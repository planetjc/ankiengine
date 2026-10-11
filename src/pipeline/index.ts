// The pipeline as prompts and a runner -- docs/APP.md: each stage hands the
// agent the bundled method file, the course folder and its materials, and
// asks for that step's artifact beside them; the adjudicator is a fresh
// session that wrote none of the cards, and the writer applies its verdicts
// verbatim. Nothing here says what a card is; the method text does.
//
// Over an injected client, so the desktop app (app/, through Tauri) and the
// browser page (site/, through the bridge) run the same stages with the same
// prompts. It began as app/src/pipeline.ts; the app kept a copy for a while,
// by a rule that it imports nothing from the engine at build time, and the
// copy silently missed `companions` and `describeExtracted` -- so the rule
// went, and there is one pipeline (docs/APP.md, "Where it lives").

import type { ContentBlock } from '../acp/protocol.js';
import type { Flag } from '../sidecar/methods.js';

export type { ContentBlock, Flag };

/** What a course folder listing looks like to the prompts: course/list's `files`. */
export interface CourseFileLike {
  relPath: string;
  kind: string;
  bytes: number;
  mimeType: string;
}

/** What the page extracted from one source file, beside it: course/list's `extracted`. */
export interface ExtractedLike {
  source: string; // relPath of the PDF
  text: string | null; // relPath of text.md, when written
  images: string[]; // relPaths of the page images, in page order
}

/** The class a course folder is in, as course/list gives it: its brief, and the exam the deck is studied for. */
export interface CourseClassLike {
  folder: string;
  path: string; // the class's own folder, where class.md is
  brief: 'none' | 'written' | 'reviewed';
  exam: { name: string; date: string | null; covers?: string } | null;
}

/** What a deck in Anki already holds: anki/deckNotes's answer. */
export interface AnkiHeldLike {
  reachable: boolean;
  deck: string;
  exists: boolean;
  total: number;
  firstFields: string[];
}

/** The subset of the sidecar surface the stages need, however it is reached. */
export interface PipelineClient {
  readMethod(name: string): Promise<{ text: string }>;
  listCourse(path: string): Promise<{ files: CourseFileLike[]; extracted?: ExtractedLike[]; class?: CourseClassLike | null }>;
  readCourse(path: string, name: string): Promise<{ text: string }>;
  /** Reads the deck in Anki, never changing it; without it, no stage is told what Anki holds. */
  ankiDeckNotes?(deck: string): Promise<AnkiHeldLike>;
  newSession(connectionId: string): Promise<{ session: { sessionId: string } }>;
  prompt(sessionId: string, blocks: ContentBlock[]): Promise<{ stopReason: string }>;
  /**
   * True for a failure the sidecar reported (a JSON-RPC error such as an
   * artifact not being there yet), which the runner tolerates; anything
   * else is a bug and is rethrown.
   */
  isRpcError(err: unknown): boolean;
}

/** An open agent connection with its writer session: agent/connect's result. */
export interface ConnectionLike {
  connectionId: string;
  session: { sessionId: string } | null;
}

export type StageId = 'extract' | 'inventory review' | 'organize' | 'plan review' | 'cards' | 'deck preview' | 'audit' | 'deliver';

export interface WritingStage {
  id: StageId | 'class brief';
  method: string; // method file name
  artifact: string; // what the stage writes beside the material
  ask: string; // the one app-side sentence: which folder, which artifact
  companions?: string[]; // other method-repo files this step refers to by name; attached so the agent never searches for them
  time?: boolean; // told the exam date and the student's rate: the step that sizes the deck to them
  anki?: boolean; // told what the deck already holds in Anki: the step that decides which cards there will be
}

/** How deck.json names its slide images: the app packs, checks and renders them from this list. */
const MEDIA =
  'Slide images: reference each one in Extra by the name the method gives it, and list every such name once in a top-level "media" array in deck.json as {"filename": "<that name>", "path": "<absolute path of the page image under _extracted/>"} -- this app packs, checks and renders the images from that list; there is no collection.media here to stage into, and no file is copied or renamed.';

