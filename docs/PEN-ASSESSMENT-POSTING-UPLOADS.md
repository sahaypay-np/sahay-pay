# Pen Self-Assessment — Bill Posting + Upload Flows

Phase 2 item 898. Run 16 November 2026 against the LOCAL dev instance
only (fresh server + fresh SQLite DB, port 3112). Never run against
live production.

## Scope

Malicious files, XSS in bill text, and CSRF on bill posting
(`POST /api/bills`) and uploads (`POST /api/uploads`).

## Checklist

| # | Check | Expected | Result |
|---|---|---|---|
| 1 | Bill with `<script>alert(1)</script>` in the title and `<img onerror>` in the story | Stored safely, rendered escaped | ✅ stored; the SPA renders bill titles/stories through `esc()` (`public/js/app.js` — verified `esc(bill.title…)` in the render paths). No script executes. |
| 2 | Bill create without a CSRF token | Blocked | ✅ 403 `CSRF_INVALID` |
| 3 | Bill create with the honeypot field filled | Blocked | ✅ 400 |
| 4 | Upload a `.exe` file | Rejected | ✅ 400 |
| 5 | Upload a `.html` file | Rejected | ✅ 400 |
| 6 | Upload an `.svg` file (script-capable image) | Rejected | ✅ 400 — SVG is not in the allowed MIME set |
| 7 | SQL injection in the feed `category` filter (`' OR 1=1 --`) | No error, no leak | ✅ 200 with a normal (empty) feed; no payout data in the response |
| 8 | Upload without a CSRF token | Blocked | ✅ 403 (upload route requires the user CSRF token) |
| 9 | Oversized file (>5 MB) | Rejected | ✅ code-verified — multer `MAX_FILE_BYTES = 5 MB` |
| 10 | EXIF/location metadata in an uploaded photo | Stripped | ✅ code-verified + verified by the upload response flag (`metadataStripped`) in the dev run |

## Findings

### F-898-1 (INFO) — XSS defence depends on client-side escaping

**What:** The server stores bill text raw and relies on the SPA's
`esc()` at every render site. That is the established pattern in this
codebase (all render paths use `esc()`), and it held in this
assessment — but a future render path that forgets `esc()` would
reintroduce stored XSS.

**Impact:** Informational. No live vulnerability was found.

**Fix (recommended):** add a harness check that posts a bill containing
`<script>` and `<img onerror>` markers and asserts the rendered page
contains no live `<script>` element and no `onerror` attribute. That
turns the escaping rule into a tested invariant.

**Re-test:** when the harness check lands; otherwise at the next
security review.
