// Sahay Pay — public routes (no auth required).
// GET /api/config, GET /api/feed, GET /api/leaders.
// Feed: approved bills only, never own bills, never already-seen ids.
// Ranking (Recommended): verified boost + same-country boost + recency boost +
// fewer-supporters boost + new-poster fairness boost. Honest empty states.

'use strict';

const express = require('express');
const db = require('../db');
const { feeModelSentence } = require('../lib/fees');

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
    const feeMode = (await db.getSetting('fee_mode')) || 'supporter_fee';
    const feeConfig = await db.getSettingJson('fee_config', {});
    const brandPackages = await db.getSettingJson('brand_packages', []);
    const founderTipConfig = await db.getSettingJson('founder_tip_config', {});
    const paymentMethods = await db.getSettingJson('payment_methods', {});
    const categories = await db.getSettingJson('categories', []);
    const minGiftMinor = Number(await db.getSetting('min_gift_minor')) || 1000;
    res.json({
      appName: 'Sahay Pay',
      tagline: 'Small acts. Real help.',
      demoMode: true,
      feeMode,
      feeConfig,
      feeModelSentenceNPR: feeModelSentence(feeMode, feeConfig, 'NPR'),
      feeModelSentenceINR: feeModelSentence(feeMode, feeConfig, 'INR'),
      brandPackages,
      founderTipConfig,
      paymentMethods,
      categories,
      minGiftMinor,
      crossBorderNote: CROSS_BORDER_NOTE,
      giftAmountChips: { NPR: [10000, 50000, 100000], INR: [10000, 50000, 100000] },
    });
  } catch (err) {
    next(err);
  }
});

// --- Feed ---

