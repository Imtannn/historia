/** World timeline — full chronicle + Phase→Events→Moments mindmap branches. */

import { api } from "../api.js";
import { openAddPhase } from "../modal.js";
import {
  compareByDateThenTitle,
  escapeHtml,
  formatDate,
  formatRange,
  formatSignedYear,
  storedToSignedYear,
  typeLabel,
} from "../util.js";

const VIEWS = ["phases", "events", "periods"];
const ORIENTS = ["vertical", "horizontal"];
/** Year-gap zoom steps (coarse → fine). Full chronicle always on the spine. */
const YEAR_GAPS = [1000, 500, 100, 50, 10];
const DEFAULT_ZOOM_INDEX = YEAR_GAPS.indexOf(100);
const PX_PER_GAP = 72;
const BRANCH_ROW_PX = 72;
const STAGE_MIN_PX = 1400;
const STAGE_MAX_PX = 320000;
const MAX_TICKS = 20000;
const MAX_TICK_LABELS = 10;
const MIN_SPAN_PCT = 0.15;
const CLUSTER_PCT = 1.2;
const STACK_REM = 3.25;
const STACK_LANE_REM = 1.25;
const FAN_GAP_PX = 40;
const FAN_WIDTH_PX = 17 * 16;
const FAN_STAGE_PAD_PX = 48;
const MMAP_SCROLL_PAD_PX = 48;
const CURVE_MIN_DX = 28;
const WHEEL_ZOOM_STEP_PX = 140;
const TAG_DEBOUNCE_MS = 250;
const MOBILE_MQ = "(max-width: 767px)";
const HORIZONTAL_STAGE_H = 28 * 16; // ~28rem card lane
const REL_PART_OF = "part_of";
const REL_CHILD = "child";
const SCOPE_ALL = "";
const SCOPE_TL = "timeline";
const SCOPE_PHASE = "phase";
const SCOPE_PERIOD = "period";

/** @type {AbortController | null} */
let activeUiAbort = null;

/**
 * @typedef {{ id: string, title: string, type: string, date_start?: string|null, date_end?: string|null }} TimelineEntity
 * @typedef {{ entity: TimelineEntity, display_date?: string, display_end?: string|null, sort_year?: number|null, end_year?: number|null, position?: number|null, position_end?: number|null, color?: string|null, start_year?: number, left?: number, width?: number }} TimelineItem
 * @typedef {{ loading: boolean, items: TimelineEntity[], error?: string }} ChildrenCacheEntry
 * @typedef {{ entity: TimelineEntity, relation?: string|{value?: string}, direction?: string }} NeighborItem
 */

function fmtYearGap(gap) {
  const n = Math.max(1, Math.round(gap));
  const num = n.toLocaleString("en-US");
  return n === 1 ? "1 year" : `${num} years`;
}

function sortEntitiesByDate(list) {
  return (list || []).slice().sort(compareByDateThenTitle);
}

function stageExtentPx(worldSpan, yearGap, branchExtra = 0) {
  const span = Math.max(worldSpan, 1);
  const gap = Math.max(yearGap, 1);
  const raw = (span / gap) * PX_PER_GAP;
  return Math.round(Math.min(Math.max(raw, STAGE_MIN_PX), STAGE_MAX_PX) + branchExtra);
}

function normalizeView(raw) {
  const v = String(raw || "").toLowerCase();
  return VIEWS.includes(v) ? v : "phases";
}

function normalizeOrient(raw) {
  const v = String(raw || "").toLowerCase();
  return ORIENTS.includes(v) ? v : "vertical";
}

function pct(year, lo, hi) {
  const span = Math.max(hi - lo, 1e-9);
  return ((year - lo) / span) * 100;
}

/** Axis ticks; only a sparse subset gets labels to avoid clutter. */
function makeTicks(lo, hi, yearGap) {
  const step = Math.max(1, Math.round(yearGap));
  const ticks = [];
  let y = Math.floor(lo / step) * step;
  let n = 0;
  while (y <= hi + step && n < MAX_TICKS) {
    if (y >= lo && y <= hi) {
      ticks.push({
        year: y,
        position: pct(y, lo, hi),
        label: formatSignedYear(y),
        showLabel: false,
      });
      n += 1;
    }
    y += step;
  }
  if (!ticks.length) return ticks;
  const labelEvery = Math.max(1, Math.ceil(ticks.length / MAX_TICK_LABELS));
  ticks.forEach((t, i) => {
    t.showLabel = i === 0 || i === ticks.length - 1 || i % labelEvery === 0;
  });
  return ticks;
}

function projectItem(item, lo, hi) {
  const y0 = item.sort_year;
  if (y0 == null) return null;
  return {
    ...item,
    position: pct(y0, lo, hi),
    position_end: item.end_year != null ? pct(item.end_year, lo, hi) : null,
  };
}

function projectBand(band, lo, hi) {
  if (band.start_year == null || band.end_year == null) return null;
  const a = Math.min(band.start_year, band.end_year);
  const b = Math.max(band.start_year, band.end_year);
  const top = pct(a, lo, hi);
  const bottom = pct(b, lo, hi);
  return {
    ...band,
    left: top,
    width: Math.max(bottom - top, MIN_SPAN_PCT),
  };
}

/** @param {TimelineEntity} e */
function entityToTimelineItem(e) {
  const y0 = storedToSignedYear(e.date_start);
  const y1 = storedToSignedYear(e.date_end);
  return {
    entity: e,
    display_date: formatDate(e.date_start) || "?",
    display_end: e.date_end ? formatDate(e.date_end) : null,
    sort_year: y0,
    end_year: y1,
  };
}

function scopeValue(kind, id) {
  return id ? `${kind}:${id}` : SCOPE_ALL;
}

function parseScopeValue(raw) {
  const s = String(raw || "");
  if (!s) return { kind: SCOPE_ALL, id: "" };
  const i = s.indexOf(":");
  if (i < 0) return { kind: SCOPE_TL, id: s }; // legacy timeline id only
  return { kind: s.slice(0, i), id: s.slice(i + 1) };
}

function bandOptionLabel(b) {
  const title = b.entity?.title || "Untitled";
  const a = formatSignedYear(b.start_year);
  const z = formatSignedYear(b.end_year);
  return a && z ? `${title} (${a} – ${z})` : title;
}

/** Narrowest band covering a year (phases or periods). */
function bandAtYear(year, bands) {
  if (year == null || !bands?.length) return null;
  let best = null;
  let bestSpan = Infinity;
  for (const p of bands) {
    if (p.start_year == null || p.end_year == null) continue;
    const lo = Math.min(p.start_year, p.end_year);
    const hi = Math.max(p.start_year, p.end_year);
    if (year < lo || year > hi) continue;
    const span = hi - lo;
    if (span < bestSpan) {
      best = p;
      bestSpan = span;
    }
  }
  return best;
}

/** Event / card ink from the phase that covers its year (narrowest). */
function colorForTimelineItem(item, phaseBands) {
  if (item?.entity?.type === "phase" && item.color) return item.color;
  const y = item?.sort_year;
  const mid = item?.end_year != null && y != null ? (y + item.end_year) / 2 : y;
  return bandAtYear(mid, phaseBands)?.color || item?.color || null;
}

