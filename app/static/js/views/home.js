/** Placeholder / home stub until gamification lands. */

import { api } from "../api.js";
import { escapeHtml, formatRange, typeLabel } from "../util.js";

export async function renderHome(root) {
  let entities = [];
  try {
    entities = await api.listEntities();
  } catch {
    entities = [];
  }
  const recent = [...entities]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 5);

  root.innerHTML = `
    <div class="mb-8">
      <h1 class="font-display text-3xl sm:text-4xl tracking-tight">Welcome back</h1>
      <p class="text-ink-muted mt-2 max-w-xl">Organize history once — then learn it with flashcards and quizzes that stay in sync.</p>
    </div>

    <div class="grid sm:grid-cols-3 gap-4 mb-10">
      <div class="rounded-2xl bg-white border border-paper-line p-5 shadow-soft">
        <p class="text-xs uppercase tracking-wider text-ink-faint font-semibold">Entries</p>
        <p class="font-display text-3xl mt-1 tabular-nums">${entities.length}</p>
      </div>
      <a href="#/flashcards" class="rounded-2xl bg-accent text-white p-5 shadow-soft hover:bg-accent-dark transition-colors no-underline">
        <p class="text-xs uppercase tracking-wider text-white/70 font-semibold">Learn</p>
        <p class="font-display text-xl mt-1">Review now →</p>
      </a>
      <a href="#/library" class="rounded-2xl bg-accent-soft text-accent-dark p-5 hover:bg-[#E8CDB8] transition-colors no-underline">
        <p class="text-xs uppercase tracking-wider opacity-70 font-semibold">Browse</p>
        <p class="font-display text-xl mt-1">Open library →</p>
      </a>
    </div>

    <section>
      <h2 class="font-display text-xl mb-3">Recently added</h2>
      ${
        recent.length === 0
          ? `<div class="rounded-2xl border border-dashed border-paper-line p-8 text-center text-ink-muted text-sm">
              Nothing here yet. Hit <strong class="text-ink">+ Add</strong> or load the sample set in Settings.
            </div>`
          : `<div class="space-y-2">
              ${recent
                .map((e) => {
                  const range = formatRange(e.date_start, e.date_end);
                  return `<a href="#/entity/${e.id}" class="entity-row no-underline text-inherit">
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="font-medium">${escapeHtml(e.title)}</span>
                        <span class="type-badge">${typeLabel(e.type)}</span>
                        ${range ? `<span class="text-xs text-ink-faint">${escapeHtml(range)}</span>` : ""}
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
