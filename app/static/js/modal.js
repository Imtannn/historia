/** Add Event modal — Country/World → Period → Figure/Empire cascade. */

import { api } from "./api.js";
import {
  composeDate,
  escapeHtml,
  formatRange,
  formatSignedYear,
  iconEvent,
  iconFigure,
  isImageUrl,
  mediaPreviewHtml,
  normalizeTag,
  splitDateParts,
  storedToSignedYear,
  toast,
} from "./util.js";

let allEvents = [];
let hubs = { period: [], phase: [], country: [], figure: [] };
let catalog = { countries: [], empires: [], figures: [] };
let selectedRelated = new Map();
let selectedBelong = {
  period: new Map(),
  phase: new Map(),
  country: new Map(), // modern countries + World + empires (all place hubs)
  figure: new Map(),
};
let attachments = [];
/** Periods / phases kept even if dates don’t auto-map (hub CTAs / edit links). */
let pinnedPeriodIds = new Set();
let pinnedPhaseIds = new Set();

function empireNameSet() {
  return new Set((catalog.empires || []).map((e) => e.name.toLowerCase()));
}

function isEmpireTitle(title) {
  return empireNameSet().has(String(title || "").toLowerCase());
}

function isWorldTitle(title) {
  return String(title || "").toLowerCase() === "world";
}

/** Modern countries + World (not empires). Exactly one when set. */
function selectedPlaces() {
  return [...selectedBelong.country.values()].filter((e) => !isEmpireTitle(e.title));
}

function primaryPlace() {
  return selectedPlaces()[0] || null;
}

function clearPrimaryPlaces() {
  for (const e of selectedPlaces()) {
    selectedBelong.country.delete(e.id);
  }
}

/** Empires linked to the selected modern country. Hidden for World. */
function empiresForContext() {
  const place = primaryPlace();
  if (!place || isWorldTitle(place.title)) return [];
  const name = place.title.toLowerCase();
  return (catalog.empires || []).filter((e) =>
    (e.modern || []).some((m) => m.toLowerCase() === name)
  );
}

/** Drop empires that no longer match the selected country (or clear them on World). */
function pruneEmpiresForPrimary() {
  const place = primaryPlace();
  if (!place || isWorldTitle(place.title)) {
    for (const e of selectedEmpires()) {
      selectedBelong.country.delete(e.id);
    }
    return;
  }
  const allowed = new Set(empiresForContext().map((e) => e.name.toLowerCase()));
  for (const e of selectedEmpires()) {
    if (!allowed.has(e.title.toLowerCase())) {
      selectedBelong.country.delete(e.id);
    }
  }
}

/** If edit data has multiple countries, keep one (prefer non-World). */
function normalizeToSingleCountry() {
  const places = selectedPlaces();
  if (places.length <= 1) return;
  const preferred = places.find((p) => !isWorldTitle(p.title)) || places[0];
  for (const p of places) {
    if (p.id !== preferred.id) selectedBelong.country.delete(p.id);
  }
}

function selectedEmpires() {
  return [...selectedBelong.country.values()].filter((e) => isEmpireTitle(e.title));
}

function hasPlaceContext() {
  return selectedPlaces().length > 0;
}

/** Event needs at least one anchor: country, figure, period, or phase. */
function hasEventAnchor(eventCountries) {
  return (
    (eventCountries?.length || 0) > 0 ||
    selectedBelong.period.size > 0 ||
    selectedBelong.phase.size > 0 ||
    selectedBelong.figure.size > 0
  );
}

/** Period overlaps the selected era (BC years are negative). Custom periods without range always match. */
function periodMatchesEra(periodMeta, era) {
  if (!periodMeta || periodMeta.start_year == null || periodMeta.end_year == null) return true;
  if (era === "bc") return periodMeta.start_year < 0;
  return periodMeta.end_year > 0;
}

function selectedEra() {
  return document.querySelector('input[name="qa-from-era"]:checked')?.value || "ac";
}

/** Drop selected periods that no longer fit the chosen BC/AC era. */
function clearPeriodIfEraMismatch() {
  const era = selectedEra();
  let cleared = false;
  for (const [id, period] of [...selectedBelong.period.entries()]) {
    const meta = periodMetaFor(period);
    if (!periodMatchesEra(meta, era)) {
      selectedBelong.period.delete(id);
      pinnedPeriodIds.delete(id);
      cleared = true;
    }
  }
  return cleared;
}

/** Prefill From/To on inline period/phase create from the event dates. */
function defaultCreateYearsFromEvent() {
  const from = readEventDateSide("qa-from");
  const to = readEventDateSide("qa-to");
  const fromYear = from.signed != null ? String(Math.abs(from.signed)) : "";
  const toYear = to.signed != null ? String(Math.abs(to.signed)) : fromYear;
  return {
    fromYear,
    fromEra: from.era || selectedEra(),
    toYear,
    toEra: to.signed != null ? to.era : from.era || selectedEra(),
  };
}

/** Prefer the period/phase entity's from/to years. */
function periodMetaFor(periodOrName) {
  if (periodOrName && typeof periodOrName === "object") {
    const start = storedToSignedYear(periodOrName.date_start);
    const end = storedToSignedYear(periodOrName.date_end);
    if (start != null || end != null) {
      const a = start ?? end;
      const b = end ?? start;
      return {
        name: periodOrName.title,
        start_year: Math.min(a, b),
        end_year: Math.max(a, b),
      };
    }
    return null;
  }
  return null;
}

/** Normalize a From–To pair on the signed timeline (−BC … 0 … +AC). */
function normalizeYearRange(start, end = start) {
  if (start == null) return null;
  const hi = end == null ? start : end;
  return start <= hi ? { lo: start, hi } : { lo: hi, hi: start };
}

function periodOverlapsRange(meta, start, end) {
  if (!meta || meta.start_year == null || meta.end_year == null) return false;
  const r = normalizeYearRange(start, end);
  if (!r) return false;
  const plo = Math.min(meta.start_year, meta.end_year);
  const phi = Math.max(meta.start_year, meta.end_year);
  // Share interior years on the signed timeline; endpoint-only touch does not count
  // (Prehistory …3300 BC must not claim Bronze Age 3300 BC…).
  return r.lo < phi && r.hi > plo;
}

/**
 * Score notebook eras against a date span on the signed year line (−BC … +AC).
 * A span that crosses period boundaries matches every overlapping era
 * (so a phase/event can belong to more than one period).
 */
function scoreNotebookEras(hubList, start, end = start) {
  const r = normalizeYearRange(start, end);
  if (!r) return [];
  const out = [];
  for (const ent of hubList || []) {
    const meta = periodMetaFor(ent);
    if (!periodOverlapsRange(meta, r.lo, r.hi)) continue;
    const plo = Math.min(meta.start_year, meta.end_year);
    const phi = Math.max(meta.start_year, meta.end_year);
    out.push({
      entity: ent,
      meta: { ...meta, start_year: plo, end_year: phi },
      span: phi - plo,
      overlap: Math.min(r.hi, phi) - Math.max(r.lo, plo),
    });
  }
  out.sort(
    (a, b) =>
      b.overlap - a.overlap ||
      a.span - b.span ||
      a.entity.title.localeCompare(b.entity.title)
  );
  return out;
}

/** Notebook periods that best match [start, end] on the signed timeline. */
function findNotebookPeriodsContaining(start, end = start) {
  return scoreNotebookEras(hubs.period || [], start, end);
}

/** Notebook phases that best match [start, end]. */
function findNotebookPhasesContaining(start, end = start) {
  return scoreNotebookEras(hubs.phase || [], start, end);
}

function collectPinned(kind) {
  const ids = kind === "phase" ? pinnedPhaseIds : pinnedPeriodIds;
  const map = selectedBelong[kind];
  const hubList = hubs[kind] || [];
  const pinned = [];
  for (const id of ids) {
    const ent = map.get(id) || hubList.find((p) => p.id === id) || null;
    if (ent) pinned.push(ent);
  }
  return pinned;
}

/**
 * Auto-link notebook periods + phases whose From–To overlap the event dates.
 * Keeps any pinned periods/phases (hub CTAs / edit links).
 */
function autoAssignPeriodsFromEventDates() {
  const from = readEventDateSide("qa-from");
  const to = readEventDateSide("qa-to");
  // No date yet — keep any preselected / edit periods & phases
  if (from.error || to.error || from.signed == null) {
    return {
      matched: [...selectedBelong.period.values()],
      phases: [...selectedBelong.phase.values()],
    };
  }

  const start = from.signed;
  const end = to.signed ?? from.signed;
  const periodHits = findNotebookPeriodsContaining(start, end);
  const phaseHits = findNotebookPhasesContaining(start, end);
  const pinnedPeriods = collectPinned("period");
  const pinnedPhases = collectPinned("phase");

  selectedBelong.period.clear();
  for (const h of periodHits) {
    selectedBelong.period.set(h.entity.id, h.entity);
  }
  for (const ent of pinnedPeriods) {
    selectedBelong.period.set(ent.id, ent);
  }

  selectedBelong.phase.clear();
  for (const h of phaseHits) {
    selectedBelong.phase.set(h.entity.id, h.entity);
  }
  for (const ent of pinnedPhases) {
    selectedBelong.phase.set(ent.id, ent);
  }

  return {
    matched: [...selectedBelong.period.values()],
    phases: [...selectedBelong.phase.values()],
  };
}

/** Periods that overlap a phase’s From–To (for create/edit phase). */
function autoAssignPeriodsForRange(start, end) {
  if (start == null) return [];
  return findNotebookPeriodsContaining(start, end == null ? start : end).map((h) => h.entity);
}

async function onEventDateFieldsChanged() {
  syncDateConstraints();
  autoAssignPeriodsFromEventDates();
  refreshBelongUI();
}

/** Bounds from the selected period's from/to (entity or catalog). */
function selectedPeriodBounds() {
  const periods = [...selectedBelong.period.values()];
  if (!periods.length) return null;
  // Use the narrowest selected period for date locking
  let best = null;
  for (const period of periods) {
    const meta = periodMetaFor(period);
    if (!meta || meta.start_year == null || meta.end_year == null) continue;
    const span = meta.end_year - meta.start_year;
    if (!best || span < best.span) {
      best = { start: meta.start_year, end: meta.end_year, name: period.title, span };
    }
  }
  if (!best) return null;
  return { start: best.start, end: best.end, name: best.name };
}

function syncDateConstraints() {
  const bounds = selectedPeriodBounds();
  const hint = document.getElementById("date-period-hint");
  const yearEls = ["qa-from-year", "qa-to-year"]
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  if (!yearEls.length) return;

  yearEls.forEach((yearEl) => {
    yearEl.removeAttribute("min");
    yearEl.removeAttribute("max");
    yearEl.placeholder = "Year";
  });

  if (!bounds) {
    if (hint) {
      hint.textContent = "Set From / To with AC or BC — periods map from the range.";
    }
    return;
  }

  const { start, end, name } = bounds;
  if (hint) {
    hint.textContent = `Mapped to ${name} (${formatSignedYear(start)} – ${formatSignedYear(end)})`;
  }
}

function eraForSide(prefix) {
  return document.querySelector(`input[name="${prefix}-era"]:checked`)?.value || "ac";
}

function signedYearFromSide(prefix) {
  const year = document.getElementById(`${prefix}-year`)?.value;
  if (year == null || String(year).trim() === "") return null;
  let y = parseInt(String(year).trim(), 10);
  if (Number.isNaN(y)) return null;
  y = Math.abs(y);
  const era = eraForSide(prefix);
  return era === "bc" ? -y : y;
}

function signedYearFromForm() {
  return signedYearFromSide("qa-from");
}

function readEventDateSide(prefix) {
  const day = document.getElementById(`${prefix}-day`)?.value;
  const month = document.getElementById(`${prefix}-month`)?.value;
  const year = document.getElementById(`${prefix}-year`)?.value;
  const era = eraForSide(prefix);
  if ((month || day) && !String(year || "").trim()) {
    return { error: "Add a year if you set month or day" };
  }
  return {
    day,
    month,
    year,
    era,
    stored: composeDate(year, month, day, era),
    signed: signedYearFromSide(prefix),
  };
}

function flagForCountry(name) {
  const key = String(name || "").toLowerCase();
  const hit =
    catalog.countries.find((c) => c.name.toLowerCase() === key) ||
    (catalog.empires || []).find((e) => e.name.toLowerCase() === key);
  return hit?.flag || "";
}

function displayHubLabel(kind, entity) {
  if (kind === "country" || kind === "empire") {
    const summary = (entity.summary || "").trim();
    const flag =
      flagForCountry(entity.title) ||
      (summary && !summary.includes(" ") ? summary : "");
    return flag ? `${flag} ${entity.title}` : entity.title;
  }
  return entity.title;
}

let mediaHandlersAbort = null;

function closeModal() {
  mediaHandlersAbort?.abort();
  mediaHandlersAbort = null;
  document.getElementById("modal-root").classList.add("hidden");
  document.getElementById("modal-panel").innerHTML = "";
  selectedRelated = new Map();
  selectedBelong = { period: new Map(), phase: new Map(), country: new Map(), figure: new Map() };
  pinnedPeriodIds = new Set();
  pinnedPhaseIds = new Set();
  attachments = [];
}

function openModal() {
  document.getElementById("modal-root").classList.remove("hidden");
}

function syncBelongHint() {
  const hint = document.getElementById("belong-hint");
  if (!hint) return;
  const figCount = selectedBelong.figure.size;
  const parts = [];
  if (selectedBelong.period.size) {
    const n = selectedBelong.period.size;
    parts.push(`${n} period${n === 1 ? "" : "s"}`);
  }
  if (selectedBelong.phase.size) {
    const n = selectedBelong.phase.size;
    parts.push(`${n} phase${n === 1 ? "" : "s"}`);
  }
  if (figCount) parts.push(`${figCount} figure${figCount === 1 ? "" : "s"}`);
  hint.textContent = parts.length
    ? `${parts.join(" · ")} linked`
    : "Enter dates to auto-map, or search to add periods and phases.";
  hint.className = "text-xs text-ink-faint mt-0 mb-2";
  syncCascadeLock();
}

function syncCascadeLock() {
  // Figures are independent of country — no cascade lock in the add-event wizard.
}

function chipHtml(label, attrs) {
  return `
    <button type="button" ${attrs} class="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-accent-soft text-accent-dark text-xs font-medium">
      ${escapeHtml(label)}
      <span aria-hidden="true">×</span>
    </button>`;
}

const LINK_ROLE_MAX_LENGTH = 64;
const PICKER_HIT_LIMIT = 30;

function sortByTitle(entities) {
  return entities.slice().sort((a, b) => a.title.localeCompare(b.title));
}

function neighborRelation(item) {
  return String(item?.relation || "");
}

function neighborItems(neighbors, type, { direction = null, relation = null } = {}) {
  return (neighbors?.related?.[type] || []).filter((item) => {
    if (direction && item.direction !== direction) return false;
    if (relation && neighborRelation(item) !== relation) return false;
    return true;
  });
}

function titleMatches(entity, q) {
  if (!q) return true;
  const hay = `${entity.title} ${entity.summary || ""}`.toLowerCase();
  return hay.includes(q);
}

/** Searchable list that calls onPick(entity). Returns a re-render function. */
function bindEntitySearchPicker({
  listId,
  searchId,
  getCandidates,
  isSelected,
  onPick,
  emptyNone,
  limit = PICKER_HIT_LIMIT,
}) {
  const listEl = document.getElementById(listId);
  const searchEl = document.getElementById(searchId);

  function render() {
    if (!listEl) return;
    const q = (searchEl?.value || "").trim().toLowerCase();
    const candidates = getCandidates();
    const hits = candidates.filter((e) => !isSelected(e.id) && titleMatches(e, q));
    if (!hits.length) {
      listEl.innerHTML = `<p class="px-3 py-2 text-sm text-ink-faint">${
        candidates.length ? "No matches." : emptyNone
      }</p>`;
      return;
    }
    listEl.innerHTML = hits
      .slice(0, limit)
      .map(
        (e) => `
      <button type="button" data-pick-id="${e.id}" class="w-full text-left px-3 py-2 text-sm hover:bg-paper-deep">
        ${escapeHtml(e.title)}
      </button>`
      )
      .join("");
    listEl.querySelectorAll("[data-pick-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const ent = candidates.find((c) => c.id === btn.dataset.pickId);
        if (ent) onPick(ent);
      });
    });
  }

  searchEl?.addEventListener("input", render);
  render();
  return render;
}

/** Chip row for Map<id, entity>. Returns a re-render function. */
function bindRemovableChips({ chipsId, selected, emptyHtml, onChange }) {
  const box = document.getElementById(chipsId);

  function render() {
    if (!box) return;
    if (!selected.size) {
      box.innerHTML = emptyHtml;
      return;
    }
    box.innerHTML = [...selected.values()]
      .map((e) => chipHtml(e.title, `data-rm-id="${e.id}"`))
      .join("");
    box.querySelectorAll("[data-rm-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        selected.delete(btn.dataset.rmId);
        render();
        onChange?.();
      });
    });
  }

  render();
  return render;
}

