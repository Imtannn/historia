/** Event board — sorted events, filters, multi-select → group into topic. */

import { api } from "../api.js";
import { escapeHtml, entityMatches, formatDate, formatEntityRange, formatCountryNames, formatSignedYear, composeDate, storedToSignedYear, toast, typeLabel, isImageUrl, bindYearInputs, presentYear, compareByDateThenTitle, compareSortDates, entitySortDate, effectiveEndYear, rangesEnclosed } from "../util.js";
import { restoreGalleryScroll } from "../scroll-memory.js";
import { openAddPhase, openAddTopic, openAddFigure, openAddCountry, openAssignCountry, openDangerConfirm } from "../modal.js";

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

function eraBounds(era) {
  const start = storedToSignedYear(era?.date_start);
  if (start == null) return null;
  const end = effectiveEndYear(era) ?? start;
  return [Math.min(start, end), Math.max(start, end)];
}

function eraDuration(era) {
  const bounds = eraBounds(era);
  return bounds ? bounds[1] - bounds[0] : Number.POSITIVE_INFINITY;
}

function eraCountryKeys(era) {
  return formatCountryNames(era).map((n) => n.toLowerCase());
}

function eraContainsDates(era, entity) {
  const outer = eraBounds(era);
  const start = storedToSignedYear(entity?.date_start);
  if (!outer || start == null) return false;
  if (entity.type === "figure") {
    return start >= outer[0] && start <= outer[1];
  }
  const end = effectiveEndYear(entity) ?? start;
  return rangesEnclosed(start, end, outer[0], outer[1]);
}

/** Date enclosure, plus country when the era has one. */
function eraContains(era, entity, ctx = null) {
  if (!eraContainsDates(era, entity)) return false;
  const want = eraCountryKeys(era);
  if (!want.length) return true;
  const have = galleryCountries(entity, ctx).map((n) => n.toLowerCase());
  if (!have.length) return false;
  return have.some((name) => want.includes(name));
}

function pickNarrowestEra(entity, eras, ctx = null) {
  const hits = (eras || []).filter((era) => eraContains(era, entity, ctx));
  if (!hits.length) return null;
  hits.sort((a, b) => {
    const aLocal = eraCountryKeys(a).length ? 0 : 1;
    const bLocal = eraCountryKeys(b).length ? 0 : 1;
    if (aLocal !== bLocal) return aLocal - bLocal;
    const delta = eraDuration(a) - eraDuration(b);
    if (delta !== 0) return delta;
    return compareByDateThenTitle(a, b);
  });
  return hits[0];
}

function buildGalleryCtx(all, flagMap = {}) {
  return {
    byId: new Map((all || []).map((e) => [e.id, e])),
    periods: (all || []).filter((e) => e.type === "period").slice().sort(compareByDateThenTitle),
    phases: (all || []).filter((e) => e.type === "phase").slice().sort(compareByDateThenTitle),
    places: (all || []).filter((e) => e.type === "place"),
    events: (all || []).filter((e) => e.type === "event"),
    flagMap,
    countryCache: new Map(),
  };
}

function galleryParent(entity, ctx) {
  if (entity?.type === "milestone" && entity.parent_id) {
    return ctx?.byId?.get(entity.parent_id) || null;
  }
  return null;
}

function galleryDatedEntity(entity, ctx) {
  if (entity?.type === "milestone" && storedToSignedYear(entity.date_start) == null) {
    return galleryParent(entity, ctx) || entity;
  }
  return entity;
}

function pushUniqueName(names, seen, raw) {
  const name = String(raw || "").trim();
  if (!name) return;
  const key = name.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  names.push(name);
}

function ownGalleryCountries(entity, ctx) {
  const names = [];
  const seen = new Set();
  for (const name of formatCountryNames(entity)) pushUniqueName(names, seen, name);
  pushUniqueName(names, seen, entity?.place_name);
  const parent = galleryParent(entity, ctx);
  if (parent) {
    for (const name of ownGalleryCountries(parent, ctx)) pushUniqueName(names, seen, name);
  }
  return names;
}

