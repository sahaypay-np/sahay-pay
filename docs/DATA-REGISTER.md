# Sahay Pay — Data Register

Everywhere user data lives, and what each place holds. Review annually
with the vendor review (runbook §5).

## Netlify — hosting + CDN + serverless function

- **Purpose:** serves the static SPA, runs the Express app as a
  Function for `/api/*` and `/uploads/public/*`.
- **User data held:** function logs (request paths, timestamps, errors)
  — no database. Uploaded files pass through `/tmp` on the function
  (ephemeral; do not persist).
- **Region:** global CDN; functions run in the region Netlify assigns.
- **Plan:** Free (Starter).

## Supabase — database

- **Purpose:** the Postgres database for everything the app stores.
- **User data held:** profiles, bills, payout methods (encrypted),
  gifts, sessions (hashed tokens), verification submissions, reports /
  complaints, notifications, brands, auctions, audit log, settings.
- **Region:** Mumbai (ap-south-1).
- **Plan:** Free (500 MB database; no scheduled backups).

## GitHub — code only

- **Purpose:** source code, CI (Actions), issue tracking.
- **User data held:** none. No user data, no production data, and no
  secrets are committed. CI logs contain test output only (throwaway
  local data).
- **Plan:** Free (public repo).

## Owner's devices / dashboards

- **Purpose:** admin console use, support dashboards, password manager.
- **User data held:** whatever the owner views in the admin console
  (review packets, reports, audit log). No bulk export exists today.
- **Handling:** owner's responsibility — device lock, password manager,
  no shared devices for admin work.

## What is NOT used

- No email provider (no email by design — nothing is sent).
- No analytics or advertising tracker (no third-party scripts).
- No payment gateway (Demo Mode — no real money moves).
- No object storage yet (uploads are local disk / function `/tmp`).
- No error-tracking service (errors go to function logs + console).
