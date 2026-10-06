// The worker's message shapes. Shared by both sides so a change to one is a
// type error in the other.

export interface LoadRequest {
  id: number;
  kind: 'load';
  /** The dropped file's text, unparsed -- the engine validates it. */
  deckText: string;
  /** Appears in validation messages, where a path would on the CLI. */
  label: string;
}

export interface ExportRequest {
  id: number;
  kind: 'export';
  deckText: string;
  label: string;
  /**
   * filename -> bytes, for whatever media the user supplied alongside.
   * A Map, not a Record: a plain object resolves inherited keys, so a deck
   * referencing `constructor` or `__proto__` would read Object.prototype
   * members as if they were files (structured clone carries Maps fine).
   */
  media: Map<string, Uint8Array>;
}

export type WorkerRequest = LoadRequest | ExportRequest;

export interface LoadOk {
  id: number;
  ok: true;
  kind: 'load';
  count: number;
  deckNames: string[];
  /** The check report, exactly as `ape check` prints it. */
  report: string;
  clean: boolean;
  /** renderReview's page, with media still as file:// -- the page rewrites them. */
  reviewHtml: string;
  /** Media filenames the deck references, so the page can ask for them. */
  referencedMedia: string[];
}

export interface ExportOk {
  id: number;
  ok: true;
  kind: 'export';
  bytes: Uint8Array;
  unresolvedMedia: string[];
}

export interface Failed {
  id: number;
  ok: false;
  message: string;
  /**
   * The worker cannot serve any further request and must be replaced.
   * Set when the WASM load failed: emscripten calls abort() on an
   * instantiation failure and latches a module-scope flag, so every later
   * initSqlJs() in that worker fails identically no matter how healthy the
   * network becomes. Only a fresh worker recovers.
   */
  fatal?: boolean;
}

export type WorkerResponse = LoadOk | ExportOk | Failed;
