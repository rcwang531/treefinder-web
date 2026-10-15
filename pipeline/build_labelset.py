"""Build one label set for the TreeFinder web viewer.

Input:  a folder of site GeoTIFFs (bands R, G, B, N, NDVI, label; float32, NaN = nodata)
        plus an optional summary CSV keyed by "File Name".
Output (in <out>/<id>/):
    sites.geojson      site extents (EPSG:4326) with site ID, CSV attributes and label stats
    labels.pmtiles     vectorized label polygons (vector tiles, layer "labels")
    mask.pmtiles       label mask raster tiles (PNG, RGBA)
    rgb.pmtiles        site true-color imagery (WEBP, RGBA)
    nir.pmtiles        site false-color imagery, N/R/G (WEBP, RGBA)
and registers the set in <out>/manifest.json.

Each source file gets a permanent site ID (state code + number, e.g. AL_001) and a
"labels last refined" date from site_registry.csv, which this script extends with any new files.

Example:
    python build_labelset.py ../datasets/all_data_20261014 \
        --csv ../datasets/datasummary_20261014.csv \
        --id original --name "Original labels" --out ../web/public/data
"""
import argparse
import csv
import datetime
import re
import glob
import json
import os
import shutil
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd
import rasterio
from rasterio import features
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject, transform_bounds, transform_geom
from shapely.geometry import box, mapping, shape
from tqdm import tqdm

WGS84 = CRS.from_epsg(4326)
WEB = CRS.from_epsg(3857)
# Web Mercator pixel size at zoom 18 (256-px tiles); site rasters are warped onto this grid.
WEB_RES = 156543.03392804097 / 2**18
REGISTRY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "site_registry.csv")
REGISTRY_FIELDS = ["site_id", "file_name", "state", "label_refined"]
STATE_CODES = {
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA",
    "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE", "Florida": "FL", "Georgia": "GA",
    "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA", "Kansas": "KS",
    "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD", "Massachusetts": "MA",
    "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS", "Missouri": "MO", "Montana": "MT",
    "Nebraska": "NE", "Nevada": "NV", "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM",
    "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK",
    "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC",
    "South Dakota": "SD", "Tennessee": "TN", "Texas": "TX", "Utah": "UT", "Vermont": "VT",
    "Virginia": "VA", "Washington": "WA", "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY",
}
MASK_RGB = (255, 0, 200)  # magenta: contrasts with both green canopy and brown dead trees
RASTER_KINDS = {
    # kind: (pmtiles format, resampling for color bands)
    "mask": ("PNG", Resampling.nearest),
    "rgb": ("WEBP", Resampling.bilinear),
    "nir": ("WEBP", Resampling.bilinear),
}


def band(src, name, position):
    """1-based index of a band by description, falling back to its usual position."""
    if name in src.descriptions:
        return src.descriptions.index(name) + 1
    if src.count == 6:
        return position
    return None


def to_web_grid(src_arr, src_transform, src_crs, bounds, resampling, path):
    """Warp a (4, h, w) uint8 RGBA array onto the z18 Web Mercator grid and write it to `path`."""
    left, bottom, right, top = transform_bounds(src_crs, WEB, *bounds)
    left, bottom = np.floor(left / WEB_RES) * WEB_RES, np.floor(bottom / WEB_RES) * WEB_RES
    right, top = np.ceil(right / WEB_RES) * WEB_RES, np.ceil(top / WEB_RES) * WEB_RES
    width, height = int(round((right - left) / WEB_RES)), int(round((top - bottom) / WEB_RES))
    dst_transform = from_origin(left, top, WEB_RES, WEB_RES)
    dst = np.zeros((4, height, width), dtype=np.uint8)
    for i in range(4):
        reproject(
            src_arr[i], dst[i],
            src_transform=src_transform, src_crs=src_crs,
            dst_transform=dst_transform, dst_crs=WEB,
            resampling=Resampling.nearest if i == 3 else resampling,
        )
    profile = dict(
        driver="GTiff", width=width, height=height, count=4, dtype="uint8", crs=WEB,
        transform=dst_transform, tiled=True, blockxsize=256, blockysize=256,
        compress="deflate", photometric="RGB",
    )
    with rasterio.open(path, "w", **profile) as dst_ds:
        dst_ds.write(dst)
        dst_ds.colorinterp = [
            rasterio.enums.ColorInterp.red, rasterio.enums.ColorInterp.green,
            rasterio.enums.ColorInterp.blue, rasterio.enums.ColorInterp.alpha,
        ]
        dst_ds.build_overviews([2, 4, 8, 16, 32], Resampling.average)