function galleryCountries(entity, ctx) {
  if (!entity) return [];
  if (entity.id && ctx?.countryCache?.has(entity.id)) return ctx.countryCache.get(entity.id);

  const names = ownGalleryCountries(entity, ctx);
  const seen = new Set(names.map((name) => name.toLowerCase()));

  // Figures inherit countries from contemporaneous events they already share a country
  // with, so Julius Caesar (Rome, 100 BC) sits with "invades Britain" (Rome/England, 55 BC).
  if (entity.type === "figure" && seen.size && ctx?.events?.length) {
    const birth = storedToSignedYear(entity.date_start);
    const death = effectiveEndYear(entity) ?? birth;
    const lo = birth == null ? null : Math.min(birth, death ?? birth);
    const hi = birth == null ? null : Math.max(birth, death ?? birth);
    for (const event of ctx.events) {
      const start = storedToSignedYear(event.date_start);
      if (start == null) continue;
      if (lo != null && (start < lo || start > hi)) continue;
      const eventCountries = ownGalleryCountries(event, ctx);
      if (!eventCountries.some((name) => seen.has(name.toLowerCase()))) continue;
      for (const name of eventCountries) pushUniqueName(names, seen, name);
    }
  }

  if (entity.id && ctx?.countryCache) ctx.countryCache.set(entity.id, names);
  return names;
}

function galleryPhase(entity, ctx) {
  const dated = galleryDatedEntity(entity, ctx);
  const own = pickNarrowestEra(dated, ctx?.phases, ctx);
  if (own) return own;
  const parent = galleryParent(entity, ctx);
  if (!parent) return null;
  return pickNarrowestEra(galleryDatedEntity(parent, ctx), ctx?.phases, ctx);
}

function galleryPeriod(entity, ctx) {
  const phase = galleryPhase(entity, ctx);
  if (phase) {
    const nested = pickNarrowestEra(phase, ctx?.periods, ctx);
    if (nested) return nested;
  }
  const dated = galleryDatedEntity(entity, ctx);
  const own = pickNarrowestEra(dated, ctx?.periods, ctx);
  if (own) return own;
  const parent = galleryParent(entity, ctx);
  if (!parent) return null;
  return pickNarrowestEra(galleryDatedEntity(parent, ctx), ctx?.periods, ctx);
}

function resolveGalleryContext(item, ctx) {
  const entity = item?.entity;
  return {
    countries: galleryCountries(entity, ctx),
    phase: galleryPhase(entity, ctx),
    period: galleryPeriod(entity, ctx),
  };
}

function countryChipHtml(name, flagMap) {
  const flag = (name && flagMap?.[name.toLowerCase()]) || "";
  return `<span class="gallery-chip">${
    flag ? `<span class="gallery-chip-flag">${escapeHtml(flag)}</span>` : ""
  }<span class="gallery-chip-text">${escapeHtml(name)}</span></span>`;
}

function galleryBadgeHtml(item, ctx, badgeKeys) {
  if (!ctx || !badgeKeys?.length) return "";
  const info = resolveGalleryContext(item, ctx);
  const chips = [];
  for (const key of badgeKeys) {
    if (key === "country") {
      if (info.countries.length) {
        for (const name of info.countries.slice(0, 2)) {
          chips.push(countryChipHtml(name, ctx.flagMap));
        }
      } else {
        chips.push(`<span class="gallery-chip gallery-chip-muted">Global</span>`);
      }
    } else if (key === "phase" && info.phase) {
      chips.push(
        `<span class="gallery-chip"><span class="gallery-chip-text">${escapeHtml(info.phase.title)}</span></span>`
      );
    } else if (key === "period" && info.period) {
      chips.push(
        `<span class="gallery-chip"><span class="gallery-chip-text">${escapeHtml(info.period.title)}</span></span>`
      );
    }
  }
  if (!chips.length) return "";
  return `<div class="gallery-chips">${chips.join("")}</div>`;
}

