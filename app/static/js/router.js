/** Hash-based SPA router. */

const routes = [];

export function route(pattern, handler) {
  // pattern like "/entity/:id" or "/library"
  const keys = [];
  const re = new RegExp(
    "^" +
      pattern
        .replace(/\//g, "\\/")
        .replace(/:([a-zA-Z_]+)/g, (_, k) => {
          keys.push(k);
          return "([^/]+)";
        }) +
      "$"
  );
  routes.push({ re, keys, handler, pattern });
}

export function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [pathPart, queryPart] = raw.split("?");
  const path = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  const query = Object.fromEntries(new URLSearchParams(queryPart || ""));
  return { path, query };
}

export async function navigate(to) {
  if (to.startsWith("#")) {
    location.hash = to.slice(1);
  } else {
    location.hash = to.startsWith("/") ? to : `/${to}`;
  }
}

export function startRouter(onResolve) {
  async function resolve() {
    const { path, query } = parseHash();
    let matched = null;
    let params = {};
    for (const r of routes) {
      const m = path.match(r.re);
      if (m) {
        params = {};
        r.keys.forEach((k, i) => {
          params[k] = decodeURIComponent(m[i + 1]);
        });
        matched = r;
        break;
      }
    }
    const navKey = matched
      ? matched.pattern.split("/")[1] || "home"
      : "home";
    document.querySelectorAll("[data-nav]").forEach((el) => {
      el.classList.toggle("active", el.dataset.nav === navKey || (navKey === "" && el.dataset.nav === "home"));
    });
    // Special: entity pages highlight library
    if (path.startsWith("/entity/")) {
      document.querySelectorAll("[data-nav]").forEach((el) => {
        el.classList.toggle("active", el.dataset.nav === "library");
      });
    }
    await onResolve({ path, query, params, matched });
  }

  window.addEventListener("hashchange", resolve);
  resolve();
  return resolve;
}
