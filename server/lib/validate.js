// Sahay Pay — shared input validation + payout-method validation.
// Payout rules are enforced on the server AND mirrored on the client:
//   eSewa / Khalti: 10-digit Nepali mobile, starts 97/98.
//   UPI ID (VPA): ^[\w.\-]{2,}@[a-zA-Z]{2,}$
//   Bank NP: bank name (2+ chars), account 5-20 digits, holder name.
//   Bank IN: account 9-18 digits, IFSC ^[A-Z]{4}0[A-Z0-9]{6}$, holder name.
//   connectIPS: bank name, account number, holder name.
//   Fonepay QR: QR image upload (reviewer-checked).
//   Payment link: HTTPS URL.
// Masked hints are generated server-side: last 4 only, never the full account.

'use strict';

const NEPALI_MOBILE = /^9[78]\d{8}$/;
const UPI_VPA = /^[\w.\-]{2,}@[a-zA-Z]{2,}$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const DIGITS = /^\d+$/;

function cleanStr(v, max = 1000) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

function isNonEmptyStr(v, max = 1000) {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
}

// Validate one payout method payload.
// Input shape: { method, holderName, account, bankName (alias: bank), branch, ifsc, qrUrl }
// Returns { ok: true, account, hint, meta } or { ok: false, error }.
// meta carries the non-account display fields (bank name, branch, IFSC) so the
// reveal step can show them alongside the decrypted account.
function validatePayoutMethod(input) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Payout method is required.' };
  const method = cleanStr(input.method, 32);
  const holderName = cleanStr(input.holderName, 120);
  const account = cleanStr(input.account, 64);
  const bankName = cleanStr(input.bankName || input.bank, 120);
  const branch = cleanStr(input.branch, 120);
  const ifsc = cleanStr(input.ifsc, 16).toUpperCase();
  const qrUrl = cleanStr(input.qrUrl, 500);

  const needHolder = () => {
    if (!holderName || holderName.length < 2) {
      return { ok: false, error: 'Account holder name is required (2+ characters).' };
    }
    return null;
  };

  switch (method) {
    case 'esewa':
    case 'khalti': {
      const label = method === 'esewa' ? 'eSewa' : 'Khalti';
      const holderErr = needHolder();
      if (holderErr) return holderErr;
      if (!NEPALI_MOBILE.test(account)) {
        return {
          ok: false,
          error: `That doesn't look like a ${label} number — it should be the 10-digit mobile number your ${label} account is registered with, starting 97 or 98.`,
        };
      }
      return { ok: true, account, hint: `${label} account ····${account.slice(-4)}` };
    }
    case 'upi': {
      const holderErr = needHolder();
      if (holderErr) return holderErr;
      if (!UPI_VPA.test(account)) {
        return { ok: false, error: 'That doesn\'t look like a UPI ID — it should look like name@bank (e.g. name@okhdfc).' };
      }
      const at = account.lastIndexOf('@');
      return { ok: true, account, hint: `UPI ····${account.slice(at)}` };
    }
    case 'bank_np': {
      const holderErr = needHolder();
      if (holderErr) return holderErr;
      if (!bankName || bankName.length < 2) return { ok: false, error: 'Bank name is required (2+ characters).' };
      if (!DIGITS.test(account) || account.length < 5 || account.length > 20) {
        return { ok: false, error: 'Bank account number must be 5–20 digits.' };
      }
      return { ok: true, account, hint: `Bank ····${account.slice(-4)} (${bankName})`, meta: { bankName, branch } };
    }
    case 'bank_in': {
      const holderErr = needHolder();
      if (holderErr) return holderErr;
      if (!DIGITS.test(account) || account.length < 9 || account.length > 18) {
        return { ok: false, error: 'Bank account number must be 9–18 digits.' };
      }
      if (!IFSC.test(ifsc)) {
        return { ok: false, error: 'That doesn\'t look like an IFSC code — it should look like HDFC0001234 (4 letters, 0, then 6 letters/digits).' };
      }
      return { ok: true, account: `${account}|${ifsc}`, hint: `Bank ····${account.slice(-4)} (IFSC ${ifsc})`, meta: { bankName, branch, ifsc } };
    }
    case 'connectips': {
      const holderErr = needHolder();
      if (holderErr) return holderErr;
      if (!bankName || bankName.length < 2) return { ok: false, error: 'Bank name is required (2+ characters).' };
      if (!DIGITS.test(account) || account.length < 5 || account.length > 20) {
        return { ok: false, error: 'Bank account number must be 5–20 digits.' };
      }
      return { ok: true, account, hint: `connectIPS ····${account.slice(-4)} (${bankName})`, meta: { bankName, branch } };
    }
    case 'fonepay_qr': {
      const holderErr = needHolder();
      if (holderErr) return holderErr;
      if (!qrUrl) return { ok: false, error: 'Please upload your own Fonepay QR image.' };
      return { ok: true, account: qrUrl, hint: 'Fonepay QR (reviewer-checked)' };
    }
    case 'payment_link': {
      const holderErr = needHolder();
      if (holderErr) return holderErr;
      if (!/^https:\/\/[^\s/$.?#].[^\s]*$/i.test(account)) {
        return { ok: false, error: 'Payment link must be a full https:// URL.' };
      }
      let host = '';
      try { host = new URL(account).hostname; } catch { return { ok: false, error: 'Payment link must be a valid https:// URL.' }; }
      return { ok: true, account, hint: `Payment link (${host})` };
    }
    default:
      return { ok: false, error: `Unknown payout method: ${method || '(none)'}.` };
  }
}

const METHODS_BY_COUNTRY = {
  NP: ['esewa', 'khalti', 'connectips', 'bank_np', 'fonepay_qr'],
  IN: ['upi', 'bank_in', 'payment_link'],
};

function methodAllowedForCountry(method, country) {
  const list = METHODS_BY_COUNTRY[country];
  return Boolean(list && list.includes(method));
}

// Onboarding field validation. Returns an error string or null.
function validateOnboarding(body) {
  const displayName = cleanStr(body.displayName, 60);
  if (displayName.length < 2) return 'Please tell us what we should call you (2–60 characters).';
  const age = Number(body.age);
  if (!Number.isInteger(age) || age < 1 || age > 120) return 'Please enter your age in years.';
  if (!['NP', 'IN'].includes(body.country)) return 'Please choose Nepal or India.';
  const city = cleanStr(body.city, 120);
  if (city.length < 2) return 'Please tell us where you live (city).';
  if (body.about !== undefined && typeof body.about !== 'string') return 'About me must be text.';
  if (body.about && body.about.length > 500) return 'About me must be 500 characters or fewer.';
  if (body.language !== undefined && !['en', 'ne', 'hi'].includes(body.language)) {
    return 'Language must be English, Nepali or Hindi.';
  }
  // Two SEPARATE consents (checklist items 402/404): Terms and Privacy
  // Policy are accepted independently and version-logged at onboarding.
  if (body.termsAccepted !== true) return 'Please agree to the Terms to create a profile.';
  if (body.privacyAccepted !== true) return 'Please agree to the Privacy Policy to create a profile.';
  return null;
}

module.exports = {
  cleanStr,
  isNonEmptyStr,
  validatePayoutMethod,
  methodAllowedForCountry,
  METHODS_BY_COUNTRY,
  validateOnboarding,
  NEPALI_MOBILE,
  UPI_VPA,
  IFSC,
};