function renderCountryChips() {
  const box = document.getElementById("belong-chips-country");
  if (!box) return;
  const place = primaryPlace();
  const empires = selectedEmpires();
  if (!place && !empires.length) {
    box.innerHTML = `<span class="text-xs text-ink-faint">None selected</span>`;
    return;
  }
  let html = "";
  if (place) {
    html += chipHtml(displayHubLabel("country", place), `data-reset-place="1"`);
  }
  html += empires
    .map((e) => chipHtml(displayHubLabel("empire", e), `data-unlink-empire="${e.id}"`))
    .join("");
  box.innerHTML = html;
  box.querySelector("[data-reset-place]")?.addEventListener("click", async () => {
    clearPrimaryPlaces();
    try {
      await setPrimaryPlace("World", "🌍");
    } catch {
      refreshBelongUI();
    }
  });
  box.querySelectorAll("[data-unlink-empire]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedBelong.country.delete(btn.dataset.unlinkEmpire);
      refreshBelongUI();
    });
  });
}

function renderPeriodChips() {
  const box = document.getElementById("belong-chips-period");
  if (!box) return;
  const periods = [...selectedBelong.period.values()];
  if (!periods.length) {
    box.innerHTML = `<p class="text-sm text-ink-faint py-1">None yet — search above, or enter dates to auto-map.</p>`;
    return;
  }
  box.innerHTML = `
    <div class="flex flex-wrap gap-1.5">
      ${periods
        .map((period) => {
          const meta = periodMetaFor(period);
          const range = meta
            ? ` · ${formatSignedYear(meta.start_year)}–${formatSignedYear(meta.end_year)}`
            : "";
          return chipHtml(`${period.title}${range}`, `data-unlink-period="${period.id}"`);
        })
        .join("")}
    </div>`;
  box.querySelectorAll("[data-unlink-period]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedBelong.period.delete(btn.dataset.unlinkPeriod);
      pinnedPeriodIds.delete(btn.dataset.unlinkPeriod);
      refreshBelongUI();
    });
  });
}

function renderPhaseChips() {
  const box = document.getElementById("belong-chips-phase");
  if (!box) return;
  const phases = [...selectedBelong.phase.values()];
  if (!phases.length) {
    box.innerHTML = `<p class="text-sm text-ink-faint py-1">None yet — search above, or enter dates to auto-map.</p>`;
    return;
  }
  box.innerHTML = `
    <div class="flex flex-wrap gap-1.5">
      ${phases
        .map((phase) => {
          const meta = periodMetaFor(phase);
          const range = meta
            ? ` · ${formatSignedYear(meta.start_year)}–${formatSignedYear(meta.end_year)}`
            : "";
          return chipHtml(`${phase.title}${range}`, `data-unlink-phase="${phase.id}"`);
        })
        .join("")}
    </div>`;
  box.querySelectorAll("[data-unlink-phase]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedBelong.phase.delete(btn.dataset.unlinkPhase);
      pinnedPhaseIds.delete(btn.dataset.unlinkPhase);
      refreshBelongUI();
    });
  });
}

function renderActorChips() {
  const box = document.getElementById("belong-chips-actor");
  if (!box) return;
  const figures = [...selectedBelong.figure.values()];
  if (!figures.length) {
    box.innerHTML = `<p class="text-sm text-ink-faint py-1">No one linked yet — pick from your figures above.</p>`;
    return;
  }
  box.innerHTML = `
    <div class="flex flex-wrap gap-1.5">
      ${figures
        .map(
          (e) =>
            chipHtml(e.title, `data-unlink-figure="${e.id}"`)
        )
        .join("")}
    </div>`;
  box.querySelectorAll("[data-unlink-figure]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedBelong.figure.delete(btn.dataset.unlinkFigure);
      refreshBelongUI();
    });
  });
}

function catalogButton(kind, item, extra = "") {
  const hint = item.modern?.length ? item.modern.join(", ") : "";
  return `
    <button type="button" data-pick-kind="${kind}" data-pick-name="${escapeHtml(item.name)}" data-pick-flag="${escapeHtml(item.flag || "")}" ${extra}
      class="w-full text-left px-2 py-1.5 rounded-lg hover:bg-paper-deep text-sm flex items-start gap-2 disabled:opacity-40">
      ${item.flag ? `<span class="text-base leading-none mt-0.5">${item.flag}</span>` : ""}
      <span class="min-w-0">
        <span class="block">${escapeHtml(item.name)}</span>
        ${hint ? `<span class="block text-[11px] text-ink-faint">→ ${escapeHtml(hint)}</span>` : ""}
      </span>
    </button>`;
}

function matchesQ(name, q, extra = []) {
  if (!q) return true;
  const hay = [name, ...extra].join(" ").toLowerCase();
  return hay.includes(q);
}

function renderCountryCatalog() {
  const box = document.getElementById("belong-catalog-country");
  if (!box) return;
  const q = (document.getElementById("belong-search-country")?.value || "").trim().toLowerCase();
  const current = primaryPlace()?.title.toLowerCase() || "";
  const selectedEmpire = new Set(selectedEmpires().map((e) => e.title.toLowerCase()));
  let items = (catalog.countries || []).filter((c) => matchesQ(c.name, q));
  items.sort((a, b) => {
    if (a.name === "World") return -1;
    if (b.name === "World") return 1;
    return a.name.localeCompare(b.name);
  });

  let html = "";
  if (!items.length) {
    html = `<p class="text-xs text-ink-faint px-1 py-2">No matches</p>`;
  } else {
    html =
      `<p class="text-[10px] uppercase tracking-wider text-ink-faint font-semibold px-2 pt-1.5 pb-0.5">Pick one country (or World)</p>` +
      items
        .map((c) => {
          const selected = c.name.toLowerCase() === current;
          return `
    <button type="button" data-pick-kind="country" data-pick-name="${escapeHtml(c.name)}" data-pick-flag="${escapeHtml(c.flag || "")}"
      class="w-full text-left px-2 py-1.5 rounded-lg text-sm flex items-center gap-2 ${selected ? "bg-accent-soft text-accent-dark font-medium" : "hover:bg-paper-deep"}">
      ${c.flag ? `<span class="text-base leading-none">${c.flag}</span>` : ""}
      <span class="flex-1 min-w-0">${escapeHtml(c.name)}</span>
      ${selected ? `<span class="text-[11px] text-accent-dark">Selected</span>` : ""}
    </button>`;
        })
        .join("");
  }

  // Empires: subgroup of the selected country only (not World)
  const place = primaryPlace();
  const showEmpires = place && !isWorldTitle(place.title);
  if (showEmpires) {
    const empires = empiresForContext().filter((e) => matchesQ(e.name, q, e.modern || []));
    html += `<p class="text-[10px] uppercase tracking-wider text-ink-faint font-semibold px-2 pt-2 pb-0.5 border-t border-paper-line mt-1">Empires for ${escapeHtml(place.title)}</p>`;
    if (!empires.length) {
      html += `<p class="text-xs text-ink-faint px-2 py-1.5">No empires linked to this country${q ? " for this search" : ""}.</p>`;
    } else {
      html += empires
        .map((e) => {
          const selected = selectedEmpire.has(e.name.toLowerCase());
          return `
    <button type="button" data-pick-kind="empire" data-pick-name="${escapeHtml(e.name)}" data-pick-flag="${escapeHtml(e.flag || "")}"
      class="w-full text-left px-2 py-1.5 rounded-lg text-sm flex items-start gap-2 ${selected ? "bg-accent-soft text-accent-dark font-medium" : "hover:bg-paper-deep"}">
      ${e.flag ? `<span class="text-base leading-none mt-0.5">${e.flag}</span>` : ""}
      <span class="min-w-0 flex-1">
        <span class="block">${escapeHtml(e.name)}</span>
        ${e.modern?.length ? `<span class="block text-[11px] ${selected ? "text-accent-dark/80" : "text-ink-faint"}">→ ${escapeHtml(e.modern.join(", "))}</span>` : ""}
      </span>
      ${selected ? `<span class="text-[11px] text-accent-dark shrink-0">Added</span>` : `<span class="text-[11px] text-ink-faint shrink-0">Add</span>`}
    </button>`;
        })
        .join("");
    }
  }

  box.innerHTML = html;
  bindPickButtons(box);
}

function renderPeriodCatalog() {
  const box = document.getElementById("belong-catalog-period");
  if (!box) return;
  const qRaw = (document.getElementById("belong-search-period")?.value || "").trim();
  const q = qRaw.toLowerCase();
  const selectedNames = new Set(
    [...selectedBelong.period.values()].map((e) => e.title.toLowerCase())
  );
  const era = selectedEra();
  const mine = hubs.period
    .filter((p) => !selectedNames.has(p.title.toLowerCase()))
    .filter((p) => matchesQ(p.title, q))
    .filter((p) => periodMatchesEra(periodMetaFor(p) || { start_year: null, end_year: null }, era))
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title));

  const exactHit =
    mine.some((p) => p.title.toLowerCase() === q) || selectedNames.has(q);
  const canCreate = q.length >= 2 && !exactHit;
  const defs = defaultCreateYearsFromEvent();

  if (!mine.length && !canCreate) {
    box.innerHTML = `<p class="text-xs text-ink-faint px-2 py-2">${
      q
        ? "No matches — keep typing to create a new period."
        : hubs.period.length
          ? "All matching periods are linked. Search to add another."
          : era === "bc"
            ? "No BC periods yet — search a name to create one."
            : "No AC periods yet — search a name to create one."
    }</p>`;
    bindPickButtons(box);
    return;
  }

  let html = "";
  if (mine.length) {
    html += `<p class="text-[10px] uppercase tracking-wider text-ink-faint font-semibold px-2 pt-1.5 pb-0.5">Your periods</p>`;
    html += mine
      .map((p) => {
        const meta = periodMetaFor(p);
        const range = meta
          ? `${formatSignedYear(meta.start_year)} – ${formatSignedYear(meta.end_year)}`
          : "";
        return `
    <button type="button" data-pick-existing="${p.id}" data-pick-kind="period"
      class="w-full text-left px-2 py-1.5 rounded-lg hover:bg-paper-deep text-sm">
      <span class="block">${escapeHtml(p.title)}</span>
      ${range ? `<span class="block text-[11px] text-ink-faint">${escapeHtml(range)}</span>` : ""}
    </button>`;
      })
      .join("");
  } else if (!q) {
    html += `<p class="text-[10px] uppercase tracking-wider text-ink-faint font-semibold px-2 pt-1.5 pb-0.5">Your periods</p>`;
    html += `<p class="text-xs text-ink-faint px-2 py-1.5">None yet — search a name to add one.</p>`;
  }

  if (canCreate) {
    const fromEra = defs.fromEra === "bc" ? "bc" : "ac";
    const toEra = defs.toEra === "bc" ? "bc" : "ac";
    html += `
    <div class="border-t border-paper-line mt-1 px-2 py-2 space-y-2">
      <p class="text-sm font-medium text-accent-dark">Create period “${escapeHtml(qRaw)}”</p>
      <div class="grid grid-cols-2 gap-2">
        <div>
          <label class="text-[11px] text-ink-faint" for="period-create-from">From</label>
          <div class="flex gap-1 items-center mt-0.5">
            <input id="period-create-from" class="input py-1.5 text-sm" inputmode="numeric" placeholder="Year" value="${escapeHtml(defs.fromYear)}" />
            <select id="period-create-from-era" class="input py-1.5 text-sm w-[4.5rem] shrink-0">
              <option value="ac" ${fromEra === "ac" ? "selected" : ""}>AC</option>
              <option value="bc" ${fromEra === "bc" ? "selected" : ""}>BC</option>
            </select>
          </div>
        </div>
        <div>
          <label class="text-[11px] text-ink-faint" for="period-create-to">To</label>
          <div class="flex gap-1 items-center mt-0.5">
            <input id="period-create-to" class="input py-1.5 text-sm" inputmode="numeric" placeholder="Year" value="${escapeHtml(defs.toYear)}" />
            <select id="period-create-to-era" class="input py-1.5 text-sm w-[4.5rem] shrink-0">
              <option value="ac" ${toEra === "ac" ? "selected" : ""}>AC</option>
              <option value="bc" ${toEra === "bc" ? "selected" : ""}>BC</option>
            </select>
          </div>
        </div>
      </div>
      <button type="button" data-create-typed-period="${escapeHtml(qRaw)}"
        class="w-full text-left px-2 py-1.5 rounded-lg hover:bg-accent-soft text-sm text-accent-dark font-medium">
        Create with this range
      </button>
    </div>`;
  }
  box.innerHTML = html;
  bindPickButtons(box);
  box.querySelectorAll("[data-pick-existing]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ent = hubs.period.find((x) => x.id === btn.dataset.pickExisting);
      if (!ent) return;
      selectedBelong.period.set(ent.id, ent);
      pinnedPeriodIds.add(ent.id);
      const search = document.getElementById("belong-search-period");
      if (search) search.value = "";
      refreshBelongUI();
    });
  });
  box.querySelectorAll("[data-create-typed-period]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.createTypedPeriod;
      if (!name) return;
      const fromY = document.getElementById("period-create-from")?.value.trim();
      const toY = document.getElementById("period-create-to")?.value.trim();
      const fromEra = document.getElementById("period-create-from-era")?.value || "ac";
      const toEra = document.getElementById("period-create-to-era")?.value || "ac";
      if (!fromY || !toY) {
        toast("Set From and To years for this period");
        return;
      }
      const date_start = composeDate(fromY, null, null, fromEra);
      const date_end = composeDate(toY, null, null, toEra);
      const startN = storedToSignedYear(date_start);
      const endN = storedToSignedYear(date_end);
      if (startN != null && endN != null && startN > endN) {
        toast("From must be earlier than To");
        return;
      }
      try {
        await ensurePeriod(name, { date_start, date_end });
        const search = document.getElementById("belong-search-period");
        if (search) search.value = "";
        refreshBelongUI();
        toast(`Created “${name}”`);
      } catch (err) {
        toast(err.message || "Could not create");
      }
    });
  });
}

