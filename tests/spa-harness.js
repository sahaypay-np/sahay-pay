// Sahay Pay — headless SPA check (jsdom + real server).
// Drives the actual frontend JS in a DOM against the live local API:
// boot, welcome -> country -> onboarding, swipe/leaders/help/settings,
// admin PIN setup + login + dashboard, post step 1.
// Fails on any uncaught page error or failed assertion.
// Usage: npm install --no-save jsdom   (dev-only; NOT a production dependency)
//        BASE=http://localhost:3101 node tests/spa-harness.js
// (server must be running on a FRESH database: no PIN set, no users.)

'use strict';

const { JSDOM, VirtualConsole } = require('jsdom');

const BASE = process.env.BASE || 'http://localhost:3101';
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.detail && e.detail.stack ? e.detail.stack.split('\n')[0] : e.message)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS: ' + name); }
  else { fail++; console.log('FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (fn()) return true; } catch { /* retry */ }
    await sleep(100);
  }
  console.log('TIMEOUT waiting for: ' + label);
  return false;
}

async function main() {
  // Cookie jar: Node fetch doesn't store cookies, so the harness does.
  const jar = new Map();
  function jarFetch(input, init) {
    const url = new URL(typeof input === 'string' ? input : input.url, BASE);
    const headers = new Headers((init && init.headers) || {});
    const cookies = [...jar.entries()].map(([k, v]) => k + '=' + v).join('; ');
    if (cookies) headers.set('Cookie', cookies);
    return fetch(url.toString(), { ...(init || {}), headers }).then((res) => {
      const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const sc of setCookie) {
        const [pair] = sc.split(';');
        const i = pair.indexOf('=');
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      return res;
    });
  }

  const dom = await JSDOM.fromURL(BASE + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.fetch = jarFetch;
      // jsdom has no scrollIntoView/scrollTo; the app calls both on route changes.
      window.HTMLElement.prototype.scrollIntoView = function () {};
      window.scrollTo = function () {};
    },
  });
  const { window } = dom;
  const doc = window.document;
  const $ = (s) => doc.querySelector(s);
  const text = () => (doc.getElementById('view') ? doc.getElementById('view').textContent : doc.body.textContent);

  // 1. Boot -> splash -> welcome (1.4s splash timer).
  check('splash renders', await waitFor(() => text().includes('Sahay Pay'), 5000, 'splash'));
  check('welcome slides render', await waitFor(() => !!$('#w-next'), 5000, 'welcome'));

  // 2. Welcome -> country -> onboarding.
  $('#w-skip').click();
  check('country screen renders', await waitFor(() => !!$('.country-card'), 3000, 'country'));
  doc.querySelector('.country-card[data-c="NP"]').click();
  await sleep(100);
  $('#c-next').click();
  check('onboarding form renders', await waitFor(() => !!$('#ob-form'), 3000, 'onboarding'));

  // 3. Fill + submit onboarding (age 25, NP).
  $('#ob-name').value = 'Harness User';
  $('#ob-age').value = '25';
  $('#ob-city').value = 'Bhairahawa';
  $('#ob-about').value = 'Testing the app end to end.';
  $('#ob-c1').checked = true;
  $('#ob-c2').checked = true;
  $('#ob-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const inOk = await waitFor(() => !!$('#in-go') || text().includes('Start swiping') || text().includes('swiping'), 8000, 'youre-in');
  check('onboarding submits and lands on success screen', inOk, text().slice(0, 200));
  if ($('#in-go')) $('#in-go').click();

  // 4. Swipe: honest empty state (no approved bills on a fresh DB).
  check('swipe renders after onboarding', await waitFor(() => window.location.hash.startsWith('#/swipe') && !!$('#deck-wrap'), 5000, 'swipe'));
  check('swipe shows empty state, not a crash', await waitFor(() => text().includes('No bills') || text().includes('Post the first') || text().includes('first bill') || !!doc.querySelector('.empty'), 5000, 'swipe empty'));

  // 5. Leaders (empty), Help Centre (6 topics), Settings, My Bills.
  window.location.hash = '#/leaders';
  check('leaders renders', await waitFor(() => text().includes('Leaderboard') || text().includes('Leaders'), 5000, 'leaders'));
  check('leaders empty state', await waitFor(() => text().includes('No confirmed') || !!doc.querySelector('.empty'), 5000, 'leaders empty'));
  window.location.hash = '#/help';
  check('help centre renders', await waitFor(() => text().includes('Help Centre') || text().includes('Help Center'), 5000, 'help'));
  window.location.hash = '#/help?topic=terms';
  check('terms page renders full text', await waitFor(() => text().includes('Governing law and contact') && text().includes('Demo Mode'), 5000, 'terms'));
  window.location.hash = '#/help?topic=privacy';
  check('privacy page renders full text', await waitFor(() => text().includes('Your rights') && text().includes('Individual Privacy Act 2075'), 5000, 'privacy'));
  window.location.hash = '#/settings';
  check('settings renders with prefs', await waitFor(() => !!$('#st-save-prefs') && !!$('#st-save-priv'), 5000, 'settings'));
  window.location.hash = '#/mybills';
  check('my bills renders', await waitFor(() => text().includes('My Bills'), 5000, 'mybills'));
  window.location.hash = '#/post';
  check('post step 1 renders', await waitFor(() => !!doc.querySelector('#view h1'), 5000, 'post'));

  // 6. Admin: PIN setup (fresh DB) -> login -> dashboard metrics load.
  window.location.hash = '#/admin';
  check('admin PIN setup screen renders', await waitFor(() => !!$('#ad-setup'), 5000, 'pin setup'));
  $('#ad-pin').value = '123456';
  $('#ad-pin2').value = '123456';
  $('#ad-setup').click();
  check('admin login screen after setup', await waitFor(() => !!$('#ad-pin') && !!doc.querySelector('#ad-body .card'), 5000, 'login after setup'));
  // After setup the login form re-renders; fill and log in.
  await waitFor(() => { const b = [...doc.querySelectorAll('button')].find((x) => x.id === 'ad-login' || /log in/i.test(x.textContent)); return !!b; }, 3000, 'login button');
  const pinInput = $('#ad-pin');
  pinInput.value = '123456';
  const loginBtn = [...doc.querySelectorAll('button')].find((x) => x.id === 'ad-login' || /log in/i.test(x.textContent));
  if (loginBtn) loginBtn.click();
  check('admin dashboard loads', await waitFor(() => window.location.hash.startsWith('#/admin/dashboard') && !!$('#ad-body'), 8000, 'dashboard'));
  check('dashboard shows real metrics (1 user)', await waitFor(() => text().includes('1'), 5000, 'metrics'));

  // 7. No uncaught page errors at any point.
  check('no uncaught page errors', errors.length === 0, errors.slice(0, 5).join(' | '));

  console.log(`=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS CRASH:', e); process.exit(2); });
