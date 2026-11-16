# Sahay Pay — Runbook

Operations manual for the Sahay Pay live service. This file lives in the
GitHub repo, so it stays readable even when the site itself is down
(checklist item 954). Update this runbook after every significant change
(item 974) — a stale runbook is worse than none.

Owner: danish (all decisions are his; see "Contact order" below).
Live site: https://sahay-pay.netlify.app
Repo: https://github.com/sahaypay-np/sahay-pay

## 1. Setup (local development)

Requirements: Node.js 24+ (see `engines` in `package.json`).

```bash
git clone https://github.com/sahaypay-np/sahay-pay.git
cd sahay-pay
npm ci
npm install --no-save jsdom   # only needed for tests/spa-harness.js
cp .env.example .env          # fill in; .env is gitignored, never commit it
```

Start a local server with throwaway secrets (no real secrets in dev):

```bash
PORT=3101 SESSION_SECRET=$(openssl rand -base64 48) \
  PAYOUT_ENCRYPTION_KEY=$(openssl rand -base64 32) \
  CLAUDE_APPROVAL_BRIDGE_SECRET=test-bridge-secret \
  node server/index.js
```

Without `DATABASE_URL` the server uses local SQLite (`data/sahay-pay.db`).
The schema migrates itself at startup. There is no seeded or fake data.

### Test suites (all against a FRESH local server + database)

Each suite sets the admin PIN and flips the fee mode, so each needs a
fresh server (kill, `rm -rf data`, restart) before it runs:

```bash
BASE=http://localhost:3101 ./tests/smoke.sh        # 57 checks
BASE=http://localhost:3101 ./tests/contract.sh     # 73 checks
BASE=http://localhost:3101 node tests/spa-harness.js # 20 checks
bash scripts/check-secrets.sh                  # secret scan
```

NEVER run `smoke.sh`, `contract.sh`, or `spa-harness.js` against the live
URL: they claim the admin PIN setup and flip the fee mode. The live-safe
suite is `tests/smoke-live.sh` (see README), and the read-only post-deploy
check is `tests/check-live.sh`.

## 2. Hosting

| Piece | Provider | Plan | Region / notes |
|---|---|---|---|
| Static site + CDN + serverless function | Netlify | Free (Starter) | Git-connected; auto-deploys from `main` |
| Database | Supabase (Postgres) | Free | Mumbai (ap-south-1) |
| Code + CI | GitHub | Free (public repo) | GitHub Actions + CodeQL + Dependabot |

See `docs/VENDORS.md` and `docs/DATA-REGISTER.md` for the full lists.

### Free-plan limits to watch (item 944)

- Netlify free: 100 GB bandwidth/month, 300 build minutes/month.
- Supabase free: 500 MB database, 50k monthly active users, 2 GB file
  storage, 1 GB file transfer. **No scheduled backups on the free plan**
  — the live database is currently unbacked-up. Backups need a paid plan
  or a manual export routine (see §7).
- Check the vendor dashboards for current usage and current limits; the
  numbers above are as of November 2026 and vendors change them.

## 3. Deploy process (item 968)

1. Work on a branch; open a pull request to `main`.
2. CI must be green before merge: all three suites + `npm audit` +
   secret scan + X-Powered-By check (see `.github/workflows/ci.yml`).
   A coordinator reviews the change (see §11).
3. Merge to `main`. Netlify auto-deploys: it serves `public/` from the
   CDN and bundles the Express app as a Function for `/api/*` and
   `/uploads/public/*`. There is no build step.
4. Watch the deploy in the Netlify dashboard (Deploys tab) until it says
   Published. Note the deploy ID and commit.
5. Run the read-only post-deploy checks:
   `./tests/check-live.sh` (health, robots, sitemap, security headers,
   JSON 404, security.txt, manifest). It creates no data.
6. Spot-check the live site in a browser: home loads, Help Centre opens,
   one Help topic renders, admin login screen loads.
7. Record the deploy in `CHANGELOG.md` (date, version, what changed).

