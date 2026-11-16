-- Sahay Pay — SQLite schema (local dev fallback, Node 24 node:sqlite).
-- Same tables as schema.postgres.sql; dialect differences only.
-- IDs: TEXT (crypto.randomUUID). Timestamps: TEXT ISO-8601 UTC.
-- Money: INTEGER minor units (paisa). Booleans: INTEGER 0/1.
-- JSON: TEXT (stringify/parse in JS).
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
  recovery_code_hash TEXT,
  recovery_code_lookup TEXT,
  terms_accepted_version TEXT,
  terms_accepted_at TEXT,
  privacy_accepted_version TEXT,
  privacy_accepted_at TEXT,
  suspended INTEGER NOT NULL DEFAULT 0,
  referral_code TEXT,
  referred_by TEXT,
  suspended_until TEXT,
  suspension_reason TEXT DEFAULT '',
  admin_notes TEXT DEFAULT '',
  trusted_poster INTEGER NOT NULL DEFAULT 0,
  watchlist INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  csrf_token TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
-- NOTE: idx_users_recovery (users.recovery_code_lookup) is NOT created here:
-- on an existing DB the CREATE TABLE above is a no-op, so the column does
-- not exist yet when this file runs. migrate() in server/db.js creates it
-- after the EXTRA_COLUMNS ALTERs (see the 2026-11-16 live-502 fix).

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
  for_whom TEXT DEFAULT 'myself',
  relationship TEXT DEFAULT '',
  for_other_consent INTEGER NOT NULL DEFAULT 0,
  about_me TEXT DEFAULT '',
  biller_instructions TEXT DEFAULT '',
  photos_json TEXT DEFAULT '[]',
  story_lang TEXT DEFAULT 'en',
  not_paid_consequence TEXT DEFAULT '',
  tried_to_pay TEXT DEFAULT '',
  money_means TEXT DEFAULT '',
  bill_type_other TEXT DEFAULT '',
  charity_name TEXT DEFAULT '',
  business INTEGER NOT NULL DEFAULT 0,
  business_name TEXT DEFAULT '',
  business_desc TEXT DEFAULT '',
  dream INTEGER NOT NULL DEFAULT 0,
  dream_desc TEXT DEFAULT '',
  expires_at TEXT,
  extension_used INTEGER NOT NULL DEFAULT 0,
  repost_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bills_feed ON bills(status, country, created_at);
CREATE INDEX IF NOT EXISTS idx_bills_user ON bills(user_id, status);

CREATE TABLE IF NOT EXISTS bill_edits (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  changed_fields TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bill_edits_bill ON bill_edits(bill_id, created_at);

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
  severity TEXT DEFAULT 'low',
  assigned_to TEXT DEFAULT '',
  needs_legal INTEGER NOT NULL DEFAULT 0,
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
  deliver_at TEXT,
  broadcast_id TEXT,
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
  severity TEXT DEFAULT 'low',
  assigned_to TEXT DEFAULT '',
  needs_legal INTEGER NOT NULL DEFAULT 0,
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
  prev_hash TEXT,
  entry_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  admin_user_id TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  csrf_token TEXT,
  last_seen_at TEXT
);

-- DB-backed rate-limit buckets (survive serverless cold starts).
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  reset_at TEXT NOT NULL,
  violations INTEGER NOT NULL DEFAULT 0
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

-- Phase 2 (sections 7–8): messaging, thank-you notes, announcements,
-- appeals, case notes, per-admin accounts + invites, webhook delivery log,
-- broadcasts, audit archive.
CREATE TABLE IF NOT EXISTS message_threads (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  supporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  poster_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_bill ON message_threads(bill_id, supporter_id);
CREATE INDEX IF NOT EXISTS idx_threads_poster ON message_threads(poster_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_threads_supporter ON message_threads(supporter_id, updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS thank_you_notes (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  gift_id TEXT NOT NULL REFERENCES gifts(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thanks_bill ON thank_you_notes(bill_id, created_at);
CREATE INDEX IF NOT EXISTS idx_thanks_recipient ON thank_you_notes(recipient_id, created_at);

CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  publish_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_announcements_publish ON announcements(publish_at, created_at);

CREATE TABLE IF NOT EXISTS appeals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  explanation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  decision_note TEXT DEFAULT '',
  decided_by TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_appeals_status ON appeals(status, created_at);

CREATE TABLE IF NOT EXISTS case_notes (
  id TEXT PRIMARY KEY,
  case_type TEXT NOT NULL,
  case_id TEXT NOT NULL,
  admin_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_notes_case ON case_notes(case_type, case_id, created_at);

CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'moderator',
  pin_hash TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS admin_invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'moderator',
  created_by TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  target_url TEXT NOT NULL,
  payload_kind TEXT NOT NULL DEFAULT 'review_packet',
  status_code INTEGER,
  error TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_created ON webhook_deliveries(created_at);

CREATE TABLE IF NOT EXISTS broadcasts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  audience_json TEXT NOT NULL DEFAULT '{}',
  recipient_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_archive (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  meta_json TEXT DEFAULT '{}',
  prev_hash TEXT,
  entry_hash TEXT,
  created_at TEXT NOT NULL,
  archived_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_archive_created ON audit_archive(created_at);
