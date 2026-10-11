// anki/status and anki/send: the deck goes straight into a running Anki
// through AnkiConnect (src/sidecar/anki.ts), against the fake in
// fake-anki.ts. What is checked is the order and content of the actions --
// note type created only when missing, deck created before notes, every
// referenced image stored under the field's own name from the deck's media
// list, notes added with duplicates refused -- and that Anki being closed is
// reported in words, with the JSON-RPC code the app already handles.
//
// anki/decks, anki/deckStats, anki/existing: Anki read back. What is
// checked is that they only ever read, that a deck's name reaches Anki's
// search meaning that deck and its subdecks whatever it is spelled with,
// and that Anki closed is an answer, not an error.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after } from 'node:test';

import { deckQuery, tidyError } from '../../dist/sidecar/anki.js';
import { READ_ONLY, startFakeAnki, type FakeAnki } from './fake-anki.ts';
import { TIMEOUT, makeTmpDir, spawnSidecar, sweepSidecars } from './helpers.ts';

after(sweepSidecars);

const NOT_OPEN = /Anki is not open, or the AnkiConnect add-on/;

function writeDeck(dir: string): { deckPath: string; page: string } {
  const extracted = join(dir, '_extracted', 'Lecture 9.pdf');
  mkdirSync(extracted, { recursive: true });
  const page = join(extracted, 'p003.jpg');
  writeFileSync(page, readFileSync(join(import.meta.dirname, '..', 'apkg', 'fixtures', 'slide.jpg')));
  const deckPath = join(dir, 'deck.json');
  const note = (text: string) => ({
    deckName: 'ISF::Biochemistry::Gene Expression',
    modelName: 'Custom Cloze',
    fields: { Text: text, Extra: '<img src="isf-biochem-09-slide-03.jpg"><br>Source: "…" &mdash; Slide 3', Source: 'Slide 3' },
    tags: ['isf::biochemistry', 'slide::biochem-09-03'],
  });
  writeFileSync(
    deckPath,
    JSON.stringify({
      deckName: 'ISF::Biochemistry::Gene Expression',
      modelName: 'Custom Cloze',
      media: [{ filename: 'isf-biochem-09-slide-03.jpg', path: '_extracted/Lecture 9.pdf/p003.jpg' }],
      notes: [
        note('{{c1::<b>E. coli</b>::which bacterium?}} has {{c2::<i>one circular chromosome</i>::what chromosome?}}'),
        note('{{c1::<b>Prokaryotic</b>::which?}} <b>gene transcripts</b> {{c2::<i>do not</i>::do or do not?}} contain introns'),
      ],
    }),
  );
  return { deckPath, page };
}

test('anki/status: reachable with the version when the endpoint answers; not, in words, when nothing listens', { timeout: TIMEOUT }, async () => {
  const fake: FakeAnki = await startFakeAnki();
  const s = spawnSidecar({ env: { APE_ANKI_CONNECT: fake.url } });
  await s.ready;
  const up = (await s.request(1, 'anki/status', {})).result as { reachable: boolean; version: number; url: string };
  assert.equal(up.reachable, true);
  assert.equal(up.version, 6);
  assert.equal(up.url, fake.url);
  await fake.close();
  const down = (await s.request(2, 'anki/status', {})).result as { reachable: boolean; error: string };
  assert.equal(down.reachable, false);
  assert.match(down.error, NOT_OPEN);
  assert.equal(await s.end(), 0);
});

test('anki/send: creates the note type only when missing, the deck before the notes, stores every image under the field\'s name, adds the notes', { timeout: TIMEOUT }, async () => {
  const fake = await startFakeAnki();
  const { deckPath, page } = writeDeck(makeTmpDir('ape-sidecar-anki-'));
  const s = spawnSidecar({ env: { APE_ANKI_CONNECT: fake.url } });
  await s.ready;

  const res = await s.request(1, 'anki/send', { path: deckPath });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const r = res.result as { decks: string[]; total: number; added: number; skipped: number; media: number; unresolvedMedia: string[]; createdModel: boolean };
  assert.deepEqual(r, { decks: ['ISF::Biochemistry::Gene Expression'], total: 2, added: 2, skipped: 0, media: 1, unresolvedMedia: [], createdModel: true });

  const actions = fake.calls.map((c) => c.action);
  assert.deepEqual(actions, ['version', 'modelNames', 'createModel', 'createDeck', 'storeMediaFile', 'canAddNotes', 'addNotes'], 'the order AnkiConnect needs: type, deck, media, notes');
  const created = fake.calls.find((c) => c.action === 'createModel')!.params;
  assert.equal(created.modelName, 'Custom Cloze');
  assert.deepEqual(created.inOrderFields, ['Text', 'Extra', 'Source']);
  assert.equal(created.isCloze, true);
  assert.deepEqual(fake.media, [{ filename: 'isf-biochem-09-slide-03.jpg', path: page }], 'the referenced name, the file from the deck\'s list');
  assert.equal(fake.notes.length, 2);
  assert.deepEqual((fake.notes[0].options as Record<string, unknown>), { allowDuplicate: false, duplicateScope: 'deck' });

  // A second send: the type exists now, and both notes are duplicates.
  for (const n of fake.notes) fake.duplicates.add((n.fields as Record<string, string>).Text);
  const again = (await s.request(2, 'anki/send', { path: deckPath })).result as { added: number; skipped: number; createdModel: boolean };
  assert.deepEqual([again.added, again.skipped, again.createdModel], [0, 2, false]);
  const second = fake.calls.slice(7).map((c) => c.action);
  assert.ok(!second.includes('createModel'), 'no second createModel');
  assert.ok(!second.includes('addNotes'), 'nothing new, so nothing added');

  await fake.close();
  assert.equal(await s.end(), 0);
});

