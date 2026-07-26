/** Short Add Event modal — title, flexible date + BC/AC, @links, tags, place, file links. */

import { api } from "./api.js";
import { composeDate, escapeHtml, normalizeTag, toast } from "./util.js";

let allEvents = [];
let selectedLinks = new Map(); // id -> event
let attachments = [];

function closeModal() {
  document.getElementById("modal-root").classList.add("hidden");
  document.getElementById("modal-panel").innerHTML = "";
  selectedLinks = new Map();
  attachments = [];
}

function openModal() {
  document.getElementById("modal-root").classList.remove("hidden");
}

function renderLinkChips() {
  const box = document.getElementById("link-chips");
  if (!box) return;
  if (selectedLinks.size === 0) {
    box.innerHTML = `<span class="text-xs text-ink-faint">No related events yet</span>`;
    return;
  }
  box.innerHTML = [...selectedLinks.values()]
    .map(
      (e) => `
      <button type="button" data-unlink="${e.id}" class="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-accent-soft text-accent-dark text-xs font-medium">
        @${escapeHtml(e.title)}
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

function renderAtResults(query) {
  const box = document.getElementById("at-results");
  if (!box) return;
  let q = (query || "").trim();
  if (q.startsWith("@")) q = q.slice(1);
  q = q.toLowerCase();
  if (!q) {
    box.innerHTML = "";
    return;
  }
  const hits = allEvents
    .filter((e) => !selectedLinks.has(e.id))
    .filter((e) => e.title.toLowerCase().includes(q) || (e.summary || "").toLowerCase().includes(q))
    .slice(0, 8);
  if (!hits.length) {
    box.innerHTML = `<p class="text-xs text-ink-faint px-1 py-2">No matching events</p>`;
    return;
  }
  box.innerHTML = hits
    .map(
      (e) => `
    <button type="button" data-pick="${e.id}" class="w-full text-left px-2 py-1.5 rounded-lg hover:bg-paper-deep text-sm">
      @${escapeHtml(e.title)}
    </button>`
    )
    .join("");
  box.querySelectorAll("[data-pick]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ent = allEvents.find((x) => x.id === btn.dataset.pick);
      if (ent) {
        selectedLinks.set(ent.id, ent);
        const input = document.getElementById("at-search");
        if (input) input.value = "";
        renderLinkChips();
        renderAtResults("");
      }
    });
  });
}

function renderAttachments() {
  const box = document.getElementById("file-list");
  if (!box) return;
  if (!attachments.length) {
    box.innerHTML = `<span class="text-xs text-ink-faint">No file links yet</span>`;
    return;
  }
  box.innerHTML = attachments
    .map(
      (url, i) => `
      <div class="flex items-center gap-2 text-sm">
        <a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="text-accent hover:underline truncate flex-1">${escapeHtml(url)}</a>
        <button type="button" data-rm-file="${i}" class="btn-ghost text-xs px-2 py-0.5">Remove</button>
      </div>`
    )
    .join("");
  box.querySelectorAll("[data-rm-file]").forEach((btn) => {
    btn.addEventListener("click", () => {
      attachments.splice(parseInt(btn.dataset.rmFile, 10), 1);
      renderAttachments();
    });
  });
}

function renderTagChips(tags) {
  const box = document.getElementById("tag-chips");
  if (!box) return;
  if (!tags.length) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = tags
    .map(
      (t, i) => `
      <button type="button" data-rm-tag="${i}" class="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-paper-deep text-ink-muted text-xs">
        #${escapeHtml(t)}
        <span aria-hidden="true">×</span>
      </button>`
    )
    .join("");
  box.querySelectorAll("[data-rm-tag]").forEach((btn) => {
    btn.addEventListener("click", () => {
      tags.splice(parseInt(btn.dataset.rmTag, 10), 1);
      renderTagChips(tags);
    });
  });
}

export async function openQuickAdd({ onSaved } = {}) {
  const entities = await api.listEntities({ type: "event" });
  allEvents = entities;
  selectedLinks = new Map();
  attachments = [];
  const tags = [];

  const panel = document.getElementById("modal-panel");
  panel.innerHTML = `
    <div class="flex items-start justify-between mb-4">
      <div>
        <h2 class="font-display text-xl">Add event</h2>
        <p class="text-sm text-ink-muted mt-0.5">Only a title is required — everything else is optional.</p>
      </div>
      <button type="button" class="btn-ghost text-lg leading-none" data-close-modal aria-label="Close">×</button>
    </div>
    <form id="quick-add-form" class="space-y-4">
      <div>
        <label class="label" for="qa-title">Title</label>
        <input id="qa-title" class="input" required maxlength="500" placeholder="What happened?" autofocus />
      </div>

      <div>
        <label class="label">Date <span class="font-normal text-ink-faint">(optional)</span></label>
        <div class="grid grid-cols-3 gap-2 mb-2">
          <div>
            <input id="qa-day" class="input" type="number" min="1" max="31" placeholder="Day" />
          </div>
          <div>
            <input id="qa-month" class="input" type="number" min="1" max="12" placeholder="Month" />
          </div>
          <div>
            <input id="qa-year" class="input" type="number" placeholder="Year" />
          </div>
        </div>
        <div class="flex gap-2">
          <label class="flex-1 flex items-center justify-center gap-2 rounded-lg border border-paper-line px-3 py-2 text-sm cursor-pointer has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
            <input type="radio" name="qa-era" value="ac" checked class="accent-accent" />
            AC
          </label>
          <label class="flex-1 flex items-center justify-center gap-2 rounded-lg border border-paper-line px-3 py-2 text-sm cursor-pointer has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
            <input type="radio" name="qa-era" value="bc" class="accent-accent" />
            BC
          </label>
        </div>
        <p class="text-[11px] text-ink-faint mt-1.5">Year alone is fine. Day/month optional. Board sorts by date automatically.</p>
      </div>

      <div>
        <label class="label" for="qa-note">Note <span class="font-normal text-ink-faint">(optional)</span></label>
        <textarea id="qa-note" class="textarea" placeholder="Short note about this event…"></textarea>
      </div>

      <div>
        <label class="label" for="at-search">Related (@) <span class="font-normal text-ink-faint">(optional)</span></label>
        <input id="at-search" class="input" placeholder="Type @ or search to link events…" autocomplete="off" />
        <div id="at-results" class="mt-1 max-h-28 overflow-y-auto"></div>
        <div id="link-chips" class="flex flex-wrap gap-1.5 mt-2"></div>
      </div>

      <div>
        <label class="label" for="tag-input">Tags <span class="font-normal text-ink-faint">(optional)</span></label>
        <div class="flex gap-2">
          <input id="tag-input" class="input flex-1" placeholder="#europe or europe — Enter to add" />
          <button type="button" id="tag-add" class="btn-secondary px-3">Add</button>
        </div>
        <div id="tag-chips" class="flex flex-wrap gap-1.5 mt-2"></div>
      </div>

      <div>
        <label class="label">Place <span class="font-normal text-ink-faint">(optional)</span></label>
        <div class="space-y-2">
          <input id="qa-place-name" class="input" placeholder="Location name" maxlength="500" />
          <input id="qa-place-url" class="input" placeholder="Google Earth / map URL" maxlength="2000" />
        </div>
      </div>

      <div>
        <label class="label">Files <span class="font-normal text-ink-faint">(links / paths — optional)</span></label>
        <div class="flex gap-2">
          <input id="file-input" class="input flex-1" placeholder="Paste a URL or file path" />
          <button type="button" id="file-add" class="btn-secondary px-3">Add</button>
        </div>
        <div id="file-list" class="mt-2 space-y-1"></div>
      </div>

      <div class="flex justify-end gap-2 pt-1">
        <button type="button" class="btn-ghost" data-close-modal>Cancel</button>
        <button type="submit" class="btn-primary px-4 py-2">Save event</button>
      </div>
    </form>
  `;

  renderLinkChips();
  renderAttachments();
  renderTagChips(tags);
  openModal();
  queueMicrotask(() => document.getElementById("qa-title")?.focus());

  const atSearch = document.getElementById("at-search");
  atSearch.addEventListener("input", (e) => renderAtResults(e.target.value));
  atSearch.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const first = document.querySelector("#at-results [data-pick]");
      if (first) first.click();
    }
  });

  function addTag() {
    const raw = document.getElementById("tag-input").value;
    const t = normalizeTag(raw);
    if (!t) return;
    if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
    document.getElementById("tag-input").value = "";
    renderTagChips(tags);
  }
  document.getElementById("tag-add").addEventListener("click", addTag);
  document.getElementById("tag-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTag();
    }
  });

  function addFile() {
    const url = document.getElementById("file-input").value.trim();
    if (!url) return;
    if (!attachments.includes(url)) attachments.push(url);
    document.getElementById("file-input").value = "";
    renderAttachments();
  }
  document.getElementById("file-add").addEventListener("click", addFile);
  document.getElementById("file-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addFile();
    }
  });

  document.getElementById("quick-add-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const year = document.getElementById("qa-year").value;
    const month = document.getElementById("qa-month").value;
    const day = document.getElementById("qa-day").value;
    const era = document.querySelector('input[name="qa-era"]:checked')?.value || "ac";

    if ((month || day) && !String(year).trim()) {
      toast("Add a year if you set month or day");
      return;
    }

    const date_start = composeDate(year, month, day, era);
    const note = document.getElementById("qa-note").value.trim();
    const placeName = document.getElementById("qa-place-name").value.trim();
    const placeUrl = document.getElementById("qa-place-url").value.trim();

    const body = {
      type: "event",
      title: document.getElementById("qa-title").value.trim(),
      summary: note || null,
      body: null,
      date_start,
      date_end: null,
      parent_id: null,
      tags: [...tags],
      place_name: placeName || null,
      place_url: placeUrl || null,
      attachments: [...attachments],
      link_ids: [...selectedLinks.keys()],
      link_relation: "related_to",
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
