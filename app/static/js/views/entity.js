/** Entity hub — events show place/attachments; figures show biography + life timeline. */

import { api } from "../api.js";
import {
  escapeHtml,
  formatDate,
  formatRange,
  formatCountryNames,
  isImageUrl,
  relationLabel,
  typeLabel,
  toast,
  compareByDateThenTitle,
} from "../util.js";
import { openEditEvent, openEditFigure, openEditPeriod, openEditPhase, openAddPhase, openAddMilestone, openQuickAdd, openAddToTopic } from "../modal.js";

const GROUP_ORDER = ["event", "phase", "period", "place", "figure", "topic", "milestone", "timeline"];
const GROUP_TITLES = {
  event: "Related events",
  phase: "Phases",
  period: "Periods",
  place: "Countries",
  figure: "Figures",
  topic: "Topics",
  milestone: "Moments",
  timeline: "Timelines",
};

function groupList(related) {
  return [
    ...GROUP_ORDER.filter((k) => related[k]?.length),
    ...Object.keys(related).filter((k) => !GROUP_ORDER.includes(k) && related[k]?.length),
  ];
}

function groupTitle(key, overrides = {}) {
  return overrides[key] || GROUP_TITLES[key] || typeLabel(key);
}

function lifeTimelineHtml(e, lifeEvents) {
  const rows = [];

  if (e.date_start) {
    rows.push({
      kind: "pin",
      sortDate: e.date_start,
      label: "Born",
      date: e.date_start,
      title: "Birth",
      summary: null,
      href: null,
      linkId: null,
      role: "born",
    });
  }

  for (const item of lifeEvents || []) {
    const ent = item.entity;
    rows.push({
      kind: "event",
      sortDate: ent.date_start,
      label: null,
      date: ent.date_start,
      title: ent.title,
      summary: ent.summary,
      href: `#/entity/${ent.id}`,
      linkId: item.link_id,
      role: "",
    });
  }

  if (e.date_end) {
    rows.push({
      kind: "pin",
      sortDate: e.date_end,
      label: "Died",
      date: e.date_end,
      title: "Death",
      summary: null,
      href: null,
      linkId: null,
      role: "died",
    });
  }

  rows.sort((a, b) => compareByDateThenTitle({ date_start: a.sortDate, title: a.title }, { date_start: b.sortDate, title: b.title }));

  if (!rows.length) {
    return `
      <section class="mb-8 rounded-2xl border border-dashed border-paper-line p-6">
        <p class="text-sm text-ink-muted mb-3">No events in this life story yet.</p>
        <button type="button" id="figure-add-moment" class="btn-primary text-sm px-3 py-1.5">Add event</button>
      </section>`;
  }

  return `
    <section class="mb-8">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 class="font-display text-xl">Life story</h2>
        <button type="button" id="figure-add-moment" class="btn-secondary text-sm px-3 py-1.5">Add event</button>
      </div>
      <ol class="relative space-y-0 border-l-2 border-paper-line ml-3 pl-5">
        ${rows
          .map((row) => {
            const dateLabel = formatDate(row.date);
            if (row.kind === "pin") {
              return `
              <li class="relative pb-5 last:pb-0">
                <span class="absolute -left-[1.4rem] top-1.5 h-2.5 w-2.5 rounded-full bg-ink-faint ring-4 ring-paper"></span>
                <div class="flex flex-wrap items-center gap-2 text-sm">
                  <span class="text-[11px] uppercase tracking-wider font-semibold text-ink-faint">${escapeHtml(row.label)}</span>
                  ${dateLabel ? `<span class="text-xs text-ink-faint tabular-nums">${escapeHtml(dateLabel)}</span>` : ""}
                </div>
              </li>`;
            }
            return `
              <li class="relative pb-5 last:pb-0">
                <span class="absolute -left-[1.4rem] top-2.5 h-2.5 w-2.5 rounded-full bg-accent ring-4 ring-paper"></span>
                <a href="${row.href}" class="block rounded-xl border border-paper-line bg-white p-4 shadow-soft no-underline text-inherit">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="font-medium text-base">${escapeHtml(row.title)}</span>
                    ${dateLabel ? `<span class="text-sm text-ink-faint tabular-nums">${escapeHtml(dateLabel)}</span>` : ""}
                  </div>
                  ${row.summary ? `<p class="text-sm text-ink-muted mt-1">${escapeHtml(row.summary)}</p>` : ""}
                </a>
              </li>`;
          })
          .join("")}
      </ol>
    </section>`;
}

