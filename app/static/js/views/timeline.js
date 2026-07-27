/** World timeline — full chronicle + Phase→Events→Moments mindmap branches. */

import { api } from "../api.js";
  import {
  compareByDateThenTitle,
  escapeHtml,
  formatDate,
  formatRange,
  formatSignedYear,
  typeLabel,
} from "../util.js";

const VIEWS = ["phases", "events", "periods"];
/** Year-gap zoom steps (coarse → fine). Full chronicle always on the spine. */
const YEAR_GAPS = [1000, 500, 100, 50, 10];
const PX_PER_GAP = 72;
const BRANCH_ROW_PX = 72;
const STAGE_MIN_PX = 1400;
const STAGE_MAX_PX = 320000;
const MAX_TICKS = 20000;
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
const REL_PART_OF = "part_of";
const REL_CHILD = "child";

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

function stageHeight(worldSpan, yearGap, branchExtra = 0) {
  const span = Math.max(worldSpan, 1);
  const gap = Math.max(yearGap, 1);
  const raw = (span / gap) * PX_PER_GAP;
  return Math.round(Math.min(Math.max(raw, STAGE_MIN_PX), STAGE_MAX_PX) + branchExtra);
}

function normalizeView(raw) {
  const v = String(raw || "").toLowerCase();
  return VIEWS.includes(v) ? v : "phases";
}

function pct(year, lo, hi) {
  const span = Math.max(hi - lo, 1e-9);
  return ((year - lo) / span) * 100;
}

