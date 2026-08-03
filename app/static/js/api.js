/** Thin API client. */

const JSON_HEADERS = { "Content-Type": "application/json", Accept: "application/json" };
const CATEGORIES_KEY = "historia.categories";

function readLocalCategories() {
  try {
    const raw = localStorage.getItem(CATEGORIES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.map((c) => String(c).trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function writeLocalCategories(categories) {
  localStorage.setItem(CATEGORIES_KEY, JSON.stringify(categories));
}

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
  syncCountryPlaces: () => request("/entities/sync-country-places", { method: "POST" }),
  deleteEntity: (id) => request(`/entities/${id}`, { method: "DELETE" }),
  listLinks: (entityId) => request(`/links${entityId ? `?entity_id=${entityId}` : ""}`),
  createLink: (body) => request("/links", { method: "POST", body: JSON.stringify(body) }),
  updateLink: (id, body) => request(`/links/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteLink: (id) => request(`/links/${id}`, { method: "DELETE" }),
  export: () => request("/export"),
  import: (mode, payload) => request("/import", { method: "POST", body: JSON.stringify({ mode, payload }) }),
  wipe: () => request("/wipe", { method: "POST" }),
  getProgress: () => request("/progress"),
  updateProgress: (body) => request("/progress", { method: "PATCH", body: JSON.stringify(body) }),
  /** Classifications — server when available, localStorage fallback. */
  getUserCategories: async () => {
    const local = readLocalCategories();
    try {
      const p = await request("/progress");
      if (Array.isArray(p?.categories)) {
        writeLocalCategories(p.categories);
        return p.categories;
      }
    } catch {
      /* use local fallback */
    }
    return local;
  },
  saveUserCategories: async (categories) => {
    const cleaned = categories.map((c) => String(c).trim()).filter(Boolean);
    writeLocalCategories(cleaned);
    try {
      const saved = await request("/progress", {
        method: "PATCH",
        body: JSON.stringify({ categories: cleaned }),
      });
      if (Array.isArray(saved?.categories)) {
        writeLocalCategories(saved.categories);
        return { categories: saved.categories, synced: true };
      }
    } catch {
      /* saved locally only */
    }
    return { categories: cleaned, synced: false };
  },
  review: (body) => request("/learn/review", { method: "POST", body: JSON.stringify(body) }),
  flashcards: (params = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v != null && v !== "") q.set(k, v);
    });
    const s = q.toString();
    return request(`/learn/flashcards${s ? `?${s}` : ""}`);
  },
  quizSession: (body) => request("/learn/quiz", { method: "POST", body: JSON.stringify(body) }),
  checkAnswer: (body) => request("/learn/check", { method: "POST", body: JSON.stringify(body) }),
  dashboard: () => request("/dashboard"),
  seed: () => request("/seed", { method: "POST" }),
  renderMarkdown: (text) => request("/markdown", { method: "POST", body: JSON.stringify({ text }) }),
  timeline: (params = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v != null && v !== "") q.set(k, v);
    });
    const s = q.toString();
    return request(`/timeline${s ? `?${s}` : ""}`);
  },
  createTopic: (body) => request("/topics", { method: "POST", body: JSON.stringify(body) }),
  reorderTopicMembers: async (topicId, body) => {
    const payload = JSON.stringify(body);
    const paths = [
      `/topics/${topicId}/member-order`,
      `/entities/${topicId}/topic-member-order`,
    ];
    for (const path of paths) {
      try {
        return await request(path, { method: "PATCH", body: payload });
      } catch (err) {
        const msg = String(err.message || "").toLowerCase();
        if (msg.includes("not found")) continue;
        throw err;
      }
    }
    const links = await request(`/links?entity_id=${encodeURIComponent(topicId)}`);
    const byMember = new Map();
    for (const link of links || []) {
      if (link.relation !== "part_of") continue;
      if (link.source_id === topicId) byMember.set(link.target_id, link);
      else if (link.target_id === topicId) byMember.set(link.source_id, link);
    }
    for (let idx = 0; idx < (body.ordered_entity_ids || []).length; idx++) {
      const eid = body.ordered_entity_ids[idx];
      const link = byMember.get(eid);
      if (!link) throw new Error(`Not a member of this topic: ${eid}`);
      await request(`/links/${link.id}`, {
        method: "PATCH",
        body: JSON.stringify({ sort_order: idx }),
      });
    }
    return { ok: true, fallback: true };
  },
  upload: async (file) => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const detail = data?.detail || res.statusText;
      throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    }
    return data;
  },
  catalog: () => request("/catalog"),
};

const MAX_EMBED_BYTES = 2 * 1024 * 1024;

function uploadUnavailable(err) {
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("not found") || msg.includes("404");
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read image"));
    reader.readAsDataURL(file);
  });
}

/** Upload to server, or embed as data URL when /api/upload is missing (old server). */
api.uploadOrEmbed = async (file) => {
  try {
    const { url } = await api.upload(file);
    return { url, embedded: false };
  } catch (err) {
    if (!uploadUnavailable(err)) throw err;
    if (file.size > MAX_EMBED_BYTES) {
      throw new Error(
        "Upload unavailable and image is too large to embed. Run: cd ~/Downloads/historia && npm run restart"
      );
    }
    const url = await fileToDataUrl(file);
    if (!url.startsWith("data:image/")) {
      throw new Error("Could not embed this image type");
    }
    return { url, embedded: true };
  }
};
