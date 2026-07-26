/** Progress chrome helpers + daily goal celebration. */

import { toast } from "./util.js";

export function syncProgressChrome(progress) {
  if (!progress) return;
  const streakEl = document.getElementById("streak-count");
  const xpEl = document.getElementById("header-xp");
  if (streakEl) streakEl.textContent = `${progress.streak_current} day streak`;
  if (xpEl) xpEl.textContent = `${progress.xp_today} / ${progress.daily_goal_xp} XP today`;
}

export function showGoalCelebration(progress) {
  const existing = document.getElementById("celebrate-overlay");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.id = "celebrate-overlay";
  el.className = "fixed inset-0 z-[70] flex items-center justify-center p-6 bg-ink/40";
  el.innerHTML = `
    <div class="celebrate bg-white rounded-2xl shadow-soft max-w-sm w-full p-8 text-center border border-paper-line">
      <div class="text-4xl mb-3" aria-hidden="true">🔥</div>
      <h2 class="font-display text-2xl mb-2">Daily goal reached!</h2>
      <p class="text-ink-muted text-sm mb-1">${progress.xp_today} XP today</p>
      <p class="text-accent font-semibold mb-6">${progress.streak_current} day streak</p>
      <button type="button" class="btn-primary px-5 py-2.5" id="celebrate-ok">Keep going</button>
    </div>
  `;
  document.body.appendChild(el);
  el.querySelector("#celebrate-ok").addEventListener("click", () => el.remove());
  el.addEventListener("click", (e) => {
    if (e.target === el) el.remove();
  });
  toast("Daily goal complete — streak up!");
}
