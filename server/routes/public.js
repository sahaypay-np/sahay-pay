// Sahay Pay — public routes (no auth required).
// GET /api/config, GET /api/feed, GET /api/leaders.
// Feed: approved bills only, never own bills, never already-seen ids.
// Ranking (Recommended): verified boost + same-country boost + recency boost +
// fewer-supporters boost + new-poster fairness boost. Honest empty states.

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { feeModelSentence } = require('../lib/fees');
const { TERMS_VERSION, PRIVACY_VERSION, POLICY_EFFECTIVE_DATE } = require('../lib/policy');
const { CITIES, findCity, haversineKm } = require('../lib/cities');
const { askTypeOf, expiryOf, isExpired } = require('./bills');
const { tierForCount, computeStreak, listAchievements, weekKeyOf } = require('../lib/achievements');

const router = express.Router();

const CROSS_BORDER_NOTE = [
  'Cross-border help: India → Nepal help can use the UPI–NPI link where your bank/app supports it, up to INR 200,000 per transfer.',
  'Nepal → India help is limited (INR 15,000 per transfer, INR 100,000 per month, only Indian citizens with accounts at participating Nepali banks).',
  'Cross-border help must follow your local laws, including India\'s foreign-contribution rules — a non-Indian citizen should check before helping an Indian bill.',
  'Sahay Pay never holds or moves money — you always send directly in your own licensed app.',
  'General information only — not legal advice.',
].join(' ');

router.get('/config', async (req, res, next) => {
  try {
    // Parallel: these 11 settings reads are independent, and each is a
    // ~200ms round trip to Supabase from the serverless function — run
    // sequentially, /config cost ~1.9s even warm (measured 2026-11-16).
    const [feeModeRaw, feeConfig, brandPackages, founderTipConfig, paymentMethods, categories, minGiftRaw, minNprRaw, minInrRaw, giftChips, charityFreeCategories] =
      await Promise.all([
        db.getSetting('fee_mode'),
        db.getSettingJson('fee_config', {}),
        db.getSettingJson('brand_packages', []),
        db.getSettingJson('founder_tip_config', {}),
        db.getSettingJson('payment_methods', {}),
        db.getSettingJson('categories', []),
        db.getSetting('min_gift_minor'),
        db.getSetting('min_gift_minor_npr'),
        db.getSetting('min_gift_minor_inr'),
        db.getSettingJson('gift_chips', null),
        db.getSettingJson('charity_fee_free_categories', []),
      ]);
    const feeMode = feeModeRaw || 'supporter_fee';
    const minGiftMinor = Number(minGiftRaw) || 1000;
    // Phase 2 public settings: fraud banner (974), security status (886),
    // known scams (976), emergency freeze state (883).
    const [fraudBanner, securityStatus, knownScams, freezeOn] = await Promise.all([
      db.getSettingJson('fraud_banner', { active: false, message: '' }),
      db.getSettingJson('security_status', { status: 'normal', message: '', incidents: [] }),
      db.getSettingJson('known_scams', []),
      db.getSetting('emergency_freeze'),
    ]);
    const defaultChips = { NPR: [10000, 25000, 50000, 100000], INR: [10000, 25000, 50000, 100000] };
    // Item 791: whether the owner is available (owner-set; default false —
    // the honest default is "not available" until the owner says otherwise).
    const adminAvailable = (await db.getSetting('admin_available')) === 'true';
    // Item 748 (funnel): an anonymous daily visitor counter, incremented
    // on each /config hit — the first request a visit makes. Fire-and-
    // forget: a failure must never slow or break /config. No identity is
    // tracked — only a daily total in settings.
    const todayKey = `visits_${new Date().toISOString().slice(0, 10)}`;
    db.getSetting(todayKey)
      .then((v) => db.setSetting(todayKey, String((Number(v) || 0) + 1)))
      .catch(() => {});
    res.json({
      appName: 'Sahay Pay',
      tagline: 'Small acts. Real help.',
      demoMode: true,
      adminAvailable,
      feeMode,
      feeConfig,
      feeModelSentenceNPR: feeModelSentence(feeMode, feeConfig, 'NPR'),
      feeModelSentenceINR: feeModelSentence(feeMode, feeConfig, 'INR'),
      brandPackages,
      founderTipConfig,
      paymentMethods,
      categories,
      minGiftMinor,
      minGiftMinorNPR: Number(minNprRaw) || minGiftMinor,
      minGiftMinorINR: Number(minInrRaw) || minGiftMinor,
      charityFeeFreeCategories: Array.isArray(charityFreeCategories) ? charityFreeCategories : [],
      cities: CITIES,
      policyVersion: { terms: TERMS_VERSION, privacy: PRIVACY_VERSION, effective: POLICY_EFFECTIVE_DATE },
      crossBorderNote: CROSS_BORDER_NOTE,
      giftAmountChips: (giftChips && giftChips.NPR && giftChips.INR) ? giftChips : defaultChips,
      fraudBanner: fraudBanner && fraudBanner.active ? fraudBanner : null,
      securityStatus,
      knownScams: Array.isArray(knownScams) ? knownScams : [],
      emergencyFreeze: freezeOn === '1',
    });
  } catch (err) {
    next(err);
  }
});

// --- Public stats (items 964/965): live totals for the fact sheet +
// transparency page. Aggregates only — no personal data, no per-user rows.

router.get('/stats', async (req, res, next) => {
  try {
    const q = async (sql, params = []) => (await db.get(sql, params)) || {};
    const billsPosted = await q('SELECT COUNT(*) AS c FROM bills');
    const billsApproved = await q(`SELECT COUNT(*) AS c FROM bills WHERE status IN ('approved', 'completed')`);
    const billsCompleted = await q(`SELECT COUNT(*) AS c FROM bills WHERE status = 'completed'`);
    const giftsConfirmed = await q(`SELECT COUNT(*) AS c FROM gifts WHERE status = 'confirmed'`);
    const volume = await db.query(
      `SELECT currency, COALESCE(SUM(amount_minor),0) AS total FROM gifts WHERE status = 'confirmed' GROUP BY currency`
    );
    const complaintsResolved = await q(`SELECT COUNT(*) AS c FROM complaints WHERE status = 'resolved'`);
    const complaintsTotal = await q('SELECT COUNT(*) AS c FROM complaints');
    const users = await q('SELECT COUNT(*) AS c FROM users');
    const published = await db.getSettingJson('transparency_reports', {});
    const months = Object.keys(published).sort().reverse();
    res.json({
      billsPosted: Number(billsPosted.c || 0),
      billsApproved: Number(billsApproved.c || 0),
      billsCompleted: Number(billsCompleted.c || 0),
      giftsConfirmed: Number(giftsConfirmed.c || 0),
      confirmedVolume: volume.rows.map((r) => ({ currency: r.currency, totalMinor: Number(r.total) })),
      complaintsResolved: Number(complaintsResolved.c || 0),
      complaintsTotal: Number(complaintsTotal.c || 0),
      users: Number(users.c || 0),
      latestTransparencyReport: months.length ? published[months[0]] : null,
      demoMode: true,
    });
  } catch (err) {
    next(err);
  }
});

// --- Public changelog (item 967): the repo CHANGELOG.md as text ---

router.get('/changelog', async (req, res, next) => {
  try {
    const file = path.join(__dirname, '..', '..', 'CHANGELOG.md');
    const text = fs.readFileSync(file, 'utf8');
    res.json({ changelog: text });
  } catch (err) {
    next(err);
  }
});

