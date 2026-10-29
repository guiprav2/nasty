// V8 builds a new ICU collator for every String.prototype.localeCompare call
// that passes locales or options, which made sorting a few hundred file names
// cost several milliseconds per update. ECMA-402 defines that call as
// `new Intl.Collator(locales, options).compare(String(this), String(that))`,
// so reusing the collator for identical (locales, options) gives identical
// results. Anything unusual (getters, non-primitive values, locale arrays)
// goes to the builtin.
const builtin = String.prototype.localeCompare;
const collators = new Map();

function optionsKey(options) {
  if (options === undefined) return "";
  if (options === null || typeof options !== "object" || Object.getPrototypeOf(options) !== Object.prototype) return null;
  let key = "";
  for (const name of Object.keys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, name);
    if (!("value" in descriptor)) return null;
    const value = descriptor.value;
    const type = typeof value;
    if (value !== undefined && type !== "string" && type !== "boolean" && type !== "number") return null;
    key += `${name}=${type}:${String(value)};`;
  }
  return key;
}

function localeCompare(that) {
  const locales = arguments[1], options = arguments[2];
  if (this == null || (locales === undefined && options === undefined)
      || (locales !== undefined && typeof locales !== "string")) {
    return builtin.apply(this, arguments);
  }
  const options_ = optionsKey(options);
  if (options_ === null) return builtin.apply(this, arguments);
  const key = `${locales ?? ""}\0${options_}`;
  let collator = collators.get(key);
  if (!collator) {
    collator = new Intl.Collator(locales, options);
    collators.set(key, collator);
    if (collators.size > 64) collators.delete(collators.keys().next().value);
  }
  return collator.compare(String(this), String(that));
}

Object.defineProperty(String.prototype, "localeCompare", { value: localeCompare, writable: true, enumerable: false, configurable: true });