function renderTicksHtml(ticks, phaseBands, horizontal) {
  return (ticks || [])
    .map((t) => {
      const phase = bandAtYear(t.year, phaseBands);
      const ink = phase ? `--tick:${phase.color};` : "";
      const pos = horizontal ? `left:${t.position}%` : `top:${t.position}%`;
      return `
            <div class="wt-tick ${phase ? "has-phase" : ""} ${t.showLabel ? "has-label" : ""}" style="${pos};${ink}">
              <span class="wt-tick-mark"></span>
              ${
                t.showLabel
                  ? `<span class="wt-tick-label">${escapeHtml(t.label)}</span>`
                  : ""
              }
            </div>`;
    })
    .join("");
}

/** Colored axis spans = phases. */
function renderAxisSegmentsHtml(phaseBands, horizontal) {
  return (phaseBands || [])
    .map((p) => {
      const pos = horizontal
        ? `left:${p.left}%;width:${p.width}%`
        : `top:${p.left}%;height:${p.width}%`;
      const title = p.entity?.title || "Phase";
      const range =
        p.start_year != null && p.end_year != null
          ? `${formatSignedYear(p.start_year)} – ${formatSignedYear(p.end_year)}`
          : "";
      const tip = range ? `${title} · ${range}` : title;
      return `
    <div class="wt-axis-seg" style="${pos};--seg:${p.color}"
      data-phase-tip="${escapeHtml(tip)}"
      title="${escapeHtml(tip)}"
      role="img"
      aria-label="${escapeHtml(tip)}"></div>`;
    })
    .join("");
}

/**
 * Periods as dash breakpoints on the axis (era boundaries).
 * One dash per unique boundary year; label with period(s) that start there.
 */
function periodBreakpoints(periods, worldLo, worldHi) {
  if (worldLo == null || worldHi == null || !periods?.length) return [];
  /** @type {Map<number, { year: number, position: number, titles: string[] }>} */
  const byYear = new Map();
  for (const p of periods) {
    if (p.start_year == null || p.end_year == null) continue;
    const start = Math.min(p.start_year, p.end_year);
    const end = Math.max(p.start_year, p.end_year);
    const title = p.entity?.title || "Period";
    for (const [year, asStart] of [
      [start, true],
      [end, false],
    ]) {
      if (year < worldLo || year > worldHi) continue;
      let entry = byYear.get(year);
      if (!entry) {
        entry = { year, position: pct(year, worldLo, worldHi), titles: [], starts: [] };
        byYear.set(year, entry);
      }
      if (asStart) entry.starts.push(title);
      else if (!entry.titles.includes(title) && !entry.starts.includes(title)) {
        entry.titles.push(title);
      }
    }
  }
  return [...byYear.values()]
    .map((e) => ({
      year: e.year,
      position: e.position,
      label: (e.starts.length ? e.starts : e.titles).join(" · ") || formatSignedYear(e.year),
      color: null,
    }))
    .sort((a, b) => a.year - b.year);
}

function renderPeriodBreaksHtml(breaks, horizontal) {
  return (breaks || [])
    .map((b) => {
      const pos = horizontal ? `left:${b.position}%` : `top:${b.position}%`;
      return `
    <div class="wt-period-break" style="${pos}" title="${escapeHtml(b.label)}">
      <span class="wt-period-break-mark" aria-hidden="true"></span>
      <span class="wt-period-break-label">${escapeHtml(b.label)}</span>
    </div>`;
    })
    .join("");
}

function viewCopy(view, empty) {
  if (empty) {
    return "Your chronicle of the world starts empty. Each dated event etches another mark on the axis of time.";
  }
  if (view === "periods") {
    return "Periods mark era breakpoints on the axis — pick one in the scope menu to jump there. Phases color the spine.";
  }
  if (view === "phases") {
    return "Phases color the axis; their events sit as cards — pick a phase to focus, then expand for moments.";
  }
  return "Events as cards on the spine. Phases color the axis; periods mark era breakpoints.";
}

function viewEmpty(view, { phasesExist = false, periodsExist = false } = {}) {
  if (view === "periods") {
    if (periodsExist) {
      return {
        title: "Period breakpoints",
        copy: "Pick a period in the scope menu to jump to that era boundary. Phases color the spine; events live on Events and Phases.",
        cta: "Add event",
      };
    }
    return {
      title: "No periods yet",
      copy: "Create a period with a From–To range — it will appear as a dash breakpoint on the axis.",
      cta: "Add an event (then link a period)",
    };
  }
  if (view === "phases") {
    return {
      title: "No phases yet",
      copy: "Create a phase to color the axis and group events on the spine.",
      cta: "Add phase",
    };
  }
  return {
    title: "The axis awaits",
    copy: "Add a dated event — Waterloo, Caesar, your family’s story — and watch the first point appear.",
    cta: "Add your first moment",
  };
}

function scopeSelectHtml({ timelines, phases, periods, selectedValue }) {
  const tlOpts = (timelines || [])
    .map(
      (t) =>
        `<option value="${escapeHtml(scopeValue(SCOPE_TL, t.id))}" ${
          selectedValue === scopeValue(SCOPE_TL, t.id) ? "selected" : ""
        }>${escapeHtml(t.title)}</option>`
    )
    .join("");
  const phaseOpts = (phases || [])
    .map((p) => {
      const val = scopeValue(SCOPE_PHASE, p.entity?.id);
      return `<option value="${escapeHtml(val)}" ${
        selectedValue === val ? "selected" : ""
      }>${escapeHtml(bandOptionLabel(p))}</option>`;
    })
    .join("");
  const periodOpts = (periods || [])
    .map((p) => {
      const val = scopeValue(SCOPE_PERIOD, p.entity?.id);
      return `<option value="${escapeHtml(val)}" ${
        selectedValue === val ? "selected" : ""
      }>${escapeHtml(bandOptionLabel(p))}</option>`;
    })
    .join("");
  return `
    <select id="tl-pick" class="select wt-select wt-scope-select" aria-label="Scope">
      <option value="" ${!selectedValue ? "selected" : ""}>All of history</option>
      ${tlOpts ? `<optgroup label="Timelines">${tlOpts}</optgroup>` : ""}
      ${phaseOpts ? `<optgroup label="Phases">${phaseOpts}</optgroup>` : ""}
      ${periodOpts ? `<optgroup label="Periods">${periodOpts}</optgroup>` : ""}
    </select>`;
}

function dateLabelForEntity(e) {
  return formatRange(e?.date_start, e?.date_end) || formatDate(e?.date_start) || "?";
}

function relationValue(rel) {
  if (rel == null) return "";
  if (typeof rel === "object" && rel.value != null) return String(rel.value);
  return String(rel);
}

/** @param {NeighborItem} x */
function isChildNeighbor(x) {
  return x.direction === REL_CHILD || relationValue(x.relation) === REL_CHILD;
}

/** @param {NeighborItem} x */
function isPartOfNeighbor(x) {
  return relationValue(x.relation) === REL_PART_OF;
}

function mmapEmptyHtml(message) {
  return `<div class="wt-mmap-empty">${escapeHtml(message)}</div>`;
}

function expandKindFor(view, entityType) {
  if (entityType === "event" && (view === "events" || view === "phases")) return "event";
  return null;
}