function galleryCardHtml(item, view = {}) {
  const entity = item.entity;
  const thumb = item.images?.[0];
  const range = formatEntityRange(entity) || formatDate(entity.date_start);
  const badges = galleryBadgeHtml(item, view.ctx, view.badges);
  const compact = Boolean(view.compact) || entity.type === "milestone";
  return `
    <a href="#/entity/${entity.id}" class="gallery-card${compact ? " is-moment" : ""} no-underline text-inherit">
      <div class="gallery-thumb-wrap${thumb ? "" : " is-placeholder"}">
        ${
          thumb
            ? `<img src="${escapeHtml(thumb)}" alt="" class="gallery-thumb" loading="lazy" />`
            : `<span class="gallery-placeholder-label">Add image</span>`
        }
      </div>
      <div class="gallery-meta">
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="type-badge">${typeLabel(entity.type)}</span>
          ${entity.category ? `<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-paper-deep text-ink-muted">${escapeHtml(entity.category)}</span>` : ""}
        </div>
        <p class="font-medium text-sm mt-1 line-clamp-2">${escapeHtml(entity.title)}</p>
        ${range ? `<p class="text-xs text-ink-faint tabular-nums mt-0.5">${escapeHtml(range)}</p>` : ""}
        ${badges}
      </div>
    </a>`;
}

const GALLERY_PEER_RANK = { event: 0, figure: 0, milestone: 1 };

function gallerySortDate(item, ctx) {
  const entity = item?.entity;
  const parent = galleryParent(entity, ctx);
  return entitySortDate(entity, parent);
}

function compareGalleryCards(a, b, sortDir = "oldest", ctx = null) {
  const ea = a?.entity;
  const eb = b?.entity;
  let cmp = compareSortDates(gallerySortDate(a, ctx), gallerySortDate(b, ctx));
  if (cmp === 0) {
    const ra = GALLERY_PEER_RANK[ea?.type] ?? 2;
    const rb = GALLERY_PEER_RANK[eb?.type] ?? 2;
    if (ra !== rb) cmp = ra - rb;
    else cmp = String(ea?.title || "").localeCompare(String(eb?.title || ""));
  }
  return sortDir === "newest" ? -cmp : cmp;
}

function galleryLeafHtml(items, view = {}) {
  const ctx = view.ctx;
  const sortDir = view.sortDir || "oldest";
  const leaves = leafCards(items);
  if (!leaves.length) return "";

  const moments = leaves.filter((item) => item.entity.type === "milestone");
  const peers = leaves.filter((item) => item.entity.type !== "milestone");
  const peerIds = new Set(peers.map((item) => item.entity.id));
  const momentsByParent = new Map();
  const orphans = [];

  for (const moment of moments) {
    const parentId = moment.entity.parent_id;
    const parent = parentId ? ctx?.byId?.get(parentId) : null;
    if (parentId && parent?.type === "event") {
      if (!momentsByParent.has(parentId)) momentsByParent.set(parentId, []);
      momentsByParent.get(parentId).push(moment);
      if (!peerIds.has(parentId)) {
        peers.push({ entity: parent, images: entityImageUrls(parent) });
        peerIds.add(parentId);
      }
    } else {
      orphans.push(moment);
    }
  }

  const ordered = peers
    .slice()
    .sort((a, b) => compareGalleryCards(a, b, sortDir, ctx));
  const cards = [];
  for (const peer of ordered) {
    const kids = (momentsByParent.get(peer.entity.id) || [])
      .slice()
      .sort((a, b) => compareGalleryCards(a, b, sortDir, ctx));
    if (peer.entity.type === "event" && kids.length) {
      cards.push(`<div class="gallery-cluster">
        <div class="gallery-cluster-parent">${galleryCardHtml(peer, view)}</div>
        <div class="gallery-cluster-moments">
          <p class="gallery-cluster-label">Moments</p>
          <div class="gallery-grid gallery-grid-moments">${kids
            .map((kid) => galleryCardHtml(kid, { ...view, compact: true }))
            .join("")}</div>
        </div>
      </div>`);
    } else {
      cards.push(galleryCardHtml(peer, view));
    }
  }
  for (const moment of orphans.sort((a, b) => compareGalleryCards(a, b, sortDir, ctx))) {
    cards.push(galleryCardHtml(moment, { ...view, compact: true }));
  }
  return `<div class="gallery-grid gallery-leaf-grid">${cards.join("")}</div>`;
}

const GALLERY_UNASSIGNED = {
  country: { key: "__global__", label: "Global / Unassigned", kind: "country" },
  period: { key: "__unassigned_period__", label: "Unassigned Period", kind: "period" },
  phase: { key: "__unassigned_phase__", label: "Unassigned Phase", kind: "phase" },
};

const GALLERY_NEST_PATHS = {
  country: ["country", "period", "phase"],
  periods: ["period", "phase", "country"],
  phases: ["phase", "period", "country"],
};

const GALLERY_GROUPS = [
  { id: "country", label: "Country" },
  { id: "periods", label: "Period" },
  { id: "phases", label: "Phase" },
  { id: "timeline", label: "Timeline" },
];

function normalizeGalleryGroup(value) {
  const id = String(value || "country").toLowerCase();
  if (id === "hierarchy") return "periods";
  return GALLERY_GROUPS.some((g) => g.id === id) ? id : "country";
}

function normalizeGalleryOrder(value) {
  return String(value || "oldest").toLowerCase() === "newest" ? "newest" : "oldest";
}

function isGalleryLeaf(entity) {
  return entity?.type === "event" || entity?.type === "milestone" || entity?.type === "figure";
}

function leafCards(list) {
  return (list || []).filter((item) => isGalleryLeaf(item.entity));
}

function dimensionBuckets(item, ctx, dim) {
  const info = resolveGalleryContext(item, ctx);
  if (dim === "country") {
    const names = info.countries;
    if (!names.length) return [{ ...GALLERY_UNASSIGNED.country, entity: null, flag: "" }];
    const seen = new Set();
    const buckets = [];
    for (const name of names) {
      const key = `country:${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const place = ctx.places.find((p) => p.title.toLowerCase() === name.toLowerCase()) || null;
      buckets.push({
        key,
        label: name,
        kind: "country",
        entity: place,
        flag: ctx.flagMap?.[name.toLowerCase()] || "",
      });
    }
    return buckets;
  }
  if (dim === "period") {
    if (info.period) {
      return [{ key: info.period.id, label: info.period.title, kind: "period", entity: info.period }];
    }
    return [{ ...GALLERY_UNASSIGNED.period, entity: null }];
  }
  if (info.phase) {
    return [{ key: info.phase.id, label: info.phase.title, kind: "phase", entity: info.phase }];
  }
  return [{ ...GALLERY_UNASSIGNED.phase, entity: null }];
}

