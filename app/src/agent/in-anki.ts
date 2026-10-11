// What Anki already has, in the app's words: the deck names offered in the
// rail, the deliver step's line on what a send will add and how much of the
// deck has been studied, and what the steps that plan and write cards are
// told the deck already holds. Read through the engine's anki/* reads, which
// never change the collection.

import type { AnkiHeldLike } from '../../../dist/pipeline/anki.js';
import type { AnkiDeckStats, AnkiExisting, SidecarClient } from '../engine/client.js';

/** Anki's deck names in the order a person looks for them: by name, Lecture 2 before Lecture 10. */
export function deckSuggestions(decks: string[]): string[] {
  const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...new Set(decks)].sort(byName.compare);
}

/**
 * The deliver step's line, said before Send to Anki is pressed: how many of
 * the deck's notes Anki already holds, and, for a deck Anki has, how many of
 * its cards are studied. Empty when Anki could not be read.
 */
export function inAnkiLine(existing: AnkiExisting | null, stats: AnkiDeckStats | null): string {
  const lines: string[] = [];
  if (existing?.reachable && existing.total > 0) {
    const { total, existing: there } = existing;
    if (total === 1) lines.push(there ? 'The note is already in Anki; a send adds nothing.' : 'The note is not in Anki yet.');
    else if (there === 0) lines.push(`None of the ${total} notes are in Anki yet.`);
    else if (there === total) lines.push(`All ${total} notes are already in Anki; a send adds nothing.`);
    else lines.push(`${there} of the ${total} notes ${there === 1 ? 'is' : 'are'} already in Anki; a send adds the other ${total - there}.`);
  }
  if (stats?.reachable && stats.exists && stats.cards > 0) {
    const studied = stats.cards - stats.new;
    const has = stats.cards === 1 ? 'one card' : `${stats.cards} cards`;
    const how = studied === 0 ? (stats.cards === 1 ? 'not studied yet' : 'none studied yet') : studied === stats.cards ? (stats.cards === 1 ? 'studied' : 'all studied') : `${studied} of them studied`;
    lines.push(`${stats.deck} has ${has} in Anki, ${how}.`);
  }
  return lines.join(' ');
}

/**
 * What the deck already holds in Anki, as organize and cards are told it
 * (src/pipeline/anki.ts): its counts from anki/deckStats, its notes' first
 * fields from anki/deckNotes. A stage's reader, handed over in StageOptions.
 */
export function ankiReader(sidecar: Pick<SidecarClient, 'ankiDeckStats' | 'ankiDeckNotes'>): (deck: string) => Promise<AnkiHeldLike> {
  return async (deck) => {
    const [stats, held] = await Promise.all([sidecar.ankiDeckStats(deck), sidecar.ankiDeckNotes(deck)]);
    return {
      reachable: stats.reachable && held.reachable,
      deck: stats.deck,
      exists: stats.exists && held.exists,
      notes: held.total,
      cards: stats.cards,
      new: stats.new,
      firstFields: held.firstFields,
    };
  };
}
