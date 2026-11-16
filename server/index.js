// Sahay Pay — server entry point.
// Express 5 app: serves public/ (vanilla SPA, no build step) + JSON API under /api.
// Port from PORT env (default 3000). DB: Postgres when DATABASE_URL is set,
// otherwise local SQLite (data/sahay-pay.db). Schema migrates at startup.
// No seeded/demo/fake data anywhere. Demo Mode: no real payment integration.

'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const db = require('./db');
const { attachUser, verifyOrigin, verifyCsrf } = require('./lib/auth');
const { maintenanceGate, freezeGate } = require('./lib/maintenance');
const { sanitizeText } = require('./lib/sanitize');
const { payoutKeySource, PUBLIC_DIR } = require('./lib/storage');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render/Koyeb sit behind a proxy; req.ip is the client

// Minimal cookie parsing (no cookie-parser dependency — only express, pg, multer).
app.use((req, res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      try {
        req.cookies[name] = decodeURIComponent(value);
      } catch {
        req.cookies[name] = value;
      }
    }
  }
  next();
});

app.use(express.json({ limit: '1mb' }));

// Attach the user (if any) to every request; routes decide whether auth is required.
app.use(attachUser);

// Maintenance kill switch (item 194): 503s the API (except health + admin)
// while maintenance_mode is on. Then Origin/Referer verification (item 130)
// and CSRF synchronizer tokens (item 129) for state-changing API requests.
app.use(maintenanceGate);
app.use(freezeGate);
app.use(verifyOrigin);
app.use(verifyCsrf);

// --- API routes ---
app.use('/api', require('./routes/public')); // /api/config, /api/feed, /api/leaders
app.use('/api/auth', require('./routes/auth'));
app.use('/api/profile', require('./routes/profile'));
const billsRouter = require('./routes/bills');
app.use('/api/bills', billsRouter);
app.use('/api/uploads', billsRouter.uploadsRouter);
app.use('/api/gifts', require('./routes/gifts'));
app.use('/api/verification', require('./routes/verification'));
app.use('/api/brands', require('./routes/brands'));
app.use('/api/auctions', require('./routes/auctions'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api', require('./routes/reports')); // /api/reports, /api/complaints
app.use('/api/admin', require('./routes/admin'));
app.use('/api/bridge', require('./routes/bridge'));

// Health check (no auth, no data).
app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'Sahay Pay', demoMode: true, db: db.isPostgres ? 'postgres' : 'sqlite' });
});

// Public uploaded images (redacted bill photos, avatars, support photos).
// Served from the same resolved dir multer writes to (/tmp on Vercel).
app.use('/uploads/public', express.static(PUBLIC_DIR, { maxAge: '7d' }));

// security.txt (RFC 9116): express.static ignores dotfiles by default, so
// serve /.well-known/security.txt explicitly. Netlify serves it from
// public/ directly; this keeps local/dev behaviour identical to live.
app.get('/.well-known/security.txt', (req, res) => {
  res.type('text/plain').sendFile(path.join(ROOT, 'public', '.well-known', 'security.txt'), { dotfiles: 'allow' });
});

// Frontend SPA (built by the frontend agent; served as-is here).
app.use(express.static(path.join(ROOT, 'public')));

// SPA fallback: any non-API GET serves index.html when it exists.
app.get(/^\/(?!api\/).*/, (req, res, next) => {
  const index = path.join(ROOT, 'public', 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  next();
});

// Unknown API route.
app.use('/api', (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'API route not found.' } });
});

// Central error handler: always the {error:{code,message}} shape.
// Item 836: error text is sanitized before it is logged or returned, so a
// payout account number can never leak into a log line or error message.
app.use((err, req, res, _next) => {
  console.error('[error]', sanitizeText(err && err.stack ? err.stack : String(err)));
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON.' } });
  }
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } });
});

async function start() {
  await db.migrate();
  if (!process.env.SESSION_SECRET) {
    console.error(
      '[SECURITY WARNING] SESSION_SECRET is not set. Set it before any real use ' +
        '(sessions still work, but payout-key derivation falls back to an ephemeral key).'
    );
  }
  console.log(`[sahay-pay] payout encryption key source: ${payoutKeySource}`);
  console.log(`[sahay-pay] demo mode: ON (no real payment integration)`);
  // Express wires this callback to both 'listening' and 'error' (once):
  // on a bind failure (e.g. port already in use) it receives the error —
  // fail loudly instead of printing "listening" and exiting 0.
  app.listen(PORT, (err) => {
    if (err) {
      console.error(`[sahay-pay] FATAL: could not listen on port ${PORT}: ${err.message}`);
      process.exit(1);
    }
    console.log(`[sahay-pay] listening on http://localhost:${PORT} (db: ${db.isPostgres ? 'postgres' : 'sqlite'})`);
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('[fatal] failed to start:', err);
    process.exit(1);
  });
}

module.exports = app;
