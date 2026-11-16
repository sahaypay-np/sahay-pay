// Sahay Pay — gift-message blocklist (Phase 2, item 257).
// Gift messages are screened against this list before they are stored AND
// before they are shown to the recipient (defence in depth). Matching is
// case-insensitive, on word boundaries, so "class" does not trip on "ass".
// Keep the list short and unambiguous: clear abuse, slurs, and contact
// solicitation (phone numbers / links do not belong in a gift message —
// the helper and poster already have a dispute message flow for problems).
// No PII is logged: the matcher returns only whether a term matched.

'use strict';

// English + common romanised Nepali/Hindi abuse. Deliberately short: a
// false positive blocks a kind message, so only unambiguous terms belong.
const BLOCKED_TERMS = [
  // English profanity / slurs (unambiguous forms only).
  'fuck', 'shit', 'bitch', 'bastard', 'damn you', 'asshole', 'dickhead',
  'motherfucker', 'son of a bitch', 'kill yourself', 'kys',
  'nigger', 'nigga', 'chink', 'retard',
  // Romanised Nepali/Hindi abuse.
  'muji', 'randi', 'chutia', 'chutiya', 'bhosdike', 'bhenchod', 'behenchod',
  'madarchod', 'gandu', 'harami', 'kutta', 'kutti',
  // Contact solicitation / off-platform moves (gift messages must stay kind
  // notes, not a way to harvest contacts).
  'whatsapp me', 'call me at', 'my number is', 'message me on',
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary match: "hell" must not match "hello".
function containsBlockedTerm(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return false;
  for (const term of BLOCKED_TERMS) {
    const re = new RegExp(`(^|[^a-z])${escapeRegExp(term)}([^a-z]|$)`, 'i');
    if (re.test(s)) return true;
  }
  // Bare phone numbers / URLs are also blocked in gift messages.
  if (/\b\d{7,}\b/.test(s)) return true;
  if (/https?:\/\/|www\./i.test(s)) return true;
  return false;
}

module.exports = { BLOCKED_TERMS, containsBlockedTerm };
