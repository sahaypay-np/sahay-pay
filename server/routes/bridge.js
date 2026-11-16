// Sahay Pay — Muse owner-approval bridge.
// POST /api/bridge/approve {packetId, decision, reason}
// Header: X-Sahay-Bridge-Secret must match CLAUDE_APPROVAL_BRIDGE_SECRET.
// Same effect as the admin review action; audit-logged as actor "muse-bridge".
// When the secret is not configured, the bridge is disabled (503).
// This is how Muse turns danish's explicit YES/NO in chat into publication.

'use strict';

const express = require('express');
const crypto = require('crypto');
const { applyReviewDecision } = require('../lib/notify');
const { cleanStr } = require('../lib/validate');

const router = express.Router();

function secretsMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

router.post('/approve', async (req, res, next) => {
  try {
    const expected = process.env.CLAUDE_APPROVAL_BRIDGE_SECRET;
    if (!expected) {
      return res.status(503).json({
        error: { code: 'BRIDGE_DISABLED', message: 'The approval bridge is not configured (no bridge secret set).' },
      });
    }
    if (!secretsMatch(req.get('X-Sahay-Bridge-Secret'), expected)) {
      return res.status(401).json({ error: { code: 'BRIDGE_UNAUTHORIZED', message: 'Invalid bridge secret.' } });
    }
    const result = await applyReviewDecision(
      req.body?.packetId,
      req.body?.decision,
      cleanStr(req.body?.reason || '', 600),
      'muse-bridge',
      'muse-bridge'
    );
    if (!result.ok) {
      return res.status(result.status || 400).json({ error: { code: 'REVIEW_FAILED', message: result.error } });
    }
    res.json({ ok: true, packetStatus: result.packetStatus });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
