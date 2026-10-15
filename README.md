# TreeFinder Web

A static web map of the hand-annotated dead-tree segmentation dataset, shown over NAIP 2021–2023.

- **Base map:** NAIP mosaics for each year, served as tiles by Microsoft Planetary Computer, with Esri imagery for context below zoom 11.
- **Per label set:** site extents with a 50 m buffer, vectorized label polygons, the label mask raster, and the site's own true-color and NIR imagery.
- **Tabs:** one per label set listed in `web/public/data/manifest.json`.

No server is needed. Everything is precomputed into static files (GeoJSON and PMTiles), which any static host can serve over HTTP range requests.

```
datasets/                 input GeoTIFFs (R, G, B, N, NDVI, label; float32, NaN = nodata) and summary CSV
pipeline/
  environment.yml         conda env (GDAL, rasterio, geopandas, tippecanoe, rio-pmtiles, Node 20)
  build_labelset.py       folder of TIFFs -> web/public/data/<id>/ + manifest.json entry
  register_naip.py        per-year NAIP mosaic tile URLs -> naip_sources.json
  naip_availability.py    per-site NAIP years and acquisition dates -> naip_availability.json
  work/                   intermediate per-site rasters (safe to delete)
web/                      Vite + TypeScript + MapLibre GL app
  public/data/            generated data served with the app
```

## Environment

```bash
module load python/3.12.9/anaconda
conda activate /gpfs/data1/xiegp/Ruichen/Ruichen/envs/treefinder_web
# recreate elsewhere with:  conda env create -p <path> -f pipeline/environment.yml
```

## Build the data

```bash
cd pipeline
python register_naip.py --out ../web/public/data            # once; the search ids are stable
python build_labelset.py ../datasets/all_data_20261014 \
    --csv ../datasets/datasummary_20261014.csv \
    --id original --name "Original labels" --out ../web/public/data
python naip_availability.py --data ../web/public/data       # after every new label set
```

The label set build takes about 10–15 minutes for 1,001 sites with 8 workers. Use `--limit 10` for a quick test and `--skip-rasters` to build only the outlines and polygons.

## Add a new label set (for example, newly drawn labels)

Put the TIFFs in a folder, using the same 6-band layout as the original data. Then run:

```bash
python build_labelset.py /path/to/new_labels --csv /path/to/summary.csv \
    --id new_2026 --name "New labels" --out ../web/public/data
python naip_availability.py --data ../web/public/data
```

A new tab appears in the web app with no code changes. The CSV is optional; it only adds state, climate and species to the site card. Re-running with the same `--id` replaces that set.

## Run the web app

```bash
cd web
npm install
npm run dev        # http://localhost:5173 (use VS Code port forwarding from the cluster)
npm run build      # static site in web/dist/, including the data/ folder
```

URL hash state: `#map=z/lat/lon&y=<year>&t=<labelset>&s=<site>`. Keys `1` `2` `3` switch the NAIP year.

## Deploy

`web/dist/` is a self-contained static site. The PMTiles files need a host that supports HTTP range requests; GitHub Pages, Cloudflare Pages/R2 and S3 all do. If the data grows beyond what the site host allows (GitHub Pages: 1 GB, 100 MB per file), put `public/data/` on R2 or S3 with CORS enabled.
