/** Library list view. */

import { api } from "./api.js";
import { escapeHtml, entityMatches, formatRange, typeLabel } from "./util.js";

const TYPES = ["", "event", "place", "figure", "period", "milestone", "timeline"];

export async function renderLibrary(root, { query = {} } = {}) {
  const entities = await api.listEntities();
  const filterType = query.type || "";
  const filterTag = query.tag || "";
  const filterQ = query.q || "";

  const tags = [...new Set(entities.flatMap((e) => e.tags || []))].sort((a, b) =>
    a.localeCompare(b)
  );

  let filtered = entities;
  if (filterType) filtered = filtered.filter((e) => e.type === filterType);
  if (filterTag) filtered = filtered.filter((e) => (e.tags || []).includes(filterTag));
  if (filterQ) filtered = filtered.filter((e) => entityMatches(e, filterQ));

  root.innerHTML = `
    <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6">
      <div>
        <h1 class="font-display text-3xl tracking-tight">Library</h1>
        <p class="text-ink-muted mt-1">${filtered.length} of ${entities.length} entries</p>
      </div>
    </div>

    <div class="flex flex-col sm:flex-row gap-3 mb-5">
      <input id="lib-q" class="input flex-1" placeholder="Search titles, summaries, tags…" value="${escapeHtml(filterQ)}" />
      <select id="lib-type" class="select sm:w-40">
        ${TYPES.map(
          (t) =>
            `<option value="${t}" ${t === filterType ? "selected" : ""}>${t ? typeLabel(t) : "All types"}</option>`
        ).join("")}
      </select>
      <select id="lib-tag" class="select sm:w-40">
        <option value="">All tags</option>
        ${tags
          .map((t) => `<option value="${escapeHtml(t)}" ${t === filterTag ? "selected" : ""}>${escapeHtml(t)}</option>`)
          .join("")}
      </select>
    </div>

    ${
      filtered.length === 0
        ? `<div class="rounded-2xl border border-dashed border-paper-line bg-white/50 p-10 text-center">
            <p class="font-display text-xl mb-2">${entities.length === 0 ? "Your library is empty" : "No matches"}</p>
            <p class="text-ink-muted text-sm mb-4">${
              entities.length === 0
                ? "Add an event, place, or figure — or load the sample set from Settings."
                : "Try a different search or clear filters."
            }</p>
            ${
              entities.length === 0
                ? `<a href="#/settings" class="btn-secondary inline-block">Go to Settings</a>`
                : ""
            }
          </div>`
        : `<div class="space-y-2" id="lib-list">
            ${filtered
              .map((e) => {
                const range = formatRange(e.date_start, e.date_end);
                return `
                <a href="#/entity/${e.id}" class="entity-row no-underline text-inherit">
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="font-medium truncate">${escapeHtml(e.title)}</span>
                      <span class="type-badge">${typeLabel(e.type)}</span>
                      ${range ? `<span class="text-xs text-ink-faint">${escapeHtml(range)}</span>` : ""}
                    </div>
                    ${e.summary ? `<p class="text-sm text-ink-muted mt-0.5 line-clamp-1">${escapeHtml(e.summary)}</p>` : ""}
                    ${
                      (e.tags || []).length
                        ? `<div class="flex flex-wrap gap-1 mt-1.5">${(e.tags || [])
                            .map((t) => `<span class="text-[11px] text-ink-faint">#${escapeHtml(t)}</span>`)
                            .join("")}</div>`
                        : ""
                    }
                  </div>
                </a>`;
              })
              .join("")}
          </div>`
    }
  `;

  function pushFilters() {
    const q = document.getElementById("lib-q").value.trim();
    const type = document.getElementById("lib-type").value;
    const tag = document.getElementById("lib-tag").value;
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (type) params.set("type", type);
    if (tag) params.set("tag", tag);
    const s = params.toString();
    location.hash = `/library${s ? `?${s}` : ""}`;
  }

  let debounce;
  document.getElementById("lib-q").addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(pushFilters, 220);
  });
  document.getElementById("lib-type").addEventListener("change", pushFilters);
  document.getElementById("lib-tag").addEventListener("change", pushFilters);
}
