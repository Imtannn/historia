/** Quick-add / edit entity modal. */

import { api } from "./api.js";
import { escapeHtml, toast, typeLabel } from "./util.js";

const TYPES = ["event", "place", "figure", "period", "milestone", "timeline"];
const RELATIONS = ["occurred_in", "involves", "part_of", "preceded_by", "related_to"];

let allEntities = [];
let selectedLinks = new Map(); // id -> entity

function closeModal() {
  document.getElementById("modal-root").classList.add("hidden");
  document.getElementById("modal-panel").innerHTML = "";
  selectedLinks = new Map();
}

function openModal() {
  document.getElementById("modal-root").classList.remove("hidden");
}

function renderLinkChips() {
  const box = document.getElementById("link-chips");
  if (!box) return;
  if (selectedLinks.size === 0) {
    box.innerHTML = `<span class="text-xs text-ink-faint">No links yet</span>`;
    return;
  }
  box.innerHTML = [...selectedLinks.values()]
    .map(
      (e) => `
      <button type="button" data-unlink="${e.id}" class="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-accent-soft text-accent-dark text-xs font-medium">
        ${escapeHtml(e.title)}
        <span aria-hidden="true">×</span>
      </button>`
    )
    .join("");
  box.querySelectorAll("[data-unlink]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedLinks.delete(btn.dataset.unlink);
      renderLinkChips();
    });
  });
}

function renderSearchResults(query) {
  const box = document.getElementById("link-results");
  if (!box) return;
  const q = (query || "").toLowerCase().trim();
  if (!q) {
    box.innerHTML = "";
    return;
  }
  const hits = allEntities
    .filter((e) => !selectedLinks.has(e.id))
    .filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        (e.summary || "").toLowerCase().includes(q) ||
        (e.tags || []).some((t) => t.toLowerCase().includes(q))
    )
    .slice(0, 8);
  if (!hits.length) {
    box.innerHTML = `<p class="text-xs text-ink-faint px-1 py-2">No matches</p>`;
    return;
  }
  box.innerHTML = hits
    .map(
      (e) => `
    <button type="button" data-pick="${e.id}" class="w-full text-left px-2 py-1.5 rounded-lg hover:bg-paper-deep text-sm flex justify-between gap-2">
      <span>${escapeHtml(e.title)}</span>
      <span class="type-badge shrink-0">${typeLabel(e.type)}</span>
    </button>`
    )
    .join("");
  box.querySelectorAll("[data-pick]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ent = allEntities.find((x) => x.id === btn.dataset.pick);
      if (ent) {
        selectedLinks.set(ent.id, ent);
        document.getElementById("link-search").value = "";
        renderLinkChips();
        renderSearchResults("");
      }
    });
  });
}

export async function openQuickAdd({ onSaved } = {}) {
  allEntities = await api.listEntities();
  selectedLinks = new Map();
  const panel = document.getElementById("modal-panel");
  panel.innerHTML = `
    <div class="flex items-start justify-between mb-4">
      <div>
        <h2 class="font-display text-xl">Add entry</h2>
        <p class="text-sm text-ink-muted mt-0.5">One place for any type of history note.</p>
      </div>
      <button type="button" class="btn-ghost text-lg leading-none" data-close-modal aria-label="Close">×</button>
    </div>
    <form id="quick-add-form" class="space-y-4">
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="label" for="qa-type">Type</label>
          <select id="qa-type" class="select" required>
            ${TYPES.map((t) => `<option value="${t}">${typeLabel(t)}</option>`).join("")}
          </select>
        </div>
        <div>
          <label class="label" for="qa-relation">Link as</label>
          <select id="qa-relation" class="select">
            ${RELATIONS.map((r) => `<option value="${r}">${r.replace(/_/g, " ")}</option>`).join("")}
          </select>
        </div>
      </div>
      <div>
        <label class="label" for="qa-title">Title</label>
        <input id="qa-title" class="input" required maxlength="500" placeholder="e.g. Battle of Waterloo" />
      </div>
      <div>
        <label class="label" for="qa-summary">Summary</label>
        <input id="qa-summary" class="input" maxlength="2000" placeholder="Short description for cards" />
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="label" for="qa-start">Start date</label>
          <input id="qa-start" class="input" placeholder="1815 or -0044" />
        </div>
        <div>
          <label class="label" for="qa-end">End date</label>
          <input id="qa-end" class="input" placeholder="optional" />
        </div>
      </div>
      <div>
        <label class="label" for="qa-tags">Tags</label>
        <input id="qa-tags" class="input" placeholder="comma-separated, e.g. europe, war" />
      </div>
      <div>
        <label class="label" for="qa-parent">Parent (optional)</label>
        <select id="qa-parent" class="select">
          <option value="">— none —</option>
          ${allEntities
            .map((e) => `<option value="${e.id}">${escapeHtml(e.title)} (${typeLabel(e.type)})</option>`)
            .join("")}
        </select>
      </div>
      <div>
        <label class="label" for="link-search">Link to existing</label>
        <input id="link-search" class="input" placeholder="Search entities…" autocomplete="off" />
        <div id="link-results" class="mt-1 max-h-36 overflow-y-auto"></div>
        <div id="link-chips" class="flex flex-wrap gap-1.5 mt-2"></div>
      </div>
      <div>
        <label class="label" for="qa-body">Notes (markdown)</label>
        <textarea id="qa-body" class="textarea" placeholder="Longer notes…"></textarea>
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" class="btn-ghost" data-close-modal>Cancel</button>
        <button type="submit" class="btn-primary px-4 py-2">Save</button>
      </div>
    </form>
  `;
  renderLinkChips();
  openModal();

  document.getElementById("link-search").addEventListener("input", (e) => {
    renderSearchResults(e.target.value);
  });

  document.getElementById("quick-add-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const tags = document
      .getElementById("qa-tags")
      .value.split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const body = {
      type: document.getElementById("qa-type").value,
      title: document.getElementById("qa-title").value.trim(),
      summary: document.getElementById("qa-summary").value.trim() || null,
      body: document.getElementById("qa-body").value.trim() || null,
      date_start: document.getElementById("qa-start").value.trim() || null,
      date_end: document.getElementById("qa-end").value.trim() || null,
      parent_id: document.getElementById("qa-parent").value || null,
      tags,
      link_ids: [...selectedLinks.keys()],
      link_relation: document.getElementById("qa-relation").value,
    };
    try {
      const created = await api.createEntity(body);
      toast(`Added “${created.title}”`);
      closeModal();
      if (onSaved) onSaved(created);
    } catch (err) {
      toast(err.message || "Could not save");
    }
  });
}

export function bindModalChrome() {
  document.getElementById("modal-root").addEventListener("click", (e) => {
    if (e.target.matches("[data-close-modal]")) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
}

export { closeModal };
