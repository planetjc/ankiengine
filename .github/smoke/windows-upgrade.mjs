// Upgrades the Windows app the way a user on the previous release does, on a
// clean machine: installs that release, puts a file where the app keeps its
// data, installs this tag's build over it as the updater does, and checks what
// is left. The updater runs the installer with /P /UPDATE (tauri-plugin-updater,
// updater.rs); this uses /S /UPDATE, the same install without the progress
// window. In update mode the installer makes no shortcuts of its own, so the
// new Start menu and desktop shortcuts are the hook's to make.
//
//   GH_TOKEN=... GITHUB_REF_NAME=<tag> GITHUB_REPOSITORY=<owner/repo> node .github/smoke/windows-upgrade.mjs
//
// The NSIS installer takes its install folder, its Start menu shortcut and its
// uninstall entry from the productName, so renaming APE to AnkiEngine moved
// the install from %LOCALAPPDATA%\APE to %LOCALAPPDATA%\AnkiEngine. Installed
// plainly, the new build would sit beside the old app, listed twice in
// Installed apps, with a second shortcut that starts the old one.
// app/src-tauri/windows/installer-hooks.nsh removes the old install, and this
// is the check that it does. The bundle identifier did not change, so the
// user's data in %APPDATA%\com.ankiengine.ape and %LOCALAPPDATA%\com.ankiengine.ape
// is where the new build looks for it, provided the hook leaves it alone.
//
// A previous release already named AnkiEngine is a plain upgrade, and the
// same checks hold. With no previous release, or none that has a Windows
// installer, there is nothing to upgrade from: it says so and installs this
// build alone.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const { GITHUB_REF_NAME: tag, GITHUB_REPOSITORY: repo, LOCALAPPDATA: local, APPDATA: roaming } = process.env;
if (!tag || !repo || !local || !roaming) {
  console.error('usage: windows-upgrade.mjs, with GITHUB_REF_NAME, GITHUB_REPOSITORY, LOCALAPPDATA and APPDATA in the environment');
  process.exit(2);
}

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const newDir = join(local, 'AnkiEngine');
const oldDir = join(local, 'APE');
const hasKey = (name) =>
  spawnSync('reg', ['query', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${name}`], { stdio: 'ignore' }).status === 0;
const programs = (base) => join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
const startMenu = [programs(roaming), programs(process.env.ProgramData ?? 'C:\\ProgramData')];
const shortcuts = (name, roots) =>
  roots
    .filter(existsSync)
    .flatMap((root) => readdirSync(root, { recursive: true }).filter((f) => basename(f).toLowerCase() === name.toLowerCase()).map((f) => join(root, f)));

let bad = 0;
const fail = (message) => {
  console.log(`::error::${message}`);
  bad = 1;
};

// Start-Process -Wait, because the setup program can return to a shell before
// the installer has finished, and the next step reads what it leaves.
function install(exe, what, args = '/S') {
  console.log(`installing ${what} (${args})`);
  const run = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', '$p = Start-Process -FilePath $env:SETUP_EXE -ArgumentList $env:SETUP_ARGS -Wait -PassThru; exit $p.ExitCode'],
    { env: { ...process.env, SETUP_EXE: exe, SETUP_ARGS: args }, stdio: 'inherit' },
  );
  if (run.status !== 0) {
    console.log(`::error::the installer for ${what} exited with ${run.error?.message ?? run.status ?? run.signal}; nothing below it can be checked`);
    process.exit(1);
  }
}

// Each release into its own folder: two releases both carry an
// AnkiEngine-windows-x64-setup.exe.
const work = mkdtempSync(join(tmpdir(), 'upgrade-'));
function download(from, name) {
  mkdirSync(join(work, from), { recursive: true });
  try {
    gh('release', 'download', from, '--repo', repo, '--pattern', name, '--dir', join(work, from));
  } catch {
    console.log(`::error::${from} has no ${name} to install`);
    process.exit(1);
  }
  return join(work, from, name);
}

const next = download(tag, 'AnkiEngine-windows-x64-setup.exe');

// The release before this one is the highest promoted version below the tag,
// not simply the newest other release: re-running an older tag must not
// "upgrade" from a release that came after it.
const byVersion = new Intl.Collator('en', { numeric: true }).compare;
const promoted = JSON.parse(gh('release', 'list', '--repo', repo, '--exclude-drafts', '--exclude-pre-releases', '--limit', '100', '--json', 'tagName'));
const previous = promoted
  .map((r) => r.tagName)
  .filter((t) => byVersion(t, tag) < 0)
  .sort(byVersion)
  .pop();

const dataDirs = [join(roaming, 'com.ankiengine.ape'), join(local, 'com.ankiengine.ape')];
const markers = [];
const desktops = [join(process.env.USERPROFILE ?? '', 'Desktop'), join(process.env.PUBLIC ?? 'C:\\Users\\Public', 'Desktop')];
let hadDesktop = false;

if (!previous) {
  console.log(`::notice::no promoted release before ${tag}, so there is no upgrade to test; installing it alone`);
} else {
  const names = JSON.parse(gh('release', 'view', previous, '--repo', repo, '--json', 'assets')).assets.map((a) => a.name);
  // The stable name is APE-windows-x64-setup.exe up to v0.3.2, AnkiEngine-... after.
  const setup = names.find((n) => n.endsWith('-windows-x64-setup.exe'));
  if (!setup) {
    console.log(`::warning::${previous} has no *-windows-x64-setup.exe, so the upgrade from it is not tested; installing ${tag} alone`);
  } else {
    install(download(previous, setup), `${previous} (${setup})`);

    // The file name says which folder that release installs to. Going by
    // whatever is on disk instead would pass an installer that put nothing
    // where it should.
    const was = setup.startsWith('APE-') ? 'APE' : 'AnkiEngine';
    const wasExe = join(local, was, 'ape-app.exe');
    if (!existsSync(wasExe)) {
      fail(`${previous}'s installer left no ${wasExe}, so this cannot show an upgrade`);
      process.exit(1);
    }
    // What the removal checks below would otherwise pass without having seen.
    if (was === 'APE') {
      if (!hasKey('APE')) console.log(`::warning::${previous} left no APE entry under HKCU Uninstall; the check below that it is removed proves nothing`);
      if (shortcuts('APE.lnk', startMenu).length === 0) console.log(`::warning::${previous} left no APE.lnk in the Start menu; the check below that it is moved proves nothing`);
      hadDesktop = shortcuts('APE.lnk', desktops).length > 0;
    }

    // Stands for the user's decks and settings: the upgrade must not touch it.
    for (const dir of dataDirs) {
      const marker = join(dir, 'upgrade-marker.txt');
      mkdirSync(dirname(marker), { recursive: true });
      writeFileSync(marker, `written after installing ${previous}, before the upgrade to ${tag}\n`);
      markers.push(marker);
    }
  }
}

