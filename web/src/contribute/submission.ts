// File formats for contributions: a site file (where the annotated square is), an annotation
// file (the drawn polygons) and a review file. All are GeoJSON FeatureCollections with a
// top-level "treefinder" block; the submission ID ties them together.
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_FEATURES } from "./config";
import { areaM2, polygonInside } from "./geo";

export type Verdict = "correct" | "incorrect" | "needs_edit";

export interface SiteMeta {
  schema: 1;
  kind: "site";
  submission_id: string;
  site_id: string;
  moved: boolean;
  offset_m: [number, number];
  size_m: [number, number];
  naip_year: number;
  annotator: string;
  created_at: string;
}
export interface AnnotationMeta {
  schema: 1;
  kind: "annotation";
  submission_id: string;
  site_id: string;
  naip_year: number;
  annotator: string;
  exported_at: string;
  label: "dead_tree";
  /** The site square, repeated so the annotation file is usable on its own. */
  site_frame: GeoJSON.Polygon;
}
export interface ReviewMeta {
  schema: 1;
  kind: "review";
  submission_id: string;
  reviewer: string;
  decision: string;
  comment: string;
  reviewed_at: string;
}
type FC<M> = GeoJSON.FeatureCollection<GeoJSON.Polygon> & { treefinder: M };
export type SiteFile = FC<SiteMeta>;
export type AnnotationFile = FC<AnnotationMeta>;
export type ReviewFile = FC<ReviewMeta>;

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
// The contributor part of IDs and file names; the backend accepts up to 40 of [a-z0-9_].
const who = (email: string) => email.split("@")[0].replace(/[^a-z0-9]+/gi, "_").toLowerCase().slice(0, 40);

export function newSubmissionId(site: string, email: string) {
  return `${site}-${who(email)}-${stamp()}`;
}
export function fileName(id: string, kind: "site" | "annotation" | "review", reviewer?: string) {
  return `TreeFinder_${id}_${kind}${reviewer ? `_${who(reviewer)}` : ""}.geojson`;
}

export function buildSite(o: {
  id: string;
  site_id: string;
  frame: GeoJSON.Polygon;
  moved: boolean;
  offset_m: [number, number];
  size_m: [number, number];
  naip_year: number;
  annotator: string;
}): SiteFile {
  const meta: SiteMeta = {
    schema: 1,
    kind: "site",
    submission_id: o.id,
    site_id: o.site_id,
    moved: o.moved,
    offset_m: [Math.round(o.offset_m[0]), Math.round(o.offset_m[1])],
    size_m: [Math.round(o.size_m[0]), Math.round(o.size_m[1])],
    naip_year: o.naip_year,
    annotator: o.annotator,
    created_at: new Date().toISOString(),
  };
  return {
    type: "FeatureCollection",
    treefinder: meta,
    features: [{
      type: "Feature",
      properties: { submission_id: o.id, site_id: o.site_id, moved: o.moved, naip_year: o.naip_year, offset_m: meta.offset_m },
      geometry: o.frame,
    }],
  };
}

export function buildAnnotation(polys: GeoJSON.Polygon[], site: SiteFile): AnnotationFile {
  const m = site.treefinder;
  return {
    type: "FeatureCollection",
    treefinder: {
      schema: 1,
      kind: "annotation",
      submission_id: m.submission_id,
      site_id: m.site_id,
      naip_year: m.naip_year,
      annotator: m.annotator,
      exported_at: new Date().toISOString(),
      label: "dead_tree",
      site_frame: site.features[0].geometry,
    },
    features: polys.map((geometry, i) => ({
      type: "Feature",
      properties: {
        id: `${m.submission_id}-${String(i + 1).padStart(3, "0")}`,
        site_id: m.site_id,
        naip_year: m.naip_year,
        label: "dead_tree",
        area_m2: +areaM2(geometry).toFixed(2),
      },
      geometry,
    })),
  };
}

export interface ReviewMark {
  verdict: Verdict;
  comment: string;
}
export function buildReview(
  annotation: AnnotationFile,
  marks: Record<string, ReviewMark>,
  added: GeoJSON.Polygon[],
  meta: { reviewer: string; decision: string; comment: string },
): ReviewFile {
  const id = annotation.treefinder.submission_id;
  return {
    type: "FeatureCollection",
    treefinder: { schema: 1, kind: "review", submission_id: id, ...meta, reviewed_at: new Date().toISOString() },
    features: [
      ...annotation.features.map((f) => ({
        ...f,
        properties: {
          ...f.properties,
          review_verdict: marks[f.properties!.id]?.verdict ?? null,
          review_comment: marks[f.properties!.id]?.comment ?? "",
        },
      })),
      ...added.map((geometry, i) => ({
        type: "Feature" as const,
        properties: {
          id: `${id}-r${String(i + 1).padStart(3, "0")}`,
          added_by_reviewer: true,
          label: "dead_tree",
          area_m2: +areaM2(geometry).toFixed(2),
        },
        geometry,
      })),
    ],
  };
}

export function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/geo+json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- checking uploaded files ----------
function parse(text: string, name: string) {
  if (new Blob([text]).size > MAX_UPLOAD_BYTES) throw new Error(`${name} is larger than 2 MB.`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name} is not a valid JSON file.`);
  }
}

function checkAnnotation(a: AnnotationFile, frame: GeoJSON.Polygon) {
  if (a?.type !== "FeatureCollection" || !Array.isArray(a.features)) throw new Error("The annotation is not a GeoJSON FeatureCollection.");
  if (!a.features.length) throw new Error("The annotation has no polygons.");
  if (a.features.length > MAX_UPLOAD_FEATURES) throw new Error(`The annotation has more than ${MAX_UPLOAD_FEATURES} polygons.`);
  a.features.forEach((f, i) => {
    if (f.geometry?.type !== "Polygon") throw new Error(`Feature ${i + 1} is not a polygon.`);
    if (!polygonInside(f.geometry, frame)) throw new Error(`Polygon ${i + 1} reaches outside the site square.`);
  });
}

/**
 * Turn dropped files into a submission: either both files from a download, or just the
 * annotation file (its site square is embedded, so the site file can be rebuilt).
 */
export function readSubmission(files: { name: string; text: string }[], knownSite: (id: string) => boolean) {
  let site: SiteFile | null = null;
  let annotation: AnnotationFile | null = null;
  for (const f of files) {
    const j = parse(f.text, f.name);
    if (j?.treefinder?.kind === "site") site = j;
    else if (j?.treefinder?.kind === "annotation") annotation = j;
    else throw new Error(`${f.name} is not a TreeFinder site or annotation file.`);
  }
  if (!annotation) throw new Error("Add the annotation file (…_annotation.geojson).");
  const m = annotation.treefinder;
  if (!knownSite(m.site_id)) throw new Error(`Unknown TreeFinder site ${m.site_id}.`);
  if (site && site.treefinder.submission_id !== m.submission_id) {
    throw new Error("The site file and the annotation file belong to different submissions.");
  }
  site ??= {
    type: "FeatureCollection",
    treefinder: {
      schema: 1, kind: "site", submission_id: m.submission_id, site_id: m.site_id, moved: false, offset_m: [0, 0],
      size_m: [0, 0], naip_year: m.naip_year, annotator: m.annotator, created_at: m.exported_at,
    },
    features: [{ type: "Feature", properties: { submission_id: m.submission_id, site_id: m.site_id }, geometry: m.site_frame }],
  };
  checkAnnotation(annotation, site.features[0].geometry);
  return { site, annotation };
}
