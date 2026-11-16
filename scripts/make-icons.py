#!/usr/bin/env python3
"""Generate Sahay Pay brand icons + OG image (checklist items 505/506/651/654).

Design: dark navy (#101827) rounded square with a white bold "S" mark,
matching the in-app logo mark (.logo-mark in public/css/app.css).
OG image: 1200x630 navy background, white "S" mark + "Sahay Pay" wordmark
and the tagline "Small acts. Real help."

Outputs (all committed to the repo):
  public/favicon-16x16.png  public/favicon-32x32.png
  public/apple-touch-icon.png (180x180)
  public/icon-192.png       public/icon-512.png
  public/og-image.png       (1200x630)

Requires Pillow. Run: python3 scripts/make-icons.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, "public")

NAVY = (16, 24, 39)          # #101827
NAVY_LIGHT = (31, 41, 55)    # #1F2937 (subtle gradient end)
WHITE = (255, 255, 255)
MUTED = (156, 163, 175)      # #9CA3AF

FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except (OSError, IOError):
        return ImageFont.load_default()


def rounded_square(size, radius_frac=0.22):
    """Navy rounded square with a subtle vertical gradient."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grad = Image.new("RGBA", (size, size))
    gd = ImageDraw.Draw(grad)
    for y in range(size):
        t = y / max(size - 1, 1)
        c = tuple(int(NAVY[i] + (NAVY_LIGHT[i] - NAVY[i]) * t) for i in range(3))
        gd.line([(0, y), (size, y)], fill=c + (255,))
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, size - 1, size - 1],
                         radius=int(size * radius_frac), fill=255)
    img.paste(grad, (0, 0), mask)
    return img


def draw_s(img, scale=0.62):
    """Centred white bold S, sized as a fraction of the image."""
    size = img.size[0]
    d = ImageDraw.Draw(img)
    f = font(FONT_BOLD, int(size * scale))
    text = "S"
    bbox = d.textbbox((0, 0), text, font=f)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((size - w) / 2 - bbox[0], (size - h) / 2 - bbox[1]),
           text, font=f, fill=WHITE + (255,))
    return img


def make_icon(size, name):
    img = draw_s(rounded_square(size))
    # Apple touch icon must be opaque (no transparency).
    if name == "apple-touch-icon.png":
        img = img.convert("RGB")
    img.save(os.path.join(PUBLIC, name), "PNG")
    print(f"wrote {name} ({size}x{size})")


def make_og():
    w, h = 1200, 630
    img = Image.new("RGB", (w, h), NAVY)
    d = ImageDraw.Draw(img)
    # Soft glow circle behind the mark.
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([90, 115, 490, 515], fill=(31, 41, 55, 255))
    img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")
    d = ImageDraw.Draw(img)
    # S mark tile (paste with its alpha mask so the rounded corners stay clean).
    tile = draw_s(rounded_square(280, radius_frac=0.24))
    img.paste(tile, (130, 175), tile)
    d = ImageDraw.Draw(img)
    d.text((470, 215), "Sahay Pay", font=font(FONT_BOLD, 110), fill=WHITE)
    d.text((472, 350), "Small acts. Real help.",
           font=font(FONT_REG, 48), fill=MUTED)
    d.text((472, 445), "sahay-pay.netlify.app",
           font=font(FONT_REG, 36), fill=(107, 114, 128))
    img.save(os.path.join(PUBLIC, "og-image.png"), "PNG")
    print("wrote og-image.png (1200x630)")


def main():
    make_icon(16, "favicon-16x16.png")
    make_icon(32, "favicon-32x32.png")
    make_icon(180, "apple-touch-icon.png")
    make_icon(192, "icon-192.png")
    make_icon(512, "icon-512.png")
    make_og()


if __name__ == "__main__":
    main()
