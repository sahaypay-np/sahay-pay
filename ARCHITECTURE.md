# Sahay Pay — Standalone Build: Architecture & API Contract

Public rebuild of Sahay Pay (Nepal + India bill-support platform) as a standalone
deployable web app. Source of truth for product behaviour:
`~/workspace/your_files/sahay-pay-ultra-master-prompt/sahay-pay-ultra-master-prompt.md`
(Part C = build spec; Section 0 standing decisions override everything).
Current-build context: `~/workspace/sahay-pay/improvement-log.md` (runs 1–4).

## Standing rules (never break)
- Name: **Sahay Pay**. Tagline: "Small acts. Real help."
- **NO Gmail/Google/email login, no password, no OTP.** Profiles from simple
  questions only (display name, age, country, city, about, language, optional photo).
- **18+ hard block** — under 18 creates NO profile row.
- **30-day persistent login** (opaque session token, hashed server-side, sliding renewal).
- **Nothing public without owner approval.** Posts start `pending_review`, are
  invisible in feed/search/detail/share until approved. AI never approves.
- **NO fakes ever.** No seeded/demo data in the shipped DB. Honest empty states.
- **Real payout account always collected** for the chosen method, validated,
  masked publicly (last 4 only), full details revealed to a helper only at the
  Send step (after the Check step), every reveal audit-logged.
- **Demo Mode honesty.** No real payment integration, no real money movement.
  Every payment surface labelled "Demo Mode". Never claim a payment succeeded.
  Never collect MPIN / OTP / passwords / banking credentials.
- **Sahay Pay never holds gift money.** Gifts move supporter → recipient (or
  supporter → biller) in the supporter's own payment app.
- Legal content is labelled "General information only — not legal advice".
- Money is stored as **integer minor units (paisa)** — never float.

## Stack
- Node.js 24, Express 5, `pg` (Postgres in production), `node:sqlite` (local dev
  fallback when no DATABASE_URL), `multer` (uploads). Crypto: Node built-in
  `crypto` (scrypt for admin PIN, AES-256-GCM for payout accounts, SHA-256 for
  session-token hashes). No other runtime dependencies unless justified.
- Single app: Express serves `public/` (vanilla HTML/CSS/JS SPA, no build step)
  + JSON API under `/api`. Port from `PORT` env (default 3000).
- Deploy: Render free or Koyeb free from a git repo (Dockerfile + render.yaml).
  Postgres from Supabase or Neon free tier (persistent, no card). No secrets in code.

## Layout
```
package.json  .env.example  .gitignore  Dockerfile  render.yaml  README.md
server/
  index.js            entry: express app, middleware, static, routes, start
  db.js               adapter: pg when DATABASE_URL set, else node:sqlite;
                      exports query(text, params) -> {rows}, get(), run(), migrate()
  schema.postgres.sql schema.sqlite.sql   (same tables; dialect differences only)
  lib/auth.js         user sessions + admin PIN (scrypt) + admin sessions + rate limit
  lib/validate.js     payout validators + shared input validation
  lib/fees.js         fee engine + quote
  lib/money.js        minor-unit format/parse (NPR रू / INR ₹)
  lib/audit.js        audit log helper
  lib/notify.js       in-app notifications + owner review-packet webhook
  lib/storage.js      uploads: local disk now (uploads/public, uploads/private);
                      S3-compatible path documented for production
  routes/*.js         public, auth, profile, bills, gifts, verification,
                      brands, auctions, notifications, reports, admin, bridge
public/
  index.html  css/app.css  js/app.js  js/i18n.js
tests/smoke.sh        curl smoke tests (written during verification)
```

## Database (same tables in both dialects)
IDs: TEXT (crypto.randomUUID). Timestamps: TEXT ISO-8601 UTC. Money: INTEGER minor units.
JSON stored as TEXT (stringify/parse in JS). Booleans: INTEGER 0/1 in SQLite, BOOLEAN in Postgres
(adapter normalises: use 0/1 in code, Postgres schema uses BOOLEAN with 0/1 literals — instead
use INTEGER 0/1 in BOTH schemas to keep SQL identical).

