// The Node entry point: buildApkg (build.ts) over node:sqlite, node:fs and
// node:zlib, written to a file.
//
// Anything importing this module gets the Node halves with it, so a browser
// build imports './build.js' directly instead -- that is the whole reason
// the two are separate files.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DeckNote } from '../types.js';
import { buildApkg } from './build.js';
import { mappedMediaReader, nodeMediaReader, type MediaMapEntry } from './media-node.js';
import { openNodeSqlite } from './sqlite-node.js';
import { nodeZipCodec } from './zlib-node.js';

export { buildApkg } from './build.js';
export type { BuildApkgOptions, BuildApkgResult } from './build.js';

export interface WriteApkgOptions {
  /** Puts every note into this one deck; left out, each note goes into its own deckName's (collection.ts). */
  deckName?: string;
  outPath: string;
  /** Must exist; referenced media files are read from here (doc §10). */
  mediaDir: string;
  /**
   * The deck's own media list (deck-json.ts DeckMediaRef): a referenced
   * filename is read from its mapped path first, then from mediaDir, then
   * from each of `fallbackDirs`. The app's decks carry one, since their
   * images sit under _extracted/ under working names.
   */
  media?: MediaMapEntry[];
  fallbackDirs?: string[];
  /**
   * epoch-ms "now". Defaults to real time in production. Every id,
   * mod/crt/scm timestamp, and note guid this exporter writes is derived
   * from this value (and this call's own counter state) -- never a fresh
   * Date.now()/Math.random()/crypto.randomUUID() call -- so two calls with
   * the same clock and the same notes produce byte-identical output.
   */
  clock?: () => number;
}

export interface WriteApkgResult {
  /**
   * Filenames some note referenced (via <img>/<audio>/... in Text/Extra)
   * that had no readable file behind them in mediaDir -- collectMedia's own
   * `unresolved`, passed through here rather than dropped (media.ts). Empty
   * when every reference resolved. check_deck.py's media check is expected
   * to have already caught this upstream of writeApkg (doc §10); this is a
   * second, cheap line of visibility for whatever a given run actually
   * found, not a replacement for that check -- the package is still
   * written either way, just missing these files' bytes.
   */
  unresolvedMedia: string[];
}


/**
 * buildApkg over the Node platform primitives, written to `options.outPath`.
 * Parent directories are created as needed.
 */
export function writeApkg(notes: DeckNote[], options: WriteApkgOptions): WriteApkgResult {
  const { bytes, unresolvedMedia } = buildApkg(notes, {
    deckName: options.deckName,
    readMedia: options.media?.length || options.fallbackDirs?.length ? mappedMediaReader(options.media ?? [], [options.mediaDir, ...(options.fallbackDirs ?? [])]) : nodeMediaReader(options.mediaDir),
    openSqlite: openNodeSqlite,
    zipCodec: nodeZipCodec,
    clock: options.clock,
  });

  mkdirSync(dirname(options.outPath), { recursive: true });
  writeFileSync(options.outPath, bytes);

  return { unresolvedMedia };
}