export const WRITING_STAGES: WritingStage[] = [
  { id: 'extract', method: '1-extract.md', artifact: 'inventory.md', ask: 'Run this step on the course folder below and write inventory.md beside the material.', companions: ['SETUP.md'] },
  { id: 'organize', method: '2-organize.md', artifact: 'plan.md', ask: 'Run this step on the course folder below: inventory.md is already there; write plan.md beside it.', time: true, anki: true },
  {
    id: 'cards',
    method: '3-cards.md',
    artifact: 'deck.json',
    ask: `Run this step on the course folder below: plan.md and inventory.md are already there. Write deck.json beside them and stop there -- this app runs the structural checks and renders the review itself, and nothing is inserted into Anki from here. ${MEDIA}`,
  },
];

/** exams.json, as the app reads it: the exams, and what is due besides them. */
const DATES =
  'a JSON object {"exams": [...], "deadlines": [...]}. "exams" has one object per exam the papers name -- quizzes and practicals included -- {"name": "<as they name it>", "date": "YYYY-MM-DD" or null when no date is given, "covers": "<what it covers, in their words>"}. "deadlines" has one object per graded thing the papers say is due rather than sat -- an assignment, a problem set, a lab report, a paper, a presentation -- {"name": "<as they name it>", "date": "YYYY-MM-DD" or null, "what": "<what else they say of it -- its topic, its weight -- not its name again; left out when they say nothing more>"}, and is empty when they name none.';

/**
 * A class's one step, run in the class's own folder: the syllabus and the
 * other papers read once into class.md, which every deck in the class is
 * then given. exams.json is this app's, not the method's: the dates, which
 * the app keeps and does arithmetic with, as data the person confirms.
 */
export const CLASS_STAGE: WritingStage = {
  id: 'class brief',
  method: '0-class.md',
  artifact: 'class.md',
  ask: `Run this step on the class folder below and write class.md beside its files. Also write exams.json beside it: ${DATES} This app shows the person those exams and deadlines to confirm and keeps the dates; no cards are written here.`,
};

/**
 * The class brief again, for papers added since it was written: the same
 * step, told which papers are new and to fold them into class.md rather than
 * start over -- the person has read and corrected what is there.
 */
export function classUpdateStage(newPapers: string[]): WritingStage {
  const list = newPapers.map((f) => `- ${f}`).join('\n');
  return {
    ...CLASS_STAGE,
    ask: `class.md is already written beside the class's papers, from the ones it names, and the person has read it. These papers were added since:\n${list}\nRead each of them end to end and fold what they add into class.md, in its sections, each new line with its source -- as your method's "A paper added later" says. Keep every line that is there unless a new paper changes it, and say so where it does. Then write exams.json again, with every exam and deadline class.md now names: ${DATES} No cards are written here.`,
  };
}

/**
 * A writing step again, for material added to a deck after the step's file
 * was written: told which files are new, and to add to the file rather than
 * start over -- the person has read what is there, and the cards may be in
 * Anki already, which knows a note by its text.
 */
export function additionStage(stage: WritingStage, added: string[]): WritingStage {
  const list = added.map((f) => `- ${f}`).join('\n');
  const heading = `"## Added: ${added.join(', ')}"`;
  const asks: Partial<Record<WritingStage['id'], string>> = {
    extract: `inventory.md is already written beside the material, from the files it names, and the person has read it. These files were added to the deck since:\n${list}\nRead each of them end to end, as your method says, and add what they teach to the end of inventory.md under one new heading, ${heading}, in the same form as the rest, each fact with where it came from. Leave every line already there as it is. A fact the inventory already has is not listed again; one that differs from a line already there is listed under the new heading with both sources, and the old line stays.`,
    organize: `plan.md is already written from inventory.md, and the person has read it; its cards may already be written and in Anki. inventory.md now ends with facts from files added since:\n${list}\nPlan cards for those facts only, at the end of plan.md under one new heading, ${heading}, in the same form as the rest. Leave every card already planned as it is: a fact the plan already covers is not planned again, and a new fact that overlaps a planned card is noted under the new heading, not merged into the old card.`,
    cards: `deck.json is already written from plan.md, and its notes may already be in Anki, which knows a note by its text. plan.md now ends with cards planned for files added since:\n${list}\nWrite those cards, to the method, and add them to the end of the notes array in deck.json, in the plan's order, with the same deck name, note type, tags and conventions as the notes already there. Do not change, reorder or remove any note already in deck.json: one reworded would reach Anki as a second card and leave the first behind. Stop there -- this app runs the structural checks and renders the review itself. ${MEDIA} New images go after the ones already listed.`,
  };
  const ask = asks[stage.id];
  if (!ask) throw new Error(`${stage.id} has no addition`);
  return { ...stage, ask };
}

