// Sahay Pay — auctions routes (an original, moderated extension).
// GET /api/auctions, GET /api/auctions/:id (public, approved only),
// POST /api/auctions (-> pending_review), POST /api/auctions/:id/bid,
// GET /api/auctions/mine.
// Bidding: no self-bidding; must exceed the current highest bid by at least
// the minimum increment (5% of the current bid, min 1000 minor).
// Real payment/transfer for auctions stays DISABLED (Demo Mode).

'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { logAudit, nowIso } = require('../lib/audit');
const { requireAuth, requireActive, rateLimit } = require('../lib/auth');
const { cleanStr } = require('../lib/validate');
const { isMinorAmount } = require('../lib/money');
const { createReviewPacket, createNotification } = require('../lib/notify');

const router = express.Router();

function minIncrement(currentMinor, sellerIncrement) {
  // Seller-set minimum increment (item 579) wins when present.
  if (Number.isInteger(sellerIncrement) && sellerIncrement > 0) return sellerIncrement;
  return Math.max(1000, Math.ceil(currentMinor * 0.05));
}

async function withBids(row) {
  const { rows } = await db.query(
    `SELECT ab.*, u.display_name AS bidder_name, u.username AS bidder_username
     FROM auction_bids ab JOIN users u ON u.id = ab.bidder_id
     WHERE ab.auction_id = $1 ORDER BY ab.amount_minor DESC LIMIT 50`,
    [row.id]
  );
  const highest = rows[0] ? Number(rows[0].amount_minor) : Number(row.start_bid_minor);
  const increment = minIncrement(highest, row.min_increment_minor);
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    description: row.description,
    photoUrl: row.photo_url,
    category: row.category,
    country: row.country,
    startBidMinor: row.start_bid_minor,
    currency: row.currency,
    endsAt: row.ends_at,
    status: row.status,
    createdAt: row.created_at,
    currentBidMinor: highest,
    minIncrement: increment,
    minNextBidMinor: highest + increment,
    bidCount: rows.length,
    // Winner announcement (item 568): once the end time has passed, the
    // highest bidder is the winner.
    ended: new Date(row.ends_at).getTime() <= Date.now(),
    winner: new Date(row.ends_at).getTime() <= Date.now() && rows[0] ? {
      bidderName: rows[0].bidder_name, bidderUsername: rows[0].bidder_username,
      amountMinor: rows[0].amount_minor,
    } : null,
    // Settlement state (items 572/573).
    settlement: {
      buyerSettled: row.buyer_settled === 1,
      sellerSettled: row.seller_settled === 1,
      settledAt: row.settled_at || null,
      settled: Boolean(row.settled_at),
    },
    bids: rows.map((b) => ({
      id: b.id, amountMinor: b.amount_minor, bidderName: b.bidder_name,
      bidderUsername: b.bidder_username, createdAt: b.created_at,
    })),
  };
}

