#!/usr/bin/env python3
# Generate the studio derivatives for one photo:
#   thumb (600px), thumb-wm, preview (1600px), preview-wm, mls (2048px)
# Watermark = the business mark (public/brand/watermark.png, white AC/RE on
# transparent), centered, 70% transparent (30% opacity), scaled to WM_WIDTH
# (default 30%) of the image width. Usage:
#   make-derivatives.py <src.jpg> <outdir> <watermark.png>
# Writes <outdir>/{thumb,thumb-wm,preview,preview-wm}/<basename>.jpg
import sys, os
from PIL import Image

src, outdir, logo_path = sys.argv[1], sys.argv[2], sys.argv[3]
base = os.path.splitext(os.path.basename(src))[0] + ".jpg"

im = Image.open(src).convert("RGB")
logo = Image.open(logo_path).convert("RGBA")

def resized(img, long_edge):
    w, h = img.size
    s = long_edge / max(w, h)
    if s >= 1:
        return img.copy()
    return img.resize((round(w * s), round(h * s)), Image.LANCZOS)

def watermark(img):
    out = img.convert("RGBA")
    lw = round(img.width * float(os.environ.get("WM_WIDTH", "0.30")))
    ls = lw / logo.width
    l = logo.resize((lw, round(logo.height * ls)), Image.LANCZOS)
    # 70% transparency = keep 30% of the logo's own alpha
    alpha = l.getchannel("A").point(lambda a: int(a * 0.30))
    l.putalpha(alpha)
    out.alpha_composite(l, ((out.width - l.width) // 2, (out.height - l.height) // 2))
    return out.convert("RGB")

for name, img, q in [
    ("preview", resized(im, 1600), 78),
    ("thumb", resized(im, 600), 70),
]:
    os.makedirs(os.path.join(outdir, name), exist_ok=True)
    img.save(os.path.join(outdir, name, base), "JPEG", quality=q, optimize=True)
    wm_dir = os.path.join(outdir, name + "-wm")
    os.makedirs(wm_dir, exist_ok=True)
    watermark(img).save(os.path.join(wm_dir, base), "JPEG", quality=q, optimize=True)

# MLS delivery size — 2048px long edge, clean (downloads are already payment-gated)
os.makedirs(os.path.join(outdir, "mls"), exist_ok=True)
resized(im, 2048).save(os.path.join(outdir, "mls", base), "JPEG", quality=85, optimize=True)

print(base)
