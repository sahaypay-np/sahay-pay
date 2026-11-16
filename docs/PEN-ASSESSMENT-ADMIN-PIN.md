# Pen Self-Assessment — Admin PIN Flow

Phase 2 item 897. Run 16 November 2026 against the LOCAL dev instance
only (fresh server + fresh SQLite DB, port 3112). Never run against
live production.

## Scope

Brute force, session fixation, and timing attacks on the admin PIN flow
(`POST /api/admin/setup-pin`, `/login`, `/elevate`, `/change-pin`,
and the admin session cookie `sp_admin`).

## Checklist

| # | Check | Expected | Result |
|---|---|---|---|
| 1 | Admin endpoint without an admin session | 401 | ✅ 401 on `GET /api/admin/metrics` |
| 2 | Login with a wrong PIN | 401 | ✅ 401 |
| 3 | Elevate with a wrong PIN | 401 | ✅ 401 |
| 4 | Brute force: 12 rapid wrong-PIN logins | Rate-limited | ✅ 429 after the burst (limit: 10 attempts / 15 min per IP) |
| 5 | Session fixation: log in with a pre-set `sp_admin` cookie | Fresh token issued | ✅ the login response set a different token; the pre-set value was not adopted |
| 6 | Change PIN with a wrong old PIN | Blocked | ✅ 400 (validation error; PIN unchanged) |
| 7 | Admin POST without a CSRF token | Blocked | ✅ 403 `CSRF_INVALID` |
| 8 | Timing: PIN comparison | Constant-time | ✅ code-verified — PINs are verified with scrypt + `crypto.timingSafeEqual` (`server/lib/auth.js` `verifySecret`); no early-exit string compare |
| 9 | Elevation required for review decisions + fee changes | 403 without elevation | ✅ verified in the smoke run (review returned 403 before `/admin/elevate`, 200 after) |
| 10 | PIN setup rate limit | Limited | ✅ code-verified — 5 attempts / hour |

## Findings

None. No issues found in this assessment.

**Notes:**
- The brute-force limit (10/15 min) is per IP. A distributed attack
  from many IPs would not hit it; the 6+ digit PIN space (1,000,000+
  combinations) is the remaining defence, plus the audit log's failed
  login entries. Accepted risk for a single-owner console; revisit if
  the admin console ever gains more users.
- The PIN is 6+ digits, numeric only. A longer alphanumeric admin
  secret would be stronger, but the PIN is a deliberate usability
  choice for a single owner typing on a phone.
