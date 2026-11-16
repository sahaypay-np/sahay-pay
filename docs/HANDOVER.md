# Sahay Pay — Handover

What a new operator needs to take over this service. **No credential
values are in this file** — credentials live in the owner's password
manager and the vendor dashboards. If you are reading this and you are
not the owner, ask the owner for access; do not go looking for secrets
in the repo (there are none — CI scans for them).

## The service in one paragraph

Sahay Pay connects people in Nepal and India who need help with a bill
with people willing to help. Supporters pay the person directly from
their own payment app; the platform never holds gift money. It is in
Demo Mode (no real payment integration). Every post is reviewed by the
owner before it goes public. Live at https://sahay-pay.netlify.app.

## Accounts & access (owner holds all of these)

| What | Where | Notes |
|---|---|---|
| GitHub repo | https://github.com/sahaypay-np/sahay-pay | Owner is admin. CI/CD runs here. |
| Netlify site | Netlify dashboard → Sahay Pay | Holds ALL env vars (DATABASE_URL, SESSION_SECRET, PAYOUT_ENCRYPTION_KEY, etc.). Deploys + rollbacks happen here. |
| Supabase project | Supabase dashboard → Sahay Pay | The live Postgres database (Mumbai). SQL editor for PIN recovery / wipes. |
| Admin console | Live site → Admin | PIN-gated (6+ digits). PIN is the owner's; recovery is in the runbook §9. |
| Domain | None yet | Free Netlify subdomain only. `.com.np` needs a registered business. |

## Daily / weekly / monthly jobs

See `docs/RUNBOOK.md` §5 (review routines). In short: weekly log +
audit-log review; monthly Dependabot + PageSpeed; quarterly security
audit + usage review; annually vendor + policy review.

## If something breaks

1. `docs/RUNBOOK.md` §4 (incident response) — severity levels, contact
   order, first-hour steps, templates.
2. Rollback: Netlify dashboard → Deploys → publish the last good
   deploy (runbook §3).
3. PIN lost: runbook §9 (clear the hash in Supabase, re-run setup).
4. No backups exist yet — a lost database cannot be restored. This is
   the first thing to fix (owner decision).

## Key docs

- `README.md` — what the service is, how to run and deploy it.
- `ARCHITECTURE.md` — stack, layout, API contract, security notes.
- `docs/RUNBOOK.md` — operations (start here for any incident).
- `docs/SECURITY.md` — threat model. `docs/SECURITY-REVIEW-2026.md` —
  first annual review. `docs/OWASP-MAPPING.md` — control mapping.
- `docs/DECISIONS.md` — why things are the way they are.
- `docs/VENDORS.md` / `docs/DATA-REGISTER.md` — who holds what.
- `docs/BRAND.md` — voice, colours, logo.
- `docs/legal-archive/` — v1.0 Terms + Privacy Policy.
- `CHANGELOG.md` — release history.

## Things NOT to do

- Never run the test suites against the live URL (they claim the admin
  PIN setup and flip the fee mode). Use `tests/check-live.sh` for live.
- Never commit secrets, `.env`, or production data.
- Never rotate `PAYOUT_ENCRYPTION_KEY` after real payout accounts
  exist (stored payout details would become unreadable).
- Never present the service as handling real payments while Demo Mode
  is on.
- Never rename the service (see the name-collision flag in
  `docs/SECURITY-REVIEW-2026.md` — lawyer review first).