test('anki/send: a deck sent again to an AnkiConnect that fails a batch on any duplicate adds the new notes and counts the rest, without an error', { timeout: TIMEOUT }, async () => {
  const fake = await startFakeAnki({ strict: true });
  const { deckPath } = writeDeck(makeTmpDir('ape-sidecar-anki-'));
  const s = spawnSidecar({ env: { APE_ANKI_CONNECT: fake.url } });
  await s.ready;

  assert.equal((await s.request(1, 'anki/send', { path: deckPath })).error, undefined);
  // One already in Anki, one not: the first note stays as a duplicate, the second is gone.
  const [kept] = fake.notes.splice(0);
  fake.duplicates.add((kept!.fields as Record<string, string>).Text);
  const res = await s.request(2, 'anki/send', { path: deckPath });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const r = res.result as { added: number; skipped: number; total: number };
  assert.deepEqual([r.added, r.skipped, r.total], [1, 1, 2]);
  const sent = fake.calls.filter((c) => c.action === 'addNotes').at(-1)!.params.notes as unknown[];
  assert.equal(sent.length, 1, 'only the note Anki can take is sent');

  await fake.close();
  assert.equal(await s.end(), 0);
});

test('tidyError: an AnkiConnect error list is said once per message, with a count', () => {
  const dup = 'cannot create note because it is a duplicate';
  assert.equal(tidyError(`['${dup}', '${dup}', '${dup}', "deck's gone"]`), `${dup} (3 notes); deck's gone`);
  assert.equal(tidyError(`['${dup}']`), dup);
  assert.equal(tidyError('collection is not available'), 'collection is not available');
});

test('anki/send: deckName overrides every note\'s own; Anki closed is -32000 in words; a missing path is -32602', { timeout: TIMEOUT }, async () => {
  const fake = await startFakeAnki();
  const { deckPath } = writeDeck(makeTmpDir('ape-sidecar-anki-'));
  const s = spawnSidecar({ env: { APE_ANKI_CONNECT: fake.url } });
  await s.ready;

  const r = (await s.request(1, 'anki/send', { path: deckPath, deckName: 'Testy test' })).result as { decks: string[] };
  assert.deepEqual(r.decks, ['Testy test']);
  assert.ok(fake.decks.includes('Testy test'));
  assert.ok(fake.notes.every((n) => n.deckName === 'Testy test'));

  const bad = await s.request(2, 'anki/send', {});
  assert.equal(bad.error?.code, -32602);

  await fake.close();
  const closed = await s.request(3, 'anki/send', { path: deckPath });
  assert.equal(closed.error?.code, -32000);
  assert.match(closed.error?.message ?? '', NOT_OPEN);
  assert.equal(await s.end(), 0);
});

/** Every action the fake was asked, each one a read. */
function onlyRead(fake: FakeAnki): void {
  const writes = fake.calls.map((c) => c.action).filter((a) => !READ_ONLY.has(a));
  assert.deepEqual(writes, [], 'a read never writes to the collection');
}

// Each of these, unescaped, would be read by Anki's search as something
// else: wildcards, a closing quote, an escape. Their look-alikes are there to
// be wrongly found.
const AWKWARD = ['Course::Lecture 3', 'Bio: "Week" 1', 'A_B', 'A*B', 'Back\\slash', 'Paren (x) & -y'];
const LOOKALIKES = ['Course::Lecture 30', 'Course::Lecture 3x', 'AxB', 'AyyB', 'Bio: Week 1'];

