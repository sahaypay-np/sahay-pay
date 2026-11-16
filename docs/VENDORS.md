# Sahay Pay — Vendors

Every third-party service the project uses. Owner of every account:
danish. Review annually (runbook §5).

| Service | Purpose | Plan | Region | Account / notes |
|---|---|---|---|---|
| Netlify | Hosting + CDN + serverless function (`/.netlify/functions/api`) | Free (Starter) | Global CDN | Git-connected to this repo; auto-deploys from `main`. Dashboard holds all env vars. |
| Supabase | Postgres database | Free | Mumbai (ap-south-1) | Holds all user data. No scheduled backups on free. |
| GitHub | Code hosting, CI (Actions), CodeQL, Dependabot | Free (public repo) | — | Repo: `sahaypay-np/sahay-pay`. No user data. |

## Considered but not used (kept for the record)

| Service | Why not |
|---|---|
| Vercel | Blocked 2026-11-16: dashboard requires SMS phone verification; no number can receive SMS right now. `api/index.js` + `vercel.json` kept in repo, unused. |
| Render | Blocked 2026-11-16: demands a credit card for identity verification even for a free service. `render.yaml` kept, unused. |
| Koyeb | Blocked 2026-11-16: control panel unusable for new accounts during the Mistral takeover. |
| Neon (Postgres) | Alternative database, not chosen — Supabase is the live database. |

## Not yet chosen (owner decisions pending)

| Need | Status |
|---|---|
| Uptime monitoring / alerting | No account chosen; monitoring is manual until then |
| Backups | Supabase free has none; paid plan or manual exports — owner decision pending |
| Payment gateway (eSewa / Khalti / UPI) | Demo Mode until business + licences exist; no gateway account |
| Object storage for uploads | Future; uploads are local disk / function `/tmp` today |
| Custom domain | `.com.np` needs a registered business named Sahay Pay; later step |

No vendor holds credentials in this repo. Account access lives in the
owner's password manager and the vendor dashboards (see
`docs/HANDOVER.md`).
