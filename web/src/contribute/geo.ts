// Geometry helpers for contributed polygons: containment in a site, area, and the
// GeoJSON format used for downloads and uploads.
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_FEATURES } from "./config";

type Ring = number[][];

/** Ray-casting point-in-ring test (lon/lat). */
export function inRing([x, y]: number[], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True when every vertex of `poly` lies inside the site extent. */
export function polygonInside(poly: GeoJSON.Polygon, extent: GeoJSON.Polygon): boolean {
  return poly.coordinates.every((ring) => ring.every((pt) => inRing(pt, extent.coordinates[0])));
}

/** Approximate area in m² (equirectangular projection; fine at tree scale). */
export function areaM2(poly: GeoJSON.Polygon): number {
  const R = 6_371_008.8;
  const ringArea = (ring: Ring) => {
    const lat0 = (ring.reduce((s, p) => s + p[1], 0) / ring.length) * (Math.PI / 180);
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a / 2) * (Math.PI / 180) ** 2 * R * R * Math.cos(lat0);
  };
  const [outer, ...holes] = poly.coordinates;
  return ringArea(outer) - holes.reduce((s, h) => s + ringArea(h), 0);
}

export interface ExportMeta {
  site: string;
  naip_year: number;
  annotator: string;
}

/** The FeatureCollection a contributor downloads (and later uploads). */
export function buildExport(polys: GeoJSON.Polygon[], meta: ExportMeta): GeoJSON.FeatureCollection & { treefinder: object } {
  const exported_at = new Date().toISOString();
  return {
    type: "FeatureCollection",
    treefinder: { schema: 1, ...meta, exported_at, label: "dead_tree" },
    features: polys.map((geometry, i) => ({
      type: "Feature",
      properties: { id: `${meta.site}-new-${String(i + 1).padStart(3, "0")}`, ...meta, label: "dead_tree", area_m2: +areaM2(geometry).toFixed(2) },
      geometry,
    })),
  };
}

export function exportFileName(site: string, email: string) {
  const who = email.split("@")[0].replace(/[^a-z0-9]+/gi, "_");
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  return `TreeFinder_${site}_${who}_${stamp}.geojson`;
}

export interface CheckedUpload {
  site: string;
  features: number;
  content: string;
}

/** Validate a file the user wants to upload; throws an Error with a readable message. */
export function checkUpload(text: string, extentOf: (site: string) => GeoJSON.Polygon | null): CheckedUpload {
  if (new Blob([text]).size > MAX_UPLOAD_BYTES) throw new Error("The file is larger than 2 MB.");
  let fc: GeoJSON.FeatureCollection & { treefinder?: { site?: string } };
  try {
    fc = JSON.parse(text);
  } catch {
    throw new Error("This is not a valid JSON file.");
  }
  if (fc?.type !== "FeatureCollection" || !Array.isArray(fc.features)) {
    throw new Error("Expected a GeoJSON FeatureCollection, like the files downloaded here.");
  }
  if (!fc.features.length) throw new Error("The file has no polygons.");
  if (fc.features.length > MAX_UPLOAD_FEATURES) throw new Error(`The file has more than ${MAX_UPLOAD_FEATURES} polygons.`);
  const site = fc.treefinder?.site ?? (fc.features[0].properties?.site as string | undefined);
  const extent = site ? extentOf(site) : null;
  if (!site || !extent) throw new Error("The file doesn't say which TreeFinder site it belongs to.");
  fc.features.forEach((f, i) => {
    if (f.geometry?.type !== "Polygon") throw new Error(`Feature ${i + 1} is not a polygon.`);
    if (!polygonInside(f.geometry, extent)) throw new Error(`Polygon ${i + 1} reaches outside site ${site}.`);
  });
  return { site, features: fc.features.length, content: text };
}
