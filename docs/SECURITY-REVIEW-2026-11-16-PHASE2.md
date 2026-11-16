# Sahay Pay — Security Review, Phase 2 Follow-up (16 November 2026)

Phase 2 item 900. Follow-up to `docs/SECURITY-REVIEW-2026.md`. Covers
the four in-house pen self-assessments (items 896–899), run 16 November
2026 against the LOCAL dev instance only (fresh server + fresh SQLite
DB, port 3112). Nothing in this review was run against live production.

## Assessments

| Doc | Area | Checks | Findings |
|---|---|---|---|
| `docs/PEN-ASSESSMENT-PAYOUT-REVEAL.md` | Payout-reveal flow (token theft, IDOR, rate-limit bypass) | 14 | 1 LOW |
| `docs/PEN-ASSESSMENT-ADMIN-PIN.md` | Admin PIN flow (brute force, fixation, timing) | 10 | 0 |
| `docs/PEN-ASSESSMENT-POSTING-UPLOADS.md` | Bill posting + uploads (malicious files, XSS, CSRF) | 10 | 1 INFO |
| `docs/PEN-ASSESSMENT-SESSION-COOKIE.md` | Session cookie (theft, replay, fixation, leakage) | 10 | 0 |

## Findings

### F-896-1 (LOW) — Solved payout-reveal challenges are replayable within 10 minutes

A solved arithmetic challenge can be submitted again for the same gift
within its 10-minute TTL (verified: second reveal returned 200). The
challenge is stateless (HMAC-signed, no server-side record).

**Why LOW:** the challenge is bound to one gift and one user; the
attacker already has the details from the first reveal; each replay
still counts against the daily caps (10/account, 20/bill) and is
audit-logged. There is no cross-gift or cross-user reuse.

**Fix:** single-use challenges via a server-side used-challenge record
(DB table, challenge id + expiry, lazy cleanup). An in-memory set is not
enough — serverless instances do not share memory.

**Re-test:** after the fix lands, re-run check 11 of the payout-reveal
assessment; expected 403 on the second use. Target: next security
review (see the yearly self-review checklist in `docs/RUNBOOK.md` §5).

### F-898-1 (INFO) — XSS defence depends on client-side escaping

The server stores bill text raw; the SPA escapes it at every render
site with `esc()`. No live vulnerability was found, but a future render
path that forgets `esc()` would reintroduce stored XSS.

**Fix (recommended):** add a harness check that posts a bill containing
`<script>` and `<img onerror>` markers and asserts the rendered page
contains no live `<script>` element and no `onerror` attribute.

**Re-test:** when the harness check lands; otherwise at the next
security review.

## What held up

- **IDOR:** gift reads/reveals are scoped to the caller (404 for
  another user's gift — existence is not leaked).
- **Challenge design:** gift-bound, HMAC-signed, 10-minute TTL,
  constant-time signature compare; forged and cross-gift challenges
  fail.
- **Admin PIN:** scrypt + constant-time compare; 10/15-min brute-force
  limit (429 observed); fixation resisted; elevation gating works.
- **Sessions:** HttpOnly + SameSite=Lax cookies; fingerprint binding
  kills stolen cookies; rotation kills old tokens; cap of 3 holds with
  the oldest revoked; 90-day absolute lifetime enforced in code.
- **Uploads:** exe/html/svg all rejected; 5 MB cap; EXIF stripped.
- **CSRF:** enforced on all tested write endpoints (user + admin).
- **Rate limits:** admin login, recover (5/15 min), and the per-device
  account cap (5/day) all fired during the assessment runs.

## Accepted risks (unchanged from the 2026 review)

- The admin brute-force limit is per IP; a distributed attack would not
  hit it. The 6+ digit PIN space + audit logging is the remaining
  defence. Accepted for a single-owner console.
- No backups exist yet — a lost database cannot be restored (see
  Incident Playbook Scenario 3). This remains the highest-impact open
  item and is an owner decision, not a code fix.
