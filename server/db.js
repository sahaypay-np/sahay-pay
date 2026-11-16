// Sahay Pay — database adapter.
// Postgres (pg Pool) when DATABASE_URL is set; otherwise Node 24 built-in
// node:sqlite (DatabaseSync) with a local file at data/sahay-pay.db.
// Same interface either way: query(text, params) -> {rows}, plus get()/run()
// conveniences and migrate() which runs the matching schema file at startup.
// SQL is written with $1-style placeholders; the SQLite path translates them
// to ?. Money is integer minor units (paisa). IDs are crypto.randomUUID.
// Timestamps are TEXT ISO-8601 UTC, generated in JS.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const usePostgres = Boolean(process.env.DATABASE_URL);

let pool = null;
let sqliteDb = null;

if (usePostgres) {
  const { Pool } = require('pg');
  // Explicit pool limits + timeouts (checklist item 220): the free-tier
  // Supabase DB is small, so cap connections and fail slow queries fast
  // instead of hanging a serverless invocation.
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30 * 1000,
    connectionTimeoutMillis: 10 * 1000,
    statement_timeout: 30 * 1000,
  });
  pool.on('error', (err) => console.error('[db] pg pool error:', err.message));
} else {
  const { DatabaseSync } = require('node:sqlite');
  const dataDir = path.join(ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  sqliteDb = new DatabaseSync(path.join(dataDir, 'sahay-pay.db'));
  sqliteDb.exec('PRAGMA foreign_keys = ON;');
  sqliteDb.exec('PRAGMA journal_mode = WAL;');
}

function toSqlitePlaceholders(text) {
  return text.replace(/\$(\d+)/g, '?');
}

// Translate $N placeholders to ? AND expand params in order of appearance,
// so a placeholder reused in one query (e.g. $1 twice) still binds correctly
// on SQLite (Postgres natively supports reuse; positional ? does not).
function translateSqlite(text, params) {
  const newParams = [];
  const sql = text.replace(/\$(\d+)/g, (m, n) => {
    newParams.push(params[Number(n) - 1]);
    return '?';
  });
  return { sql, params: newParams };
}

// Does this statement return rows? SELECT/WITH, or anything with RETURNING.
function returnsRows(text) {
  const t = text.trim();
  return /^(SELECT|WITH)\b/i.test(t) || /\bRETURNING\b/i.test(t);
}

async function query(text, params = []) {
  if (usePostgres) {
    const res = await pool.query(text, params);
    return { rows: res.rows };
  }
  const { sql, params: sqliteParams } = translateSqlite(text, params);
  const stmt = sqliteDb.prepare(sql);
  if (returnsRows(text)) {
    return { rows: stmt.all(...sqliteParams) };
  }
  const info = stmt.run(...sqliteParams);
  return { rows: [], changes: info.changes, lastInsertRowid: info.lastInsertRowid };
}

async function get(text, params = []) {
  const { rows } = await query(text, params);
  return rows[0] || null;
}

async function run(text, params = []) {
  return query(text, params);
}

// Default settings (config, NOT content — no seeded/demo/fake data).
// fee_mode: supporter_fee is ACTIVE by default; zero_fee_plus_tip is staged
// behind the admin toggle (improvement-loop run 2). The owner flips it.
const DEFAULT_SETTINGS = {
  fee_mode: 'supporter_fee',
  fee_config: JSON.stringify({
    NPR: { flatMinor: 16000, thresholdMinor: 160000, percent: 10, minMinor: 16000 },
    INR: { flatMinor: 10000, thresholdMinor: 100000, percent: 10, minMinor: 10000 },
  }),
  brand_packages: JSON.stringify([
    { id: 'free', name: 'Free', priceNPRMinor: 0, priceINRMinor: 0, note: 'Charity / community asks only, where the owner enables it.' },
    { id: 'plus', name: 'Plus', priceNPRMinor: 99900, priceINRMinor: 59900, note: 'One brand connection.' },
    { id: 'campaign', name: 'Campaign Partner', priceNPRMinor: 499900, priceINRMinor: 299900, note: 'Campaign partnership.' },
  ]),
  founder_tip_config: JSON.stringify({
    enabled: true,
    optionsPercent: [0, 5, 10],
    defaultPercent: 0,
    note: 'Optional founder contribution. Default is No thanks; never added silently.',
  }),
  payment_methods: JSON.stringify({
    NP: [
      { id: 'esewa', name: 'eSewa', enabled: true },
      { id: 'khalti', name: 'Khalti', enabled: true },
      { id: 'connectips', name: 'connectIPS', enabled: true },
      { id: 'bank_np', name: 'Bank transfer (Nepal)', enabled: true },
      { id: 'fonepay_qr', name: 'Fonepay QR', enabled: true },
    ],
    IN: [
      { id: 'upi', name: 'UPI', enabled: true },
      { id: 'bank_in', name: 'Bank transfer (India)', enabled: true },
      { id: 'payment_link', name: 'Payment link', enabled: true },
    ],
  }),
  categories: JSON.stringify([
    'Electricity', 'Water', 'Internet', 'Education', 'Medical expenses', 'Rent',
    'Housing', 'Mobile recharge', 'Food & essentials', 'Transportation',
    'Family expenses', 'Emergency expenses', 'Small business', 'Veterinary',
    'Government fees', 'Charity', 'Other',
  ]),
  min_gift_minor: '1000',
};

async function getSetting(key) {
  const row = await get('SELECT value FROM settings WHERE key = $1', [key]);
  return row ? row.value : null;
}

async function getSettingJson(key, fallback = null) {
  const raw = await getSetting(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function setSetting(key, value) {
  await run(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}

// Load a schema file, tolerating serverless bundlers that relocate files:
// locally (and on Vercel) it sits next to this file; on Netlify Functions
// the .sql files ship via netlify.toml included_files at <bundle>/server/,
// and the function runs with cwd = the bundle dir.
function loadSchema(filename) {
  const candidates = [
    path.join(__dirname, filename),
    path.join(process.cwd(), 'server', filename),
    path.join(process.cwd(), filename),
  ];
  for (const p of candidates) {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch { /* try next */ }
  }
  throw new Error(`schema file not found: ${filename}`);
}

// Additive column migration for databases created before these columns
// existed (CREATE TABLE IF NOT EXISTS never alters an existing table).
// A duplicate-column error just means the column is already there.
const EXTRA_COLUMNS = [
  ['users', 'prefs_json', "TEXT DEFAULT '{}'"],
  ['bills', 'anonymous', 'INTEGER NOT NULL DEFAULT 0'],
  ['payout_methods', 'meta_json', "TEXT DEFAULT '{}'"],
  ['users', 'recovery_code_hash', 'TEXT'],
  ['users', 'recovery_code_lookup', 'TEXT'],
  ['users', 'terms_accepted_version', 'TEXT'],
  ['users', 'terms_accepted_at', 'TEXT'],
  ['users', 'privacy_accepted_version', 'TEXT'],
  ['users', 'privacy_accepted_at', 'TEXT'],
  ['sessions', 'csrf_token', 'TEXT'],
  ['sessions', 'user_agent', 'TEXT'],
  ['admin_sessions', 'csrf_token', 'TEXT'],
  ['admin_sessions', 'last_seen_at', 'TEXT'],
];

// Cold-start mitigation (checklist priority fix (g)): the full migrate is
// ~20 statements (schema + ALTER probes + settings seeds). On a serverless
// cold start each round trip costs, so when the stored schema hash matches
// the current schema file + column list, skip the whole migrate with a
// single cheap probe. The hash is written only AFTER a successful full
// migrate, so a failed or partial migrate is retried on the next boot,
// and a fresh DB (no settings table yet) always runs the full path.
async function migrate() {
  const schemaFile = usePostgres ? 'schema.postgres.sql' : 'schema.sqlite.sql';
  const sql = loadSchema(schemaFile);
  const schemaHash = require('crypto')
    .createHash('sha256')
    .update(sql)
    .update(JSON.stringify(EXTRA_COLUMNS))
    .digest('hex');
  try {
    const stored = await getSetting('schema_hash');
    if (stored === schemaHash) {
      console.log(`[db] schema current (hash ${schemaHash.slice(0, 8)}), migrate skipped`);
      return;
    }
  } catch {
    // No settings table yet (fresh DB) — run the full migrate below.
  }
  if (usePostgres) {
    await pool.query(sql);
  } else {
    sqliteDb.exec(sql);
  }
  for (const [table, column, ddl] of EXTRA_COLUMNS) {
    try {
      await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      console.log(`[db] added column ${table}.${column}`);
    } catch (err) {
      if (!/duplicate column|already exists/i.test(err.message)) throw err;
    }
  }
  // Seed config defaults only (no content rows, ever).
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await run(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO NOTHING',
      [key, value]
    );
  }
  await setSetting('schema_hash', schemaHash);
  console.log(`[db] migrated (${usePostgres ? 'postgres' : 'sqlite'})`);
}

function close() {
  if (pool) return pool.end();
  if (sqliteDb) sqliteDb.close();
  return Promise.resolve();
}

module.exports = {
  query,
  get,
  run,
  migrate,
  close,
  getSetting,
  getSettingJson,
  setSetting,
  isPostgres: usePostgres,
};