Environment variables live in the Netlify dashboard (Site settings →
Environment variables), never in the repo: `DATABASE_URL`,
`SESSION_SECRET`, `PAYOUT_ENCRYPTION_KEY`, `ADMIN_SETUP_TOKEN` (optional),
`CLAUDE_APPROVAL_BRIDGE_SECRET` (optional), `APP_BASE_URL`. Set
`NODE_ENV=production` so cookies are marked Secure (see §9).

### Rollback (item 949)

- **Netlify one-click rollback (fastest):** Netlify dashboard → Deploys →
  pick the last good deploy → "Publish deploy". The site reverts within a
  minute; the database is untouched.
- **Git revert (when the bad change must come out of the code):**
  `git revert <commit>` on `main`, push, let Netlify auto-deploy.
- After any rollback, re-run `./tests/check-live.sh` and check the site.
- Rollback does not undo database changes. If a deploy changed the schema
  or data, see §7 (restore) and §4 (incident response).

## 4. Incident response (items 192/241/243/439/946–951/953)

danish leads every incident. Nobody else takes a destructive action
(deleting data, rotating secrets, notifying users) without his say-so.

### Severity levels (item 946)

| Level | Meaning | Examples |
|---|---|---|
| P1 | Service down or user data exposed | Site unreachable; payout details leaked; admin PIN compromised |
| P2 | Major feature broken or abuse in progress | Posting/gifting broken; fraud ring posting fake bills; spam flood |
| P3 | Minor feature broken, workaround exists | One Help topic broken; leaderboard stale |
| P4 | Cosmetic / no user impact | Typo; broken non-essential link |

### Contact order (items 242/947/951)

1. danish (owner — decides everything, including authority notification).
2. Platform support, only as needed:
   - Netlify: https://www.netlify.com/support/ and
     https://answers.netlify.com/
   - Supabase: https://supabase.com/support and
     https://supabase.com/docs
   - GitHub: https://support.github.com/
3. Authorities, only on danish's decision (see "Cybercrime" and
   "Breach" below).

### First-hour isolation steps (item 243, adapted for serverless)

1. **Preserve evidence first** (see "Evidence" below) — do not rebuild
   or wipe anything until logs are exported.
2. **Stop the bleeding:**
   - Suspend the abusive user(s) in the admin console (Admin → Users).
   - Pause the affected bill(s) (admin console or fraud report path).
   - Revoke sessions: log the affected user(s) out (see §9) and, if the
     admin PIN is suspected compromised, rotate it (see §9).
   - If the site itself is the problem, roll back to the last good
     Netlify deploy (§3) or, for a bad deploy, publish the previous one.
3. **Assess:** what happened, who is affected, is it still happening?
4. **Decide with danish:** notify users? notify an authority? Keep the
   site up or take it down? (There is no maintenance-mode switch today —
   the closest is a Netlify rollback to a safe deploy, or unpublishing
   the site from the Netlify dashboard in an emergency.)
5. **Fix, verify, write the post-mortem** (§4, last section).

### Breach response plan (items 244/439)

If personal data (profiles, payout details, verification documents,
sessions) may have been accessed by someone who should not have it:

1. Contain (first-hour steps above).
2. Assess: what data, how many users, how did it happen, is it ongoing?
3. danish decides on notification (item 245): he decides whether and
   when to notify affected users and any authority. Record the decision
   and the reason.
4. Notify affected users through the in-app complaint route or whatever
   contact exists for them (there are no email addresses on file — see
   the template below).
5. Record the incident: date, what happened, data involved, users
   affected, actions taken, decision log.
6. Fix the cause; rotate any exposed secret (§9); review the audit log.

### Breach notification template (item 244)

> Subject: Important — a security incident on Sahay Pay
>
> Dear Sahay Pay user,
>
> On [date] we discovered [what happened in plain language]. The data
> involved was [list: e.g. display names and cities; no payout details
> were accessed / payout details may have been accessed]. [Number] users
> are affected.
>
> What we have done: [containment + fix]. What you should do: [e.g. log
> out and log back in; check your payout account for unexpected activity;
> contact us if anything looks wrong].
>
> We are sorry this happened. If you have questions, contact us through
> the Help Centre complaint form in the app:
> https://sahay-pay.netlify.app/#/help?topic=complaints
>
> — The Sahay Pay team

