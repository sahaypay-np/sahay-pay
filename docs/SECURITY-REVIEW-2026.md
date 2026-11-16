# Sahay Pay — Hosting Security Review 2026

**Date:** 16 November 2026
**Scope:** the live site (https://sahay-pay.netlify.app), the standalone
repo (https://github.com/sahaypay-np/sahay-pay), hosting (Netlify +
Supabase), and the code as deployed at commit `b8defcb` plus the fixes
from this job.
**Status:** this job is the FIRST annual hosting security review
(checklist item 100). The next review is due November 2027 (quarterly
mini-audits in between — see `docs/RUNBOOK.md` §5).

## Method

A 1000-item Nepal-edition website checklist was triaged item by item
(ledger: `~/workspace/sahay-pay/checklist-1000-progress.md` in the
operator's workspace, not in this repo). Each item was marked DONE, DO,
NEEDS-DANISH, or N/A with evidence. DO items were implemented in three
workstreams (headers/docs, app hardening, UI/accessibility) on separate
branches, each verified by the full test suites (smoke 57, contract 73,
SPA harness 20) against fresh local servers before merge. Live checks
were read-only (`tests/check-live.sh`).

## Findings fixed in this job

| # | Finding | Fix | Evidence |
|---|---|---|---|
| 1 | No security headers on live responses (no CSP, XFO, XCTO, Referrer-Policy, Permissions-Policy) | `[[headers]]` in `netlify.toml` for `/*`, incl. CSP (with `'unsafe-inline'`, required by the SPA's inline handlers) + HSTS | `netlify.toml`; verified live post-deploy with `tests/check-live.sh` |
| 2 | Express sent `X-Powered-By: Express` | `app.disable('x-powered-by')` in `server/index.js`; CI checks it stays absent | curl before/after on local server |
| 3 | No CI, no SAST, no secret scan, no dependency updates | GitHub Actions CI (suites + audit + secret scan), CodeQL, Dependabot weekly | `.github/workflows/`, `scripts/check-secrets.sh` |
| 4 | No vulnerability disclosure channel | `/.well-known/security.txt` + `SECURITY.md` (48-hour acknowledgement) | Files in repo; Express serves security.txt explicitly (dotfiles) |
| 5 | Hidden-file exposure untested | Verified `/.env`, `/.git/HEAD`, `/.htaccess` return only the SPA shell (local + live) | curl output, 16 Nov 2026 |
| 6 | Verification documents: policy said "deleted after review" but deletion was not verified in code | Assigned to workstream B (deletion code); policy wording kept as-is. **Confirm in workstream B's report before treating this as closed.** | Workstream B report (pending at time of writing) |
| 7 | Rate limits existed but were in-memory only (reset on function recycle) | Hardening assigned to workstream B; residual risk recorded in `docs/SECURITY.md`. **Confirm in workstream B's report.** | Workstream B report (pending at time of writing) |
| 8 | Legal documents unversioned; no retention schedule, no cookie table, no disputes/copyright/ETA clauses | Terms + Privacy v1.0 with all additions; archives in `docs/legal-archive/` | `public/js/app.js` legal constants |
| 9 | No runbook, threat model, or incident plan | `docs/RUNBOOK.md`, `docs/SECURITY.md`, this review, OWASP mapping, review checklist | `docs/` |

## Findings still open (not fixed in this job)

| # | Finding | Owner / next step |
|---|---|---|
| 1 | **No database backups.** Supabase free has no scheduled backups; a lost or corrupted live DB cannot be restored. This is the largest operational risk. | danish: decide on paid Supabase plan or a manual export routine |
| 2 | **No uptime monitoring or alerting.** Nothing pages anyone if the site goes down. | danish: choose a monitoring account |
| 3 | **CSP keeps `'unsafe-inline'`** for script/style (111 inline `onclick=` handlers + inline styles). Removing them is a large refactor. | Future hardening work |
| 4 | **No lockout/alerting on admin PIN guessing** — rate limits only slow it. | Future hardening work |
| 5 | **No maintenance-mode switch.** Emergency takedown means unpublishing in the Netlify dashboard. | Accept for now; revisit if incidents demand it |
| 6 | **Name collision (see below).** Needs lawyer review before any trademark step. | danish + lawyer |

## Name-collision flag (checklist items 509/370) — FOR LAWYER REVIEW

An Ethiopian mobile wallet named **"SahayPay"** already exists in the
same sector:

- Operator: RAYS Micro Finance Institution S.C., Addis Ababa, Ethiopia
  (NBE-licensed); site sahaypay.com; apps on Google Play ("SahayPay",
  "Sahay").
- Launched 2019. Reached 540,000 users by end-2021 (Mercy Corps / RIPA
  Learning Brief #7, August 2024); the provider now claims over 1
  million users and 5,000+ agents across Ethiopia.
- Same sector: bill payments, P2P transfers, merchant payments, mobile
  money — overlapping closely with Sahay Pay's bill-support purpose.

**No rename is being made.** "Sahay Pay" was the owner's explicit final
choice (16 November 2026), and the Ethiopian service operates in a
different country and market. But the collision is real and must go to a
lawyer before any trademark filing, app-store listing under this name,
or business registration that relies on the name being distinctive.
Recorded here and in `docs/DECISIONS.md`. Do not remove this flag
without the owner's explicit instruction after legal advice.

## Verdict

The service is in reasonable shape for a free-tier launch: no known
critical vulnerability was found, headers/CI/disclosure/docs are now in
place, and the test suites are green. The two risks that matter most are
operational, not code: **no backups** and **no monitoring**. Both need
owner decisions, not more code.