function createNestNode(meta) {
  return { ...meta, children: new Map(), items: [] };
}

function placeNestedItem(node, item, path, index, ctx) {
  if (index >= path.length) {
    node.items.push(item);
    return;
  }
  for (const bucket of dimensionBuckets(item, ctx, path[index])) {
    if (!node.children.has(bucket.key)) {
      node.children.set(bucket.key, createNestNode(bucket));
    }
    placeNestedItem(node.children.get(bucket.key), item, path, index + 1, ctx);
  }
}

function buildGalleryTree(items, ctx, path) {
  const root = createNestNode({ key: "root", label: "", kind: "root", entity: null });
  for (const item of leafCards(items)) {
    placeNestedItem(root, item, path, 0, ctx);
  }
  return root;
}

function nestNodeHasContent(node) {
  if (node.items.length) return true;
  for (const child of node.children.values()) {
    if (nestNodeHasContent(child)) return true;
  }
  return false;
}

function isUnassignedNest(node) {
  return String(node?.key || "").startsWith("__");
}

function compareNestNodes(a, b, sortDir = "oldest") {
  const aUn = isUnassignedNest(a);
  const bUn = isUnassignedNest(b);
  if (aUn !== bUn) return aUn ? 1 : -1;
  if (a.kind === "country") {
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  }
  const cmp = compareByDateThenTitle(a.entity || { title: a.label }, b.entity || { title: b.label });
  return sortDir === "newest" ? -cmp : cmp;
}

function nestHeadingHtml(node, depth, ctx) {
  const tag = depth === 0 ? "h2" : depth === 1 ? "h3" : "h4";
  const range = node.entity
    ? formatEntityRange(node.entity) || formatDate(node.entity.date_start)
    : "";
  const title = node.kind === "country" && node.flag ? `${node.flag} ${node.label}` : node.label;
  const linked = node.entity
    ? `<a href="#/entity/${node.entity.id}" class="no-underline text-inherit hover:text-accent">${escapeHtml(title)}</a>`
    : escapeHtml(title);
  return `<${tag} class="gallery-nest-title${isUnassignedNest(node) ? " is-unassigned" : ""}">
    ${linked}
    ${range ? `<span class="gallery-nest-range">${escapeHtml(range)}</span>` : ""}
  </${tag}>`;
}

