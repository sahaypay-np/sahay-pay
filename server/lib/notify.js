// Sahay Pay — notifications, owner review packets, and the owner webhook.
// Review workflow (Part C §3): every submission (bill, brand ask, auction,
// profile photo, material edit) creates a review packet and waits for the
// OWNER's explicit yes. Nothing auto-publishes. The packet is:
//  (a) listed in the admin review queue,
//  (b) POSTed to OWNER_NOTIFICATION_WEBHOOK_URL if set (fire-and-forget),
//  (c) decided only via the PIN-gated admin review action or the
//      bridge (Muse) with its dedicated secret.
// applyReviewDecision is shared by the admin route and the bridge route so
// both have exactly the same effect.

'use strict';

const crypto = require('crypto');
const db = require('../db');
const { logAudit, nowIso } = require('./audit');
const { trustScoreForUser } = require('./abuse');

// --- Notification preferences (Phase 2 §7, items 612–618) ---
// Every notification kind maps to one preference event. The user's
// prefs_json.notifyTypes[event] === false suppresses that event (default:
// everything on). Legacy notifyPrefs (posts/gifts/brands) still apply as
// a fallback for users who never set the per-event toggles.
// Categories: 'security' alerts can NEVER be turned off (item 616) and
// bypass the pause + quiet-hours rules; everything else is non-essential
// for the pause rule (614) and non-urgent for quiet hours (617).
const KIND_EVENT = {
  post_approved: 'bill_approved',
  post_rejected: 'bill_rejected',
  changes_requested: 'changes_requested',
  bill_paused: 'security',
  bill_removed: 'security',
  bill_restored: 'security',
  poster_warned: 'security',
  payout_edited: 'security',
  gift_started: 'gift_received',
  gift_details_shown: 'gift_received',
  gift_reported_sent: 'gift_received',
  gift_confirmed: 'gift_confirmed',
  gift_not_received: 'gift_received',
  gift_progress: 'milestones',
  first_gift: 'milestones',
  gift_fully_funded: 'milestones',
  milestone_giver: 'milestones',
  milestone_helper: 'milestones',
  verification_approved: 'verification',
  verification_decided: 'verification',
  complaint_resolved: 'account',
  appeal_decided: 'account',
  report_decided: 'account',
  user_notice: 'account',
  digest_weekly: 'digest',
  digest_monthly: 'digest',
  referral_milestone: 'referral',
  referral_friend: 'referral',
  message_received: 'messages',
  thank_you_received: 'thanks',
  announcement: 'announcements',
  broadcast: 'announcements',
  deadline_reminder: 'bills',
  confirm_reminder: 'gifts',
  verification_reminder: 'verification',
  thank_you_reminder: 'thanks',
  auction_outbid: 'account',
  auction_paused: 'account',
  auction_removed: 'account',
  auction_restored: 'account',
};
const SECURITY_EVENTS = new Set(['security']);
// Legacy notifyPrefs fallback: posts -> bill events, gifts -> gift events,
// brands -> announcements.
const LEGACY_EVENT_MAP = {
  bill_approved: 'posts', bill_rejected: 'posts', changes_requested: 'posts',
  gift_received: 'gifts', gift_confirmed: 'gifts',
  announcements: 'brands',
};

async function getUserPrefs(userId) {
  try {
    const row = await db.get('SELECT prefs_json FROM users WHERE id = $1', [userId]);
    return JSON.parse(row?.prefs_json || '{}');
  } catch {
    return {};
  }
}

function eventEnabled(prefs, event) {
  if (SECURITY_EVENTS.has(event)) return true; // item 616: security cannot be off
  const types = prefs.notifyTypes || {};
  if (types[event] === false) return false;
  if (types[event] === true) return true;
  const legacyKey = LEGACY_EVENT_MAP[event];
  if (legacyKey && prefs.notifyPrefs && prefs.notifyPrefs[legacyKey] === false) return false;
  return true;
}

