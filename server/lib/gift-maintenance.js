// Sahay Pay — lazy gift/pledge maintenance (Phase 2, items 243/244/267).
// There is no scheduler on the free tier and no email in the product, so
// time-based rules are evaluated LAZILY when the affected user next opens
// the app (called from GET /api/notifications and GET /api/gifts/mine):
//  - 243: a marked-sent gift unconfirmed after 24h (then 72h) notifies the
//    poster in-app to confirm or dispute it.
//  - 244: a marked-sent gift still unconfirmed after 7 days moves to
//    'expired' ("awaiting confirmation" history) and both parties are
//    notified in-app. Expired gifts never credit the bill.
//  - 267: an active pledge whose next due date has arrived notifies the
//    helper in-app to send the next gift manually (no automatic payment,
//    ever). One reminder per due cycle.
// All work is scoped to one user and is best-effort: a failure here must
// never fail the request that triggered it.

'use strict';

const db = require('../db');
const { createNotification } = require('./notify');
const { nowIso } = require('./audit');

const HOUR = 3600000;
const DAY = 24 * HOUR;

async function runGiftMaintenanceForUser(userId) {
  if (!userId) return;
  const now = Date.now();
  const nowStr = nowIso();

  // Gifts where this user is the POSTER (bills they own) and the gift is
  // waiting on their confirmation.
  const { rows: waiting } = await db.query(
    `SELECT g.*, b.title AS bill_title, b.user_id AS poster_id,
            u.display_name AS supporter_name
     FROM gifts g
     JOIN bills b ON b.id = g.bill_id
     JOIN users u ON u.id = g.supporter_id
     WHERE b.user_id = $1 AND g.status = 'donor_reported_sent'`,
    [userId]
  );
  for (const g of waiting) {
    const sentAt = new Date(g.reported_sent_at || g.created_at).getTime();
    const ageMs = now - sentAt;
    const amount = `${g.amount_minor / 100} ${g.currency}`;
    const helper = g.supporter_name || 'Someone';
    if (ageMs >= 7 * DAY) {
      // 244: expire after 7 days unconfirmed.
      await db.run(`UPDATE gifts SET status = 'expired' WHERE id = $1`, [g.id]);
      await createNotification(
        g.poster_id, 'gift_expired',
        'A gift expired unconfirmed',
        `${helper}'s ${amount} help for "${g.bill_title}" was never confirmed and has moved to your history. You can still confirm it if the money did arrive — open a dispute and the owner can help.`,
        '#/mybills'
      );
      await createNotification(
        g.supporter_id, 'gift_expired',
        'Your gift expired unconfirmed',
        `Your ${amount} help for "${g.bill_title}" was not confirmed within 7 days. If you did send it, open a dispute from My Bills and the owner can help.`,
        '#/mybills'
      );
    } else if (ageMs >= 72 * HOUR && g.reminded_72h !== 1) {
      await db.run(`UPDATE gifts SET reminded_72h = 1 WHERE id = $1`, [g.id]);
      await createNotification(
        g.poster_id, 'gift_confirm_reminder',
        'Still waiting: did this help arrive?',
        `${helper} says they sent ${amount} for "${g.bill_title}" 3 days ago. Please confirm it arrived — or tap "Didn't arrive" if it didn't.`,
        '#/mybills'
      );
    } else if (ageMs >= 24 * HOUR && g.reminded_24h !== 1) {
      await db.run(`UPDATE gifts SET reminded_24h = 1 WHERE id = $1`, [g.id]);
      await createNotification(
        g.poster_id, 'gift_confirm_reminder',
        'Did this help arrive?',
        `${helper} says they sent ${amount} for "${g.bill_title}" yesterday. Please confirm it arrived — or tap "Didn't arrive" if it didn't.`,
        '#/mybills'
      );
    }
  }

  // Pledges where this user is the HELPER and the next gift is due.
  const { rows: pledges } = await db.query(
    `SELECT p.*, b.title AS bill_title
     FROM pledges p JOIN bills b ON b.id = p.bill_id
     WHERE p.user_id = $1 AND p.status = 'active' AND p.next_due_at <= $2`,
    [userId, nowStr]
  );
  for (const p of pledges) {
    // One reminder per due cycle: last_reminded_at must predate this due date.
    if (p.last_reminded_at && p.last_reminded_at >= p.next_due_at) continue;
    await db.run(`UPDATE pledges SET last_reminded_at = $1 WHERE id = $2`, [nowStr, p.id]);
    await createNotification(
      p.user_id, 'pledge_due',
      'Your pledged help is due',
      `Your ${p.frequency} pledge of ${p.amount_minor / 100} ${p.currency} for "${p.bill_title}" is due. Open the bill and send it when you're ready — nothing is charged automatically.`,
      `#/bill/${p.bill_id}`
    );
  }
}

// Best-effort wrapper: maintenance must never break the request.
async function runGiftMaintenanceSafe(userId) {
  try {
    await runGiftMaintenanceForUser(userId);
  } catch (err) {
    console.error('[gift-maintenance] failed for user', userId, err.message);
  }
}

module.exports = { runGiftMaintenanceForUser, runGiftMaintenanceSafe };
