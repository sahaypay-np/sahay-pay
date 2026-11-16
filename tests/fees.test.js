// Sahay Pay — fee-engine unit tests (Phase 2, item 220).
// Run: node --test tests/fees.test.js
// Covers both currencies, tier boundaries, minimums, charity exemption,
// per-category fee-free (item 217), and zero-fee-plus-tip mode.
// The live fee model (owner's decision, never change here without his
// word): NPR flat 160 up to 1,600 then 10%, min 160; INR flat 100 up to
// 1,000 then 10%, min 100; charity asks free.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { quote, feeModelSentence, isFeeExempt, feeExemptReason } = require('../server/lib/fees');

const FEE_CONFIG = {
  NPR: { flatMinor: 16000, thresholdMinor: 160000, percent: 10, minMinor: 16000 },
  INR: { flatMinor: 10000, thresholdMinor: 100000, percent: 10, minMinor: 10000 },
};

test('NPR flat fee at and below the threshold', () => {
  assert.equal(quote(10000, 'NPR', false, 'supporter_fee', FEE_CONFIG).feeMinor, 16000);
  assert.equal(quote(160000, 'NPR', false, 'supporter_fee', FEE_CONFIG).feeMinor, 16000);
});

test('NPR percentage fee above the threshold', () => {
  // 2,000 NPR -> 10% = 200 NPR.
  const q = quote(200000, 'NPR', false, 'supporter_fee', FEE_CONFIG);
  assert.equal(q.feeMinor, 20000);
  assert.equal(q.totalMinor, 220000);
});

test('NPR tier boundary: one paisa above the threshold switches to percent', () => {
  // 1,600.01 NPR -> 10% = 160.001 -> rounds to 160.00... min 160 applies.
  const q = quote(160001, 'NPR', false, 'supporter_fee', FEE_CONFIG);
  assert.equal(q.feeMinor, 16000);
  // 1,601 NPR -> 10% = 160.10.
  assert.equal(quote(160100, 'NPR', false, 'supporter_fee', FEE_CONFIG).feeMinor, 16010);
});

test('INR flat fee at and below the threshold', () => {
  assert.equal(quote(5000, 'INR', false, 'supporter_fee', FEE_CONFIG).feeMinor, 10000);
  assert.equal(quote(100000, 'INR', false, 'supporter_fee', FEE_CONFIG).feeMinor, 10000);
});

test('INR percentage fee above the threshold', () => {
  const q = quote(150000, 'INR', false, 'supporter_fee', FEE_CONFIG);
  assert.equal(q.feeMinor, 15000);
  assert.equal(q.totalMinor, 165000);
});

test('INR tier boundary: one paisa above the threshold switches to percent', () => {
  assert.equal(quote(100001, 'INR', false, 'supporter_fee', FEE_CONFIG).feeMinor, 10000);
  assert.equal(quote(100100, 'INR', false, 'supporter_fee', FEE_CONFIG).feeMinor, 10010);
});

test('minimum fee applies when the percentage would be smaller', () => {
  // A config where percent-of-amount < min: 10% of 1,100 = 110 < 160 min.
  const cfg = { NPR: { flatMinor: 16000, thresholdMinor: 100000, percent: 10, minMinor: 16000 } };
  assert.equal(quote(110000, 'NPR', false, 'supporter_fee', cfg).feeMinor, 16000);
});

test('charity asks are always fee-free', () => {
  assert.equal(quote(500000, 'NPR', true, 'supporter_fee', FEE_CONFIG).feeMinor, 0);
  assert.equal(quote(500000, 'INR', true, 'supporter_fee', FEE_CONFIG).feeMinor, 0);
  const q = quote(500000, 'NPR', true, 'supporter_fee', FEE_CONFIG);
  assert.equal(q.totalMinor, 500000);
});

test('zero-fee-plus-tip mode is always fee-free', () => {
  assert.equal(quote(500000, 'NPR', false, 'zero_fee_plus_tip', FEE_CONFIG).feeMinor, 0);
  assert.equal(quote(500000, 'INR', false, 'zero_fee_plus_tip', FEE_CONFIG).feeMinor, 0);
});

test('per-category fee-free (item 217)', () => {
  assert.equal(isFeeExempt(false, 'Charity', ['Charity', 'Education']), true);
  assert.equal(isFeeExempt(false, 'Rent', ['Charity', 'Education']), false);
  assert.equal(isFeeExempt(true, 'Rent', []), true);
  assert.equal(isFeeExempt(false, 'Rent', []), false);
  assert.equal(quote(500000, 'NPR', false, 'supporter_fee', FEE_CONFIG, true).feeMinor, 0);
  assert.equal(feeExemptReason(false, 'Charity', ['Charity'], 'supporter_fee'), 'category');
  assert.equal(feeExemptReason(true, 'Rent', [], 'supporter_fee'), 'charity');
  assert.equal(feeExemptReason(false, 'Rent', [], 'zero_fee_plus_tip'), 'zero_fee_mode');
  assert.equal(feeExemptReason(false, 'Rent', [], 'supporter_fee'), null);
});

test('fee model sentence renders the exact rule text (items 212/213)', () => {
  const npr = feeModelSentence('supporter_fee', FEE_CONFIG, 'NPR');
  assert.match(npr, /रू160 flat up to रू1600, then 10% \(minimum रू160\)/);
  const inr = feeModelSentence('supporter_fee', FEE_CONFIG, 'INR');
  assert.match(inr, /₹100 flat up to ₹1000, then 10% \(minimum ₹100\)/);
  assert.match(feeModelSentence('zero_fee_plus_tip', FEE_CONFIG, 'NPR'), /no cut/);
});

test('zero/invalid amounts never produce a negative total', () => {
  // The server validates amounts before quoting, so these paths only
  // matter for robustness: amount clamps to 0, fee stays the flat fee.
  assert.equal(quote(0, 'NPR', false, 'supporter_fee', FEE_CONFIG).feeMinor, 16000);
  assert.equal(quote(-500, 'NPR', false, 'supporter_fee', FEE_CONFIG).totalMinor, 16000);
  assert.equal(quote('abc', 'NPR', false, 'supporter_fee', FEE_CONFIG).totalMinor, 16000);
});

test('missing fee config quotes zero rather than crashing', () => {
  assert.equal(quote(100000, 'NPR', false, 'supporter_fee', {}).feeMinor, 0);
  assert.equal(quote(100000, 'NPR', false, 'supporter_fee', null).feeMinor, 0);
});
