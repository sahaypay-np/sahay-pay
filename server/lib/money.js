// Sahay Pay — money helpers. All money is integer minor units (paisa).
// Never floats. NPR uses रू, INR uses ₹. Always show money with currency.

'use strict';

const SYMBOLS = { NPR: 'रू', INR: '₹' };

function symbol(currency) {
  return SYMBOLS[currency] || currency || '';
}

// 160000 minor NPR -> "रू 1,600"
function formatMinor(minor, currency) {
  const n = Number(minor) || 0;
  const major = Math.floor(n / 100);
  const paisa = n % 100;
  const majorStr = major.toLocaleString('en-IN');
  const s = paisa ? `${majorStr}.${String(paisa).padStart(2, '0')}` : majorStr;
  return `${symbol(currency)} ${s}`;
}

// Parse a user-typed major-unit amount ("1600", "1,600.50") into minor units.
// Returns null when invalid. Rejects negatives, zero, NaN, > 2 decimals.
function parseMajorToMinor(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) return null;
    return Math.round(input * 100);
  }
  if (typeof input !== 'string') return null;
  const clean = input.replace(/[,₹रू\s]/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const [whole, frac = ''] = clean.split('.');
  const minor = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(minor) || minor <= 0) return null;
  return minor;
}

function isMinorAmount(v) {
  return Number.isSafeInteger(v) && v > 0;
}

module.exports = { formatMinor, parseMajorToMinor, isMinorAmount, symbol };
