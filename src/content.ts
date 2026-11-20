// Better Crunchyroll — cinema mode.
//
// Crunchyroll's player (Bitmovin video + their own "katamari" controls) lives
// directly in the watch page. Its class names are generated, so we key off the
// stable data-testid attributes instead, with generic fallbacks:
//   - the player root is the lowest common ancestor of the <video> and the
//     fullscreen button (#player-container today),
//   - the root is pinned to fill the viewport,
//   - every root layer except the controls layer is shifted so the full-size
//     picture is centred when there is room, or moved up to leave a strip for
//     the controls when there isn't,
//   - the controls layer is shifted so the bottom controls sit right under the
//     picture, and kept visible instead of auto-hiding,
//   - the page behind is darkened by dimming every sibling along the path from
//     the player up to <body>, which avoids fighting the site's z-index stacking.

const STORAGE_KEY = "bcrCinema";

const ANCHOR_SELECTORS = [
  '[data-testid="fullscreen-button"]',
  '[data-testid*="fullscreen" i]',
  '[aria-label*="fullscreen" i]',
  '[aria-label*="full screen" i]',
  '[data-testid*="settings" i]',
  '[aria-label*="settings" i]',
];

const BOTTOM_CONTROLS_SELECTOR = '[data-testid="bottom-controls-autohide"]';

const CONTROL_SELECTORS = [
  "button",
  '[role="button"]',
  '[role="slider"]',
  'input[type="range"]',
].join(",");

const MOON_PATH = "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z";
const DEFAULT_CONTROLS_HEIGHT = 116;

interface Player {
  root: HTMLElement; // lowest common ancestor of the video and the controls
  anchor: HTMLElement; // the fullscreen/settings button we insert next to
  video: HTMLVideoElement;
}

let cinema = false;
let player: Player | null = null;
let controlsHeight = 0;
let resizeObserver: ResizeObserver | null = null;
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
      if (cy < area.top + area.height / 2 || cy > area.bottom + 1) continue;
      return btn;
    }
  }
  return null;
}

/** Height of the bottom controls strip (seek bar + button row). */
function measureControls(p: Player): number {
  const known = p.root.querySelector(BOTTOM_CONTROLS_SELECTOR);
  if (known) {
    const h = known.getBoundingClientRect().height;
    if (h > 0) return Math.round(h);
  }
  // Fallback: span from the highest control near the bottom to the layer's bottom.
  const rootHeight = p.root.clientHeight;
  const layer = [...p.root.children].find((c) => c.contains(p.anchor));
  if (!layer || !rootHeight) return 0;
  const bottom = layer.getBoundingClientRect().bottom;
  let top = Infinity;
  for (const el of layer.querySelectorAll(CONTROL_SELECTORS)) {
    const r = el.getBoundingClientRect();
    if (!hasSize(r)) continue;
    if (r.top < bottom - rootHeight * 0.25 || r.bottom > bottom + 1) continue;
    top = Math.min(top, r.top);
  }
  if (top === Infinity) return 0;
  return Math.round(bottom - top + 8);
}

// ---------- Moon button ----------

function moonSvg(filled: boolean, svgClass: string): string {
  const fill = filled ? "currentColor" : "none";
  return `<svg width="24" height="24" viewBox="0 0 24 24" class="${svgClass}" aria-hidden="true"><path d="${MOON_PATH}" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function updateMoon(btn: HTMLElement, svgClass: string): void {
  const pressed = String(cinema);
  if (btn.getAttribute("aria-pressed") === pressed && btn.firstChild) return;
  btn.setAttribute("aria-pressed", pressed);
  btn.innerHTML = moonSvg(cinema, svgClass);
}

/**
 * Adds the moon to the control row, cloning the anchor button's wrapper,
 * button and icon classes so it picks up the player's own sizing, hover and
 * responsive styles.
 */
function ensureMoon(anchor: HTMLElement): void {
  // Each native button sits in its own single-child wrapper; the moon gets a
  // matching wrapper placed before the anchor's.
  let slot: HTMLElement = anchor;
  while (slot.parentElement && slot.parentElement.children.length === 1) slot = slot.parentElement;

  const svgClass = anchor.querySelector("svg")?.getAttribute("class") ?? "";
  let wrap = slot.previousElementSibling;
  if (!(wrap instanceof HTMLElement && wrap.classList.contains("bcr-moon-wrap"))) {
    document.querySelectorAll(".bcr-moon-wrap").forEach((b) => b.remove());
    const btn = document.createElement("button");
    btn.className = `${anchor.className} bcr-moon`;
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
    // Rebuild the wrapper chain (e.g. div.kat:relative) around the button.
    let node: HTMLElement = btn;
    for (let n: HTMLElement | null = anchor.parentElement; n && n !== slot.parentElement; n = n.parentElement) {
      const w = document.createElement(n.tagName);
      w.className = n.className;
      w.appendChild(node);
      node = w;
    }
    node.classList.add("bcr-moon-wrap");
    slot.parentElement?.insertBefore(node, slot);
    wrap = node;
  }
  const moon = wrap.querySelector<HTMLElement>(".bcr-moon");
  if (moon) updateMoon(moon, svgClass);
}

// ---------- Player layout ----------

/**
 * Keeps the picture at full size and places the controls strip under it:
 * centred in the player when there is room, otherwise pushed up to the top.
 * When even that leaves less than a strip below, the controls overlap the
 * bottom of the picture by the shortfall. Assumes the video is letterboxed and
 * centred within its layer (object-fit: contain), as Bitmovin renders it.
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

  const pic = Math.min(w / aspect, h); // picture height as the player draws it
  const top = Math.max(0, Math.min((h - pic) / 2, h - strip - pic));

  root.style.setProperty("--bcr-shift", `${top - (h - pic) / 2}px`);
  root.style.setProperty("--bcr-lift", `${Math.min(0, top + pic - (h - strip))}px`);
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
}

// ---------- Page: fill viewport + darken ----------

function applyPage(): void {
  const target = cinema && location.pathname.includes("/watch") ? (player?.root ?? null) : null;
  document.querySelectorAll(".bcr-fill").forEach((el) => {
    if (el !== target) el.classList.remove("bcr-fill");
  });
  target?.classList.add("bcr-fill");

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
    player = null;
    resizeObserver?.disconnect();
  }
  applyPlayer();
  applyPage();
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
