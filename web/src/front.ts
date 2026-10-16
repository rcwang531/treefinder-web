import "./tokens.css";
import "./front.css";

// Links shared before the front page existed pointed at the map's hash state (#s=…, #map=…).
// Send those straight to the map with the same state.
if (/(^|[#&])(s|map|y|t|about)=/.test(location.hash)) {
  location.replace(`map.html${location.hash}`);
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

// ---- hero background: a slow cross-fade between labeled sites, pausable (WCAG 2.2.2) ----
const slides = [...document.querySelectorAll<HTMLImageElement>(".hero-bg img")];
const caption = $("#hero-caption");
const pause = $<HTMLButtonElement>("#hero-pause");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
let current = 0;
let timer = 0;

function show(i: number) {
  const img = slides[i];
  if (img.dataset.src && !img.src) img.src = img.dataset.src;
  const swap = () => {
    slides[current].classList.remove("active");
    img.classList.add("active");
    caption.textContent = img.dataset.caption ?? "";
    current = i;
  };
  if (img.complete && img.naturalWidth) swap();
  else img.addEventListener("load", swap, { once: true });
}
function play() {
  clearInterval(timer);
  timer = window.setInterval(() => show((current + 1) % slides.length), 8000);
  pause.setAttribute("aria-pressed", "false");
  pause.setAttribute("aria-label", "Pause background slideshow");
  pause.textContent = "❚❚";
}
function stop() {
  clearInterval(timer);
  pause.setAttribute("aria-pressed", "true");
  pause.setAttribute("aria-label", "Play background slideshow");
  pause.textContent = "▶";
}
pause.addEventListener("click", () => (pause.getAttribute("aria-pressed") === "true" ? play() : stop()));
if (reduceMotion || slides.length < 2) stop();
else {
  // Fetch the next background after the page has settled.
  addEventListener("load", () => {
    const next = slides[1];
    if (next.dataset.src) next.src = next.dataset.src;
  });
  play();
}

// ---- nav: mark the section in view ----
const navLinks = new Map(
  [...document.querySelectorAll<HTMLAnchorElement>(".site-nav nav a[href^='#']")].map((a) => [a.hash.slice(1), a]),
);
const sectionObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      navLinks.forEach((l) => l.removeAttribute("aria-current"));
      navLinks.get(e.target.id)?.setAttribute("aria-current", "true");
    }
  },
  { rootMargin: "-45% 0px -50% 0px" }, // a section counts as current when it crosses mid-screen
);
for (const id of navLinks.keys()) {
  const el = document.getElementById(id);
  if (el) sectionObserver.observe(el);
}

// ---- citation ----
$("#copy-bib").addEventListener("click", async () => {
  const btn = $("#copy-bib");
  try {
    await navigator.clipboard.writeText($("#bibtex").textContent!);
    btn.textContent = "Copied";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = "Copy BibTeX"), 1500);
});
