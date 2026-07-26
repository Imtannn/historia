/** Horizontal timeline view. */

import { api } from "../api.js";
import { escapeHtml, typeLabel } from "../util.js";

export async function renderTimeline(root, { query = {} } = {}) {
  const timelineId = query.timeline_id || "";
  const tag = query.tag || "";
  const data = await api.timeline({
    ...(timelineId ? { timeline_id: timelineId } : {}),
    ...(tag ? { tag } : {}),
  });

  const dated = data.items.filter((i) => i.position != null);
  const undated = data.items.filter((i) => i.position == null);

  root.innerHTML = `
    <div class="mb-6">
      <h1 class="font-display text-3xl tracking-tight">Timeline</h1>
      <p class="text-ink-muted mt-1">Events on a horizontal axis — BCE-aware, undated last.</p>
    </div>

    <div class="flex flex-col sm:flex-row gap-3 mb-8">
      <select id="tl-pick" class="select sm:w-64">
        <option value="">All events</option>
        ${(data.timelines || [])
          .map(
            (t) =>
              `<option value="${t.id}" ${t.id === timelineId ? "selected" : ""}>${escapeHtml(t.title)}</option>`
          )
          .join("")}
      </select>
      <input id="tl-tag" class="input sm:w-48" placeholder="Filter by tag" value="${escapeHtml(tag)}" />
    </div>

    ${
      data.items.length === 0
        ? `<div class="rounded-2xl border border-dashed border-paper-line p-10 text-center text-ink-muted text-sm">
            No dated events yet. Add events with a start date, or create a Timeline entity and link events to it.
          </div>`
        : `
        ${
          data.range?.start_year != null
            ? `<p class="text-xs text-ink-faint mb-2 tabular-nums">
                ${fmtYear(data.range.start_year)} → ${fmtYear(data.range.end_year)}
              </p>`
            : ""
        }
        <div class="overflow-x-auto pb-4">
          <div class="min-w-[640px] px-8">
            <div class="timeline-track">
              ${dated
                .map((item, idx) => {
                  const above = idx % 2 === 0;
                  return `
                  <a href="#/entity/${item.entity.id}" class="timeline-dot" style="left:${item.position}%" title="${escapeHtml(item.entity.title)}">
                    <span class="timeline-label ${above ? "above" : ""}">
                      <span class="block font-semibold text-ink">${escapeHtml(item.display_date || "?")}</span>
                      <span class="block text-ink-muted">${escapeHtml(item.entity.title)}</span>
                    </span>
                  </a>`;
                })
                .join("")}
            </div>
          </div>
        </div>

        <h2 class="font-display text-xl mb-3 mt-4">Chronological list</h2>
        <div class="space-y-2">
          ${data.items
            .map((item) => {
              const e = item.entity;
              return `
              <a href="#/entity/${e.id}" class="entity-row no-underline text-inherit">
                <div class="w-20 shrink-0 text-sm tabular-nums text-ink-faint">${escapeHtml(item.display_date || "—")}</div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="font-medium">${escapeHtml(e.title)}</span>
                    <span class="type-badge">${typeLabel(e.type)}</span>
                  </div>
                  ${e.summary ? `<p class="text-sm text-ink-muted mt-0.5 line-clamp-1">${escapeHtml(e.summary)}</p>` : ""}
                </div>
              </a>`;
            })
            .join("")}
        </div>
        ${
          undated.length
            ? `<p class="text-xs text-ink-faint mt-3">${undated.length} undated item(s) listed at the end.</p>`
            : ""
        }`
    }
  `;

  function push() {
    const tid = document.getElementById("tl-pick").value;
    const t = document.getElementById("tl-tag").value.trim();
    const params = new URLSearchParams();
    if (tid) params.set("timeline_id", tid);
    if (t) params.set("tag", t);
    const s = params.toString();
    location.hash = `/timeline${s ? `?${s}` : ""}`;
  }

  document.getElementById("tl-pick").addEventListener("change", push);
  let deb;
  document.getElementById("tl-tag").addEventListener("input", () => {
    clearTimeout(deb);
    deb = setTimeout(push, 250);
  });
}

function fmtYear(y) {
  if (y == null) return "";
  return y < 0 ? `${Math.abs(y)} BCE` : String(y);
}
