// What the agent is told about the steps, and the lines it answers with.
// A writer told only its current step answered a note mid-extract with "I
// already extracted it" and set off on the rest its own way.
import assert from 'node:assert/strict';
import test from 'node:test';

import { directives, STAGES, stepsNote, withoutDirectives, type Step } from '../src/agent/steps-note.ts';

const steps = (running: string | null, doneThrough: number): Step[] =>
  STAGES.map((stage, i) => ({ stage, about: `about ${stage}`, state: stage === running ? 'running' : i < doneThrough ? 'done' : i === doneThrough && !running ? 'next' : 'not yet' }));

test('the note lists all eight steps with their state, says what is running, and how to answer', () => {
  const n = stepsNote(steps('extract', 0), 'ISF::Biochem');
  assert.match(n, /not typed by the person/);
  assert.match(n, /\(ISF::Biochem\)/);
  assert.match(n, /1\. extract — running\n/);
  assert.match(n, /2\. inventory review — not yet \(about inventory review\)/);
  assert.match(n, /Running now: extract\./);
  assert.match(n, /APE: done <step>/);
  assert.match(n, /APE: run <step>/);
  const idle = stepsNote(steps(null, 1), '');
  assert.match(idle, /1\. extract — done\n/, 'a done step is not explained again');
  assert.match(idle, /Nothing is running; next is inventory review\./);
});

test('directive lines are found at the end of a reply, in order, whatever markdown dresses them', () => {
  const reply = 'The inventory is already written.\n\nAPE: done extract\n**APE: done inventory review**\n`APE: run organize`.';
  assert.deepEqual(directives(reply), [
    { verb: 'done', stage: 'extract' },
    { verb: 'done', stage: 'inventory review' },
    { verb: 'run', stage: 'organize' },
  ]);
  assert.equal(withoutDirectives(reply), 'The inventory is already written.');
});

test('a step the app does not have, or a mention mid-sentence, moves nothing', () => {
  assert.deepEqual(directives('APE: done everything\nAPE: run the rest'), []);
  assert.deepEqual(directives('I could write "APE: done extract" if you want.'), [], 'only a line of its own');
  assert.deepEqual(directives('ape:  DONE   Inventory  Review'), [{ verb: 'done', stage: 'inventory review' }], 'spacing and case are forgiven');
});

test('files added after the steps ran are named, and the steps said to add to their files', () => {
  const n = stepsNote(steps(null, 0), 'Bio::L1', ['study guide.pdf', 'notes.txt']);
  assert.match(n, /Files added to this deck after its steps ran: study guide\.pdf, notes\.txt\. The steps run again on those alone/);
  assert.doesNotMatch(stepsNote(steps(null, 0), 'Bio::L1'), /Files added/);
});
