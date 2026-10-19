// The sidecar over HTTP, for a browser page -- docs/research/sidecar-protocol.md
// carried onto a transport a tab can reach.
//
// Same core as the stdio sidecar (dispatch.ts), different pipes: a page cannot
// hold a child process's stdin/stdout, but it can open a connection to
// 127.0.0.1. Everything the sidecar would have written to stdout goes down one
// Server-Sent Events stream -- responses, notifications, and the reverse
// requests it makes of its host -- so the ordering rule (§2.2, responses in
// arrival order) holds exactly as it did; and every line the host would have
// written to stdin arrives as the body of a POST. node:http only: the engine
// keeps its zero-dependency rule, and SSE is plain text, which JSON-RPC is.
//
// This process spawns agents and reads and writes the user's files, and any
// page in the user's browser can attempt a connection to loopback. So:
//
//   * it binds 127.0.0.1 and refuses anything else -- never the network;
//   * every request carries a per-run token the bridge minted and printed,
//     which the page received in its URL fragment (never sent to the site
//     hosting the page) -- a wrong or missing token is 401;
//   * every request's Origin must be on the allowlist -- a missing one is as
//     refused as a wrong one, since a browser always sends it and only a
//     browser is meant to be here;
//   * CORS preflights echo that exact origin, never `*`, and answer the
//     local-network preflight header so Chrome's gate can be passed at all.
//
// One page at a time: a new /events subscriber replaces the last. Lines sent
// while nobody is subscribed are held (bounded) and delivered to the next
// subscriber, so a page that reconnects does not lose the response to a
// request it had already posted.

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { extname, resolve as resolvePath, sep } from 'node:path';
import { FrameDecoder } from '../acp/framing.js';
import { createDispatcher } from './dispatch.js';
import type { SidecarInfo } from './methods.js';

export interface ServeOptions {
  info: SidecarInfo;
  /** 0 picks a free port. */
  port: number;
  /** Loopback only; anything else is refused before listening. */
  host?: string;
  token: string;
  /** Exact origins, e.g. `https://ankiengine.com`. */
  allowedOrigins: readonly string[];
  /** Runs when a `sidecar/shutdown` request is handled. */
  onShutdown?: () => void;
}

export interface SidecarServer {
  port: number;
  host: string;
  /** Stops listening, ends the events stream, reaps agents. */
  close(): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
/** Lines kept for a subscriber that has not connected yet, or has dropped. */
const HELD_LINE_LIMIT = 1000;
const PING_INTERVAL_MS = 30_000;
const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.json': 'application/json', '.md': 'text/markdown',
  '.txt': 'text/plain', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
};

function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

