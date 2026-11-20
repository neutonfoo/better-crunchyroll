// Better Crunchyroll — cinema mode.
//
// Runs in every Crunchyroll frame. Crunchyroll's class names are generated and
// change often, so nothing here depends on them. Instead:
//   - the player is located from the <video> element plus a nearby
//     fullscreen/settings button (matched by aria-label / data-testid),
//   - the player is pinned to fill the viewport,
//   - "controls below the video" is done by uniformly scaling every layer of the
//     player except the controls layer around its centre, so the picture stays
//     centred with black bars, then lifting the controls layer so the (still
//     overlaid) controls sit just under the picture,
//   - the page behind is darkened by dimming every sibling along the path from
//     the player up to <body>, which avoids fighting the site's z-index stacking.

const STORAGE_KEY = "bcrCinema";
const IS_TOP = window === window.top;

const ANCHOR_SELECTORS = [
  '[data-testid*="fullscreen" i]',
  '[aria-label*="fullscreen" i]',
  '[aria-label*="full screen" i]',
  '[title*="fullscreen" i]',
  '[data-testid*="settings" i]',
  '[aria-label*="settings" i]',
];

const CONTROL_SELECTORS = [
  "button",
  '[role="button"]',
  '[role="slider"]',
  'input[type="range"]',
  '[data-testid*="progress" i]',
  '[data-testid*="seek" i]',
  '[class*="progress" i]',
  '[class*="seek" i]',
].join(",");

const MOON_PATH = "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z";
const DEFAULT_CONTROLS_HEIGHT = 96;

interface Player {
  root: HTMLElement; // lowest common ancestor of the video and the controls
  anchor: HTMLElement; // the fullscreen/settings button we insert next to
  video: HTMLVideoElement;
}

let cinema = false;
let player: Player | null = null;
let controlsHeight = 0;
let resizeObserver: ResizeObserver | null = null;
let keepAliveTimer: number | undefined;
let syncScheduled = false;
const dimmed = new Set<Element>();

// ---------- DOM helpers ----------

function hasSize(r: DOMRect): boolean {
  return r.width > 0 && r.height > 0;
}

function commonAncestor(a: Element, b: Element): HTMLElement | null {
  const seen = new Set<Element>();
  for (let n: Element | null = a; n; n = n.parentElement) seen.add(n);
  for (let n: Element | null = b; n; n = n.parentElement) {
    if (seen.has(n)) return n as HTMLElement;
  }
  return null;
}

function largestVideo(): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null;
  let bestArea = 0;
  for (const v of document.querySelectorAll("video")) {
    const r = v.getBoundingClientRect();
    if (r.width * r.height > bestArea) {
      bestArea = r.width * r.height;
      best = v;
    }
  }
  return best;
}

function largestIframe(): HTMLIFrameElement | null {
  let best: HTMLIFrameElement | null = null;
  let bestArea = 200 * 100;
  for (const f of document.querySelectorAll("iframe")) {
    const r = f.getBoundingClientRect();
    if (r.width * r.height > bestArea) {
      bestArea = r.width * r.height;
      best = f;
    }
  }
  return best;
}

/** Finds a control-bar button that sits in the lower half of the player. */
function findAnchor(video: HTMLVideoElement): HTMLElement | null {
  // Once the media is scaled, the video's own rect shrinks, so prefer the root.
  const area = (player?.root.isConnected ? player.root : video).getBoundingClientRect();
  for (const sel of ANCHOR_SELECTORS) {
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      if (el.closest(".bcr-moon")) continue;
      const btn = el.closest<HTMLElement>('button, [role="button"]') ?? el;
      const r = btn.getBoundingClientRect();
      if (!hasSize(r)) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < area.left || cx > area.right) continue;
      if (cy < area.top + area.height / 2 || cy > area.bottom + area.height * 0.25) continue;
      return btn;
    }
  }
  return null;
}

/** Height of the controls strip, measured from the bottom of the player. */
function measureControls(p: Player): number {
  const rootHeight = p.root.clientHeight;
  const layer = [...p.root.children].find((c) => c.contains(p.anchor));
  if (!layer || !rootHeight) return 0;
  // Measure against the layer, not the root, since the layer may be lifted.
  const bottom = layer.getBoundingClientRect().bottom;
  let top = Infinity;
  for (const el of layer.querySelectorAll(CONTROL_SELECTORS)) {
    const r = el.getBoundingClientRect();
    if (!hasSize(r)) continue;
    if (r.top < bottom - rootHeight * 0.4 || r.bottom > bottom + 1) continue;
    top = Math.min(top, r.top);
  }
  if (top === Infinity) return 0;
  return Math.round(Math.min(bottom - top + 8, rootHeight * 0.3));
}