test('deckQuery: a deck name reaches Anki\'s search escaped, colons as they are', () => {
  assert.equal(deckQuery('Course::Lecture 3'), 'deck:"Course::Lecture 3"');
  assert.equal(deckQuery('Bio: "Week" 1'), 'deck:"Bio: \\"Week\\" 1"');
  assert.equal(deckQuery('A_B*'), 'deck:"A\\_B\\*"');
  assert.equal(deckQuery('Back\\slash'), 'deck:"Back\\\\slash"');
});

test('anki/decks: every deck name, subdecks and their parents; Anki closed is an answer in words, not an error', { timeout: TIMEOUT }, async () => {
  const fake = await startFakeAnki();
  fake.addNote('ISF::Biochemistry::Gene Expression', '{{c1::x}}');
  fake.addNote('Bio: "Week" 1', '{{c1::y}}');
  const s = spawnSidecar({ env: { APE_ANKI_CONNECT: fake.url } });
  await s.ready;

  const res = await s.request(1, 'anki/decks', {});
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.result, { reachable: true, error: null, decks: ['Default', 'ISF', 'ISF::Biochemistry', 'ISF::Biochemistry::Gene Expression', 'Bio: "Week" 1'] });
  onlyRead(fake);

  await fake.close();
  const down = await s.request(2, 'anki/decks', {});
  assert.equal(down.error, undefined, 'closed is not a JSON-RPC error');
  const r = down.result as { reachable: boolean; error: string; decks: string[] };
  assert.deepEqual([r.reachable, r.decks], [false, []]);
  assert.match(r.error, NOT_OPEN);
  assert.equal(await s.end(), 0);
});

