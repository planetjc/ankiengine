// One deck's share of what the steps remember this session and leave no
// file for. The window has one set of steps for every deck it opens
// (stages.ts), so each deck's share is put away when another opens and is
// there again when it comes back; a deck not opened before starts with
// nothing.

/** Holds a value per deck folder. */
export interface PerDeck<T> {
  /** The deck the value in hand is for: null before any, or with none open. */
  at(): string | null;
  /** Puts `now` away under the deck it is for, and hands back the value for `dir`: as it was left, or new. */
  swap(dir: string | null, now: T): T;
}

export function perDeck<T>(fresh: () => T): PerDeck<T> {
  const kept = new Map<string, T>();
  let at: string | null = null;
  return {
    at: () => at,
    swap(dir, now) {
      if (dir === at) return now;
      if (at !== null) kept.set(at, now);
      at = dir;
      return (dir === null ? undefined : kept.get(dir)) ?? fresh();
    },
  };
}
