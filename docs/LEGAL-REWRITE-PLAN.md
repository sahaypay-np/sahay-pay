# Sahay Pay — Legal Rewrite Project Plan

Phase 2 item 1000. Last updated 16 November 2026.

This plan covers the next full rewrite of the Terms of Service and
Privacy Policy. The Phase 2 rewrite (Nov 2026) was plain-language only
— no legal meaning changed. A future rewrite that changes legal meaning
needs the full process below.

## When a rewrite is needed

- A new feature changes what data is collected, how money moves, or
  what users agree to (e.g. real payments launching, a new country).
- The law changes in Nepal or India (new privacy rules, new e-commerce
  rules, new payment rules).
- The annual policy review (runbook §5) finds something out of date.

## Steps

1. **Scope it.** List exactly which sections change and why. If only
   wording changes, it is a plain-language pass (no version bump, no
   re-acceptance). If legal meaning changes, it is a version bump.
2. **Draft in plain language first.** Write the new sections the way
   the "In short" boxes read — then add the precise legal wording
   underneath. Every section keeps its "In short" box.
3. **Get it reviewed.** A lawyer reviews the draft before publication
   (this is the one step an agent cannot do — it needs danish to engage
   a lawyer). Budget for it; do not publish a legal-meaning change
   without review.
4. **Translate the summaries.** The English version is binding; the
   short summaries above each document are translated to Nepali and
   Hindi. The full legal text stays English-only (translating it would
   create three binding versions).
5. **Archive the old version** in `docs/legal-archive/` and record the
   change in `docs/LEGAL-CHANGELOG.md`.
6. **Bump the version** in `server/lib/policy.js` (Terms/Privacy
   version constants) if the legal meaning changed. The app then asks
   every user to re-accept before continuing.
7. **Announce it.** In-app notice + Help Centre note, in EN/NE/HI,
   saying what changed and why, at least 7 days before it takes effect
   for a legal-meaning change.
8. **Publish + verify.** Deploy, check the Help Centre shows the new
   version, and confirm the re-acceptance flow works (a test user on
   the old version is asked to accept the new one).

## What "done" looks like

- New version live in the app, with "In short" boxes intact.
- Old version archived, changelog updated.
- Re-acceptance verified on a test account.
- Announcement published in all three languages.