function renderExpandBtn(id, kind, expanded, cache) {
  if (!kind) return "";
  const isOpen = expanded.has(id);
  const entry = cache.get(id);
  const count = entry?.items?.length;
  const countLabel = entry?.loading ? "…" : count != null ? String(count) : "▸";
  const safeId = escapeHtml(id);
  return `
    <button type="button"
      class="wt-expand ${isOpen ? "is-open" : ""}"
      data-wt-expand="${safeId}"
      data-wt-expand-kind="${kind}"
      aria-expanded="${isOpen ? "true" : "false"}"
      title="${kind === "phase" ? "Show events" : "Show moments"}">
      <span class="wt-expand-chevron" aria-hidden="true">${isOpen ? "▾" : "▸"}</span>
      <span class="wt-expand-count">${escapeHtml(countLabel)}</span>
    </button>`;
}

function renderDetailsLink(id) {
  return `<a href="#/entity/${escapeHtml(id)}" class="wt-card-details" title="Open details" aria-label="Open details">↗</a>`;
}

function renderCardInner({ dateLabel, title, type, isRange, startYear, endYear }) {
  const core = `
            <span class="wt-event-date">${escapeHtml(dateLabel)}</span>
            <span class="wt-event-title">${escapeHtml(title)}</span>
            <span class="type-badge">${escapeHtml(typeLabel(type))}</span>`;
  if (!isRange) return core;
  return `${core}
            <span class="wt-event-range-foot" aria-hidden="true">
              <span>${escapeHtml(startYear)}</span>
              <span class="wt-event-range-arrow">↓</span>
              <span>${escapeHtml(endYear)}</span>
            </span>`;
}

/** @param {HTMLElement} stage @param {string} rootId */
function rootCardEl(stage, rootId) {
  return (
    stage.querySelector(`#wt-ev-${CSS.escape(rootId)} .wt-event-card-wrap`) ||
    stage.querySelector(`#wt-ev-${CSS.escape(rootId)} .wt-event-card`) ||
    stage.querySelector(`[data-mmap-anchor="${CSS.escape(rootId)}"]`)
  );
}

function isMobileTimeline() {
  return typeof window !== "undefined" && window.matchMedia?.(MOBILE_MQ)?.matches;
}

function wheelDeltaPx(e) {
  const mode = e.deltaMode;
  if (mode === 1) return e.deltaY * 16;
  if (mode === 2) return e.deltaY * (window.innerHeight || 800);
  return e.deltaY;
}

function nodeAxisStyle({ position, spanPct, stack, isRange, horizontal, side }) {
  if (horizontal) {
    if (isRange && spanPct != null) {
      return `left:${position}%;width:${spanPct}%;--stack-n:${stack};--stack-lane:${STACK_LANE_REM}rem`;
    }
    if (side === "above") {
      return stack === 0
        ? `left:${position}%;bottom:50%;top:auto`
        : `left:${position}%;bottom:calc(50% + ${stack * STACK_REM}rem);top:auto`;
    }
    return stack === 0
      ? `left:${position}%;top:50%`
      : `left:${position}%;top:calc(50% + ${stack * STACK_REM}rem)`;
  }
  if (isRange && spanPct != null) {
    return `top:${position}%;height:${spanPct}%;--stack-n:${stack};--stack-lane:${STACK_LANE_REM}rem`;
  }
  return stack === 0
    ? `top:${position}%`
    : `top:calc(${position}% + ${stack * STACK_REM}rem)`;
}

function renderPrimaryNodesHtml(
  primaryItems,
  stackOffsets,
  eventSides,
  view,
  expanded,
  cache,
  phaseBands,
  horizontal
) {
  return primaryItems
    .map((item, idx) => {
      const e = item.entity;
      const yearSpan =
        item.sort_year != null && item.end_year != null
          ? Math.abs(item.end_year - item.sort_year)
          : 0;
      const spanPct =
        item.position_end != null
          ? Math.max(item.position_end - item.position, MIN_SPAN_PCT)
          : null;
      const isRange =
        spanPct != null && yearSpan > 0 && e.type === "event" && view === "events";
      const dateLabel = item.display_end
        ? `${item.display_date} – ${item.display_end}`
        : item.display_date || "?";
      const stack = stackOffsets[idx] || 0;
      const side = eventSides[idx] || (horizontal ? "below" : "right");
      const startYear = item.sort_year != null ? formatSignedYear(item.sort_year) : "";
      const endYear =
        item.end_year != null
          ? formatSignedYear(item.end_year)
          : item.display_end
            ? String(item.display_end)
            : "";
      const axisStyle = nodeAxisStyle({
        position: item.position,
        spanPct,
        stack,
        isRange,
        horizontal,
        side,
      });
      const phaseColor = colorForTimelineItem(item, phaseBands);
      const ink = phaseColor ? `--node:${phaseColor};` : "";
      const kind = expandKindFor(view, e.type);
      const isRoot = e.type === "event" && (view === "events" || view === "phases");
      const safeId = escapeHtml(e.id);
      const cardInner = renderCardInner({
        dateLabel,
        title: e.title,
        type: e.type,
        isRange,
        startYear,
        endYear,
      });
      const cardHtml = kind
        ? `<button type="button" class="wt-event-card ${isRange ? "is-range-card" : ""} ${expanded.has(e.id) ? "is-open" : ""}"
              data-wt-expand="${safeId}" data-wt-expand-kind="${kind}"
              aria-expanded="${expanded.has(e.id) ? "true" : "false"}">
              ${cardInner}
            </button>`
        : `<a href="#/entity/${safeId}" class="wt-event-card ${isRange ? "is-range-card" : ""}">${cardInner}</a>`;
      return `
      <div class="wt-event is-${side} ${isRange ? "is-range" : ""} ${phaseColor ? "has-phase-color" : ""} ${isRoot ? "is-mmap-root" : ""} ${expanded.has(e.id) ? "is-expanded" : ""}"
        style="${axisStyle};--i:${idx};${ink}"
        data-year="${item.sort_year ?? ""}"
        data-entity-id="${safeId}"
        data-entity-type="${escapeHtml(e.type)}"
        data-side="${side}"
        data-pos="${item.position}"
        id="wt-ev-${safeId}">
        ${isRange ? `<span class="wt-event-rail" aria-hidden="true"></span>` : ""}
        <span class="wt-event-node ${isRange ? "is-range-start" : ""}" data-mmap-anchor="${safeId}" title="${escapeHtml(dateLabel)}"></span>
        ${
          isRange && endYear
            ? `<span class="wt-event-node is-range-end" title="${escapeHtml(endYear)}"></span>`
            : ""
        }
        <div class="wt-event-card-wrap">
          ${renderExpandBtn(e.id, kind, expanded, cache)}
          ${cardHtml}
          ${renderDetailsLink(e.id)}
        </div>
      </div>`;
    })
    .join("");
}

function renderMomentCard(e) {
  const safeId = escapeHtml(e.id);
  return `
    <a href="#/entity/${safeId}" class="wt-mmap-card is-moment" id="wt-mmap-ms-${safeId}" data-mmap-node="${safeId}">
      <span class="wt-mmap-kicker">Moment</span>
      <span class="wt-mmap-date">${escapeHtml(dateLabelForEntity(e))}</span>
      <span class="wt-mmap-title">${escapeHtml(e.title)}</span>
    </a>`;
}

