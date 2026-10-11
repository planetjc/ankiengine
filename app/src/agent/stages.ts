// The steps: the rail on the left says where a run is, the bar at the top
// of the main pane says what is next and runs it with one button. Writing
// stages run the method through the agent and show the artifact behind a
// gate; the review stages are that gate ("Looks right → organize"); the
// preview is the deck view; the audit runs the whole-deck auditor in a
// fresh session, merges its findings with the owner's flags, hands them to
// an adjudicator, and the writer applies the verdicts verbatim; deliver
// exports. Nothing here decides what a card says; the method text and the
// agent do.
//
// What is done is read from the course folder (course/list's artifacts, the
// flags, verdicts.md), so a run picks up where it was left; what was merely
// looked at this session (a review, the preview) is remembered here.
//
// Files added to a deck after its steps ran are new to them (course/list's
// coverage): each step runs again on just those, adding to its file rather
// than starting over (additionStage), the audit reads only the new cards,
// and Send to Anki adds them beside the ones already there.

import {
  WRITING_STAGES,
  additionStage,
  makeRunner,
  type AuditFinding,
  type AuditScope,
  type Runner,
  type StageId,
} from '../../../dist/pipeline/index.js';
import { EngineError, type ConnectResult, type Coverage, type Flag, type SidecarClient, type SendToAnkiResult } from '../engine/client.js';
import type { Bus } from './bus.js';
import { mergeFlags } from './flags.js';
import { ankiReader, inAnkiLine } from './in-anki.js';
import { perDeck } from './per-deck.js';
import { STAGES, stepsNote, type Directive, type StepState } from './steps-note.js';
import { readNewPerDay } from './study.js';

/** Silence long enough to mention, and long enough to worry about. */
const QUIET_MS = 60_000;
const STALLED_MS = 240_000;

export { STAGES };

/** One line per step: what it does, shown in the bar before it runs. */
const ABOUT: Record<StageId, string> = {
  extract: 'The agent reads the material and writes inventory.md: every fact, with where it came from.',
  'inventory review': 'Read the inventory. Anything missing or wrong, tell the agent below; continue when it is right.',
  organize: 'The agent turns the inventory into plan.md: which cards, in what order.',
  'plan review': 'Read the plan; continue when it looks right.',
  cards: 'The agent writes deck.json. The structural checks run on it here.',
  'deck preview': 'Every card, rendered. Flag any that are wrong.',
  audit: 'A fresh session that wrote none of the cards reads the whole deck. Its findings and your flags go to an adjudicator; the writer applies the verdicts as written.',
  deliver: 'Export the .apkg beside your material. Double-click it to import into Anki.',
};

export interface StageHost {
  sidecar: SidecarClient;
  /** The shared notification stream, for knowing the agent is still alive. */
  bus: Bus;
  courseDir(): string | null;
  deckName(): string;
  say(text: string, isError?: boolean): void;
  /** Puts the agent pane (gate + chat) in the main pane. */
  showAgentView(): void;
  /** Loads `<courseDir>/deck.json` into the deck view and shows it. */
  openDeck(courseDir: string): Promise<void>;
  /** Exports the deck; the path written, or null when the shell saved it some other way (a download) or failed. */
  exportDeck(): Promise<string | null>;
  /** Puts the deck into the running Anki; null when it failed (Anki closed, most often). */
  sendToAnki(): Promise<SendToAnkiResult | null>;
  /** Extracts text and page images beside every PDF that has none yet; runs before the extract stage. */
  prepareMaterials(courseDir: string): Promise<void>;
  openSettings(): void;
  /** Whether the deck has any material to read; extract has nothing to do without it. */
  hasMaterials(): boolean;
  /** Opens the shell's way of adding files (a picker). */
  addFiles(): void;
  /** What the deck's files are in changed -- a step was written from files added later, or put back: the tiles' marks follow. */
  coverageChanged?(): void;
}

/** What each stage that can be discarded writes beside the material, besides whatever else the agent leaves. */
const OUTPUT: Partial<Record<StageId, string[]>> = {
  extract: ['inventory.md'],
  organize: ['plan.md'],
  cards: ['deck.json'],
  audit: ['audit.md', 'audit.json'],
};
/** What finishing each step means, in the note the agent is sent. */
const FINISH: Record<StageId, string> = {
  extract: 'writes inventory.md',
  'inventory review': 'the person reads inventory.md and says it is right',
  organize: 'writes plan.md',
  'plan review': 'the person reads plan.md and says it is right',
  cards: 'writes deck.json',
  'deck preview': 'the person looks through every card',
  audit: 'a fresh session reviews the whole deck; the person rules on its findings',
  deliver: 'the person exports the deck or sends it to Anki',
};
/** The file a writing step leaves, which is what "done" is checked against. */
const FILE: Partial<Record<StageId, string>> = { extract: 'inventory.md', organize: 'plan.md', cards: 'deck.json', audit: 'audit.md' };

/** The stage behind an artifact a gate shows. */
const WRITER: Record<string, StageId> = { 'inventory.md': 'extract', 'plan.md': 'organize', 'deck.json': 'cards' };

/** A step's file, as the record of what each was written from names it. */
type MadeFile = 'inventory.md' | 'plan.md' | 'deck.json' | 'audit.md';
/** Each step that writes a file, and which part of the coverage is its. */
const COVERS: Partial<Record<StageId, { file: MadeFile; key: 'inventory' | 'plan' | 'deck' | 'audit' }>> = {
  extract: { file: 'inventory.md', key: 'inventory' },
  organize: { file: 'plan.md', key: 'plan' },
  cards: { file: 'deck.json', key: 'deck' },
  audit: { file: 'audit.md', key: 'audit' },
};

/**
 * What a step's file was before material was added to it, kept beside the
 * deck so that Discard puts it back -- the cards in it may be in Anki -- rather
 * than trashing the whole file. A dotfile: never material, never listed.
 */
const BEFORE = '.ape-before.json';
type Before = Partial<Record<MadeFile, { text: string; from: string[]; unaudited: number | null }>>;

/** "a.pdf", "a.pdf and b.txt", "3 files". */
function names(files: string[]): string {
  return files.length === 1 ? files[0]! : files.length === 2 ? `${files[0]} and ${files[1]}` : `${files.length} files`;
}

