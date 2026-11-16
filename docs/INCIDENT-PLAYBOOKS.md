# Sahay Pay — Incident Playbooks

Phase 2 item 881. Last updated 16 November 2026.

Three named scenarios, each with: how you know, first hour, fix,
notify, and follow-up. The general incident process (severity levels,
contact order, evidence preservation) lives in `docs/RUNBOOK.md` §4.
These playbooks are the scenario-specific part.

## Scenario 1 — Suspected payout-data breach

**How you know:** an alert, a user report, or the admin Security view
showing a spike in blocked reveals, fingerprint changes, or anomalies —
or a hosting provider tells you the database was accessed.

**First hour:**
1. Turn on the **emergency freeze** (admin dashboard or Security view) —
   the feed and new gifts stop; payout reveals stop too.
2. Turn on **maintenance mode** if the freeze is not enough to stop the
   access (e.g. the database itself is exposed).
3. Preserve evidence: export the audit log (admin → Audit → Export),
   note the time you noticed, and do not delete anything.
4. Check what was accessed: Supabase logs, Netlify logs, the audit log's
   `payout_revealed` / `payout_reveal_blocked` / `session_fingerprint_changed`
   entries for the window.

**Fix:**
1. If a key is suspected leaked: rotate `PAYOUT_ENCRYPTION_KEY` using
   the runbook in `docs/KEY-ROTATION.md` (re-encryption script + Netlify
   update + redeploy). Rotate `SESSION_SECRET` too — all users are
   logged out, which is the point.
2. If an account is compromised: suspend it (admin → Users), revoke its
   sessions, and check its bills.
3. Fix the hole that let it happen (the post-incident review decides
   what that is — see below).

**Notify:**
1. Users whose payout data may have been exposed: in-app notification +
   Help Centre security-status page, using the breach-notification
   template (`docs/BREACH-NOTIFICATION-TEMPLATE.md`, EN/NE/HI). Say what
   happened, what data was involved, what you did, and what they should
   do (watch their eSewa/Khalti/bank account; change their MPIN if they
   shared it — though Sahay Pay never asks for MPINs).
2. Report to the relevant authority where the law requires it (see
   runbook §4 cybercrime reporting).

**Follow-up:** post-incident review within 7 days (runbook §4). Update
the threat model in `docs/SECURITY.md` if the attack was new.

## Scenario 2 — Mass fake-bill / scam wave

**How you know:** the review queue fills with similar bills, the abuse
dashboard shows a spike in fraud reports, or users report the same scam
in complaints.

**First hour:**
1. Turn on the **fraud banner** (admin → Security) with a short warning
   naming the scam pattern.
2. Add the scam to the **known-scams list** so it appears on the public
   known-scams page.
3. Pause the affected bills (admin → Reports → pause) — a credible fraud
   report already pauses a bill automatically, but check for siblings
   the reporter missed.

**Fix:**
1. Review the queue in bulk: reject the fake bills, suspend the accounts
   behind them (admin → Users).
2. Check for a pattern: same device fingerprint, same payout account,
   same wording. If one payout account appears on many bills, that is
   one scammer — suspend every account using it.
3. If the wave is automated (many posts in minutes), turn on the
   **emergency freeze** until the queue is cleared.

**Notify:**
1. Users who gifted to a fake bill: in-app notification that the bill
   was removed and why, and a reminder that Sahay Pay cannot reverse a
   transfer it never held — but they should report the fraud to their
   payment provider and the police.
2. Post the scam on the known-scams page (done above) and keep the fraud
   banner up until the wave passes.

**Follow-up:** add the scam phrases to the server's scam-phrase list
(`server/lib/abuse.js`) so future posts are flagged at submission.
Post-incident review within 7 days.

## Scenario 3 — Admin PIN compromise

**How you know:** an admin login you did not make (check the audit log
for `admin_login` entries), a PIN-change notification you did not
trigger, or the PIN was shared/seen by someone else.

**First hour:**
1. **Change the PIN immediately** (admin → Change PIN). This rotates the
   admin session — any other admin session is killed.
2. Check the audit log for what the other session did: review decisions,
   fee changes, user suspensions, freeze/banner changes. Undo anything
   wrong (reopen wrongly resolved complaints, restore wrongly suspended
   users, re-check fee settings).
3. If the intruder changed the PIN first and you are locked out: the PIN
   hash lives in the database (`settings` table, `admin_pin_hash`). A
   database-level reset is the recovery path — see runbook §4.

**Fix:**
1. Review every admin action in the window and reverse the bad ones.
2. If any user data was viewed or exported by the intruder, treat it as
   Scenario 1 (breach notification).

**Notify:**
1. Users affected by a wrong admin decision (e.g. a wrongly suspended
   account): in-app notification + reversal.
2. If user data was exposed, follow Scenario 1's notification steps.

**Follow-up:** post-incident review within 7 days. Consider whether the
PIN was guessable (it must be 6+ digits and not a birth year or
sequence) and whether the 90-day rotation was overdue.
