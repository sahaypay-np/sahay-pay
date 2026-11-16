// Sahay Pay — referrals (Phase 2 §7, items 671–680).
// Each user gets a unique referral code; signups via ?ref=<code> record
// the referrer (users.referred_by). A referred friend is "active" once
// they post their first bill or send their first gift (674).
// Fraud checks (678): self-referral is structurally impossible (a new
// account cannot be its own referrer — the code resolves to an existing
// user id, never the new one), and referral velocity (5+ signups via one
// code in 24h) is flagged for admin review. No device fingerprinting is
// used for referrals — item 855's coarse UA hash stays a rate-limit key
// only (P1-269).

'use strict';

const crypto = require('crypto');
const db = require('../db');
const { logAudit } = require('./audit');
const { createNotification } = require('./notify');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const REFERRAL_BADGES = [1, 5, 10];
const VELOCITY_THRESHOLD = 5; // signups via one code in 24h -> admin flag

function randomCode(length = 8) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

// Generate a referral code that no user holds yet (retries on collision).
async function generateReferralCode() {
  for (let i = 0; i < 10; i++) {
    const code = randomCode();
    const taken = await db.get('SELECT id FROM users WHERE referral_code = $1', [code]);
    if (!taken) return code;
  }
  // Extremely unlikely: fall back to a longer code.
  return randomCode(12);
}

// Backfill a code for users created before referrals existed.
async function ensureReferralCode(userId) {
  const user = await db.get('SELECT referral_code FROM users WHERE id = $1', [userId]);
  if (!user) return null;
  if (user.referral_code) return user.referral_code;
  const code = await generateReferralCode();
  await db.run('UPDATE users SET referral_code = $1 WHERE id = $2', [code, userId]);
  return code;
}

// Active referred friends: referred users with >= 1 submitted bill or >= 1 gift.
async function activeReferralCount(referrerId) {
  const row = await db.get(
    `SELECT COUNT(*) AS c FROM users u
     WHERE u.referred_by = $1 AND (
       EXISTS (SELECT 1 FROM bills b WHERE b.user_id = u.id AND b.status != 'draft')
       OR EXISTS (SELECT 1 FROM gifts g WHERE g.supporter_id = u.id)
     )`,
    [referrerId]
  );
  return Number(row?.c || 0);
}

async function totalReferralCount(referrerId) {
  const row = await db.get('SELECT COUNT(*) AS c FROM users WHERE referred_by = $1', [referrerId]);
  return Number(row?.c || 0);
}

function badgesFor(count) {
  return REFERRAL_BADGES.filter((b) => count >= b);
}

// Item 674: when a referred friend posts their first bill or sends their
// first gift, alert the referrer — once per friend per kind.
async function maybeNotifyReferralMilestone(userId, kind) {
  const user = await db.get('SELECT referred_by, display_name FROM users WHERE id = $1', [userId]);
  if (!user?.referred_by) return;
  const referrer = await db.get('SELECT id, prefs_json FROM users WHERE id = $1', [user.referred_by]);
  if (!referrer) return;
  // Referral opt-out (680): the referrer stopped referral alerts.
  try {
    const prefs = JSON.parse(referrer.prefs_json || '{}');
    if (prefs.referralOptOut === true) return;
  } catch { /* prefs unreadable — notify anyway */ }
  const link = `#/referrals?friend=${userId}`;
  // Dedupe: one alert per friend per kind.
  const existing = await db.get(
    `SELECT id FROM notifications
     WHERE user_id = $1 AND kind = 'referral_milestone' AND link = $2 LIMIT 1`,
    [referrer.id, `${link}:${kind}`]
  );
  if (existing) return;
  const what = kind === 'bill' ? 'posted their first bill' : 'sent their first gift';
  await createNotification(
    referrer.id, 'referral_milestone', 'Your friend is helping',
    `${user.display_name} — who joined through your link — ${what}.`,
    `${link}:${kind}`
  );
}

// Item 678 (velocity part): flag a referrer whose code gained many
// signups in 24 hours, for admin review. Flag only — never a block.
async function checkReferralVelocity(referrerId) {
  const row = await db.get(
    `SELECT COUNT(*) AS c FROM users
     WHERE referred_by = $1 AND created_at >= $2`,
    [referrerId, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()]
  );
  if (Number(row?.c || 0) >= VELOCITY_THRESHOLD) {
    await logAudit('system', 'referral-velocity', 'referral_velocity_flag', 'user', referrerId, {
      signupsLast24h: Number(row.c),
    });
  }
}

module.exports = {
  generateReferralCode,
  ensureReferralCode,
  activeReferralCount,
  totalReferralCount,
  badgesFor,
  REFERRAL_BADGES,
  maybeNotifyReferralMilestone,
  checkReferralVelocity,
};
