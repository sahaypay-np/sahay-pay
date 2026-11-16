# Sahay Pay — Decision Log

Durable decisions and their reasons. Newest first. A decision stays
until danish changes it — record the change here with the date, don't
rewrite history.

## 2026-11-16 — Name stays "Sahay Pay" despite the Ethiopian collision

An Ethiopian mobile wallet named "SahayPay" (RAYS Micro Finance
Institution, sahaypay.com, 540k users by end-2021, now 1M+ claimed)
already exists in the same sector. Recorded as a flag for lawyer review
in `docs/SECURITY-REVIEW-2026.md`. **No rename:** the name was the
owner's explicit final choice. Do not rename anything without his word
after legal advice.

## 2026-11-16 — No analytics until the owner says so

No third-party analytics, no trackers, no third-party scripts of any
kind. The service runs with zero analytics. Adding any analytics needs
danish's explicit decision (and a Privacy Policy update first).

## 2026-11-16 — Fee model: supporter fee live, zero-fee + tip staged

The fee engine supports a supporter fee (NPR: Rs 160 up to Rs 1,600,
then 10%; INR: Rs 100 up to Rs 1,000, then 10%; charity asks free).
Zero-fee mode and the founder tip are staged alongside it. While Demo
Mode is active, fees are quoted only and never collected. Which mode is
live is a config switch, not a code change.

## 2026-11-16 — 30-day sessions

User logins last 30 days (sliding renewal when < 7 days remain); admin
logins last 24 hours. No "remember me" option — 30 days is the fixed
term, stated in the Terms (§3) and Privacy Policy (§5, §8).

## 2026-11-16 — Recovery codes: proposed, awaiting owner decision

A user who logs out, clears cookies, or switches device currently
cannot return to their account (no email/password by design). Proposed
fix: a recovery code shown at signup. **Status: proposed, not decided**
— danish has not yet chosen. Do not build it until he does. (Found
during the 16 Nov real-browser journey check.)

## 2026-11-16 — Demo Mode until real gateways + licences exist

No real payment integration is connected and no real money moves
through Sahay Pay. Gifts are made by users in their own payment apps.
The service stays in clearly-labelled Demo Mode until the business is
registered and authorised gateways/licences exist. Never present the
service as handling real payments.

## 2026-11-15 — No-email auth

Accounts are created from simple questions only (name, age, country,
city, about). No Gmail/Google login, no email address, no password.
Reason: the Nepal/India audience should not need a Google account to
get help. Consequence: no password reset, no email notifications, and
the recovery problem above.

## 2026-11-15 — Netlify + Supabase (free tiers)

Hosting: Netlify free (Starter), Git-connected, static SPA + Express
as a Function. Database: Supabase free Postgres (Mumbai). Chosen after
Vercel (SMS verification blocked), Render (card required), and Koyeb
(unusable panel) all failed on 2026-11-16. Known limits: no scheduled
backups, no monitoring, uploads ephemeral on the function.

## 2026-11-15 — Human approval for everything public

Every post, brand ask, and auction is approved by the owner before it
goes public. AI can flag things; AI can never approve. This is the main
fraud control and it does not scale past one reviewer — accepted
deliberately at this size.

## 2026-11-07 — Halved price pack (freelancer profiles, not the app)

Not an app decision, recorded to avoid confusion: the owner's
freelancing prices were halved on 2026-11-07 (Business Website $125,
Web App $250, hourly $7.50). This does not affect Sahay Pay fees.