function renderPhaseCatalog() {
  const box = document.getElementById("belong-catalog-phase");
  if (!box) return;
  const qRaw = (document.getElementById("belong-search-phase")?.value || "").trim();
  const q = qRaw.toLowerCase();
  const selectedNames = new Set(
    [...selectedBelong.phase.values()].map((e) => e.title.toLowerCase())
  );
  const mine = (hubs.phase || [])
    .filter((p) => !selectedNames.has(p.title.toLowerCase()))
    .filter((p) => matchesQ(p.title, q))
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title));
  const exactHit = mine.some((p) => p.title.toLowerCase() === q) || selectedNames.has(q);
  const canCreate = q.length >= 2 && !exactHit;
  const defs = defaultCreateYearsFromEvent();

  if (!mine.length && !canCreate) {
    box.innerHTML = `<p class="text-xs text-ink-faint px-2 py-2">${
      q
        ? "No matches — keep typing to create a new phase."
        : (hubs.phase || []).length
          ? "All your phases are linked. Search to add another."
          : "No phases yet — search a name to create one."
    }</p>`;
    return;
  }

  let html = "";
  if (mine.length) {
    html += `<p class="text-[10px] uppercase tracking-wider text-ink-faint font-semibold px-2 pt-1.5 pb-0.5">Your phases</p>`;
    html += mine
      .map((p) => {
        const meta = periodMetaFor(p);
        const range = meta
          ? `${formatSignedYear(meta.start_year)} – ${formatSignedYear(meta.end_year)}`
          : "";
        return `
    <button type="button" data-pick-existing="${p.id}" data-pick-kind="phase"
      class="w-full text-left px-2 py-1.5 rounded-lg hover:bg-paper-deep text-sm">
      <span class="block">${escapeHtml(p.title)}</span>
      ${range ? `<span class="block text-[11px] text-ink-faint">${escapeHtml(range)}</span>` : ""}
    </button>`;
      })
      .join("");
  } else if (!q) {
    html += `<p class="text-[10px] uppercase tracking-wider text-ink-faint font-semibold px-2 pt-1.5 pb-0.5">Your phases</p>`;
    html += `<p class="text-xs text-ink-faint px-2 py-1.5">None yet — search a name to create one.</p>`;
  }

  if (canCreate) {
    const fromEra = defs.fromEra === "bc" ? "bc" : "ac";
    const toEra = defs.toEra === "bc" ? "bc" : "ac";
    html += `
    <div class="border-t border-paper-line mt-1 px-2 py-2 space-y-2">
      <p class="text-sm font-medium text-accent-dark">Create phase “${escapeHtml(qRaw)}”</p>
      <div class="grid grid-cols-2 gap-2">
        <div>
          <label class="text-[11px] text-ink-faint" for="phase-create-from">From</label>
          <div class="flex gap-1 items-center mt-0.5">
            <input id="phase-create-from" class="input py-1.5 text-sm" inputmode="numeric" placeholder="Year" value="${escapeHtml(defs.fromYear)}" />
            <select id="phase-create-from-era" class="input py-1.5 text-sm w-[4.5rem] shrink-0">
              <option value="ac" ${fromEra === "ac" ? "selected" : ""}>AC</option>
              <option value="bc" ${fromEra === "bc" ? "selected" : ""}>BC</option>
            </select>
          </div>
        </div>
        <div>
          <label class="text-[11px] text-ink-faint" for="phase-create-to">To</label>
          <div class="flex gap-1 items-center mt-0.5">
            <input id="phase-create-to" class="input py-1.5 text-sm" inputmode="numeric" placeholder="Year" value="${escapeHtml(defs.toYear)}" />
            <select id="phase-create-to-era" class="input py-1.5 text-sm w-[4.5rem] shrink-0">
              <option value="ac" ${toEra === "ac" ? "selected" : ""}>AC</option>
              <option value="bc" ${toEra === "bc" ? "selected" : ""}>BC</option>
            </select>
          </div>
        </div>
      </div>
      <button type="button" data-create-typed-phase="${escapeHtml(qRaw)}"
        class="w-full text-left px-2 py-1.5 rounded-lg hover:bg-accent-soft text-sm text-accent-dark font-medium">
        Create with this range
      </button>
    </div>`;
  }
  box.innerHTML = html;
  box.querySelectorAll("[data-pick-existing]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ent = hubs.phase.find((x) => x.id === btn.dataset.pickExisting);
      if (!ent) return;
      selectedBelong.phase.set(ent.id, ent);
      pinnedPhaseIds.add(ent.id);
      const search = document.getElementById("belong-search-phase");
      if (search) search.value = "";
      refreshBelongUI();
    });
  });
  box.querySelectorAll("[data-create-typed-phase]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.createTypedPhase;
      if (!name) return;
      const fromY = document.getElementById("phase-create-from")?.value.trim();
      const toY = document.getElementById("phase-create-to")?.value.trim();
      const fromEra = document.getElementById("phase-create-from-era")?.value || "ac";
      const toEra = document.getElementById("phase-create-to-era")?.value || "ac";
      if (!fromY || !toY) {
        toast("Set From and To years for this phase");
        return;
      }
      const date_start = composeDate(fromY, null, null, fromEra);
      const date_end = composeDate(toY, null, null, toEra);
      const startN = storedToSignedYear(date_start);
      const endN = storedToSignedYear(date_end);
      if (startN != null && endN != null && startN > endN) {
        toast("From must be earlier than To");
        return;
      }
      try {
        await ensurePhase(name, { date_start, date_end });
        const search = document.getElementById("belong-search-phase");
        if (search) search.value = "";
        refreshBelongUI();
        toast(`Created “${name}”`);
      } catch (err) {
        toast(err.message || "Could not create");
      }
    });
  });
}

function renderActorCatalog() {
  const box = document.getElementById("belong-catalog-actor");
  if (!box) return;
  const qRaw = (document.getElementById("belong-search-actor")?.value || "").trim();
  const q = qRaw.toLowerCase();
  const selectedFigure = new Set([...selectedBelong.figure.values()].map((e) => e.title.toLowerCase()));
  const mineNames = new Set(hubs.figure.map((f) => f.title.toLowerCase()));

  let mine = hubs.figure
    .filter((f) => !selectedFigure.has(f.title.toLowerCase()))
    .filter((f) => matchesQ(f.title, q))
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title));

  let catalogHits = [];
  if (q) {
    catalogHits = (catalog.figures || [])
      .filter((f) => !mineNames.has(f.name.toLowerCase()))
      .filter((f) => !selectedFigure.has(f.name.toLowerCase()))
      .filter((f) => matchesQ(f.name, q))
      .slice(0, 12);
  }

  const exactMine = mine.some((f) => f.title.toLowerCase() === q);
  const exactCatalog = (catalog.figures || []).some((f) => f.name.toLowerCase() === q);
  const canCreateTyped = q.length >= 2 && !exactMine && !exactCatalog;

  if (!mine.length && !catalogHits.length && !canCreateTyped) {
    box.innerHTML = `<p class="text-xs text-ink-faint px-2 py-2">${
      q
        ? "No matches — keep typing to create a new figure."
        : hubs.figure.length
          ? "All your figures are already linked. Search to add someone new."
          : "No figures yet. Search a name to add one from the catalog, or create a new one."
    }</p>`;
    bindPickButtons(box);
    return;
  }

  let html = "";
  if (mine.length) {
    html += `<p class="text-[10px] uppercase tracking-wider text-ink-faint font-semibold px-2 pt-1.5 pb-0.5">Your figures</p>`;
    html += mine
      .map(
        (f) => `
    <button type="button" data-pick-existing="${f.id}" data-pick-kind="figure"
      class="w-full text-left px-2 py-1.5 rounded-lg hover:bg-paper-deep text-sm">
      ${escapeHtml(f.title)}
    </button>`
      )
      .join("");
  } else if (!q) {
    html += `<p class="text-[10px] uppercase tracking-wider text-ink-faint font-semibold px-2 pt-1.5 pb-0.5">Your figures</p>`;
    html += `<p class="text-xs text-ink-faint px-2 py-1.5">None yet — search a name to add one.</p>`;
  }

  if (catalogHits.length) {
    html += `<p class="text-[10px] uppercase tracking-wider text-ink-faint font-semibold px-2 pt-2 pb-0.5 border-t border-paper-line mt-1">Add from catalog</p>`;
    html += catalogHits
      .map(
        (f) => `
    <button type="button" data-pick-kind="figure" data-pick-name="${escapeHtml(f.name)}" data-pick-flag=""
      class="w-full text-left px-2 py-1.5 rounded-lg hover:bg-paper-deep text-sm flex items-center justify-between gap-2">
      <span>${escapeHtml(f.name)}</span>
      <span class="text-[11px] text-accent-dark shrink-0">Add</span>
    </button>`
      )
      .join("");
  }

  if (canCreateTyped) {
    html += `
    <button type="button" data-create-typed-figure="${escapeHtml(qRaw)}"
      class="w-full text-left px-2 py-1.5 rounded-lg hover:bg-accent-soft text-sm text-accent-dark font-medium border-t border-paper-line mt-1">
      Create “${escapeHtml(qRaw)}”
    </button>`;
  }

  box.innerHTML = html;
  bindPickButtons(box);
  box.querySelectorAll("[data-pick-existing]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ent = hubs.figure.find((x) => x.id === btn.dataset.pickExisting);
      if (!ent) return;
      selectedBelong.figure.set(ent.id, ent);
      const search = document.getElementById("belong-search-actor");
      if (search) search.value = "";
      refreshBelongUI();
    });
  });
  box.querySelectorAll("[data-create-typed-figure]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.createTypedFigure;
      if (!name) return;
      try {
        await ensureTyped("figure", name);
        const search = document.getElementById("belong-search-actor");
        if (search) search.value = "";
        refreshBelongUI();
        toast(`Added “${name}”`);
      } catch (err) {
        toast(err.message || "Could not create");
      }
    });
  });
}

function bindPickButtons(box) {
  box.querySelectorAll("[data-pick-kind]").forEach((btn) => {
    if (
      btn.hasAttribute("data-pick-existing") ||
      btn.hasAttribute("data-create-typed-figure") ||
      btn.hasAttribute("data-create-typed-period") ||
      btn.hasAttribute("data-create-typed-phase")
    ) {
      return;
    }
    btn.addEventListener("click", () => {
      pickFromCatalog(btn.dataset.pickKind, btn.dataset.pickName, btn.dataset.pickFlag || "");
    });
  });
}

function syncPlaceSummary() {
  const el = document.getElementById("place-summary");
  if (!el) return;
  const place = primaryPlace();
  el.textContent = place ? displayHubLabel("country", place) : "Choose a country or World";
}

async function setPrimaryPlace(name, flagHint = "") {
  clearPrimaryPlaces();
  const existing = hubs.country.find((e) => e.title.toLowerCase() === name.toLowerCase());
  if (existing) {
    selectedBelong.country.set(existing.id, existing);
  } else {
    const flag = flagHint || flagForCountry(name);
    const created = await api.createEntity({
      type: "place",
      title: name,
      summary: flag || null,
      tags: [],
      attachments: [],
      period_ids: [],
      country_ids: [],
      figure_ids: [],
      link_ids: [],
    });
    hubs.country.push(created);
    hubs.country.sort((a, b) => a.title.localeCompare(b.title));
    selectedBelong.country.set(created.id, created);
  }
  pruneEmpiresForPrimary();
  refreshBelongUI();
  return primaryPlace();
}

/** Resolve free-text country names to place entity IDs (create places when missing). */
async function ensurePlacesForNames(names) {
  const cleaned = [...new Set(names.map((n) => String(n || "").trim()).filter(Boolean))];
  if (!cleaned.length) return [];

  if (!catalog.countries?.length && !catalog.empires?.length) {
    try {
      const cat = await api.catalog();
      catalog.countries = cat.countries || [];
      catalog.empires = cat.empires || [];
    } catch {
      /* flags optional */
    }
  }

  let places = hubs.country?.length ? hubs.country : await api.listEntities({ type: "place" });
  const ids = [];

  for (const name of cleaned) {
    let place = places.find((p) => p.title.toLowerCase() === name.toLowerCase());
    if (!place) {
      const flag = flagForCountry(name);
      place = await api.createEntity({
        type: "place",
        title: name,
        summary: flag || null,
        tags: [],
        attachments: [],
        period_ids: [],
        country_ids: [],
        figure_ids: [],
        link_ids: [],
      });
      places.push(place);
      if (hubs.country) {
        hubs.country.push(place);
        hubs.country.sort((a, b) => a.title.localeCompare(b.title));
      }
    }
    ids.push(place.id);
  }

  return ids;
}

async function loadSavedCountries() {
  try {
    hubs.country = await api.listEntities({ type: "place" });
    hubs.country.sort((a, b) => a.title.localeCompare(b.title));
  } catch {
    hubs.country = hubs.country || [];
  }
  return hubs.country;
}

function savedCountryFlag(place) {
  const summary = (place.summary || "").trim();
  return flagForCountry(place.title) || (summary && !summary.includes(" ") ? summary : "");
}

function renderSavedCountryCatalog({ boxId, searchId, excludeNames = [], onPick, mode = "pick" }) {
  const box = document.getElementById(boxId);
  if (!box) return;
  const qRaw = (document.getElementById(searchId)?.value || "").trim();
  const q = qRaw.toLowerCase();
  const excluded = new Set(excludeNames.map((n) => String(n).toLowerCase()));
  const places = (hubs.country || [])
    .filter((p) => !excluded.has(p.title.toLowerCase()))
    .filter((p) => matchesQ(p.title, q))
    .sort((a, b) => {
      if (a.title === "World") return -1;
      if (b.title === "World") return 1;
      return a.title.localeCompare(b.title);
    });

  const exactMatch =
    places.some((p) => p.title.toLowerCase() === q) || excluded.has(q);
  const canCreate = q.length >= 1 && !exactMatch;

  let html = "";
  if (places.length) {
    html += `<p class="text-[10px] uppercase tracking-wider text-ink-faint font-semibold px-2 pt-1.5 pb-0.5">Your countries</p>`;
    html += places
      .map((p) => {
        const flag = savedCountryFlag(p);
        return `
      <button type="button" data-pick-country="${escapeHtml(p.title)}"
        class="w-full text-left px-2 py-1.5 rounded-lg hover:bg-paper-deep text-sm flex items-center gap-2">
        ${flag ? `<span class="text-base leading-none">${flag}</span>` : ""}
        <span class="flex-1 min-w-0">${escapeHtml(p.title)}</span>
        <span class="text-[11px] text-accent-dark shrink-0">${mode === "fill" ? "Select" : "Add"}</span>
      </button>`;
      })
      .join("");
  } else if (!q) {
    html += `<p class="text-xs text-ink-faint px-2 py-2">No countries yet — type a name to add one.</p>`;
  } else {
    html += `<p class="text-xs text-ink-faint px-2 py-2">No matches in your countries.</p>`;
  }

  if (canCreate) {
    html += `
    <button type="button" data-create-country="${escapeHtml(qRaw)}"
      class="w-full text-left px-2 py-1.5 rounded-lg hover:bg-accent-soft text-sm text-accent-dark font-medium border-t border-paper-line mt-1">
      ${mode === "fill" ? "Use" : "Add"} “${escapeHtml(qRaw)}”
    </button>`;
  }

  box.innerHTML = html;
  box.querySelectorAll("[data-pick-country]").forEach((btn) => {
    btn.addEventListener("click", () => onPick(btn.dataset.pickCountry));
  });
  box.querySelectorAll("[data-create-country]").forEach((btn) => {
    btn.addEventListener("click", () => onPick(btn.dataset.createCountry));
  });
}

async function ensureEmpire(name, flagHint = "") {
  const existing = hubs.country.find((e) => e.title.toLowerCase() === name.toLowerCase());
  if (existing) {
    selectedBelong.country.set(existing.id, existing);
    return existing;
  }
  const flag = flagHint || flagForCountry(name) || "🏛️";
  const created = await api.createEntity({
    type: "place",
    title: name,
    summary: flag,
    tags: [],
    attachments: [],
    period_ids: [],
    country_ids: [],
    figure_ids: [],
    link_ids: [],
  });
  hubs.country.push(created);
  hubs.country.sort((a, b) => a.title.localeCompare(b.title));
  selectedBelong.country.set(created.id, created);
  return created;
}

function refreshBelongUI() {
  renderCountryChips();
  renderPeriodChips();
  renderPhaseChips();
  renderActorChips();
  renderCountryCatalog();
  renderPeriodCatalog();
  renderPhaseCatalog();
  renderActorCatalog();
  syncBelongHint();
  syncPlaceSummary();
  syncDateConstraints();
}

async function setPrimaryPeriod(name) {
  await ensurePeriod(name);
  refreshBelongUI();
}

/** Create or reuse a notebook period (dates from the create form when provided). */
async function ensurePeriod(name, { date_start = undefined, date_end = undefined } = {}) {
  const existing = hubs.period.find((e) => e.title.toLowerCase() === name.toLowerCase());
  if (existing) {
    if ((!existing.date_start && !existing.date_end) && (date_start != null || date_end != null)) {
      try {
        const updated = await api.updateEntity(existing.id, {
          date_start: date_start ?? null,
          date_end: date_end ?? null,
        });
        Object.assign(existing, updated);
      } catch {
        /* keep selecting even if backfill fails */
      }
    }
    selectedBelong.period.set(existing.id, existing);
    pinnedPeriodIds.add(existing.id);
    return existing;
  }

  const start = date_start === undefined ? null : date_start;
  const end = date_end === undefined ? null : date_end;

  const created = await api.createEntity({
    type: "period",
    title: name,
    summary: null,
    date_start: start ?? null,
    date_end: end ?? null,
    tags: [],
    attachments: [],
    period_ids: [],
    country_ids: [],
    figure_ids: [],
    link_ids: [],
  });
  hubs.period.push(created);
  hubs.period.sort((a, b) => a.title.localeCompare(b.title));
  selectedBelong.period.set(created.id, created);
  pinnedPeriodIds.add(created.id);
  return created;
}

/** Create or reuse a phase with From–To; auto-links overlapping periods. */
async function ensurePhase(name, { date_start = null, date_end = null } = {}) {
  const existing = hubs.phase.find((e) => e.title.toLowerCase() === name.toLowerCase());
  if (existing) {
    selectedBelong.phase.set(existing.id, existing);
    pinnedPhaseIds.add(existing.id);
    return existing;
  }

  const startN = storedToSignedYear(date_start);
  const endN = storedToSignedYear(date_end);
  const periodIdSet = new Set(autoAssignPeriodsForRange(startN, endN).map((p) => p.id));
  for (const id of selectedBelong.period.keys()) periodIdSet.add(id);

  const created = await api.createEntity({
    type: "phase",
    title: name,
    summary: null,
    date_start: date_start ?? null,
    date_end: date_end ?? null,
    tags: [],
    attachments: [],
    period_ids: [...periodIdSet],
    country_ids: [],
    figure_ids: [],
    link_ids: [],
  });
  hubs.phase.push(created);
  hubs.phase.sort((a, b) => a.title.localeCompare(b.title));
  selectedBelong.phase.set(created.id, created);
  pinnedPhaseIds.add(created.id);
  return created;
}

