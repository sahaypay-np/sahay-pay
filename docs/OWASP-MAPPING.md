# Sahay Pay — OWASP Top 10 Mapping

Maps the OWASP Top 10 (2021) to this project's controls. Review when the
threat model is reviewed (annually — see `docs/SECURITY.md`).

| OWASP Top 10 (2021) | Project controls | Gaps / notes |
|---|---|---|
| **A01 Broken Access Control** | Owner-only admin routes behind PIN session; private files served only via authenticated reviewer/owner routes; bills in `pending_review` return 404 to non-owners; user actions check ownership server-side | Admin is a single PIN — no roles. Reviewer = owner only. |
| **A02 Cryptographic Failures** | Payout details AES-256-GCM at rest; session tokens are random + SHA-256 hashed server-side; PINs scrypt-hashed; HTTPS everywhere (Netlify); cookies HttpOnly + SameSite=Lax (+ Secure in production) | `PAYOUT_ENCRYPTION_KEY` fallback derives from `SESSION_SECRET` if unset; ephemeral key if both unset (startup warning). Key rotation after real data exists would break decryption — see runbook. |
| **A03 Injection** | Parameterised queries everywhere; input validation client AND server; JSON body limit 1 MB; no `eval()` anywhere | CSP keeps `'unsafe-inline'` (inline handlers) — see A07. |
| **A04 Insecure Design** | Human approval before anything goes public; gifts never flow through the platform (no money to steal); no email/password to phish; Demo Mode labels everywhere | Recovery design for lost sessions is still pending an owner decision (recovery codes proposed). |
| **A05 Security Misconfiguration** | Security headers via `netlify.toml`; `X-Powered-By` disabled; `.env` gitignored; no directory listing; SPA fallback returns the shell for unknown paths (no file leaks) | `NODE_ENV=production` must be set in Netlify for Secure cookies — verify in the dashboard. |
| **A06 Vulnerable Components** | Dependabot weekly; `npm audit` in CI (blocks merge); CodeQL SAST; tiny dependency tree (express, pg, multer, serverless-http) | No lockfile pinning beyond `package-lock.json` (standard). |
| **A07 Auth Failures** | No passwords to brute-force; scrypt PIN hash; fail-closed PIN setup; rate-limited admin login; 30-day user sessions / 24h admin sessions; session revocation via suspension + session deletion | No lockout or alerting on PIN guessing; no MFA (single-owner service — PIN is the only factor). |
| **A08 Software & Data Integrity** | No third-party scripts (all self-hosted); no CDN JS; GitHub Actions pinned to major versions (`@v4`/`@v3`); CodeQL on PRs | Actions are pinned to moving major tags, not SHAs — acceptable for this size; revisit if the project grows. |
| **A09 Logging & Monitoring Failures** | Admin audit log (payout reveals, approvals, suspensions, PIN changes); Netlify function logs | No alerting, no uptime monitoring, no automated anomaly detection (manual weekly review). Audit log has no automated purge (1-year retention is manual). |
| **A10 SSRF** | The server makes no outbound requests on behalf of users except the optional owner webhook (owner-configured URL only, fire-and-forget) | No user-supplied URLs are fetched server-side. |

## What OWASP does not cover here (project-specific)

- **Fake-bill fraud:** the top real-world risk. Covered by human review,
  badges, fraud reports that auto-pause, and suspension — see
  `docs/SECURITY.md`.
- **No backups / no monitoring:** operational risks, not OWASP items —
  tracked in `docs/SECURITY-REVIEW-2026.md`.
