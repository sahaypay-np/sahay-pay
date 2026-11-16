# Changelog

All notable changes to Sahay Pay. The coordinator maintains this file
per deploy (checklist item 913).

## Unreleased

### Phase 2 sections 7–8 — notifications, messaging, engagement, admin (16 Nov 2026)

- Notifications: kind filters (gifts/bills/account), cursor pagination,
  load-more, per-notification detail + dismiss, mark-all-read (due
  notifications only). Per-event preferences (15 events), pause-all with
  7-day auto-resume, quiet hours (local time + timezone offset), optional
  notification sound, notification language (EN/NE/HI). Security
  notifications can never be turned off. Lazy reminders (confirm,
  deadline, thank-you, verification) shown once per session.
- In-app messaging: one thread per bill + giver, opening only after a
  gift has been started; server-side filter blocks links, UPI IDs,
  phone numbers, bank details and OTP/PIN digits (plain warnings about
  scams are allowed); block/unblock; unread counts; hidden messages
  stay in the thread as placeholders.
- Thank-you notes: recipients can thank a giver on a confirmed gift,
  optionally public on the bill's thank-you wall.
- Referrals: personal code + share link, public landing page (first
  name only), milestone badges (1/5/10 active referrals), leaders
  board, opt-out; self-referral is structurally impossible and
  high-velocity codes are flagged for admin review.
- Weekly + monthly activity summaries (given/received, bills helped,
  new bills in your city, leaderboard rank) with opt-out.
- Announcements page; bill history now shows review decisions.
- Admin: queue filters (type, oldest/newest, flagged, search) + bulk
  review (up to 50) + hold/unhold; user detail with suspension (reason
  required), 7/30-day temporary suspension, typed-BAN ban, admin notes,
  trusted-poster and watchlist flags; report detail with case notes,
  severity/assignment/legal flags, request-changes and escalate;
  complaints inbox with template responses; appeals with content
  restore; admin dispute queue; analytics + CSV export; payouts
  summary + gift-status override; admin accounts (owner/moderator/
  viewer roles, one-time invite codes, per-account lockout, viewers
  read-only); security settings (PIN length, idle timeout, lockout)
  + security-events log; admin availability toggle; broadcasts with
  preview + 5000-recipient cap; audit log filters + CSV export +
  hash-chain verification + one-click archive of entries older than
  90 days; weekly moderation report; leaderboard audit; bridge
  health/history; webhook delivery log + test.
- New Help topics: how direct payments work, referrals, how
  moderation works, install the app (16 topics total).
- Install prompt: offered after the third visit, once per device.
- Tests: smoke 224, contract 152, SPA harness 83, migrate-old-db 23
  (all green; migration verified against b8defcb, f3ec28a and 165bfac).

### Headers / SEO / docs workstream (checklist job, 16 Nov 2026)

- Security headers via `netlify.toml`: CSP, X-Frame-Options DENY,
  X-Content-Type-Options nosniff, Referrer-Policy,
  Permissions-Policy, HSTS.
- Express `X-Powered-By` disabled; CI checks it stays absent.
- CI: GitHub Actions (all suites + `npm audit` + secret scan on every
  push/PR), CodeQL SAST, Dependabot weekly.
- `/.well-known/security.txt` + `SECURITY.md` (48-hour acknowledgement).
- Brand icons (favicons, apple-touch-icon, 192/512, OG image) generated
  by `scripts/make-icons.py`; manifest, canonical, OG + Twitter Card,
  Organization + FAQPage JSON-LD, `<noscript>` message.
- `sitemap.xml` + Sitemap line in `robots.txt`.
- `tests/check-live.sh`: read-only post-deploy checks.
- Terms + Privacy Policy v1.0 (ETA 2063 clause, contract-formation,
  copyright reporting, disputes clause, retention schedule, cookie
  table, 30-day access/export response); archives in
  `docs/legal-archive/`.
- New Help topics: About Sahay Pay, Refunds, Content rules (12 topics
  total); EN/NE/HI titles + summaries.
- Docs: runbook, security architecture + threat model, 2026 security
  review, OWASP mapping, review checklist, data classification,
  data register, vendors, decision log, handover, brand guide,
  maintenance + performance report templates, end-of-life plan.

## 1.0.0 — 2026-11-16 (launch)

- Sahay Pay live at https://sahay-pay.netlify.app (Netlify free +
  Supabase free, Mumbai).
- Full app: no-email onboarding (18+ gate), 6-step bill posting with
  owner review, gift journey (Amount / Check / Send / Confirmed),
  3-badge verification, leaderboards, brands, auctions, notifications,
  admin console (PIN-gated).
- Demo Mode: no real payment integration; fees quoted, never collected.
- Terms of Service (14 sections) + Privacy Policy (9 sections) in the
  Help Centre.
- PageSpeed 100/100/100/100 (Performance / Accessibility / Best
  Practices / SEO) on mobile and desktop; console clean.
- Live database wiped clean of test data before launch.
