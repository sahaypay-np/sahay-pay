# Sahay Pay — standalone web app

Bill-support / gifting platform for Nepal (NPR: eSewa, Khalti, connectIPS,
bank transfer) and India (INR: UPI, bank transfer). Inspired by OnlyBills,
rebuilt from scratch as a deployable Node.js app.

**Status: built and verified locally (Mon 2026-11-16). Not yet deployed.**
This repo is the public version — it will live on a free subdomain.
It is a separate codebase from the Muse artifact (`billsahay`); that
artifact was not touched or read while building this.

## Standing rules (danish's orders — never break these)

- **Name is Sahay Pay.** Not CrystalBills, not BillSahay.
- **No Gmail / Google / email login.** Profiles come from simple questions
  only (name, age, country, city, about, language, optional photo).
- **18+ only, hard block** — under-18s get no profile row at all.
- **30-day persistent login** (sliding session cookie).
- **Nothing public without the owner's explicit approval** — every post,
  brand ask, auction and photo change waits in a review queue until the
  owner says yes (admin console, or the Muse bridge).
- **No fakes anywhere** — no seeded/demo bills, users, brands or auctions.
  Empty states are honest.
- **Real payout account always collected** — choosing eSewa forces the
  eSewa number, bank transfer forces holder/bank/account/branch (+ IFSC
  for India), and so on. Public views show only a masked hint (last 4).
  Full details are revealed to a helper only after the fee step.
- **Demo Mode honesty** — there is NO real payment integration and NO real
  money movement. Every payment surface is labelled Demo Mode, and the app
  never claims a payment succeeded. Gifts move supporter → recipient
  directly in the supporter's own payment app; Sahay Pay never holds money.
- **Never collect MPIN / OTP / passwords / banking credentials.**
- **Legal notes are general information only**, never legal advice.

## What it does

- Onboarding (no email), age gate, persistent session
- Swipe deck + filters (country, category, amount band, verified-only,
  pay-direct-only, charity, bill-shown, city, posted-when) + fair ranking
  (verified / same-country / recency / fewer-supporters / new-poster boosts)
- 6-step post flow → Pending Review until the owner approves; material
  edits and payout changes send a live bill back to review
- Payout accounts for every method (eSewa, Khalti, UPI, bank NP/IN,
  connectIPS, Fonepay QR, payment link) — validated, AES-256-GCM
  encrypted at rest, masked publicly, editable in My Bills
- 4-step gift journey (Amount → Fee → Send it → Confirmed) in Demo Mode;
  only the recipient's confirmation credits the bill and the leaderboards
- Direct bill pay (pay the biller, not the person)
- Leaderboards from confirmed gifts only (supporters / received / bills /
  fully paid / brands)
- Brands + Brand Connect (company-domain email required for paid plans),
  auctions + bidding (min increment, no self-bidding)
- My Bills (incl. help given / received, confirm / not-received / dispute)
- Verification centre (Bill / ID / Name / Biller — human-decided)
- Help Centre (6 topics), cross-border help note (UPI–NPI limits + FCRA
  check), complaints, reports (fraud report auto-pauses a live bill)
- Fee engine: `supporter_fee` ACTIVE (NPR flat रू160 ≤ रू1,600 then 10%,
  min रू160; INR flat ₹100 ≤ ₹1,000 then 10%, min ₹100; charity free);
  `zero_fee_plus_tip` staged behind an admin toggle
- Admin console: first-run owner PIN setup (scrypt, fail-closed, no
  default PIN), review queue, users, verifications, reports, fees,
  payment methods, audit log, gift overview
- EN / NE / HI, light + dark, mobile-first iOS Liquid Glass UI
- Muse owner-approval bridge (`POST /api/bridge/approve`, header
  `X-Sahay-Bridge-Secret`) — how danish's yes/no in chat publishes posts

## Stack

- Node.js 24 + Express 5, single app serving the SPA + JSON API
- `pg` when `DATABASE_URL` is set, else Node's built-in `node:sqlite`
  (local file `data/sahay-pay.db`) — same SQL, `$N` placeholders
- Dependencies: `express`, `pg`, `multer` only. No build step.
- Money is integer minor units (paisa). IDs are UUIDs.

## Run locally

