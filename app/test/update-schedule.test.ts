// When the app looks for an update. v0.2.1 looked once at launch and said
// nothing when that look failed; an owner's copy sat on 0.2.1 with 0.3.1 out.
import assert from 'node:assert/strict';
import test from 'node:test';

import { EVERY, ON_FRONT_AFTER, PUT_OFF_FOR, RETRY_AFTER, lookLine, updateSchedule } from '../src/update-schedule.ts';

type Answer = { version: string } | null | Error;

function rig(answers: Answer[]) {
  let clock = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const offered: string[] = [];
  let looks = 0;
  const schedule = updateSchedule({
    look: async () => {
      looks++;
      const a = answers.length > 1 ? answers.shift()! : answers[0]!;
      if (a instanceof Error) throw a;
      return a;
    },
    offer: (v) => offered.push(v),
    now: () => clock,
    later: (ms, fn) => timers.push({ at: clock + ms, fn }),
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    schedule,
    offered,
    looks: () => looks,
    timers,
    async advance(ms: number) {
      clock += ms;
      for (const t of timers.filter((t) => t.at <= clock)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
      await settle();
    },
    settle,
  };
}

test('a failed look at launch is tried again in a minute, then in five, then left to the timer', async () => {
  const r = rig([new Error('offline'), new Error('offline'), new Error('offline')]);
  await r.schedule.launched();
  assert.equal(r.looks(), 1);
  assert.deepEqual(r.timers.map((t) => t.at), [RETRY_AFTER[0]]);
  await r.advance(RETRY_AFTER[0]!);
  assert.equal(r.looks(), 2);
  await r.advance(RETRY_AFTER[1]!);
  assert.equal(r.looks(), 3);
  assert.equal(r.timers.length, 0, 'no more retries after the second');
  assert.deepEqual(r.offered, []);
  assert.equal(r.schedule.last()?.outcome.kind, 'failed');
});

test('a retry that gets through offers the update', async () => {
  const r = rig([new Error('offline'), { version: '0.3.1' }]);
  await r.schedule.launched();
  await r.advance(RETRY_AFTER[0]!);
  assert.deepEqual(r.offered, ['0.3.1']);
});

test('while the bar is up nothing looks again; the window coming to the front looks once the last look is half an hour old', async () => {
  const r = rig([null]);
  await r.schedule.launched();
  assert.equal(r.looks(), 1);
  await r.advance(ON_FRONT_AFTER - 1);
  await r.schedule.toFront();
  assert.equal(r.looks(), 1, 'too soon');
  await r.advance(1);
  await r.schedule.toFront();
  assert.equal(r.looks(), 2);

  const up = rig([{ version: '0.3.1' }]);
  await up.schedule.launched();
  await up.advance(EVERY);
  await up.schedule.periodic();
  await up.schedule.toFront();
  assert.equal(up.looks(), 1, 'the bar is up: no second look');
  assert.deepEqual(up.offered, ['0.3.1']);
});

test('Later puts a version off for a day; asking offers it anyway; a newer one is offered at once', async () => {
  const r = rig([{ version: '0.3.1' }, { version: '0.3.1' }, { version: '0.3.1' }, { version: '0.3.2' }]);
  await r.schedule.launched();
  r.schedule.putOff('0.3.1');
  await r.advance(EVERY);
  await r.schedule.periodic();
  assert.deepEqual(r.offered, ['0.3.1'], 'put off: not offered again by the timer');

  const asked = await r.schedule.checkNow();
  assert.deepEqual(asked, { kind: 'available', version: '0.3.1' });
  assert.deepEqual(r.offered, ['0.3.1', '0.3.1'], 'asked for: offered even though put off');

  r.schedule.putOff('0.3.1');
  await r.advance(EVERY);
  await r.schedule.periodic();
  assert.deepEqual(r.offered, ['0.3.1', '0.3.1', '0.3.2']);
});

test('a put-off version comes back after a day', async () => {
  const r = rig([{ version: '0.3.1' }]);
  await r.schedule.launched();
  r.schedule.putOff('0.3.1');
  await r.advance(PUT_OFF_FOR);
  await r.schedule.periodic();
  assert.deepEqual(r.offered, ['0.3.1', '0.3.1']);
});

test('two askers at once share one look', async () => {
  const r = rig([{ version: '0.3.1' }]);
  const [a, b] = await Promise.all([r.schedule.checkNow(), r.schedule.checkNow()]);
  assert.equal(r.looks(), 1);
  assert.deepEqual(a, b);
});

test('Settings says what the last look found', () => {
  const t = () => '4:52 PM';
  assert.equal(lookLine(null, t), 'Not checked yet.');
  assert.equal(lookLine({ at: 0, outcome: { kind: 'latest' } }, t), 'Checked 4:52 PM: this is the latest version.');
  assert.equal(
    lookLine({ at: 0, outcome: { kind: 'available', version: '0.3.2' } }, t),
    'Checked 4:52 PM: version 0.3.2 is available. The bar at the top of the window installs it.',
  );
  assert.equal(
    lookLine({ at: 0, outcome: { kind: 'failed', message: 'error sending request' } }, t),
    'Checked 4:52 PM: could not reach the update feed (error sending request).',
  );
});
