/**
 * TreeFinder contribution service (Google Apps Script web app).
 *
 * Bound to a Google Sheet with the tabs below (run `setup` once to create them):
 *   Contributors  email | name | roles | active      roles: any of "validate", "annotate", "review"
 *   Requests      requested_at | email | name        sign-ins from accounts not on the list
 *   Validations   time | email | site | pid | answer | naip_year | composite
 *   Submissions   time | id | email | name | site_id | placed | naip_year | polygons | status | folder_id |
 *                 site_file_id | annotation_file_id | reviewed_at
 *   Reviews       time | submission_id | reviewer | reviewer_name | decision | comment | file_id
 *
 * Files go to the Drive folder FOLDER_ID, one folder per contributor and one per submission:
 *   contributions/<contributor>/<submission id>/site.geojson
 *                                              annotation.geojson
 *                                              review_<reviewer>_<UTC time>.geojson
 *
 * Script properties (Project Settings → Script properties):
 *   CLIENT_ID   the OAuth web client ID used by the site's Google sign-in
 *   FOLDER_ID   the shared Drive folder that receives contributions
 *
 * Deploy → New deployment → Web app: "Execute as: Me", "Who has access: Anyone".
 * "Anyone" only means the URL is reachable; every request must carry a valid Google ID token
 * for CLIENT_ID. Only listed, active contributors can write; annotators see only their own
 * submissions, reviewers see all of them.
 */

const MAX_BYTES = 2000000; // per file; mirrored in web/src/contribute/config.ts
const MAX_FEATURES = 2000;
const ANSWERS = ["dead", "not_dead", "unsure"];
const DECISIONS = ["accepted", "needs_changes", "rejected"];
const ROLES = ["validate", "annotate", "review"];
const SITE_RE = /^[A-Z]{2}_\d{3}$/;
const PID_RE = /^[A-Z]{2}_\d{3}-\d{3}$/;
const SUB_RE = /^(?:[A-Z]{2}_\d{3}|NEW)-[a-z0-9_]{1,40}-\d{8}-\d{4}$/; // NEW = a square the contributor placed
const TABS = {
  Contributors: ["email", "name", "roles", "active"],
  Requests: ["requested_at", "email", "name"],
  Validations: ["time", "email", "site", "pid", "answer", "naip_year", "composite"],
  Submissions: ["time", "id", "email", "name", "site_id", "placed", "naip_year", "polygons", "status", "folder_id",
    "site_file_id", "annotation_file_id", "reviewed_at"],
  Reviews: ["time", "submission_id", "reviewer", "reviewer_name", "decision", "comment", "file_id"],
};

