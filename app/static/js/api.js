/** Thin API client. */

const JSON_HEADERS = { "Content-Type": "application/json", Accept: "application/json" };

async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: options.body ? JSON_HEADERS : { Accept: "application/json" },
    ...options,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail = data?.detail || data?.message || res.statusText;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return data;
}

export const api = {
  health: () => request("/health"),
  listEntities: (params = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v != null && v !== "") q.set(k, v);
    });
    const s = q.toString();
    return request(`/entities${s ? `?${s}` : ""}`);
  },
  getEntity: (id) => request(`/entities/${id}`),
  neighbors: (id) => request(`/entities/${id}/neighbors`),
  createEntity: (body) => request("/entities", { method: "POST", body: JSON.stringify(body) }),
  updateEntity: (id, body) => request(`/entities/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteEntity: (id) => request(`/entities/${id}`, { method: "DELETE" }),
  listLinks: (entityId) => request(`/links${entityId ? `?entity_id=${entityId}` : ""}`),
  createLink: (body) => request("/links", { method: "POST", body: JSON.stringify(body) }),
  deleteLink: (id) => request(`/links/${id}`, { method: "DELETE" }),
  export: () => request("/export"),
  import: (mode, payload) => request("/import", { method: "POST", body: JSON.stringify({ mode, payload }) }),
  wipe: () => request("/wipe", { method: "POST" }),
  getProgress: () => request("/progress"),
  updateProgress: (body) => request("/progress", { method: "PATCH", body: JSON.stringify(body) }),
  review: (body) => request("/learn/review", { method: "POST", body: JSON.stringify(body) }),
  flashcards: (params = {}) => {
    const q = new URLSearchParams(params);
    return request(`/learn/flashcards?${q}`);
  },
  quizSession: (body) => request("/learn/quiz", { method: "POST", body: JSON.stringify(body) }),
  dashboard: () => request("/dashboard"),
  seed: () => request("/seed", { method: "POST" }),
  renderMarkdown: (text) => request("/markdown", { method: "POST", body: JSON.stringify({ text }) }),
  timeline: (params = {}) => {
    const q = new URLSearchParams(params);
    return request(`/timeline?${q}`);
  },
};
