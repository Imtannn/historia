/** Quiz config, runner (MCQ / type-in / match), and summary. */

import { api } from "../api.js";
import { escapeHtml, toast } from "../util.js";
import { showGoalCelebration, syncProgressChrome } from "../progress-ui.js";

export async function renderQuiz(root) {
  root.innerHTML = `
    <div class="mb-6">
      <h1 class="font-display text-3xl tracking-tight">Quiz</h1>
      <p class="text-ink-muted mt-1">Test recall with multiple choice, type-in, or matching.</p>
    </div>

    <form id="quiz-config" class="rounded-2xl bg-white border border-paper-line p-6 shadow-soft space-y-4 max-w-lg">
      <div>
        <label class="label" for="qz-type">Question type</label>
        <select id="qz-type" class="select">
          <option value="mixed">Mixed</option>
          <option value="mcq">Multiple choice</option>
          <option value="typein">Type-in</option>
          <option value="match">Match</option>
        </select>
      </div>
      <div>
        <label class="label" for="qz-len">Length</label>
        <select id="qz-len" class="select">
          <option value="5">5</option>
          <option value="10" selected>10</option>
          <option value="20">20</option>
        </select>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="label" for="qz-entity-type">Entity type</label>
          <select id="qz-entity-type" class="select">
            <option value="">Any</option>
            <option value="event">Event</option>
            <option value="figure">Figure</option>
            <option value="place">Place</option>
            <option value="period">Period</option>
          </select>
        </div>
        <div>
          <label class="label" for="qz-tag">Tag</label>
          <input id="qz-tag" class="input" placeholder="optional" />
        </div>
      </div>
      <button type="submit" class="btn-primary px-4 py-2.5 w-full sm:w-auto">Start quiz</button>
    </form>
    <div id="qz-stage" class="mt-8"></div>
  `;

  document.getElementById("quiz-config").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {
      quiz_type: document.getElementById("qz-type").value,
      length: parseInt(document.getElementById("qz-len").value, 10),
      type: document.getElementById("qz-entity-type").value || null,
      tag: document.getElementById("qz-tag").value.trim() || null,
    };
    try {
      const session = await api.quizSession(body);
      if (!session.questions?.length) {
        toast("Not enough data for that quiz — add more linked entities.");
        return;
      }
      runSession(root, session.questions);
    } catch (err) {
      toast(err.message || "Could not start quiz");
    }
  });
}

