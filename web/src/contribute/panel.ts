// Contributor features on the map page: sign-in, polygon validation and drawing new labels.
import maplibregl from "maplibre-gl";
import { TerraDraw, TerraDrawPolygonMode, TerraDrawSelectMode, ValidateNotSelfIntersecting } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { currentSession, renderSignIn, signOut, type Session } from "./auth";
import { backend, BackendError, type Answer, type Contributor, type Role } from "./backend";
import { DEMO_MODE } from "./config";
import { buildExport, checkUpload, exportFileName, polygonInside } from "./geo";

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
}

type Mode = "validate" | "draw";
const roleFor = (m: Mode): Role => (m === "draw" ? "annotate" : "validate");
const ANSWERS: { value: Answer; label: string; key: string }[] = [
  { value: "dead", label: "Yes, dead", key: "y" },
  { value: "not_dead", label: "No", key: "n" },
  { value: "unsure", label: "Not sure", key: "u" },
];
const DRAFT_PREFIX = "treefinder.draft";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function setupContribute(host: ContributeHost, root: HTMLElement) {
  const { map } = host;
  let session: Session | null = currentSession();
  let user: Contributor | null = null;
  let mode: Mode = "validate";
  let answers: Record<string, Answer> = {};
  let message = "";

  // ---------- rendering ----------
  function render() {
    const demo = DEMO_MODE
      ? `<p class="contrib-demo" role="note"><b>Demo mode.</b> The contribution service isn't connected yet, so sign-in is simulated and answers stay in this browser.</p>`
      : "";
    if (!session || !user) {
      root.innerHTML = `${demo}
        <h2>Contribute</h2>
        <p>Approved contributors can check existing labels and draw new ones.</p>
        <ul class="contrib-roles">
          <li><b>Validate</b>: click a labeled polygon and answer one question: is this tree dead?</li>
          <li><b>Draw</b>: outline dead trees at a TreeFinder site on its latest NAIP imagery, download them as GeoJSON and upload the file.</li>
        </ul>
        <div id="signin-slot" class="signin-slot"></div>
        <p class="muted small">No account yet? Sign in and an access request is recorded for the team, or email
          <a href="mailto:ruichenw@umd.edu?subject=TreeFinder%20contributor%20access">ruichenw@umd.edu</a>.</p>
        <p class="contrib-msg" role="status">${esc(message)}</p>`;
      renderSignIn(root.querySelector("#signin-slot")!, onSignIn).catch((e) => {
        message = String(e.message ?? e);
        root.querySelector(".contrib-msg")!.textContent = message;
      });
      return;
    }
    const who = `<p class="contrib-user">Signed in as <b>${esc(user.name)}</b><br><span class="muted">${esc(user.email)}</span>
      <button id="signout" class="contrib-link" type="button">Sign out</button></p>`;
    if (user.pending || !user.roles.length) {
      root.innerHTML = `${demo}<h2>Contribute</h2>${who}
        <p>Your account isn't on the contributor list yet. Your request has been recorded and the team will review it.</p>`;
      root.querySelector<HTMLButtonElement>("#signout")!.onclick = doSignOut;
      return;
    }
    if (!user.roles.includes(roleFor(mode))) mode = user.roles[0] === "annotate" ? "draw" : "validate";
    const tabs = user.roles.length > 1
      ? `<div class="contrib-modes" role="radiogroup" aria-label="Contribution mode">
          <button type="button" role="radio" aria-checked="${mode === "validate"}" data-mode="validate">Validate</button>
          <button type="button" role="radio" aria-checked="${mode === "draw"}" data-mode="draw">Draw</button>
        </div>`
      : "";
    root.innerHTML = `${demo}<h2>Contribute</h2>${who}${tabs}<div id="contrib-body"></div>
      <p class="contrib-msg" role="status" aria-live="polite">${esc(message)}</p>`;
    root.querySelector<HTMLButtonElement>("#signout")!.onclick = doSignOut;
    root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => (b.onclick = () => setMode(b.dataset.mode as Mode)));
    if (mode === "validate") renderValidate();
    else renderDraw();
  }

  function say(text: string) {
    message = text;
    const el = root.querySelector(".contrib-msg");
    if (el) el.textContent = text;
  }

  // ---------- sign-in ----------
  async function onSignIn(s: Session) {
    session = s;
    say("Checking your contributor access…");
    try {
      user = await backend.whoami(s.token);
      if (user.roles.includes("validate")) {
        answers = await backend.myValidations(s.token);
        paintAnswers();
      }
      say("");
    } catch (e) {
      handleError(e);
    }
    render();
    activateMode();
  }
  function doSignOut() {
    deactivate();
    signOut();
    session = null;
    user = null;
    answers = {};
    paintAnswers();
    message = "Signed out.";
    render();
  }
  function handleError(e: unknown) {
    if (e instanceof BackendError && (e.code === "auth" || e.code === "expired")) {
      signOut();
      session = null;
      user = null;
      say("Your sign-in expired. Please sign in again.");
      render();
      return;
    }
    say(e instanceof Error ? e.message : String(e));
  }

  // ---------- mode switching ----------
  let active = false;
  function setMode(m: Mode) {
    deactivate();
    mode = m;
    message = "";
    render();
    activateMode();
  }
  /** Turn on the current mode's map interaction (called when the Contribute view is shown). */
  function activateMode() {
    if (!user || user.pending || !visible) return;
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
        await backend.validate(session!.token, { pid, site, answer, naip_year: year, composite: host.composite() });
        answers[pid] = answer;
        map.setFeatureState({ source: "labels", sourceLayer: "labels", id: pid }, { answer });
        say(`Saved: ${pid} marked "${ANSWERS.find((a) => a.value === answer)!.label}".`);
        renderValidate();
        popup?.remove();
      } catch (e) {
        box.querySelectorAll("button").forEach((b) => (b.disabled = false));
        handleError(e);
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
  const draftKey = (site: string) => `${DRAFT_PREFIX}.${user?.email ?? "anon"}.${site}`;

  function siteValidation(feature: { geometry: GeoJSON.Geometry }) {
    const site = drawSite ? host.extentOf(drawSite) : null;
    if (feature.geometry.type !== "Polygon" || !site) return { valid: false, reason: "Not a polygon" };
    if (!polygonInside(feature.geometry, site)) return { valid: false, reason: "Outside the site" };
    return ValidateNotSelfIntersecting(feature as never);
  }

  function ensureDraw() {
    if (draw) return draw;
    const polygonStyle = {
      fillColor: "#ff9100", fillOpacity: 0.15, outlineColor: "#ff9100", outlineWidth: 2,
      closingPointColor: "#ffffff", closingPointOutlineColor: "#ff9100",
    } as const;
    draw = new TerraDraw({
      adapter: new TerraDrawMapLibreGLAdapter({ map }),
      modes: [
        new TerraDrawPolygonMode({ styles: polygonStyle, validation: (f) => siteValidation(f) }),
        new TerraDrawSelectMode({
          flags: {
            polygon: {
              feature: {
                draggable: true,
                validation: (f) => siteValidation(f),
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
    try {
      localStorage.setItem(draftKey(drawSite), JSON.stringify(polygons()));
    } catch {
      /* storage unavailable: the draft lasts for this page view */
    }
  }
  function loadDraft(site: string) {
    let saved: GeoJSON.Polygon[] = [];
    try {
      saved = JSON.parse(localStorage.getItem(draftKey(site)) ?? "[]");
    } catch {
      saved = [];
    }
    if (saved.length) {
      draw!.addFeatures(
        saved.map((geometry) => ({ id: crypto.randomUUID(), type: "Feature", geometry, properties: { mode: "polygon" } })),
      );
    }
  }

  function startDrawing() {
    const s = host.site();
    if (!s) {
      renderDraw();
      return;
    }
    // Label on the most recent imagery available for this site.
    const latest = host.latestYear(s.id);
    if (latest && latest !== host.year()) host.setYear(latest);
    const d = ensureDraw();
    if (drawSite !== s.id) {
      saveDraft();
      d.clear();
      drawSite = s.id;
      loadDraft(s.id);
    }
    host.setDrawing(true);
    d.setMode("polygon");
    renderDraw();
  }
  function stopDrawing() {
    if (!draw) return;
    saveDraft();
    draw.setMode("static");
    host.setDrawing(false);
  }

  function updateDrawCount() {
    const el = root.querySelector("#draw-count");
    if (el) {
      const n = polygons().length;
      el.textContent = `${n} polygon${n === 1 ? "" : "s"} drawn · draft saved in this browser`;
    }
    root.querySelectorAll<HTMLButtonElement>("[data-needs-polys]").forEach((b) => (b.disabled = !polygons().length));
  }

  function renderDraw() {
    const body = root.querySelector("#contrib-body");
    if (!body) return;
    const s = host.site();
    if (!s) {
      body.innerHTML = `<p><b>Select a site first</b> (in the Sites tab, or by clicking one on the map). Drawing is limited to the 1,000 TreeFinder sites.</p>`;
      return;
    }
    const tool = draw?.getMode() ?? "static";
    body.innerHTML = `
      <p class="draw-site">Site <b>${esc(s.id)}</b> · NAIP ${host.year()}</p>
      <div class="draw-tools" role="toolbar" aria-label="Drawing tools">
        <button type="button" data-tool="polygon" aria-pressed="${tool === "polygon"}">Draw</button>
        <button type="button" data-tool="select" aria-pressed="${tool === "select"}">Edit</button>
        <button type="button" data-act="clear" data-needs-polys>Clear all</button>
      </div>
      <p class="muted small">Click to add corners; click the first corner or press <kbd>Enter</kbd> to finish, <kbd>Esc</kbd> to cancel.
        In Edit, drag corners or the shape; select a polygon and press <kbd>Delete</kbd> to remove it. Polygons must stay inside the site.</p>
      <p id="draw-count" class="draw-count"></p>
      <button type="button" class="contrib-btn" data-act="download" data-needs-polys>Download GeoJSON</button>
      <h3>Upload</h3>
      <div id="dropzone" class="dropzone" tabindex="0" role="button" aria-label="Upload a GeoJSON file: drop it here or press Enter to choose a file">
        Drop a downloaded <b>.geojson</b> file here, or <u>choose a file</u>
        <input id="upload-file" type="file" accept=".geojson,.json,application/geo+json,application/json" hidden />
      </div>
      <button type="button" class="contrib-btn primary" data-act="upload-current" data-needs-polys>Upload current drawing</button>`;
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
    body.querySelector<HTMLButtonElement>("[data-act=upload-current]")!.onclick = () => {
      const fc = buildExport(polygons(), { site: s.id, naip_year: host.year(), annotator: user!.email });
      uploadText(exportFileName(s.id, user!.email), JSON.stringify(fc));
    };
    const zone = body.querySelector<HTMLElement>("#dropzone")!;
    const input = body.querySelector<HTMLInputElement>("#upload-file")!;
    zone.onclick = () => input.click();
    zone.onkeydown = (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), input.click());
    input.onchange = () => input.files?.[0] && uploadFile(input.files[0]);
    zone.ondragover = (e) => {
      e.preventDefault();
      zone.classList.add("over");
    };
    zone.ondragleave = () => zone.classList.remove("over");
    zone.ondrop = (e) => {
      e.preventDefault();
      zone.classList.remove("over");
      const f = e.dataTransfer?.files[0];
      if (f) uploadFile(f);
    };
    updateDrawCount();
  }

  function downloadCurrent() {
    const s = host.site()!;
    const fc = buildExport(polygons(), { site: s.id, naip_year: host.year(), annotator: user!.email });
    const url = URL.createObjectURL(new Blob([JSON.stringify(fc, null, 1)], { type: "application/geo+json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: exportFileName(s.id, user!.email) });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say(`Downloaded ${a.download}. Upload it below to share it with the team.`);
  }
  async function uploadFile(file: File) {
    uploadText(file.name, await file.text());
  }
  async function uploadText(fileName: string, text: string) {
    let checked;
    try {
      checked = checkUpload(text, host.extentOf);
    } catch (e) {
      say(`Can't upload ${fileName}: ${(e as Error).message}`);
      return;
    }
    say(`Uploading ${fileName}…`);
    try {
      const r = await backend.upload(session!.token, fileName, checked.site, checked.content);
      say(`Uploaded ${r.features} polygon${r.features === 1 ? "" : "s"} for ${checked.site} as ${r.fileName}. Thank you!`);
    } catch (e) {
      handleError(e);
    }
  }

  // ---------- visibility (Contribute view shown or hidden) ----------
  let visible = false;
  function show(on: boolean) {
    visible = on;
    if (on) activateMode();
    else deactivate();
  }

  // A session from earlier in this tab: restore it quietly.
  if (session) onSignIn(session);
  else render();

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