// ---------- Moon button ----------

function moonSvg(filled: boolean): string {
  const fill = filled ? "currentColor" : "none";
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${MOON_PATH}" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function updateMoon(btn: HTMLElement): void {
  const pressed = String(cinema);
  if (btn.getAttribute("aria-pressed") === pressed && btn.firstChild) return;
  btn.setAttribute("aria-pressed", pressed);
  btn.innerHTML = moonSvg(cinema);
}

function ensureMoon(anchor: HTMLElement): void {
  let btn = anchor.previousElementSibling;
  if (!(btn instanceof HTMLElement && btn.classList.contains("bcr-moon"))) {
    document.querySelectorAll(".bcr-moon").forEach((b) => b.remove());
    btn = document.createElement("button");
    btn.className = "bcr-moon";
    btn.setAttribute("type", "button");
    btn.setAttribute("aria-label", "Cinema mode");
    btn.setAttribute("title", "Cinema mode");
    // Keep the player from treating clicks here as play/pause or fullscreen.
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick"]) {
      btn.addEventListener(type, (e) => e.stopPropagation());
    }
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setCinema(!cinema);
    });
    anchor.parentElement?.insertBefore(btn, anchor);
  }
  const moon = btn as HTMLElement;
  const r = anchor.getBoundingClientRect();
  const size = hasSize(r) ? `${Math.round(Math.min(r.width, r.height))}px` : "40px";
  moon.style.width = size;
  moon.style.height = size;
  updateMoon(moon);
}

// ---------- Player layout ----------

/**
 * Shrinks the picture (around its centre) until there is room for the controls
 * strip beneath it, then lifts the controls layer to sit right under it.
 * Assumes the video is letterboxed and centred within the player, which is
 * how <video> renders by default (object-fit: contain).
 */
function updateLayout(): void {
  if (!player) return;
  const { root, video } = player;
  const measured = measureControls(player);
  if (measured > 0) controlsHeight = measured;
  const w = root.clientWidth;
  const h = root.clientHeight;
  if (!w || !h) return;
  const strip = controlsHeight || DEFAULT_CONTROLS_HEIGHT;
  const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
  const natural = Math.min(w / aspect, h);
  const target = Math.max(0, Math.min(w / aspect, h - 2 * strip));
  const lift = Math.max(0, (h - target) / 2 - strip);
  root.style.setProperty("--bcr-scale", String(target / natural));
  root.style.setProperty("--bcr-lift", `${-lift}px`);
}

function applyPlayer(): void {
  const media = new Set<Element>();
  let controls: Element | null = null;
  if (cinema && player) {
    const { root, anchor } = player;
    root.classList.add("bcr-root");
    for (const child of root.children) {
      if (child.contains(anchor)) controls = child;
      else media.add(child);
    }
    updateLayout();
  }
  document.querySelectorAll(".bcr-media").forEach((el) => {
    if (!media.has(el)) el.classList.remove("bcr-media");
  });
  media.forEach((el) => el.classList.add("bcr-media"));
  document.querySelectorAll(".bcr-controls").forEach((el) => {
    if (el !== controls) el.classList.remove("bcr-controls");
  });
  controls?.classList.add("bcr-controls");
  if (!cinema || !player) {
    document.querySelectorAll(".bcr-root").forEach((el) => el.classList.remove("bcr-root"));
  }
  updateKeepAlive();
}

/**
 * The player auto-hides its controls after a few seconds of no mouse movement.
 * With the controls in their own strip there is nothing to hide them from, so
 * nudge the player with synthetic mouse moves over the controls.
 */
