// Builds collection.anki21: schema-11 tables plus the one `col` row, every
// `notes` row, and every `cards` row -- docs/research/apkg-format.md §4-§8.
// How those bytes are produced is the caller's choice (sqlite.ts): under
// Node the database is a scratch file, because node:sqlite can only address
// a path; in a browser it is in memory. Everything below -- the schema, the
// rows, every value written -- is identical on both, which is what makes the
// two outputs comparable byte-for-byte.

import type { DeckNote } from '../types.js';
import type { OpenSqlite } from './sqlite.js';
import { executeSchema } from './schema-sql.js';
import { buildCustomClozeModel } from './notetype.js';
import { CUSTOM_CLOZE_MODEL_NAME } from './notetype-source.js';
import { IdAllocator, contentGuid } from './ids.js';
import { normalizeFieldText, stripHtmlPreservingMediaFilenames, fieldChecksum } from './text.js';

/**
 * The notetype's id, fixed. Anki matches an imported notetype by id before
 * name (doc §5d): one taken from the export clock was new every time, so each
 * import added another renamed "Custom Cloze" and hung that export's notes on
 * it. Fixed, the second import finds the first one's and reuses it. It is a
 * millisecond timestamp like any Anki id (2025-09-07, when the exporter was
 * written), well clear of the ids handed out from the export clock.
 */
export const CUSTOM_CLOZE_MODEL_ID = 1_757_203_200_000;
import { distinctClozeNumbers } from './cloze.js';

// doc §5b, "Always include it, verbatim" -- the hardcoded id-1 deck every
// current Anki assumes exists (rslib/src/notetype/cardgen.rs's
// default_deck_conf(), cited in the doc).
const DEFAULT_DECK = {
  id: 1,
  mod: 0,
  name: 'Default',
  usn: 0,
  lrnToday: [0, 0],
  revToday: [0, 0],
  newToday: [0, 0],
  timeToday: [0, 0],
  collapsed: true,
  browserCollapsed: true,
  desc: '',
  dyn: 0,
  conf: 1,
  extendNew: 0,
  extendRev: 0,
  reviewLimit: null,
  newLimit: null,
  reviewLimitToday: null,
  newLimitToday: null,
  desiredRetention: null,
};

