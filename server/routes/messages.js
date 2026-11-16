// Sahay Pay — safety-first in-app messaging (Phase 2 §7, items 681–691).
// One thread per bill + giver; a thread opens ONLY after a gift has been
// started on that bill (682). Messages are filtered server-side (685):
// phone numbers, bank details, and external payment links are blocked.
// No email, no external service — in-app only.
// Endpoints:
//   POST /api/messages/thread {billId, supporterId?} — open/create a thread
//   GET  /api/messages — inbox (threads with unread counts)
//   GET  /api/messages/unread-count
//   GET  /api/messages/can-message?billId= — bill-page button state (689)
//   GET  /api/messages/:threadId — thread + messages (marks read, 687)
//   POST /api/messages/:threadId — send (filtered, 685)
//   POST /api/messages/:threadId/block | /unblock — block/unblock (684)

'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { logAudit, nowIso } = require('../lib/audit');
const { requireAuth, requireActive, rateLimit } = require('../lib/auth');
const { cleanStr } = require('../lib/validate');
const { createNotification } = require('../lib/notify');

const router = express.Router();

// --- Message filter (item 685) ---
// Blocks: URLs, UPI IDs, phone numbers (NP/IN + generic 10+ digit runs),
// bank-account-like digit runs, IFSC codes, "account number" + digits.
// Returns the matched category or null. Deliberately conservative on
// plain words: "OTP" or "password" alone is allowed (people warn each
// other about scams); digits attached to them are not.
const FILTERS = [
  { category: 'link', re: /https?:\/\/|www\.[a-z0-9-]+/i },
  { category: 'link', re: /\b[a-z0-9._-]{2,}@[a-z]{2,}\b/i }, // UPI-style id
  { category: 'phone', re: /\+?977[\s-]?\d[\d\s-]{7,}/ },
  { category: 'phone', re: /\+?91[\s-]?\d[\d\s-]{8,}/ },
  { category: 'phone', re: /\b(?:98|97)\d{8}\b/ }, // Nepal mobile
  { category: 'phone', re: /\b[6-9]\d{9}\b/ }, // India mobile
  { category: 'bank', re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/ }, // IFSC
  { category: 'bank', re: /(?:account|acc\.?|a\/c)\s*(?:no|number|num)?\s*[:#]?\s*\d[\d\s-]{5,}/i },
  { category: 'bank', re: /(?:otp|mpin|pin|password)\s*(?:is|:|=)?\s*\d{4,}/i },
  { category: 'phone', re: /\b\d[\d\s-]{9,}\d\b/ }, // any 11+ digit run
];

function filterHit(body) {
  for (const f of FILTERS) {
    if (f.re.test(body)) return f.category;
  }
  return null;
}

async function getThreadForUser(threadId, userId) {
  const thread = await db.get('SELECT * FROM gift_threads WHERE id = $1', [threadId]);
  if (!thread) return null;
  if (thread.supporter_id !== userId && thread.poster_id !== userId) return null;
  return thread;
}

function publicThread(t, other, bill, unread) {
  return {
    id: t.id,
    billId: t.bill_id,
    billTitle: bill?.title || '',
    billStatus: bill?.status || '',
    otherUser: other ? { id: other.id, displayName: other.display_name, username: other.username } : null,
    blockedBy: t.blocked_by,
    lastMessageAt: t.updated_at,
    unreadCount: unread,
    createdAt: t.created_at,
  };
}

// POST /api/messages/thread — open (or find) the thread for a bill + giver.
// The caller is either the bill poster (passes supporterId) or the
// supporter (supporterId defaults to the caller). A gift row for the
// bill + supporter must exist, or the thread stays closed (682).
router.post('/thread', requireActive, rateLimit('message-thread', 20, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const billId = cleanStr(req.body?.billId, 64);
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [billId]);
    if (!bill) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
    const isPoster = bill.user_id === req.user.id;
    const supporterId = isPoster ? cleanStr(req.body?.supporterId, 64) : req.user.id;
    if (!supporterId) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'A supporter is required to open a thread.' } });
    }
    if (!isPoster && supporterId !== req.user.id) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only message about your own gifts.' } });
    }
    if (isPoster && supporterId === req.user.id) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'You cannot message yourself.' } });
    }
    // Gate (682): a gift must have been started on this bill by this supporter.
    const gift = await db.get(
      'SELECT id FROM gifts WHERE bill_id = $1 AND supporter_id = $2 LIMIT 1',
      [bill.id, supporterId]
    );
    if (!gift) {
      return res.status(403).json({
        error: { code: 'GIFT_REQUIRED', message: 'Messaging opens after a gift has been started on this bill.' },
      });
    }
    let thread = await db.get(
      'SELECT * FROM gift_threads WHERE bill_id = $1 AND supporter_id = $2',
      [bill.id, supporterId]
    );
    if (!thread) {
      const id = crypto.randomUUID();
      const now = nowIso();
      await db.run(
        `INSERT INTO gift_threads (id, bill_id, supporter_id, poster_id, blocked_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NULL, $5, $6)`,
        [id, bill.id, supporterId, bill.user_id, now, now]
      );
      thread = await db.get('SELECT * FROM gift_threads WHERE id = $1', [id]);
      await logAudit('user', req.user.id, 'message_thread_opened', 'message_thread', id, { billId: bill.id });
    }
    const otherId = thread.supporter_id === req.user.id ? thread.poster_id : thread.supporter_id;
    const other = await db.get('SELECT id, display_name, username FROM users WHERE id = $1', [otherId]);
    res.status(201).json({ thread: publicThread(thread, other, bill, 0) });
  } catch (err) {
    next(err);
  }
});