def process_site(path, work, buffer_m, imagery=True):
    site = os.path.splitext(os.path.basename(path))[0]
    with rasterio.open(path) as src:
        crs, transform, bounds = src.crs, src.transform, src.bounds
        bands = {k: band(src, k, i) for k, i in [("R", 1), ("G", 2), ("B", 3), ("N", 4), ("label", 6)]}
        if bands["label"] is None and src.count == 1:
            bands["label"] = 1
        data = {k: src.read(i) for k, i in bands.items() if i is not None}

    label = data["label"]
    valid = ~np.isnan(label)
    dead = valid & (label > 0.5)

    extent = box(*bounds)
    buffered = extent.buffer(buffer_m, join_style=2)  # mitred join keeps it a rectangle

    polygons = []
    if dead.any():
        for geom, _ in features.shapes(dead.astype(np.uint8), mask=dead, transform=transform, connectivity=8):
            polygons.append({
                "type": "Feature",
                "properties": {"site": site, "area_m2": round(shape(geom).area, 2)},
                "geometry": transform_geom(crs, WGS84, geom, precision=7),
            })

    rasters = {"mask": np.zeros((4,) + label.shape, dtype=np.uint8)}
    rasters["mask"][:3, dead] = np.array(MASK_RGB, dtype=np.uint8)[:, None]
    rasters["mask"][3] = dead * 255
    if imagery and all(k in data for k in "RGBN"):
        img_valid = valid.copy()
        for k in "RGBN":
            img_valid &= ~np.isnan(data[k])
        to8 = {k: np.clip(np.nan_to_num(data[k]), 0, 255).astype(np.uint8) for k in "RGBN"}
        alpha = (img_valid * 255).astype(np.uint8)
        rasters["rgb"] = np.stack([to8["R"], to8["G"], to8["B"], alpha])
        rasters["nir"] = np.stack([to8["N"], to8["R"], to8["G"], alpha])

    written = {}
    for kind, arr in rasters.items():
        if kind == "mask" and not dead.any():
            continue
        out = os.path.join(work, kind, f"{site}.tif")
        to_web_grid(arr, transform, crs, bounds, RASTER_KINDS[kind][1], out)
        written[kind] = out

    return {
        "site": site,
        "crs": crs.to_string(),
        "extent": transform_geom(crs, WGS84, mapping(extent), precision=7),
        "buffer": transform_geom(crs, WGS84, mapping(buffered), precision=7),
        "label_px": int(dead.sum()),
        "label_area_m2": round(float(dead.sum()) * abs(transform.a * transform.e), 2),
        "n_polygons": len(polygons),
        "has_imagery": all(k in data for k in "RGBN"),
        "polygons": polygons,
        "rasters": written,
    }


def load_csv(path):
    if not path:
        return {}
    df = pd.read_csv(path, dtype=str).fillna("")
    out = {}
    for row in df.to_dict("records"):
        # Species lists are not validated yet, so they are left out of the web data.
        out[row["File Name"]] = {
            "state": row.get("State", ""),
            "climate": row.get("Koppen Geiger Climate", ""),
            "hardiness_zone": row.get("USDA Plant Hardness Zone", ""),
        }
    return out


def natural_key(name):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


def update_registry(files, attrs, refined_date):
    """Return {file_name: registry row}, assigning IDs to files not yet in site_registry.csv.

    IDs are permanent: a file keeps its ID across rebuilds and label sets. New files are numbered
    after the highest existing number for their state, in natural file-name order. With
    refined_date set, the processed files' "label_refined" date is updated too.
    """
    rows = {}
    if os.path.exists(REGISTRY):
        with open(REGISTRY, newline="") as f:
            rows = {r["file_name"]: r for r in csv.DictReader(f)}
    next_num = {}
    for r in rows.values():
        code, num = r["site_id"].rsplit("_", 1)
        next_num[code] = max(next_num.get(code, 0), int(num))
    today = datetime.date.today().isoformat()
    for name in sorted(files, key=natural_key):
        if name in rows:
            if refined_date:
                rows[name]["label_refined"] = refined_date
            continue
        state = attrs.get(name, {}).get("state", "")
        code = STATE_CODES.get(state, "US")
        next_num[code] = next_num.get(code, 0) + 1
        rows[name] = {"site_id": f"{code}_{next_num[code]:03d}", "file_name": name, "state": state,
                      "label_refined": refined_date or today}
    with open(REGISTRY, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=REGISTRY_FIELDS)
        w.writeheader()
        w.writerows(sorted(rows.values(), key=lambda r: natural_key(r["site_id"])))
    return rows


def write_geojson(path, feats):
    with open(path, "w") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f, separators=(",", ":"))