// doc §5c -- "known-good, taken verbatim from a real, successfully-importing
// file" rather than individually re-derived key-by-key from source (the doc
// flags this whole blob as lower confidence for that reason). Doesn't vary
// per note/card, so copying it verbatim carries very low risk regardless.
const DEFAULT_DCONF = {
  id: 1,
  mod: 0,
  name: 'Default',
  usn: 0,
  maxTaken: 60,
  autoplay: true,
  timer: 0,
  replayq: true,
  new: { bury: false, delays: [1.0, 10.0], initialFactor: 2500, ints: [1, 4, 0], order: 1, perDay: 20 },
  rev: { bury: false, ease4: 1.3, ivlFct: 1.0, maxIvl: 36500, perDay: 200, hardFactor: 1.2 },
  lapse: { delays: [10.0], leechAction: 1, leechFails: 8, minInt: 1, mult: 0.0 },
  dyn: false,
  newMix: 0,
  newPerDayMinimum: 0,
  interdayLearningMix: 0,
  reviewOrder: 0,
  newSortOrder: 0,
  newGatherPriority: 0,
  buryInterdayLearning: false,
  fsrsWeights: [] as number[],
  fsrsParams5: [] as number[],
  fsrsParams6: [] as number[],
  desiredRetention: 0.9,
  ignoreRevlogsBeforeDate: '',
  easyDaysPercentages: [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
  stopTimerOnAnswer: false,
  secondsToShowQuestion: 0.0,
  secondsToShowAnswer: 0.0,
  questionAction: 0,
  answerAction: 0,
  waitForAudio: true,
  sm2Retention: 0.9,
  weightSearch: '',
};

/** One of the export's own decks, alongside Default in col.decks (doc §5b). */
function makeDeck(id: number, name: string, nowSeconds: number) {
  return {
    id,
    mod: nowSeconds,
    name, // the exact "::"-joined hierarchical name, stored as-is (doc §5b)
    usn: -1, // "created locally, not yet synced" -- matches a real user-created deck
    lrnToday: [0, 0],
    revToday: [0, 0],
    newToday: [0, 0],
    timeToday: [0, 0],
    collapsed: false,
    browserCollapsed: false,
    desc: '',
    dyn: 0,
    conf: 1, // reuses the one dconf group rather than minting a new one
    extendNew: 0,
    extendRev: 0,
    reviewLimit: null,
    newLimit: null,
    reviewLimitToday: null,
    newLimitToday: null,
    desiredRetention: null,
  };
}

export interface BuildCollectionOptions {
  /**
   * Puts every note into this one deck, whatever its own deckName says --
   * the override Send to Anki takes too (src/sidecar/anki.ts). Left out,
   * each note goes into the deck its own deckName names: one deck per
   * distinct name, the way an exam deck keeps a subdeck per chapter.
   */
  deckName?: string;
  /** epoch ms, from the caller's clock -- the sole source of "now". */
  clockMs: number;
  /** Where the SQLite database comes from -- sqlite.ts. */
  openSqlite: OpenSqlite;
}

interface NoteRow {
  id: number;
  guid: string;
  mid: number;
  mod: number;
  usn: number;
  tags: string;
  flds: string;
  sfld: string;
  csum: number;
  flags: number;
  data: string;
}

interface CardRow {
  id: number;
  nid: number;
  did: number;
  ord: number;
  mod: number;
  usn: number;
  type: number;
  queue: number;
  due: number;
  ivl: number;
  factor: number;
  reps: number;
  lapses: number;
  left: number;
  odue: number;
  odid: number;
  flags: number;
  data: string;
}

/**
 * Builds the full collection.anki21 SQLite file and returns its bytes.
 * Every id, timestamp, and guid is derived from `clockMs` and this
 * function's own counters -- no Date.now()/Math.random() anywhere in this
 * module, which is what makes byte-identical output possible for two calls
 * given the same clock (determinism.test.ts).
 */
export function buildCollection(notes: DeckNote[], options: BuildCollectionOptions): Uint8Array {
  const { deckName: override, clockMs } = options;
  const nowSeconds = Math.floor(clockMs / 1000); // doc §5: col.crt and every notes/cards `mod` are seconds

  if (override !== undefined && override.trim() === '') {
    throw new Error(`options.deckName is empty -- leave it out to keep each note's own deckName`);
  }
  // Which deck each note goes into, settled before anything is written:
  // deck.json is LLM-authored, so a note naming no deck is rejected here,
  // named to the note, rather than exported into a nameless one.
  const placed = notes.map((note, noteIndex) => {
    if (override !== undefined) return override;
    if (typeof note.deckName !== 'string' || note.deckName.trim() === '') {
      throw new Error(`notes[${noteIndex}].deckName is ${JSON.stringify(note.deckName)} -- every note names the deck it goes into`);
    }
    return note.deckName;
  });

  const ids = new IdAllocator(clockMs);
  const modelId = CUSTOM_CLOZE_MODEL_ID;
  // One deck per distinct name, in the order the notes first name them, and
  // their ids taken before any note's -- as the single deck's always was, so
  // a one-deck export comes out byte-for-byte as it did before.
  const deckIds = new Map<string, number>();
  for (const name of placed) if (!deckIds.has(name)) deckIds.set(name, ids.next());

  const models = { [String(modelId)]: buildCustomClozeModel(modelId, nowSeconds) };

  // Parents ("Botany", "Botany::Test 1") are left out: Anki's importer
  // creates any a deck's name implies, as it always has for the one deck.
  const decks: Record<string, unknown> = { '1': DEFAULT_DECK };
  for (const [name, id] of deckIds) decks[String(id)] = makeDeck(id, name, nowSeconds);
  const dconf = { '1': DEFAULT_DCONF };
  const firstDeckId = deckIds.values().next().value ?? DEFAULT_DECK.id;

  const noteRows: NoteRow[] = [];
  const cardRows: CardRow[] = [];
  let dueCounter = 1; // doc §7: one counter, advanced once per NOTE, shared by that note's own cards
  const seen = new Map<string, number>(); // guid key -> how many notes already had it

  for (const [noteIndex, note] of notes.entries()) {
    // modelName is part of the AnkiConnect-shaped DeckNote a note arrives
    // as, but every card here uses the one hardcoded Custom Cloze model: a
    // note naming another is rejected, not silently re-typed.
    if (note.modelName !== CUSTOM_CLOZE_MODEL_NAME) {
      throw new Error(
        `notes[${noteIndex}].modelName is ${JSON.stringify(note.modelName)}, but this exporter only ` +
          `emits the ${JSON.stringify(CUSTOM_CLOZE_MODEL_NAME)} notetype and has no way to honour a ` +
          `different one`,
      );
    }

    // doc §6 "Control characters": strip every ASCII control char except
    // \n/\t before the text is ever joined, hashed, or stored.
    const text = normalizeFieldText(note.fields.Text);
    const extra = normalizeFieldText(note.fields.Extra);
    const source = normalizeFieldText(note.fields.Source);

    const deckName = placed[noteIndex]!;
    const noteId = ids.next();
    // Custom Cloze's sortf is always 0 (Text): field-0-stripped and
    // sort-field-stripped are therefore the same computation here, per the
    // doc's general rule in §6 ("csum is always field 0 ... sfld is
    // whichever field sortf names").
    const strippedField0 = stripHtmlPreservingMediaFilenames(text);

    // The guid is the note's identity across exports: the deck, the notetype
    // and the first field as Anki strips it -- the same deck-scoped
    // "same first field" rule Send to Anki's duplicate check applies
    // (src/sidecar/anki.ts), so both routes agree on what is the same card.
    // Re-exported unchanged, or with only Extra, Source or formatting
    // changed, a note updates the one already in Anki; reworded, it arrives
    // as a new note, as it would over AnkiConnect. A note whose stripped
    // Text repeats an earlier one in this deck takes its occurrence number,
    // which keeps guids unique within the file.
    const key = [deckName, CUSTOM_CLOZE_MODEL_NAME, strippedField0].join('\x1f');
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);

    noteRows.push({
      id: noteId,
      guid: contentGuid(occurrence === 0 ? key : `${key}\x1f${occurrence}`),
      mid: modelId,
      mod: nowSeconds,
      usn: -1,
      // One leading and one trailing space, always -- doc §6. NOT the naive
      // " " + tags.join(" ") + " ": that formula gives "  " (two spaces)
      // for zero tags, but the doc's own worked value for that case is a
      // single space. The formula that actually produces a single shared
      // space for zero tags while still matching every populated case
      // (verified against the doc's real 3-4 tag sample and the single-tag
      // case) is "each tag prefixed by a space, then one trailing space" --
      // equivalent to the naive formula whenever tags.length > 0, and
      // collapsing correctly to " " when it's empty. Special-cased
      // directly rather than relying on that equivalence to stay obvious.
      tags: note.tags.length === 0 ? ' ' : ` ${note.tags.join(' ')} `,
      flds: [text, extra, source].join('\x1f'),
      sfld: strippedField0,
      csum: fieldChecksum(strippedField0),
      flags: 0,
      data: '', // doc §6: empty string -- contrast with cards.data below
    });

    // doc §7: cloze_number_in_fields scans every field, not just the one
    // the template renders. distinctClozeNumbers already drops anything
    // that can't fit cardgen.rs's HashSet<u16> (>65535); what's left still
    // needs the same `saturating_sub(1).min(499)` cardgen.rs applies to
    // every surviving element -- the doc's exact quoted expression, not an
    // unbounded `clozeNumber - 1` (a {{c0::}} typo would otherwise write a
    // negative ord; anything past c500 would otherwise write an ord past
    // what any real Anki-generated card can carry).
    const ordinals = distinctClozeNumbers({ Text: text, Extra: extra, Source: source });
    const due = dueCounter;
    dueCounter += 1;

    // The clamp below is many-to-one at both ends (0 and 1 both floor to
    // ord 0; every number >= 500 ceilings to ord 499), so -- unlike
    // `ordinals`, whose entries are distinct cloze *numbers* -- the ords
    // produced here are not guaranteed distinct. `ordinals` is sorted
    // ascending and the clamp is monotonic non-decreasing, so any
    // collision is necessarily between adjacent entries: comparing each
    // new ord only to the immediately preceding one is therefore a
    // complete dedupe, not merely a heuristic one.
    let previousOrd: number | undefined;
    for (const clozeNumber of ordinals) {
      const ord = Math.min(Math.max(clozeNumber - 1, 0), 499);
      if (ord === previousOrd) continue;
      previousOrd = ord;
      cardRows.push({
        id: ids.next(),
        nid: noteId,
        did: deckIds.get(deckName)!,
        ord,
        mod: nowSeconds,
        usn: -1,
        type: 0,
        queue: 0,
        due,
        ivl: 0,
        factor: 0,
        reps: 0,
        lapses: 0,
        left: 0,
        odue: 0,
        odid: 0,
        flags: 0,
        data: '{}', // doc §7: "{}", not empty -- the inverse of notes.data
      });
    }
  }

  // doc §5a: nextPos = (highest due assigned) + 1, so a live Anki that
  // imports this file and then adds one more card by hand doesn't collide
  // with a due value this file already used. dueCounter has already been
  // advanced past the last note's due, so it IS that value.
  const conf = {
    curDeck: firstDeckId,
    schedVer: 2, // doc §5a: hard-required by the importer's scheduler-version check
    collapseTime: 1200,
    estTimes: true,
    addToCur: true,
    creationOffset: 240,
    dayLearnFirst: false,
    newSpread: 0,
    sched2021: true,
    nextPos: dueCounter,
    curModel: modelId,
    activeDecks: [firstDeckId],
    dueCounts: true,
    timeLim: 0,
    sortBackwards: false,
    sortType: 'noteFld',
  };

  return writeCollectionFile({ nowSeconds, clockMs, conf, models, decks, dconf, noteRows, cardRows }, options.openSqlite);
}

