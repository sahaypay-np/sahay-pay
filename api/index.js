// Sahay Pay — Vercel serverless entry point.
// Vercel runs this file as a function: it exports the same Express app that
// server/index.js builds for long-running hosts, and runs db.migrate() once
// per cold start (idempotent: CREATE TABLE IF NOT EXISTS + guarded ALTERs +
// config upserts). Sessions are DB-backed, so logins survive across
// invocations. Uploads go to /tmp on Vercel (see server/lib/storage.js) and
// are ephemeral until object storage lands.

'use strict';

const db = require('../server/db');
const app = require('../server/index');

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

module.exports = async (req, res) => {
  await ensureReady();
  return app(req, res);
};
