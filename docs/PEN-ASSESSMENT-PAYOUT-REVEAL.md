# Pen Self-Assessment — Payout-Reveal Flow

Phase 2 item 896. Run 16 November 2026 against the LOCAL dev instance
only (fresh server + fresh SQLite DB, port 3112). Never run against
live production.

## Scope

Token theft, IDOR, and rate-limit bypass on the payout-reveal flow
(`GET /api/gifts/:id/challenge`, `POST /api/gifts/:id/reveal`,
`GET /api/gifts/:id`).

## Checklist

| # | Check | Expected | Result |
|---|---|---|---|
| 1 | Reveal another user's gift (IDOR) | Blocked | ✅ 404 — the gift lookup is scoped to the caller, so another user's gift is indistinguishable from a nonexistent one |
| 2 | Read another user's gift `GET /api/gifts/:id` (IDOR) | Blocked | ✅ 404 (same scoping) |
| 3 | Reveal a nonexistent gift | 404 | ✅ 404 |
| 4 | Reveal without a challenge | Blocked | ✅ 400 `CHALLENGE_REQUIRED` |
| 5 | Reveal with a wrong challenge answer | Blocked | ✅ 403 `CHALLENGE_FAILED` |
| 6 | Reveal with a forged challenge id | Blocked | ✅ 403 `CHALLENGE_FAILED` (HMAC signature fails) |
| 7 | Reveal with a challenge for a different gift | Blocked | ✅ 403 — the challenge is bound to its gift id (`cid !== giftId` fails) |
| 8 | Reveal from a session younger than 5 minutes | Blocked | ✅ 403 `SESSION_TOO_NEW` |
| 9 | Valid reveal (challenge solved, session aged) | 200 + payout details | ✅ 200 |
| 10 | Reveal without a CSRF token | Blocked | ✅ 403 `CSRF_INVALID` |
| 11 | Challenge replay: same solved challenge used twice for the same gift | Blocked | ⚠️ **200 — accepted** (see finding F-896-1, LOW) |
| 12 | Session rotation on reveal: old token dead after a reveal | Dead | ✅ verified (the next call with the old token returned 401) |
| 13 | Per-account daily cap (10) / per-bill cap (20) | Enforced | ✅ code-verified (`REVEAL_DAILY_CAP_PER_ACCOUNT=10`, `REVEAL_DAILY_CAP_PER_BILL=20` in `server/lib/security.js`); not exhausted in this run to keep the run short |
| 14 | Every attempt audit-logged, including failures | Logged | ✅ `payout_reveal_blocked` entries with reasons in the audit log |

## Findings

### F-896-1 (LOW) — Solved challenges are replayable within their 10-minute window

**What:** The challenge is stateless (HMAC-signed, no server-side
record), so a solved challenge can be submitted again for the same gift
within its 10-minute TTL. Verified: a second reveal with the same
`challengeId` + answer returned 200.

**Impact:** Low. The challenge is bound to one gift and one user, the
attacker already has the details from the first reveal, each replay
still counts against the daily caps and is audit-logged. There is no
cross-gift or cross-user reuse.

**Fix:** Make challenges single-use with a server-side used-challenge
record (DB table `used_challenges`, challenge id + expiry, lazy
cleanup). An in-memory set is not enough — serverless instances do not
share memory.

**Re-test:** after the fix lands, re-run check 11; expected 403 on the
second use. Target: next security review (see the yearly self-review
checklist in `docs/RUNBOOK.md` §5).
