// Sahay Pay — Netlify Functions entry point.
// Same Express app as server/index.js, wrapped with serverless-http, with
// db.migrate() once per cold start (idempotent). Sessions are DB-backed, so
// logins survive across invocations. Uploads go to /tmp on Netlify (see
// server/lib/storage.js) and are ephemeral until object storage lands.
//
// Path handling: netlify.toml rewrites /api/* and /uploads/public/* to this
// function, preserving the original path after the function prefix
// (/.netlify/functions/api/api/...). Netlify may pass either the original
// path or the rewritten one in event.path — strip the function prefix when
// present so Express always sees the real route.
'use strict';

const serverless = require('serverless-http');
const db = require('../../server/db');
const app = require('../../server/index');

const handler = serverless(app, {
  // Binary responses (uploaded photos, PDFs) must be base64-encoded or API
  // Gateway mangles them as UTF-8. JSON/HTML stay plain text.
  binary: ['image/*', 'application/pdf', 'application/octet-stream'],
});
const FN_PREFIX = '/.netlify/functions/api';

let ready = null;
function ensureReady() {
  if (!ready) {
    ready = db.migrate().catch((err) => {
      ready = null; // let the next request retry the migration
      throw err;
    });
  }
  return ready;
}

module.exports.handler = async (event, context) => {
  await ensureReady();
  if (event.path && event.path.startsWith(FN_PREFIX)) {
    const rest = event.path.slice(FN_PREFIX.length);
    event.path = rest === '' ? '/' : rest;
  }
  return handler(event, context);
};
