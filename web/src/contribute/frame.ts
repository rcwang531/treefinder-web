// A site frame contributors can drag to a new location. Only its position changes: corners keep
// their ground offsets (in meters) from the center, so size and orientation are preserved even
// when it moves north or south.
import type maplibregl from "maplibre-gl";

const R = 6_371_008.8;
const RAD = Math.PI / 180;
const FILL = "contrib-frame-fill";
const LINE = "contrib-frame-line";
const SRC = "contrib-frame";

/** Where the frame may be placed: CONUS (matches the map's panning limit). */
const LIMIT = { w: -125, s: 24.3, e: -66.9, n: 49.5 };

export interface FrameState {
  siteId: string;
  /** Current center (lon, lat). */
  center: [number, number];
}

export class SiteFrame {
  private siteId = "";
  private original: GeoJSON.Polygon | null = null;
  private origin: [number, number] = [0, 0];
  private offsets: [number, number][] = []; // corner offsets in meters from the original center
  private center: [number, number] = [0, 0];
  private movable = false;
  private drag: { from: maplibregl.LngLat; center: [number, number] } | null = null;

  constructor(private map: maplibregl.Map, private onChange: () => void) {
    map.on("mousedown", FILL, (e) => this.startDrag(e));
    map.on("touchstart", FILL, (e) => this.startDrag(e as unknown as maplibregl.MapMouseEvent));
    map.on("mousemove", (e) => this.moveDrag(e));
    map.on("touchmove", (e) => this.moveDrag(e as unknown as maplibregl.MapMouseEvent));
    map.on("mouseup", () => this.endDrag());
    map.on("touchend", () => this.endDrag());
    map.on("mouseenter", FILL, () => this.movable && (map.getCanvas().style.cursor = "move"));
    map.on("mouseleave", FILL, () => this.movable && (map.getCanvas().style.cursor = ""));
  }

  /** Show the frame for `siteId`, optionally restored to a saved center. */
  set(siteId: string, extent: GeoJSON.Polygon, center?: [number, number]) {
    this.siteId = siteId;
    this.original = extent;
    const ring = extent.coordinates[0].slice(0, -1);
    this.origin = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
    const cos = Math.cos(this.origin[1] * RAD);
    this.offsets = ring.map(([x, y]) => [(x - this.origin[0]) * RAD * R * cos, (y - this.origin[1]) * RAD * R]);
    this.center = center ?? this.origin;
    this.draw();
  }

  get id() {
    return this.siteId;
  }
  get moved() {
    return Math.hypot(...this.offsetMeters()) > 0.5;
  }
  /** Shift from the original position, in meters east and north. */
  offsetMeters(): [number, number] {
    const lat = (this.center[1] + this.origin[1]) / 2;
    return [
      (this.center[0] - this.origin[0]) * RAD * R * Math.cos(lat * RAD),
      (this.center[1] - this.origin[1]) * RAD * R,
    ];
  }
  state(): FrameState {
    return { siteId: this.siteId, center: this.center };
  }
  /** Width and height in meters (of the axis-aligned box around the corners). */
  sizeMeters(): [number, number] {
    const xs = this.offsets.map((o) => o[0]);
    const ys = this.offsets.map((o) => o[1]);
    return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  }

  geometry(): GeoJSON.Polygon {
    if (!this.moved && this.original) return this.original;
    const cos = Math.cos(this.center[1] * RAD);
    const ring = this.offsets.map(([dx, dy]) => [
      +(this.center[0] + dx / (R * cos) / RAD).toFixed(7),
      +(this.center[1] + dy / R / RAD).toFixed(7),
    ]);
    return { type: "Polygon", coordinates: [[...ring, ring[0]]] };
  }

  reset() {
    this.center = this.origin;
    this.draw();
    this.onChange();
  }
  setMovable(on: boolean) {
    this.movable = on;
    if (this.map.getLayer(LINE)) this.map.setPaintProperty(LINE, "line-width", on ? 3 : 2);
    if (this.map.getLayer(FILL)) this.map.setPaintProperty(FILL, "fill-opacity", on ? 0.12 : 0.04);
  }

  hide() {
    this.endDrag();
    for (const id of [LINE, FILL]) if (this.map.getLayer(id)) this.map.removeLayer(id);
    if (this.map.getSource(SRC)) this.map.removeSource(SRC);
  }

  private draw() {
    const data: GeoJSON.Feature = { type: "Feature", properties: {}, geometry: this.geometry() };
    const src = this.map.getSource(SRC) as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData(data);
      return;
    }
    this.map.addSource(SRC, { type: "geojson", data });
    this.map.addLayer({ id: FILL, type: "fill", source: SRC, paint: { "fill-color": "#b388ff", "fill-opacity": 0.04 } });
    this.map.addLayer({
      id: LINE,
      type: "line",
      source: SRC,
      paint: { "line-color": "#b388ff", "line-width": 2, "line-dasharray": [2, 1.5] },
    });
  }

  private startDrag(e: maplibregl.MapMouseEvent) {
    if (!this.movable) return;
    e.preventDefault(); // stop the map from panning while the frame moves
    this.drag = { from: e.lngLat, center: this.center };
  }
  private moveDrag(e: maplibregl.MapMouseEvent) {
    if (!this.drag) return;
    const lon = this.drag.center[0] + (e.lngLat.lng - this.drag.from.lng);
    const lat = this.drag.center[1] + (e.lngLat.lat - this.drag.from.lat);
    this.center = [Math.min(LIMIT.e, Math.max(LIMIT.w, lon)), Math.min(LIMIT.n, Math.max(LIMIT.s, lat))];
    this.draw();
  }
  private endDrag() {
    if (!this.drag) return;
    this.drag = null;
    this.onChange();
  }
}
