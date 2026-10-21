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

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ---- gallery: built from assets/gallery/gallery.json (see web/scripts/make_gallery.py) ----
interface GalleryItem {
  file: string;
  site: string;
  year: number;
  state: string;
  polygons: number;
  area_m2: number;
  width: number;
  height: number;
}
fetch("assets/gallery/gallery.json")
  .then((r) => (r.ok ? r.json() : []))
  .then((items: GalleryItem[]) => {
    $("#gallery").innerHTML = items
      .map(
        (g) => `<li><a class="site-card" href="map.html#y=${g.year}&amp;s=${esc(g.site)}">
          <img src="assets/gallery/${esc(g.file)}" alt="NAIP ${g.year} aerial view of site ${esc(g.site)} in ${esc(g.state)} with ${g.polygons} dead-tree polygons outlined" loading="lazy" width="${g.width}" height="${g.height}" />
          <span class="site-card-text"><b>${esc(g.site)}</b> ${esc(g.state)} · ${g.polygons} dead trees · ${g.area_m2.toLocaleString()} m²</span>
        </a></li>`,
      )
      .join("");
  })
  .catch(() => ($("#explore").querySelector(".intro")!.textContent = "Open the map to explore all labeled sites."));

// ---- contributors: data/contributors.json ----
interface Person {
  name: string;
  affiliation?: string;
  roles?: string[];
}
fetch("data/contributors.json")
  .then((r) => (r.ok ? r.json() : { contributors: [] }))
  .then(({ contributors }: { contributors: Person[] }) => {
    const box = $("#contributor-list");
    if (!contributors.length) {
      box.innerHTML = `<p class="empty-state">Contributors who label and validate trees will be listed here.
        <a href="#contribute">Be one of the first.</a></p>`;
      return;
    }
    box.innerHTML = `<ul class="people">${contributors
      .map(
        (c) => `<li><b>${esc(c.name)}</b>${c.affiliation ? `<br><span class="muted">${esc(c.affiliation)}</span>` : ""}${
          c.roles?.length ? `<br><span class="roles">${c.roles.map(esc).join(" · ")}</span>` : ""
        }</li>`,
      )
      .join("")}</ul>`;
  })
  .catch(() => undefined);

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
