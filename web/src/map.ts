// MapLibre setup: Esri context imagery at low zoom, one NAIP mosaic per year (true or false
// color), and the per-label-set overlays (site imagery, mask raster, label polygons, site outlines).
import maplibregl, { type LngLatBoundsLike, type StyleSpecification } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { dataUrl, type Composite, type LabelSet, type NaipSources, type SiteCollection } from "./data";

maplibregl.addProtocol("pmtiles", new Protocol().tile);

/** The mask PNGs are magenta; in false color (pink vegetation) the layer is hue-rotated to cyan. */
export const MASK_HUE_ROTATE: Record<Composite, number> = { true: 0, false: 240 };
export const MASK_CSS: Record<Composite, string> = { true: "#ff00c8", false: "#00c8ff" };

export const COLORS = {
  polygon: "#ffe14d",
  polygonCasing: "#1b1f23",
  extent: "#00e5ff", // keep in sync with --sw-extent (legend swatch)
  point: "#ff4fd8",
};

/** Default view: the contiguous US. */
export const HOME_BOUNDS: LngLatBoundsLike = [[-125, 24.3], [-66.9, 49.5]];
/** Panning limit: CONUS plus a margin. Sites outside it (Hawaii) get their own limit when selected. */
export const CONUS_MAX_BOUNDS: [[number, number], [number, number]] = [[-130, 21], [-62, 53]];
const OUTSIDE_MARGIN_DEG = 3;

/** The panning limit to use while a site is in focus. */
export function maxBoundsFor(bbox: [number, number, number, number] | null): [[number, number], [number, number]] {
  const [[W, S], [E, N]] = CONUS_MAX_BOUNDS;
  if (!bbox) return CONUS_MAX_BOUNDS;
  const [w, s, e, n] = bbox;
  if (w >= W && e <= E && s >= S && n <= N) return CONUS_MAX_BOUNDS;
  const m = OUTSIDE_MARGIN_DEG;
  return [[w - m, s - m], [e + m, n + m]];
}

const ESRI_MAXZOOM = 11.5; // Esri context is hidden once NAIP takes over

export function createMap(container: HTMLElement, naip: NaipSources, composite: Composite): maplibregl.Map {
  const style: StyleSpecification = {
    version: 8,
    glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
    sources: {
      esri: {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        maxzoom: 19,
        attribution: "Context imagery © Esri, Maxar, Earthstar Geographics",
      },
      ...Object.fromEntries(
        naip.years.map((y) => [
          `naip-${y.year}`,
          {
            type: "raster" as const,
            tiles: [y.tiles[composite]],
            tileSize: 256,
            minzoom: y.minzoom,
            maxzoom: 18,
            attribution: naip.attribution,
          },
        ]),
      ),
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#1d2024" } },
      { id: "esri", type: "raster", source: "esri", maxzoom: ESRI_MAXZOOM },
      ...naip.years.map((y) => ({
        id: `naip-${y.year}`,
        type: "raster" as const,
        source: `naip-${y.year}`,
        minzoom: y.minzoom,
        layout: { visibility: "none" as const },
      })),
    ],
  };

  const map = new maplibregl.Map({
    container,
    style,
    bounds: HOME_BOUNDS,
    maxBounds: CONUS_MAX_BOUNDS,
    hash: "map",
    maxPitch: 0,
    dragRotate: false,
    attributionControl: false,
  });
  map.touchZoomRotate.disableRotation();

  // Source credits stay collapsed behind the (i) button. MapLibre expands them whenever a
  // source's attribution first appears, so undo any expansion the user didn't click for.
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
  const attrib = container.querySelector<HTMLElement>(".maplibregl-ctrl-attrib")!;
  let lastClick = 0;
  attrib.addEventListener("click", () => (lastClick = Date.now()), true);
  new MutationObserver(() => {
    if (attrib.classList.contains("maplibregl-compact-show") && Date.now() - lastClick > 500) {
      attrib.classList.remove("maplibregl-compact-show");
    }
  }).observe(attrib, { attributes: true, attributeFilter: ["class"] });
  return map;
}