// Quiet hours (item 617): prefs.quietHours = {start, end} in LOCAL hours
// (0–23), prefs.tzOffsetMinutes = minutes ahead of UTC (client-detected;
// default +345, Nepal). Returns the ISO time the notification should be
// delivered at, or null for "now". Non-urgent notifications created inside
// the window are held until the window ends (lazy delivery on next visit).
function quietHoursDeliverAt(prefs, event, nowMs) {
  if (SECURITY_EVENTS.has(event)) return null;
  const qh = prefs.quietHours;
  if (!qh || !Number.isInteger(qh.start) || !Number.isInteger(qh.end) || qh.start === qh.end) return null;
  const offsetMin = Number.isInteger(prefs.tzOffsetMinutes) ? prefs.tzOffsetMinutes : 345;
  const localMs = nowMs + offsetMin * 60000;
  const local = new Date(localMs);
  const localMinutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const startMin = qh.start * 60;
  const endMin = qh.end * 60;
  const inWindow = startMin < endMin
    ? (localMinutes >= startMin && localMinutes < endMin)
    : (localMinutes >= startMin || localMinutes < endMin);
  if (!inWindow) return null;
  // Next window end, in local minutes from now.
  let daysAhead = 0;
  if (localMinutes >= endMin) daysAhead = 1;
  const endLocal = new Date(localMs);
  endLocal.setUTCHours(Math.floor(endMin / 60), endMin % 60, 0, 0);
  endLocal.setUTCDate(endLocal.getUTCDate() + daysAhead);
  return new Date(endLocal.getTime() - offsetMin * 60000).toISOString();
}

async function createNotification(userId, kind, title, body, link = '', opts = {}) {
  if (!userId) return null;
  const event = KIND_EVENT[kind] || 'account';
  const prefs = await getUserPrefs(userId);
  if (!eventEnabled(prefs, event)) return null; // per-event opt-out (613/615)
  // Pause-all-non-essential (614): 7-day auto-resume — the toggle stores
  // pauseUntil; once it passes, delivery resumes on its own (lazy check).
  if (!SECURITY_EVENTS.has(event) && prefs.pauseUntil && Date.parse(prefs.pauseUntil) > Date.now()) {
    return null;
  }
  const deliverAt = quietHoursDeliverAt(prefs, event, Date.now());
  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO notifications (id, user_id, kind, title, body, link, is_read, deliver_at, broadcast_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9)`,
    [id, userId, kind, title, body, link, deliverAt, opts.broadcastId || null, nowIso()]
  );
  return id;
}

// Item 797: persist every owner-webhook delivery (target, kind, result)
// so the admin console can show the delivery log. The stored URL is the
// origin + path only — the query string is stripped because it could carry
// a secret token.
async function logWebhookDelivery(url, payloadKind, statusCode, error) {
  try {
    let safeUrl = '';
    try {
      const u = new URL(url);
      safeUrl = `${u.origin}${u.pathname}`;
    } catch {
      safeUrl = String(url || '').split('?')[0].slice(0, 200);
    }
    await db.run(
      `INSERT INTO webhook_deliveries (id, target_url, payload_kind, status_code, error, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [crypto.randomUUID(), safeUrl, payloadKind, statusCode, String(error || '').slice(0, 300), nowIso()]
    );
  } catch (err) {
    console.error('[webhook] FAILED to log delivery:', err.message);
  }
}

// Fire-and-forget POST of the review packet to the owner's webhook (Muse).
// Never blocks the request; failures are logged, never fatal. The packet
// still waits in the admin queue when the webhook is unset or fails.
function sendOwnerWebhook(packet) {
  const url = process.env.OWNER_NOTIFICATION_WEBHOOK_URL;
  if (!url) return;
  const payload = JSON.stringify(packet);
  const kind = packet?.type === 'webhook_test' ? 'webhook_test' : 'review_packet';
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  })
    .then((res) => {
      console.log(`[webhook] review packet ${packet.id} -> owner webhook: HTTP ${res.status}`);
      logWebhookDelivery(url, kind, res.status, res.ok ? '' : `HTTP ${res.status}`);
    })
    .catch((err) => {
      console.error(`[webhook] review packet ${packet.id} -> owner webhook FAILED:`, err.message);
      logWebhookDelivery(url, kind, null, err.message);
    });
}

