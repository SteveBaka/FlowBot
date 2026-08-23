// electron-builder afterPack hook: trim the packaged app for Linux.
// The Docker image only consumes release/linux-unpacked, so everything the
// runtime never loads on linux is dropped here to shrink artifact and image.
// Run `git show HEAD:scripts/after-pack-trim.cjs` history if a future desktop
// linux build needs any of this back.

const fs = require('node:fs');
const path = require('node:path');

const KEEP_LOCALES = new Set(['zh-CN.pak', 'zh-TW.pak', 'en-US.pak']);
const KEEP_KOFFI_PLATFORMS = new Set(['linux_x64']);

function removeQuiet(target) {
  if (!fs.existsSync(target)) return 0;
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory()) {
    fs.rmSync(target, { force: true });
    return stat.size;
  }
  let freed = 0;
  for (const entry of fs.readdirSync(target)) {
    fs.rmSync(path.join(target, entry), { recursive: true, force: true });
  }
  fs.rmdirSync(target);
  return freed;
}

function dirSize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

function trimLocales(appDir) {
  const localesDir = path.join(appDir, 'locales');
  if (!fs.existsSync(localesDir)) return;
  for (const pak of fs.readdirSync(localesDir)) {
    if (!KEEP_LOCALES.has(pak)) {
      fs.rmSync(path.join(localesDir, pak), { force: true });
    }
  }
  console.log(`[after-pack-trim] locales kept: ${[...KEEP_LOCALES].join(', ')}`);
}

function trimUnpackedNodeModules(appDir) {
  const nm = path.join(appDir, 'resources', 'app.asar.unpacked', 'node_modules');

  // macOS speech runtime never loads on Linux (transcribe uses sherpa-onnx-linux-x64)
  removeQuiet(path.join(nm, 'sherpa-onnx-darwin-arm64'));

  // koffi ships prebuilds for ~19 platforms; only linux_x64 is used here
  const koffiBuild = path.join(nm, 'koffi', 'build', 'koffi');
  if (fs.existsSync(koffiBuild)) {
    for (const platformDir of fs.readdirSync(koffiBuild)) {
      if (!KEEP_KOFFI_PLATFORMS.has(platformDir)) {
        fs.rmSync(path.join(koffiBuild, platformDir), { recursive: true, force: true });
      }
    }
  }
  console.log('[after-pack-trim] removed sherpa-onnx-darwin-arm64 + non-linux koffi prebuilds');
}

function trimBundledLicenseDoc(appDir) {
  // Aggregated Chromium OSS license doc (~19MB), never read at runtime.
  // License texts also remain in LICENSE.electron.txt / the upstream project.
  removeQuiet(path.join(appDir, 'LICENSES.chromium.html'));
}

function trimDuplicateResourcesFonts(appDir) {
  // resources/fonts is duplicated into the package by the blanket
  // resources/ -> resources/ extraResources mapping, but the renderer loads
  // the vite-hashed copies from dist/assets and no main-process code or
  // worker reads fonts from here.
  removeQuiet(path.join(appDir, 'resources', 'resources', 'fonts'));
}

function trimPatchedWcdbBackups(appDir) {
  // Local patch runs (scripts/patch-wcdb-deadline.py) may leave a
  // *.deadline-orig backup next to the source .so in resources/wcdb;
  // the Docker image patches its own copy with --no-backup, so never
  // ship these leftovers.
  const wcdbDir = path.join(appDir, 'resources', 'resources', 'wcdb');
  if (!fs.existsSync(wcdbDir)) return;
  for (const candidate of findFiles(wcdbDir, /\.deadline-orig$/)) {
    fs.rmSync(candidate, { force: true });
  }
}

function findFiles(dir, pattern) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findFiles(full, pattern));
    else if (pattern.test(entry.name)) out.push(full);
  }
  return out;
}

function fixFfmpegStaticExecBit(appDir) {
  // 历史遗留 bug：产物中 ffmpeg-static 一直是 644，spawn 返回 EACCES，
  // 图片解密的 ffmpeg 分支自首个镜像起即静默失败。补 755。
  const target = path.join(
    appDir, 'resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg'
  )
  try {
    if (fs.existsSync(target)) {
      fs.chmodSync(target, 0o755)
      console.log('[after-pack-trim] ffmpeg-static exec bit set to 755')
    }
  } catch (e) {
    console.error('[after-pack-trim] chmod ffmpeg-static failed:', e && e.message)
  }
}

function main(context) {
  if (context.electronPlatformName !== 'linux') {
    console.log(`[after-pack-trim] platform ${context.electronPlatformName} — nothing to trim`);
    return;
  }
  // AfterPackContext exposes appOutDir (= release/linux-unpacked), not appDir
  const appDir = context.appOutDir;
  const before = dirSize(appDir);

  trimLocales(appDir);
  trimUnpackedNodeModules(appDir);
  trimBundledLicenseDoc(appDir);
  trimDuplicateResourcesFonts(appDir);
  trimPatchedWcdbBackups(appDir);
  fixFfmpegStaticExecBit(appDir);

  const after = dirSize(appDir);
  console.log(
    `[after-pack-trim] app dir ${appDir}: ${(before / 1048576).toFixed(0)}MB -> ${(after / 1048576).toFixed(0)}MB (freed ${((before - after) / 1048576).toFixed(0)}MB)`
  );
}

module.exports = main;