// GET /api/messages/can-message?billId= — bill-page button state (689).
router.get('/can-message', requireAuth, async (req, res, next) => {
  try {
    const bill = await db.get('SELECT * FROM bills WHERE id = $1', [req.query.billId]);
    if (!bill) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found.' } });
    if (bill.user_id === req.user.id) {
      return res.json({ canMessage: false, reason: 'own_bill' });
    }
    const gift = await db.get(
      'SELECT id FROM gifts WHERE bill_id = $1 AND supporter_id = $2 LIMIT 1',
      [bill.id, req.user.id]
    );
    if (!gift) return res.json({ canMessage: false, reason: 'gift_required' });
    const thread = await db.get(
      'SELECT id FROM gift_threads WHERE bill_id = $1 AND supporter_id = $2',
      [bill.id, req.user.id]
    );
    res.json({ canMessage: true, threadId: thread?.id || null });
  } catch (err) {
    next(err);
  }
});

// GET /api/messages/unread-count — inbox badge (688).
router.get('/unread-count', requireAuth, async (req, res, next) => {
  try {
    const row = await db.get(
      `SELECT COUNT(*) AS c FROM gift_thread_messages m JOIN gift_threads t ON t.id = m.thread_id
       WHERE m.is_read = 0 AND m.sender_id != $1
         AND (t.supporter_id = $1 OR t.poster_id = $1) AND m.hidden = 0`,
      [req.user.id]
    );
    res.json({ unreadCount: Number(row?.c || 0) });
  } catch (err) {
    next(err);
  }
});

