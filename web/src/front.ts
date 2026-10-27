import "./tokens.css";
import "./front.css";

// Links shared before the front page existed pointed at the map's hash state (#s=…, #map=…).
// Send those straight to the map with the same state.
if (/(^|[#&])(s|map|y|t|about)=/.test(location.hash)) {
  location.replace(`map.html${location.hash}`);
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

// ---- hero background: a slow cross-fade through the gallery images, pausable (WCAG 2.2.2) ----
// The first slide is in the HTML; addSlides() appends the rest once gallery.json has loaded.
const heroBg = $(".hero-bg");
const slides = [...heroBg.querySelectorAll<HTMLImageElement>("img")];
const caption = $("#hero-caption");
const pause = $<HTMLButtonElement>("#hero-pause");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
let current = 0;
let timer = 0;

const playing = () => pause.getAttribute("aria-pressed") !== "true";
// Start fetching a slide before it is due, so the cross-fade never waits on the network.
const preload = (img: HTMLImageElement) => {
  if (img.dataset.src && !img.getAttribute("src")) img.src = img.dataset.src;
};

function show(i: number) {
  const img = slides[i];
  preload(img);
  const swap = () => {
    const at = slides.indexOf(img);
    if (!playing() || at < 0 || at === current) return; // paused while the image was still loading
    slides[current].classList.remove("active");
    img.classList.add("active");
    caption.textContent = img.dataset.caption ?? "";
    current = at;
    preload(slides[(at + 1) % slides.length]);
  };
  if (img.complete && img.naturalWidth) swap();
  else if (img.complete) drop(img); // already failed while preloading
  else {
    img.addEventListener("load", swap, { once: true });
    // a slide that fails to load is dropped, and the next tick moves on to the one after it
    img.addEventListener("error", () => drop(img), { once: true });
  }
}
function drop(img: HTMLImageElement) {
  const at = slides.indexOf(img);
  if (at < 0) return;
  slides.splice(at, 1);
  img.remove();
  if (at < current) current--;
  if (slides.length < 2) {
    clearInterval(timer);
    pause.hidden = true;
  }
}
function play() {
  clearInterval(timer);
  pause.setAttribute("aria-pressed", "false");
  pause.setAttribute("aria-label", "Pause background slideshow");
  pause.textContent = "❚❚";
  if (slides.length > 1) {
    timer = window.setInterval(() => show((current + 1) % slides.length), 8000);
    preload(slides[(current + 1) % slides.length]);
  }
}
function stop() {
  clearInterval(timer);
  pause.setAttribute("aria-pressed", "true");
  pause.setAttribute("aria-label", "Play background slideshow");
  pause.textContent = "▶";
}
pause.addEventListener("click", () => (playing() ? stop() : play()));
pause.hidden = true; // shown once there is more than one slide
if (reduceMotion) stop();

function addSlides(items: { src: string; caption: string }[]) {
  const shown = new Set(slides.map((s) => s.src)); // absolute URLs, so "/a.jpg" and "./a.jpg" match
  for (const { src, caption: text } of items) {
    if (shown.has(new URL(src, document.baseURI).href)) continue;
    const img = document.createElement("img");
    img.alt = "";
    img.dataset.src = src;
    img.dataset.caption = text;
    heroBg.append(img);
    slides.push(img);
  }
  if (slides.length < 2) return;
  pause.hidden = false;
  if (playing()) play();
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
  hero?: string; // full-size slideshow background, relative to assets/gallery/
}
fetch("assets/gallery/gallery.json")
  .then((r) => (r.ok ? r.json() : []))
  .then((items: GalleryItem[]) => {
    addSlides(
      items
        .filter((g) => g.hero)
        .map((g) => ({
          src: `assets/gallery/${g.hero}`,
          caption: `Hand-labeled dead trees at site ${g.site}, ${g.state} · NAIP ${g.year}`,
        })),
    );
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