export function showYear(map: maplibregl.Map, naip: NaipSources, year: number) {
  for (const y of naip.years) {
    map.setLayoutProperty(`naip-${y.year}`, "visibility", y.year === year ? "visible" : "none");
  }
}

export function showComposite(map: maplibregl.Map, naip: NaipSources, composite: Composite) {
  for (const y of naip.years) {
    (map.getSource(`naip-${y.year}`) as maplibregl.RasterTileSource).setTiles([y.tiles[composite]]);
  }
}

/** Zoom buttons plus a "home" button that returns to the default view. */
export function addNavigation(map: maplibregl.Map, onHome: () => void) {
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
  // Scale bars: metric (the dataset's units) above imperial. Controls added later to a bottom
  // corner stack above earlier ones, so imperial goes in first.
  map.addControl(new maplibregl.ScaleControl({ unit: "imperial", maxWidth: 120 }), "bottom-left");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 120 }), "bottom-left");
  map.addControl(
    {
      onAdd() {
        const group = document.createElement("div");
        group.className = "maplibregl-ctrl maplibregl-ctrl-group";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "home-ctrl";
        btn.title = "Default view";
        btn.setAttribute("aria-label", "Default view");
        btn.innerHTML =
          '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 3 2.5 11.2l1.3 1.5L5 11.7V20a1 1 0 0 0 1 1h4.5v-6h3v6H18a1 1 0 0 0 1-1v-8.3l1.2 1 1.3-1.5Z"/></svg>';
        btn.onclick = onHome;
        group.append(btn);
        return group;
      },
      onRemove() {},
    },
    "top-left",
  );
}

export function goHome(map: maplibregl.Map) {
  map.setMaxBounds(CONUS_MAX_BOUNDS);
  map.fitBounds(HOME_BOUNDS, { duration: 800 });
}

const LS_LAYERS = [
  "site-imagery",
  "mask",
  "extents-fill",
  "extents-line",
  "extents-selected",
  "labels-casing",
  "labels-line",
  "points-cluster",
  "points-cluster-count",
  "points",
];
const LS_SOURCES = ["site-rgb", "site-nir", "mask", "extents", "labels", "points"];

