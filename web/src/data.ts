// Types and loaders for the static files written by the pipeline (web/public/data).

export interface LabelSet {
  id: string;
  name: string;
  description: string;
  n_sites: number;
  n_polygons: number;
  buffer_m: number;
  raster_maxzoom: number;
  layers: {
    sites: string;
    labels: string;
    mask?: string;
    rgb?: string;
    nir?: string;
  };
}

/** NAIP band composite: true color (R,G,B) or false color (NIR,R,G). */
export type Composite = "true" | "false";

export interface NaipYear {
  year: number;
  /** Planetary Computer mosaic search id; the tile URLs contain it. */
  searchid: string;
  tiles: Record<Composite, string>;
  minzoom: number;
}

export interface NaipSources {
  attribution: string;
  years: NaipYear[];
}

export interface NaipAcquisition {
  date: string;
  gsd: number | null;
  id: string;
}

/** site -> year (as string) -> acquisition */
export type Availability = Record<string, Record<string, NaipAcquisition>>;

export interface SiteProps {
  /** Permanent site ID, e.g. "AL_001" (see pipeline/site_registry.csv). */
  site: string;
  /** Source GeoTIFF name; searchable but not displayed. */
  file: string;
  state?: string;
  climate?: string;
  hardiness_zone?: string;
  /** "Labels last refined" date, YYYY-MM-DD. */
  label_refined?: string;
  crs: string;
  label_px: number;
  label_area_m2: number;
  n_polygons: number;
  has_imagery: boolean;
  bbox: [number, number, number, number];
}

export type SiteCollection = GeoJSON.FeatureCollection<GeoJSON.Polygon, SiteProps>;

export const dataUrl = (path: string) => new URL(`data/${path}`, document.baseURI).href;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(dataUrl(path));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// Planetary Computer mosaic search ids now expire (they look like "pc1.<unix expiry>.<hash>"), so the
// ids saved in naip_sources.json go stale. Register the same per-year search again from the browser
// and swap the fresh id into the tile URLs. Ids are cached until shortly before they expire.
const PC_REGISTER = "https://planetarycomputer.microsoft.com/api/data/v1/mosaic/register";
const searchBody = (year: number) => ({
  // same query as pipeline/register_naip.py
  collections: ["naip"],
  "filter-lang": "cql2-json",
  filter: { op: "=", args: [{ property: "naip:year" }, String(year)] },
  sortby: [{ field: "datetime", direction: "desc" }],
});
const expiry = (id: string) => Number(/^pc1\.(\d+)\./.exec(id)?.[1] ?? 0) * 1000;

async function freshSearchId(year: number): Promise<string> {
  const key = `naip-search-${year}`;
  try {
    const cached = localStorage.getItem(key);
    if (cached && expiry(cached) - Date.now() > 3600e3) return cached;
  } catch { /* storage blocked */ }
  const res = await fetch(PC_REGISTER, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(searchBody(year)),
  });
  if (!res.ok) throw new Error(`NAIP ${year} register: HTTP ${res.status}`);
  // the response field was "searchid" and is now "id"; accept either
  const body = (await res.json()) as { id?: string; searchid?: string; links?: { href: string }[] };
  const searchid = body.id ?? body.searchid ?? /\/mosaic\/([^/]+)\//.exec(body.links?.[0]?.href ?? "")?.[1];
  if (!searchid) throw new Error(`NAIP ${year} register: no search id in the response`);
  try { localStorage.setItem(key, searchid); } catch { /* storage blocked */ }
  return searchid;
}

async function refreshNaip(naip: NaipSources): Promise<NaipSources> {
  const years = await Promise.all(
    naip.years.map(async (y) => {
      try {
        const id = await freshSearchId(y.year);
        const tiles = Object.fromEntries(
          Object.entries(y.tiles).map(([k, url]) => [k, url.replace(`/mosaic/${y.searchid}/`, `/mosaic/${id}/`)]),
        ) as Record<Composite, string>;
        return { ...y, searchid: id, tiles };
      } catch (e) {
        console.warn(e); // keep the saved id; tiles may still load
        return y;
      }
    }),
  );
  return { ...naip, years };
}

export async function loadStatic() {
  const [manifest, naip, availability] = await Promise.all([
    getJson<{ labelsets: LabelSet[] }>("manifest.json"),
    getJson<NaipSources>("naip_sources.json").then(refreshNaip),
    getJson<{ sites: Availability }>("naip_availability.json")
      .then((a) => a.sites)
      .catch(() => ({}) as Availability), // optional: the map works without it
  ]);
  return { labelsets: manifest.labelsets, naip, availability };
}

export const loadSites = (ls: LabelSet) => getJson<SiteCollection>(`${ls.id}/${ls.layers.sites}`);
