import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { collectAppFiles } from './collect-app.js';
import { ensureLinuxRuntimeBase } from './build-linux-runtime.js';
import { appendOverlay, createAppArchive } from './overlay.js';
import { repoPaths, resetDir } from './layout.js';
import { artifactName } from './targets.js';

/**
 * Pack linux-x64 as: cached runtime AppImage + appended app tar.gz overlay.
 * Same trailer format Webfoundry #2 will use when exporting from the browser.
 *
 * @param {object} opts
 * @param {string} opts.appDir
 * @param {string} opts.nodeDir
 * @param {string} opts.name
 * @param {string} opts.entry
 * @param {string} opts.outDir
 * @param {boolean} opts.skipNativeBuild
 * @param {boolean} [opts.rebuildRuntime]
 */
export async function packLinuxAppImage(opts) {
  const { appDir, nodeDir, name, entry, outDir, skipNativeBuild, rebuildRuntime = false } = opts;
  const { stagingRoot } = repoPaths(nodeDir);
  const outPath = join(outDir, artifactName('linux-x64', name));
  const files = collectAppFiles({ appDir, entry, outputArtifact: outPath });

  const base = await ensureLinuxRuntimeBase({
    nodeDir,
    skipNativeBuild,
    rebuild: rebuildRuntime,
    appDirForIcon: appDir,
  });

  const stage = join(stagingRoot, `overlay-${process.pid}`);
  resetDir(stage);
  try {
    const archivePath = join(stage, 'app.tar.gz');
    const appStage = join(stage, 'app');
    createAppArchive({ appDir, files, entry, archivePath, stageDir: appStage });

    mkdirSync(outDir, { recursive: true });
    rmSync(outPath, { force: true });
    await appendOverlay(base, archivePath, outPath);
    chmodSync(outPath, 0o755);

    console.log(outPath);
    return outPath;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
