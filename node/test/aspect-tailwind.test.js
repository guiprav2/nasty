import assert from "node:assert/strict";
import { resolveTailwind } from "../tailwind.js";
import { test } from "node:test";

test("named aspect utilities", () => {
  assert.equal(resolveTailwind("aspect-auto").aspectRatio, "auto");
  assert.equal(resolveTailwind("aspect-square").aspectRatio, "1 / 1");
  assert.equal(resolveTailwind("aspect-video").aspectRatio, "16 / 9");
});

test("arbitrary aspect-[w/h] fractions", () => {
  assert.equal(resolveTailwind("aspect-[3/4]").aspectRatio, "3 / 4");
  assert.equal(resolveTailwind("aspect-[16/9]").aspectRatio, "16 / 9");
  assert.equal(resolveTailwind("aspect-[1/1]").aspectRatio, "1 / 1");
  assert.equal(resolveTailwind("aspect-[2.35/1]").aspectRatio, "2.35 / 1");
});

test("arbitrary aspect numeric and auto", () => {
  assert.equal(resolveTailwind("aspect-[1.5]").aspectRatio, "1.5");
  assert.equal(resolveTailwind("aspect-[auto]").aspectRatio, "auto");
});

test("aspect-[3/4] is not mistaken for a spacing percentage", () => {
  const styles = resolveTailwind("aspect-[3/4]");
  assert.equal(styles.aspectRatio, "3 / 4");
  assert.equal(styles.width, undefined);
  assert.equal(styles.height, undefined);
});