function mediaSectionHtml(attachments) {
  if (!attachments?.length) return "";
  return `
    <section class="mb-8 rounded-2xl bg-white border border-paper-line p-5 shadow-soft">
      <h2 class="text-xs uppercase tracking-wider text-ink-faint font-semibold mb-3">Media</h2>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
        ${attachments
          .map((url) => {
            if (isImageUrl(url)) {
              return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="block rounded-xl overflow-hidden border border-paper-line hover:border-accent/40">
                <img src="${escapeHtml(url)}" alt="" class="w-full aspect-square object-cover" loading="lazy" />
              </a>`;
            }
            const isHttp = /^https?:\/\//i.test(url);
            return `<div class="text-sm break-all p-2 rounded-lg bg-paper-deep">
              ${isHttp ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="text-accent hover:underline">${escapeHtml(url)}</a>` : escapeHtml(url)}
            </div>`;
          })
          .join("")}
      </div>
    </section>`;
}

function duringTimeSectionHtml(items) {
  if (!items?.length) return "";
  const sorted = [...items].sort((a, b) =>
    compareByDateThenTitle(a.entity, b.entity)
  );
  return `
    <section class="mb-8">
      <h2 class="font-display text-xl mb-1">Events during this time</h2>
      <p class="text-sm text-ink-muted mb-3">All your other notes whose dates fall within this range — events, moments, figures, phases, and periods from anywhere in your library.</p>
      <div class="space-y-2">
        ${sorted
          .map((item) => {
            const ent = item.entity;
            const r = formatRange(ent.date_start, ent.date_end) || formatDate(ent.date_start);
            const fromParent = item.parent?.title
              ? `<span class="text-xs text-ink-faint">from ${escapeHtml(item.parent.title)}</span>`
              : "";
            return `
            <a href="#/entity/${ent.id}" class="entity-row no-underline text-inherit">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-medium">${escapeHtml(ent.title)}</span>
                  <span class="type-badge">${typeLabel(ent.type)}</span>
                  ${r ? `<span class="text-xs text-ink-faint tabular-nums">${escapeHtml(r)}</span>` : ""}
                  ${fromParent}
                </div>
                ${ent.summary ? `<p class="text-sm text-ink-muted mt-0.5 line-clamp-2">${escapeHtml(ent.summary)}</p>` : ""}
              </div>
            </a>`;
          })
          .join("")}
      </div>
    </section>`;
}

function milestonesSectionHtml(milestones) {
  const sorted = [...milestones].sort((a, b) =>
    compareByDateThenTitle(a.entity, b.entity)
  );
  if (!sorted.length) {
    return `
      <section class="mb-8 rounded-2xl border border-dashed border-paper-line p-6">
        <p class="text-sm text-ink-muted mb-3">No moments yet — add dated moments inside this event’s range.</p>
        <button type="button" id="event-add-milestone" class="btn-primary text-sm px-3 py-1.5">Add moment</button>
      </section>`;
  }
  return `
    <section class="mb-8">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 class="font-display text-xl">Moments</h2>
        <button type="button" id="event-add-milestone" class="btn-secondary text-sm px-3 py-1.5">Add moment</button>
      </div>
      <ol class="relative space-y-0 border-l-2 border-paper-line ml-3 pl-5">
        ${sorted
          .map((item) => {
            const ent = item.entity;
            const r = formatRange(ent.date_start, ent.date_end) || formatDate(ent.date_start);
            return `
            <li class="relative pb-5 last:pb-0">
              <span class="absolute -left-[1.4rem] top-1.5 h-2.5 w-2.5 rounded-full bg-accent ring-4 ring-paper"></span>
              <a href="#/entity/${ent.id}" class="block rounded-xl border border-paper-line bg-white p-3 hover:border-accent/40 no-underline text-inherit">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-medium">${escapeHtml(ent.title)}</span>
                  <span class="type-badge">Moment</span>
                  ${r ? `<span class="text-xs text-ink-faint tabular-nums">${escapeHtml(r)}</span>` : ""}
                </div>
                ${ent.summary ? `<p class="text-sm text-ink-muted mt-1">${escapeHtml(ent.summary)}</p>` : ""}
              </a>
            </li>`;
          })
          .join("")}
      </ol>
    </section>`;
}