def run(cmd):
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", help="folder of site GeoTIFFs")
    ap.add_argument("--csv", help="summary CSV with a 'File Name' column")
    ap.add_argument("--id", required=True, help="label set id (folder name, URL-safe)")
    ap.add_argument("--name", required=True, help="label set display name (tab title)")
    ap.add_argument("--description", default="")
    ap.add_argument("--out", required=True, help="web data root, e.g. ../web/public/data")
    ap.add_argument("--work", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "work"))
    ap.add_argument("--buffer-m", type=float, default=50.0, help="margin around each site for zoom-to framing")
    ap.add_argument("--refined-date", help="set 'labels last refined' (YYYY-MM-DD) for these files; "
                    "new files default to today")
    ap.add_argument("--minzoom", type=int, default=12)
    ap.add_argument("--maxzoom", type=int, default=18)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--limit", type=int, help="only process the first N files (for testing)")
    ap.add_argument("--skip-rasters", action="store_true", help="skip mask/rgb/nir PMTiles")
    ap.add_argument("--no-imagery", action="store_true",
                    help="skip the rgb/nir site imagery PMTiles (each is ~250 MB, over GitHub's 100 MB file limit)")
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.src, "*.tif")))[: args.limit]
    if not files:
        sys.exit(f"no .tif files in {args.src}")
    attrs = load_csv(args.csv)
    registry = update_registry([os.path.splitext(os.path.basename(f))[0] for f in files], attrs, args.refined_date)
    out_dir = os.path.join(args.out, args.id)
    work = os.path.join(args.work, args.id)
    shutil.rmtree(work, ignore_errors=True)
    for kind in RASTER_KINDS:
        os.makedirs(os.path.join(work, kind), exist_ok=True)
    os.makedirs(out_dir, exist_ok=True)

    results = []
    with ProcessPoolExecutor(args.workers) as pool:
        futs = [pool.submit(process_site, f, work, args.buffer_m, not args.no_imagery) for f in files]
        for fut in tqdm(futs, desc="sites"):
            results.append(fut.result())

    sites, buffers = [], []
    with open(os.path.join(work, "labels.geojsonseq"), "w") as f:
        for r in sorted(results, key=lambda r: natural_key(registry[r["site"]]["site_id"])):
            reg = registry[r["site"]]
            props = {
                "site": reg["site_id"], "file": r["site"], **attrs.get(r["site"], {}),
                "label_refined": reg["label_refined"],
                "crs": r["crs"], "label_px": r["label_px"], "label_area_m2": r["label_area_m2"],
                "n_polygons": r["n_polygons"], "has_imagery": r["has_imagery"],
            }
            props["bbox"] = [round(v, 7) for v in shape(r["buffer"]).bounds]
            sites.append({"type": "Feature", "properties": props, "geometry": r["extent"]})
            buffers.append({"type": "Feature", "properties": {"site": reg["site_id"]}, "geometry": r["buffer"]})
            for p in r["polygons"]:
                p["properties"]["site"] = reg["site_id"]
                f.write(json.dumps(p, separators=(",", ":")) + "\n")
    write_geojson(os.path.join(out_dir, "sites.geojson"), sites)
    write_geojson(os.path.join(work, "cutline.geojson"), buffers)  # limits which raster tiles get built

    run([
        "tippecanoe", "-o", os.path.join(out_dir, "labels.pmtiles"), "--force", "-l", "labels",
        "-Z", "10", "-z", str(args.maxzoom), "--no-feature-limit", "--no-tile-size-limit",
        "--no-tiny-polygon-reduction", "--quiet", os.path.join(work, "labels.geojsonseq"),
    ])

    layers = {"sites": "sites.geojson", "labels": "labels.pmtiles"}
    if not args.skip_rasters:
        for kind, (fmt, _) in RASTER_KINDS.items():
            tifs = [r["rasters"][kind] for r in results if kind in r["rasters"]]
            if not tifs:
                continue
            vrt = os.path.join(work, f"{kind}.vrt")
            run(["gdalbuildvrt", "-q", "-resolution", "highest", "-input_file_list",
                 _write_list(os.path.join(work, f"{kind}.txt"), tifs), vrt])
            out = os.path.join(out_dir, f"{kind}.pmtiles")
            if os.path.exists(out):
                os.remove(out)
            cmd = ["rio", "pmtiles", vrt, out, "-f", fmt, "--rgba", "--tile-size", "512",
                   "--zoom-levels", f"{args.minzoom}..{args.maxzoom - 1}",
                   "--cutline", os.path.join(work, "cutline.geojson"),
                   "--exclude-empty-tiles", "-j", str(args.workers), "--silent",
                   "--resampling", "nearest" if kind == "mask" else "bilinear"]
            if fmt == "WEBP":
                cmd += ["--co", "QUALITY=85"]
            run(cmd)
            layers[kind] = f"{kind}.pmtiles"

    _update_manifest(args, layers, results)
    print(f"done: {len(results)} sites, {sum(r['n_polygons'] for r in results)} polygons -> {out_dir}")


def _write_list(path, items):
    with open(path, "w") as f:
        f.write("\n".join(items) + "\n")
    return path


def _update_manifest(args, layers, results):
    path = os.path.join(args.out, "manifest.json")
    manifest = {"labelsets": []}
    if os.path.exists(path):
        with open(path) as f:
            manifest = json.load(f)
    entry = {
        "id": args.id,
        "name": args.name,
        "description": args.description,
        "source": os.path.abspath(args.src),
        "created": datetime.date.today().isoformat(),
        "n_sites": len(results),
        "n_polygons": sum(r["n_polygons"] for r in results),
        "buffer_m": args.buffer_m,
        "raster_maxzoom": args.maxzoom - 1,  # 512-px tiles: z17 at 512 px == z18 at 256 px
        "layers": layers,
    }
    sets = [s for s in manifest["labelsets"] if s["id"] != args.id]
    manifest["labelsets"] = sets + [entry] if args.id != "original" else [entry] + sets
    with open(path, "w") as f:
        json.dump(manifest, f, indent=2)


if __name__ == "__main__":
    main()