async function createReviewPacket(targetType, targetId, payload) {
  const id = crypto.randomUUID();
  const packet = {
    id,
    targetType,
    targetId,
    payload,
    status: 'pending',
    createdAt: nowIso(),
  };
  await db.run(
    `INSERT INTO review_packets (id, target_type, target_id, payload_json, status, created_at)
     VALUES ($1, $2, $3, $4, 'pending', $5)`,
    [id, targetType, targetId, JSON.stringify(payload), packet.createdAt]
  );
  sendOwnerWebhook(packet);
  return packet;
}

// Build the owner-facing packet payload for a bill: everything the owner
// needs to decide, with the payout account MASKED (last 4 only).
async function billPacketPayload(bill, payoutHints) {
  const owner = await db.get('SELECT * FROM users WHERE id = $1', [bill.user_id]);
  const counts = await db.get(
    `SELECT
       (SELECT COUNT(*) FROM bills WHERE user_id = $1 AND status = 'approved') AS approved,
       (SELECT COUNT(*) FROM bills WHERE user_id = $2 AND status = 'rejected') AS rejected,
       (SELECT COUNT(*) FROM reports WHERE target_type = 'bill' AND target_id IN (SELECT id FROM bills WHERE user_id = $3)) AS reports`,
    [bill.user_id, bill.user_id, bill.user_id]
  );
  const payload = {
    kind: 'bill',
    billId: bill.id,
    requestCode: bill.request_code,
    title: bill.title,
    category: bill.category,
    company: bill.company,
    amountMinor: bill.amount_minor,
    currency: bill.currency,
    country: bill.country,
    city: bill.city,
    story: bill.story,
    details: bill.details,
    charity: bill.charity === 1,
    payDirect: bill.pay_direct === 1,
    billerName: bill.biller_name,
    photoUrl: bill.photo_url,
    supportPhotoUrl: bill.support_photo_url,
    hasPrivateProof: Boolean(bill.private_proof_url),
    payoutHints: payoutHints || [],
    requester: owner
      ? {
          displayName: owner.display_name,
          username: owner.username,
          memberSince: owner.created_at,
          approvedPosts: Number(counts?.approved || 0),
          rejectedPosts: Number(counts?.rejected || 0),
          reportsAgainst: Number(counts?.reports || 0),
        }
      : null,
    // Item 857: trust score (account age, verified actions, report
    // history) — a hint for the reviewer, never a decision.
    trustScore: await trustScoreForUser(bill.user_id),
    aiNote: 'AI-suggested — not a decision: no automated checks ran on this post. A human (the owner) decides.',
  };
  return payload;
}

