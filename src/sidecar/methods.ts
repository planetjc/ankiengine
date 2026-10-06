// The sidecar's method table -- docs/research/sidecar-protocol.md §4. Every
// handler is a thin adapter over the same engine calls the CLI makes
// (src/cli/*.ts), returning structured results instead of printing them.
// Nothing here decides anything about a card: deck loading, checks,
// rendering and export are the engine's; flags are stored, never read for
// meaning (§4 flags/*, and APP.md's "no card-authoring logic in app code").
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import {
  checkDeck,
  formatCheckReport,
  loadInventory,
  loadTranscript,
  renderReview,
  type CheckDeckOptions,
} from '../checks/index.js';
import { nodeMediaExists } from '../checks/media-exists-node.js';
import { mappedMediaExists, resolveMediaFile } from '../apkg/media-node.js';
import { loadDeckMedia, loadDeckNotes, type DeckMediaRef } from '../cli/deck-loader.js';
import { isExistingDirectory, resolveMediaDir } from '../cli/media-dir.js';
import { readFileOrThrow } from '../cli/read-file.js';

/** §3: a params problem. Carries the JSON-RPC code so index.ts can map it without string-matching. */
export class InvalidParams extends Error {
  readonly code = -32602;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidParams';
  }
}

export interface SidecarInfo {
  engine: 'ape';
  version: string;
  node: string;
}

export interface Flag {
  noteIndex: number;
  note: string;
  at: string;
}

type Params = Record<string, unknown>;


/** Where a referenced image is: the deck's own list, the Anki media directory, the deck's folder; undefined when nowhere. */
function mediaResolver(media: DeckMediaRef[], mediaDir: string, deckPath: string): (filename: string) => string | undefined {
  return (filename) => resolveMediaFile(filename, media, [mediaDir, dirname(deckPath)]);
}

function asParams(params: unknown): Params {
  if (params === undefined || params === null) return {};
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new InvalidParams('params must be an object');
  }
  return params as Params;
}

