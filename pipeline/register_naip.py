"""Register one NAIP mosaic per year on Microsoft Planetary Computer and write the tile URLs.

Output goes to <out>/naip_sources.json, which the web app reads at startup. Planetary Computer
search ids now expire after about a day ("pc1.<unix expiry>.<hash>"), so the web app registers the
same query again in the browser (web/src/data.ts) and swaps the fresh id into these tile URLs; the
file mainly records the query, years and URL format.

    python register_naip.py --out ../web/public/data --years 2021 2022 2023
"""
import argparse
import json
import os

import requests

API = "https://planetarycomputer.microsoft.com/api/data/v1"
# NAIP band order is R, G, B, NIR.
COMPOSITES = {
    "true": "image%7C1%2C2%2C3",   # R, G, B
    "false": "image%7C4%2C1%2C2",  # NIR, R, G (color infrared)
}
TILE_QUERY = "collection=naip&assets=image&asset_bidx={bidx}&format=jpeg"


def register(year):
    body = {
        "collections": ["naip"],
        "filter-lang": "cql2-json",
        "filter": {"op": "=", "args": [{"property": "naip:year"}, str(year)]},
        "sortby": [{"field": "datetime", "direction": "desc"}],
    }
    r = requests.post(f"{API}/mosaic/register", json=body, timeout=60)
    r.raise_for_status()
    return r.json()["searchid"]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", required=True)
    ap.add_argument("--years", nargs="+", type=int, default=[2021, 2022, 2023])
    args = ap.parse_args()

    sources = []
    for year in args.years:
        sid = register(year)
        sources.append({
            "year": year,
            "searchid": sid,
            "tiles": {
                name: f"{API}/mosaic/{sid}/tiles/WebMercatorQuad/{{z}}/{{x}}/{{y}}@1x?" + TILE_QUERY.format(bidx=bidx)
                for name, bidx in COMPOSITES.items()
            },
            "minzoom": 11,  # the mosaic endpoint returns empty tiles below z11
        })
        print(year, sid)
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "naip_sources.json"), "w") as f:
        json.dump({"attribution": "NAIP imagery: USDA FPAC-BC, via Microsoft Planetary Computer",
                   "years": sources}, f, indent=2)


if __name__ == "__main__":
    main()