Tables:
- settings(key TEXT PK, value TEXT) — fee_mode, fee_config (JSON), brand_packages (JSON),
  founder_tip_config (JSON), payment_methods (JSON), admin_pin_hash, categories (JSON)
- users(id, display_name, username UNIQUE, age, country, city, about, language, photo_url,
  suspended INTEGER DEFAULT 0, created_at)
- sessions(token_hash TEXT PK, user_id, created_at, expires_at, last_seen_at)
- bills(id, user_id, request_code UNIQUE, title, category, company, amount_minor, currency,
  covered_minor DEFAULT 0, due_date, story, details, charity INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending_review', city, country, photo_url, support_photo_url,
  private_proof_url, pay_direct INTEGER DEFAULT 0, biller_name, biller_ref, biller_destination,
  views INTEGER DEFAULT 0, report_count INTEGER DEFAULT 0, rejection_reason, changes_note,
  approved_at, approved_by, completed_at, created_at, updated_at)
  status: draft|pending_review|approved|rejected|changes_requested|paused|completed|expired|under_investigation|removed
- payout_methods(id, bill_id, method, holder_name, account_enc TEXT, account_hint TEXT, created_at)
  method: esewa|khalti|connectips|bank_np|fonepay_qr|upi|bank_in|payment_link
- gifts(id, bill_id, supporter_id, amount_minor, currency, fee_minor, tip_minor,
  status TEXT DEFAULT 'initiated', reference, dispute_note, created_at, confirmed_at)
  status: initiated|details_shown|donor_reported_sent|verification_pending|confirmed|failed|disputed|reversed
- verifications(id, user_id, bill_id, type, status, doc_url, reviewer_note, created_at, decided_at)
  type: bill|id|name|biller ; status: submitted|under_review|approved|rejected|more_required
- brands(id, user_id, name, display_name, story, country, city, contact_phone, content_no_fee,
  status TEXT DEFAULT 'pending_review', created_at)
- brand_connects(id, brand_id, brand_name, contact_name, phone, note, plan, status, created_at)
- auctions(id, user_id, title, description, photo_url, category, country, start_bid_minor,
  currency, ends_at, status TEXT DEFAULT 'pending_review', created_at)
- auction_bids(id, auction_id, bidder_id, amount_minor, created_at)
- notifications(id, user_id, kind, title, body, link, is_read INTEGER DEFAULT 0, created_at)
- reports(id, reporter_id, target_type, target_id, reason, note, status TEXT DEFAULT 'open', created_at)
- complaints(id, user_id, subject, body, status TEXT DEFAULT 'open', created_at)
- audit_logs(id, actor_type, actor_id, action, target_type, target_id, meta_json, created_at)
- admin_sessions(token_hash TEXT PK, created_at, expires_at)
- review_packets(id, target_type, target_id, payload_json, status TEXT DEFAULT 'pending', created_at)
  target_type: bill|brand|auction|photo ; status: pending|approved|rejected|changes_requested

Feed/leaderboard indexes: bills(status, country, created_at), gifts(bill_id, status),
gifts(supporter_id, status), audit_logs(created_at).

## Fee engine (lib/fees.js)
- `feeMode` from settings: `supporter_fee` (ACTIVE by default) or `zero_fee_plus_tip` (staged).
- supporter_fee: NPR flat 16000 minor up to threshold 160000 minor, then 10%, min 16000;
  INR flat 10000 up to 100000, then 10%, min 10000. Charity: fee 0 always.
- zero_fee_plus_tip: fee 0; optional founder tip (None/5%/10%/Custom, default None).
- `quote(amountMinor, currency, charity, feeMode)` -> {feeMinor, totalMinor, feeMode}.
- Admin can switch feeMode (PIN-gated, audit-logged). UI states the live model in one sentence.

