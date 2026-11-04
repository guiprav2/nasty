/**
 * Windows win-x64 packaging via Node SEA + native addon sidecar.
 * Not implemented in deliverable #1 (linux-x64 AppImage validation cut).
 */
export async function packWinSea() {
  const err = new Error(
    [
      'nasty-bundle --target win-x64 is not implemented yet.',
      'Planned approach: Node Single Executable Application (SEA) with nasty.node extracted at runtime (sidecar).',
      'Requires a Windows Node binary (prefer Node 26+ for `node --build-sea`), cross-compiled nasty-native',
      '(x86_64-pc-windows-gnu), and optional icons/icon.ico branding.',
      'Use --target linux-x64 on this host for the current validation cut.',
    ].join('\n'),
  );
  err.code = 'NASTY_BUNDLE_STUB';
  throw err;
}