interface WriteArgs {
  nowSeconds: number;
  clockMs: number;
  conf: unknown;
  models: unknown;
  decks: unknown;
  dconf: unknown;
  noteRows: NoteRow[];
  cardRows: CardRow[];
}

function writeCollectionFile(args: WriteArgs, openSqlite: OpenSqlite): Uint8Array {
  const db = openSqlite();
  let finished = false;
  try {
    executeSchema(db);

    db.prepare(
      `INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags)
       VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, '{}')`,
    ).run(
      args.nowSeconds,
      args.clockMs, // col.mod: milliseconds (doc §5)
      args.clockMs, // col.scm: milliseconds, "now" is safe (doc §5)
      JSON.stringify(args.conf),
      JSON.stringify(args.models),
      JSON.stringify(args.decks),
      JSON.stringify(args.dconf),
    );

    const insertNote = db.prepare(
      `INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of args.noteRows) {
      insertNote.run(row.id, row.guid, row.mid, row.mod, row.usn, row.tags, row.flds, row.sfld, row.csum, row.flags, row.data);
    }

    const insertCard = db.prepare(
      `INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of args.cardRows) {
      insertCard.run(
        row.id,
        row.nid,
        row.did,
        row.ord,
        row.mod,
        row.usn,
        row.type,
        row.queue,
        row.due,
        row.ivl,
        row.factor,
        row.reps,
        row.lapses,
        row.left,
        row.odue,
        row.odid,
        row.flags,
        row.data,
      );
    }
    const bytes = db.finish();
    finished = true;
    return bytes;
  } finally {
    // finish() has already released everything on the success path; this is
    // the throw path, where a scratch file would otherwise outlive the call.
    if (!finished) db.dispose();
  }
}