## Payout validation (lib/validate.js) — client AND server
- eSewa: 10-digit Nepali mobile, starts 97/98. Khalti: same mobile rule.
- UPI ID (VPA): `^[\w.\-]{2,}@[a-zA-Z]{2,}$` (e.g. name@okhdfc).
- Bank NP: bank name (2+ chars), account number (5–20 digits), holder name.
- Bank IN: account number (9–18 digits), IFSC `^[A-Z]{4}0[A-Z0-9]{6}$`, holder name.
- connectIPS: bank name, account number, holder name.
- Masked hint server-side: last 4 only, e.g. "eSewa account ····4567", "UPI ····@okhdfc".
- A bill cannot be submitted without ≥1 valid payout method (unless pay-direct only).

## API contract
- Base `/api`. JSON in/out. Success: the resource object (or `{ok:true,...}` for actions).
  Errors: `{error:{code,message}}` with HTTP status (400 validation, 401 unauth, 403 forbidden,
  404 not found, 409 conflict, 429 rate-limited).
- Auth: cookie `sp_session` (httpOnly, SameSite=Lax, Path=/, 30d, Secure in production).
  Admin: cookie `sp_admin` (httpOnly, 24h). Bridge: header `X-Sahay-Bridge-Secret`.
- Public (no auth): GET /api/config, GET /api/feed, GET /api/bills/:id (404 unless approved
  or owner/admin), GET /api/leaders, GET /api/brands, GET /api/brands/:id,
  GET /api/auctions, GET /api/auctions/:id.
- Auth: POST /api/auth/onboard {displayName, age, country, city, about, language}
  (age<18 -> 403 {code:'AGE_BLOCK'}, NO user row); GET /api/auth/me;
  POST /api/auth/logout; POST /api/auth/logout-all.
- Profile: GET/PATCH /api/profile/me; GET /api/profile/:username (public);
  POST /api/profile/delete.
- Bills: POST /api/bills (create draft or full; status draft|pending_review via submit flag);
  PATCH /api/bills/:id (material edit on approved bill -> back to pending_review);
  POST /api/bills/:id/submit; GET /api/bills/mine?status=; POST /api/bills/:id/complete;
  POST /api/bills/:id/remove; POST /api/bills/:id/payout (change payout -> re-review if approved);
  POST /api/uploads (multipart field `file`, `kind` = public_bill|private_proof|support|avatar|id_doc|qr).
- Gifts: POST /api/gifts/quote {billId, amountMinor}; POST /api/gifts {billId, amountMinor, tipMinor};
  POST /api/gifts/:id/reveal (returns payout details; audit-logged; only after Check);
  POST /api/gifts/:id/reported-sent {reference}; POST /api/gifts/:id/confirm (recipient only);
  POST /api/gifts/:id/not-received; POST /api/gifts/:id/dispute {note};
  GET /api/gifts/mine?type=given|received.
  Confirm: only recipient confirms; bill covered_minor increases (capped at amount);
  leaderboards count confirmed gifts ONLY.
- Verification: POST /api/verification {type, billId?, docUrl}; GET /api/verification/mine.
- Brands: POST /api/brands (ask -> pending_review); GET /api/brands/mine;
  POST /api/brands/:id/connect {brandName, contactName, phone, note, plan} (Demo Mode, no charge).
- Auctions: POST /api/auctions (-> pending_review); POST /api/auctions/:id/bid {amountMinor}
  (no self-bidding; must exceed current highest + min increment); GET /api/auctions/mine.
- Notifications: GET /api/notifications; POST /api/notifications/:id/read;
  POST /api/notifications/read-all.
- Reports: POST /api/reports {targetType, targetId, reason, note} — credible fraud reason
  on an approved bill immediately sets it under_investigation + hides from feed.
  POST /api/complaints {subject, body}.