function renderEventDetail(root, data, e, bodyHtml) {
  const range = formatRange(e.date_start, e.date_end) || formatDate(e.date_start);
  const related = { ...(data.related || {}) };
  const milestones = related.milestone || [];
  const phases = related.phase || [];
  delete related.milestone;
  delete related.phase;
  const otherGroups = groupList(related);
  const attachments = e.attachments || [];

  root.innerHTML = `
    <div class="mb-2">
      <a href="#/library" class="text-sm text-ink-muted hover:text-accent">← Events</a>
    </div>

    <header class="mb-8">
      <div class="flex flex-wrap items-center gap-2 mb-2">
        <span class="type-badge">${typeLabel(e.type)}</span>
        ${range ? `<span class="text-sm text-ink-faint tabular-nums">${escapeHtml(range)}</span>` : ""}
        ${formatCountryNames(e).length ? `<span class="text-sm text-ink-faint">${escapeHtml(formatCountryNames(e).join(", "))}</span>` : ""}
        ${e.category ? `<span class="type-badge">${escapeHtml(e.category)}</span>` : ""}
      </div>
      <h1 class="font-display text-3xl sm:text-4xl tracking-tight">${escapeHtml(e.title)}</h1>
      ${e.summary ? `<p class="text-lg text-ink-muted mt-3 max-w-2xl">${escapeHtml(e.summary)}</p>` : ""}
      ${
        (e.tags || []).length
          ? `<div class="flex flex-wrap gap-2 mt-3">${(e.tags || [])
              .map(
                (t) =>
                  `<a href="#/library?tag=${encodeURIComponent(t)}" class="text-xs px-2 py-1 rounded-full bg-paper-deep text-ink-muted hover:text-accent">#${escapeHtml(t)}</a>`
              )
              .join("")}</div>`
          : ""
      }
      <div class="flex flex-wrap gap-2 mt-5">
        <button type="button" id="entity-edit" class="btn-secondary text-sm px-3 py-1.5">Edit</button>
        <button type="button" id="event-add-phase" class="btn-secondary text-sm px-3 py-1.5">Add phase</button>
        <button type="button" id="event-add-milestone-top" class="btn-primary text-sm px-3 py-1.5">Add moment</button>
        <button type="button" id="entity-delete" class="btn-ghost text-sm text-red-700 hover:bg-red-50">Delete</button>
      </div>
    </header>

    ${
      e.place_name || e.place_url
        ? `<section class="mb-8 rounded-2xl bg-white border border-paper-line p-5 shadow-soft">
            <h2 class="text-xs uppercase tracking-wider text-ink-faint font-semibold mb-2">Place</h2>
            <p class="font-medium">${escapeHtml(e.place_name || "Location")}</p>
            ${
              e.place_url
                ? `<a href="${escapeHtml(e.place_url)}" target="_blank" rel="noopener" class="text-sm text-accent hover:underline break-all mt-1 inline-block">${escapeHtml(e.place_url)}</a>`
                : ""
            }
          </section>`
        : ""
    }

    ${mediaSectionHtml(attachments)}

    ${
      bodyHtml
        ? `<section class="mb-10 rounded-2xl bg-white border border-paper-line p-6 shadow-soft">
            <h2 class="text-xs uppercase tracking-wider text-ink-faint font-semibold mb-3">Notes</h2>
            <div class="prose-historia">${bodyHtml}</div>
          </section>`
        : ""
    }

    ${milestonesSectionHtml(milestones)}

    ${duringTimeSectionHtml(data.during_time)}

    ${
      phases.length
        ? `<section class="mb-8">
            <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
              <h2 class="font-display text-xl">Phases</h2>
              <button type="button" id="event-add-phase-section" class="btn-secondary text-sm px-3 py-1.5">Add phase</button>
            </div>
            <div class="space-y-2">
              ${phases
                .map((item) => {
                  const ent = item.entity;
                  const r = formatRange(ent.date_start, ent.date_end) || formatDate(ent.date_start);
                  return `
                  <a href="#/entity/${ent.id}" class="entity-row no-underline text-inherit">
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="font-medium">${escapeHtml(ent.title)}</span>
                        <span class="type-badge">Phase</span>
                        ${r ? `<span class="text-xs text-ink-faint">${escapeHtml(r)}</span>` : ""}
                      </div>
                      ${ent.summary ? `<p class="text-sm text-ink-muted mt-0.5 line-clamp-1">${escapeHtml(ent.summary)}</p>` : ""}
                    </div>
                  </a>`;
                })
                .join("")}
            </div>
          </section>`
        : `<section class="mb-8 rounded-2xl border border-dashed border-paper-line p-6">
            <p class="text-sm text-ink-muted mb-3">No phases linked yet.</p>
            <button type="button" id="event-add-phase-section" class="btn-primary text-sm px-3 py-1.5">Add phase</button>
          </section>`
    }

    ${
      otherGroups.length
        ? otherGroups
            .map((key) => {
              const items = related[key];
              return `
              <section class="mb-8">
                <h2 class="font-display text-xl mb-3">${groupTitle(key)}</h2>
                <div class="space-y-2">
                  ${items
                    .map((item) => {
                      const ent = item.entity;
                      const r = formatRange(ent.date_start, ent.date_end) || formatDate(ent.date_start);
                      return `
                      <a href="#/entity/${ent.id}" class="entity-row no-underline text-inherit">
                        <div class="flex-1 min-w-0">
                          <div class="flex items-center gap-2 flex-wrap">
                            <span class="font-medium">${escapeHtml(ent.title)}</span>
                            ${r ? `<span class="text-xs text-ink-faint">${escapeHtml(r)}</span>` : ""}
                          </div>
                          ${ent.summary ? `<p class="text-sm text-ink-muted mt-0.5 line-clamp-1">${escapeHtml(ent.summary)}</p>` : ""}
                        </div>
                      </a>`;
                    })
                    .join("")}
                </div>
              </section>`;
            })
            .join("")
        : ""
    }

    <section class="mb-8">
      <h2 class="font-display text-xl mb-3">Referenced by</h2>
      ${
        (data.backlinks || []).length === 0
          ? `<p class="text-sm text-ink-muted">Nothing links here yet.</p>`
          : `<div class="space-y-2">
              ${data.backlinks
                .map((item) => {
                  const ent = item.entity;
                  return `
                  <a href="#/entity/${ent.id}" class="entity-row no-underline text-inherit">
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="font-medium">${escapeHtml(ent.title)}</span>
                        <span class="type-badge">${typeLabel(ent.type)}</span>
                        <span class="text-[11px] text-ink-faint">${escapeHtml(relationLabel(item.relation))}</span>
                      </div>
                    </div>
                  </a>`;
                })
                .join("")}
            </div>`
      }
    </section>
  `;
}

