"""Rebuild the front-page gallery from the images in web/public/assets/gallery/.

To change the gallery: copy the screenshots you want (e.g. from assets/gallery_candidates/)
into web/public/assets/gallery/, named <SITE>_<YEAR>[_tag].jpg such as CO_001_2023.jpg or CO_001_2023_close.jpg, delete the
ones you don't want, then run from the repo root:

    python3 web/scripts/make_gallery.py

Images are resized in place to 960 px wide, and gallery.json gets each site's state, polygon
count and dead-tree area from the published site data. Gallery order follows the optional
`order.txt` (one file name per line); files not listed there come after, alphabetically.

The same images are the front-page hero slideshow. Because the gallery copies are only 960 px wide,
each hero background (gallery/hero/<file>, 1920x1080) is cut from the full-size screenshot of the same
name in assets/gallery_candidates/. Images without one stay out of the slideshow.
"""
import json
import os
import re
import sys

from PIL import Image

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
GALLERY = os.path.join(WEB, "public", "assets", "gallery")
SITES = os.path.join(WEB, "public", "data", "original", "sites.geojson")
NAME = re.compile(r"^([A-Z]{2}_\d{3})_(\d{4})(_[a-z0-9]+)?\.(jpe?g|png|webp)$", re.I)  # CO_001_2023.jpg, CO_001_2023_close.jpg
WIDTH = 960
CANDIDATES = os.path.join(WEB, "..", "assets", "gallery_candidates")
HERO = os.path.join(GALLERY, "hero")
HERO_SIZE = (1920, 1080)


def make_hero(f):
    """Crop the full-size candidate to 16:9 and save it as the hero background; returns its path or None."""
    out = os.path.join(HERO, f)
    src = os.path.join(CANDIDATES, f)
    if os.path.exists(src):
        im = Image.open(src).convert("RGB")
        ch = round(im.width * HERO_SIZE[1] / HERO_SIZE[0])
        if ch <= im.height:
            top = (im.height - ch) // 2
            im = im.crop((0, top, im.width, top + ch))
        else:
            cw = round(im.height * HERO_SIZE[0] / HERO_SIZE[1])
            left = (im.width - cw) // 2
            im = im.crop((left, 0, left + cw, im.height))
        os.makedirs(HERO, exist_ok=True)
        im.resize(HERO_SIZE, Image.LANCZOS).save(out, quality=80, optimize=True, progressive=True)
    return f"hero/{f}" if os.path.exists(out) else None


def main():
    sites = {f["properties"]["site"]: f["properties"] for f in json.load(open(SITES))["features"]}
    files = sorted(f for f in os.listdir(GALLERY) if NAME.match(f))
    order_file = os.path.join(GALLERY, "order.txt")
    if os.path.exists(order_file):
        wanted = [l.strip() for l in open(order_file) if l.strip() and not l.startswith("#")]
        files = [f for f in wanted if f in files] + [f for f in files if f not in wanted]
    items, skipped = [], []
    for f in files:
        site, year = NAME.match(f).group(1).upper(), int(NAME.match(f).group(2))
        p = sites.get(site)
        if not p:
            skipped.append(f"{f} (unknown site {site})")
            continue
        path = os.path.join(GALLERY, f)
        im = Image.open(path)
        if im.width > WIDTH:
            im = im.convert("RGB").resize((WIDTH, round(im.height * WIDTH / im.width)), Image.LANCZOS)
            im.save(path, quality=82, optimize=True, progressive=True)
        item = {
            "file": f, "site": site, "year": year, "state": p.get("state", ""),
            "polygons": p["n_polygons"], "area_m2": round(p["label_area_m2"]),
            "width": im.width, "height": im.height,
        }
        hero = make_hero(f)
        if hero:
            item["hero"] = hero
        items.append(item)
    # drop hero backgrounds of images that left the gallery
    if os.path.isdir(HERO):
        keep = {i["file"] for i in items}
        for h in os.listdir(HERO):
            if h not in keep:
                os.remove(os.path.join(HERO, h))
    with open(os.path.join(GALLERY, "gallery.json"), "w") as out:
        json.dump(items, out, indent=1)
    print(f"gallery.json: {len(items)} images, {sum('hero' in i for i in items)} with a hero background" + (f"; skipped: {', '.join(skipped)}" if skipped else ""))
    if not items:
        sys.exit("no gallery images found")


if __name__ == "__main__":
    main()
