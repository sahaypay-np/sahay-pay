# Sahay Pay — Data Classification

Four levels. When in doubt, classify up, not down.

## Public

Visible to anyone on the site.

- Published bill posts (amount, category, description, public photo,
  city/country, masked payout hint)
- Public profiles (display name, city, about, badges)
- Leaderboards (names + confirmed-help totals)
- Help Centre, Terms, Privacy Policy, brand assets

Handling: no special controls. Still never publish someone else's
private details — bill photos must be redacted before posting (the app
has a redaction step).

## Internal

Visible to the owner/admin and needed to run the service. Not public.

- Pending-review bills and their review packets
- Reports, complaints, and appeals
- Audit log entries
- Admin metrics and fee configuration
- Session records (hashes + expiry, not tokens)

Handling: admin console only; do not copy into chat, screenshots, or
other tools except for incident evidence (runbook §4). Retain per the
runbook retention table.

## Confidential

Personal data whose leak would harm a user.

- Full payout details (eSewa/Khalti number, UPI ID, bank details)
- Verification documents (ID photos, bill proof)
- Full profile data behind the public view (exact age, if stored)
- User session tokens (while live)

Handling: encrypted at rest where stored (payout details:
AES-256-GCM); shown only to the intended recipient at the intended step
(payout details: only to a helper at the Send step; verification
documents: reviewer only); every payout reveal logged; deleted per the
retention schedule (verification documents: after review). Never in
logs, never in the repo, never in screenshots.

## Highly sensitive

Loss or leak would compromise the whole service.

- `SESSION_SECRET`, `PAYOUT_ENCRYPTION_KEY`
- `CLAUDE_APPROVAL_BRIDGE_SECRET`, `ADMIN_SETUP_TOKEN`
- `DATABASE_URL` (full database access)
- Admin PIN (and its scrypt hash)
- Production backups / database exports (once they exist)

Handling: Netlify dashboard / Supabase dashboard / owner's password
manager only. Never in the repo, chat, docs, screenshots, or URLs.
Rotate immediately if ever exposed (runbook §9). The secret scan
(`scripts/check-secrets.sh`) guards the repo; nothing guards a
screenshot — do not take one.
