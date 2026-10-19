#!/usr/bin/env node
// `ankiengine-bridge`: the sidecar as a local server, so the browser page can
// drive an agent that runs on this machine -- see docs/APP.md, "Stage 3".
// (`ape-bridge`, the first name for the same file, still works.)
//
// A web page cannot launch Claude Code; that is the browser sandbox. This is
// the one process a subscriber runs so that the page has something to talk
// to: it serves src/sidecar over HTTP on loopback (serve.ts), prints a URL
// carrying a per-run token in the fragment, and opens it. Everything the
// desktop app's Rust shell did -- own the sidecar, hand it the method files,
// name the data directory -- happens here, in one file, with no Rust and no
// bundled Node. The Node a Claude Code user already has is enough: nothing
// here needs more than 20, because the one method that does (`deck/export`,
// via node:sqlite) loads lazily and the page can do that job itself.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveSidecar, type SidecarServer } from '../sidecar/serve.js';
import type { SidecarInfo } from '../sidecar/methods.js';

const NODE_FLOOR = 20;
const DEFAULT_PORT = 9100;
const DEFAULT_SITE = 'https://ankiengine.com/tool/';
// The method is prose that lives in its own repository and is read at run
// time, unmodified (docs/APP.md). The desktop app bundles a copy at build
// time; a package installed with npx has no build step on the user's machine,
// so the bridge fetches the same files once into its data directory.
const METHOD_RAW = 'https://raw.githubusercontent.com/planetjc/anki-process-engine-live/main/';
// SETUP.md sits at the repository root, not in method/, and 1-extract.md
// sends the agent to it by name for the slide-conversion commands. Left out,
// the first live run from the website watched the agent search skills/ and
// .claude/ for it -- a permission prompt for a file we could have handed over.
const METHOD_FILES: { name: string; from: string }[] = [
  { name: '1-extract.md', from: 'method/1-extract.md' },
  { name: '2-organize.md', from: 'method/2-organize.md' },
  { name: '3-cards.md', from: 'method/3-cards.md' },
  { name: '4-audit.md', from: 'method/4-audit.md' },
  { name: 'SETUP.md', from: 'SETUP.md' },
];

interface Args {
  courseDir: string | null;
  port: number;
  site: string;
  open: boolean;
  allowOrigins: string[];
  refreshMethod: boolean;
  help: boolean;
}

function usage(): string {
  return `usage: ankiengine-bridge [course-folder] [options]

  course-folder        the folder of lecture material to work on (optional; the page can ask)

  --port <n>           listen on this loopback port (default ${DEFAULT_PORT}; 0 picks a free one)
  --site <url>         the page to open (default ${DEFAULT_SITE})
  --allow-origin <o>   additionally allow this page origin (repeatable; for local development)
  --no-open            print the URL but do not open a browser
  --refresh-method     re-download the method files even if present
  -h, --help

environment:
  APE_METHOD_DIR       use these method files instead of the downloaded copy
  APE_DATA_DIR         where agents are installed and method files cached
  APE_SITE_URL         same as --site
`;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    courseDir: null,
    port: DEFAULT_PORT,
    site: process.env.APE_SITE_URL ?? DEFAULT_SITE,
    open: true,
    allowOrigins: [],
    refreshMethod: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--port') args.port = Number(next());
    else if (a === '--site') args.site = next();
    else if (a === '--allow-origin') args.allowOrigins.push(next());
    else if (a === '--no-open') args.open = false;
    else if (a === '--refresh-method') args.refreshMethod = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else if (args.courseDir === null) args.courseDir = resolve(a);
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) throw new Error('--port must be 0-65535');
  return args;
}

function packageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { version?: string };
  return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
}

/** Same location per platform as the desktop app's data directory. */
function dataDir(): string {
  if (process.env.APE_DATA_DIR) return process.env.APE_DATA_DIR;
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'com.ankiengine.ape');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'com.ankiengine.ape');
  return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'ape');
}

async function ensureMethodDir(base: string, refresh: boolean): Promise<string> {
  const fromEnv = process.env.APE_METHOD_DIR;
  if (fromEnv) {
    if (!existsSync(fromEnv) || !statSync(fromEnv).isDirectory()) throw new Error(`APE_METHOD_DIR is not a directory: ${fromEnv}`);
    return fromEnv;
  }
  const dir = join(base, 'method');
  mkdirSync(dir, { recursive: true });
  const missing = METHOD_FILES.filter((f) => refresh || !existsSync(join(dir, f.name)));
  if (missing.length > 0) {
    process.stderr.write(`fetching the method files (${missing.length}) into ${dir}\n`);
    for (const f of missing) {
      const res = await fetch(METHOD_RAW + f.from);
      if (!res.ok) throw new Error(`could not fetch ${f.name}: HTTP ${res.status}`);
      writeFileSync(join(dir, f.name), await res.text());
    }
  }
  return dir;
}

function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => process.stderr.write('could not open a browser; open the URL above by hand\n'));
  child.unref();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const major = Number(process.versions.node.split('.')[0]);
  if (major < NODE_FLOOR) {
    throw new Error(`ankiengine-bridge needs Node ${NODE_FLOOR} or newer (this is ${process.versions.node}); Claude Code needs the same, so upgrading Node fixes both`);
  }

  if (args.courseDir !== null && (!existsSync(args.courseDir) || !statSync(args.courseDir).isDirectory())) {
    throw new Error(`not a folder: ${args.courseDir}`);
  }

  const data = dataDir();
  mkdirSync(data, { recursive: true });
  process.env.APE_METHOD_DIR = await ensureMethodDir(data, args.refreshMethod);

  const site = new URL(args.site);
  const token = randomBytes(24).toString('base64url');
  const info: SidecarInfo = { engine: 'ape', version: packageVersion(), node: process.versions.node };

  let server: SidecarServer | undefined;
  const shutdown = async (code: number): Promise<never> => {
    await server?.close().catch(() => undefined);
    process.exit(code);
  };
  const serve = (port: number) =>
    serveSidecar({ info, port, token, allowedOrigins: [site.origin, ...args.allowOrigins], onShutdown: () => void shutdown(0) });
  try {
    server = await serve(args.port);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || args.port === 0) throw err;
    process.stderr.write(`port ${args.port} is busy; picking a free one\n`);
    server = await serve(0);
  }

  const params = new URLSearchParams({ bridge: `http://127.0.0.1:${server.port}`, token, data });
  if (args.courseDir !== null) params.set('course', args.courseDir);
  // The fragment is never sent to the server hosting the page.
  const url = `${site.href}#${params.toString()}`;

  process.stdout.write(
    `\nankiengine-bridge ${info.version} on http://127.0.0.1:${server.port} (Node ${info.node})\n` +
      `  method files : ${process.env.APE_METHOD_DIR}\n` +
      `  data         : ${data}\n` +
      (args.courseDir !== null ? `  course folder: ${args.courseDir}\n` : '') +
      `\n  ${url}\n\n` +
      `Leave this running while you use the page. Ctrl-C to stop.\n`,
  );
  if (args.open) openInBrowser(url);

  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
}

main().catch((err: unknown) => {
  process.stderr.write(`ankiengine-bridge: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
