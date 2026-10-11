// What the deck already holds in Anki, as the steps that plan and write its
// cards are told it. The shell reads Anki (anki/deckStats and anki/deckNotes,
// both read-only) and hands the reader to the stage through StageOptions;
// nothing here talks to Anki. A send skips only an exact repeat of a note's
// first field, so a card that asks the same thing in other words is the
// writer's to leave out -- which it can only do if it is told what is there.

import type { WritingStage } from './index.js';

/** What a deck in Anki, subdecks included, already holds, read just before a step runs. */
export interface AnkiHeldLike {
  /** False when Anki could not be read; the step is then told nothing. */
  reachable: boolean;
  /** As Anki spells it. */
  deck: string;
  exists: boolean;
  notes: number;
  cards: number;
  /** Cards never studied; the rest have been. */
  new: number;
  /** The first field of each note -- the field a duplicate is judged by -- oldest first, perhaps not all of them. */
  firstFields: string[];
}

/** The steps that decide which cards there are and write them; a step another one adds can join by its id. */
export const ANKI_STAGES = new Set<string>(['organize', 'cards']);

/** How long a step waits on Anki before running without it: a dialog open in Anki holds AnkiConnect's answer. */
export const ANKI_WAIT_MS = 5000;

/** The reader's answer, or null when it fails or Anki takes longer than ANKI_WAIT_MS. */
export async function readHeld(read: (deck: string) => Promise<AnkiHeldLike>, deck: string): Promise<AnkiHeldLike | null> {
  if (!deck) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ANKI_WAIT_MS)));
  try {
    return await Promise.race([read(deck).catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** A field as one line of text for a list in a prompt: tags gone, the common entities read, cut short when long. */
export function fieldText(html: string, max = 200): string {
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
 * The paragraph a step is given: how many notes the deck holds and how many
 * of its cards are studied, then each note's first field, then what to do
 * about them -- leave out of plan.md, or out of deck.json, a card one of them
 * already asks. Empty when Anki could not be read, has no such deck, or it is
 * empty: the step then reads as it always did.
 */
export function ankiParagraph(stage: Pick<WritingStage, 'artifact'>, held: AnkiHeldLike | null): string {
  if (!held || !held.reachable || !held.exists || held.notes === 0) return '';
  const notes = held.notes === 1 ? 'one note' : `${held.notes} notes`;
  const studied = held.cards - held.new;
  const cards = held.cards === 1 ? `one card, ${studied ? 'studied' : 'not studied yet'}` : `${held.cards} cards: ${studied} studied, ${held.new} new`;
  const listed = held.firstFields.map((f) => `- ${fieldText(f) || '(empty)'}`).join('\n');
  const more = held.notes > held.firstFields.length ? `\n- …and ${held.notes - held.firstFields.length} more, not listed` : '';
  const what =
    stage.artifact === 'plan.md'
      ? 'Plan no card that asks what one of these already asks; where the inventory has such a fact, leave it out, and say in plan.md which were left out for that reason.'
      : 'Write no card that asks what one of these already asks, even where plan.md lists it; when you finish, say which were left out for that reason.';
  return `Already in Anki, read from it just now: the deck ${held.deck} holds ${notes} (${cards}). The first field of each:\n${listed}${more}\nThese are cards the student already has, not lecture material. ${what}`;
}