function renderGenericHub(root, data, e, bodyHtml) {
  const isTopic = e.type === "topic";
  const isPeriod = e.type === "period";
  const isPhase = e.type === "phase";
  const backHref = isTopic
    ? "#/library?tab=topics"
    : isPeriod
      ? "#/library?tab=periods"
      : isPhase
        ? "#/library?tab=phases"
        : e.type === "place"
          ? "#/library?tab=countries"
          : "#/library";
  const backLabel = isTopic
    ? "Topics"
    : isPeriod
      ? "Periods"
      : isPhase
        ? "Phases"
        : e.type === "place"
          ? "Countries"
          : "Library";
  const range = formatRange(e.date_start, e.date_end) || formatDate(e.date_start);
  const related = { ...(data.related || {}) };
  const eventItems = related.event || [];
  const phaseItems = related.phase || [];
  if (isPeriod || isPhase) delete related.event;
  if (isPeriod) delete related.phase;
  const groups = groupList(related);
  const attachments = e.attachments || [];

  root.innerHTML = `
    <div class="mb-2">
      <a href="${backHref}" class="text-sm text-ink-muted hover:text-accent">← ${backLabel}</a>
    </div>

    <header class="mb-8">
      <div class="flex flex-wrap items-center gap-2 mb-2">
        <span class="type-badge">${typeLabel(e.type)}</span>
        ${range ? `<span class="text-sm text-ink-faint tabular-nums">${escapeHtml(range)}</span>` : ""}
      </div>
      <h1 class="font-display text-3xl sm:text-4xl tracking-tight">${escapeHtml(e.title)}</h1>
      ${e.summary ? `<p class="text-lg text-ink-muted mt-3 max-w-2xl">${escapeHtml(e.summary)}</p>` : ""}
      ${
        (e.tags || []).length
          ? `<div class="flex flex-wrap gap-2 mt-3">${(e.tags || [])
              .map(
                (t) =>
                  `<a href="#/library?tag=${encodeURIComponent(t)}" class="text-xs px-2 py-1 rounded-full bg-paper-deep text-ink-muted hover:text-accent">#${escapeHtml(t)}</a>`
              )
              .join("")}</div>`
          : ""
      }
      <div class="flex flex-wrap gap-2 mt-5">
        ${
          e.type === "event"
            ? `<button type="button" id="entity-edit" class="btn-secondary text-sm px-3 py-1.5">Edit</button>`
            : ""
        }
        ${
          isTopic
            ? `<button type="button" id="topic-add-event" class="btn-primary text-sm px-3 py-1.5">Add event</button>
               <button type="button" id="topic-add-phase" class="btn-secondary text-sm px-3 py-1.5">Add phase</button>
               <button type="button" id="topic-add-figure" class="btn-secondary text-sm px-3 py-1.5">Add figure</button>`
            : ""
        }
        ${
          isPeriod
            ? `<button type="button" id="period-edit" class="btn-secondary text-sm px-3 py-1.5">Edit period</button>
               <button type="button" id="period-add-phase" class="btn-secondary text-sm px-3 py-1.5">Add phase</button>
               <button type="button" id="period-add-event" class="btn-primary text-sm px-3 py-1.5">Add event</button>`
            : ""
        }
        ${
          isPhase
            ? `<button type="button" id="phase-edit" class="btn-secondary text-sm px-3 py-1.5">Edit phase</button>
               <button type="button" id="phase-add-event" class="btn-primary text-sm px-3 py-1.5">Add event</button>`
            : ""
        }
        <button type="button" id="entity-delete" class="btn-ghost text-sm text-red-700 hover:bg-red-50">Delete</button>
      </div>
    </header>

    ${
      e.place_name || e.place_url
        ? `<section class="mb-8 rounded-2xl bg-white border border-paper-line p-5 shadow-soft">
            <h2 class="text-xs uppercase tracking-wider text-ink-faint font-semibold mb-2">Place</h2>
            <p class="font-medium">${escapeHtml(e.place_name || "Location")}</p>
            ${
              e.place_url
                ? `<a href="${escapeHtml(e.place_url)}" target="_blank" rel="noopener" class="text-sm text-accent hover:underline break-all mt-1 inline-block">${escapeHtml(e.place_url)}</a>`
                : ""
            }
          </section>`
        : ""
    }

    ${mediaSectionHtml(attachments)}

    ${
      bodyHtml
        ? `<section class="mb-10 rounded-2xl bg-white border border-paper-line p-6 shadow-soft">
            <h2 class="text-xs uppercase tracking-wider text-ink-faint font-semibold mb-3">Notes</h2>
            <div class="prose-historia">${bodyHtml}</div>
          </section>`
        : ""
    }

    ${
      isPeriod
        ? phaseItems.length
          ? `<section class="mb-8">
              <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
                <h2 class="font-display text-xl">Phases in this period</h2>
                <button type="button" id="period-add-phase-section" class="btn-secondary text-sm px-3 py-1.5">Add phase</button>
              </div>
              <div class="space-y-2">
                ${phaseItems
                  .map((item) => {
                    const ent = item.entity;
                    const r = formatRange(ent.date_start, ent.date_end) || formatDate(ent.date_start);
                    return `
                    <a href="#/entity/${ent.id}" class="entity-row no-underline text-inherit">
                      <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2 flex-wrap">
                          <span class="font-medium">${escapeHtml(ent.title)}</span>
                          <span class="type-badge">Phase</span>
                          ${r ? `<span class="text-xs text-ink-faint">${escapeHtml(r)}</span>` : ""}
                        </div>
                        ${ent.summary ? `<p class="text-sm text-ink-muted mt-0.5 line-clamp-1">${escapeHtml(ent.summary)}</p>` : ""}
                      </div>
                    </a>`;
                  })
                  .join("")}
              </div>
            </section>`
          : `<section class="mb-8 rounded-2xl border border-dashed border-paper-line p-6">
              <p class="text-sm text-ink-muted mb-3">No phases in this period yet.</p>
              <button type="button" id="period-add-phase-section" class="btn-primary text-sm px-3 py-1.5">Add phase</button>
            </section>`
        : ""
    }

    ${
      isPeriod || isPhase
        ? eventItems.length
          ? `<section class="mb-8">
              <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
                <h2 class="font-display text-xl">${isPhase ? "Events in this phase" : "Events in this period"}</h2>
                <button type="button" id="${isPhase ? "phase-add-event-section" : "period-add-event-section"}" class="btn-secondary text-sm px-3 py-1.5">Add event</button>
              </div>
              <div class="space-y-2">
                ${eventItems
                  .map((item) => {
                    const ent = item.entity;
                    const r = formatRange(ent.date_start, ent.date_end) || formatDate(ent.date_start);
                    return `
                    <a href="#/entity/${ent.id}" class="entity-row no-underline text-inherit">
                      <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2 flex-wrap">
                          <span class="font-medium">${escapeHtml(ent.title)}</span>
                          ${r ? `<span class="text-xs text-ink-faint">${escapeHtml(r)}</span>` : ""}
                        </div>
                        ${ent.summary ? `<p class="text-sm text-ink-muted mt-0.5 line-clamp-1">${escapeHtml(ent.summary)}</p>` : ""}
                      </div>
                    </a>`;
                  })
                  .join("")}
              </div>
            </section>`
          : `<section class="mb-8 rounded-2xl border border-dashed border-paper-line p-6">
              <p class="text-sm text-ink-muted mb-3">No events in this ${isPhase ? "phase" : "period"} yet.</p>
              <button type="button" id="${isPhase ? "phase-add-event-section" : "period-add-event-section"}" class="btn-primary text-sm px-3 py-1.5">Add event</button>
            </section>`
        : groups.length
          ? groups
              .map((key) => {
                const items = data.related[key];
                const title = groupTitle(key, {
                  ...(isTopic
                    ? {
                        event: "Events in this topic",
                        phase: "Phases in this topic",
                        figure: "Figures in this topic",
                      }
                    : {}),
                });
                return `
              <section class="mb-8">
                <h2 class="font-display text-xl mb-3">${title}</h2>
                <div class="space-y-2">
                  ${items
                    .map((item) => {
                      const ent = item.entity;
                      const r = formatDate(ent.date_start);
                      return `
                      <a href="#/entity/${ent.id}" class="entity-row no-underline text-inherit">
                        <div class="flex-1 min-w-0">
                          <div class="flex items-center gap-2 flex-wrap">
                            <span class="font-medium">${escapeHtml(ent.title)}</span>
                            ${r ? `<span class="text-xs text-ink-faint">${escapeHtml(r)}</span>` : ""}
                          </div>
                          ${ent.summary ? `<p class="text-sm text-ink-muted mt-0.5 line-clamp-1">${escapeHtml(ent.summary)}</p>` : ""}
                        </div>
                      </a>`;
                    })
                    .join("")}
                </div>
              </section>`;
              })
              .join("")
          : isTopic
            ? `<section class="mb-8 rounded-2xl border border-dashed border-paper-line p-6 text-sm text-ink-muted space-y-3">
              <p>No events, phases, or figures in this topic yet.</p>
              <div class="flex flex-wrap gap-2">
                <button type="button" id="topic-add-event-empty" class="btn-primary text-sm px-3 py-1.5">Add event</button>
                <button type="button" id="topic-add-phase-empty" class="btn-secondary text-sm px-3 py-1.5">Add phase</button>
                <button type="button" id="topic-add-figure-empty" class="btn-secondary text-sm px-3 py-1.5">Add figure</button>
              </div>
            </section>`
            : `<section class="mb-8 rounded-2xl border border-dashed border-paper-line p-6 text-sm text-ink-muted">
              No related events yet. Use <strong>@</strong> when adding an event to link others.
            </section>`
    }

    ${duringTimeSectionHtml(data.during_time)}

    ${
      isPeriod || isPhase
        ? groups
            .map((key) => {
              const items = related[key];
              return `
              <section class="mb-8">
                <h2 class="font-display text-xl mb-3">${groupTitle(key)}</h2>
                <div class="space-y-2">
                  ${items
                    .map((item) => {
                      const ent = item.entity;
                      return `
                      <a href="#/entity/${ent.id}" class="entity-row no-underline text-inherit">
                        <div class="flex-1 min-w-0">
                          <div class="flex items-center gap-2 flex-wrap">
                            <span class="font-medium">${escapeHtml(ent.title)}</span>
                            <span class="type-badge">${typeLabel(ent.type)}</span>
                          </div>
                        </div>
                      </a>`;
                    })
                    .join("")}
                </div>
              </section>`;
            })
            .join("")
        : ""
    }

    <section class="mb-8">
      <h2 class="font-display text-xl mb-3">Referenced by</h2>
      ${
        (data.backlinks || []).length === 0
          ? `<p class="text-sm text-ink-muted">Nothing links here yet.</p>`
          : `<div class="space-y-2">
              ${data.backlinks
                .map((item) => {
                  const ent = item.entity;
                  return `
                  <a href="#/entity/${ent.id}" class="entity-row no-underline text-inherit">
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="font-medium">${escapeHtml(ent.title)}</span>
                        <span class="type-badge">${typeLabel(ent.type)}</span>
                        <span class="text-[11px] text-ink-faint">${escapeHtml(relationLabel(item.relation))}</span>
                      </div>
                    </div>
                  </a>`;
                })
                .join("")}
            </div>`
      }
    </section>
  `;
}

