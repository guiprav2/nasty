const CSS_LENGTH = /^([+]?(?:\d+\.?\d*|\.\d+))(px|%)$/i;

export function validateWindowDimension(value, axis) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`${axis} must be a nonnegative finite dimension`);
    return;
  }
  if (typeof value !== "string") throw new TypeError(`${axis} must be a pixel number or a px/% CSS dimension`);
  const text = value.trim();
  if (text === "0" || CSS_LENGTH.test(text)) return;
  throw new TypeError(`invalid ${axis}: expected a nonnegative px or % dimension`);
}

export function resolveWindowDimension(value, axis, viewport, percentBase = viewport[axis]) {
  validateWindowDimension(value, axis);
  if (typeof value === "number") return value;
  const text = value.trim();
  if (text === "0") return 0;
  const [, amountText, unit] = CSS_LENGTH.exec(text);
  const amount = Number(amountText);
  return unit.toLowerCase() === "px" ? amount : amount * percentBase / 100;
}
