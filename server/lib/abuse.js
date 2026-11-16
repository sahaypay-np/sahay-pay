// Sahay Pay — abuse signals for bill review (Phase 2 items 853/854/857).
// All signals are FLAGS for the human reviewer, never auto-blocks: every
// bill already waits for owner approval, so a flag only adds context to
// the review packet. Nothing here auto-publishes or auto-rejects.

'use strict';

const db = require('../db');

// Item 853: known scam phrases (EN + common NP/IN phrasings). Matches go
// to the review packet as scamFlag + matched phrases.
const SCAM_PHRASES = [
  'double your money',
  'guaranteed returns',
  'guaranteed profit',
  'send money to unlock',
  'pay to unlock',
  'investment opportunity',
  'crypto investment',
  'bitcoin investment',
  'forex trading profit',
  'earn money from home',
  'work from home earn',
  'quick money',
  'easy money scheme',
  'lottery winner',
  'you have won',
  'claim your prize',
  'processing fee to release',
  'pay the fee to receive',
  'urgent help send money now',
  'send me money first',
  'double your amount',
  'money doubling',
  'ponzi',
  'mlm opportunity',
  'join my team earn',
  'whatsapp me to invest',
  'telegram invest',
  'kyc update urgently',
  'account will be blocked',
  'verify your account now',
];

function scanScamPhrases(text) {
  const hay = ` ${String(text || '').toLowerCase()} `;
  const found = [];
  for (const phrase of SCAM_PHRASES) {
    if (hay.includes(phrase)) found.push(phrase);
  }
  return found;
}

// Item 854: duplicate-bill detector — same poster-independent title +
// amount + photo within 90 days. Returns the matching bill id or null.
async function findDuplicateBill({ title, amountMinor, photoUrl, excludeBillId }) {
  if (!title || !amountMinor) return null;
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const row = await db.get(
    `SELECT id FROM bills
     WHERE LOWER(title) = LOWER($1) AND amount_minor = $2
       AND photo_url IS NOT NULL AND photo_url = $3
       AND id != $4 AND created_at >= $5
     ORDER BY created_at DESC LIMIT 1`,
    [title, amountMinor, photoUrl || '', excludeBillId || '', since]
  );
  return row ? row.id : null;
}

// Item 857: trust score for the admin queue — account age, verified
// actions, report history. 0–100, with the factors shown so the owner can
// see WHY. A score is a hint, never a decision.
async function trustScoreForUser(userId) {
  const user = await db.get('SELECT created_at FROM users WHERE id = $1', [userId]);
  const counts = await db.get(
    `SELECT
       (SELECT COUNT(*) FROM bills WHERE user_id = $1 AND status = 'approved') AS approved,
       (SELECT COUNT(*) FROM bills WHERE user_id = $2 AND status = 'rejected') AS rejected,
       (SELECT COUNT(*) FROM verifications WHERE user_id = $3 AND status = 'approved') AS verified,
       (SELECT COUNT(*) FROM reports WHERE target_type = 'bill' AND target_id IN (SELECT id FROM bills WHERE user_id = $4)) AS reports,
       (SELECT COUNT(*) FROM gifts WHERE supporter_id = $5 AND status = 'confirmed') AS gifts_confirmed`,
    [userId, userId, userId, userId, userId]
  );
  const ageDays = user ? Math.floor((Date.now() - Date.parse(user.created_at)) / 86400000) : 0;
  let score = 50; // neutral start
  const factors = [];
  if (ageDays >= 30) { score += 10; factors.push('account 30+ days old'); }
  else if (ageDays >= 7) { score += 5; factors.push('account 7+ days old'); }
  else { factors.push('new account'); }
  const approved = Number(counts?.approved || 0);
  const verified = Number(counts?.verified || 0);
  const reports = Number(counts?.reports || 0);
  const rejected = Number(counts?.rejected || 0);
  const giftsConfirmed = Number(counts?.gifts_confirmed || 0);
  if (approved >= 3) { score += 15; factors.push('3+ approved bills'); }
  else if (approved >= 1) { score += 8; factors.push('approved bill history'); }
  if (verified >= 1) { score += 10; factors.push('verified badge'); }
  if (giftsConfirmed >= 1) { score += 5; factors.push('confirmed help given'); }
  if (reports >= 3) { score -= 25; factors.push('3+ reports against'); }
  else if (reports >= 1) { score -= 10; factors.push('reported before'); }
  if (rejected >= 2) { score -= 10; factors.push('2+ rejected bills'); }
  score = Math.max(0, Math.min(100, score));
  return { score, factors, ageDays, approved, verified, reports, rejected, giftsConfirmed };
}

module.exports = { SCAM_PHRASES, scanScamPhrases, findDuplicateBill, trustScoreForUser };
