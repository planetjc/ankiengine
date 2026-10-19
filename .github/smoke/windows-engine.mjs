// Starts the installed Windows app and checks that its engine is running and
// stays up. The window cannot be read from here, so on failure the engine is
// run by hand, the way sidecar.rs runs it, to print what it says as it dies.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// Per-user by default, machine-wide if the installer was told to. The folder
// is named for the product (AnkiEngine; APE up to v0.3.2), the program in it
// for the Cargo binary, which kept its name.
const dir = [process.env.LOCALAPPDATA, process.env.ProgramFiles]
  .filter(Boolean)
  .map((d) => join(d, 'AnkiEngine'))
  .find((d) => existsSync(join(d, 'ape-app.exe')));
if (!dir) throw new Error('no installed AnkiEngine\\ape-app.exe, under LOCALAPPDATA or ProgramFiles');

function engine() {
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { $_.CommandLine }"],
    { encoding: 'utf8' },
  );
  return out.split(/\r?\n/).find((l) => l.includes(join('engine', 'sidecar')));
}

spawn(join(dir, 'ape-app.exe'), [], { detached: true, stdio: 'ignore' }).unref();

let seen;
for (let i = 0; i < 30 && !seen; i++) {
  await sleep(2000);
  seen = engine();
}
// Up, and still up past the app's own restart window (MIN_UPTIME_FOR_RESTART).
if (seen) await sleep(12000);
const running = seen && engine();
execFileSync('taskkill', ['/F', '/IM', 'ape-app.exe'], { stdio: 'ignore' });

if (running) {
  console.log(`engine running: ${running}`);
  process.exit(0);
}

console.log(`::error::the Windows app's engine is not running${seen ? ' (it started, then stopped)' : ''}. Run by hand, it says:`);
const child = spawn(join(dir, 'node.exe'), [join(dir, 'engine', 'sidecar', 'index.js')], {
  env: { ...process.env, APE_METHOD_DIR: join(dir, 'method') },
  stdio: ['pipe', 'inherit', 'inherit'],
});
child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"sidecar/ping"}\n');
setTimeout(() => child.stdin.end(), 5000);
child.on('exit', (code) => {
  console.log(`(exit code ${code})`);
  process.exit(1);
});
