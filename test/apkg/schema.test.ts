// The generated collection's SQLite schema and its one `col` row, against
// docs/research/apkg-format.md §4 (schema) and §5 (col row).
//
// Ground truth for every literal SQL string below is PRIMARY: it was read
// directly out of a real Anki-exported .apkg found on this machine
// (~/Dev/Anki/backups/pre-push-20260706-123359/apkg/ISF-Week_1-Histology.apkg,
// `collection.anki21`'s own sqlite_master.sql column, not the pretty-printed
// `.schema` CLI output -- the doc's own §4 independently transcribes the
// same text from `rslib/src/storage/schema11.sql` and states the two agree
// character-for-character; this file re-derives the constants directly from
// the real database instead of copying the doc's copy). The Default-deck
// JSON object in DEFAULT_DECK is the doc's own "verbatim" block (§5b) --
// doc-sourced, not independently re-read from the real file this session,
// since the real file's own "Default" deck entry sits at a different (long
// since modified) `mod` than a fresh export would produce. The notetype
// css/qfmt/afmt/field-name constants are read directly from
// anki/custom-cloze.json (the actual source of truth cited by the doc for
// this note type), not retyped by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeApkg } from '../../dist/apkg/index.js';
import type { DeckNote } from '../../dist/types.js';
import {
  FIXED_CLOCK_MS,
  fixedClock,
  makeTempDir,
  makeEmptyMediaDir,
  makeNote,
  extractZipMember,
  openCollection,
} from './helpers.ts';

// --- Ground truth: literal DDL text, read verbatim from sqlite_master.sql
// on a real Anki-exported collection.anki21 (see file header). ---
const SQL_CARDS =
  'CREATE TABLE cards (\n  id integer PRIMARY KEY,\n  nid integer NOT NULL,\n  did integer NOT NULL,\n  ord integer NOT NULL,\n  mod integer NOT NULL,\n  usn integer NOT NULL,\n  type integer NOT NULL,\n  queue integer NOT NULL,\n  due integer NOT NULL,\n  ivl integer NOT NULL,\n  factor integer NOT NULL,\n  reps integer NOT NULL,\n  lapses integer NOT NULL,\n  left integer NOT NULL,\n  odue integer NOT NULL,\n  odid integer NOT NULL,\n  flags integer NOT NULL,\n  data text NOT NULL\n)';
const SQL_COL =
  'CREATE TABLE col (\n  id integer PRIMARY KEY,\n  crt integer NOT NULL,\n  mod integer NOT NULL,\n  scm integer NOT NULL,\n  ver integer NOT NULL,\n  dty integer NOT NULL,\n  usn integer NOT NULL,\n  ls integer NOT NULL,\n  conf text NOT NULL,\n  models text NOT NULL,\n  decks text NOT NULL,\n  dconf text NOT NULL,\n  tags text NOT NULL\n)';
const SQL_GRAVES =
  'CREATE TABLE graves (\n  usn integer NOT NULL,\n  oid integer NOT NULL,\n  type integer NOT NULL\n)';
const SQL_NOTES =
  'CREATE TABLE notes (\n  id integer PRIMARY KEY,\n  guid text NOT NULL,\n  mid integer NOT NULL,\n  mod integer NOT NULL,\n  usn integer NOT NULL,\n  tags text NOT NULL,\n  flds text NOT NULL,\n  -- The use of type integer for sfld is deliberate, because it means that integer values in this\n  -- field will sort numerically.\n  sfld integer NOT NULL,\n  csum integer NOT NULL,\n  flags integer NOT NULL,\n  data text NOT NULL\n)';
const SQL_REVLOG =
  'CREATE TABLE revlog (\n  id integer PRIMARY KEY,\n  cid integer NOT NULL,\n  usn integer NOT NULL,\n  ease integer NOT NULL,\n  ivl integer NOT NULL,\n  lastIvl integer NOT NULL,\n  factor integer NOT NULL,\n  time integer NOT NULL,\n  type integer NOT NULL\n)';

const EXPECTED_TABLE_SQL: Record<string, string> = {
  col: SQL_COL,
  notes: SQL_NOTES,
  cards: SQL_CARDS,
  revlog: SQL_REVLOG,
  graves: SQL_GRAVES,
};