test('anki/deckStats: notes and cards new, learning and in review, subdecks counted, look-alike decks not; a missing deck is zeros and is not made', { timeout: TIMEOUT }, async () => {
  const fake = await startFakeAnki();
  fake.addNote('Course::Lecture 3', 'a', ['new', 'review']);
  fake.addNote('Course::Lecture 3', 'b', ['learning', 'relearning']);
  fake.addNote('Course::Lecture 3::Ch 1', 'c', ['review']);
  fake.addNote('Course::Lecture 3::Ch 1', 'd', ['new']);
  for (const deck of [...AWKWARD.slice(1), ...LOOKALIKES]) fake.addNote(deck, `in ${deck}`, ['review', 'new']);
  const s = spawnSidecar({ env: { APE_ANKI_CONNECT: fake.url } });
  await s.ready;

  const res = await s.request(1, 'anki/deckStats', { deck: 'Course::Lecture 3' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  // a: new + review; b: learning + relearning (a lapsed review card); c: review; d: new. Lecture 30 and 3x are not under it.
  assert.deepEqual(res.result, { reachable: true, error: null, deck: 'Course::Lecture 3', exists: true, notes: 4, cards: 6, new: 2, learning: 1, review: 3 });

  // A subdeck alone; and the name in another case is the same deck, as in Anki.
  const sub = (await s.request(2, 'anki/deckStats', { deck: 'course::lecture 3::ch 1' })).result as { deck: string; notes: number; cards: number };
  assert.deepEqual([sub.deck, sub.notes, sub.cards], ['Course::Lecture 3::Ch 1', 2, 2]);

  // Every awkward name finds its own deck and nothing that only looks like it.
  let id = 3;
  for (const deck of AWKWARD.slice(1)) {
    const r = (await s.request(id++, 'anki/deckStats', { deck })).result as { exists: boolean; notes: number; cards: number; new: number; review: number };
    assert.deepEqual([r.exists, r.notes, r.cards, r.new, r.review], [true, 1, 2, 1, 1], deck);
  }

  const before = fake.decks.length;
  const missing = (await s.request(id++, 'anki/deckStats', { deck: 'Course::Lecture 4' })).result;
  assert.deepEqual(missing, { reachable: true, error: null, deck: 'Course::Lecture 4', exists: false, notes: 0, cards: 0, new: 0, learning: 0, review: 0 });
  assert.equal(fake.decks.length, before, 'asking about a deck does not make it');
  onlyRead(fake);

  assert.equal((await s.request(id++, 'anki/deckStats', {})).error?.code, -32602);

  await fake.close();
  const down = await s.request(id++, 'anki/deckStats', { deck: 'Course::Lecture 3' });
  assert.equal(down.error, undefined);
  const r = down.result as { reachable: boolean; error: string; exists: boolean; cards: number };
  assert.deepEqual([r.reachable, r.exists, r.cards], [false, false, 0]);
  assert.match(r.error, NOT_OPEN);
  assert.equal(await s.end(), 0);
});

test('anki/existing: which notes Anki already holds, by the rule a send skips them by, before any is sent; nothing is made to find out', { timeout: TIMEOUT }, async () => {
  const fake = await startFakeAnki();
  const { deckPath } = writeDeck(makeTmpDir('ape-sidecar-anki-'));
  const s = spawnSidecar({ env: { APE_ANKI_CONNECT: fake.url } });
  await s.ready;
  type Existing = { reachable: boolean; error: string | null; decks: string[]; total: number; existing: number; inAnki: boolean[] };

  // Neither the deck nor the note type is in Anki yet: canAddNotes would
  // refuse every note for that, which is not "already there".
  const fresh = (await s.request(1, 'anki/existing', { path: deckPath })).result as Existing;
  assert.deepEqual(fresh, { reachable: true, error: null, decks: ['ISF::Biochemistry::Gene Expression'], total: 2, existing: 0, inAnki: [false, false] });
  assert.ok(!fake.calls.some((c) => c.action === 'canAddNotes'), 'nothing to ask when the deck is not there');
  onlyRead(fake);

  // Sent, then one note taken back out of the deck: one there, one not.
  await s.request(2, 'anki/send', { path: deckPath });
  const firstText = (fake.notes[0]!.fields as Record<string, string>).Text;
  for (const c of fake.cards) if (c.nid === fake.notes[1]!.id) c.deck = 'Elsewhere';
  fake.calls.length = 0;
  const half = (await s.request(3, 'anki/existing', { path: deckPath })).result as Existing;
  assert.deepEqual([half.total, half.existing, half.inAnki], [2, 1, [true, false]]);
  const asked = fake.calls.find((c) => c.action === 'canAddNotes')!.params.notes as Record<string, unknown>[];
  assert.deepEqual(asked[0]!.options, { allowDuplicate: false, duplicateScope: 'deck' }, 'the same rule a send uses');
  assert.equal((asked[0]!.fields as Record<string, string>).Text, firstText);
  onlyRead(fake);

  // deckName puts every note in that deck, as a send's does: none of them is there.
  const other = (await s.request(4, 'anki/existing', { path: deckPath, deckName: 'ISF::Biochemistry' })).result as Existing;
  assert.deepEqual([other.decks, other.existing], [['ISF::Biochemistry'], 0]);

  assert.equal((await s.request(5, 'anki/existing', {})).error?.code, -32602);

  await fake.close();
  const down = await s.request(6, 'anki/existing', { path: deckPath });
  assert.equal(down.error, undefined);
  const r = down.result as Existing;
  assert.deepEqual([r.reachable, r.total, r.existing], [false, 2, 0], 'the deck is still read; Anki is not');
  assert.match(r.error ?? '', NOT_OPEN);
  assert.equal(await s.end(), 0);
});

test('anki/deckNotes: the first field of each note in a deck and its subdecks, oldest first, up to the limit; a look-alike deck\'s are not among them', { timeout: TIMEOUT }, async () => {
  const fake = await startFakeAnki();
  fake.addNote('Course::Lecture 3', '{{c1::<b>Hexokinase</b>}} phosphorylates glucose');
  fake.addNote('Course::Lecture 30', 'not this one');
  fake.addNote('Course::Lecture 3::Ch 1', '{{c1::Pyruvate}} enters the mitochondrion');
  fake.addNote('Course::Lecture 3', '{{c1::NADH}} carries electrons');
  const s = spawnSidecar({ env: { APE_ANKI_CONNECT: fake.url } });
  await s.ready;

  const res = await s.request(1, 'anki/deckNotes', { deck: 'course::lecture 3' });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.result, {
    reachable: true,
    error: null,
    deck: 'Course::Lecture 3',
    exists: true,
    total: 3,
    firstFields: ['{{c1::<b>Hexokinase</b>}} phosphorylates glucose', '{{c1::Pyruvate}} enters the mitochondrion', '{{c1::NADH}} carries electrons'],
  });
  const two = (await s.request(2, 'anki/deckNotes', { deck: 'Course::Lecture 3', limit: 2 })).result as { total: number; firstFields: string[] };
  assert.deepEqual([two.total, two.firstFields.length], [3, 2], 'the count is all of them; the list stops at the limit');

  const missing = (await s.request(3, 'anki/deckNotes', { deck: 'Course::Lecture 4' })).result;
  assert.deepEqual(missing, { reachable: true, error: null, deck: 'Course::Lecture 4', exists: false, total: 0, firstFields: [] });
  onlyRead(fake);

  assert.equal((await s.request(4, 'anki/deckNotes', {})).error?.code, -32602);
  assert.equal((await s.request(5, 'anki/deckNotes', { deck: 'x', limit: -1 })).error?.code, -32602);

  await fake.close();
  const down = (await s.request(6, 'anki/deckNotes', { deck: 'Course::Lecture 3' })).result as { reachable: boolean; error: string; firstFields: string[] };
  assert.deepEqual([down.reachable, down.firstFields], [false, []]);
  assert.match(down.error, NOT_OPEN);
  assert.equal(await s.end(), 0);
});
