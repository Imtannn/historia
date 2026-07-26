/** Settings — daily goal, export/import/wipe, sample seed. */

import { api } from "../api.js";
import { toast } from "../util.js";
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