async function ensureTyped(kind, name) {
  if (kind === "period") return ensurePeriod(name);
  const existing = hubs[kind].find((e) => e.title.toLowerCase() === name.toLowerCase());
  if (existing) {
    selectedBelong[kind].set(existing.id, existing);
    return existing;
  }
  const created = await api.createEntity({
    type: kind,
    title: name,
    summary: null,
    tags: [],
    attachments: [],
    period_ids: [],
    country_ids: [],
    figure_ids: [],
    link_ids: [],
  });
  hubs[kind].push(created);
  hubs[kind].sort((a, b) => a.title.localeCompare(b.title));
  selectedBelong[kind].set(created.id, created);
  return created;
}

async function pickFromCatalog(kind, name, flag) {
  try {
    if (kind === "country") {
      await setPrimaryPlace(name, flag);
      const search = document.getElementById("belong-search-country");
      if (search) search.value = "";
      return;
    }
    if (kind === "empire") {
      const place = primaryPlace();
      if (!place || isWorldTitle(place.title)) {
        toast("Pick a country first to add an empire");
        return;
      }
      const already = selectedEmpires().find((e) => e.title.toLowerCase() === name.toLowerCase());
      if (already) {
        selectedBelong.country.delete(already.id);
        refreshBelongUI();
        return;
      }
      await ensureEmpire(name, flag || "🏛️");
      refreshBelongUI();
      return;
    }
    if (kind === "period") {
      await setPrimaryPeriod(name);
      const search = document.getElementById("belong-search-period");
      if (search) search.value = "";
      return;
    }
    if (kind === "figure") {
      await ensureTyped("figure", name);
      const search = document.getElementById("belong-search-actor");
      if (search) search.value = "";
      refreshBelongUI();
    }
  } catch (err) {
    toast(err.message || "Could not add");
  }
}

function renderRelatedChips() {
  const box = document.getElementById("link-chips");
  if (!box) return;
  if (selectedRelated.size === 0) {
    box.innerHTML = `<span class="text-xs text-ink-faint">No related events yet</span>`;
    return;
  }
  box.innerHTML = [...selectedRelated.values()]
    .map(
      (e) => `
      <button type="button" data-unlink="${e.id}" class="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-accent-soft text-accent-dark text-xs font-medium">
        @${escapeHtml(e.title)}
        <span aria-hidden="true">×</span>
      </button>`
    )
    .join("");
  box.querySelectorAll("[data-unlink]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedRelated.delete(btn.dataset.unlink);
      renderRelatedChips();
    });
  });
}

function renderAtResults(query) {
  const box = document.getElementById("at-results");
  if (!box) return;
  let q = (query || "").trim();
  if (q.startsWith("@")) q = q.slice(1);
  q = q.toLowerCase();
  if (!q) {
    box.innerHTML = "";
    return;
  }
  const hits = allEvents
    .filter((e) => !selectedRelated.has(e.id))
    .filter((e) => e.title.toLowerCase().includes(q) || (e.summary || "").toLowerCase().includes(q))
    .slice(0, 8);
  if (!hits.length) {
    box.innerHTML = `<p class="text-xs text-ink-faint px-1 py-2">No matching events</p>`;
    return;
  }
  box.innerHTML = hits
    .map(
      (e) => `
    <button type="button" data-pick="${e.id}" class="w-full text-left px-2 py-1.5 rounded-lg hover:bg-paper-deep text-sm">
      @${escapeHtml(e.title)}
    </button>`
    )
    .join("");
  box.querySelectorAll("[data-pick]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ent = allEvents.find((x) => x.id === btn.dataset.pick);
      if (ent) {
        selectedRelated.set(ent.id, ent);
        document.getElementById("at-search").value = "";
        renderRelatedChips();
        renderAtResults("");
      }
    });
  });
}

function renderAttachments() {
  const box = document.getElementById("file-list");
  if (!box) return;
  if (!attachments.length) {
    box.innerHTML = `<span class="text-xs text-ink-faint">Paste an image or URL here — nothing added yet</span>`;
    return;
  }
  box.innerHTML = attachments
    .map(
      (url, i) => `
      <div class="flex items-center gap-3 text-sm py-1">
        ${mediaPreviewHtml(url, { className: "h-14 w-14 object-cover rounded-lg border border-paper-line shrink-0" })}
        <a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="text-accent hover:underline truncate flex-1 min-w-0">${escapeHtml(isImageUrl(url) ? "Image" : url)}</a>
        <button type="button" data-rm-file="${i}" class="btn-ghost text-xs px-2 py-0.5 shrink-0">Remove</button>
      </div>`
    )
    .join("");
  box.querySelectorAll("[data-rm-file]").forEach((btn) => {
    btn.addEventListener("click", () => {
      attachments.splice(parseInt(btn.dataset.rmFile, 10), 1);
      renderAttachments();
    });
  });
}

function mediaBlockHtml() {
  return `
    <div id="media-block" class="rounded-xl border border-dashed border-paper-line bg-paper-deep/20 p-3" tabindex="0">
      <label class="label">Media</label>
      <p class="text-xs text-ink-faint -mt-1 mb-2">Click here and paste an image (Cmd+V), drop a file, paste a URL, or browse.</p>
      <div class="flex flex-wrap gap-2">
        <input id="file-input" class="input flex-1 min-w-[12rem]" placeholder="Image URL…" />
        <button type="button" id="file-add" class="btn-secondary px-3">Add URL</button>
        <button type="button" id="file-browse" class="btn-secondary px-3">Browse…</button>
        <input type="file" id="file-picker" accept="image/jpeg,image/png,image/gif,image/webp" class="hidden" />
      </div>
      <div id="file-list" class="mt-2 space-y-1"></div>
    </div>`;
}

function extForMime(mime) {
  const m = (mime || "").toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("gif")) return "gif";
  if (m.includes("webp")) return "webp";
  return "png";
}

function fileFromBlob(blob, mimeType = "") {
  const type = blob.type || mimeType || "image/png";
  if (blob instanceof File && blob.name && blob.type) return blob;
  const ext = extForMime(type);
  return new File([blob], `pasted-${Date.now()}.${ext}`, { type });
}

async function blobFromDataUrl(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

/** @returns {Promise<{ blob: Blob, type: string } | null>} */
async function readClipboardImage(dataTransfer) {
  if (!dataTransfer) return null;

  for (const file of dataTransfer.files || []) {
    if (file.type.startsWith("image/")) {
      return { blob: file, type: file.type };
    }
  }

  for (const item of dataTransfer.items || []) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const blob = item.getAsFile();
      if (blob) return { blob, type: item.type || blob.type || "image/png" };
    }
  }

  const text = dataTransfer.getData("text/plain")?.trim();
  if (text?.startsWith("data:image/")) {
    try {
      const blob = await blobFromDataUrl(text);
      if (blob.type.startsWith("image/")) return { blob, type: blob.type };
    } catch {
      /* ignore bad data URL */
    }
  }

  return null;
}

function bindMediaHandlers() {
  mediaHandlersAbort?.abort();
  mediaHandlersAbort = new AbortController();
  const { signal } = mediaHandlersAbort;

  async function addMediaUrl(url) {
    const trimmed = String(url || "").trim();
    if (!trimmed || attachments.includes(trimmed)) return;
    attachments.push(trimmed);
    renderAttachments();
  }

  let uploading = false;

  async function addMediaBlob(blob, mimeType = "") {
    if (uploading) return;
    uploading = true;
    try {
      const file = fileFromBlob(blob, mimeType);
      const { url, embedded } = await api.uploadOrEmbed(file);
      await addMediaUrl(url);
      toast(embedded ? "Image added (embedded)" : "Image added");
    } catch (err) {
      toast(err.message || "Could not add image");
    } finally {
      uploading = false;
    }
  }

  async function handleClipboardPaste(e) {
    if (e.defaultPrevented) return false;
    const image = await readClipboardImage(e.clipboardData);
    if (image) {
      e.preventDefault();
      await addMediaBlob(image.blob, image.type);
      return true;
    }
    if (e.target?.id === "file-input") {
      const text = e.clipboardData?.getData("text/plain")?.trim();
      if (text && /^https?:\/\//i.test(text)) {
        e.preventDefault();
        await addMediaUrl(text);
        const input = document.getElementById("file-input");
        if (input) input.value = "";
        return true;
      }
    }
    return false;
  }

  function addFile() {
    const input = document.getElementById("file-input");
    addMediaUrl(input?.value);
    if (input) input.value = "";
  }

  document.getElementById("file-add")?.addEventListener("click", addFile, { signal });
  document.getElementById("file-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addFile();
    }
  }, { signal });

  document.getElementById("file-browse")?.addEventListener("click", () => {
    document.getElementById("file-picker")?.click();
  }, { signal });

  document.getElementById("file-picker")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (file) await addMediaBlob(file, file.type);
    e.target.value = "";
  }, { signal });

  const mediaBlock = document.getElementById("media-block");
  mediaBlock?.addEventListener("dragover", (e) => {
    if ([...e.dataTransfer?.types || []].includes("Files")) {
      e.preventDefault();
      mediaBlock.classList.add("border-accent", "bg-accent-soft/30");
    }
  }, { signal });

  mediaBlock?.addEventListener("dragleave", () => {
    mediaBlock.classList.remove("border-accent", "bg-accent-soft/30");
  }, { signal });

  mediaBlock?.addEventListener("drop", async (e) => {
    e.preventDefault();
    mediaBlock.classList.remove("border-accent", "bg-accent-soft/30");
    const file = [...e.dataTransfer?.files || []].find((f) => f.type.startsWith("image/"));
    if (file) await addMediaBlob(file, file.type);
  }, { signal });

  // Paste works anywhere in the modal while it is open (not only when the URL field is focused).
  document.getElementById("modal-panel")?.addEventListener("paste", (e) => {
    void handleClipboardPaste(e);
  }, { signal });
}

function categorySelectHtml(categories, selected = "", { error = "" } = {}) {
  if (error) {
    return `
      <div>
        <label class="label">Classification</label>
        <p class="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">${escapeHtml(error)}</p>
        <input id="entity-category" type="hidden" value="${escapeHtml(selected)}" />
      </div>`;
  }
  if (!categories?.length) {
    return `
      <div>
        <label class="label">Classification</label>
        <p class="text-xs text-ink-faint">Add options in Settings → Classifications, then reopen this form.</p>
        <input id="entity-category" type="hidden" value="" />
      </div>`;
  }
  return `
    <div>
      <label class="label" for="entity-category">Classification</label>
      <select id="entity-category" class="select">
        <option value="">— None —</option>
        ${categories
          .map(
            (c) =>
              `<option value="${escapeHtml(c)}" ${c === selected ? "selected" : ""}>${escapeHtml(c)}</option>`
          )
          .join("")}
      </select>
    </div>`;
}

async function loadUserCategories() {
  const categories = await api.getUserCategories();
  return { categories, error: "" };
}

function freeTextCountryHtml(id, value = "", { label = "Country / territory" } = {}) {
  return `
    <div>
      <label class="label" for="${id}">${label} <span class="font-normal text-ink-faint">(optional)</span></label>
      <p class="text-xs text-ink-faint -mt-1">Type any name — modern or historic.</p>
      <input id="${id}" class="input" maxlength="500" placeholder="e.g. Wessex, Frankish Empire" value="${escapeHtml(value)}" autocomplete="off" />
    </div>`;
}

function eventCountriesBlockHtml() {
  return `
    <div>
      <label class="label" for="qa-country-input">Countries / territories</label>
      <p class="text-xs text-ink-faint -mt-1">Pick from your countries or type a new name — e.g. Germany, France, Rome.</p>
      <div class="flex gap-2">
        <input id="qa-country-input" class="input flex-1" maxlength="500" placeholder="Search or type a country…" autocomplete="off" />
        <button type="button" id="qa-country-add" class="btn-secondary px-3 shrink-0">Add</button>
      </div>
      <div id="qa-country-catalog" class="mt-2 max-h-40 overflow-y-auto rounded-lg border border-paper-line bg-paper-deep/30"></div>
      <div id="qa-country-chips" class="flex flex-wrap gap-1.5 mt-2 min-h-[1.5rem]"></div>
    </div>`;
}

function renderEventCountryChips(countries) {
  const box = document.getElementById("qa-country-chips");
  if (!box) return;
  if (!countries.length) {
    box.innerHTML = `<span class="text-xs text-ink-faint">No countries yet — add one above.</span>`;
    return;
  }
  box.innerHTML = countries
    .map(
      (c, i) => `
      <button type="button" data-rm-country="${i}" class="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-paper-deep text-sm">
        ${escapeHtml(c)}
        <span aria-hidden="true">×</span>
      </button>`
    )
    .join("");
  box.querySelectorAll("[data-rm-country]").forEach((btn) => {
    btn.addEventListener("click", () => {
      countries.splice(parseInt(btn.dataset.rmCountry, 10), 1);
      renderEventCountryChips(countries);
    });
  });
}

function bindEventCountryHandlers(countries) {
  function refreshCatalog() {
    renderSavedCountryCatalog({
      boxId: "qa-country-catalog",
      searchId: "qa-country-input",
      excludeNames: countries,
      onPick: (name) => {
        if (!name) return;
        if (countries.some((c) => c.toLowerCase() === name.toLowerCase())) {
          toast("Already added");
          return;
        }
        countries.push(name);
        const input = document.getElementById("qa-country-input");
        if (input) input.value = "";
        renderEventCountryChips(countries);
        refreshCatalog();
      },
    });
  }

  function addCountry() {
    const input = document.getElementById("qa-country-input");
    const val = input?.value.trim();
    if (!val) return;
    if (countries.some((c) => c.toLowerCase() === val.toLowerCase())) {
      toast("Already added");
      return;
    }
    countries.push(val);
    if (input) input.value = "";
    renderEventCountryChips(countries);
    refreshCatalog();
  }
  document.getElementById("qa-country-add")?.addEventListener("click", addCountry);
  document.getElementById("qa-country-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addCountry();
    }
  });
  document.getElementById("qa-country-input")?.addEventListener("input", refreshCatalog);
  renderEventCountryChips(countries);
  refreshCatalog();
}

function renderTagChips(tags) {
  const box = document.getElementById("tag-chips");
  if (!box) return;
  if (!tags.length) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = tags
    .map(
      (t, i) => `
      <button type="button" data-rm-tag="${i}" class="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-paper-deep text-ink-muted text-xs">
        #${escapeHtml(t)}
        <span aria-hidden="true">×</span>
      </button>`
    )
    .join("");
  box.querySelectorAll("[data-rm-tag]").forEach((btn) => {
    btn.addEventListener("click", () => {
      tags.splice(parseInt(btn.dataset.rmTag, 10), 1);
      renderTagChips(tags);
    });
  });
}

function periodDateBlock(fromParts, toParts = null) {
  const to = toParts || { year: "", month: "", day: "", era: fromParts.era || "ac" };
  return `
    <div class="rounded-lg border border-paper-line bg-paper-deep/30 p-2.5 space-y-3">
      <div>
        <p class="text-[10px] uppercase tracking-wider text-ink-faint font-semibold">Event dates</p>
        <p id="date-period-hint" class="text-xs text-ink-faint">Set From / To with AC or BC — periods map from the range.</p>
      </div>
      <div>
        <p class="text-xs font-medium text-ink-muted mb-1">From</p>
        <div class="grid grid-cols-3 gap-2">
          <input id="qa-from-day" class="input" type="number" min="1" max="31" placeholder="Day" value="${escapeHtml(fromParts.day)}" />
          <input id="qa-from-month" class="input" type="number" min="1" max="12" placeholder="Month" value="${escapeHtml(fromParts.month)}" />
          <input id="qa-from-year" class="input" type="number" placeholder="Year" value="${escapeHtml(fromParts.year)}" />
        </div>
        <div class="flex gap-3 mt-1.5">
          <label class="inline-flex items-center gap-1.5 text-xs cursor-pointer">
            <input type="radio" name="qa-from-era" value="ac" ${fromParts.era !== "bc" ? "checked" : ""} class="accent-accent" /> AC
          </label>
          <label class="inline-flex items-center gap-1.5 text-xs cursor-pointer">
            <input type="radio" name="qa-from-era" value="bc" ${fromParts.era === "bc" ? "checked" : ""} class="accent-accent" /> BC
          </label>
        </div>
      </div>
      <div>
        <p class="text-xs font-medium text-ink-muted mb-1">To <span class="font-normal text-ink-faint">(optional)</span></p>
        <div class="grid grid-cols-3 gap-2">
          <input id="qa-to-day" class="input" type="number" min="1" max="31" placeholder="Day" value="${escapeHtml(to.day)}" />
          <input id="qa-to-month" class="input" type="number" min="1" max="12" placeholder="Month" value="${escapeHtml(to.month)}" />
          <input id="qa-to-year" class="input" type="number" placeholder="Year" value="${escapeHtml(to.year)}" />
        </div>
        <div class="flex gap-3 mt-1.5">
          <label class="inline-flex items-center gap-1.5 text-xs cursor-pointer">
            <input type="radio" name="qa-to-era" value="ac" ${to.era !== "bc" ? "checked" : ""} class="accent-accent" /> AC
          </label>
          <label class="inline-flex items-center gap-1.5 text-xs cursor-pointer">
            <input type="radio" name="qa-to-era" value="bc" ${to.era === "bc" ? "checked" : ""} class="accent-accent" /> BC
          </label>
        </div>
      </div>
    </div>
  `;
}

