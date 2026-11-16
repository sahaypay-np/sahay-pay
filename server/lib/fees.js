// Sahay Pay — fee engine.
// feeMode comes from settings: 'supporter_fee' (ACTIVE by default) or
// 'zero_fee_plus_tip' (staged; the owner flips it in Admin).
// supporter_fee: flat fee up to a threshold, then a percentage, with a minimum.
// Charity: fee 0 always. In zero_fee_plus_tip mode the fee is always 0 and
// the founder tip is a separate, optional, supporter-chosen amount.
// Money is integer minor units (paisa).

'use strict';

function quote(amountMinor, currency, charity, feeMode, feeConfig) {
  const amount = Math.max(0, Math.floor(Number(amountMinor) || 0));
  if (charity || feeMode === 'zero_fee_plus_tip') {
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

module.exports = { quote, feeModelSentence };
