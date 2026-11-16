# Sahay Pay — Data-Minimisation Audit

Phase 2 item 993. Last audited 16 November 2026. Re-audit annually
(see the yearly self-review checklist in `docs/RUNBOOK.md` §5).

Principle: collect as little as possible. Every field below must have
one stated purpose; anything without a purpose is removed.

## What we collect — and why

| Data | Purpose | Kept until | Notes |
|---|---|---|---|
| Display name, age, country, city, about, language, optional photo | The profile helpers see | Account deleted | Age is needed only for the 18+ gate; the exact age is stored but never shown publicly. |
| Payout details (eSewa/Khalti number, UPI ID, bank account) | So a helper can pay the poster | Bill deleted or account deleted | Encrypted (AES-256-GCM, key-per-field); shown publicly only as a masked hint. |
| Bills (title, category, amount, story, photo) | The service itself | Bill deleted or account deleted | Public by design. |
| Verification documents | Human review of badges | Deleted after the review is decided | Reviewer-only. |
| Reports + complaints | Safety and appeals | 1 year (audit log) | Complaint text is kept with the complaint until resolved + 1 year. |
| Session records (cookie, device label, browser family hash) | Keeping the user logged in; detecting session theft | 30 days (user) / 24h (admin) | No IP address is ever stored. Browser version is NOT stored — only the browser family hash, so a browser update does not log the user out. |
| Recovery-code hash | Checking a code the user enters | Account deleted | The code itself is never stored — only a salted hash. |
| Audit log (who did what, when) | Security + transparency reports | 1 year | Never contains payout details or full account numbers. |
| Upload metadata (file size, kind, owner) | The 50 MB/account upload quota | Account deleted | EXIF/location metadata is stripped from photos on upload. |

## What we do NOT collect

Email addresses, passwords, OTPs, MPINs, card numbers, banking
credentials, IP addresses, precise location, device advertising IDs,
or any third-party analytics/tracking data. There are no third-party
analytics or advertising trackers on Sahay Pay.

## Findings (16 Nov 2026)

1. **Exact age stored, only 18+ needed.** The profile stores the exact
   age the user entered. The gate only needs "18 or over". Keeping the
   exact age is a deliberate choice (it lets the profile show an age
   band honestly in future), but it is the one field that collects more
   than the minimum. Decision: keep, revisit at the next audit.
2. **Audit log retention is 1 year.** No automated deletion job exists
   yet — deletion is manual (see runbook). Decision: acceptable while
   the user count is small; add a lazy cleanup when the log grows.
3. **Upload quota metadata** is new (Phase 2). It stores only size,
   kind, and owner — no file content hashes. No change needed.
4. **No new data types were added in Phase 2** beyond the quota table
   and the session device fields (browser family hash, device class,
   trusted note). All have a stated purpose above.