router.get('/', async (req, res, next) => {
  try {
    // Category filter (item 578).
    const params = [nowIso()];
    let where = `status = 'approved' AND ends_at > $1`;
    if (req.query.category) {
      params.push(cleanStr(req.query.category, 60));
      where += ` AND category = $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT * FROM auctions WHERE ${where} ORDER BY ends_at ASC LIMIT 100`,
      params
    );
    const auctions = [];
    for (const r of rows) auctions.push(await withBids(r));
    res.json({
      auctions,
      emptyMessage: auctions.length === 0 ? 'No live auctions yet.' : undefined,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/auctions/watchlist — own watched auctions (item 577).
router.get('/watchlist', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT a.* FROM auction_watchlist w JOIN auctions a ON a.id = w.auction_id
       WHERE w.user_id = $1 ORDER BY a.ends_at ASC LIMIT 50`,
      [req.user.id]
    );
    const auctions = [];
    for (const r of rows) auctions.push(await withBids(r));
    res.json({ auctions });
  } catch (err) {
    next(err);
  }
});

router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM auctions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
      [req.user.id]
    );
    const auctions = [];
    for (const r of rows) auctions.push(await withBids(r));
    res.json({ auctions });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireActive, rateLimit('post-auction', 10, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const body = req.body || {};
    const title = cleanStr(body.title, 120);
    if (title.length < 3) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please give your listing a title (3–120 characters).' } });
    const description = cleanStr(body.description, 1500);
    if (description.length < 20) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Please describe the item (20–1500 characters).' } });
    if (!isMinorAmount(body.startBidMinor)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Starting bid must be a positive amount in minor units.' } });
    }
    const endsAt = new Date(body.endsAt);
    if (Number.isNaN(endsAt.getTime()) || endsAt.getTime() <= Date.now() + 60 * 60 * 1000) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'The auction must end at least 1 hour from now.' } });
    }
    const currency = req.user.country === 'IN' ? 'INR' : 'NPR';
    // Seller-set minimum bid increment (item 579): optional; when given
    // it must be at least 1000 minor (₹/रू10).
    let minIncrementMinor = null;
    if (body.minIncrementMinor !== undefined && body.minIncrementMinor !== null && body.minIncrementMinor !== '') {
      if (!isMinorAmount(body.minIncrementMinor) || body.minIncrementMinor < 1000) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'Minimum bid increment must be at least 1000 minor (₹/रू10).' } });
      }
      minIncrementMinor = body.minIncrementMinor;
    }
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO auctions (id, user_id, title, description, photo_url, category, country, start_bid_minor, currency, ends_at, status, min_increment_minor, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending_review', $11, $12)`,
      [
        id, req.user.id, title, description,
        body.photoUrl ? cleanStr(body.photoUrl, 500) : null,
        cleanStr(body.category || 'Other', 60), req.user.country,
        body.startBidMinor, currency, endsAt.toISOString(), minIncrementMinor, nowIso(),
      ]
    );
    const auction = await db.get('SELECT * FROM auctions WHERE id = $1', [id]);
    const packet = await createReviewPacket('auction', id, {
      kind: 'auction',
      auctionId: id,
      title,
      description,
      category: auction.category,
      country: auction.country,
      startBidMinor: auction.start_bid_minor,
      currency,
      endsAt: auction.ends_at,
      seller: { displayName: req.user.displayName, username: req.user.username },
    });
    await logAudit('user', req.user.id, 'auction_submitted', 'auction', id, {});
    res.status(201).json({ auction: await withBids(auction), reviewPacketId: packet.id });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/bid', requireActive, rateLimit('bid', 30, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const auction = await db.get('SELECT * FROM auctions WHERE id = $1', [req.params.id]);
    if (!auction || auction.status !== 'approved') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Auction not found.' } });
    }
    if (new Date(auction.ends_at).getTime() <= Date.now()) {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'This auction has ended.' } });
    }
    if (auction.user_id === req.user.id) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You cannot bid on your own auction.' } });
    }
    const amountMinor = req.body?.amountMinor;
    if (!isMinorAmount(amountMinor)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Bid must be a positive amount in minor units.' } });
    }
    const current = await withBids(auction);
    if (amountMinor < current.minNextBidMinor) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: `Your bid must be at least ${current.minNextBidMinor / 100} ${auction.currency} (current highest + minimum increment).` },
      });
    }
    const previousHighest = current.bids[0];
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO auction_bids (id, auction_id, bidder_id, amount_minor, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [id, auction.id, req.user.id, amountMinor, nowIso()]
    );
    if (previousHighest && previousHighest.bidderUsername !== req.user.username) {
      const prevBidder = await db.get('SELECT id FROM users WHERE username = $1', [previousHighest.bidderUsername]);
      if (prevBidder) {
        await createNotification(
          prevBidder.id, 'auction_outbid', 'You were outbid',
          `Someone bid ${amountMinor / 100} ${auction.currency} on "${auction.title}".`,
          `#/auction/${auction.id}`
        );
      }
    }
    await logAudit('user', req.user.id, 'auction_bid', 'auction', auction.id, { bidId: id, amountMinor });
    const updated = await db.get('SELECT * FROM auctions WHERE id = $1', [auction.id]);
    res.status(201).json({ auction: await withBids(updated), demoMode: true });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const auction = await db.get('SELECT * FROM auctions WHERE id = $1', [req.params.id]);
    if (!auction) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Auction not found.' } });
    const isOwner = req.user && req.user.id === auction.user_id;
    if (auction.status !== 'approved' && !isOwner) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Auction not found.' } });
    }
    const seller = await db.get('SELECT display_name, username, photo_url FROM users WHERE id = $1', [auction.user_id]);
    const out = await withBids(auction);
    out.seller = seller ? { displayName: seller.display_name, username: seller.username, photoUrl: seller.photo_url } : null;
    // Watchlist membership for the signed-in viewer (item 577).
    if (req.user) {
      const watch = await db.get(
        'SELECT id FROM auction_watchlist WHERE auction_id = $1 AND user_id = $2',
        [auction.id, req.user.id]
      );
      out.watching = Boolean(watch);
    }
    res.json({ auction: out });
  } catch (err) {
    next(err);
  }
});