/** Mindmap fan on the same side as the event card (or above/below when horizontal). */
function renderMindmapsHtml(primaryItems, eventSides, view, expanded, cache, horizontal) {
  const chunks = [];
  primaryItems.forEach((item, idx) => {
    const e = item.entity;
    if (!expanded.has(e.id)) return;
    const kind = expandKindFor(view, e.type);
    if (!kind) return;
    const fanSide = eventSides[idx] || (horizontal ? "below" : "right");
    const entry = cache.get(e.id);
    const mid =
      item.position_end != null
        ? (item.position + item.position_end) / 2
        : item.position;
    const posStyle = horizontal ? `left:${mid}%` : `top:${mid}%`;
    let body = "";
    if (!entry || entry.loading) {
      body = mmapEmptyHtml("Loading…");
    } else if (entry.error) {
      body = mmapEmptyHtml(entry.error);
    } else if (kind === "event") {
      body = !entry.items.length
        ? mmapEmptyHtml("No moments yet")
        : `<div class="wt-mmap-moments" data-mmap-parent="${escapeHtml(e.id)}">
          ${entry.items.map(renderMomentCard).join("")}
        </div>`;
    }
    chunks.push(`
      <div class="wt-mmap is-fan-${fanSide}" style="${posStyle}" data-mmap-root="${escapeHtml(e.id)}" data-mmap-kind="${kind}" data-fan="${fanSide}">
        <div class="wt-mmap-tree">
          ${body}
        </div>
      </div>`);
  });
  return chunks.join("");
}

/**
 * Place each mindmap fan just outside the root card.
 * Vertical: left/right. Horizontal: above/below.
 * On mobile vertical, CSS owns layout — clear inline overrides.
 */
function layoutMindmapFans(stage) {
  if (!stage) return;
  const mmaps = stage.querySelectorAll(".wt-mmap[data-mmap-root]");
  if (!mmaps.length) return;
  const horizontal = stage.classList.contains("is-horizontal");

  if (!horizontal && isMobileTimeline()) {
    mmaps.forEach((mmap) => {
      mmap.style.left = "";
      mmap.style.right = "";
      mmap.style.top = "";
      mmap.style.bottom = "";
      mmap.style.width = "";
    });
    stage.style.minWidth = "";
    return;
  }

  const sr = stage.getBoundingClientRect();
  let stageW = stage.offsetWidth;
  let stageH = stage.offsetHeight;
  let minNeeded = horizontal ? stageH : stageW;

  function placeFan(mmap, stageRect) {
    const fan = mmap.dataset.fan || (horizontal ? "below" : "right");
    const rootWrap = rootCardEl(stage, mmap.dataset.mmapRoot || "");
    if (!rootWrap) return;
    const rr = rootWrap.getBoundingClientRect();
    mmap.style.width = `${FAN_WIDTH_PX}px`;

    if (horizontal) {
      mmap.style.left = `${rr.left - stageRect.left + rr.width / 2 - FAN_WIDTH_PX / 2}px`;
      mmap.style.right = "auto";
      if (fan === "above") {
        const bottomEdge = rr.top - stageRect.top - FAN_GAP_PX;
        mmap.style.top = "auto";
        mmap.style.bottom = `${Math.max(0, stageH - bottomEdge)}px`;
        mmap.style.transform = "translateY(0)";
      } else {
        const topEdge = rr.bottom - stageRect.top + FAN_GAP_PX;
        mmap.style.bottom = "auto";
        mmap.style.top = `${topEdge}px`;
        mmap.style.transform = "translateY(0)";
        minNeeded = Math.max(minNeeded, topEdge + 200);
      }
      return;
    }

    mmap.style.top = "";
    mmap.style.bottom = "";
    if (fan === "left") {
      const rightEdge = rr.left - stageRect.left - FAN_GAP_PX;
      mmap.style.left = "auto";
      mmap.style.right = `${Math.max(0, stageW - rightEdge)}px`;
      const fanLeft = rightEdge - FAN_WIDTH_PX;
      if (fanLeft < FAN_STAGE_PAD_PX) {
        minNeeded = Math.max(minNeeded, stageW + (FAN_STAGE_PAD_PX - fanLeft));
      }
    } else {
      const leftEdge = rr.right - stageRect.left + FAN_GAP_PX;
      mmap.style.right = "auto";
      mmap.style.left = `${leftEdge}px`;
      minNeeded = Math.max(minNeeded, leftEdge + FAN_WIDTH_PX + FAN_STAGE_PAD_PX);
    }
  }

  mmaps.forEach((mmap) => placeFan(mmap, sr));

  if (!horizontal && minNeeded > stageW + 1) {
    stage.style.minWidth = `${Math.ceil(minNeeded)}px`;
    const sr2 = stage.getBoundingClientRect();
    stageW = stage.offsetWidth;
    mmaps.forEach((mmap) => placeFan(mmap, sr2));
  } else if (horizontal && minNeeded > stageH + 1) {
    stage.style.minHeight = `${Math.ceil(minNeeded)}px`;
    const sr2 = stage.getBoundingClientRect();
    stageH = stage.offsetHeight;
    mmaps.forEach((mmap) => placeFan(mmap, sr2));
  }
}

/**
 * Draw cubic bezier links from root card → Moments (and nested cards).
 * Coordinates are relative to the stage element.
 */
function paintMindmapLinks(stage) {
  if (!stage) return;
  layoutMindmapFans(stage);

  let svg = stage.querySelector("svg.wt-mmap-links");
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("wt-mmap-links");
    svg.setAttribute("aria-hidden", "true");
    stage.prepend(svg);
  }
  const w = Math.max(stage.scrollWidth, stage.offsetWidth, 1);
  const h = Math.max(stage.scrollHeight, stage.offsetHeight, 1);
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.innerHTML = "";

  const stageRect = stage.getBoundingClientRect();

  function pt(el, edge) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    let x = r.left - stageRect.left + r.width / 2;
    let y = r.top - stageRect.top + r.height / 2;
    if (edge === "left") x = r.left - stageRect.left;
    else if (edge === "right") x = r.right - stageRect.left;
    else if (edge === "top") y = r.top - stageRect.top;
    else if (edge === "bottom") y = r.bottom - stageRect.top;
    return { x, y };
  }

  function curve(a, b, className) {
    if (!a || !b) return;
    if (Number.isNaN(a.x) || Number.isNaN(a.y) || Number.isNaN(b.x) || Number.isNaN(b.y)) return;
    const horiz = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    if (horiz) {
      const dx = Math.max(Math.abs(b.x - a.x) * 0.45, CURVE_MIN_DX);
      const c1x = a.x <= b.x ? a.x + dx : a.x - dx;
      const c2x = a.x <= b.x ? b.x - dx : b.x + dx;
      path.setAttribute(
        "d",
        `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} C ${c1x.toFixed(1)} ${a.y.toFixed(1)}, ${c2x.toFixed(1)} ${b.y.toFixed(1)}, ${b.x.toFixed(1)} ${b.y.toFixed(1)}`
      );
    } else {
      const dy = Math.max(Math.abs(b.y - a.y) * 0.45, CURVE_MIN_DX);
      const c1y = a.y <= b.y ? a.y + dy : a.y - dy;
      const c2y = a.y <= b.y ? b.y - dy : b.y + dy;
      path.setAttribute(
        "d",
        `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} C ${a.x.toFixed(1)} ${c1y.toFixed(1)}, ${b.x.toFixed(1)} ${c2y.toFixed(1)}, ${b.x.toFixed(1)} ${b.y.toFixed(1)}`
      );
    }
    path.setAttribute("class", className);
    path.setAttribute("fill", "none");
    svg.appendChild(path);
  }

  function fanEdges(fan) {
    if (fan === "above") return { root: "top", child: "bottom" };
    if (fan === "below") return { root: "bottom", child: "top" };
    if (fan === "left") return { root: "left", child: "right" };
    return { root: "right", child: "left" };
  }

  stage.querySelectorAll(".wt-mmap[data-mmap-root]").forEach((mmap) => {
    const rootId = mmap.dataset.mmapRoot;
    const fan = mmap.dataset.fan || "right";
    const { root: rootEdge, child: childEdge } = fanEdges(fan);
    const rootEl = rootCardEl(stage, rootId || "");
    const rootPt = pt(rootEl, rootEdge);

    mmap.querySelectorAll(".wt-mmap-card.is-moment").forEach((ms) => {
      curve(rootPt, pt(ms, childEdge), "wt-mmap-path is-moment-link");
    });
  });
}

