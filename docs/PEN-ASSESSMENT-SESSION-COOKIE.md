# Pen Self-Assessment — Session Cookie

Phase 2 item 899. Run 16 November 2026 against the LOCAL dev instance
only (fresh server + fresh SQLite DB, port 3112). Never run against
live production.

## Scope

Theft, replay, fixation, and cross-site leakage of the user session
cookie (`sp_session`).

## Checklist

| # | Check | Expected | Result |
|---|---|---|---|
| 1 | Cookie flags on `Set-Cookie: sp_session` | HttpOnly + SameSite=Lax (+ Secure in production) | ✅ HttpOnly + SameSite=Lax observed; Secure is set when `NODE_ENV=production` (code-verified — this dev run used plain HTTP, so Secure was correctly absent) |
| 2 | Theft: stolen cookie used from a different browser | Session killed | ✅ the request returned no user; the session was destroyed and `session_fingerprint_changed` was audit-logged; the response carried the `X-Session-Suspicious` header |
| 3 | Replay after logout | Dead | ✅ the logged-out token returned no user |
| 4 | Fixation: onboard with a pre-set `sp_session` cookie | Fresh token issued | ✅ the onboard response set a different token |
| 5 | Rotation: old token dead after recovery-code regeneration | Dead | ✅ old token returned no user; new token worked |
| 6 | Old recovery code dead after regeneration | Dead | ✅ 401 on `/auth/recover` with the old code |
| 7 | Session cap: 4 sessions created for one user | Cap holds at 3, oldest revoked | ✅ 3 sessions after 4 creates; the oldest token was gone from the DB, the newest present |
| 8 | Absolute lifetime | 90 days from creation, however active | ✅ code-verified (`SESSION_ABSOLUTE_DAYS = 90` in `server/lib/auth.js`; enforced in `lookupSession` + capped in `maybeRenewSession` and `rotateSession`) |
| 9 | Session renewal | Sliding 30-day expiry, never past the 90-day cap | ✅ code-verified in `maybeRenewSession` |
| 10 | CSRF token survives rotation | In-flight forms keep working | ✅ by design — rotation carries the CSRF token over (`rotateSession`); verified in the reveal flow (reported-sent succeeded after a reveal rotation) |

## Findings

None. No issues found in this assessment.

**Notes:**
- The fingerprint binding compares the browser *family* hash only, so
  a browser version update does not log the user out, while a
  different browser (or a stolen cookie used elsewhere) kills the
  session. That trade-off is deliberate (see `server/lib/device.js`).
- The 90-day absolute cap was verified by code reading, not by waiting
  90 days. A test that backdates a session's `created_at` past 90 days
  and asserts the next request is rejected would make it a tested
  invariant — recommended for the next test round.