/** An audit of only the cards added since the last one: where they start, and the files they came from. */
export interface AuditScope {
  /** The first added card, counted from 1 in deck.json order. */
  from: number;
  files: string[];
}

/** What the app knows that the folder does not: the student's own rate, and what day it is. */
export interface StageOptions {
  /** New cards a day, the student's own setting. */
  newPerDay?: number;
  /** Today; the clock, when not given. */
  today?: Date;
}

const ATTACH_LIMIT = 20 * 1024 * 1024; // embedded attachments above this are listed by path only

function fileUri(dir: string, rel: string): string {
  return `file://${encodeURI(`${dir.replace(/\/$/, '')}/${rel}`)}`;
}

function describe(files: CourseFileLike[]): string {
  return files.map((f) => `- ${f.relPath} (${f.kind}, ${(f.bytes / 1024).toFixed(0)} KB)`).join('\n');
}

/**
 * The paragraph that stops the agent probing for PDF tooling: what the page
 * already extracted, where it is, and that nothing needs converting. Empty
 * when nothing was extracted, so a folder of plain text reads as before.
 */
export function describeExtracted(extracted: ExtractedLike[]): string {
  const lines = extracted
    .filter((e) => e.text !== null || e.images.length > 0)
    .map((e) => {
      const parts: string[] = [];
      if (e.text) parts.push(`${e.text} (the text of every page, under "## Page N" headings)`);
      if (e.images.length > 0) parts.push(e.images.length === 1 ? `one page image, ${e.images[0]}` : `${e.images.length} page images, ${e.images[0]} … ${e.images[e.images.length - 1]}`);
      return `- ${e.source} → ${parts.join('; ')}`;
    });
  if (lines.length === 0) return '';
  return `\n\nAlready extracted beside the material by this app, with no tools:\n${lines.join('\n')}\nRead those instead of converting the source; do not look for pdftotext, pypdf or any other tooling. The text can carry stray spaces inside words where the PDF's fonts have odd widths ("c opied"); for exact wording, the page image is the authority.`;
}

/** A date as the calendar has it, YYYY-MM-DD, in local time. */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Whole days from one YYYY-MM-DD to another. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The line the method's "From the time" rule waits for: the exam date and
 * the student's rate. Empty when there is no dated exam still ahead -- the
 * tiers then stand as written, as the method says.
 */
export function timeLine(exam: CourseClassLike['exam'], opts: StageOptions = {}): string {
  if (!exam?.date) return '';
  const today = ymd(opts.today ?? new Date());
  const days = daysBetween(today, exam.date);
  if (days < 0) return '';
  const when = days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} from today (${today})`;
  const covers = exam.covers ? ` The syllabus says it covers: ${exam.covers}.` : '';
  const rate =
    opts.newPerDay && opts.newPerDay > 0
      ? ` The student adds up to ${opts.newPerDay} new card${opts.newPerDay === 1 ? '' : 's'} a day (their own setting), so about ${days * opts.newPerDay} new cards can be reviewed before it.`
      : ' The student has not said how many new cards a day they add.';
  return `Time: this deck is studied for ${exam.name} on ${exam.date}, ${when}.${rate}${covers} This date is the student's own and wins over any date in class.md.`;
}