function makeTicks(lo, hi, yearGap) {
  const step = Math.max(1, Math.round(yearGap));
  const ticks = [];
  let y = Math.floor(lo / step) * step;
  let n = 0;
  while (y <= hi + step && n < MAX_TICKS) {
    if (y >= lo && y <= hi) {
      ticks.push({ year: y, position: pct(y, lo, hi), label: formatSignedYear(y) });
      n += 1;
    }
    y += step;
  }
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

/** @param {number|null|undefined} year @param {TimelineItem[]} periods */
function periodAtYear(year, periods) {
  if (year == null || !periods?.length) return null;
  let best = null;
  let bestSpan = Infinity;
  for (const p of periods) {
    if (p.start_year == null || p.end_year == null) continue;
    if (year < p.start_year || year > p.end_year) continue;
    const span = p.end_year - p.start_year;
    if (span < bestSpan) {
      best = p;
      bestSpan = span;
    }
  }
  return best;
}

/** @param {TimelineItem} item @param {TimelineItem[]} periods */
function colorForTimelineItem(item, periods) {
  if (item?.entity?.type === "period" && item.color) return item.color;
  const y = item?.sort_year;
  const mid = item?.end_year != null && y != null ? (y + item.end_year) / 2 : y;
  return periodAtYear(mid, periods)?.color || item?.color || null;
}

function renderAxisSegmentsHtml(periodBands) {
  return (periodBands || [])
    .map(
      (p) => `
    <div class="wt-axis-seg" style="top:${p.left}%;height:${p.width}%;--seg:${p.color}"
      title="${escapeHtml(p.entity?.title || "")}"></div>`
    )
    .join("");
}

function renderTicksHtml(ticks, periodBands) {
  return (ticks || [])
    .map((t) => {
      const period = periodAtYear(t.year, periodBands);
      const ink = period ? `--tick:${period.color};` : "";
      return `
            <div class="wt-tick ${period ? "has-period" : ""}" style="top:${t.position}%;${ink}">
              <span class="wt-tick-mark"></span>
              <span class="wt-tick-label">${escapeHtml(t.label)}</span>
            </div>`;
    })
    .join("");
}

function bandsAsItems(bands) {
  return (bands || []).map((b) => ({
    entity: b.entity,
    display_date: b.display_start || formatSignedYear(b.start_year),
    display_end: b.display_end || formatSignedYear(b.end_year),
    position: b.left,
    position_end: b.left + (b.width || 0),
    sort_year: b.start_year,
    end_year: b.end_year,
    color: b.color,
  }));
}

function viewCopy(view, empty) {
  if (empty) {
    return "Your chronicle of the world starts empty. Each dated event etches another mark on the axis of time.";
  }
  if (view === "periods") {
    return "View by period — eras as spans along the spine. Switch to phases or events anytime.";
  }
  if (view === "phases") {
    return "Open a phase to unfold its events, then open an event to see its moments — a mindmap on the spine.";
  }
  return "Events on the spine — expand one to reveal its moments. Periods color the axis.";
}

function viewEmpty(view) {
  if (view === "periods") {
    return {
      title: "No periods yet",
      copy: "Create a period with a From–To range, then it will appear as a span on this spine.",
      cta: "Add an event (then link a period)",
    };
  }
  if (view === "phases") {
    return {
      title: "No phases yet",
      copy: "Create a phase with a date range from an event or period page — it will show here.",
      cta: "Add an event",
    };
  }
  return {
    title: "The axis awaits",
    copy: "Add a dated event — Waterloo, Caesar, your family’s story — and watch the first point appear.",
    cta: "Add your first moment",
  };
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
  if (view === "phases" && entityType === "phase") return "phase";
  if ((view === "events" || view === "phases") && entityType === "event") return "event";
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

function renderPrimaryNodesHtml(primaryItems, stackOffsets, eventSides, view, expanded, cache, periodBands) {
  return primaryItems
    .map((item, idx) => {
      const e = item.entity;
      const isPeriod = e.type === "period";
      const isPhase = e.type === "phase";
      const yearSpan =
        item.sort_year != null && item.end_year != null
          ? Math.abs(item.end_year - item.sort_year)
          : 0;
      const spanPct =
        item.position_end != null
          ? Math.max(item.position_end - item.position, MIN_SPAN_PCT)
          : null;
      const isRange =
        spanPct != null &&
        yearSpan > 0 &&
        (isPhase || isPeriod || (view === "events" && e.type === "event"));
      const dateLabel = item.display_end
        ? `${item.display_date} – ${item.display_end}`
        : item.display_date || "?";
      const stack = stackOffsets[idx] || 0;
      const side = eventSides[idx] || "right";
      const startYear = item.sort_year != null ? formatSignedYear(item.sort_year) : "";
      const endYear =
        item.end_year != null
          ? formatSignedYear(item.end_year)
          : item.display_end
            ? String(item.display_end)
            : "";
      const topStyle = isRange
        ? `top:${item.position}%;height:${spanPct}%;--stack-n:${stack};--stack-lane:${STACK_LANE_REM}rem`
        : stack === 0
          ? `top:${item.position}%`
          : `top:calc(${item.position}% + ${stack * STACK_REM}rem)`;
      const periodColor = colorForTimelineItem(item, periodBands);
      const ink = periodColor ? `--node:${periodColor};` : "";
      const kind = expandKindFor(view, e.type);
      const isRoot = isPhase || (view === "events" && e.type === "event");
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
      <div class="wt-event is-${side} ${isPeriod ? "is-period" : ""} ${isPhase ? "is-phase" : ""} ${isRange ? "is-range" : ""} ${periodColor ? "has-period-color" : ""} ${isRoot ? "is-mmap-root" : ""} ${expanded.has(e.id) ? "is-expanded" : ""}"
        style="${topStyle};--i:${idx};${ink}"
        data-year="${item.sort_year ?? ""}"
        data-entity-id="${safeId}"
        data-entity-type="${escapeHtml(e.type)}"
        data-side="${side}"
        data-pos="${item.position}"
        id="wt-ev-${safeId}">
        ${isRange ? `<span class="wt-event-rail" aria-hidden="true"></span>` : ""}
        ${
          !isRange && spanPct != null
            ? `<span class="wt-event-span" style="height:${spanPct}%"></span>`
            : ""
        }
        <span class="wt-event-node ${isRange ? "is-range-start" : ""}" data-mmap-anchor="${safeId}" title="${escapeHtml(dateLabel)}">
          ${startYear ? `<span class="wt-event-year">${escapeHtml(startYear)}</span>` : ""}
        </span>
        ${
          isRange && endYear
            ? `<span class="wt-event-node is-range-end" title="${escapeHtml(endYear)}">
                <span class="wt-event-year">${escapeHtml(endYear)}</span>
              </span>`
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

function renderEventMindCard(e, expanded, cache, bi) {
  const open = expanded.has(e.id);
  const entry = cache.get(e.id);
  const safeId = escapeHtml(e.id);
  let momentsBlock = "";
  if (open) {
    if (!entry || entry.loading) {
      momentsBlock = mmapEmptyHtml("Loading moments…");
    } else if (entry.error) {
      momentsBlock = mmapEmptyHtml(entry.error);
    } else if (!entry.items.length) {
      momentsBlock = mmapEmptyHtml("No moments yet");
    } else {
      momentsBlock = `
        <div class="wt-mmap-moments" data-mmap-parent="${safeId}">
          ${entry.items.map(renderMomentCard).join("")}
        </div>`;
    }
  }

  return `
    <div class="wt-mmap-event" style="--bi:${bi}" data-mmap-event="${safeId}">
      <div class="wt-mmap-event-head">
        ${renderExpandBtn(e.id, "event", expanded, cache)}
        <button type="button" class="wt-mmap-card is-event ${open ? "is-open" : ""}"
          id="wt-mmap-ev-${safeId}" data-mmap-node="${safeId}"
          data-wt-expand="${safeId}" data-wt-expand-kind="event"
          aria-expanded="${open ? "true" : "false"}">
          <span class="wt-mmap-kicker">Event</span>
          <span class="wt-mmap-date">${escapeHtml(dateLabelForEntity(e))}</span>
          <span class="wt-mmap-title">${escapeHtml(e.title)}</span>
        </button>
        ${renderDetailsLink(e.id)}
      </div>
      ${momentsBlock}
    </div>`;
}

/** Mindmap fan on the SAME side as the phase card. */
function renderMindmapsHtml(primaryItems, eventSides, view, expanded, cache) {
  const chunks = [];
  primaryItems.forEach((item, idx) => {
    const e = item.entity;
    if (!expanded.has(e.id)) return;
    const kind = expandKindFor(view, e.type);
    if (!kind) return;
    const fanSide = eventSides[idx] || "right";
    const entry = cache.get(e.id);
    const top =
      item.position_end != null
        ? (item.position + item.position_end) / 2
        : item.position;
    let body = "";
    if (!entry || entry.loading) {
      body = mmapEmptyHtml("Loading…");
    } else if (entry.error) {
      body = mmapEmptyHtml(entry.error);
    } else if (kind === "phase") {
      body = !entry.items.length
        ? mmapEmptyHtml("No events in this phase yet")
        : entry.items.map((ev, bi) => renderEventMindCard(ev, expanded, cache, bi)).join("");
    } else if (kind === "event") {
      body = !entry.items.length
        ? mmapEmptyHtml("No moments yet")
        : `<div class="wt-mmap-moments" data-mmap-parent="${escapeHtml(e.id)}">
          ${entry.items.map(renderMomentCard).join("")}
        </div>`;
    }
    chunks.push(`
      <div class="wt-mmap is-fan-${fanSide}" style="top:${top}%" data-mmap-root="${escapeHtml(e.id)}" data-mmap-kind="${kind}" data-fan="${fanSide}">
        <div class="wt-mmap-tree">
          ${body}
        </div>
      </div>`);
  });
  return chunks.join("");
}

/**
 * Place each mindmap fan just outside the root card (same side).
 * On mobile, CSS owns layout — clear inline overrides.
 */
function layoutMindmapFans(stage) {
  if (!stage) return;
  const mmaps = stage.querySelectorAll(".wt-mmap[data-mmap-root]");
  if (!mmaps.length) return;

  if (isMobileTimeline()) {
    mmaps.forEach((mmap) => {
      mmap.style.left = "";
      mmap.style.right = "";
      mmap.style.width = "";
    });
    stage.style.minWidth = "";
    return;
  }

  const sr = stage.getBoundingClientRect();
  let stageW = stage.offsetWidth;
  let minNeeded = stageW;

  function placeFan(mmap, stageRect, width) {
    const fan = mmap.dataset.fan || "right";
    const rootWrap = rootCardEl(stage, mmap.dataset.mmapRoot || "");
    if (!rootWrap) return;
    const rr = rootWrap.getBoundingClientRect();
    mmap.style.width = `${FAN_WIDTH_PX}px`;
    if (fan === "left") {
      const rightEdge = rr.left - stageRect.left - FAN_GAP_PX;
      mmap.style.left = "auto";
      mmap.style.right = `${Math.max(0, width - rightEdge)}px`;
      const fanLeft = rightEdge - FAN_WIDTH_PX;
      if (fanLeft < FAN_STAGE_PAD_PX) {
        minNeeded = Math.max(minNeeded, width + (FAN_STAGE_PAD_PX - fanLeft));
      }
    } else {
      const leftEdge = rr.right - stageRect.left + FAN_GAP_PX;
      mmap.style.right = "auto";
      mmap.style.left = `${leftEdge}px`;
      minNeeded = Math.max(minNeeded, leftEdge + FAN_WIDTH_PX + FAN_STAGE_PAD_PX);
    }
  }

  mmaps.forEach((mmap) => placeFan(mmap, sr, stageW));

  if (minNeeded > stageW + 1) {
    stage.style.minWidth = `${Math.ceil(minNeeded)}px`;
    const sr2 = stage.getBoundingClientRect();
    stageW = stage.offsetWidth;
    mmaps.forEach((mmap) => placeFan(mmap, sr2, stageW));
  }
}

/**
 * Draw cubic bezier links from Phase (spine) → Events → Moments.
 * Mindmap fans on the SAME side as the root card.
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
    const y = r.top - stageRect.top + r.height / 2;
    let x;
    if (edge === "left") x = r.left - stageRect.left;
    else if (edge === "right") x = r.right - stageRect.left;
    else x = r.left - stageRect.left + r.width / 2;
    return { x, y };
  }

  function curve(a, b, className) {
    if (!a || !b) return;
    if (Number.isNaN(a.x) || Number.isNaN(a.y) || Number.isNaN(b.x) || Number.isNaN(b.y)) return;
    // Keep control points on the outer side so curves don't fold through cards
    const dx = Math.max(Math.abs(b.x - a.x) * 0.45, CURVE_MIN_DX);
    const c1x = a.x <= b.x ? a.x + dx : a.x - dx;
    const c2x = a.x <= b.x ? b.x - dx : b.x + dx;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} C ${c1x.toFixed(1)} ${a.y.toFixed(1)}, ${c2x.toFixed(1)} ${b.y.toFixed(1)}, ${b.x.toFixed(1)} ${b.y.toFixed(1)}`
    );
    path.setAttribute("class", className);
    path.setAttribute("fill", "none");
    svg.appendChild(path);
  }

  stage.querySelectorAll(".wt-mmap[data-mmap-root]").forEach((mmap) => {
    const rootId = mmap.dataset.mmapRoot;
    const fan = mmap.dataset.fan || "right";
    const rootEl = rootCardEl(stage, rootId || "");
    const rootEdge = fan === "right" ? "right" : "left";
    const childEdge = fan === "right" ? "left" : "right";
    const rootPt = pt(rootEl, rootEdge);

    mmap.querySelectorAll(".wt-mmap-card.is-event").forEach((evCard) => {
      curve(rootPt, pt(evCard, childEdge), "wt-mmap-path is-event-link");

      const evId = evCard.dataset.mmapNode;
      const moments = mmap.querySelector(`.wt-mmap-moments[data-mmap-parent="${CSS.escape(evId || "")}"]`);
      if (!moments) return;
      const evOut = pt(evCard, rootEdge);
      moments.querySelectorAll(".wt-mmap-card.is-moment").forEach((ms) => {
        curve(evOut, pt(ms, childEdge), "wt-mmap-path is-moment-link");
      });
    });

    if (mmap.dataset.mmapKind === "event") {
      mmap.querySelectorAll(".wt-mmap-card.is-moment").forEach((ms) => {
        curve(rootPt, pt(ms, childEdge), "wt-mmap-path is-moment-link");
      });
    }
  });
}

function yearAtScroll(host, stage, worldLo, worldHi, clientY = null) {
  if (!host || !stage) return (worldLo + worldHi) / 2;
  const span = Math.max(worldHi - worldLo, 1);
  const hostRect = host.getBoundingClientRect();
  const focusY = clientY != null ? clientY - hostRect.top : host.clientHeight / 2;
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

export async function renderTimeline(root, { query = {} } = {}) {
  const timelineId = query.timeline_id || "";
  const tag = query.tag || "";
  const view = normalizeView(query.view);
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

  let zoomIndex = 0;
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
  const emptyMsg = viewEmpty(view);

  let chipItems = [];
  let showUndated = false;
  let viewEmptyState = false;
  if (view === "periods") {
    chipItems = periods;
    viewEmptyState = !worldEmpty && periods.length === 0;
  } else if (view === "phases") {
    chipItems = phases;
    viewEmptyState = !worldEmpty && phases.length === 0;
  } else {
    chipItems = periods;
    showUndated = undated.length > 0;
    viewEmptyState = !worldEmpty && datedEvents.length === 0 && undated.length === 0;
  }
  const empty = worldEmpty || viewEmptyState;

  root.classList.add("view-world-timeline");

  function openAdd() {
    document.getElementById("quick-add-btn")?.click();
  }

  function push(nextView = view) {
    const tid = document.getElementById("tl-pick")?.value || "";
    const t = document.getElementById("tl-tag")?.value.trim() || "";
    const params = new URLSearchParams();
    if (tid) params.set("timeline_id", tid);
    if (t) params.set("tag", t);
    if (nextView && nextView !== "phases") params.set("view", nextView);
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
      for (const child of entry.items) {
        if (!expanded.has(child.id)) continue;
        const nested = childrenCache.get(child.id);
        if (!nested || nested.loading || nested.error) rows += 1;
        else rows += Math.max(nested.items.length, 1);
      }
    }
    return rows * BRANCH_ROW_PX;
  }

  function timelineModel() {
    let primaryRaw = [];
    // Periods always drive spine / card color (bands UI is hidden)
    const periodBands = periods.map((p) => projectBand(p, worldLo, worldHi)).filter(Boolean);

    if (view === "periods") {
      primaryRaw = periods;
    } else if (view === "phases") {
      primaryRaw = phases;
    } else {
      primaryRaw = datedEvents;
    }

    let primaryItems = [];
    if (view === "periods" || view === "phases") {
      primaryItems = bandsAsItems(
        primaryRaw.map((p) => projectBand(p, worldLo, worldHi)).filter(Boolean)
      );
    } else {
      primaryItems = primaryRaw.map((i) => projectItem(i, worldLo, worldHi)).filter(Boolean);
    }

    return {
      height: stageHeight(worldSpan, yearGap, branchExtraPx()),
      ticks: hasRange ? makeTicks(worldLo, worldHi, yearGap) : [],
      canZoomIn: zoomIndex < YEAR_GAPS.length - 1,
      canZoomOut: zoomIndex > 0,
      atFit: zoomIndex === 0,
      yearGap,
      periodBands,
      primaryItems,
      stackOffsets: assignStackOffsets(primaryItems),
      eventSides: assignEventSides(primaryItems),
    };
  }

  function stageInnerHtml(model, quiet) {
    const hasMmap = expanded.size > 0;
    return `
      <div class="wt-stage is-view-${view} ${quiet ? "is-quiet" : ""} ${hasMmap ? "has-mmap" : ""}" id="wt-stage" style="height:${model.height}px" tabindex="0">
        <div class="wt-axis">
          <div class="wt-axis-line"></div>
          ${renderAxisSegmentsHtml(model.periodBands)}
          ${renderTicksHtml(model.ticks, model.periodBands)}
        </div>
        <div class="wt-events">
          ${renderPrimaryNodesHtml(
            model.primaryItems,
            model.stackOffsets,
            model.eventSides,
            view,
            expanded,
            childrenCache,
            model.periodBands
          )}
        </div>
        <div class="wt-mmap-layer" aria-live="polite">
          ${renderMindmapsHtml(
            model.primaryItems,
            model.eventSides,
            view,
            expanded,
            childrenCache
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
      // Full chronicle always — zoom only changes the year gap / scale
      label.textContent = `${formatSignedYear(worldLo)} – ${formatSignedYear(worldHi)} · ${fmtYearGap(yearGap)}`;
    }

    const zin = root.querySelector("#wt-zoom-in");
    const zout = root.querySelector("#wt-zoom-out");
    const fit = root.querySelector("#wt-zoom-fit");
    if (zin) zin.disabled = !model.canZoomIn;
    if (zout) zout.disabled = !model.canZoomOut;
    if (fit) fit.disabled = model.atFit;
  }

  function scrollToYear(year, clientY = null) {
    const host = root.querySelector("#wt-stage-host");
    const stage = document.getElementById("wt-stage");
    if (!host || !stage || !hasRange) return;
    const span = Math.max(worldHi - worldLo, 1);
    const frac = Math.min(1, Math.max(0, (year - worldLo) / span));
    const hostRect = host.getBoundingClientRect();
    const focusY = clientY != null ? clientY - hostRect.top : host.clientHeight / 2;
    host.scrollTop = frac * stage.offsetHeight - focusY;
  }

  function updateStage(anchorYear = null, anchorClientY = null) {
    if (empty || !hasRange) return;
    const host = root.querySelector("#wt-stage-host");
    if (!host) return;
    const stageBefore = document.getElementById("wt-stage");
    const keepYear =
      anchorYear != null
        ? anchorYear
        : yearAtScroll(host, stageBefore, worldLo, worldHi);
    const model = timelineModel();
    host.innerHTML = stageInnerHtml(model, true);
    syncZoomChrome(model);
    scrollToYear(keepYear, anchorClientY);
    requestAnimationFrame(() => paintMindmapLinks(document.getElementById("wt-stage")));
  }

  function setZoomIndex(nextIndex, anchorYear = null, anchorClientY = null) {
    const i = Math.max(0, Math.min(YEAR_GAPS.length - 1, nextIndex));
    if (i === zoomIndex) return false;
    zoomIndex = i;
    yearGap = YEAR_GAPS[zoomIndex];
    updateStage(anchorYear, anchorClientY);
    return true;
  }

  function zoomBy(direction) {
    if (!hasRange) return;
    const host = root.querySelector("#wt-stage-host");
    const stage = document.getElementById("wt-stage");
    const anchor = yearAtScroll(host, stage, worldLo, worldHi);
    setZoomIndex(direction === "in" ? zoomIndex + 1 : zoomIndex - 1, anchor);
  }

  async function toggleExpand(id, kind) {
    if (!id || !kind) return;
    if (expanded.has(id)) {
      expanded.delete(id);
      const entry = childrenCache.get(id);
      if (kind === "phase" && entry?.items) {
        for (const child of entry.items) expanded.delete(child.id);
      }
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
      if (mr.left < hr.left + MMAP_SCROLL_PAD_PX) {
        host.scrollLeft += mr.left - hr.left - MMAP_SCROLL_PAD_PX;
      } else if (mr.right > hr.right - MMAP_SCROLL_PAD_PX) {
        host.scrollLeft += mr.right - hr.right + MMAP_SCROLL_PAD_PX;
      }
      requestAnimationFrame(() => paintMindmapLinks(stage));
    });
  }

  function mountShell() {
    const model = empty || !hasRange ? null : timelineModel();

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
          <button type="button" id="wt-add" class="btn-primary px-5 py-2.5 shrink-0">+ Add event</button>
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
        ${
          hasRange && !empty
            ? `<div class="wt-zoom-bar" role="group" aria-label="Time zoom">
                <button type="button" class="wt-zoom-btn" id="wt-zoom-out" title="Wider year gaps" ${model.canZoomOut ? "" : "disabled"} aria-label="Zoom out">−</button>
                <span class="wt-zoom-label tabular-nums">${escapeHtml(formatSignedYear(worldLo))} – ${escapeHtml(formatSignedYear(worldHi))} · ${escapeHtml(fmtYearGap(yearGap))}</span>
                <button type="button" class="wt-zoom-btn" id="wt-zoom-in" title="Tighter year gaps — scroll the full timeline" ${model.canZoomIn ? "" : "disabled"} aria-label="Zoom in">+</button>
                <button type="button" class="wt-zoom-fit" id="wt-zoom-fit" title="Widest year gaps (fit)" ${model.atFit ? "disabled" : ""}>Fit</button>
              </div>`
            : ""
        }
        <select id="tl-pick" class="select wt-select" aria-label="Timeline filter">
          <option value="">All of history</option>
          ${(data.timelines || [])
            .map(
              (t) =>
                `<option value="${t.id}" ${t.id === timelineId ? "selected" : ""}>${escapeHtml(t.title)}</option>`
            )
            .join("")}
        </select>
        <input id="tl-tag" class="input wt-tag" placeholder="Filter by tag" value="${escapeHtml(tag)}" />
        ${
          chipItems.length
            ? `<div class="wt-period-chips" role="list">
                ${chipItems
                  .slice(0, 12)
                  .map((p) => {
                    const mid = (p.start_year + p.end_year) / 2;
                    return `
                  <button type="button" class="wt-period-chip" data-focus-year="${mid}" style="--chip:${p.color}" role="listitem">
                    ${escapeHtml(p.entity.title)}
                  </button>`;
                  })
                  .join("")}
              </div>`
            : ""
        }
      </div>

      ${
        empty
          ? `<div class="wt-empty">
              <div class="wt-empty-axis" aria-hidden="true"></div>
              <p class="wt-empty-title">${escapeHtml(emptyMsg.title)}</p>
              <p class="wt-empty-copy">${escapeHtml(emptyMsg.copy)}</p>
              <button type="button" id="wt-add-empty" class="btn-primary px-6 py-3">${escapeHtml(emptyMsg.cta)}</button>
            </div>`
          : `<div class="wt-stage-wrap">
              <div id="wt-stage-host" class="wt-stage-host" tabindex="0" aria-label="Scrollable full timeline">${stageInnerHtml(model, false)}</div>
            </div>
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
    requestAnimationFrame(() => paintMindmapLinks(document.getElementById("wt-stage")));
  }

  function wireShell() {
    activeUiAbort?.abort();
    const uiAbort = new AbortController();
    activeUiAbort = uiAbort;
    const { signal } = uiAbort;

    document.getElementById("wt-add")?.addEventListener("click", openAdd, { signal });
    document.getElementById("wt-add-empty")?.addEventListener("click", openAdd, { signal });

    root.querySelectorAll("[data-view]").forEach((btn) => {
      btn.addEventListener(
        "click",
        () => {
          const next = normalizeView(btn.dataset.view);
          if (next === view) return;
          push(next);
        },
        { signal }
      );
    });

    document.getElementById("tl-pick")?.addEventListener("change", () => push(), { signal });
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

    root.querySelectorAll("[data-focus-year]").forEach((btn) => {
      btn.addEventListener(
        "click",
        () => {
          const year = parseFloat(btn.dataset.focusYear || "");
          if (Number.isNaN(year) || !hasRange) return;
          scrollToYear(year);
          syncZoomChrome(timelineModel());
        },
        { signal }
      );
    });

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

      // Drag empty space to pan horizontally (and vertically)
      let panX = null;
      host.addEventListener(
        "pointerdown",
        (e) => {
          if (e.button !== 0) return;
          if (e.target.closest("a.wt-card-details, input, select")) return;
          if (e.target.closest("button[data-wt-expand], .wt-mmap-card.is-moment")) return;
          panX = { x: e.clientX, y: e.clientY, sl: host.scrollLeft, st: host.scrollTop };
          host.classList.add("is-panning-x");
          host.setPointerCapture(e.pointerId);
        },
        { signal }
      );
      host.addEventListener(
        "pointermove",
        (e) => {
          if (!panX) return;
          host.scrollLeft = panX.sl - (e.clientX - panX.x);
          host.scrollTop = panX.st - (e.clientY - panX.y);
          paintMindmapLinks(document.getElementById("wt-stage"));
        },
        { signal }
      );
      const endPanX = () => {
        panX = null;
        host.classList.remove("is-panning-x");
      };
      host.addEventListener("pointerup", endPanX, { signal });
      host.addEventListener("pointercancel", endPanX, { signal });

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

      // Free wheel/pinch zoom: accumulate distance so a flick can't
      // race through every year-gap in one gesture. One step max per event.
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
          const anchor = yearAtScroll(host, stage, worldLo, worldHi, e.clientY);
          setZoomIndex(next, anchor, e.clientY);
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

/** Alternate left/right; keep tight clusters on the same side. */
function assignEventSides(items) {
  const sides = items.map(() => "right");
  let side = "left";
  for (let i = 0; i < items.length; i++) {
    if (i > 0) {
      const prev = items[i - 1].position;
      const cur = items[i].position;
      if (prev != null && cur != null && Math.abs(cur - prev) < CLUSTER_PCT) {
        sides[i] = sides[i - 1];
        continue;
      }
      side = side === "left" ? "right" : "left";
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
