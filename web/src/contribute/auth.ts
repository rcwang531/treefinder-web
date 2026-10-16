// Google sign-in (Google Identity Services). The ID token (a signed JWT) is what the backend
// verifies; the profile decoded here is only for display.
import { DEMO_MODE, GOOGLE_CLIENT_ID } from "./config";

const TOKEN_KEY = "treefinder.idToken";
const GIS_SRC = "https://accounts.google.com/gsi/client";

interface GoogleId {
  initialize(options: { client_id: string; callback: (r: { credential: string }) => void; auto_select?: boolean }): void;
  renderButton(el: HTMLElement, options: Record<string, string | number>): void;
  disableAutoSelect(): void;
}
declare global {
  interface Window {
    google?: { accounts: { id: GoogleId } };
  }
}

export interface Session {
  token: string;
  email: string;
  name: string;
  /** Expiry in ms since epoch. */
  exp: number;
}

function decode(token: string): Session | null {
  try {
    const p = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return { token, email: p.email, name: p.name ?? p.email, exp: p.exp * 1000 };
  } catch {
    return null;
  }
}

/** The current session, if one exists and has more than a minute left. */
export function currentSession(): Session | null {
  if (DEMO_MODE) {
    const t = sessionStorage.getItem(TOKEN_KEY);
    return t === "demo" ? { token: "demo", email: "demo@treefinder.local", name: "Demo contributor", exp: Infinity } : null;
  }
  const t = sessionStorage.getItem(TOKEN_KEY);
  const s = t ? decode(t) : null;
  return s && s.exp - Date.now() > 60_000 ? s : null;
}

export function signOut() {
  sessionStorage.removeItem(TOKEN_KEY);
  window.google?.accounts.id.disableAutoSelect();
}

let gisLoading: Promise<void> | null = null;
function loadGis(): Promise<void> {
  gisLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load Google sign-in."));
    document.head.append(s);
  });
  return gisLoading;
}

/** Render a sign-in button into `el`; `onSignIn` fires with the new session. */
export async function renderSignIn(el: HTMLElement, onSignIn: (s: Session) => void) {
  if (DEMO_MODE) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "contrib-btn primary";
    b.textContent = "Sign in (demo)";
    b.onclick = () => {
      sessionStorage.setItem(TOKEN_KEY, "demo");
      onSignIn(currentSession()!);
    };
    el.replaceChildren(b);
    return;
  }
  await loadGis();
  const id = window.google!.accounts.id;
  id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: ({ credential }) => {
      sessionStorage.setItem(TOKEN_KEY, credential);
      const s = decode(credential);
      if (s) onSignIn(s);
    },
  });
  id.renderButton(el, { type: "standard", theme: "outline", size: "large", text: "signin_with", shape: "pill" });
}
