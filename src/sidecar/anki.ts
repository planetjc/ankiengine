// Anki itself, through AnkiConnect: the add-on serves a plain JSON endpoint
// on localhost while Anki is open, and the method's own insertion route is
// that endpoint (method/3-cards.md, "Getting the notes in"). This is the
// app's "Send to Anki": the same deck.json the exporter packs, put straight
// into the running collection -- the note type created if the collection
// lacks it, the deck created, every image stored under the name the field
// uses (from the deck's own media list, apkg-format.md §3), then the notes
// added. No agent, no MCP server: the sidecar is a program and can POST.
//
// It reads Anki back too, without changing anything: the decks it has, how
// much of one has been studied, and which of a deck.json's notes it already
// holds -- so the app can offer an existing deck's name and say what a send
// will add before it is pressed, and the organize step can be told what
// the deck already holds. Only actions that read: deckNames, modelNames,
// findNotes, findCards, notesInfo, and canAddNotes, which builds each note
// in memory and adds nothing. Not getDeckStats: it looks a deck up with
// decks.id(), which creates the deck when it is missing.
//
// Anki closed, or the add-on not installed, is the ordinary failure and is
// reported as such, in words the person can act on.

import { dirname } from 'node:path';
import { extractMediaFilenames } from '../apkg/text.js';
import { resolveMediaFile } from '../apkg/media-node.js';
import { CUSTOM_CLOZE_AFMT, CUSTOM_CLOZE_CSS, CUSTOM_CLOZE_FIELD_NAMES, CUSTOM_CLOZE_MODEL_NAME, CUSTOM_CLOZE_QFMT, CUSTOM_CLOZE_TEMPLATE_NAME } from '../apkg/notetype-source.js';
import { loadDeckMedia, loadDeckNotes } from '../cli/deck-loader.js';
import { resolveMediaDir } from '../cli/media-dir.js';
import type { DeckNote } from '../types.js';
import { InvalidParams, type MethodHandler } from './methods.js';

/** AnkiConnect's default; APE_ANKI_CONNECT overrides it (tests point it at a fake). */
export const ANKI_CONNECT_URL = process.env.APE_ANKI_CONNECT ?? 'http://127.0.0.1:8765';
const ADDON_CODE = '2055492159';
// The app takes this line down once Anki answers, by its start (app/src/agent/app.ts, "Anki, watched").
export const NOT_OPEN = `Anki is not open, or the AnkiConnect add-on (code ${ADDON_CODE}) is not installed. Open Anki and try again.`;

export interface AnkiStatus {
  url: string;
  reachable: boolean;
  version: number | null;
  error: string | null;
}

export interface SendResult {
  /** The deck name(s) the notes went into. */
  decks: string[];
  total: number;
  added: number;
  /** Notes AnkiConnect refused -- duplicates, almost always. */
  skipped: number;
  /** Images stored into the collection's media folder. */
  media: number;
  /** Referenced image names with no file to store. */
  unresolvedMedia: string[];
  /** Whether the Custom Cloze note type had to be created. */
  createdModel: boolean;
}

/**
 * Every read answers as anki/status does: Anki closed is `reachable: false`
 * with the NOT_OPEN sentence, never a thrown error, and the rest of the
 * answer empty.
 */
export interface AnkiRead {
  reachable: boolean;
  error: string | null;
}

export interface AnkiDecks extends AnkiRead {
  /** Every deck name in the collection, `::` and all, in Anki's order. */
  decks: string[];
}

/** One deck and every subdeck beneath it. The three card counts add up to `cards`. */
export interface AnkiDeckStats extends AnkiRead {
  /** As Anki spells it, when it has the deck; else as asked. */
  deck: string;
  /** Whether Anki has a deck by this name. When not, every count is 0. */
  exists: boolean;
  notes: number;
  cards: number;
  /** Never studied. */
  new: number;
  /** Studied, not yet graduated. */
  learning: number;
  /** Graduated, lapsed cards being relearned among them. */
  review: number;
}