function runSession(root, questions) {
  const stage = document.getElementById("qz-stage");
  const config = document.getElementById("quiz-config");
  config.classList.add("hidden");

  let idx = 0;
  let score = 0;
  let earned = 0;
  const missed = [];
  let goalHit = false;

  async function next() {
    if (idx >= questions.length) {
      showSummary(stage, { score, total: questions.length, earned, missed, goalHit, onAgain: () => location.reload() });
      return;
    }
    const q = questions[idx];
    if (q.type === "mcq") await renderMcq(stage, q);
    else if (q.type === "typein") await renderTypein(stage, q);
    else if (q.type === "match") await renderMatch(stage, q);
    else {
      idx += 1;
      next();
    }
  }

  async function finishQuestion(q, result) {
    syncProgressChrome(result.progress);
    if (result.goal_just_hit) {
      goalHit = true;
      showGoalCelebration(result.progress);
    }
    if (result.correct) {
      score += 1;
      earned += result.xp_earned || 0;
    } else {
      missed.push({ entity_id: q.entity_id, prompt: q.prompt, answer: q.answer || JSON.stringify(q.pairs || {}) });
    }
    idx += 1;
    setTimeout(next, result.correct ? 450 : 900);
  }

  async function renderMcq(stage, q) {
    stage.innerHTML = `
      <p class="text-sm text-ink-faint mb-2">${idx + 1} / ${questions.length} · MCQ · +${q.xp} XP</p>
      <h2 class="font-display text-xl mb-4">${escapeHtml(q.prompt)}</h2>
      <div class="space-y-2 max-w-lg" id="mcq-opts">
        ${q.options
          .map(
            (o, i) =>
              `<button type="button" data-opt="${i}" class="entity-row text-left">${escapeHtml(o)}</button>`
          )
          .join("")}
      </div>
      <p id="qz-feedback" class="mt-4 text-sm font-medium hidden"></p>
    `;
    const opts = stage.querySelectorAll("[data-opt]");
    opts.forEach((btn) => {
      btn.addEventListener("click", async () => {
        opts.forEach((b) => (b.disabled = true));
        const answer = q.options[parseInt(btn.dataset.opt, 10)];
        try {
          const result = await api.checkAnswer({
            quiz_type: "mcq",
            answer,
            expected: q.answer,
            entity_id: q.entity_id,
            xp_amount: q.xp,
          });
          const fb = document.getElementById("qz-feedback");
          fb.classList.remove("hidden");
          if (result.correct) {
            fb.textContent = "Nice! That's right.";
            fb.className = "mt-4 text-sm font-medium text-green-700";
            btn.style.borderColor = "#16A34A";
          } else {
            fb.textContent = `Not quite — answer: ${q.answer}`;
            fb.className = "mt-4 text-sm font-medium text-red-700";
            btn.style.borderColor = "#DC2626";
          }
          await finishQuestion(q, result);
        } catch (err) {
          toast(err.message);
        }
      });
    });
  }

  async function renderTypein(stage, q) {
    stage.innerHTML = `
      <p class="text-sm text-ink-faint mb-2">${idx + 1} / ${questions.length} · Type-in · +${q.xp} XP</p>
      <h2 class="font-display text-xl mb-4">${escapeHtml(q.prompt)}</h2>
      <form id="typein-form" class="max-w-md flex gap-2">
        <input id="typein-ans" class="input flex-1" autocomplete="off" placeholder="${escapeHtml(q.hint || "Your answer")}" />
        <button type="submit" class="btn-primary px-4">Check</button>
      </form>
      <p id="qz-feedback" class="mt-4 text-sm font-medium hidden"></p>
    `;
    document.getElementById("typein-ans").focus();
    document.getElementById("typein-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const answer = document.getElementById("typein-ans").value;
      document.querySelector("#typein-form button").disabled = true;
      try {
        const result = await api.checkAnswer({
          quiz_type: "typein",
          answer,
          expected: q.answer,
          entity_id: q.entity_id,
          xp_amount: q.xp,
        });
        const fb = document.getElementById("qz-feedback");
        fb.classList.remove("hidden");
        if (result.correct) {
          fb.textContent = "Correct!";
          fb.className = "mt-4 text-sm font-medium text-green-700";
        } else {
          fb.textContent = `Answer: ${q.answer}`;
          fb.className = "mt-4 text-sm font-medium text-red-700";
        }
        await finishQuestion(q, result);
      } catch (err) {
        toast(err.message);
      }
    });
  }

  async function renderMatch(stage, q) {
    const pairs = {}; // leftId -> rightLabel once paired
    let selectedLeft = null;
    let selectedRight = null;

    stage.innerHTML = `
      <p class="text-sm text-ink-faint mb-2">${idx + 1} / ${questions.length} · Match · +${q.xp} XP</p>
      <h2 class="font-display text-xl mb-4">${escapeHtml(q.prompt)}</h2>
      <div class="grid sm:grid-cols-2 gap-4 max-w-2xl">
        <div class="space-y-2" id="match-left">
          ${q.left
            .map((item) => `<button type="button" data-left="${item.id}" class="match-item w-full text-left">${escapeHtml(item.label)}</button>`)
            .join("")}
        </div>
        <div class="space-y-2" id="match-right">
          ${q.right
            .map((item) => `<button type="button" data-right="${item.id}" data-label="${escapeHtml(item.label)}" class="match-item w-full text-left">${escapeHtml(item.label)}</button>`)
            .join("")}
        </div>
      </div>
      <div class="mt-5 flex gap-2">
        <button type="button" id="match-submit" class="btn-primary px-4 py-2" disabled>Submit pairs</button>
        <button type="button" id="match-reset" class="btn-ghost">Reset</button>
      </div>
      <p id="qz-feedback" class="mt-4 text-sm font-medium hidden"></p>
    `;

    function refresh() {
      const leftBtns = stage.querySelectorAll("[data-left]");
      const rightBtns = stage.querySelectorAll("[data-right]");
      leftBtns.forEach((b) => {
        const id = b.dataset.left;
        b.classList.toggle("selected", selectedLeft === id);
        b.classList.toggle("paired", id in pairs);
      });
      rightBtns.forEach((b) => {
        const used = Object.values(pairs).includes(b.dataset.label);
        b.classList.toggle("selected", selectedRight === b.dataset.right);
        b.classList.toggle("paired", used);
      });
      document.getElementById("match-submit").disabled = Object.keys(pairs).length < q.left.length;
    }

    function tryPair() {
      if (selectedLeft && selectedRight) {
        const rightBtn = stage.querySelector(`[data-right="${selectedRight}"]`);
        pairs[selectedLeft] = rightBtn.dataset.label;
        selectedLeft = null;
        selectedRight = null;
        refresh();
      }
    }

    stage.querySelectorAll("[data-left]").forEach((b) => {
      b.addEventListener("click", () => {
        if (b.dataset.left in pairs) return;
        selectedLeft = b.dataset.left;
        tryPair();
        refresh();
      });
    });
    stage.querySelectorAll("[data-right]").forEach((b) => {
      b.addEventListener("click", () => {
        if (Object.values(pairs).includes(b.dataset.label)) return;
        selectedRight = b.dataset.right;
        tryPair();
        refresh();
      });
    });
    document.getElementById("match-reset").addEventListener("click", () => {
      Object.keys(pairs).forEach((k) => delete pairs[k]);
      selectedLeft = selectedRight = null;
      refresh();
    });
    document.getElementById("match-submit").addEventListener("click", async () => {
      try {
        const result = await api.checkAnswer({
          quiz_type: "match",
          answer: pairs,
          expected: q.pairs,
          entity_id: q.entity_id,
          entity_ids: q.entity_ids || [q.entity_id],
          xp_amount: q.xp,
        });
        const fb = document.getElementById("qz-feedback");
        fb.classList.remove("hidden");
        if (result.correct) {
          fb.textContent = "Perfect match!";
          fb.className = "mt-4 text-sm font-medium text-green-700";
        } else {
          fb.textContent = "Some pairs were off — keep practicing.";
          fb.className = "mt-4 text-sm font-medium text-red-700";
        }
        document.getElementById("match-submit").disabled = true;
        await finishQuestion(q, result);
      } catch (err) {
        toast(err.message);
      }
    });
  }

  next();
}