function belongStep(step, stepNum, label, placeholder, catalogHeight = "max-h-40", { dateParts = null, dateEndParts = null } = {}) {
  const stepLabel = stepNum
    ? `<span class="text-ink-faint font-normal mr-1">${stepNum}.</span>${label}`
    : label;
  const showLock = false;
  const dateBlock = step === "period" && dateParts ? periodDateBlock(dateParts, dateEndParts) : "";
  return `
    <div id="belong-step-${step}" class="rounded-xl border border-paper-line p-3 bg-white space-y-3">
      <div>
        <div class="flex items-baseline justify-between gap-2 mb-1">
          <label class="label mb-0" for="belong-search-${step}">${stepLabel}</label>
          <span id="belong-lock-${step}" class="text-[11px] text-ink-faint ${showLock ? "" : "hidden"}">Needs country first</span>
        </div>
        <input id="belong-search-${step}" class="input w-full" placeholder="${placeholder}" autocomplete="off" />
        <div id="belong-catalog-${step}" class="mt-2 ${catalogHeight} overflow-y-auto rounded-lg border border-paper-line bg-paper-deep/30"></div>
        <div id="belong-chips-${step}" class="flex flex-wrap gap-1.5 mt-2"></div>
      </div>
      ${dateBlock}
    </div>
  `;
}

export async function openQuickAdd({
  onSaved,
  editEntity = null,
  neighbors = null,
  preselectFigures = [],
  preselectPeriod = null,
  preselectPhase = null,
} = {}) {
  const isEdit = Boolean(editEntity?.id);
  let events;
  let periods;
  let phases;
  let places;
  let figures;
  let catalogData = { countries: [], empires: [], figures: [] };
  let userCategories = [];
  let categoriesError = "";
  try {
    const [lists, catalogResult, catResult] = await Promise.all([
      Promise.all([
        api.listEntities({ type: "event" }),
        api.listEntities({ type: "period" }),
        api.listEntities({ type: "phase" }),
        api.listEntities({ type: "place" }),
        api.listEntities({ type: "figure" }),
      ]),
      api.catalog().catch(() => ({ countries: [], empires: [], figures: [] })),
      loadUserCategories(),
    ]);
    [events, periods, phases, places, figures] = lists;
    catalogData = catalogResult;
    userCategories = catResult.categories;
    categoriesError = catResult.error;
  } catch (err) {
    toast(err.message || "Could not open Add event");
    throw err;
  }
  allEvents = events.filter((e) => !isEdit || e.id !== editEntity.id);
  hubs = { period: periods, phase: phases, country: places, figure: figures };
  catalog = {
    countries: catalogData?.countries || [],
    empires: catalogData?.empires || [],
    figures: catalogData?.figures || [],
  };
  selectedRelated = new Map();
  selectedBelong = { period: new Map(), phase: new Map(), country: new Map(), figure: new Map() };
  pinnedPeriodIds = new Set();
  pinnedPhaseIds = new Set();
  attachments = isEdit ? [...(editEntity.attachments || [])] : [];
  const tags = isEdit ? [...(editEntity.tags || [])] : [];
  const eventCountries = [];
  if (isEdit) {
    if (editEntity.country_names?.length) {
      eventCountries.push(...editEntity.country_names);
    } else if (editEntity.country_name) {
      eventCountries.push(editEntity.country_name);
    }
  }

  if (isEdit && neighbors) {
    const related = neighbors.related || {};
    for (const item of related.period || []) {
      selectedBelong.period.set(item.entity.id, item.entity);
      pinnedPeriodIds.add(item.entity.id);
    }
    for (const item of related.phase || []) {
      selectedBelong.phase.set(item.entity.id, item.entity);
      pinnedPhaseIds.add(item.entity.id);
    }
    for (const item of related.place || []) {
      const title = item.entity?.title;
      if (title && !eventCountries.some((c) => c.toLowerCase() === title.toLowerCase())) {
        eventCountries.push(title);
      }
    }
    for (const item of related.figure || []) {
      selectedBelong.figure.set(item.entity.id, item.entity);
    }
    for (const item of related.event || []) {
      if (item.direction === "out" || item.relation === "related_to") {
        selectedRelated.set(item.entity.id, item.entity);
      }
    }
    for (const item of neighbors.backlinks || []) {
      if (item.entity.type === "event") {
        selectedRelated.set(item.entity.id, item.entity);
      }
    }
  }

  for (const fig of preselectFigures || []) {
    if (!fig?.id) continue;
    selectedBelong.figure.set(fig.id, fig);
    if (!hubs.figure.some((f) => f.id === fig.id)) {
      hubs.figure.push(fig);
    }
  }

  if (!isEdit && preselectPeriod?.id) {
    selectedBelong.period.set(preselectPeriod.id, preselectPeriod);
    pinnedPeriodIds.add(preselectPeriod.id);
    if (!hubs.period.some((p) => p.id === preselectPeriod.id)) {
      hubs.period.push(preselectPeriod);
    }
  }

  if (!isEdit && preselectPhase?.id) {
    selectedBelong.phase.set(preselectPhase.id, preselectPhase);
    pinnedPhaseIds.add(preselectPhase.id);
    if (!hubs.phase.some((p) => p.id === preselectPhase.id)) {
      hubs.phase.push(preselectPhase);
    }
  }

  const dateParts = isEdit ? splitDateParts(editEntity.date_start) : { year: "", month: "", day: "", era: "ac" };
  const dateEndParts = isEdit
    ? splitDateParts(editEntity.date_end)
    : { year: "", month: "", day: "", era: "ac" };
  const eraSeed = preselectPhase || preselectPeriod;
  if (!isEdit && eraSeed?.id) {
    const meta = periodMetaFor(eraSeed);
    if (meta?.end_year != null && meta.end_year < 0) {
      dateParts.era = "bc";
      dateEndParts.era = "bc";
    } else if (meta?.start_year != null && meta.start_year > 0) {
      dateParts.era = "ac";
      dateEndParts.era = "ac";
    }
  }

  const panel = document.getElementById("modal-panel");
  const contextNote = !isEdit
    ? (preselectFigures || [])[0]?.title
      ? ` · for ${(preselectFigures || [])[0].title}`
      : preselectPhase?.title
        ? ` · in ${preselectPhase.title}`
        : preselectPeriod?.title
          ? ` · in ${preselectPeriod.title}`
          : ""
    : "";
  panel.innerHTML = `
    <div class="flex items-start justify-between mb-4">
      <div>
        <h2 class="font-display text-xl flex items-center gap-2">${iconEvent()} ${isEdit ? "Edit event" : "Add event"}</h2>
        <p id="wizard-sub" class="text-sm text-ink-muted mt-0.5">Step 1 of 2 — title, country &amp; figures${escapeHtml(contextNote)}</p>
      </div>
      <button type="button" class="btn-ghost text-lg leading-none" data-close-modal aria-label="Close">×</button>
    </div>

    <div class="flex gap-2 mb-5" aria-hidden="true">
      <div id="wizard-dot-1" class="h-1 flex-1 rounded-full bg-accent"></div>
      <div id="wizard-dot-2" class="h-1 flex-1 rounded-full bg-paper-line"></div>
    </div>

    <form id="quick-add-form" class="space-y-4">
      <div id="wizard-step-1" class="space-y-4">
        <div>
          <label class="label" for="qa-title">What happened?</label>
          <input id="qa-title" class="input text-lg" required maxlength="500" placeholder="e.g. Union of the Principalities" value="${escapeHtml(isEdit ? editEntity.title : "")}" autofocus />
        </div>
        ${eventCountriesBlockHtml()}
        <div class="space-y-3">
          ${belongStep("actor", "", "Figures involved", "Search your figures, or type a name to add…", "max-h-48")}
          <p class="text-xs text-ink-faint -mt-1">Link people this event belongs to — e.g. a ruler, general, or key figure.</p>
        </div>
        <div class="flex justify-end gap-2 pt-1">
          <button type="button" class="btn-ghost" data-close-modal>Cancel</button>
          <button type="button" id="wizard-next" class="btn-primary px-5 py-2.5">Continue</button>
        </div>
      </div>

      <div id="wizard-step-2" class="space-y-4 hidden">
        <div>
          <p id="belong-hint" class="text-xs text-ink-faint mt-0 mb-2">Enter dates to auto-map, or search to add periods and phases.</p>
          ${periodDateBlock(dateParts, dateEndParts)}
          <div class="mt-3 space-y-3">
            ${belongStep("period", "", "Periods", "Search periods, or type a name to create…", "max-h-40")}
            ${belongStep("phase", "", "Phases", "Search phases, or type a name to create…", "max-h-40")}
          </div>
        </div>

        <div>
          <label class="label" for="qa-note">Note <span class="font-normal text-ink-faint">(optional)</span></label>
          <textarea id="qa-note" class="textarea" placeholder="Short note…">${escapeHtml(isEdit ? editEntity.summary || "" : "")}</textarea>
        </div>

        <div>
          <label class="label" for="at-search">Related events (@)</label>
          <input id="at-search" class="input" placeholder="Type @ or search…" autocomplete="off" />
          <div id="at-results" class="mt-1 max-h-28 overflow-y-auto"></div>
          <div id="link-chips" class="flex flex-wrap gap-1.5 mt-2"></div>
        </div>

        <div>
          <label class="label" for="tag-input">Tags</label>
          <div class="flex gap-2">
            <input id="tag-input" class="input flex-1" placeholder="#europe — Enter to add" />
            <button type="button" id="tag-add" class="btn-secondary px-3">Add</button>
          </div>
          <div id="tag-chips" class="flex flex-wrap gap-1.5 mt-2"></div>
        </div>

        ${categorySelectHtml(userCategories, isEdit ? editEntity.category || "" : "", { error: categoriesError })}

        <div>
          <label class="label">Map pin</label>
          <div class="space-y-2">
            <input id="qa-place-name" class="input" placeholder="Location name" maxlength="500" value="${escapeHtml(isEdit ? editEntity.place_name || "" : "")}" />
            <input id="qa-place-url" class="input" placeholder="Google Earth / map URL" maxlength="2000" value="${escapeHtml(isEdit ? editEntity.place_url || "" : "")}" />
          </div>
        </div>

        ${mediaBlockHtml()}

        <div class="flex justify-between gap-2 pt-1">
          <button type="button" id="wizard-back" class="btn-ghost">Back</button>
          <button type="submit" class="btn-primary px-5 py-2.5">${isEdit ? "Save changes" : "Save event"}</button>
        </div>
      </div>
    </form>
  `;

  let wizardStep = 1;
  function showWizardStep(n) {
    wizardStep = n;
    document.getElementById("wizard-step-1")?.classList.toggle("hidden", n !== 1);
    document.getElementById("wizard-step-2")?.classList.toggle("hidden", n !== 2);
    const sub = document.getElementById("wizard-sub");
    if (sub) {
      const figNote =
        !isEdit && (preselectFigures || []).length ? ` · for ${preselectFigures[0].title}` : "";
      const hubNote =
        !figNote && !isEdit && (preselectPhase?.title || preselectPeriod?.title)
          ? ` · in ${preselectPhase?.title || preselectPeriod.title}`
          : "";
      sub.textContent =
        n === 1
          ? `Step 1 of 2 — title, country & figures${figNote}${hubNote}`
          : "Step 2 of 2 — dates & details";
    }
    document.getElementById("wizard-dot-1")?.classList.toggle("bg-accent", true);
    document.getElementById("wizard-dot-1")?.classList.toggle("bg-paper-line", false);
    const dot2 = document.getElementById("wizard-dot-2");
    if (dot2) {
      dot2.classList.toggle("bg-accent", n === 2);
      dot2.classList.toggle("bg-paper-line", n !== 2);
    }
    if (n === 1) {
      queueMicrotask(() => document.getElementById("qa-title")?.focus());
    } else {
      autoAssignPeriodsFromEventDates();
      refreshBelongUI();
      queueMicrotask(() => document.getElementById("qa-from-year")?.focus());
    }
  }

  function goToStep2() {
    const title = document.getElementById("qa-title")?.value.trim();
    if (!title) {
      toast("Add a title first");
      document.getElementById("qa-title")?.focus();
      return;
    }
    showWizardStep(2);
  }

  ["actor", "period", "phase"].forEach((step) => {
    const search = document.getElementById(`belong-search-${step}`);
    if (!search) return;
    search.addEventListener("input", () => {
      if (step === "actor") renderActorCatalog();
      else if (step === "period") renderPeriodCatalog();
      else renderPhaseCatalog();
    });
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const cat = document.getElementById(`belong-catalog-${step}`);
        const createBtn = cat?.querySelector(
          "[data-create-typed-figure], [data-create-typed-period], [data-create-typed-phase]"
        );
        const pickBtn = cat?.querySelector("[data-pick-existing], [data-pick-kind]");
        (createBtn || pickBtn)?.click();
      }
    });
  });

  bindEventCountryHandlers(eventCountries);
  refreshBelongUI();
  renderRelatedChips();
  renderAttachments();
  bindMediaHandlers();
  renderTagChips(tags);
  showWizardStep(1);
  openModal();

  document.getElementById("wizard-next")?.addEventListener("click", goToStep2);
  document.getElementById("wizard-back")?.addEventListener("click", () => showWizardStep(1));
  document.getElementById("qa-title")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      goToStep2();
    }
  });

  const atSearch = document.getElementById("at-search");
  atSearch.addEventListener("input", (e) => renderAtResults(e.target.value));
  atSearch.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      document.querySelector("#at-results [data-pick]")?.click();
    }
  });

  function addTag() {
    const t = normalizeTag(document.getElementById("tag-input").value);
    if (!t) return;
    if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
    document.getElementById("tag-input").value = "";
    renderTagChips(tags);
  }
  document.getElementById("tag-add").addEventListener("click", addTag);
  document.getElementById("tag-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTag();
    }
  });

  document.getElementById("qa-from-year")?.addEventListener("change", () => {
    onEventDateFieldsChanged();
  });
  document.getElementById("qa-from-year")?.addEventListener("blur", () => {
    onEventDateFieldsChanged();
  });
  document.getElementById("qa-to-year")?.addEventListener("change", () => {
    onEventDateFieldsChanged();
  });
  document.getElementById("qa-to-year")?.addEventListener("blur", () => {
    onEventDateFieldsChanged();
  });
  document.querySelectorAll('input[name="qa-from-era"], input[name="qa-to-era"]').forEach((el) => {
    el.addEventListener("change", () => {
      const cleared = clearPeriodIfEraMismatch();
      if (cleared) {
        toast(
          selectedEra() === "bc"
            ? "Cleared period — it doesn’t include BC years"
            : "Cleared period — it doesn’t include AC years"
        );
      }
      onEventDateFieldsChanged();
    });
  });

  document.getElementById("quick-add-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (wizardStep !== 2) {
      goToStep2();
      return;
    }

    const from = readEventDateSide("qa-from");
    const to = readEventDateSide("qa-to");
    if (from.error) {
      toast(from.error);
      return;
    }
    if (to.error) {
      toast(to.error);
      return;
    }
    if (from.signed != null && to.signed != null && from.signed > to.signed) {
      toast("From must be earlier than To");
      return;
    }
    if (to.stored && !from.stored) {
      toast("Set From before To");
      return;
    }

    if (from.signed != null) {
      autoAssignPeriodsFromEventDates();
    }

    if (!hasEventAnchor(eventCountries)) {
      toast("Add a country, figure, period, or phase");
      if (!eventCountries.length && !selectedBelong.figure.size) {
        showWizardStep(1);
      }
      return;
    }

    const countryNames = [...eventCountries];
    let countryIds = [];
    try {
      countryIds = await ensurePlacesForNames(countryNames);
    } catch (err) {
      toast(err.message || "Could not save countries");
      return;
    }
    const body = {
      title: document.getElementById("qa-title").value.trim(),
      summary: document.getElementById("qa-note").value.trim() || null,
      date_start: from.stored,
      date_end: to.stored,
      tags: [...tags],
      place_name: document.getElementById("qa-place-name").value.trim() || null,
      place_url: document.getElementById("qa-place-url").value.trim() || null,
      country_names: countryNames,
      country_name: countryNames.length ? countryNames.join(", ") : null,
      category: document.getElementById("entity-category")?.value.trim() || null,
      attachments: [...attachments],
      period_ids: [...selectedBelong.period.keys()],
      phase_ids: [...selectedBelong.phase.keys()],
      country_ids: countryIds,
      figure_ids: [...selectedBelong.figure.keys()],
      figure_roles: {},
      link_ids: [...selectedRelated.keys()],
      link_relation: "related_to",
    };

    try {
      let saved;
      if (isEdit) {
        saved = await api.updateEntity(editEntity.id, body);
        toast(`Updated “${saved.title}”`);
      } else {
        saved = await api.createEntity({ type: "event", ...body, body: null, parent_id: null });
        const periodNames = [...selectedBelong.period.values()].map((p) => p.title);
        toast(
          periodNames.length
            ? `Added “${saved.title}” · ${periodNames.join(", ")}`
            : `Added “${saved.title}”`
        );
      }
      closeModal();
      if (onSaved) onSaved(saved);
    } catch (err) {
      toast(err.message || "Could not save");
    }
  });
}