/** How many notes a deck.json holds, however it is shaped (a list, {notes}, {params: {notes}}). */
export function noteCount(text: string): number {
  try {
    const d = JSON.parse(text) as unknown;
    const o = (typeof d === 'object' && d !== null && 'params' in d ? (d as { params: unknown }).params : d) as { notes?: unknown } | unknown[];
    return Array.isArray(o) ? o.length : Array.isArray((o as { notes?: unknown })?.notes) ? ((o as { notes: unknown[] }).notes.length) : 0;
  } catch {
    return 0;
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function next(stage: StageId): StageId | null {
  const i = STAGES.indexOf(stage);
  return i >= 0 && i + 1 < STAGES.length ? STAGES[i + 1]! : null;
}

export interface Stages {
  /** Called when an agent is connected or gone; before that only the two deck stages work. */
  setConnection(conn: ConnectResult | null): void;
  run(stage: StageId): Promise<void>;
  /** Re-reads the folder and redraws the rail and the bar. */
  refresh(): Promise<void>;
  /** What is running, or null; a deck is not switched out from under a run. */
  busy(): string | null;
  /** The note on where the deck stands, for the agent (steps-note.ts). */
  note(): string;
  /** Acts on one line the agent ended a reply with, after checking it; says what happened, for the chat. */
  act(d: Directive): Promise<string>;
  /** Anki opened or closed: the deliver step reads what it has again. */
  ankiChanged(): void;
}

interface Action {
  stage: StageId;
  button: string;
  hint: string;
  go: () => Promise<void>;
  secondary?: { label: string; go: () => Promise<void> };
}

export function mountStages(rail: HTMLOListElement, bar: HTMLElement, gate: HTMLElement, host: StageHost): Stages {
  const { sidecar } = host;
  let runner: Runner | null = null;
  let writerSession: string | null = null;
  /** What is running, or null. Named rather than a flag so the rail can mark it and the refusal can say which. */
  let busy: string | null = null;
  /** When the running stage started, and when the agent last said anything. */
  let startedAt = 0;
  let lastHeard = 0;
  let ticker: number | null = null;
  // Any traffic at all counts as a sign of life, including a tool call or a
  // single token. Only agent/update -- the engine's forward of the agent's own
  // session/update stream -- so it cannot be kept alive by the shell's own
  // polling. Any session counts: the audit and the adjudicator run in their own.
  host.bus.onNotification((method) => {
    if (busy && method === 'agent/update') lastHeard = Date.now();
  });
  /** Stages the user asked to run again despite an artifact already existing. */
  const force = new Set<StageId>();
  // What the folder says, as of the last refresh.
  let has = { inventory: false, plan: false, deck: false, audit: false, verdicts: false, flags: 0 };
  // What happened this session and leaves no file: reviews looked at, the preview opened, the export written.
  const reviewed = new Set<StageId>();
  let previewed = false;
  let exportedTo: string | null = null;
  let sentToAnki: string | null = null; // what landed in Anki, once it has
  /** What each step's file was written from, as the last listing said; null for a class, or before a deck is read. */
  let cov: Coverage | null = null;
  /** The cards the last addition wrote, by where they start: what the preview, the audit and the send are about. */
  let lastAdded: { from: number; count: number } | null = null;
  /** The artifact the gate is showing, if any. */
  let showing: string | null = null;
  /** A run-through is in progress: each stage starts the next until the audit. */
  let through = false;
  /** Stop was pressed during the current run. A stage's file can already exist when it is cancelled, so this, not the file, ends a run-through. */
  let stopRequested = false;
  /** The last stage did not finish its turn: stopped, cut short, or failed. */
  let halted = false;
  /** Cancel was pressed: the run stops, then what it wrote is offered for the trash. */
  let discardAfter = false;
  /** The folder's files as the last run found them, so what the run added -- a converted/ folder, notes -- can be told apart. */
  let lastRun: { dir: string; stage: StageId; before: Set<string> } | null = null;
  /** The stage whose artifact the gate shows, so Re-read can redraw it whole. */
  let gateStage: StageId | null = null;
  /** What the discard gate on screen listed, moved to the trash on a yes -- and the step's file put back as it was, when the run added to it. */
  let pendingDiscard: { dir: string; stage: StageId; names: string[]; restore: MadeFile | null } | null = null;

  // Each step is a button, and says so: the first person through this screen
  // read the list as a progress display and asked how to start the process.
  rail.innerHTML = STAGES.map(
    (s) => `<li data-stage="${s}" role="button" tabindex="0" title="${esc(ABOUT[s])}"><span class="sname">${esc(s)}</span><span class="sstate"></span></li>`,
  ).join('');

  function setStage(name: StageId | null): void {
    rail.querySelectorAll<HTMLLIElement>('li').forEach((li) => li.classList.toggle('on', li.dataset.stage === name));
  }

  /**
   * A stage takes minutes -- the PDFs are read, then an agent writes -- and
   * the status line is one line that anything else can overwrite. So the step
   * itself carries the state, where it cannot be clobbered.
   */
  function setBusy(label: string | null): void {
    busy = label;
    if (label !== null) stopRequested = discardAfter = false;
    rail.querySelectorAll<HTMLLIElement>('li').forEach((li) => li.classList.toggle('running', li.dataset.stage === label));
    rail.setAttribute('aria-busy', label === null ? 'false' : 'true');
    startedAt = label === null ? 0 : Date.now();
    lastHeard = startedAt;
    renderBar();
    if (ticker !== null) clearInterval(ticker);
    ticker = label === null ? null : (setInterval(tick, 1000) as unknown as number);
  }

  /**
   * A stage is minutes of someone else's work and the window has nothing to
   * say about it, which is indistinguishable from a hang. There is no total to
   * count towards -- the agent decides how much reading a lecture takes -- so
   * the bar reports the two things that are actually known: how long this has
   * been going, and how long since the agent last said anything. The second is
   * the one that answers "is this stuck?".
   */
  function human(ms: number): string {
    const s = Math.floor(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  }

  function tick(): void {
    if (!busy) return;
    const now = Date.now();
    const elapsed = bar.querySelector<HTMLElement>('.nb-elapsed');
    const idle = bar.querySelector<HTMLElement>('.nb-idle');
    if (elapsed) elapsed.textContent = human(now - startedAt);
    if (!idle) return;
    const quiet = now - lastHeard;
    // Under a minute of silence is ordinary: the agent is reading, or thinking.
    idle.textContent = quiet < QUIET_MS ? '' : `nothing heard for ${human(quiet)}`;
    idle.classList.toggle('stalled', quiet >= STALLED_MS);
    // The count changes every second, so it is not what a screen reader hears:
    // only crossing into quiet, and into stalled, is announced.
    const said = bar.querySelector<HTMLElement>('.nb-said');
    const state = quiet >= STALLED_MS ? 'The agent may be stalled: nothing heard for four minutes.' : quiet >= QUIET_MS ? 'Nothing heard from the agent for a minute.' : '';
    if (said && said.textContent !== state) said.textContent = state;
  }

  /** Whether a step's file is in the folder. */
  function exists(stage: StageId): boolean {
    return stage === 'extract' ? has.inventory : stage === 'organize' ? has.plan : stage === 'cards' ? has.deck : stage === 'audit' ? has.audit : false;
  }

  /** Files added since a step's file was written, which it has not been given; empty when it has no file yet. */
  function addedTo(stage: StageId): string[] {
    const c = COVERS[stage];
    return (c && cov?.[c.key]?.added) || [];
  }

  /**
   * Which steps are behind the material: a step is, when files were added
   * since its file was written, or since any step before it was -- what it
   * adds has to come down through every step after it.
   */
  function behind(): { extract: boolean; organize: boolean; cards: boolean; audit: boolean } {
    const extract = addedTo('extract').length > 0;
    const organize = extract || addedTo('organize').length > 0;
    const cards = organize || addedTo('cards').length > 0;
    return { extract, organize, cards, audit: cards || addedTo('audit').length > 0 };
  }

  /** What a step is given, as the record of what its file is written from: the materials, then each file's own cover in turn. */
  function givenTo(stage: StageId): string[] {
    const m = cov?.materials ?? [];
    const inv = cov?.inventory?.covers ?? m;
    const plan = cov?.plan?.covers ?? inv;
    return stage === 'extract' ? m : stage === 'organize' ? inv : stage === 'cards' ? plan : (cov?.deck?.covers ?? plan);
  }

  // A later artifact implies the earlier steps: a folder with only deck.json
  // in it resumes at the preview, not at extract. A step behind the material
  // is not done, nor is anything after it, until what was added comes through.
  function done(stage: StageId): boolean {
    const b = behind();
    switch (stage) {
      case 'extract':
        return (has.inventory || has.plan || has.deck) && !b.extract;
      case 'inventory review':
        return !b.extract && (reviewed.has(stage) || ((has.plan || has.deck) && !b.organize));
      case 'organize':
        return (has.plan || has.deck) && !b.organize;
      case 'plan review':
        return !b.organize && (reviewed.has(stage) || (has.deck && !b.cards));
      case 'cards':
        return has.deck && !b.cards;
      case 'deck preview':
        return has.deck && !b.cards && (previewed || (has.audit && !b.audit));
      case 'audit':
        return has.audit && !b.audit && !(has.flags > 0);
      case 'deliver':
        return exportedTo !== null;
    }
  }

  /** What the bar offers: the first step not done, with the audit's sub-steps spelled out. */
  function action(): Action {
    const writing = (stage: StageId): Action => {
      const added = exists(stage) ? addedTo(stage) : [];
      if (!added.length) return { stage, button: `Run ${stage}`, hint: ABOUT[stage], go: () => run(stage) };
      const them = added.length === 1 ? 'it' : 'them';
      const hint =
        stage === 'extract'
          ? `${names(added)} ${added.length === 1 ? 'was' : 'were'} added after the deck was made. The agent adds what ${added.length === 1 ? 'it teaches' : 'they teach'} to inventory.md; what is there stays as it is.`
          : stage === 'organize'
            ? `The agent plans cards for what ${names(added)} added to the inventory, at the end of plan.md. The cards already planned stay as they are.`
            : `The agent writes the new cards from the plan and adds ${them} to the end of deck.json. The cards already written stay word for word, so the ones in Anki are not doubled.`;
      return { stage, button: `Run ${stage} on ${added.length === 1 ? 'the new file' : `${added.length} new files`}`, hint, go: () => run(stage) };
    };
    // A review is read before it is approved: the first press opens the
    // artifact in the gate, the second is the approval and runs what follows.
    const review = (stage: StageId): Action => {
      const after = next(stage)!;
      const artifact = stage === 'inventory review' ? 'inventory.md' : 'plan.md';
      if (showing !== artifact) return { stage, button: `Read ${artifact}`, hint: ABOUT[stage], go: () => run(stage) };
      return {
        stage,
        button: `Looks right → ${after}`,
        hint: ABOUT[stage],
        go: async () => {
          reviewed.add(stage);
          await run(after);
        },
      };
    };
    const b = behind();
    if (!has.deck || b.cards) {
      if (!has.plan || b.organize) {
        if (!has.inventory && !host.hasMaterials()) return { stage: 'extract', button: 'Add files…', hint: 'Add the lecture\'s files first: slides as PDF, the transcript, the objectives.', go: async () => host.addFiles() };
        if (!has.inventory || b.extract) return writing('extract');
        if (!reviewed.has('inventory review')) return review('inventory review');
        return writing('organize');
      }
      if (!reviewed.has('plan review')) return review('plan review');
      return writing('cards');
    }
    // An audit from before cards were added has not read them: the deck is previewed and audited again, for those.
    const audited = has.audit && !b.audit;
    const fresh = lastAdded && b.audit ? lastAdded : null;
    if (!audited && !previewed)
      return { stage: 'deck preview', button: 'Open the deck', hint: fresh ? `Every card, rendered — the ${fresh.count} new ${fresh.count === 1 ? 'one is' : 'ones are'} from #${fresh.from}. Flag any that are wrong.` : ABOUT['deck preview'], go: () => run('deck preview') };
    if (!audited)
      return {
        stage: 'audit',
        button: 'Run audit',
        hint: has.audit && cov?.unaudited ? `A fresh session reads the cards added since the last audit, from #${cov.unaudited}. Its findings and your flags go to an adjudicator; the writer applies the verdicts as written.` : ABOUT.audit,
        go: () => run('audit'),
      };
    if (has.flags > 0 && !has.verdicts)
      return {
        stage: 'audit',
        button: `Adjudicate ${has.flags} flag${has.flags === 1 ? '' : 's'}`,
        hint: 'An adjudicator that wrote none of the cards rules on each flag: approve, fix, or cut.',
        go: adjudicate,
        secondary: { label: 'Re-run audit', go: () => (force.add('audit'), run('audit')) },
      };
    if (has.flags > 0)
      return {
        stage: 'audit',
        button: 'Apply verdicts',
        hint: 'The writer applies every verdict as written -- no re-judging -- and the deck is re-checked.',
        go: applyVerdicts,
        secondary: { label: 'Re-adjudicate', go: adjudicate },
      };
    const toAnki = { label: 'Send to Anki', go: send };
    if (sentToAnki !== null)
      return {
        stage: 'deliver',
        button: 'Send again',
        hint: `Done. ${sentToAnki} — open Anki and study.`,
        go: send,
        secondary: { label: 'Export .apkg', go: () => run('deliver') },
      };
    if (exportedTo !== null)
      return {
        stage: 'deliver',
        button: 'Export again',
        hint: `Done. ${exportedTo} is beside your material — double-click it to import into Anki, or send it straight in.${withLine(ankiLine())}`,
        go: () => run('deliver'),
        secondary: toAnki,
      };
    const known = ankiLine();
    // What Anki already has says it best; without Anki's answer, an addition says the new cards go in beside the old.
    const adds = lastAdded ? ` Send to Anki adds the ${lastAdded.count} new card${lastAdded.count === 1 ? '' : 's'}; the ones already there are skipped.` : '';
    const hint = known ? `${known} Export writes an .apkg to import by hand instead.` : `${ABOUT.deliver} Anki must be open with the AnkiConnect add-on; Export writes an .apkg to import by hand instead.${adds}`;
    return { stage: 'deliver', button: 'Send to Anki', hint, go: send, secondary: { label: 'Export .apkg', go: () => run('deliver') } };
  }

  // ---- what Anki already has of the deck, said in the deliver step ----------------
  // Read when the step is shown -- for this folder under this name, and again
  // once what was read is a few seconds old -- and when Anki opens or closes.
  // Only reads (in-anki.ts); Anki closed, or an engine without these reads,
  // leaves the line empty and the bar says what it always did.
  const ANKI_FRESH_MS = 5000;
  let inAnki: { key: string; at: number; line: string } | null = null;
  let readingAnki: string | null = null;
  const withLine = (line: string): string => (line ? ` ${line}` : '');

  /** Which deck the line is about: the folder, and the name it goes to Anki under. */
  function ankiKey(): string {
    return `${host.courseDir() ?? ''}\n${host.deckName()}`;
  }

  /** The line for the deck as it is now, '' until Anki has answered; asks again when what is held is for another deck or old. */
  function ankiLine(): string {
    const key = ankiKey();
    const held = inAnki !== null && inAnki.key === key ? inAnki : null;
    if ((held === null || Date.now() - held.at > ANKI_FRESH_MS) && readingAnki !== key) void readAnki();
    return held?.line ?? '';
  }

  async function readAnki(): Promise<void> {
    const dir = host.courseDir();
    if (!dir) return;
    const key = ankiKey();
    readingAnki = key;
    const name = host.deckName();
    const [existing, stats] = await Promise.all([
      sidecar.ankiExisting(`${dir}/deck.json`).catch(() => null),
      name ? sidecar.ankiDeckStats(name).catch(() => null) : null,
    ]);
    if (readingAnki !== key) return; // asked again since, for this deck or another
    readingAnki = null;
    inAnki = { key, at: Date.now(), line: inAnkiLine(existing, stats) };
    if (!busy && ankiKey() === key) renderBar();
  }

  // ---- each deck's own session -----------------------------------------------------
  // One set of steps serves every deck the window opens, and what it
  // remembers without a file -- reviews read, the preview opened, the export,
  // the send, a re-run asked for -- belongs to the deck it happened in
  // (per-deck.ts). Without this, an export of one deck showed the next deck
  // opened as delivered, and an inventory read in one offered "Looks right"
  // in the next, unread.
  const sessions = perDeck(() => ({ reviewed: [] as StageId[], force: [] as StageId[], previewed: false, exportedTo: null as string | null, sentToAnki: null as string | null, lastAdded: null as { from: number; count: number } | null }));

  /** When another deck is open: puts the last one's session away and takes out this one's. */
  function followDeck(): void {
    const dir = host.courseDir();
    if (dir === sessions.at()) return;
    const mine = sessions.swap(dir, { reviewed: [...reviewed], force: [...force], previewed, exportedTo, sentToAnki, lastAdded });
    reviewed.clear();
    for (const s of mine.reviewed) reviewed.add(s);
    force.clear();
    for (const s of mine.force) force.add(s);
    ({ previewed, exportedTo, sentToAnki, lastAdded } = mine);
    // The gate was the last deck's, and the shell has emptied it.
    showing = null;
    gateStage = null;
    halted = false;
  }

  function renderBar(): void {
    followDeck();
    if (!host.courseDir()) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    if (busy) {
      const n = STAGES.indexOf(busy as StageId) + 1;
      bar.innerHTML = `<span class="nb-spin" aria-hidden="true"></span>
        <div class="nb-text"><span class="nb-k">${
          through ? 'Running through to audit' : n > 0 ? `Running · step ${n} of ${STAGES.length}` : 'Running'
        }</span><strong>${esc(busy)}…</strong><span class="nb-hint">${
        through
          ? 'Each stage starts the next; it stops at the audit for you. Stop ends the run and keeps what it wrote; Cancel ends it and offers what it wrote for the trash.'
          : 'Watch the agent below. Stop ends its turn and keeps what it wrote; Cancel ends it and offers what it wrote for the trash.'
      }</span></div>
        <div class="nb-run"><span class="nb-elapsed">0s</span><span class="nb-idle" aria-hidden="true"></span><span class="nb-said sr-only" role="status"></span></div>
        <div class="nb-actions">${OUTPUT[busy as StageId] ? '<button type="button" data-cancel="1" class="quiet">Cancel</button>' : ''}<button type="button" data-stop="1" class="quiet">Stop</button></div>`;
      tick();
      return;
    }
    const a = action();
    const n = STAGES.indexOf(a.stage) + 1;
    // Material added to a made deck: the kicker says so until it is through to the audit.
    const adding = behind().audit ? (cov?.materials ?? []).filter((f) => !(cov?.audit ?? cov?.deck ?? cov?.plan ?? cov?.inventory)?.covers.includes(f)).length : 0;
    const needsAgent = !runner && (WRITING_STAGES.some((w) => w.id === a.stage) || a.stage === 'audit');
    rail.querySelectorAll<HTMLLIElement>('li').forEach((li) => li.classList.toggle('next', li.dataset.stage === a.stage));
    // Run to audit: offered wherever a stage is still ahead of the audit and an agent can run it.
    const canThrough = !!runner && !needsAgent && nextAuto() !== null && !(a.stage === 'extract' && !has.inventory && !host.hasMaterials());
    // The number belongs to the kicker, with how many there are -- "step 4 of
    // 8" says where a run is; "4 ·" in front of the name only crowds it.
    bar.innerHTML = `<div class="nb-text"><span class="nb-k">${
      exportedTo !== null && a.stage === 'deliver' ? 'Done' : adding ? `Adding ${adding} file${adding === 1 ? '' : 's'} · step ${n} of ${STAGES.length}` : `Next · step ${n} of ${STAGES.length}`
    }</span><strong>${esc(a.stage)}</strong><span class="nb-hint">${esc(a.hint)}</span></div>
      <div class="nb-actions">${
        canThrough ? `<button type="button" data-through="1" class="quiet" title="Extract, organize, cards and audit in a row, with no stops; come back to the findings.">Run to audit</button>` : ''
      }${a.secondary ? `<button type="button" data-secondary="1" class="quiet">${esc(a.secondary.label)}</button>` : ''}${
        needsAgent ? `<button type="button" data-settings="1">Set up an agent in Settings</button>` : `<button type="button" data-go="1">${esc(a.button)}</button>`
      }</div>`;
  }

  bar.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    // The bar is a class's while one is open (class-steps.ts); its buttons are not these.
    if (!b || !host.courseDir()) return;
    if (b.dataset.stop || b.dataset.cancel) {
      // The audit and the adjudicator run in sessions of their own; the runner
      // knows which one is prompting. Between turns there is nothing to cancel,
      // and the flag still ends a run-through before its next stage.
      stopRequested = true;
      if (b.dataset.cancel) discardAfter = true;
      const id = runner?.activeSession() ?? writerSession;
      if (id) void sidecar.cancel(id);
      host.say(`${b.dataset.cancel ? 'cancelling' : 'stopping'} ${busy ?? 'the run'}…`);
      return;
    }
    if (b.dataset.settings) return host.openSettings();
    if (b.dataset.through) return void runThrough();
    const a = action();
    if (b.dataset.go) void a.go();
    else if (b.dataset.secondary && a.secondary) void a.secondary.go();
  });

  async function refresh(): Promise<void> {
    const dir = host.courseDir();
    if (!dir) {
      renderBar();
      return;
    }
    try {
      const { artifacts, coverage } = await sidecar.listCourse(dir);
      cov = coverage ?? null;
      const audit = artifacts.deck ? await sidecar.readCourse(dir, 'audit.md').then(() => true, () => false) : false;
      const verdicts = artifacts.deck ? await sidecar.readCourse(dir, 'verdicts.md').then(() => true, () => false) : false;
      const flags = artifacts.deck ? await sidecar.readFlags(`${dir}/deck.json`).then((r) => r.flags.length, () => 0) : 0;
      has = { inventory: artifacts.inventory, plan: artifacts.plan, deck: artifacts.deck, audit, verdicts, flags };
    } catch {
      has = { inventory: false, plan: false, deck: false, audit: false, verdicts: false, flags: 0 };
      cov = null;
    }
    rail.querySelectorAll<HTMLLIElement>('li').forEach((li) => li.classList.toggle('done', done(li.dataset.stage as StageId)));
    renderBar();
  }

  function showGate(html: string, artifact: string | null = null): void {
    gate.innerHTML = html;
    gate.hidden = false;
    showing = artifact;
    host.showAgentView();
    renderBar();
  }
  function hideGate(): void {
    gate.hidden = true;
    showing = null;
    renderBar();
  }

  /**
   * The artifact a stage wrote, with the way on. After a writing stage the
   * gate is the review: the button marks the review step done and runs the
   * stage after it, rather than showing the same file twice.
   */
  function showArtifactGate(stage: StageId, artifact: string, text: string | null): void {
    gateStage = stage;
    let after = next(stage);
    const reviewStep = after === 'inventory review' || after === 'plan review' ? after : null;
    if (reviewStep) after = next(reviewStep);
    const label = after === 'deck preview' ? 'Open the deck →' : after ? `Looks right → ${after}` : '';
    // No file, nothing to approve: a stopped organize offered "Looks right →
    // cards" over "(no plan.md was written)". The way on is the step again.
    const writer = WRITER[artifact];
    const forward =
      text === null
        ? writer ? `<button type="button" data-go="${writer}">Run ${esc(writer)} again</button>` : ''
        : after ? `<button type="button" data-go="${after}" ${reviewStep ? `data-reviewed="${reviewStep}"` : ''}>${esc(label)}</button>` : '';
    const missing = halted && stage === writer ? `${stage} stopped before writing ${artifact}` : `no ${artifact} was written`;
    showGate(`<header class="bar"><span>${esc(artifact)}</span><span class="grow"></span>
      ${forward}<button type="button" data-reread="${esc(artifact)}" class="quiet">Re-read</button>${
        writer && text !== null ? `<button type="button" data-discard="${writer}" class="quiet" title="Move what this step wrote to the deck's trash and go back to it">Discard…</button>` : ''
      }<button type="button" data-close="1" class="quiet">Close</button></header>
      <pre class="artifact">${text === null ? `(${esc(missing)} — run it again, or ask the agent below)` : esc(text)}</pre>`, artifact);
  }

  async function readBefore(dir: string): Promise<Before> {
    try {
      const b = JSON.parse((await sidecar.readCourse(dir, BEFORE)).text) as unknown;
      return typeof b === 'object' && b !== null && !Array.isArray(b) ? (b as Before) : {};
    } catch {
      return {};
    }
  }

  /** Keeps `file` as it is before an addition runs on it -- or, for a run written whole (`text` null), drops what was kept. */
  async function keepBefore(dir: string, file: MadeFile, text: string | null): Promise<void> {
    const kept = await readBefore(dir);
    if (text === null && !kept[file]) return;
    const key = COVERS[WRITER[file] ?? 'audit']!.key;
    if (text === null) delete kept[file];
    else kept[file] = { text, from: cov?.[key]?.covers ?? givenTo(WRITER[file] ?? 'audit'), unaudited: cov?.unaudited ?? null };
    await sidecar.writeCourse(dir, BEFORE, { text: JSON.stringify(kept) }).catch(() => undefined);
  }

  /**
   * The step finished and its file is there: the record that it was written
   * from `given`. Cards added to a made deck say where they start, so the
   * audit reads only those; an addition that carded nothing has nothing new
   * for the audit either.
   */
  async function recordMade(dir: string, stage: StageId, given: string[], before: string | null, after: string): Promise<void> {
    const file = COVERS[stage]?.file;
    if (!file) return;
    let newFrom: number | null | undefined;
    if (stage === 'cards') {
      if (before === null) {
        newFrom = null;
        lastAdded = null;
      } else {
        const n0 = noteCount(before);
        const n1 = noteCount(after);
        lastAdded = n1 > n0 ? { from: n0 + 1, count: n1 - n0 } : null;
        newFrom = lastAdded ? lastAdded.from : (cov?.unaudited ?? null);
        // New cards are new to Anki and to the .apkg: what was sent or exported was the deck without them, and what Anki was said to hold is read again.
        exportedTo = sentToAnki = null;
        inAnki = null;
        previewed = false;
      }
    }
    try {
      cov = (await sidecar.madeFrom(dir, file, given, newFrom)).coverage;
      if (stage === 'cards' && before !== null && !lastAdded && has.audit && cov.audit) cov = (await sidecar.madeFrom(dir, 'audit.md', given)).coverage;
    } catch (err) {
      host.say(err instanceof EngineError ? err.message : String(err), true);
    }
    host.coverageChanged?.();
  }

  async function run(stage: StageId): Promise<void> {
    const dir = host.courseDir();
    if (!dir) return host.say('choose a course folder first', true);
    // Not an error: the previous click is still working. Saying which, and
    // where to watch it, is the whole of what the person needed to know.
    if (busy) return host.say(`${busy} is still running — watch the agent below, or press Stop in the bar`);
    if (stage === 'extract' && !host.hasMaterials()) {
      host.say('add the lecture files first', true);
      return host.addFiles();
    }
    const writing = WRITING_STAGES.find((w) => w.id === stage);
    if ((writing || stage === 'audit') && !runner) {
      host.say('no agent is connected — set one up in Settings', true);
      return host.openSettings();
    }
    setStage(stage);
    // Only a branch that claimed the bar gives it back: opening the deck or a
    // review is not a run, and clearing busy when it finished used to clear it
    // for whatever stage had started meanwhile.
    let claimed = false;
    const claim = (label: string): void => {
      setBusy(label);
      claimed = true;
    };
    // What was here before, so a discard takes only what this run added.
    const snapshot = async (): Promise<void> => {
      const before = await sidecar.listCourse(dir).then((r) => new Set(r.files.map((f) => f.relPath)), () => null);
      lastRun = before ? { dir, stage, before } : null;
    };
    halted = false;
    try {
      if (writing) {
        host.showAgentView();
        hideGate();
        claim(stage);
        await snapshot();
        // What the step is given, as of now -- a file added while it runs is not in it.
        cov = await sidecar.listCourse(dir).then((r) => r.coverage ?? null, () => cov);
        const given = givenTo(stage);
        const file = COVERS[stage]!.file;
        const adding = exists(stage) ? addedTo(stage) : [];
        const before = adding.length ? await sidecar.readCourse(dir, file).then((r) => r.text, () => null) : null;
        await keepBefore(dir, file, before);
        // What it adds is read before the next step, as the first time was.
        if (adding.length && stage === 'extract') reviewed.delete('inventory review');
        if (adding.length && stage === 'organize') reviewed.delete('plan review');
        if (stage === 'extract') await host.prepareMaterials(dir);
        if (stopRequested) {
          halted = true;
          host.say(`${stage} stopped before the agent started`);
          return;
        }
        host.say(adding.length ? `running ${stage} on ${names(adding)}…` : `running ${stage}…`);
        const r = await runner!.run(adding.length && before !== null ? additionStage(writing, adding) : writing);
        halted = r.stopReason !== 'end_turn';
        if (!halted && r.artifactText !== null) await recordMade(dir, stage, given, adding.length ? before : null, r.artifactText);
        host.say(!halted ? (stage === 'cards' && before !== null ? (lastAdded ? `cards finished — ${lastAdded.count} new, from #${lastAdded.from}` : 'cards finished — the added files gave no new cards') : `${stage} finished`) : `${stage} stopped: ${r.stopReason}`, halted);
        if (!discardAfter) showArtifactGate(stage, writing.artifact, r.artifactText);
      } else if (stage === 'inventory review' || stage === 'plan review') {
        const artifact = stage === 'inventory review' ? 'inventory.md' : 'plan.md';
        const text = await sidecar.readCourse(dir, artifact).then((r) => r.text, () => null);
        showArtifactGate(stage, artifact, text);
      } else if (stage === 'deck preview') {
        previewed = true;
        await host.openDeck(dir);
      } else if (stage === 'audit') {
        // Resumable: if audit.md is already beside the deck -- from an earlier
        // run, or a run lost to a restart -- show it and offer the adjudicator
        // rather than paying for the audit again. "Re-run" is there for when
        // the deck has changed since.
        const existing = await sidecar.readCourse(dir, 'audit.md').then((r) => r.text, () => null);
        cov = await sidecar.listCourse(dir).then((r) => r.coverage ?? null, () => cov);
        // Cards added since the audit was written: it is behind, and this one reads those.
        const stale = behind().audit;
        if (existing !== null && !force.has('audit') && !stale) {
          const { flags } = await sidecar.readFlags(`${dir}/deck.json`);
          showGate(`<header class="bar"><span>audit.md (already written) · ${flags.length} flag(s) to adjudicate</span><span class="grow"></span>
            ${flags.length ? '<button type="button" data-adjudicate="1">Adjudicate</button>' : ''}<button type="button" data-rerun="audit" class="quiet">Re-run audit</button><button type="button" data-close="1" class="quiet">Close</button></header>
            <pre class="artifact">${esc(existing)}</pre>`);
          host.say('audit.md is already there — adjudicate, or re-run the audit');
          return;
        }
        force.delete('audit');
        const given = givenTo('audit');
        const scope: AuditScope | undefined = existing !== null && stale && cov?.unaudited ? { from: cov.unaudited, files: addedTo('audit') } : undefined;
        // Read only for the added cards, the last audit is kept for Discard to put back.
        await keepBefore(dir, 'audit.md', scope ? existing : null);
        // What the last audit wrote is about a deck that has changed since; an
        // auditor that writes nothing this time must not have it read back as
        // this run's findings.
        await Promise.all(['audit.md', 'audit.json'].map((name) => sidecar.deleteCourse(dir, name).catch(() => undefined)));
        // The method's run-sheet: an auditor who wrote none of the cards reads
        // the whole deck first; its findings and the owner's flags then go to
        // a separate adjudicator. The owner sees the report before that step.
        host.showAgentView();
        hideGate();
        claim(stage);
        await snapshot();
        host.say(scope ? `auditing the cards added since the last audit, from #${scope.from}, in a fresh session…` : 'auditing the whole deck in a fresh session…');
        const deckPath = `${dir}/deck.json`;
        // The auditor is told review.html is beside deck.json -- the run-sheet's
        // step 2, every front rendered as the student will see it. The app keeps
        // its own preview in memory, so the file is written here, just before.
        await sidecar.review(deckPath, { outPath: `${dir}/review.html` }).catch(() => undefined);
        const a = await runner!.audit(scope);
        halted = a.stopReason !== 'end_turn';
        // A cancelled audit's findings are not merged into the owner's flags.
        if (discardAfter) return;
        if (!halted && a.report !== null) await sidecar.madeFrom(dir, 'audit.md', given).then((r) => (cov = r.coverage), () => undefined);
        const { flags } = await sidecar.readFlags(deckPath);
        const merged: Flag[] = mergeFlags([
          ...flags,
          ...a.findings.filter((f: AuditFinding) => f.card > 0).map((f: AuditFinding) => ({ noteIndex: f.card - 1, note: `[${f.angle}] ${f.finding}`, at: new Date().toISOString() })),
        ]);
        await sidecar.writeFlags(deckPath, merged);
        showGate(`<header class="bar"><span>audit.md · ${a.findings.length} finding(s), ${flags.length} owner flag(s)</span><span class="grow"></span>
          ${merged.length ? `<button type="button" data-adjudicate="1">Adjudicate ${merged.length}</button>` : ''}<button type="button" data-close="1" class="quiet">Close</button></header>
          <pre class="artifact">${a.report === null ? '(no audit.md was written)' : esc(a.report)}</pre>`);
        host.say(a.stopReason === 'end_turn' ? `audit filed ${a.findings.length} finding(s)` : `auditor stopped: ${a.stopReason}`, a.stopReason !== 'end_turn');
      } else if (stage === 'deliver') {
        claim(stage);
        const out = await host.exportDeck();
        if (out !== null) exportedTo = out;
        else if (exportedTo === null) exportedTo = 'the .apkg';
      }
    } catch (err) {
      halted = true;
      host.say(err instanceof EngineError ? err.message : String(err), true);
    } finally {
      const cancelled = claimed && discardAfter;
      if (claimed) setBusy(null);
      await refresh();
      if (cancelled) await offerDiscard(stage);
    }
  }

  /**
   * Cancel, or Discard on a review: what the stage wrote and whatever else
   * its run added to the folder, listed, then moved to the deck's trash on a
   * yes -- the step goes back to not done. Nothing that was there before the
   * run is offered: the person's material stays, and so does an earlier
   * step's output. Without a record of the run (a later step has run since,
   * or the app restarted), only the step's own file is offered.
   */
  async function offerDiscard(stage: StageId): Promise<void> {
    const dir = host.courseDir();
    const outputs = OUTPUT[stage];
    if (!dir || !outputs) return;
    if (busy) return host.say(`${busy} is still running — stop it first`);
    // A run that added to a file the step had already written: the file goes back to how it was, not to the trash.
    const file = COVERS[stage]?.file ?? null;
    const restore = file && (await readBefore(dir))[file] ? file : null;
    const own = (await Promise.all(outputs.map((name) => sidecar.readCourse(dir, name).then(() => name, () => null)))).filter((n): n is string => n !== null && n !== restore);
    const run = lastRun && lastRun.dir === dir && lastRun.stage === stage ? lastRun : null;
    const added = run ? await sidecar.listCourse(dir).then((r) => r.files.map((f) => f.relPath).filter((f) => !run.before.has(f)), () => []) : [];
    const names = [...own, ...added];
    if (names.length === 0 && !restore) {
      hideGate();
      return host.say(`${stage} left nothing behind`);
    }
    const note = run ? 'Everything that was in the folder before the run stays.' : "Only the step's own file is listed: what else a run added is known only for the latest run, until the app closes.";
    const button = restore ? (names.length ? `Put back ${restore} and move ${names.length} to the trash` : `Put back ${restore}`) : `Move ${names.length} to the trash`;
    const text = [
      restore ? `${restore} goes back to how it was before the files added later were run through it. Nothing else changes.` : '',
      names.length ? `These go to the deck's trash, kept there 30 days:\n\n${names.map((n) => `  ${n}`).join('\n')}` : '',
      names.length || !restore ? note : '',
    ].filter(Boolean).join('\n\n');
    showGate(`<header class="bar"><span>Discard ${esc(stage)}?</span><span class="grow"></span><button type="button" data-discard-yes="1">${esc(button)}</button><button type="button" data-close="1" class="quiet">Keep</button></header>
      <pre class="artifact">${esc(text)}</pre>`);
    pendingDiscard = { dir, stage, names, restore };
  }

  async function discard(): Promise<void> {
    const d = pendingDiscard;
    pendingDiscard = null;
    if (!d || d.dir !== host.courseDir()) return hideGate();
    if (busy) return host.say(`${busy} is still running — stop it first`);
    const failed: string[] = [];
    if (d.restore) {
      const kept = await readBefore(d.dir);
      const was = kept[d.restore];
      try {
        if (!was) throw new Error(`what ${d.restore} was before is gone`);
        await sidecar.writeCourse(d.dir, d.restore, { text: was.text });
        // Its record goes back with it: what it covered, and where the unaudited cards started.
        cov = (await sidecar.madeFrom(d.dir, d.restore, was.from, d.restore === 'deck.json' ? was.unaudited : undefined)).coverage;
        // The audit put back did not read the added cards: they are unaudited again, from where they were.
        if (d.restore === 'audit.md' && was.unaudited && cov.deck) cov = (await sidecar.madeFrom(d.dir, 'deck.json', cov.deck.covers, was.unaudited)).coverage;
        delete kept[d.restore];
        await sidecar.writeCourse(d.dir, BEFORE, { text: JSON.stringify(kept) });
        if (d.restore === 'deck.json') lastAdded = null;
      } catch (err) {
        failed.push(`${d.restore} (${err instanceof Error ? err.message : String(err)})`);
      }
      host.coverageChanged?.();
    }
    for (const name of d.names) await sidecar.deleteCourse(d.dir, name, { trash: true }).catch(() => failed.push(name));
    if (lastRun?.dir === d.dir && lastRun.stage === d.stage) lastRun = null;
    const review = next(d.stage);
    if (review === 'inventory review' || review === 'plan review') reviewed.delete(review);
    if (d.stage === 'cards') previewed = false;
    hideGate();
    host.say(
      failed.length ? `could not put back or move ${failed.join(', ')}` : `${d.stage} discarded — ${[d.restore ? `${d.restore} put back` : '', d.names.length ? `${d.names.length} moved to the deck's trash` : ''].filter(Boolean).join(', ')}`,
      failed.length > 0,
    );
    await refresh();
  }

  /** Send to Anki: no agent runs, so it is not a busy stage; it either lands or says why not. */
  async function send(): Promise<void> {
    if (busy) return host.say(`${busy} is still running — watch the agent below`);
    host.say('sending to Anki…');
    const r = await host.sendToAnki();
    if (r === null) return renderBar();
    // A deck sent again is all duplicates: that is not a failure, just nothing new.
    const cards = (n: number) => `${n} card${n === 1 ? '' : 's'}`;
    const where = r.decks.join(', ');
    sentToAnki =
      r.added === 0 && r.total > 0
        ? `${r.total === 1 ? 'The card was' : `All ${cards(r.total)} were`} already in ${where}`
        : r.skipped > 0
          ? `${cards(r.added)} added to ${where}; ${r.skipped} ${r.skipped === 1 ? 'was' : 'were'} already there`
          : `${r.added} of ${cards(r.total)} in ${where}`;
    renderBar();
  }

  /** The next stage a run-through would start, or null when it is the person's turn: the audit is written, or there is nothing to extract from. */
  function nextAuto(): StageId | null {
    const b = behind();
    if (!has.inventory || b.extract) return host.hasMaterials() ? 'extract' : null;
    if (!has.plan || b.organize) return 'organize';
    if (!has.deck || b.cards) return 'cards';
    if (!has.audit || b.audit) return 'audit';
    return null;
  }

  /**
   * Run through to the audit: the writing stages and the audit in a row,
   * with no stop at the read-and-confirm gates -- for the person who has
   * been through the steps enough times and wants to come back to findings.
   * It ends where judgment starts, with the audit on screen and adjudication
   * waiting, or at the first stage that wrote nothing.
   */
  async function runThrough(): Promise<void> {
    if (busy) return host.say(`${busy} is still running — watch the agent below`);
    if (!runner) {
      host.say('no agent is connected — set one up in Settings', true);
      return host.openSettings();
    }
    through = true;
    renderBar();
    try {
      for (;;) {
        await refresh();
        const stage = nextAuto();
        if (stage === null) break;
        if (stage === 'organize') reviewed.add('inventory review');
        if (stage === 'cards') reviewed.add('plan review');
        await run(stage);
        // A stopped stage can leave its file behind -- deck.json written early,
        // then cancelled mid-fix -- so the file existing is not the test.
        if (stopRequested || halted) {
          host.say(`run-through stopped at ${stage}`, !stopRequested);
          return;
        }
        await refresh();
        if (!done(stage) && !(stage === 'audit' && has.audit)) {
          host.say(`run-through stopped: ${stage} wrote nothing`, true);
          return;
        }
      }
      host.say(has.audit ? 'run-through done — the audit is ready to read' : 'run-through done');
    } finally {
      through = false;
      renderBar();
    }
  }

  async function adjudicate(): Promise<void> {
    const dir = host.courseDir();
    if (!dir || !runner) return;
    const { flags } = await sidecar.readFlags(`${dir}/deck.json`);
    if (flags.length === 0) return host.say('nothing is flagged', true);
    if (busy) return host.say(`${busy} is still running — watch the agent below`);
    host.showAgentView();
    hideGate();
    setBusy('adjudicate');
    host.say(`adjudicating ${flags.length} flag(s) in a fresh session…`);
    try {
      // Verdicts from an earlier round rule on other flags, by card numbers
      // that may have moved; an adjudicator that writes nothing must not have
      // them shown, and offered for applying, as its own.
      await sidecar.deleteCourse(dir, 'verdicts.md').catch(() => undefined);
      const r = await runner.adjudicate(mergeFlags(flags)); // the owner may have flagged a card the audit already had
      showGate(`<header class="bar"><span>verdicts.md</span><span class="grow"></span>
        ${r.verdicts !== null ? '<button type="button" data-apply="1">Apply verdicts</button>' : ''}<button type="button" data-close="1" class="quiet">Close</button></header>
        <pre class="artifact">${r.verdicts === null ? '(no verdicts.md was written)' : esc(r.verdicts)}</pre>`);
      host.say(r.stopReason === 'end_turn' ? 'verdicts in — review them, then apply' : `adjudicator stopped: ${r.stopReason}`, r.stopReason !== 'end_turn');
    } catch (err) {
      host.say(err instanceof EngineError ? err.message : String(err), true);
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  async function applyVerdicts(): Promise<void> {
    const dir = host.courseDir();
    if (!dir || !runner) return;
    if (busy) return host.say(`${busy} is still running — watch the agent below`);
    host.showAgentView();
    hideGate();
    setBusy('applying verdicts');
    host.say('writer applying verdicts…');
    try {
      const r = await runner.applyVerdicts();
      host.say(r.stopReason === 'end_turn' ? 'verdicts applied — re-checking the deck' : `writer stopped: ${r.stopReason}`, r.stopReason !== 'end_turn');
      // The flags were the adjudicator's input; once its verdicts are applied
      // they are resolved, and their note indexes no longer line up with a
      // deck that may have lost cards. Clear them before the reload, so the
      // deck view does not show sixteen stale flags on a clean deck.
      // verdicts.md goes with them, for the same reason: left behind, the next
      // round's flags made the button "Apply verdicts" again, and the writer
      // applied the old rulings by number to cards that had since moved.
      if (r.stopReason === 'end_turn') {
        await sidecar.writeFlags(`${dir}/deck.json`, []).catch(() => undefined);
        await sidecar.deleteCourse(dir, 'verdicts.md').catch(() => undefined);
      }
      previewed = true;
      await host.openDeck(dir);
    } catch (err) {
      host.say(err instanceof EngineError ? err.message : String(err), true);
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  function note(): string {
    const nextStage = busy ? null : action().stage;
    // The audit's sub-steps (adjudicating, applying verdicts) run under the audit.
    const runningStage = busy ? ((STAGES as readonly string[]).includes(busy) ? (busy as StageId) : 'audit') : null;
    const steps = STAGES.map((stage) => {
      const state: StepState = stage === runningStage ? 'running' : done(stage) ? 'done' : stage === nextStage ? 'next' : 'not yet';
      return { stage, state, about: FINISH[stage] };
    });
    // Files no step after them has been given yet: what the steps are bringing through.
    const pending = behind().audit ? (cov?.materials ?? []).filter((f) => !(cov?.audit ?? cov?.deck ?? cov?.plan ?? cov?.inventory)?.covers.includes(f)) : [];
    return stepsNote(steps, host.deckName(), pending);
  }

  /**
   * One line from the agent, checked before anything moves: a writing step is
   * done only if its file is in the folder; a step is started only when it is
   * the one the bar offers and nothing is running. Delivering is left to the
   * person -- it puts cards into their Anki.
   */
  async function act(d: Directive): Promise<string> {
    if (!host.courseDir()) return `no deck is open; ${d.stage} is left as it is`;
    await refresh();
    const { stage } = d;
    if (d.verb === 'done') {
      const file = FILE[stage];
      if (file) {
        if (done(stage)) return `✓ ${stage} is done — ${file} is in the folder`;
        const missing = exists(stage) ? addedTo(stage) : [];
        return missing.length ? `${stage} is not done: ${file} does not have ${names(missing)} in it yet — run ${stage} on the new files` : `${stage} is not done: there is no ${file} in the folder yet`;
      }
      if (stage === 'inventory review' || stage === 'plan review') {
        const needs = stage === 'inventory review' ? 'extract' : 'organize';
        if (!done(needs)) return `${stage} cannot be checked off: ${needs} has not written ${FILE[needs]} yet`;
        if (done(stage)) return `✓ ${stage} was already done`;
        reviewed.add(stage);
        if (showing === (stage === 'inventory review' ? 'inventory.md' : 'plan.md')) hideGate();
        await refresh();
        return `✓ ${stage} checked off — next: ${action().stage}`;
      }
      if (stage === 'deck preview') {
        if (!has.deck) return 'deck preview cannot be checked off: there is no deck.json yet';
        previewed = true;
        await refresh();
        return `✓ deck preview checked off — next: ${action().stage}`;
      }
      return "deliver is done when the deck is exported or sent to Anki — that is the person's button";
    }
    if (busy) return `${busy} is still running; ${stage} waits until it finishes`;
    if (stage === 'deliver') return "deliver puts cards into Anki — that is the person's button, in the bar above";
    const a = action();
    if (a.stage !== stage) return `${stage} is not next — ${a.stage} is`;
    if (a.button === 'Add files…') return "there are no files to read yet; add the lecture's files first";
    if (!runner && (WRITING_STAGES.some((w) => w.id === stage) || stage === 'audit')) return `${stage} needs an agent connected — see Settings`;
    void a.go();
    return `▸ ${a.button}`;
  }

  rail.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-stage]');
    if (li) void run(li.dataset.stage as StageId);
  });
  rail.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-stage]');
    if (!li) return;
    e.preventDefault();
    void run(li.dataset.stage as StageId);
  });

  gate.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    const dir = host.courseDir();
    if (!b || !dir) return;
    if (b.dataset.close) hideGate();
    else if (b.dataset.go) {
      if (b.dataset.reviewed) reviewed.add(b.dataset.reviewed as StageId);
      void run(b.dataset.go as StageId);
    } else if (b.dataset.reread) {
      const text = await sidecar.readCourse(dir, b.dataset.reread).then((r) => r.text, () => null);
      // Redrawn whole: a file the agent wrote since, asked in the chat, brings
      // the way on with it.
      if (gateStage && showing === b.dataset.reread) showArtifactGate(gateStage, b.dataset.reread, text);
      else {
        const pre = gate.querySelector('pre');
        if (pre) pre.textContent = text ?? `(no ${b.dataset.reread})`;
      }
    } else if (b.dataset.discard) void offerDiscard(b.dataset.discard as StageId);
    else if (b.dataset.discardYes) void discard();
    else if (b.dataset.adjudicate) void adjudicate();
    else if (b.dataset.apply) void applyVerdicts();
    else if (b.dataset.rerun) {
      force.add(b.dataset.rerun as StageId);
      void run(b.dataset.rerun as StageId);
    }
  });

  return {
    setConnection(conn) {
      const dir = host.courseDir();
      // The rate is read at each run, so a change in Settings reaches the next organize.
      runner = conn && conn.session && dir ? makeRunner(sidecar, conn, dir, host.deckName, note, () => ({ newPerDay: readNewPerDay(), anki: ankiReader(sidecar) })) : null;
      writerSession = conn?.session?.sessionId ?? null;
      renderBar();
    },
    run,
    // A deck just opened is refreshed first: its own session is taken out before anything is read against it.
    refresh: () => (followDeck(), refresh()),
    busy: () => busy,
    note,
    act,
    ankiChanged() {
      if (!host.courseDir()) return;
      inAnki = null;
      renderBar();
    },
  };
}
