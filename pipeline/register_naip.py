"""Register one NAIP mosaic per year on Microsoft Planetary Computer and write the tile URLs.

The search id is a hash of the query, so re-running returns the same ids. Output goes to
<out>/naip_sources.json, which the web app reads at startup.

    python register_naip.py --out ../web/public/data --years 2021 2022 2023
"""
import argparse
import json
import os

import requests

API = "https://planetarycomputer.microsoft.com/api/data/v1"
TILE_QUERY = "collection=naip&assets=image&asset_bidx=image%7C1%2C2%2C3&format=jpeg"


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
            "tiles": f"{API}/mosaic/{sid}/tiles/WebMercatorQuad/{{z}}/{{x}}/{{y}}@1x?{TILE_QUERY}",
            "minzoom": 11,  # the mosaic endpoint returns empty tiles below z11
        })
        print(year, sid)
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "naip_sources.json"), "w") as f:
        json.dump({"attribution": "NAIP imagery: USDA FPAC-BC, via Microsoft Planetary Computer",
                   "years": sources}, f, indent=2)


if __name__ == "__main__":
    main()
