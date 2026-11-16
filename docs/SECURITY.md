# Sahay Pay — Security Architecture & Threat Model

Review annually (see `docs/RUNBOOK.md` §5). Last reviewed: 16 November
2026 (first review — the 1000-item checklist job; see
`docs/SECURITY-REVIEW-2026.md`).

## Architecture (security view)

- **Frontend:** vanilla JS single-page app in `public/`, served by the
  Netlify CDN. No third-party scripts — everything is self-hosted, so
  there is no supply-chain JavaScript to audit.
- **Backend:** Node.js 24 + Express 5, running as a Netlify Function for
  `/api/*` and `/uploads/public/*`. No build step.
- **Database:** Supabase Postgres (Mumbai). Local dev uses SQLite.
- **Auth:** no email, no passwords. Users get an opaque random session
  token (SHA-256 hash stored server-side) in an HttpOnly,
  SameSite=Lax cookie (`sp_session`, 30 days, sliding renewal). Admin
  access is a 6+ digit PIN (scrypt hash) with its own 24h cookie
  (`sp_admin`). Cookies are marked Secure when `NODE_ENV=production`.
- **Payout details:** AES-256-GCM encrypted at rest
  (`PAYOUT_ENCRYPTION_KEY`, else derived from `SESSION_SECRET`, else
  ephemeral with a startup warning). Full details are shown only to a
  helper at the Send step; every reveal is logged in the audit log.
  Phase 2 (item 833): encryption is **key-per-field** — each payout
  method (esewa, khalti, upi, bank_np, …) gets its own key, derived
  from the master key with HMAC-SHA-256 over the label
  `sahay-pay-field:<method>`, so a compromised field key exposes only
  one field type. New ciphertexts carry a `v2:` prefix; legacy blobs
  (master key directly) still decrypt. Rotation: see
  `docs/KEY-ROTATION.md`.
- **Verification documents:** reviewer-only; deleted after the review
  is decided (deletion code landed in the November 2026 checklist job).
- **Uploads:** images (jpg/png/webp) + PDF only, 5 MB cap, random
  filenames, private files served only via authenticated reviewer/owner
  routes. Public images are re-encoded via the client canvas step
  (strips EXIF).
- **Rate limits:** in-memory buckets per IP + route (onboarding,
  posting, gift create, report, bid, admin login). Note: in-memory
  limits reset when a serverless function instance is recycled, so they
  slow abuse rather than stop a determined attacker.
- **Human approval:** the owner approves every post, brand ask, and
  auction before it goes public. AI can flag things; AI can never
  approve.
- **Headers:** CSP, X-Frame-Options DENY, X-Content-Type-Options
  nosniff, Referrer-Policy, Permissions-Policy, HSTS (via
  `netlify.toml`); Express `X-Powered-By` disabled. The CSP keeps
  `'unsafe-inline'` for script/style because the SPA uses 111 inline
  `onclick=` handlers and inline styles — removing those handlers is
  the path to a stricter CSP.
- **CI gates:** suites + `npm audit` + secret scan + X-Powered-By check
  on every push/PR; CodeQL SAST; Dependabot weekly.
- **Logging:** admin audit log (who did what, when). No third-party
  analytics or trackers.

## Assets (what needs protecting)

| Asset | Why it matters |
|---|---|
| Payout details (eSewa/Khalti/UPI/bank) | Direct financial harm if leaked |
| Verification documents (ID photos, bill proof) | Identity theft if leaked |
| Session tokens + admin PIN | Account takeover / full admin control |
| User profiles + bills | Privacy; fake bills damage trust |
| `SESSION_SECRET`, `PAYOUT_ENCRYPTION_KEY` | Master keys for sessions + payout data |
| The live site's reputation | A scammy-looking or defaced site kills the service |

## Actors

- **Opportunistic scammers:** fake bills to collect gifts; the main
  everyday threat. Countered by human review of every post, fraud
  reports that auto-pause a bill, and account suspension.
- **Curious attackers / scanners:** automated probing for `/.env`,
  `/.git`, admin endpoints, SQL injection. Countered by parameterised
  queries, input validation, the SPA fallback (no file leaks), and
  rate limits.
- **A determined attacker:** targeted account takeover or admin-PIN
  guessing. Countered by scrypt PIN hashing, fail-closed PIN setup,
  rate-limited admin login, and HttpOnly session cookies — but there is
  no lockout or alerting on the free tier, so detection is manual
  (weekly audit-log review).
- **Malicious user content:** defamation, CSAM, illegal content.
  Countered by pre-publication review, content rules (Help Centre),
  reporting, and takedown.
- **Insider / owner device loss:** the owner's device holds the admin
  session. Countered by the 24h admin session and PIN rotation.

## Threats and controls (summary)

| Threat | Controls | Residual risk |
|---|---|---|
| Fake bills / gift fraud | Human review, badges, fraud reports auto-pause, suspension | A convincing fake can pass one human review |
| Payout data leak | AES-256-GCM at rest, masked hints, reveal-only-at-Send, audit log | Key compromise would expose all stored payout details |
| Session hijack | HttpOnly + SameSite=Lax + Secure-in-production cookies, random tokens | No per-session device binding; a stolen cookie works until expiry |
| Admin PIN guessing | scrypt hash, rate-limited login, fail-closed setup | No lockout/alerting; guessing is only slowed |
| XSS | `esc()` escaping in the SPA, CSP (with `unsafe-inline`), no third-party scripts | `unsafe-inline` weakens the CSP; inline handlers are the risk |
| SQL injection | Parameterised queries everywhere | Low |
| Secret leak via repo | Secret scan in CI, `.env` gitignored, no secrets in code | A secret committed before the scan existed would still be in git history — rotate if ever found |
| Data loss (no backups) | None on the free tier | **Highest operational risk**: a lost DB cannot be restored |
| Dependency vulnerability | Dependabot, `npm audit` in CI, CodeQL | Zero-days between release and patch |
| DDoS / free-tier exhaustion | Netlify CDN absorbs some load; rate limits | No WAF or paid protection; heavy traffic can exhaust the free tier |

## Assumptions

- The owner is the only admin and the only reviewer.
- Netlify and Supabase are trusted to run their platforms securely;
  Sahay Pay does not audit them.
- Users' own devices and payment apps are outside Sahay Pay's control —
  the Terms say so, and the app never asks for MPINs, OTPs, or card
  details.
- Demo Mode: no real payment integration exists, so there is no payment
  card data and no PCI scope. If real payments launch, this document
  and the threat model must be revised before go-live.