function renderFigureBiography(root, data, e, bodyHtml) {
  const lifeRange = formatRange(e.date_start, e.date_end) || formatDate(e.date_start);
  const reignRange = formatRange(e.reign_start, e.reign_end) || formatDate(e.reign_start);
  const lifeEvents = data.life_events || [];
  const related = { ...(data.related || {}) };
  // Events are shown in life story; hide duplicate event group
  delete related.event;
  delete related.place;
  const otherGroups = groupList(related);

  root.innerHTML = `
    <div class="mb-2">
      <a href="#/library?tab=figures" class="text-sm text-ink-muted hover:text-accent">← Figures</a>
    </div>

    <header class="mb-8">
      <div class="flex flex-wrap items-center gap-2 mb-2">
        <span class="type-badge">Biography</span>
        ${lifeRange ? `<span class="text-sm text-ink-faint tabular-nums">Life · ${escapeHtml(lifeRange)}</span>` : ""}
        ${reignRange ? `<span class="text-sm text-ink-faint tabular-nums">Ruled · ${escapeHtml(reignRange)}</span>` : ""}
        ${e.category ? `<span class="type-badge">${escapeHtml(e.category)}</span>` : ""}
      </div>
      <h1 class="font-display text-3xl sm:text-4xl tracking-tight">${escapeHtml(e.title)}</h1>
      ${e.place_name ? `<p class="text-sm text-ink-muted mt-2">${escapeHtml(e.place_name)}</p>` : ""}
      ${e.summary ? `<p class="text-lg text-ink-muted mt-3 max-w-2xl">${escapeHtml(e.summary)}</p>` : `<p class="text-sm text-ink-faint mt-3">Add a short bio to introduce this figure.</p>`}
      ${
        (e.tags || []).length
          ? `<div class="flex flex-wrap gap-2 mt-3">${(e.tags || [])
              .map(
                (t) =>
                  `<a href="#/library?tag=${encodeURIComponent(t)}" class="text-xs px-2 py-1 rounded-full bg-paper-deep text-ink-muted hover:text-accent">#${escapeHtml(t)}</a>`
              )
              .join("")}</div>`
          : ""
      }
      <div class="flex flex-wrap gap-2 mt-5">
        <button type="button" id="figure-edit" class="btn-secondary text-sm px-3 py-1.5">Edit</button>
        <button type="button" id="figure-add-moment-top" class="btn-primary text-sm px-3 py-1.5">Add event</button>
        <button type="button" id="entity-delete" class="btn-ghost text-sm text-red-700 hover:bg-red-50">Delete</button>
      </div>
    </header>

    ${
      bodyHtml
        ? `<section class="mb-10 rounded-2xl bg-white border border-paper-line p-6 shadow-soft">
            <h2 class="text-xs uppercase tracking-wider text-ink-faint font-semibold mb-3">Biography</h2>
            <div class="prose-historia">${bodyHtml}</div>
          </section>`
        : ""
    }

    ${mediaSectionHtml(e.attachments || [])}

    ${lifeTimelineHtml(e, lifeEvents)}

    ${duringTimeSectionHtml(data.during_time)}

    ${
      otherGroups.length
        ? otherGroups
            .map((key) => {
              const items = related[key];
              return `
              <section class="mb-8">
                <h2 class="font-display text-xl mb-3">${groupTitle(key, { figure: "Related people" })}</h2>
                <div class="space-y-2">
                  ${items
                    .map((item) => {
                      const ent = item.entity;
                      const role = item.role ? String(item.role) : "";
                      return `
                      <a href="#/entity/${ent.id}" class="entity-row no-underline text-inherit">
                        <div class="flex-1 min-w-0">
                          <div class="flex items-center gap-2 flex-wrap">
                            <span class="font-medium">${escapeHtml(ent.title)}</span>
                            ${
                              role
                                ? `<span class="text-[11px] px-2 py-0.5 rounded-full bg-paper-deep text-ink-muted">${escapeHtml(role)}</span>`
                                : ""
                            }
                          </div>
                          ${ent.summary ? `<p class="text-sm text-ink-muted mt-0.5 line-clamp-1">${escapeHtml(ent.summary)}</p>` : ""}
                        </div>
                      </a>`;
                    })
                    .join("")}
                </div>
              </section>`;
            })
            .join("")
        : ""
    }
  `;
}

