import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import type maplibregl from "maplibre-gl";
import { loadSites, loadStatic, type LabelSet, type SiteCollection, type SiteProps } from "./data";
import {
  addNavigation,
  applyOverlays,
  createMap,
  goHome,
  MASK_CSS,
  setLabelSet,
  setSelected,
  showComposite,
  showYear,
  type OverlayState,
} from "./map";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

// ---- URL hash: "map=z/lat/lon" is owned by MapLibre; we add t (tab), y (year) and s (site). ----
function readHash(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of location.hash.replace(/^#/, "").split("&")) {
    const [k, v] = part.split("=");
    if (k && v !== undefined) out[k] = decodeURIComponent(v);
  }
  return out;
}
function writeHash(updates: Record<string, string | null>) {
  const h = { ...readHash(), ...updates };
  const s = Object.entries(h)
    .filter(([, v]) => v !== null && v !== "")
    .map(([k, v]) => `${k}=${k === "map" ? v : encodeURIComponent(v!)}`)
    .join("&");
  history.replaceState(history.state, "", `#${s}`);
}

// ---- per-viewer layer preferences (best effort) ----
const OVERLAY_KEY = "treefinder.overlays.v2"; // bump when defaults change so old choices don't stick
const defaultOverlays: OverlayState = {
  naip: "true",
  polygons: true,
  mask: true,
  maskOpacity: 0.7,
  outlines: true,
  imagery: "off",
  imageryOpacity: 1,
};
function loadOverlays(): OverlayState {
  try {
    return { ...defaultOverlays, ...JSON.parse(localStorage.getItem(OVERLAY_KEY) ?? "{}") };
  } catch {
    return { ...defaultOverlays };
  }
}
function saveOverlays(o: OverlayState) {
  try {
    localStorage.setItem(OVERLAY_KEY, JSON.stringify(o));
  } catch {
    /* storage unavailable: preferences just won't persist */
  }
}

