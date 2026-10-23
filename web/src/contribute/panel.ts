// "Contribute" tab: validate existing labels, or draw new ones in a (movable) site square and
// submit them together with the site information.
import maplibregl from "maplibre-gl";
import { TerraDraw, TerraDrawPolygonMode, TerraDrawSelectMode, ValidateNotSelfIntersecting } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { backend, type Answer, type Role } from "./backend";
import { SiteFrame, type FrameState } from "./frame";
import { polygonInside } from "./geo";
import { demoNote, esc, mountSignIn, store, userBlock, wireSignOut } from "./session";
import { buildAnnotation, buildSite, download, fileName, newSubmissionId, readSubmission } from "./submission";

export interface ContributeHost {
  map: maplibregl.Map;
  /** The selected site, if any. */
  site(): { id: string; extent: GeoJSON.Polygon } | null;
  extentOf(site: string): GeoJSON.Polygon | null;
  year(): number;
  composite(): string;
  latestYear(site: string): number | null;
  setYear(year: number): void;
  /** While drawing, the map's own click handling (site selection) must stand down. */
  setDrawing(active: boolean): void;
  /** Switch the sidebar to the Review tab (to see one's submissions). */
  openReview(): void;
}

type Mode = "validate" | "draw";
const roleFor = (m: Mode): Role => (m === "draw" ? "annotate" : "validate");
const ANSWERS: { value: Answer; label: string; key: string }[] = [
  { value: "dead", label: "Yes, dead", key: "y" },
  { value: "not_dead", label: "No", key: "n" },
  { value: "unsure", label: "Not sure", key: "u" },
];
const DRAFT_PREFIX = "treefinder.draft2";

interface Draft {
  frame: FrameState;
  polygons: GeoJSON.Polygon[];
}

