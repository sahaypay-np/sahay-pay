// Sahay Pay — simple in-app challenge question (Phase 2 item 847).
// Replaces the checkbox-only confirmation before a payout reveal. No
// CAPTCHA vendor, no third party: a small arithmetic question, stateless.
// The challenge id is HMAC-signed (SESSION_SECRET) so the server never
// stores challenges: id = base64url(giftId "." expiryMs "." a "." b "." hmac).
// Valid 10 minutes, single gift, single answer.

'use strict';

const crypto = require('crypto');

const CHALLENGE_TTL_MS = 10 * 60 * 1000;

function challengeSecret() {
  // SESSION_SECRET is the install secret; without it the challenge still
  // works (ephemeral key) but cannot survive a restart — acceptable for a
  // 10-minute challenge, and the server already warns loudly about the
  // missing secret at boot.
  if (!challengeSecret._key) {
    challengeSecret._key = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
  }
  return challengeSecret._key;
}

function newChallenge(giftId) {
  const a = 2 + Math.floor(Math.random() * 8);
  const b = 2 + Math.floor(Math.random() * 8);
  const expiry = Date.now() + CHALLENGE_TTL_MS;
  const payload = `${giftId}.${expiry}.${a}.${b}`;
  const sig = crypto.createHmac('sha256', challengeSecret()).update(payload).digest('hex').slice(0, 32);
  return {
    challengeId: Buffer.from(`${payload}.${sig}`).toString('base64url'),
    question: `What is ${a} + ${b}?`,
    expiresInSec: Math.floor(CHALLENGE_TTL_MS / 1000),
  };
}

function verifyChallenge(challengeId, giftId, answer) {
  try {
    const decoded = Buffer.from(String(challengeId || ''), 'base64url').toString('utf8');
    const [cid, expiry, a, b, sig] = decoded.split('.');
    if (cid !== giftId) return false;
    if (Number(expiry) < Date.now()) return false;
    const payload = `${cid}.${expiry}.${a}.${b}`;
    const expected = crypto.createHmac('sha256', challengeSecret()).update(payload).digest('hex').slice(0, 32);
    const sigBuf = Buffer.from(sig || '');
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;
    return Number(answer) === Number(a) + Number(b);
  } catch {
    return false;
  }
}

module.exports = { newChallenge, verifyChallenge, CHALLENGE_TTL_MS };