function requireString(params: Params, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidParams(`params.${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(params: Params, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new InvalidParams(`params.${key} must be a string`);
  return value;
}

function optionalBoolean(params: Params, key: string, fallback: boolean): boolean {
  const value = params[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new InvalidParams(`params.${key} must be a boolean`);
  return value;
}

function optionalStringArray(params: Params, key: string): string[] {
  const value = params[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new InvalidParams(`params.${key} must be an array of strings`);
  }
  return value;
}

function flagsPathFor(deckPath: string): string {
  return join(dirname(deckPath), 'flags.json');
}

function parseFlags(value: unknown): Flag[] {
  if (!Array.isArray(value)) throw new InvalidParams('params.flags must be an array');
  return value.map((entry, i) => {
    const flag = entry as Partial<Flag> | null;
    if (typeof flag !== 'object' || flag === null) throw new InvalidParams(`params.flags[${i}] must be an object`);
    if (!Number.isInteger(flag.noteIndex) || (flag.noteIndex as number) < 0) {
      throw new InvalidParams(`params.flags[${i}].noteIndex must be a non-negative integer`);
    }
    if (typeof flag.note !== 'string') throw new InvalidParams(`params.flags[${i}].note must be a string`);
    if (typeof flag.at !== 'string' || Number.isNaN(Date.parse(flag.at))) {
      throw new InvalidParams(`params.flags[${i}].at must be an ISO timestamp string`);
    }
    return { noteIndex: flag.noteIndex as number, note: flag.note, at: flag.at };
  });
}

export type MethodHandler = (params: unknown) => unknown | Promise<unknown>;

export function buildMethods(info: SidecarInfo, onShutdown: () => void): Record<string, MethodHandler> {
  return {
    'sidecar/ping': () => info,

    'sidecar/shutdown': () => {
      onShutdown();
      return {};
    },

    'media/dir': () => {
      const mediaDir = resolveMediaDir();
      return { mediaDir, exists: isExistingDirectory(mediaDir) };
    },

    'deck/load': (raw) => {
      const path = requireString(asParams(raw), 'path');
      const notes = loadDeckNotes(path);
      return { notes, count: notes.length };
    },

    // Mirrors src/cli/check.ts step for step; see that file's header for the
    // order check_deck.py itself imposes (media note, transcripts, inventory,
    // deck, then the zero-notes case).
    'deck/check': (raw) => {
      const params = asParams(raw);
      const path = requireString(params, 'path');
      const transcriptPaths = optionalStringArray(params, 'transcriptPaths');
      const inventoryPath = optionalString(params, 'inventoryPath');
      const wantMedia = optionalBoolean(params, 'checkMedia', true);
      const mediaDir = optionalString(params, 'mediaDir') ?? resolveMediaDir();

      // A deck that carries its own media list (the app's do: the images sit
      // under _extracted/ under working names) is checked against that list
      // and its own folder, whether or not an Anki media directory exists.
      const media = loadDeckMedia(path);
      const own = media.length > 0;
      const checkMedia = wantMedia && (own || isExistingDirectory(mediaDir));
      const mediaNote = wantMedia && !checkMedia ? `note: ${mediaDir} not found - skipping the media check` : null;

      const transcript = transcriptPaths.length > 0 ? transcriptPaths.flatMap((p) => loadTranscript(readFileOrThrow(p))) : undefined;

      let inventory: Map<string, Set<string>> | undefined;
      if (inventoryPath !== undefined) {
        inventory = loadInventory(readFileOrThrow(inventoryPath));
        if (inventory.size === 0) throw new Error(`${inventoryPath}: no numbered fact rows found`);
      }

      const notes = loadDeckNotes(path);
      if (notes.length === 0) throw new Error(`${path} contains no notes`);

      const opts: CheckDeckOptions = { checkMedia, mediaDir, mediaExists: own ? mappedMediaExists(media, [dirname(path)]) : nodeMediaExists, transcript, inventory };
      const result = checkDeck(notes, opts);
      return {
        result,
        report: formatCheckReport(result),
        clean: result.findings.length === 0,
        count: notes.length,
        mediaNote,
      };
    },

    'deck/review': (raw) => {
      const params = asParams(raw);
      const path = requireString(params, 'path');
      const mediaDir = optionalString(params, 'mediaDir') ?? resolveMediaDir();
      const outPath = optionalString(params, 'outPath') ?? null;
      const notes = loadDeckNotes(path);
      const media = loadDeckMedia(path);
      const html = renderReview(notes, { mediaDir, resolveMedia: mediaResolver(media, mediaDir, path) });
      if (outPath !== null) {
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, html, 'utf8');
      }
      return { html, count: notes.length, outPath };
    },

    'deck/export': async (raw) => {
      const params = asParams(raw);
      const path = requireString(params, 'path');
      const notes = loadDeckNotes(path);
      const outPath = optionalString(params, 'outPath') ?? join(dirname(path), `${basename(path, extname(path))}.apkg`);
      const deckName = optionalString(params, 'deckName'); // overrides every note's own, as anki/send's does
      const mediaDir = optionalString(params, 'mediaDir') ?? resolveMediaDir();
      // Loaded on first use, the way src/cli/index.ts defers its subcommands:
      // the writer reaches node:sqlite, which does not exist below Node 24,
      // and the bridge (src/bridge) must start on the Node a Claude Code user
      // already has. Every other method here runs on Node 20; only an actual
      // export asks for more -- and the page can do that one itself.
      const { writeApkg } = await import('../apkg/index.js');
      const { unresolvedMedia } = writeApkg(notes, { deckName, outPath, mediaDir, media: loadDeckMedia(path), fallbackDirs: [dirname(path)] });
      return { outPath, count: notes.length, unresolvedMedia };
    },

    'flags/read': (raw) => {
      const path = requireString(asParams(raw), 'path');
      const flagsPath = flagsPathFor(path);
      if (!existsSync(flagsPath)) return { flags: [], flagsPath };
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(flagsPath, 'utf8'));
      } catch (err) {
        throw new Error(`${flagsPath} is not valid JSON: ${(err as Error).message}`);
      }
      if (!Array.isArray(parsed)) throw new Error(`${flagsPath}: expected a list of flags`);
      return { flags: parsed as Flag[], flagsPath };
    },

    'flags/write': (raw) => {
      const params = asParams(raw);
      const path = requireString(params, 'path');
      const flags = parseFlags(params.flags);
      const flagsPath = flagsPathFor(path);
      mkdirSync(dirname(flagsPath), { recursive: true });
      writeFileSync(flagsPath, `${JSON.stringify(flags, null, 2)}\n`, 'utf8');
      return { flagsPath, count: flags.length };
    },
  };
}