Note: Sahay Pay holds no email addresses, so "notify users" in practice
means an in-app notice plus the complaint-form channel. If a breach ever
needs wider notice, danish decides the channel.

### Client-outage template (item 948)

> Sahay Pay is currently unavailable [ / experiencing problems with
> (feature) ] since [time]. We are working on it and expect service to
> return by [time or "as soon as possible"]. Your posts and gifts are
> safe. Updates will be posted here. Thank you for your patience.

### Evidence preservation (item 246)

Before any rebuild, rollback, or wipe:

1. Export the admin audit log (Admin → Audit) — copy or screenshot the
   relevant rows with timestamps.
2. Export the Netlify function logs (Netlify dashboard → Functions →
   Logs) for the incident window.
3. Copy the Supabase logs for the same window, if available.
4. Save everything with the incident record (date + summary). Do not
   edit the exports.

### Suspected hack / malware (item 950)

1. Treat as P1. Preserve evidence (§4 above).
2. Roll back to the last known-good deploy (§3) if the served code may
   be tampered with.
3. Rotate every secret that could be exposed (§9) — SESSION_SECRET,
   PAYOUT_ENCRYPTION_KEY only if no real payout accounts exist yet (see
   the warning in §9), bridge secret, admin PIN.
4. Review the audit log for admin actions you do not recognise.
5. Review recent git history for commits you do not recognise.
6. danish decides on authority notification (Cyber Bureau, below).

### Cybercrime reporting (item 418)

No incident has occurred to date. If one does:

- Nepal Police Cyber Bureau — report online at
  https://cyberbureau.nepalpolice.gov.np/ (report page:
  /report-cyber-crime/) or by email to
  cyberbureau@nepalpolice.gov.np. Police emergency: 100. Verify current
  numbers on the official site before calling. Note: under the
  Electronic Transactions Act 2063, a complaint must generally be made
  within 90 days of learning of the offence.
- Keep a copy of any complaint filed, plus the evidence exports.
- For sexual exploitation / CSAM / non-consensual intimate images
  (Terms §10): remove the content immediately, preserve evidence, and
  report to the Cyber Bureau — danish decides, same day.

### Post-incident review (items 250/953)

Within one week of any P1/P2 (and any P3 that taught something):

1. What happened, in order, with times.
2. What went well / what went badly.
3. Root cause.
4. Actions (each with an owner and a date) — code fix, doc fix, process
   fix, or "accepted risk" with danish's sign-off.
5. Write it up and keep it with the incident record. Update this
   runbook if the incident exposed a gap in it.

## 5. Review routines

### Weekly (items 177/748/938)

- Netlify function logs: scan for errors and unusual volume.
- Admin audit log: scan for unusual admin actions, failed logins, and
  payout reveals that look wrong.
- Login attempts: check failed admin logins (repeated failures may mean
  someone is guessing the PIN — see §9).
- Load-time check: open the live site and note if it feels slow; run a
  PageSpeed check monthly (below) or sooner if it feels off.

### Monthly (items 906/909/964/940/791)

- Dependency updates: review and merge Dependabot PRs (CI runs on each
  one). Check `npm audit` output for new advisories.
- Advisory sources: GitHub Dependabot alerts (this repo), the npm
  advisory database, and Node.js security releases.
- PageSpeed check: run PageSpeed Insights on the live homepage after
  any major change; record the scores in
  `docs/PERFORMANCE-REPORT-TEMPLATE.md`.
- Login-attempt log review: failed admin logins for the month.
- Broken-link check: run `./tests/check-live.sh` (covers robots,
  sitemap, headers, health) and click through the Help topics.

### Six-monthly (item 260)

- Stored-data review: check what is stored (users, bills, verification
  documents, audit log) against the retention policy (§8). Delete what
  should not be there. Confirm verification documents are being deleted
  after review.

### Quarterly (items 956/957/983/798)

