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
const { logAudit, nowIso, verifyAuditChain } = require('../lib/audit');
const {
  isPinSet, setupPin, verifyAdminPin, changePin,
  createAdminSession, destroyAdminSession, requireAdmin, requireRole,
  blockViewerWrites, lookupAdminSession,
  sessionCookieOptions, ADMIN_SESSION_HOURS, rateLimit,
  getOrCreateCsrfToken, verifyAdminUserPin, createAdminInvite,
  redeemAdminInvite, listAdminUsers, getAdminUser, createAdminUser,
  deleteAdminUser, getSecuritySettings,
} = require('../lib/auth');
const { cleanStr } = require('../lib/validate');
const { applyReviewDecision, createNotification, sendOwnerWebhook, createReviewPacket, billPacketPayload } = require('../lib/notify');
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
// Item 777: the rate limit is 5 attempts per 15 minutes (per IP), and
// per-admin accounts have their own lockout (see verifyAdminUserPin).
// Two paths: {pin} alone = the owner's shared PIN; {adminId, pin} = a
// per-admin account's individual PIN (items 771–772).
router.post('/login', rateLimit('admin-login', 5, 15 * 60 * 1000), async (req, res, next) => {
  try {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const adminId = cleanStr(req.body?.adminId || '', 64);
    if (adminId) {
      const result = await verifyAdminUserPin(adminId, req.body?.pin);
      if (!result.ok) {
        await logAudit('admin', adminId, 'admin_login_failed', 'admin', 'login', { ip, locked: Boolean(result.locked) });
        return res.status(result.locked ? 423 : 401).json({
          error: {
            code: result.locked ? 'ADMIN_LOCKED' : 'INVALID_PIN',
            message: result.error,
            lockedUntil: result.lockedUntil || null,
            remaining: result.remaining,
          },
        });
      }
      const session = await createAdminSession(result.adminUser.id, req.headers['user-agent']);
      res.cookie('sp_admin', session.token, sessionCookieOptions(ADMIN_SESSION_HOURS * 60 * 60 * 1000, req));
      await logAudit('admin', result.adminUser.id, 'admin_login', 'admin', 'login', { ip, role: result.adminUser.role });
      return res.json({
        ok: true, sessionExpiresAt: session.expiresAt, csrfToken: session.csrfToken,
        role: result.adminUser.role, displayName: result.adminUser.display_name, adminUserId: result.adminUser.id,
      });
    }
    if (!(await isPinSet())) {
      return res.status(403).json({
        error: { code: 'PIN_NOT_SET', message: 'No admin PIN has been set yet. Set one on the setup screen first.' },
      });
    }
    const ok = await verifyAdminPin(req.body?.pin);
    // Client IP in the audit meta for login events, success + failure
    // (item 238). req.ip is the real client IP (trust proxy is set).
    if (!ok) {
      await logAudit('admin', 'owner', 'admin_login_failed', 'admin', 'login', { ip });
      return res.status(401).json({ error: { code: 'INVALID_PIN', message: 'Incorrect PIN.' } });
    }
    const session = await createAdminSession(null, req.headers['user-agent']);
    res.cookie('sp_admin', session.token, sessionCookieOptions(ADMIN_SESSION_HOURS * 60 * 60 * 1000, req));
    await logAudit('admin', 'owner', 'admin_login', 'admin', 'login', { ip });
    res.json({ ok: true, sessionExpiresAt: session.expiresAt, csrfToken: session.csrfToken, role: 'owner', displayName: 'Owner' });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/redeem-invite {code, displayName, pin} — creates a
// per-admin account from a one-time invite code the owner generated
// (item 773). Public route (no admin session yet), rate-limited.
router.post('/redeem-invite', rateLimit('admin-redeem', 10, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const result = await redeemAdminInvite(req.body?.code, req.body?.displayName, req.body?.pin);
    if (!result.ok) return res.status(400).json({ error: { code: 'INVITE_FAILED', message: result.error } });
    res.status(201).json({ ok: true, adminUser: result.adminUser });
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
    if (!row) return res.json({ admin: false });
    // Items 771/772: resolve the role so the console can hide write UI
    // for viewers. A session with no admin_user_id is the owner.
    let role = 'owner';
    let displayName = 'Owner';
    let adminUserId = null;
    if (row.admin_user_id) {
      const adminUser = await db.get('SELECT * FROM admin_users WHERE id = $1', [row.admin_user_id]);
      if (adminUser) {
        role = adminUser.role;
        displayName = adminUser.display_name;
        adminUserId = adminUser.id;
      }
    }
    res.json({ admin: true, role, displayName, adminUserId });
  } catch (err) {
    next(err);
  }
});

// Everything below requires a valid admin session.
// Viewers are read-only (item 772): blockViewerWrites rejects every
// non-GET request from a viewer account.
router.use(requireAdmin, blockViewerWrites);

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
  // Phase 2 §7–8 tables (admin_users/admin_invites are exported below
  // with explicit column lists — their PIN/code hashes never leave).
  'message_threads', 'messages', 'thank_you_notes', 'announcements',
  'appeals', 'case_notes', 'webhook_deliveries', 'broadcasts', 'audit_archive',
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
              privacy_accepted_version, privacy_accepted_at, suspended,
              referral_code, referred_by, suspended_until, suspension_reason,
              admin_notes, trusted_poster, watchlist, banned, created_at
       FROM users ORDER BY 1`
    );
    tables.users = users.rows;
    for (const t of EXPORT_TABLES) {
      const r = await db.query(`SELECT * FROM ${t} ORDER BY 1`);
      tables[t] = r.rows;
    }
    // Admin accounts: never the PIN hash / invite code hash.
    const adminUsers = await db.query(
      `SELECT id, display_name, role, failed_attempts, locked_until, created_at, last_login_at
       FROM admin_users ORDER BY 1`
    );
    tables.admin_users = adminUsers.rows;
    const adminInvites = await db.query(
      `SELECT id, role, created_by, created_at, used_at, used_by FROM admin_invites ORDER BY 1`
    );
    tables.admin_invites = adminInvites.rows;
    // Settings: everything except secrets.
    const settings = await db.query('SELECT key, value FROM settings ORDER BY 1');
    tables.settings = settings.rows.filter(
      (row) => !SECRET_SETTING_KEYS.has(row.key) && !SECRET_SETTING_PATTERN.test(row.key)
    );
    await logAudit('admin', req.admin.actor, 'admin_data_export', 'admin', 'export', {
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

router.put('/maintenance', requireRole('owner'), async (req, res, next) => {
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

// The shared owner PIN can only be changed by the owner (per-admin
// accounts have their own PINs and cannot touch it).
router.post('/change-pin', requireRole('owner'), async (req, res, next) => {
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
    // Phase 2 §8 dashboard alerts: overdue review packets (715: pending
    // > 48h), stuck gifts (755: donor-reported > 7 days), overdue reports
    // (764: open > 72h). Computed lazily — no scheduler exists.
    const overduePackets = await q(
      `SELECT COUNT(*) AS c FROM review_packets
       WHERE status = 'pending' AND created_at < $1`,
      [new Date(Date.now() - 48 * 3600000).toISOString()]
    );
    const stuckGifts = await q(
      `SELECT COUNT(*) AS c FROM gifts
       WHERE status = 'donor_reported_sent' AND created_at < $1`,
      [new Date(Date.now() - 7 * 24 * 3600000).toISOString()]
    );
    const overdueReports = await q(
      `SELECT COUNT(*) AS c FROM reports
       WHERE status = 'open' AND created_at < $1`,
      [new Date(Date.now() - 72 * 3600000).toISOString()]
    );
    const openAppeals = await q(`SELECT COUNT(*) AS c FROM appeals WHERE status = 'open'`);
    const openDisputes = await q(`SELECT COUNT(*) AS c FROM gifts WHERE status = 'disputed'`);
    res.json({
      users: Number(users.c || 0),
      suspendedUsers: Number(suspended.c || 0),
      billsByStatus: Object.fromEntries(billsByStatus.rows.map((r) => [r.status, Number(r.c)])),
      pendingReviewPackets: Number(pendingPackets.c || 0),
      openReports: Number(openReports.c || 0),
      openComplaints: Number(openComplaints.c || 0),
      pendingVerifications: Number(pendingVerif.c || 0),
      overdueReviewPackets: Number(overduePackets.c || 0),
      stuckGifts: Number(stuckGifts.c || 0),
      overdueReports: Number(overdueReports.c || 0),
      openAppeals: Number(openAppeals.c || 0),
      openDisputes: Number(openDisputes.c || 0),
      confirmedHelpVolume: volume.rows.map((r) => ({ currency: r.currency, totalMinor: Number(r.total), gifts: Number(r.gifts) })),
      founderTipsConfirmed: tips.rows.map((r) => ({ currency: r.currency, totalMinor: Number(r.total) })),
      giftsByStatus: Object.fromEntries(giftsByStatus.rows.map((r) => [r.status, Number(r.c)])),
    });
  } catch (err) {
    next(err);
  }
});

// --- Review queue ---

// GET /api/admin/queue — Phase 2 §8 filters (709–711): ?status (incl.
// 'held'), ?target_type (bill|brand|auction|photo), ?order (oldest|newest),
// ?flagged=1 (bills with report_count > 0), ?q (search in payload title /
// request code / requester name). Watchlist posters sort first (731).
router.get('/queue', async (req, res, next) => {
  try {
    const status = ['pending', 'approved', 'rejected', 'changes_requested', 'held'].includes(req.query.status)
      ? req.query.status
      : 'pending';
    const targetType = ['bill', 'brand', 'auction', 'photo'].includes(req.query.target_type)
      ? req.query.target_type
      : null;
    const order = req.query.order === 'oldest' ? 'ASC' : 'DESC';
    const flagged = req.query.flagged === '1';
    const q = cleanStr(req.query.q || '', 120).toLowerCase();
    const params = [status];
    let where = 'status = $1';
    if (targetType) { params.push(targetType); where += ` AND target_type = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT * FROM review_packets WHERE ${where} ORDER BY created_at ${order} LIMIT 200`,
      params
    );
    const packets = [];
    for (const r of rows) {
      let payload = {};
      try { payload = JSON.parse(r.payload_json || '{}'); } catch { /* keep {} */ }
      if (q) {
        const hay = `${payload.title || ''} ${payload.requestCode || ''} ${payload.requester?.displayName || ''} ${payload.requester?.username || ''}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      let flaggedBill = false;
      let watchlisted = false;
      let approvedBy = null;
      if (r.target_type === 'bill') {
        const bill = await db.get('SELECT report_count, approved_by, user_id FROM bills WHERE id = $1', [r.target_id]);
        if (bill) {
          flaggedBill = Number(bill.report_count || 0) > 0;
          approvedBy = bill.approved_by || null;
          const poster = await db.get('SELECT watchlist FROM users WHERE id = $1', [bill.user_id]);
          watchlisted = poster?.watchlist === 1;
        }
      }
      if (flagged && !flaggedBill) continue;
      packets.push({
        id: r.id,
        targetType: r.target_type,
        targetId: r.target_id,
        payload,
        status: r.status,
        createdAt: r.created_at,
        flagged: flaggedBill,
        watchlisted,
        approvedBy,
      });
    }
    // Watchlisted posters first (731) — the admin sees the riskiest
    // packets at the top without changing the requested time order.
    packets.sort((a, b) => Number(b.watchlisted) - Number(a.watchlisted));
    res.json({ packets: packets.slice(0, 100) });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/review/bulk {packetIds[], decision, reason} — items
// 705–708: decide many packets at once. The frontend shows a confirmation
// dialog listing the count before sending; the server decides each packet
// through the same applyReviewDecision path and reports per-packet results
// (a single bad packet never blocks the rest).
router.post('/review/bulk', async (req, res, next) => {
  try {
    const packetIds = req.body?.packetIds;
    if (!Array.isArray(packetIds) || packetIds.length < 1 || packetIds.length > 50) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'packetIds must be an array of 1–50 packet ids.' } });
    }
    const decision = req.body?.decision;
    if (!['approve', 'reject', 'changes'].includes(decision)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Decision must be approve, reject or changes.' } });
    }
    const reason = cleanStr(req.body?.reason || '', 600);
    if (decision !== 'approve' && !reason) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'A reason is required for reject / changes.' } });
    }
    const results = [];
    for (const packetId of packetIds) {
      const result = await applyReviewDecision(String(packetId), decision, reason, 'admin', req.admin.actor);
      results.push({
        packetId: String(packetId),
        ok: result.ok,
        packetStatus: result.packetStatus || null,
        error: result.ok ? null : result.error,
      });
    }
    const decided = results.filter((r) => r.ok).length;
    await logAudit('admin', req.admin.actor, `review_bulk_${decision}`, 'review', 'bulk', {
      requested: packetIds.length, decided, reason,
    });
    res.json({ ok: true, requested: packetIds.length, decided, results });
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
      req.admin.actor
    );
    if (!result.ok) {
      return res.status(result.status || 400).json({ error: { code: 'REVIEW_FAILED', message: result.error } });
    }
    res.json({ ok: true, packetStatus: result.packetStatus });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/review/:packetId/hold {note} — item 713: park a packet
