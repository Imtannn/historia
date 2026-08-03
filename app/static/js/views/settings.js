/** Settings — daily goal, export/import/wipe, sample seed. */

import { api } from "../api.js";
import { toast, escapeHtml } from "../util.js";
import { syncProgressChrome } from "../progress-ui.js";

export async function renderSettings(root) {
  const progress = await api.getProgress();
  syncProgressChrome(progress);

  root.innerHTML = `
    <div class="mb-8">
      <h1 class="font-display text-3xl tracking-tight">Settings</h1>
      <p class="text-ink-muted mt-1">Goals, backups, and sample data. JSON export is your safety net.</p>
    </div>

    <section class="rounded-2xl bg-white border border-paper-line p-6 shadow-soft mb-6 max-w-xl">
      <h2 class="font-display text-xl mb-1">Classifications</h2>
      <p class="text-sm text-ink-muted mb-4">Define your own filter options (e.g. War, Politics, Culture). Use them when adding events or figures.</p>
      <div class="flex gap-2 mb-3">
        <input id="cat-input" class="input flex-1" placeholder="New classification…" maxlength="64" />
        <button type="button" id="cat-add" class="btn-secondary px-3">Add</button>
      </div>
      <div id="cat-list" class="flex flex-wrap gap-2 min-h-[1.5rem]"></div>
      <p id="cat-sync-note" class="hidden text-xs text-ink-faint mt-2"></p>
    </section>

    <section class="rounded-2xl bg-white border border-paper-line p-6 shadow-soft mb-6 max-w-xl">
      <h2 class="font-display text-xl mb-1">Daily goal</h2>
      <p class="text-sm text-ink-muted mb-4">Hit this XP target to keep your streak alive.</p>
      <form id="goal-form" class="flex items-end gap-3">
        <div class="flex-1">
          <label class="label" for="daily-goal">XP per day</label>
          <input id="daily-goal" class="input" type="number" min="1" max="1000" value="${progress.daily_goal_xp}" />
        </div>
        <button type="submit" class="btn-primary px-4 py-2.5">Save</button>
      </form>
    </section>

    <section class="rounded-2xl bg-white border border-paper-line p-6 shadow-soft mb-6 max-w-xl">
      <h2 class="font-display text-xl mb-1">Sample data</h2>
      <p class="text-sm text-ink-muted mb-4">Load Modern Europe entities, links, and a timeline. Only works on an empty library.</p>
      <button type="button" id="btn-seed" class="btn-secondary px-4 py-2">Load sample set</button>
    </section>

    <section class="rounded-2xl bg-white border border-paper-line p-6 shadow-soft mb-6 max-w-xl">
      <h2 class="font-display text-xl mb-1">Backup</h2>
      <p class="text-sm text-ink-muted mb-4">Export everything to JSON, or import a previous dump.</p>
      <div class="flex flex-wrap gap-2 mb-4">
        <button type="button" id="btn-export" class="btn-primary px-4 py-2">Export JSON</button>
      </div>
      <div class="border-t border-paper-line pt-4 space-y-3">
        <label class="label" for="import-file">Import file</label>
        <input id="import-file" type="file" accept="application/json,.json" class="block text-sm" />
        <div class="flex items-center gap-4 text-sm">
          <label class="inline-flex items-center gap-2 cursor-pointer">
            <input type="radio" name="import-mode" value="merge" checked />
            Merge by id
          </label>
          <label class="inline-flex items-center gap-2 cursor-pointer">
            <input type="radio" name="import-mode" value="replace" />
            Replace all
          </label>
        </div>
        <button type="button" id="btn-import" class="btn-secondary px-4 py-2">Import</button>
      </div>
    </section>

    <section class="rounded-2xl border border-red-200 bg-red-50/50 p-6 max-w-xl">
      <h2 class="font-display text-xl mb-1 text-red-900">Danger zone</h2>
      <p class="text-sm text-red-800/80 mb-4">Wipe deletes every entity, link, and review. Export first.</p>
      <button type="button" id="btn-wipe" class="px-4 py-2 rounded-lg bg-red-700 text-white font-semibold hover:bg-red-800">Wipe all data</button>
    </section>
  `;

  let categories = await api.getUserCategories();

  function syncNote(synced) {
    const el = document.getElementById("cat-sync-note");
    if (!el) return;
    if (synced) {
      el.classList.add("hidden");
      el.textContent = "";
      return;
    }
    el.classList.remove("hidden");
    el.textContent = "Saved on this device. Run npm run restart to sync to the server.";
  }

  async function persistCategories(next) {
    const result = await api.saveUserCategories(next);
    categories = [...result.categories];
    syncNote(result.synced);
    return result;
  }

  function renderCategories() {
    const box = document.getElementById("cat-list");
    if (!box) return;
    if (!categories.length) {
      box.innerHTML = `<span class="text-sm text-ink-faint">No classifications yet.</span>`;
      return;
    }
    box.innerHTML = categories
      .map(
        (c, i) => `
      <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-paper-deep text-sm">
        ${escapeHtml(c)}
        <button type="button" data-rm-cat="${i}" class="text-ink-faint hover:text-red-700" aria-label="Remove">×</button>
      </span>`
      )
      .join("");
    box.querySelectorAll("[data-rm-cat]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const next = categories.filter((_, i) => i !== parseInt(btn.dataset.rmCat, 10));
        try {
          await persistCategories(next);
          renderCategories();
          toast("Classification removed");
        } catch (err) {
          toast(err.message);
        }
      });
    });
  }
  renderCategories();

  document.getElementById("cat-add")?.addEventListener("click", async () => {
    const val = document.getElementById("cat-input")?.value.trim();
    if (!val) return;
    if (categories.some((c) => c.toLowerCase() === val.toLowerCase())) {
      toast("Already exists");
      return;
    }
    const next = [...categories, val];
    try {
      await persistCategories(next);
      document.getElementById("cat-input").value = "";
      renderCategories();
      toast("Classification added");
    } catch (err) {
      toast(err.message);
    }
  });
  document.getElementById("cat-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      document.getElementById("cat-add")?.click();
    }
  });

  document.getElementById("goal-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const val = parseInt(document.getElementById("daily-goal").value, 10);
    try {
      const p = await api.updateProgress({ daily_goal_xp: val });
      syncProgressChrome(p);
      toast("Daily goal updated");
    } catch (err) {
      toast(err.message);
    }
  });

  document.getElementById("btn-seed").addEventListener("click", async () => {
    try {
      const res = await api.seed();
      toast(`Loaded ${res.created} sample entries`);
      location.hash = "/library";
    } catch (err) {
      toast(err.message || "Library must be empty to load samples");
    }
  });

  document.getElementById("btn-export").addEventListener("click", async () => {
    try {
      const data = await api.export();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `historia-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast("Export downloaded");
    } catch (err) {
      toast(err.message);
    }
  });

  document.getElementById("btn-import").addEventListener("click", async () => {
    const file = document.getElementById("import-file").files?.[0];
    if (!file) {
      toast("Choose a JSON file first");
      return;
    }
    const mode = document.querySelector('input[name="import-mode"]:checked').value;
    if (mode === "replace" && !confirm("Replace will wipe current data, then import. Continue?")) {
      return;
    }
    if (mode === "merge" && !confirm("Merge will upsert entities by id. Continue?")) {
      return;
    }
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const res = await api.import(mode, payload);
      toast(`Imported ${res.entities} entities (${res.mode})`);
      location.hash = "/library";
    } catch (err) {
      toast(err.message || "Import failed — check the file");
    }
  });

  document.getElementById("btn-wipe").addEventListener("click", async () => {
    if (!confirm("Really wipe ALL data? This cannot be undone.")) return;
    if (!confirm("Last chance — wipe everything?")) return;
    try {
      await api.wipe();
      toast("Database wiped");
      location.hash = "/";
    } catch (err) {
      toast(err.message);
    }
  });
}