const AMOUNT_BANDS = {
  small: [0, 500000], // up to NPR/INR 5,000
  medium: [500001, 2500000],
  large: [2500001, 10000000],
  huge: [10000001, Infinity],
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

function scoreBill(bill, viewerCountry, nowMs) {
  let score = 0;
  if (bill.verifiedCount > 0) score += 40; // verified boost
  if (viewerCountry && bill.country === viewerCountry) score += 25; // same-country boost
  const ageHours = (nowMs - new Date(bill.created_at).getTime()) / 3600000;
  if (ageHours < 24) score += 20; // recency boost
  else if (ageHours < 72) score += 10;
  else if (ageHours < 168) score += 5;
  if (bill.supporterCount === 0) score += 15; // fewer-supporters boost
  else if (bill.supporterCount < 3) score += 8;
  if (bill.posterApprovedCount <= 1) score += 10; // new-poster fairness boost
  return score;
}

router.get('/feed', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const offset = parseCursor(req.query.cursor);
    const sort = ['recommended', 'newest', 'almost_funded', 'most_supported'].includes(req.query.sort)
      ? req.query.sort
      : 'recommended';
    const viewerCountry = req.user?.country || (['NP', 'IN'].includes(req.query.country) ? req.query.country : null);
    const filterCountry = ['NP', 'IN'].includes(req.query.country) ? req.query.country : null;
    const categories = typeof req.query.category === 'string'
      ? req.query.category.split(',').map((c) => c.trim()).filter(Boolean)
      : [];
    const band = AMOUNT_BANDS[req.query.amountBand || req.query.band];
    const verifiedOnly = req.query.verified === '1' || req.query.verified === 'true';
    const payDirectOnly = req.query.payDirect === '1' || req.query.payDirect === 'true'
      || req.query.pay_direct === '1' || req.query.pay_direct === 'true';
    const charityOnly = req.query.charity === '1' || req.query.charity === 'true';
    const billShownOnly = req.query.billShown === '1' || req.query.billShown === 'true'
      || req.query.bill_shown === '1' || req.query.bill_shown === 'true';
    const cityFilter = typeof req.query.city === 'string' ? req.query.city.trim() : '';
    const posted = req.query.posted; // today|week|month
    const seen = typeof req.query.seen === 'string'
      ? req.query.seen.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 500)
      : [];

    // Approved bills only. Build the WHERE clause with parameters.
    const params = [];
    let where = `b.status = 'approved'`;
    if (filterCountry) { params.push(filterCountry); where += ` AND b.country = $${params.length}`; }
    if (categories.length) {
      const ph = categories.map((c) => { params.push(c); return `$${params.length}`; }).join(',');
      where += ` AND b.category IN (${ph})`;
    }
    if (band) {
      params.push(band[0]); where += ` AND b.amount_minor >= $${params.length}`;
      if (Number.isFinite(band[1])) { params.push(band[1]); where += ` AND b.amount_minor <= $${params.length}`; }
    }
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
              (SELECT COUNT(DISTINCT supporter_id) FROM gifts g WHERE g.bill_id = b.id AND g.status = 'confirmed') AS supporter_count,
              (SELECT COUNT(*) FROM bills b2 WHERE b2.user_id = b.user_id AND b2.status = 'approved') AS poster_approved_count,
              (SELECT COUNT(*) FROM bills b2 WHERE b2.user_id = b.user_id) AS poster_total_count
       FROM bills b JOIN users u ON u.id = b.user_id
       WHERE ${where}
       ORDER BY b.created_at DESC
       LIMIT 500`,
      params
    );

    let bills = rows.map((r) => ({
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
      anonymous: r.anonymous === 1,
      status: r.status,
      city: r.city,
      country: r.country,
      photoUrl: r.photo_url,
      supportPhotoUrl: r.support_photo_url,
      payDirect: r.pay_direct === 1,
      views: r.views,
      createdAt: r.created_at,
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
      supporterCount: Number(r.supporter_count),
      posterApprovedCount: Number(r.poster_approved_count),
    }));

    if (verifiedOnly) bills = bills.filter((b) => b.verifiedCount > 0);

    const nowMs = Date.now();
    if (sort === 'recommended') {
      bills.forEach((b) => { b.score = scoreBill(b, viewerCountry, nowMs); });
      bills.sort((a, b) => b.score - a.score || new Date(b.createdAt) - new Date(a.createdAt));
    } else if (sort === 'newest') {
      bills.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    } else if (sort === 'almost_funded') {
      bills.sort((a, b) => (b.coveredMinor / b.amountMinor) - (a.coveredMinor / a.amountMinor));
    } else if (sort === 'most_supported') {
      bills.sort((a, b) => b.supporterCount - a.supporterCount);
    }

    const total = bills.length;
    const page = bills.slice(offset, offset + limit);
    const nextCursor = offset + limit < total ? encodeCursor(offset + limit) : null;

    // Enrich just the page: approved badges (bill-level + poster-level) and
    // the public masked payout hints, so cards can show them without extra calls.
    if (page.length) {
      const userByBill = new Map(rows.map((r) => [r.id, r.user_id]));
      const pageIds = page.map((b) => b.id);
      const ph = pageIds.map((_, i) => `$${i + 1}`).join(',');
      const userIds = [...new Set(pageIds.map((id) => userByBill.get(id)).filter(Boolean))];
      const badgeRows = await db.query(
        `SELECT bill_id, user_id, type FROM verifications
         WHERE status = 'approved' AND (bill_id IN (${ph})
           OR (bill_id IS NULL AND user_id IN (${userIds.map((_, i) => `$${pageIds.length + i + 1}`).join(',')})))`,
        [...pageIds, ...userIds]
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
        b.payoutHints = hintsByBill.get(b.id) || [];
        b.payoutHint = b.payoutHints.length ? b.payoutHints[0].hint : null;
      }
    }

    res.json({
      bills: page.map(({ score, ...rest }) => rest),
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

// --- Leaderboards (confirmed gifts ONLY) ---

router.get('/leaders', async (req, res, next) => {
  try {
    // Canonical vocab: top_supporters | most_received | top_bills | fully_paid | brands.
    // Short aliases (supporters, received, bills, paid) are accepted too.
    const TAB_ALIASES = {
      supporters: 'top_supporters', received: 'most_received',
      bills: 'top_bills', paid: 'fully_paid',
    };
    const tabRaw = TAB_ALIASES[req.query.tab] || req.query.tab;
    const tab = ['top_supporters', 'most_received', 'top_bills', 'fully_paid', 'brands'].includes(tabRaw)
      ? tabRaw
      : 'top_supporters';
    const periodRaw = req.query.period === '7' ? '7d' : req.query.period === '30' ? '30d' : req.query.period;
    const period = ['7d', '30d', 'all'].includes(periodRaw) ? periodRaw : '7d';
    const scope = ['NP', 'IN', 'all'].includes(req.query.scope) ? req.query.scope : 'all';
    const since = period === 'all'
      ? null
      : new Date(Date.now() - (period === '7d' ? 7 : 30) * 24 * 3600000).toISOString();

    const params = [];
    let where = `g.status = 'confirmed'`;
    if (since) { params.push(since); where += ` AND g.confirmed_at >= $${params.length}`; }
    if (scope !== 'all') { params.push(scope); where += ` AND b.country = $${params.length}`; }

    if (tab === 'top_supporters') {
      const { rows } = await db.query(
        `SELECT g.supporter_id AS id, u.display_name AS display_name, u.username, u.photo_url, u.country,
                SUM(g.amount_minor) AS total_minor, g.currency AS currency, COUNT(*) AS gifts,
                COUNT(DISTINCT g.bill_id) AS bills_helped
         FROM gifts g JOIN bills b ON b.id = g.bill_id JOIN users u ON u.id = g.supporter_id
         WHERE ${where}
         GROUP BY g.supporter_id, u.display_name, u.username, u.photo_url, u.country, g.currency
         ORDER BY total_minor DESC LIMIT 50`,
        params
      );
      return res.json({
        tab, period, scope,
        leaders: rows.map((r, i) => ({
          rank: i + 1, id: r.id, displayName: r.display_name, username: r.username,
          photoUrl: r.photo_url, country: r.country, totalMinor: Number(r.total_minor),
          currency: r.currency, gifts: Number(r.gifts), billsHelped: Number(r.bills_helped),
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
        tab, period, scope,
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
        tab, period, scope,
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
        tab, period, scope,
        leaders: rows.map((r, i) => ({
          rank: i + 1, id: r.id, displayName: r.display_name, username: r.username,
          photoUrl: r.photo_url, country: r.country, billsPaid: Number(r.bills_paid),
        })),
        emptyMessage: rows.length === 0 ? 'No fully paid bills yet.' : undefined,
      });
    }

    // brands tab: most responded / most asked (honest zeroes when empty)
    const responded = await db.query(
      `SELECT bc.brand_name AS name, COUNT(*) AS responses, COUNT(DISTINCT br.country) AS countries
       FROM brand_connects bc JOIN brands br ON br.id = bc.brand_id
       WHERE bc.status = 'connected'
       GROUP BY bc.brand_name ORDER BY responses DESC LIMIT 50`
    );
    const asked = await db.query(
      `SELECT name, COUNT(*) AS asks FROM brands WHERE status = 'approved'
       GROUP BY name ORDER BY asks DESC LIMIT 50`
    );
    return res.json({
      tab, period, scope,
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

module.exports = router;
