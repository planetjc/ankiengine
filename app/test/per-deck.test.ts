// What the steps remember without a file belongs to the deck it happened in:
// an export of one deck once showed the next deck opened as delivered.
import assert from 'node:assert/strict';
import test from 'node:test';

import { perDeck } from '../src/agent/per-deck.ts';

type Session = { exportedTo: string | null; reviewed: string[] };
const fresh = (): Session => ({ exportedTo: null, reviewed: [] });

test('a deck not opened before starts with nothing; one opened before is as it was left', () => {
  const decks = perDeck(fresh);
  assert.equal(decks.at(), null);
  let now = decks.swap('/decks/a', fresh());
  assert.deepEqual(now, fresh());
  now = { exportedTo: '/decks/a/A.apkg', reviewed: ['inventory review'] };

  now = decks.swap('/decks/b', now);
  assert.deepEqual(now, fresh(), "b does not get a's export");
  assert.equal(decks.at(), '/decks/b');
  now = { exportedTo: null, reviewed: ['plan review'] };

  now = decks.swap('/decks/a', now);
  assert.deepEqual(now, { exportedTo: '/decks/a/A.apkg', reviewed: ['inventory review'] }, 'back to a, as it was');
  assert.deepEqual(decks.swap('/decks/b', now), { exportedTo: null, reviewed: ['plan review'] });
});

test('with no deck open the value is new, and the deck closed keeps its own', () => {
  const decks = perDeck(fresh);
  decks.swap('/decks/a', fresh());
  const none = decks.swap(null, { exportedTo: 'A.apkg', reviewed: [] });
  assert.deepEqual(none, fresh());
  assert.equal(decks.at(), null);
  assert.deepEqual(decks.swap('/decks/a', none), { exportedTo: 'A.apkg', reviewed: [] });
});

test('the same deck again changes nothing', () => {
  const decks = perDeck(fresh);
  decks.swap('/decks/a', fresh());
  const now = { exportedTo: 'A.apkg', reviewed: [] };
  assert.equal(decks.swap('/decks/a', now), now);
});
