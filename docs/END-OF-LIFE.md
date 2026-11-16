# Sahay Pay — End-of-Life Plan

What happens if Sahay Pay ever shuts down. Written now so the shutdown
is orderly, not a scramble. danish decides if and when this plan is
used; nothing here is a decision to shut down.

## Principles

- Users get notice and a way to take their data with them.
- No user is left with a gift in limbo: in-flight gifts are resolved
  (confirmed or the parties told) before shutdown.
- Data is deleted, not abandoned. Backups (once they exist) are deleted
  on the same schedule.
- The shutdown itself is communicated honestly and in plain language.

## Shutdown sequence

### 1. Decide and date it (owner)

- danish sets the shutdown date (at least 30 days out) and approves
  the notice text.
- Freeze new feature work; only shutdown tasks proceed.

### 2. Notify users (30 days before)

- In-app notice on every screen + a Help Centre topic explaining:
  the date, why, what happens to posts/gifts, and how to export data.
- There are no email addresses on file, so in-app notice is the
  channel. If any other channel exists by then (e.g. social accounts),
  post there too.

### 3. Stop new activity (14 days before)

- Disable new bill posts and new gift creation (admin switch or a
  holding deploy).
- Existing live bills stay visible so in-flight gifts can complete.
- Owner reviews and resolves every pending item in the admin queue.

### 4. Data export window (until shutdown day)

- Every user can export their own data: profile, bills, gifts
  (confirmed + pending), and their complaint history. Export format:
  JSON + human-readable summary. (No self-serve export exists today —
  build it as part of the shutdown work, or export from the database on
  request via the complaint form.)
- Owner exports the full dataset for the archive (encrypted, stored
  offline, access limited to the owner).

### 5. Shutdown day

- Unpublish the site in the Netlify dashboard (or publish a holding
  page with the shutdown notice + a contact route).
- Stop the function (disconnect the repo or delete the site in
  Netlify).
- Delete the Supabase project data (or the whole project) after the
  archive export is verified.
- Revoke/rotate all secrets; delete the Netlify + Supabase projects
  when the archive is confirmed.

### 6. After shutdown (30 days)

- Keep the holding page up for 30 days with the notice and a contact
  route, then take it down.
- Delete the offline archive after the retention the owner chooses
  (default: 1 year, matching the audit-log retention), unless a legal
  hold applies.
- Archive the repo (GitHub → Archive) rather than deleting it, so the
  code and docs survive for reference. Remove any live credentials
  from the vendor dashboards first (they are not in the repo).

## Redirects

- There is no custom domain today, so there are no redirects to keep.
  If a custom domain exists by shutdown time: keep the domain for 1
  year, redirecting `/` to the holding page, then let it lapse.
- Do not redirect users to any other service without their consent.

## Account closure checklist

- [ ] Netlify site deleted (after holding period)
- [ ] Supabase project deleted (after archive verified)
- [ ] GitHub repo archived (not deleted)
- [ ] All secrets rotated/revoked (nothing live to leak)
- [ ] Vendor accounts closed or kept per owner's choice
- [ ] Final note written to `CHANGELOG.md`
