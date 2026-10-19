// The page's side of the bridge: JSON-RPC over one EventSource and POSTs to
// 127.0.0.1 -- the mirror of src/sidecar/serve.ts.
//
// Where the connection details come from: the URL fragment. `ankiengine-bridge`
// prints a URL like `<page>#bridge=http://127.0.0.1:9100&token=…&data=…`,
// and a fragment is the one part of a URL a browser never sends to the
// server hosting the page, so the token that lets this page drive an agent
// on the user's machine is shared with exactly nobody else.
//
// Everything the sidecar says arrives on the events stream in the order it
// said it -- responses to our requests, notifications, and the requests it
// makes of us (agent/requestPermission). Requests go up as newline-delimited
// JSON-RPC in a POST body, acknowledged 202; the answer comes down the
// stream and is matched to its promise by id.

import { EngineError, type EngineHost, type EngineInfo, type ReverseRequest } from '../../../app/src/engine/host.js';

export interface BridgeLocator {
  /** e.g. http://127.0.0.1:9100 */
  origin: string;
  token: string;
  /** The bridge's data directory, which agents/* methods take as a parameter. */
  dataDir: string;
  /** A course folder named on the command line, if any. */
  courseDir: string | null;
}


type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** Reads the bridge's details out of the page's own URL, or null when there are none. */
export function locateBridge(hash: string = location.hash): BridgeLocator | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const origin = params.get('bridge');
  const token = params.get('token');
  const dataDir = params.get('data');
  if (!origin || !token || !dataDir) return null;
  return { origin, token, dataDir, courseDir: params.get('course') };
}

export class Bridge implements EngineHost {
  /** What the sidecar said about itself; filled in by health(). */
  info: EngineInfo = { engine: 'ape', version: '0', node: '0', transport: 'http' };
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private events: EventSource | null = null;
  private notificationHandler: ((method: string, params: unknown) => void) | null = null;
  private requestHandler: ((request: ReverseRequest) => void) | null = null;
  private failure: string | null = null;

  constructor(readonly locator: BridgeLocator) {}

  private url(path: string): string {
    return `${this.locator.origin}${path}?token=${encodeURIComponent(this.locator.token)}`;
  }

  /** A URL the page can fetch or point an <img> at: one file beneath `root`, via the bridge. */
  fileUrl(root: string, relPath: string): string {
    return `${this.url('/file')}&root=${encodeURIComponent(root)}&path=${encodeURIComponent(relPath)}`;
  }

  /** Confirms a bridge is there and is ours. */
  async health(): Promise<EngineInfo> {
    const res = await fetch(this.url('/health'));
    if (!res.ok) throw new EngineError(-32000, `the bridge answered ${res.status} ${res.statusText}`);
    this.info = (await res.json()) as EngineInfo;
    return this.info;
  }

  /** EngineHost: the folder named on the command line, if any. */
  courseRoot(): string | null {
    return this.locator.courseDir;
  }

  /** EngineHost: where this bridge installs agents. */
  dataDir(): string {
    return this.locator.dataDir;
  }

  /** EngineHost: one file beneath `root`, fetched through the bridge. */
  async readFile(root: string, relPath: string): Promise<Uint8Array | null> {
    const res = await fetch(this.fileUrl(root, relPath));
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  }

  /** Opens the events stream; resolves once the sidecar's ready line arrives. */
  connect(): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const source = new EventSource(this.url('/events'));
      this.events = source;
      let ready = false;
      source.onmessage = (event: MessageEvent<string>) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          return;
        }
        if (!ready && message.method === 'sidecar/ready') {
          ready = true;
          resolve(message.params as Record<string, unknown>);
          return;
        }
        this.dispatch(message);
      };
      source.onerror = () => {
        // EventSource reconnects on its own; a failure before ready means the
        // bridge is not there or refused us, and that is the one to surface.
        if (!ready) {
          source.close();
          reject(new EngineError(-32000, 'could not reach the bridge -- is `ankiengine-bridge` still running?'));
        }
      };
    });
  }

  close(): void {
    this.events?.close();
    this.events = null;
    this.failure = 'the bridge connection was closed';
    for (const p of this.pending.values()) p.reject(new EngineError(-32000, this.failure));
    this.pending.clear();
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }

  /** Requests the sidecar makes of the page (agent-protocol.md §3). Answer with `answer`/`refuse`. */
  onRequest(handler: (request: ReverseRequest) => void): void {
    this.requestHandler = handler;
  }

  private dispatch(message: Record<string, unknown>): void {
    const hasId = 'id' in message && message.id !== null && message.id !== undefined;
    if ('method' in message) {
      if (hasId) this.requestHandler?.({ id: Number(message.id), method: String(message.method), params: message.params });
      else this.notificationHandler?.(String(message.method), message.params);
      return;
    }
    if (!hasId) return;
    const slot = this.pending.get(Number(message.id));
    if (!slot) return;
    this.pending.delete(Number(message.id));
    if ('error' in message) {
      const error = message.error as { code: number; message: string; data?: unknown };
      slot.reject(new EngineError(error.code, error.message, error.data));
    } else {
      slot.resolve(message.result);
    }
  }

  private async post(lines: string): Promise<void> {
    const res = await fetch(this.url('/rpc'), { method: 'POST', body: lines });
    if (!res.ok) throw new EngineError(-32000, `the bridge refused the request: ${res.status}`);
  }

  async call<T>(method: string, params?: unknown): Promise<T> {
    if (this.failure !== null) throw new EngineError(-32000, this.failure);
    const id = this.nextId++;
    const line = `${JSON.stringify(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params })}\n`;
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    // The answer can arrive on the events stream before the POST's 202 does,
    // and a promise rejected while nobody is awaiting it yet is reported as
    // unhandled -- even though the caller is about to. Mark it handled here;
    // the rejection still reaches the `await` below.
    result.catch(() => undefined);
    try {
      await this.post(line);
    } catch (err) {
      this.pending.delete(id);
      throw err;
    }
    return (await result) as T;
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.post(`${JSON.stringify(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })}\n`);
  }

  /** Answers one of the sidecar's reverse requests. */
  answer(id: number, result: unknown): Promise<void> {
    return this.post(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  refuse(id: number, message: string): Promise<void> {
    return this.post(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } })}\n`);
  }
}
