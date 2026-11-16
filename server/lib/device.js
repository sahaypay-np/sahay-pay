// Sahay Pay — device/browser derivation from the stored user-agent.
// (Phase 2 items 801/805/806/810/818/855.)
// No IP address is ever stored, so there is no IP-derived location: device
// class + browser family, derived from the user-agent, is the no-IP
// equivalent. The browser family is also the session token-binding signal:
// a token presented from a different browser family than the one that
// created it is rejected (fail closed, items 806/818).
// The device fingerprint (SHA-256 of the full user-agent) is used ONLY for
// the per-device posting/account caps (item 855) — it is a coarse,
// privacy-preserving signal, not a stable device ID.

'use strict';

const crypto = require('crypto');

function browserFamily(ua) {
  const s = String(ua || '').toLowerCase();
  if (!s) return 'unknown';
  if (s.includes('curl/')) return 'curl';
  if (s.startsWith('node') || s.includes('node-fetch') || s.includes('undici')) return 'node';
  if (s.includes('edg/') || s.includes('edge/')) return 'edge';
  if (s.includes('opr/') || s.includes('opera')) return 'opera';
  if (s.includes('firefox/') || s.includes('fxios')) return 'firefox';
  if (s.includes('crios') || s.includes('chrome/') || s.includes('chromium')) return 'chrome';
  if (s.includes('safari/') || s.includes('version/')) return 'safari';
  if (s.includes('samsungbrowser')) return 'samsung';
  if (s.includes('bot') || s.includes('crawler') || s.includes('spider')) return 'bot';
  return 'other';
}

function deviceClass(ua) {
  const s = String(ua || '').toLowerCase();
  if (!s) return 'unknown';
  if (s.includes('ipad') || s.includes('tablet') || s.includes('sm-t')) return 'tablet';
  if (s.includes('mobile') || s.includes('android') || s.includes('iphone') || s.includes('phone')) return 'mobile';
  if (s.includes('curl') || s.startsWith('node') || s.includes('bot')) return 'other';
  return 'desktop';
}

function deviceLabel(ua) {
  const fam = browserFamily(ua);
  const cls = deviceClass(ua);
  if (fam === 'unknown' && cls === 'unknown') return 'Unknown device';
  const famName = {
    chrome: 'Chrome', firefox: 'Firefox', safari: 'Safari', edge: 'Edge',
    opera: 'Opera', samsung: 'Samsung Internet', curl: 'curl', node: 'Node',
    bot: 'Bot', other: 'Browser', unknown: 'Unknown browser',
  }[fam] || 'Browser';
  const clsName = { mobile: 'Mobile', desktop: 'Desktop', tablet: 'Tablet', other: '', unknown: '' }[cls] || '';
  return clsName ? `${famName} · ${clsName}` : famName;
}

// Binding hash: SHA-256 of the browser family only (not the full UA), so a
// browser version bump does not log the user out, but copying the token
// into a different browser family fails closed.
function familyHash(ua) {
  return crypto.createHash('sha256').update(`sahay-pay-ua-family:${browserFamily(ua)}`).digest('hex');
}

// Coarse per-device fingerprint for the item-855 caps (accounts + posts
// per device per day). Full-UA hash — no IP, no canvas, no stable ID.
function deviceFingerprint(ua) {
  return crypto.createHash('sha256').update(`sahay-pay-device:${String(ua || '')}`).digest('hex');
}

module.exports = { browserFamily, deviceClass, deviceLabel, familyHash, deviceFingerprint };
