-- Sahay Pay — Postgres schema (production).
-- Same tables as schema.sqlite.sql; dialect differences only.
-- IDs: TEXT (crypto.randomUUID). Timestamps: TEXT ISO-8601 UTC.
-- Money: INTEGER minor units (paisa). Booleans: INTEGER 0/1 (same as SQLite,
-- so SQL stays identical across dialects). JSON: TEXT (stringify/parse in JS).
-- NO seeded/demo/fake rows: only settings defaults (config, not content).

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  age INTEGER NOT NULL,
  country TEXT NOT NULL,
  city TEXT NOT NULL,
  about TEXT DEFAULT '',
  language TEXT NOT NULL DEFAULT 'en',
  photo_url TEXT,
  prefs_json TEXT DEFAULT '{}',
  suspended INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_code TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  company TEXT DEFAULT '',
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  covered_minor INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  story TEXT NOT NULL,
  details TEXT DEFAULT '',
  charity INTEGER NOT NULL DEFAULT 0,
  anonymous INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending_review',
  city TEXT DEFAULT '',
  country TEXT NOT NULL,
  photo_url TEXT,
  support_photo_url TEXT,
  private_proof_url TEXT,
  pay_direct INTEGER NOT NULL DEFAULT 0,
  biller_name TEXT DEFAULT '',
  biller_ref TEXT DEFAULT '',
  biller_destination TEXT DEFAULT '',
  views INTEGER NOT NULL DEFAULT 0,
  report_count INTEGER NOT NULL DEFAULT 0,
  rejection_reason TEXT DEFAULT '',
  changes_note TEXT DEFAULT '',
  approved_at TEXT,
  approved_by TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bills_feed ON bills(status, country, created_at);
CREATE INDEX IF NOT EXISTS idx_bills_user ON bills(user_id, status);

CREATE TABLE IF NOT EXISTS payout_methods (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  holder_name TEXT NOT NULL,
  account_enc TEXT NOT NULL,
  account_hint TEXT NOT NULL,
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payout_bill ON payout_methods(bill_id);

CREATE TABLE IF NOT EXISTS gifts (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  supporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  fee_minor INTEGER NOT NULL DEFAULT 0,
  tip_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'initiated',
  reference TEXT DEFAULT '',
  dispute_note TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  confirmed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_gifts_bill ON gifts(bill_id, status);
CREATE INDEX IF NOT EXISTS idx_gifts_supporter ON gifts(supporter_id, status);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bill_id TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted',
  doc_url TEXT,
  reviewer_note TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_verif_user ON verifications(user_id, status);

CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  display_name TEXT DEFAULT '',
  story TEXT NOT NULL,
  country TEXT NOT NULL,
  city TEXT DEFAULT '',
  contact_phone TEXT DEFAULT '',
  content_no_fee INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending_review',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brands_status ON brands(status, created_at);

CREATE TABLE IF NOT EXISTS brand_connects (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  brand_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  note TEXT DEFAULT '',
  plan TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auctions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  photo_url TEXT,
  category TEXT NOT NULL,
  country TEXT NOT NULL,
  start_bid_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auctions_status ON auctions(status, ends_at);

CREATE TABLE IF NOT EXISTS auction_bids (
  id TEXT PRIMARY KEY,
  auction_id TEXT NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  bidder_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_minor INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bids_auction ON auction_bids(auction_id, amount_minor);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read, created_at);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);

CREATE TABLE IF NOT EXISTS complaints (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_packets (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_packets_status ON review_packets(status, created_at);
