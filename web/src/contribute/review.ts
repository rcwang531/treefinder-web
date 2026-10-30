// "Review" tab: reviewers check submitted site squares + annotations, mark each polygon and
// leave comments; annotators see their own submissions with the reviewers' feedback.
import maplibregl from "maplibre-gl";
import { TerraDraw, TerraDrawPolygonMode, TerraDrawSelectMode, ValidateNotSelfIntersecting } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { backend, type Decision, type SubmissionDetail, type SubmissionSummary } from "./backend";
import { polygonInside } from "./geo";
import { demoNote, esc, mountSignIn, store, userBlock, wireSignOut } from "./session";
import {
  buildReview, download, fileName,
  type AnnotationFile, type ReviewFile, type ReviewMark, type SiteFile, type Verdict,
} from "./submission";

export interface ReviewHost {
  map: maplibregl.Map;
  setYear(year: number): void;
  setDrawing(active: boolean): void;
  zoomToBounds(b: [number, number, number, number]): void;
}

const VERDICTS: { value: Verdict; label: string; key: string }[] = [
  { value: "correct", label: "Correct", key: "c" },
  { value: "incorrect", label: "Incorrect", key: "x" },
  { value: "needs_edit", label: "Needs edit", key: "e" },
];
const DECISIONS: { value: Decision; label: string }[] = [
  { value: "accepted", label: "Accept" },
  { value: "needs_changes", label: "Needs changes" },
  { value: "rejected", label: "Reject" },
];
const STATUS_LABEL: Record<string, string> = {
  pending: "Waiting for review",
  accepted: "Accepted",
  needs_changes: "Needs changes",
  rejected: "Rejected",
};
const SRC = "review-polys";
const FRAME_SRC = "review-frame";
const LAYERS = ["review-frame-line", "review-polys-fill", "review-polys-line"];
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export function setupReview(host: ReviewHost, root: HTMLElement) {
  const { map } = host;
  let visible = false;
  let message = "";
  let filter: "pending" | "reviewed" | "all" = "pending";
  let mine: SubmissionSummary[] = [];
  let queue: SubmissionSummary[] = [];
  let open: {
    detail: SubmissionDetail;
    site: SiteFile;
    annotation: AnnotationFile;
    /** This viewer is reviewing (not just reading feedback). */
    reviewing: boolean;
    marks: Record<string, ReviewMark>;
    /** Feedback being shown read-only (the latest review). */
    shown: ReviewFile | null;
  } | null = null;

  store.subscribe(() => {
    close();
    if (visible) load();
    else render();
  });

  function say(t: string) {
    message = t;
    const el = root.querySelector(".contrib-msg");
    if (el) el.textContent = t;
  }

  async function load() {
    render();
    if (!store.user || store.user.pending) return;
    try {
      if (store.has("annotate")) mine = await backend.mySubmissions(store.token);
      if (store.has("review")) queue = await backend.listSubmissions(store.token);
    } catch (e) {
      say(store.fail(e));
    }
    render();
  }

  // ---------- lists ----------
  function item(s: SubmissionSummary, forReview: boolean) {
    const last = s.reviews[s.reviews.length - 1];
    return `<li><button type="button" class="sub-item" data-open="${esc(s.id)}" data-review="${forReview}">
        <span class="sub-title"><b>${s.placed ? "New site" : esc(s.site_id)}</b>${s.placed ? ' <span class="tag">placed</span>' : ""}
          <span class="status status-${esc(s.status)}">${STATUS_LABEL[s.status] ?? esc(s.status)}</span></span>
        <span class="muted small">${s.polygons} polygons · NAIP ${s.naip_year} · ${fmtDate(s.created)}${forReview ? ` · ${esc(s.annotator_name)}` : ""}</span>
        ${last?.comment && !forReview ? `<span class="sub-comment">“${esc(last.comment)}”</span>` : ""}
      </button></li>`;
  }
  function render() {
    if (open) return renderOpen();
    const u = store.user;
    if (!store.session || !u) {
      root.innerHTML = `${demoNote()}<h2>Review</h2>
        <p>Reviewers check submitted annotations here, and contributors see the feedback on their work.</p>
        <div class="signin-slot"></div><p class="contrib-msg" role="status">${esc(store.message || message)}</p>`;
      mountSignIn(root.querySelector(".signin-slot")!, say);
      return;
    }
    if (u.pending) {
      root.innerHTML = `${demoNote()}<h2>Review</h2>${userBlock()}<p>Your account isn't approved yet.</p>`;
      wireSignOut(root);
      return;
    }
    const list = queue.filter((s) => filter === "all" || (filter === "pending" ? s.status === "pending" : s.status !== "pending"));
    root.innerHTML = `${demoNote()}<h2>Review</h2>${userBlock()}
      ${store.has("review") ? `
        <h3>Review queue</h3>
        <div class="contrib-modes" role="radiogroup" aria-label="Show">
          ${(["pending", "reviewed", "all"] as const).map((f) => `<button type="button" role="radio" data-filter="${f}" aria-checked="${filter === f}">${f[0].toUpperCase() + f.slice(1)}</button>`).join("")}
        </div>
        ${list.length ? `<ul class="sub-list">${list.map((s) => item(s, true)).join("")}</ul>` : `<p class="muted small">Nothing here.</p>`}` : ""}
      ${store.has("annotate") ? `
        <h3>My submissions</h3>
        ${mine.length ? `<ul class="sub-list">${mine.map((s) => item(s, false)).join("")}</ul>` : `<p class="muted small">You haven't submitted anything yet. Draw in the Contribute tab.</p>`}` : ""}
      <p class="contrib-msg" role="status" aria-live="polite">${esc(message)}</p>`;
    wireSignOut(root);
    root.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((b) => (b.onclick = () => {
      filter = b.dataset.filter as typeof filter;
      render();
    }));
    root.querySelectorAll<HTMLButtonElement>("[data-open]").forEach((b) => (b.onclick = () => openSubmission(b.dataset.open!, b.dataset.review === "true")));
  }

  // ---------- one submission ----------
  async function openSubmission(id: string, reviewing: boolean) {
    say(`Loading ${id}…`);
    try {
      const detail = await backend.getSubmission(store.token, id);
      const reviews = detail.reviewFiles.map((r) => JSON.parse(r.content) as ReviewFile);
      open = {
        detail,
        site: JSON.parse(detail.site),
        annotation: JSON.parse(detail.annotation),
        reviewing,
        marks: {},
        shown: reviews[reviews.length - 1] ?? null,
      };
      if (reviewing && open.shown) {
        // Continue from the latest review's marks.
        for (const f of open.shown.features) {
          const v = f.properties?.review_verdict as Verdict | null;
          if (v && !f.properties?.added_by_reviewer) open.marks[f.properties!.id] = { verdict: v, comment: f.properties!.review_comment ?? "" };
        }
      }
      message = "";
      showOnMap();
      render();
    } catch (e) {
      say(store.fail(e));
    }
  }

  function features(): GeoJSON.FeatureCollection {
    if (!open) return { type: "FeatureCollection", features: [] };
    const base = open.annotation.features.map((f) => {
      const id = f.properties!.id;
      const fromShown = open!.shown?.features.find((g) => g.properties?.id === id)?.properties;
      const verdict = open!.reviewing ? open!.marks[id]?.verdict : fromShown?.review_verdict;
      return { ...f, properties: { ...f.properties, verdict: verdict ?? "" } };
    });
    // Annotators also see the trees the reviewer added.
    const added = !open.reviewing && open.shown
      ? open.shown.features.filter((f) => f.properties?.added_by_reviewer).map((f) => ({ ...f, properties: { ...f.properties, verdict: "added" } }))
      : [];
    return { type: "FeatureCollection", features: [...base, ...added] };
  }
  function showOnMap() {
    if (!open) return;
    clearMap();
    map.addSource(FRAME_SRC, { type: "geojson", data: open.site.features[0] });
    map.addSource(SRC, { type: "geojson", data: features(), promoteId: "id" });
    map.addLayer({ id: "review-frame-line", type: "line", source: FRAME_SRC, paint: { "line-color": "#b388ff", "line-width": 2.5, "line-dasharray": [2, 1.5] } });
    map.addLayer({ id: "review-polys-fill", type: "fill", source: SRC, paint: { "fill-color": "#000", "fill-opacity": 0 } });
    map.addLayer({
      id: "review-polys-line",
      type: "line",
      source: SRC,
      paint: {
        "line-width": 2.5,
        "line-color": ["match", ["get", "verdict"],
          "correct", "#00e676", "incorrect", "#ff1744", "needs_edit", "#ffc400", "added", "#40c4ff",
          "#ff9100"],
      },
    });
    host.setYear(open.site.treefinder.naip_year);
    const ring = open.site.features[0].geometry.coordinates[0];
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    host.zoomToBounds([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  function refreshMap() {
    (map.getSource(SRC) as maplibregl.GeoJSONSource | undefined)?.setData(features());
  }
  function clearMap() {
    for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of [SRC, FRAME_SRC]) if (map.getSource(id)) map.removeSource(id);
  }
  function close() {
    stopAdding();
    popup?.remove();
    clearMap();
    open = null;
  }

  function renderOpen() {
    const o = open!;
    const m = o.site.treefinder;
    const reviews = o.detail.reviewFiles;
    const marked = Object.keys(o.marks).length;
    const counts = Object.values(o.marks).reduce((a, k) => ((a[k.verdict] = (a[k.verdict] ?? 0) + 1), a), {} as Record<string, number>);
    root.innerHTML = `${demoNote()}
      <button type="button" class="contrib-link back" data-act="back">← All submissions</button>
      <h2>${m.placed ? "New site" : esc(m.site_id)}${m.placed ? ' <span class="tag">placed</span>' : ""}</h2>
      <dl class="sub-meta">
        <dt>Submission</dt><dd>${esc(o.detail.id)}</dd>
        <dt>Annotator</dt><dd>${esc(o.detail.annotator_name)}</dd>
        <dt>Polygons</dt><dd>${o.annotation.features.length} · NAIP ${m.naip_year}</dd>
        <dt>Square</dt><dd>${m.placed ? `${m.size_m[0]} × ${m.size_m[1]} m at ${m.center[1].toFixed(4)}, ${m.center[0].toFixed(4)}` : `TreeFinder site ${esc(m.site_id)}`}</dd>
        <dt>Status</dt><dd><span class="status status-${esc(o.detail.status)}">${STATUS_LABEL[o.detail.status] ?? esc(o.detail.status)}</span></dd>
      </dl>
      <ul class="answer-legend" aria-label="Outline colors">
        <li><i class="sw-review" style="border-color:#ff9100"></i> Not reviewed</li>
        <li><i class="sw-review" style="border-color:#00e676"></i> Correct${o.reviewing ? ` (${counts.correct ?? 0})` : ""}</li>
        <li><i class="sw-review" style="border-color:#ff1744"></i> Incorrect${o.reviewing ? ` (${counts.incorrect ?? 0})` : ""}</li>
        <li><i class="sw-review" style="border-color:#ffc400"></i> Needs edit${o.reviewing ? ` (${counts.needs_edit ?? 0})` : ""}</li>
        <li><i class="sw-review" style="border-color:#40c4ff"></i> Added by reviewer</li>
      </ul>
      ${o.reviewing ? `
        <p>Click each polygon to mark it, and add any dead trees that were missed.
          ${marked}/${o.annotation.features.length} marked.</p>
        <div class="draw-tools" role="toolbar" aria-label="Reviewer drawing">
          <button type="button" data-act="add" aria-pressed="${adding}">${adding ? "Stop adding" : "Add missed tree"}</button>
          <span class="muted small">${addedPolys().length} added</span>
        </div>
        <fieldset class="decision"><legend>Decision</legend>
          ${DECISIONS.map((d) => `<label class="check"><input type="radio" name="decision" value="${d.value}" ${draftDecision === d.value ? "checked" : ""} /> ${d.label}</label>`).join("")}
        </fieldset>
        <label class="comment">Comment for the annotator
          <textarea id="review-comment" rows="3">${esc(draftComment)}</textarea></label>
        <button type="button" class="contrib-btn" data-act="download-review">Download review</button>
        <button type="button" class="contrib-btn primary" data-act="submit-review">Submit review</button>` : `
        <p class="muted small">Click a polygon to read the reviewer's note.</p>`}
      <h3>Reviews</h3>
      ${reviews.length ? `<ul class="review-list">${reviews.map((r, i) => `<li>
          <span class="status status-${esc(r.decision)}">${STATUS_LABEL[r.decision] ?? esc(r.decision)}</span>
          <b>${esc(r.reviewer_name)}</b> · ${fmtDate(r.time)}
          ${r.comment ? `<p>${esc(r.comment)}</p>` : ""}
          <button type="button" class="contrib-link" data-dl="${i}">Download this review</button></li>`).join("")}</ul>`
        : `<p class="muted small">No reviews yet.</p>`}
      <div class="draw-tools"><button type="button" class="contrib-btn" data-act="download-sub">Download site + annotation</button></div>
      <p class="contrib-msg" role="status" aria-live="polite">${esc(message)}</p>`;
    root.querySelector<HTMLButtonElement>("[data-act=back]")!.onclick = () => {
      close();
      load();
    };
    root.querySelector<HTMLButtonElement>("[data-act=download-sub]")!.onclick = () => {
      download(fileName(o.detail.id, "site"), o.site);
      setTimeout(() => download(fileName(o.detail.id, "annotation"), o.annotation), 400);
    };
    root.querySelectorAll<HTMLButtonElement>("[data-dl]").forEach((b) => (b.onclick = () => {
      download(fileName(o.detail.id, "review", reviews[+b.dataset.dl!].reviewer_name), JSON.parse(reviews[+b.dataset.dl!].content));
    }));
    if (!o.reviewing) return;
    root.querySelector<HTMLButtonElement>("[data-act=add]")!.onclick = () => (adding ? stopAdding() : startAdding());
    root.querySelectorAll<HTMLInputElement>("input[name=decision]").forEach((r) => (r.onchange = () => (draftDecision = r.value as Decision)));
    root.querySelector<HTMLTextAreaElement>("#review-comment")!.oninput = (e) => (draftComment = (e.target as HTMLTextAreaElement).value);
    root.querySelector<HTMLButtonElement>("[data-act=download-review]")!.onclick = () => {
      download(fileName(o.detail.id, "review", store.user!.email), currentReview());
    };
    root.querySelector<HTMLButtonElement>("[data-act=submit-review]")!.onclick = submitReview;
  }

  let draftDecision: Decision | "" = "";
  let draftComment = "";
  function currentReview() {
    return buildReview(open!.annotation, open!.marks, addedPolys(), {
      reviewer: store.user!.email,
      decision: draftDecision,
      comment: draftComment.trim(),
    });
  }
  async function submitReview() {
    if (!draftDecision) {
      say("Choose a decision first.");
      return;
    }
    say("Submitting review…");
    try {
      const s = await backend.saveReview(store.token, {
        id: open!.detail.id,
        decision: draftDecision,
        comment: draftComment.trim(),
        review: JSON.stringify(currentReview()),
      });
      say(`Review saved: ${STATUS_LABEL[s.status]}.`);
      draftDecision = "";
      draftComment = "";
      const id = open!.detail.id;
      close();
      await openSubmission(id, true);
      say("Review saved. The annotator can now see it.");
    } catch (e) {
      say(store.fail(e));
    }
  }

  // ---------- marking polygons ----------
  let popup: maplibregl.Popup | null = null;
  function markPolygon(id: string, at: maplibregl.LngLat) {
    popup?.remove();
    const o = open!;
    const box = document.createElement("div");
    box.className = "validate-popup";
    if (!o.reviewing) {
      const p = o.shown?.features.find((f) => f.properties?.id === id)?.properties;
      const v = VERDICTS.find((x) => x.value === p?.review_verdict);
      box.innerHTML = p?.added_by_reviewer
        ? `<p class="vp-q">Added by the reviewer</p><p class="vp-meta">A dead tree that was missed.</p>`
        : `<p class="vp-q">${v ? v.label : "Not reviewed"}</p><p class="vp-meta">${esc(id)}</p>${p?.review_comment ? `<p>${esc(p.review_comment)}</p>` : ""}`;
    } else {
      const cur = o.marks[id];
      box.innerHTML = `<p class="vp-q" id="rv-q">Is this polygon right?</p><p class="vp-meta">${esc(id)}</p>
        <div class="vp-answers" role="group" aria-labelledby="rv-q">${VERDICTS.map(
          (v) => `<button type="button" data-v="${v.value}" aria-pressed="${cur?.verdict === v.value}">${v.label} <kbd>${v.key.toUpperCase()}</kbd></button>`,
        ).join("")}</div>
        <label class="vp-comment">Comment (optional)<textarea rows="2">${esc(cur?.comment ?? "")}</textarea></label>`;
      const ta = box.querySelector("textarea")!;
      const choose = (v: Verdict) => {
        o.marks[id] = { verdict: v, comment: ta.value.trim() };
        refreshMap();
        renderOpen();
        popup?.remove();
      };
      box.querySelectorAll<HTMLButtonElement>("[data-v]").forEach((b) => (b.onclick = () => choose(b.dataset.v as Verdict)));
      ta.addEventListener("keydown", (e) => e.stopPropagation()); // typing must not trigger shortcuts
      const onKey = (e: KeyboardEvent) => {
        if ((e.target as HTMLElement).tagName === "TEXTAREA") return;
        const v = VERDICTS.find((x) => x.key === e.key.toLowerCase());
        if (v && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          choose(v.value);
        }
      };
      document.addEventListener("keydown", onKey);
      popup = new maplibregl.Popup({ maxWidth: "300px", focusAfterOpen: true }).setLngLat(at).setDOMContent(box).addTo(map);
      popup.on("close", () => document.removeEventListener("keydown", onKey));
      return;
    }
    popup = new maplibregl.Popup({ maxWidth: "300px" }).setLngLat(at).setDOMContent(box).addTo(map);
  }

  function handleMapClick(e: maplibregl.MapMouseEvent): boolean {
    if (!visible || !open || adding || !map.getLayer("review-polys-fill")) return false;
    const [f] = map.queryRenderedFeatures(e.point, { layers: ["review-polys-fill"] });
    if (!f?.properties?.id) return false;
    markPolygon(String(f.properties.id), e.lngLat);
    return true;
  }

  // ---------- reviewer adds missed trees ----------
  let td: TerraDraw | null = null;
  let adding = false;
  function addedPolys(): GeoJSON.Polygon[] {
    return (td?.getSnapshot() ?? [])
      .filter((f) => f.geometry.type === "Polygon" && f.properties.mode === "polygon")
      .map((f) => f.geometry as GeoJSON.Polygon);
  }
  function startAdding() {
    if (!open) return;
    if (!td) {
      const inside = (f: { geometry: GeoJSON.Geometry }) =>
        f.geometry.type === "Polygon" && open && polygonInside(f.geometry, open.site.features[0].geometry)
          ? ValidateNotSelfIntersecting(f as never)
          : { valid: false, reason: "Outside the site square" };
      td = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map, prefixId: "td-review" }),
        modes: [
          new TerraDrawPolygonMode({ styles: { fillColor: "#40c4ff", fillOpacity: 0.15, outlineColor: "#40c4ff", outlineWidth: 2 }, validation: inside }),
          new TerraDrawSelectMode({ flags: { polygon: { feature: { draggable: true, validation: inside, coordinates: { draggable: true, deletable: true, midpoints: true } } } } }),
        ],
      });
      td.start();
      td.on("change", () => {
        const el = root.querySelector(".draw-tools .muted");
        if (el) el.textContent = `${addedPolys().length} added`;
      });
    }
    adding = true;
    popup?.remove();
    td.setMode("polygon");
    host.setDrawing(true);
    renderOpen();
  }
  function stopAdding() {
    if (!adding) return;
    adding = false;
    td?.setMode("static");
    host.setDrawing(false);
    if (open) renderOpen();
  }

  // ---------- visibility ----------
  function show(on: boolean) {
    visible = on;
    if (on) {
      if (open) showOnMap();
      load();
    } else {
      stopAdding();
      popup?.remove();
      clearMap();
    }
  }

  render();
  return { show, handleMapClick };
}