// GET /api/messages — inbox (688: per-thread unread counts).
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT t.*, b.title AS bill_title, b.status AS bill_status
       FROM gift_threads t JOIN bills b ON b.id = t.bill_id
       WHERE t.supporter_id = $1 OR t.poster_id = $1
       ORDER BY t.updated_at DESC LIMIT 50`,
      [req.user.id]
    );
    const threads = [];
    for (const t of rows) {
      const otherId = t.supporter_id === req.user.id ? t.poster_id : t.supporter_id;
      const other = await db.get('SELECT id, display_name, username FROM users WHERE id = $1', [otherId]);
      const unread = await db.get(
        `SELECT COUNT(*) AS c FROM gift_thread_messages
         WHERE thread_id = $1 AND is_read = 0 AND sender_id != $2 AND hidden = 0`,
        [t.id, req.user.id]
      );
      const last = await db.get(
        'SELECT body, created_at FROM gift_thread_messages WHERE thread_id = $1 AND hidden = 0 ORDER BY created_at DESC LIMIT 1',
        [t.id]
      );
      threads.push({
        ...publicThread(t, other, { title: t.bill_title, status: t.bill_status }, Number(unread?.c || 0)),
        lastMessage: last ? { body: last.body, createdAt: last.created_at } : null,
      });
    }
    res.json({ threads });
  } catch (err) {
    next(err);
  }
});

// GET /api/messages/:threadId — thread + messages; marks the other party's
// messages read for the viewer (687: sent/seen receipts).
router.get('/:threadId', requireAuth, async (req, res, next) => {
  try {
    const thread = await getThreadForUser(req.params.threadId, req.user.id);
    if (!thread) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found.' } });
    const bill = await db.get('SELECT id, title, status FROM bills WHERE id = $1', [thread.bill_id]);
    const otherId = thread.supporter_id === req.user.id ? thread.poster_id : thread.supporter_id;
    const other = await db.get('SELECT id, display_name, username FROM users WHERE id = $1', [otherId]);
    // Mark the other party's messages as read.
    await db.run(
      'UPDATE gift_thread_messages SET is_read = 1 WHERE thread_id = $1 AND sender_id != $2 AND is_read = 0',
      [thread.id, req.user.id]
    );
    const { rows } = await db.query(
      `SELECT m.*, u.display_name AS sender_name
       FROM gift_thread_messages m JOIN users u ON u.id = m.sender_id
       WHERE m.thread_id = $1 ORDER BY m.created_at ASC LIMIT 200`,
      [thread.id]
    );
    res.json({
      thread: publicThread(thread, other, bill, 0),
      messages: rows.map((m) => ({
        id: m.id,
        senderId: m.sender_id,
        senderName: m.sender_name,
        // Item 690: hidden messages stay in the thread as placeholders
        // (the body is masked; the audit trail keeps the original).
        body: m.hidden === 1 ? '' : m.body,
        hidden: m.hidden === 1,
        isRead: m.is_read === 1,
        mine: m.sender_id === req.user.id,
        createdAt: m.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/messages/:threadId — send a message (filtered, 685).
router.post('/:threadId', requireActive, rateLimit('message-send', 60, 60 * 60 * 1000), async (req, res, next) => {
  try {
    const thread = await getThreadForUser(req.params.threadId, req.user.id);
    if (!thread) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found.' } });
    if (thread.blocked_by) {
      return res.status(403).json({ error: { code: 'THREAD_BLOCKED', message: 'This conversation is blocked.' } });
    }
    const body = cleanStr(req.body?.body, 1000);
    if (body.length < 1) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Write a message first.' } });
    }
    const hit = filterHit(body);
    if (hit) {
      const what = hit === 'link' ? 'links'
        : hit === 'phone' ? 'phone numbers'
          : 'bank details or codes';
      return res.status(400).json({
        error: {
          code: 'MESSAGE_BLOCKED',
          message: `For your safety, messages cannot contain ${what}. Keep payments inside Sahay Pay's gift flow — never share numbers or account details in chat.`,
        },
      });
    }
    const id = crypto.randomUUID();
    const now = nowIso();
    await db.run(
      `INSERT INTO gift_thread_messages (id, thread_id, sender_id, body, is_read, hidden, created_at)
       VALUES ($1, $2, $3, $4, 0, 0, $5)`,
      [id, thread.id, req.user.id, body, now]
    );
    await db.run('UPDATE gift_threads SET updated_at = $1 WHERE id = $2', [now, thread.id]);
    const otherId = thread.supporter_id === req.user.id ? thread.poster_id : thread.supporter_id;
    const bill = await db.get('SELECT title FROM bills WHERE id = $1', [thread.bill_id]);
    await createNotification(
      otherId, 'message_received', 'New message',
      `${req.user.displayName} sent you a message about "${bill?.title || 'your bill'}".`,
      `#/messages/${thread.id}`
    );
    res.status(201).json({
      message: {
        id, senderId: req.user.id, senderName: req.user.displayName,
        body, isRead: false, mine: true, createdAt: now,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/messages/:threadId/block — block this conversation (684).
router.post('/:threadId/block', requireAuth, async (req, res, next) => {
  try {
    const thread = await getThreadForUser(req.params.threadId, req.user.id);
    if (!thread) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found.' } });
    await db.run('UPDATE gift_threads SET blocked_by = $1 WHERE id = $2', [req.user.id, thread.id]);
    await logAudit('user', req.user.id, 'message_thread_blocked', 'message_thread', thread.id, {});
    res.json({ ok: true, blocked: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/messages/:threadId/unblock — unblock (only the blocker can).
router.post('/:threadId/unblock', requireAuth, async (req, res, next) => {
  try {
    const thread = await getThreadForUser(req.params.threadId, req.user.id);
    if (!thread) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found.' } });
    if (thread.blocked_by !== req.user.id) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the person who blocked this conversation can unblock it.' } });
    }
    await db.run('UPDATE gift_threads SET blocked_by = NULL WHERE id = $1', [thread.id]);
    res.json({ ok: true, blocked: false });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.filterHit = filterHit;