function showSummary(stage, { score, total, earned, missed, goalHit, onAgain }) {
  stage.innerHTML = `
    <div class="rounded-2xl bg-white border border-paper-line p-8 shadow-soft max-w-lg">
      <h2 class="font-display text-2xl mb-2">Quiz complete</h2>
      <p class="text-ink-muted mb-1">Score: <strong class="text-ink">${score} / ${total}</strong></p>
      <p class="text-accent font-semibold mb-2">+${earned} XP</p>
      ${goalHit ? `<p class="text-sm text-green-700 mb-4">You hit today's goal — streak updated!</p>` : `<p class="mb-4"></p>`}
      ${
        missed.length
          ? `<div class="mb-6">
              <h3 class="text-sm font-semibold text-ink-muted mb-2">Missed</h3>
              <ul class="space-y-2">
                ${missed
                  .map(
                    (m) => `<li class="text-sm">
                      <a href="#/entity/${m.entity_id}" class="text-accent hover:underline">${escapeHtml(m.prompt)}</a>
                      <span class="text-ink-faint"> — ${escapeHtml(String(m.answer))}</span>
                    </li>`
                  )
                  .join("")}
              </ul>
            </div>`
          : `<p class="text-sm text-green-700 mb-6">Flawless — every answer landed.</p>`
      }
      <div class="flex flex-wrap gap-2">
        <a href="#/quiz" class="btn-primary px-4 py-2 inline-block" id="qz-again">Try another</a>
        <a href="#/" class="btn-ghost inline-block">Home</a>
      </div>
    </div>
  `;
}
