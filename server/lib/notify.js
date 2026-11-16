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

async function createNotification(userId, kind, title, body, link = '') {
  if (!userId) return null;
  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO notifications (id, user_id, kind, title, body, link, is_read, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 0, $7)`,
    [id, userId, kind, title, body, link, nowIso()]
  );
  return id;
}

// Fire-and-forget POST of the review packet to the owner's webhook (Muse).
// Never blocks the request; failures are logged, never fatal. The packet
// still waits in the admin queue when the webhook is unset or fails.
function sendOwnerWebhook(packet) {
  const url = process.env.OWNER_NOTIFICATION_WEBHOOK_URL;
  if (!url) return;
  const payload = JSON.stringify(packet);
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  })
    .then((res) => {
      console.log(`[webhook] review packet ${packet.id} -> owner webhook: HTTP ${res.status}`);
    })
    .catch((err) => {
      console.error(`[webhook] review packet ${packet.id} -> owner webhook FAILED:`, err.message);
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
      await db.run(
        `UPDATE bills SET status = 'approved', approved_at = $1, approved_by = $2,
         rejection_reason = '', changes_note = '', updated_at = $4 WHERE id = $3`,
        [now, actorId, bill.id, now]
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
    await db.run('UPDATE brands SET status = $1 WHERE id = $2', [status, brand.id]);
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
  sendOwnerWebhook,
  createReviewPacket,
  billPacketPayload,
  applyReviewDecision,
};
