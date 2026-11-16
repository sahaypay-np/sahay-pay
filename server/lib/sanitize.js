// Sahay Pay — error/log sanitizer (Phase 2 item 836).
// Payout details must never appear in an error report or crash log. This
// helper redacts digit runs (9–19 digits, the account/card range),
// UPI-style ids, and IFSC-shaped codes from any string before it is
// logged or returned in an error body. There is no crash-log service in
// this product — the sanitizer covers console error output + the central
// error handler's messages.

'use strict';

function sanitizeText(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  // Long digit runs (spaces/dashes tolerated): 9–19 digits.
  out = out.replace(/\b\d[\d\s-]{7,23}\d\b/g, (m) => {
    const digits = m.replace(/[\s-]/g, '');
    if (digits.length >= 9 && digits.length <= 19) return '[redacted-number]';
    return m;
  });
  // UPI ids / emails.
  out = out.replace(/[\w.\-]{2,}@[a-zA-Z]{2,}/g, '[redacted-id]');
  // IFSC codes.
  out = out.replace(/\b[A-Z]{4}0[A-Z0-9]{6}\b/g, '[redacted-ifsc]');
  return out;
}

module.exports = { sanitizeText };