- Security audit: re-run this checklist's security checks (headers via
  `tests/check-live.sh`, `npm audit`, secret scan, CodeQL findings,
  review the admin audit log). This checklist job (November 2026) was
  the first audit — see `docs/SECURITY-REVIEW-2026.md`.
- User-account review: list users in the admin console; suspend
  abusive or fake accounts.
- Hosting-usage review: Netlify bandwidth/build minutes and Supabase
  database size against the free limits (§2). Plan the upgrade before
  hitting a limit, not after.
- Performance + accessibility review: PageSpeed + a manual pass
  (keyboard, screen-size, reduced motion).

### Annually (item 297 + policy review)

- Vendor review: re-check every vendor in `docs/VENDORS.md` (plan,
  price, region, terms). Confirm the free tiers still cover the usage.
- Policy review: re-read the Terms, Privacy Policy, and this runbook;
  update version numbers and archive old versions in
  `docs/legal-archive/`.
- Security architecture review: re-read `docs/SECURITY.md` (threat
  model) and update it for anything that changed.

### PIN rotation (item 959)

The admin PIN should be rotated every 90 days. This is danish's action
(change it in the admin console). There is no automatic reminder — note
the next rotation date when rotating.

## 6. Content inventory (item 969)

App views (hash routes): #/splash, #/welcome, #/country, #/onboarding,
#/age-block, #/swipe, #/bill/:id, #/photo/:billId, #/post (6 steps),
#/leaders, #/brands, #/brand/:id, #/brand-new, #/auctions, #/auction/:id,
#/mybills, #/profile/:username, #/settings, #/help, #/notifications,
#/verify, #/gift/:billId (4 steps), #/founder-tip, #/admin (login/setup),
#/admin/dashboard, #/admin/queue, #/admin/users, #/admin/verifications,
#/admin/reports, #/admin/fees, #/admin/audit.

Help topics (12): About Sahay Pay, How helping works, How posting works,
FAQ, Verification explained, Fees & founder tip, Refunds, Safety,
Content rules, Complaints & appeals, Privacy Policy, Terms.

Legal documents: Terms of Service v1.0 and Privacy Policy v1.0, in the
Help Centre (constants in `public/js/app.js`) and archived in
`docs/legal-archive/`. Footer links to refund/privacy/terms are on every
page (workstream A).

Static public files: `robots.txt`, `sitemap.xml`,
`.well-known/security.txt`, `manifest.webmanifest`, favicons + app
icons, `og-image.png`.

## 7. Restore procedure (items 228/922)

### Code / site restore

1. Netlify dashboard → Deploys → publish the last good deploy (§3).
2. Or `git revert` the bad commit on `main` and let Netlify redeploy.

### Database restore

**Current state: there is no backup.** Supabase free has no scheduled
backups and no point-in-time recovery. Until backups exist, a lost or
corrupted database cannot be restored — this is the project's largest
operational risk and the reason the owner is deciding on a backup plan.

Once backups exist (paid Supabase plan or manual exports), the restore
steps are:

1. Stop writes: publish a holding deploy or take the site down in the
   Netlify dashboard so no new data lands mid-restore.
2. Supabase dashboard → Database → Backups → restore to the chosen
   point (paid plan), or restore a manual SQL dump with `psql`.
3. Verify row counts (users, bills, gifts) against the pre-incident
   numbers from the admin dashboard / audit log.
4. Bring the site back up; run `./tests/check-live.sh`; spot-check the
   feed and one bill.
5. Record the restore in the incident log.

Manual export (until automated backups exist): Supabase dashboard → SQL
editor → export, or `pg_dump` with the connection string. Store exports
outside the repo, encrypted, and never commit them.

## 8. Retention policy (items 225/292/993/919)

| Data | Retention |
|---|---|
| Profiles and bills | Until the user deletes them |
| Verification documents | Deleted after the review is decided |
| Sessions | 30 days (user login), 24 hours (admin login) |
| Audit log entries | 1 year (no automated purge job exists on the free tier — delete manually at review) |
| Netlify function logs | Per platform retention |
| Backups (once they exist) | Daily 7, weekly 4, monthly 12 |