function renderNestNode(node, depth, view) {
  const kids = [...node.children.values()]
    .filter(nestNodeHasContent)
    .sort((a, b) => compareNestNodes(a, b, view.sortDir));
  const inner = kids.length
    ? kids.map((child) => renderNestNode(child, depth + 1, view)).join("")
    : galleryLeafHtml(node.items, view);
  if (!inner) return "";
  return `<section class="gallery-nest gallery-nest-${depth}">
    ${nestHeadingHtml(node, depth, view.ctx)}
    <div class="gallery-nest-body">${inner}</div>
  </section>`;
}

function renderNestedGallery(items, ctx, groupBy, sortDir) {
  const path = GALLERY_NEST_PATHS[groupBy];
  if (!path) return galleryLeafHtml(items, { ctx, sortDir, badges: ["country", "period", "phase"] });
  const tree = buildGalleryTree(items, ctx, path);
  const top = [...tree.children.values()]
    .filter(nestNodeHasContent)
    .sort((a, b) => compareNestNodes(a, b, sortDir));
  return top.map((node) => renderNestNode(node, 0, { ctx, sortDir, badges: [] })).join("");
}

function renderGalleryBody(ctx, mediaItems, groupBy, sortDir = "oldest") {
  return renderNestedGallery(mediaItems, ctx, groupBy, sortDir);
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
      groupBy: normalizeGalleryGroup(query.group),
      sortDir: normalizeGalleryOrder(query.order),
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
  filtered = filtered.slice().sort(compareByDateThenTitle);

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
        <p class="text-ink-muted mt-1">${filtered.length} event${filtered.length === 1 ? "" : "s"} · sorted oldest to newest · tick to group, assign a country, or delete</p>
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
      <button type="button" id="assign-country-btn" class="bg-white text-accent-dark font-semibold text-sm px-3 py-1.5 rounded-lg hover:bg-accent-soft">Assign to country…</button>
      <button type="button" id="bulk-delete-btn" class="bg-red-800 text-white font-semibold text-sm px-3 py-1.5 rounded-lg hover:bg-red-900">Delete selected</button>
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
                const range = formatEntityRange(e) || formatDate(e.date_start);
                return `
                <div class="entity-row items-center !cursor-default" data-row="${e.id}">
                  <label class="shrink-0 flex items-center p-1 cursor-pointer" title="Select">
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

  document.getElementById("assign-country-btn")?.addEventListener("click", () => {
    if (selected.size === 0) return;
    openAssignCountry({
      entityIds: [...selected],
      onSaved: () => {
        selected.clear();
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      },
    });
  });

  document.getElementById("bulk-delete-btn")?.addEventListener("click", async () => {
    if (selected.size === 0) return;
    const ids = [...selected];
    const n = ids.length;
    const ok = await openDangerConfirm({
      title: "Delete selected events?",
      body: `Are you sure you want to delete ${n} item${n === 1 ? "" : "s"}? This cannot be undone.`,
      confirmLabel: n === 1 ? "Delete event" : `Delete ${n} events`,
    });
    if (!ok) return;
    try {
      const res = await api.bulkDelete(ids);
      const deleted = Number(res.deleted) || n;
      selected.clear();
      syncBar();
      toast(deleted === 1 ? "Deleted 1 event" : `Deleted ${deleted} events`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    } catch (err) {
      toast(err.message || "Could not delete the selected events");
    }
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
  if (tab === "figures" || tab === "periods" || tab === "phases") {
    items = items.slice().sort(compareByDateThenTitle);
  }

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
    ? `${items.length} · oldest birth first · open a person to see their biography & life story`
    : isPeriods
      ? `${items.length} · oldest to newest · each period has a From – To range`
      : isPhases
        ? `${items.length} · oldest to newest · tick to group into a topic, or open one`
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
                    isFigures && (t.date_start || t.date_end || t.ongoing)
                      ? `<p class="text-xs text-ink-faint mt-0.5 tabular-nums">${escapeHtml(formatEntityRange(t) || formatDate(t.date_start) || "—")}</p>`
                      : ""
                  }
                  ${
                    isRanged
                      ? `<p class="text-xs text-ink-faint mt-0.5 tabular-nums">${
                          formatEntityRange(t)
                            ? escapeHtml(formatEntityRange(t))
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

  async function createPeriod({ title, summary, date_start, date_end, ongoing = false }) {
    const name = String(title || "").trim();
    if (!name) {
      toast("Enter a name");
      return;
    }
    if (!date_start || (!ongoing && !date_end)) {
      toast(ongoing ? "Set a From year" : "Set both From and To years");
      return;
    }
    const startN = storedToSignedYear(date_start);
    const endN = ongoing ? presentYear() : storedToSignedYear(date_end);
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
        date_end: ongoing ? null : date_end,
        ongoing,
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
              <input id="add-period-from" class="input" data-year-input inputmode="numeric" placeholder="Year" required />
              <label class="inline-flex items-center gap-1 text-xs"><input type="radio" name="add-period-from-era" value="ac" checked /> AC</label>
              <label class="inline-flex items-center gap-1 text-xs"><input type="radio" name="add-period-from-era" value="bc" /> BC</label>
            </div>
          </div>
          <div>
            <label class="label" for="add-period-to">To</label>
            <div class="flex gap-2 items-center">
              <input id="add-period-to" class="input" data-year-input inputmode="numeric" placeholder="Year" />
              <label class="inline-flex items-center gap-1 text-xs"><input type="radio" name="add-period-to-era" value="ac" checked /> AC</label>
              <label class="inline-flex items-center gap-1 text-xs"><input type="radio" name="add-period-to-era" value="bc" /> BC</label>
            </div>
            <label class="inline-flex items-center gap-1.5 text-xs cursor-pointer mt-1.5">
              <input type="checkbox" id="add-period-ongoing" class="accent-accent" />
              Until now
            </label>
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
    const ongoingEl = document.getElementById("add-period-ongoing");
    bindYearInputs(panel);
    const syncOngoing = () => {
      const on = Boolean(ongoingEl?.checked);
      if (toEl) toEl.disabled = on;
      document.querySelectorAll('input[name="add-period-to-era"]').forEach((el) => {
        el.disabled = on;
      });
    };
    ongoingEl?.addEventListener("change", syncOngoing);
    syncOngoing();

    document.getElementById("add-period-form")?.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fromEra = document.querySelector('input[name="add-period-from-era"]:checked')?.value || "ac";
      const toEra = document.querySelector('input[name="add-period-to-era"]:checked')?.value || "ac";
      const ongoing = Boolean(ongoingEl?.checked);
      await createPeriod({
        title: nameEl?.value || "",
        summary: document.getElementById("add-period-summary")?.value.trim() || null,
        date_start: composeDate(fromEl?.value.trim(), null, null, fromEra),
        date_end: ongoing ? null : composeDate(toEl?.value.trim(), null, null, toEra),
        ongoing,
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
  { filterQ = "", filterType = "", filterCategory = "", groupBy = "country", sortDir = "oldest" } = {}
) {
  const group = normalizeGalleryGroup(groupBy);
  const order = normalizeGalleryOrder(sortDir);
  const [all, categories, catalog] = await Promise.all([
    api.listEntities(),
    api.getUserCategories(),
    api.catalog().catch(() => ({ countries: [], empires: [] })),
  ]);

  const flagMap = {};
  for (const c of catalog.countries || []) flagMap[c.name.toLowerCase()] = c.flag;
  for (const e of catalog.empires || []) flagMap[e.name.toLowerCase()] = e.flag;
  for (const place of all.filter((e) => e.type === "place")) {
    const flag = place.summary && !String(place.summary).includes(" ") ? place.summary.trim() : "";
    if (flag) flagMap[place.title.toLowerCase()] = flag;
  }
  const ctx = buildGalleryCtx(all, flagMap);

  let items = all
    .filter((e) => isGalleryLeaf(e))
    .map((e) => ({ entity: e, images: entityImageUrls(e) }));

  if (filterType === "figure") {
    items = items.filter((x) => x.entity.type === "figure");
  } else if (filterType === "event") {
    const eventIds = new Set(
      items.filter((x) => x.entity.type === "event").map((x) => x.entity.id)
    );
    items = items.filter(
      (x) =>
        x.entity.type === "event" ||
        (x.entity.type === "milestone" && eventIds.has(x.entity.parent_id))
    );
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

  const missingCount = items.filter((x) => !x.images.length).length;
  const groupedHtml = renderGalleryBody(ctx, items, group, order);
  const groupLabel = GALLERY_GROUPS.find((g) => g.id === group)?.label || "Country";
  const orderLabel = order === "newest" ? "newest to oldest" : "oldest to newest";

  const typeSummary =
    filterType === "event" ? "events" : filterType === "figure" ? "figures" : "items";
  const filterBits = [typeSummary];
  if (filterCategory) filterBits.push(filterCategory);
  filterBits.push(`grouped by ${groupLabel.toLowerCase()}`);
  if (missingCount) {
    filterBits.push(`${missingCount} missing an image`);
  }

  function galleryHashParams() {
    const params = new URLSearchParams({ tab: "gallery" });
    const q = document.getElementById("gallery-q")?.value.trim();
    const type = document.getElementById("gallery-type")?.value || "";
    const category = document.getElementById("gallery-category")?.value || "";
    const nextGroup = normalizeGalleryGroup(document.getElementById("gallery-group")?.value);
    const nextOrder = normalizeGalleryOrder(document.getElementById("gallery-order")?.value);
    if (q) params.set("q", q);
    if (type) params.set("type", type);
    if (category) params.set("category", category);
    if (nextGroup !== "country") params.set("group", nextGroup);
    if (nextOrder !== "oldest") params.set("order", nextOrder);
    return params;
  }

  function navigateGallery() {
    location.hash = `/library?${galleryHashParams()}`;
  }

  const showCategoryFilter = filterType !== "event";

  root.innerHTML = `
    <div class="mb-6">
      <h1 class="font-display text-3xl tracking-tight">Gallery</h1>
      <p class="text-ink-muted mt-1">${items.length} ${filterBits.join(" · ")} · ${orderLabel}</p>
    </div>

    <div class="flex flex-col gap-3 mb-6 max-w-4xl">
      <input id="gallery-q" class="input w-full" placeholder="Search gallery…" value="${escapeHtml(filterQ)}" />
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <select id="gallery-type" class="select" aria-label="Filter by type">
          <option value="" ${filterType === "" ? "selected" : ""}>All types</option>
          <option value="event" ${filterType === "event" ? "selected" : ""}>Events only</option>
          <option value="figure" ${filterType === "figure" ? "selected" : ""}>Figures only</option>
        </select>
        <select id="gallery-category" class="select" aria-label="Filter by classification" ${showCategoryFilter ? "" : "disabled"}>
          <option value="">All classifications</option>
          ${categories
            .map(
              (c) =>
                `<option value="${escapeHtml(c)}" ${c === filterCategory ? "selected" : ""}>${escapeHtml(c)}</option>`
            )
            .join("")}
        </select>
        <select id="gallery-group" class="select" aria-label="Group by">
          ${GALLERY_GROUPS.map(
            (g) =>
              `<option value="${g.id}" ${g.id === group ? "selected" : ""}>Group by: ${escapeHtml(g.label)}</option>`
          ).join("")}
        </select>
        <select id="gallery-order" class="select" aria-label="Sort by date">
          <option value="oldest" ${order === "oldest" ? "selected" : ""}>Oldest to newest</option>
          <option value="newest" ${order === "newest" ? "selected" : ""}>Newest to oldest</option>
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
            <p class="font-display text-xl mb-2">Nothing to show</p>
            <p class="text-sm">Add events, figures, or moments — items without pictures still appear here so you can add an image.</p>
          </div>`
        : `<div class="gallery-timeline">${groupedHtml}</div>`
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
  document.getElementById("gallery-group")?.addEventListener("change", navigateGallery);
  document.getElementById("gallery-order")?.addEventListener("change", navigateGallery);

  let debounce;
  document.getElementById("gallery-q")?.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(navigateGallery, 220);
  });

  restoreGalleryScroll();
}
