/** Event board — sorted events, filters, multi-select → group into topic. */

import { api } from "../api.js";
import { escapeHtml, entityMatches, formatDate, toast } from "../util.js";

export async function renderLibrary(root, { query = {} } = {}) {
  const tab = query.tab === "topics" ? "topics" : "events";
  const filterTag = query.tag || "";
  const filterQ = query.q || "";

  if (tab === "topics") {
    await renderTopicsTab(root, { filterQ });
    return;
  }

  const entities = await api.listEntities({ type: "event" });
  const tags = [...new Set(entities.flatMap((e) => e.tags || []))].sort((a, b) =>
    a.localeCompare(b)
  );

  let filtered = entities;
  if (filterTag) filtered = filtered.filter((e) => (e.tags || []).includes(filterTag));
  if (filterQ) filtered = filtered.filter((e) => entityMatches(e, filterQ));

  root.innerHTML = `
    <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-4">
      <div>
        <h1 class="font-display text-3xl tracking-tight">Library</h1>
        <p class="text-ink-muted mt-1">${filtered.length} event${filtered.length === 1 ? "" : "s"} · sorted by date</p>
      </div>
      <div class="flex gap-1 rounded-xl bg-paper-deep p-1 self-start">
        <a href="#/library" class="px-3 py-1.5 rounded-lg text-sm font-semibold bg-white text-accent shadow-sm">Events</a>
        <a href="#/library?tab=topics" class="px-3 py-1.5 rounded-lg text-sm text-ink-muted hover:text-ink">Topics</a>
      </div>
    </div>

    <div class="flex flex-col sm:flex-row gap-3 mb-4">
      <input id="lib-q" class="input flex-1" placeholder="Search titles, notes, tags, places…" value="${escapeHtml(filterQ)}" />
      <select id="lib-tag" class="select sm:w-44">
        <option value="">All tags</option>
        ${tags
          .map((t) => `<option value="${escapeHtml(t)}" ${t === filterTag ? "selected" : ""}>#${escapeHtml(t)}</option>`)
          .join("")}
      </select>
    </div>

    <div id="group-bar" class="hidden sticky top-14 z-10 mb-3 rounded-xl bg-accent text-white px-4 py-3 flex flex-wrap items-center gap-3 shadow-soft">
      <span id="group-count" class="text-sm font-medium"></span>
      <button type="button" id="group-btn" class="ml-auto bg-white text-accent-dark font-semibold text-sm px-3 py-1.5 rounded-lg hover:bg-accent-soft">Group into topic…</button>
      <button type="button" id="group-clear" class="text-sm text-white/80 hover:text-white">Clear</button>
    </div>

    ${
      filtered.length === 0
        ? `<div class="rounded-2xl border border-dashed border-paper-line bg-white/50 p-10 text-center">
            <p class="font-display text-xl mb-2">${entities.length === 0 ? "No events yet" : "No matches"}</p>
            <p class="text-ink-muted text-sm mb-4">${
              entities.length === 0
                ? "Hit + Add to create your first event."
                : "Try a different search or clear filters."
            }</p>
          </div>`
        : `<div class="space-y-2" id="lib-list">
            ${filtered
              .map((e) => {
                const range = formatDate(e.date_start);
                return `
                <div class="entity-row items-center !cursor-default" data-row="${e.id}">
                  <label class="shrink-0 flex items-center p-1 cursor-pointer" title="Select for topic">
                    <input type="checkbox" class="event-check w-4 h-4 accent-[#C45C26]" data-id="${e.id}" />
                  </label>
                  <a href="#/entity/${e.id}" class="flex-1 min-w-0 no-underline text-inherit">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="font-medium truncate">${escapeHtml(e.title)}</span>
                      ${range ? `<span class="text-xs text-ink-faint tabular-nums">${escapeHtml(range)}</span>` : `<span class="text-xs text-ink-faint">Undated</span>`}
                    </div>
                    ${e.summary ? `<p class="text-sm text-ink-muted mt-0.5 line-clamp-1">${escapeHtml(e.summary)}</p>` : ""}
                    <div class="flex flex-wrap gap-2 mt-1">
                      ${e.place_name ? `<span class="text-[11px] text-ink-faint">${escapeHtml(e.place_name)}</span>` : ""}
                      ${(e.tags || [])
                        .map((t) => `<span class="text-[11px] text-ink-faint">#${escapeHtml(t)}</span>`)
                        .join("")}
                    </div>
                  </a>
                </div>`;
              })
              .join("")}
          </div>`
    }
  `;

  function pushFilters() {
    const q = document.getElementById("lib-q").value.trim();
    const tag = document.getElementById("lib-tag").value;
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (tag) params.set("tag", tag);
    const s = params.toString();
    location.hash = `/library${s ? `?${s}` : ""}`;
  }

  let debounce;
  document.getElementById("lib-q")?.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(pushFilters, 220);
  });
  document.getElementById("lib-tag")?.addEventListener("change", pushFilters);

  const selected = new Set();
  const bar = document.getElementById("group-bar");
  const countEl = document.getElementById("group-count");

  function syncBar() {
    if (!bar) return;
    if (selected.size === 0) {
      bar.classList.add("hidden");
      return;
    }
    bar.classList.remove("hidden");
    countEl.textContent = `${selected.size} selected`;
  }

  root.querySelectorAll(".event-check").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(cb.dataset.id);
      else selected.delete(cb.dataset.id);
      syncBar();
    });
  });

  document.getElementById("group-clear")?.addEventListener("click", () => {
    selected.clear();
    root.querySelectorAll(".event-check").forEach((cb) => {
      cb.checked = false;
    });
    syncBar();
  });

  document.getElementById("group-btn")?.addEventListener("click", async () => {
    if (selected.size === 0) return;
    const title = prompt("Topic name for the selected events:");
    if (!title || !title.trim()) return;
    try {
      const topic = await api.createTopic({
        title: title.trim(),
        event_ids: [...selected],
      });
      toast(`Grouped into “${topic.title}”`);
      location.hash = `/entity/${topic.id}`;
    } catch (err) {
      toast(err.message || "Could not create topic");
    }
  });
}

async function renderTopicsTab(root, { filterQ = "" } = {}) {
  let topics = await api.listEntities({ type: "topic" });
  if (filterQ) topics = topics.filter((e) => entityMatches(e, filterQ));

  root.innerHTML = `
    <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-4">
      <div>
        <h1 class="font-display text-3xl tracking-tight">Topics</h1>
        <p class="text-ink-muted mt-1">${topics.length} topic${topics.length === 1 ? "" : "s"}</p>
      </div>
      <div class="flex gap-1 rounded-xl bg-paper-deep p-1 self-start">
        <a href="#/library" class="px-3 py-1.5 rounded-lg text-sm text-ink-muted hover:text-ink">Events</a>
        <a href="#/library?tab=topics" class="px-3 py-1.5 rounded-lg text-sm font-semibold bg-white text-accent shadow-sm">Topics</a>
      </div>
    </div>
    <p class="text-sm text-ink-muted mb-5">Select events on the Events board, then group them under a topic name.</p>
    ${
      topics.length === 0
        ? `<div class="rounded-2xl border border-dashed border-paper-line p-10 text-center text-ink-muted text-sm">
            No topics yet. Tick events in the library and use <strong class="text-ink">Group into topic</strong>.
          </div>`
        : `<div class="space-y-2">
            ${topics
              .map(
                (t) => `
              <a href="#/entity/${t.id}" class="entity-row no-underline text-inherit">
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="font-medium">${escapeHtml(t.title)}</span>
                    <span class="type-badge">Topic</span>
                  </div>
                  ${t.summary ? `<p class="text-sm text-ink-muted mt-0.5">${escapeHtml(t.summary)}</p>` : ""}
                </div>
              </a>`
              )
              .join("")}
          </div>`
    }
  `;
}