```bash
npm install
cp .env.example .env   # fill in SESSION_SECRET + PAYOUT_ENCRYPTION_KEY (see below)
npm start              # listens on http://localhost:3000 (PORT to change)
```

Generate the secrets (never commit real values):

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"  # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # PAYOUT_ENCRYPTION_KEY (exactly 32 bytes, base64)
```

First run: open the app, create a profile, then open **Admin** and set the
owner PIN (6+ digits). Until the PIN is set, the admin console fails closed
— no login is accepted.

## Tests (all passing locally, 2026-11-16)

Each suite needs the server running on a **fresh** database:

```bash
rm -rf data uploads
PORT=3101 SESSION_SECRET=test-secret \
  PAYOUT_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") \
  CLAUDE_APPROVAL_BRIDGE_SECRET=test-bridge-secret \
  node server/index.js
```

Then, in another shell:

| Suite | Command | Result |
|---|---|---|
| Backend smoke (curl) | `BASE=http://localhost:3101 bash tests/smoke.sh` | **56/56** |
| Contract (curl) | `BASE=http://localhost:3101 bash tests/contract.sh` | **73/73** |
| SPA headless (jsdom) | `npm install --no-save jsdom && BASE=http://localhost:3101 node tests/spa-harness.js` | **18/18** |

The smoke suite covers the API end to end (onboarding, age block, post →
approve → feed, gift → reveal → confirm, reports → auto-pause, admin,
bridge, uploads, verification, brands, auctions). The contract suite
covers the frontend/backend joins fixed during integration (payout
bank name + branch in reveal, anonymous masking, boolean flags, prefs,
country change, leaders/feed vocab, admin fee + methods shapes,
hash-route notification links, onboarding photo, brand-connect email).
The SPA harness drives the real frontend JS in a DOM: boot, welcome →
country → onboarding, swipe / leaders / help / settings / my bills /
post, admin PIN setup → login → dashboard — with zero uncaught errors.

## Deploy (free tier)

### 1. Database — Supabase or Neon (free, no card)

Create a free Postgres project and copy its connection string
(`postgres://user:pass@host:5432/db?sslmode=require`). The app runs the
schema itself at startup (`server/schema.postgres.sql`); no manual
migration is needed. **First run against Postgres must be smoke-tested**
— the Postgres path is code-reviewed but has never been executed (see
"Known gaps").

### 2. Host — Render free (or Koyeb free)

**Render** (recommended first): push this repo to GitHub, then in the
Render dashboard create a Web Service from the repo. `render.yaml` is
included (Blueprint): Node, free plan, `npm ci`, `node server/index.js`.
Set in the dashboard (never in the repo):

- `DATABASE_URL` — the Supabase/Neon string
- `SESSION_SECRET` — generated by Render (`generateValue`)
- `PAYOUT_ENCRYPTION_KEY` — paste a base64 32-byte key (see above).
  **Do not use Render's generateValue here** — the wrong format makes the
  server refuse to start.
- `CLAUDE_APPROVAL_BRIDGE_SECRET` — generated by Render
- `OWNER_NOTIFICATION_WEBHOOK_URL` — optional (owner review-packet webhook)
- `APP_BASE_URL` — the public URL once assigned

Render gives a free subdomain (`https://sahay-pay.onrender.com`). Free
services sleep after 15 minutes idle (first visit after sleep is slow)
and have ephemeral disks — **uploaded photos do not survive a redeploy**
(see "Known gaps").

**Koyeb** (alternative): same repo + env vars; build `npm ci`, run
`node server/index.js`, port 3000. Also gives a free subdomain.

### 3. After deploy

1. Open the app, create your profile.
2. Open **Admin**, set the owner PIN (6+ digits) — do this immediately;
   until then anyone could set it (first-run setup is only possible
   while no PIN exists; set `ADMIN_SETUP_TOKEN` to gate it further).
3. Run the smoke suite against the live URL
   (`BASE=https://<your-app> bash tests/smoke.sh`) — it creates test
   data, so do it before announcing the site, then wipe the database
   (or delete the test rows) before real use.
4. Keep the site in Demo Mode until real authorised gateways/licences
   exist. Never present it as handling real payments.

### Free domain notes

