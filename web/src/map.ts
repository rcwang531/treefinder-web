// MapLibre setup: Esri context imagery at low zoom, one NAIP mosaic per year, and the
// per-label-set overlays (site imagery, mask raster, label polygons, site outlines).
import maplibregl, { type StyleSpecification } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { dataUrl, type LabelSet, type NaipSources, type SiteCollection } from "./data";

maplibregl.addProtocol("pmtiles", new Protocol().tile);

export const COLORS = {
  polygon: "#ffe14d",
  extent: "#ffffff",
  buffer: "#7fd3ff",
  selected: "#00e5ff",
  point: "#ff4fd8",
};

const ESRI_MAXZOOM = 11.5; // Esri context is hidden once NAIP takes over

export function createMap(container: HTMLElement, naip: NaipSources): maplibregl.Map {
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
            tiles: [y.tiles],
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

  return new maplibregl.Map({
    container,
    style,
    center: [-98.5, 39.5],
    zoom: 3.6,
    hash: "map",
    maxPitch: 0,
    dragRotate: false,
    attributionControl: { compact: true },
  });
}

export function showYear(map: maplibregl.Map, naip: NaipSources, year: number) {
  for (const y of naip.years) {
    map.setLayoutProperty(`naip-${y.year}`, "visibility", y.year === year ? "visible" : "none");
  }
}

const LS_LAYERS = [
  "site-imagery",
  "mask",
  "buffers-line",
  "extents-fill",
  "extents-line",
  "extents-selected",
  "labels-fill",
  "labels-line",
  "points-cluster",
  "points-cluster-count",
  "points",
];
const LS_SOURCES = ["site-rgb", "site-nir", "mask", "buffers", "extents", "labels", "points"];

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
  map.addSource("buffers", { type: "geojson", data: dataUrl(`${ls.id}/${ls.layers.buffers}`) });
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
    id: "buffers-line",
    type: "line",
    source: "buffers",
    minzoom: outlineMin,
    paint: { "line-color": COLORS.buffer, "line-width": 1.2, "line-dasharray": [3, 2], "line-opacity": 0.9 },
  });
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
    paint: { "line-color": COLORS.selected, "line-width": 3 },
  });
  map.addLayer({
    id: "labels-fill",
    type: "fill",
    source: "labels",
    "source-layer": "labels",
    paint: { "fill-color": COLORS.polygon, "fill-opacity": 0.15 },
  });
  map.addLayer({
    id: "labels-line",
    type: "line",
    source: "labels",
    "source-layer": "labels",
    paint: { "line-color": COLORS.polygon, "line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.8, 18, 2] },
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
  vis("labels-fill", o.polygons);
  vis("labels-line", o.polygons);
  vis("mask", o.mask);
  if (map.getLayer("mask")) map.setPaintProperty("mask", "raster-opacity", o.maskOpacity);
  vis("buffers-line", o.outlines);
  vis("extents-line", o.outlines);

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