const fmtArea = (m2: number) => (m2 >= 10000 ? `${(m2 / 10000).toFixed(2)} ha` : `${Math.round(m2)} m²`);
const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function main() {
  const { labelsets, naip, availability } = await loadStatic();
  const years = naip.years.map((y) => y.year);
  const hash = readHash();

  const state = {
    tab: labelsets.find((l) => l.id === hash.t) ?? labelsets[0],
    year: years.includes(Number(hash.y)) ? Number(hash.y) : years[years.length - 1],
    site: (hash.s as string | undefined) ?? null,
    overlays: loadOverlays(),
    sites: null as SiteCollection | null,
    byName: new Map<string, SiteProps>(),
    focus: null as string | null, // site whose NAIP coverage drives the notice / year buttons
  };

  const map = createMap($("#map"), naip, state.overlays.naip);
  const panel = $("#layers");
  const hadMapHash = "map" in hash;
  await new Promise<void>((resolve) => map.once("load", () => resolve()));
  if (import.meta.env.DEV) (window as unknown as { map: maplibregl.Map }).map = map; // for browser tests
  const home = () => goHome(map);
  addNavigation(map, home);
  $("#home-title").onclick = home;

  // ---------- tabs ----------
  const tabs = $("#tabs");
  function renderTabs() {
    tabs.replaceChildren(
      ...labelsets.map((ls) => {
        const b = document.createElement("button");
        b.role = "tab";
        b.textContent = ls.name;
        b.title = `${ls.description}\n${ls.n_sites} sites · ${ls.n_polygons} polygons`.trim();
        b.setAttribute("aria-selected", String(ls.id === state.tab.id));
        b.onclick = () => ls.id !== state.tab.id && switchTab(ls);
        return b;
      }),
    );
  }

  // ---------- years ----------
  const yearsEl = $("#years");
  function renderYears() {
    const cov = state.focus ? availability[state.focus] : undefined;
    yearsEl.replaceChildren(
      ...years.map((y) => {
        const b = document.createElement("button");
        b.role = "radio";
        b.textContent = String(y);
        b.setAttribute("aria-checked", String(y === state.year));
        const acq = cov?.[y];
        b.disabled = Boolean(cov && !acq); // no NAIP this year for the site in view
        b.title = acq ? `NAIP flown ${fmtDate(acq.date)} (${acq.gsd ?? "?"} m)` : cov ? "No NAIP this year here" : "";
        b.onclick = () => setYear(y);
        return b;
      }),
    );
  }
  function setYear(y: number) {
    state.year = y;
    showYear(map, naip, y);
    writeHash({ y: String(y) });
    renderYears();
    renderNotice();
  }

  // ---------- coverage notice ----------
  const notice = $("#notice");
  function renderNotice() {
    const cov = state.focus ? availability[state.focus] : undefined;
    if (!cov || cov[state.year]) {
      notice.hidden = true;
      return;
    }
    const others = Object.entries(cov).map(([y, a]) => `${y} (${fmtDate(a.date)})`);
    notice.hidden = false;
    notice.textContent =
      `No NAIP ${state.year} imagery covers ${state.focus}.` +
      (others.length ? ` Available: ${others.join(", ")}.` : " No NAIP 2021–2023 found here.");
  }
  function updateFocus() {
    let focus = state.site;
    if (!focus && map.getZoom() >= 12 && state.sites) {
      const c = map.getCenter();
      const hit = state.sites.features.find(({ properties: { bbox: [w, s, e, n] } }) =>
        c.lng >= w && c.lng <= e && c.lat >= s && c.lat <= n);
      focus = hit?.properties.site ?? null;
    }
    if (focus !== state.focus) {
      state.focus = focus;
      renderYears();
      renderNotice();
    }
  }
  map.on("moveend", updateFocus);

  // ---------- site list ----------
  const list = $("#site-list");
  const search = $<HTMLInputElement>("#search");
  const onlyLabeled = $<HTMLInputElement>("#only-labeled");
  const count = $("#count");

  function renderList() {
    // Most-labeled sites first; ties (incl. unlabeled sites) fall back to ID order.
    const items = [...state.byName.values()].sort(
      (a, b) => b.label_area_m2 - a.label_area_m2 || a.site.localeCompare(b.site, undefined, { numeric: true }),
    );
    list.replaceChildren(
      ...items.map((p) => {
        const li = document.createElement("li");
        li.dataset.site = p.site;
        li.dataset.search = `${p.site} ${p.state ?? ""} ${p.file}`.toLowerCase();
        li.dataset.labeled = String(p.label_px > 0);
        li.innerHTML = `<button type="button"><span class="name">${esc(p.site)}</span>
          <span class="meta">${esc(p.state ?? "")} · ${p.label_px > 0 ? `${fmtArea(p.label_area_m2)} dead` : "no labels"}</span></button>`;
        li.querySelector("button")!.onclick = () => selectSite(p.site, true);
        return li;
      }),
    );
    filterList();
  }
  function filterList() {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const li of list.children as HTMLCollectionOf<HTMLLIElement>) {
      const ok = (!q || li.dataset.search!.includes(q)) && (!onlyLabeled.checked || li.dataset.labeled === "true");
      li.hidden = !ok;
      if (ok) shown++;
    }
    count.textContent = `${shown} of ${list.children.length} sites`;
  }
  search.oninput = filterList;
  onlyLabeled.onchange = filterList;

  // ---------- site card / selection ----------
  const card = $("#site-card");
  function renderCard() {
    const p = state.site ? state.byName.get(state.site) : undefined;
    for (const li of list.children as HTMLCollectionOf<HTMLLIElement>) {
      li.firstElementChild!.setAttribute("aria-current", String(li.dataset.site === state.site));
    }
    if (!p) {
      card.hidden = true;
      return;
    }
    const av = availability[p.site] ?? {};
    const naipRows = years
      .map((y) => `${y}: ${av[y] ? `${fmtDate(av[y].date)} · ${av[y].gsd ?? "?"} m` : "—"}`)
      .join("<br>");
    card.hidden = false;
    card.innerHTML = `
      <h2>${esc(p.site)} <button class="close" aria-label="Clear selection">×</button></h2>
      <dl>
        <dt>State</dt><dd>${esc(p.state ?? "—")}</dd>
        <dt>Dead trees</dt><dd>${p.label_px > 0 ? `${fmtArea(p.label_area_m2)} · ${p.n_polygons} polygons` : "none labeled"}</dd>
        <dt>Climate</dt><dd>${esc(p.climate || "—")} · zone ${esc(p.hardiness_zone || "—")}</dd>
        <dt>NAIP</dt><dd>${naipRows}</dd>
        <dt>Labels refined</dt><dd>${p.label_refined ? fmtDate(p.label_refined) : "—"}</dd>
        ${p.has_imagery ? "" : `<dt>Note</dt><dd>No site imagery in this file</dd>`}
      </dl>`;
    card.querySelector<HTMLButtonElement>(".close")!.onclick = () => selectSite(null, false);
  }
  function zoomTo(p: SiteProps) {
    const [w, s, e, n] = p.bbox;
    // Keep the site clear of the floating layer panel on wide screens.
    const right = matchMedia("(max-width: 760px)").matches ? 24 : panel.offsetWidth + 36;
    map.fitBounds([[w, s], [e, n]], { padding: { top: 40, bottom: 40, left: 24, right }, maxZoom: 18, duration: 800 });
  }
  function selectSite(site: string | null, zoom: boolean) {
    state.site = site && state.byName.has(site) ? site : null;
    setSelected(map, state.site);
    writeHash({ s: state.site });
    renderCard();
    updateFocus();
    const p = state.site ? state.byName.get(state.site) : undefined;
    if (p && zoom) {
      zoomTo(p);
      // Jump straight to a year that has imagery if the current one doesn't.
      const av = availability[p.site];
      if (av && !av[state.year]) {
        const best = years.filter((y) => av[y]).pop();
        if (best) setYear(best);
      }
      document.body.classList.remove("drawer-open");
      list.querySelector(`li[data-site="${CSS.escape(p.site)}"]`)?.scrollIntoView({ block: "nearest" });
    }
  }

  // ---------- label set switching ----------
  async function switchTab(ls: LabelSet) {
    state.tab = ls;
    writeHash({ t: ls.id });
    renderTabs();
    state.sites = await loadSites(ls);
    state.byName = new Map(state.sites.features.map((f) => [f.properties.site, f.properties]));
    // Links made before site IDs existed carry the source file name; map them to the ID.
    if (state.site && !state.byName.has(state.site)) {
      state.site = state.sites.features.find((f) => f.properties.file === state.site)?.properties.site ?? null;
    }
    setLabelSet(map, ls, state.sites);
    // Site imagery is optional per label set (left out of the GitHub Pages build for size).
    $("#imagery-controls").hidden = !ls.layers.rgb && !ls.layers.nir;
    if (!ls.layers.mask) state.overlays.mask = false;
    panel.querySelector<HTMLElement>("label:has([data-ov=mask])")!.hidden = !ls.layers.mask;
    $("#mask-opacity").hidden = !ls.layers.mask;
    applyOverlays(map, state.overlays);
    renderList();
    selectSite(state.site, false);
  }

  // ---------- layer panel ----------
  function syncPanel() {
    for (const el of panel.querySelectorAll<HTMLInputElement>("input[data-ov]")) {
      const key = el.dataset.ov as keyof OverlayState;
      const v = state.overlays[key];
      if (el.type === "checkbox") el.checked = v as boolean;
      else if (el.type === "radio") el.checked = el.value === v;
      else el.value = String(v);
    }
    panel.style.setProperty("--sw-mask", MASK_CSS[state.overlays.naip]); // swatch + slider follow the mask color
    for (const out of panel.querySelectorAll<HTMLOutputElement>("output[data-for]")) {
      out.value = `${Math.round(Number(state.overlays[out.dataset.for as keyof OverlayState]) * 100)}%`;
    }
  }
  panel.addEventListener("input", (ev) => {
    const el = ev.target as HTMLInputElement;
    const key = el.dataset.ov as keyof OverlayState | undefined;
    if (!key) return;
    const o = state.overlays as unknown as Record<string, unknown>;
    o[key] = el.type === "checkbox" ? el.checked : el.type === "range" ? Number(el.value) : el.value;
    if (key === "naip") showComposite(map, naip, state.overlays.naip);
    applyOverlays(map, state.overlays);
    syncPanel();
    saveOverlays(state.overlays);
  });
  // After a mouse/touch click on a layer option, hand focus back to the map so its keyboard
  // shortcuts (arrows, +/-) keep working. Keyboard users keep focus where they are.
  let pointerAt = 0;
  panel.addEventListener("pointerdown", () => (pointerAt = Date.now()));
  panel.addEventListener("change", (ev) => {
    const el = ev.target as HTMLInputElement;
    if ((el.type === "radio" || el.type === "checkbox") && Date.now() - pointerAt < 1000) {
      map.getCanvas().focus({ preventScroll: true });
    }
  });
  panel.querySelector("h2")!.addEventListener("click", () => panel.classList.toggle("collapsed"));
  if (matchMedia("(max-width: 760px)").matches) panel.classList.add("collapsed");

  // ---------- map interaction ----------
  const clickable = ["points-cluster", "points", "extents-fill"];
  map.on("click", async (e) => {
    const layers = clickable.filter((id) => map.getLayer(id));
    const [f] = map.queryRenderedFeatures(e.point, { layers });
    if (!f) return;
    if (f.layer.id === "points-cluster") {
      const src = map.getSource("points") as maplibregl.GeoJSONSource;
      const zoom = await src.getClusterExpansionZoom(f.properties.cluster_id);
      map.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom });
      return;
    }
    selectSite(f.properties.site, f.layer.id === "points");
  });
  map.on("mousemove", (e) => {
    const layers = clickable.filter((id) => map.getLayer(id));
    map.getCanvas().style.cursor = map.queryRenderedFeatures(e.point, { layers }).length ? "pointer" : "";
  });

  // Year keys work everywhere except while typing in a text field.
  document.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (t.matches("textarea, input[type=search], input[type=text]") || e.metaKey || e.ctrlKey || e.altKey) return;
    const i = Number(e.key) - 1;
    const btn = yearsEl.children[i] as HTMLButtonElement | undefined;
    if (btn && !btn.disabled) setYear(years[i]);
  });
  $("#drawer-toggle").onclick = () => document.body.classList.toggle("drawer-open");

  // ---------- about dialog ----------
  const about = $<HTMLDialogElement>("#about");
  const openAbout = () => {
    about.showModal();
    writeHash({ about: "1" });
  };
  $("#about-btn").onclick = openAbout;
  about.querySelector<HTMLButtonElement>(".close")!.onclick = () => about.close();
  about.addEventListener("click", (e) => e.target === about && about.close()); // backdrop click
  about.addEventListener("close", () => writeHash({ about: null }));
  $("#copy-bib").onclick = async () => {
    const btn = $("#copy-bib");
    try {
      await navigator.clipboard.writeText($("#bibtex").textContent!);
      btn.textContent = "Copied";
    } catch {
      btn.textContent = "Copy failed";
    }
    setTimeout(() => (btn.textContent = "Copy BibTeX"), 1500);
  };
  if (hash.about) openAbout();

  // ---------- start ----------
  syncPanel();
  setYear(state.year);
  await switchTab(state.tab);
  if (state.site && !hadMapHash) zoomTo(state.byName.get(state.site)!);
}

main().catch((err) => {
  document.body.innerHTML = `<p style="padding:16px">Failed to load data: ${String(err)}</p>`;
  console.error(err);
});
