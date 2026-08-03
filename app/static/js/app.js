/** App bootstrap: shell chrome + routing. */

import { api } from "./api.js";
import { route, startRouter } from "./router.js";
import { bindModalChrome, openQuickAdd } from "./modal.js";
import { toast } from "./util.js";
import { syncProgressChrome } from "./progress-ui.js";
import { renderHome } from "./views/home.js";
import { renderLibrary } from "./views/library.js";
import { renderEntity } from "./views/entity.js";
import { renderTimeline, teardownTimeline } from "./views/timeline.js";
import { renderFlashcards } from "./views/flashcards.js";
import { renderQuiz } from "./views/quiz.js";
import { renderSettings } from "./views/settings.js";

const view = () => document.getElementById("view");

async function refreshHeader() {
  try {
    const p = await api.getProgress();
    syncProgressChrome(p);
  } catch {
    const streakEl = document.getElementById("streak-count");
    if (streakEl) streakEl.textContent = "—";
  }
}

function bindShell() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebar-overlay");
  const menuBtn = document.getElementById("menu-btn");

  function closeSidebar() {
    sidebar.classList.add("-translate-x-full");
    overlay.classList.add("hidden");
  }
  function openSidebar() {
    sidebar.classList.remove("-translate-x-full");
    overlay.classList.remove("hidden");
  }

  menuBtn.addEventListener("click", openSidebar);
  overlay.addEventListener("click", closeSidebar);
  sidebar.querySelectorAll("a").forEach((a) => a.addEventListener("click", closeSidebar));

  document.getElementById("quick-add-btn").addEventListener("click", () => {
    openQuickAdd({
      onSaved: (created) => {
        refreshHeader();
        location.hash = `/entity/${created.id}`;
      },
    }).catch((err) => {
      console.error(err);
      toast(err.message || "Could not open Add event");
    });
  });

  bindModalChrome();
}

route("/", ({ root, query }) => renderTimeline(root, { query }));
route("/timeline", ({ root, query }) => renderTimeline(root, { query }));
route("/progress", ({ root }) => renderHome(root));
route("/library", ({ root, query }) => renderLibrary(root, { query }));
route("/entity/:id", ({ root, params }) => renderEntity(root, { params }));
route("/flashcards", ({ root }) => renderFlashcards(root));
route("/quiz", ({ root }) => renderQuiz(root));
route("/settings", ({ root }) => renderSettings(root));

bindShell();
refreshHeader();

api.health().then((h) => {
  if (h?.features?.topic_reorder !== true) {
    toast("Restart server for topic reorder — run: npm run restart", 9000);
  } else if (h?.version == null || h.version < 2) {
    toast("Server needs restart — run: npm run restart", 8000);
  }
}).catch(() => {});

startRouter(async ({ path, query, params, matched }) => {
  const root = view();
  teardownTimeline(root);
  root.innerHTML = `<p class="text-ink-muted text-sm px-4 lg:px-8 py-6">Loading…</p>`;
  try {
    if (!matched) {
      root.innerHTML = `<p class="text-ink-muted px-4">Page not found. <a href="#/" class="text-accent underline">World timeline</a></p>`;
      return;
    }
    await matched.handler({ root, path, query, params });
    refreshHeader();
  } catch (err) {
    console.error(err);
    root.classList.remove("view-world-timeline");
    root.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-6 text-red-800 mx-4 lg:mx-8 my-6">
      <p class="font-medium">Something went wrong</p>
      <p class="text-sm mt-1">${err.message || err}</p>
    </div>`;
    toast(err.message || "Error");
  }
});