// Apply an owner decision to a review packet. Shared by admin + bridge.
// decision: 'approve' | 'reject' | 'changes'. Returns {ok} or {ok:false, error}.
async function applyReviewDecision(packetId, decision, reason, actorType, actorId) {
  const packet = await db.get('SELECT * FROM review_packets WHERE id = $1', [packetId]);
  if (!packet) return { ok: false, status: 404, error: 'Review packet not found.' };
  if (packet.status !== 'pending') {
    return { ok: false, status: 409, error: `This packet was already decided (${packet.status}).` };
  }
  if (!['approve', 'reject', 'changes'].includes(decision)) {
    return { ok: false, status: 400, error: 'Decision must be approve, reject or changes.' };
  }

  const payload = JSON.parse(packet.payload_json || '{}');
  const now = nowIso();
  const newPacketStatus = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'changes_requested';

  if (packet.target_type === 'bill') {
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [packet.target_id]);
    if (!bill) return { ok: false, status: 404, error: 'Bill not found.' };
    if (decision === 'approve') {
      // Phase 2 (item 181): 30-day expiry starts at approval.
      const expiresAt = new Date(Date.now() + 30 * 24 * 3600000).toISOString();
      await db.run(
        `UPDATE bills SET status = 'approved', approved_at = $1, approved_by = $2,
         rejection_reason = '', changes_note = '', expires_at = $5, updated_at = $4 WHERE id = $3`,
        [now, actorId, bill.id, now, expiresAt]
      );
      await createNotification(
        bill.user_id, 'post_approved', 'Your request is live',
        `"${bill.title}" was approved and is now in the swipe feed.`, `#/bill/${bill.id}`
      );
    } else if (decision === 'reject') {
      await db.run(
        `UPDATE bills SET status = 'rejected', rejection_reason = $1, updated_at = $2 WHERE id = $3`,
        [reason || 'Not approved.', now, bill.id]
      );
      await createNotification(
        bill.user_id, 'post_rejected', 'Your request was not approved',
        reason ? `Reason: ${reason}` : 'Your request was not approved. You can appeal from the Help Centre.',
        '#/mybills'
      );
    } else {
      await db.run(
        `UPDATE bills SET status = 'changes_requested', changes_note = $1, updated_at = $2 WHERE id = $3`,
        [reason || 'Please make some changes and resubmit.', now, bill.id]
      );
      await createNotification(
        bill.user_id, 'changes_requested', 'Changes requested on your post',
        reason || 'The owner asked for some changes before your post can go live.',
        '#/mybills'
      );
    }
  } else if (packet.target_type === 'brand') {
    const brand = await db.get('SELECT * FROM brands WHERE id = $1', [packet.target_id]);
    if (!brand) return { ok: false, status: 404, error: 'Brand ask not found.' };
    const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'changes_requested';
    // Ask expiry (item 598): an approved ask closes after 60 days without
    // a response (lazy — evaluated on read).
    const expiresAt = decision === 'approve'
      ? new Date(Date.now() + 60 * 86400000).toISOString()
      : brand.expires_at;
    await db.run('UPDATE brands SET status = $1, expires_at = $2 WHERE id = $3', [status, expiresAt, brand.id]);
    await createNotification(
      brand.user_id,
      decision === 'approve' ? 'post_approved' : decision === 'reject' ? 'post_rejected' : 'changes_requested',
      decision === 'approve' ? 'Your brand ask is live' : decision === 'reject' ? 'Your brand ask was not approved' : 'Changes requested on your brand ask',
      reason || '',
      '#/brands'
    );
  } else if (packet.target_type === 'auction') {
    const auction = await db.get('SELECT * FROM auctions WHERE id = $1', [packet.target_id]);
    if (!auction) return { ok: false, status: 404, error: 'Auction not found.' };
    const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'changes_requested';
    await db.run('UPDATE auctions SET status = $1 WHERE id = $2', [status, auction.id]);
    await createNotification(
      auction.user_id,
      decision === 'approve' ? 'post_approved' : decision === 'reject' ? 'post_rejected' : 'changes_requested',
      decision === 'approve' ? 'Your auction is live' : decision === 'reject' ? 'Your auction was not approved' : 'Changes requested on your auction',
      reason || '',
      '#/auctions'
    );
  } else if (packet.target_type === 'photo') {
    // Profile-photo change: payload carries { userId, photoUrl }.
    const userId = payload.userId;
    if (decision === 'approve' && userId && payload.photoUrl) {
      await db.run('UPDATE users SET photo_url = $1 WHERE id = $2', [payload.photoUrl, userId]);
      await createNotification(userId, 'post_approved', 'Your profile photo is live', 'Your new profile photo was approved.', '#/settings');
    } else if (userId) {
      await createNotification(
        userId, 'post_rejected', 'Your profile photo was not approved',
        reason || 'Please choose a different photo.', '#/settings'
      );
    }
  } else if (packet.target_type === 'cover') {
    // Cover-image change (item 466): payload carries { userId, coverUrl }.
    const userId = payload.userId;
    if (decision === 'approve' && userId && payload.coverUrl) {
      await db.run('UPDATE users SET cover_url = $1 WHERE id = $2', [payload.coverUrl, userId]);
      await createNotification(userId, 'post_approved', 'Your cover image is live', 'Your new cover image was approved.', '#/settings');
    } else if (userId) {
      await createNotification(
        userId, 'post_rejected', 'Your cover image was not approved',
        reason || 'Please choose a different image.', '#/settings'
      );
    }
  } else if (packet.target_type === 'thank') {
    // Thank-you moderation (item 427): nothing public until approved.
    const thank = await db.get('SELECT * FROM thanks WHERE id = $1', [packet.target_id]);
    if (!thank) return { ok: false, status: 404, error: 'Thank-you not found.' };
    const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'changes_requested';
    await db.run('UPDATE thanks SET status = $1 WHERE id = $2', [status, thank.id]);
    if (decision === 'approve') {
      // Giver notification (item 428).
      await createNotification(
        thank.giver_id, 'thank_you', 'Someone thanked you',
        'A person you helped sent you a thank-you.', `#/bill/${thank.bill_id}`
      );
    } else {
      await createNotification(
        thank.receiver_id, 'thank_you_decided',
        decision === 'reject' ? 'Your thank-you was not approved' : 'Changes requested on your thank-you',
        reason || '', `#/bill/${thank.bill_id}`
      );
    }
  } else if (packet.target_type === 'story') {
    // Receiver-story moderation (item 483).
    const story = await db.get('SELECT * FROM receiver_stories WHERE id = $1', [packet.target_id]);
    if (!story) return { ok: false, status: 404, error: 'Story not found.' };
    const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'changes_requested';
    await db.run('UPDATE receiver_stories SET status = $1 WHERE id = $2', [status, story.id]);
    if (decision !== 'approve') {
      await createNotification(
        story.user_id, 'story_decided',
        decision === 'reject' ? 'Your story was not approved' : 'Changes requested on your story',
        reason || '', `#/bill/${story.bill_id}`
      );
    }
  } else if (packet.target_type === 'csr') {
    // CSR-update moderation (item 551).
    const csr = await db.get('SELECT * FROM csr_updates WHERE id = $1', [packet.target_id]);
    if (!csr) return { ok: false, status: 404, error: 'CSR update not found.' };
    const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'changes_requested';
    await db.run('UPDATE csr_updates SET status = $1 WHERE id = $2', [status, csr.id]);
    const bp = await db.get('SELECT owner_id FROM brand_profiles WHERE id = $1', [csr.brand_profile_id]);
    if (bp && decision !== 'approve') {
      await createNotification(
        bp.owner_id, 'csr_decided',
        decision === 'reject' ? 'Your CSR update was not approved' : 'Changes requested on your CSR update',
        reason || '', '#/brand-directory'
      );
    }
  } else if (packet.target_type === 'brand_profile') {
    // Registered-brand application (items 501/509/510).
    const bp = await db.get('SELECT * FROM brand_profiles WHERE id = $1', [packet.target_id]);
    if (!bp) return { ok: false, status: 404, error: 'Brand profile not found.' };
    const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'changes_requested';
    await db.run(
      'UPDATE brand_profiles SET status = $1, rejection_reason = $2, updated_at = $3 WHERE id = $4',
      [status, decision === 'reject' ? (reason || 'Not approved.') : '', now, bp.id]
    );
    await createNotification(
      bp.owner_id,
      decision === 'approve' ? 'brand_approved' : 'brand_decided',
      decision === 'approve' ? 'Your brand is listed' : decision === 'reject' ? 'Your brand application was not approved' : 'Changes requested on your brand application',
      reason || '',
      '#/brand-directory'
    );
  } else {
    return { ok: false, status: 400, error: `Unknown packet target type: ${packet.target_type}.` };
  }

  await db.run('UPDATE review_packets SET status = $1 WHERE id = $2', [newPacketStatus, packet.id]);
  await logAudit(actorType, actorId, `review_${decision}`, packet.target_type, packet.target_id, {
    packetId: packet.id,
    reason: reason || '',
  });
  return { ok: true, packetStatus: newPacketStatus };
}

module.exports = {
  createNotification,
  getUserPrefs,
  eventEnabled,
  KIND_EVENT,
  sendOwnerWebhook,
  logWebhookDelivery,
  createReviewPacket,
  billPacketPayload,
  applyReviewDecision,
};
