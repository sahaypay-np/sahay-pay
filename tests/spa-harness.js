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
  check('splash renders', await waitFor(() => !$('#boot-loading') && text().includes('Sahay Pay'), 5000, 'splash'));
  check('welcome slides render', await waitFor(() => !!$('#w-next'), 5000, 'welcome'));

  // 2. Welcome -> country -> onboarding.
  check('welcome offers recovery-code sign-in', !!$('#w-recover'));
  $('#w-skip').click();
  check('country screen renders', await waitFor(() => !!$('.country-card'), 3000, 'country'));
  check('topbar+dock hidden on no-chrome country page', window.getComputedStyle($('#topbar')).display === 'none' && window.getComputedStyle($('#dock')).display === 'none');
  doc.querySelector('.country-card[data-c="NP"]').click();
  await sleep(100);
  $('#c-next').click();
  check('onboarding form renders', await waitFor(() => !!$('#ob-form'), 3000, 'onboarding'));

  // 3. Fill + submit onboarding (age 25, NP). Consent is two separate
  // checkboxes now (Terms; Privacy Policy) plus the 18+ checkbox.
  check('onboarding has split consent checkboxes', !!$('#ob-c2') && !!$('#ob-c3'));

  // 3. Onboarding validation: empty submit shows specific inline errors (562/554),
  // then a partial fill clears only the fixed field's error (555: data preserved).
  $('#ob-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(100);
  check('onboarding empty submit shows inline errors', !!$('#e-name').textContent && !!$('#e-age').textContent && !!$('#e-city').textContent,
    'name=' + $('#e-name').textContent + ' age=' + $('#e-age').textContent + ' city=' + $('#e-city').textContent);
  check('onboarding error fields get aria-invalid + aria-describedby',
    $('#ob-name').getAttribute('aria-invalid') === 'true' && $('#ob-name').getAttribute('aria-describedby') === 'e-name');
  $('#ob-name').value = 'Harness User';
  $('#ob-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(100);
  check('onboarding keeps entered data after a failed submit', $('#ob-name').value === 'Harness User' && !$('#e-name').textContent && !!$('#e-age').textContent);

  // Fill + submit onboarding (age 25, NP).

  $('#ob-name').value = 'Harness User';
  $('#ob-age').value = '25';
  $('#ob-city').value = 'Bhairahawa';
  $('#ob-about').value = 'Testing the app end to end.';
  $('#ob-c1').checked = true;
  $('#ob-c2').checked = true;
  $('#ob-c3').checked = true;
  $('#ob-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const inOk = await waitFor(() => !!$('#in-go') || text().includes('Start swiping') || text().includes('swiping'), 8000, 'youre-in');
  check('onboarding submits and lands on success screen', inOk, text().slice(0, 200));
  // Recovery code is shown ONCE on the success screen.
  const rcEl = $('#rc-code');
  check('recovery code shown once on success screen', !!rcEl && /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(rcEl.textContent.trim()), rcEl ? rcEl.textContent.trim() : 'no #rc-code');
  if ($('#in-go')) $('#in-go').click();

  // 4. Swipe: honest empty state (no approved bills on a fresh DB).
  check('swipe renders after onboarding', await waitFor(() => window.location.hash.startsWith('#/swipe') && !!$('#deck-wrap'), 5000, 'swipe'));
  check('topbar+dock visible on chrome swipe page', window.getComputedStyle($('#topbar')).display === 'flex' && window.getComputedStyle($('#dock')).display === 'flex');
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
  check('settings has download-my-data button', !!$('#st-export'));
  check('settings lists sessions', await waitFor(() => !!$('#st-sessions') && text().includes('This device'), 5000, 'sessions list'));
  window.location.hash = '#/mybills';
  check('my bills renders', await waitFor(() => text().includes('My Bills'), 5000, 'mybills'));
  window.location.hash = '#/post';
  check('post step 1 renders', await waitFor(() => !!$('#f-title'), 5000, 'post'));

  // 5b. Post flow end to end (562): step 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> submitted.
  $('#f-title').value = 'Harness electricity bill';
  doc.querySelector('#f-cats .chip').click();
  $('#f-amount').value = '5000';
  $('#f-story').value = 'Harness test story for the post flow, long enough to be a real story.';
  $('#f-adult').checked = true; // phase 2 (123): 18+ confirmation is a hard gate on step 1
  $('#p-next').click();
  check('post step 2 renders (photo)', await waitFor(() => !!$('#f-photo'), 3000, 'post step 2'));
  $('#p-next').click();
  check('post step 3 renders (profile)', await waitFor(() => !!$('#f-anon'), 3000, 'post step 3'));
  $('#p-next').click();
  check('post step 4 renders (payout)', await waitFor(() => !!doc.querySelector('[data-payout]'), 3000, 'post step 4'));
  doc.querySelector('[data-payout="0"] [data-f="account"]').value = '9800000000';
  doc.querySelector('[data-payout="0"] [data-f="holder"]').value = 'Harness User';
  $('#f-belongs').checked = true;
  check('post step 4 has payout-consent checkbox (920)', !!$('#f-consent'));
  $('#f-consent').checked = true;
  $('#p-next').click();
  check('post step 5 renders (verification)', await waitFor(() => !!$('#v-bill'), 3000, 'post step 5'));
  $('#p-next').click();
  check('post step 6 renders (preview)', await waitFor(() => text().includes('Final preview'), 3000, 'post step 6'));
  $('#f-consent').checked = true; // phase 2 (124): consent checkbox gates submission
  $('#p-next').click();
  check('post submits and shows request code', await waitFor(() => text().includes('Your request code'), 8000, 'post submitted'), text().slice(0, 200));

  // 5c. Complaint form: validation error path, then a real submit (786/554).
  window.location.hash = '#/help?topic=complaints';
  check('complaint form renders', await waitFor(() => !!$('#cp-send'), 5000, 'complaint form'));
  $('#cp-send').click();
  await sleep(100);
  check('complaint empty submit shows inline error', !!$('#cp-err').textContent);
  $('#cp-subject').value = 'Harness complaint';
  $('#cp-body').value = 'Testing the complaint form end to end.';
  $('#cp-send').click();
  check('complaint submits and clears the form', await waitFor(() => $('#cp-subject').value === '' && doc.getElementById('toast-root').textContent.length > 0, 5000, 'complaint sent'));

  // 5d. Footer links (549): all seven present; Terms/Privacy land on full text.
  const footerLinks = [...doc.querySelectorAll('#site-footer a')].map((a) => a.getAttribute('href'));
  check('footer has 10 links (help/community/brand-directory/founder/terms/privacy/refunds/about/scam-warning/how-to-complain)', footerLinks.length === 10 && footerLinks.includes('#/help') && footerLinks.includes('#/community') && footerLinks.includes('#/brand-directory') && footerLinks.includes('#/founder') && footerLinks.includes('#/help?topic=terms') && footerLinks.includes('#/help?topic=privacy') && footerLinks.includes('#/help?topic=refunds') && footerLinks.includes('#/help?topic=about') && footerLinks.includes('#/help?topic=scam-warning') && footerLinks.includes('#/help?topic=how-to-complain'), footerLinks.join(','));
  check('footer copyright present', text().includes('© 2026') || doc.getElementById('site-footer').textContent.includes('© 2026'));
  window.location.hash = '#/swipe';
  await waitFor(() => !!$('#deck-wrap'), 5000, 'swipe again');
  doc.querySelector('#site-footer a[href="#/help?topic=terms"]').click();
  check('footer Terms link opens full terms', await waitFor(() => text().includes('Governing law and contact'), 5000, 'footer terms'));
  doc.querySelector('#site-footer a[href="#/help?topic=privacy"]').click();
  check('footer Privacy link opens full privacy policy', await waitFor(() => text().includes('Individual Privacy Act 2075'), 5000, 'footer privacy'));
  doc.querySelector('#site-footer a[href="#/help"]').click();
  check('footer Help Centre link opens topic list', await waitFor(() => !!$('#help-list'), 5000, 'footer help'));
  // Refunds/About topics land with workstream C; until then they must fall
  // back to the Help Centre list, never a crash or a 404 view.
  doc.querySelector('#site-footer a[href="#/help?topic=refunds"]').click();
  check('footer Refunds link lands on help (topic pending)', await waitFor(() => !!$('#help-list') || text().includes('Refund'), 5000, 'footer refunds'));
  doc.querySelector('#site-footer a[href="#/help?topic=about"]').click();
  check('footer About link lands on help (topic pending)', await waitFor(() => !!$('#help-list') || text().includes('About'), 5000, 'footer about'));
  doc.querySelector('#site-footer a[href="#/help?topic=scam-warning"]').click();
  check('footer scam-warning link opens scam topic', await waitFor(() => text().toLowerCase().includes('scam'), 5000, 'footer scam'));
  doc.querySelector('#site-footer a[href="#/help?topic=how-to-complain"]').click();
  check('footer how-to-complain link opens complaint topic', await waitFor(() => text().toLowerCase().includes('complain'), 5000, 'footer complain'));

  // 5e. Dock tabs (549): each tab navigates to its view.
  const tabs = ['swipe', 'post', 'leaders', 'brands', 'mybills'];
  let tabsOk = true;
  for (const tab of tabs) {
    doc.querySelector(`.dock-tab[data-tab="${tab}"]`).click();
    const ok = await waitFor(() => window.location.hash === '#/' + tab, 3000, 'dock ' + tab);
    if (!ok) tabsOk = false;
  }
  check('all 5 dock tabs navigate to their views', tabsOk);

  // 5f. Help topic links (674): every topic renders, none 404s.
  let topicsOk = true;
  for (const topic of ['helping', 'posting', 'faq', 'verification', 'fees', 'safety', 'complaints', 'privacy', 'terms', 'how-direct-payments-work', 'referrals', 'how-moderation-works', 'install']) {
    window.location.hash = '#/help?topic=' + topic;
    const ok = await waitFor(() => !!doc.querySelector('#view h1') && !text().includes('Page not found'), 3000, 'topic ' + topic);
    if (!ok) topicsOk = false;
  }
  check('all 13 help topics render without a 404 (incl. 4 phase-2 §7 topics)', topicsOk);

  // 5g. Branded 404 (563/572) for unknown routes + unknown bills.
  window.location.hash = '#/does-not-exist';
  check('unknown route shows branded 404 view', await waitFor(() => text().includes('Page not found') && !!doc.querySelector('#view h1'), 3000, '404 view'));
  window.location.hash = '#/bill/no-such-bill';
  check('unknown bill shows not-found state', await waitFor(() => text().includes("isn't available"), 5000, 'bill 404'));

  // 5h. Skeleton loading state (566/572): visible while the bill loads.
  window.location.hash = '#/swipe';
  await waitFor(() => !!$('#deck-wrap'), 5000, 'swipe again 2');
  window.location.hash = '#/bill/another-missing-bill';
  let sawSkeleton = false;
  for (let i = 0; i < 120; i++) {
    if (doc.querySelector('.skel[role="status"]')) { sawSkeleton = true; break; }
    await sleep(5);
  }
  check('skeleton shows a visible loading state (role=status)', sawSkeleton);
  await waitFor(() => text().includes("isn't available"), 5000, 'bill 404 again');

  // 5i. Escape closes sheets, and the sheet has a close button (550).
  window.location.hash = '#/swipe';
  await waitFor(() => !!$('#f-open'), 5000, 'swipe again 3');
  $('#f-open').click();
  check('filters sheet opens with a close button', await waitFor(() => !!doc.querySelector('#sheet-root [role="dialog"]') && !!doc.querySelector('.sheet-close'), 3000, 'sheet open'));
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(100);
  check('Escape closes the sheet', !doc.querySelector('#sheet-root').firstChild);

  // 5j. Offline banner (569): offline event shows it, online hides it.
  window.dispatchEvent(new window.Event('offline'));
  await sleep(100);
  check('offline event shows the offline banner', !$('#offline-banner').hidden && $('#offline-text').textContent.length > 0);
  window.dispatchEvent(new window.Event('online'));
  await sleep(100);
  check('online event hides the offline banner', $('#offline-banner').hidden);

  // 5k. Skip link (547): present, and clicking it focuses main without routing.
  check('skip link present', !!doc.querySelector('.skip-link') && doc.querySelector('.skip-link').getAttribute('href') === '#view');
  const hashBefore = window.location.hash;
  doc.querySelector('.skip-link').click();
  await sleep(100);
  check('skip link focuses main and does not route to 404', window.location.hash === hashBefore && doc.activeElement === doc.getElementById('view'));

  // 5l. Static shell assets (736/502): service worker, logo, manifest all serve.
  const swRes = await jarFetch(BASE + '/sw.js');
  const swText = await swRes.text();
  check('service worker serves and never caches /api/*', swRes.status === 200 && swText.includes('/api/') && swText.includes('never cache API'));
  check('logo + manifest serve', (await jarFetch(BASE + '/logo.svg')).status === 200 && (await jarFetch(BASE + '/manifest.webmanifest')).status === 200);
  check('html lang matches the active locale (en)', doc.documentElement.lang === 'en');
  check('header uses the SVG logo', !!doc.querySelector('.logo-mark img[src="logo.svg"]'));

  // 5m. Phase 2 section 7 user pages: notifications, messages, referrals,
  // summary, updates, and the notification-prefs card in settings.
  window.location.hash = '#/notifications';
  check('notifications page renders with filter tabs', await waitFor(() => !!$('#nt-tabs') && !!$('#nt-readall'), 5000, 'notifications'));
  check('notifications has 4 filter tabs (all/gifts/bills/account)', doc.querySelectorAll('#nt-tabs .tab-btn').length === 4);
  window.location.hash = '#/messages';
  check('messages page renders empty state', await waitFor(() => text().includes('Messages') && (!!doc.querySelector('.empty') || !!doc.querySelector('#msg-body')), 5000, 'messages'));
  window.location.hash = '#/referrals';
  check('referrals page renders with code + copy button', await waitFor(() => !!$('#ref-copy') && !!$('#ref-share'), 5000, 'referrals'));
  window.location.hash = '#/digest';
  check('digest page renders weekly digest', await waitFor(() => !!$('#sum-body') && text().includes('My summary'), 5000, 'digest'));
  window.location.hash = '#/summary';
  check('summary page renders monthly gift summary', await waitFor(() => !!$('#sum-body') && (text().includes('Monthly summary') || text().includes('No confirmed gifts yet')), 5000, 'summary'));
  window.location.hash = '#/updates';
  check('updates page renders empty state', await waitFor(() => text().includes('Updates') && !!$('#up-body'), 5000, 'updates'));
  window.location.hash = '#/settings';
  check('settings has notification-prefs card (pause-all)', await waitFor(() => !!$('#st-pause'), 5000, 'notif prefs'));
  // Item 791: the Help Centre shows the admin-status pill (away by default).
  window.location.hash = '#/help';
  check('help centre shows admin-status pill', await waitFor(() => text().includes('Admin away'), 5000, 'admin pill'));
  // Item 663: a draft saved 24h+ ago shows a reminder card on the feed.
  window.localStorage.setItem('sp_drafts', JSON.stringify([{ id: 'h1', updatedAt: Date.now() - 25 * 3600000, data: { title: 'Old harness draft', category: 'Electricity' } }]));
  window.location.hash = '#/swipe';
  check('draft reminder card shows for a 25h-old draft', await waitFor(() => text().includes('Unfinished draft'), 5000, 'draft reminder'));
  window.localStorage.removeItem('sp_drafts');

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
  check('admin export button present', !!$('#ad-export'));
  check('dashboard shows real metrics (1 user)', await waitFor(() => text().includes('1'), 5000, 'metrics'));

  // 6a. Phase 2 section 8 admin pages render: analytics, complaints (the
  // harness complaint from 5c must be listed), users, security, audit.
  window.location.hash = '#/admin/analytics';
  check('admin analytics renders with export', await waitFor(() => !!$('#an-export') && text().includes('Analytics'), 5000, 'admin analytics'));
  window.location.hash = '#/admin/complaints';
  check('admin complaints inbox lists the harness complaint', await waitFor(() => text().includes('Harness complaint'), 5000, 'admin complaints'));
  window.location.hash = '#/admin/users';
  check('admin users list shows the harness user', await waitFor(() => text().includes('Harness User'), 5000, 'admin users'));
  window.location.hash = '#/admin/security';
  check('admin security page renders', await waitFor(() => text().includes('Security') && !!$('#ad-body'), 5000, 'admin security'));
  window.location.hash = '#/admin/audit';
  check('admin audit log renders with verify + export', await waitFor(() => !!$('#audit-verify') && !!$('#audit-export'), 5000, 'admin audit'));
  $('#audit-verify').click();
  check('audit hash-chain verify reports ok', await waitFor(() => $('#audit-verify-out') && $('#audit-verify-out').textContent.includes('verified'), 5000, 'audit verify'), $('#audit-verify-out') ? $('#audit-verify-out').textContent : 'no output');
  window.location.hash = '#/admin/auctions';
  check('admin auctions page renders with status filter', await waitFor(() => !!$('#au-status') && text().includes('Auctions'), 5000, 'admin auctions'));

  // 6b. Logout resets the header (a): avatar back to '?', badge hidden.
  window.location.hash = '#/settings';
  await waitFor(() => !!$('#st-logout'), 5000, 'settings again');
  $('#st-logout').click();
  check('logout confirm dialog opens', await waitFor(() => !!doc.querySelector('#modal-root [data-act="yes"]'), 3000, 'logout confirm'));
  doc.querySelector('#modal-root [data-act="yes"]').click();
  check('logout lands on welcome', await waitFor(() => window.location.hash === '#/welcome', 5000, 'welcome after logout'));
  await sleep(200);
  check('header avatar resets to ? after logout', $('#avatar-initial').textContent === '?');
  check('bell badge hidden after logout', $('#bell-badge').hidden === true);
  check('country chip hidden after logout', $('#country-chip').hidden === true);

  // 6c. Admin session survives a page reload: boot() restores it from the
  // 24h sp_admin cookie, so a fresh page load must open the dashboard
  // directly instead of showing the PIN gate. (The user session was just
  // logged out, so only the admin cookie is live here.)
  const dom2 = await JSDOM.fromURL(BASE + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window2) {
      window2.fetch = jarFetch;
      window2.HTMLElement.prototype.scrollIntoView = function () {};
      window2.scrollTo = function () {};
    },
  });
  const doc2 = dom2.window.document;
  const text2 = () => (doc2.getElementById('view') ? doc2.getElementById('view').textContent : '');
  check('fresh page load boots', await waitFor(() => text2().includes('Sahay Pay'), 8000, 'reload boot'));
  dom2.window.location.hash = '#/admin/dashboard';
  check('admin dashboard opens after reload without the PIN gate', await waitFor(() => !!doc2.getElementById('ad-body') && !text2().includes('needs the owner PIN') && !text2().includes('Admin login'), 8000, 'reload dashboard'));
  check('reloaded dashboard shows real metrics', await waitFor(() => text2().includes('Total users'), 5000, 'reload metrics'));

  // 7. No uncaught page errors at any point.
  check('no uncaught page errors', errors.length === 0, errors.slice(0, 5).join(' | '));

  console.log(`=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS CRASH:', e); process.exit(2); });
