// What Anki already has, as the rail and the deliver step say it.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { AnkiDeckStats, AnkiExisting } from '../src/engine/client.ts';
import { deckSuggestions, inAnkiLine } from '../src/agent/in-anki.ts';

const existing = (total: number, there: number, reachable = true): AnkiExisting => ({
  reachable,
  error: reachable ? null : 'Anki is not open',
  decks: ['Course::Lecture 3'],
  total,
  existing: there,
  inAnki: Array.from({ length: total }, (_, i) => i < there),
});
const stats = (cards: number, fresh: number, exists = true): AnkiDeckStats => ({
  reachable: true,
  error: null,
  deck: 'Course::Lecture 3',
  exists,
  notes: cards,
  cards,
  new: fresh,
  learning: 0,
  review: cards - fresh,
});

test('deck names are offered by name, numbers in order, each once', () => {
  assert.deepEqual(deckSuggestions(['Course::Lecture 10', 'Default', 'Course::Lecture 2', 'course', 'Course::Lecture 2']), ['course', 'Course::Lecture 2', 'Course::Lecture 10', 'Default']);
});

test('how many of the notes Anki already holds, and what a send adds', () => {
  assert.equal(inAnkiLine(existing(42, 0), null), 'None of the 42 notes are in Anki yet.');
  assert.equal(inAnkiLine(existing(42, 18), null), '18 of the 42 notes are already in Anki; a send adds the other 24.');
  assert.equal(inAnkiLine(existing(42, 1), null), '1 of the 42 notes is already in Anki; a send adds the other 41.');
  assert.equal(inAnkiLine(existing(42, 42), null), 'All 42 notes are already in Anki; a send adds nothing.');
  assert.equal(inAnkiLine(existing(1, 1), null), 'The note is already in Anki; a send adds nothing.');
  assert.equal(inAnkiLine(existing(1, 0), null), 'The note is not in Anki yet.');
});

test('how much of a deck Anki has is studied, only for a deck it has', () => {
  assert.equal(inAnkiLine(existing(42, 42), stats(150, 30)), 'All 42 notes are already in Anki; a send adds nothing. Course::Lecture 3 has 150 cards in Anki, 120 of them studied.');
  assert.equal(inAnkiLine(null, stats(150, 150)), 'Course::Lecture 3 has 150 cards in Anki, none studied yet.');
  assert.equal(inAnkiLine(null, stats(150, 0)), 'Course::Lecture 3 has 150 cards in Anki, all studied.');
  assert.equal(inAnkiLine(null, stats(1, 1)), 'Course::Lecture 3 has one card in Anki, not studied yet.');
  assert.equal(inAnkiLine(existing(42, 0), stats(0, 0, false)), 'None of the 42 notes are in Anki yet.');
  assert.equal(inAnkiLine(existing(42, 0), stats(0, 0)), 'None of the 42 notes are in Anki yet.', 'an empty deck says nothing of studying');
});

test('Anki closed, or an engine without the reads, says nothing: the bar keeps its own words', () => {
  assert.equal(inAnkiLine(existing(42, 0, false), { ...stats(0, 0, false), reachable: false }), '');
  assert.equal(inAnkiLine(null, null), '');
  assert.equal(inAnkiLine(existing(0, 0), null), '');
});

test('no line says "your"', () => {
  const said = [inAnkiLine(existing(42, 18), stats(150, 30)), inAnkiLine(existing(1, 0), stats(1, 1))].join(' ');
  assert.doesNotMatch(said, /\byour\b/i);
});