const EXPECTED_INDEX_SQL: Record<string, string> = {
  ix_notes_usn: 'CREATE INDEX ix_notes_usn ON notes (usn)',
  ix_cards_usn: 'CREATE INDEX ix_cards_usn ON cards (usn)',
  ix_revlog_usn: 'CREATE INDEX ix_revlog_usn ON revlog (usn)',
  ix_cards_nid: 'CREATE INDEX ix_cards_nid ON cards (nid)',
  ix_cards_sched: 'CREATE INDEX ix_cards_sched ON cards (did, queue, due)',
  ix_revlog_cid: 'CREATE INDEX ix_revlog_cid ON revlog (cid)',
  ix_notes_csum: 'CREATE INDEX ix_notes_csum ON notes (csum)',
};

// doc §5b, "Always include it, verbatim". Doc-sourced (priority 3), not
// independently re-read from the real file this session -- the real file's
// own Default deck entry has since been modified by real use (its `mod` is
// no longer 0), so it's not a usable ground-truth source for what a
// *fresh* export should contain.
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

// Read directly from anki/custom-cloze.json (the note type's actual source
// of truth per the doc), not retyped by hand -- see the top-of-file note.
const CUSTOM_CLOZE_CSS =
  '.card { font-family: Menlo, baskerville, sans;\n        font-size: 19px; line-height: 1.5; max-width: 760px; margin: 0 auto; padding: 8px;\n        text-align: center; color: #D7DEE9; background-color: #333B45; }\n.nightMode.card, .night_mode .card { color: #D7DEE9 !important; background-color: #333B45 !important; }\n.cloze { font-weight: bold; color: MediumSeaGreen; }\n.nightMode .cloze, .night_mode .cloze { color: MediumSeaGreen !important; }\nb { color: #C695C6 !important; }\ni { color: IndianRed !important; }\nu { color: #5EB3B3 !important; }\nimg { max-width: 100%; height: auto; border-radius: 6px; margin: 8px 0; }\nhr { border: none; border-top: 1px solid #555; margin: 14px 0; }\n.btn-reveal { display: inline-block; background: #3b4654; color: #D7DEE9;\n              border: 1px solid #51606e; border-radius: 6px; padding: 5px 12px;\n              font-size: 14px; cursor: pointer; margin: 12px 0 6px; }\n.btn-reveal:hover { background: #45525f; }\n.extra { text-align: center; background: #2c343d; border-radius: 8px;\n         padding: 10px 14px; margin: 6px 0; }\n.src { color: #839496; font-size: 13px; font-style: italic; margin-top: 10px; }';
const CUSTOM_CLOZE_QFMT = '{{cloze:Text}}';
const CUSTOM_CLOZE_AFMT =
  '{{cloze:Text}}{{#Extra}}<div class="extra">{{Extra}}</div>{{/Extra}}{{#Source}}<div class="src">{{Source}}</div>{{/Source}}';

const DECK_NAME = 'Fixtures::Reference Cards';

function loadOneNote(): DeckNote {
  const fixturePath = join(import.meta.dirname, '..', 'fixtures', 'reference-cards.json');
  const { notes } = JSON.parse(readFileSync(fixturePath, 'utf8')) as { notes: DeckNote[] };
  // ref-01: a plain two-cloze note, nothing schema.test.ts needs to vary.
  return notes[0];
}

async function buildFixtureCollection() {
  const tempDir = makeTempDir('schema');
  const outPath = join(tempDir, 'out.apkg');
  const mediaDir = makeEmptyMediaDir(tempDir); // no note here references media
  await writeApkg([loadOneNote()], { deckName: DECK_NAME, outPath, mediaDir, clock: fixedClock });
  const dbPath = extractZipMember(outPath, 'collection.anki21', tempDir);
  const db = openCollection(dbPath);
  return { db, tempDir };
}

test('schema: exactly the five schema-11 tables, each matching the real Anki DDL text literally', async () => {
  const { db } = await buildFixtureCollection();
  const rows = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string; sql: string }[];
  db.close();

  const names = rows.map((r) => r.name).sort();
  assert.deepEqual(
    names,
    Object.keys(EXPECTED_TABLE_SQL).sort(),
    'unexpected table set -- schema11 defines exactly col/notes/cards/revlog/graves; ' +
      'no notetypes table (that is the live, normalized schema, not the export format), ' +
      'and no sqlite_stat1/sqlite_stat4 (those are ANALYZE artifacts a from-scratch writer never produces)',
  );
  for (const row of rows) {
    assert.equal(row.sql, EXPECTED_TABLE_SQL[row.name], `table ${row.name} DDL text must match schema11 verbatim`);
  }
});

