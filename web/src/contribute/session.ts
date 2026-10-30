// Sign-in state shared by the Contribute and Review tabs.
import { currentSession, renderSignIn, signOut as clearToken, type Session } from "./auth";
import { backend, BackendError, type Contributor, type Role } from "./backend";
import { DEMO_MODE } from "./config";

type Listener = () => void;

export const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

class SessionStore {
  session: Session | null = currentSession();
  user: Contributor | null = null;
  message = "";
  private listeners = new Set<Listener>();
  private checking: Promise<void> | null = null;

  constructor() {
    // A sign-in from earlier in this tab: restore it quietly.
    if (this.session) this.checking = this.signIn(this.session);
  }

  get token() {
    return this.session?.token ?? "";
  }
  has(role: Role) {
    return Boolean(this.user && !this.user.pending && this.user.roles.includes(role));
  }
  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    this.listeners.forEach((fn) => fn());
  }
  ready() {
    return this.checking ?? Promise.resolve();
  }

  async signIn(s: Session) {
    this.session = s;
    this.message = "Checking your contributor access…";
    this.emit();
    try {
      this.user = await backend.whoami(s.token);
      this.message = "";
    } catch (e) {
      this.fail(e);
    }
    this.emit();
  }
  signOut() {
    clearToken();
    this.session = null;
    this.user = null;
    this.message = "Signed out.";
    this.emit();
  }
  /** Turn an error into a message; an expired sign-in signs the user out. */
  fail(e: unknown): string {
    if (e instanceof BackendError && (e.code === "auth" || e.code === "expired")) {
      clearToken();
      this.session = null;
      this.user = null;
      this.message = "Your sign-in expired. Please sign in again.";
      this.emit();
      return this.message;
    }
    return e instanceof Error ? e.message : String(e);
  }
}

export const store = new SessionStore();

export const demoNote = () =>
  DEMO_MODE
    ? `<p class="contrib-demo" role="note"><b>Demo mode.</b> The contribution service isn't connected yet, so sign-in is simulated and everything stays in this browser.</p>`
    : "";

/** Signed-in banner with a sign-out link. */
export function userBlock(): string {
  const u = store.user!;
  return `<p class="contrib-user">Signed in as <b>${esc(u.name)}</b><br><span class="muted">${esc(u.email)}</span>
    <button type="button" class="contrib-link" data-signout>Sign out</button></p>`;
}
export function wireSignOut(root: HTMLElement) {
  root.querySelector<HTMLButtonElement>("[data-signout]")?.addEventListener("click", () => store.signOut());
}

/** Fill `slot` with the sign-in button (Google, or the demo stand-in). */
export function mountSignIn(slot: HTMLElement, onError: (msg: string) => void) {
  renderSignIn(slot, (s) => store.signIn(s)).catch((e) => onError(String(e.message ?? e)));
}
