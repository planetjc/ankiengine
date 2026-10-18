// What the agent is told about the steps, and how it answers back.
//
// The writer only ever saw the step it was prompted with. A note sent in
// the chat mid-extract got "I already extracted it" and an offer to run the
// rest of the process its own way, not the method's. So every chat message
// and every stage prompt carries this note: the eight steps as the rail shows
// them, which is running, and what the agent may do about them.
//
// It answers with a line of its own at the end of a reply -- "APE: done
// extract", "APE: run organize" -- which the app checks against the folder
// before acting. A line of text rather than a tool, so it works the same for
// every agent, the embedded OpenRouter loop included. No imports but types,
// so the tests run it as it is.

import type { StageId } from '../../../dist/pipeline/index.js';

export const STAGES: readonly StageId[] = ['extract', 'inventory review', 'organize', 'plan review', 'cards', 'deck preview', 'audit', 'deliver'];

export type StepState = 'done' | 'running' | 'next' | 'not yet';

export interface Step {
  stage: StageId;
  state: StepState;
  /** What finishing it means, said once: the file a writing step leaves, the person's read of a review. */
  about: string;
}

/**
 * The note: where the deck stands, and how to move it. `added` names files
 * the person added after the deck's steps ran: the steps run again on just
 * those, adding to each file rather than starting over.
 */
export function stepsNote(steps: Step[], deck: string, added: string[] = []): string {
  const running = steps.find((s) => s.state === 'running');
  const next = steps.find((s) => s.state === 'next');
  const lines = steps.map((s, i) => `  ${i + 1}. ${s.stage} — ${s.state}${s.state === 'done' || s.state === 'running' ? '' : ` (${s.about})`}`);
  return [
    `[From the AnkiEngine app, not typed by the person.] The person makes this deck${deck ? ` (${deck})` : ''} in eight steps, shown in the app's sidebar. The app starts each step itself and shows the person what a step wrote before the next one begins:`,
    ...lines,
    ...(added.length
      ? [`Files added to this deck after its steps ran: ${added.join(', ')}. The steps run again on those alone, each adding to its file -- inventory.md, plan.md, deck.json -- and leaving what is there as it is; the cards already written may be in Anki.`]
      : []),
    running ? `Running now: ${running.stage}.` : next ? `Nothing is running; next is ${next.stage}.` : 'Nothing is running.',
    'Keep to the step in front of you. Do not start another step\'s work on your own, and do not redo a step that is done unless the person asks.',
    'You can move the sidebar by ending your reply with a line of its own, one per action:',
    '  APE: done <step>  — that step is finished. A writing step counts only if its file is in the course folder; a review step only when the person has said, here, that it is right.',
    '  APE: run <step>   — start the step that is next, when the person wants to go on.',
    'The app checks each line against the folder, does it or says why not, and shows the person what happened.',
  ].join('\n');
}

export interface Directive {
  verb: 'done' | 'run';
  stage: StageId;
}

const LINE = /^[ \t>*_`]*APE:[ \t]*(done|run)[ \t]+(.+?)[ \t*_`.]*$/gim;

/** The directives a reply ends with, in order; a step name the app does not have is left out. */
export function directives(text: string): Directive[] {
  const out: Directive[] = [];
  for (const m of text.matchAll(LINE)) {
    const name = m[2]!.toLowerCase().replace(/\s+/g, ' ').trim();
    const stage = STAGES.find((s) => s === name);
    if (stage) out.push({ verb: m[1]!.toLowerCase() as Directive['verb'], stage });
  }
  return out;
}

/** The reply as the person reads it: the directive lines are the app's to act on and report, not prose. */
export function withoutDirectives(text: string): string {
  return text.replace(LINE, '').replace(/\n{3,}/g, '\n\n').trimEnd();
}
