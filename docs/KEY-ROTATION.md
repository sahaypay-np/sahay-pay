# Sahay Pay — Key Rotation Plan

Phase 2 items 832 / 888 / 893. Last updated 16 November 2026.

## What keys exist

| Secret | Where it lives | What it protects |
|---|---|---|
| `PAYOUT_ENCRYPTION_KEY` | Netlify env vars | Payout account numbers (AES-256-GCM, key-per-field) |
| `SESSION_SECRET` | Netlify env vars | Session tokens, CSRF tokens, challenge HMACs; also the fallback payout-key derivation if `PAYOUT_ENCRYPTION_KEY` is unset |
| Admin PIN | Owner's memory + password manager (hashed in the DB) | Admin console login + elevation |
| `CLAUDE_APPROVAL_BRIDGE_SECRET` | Netlify env vars | The approval-bridge endpoint (if used) |
| `DATABASE_URL` | Netlify env vars | Postgres connection (Supabase) |
| Netlify / Supabase / GitHub account passwords | Owner's password manager | The hosting accounts themselves |

No other secrets exist. There are no payment-gateway keys (Demo Mode —
no real payment integration), no email credentials (the product sends no
email), and no third-party API keys.

## Rotation schedule (item 893)

| Secret | Rotate | How |
|---|---|---|
| Admin PIN | Every 90 days | Admin console → Change PIN (see runbook §5 PIN rotation) |
| `SESSION_SECRET` | Every 12 months, or immediately on suspected leak | Change in Netlify, redeploy. All users are logged out (sessions are signed with it) — announce it in the app first via the fraud banner. |
| `PAYOUT_ENCRYPTION_KEY` | Every 12 months, or immediately on suspected leak | Re-encryption runbook below — never just change the value, or stored payout details become unreadable. |
| `CLAUDE_APPROVAL_BRIDGE_SECRET` | Every 12 months | Change in Netlify + in the bridge caller, redeploy. |
| `DATABASE_URL` | On staff/access change, or on suspected leak | Rotate in Supabase, update Netlify, redeploy. |
| Account passwords | Every 12 months, or on suspected leak | In each provider's settings. |

The monthly review (runbook §5) checks which rotations are due.

## Payout-key rotation runbook (item 888)

Rotating `PAYOUT_ENCRYPTION_KEY` means re-encrypting every stored payout
account under the new key. The tool is `scripts/reencrypt-payouts.js`.

**Before you start:** announce a maintenance window (maintenance mode on,
see runbook §2). Payout reveals are paused during the window so no new
rows are written with the old key mid-rotation.

1. **Back up the database.** Supabase dashboard → backup, or export the
   `payout_methods` table. Keep the backup until the rotation is verified.
2. **Generate the new key:** `openssl rand -base64 32`. Store it in the
   password manager. Never put it in the repo, in chat, or in a file.
3. **Dry run against a copy:**
   `NEW_PAYOUT_ENCRYPTION_KEY=<new> PAYOUT_ENCRYPTION_KEY=<old> node scripts/reencrypt-payouts.js --dry-run`
   against a database copy. It must report 0 failures.
4. **Run for real** (same command, without `--dry-run`) against the live
   database.
5. **Immediately** set `PAYOUT_ENCRYPTION_KEY` to the new key in Netlify
   and redeploy. Between steps 4 and 5 the app cannot read payout
   details — keep the gap to minutes.
6. **Verify:** log in as a test helper, reveal a payout on a test bill,
   confirm the account number reads correctly. Check the audit log for
   `payout_revealed` with no errors.
7. **Keep the old key for 30 days** (password manager only), then destroy
   it. If anything goes wrong in the first hours, restore the database
   backup and the old key.
8. Turn maintenance mode off.

**Failure modes:**
- The script reports failed rows: those rows were encrypted with a key
  that is not the current one (legacy rows from before the key existed,
  or a previous partial rotation). Do NOT deploy the new key until every
  row re-encrypts — failed rows would become unreadable. Investigate the
  row (check its `created_at` against the key history) and re-encrypt it
  by hand from the backup, or delete the bill if it is abandoned.
- The deploy happens before the re-encryption: payout reveals fail with
  decryption errors. Roll back the deploy (old key) and re-run the
  script.

## Key-per-field encryption (item 833)

Payout accounts are encrypted with AES-256-GCM using a key derived per
field type (the payout method: `esewa`, `khalti`, `upi`, `bank_np`, …)
via HMAC-SHA-256 over the master key with the label
`sahay-pay-field:<method>`. A compromised field key exposes only one
field type, never the whole payout table. New ciphertexts carry a `v2:`
prefix; legacy blobs (no prefix, master key directly) still decrypt, so
existing rows keep working until re-encrypted. See
`server/lib/storage.js` (`fieldKey`, `encryptAccount`, `decryptAccount`,
`reencryptAccount`).
