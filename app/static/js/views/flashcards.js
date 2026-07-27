/** Flashcard session runner. */

import { api } from "../api.js";
import { escapeHtml, toast } from "../util.js";
import { showGoalCelebration, syncProgressChrome } from "../progress-ui.js";

export async function renderFlashcards(root) {
  root.innerHTML = `
    <div class="mb-6">
      <h1 class="font-display text-3xl tracking-tight">Flashcards</h1>
      <p class="text-ink-muted mt-1">Flip to reveal, then mark Got it or Missed it.</p>
    </div>
    <div class="flex flex-wrap gap-3 mb-6">
      <select id="fc-type" class="select sm:w-40">
        <option value="">All types</option>
        <option value="event">Event</option>
        <option value="figure">Figure</option>
        <option value="place">Place</option>
        <option value="period">Period</option>
        <option value="milestone">Moment</option>
      </select>
      <input id="fc-tag" class="input sm:w-40" placeholder="Tag filter" />
      <button type="button" id="fc-start" class="btn-primary px-4 py-2">Start review</button>
    </div>
    <div id="fc-stage"></div>
  `;

  document.getElementById("fc-start").addEventListener("click", () => startSession(root));
}

async function startSession(root) {
  const type = document.getElementById("fc-type").value;
  const tag = document.getElementById("fc-tag").value.trim();
  const data = await api.flashcards({ type, tag, limit: 15 });
  const cards = data.cards || [];
  const stage = document.getElementById("fc-stage");

  if (!cards.length) {
    stage.innerHTML = `
      <div class="rounded-2xl border border-dashed border-paper-line p-10 text-center text-ink-muted text-sm">
        No flashcards yet. Add entities with dates, summaries, or links — or load the sample set.
      </div>`;
    return;
  }

  let idx = 0;
  let earned = 0;
  let correctCount = 0;

  async function showCard() {
    if (idx >= cards.length) {
      stage.innerHTML = `
        <div class="rounded-2xl bg-white border border-paper-line p-8 text-center shadow-soft">
          <h2 class="font-display text-2xl mb-2">Session complete</h2>
          <p class="text-ink-muted mb-1">${correctCount} / ${cards.length} remembered</p>
          <p class="text-accent font-semibold mb-6">+${earned} XP</p>
          <button type="button" id="fc-again" class="btn-primary px-4 py-2">Review again</button>
        </div>`;
      document.getElementById("fc-again").addEventListener("click", () => startSession(root));
      return;
    }

    const card = cards[idx];
    stage.innerHTML = `
      <p class="text-sm text-ink-faint mb-3">${idx + 1} / ${cards.length}</p>
      <div id="flip-card" class="card-flip max-w-lg mx-auto cursor-pointer" tabindex="0" role="button" aria-label="Flip card">
        <div class="card-flip-inner">
          <div class="card-face card-front shadow-soft">
            <p class="text-xs uppercase tracking-wider text-ink-faint font-semibold mb-3">Question</p>
            <p class="font-display text-xl sm:text-2xl text-center leading-snug">${escapeHtml(card.prompt)}</p>
            <p class="text-center text-xs text-ink-faint mt-6">Tap to flip</p>
          </div>
          <div class="card-face card-back shadow-soft">
            <p class="text-xs uppercase tracking-wider text-ink-faint font-semibold mb-3">Answer</p>
            <p class="font-display text-xl sm:text-2xl text-center leading-snug">${escapeHtml(card.answer)}</p>
          </div>
        </div>
      </div>
      <div id="fc-actions" class="hidden flex justify-center gap-3 mt-6">
        <button type="button" id="fc-miss" class="btn-ghost px-5 py-2.5 border border-paper-line">Missed it</button>
        <button type="button" id="fc-got" class="btn-primary px-5 py-2.5">Got it · +${card.xp} XP</button>
      </div>
      <p class="text-center mt-4"><a href="#/entity/${card.entity_id}" class="text-sm text-accent hover:underline">Open entry</a></p>
    `;

    const flip = document.getElementById("flip-card");
    const actions = document.getElementById("fc-actions");
    function doFlip() {
      flip.classList.add("flipped");
      actions.classList.remove("hidden");
    }
    flip.addEventListener("click", doFlip);
    flip.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        doFlip();
      }
    });

    async function grade(correct) {
      try {
        const res = await api.review({
          entity_id: card.entity_id,
          correct,
          xp_amount: card.xp,
        });
        if (correct) {
          correctCount += 1;
          earned += res.xp_earned || 0;
        }
        syncProgressChrome(res.progress);
        if (res.goal_just_hit) showGoalCelebration(res.progress);
        idx += 1;
        showCard();
      } catch (err) {
        toast(err.message || "Could not save review");
      }
    }

    document.getElementById("fc-got").addEventListener("click", () => grade(true));
    document.getElementById("fc-miss").addEventListener("click", () => grade(false));
  }

  showCard();
}
