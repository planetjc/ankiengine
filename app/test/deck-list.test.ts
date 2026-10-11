// The deck list's arithmetic: Anki's `::` as folders, the orders, the search,
// the file counts. The DOM around it is driven by hand; these are the rules.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { DeckSummary } from '../src/engine/client.ts';
import { arrange, deckStatus, folderTree, foldersOf, material, matches, splitName, when, type FolderNode } from '../src/agent/deck-list.ts';

const deck = (name: string, modified: string, extra: Partial<DeckSummary> = {}): DeckSummary => ({
  name,
  folder: name,
  path: `/decks/${name}`,
  files: 0,
  pdfs: 0,
  artifacts: { inventory: false, plan: false, deck: false, flags: false, review: false },
  modified,
  ...extra,
});

test('a name splits at its last :: into folder and deck', () => {
  assert.deepEqual(splitName('ISF::Biochem::Lecture 9'), { folder: 'ISF::Biochem', leaf: 'Lecture 9' });
  assert.deepEqual(splitName('Test'), { folder: '', leaf: 'Test' });
});

test('every folder is offered, with the folders above it', () => {
  assert.deepEqual(foldersOf([deck('A::B::c', ''), deck('Z', ''), deck('A::d', '')]), ['A', 'A::B']);
});

test('the Folders tree nests, keeps an empty folder, and puts subfolders before decks, A–Z', () => {
  const tree = folderTree([deck('ISF::Test 2::Bio::Nucleic', ''), deck('ISF::Bio::Gene', ''), deck('Loose', ''), deck('ISF::Anatomy', '')], ['Year 1::Pharm']);
  const show = (n: FolderNode): unknown => [n.name, n.total, n.folders.map(show), n.decks.map((d) => splitName(d.name).leaf)];
  assert.deepEqual(show(tree), [
    '', 3 + 1, [
      ['ISF', 3, [['Bio', 1, [], ['Gene']], ['Test 2', 1, [['Bio', 1, [], ['Nucleic']]], []]], ['Anatomy']],
      ['Year 1', 0, [['Pharm', 0, [], []]], []],
    ], ['Loose'],
  ]);
});

test('Recent is one flat list, newest first, whatever the folder', () => {
  const decks = [deck('ISF::Old', '2026-09-01'), deck('Loose', '2026-09-10'), deck('ISF::New', '2026-09-20')];
  assert.deepEqual(arrange(decks, 'recent').map((d) => d.name), ['ISF::New', 'Loose', 'ISF::Old'], 'a month-old deck does not ride above yesterday\'s for sharing its folder');
});

test('a search matches every word, anywhere in the full name', () => {
  const d = deck('ISF::Biochemistry::Regulation of Gene Expression', '');
  assert.equal(matches(d, 'gene reg'), true);
  assert.equal(matches(d, 'isf gene'), true);
  assert.equal(matches(d, 'gene anatomy'), false);
});

test('files are counted by kind, not as "other"', () => {
  assert.equal(material(deck('a', '', { files: 3, pdfs: 1, kinds: { pdf: 1, doc: 2 } })), '1 PDF, 2 documents');
  assert.equal(material(deck('a', '', { files: 2, pdfs: 1 })), '1 PDF, 1 other file', 'an older engine without kinds');
  assert.equal(material(deck('a', '')), 'no files yet');
});

test('when: today, yesterday, days, then a date', () => {
  const now = new Date(2026, 8, 25, 15);
  assert.equal(when(new Date(2026, 8, 25, 1).toISOString(), now), 'today');
  assert.equal(when(new Date(2026, 8, 24, 23).toISOString(), now), 'yesterday');
  assert.equal(when(new Date(2026, 8, 21).toISOString(), now), '4 days ago');
  assert.match(when(new Date(2026, 7, 1).toISOString(), now), /Aug/);
});

test('a deck with files added after its steps ran says so, until the cards have them', () => {
  const made = { inventory: true, plan: true, deck: true, flags: false, review: false };
  assert.equal(deckStatus(deck('A', '2026-09-27T00:00:00Z', { files: 3, artifacts: made, added: 2 })), '2 files added — not in the cards yet');
  assert.equal(deckStatus(deck('A', '2026-09-27T00:00:00Z', { files: 2, artifacts: made, added: 1 })), '1 file added — not in the cards yet');
  assert.equal(deckStatus(deck('A', '2026-09-27T00:00:00Z', { files: 2, artifacts: made, added: 0 })), 'cards written — preview, audit, export');
  assert.equal(deckStatus(deck('B', '2026-09-27T00:00:00Z', { files: 2, added: 2 })), 'materials added — next: extract', 'nothing made yet: every file is simply material');
});
