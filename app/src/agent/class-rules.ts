// A class's rules, apart from its DOM: which folder can be one, which class
// a deck is in, how far off an exam is, and how the exams the agent found in
// the syllabus join the ones the person keeps. And a semester's: which is
// now, in what order they show, and what is coming up across its classes.
// No imports but types, so the tests run them as they are.

import type { ClassSummary, Deadline, Exam, Semester } from '../engine/client.js';

/** An exam as the agent wrote it into exams.json: no id yet, and nothing checked. */
export interface FoundExam {
  name: string;
  date: string | null;
  covers?: string;
}

/** A deadline as the agent wrote it into exams.json, beside the exams. */
export interface FoundDeadline {
  name: string;
  date: string | null;
  what?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `name` is `folder` or beneath it. */
const inFolder = (name: string, folder: string): boolean => name === folder || name.startsWith(`${folder}::`);

/** Whether a folder can be made a class: not one already, not inside one, holding none; not a semester, nor holding one. */
export function canBeClass(folder: string, classes: ClassSummary[], semesters: Semester[] = []): boolean {
  return !classes.some((c) => inFolder(folder, c.folder) || inFolder(c.folder, folder)) && !semesters.some((t) => inFolder(t.folder, folder));
}

/** The semester a deck, class or folder is in, if any: one at most, since semesters do not nest. */
export function semesterOf(name: string, semesters: Semester[]): Semester | undefined {
  return semesters.find((t) => inFolder(name, t.folder));
}

export type TermState = 'now' | 'ahead' | 'past' | 'undated';

/** Where a semester stands today. One with a start and no end is under way once it starts. */
export function termState(t: Semester, today: Date = new Date()): TermState {
  if (!t.start && !t.end) return 'undated';
  const now = ymd(today);
  if (t.start && now < t.start) return 'ahead';
  if (t.end && now > t.end) return 'past';
  return 'now';
}

/** The order they are shown in: the one under way, then those ahead (soonest first), then past ones (latest first), undated last. */
export function orderSemesters(semesters: Semester[], today: Date = new Date()): Semester[] {
  const rank: Record<TermState, number> = { now: 0, ahead: 1, past: 2, undated: 3 };
  return [...semesters].sort((a, b) => {
    const sa = termState(a, today);
    const sb = termState(b, today);
    if (sa !== sb) return rank[sa] - rank[sb];
    if (sa === 'ahead') return (a.start ?? '').localeCompare(b.start ?? '');
    return (b.start ?? b.end ?? '').localeCompare(a.start ?? a.end ?? '') || a.folder.localeCompare(b.folder, undefined, { numeric: true, sensitivity: 'base' });
  });
}

/** The semester a new class goes in unless the person says otherwise: the one under way, else the next, else the latest. */
export function defaultSemester(semesters: Semester[], today: Date = new Date()): Semester | undefined {
  return orderSemesters(semesters, today).find((t) => termState(t, today) !== 'undated') ?? semesters[0];
}

/** A first semester, named and dated from today, for the person to correct: US-style terms. */
export function suggestTerm(today: Date = new Date()): { name: string; start: string; end: string } {
  const y = today.getFullYear();
  const m = today.getMonth();
  if (m <= 4) return { name: `Spring ${y}`, start: `${y}-01-12`, end: `${y}-05-15` };
  if (m <= 6) return { name: `Summer ${y}`, start: `${y}-06-01`, end: `${y}-08-07` };
  return { name: `Fall ${y}`, start: `${y}-08-24`, end: `${y}-12-18` };
}

/**
 * The semester a new one most likely is: today's term, or -- when that one
 * is made already -- the term after the latest there is, Fall to Spring to
 * Summer to Fall. Named and dated for the person to correct.
 */
export function nextTerm(semesters: Semester[], today: Date = new Date()): { name: string; start: string; end: string } {
  const have = new Set(semesters.map((t) => t.folder.split('::').pop()!.toLowerCase()));
  let { name } = suggestTerm(today);
  // Past today's term, to the one after the latest made: never behind what exists.
  const latest = [...semesters].filter((t) => t.start).sort((a, b) => b.start!.localeCompare(a.start!))[0];
  if (latest && have.has(name.toLowerCase())) {
    const m = /\b(spring|summer|fall)\s+(\d{4})\b/i.exec(latest.folder);
    if (m) name = `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1).toLowerCase()} ${m[2]}`;
  }
  const after = (n: string): string => {
    const m = /^(Spring|Summer|Fall) (\d{4})$/.exec(n);
    if (!m) return n;
    const y = Number(m[2]);
    return m[1] === 'Spring' ? `Summer ${y}` : m[1] === 'Summer' ? `Fall ${y}` : `Spring ${y + 1}`;
  };
  for (let i = 0; i < 12 && have.has(name.toLowerCase()); i += 1) name = after(name);
  return { name, ...termFromName(name, today) };
}

/** A term's dates from its name, when it says one -- "Fall 2026", "Spring '27" -- else from today. */
export function termFromName(name: string, today: Date = new Date()): { start: string; end: string } {
  const m = /\b(fall|autumn|spring|summer|winter)\s*'?(\d{4}|\d{2})\b/i.exec(name);
  if (!m) {
    const { start, end } = suggestTerm(today);
    return { start, end };
  }
  const y = m[2]!.length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  switch (m[1]!.toLowerCase()) {
    case 'spring':
      return { start: `${y}-01-12`, end: `${y}-05-15` };
    case 'summer':
      return { start: `${y}-06-01`, end: `${y}-08-07` };
    case 'winter':
      return { start: `${y}-01-04`, end: `${y}-01-29` };
    default:
      return { start: `${y}-08-24`, end: `${y}-12-18` };
  }
}

/** "Aug 24 – Dec 18", or what is known of it. */
export function termRange(t: Semester, today: Date = new Date()): string {
  if (t.start && t.end) return `${shortDate(t.start, today)} – ${shortDate(t.end, today)}`;
  if (t.start) return `from ${shortDate(t.start, today)}`;
  if (t.end) return `until ${shortDate(t.end, today)}`;
  return 'no dates';
}

/** The exams still ahead across some classes, soonest first, each with its class. */
export function upcomingExams(classes: ClassSummary[], today: Date = new Date(), limit = Infinity): { exam: Exam; cls: ClassSummary }[] {
  const now = ymd(today);
  return classes
    .flatMap((cls) => cls.exams.filter((e) => e.date !== null && e.date >= now).map((exam) => ({ exam, cls })))
    .sort((a, b) => a.exam.date!.localeCompare(b.exam.date!) || a.cls.folder.localeCompare(b.cls.folder))
    .slice(0, limit);
}

/** One date still ahead in a class: an exam it is sat, or a deadline it is due. */
export interface Upcoming {
  kind: 'exam' | 'due';
  name: string;
  date: string;
  cls: ClassSummary;
}

/** Every exam and deadline still ahead across some classes, soonest first; on one day, the exam first. */
export function upcoming(classes: ClassSummary[], today: Date = new Date(), limit = Infinity): Upcoming[] {
  const now = ymd(today);
  const ahead = (d: string | null): d is string => d !== null && d >= now;
  return classes
    .flatMap((cls) => [
      ...cls.exams.filter((e) => ahead(e.date)).map((e): Upcoming => ({ kind: 'exam', name: e.name, date: e.date!, cls })),
      ...(cls.deadlines ?? []).filter((d) => ahead(d.date)).map((d): Upcoming => ({ kind: 'due', name: d.name, date: d.date!, cls })),
    ])
    .sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === 'exam' ? -1 : 1) || a.cls.folder.localeCompare(b.cls.folder))
    .slice(0, limit);
}