/** Run once from the editor: creates the tabs with header rows. Safe to re-run. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(TABS).forEach((name) => {
    const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sheet.getLastRow() === 0) sheet.appendRow(TABS[name]);
    sheet.setFrozenRows(1);
  });
}

function doGet() {
  return json_({ ok: true, service: "TreeFinder contributions" });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const who = contributor_(verify_(req.idToken));
    switch (req.action) {
      case "whoami":
        return json_({ ok: true, user: who });
      case "validate":
        need_(who, "validate");
        return json_(saveValidation_(who, req));
      case "myValidations":
        need_(who, "validate");
        return json_({ ok: true, answers: myValidations_(who.email) });
      case "submit":
        need_(who, "annotate");
        return json_({ ok: true, submission: submit_(who, req) });
      case "mySubmissions":
        need_(who, "annotate");
        return json_({ ok: true, submissions: submissions_((s) => s.email === who.email) });
      case "listSubmissions":
        need_(who, "review");
        return json_({ ok: true, submissions: submissions_(() => true) });
      case "getSubmission":
        return json_({ ok: true, submission: getSubmission_(who, req.id) });
      case "saveReview":
        need_(who, "review");
        return json_({ ok: true, submission: saveReview_(who, req) });
      default:
        throw fail_("Unknown action.", "bad_request");
    }
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err), code: err.code || "error" });
  }
}

// ---------- auth ----------
function verify_(token) {
  if (!token) throw fail_("Please sign in.", "auth");
  const cache = CacheService.getScriptCache();
  const key = "tok_" + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const res = UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token), {
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw fail_("Your sign-in expired. Please sign in again.", "expired");
  const info = JSON.parse(res.getContentText());
  const clientId = PropertiesService.getScriptProperties().getProperty("CLIENT_ID");
  const okIssuer = info.iss === "accounts.google.com" || info.iss === "https://accounts.google.com";
  if (info.aud !== clientId || !okIssuer || String(info.email_verified) !== "true") {
    throw fail_("This sign-in is not valid for TreeFinder.", "auth");
  }
  const user = { email: String(info.email).toLowerCase(), name: info.name || info.email };
  cache.put(key, JSON.stringify(user), 300); // 5 minutes
  return user;
}

function contributor_(user) {
  const row = rows_("Contributors").find((r) => String(r.email).trim().toLowerCase() === user.email);
  const active = row && (row.active === true || String(row.active).toUpperCase() === "TRUE");
  if (!active) {
    recordRequest_(user);
    return { email: user.email, name: user.name, roles: [], pending: true };
  }
  const roles = String(row.roles)
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => ROLES.indexOf(s) >= 0);
  return { email: user.email, name: row.name || user.name, roles: roles, pending: false };
}

function recordRequest_(user) {
  withLock_(() => {
    const seen = rows_("Requests").some((r) => String(r.email).toLowerCase() === user.email);
    if (!seen) sheet_("Requests").appendRow([new Date(), user.email, user.name]);
  });
}

function need_(who, role) {
  if (who.roles.indexOf(role) < 0) throw fail_("Your account is not approved for this yet.", "forbidden");
}

// ---------- validations ----------
function saveValidation_(who, req) {
  if (!PID_RE.test(req.pid) || !SITE_RE.test(req.site) || req.pid.indexOf(req.site + "-") !== 0) {
    throw fail_("Unknown polygon.", "bad_request");
  }
  if (ANSWERS.indexOf(req.answer) < 0) throw fail_("Unknown answer.", "bad_request");
  withLock_(() => {
    sheet_("Validations").appendRow([new Date(), who.email, req.site, req.pid, req.answer, Number(req.naip_year) || "", String(req.composite || "")]);
  });
  return { ok: true };
}

/** The latest answer per polygon for one contributor. */
function myValidations_(email) {
  const answers = {};
  rows_("Validations").forEach((r) => {
    if (String(r.email).toLowerCase() === email) answers[r.pid] = r.answer;
  });
  return answers;
}

// ---------- submissions ----------
function readGeojson_(text, name) {
  const s = String(text || "");
  if (Utilities.newBlob(s).getBytes().length > MAX_BYTES) throw fail_(name + " is larger than 2 MB.", "bad_request");
  let fc;
  try {
    fc = JSON.parse(s);
  } catch (e) {
    throw fail_(name + " is not valid JSON.", "bad_request");
  }
  if (!fc || fc.type !== "FeatureCollection" || !Array.isArray(fc.features) || !fc.treefinder) {
    throw fail_(name + " is not a TreeFinder GeoJSON file.", "bad_request");
  }
  return fc;
}

