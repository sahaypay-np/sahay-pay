# Changelog

All notable changes to Sahay Pay. The coordinator maintains this file
per deploy (checklist item 913).

## Unreleased

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
