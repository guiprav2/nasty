import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultHostKind,
  defaultOsKind,
  hostPlatform,
  isFullscreenHost,
  isNastyOS,
} from "../internal/platform.js";
import {
  getTailwindOsKind,
  resolveTailwind,
  setTailwindHostKind,
  setTailwindOsKind,
} from "../tailwind.js";

test.afterEach(() => {
  setTailwindHostKind("desktop");
  setTailwindOsKind(null);
});

test("platform helpers treat NASTY_PLATFORM=nastyos as NastyOS", async (t) => {
  // Child-process style: these helpers read process.env / process.platform live.
  const prev = process.env.NASTY_PLATFORM;
  t.after(() => {
    if (prev === undefined) delete process.env.NASTY_PLATFORM;
    else process.env.NASTY_PLATFORM = prev;
  });
  process.env.NASTY_PLATFORM = "nastyos";
  assert.equal(hostPlatform(), "nastyos");
  assert.equal(isNastyOS(), true);
  assert.equal(isFullscreenHost(), true);
  assert.equal(defaultHostKind(), "mobile");
  assert.equal(defaultOsKind(), "nastyos");
});

test("nastyos: utilities apply only for nastyos os kind", () => {
  setTailwindOsKind("nastyos");
  setTailwindHostKind("mobile");
  assert.equal(getTailwindOsKind(), "nastyos");
  assert.equal(resolveTailwind("nastyos:opacity-50").opacity, 0.5);
  assert.equal(resolveTailwind("lin:opacity-50").opacity, undefined);
  assert.equal(resolveTailwind("android:opacity-50").opacity, undefined);
});
