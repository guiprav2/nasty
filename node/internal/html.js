/**
 * HTML fragment parse/serialize for Element.innerHTML / outerHTML and DOMParser.
 * Intentionally a focused HTML5-ish subset (tags, attrs, text, comments, void /
 * raw-text elements, common entities) — enough for Webfoundry templates.
 */

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'noscript']);

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
};

/**
 * @param {string} html
 * @param {{ createElement: (tag: string) => any, createTextNode: (data: string) => any }} factory
 * @returns {any[]}
 */
export function parseHtmlFragment(html, factory) {
  const input = String(html ?? '');
  let i = 0;

  function peek(n = 1) {
    return input.slice(i, i + n);
  }

  function startsWith(s) {
    return input.startsWith(s, i);
  }

  function decodeEntities(text) {
    return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (full, body) => {
      if (body[0] === '#') {
        const hex = body[1] === 'x' || body[1] === 'X';
        const n = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
        if (!Number.isFinite(n) || n < 0) return full;
        try {
          return String.fromCodePoint(n);
        } catch {
          return full;
        }
      }
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : full;
    });
  }

  function readUntil(re) {
    const start = i;
    const m = re.exec(input.slice(i));
    if (!m) {
      i = input.length;
      return input.slice(start);
    }
    i += m.index;
    return input.slice(start, i);
  }

  function skipWs() {
    while (i < input.length && /[\t\n\f\r ]/.test(input[i])) i += 1;
  }

  function parseAttributes(el) {
    while (i < input.length) {
      skipWs();
      if (i >= input.length || input[i] === '>' || peek(2) === '/>') break;
      const nameStart = i;
      if (!/[a-zA-Z_:]/.test(input[i])) {
        i += 1;
        continue;
      }
      i += 1;
      while (i < input.length && /[\w:.-]/.test(input[i])) i += 1;
      const name = input.slice(nameStart, i).toLowerCase();
      skipWs();
      let value = '';
      if (input[i] === '=') {
        i += 1;
        skipWs();
        if (input[i] === '"' || input[i] === "'") {
          const q = input[i];
          i += 1;
          const start = i;
          while (i < input.length && input[i] !== q) i += 1;
          value = decodeEntities(input.slice(start, i));
          if (input[i] === q) i += 1;
        } else {
          const start = i;
          while (i < input.length && !/[\t\n\f\r >]/.test(input[i])) i += 1;
          value = decodeEntities(input.slice(start, i));
        }
      }
      // Nasty forbids style attribute mutation; drop it when parsing HTML.
      if (name === 'style') continue;
      try {
        el.setAttribute(name, value);
      } catch {
        /* skip attributes the host rejects */
      }
    }
  }

  function parseNodes(stopTag) {
    const nodes = [];
    while (i < input.length) {
      if (input[i] !== '<') {
        const text = readUntil(/</);
        if (text) nodes.push(factory.createTextNode(decodeEntities(text)));
        continue;
      }
      if (startsWith('<!--')) {
        i += 4;
        const end = input.indexOf('-->', i);
        i = end < 0 ? input.length : end + 3;
        continue;
      }
      if (startsWith('<![CDATA[')) {
        i += 9;
        const end = input.indexOf(']]>', i);
        const data = end < 0 ? input.slice(i) : input.slice(i, end);
        i = end < 0 ? input.length : end + 3;
        if (data) nodes.push(factory.createTextNode(data));
        continue;
      }
      if (startsWith('</')) {
        const m = /^<\/([a-zA-Z][\w:-]*)\s*>/.exec(input.slice(i));
        if (!m) {
          i += 2;
          continue;
        }
        const name = m[1].toLowerCase();
        i += m[0].length;
        if (stopTag && name === stopTag) return nodes;
        // Unmatched closer: ignore (browser recovery is more elaborate).
        continue;
      }
      if (startsWith('<!')) {
        // doctype / bogus comment
        const end = input.indexOf('>', i + 2);
        i = end < 0 ? input.length : end + 1;
        continue;
      }
      if (startsWith('<?')) {
        const end = input.indexOf('>', i + 2);
        i = end < 0 ? input.length : end + 1;
        continue;
      }
      const tagMatch = /^<([a-zA-Z][\w:-]*)/.exec(input.slice(i));
      if (!tagMatch) {
        nodes.push(factory.createTextNode('<'));
        i += 1;
        continue;
      }
      const tagName = tagMatch[1].toLowerCase();
      i += tagMatch[0].length;
      const el = factory.createElement(tagName);
      parseAttributes(el);
      skipWs();
      let selfClosing = false;
      if (peek(2) === '/>') {
        selfClosing = true;
        i += 2;
      } else if (input[i] === '>') {
        i += 1;
      } else {
        // Malformed tag: skip to next '>'
        const end = input.indexOf('>', i);
        i = end < 0 ? input.length : end + 1;
      }
      if (!selfClosing && !VOID.has(tagName)) {
        if (RAW_TEXT.has(tagName)) {
          const close = new RegExp(`</${tagName}\\s*>`, 'i');
          const rest = input.slice(i);
          const m = close.exec(rest);
          const raw = m ? rest.slice(0, m.index) : rest;
          i += m ? m.index + m[0].length : rest.length;
          if (raw) el.appendChild(factory.createTextNode(raw));
        } else {
          for (const child of parseNodes(tagName)) el.appendChild(child);
        }
      }
      nodes.push(el);
    }
    return nodes;
  }

  return parseNodes(null);
}

export function escapeHtmlText(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeHtmlAttr(text) {
  return escapeHtmlText(text).replace(/"/g, '&quot;');
}

/**
 * @param {any} node Element or Text
 * @param {{ getLeafText?: (el: any) => string }} [opts]
 */
export function serializeHtmlNode(node, opts = {}) {
  if (!node) return '';
  if (node.nodeType === 3) return escapeHtmlText(node.data ?? node.textContent ?? '');
  if (node.nodeType !== 1) return '';
  const tag = node.localName || String(node.tagName || '').toLowerCase();
  let out = `<${tag}`;
  const attrs = node.attributes;
  if (attrs && typeof attrs.forEach === 'function') {
    attrs.forEach((value, name) => {
      if (name === 'style') return;
      out += value === '' ? ` ${name}` : ` ${name}="${escapeHtmlAttr(value)}"`;
    });
  }
  if (VOID.has(tag)) return `${out}>`;
  out += '>';
  out += serializeHtmlChildren(node, opts);
  out += `</${tag}>`;
  return out;
}

export function serializeHtmlChildren(el, opts = {}) {
  if (!el) return '';
  const nodes = el.childNodes ?? el.children;
  if (nodes?.length) {
    return [...nodes].map((child) => serializeHtmlNode(child, opts)).join('');
  }
  const leaf = opts.getLeafText?.(el);
  return leaf ? escapeHtmlText(leaf) : '';
}
