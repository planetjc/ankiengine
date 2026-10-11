// A local stand-in for AnkiConnect (the add-on's JSON endpoint on
// localhost:8765): every request is `{action, version, params}` and every
// answer `{result, error}`. The test points the sidecar here through env
// APE_ANKI_CONNECT and reads back every action from `calls`. It holds a
// tiny collection -- model names, deck names, stored media, added notes and
// their cards -- so a send can be checked for what it created and in what
// order, and a read for what it found.
//
// Searches (findNotes, findCards) are parsed the way Anki's are, as far as
// the engine uses them: `deck:"…"` matches the deck and its subdecks, any
// case, with `*` and `_` as wildcards unless escaped and an unknown escape
// refused; `is:new`, `is:learn`, `is:review`, negated with `-`. Anything
// else is an error, so a query Anki would read differently fails here too.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeCall {
  action: string;
  params: Record<string, unknown>;
}

/** A card's place in Anki's scheduler, by card type: relearning is a graduated card that lapsed. */
export type FakeCardState = 'new' | 'learning' | 'review' | 'relearning';

export interface FakeCard {
  id: number;
  nid: number;
  deck: string;
  state: FakeCardState;
}

export interface FakeAnki {
  url: string;
  calls: FakeCall[];
  models: string[];
  decks: string[];
  media: { filename: string; path: string }[];
  /** Notes as addNotes was given them, each with the id it was given. */
  notes: Record<string, unknown>[];
  cards: FakeCard[];
  /** Field Text values that addNotes should refuse as duplicates. */
  duplicates: Set<string>;
  /** A note already in the collection, as if studied there: one card per state given. */
  addNote(deck: string, text: string, states?: FakeCardState[], modelName?: string): number;
  close(): Promise<void>;
}

/** Every action that only reads the collection. A read method calls nothing else. */
export const READ_ONLY = new Set(['version', 'deckNames', 'modelNames', 'findNotes', 'findCards', 'canAddNotes', 'notesInfo']);

const ESCAPABLE = '\\"*_:()-';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The query's terms: split on spaces outside quotes, a backslash keeping the next character whole. */
function tokenize(query: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < query.length; i++) {
    const c = query[i]!;
    if (c === '\\' && i + 1 < query.length) cur += c + query[++i];
    else if (c === '"') {
      quoted = !quoted;
      cur += c;
    } else if (!quoted && /\s/.test(c)) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (quoted) throw new Error('unbalanced quotes in search');
  if (cur) out.push(cur);
  return out;
}

/** A deck: value as Anki's search reads it, still escaped: the deck itself or anything under it. */
function deckPattern(value: string): RegExp {
  let re = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === '\\') {
      const e = value[++i];
      if (e === undefined || !ESCAPABLE.includes(e)) throw new Error(`invalid escape sequence \\${e ?? ''} in search`);
      re += escapeRe(e);
    } else if (c === '*') re += '.*';
    else if (c === '_') re += '.';
    else re += escapeRe(c);
  }
  return new RegExp(`^${re}(::|$)`, 'i');
}