export async function openEditEvent(entityId, { onSaved } = {}) {
  const neighbors = await api.neighbors(entityId);
  if (neighbors.entity.type !== "event") {
    toast("Only events can be edited in this form");
    return;
  }
  return openQuickAdd({
    editEntity: neighbors.entity,
    neighbors,
    onSaved,
  });
}

/** Single optional date block (day / month / year + era). */
function figureSingleDateHtml(prefix, label, parts) {
  return `
    <div>
      <p class="text-xs font-medium text-ink-muted mb-1">${label}</p>
      <div class="grid grid-cols-3 gap-2">
        <input id="${prefix}-day" class="input" type="number" min="1" max="31" placeholder="Day" value="${escapeHtml(parts.day)}" />
        <input id="${prefix}-month" class="input" type="number" min="1" max="12" placeholder="Month" value="${escapeHtml(parts.month)}" />
        <input id="${prefix}-year" class="input" type="number" placeholder="Year" value="${escapeHtml(parts.year)}" />
      </div>
      <div class="flex gap-3 mt-1.5">
        <label class="inline-flex items-center gap-1.5 text-xs cursor-pointer">
          <input type="radio" name="${prefix}-era" value="ac" ${parts.era !== "bc" ? "checked" : ""} class="accent-accent" /> AC
        </label>
        <label class="inline-flex items-center gap-1.5 text-xs cursor-pointer">
          <input type="radio" name="${prefix}-era" value="bc" ${parts.era === "bc" ? "checked" : ""} class="accent-accent" /> BC
        </label>
      </div>
    </div>`;
}

function figureDatesFormHtml({ birth, death, reignFrom, reignTo }) {
  return `
    <div class="space-y-4">
      <div>
        <label class="label">Life dates <span class="font-normal text-ink-faint">(optional)</span></label>
        <div class="grid sm:grid-cols-2 gap-3 mt-1">
          ${figureSingleDateHtml("fig-birth", "Birth", birth)}
          ${figureSingleDateHtml("fig-death", "Death", death)}
        </div>
      </div>
      <div class="rounded-lg border border-paper-line bg-paper-deep/30 p-2.5 space-y-3">
        <label class="label mb-0">Ruling period <span class="font-normal text-ink-faint">(optional)</span></label>
        <p class="text-xs text-ink-faint -mt-1">Separate from birth and death — for kings, emperors, and other leaders.</p>
        ${figureSingleDateHtml("fig-reign-from", "From", reignFrom)}
        ${figureSingleDateHtml("fig-reign-to", "To", reignTo)}
      </div>
    </div>`;
}

function readFigureOptionalDate(prefix, label) {
  const year = document.getElementById(`${prefix}-year`)?.value?.trim();
  const month = document.getElementById(`${prefix}-month`)?.value;
  const day = document.getElementById(`${prefix}-day`)?.value;
  const era = document.querySelector(`input[name="${prefix}-era"]:checked`)?.value || "ac";
  if ((month || day) && !year) {
    return { error: `Add a year for ${label} if you set month or day` };
  }
  return { stored: composeDate(year || null, month, day, era) };
}

function readFigureFormDates() {
  const birth = readFigureOptionalDate("fig-birth", "birth");
  if (birth.error) return birth;
  const death = readFigureOptionalDate("fig-death", "death");
  if (death.error) return death;
  const reignFrom = readFigureOptionalDate("fig-reign-from", "ruling start");
  if (reignFrom.error) return reignFrom;
  const reignTo = readFigureOptionalDate("fig-reign-to", "ruling end");
  if (reignTo.error) return reignTo;
  return {
    date_start: birth.stored,
    date_end: death.stored,
    reign_start: reignFrom.stored,
    reign_end: reignTo.stored,
  };
}

function figureCountryFieldHtml(value = "") {
  return `
    <div>
      <label class="label" for="fig-country">Country / territory <span class="font-normal text-ink-faint">(optional)</span></label>
      <p class="text-xs text-ink-faint -mt-1">Pick from your countries or type a new name — modern or historic.</p>
      <input id="fig-country" class="input" maxlength="500" placeholder="Search or type a country…" value="${escapeHtml(value)}" autocomplete="off" />
      <div id="fig-country-catalog" class="mt-2 max-h-40 overflow-y-auto rounded-lg border border-paper-line bg-paper-deep/30"></div>
    </div>`;
}

function bindFigureCountryHandlers() {
  function refreshCatalog() {
    renderSavedCountryCatalog({
      boxId: "fig-country-catalog",
      searchId: "fig-country",
      excludeNames: [],
      mode: "fill",
      onPick: (name) => {
        const input = document.getElementById("fig-country");
        if (input) input.value = name;
        refreshCatalog();
      },
    });
  }
  document.getElementById("fig-country")?.addEventListener("input", refreshCatalog);
  refreshCatalog();
}

function bindFigureFormSubmit(formId, onSubmit) {
  document.getElementById(formId)?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const title = document.getElementById("fig-title")?.value.trim();
    if (!title) {
      toast("Name is required");
      return;
    }
    const dates = readFigureFormDates();
    if (dates.error) {
      toast(dates.error);
      return;
    }
    await onSubmit({
      title,
      summary: document.getElementById("fig-summary")?.value.trim() || null,
      body: document.getElementById("fig-body")?.value.trim() || null,
      place_name: document.getElementById("fig-country")?.value.trim() || null,
      ...dates,
    });
  });
}

/** Add figure with life dates, ruling period, and free-text country. */
export async function openAddFigure({ onSaved } = {}) {
  const panel = document.getElementById("modal-panel");
  if (!panel) {
    toast("Could not open form");
    return;
  }
  let userCategories = [];
  let categoriesError = "";
  const catResult = await loadUserCategories();
  userCategories = catResult.categories;
  categoriesError = catResult.error;
  await loadSavedCountries();
  attachments = [];
  const empty = { year: "", month: "", day: "", era: "ac" };
  panel.innerHTML = `
    <div class="flex items-start justify-between mb-4">
      <div>
        <h2 class="font-display text-xl flex items-center gap-2">${iconFigure()} Add figure</h2>
        <p class="text-sm text-ink-muted mt-0.5">Name, life dates, ruling period, and country.</p>
      </div>
      <button type="button" class="btn-ghost text-lg leading-none" data-close-modal aria-label="Close">×</button>
    </div>
    <form id="fig-add-form" class="space-y-5 max-h-[70vh] overflow-y-auto pr-1">
      <div>
        <label class="label" for="fig-title">Name</label>
        <input id="fig-title" class="input text-lg" required maxlength="500" placeholder="e.g. Alfred the Great" autofocus autocomplete="off" />
      </div>
      <div>
        <label class="label" for="fig-summary">Short bio <span class="font-normal text-ink-faint">(optional)</span></label>
        <textarea id="fig-summary" class="textarea" placeholder="One or two sentences…"></textarea>
      </div>
      <div>
        <label class="label" for="fig-body">Full biography <span class="font-normal text-ink-faint">(optional)</span></label>
        <textarea id="fig-body" class="textarea min-h-[80px]" placeholder="Longer notes (markdown)…"></textarea>
      </div>
      ${figureDatesFormHtml({ birth: empty, death: empty, reignFrom: empty, reignTo: empty })}
      ${figureCountryFieldHtml()}
      ${categorySelectHtml(userCategories, "", { error: categoriesError })}
      ${mediaBlockHtml()}
      <div class="flex justify-end gap-2 pt-2 sticky bottom-0 bg-white py-2">
        <button type="button" class="btn-ghost" data-close-modal>Cancel</button>
        <button type="submit" class="btn-primary px-5 py-2.5">Create biography</button>
      </div>
    </form>
  `;
  openModal();
  renderAttachments();
  bindMediaHandlers();
  bindFigureCountryHandlers();
  bindFigureFormSubmit("fig-add-form", async (payload) => {
    try {
      const countryName = payload.place_name || "";
      const countryIds = countryName ? await ensurePlacesForNames([countryName]) : [];
      const saved = await api.createEntity({
        type: "figure",
        ...payload,
        category: document.getElementById("entity-category")?.value.trim() || null,
        attachments: [...attachments],
        parent_id: null,
        tags: [],
        period_ids: [],
        country_ids: countryIds,
        figure_ids: [],
        link_ids: [],
      });
      toast(`Opened biography for “${saved.title}”`);
      closeModal();
      if (onSaved) onSaved(saved);
    } catch (err) {
      toast(err.message || "Could not create figure");
    }
  });
}

/** Edit figure: bio, country, related people (+ relationship), topics. */
export async function openEditFigure(figure, { onSaved } = {}) {
  const birth = splitDateParts(figure.date_start);
  const death = splitDateParts(figure.date_end);
  const reignFrom = splitDateParts(figure.reign_start);
  const reignTo = splitDateParts(figure.reign_end);
  const panel = document.getElementById("modal-panel");
  if (!panel || !figure?.id) return;

  let figures = [];
  let topics = [];
  let neighbors = { related: {} };
  let userCategories = [];
  let categoriesError = "";
  try {
    const [figList, topicList, nbrs, catResult] = await Promise.all([
      api.listEntities({ type: "figure" }),
      api.listEntities({ type: "topic" }),
      api.neighbors(figure.id),
      loadUserCategories(),
    ]);
    figures = figList;
    topics = topicList;
    neighbors = nbrs;
    userCategories = catResult.categories;
    categoriesError = catResult.error;
  } catch (err) {
    toast(err.message || "Could not load figure links");
    return;
  }
  await loadSavedCountries();
  attachments = [...(figure.attachments || [])];

  let countryName = figure.place_name || "";
  if (!countryName) {
    const linked = neighborItems(neighbors, "place", { direction: "out", relation: "involves" });
    if (!linked.length) {
      const alt = neighborItems(neighbors, "place", { relation: "involves" });
      if (alt.length) countryName = alt[0].entity.title;
    } else {
      countryName = linked[0].entity.title;
    }
  }

  const selectedPeople = new Map();
  for (const item of neighborItems(neighbors, "figure", { direction: "out", relation: "related_to" })) {
    selectedPeople.set(item.entity.id, {
      entity: item.entity,
      role: item.role || "",
    });
  }

  const selectedTopics = new Map();
  const initialTopicLinkIds = new Map();
  for (const item of neighborItems(neighbors, "topic")) {
    selectedTopics.set(item.entity.id, item.entity);
    if (item.link_id) initialTopicLinkIds.set(item.entity.id, item.link_id);
  }

  figures = sortByTitle(figures.filter((f) => f.id !== figure.id));
  topics = sortByTitle(topics);

  const emptyChip = (msg) => `<p class="text-sm text-ink-faint">${msg}</p>`;

  panel.innerHTML = `
    <div class="flex items-start justify-between mb-4">
      <div>
        <h2 class="font-display text-xl flex items-center gap-2">${iconFigure()} Edit figure</h2>
        <p class="text-sm text-ink-muted mt-0.5">${escapeHtml(figure.title)}</p>
      </div>
      <button type="button" class="btn-ghost text-lg leading-none" data-close-modal aria-label="Close">×</button>
    </div>
    <form id="fig-form" class="space-y-5 max-h-[70vh] overflow-y-auto pr-1">
      <div>
        <label class="label" for="fig-title">Name</label>
        <input id="fig-title" class="input" required maxlength="500" value="${escapeHtml(figure.title)}" />
      </div>
      <div>
        <label class="label" for="fig-summary">Short bio</label>
        <textarea id="fig-summary" class="textarea" placeholder="One or two sentences…">${escapeHtml(figure.summary || "")}</textarea>
      </div>
      <div>
        <label class="label" for="fig-body">Full biography</label>
        <textarea id="fig-body" class="textarea min-h-[100px]" placeholder="Longer notes (markdown)…">${escapeHtml(figure.body || "")}</textarea>
      </div>
      ${figureDatesFormHtml({ birth, death, reignFrom, reignTo })}
      ${figureCountryFieldHtml(countryName)}
      ${categorySelectHtml(userCategories, figure.category || "", { error: categoriesError })}
      ${mediaBlockHtml()}

      <div class="border-t border-paper-line pt-4 space-y-2">
        <label class="label">Related people</label>
        <p class="text-xs text-ink-faint -mt-1">Tag other figures and name the relationship (e.g. mentor, rival, spouse).</p>
        <div id="fig-people-chips" class="space-y-2"></div>
        <input id="fig-people-q" class="input" placeholder="Search figures…" autocomplete="off" />
        <div id="fig-people-list" class="max-h-36 overflow-y-auto rounded-lg border border-paper-line divide-y divide-paper-line"></div>
      </div>

      <div class="border-t border-paper-line pt-4 space-y-2">
        <label class="label">Topics</label>
        <p class="text-xs text-ink-faint -mt-1">Connect this person to themes you are studying.</p>
        <div id="fig-topic-chips" class="flex flex-wrap gap-1.5 min-h-[1.5rem]"></div>
        <input id="fig-topic-q" class="input" placeholder="Search topics…" autocomplete="off" />
        <div id="fig-topic-list" class="max-h-36 overflow-y-auto rounded-lg border border-paper-line divide-y divide-paper-line"></div>
      </div>

      <div class="flex justify-end gap-2 pt-2 sticky bottom-0 bg-white py-2">
        <button type="button" class="btn-ghost" data-close-modal>Cancel</button>
        <button type="submit" class="btn-primary px-5 py-2.5">Save</button>
      </div>
    </form>
  `;
  openModal();
  renderAttachments();
  bindMediaHandlers();
  bindFigureCountryHandlers();

  function renderPeopleChips() {
    const box = document.getElementById("fig-people-chips");
    if (!box) return;
    if (!selectedPeople.size) {
      box.innerHTML = emptyChip("No related people yet.");
      return;
    }
    box.innerHTML = [...selectedPeople.values()]
      .map(
        ({ entity, role }) => `
      <div class="flex flex-wrap items-center gap-2 rounded-lg border border-paper-line bg-white px-2.5 py-2">
        <span class="font-medium text-sm min-w-0 flex-1 truncate">${escapeHtml(entity.title)}</span>
        <input data-role-for="${entity.id}" class="input text-sm py-1 max-w-[10rem] sm:max-w-[14rem]" maxlength="${LINK_ROLE_MAX_LENGTH}"
          placeholder="Relationship" value="${escapeHtml(role || "")}" />
        <button type="button" data-rm-person="${entity.id}" class="btn-ghost text-xs px-2 py-1 text-ink-muted">Remove</button>
      </div>`
      )
      .join("");
    box.querySelectorAll("[data-rm-person]").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedPeople.delete(btn.dataset.rmPerson);
        renderPeopleChips();
        renderPeopleList();
      });
    });
    box.querySelectorAll("[data-role-for]").forEach((input) => {
      input.addEventListener("input", () => {
        const row = selectedPeople.get(input.dataset.roleFor);
        if (row) row.role = input.value;
      });
    });
  }

  const renderPeopleList = bindEntitySearchPicker({
    listId: "fig-people-list",
    searchId: "fig-people-q",
    getCandidates: () => figures,
    isSelected: (id) => selectedPeople.has(id),
    emptyNone: "No other figures yet.",
    onPick: (ent) => {
      selectedPeople.set(ent.id, { entity: ent, role: "" });
      renderPeopleChips();
      renderPeopleList();
    },
  });
  renderPeopleChips();

  let renderTopicList = () => {};
  const renderTopicChips = bindRemovableChips({
    chipsId: "fig-topic-chips",
    selected: selectedTopics,
    emptyHtml: emptyChip("Not in any topic yet."),
    onChange: () => renderTopicList(),
  });
  renderTopicList = bindEntitySearchPicker({
    listId: "fig-topic-list",
    searchId: "fig-topic-q",
    getCandidates: () => topics,
    isSelected: (id) => selectedTopics.has(id),
    emptyNone: "No topics yet — create one from the library.",
    onPick: (ent) => {
      selectedTopics.set(ent.id, ent);
      renderTopicChips();
      renderTopicList();
    },
  });

  document.getElementById("fig-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const title = document.getElementById("fig-title").value.trim();
    if (!title) {
      toast("Name is required");
      return;
    }
    const dates = readFigureFormDates();
    if (dates.error) {
      toast(dates.error);
      return;
    }

    document.querySelectorAll("[data-role-for]").forEach((input) => {
      const row = selectedPeople.get(input.dataset.roleFor);
      if (row) row.role = input.value.trim();
    });

    const figure_ids = [...selectedPeople.keys()];
    const figure_roles = {};
    for (const [id, row] of selectedPeople) {
      if (row.role) figure_roles[id] = row.role;
    }

    try {
      const countryName = document.getElementById("fig-country")?.value.trim() || null;
      const countryIds = countryName ? await ensurePlacesForNames([countryName]) : [];
      const saved = await api.updateEntity(figure.id, {
        title,
        summary: document.getElementById("fig-summary").value.trim() || null,
        body: document.getElementById("fig-body").value.trim() || null,
        date_start: dates.date_start,
        date_end: dates.date_end,
        reign_start: dates.reign_start,
        reign_end: dates.reign_end,
        place_name: countryName,
        category: document.getElementById("entity-category")?.value.trim() || null,
        attachments: [...attachments],
        country_ids: countryIds,
        figure_ids,
        figure_roles,
      });

      const nextTopicIds = new Set(selectedTopics.keys());
      for (const [tid, linkId] of initialTopicLinkIds) {
        if (!nextTopicIds.has(tid) && linkId) await api.deleteLink(linkId);
      }
      for (const tid of nextTopicIds) {
        if (!initialTopicLinkIds.has(tid)) {
          await api.createLink({
            source_id: tid,
            target_id: figure.id,
            relation: "part_of",
          });
        }
      }

      toast(`Updated “${saved.title}”`);
      closeModal();
      if (onSaved) onSaved(saved);
    } catch (err) {
      toast(err.message || "Could not save");
    }
  });
}