// Over an earlier install, the way the updater runs it; alone, the way a new
// user runs it.
install(next, `${tag} (AnkiEngine-windows-x64-setup.exe)`, markers.length ? '/S /UPDATE' : '/S');

const exe = join(newDir, 'ape-app.exe');
if (!existsSync(exe)) fail(`${tag}'s installer left no ${exe}`);
if (!hasKey('AnkiEngine')) fail(`${tag}'s installer wrote no AnkiEngine entry under HKCU Uninstall; it will not be listed in Installed apps`);

// What the installer of the APE-named builds left, which the hook removes.
if (existsSync(oldDir)) {
  fail(`${oldDir} is still there (${readdirSync(oldDir).join(', ') || 'empty'}); the old install is meant to be removed on upgrade`);
}
if (hasKey('APE')) fail('HKCU Uninstall\\APE is still there; Installed apps lists the old app beside the new one');
for (const lnk of [...shortcuts('APE.lnk', startMenu), ...shortcuts('APE.lnk', desktops)]) {
  fail(`${lnk} is still there; it starts the old app, which would offer this update again`);
}
// In update mode the hook makes these; on a fresh install, the installer does.
if (shortcuts('AnkiEngine.lnk', startMenu).length === 0) fail('no AnkiEngine.lnk in the Start menu; nothing starts the new app');
if (hadDesktop && shortcuts('AnkiEngine.lnk', desktops).length === 0) {
  fail('the old install had a desktop shortcut and the new one has none');
}

for (const marker of markers) {
  if (!existsSync(marker)) fail(`${marker} is gone: the upgrade deleted what the app keeps for the user`);
}

if (bad) process.exit(1);
console.log(
  previous && markers.length
    ? `upgraded ${previous} to ${tag}: AnkiEngine installed, the old install gone, user data kept`
    : `${tag} installed: AnkiEngine in place, no old install left`,
);
