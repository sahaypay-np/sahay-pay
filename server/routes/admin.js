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
  createAdminSession, destroyAdminSession, requireAdmin, lookupAdminSession,
  requireElevated, elevateAdminSession, rotateAdminSession, requireRole,
  blockViewerWrites,
  sessionCookieOptions, ADMIN_SESSION_HOURS, rateLimit,
  getOrCreateCsrfToken, verifyAdminUserPin, createAdminInvite,
  redeemAdminInvite, listAdminUsers, getAdminUser, createAdminUser,
  deleteAdminUser, getSecuritySettings,
} = require('../lib/auth');
const { cleanStr } = require('../lib/validate');
const { applyReviewDecision, createNotification, sendOwnerWebhook, createReviewPacket, billPacketPayload } = require('../lib/notify');
const { deletePrivateFile } = require('../lib/storage');
const { getMaintenanceState, setMaintenanceMode, getFreezeState, setEmergencyFreeze } = require('../lib/maintenance');
const { accountsOverRevealThreshold, recentRevealAnomalies } = require('../lib/security');
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
  'basket_items', 'pledges', 'gift_messages', 'billers', 'bill_edits',
  // Phase 2 sections 4–6.
  'follows', 'user_blocks', 'achievements', 'thanks', 'thank_reactions',
  'receiver_stories', 'brand_profiles', 'brand_responses', 'message_threads',
  'messages', 'partnerships', 'drops', 'drop_entries', 'csr_updates',
  'appeals', 'signin_history', 'fraud_flags', 'auction_watchlist',
  'scam_notices', 'anon_stats',
  // Phase 2 §7–8 tables (admin_users/admin_invites are exported below
  // with explicit column lists — their PIN/code hashes never leave).
  'gift_threads', 'gift_thread_messages', 'thank_you_notes', 'announcements',
  'case_notes', 'webhook_deliveries', 'broadcasts', 'audit_archive',
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
              referral_code, referred_by, suspended_until, suspended_reason,
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
      overdueReviewPackets: Number(overduePackets.c || 0),
      stuckGifts: Number(stuckGifts.c || 0),
      overdueReports: Number(overdueReports.c || 0),
      openAppeals: Number(openAppeals.c || 0),
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
router.post('/review/bulk', requireElevated, async (req, res, next) => {
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
// Item 808: bill approval decisions need a fresh PIN re-auth (elevation).
router.post('/review/:packetId', requireElevated, async (req, res, next) => {
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
router.post('/review/:packetId/hold', requireElevated, async (req, res, next) => {
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

router.post('/review/:packetId/unhold', requireElevated, async (req, res, next) => {
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
        suspendedUntil: r.suspended_until || null, suspensionReason: r.suspended_reason || '',
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
      `SELECT t.*, b.title AS bill_title FROM gift_threads t JOIN bills b ON b.id = t.bill_id
       WHERE t.supporter_id = $1 OR t.poster_id = $1 ORDER BY t.updated_at DESC LIMIT 20`,
      [user.id]
    );
    const threadIds = threads.rows.map((t) => t.id);
    let messages = [];
    if (threadIds.length) {
      const ph = threadIds.map((_, i) => `$${i + 1}`).join(',');
      const msgs = await db.query(
        `SELECT id, thread_id, sender_id, body, is_read, hidden, created_at
         FROM gift_thread_messages WHERE thread_id IN (${ph}) ORDER BY created_at DESC LIMIT 100`,
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
        suspendedUntil: user.suspended_until || null, suspensionReason: user.suspended_reason || '',
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
  // Suspension reason + duration (item 384; item 726: a reason is required).
  const reason = cleanStr(req.body?.reason || '', 600);
  // Both admin UIs send a duration: the §4–6 form sends durationDays
  // (1–3650), the §7–8 form sends days (7/30). Accept either.
  const rawDays = req.body?.durationDays ?? req.body?.days;
  const durationDays = rawDays === undefined || rawDays === null || rawDays === ''
    ? null
    : Math.max(1, Math.min(3650, Math.floor(Number(rawDays) || 0) || 0)) || null;
  const until = suspended && durationDays
    ? new Date(Date.now() + durationDays * 86400000).toISOString()
    : null;
  if (suspended) {
    if (!reason) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'A suspension reason is required.' } });
    }
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
  await logAudit('admin', req.admin.actor, suspended ? 'user_suspended' : 'user_restored', 'user', user.id, { reason, durationDays });
  res.json({ ok: true, suspended, reason, suspendedUntil: until });
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
      `UPDATE users SET suspended = 1, banned = 1, suspended_until = NULL, suspended_reason = $1 WHERE id = $2`,
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
      target = await db.get('SELECT id, thread_id, sender_id, body, hidden FROM gift_thread_messages WHERE id = $1', [report.target_id]);
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

// POST /api/admin/reports/:id {action: dismiss|hide|pause|remove|suspend|restore|warn|request_changes|escalate|hide_message}
// Items 735 (request-changes + escalate + hide_message) and 738 (the
// reporter is notified of the decision). The reason is stored on the
// report + in the audit meta (item 350).
router.post('/reports/:id', async (req, res, next) => {
  try {
    const report = await db.get('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!report) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Report not found.' } });
    const action = req.body?.action;
    if (!['dismiss', 'hide', 'pause', 'remove', 'suspend', 'restore', 'warn', 'request_changes', 'escalate', 'hide_message'].includes(action)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Action must be dismiss, hide, pause, remove, suspend, restore, warn, request_changes, escalate or hide_message.' } });
    }
    const reason = cleanStr(req.body?.reason || '', 600);
    const now = nowIso();
    const note = cleanStr(req.body?.note || '', 600);
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
      await logAudit('admin', req.admin.actor, 'report_warn', 'report', report.id, { posterId });
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
          // Reporter is notified of the outcome too (item 352).
          await createNotification(
            report.reporter_id, 'report_outcome', 'Report outcome: bill restored',
            'The bill you reported was reviewed and restored to the feed. Thank you for keeping Sahay Pay safe.',
            `#/bill/${bill.id}`
          );
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
      await db.run('DELETE FROM gift_thread_messages WHERE id = $1', [report.target_id]);
    } else if (report.target_type === 'message' && action === 'hide_message') {
      // Item 690/735: hide the reported message (it stays in the DB for
      // the audit trail; the thread shows a placeholder).
      await db.run(`UPDATE gift_thread_messages SET hidden = 1 WHERE id = $1`, [report.target_id]);
    }
    const newStatus = action === 'escalate' ? 'open' : 'resolved';
    await db.run(
      `UPDATE reports SET status = $1, decision = $2, decision_reason = $3, decided_at = $4 WHERE id = $5`,
      [newStatus, action, reason, now, report.id]
    );
    // Item 738: tell the reporter what happened to their report.
    await createNotification(
      report.reporter_id, 'report_decided', 'Update on your report',
      action === 'dismiss'
        ? 'Thanks for reporting — we reviewed it and found no problem.'
        : `Thanks for reporting — we took action on it (${action.replace(/_/g, ' ')}).`,
      '#/help'
    );
    await logAudit('admin', req.admin.actor, `report_${action}`, 'report', report.id, { targetType: report.target_type, targetId: report.target_id, reason, note });
    res.json({ ok: true, action });
  } catch (err) {
    next(err);
  }
});

// --- Auction moderation (item 785) ---
// Auctions reach the public list only via review packets (status
// 'approved'); there were no admin auction endpoints at all. Pause and
// remove both hide the auction from the public list and block new bids
// (the public routes require status 'approved'), and the seller is
// notified in-app. Restore returns a paused/removed auction to
// 'approved' (the public list still hides it once ends_at passes).

router.get('/auctions', async (req, res, next) => {
  try {
    const status = req.query.status;
    const params = [];
    let where = '';
    if (status && ['pending_review', 'approved', 'paused', 'removed'].includes(status)) {
      params.push(status);
      where = `WHERE a.status = $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT a.*, u.display_name AS seller_name, u.username AS seller_username,
              (SELECT COUNT(*) FROM auction_bids b WHERE b.auction_id = a.id) AS bid_count,
              (SELECT MAX(amount_minor) FROM auction_bids b WHERE b.auction_id = a.id) AS highest_bid_minor
       FROM auctions a JOIN users u ON u.id = a.user_id ${where}
       ORDER BY a.created_at DESC LIMIT 100`,
      params
    );
    res.json({
      auctions: rows.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        category: r.category,
        currency: r.currency,
        startBidMinor: r.start_bid_minor,
        highestBidMinor: r.highest_bid_minor,
        bidCount: Number(r.bid_count),
        status: r.status,
        endsAt: r.ends_at,
        createdAt: r.created_at,
        seller: { id: r.user_id, displayName: r.seller_name, username: r.seller_username },
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/auctions/:id/:action', async (req, res, next) => {
  try {
    const { action } = req.params;
    if (!['pause', 'remove', 'restore'].includes(action)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Action must be pause, remove or restore.' } });
    }
    const auction = await db.get('SELECT * FROM auctions WHERE id = $1', [req.params.id]);
    if (!auction) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Auction not found.' } });
    const nextStatus = action === 'pause' ? 'paused' : action === 'remove' ? 'removed' : 'approved';
    if (auction.status === nextStatus) {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `Auction is already ${nextStatus}.` } });
    }
    await db.run(`UPDATE auctions SET status = $1 WHERE id = $2`, [nextStatus, auction.id]);
    await logAudit('admin', req.admin.actor, `auction_${action}`, 'auction', auction.id, {
      from: auction.status, to: nextStatus,
    });
    const kind = action === 'pause' ? 'auction_paused' : action === 'remove' ? 'auction_removed' : 'auction_restored';
    const title = action === 'pause'
      ? 'Your auction was paused'
      : action === 'remove'
        ? 'Your auction was removed'
        : 'Your auction is live again';
    const body = action === 'pause'
      ? `Your auction "${auction.title}" was paused by a moderator and is hidden for now.`
      : action === 'remove'
        ? `Your auction "${auction.title}" was removed by a moderator.`
        : `Your auction "${auction.title}" was reviewed and restored.`;
    await createNotification(auction.user_id, kind, title, body, `#/auction/${auction.id}`);
    res.json({ ok: true, status: nextStatus });
  } catch (err) {
    next(err);
  }
});

// --- Complaints (items 768–770) ---

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
        '#/complaint-status'
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

router.put('/fees', requireRole('owner'), requireElevated, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.feeMode !== undefined) {
      if (!['supporter_fee', 'zero_fee_plus_tip'].includes(body.feeMode)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'feeMode must be supporter_fee or zero_fee_plus_tip.' } });
      }
      const oldMode = (await db.getSetting('fee_mode')) || 'supporter_fee';
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
      // Item 216: fee-rule changes log admin + old/new values + timestamp.
      const oldConfig = await db.getSettingJson('fee_config', {});
      await db.setSetting('fee_config', JSON.stringify(body.feeConfig));
      await logAudit('admin', req.admin.actor, 'fee_config_changed', 'settings', 'fee_config', {});
    }
    if (body.founderTipConfig !== undefined) {
      const oldTip = await db.getSettingJson('founder_tip_config', {});
      await db.setSetting('founder_tip_config', JSON.stringify(body.founderTipConfig));
      await logAudit('admin', req.admin.actor, 'founder_tip_config_changed', 'settings', 'founder_tip_config', {});
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

// --- Gift dispute centre (items 281/282/284, 754) ---
// One queue for both admin UIs: the §3 dispute centre (open/resolved +
// fee reviews, mapped camelCase fields) and the §7–8 queue (item 754),
// which reads the raw gift row + audit timeline per dispute. The
// user-facing dispute-status page (item 938) reads the gift thread.

router.get('/disputes', async (req, res, next) => {
  try {
    const status = req.query.status === 'resolved' ? 'resolved' : 'open';
    const where = status === 'open'
      ? `g.status = 'disputed' OR g.fee_review_status IN ('requested', 'acknowledged')`
      : `g.fee_review_status = 'resolved'`;
    const { rows } = await db.query(
      `SELECT g.*, b.title AS bill_title, b.request_code AS bill_code, b.user_id AS recipient_id,
              u.display_name AS supporter_name, u.username AS supporter_username,
              (SELECT body FROM gift_messages m WHERE m.gift_id = g.id AND m.sender_type = 'admin' ORDER BY m.created_at DESC LIMIT 1) AS last_admin_message,
              (SELECT created_at FROM gift_messages m WHERE m.gift_id = g.id AND m.sender_type = 'admin' ORDER BY m.created_at DESC LIMIT 1) AS last_admin_message_at,
              (SELECT COUNT(*) FROM gift_messages m WHERE m.gift_id = g.id) AS message_count
       FROM gifts g JOIN bills b ON b.id = g.bill_id JOIN users u ON u.id = g.supporter_id
       WHERE ${where} ORDER BY COALESCE(g.disputed_at, g.fee_review_at, g.created_at) ASC LIMIT 100`
    );
    const disputes = [];
    for (const r of rows) {
      const timeline = await db.query(
        `SELECT * FROM audit_logs WHERE target_type = 'gift' AND target_id = $1 ORDER BY created_at ASC LIMIT 50`,
        [r.id]
      );
      disputes.push({
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
        // Item 754: the §7–8 queue reads the raw gift row + timeline.
        gift: r,
        timeline: timeline.rows,
      });
    }
    res.json({ disputes });
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
    const clauses = [];
    // Per-bill audit trail (item 378): entries targeting the bill, plus
    // entries whose meta references it (verification/report decisions).
    if (req.query.billId) {
      const billId = cleanStr(req.query.billId, 64);
      params.push(billId);
      params.push(`%\"billId\":\"${billId}\"%`);
      params.push(`%\"targetId\":\"${billId}\"%`);
      clauses.push(`(target_id = $${params.length - 2} OR meta_json LIKE $${params.length - 1} OR meta_json LIKE $${params.length})`);
    }
    // Per-user audit trail (item 379): entries by or about the user.
    if (req.query.userId) {
      const userId = cleanStr(req.query.userId, 64);
      params.push(userId);
      params.push(userId);
      clauses.push(`(actor_id = $${params.length - 1} OR target_id = $${params.length})`);
    }
    if (req.query.actor) { params.push(cleanStr(req.query.actor, 64)); clauses.push(`actor_id = $${params.length}`); }
    if (req.query.action) { params.push(cleanStr(req.query.action, 64)); clauses.push(`action = $${params.length}`); }
    if (req.query.targetType) { params.push(cleanStr(req.query.targetType, 32)); clauses.push(`target_type = $${params.length}`); }
    if (req.query.from && Number.isFinite(Date.parse(req.query.from))) {
      params.push(new Date(req.query.from).toISOString()); clauses.push(`created_at >= $${params.length}`);
    }
    if (req.query.to && Number.isFinite(Date.parse(req.query.to))) {
      params.push(new Date(req.query.to).toISOString()); clauses.push(`created_at <= $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
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

// POST /api/admin/complaints/:id {action: resolve|reopen} — closing a
// complaint notifies the complainant (the in-app confirmation).
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

// --- Appeals (items 351, 384, 739–740) ---
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
    // Both admin UIs decide appeals: the §4–6 page sends uphold/overturn,
    // the §7–8 page sends approve/reject. Accept both vocabularies.
    if (!['uphold', 'overturn', 'approve', 'reject'].includes(decision)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Decision must be uphold, overturn, approve or reject.' } });
    }
    const note = cleanStr(req.body?.note || '', 600);
    const now = nowIso();
    const restore = decision === 'overturn' || decision === 'approve';
    const status = restore ? 'overturned' : 'upheld';
    await db.run(
      `UPDATE appeals SET status = $1, reviewer_note = $2, decided_by = $3, decided_at = $4 WHERE id = $5`,
      [status, note, req.admin.actor, now, appeal.id]
    );
    if (restore) {
      // Item 740: deciding for the appellant RESTORES the content. A
      // removed or paused bill goes back to approved; a rejected bill
      // goes back to pending_review with a fresh review packet; a
      // suspended user is restored (unless banned).
      if (appeal.target_type === 'bill') {
        const bill = await db.get('SELECT * FROM bills WHERE id = $1', [appeal.target_id]);
        if (bill && (bill.status === 'removed' || bill.status === 'under_investigation')) {
          await db.run(`UPDATE bills SET status = 'approved', updated_at = $1 WHERE id = $2`, [now, bill.id]);
        } else if (bill && bill.status === 'rejected') {
          await db.run(`UPDATE bills SET status = 'pending_review', rejection_reason = '', updated_at = $1 WHERE id = $2`, [now, bill.id]);
          await createReviewPacket('bill', bill.id, await billPacketPayload(bill, []));
        }
      } else if (appeal.target_type === 'user') {
        await db.run(
          `UPDATE users SET suspended = 0, suspended_reason = '', suspended_until = NULL, suspended_at = NULL WHERE id = $1 AND banned = 0`,
          [appeal.target_id]
        );
      }
    }
    await createNotification(
      appeal.user_id,
      restore ? 'appeal_overturned' : 'appeal_upheld',
      restore ? 'Your appeal was accepted' : 'Your appeal was reviewed',
      note || (restore ? 'The decision was reversed.' : 'The original decision stands.'),
      '#/help?topic=appeals'
    );
    await logAudit('admin', req.admin.actor, `appeal_${decision}`, 'appeal', appeal.id, { targetType: appeal.target_type, targetId: appeal.target_id, note });
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

// --- Admin accounts (items 771–773) ---

router.get('/admins', requireRole('owner'), async (req, res, next) => {
  try {
    res.json({ admins: await listAdminUsers() });
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

router.post('/admins', requireRole('owner'), async (req, res, next) => {
  try {
    const result = await createAdminUser(req.body?.displayName, req.body?.role, req.body?.pin);
    if (!result.ok) return res.status(400).json({ error: { code: 'ADMIN_CREATE_FAILED', message: result.error } });
    res.status(201).json({ ok: true, adminUser: result.adminUser });
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

// --- Brand verification (items 506/507) ---
// Manual owner check of the brand's public registration details — no
// licence or permission is involved.
router.post('/brand-profiles/:id/verify', async (req, res, next) => {
  try {
    const bp = await db.get('SELECT * FROM brand_profiles WHERE id = $1', [req.params.id]);
    if (!bp || bp.status !== 'approved') {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Only an approved brand profile can be verified.' } });
    }
    await db.run(
      'UPDATE brand_profiles SET verified = 1, updated_at = $1 WHERE id = $2',
      [nowIso(), bp.id]
    );
    await createNotification(
      bp.owner_id, 'brand_verified', 'Your brand is verified',
      `${bp.name} now shows the verified badge in the directory.`, `#/brand-directory/${bp.id}`
    );
    await logAudit('admin', 'owner', 'brand_verified', 'brand_profile', bp.id, {});
    res.json({ ok: true });
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

// --- Sponsored drops (items 539–543) ---

router.get('/drops', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT d.*, (SELECT COUNT(*) FROM drop_entries e WHERE e.drop_id = d.id) AS entries
       FROM drops d ORDER BY d.created_at DESC LIMIT 100`
    );
    res.json({
      drops: rows.map((r) => ({
        id: r.id, brandProfileId: r.brand_profile_id, brandName: r.brand_name,
        title: r.title, product: r.product, quantity: r.quantity,
        eligibility: r.eligibility, status: r.status,
        winnerUserId: r.winner_user_id, entries: Number(r.entries || 0),
        createdAt: r.created_at, drawnAt: r.drawn_at,
      })),
    });
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

// --- Security (items 775, 788, 789, 826/827) ---

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
    // Items 826/827: reveal alerts + anomalies (same endpoint — the
    // §9–10 security page reads these fields alongside the §7–8 ones).
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
      lastSignIns,
      securitySettings: await getSecuritySettings(),
      events: events.rows.map((r) => ({
        id: r.id, actorId: r.actor_id, action: r.action,
        targetType: r.target_type, targetId: r.target_id,
        meta: JSON.parse(r.meta_json || '{}'), createdAt: r.created_at,
      })),
      accountsOverRevealThreshold: overThreshold,
      anomalies,
      blockedReveals24h: Number(blocked24h?.c || 0),
      fingerprintChanges: fingerprintChanges.rows.map((r) => ({ userId: r.actor_id, createdAt: r.created_at })),
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

// --- Security status page content (item 886) ---

router.get('/security-status', async (req, res, next) => {
  try {
    const stored = await db.getSettingJson('security_status', null);
    res.json(stored || { status: 'normal', message: '', incidents: [] });
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

router.post('/drops', async (req, res, next) => {
  try {
    const body = req.body || {};
    const title = cleanStr(body.title, 200);
    const product = cleanStr(body.product, 300);
    if (title.length < 3 || product.length < 2) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Title and product are required.' } });
    }
    const brandName = cleanStr(body.brandName, 120);
    if (brandName.length < 2) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Brand name is required.' } });
    }
    let brandProfileId = null;
    if (body.brandProfileId) {
      const bp = await db.get('SELECT id FROM brand_profiles WHERE id = $1', [cleanStr(body.brandProfileId, 64)]);
      if (!bp) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Brand profile not found.' } });
      brandProfileId = bp.id;
    }
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO drops (id, brand_profile_id, brand_name, title, product, quantity, eligibility, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8)`,
      [
        id, brandProfileId, brandName, title, product,
        Math.max(1, parseInt(body.quantity, 10) || 1),
        cleanStr(body.eligibility || '', 1000), nowIso(),
      ]
    );
    await logAudit('admin', 'owner', 'drop_created', 'drop', id, { brandName, title });
    res.status(201).json({ ok: true, dropId: id });
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

// POST /admin/drops/:id/draw — random draw, winner displayed by published
// rules (item 542). Winner is picked from entries; ties/quantity > 1
// are handled by drawing additional winners in the response.
router.post('/drops/:id/draw', async (req, res, next) => {
  try {
    const drop = await db.get('SELECT * FROM drops WHERE id = $1', [req.params.id]);
    if (!drop) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Drop not found.' } });
    if (drop.status !== 'open') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: `This drop is ${drop.status}, not open.` } });
    }
    const { rows } = await db.query('SELECT user_id FROM drop_entries WHERE drop_id = $1', [drop.id]);
    if (!rows.length) {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'No entries yet — nothing to draw.' } });
    }
    // Fisher–Yates with crypto randomness; winner is the first of the
    // shuffled entries. Multiple quantity → additional winners listed.
    const pool = rows.map((r) => r.user_id);
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = crypto.randomInt(0, i + 1);
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const winnerCount = Math.min(drop.quantity, pool.length);
    const winners = pool.slice(0, winnerCount);
    await db.run(
      `UPDATE drops SET status = 'drawn', winner_user_id = $1, drawn_at = $2 WHERE id = $3`,
      [winners[0], nowIso(), drop.id]
    );
    for (const winnerId of winners) {
      await createNotification(
        winnerId, 'drop_won', `You won the ${drop.title} drop`,
        `You won ${drop.product} from ${drop.brandName}. The brand will contact you.`,
        `#/drops`
      );
    }
    await logAudit('admin', 'owner', 'drop_drawn', 'drop', drop.id, { winners, entries: rows.length });
    res.json({ ok: true, winners, entries: rows.length });
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
