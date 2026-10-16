// Client for the contributor backend (contribute/apps-script/Code.gs), plus a demo stand-in.
import { APPS_SCRIPT_URL, DEMO_MODE } from "./config";

export type Role = "validate" | "annotate";
export type Answer = "dead" | "not_dead" | "unsure";

export interface Contributor {
  email: string;
  name: string;
  roles: Role[];
  /** Signed in but not on the approved list yet (an access request was recorded). */
  pending: boolean;
}

export interface ValidationInput {
  pid: string;
  site: string;
  answer: Answer;
  naip_year: number;
  composite: string;
}

export interface UploadResult {
  fileName: string;
  features: number;
}

export class BackendError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

export interface Backend {
  whoami(token: string): Promise<Contributor>;
  validate(token: string, v: ValidationInput): Promise<void>;
  myValidations(token: string): Promise<Record<string, Answer>>;
  upload(token: string, fileName: string, site: string, content: string): Promise<UploadResult>;
}

// ---- Apps Script web app ----
// Requests are sent as text/plain so the browser skips the CORS preflight, which Apps Script
// web apps can't answer; the body is still JSON.
async function call<T>(action: string, token: string, payload: object = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, idToken: token, ...payload }),
      redirect: "follow",
    });
  } catch {
    throw new BackendError("Could not reach the TreeFinder contribution service.", "network");
  }
  const data = (await res.json().catch(() => null)) as ({ ok: boolean; error?: string; code?: string } & T) | null;
  if (!data) throw new BackendError("Unexpected response from the contribution service.", "bad_response");
  if (!data.ok) throw new BackendError(data.error ?? "Request failed.", data.code ?? "error");
  return data;
}

const remote: Backend = {
  async whoami(token) {
    return (await call<{ user: Contributor }>("whoami", token)).user;
  },
  async validate(token, v) {
    await call("validate", token, v);
  },
  async myValidations(token) {
    return (await call<{ answers: Record<string, Answer> }>("myValidations", token)).answers;
  },
  async upload(token, fileName, site, content) {
    return call<UploadResult>("upload", token, { fileName, site, content });
  },
};

// ---- demo: everything stays in this browser ----
const DEMO_KEY = "treefinder.demo.validations";
function readDemo(): Record<string, Answer> {
  try {
    return JSON.parse(localStorage.getItem(DEMO_KEY) ?? "{}");
  } catch {
    return {};
  }
}
const demo: Backend = {
  async whoami() {
    return { email: "demo@treefinder.local", name: "Demo contributor", roles: ["validate", "annotate"], pending: false };
  },
  async validate(_token, v) {
    const all = readDemo();
    all[v.pid] = v.answer;
    try {
      localStorage.setItem(DEMO_KEY, JSON.stringify(all));
    } catch {
      /* storage unavailable: answers last for this page view only */
    }
  },
  async myValidations() {
    return readDemo();
  },
  async upload(_token, fileName, _site, content) {
    const features = (JSON.parse(content) as GeoJSON.FeatureCollection).features.length;
    return { fileName: `${fileName} (demo: not sent)`, features };
  },
};

export const backend: Backend = DEMO_MODE ? demo : remote;
