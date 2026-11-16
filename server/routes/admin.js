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
const crypto = require('crypto');
const db = require('../db');
const { logAudit, nowIso } = require('../lib/audit');
const {
  isPinSet, setupPin, verifyAdminPin, changePin,
  createAdminSession, destroyAdminSession, requireAdmin, lookupAdminSession,
  requireElevated, elevateAdminSession, rotateAdminSession,
  sessionCookieOptions, ADMIN_SESSION_HOURS, rateLimit,
  getOrCreateCsrfToken,
} = require('../lib/auth');
const { cleanStr } = require('../lib/validate');
const { applyReviewDecision, createNotification } = require('../lib/notify');
const { deletePrivateFile } = require('../lib/storage');
const { getMaintenanceState, setMaintenanceMode, getFreezeState, setEmergencyFreeze } = require('../lib/maintenance');
const { accountsOverRevealThreshold, recentRevealAnomalies } = require('../lib/security');

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

// GET /api/admin/session — 200 always: {admin: true/false}. Lets the frontend
// detect an admin session at boot without a 401 console error (same pattern
// as /api/auth/me returning 200 {user:null} when logged out). The /metrics
// probe it replaces fired a 401 for every logged-out visitor on every boot,
// which Lighthouse flagged under Best Practices.
router.get('/session', async (req, res, next) => {
  try {
    const row = await lookupAdminSession(req.cookies?.sp_admin);
    res.json({ admin: Boolean(row) });
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

// --- Full-data export (backups without a paid plan) ---
// GET /api/admin/export — admin session required. Returns a JSON download of
// the service's user-facing data (everything needed to rebuild state).
// SAFETY: payout accounts are exported ONLY as their stored AES-256-GCM
// ciphertext (account_enc) — never decrypted. The export NEVER contains:
// sessions / admin_sessions (token hashes), users.recovery_code_hash /
// recovery_code_lookup (credential-equivalent), or settings.admin_pin_hash.
// Uploaded photo FILES are not included (photo_url references only).
const EXPORT_TABLES = [
  'bills', 'payout_methods', 'gifts', 'verifications', 'brands',
  'brand_connects', 'auctions', 'auction_bids', 'notifications',
  'reports', 'complaints', 'review_packets', 'audit_logs',
  'basket_items', 'pledges', 'gift_messages', 'billers', 'bill_edits',
];
const SECRET_SETTING_KEYS = new Set(['admin_pin_hash']);
const SECRET_SETTING_PATTERN = /secret|token|password/i;

router.get('/export', async (req, res, next) => {
  try {
    const tables = {};
    // Users: explicit column list so recovery-code hashes can never leak,
    // even if the schema grows new secret columns later.
    const users = await db.query(
      `SELECT id, display_name, username, age, country, city, about, language,
              photo_url, prefs_json, terms_accepted_version, terms_accepted_at,
              privacy_accepted_version, privacy_accepted_at, suspended, created_at
       FROM users ORDER BY 1`
    );
    tables.users = users.rows;
    for (const t of EXPORT_TABLES) {
      const r = await db.query(`SELECT * FROM ${t} ORDER BY 1`);
      tables[t] = r.rows;
    }
    // Settings: everything except secrets.
    const settings = await db.query('SELECT key, value FROM settings ORDER BY 1');
    tables.settings = settings.rows.filter(
      (row) => !SECRET_SETTING_KEYS.has(row.key) && !SECRET_SETTING_PATTERN.test(row.key)
    );
    await logAudit('admin', 'owner', 'admin_data_export', 'admin', 'export', {
      tables: Object.keys(tables),
      rows: Object.values(tables).reduce((n, rows) => n + rows.length, 0),
    });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="sahay-pay-export-${stamp}.json"`);
    res.json({ exportedAt: new Date().toISOString(), app: 'Sahay Pay', version: 1, tables });
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
    // Item 802: rotate the admin session token on PIN change.
    await rotateAdminSession(req, res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/elevate {pin} — item 808: re-enter the owner PIN to
// unlock sensitive actions (fee changes, review decisions) for 10 minutes.
router.post('/elevate', rateLimit('admin-elevate', 10, 15 * 60 * 1000), async (req, res, next) => {
  try {
    const ok = await verifyAdminPin(req.body?.pin);
    if (!ok) {
      await logAudit('admin', 'owner', 'admin_elevate_failed', 'admin', 'elevate', {});
      return res.status(401).json({ error: { code: 'INVALID_PIN', message: 'Incorrect PIN.' } });
    }
    await elevateAdminSession(req.cookies?.sp_admin);
    await logAudit('admin', 'owner', 'admin_elevated', 'admin', 'elevate', {});
    res.json({ ok: true, elevatedMinutes: 10 });
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
    // Gift disputes (items 281/284): open disputes + fee reviews, and the
    // escalation count — disputes unanswered by an admin for 48h+.
    const openDisputes = await q(
      `SELECT COUNT(*) AS c FROM gifts
       WHERE status = 'disputed' OR fee_review_status IN ('requested', 'acknowledged')`
    );
    const staleCutoff = new Date(Date.now() - 48 * 3600000).toISOString();
    const staleDisputes = await q(
      `SELECT COUNT(*) AS c FROM gifts g
       WHERE (g.status = 'disputed' OR g.fee_review_status IN ('requested', 'acknowledged'))
         AND COALESCE(g.disputed_at, g.fee_review_at, g.created_at) <= $1
         AND NOT EXISTS (
           SELECT 1 FROM gift_messages m
           WHERE m.gift_id = g.id AND m.sender_type = 'admin'
             AND m.created_at > COALESCE(g.disputed_at, g.fee_review_at, g.created_at)
         )`,
      [staleCutoff]
    );
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
      openDisputes: Number(openDisputes.c || 0),
      staleDisputes: Number(staleDisputes.c || 0),
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
// Item 808: bill approval decisions need a fresh PIN re-auth (elevation).
router.post('/review/:packetId', requireElevated, async (req, res, next) => {
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

// POST /api/admin/reports/:id {action: dismiss|hide|pause|remove|suspend|restore|warn}
router.post('/reports/:id', async (req, res, next) => {
  try {
    const report = await db.get('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!report) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Report not found.' } });
    const action = req.body?.action;
    if (!['dismiss', 'hide', 'pause', 'remove', 'suspend', 'restore', 'warn'].includes(action)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Action must be dismiss, hide, pause, remove, suspend, restore or warn.' } });
    }
    const now = nowIso();
    // Item 859: warn the poster (notification, no content change).
    if (action === 'warn') {
      let posterId = null;
      if (report.target_type === 'bill') {
        const bill = await db.get('SELECT user_id, title FROM bills WHERE id = $1', [report.target_id]);
        if (bill) {
          posterId = bill.user_id;
          await createNotification(
            bill.user_id, 'poster_warned', 'A warning about your bill',
            `Your bill "${bill.title}" was reported (${report.reason}). Please check it follows the community guidelines — further reports may hide it.`,
            '#/mybills'
          );
        }
      } else if (report.target_type === 'user') {
        posterId = report.target_id;
        await createNotification(
          report.target_id, 'poster_warned', 'A warning about your account',
          'Your account was reported. Please check it follows the community guidelines.',
          '#/help?topic=guidelines'
        );
      }
      await db.run(`UPDATE reports SET status = 'resolved' WHERE id = $1`, [report.id]);
      await logAudit('admin', 'owner', 'report_warn', 'report', report.id, { posterId });
      return res.json({ ok: true, action });
    }
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
    const [feeModeRaw, feeConfig, founderTipConfig, minGiftRaw, minNprRaw, minInrRaw, giftChips, charityFreeCategories] = await Promise.all([
      db.getSetting('fee_mode'),
      db.getSettingJson('fee_config', {}),
      db.getSettingJson('founder_tip_config', {}),
      db.getSetting('min_gift_minor'),
      db.getSetting('min_gift_minor_npr'),
      db.getSetting('min_gift_minor_inr'),
      db.getSettingJson('gift_chips', null),
      db.getSettingJson('charity_fee_free_categories', []),
    ]);
    res.json({
      feeMode: feeModeRaw || 'supporter_fee',
      feeConfig,
      founderTipConfig,
      minGiftMinor: Number(minGiftRaw) || 1000,
      minGiftMinorNPR: Number(minNprRaw) || Number(minGiftRaw) || 1000,
      minGiftMinorINR: Number(minInrRaw) || Number(minGiftRaw) || 1000,
      giftChips: (giftChips && giftChips.NPR && giftChips.INR)
        ? giftChips
        : { NPR: [10000, 25000, 50000, 100000], INR: [10000, 25000, 50000, 100000] },
      charityFeeFreeCategories: Array.isArray(charityFreeCategories) ? charityFreeCategories : [],
    });
  } catch (err) {
    next(err);
  }
});

router.put('/fees', requireElevated, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.feeMode !== undefined) {
      if (!['supporter_fee', 'zero_fee_plus_tip'].includes(body.feeMode)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'feeMode must be supporter_fee or zero_fee_plus_tip.' } });
      }
      const oldMode = (await db.getSetting('fee_mode')) || 'supporter_fee';
      await db.setSetting('fee_mode', body.feeMode);
      await logAudit('admin', 'owner', 'fee_mode_changed', 'settings', 'fee_mode', { oldValue: oldMode, newValue: body.feeMode, changedAt: nowIso() });
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
      // Item 216: fee-rule changes log admin + old/new values + timestamp.
      const oldConfig = await db.getSettingJson('fee_config', {});
      await db.setSetting('fee_config', JSON.stringify(body.feeConfig));
      await logAudit('admin', 'owner', 'fee_config_changed', 'settings', 'fee_config', {
        admin: 'owner', oldValue: oldConfig, newValue: body.feeConfig, changedAt: nowIso(),
      });
    }
    if (body.founderTipConfig !== undefined) {
      const oldTip = await db.getSettingJson('founder_tip_config', {});
      await db.setSetting('founder_tip_config', JSON.stringify(body.founderTipConfig));
      await logAudit('admin', 'owner', 'founder_tip_config_changed', 'settings', 'founder_tip_config', {
        admin: 'owner', oldValue: oldTip, newValue: body.founderTipConfig, changedAt: nowIso(),
      });
    }
    if (body.minGiftMinor !== undefined) {
      if (!Number.isSafeInteger(body.minGiftMinor) || body.minGiftMinor <= 0) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'minGiftMinor must be a positive integer.' } });
      }
      await db.setSetting('min_gift_minor', String(body.minGiftMinor));
    }
    // Item 206: per-currency minimums.
    for (const [key, setting] of [['minGiftMinorNPR', 'min_gift_minor_npr'], ['minGiftMinorINR', 'min_gift_minor_inr']]) {
      if (body[key] !== undefined) {
        if (!Number.isSafeInteger(body[key]) || body[key] <= 0) {
          return res.status(400).json({ error: { code: 'VALIDATION', message: `${key} must be a positive integer.` } });
        }
        const oldVal = await db.getSetting(setting);
        await db.setSetting(setting, String(body[key]));
        await logAudit('admin', 'owner', 'min_gift_changed', 'settings', setting, {
          admin: 'owner', oldValue: oldVal, newValue: String(body[key]), changedAt: nowIso(),
        });
      }
    }
    // Item 290: gift-chip amounts per currency (2–6 chips, ascending).
    if (body.giftChips !== undefined) {
      if (typeof body.giftChips !== 'object' || Array.isArray(body.giftChips)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'giftChips must be an object keyed by currency.' } });
      }
      for (const [cur, chips] of Object.entries(body.giftChips)) {
        if (!['NPR', 'INR'].includes(cur) || !Array.isArray(chips) || chips.length < 2 || chips.length > 6
          || chips.some((c) => !Number.isSafeInteger(c) || c <= 0)
          || chips.some((c, i) => i > 0 && c <= chips[i - 1])) {
          return res.status(400).json({ error: { code: 'VALIDATION', message: `giftChips.${cur} must be 2–6 ascending positive integers.` } });
        }
      }
      await db.setSetting('gift_chips', JSON.stringify(body.giftChips));
      await logAudit('admin', 'owner', 'gift_chips_changed', 'settings', 'gift_chips', { admin: 'owner', newValue: body.giftChips, changedAt: nowIso() });
    }
    // Item 217: per-category charity fee-free list.
    if (body.charityFeeFreeCategories !== undefined) {
      if (!Array.isArray(body.charityFeeFreeCategories) || body.charityFeeFreeCategories.some((c) => typeof c !== 'string')) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'charityFeeFreeCategories must be an array of category names.' } });
      }
      const oldList = await db.getSettingJson('charity_fee_free_categories', []);
      await db.setSetting('charity_fee_free_categories', JSON.stringify(body.charityFeeFreeCategories));
      await logAudit('admin', 'owner', 'charity_fee_free_changed', 'settings', 'charity_fee_free_categories', {
        admin: 'owner', oldValue: oldList, newValue: body.charityFeeFreeCategories, changedAt: nowIso(),
      });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/fees/history — fee-change history (item 219): past fee
// rules with effective dates, from the audit trail.
router.get('/fees/history', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM audit_logs
       WHERE action IN ('fee_config_changed', 'fee_mode_changed', 'min_gift_changed', 'gift_chips_changed', 'charity_fee_free_changed', 'founder_tip_config_changed')
       ORDER BY created_at DESC LIMIT 100`
    );
    res.json({
      history: rows.map((r) => {
        let meta = {};
        try { meta = JSON.parse(r.meta_json || '{}'); } catch { meta = {}; }
        return {
          id: r.id, action: r.action, actorId: r.actor_id,
          oldValue: meta.oldValue !== undefined ? meta.oldValue : null,
          newValue: meta.newValue !== undefined ? meta.newValue : (meta.feeMode || null),
          changedAt: meta.changedAt || r.created_at, createdAt: r.created_at,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/tips — optional founder-tip totals in Demo Mode gifts,
// grouped by week and currency (item 225). No payment is ever taken.
router.get('/tips', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT currency, tip_minor, created_at FROM gifts WHERE tip_minor > 0 ORDER BY created_at DESC LIMIT 1000`
    );
    const weeks = {};
    for (const r of rows) {
      const d = new Date(r.created_at);
      const monday = new Date(d);
      const dow = (d.getUTCDay() + 6) % 7;
      monday.setUTCDate(d.getUTCDate() - dow);
      monday.setUTCHours(0, 0, 0, 0);
      const key = `${monday.toISOString().slice(0, 10)}|${r.currency}`;
      if (!weeks[key]) {
        weeks[key] = { weekStart: monday.toISOString().slice(0, 10), currency: r.currency, totalMinor: 0, gifts: 0 };
      }
      weeks[key].totalMinor += r.tip_minor;
      weeks[key].gifts++;
    }
    res.json({ weeks: Object.values(weeks).sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1)) });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/analytics/gifts — gift-flow funnel (item 297), last 30
// days by default. Sheet-opened is a client event; amount chosen / fee
// step passed / details shown / marked sent / confirmed are derived from
// the audit log. Demo Mode only — no payment data exists.
router.get('/analytics/gifts', async (req, res, next) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const since = new Date(Date.now() - days * 24 * 3600000).toISOString();
    const { rows } = await db.query(
      `SELECT action, COUNT(*) AS c FROM audit_logs
       WHERE created_at >= $1
         AND action IN ('gift_sheet_opened', 'gift_created', 'payout_revealed', 'gift_reported_sent', 'gift_confirmed', 'gift_disputed', 'gift_not_received')
       GROUP BY action`,
      [since]
    );
    const counts = Object.fromEntries(rows.map((r) => [r.action, Number(r.c)]));
    res.json({
      days,
      funnel: {
        sheetOpened: counts.gift_sheet_opened || 0,
        amountChosen: counts.gift_created || 0,
        feeStepPassed: counts.gift_created || 0,
        detailsShown: counts.payout_revealed || 0,
        markedSent: counts.gift_reported_sent || 0,
        confirmed: counts.gift_confirmed || 0,
        disputed: counts.gift_disputed || 0,
        notReceived: counts.gift_not_received || 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

// --- Gift dispute centre (items 281/282/284) ---

router.get('/disputes', async (req, res, next) => {
  try {
    const status = req.query.status === 'resolved' ? 'resolved' : 'open';
    const where = status === 'open'
      ? `g.status = 'disputed' OR g.fee_review_status IN ('requested', 'acknowledged')`
      : `g.fee_review_status = 'resolved'`;
    const { rows } = await db.query(
      `SELECT g.*, b.title AS bill_title, b.request_code AS bill_code,
              u.display_name AS supporter_name,
              (SELECT body FROM gift_messages m WHERE m.gift_id = g.id AND m.sender_type = 'admin' ORDER BY m.created_at DESC LIMIT 1) AS last_admin_message,
              (SELECT created_at FROM gift_messages m WHERE m.gift_id = g.id AND m.sender_type = 'admin' ORDER BY m.created_at DESC LIMIT 1) AS last_admin_message_at,
              (SELECT COUNT(*) FROM gift_messages m WHERE m.gift_id = g.id) AS message_count
       FROM gifts g JOIN bills b ON b.id = g.bill_id JOIN users u ON u.id = g.supporter_id
       WHERE ${where} ORDER BY COALESCE(g.disputed_at, g.fee_review_at, g.created_at) ASC LIMIT 100`
    );
    res.json({
      disputes: rows.map((r) => ({
        giftId: r.id,
        billId: r.bill_id,
        billTitle: r.bill_title,
        billCode: r.bill_code,
        supporterName: r.supporter_name,
        amountMinor: r.amount_minor,
        currency: r.currency,
        status: r.status,
        disputeNote: r.dispute_note,
        disputedAt: r.disputed_at,
        directPay: r.direct_pay === 1,
        feeReviewStatus: r.fee_review_status,
        feeReviewCase: r.fee_review_case,
        feeReviewAt: r.fee_review_at,
        lastAdminMessage: r.last_admin_message || null,
        lastAdminMessageAt: r.last_admin_message_at || null,
        messageCount: Number(r.message_count || 0),
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/disputes/:giftId', async (req, res, next) => {
  try {
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [req.params.giftId]);
    if (!gift) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Gift not found.' } });
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [gift.bill_id]);
    const supporter = await db.get('SELECT display_name, username FROM users WHERE id = $1', [gift.supporter_id]);
    const poster = bill ? await db.get('SELECT display_name, username FROM users WHERE id = $1', [bill.user_id]) : null;
    const { rows } = await db.query(
      `SELECT * FROM gift_messages WHERE gift_id = $1 ORDER BY created_at ASC LIMIT 200`,
      [gift.id]
    );
    res.json({
      gift: {
        id: gift.id, billId: gift.bill_id, amountMinor: gift.amount_minor, currency: gift.currency,
        feeMinor: gift.fee_minor, tipMinor: gift.tip_minor, status: gift.status,
        reference: gift.reference, disputeNote: gift.dispute_note, disputedAt: gift.disputed_at,
        directPay: gift.direct_pay === 1, billerName: gift.biller_name, billerRef: gift.biller_ref,
        feeReviewStatus: gift.fee_review_status, feeReviewCase: gift.fee_review_case, feeReviewAt: gift.fee_review_at,
        createdAt: gift.created_at, confirmedAt: gift.confirmed_at,
      },
      bill: bill ? { id: bill.id, title: bill.title, requestCode: bill.request_code, status: bill.status } : null,
      supporter: supporter ? { displayName: supporter.display_name, username: supporter.username } : null,
      poster: poster ? { displayName: poster.display_name, username: poster.username } : null,
      messages: rows.map((r) => ({ id: r.id, senderType: r.sender_type, body: r.body, createdAt: r.created_at })),
    });
  } catch (err) {
    next(err);
  }
});

async function postAdminDisputeMessage(giftId, body, req) {
  const id = crypto.randomUUID();
  const now = nowIso();
  await db.run(
    `INSERT INTO gift_messages (id, gift_id, sender_type, sender_id, body, created_at) VALUES ($1, $2, 'admin', 'admin', $3, $4)`,
    [id, giftId, body, now]
  );
  const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [giftId]);
  const bill = gift ? await db.get('SELECT * FROM bills WHERE id = $1', [gift.bill_id]) : null;
  if (gift) {
    await createNotification(gift.supporter_id, 'gift_message_admin', 'Message from Sahay Pay', 'The Sahay Pay team wrote about your gift.', '#/mybills');
    if (bill) await createNotification(bill.user_id, 'gift_message_admin', 'Message from Sahay Pay', 'The Sahay Pay team wrote about a gift on your bill.', '#/mybills');
  }
  return id;
}

router.post('/disputes/:giftId/acknowledge', async (req, res, next) => {
  try {
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [req.params.giftId]);
    if (!gift) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Gift not found.' } });
    if (gift.fee_review_status === 'requested') {
      await db.run(`UPDATE gifts SET fee_review_status = 'acknowledged' WHERE id = $1`, [gift.id]);
    }
    await logAudit('admin', 'owner', 'dispute_acknowledged', 'gift', gift.id, {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/disputes/:giftId/message', async (req, res, next) => {
  try {
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [req.params.giftId]);
    if (!gift) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Gift not found.' } });
    const body = cleanStr(req.body?.body || '', 1000);
    if (!body) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Write a message first.' } });
    await postAdminDisputeMessage(gift.id, body, req);
    await logAudit('admin', 'owner', 'dispute_messaged', 'gift', gift.id, {});
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/disputes/:giftId/resolve', async (req, res, next) => {
  try {
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [req.params.giftId]);
    if (!gift) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Gift not found.' } });
    const note = cleanStr(req.body?.note || '', 600);
    // A resolved dispute returns the gift to donor-reported (the parties
    // can still confirm it) unless it was a fee review, which is marked
    // resolved on its own field. Nothing here moves money.
    if (gift.status === 'disputed') {
      await db.run(`UPDATE gifts SET status = 'donor_reported_sent' WHERE id = $1`, [gift.id]);
    }
    if (['requested', 'acknowledged'].includes(gift.fee_review_status)) {
      await db.run(`UPDATE gifts SET fee_review_status = 'resolved' WHERE id = $1`, [gift.id]);
    }
    if (note) await postAdminDisputeMessage(gift.id, note, req);
    await logAudit('admin', 'owner', 'dispute_resolved', 'gift', gift.id, { note });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- Biller directory admin tooling (item 277) ---

const BILLER_CATEGORIES = ['electricity', 'water', 'internet', 'school', 'hospital', 'other'];

router.get('/billers', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM billers ORDER BY active DESC, category ASC, name ASC LIMIT 200');
    res.json({
      billers: rows.map((r) => ({
        id: r.id, name: r.name, category: r.category, country: r.country,
        refFormat: r.ref_format || '', refHint: r.ref_hint || '',
        active: r.active === 1, createdAt: r.created_at, updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/billers', async (req, res, next) => {
  try {
    const name = cleanStr(req.body?.name, 120);
    const category = cleanStr(req.body?.category, 32);
    const country = cleanStr(req.body?.country, 2);
    if (!name || name.length < 2) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Biller name must be 2+ characters.' } });
    }
    if (!BILLER_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Category must be electricity, water, internet, school, hospital or other.' } });
    }
    if (!['NP', 'IN'].includes(country)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Country must be NP or IN.' } });
    }
    const id = crypto.randomUUID();
    const now = nowIso();
    await db.run(
      `INSERT INTO billers (id, name, category, country, ref_format, ref_hint, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $7)`,
      [id, name, category, country, cleanStr(req.body?.refFormat, 120), cleanStr(req.body?.refHint, 300), now]
    );
    await logAudit('admin', 'owner', 'biller_added', 'biller', id, { name, category, country });
    res.status(201).json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

router.put('/billers/:id', async (req, res, next) => {
  try {
    const row = await db.get('SELECT * FROM billers WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Biller not found.' } });
    const name = req.body?.name !== undefined ? cleanStr(req.body.name, 120) : '';
    const category = req.body?.category !== undefined ? cleanStr(req.body.category, 32) : '';
    const country = req.body?.country !== undefined ? cleanStr(req.body.country, 2) : '';
    if (req.body?.name !== undefined && name.length < 2) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Biller name must be 2+ characters.' } });
    }
    if (category && !BILLER_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid biller category.' } });
    }
    if (country && !['NP', 'IN'].includes(country)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Country must be NP or IN.' } });
    }
    const next = {
      name: name || row.name,
      category: category || row.category,
      country: country || row.country,
      ref_format: req.body?.refFormat !== undefined ? cleanStr(req.body.refFormat, 120) : row.ref_format,
      ref_hint: req.body?.refHint !== undefined ? cleanStr(req.body.refHint, 300) : row.ref_hint,
      active: req.body?.active !== undefined ? (req.body.active ? 1 : 0) : row.active,
    };
    await db.run(
      `UPDATE billers SET name = $1, category = $2, country = $3, ref_format = $4, ref_hint = $5, active = $6, updated_at = $7 WHERE id = $8`,
      [next.name, next.category, next.country, next.ref_format, next.ref_hint, next.active, nowIso(), row.id]
    );
    await logAudit('admin', 'owner', 'biller_updated', 'biller', row.id, { oldValue: { name: row.name, category: row.category, country: row.country, active: row.active }, newValue: next });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/billers/:id', async (req, res, next) => {
  try {
    const row = await db.get('SELECT * FROM billers WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Biller not found.' } });
    // Deactivate rather than delete: the change log (audit trail) keeps the
    // record, and old receipts still resolve the biller name.
    await db.run(`UPDATE billers SET active = 0, updated_at = $1 WHERE id = $2`, [nowIso(), row.id]);
    await logAudit('admin', 'owner', 'biller_deactivated', 'biller', row.id, { name: row.name });
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

// --- Complaints log (item 909) + security-incident flag (item 882) ---

router.get('/complaints', async (req, res, next) => {
  try {
    const status = req.query.status;
    const category = req.query.category;
    const params = [];
    const clauses = [];
    if (status) { params.push(status); clauses.push(`c.status = $${params.length}`); }
    if (category) { params.push(category); clauses.push(`c.category = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await db.query(
      `SELECT c.*, u.display_name AS user_name, u.username AS user_username
       FROM complaints c JOIN users u ON u.id = c.user_id
       ${where} ORDER BY c.created_at DESC LIMIT 100`,
      params
    );
    res.json({ complaints: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/complaints/:id {action: resolve|reopen} — closing a
// complaint notifies the complainant (the in-app confirmation).
router.post('/complaints/:id', async (req, res, next) => {
  try {
    const row = await db.get('SELECT * FROM complaints WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Complaint not found.' } });
    const action = req.body?.action;
    if (!['resolve', 'reopen'].includes(action)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Action must be resolve or reopen.' } });
    }
    const status = action === 'resolve' ? 'resolved' : 'open';
    await db.run('UPDATE complaints SET status = $1 WHERE id = $2', [status, row.id]);
    if (action === 'resolve') {
      await createNotification(
        row.user_id, 'complaint_resolved', 'Your complaint was resolved',
        `Your complaint "${row.subject}" has been reviewed and closed. Thank you for telling us.`,
        '#/complaint-status'
      );
    }
    await logAudit('admin', 'owner', `complaint_${action}`, 'complaint', row.id, {});
    res.json({ ok: true, status });
  } catch (err) {
    next(err);
  }
});

// --- Abuse-report dashboard (item 858): aggregates over the reports list ---

router.get('/abuse', async (req, res, next) => {
  try {
    const byReason = await db.query(
      `SELECT reason, COUNT(*) AS c FROM reports WHERE status = 'open' GROUP BY reason ORDER BY c DESC`
    );
    const byTarget = await db.query(
      `SELECT target_type, COUNT(*) AS c FROM reports WHERE status = 'open' GROUP BY target_type`
    );
    const topReporters = await db.query(
      `SELECT r.reporter_id, u.display_name, u.username, COUNT(*) AS c
       FROM reports r JOIN users u ON u.id = r.reporter_id
       GROUP BY r.reporter_id, u.display_name, u.username
       ORDER BY c DESC LIMIT 10`
    );
    const recentResolved = await db.query(
      `SELECT * FROM reports WHERE status = 'resolved' ORDER BY created_at DESC LIMIT 20`
    );
    const open = await db.get(`SELECT COUNT(*) AS c FROM reports WHERE status = 'open'`);
    res.json({
      openReports: Number(open?.c || 0),
      byReason: byReason.rows.map((r) => ({ reason: r.reason, count: Number(r.c) })),
      byTarget: byTarget.rows.map((r) => ({ targetType: r.target_type, count: Number(r.c) })),
      topReporters: topReporters.rows.map((r) => ({
        reporterId: r.reporter_id, displayName: r.display_name, username: r.username, reports: Number(r.c),
      })),
      recentResolved: recentResolved.rows,
    });
  } catch (err) {
    next(err);
  }
});

// --- Security view (items 826/827): reveal alerts + anomalies ---

router.get('/security', async (req, res, next) => {
  try {
    const [overThreshold, anomalies] = await Promise.all([
      accountsOverRevealThreshold(),
      recentRevealAnomalies(50),
    ]);
    const blocked24h = await db.get(
      `SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'payout_reveal_blocked' AND created_at >= $1`,
      [new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()]
    );
    const fingerprintChanges = await db.query(
      `SELECT actor_id, created_at FROM audit_logs
       WHERE action = 'session_fingerprint_changed' ORDER BY created_at DESC LIMIT 20`
    );
    res.json({
      accountsOverRevealThreshold: overThreshold,
      anomalies,
      blockedReveals24h: Number(blocked24h?.c || 0),
      fingerprintChanges: fingerprintChanges.rows.map((r) => ({ userId: r.actor_id, createdAt: r.created_at })),
    });
  } catch (err) {
    next(err);
  }
});

// --- Security status page content (item 886) ---

router.get('/security-status', async (req, res, next) => {
  try {
    const stored = await db.getSettingJson('security_status', null);
    res.json(stored || { status: 'normal', message: '', incidents: [] });
  } catch (err) {
    next(err);
  }
});

router.put('/security-status', async (req, res, next) => {
  try {
    const body = req.body || {};
    const status = ['normal', 'incident', 'maintenance'].includes(body.status) ? body.status : 'normal';
    const message = cleanStr(body.message || '', 500);
    const incidents = Array.isArray(body.incidents) ? body.incidents.slice(0, 20).map((i) => ({
      date: cleanStr(i.date || '', 20),
      title: cleanStr(i.title || '', 120),
      body: cleanStr(i.body || '', 500),
    })) : [];
    const value = { status, message, incidents };
    await db.setSetting('security_status', JSON.stringify(value));
    await logAudit('admin', 'owner', 'security_status_changed', 'settings', 'security_status', { status });
    res.json(value);
  } catch (err) {
    next(err);
  }
});

// --- Fraud-awareness banner (item 974) + known scams (item 976) ---

router.get('/fraud-banner', async (req, res, next) => {
  try {
    res.json(await db.getSettingJson('fraud_banner', { active: false, message: '' }));
  } catch (err) {
    next(err);
  }
});

router.put('/fraud-banner', async (req, res, next) => {
  try {
    const value = {
      active: req.body?.active === true,
      message: cleanStr(req.body?.message || '', 300),
    };
    await db.setSetting('fraud_banner', JSON.stringify(value));
    await logAudit('admin', 'owner', 'fraud_banner_changed', 'settings', 'fraud_banner', { active: value.active });
    res.json(value);
  } catch (err) {
    next(err);
  }
});

router.get('/known-scams', async (req, res, next) => {
  try {
    res.json({ scams: await db.getSettingJson('known_scams', []) });
  } catch (err) {
    next(err);
  }
});

router.put('/known-scams', async (req, res, next) => {
  try {
    const scams = Array.isArray(req.body?.scams) ? req.body.scams.slice(0, 20).map((s) => ({
      title: cleanStr(s.title || '', 120),
      body: cleanStr(s.body || '', 800),
      addedAt: cleanStr(s.addedAt || '', 20) || nowIso().slice(0, 10),
    })).filter((s) => s.title && s.body) : [];
    await db.setSetting('known_scams', JSON.stringify(scams));
    await logAudit('admin', 'owner', 'known_scams_changed', 'settings', 'known_scams', { count: scams.length });
    res.json({ scams });
  } catch (err) {
    next(err);
  }
});

// --- Emergency freeze (item 883) ---

router.get('/freeze', async (req, res, next) => {
  try {
    res.json(await getFreezeState());
  } catch (err) {
    next(err);
  }
});

router.put('/freeze', async (req, res, next) => {
  try {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'enabled must be true or false.' } });
    }
    res.json(await setEmergencyFreeze(enabled, req.body?.message));
  } catch (err) {
    next(err);
  }
});

// --- Monthly transparency report (item 966) ---
// GET builds the report for a month (YYYY-MM) from live data; POST
// publishes it (stored in settings, shown on the public transparency page).

async function buildTransparencyReport(month) {
  const [y, m] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1)).toISOString();
  const end = new Date(Date.UTC(y, m, 1)).toISOString();
  const q = async (sql, params = []) => (await db.get(sql, params)) || {};
  const billsPosted = await q('SELECT COUNT(*) AS c FROM bills WHERE created_at >= $1 AND created_at < $2', [start, end]);
  const approved = await q(`SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'review_approve' AND created_at >= $1 AND created_at < $2`, [start, end]);
  const rejected = await q(`SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'review_reject' AND created_at >= $1 AND created_at < $2`, [start, end]);
  const changes = await q(`SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'review_changes' AND created_at >= $1 AND created_at < $2`, [start, end]);
  const reportsFiled = await q(`SELECT COUNT(*) AS c FROM reports WHERE created_at >= $1 AND created_at < $2`, [start, end]);
  const reportsResolved = await q(`SELECT COUNT(*) AS c FROM audit_logs WHERE action LIKE 'report_%' AND created_at >= $1 AND created_at < $2`, [start, end]);
  const complaintsFiled = await q(`SELECT COUNT(*) AS c FROM complaints WHERE created_at >= $1 AND created_at < $2`, [start, end]);
  const complaintsResolved = await q(`SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'complaint_resolve' AND created_at >= $1 AND created_at < $2`, [start, end]);
  const giftsConfirmed = await q(`SELECT COUNT(*) AS c, COALESCE(SUM(amount_minor),0) AS total FROM gifts WHERE status = 'confirmed' AND confirmed_at >= $1 AND confirmed_at < $2`, [start, end]);
  const suspensions = await q(`SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'user_suspended' AND created_at >= $1 AND created_at < $2`, [start, end]);
  return {
    month,
    generatedAt: nowIso(),
    billsPosted: Number(billsPosted.c || 0),
    reviewDecisions: {
      approved: Number(approved.c || 0),
      rejected: Number(rejected.c || 0),
      changesRequested: Number(changes.c || 0),
    },
    reportsFiled: Number(reportsFiled.c || 0),
    reportsResolved: Number(reportsResolved.c || 0),
    complaintsFiled: Number(complaintsFiled.c || 0),
    complaintsResolved: Number(complaintsResolved.c || 0),
    giftsConfirmed: Number(giftsConfirmed.c || 0),
    giftsConfirmedTotalMinor: Number(giftsConfirmed.total || 0),
    suspensions: Number(suspensions.c || 0),
  };
}

router.get('/transparency-report', async (req, res, next) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || ''))
      ? String(req.query.month)
      : new Date().toISOString().slice(0, 7);
    const published = await db.getSettingJson('transparency_reports', {});
    res.json({ report: await buildTransparencyReport(month), published: published[month] || null });
  } catch (err) {
    next(err);
  }
});

router.post('/transparency-report', async (req, res, next) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(String(req.body?.month || ''))
      ? String(req.body.month)
      : new Date().toISOString().slice(0, 7);
    const report = await buildTransparencyReport(month);
    const published = await db.getSettingJson('transparency_reports', {});
    published[month] = report;
    await db.setSetting('transparency_reports', JSON.stringify(published));
    await logAudit('admin', 'owner', 'transparency_report_published', 'settings', `transparency:${month}`, {});
    res.json({ ok: true, report });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
