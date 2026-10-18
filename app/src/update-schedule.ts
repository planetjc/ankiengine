// When to look for an update, and what to do with what comes back. Kept apart
// from Tauri so the rules can be tested; updater.ts supplies the look itself
// and the bar.
//
// v0.2.1 looked once, at launch, and said nothing when that one look failed,
// so a launch that missed it -- the network not up yet, a hiccup -- stayed on
// its version until the next launch, with nothing on screen to say so. Now it
// looks at launch; after a failed look, again in a minute and then in five;
// every six hours while the app runs; and when the window comes back to the
// front, if the last look is half an hour old. A version put off with Later is
// not offered again for a day, unless the person asks (Settings).

export type Outcome =
  | { kind: 'available'; version: string }
  | { kind: 'latest' }
  | { kind: 'failed'; message: string };

export interface Look {
  /** When it finished, ms since the epoch. */
  at: number;
  outcome: Outcome;
}

/** What Settings is handed, where the shell can update itself (the desktop app). */
export interface UpdateControl {
  /** This app's version. */
  version(): Promise<string>;
  /** Look now: the bar goes up if there is an update, put off or not. */
  checkNow(): Promise<Outcome>;
  /** The last look, if there has been one. */
  last(): Look | null;
  /** Called after every look, background or asked for. */
  onLook(fn: (look: Look) => void): void;
}

export interface ScheduleDeps {
  /** The version on offer, or null when this one is the latest; throws when it cannot tell. */
  look(): Promise<{ version: string } | null>;
  /** Put the bar up for a version (replacing one already up). */
  offer(version: string): void;
  now(): number;
  later(ms: number, fn: () => void): void;
}

export const RETRY_AFTER = [60_000, 5 * 60_000];
export const EVERY = 6 * 60 * 60_000;
export const ON_FRONT_AFTER = 30 * 60_000;
export const PUT_OFF_FOR = 24 * 60 * 60_000;

export function updateSchedule(deps: ScheduleDeps) {
  let started = -Infinity;
  let running: Promise<Outcome> | null = null;
  let last: Look | null = null;
  let offered: string | null = null;
  let retrying = false;
  const putOff = new Map<string, number>();
  const listeners: ((look: Look) => void)[] = [];

  // One look at a time: a second asker gets the one already under way.
  function lookOnce(): Promise<Outcome> {
    if (running) return running;
    started = deps.now();
    running = deps
      .look()
      .then((found): Outcome => (found ? { kind: 'available', version: found.version } : { kind: 'latest' }))
      .catch((err: unknown): Outcome => ({ kind: 'failed', message: err instanceof Error ? err.message : String(err) }))
      .then((outcome) => {
        running = null;
        last = { at: deps.now(), outcome };
        for (const fn of listeners) fn(last);
        return outcome;
      });
    return running;
  }

  // Unasked: offers what is new unless it was put off, and tries again after a failure.
  async function background(attempt = 0): Promise<void> {
    if (offered) return;
    const outcome = await lookOnce();
    if (outcome.kind === 'available') {
      const until = putOff.get(outcome.version);
      if (!offered && !(until !== undefined && deps.now() < until)) {
        offered = outcome.version;
        deps.offer(outcome.version);
      }
    } else if (outcome.kind === 'failed' && attempt < RETRY_AFTER.length && !retrying) {
      retrying = true;
      deps.later(RETRY_AFTER[attempt]!, () => {
        retrying = false;
        void background(attempt + 1);
      });
    }
  }

  return {
    /** At launch. */
    launched: (): Promise<void> => background(),
    /** On the six-hour timer. */
    periodic: (): Promise<void> => background(),
    /** The window came back to the front. */
    toFront: (): Promise<void> => (deps.now() - started >= ON_FRONT_AFTER ? background() : Promise.resolve()),
    /** Asked for (Settings): offers what it finds even if it was put off. */
    async checkNow(): Promise<Outcome> {
      const outcome = await lookOnce();
      if (outcome.kind === 'available') {
        putOff.delete(outcome.version);
        offered = outcome.version;
        deps.offer(outcome.version);
      }
      return outcome;
    },
    /** Later: the bar is gone, and this version waits a day. */
    putOff(version: string): void {
      if (offered === version) offered = null;
      putOff.set(version, deps.now() + PUT_OFF_FOR);
    },
    last: (): Look | null => last,
    onLook(fn: (look: Look) => void): void {
      listeners.push(fn);
    },
  };
}

/** The line Settings shows for a look. */
export function lookLine(look: Look | null, time: (at: number) => string): string {
  if (!look) return 'Not checked yet.';
  const when = `Checked ${time(look.at)}`;
  switch (look.outcome.kind) {
    case 'available':
      return `${when}: version ${look.outcome.version} is available. The bar at the top of the window installs it.`;
    case 'latest':
      return `${when}: this is the latest version.`;
    case 'failed':
      return `${when}: could not reach the update feed (${look.outcome.message}).`;
  }
}