/** What a deck in Anki, subdecks included, already holds, for a writer planning more. */
export interface AnkiDeckNotes extends AnkiRead {
  /** As Anki spells it, when it has the deck; else as asked. */
  deck: string;
  exists: boolean;
  /** Every note in it. */
  total: number;
  /** The first field of each, as Anki holds it -- the field a duplicate is judged by. Oldest first, at most the limit asked. */
  firstFields: string[];
}

export interface AnkiExisting extends AnkiRead {
  /** The deck name(s) the notes go into. */
  decks: string[];
  total: number;
  /** Notes Anki already holds, by the rule a send skips them by. */
  existing: number;
  /** Per note, in deck.json's order. */
  inAnki: boolean[];
}

class AnkiUnreachable extends Error {
  constructor(public readonly cause_: string) {
    super(NOT_OPEN);
    this.name = 'AnkiUnreachable';
  }
}

async function invoke<T>(url: string, action: string, params?: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, version: 6, params: params ?? {} }) });
  } catch (err) {
    throw new AnkiUnreachable(String((err as Error)?.cause ?? err));
  }
  if (!res.ok) throw new Error(`AnkiConnect answered ${res.status} to ${action}`);
  const body = (await res.json()) as { result?: T; error?: string | null };
  if (body.error) throw new Error(`AnkiConnect: ${tidyError(body.error)}`);
  return body.result as T;
}

/**
 * AnkiConnect's errors for a batch are a Python list printed as a string,
 * one entry per note -- "['cannot create note because it is a duplicate',
 * …]" a hundred times over. Said once each, with how many.
 */
