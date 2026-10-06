// The engine, off the main thread.
//
// checkDeck, renderReview and buildApkg are synchronous over the whole deck
// (deliberately -- see src/apkg/build.ts), so running them inline would lock
// the page up for the length of an export. Here they cannot.
//
// This calls the engine's functions directly rather than speaking the
// sidecar's JSON-RPC: those handlers are path-oriented, and nothing here has
// a filesystem path. What crosses the wire is a deck's text in and a report,
// a review page or a package out.

import initSqlJs, { type SqlJsStatic } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

import { checkDeck, formatCheckReport, renderReview } from '../../../dist/checks/index.js';
import { buildApkg } from '../../../dist/apkg/build.js';
import { parseDeckNotes } from '../../../dist/deck-json.js';
import { extractMediaFilenames } from '../../../dist/apkg/text.js';
import type { DeckNote } from '../../../dist/types.js';
import { sqlJsOpener } from './sqlite-sqljs.js';
import { fflateZipCodec } from './deflate-fflate.js';
import type { WorkerRequest, WorkerResponse } from './protocol.js';

// Loaded once, before anything can ask for an export. initSqlJs is async;
// everything downstream of it is synchronous, which is what lets the
// engine's writer keep its synchronous shape (sqlite-sqljs.ts).
let sqlReady: Promise<SqlJsStatic> | undefined;
/** Marks an error as one only a new worker can recover from. */
const FATAL = Symbol.for('ape.fatal');

function sqlJs(): Promise<SqlJsStatic> {
  // A plain `sqlReady ??= initSqlJs(...)` memoizes a REJECTED promise as
  // happily as a fulfilled one, so one failed wasm fetch would replay the
  // same stale error forever. Clearing the slot is necessary but NOT
  // sufficient: emscripten's abort() on an instantiation failure latches a
  // flag inside the sql.js glue module, and every later initSqlJs() in this
  // worker then fails identically (verified -- a correct load immediately
  // after a bad one still throws the original CompileError). So the failure
  // is also flagged fatal, and the page throws this worker away.
  sqlReady ??= initSqlJs({ locateFile: () => wasmUrl }).catch((err: unknown) => {
    sqlReady = undefined;
    const error = err instanceof Error ? err : new Error(String(err));
    (error as unknown as Record<symbol, boolean>)[FATAL] = true;
    throw error;
  });
  return sqlReady;
}

function mediaNames(notes: DeckNote[]): string[] {
  const seen = new Set<string>();
  for (const note of notes) {
    for (const html of [note.fields.Text, note.fields.Extra]) {
      for (const name of extractMediaFilenames(html ?? '')) seen.add(name);
    }
  }
  return [...seen];
}

async function handle(request: WorkerRequest): Promise<WorkerResponse> {
  if (request.kind === 'load') {
    const notes = parseDeckNotes(request.deckText, request.label);
    // checkMedia stays off: the page has files, not a directory, and rule 2
    // asks whether a name exists in the Anki media folder -- a question a
    // browser cannot answer. Every other rule is pure and runs in full.
    const result = checkDeck(notes, { checkMedia: false });
    return {
      id: request.id,
      ok: true,
      kind: 'load',
      count: notes.length,
      deckNames: [...new Set(notes.map((n) => n.deckName).filter(Boolean))],
      report: formatCheckReport(result),
      clean: result.findings.length === 0,
      reviewHtml: renderReview(notes),
      referencedMedia: mediaNames(notes),
    };
  }

  const notes = parseDeckNotes(request.deckText, request.label);
  const SQL = await sqlJs();
  // Each note goes into its own deckName's deck (src/apkg/collection.ts).
  const { bytes, unresolvedMedia } = buildApkg(notes, {
    readMedia: (filename) => request.media.get(filename),
    openSqlite: sqlJsOpener(SQL),
    zipCodec: fflateZipCodec,
  });
  return { id: request.id, ok: true, kind: 'export', bytes, unresolvedMedia };
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  /**
   * Every request must produce exactly one response: the page keeps a pending
   * entry per id and only ever clears it on receipt, so a request that posts
   * nothing hangs that promise forever.
   */
  const post = (response: WorkerResponse, transfer: Transferable[] = []): void => {
    try {
      (self as unknown as Worker).postMessage(response, transfer);
    } catch (err) {
      // A failed post -- DataCloneError, an already-detached buffer, an
      // allocation failure on a large package -- must not be the end of it.
      // The fallback carries no payload, so it is always cloneable.
      const message = err instanceof Error ? err.message : String(err);
      (self as unknown as Worker).postMessage({ id: request.id, ok: false, message } satisfies WorkerResponse);
    }
  };

  // .then(...).catch(...), not .then(onOk, onErr): the two-argument form makes
  // the handlers siblings, so a throw out of the success path -- including out
  // of postMessage itself -- would reject a promise nobody observes and no
  // response would ever be sent.
  handle(request)
    .then((response) => {
      // The package can be megabytes; hand the buffer over rather than copy it.
      const transfer = response.ok && response.kind === 'export' ? [response.bytes.buffer] : [];
      post(response, transfer as Transferable[]);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const fatal = typeof err === 'object' && err !== null && (err as Record<symbol, boolean>)[FATAL] === true;
      post({ id: request.id, ok: false, message, fatal });
    });
};
