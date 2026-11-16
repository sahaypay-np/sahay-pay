// Sahay Pay — admin routes (owner only, PIN-gated).
// GET /api/admin/pin-status, POST /api/admin/setup-pin (only while unset),
// POST /api/admin/login, POST /api/admin/logout, POST /api/admin/change-pin,
// GET /api/admin/metrics, GET /api/admin/queue, POST /api/admin/review/:packetId,
// GET /api/admin/users, POST /api/admin/users/:id/suspend|restore,
// GET /api/admin/verifications, POST /api/admin/verifications/:id,
// GET /api/admin/reports, POST /api/admin/reports/:id,
// GET /api/admin/fees, PUT /api/admin/fees, GET /api/admin/methods, PUT /api/admin/methods,
// GET /api/admin/audit, GET /api/admin/gifts.
// Every admin action is audit-logged. The PIN is never in logs or responses.

'use strict';

const express = require('express');
const db = require('../db');
const { logAudit, nowIso } = require('../lib/audit');
const {
  isPinSet, setupPin, verifyAdminPin, changePin,
  createAdminSession, destroyAdminSession, requireAdmin,
  sessionCookieOptions, ADMIN_SESSION_HOURS, rateLimit,
  getOrCreateCsrfToken,
} = require('../lib/auth');
const { cleanStr } = require('../lib/validate');
const { applyReviewDecision, createNotification } = require('../lib/notify');
const { deletePrivateFile } = require('../lib/storage');
const { getMaintenanceState, setMaintenanceMode } = require('../lib/maintenance');

const router = express.Router();

// --- PIN setup / login (no admin session required) ---

router.get('/pin-status', async (req, res, next) => {
  try {
    res.json({ pinSet: await isPinSet() });
  } catch (err) {
    next(err);
  }
});

// One-time setup. If ADMIN_SETUP_TOKEN is configured, the request must carry it.
router.post('/setup-pin', rateLimit('admin-setup', 5, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const setupToken = process.env.ADMIN_SETUP_TOKEN;
    if (setupToken && req.body?.setupToken !== setupToken) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'A setup token is required.' } });
    }
    const result = await setupPin(req.body?.pin);
    if (!result.ok) return res.status(409).json({ error: { code: 'PIN_SETUP_FAILED', message: result.error } });
    res.json({ ok: true, message: 'Admin PIN set. You can now log in to the admin console.' });
  } catch (err) {
    next(err);
  }
});

