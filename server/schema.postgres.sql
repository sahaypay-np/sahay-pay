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
  recovery_code_hash TEXT,
  recovery_code_lookup TEXT,
  terms_accepted_version TEXT,
  terms_accepted_at TEXT,
  privacy_accepted_version TEXT,
  privacy_accepted_at TEXT,
  suspended INTEGER NOT NULL DEFAULT 0,
  suspended_reason TEXT DEFAULT '',
  suspended_until TEXT,
  suspended_at TEXT,
  cover_url TEXT,
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
  share_count INTEGER NOT NULL DEFAULT 0,
  doc_hash TEXT,
  ahash TEXT,
  fraud_score INTEGER,
  fraud_band TEXT,
  fraud_override TEXT,
  fraud_override_reason TEXT DEFAULT '',
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
  anonymous INTEGER NOT NULL DEFAULT 0,
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
  doc_hash TEXT,
  doc_type TEXT DEFAULT '',
  reviewer_note TEXT DEFAULT '',
  expires_at TEXT,
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
  visual_url TEXT,
  tags TEXT DEFAULT '',
  closed_at TEXT,
  thank_you_note TEXT DEFAULT '',
  expires_at TEXT,
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
  industry TEXT DEFAULT '',
  offer TEXT DEFAULT '',
  work_email TEXT DEFAULT '',
  requester_id TEXT,
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
  min_increment_minor INTEGER,
  currency TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review',
  buyer_settled INTEGER NOT NULL DEFAULT 0,
  seller_settled INTEGER NOT NULL DEFAULT 0,
  settled_at TEXT,
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
  decision TEXT DEFAULT '',
  decision_reason TEXT DEFAULT '',
  decided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);

CREATE TABLE IF NOT EXISTS complaints (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT DEFAULT '',
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

-- Phase 2 sections 4–6: follows, blocks, achievements, thank-yous,
-- receiver stories, registered brands, messaging, drops, CSR,
-- partnerships, appeals, sign-in history, fraud flags, auction
-- watchlist, scam notices, anonymised deletion stats.
CREATE TABLE IF NOT EXISTS follows (
  id TEXT PRIMARY KEY,
  follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE(follower_id, followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);

CREATE TABLE IF NOT EXISTS user_blocks (
  id TEXT PRIMARY KEY,
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE(blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON user_blocks(blocker_id);

CREATE TABLE IF NOT EXISTS achievements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  awarded_at TEXT NOT NULL,
  UNIQUE(user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_achievements_user ON achievements(user_id);

CREATE TABLE IF NOT EXISTS thanks (
  id TEXT PRIMARY KEY,
  gift_id TEXT NOT NULL REFERENCES gifts(id) ON DELETE CASCADE,
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  giver_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL DEFAULT '',
  video_url TEXT,
  video_duration_sec INTEGER,
  status TEXT NOT NULL DEFAULT 'pending_review',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thanks_giver ON thanks(giver_id, status);
CREATE INDEX IF NOT EXISTS idx_thanks_bill ON thanks(bill_id, status);

CREATE TABLE IF NOT EXISTS thank_reactions (
  id TEXT PRIMARY KEY,
  thank_id TEXT NOT NULL REFERENCES thanks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(thank_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_thank_reactions_thank ON thank_reactions(thank_id);

CREATE TABLE IF NOT EXISTS receiver_stories (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_bill ON receiver_stories(bill_id, status);

CREATE TABLE IF NOT EXISTS brand_profiles (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  industry TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL,
  city TEXT DEFAULT '',
  website TEXT DEFAULT '',
  description TEXT DEFAULT '',
  logo_url TEXT,
  email TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending_review',
  verified INTEGER NOT NULL DEFAULT 0,
  rejection_reason TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brand_profiles_status ON brand_profiles(status, created_at);
CREATE INDEX IF NOT EXISTS idx_brand_profiles_owner ON brand_profiles(owner_id);

CREATE TABLE IF NOT EXISTS brand_responses (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  brand_profile_id TEXT REFERENCES brand_profiles(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brand_responses_ask ON brand_responses(brand_id, created_at);

CREATE TABLE IF NOT EXISTS message_threads (
  id TEXT PRIMARY KEY,
  brand_profile_id TEXT NOT NULL REFERENCES brand_profiles(id) ON DELETE CASCADE,
  ask_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  asker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(brand_profile_id, ask_id)
);
CREATE INDEX IF NOT EXISTS idx_threads_brand ON message_threads(brand_profile_id);
CREATE INDEX IF NOT EXISTS idx_threads_asker ON message_threads(asker_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS partnerships (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  org_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  proposal TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_partnerships_status ON partnerships(status, created_at);

CREATE TABLE IF NOT EXISTS drops (
  id TEXT PRIMARY KEY,
  brand_profile_id TEXT REFERENCES brand_profiles(id) ON DELETE SET NULL,
  brand_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  product TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 1,
  eligibility TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'upcoming',
  winner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  drawn_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_drops_status ON drops(status, created_at);

CREATE TABLE IF NOT EXISTS drop_entries (
  id TEXT PRIMARY KEY,
  drop_id TEXT NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE(drop_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_drop_entries_drop ON drop_entries(drop_id);

CREATE TABLE IF NOT EXISTS csr_updates (
  id TEXT PRIMARY KEY,
  brand_profile_id TEXT NOT NULL REFERENCES brand_profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_csr_brand ON csr_updates(brand_profile_id, status);

CREATE TABLE IF NOT EXISTS appeals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  reviewer_note TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_appeals_user ON appeals(user_id, status);
CREATE INDEX IF NOT EXISTS idx_appeals_target ON appeals(target_type, target_id);

CREATE TABLE IF NOT EXISTS signin_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signin_user ON signin_history(user_id, created_at);

CREATE TABLE IF NOT EXISTS fraud_flags (
  id TEXT PRIMARY KEY,
  bill_id TEXT,
  user_id TEXT,
  signal TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_fraud_flags_bill ON fraud_flags(bill_id, status);
CREATE INDEX IF NOT EXISTS idx_fraud_flags_status ON fraud_flags(status, created_at);

CREATE TABLE IF NOT EXISTS auction_watchlist (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auction_id TEXT NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, auction_id)
);
CREATE INDEX IF NOT EXISTS idx_watchlist_user ON auction_watchlist(user_id);

CREATE TABLE IF NOT EXISTS scam_notices (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS anon_stats (
  id TEXT PRIMARY KEY,
  currency TEXT NOT NULL,
  total_minor INTEGER NOT NULL DEFAULT 0,
  gifts INTEGER NOT NULL DEFAULT 0,
  bills_helped INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