Enforcement note: backup retention is policy only until backups exist
(blocked on the backup decision). Audit-log purging after 1 year is a
manual step at the six-monthly data review (§5).

## 9. Credentials, sessions, PIN (items 75/249/955)

### Credential rotation (item 75)

Rotate in the Netlify dashboard (environment variables), then redeploy
so the function picks up the new values. Test the site after each
rotation.

| Secret | How to rotate | Effect |
|---|---|---|
| `SESSION_SECRET` | Generate a new base64 48-byte value; set in Netlify; redeploy | All user sessions stop working — everyone must log in again |
| `PAYOUT_ENCRYPTION_KEY` | **NEVER rotate after real payout accounts exist** — existing encrypted payout details would become unreadable. Rotation is only safe while no real payout accounts are stored. | Breaks decryption of stored payout details |
| `CLAUDE_APPROVAL_BRIDGE_SECRET` | New random value in Netlify; update the bridge caller to match | Bridge calls with the old secret fail (401) |
| `ADMIN_SETUP_TOKEN` | New random value in Netlify | Only affects first-run PIN setup (already done) |
| `DATABASE_URL` | Rotate in Supabase (new password), update Netlify | Old connection string stops working |

If a secret is ever committed to the repo by mistake: remove it, rotate
it immediately (it is public the moment it is pushed), and check the
secret scan (`scripts/check-secrets.sh`) passes.

### Session revocation — no passwords (item 249)

There are no passwords to reset. To cut off a user:

1. Suspend the user in the admin console (Admin → Users) — this stops
   them using the service.
2. Log them out everywhere: delete their session row(s) in Supabase
   (sessions table) or use the admin console if it offers logout.
3. If the admin PIN is compromised: change the PIN in the admin console
   (this ends the admin session); if the PIN itself is unknown, use the
   PIN-recovery procedure below.

### Admin PIN recovery (item 955)

If the admin PIN is lost:

1. Open the Supabase SQL editor.
2. Delete the PIN hash row (settings is a key/value table):
   `DELETE FROM settings WHERE key = 'admin_pin_hash';`
3. Open the live site → Admin → the first-run PIN setup appears again.
4. Set a new PIN immediately — until then, anyone could set it.

There is no "backup admin account" — the PIN is the only admin access,
by design.

## 10. Monitoring

There is no uptime monitoring or alerting yet (it needs an account the
owner has not chosen). Until then, monitoring is manual: the weekly
routine (§5) plus `./tests/check-live.sh` after every deploy. When the
owner picks a monitor, document it here and in `docs/VENDORS.md`.

## 11. Branches + review workflow (item 998)

- `main` is the live branch. Netlify auto-deploys every push to `main`.
- Work happens on short-lived branches (one per workstream or change).
- Every change goes through a pull request: CI green (suites + audit +
  secret scan) and a coordinator review before merge.
- Never push directly to `main` except a revert during an incident.
- Never commit secrets, test data, or `.env`. Never run the suites
  against live. Never edit `tests/live-wipe.sql` without coordinator
  agreement.
- Commits are SSH-signed (item 196): the local repo config sets
  `gpg.format=ssh`, `user.signingkey=~/.ssh/id_ed25519.pub`, and
  `commit.gpgsign=true`, so every commit carries a signature from the
  deploy key. Verify with `git verify-commit HEAD` (needs
  `gpg.ssh.allowedSignersFile` pointing at the repo's `allowed_signers`
  file). GitHub shows the "Verified" badge only after the same public
  key is added as a *signing* key on the sahaypay-np account — that step
  is the owner's, in GitHub Settings → SSH and GPG keys.

## 12. "Update docs after every change" (item 974)

Any change that alters behaviour, setup, hosting, security, or policy
must update the matching doc in the same pull request: code change →
`ARCHITECTURE.md` if the contract changed; new env var → `README.md` +
`.env.example`; new Help topic → content inventory (§6); new vendor →
`docs/VENDORS.md` + `docs/DATA-REGISTER.md`; policy wording change →
version bump + `docs/legal-archive/` copy.
