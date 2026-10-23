// The square a contributor annotates: either an existing TreeFinder site's extent, or a new
// north-aligned square placed by clicking the map (only when zoomed in far enough to see trees).
import type maplibregl from "maplibre-gl";

const R = 6_371_008.8;
const RAD = Math.PI / 180;
const FILL = "contrib-frame-fill";
const LINE = "contrib-frame-line";
const SRC = "contrib-frame";

/** Placing a square needs at least this zoom (individual crowns are visible from here). */
export const PLACE_MIN_ZOOM = 16;
/** Side lengths offered for placed squares, in meters (300 m ≈ 500 × 500 NAIP pixels). */
export const PLACE_SIZES = [200, 300, 500];
export const PLACE_DEFAULT_SIZE = 300;
/** Where squares may be placed: CONUS (matches the map's panning limit). */
const LIMIT = { w: -125, s: 24.3, e: -66.9, n: 49.5 };

export type FrameState =
  | { kind: "site"; siteId: string }
  | { kind: "placed"; center: [number, number]; size: number };

export class SiteFrame {
  private current: FrameState | null = null;
  private geom: GeoJSON.Polygon | null = null;

  constructor(private map: maplibregl.Map) {}

  /** Use an existing site's extent. */
  useSite(siteId: string, extent: GeoJSON.Polygon) {
    this.current = { kind: "site", siteId };
    this.geom = extent;
    this.draw();
  }

  /** Place a new square of `size` meters centered on `center`; false if outside CONUS. */
  placeAt(center: [number, number], size: number): boolean {
    const [lon, lat] = center;
    if (lon < LIMIT.w || lon > LIMIT.e || lat < LIMIT.s || lat > LIMIT.n) return false;
    const h = size / 2;
    const dLon = h / (R * Math.cos(lat * RAD)) / RAD;
    const dLat = h / R / RAD;
    const r = (v: number) => +v.toFixed(7);
    const ring = [
      [r(lon - dLon), r(lat - dLat)], [r(lon + dLon), r(lat - dLat)],
      [r(lon + dLon), r(lat + dLat)], [r(lon - dLon), r(lat + dLat)],
    ];
    this.current = { kind: "placed", center: [r(lon), r(lat)], size };
    this.geom = { type: "Polygon", coordinates: [[...ring, ring[0]]] };
    this.draw();
    return true;
  }

  /** Restore a saved state; `extentOf` looks up existing sites. */
  restore(s: FrameState, extentOf: (site: string) => GeoJSON.Polygon | null) {
    if (s.kind === "site") {
      const e = extentOf(s.siteId);
      if (e) this.useSite(s.siteId, e);
    } else this.placeAt(s.center, s.size);
  }

  get state() {
    return this.current;
  }
  get placed() {
    return this.current?.kind === "placed";
  }
  /** Existing site ID, or "NEW" for a placed square. */
  get siteId() {
    return this.current?.kind === "site" ? this.current.siteId : "NEW";
  }
  geometry(): GeoJSON.Polygon | null {
    return this.geom;
  }
  center(): [number, number] | null {
    if (!this.geom) return null;
    const ring = this.geom.coordinates[0].slice(0, -1);
    return [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
  }
  /** Width and height in meters of the box around the square. */
  sizeMeters(): [number, number] {
    if (!this.geom) return [0, 0];
    const ring = this.geom.coordinates[0];
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    const lat = (Math.min(...ys) + Math.max(...ys)) / 2;
    return [(Math.max(...xs) - Math.min(...xs)) * RAD * R * Math.cos(lat * RAD), (Math.max(...ys) - Math.min(...ys)) * RAD * R];
  }

  clear() {
    this.current = null;
    this.geom = null;
    this.hide();
  }
  hide() {
    for (const id of [LINE, FILL]) if (this.map.getLayer(id)) this.map.removeLayer(id);
    if (this.map.getSource(SRC)) this.map.removeSource(SRC);
  }
  /** Re-add the layers (e.g. after the tab was hidden). */
  show() {
    if (this.geom) this.draw();
  }

  private draw() {
    const data: GeoJSON.Feature = { type: "Feature", properties: {}, geometry: this.geom! };
    const src = this.map.getSource(SRC) as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData(data);
      return;
    }
    this.map.addSource(SRC, { type: "geojson", data });
    this.map.addLayer({ id: FILL, type: "fill", source: SRC, paint: { "fill-color": "#b388ff", "fill-opacity": 0.05 } });
    this.map.addLayer({
      id: LINE,
      type: "line",
      source: SRC,
      paint: { "line-color": "#b388ff", "line-width": 2.5, "line-dasharray": [2, 1.5] },
    });
  }
}