/** A field as one line of text for a list in a prompt: tags gone, the common entities read, cut short when long. */
function fieldText(html: string, max = 200): string {
  const text = html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * What the deck already holds in Anki, read just before the step runs: the
 * first field of each note, the field Anki judges a duplicate by. A send
 * skips only an exact repeat; a card that asks the same thing in other words
 * is the writer's to leave out. Empty when Anki is closed, has no such deck,
 * or it is empty -- the step then reads as it always did.
 */
export function ankiParagraph(held: AnkiHeldLike | null): string {
  if (!held || !held.reachable || !held.exists || held.total === 0) return '';
  const listed = held.firstFields.map((f) => `- ${fieldText(f) || '(empty)'}`).join('\n');
  const more = held.total > held.firstFields.length ? `\n- …and ${held.total - held.firstFields.length} more, not listed` : '';
  const n = held.total === 1 ? 'one note' : `${held.total} notes`;
  return `Already in Anki: the deck ${held.deck} holds ${n}, read from Anki just now. The first field of each:\n${listed}${more}\nThese are cards the student already has, not lecture material. Plan no card that asks what one of these already asks; where the inventory has such a fact, leave it out, and say in plan.md which were left out for that reason.`;
}

/** How long a stage waits on Anki before running without it: a modal dialog in Anki holds AnkiConnect's answer. */
const ANKI_WAIT_MS = 5000;

async function heldInAnki(client: PipelineClient, deck: string): Promise<AnkiHeldLike | null> {
  if (!client.ankiDeckNotes || !deck) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ANKI_WAIT_MS)));
  try {
    return await Promise.race([client.ankiDeckNotes(deck).catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The prompt for a writing stage: method as the system block, the ask, the listing, then the materials as links. */
export async function stageBlocks(client: PipelineClient, stage: WritingStage, courseDir: string, deckName: string, opts: StageOptions = {}): Promise<ContentBlock[]> {
  const [method, course] = await Promise.all([client.readMethod(stage.method), client.listCourse(courseDir)]);
  // A bridge started before SETUP.md was fetched, or APE_METHOD_DIR pointing at a
  // bare method/ checkout, has no companion to give: the stage runs without it
  // rather than failing on a file the agent can live without.
  const extras = (await Promise.all((stage.companions ?? []).map((name) => client.readMethod(name).then((r) => ({ name, text: r.text }), () => null)))).filter((e) => e !== null);
  const materials = course.files.filter((f) => f.kind !== 'other');
  const isClass = stage.id === 'class brief';
  // The method asks the user for the deck name and refuses to infer it
  // (a live run without one wrote "Deck: not supplied"); the app collects it.
  const deckLine = isClass ? `Class: ${deckName}` : deckName ? `Deck: ${deckName}` : 'Deck: not supplied by the user';
  const attached = extras.length > 0 ? `\n\n${extras.map((e) => e.name).join(', ')} from the method repository ${extras.length === 1 ? 'is' : 'are'} attached below; do not search the file system for ${extras.length === 1 ? 'it' : 'them'}.` : '';
  const extracted = course.extracted ?? [];
  // A deck in a class is given the class's brief, whole: a page or two, read
  // at every step, where the syllabus it came from would be paid for each time.
  const cls = !isClass && course.class ? course.class : null;
  const brief = cls && cls.brief !== 'none' ? await client.readCourse(cls.path, 'class.md').then((r) => r.text, () => null) : null;
  const classPara = cls
    ? brief !== null
      ? `\n\nThis deck is in the class ${cls.folder}. Its class brief, class.md, is attached below: what the syllabus and the class's other papers say about the whole course. It is course context, not lecture material; your method says how to use it.`
      : `\n\nThis deck is in the class ${cls.folder}, which has no class brief yet.`
    : '';
  const time = stage.time && cls ? timeLine(cls.exam, opts) : '';
  const anki = stage.anki && !isClass ? ankiParagraph(await heldInAnki(client, deckName)) : '';
  const blocks: ContentBlock[] = [
    { type: 'resource', resource: { uri: 'ape://system', text: method.text, mimeType: 'text/markdown' } },
    { type: 'text', text: `${stage.ask}${attached}\n\n${deckLine}\n${isClass ? 'Class' : 'Course'} folder: ${courseDir}\n\n${isClass ? 'Files' : 'Materials'}:\n${describe(materials) || '(none)'}${describeExtracted(extracted)}${classPara}${time ? `\n\n${time}` : ''}${anki ? `\n\n${anki}` : ''}` },
    ...extras.map((e): ContentBlock => ({ type: 'resource', resource: { uri: `ape://method/${e.name}`, text: e.text, mimeType: 'text/markdown' } })),
  ];
  if (cls && brief !== null) blocks.push({ type: 'resource', resource: { uri: fileUri(cls.path, 'class.md'), text: brief, mimeType: 'text/markdown' } });
  for (const f of materials) {
    if ((f.kind === 'pdf' || f.kind === 'image' || f.kind === 'text') && f.bytes <= ATTACH_LIMIT) {
      blocks.push({ type: 'resource_link', uri: fileUri(courseDir, f.relPath), name: f.relPath, mimeType: f.mimeType });
    }
  }
  // The extracted text is linked, not inlined: the agent reads it when it
  // gets there, and a 60-page lecture is not paid for twice in one prompt.
  for (const e of extracted) {
    if (e.text) blocks.push({ type: 'resource_link', uri: fileUri(courseDir, e.text), name: e.text, mimeType: 'text/markdown' });
  }
  return blocks;
}

export interface AuditFinding {
  card: number; // 1-based; 0 for a deck-wide (coverage) finding
  angle: 'truth' | 'fluency' | 'coverage' | 'style' | string;
  finding: string;
}

/** The auditor's prompt: the deck-auditor brief as the system block, the step-3 method for its reference cards, the deck. A fresh session that wrote none of the cards. */
export async function auditBlocks(client: PipelineClient, courseDir: string, scope?: AuditScope): Promise<ContentBlock[]> {
  const [brief, method, deck] = await Promise.all([client.readMethod('4-audit.md'), client.readMethod('3-cards.md'), client.readCourse(courseDir, 'deck.json')]);
  // Material added to an audited deck: its new cards are what is unread.
  const only = scope
    ? ` Cards #${scope.from} onward were added since this deck was last audited, from files added to it later (${scope.files.join(', ')}); the cards before them were audited then. Audit the added cards on all four angles -- coverage meaning coverage of the added files -- and read the earlier ones only to catch an added card that repeats or contradicts one of them.`
    : '';
  return [
    { type: 'resource', resource: { uri: 'ape://system', text: brief.text, mimeType: 'text/markdown' } },
    {
      type: 'text',
      text: `Audit the deck in the course folder below.${only} The seven reference cards your brief tells you to read first are at the top of the attached step-3 method; review.html is already rendered beside deck.json, so do not run render_review.py. Cards are numbered from 1 in deck.json array order. Write your findings to audit.md beside the deck -- all four angles of your brief -- and ALSO write audit.json beside it: a JSON array of objects { "card": <number>, "angle": "truth"|"fluency"|"coverage"|"style", "finding": "<one or two sentences>" }, one per finding that names a specific card (a coverage finding with no card uses "card": 0). Edit nothing else.\n\nCourse folder: ${courseDir}`,
    },
    { type: 'resource', resource: { uri: 'ape://method/3-cards.md', text: method.text, mimeType: 'text/markdown' } },
    { type: 'resource', resource: { uri: fileUri(courseDir, 'deck.json'), text: deck.text, mimeType: 'application/json' } },
  ];
}

/** The adjudicator's prompt: method 3, the deck, the flags -- and a verdict per flag, written beside the deck. */
export async function adjudicateBlocks(client: PipelineClient, courseDir: string, flags: Flag[]): Promise<ContentBlock[]> {
  const [method, deck] = await Promise.all([client.readMethod('3-cards.md'), client.readCourse(courseDir, 'deck.json')]);
  const list = flags.map((f, i) => `${i + 1}. card #${f.noteIndex + 1}: ${f.note || '(no note -- the reviewer flagged it without saying why; judge the card on the method alone)'}`).join('\n');
  return [
    { type: 'resource', resource: { uri: 'ape://system', text: method.text, mimeType: 'text/markdown' } },
    {
      type: 'text',
      text: `You are the adjudicator for a deck you did not write. You wrote none of these cards. For each flag below, read the card in deck.json (cards are numbered from 1 in array order) against the method above and the sources in the course folder, and return exactly one verdict per flag: "approve" with one sentence saying why the card stands as written, "fix" with the complete corrected Text/Extra/Source fields, or "cut" if the card should not exist. Write the verdicts to verdicts.md beside deck.json, numbered like the flags, and nothing else.\n\nCourse folder: ${courseDir}\n\nFlags:\n${list}`,
    },
    { type: 'resource', resource: { uri: fileUri(courseDir, 'deck.json'), text: deck.text, mimeType: 'application/json' } },
  ];
}

/** The writer applies the adjudicator's verdicts verbatim -- the standing rule, as wiring. */
export async function applyVerdictsBlocks(client: PipelineClient, courseDir: string): Promise<ContentBlock[]> {
  const verdicts = await client.readCourse(courseDir, 'verdicts.md');
  return [
    {
      type: 'text',
      text: `An adjudicator who wrote none of the cards has ruled on the flagged ones. Apply every "fix" verdict below to deck.json exactly as written -- do not re-judge, soften, or improve on them -- remove every card with a "cut" verdict, and leave every "approve" card as it is. Keep the array order of surviving cards. Rewrite deck.json in place and stop.\n\nCourse folder: ${courseDir}\n\n${verdicts.text}`,
    },
  ];
}

export interface Runner {
  run(stage: WritingStage): Promise<{ stopReason: string; artifactText: string | null }>;
  /** The whole-deck read the method's run-sheet calls step 3: a fresh session files findings; nothing is edited. With a scope, only the cards added since the last audit. */
  audit(scope?: AuditScope): Promise<{ stopReason: string; report: string | null; findings: AuditFinding[] }>;
  adjudicate(flags: Flag[]): Promise<{ stopReason: string; verdicts: string | null }>;
  applyVerdicts(): Promise<{ stopReason: string }>;
  /**
   * The session a turn is running in right now, or null. The audit and the
   * adjudicator run in fresh sessions, so "cancel the writer" does not stop
   * them; Stop cancels this one.
   */
  activeSession(): string | null;
}

/**
 * `context`, when given, is the shell's note on where the deck stands --
 * which steps are done, which is running, what the agent may do about it --
 * sent after the stage's own blocks. A writer that was only ever told its
 * current step answered a note mid-extract with "I already extracted it" and
 * set off on the rest of the process its own way.
 */
export function makeRunner(client: PipelineClient, conn: ConnectionLike, courseDir: string, deckName: () => string, context?: () => string, options?: () => StageOptions): Runner {
  const writer = conn.session!.sessionId;
  let active: string | null = null;
  const prompt = async (sessionId: string, blocks: ContentBlock[]): Promise<{ stopReason: string }> => {
    active = sessionId;
    try {
      return await client.prompt(sessionId, blocks);
    } finally {
      if (active === sessionId) active = null;
    }
  };
  return {
    async run(stage) {
      const blocks = await stageBlocks(client, stage, courseDir, deckName(), options?.());
      const where = context?.();
      if (where) blocks.push({ type: 'text', text: where });
      const { stopReason } = await prompt(writer, blocks);
      let artifactText: string | null = null;
      try {
        artifactText = (await client.readCourse(courseDir, stage.artifact)).text;
      } catch (err) {
        if (!client.isRpcError(err)) throw err;
      }
      return { stopReason, artifactText };
    },
    async audit(scope) {
      const fresh = await client.newSession(conn.connectionId);
      const { stopReason } = await prompt(fresh.session.sessionId, await auditBlocks(client, courseDir, scope));
      const report = await client.readCourse(courseDir, 'audit.md').then((r) => r.text, () => null);
      let findings: AuditFinding[] = [];
      try {
        const raw = JSON.parse((await client.readCourse(courseDir, 'audit.json')).text) as unknown;
        if (Array.isArray(raw)) findings = raw.filter((f): f is AuditFinding => typeof f === 'object' && f !== null && typeof (f as AuditFinding).finding === 'string');
      } catch {
        /* no machine-readable findings: the report still shows */
      }
      return { stopReason, report, findings };
    },
    async adjudicate(flags) {
      const fresh = await client.newSession(conn.connectionId);
      const blocks = await adjudicateBlocks(client, courseDir, flags);
      const { stopReason } = await prompt(fresh.session.sessionId, blocks);
      let verdicts: string | null = null;
      try {
        verdicts = (await client.readCourse(courseDir, 'verdicts.md')).text;
      } catch (err) {
        if (!client.isRpcError(err)) throw err;
      }
      return { stopReason, verdicts };
    },
    async applyVerdicts() {
      return prompt(writer, await applyVerdictsBlocks(client, courseDir));
    },
    activeSession: () => active,
  };
}
