/* Sahay Pay service worker — caches ONLY the static app shell.
   NEVER caches /api/* responses: bills, gifts, payouts and admin data are
   always live. Bump SHELL_CACHE when a shell asset changes. */
var SHELL_CACHE = "sahay-pay-shell-v1";
var SHELL = [
  "/",
  "/index.html",
  "/css/app.css",
  "/js/app.js",
  "/js/i18n.js",
  "/logo.svg",
  "/manifest.webmanifest"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== SHELL_CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf("/api/") === 0) return; // never cache API
  if (url.pathname.indexOf("/uploads/") === 0) return; // never cache user uploads
  var isShell = SHELL.indexOf(url.pathname) >= 0;
  if (isShell) {
    // Shell assets: cache-first, refresh in the background.
    e.respondWith(
      caches.match(e.request).then(function (hit) {
        var net = fetch(e.request).then(function (res) {
          if (res && res.ok) {
            var copy = res.clone();
            caches.open(SHELL_CACHE).then(function (c) { c.put(e.request, copy); });
          }
          return res;
        }).catch(function () { return hit; });
        return hit || net;
      })
    );
    return;
  }
  // Everything else same-origin: network only; fall back to the cached shell
  // for navigations so an offline visit still opens the app.
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request).catch(function () { return caches.match("/index.html"); })
    );
  }
});
