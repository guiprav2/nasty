// DuckDuckGo's no-JS HTML endpoint. Public SearXNG JSON was rate-limited,
// bot-walled, or HTML-only from this network. This POST returns real web hits
// with no API key.

let ENDPOINT = 'https://html.duckduckgo.com/html/';
let UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

function decodeAttr(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function decodeHtml(s) {
  return decodeAttr(String(s || '').replace(/<[^>]*>/g, ''))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function unwrapUrl(href) {
  let raw = decodeAttr(href);
  let u;
  try { u = new URL(raw, ENDPOINT); } catch { return ''; }
  let uddg = u.searchParams.get('uddg');
  if (uddg) {
    try { u = new URL(uddg); } catch { return ''; }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  if (/(^|\.)duckduckgo\.com$/i.test(u.hostname)) return '';
  return u.href;
}

export function parseDuckDuckGoHtml(html) {
  let results = [];
  let re = /<a\b([^>]*\bresult__a\b[^>]*)>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    let hrefMatch = m[1].match(/\bhref=["']([^"']+)["']/);
    if (!hrefMatch) continue;
    let before = html.slice(Math.max(0, m.index - 600), m.index);
    if (/result--ad/.test(before)) continue;
    let url = unwrapUrl(hrefMatch[1]);
    let title = decodeHtml(m[2]);
    if (!url || !title) continue;
    let windowHtml = html.slice(m.index, m.index + 4000);
    let snippetMatch = windowHtml.match(/\bresult__snippet\b[^>]*>([\s\S]*?)<\/a>/);
    let snippet = snippetMatch ? decodeHtml(snippetMatch[1]).slice(0, 500) : '';
    if (results.some(r => r.url === url)) continue;
    results.push({ url, title: title.slice(0, 300), snippet });
    if (results.length >= 8) break;
  }
  return results;
}

export async function searchWeb(terms, fetchImpl = globalThis.fetch) {
  let q = String(terms || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!q) return { query: '', results: [], error: 'terms is empty' };
  let res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Accept: 'text/html',
    },
    body: new URLSearchParams({ q, kl: 'us-en' }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return { query: q, results: [], error: `DuckDuckGo HTTP ${res.status}` };
  let html = await res.text();
  let results = parseDuckDuckGoHtml(html);
  if (!results.length && /bots use DuckDuckGo|anomaly-modal|unfortunately/i.test(html)) {
    return { query: q, results: [], error: 'DuckDuckGo blocked this query. Try different terms.' };
  }
  if (!results.length) return { query: q, results: [], error: 'No web results for those terms.' };
  return { query: q, results };
}
