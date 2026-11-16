// Sahay Pay — sensitive-number detection in TEXT (Phase 2 items 866/867,
// no-OCR interpretation).
// The triaged items asked for client-side OCR (tesseract.js) on bill
// photos. That was descoped — tesseract.js is far too heavy for this
// free-tier SPA (see the item-134 descope in sections 1–3). The no-OCR
// form implemented here: pattern-based detection of number-like strings
// in TEXT fields (bill title/story/details, complaint body), plus the
// manual-redaction guidance/reminder in the post flow (the canvas blur
// tool already exists there; item 868 adds the detection-driven warning).
// Detected numbers are NEVER stored or echoed in full — only a masked
// form (first 2 + last 2) reaches the response/audit log.

'use strict';

function luhnValid(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function maskNumber(digits) {
  if (digits.length <= 4) return '••••';
  return `${digits.slice(0, 2)}••••${digits.slice(-2)}`;
}

// Scan text for number-like strings that look like sensitive identifiers.
// Returns [{ type, masked, length }]. Types: card, bank_account, phone,
// citizenship (Nepal), id_number (generic long run).
function findSensitiveNumbers(text) {
  const found = [];
  const seen = new Set();
  const s = String(text || '');
  const push = (type, digits) => {
    const key = `${type}:${digits}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ type, masked: maskNumber(digits), length: digits.length });
  };
  // Digit runs (spaces/dashes inside are tolerated, e.g. card numbers).
  const runs = s.match(/\d[\d\s-]{7,24}\d/g) || [];
  for (const run of runs) {
    const digits = run.replace(/[\s-]/g, '');
    if (digits.length < 9) continue;
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      push('card', digits);
      continue;
    }
    if (/^9[78]\d{8}$/.test(digits)) { push('phone', digits); continue; }
    if (digits.length >= 9 && digits.length <= 18) { push('bank_account', digits); continue; }
    if (digits.length > 18) { push('id_number', digits); continue; }
  }
  // Nepali citizenship number shape: 12-34-56-78901 style.
  const citizen = s.match(/\b\d{1,3}-\d{1,3}-\d{1,3}-\d{4,6}\b/g) || [];
  for (const c of citizen) push('citizenship', c.replace(/-/g, ''));
  // UPI-style ids and emails in bill text are also sensitive-ish.
  const upi = s.match(/[\w.\-]{2,}@[a-zA-Z]{2,}/g) || [];
  for (const u of upi) {
    if (!seen.has(`upi:${u}`)) {
      seen.add(`upi:${u}`);
      found.push({ type: 'upi_or_email', masked: `${u.slice(0, 2)}••••@${u.split('@')[1] || ''}`, length: u.length });
    }
  }
  return found;
}

// Client-mirrorable check (same patterns, used by the frontend warning).
// The frontend duplicates the digit-run scan in plain JS; this export is
// the server's copy of record.
module.exports = { findSensitiveNumbers, luhnValid, maskNumber };
