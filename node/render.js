const SIDES = ["Top", "Right", "Bottom", "Left"];

function parseColor(value) {
  if (!value || value === "transparent") return null;
  let match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value);
  if (match) {
    const hex = match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join("") : match[1];
    return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255).concat(1);
  }
  match = /^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(value);
  if (!match) throw new TypeError(`unsupported display-list color: ${value}`);
  const alpha = match[4] ? (match[4].endsWith("%") ? Number.parseFloat(match[4]) / 100 : Number.parseFloat(match[4])) : 1;
  return [Number(match[1]) / 255, Number(match[2]) / 255, Number(match[3]) / 255, alpha];
}

function intersection(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}

// Display-list v1 contains unclipped solid quads. Clip in JS before sending it to Rust.
export function buildBoxDisplayList(boxes, width, height) {
  const values = [1];
  const viewport = { x: 0, y: 0, width, height };
  const push = (rect, color, clip) => {
    if (!color || rect.width <= 0 || rect.height <= 0) return;
    const visible = clip ? intersection(rect, clip) : rect;
    if (visible.width <= 0 || visible.height <= 0) return;
    values.push(visible.x, visible.y, visible.width, visible.height, ...color);
  };

  for (const box of boxes) {
    const { element, borderBox, border } = box;
    const clip = box.clip ? intersection(box.clip, viewport) : viewport;
    push(borderBox, parseColor(element.style.backgroundColor), clip);
    const style = element.style;
    for (const side of SIDES) {
      const edge = side.toLowerCase();
      const borderStyle = style[`border${side}Style`] ?? style.borderStyle ?? "none";
      if (borderStyle === "none" || borderStyle === "hidden") continue;
      const thickness = border[edge];
      const rect = side === "Top"
        ? { x: borderBox.x, y: borderBox.y, width: borderBox.width, height: thickness }
        : side === "Right"
          ? { x: borderBox.x + borderBox.width - thickness, y: borderBox.y, width: thickness, height: borderBox.height }
          : side === "Bottom"
            ? { x: borderBox.x, y: borderBox.y + borderBox.height - thickness, width: borderBox.width, height: thickness }
            : { x: borderBox.x, y: borderBox.y, width: thickness, height: borderBox.height };
      const color = style[`border${side}Color`] ?? style.borderColor ?? "#000000";
      push(rect, parseColor(color), clip);
    }
  }
  return Buffer.from(new Float32Array(values).buffer);
}
