# Monthly Maintenance Report — TEMPLATE

Copy this file each month (e.g. `docs/reports/maintenance-2026-12.md`)
and fill it in. Delete the guidance in italics when done.

## Month: YYYY-MM

**Prepared by:** _name_
**Date:** _date_

## Deploys this month

| Date | Commit / deploy | What changed | Check-live result |
|---|---|---|---|
| | | | PASS / FAIL (notes) |

## Dependency updates

- Dependabot PRs merged: _n_ (list any held back + why)
- `npm audit` result: _clean / findings + action_
- CodeQL findings: _none / list + action_

## Reviews done

- [ ] Weekly function-log + audit-log reviews (4–5 done)
- [ ] Monthly login-attempt review
- [ ] Monthly PageSpeed check (scores: _mobile / desktop_)
- [ ] Broken-link check (`tests/check-live.sh`)

## Incidents

_None / list: date, severity, summary, post-mortem link._

## Users & content (from admin dashboard)

- New users this month: _
- Bills posted / approved / rejected: _ / _ / _
- Gifts confirmed: _
- Accounts suspended: _ (reasons)

## Hosting usage (against free limits)

- Netlify bandwidth used: _ / 100 GB
- Supabase database size: _ / 500 MB
- Notes / approaching limits: _

## Backups

- Backup status: _none yet / manual export dated _ / automated (plan _)_
- Last restore test: _date + result (or "not tested")_

## Next month

- _Planned work, pending owner decisions, risks_
