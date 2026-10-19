// What a shell needs from whatever is running the engine, so the panes do
// not know which one they are talking to.
//
// Two hosts implement this. The desktop app's (tauri-host.ts) reaches the
// sidecar that Rust spawned, over Tauri's invoke and events. The bridge's
// (site/src/engine/bridge-transport.ts) reaches `ankiengine-bridge` on the user's
// machine over loopback HTTP, from a page. A third ran the sidecar inside
// the browser tab on WebContainer and was retired (docs/HANDOFF.md §3).
// Same program, same method table, same JSON-RPC -- only the pipe differs,
// and this interface is the whole of the difference.

/** What the sidecar says about itself when it comes up (`sidecar/ping`, the bridge's /health). */
export interface EngineInfo {
  engine: string;
  version: string;
  node: string;
  transport: string;
}

/**
 * A failure the engine reported -- a JSON-RPC error, such as an artifact not
 * being there yet -- as opposed to a bug in the shell, which is any other
 * throw. The stage runner tolerates the first and rethrows the second.
 */
export class EngineError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

/** A request the sidecar makes of the shell (agent-protocol.md §3): answered with `answer` or `refuse`. */
export interface ReverseRequest {
  id: number;
  method: string;
  params: unknown;
}

export interface EngineHost {
  /** What the sidecar said about itself when it came up. */
  readonly info: EngineInfo;
  /** Absolute path of the folder the user's material lives in, in this host's filesystem, or null when the user has not named one. */
  courseRoot(): string | null;
  /** Where agents are installed: the sidecar's data dir, as the agents/* methods take it. */
  dataDir(): string;
  call<T>(method: string, params?: unknown): Promise<T>;
  answer(id: number, result: unknown): Promise<void>;
  refuse(id: number, message: string): Promise<void>;
  /** ONE handler: a second call replaces the first. UI code goes through agent/bus.ts, which owns this slot and fans out. */
  onNotification(handler: (method: string, params: unknown) => void): void;
  /** Requests the sidecar makes of the shell. One handler, same rule. */
  onRequest(handler: (request: ReverseRequest) => void): void;
  /** One file beneath `root`, or null when it is not there. */
  readFile(root: string, relPath: string): Promise<Uint8Array | null>;
  close(): void;

  /**
   * Runs the agent's own sign-in command and relays its console, for a host
   * that has no browser of its own to hand the OAuth step to. The ACP
   * adapters advertise no auth methods -- Claude's flow lives in the CLI --
   * so the shell shows what the command prints and types back what the
   * user answers rather than guessing at the shape of the flow. Neither
   * current host provides it; the picker's Sign in button (agent/login)
   * covers agents that do advertise a method.
   */
  signIn?(onOutput: (text: string) => void): { write(line: string): void; cancel(): void; done: Promise<number> } | null;
}