test('schema: exactly the seven expected indices, each matching the real Anki DDL text literally', async () => {
  const { db } = await buildFixtureCollection();
  const rows = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' ORDER BY name")
    .all() as { name: string; sql: string }[];
  db.close();

  const names = rows.map((r) => r.name).sort();
  assert.deepEqual(names, Object.keys(EXPECTED_INDEX_SQL).sort());
  for (const row of rows) {
    assert.equal(row.sql, EXPECTED_INDEX_SQL[row.name]);
  }
});

test('schema: no ANALYZE tables and no live-schema notetypes table', async () => {
  const { db } = await buildFixtureCollection();
  const names = (db.prepare('SELECT name FROM sqlite_master').all() as { name: string }[]).map((r) => r.name);
  db.close();
  for (const forbidden of ['sqlite_stat1', 'sqlite_stat4', 'notetypes', 'config', 'deck_config', 'fields']) {
    assert.ok(!names.includes(forbidden), `sqlite_master must not contain "${forbidden}"`);
  }
});

test('col: exactly one row, id 1, with the schema-11 bootstrap constants', async () => {
  const { db } = await buildFixtureCollection();
  const rowCount = (db.prepare('SELECT count(*) as n FROM col').get() as { n: number }).n;
  assert.equal(rowCount, 1);

  const col = db
    .prepare('SELECT id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags FROM col')
    .get() as Record<string, unknown>;
  db.close();

  assert.equal(col.id, 1);
  assert.equal(col.ver, 11, 'ver must be the schema-11 marker');
  assert.equal(col.dty, 0);
  assert.equal(col.usn, 0);
  assert.equal(col.ls, 0);
  assert.equal(col.tags, '{}', 'the legacy tag-name cache is never populated, even with tagged notes present');

  // crt is deliberately NOT pinned to an exact value: the doc (§5) states any
  // reasonable value is safe here since brand-new cards never touch
  // day-based due math. Only sanity-check its shape.
  assert.equal(typeof col.crt, 'number');
  assert.ok(Number.isInteger(col.crt as number) && (col.crt as number) >= 0);

  // mod/scm ARE exactly pinned: both are "now" at export time in
  // milliseconds (doc §5's timestamp convention), and with a fixed clock
  // "now" is a known constant -- this only works because writeApkg is
  // required to source every timestamp from `clock()`, never Date.now().
  assert.equal(col.mod, FIXED_CLOCK_MS);
  assert.equal(col.scm, FIXED_CLOCK_MS);
});

test('col.conf: schedVer must be 2 (Anki hard-rejects a v1-scheduler import)', async () => {
  const { db } = await buildFixtureCollection();
  const conf = JSON.parse((db.prepare('SELECT conf FROM col').get() as { conf: string }).conf);
  db.close();
  assert.equal(conf.schedVer, 2);
});

test('col.decks: the built-in Default deck (id 1) is present verbatim, plus one deck for this export', async () => {
  const { db } = await buildFixtureCollection();
  const decks = JSON.parse((db.prepare('SELECT decks FROM col').get() as { decks: string }).decks) as Record<
    string,
    Record<string, unknown>
  >;
  db.close();

  assert.deepEqual(decks['1'], DEFAULT_DECK);

  const otherKeys = Object.keys(decks).filter((k) => k !== '1');
  assert.equal(otherKeys.length, 1, 'exactly one non-Default deck for a single-deck export');
  const ourDeck = decks[otherKeys[0]];
  assert.equal(ourDeck.name, DECK_NAME, 'deck name must be the exact :: -joined hierarchical name, not re-encoded');
  assert.equal(ourDeck.dyn, 0, 'a normal (non-filtered) deck');
  assert.equal(ourDeck.conf, 1, 'reuses the one dconf group rather than minting a new one');
  assert.ok(Number.isInteger(ourDeck.id as number) && (ourDeck.id as number) !== 1);
});

// An exam deck: one subdeck per chapter, interleaved the way a deck.json
// built chapter by chapter and then reordered can be.
const CHAPTERS = ['Botany::Test 1::Ch 01 Intro', 'Botany::Test 1::Ch 10 Flowers', 'Botany::Test 1::Ch 19 Classification'];
const CHAPTER_NOTES = [
  makeNote('{{c1::Xylem}} carries water.', { deckName: CHAPTERS[0] }),
  makeNote('{{c1::Petals}} draw in {{c2::pollinators}}.', { deckName: CHAPTERS[1] }),
  makeNote('{{c1::Phloem}} carries sugars.', { deckName: CHAPTERS[0] }),
  makeNote('{{c1::Linnaeus}} named the species.', { deckName: CHAPTERS[2] }),
];

