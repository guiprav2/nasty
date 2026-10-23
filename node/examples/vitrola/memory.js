import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function createMemory(file) {
  let stored = {};
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed;
  } catch { /* first run */ }
  let chain = Promise.resolve();

  function locked(fn) {
    const pending = chain.then(fn, fn);
    chain = pending.then(() => {}, () => {});
    return pending;
  }

  async function save() {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(stored), { mode: 0o600 });
    await rename(temporary, file);
  }

  function clip(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
  }

  return {
    remember(key, value) {
      return locked(async () => {
        const name = clip(key).slice(0, 80);
        const note = clip(value);
        if (!name || !note) return { ok: false, error: "key and value are required" };
        stored[name] = note;
        const keys = Object.keys(stored);
        if (keys.length > 80) delete stored[keys[0]];
        await save();
        return { ok: true, key: name };
      });
    },
    recall(key) {
      return locked(async () => {
        const name = clip(key);
        if (!name) {
          const entries = Object.entries(stored).slice(-40).map(([entryKey, entryValue]) => ({ key: entryKey, value: entryValue }));
          return { ok: true, entries };
        }
        const value = stored[name];
        if (!value) return { ok: false, error: `Nothing stored under “${name}”.` };
        return { ok: true, key: name, value };
      });
    },
    forget(key) {
      return locked(async () => {
        const name = clip(key);
        if (!name || !stored[name]) return { ok: false, error: "Nothing stored under that key." };
        delete stored[name];
        await save();
        return { ok: true, key: name };
      });
    },
    async text() {
      const entries = Object.entries(stored);
      if (!entries.length) return "Memory: empty.";
      return ["Memory:"].concat(entries.slice(-24).map(([key, value]) => `- ${key}: ${value}`)).join("\n");
    },
  };
}
