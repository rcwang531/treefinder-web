"""Look up which NAIP years cover each site (Planetary Computer STAC) and the acquisition dates.

Reads every <data>/*/sites.geojson and writes <data>/naip_availability.json:
    {"years": [2021, 2022, 2023],
     "sites": {"al4": {"2021": {"date": "2021-10-03", "gsd": 0.6, "id": "..."}, ...}, ...}}
Sites already in the file are skipped unless --refresh is given.

    python naip_availability.py --data ../web/public/data
"""
import argparse
import glob
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor

import requests
from shapely.geometry import shape
from tqdm import tqdm

STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search"


def lookup(site, point, years):
    body = {
        "collections": ["naip"],
        "intersects": {"type": "Point", "coordinates": point},
        "datetime": f"{min(years)}-01-01T00:00:00Z/{max(years)}-12-31T23:59:59Z",
        "limit": 50,
    }
    for attempt in range(6):
        try:
            r = requests.post(STAC, json=body, timeout=60)
            r.raise_for_status()
            break
        except requests.RequestException:
            if attempt == 5:
                return site, None  # left out of the output, so a re-run retries it
            time.sleep(2 ** attempt * 2)  # the API answers 403 when rate limited
    found = {}
    for item in r.json()["features"]:
        p = item["properties"]
        year = str(p.get("naip:year") or p["datetime"][:4])
        if int(year) not in years:
            continue
        entry = {"date": p["datetime"][:10], "gsd": p.get("gsd"), "id": item["id"]}
        # Keep the most recent acquisition when a site sits on several quads/flights.
        if year not in found or entry["date"] > found[year]["date"]:
            found[year] = entry
    return site, found


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", required=True, help="web data root containing <labelset>/sites.geojson")
    ap.add_argument("--years", nargs="+", type=int, default=[2021, 2022, 2023])
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--threads", type=int, default=3)
    args = ap.parse_args()

    out = os.path.join(args.data, "naip_availability.json")
    existing = {}
    if os.path.exists(out) and not args.refresh:
        with open(out) as f:
            existing = json.load(f)["sites"]

    todo = {}
    for path in glob.glob(os.path.join(args.data, "*", "sites.geojson")):
        with open(path) as f:
            for feat in json.load(f)["features"]:
                site = feat["properties"]["site"]
                if site not in existing:
                    c = shape(feat["geometry"]).centroid
                    todo[site] = [c.x, c.y]

    failed = []
    with ThreadPoolExecutor(args.threads) as pool:
        futs = [pool.submit(lookup, s, pt, args.years) for s, pt in todo.items()]
        for fut in tqdm(futs, desc="naip lookup"):
            site, found = fut.result()
            if found is None:
                failed.append(site)
            else:
                existing[site] = found

    with open(out, "w") as f:
        json.dump({"years": args.years, "sites": dict(sorted(existing.items()))}, f, separators=(",", ":"))
    counts = {y: sum(str(y) in v for v in existing.values()) for y in args.years}
    print(f"{len(existing)} sites; coverage per year: {counts}")
    if failed:
        print(f"{len(failed)} lookups failed (re-run to retry): {', '.join(failed[:20])}")


if __name__ == "__main__":
    main()