function exportDecks(notes: DeckNote[], deckName?: string) {
  const tempDir = makeTempDir('schema-decks');
  const outPath = join(tempDir, 'out.apkg');
  writeApkg(notes, { deckName, outPath, mediaDir: makeEmptyMediaDir(tempDir), clock: fixedClock });
  const db = openCollection(extractZipMember(outPath, 'collection.anki21', tempDir));
  const decks = Object.values(JSON.parse((db.prepare('SELECT decks FROM col').get() as { decks: string }).decks) as Record<string, { id: number; name: string }>);
  const cards = db.prepare('SELECT n.flds AS flds, c.did AS did FROM cards c JOIN notes n ON n.id = c.nid ORDER BY c.id').all() as unknown as { flds: string; did: number }[];
  db.close();
  const nameOf = new Map(decks.map((d) => [d.id, d.name]));
  return { deckNames: decks.map((d) => d.name).filter((n) => n !== 'Default'), cards: cards.map((c) => [c.flds.split('\x1f')[0], nameOf.get(c.did)]) };
}

test('col.decks: notes naming different decks make one package, a deck each, every card in its own note\'s', () => {
  const { deckNames, cards } = exportDecks(CHAPTER_NOTES);
  assert.deepEqual(deckNames.sort(), [...CHAPTERS].sort(), 'one deck per distinct deckName, nothing else besides Default');
  assert.deepEqual(cards, [
    [CHAPTER_NOTES[0]!.fields.Text, CHAPTERS[0]],
    [CHAPTER_NOTES[1]!.fields.Text, CHAPTERS[1]],
    [CHAPTER_NOTES[1]!.fields.Text, CHAPTERS[1]],
    [CHAPTER_NOTES[2]!.fields.Text, CHAPTERS[0]],
    [CHAPTER_NOTES[3]!.fields.Text, CHAPTERS[2]],
  ]);
});

test('col.decks: a deckName option puts every note into that one deck, whatever the notes name', () => {
  const { deckNames, cards } = exportDecks(CHAPTER_NOTES, 'Botany::Everything');
  assert.deepEqual(deckNames, ['Botany::Everything']);
  assert.ok(cards.every(([, deck]) => deck === 'Botany::Everything'));
});

test('col.decks: a note naming no deck is rejected, named to the note, not exported into a nameless one', () => {
  const nameless = [CHAPTER_NOTES[0]!, { ...CHAPTER_NOTES[1]!, deckName: '' }];
  assert.throws(() => exportDecks(nameless), /^Error: notes\[1\]\.deckName is "" -- every note names the deck it goes into$/);
  assert.throws(() => exportDecks(CHAPTER_NOTES, ' '), /options\.deckName is empty/);
});

test('col.models: exactly one Custom Cloze notetype, matching anki/custom-cloze.json', async () => {
  const { db } = await buildFixtureCollection();
  const models = JSON.parse((db.prepare('SELECT models FROM col').get() as { models: string }).models) as Record<
    string,
    Record<string, unknown>
  >;
  db.close();

  const modelIds = Object.keys(models);
  assert.equal(modelIds.length, 1, 'this pipeline uses exactly one notetype');
  const model = models[modelIds[0]];

  assert.equal(model.name, 'Custom Cloze');
  assert.equal(model.type, 1, 'NotetypeKind::Cloze == 1, not 0 (Standard) -- the field the task flagged to verify precisely');
  assert.equal(model.sortf, 0, 'sort field is field index 0 (Text)');
  assert.equal(model.css, CUSTOM_CLOZE_CSS);

  const flds = model.flds as { name: string; ord: number }[];
  assert.deepEqual(
    flds.map((f) => [f.name, f.ord]),
    [
      ['Text', 0],
      ['Extra', 1],
      ['Source', 2],
    ],
  );

  const tmpls = model.tmpls as { qfmt: string; afmt: string }[];
  assert.equal(tmpls.length, 1);
  assert.equal(tmpls[0].qfmt, CUSTOM_CLOZE_QFMT);
  assert.equal(tmpls[0].afmt, CUSTOM_CLOZE_AFMT);
});

test('col.dconf: the "1"/"Default" option group exists (doc flags this blob as lower-confidence -- light check only)', async () => {
  const { db } = await buildFixtureCollection();
  const dconf = JSON.parse((db.prepare('SELECT dconf FROM col').get() as { dconf: string }).dconf) as Record<
    string,
    Record<string, unknown>
  >;
  db.close();
  assert.equal(dconf['1']?.name, 'Default');
});