// in 'held' status (not pending, not decided) while the owner waits for
// more information. /unhold returns it to 'pending'.
router.post('/review/:packetId/hold', async (req, res, next) => {
  try {
    const packet = await db.get('SELECT * FROM review_packets WHERE id = $1', [req.params.packetId]);
    if (!packet) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Review packet not found.' } });
    if (packet.status !== 'pending') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `Only a pending packet can be held (current: ${packet.status}).` } });
    }
    await db.run(`UPDATE review_packets SET status = 'held' WHERE id = $1`, [packet.id]);
    await logAudit('admin', req.admin.actor, 'review_held', packet.target_type, packet.target_id, {
      packetId: packet.id, note: cleanStr(req.body?.note || '', 600),
    });
    res.json({ ok: true, packetStatus: 'held' });
  } catch (err) {
    next(err);
  }
});

router.post('/review/:packetId/unhold', async (req, res, next) => {
  try {
    const packet = await db.get('SELECT * FROM review_packets WHERE id = $1', [req.params.packetId]);
    if (!packet) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Review packet not found.' } });
    if (packet.status !== 'held') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `Only a held packet can be unheld (current: ${packet.status}).` } });
    }
    await db.run(`UPDATE review_packets SET status = 'pending' WHERE id = $1`, [packet.id]);
    await logAudit('admin', req.admin.actor, 'review_unheld', packet.target_type, packet.target_id, { packetId: packet.id });
    res.json({ ok: true, packetStatus: 'pending' });
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
      // Item 724 (swap): no email search exists (the product has no
      // email); search by display name, username, or exact user id.
      if (/^[0-9a-f-]{36}$/i.test(search)) {
        params.push(search);
        where = `u.id = $1`;
      } else {
        params.push(`%${search}%`); params.push(`%${search}%`);
        where = `(u.display_name LIKE $1 OR u.username LIKE $2)`;
      }
    }
    const { rows } = await db.query(
      `SELECT u.*,
              (SELECT COUNT(*) FROM bills b WHERE b.user_id = u.id) AS bill_count,
              (SELECT COUNT(*) FROM bills b WHERE b.user_id = u.id AND b.status = 'approved') AS approved_count,
              (SELECT COUNT(*) FROM gifts g WHERE g.supporter_id = u.id AND g.status = 'confirmed') AS gifts_sent_count
       FROM users u WHERE ${where} ORDER BY u.created_at DESC LIMIT 100`,
      params
    );
    res.json({
      users: rows.map((r) => ({
        id: r.id, displayName: r.display_name, username: r.username, age: r.age,
        country: r.country, city: r.city, about: r.about, language: r.language,
        photoUrl: r.photo_url, suspended: r.suspended === 1, createdAt: r.created_at,
        billCount: Number(r.bill_count), approvedCount: Number(r.approved_count),
        giftsSentCount: Number(r.gifts_sent_count),
        suspendedUntil: r.suspended_until || null, suspensionReason: r.suspension_reason || '',
        trustedPoster: r.trusted_poster === 1, watchlist: r.watchlist === 1, banned: r.banned === 1,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/users/:id — item 725: full user detail (bills, gifts,
// reports, verifications, message history) for the admin user page.
router.get('/users/:id', async (req, res, next) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
    const bills = await db.query(
      `SELECT id, request_code, title, category, amount_minor, covered_minor, currency,
              status, approved_by, report_count, created_at
       FROM bills WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [user.id]
    );
    const giftsGiven = await db.query(
      `SELECT g.id, g.bill_id, g.amount_minor, g.currency, g.status, g.created_at, b.title AS bill_title
       FROM gifts g JOIN bills b ON b.id = g.bill_id WHERE g.supporter_id = $1 ORDER BY g.created_at DESC LIMIT 50`,
      [user.id]
    );
    const giftsReceived = await db.query(
      `SELECT g.id, g.bill_id, g.supporter_id, g.amount_minor, g.currency, g.status, g.created_at, b.title AS bill_title
       FROM gifts g JOIN bills b ON b.id = g.bill_id WHERE b.user_id = $1 ORDER BY g.created_at DESC LIMIT 50`,
      [user.id]
    );
    const reportsAgainst = await db.query(
      `SELECT * FROM reports WHERE target_type = 'user' AND target_id = $1
       OR (target_type = 'bill' AND target_id IN (SELECT id FROM bills WHERE user_id = $1))
       ORDER BY created_at DESC LIMIT 50`,
      [user.id]
    );
    const reportsFiled = await db.query(
      `SELECT * FROM reports WHERE reporter_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [user.id]
    );
    const verifications = await db.query(
      `SELECT id, bill_id, type, status, reviewer_note, created_at, decided_at
       FROM verifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [user.id]
    );
    const threads = await db.query(
      `SELECT t.*, b.title AS bill_title FROM message_threads t JOIN bills b ON b.id = t.bill_id
       WHERE t.supporter_id = $1 OR t.poster_id = $1 ORDER BY t.updated_at DESC LIMIT 20`,
      [user.id]
    );
    const threadIds = threads.rows.map((t) => t.id);
    let messages = [];
    if (threadIds.length) {
      const ph = threadIds.map((_, i) => `$${i + 1}`).join(',');
      const msgs = await db.query(
        `SELECT id, thread_id, sender_id, body, is_read, hidden, created_at
         FROM messages WHERE thread_id IN (${ph}) ORDER BY created_at DESC LIMIT 100`,
        threadIds
      );
      messages = msgs.rows;
    }
    // Item 730: trusted-poster auto-suggest — 3+ approved bills, zero
    // reports against, never suspended.
    const approvedCount = bills.rows.filter((b) => b.status === 'approved' || b.status === 'completed').length;
    const trustedSuggested = approvedCount >= 3 && reportsAgainst.rows.length === 0 && user.suspended !== 1 && user.banned !== 1;
    res.json({
      user: {
        id: user.id, displayName: user.display_name, username: user.username, age: user.age,
        country: user.country, city: user.city, about: user.about, language: user.language,
        photoUrl: user.photo_url, suspended: user.suspended === 1, createdAt: user.created_at,
        suspendedUntil: user.suspended_until || null, suspensionReason: user.suspension_reason || '',
        adminNotes: user.admin_notes || '', trustedPoster: user.trusted_poster === 1,
        watchlist: user.watchlist === 1, banned: user.banned === 1,
        referralCode: user.referral_code || null, referredBy: user.referred_by || null,
      },
      trustedSuggested,
      bills: bills.rows,
      giftsGiven: giftsGiven.rows,
      giftsReceived: giftsReceived.rows,
      reportsAgainst: reportsAgainst.rows,
      reportsFiled: reportsFiled.rows,
      verifications: verifications.rows,
      messageThreads: threads.rows,
      messages,
    });
  } catch (err) {
    next(err);
  }
});

// Items 726/727: suspension now needs a MANDATORY reason (shown to the
// user in-app) and can be temporary (7 or 30 days) or indefinite
// (days omitted). The reason is stored and the user is notified.
async function setSuspended(req, res, suspended) {
  const user = await db.get('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  if (suspended) {
    const reason = cleanStr(req.body?.reason || '', 600);
    if (!reason) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'A suspension reason is required.' } });
    }
    const days = req.body?.days === 7 || req.body?.days === 30 ? req.body.days : null;
    const until = days ? new Date(Date.now() + days * 24 * 3600000).toISOString() : null;
    await db.run(
      `UPDATE users SET suspended = 1, suspended_until = $1, suspension_reason = $2 WHERE id = $3`,
      [until, reason, user.id]
    );
    await createNotification(
      user.id, 'user_notice', 'Your account is suspended',
      days
        ? `Your account is suspended for ${days} days. Reason: ${reason}`
        : `Your account is suspended. Reason: ${reason}`,
      '#/help'
    );
    await logAudit('admin', req.admin.actor, 'user_suspended', 'user', user.id, { reason, days, until });
    return res.json({ ok: true, suspended: true, suspendedUntil: until });
  }
  await db.run(
    `UPDATE users SET suspended = 0, suspended_until = NULL, suspension_reason = '' WHERE id = $1`,
    [user.id]
  );
  await createNotification(user.id, 'user_notice', 'Your account is active again', 'Your account suspension has been lifted.', '#/feed');
  await logAudit('admin', req.admin.actor, 'user_restored', 'user', user.id, {});
  res.json({ ok: true, suspended: false });
}

router.post('/users/:id/suspend', (req, res, next) => setSuspended(req, res, true).catch(next));
router.post('/users/:id/restore', (req, res, next) => setSuspended(req, res, false).catch(next));

// POST /api/admin/users/:id/ban — item 728: permanent ban. Requires the
// typed confirmation 'BAN' (no accidental bans) and a reason. Owner only.
// A banned account is suspended forever and never auto-restores (727).
router.post('/users/:id/ban', requireRole('owner'), async (req, res, next) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
    if (req.body?.confirm !== 'BAN') {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Type BAN to confirm a permanent ban.' } });
    }
    const reason = cleanStr(req.body?.reason || '', 600);
    if (!reason) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'A ban reason is required.' } });
    }
    await db.run(
      `UPDATE users SET suspended = 1, banned = 1, suspended_until = NULL, suspension_reason = $1 WHERE id = $2`,
      [reason, user.id]
    );
    await db.run('DELETE FROM sessions WHERE user_id = $1', [user.id]);
    await createNotification(user.id, 'user_notice', 'Your account has been banned', `Reason: ${reason}`, '#/help');
    await logAudit('admin', req.admin.actor, 'user_banned', 'user', user.id, { reason });
    res.json({ ok: true, banned: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/users/:id/notes {notes} — item 729: internal admin
// notes on a user (never shown to the user).
router.post('/users/:id/notes', async (req, res, next) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
    const notes = cleanStr(req.body?.notes || '', 2000);
    await db.run('UPDATE users SET admin_notes = $1 WHERE id = $2', [notes, user.id]);
    await logAudit('admin', req.admin.actor, 'user_notes_updated', 'user', user.id, {});
    res.json({ ok: true, adminNotes: notes });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/users/:id/trusted {trusted} — item 730: trusted-poster
// flag (trusted posters' bills still go through review; the flag is a
// queue signal, not an auto-approve).
router.post('/users/:id/trusted', async (req, res, next) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
    const trusted = req.body?.trusted === true;
    await db.run('UPDATE users SET trusted_poster = $1 WHERE id = $2', [trusted ? 1 : 0, user.id]);
    await logAudit('admin', req.admin.actor, trusted ? 'user_trusted' : 'user_untrusted', 'user', user.id, {});
    res.json({ ok: true, trustedPoster: trusted });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/users/:id/watchlist {watchlist} — item 731: watchlist
// flag (their packets sort first in the review queue).
router.post('/users/:id/watchlist', async (req, res, next) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
    const watch = req.body?.watchlist === true;
    await db.run('UPDATE users SET watchlist = $1 WHERE id = $2', [watch ? 1 : 0, user.id]);
    await logAudit('admin', req.admin.actor, watch ? 'user_watchlisted' : 'user_unwatchlisted', 'user', user.id, {});
    res.json({ ok: true, watchlist: watch });
  } catch (err) {
    next(err);
  }
});

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
    await logAudit('admin', req.admin.actor, `verification_${decision}`, 'verification', row.id, { type: row.type, docDeleted });
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
    const severity = req.query.severity;
    const assignedTo = req.query.assigned_to;
    const params = [];
    const conds = [];
    if (status) { params.push(status); conds.push(`r.status = $${params.length}`); }
    if (severity) { params.push(severity); conds.push(`r.severity = $${params.length}`); }
    if (assignedTo) { params.push(assignedTo); conds.push(`r.assigned_to = $${params.length}`); }
    const where = conds.length ? conds.join(' AND ') : '1=1';
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

// GET /api/admin/reports/:id — item 734: flag detail view (report,
// reporter, target summary, case notes, audit timeline).
router.get('/reports/:id', async (req, res, next) => {
  try {
    const report = await db.get('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!report) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Report not found.' } });
    const reporter = await db.get('SELECT id, display_name, username FROM users WHERE id = $1', [report.reporter_id]);
    let target = null;
    if (report.target_type === 'bill') {
      target = await db.get('SELECT id, title, category, amount_minor, currency, status, user_id FROM bills WHERE id = $1', [report.target_id]);
    } else if (report.target_type === 'user') {
      target = await db.get('SELECT id, display_name, username, suspended FROM users WHERE id = $1', [report.target_id]);
    } else if (report.target_type === 'message') {
      target = await db.get('SELECT id, thread_id, sender_id, body, hidden FROM messages WHERE id = $1', [report.target_id]);
    } else if (report.target_type === 'brand') {
      target = await db.get('SELECT id, name, status, user_id FROM brands WHERE id = $1', [report.target_id]);
    } else if (report.target_type === 'auction') {
      target = await db.get('SELECT id, title, status, user_id FROM auctions WHERE id = $1', [report.target_id]);
    } else if (report.target_type === 'photo') {
      target = await db.get('SELECT id, display_name, username, photo_url FROM users WHERE id = $1', [report.target_id]);
    }
    const notes = await db.query(
      `SELECT * FROM case_notes WHERE case_type = 'report' AND case_id = $1 ORDER BY created_at ASC`,
      [report.id]
    );
    const timeline = await db.query(
      `SELECT * FROM audit_logs WHERE target_type = $1 AND target_id = $2
       OR (meta_json LIKE $3) ORDER BY created_at ASC LIMIT 50`,
      [report.target_type, report.target_id, `%${report.id}%`]
    );
    res.json({ report, reporter, target, caseNotes: notes.rows, timeline: timeline.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/reports/:id — items 761/766/767: set severity,
// assign to an admin, flag needs_legal. Optionally attach a case note.
router.patch('/reports/:id', async (req, res, next) => {
  try {
    const report = await db.get('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!report) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Report not found.' } });
    const updates = [];
    const params = [];
    if (req.body?.severity !== undefined) {
      if (!['low', 'medium', 'high', 'critical'].includes(req.body.severity)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'Severity must be low, medium, high or critical.' } });
      }
      params.push(req.body.severity); updates.push(`severity = $${params.length}`);
    }
    if (req.body?.assignedTo !== undefined) {
      params.push(cleanStr(req.body.assignedTo, 64)); updates.push(`assigned_to = $${params.length}`);
    }
    if (req.body?.needsLegal !== undefined) {
      params.push(req.body.needsLegal === true ? 1 : 0); updates.push(`needs_legal = $${params.length}`);
    }
    if (updates.length) {
      params.push(report.id);
      await db.run(`UPDATE reports SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
    }
    const note = cleanStr(req.body?.note || '', 2000);
    if (note) {
      await db.run(
        `INSERT INTO case_notes (id, case_type, case_id, admin_id, body, created_at)
         VALUES ($1, 'report', $2, $3, $4, $5)`,
        [crypto.randomUUID(), report.id, req.admin.actor, note, nowIso()]
      );
    }
    await logAudit('admin', req.admin.actor, 'report_updated', 'report', report.id, {
      severity: req.body?.severity, assignedTo: req.body?.assignedTo, needsLegal: req.body?.needsLegal,
    });
    const updated = await db.get('SELECT * FROM reports WHERE id = $1', [report.id]);
    res.json({ report: updated });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/reports/:id {action: dismiss|hide|pause|remove|suspend|restore|request_changes|escalate|hide_message}
// Items 735 (request-changes + escalate + hide_message) and 738 (the
// reporter is notified of the decision).
router.post('/reports/:id', async (req, res, next) => {
  try {
    const report = await db.get('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!report) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Report not found.' } });
    const action = req.body?.action;
    if (!['dismiss', 'hide', 'pause', 'remove', 'suspend', 'restore', 'request_changes', 'escalate', 'hide_message'].includes(action)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Action must be dismiss, hide, pause, remove, suspend, restore, request_changes, escalate or hide_message.' } });
    }
    const now = nowIso();
    const note = cleanStr(req.body?.note || '', 600);
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
        } else if (action === 'request_changes') {
          // Item 735: ask the poster to fix the bill (back to
          // changes_requested, with the admin's note).
          if (!note) {
            return res.status(400).json({ error: { code: 'VALIDATION', message: 'A note is required when requesting changes.' } });
          }
          await db.run(`UPDATE bills SET status = 'changes_requested', changes_note = $1, updated_at = $2 WHERE id = $3`, [note, now, bill.id]);
          await createNotification(bill.user_id, 'changes_requested', 'Changes requested on your post', note, '#/mybills');
        } else if (action === 'escalate') {
          // Item 735/760: mark the report for the legal/escalation path.
          await db.run(`UPDATE reports SET needs_legal = 1, severity = 'critical' WHERE id = $1`, [report.id]);
        }
      }
    } else if (report.target_type === 'user' && action === 'suspend') {
      await db.run('UPDATE users SET suspended = 1 WHERE id = $1', [report.target_id]);
    } else if (report.target_type === 'message' && action === 'hide_message') {
      // Item 690/735: hide the reported message (it stays in the DB for
      // the audit trail; the thread shows a placeholder).
      await db.run(`UPDATE messages SET hidden = 1 WHERE id = $1`, [report.target_id]);
    }
    const newStatus = action === 'escalate' ? 'open' : 'resolved';
    await db.run(`UPDATE reports SET status = $1 WHERE id = $2`, [newStatus, report.id]);
    // Item 738: tell the reporter what happened to their report.
    await createNotification(
      report.reporter_id, 'report_decided', 'Update on your report',
      action === 'dismiss'
        ? 'Thanks for reporting — we reviewed it and found no problem.'
        : `Thanks for reporting — we took action on it (${action.replace(/_/g, ' ')}).`,
      '#/help'
    );
    await logAudit('admin', req.admin.actor, `report_${action}`, 'report', report.id, { targetType: report.target_type, targetId: report.target_id, note });
    res.json({ ok: true, action });
  } catch (err) {
    next(err);
  }
});

// --- Complaints (items 768–770) ---

router.get('/complaints', async (req, res, next) => {
  try {
    const status = req.query.status;
    const params = [];
    let where = '1=1';
    if (status) { params.push(status); where = `c.status = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT c.*, u.display_name AS user_name, u.username AS user_username
       FROM complaints c JOIN users u ON u.id = c.user_id
       WHERE ${where} ORDER BY c.created_at DESC LIMIT 100`,
      params
    );
    res.json({ complaints: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/complaints/:id', async (req, res, next) => {
  try {
    const row = await db.get(
      `SELECT c.*, u.display_name AS user_name, u.username AS user_username
       FROM complaints c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Complaint not found.' } });
    res.json({ complaint: row });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/complaints/:id {action: resolve|reopen, response?}
// Item 769: the resolve call accepts an optional response text (the admin
// console offers templates); item 770: the user is notified of the
// resolution, with the response text in the notification body.
router.post('/complaints/:id', async (req, res, next) => {
  try {
    const complaint = await db.get('SELECT * FROM complaints WHERE id = $1', [req.params.id]);
    if (!complaint) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Complaint not found.' } });
    const action = req.body?.action;
    if (!['resolve', 'reopen'].includes(action)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Action must be resolve or reopen.' } });
    }
    const response = cleanStr(req.body?.response || '', 2000);
    const newStatus = action === 'resolve' ? 'resolved' : 'open';
    await db.run(`UPDATE complaints SET status = $1 WHERE id = $2`, [newStatus, complaint.id]);
    if (action === 'resolve') {
      await createNotification(
        complaint.user_id, 'complaint_resolved', 'Your complaint was resolved',
        response || `Your complaint "${complaint.subject}" has been resolved.`,
        '#/help'
      );
    }
    await logAudit('admin', req.admin.actor, `complaint_${action}`, 'complaint', complaint.id, { response: response || '' });
    res.json({ ok: true, action, status: newStatus });
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

router.put('/fees', requireRole('owner'), async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.feeMode !== undefined) {
      if (!['supporter_fee', 'zero_fee_plus_tip'].includes(body.feeMode)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'feeMode must be supporter_fee or zero_fee_plus_tip.' } });
      }
      await db.setSetting('fee_mode', body.feeMode);
      await logAudit('admin', req.admin.actor, 'fee_mode_changed', 'settings', 'fee_mode', { feeMode: body.feeMode });
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
      await logAudit('admin', req.admin.actor, 'fee_config_changed', 'settings', 'fee_config', {});
    }
    if (body.founderTipConfig !== undefined) {
      await db.setSetting('founder_tip_config', JSON.stringify(body.founderTipConfig));
      await logAudit('admin', req.admin.actor, 'founder_tip_config_changed', 'settings', 'founder_tip_config', {});
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

router.put('/methods', requireRole('owner'), async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.paymentMethods !== undefined) {
      await db.setSetting('payment_methods', JSON.stringify(body.paymentMethods));
      await logAudit('admin', req.admin.actor, 'payment_methods_changed', 'settings', 'payment_methods', {});
    }
    if (body.brandPackages !== undefined) {
      await db.setSetting('brand_packages', JSON.stringify(body.brandPackages));
      await logAudit('admin', req.admin.actor, 'brand_packages_changed', 'settings', 'brand_packages', {});
    }
    if (body.categories !== undefined) {
      if (!Array.isArray(body.categories) || body.categories.some((c) => typeof c !== 'string')) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'categories must be an array of strings.' } });
      }
      await db.setSetting('categories', JSON.stringify(body.categories));
      await logAudit('admin', req.admin.actor, 'categories_changed', 'settings', 'categories', {});
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- Audit log (items 718–722) ---

// Item 718: filters — actor, action, targetType, from, to (ISO dates).
router.get('/audit', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const params = [];
    const conds = [];
    if (req.query.actor) { params.push(cleanStr(req.query.actor, 64)); conds.push(`actor_id = $${params.length}`); }
    if (req.query.action) { params.push(cleanStr(req.query.action, 64)); conds.push(`action = $${params.length}`); }
    if (req.query.targetType) { params.push(cleanStr(req.query.targetType, 32)); conds.push(`target_type = $${params.length}`); }
    if (req.query.from && Number.isFinite(Date.parse(req.query.from))) {
      params.push(new Date(req.query.from).toISOString()); conds.push(`created_at >= $${params.length}`);
    }
    if (req.query.to && Number.isFinite(Date.parse(req.query.to))) {
      params.push(new Date(req.query.to).toISOString()); conds.push(`created_at <= $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    params.push(limit);
    const { rows } = await db.query(
      `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    // Item 722: how many entries are archivable (older than 90 days) —
    // the console shows a banner when this is non-zero.
    const archivable = await db.get(
      `SELECT COUNT(*) AS c FROM audit_logs WHERE created_at < $1`,
      [new Date(Date.now() - 90 * 24 * 3600000).toISOString()]
    );
    res.json({
      logs: rows.map((r) => ({
        id: r.id, actorType: r.actor_type, actorId: r.actor_id, action: r.action,
        targetType: r.target_type, targetId: r.target_id,
        meta: JSON.parse(r.meta_json || '{}'), createdAt: r.created_at,
        entryHash: r.entry_hash || null,
      })),
      archivableCount: Number(archivable?.c || 0),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/audit/export?format=csv — item 719: CSV export of the
// audit log (same filters as /audit).
router.get('/audit/export', async (req, res, next) => {
  try {
    const params = [];
    const conds = [];
    if (req.query.actor) { params.push(cleanStr(req.query.actor, 64)); conds.push(`actor_id = $${params.length}`); }
    if (req.query.action) { params.push(cleanStr(req.query.action, 64)); conds.push(`action = $${params.length}`); }
    if (req.query.targetType) { params.push(cleanStr(req.query.targetType, 32)); conds.push(`target_type = $${params.length}`); }
    if (req.query.from && Number.isFinite(Date.parse(req.query.from))) {
      params.push(new Date(req.query.from).toISOString()); conds.push(`created_at >= $${params.length}`);
    }
    if (req.query.to && Number.isFinite(Date.parse(req.query.to))) {
      params.push(new Date(req.query.to).toISOString()); conds.push(`created_at <= $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows } = await db.query(
      `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT 5000`,
      params
    );
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = ['id,created_at,actor_type,actor_id,action,target_type,target_id,meta'];
    for (const r of rows) {
      lines.push([r.id, r.created_at, r.actor_type, r.actor_id, r.action, r.target_type, r.target_id, r.meta_json].map(esc).join(','));
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="sahay-pay-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(lines.join('\n'));
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/audit/verify — item 721: verify the audit hash chain.
router.get('/audit/verify', async (req, res, next) => {
  try {
    res.json(await verifyAuditChain());
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/audit/archive — item 722: one-click archive of audit
// entries older than 90 days into audit_archive (they stay queryable
// there; nothing is deleted). Owner only.
router.post('/audit/archive', requireRole('owner'), async (req, res, next) => {
  try {
    const cutoff = new Date(Date.now() - 90 * 24 * 3600000).toISOString();
    const { rows } = await db.query(
      'SELECT * FROM audit_logs WHERE created_at < $1 ORDER BY created_at ASC LIMIT 5000',
      [cutoff]
    );
    for (const r of rows) {
      await db.run(
        `INSERT INTO audit_archive (id, actor_type, actor_id, action, target_type, target_id,
           meta_json, prev_hash, entry_hash, created_at, archived_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [r.id, r.actor_type, r.actor_id, r.action, r.target_type, r.target_id,
         r.meta_json, r.prev_hash, r.entry_hash, r.created_at, nowIso()]
      );
    }
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      const ph = ids.map((_, i) => `$${i + 1}`).join(',');
      await db.run(`DELETE FROM audit_logs WHERE id IN (${ph})`, ids);
    }
    await logAudit('admin', req.admin.actor, 'audit_archived', 'audit', 'archive', { archived: rows.length, cutoff });
    res.json({ ok: true, archived: rows.length });
  } catch (err) {
    next(err);
  }
});

// --- Gift status overview ---

router.get('/gifts', async (req, res, next) => {
  try {
    const status = req.query.status;
    const params = [];
    const conds = [];
    if (status) { params.push(status); conds.push(`g.status = $${params.length}`); }
    // Item 752: date-range filter on the payout overview.
    if (req.query.from && Number.isFinite(Date.parse(req.query.from))) {
      params.push(new Date(req.query.from).toISOString()); conds.push(`g.created_at >= $${params.length}`);
    }
    if (req.query.to && Number.isFinite(Date.parse(req.query.to))) {
      params.push(new Date(req.query.to).toISOString()); conds.push(`g.created_at <= $${params.length}`);
    }
    const where = conds.length ? conds.join(' AND ') : '1=1';
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

// Shared gift-confirm credit logic (used by the admin override and the
// dispute resolve-confirm path): confirm + credit the bill, capped.
async function adminConfirmGift(gift, bill, actorId) {
  const now = nowIso();
  const credit = Math.min(gift.amount_minor, Math.max(0, bill.amount_minor - bill.covered_minor));
  await db.run(`UPDATE gifts SET status = 'confirmed', confirmed_at = $1 WHERE id = $2`, [now, gift.id]);
  await db.run(`UPDATE bills SET covered_minor = covered_minor + $1, updated_at = $2 WHERE id = $3`, [credit, now, bill.id]);
  const updatedBill = await db.get('SELECT * FROM bills WHERE id = $1', [bill.id]);
  if (updatedBill.covered_minor >= updatedBill.amount_minor && updatedBill.status === 'approved') {
    await db.run(`UPDATE bills SET status = 'completed', completed_at = $1 WHERE id = $2`, [now, bill.id]);
  }
  await createNotification(
    gift.supporter_id, 'gift_confirmed', 'Your help arrived',
    `Your ${gift.amount_minor / 100} ${gift.currency} help on "${bill.title}" was confirmed.`,
    `#/bill/${bill.id}`
  );
  await logAudit('admin', actorId, 'gift_admin_confirmed', 'gift', gift.id, { billId: bill.id, creditedMinor: credit });
  return credit;
}

// POST /api/admin/gifts/:id/status {status, note} — item 756: gift-status
// override (admin-only). Confirming applies the same bill-credit logic as
// a recipient confirmation; other statuses just move the gift.
router.post('/gifts/:id/status', async (req, res, next) => {
  try {
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [req.params.id]);
    if (!gift) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Gift not found.' } });
    const status = req.body?.status;
    if (!['initiated', 'details_shown', 'donor_reported_sent', 'confirmed', 'failed', 'disputed'].includes(status)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid gift status.' } });
    }
    const note = cleanStr(req.body?.note || '', 600);
    if (status === 'confirmed' && gift.status !== 'confirmed') {
      const bill = await db.get('SELECT * FROM bills WHERE id = $1', [gift.bill_id]);
      if (!bill) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
      const credited = await adminConfirmGift(gift, bill, req.admin.actor);
      return res.json({ ok: true, status: 'confirmed', creditedMinor: credited });
    }
    await db.run(`UPDATE gifts SET status = $1 WHERE id = $2`, [status, gift.id]);
    await logAudit('admin', req.admin.actor, 'gift_status_override', 'gift', gift.id, { from: gift.status, to: status, note });
    res.json({ ok: true, status });
  } catch (err) {
    next(err);
  }
});

// --- Disputes (item 754, admin side) ---
// Disputes are raised by users via POST /api/gifts/:id/dispute (status
// 'disputed'). This queue lists them with their audit timeline. The
// s9-10 user-facing dispute-status page (item 938) was reverted, so the
// user side is the existing gift flow for now — the coordinator reconciles
// the 938 wiring when s9-10 re-lands.

router.get('/disputes', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT g.*, b.title AS bill_title, b.user_id AS recipient_id,
              u.display_name AS supporter_name, u.username AS supporter_username
       FROM gifts g JOIN bills b ON b.id = g.bill_id JOIN users u ON u.id = g.supporter_id
       WHERE g.status = 'disputed' ORDER BY g.created_at DESC LIMIT 100`
    );
    const disputes = [];
    for (const g of rows) {
      const timeline = await db.query(
        `SELECT * FROM audit_logs WHERE target_type = 'gift' AND target_id = $1 ORDER BY created_at ASC LIMIT 50`,
        [g.id]
      );
      disputes.push({ gift: g, timeline: timeline.rows });
    }
    res.json({ disputes });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/gifts/:id/dispute {action, note} — resolve-confirm,
// resolve-fail, refund-guidance, escalate.
router.post('/gifts/:id/dispute', async (req, res, next) => {
  try {
    const gift = await db.get('SELECT * FROM gifts WHERE id = $1', [req.params.id]);
    if (!gift) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Gift not found.' } });
    const action = req.body?.action;
    if (!['resolve-confirm', 'resolve-fail', 'refund-guidance', 'escalate'].includes(action)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Action must be resolve-confirm, resolve-fail, refund-guidance or escalate.' } });
    }
    const note = cleanStr(req.body?.note || '', 600);
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [gift.bill_id]);
    if (action === 'resolve-confirm') {
      const credited = await adminConfirmGift(gift, bill, req.admin.actor);
      await createNotification(
        bill.user_id, 'user_notice', 'A dispute was resolved',
        `The disputed help on "${bill.title}" was confirmed as received.`, `#/bill/${bill.id}`
      );
      return res.json({ ok: true, action, status: 'confirmed', creditedMinor: credited });
    }
    if (action === 'resolve-fail') {
      await db.run(`UPDATE gifts SET status = 'failed' WHERE id = $1`, [gift.id]);
      await createNotification(
        gift.supporter_id, 'user_notice', 'A dispute was resolved',
        `The disputed help on "${bill?.title || 'a bill'}" was marked as not received.`, '#/help'
      );
      await logAudit('admin', req.admin.actor, 'dispute_resolved_failed', 'gift', gift.id, { note });
      return res.json({ ok: true, action, status: 'failed' });
    }
    if (action === 'refund-guidance') {
      // Demo Mode: Sahay Pay never holds money, so there is nothing to
      // refund from — the guidance tells the supporter how to ask the
      // recipient directly (the payment happened in their own app).
      await createNotification(
        gift.supporter_id, 'user_notice', 'How to ask for your money back',
        `Sahay Pay never holds your money — you sent it directly from your own payment app. To get it back, ask the recipient directly${note ? `: ${note}` : ''}. If they refuse, keep your payment receipt and report the bill.`,
        '#/help'
      );
      await logAudit('admin', req.admin.actor, 'dispute_refund_guidance', 'gift', gift.id, { note });
      return res.json({ ok: true, action, status: gift.status });
    }
    // escalate: flag for the legal path.
    await db.run(`UPDATE gifts SET needs_legal = 1, severity = 'critical' WHERE id = $1`, [gift.id]);
    await logAudit('admin', req.admin.actor, 'dispute_escalated', 'gift', gift.id, { note });
    res.json({ ok: true, action, status: gift.status });
  } catch (err) {
    next(err);
  }
});

// --- Analytics (items 741–750) ---
// GET /api/admin/analytics?from&to — all computed from real data. DAU
// comes from sessions.last_seen_at (a session seen that day counts once);
// the funnel's visitor count is the anonymous daily counter from /config.

function analyticsRange(req) {
  const to = req.query.to && Number.isFinite(Date.parse(req.query.to))
    ? new Date(req.query.to).toISOString()
    : new Date().toISOString();
  const from = req.query.from && Number.isFinite(Date.parse(req.query.from))
    ? new Date(req.query.from).toISOString()
    : new Date(Date.parse(to) - 30 * 24 * 3600000).toISOString();
  return { from, to };
}

router.get('/analytics', async (req, res, next) => {
  try {
    const { from, to } = analyticsRange(req);
    const day = (iso) => String(iso || '').slice(0, 10);
    const dauRows = await db.query(
      `SELECT DATE(last_seen_at) AS d, COUNT(DISTINCT user_id) AS c
       FROM sessions WHERE last_seen_at >= $1 AND last_seen_at <= $2 GROUP BY DATE(last_seen_at) ORDER BY d`,
      [from, to]
    );
    const signupRows = await db.query(
      `SELECT DATE(created_at) AS d, COUNT(*) AS c FROM users
       WHERE created_at >= $1 AND created_at <= $2 GROUP BY DATE(created_at) ORDER BY d`,
      [from, to]
    );
    const billRows = await db.query(
      `SELECT DATE(created_at) AS d, COUNT(*) AS c FROM bills
       WHERE created_at >= $1 AND created_at <= $2 GROUP BY DATE(created_at) ORDER BY d`,
      [from, to]
    );
    const billsByStatus = await db.query(
      `SELECT status, COUNT(*) AS c FROM bills WHERE created_at >= $1 AND created_at <= $2 GROUP BY status`,
      [from, to]
    );
    const giftRows = await db.query(
      `SELECT DATE(created_at) AS d, currency, COUNT(*) AS c, COALESCE(SUM(amount_minor), 0) AS total
       FROM gifts WHERE created_at >= $1 AND created_at <= $2 GROUP BY DATE(created_at), currency ORDER BY d`,
      [from, to]
    );
    const confirmedByWeek = await db.query(
      `SELECT currency, COALESCE(SUM(amount_minor), 0) AS total, COUNT(*) AS c
       FROM gifts WHERE status = 'confirmed' AND confirmed_at >= $1 AND confirmed_at <= $2 GROUP BY currency`,
      [from, to]
    );
    // Review throughput + median time-to-decision (from the audit log:
    // review_* entries carry meta.packetId; the packet has created_at).
    const reviewRows = await db.query(
      `SELECT * FROM audit_logs WHERE action LIKE 'review_%'
       AND created_at >= $1 AND created_at <= $2 ORDER BY created_at ASC`,
      [from, to]
    );
    const throughputByDay = {};
    const decisionTimes = [];
    for (const r of reviewRows.rows) {
      throughputByDay[day(r.created_at)] = (throughputByDay[day(r.created_at)] || 0) + 1;
      let meta = {};
      try { meta = JSON.parse(r.meta_json || '{}'); } catch { /* keep {} */ }
      if (meta.packetId) {
        const packet = await db.get('SELECT created_at FROM review_packets WHERE id = $1', [meta.packetId]);
        if (packet) decisionTimes.push(Date.parse(r.created_at) - Date.parse(packet.created_at));
      }
    }
    decisionTimes.sort((a, b) => a - b);
    const medianDecisionMs = decisionTimes.length
      ? decisionTimes[Math.floor(decisionTimes.length / 2)]
      : null;
    const reportVolume = await db.query(
      `SELECT reason, COUNT(*) AS c FROM reports
       WHERE created_at >= $1 AND created_at <= $2 GROUP BY reason ORDER BY c DESC`,
      [from, to]
    );
    const topGivers = await db.query(
      `SELECT g.supporter_id, u.display_name, u.username,
              COALESCE(SUM(g.amount_minor), 0) AS total, COUNT(*) AS gifts
       FROM gifts g JOIN users u ON u.id = g.supporter_id
       WHERE g.status = 'confirmed' AND g.confirmed_at >= $1 AND g.confirmed_at <= $2
       GROUP BY g.supporter_id, u.display_name, u.username ORDER BY total DESC LIMIT 10`,
      [from, to]
    );
    const topPosters = await db.query(
      `SELECT b.user_id, u.display_name, u.username, COUNT(*) AS bills,
              COALESCE(SUM(b.covered_minor), 0) AS received
       FROM bills b JOIN users u ON u.id = b.user_id
       WHERE b.created_at >= $1 AND b.created_at <= $2
       GROUP BY b.user_id, u.display_name, u.username ORDER BY bills DESC LIMIT 10`,
      [from, to]
    );
    const cityBreakdown = await db.query(
      `SELECT city, country, COUNT(*) AS c FROM bills
       WHERE created_at >= $1 AND created_at <= $2 GROUP BY city, country ORDER BY c DESC LIMIT 20`,
      [from, to]
    );
    // Funnel: visitors (anonymous /config counter) -> signups -> bills
    // submitted -> gifts created -> gifts confirmed.
    const visitKeys = [];
    for (let d = new Date(from.slice(0, 10)); d <= new Date(to.slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1)) {
      visitKeys.push(`visits_${d.toISOString().slice(0, 10)}`);
    }
    let visitors = 0;
    for (const k of visitKeys) visitors += Number(await db.getSetting(k)) || 0;
    const signups = await db.get('SELECT COUNT(*) AS c FROM users WHERE created_at >= $1 AND created_at <= $2', [from, to]);
    const billsSubmitted = await db.get('SELECT COUNT(*) AS c FROM bills WHERE created_at >= $1 AND created_at <= $2', [from, to]);
    const giftsCreated = await db.get('SELECT COUNT(*) AS c FROM gifts WHERE created_at >= $1 AND created_at <= $2', [from, to]);
    const giftsConfirmed = await db.get(`SELECT COUNT(*) AS c FROM gifts WHERE status = 'confirmed' AND confirmed_at >= $1 AND confirmed_at <= $2`, [from, to]);
    res.json({
      from, to,
      dau: dauRows.rows.map((r) => ({ date: r.d, users: Number(r.c) })),
      signupsByDay: signupRows.rows.map((r) => ({ date: r.d, count: Number(r.c) })),
      billsByDay: billRows.rows.map((r) => ({ date: r.d, count: Number(r.c) })),
      billsByStatus: Object.fromEntries(billsByStatus.rows.map((r) => [r.status, Number(r.c)])),
      giftsByDay: giftRows.rows.map((r) => ({ date: r.d, currency: r.currency, count: Number(r.c), totalMinor: Number(r.total) })),
      confirmedValueByCurrency: confirmedByWeek.rows.map((r) => ({ currency: r.currency, totalMinor: Number(r.total), gifts: Number(r.c) })),
      reviewThroughputByDay: Object.entries(throughputByDay).map(([date, count]) => ({ date, count })),
      medianDecisionMs,
      decisionsCounted: decisionTimes.length,
      reportVolumeByReason: reportVolume.rows.map((r) => ({ reason: r.reason, count: Number(r.c) })),
      topGivers: topGivers.rows.map((r) => ({ userId: r.supporter_id, displayName: r.display_name, username: r.username, totalMinor: Number(r.total), gifts: Number(r.gifts) })),
      topPosters: topPosters.rows.map((r) => ({ userId: r.user_id, displayName: r.display_name, username: r.username, bills: Number(r.bills), receivedMinor: Number(r.received) })),
      cityBreakdown: cityBreakdown.rows.map((r) => ({ city: r.city, country: r.country, count: Number(r.c) })),
      funnel: {
        visitors,
        signups: Number(signups?.c || 0),
        billsSubmitted: Number(billsSubmitted?.c || 0),
        giftsCreated: Number(giftsCreated?.c || 0),
        giftsConfirmed: Number(giftsConfirmed?.c || 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/analytics/export?format=csv — items 741–750 as a CSV.
router.get('/analytics/export', async (req, res, next) => {
  try {
    const { from, to } = analyticsRange(req);
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = ['section,date,currency,count,total_minor'];
    const push = (section, date, currency, count, total) =>
      lines.push([section, date, currency, count, total].map(esc).join(','));
    const signups = await db.query(
      `SELECT DATE(created_at) AS d, COUNT(*) AS c FROM users WHERE created_at >= $1 AND created_at <= $2 GROUP BY DATE(created_at) ORDER BY d`,
      [from, to]
    );
    for (const r of signups.rows) push('signups', r.d, '', r.c, '');
    const bills = await db.query(
      `SELECT DATE(created_at) AS d, COUNT(*) AS c FROM bills WHERE created_at >= $1 AND created_at <= $2 GROUP BY DATE(created_at) ORDER BY d`,
      [from, to]
    );
    for (const r of bills.rows) push('bills', r.d, '', r.c, '');
    const gifts = await db.query(
      `SELECT DATE(created_at) AS d, currency, COUNT(*) AS c, COALESCE(SUM(amount_minor), 0) AS total FROM gifts WHERE created_at >= $1 AND created_at <= $2 GROUP BY DATE(created_at), currency ORDER BY d`,
      [from, to]
    );
    for (const r of gifts.rows) push('gifts', r.d, r.currency, r.c, r.total);
    const reports = await db.query(
      `SELECT reason, COUNT(*) AS c FROM reports WHERE created_at >= $1 AND created_at <= $2 GROUP BY reason`,
      [from, to]
    );
    for (const r of reports.rows) push('reports', r.reason, '', r.c, '');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="sahay-pay-analytics-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(lines.join('\n'));
  } catch (err) {
    next(err);
  }
});

// --- Payout oversight (items 757–758) ---

router.get('/payouts', async (req, res, next) => {
  try {
    // Monthly payout summary: confirmed gifts per month + currency.
    const monthly = await db.query(
      `SELECT SUBSTR(confirmed_at, 1, 7) AS month, currency,
              COUNT(*) AS gifts, COALESCE(SUM(amount_minor), 0) AS total,
              COALESCE(SUM(fee_minor), 0) AS fees, COALESCE(SUM(tip_minor), 0) AS tips
       FROM gifts WHERE status = 'confirmed' AND confirmed_at IS NOT NULL
       GROUP BY SUBSTR(confirmed_at, 1, 7), currency ORDER BY month DESC LIMIT 24`
    );
    const feeConfig = await db.getSettingJson('fee_config', {});
    const feeMode = (await db.getSetting('fee_mode')) || 'supporter_fee';
    const thisMonth = new Date().toISOString().slice(0, 7);
    const monthlyFee = await db.get(
      `SELECT COALESCE(SUM(fee_minor), 0) AS total FROM gifts
       WHERE status = 'confirmed' AND SUBSTR(confirmed_at, 1, 7) = $1`,
      [thisMonth]
    );
    res.json({
      feeMode,
      feeTable: feeConfig,
      monthlyFeeTotalMinor: Number(monthlyFee?.total || 0),
      monthlyFeeMonth: thisMonth,
      monthlySummary: monthly.rows.map((r) => ({
        month: r.month, currency: r.currency, gifts: Number(r.gifts),
        totalMinor: Number(r.total), feesMinor: Number(r.fees), tipsMinor: Number(r.tips),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// --- Appeals (items 739–740, admin side) ---
// Users file appeals via POST /api/appeals (see server/routes/appeals.js).

router.get('/appeals', async (req, res, next) => {
  try {
    const status = req.query.status;
    const params = [];
    let where = '1=1';
    if (status) { params.push(status); where = `a.status = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT a.*, u.display_name AS user_name, u.username AS user_username
       FROM appeals a JOIN users u ON u.id = a.user_id
       WHERE ${where} ORDER BY a.created_at DESC LIMIT 100`,
      params
    );
    res.json({ appeals: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/appeals/:id', async (req, res, next) => {
  try {
    const appeal = await db.get('SELECT * FROM appeals WHERE id = $1', [req.params.id]);
    if (!appeal) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Appeal not found.' } });
    if (appeal.status !== 'open') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `This appeal was already decided (${appeal.status}).` } });
    }
    const decision = req.body?.decision;
    if (!['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Decision must be approve or reject.' } });
    }
    const note = cleanStr(req.body?.note || '', 600);
    const newStatus = decision === 'approve' ? 'approved' : 'rejected';
    await db.run(
      `UPDATE appeals SET status = $1, decision_note = $2, decided_by = $3, decided_at = $4 WHERE id = $5`,
      [newStatus, note, req.admin.actor, nowIso(), appeal.id]
    );
    if (decision === 'approve') {
      // Item 740: approving an appeal RESTORES the content. A removed or
      // paused bill goes back to approved; a rejected bill goes back to
      // pending_review with a fresh review packet; a suspended user is
      // restored (unless banned).
      if (appeal.target_type === 'bill') {
        const bill = await db.get('SELECT * FROM bills WHERE id = $1', [appeal.target_id]);
        if (bill && (bill.status === 'removed' || bill.status === 'under_investigation')) {
          await db.run(`UPDATE bills SET status = 'approved', updated_at = $1 WHERE id = $2`, [nowIso(), bill.id]);
        } else if (bill && bill.status === 'rejected') {
          await db.run(`UPDATE bills SET status = 'pending_review', rejection_reason = '', updated_at = $1 WHERE id = $2`, [nowIso(), bill.id]);
          await createReviewPacket('bill', bill.id, await billPacketPayload(bill, []));
        }
      } else if (appeal.target_type === 'user') {
        await db.run(
          `UPDATE users SET suspended = 0, suspended_until = NULL, suspension_reason = '' WHERE id = $1 AND banned = 0`,
          [appeal.target_id]
        );
      }
    }
    await createNotification(
      appeal.user_id, 'appeal_decided',
      decision === 'approve' ? 'Your appeal was approved' : 'Your appeal was not approved',
      note || (decision === 'approve' ? 'Your appeal was approved and the content was restored.' : 'Your appeal was reviewed and not approved.'),
      '#/help'
    );
    await logAudit('admin', req.admin.actor, `appeal_${decision}`, 'appeal', appeal.id, {
      targetType: appeal.target_type, targetId: appeal.target_id, note,
    });
    res.json({ ok: true, status: newStatus });
  } catch (err) {
    next(err);
  }
});

// --- Admin accounts (items 771–773) ---

router.get('/admins', requireRole('owner'), async (req, res, next) => {
  try {
    res.json({ admins: await listAdminUsers() });
  } catch (err) {
    next(err);
  }
});

router.post('/admins', requireRole('owner'), async (req, res, next) => {
  try {
    const result = await createAdminUser(req.body?.displayName, req.body?.role, req.body?.pin);
    if (!result.ok) return res.status(400).json({ error: { code: 'ADMIN_CREATE_FAILED', message: result.error } });
    res.status(201).json({ ok: true, adminUser: result.adminUser });
  } catch (err) {
    next(err);
  }
});

router.delete('/admins/:id', requireRole('owner'), async (req, res, next) => {
  try {
    const result = await deleteAdminUser(req.params.id);
    if (!result.ok) return res.status(404).json({ error: { code: 'NOT_FOUND', message: result.error } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/invites {role} — one-time setup code, shown ONCE in
// the response. The owner passes it to the new admin himself (no email).
router.post('/invites', requireRole('owner'), async (req, res, next) => {
  try {
    const result = await createAdminInvite(req.body?.role, req.admin.actor);
    if (!result.ok) return res.status(400).json({ error: { code: 'INVITE_FAILED', message: result.error } });
    res.status(201).json({ ok: true, invite: result.invite });
  } catch (err) {
    next(err);
  }
});

// --- Admin activity (item 774) ---

router.get('/activity', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const { rows } = await db.query(
      `SELECT * FROM audit_logs WHERE actor_type IN ('admin', 'muse-bridge')
       ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    const byActor = await db.query(
      `SELECT actor_id, COUNT(*) AS c FROM audit_logs
       WHERE actor_type IN ('admin', 'muse-bridge') GROUP BY actor_id ORDER BY c DESC`
    );
    const admins = await listAdminUsers();
    const names = { owner: 'Owner', 'muse-bridge': 'Muse bridge' };
    for (const a of admins) names[a.id] = a.displayName;
    res.json({
      activity: rows.map((r) => ({
        id: r.id, actorId: r.actor_id, actorName: names[r.actor_id] || r.actor_id,
        action: r.action, targetType: r.target_type, targetId: r.target_id,
        meta: JSON.parse(r.meta_json || '{}'), createdAt: r.created_at,
      })),
      byActor: byActor.rows.map((r) => ({ actorId: r.actor_id, actorName: names[r.actor_id] || r.actor_id, count: Number(r.c) })),
    });
  } catch (err) {
    next(err);
  }
});

// --- Security (items 775, 788, 789) ---

const SECURITY_EVENT_ACTIONS = [
  'admin_login', 'admin_login_failed', 'admin_account_locked',
  'admin_pin_set', 'admin_pin_changed', 'admin_user_created',
  'admin_user_deleted', 'admin_invite_created', 'user_banned',
];

router.get('/security', async (req, res, next) => {
  try {
    // Item 775: last sign-in per admin account (from admin_sessions).
    const sessions = await db.query(
      `SELECT admin_user_id, MAX(created_at) AS last_login, user_agent
       FROM admin_sessions GROUP BY admin_user_id`
    );
    const admins = await listAdminUsers();
    const names = { owner: 'Owner' };
    for (const a of admins) names[a.id] = a.displayName;
    const lastSignIns = sessions.rows.map((r) => ({
      adminUserId: r.admin_user_id || 'owner',
      displayName: names[r.admin_user_id || 'owner'] || (r.admin_user_id || 'owner'),
      lastLoginAt: r.last_login,
      userAgent: r.user_agent || null,
    }));
    // Item 789: security-events log (login failures, lockouts, PIN
    // changes, admin-account changes, bans).
    const ph = SECURITY_EVENT_ACTIONS.map((_, i) => `$${i + 1}`).join(',');
    const events = await db.query(
      `SELECT * FROM audit_logs WHERE action IN (${ph}) ORDER BY created_at DESC LIMIT 200`,
      SECURITY_EVENT_ACTIONS
    );
    res.json({
      lastSignIns,
      securitySettings: await getSecuritySettings(),
      events: events.rows.map((r) => ({
        id: r.id, actorId: r.actor_id, action: r.action,
        targetType: r.target_type, targetId: r.target_id,
        meta: JSON.parse(r.meta_json || '{}'), createdAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/security-settings', requireRole('owner'), async (req, res, next) => {
  try {
    res.json({ settings: await getSecuritySettings() });
  } catch (err) {
    next(err);
  }
});

router.put('/security-settings', requireRole('owner'), async (req, res, next) => {
  try {
    const current = await getSecuritySettings();
    const body = req.body || {};
    const nextSettings = { ...current };
    if (body.pinMinLength !== undefined) {
      if (!Number.isInteger(body.pinMinLength) || body.pinMinLength < 4 || body.pinMinLength > 32) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'pinMinLength must be 4–32.' } });
      }
      nextSettings.pinMinLength = body.pinMinLength;
    }
    if (body.adminIdleMinutes !== undefined) {
      if (!Number.isInteger(body.adminIdleMinutes) || body.adminIdleMinutes < 5 || body.adminIdleMinutes > 480) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'adminIdleMinutes must be 5–480.' } });
      }
      nextSettings.adminIdleMinutes = body.adminIdleMinutes;
    }
    if (body.lockoutAttempts !== undefined) {
      if (!Number.isInteger(body.lockoutAttempts) || body.lockoutAttempts < 3 || body.lockoutAttempts > 20) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'lockoutAttempts must be 3–20.' } });
      }
      nextSettings.lockoutAttempts = body.lockoutAttempts;
    }
    if (body.lockoutMinutes !== undefined) {
      if (!Number.isInteger(body.lockoutMinutes) || body.lockoutMinutes < 5 || body.lockoutMinutes > 1440) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'lockoutMinutes must be 5–1440.' } });
      }
      nextSettings.lockoutMinutes = body.lockoutMinutes;
    }
    await db.setSetting('security_settings', JSON.stringify(nextSettings));
    await logAudit('admin', req.admin.actor, 'security_settings_changed', 'settings', 'security_settings', nextSettings);
    res.json({ ok: true, settings: nextSettings });
  } catch (err) {
    next(err);
  }
});

// --- Admin availability (item 792) ---

router.get('/availability', async (req, res, next) => {
  try {
    res.json({ available: (await db.getSetting('admin_available')) === 'true' });
  } catch (err) {
    next(err);
  }
});

router.put('/availability', requireRole('owner'), async (req, res, next) => {
  try {
    if (typeof req.body?.available !== 'boolean') {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'available must be true or false.' } });
    }
    await db.setSetting('admin_available', req.body.available ? 'true' : 'false');
    await logAudit('admin', req.admin.actor, 'admin_availability_changed', 'settings', 'admin_available', { available: req.body.available });
    res.json({ ok: true, available: req.body.available });
  } catch (err) {
    next(err);
  }
});

// --- Bridge history + health (items 794–795) ---

router.get('/bridge-history', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const { rows } = await db.query(
      `SELECT * FROM audit_logs WHERE actor_type = 'muse-bridge' ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    res.json({
      history: rows.map((r) => ({
        id: r.id, action: r.action, targetType: r.target_type, targetId: r.target_id,
        meta: JSON.parse(r.meta_json || '{}'), createdAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/bridge-health', async (req, res, next) => {
  try {
    const lastPing = await db.getSetting('bridge_last_ping');
    const configured = Boolean(process.env.CLAUDE_APPROVAL_BRIDGE_SECRET);
    const lastPingMs = lastPing ? Date.parse(lastPing) : null;
    const stale = !lastPingMs || Date.now() - lastPingMs > 24 * 3600000;
    res.json({
      configured,
      lastPing: lastPing || null,
      // "ok" when the bridge is configured and has pinged (or decided)
      // in the last 24h; "stale" otherwise. A bridge that has never
      // pinged is "unknown", not "down" — it may simply be unused.
      status: !configured ? 'disabled' : !lastPingMs ? 'unknown' : stale ? 'stale' : 'ok',
    });
  } catch (err) {
    next(err);
  }
});

// --- Webhook test + delivery log (items 796–797) ---

router.post('/webhook/test', requireRole('owner'), async (req, res, next) => {
  try {
    if (!process.env.OWNER_NOTIFICATION_WEBHOOK_URL) {
      return res.status(400).json({ error: { code: 'WEBHOOK_NOT_CONFIGURED', message: 'No owner webhook URL is configured (OWNER_NOTIFICATION_WEBHOOK_URL).' } });
    }
    sendOwnerWebhook({
      id: `test-${crypto.randomUUID()}`,
      type: 'webhook_test',
      targetType: 'test',
      targetId: 'test',
      payload: { message: 'Sahay Pay webhook test — if you see this, the webhook works.' },
      status: 'pending',
      createdAt: nowIso(),
    });
    await logAudit('admin', req.admin.actor, 'webhook_test_sent', 'webhook', 'test', {});
    res.json({ ok: true, message: 'Test packet sent. Check the delivery log in a few seconds.' });
  } catch (err) {
    next(err);
  }
});

router.get('/webhook-log', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const { rows } = await db.query(
      'SELECT * FROM webhook_deliveries ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    res.json({ deliveries: rows });
  } catch (err) {
    next(err);
  }
});

// --- Announcements (item 697, admin side) ---

router.get('/announcements', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 100');
    res.json({ announcements: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/announcements', requireRole('owner'), async (req, res, next) => {
  try {
    const title = cleanStr(req.body?.title, 200);
    const body = cleanStr(req.body?.body, 4000);
    if (title.length < 3) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Title must be 3+ characters.' } });
    if (body.length < 10) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Body must be 10+ characters.' } });
    const publishAt = req.body?.publishAt && Number.isFinite(Date.parse(req.body.publishAt))
      ? new Date(req.body.publishAt).toISOString()
      : nowIso();
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO announcements (id, title, body, publish_at, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, title, body, publishAt, req.admin.actor, nowIso()]
    );
    await logAudit('admin', req.admin.actor, 'announcement_created', 'announcement', id, { publishAt });
    res.status(201).json({ ok: true, id, publishAt });
  } catch (err) {
    next(err);
  }
});

router.delete('/announcements/:id', requireRole('owner'), async (req, res, next) => {
  try {
    const row = await db.get('SELECT * FROM announcements WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Announcement not found.' } });
    await db.run('DELETE FROM announcements WHERE id = $1', [row.id]);
    await logAudit('admin', req.admin.actor, 'announcement_deleted', 'announcement', row.id, {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- Broadcasts (items 779–782) ---

function broadcastAudienceWhere(audience) {
  // Returns {where, params} for the users table. Audiences: all, city,
  // givers (has a confirmed gift), posters (has an approved bill).
  if (audience?.type === 'city' && audience.city) {
    return { where: 'city = $1', params: [cleanStr(audience.city, 120)] };
  }
  if (audience?.type === 'givers') {
    return { where: `id IN (SELECT supporter_id FROM gifts WHERE status = 'confirmed')`, params: [] };
  }
  if (audience?.type === 'posters') {
    return { where: `id IN (SELECT user_id FROM bills WHERE status IN ('approved', 'completed'))`, params: [] };
  }
  return { where: '1=1', params: [] };
}

router.get('/broadcasts', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 100');
    res.json({
      broadcasts: rows.map((r) => ({
        id: r.id, title: r.title, body: r.body,
        audience: JSON.parse(r.audience_json || '{}'),
        recipientCount: r.recipient_count, createdBy: r.created_by, createdAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/broadcasts/preview?audienceType=all|city|givers|posters&city=X
// — item 781: recipient count before sending.
router.get('/broadcasts/preview', async (req, res, next) => {
  try {
    const audience = { type: req.query.audienceType || 'all', city: req.query.city || '' };
    const { where, params } = broadcastAudienceWhere(audience);
    const row = await db.get(`SELECT COUNT(*) AS c FROM users WHERE ${where}`, params);
    res.json({ audience, recipientCount: Number(row?.c || 0) });
  } catch (err) {
    next(err);
  }
});

router.post('/broadcasts', requireRole('owner'), async (req, res, next) => {
  try {
    const title = cleanStr(req.body?.title, 200);
    const body = cleanStr(req.body?.body, 2000);
    if (title.length < 3) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Title must be 3+ characters.' } });
    if (body.length < 10) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Body must be 10+ characters.' } });
    const audience = req.body?.audience || { type: 'all' };
    if (!['all', 'city', 'givers', 'posters'].includes(audience.type)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Audience type must be all, city, givers or posters.' } });
    }
    const { where, params } = broadcastAudienceWhere(audience);
    const { rows } = await db.query(`SELECT id FROM users WHERE ${where} ORDER BY created_at ASC LIMIT 5000`, params);
    const id = crypto.randomUUID();
    let sent = 0;
    for (const u of rows) {
      // createNotification enforces each user's per-event opt-out, so
      // the delivered count may be lower than the audience size.
      const nid = await createNotification(u.id, 'broadcast', title, body, '#/updates', { broadcastId: id });
      if (nid) sent++;
    }
    await db.run(
      `INSERT INTO broadcasts (id, title, body, audience_json, recipient_count, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, title, body, JSON.stringify(audience), sent, req.admin.actor, nowIso()]
    );
    await logAudit('admin', req.admin.actor, 'broadcast_sent', 'broadcast', id, { audience, audienceSize: rows.length, sent });
    res.status(201).json({ ok: true, id, audienceSize: rows.length, sent });
  } catch (err) {
    next(err);
  }
});

// --- Case notes + escalations (items 760, 767) ---

router.post('/case-notes', async (req, res, next) => {
  try {
    const caseType = cleanStr(req.body?.caseType, 32);
    const caseId = cleanStr(req.body?.caseId, 64);
    const body = cleanStr(req.body?.body, 2000);
    if (!['report', 'gift', 'complaint', 'appeal', 'user', 'bill'].includes(caseType)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid case type.' } });
    }
    if (!caseId || body.length < 1) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'A case id and a note are required.' } });
    }
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO case_notes (id, case_type, case_id, admin_id, body, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, caseType, caseId, req.admin.actor, body, nowIso()]
    );
    res.status(201).json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

router.get('/case-notes', async (req, res, next) => {
  try {
    const caseType = cleanStr(req.query.caseType || '', 32);
    const caseId = cleanStr(req.query.caseId || '', 64);
    if (!caseType || !caseId) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'caseType and caseId are required.' } });
    }
    const { rows } = await db.query(
      `SELECT * FROM case_notes WHERE case_type = $1 AND case_id = $2 ORDER BY created_at ASC LIMIT 100`,
      [caseType, caseId]
    );
    res.json({ notes: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/escalations — item 760: everything flagged for the
// escalation/legal path (reports + gifts with needs_legal, escalated
// disputes), with their case notes.
router.get('/escalations', async (req, res, next) => {
  try {
    const reports = await db.query(
      `SELECT r.*, u.display_name AS reporter_name FROM reports r JOIN users u ON u.id = r.reporter_id
       WHERE r.needs_legal = 1 ORDER BY r.created_at DESC LIMIT 100`
    );
    const gifts = await db.query(
      `SELECT g.*, b.title AS bill_title FROM gifts g JOIN bills b ON b.id = g.bill_id
       WHERE g.needs_legal = 1 ORDER BY g.created_at DESC LIMIT 100`
    );
    res.json({ reports: reports.rows, gifts: gifts.rows });
  } catch (err) {
    next(err);
  }
});

// --- Weekly moderation report (item 799) ---

router.get('/weekly-report', async (req, res, next) => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 3600000).toISOString();
    const q = async (sql, params = []) => Number((await db.get(sql, params))?.c || 0);
    const decided = await q(
      `SELECT COUNT(*) AS c FROM audit_logs WHERE action LIKE 'review_%' AND created_at >= $1`, [since]
    );
    const approved = await q(
      `SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'review_approve' AND created_at >= $1`, [since]
    );
    const rejected = await q(
      `SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'review_reject' AND created_at >= $1`, [since]
    );
    const changes = await q(
      `SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'review_changes' AND created_at >= $1`, [since]
    );
    const reportsFiled = await q(`SELECT COUNT(*) AS c FROM reports WHERE created_at >= $1`, [since]);
    const reportsResolved = await q(
      `SELECT COUNT(*) AS c FROM audit_logs WHERE action LIKE 'report_%' AND created_at >= $1`, [since]
    );
    const complaintsFiled = await q(`SELECT COUNT(*) AS c FROM complaints WHERE created_at >= $1`, [since]);
    const complaintsResolved = await q(
      `SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'complaint_resolve' AND created_at >= $1`, [since]
    );
    const appealsFiled = await q(`SELECT COUNT(*) AS c FROM appeals WHERE created_at >= $1`, [since]);
    const appealsDecided = await q(
      `SELECT COUNT(*) AS c FROM audit_logs WHERE action LIKE 'appeal_%' AND created_at >= $1`, [since]
    );
    const newUsers = await q(`SELECT COUNT(*) AS c FROM users WHERE created_at >= $1`, [since]);
    const newBills = await q(`SELECT COUNT(*) AS c FROM bills WHERE created_at >= $1`, [since]);
    const giftsConfirmed = await q(
      `SELECT COUNT(*) AS c FROM gifts WHERE status = 'confirmed' AND confirmed_at >= $1`, [since]
    );
    const pendingNow = await q(`SELECT COUNT(*) AS c FROM review_packets WHERE status = 'pending'`);
    const openReportsNow = await q(`SELECT COUNT(*) AS c FROM reports WHERE status = 'open'`);
    res.json({
      since,
      generatedAt: nowIso(),
      reviews: { decided, approved, rejected, changes },
      reports: { filed: reportsFiled, resolved: reportsResolved },
      complaints: { filed: complaintsFiled, resolved: complaintsResolved },
      appeals: { filed: appealsFiled, decided: appealsDecided },
      growth: { newUsers, newBills, giftsConfirmed },
      stillOpen: { pendingReviewPackets: pendingNow, openReports: openReportsNow },
    });
  } catch (err) {
    next(err);
  }
});

// --- Leaderboard audit (item 787) ---

router.get('/leaderboard-audit', async (req, res, next) => {
  try {
    // Recompute the top givers straight from confirmed gifts, and flag
    // any whose account is suspended or banned (their totals still count
    // — the audit just surfaces it).
    const { rows } = await db.query(
      `SELECT g.supporter_id, u.display_name, u.username, u.suspended, u.banned,
              COALESCE(SUM(g.amount_minor), 0) AS total, COUNT(*) AS gifts
       FROM gifts g JOIN users u ON u.id = g.supporter_id
       WHERE g.status = 'confirmed'
       GROUP BY g.supporter_id, u.display_name, u.username, u.suspended, u.banned
       ORDER BY total DESC LIMIT 20`
    );
    res.json({
      topGivers: rows.map((r) => ({
        userId: r.supporter_id, displayName: r.display_name, username: r.username,
        totalMinor: Number(r.total), gifts: Number(r.gifts),
        suspended: r.suspended === 1, banned: r.banned === 1,
      })),
      computedAt: nowIso(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