function inRing_(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function submit_(who, req) {
  if (!SUB_RE.test(req.id) || !(SITE_RE.test(req.site_id) || req.site_id === "NEW") || req.id.indexOf(req.site_id + "-") !== 0) {
    throw fail_("Unknown submission or site.", "bad_request");
  }
  const site = readGeojson_(req.site, "The site file");
  const ann = readGeojson_(req.annotation, "The annotation file");
  if (site.treefinder.kind !== "site" || ann.treefinder.kind !== "annotation") throw fail_("Expected a site file and an annotation file.", "bad_request");
  if (site.treefinder.submission_id !== req.id || ann.treefinder.submission_id !== req.id) throw fail_("The files belong to different submissions.", "bad_request");
  const frame = site.features[0] && site.features[0].geometry;
  if (!frame || frame.type !== "Polygon") throw fail_("The site file has no site square.", "bad_request");
  if (!ann.features.length || ann.features.length > MAX_FEATURES) throw fail_("The annotation needs 1 to " + MAX_FEATURES + " polygons.", "bad_request");
  ann.features.forEach((f, i) => {
    if (!f || !f.geometry || f.geometry.type !== "Polygon") throw fail_("Feature " + (i + 1) + " is not a polygon.", "bad_request");
    const allIn = f.geometry.coordinates.every((r) => r.every((p) => inRing_(p, frame.coordinates[0])));
    if (!allIn) throw fail_("Polygon " + (i + 1) + " reaches outside the site square.", "bad_request");
  });
  if (rows_("Submissions").some((r) => r.id === req.id)) throw fail_("This submission was already received.", "duplicate");

  const folder = subfolder_(subfolder_(subfolder_(rootFolder_(), "contributions"), who.email.replace(/[^a-z0-9]+/gi, "_")), req.id);
  const siteFile = folder.createFile("site.geojson", req.site, "application/geo+json");
  const annFile = folder.createFile("annotation.geojson", req.annotation, "application/geo+json");
  const meta = site.treefinder;
  withLock_(() => {
    sheet_("Submissions").appendRow([new Date(), req.id, who.email, who.name, req.site_id, Boolean(meta.placed), Number(meta.naip_year) || "",
      ann.features.length, "pending", folder.getId(), siteFile.getId(), annFile.getId(), ""]);
  });
  return submissions_((s) => s.id === req.id)[0];
}

/** Submission summaries (newest first) with their reviews, filtered by `keep`. */
function submissions_(keep) {
  const reviews = rows_("Reviews");
  return rows_("Submissions")
    .map((r) => ({ row: r, email: String(r.email).toLowerCase(), id: String(r.id) }))
    .filter(keep)
    .reverse()
    .map((s) => summary_(s.row, reviews));
}

function summary_(r, reviews) {
  return {
    id: String(r.id),
    site_id: String(r.site_id),
    placed: r.placed === true || String(r.placed).toUpperCase() === "TRUE",
    annotator: String(r.email),
    annotator_name: String(r.name),
    created: new Date(r.time).toISOString(),
    naip_year: Number(r.naip_year),
    polygons: Number(r.polygons),
    status: String(r.status || "pending"),
    reviews: reviews
      .filter((v) => String(v.submission_id) === String(r.id))
      .map((v) => ({ reviewer_name: String(v.reviewer_name), decision: String(v.decision), comment: String(v.comment), time: new Date(v.time).toISOString() })),
  };
}

function getSubmission_(who, id) {
  const row = rows_("Submissions").find((r) => String(r.id) === String(id));
  if (!row) throw fail_("Submission not found.", "not_found");
  const own = String(row.email).toLowerCase() === who.email;
  if (!own && who.roles.indexOf("review") < 0) throw fail_("You can only open your own submissions.", "forbidden");
  const reviews = rows_("Reviews").filter((v) => String(v.submission_id) === String(id));
  const s = summary_(row, reviews);
  s.site = DriveApp.getFileById(row.site_file_id).getBlob().getDataAsString();
  s.annotation = DriveApp.getFileById(row.annotation_file_id).getBlob().getDataAsString();
  s.reviewFiles = reviews.map((v) => ({
    reviewer_name: String(v.reviewer_name),
    decision: String(v.decision),
    comment: String(v.comment),
    time: new Date(v.time).toISOString(),
    content: DriveApp.getFileById(v.file_id).getBlob().getDataAsString(),
  }));
  return s;
}

function saveReview_(who, req) {
  if (DECISIONS.indexOf(req.decision) < 0) throw fail_("Choose a decision.", "bad_request");
  const review = readGeojson_(req.review, "The review");
  if (review.treefinder.kind !== "review" || review.treefinder.submission_id !== req.id) throw fail_("The review doesn't match this submission.", "bad_request");
  const sheet = sheet_("Submissions");
  const values = sheet.getDataRange().getValues();
  const head = values[0];
  const idx = values.findIndex((v, i) => i > 0 && String(v[head.indexOf("id")]) === String(req.id));
  if (idx < 1) throw fail_("Submission not found.", "not_found");
  const folder = DriveApp.getFolderById(values[idx][head.indexOf("folder_id")]);
  const stamp = Utilities.formatDate(new Date(), "UTC", "yyyyMMdd-HHmmss");
  const file = folder.createFile("review_" + who.email.replace(/[^a-z0-9]+/gi, "_") + "_" + stamp + ".geojson", req.review, "application/geo+json");
  const comment = String(req.comment || "").slice(0, 2000);
  withLock_(() => {
    sheet_("Reviews").appendRow([new Date(), req.id, who.email, who.name, req.decision, comment, file.getId()]);
    sheet.getRange(idx + 1, head.indexOf("status") + 1).setValue(req.decision);
    sheet.getRange(idx + 1, head.indexOf("reviewed_at") + 1).setValue(new Date());
  });
  return submissions_((s) => s.id === String(req.id))[0];
}

// ---------- helpers ----------
function rootFolder_() {
  return DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty("FOLDER_ID"));
}

function subfolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function sheet_(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw fail_("The service is not set up (missing tab " + name + "). Run setup().", "setup");
  return sheet;
}

function rows_(name) {
  const values = sheet_(name).getDataRange().getValues();
  const head = values.shift() || [];
  return values.map((v) => Object.fromEntries(head.map((h, i) => [h, v[i]])));
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function fail_(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