/** Within the week: what the School view marks as soon. */
export function soon(date: string, today: Date = new Date()): boolean {
  const n = daysUntil(date, today);
  return n >= 0 && n <= 7;
}

/** Today on this machine's calendar, YYYY-MM-DD. */
export function ymd(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Whole days from today to `date`; negative once it has passed. */
export function daysUntil(date: string, today: Date = new Date()): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${ymd(today)}T00:00:00Z`)) / 86_400_000);
}

/** How far off, said the way a person says it. */
export function countdown(date: string, today: Date = new Date()): string {
  const n = daysUntil(date, today);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

/** "Oct 14", or "Oct 14, 2027" when it is not this year. */
export function shortDate(date: string, today: Date = new Date()): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1] ?? '?';
  return y === today.getFullYear() ? `${month} ${d}` : `${month} ${d}, ${y}`;
}

/** The next exam on the calendar, today's included; null when none is ahead. */
export function nextExam(exams: Exam[], today: Date = new Date()): Exam | null {
  const now = ymd(today);
  return exams.filter((e) => e.date !== null && e.date >= now).sort((a, b) => a.date!.localeCompare(b.date!))[0] ?? null;
}

/** The next deadline on the calendar, today's included; null when none is ahead. */
export function nextDeadline(deadlines: Deadline[], today: Date = new Date()): Deadline | null {
  const now = ymd(today);
  return deadlines.filter((d) => d.date !== null && d.date >= now).sort((a, b) => a.date!.localeCompare(b.date!))[0] ?? null;
}

/** "due in 3 days", "due today", "was due 2 days ago". */
export function dueWhen(date: string, today: Date = new Date()): string {
  const n = daysUntil(date, today);
  return n < 0 ? `was due ${countdown(date, today)}` : `due ${countdown(date, today)}`;
}

/** What fits before an exam at the person's rate: the number the organize step is told. */
export function roomBefore(exam: Exam, newPerDay: number, today: Date = new Date()): number | null {
  if (!exam.date) return null;
  const n = daysUntil(exam.date, today);
  return n < 0 ? null : n * newPerDay;
}

/** One list from exams.json: a name, a real date or none, and what the row says about itself under `detail`. */
function rowsOf(list: unknown, detail: 'covers' | 'what'): { name: string; date: string | null; covers?: string; what?: string }[] {
  if (!Array.isArray(list)) return [];
  const out: { name: string; date: string | null; covers?: string; what?: string }[] = [];
  for (const x of list) {
    if (typeof x !== 'object' || x === null) continue;
    const e = x as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.replace(/\s+/g, ' ').trim() : '';
    if (!name) continue;
    const date = typeof e.date === 'string' && DATE.test(e.date) && !Number.isNaN(Date.parse(`${e.date}T00:00:00Z`)) ? e.date : null;
    const said = typeof e[detail] === 'string' && (e[detail] as string).trim() ? (e[detail] as string).trim() : undefined;
    out.push({ name, date, ...(said ? { [detail]: said } : {}) });
  }
  return out;
}

/** exams.json as the agent wrote it: its exams, and what is due besides them. An older brief's plain array is all exams. */
export function parseFoundDates(text: string): { exams: FoundExam[]; deadlines: FoundDeadline[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { exams: [], deadlines: [] };
  }
  if (Array.isArray(raw)) return { exams: rowsOf(raw, 'covers'), deadlines: [] };
  if (typeof raw !== 'object' || raw === null) return { exams: [], deadlines: [] };
  const o = raw as Record<string, unknown>;
  return { exams: rowsOf(o.exams, 'covers'), deadlines: rowsOf(o.deadlines, 'what') };
}

/** exams.json's exams alone. */
export function parseFoundExams(text: string): FoundExam[] {
  return parseFoundDates(text).exams;
}

const key = (name: string) => name.toLowerCase().replace(/\s+/g, ' ').trim();

type Row = { id?: string; name: string; date: string | null; covers?: string; what?: string; setBy?: 'person' };

export interface DatedMerge<T> {
  rows: T[];
  /** New rows the papers named. */
  added: number;
  /** Rows that gained a date, or a line about themselves, they did not have. */
  filled: number;
  /** Dates the papers moved: a newer paper -- a revised schedule -- over an older one's. */
  moved: { name: string; from: string; to: string }[];
  /** Dates the person set that the papers now say otherwise: theirs stands, and they are told. */
  differ: { name: string; papers: string; yours: string }[];
}

/**
 * The rows a class keeps, with what the agent found in the papers joined
 * in: a new name is added; a date or `detail` is filled in or, when a newer
 * paper moves it, moved. What the person set by hand is never overwritten --
 * a date they corrected stays theirs, and where the papers disagree, that is
 * said rather than done.
 */
function mergeDated<T extends Row>(kept: T[], found: Omit<Row, 'id' | 'setBy'>[], detail: 'covers' | 'what'): DatedMerge<Omit<T, 'id'> & { id?: string }> {
  const rows: (Omit<T, 'id'> & { id?: string })[] = kept.map((e) => ({ ...e }));
  const out: DatedMerge<Omit<T, 'id'> & { id?: string }> = { rows, added: 0, filled: 0, moved: [], differ: [] };
  for (const f of found) {
    const same = rows.find((e) => key(e.name) === key(f.name)) as Row | undefined;
    const said = f[detail];
    if (!same) {
      rows.push({ name: f.name, date: f.date, ...(said ? { [detail]: said } : {}) } as Omit<T, 'id'>);
      out.added += 1;
      continue;
    }
    const theirs = same.setBy === 'person';
    let filled = false;
    if (f.date && same.date !== f.date) {
      if (same.date === null) {
        same.date = f.date;
        filled = true;
      } else if (theirs) out.differ.push({ name: same.name, papers: f.date, yours: same.date });
      else {
        out.moved.push({ name: same.name, from: same.date, to: f.date });
        same.date = f.date;
      }
    }
    if (said && same[detail] !== said && (!same[detail] || !theirs)) {
      if (!same[detail]) filled = true;
      same[detail] = said;
    }
    if (filled) out.filled += 1;
  }
  return out;
}

export interface ExamMerge extends Omit<DatedMerge<Omit<Exam, 'id'> & { id?: string }>, 'rows'> {
  exams: (Omit<Exam, 'id'> & { id?: string })[];
}

/** The class's exams with the ones the papers name joined in (mergeDated). */
export function mergeExams(kept: Exam[], found: FoundExam[]): ExamMerge {
  const { rows, ...rest } = mergeDated(kept, found, 'covers');
  return { exams: rows, ...rest };
}

/** The class's deadlines with the ones the papers name joined in, as the exams are. */
export function mergeDeadlines(kept: Deadline[], found: FoundDeadline[]): DatedMerge<Omit<Deadline, 'id'> & { id?: string }> {
  return mergeDated(kept, found, 'what');
}
