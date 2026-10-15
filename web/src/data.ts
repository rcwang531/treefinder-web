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

export async function loadStatic() {
  const [manifest, naip, availability] = await Promise.all([
    getJson<{ labelsets: LabelSet[] }>("manifest.json"),
    getJson<NaipSources>("naip_sources.json"),
    getJson<{ sites: Availability }>("naip_availability.json")
      .then((a) => a.sites)
      .catch(() => ({}) as Availability), // optional: the map works without it
  ]);
  return { labelsets: manifest.labelsets, naip, availability };
}

export const loadSites = (ls: LabelSet) => getJson<SiteCollection>(`${ls.id}/${ls.layers.sites}`);