- `.co` is **not** free (~$15.50 first year). The free route is the
  host's subdomain (Render/Koyeb) for now.
- `.com.np` **is** free (register.com.np via Mercantile) but the name
  must match the applicant's legal name (personal) or a registered
  business/brand name — `sahaypay.com.np` needs a registered business
  named Sahay Pay. That is a later step, after the business exists.

## What was verified live vs code-only

**Driven live (local SQLite):** everything in the three test suites above
— onboarding, age block, post → review → approve → feed, gift journey
with real payout reveal, leaderboards, brands, auctions, verification,
reports → auto-pause, admin PIN + console, fees, methods, prefs,
notifications, bridge approve, uploads (incl. private-file access
control), and the SPA flows in the jsdom harness.

**Code-only / not yet driven:**
- **Postgres path** — never executed (no Postgres server here). The pg
  adapter, `schema.postgres.sql` and the `ON CONFLICT` upserts follow
  standard patterns, but the first Supabase/Neon run must be smoke-tested.
- **Docker image** — never built (no Docker daemon here). Dockerfile and
  render.yaml are written but unexecuted.
- **Owner webhook** — fire-and-forget POST is implemented but no webhook
  URL was available to drive it. Packets correctly wait in the admin
  queue when it is unset (verified).
- **Rate limits, 30-day sliding renewal, session expiry** — implemented,
  not driven to their limits.
- **No real browser check** — the SPA was driven in jsdom (real JS, real
  API), not in Chrome/Safari on a phone. Visual Liquid Glass polish and
  touch gestures (swipe) still need danish's eyes on a real device.
- **Uploads are local disk** — on Render free they vanish on redeploy.
  Object storage (`OBJECT_STORAGE_*`) is designed but not implemented.
- **No CSRF tokens** (cookies are SameSite=Lax; state-changing routes
  rely on that + auth). No Turnstile human check before reveal (checkbox
  only). No virus scan on uploads.

## Repo layout

```
package.json / package-lock.json   deps: express, pg, multer
.env.example                       env names only — never commit values
render.yaml                        Render Blueprint (free web service)
Dockerfile                         node:24-alpine
ARCHITECTURE.md                    design + API contract + DB schema
server/index.js                    entry: static SPA + /api, error handler
server/db.js                       pg/SQLite adapter + migrate() + defaults
server/schema.postgres.sql         Postgres schema (17 tables)
server/schema.sqlite.sql           SQLite schema (identical tables)
server/lib/                        auth, validate, fees, money, audit,
                                   notify (review packets), storage
server/routes/                     public, auth, profile, bills, gifts,
                                   verification, brands, auctions,
                                   notifications, reports, admin, bridge
public/                            SPA: index.html, css/app.css,
                                   js/i18n.js (EN/NE/HI), js/app.js
tests/smoke.sh                     backend smoke suite (56 checks)
tests/contract.sh                  frontend/backend contract suite (73)
tests/spa-harness.js               jsdom SPA harness (18 checks)
```

## Still missing / next for deployment

1. **Accounts needed:** a GitHub account (to host the repo) and a
   Render or Koyeb account (to host the app), plus a Supabase or Neon
   account (free Postgres). No paid service is required.
2. **Env vars** (set in the host dashboard): `DATABASE_URL`,
   `SESSION_SECRET`, `PAYOUT_ENCRYPTION_KEY` (base64, exactly 32 bytes),
   `CLAUDE_APPROVAL_BRIDGE_SECRET`; optional `ADMIN_SETUP_TOKEN`,
   `OWNER_NOTIFICATION_WEBHOOK_URL`, `APP_BASE_URL`.
3. **First-run owner steps on the live site:** set the admin PIN, decide
   the fee model (supporter fee is live; zero-fee + founder tip is one
   admin toggle away), smoke-test against the live URL, wipe test data.
4. **Known product gaps (not blockers):** object storage for uploads;
   Turnstile human check before reveal; admin screens for payment
   monitoring, refunds, brand applications, auction moderation,
   leaderboard recompute, broadcast notifications, security settings
   (no API endpoints for these exist yet); pull-to-refresh, push
   notifications, offline cache; redaction is manual draw-only (no
   OCR/detection); basket is localStorage-only; founder-tip payment is
   Demo Mode only (no tip-payment endpoint).