- Admin (PIN session required; every action audit-logged):
  GET /api/admin/pin-status -> {pinSet}; POST /api/admin/setup-pin {pin} (only while unset);
  POST /api/admin/login {pin}; POST /api/admin/logout; POST /api/admin/change-pin {oldPin, newPin};
  GET /api/admin/metrics; GET /api/admin/queue?status=; POST /api/admin/review/:packetId
  {decision: approve|reject|changes, reason}; GET /api/admin/users;
  POST /api/admin/users/:id/suspend|restore; GET /api/admin/verifications;
  POST /api/admin/verifications/:id {decision, note}; GET /api/admin/reports;
  POST /api/admin/reports/:id {action: dismiss|hide|pause|remove|suspend};
  GET /api/admin/fees; PUT /api/admin/fees; GET /api/admin/methods; PUT /api/admin/methods;
  GET /api/admin/audit; GET /api/admin/gifts (status overview).
- Bridge (Muse approval): POST /api/bridge/approve {packetId, decision, reason}
  with X-Sahay-Bridge-Secret. Same effect as admin review; audit-logged as actor "muse-bridge".
- Owner webhook: on every new review packet, POST the packet JSON to
  OWNER_NOTIFICATION_WEBHOOK_URL if set (fire-and-forget, logged). If unset, packets
  simply wait in the admin queue. NOTHING auto-publishes.

## Feed ranking (GET /api/feed)
Approved bills only, never own bills, never already-swiped (client sends `seen` ids).
Score = verified boost + same-country boost + recency boost + fewer-supporters boost +
new-poster fairness boost. Sort param: recommended|newest|almost_funded|most_supported.
Filters: country, category (multi), amount band, verified only, pay-direct only, charity,
posted range. Cursor pagination (limit 20). Honest empty state when no matches.

## Frontend (public/)
Vanilla SPA, hash routing, no build step. iOS Liquid Glass: translucent glass cards
(backdrop-filter blur, thin borders, soft shadows), living gradient background,
floating glass tab dock (5 tabs: Swipe, Post, Leaders, Brands, My Bills), light + dark
mode (OS default + toggle), mobile-first, reduced-motion respected.
Screens (hash routes): #/splash, #/welcome, #/country, #/onboarding, #/age-block,
#/swipe, #/bill/:id, #/photo/:billId, #/post (6 steps), #/leaders, #/brands,
#/brand/:id, #/brand-new, #/auctions, #/auction/:id, #/mybills, #/profile/:username,
#/settings, #/help (6 topics: How helping works, How posting works, FAQ,
Complaints & appeals, Privacy Policy, Terms), #/notifications, #/verify,
#/gift/:billId (4 steps: Amount/Check/Send/Confirmed), #/founder-tip,
#/admin (login/setup), #/admin/dashboard, #/admin/queue, #/admin/users,
#/admin/verifications, #/admin/reports, #/admin/fees, #/admin/audit.
i18n: js/i18n.js with EN/NE/HI dictionaries for core UI strings; language from
onboarding, changeable in Settings; fallback EN. Money always with currency (रू/₹).
Cross-border help note (in gift flow + Help): India→Nepal UPI–NPI up to INR 200,000/txn;
Nepal→India INR 15,000/txn, INR 100,000/month, Indian citizens only; non-Indian citizens
check before helping an Indian bill (FCRA); "General information only — not legal advice".
Redaction step in post flow: user draws black-out rectangles on the bill photo (canvas);
the redacted image is the public version; original kept private. Must be confirmed before submit.
Every button performs its action. No decorative buttons. No fake data anywhere.

## Env vars (.env.example — names only)
DATABASE_URL, SESSION_SECRET, PAYOUT_ENCRYPTION_KEY, ADMIN_SETUP_TOKEN,
CLAUDE_APPROVAL_BRIDGE_SECRET, OWNER_NOTIFICATION_WEBHOOK_URL, APP_BASE_URL,
PORT, NODE_ENV. (Gateway keys ESEWA_*/KHALTI_*/INDIA_GATEWAY_* listed as
not-yet-configured; object-storage keys listed as future.)