// POST /api/auctions/:id/watch — add to watchlist (item 577).
router.post('/:id/watch', requireAuth, async (req, res, next) => {
  try {
    const auction = await db.get('SELECT id FROM auctions WHERE id = $1', [req.params.id]);
    if (!auction) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Auction not found.' } });
    await db.run(
      `INSERT INTO auction_watchlist (id, auction_id, user_id, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [crypto.randomUUID(), auction.id, req.user.id, nowIso()]
    );
    res.status(201).json({ ok: true, watching: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/auctions/:id/watch — remove from watchlist.
router.delete('/:id/watch', requireAuth, async (req, res, next) => {
  try {
    await db.run('DELETE FROM auction_watchlist WHERE auction_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true, watching: false });
  } catch (err) {
    next(err);
  }
});

// POST /api/auctions/:id/settle — buyer + seller confirm the exchange
// (items 572/573). Auctions have no 'ended' status — ended is time-based
// (ends_at passed). Each side confirms once; when both have, the auction
// is marked settled.
router.post('/:id/settle', requireActive, async (req, res, next) => {
  try {
    const auction = await db.get('SELECT * FROM auctions WHERE id = $1', [req.params.id]);
    if (!auction) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Auction not found.' } });
    if (auction.status !== 'approved') {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'Only an approved auction can be settled.' } });
    }
    if (new Date(auction.ends_at).getTime() > Date.now()) {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'This auction has not ended yet.' } });
    }
    const winner = await db.get(
      'SELECT bidder_id FROM auction_bids WHERE auction_id = $1 ORDER BY amount_minor DESC, created_at ASC LIMIT 1',
      [auction.id]
    );
    if (!winner) {
      return res.status(409).json({ error: { code: 'INVALID_STATE', message: 'This auction had no bids.' } });
    }
    const isBuyer = winner.bidder_id === req.user.id;
    const isSeller = auction.user_id === req.user.id;
    if (!isBuyer && !isSeller) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the buyer or seller can confirm settlement.' } });
    }
    const col = isBuyer ? 'buyer_settled' : 'seller_settled';
    await db.run(`UPDATE auctions SET ${col} = 1 WHERE id = $1`, [auction.id]);
    const updated = await db.get('SELECT * FROM auctions WHERE id = $1', [auction.id]);
    let settled = false;
    if (updated.buyer_settled === 1 && updated.seller_settled === 1 && !updated.settled_at) {
      await db.run('UPDATE auctions SET settled_at = $1 WHERE id = $2', [nowIso(), auction.id]);
      settled = true;
      const otherId = isBuyer ? auction.user_id : winner.bidder_id;
      await createNotification(
        otherId, 'auction_settled', 'Auction settled',
        `The auction for ${auction.title} is now settled — both sides confirmed.`,
        `#/auction/${auction.id}`
      );
    }
    await logAudit('user', req.user.id, 'auction_settle_confirmed', 'auction', auction.id, { side: isBuyer ? 'buyer' : 'seller' });
    res.json({
      ok: true, settled,
      buyerSettled: updated.buyer_settled === 1,
      sellerSettled: updated.seller_settled === 1,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