function updateKeepAlive(): void {
  const active = cinema && player !== null;
  if (active && keepAliveTimer === undefined) {
    keepAliveTimer = window.setInterval(() => {
      if (!player || document.hidden) return;
      const r = player.root.getBoundingClientRect();
      const a = player.anchor.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = hasSize(a) ? a.top + a.height / 2 : r.bottom - (controlsHeight || DEFAULT_CONTROLS_HEIGHT) / 2;
      const target = document.elementFromPoint(x, y) ?? player.root;
      const init = { bubbles: true, cancelable: true, clientX: x, clientY: y };
      target.dispatchEvent(new PointerEvent("pointermove", init));
      target.dispatchEvent(new MouseEvent("mousemove", init));
    }, 1500);
  } else if (!active && keepAliveTimer !== undefined) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = undefined;
  }
}

// ---------- Page: fill viewport + darken (top frame only) ----------

/** The element that represents the player in the top-level page. */
function pagePlayerElement(): HTMLElement | null {
  let el: HTMLElement | null = player?.root ?? largestIframe();
  if (!el) return null;
  // Once pinned to the viewport it no longer matches its wrappers' size anyway.
  if (el.classList.contains("bcr-fill")) return el;
  // Climb through same-size wrappers so overlays like "Skip Intro" aren't dimmed.
  const r = el.getBoundingClientRect();
  while (el.parentElement && el.parentElement !== document.body) {
    const pr = el.parentElement.getBoundingClientRect();
    if (Math.abs(pr.width - r.width) > 2 || Math.abs(pr.height - r.height) > 2) break;
    el = el.parentElement;
  }
  return el;
}

function applyPage(): void {
  const onWatch = cinema && location.pathname.includes("/watch");
  const fill = onWatch ? (player?.root ?? largestIframe()) : null;
  document.querySelectorAll(".bcr-fill").forEach((el) => {
    if (el !== fill) el.classList.remove("bcr-fill");
  });
  fill?.classList.add("bcr-fill");

  const target = onWatch ? pagePlayerElement() : null;
  const wanted = new Set<Element>();
  if (target) {
    for (let n: Element = target; n.parentElement && n !== document.body; n = n.parentElement) {
      for (const sib of n.parentElement.children) {
        if (sib !== n && !(sib instanceof HTMLScriptElement) && !(sib instanceof HTMLStyleElement)) {
          wanted.add(sib);
        }
      }
    }
  }
  dimmed.forEach((el) => {
    if (!wanted.has(el)) el.classList.remove("bcr-dim");
  });
  wanted.forEach((el) => el.classList.add("bcr-dim"));
  dimmed.clear();
  wanted.forEach((el) => dimmed.add(el));
  document.documentElement.classList.toggle("bcr-cinema", target !== null);
}

// ---------- Sync loop ----------

function sync(): void {
  syncScheduled = false;
  const video = largestVideo();
  const anchor = video && hasSize(video.getBoundingClientRect()) ? findAnchor(video) : null;
  if (video && anchor) {
    const root = commonAncestor(video, anchor);
    if (root && (root !== player?.root || anchor !== player.anchor || video !== player.video)) {
      player = { root, anchor, video };
      resizeObserver?.disconnect();
      resizeObserver = new ResizeObserver(() => cinema && updateLayout());
      resizeObserver.observe(root);
    }
    ensureMoon(anchor);
  } else if (player && !player.root.isConnected) {
    // Controls can unmount while hidden; only drop the player if it's truly gone.
    player = null;
    resizeObserver?.disconnect();
  }
  applyPlayer();
  if (IS_TOP) applyPage();
}

function scheduleSync(): void {
  if (syncScheduled) return;
  syncScheduled = true;
  setTimeout(sync, 250);
}

function setCinema(on: boolean): void {
  cinema = on;
  sync();
  chrome.storage.local.set({ [STORAGE_KEY]: on });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(STORAGE_KEY in changes)) return;
  cinema = Boolean(changes[STORAGE_KEY].newValue);
  sync();
});

chrome.storage.local.get(STORAGE_KEY).then((v) => {
  cinema = Boolean(v[STORAGE_KEY]);
  sync();
});

new MutationObserver(scheduleSync).observe(document.documentElement, {
  childList: true,
  subtree: true,
});
window.addEventListener("resize", scheduleSync);
document.addEventListener("fullscreenchange", scheduleSync);
// The video's aspect ratio is only known once metadata loads.
document.addEventListener("loadedmetadata", scheduleSync, true);
// Esc leaves cinema mode (in native fullscreen the browser handles Esc itself).
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && cinema && !document.fullscreenElement) setCinema(false);
});
