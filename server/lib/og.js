// Sahay Pay — share pages with server-side Open Graph tags (Phase 2 §5/§6,
// items 438–440, 587–589). Hash routes (#/bill/…) are invisible to
// crawlers, so share links use clean URLs (/share/bill/:id, …) served by
// the Express app: crawlers read the OG meta tags, humans are redirected
// (meta refresh + JS) to the matching hash route. On Netlify, /share/* is
// routed to the API function (netlify.toml).

'use strict';

function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sharePage({ title, description, image, url, redirect, type = 'website' }) {
  const t = escAttr(title || 'Sahay Pay');
  const d = escAttr(description || 'Small acts. Real help.');
  const img = escAttr(image || '/og-image.png');
  const u = escAttr(url || '');
  const r = escAttr(redirect || '/#/swipe');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>${t} — Sahay Pay</title>
<meta name="description" content="${d}">
<meta property="og:type" content="${escAttr(type)}">
<meta property="og:site_name" content="Sahay Pay">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${img}">
<meta property="og:url" content="${u}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${img}">
<meta http-equiv="refresh" content="0; url=${r}">
<link rel="canonical" href="${u}">
</head><body>
<p><a href="${r}">Open in Sahay Pay</a></p>
<script>location.replace(${JSON.stringify(redirect || '/#/swipe')});</script>
</body></html>`;
}

module.exports = { sharePage };