// --- Feed ---

const AMOUNT_BANDS = {
  small: [0, 500000], // up to NPR/INR 5,000
  medium: [500001, 2500000],
  large: [2500001, 10000000],
  huge: [10000001, 50000000],
  humongous: [50000001, Infinity], // phase 2 (item 28): Humongous split
};

function parseCursor(cursor) {
  if (!cursor) return 0;
  try {
    const obj = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    return Number.isInteger(obj.offset) && obj.offset >= 0 ? obj.offset : 0;
  } catch {
    return 0;
  }
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ offset })).toString('base64url');
}

// Ranking factors, each with a stable key used for the "why am I seeing
// this" note (item 16) and the ranking explainer (item 62).
function scoreBill(bill, viewerCountry, viewerCity, nowMs) {
  const factors = [];
  if (bill.verifiedCount > 0) factors.push(['verified', 40]);
  if (viewerCountry && bill.country === viewerCountry) factors.push(['same_country', 25]);
  if (viewerCity && bill.city && bill.city.toLowerCase() === viewerCity.toLowerCase()) {
    factors.push(['same_city', 15]); // item 44
  }
  const ageHours = (nowMs - new Date(bill.created_at).getTime()) / 3600000;
  if (ageHours < 24) factors.push(['recent', 20]);
  else if (ageHours < 72) factors.push(['recent', 10]);
  else if (ageHours < 168) factors.push(['recent', 5]);
  if (bill.supporterCount === 0) factors.push(['few_supporters', 15]);
  else if (bill.supporterCount < 3) factors.push(['few_supporters', 8]);
  if (bill.posterApprovedCount <= 1) factors.push(['new_poster', 10]);
  // Staleness boost (item 60): old + barely seen bills get a second chance.
  // No per-view timestamps exist, so approximate from age + low view count.
  if (ageHours >= 168 && (bill.views || 0) < 5) factors.push(['stale', 10]);
  let score = 0;
  let top = null;
  for (const [key, pts] of factors) {
    score += pts;
    if (!top || pts > top.pts) top = { key, pts };
  }
  return { score, topFactor: top ? top.key : 'recent' };
}

// --- Typo-tolerant search (item 74) ---
function normText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function editDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = [];
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let up = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, up + (a[i - 1] === b[j - 1] ? 0 : 1));
      up = tmp;
    }
  }
  return prev[b.length];
}

// Every query token must match some haystack token: substring, or (for
// tokens of 4+ chars) within edit distance 2.
function matchesSearch(haystackTokens, queryTokens) {
  return queryTokens.every((q) => haystackTokens.some((h) =>
    h.includes(q) || (q.length >= 4 && h.length >= 4 && editDistance(q, h) <= 2)
  ));
}

// Ranking post-pass (items 59 + 64): at most one bill per poster in the
// top 10, and no category fills more than half of the first 20 cards.
// Stable: only demotes a card to the first later slot that keeps the rules.
function applyRankingRules(bills) {
  const out = [];
  const deferred = [];
  const posterInTop10 = new Set();
  const catInFirst20 = new Map();
  for (const b of bills) {
    const pos = out.length;
    const posterKey = b.posterId || b.poster?.username || b.id;
    const catCount = catInFirst20.get(b.category) || 0;
    const breaksRotation = pos < 10 && posterInTop10.has(posterKey);
    const breaksCap = pos < 20 && catCount >= 10;
    if (breaksRotation || breaksCap) {
      deferred.push(b);
      continue;
    }
    out.push(b);
    if (pos < 10) posterInTop10.add(posterKey);
    if (pos < 20) catInFirst20.set(b.category, catCount + 1);
  }
  return out.concat(deferred);
}