export function setupContribute(host: ContributeHost, root: HTMLElement) {
  const { map } = host;
  let mode: Mode = "validate";
  let answers: Record<string, Answer> = {};
  let message = "";
  let visible = false;
  let active = false;

  store.subscribe(async () => {
    if (store.has("validate")) {
      try {
        answers = await backend.myValidations(store.token);
      } catch (e) {
        message = store.fail(e);
      }
    } else answers = {};
    paintAnswers();
    if (!store.user) deactivate();
    render();
    activateMode();
  });

  // ---------- rendering ----------
  function render() {
    const u = store.user;
    if (!store.session || !u) {
      root.innerHTML = `${demoNote()}
        <h2>Contribute</h2>
        <p>Approved contributors can check existing labels and draw new ones.</p>
        <ul class="contrib-roles">
          <li><b>Validate</b>: click a labeled polygon and answer one question: is this tree dead?</li>
          <li><b>Draw</b>: place a site square (move it anywhere in the US if you like), outline the dead trees in it and submit them. A reviewer checks every submission.</li>
        </ul>
        <div class="signin-slot"></div>
        <p class="muted small">No account yet? Sign in and an access request is recorded for the team, or email
          <a href="mailto:ruichenw@umd.edu?subject=TreeFinder%20contributor%20access">ruichenw@umd.edu</a>.</p>
        <p class="contrib-msg" role="status">${esc(store.message || message)}</p>`;
      mountSignIn(root.querySelector(".signin-slot")!, say);
      return;
    }
    if (u.pending || !(u.roles.includes("validate") || u.roles.includes("annotate"))) {
      root.innerHTML = `${demoNote()}<h2>Contribute</h2>${userBlock()}
        <p>${u.pending ? "Your account isn't on the contributor list yet. Your request has been recorded and the team will review it." : "Your account can review submissions (see the Review tab) but not contribute labels."}</p>`;
      wireSignOut(root);
      return;
    }
    if (!u.roles.includes(roleFor(mode))) mode = u.roles.includes("validate") ? "validate" : "draw";
    const both = u.roles.includes("validate") && u.roles.includes("annotate");
    const tabs = both
      ? `<div class="contrib-modes" role="radiogroup" aria-label="Contribution mode">
          <button type="button" role="radio" aria-checked="${mode === "validate"}" data-mode="validate">Validate</button>
          <button type="button" role="radio" aria-checked="${mode === "draw"}" data-mode="draw">Draw</button>
        </div>`
      : "";
    root.innerHTML = `${demoNote()}<h2>Contribute</h2>${userBlock()}${tabs}<div id="contrib-body"></div>
      <p class="contrib-msg" role="status" aria-live="polite">${esc(message)}</p>`;
    wireSignOut(root);
    root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => (b.onclick = () => setMode(b.dataset.mode as Mode)));
    if (mode === "validate") renderValidate();
    else renderDraw();
  }

  function say(text: string) {
    message = text;
    const el = root.querySelector(".contrib-msg");
    if (el) el.textContent = text;
  }

  // ---------- mode switching ----------
  function setMode(m: Mode) {
    deactivate();
    mode = m;
    message = "";
    render();
    activateMode();
  }
  function activateMode() {
    if (!visible || !store.has(roleFor(mode))) return;
    active = true;
    if (mode === "draw") startDrawing();
  }
  function deactivate() {
    active = false;
    popup?.remove();
    stopDrawing();
  }

  // ---------- validation ----------
  function renderValidate() {
    const counts = { dead: 0, not_dead: 0, unsure: 0 };
    Object.values(answers).forEach((a) => counts[a]++);
    const total = counts.dead + counts.not_dead + counts.unsure;
    root.querySelector("#contrib-body")!.innerHTML = `
      <p>Zoom in to a site and <b>click a polygon outline</b> to answer whether it marks a dead tree.
        Switch NAIP years (<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd>) or false color (<kbd>→</kbd>) to compare.</p>
      <ul class="answer-legend" aria-label="Outline colors">
        <li><i class="sw-answer" data-a="dead"></i> Dead (${counts.dead})</li>
        <li><i class="sw-answer" data-a="not_dead"></i> Not dead (${counts.not_dead})</li>
        <li><i class="sw-answer" data-a="unsure"></i> Not sure (${counts.unsure})</li>
      </ul>
      <p class="muted small">You have answered ${total} polygon${total === 1 ? "" : "s"}.</p>`;
  }
  function paintAnswers() {
    if (!map.getSource("labels")) return;
    map.removeFeatureState({ source: "labels", sourceLayer: "labels" });
    for (const [pid, answer] of Object.entries(answers)) {
      map.setFeatureState({ source: "labels", sourceLayer: "labels", id: pid }, { answer });
    }
  }

  let popup: maplibregl.Popup | null = null;
  function askAbout(pid: string, site: string, at: maplibregl.LngLat) {
    popup?.remove();
    const box = document.createElement("div");
    box.className = "validate-popup";
    const year = host.year();
    const comp = host.composite() === "false" ? "false color" : "true color";
    box.innerHTML = `<p class="vp-q" id="vp-q">Is this a dead tree?</p>
      <p class="vp-meta">Polygon ${esc(pid)} · NAIP ${year} ${comp}</p>
      <div class="vp-answers" role="group" aria-labelledby="vp-q">${ANSWERS.map(
        (a) => `<button type="button" data-answer="${a.value}" aria-pressed="${answers[pid] === a.value}">${a.label} <kbd>${a.key.toUpperCase()}</kbd></button>`,
      ).join("")}</div>`;
    const choose = async (answer: Answer) => {
      box.querySelectorAll("button").forEach((b) => (b.disabled = true));
      try {
        await backend.validate(store.token, { pid, site, answer, naip_year: year, composite: host.composite() });
        answers[pid] = answer;
        map.setFeatureState({ source: "labels", sourceLayer: "labels", id: pid }, { answer });
        say(`Saved: ${pid} marked "${ANSWERS.find((a) => a.value === answer)!.label}".`);
        renderValidate();
        popup?.remove();
      } catch (e) {
        box.querySelectorAll("button").forEach((b) => (b.disabled = false));
        say(store.fail(e));
      }
    };
    box.querySelectorAll<HTMLButtonElement>("[data-answer]").forEach((b) => (b.onclick = () => choose(b.dataset.answer as Answer)));
    const onKey = (e: KeyboardEvent) => {
      const a = ANSWERS.find((x) => x.key === e.key.toLowerCase());
      if (a && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        choose(a.value);
      }
    };
    document.addEventListener("keydown", onKey);
    popup = new maplibregl.Popup({ closeButton: true, maxWidth: "280px", focusAfterOpen: true })
      .setLngLat(at)
      .setDOMContent(box) // DOM content, not HTML strings: nothing passes through an HTML sanitizer
      .addTo(map);
    popup.on("close", () => document.removeEventListener("keydown", onKey));
    box.querySelector<HTMLButtonElement>("button")?.focus();
  }

  /** Map click hook from main.ts; returns true when the click was used for validation. */
  function handleMapClick(e: maplibregl.MapMouseEvent): boolean {
    if (!active || mode !== "validate" || !map.getLayer("labels-hit")) return false;
    const [f] = map.queryRenderedFeatures(e.point, { layers: ["labels-hit"] });
    if (!f?.properties?.pid) return false;
    askAbout(String(f.properties.pid), String(f.properties.site), e.lngLat);
    return true;
  }

  // ---------- drawing ----------
  let draw: TerraDraw | null = null;
  let drawSite: string | null = null;
  let moving = false;
  const frame = new SiteFrame(map, () => {
    saveDraft();
    renderDraw();
  });
  const draftKey = (site: string) => `${DRAFT_PREFIX}.${store.user?.email ?? "anon"}.${site}`;

  function insideFrame(feature: { geometry: GeoJSON.Geometry }) {
    if (feature.geometry.type !== "Polygon" || !drawSite) return { valid: false, reason: "Not a polygon" };
    if (!polygonInside(feature.geometry, frame.geometry())) return { valid: false, reason: "Outside the site square" };
    return ValidateNotSelfIntersecting(feature as never);
  }

  function ensureDraw() {
    if (draw) return draw;
    const polygonStyle = {
      fillColor: "#ff9100", fillOpacity: 0.15, outlineColor: "#ff9100", outlineWidth: 2,
      closingPointColor: "#ffffff", closingPointOutlineColor: "#ff9100",
    } as const;
    draw = new TerraDraw({
      adapter: new TerraDrawMapLibreGLAdapter({ map, prefixId: "td-contrib" }),
      modes: [
        new TerraDrawPolygonMode({ styles: polygonStyle, validation: (f) => insideFrame(f) }),
        new TerraDrawSelectMode({
          flags: {
            polygon: {
              feature: {
                draggable: true,
                validation: (f) => insideFrame(f),
                coordinates: { draggable: true, midpoints: true, deletable: true },
              },
            },
          },
        }),
      ],
    });
    draw.start();
    draw.on("change", () => {
      saveDraft();
      updateDrawCount();
    });
    return draw;
  }

  function polygons(): GeoJSON.Polygon[] {
    return (draw?.getSnapshot() ?? [])
      .filter((f) => f.geometry.type === "Polygon" && f.properties.mode === "polygon")
      .map((f) => f.geometry as GeoJSON.Polygon);
  }
  function saveDraft() {
    if (!drawSite) return;
    const d: Draft = { frame: frame.state(), polygons: polygons() };
    try {
      localStorage.setItem(draftKey(drawSite), JSON.stringify(d));
    } catch {
      /* storage unavailable: the draft lasts for this page view */
    }
  }
  function readDraft(site: string): Draft | null {
    try {
      return JSON.parse(localStorage.getItem(draftKey(site)) ?? "null");
    } catch {
      return null;
    }
  }

  function startDrawing() {
    const s = host.site();
    if (!s) {
      stopDrawing();
      renderDraw();
      return;
    }
    const d = ensureDraw();
    if (drawSite !== s.id) {
      saveDraft();
      d.clear();
      drawSite = s.id;
      const draft = readDraft(s.id);
      frame.set(s.id, s.extent, draft?.frame.center);
      if (draft?.polygons.length) {
        d.addFeatures(
          draft.polygons.map((geometry) => ({ id: crypto.randomUUID(), type: "Feature", geometry, properties: { mode: "polygon" } })),
        );
      }
      // Label on the most recent imagery available here (unknown once the square has moved away).
      const latest = host.latestYear(s.id);
      if (!frame.moved && latest && latest !== host.year()) host.setYear(latest);
    }
    host.setDrawing(true);
    if (!moving) d.setMode("polygon");
    renderDraw();
  }
  function stopDrawing() {
    if (draw) {
      saveDraft();
      draw.setMode("static");
    }
    setMoving(false);
    frame.hide();
    drawSite = null;
    draw?.clear();
    host.setDrawing(false);
  }
  function setMoving(on: boolean) {
    moving = on;
    frame.setMovable(on);
    if (on) draw?.setMode("static");
    else if (active && mode === "draw" && drawSite) draw?.setMode("polygon");
  }

  function updateDrawCount() {
    const n = polygons().length;
    const el = root.querySelector("#draw-count");
    if (el) el.textContent = `${n} polygon${n === 1 ? "" : "s"} drawn · draft saved in this browser`;
    root.querySelectorAll<HTMLButtonElement>("[data-needs-polys]").forEach((b) => (b.disabled = !n));
    const mv = root.querySelector<HTMLButtonElement>("[data-act=move]");
    if (mv) mv.disabled = n > 0 && !moving;
  }

  function renderDraw() {
    const body = root.querySelector("#contrib-body");
    if (!body || mode !== "draw") return;
    const s = host.site();
    if (!s || !drawSite) {
      body.innerHTML = `<p><b>Select a site first</b> (in the Sites tab, or by clicking one on the map). Its square is where you'll draw; you can move it afterwards.</p>`;
      return;
    }
    const [east, north] = frame.offsetMeters().map(Math.round);
    const where = frame.moved
      ? `moved ${Math.abs(east)} m ${east >= 0 ? "east" : "west"}, ${Math.abs(north)} m ${north >= 0 ? "north" : "south"}`
      : "original position";
    const tool = moving ? "move" : draw?.getMode() ?? "static";
    body.innerHTML = `
      <p class="draw-site">Site <b>${esc(s.id)}</b> · NAIP ${host.year()}<br><span class="muted small">Square: ${where}</span></p>
      <div class="draw-tools" role="toolbar" aria-label="Site square">
        <button type="button" data-act="move" aria-pressed="${moving}">${moving ? "Done moving" : "Move site"}</button>
        <button type="button" data-act="reset" ${frame.moved ? "" : "disabled"}>Reset position</button>
      </div>
      <p class="muted small">${moving
        ? "Drag the dashed square to a new spot. Its size and orientation stay the same."
        : "Move the square before drawing; it's locked while it contains polygons."}</p>
      <div class="draw-tools" role="toolbar" aria-label="Drawing tools">
        <button type="button" data-tool="polygon" aria-pressed="${tool === "polygon"}" ${moving ? "disabled" : ""}>Draw</button>
        <button type="button" data-tool="select" aria-pressed="${tool === "select"}" ${moving ? "disabled" : ""}>Edit</button>
        <button type="button" data-act="clear" data-needs-polys>Clear all</button>
      </div>
      <p class="muted small">Click to add corners; click the first corner or press <kbd>Enter</kbd> to finish, <kbd>Esc</kbd> to cancel.
        In Edit, drag corners or the shape; select a polygon and press <kbd>Delete</kbd> to remove it. Polygons must stay inside the square.</p>
      <p id="draw-count" class="draw-count"></p>
      <button type="button" class="contrib-btn" data-act="download" data-needs-polys>Download site + annotation</button>
      <button type="button" class="contrib-btn primary" data-act="submit" data-needs-polys>Submit for review</button>
      <h3>Upload saved files</h3>
      <div id="dropzone" class="dropzone" tabindex="0" role="button" aria-label="Upload saved files: drop them here or press Enter to choose files">
        Drop the downloaded <b>site</b> and <b>annotation</b> files here, or <u>choose files</u>
        <input id="upload-file" type="file" multiple accept=".geojson,.json,application/geo+json,application/json" hidden />
      </div>
      <p class="muted small">Submitted work and reviewer feedback are in the <button type="button" class="contrib-link" data-act="mine">Review tab</button>.</p>`;
    body.querySelector<HTMLButtonElement>("[data-act=move]")!.onclick = () => {
      setMoving(!moving);
      renderDraw();
    };
    body.querySelector<HTMLButtonElement>("[data-act=reset]")!.onclick = () => frame.reset();
    body.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) => {
      b.onclick = () => {
        ensureDraw().setMode(b.dataset.tool!);
        body.querySelectorAll("[data-tool]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      };
    });
    body.querySelector<HTMLButtonElement>("[data-act=clear]")!.onclick = () => {
      if (confirm(`Remove all ${polygons().length} polygons drawn at ${s.id}?`)) {
        draw?.clear();
        saveDraft();
        updateDrawCount();
      }
    };
    body.querySelector<HTMLButtonElement>("[data-act=download]")!.onclick = downloadCurrent;
    body.querySelector<HTMLButtonElement>("[data-act=submit]")!.onclick = () => {
      const { site, annotation } = current();
      submit(site, annotation);
    };
    body.querySelector<HTMLButtonElement>("[data-act=mine]")!.onclick = () => host.openReview();
    const zone = body.querySelector<HTMLElement>("#dropzone")!;
    const input = body.querySelector<HTMLInputElement>("#upload-file")!;
    zone.onclick = () => input.click();
    zone.onkeydown = (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), input.click());
    input.onchange = () => input.files?.length && uploadFiles([...input.files]);
    zone.ondragover = (e) => {
      e.preventDefault();
      zone.classList.add("over");
    };
    zone.ondragleave = () => zone.classList.remove("over");
    zone.ondrop = (e) => {
      e.preventDefault();
      zone.classList.remove("over");
      if (e.dataTransfer?.files.length) uploadFiles([...e.dataTransfer.files]);
    };
    updateDrawCount();
  }

  /** The current square and polygons as a site file + annotation file pair. */
  function current() {
    const id = newSubmissionId(drawSite!, store.user!.email);
    const site = buildSite({
      id,
      site_id: drawSite!,
      frame: frame.geometry(),
      moved: frame.moved,
      offset_m: frame.offsetMeters(),
      size_m: frame.sizeMeters(),
      naip_year: host.year(),
      annotator: store.user!.email,
    });
    return { site, annotation: buildAnnotation(polygons(), site) };
  }
  function downloadCurrent() {
    const { site, annotation } = current();
    const id = site.treefinder.submission_id;
    download(fileName(id, "site"), site);
    setTimeout(() => download(fileName(id, "annotation"), annotation), 400); // browsers drop back-to-back downloads
    say(`Downloaded ${fileName(id, "site")} and ${fileName(id, "annotation")}. Upload both below, or press Submit.`);
  }
  async function uploadFiles(files: File[]) {
    try {
      const texts = await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() })));
      const { site, annotation } = readSubmission(texts, (id) => Boolean(host.extentOf(id)));
      submit(site, annotation);
    } catch (e) {
      say(`Can't upload: ${(e as Error).message}`);
    }
  }
  async function submit(site: ReturnType<typeof buildSite>, annotation: ReturnType<typeof buildAnnotation>) {
    const id = site.treefinder.submission_id;
    say(`Submitting ${id}…`);
    try {
      const r = await backend.submit(store.token, {
        id,
        site_id: site.treefinder.site_id,
        site: JSON.stringify(site),
        annotation: JSON.stringify(annotation),
      });
      say(`Submitted ${r.polygons} polygon${r.polygons === 1 ? "" : "s"} as ${r.id}. A reviewer will check it; feedback appears in the Review tab.`);
    } catch (e) {
      say(store.fail(e));
    }
  }

  // ---------- visibility (Contribute tab shown or hidden) ----------
  function show(on: boolean) {
    visible = on;
    if (on) {
      render();
      activateMode();
    } else deactivate();
  }

  render();

  return {
    show,
    handleMapClick,
    /** Called by main.ts when the selected site or NAIP year changes. */
    refresh() {
      if (!active) return;
      if (mode === "draw") startDrawing();
      else render();
    },
    /** Re-apply answer colors after the label layers were rebuilt (tab switch). */
    repaint: paintAnswers,
  };
}
