// Sahay Pay — versioned Terms / Privacy Policy constants.
// Bump BOTH versions together whenever either document changes; users who
// accepted an older version get an in-app re-acceptance notice (there is no
// email channel). The versioned policy TEXT lives in the Help Centre
// (workstream C owns the wording); this file owns only the version numbers.
'use strict';

const TERMS_VERSION = '1.0';
const PRIVACY_VERSION = '1.0';
const POLICY_EFFECTIVE_DATE = '2026-11-16';

function consentIsCurrent(userRow) {
  if (!userRow) return false;
  return (
    userRow.terms_accepted_version === TERMS_VERSION &&
    userRow.privacy_accepted_version === PRIVACY_VERSION
  );
}

module.exports = { TERMS_VERSION, PRIVACY_VERSION, POLICY_EFFECTIVE_DATE, consentIsCurrent };