function bindLifeMoment(figure) {
  const open = () => {
    openQuickAdd({
      preselectFigures: [figure],
      onSaved: (saved) => {
        location.hash = `/entity/${figure.id}`;
        window.dispatchEvent(new HashChangeEvent("hashchange"));
        if (saved?.id) toast(`Added to ${figure.title}’s life story`);
      },
    }).catch((err) => {
      console.error(err);
      toast(err.message || "Could not open Add event");
    });
  };
  document.getElementById("figure-add-moment")?.addEventListener("click", open);
  document.getElementById("figure-add-moment-top")?.addEventListener("click", open);
}

function bindPeriodAddEvent(period) {
  const open = () => {
    openQuickAdd({
      preselectPeriod: period,
      onSaved: (saved) => {
        location.hash = `/entity/${period.id}`;
        window.dispatchEvent(new HashChangeEvent("hashchange"));
        if (saved?.id) toast(`Added to ${period.title}`);
      },
    }).catch((err) => {
      console.error(err);
      toast(err.message || "Could not open Add event");
    });
  };
  document.getElementById("period-add-event")?.addEventListener("click", open);
  document.getElementById("period-add-event-section")?.addEventListener("click", open);
}

function bindPeriodAddPhase(period) {
  const open = () => {
    openAddPhase({
      preselectPeriod: period,
      onSaved: (saved) => {
        location.hash = `/entity/${period.id}`;
        window.dispatchEvent(new HashChangeEvent("hashchange"));
        if (saved?.id) toast(`Phase added to ${period.title}`);
      },
    }).catch((err) => {
      console.error(err);
      toast(err.message || "Could not open Add phase");
    });
  };
  document.getElementById("period-add-phase")?.addEventListener("click", open);
  document.getElementById("period-add-phase-section")?.addEventListener("click", open);
}

