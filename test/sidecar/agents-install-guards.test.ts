// What went wrong when an owner pressed "Update to 0.94.0" for Claude on a slow
// connection: the download took minutes, a second press started a second npm
// in the same folder, that one failed (ENOTEMPTY, on a folder an install cut
// short on Oct 5 had left behind) and its rollback took the first one's
// half-written Claude program with it -- after which the first finished
// "successfully" without it, since npm drops an optional package it could not
// install. The error shown was npm's last line, which only says where the log is.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { clearRetired, installAgent, missingPlatformPackages, npmError, type RegistryEntry } from '../../dist/agents/index.js';
import { makeTmpDir } from './helpers.ts';

test('npmError: the line that says what went wrong, not where the log is', () => {
  const enotempty = [
    'npm error code ENOTEMPTY',
    'npm error syscall rename',
    "npm error path /x/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64",
    "npm error dest /x/node_modules/@anthropic-ai/.claude-agent-sdk-darwin-arm64-grJryrAX",
    'npm error errno -66',
    "npm error ENOTEMPTY: directory not empty, rename '/x/a' -> '/x/.a-grJryrAX'",
    'npm error A complete log of this run can be found in: /Users/me/.npm/_logs/2026-10-20T01_20_17_398Z-debug-0.log',
  ];
  assert.equal(npmError(enotempty), "ENOTEMPTY: directory not empty, rename '/x/a' -> '/x/.a-grJryrAX'");
  const e404 = [
    'npm error code E404',
    'npm error 404 Not Found - GET https://registry.npmjs.org/@x%2fy - Not found',
    'npm error 404',
    'npm error A complete log of this run can be found in: /tmp/log',
  ];
  assert.equal(npmError(e404), '404 Not Found - GET https://registry.npmjs.org/@x%2fy - Not found');
  assert.equal(npmError(['npm error code EACCES', 'npm error A complete log of this run can be found in: /tmp/log']), 'code EACCES');
  assert.equal(npmError(['something else entirely']), 'something else entirely');
  assert.equal(npmError([]), '');
});

test('clearRetired removes what an install cut short left behind, and nothing else', () => {
  const prefix = makeTmpDir();
  const nm = join(prefix, 'node_modules');
  for (const d of ['.claude-agent-sdk-lEJHKsRN', '@anthropic-ai/.claude-agent-sdk-darwin-arm64-grJryrAX', '@anthropic-ai/.sdk-4mateDH2', '.bin', 'kept', '@anthropic-ai/sdk']) {
    mkdirSync(join(nm, d), { recursive: true });
  }
  writeFileSync(join(nm, '.package-lock.json'), '{}');
  writeFileSync(join(nm, '.file-ABCDEFGH'), 'a file, not a retired package');
  const removed = clearRetired(prefix).map((p) => p.slice(nm.length + 1)).sort();
  assert.deepEqual(removed, ['.claude-agent-sdk-lEJHKsRN', '@anthropic-ai/.claude-agent-sdk-darwin-arm64-grJryrAX', '@anthropic-ai/.sdk-4mateDH2']);
  for (const kept of ['.bin', 'kept', '@anthropic-ai/sdk', '.package-lock.json', '.file-ABCDEFGH']) assert.ok(existsSync(join(nm, kept)), kept);
  assert.deepEqual(clearRetired(makeTmpDir()), [], 'no node_modules yet: nothing to do');
});

test('missingPlatformPackages names an optional package for this platform that npm left out', () => {
  const prefix = makeTmpDir();
  const nm = join(prefix, 'node_modules');
  mkdirSync(join(nm, '@anthropic-ai', 'claude-agent-sdk'), { recursive: true });
  writeFileSync(
    join(nm, '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
    JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', optionalDependencies: { '@anthropic-ai/claude-agent-sdk-darwin-arm64': '1', '@anthropic-ai/claude-agent-sdk-linux-x64': '1', '@esbuild/darwin-arm64': '1' } }),
  );
  assert.deepEqual(missingPlatformPackages(prefix, 'darwin', 'arm64').sort(), ['@anthropic-ai/claude-agent-sdk-darwin-arm64', '@esbuild/darwin-arm64']);
  assert.deepEqual(missingPlatformPackages(prefix, 'linux', 'x64'), ['@anthropic-ai/claude-agent-sdk-linux-x64']);
  assert.deepEqual(missingPlatformPackages(prefix, 'win32', 'x64'), [], 'nothing built for this platform is asked for');

  for (const dep of ['@anthropic-ai/claude-agent-sdk-darwin-arm64', '@esbuild/darwin-arm64']) {
    mkdirSync(join(nm, dep), { recursive: true });
    writeFileSync(join(nm, dep, 'package.json'), '{}');
  }
  assert.deepEqual(missingPlatformPackages(prefix, 'darwin', 'arm64'), []);
  assert.deepEqual(missingPlatformPackages(makeTmpDir()), [], 'no node_modules yet: nothing missing');
});

// A stand-in for npm: counts its runs, takes a moment, and installs a package
// with a bin -- enough for installAgent to call the install good.
function fakeNpm(dir: string): string {
  const cli = join(dir, 'fake-npm-cli.mjs');
  writeFileSync(
    cli,
    `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const prefix = args[args.indexOf('--prefix') + 1];
appendFileSync(join(${JSON.stringify(dir)}, 'runs'), 'run\\n');
await new Promise((r) => setTimeout(r, 300));
const pkg = join(prefix, 'node_modules', 'fake-agent');
mkdirSync(pkg, { recursive: true });
writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'fake-agent', version: '1.2.3', bin: { 'fake-agent': 'cli.js' } }));
writeFileSync(join(pkg, 'cli.js'), '');
`,
  );
  return cli;
}

test('a second install while one runs gets the first one, not a second npm', async () => {
  const work = makeTmpDir();
  const dataDir = makeTmpDir();
  const before = process.env.APE_NPM_CLI;
  process.env.APE_NPM_CLI = fakeNpm(work);
  try {
    const entry: RegistryEntry = { id: 'fake-agent', name: 'Fake', description: '', version: '1.2.3', distribution: 'npx', npx: { package: 'fake-agent', args: [], env: {} } };
    // What an install cut short leaves: it would make a real npm fail with ENOTEMPTY.
    const retired = join(dataDir, 'npx', 'fake-agent', 'node_modules', '.fake-agent-AbCd1234');
    mkdirSync(retired, { recursive: true });

    const first = installAgent(dataDir, entry);
    const second = installAgent(dataDir, entry);
    assert.equal(second, first, 'the same promise');
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.equal(a.version, '1.2.3');
    assert.equal(readFileSync(join(work, 'runs'), 'utf8'), 'run\n', 'npm ran once');
    assert.ok(!existsSync(retired), 'the leftover was cleared before npm ran');

    // Once settled, a new install runs again.
    await installAgent(dataDir, entry);
    assert.equal(readFileSync(join(work, 'runs'), 'utf8'), 'run\nrun\n');
  } finally {
    if (before === undefined) delete process.env.APE_NPM_CLI;
    else process.env.APE_NPM_CLI = before;
  }
});
