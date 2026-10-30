// Contributor backend settings. Both values are public by design (they ship in the page);
// access control happens in the Apps Script, which checks the Google ID token and the
// approved-contributor list. See contribute/README.md for how to obtain them.
//
// Leave either empty to run in demo mode: sign-in is simulated and nothing leaves the browser.
export const GOOGLE_CLIENT_ID = "";
export const APPS_SCRIPT_URL = "";

export const DEMO_MODE = !GOOGLE_CLIENT_ID || !APPS_SCRIPT_URL;

/** Upload limits, mirrored in the Apps Script. */
export const MAX_UPLOAD_BYTES = 2_000_000;
export const MAX_UPLOAD_FEATURES = 2_000;
