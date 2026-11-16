# Sahay Pay — Brand

## Brand sheet (one page)

| Element | Value |
|---|---|
| Name | Sahay Pay ("Sahay" = help, in Nepali and Hindi) |
| Tagline | "Small acts. Real help." |
| Logo | White bold "S" on a dark navy rounded square (see `public/icon-512.png`; regenerate with `scripts/make-icons.py`) |
| Primary colour | Navy `#101827` (backgrounds, theme colour, logo tile) |
| Secondary | Slate `#1F2937` (gradient end, glow) |
| Text on dark | White `#FFFFFF`; muted `#9CA3AF` |
| Fonts | System stack only — no webfonts (keeps the app fast and fully self-hosted) |
| UI style | iOS Liquid Glass: translucent glass cards, soft shadows, living gradient background, floating glass tab dock, light + dark mode |
| Voice | Warm, plain, honest (see below) |

## Voice guide

**Tone:** warm and direct, like a helpful neighbour — never corporate,
never hypey, never pleading. Short sentences. Plain words.

**Words to use:** help, supporter, gift, bill, directly, voluntary,
reviewed by a person.

**Words to avoid:** donate/donation (gifts are person-to-person, not
charity fundraising), invest/earn/returns (this is not finance),
guaranteed/safe/secure promise (never promise what the service cannot
control), "free money", "instant cash".

**Honesty rules (non-negotiable):**

- Always say Demo Mode where money is discussed. Never claim a real
  payment moved through Sahay Pay.
- Always say Sahay Pay never holds gift money.
- Never promise a user will receive help, or that a post is genuine —
  badges mean a reviewer checked what was shown, nothing more.
- Never ask for MPINs, OTPs, passwords, or card details — and say so
  where relevant.
- Legal text is general information only, not legal advice.

**Languages:** the app ships in English, Nepali, and Hindi. Legal
documents are English-only (the English version is the binding one);
Help topics give a short translated summary plus the English full text.

**Numbers:** money always with its currency (रू / ₹). Fees always shown
in full before the user confirms anything.

## Logo use

- The "S" tile is the logo. Do not stretch it, recolour it, or put
  text over it.
- On light backgrounds, use the navy tile as-is (it carries its own
  background).
- The OG image (`public/og-image.png`, 1200×630) is for link previews.
- Favicon / app icons are generated from `scripts/make-icons.py` —
  re-run the script rather than hand-editing the PNGs.
