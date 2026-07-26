/** Dashboard — streak, XP ring, review CTA, weakest topics. */

import { api } from "../api.js";
import { escapeHtml, formatRange, typeLabel } from "../util.js";
import { syncProgressChrome } from "../progress-ui.js";

function goalRing(progress) {
  const pct = Math.min(100, Math.round((progress.xp_today / Math.max(progress.daily_goal_xp, 1)) * 100));
  const r = 54;
  const c = 2 * Math.PI * r;
  const offset = c - (pct / 100) * c;
  return `
    <div class="goal-ring-wrap">
      <svg class="w-full h-full" viewBox="0 0 120 120" aria-hidden="true">
        <circle cx="60" cy="60" r="${r}" fill="none" stroke="#E7E0D6" stroke-width="10" />
        <circle cx="60" cy="60" r="${r}" fill="none" stroke="#C45C26" stroke-width="10"
          stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${offset}"
          style="transition: stroke-dashoffset 0.6s ease" />
      </svg>
      <div class="goal-ring-label">
        <span class="font-display text-2xl tabular-nums text-ink">${progress.xp_today}</span>
        <span class="text-[11px] text-ink-faint">/ ${progress.daily_goal_xp} XP</span>
      </div>
    </div>
    <p class="text-center text-sm text-ink-muted mt-2">${pct}% of today's goal</p>
  `;
}

export async function renderHome(root) {
  const data = await api.dashboard();
  const p = data.progress;
  syncProgressChrome(p);

  root.innerHTML = `
    <div class="mb-8">
      <h1 class="font-display text-3xl sm:text-4xl tracking-tight">Historia</h1>
      <p class="text-ink-muted mt-2 max-w-xl">Organize once. Learn every day.</p>
    </div>

    <div class="grid lg:grid-cols-3 gap-6 mb-10">
      <div class="rounded-2xl bg-white border border-paper-line p-6 shadow-soft text-center">
        ${goalRing(p)}
        ${p.goal_hit_today ? `<p class="text-sm text-green-700 font-medium mt-2">Goal complete — nice work!</p>` : ""}
      </div>

      <div class="rounded-2xl bg-white border border-paper-line p-6 shadow-soft flex flex-col justify-center">
        <p class="text-xs uppercase tracking-wider text-ink-faint font-semibold">Streak</p>
        <p class="font-display text-4xl mt-2"><span aria-hidden="true">🔥</span> ${p.streak_current}</p>
        <p class="text-sm text-ink-muted mt-1">Longest: ${p.streak_longest} days</p>
        <p class="text-sm text-ink-faint mt-4">Total XP: <span class="tabular-nums text-ink font-medium">${p.xp}</span></p>
      </div>

      <a href="#/flashcards" class="rounded-2xl bg-accent text-white p-6 shadow-soft hover:bg-accent-dark transition-colors no-underline flex flex-col justify-center">
        <p class="text-xs uppercase tracking-wider text-white/70 font-semibold">Learn</p>
        <p class="font-display text-2xl mt-2">Review now</p>
        <p class="text-sm text-white/80 mt-2">${data.entity_count} entries ready to practice</p>
      </a>
    </div>

    <div class="grid sm:grid-cols-2 gap-8">
      <section>
        <div class="flex items-baseline justify-between mb-3">
          <h2 class="font-display text-xl">Recently added</h2>
          <a href="#/library" class="text-sm text-accent hover:underline">Library</a>
        </div>
        ${
          data.recent.length === 0
            ? `<div class="rounded-2xl border border-dashed border-paper-line p-6 text-sm text-ink-muted text-center">
                Empty for now. <a href="#/settings" class="text-accent underline">Load sample set</a> or hit + Add.
              </div>`
            : `<div class="space-y-2">
                ${data.recent
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

      <section>
        <div class="flex items-baseline justify-between mb-3">
          <h2 class="font-display text-xl">Weakest topics</h2>
          <a href="#/quiz" class="text-sm text-accent hover:underline">Quiz</a>
        </div>
        ${
          data.weakest.length === 0
            ? `<p class="text-sm text-ink-muted">Add entries to see mastery here.</p>`
            : `<div class="space-y-2">
                ${data.weakest
                  .map((w) => {
                    const e = w.entity;
                    return `<a href="#/entity/${e.id}" class="entity-row no-underline text-inherit">
                      <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2">
                          <span class="font-medium truncate">${escapeHtml(e.title)}</span>
                          <span class="type-badge">${typeLabel(e.type)}</span>
                        </div>
                      </div>
                      <div class="text-right shrink-0">
                        <p class="text-sm font-semibold tabular-nums text-accent">${Math.round(w.mastery)}%</p>
                        <p class="text-[11px] text-ink-faint">${w.times_seen} seen</p>
                      </div>
                    </a>`;
                  })
                  .join("")}
              </div>`
        }
      </section>
    </div>
  `;
}
