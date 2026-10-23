// Line grep over HTML. Long lines are split at tags so -A/-B/-C can see neighbors.

function linesOf(html) {
  const lines = [];
  for (const raw of String(html || "").split(/\r?\n/)) {
    if (raw.length <= 400) {
      lines.push(raw);
      continue;
    }
    let rest = raw;
    while (rest.length > 400) {
      let cut = rest.lastIndexOf(">", 400);
      if (cut < 40) cut = 400;
      else cut += 1;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) lines.push(rest);
  }
  return lines;
}

function compile(pattern, ignoreCase) {
  const source = String(pattern || "");
  if (!source) throw new Error("pattern is empty");
  const flags = ignoreCase === false ? "" : "i";
  try {
    return new RegExp(source, flags);
  } catch {
    return new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  }
}

export function grepHtml(html, options = {}) {
  const lines = linesOf(html);
  const expression = compile(options.pattern, options.ignoreCase);
  const around = Math.max(0, Math.min(8, Math.floor(Number(options.context) || 0)));
  const before = around || Math.max(0, Math.min(8, Math.floor(Number(options.before) || 0)));
  const after = around || Math.max(0, Math.min(8, Math.floor(Number(options.after) || 0)));
  const maxMatches = Math.max(1, Math.min(30, Math.floor(Number(options.maxMatches) || 12)));
  const hits = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!expression.test(lines[index])) continue;
    expression.lastIndex = 0;
    const start = Math.max(0, index - before);
    const end = Math.min(lines.length, index + after + 1);
    const block = [];
    for (let line = start; line < end; line += 1) {
      const mark = line === index ? ":" : "-";
      block.push(`${line + 1}${mark}${lines[line].slice(0, 300)}`);
    }
    hits.push(block.join("\n"));
    if (hits.length >= maxMatches) break;
  }
  return {
    matches: hits.length,
    lines: lines.length,
    text: hits.join("\n--\n").slice(0, 6000),
  };
}

export function firstPatternUrl(html, pattern, base) {
  const expression = compile(pattern, true);
  const match = expression.exec(String(html || ""));
  if (!match) return "";
  const raw = match[1] || match[0];
  try {
    const url = new URL(String(raw).trim(), base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.href;
  } catch {
    return "";
  }
}
