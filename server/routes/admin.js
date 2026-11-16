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
  createAdminSession, destroyAdminSession, requireAdmin, lookupAdminSession,
  sessionCookieOptions, ADMIN_SESSION_HOURS, rateLimit,
  getOrCreateCsrfToken,
} = require('../lib/auth');
const { cleanStr } = require('../lib/validate');
const { applyReviewDecision, createNotification } = require('../lib/notify');
const { deletePrivateFile } = require('../lib/storage');
const { getMaintenanceState, setMaintenanceMode } = require('../lib/maintenance');
const { SIGNAL_WEIGHTS, bandForScore, flagSignal } = require('../lib/fraud');

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
  // Phase 2 sections 4–6.
  'follows', 'user_blocks', 'achievements', 'thanks', 'thank_reactions',
  'receiver_stories', 'brand_profiles', 'brand_responses', 'message_threads',
  'messages', 'partnerships', 'drops', 'drop_entries', 'csr_updates',
  'appeals', 'signin_history', 'fraud_flags', 'auction_watchlist',
  'scam_notices', 'anon_stats',
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
    const pendingAppeals = await q(`SELECT COUNT(*) AS c FROM appeals WHERE status = 'open'`);
    const openFraudFlags = await q(`SELECT COUNT(*) AS c FROM fraud_flags WHERE status = 'open'`);
    const highRiskFlags = await q(`SELECT COUNT(*) AS c FROM fraud_flags WHERE status = 'open' AND severity = 'high'`);
    const pendingBrands = await q(`SELECT COUNT(*) AS c FROM brand_profiles WHERE status = 'pending_review'`);
    const openPartnerships = await q(`SELECT COUNT(*) AS c FROM partnerships WHERE status = 'open'`);
    const pendingConnects = await q(`SELECT COUNT(*) AS c FROM brand_connects WHERE status IN ('pending','under_review')`);
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
      pendingAppeals: Number(pendingAppeals.c || 0),
      openFraudFlags: Number(openFraudFlags.c || 0),
      highRiskFlags: Number(highRiskFlags.c || 0),
      pendingBrandProfiles: Number(pendingBrands.c || 0),
      openPartnerships: Number(openPartnerships.c || 0),
      pendingConnects: Number(pendingConnects.c || 0),
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
  // Suspension reason + duration (item 384). durationDays: null = indefinite.
  const reason = cleanStr(req.body?.reason || '', 600);
  const durationDays = req.body?.durationDays === undefined || req.body?.durationDays === null
    ? null
    : Math.max(1, Math.min(3650, Math.floor(Number(req.body.durationDays) || 0) || 0)) || null;
  const until = suspended && durationDays
    ? new Date(Date.now() + durationDays * 86400000).toISOString()
    : null;
  if (suspended) {
    await db.run(
      `UPDATE users SET suspended = 1, suspended_reason = $1, suspended_until = $2, suspended_at = $3 WHERE id = $4`,
      [reason, until, nowIso(), user.id]
    );
    await createNotification(
      user.id, 'account_suspended', 'Your account is suspended',
      (reason || 'Your account was suspended by the owner.')
        + (until ? ` It will be reviewed on ${until.slice(0, 10)}.` : '')
        + ' You can appeal from the Help Centre.',
      '#/help?topic=appeals'
    );
  } else {
    await db.run(
      `UPDATE users SET suspended = 0, suspended_reason = '', suspended_until = NULL, suspended_at = NULL WHERE id = $1`,
      [user.id]
    );
    await createNotification(
      user.id, 'account_restored', 'Your account is active again',
      'Your suspension was lifted. Welcome back.', '#/swipe'
    );
  }
  await logAudit('admin', 'owner', suspended ? 'user_suspended' : 'user_restored', 'user', user.id, { reason, durationDays });
  res.json({ ok: true, suspended, reason, suspendedUntil: until });
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
    // Oldest first (item 311): the longest-waiting request is reviewed first.
    // Bill title/category + wait time come from the joined bill row.
    const { rows } = await db.query(
      `SELECT v.*, u.display_name AS user_name, u.username AS user_username,
              b.title AS bill_title, b.category AS bill_category,
              b.amount_minor AS bill_amount_minor, b.currency AS bill_currency,
              (SELECT COUNT(*) FROM verifications v2 WHERE v2.doc_hash = v.doc_hash AND v.doc_hash IS NOT NULL AND v2.id != v.id) AS dup_doc_count
       FROM verifications v JOIN users u ON u.id = v.user_id
       LEFT JOIN bills b ON b.id = v.bill_id
       WHERE ${where} ORDER BY v.created_at ASC LIMIT 100`,
      params
    );
    res.json({
      verifications: rows.map((r) => ({
        ...r,
        waitHours: Math.max(0, Math.round((Date.now() - new Date(r.created_at).getTime()) / 3600000)),
        duplicateDoc: Number(r.dup_doc_count || 0) > 0,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/verifications/:id/history — per-request decision history
// (item 315) from the audit log: approve/reject/more-info/revoke events.
router.get('/verifications/:id/history', async (req, res, next) => {
  try {
    const row = await db.get('SELECT * FROM verifications WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Verification not found.' } });
    const { rows } = await db.query(
      `SELECT * FROM audit_logs WHERE target_type = 'verification' AND target_id = $1 ORDER BY created_at ASC LIMIT 100`,
      [row.id]
    );
    res.json({
      history: rows.map((r) => ({
        id: r.id, actorType: r.actor_type, actorId: r.actor_id, action: r.action,
        meta: JSON.parse(r.meta_json || '{}'), createdAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/verifications/:id {decision: approve|reject|more_required|revoke, note}
// Approve sets the badge expiry (item 306): ID/name/biller = 12 months;
// a bill badge lasts as long as its bill. Revoke (item 307) removes an
// approved badge with a reason + audit + poster notification.
router.post('/verifications/:id', async (req, res, next) => {
  try {
    const row = await db.get('SELECT * FROM verifications WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Verification not found.' } });
    const decision = req.body?.decision;
    if (!['approve', 'reject', 'more_required', 'revoke'].includes(decision)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Decision must be approve, reject, more_required or revoke.' } });
    }
    if (decision === 'revoke') {
      if (row.status !== 'approved') {
        return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'Only an approved badge can be revoked.' } });
      }
      const note = cleanStr(req.body?.note || '', 600);
      await db.run(
        `UPDATE verifications SET status = 'revoked', reviewer_note = $1, decided_at = $2, expires_at = NULL WHERE id = $3`,
        [note, nowIso(), row.id]
      );
      await createNotification(
        row.user_id, 'verification_revoked', 'A badge was removed',
        note || `Your ${row.type} verification was revoked by the owner.`,
        '#/verify'
      );
      await logAudit('admin', 'owner', 'verification_revoke', 'verification', row.id, { type: row.type, reason: note });
      const updated = await db.get('SELECT * FROM verifications WHERE id = $1', [row.id]);
      return res.json({ verification: updated });
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
    // Badge expiry (item 306). Bill badges follow their bill's expiry;
    // everything else lasts 12 months from approval.
    let expiresAt = null;
    if (decision === 'approve') {
      if (row.type === 'bill' && row.bill_id) {
        const bill = await db.get('SELECT expires_at, approved_at FROM bills WHERE id = $1', [row.bill_id]);
        expiresAt = bill?.expires_at
          || (bill?.approved_at ? new Date(new Date(bill.approved_at).getTime() + 30 * 86400000).toISOString() : null);
      } else {
        expiresAt = new Date(Date.now() + 365 * 86400000).toISOString();
      }
    }
    await db.run(
      `UPDATE verifications SET status = $1, reviewer_note = $2, decided_at = $3,
       doc_url = $4, expires_at = $5 WHERE id = $6`,
      [status, note, nowIso(), decision === 'more_required' ? row.doc_url : null, expiresAt, row.id]
    );
    // Duplicate-document alert (item 325): flag when the same document
    // hash was submitted before by a different user.
    if (row.doc_hash && decision !== 'more_required') {
      const dup = await db.get(
        `SELECT user_id FROM verifications WHERE doc_hash = $1 AND id != $2 AND user_id != $3 LIMIT 1`,
        [row.doc_hash, row.id, row.user_id]
      );
      if (dup) {
        await flagSignal({
          userId: row.user_id, signal: 'duplicate_document',
          detail: 'Same verification document hash as an earlier submission by another account.',
          severity: 'high',
        });
      }
    }
    await createNotification(
      row.user_id,
      status === 'approved' ? 'verification_approved' : 'verification_decided',
      status === 'approved' ? 'Verification approved' : status === 'rejected' ? 'Verification not approved' : 'More documents needed',
      note || `Your ${row.type} verification was ${status}.`,
      '#/verify'
    );
    await logAudit('admin', 'owner', `verification_${decision}`, 'verification', row.id, { type: row.type, docDeleted, expiresAt });
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
      `SELECT r.*, u.display_name AS reporter_name, u.username AS reporter_username,
              (SELECT COUNT(*) FROM reports r2 WHERE r2.reporter_id = r.reporter_id AND r2.decision = 'dismiss') AS reporter_dismissed_count
       FROM reports r JOIN users u ON u.id = r.reporter_id
       WHERE ${where} ORDER BY r.created_at DESC LIMIT 100`,
      params
    );
    res.json({
      reports: rows.map((r) => ({
        ...r,
        reporterDismissedCount: Number(r.reporter_dismissed_count || 0),
        // False-report signal (item 354): 3+ dismissed reports flags the
        // reporter for reviewer attention.
        reporterFlagged: Number(r.reporter_dismissed_count || 0) >= 3,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/reports/:id {action: dismiss|hide|pause|remove|suspend|restore, reason}
// The reason is stored on the report + in the audit meta (item 350).
router.post('/reports/:id', async (req, res, next) => {
  try {
    const report = await db.get('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!report) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Report not found.' } });
    const action = req.body?.action;
    if (!['dismiss', 'hide', 'pause', 'remove', 'suspend', 'restore'].includes(action)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Action must be dismiss, hide, pause, remove, suspend or restore.' } });
    }
    const reason = cleanStr(req.body?.reason || '', 600);
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
          // Reporter is notified of the outcome too (item 352).
          await createNotification(
            report.reporter_id, 'report_outcome', 'Report outcome: bill restored',
            'The bill you reported was reviewed and restored to the feed. Thank you for keeping Sahay Pay safe.',
            `#/bill/${bill.id}`
          );
        } else if (action === 'suspend') {
          await db.run('UPDATE users SET suspended = 1 WHERE id = $1', [bill.user_id]);
          await db.run(`UPDATE bills SET status = 'removed', updated_at = $1 WHERE id = $2`, [now, bill.id]);
        }
      }
    } else if (report.target_type === 'user' && action === 'suspend') {
      await db.run('UPDATE users SET suspended = 1 WHERE id = $1', [report.target_id]);
    } else if (report.target_type === 'auction') {
      // Auction reports (item 574): pause/remove/restore the auction.
      const auction = await db.get('SELECT * FROM auctions WHERE id = $1', [report.target_id]);
      if (auction) {
        if (action === 'hide' || action === 'pause') {
          await db.run(`UPDATE auctions SET status = 'under_investigation' WHERE id = $1`, [auction.id]);
        } else if (action === 'remove') {
          await db.run(`UPDATE auctions SET status = 'removed' WHERE id = $1`, [auction.id]);
          await createNotification(auction.user_id, 'auction_removed', 'Your auction was removed', 'Your auction was removed after a report review.', '#/auctions');
        } else if (action === 'restore') {
          await db.run(`UPDATE auctions SET status = 'approved' WHERE id = $1`, [auction.id]);
          await createNotification(auction.user_id, 'auction_restored', 'Your auction is live again', 'Your auction was reviewed and restored.', `#/auction/${auction.id}`);
          await createNotification(
            report.reporter_id, 'report_outcome', 'Report outcome: auction restored',
            'The auction you reported was reviewed and restored. Thank you for keeping Sahay Pay safe.',
            `#/auction/${auction.id}`
          );
        } else if (action === 'suspend') {
          await db.run('UPDATE users SET suspended = 1 WHERE id = $1', [auction.user_id]);
          await db.run(`UPDATE auctions SET status = 'removed' WHERE id = $1`, [auction.id]);
        }
      }
    } else if (report.target_type === 'message' && (action === 'remove' || action === 'hide')) {
      // Reported message: remove it from the thread.
      await db.run('DELETE FROM messages WHERE id = $1', [report.target_id]);
    }
    if (action === 'dismiss') {
      await createNotification(
        report.reporter_id, 'report_outcome', 'Report outcome: no action needed',
        'The report you filed was reviewed and no action was needed. Thank you for keeping Sahay Pay safe.',
        '#/help?topic=safety'
      );
    }
    await db.run(
      `UPDATE reports SET status = 'resolved', decision = $1, decision_reason = $2, decided_at = $3 WHERE id = $4`,
      [action, reason, now, report.id]
    );
    await logAudit('admin', 'owner', `report_${action}`, 'report', report.id, { targetType: report.target_type, targetId: report.target_id, reason });
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
    const params = [];
    const clauses = [];
    // Per-bill audit trail (item 378): entries targeting the bill, plus
    // entries whose meta references it (verification/report decisions).
    if (req.query.billId) {
      const billId = cleanStr(req.query.billId, 64);
      params.push(billId);
      params.push(`%"billId":"${billId}"%`);
      params.push(`%"targetId":"${billId}"%`);
      clauses.push(`(target_id = $${params.length - 2} OR meta_json LIKE $${params.length - 1} OR meta_json LIKE $${params.length})`);
    }
    // Per-user audit trail (item 379): entries by or about the user.
    if (req.query.userId) {
      const userId = cleanStr(req.query.userId, 64);
      params.push(userId);
      params.push(userId);
      clauses.push(`(actor_id = $${params.length - 1} OR target_id = $${params.length})`);
    }
    // Date range (item 380).
    if (req.query.from) { params.push(cleanStr(req.query.from, 32)); clauses.push(`created_at >= $${params.length}`); }
    if (req.query.to) { params.push(cleanStr(req.query.to, 32)); clauses.push(`created_at <= $${params.length}`); }
    if (req.query.action) { params.push(`%${cleanStr(req.query.action, 64)}%`); clauses.push(`action LIKE $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);
    const { rows } = await db.query(
      `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
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

// --- Fraud dashboard (items 331–345, 398) ---

// GET /api/admin/fraud — flagged bills, top signals, 30-day trends,
// unresolved high-risk flags (the weekly review list, item 345, computed
// on load — no scheduler on the free tier), and the published signal
// weights (item 398).
router.get('/fraud', async (req, res, next) => {
  try {
    const flags = await db.query(
      `SELECT f.*, b.title AS bill_title, b.status AS bill_status,
              u.display_name AS user_name, u.username AS user_username
       FROM fraud_flags f
       LEFT JOIN bills b ON b.id = f.bill_id
       LEFT JOIN users u ON u.id = f.user_id
       WHERE f.status = 'open' ORDER BY f.created_at DESC LIMIT 100`
    );
    const bySignal = await db.query(
      `SELECT signal, COUNT(*) AS c FROM fraud_flags WHERE status = 'open' GROUP BY signal ORDER BY c DESC`
    );
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    const trend = await db.query(
      `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS c FROM fraud_flags
       WHERE created_at >= $1 GROUP BY day ORDER BY day ASC`,
      [thirtyDaysAgo]
    );
    const riskBands = await db.query(
      `SELECT COALESCE(fraud_band, 'low') AS band, COUNT(*) AS c FROM bills
       WHERE status IN ('approved', 'pending_review', 'under_investigation') GROUP BY band`
    );
    const weights = Object.fromEntries(
      Object.entries(SIGNAL_WEIGHTS).map(([k, v]) => [k, { weight: v.weight, label: v.label }])
    );
    res.json({
      flags: flags.rows.map((r) => ({
        id: r.id, billId: r.bill_id, userId: r.user_id, signal: r.signal,
        detail: r.detail, severity: r.severity, status: r.status, createdAt: r.created_at,
        billTitle: r.bill_title, billStatus: r.bill_status,
        userName: r.user_name, userUsername: r.user_username,
      })),
      bySignal: bySignal.rows.map((r) => ({ signal: r.signal, count: Number(r.c) })),
      trend30d: trend.rows.map((r) => ({ day: r.day, count: Number(r.c) })),
      riskBands: Object.fromEntries(riskBands.rows.map((r) => [r.band, Number(r.c)])),
      weights,
      unresolvedHighRisk: flags.rows.filter((r) => r.severity === 'high').length,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/fraud/:id/resolve — mark a flag resolved.
router.post('/fraud/:id/resolve', async (req, res, next) => {
  try {
    const flag = await db.get('SELECT * FROM fraud_flags WHERE id = $1', [req.params.id]);
    if (!flag) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Flag not found.' } });
    await db.run(`UPDATE fraud_flags SET status = 'resolved', resolved_at = $1 WHERE id = $2`, [nowIso(), flag.id]);
    await logAudit('admin', 'owner', 'fraud_flag_resolved', 'fraud_flag', flag.id, { signal: flag.signal });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/bills/:id/fraud-override {band, reason} — manual
// fraud-band override with a written reason + audit (item 344).
router.post('/bills/:id/fraud-override', async (req, res, next) => {
  try {
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [req.params.id]);
    if (!bill) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
    const band = req.body?.band;
    if (!['low', 'medium', 'high', null, ''].includes(band)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Band must be low, medium, high, or empty to clear.' } });
    }
    const reason = cleanStr(req.body?.reason || '', 600);
    if (band && reason.length < 5) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'A reason (5+ characters) is required for an override.' } });
    }
    await db.run(
      `UPDATE bills SET fraud_override = $1, fraud_override_reason = $2 WHERE id = $3`,
      [band || null, reason, bill.id]
    );
    await logAudit('admin', 'owner', 'fraud_override', 'bill', bill.id, { band: band || null, reason });
    res.json({ ok: true, band: band || null });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/queue/bills — admin bill queue with risk bands (item 332).
router.get('/queue/bills', async (req, res, next) => {
  try {
    const status = ['pending_review', 'approved', 'under_investigation', 'rejected', 'removed'].includes(req.query.status)
      ? req.query.status
      : 'pending_review';
    const { rows } = await db.query(
      `SELECT b.*, u.display_name AS poster_name, u.username AS poster_username,
              u.created_at AS poster_created_at,
              (SELECT COUNT(*) FROM fraud_flags f WHERE f.bill_id = b.id AND f.status = 'open') AS open_flags
       FROM bills b JOIN users u ON u.id = b.user_id
       WHERE b.status = $1 ORDER BY b.created_at ASC LIMIT 100`,
      [status]
    );
    res.json({
      bills: rows.map((r) => ({
        id: r.id, requestCode: r.request_code, title: r.title, category: r.category,
        amountMinor: r.amount_minor, currency: r.currency, status: r.status,
        city: r.city, country: r.country, createdAt: r.created_at,
        posterName: r.poster_name, posterUsername: r.poster_username,
        posterAgeHours: Math.max(0, Math.round((Date.now() - new Date(r.poster_created_at).getTime()) / 3600000)),
        fraudScore: r.fraud_score, fraudBand: r.fraud_override || r.fraud_band || 'low',
        fraudOverride: r.fraud_override || null,
        fraudOverrideReason: r.fraud_override_reason || '',
        openFlags: Number(r.open_flags || 0),
        // New-account + high-value flag (item 342).
        newAccountHighValue:
          (Date.now() - new Date(r.poster_created_at).getTime()) < 24 * 3600000 && r.amount_minor >= 2500000,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/trust-report?month=YYYY-MM — monthly roll-up (item 399).
router.get('/trust-report', async (req, res, next) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '')
      ? req.query.month
      : new Date().toISOString().slice(0, 7);
    const [y, m] = month.split('-').map(Number);
    const start = new Date(Date.UTC(y, m - 1, 1)).toISOString();
    const end = new Date(Date.UTC(y, m, 1)).toISOString();
    const q = async (sql, params = []) => Number((await db.get(sql, params))?.c || 0);
    const verificationsCompleted = await q(
      `SELECT COUNT(*) AS c FROM verifications WHERE decided_at >= $1 AND decided_at < $2 AND status IN ('approved','rejected')`,
      [start, end]
    );
    const verificationsApproved = await q(
      `SELECT COUNT(*) AS c FROM verifications WHERE decided_at >= $1 AND decided_at < $2 AND status = 'approved'`,
      [start, end]
    );
    const reportsResolved = await q(
      `SELECT COUNT(*) AS c FROM reports WHERE decided_at >= $1 AND decided_at < $2`,
      [start, end]
    );
    const reportsFiled = await q(
      `SELECT COUNT(*) AS c FROM reports WHERE created_at >= $1 AND created_at < $2`,
      [start, end]
    );
    const billsPaused = await q(
      `SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'bill_auto_paused' AND created_at >= $1 AND created_at < $2`,
      [start, end]
    );
    const fraudFlags = await q(
      `SELECT COUNT(*) AS c FROM fraud_flags WHERE created_at >= $1 AND created_at < $2`,
      [start, end]
    );
    const appealsDecided = await q(
      `SELECT COUNT(*) AS c FROM appeals WHERE decided_at >= $1 AND decided_at < $2`,
      [start, end]
    );
    res.json({
      month, verificationsCompleted, verificationsApproved, reportsFiled, reportsResolved,
      billsPaused, fraudFlags, appealsDecided,
    });
  } catch (err) {
    next(err);
  }
});

// --- Velocity caps (item 333) ---

router.get('/velocity', async (req, res, next) => {
  try {
    const [day, week, giftHour, revealDay] = await Promise.all([
      db.getSetting('bill_day_cap'), db.getSetting('bill_week_cap'),
      db.getSetting('gift_hour_cap'), db.getSetting('reveal_day_cap'),
    ]);
    res.json({
      billDayCap: Number(day) || 3,
      billWeekCap: Number(week) || 10,
      giftHourCap: Number(giftHour) || 10,
      revealDayCap: Number(revealDay) || 20,
    });
  } catch (err) {
    next(err);
  }
});

router.put('/velocity', async (req, res, next) => {
  try {
    const caps = [
      ['bill_day_cap', req.body?.billDayCap],
      ['bill_week_cap', req.body?.billWeekCap],
      ['gift_hour_cap', req.body?.giftHourCap],
      ['reveal_day_cap', req.body?.revealDayCap],
    ];
    for (const [key, value] of caps) {
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value < 1 || value > 1000) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: `${key} must be an integer between 1 and 1000.` } });
      }
      await db.setSetting(key, String(value));
    }
    await logAudit('admin', 'owner', 'velocity_caps_changed', 'settings', 'velocity', {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- Appeals (items 351, 384) ---

router.get('/appeals', async (req, res, next) => {
  try {
    const status = req.query.status;
    const params = [];
    let where = '1=1';
    if (status) { params.push(status); where = `a.status = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT a.*, u.display_name AS user_name, u.username AS user_username
       FROM appeals a JOIN users u ON u.id = a.user_id
       WHERE ${where} ORDER BY a.created_at ASC LIMIT 100`,
      params
    );
    res.json({ appeals: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/appeals/:id {decision: uphold|overturn, note}
router.post('/appeals/:id', async (req, res, next) => {
  try {
    const appeal = await db.get('SELECT * FROM appeals WHERE id = $1', [req.params.id]);
    if (!appeal) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Appeal not found.' } });
    if (appeal.status !== 'open') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `This appeal is already ${appeal.status}.` } });
    }
    const decision = req.body?.decision;
    if (!['uphold', 'overturn'].includes(decision)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Decision must be uphold or overturn.' } });
    }
    const note = cleanStr(req.body?.note || '', 600);
    const now = nowIso();
    const status = decision === 'overturn' ? 'overturned' : 'upheld';
    await db.run(
      `UPDATE appeals SET status = $1, reviewer_note = $2, decided_at = $3 WHERE id = $4`,
      [status, note, now, appeal.id]
    );
    if (decision === 'overturn') {
      if (appeal.target_type === 'bill') {
        const bill = await db.get('SELECT * FROM bills WHERE id = $1', [appeal.target_id]);
        if (bill && ['removed', 'under_investigation', 'rejected'].includes(bill.status)) {
          await db.run(`UPDATE bills SET status = 'approved', updated_at = $1 WHERE id = $2`, [now, bill.id]);
        }
      } else if (appeal.target_type === 'user') {
        await db.run(
          `UPDATE users SET suspended = 0, suspended_reason = '', suspended_until = NULL, suspended_at = NULL WHERE id = $1`,
          [appeal.target_id]
        );
      }
    }
    await createNotification(
      appeal.user_id,
      decision === 'overturn' ? 'appeal_overturned' : 'appeal_upheld',
      decision === 'overturn' ? 'Your appeal was accepted' : 'Your appeal was reviewed',
      note || (decision === 'overturn' ? 'The decision was reversed.' : 'The original decision stands.'),
      '#/help?topic=appeals'
    );
    await logAudit('admin', 'owner', `appeal_${decision}`, 'appeal', appeal.id, { targetType: appeal.target_type, targetId: appeal.target_id });
    res.json({ ok: true, status });
  } catch (err) {
    next(err);
  }
});

// --- Partnerships inbox (item 554) ---

router.get('/partnerships', async (req, res, next) => {
  try {
    const status = req.query.status;
    const params = [];
    let where = '1=1';
    if (status) { params.push(status); where = `status = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT * FROM partnerships WHERE ${where} ORDER BY created_at ASC LIMIT 100`,
      params
    );
    res.json({ partnerships: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/partnerships/:id', async (req, res, next) => {
  try {
    const row = await db.get('SELECT * FROM partnerships WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Partnership enquiry not found.' } });
    const status = req.body?.status;
    if (!['open', 'reviewed', 'declined'].includes(status)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Status must be open, reviewed or declined.' } });
    }
    await db.run('UPDATE partnerships SET status = $1 WHERE id = $2', [status, row.id]);
    await logAudit('admin', 'owner', 'partnership_reviewed', 'partnership', row.id, { status });
    res.json({ ok: true, status });
  } catch (err) {
    next(err);
  }
});

// --- Brand Connect review queue (items 521, 531) ---

router.get('/connects', async (req, res, next) => {
  try {
    const status = req.query.status;
    const params = [];
    let where = '1=1';
    if (status) { params.push(status); where = `bc.status = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT bc.*, br.name AS ask_name, br.user_id AS asker_id, u.display_name AS asker_name
       FROM brand_connects bc JOIN brands br ON br.id = bc.brand_id
       LEFT JOIN users u ON u.id = br.user_id
       WHERE ${where} ORDER BY bc.created_at ASC LIMIT 100`,
      params
    );
    res.json({ connects: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/connects/:id {decision: approve|decline, note} — owner
// review before any introduction (item 531). Approve sets the connect
// 'connected' (item 521) and logs the introduction in-app for both sides;
// the email half (item 532) is the owner's manual action, NEEDS-DANISH.
router.post('/connects/:id', async (req, res, next) => {
  try {
    const connect = await db.get('SELECT * FROM brand_connects WHERE id = $1', [req.params.id]);
    if (!connect) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Connect request not found.' } });
    const decision = req.body?.decision;
    if (!['approve', 'decline'].includes(decision)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Decision must be approve or decline.' } });
    }
    const note = cleanStr(req.body?.note || '', 600);
    const status = decision === 'approve' ? 'connected' : 'declined';
    await db.run('UPDATE brand_connects SET status = $1 WHERE id = $2', [status, connect.id]);
    const brand = await db.get('SELECT * FROM brands WHERE id = $1', [connect.brand_id]);
    if (brand && decision === 'approve') {
      await createNotification(
        brand.user_id, 'brand_introduced', 'You were introduced to a brand',
        `${connect.brand_name} was introduced to you about your ask for ${brand.name}. The owner will be in touch outside the app if needed.`,
        `#/brand/${brand.id}`
      );
    }
    if (connect.requester_id && decision === 'approve') {
      await createNotification(
        connect.requester_id, 'brand_introduced', 'Introduction approved',
        `Your connection request for ${connect.brand_name} was approved. The owner will introduce you to the asker.`,
        `#/brand/${connect.brand_id}`
      );
    }
    await logAudit('admin', 'owner', `connect_${decision}`, 'brand_connect', connect.id, { note });
    res.json({ ok: true, status });
  } catch (err) {
    next(err);
  }
});

// --- Auction moderation (item 570) ---

router.post('/auctions/:id', async (req, res, next) => {
  try {
    const auction = await db.get('SELECT * FROM auctions WHERE id = $1', [req.params.id]);
    if (!auction) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Auction not found.' } });
    const action = req.body?.action;
    if (!['pause', 'remove', 'relist'].includes(action)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Action must be pause, remove or relist.' } });
    }
    const reason = cleanStr(req.body?.reason || '', 600);
    const status = action === 'pause' ? 'under_investigation' : action === 'remove' ? 'removed' : 'approved';
    await db.run('UPDATE auctions SET status = $1 WHERE id = $2', [status, auction.id]);
    await createNotification(
      auction.user_id, `auction_${action}`, `Your auction was ${action === 'relist' ? 'listed again' : action + 'd'}`,
      reason || '', `#/auction/${auction.id}`
    );
    await logAudit('admin', 'owner', `auction_${action}`, 'auction', auction.id, { reason });
    res.json({ ok: true, status });
  } catch (err) {
    next(err);
  }
});

// --- Scam notices (item 365): admin-posted, no scheduler ---

router.get('/scam-notices', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM scam_notices ORDER BY created_at DESC LIMIT 20');
    res.json({ notices: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/scam-notices', async (req, res, next) => {
  try {
    const title = cleanStr(req.body?.title, 200);
    const body = cleanStr(req.body?.body, 2000);
    if (title.length < 3 || body.length < 10) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Title (3+) and body (10+) are required.' } });
    }
    const id = require('crypto').randomUUID();
    await db.run(
      `INSERT INTO scam_notices (id, title, body, created_at) VALUES ($1, $2, $3, $4)`,
      [id, title, body, nowIso()]
    );
    await logAudit('admin', 'owner', 'scam_notice_posted', 'scam_notice', id, {});
    res.status(201).json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

// --- Featured brand of the week (items 544, 547) ---

router.put('/featured-brand', async (req, res, next) => {
  try {
    const brandProfileId = req.body?.brandProfileId ? cleanStr(req.body.brandProfileId, 64) : '';
    if (brandProfileId) {
      const bp = await db.get('SELECT * FROM brand_profiles WHERE id = $1', [brandProfileId]);
      if (!bp || bp.status !== 'approved') {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'Only an approved brand profile can be featured.' } });
      }
    }
    // ISO week key — the slot rotates on read when the week changes.
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const day = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - day + 3);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((d - yearStart) / 86400000 - 3 + ((yearStart.getUTCDay() + 6) % 7)) / 7);
    const weekKey = `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
    await db.setSetting('featured_brand_id', brandProfileId);
    await db.setSetting('featured_brand_week', weekKey);
    await logAudit('admin', 'owner', 'featured_brand_set', 'settings', 'featured_brand_id', { brandProfileId, weekKey });
    res.json({ ok: true, brandProfileId, week: weekKey });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