/** Replace all label-set overlays with the ones for `ls`. */
export function setLabelSet(map: maplibregl.Map, ls: LabelSet, sites: SiteCollection) {
  for (const id of LS_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
  for (const id of LS_SOURCES) if (map.getSource(id)) map.removeSource(id);

  const pm = (file: string) => `pmtiles://${dataUrl(`${ls.id}/${file}`)}`;
  const points: GeoJSON.FeatureCollection<GeoJSON.Point> = {
    type: "FeatureCollection",
    features: sites.features.map((f) => {
      const [w, s, e, n] = f.properties.bbox;
      return {
        type: "Feature",
        properties: { site: f.properties.site, labeled: f.properties.label_px > 0 },
        geometry: { type: "Point", coordinates: [(w + e) / 2, (s + n) / 2] },
      };
    }),
  };

  if (ls.layers.rgb) map.addSource("site-rgb", { type: "raster", url: pm(ls.layers.rgb), tileSize: 512 });
  if (ls.layers.nir) map.addSource("site-nir", { type: "raster", url: pm(ls.layers.nir), tileSize: 512 });
  if (ls.layers.mask) map.addSource("mask", { type: "raster", url: pm(ls.layers.mask), tileSize: 512 });
  map.addSource("extents", { type: "geojson", data: sites, promoteId: "site" });
  map.addSource("labels", { type: "vector", url: pm(ls.layers.labels) });
  map.addSource("points", { type: "geojson", data: points, cluster: true, clusterMaxZoom: 8, clusterRadius: 40 });

  const outlineMin = 11;
  if (ls.layers.rgb) {
    map.addLayer({ id: "site-imagery", type: "raster", source: "site-rgb", layout: { visibility: "none" } });
  }
  if (ls.layers.mask) {
    map.addLayer({
      id: "mask",
      type: "raster",
      source: "mask",
      paint: { "raster-resampling": "nearest", "raster-fade-duration": 0 },
    });
  }
  map.addLayer({
    id: "extents-fill", // invisible hit target for clicks
    type: "fill",
    source: "extents",
    minzoom: outlineMin,
    paint: { "fill-color": "#000", "fill-opacity": 0 },
  });
  map.addLayer({
    id: "extents-line",
    type: "line",
    source: "extents",
    minzoom: outlineMin,
    paint: { "line-color": COLORS.extent, "line-width": 1.5, "line-opacity": 0.85 },
  });
  map.addLayer({
    id: "extents-selected",
    type: "line",
    source: "extents",
    filter: ["==", ["get", "site"], ""],
    paint: { "line-color": COLORS.extent, "line-width": 3.5 }, // selected site: same color, heavier line
  });
  // A dark casing under the yellow outline keeps small polygons visible on bright imagery.
  // MapLibre only allows ["zoom"] at the top of an interpolate, so the casing gets its own curve.
  const width = (pad: number): maplibregl.ExpressionSpecification =>
    ["interpolate", ["linear"], ["zoom"], 12, 1.2 + pad, 16, 2 + pad, 19, 3 + pad];
  map.addLayer({
    id: "labels-casing",
    type: "line",
    source: "labels",
    "source-layer": "labels",
    paint: { "line-color": COLORS.polygonCasing, "line-opacity": 0.6, "line-width": width(2) },
  });
  map.addLayer({
    id: "labels-line",
    type: "line",
    source: "labels",
    "source-layer": "labels",
    paint: { "line-color": COLORS.polygon, "line-width": width(0) },
  });
  map.addLayer({
    id: "points-cluster",
    type: "circle",
    source: "points",
    filter: ["has", "point_count"],
    maxzoom: outlineMin + 1,
    paint: {
      "circle-color": "rgba(255,79,216,0.85)",
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 1.5,
      "circle-radius": ["step", ["get", "point_count"], 12, 10, 16, 50, 21],
    },
  });
  map.addLayer({
    id: "points-cluster-count",
    type: "symbol",
    source: "points",
    filter: ["has", "point_count"],
    maxzoom: outlineMin + 1,
    layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": ["Noto Sans Regular"], "text-size": 12 },
    paint: { "text-color": "#fff" },
  });
  map.addLayer({
    id: "points",
    type: "circle",
    source: "points",
    filter: ["!", ["has", "point_count"]],
    maxzoom: outlineMin + 1,
    paint: {
      "circle-color": ["case", ["get", "labeled"], COLORS.point, "#c9c9c9"],
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 1.5,
      "circle-radius": 6,
    },
  });
}

export function setSelected(map: maplibregl.Map, site: string | null) {
  if (map.getLayer("extents-selected")) {
    map.setFilter("extents-selected", ["==", ["get", "site"], site ?? ""]);
  }
}

export interface OverlayState {
  naip: Composite;
  polygons: boolean;
  mask: boolean;
  maskOpacity: number;
  outlines: boolean;
  imagery: "off" | "rgb" | "nir";
  imageryOpacity: number;
}

export function applyOverlays(map: maplibregl.Map, o: OverlayState) {
  const vis = (id: string, on: boolean) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  };
  vis("labels-casing", o.polygons);
  vis("labels-line", o.polygons);
  vis("mask", o.mask);
  if (map.getLayer("mask")) {
    map.setPaintProperty("mask", "raster-opacity", o.maskOpacity);
    map.setPaintProperty("mask", "raster-hue-rotate", MASK_HUE_ROTATE[o.naip]);
  }
  vis("extents-line", o.outlines);
  vis("extents-selected", o.outlines);

  if (map.getLayer("site-imagery")) {
    const want = o.imagery === "nir" ? "site-nir" : "site-rgb";
    const layer = map.getLayer("site-imagery")!;
    if (layer.source !== want && map.getSource(want)) {
      // A raster layer's source can't be changed in place; re-create it at the same position.
      const before = map.getStyle().layers[map.getStyle().layers.findIndex((l) => l.id === "site-imagery") + 1]?.id;
      map.removeLayer("site-imagery");
      map.addLayer({ id: "site-imagery", type: "raster", source: want }, before);
    }
    vis("site-imagery", o.imagery !== "off");
    map.setPaintProperty("site-imagery", "raster-opacity", o.imageryOpacity);
  }
}
