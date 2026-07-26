/** App bootstrap: shell chrome + routing. */

import { api } from "./api.js";
import { route, startRouter } from "./router.js";
import { bindModalChrome, openQuickAdd } from "./modal.js";
import { toast } from "./util.js";
import { syncProgressChrome } from "./progress-ui.js";
import { renderHome } from "./views/home.js";
import { renderLibrary } from "./views/library.js";
import { renderEntity } from "./views/entity.js";
import { renderTimeline } from "./views/timeline.js";
import { renderFlashcards } from "./views/flashcards.js";
import { renderQuiz } from "./views/quiz.js";

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
    });
  });

  bindModalChrome();
}

function stub(name) {
  return async (root) => {
    root.innerHTML = `
      <h1 class="font-display text-3xl mb-2">${name}</h1>
      <p class="text-ink-muted">Coming in the next build step.</p>
    `;
  };
}

route("/", ({ root }) => renderHome(root));
route("/library", ({ root, query }) => renderLibrary(root, { query }));
route("/entity/:id", ({ root, params }) => renderEntity(root, { params }));
route("/timeline", ({ root, query }) => renderTimeline(root, { query }));
route("/flashcards", ({ root }) => renderFlashcards(root));
route("/quiz", ({ root }) => renderQuiz(root));
route("/settings", stub("Settings"));

bindShell();
refreshHeader();

startRouter(async ({ path, query, params, matched }) => {
  const root = view();
  root.innerHTML = `<p class="text-ink-muted text-sm">Loading…</p>`;
  try {
    if (!matched) {
      root.innerHTML = `<p class="text-ink-muted">Page not found. <a href="#/" class="text-accent underline">Home</a></p>`;
      return;
    }
    await matched.handler({ root, path, query, params });
    refreshHeader();
  } catch (err) {
    console.error(err);
    root.innerHTML = `<div class="rounded-2xl border border-red-200 bg-red-50 p-6 text-red-800">
      <p class="font-medium">Something went wrong</p>
      <p class="text-sm mt-1">${err.message || err}</p>
    </div>`;
    toast(err.message || "Error");
  }
});
