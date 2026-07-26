/** Entity hub page — related groups, backlinks, markdown body. */

import { api } from "../api.js";
import { escapeHtml, formatRange, relationLabel, typeLabel, toast } from "../util.js";

const GROUP_ORDER = ["event", "figure", "period", "milestone", "place", "timeline"];
const GROUP_TITLES = {
  event: "Events",
  figure: "Figures",
  period: "Periods",
  milestone: "Milestones",
  place: "Places & cities",
  timeline: "Timelines",
};

function groupList(related) {
  const keys = [
    ...GROUP_ORDER.filter((k) => related[k]?.length),
    ...Object.keys(related).filter((k) => !GROUP_ORDER.includes(k) && related[k]?.length),
  ];
  return keys;
}

export async function renderEntity(root, { params }) {
  const data = await api.neighbors(params.id);
  const e = data.entity;
  const range = formatRange(e.date_start, e.date_end);

  let bodyHtml = "";
  if (e.body) {
    const md = await api.renderMarkdown(e.body);
    bodyHtml = md.html;
  }

  const groups = groupList(data.related || {});

  root.innerHTML = `
    <div class="mb-2">
      <a href="#/library" class="text-sm text-ink-muted hover:text-accent">← Library</a>
    </div>

    <header class="mb-8">
      <div class="flex flex-wrap items-center gap-2 mb-2">
        <span class="type-badge">${typeLabel(e.type)}</span>
        ${range ? `<span class="text-sm text-ink-faint">${escapeHtml(range)}</span>` : ""}
        ${
          data.parent
            ? `<a href="#/entity/${data.parent.id}" class="text-sm text-accent hover:underline">in ${escapeHtml(data.parent.title)}</a>`
            : ""
        }
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
        <button type="button" id="entity-delete" class="btn-ghost text-sm text-red-700 hover:bg-red-50">Delete</button>
      </div>
    </header>

    ${
      bodyHtml
        ? `<section class="mb-10 rounded-2xl bg-white border border-paper-line p-6 shadow-soft">
            <h2 class="text-xs uppercase tracking-wider text-ink-faint font-semibold mb-3">Notes</h2>
            <div class="prose-historia">${bodyHtml}</div>
          </section>`
        : ""
    }

    ${
      groups.length
        ? groups
            .map((key) => {
              const items = data.related[key];
              return `
              <section class="mb-8">
                <h2 class="font-display text-xl mb-3">${GROUP_TITLES[key] || typeLabel(key)}</h2>
                <div class="space-y-2">
                  ${items
                    .map((item) => {
                      const ent = item.entity;
                      const r = formatRange(ent.date_start, ent.date_end);
                      return `
                      <a href="#/entity/${ent.id}" class="entity-row no-underline text-inherit">
                        <div class="flex-1 min-w-0">
                          <div class="flex items-center gap-2 flex-wrap">
                            <span class="font-medium">${escapeHtml(ent.title)}</span>
                            <span class="text-[11px] text-ink-faint">${escapeHtml(relationLabel(item.relation))}</span>
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
        : `<section class="mb-8 rounded-2xl border border-dashed border-paper-line p-6 text-sm text-ink-muted">
            No outgoing links yet. Add related entries via <strong>+ Add</strong> and link them here.
          </section>`
    }

    <section class="mb-8">
      <h2 class="font-display text-xl mb-3">Referenced by</h2>
      ${
        (data.backlinks || []).length === 0
          ? `<p class="text-sm text-ink-muted">Nothing links here yet — backlinks appear automatically.</p>`
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

  document.getElementById("entity-delete").addEventListener("click", async () => {
    if (!confirm(`Delete “${e.title}”? This removes its links too.`)) return;
    try {
      await api.deleteEntity(e.id);
      toast("Deleted");
      location.hash = "/library";
    } catch (err) {
      toast(err.message || "Delete failed");
    }
  });
}
