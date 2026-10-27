// Page HTML cache shared by playback pattern fallback (and any tool that reads a page).
// Entries are URL -> { html, at }. A hit older than 10 seconds is a miss.

const TTL_MS = 10_000;
const pages = Object.create(null);

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function fresh(entry, now) {
  return entry && now - entry.at < TTL_MS;
}

export function cachedPage(url) {
  const entry = pages[String(url || "")];
  return fresh(entry, Date.now()) ? entry.html : null;
}

export function storePage(url, html, at = Date.now()) {
  const key = String(url || "");
  if (!key) return;
  pages[key] = { html: String(html ?? ""), at: Number(at) || Date.now() };
}

export function clearPageCache() {
  for (const key of Object.keys(pages)) delete pages[key];
}

export async function fetchPage(url, fetchImpl = globalThis.fetch) {
  const key = String(url || "").trim();
  if (!key) throw new Error("url is empty");
  const now = Date.now();
  const hit = pages[key];
  if (fresh(hit, now)) return hit.html;
  if (hit) delete pages[key];
  const response = await fetchImpl(key, {
    redirect: "follow",
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${key}`);
  const html = await response.text();
  const stored = response.url || key;
  pages[key] = { html, at: Date.now() };
  if (stored !== key) pages[stored] = { html, at: Date.now() };
  return html;
}
