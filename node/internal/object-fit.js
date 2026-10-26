// CSS object-fit / object-position for replaced content (img, video).
// Returns a destination rect in content-box coordinates and normalized UVs.
// Dest may extend outside the box; callers clip to the content box.

function positionFraction(value, fallback) {
  if (value === "left" || value === "top") return 0;
  if (value === "right" || value === "bottom") return 1;
  if (value === "center") return 0.5;
  if (value?.endsWith("%")) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n / 100 : fallback;
  }
  return fallback;
}

/** Parse object-position into [x, y] fractions of (container − object). */
export function objectPositionFractions(value) {
  const values = String(value ?? "50% 50%").trim().split(/\s+/).filter(Boolean);
  if (values.length >= 2) {
    return [positionFraction(values[0], 0.5), positionFraction(values[1], 0.5)];
  }
  if (values.length === 1) {
    const v = values[0];
    if (v === "top" || v === "bottom") return [0.5, positionFraction(v, 0.5)];
    if (v === "left" || v === "right") return [positionFraction(v, 0.5), 0.5];
    if (v === "center") return [0.5, 0.5];
    return [positionFraction(v, 0.5), 0.5];
  }
  return [0.5, 0.5];
}

/**
 * @param {number} imageWidth
 * @param {number} imageHeight
 * @param {number} boxWidth
 * @param {number} boxHeight
 * @param {string} [fit]
 * @param {number} [positionX]
 * @param {number} [positionY]
 * @returns {{ x: number, y: number, width: number, height: number, u0: number, v0: number, u1: number, v1: number }}
 */
export function objectFitLayout(imageWidth, imageHeight, boxWidth, boxHeight, fit = "fill", positionX = 0.5, positionY = 0.5) {
  const iw = Math.max(0, Number(imageWidth) || 0);
  const ih = Math.max(0, Number(imageHeight) || 0);
  const bw = Math.max(0, Number(boxWidth) || 0);
  const bh = Math.max(0, Number(boxHeight) || 0);
  let mode = String(fit || "fill").toLowerCase();
  if (mode === "scale-down") {
    mode = iw <= bw && ih <= bh ? "none" : "contain";
  }

  let width;
  let height;
  if (mode === "none") {
    width = iw;
    height = ih;
  } else if (mode === "contain" || mode === "cover") {
    if (iw <= 0 || ih <= 0 || bw <= 0 || bh <= 0) {
      width = bw;
      height = bh;
    } else {
      const scale = mode === "contain"
        ? Math.min(bw / iw, bh / ih)
        : Math.max(bw / iw, bh / ih);
      width = iw * scale;
      height = ih * scale;
    }
  } else {
    // fill (default) and unknown values stretch to the content box
    width = bw;
    height = bh;
  }

  const x = (bw - width) * positionX;
  const y = (bh - height) * positionY;
  return { x, y, width, height, u0: 0, v0: 0, u1: 1, v1: 1 };
}
