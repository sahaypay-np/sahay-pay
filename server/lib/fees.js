// Sahay Pay — fee engine.
// feeMode comes from settings: 'supporter_fee' (ACTIVE by default) or
// 'zero_fee_plus_tip' (staged; the owner flips it in Admin).
// supporter_fee: flat fee up to a threshold, then a percentage, with a minimum.
// Charity: fee 0 always. In zero_fee_plus_tip mode the fee is always 0 and
// the founder tip is a separate, optional, supporter-chosen amount.
// Phase 2 (item 217): the admin can also mark whole bill CATEGORIES
// fee-free (e.g. Charity); those bills quote a zero fee like charity asks.
// Money is integer minor units (paisa).

'use strict';

// Is this bill fee-exempt? Charity asks always are; otherwise the bill's
// category may be on the admin's fee-free list (setting
// charity_fee_free_categories, a JSON array of category names).
function isFeeExempt(charity, category, charityFreeCategories) {
  if (charity) return true;
  if (!category || !Array.isArray(charityFreeCategories)) return false;
  return charityFreeCategories.includes(category);
}

// Why is the fee zero (for the sheet's "No fee" label, item 218)?
// Returns 'charity' | 'category' | 'zero_fee_mode' | null.
function feeExemptReason(charity, category, charityFreeCategories, feeMode) {
  if (feeMode === 'zero_fee_plus_tip') return 'zero_fee_mode';
  if (charity) return 'charity';
  if (category && Array.isArray(charityFreeCategories) && charityFreeCategories.includes(category)) {
    return 'category';
  }
  return null;
}

function quote(amountMinor, currency, charity, feeMode, feeConfig, feeExempt) {
  const amount = Math.max(0, Math.floor(Number(amountMinor) || 0));
  if (charity || feeExempt || feeMode === 'zero_fee_plus_tip') {
    return { feeMinor: 0, totalMinor: amount, feeMode: feeMode || 'supporter_fee' };
  }
  const cfg = (feeConfig && feeConfig[currency]) || feeConfig?.NPR;
  if (!cfg) return { feeMinor: 0, totalMinor: amount, feeMode };
  let fee;
  if (amount <= cfg.thresholdMinor) {
    fee = cfg.flatMinor;
  } else {
    fee = Math.round((amount * cfg.percent) / 100);
  }
  fee = Math.max(fee, cfg.minMinor);
  return { feeMinor: fee, totalMinor: amount + fee, feeMode };
}

// One-sentence statement of the live money model (shown on pay screens).
function feeModelSentence(feeMode, feeConfig, currency) {
  if (feeMode === 'zero_fee_plus_tip') {
    return 'Sahay Pay takes no cut of your help — an optional founder tip is your choice, default No thanks.';
  }
  const cfg = (feeConfig && feeConfig[currency]) || feeConfig?.NPR;
  if (!cfg) return 'Sahay Pay fee: see the Check step for the exact amount.';
  const sym = currency === 'INR' ? '₹' : 'रू';
  const flat = cfg.flatMinor / 100;
  const threshold = cfg.thresholdMinor / 100;
  return `Sahay Pay fee: ${sym}${flat} flat up to ${sym}${threshold}, then ${cfg.percent}% (minimum ${sym}${flat}); charity asks are free.`;
}

module.exports = { quote, feeModelSentence, isFeeExempt, feeExemptReason };
