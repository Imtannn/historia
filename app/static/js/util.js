/** Shared helpers: dates, badges, toast, escape. */

const TYPE_LABELS = {
  event: "Event",
  place: "Country / empire",
  figure: "Figure",
  period: "Period",
  phase: "Phase",
  milestone: "Moment",
  timeline: "Timeline",
  topic: "Topic",
};

export function typeLabel(t) {
  return TYPE_LABELS[t] || t;
}

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Build stored date string from form parts. era: "bc" | "ac" */
export function composeDate(year, month, day, era = "ac") {
  if (year == null || String(year).trim() === "") return null;
  let y = parseInt(String(year).trim(), 10);
  if (Number.isNaN(y)) return null;
  y = Math.abs(y);

  let m = null;
  let d = null;
  if (month != null && String(month).trim() !== "") {
    m = Math.min(Math.max(parseInt(String(month).trim(), 10), 1), 12);
    if (Number.isNaN(m)) m = null;
  }
  if (m != null && day != null && String(day).trim() !== "") {
    d = Math.min(Math.max(parseInt(String(day).trim(), 10), 1), 31);
    if (Number.isNaN(d)) d = null;
  }

  const isBc = String(era || "ac").toLowerCase() === "bc";
  const yearPart = isBc ? `-${String(y).padStart(4, "0")}` : String(y);
  if (m == null) return yearPart;
  if (d == null) return `${yearPart}-${String(m).padStart(2, "0")}`;
  return `${yearPart}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Split stored date into form fields. */
export function splitDateParts(value) {
  const p = parseDate(value);
  if (!p) return { year: "", month: "", day: "", era: "ac" };
  const body = String(value || "").replace(/^-/, "");
  const parts = body.split("-");
  const hasMonth = parts.length >= 2 && /^\d+$/.test(parts[1]);
  const hasDay = parts.length >= 3 && /^\d+$/.test(parts[2]);
  return {
    year: String(Math.abs(p.year)),
    month: hasMonth ? String(parseInt(parts[1], 10)) : "",
    day: hasDay ? String(parseInt(parts[2], 10)) : "",
    era: p.year < 0 ? "bc" : "ac",
  };
}

export function parseDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const upper = raw.toUpperCase().replace(/\s+/g, "");
  if (
    upper.endsWith("BCE") ||
    upper.endsWith("BC") ||
    upper.endsWith("AC") ||
    upper.endsWith("CE") ||
    upper.endsWith("AD")
  ) {
    const digits = upper.replace(/\D/g, "");
    if (!digits) return null;
    const y = parseInt(digits, 10);
    const neg = upper.endsWith("BCE") || upper.endsWith("BC");
    return { year: neg ? -y : y, month: 1, day: 1 };
  }
  const neg = raw.startsWith("-");
  const body = neg ? raw.slice(1) : raw;
  const parts = body.split("-");
  try {
    let year = parseInt(parts[0], 10);
    if (Number.isNaN(year)) return null;
    if (neg) year = -year;
    const month = parts[1] ? parseInt(parts[1], 10) : 1;
    const day = parts[2] ? parseInt(parts[2], 10) : 1;
    return { year, month, day };
  } catch {
    return null;
  }
}

export function dateSortKey(value) {
  const p = parseDate(value);
  if (!p) return [1, 0, 0, 0];
  return [0, p.year, p.month, p.day];
}

export function formatDate(value) {
  if (!value || !String(value).trim()) return "";
  const p = parseDate(value);
  if (!p) return "";
  const yearLabel = formatYearNumber(Math.abs(p.year));
  const era = p.year < 0 ? "BC" : "AC";
  const body = String(value).replace(/^-/, "");
  const parts = body.split("-");
  const hasMonth = parts.length >= 2 && /^\d+$/.test(parts[1]);
  const hasDay = parts.length >= 3 && /^\d+$/.test(parts[2]);
  if (hasDay && hasMonth) return `${parseInt(parts[2], 10)}/${parseInt(parts[1], 10)}/${yearLabel} ${era}`;
  if (hasMonth) return `${parseInt(parts[1], 10)}/${yearLabel} ${era}`;
  return formatSignedYear(p.year);
}

/** Absolute year with thousands separators (e.g. 3300 → "3,300"). */
export function formatYearNumber(year) {
  const n = Math.round(Math.abs(Number(year)));
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("en-US");
}

/** Display a signed historic year (negative = BC). */
export function formatSignedYear(year) {
  if (year == null || year === "") return "";
  const n = Math.round(Number(year));
  if (!Number.isFinite(n)) return "";
  const label = formatYearNumber(n);
  return n < 0 ? `${label} BC` : `${label} AC`;
}

export function formatRange(start, end) {
  const a = formatDate(start);
  const b = formatDate(end);
  if (a && b) return `${a} – ${b}`;
  return a || b || "";
}

/** Signed year (negative = BC) → stored Historia date string. */
export function signedYearToStored(year) {
  if (year == null || year === "") return null;
  const n = Number(year);
  if (!Number.isFinite(n)) return null;
  return composeDate(Math.abs(n), null, null, n < 0 ? "bc" : "ac");
}

/** Stored date → signed year, or null. */
export function storedToSignedYear(value) {
  const p = parseDate(value);
  if (!p) return null;
  return p.year;
}

export function normalizeTag(raw) {
  return String(raw || "")
    .trim()
    .replace(/^#+/, "")
    .trim();
}

export function toast(message, ms = 2600) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), ms);
}

export function fuzzyScore(query, text) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = (text || "").toLowerCase();
  if (t.includes(q)) return 2 + (t.startsWith(q) ? 1 : 0);
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length ? 1 : 0;
}

export function iconEvent(size = 20) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-accent shrink-0" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`;
}

export function iconFigure(size = 20) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-accent shrink-0" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M5 20c0-4 3.5-7 7-7s7 3 7 7"/></svg>`;
}

export function isImageUrl(url) {
  const s = String(url || "").trim().toLowerCase();
  if (!s) return false;
  if (s.startsWith("data:image/")) return true;
  if (s.startsWith("/static/uploads/")) return true;
  return /\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(s);
}

export function mediaPreviewHtml(url, { className = "h-16 w-16 object-cover rounded-lg border border-paper-line" } = {}) {
  if (isImageUrl(url)) {
    return `<img src="${escapeHtml(url)}" alt="" class="${className}" loading="lazy" />`;
  }
  return `<span class="text-xs text-accent truncate">${escapeHtml(url)}</span>`;
}

export function formatCountryNames(entity) {
  const names = entity?.country_names?.length
    ? entity.country_names
    : entity?.country_name
      ? [entity.country_name]
      : [];
  return names.filter(Boolean);
}

export function entityMatches(entity, query) {
  if (!query) return true;
  const hay = [
    entity.title,
    entity.summary || "",
    entity.place_name || "",
    entity.country_name || "",
    ...formatCountryNames(entity),
    entity.category || "",
    ...(entity.tags || []),
  ].join(" ");
  return fuzzyScore(query, hay) > 0;
}

export function relationLabel(rel) {
  return String(rel || "related").replace(/_/g, " ");
}

export function compareByDateThenTitle(a, b) {
  const ka = dateSortKey(a?.date_start);
  const kb = dateSortKey(b?.date_start);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  }
  return String(a?.title || "").localeCompare(String(b?.title || ""));
}