/** Edit period: name, summary, from/to years. */
export async function openEditPeriod(period, { onSaved } = {}) {
  const from = splitDateParts(period.date_start);
  const to = splitDateParts(period.date_end);
  const panel = document.getElementById("modal-panel");
  panel.innerHTML = `
    <div class="flex items-start justify-between mb-4">
      <div>
        <h2 class="font-display text-xl">Edit period</h2>
        <p class="text-sm text-ink-muted mt-0.5">Set the From – To range for this era</p>
      </div>
      <button type="button" class="btn-ghost text-lg leading-none" data-close-modal aria-label="Close">×</button>
    </div>
    <form id="period-form" class="space-y-4">
      <div>
        <label class="label" for="period-title">Name</label>
        <input id="period-title" class="input" required maxlength="500" value="${escapeHtml(period.title)}" />
      </div>
      <div>
        <label class="label" for="period-summary">Summary</label>
        <textarea id="period-summary" class="textarea" placeholder="What defines this period…">${escapeHtml(period.summary || "")}</textarea>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="label" for="period-from-year">From</label>
          <div class="flex gap-2 items-center">
            <input id="period-from-year" class="input" inputmode="numeric" placeholder="Year" value="${escapeHtml(from.year)}" />
            <label class="inline-flex items-center gap-1 text-xs"><input type="radio" name="period-from-era" value="ac" ${from.era !== "bc" ? "checked" : ""} /> AC</label>
            <label class="inline-flex items-center gap-1 text-xs"><input type="radio" name="period-from-era" value="bc" ${from.era === "bc" ? "checked" : ""} /> BC</label>
          </div>
        </div>
        <div>
          <label class="label" for="period-to-year">To</label>
          <div class="flex gap-2 items-center">
            <input id="period-to-year" class="input" inputmode="numeric" placeholder="Year" value="${escapeHtml(to.year)}" />
            <label class="inline-flex items-center gap-1 text-xs"><input type="radio" name="period-to-era" value="ac" ${to.era !== "bc" ? "checked" : ""} /> AC</label>
            <label class="inline-flex items-center gap-1 text-xs"><input type="radio" name="period-to-era" value="bc" ${to.era === "bc" ? "checked" : ""} /> BC</label>
          </div>
        </div>
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" class="btn-ghost" data-close-modal>Cancel</button>
        <button type="submit" class="btn-primary px-5 py-2.5">Save period</button>
      </div>
    </form>
  `;
  openModal();
  document.getElementById("period-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const title = document.getElementById("period-title").value.trim();
    if (!title) {
      toast("Name is required");
      return;
    }
    const fromEra = document.querySelector('input[name="period-from-era"]:checked')?.value || "ac";
    const toEra = document.querySelector('input[name="period-to-era"]:checked')?.value || "ac";
    const fromYear = document.getElementById("period-from-year").value.trim();
    const toYear = document.getElementById("period-to-year").value.trim();
    if (!fromYear || !toYear) {
      toast("Set both From and To years");
      return;
    }
    const date_start = composeDate(fromYear, null, null, fromEra);
    const date_end = composeDate(toYear, null, null, toEra);
    const startN = storedToSignedYear(date_start);
    const endN = storedToSignedYear(date_end);
    if (startN != null && endN != null && startN > endN) {
      toast("From must be earlier than To");
      return;
    }
    try {
      const saved = await api.updateEntity(period.id, {
        title,
        summary: document.getElementById("period-summary").value.trim() || null,
        date_start,
        date_end,
      });
      toast(`Updated “${saved.title}”`);
      closeModal();
      if (onSaved) onSaved(saved);
    } catch (err) {
      toast(err.message || "Could not save");
    }
  });
}

function countryFlagFromSummary(summary) {
  const s = String(summary || "").trim();
  if (!s || s.includes(" ")) return "";
  return s;
}

/** Add a country / territory hub (name + optional flag emoji). */
export async function openAddCountry({ onSaved } = {}) {
  let catalogData = { countries: [], empires: [] };
  try {
    catalogData = await api.catalog();
  } catch {
    /* ignore */
  }
  const panel = document.getElementById("modal-panel");
  if (!panel) {
    toast("Could not open form");
    return;
  }
  panel.innerHTML = `
    <div class="flex items-start justify-between mb-4">
      <div>
        <h2 class="font-display text-xl">Add country</h2>
        <p class="text-sm text-ink-muted mt-0.5">Name it and optionally add a flag emoji.</p>
      </div>
      <button type="button" class="btn-ghost text-lg leading-none" data-close-modal aria-label="Close">×</button>
    </div>
    <form id="country-form" class="space-y-4">
      <div>
        <label class="label" for="country-title">Name</label>
        <input id="country-title" class="input text-lg" required maxlength="500" placeholder="e.g. Rome, France, Frankish Empire" autofocus autocomplete="off" />
      </div>
      <div>
        <label class="label" for="country-flag">Flag <span class="font-normal text-ink-faint">(optional)</span></label>
        <p class="text-xs text-ink-faint -mt-1">Paste an emoji — e.g. 🇫🇷 🏛️ 🌍. Known names auto-fill when saved.</p>
        <input id="country-flag" class="input" maxlength="20" placeholder="🇫🇷" autocomplete="off" />
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" class="btn-ghost" data-close-modal>Cancel</button>
        <button type="submit" class="btn-primary px-5 py-2.5">Create country</button>
      </div>
    </form>
  `;
  openModal();
  const titleInput = document.getElementById("country-title");
  const flagInput = document.getElementById("country-flag");
  titleInput?.addEventListener("blur", () => {
    if (flagInput?.value.trim()) return;
    const name = titleInput.value.trim();
    if (!name) return;
    const key = name.toLowerCase();
    const hit =
      catalogData.countries?.find((c) => c.name.toLowerCase() === key) ||
      catalogData.empires?.find((e) => e.name.toLowerCase() === key);
    if (hit?.flag) flagInput.value = hit.flag;
  });
  document.getElementById("country-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const title = titleInput?.value.trim();
    if (!title) {
      toast("Name is required");
      return;
    }
    let flag = flagInput?.value.trim() || "";
    if (!flag) {
      const key = title.toLowerCase();
      const hit =
        catalogData.countries?.find((c) => c.name.toLowerCase() === key) ||
        catalogData.empires?.find((e) => e.name.toLowerCase() === key);
      flag = hit?.flag || "";
    }
    try {
      const saved = await api.createEntity({
        type: "place",
        title,
        summary: flag || null,
        body: null,
        parent_id: null,
        tags: [],
        attachments: [],
        period_ids: [],
        country_ids: [],
        figure_ids: [],
        link_ids: [],
      });
      toast(`Created “${saved.title}”`);
      closeModal();
      if (onSaved) onSaved(saved);
    } catch (err) {
      toast(err.message || "Could not create country");
    }
  });
}

/** Edit country name and flag emoji. */
export async function openEditCountry(place, { onSaved } = {}) {
  let catalogData = { countries: [], empires: [] };
  try {
    catalogData = await api.catalog();
  } catch {
    /* ignore */
  }
  const flagValue = countryFlagFromSummary(place.summary);
  const panel = document.getElementById("modal-panel");
  panel.innerHTML = `
    <div class="flex items-start justify-between mb-4">
      <div>
        <h2 class="font-display text-xl">Edit country</h2>
        <p class="text-sm text-ink-muted mt-0.5">Update the name or flag shown in the Countries list.</p>
      </div>
      <button type="button" class="btn-ghost text-lg leading-none" data-close-modal aria-label="Close">×</button>
    </div>
    <form id="country-form" class="space-y-4">
      <div>
        <label class="label" for="country-title">Name</label>
        <input id="country-title" class="input text-lg" required maxlength="500" value="${escapeHtml(place.title)}" />
      </div>
      <div>
        <label class="label" for="country-flag">Flag <span class="font-normal text-ink-faint">(optional)</span></label>
        <input id="country-flag" class="input" maxlength="20" placeholder="🇫🇷" value="${escapeHtml(flagValue)}" autocomplete="off" />
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" class="btn-ghost" data-close-modal>Cancel</button>
        <button type="submit" class="btn-primary px-5 py-2.5">Save country</button>
      </div>
    </form>
  `;
  openModal();
  document.getElementById("country-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const title = document.getElementById("country-title")?.value.trim();
    if (!title) {
      toast("Name is required");
      return;
    }
    let flag = document.getElementById("country-flag")?.value.trim() || "";
    if (!flag) {
      const key = title.toLowerCase();
      const hit =
        catalogData.countries?.find((c) => c.name.toLowerCase() === key) ||
        catalogData.empires?.find((e) => e.name.toLowerCase() === key);
      flag = hit?.flag || "";
    }
    try {
      const saved = await api.updateEntity(place.id, {
        title,
        summary: flag || null,
      });
      toast(`Updated “${saved.title}”`);
      closeModal();
      if (onSaved) onSaved(saved);
    } catch (err) {
      toast(err.message || "Could not save");
    }
  });
}

/** Add phase: name, summary, from/to — auto-maps overlapping periods. */
export async function openAddPhase({
  onSaved,
  preselectPeriod = null,
  linkEvent = null,
} = {}) {
  try {
    hubs.period = await api.listEntities({ type: "period" });
  } catch {
    hubs.period = hubs.period || [];
  }

  const seed = linkEvent || preselectPeriod;
  const from = seed?.date_start
    ? splitDateParts(seed.date_start)
    : { year: "", month: "", day: "", era: "ac" };
  const to = seed?.date_end
    ? splitDateParts(seed.date_end)
    : seed?.date_start
      ? splitDateParts(seed.date_start)
      : { year: "", month: "", day: "", era: from.era || "ac" };

  const context =
    preselectPeriod?.title
      ? ` · in ${preselectPeriod.title}`
      : linkEvent?.title
        ? ` · for ${linkEvent.title}`
        : "";

  const panel = document.getElementById("modal-panel");
  if (!panel) {
    toast("Could not open form");
    return;
  }
  panel.innerHTML = `
    <div class="flex items-start justify-between mb-4">
      <div>
        <h2 class="font-display text-xl">Add phase</h2>
        <p class="text-sm text-ink-muted mt-0.5">A named span inside periods${escapeHtml(context)}</p>
      </div>
      <button type="button" class="btn-ghost text-lg leading-none" data-close-modal aria-label="Close">×</button>
    </div>
    <form id="add-phase-form" class="space-y-4">
      <div>
        <label class="label" for="add-phase-name">Name</label>
        <input id="add-phase-name" class="input text-lg" required maxlength="500" placeholder="e.g. Diadochi" autofocus autocomplete="off" />
      </div>
      <div>
        <label class="label" for="add-phase-summary">Summary <span class="font-normal text-ink-faint">(optional)</span></label>
        <textarea id="add-phase-summary" class="textarea" placeholder="What defines this phase…"></textarea>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="label" for="add-phase-from">From</label>
          <div class="flex gap-2 items-center">
            <input id="add-phase-from" class="input" inputmode="numeric" placeholder="Year" required value="${escapeHtml(from.year)}" />
            <label class="inline-flex items-center gap-1 text-xs"><input type="radio" name="add-phase-from-era" value="ac" ${from.era !== "bc" ? "checked" : ""} /> AC</label>
            <label class="inline-flex items-center gap-1 text-xs"><input type="radio" name="add-phase-from-era" value="bc" ${from.era === "bc" ? "checked" : ""} /> BC</label>
          </div>
        </div>
        <div>
          <label class="label" for="add-phase-to">To</label>
          <div class="flex gap-2 items-center">
            <input id="add-phase-to" class="input" inputmode="numeric" placeholder="Year" required value="${escapeHtml(to.year)}" />
            <label class="inline-flex items-center gap-1 text-xs"><input type="radio" name="add-phase-to-era" value="ac" ${to.era !== "bc" ? "checked" : ""} /> AC</label>
            <label class="inline-flex items-center gap-1 text-xs"><input type="radio" name="add-phase-to-era" value="bc" ${to.era === "bc" ? "checked" : ""} /> BC</label>
          </div>
        </div>
      </div>
      <div class="flex justify-end gap-2 pt-1">
        <button type="button" class="btn-ghost" data-close-modal>Cancel</button>
        <button type="submit" class="btn-primary px-5 py-2.5">Create phase</button>
      </div>
    </form>
  `;
  openModal();
  queueMicrotask(() => document.getElementById("add-phase-name")?.focus());

  document.getElementById("add-phase-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const title = document.getElementById("add-phase-name")?.value.trim();
    if (!title) {
      toast("Enter a name");
      return;
    }
    const fromEra = document.querySelector('input[name="add-phase-from-era"]:checked')?.value || "ac";
    const toEra = document.querySelector('input[name="add-phase-to-era"]:checked')?.value || "ac";
    const fromYear = document.getElementById("add-phase-from")?.value.trim();
    const toYear = document.getElementById("add-phase-to")?.value.trim();
    if (!fromYear || !toYear) {
      toast("Set both From and To years");
      return;
    }
    const date_start = composeDate(fromYear, null, null, fromEra);
    const date_end = composeDate(toYear, null, null, toEra);
    const startN = storedToSignedYear(date_start);
    const endN = storedToSignedYear(date_end);
    if (startN != null && endN != null && startN > endN) {
      toast("From must be earlier than To");
      return;
    }

    const periodIdSet = new Set(autoAssignPeriodsForRange(startN, endN).map((p) => p.id));
    if (preselectPeriod?.id) periodIdSet.add(preselectPeriod.id);
    if (linkEvent?.id) {
      try {
        const neighbors = await api.neighbors(linkEvent.id);
        for (const item of neighbors.related?.period || []) {
          periodIdSet.add(item.entity.id);
        }
      } catch {
        /* keep overlap + preselect only */
      }
    }

    try {
      const saved = await api.createEntity({
        type: "phase",
        title,
        summary: document.getElementById("add-phase-summary")?.value.trim() || null,
        body: null,
        date_start,
        date_end,
        parent_id: null,
        tags: [],
        attachments: [],
        period_ids: [...periodIdSet],
        country_ids: [],
        figure_ids: [],
        link_ids: [],
      });

      if (linkEvent?.id) {
        try {
          const neighbors = await api.neighbors(linkEvent.id);
          const related = neighbors.related || {};
          const period_ids = (related.period || []).map((item) => item.entity.id);
          const phase_ids = [
            ...new Set([
              ...(related.phase || []).map((item) => item.entity.id),
              saved.id,
            ]),
          ];
          const country_ids = (related.place || []).map((item) => item.entity.id);
          const figure_ids = (related.figure || []).map((item) => item.entity.id);
          await api.updateEntity(linkEvent.id, {
            period_ids,
            phase_ids,
            country_ids,
            figure_ids,
            figure_roles: {},
          });
        } catch (err) {
          toast(err.message || "Phase created, but could not link the event");
        }
      }

      toast(`Created “${saved.title}”`);
      closeModal();
      if (onSaved) onSaved(saved);
    } catch (err) {
      toast(err.message || "Could not create phase");
    }
  });
}