// Login. FAILS CLOSED when no PIN is set: no PIN is accepted.
router.post('/login', rateLimit('admin-login', 10, 15 * 60 * 1000), async (req, res, next) => {
  try {
    if (!(await isPinSet())) {
      return res.status(403).json({
        error: { code: 'PIN_NOT_SET', message: 'No admin PIN has been set yet. Set one on the setup screen first.' },
      });
    }
    const ok = await verifyAdminPin(req.body?.pin);
    // Client IP in the audit meta for login events, success + failure
    // (item 238). req.ip is the real client IP (trust proxy is set).
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (!ok) {
      await logAudit('admin', 'owner', 'admin_login_failed', 'admin', 'login', { ip });
      return res.status(401).json({ error: { code: 'INVALID_PIN', message: 'Incorrect PIN.' } });
    }
    const session = await createAdminSession();
    res.cookie('sp_admin', session.token, sessionCookieOptions(ADMIN_SESSION_HOURS * 60 * 60 * 1000, req));
    await logAudit('admin', 'owner', 'admin_login', 'admin', 'login', { ip });
    res.json({ ok: true, sessionExpiresAt: session.expiresAt, csrfToken: session.csrfToken });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    await destroyAdminSession(req.cookies?.sp_admin);
    res.clearCookie('sp_admin', { path: '/' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Everything below requires a valid admin session.
router.use(requireAdmin);

// GET /api/admin/csrf — (re-)fetch this admin session's CSRF token.
router.get('/csrf', async (req, res, next) => {
  try {
    const csrfToken = await getOrCreateCsrfToken('admin_sessions', req.cookies?.sp_admin);
    res.json({ csrfToken });
  } catch (err) {
    next(err);
  }
});

// --- Maintenance-mode kill switch (item 194) ---

router.get('/maintenance', async (req, res, next) => {
  try {
    res.json(await getMaintenanceState());
  } catch (err) {
    next(err);
  }
});

router.put('/maintenance', async (req, res, next) => {
  try {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'enabled must be true or false.' } });
    }
    res.json(await setMaintenanceMode(enabled, req.body?.message));
  } catch (err) {
    next(err);
  }
});

router.post('/change-pin', async (req, res, next) => {
  try {
    const result = await changePin(req.body?.oldPin, req.body?.newPin);
    if (!result.ok) return res.status(400).json({ error: { code: 'PIN_CHANGE_FAILED', message: result.error } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- Metrics (all computed from real data) ---

router.get('/metrics', async (req, res, next) => {
  try {
    const q = async (sql, params = []) => (await db.get(sql, params)) || {};
    const users = await q('SELECT COUNT(*) AS c FROM users');
    const suspended = await q('SELECT COUNT(*) AS c FROM users WHERE suspended = 1');
    const billsByStatus = await db.query('SELECT status, COUNT(*) AS c FROM bills GROUP BY status');
    const pendingPackets = await q(`SELECT COUNT(*) AS c FROM review_packets WHERE status = 'pending'`);
    const openReports = await q(`SELECT COUNT(*) AS c FROM reports WHERE status = 'open'`);
    const openComplaints = await q(`SELECT COUNT(*) AS c FROM complaints WHERE status = 'open'`);
    const pendingVerif = await q(`SELECT COUNT(*) AS c FROM verifications WHERE status IN ('submitted','under_review')`);
    const volume = await db.query(
      `SELECT currency, COALESCE(SUM(amount_minor),0) AS total, COUNT(*) AS gifts
       FROM gifts WHERE status = 'confirmed' GROUP BY currency`
    );
    const tips = await db.query(
      `SELECT currency, COALESCE(SUM(tip_minor),0) AS total
       FROM gifts WHERE status = 'confirmed' AND tip_minor > 0 GROUP BY currency`
    );
    const giftsByStatus = await db.query('SELECT status, COUNT(*) AS c FROM gifts GROUP BY status');
    res.json({
      users: Number(users.c || 0),
      suspendedUsers: Number(suspended.c || 0),
      billsByStatus: Object.fromEntries(billsByStatus.rows.map((r) => [r.status, Number(r.c)])),
      pendingReviewPackets: Number(pendingPackets.c || 0),
      openReports: Number(openReports.c || 0),
      openComplaints: Number(openComplaints.c || 0),
      pendingVerifications: Number(pendingVerif.c || 0),
      confirmedHelpVolume: volume.rows.map((r) => ({ currency: r.currency, totalMinor: Number(r.total), gifts: Number(r.gifts) })),
      founderTipsConfirmed: tips.rows.map((r) => ({ currency: r.currency, totalMinor: Number(r.total) })),
      giftsByStatus: Object.fromEntries(giftsByStatus.rows.map((r) => [r.status, Number(r.c)])),
    });
  } catch (err) {
    next(err);
  }
});

// --- Review queue ---

router.get('/queue', async (req, res, next) => {
  try {
    const status = ['pending', 'approved', 'rejected', 'changes_requested'].includes(req.query.status)
      ? req.query.status
      : 'pending';
    const { rows } = await db.query(
      `SELECT * FROM review_packets WHERE status = $1 ORDER BY created_at DESC LIMIT 100`,
      [status]
    );
    res.json({
      packets: rows.map((r) => ({
        id: r.id,
        targetType: r.target_type,
        targetId: r.target_id,
        payload: JSON.parse(r.payload_json || '{}'),
        status: r.status,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/review/:packetId {decision: approve|reject|changes, reason}
router.post('/review/:packetId', async (req, res, next) => {
  try {
    const result = await applyReviewDecision(
      req.params.packetId,
      req.body?.decision,
      cleanStr(req.body?.reason || '', 600),
      'admin',
      'owner'
    );
    if (!result.ok) {
      return res.status(result.status || 400).json({ error: { code: 'REVIEW_FAILED', message: result.error } });
    }
    res.json({ ok: true, packetStatus: result.packetStatus });
  } catch (err) {
    next(err);
  }
});

// --- Users ---

router.get('/users', async (req, res, next) => {
  try {
    const search = cleanStr(req.query.q || '', 120);
    const params = [];
    let where = '1=1';
    if (search) {
      params.push(`%${search}%`); params.push(`%${search}%`);
      where = `(display_name LIKE $1 OR username LIKE $2)`;
    }
    const { rows } = await db.query(
      `SELECT u.*,
              (SELECT COUNT(*) FROM bills b WHERE b.user_id = u.id) AS bill_count,
              (SELECT COUNT(*) FROM bills b WHERE b.user_id = u.id AND b.status = 'approved') AS approved_count
       FROM users u WHERE ${where} ORDER BY u.created_at DESC LIMIT 100`,
      params
    );
    res.json({
      users: rows.map((r) => ({
        id: r.id, displayName: r.display_name, username: r.username, age: r.age,
        country: r.country, city: r.city, about: r.about, language: r.language,
        photoUrl: r.photo_url, suspended: r.suspended === 1, createdAt: r.created_at,
        billCount: Number(r.bill_count), approvedCount: Number(r.approved_count),
      })),
    });
  } catch (err) {
    next(err);
  }
});

async function setSuspended(req, res, suspended) {
  const user = await db.get('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  await db.run('UPDATE users SET suspended = $1 WHERE id = $2', [suspended ? 1 : 0, user.id]);
  await logAudit('admin', 'owner', suspended ? 'user_suspended' : 'user_restored', 'user', user.id, {});
  res.json({ ok: true, suspended });
}

router.post('/users/:id/suspend', (req, res, next) => setSuspended(req, res, true).catch(next));
router.post('/users/:id/restore', (req, res, next) => setSuspended(req, res, false).catch(next));

// --- Verifications ---

router.get('/verifications', async (req, res, next) => {
  try {
    const status = req.query.status;
    const params = [];
    let where = '1=1';
    if (status) { params.push(status); where = `v.status = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT v.*, u.display_name AS user_name, u.username AS user_username
       FROM verifications v JOIN users u ON u.id = v.user_id
       WHERE ${where} ORDER BY v.created_at DESC LIMIT 100`,
      params
    );
    res.json({ verifications: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/verifications/:id {decision: approve|reject|more_required, note}
router.post('/verifications/:id', async (req, res, next) => {
  try {
    const row = await db.get('SELECT * FROM verifications WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Verification not found.' } });
    const decision = req.body?.decision;
    if (!['approve', 'reject', 'more_required'].includes(decision)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Decision must be approve, reject or more_required.' } });
    }
    const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'more_required';
    const note = cleanStr(req.body?.note || '', 600);
    // Verification documents are deleted after review (item 255) — the
    // Privacy Policy already promises this. On a final decision (approve
    // or reject) the private file is removed from disk and the reference
    // cleared; "more required" keeps the document (review is not over).
    let docDeleted = false;
    if (decision !== 'more_required' && row.doc_url) {
      docDeleted = deletePrivateFile(row.doc_url);
    }
    await db.run(
      `UPDATE verifications SET status = $1, reviewer_note = $2, decided_at = $3,
       doc_url = $4 WHERE id = $5`,
      [status, note, nowIso(), decision === 'more_required' ? row.doc_url : null, row.id]
    );
    await createNotification(
      row.user_id,
      status === 'approved' ? 'verification_approved' : 'verification_decided',
      status === 'approved' ? 'Verification approved' : status === 'rejected' ? 'Verification not approved' : 'More documents needed',
      note || `Your ${row.type} verification was ${status}.`,
      '#/verify'
    );
    await logAudit('admin', 'owner', `verification_${decision}`, 'verification', row.id, { type: row.type, docDeleted });
    const updated = await db.get('SELECT * FROM verifications WHERE id = $1', [row.id]);
    res.json({ verification: updated, docDeleted });
  } catch (err) {
    next(err);
  }
});

// --- Reports ---

router.get('/reports', async (req, res, next) => {
  try {
    const status = req.query.status;
    const params = [];
    let where = '1=1';
    if (status) { params.push(status); where = `r.status = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT r.*, u.display_name AS reporter_name, u.username AS reporter_username
       FROM reports r JOIN users u ON u.id = r.reporter_id
       WHERE ${where} ORDER BY r.created_at DESC LIMIT 100`,
      params
    );
    res.json({ reports: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/reports/:id {action: dismiss|hide|pause|remove|suspend|restore}
router.post('/reports/:id', async (req, res, next) => {
  try {
    const report = await db.get('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!report) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Report not found.' } });
    const action = req.body?.action;
    if (!['dismiss', 'hide', 'pause', 'remove', 'suspend', 'restore'].includes(action)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Action must be dismiss, hide, pause, remove, suspend or restore.' } });
    }
    const now = nowIso();
    if (report.target_type === 'bill') {
      const bill = await db.get('SELECT * FROM bills WHERE id = $1', [report.target_id]);
      if (bill) {
        if (action === 'hide' || action === 'pause') {
          await db.run(`UPDATE bills SET status = 'under_investigation', updated_at = $1 WHERE id = $2`, [now, bill.id]);
        } else if (action === 'remove') {
          await db.run(`UPDATE bills SET status = 'removed', updated_at = $1 WHERE id = $2`, [now, bill.id]);
          await createNotification(bill.user_id, 'bill_removed', 'Your bill was removed', 'Your bill was removed after a report review.', '#/mybills');
        } else if (action === 'restore') {
          await db.run(`UPDATE bills SET status = 'approved', updated_at = $1 WHERE id = $2`, [now, bill.id]);
          await createNotification(bill.user_id, 'bill_restored', 'Your bill is live again', 'Your bill was reviewed and restored to the feed.', '#/mybills');
        } else if (action === 'suspend') {
          await db.run('UPDATE users SET suspended = 1 WHERE id = $1', [bill.user_id]);
          await db.run(`UPDATE bills SET status = 'removed', updated_at = $1 WHERE id = $2`, [now, bill.id]);
        }
      }
    } else if (report.target_type === 'user' && action === 'suspend') {
      await db.run('UPDATE users SET suspended = 1 WHERE id = $1', [report.target_id]);
    }
    await db.run(`UPDATE reports SET status = 'resolved' WHERE id = $1`, [report.id]);
    await logAudit('admin', 'owner', `report_${action}`, 'report', report.id, { targetType: report.target_type, targetId: report.target_id });
    res.json({ ok: true, action });
  } catch (err) {
    next(err);
  }
});

// --- Fees (fee engine config + mode switch; audit-logged) ---

router.get('/fees', async (req, res, next) => {
  try {
    // Parallel: independent settings reads (see /config — each is a
    // ~200ms Supabase round trip from the serverless function).
    const [feeModeRaw, feeConfig, founderTipConfig, minGiftRaw] = await Promise.all([
      db.getSetting('fee_mode'),
      db.getSettingJson('fee_config', {}),
      db.getSettingJson('founder_tip_config', {}),
      db.getSetting('min_gift_minor'),
    ]);
    res.json({
      feeMode: feeModeRaw || 'supporter_fee',
      feeConfig,
      founderTipConfig,
      minGiftMinor: Number(minGiftRaw) || 1000,
    });
  } catch (err) {
    next(err);
  }
});

router.put('/fees', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.feeMode !== undefined) {
      if (!['supporter_fee', 'zero_fee_plus_tip'].includes(body.feeMode)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'feeMode must be supporter_fee or zero_fee_plus_tip.' } });
      }
      await db.setSetting('fee_mode', body.feeMode);
      await logAudit('admin', 'owner', 'fee_mode_changed', 'settings', 'fee_mode', { feeMode: body.feeMode });
    }
    if (body.feeConfig !== undefined) {
      if (typeof body.feeConfig !== 'object' || Array.isArray(body.feeConfig)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'feeConfig must be an object keyed by currency.' } });
      }
      for (const [cur, cfg] of Object.entries(body.feeConfig)) {
        if (!['NPR', 'INR'].includes(cur)) {
          return res.status(400).json({ error: { code: 'VALIDATION', message: 'feeConfig currencies must be NPR and/or INR.' } });
        }
        for (const k of ['flatMinor', 'thresholdMinor', 'percent', 'minMinor']) {
          if (!Number.isSafeInteger(cfg?.[k]) || cfg[k] < 0) {
            return res.status(400).json({ error: { code: 'VALIDATION', message: `feeConfig.${cur}.${k} must be a non-negative integer.` } });
          }
        }
      }
      await db.setSetting('fee_config', JSON.stringify(body.feeConfig));
      await logAudit('admin', 'owner', 'fee_config_changed', 'settings', 'fee_config', {});
    }
    if (body.founderTipConfig !== undefined) {
      await db.setSetting('founder_tip_config', JSON.stringify(body.founderTipConfig));
      await logAudit('admin', 'owner', 'founder_tip_config_changed', 'settings', 'founder_tip_config', {});
    }
    if (body.minGiftMinor !== undefined) {
      if (!Number.isSafeInteger(body.minGiftMinor) || body.minGiftMinor <= 0) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'minGiftMinor must be a positive integer.' } });
      }
      await db.setSetting('min_gift_minor', String(body.minGiftMinor));
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- Payment methods + brand packages (admin-configured) ---

router.get('/methods', async (req, res, next) => {
  try {
    // Parallel: independent settings reads (see /config).
    const [paymentMethods, brandPackages, categories] = await Promise.all([
      db.getSettingJson('payment_methods', {}),
      db.getSettingJson('brand_packages', []),
      db.getSettingJson('categories', []),
    ]);
    res.json({ paymentMethods, brandPackages, categories });
  } catch (err) {
    next(err);
  }
});

router.put('/methods', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.paymentMethods !== undefined) {
      await db.setSetting('payment_methods', JSON.stringify(body.paymentMethods));
      await logAudit('admin', 'owner', 'payment_methods_changed', 'settings', 'payment_methods', {});
    }
    if (body.brandPackages !== undefined) {
      await db.setSetting('brand_packages', JSON.stringify(body.brandPackages));
      await logAudit('admin', 'owner', 'brand_packages_changed', 'settings', 'brand_packages', {});
    }
    if (body.categories !== undefined) {
      if (!Array.isArray(body.categories) || body.categories.some((c) => typeof c !== 'string')) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'categories must be an array of strings.' } });
      }
      await db.setSetting('categories', JSON.stringify(body.categories));
      await logAudit('admin', 'owner', 'categories_changed', 'settings', 'categories', {});
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- Audit log ---

router.get('/audit', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const { rows } = await db.query(
      'SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    res.json({
      logs: rows.map((r) => ({
        id: r.id, actorType: r.actor_type, actorId: r.actor_id, action: r.action,
        targetType: r.target_type, targetId: r.target_id,
        meta: JSON.parse(r.meta_json || '{}'), createdAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// --- Gift status overview ---

router.get('/gifts', async (req, res, next) => {
  try {
    const status = req.query.status;
    const params = [];
    let where = '1=1';
    if (status) { params.push(status); where = `g.status = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT g.*, b.title AS bill_title, b.user_id AS recipient_id,
              u.display_name AS supporter_name, u.username AS supporter_username
       FROM gifts g JOIN bills b ON b.id = g.bill_id JOIN users u ON u.id = g.supporter_id
       WHERE ${where} ORDER BY g.created_at DESC LIMIT 100`,
      params
    );
    res.json({ gifts: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