function yearAtScroll(host, stage, worldLo, worldHi, clientCoord = null, horizontal = false) {
  if (!host || !stage) return (worldLo + worldHi) / 2;
  const span = Math.max(worldHi - worldLo, 1);
  const hostRect = host.getBoundingClientRect();
  if (horizontal) {
    const focusX = clientCoord != null ? clientCoord - hostRect.left : host.clientWidth / 2;
    const contentX = host.scrollLeft + focusX;
    const frac = Math.min(1, Math.max(0, contentX / Math.max(stage.offsetWidth, 1)));
    return worldLo + frac * span;
  }
  const focusY = clientCoord != null ? clientCoord - hostRect.top : host.clientHeight / 2;
  const contentY = host.scrollTop + focusY;
  const frac = Math.min(1, Math.max(0, contentY / Math.max(stage.offsetHeight, 1)));
  return worldLo + frac * span;
}

async function fetchChildren(id, kind) {
  const data = await api.neighbors(id);
  const related = data.related || {};
  if (kind === "phase") {
    /** @type {NeighborItem[]} */
    const raw = related.event || [];
    const partOf = raw.filter(isPartOfNeighbor).map((x) => x.entity).filter(Boolean);
    const entities = partOf.length
      ? partOf
      : raw.map((x) => x.entity).filter(Boolean);
    return sortEntitiesByDate(entities);
  }
  /** @type {NeighborItem[]} */
  const moments = (related.milestone || [])
    .filter(isChildNeighbor)
    .map((x) => x.entity)
    .filter(Boolean);
  return sortEntitiesByDate(moments);
}

/** Events belonging to one phase, or all phases when phaseIds is the full set. */
async function fetchPhaseEventItems(phaseIds, worldLo, worldHi) {
  const ids = (phaseIds || []).filter(Boolean);
  if (!ids.length || worldLo == null || worldHi == null) return [];
  const lists = await Promise.all(
    ids.map((id) => fetchChildren(id, "phase").catch(() => []))
  );
  /** @type {Map<string, TimelineEntity>} */
  const byId = new Map();
  for (const entities of lists) {
    for (const e of entities) {
      if (e?.id) byId.set(e.id, e);
    }
  }
  return sortEntitiesByDate([...byId.values()])
    .map(entityToTimelineItem)
    .map((i) => projectItem(i, worldLo, worldHi))
    .filter(Boolean);
}