/** Edit phase: name, summary, from/to — auto-maps overlapping periods. */
export async function openEditPhase(phase, { onSaved } = {}) {
  const from = splitDateParts(phase.date_start);
  const to = splitDateParts(phase.date_end);
  try {
    hubs.period = await api.listEntities({ type: "period" });
  } catch {
    hubs.period = hubs.period || [];
  }
  const panel = document.getElementById("modal-panel");
  panel.innerHTML = `
    <div class="flex items-start justify-between mb-4">
      <div>
        <h2 class="font-display text-xl">Edit phase</h2>
        <p class="text-sm text-ink-muted mt-0.5">A named span inside periods — maps by date overlap</p>
      </div>
      <button type="button" class="btn-ghost text-lg leading-none" data-close-modal aria-label="Close">×</button>
    </div>
    <form id="phase-form" class="space-y-4">
      <div>
        <label class="label" for="phase-title">Name</label>
        <input id="phase-title" class="input" required maxlength="500" value="${escapeHtml(phase.title)}" />
      </div>
      <div>
        <label class="label" for="phase-summary">Summary</label>
        <textarea id="phase-summary" class="textarea" placeholder="What defines this phase…">${escapeHtml(phase.summary || "")}</textarea>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="label" for="phase-from-year">From</label>
          <div class="flex gap-2 items-center">
            <input id="phase-from-year" class="input" inputmode="numeric" placeholder="Year" value="${escapeHtml(from.year)}" />
            <label class="inline-flex items-center gap-1 text-xs"><input type="radio" name="phase-from-era" value="ac" ${from.era !== "bc" ? "checked" : ""} /> AC</label>
            <label class="inline-flex items-center gap-1 text-xs"><input type="radio" name="phase-from-era" value="bc" ${from.era === "bc" ? "checked" : ""} /> BC</label>
          </div>
        </div>
        <div>
          <label class="label" for="phase-to-year">To</label>
          <div class="flex gap-2 items-center">
            <input id="phase-to-year" class="input" inputmode="numeric" placeholder="Year" value="${escapeHtml(to.year)}" />
            <label class="inline-flex items-center gap-1 text-xs"><input type="radio" name="phase-to-era" value="ac" ${to.era !== "bc" ? "checked" : ""} /> AC</label>
            <label class="inline-flex items-center gap-1 text-xs"><input type="radio" name="phase-to-era" value="bc" ${to.era === "bc" ? "checked" : ""} /> BC</label>
          </div>
        </div>
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" class="btn-ghost" data-close-modal>Cancel</button>
        <button type="submit" class="btn-primary px-5 py-2.5">Save phase</button>
      </div>
    </form>
  `;
  openModal();
  document.getElementById("phase-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const title = document.getElementById("phase-title").value.trim();
    if (!title) {
      toast("Name is required");
      return;
    }
    const fromEra = document.querySelector('input[name="phase-from-era"]:checked')?.value || "ac";
    const toEra = document.querySelector('input[name="phase-to-era"]:checked')?.value || "ac";
    const fromYear = document.getElementById("phase-from-year").value.trim();
    const toYear = document.getElementById("phase-to-year").value.trim();
    if (!fromYear || !toYear) {
      toast("Set both From and To years");
      return;
    }
    const date_start = composeDate(fromYear, null, null, fromEra);
    const date_end = composeDate(toYear, null, null, toEra);
    const startN = storedToSignedYear(date_start);
    const endN = storedToSignedYear(date_end);
    if (startN != null && endN != null && startN > endN) {
      toast("From must be earlier than To");
      return;
    }
    const period_ids = autoAssignPeriodsForRange(startN, endN).map((p) => p.id);
    try {
      const saved = await api.updateEntity(phase.id, {
        title,
        summary: document.getElementById("phase-summary").value.trim() || null,
        date_start,
        date_end,
        period_ids,
      });
      toast(`Updated “${saved.title}”`);
      closeModal();
      if (onSaved) onSaved(saved);
    } catch (err) {
      toast(err.message || "Could not save");
    }
  });
}

export function bindModalChrome() {
  document.getElementById("modal-root").addEventListener("click", (e) => {
    if (e.target.matches("[data-close-modal]")) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
}

/** Add a moment (sub-point) under a parent event. */
export async function openAddMilestone(parentEvent, { onSaved } = {}) {
  return openMilestoneForm({ parentEvent, onSaved });
}

/** Edit an existing moment under its parent event. */
export async function openEditMilestone(milestone, parentEvent, { onSaved } = {}) {
  return openMilestoneForm({ milestone, parentEvent, onSaved });
}

async function openMilestoneForm({ milestone = null, parentEvent, onSaved } = {}) {
  const isEdit = Boolean(milestone?.id);
  let parent = parentEvent;
  if (!parent?.id && milestone?.parent_id) {
    try {
      parent = await api.getEntity(milestone.parent_id);
    } catch {
      toast("Could not load parent event");
      return;
    }
  }
  if (!parent?.id) {
    toast("Could not find parent event for this moment");
    return;
  }

  const panel = document.getElementById("modal-panel");
  if (!panel) {
    toast("Could not open form");
    return;
  }
  const parentRange =
    formatRange(parent.date_start, parent.date_end) ||
    (parent.date_start ? formatRange(parent.date_start, null) : "");
  const parentStart = storedToSignedYear(parent.date_start);
  const parentEnd = storedToSignedYear(parent.date_end) ?? parentStart;
  const fromParts = isEdit ? splitDateParts(milestone.date_start) : { year: "", month: "", day: "", era: "ac" };
  const toParts = isEdit
    ? splitDateParts(milestone.date_end)
    : { year: "", month: "", day: "", era: fromParts.era || "ac" };

  panel.innerHTML = `
    <div class="flex items-start justify-between mb-4">
      <div>
        <h2 class="font-display text-xl">${isEdit ? "Edit moment" : "Add moment"}</h2>
        <p class="text-sm text-ink-muted mt-0.5">Inside ${escapeHtml(parent.title)}${
          parentRange ? ` · must fall within ${escapeHtml(parentRange)}` : ""
        }</p>
      </div>
      <button type="button" class="btn-ghost text-lg leading-none" data-close-modal aria-label="Close">×</button>
    </div>
    <form id="milestone-form" class="space-y-4">
      <div>
        <label class="label" for="ms-title">What happened?</label>
        <input id="ms-title" class="input text-lg" required maxlength="500" placeholder="e.g. Imperial Guard advances" value="${escapeHtml(isEdit ? milestone.title : "")}" autofocus />
      </div>
      <div>
        <label class="label" for="ms-summary">Note <span class="font-normal text-ink-faint">(optional)</span></label>
        <textarea id="ms-summary" class="textarea" placeholder="Short note…">${escapeHtml(isEdit ? milestone.summary || "" : "")}</textarea>
      </div>
      <div class="rounded-lg border border-paper-line bg-paper-deep/30 p-2.5 space-y-3">
        <p class="text-[10px] uppercase tracking-wider text-ink-faint font-semibold">Date</p>
        <div>
          <p class="text-xs font-medium text-ink-muted mb-1">From</p>
          <div class="grid grid-cols-3 gap-2">
            <input id="ms-from-day" class="input" type="number" min="1" max="31" placeholder="Day" value="${escapeHtml(fromParts.day)}" />
            <input id="ms-from-month" class="input" type="number" min="1" max="12" placeholder="Month" value="${escapeHtml(fromParts.month)}" />
            <input id="ms-from-year" class="input" type="number" placeholder="Year" value="${escapeHtml(fromParts.year)}" />
          </div>
          <div class="flex gap-3 mt-1.5">
            <label class="inline-flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="radio" name="ms-from-era" value="ac" ${fromParts.era !== "bc" ? "checked" : ""} class="accent-accent" /> AC
            </label>
            <label class="inline-flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="radio" name="ms-from-era" value="bc" ${fromParts.era === "bc" ? "checked" : ""} class="accent-accent" /> BC
            </label>
          </div>
        </div>
        <div>
          <p class="text-xs font-medium text-ink-muted mb-1">To <span class="font-normal text-ink-faint">(optional)</span></p>
          <div class="grid grid-cols-3 gap-2">
            <input id="ms-to-day" class="input" type="number" min="1" max="31" placeholder="Day" value="${escapeHtml(toParts.day)}" />
            <input id="ms-to-month" class="input" type="number" min="1" max="12" placeholder="Month" value="${escapeHtml(toParts.month)}" />
            <input id="ms-to-year" class="input" type="number" placeholder="Year" value="${escapeHtml(toParts.year)}" />
          </div>
          <div class="flex gap-3 mt-1.5">
            <label class="inline-flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="radio" name="ms-to-era" value="ac" ${toParts.era !== "bc" ? "checked" : ""} class="accent-accent" /> AC
            </label>
            <label class="inline-flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="radio" name="ms-to-era" value="bc" ${toParts.era === "bc" ? "checked" : ""} class="accent-accent" /> BC
            </label>
          </div>
        </div>
      </div>
      <div class="flex justify-end gap-2 pt-1">
        <button type="button" class="btn-ghost" data-close-modal>Cancel</button>
        <button type="submit" class="btn-primary px-5 py-2.5">${isEdit ? "Save moment" : "Add moment"}</button>
      </div>
    </form>
  `;
  openModal();
  queueMicrotask(() => document.getElementById("ms-title")?.focus());

  document.getElementById("milestone-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const title = document.getElementById("ms-title")?.value.trim();
    if (!title) {
      toast("Add a title");
      return;
    }
    const fromEra = document.querySelector('input[name="ms-from-era"]:checked')?.value || "ac";
    const toEra = document.querySelector('input[name="ms-to-era"]:checked')?.value || "ac";
    const fromY = document.getElementById("ms-from-year")?.value.trim();
    const fromM = document.getElementById("ms-from-month")?.value;
    const fromD = document.getElementById("ms-from-day")?.value;
    const toY = document.getElementById("ms-to-year")?.value.trim();
    const toM = document.getElementById("ms-to-month")?.value;
    const toD = document.getElementById("ms-to-day")?.value;
    if ((fromM || fromD) && !fromY) {
      toast("Add a From year if you set month or day");
      return;
    }
    if ((toM || toD) && !toY) {
      toast("Add a To year if you set month or day");
      return;
    }
    const date_start = composeDate(fromY || null, fromM, fromD, fromEra);
    const date_end = composeDate(toY || null, toM, toD, toEra);
    const startN = storedToSignedYear(date_start);
    const endN = storedToSignedYear(date_end);
    if (startN != null && endN != null && startN > endN) {
      toast("From must be earlier than To");
      return;
    }
    if (date_end && !date_start) {
      toast("Set From before To");
      return;
    }
    if ((startN != null || endN != null) && parentStart == null) {
      toast("Set a From date on the event before adding a dated moment");
      return;
    }
    if (parentStart != null) {
      const lo = parentStart;
      const hi = parentEnd ?? parentStart;
      const outside = (y) => y != null && (y < lo || y > hi);
      if (outside(startN) || outside(endN)) {
        toast(
          parentRange
            ? `Moment must fall within the event (${parentRange})`
            : "Moment must fall within the event’s date range"
        );
        return;
      }
    }
    const summary = document.getElementById("ms-summary")?.value.trim() || null;
    try {
      let saved;
      if (isEdit) {
        saved = await api.updateEntity(milestone.id, {
          title,
          summary,
          date_start,
          date_end,
        });
        toast(`Updated “${saved.title}”`);
      } else {
        saved = await api.createEntity({
          type: "milestone",
          title,
          summary,
          body: null,
          date_start,
          date_end,
          parent_id: parent.id,
          tags: [],
          attachments: [],
          period_ids: [],
          phase_ids: [],
          country_ids: [],
          figure_ids: [],
          link_ids: [],
        });
        toast(`Added moment “${saved.title}”`);
      }
      closeModal();
      if (onSaved) onSaved(saved);
    } catch (err) {
      toast(err.message || `Could not ${isEdit ? "save" : "create"} moment`);
    }
  });
}

/** Create an empty topic (or with optional preselected members). */
export async function openAddTopic({
  onSaved,
  preselectEventIds = [],
  preselectPhaseIds = [],
} = {}) {
  const panel = document.getElementById("modal-panel");
  if (!panel) return;
  const nEvents = preselectEventIds.length;
  const nPhases = preselectPhaseIds.length;
  const memberNote =
    nEvents || nPhases
      ? `Will include ${[
          nEvents ? `${nEvents} event${nEvents === 1 ? "" : "s"}` : "",
          nPhases ? `${nPhases} phase${nPhases === 1 ? "" : "s"}` : "",
        ]
          .filter(Boolean)
          .join(" and ")}.`
      : "You can add events, phases, and figures to it afterward.";

  panel.innerHTML = `
    <div class="flex items-start justify-between mb-4">
      <div>
        <h2 class="font-display text-xl">Create topic</h2>
        <p class="text-sm text-ink-muted mt-0.5">${escapeHtml(memberNote)}</p>
      </div>
      <button type="button" class="btn-ghost text-lg leading-none" data-close-modal aria-label="Close">×</button>
    </div>
    <form id="add-topic-form" class="space-y-4">
      <div>
        <label class="label" for="add-topic-name">Name</label>
        <input id="add-topic-name" class="input text-lg" required maxlength="500" placeholder="e.g. Rise of Rome" autofocus autocomplete="off" />
      </div>
      <div>
        <label class="label" for="add-topic-summary">Summary <span class="font-normal text-ink-faint">(optional)</span></label>
        <textarea id="add-topic-summary" class="textarea" placeholder="What this topic covers…"></textarea>
      </div>
      <div class="flex justify-end gap-2 pt-1">
        <button type="button" class="btn-ghost" data-close-modal>Cancel</button>
        <button type="submit" class="btn-primary px-5 py-2.5">Create topic</button>
      </div>
    </form>
  `;
  openModal();
  queueMicrotask(() => document.getElementById("add-topic-name")?.focus());

  document.getElementById("add-topic-form")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const title = document.getElementById("add-topic-name")?.value.trim();
    if (!title) {
      toast("Enter a name");
      return;
    }
    try {
      const saved = await api.createTopic({
        title,
        summary: document.getElementById("add-topic-summary")?.value.trim() || null,
        event_ids: [...preselectEventIds],
        phase_ids: [...preselectPhaseIds],
      });
      toast(`Created “${saved.title}”`);
      closeModal();
      if (onSaved) onSaved(saved);
      else location.hash = `/entity/${saved.id}`;
    } catch (err) {
      toast(err.message || "Could not create topic");
    }
  });
}

/** Link existing events, phases, or figures into a topic. */
export async function openAddToTopic(topic, { kind = "event", onSaved } = {}) {
  const panel = document.getElementById("modal-panel");
  if (!panel || !topic?.id) return;
  const type = kind === "phase" ? "phase" : kind === "figure" ? "figure" : "event";
  const label = type;
  let candidates = [];
  const linked = new Set();
  try {
    const [list, neighbors] = await Promise.all([
      api.listEntities({ type }),
      api.neighbors(topic.id),
    ]);
    for (const item of neighborItems(neighbors, type)) linked.add(item.entity.id);
    if (type === "event") {
      for (const item of neighborItems(neighbors, "milestone")) linked.add(item.entity.id);
    }
    candidates = sortByTitle(list.filter((e) => !linked.has(e.id)));
  } catch (err) {
    toast(err.message || "Could not load items");
    return;
  }

  panel.innerHTML = `
    <div class="flex items-start justify-between mb-4">
      <div>
        <h2 class="font-display text-xl">Add ${label} to topic</h2>
        <p class="text-sm text-ink-muted mt-0.5">Link into “${escapeHtml(topic.title)}”</p>
      </div>
      <button type="button" class="btn-ghost text-lg leading-none" data-close-modal aria-label="Close">×</button>
    </div>
    <input id="topic-member-q" class="input mb-3" placeholder="Search…" autocomplete="off" />
    <div id="topic-member-list" class="max-h-72 overflow-y-auto rounded-lg border border-paper-line divide-y divide-paper-line"></div>
    <div class="flex justify-end gap-2 pt-4">
      <button type="button" class="btn-ghost" data-close-modal>Done</button>
    </div>
  `;
  openModal();

  const renderList = bindEntitySearchPicker({
    listId: "topic-member-list",
    searchId: "topic-member-q",
    getCandidates: () => candidates,
    isSelected: () => false,
    emptyNone: `No ${label}s left to add — create one from the library first.`,
    limit: 40,
    onPick: async (ent) => {
      try {
        await api.createLink({
          source_id: topic.id,
          target_id: ent.id,
          relation: "part_of",
        });
        candidates = candidates.filter((e) => e.id !== ent.id);
        toast("Added to topic");
        renderList();
        if (onSaved) onSaved();
      } catch (err) {
        toast(err.message || "Could not add");
      }
    },
  });
  queueMicrotask(() => document.getElementById("topic-member-q")?.focus());
}

export { closeModal };
