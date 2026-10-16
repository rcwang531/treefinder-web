# TreeFinder Web

A static web map of the hand-annotated dead-tree segmentation dataset, shown over NAIP 2021–2023.

- **Base map:** NAIP mosaics for each year, in true color (R,G,B) or false color (NIR,R,G), served as tiles by Microsoft Planetary Computer, with Esri imagery for context below zoom 11.
- **Per label set:** site extents, vectorized label polygons, the label mask raster, and (locally only) the site's own true-color and NIR imagery.
- **Tabs:** one per label set listed in `web/public/data/manifest.json`.

No server is needed. Everything is precomputed into static files (GeoJSON and PMTiles), which any static host can serve over HTTP range requests.

```
datasets/                 input GeoTIFFs (R, G, B, N, NDVI, label; float32, NaN = nodata) and summary CSV
pipeline/
  environment.yml         conda env (GDAL, rasterio, geopandas, tippecanoe, rio-pmtiles, Node 20)
  build_labelset.py       folder of TIFFs -> web/public/data/<id>/ + manifest.json entry
  site_registry.csv       permanent site IDs (e.g. AL_001) and "labels last refined" dates
  register_naip.py        per-year NAIP mosaic tile URLs -> naip_sources.json
  naip_availability.py    per-site NAIP years and acquisition dates -> naip_availability.json
  work/                   intermediate per-site rasters (safe to delete)
web/                      Vite + TypeScript + MapLibre GL app
  index.html, src/front.* front page (impact, dataset, team, links to the map)
  map.html, src/main.ts   map dashboard
  public/assets/front/    front-page images (NAIP site captures, paper figures)
  public/data/            generated data served with the app
assets/slides/            text and the authors' own figures extracted from the slide decks (reference only)
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
    --id original --name "Original labels" --out ../web/public/data --no-imagery
python naip_availability.py --data ../web/public/data       # after every new label set
```

A build with `--no-imagery` takes about 10 minutes for 1,001 sites with 8 workers, and about 35 minutes with imagery. Use `--limit 10` for a quick test and `--skip-rasters` to build only the outlines and polygons.

### Site IDs and refine dates

`pipeline/site_registry.csv` gives every source file a permanent ID, made of the state code and a number (`AL_001`, `CO_014`, …), plus a "labels last refined" date. The website shows the ID; you can still find a site by its file name using the search box.

- A file keeps its ID across rebuilds and label sets.
- New files get the next free number for their state, taken from the CSV's `State` column.
- To record a refinement, pass `--refined-date YYYY-MM-DD` to `build_labelset.py`. It sets the date for every file in that run. New files get today's date by default.
- You can also edit the dates directly in the CSV and rebuild.

## Add a new label set (for example, newly drawn labels)

Put the TIFFs in a folder, using the same 6-band layout as the original data. Then run:

```bash
python build_labelset.py /path/to/new_labels --csv /path/to/summary.csv \
    --id new_2026 --name "New labels" --out ../web/public/data --no-imagery --refined-date 2026-11-01
python naip_availability.py --data ../web/public/data
```

A new tab appears in the web app with no code changes. The CSV is optional; it adds state and climate to the site card and decides the state code of new site IDs. Re-running with the same `--id` replaces that set. Keep `--no-imagery` for anything that goes on GitHub: the imagery files are larger than GitHub's 100 MB limit.

## Run the web app

```bash
cd web
npm install
npm run dev        # http://localhost:5173 (use VS Code port forwarding from the cluster)
npm run build      # static site in web/dist/, including the data/ folder
```

URL hash state: `#map=z/lat/lon&y=<year>&t=<labelset>&s=<site ID>&about=1`. Keys `1` `2` `3` switch the NAIP year. The home button, or clicking the title, returns to the default view.

## Deploy

`web/dist/` is a self-contained static site. The PMTiles files need a host that supports HTTP range requests; GitHub Pages, Cloudflare Pages/R2 and S3 all do. If the data grows beyond what the site host allows (GitHub Pages: 1 GB, 100 MB per file), put `public/data/` on R2 or S3 with CORS enabled.
