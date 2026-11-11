/**
 * Host platform helpers shared by Node desktop/Android and NastyOS preview.
 * NastyOS shims activate only when the platform is `nastyos`.
 */

function envPlatform() {
  if (typeof process === "undefined" || !process.env) return null;
  const forced = process.env.NASTY_PLATFORM || process.env.NASTYOS_PLATFORM;
  return forced || null;
}

/** @returns {"android"|"nastyos"|"linux"|"win32"|"darwin"|string} */
export function hostPlatform() {
  const forced = envPlatform();
  if (forced) return forced;
  if (typeof process === "undefined") return "unknown";
  return process.platform;
}

export function isNastyOS() {
  return hostPlatform() === "nastyos";
}

/** Fullscreen single-viewport hosts (Android NativeActivity, NastyOS). */
export function isFullscreenHost() {
  const p = hostPlatform();
  return p === "android" || p === "nastyos";
}

/** Tailwind `hostKind`: mobile on fullscreen hosts, else desktop. */
export function defaultHostKind() {
  return isFullscreenHost() ? "mobile" : "desktop";
}

/**
 * Tailwind OS variant kind: win | lin | mac | android | nastyos.
 * NastyOS is its own token so `lin:` utilities do not accidentally apply.
 */
export function defaultOsKind() {
  const p = hostPlatform();
  if (p === "win32") return "win";
  if (p === "darwin") return "mac";
  if (p === "android") return "android";
  if (p === "nastyos") return "nastyos";
  if (p === "linux") return "lin";
  return null;
}