router.get('/feed', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const offset = parseCursor(req.query.cursor);
    const sort = ['recommended', 'newest', 'almost_funded', 'most_supported', 'fewest_supported', 'largest', 'smallest', 'needs_most'].includes(req.query.sort)
      ? req.query.sort
      : 'recommended';
    const viewerCountry = req.user?.country || (['NP', 'IN'].includes(req.query.country) ? req.query.country : null);
    const viewerCity = req.user?.city || (typeof req.query.homeCity === 'string' ? req.query.homeCity.trim() : '');
    const filterCountry = ['NP', 'IN'].includes(req.query.country) ? req.query.country : null;
    const categories = typeof req.query.category === 'string'
      ? req.query.category.split(',').map((c) => c.trim()).filter(Boolean)
      : [];
    const band = AMOUNT_BANDS[req.query.amountBand || req.query.band];
    const amountMin = Number(req.query.amountMin) > 0 ? Math.floor(Number(req.query.amountMin)) : null;
    const amountMax = Number(req.query.amountMax) > 0 ? Math.floor(Number(req.query.amountMax)) : null;
    const verifiedOnly = req.query.verified === '1' || req.query.verified === 'true';
    const idVerifiedOnly = req.query.idVerified === '1' || req.query.id_verified === '1';
    const nameVerifiedOnly = req.query.nameVerified === '1' || req.query.name_verified === '1';
    const verifiedFirst = req.query.verifiedFirst === '1' || req.query.verified_first === '1';
    const payDirectOnly = req.query.payDirect === '1' || req.query.payDirect === 'true'
      || req.query.pay_direct === '1' || req.query.pay_direct === 'true';
    const charityOnly = req.query.charity === '1' || req.query.charity === 'true';
    const askType = ['bill', 'dream', 'business', 'charity'].includes(req.query.askType) ? req.query.askType : null;
    const billShownOnly = req.query.billShown === '1' || req.query.billShown === 'true'
      || req.query.bill_shown === '1' || req.query.bill_shown === 'true';
    const includeCompleted = req.query.includeCompleted === '1' || req.query.include_completed === '1';
    const fundedOnly = req.query.fundedOnly === '1' || req.query.funded_only === '1';
    const cityFilter = typeof req.query.city === 'string' ? req.query.city.trim() : '';
    const nearCity = typeof req.query.near === 'string' ? req.query.near.trim() : '';
    const radiusKm = Math.min(Math.max(Number(req.query.radiusKm) || 50, 5), 1000);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const posted = req.query.posted; // today|week|month
    const seen = typeof req.query.seen === 'string'
      ? req.query.seen.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 500)
      : [];

    // Approved bills only (plus completed when asked — item 27). Build the
    // WHERE clause with parameters.
    const params = [];
    let where = fundedOnly
      ? `b.status = 'completed'`
      : includeCompleted
        ? `(b.status = 'approved' OR b.status = 'completed')`
        : `b.status = 'approved'`;
    if (filterCountry) { params.push(filterCountry); where += ` AND b.country = $${params.length}`; }
    if (categories.length) {
      const ph = categories.map((c) => { params.push(c); return `$${params.length}`; }).join(',');
      where += ` AND b.category IN (${ph})`;
    }
    if (band) {
      params.push(band[0]); where += ` AND b.amount_minor >= $${params.length}`;
      if (Number.isFinite(band[1])) { params.push(band[1]); where += ` AND b.amount_minor <= $${params.length}`; }
    }
    if (amountMin !== null) { params.push(amountMin); where += ` AND b.amount_minor >= $${params.length}`; }
    if (amountMax !== null) { params.push(amountMax); where += ` AND b.amount_minor <= $${params.length}`; }
    if (askType === 'charity') where += ' AND b.charity = 1';
    else if (askType === 'business') where += ' AND b.business = 1';
    else if (askType === 'dream') where += ' AND b.dream = 1';
    else if (askType === 'bill') where += ' AND b.charity = 0 AND b.business = 0 AND b.dream = 0';
    if (payDirectOnly) where += ' AND b.pay_direct = 1';
    if (charityOnly) where += ' AND b.charity = 1';
    if (billShownOnly) where += ' AND b.photo_url IS NOT NULL';
    if (cityFilter) {
      params.push(`%${cityFilter.toLowerCase()}%`);
      where += ` AND LOWER(b.city) LIKE $${params.length}`;
    }
    if (posted === 'today' || posted === 'week' || posted === 'month') {
      const hours = posted === 'today' ? 24 : posted === 'week' ? 168 : 720;
      params.push(new Date(Date.now() - hours * 3600000).toISOString());
      where += ` AND b.created_at >= $${params.length}`;
    }
    if (req.user) { params.push(req.user.id); where += ` AND b.user_id != $${params.length}`; }
    if (seen.length) {
      const ph = seen.map((s) => { params.push(s); return `$${params.length}`; }).join(',');
      where += ` AND b.id NOT IN (${ph})`;
    }

    const { rows } = await db.query(
      `SELECT b.*,
              u.display_name AS poster_name, u.username AS poster_username,
              u.photo_url AS poster_photo, u.city AS poster_city,
              (SELECT COUNT(*) FROM verifications v WHERE v.bill_id = b.id AND v.status = 'approved') AS verified_count,
              (SELECT COUNT(*) FROM verifications v WHERE v.user_id = b.user_id AND v.status = 'approved') AS user_verified_count,
              (SELECT COUNT(*) FROM verifications v WHERE v.status = 'approved' AND v.type = 'id' AND (v.bill_id = b.id OR (v.bill_id IS NULL AND v.user_id = b.user_id))) AS id_verified_count,
              (SELECT COUNT(*) FROM verifications v WHERE v.status = 'approved' AND v.type = 'name' AND (v.bill_id = b.id OR (v.bill_id IS NULL AND v.user_id = b.user_id))) AS name_verified_count,
              (SELECT COUNT(DISTINCT supporter_id) FROM gifts g WHERE g.bill_id = b.id AND g.status = 'confirmed') AS supporter_count,
              (SELECT COUNT(*) FROM bills b2 WHERE b2.user_id = b.user_id AND b2.status = 'approved') AS poster_approved_count,
              (SELECT COUNT(*) FROM bills b2 WHERE b2.user_id = b.user_id) AS poster_total_count
       FROM bills b JOIN users u ON u.id = b.user_id
       WHERE ${where}
       ORDER BY b.created_at DESC
       LIMIT 500`,
      params
    );

    // Expired approved bills leave the feed (lazy expiry, item 181).
    const liveRows = rows.filter((r) => !isExpired(r));

    let bills = liveRows.map((r) => ({
      id: r.id,
      requestCode: r.request_code,
      title: r.title,
      category: r.category,
      company: r.company,
      amountMinor: r.amount_minor,
      coveredMinor: r.covered_minor,
      currency: r.currency,
      dueDate: r.due_date,
      story: r.story,
      charity: r.charity === 1,
      business: r.business === 1,
      dream: r.dream === 1,
      askType: askTypeOf(r),
      anonymous: r.anonymous === 1,
      status: r.status,
      city: r.city,
      country: r.country,
      photoUrl: r.photo_url,
      supportPhotoUrl: r.support_photo_url,
      payDirect: r.pay_direct === 1,
      views: r.views,
      createdAt: r.created_at,
      expiresAt: expiryOf(r),
      posterId: r.user_id,
      poster: r.anonymous === 1
        ? { displayName: 'Anonymous', username: null, photoUrl: null, city: r.poster_city, country: r.country }
        : {
            displayName: r.poster_name,
            username: r.poster_username,
            photoUrl: r.poster_photo,
            city: r.poster_city,
            country: r.country,
          },
      verifiedCount: Number(r.verified_count) + Number(r.user_verified_count),
      idVerified: Number(r.id_verified_count) > 0,
      nameVerified: Number(r.name_verified_count) > 0,
      supporterCount: Number(r.supporter_count),
      posterApprovedCount: Number(r.poster_approved_count),
    }));

    if (verifiedOnly) bills = bills.filter((b) => b.verifiedCount > 0);
    if (idVerifiedOnly) bills = bills.filter((b) => b.idVerified);
    if (nameVerifiedOnly) bills = bills.filter((b) => b.nameVerified);

    // Search (item 66 + typo tolerance, item 74): title, story, poster
    // first name, category, city, biller.
    if (q) {
      const queryTokens = normText(q).split(' ').filter(Boolean);
      bills = bills.filter((b) => {
        const hay = normText([
          b.title, b.story, b.category, b.city, b.company,
          (b.poster.displayName || '').split(' ')[0],
        ].join(' ')).split(' ').filter(Boolean);
        return matchesSearch(hay, queryTokens);
      });
    }

    // Near-me radius (item 41) + distance labels (item 45).
    const homeCity = findCity(nearCity || viewerCity);
    if (homeCity) {
      for (const b of bills) {
        const bc = findCity(b.city);
        b.distanceKm = bc ? Math.round(haversineKm(homeCity, bc)) : null;
      }
    }
    if (nearCity) {
      if (!homeCity) bills = [];
      else bills = bills.filter((b) => b.distanceKm !== null && b.distanceKm <= radiusKm);
    }

    const nowMs = Date.now();
    if (sort === 'recommended') {
      bills.forEach((b) => {
        const s = scoreBill(b, viewerCountry, viewerCity, nowMs);
        b.score = s.score;
        b.whySeeing = s.topFactor;
      });
      bills.sort((a, b) => b.score - a.score || new Date(b.createdAt) - new Date(a.createdAt));
      if (verifiedFirst) {
        bills.sort((a, b) => (b.verifiedCount > 0) - (a.verifiedCount > 0) || b.score - a.score);
      }
      bills = applyRankingRules(bills);
    } else if (sort === 'newest') {
      bills.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    } else if (sort === 'almost_funded') {
      bills.sort((a, b) => (b.coveredMinor / b.amountMinor) - (a.coveredMinor / a.amountMinor));
    } else if (sort === 'most_supported') {
      bills.sort((a, b) => b.supporterCount - a.supporterCount);
    } else if (sort === 'fewest_supported') {
      bills.sort((a, b) => a.supporterCount - b.supporterCount || new Date(b.createdAt) - new Date(a.createdAt));
    } else if (sort === 'largest') {
      bills.sort((a, b) => b.amountMinor - a.amountMinor);
    } else if (sort === 'smallest') {
      bills.sort((a, b) => a.amountMinor - b.amountMinor);
    } else if (sort === 'needs_most') {
      // Fewest supporters + oldest + largest remaining.
      bills.sort((a, b) => (a.supporterCount - b.supporterCount)
        || (new Date(a.createdAt) - new Date(b.createdAt))
        || ((b.amountMinor - b.coveredMinor) - (a.amountMinor - a.coveredMinor)));
    }
    if (sort !== 'recommended' && verifiedFirst) {
      bills.sort((a, b) => (b.verifiedCount > 0) - (a.verifiedCount > 0));
    }

    const total = bills.length;
    const page = bills.slice(offset, offset + limit);
    const nextCursor = offset + limit < total ? encodeCursor(offset + limit) : null;

    // Enrich just the page: approved badges (bill-level + poster-level) and
    // the public masked payout hints, so cards can show them without extra calls.
    if (page.length) {
      const userByBill = new Map(liveRows.map((r) => [r.id, r.user_id]));
      const pageIds = page.map((b) => b.id);
      const ph = pageIds.map((_, i) => `$${i + 1}`).join(',');
      const userIds = [...new Set(pageIds.map((id) => userByBill.get(id)).filter(Boolean))];
      const badgeRows = await db.query(
        `SELECT bill_id, user_id, type FROM verifications
         WHERE status = 'approved' AND (expires_at IS NULL OR expires_at > $${pageIds.length + userIds.length + 1})
           AND (bill_id IN (${ph})
           OR (bill_id IS NULL AND user_id IN (${userIds.map((_, i) => `$${pageIds.length + i + 1}`).join(',')})))`,
        [...pageIds, ...userIds, new Date().toISOString()]
      );
      const hintRows = await db.query(
        `SELECT bill_id, method, account_hint FROM payout_methods WHERE bill_id IN (${ph})`,
        pageIds
      );
      const badgesByBill = new Map(pageIds.map((id) => [id, new Set()]));
      for (const br of badgeRows.rows) {
        if (br.bill_id && badgesByBill.has(br.bill_id)) badgesByBill.get(br.bill_id).add(br.type);
        if (!br.bill_id) {
          for (const [bid, uid] of userByBill) {
            if (uid === br.user_id && badgesByBill.has(bid)) badgesByBill.get(bid).add(br.type);
          }
        }
      }
      const hintsByBill = new Map(pageIds.map((id) => [id, []]));
      for (const hr of hintRows.rows) {
        if (hintsByBill.has(hr.bill_id)) {
          hintsByBill.get(hr.bill_id).push({ method: hr.method, hint: hr.account_hint });
        }
      }
      for (const b of page) {
        b.badges = [...(badgesByBill.get(b.id) || [])];
        // Pay-direct verified (item 304): an approved biller badge.
        b.payDirectVerified = b.badges.includes('biller');
        b.payoutHints = hintsByBill.get(b.id) || [];
        b.payoutHint = b.payoutHints.length ? b.payoutHints[0].hint : null;
      }
    }

    res.json({
      bills: page.map(({ score, posterId, ...rest }) => rest),
      total,
      nextCursor,
      emptyMessage: total === 0
        ? 'No approved bills match — try widening your filters. When the owner approves the first posts, they will appear here.'
        : undefined,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/feed/counts — live facet counts for the filter panel (item 21).
// Counts respect the country/city/posted base filters (passed as the same
// query params as /feed) but NOT the facet being counted, so every chip
// shows how many bills it would add. Expired bills are excluded.
router.get('/feed/counts', async (req, res, next) => {
  try {
    const filterCountry = ['NP', 'IN'].includes(req.query.country) ? req.query.country : null;
    const cityFilter = typeof req.query.city === 'string' ? req.query.city.trim() : '';
    const posted = req.query.posted;
    const params = [];
    let where = `b.status = 'approved'`;
    if (filterCountry) { params.push(filterCountry); where += ` AND b.country = $${params.length}`; }
    if (cityFilter) { params.push(`%${cityFilter.toLowerCase()}%`); where += ` AND LOWER(b.city) LIKE $${params.length}`; }
    if (posted === 'today' || posted === 'week' || posted === 'month') {
      const hours = posted === 'today' ? 24 : posted === 'week' ? 168 : 720;
      params.push(new Date(Date.now() - hours * 3600000).toISOString());
      where += ` AND b.created_at >= $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT b.id, b.category, b.amount_minor, b.charity, b.business, b.dream,
              b.photo_url, b.pay_direct, b.approved_at, b.expires_at, b.status,
              (SELECT COUNT(*) FROM verifications v WHERE v.status = 'approved' AND (v.bill_id = b.id OR (v.bill_id IS NULL AND v.user_id = b.user_id))) AS verified_count,
              (SELECT COUNT(*) FROM verifications v WHERE v.status = 'approved' AND v.type = 'id' AND (v.bill_id = b.id OR (v.bill_id IS NULL AND v.user_id = b.user_id))) AS id_count,
              (SELECT COUNT(*) FROM verifications v WHERE v.status = 'approved' AND v.type = 'name' AND (v.bill_id = b.id OR (v.bill_id IS NULL AND v.user_id = b.user_id))) AS name_count
       FROM bills b WHERE ${where} LIMIT 2000`,
      params
    );
    const live = rows.filter((r) => !isExpired(r));
    const byCategory = {};
    const byBand = { small: 0, medium: 0, large: 0, huge: 0, humongous: 0 };
    const byAskType = { bill: 0, dream: 0, business: 0, charity: 0 };
    let verified = 0, idVerified = 0, nameVerified = 0, billShown = 0, payDirect = 0;
    for (const r of live) {
      byCategory[r.category] = (byCategory[r.category] || 0) + 1;
      for (const [band, [lo, hi]] of Object.entries(AMOUNT_BANDS)) {
        if (r.amount_minor >= lo && r.amount_minor <= hi) { byBand[band]++; break; }
      }
      byAskType[askTypeOf(r)]++;
      if (Number(r.verified_count) > 0) verified++;
      if (Number(r.id_count) > 0) idVerified++;
      if (Number(r.name_count) > 0) nameVerified++;
      if (r.photo_url) billShown++;
      if (r.pay_direct === 1) payDirect++;
    }
    const completed = await db.get(`SELECT COUNT(*) AS n FROM bills WHERE status = 'completed'`);
    res.json({
      total: live.length,
      byCategory, byBand, byAskType,
      verified, idVerified, nameVerified,
      billShown, hasPhoto: billShown, payDirect,
      fullyFunded: Number(completed?.n) || 0,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/feed/suggest?q= — search suggestions (item 67): live bill
// titles + categories matching the typed prefix.
router.get('/feed/suggest', async (req, res, next) => {
  try {
    const q = normText(req.query.q || '');
    if (q.length < 2) return res.json({ suggestions: [] });
    const { rows } = await db.query(
      `SELECT b.title, b.category FROM bills b WHERE b.status = 'approved' ORDER BY b.created_at DESC LIMIT 200`
    );
    const seen = new Set();
    const suggestions = [];
    const cats = await db.getSettingJson('categories', []);
    for (const c of cats) {
      if (normText(c).includes(q) && !seen.has(c)) {
        seen.add(c);
        suggestions.push({ kind: 'category', text: c });
      }
    }
    for (const r of rows) {
      const tokens = normText(r.title).split(' ').filter(Boolean);
      if (tokens.some((tok) => tok.startsWith(q) || (q.length >= 4 && editDistance(q, tok) <= 1))) {
        if (!seen.has(r.title)) {
          seen.add(r.title);
          suggestions.push({ kind: 'title', text: r.title });
        }
      }
      if (suggestions.length >= 8) break;
    }
    res.json({ suggestions: suggestions.slice(0, 8) });
  } catch (err) {
    next(err);
  }
});

// --- Leaderboards (confirmed gifts ONLY) ---

router.get('/leaders', async (req, res, next) => {
  try {
    // Canonical vocab: top_supporters | most_received | top_bills | fully_paid | brands | streak | most_thanked.
    // Short aliases (supporters, received, bills, paid) are accepted too.
    const TAB_ALIASES = {
      supporters: 'top_supporters', received: 'most_received',
      bills: 'top_bills', paid: 'fully_paid', thanked: 'most_thanked',
    };
    const tabRaw = TAB_ALIASES[req.query.tab] || req.query.tab;
    const tab = ['top_supporters', 'most_received', 'top_bills', 'fully_paid', 'brands', 'streak', 'most_thanked'].includes(tabRaw)
      ? tabRaw
      : 'top_supporters';
    const periodRaw = req.query.period === '7' ? '7d' : req.query.period === '30' ? '30d' : req.query.period;
    const period = ['7d', '30d', 'all'].includes(periodRaw) ? periodRaw : '7d';
    const scope = ['NP', 'IN', 'all'].includes(req.query.scope) ? req.query.scope : 'all';
    const currency = ['NPR', 'INR'].includes(req.query.currency) ? req.query.currency : null;
    // Weekly archive (item 496): ?week=YYYY-Www freezes one past ISO week.
    // Bounds: Monday 00:00 UTC of that week to the next Monday.
    function weekBounds(key) {
      const m = /^(\d{4})-W(\d{2})$/.exec(key || '');
      if (!m) return null;
      const year = Number(m[1]), week = Number(m[2]);
      if (week < 1 || week > 53) return null;
      const jan4 = new Date(Date.UTC(year, 0, 4));
      const monday1 = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000);
      const start = new Date(monday1.getTime() + (week - 1) * 7 * 86400000);
      const end = new Date(start.getTime() + 7 * 86400000);
      if (start.getTime() > Date.now()) return null; // no future weeks
      return { start: start.toISOString(), end: end.toISOString() };
    }
    const archiveWeek = weekBounds(req.query.week) ? req.query.week : null;
    const archiveBounds = archiveWeek ? weekBounds(archiveWeek) : null;
    // Last 4 completed ISO weeks (excluding the current week), newest first.
    const archiveWeeks = [];
    {
      let cursor = new Date(Date.now() - 7 * 86400000);
      while (archiveWeeks.length < 4) {
        const k = weekKeyOf(cursor);
        if (!archiveWeeks.includes(k)) archiveWeeks.push(k);
        cursor = new Date(cursor.getTime() - 7 * 86400000);
      }
    }
    const since = archiveBounds
      ? archiveBounds.start
      : period === 'all'
        ? null
        : new Date(Date.now() - (period === '7d' ? 7 : 30) * 24 * 3600000).toISOString();
    const until = archiveBounds ? archiveBounds.end : null;

    const params = [];
    // Gifts on removed bills never count (item 406).
    let where = `g.status = 'confirmed' AND b.status != 'removed'`;
    if (since) { params.push(since); where += ` AND g.confirmed_at >= $${params.length}`; }
    if (until) { params.push(until); where += ` AND g.confirmed_at < $${params.length}`; }
    if (scope !== 'all') { params.push(scope); where += ` AND b.country = $${params.length}`; }
    if (currency) { params.push(currency); where += ` AND g.currency = $${params.length}`; }

    // Rank change (item 475): ranks in the previous equal-length period.
    // Archive weeks are frozen snapshots — no rank change.
    async function previousRanks() {
      if (period === 'all' || archiveBounds) return new Map();
      const spanMs = (period === '7d' ? 7 : 30) * 24 * 3600000;
      const prevEnd = new Date(Date.now() - spanMs).toISOString();
      const prevStart = new Date(Date.now() - 2 * spanMs).toISOString();
      const p = [];
      let w = `g.status = 'confirmed' AND b.status != 'removed' AND g.confirmed_at >= $1 AND g.confirmed_at < $2`;
      p.push(prevStart, prevEnd);
      if (scope !== 'all') { p.push(scope); w += ` AND b.country = $${p.length}`; }
      const { rows } = await db.query(
        `SELECT g.supporter_id AS id, SUM(g.amount_minor) AS total_minor
         FROM gifts g JOIN bills b ON b.id = g.bill_id
         WHERE ${w} GROUP BY g.supporter_id ORDER BY total_minor DESC LIMIT 50`,
        p
      );
      return new Map(rows.map((r, i) => [r.id, i + 1]));
    }

    if (tab === 'top_supporters') {
      const { rows } = await db.query(
        `SELECT g.supporter_id AS id, u.display_name AS display_name, u.username, u.photo_url, u.country,
                SUM(g.amount_minor) AS total_minor, g.currency AS currency, COUNT(*) AS gifts,
                COUNT(DISTINCT g.bill_id) AS bills_helped,
                MIN(g.anonymous) AS all_anonymous,
                (SELECT COUNT(*) FROM gifts g2 WHERE g2.supporter_id = g.supporter_id AND g2.status = 'confirmed') AS lifetime_gifts
         FROM gifts g JOIN bills b ON b.id = g.bill_id JOIN users u ON u.id = g.supporter_id
         WHERE ${where}
         GROUP BY g.supporter_id, u.display_name, u.username, u.photo_url, u.country, g.currency
         ORDER BY total_minor DESC LIMIT 50`,
        params
      );
      const prev = await previousRanks();
      const anonTotals = await db.query(
        `SELECT currency, COALESCE(SUM(total_minor), 0) AS total, COALESCE(SUM(gifts), 0) AS gifts,
                COALESCE(SUM(bills_helped), 0) AS bills_helped FROM anon_stats GROUP BY currency`
      );
      return res.json({
        tab, period, scope, currency: currency || 'all', archiveWeek, archiveWeeks,
        leaders: rows.map((r, i) => {
          const anonymous = Number(r.all_anonymous) === 1;
          const tier = tierForCount(Number(r.lifetime_gifts || 0)).tier;
          const prevRank = prev.get(r.id);
          return {
            rank: i + 1,
            rankChange: prevRank == null ? 'new' : prevRank - (i + 1),
            id: anonymous ? null : r.id,
            displayName: anonymous ? 'Anonymous' : r.display_name,
            username: anonymous ? null : r.username,
            photoUrl: anonymous ? null : r.photo_url,
            country: r.country, totalMinor: Number(r.total_minor),
            currency: r.currency, gifts: Number(r.gifts), billsHelped: Number(r.bills_helped),
            anonymous,
            tier: tier ? { key: tier.key, name: tier.name, icon: tier.icon } : null,
          };
        }),
        // Anonymised counts kept when accounts are deleted (item 495).
        anonymousTotals: anonTotals.rows.map((r) => ({
          currency: r.currency, totalMinor: Number(r.total), gifts: Number(r.gifts), billsHelped: Number(r.bills_helped),
        })),
        emptyMessage: rows.length === 0 ? 'No confirmed help yet — be the first legend.' : undefined,
      });
    }

    if (tab === 'most_received') {
      const { rows } = await db.query(
        `SELECT b.user_id AS id, u.display_name AS display_name, u.username, u.photo_url, u.country,
                SUM(g.amount_minor) AS total_minor, g.currency AS currency, COUNT(*) AS gifts
         FROM gifts g JOIN bills b ON b.id = g.bill_id JOIN users u ON u.id = b.user_id
         WHERE ${where}
         GROUP BY b.user_id, u.display_name, u.username, u.photo_url, u.country, g.currency
         ORDER BY total_minor DESC LIMIT 50`,
        params
      );
      return res.json({
        tab, period, scope, currency: currency || 'all', archiveWeek, archiveWeeks,
        leaders: rows.map((r, i) => ({
          rank: i + 1, id: r.id, displayName: r.display_name, username: r.username,
          photoUrl: r.photo_url, country: r.country, totalMinor: Number(r.total_minor),
          currency: r.currency, gifts: Number(r.gifts),
        })),
        emptyMessage: rows.length === 0 ? 'No confirmed help yet — be the first legend.' : undefined,
      });
    }

    if (tab === 'top_bills') {
      const { rows } = await db.query(
        `SELECT b.id, b.title, b.amount_minor, b.covered_minor, b.currency, b.country,
                u.display_name AS poster_name, u.username AS poster_username,
                SUM(g.amount_minor) AS total_minor, COUNT(DISTINCT g.supporter_id) AS supporters
         FROM gifts g JOIN bills b ON b.id = g.bill_id JOIN users u ON u.id = b.user_id
         WHERE ${where}
         GROUP BY b.id, b.title, b.amount_minor, b.covered_minor, b.currency, b.country, u.display_name, u.username
         ORDER BY total_minor DESC LIMIT 50`,
        params
      );
      return res.json({
        tab, period, scope, currency: currency || 'all', archiveWeek, archiveWeeks,
        leaders: rows.map((r, i) => ({
          rank: i + 1, id: r.id, title: r.title, amountMinor: r.amount_minor,
          coveredMinor: r.covered_minor, currency: r.currency, country: r.country,
          posterName: r.poster_name, posterUsername: r.poster_username,
          totalMinor: Number(r.total_minor), supporters: Number(r.supporters),
        })),
        emptyMessage: rows.length === 0 ? 'No confirmed help yet — be the first legend.' : undefined,
      });
    }

    if (tab === 'fully_paid') {
      const { rows } = await db.query(
        `SELECT g.supporter_id AS id, u.display_name AS display_name, u.username, u.photo_url, u.country,
                COUNT(DISTINCT g.bill_id) AS bills_paid
         FROM gifts g JOIN bills b ON b.id = g.bill_id JOIN users u ON u.id = g.supporter_id
         WHERE ${where} AND b.status = 'completed'
         GROUP BY g.supporter_id, u.display_name, u.username, u.photo_url, u.country
         ORDER BY bills_paid DESC LIMIT 50`,
        params
      );
      return res.json({
        tab, period, scope, currency: currency || 'all', archiveWeek, archiveWeeks,
        leaders: rows.map((r, i) => ({
          rank: i + 1, id: r.id, displayName: r.display_name, username: r.username,
          photoUrl: r.photo_url, country: r.country, billsPaid: Number(r.bills_paid),
        })),
        emptyMessage: rows.length === 0 ? 'No fully paid bills yet.' : undefined,
      });
    }

    if (tab === 'streak') {
      // Streak leaderboard (item 422): consecutive weeks with ≥1
      // confirmed gift, computed per giver from real data.
      const { rows } = await db.query(
        `SELECT DISTINCT g.supporter_id AS id, u.display_name AS display_name, u.username, u.photo_url, u.country
         FROM gifts g JOIN bills b ON b.id = g.bill_id JOIN users u ON u.id = g.supporter_id
         WHERE ${where}`,
        params
      );
      const streaks = [];
      for (const r of rows) {
        const s = await computeStreak(r.id);
        if (s.weeks > 0) streaks.push({ ...r, weeks: s.weeks });
      }
      streaks.sort((a, b) => b.weeks - a.weeks);
      return res.json({
        tab, period, scope, archiveWeek, archiveWeeks,
        leaders: streaks.slice(0, 50).map((r, i) => ({
          rank: i + 1, id: r.id, displayName: r.display_name, username: r.username,
          photoUrl: r.photo_url, country: r.country, streakWeeks: r.weeks,
        })),
        emptyMessage: streaks.length === 0 ? 'No helping streaks yet — help two weeks in a row to start one.' : undefined,
      });
    }

    if (tab === 'most_thanked') {
      // Most-thanked givers (item 498): approved thank-yous received.
      const tParams = [];
      let tWhere = `t.status = 'approved'`;
      if (since) { tParams.push(since); tWhere += ` AND t.created_at >= $${tParams.length}`; }
      if (until) { tParams.push(until); tWhere += ` AND t.created_at < $${tParams.length}`; }
      if (scope !== 'all') { tParams.push(scope); tWhere += ` AND b.country = $${tParams.length}`; }
      const { rows } = await db.query(
        `SELECT t.giver_id AS id, u.display_name AS display_name, u.username, u.photo_url, u.country,
                COUNT(*) AS thanks
         FROM thanks t JOIN users u ON u.id = t.giver_id JOIN bills b ON b.id = t.bill_id
         WHERE ${tWhere}
         GROUP BY t.giver_id, u.display_name, u.username, u.photo_url, u.country
         ORDER BY thanks DESC LIMIT 50`,
        tParams
      );
      return res.json({
        tab, period, scope, archiveWeek, archiveWeeks,
        leaders: rows.map((r, i) => ({
          rank: i + 1, id: r.id, displayName: r.display_name, username: r.username,
          photoUrl: r.photo_url, country: r.country, thanks: Number(r.thanks),
        })),
        emptyMessage: rows.length === 0 ? 'No public thank-yous yet.' : undefined,
      });
    }

    // brands tab: most responded / most asked (honest zeroes when empty).
    // The period filter applies (item 600).
    const respParams = [];
    let respondedWhere = `bc.status = 'connected'`;
    if (since) { respParams.push(since); respondedWhere += ` AND bc.created_at >= $${respParams.length}`; }
    if (until) { respParams.push(until); respondedWhere += ` AND bc.created_at < $${respParams.length}`; }
    const responded = await db.query(
      `SELECT bc.brand_name AS name, COUNT(*) AS responses, COUNT(DISTINCT br.country) AS countries
       FROM brand_connects bc JOIN brands br ON br.id = bc.brand_id
       WHERE ${respondedWhere}
       GROUP BY bc.brand_name ORDER BY responses DESC LIMIT 50`,
      respParams
    );
    const askedParams = [];
    let askedWhere = `status = 'approved'`;
    if (since) { askedParams.push(since); askedWhere += ` AND created_at >= $${askedParams.length}`; }
    if (until) { askedParams.push(until); askedWhere += ` AND created_at < $${askedParams.length}`; }
    const asked = await db.query(
      `SELECT name, COUNT(*) AS asks FROM brands WHERE ${askedWhere}
       GROUP BY name ORDER BY asks DESC LIMIT 50`,
      askedParams
    );
    return res.json({
      tab, period, scope, currency: currency || 'all', archiveWeek, archiveWeeks,
      mostResponded: responded.rows.map((r, i) => ({ rank: i + 1, name: r.name, responses: Number(r.responses), countries: Number(r.countries) })),
      mostAsked: asked.rows.map((r, i) => ({ rank: i + 1, name: r.name, asks: Number(r.asks) })),
      emptyMessage: responded.rows.length === 0 && asked.rows.length === 0
        ? 'No brand responses yet — honest zeroes.'
        : undefined,
    });
  } catch (err) {
    next(err);
  }
});

// --- Hall of Fame (items 407–409) ---
// All-time top supporters with lifetime totals + first-helped date, and
// the most fully-paid bills with links. Monthly snapshots (?month=YYYY-MM)
// are computed lazily from confirmed_at — no scheduler (P1-254).
// Anonymous givers are excluded (item 454).

router.get('/hall-of-fame', async (req, res, next) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null;
    let params = [];
    let where = `g.status = 'confirmed' AND b.status != 'removed' AND g.anonymous = 0`;
    if (month) {
      const [y, m] = month.split('-').map(Number);
      params.push(new Date(Date.UTC(y, m - 1, 1)).toISOString());
      params.push(new Date(Date.UTC(y, m, 1)).toISOString());
      where += ` AND g.confirmed_at >= $${params.length - 1} AND g.confirmed_at < $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT g.supporter_id AS id, u.display_name AS display_name, u.username, u.photo_url, u.country,
              SUM(g.amount_minor) AS total_minor, g.currency AS currency, COUNT(*) AS gifts,
              COUNT(DISTINCT g.bill_id) AS bills_helped,
              MIN(g.confirmed_at) AS first_helped,
              (SELECT COUNT(*) FROM gifts g3 WHERE g3.supporter_id = g.supporter_id AND g3.status = 'confirmed') AS lifetime_gifts,
              (SELECT COUNT(DISTINCT g2.bill_id) FROM gifts g2 JOIN bills b2 ON b2.id = g2.bill_id
               WHERE g2.supporter_id = g.supporter_id AND g2.status = 'confirmed' AND b2.status = 'completed') AS bills_paid
       FROM gifts g JOIN bills b ON b.id = g.bill_id JOIN users u ON u.id = g.supporter_id
       WHERE ${where}
       GROUP BY g.supporter_id, u.display_name, u.username, u.photo_url, u.country, g.currency
       ORDER BY total_minor DESC LIMIT 50`,
      params
    );
    // Most fully-paid bills (item 408): completed bills with helper counts.
    const paidParams = month ? params : [];
    const paidWhere = month
      ? `b.status = 'completed' AND b.completed_at >= $1 AND b.completed_at < $2`
      : `b.status = 'completed'`;
    const paid = await db.query(
      `SELECT b.id, b.title, b.category, b.amount_minor, b.currency, b.completed_at,
              (SELECT COUNT(DISTINCT supporter_id) FROM gifts WHERE bill_id = b.id AND status = 'confirmed') AS helpers
       FROM bills b WHERE ${paidWhere} ORDER BY b.completed_at DESC LIMIT 20`,
      paidParams
    );
    // Past months with activity (for the snapshot browser).
    const months = await db.query(
      `SELECT DISTINCT substr(confirmed_at, 1, 7) AS month FROM gifts
       WHERE status = 'confirmed' AND confirmed_at IS NOT NULL ORDER BY month DESC LIMIT 24`
    );
    res.json({
      month: month || 'all',
      entries: rows.map((r, i) => ({
        rank: i + 1, id: r.id, displayName: r.display_name, username: r.username,
        photoUrl: r.photo_url, country: r.country, totalMinor: Number(r.total_minor),
        currency: r.currency, gifts: Number(r.gifts), billsHelped: Number(r.bills_helped),
        billsPaid: Number(r.bills_paid), firstHelped: r.first_helped,
        tier: tierForCount(Number(r.lifetime_gifts || 0)).tier,
      })),
      fullyPaid: paid.rows.map((r) => ({
        id: r.id, title: r.title, category: r.category, amountMinor: r.amount_minor,
        currency: r.currency, completedAt: r.completed_at, helpers: Number(r.helpers),
      })),
      months: months.rows.map((r) => r.month),
      emptyMessage: rows.length === 0 ? 'No Hall of Fame entries yet — the first legends are still being written.' : undefined,
    });
  } catch (err) {
    next(err);
  }
});

// --- Community page (items 458–461, 481, 484, 544/546, 549) ---

router.get('/community', async (req, res, next) => {
  try {
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const newestBills = await db.query(
      `SELECT b.id, b.title, b.category, b.amount_minor, b.covered_minor, b.currency,
              b.photo_url, b.created_at, u.display_name AS poster_name, u.username AS poster_username
       FROM bills b JOIN users u ON u.id = b.user_id
       WHERE b.status = 'approved' ORDER BY b.created_at DESC LIMIT 6`
    );
    const thanks = await db.query(
      `SELECT t.id, t.body, t.video_url, t.created_at, b.title AS bill_title,
              u.display_name AS giver_name, u.username AS giver_username,
              r.display_name AS receiver_name
       FROM thanks t JOIN bills b ON b.id = t.bill_id
       JOIN users u ON u.id = t.giver_id JOIN users r ON r.id = t.receiver_id
       WHERE t.status = 'approved' ORDER BY t.created_at DESC LIMIT 6`
    );
    const top3 = await db.query(
      `SELECT g.supporter_id AS id, u.display_name AS display_name, u.username, u.photo_url, u.country,
              SUM(g.amount_minor) AS total_minor, g.currency AS currency, COUNT(*) AS gifts
       FROM gifts g JOIN bills b ON b.id = g.bill_id JOIN users u ON u.id = g.supporter_id
       WHERE g.status = 'confirmed' AND b.status != 'removed' AND g.confirmed_at >= $1
       GROUP BY g.supporter_id, u.display_name, u.username, u.photo_url, u.country, g.currency
       ORDER BY total_minor DESC LIMIT 3`,
      [weekAgo]
    );
    // Weekly digest (item 460): real counts only.
    const digest = await db.get(
      `SELECT
         (SELECT COUNT(*) FROM gifts WHERE status = 'confirmed' AND confirmed_at >= $1) AS gifts_week,
         (SELECT COUNT(*) FROM bills WHERE status = 'completed' AND completed_at >= $2) AS paid_week,
         (SELECT COUNT(*) FROM gifts WHERE status = 'confirmed') AS gifts_all,
         (SELECT COUNT(*) FROM bills WHERE status = 'completed') AS paid_all`,
      [weekAgo, weekAgo]
    );
    // Newest helpers (item 461): most recent first-time givers.
    const newestHelpers = await db.query(
      `SELECT u.id, u.display_name, u.username, u.photo_url, MIN(g.confirmed_at) AS first_helped
       FROM gifts g JOIN users u ON u.id = g.supporter_id
       WHERE g.status = 'confirmed' AND g.anonymous = 0
       GROUP BY u.id, u.display_name, u.username, u.photo_url
       ORDER BY first_helped DESC LIMIT 6`
    );
    // Giver of the week (item 481) = top3[0].
    // Receiver stories feed (item 484).
    const stories = await db.query(
      `SELECT s.id, s.body, s.created_at, b.id AS bill_id, b.title AS bill_title,
              u.display_name AS author_name, u.username AS author_username
       FROM receiver_stories s JOIN bills b ON b.id = s.bill_id JOIN users u ON u.id = s.user_id
       WHERE s.status = 'approved' ORDER BY s.created_at DESC LIMIT 6`
    );
    // CSR stories feed (item 549).
    const csr = await db.query(
      `SELECT c.id, c.title, c.body, c.image_url, c.created_at,
              bp.name AS brand_name, bp.id AS brand_profile_id
       FROM csr_updates c JOIN brand_profiles bp ON bp.id = c.brand_profile_id
       WHERE c.status = 'approved' ORDER BY c.created_at DESC LIMIT 6`
    );
    // Featured brand of the week (items 544/546/547): the configured
    // brand, only while its week is current.
    const featuredId = await db.getSetting('featured_brand_id');
    const featuredWeek = await db.getSetting('featured_brand_week');
    let featured = null;
    if (featuredId && featuredWeek) {
      const now = new Date();
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const day = (d.getUTCDay() + 6) % 7;
      d.setUTCDate(d.getUTCDate() - day + 3);
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
      const week = 1 + Math.round(((d - yearStart) / 86400000 - 3 + ((yearStart.getUTCDay() + 6) % 7)) / 7);
      const weekKey = `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
      if (weekKey === featuredWeek) {
        const bp = await db.get('SELECT * FROM brand_profiles WHERE id = $1 AND status = $2', [featuredId, 'approved']);
        if (bp) {
          featured = {
            id: bp.id, name: bp.name, industry: bp.industry, country: bp.country,
            city: bp.city, description: bp.description, logoUrl: bp.logo_url, verified: bp.verified === 1,
          };
        }
      }
    }
    res.json({
      newestBills: newestBills.rows.map((r) => ({
        id: r.id, title: r.title, category: r.category, amountMinor: r.amount_minor,
        coveredMinor: r.covered_minor, currency: r.currency, photoUrl: r.photo_url,
        createdAt: r.created_at, posterName: r.poster_name, posterUsername: r.poster_username,
      })),
      thanks: thanks.rows.map((r) => ({
        id: r.id, body: r.body, videoUrl: r.video_url, createdAt: r.created_at,
        billTitle: r.bill_title, giverName: r.giver_name, giverUsername: r.giver_username,
        receiverName: r.receiver_name,
      })),
      topSupporters: top3.rows.map((r, i) => ({
        rank: i + 1, id: r.id, displayName: r.display_name, username: r.username,
        photoUrl: r.photo_url, country: r.country, totalMinor: Number(r.total_minor),
        currency: r.currency, gifts: Number(r.gifts),
      })),
      giverOfWeek: top3.rows[0] ? {
        id: top3.rows[0].id, displayName: top3.rows[0].display_name, username: top3.rows[0].username,
        photoUrl: top3.rows[0].photo_url, totalMinor: Number(top3.rows[0].total_minor),
        currency: top3.rows[0].currency, gifts: Number(top3.rows[0].gifts),
      } : null,
      digest: {
        giftsWeek: Number(digest?.gifts_week || 0), paidWeek: Number(digest?.paid_week || 0),
        giftsAll: Number(digest?.gifts_all || 0), paidAll: Number(digest?.paid_all || 0),
      },
      newestHelpers: newestHelpers.rows.map((r) => ({
        id: r.id, displayName: r.display_name, username: r.username,
        photoUrl: r.photo_url, firstHelped: r.first_helped,
      })),
      stories: stories.rows.map((r) => ({
        id: r.id, body: r.body, createdAt: r.created_at, billId: r.bill_id,
        billTitle: r.bill_title, authorName: r.author_name, authorUsername: r.author_username,
      })),
      csrStories: csr.rows.map((r) => ({
        id: r.id, title: r.title, body: r.body, imageUrl: r.image_url, createdAt: r.created_at,
        brandName: r.brand_name, brandProfileId: r.brand_profile_id,
      })),
      featured,
    });
  } catch (err) {
    next(err);
  }
});

// --- Platform milestones (items 478/479) ---
// Real aggregate totals + the dates thresholds were reached (the date of
// the Nth confirmed gift / Nth completed bill).

const MILESTONE_THRESHOLDS = [10, 50, 100, 500, 1000, 5000];

router.get('/milestones', async (req, res, next) => {
  try {
    const totals = await db.get(
      `SELECT
         (SELECT COUNT(*) FROM gifts WHERE status = 'confirmed') AS gifts,
         (SELECT COUNT(*) FROM bills WHERE status = 'completed') AS paid,
         (SELECT COUNT(DISTINCT supporter_id) FROM gifts WHERE status = 'confirmed') AS helpers,
         (SELECT COALESCE(SUM(amount_minor), 0) FROM gifts WHERE status = 'confirmed' AND currency = 'NPR') AS npr_minor,
         (SELECT COALESCE(SUM(amount_minor), 0) FROM gifts WHERE status = 'confirmed' AND currency = 'INR') AS inr_minor`
    );
    const giftDates = await db.query(
      `SELECT confirmed_at FROM gifts WHERE status = 'confirmed' ORDER BY confirmed_at ASC`
    );
    const paidDates = await db.query(
      `SELECT completed_at FROM bills WHERE status = 'completed' AND completed_at IS NOT NULL ORDER BY completed_at ASC`
    );
    const milestones = [];
    for (const n of MILESTONE_THRESHOLDS) {
      if (giftDates.rows.length >= n) {
        milestones.push({ kind: 'gifts', threshold: n, reachedAt: giftDates.rows[n - 1].confirmed_at });
      }
      if (paidDates.rows.length >= n) {
        milestones.push({ kind: 'bills_paid', threshold: n, reachedAt: paidDates.rows[n - 1].completed_at });
      }
    }
    milestones.sort((a, b) => new Date(b.reachedAt) - new Date(a.reachedAt));
    res.json({
      totals: {
        gifts: Number(totals?.gifts || 0), billsPaid: Number(totals?.paid || 0),
        helpers: Number(totals?.helpers || 0),
        totalNprMinor: Number(totals?.npr_minor || 0), totalInrMinor: Number(totals?.inr_minor || 0),
      },
      milestones,
      nextGiftMilestone: MILESTONE_THRESHOLDS.find((n) => n > Number(totals?.gifts || 0)) || null,
      nextPaidMilestone: MILESTONE_THRESHOLDS.find((n) => n > Number(totals?.paid || 0)) || null,
    });
  } catch (err) {
    next(err);
  }
});

// --- Founder supporter wall (item 565) ---
// Usernames of people who tipped (confirmed gifts with tip_minor > 0),
// honouring the hideFromSupporterWall preference.

router.get('/supporters-wall', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT u.display_name, u.username, u.photo_url,
              (SELECT COALESCE(SUM(tip_minor), 0) FROM gifts g2 WHERE g2.supporter_id = u.id AND g2.status = 'confirmed') AS tips_minor
       FROM gifts g JOIN users u ON u.id = g.supporter_id
       WHERE g.status = 'confirmed' AND g.tip_minor > 0
       ORDER BY tips_minor DESC LIMIT 100`
    );
    const wall = [];
    for (const r of rows) {
      const prefs = await db.get('SELECT prefs_json FROM users WHERE username = $1', [r.username]);
      let hidden = false;
      try { hidden = JSON.parse(prefs?.prefs_json || '{}').hideFromSupporterWall === true; } catch { /* show */ }
      if (!hidden) {
        wall.push({ displayName: r.display_name, username: r.username, photoUrl: r.photo_url, tipsMinor: Number(r.tips_minor) });
      }
    }
    res.json({ supporters: wall });
  } catch (err) {
    next(err);
  }
});

// --- Public scam notices (item 365) ---

router.get('/scam-notices', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT id, title, body, created_at FROM scam_notices ORDER BY created_at DESC LIMIT 10');
    res.json({ notices: rows.map((r) => ({ id: r.id, title: r.title, body: r.body, createdAt: r.created_at })) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