function bindEventAddPhase(event) {
  const open = () => {
    openAddPhase({
      linkEvent: event,
      onSaved: (saved) => {
        location.hash = `/entity/${event.id}`;
        window.dispatchEvent(new HashChangeEvent("hashchange"));
        if (saved?.id) toast(`Phase linked to ${event.title}`);
      },
    }).catch((err) => {
      console.error(err);
      toast(err.message || "Could not open Add phase");
    });
  };
  document.getElementById("event-add-phase")?.addEventListener("click", open);
  document.getElementById("event-add-phase-section")?.addEventListener("click", open);
}

function bindPhaseAddEvent(phase) {
  const open = () => {
    openQuickAdd({
      preselectPhase: phase,
      onSaved: (saved) => {
        location.hash = `/entity/${phase.id}`;
        window.dispatchEvent(new HashChangeEvent("hashchange"));
        if (saved?.id) toast(`Added to ${phase.title}`);
      },
    }).catch((err) => {
      console.error(err);
      toast(err.message || "Could not open Add event");
    });
  };
  document.getElementById("phase-add-event")?.addEventListener("click", open);
  document.getElementById("phase-add-event-section")?.addEventListener("click", open);
}

export async function renderEntity(root, { params }) {
  const data = await api.neighbors(params.id);
  const e = data.entity;

  let bodyHtml = "";
  if (e.body) {
    const md = await api.renderMarkdown(e.body);
    bodyHtml = md.html;
  }

  if (e.type === "figure") {
    renderFigureBiography(root, data, e, bodyHtml);
  } else if (e.type === "event") {
    renderEventDetail(root, data, e, bodyHtml);
  } else {
    renderGenericHub(root, data, e, bodyHtml);
  }

  document.getElementById("entity-edit")?.addEventListener("click", () => {
    openEditEvent(e.id, {
      onSaved: () => {
        location.hash = `/entity/${e.id}`;
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      },
    });
  });

  document.getElementById("figure-edit")?.addEventListener("click", () => {
    openEditFigure(e, {
      onSaved: () => {
        location.hash = `/entity/${e.id}`;
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      },
    });
  });

  document.getElementById("period-edit")?.addEventListener("click", () => {
    openEditPeriod(e, {
      onSaved: () => {
        location.hash = `/entity/${e.id}`;
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      },
    });
  });

  document.getElementById("phase-edit")?.addEventListener("click", () => {
    openEditPhase(e, {
      onSaved: () => {
        location.hash = `/entity/${e.id}`;
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      },
    });
  });

  if (e.type === "figure") {
    bindLifeMoment(e);
  }

  if (e.type === "period") {
    bindPeriodAddEvent(e);
    bindPeriodAddPhase(e);
  }

  if (e.type === "phase") {
    bindPhaseAddEvent(e);
  }

  if (e.type === "topic") {
    const refresh = () => {
      location.hash = `/entity/${e.id}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    };
    const addEvent = () => openAddToTopic(e, { kind: "event", onSaved: refresh });
    const addPhase = () => openAddToTopic(e, { kind: "phase", onSaved: refresh });
    const addFigure = () => openAddToTopic(e, { kind: "figure", onSaved: refresh });
    document.getElementById("topic-add-event")?.addEventListener("click", addEvent);
    document.getElementById("topic-add-phase")?.addEventListener("click", addPhase);
    document.getElementById("topic-add-figure")?.addEventListener("click", addFigure);
    document.getElementById("topic-add-event-empty")?.addEventListener("click", addEvent);
    document.getElementById("topic-add-phase-empty")?.addEventListener("click", addPhase);
    document.getElementById("topic-add-figure-empty")?.addEventListener("click", addFigure);
  }

  if (e.type === "event") {
    bindEventAddPhase(e);
    const openMs = () => {
      openAddMilestone(e, {
        onSaved: () => {
          location.hash = `/entity/${e.id}`;
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        },
      });
    };
    document.getElementById("event-add-milestone")?.addEventListener("click", openMs);
    document.getElementById("event-add-milestone-top")?.addEventListener("click", openMs);
  }

  document.getElementById("entity-delete")?.addEventListener("click", async () => {
    if (!confirm(`Delete “${e.title}”? This removes its links too.`)) return;
    try {
      await api.deleteEntity(e.id);
      toast("Deleted");
      const tab =
        e.type === "topic"
          ? "topics"
          : e.type === "figure"
            ? "figures"
            : e.type === "period"
              ? "periods"
              : e.type === "phase"
                ? "phases"
                : e.type === "place"
                  ? "countries"
                  : null;
      location.hash = tab ? `/library?tab=${tab}` : "/library";
    } catch (err) {
      toast(err.message || "Delete failed");
    }
  });
}
