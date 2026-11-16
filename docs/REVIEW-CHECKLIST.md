# Sahay Pay — Code Review Checklist (security-focused)

Use for every pull request. The reviewer checks each item that applies;
anything that fails blocks the merge until fixed or explicitly accepted
by danish with a recorded reason.

## Correctness & tests

- [ ] All three suites pass on a fresh local server (smoke 57, contract
      73, SPA harness 20) — CI runs them; confirm the CI run is green.
- [ ] No new `console.log` of user data, tokens, or secrets.
- [ ] No fake/demo/placeholder data introduced (the app ships with none).
- [ ] `node --check` passes for any changed JS file.

## Input & output

- [ ] Every new query is parameterised (no string-built SQL).
- [ ] Every new user input is validated server-side (client validation
      alone is never enough).
- [ ] Every new place user content is rendered uses `esc()` (no raw
      `innerHTML` with user data).
- [ ] File uploads: type allowlist, size cap, random filename (see
      existing upload code — do not loosen it).

## Auth & sessions

- [ ] New routes check auth the same way existing routes do; admin
      routes require the admin session.
- [ ] No new route returns another user's private data (payout details,
      verification documents, sessions).
- [ ] No session or token is logged, returned to the client in a body,
      or put in a URL.
- [ ] Cookie changes keep HttpOnly + SameSite=Lax (+ Secure in
      production).

## Secrets & config

- [ ] No secret, key, token, or real credential in the diff
      (`scripts/check-secrets.sh` passes).
- [ ] New env vars are documented in `.env.example` (names only) and
      `README.md`; production values go in the Netlify dashboard, never
      the repo.
- [ ] No new third-party script, font, or tracker (all self-hosted).

## Privacy & legal

- [ ] New data collected is added to the Privacy Policy (§1) and
      `docs/DATA-REGISTER.md` in the same PR.
- [ ] New retention need is added to the Privacy Policy (§5) and the
      runbook retention table.
- [ ] No email, password, OTP, MPIN, or card number is newly collected
      (the service collects none of these by design — collecting one
      needs danish's explicit decision first).

## Docs & deployment

- [ ] `ARCHITECTURE.md` updated if the API contract or layout changed.
- [ ] `docs/RUNBOOK.md` updated if operations changed (deploy, restore,
      rotation, routines).
- [ ] `CHANGELOG.md` updated under Unreleased.
- [ ] If the change affects live behaviour, the post-deploy check
      (`tests/check-live.sh`) still passes in intent — note any new
      check it needs.
