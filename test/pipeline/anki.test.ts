// src/pipeline/anki.ts: what the steps that plan and write cards are told
// about the deck already in Anki. The shell's reader comes in through
// StageOptions; organize and cards are told, nothing else is, and a step
// reads as it always did when Anki cannot say.
import assert from 'node:assert/strict';
import test from 'node:test';

import { ankiParagraph, type AnkiHeldLike } from '../../dist/pipeline/anki.js';
import { CLASS_STAGE, stageBlocks, WRITING_STAGES, type ContentBlock, type PipelineClient } from '../../dist/pipeline/index.js';

const client: PipelineClient = {
  readMethod: async (name) => ({ text: `<${name}>` }),
  listCourse: async () => ({ files: [{ relPath: 'L.pdf', kind: 'pdf', bytes: 4096, mimeType: 'application/pdf' }] }),
  readCourse: async () => ({ text: '' }),
  newSession: async () => ({ session: { sessionId: 'x' } }),
  prompt: async () => ({ stopReason: 'end_turn' }),
  isRpcError: () => false,
};
const textOf = (b: ContentBlock[]) => (b[1] as { text: string }).text;
const stage = (id: string) => WRITING_STAGES.find((s) => s.id === id)!;

const HELD: AnkiHeldLike = {
  reachable: true,
  deck: 'Course::Lecture 3',
  exists: true,
  notes: 3,
  cards: 5,
  new: 2,
  firstFields: ['{{c1::<b>Hexokinase</b>}} phosphorylates&nbsp;glucose', 'A &lt;b&gt; tag &amp; a<br>break'],
};

test('organize is told how much of the deck Anki holds and is studied, each first field as text, and to leave out of plan.md what they already ask', async () => {
  const asked: string[] = [];
  const text = textOf(await stageBlocks(client, stage('organize'), '/c', 'Course::Lecture 3', { anki: async (deck) => (asked.push(deck), HELD) }));
  assert.deepEqual(asked, ['Course::Lecture 3']);
  assert.match(
    text,
    /\n\nAlready in Anki, read from it just now: the deck Course::Lecture 3 holds 3 notes \(5 cards: 3 studied, 2 new\)\. The first field of each:\n- \{\{c1::Hexokinase\}\} phosphorylates glucose\n- A <b> tag & a break\n- …and 1 more, not listed\n/,
  );
  assert.match(text, /not lecture material\. Plan no card that asks what one of these already asks; .* say in plan\.md which were left out/);
  assert.ok(text.endsWith('for that reason.'), 'last in the step\'s text, after everything else it is told');
});

test('cards is told the same, and to leave them out of deck.json even where plan.md lists one', async () => {
  const text = textOf(await stageBlocks(client, stage('cards'), '/c', 'Course::Lecture 3', { anki: async () => HELD }));
  assert.match(text, /Already in Anki, read from it just now: the deck Course::Lecture 3 holds 3 notes/);
  assert.match(text, /Write no card that asks what one of these already asks, even where plan\.md lists it/);
});

test('extract and the class brief are not told, and do not ask', async () => {
  let asked = 0;
  const anki = async () => (asked++, HELD);
  for (const s of [stage('extract'), CLASS_STAGE]) assert.doesNotMatch(textOf(await stageBlocks(client, s, '/c', 'Course::Lecture 3', { anki })), /Already in Anki/, s.id);
  assert.equal(asked, 0);
});

test('a step reads as before when Anki is closed, has no such deck, has it empty, the read fails, or no deck name is given', async () => {
  const plain = textOf(await stageBlocks(client, stage('organize'), '/c', 'Course::Lecture 3'));
  for (const anki of [
    async () => ({ ...HELD, reachable: false, exists: false, notes: 0, cards: 0, new: 0, firstFields: [] }),
    async () => ({ ...HELD, exists: false, notes: 0, cards: 0, new: 0, firstFields: [] }),
    async () => ({ ...HELD, notes: 0, cards: 0, new: 0, firstFields: [] }),
    async (): Promise<AnkiHeldLike> => {
      throw new Error('method not found: anki/deckNotes');
    },
  ])
    assert.equal(textOf(await stageBlocks(client, stage('organize'), '/c', 'Course::Lecture 3', { anki })), plain);
  let asked = false;
  await stageBlocks(client, stage('organize'), '/c', '', { anki: async () => ((asked = true), HELD) });
  assert.equal(asked, false, 'no deck name, no deck to ask about');
});

test('a step waits on Anki five seconds at most: a dialog open in Anki holds its answer, and the step runs without it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = stageBlocks(client, stage('organize'), '/c', 'Course::Lecture 3', { anki: () => new Promise<AnkiHeldLike>(() => {}) });
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(4999);
  let settled = false;
  void pending.then(() => (settled = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'still waiting at 4.999s');
  t.mock.timers.tick(1);
  assert.doesNotMatch(textOf(await pending), /Already in Anki/);
});

test('ankiParagraph: one note and one card are said so; a long field is cut short', () => {
  const one = ankiParagraph(stage('organize'), { ...HELD, notes: 1, cards: 1, new: 1, firstFields: ['x'.repeat(300)] });
  assert.match(one, /holds one note \(one card, not studied yet\)\./);
  const line = one.split('\n')[1]!;
  assert.equal(line.length, 2 + 200);
  assert.ok(line.endsWith('…'));
  assert.equal(ankiParagraph(stage('organize'), null), '');
});
