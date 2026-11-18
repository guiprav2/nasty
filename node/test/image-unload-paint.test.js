import assert from "node:assert/strict";
import test from "node:test";
import { Document } from "../index.js";
import { unloadImage } from "../image-decoder.js";
import { clearPaintSegments, validTextureId } from "../render.js";
import { elementState } from "../internal/dom-state.js";
import { layerTextRunPairs } from "../internal/dom-text.js";

test("validTextureId rejects non-positive and non-integer ids", () => {
  assert.equal(validTextureId(1), true);
  assert.equal(validTextureId(42), true);
  assert.equal(validTextureId(0), false);
  assert.equal(validTextureId(-3), false);
  assert.equal(validTextureId(1.5), false);
  assert.equal(validTextureId(NaN), false);
  assert.equal(validTextureId(Infinity), false);
  assert.equal(validTextureId(undefined), false);
  assert.equal(validTextureId(null), false);
});

test("unloadImage deletes the texture and clears paint caches", () => {
  const doc = new Document();
  const img = doc.createElement("img");
  doc.body.appendChild(img);
  elementState(img).image = { textureId: 99, width: 16, height: 16 };
  const deleted = [];
  const window = {
    deleteImageTexture(id) {
      deleted.push(id);
      return true;
    },
  };
  assert.equal(unloadImage(img, window), true);
  assert.deepEqual(deleted, [99]);
  assert.equal(elementState(img).image, null);
  // Idempotent once the image state is gone.
  assert.equal(unloadImage(img, window), false);
  clearPaintSegments(img);
});

test("layerTextRunPairs returns an empty list for unprepared windows", () => {
  assert.deepEqual(layerTextRunPairs({}, [{ localName: "span" }]), []);
  assert.deepEqual(layerTextRunPairs({}, []), []);
});