function sameToken(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function serveSidecar(options: ServeOptions): Promise<SidecarServer> {
  const host = options.host ?? '127.0.0.1';
  if (!isLoopback(host)) {
    throw new Error(`refusing to listen on ${host}: the sidecar binds loopback only`);
  }
  const allowed = new Set(options.allowedOrigins);

  // ---- outbound: one ordered stream ---------------------------------------
  let subscriber: ServerResponse | null = null;
  const held: string[] = [];

  // SSE frames one event as `data: ...` lines terminated by a blank line;
  // the JSON-RPC line already ends in \n, which is the separator here.
  const frame = (line: string): string => `data: ${line.replace(/\n$/, '')}\n\n`;

  function send(line: string): void {
    if (subscriber !== null) {
      subscriber.write(frame(line));
      return;
    }
    if (held.length >= HELD_LINE_LIMIT) held.shift();
    held.push(frame(line));
  }

  const dispatcher = createDispatcher({
    info: options.info,
    send,
    onShutdown: () => options.onShutdown?.(),
  });
  const readyLine = dispatcher.readyLine({ pid: process.pid, transport: 'sse' });

  // ---- inbound ------------------------------------------------------------

  function cors(res: ServerResponse, origin: string): void {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    // Chrome's local-network access gate preflights a public page's request
    // to loopback and expects this in the answer.
    res.setHeader('access-control-allow-private-network', 'true');
  }

  function reject(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'content-type': 'text/plain' }).end(message);
  }

  // Nothing thrown in a request may reach the process: an async handler's
  // rejection is unhandled, and Node's default for that is to exit -- the
  // bridge died when a page reloaded in the middle of a large POST.
  const http: HttpServer = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) reject(res, 500, err instanceof Error ? err.message : String(err));
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${host}`);
    const origin = req.headers.origin ?? null;

    // Preflight first: it carries no token, and a refused preflight is what
    // the browser shows the page as a network error, so answer it precisely.
    if (req.method === 'OPTIONS') {
      if (origin === null || !allowed.has(origin)) return reject(res, 403, 'origin not allowed');
      cors(res, origin);
      res.writeHead(204).end();
      return;
    }

    if (origin === null || !allowed.has(origin)) return reject(res, 403, 'origin not allowed');
    cors(res, origin);
    if (!sameToken(url.searchParams.get('token'), options.token)) return reject(res, 401, 'bad token');

    switch (`${req.method} ${url.pathname}`) {
      case 'GET /health': {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...options.info, transport: 'sse' }));
        return;
      }
      case 'GET /events': {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        // Only one page drives this sidecar; a newer subscriber wins.
        subscriber?.end();
        subscriber = res;
        res.write(': connected\n\n');
        // Every subscriber gets the ready line first, as the first stdout
        // line was -- not just the first subscriber. A page that reloads
        // waits on this line to know the sidecar is there; holding it once
        // at startup left the second page waiting forever.
        res.write(frame(readyLine));
        for (const f of held.splice(0)) res.write(f);
        const ping = setInterval(() => res.write(': ping\n\n'), PING_INTERVAL_MS);
        req.on('close', () => {
          clearInterval(ping);
          if (subscriber === res) subscriber = null;
        });
        return;
      }
      case 'POST /rpc': {
        const body = await readBody(req);
        // Each body is complete in itself: one or more newline-delimited
        // messages, the last one's newline optional. Unlike stdin, a line
        // never spans two POSTs -- a fresh decoder per request means a body
        // that was cut off cannot poison the one after it, and a client that
        // forgets the trailing newline is not silently ignored.
        const decoder = new FrameDecoder();
        const text = body.endsWith('\n') || body === '' ? body : `${body}\n`;
        let count = 0;
        for (const line of [...decoder.push(Buffer.from(text, 'utf8')), ...decoder.end()]) {
          dispatcher.handle(line);
          count += 1;
        }
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ accepted: count }));
        return;
      }
      case 'GET /file': {
        // A file beneath a directory the page names -- the course folder or
        // the Anki media directory -- for the card preview and for media on
        // its way into a package. The page holds the token, so it is the
        // user reading the user's own files; what this guards against is a
        // path that climbs out of the named root, after symlinks.
        const root = url.searchParams.get('root');
        const rel = url.searchParams.get('path');
        if (!root || !rel) return reject(res, 400, 'root and path are required');
        let full: string;
        let realRoot: string;
        try {
          realRoot = realpathSync(root);
          full = realpathSync(resolvePath(realRoot, rel));
        } catch {
          return reject(res, 404, 'not found');
        }
        if (full !== realRoot && !full.startsWith(realRoot + sep)) return reject(res, 403, 'outside the root');
        const stat = statSync(full);
        if (!stat.isFile()) return reject(res, 404, 'not a file');
        res.writeHead(200, {
          'content-type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
          'content-length': stat.size,
          'cache-control': 'no-store',
        });
        // Gone between the stat and the open, or unreadable: end the response rather than throw from the stream.
        createReadStream(full).on('error', () => res.destroy()).pipe(res);
        return;
      }
      default:
        return reject(res, 404, 'not found');
    }
  }

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, host, () => {
      http.off('error', reject);
      resolve();
    });
  });
  const address = http.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;


  return {
    port,
    host,
    close: async () => {
      subscriber?.end();
      subscriber = null;
      await dispatcher.closeAll().catch(() => undefined);
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
