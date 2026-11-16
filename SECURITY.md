# Security Policy

## Reporting a vulnerability

Sahay Pay has **no email address by design** — there is no security email.
Please report vulnerabilities through one of these channels:

1. **In-app complaint form (preferred):** open the Help Centre in the app
   (`https://sahay-pay.netlify.app/#/help?topic=complaints`) and file a
   complaint describing the issue. Every complaint is reviewed by a human.
2. **GitHub:** open an issue at `https://github.com/sahaypay-np/sahay-pay`
   — but **do not post exploit details or private data in a public issue**.
   Use the in-app form for anything sensitive.

## What to include

- What the issue is and where you found it (URL, page, or file + line).
- Steps to reproduce, with the smallest example you can.
- What data or function you think is at risk.
- Whether you tested only your own account and data (please do).

## Our commitment

- We **acknowledge every report within 48 hours**.
- We aim to fix confirmed vulnerabilities promptly and will tell you when
  the fix is live. If a fix needs more time, we will say so and give a
  realistic date.
- We will not take legal action against good-faith researchers who follow
  this policy.

## Scope

- The live site: `https://sahay-pay.netlify.app`
- This repository: `https://github.com/sahaypay-np/sahay-pay`

## Please do not

- Access, modify, or delete other users' data.
- Run automated scanners or load tests against the live site (the free
  hosting tier has strict limits, and heavy traffic can take the site down
  for real users).
- Disclose a vulnerability publicly before we have had a reasonable time
  to fix it.

## No bounty program

There is no paid bug-bounty program. Sahay Pay is a small, free service
run by its owner; we are grateful for reports and will credit reporters
who want credit, but we cannot pay rewards.

## Known posture

- Demo Mode: no real payment integration is connected and no real money
  moves through Sahay Pay.
- No email, no passwords: accounts use device sessions only.
- Payout details are encrypted at rest; verification documents are
  reviewer-only and deleted after review.
