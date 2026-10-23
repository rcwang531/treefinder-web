// Client for the contributor backend (contribute/apps-script/Code.gs), plus a demo stand-in.
import { APPS_SCRIPT_URL, DEMO_MODE } from "./config";

export type Role = "validate" | "annotate" | "review";
export type Answer = "dead" | "not_dead" | "unsure";
export type Decision = "accepted" | "needs_changes" | "rejected";
export type Status = "pending" | Decision;

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

export interface ReviewSummary {
  reviewer_name: string;
  decision: Decision;
  comment: string;
  time: string;
}

export interface SubmissionSummary {
  id: string;
  /** TreeFinder site ID, or "NEW" for a square the contributor placed. */
  site_id: string;
  placed: boolean;
  annotator: string;
  annotator_name: string;
  created: string;
  naip_year: number;
  polygons: number;
  status: Status;
  reviews: ReviewSummary[];
}

export interface SubmissionDetail extends SubmissionSummary {
  /** File contents (GeoJSON text) as stored. */
  site: string;
  annotation: string;
  reviewFiles: (ReviewSummary & { content: string })[];
}

export interface SubmitInput {
  id: string;
  site_id: string;
  site: string;
  annotation: string;
}

export interface ReviewInput {
  id: string;
  decision: Decision;
  comment: string;
  review: string;
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
  submit(token: string, s: SubmitInput): Promise<SubmissionSummary>;
  mySubmissions(token: string): Promise<SubmissionSummary[]>;
  /** Reviewers only: every submission. */
  listSubmissions(token: string): Promise<SubmissionSummary[]>;
  /** The submitter or a reviewer. */
  getSubmission(token: string, id: string): Promise<SubmissionDetail>;
  saveReview(token: string, r: ReviewInput): Promise<SubmissionSummary>;
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
  async submit(token, s) {
    return (await call<{ submission: SubmissionSummary }>("submit", token, s)).submission;
  },
  async mySubmissions(token) {
    return (await call<{ submissions: SubmissionSummary[] }>("mySubmissions", token)).submissions;
  },
  async listSubmissions(token) {
    return (await call<{ submissions: SubmissionSummary[] }>("listSubmissions", token)).submissions;
  },
  async getSubmission(token, id) {
    return (await call<{ submission: SubmissionDetail }>("getSubmission", token, { id })).submission;
  },
  async saveReview(token, r) {
    return (await call<{ submission: SubmissionSummary }>("saveReview", token, r)).submission;
  },
};

// ---- demo: everything stays in this browser ----
const DEMO_USER: Contributor = {
  email: "demo@treefinder.local",
  name: "Demo contributor",
  roles: ["validate", "annotate", "review"],
  pending: false,
};
function readDemo<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}
function writeDemo(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: demo data lasts for this page view only */
  }
}
const VAL_KEY = "treefinder.demo.validations";
const SUB_KEY = "treefinder.demo.submissions";
type DemoStore = Record<string, SubmissionDetail>;
const summary = ({ site: _s, annotation: _a, reviewFiles: _r, ...rest }: SubmissionDetail): SubmissionSummary => rest;

const demo: Backend = {
  async whoami() {
    return DEMO_USER;
  },
  async validate(_token, v) {
    writeDemo(VAL_KEY, { ...readDemo<Record<string, Answer>>(VAL_KEY, {}), [v.pid]: v.answer });
  },
  async myValidations() {
    return readDemo(VAL_KEY, {});
  },
  async submit(_token, s) {
    const store = readDemo<DemoStore>(SUB_KEY, {});
    const meta = JSON.parse(s.site).treefinder;
    const detail: SubmissionDetail = {
      id: s.id,
      site_id: s.site_id,
      placed: Boolean(meta.placed),
      annotator: DEMO_USER.email,
      annotator_name: DEMO_USER.name,
      created: new Date().toISOString(),
      naip_year: meta.naip_year,
      polygons: JSON.parse(s.annotation).features.length,
      status: "pending",
      reviews: [],
      site: s.site,
      annotation: s.annotation,
      reviewFiles: [],
    };
    store[s.id] = detail;
    writeDemo(SUB_KEY, store);
    return summary(detail);
  },
  async mySubmissions() {
    return Object.values(readDemo<DemoStore>(SUB_KEY, {})).map(summary).reverse();
  },
  async listSubmissions() {
    return Object.values(readDemo<DemoStore>(SUB_KEY, {})).map(summary).reverse();
  },
  async getSubmission(_token, id) {
    const s = readDemo<DemoStore>(SUB_KEY, {})[id];
    if (!s) throw new BackendError("Submission not found.", "not_found");
    return s;
  },
  async saveReview(_token, r) {
    const store = readDemo<DemoStore>(SUB_KEY, {});
    const s = store[r.id];
    if (!s) throw new BackendError("Submission not found.", "not_found");
    const rev = { reviewer_name: DEMO_USER.name, decision: r.decision, comment: r.comment, time: new Date().toISOString() };
    s.reviews.push(rev);
    s.reviewFiles.push({ ...rev, content: r.review });
    s.status = r.decision;
    writeDemo(SUB_KEY, store);
    return summary(s);
  },
};

export const backend: Backend = DEMO_MODE ? demo : remote;