export async function renderTimeline(root, { query = {} } = {}) {
  const tag = query.tag || "";
  const view = normalizeView(query.view);
  const orient = normalizeOrient(query.orient);
  const horizontal = orient === "horizontal";

  const phaseId = query.phase_id || "";
  const periodId = query.period_id || "";
  const timelineId = !phaseId && !periodId ? query.timeline_id || "" : "";
  const selectedScope = phaseId
    ? scopeValue(SCOPE_PHASE, phaseId)
    : periodId
      ? scopeValue(SCOPE_PERIOD, periodId)
      : timelineId
        ? scopeValue(SCOPE_TL, timelineId)
        : SCOPE_ALL;

  const data = await api.timeline({
    ...(timelineId ? { timeline_id: timelineId } : {}),
    ...(tag ? { tag } : {}),
  });

  // Moments stay off the flat spine — only via Event expand
  const datedEvents = data.items.filter(
    (i) =>
      (i.sort_year != null || i.position != null) &&
      i.entity?.type !== "milestone"
  );
  const undated = data.items.filter(
    (i) =>
      i.sort_year == null &&
      i.position == null &&
      i.entity?.type !== "milestone"
  );
  const periods = data.periods || [];
  const phases = data.phases || [];
  const stats = data.stats || {};

  const worldLo = data.range?.start_year;
  const worldHi = data.range?.end_year;
  const hasRange = worldLo != null && worldHi != null && worldHi > worldLo;
  const worldSpan = hasRange ? worldHi - worldLo : 1;

  /** @type {TimelineItem[]} */
  let phaseEventItems = [];
  if (view === "phases" && hasRange && phases.length) {
    const phaseIds = phaseId
      ? [phaseId]
      : phases.map((p) => p.entity?.id).filter(Boolean);
    try {
      phaseEventItems = await fetchPhaseEventItems(phaseIds, worldLo, worldHi);
    } catch {
      phaseEventItems = [];
    }
  }

  let zoomIndex = DEFAULT_ZOOM_INDEX >= 0 ? DEFAULT_ZOOM_INDEX : 0;
  let yearGap = YEAR_GAPS[zoomIndex];
  /** @type {Set<string>} */
  const expanded = new Set();
  /** @type {Map<string, ChildrenCacheEntry>} */
  const childrenCache = new Map();
  /** @type {Map<string, number>} */
  const expandEpoch = new Map();

  const worldEmpty =
    datedEvents.length === 0 &&
    periods.length === 0 &&
    phases.length === 0 &&
    undated.length === 0;

  let showUndated = false;
  let viewEmptyState = false;
  let showStage = false;
  if (view === "periods") {
    viewEmptyState = !worldEmpty && periods.length === 0;
    showStage = !worldEmpty && periods.length > 0 && hasRange;
  } else if (view === "phases") {
    viewEmptyState = !worldEmpty && phases.length === 0;
    showStage = phases.length > 0 && hasRange && !worldEmpty;
  } else {
    showUndated = undated.length > 0;
    viewEmptyState = !worldEmpty && datedEvents.length === 0 && undated.length === 0;
    showStage = hasRange && datedEvents.length > 0;
  }
  const empty = worldEmpty || viewEmptyState;
  const emptyMsg = viewEmpty(view, {
    phasesExist: phases.length > 0,
    periodsExist: periods.length > 0,
  });

  root.classList.add("view-world-timeline");

  function openAdd() {
    document.getElementById("quick-add-btn")?.click();
  }

  function openPhase() {
    openAddPhase({
      onSaved: (saved) => {
        const params = new URLSearchParams();
        if (saved?.id) params.set("phase_id", saved.id);
        if (tag) params.set("tag", tag);
        if (orient !== "vertical") params.set("orient", orient);
        const s = params.toString();
        const base = location.hash.startsWith("#/timeline") ? "/timeline" : "/";
        location.hash = `${base}${s ? `?${s}` : ""}`;
      },
    });
  }

  function push(overrides = {}) {
    const scopeRaw =
      overrides.scope !== undefined
        ? overrides.scope
        : document.getElementById("tl-pick")?.value || "";
    const scope = parseScopeValue(scopeRaw);
    const t =
      overrides.tag !== undefined
        ? overrides.tag
        : document.getElementById("tl-tag")?.value.trim() || "";
    const nextView = overrides.view != null ? normalizeView(overrides.view) : view;
    const nextOrient =
      overrides.orient != null ? normalizeOrient(overrides.orient) : orient;
    const params = new URLSearchParams();
    if (scope.kind === SCOPE_TL && scope.id) params.set("timeline_id", scope.id);
    else if (scope.kind === SCOPE_PHASE && scope.id) params.set("phase_id", scope.id);
    else if (scope.kind === SCOPE_PERIOD && scope.id) params.set("period_id", scope.id);
    if (t) params.set("tag", t);
    if (nextView && nextView !== "phases") params.set("view", nextView);
    if (nextOrient && nextOrient !== "vertical") params.set("orient", nextOrient);
    const s = params.toString();
    const base = location.hash.startsWith("#/timeline") ? "/timeline" : "/";
    location.hash = `${base}${s ? `?${s}` : ""}`;
  }

  function branchExtraPx() {
    let rows = 0;
    for (const id of expanded) {
      const entry = childrenCache.get(id);
      if (!entry) {
        rows += 1;
        continue;
      }
      if (entry.loading || entry.error) {
        rows += 1;
        continue;
      }
      rows += Math.max(entry.items.length, 1);
    }
    return rows * BRANCH_ROW_PX;
  }

  function focusYearFromScope() {
    if (phaseId) {
      const p = phases.find((x) => x.entity?.id === phaseId);
      if (p?.start_year != null && p?.end_year != null) {
        return (p.start_year + p.end_year) / 2;
      }
    }
    if (periodId) {
      const p = periods.find((x) => x.entity?.id === periodId);
      if (p?.start_year != null && p?.end_year != null) {
        return (p.start_year + p.end_year) / 2;
      }
    }
    return null;
  }

  function timelineModel() {
    const phaseBands = phases.map((p) => projectBand(p, worldLo, worldHi)).filter(Boolean);
    const periodBreaks = periodBreakpoints(periods, worldLo, worldHi);
    /** @type {TimelineItem[]} */
    let primaryItems = [];
    if (view === "events") {
      primaryItems = datedEvents.map((i) => projectItem(i, worldLo, worldHi)).filter(Boolean);
    } else if (view === "phases") {
      primaryItems = phaseEventItems;
    }
    // Periods tab: breakpoints + phase colors on axis — no primary cards

    return {
      extent: stageExtentPx(worldSpan, yearGap, branchExtraPx()),
      ticks: hasRange ? makeTicks(worldLo, worldHi, yearGap) : [],
      canZoomIn: zoomIndex < YEAR_GAPS.length - 1,
      canZoomOut: zoomIndex > 0,
      atFit: zoomIndex === 0,
      yearGap,
      phaseBands,
      periodBreaks,
      primaryItems,
      stackOffsets: assignStackOffsets(primaryItems),
      eventSides: assignEventSides(primaryItems, horizontal),
    };
  }

  function stageInnerHtml(model, quiet) {
    const hasMmap = expanded.size > 0;
    const sizeStyle = horizontal
      ? `width:${model.extent}px;height:${HORIZONTAL_STAGE_H}px;min-height:${HORIZONTAL_STAGE_H}px`
      : `height:${model.extent}px`;
    return `
      <div class="wt-stage is-view-${view} ${horizontal ? "is-horizontal" : "is-vertical"} ${quiet ? "is-quiet" : ""} ${hasMmap ? "has-mmap" : ""}" id="wt-stage" style="${sizeStyle}" tabindex="0">
        <div class="wt-axis">
          <div class="wt-axis-line"></div>
          ${renderAxisSegmentsHtml(model.phaseBands, horizontal)}
          ${renderTicksHtml(model.ticks, model.phaseBands, horizontal)}
        </div>
        <div class="wt-period-breaks" aria-hidden="true">
          ${renderPeriodBreaksHtml(model.periodBreaks, horizontal)}
        </div>
        <div class="wt-events">
          ${renderPrimaryNodesHtml(
            model.primaryItems,
            model.stackOffsets,
            model.eventSides,
            view,
            expanded,
            childrenCache,
            model.phaseBands,
            horizontal
          )}
        </div>
        <div class="wt-mmap-layer" aria-live="polite">
          ${renderMindmapsHtml(
            model.primaryItems,
            model.eventSides,
            view,
            expanded,
            childrenCache,
            horizontal
          )}
        </div>
      </div>`;
  }

  function syncZoomChrome(model) {
    const rangeN = root.querySelector("[data-wt-range-n]");
    const rangeL = root.querySelector("[data-wt-range-l]");
    if (rangeN) rangeN.textContent = formatSignedYear(worldLo);
    if (rangeL) rangeL.textContent = `→ ${formatSignedYear(worldHi)}`;

    const label = root.querySelector(".wt-zoom-label");
    if (label) {
      label.textContent = `${formatSignedYear(worldLo)} – ${formatSignedYear(worldHi)} · ${fmtYearGap(yearGap)}`;
    }

    const zin = root.querySelector("#wt-zoom-in");
    const zout = root.querySelector("#wt-zoom-out");
    const fit = root.querySelector("#wt-zoom-fit");
    if (zin) zin.disabled = !model.canZoomIn;
    if (zout) zout.disabled = !model.canZoomOut;
    if (fit) fit.disabled = model.atFit;
  }

  function scrollToYear(year, clientCoord = null) {
    const host = root.querySelector("#wt-stage-host");
    const stage = document.getElementById("wt-stage");
    if (!host || !stage || !hasRange) return;
    const span = Math.max(worldHi - worldLo, 1);
    const frac = Math.min(1, Math.max(0, (year - worldLo) / span));
    const hostRect = host.getBoundingClientRect();
    if (horizontal) {
      const focusX =
        clientCoord != null ? clientCoord - hostRect.left : host.clientWidth / 2;
      host.scrollLeft = frac * stage.offsetWidth - focusX;
      return;
    }
    const focusY =
      clientCoord != null ? clientCoord - hostRect.top : host.clientHeight / 2;
    host.scrollTop = frac * stage.offsetHeight - focusY;
  }

  function updateStage(anchorYear = null, anchorClientCoord = null) {
    if (empty || !hasRange) return;
    const host = root.querySelector("#wt-stage-host");
    if (!host) return;
    const stageBefore = document.getElementById("wt-stage");
    const keepYear =
      anchorYear != null
        ? anchorYear
        : yearAtScroll(host, stageBefore, worldLo, worldHi, null, horizontal);
    const model = timelineModel();
    host.innerHTML = stageInnerHtml(model, true);
    syncZoomChrome(model);
    scrollToYear(keepYear, anchorClientCoord);
    requestAnimationFrame(() => paintMindmapLinks(document.getElementById("wt-stage")));
  }

  function setZoomIndex(nextIndex, anchorYear = null, anchorClientCoord = null) {
    const i = Math.max(0, Math.min(YEAR_GAPS.length - 1, nextIndex));
    if (i === zoomIndex) return false;
    zoomIndex = i;
    yearGap = YEAR_GAPS[zoomIndex];
    updateStage(anchorYear, anchorClientCoord);
    return true;
  }

  function zoomBy(direction) {
    if (!hasRange) return;
    const host = root.querySelector("#wt-stage-host");
    const stage = document.getElementById("wt-stage");
    const anchor = yearAtScroll(host, stage, worldLo, worldHi, null, horizontal);
    setZoomIndex(direction === "in" ? zoomIndex + 1 : zoomIndex - 1, anchor);
  }

  async function toggleExpand(id, kind) {
    if (!id || !kind) return;
    if (expanded.has(id)) {
      expanded.delete(id);
      updateStage();
      return;
    }
    expanded.add(id);
    const epoch = (expandEpoch.get(id) || 0) + 1;
    expandEpoch.set(id, epoch);
    if (!childrenCache.has(id) || childrenCache.get(id)?.error) {
      childrenCache.set(id, { loading: true, items: [] });
      updateStage();
      try {
        const items = await fetchChildren(id, kind);
        if (expandEpoch.get(id) !== epoch || !expanded.has(id)) return;
        childrenCache.set(id, { loading: false, items });
      } catch (err) {
        if (expandEpoch.get(id) !== epoch || !expanded.has(id)) return;
        childrenCache.set(id, {
          loading: false,
          items: [],
          error: err instanceof Error ? err.message : "Could not load",
        });
      }
    }
    if (!expanded.has(id)) return;
    updateStage();
    requestAnimationFrame(() => {
      const host = root.querySelector("#wt-stage-host");
      const stage = document.getElementById("wt-stage");
      paintMindmapLinks(stage);
      const mmap = host?.querySelector(`.wt-mmap[data-mmap-root="${CSS.escape(id)}"]`);
      if (!host || !mmap) return;
      const mr = mmap.getBoundingClientRect();
      const hr = host.getBoundingClientRect();
      if (horizontal) {
        if (mr.top < hr.top + MMAP_SCROLL_PAD_PX) {
          host.scrollTop += mr.top - hr.top - MMAP_SCROLL_PAD_PX;
        } else if (mr.bottom > hr.bottom - MMAP_SCROLL_PAD_PX) {
          host.scrollTop += mr.bottom - hr.bottom + MMAP_SCROLL_PAD_PX;
        }
      } else if (mr.left < hr.left + MMAP_SCROLL_PAD_PX) {
        host.scrollLeft += mr.left - hr.left - MMAP_SCROLL_PAD_PX;
      } else if (mr.right > hr.right - MMAP_SCROLL_PAD_PX) {
        host.scrollLeft += mr.right - hr.right + MMAP_SCROLL_PAD_PX;
      }
      requestAnimationFrame(() => paintMindmapLinks(stage));
    });
  }

  function mountShell() {
    const model = showStage && hasRange ? timelineModel() : null;
    const stageReady = Boolean(model);

    root.innerHTML = `
    <div class="wt-shell">
      <header class="wt-hero">
        <div class="wt-hero-copy">
          <p class="wt-kicker">Historia</p>
          <h1 class="wt-title">World timeline</h1>
          <p class="wt-lede">${viewCopy(view, worldEmpty)}</p>
        </div>
        <div class="wt-hero-meta">
          ${
            worldEmpty
              ? ""
              : `<div class="wt-stat"><span class="wt-stat-n">${stats.events ?? datedEvents.length}</span><span class="wt-stat-l">events</span></div>
                 <div class="wt-stat"><span class="wt-stat-n">${stats.periods || 0}</span><span class="wt-stat-l">periods</span></div>
                 <div class="wt-stat"><span class="wt-stat-n">${stats.phases || 0}</span><span class="wt-stat-l">phases</span></div>
                 ${
                   hasRange
                     ? `<div class="wt-stat wt-stat-wide"><span class="wt-stat-n tabular-nums" data-wt-range-n>${escapeHtml(formatSignedYear(worldLo))}</span><span class="wt-stat-l" data-wt-range-l>→ ${escapeHtml(formatSignedYear(worldHi))}</span></div>`
                     : ""
                 }`
          }
          <div class="wt-hero-actions">
            <button type="button" id="wt-add" class="btn-primary px-5 py-2.5 shrink-0">+ Add event</button>
            <button type="button" id="wt-add-phase" class="btn-secondary px-5 py-2.5 shrink-0">+ Add phase</button>
          </div>
        </div>
      </header>

      <div class="wt-toolbar">
        <div class="wt-view-toggle" role="tablist" aria-label="Timeline view">
          ${VIEWS.map(
            (v) => `
            <button type="button" role="tab" class="wt-view-btn ${v === view ? "is-active" : ""}"
              data-view="${v}" aria-selected="${v === view ? "true" : "false"}">
              ${v === "events" ? "Events" : v === "periods" ? "Periods" : "Phases"}
            </button>`
          ).join("")}
        </div>
        <div class="wt-orient-toggle" role="group" aria-label="Timeline orientation">
          <button type="button" class="wt-orient-btn ${!horizontal ? "is-active" : ""}" data-orient="vertical" aria-pressed="${!horizontal}" title="Vertical">V</button>
          <button type="button" class="wt-orient-btn ${horizontal ? "is-active" : ""}" data-orient="horizontal" aria-pressed="${horizontal}" title="Horizontal">H</button>
        </div>
        ${
          hasRange && stageReady
            ? `<div class="wt-zoom-bar" role="group" aria-label="Time zoom">
                <button type="button" class="wt-zoom-btn" id="wt-zoom-out" title="Wider year gaps" ${model.canZoomOut ? "" : "disabled"} aria-label="Zoom out">−</button>
                <span class="wt-zoom-label tabular-nums">${escapeHtml(formatSignedYear(worldLo))} – ${escapeHtml(formatSignedYear(worldHi))} · ${escapeHtml(fmtYearGap(yearGap))}</span>
                <button type="button" class="wt-zoom-btn" id="wt-zoom-in" title="Tighter year gaps — scroll the full timeline" ${model.canZoomIn ? "" : "disabled"} aria-label="Zoom in">+</button>
                <button type="button" class="wt-zoom-fit" id="wt-zoom-fit" title="Widest year gaps (fit)" ${model.atFit ? "disabled" : ""}>Fit</button>
              </div>`
            : ""
        }
        ${scopeSelectHtml({
          timelines: data.timelines || [],
          phases,
          periods,
          selectedValue: selectedScope,
        })}
        <input id="tl-tag" class="input wt-tag" placeholder="Filter by tag" value="${escapeHtml(tag)}" />
      </div>

      ${
        empty
          ? `<div class="wt-empty">
              <div class="wt-empty-axis" aria-hidden="true"></div>
              <p class="wt-empty-title">${escapeHtml(emptyMsg.title)}</p>
              <p class="wt-empty-copy">${escapeHtml(emptyMsg.copy)}</p>
              <button type="button" id="wt-add-empty" class="btn-primary px-6 py-3">${escapeHtml(emptyMsg.cta)}</button>
            </div>`
          : `${
              showStage && model
                ? `<div class="wt-stage-wrap">
              <div id="wt-stage-host" class="wt-stage-host ${horizontal ? "is-horizontal-host" : ""}" tabindex="0" aria-label="Scrollable full timeline">${stageInnerHtml(model, false)}</div>
            </div>`
                : ""
            }
            ${
              showUndated
                ? `<section class="wt-undated">
                    <h2 class="wt-undated-title">Undated</h2>
                    <div class="wt-undated-list">
                      ${undated
                        .map((item) => {
                          const e = item.entity;
                          return `
                          <a href="#/entity/${e.id}" class="wt-undated-row">
                            <span class="wt-undated-name">${escapeHtml(e.title)}</span>
                            <span class="type-badge">${escapeHtml(typeLabel(e.type))}</span>
                          </a>`;
                        })
                        .join("")}
                    </div>
                  </section>`
                : ""
            }`
      }
    </div>
  `;

    wireShell();
    requestAnimationFrame(() => {
      paintMindmapLinks(document.getElementById("wt-stage"));
      const focusY = focusYearFromScope();
      if (focusY != null) scrollToYear(focusY);
    });
  }

  function wireShell() {
    activeUiAbort?.abort();
    const uiAbort = new AbortController();
    activeUiAbort = uiAbort;
    const { signal } = uiAbort;

    document.getElementById("wt-add")?.addEventListener("click", openAdd, { signal });
    document.getElementById("wt-add-phase")?.addEventListener("click", openPhase, { signal });
    document.getElementById("wt-add-empty")?.addEventListener(
      "click",
      () => {
        if (view === "phases" || emptyMsg.cta === "Add phase") openPhase();
        else openAdd();
      },
      { signal }
    );

    root.querySelectorAll("[data-view]").forEach((btn) => {
      btn.addEventListener(
        "click",
        () => {
          const next = normalizeView(btn.dataset.view);
          if (next === view) return;
          push({ view: next });
        },
        { signal }
      );
    });

    root.querySelectorAll("[data-orient]").forEach((btn) => {
      btn.addEventListener(
        "click",
        () => {
          const next = normalizeOrient(btn.dataset.orient);
          if (next === orient) return;
          push({ orient: next });
        },
        { signal }
      );
    });

    document.getElementById("tl-pick")?.addEventListener(
      "change",
      () => {
        const scope = parseScopeValue(document.getElementById("tl-pick")?.value || "");
        const overrides = {};
        if (scope.kind === SCOPE_PHASE) overrides.view = "phases";
        if (scope.kind === SCOPE_PERIOD) overrides.view = "periods";
        push(overrides);
      },
      { signal }
    );
    let deb;
    document.getElementById("tl-tag")?.addEventListener(
      "input",
      () => {
        clearTimeout(deb);
        deb = setTimeout(() => push(), TAG_DEBOUNCE_MS);
      },
      { signal }
    );

    document.getElementById("wt-zoom-in")?.addEventListener("click", () => zoomBy("in"), { signal });
    document.getElementById("wt-zoom-out")?.addEventListener("click", () => zoomBy("out"), { signal });
    document.getElementById("wt-zoom-fit")?.addEventListener(
      "click",
      () => setZoomIndex(0),
      { signal }
    );

    const host = root.querySelector("#wt-stage-host");
    if (host && hasRange) {
      host.addEventListener(
        "click",
        (e) => {
          const btn = e.target.closest("[data-wt-expand]");
          if (!btn || !host.contains(btn)) return;
          e.preventDefault();
          e.stopPropagation();
          const id = btn.getAttribute("data-wt-expand");
          const kind = btn.getAttribute("data-wt-expand-kind");
          toggleExpand(id, kind);
        },
        { signal }
      );

      let pan = null;
      host.addEventListener(
        "pointerdown",
        (e) => {
          if (e.button !== 0) return;
          if (e.target.closest("a.wt-card-details, input, select")) return;
          if (e.target.closest("button[data-wt-expand], .wt-mmap-card.is-moment")) return;
          pan = { x: e.clientX, y: e.clientY, sl: host.scrollLeft, st: host.scrollTop };
          host.classList.add("is-panning-x");
          host.setPointerCapture(e.pointerId);
        },
        { signal }
      );
      host.addEventListener(
        "pointermove",
        (e) => {
          if (!pan) return;
          host.scrollLeft = pan.sl - (e.clientX - pan.x);
          host.scrollTop = pan.st - (e.clientY - pan.y);
          paintMindmapLinks(document.getElementById("wt-stage"));
        },
        { signal }
      );
      const endPan = () => {
        pan = null;
        host.classList.remove("is-panning-x");
      };
      host.addEventListener("pointerup", endPan, { signal });
      host.addEventListener("pointercancel", endPan, { signal });

      host.addEventListener(
        "scroll",
        () => {
          paintMindmapLinks(document.getElementById("wt-stage"));
        },
        { signal, passive: true }
      );

      window.addEventListener(
        "resize",
        () => paintMindmapLinks(document.getElementById("wt-stage")),
        { signal }
      );

      let wheelZoomAcc = 0;
      host.addEventListener(
        "wheel",
        (e) => {
          if (!(e.ctrlKey || e.metaKey)) return;
          const stage = e.target.closest("#wt-stage");
          if (!stage || !host.contains(stage)) return;
          e.preventDefault();

          const delta = wheelDeltaPx(e);
          if (wheelZoomAcc !== 0 && Math.sign(wheelZoomAcc) !== Math.sign(delta)) {
            wheelZoomAcc = 0;
          }
          wheelZoomAcc += delta;
          if (Math.abs(wheelZoomAcc) < WHEEL_ZOOM_STEP_PX) return;

          const dir = wheelZoomAcc < 0 ? "in" : "out";
          const next = dir === "in" ? zoomIndex + 1 : zoomIndex - 1;
          if (next < 0 || next >= YEAR_GAPS.length) {
            wheelZoomAcc = 0;
            return;
          }
          wheelZoomAcc = 0;
          const clientCoord = horizontal ? e.clientX : e.clientY;
          const anchor = yearAtScroll(
            host,
            stage,
            worldLo,
            worldHi,
            clientCoord,
            horizontal
          );
          setZoomIndex(next, anchor, clientCoord);
        },
        { passive: false, signal }
      );
    }
  }

  mountShell();
}

/** Call when leaving timeline so other views keep normal layout. */
export function teardownTimeline(root) {
  activeUiAbort?.abort();
  activeUiAbort = null;
  root?.classList.remove("view-world-timeline");
}

/** Alternate sides; keep tight clusters on the same side. */
function assignEventSides(items, horizontal = false) {
  const a = horizontal ? "above" : "left";
  const b = horizontal ? "below" : "right";
  const sides = items.map(() => b);
  let side = a;
  for (let i = 0; i < items.length; i++) {
    if (i > 0) {
      const prev = items[i - 1].position;
      const cur = items[i].position;
      if (prev != null && cur != null && Math.abs(cur - prev) < CLUSTER_PCT) {
        sides[i] = sides[i - 1];
        continue;
      }
      side = side === a ? b : a;
    }
    sides[i] = side;
  }
  return sides;
}

/** Stack nearby events so cards don’t sit on top of each other. */
function assignStackOffsets(items) {
  const offsets = items.map(() => 0);
  let run = 0;
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1].position;
    const cur = items[i].position;
    if (prev != null && cur != null && Math.abs(cur - prev) < CLUSTER_PCT) {
      run += 1;
      offsets[i] = run;
    } else {
      run = 0;
    }
  }
  return offsets;
}
