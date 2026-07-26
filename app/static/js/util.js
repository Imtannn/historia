/** Shared helpers: dates, badges, toast, escape. */

const TYPE_LABELS = {
  event: "Event",
  place: "Place",
  figure: "Figure",
  period: "Period",
  milestone: "Milestone",
  timeline: "Timeline",
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

export function parseDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const upper = raw.toUpperCase().replace(/\s+/g, "");
  if (upper.endsWith("BCE") || upper.endsWith("BC")) {
    const digits = upper.replace(/\D/g, "");
    if (!digits) return null;
    return { year: -parseInt(digits, 10), month: 1, day: 1 };
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
  const p = parseDate(value);
  if (!p) return "";
  return p.year < 0 ? `${Math.abs(p.year)} BCE` : String(p.year);
}

export function formatRange(start, end) {
  const a = formatDate(start);
  const b = formatDate(end);
  if (a && b) return `${a} – ${b}`;
  return a || b || "";
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
  // subsequence
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length ? 1 : 0;
}

export function entityMatches(entity, query) {
  if (!query) return true;
  const hay = [entity.title, entity.summary || "", ...(entity.tags || [])].join(" ");
  return fuzzyScore(query, hay) > 0;
}

export function relationLabel(rel) {
  return String(rel || "related").replace(/_/g, " ");
}
