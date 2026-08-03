/** Event board — sorted events, filters, multi-select → group into topic. */

import { api } from "../api.js";
import { escapeHtml, entityMatches, formatDate, formatRange, formatCountryNames, formatSignedYear, composeDate, storedToSignedYear, toast, typeLabel, isImageUrl } from "../util.js";
import { openAddPhase, openAddTopic, openAddFigure, openAddCountry } from "../modal.js";

const HUB_TABS = {
  periods: {
    type: "period",
    title: "Periods",
    empty: "No periods yet. Add one to set a From – To range.",
  },
  phases: {
    type: "phase",
    title: "Phases",
    empty: "No phases yet. Add one to group events inside periods.",
  },
  countries: {
    type: "place",
    title: "Countries",
    empty: "No countries yet. Add one here, or type a country when adding an event.",
  },
  figures: {
    type: "figure",
    title: "Figures",
    empty: "No figures yet. Add a person to open their biography and life story.",
  },
  topics: {
    type: "topic",
    title: "Topics",
    empty: "No topics yet. Create one, or select events/phases and group them.",
  },
};

function entityImageUrls(entity) {
  return (entity.attachments || []).filter((u) => isImageUrl(u));
}

async function eventIdsForHub(hubId) {
  if (!hubId) return null;
  const data = await api.neighbors(hubId);
  const ids = new Set();
  for (const item of data.related?.event || []) {
    ids.add(item.entity.id);
  }
  for (const item of data.backlinks || []) {
    if (item.entity?.type === "event") ids.add(item.entity.id);
  }
  return ids;
}

function countryOptionLabel(place, flagMap) {
  const flag =
    (place.summary && !String(place.summary).includes(" ") ? place.summary.trim() : "") ||
    flagMap[place.title.toLowerCase()] ||
    "";
  return flag ? `${flag} ${place.title}` : place.title;
}

