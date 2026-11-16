# Sahay Pay — Legal Changelog

Phase 2 item 903. Every change to the Terms of Service or Privacy
Policy, newest first. The full text of each version is archived in
`docs/legal-archive/`.

| Version | Date | Document | What changed |
|---|---|---|---|
| 1.0 | 16 Nov 2026 | Terms + Privacy | First published versions. Terms: ETA 2063 clause, contract formation, copyright reporting, disputes clause. Privacy: retention schedule, cookie table, 30-day access/export response. |
| 1.0 | 16 Nov 2026 | Terms | Plain-language rewrite (Phase 2): "What Sahay Pay is — and is not" box added at the top; "In short" summary box added above each of the 14 sections; intro rewritten in plain EN/NE/HI. No legal meaning changed. |
| 1.0 | 16 Nov 2026 | Privacy | Data-minimisation statement added (§1: each data type named with its purpose); breach-notification commitment added (§4). No legal meaning changed. |

## Rules

- A new **version number** (1.1, 2.0, …) is required for any change to
  the legal meaning — new obligations, new data collected, new rights,
  new retention periods. Plain-language clarifications that change no
  meaning are recorded here but do not bump the version.
- When the version bumps, users must re-accept (the app enforces this
  via `consentCurrent` — see `server/lib/policy.js`).
- Archive the old version in `docs/legal-archive/` before publishing
  the new one.
