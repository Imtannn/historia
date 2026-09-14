/** Preserve Gallery scroll + hash filters across entity detail round-trips. */

const STORAGE_KEY = "historia:gallery-scroll";

function galleryHashKey(hash = location.hash) {
  const raw = String(hash || "").replace(/^#/, "") || "/";
  const [pathPart, queryPart] = raw.split("?");
  const path = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  if (path !== "/library") return null;
  const query = new URLSearchParams(queryPart || "");
  if ((query.get("tab") || "events") !== "gallery") return null;
  return raw;
}

function readSaved() {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

function persistGalleryScroll(key, y) {
  if (!key) return;
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ hash: key, y: Math.max(0, Math.round(Number(y) || 0)) })
    );
  } catch {
    /* private mode / quota */
  }
}

function jumpTo(y) {
  const html = document.documentElement;
  const prev = html.style.scrollBehavior;
  html.style.scrollBehavior = "auto";
  window.scrollTo(0, y);
  html.style.scrollBehavior = prev;
}

export function restoreGalleryScroll() {
  const key = galleryHashKey();
  if (!key) return;
  const saved = readSaved();
  const y = saved && saved.hash === key ? Number(saved.y) || 0 : 0;
  jumpTo(y);
  requestAnimationFrame(() => {
    jumpTo(y);
    requestAnimationFrame(() => jumpTo(y));
  });
  setTimeout(() => jumpTo(y), 60);
}

export function bindGalleryScrollMemory() {
  try {
    history.scrollRestoration = "manual";
  } catch {
    /* ignore */
  }

  let lastKey = galleryHashKey();
  let lastY = window.scrollY;

  window.addEventListener(
    "scroll",
    () => {
      if (!galleryHashKey()) return;
      lastKey = galleryHashKey();
      lastY = window.scrollY;
    },
    { passive: true }
  );

  document.addEventListener(
    "click",
    (event) => {
      const link = event.target?.closest?.("a[href^='#']");
      if (!link) return;
      const key = galleryHashKey();
      if (!key) return;
      persistGalleryScroll(key, window.scrollY);
      lastKey = key;
      lastY = window.scrollY;
    },
    true
  );

  window.addEventListener("hashchange", () => {
    persistGalleryScroll(lastKey, lastY);
    lastKey = galleryHashKey();
    lastY = lastKey ? window.scrollY : 0;
  });

  window.addEventListener("pagehide", () => {
    persistGalleryScroll(galleryHashKey() || lastKey, galleryHashKey() ? window.scrollY : lastY);
  });
}