async function clientSyncCountryPlaces() {
  const [events, figures, places] = await Promise.all([
    api.listEntities({ type: "event" }),
    api.listEntities({ type: "figure" }),
    api.listEntities({ type: "place" }),
  ]);
  const known = new Set(places.map((p) => p.title.toLowerCase()));
  const names = new Set();
  for (const event of events) {
    for (const name of formatCountryNames(event)) {
      if (name) names.add(name);
    }
  }
  for (const figure of figures) {
    if (figure.place_name?.trim()) names.add(figure.place_name.trim());
  }
  let catalogData = { countries: [], empires: [] };
  try {
    catalogData = await api.catalog();
  } catch {
    /* ignore */
  }
  const flagMap = {};
  for (const c of catalogData.countries || []) flagMap[c.name.toLowerCase()] = c.flag;
  for (const e of catalogData.empires || []) flagMap[e.name.toLowerCase()] = e.flag;

  for (const name of names) {
    if (known.has(name.toLowerCase())) continue;
    const flag = flagMap[name.toLowerCase()] || null;
    await api.createEntity({
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
    known.add(name.toLowerCase());
  }
}

export async function renderLibrary(root, { query = {} } = {}) {
  const tab = query.tab || "events";
  const filterTag = query.tag || "";
  const filterQ = query.q || "";
  const filterPeriod = query.period || "";
  const filterCountry = query.country || "";
  const filterFigure = query.figure || "";

  const filterCategory = query.category || "";

  if (tab === "gallery") {
    await renderGalleryTab(root, {
      filterQ,
      filterType: query.type || "",
      filterCategory: query.category || "",
    });
    return;
  }

  if (HUB_TABS[tab]) {
    await renderHubTab(root, { tab, filterQ });
    return;
  }

  const [entities, periods, places, figures, catalog, progress] = await Promise.all([
    api.listEntities({ type: "event" }),
    api.listEntities({ type: "period" }),
    api.listEntities({ type: "place" }),
    api.listEntities({ type: "figure" }),
    api.catalog().catch(() => ({ countries: [] })),
    api.getProgress().catch(() => ({ categories: [] })),
  ]);
  const categories = progress.categories || [];

  const flagMap = {};
  for (const c of catalog.countries || []) {
    flagMap[c.name.toLowerCase()] = c.flag;
  }
  for (const e of catalog.empires || []) {
    flagMap[e.name.toLowerCase()] = e.flag;
  }

  const hubIdSets = await Promise.all([
    eventIdsForHub(filterPeriod),
    eventIdsForHub(filterCountry),
    eventIdsForHub(filterFigure),
  ]);

  let filtered = entities;
  if (filterTag) filtered = filtered.filter((e) => (e.tags || []).includes(filterTag));
  if (filterCategory) filtered = filtered.filter((e) => (e.category || "") === filterCategory);
  if (filterQ) filtered = filtered.filter((e) => entityMatches(e, filterQ));
  for (const idSet of hubIdSets) {
    if (idSet) filtered = filtered.filter((e) => idSet.has(e.id));
  }

  const tags = [...new Set(entities.flatMap((e) => e.tags || []))].sort((a, b) =>
    a.localeCompare(b)
  );

  function hubOptions(items, selectedId, labelFn) {
    return items
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((h) => {
        const label = labelFn ? labelFn(h) : h.title;
        return `<option value="${escapeHtml(h.id)}" ${h.id === selectedId ? "selected" : ""}>${escapeHtml(label)}</option>`;
      })
      .join("");
  }

  root.innerHTML = `
    <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-4">
      <div>
        <h1 class="font-display text-3xl tracking-tight">Events</h1>
        <p class="text-ink-muted mt-1">${filtered.length} event${filtered.length === 1 ? "" : "s"} · sorted by date · tick to group into a topic</p>
      </div>
    </div>

    <div class="flex flex-col gap-3 mb-4">
      <input id="lib-q" class="input w-full" placeholder="Search titles, notes, tags…" value="${escapeHtml(filterQ)}" />
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <select id="lib-category" class="select">
          <option value="">All classifications</option>
          ${categories
            .map((c) => `<option value="${escapeHtml(c)}" ${c === filterCategory ? "selected" : ""}>${escapeHtml(c)}</option>`)
            .join("")}
        </select>
        <select id="lib-tag" class="select">
          <option value="">All tags</option>
          ${tags
            .map((t) => `<option value="${escapeHtml(t)}" ${t === filterTag ? "selected" : ""}>#${escapeHtml(t)}</option>`)
            .join("")}
        </select>
        <select id="lib-period" class="select">
          <option value="">All periods</option>
          ${hubOptions(periods, filterPeriod)}
        </select>
        <select id="lib-country" class="select">
          <option value="">All countries & World</option>
          ${hubOptions(places, filterCountry, (p) => countryOptionLabel(p, flagMap))}
        </select>
        <select id="lib-figure" class="select">
          <option value="">All figures</option>
          ${hubOptions(figures, filterFigure)}
        </select>
      </div>
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
                ? "One title is enough to start your chronicle."
                : "Try a different search or clear filters."
            }</p>
            ${
              entities.length === 0
                ? `<button type="button" id="lib-add-event-empty" class="btn-primary text-sm px-4 py-2">Add event</button>`
                : ""
            }
          </div>`
        : `<div class="space-y-2" id="lib-list">
            ${filtered
              .map((e) => {
                const range = formatRange(e.date_start, e.date_end) || formatDate(e.date_start);
                return `
                <div class="entity-row items-center !cursor-default" data-row="${e.id}">
                  <label class="shrink-0 flex items-center p-1 cursor-pointer" title="Select for topic">
                    <input type="checkbox" class="event-check w-4 h-4 accent-[#C45C26]" data-id="${e.id}" />
                  </label>
                  <a href="#/entity/${e.id}" class="flex-1 min-w-0 no-underline text-inherit">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="font-medium truncate">${escapeHtml(e.title)}</span>
                      ${range ? `<span class="text-xs text-ink-faint tabular-nums">${escapeHtml(range)}</span>` : `<span class="text-xs text-ink-faint">Undated</span>`}
                      ${formatCountryNames(e).length ? `<span class="text-xs text-ink-faint">${escapeHtml(formatCountryNames(e).join(", "))}</span>` : ""}
                      ${e.category ? `<span class="type-badge">${escapeHtml(e.category)}</span>` : ""}
                    </div>
                    ${e.summary ? `<p class="text-sm text-ink-muted mt-0.5 line-clamp-1">${escapeHtml(e.summary)}</p>` : ""}
                    <div class="flex flex-wrap gap-2 mt-1">
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
    const period = document.getElementById("lib-period").value;
    const country = document.getElementById("lib-country").value;
    const figure = document.getElementById("lib-figure").value;
    const category = document.getElementById("lib-category")?.value || "";
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (category) params.set("category", category);
    if (tag) params.set("tag", tag);
    if (period) params.set("period", period);
    if (country) params.set("country", country);
    if (figure) params.set("figure", figure);
    const s = params.toString();
    location.hash = `/library${s ? `?${s}` : ""}`;
  }

  let debounce;
  document.getElementById("lib-q")?.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(pushFilters, 220);
  });
  document.getElementById("lib-category")?.addEventListener("change", pushFilters);
  document.getElementById("lib-tag")?.addEventListener("change", pushFilters);
  document.getElementById("lib-period")?.addEventListener("change", pushFilters);
  document.getElementById("lib-country")?.addEventListener("change", pushFilters);
  document.getElementById("lib-figure")?.addEventListener("change", pushFilters);

  document.getElementById("lib-add-event-empty")?.addEventListener("click", () => {
    document.getElementById("quick-add-btn")?.click();
  });

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
    openAddTopic({
      preselectEventIds: [...selected],
      onSaved: (topic) => {
        location.hash = `/entity/${topic.id}`;
      },
    });
  });
}

async function renderHubTab(root, { tab, filterQ = "" } = {}) {
  const cfg = HUB_TABS[tab];
  const isCountries = tab === "countries";
  if (isCountries) {
    try {
      await api.syncCountryPlaces();
    } catch {
      try {
        await clientSyncCountryPlaces();
      } catch {
        /* list places only */
      }
    }
  }
  let items = await api.listEntities({ type: cfg.type });
  if (filterQ) items = items.filter((e) => entityMatches(e, filterQ));

  let flagMap = {};
  if (tab === "countries") {
    try {
      const cat = await api.catalog();
      for (const c of cat.countries || []) flagMap[c.name.toLowerCase()] = c.flag;
    } catch {
      /* ignore */
    }
  }

  function label(t) {
    if (tab !== "countries") return escapeHtml(t.title);
    const flag =
      (t.summary && t.summary.trim().split(/\s/)[0]) ||
      flagMap[t.title.toLowerCase()] ||
      "";
    return flag ? `${flag} ${escapeHtml(t.title)}` : escapeHtml(t.title);
  }

  const isFigures = tab === "figures";
  const isPeriods = tab === "periods";
  const isPhases = tab === "phases";
  const isTopics = tab === "topics";
  const isRanged = isPeriods || isPhases;
  const subtitle = isFigures
    ? `${items.length} · open a person to see their biography & life story`
    : isPeriods
      ? `${items.length} · each period has a From – To range`
      : isPhases
        ? `${items.length} · tick to group into a topic, or open one`
        : isTopics
          ? `${items.length} · named groups of events and phases`
          : isCountries
            ? `${items.length} · open one to see its events and figures`
            : `${items.length} · open one to see its events`;

  root.innerHTML = `
    <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6">
      <div>
        <h1 class="font-display text-3xl tracking-tight">${cfg.title}</h1>
        <p class="text-ink-muted mt-1">${subtitle}</p>
      </div>
      ${
        items.length === 0
          ? ""
          : isFigures
            ? `<button type="button" id="hub-add-figure" class="btn-secondary text-sm px-4 py-2">Add figure</button>`
            : isPeriods
              ? `<button type="button" id="hub-add-period" class="btn-secondary text-sm px-4 py-2">Add period</button>`
              : isPhases
                ? `<button type="button" id="hub-add-phase" class="btn-secondary text-sm px-4 py-2">Add phase</button>`
                : isTopics
                  ? `<button type="button" id="hub-add-topic" class="btn-secondary text-sm px-4 py-2">Create topic</button>`
                  : isCountries
                    ? `<button type="button" id="hub-add-country" class="btn-secondary text-sm px-4 py-2">Add country</button>`
                    : ""
      }
    </div>
    <input id="hub-q" class="input mb-4" placeholder="Search…" value="${escapeHtml(filterQ)}" />
    ${
      isPhases
        ? `<div id="phase-group-bar" class="hidden sticky top-14 z-10 mb-3 rounded-xl bg-accent text-white px-4 py-3 flex flex-wrap items-center gap-3 shadow-soft">
            <span id="phase-group-count" class="text-sm font-medium"></span>
            <button type="button" id="phase-group-btn" class="ml-auto bg-white text-accent-dark font-semibold text-sm px-3 py-1.5 rounded-lg hover:bg-accent-soft">Group into topic…</button>
            <button type="button" id="phase-group-clear" class="text-sm text-white/80 hover:text-white">Clear</button>
          </div>`
        : ""
    }
    ${
      items.length === 0
        ? `<div class="rounded-2xl border border-dashed border-paper-line p-10 text-center text-ink-muted text-sm space-y-4">
            <p>${cfg.empty}</p>
            ${
              isFigures
                ? `<button type="button" id="hub-add-figure-empty" class="btn-primary text-sm px-4 py-2">Add figure</button>`
                : isPeriods
                  ? `<button type="button" id="hub-add-period-empty" class="btn-primary text-sm px-4 py-2">Add period</button>`
                  : isPhases
                    ? `<button type="button" id="hub-add-phase-empty" class="btn-primary text-sm px-4 py-2">Add phase</button>`
                    : isTopics
                      ? `<button type="button" id="hub-add-topic-empty" class="btn-primary text-sm px-4 py-2">Create topic</button>`
                      : isCountries
                        ? `<button type="button" id="hub-add-country-empty" class="btn-primary text-sm px-4 py-2">Add country</button>`
                        : ""
            }
          </div>`
        : `<div class="space-y-2">
            ${items
              .map(
                (t) => `
              <div class="entity-row items-center !cursor-default" data-row="${t.id}">
                ${
                  isPhases
                    ? `<label class="shrink-0 flex items-center p-1 cursor-pointer" title="Select for topic">
                        <input type="checkbox" class="phase-check w-4 h-4 accent-[#C45C26]" data-id="${t.id}" />
                      </label>`
                    : ""
                }
                <a href="#/entity/${t.id}" class="flex-1 min-w-0 no-underline text-inherit">
                  <div class="flex items-center gap-2">
                    <span class="font-medium">${label(t)}</span>
                    <span class="type-badge">${isFigures ? "Biography" : typeLabel(t.type)}</span>
                  </div>
                  ${t.summary && tab !== "countries" ? `<p class="text-sm text-ink-muted mt-0.5">${escapeHtml(t.summary)}</p>` : ""}
                  ${
                    isFigures && (t.date_start || t.date_end)
                      ? `<p class="text-xs text-ink-faint mt-0.5 tabular-nums">${escapeHtml(formatDate(t.date_start) || "—")}${t.date_end ? ` – ${escapeHtml(formatDate(t.date_end))}` : ""}</p>`
                      : ""
                  }
                  ${
                    isRanged
                      ? `<p class="text-xs text-ink-faint mt-0.5 tabular-nums">${
                          formatRange(t.date_start, t.date_end)
                            ? escapeHtml(formatRange(t.date_start, t.date_end))
                            : "No From – To yet — open to set"
                        }</p>`
                      : ""
                  }
                </a>
              </div>`
              )
              .join("")}
          </div>`
    }
  `;

  const openLibraryAddFigure = () => {
    openAddFigure({
      onSaved: (fig) => {
        if (fig?.id) location.hash = `/entity/${fig.id}`;
      },
    }).catch((err) => {
      console.error(err);
      toast(err.message || "Could not open Add figure");
    });
  };
  document.getElementById("hub-add-figure")?.addEventListener("click", openLibraryAddFigure);
  document.getElementById("hub-add-figure-empty")?.addEventListener("click", openLibraryAddFigure);

  const openLibraryAddCountry = () => {
    openAddCountry({
      onSaved: (place) => {
        if (place?.id) location.hash = `/entity/${place.id}`;
        else location.hash = "/library?tab=countries";
      },
    }).catch((err) => {
      console.error(err);
      toast(err.message || "Could not open Add country");
    });
  };
  document.getElementById("hub-add-country")?.addEventListener("click", openLibraryAddCountry);
  document.getElementById("hub-add-country-empty")?.addEventListener("click", openLibraryAddCountry);

  async function createPeriod({ title, summary, date_start, date_end }) {
    const name = String(title || "").trim();
    if (!name) {
      toast("Enter a name");
      return;
    }
    if (!date_start || !date_end) {
      toast("Set both From and To years");
      return;
    }
    const startN = storedToSignedYear(date_start);
    const endN = storedToSignedYear(date_end);
    if (startN != null && endN != null && startN > endN) {
      toast("From must be earlier than To");
      return;
    }
    try {
      const period = await api.createEntity({
        type: "period",
        title: name,
        summary: summary || null,
        body: null,
        date_start,
        date_end,
        parent_id: null,
        tags: [],
        attachments: [],
        period_ids: [],
        country_ids: [],
        figure_ids: [],
        link_ids: [],
      });
      toast(`Created “${period.title}”`);
      location.hash = `/entity/${period.id}`;
    } catch (err) {
      toast(err.message || "Could not create period");
    }
  }

  function showAddPeriodForm() {
    const panel = document.getElementById("modal-panel");
    const modal = document.getElementById("modal-root");
    if (!panel || !modal) {
      toast("Could not open form");
      return;
    }
    panel.innerHTML = `
      <div class="flex items-start justify-between mb-4">
        <div>
          <h2 class="font-display text-xl">Add period</h2>
          <p class="text-sm text-ink-muted mt-0.5">Name it and set a From – To range.</p>
        </div>
        <button type="button" class="btn-ghost text-lg leading-none" data-close-modal aria-label="Close">×</button>
      </div>
      <form id="add-period-form" class="space-y-4">
        <div>
          <label class="label" for="add-period-name">Name</label>
          <input id="add-period-name" class="input text-lg" required maxlength="500" placeholder="e.g. Napoleonic Era" autofocus autocomplete="off" />
        </div>
        <div>
          <label class="label" for="add-period-summary">Summary <span class="font-normal text-ink-faint">(optional)</span></label>
          <textarea id="add-period-summary" class="textarea" placeholder="What defines this period…"></textarea>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="label" for="add-period-from">From</label>
            <div class="flex gap-2 items-center">
              <input id="add-period-from" class="input" inputmode="numeric" placeholder="Year" required />
              <label class="inline-flex items-center gap-1 text-xs"><input type="radio" name="add-period-from-era" value="ac" checked /> AC</label>
              <label class="inline-flex items-center gap-1 text-xs"><input type="radio" name="add-period-from-era" value="bc" /> BC</label>
            </div>
          </div>
          <div>
            <label class="label" for="add-period-to">To</label>
            <div class="flex gap-2 items-center">
              <input id="add-period-to" class="input" inputmode="numeric" placeholder="Year" required />
              <label class="inline-flex items-center gap-1 text-xs"><input type="radio" name="add-period-to-era" value="ac" checked /> AC</label>
              <label class="inline-flex items-center gap-1 text-xs"><input type="radio" name="add-period-to-era" value="bc" /> BC</label>
            </div>
          </div>
        </div>
        <div class="flex justify-end gap-2 pt-1">
          <button type="button" class="btn-ghost" data-close-modal>Cancel</button>
          <button type="submit" class="btn-primary px-5 py-2.5">Create period</button>
        </div>
      </form>
    `;
    modal.classList.remove("hidden");

    const nameEl = document.getElementById("add-period-name");
    const fromEl = document.getElementById("add-period-from");
    const toEl = document.getElementById("add-period-to");

    document.getElementById("add-period-form")?.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fromEra = document.querySelector('input[name="add-period-from-era"]:checked')?.value || "ac";
      const toEra = document.querySelector('input[name="add-period-to-era"]:checked')?.value || "ac";
      await createPeriod({
        title: nameEl?.value || "",
        summary: document.getElementById("add-period-summary")?.value.trim() || null,
        date_start: composeDate(fromEl?.value.trim(), null, null, fromEra),
        date_end: composeDate(toEl?.value.trim(), null, null, toEra),
      });
      modal.classList.add("hidden");
      panel.innerHTML = "";
    });
    queueMicrotask(() => nameEl?.focus());
  }

  document.getElementById("hub-add-period")?.addEventListener("click", showAddPeriodForm);
  document.getElementById("hub-add-period-empty")?.addEventListener("click", showAddPeriodForm);

  const openLibraryAddPhase = () => {
    openAddPhase({
      onSaved: (saved) => {
        if (saved?.id) location.hash = `/entity/${saved.id}`;
        else location.hash = "/library?tab=phases";
      },
    }).catch((err) => {
      console.error(err);
      toast(err.message || "Could not open Add phase");
    });
  };
  document.getElementById("hub-add-phase")?.addEventListener("click", openLibraryAddPhase);
  document.getElementById("hub-add-phase-empty")?.addEventListener("click", openLibraryAddPhase);

  const openCreateTopic = () => {
    openAddTopic({
      onSaved: (topic) => {
        location.hash = `/entity/${topic.id}`;
      },
    });
  };
  document.getElementById("hub-add-topic")?.addEventListener("click", openCreateTopic);
  document.getElementById("hub-add-topic-empty")?.addEventListener("click", openCreateTopic);

  if (isPhases) {
    const selectedPhases = new Set();
    const phaseBar = document.getElementById("phase-group-bar");
    const phaseCount = document.getElementById("phase-group-count");
    function syncPhaseBar() {
      if (!phaseBar) return;
      if (selectedPhases.size === 0) {
        phaseBar.classList.add("hidden");
        return;
      }
      phaseBar.classList.remove("hidden");
      if (phaseCount) phaseCount.textContent = `${selectedPhases.size} selected`;
    }
    root.querySelectorAll(".phase-check").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) selectedPhases.add(cb.dataset.id);
        else selectedPhases.delete(cb.dataset.id);
        syncPhaseBar();
      });
    });
    document.getElementById("phase-group-clear")?.addEventListener("click", () => {
      selectedPhases.clear();
      root.querySelectorAll(".phase-check").forEach((cb) => {
        cb.checked = false;
      });
      syncPhaseBar();
    });
    document.getElementById("phase-group-btn")?.addEventListener("click", () => {
      if (selectedPhases.size === 0) return;
      openAddTopic({
        preselectPhaseIds: [...selectedPhases],
        onSaved: (topic) => {
          location.hash = `/entity/${topic.id}`;
        },
      });
    });
  }

  let debounce;
  document.getElementById("hub-q")?.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const q = document.getElementById("hub-q").value.trim();
      const params = new URLSearchParams({ tab });
      if (q) params.set("q", q);
      location.hash = `/library?${params}`;
    }, 220);
  });
}

async function renderGalleryTab(
  root,
  { filterQ = "", filterType = "", filterCategory = "" } = {}
) {
  const [all, categories] = await Promise.all([
    api.listEntities(),
    api.getUserCategories(),
  ]);

  let items = all
    .map((e) => ({ entity: e, images: entityImageUrls(e) }))
    .filter((x) => x.images.length > 0);

  if (filterType === "event" || filterType === "figure") {
    items = items.filter((x) => x.entity.type === filterType);
  }
  if (filterCategory) {
    items = items.filter((x) => {
      if (x.entity.type === "figure") return (x.entity.category || "") === filterCategory;
      return x.entity.type === "event";
    });
  }
  if (filterQ) {
    items = items.filter((x) => entityMatches(x.entity, filterQ));
  }
  items.sort((a, b) => a.entity.title.localeCompare(b.entity.title));

  const typeSummary =
    filterType === "event" ? "events" : filterType === "figure" ? "figures" : "items";
  const filterBits = [typeSummary];
  if (filterCategory) filterBits.push(filterCategory);

  function galleryHashParams() {
    const params = new URLSearchParams({ tab: "gallery" });
    const q = document.getElementById("gallery-q")?.value.trim();
    const type = document.getElementById("gallery-type")?.value || "";
    const category = document.getElementById("gallery-category")?.value || "";
    if (q) params.set("q", q);
    if (type) params.set("type", type);
    if (category) params.set("category", category);
    return params;
  }

  function navigateGallery() {
    location.hash = `/library?${galleryHashParams()}`;
  }

  const showCategoryFilter = filterType !== "event";

  root.innerHTML = `
    <div class="mb-6">
      <h1 class="font-display text-3xl tracking-tight">Gallery</h1>
      <p class="text-ink-muted mt-1">${items.length} ${filterBits.join(" · ")} with media</p>
    </div>

    <div class="flex flex-col gap-3 mb-6 max-w-2xl">
      <input id="gallery-q" class="input w-full" placeholder="Search gallery…" value="${escapeHtml(filterQ)}" />
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <select id="gallery-type" class="select">
          <option value="" ${filterType === "" ? "selected" : ""}>All types</option>
          <option value="event" ${filterType === "event" ? "selected" : ""}>Events only</option>
          <option value="figure" ${filterType === "figure" ? "selected" : ""}>Figures only</option>
        </select>
        <select id="gallery-category" class="select" ${showCategoryFilter ? "" : "disabled"}>
          <option value="">All classifications</option>
          ${categories
            .map(
              (c) =>
                `<option value="${escapeHtml(c)}" ${c === filterCategory ? "selected" : ""}>${escapeHtml(c)}</option>`
            )
            .join("")}
        </select>
      </div>
      ${
        filterType === "event"
          ? `<p class="text-xs text-ink-faint">Classification applies to figures — switch to Figures or All types to use it.</p>`
          : ""
      }
    </div>

    ${
      items.length === 0
        ? `<div class="rounded-2xl border border-dashed border-paper-line bg-white/50 p-10 text-center text-ink-muted">
            <p class="font-display text-xl mb-2">No images yet</p>
            <p class="text-sm">Add media when creating events or figures — paste an image or URL.</p>
          </div>`
        : `<div class="gallery-grid">
            ${items
              .map(({ entity: e, images }) => {
                const thumb = images[0];
                const range = formatRange(e.date_start, e.date_end) || formatDate(e.date_start);
                return `
                <a href="#/entity/${e.id}" class="gallery-card no-underline text-inherit">
                  <div class="gallery-thumb-wrap">
                    <img src="${escapeHtml(thumb)}" alt="" class="gallery-thumb" loading="lazy" />
                  </div>
                  <div class="gallery-meta">
                    <div class="flex flex-wrap items-center gap-1.5">
                      <span class="type-badge">${typeLabel(e.type)}</span>
                      ${e.category ? `<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-paper-deep text-ink-muted">${escapeHtml(e.category)}</span>` : ""}
                    </div>
                    <p class="font-medium text-sm mt-1 line-clamp-2">${escapeHtml(e.title)}</p>
                    ${range ? `<p class="text-xs text-ink-faint tabular-nums mt-0.5">${escapeHtml(range)}</p>` : ""}
                  </div>
                </a>`;
              })
              .join("")}
          </div>`
    }
  `;

  document.getElementById("gallery-type")?.addEventListener("change", () => {
    const type = document.getElementById("gallery-type")?.value || "";
    const catEl = document.getElementById("gallery-category");
    if (catEl) {
      if (type === "event") {
        catEl.value = "";
        catEl.disabled = true;
      } else {
        catEl.disabled = false;
      }
    }
    navigateGallery();
  });
  document.getElementById("gallery-category")?.addEventListener("change", navigateGallery);

  let debounce;
  document.getElementById("gallery-q")?.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(navigateGallery, 220);
  });
}
