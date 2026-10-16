/**
 * TreeFinder contribution service (Google Apps Script web app).
 *
 * Bound to a Google Sheet with the tabs below (run `setup` once to create them):
 *   Contributors  email | name | roles | active      roles: "validate", "annotate" or "validate, annotate"
 *   Requests      requested_at | email | name        sign-ins from accounts not on the list
 *   Validations   time | email | site | pid | answer | naip_year | composite
 *   Uploads       time | email | site | file_name | drive_file_id | features | bytes
 *
 * Script properties (Project Settings → Script properties):
 *   CLIENT_ID   the OAuth web client ID used by the site's Google sign-in
 *   FOLDER_ID   the shared Drive folder that receives uploaded GeoJSON files
 *
 * Deploy → New deployment → Web app: "Execute as: Me", "Who has access: Anyone".
 * "Anyone" only means the URL is reachable; every request must carry a valid Google ID token
 * for CLIENT_ID, and only active, listed contributors can write.
 */

const MAX_BYTES = 2000000; // mirrored in web/src/contribute/config.ts
const MAX_FEATURES = 2000;
const ANSWERS = ["dead", "not_dead", "unsure"];
const SITE_RE = /^[A-Z]{2}_\d{3}$/;
const PID_RE = /^[A-Z]{2}_\d{3}-\d{3}$/;
const TABS = {
  Contributors: ["email", "name", "roles", "active"],
  Requests: ["requested_at", "email", "name"],
  Validations: ["time", "email", "site", "pid", "answer", "naip_year", "composite"],
  Uploads: ["time", "email", "site", "file_name", "drive_file_id", "features", "bytes"],
};

/** Run once from the editor: creates the tabs with header rows. */
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
    const user = verify_(req.idToken);
    const who = contributor_(user);
    switch (req.action) {
      case "whoami":
        return json_({ ok: true, user: who });
      case "validate":
        need_(who, "validate");
        return json_(saveValidation_(who, req));
      case "myValidations":
        need_(who, "validate");
        return json_({ ok: true, answers: myValidations_(who.email) });
      case "upload":
        need_(who, "annotate");
        return json_(saveUpload_(who, req));
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
  const rows = rows_("Contributors");
  const row = rows.find((r) => String(r.email).trim().toLowerCase() === user.email);
  const active = row && (row.active === true || String(row.active).toUpperCase() === "TRUE");
  if (!active) {
    recordRequest_(user);
    return { email: user.email, name: user.name, roles: [], pending: true };
  }
  const roles = String(row.roles)
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s === "validate" || s === "annotate");
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

// ---------- uploads ----------
function saveUpload_(who, req) {
  const content = String(req.content || "");
  const bytes = Utilities.newBlob(content).getBytes().length;
  if (bytes > MAX_BYTES) throw fail_("The file is larger than 2 MB.", "bad_request");
  let fc;
  try {
    fc = JSON.parse(content);
  } catch (e) {
    throw fail_("The file is not valid JSON.", "bad_request");
  }
  if (!fc || fc.type !== "FeatureCollection" || !Array.isArray(fc.features) || !fc.features.length) {
    throw fail_("Expected a GeoJSON FeatureCollection with at least one polygon.", "bad_request");
  }
  if (fc.features.length > MAX_FEATURES) throw fail_("Too many polygons in one file.", "bad_request");
  if (!SITE_RE.test(req.site)) throw fail_("Unknown site.", "bad_request");
  fc.features.forEach((f, i) => {
    if (!f || !f.geometry || f.geometry.type !== "Polygon") throw fail_("Feature " + (i + 1) + " is not a polygon.", "bad_request");
  });

  const stamp = Utilities.formatDate(new Date(), "UTC", "yyyyMMdd-HHmmss");
  const name = req.site + "_" + who.email.replace(/[^a-z0-9]+/gi, "_") + "_" + stamp + ".geojson";
  const folder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty("FOLDER_ID"));
  const file = folder.createFile(name, content, "application/geo+json");
  file.setDescription("TreeFinder upload by " + who.email + " (original name: " + String(req.fileName || "").slice(0, 200) + ")");
  withLock_(() => {
    sheet_("Uploads").appendRow([new Date(), who.email, req.site, name, file.getId(), fc.features.length, bytes]);
  });
  return { ok: true, fileName: name, features: fc.features.length };
}

// ---------- helpers ----------
function sheet_(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw fail_("The service is not set up (missing tab " + name + ").", "setup");
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