export function tidyError(error: string): string {
  const list = error.trim();
  if (!list.startsWith('[') || !list.endsWith(']')) return error;
  const items = [...list.matchAll(/(['"])(.*?)\1/gs)].map((m) => m[2]!);
  if (!items.length) return error;
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts].map(([text, n]) => (n > 1 ? `${text} (${n} notes)` : text)).join('; ');
}

export async function ankiStatus(url = ANKI_CONNECT_URL): Promise<AnkiStatus> {
  try {
    const version = await invoke<number>(url, 'version');
    return { url, reachable: true, version, error: null };
  } catch (err) {
    return { url, reachable: false, version: null, error: err instanceof AnkiUnreachable ? NOT_OPEN : String((err as Error).message ?? err) };
  }
}

/** A read of the collection, answered as AnkiRead says; `blank` is the answer's shape with nothing in it. */
async function reading<T extends object>(blank: T, read: () => Promise<T>): Promise<AnkiRead & T> {
  try {
    return { reachable: true, error: null, ...(await read()) };
  } catch (err) {
    return { reachable: false, error: err instanceof AnkiUnreachable ? NOT_OPEN : String((err as Error).message ?? err), ...blank };
  }
}

/**
 * A deck and its subdecks, as Anki's search takes it: `deck:"…"` with the
 * characters the search reads as its own escaped -- a quote, a backslash,
 * and `*` and `_`, which are wildcards there (unescaped, "A_B" also finds
 * "AxB"). Colons and `::` need nothing inside the quotes. Checked against
 * Anki 26.5's own search on a scratch collection.
 */
export function deckQuery(name: string): string {
  return `deck:"${name.replace(/[\\"*_]/g, (c) => `\\${c}`)}"`;
}

/** Anki's deck names. */
export function ankiDecks(url = ANKI_CONNECT_URL): Promise<AnkiDecks> {
  return reading({ decks: [] as string[] }, async () => ({ decks: await invoke<string[]>(url, 'deckNames') }));
}

/** How much of `deck`, subdecks included, has been studied: notes, and cards new, learning and in review. */
export function deckStats(deck: string, url = ANKI_CONNECT_URL): Promise<AnkiDeckStats> {
  const blank = { deck, exists: false, notes: 0, cards: 0, new: 0, learning: 0, review: 0 };
  return reading(blank, async () => {
    // Anki's deck names are one deck whatever their case, as its search is.
    const named = (await invoke<string[]>(url, 'deckNames')).find((d) => d.toLowerCase() === deck.toLowerCase());
    if (named === undefined) return blank;
    const q = deckQuery(named);
    const count = async (action: 'findNotes' | 'findCards', query: string) => (await invoke<number[]>(url, action, { query })).length;
    const notes = await count('findNotes', q);
    const cards = await count('findCards', q);
    // is:new is every card never studied, buried or suspended ones too;
    // is:review every graduated one, relearning included. What is left is
    // learning, so the three add up whatever is suspended.
    const fresh = await count('findCards', `${q} is:new`);
    const review = await count('findCards', `${q} is:review`);
    return { deck: named, exists: true, notes, cards, new: fresh, learning: cards - fresh - review, review };
  });
}

/** The first `limit` notes in `deck` and its subdecks, by their first field, and how many there are in all. */
export function deckNotes(deck: string, limit = 200, url = ANKI_CONNECT_URL): Promise<AnkiDeckNotes> {
  const blank = { deck, exists: false, total: 0, firstFields: [] as string[] };
  return reading(blank, async () => {
    const named = (await invoke<string[]>(url, 'deckNames')).find((d) => d.toLowerCase() === deck.toLowerCase());
    if (named === undefined) return blank;
    // A note's id is when it was made, so oldest first.
    const ids = (await invoke<number[]>(url, 'findNotes', { query: deckQuery(named) })).sort((a, b) => a - b);
    const shown = ids.slice(0, Math.max(0, limit));
    const info = shown.length ? await invoke<{ fields: Record<string, { value: string; order: number }> }[]>(url, 'notesInfo', { notes: shown }) : [];
    const firstFields = info.map((n) => Object.values(n.fields ?? {}).find((f) => f.order === 0)?.value ?? '');
    return { deck: named, exists: true, total: ids.length, firstFields };
  });
}

/** Every note into `deckName` when one is given, as a send and an export both take it. */
function placeNotes(notes: DeckNote[], deckName?: string): DeckNote[] {
  return deckName ? notes.map((n) => ({ ...n, deckName })) : notes;
}

/**
 * A note as canAddNotes and addNotes take it. A duplicate is the rule
 * Anki's own add uses, kept to the deck: the same note type and first
 * field, with a card in that deck.
 */
function asNew(n: DeckNote) {
  return { deckName: n.deckName, modelName: n.modelName, fields: n.fields, tags: n.tags ?? [], options: { allowDuplicate: false, duplicateScope: 'deck' } };
}

/**
 * Which of `<path>`'s notes Anki already holds, by the same rule a send
 * skips them by. canAddNotes also refuses a note whose deck or note type
 * Anki lacks, or whose first field is empty, and here that would read as
 * "already there"; so those are settled first, from the names: a deck Anki
 * does not have holds none of them.
 */
export async function existingNotes(path: string, deckName?: string, url = ANKI_CONNECT_URL): Promise<AnkiExisting> {
  const placed = placeNotes(loadDeckNotes(path), deckName);
  const decks = [...new Set(placed.map((n) => n.deckName))];
  const blank = { decks, total: placed.length, existing: 0, inAnki: placed.map(() => false) };
  return reading(blank, async () => {
    const models = new Set(await invoke<string[]>(url, 'modelNames'));
    const known = new Set((await invoke<string[]>(url, 'deckNames')).map((d) => d.toLowerCase()));
    const asked = placed.flatMap((n, i) => (models.has(n.modelName) && known.has(n.deckName.toLowerCase()) && n.fields.Text.trim() !== '' ? [i] : []));
    const can = asked.length ? await invoke<boolean[]>(url, 'canAddNotes', { notes: asked.map((i) => asNew(placed[i]!)) }) : [];
    const inAnki = placed.map(() => false);
    asked.forEach((i, k) => (inAnki[i] = can[k] === false));
    return { decks, total: placed.length, existing: inAnki.filter(Boolean).length, inAnki };
  });
}

/** Puts `<path>`'s notes, media and note type into the running Anki. `deckName` overrides every note's own. */
export async function sendDeck(path: string, deckName?: string, url = ANKI_CONNECT_URL): Promise<SendResult> {
  const notes = loadDeckNotes(path);
  if (notes.length === 0) throw new Error(`${path} contains no notes`);
  const media = loadDeckMedia(path);
  const status = await ankiStatus(url);
  if (!status.reachable) throw new Error(status.error ?? NOT_OPEN);

  // The note type, once: the same one the exporter writes into an .apkg.
  const models = await invoke<string[]>(url, 'modelNames');
  const createdModel = !models.includes(CUSTOM_CLOZE_MODEL_NAME);
  if (createdModel) {
    await invoke(url, 'createModel', {
      modelName: CUSTOM_CLOZE_MODEL_NAME,
      inOrderFields: [...CUSTOM_CLOZE_FIELD_NAMES],
      css: CUSTOM_CLOZE_CSS,
      isCloze: true,
      cardTemplates: [{ Name: CUSTOM_CLOZE_TEMPLATE_NAME, Front: CUSTOM_CLOZE_QFMT, Back: CUSTOM_CLOZE_AFMT }],
    });
  }

  // The decks: createDeck is idempotent, and addNotes fails the whole batch
  // on a deck it does not know (method/3-cards.md).
  const placed = placeNotes(notes, deckName);
  const decks = [...new Set(placed.map((n) => n.deckName))];
  for (const deck of decks) await invoke(url, 'createDeck', { deck });

  // Every image a field references, from wherever the deck's list says it is.
  const dirs = [resolveMediaDir(), dirname(path)];
  const referenced = [...new Set(placed.flatMap((n) => [...extractMediaFilenames(n.fields.Text), ...extractMediaFilenames(n.fields.Extra ?? '')]))];
  const unresolvedMedia: string[] = [];
  let stored = 0;
  for (const filename of referenced) {
    const file = resolveMediaFile(filename, media, dirs);
    if (file === undefined) {
      unresolvedMedia.push(filename);
      continue;
    }
    await invoke(url, 'storeMediaFile', { filename, path: file });
    stored += 1;
  }

  // Only the notes Anki will take. Older AnkiConnect answered a duplicate
  // with a null id; newer versions fail the whole addNotes call with one
  // error per refused note, so a deck sent twice came back as a wall of
  // "cannot create note because it is a duplicate". canAddNotes is in both.
  const asked = placed.map(asNew);
  const can = await invoke<boolean[]>(url, 'canAddNotes', { notes: asked });
  const fresh = asked.filter((_, i) => can[i] !== false);
  const ids = fresh.length ? await invoke<(number | null)[]>(url, 'addNotes', { notes: fresh }) : [];
  const added = ids.filter((id) => id !== null).length;
  return { decks, total: placed.length, added, skipped: placed.length - added, media: stored, unresolvedMedia, createdModel };
}

export function ankiMethods(): Record<string, MethodHandler> {
  const str = (params: unknown, key: string, required: boolean): string | undefined => {
    const p = (params ?? {}) as Record<string, unknown>;
    const v = p[key];
    if (v === undefined) {
      if (required) throw new InvalidParams(`${key} is required`);
      return undefined;
    }
    if (typeof v !== 'string' || v === '') throw new InvalidParams(`${key} must be a non-empty string`);
    return v;
  };
  return {
    'anki/status': () => ankiStatus(),
    'anki/send': (params) => sendDeck(str(params, 'path', true)!, str(params, 'deckName', false)),
    'anki/decks': () => ankiDecks(),
    'anki/deckStats': (params) => deckStats(str(params, 'deck', true)!),
    'anki/existing': (params) => existingNotes(str(params, 'path', true)!, str(params, 'deckName', false)),
    'anki/deckNotes': (params) => {
      const limit = (params as Record<string, unknown> | undefined)?.limit;
      if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0)) throw new InvalidParams('limit must be a whole number, 0 or more');
      return deckNotes(str(params, 'deck', true)!, limit);
    },
  };
}
