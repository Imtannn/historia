/** Skeleton boot — health check until full SPA lands. */

async function checkHealth() {
  const el = document.getElementById("health");
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    el.textContent = `API ${data.status}`;
  } catch (err) {
    el.textContent = "API unreachable";
  }
}

checkHealth();
