-- Sahay Pay — wipe test data from the LIVE Supabase database after a
-- live-safe smoke run (tests/smoke-live.sh) or a launch check.
-- Run in the Supabase SQL editor. ONLY deletes the known test display
-- names — real users (e.g. danish) are untouched. FK cascades remove the
-- test users' bills, payout methods, gifts, sessions, verifications,
-- brands, auctions, bids, notifications, reports and complaints;
-- review_packets and audit_logs have no FK, so they are deleted explicitly.
--
-- STEP 1 — verify: this must return ONLY the test users (4 rows max).
SELECT id, display_name, username, created_at FROM users
WHERE display_name IN ('Launch Check', 'Test Poster', 'Test Helper', 'Reporter Raj');

-- STEP 2 — delete (only if step 1 showed exactly the test users).
DELETE FROM audit_logs
WHERE actor_id IN (SELECT id FROM users WHERE display_name IN ('Launch Check', 'Test Poster', 'Test Helper', 'Reporter Raj'))
   OR target_id IN (SELECT id FROM bills WHERE user_id IN (SELECT id FROM users WHERE display_name IN ('Launch Check', 'Test Poster', 'Test Helper', 'Reporter Raj')));
DELETE FROM review_packets
WHERE target_id IN (SELECT id FROM bills WHERE user_id IN (SELECT id FROM users WHERE display_name IN ('Launch Check', 'Test Poster', 'Test Helper', 'Reporter Raj')));
DELETE FROM users
WHERE display_name IN ('Launch Check', 'Test Poster', 'Test Helper', 'Reporter Raj');

-- STEP 3 — verify: bills, users and packets counts after the wipe.
SELECT (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM bills) AS bills,
       (SELECT COUNT(*) FROM review_packets) AS packets,
       (SELECT COUNT(*) FROM audit_logs) AS audit_rows;
