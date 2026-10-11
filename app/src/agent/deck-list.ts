// The deck list's rules, apart from its DOM: Anki's `::` as folders, the
// orders, the search, what a deck's files and steps say. No imports but
// types, so the tests run them as they are.

import type { DeckSummary } from '../engine/client.js';

// Folders is the tidy view: grouped, A–Z. The other two are orders across
// every deck, which grouping would break -- "recent" with a deck from last
// month above yesterday's, because they share a folder -- so they are flat,
// and each deck carries its folder above its name instead.
export type Sort = 'folders' | 'recent' | 'progress';
export const SORTS: { id: Sort; label: string }[] = [
  { id: 'folders', label: 'Folders' },
  { id: 'recent', label: 'Recent' },
  { id: 'progress', label: 'Progress' },
];

/** "A::B::C" -> folder "A::B", leaf "C". A deck at the top has folder "". */
export function splitName(name: string): { folder: string; leaf: string } {
  const at = name.lastIndexOf('::');
  return at < 0 ? { folder: '', leaf: name } : { folder: name.slice(0, at), leaf: name.slice(at + 2) };
}

/** Every folder the decks sit in, with the folders above them: "A::B" brings "A" too. */
export function foldersOf(decks: DeckSummary[]): string[] {
  const all = new Set<string>();
  for (const d of decks) {
    const segs = splitName(d.name).folder.split('::').filter(Boolean);
    for (let i = 1; i <= segs.length; i += 1) all.add(segs.slice(0, i).join('::'));
  }
  return [...all].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

/** Whether every word typed appears somewhere in the deck's full name, folders included. */
export function matches(deck: DeckSummary, query: string): boolean {
  const name = deck.name.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => name.includes(w));
}

/** Where a deck is, in one phrase. */
export function deckStatus(d: DeckSummary): string {
  const a = d.artifacts;
  if (d.added && (a.inventory || a.plan || a.deck)) return `${d.added} file${d.added === 1 ? '' : 's'} added — not in the cards yet`;
  if (a.deck) return 'cards written — preview, audit, export';
  if (a.plan) return 'plan written — next: cards';
  if (a.inventory) return 'inventory written — next: organize';
  if (d.files > 0) return 'materials added — next: extract';
  return 'empty — add files';
}

/** How many of the eight steps this deck has finished, from the artifacts on
 *  disk. It counts what was written, not what was reviewed -- a review leaves
 *  nothing behind, so the rail is the only place that knows about those. */
export function deckSteps(d: DeckSummary): number {
  const a = d.artifacts;
  if (a.deck) return 5; // extract, inventory review, organize, plan review, cards
  if (a.plan) return 3; // through organize
  if (a.inventory) return 1; // extract
  return 0;
}

const KINDS: [string, string, string][] = [
  ['pdf', 'PDF', 'PDFs'],
  ['slides', 'slide deck', 'slide decks'],
  ['doc', 'document', 'documents'],
  ['text', 'text file', 'text files'],
  ['image', 'image', 'images'],
  ['audio', 'recording', 'recordings'],
  ['video', 'video', 'videos'],
  ['other', 'other file', 'other files'],
];

/** "2 PDFs, 1 document": what the person brought, by kind. */
export function material(d: DeckSummary): string {
  if (d.files === 0) return 'no files yet';
  const kinds: Record<string, number> = d.kinds ?? { pdf: d.pdfs, other: d.files - d.pdfs };
  const parts = KINDS.filter(([k]) => kinds[k]).map(([k, one, many]) => `${kinds[k]} ${kinds[k] === 1 ? one : many}`);
  return parts.join(', ') || 'no files yet';
}

/** "today", "yesterday", "4 days ago", then a date. */
export function when(iso: string, now = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(then)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(then.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}

export const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** Recent or Progress: every deck in one flat order, whatever its folder. */
export function arrange(decks: DeckSummary[], sort: Exclude<Sort, 'folders'>): DeckSummary[] {
  const recent = (a: DeckSummary, b: DeckSummary) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0);
  return [...decks].sort(sort === 'progress' ? (a, b) => deckSteps(b) - deckSteps(a) || recent(a, b) : recent);
}

/** A folder in the Folders view: its decks and its subfolders, each A–Z; `total` counts every deck beneath. */
export interface FolderNode {
  path: string;
  name: string;
  folders: FolderNode[];
  decks: DeckSummary[];
  total: number;
}

/** The tree of `folders` (kept ones, which may be empty) and the folders the decks' names imply. The root has path "". */
export function folderTree(decks: DeckSummary[], folders: string[] = []): FolderNode {
  const root: FolderNode = { path: '', name: '', folders: [], decks: [], total: 0 };
  const nodes = new Map<string, FolderNode>([['', root]]);
  const node = (path: string): FolderNode => {
    const found = nodes.get(path);
    if (found) return found;
    const { folder: parent, leaf } = splitName(path);
    const made: FolderNode = { path, name: leaf, folders: [], decks: [], total: 0 };
    nodes.set(path, made);
    node(parent).folders.push(made);
    return made;
  };
  for (const f of [...folders, ...foldersOf(decks)]) if (f) node(f);
  for (const d of decks) node(splitName(d.name).folder).decks.push(d);
  const finish = (n: FolderNode): number => {
    n.folders.sort((a, b) => byName(a.name, b.name));
    n.decks.sort((a, b) => byName(splitName(a.name).leaf, splitName(b.name).leaf));
    n.total = n.decks.length + n.folders.reduce((sum, f) => sum + finish(f), 0);
    return n.total;
  };
  finish(root);
  return root;
}