## Security notes
- Parameterised queries everywhere. Input validation client AND server.
- Rate limits: onboarding, posting, gift create, report, bid, admin login (in-memory buckets).
- Uploads: images (jpg/png/webp) + PDF only, 5MB cap, random filenames, private files
  served only via authenticated reviewer/owner routes. Public images re-encoded via the
  client canvas step (strips EXIF).
- Payout accounts: AES-256-GCM encrypted at rest; key from PAYOUT_ENCRYPTION_KEY, else
  derived from SESSION_SECRET, else ephemeral (startup warning). Never in logs.
- Admin PIN: scrypt hash, fail-closed when unset (no PIN accepted), setup only once.

## Integration notes (2026-11-16, coordinator pass)

The backend and frontend were built in parallel from this document; the
reconciliation pass fixed the joins where they disagreed. The contract
below is what the code actually does now (verified by tests/contract.sh):

- **Payout methods**: request fields are `{method, holderName, account,
  bankName, branch, ifsc, qrUrl}` (`bank` accepted as an alias for
  `bankName`). Bank name + branch are stored in `payout_methods.meta_json`
  and returned by the reveal step. `POST /api/bills/:id/payout` takes
  `{payoutMethods: [...]}` (not a flat object).
- **Booleans are strict**: `charity`, `payDirect`, `anonymous`,
  `contentNoFee` must be JSON `true` — `1` does not count.
- **Anonymous posts**: `bills.anonymous`; public views mask the poster
  (`displayName: 'Anonymous'`, no username/photo). Owner/admin views are
  unmasked.
- **Feed**: filters `amountBand` (`band` alias), `payDirect`
  (`pay_direct` alias), `city` (substring, case-insensitive),
  `billShown`/`bill_shown` (photo present). Items carry `badges`,
  `payoutHints` and `payoutHint` (first hint string).
- **Leaders**: canonical `tab` = `top_supporters | most_received |
  top_bills | fully_paid | brands`, `period` = `7d | 30d | all`
  (aliases `supporters/received/bills/paid` and `7/30` accepted).
  Rows use camelCase (`totalMinor`, `gifts`, `billsHelped`,
  `supporters`, `billsPaid`). The brands tab returns `mostResponded`
  and `mostAsked`, not `leaders`.
- **Gift reveal** returns `payoutMethods` (array) + optional `payDirect`
  `{billerName, billerRef, billerDestination}` — not a single `payout`.
- **Fee config** shape is `{NPR: {flatMinor, thresholdMinor, percent,
  minMinor}, INR: {...}}`. `PUT /api/admin/fees` takes `{feeMode}` and/or
  `{feeConfig}` and/or `{founderTipConfig}` and/or `{minGiftMinor}`.
  `PUT /api/admin/methods` takes the whole `{paymentMethods}` object.
- **Profile**: `PATCH /api/profile/me` also accepts `country` (NP|IN)
  and prefs (`notifyPrefs`, `showTotals`, `anonDefault`, stored in
  `users.prefs_json`, returned as `user.prefs`). Onboarding accepts an
  uploaded `photoUrl`.
- **Notification `link` values are frontend hash routes** (`#/bill/:id`,
  `#/mybills`, `#/verify`, `#/settings`, `#/brand/:id`,
  `#/auction/:id`, `#/brands`, `#/auctions`) — never `/api/...` URLs.
- **Brand Connect**: paid plans (any plan other than `pay`/`free`)
  require a company-domain email in `workEmail` (legacy `email` also
  accepted). Brand list search param is `brand` (`q` also accepted).
- **Bill detail** includes `billerRef` + `billerDestination` (needed by
  the pay-direct sheet) and `poster.memberSince`. `PATCH /api/bills/:id`
  also accepts `privateProofUrl` and `anonymous` (both non-material).
- **Schema additions** (both schema files + a migrate-time ALTER for
  pre-existing databases): `users.prefs_json`, `bills.anonymous`,
  `payout_methods.meta_json`.
- **render.yaml**: `PAYOUT_ENCRYPTION_KEY` must be pasted as base64 of
  exactly 32 bytes — Render's `generateValue` is the wrong format and
  the server refuses to start with it.
