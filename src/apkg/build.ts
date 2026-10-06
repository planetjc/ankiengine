// Assembling a `.apkg`, with nothing platform-specific in it.
//
// SQLite, media reads and compression all arrive as arguments (sqlite.ts,
// media.ts, zip.ts), so this module -- the package's actual shape -- imports
// no node: anything and runs unchanged in a browser. index.ts supplies the
// Node implementations and writes the result to a file; a browser supplies
// sql.js and fflate and hands the bytes to a download.
//
// See docs/research/apkg-format.md §1 for why this writes exactly
// collection.anki21 + media (+ numbered media files) and nothing else -- no
// `meta` member, no legacy collection.anki2 stub.

import type { DeckNote, NoteFields } from '../types.js';
import { utf8 } from './bytes.js';
import { buildCollection } from './collection.js';
import { collectMedia, type MediaReader } from './media.js';
import type { OpenSqlite } from './sqlite.js';
import { buildZip, type ZipCodec, type ZipEntryInput } from './zip.js';

export interface BuildApkgOptions {
  /** Puts every note into this one deck; left out, each note goes into its own deckName's (collection.ts). */
  deckName?: string;
  /** Bytes behind each referenced media filename -- media.ts. */
  readMedia: MediaReader;
  /** Where the SQLite database comes from -- sqlite.ts. */
  openSqlite: OpenSqlite;
  /** crc32 + raw deflate -- zip.ts. */
  zipCodec: ZipCodec;
  /**
   * epoch-ms "now". Defaults to real time. Every id, mod/crt/scm timestamp
   * and note guid is derived from this value (and this call's own counter
   * state) -- never a fresh Date.now()/Math.random()/crypto.randomUUID() --
   * so two calls with the same clock and the same notes produce byte-
   * identical output. That is what lets a browser build be checked against
   * a Node one by comparing bytes rather than by inspection.
   */
  clock?: () => number;
}

export interface BuildApkgResult {
  /** The complete `.apkg` file. */
  bytes: Uint8Array;
  /** See WriteApkgResult.unresolvedMedia. */
  unresolvedMedia: string[];
}


const NOTE_FIELD_NAMES: readonly (keyof NoteFields)[] = ['Text', 'Extra', 'Source'];

/**
 * Writes a `.apkg` file containing the notes and cards of every deck they
 * name: schema-11 SQLite (collection.anki21), a JSON media manifest, and
 * the referenced media files, deflate/store zipped per docs/research/apkg-format.md.
 *
 * A plain (non-`async`) function: every step here -- SQLite writes, media
 * reads, deflate, the final file write -- is synchronous, so an `async`
 * signature would only have claimed to yield the event loop without ever
 * doing so. `await writeApkg(...)` still works at every call site (`await`
 * on a non-Promise value resolves to that value immediately).
 *
 * Validates its own inputs before doing any work, rather than letting a
 * malformed note or a bad clock surface as a raw TypeError/RangeError from
 * deep inside collection.ts/ids.ts with no indication of which note or
 * option was at fault -- deck.json (the usual source of `notes`) is
 * LLM-authored, not a trusted, statically-typed value, so the declared
 * DeckNote[]/WriteApkgOptions types are a contract this function checks
 * rather than one it's entitled to assume.
 */
export function buildApkg(notes: DeckNote[], options: BuildApkgOptions): BuildApkgResult {
  const clock = options.clock ?? Date.now;
  const clockMs = clock();
  // Every id/guid this exporter writes derives from clockMs via BigInt()
  // (ids.ts) -- a non-integer reaches that conversion as an unlabeled
  // RangeError, so it's caught here instead, named to the actual option at
  // fault.
  if (!Number.isInteger(clockMs)) {
    throw new RangeError(`options.clock() must return an integer epoch-ms value, got ${clockMs}`);
  }
  notes.forEach((note, index) => {
    for (const field of NOTE_FIELD_NAMES) {
      if (typeof note.fields?.[field] !== 'string') {
        throw new TypeError(`notes[${index}].fields.${field} must be a string, got ${typeof note.fields?.[field]}`);
      }
    }
  });

  const media = collectMedia(notes, options.readMedia);
  const dbBytes = buildCollection(notes, {
    deckName: options.deckName,
    clockMs,
    openSqlite: options.openSqlite,
  });

  const entries: ZipEntryInput[] = [
    { name: 'collection.anki21', data: dbBytes, method: 'deflate' },
    { name: 'media', data: utf8(JSON.stringify(media.manifest)), method: 'deflate' },
    // Stored, not deflated -- doc §2: these are already-compressed
    // image/audio formats in every real sample, so deflating them again
    // buys nothing.
    ...media.files.map((file, index): ZipEntryInput => ({ name: String(index), data: file.bytes, method: 'store' })),
  ];

  return { bytes: buildZip(entries, options.zipCodec), unresolvedMedia: media.unresolved };
}

