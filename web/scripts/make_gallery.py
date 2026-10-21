"""Rebuild the front-page gallery from the images in web/public/assets/gallery/.

To change the gallery: copy the screenshots you want (e.g. from assets/gallery_candidates/)
into web/public/assets/gallery/, named <SITE>_<YEAR>[_tag].jpg such as CO_001_2023.jpg or CO_001_2023_close.jpg, delete the
ones you don't want, then run from the repo root:

    python3 web/scripts/make_gallery.py

Images are resized in place to 960 px wide, and gallery.json gets each site's state, polygon
count and dead-tree area from the published site data. Gallery order follows the optional
`order.txt` (one file name per line); files not listed there come after, alphabetically.
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
        items.append({
            "file": f, "site": site, "year": year, "state": p.get("state", ""),
            "polygons": p["n_polygons"], "area_m2": round(p["label_area_m2"]),
            "width": im.width, "height": im.height,
        })
    with open(os.path.join(GALLERY, "gallery.json"), "w") as out:
        json.dump(items, out, indent=1)
    print(f"gallery.json: {len(items)} images" + (f"; skipped: {', '.join(skipped)}" if skipped else ""))
    if not items:
        sys.exit("no gallery images found")


if __name__ == "__main__":
    main()