function cardMatcher(query: string): (card: FakeCard) => boolean {
  const tests = tokenize(query).map((term) => {
    const negated = term.startsWith('-');
    // Quotes may wrap the term or its value: "deck:x" and deck:"x" are one search. Escaped quotes stay.
    const bare = (negated ? term.slice(1) : term).replace(/(\\.)|"/g, (_, esc: string | undefined) => esc ?? '');
    const colon = bare.indexOf(':');
    const key = colon < 0 ? '' : bare.slice(0, colon).toLowerCase();
    const value = bare.slice(colon + 1);
    let test: (card: FakeCard) => boolean;
    if (key === 'deck') {
      const pattern = deckPattern(value);
      test = (card) => pattern.test(card.deck);
    } else if (key === 'is' && value === 'new') test = (card) => card.state === 'new';
    else if (key === 'is' && value === 'learn') test = (card) => card.state === 'learning' || card.state === 'relearning';
    else if (key === 'is' && value === 'review') test = (card) => card.state === 'review' || card.state === 'relearning';
    else throw new Error(`the fake does not search ${JSON.stringify(term)}`);
    return negated ? (card: FakeCard) => !test(card) : test;
  });
  return (card) => tests.every((t) => t(card));
}

/** How many cards a cloze note makes: one per distinct cloze number, at least one. */
function clozeCount(text: string): number {
  return Math.max(1, new Set([...text.matchAll(/\{\{c(\d+)::/g)].map((m) => m[1])).size);
}

/**
 * `strict` is AnkiConnect as it is now: addNotes fails the whole call when
 * any note is refused, its error a Python list of one message per note.
 * Without it, the older answer: a null id for each refused note.
 */
export async function startFakeAnki(opts: { models?: string[]; decks?: string[]; strict?: boolean; port?: number } = {}): Promise<FakeAnki> {
  const state: Omit<FakeAnki, 'url' | 'close' | 'addNote'> = { calls: [], models: opts.models ?? ['Basic', 'Cloze'], decks: opts.decks ?? ['Default'], media: [], notes: [], cards: [], duplicates: new Set() };
  let nextId = 1000;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  // Anki makes a deck's parents with it.
  const makeDeck = (name: string) => {
    const parts = name.split('::');
    for (let i = 1; i <= parts.length; i++) {
      const deck = parts.slice(0, i).join('::');
      if (!state.decks.some((d) => same(d, deck))) state.decks.push(deck);
    }
  };
  const store = (n: Record<string, unknown>, states?: FakeCardState[]): number => {
    const id = nextId++;
    state.notes.push({ ...n, id });
    const text = (n.fields as Record<string, string>).Text ?? '';
    for (const s of states ?? Array.from({ length: clozeCount(text) }, (): FakeCardState => 'new')) state.cards.push({ id: nextId++, nid: id, deck: n.deckName as string, state: s });
    return id;
  };
  // AnkiConnect's duplicateScope "deck": the same note type and first field, with a card in that deck.
  const refusal = (n: Record<string, unknown>): string | null => {
    if (!state.models.includes(n.modelName as string)) return `model was not found: ${n.modelName}`;
    if (!state.decks.some((d) => same(d, n.deckName as string))) return `deck was not found: ${n.deckName}`;
    const text = (n.fields as Record<string, string>).Text ?? '';
    if (!text.trim()) return 'cannot create note because it is empty';
    const there = state.notes.some(
      (o) => o.modelName === n.modelName && (o.fields as Record<string, string>).Text === text && state.cards.some((c) => c.nid === o.id && same(c.deck, n.deckName as string)),
    );
    if (there || state.duplicates.has(text)) return 'cannot create note because it is a duplicate';
    return null;
  };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const { action, params = {} } = JSON.parse(body) as { action: string; params?: Record<string, unknown> };
      state.calls.push({ action, params });
      const reply = (result: unknown, error: string | null = null) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ result, error }));
      };
      try {
        switch (action) {
          case 'version':
            return reply(6);
          case 'modelNames':
            return reply(state.models);
          case 'createModel':
            state.models.push(params.modelName as string);
            return reply({ id: 1 });
          case 'deckNames':
            return reply(state.decks);
          case 'createDeck':
            makeDeck(params.deck as string);
            return reply(1);
          case 'storeMediaFile':
            state.media.push({ filename: params.filename as string, path: params.path as string });
            return reply(params.filename);
          case 'findCards': {
            const match = cardMatcher(params.query as string);
            return reply(state.cards.filter(match).map((c) => c.id));
          }
          case 'findNotes': {
            const match = cardMatcher(params.query as string);
            return reply([...new Set(state.cards.filter(match).map((c) => c.nid))]);
          }
          case 'notesInfo': {
            // As AnkiConnect gives them: every field with its value and place in the note type; an unknown id is {}.
            return reply(
              (params.notes as number[]).map((id) => {
                const n = state.notes.find((o) => o.id === id);
                if (!n) return {};
                const fields = Object.fromEntries(Object.entries(n.fields as Record<string, string>).map(([name, value], order) => [name, { value, order }]));
                return { noteId: id, modelName: n.modelName, tags: n.tags ?? [], fields, cards: state.cards.filter((c) => c.nid === id).map((c) => c.id) };
              }),
            );
          }
          case 'canAddNotes':
            return reply((params.notes as Record<string, unknown>[]).map((n) => refusal(n) === null));
          case 'addNotes': {
            const notes = params.notes as Record<string, unknown>[];
            const refused = notes.map(refusal).filter((r) => r !== null);
            if (opts.strict && refused.length) return reply(null, `[${refused.map((r) => `'${r}'`).join(', ')}]`);
            return reply(notes.map((n) => (refusal(n) === null ? store(n) : null)));
          }
          default:
            return reply(null, `unsupported action: ${action}`);
        }
      } catch (err) {
        return reply(null, (err as Error).message);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  // A test that fails before its close() must not keep the run from ending.
  server.unref();
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    ...state,
    addNote(deck, text, states = ['new'], modelName = 'Custom Cloze') {
      makeDeck(deck);
      if (!state.models.includes(modelName)) state.models.push(modelName);
      return store({ deckName: deck, modelName, fields: { Text: text, Extra: '', Source: '' }, tags: [] }, states);
    },
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
