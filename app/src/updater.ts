// Updates, against the feed named in tauri.conf.json. Signatures are Tauri's
// own minisign keys (the release workflow signs, the bundled pubkey
// verifies); this has nothing to do with Apple code signing. The user
// decides: a bar appears, they click. When to look is update-schedule.ts:
// at launch, again after a failure, every six hours, and when the window
// comes back to the front -- not once per launch, as v0.2.1 did.
import { getVersion } from '@tauri-apps/api/app';
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { EVERY, updateSchedule, type UpdateControl } from './update-schedule.js';

export function startUpdates(host: HTMLElement, say: (t: string, e?: boolean) => void): UpdateControl {
  let found: Update | null = null;
  let bar: HTMLElement | null = null;

  const schedule = updateSchedule({
    look: async () => {
      found = await check();
      return found ? { version: found.version } : null;
    },
    offer: (version) => show(version),
    now: () => Date.now(),
    later: (ms, fn) => void setTimeout(fn, ms),
  });
  // A failed look stays off the screen (offline is ordinary), but not out of reach:
  // Settings shows the last look, and the console has the reason.
  schedule.onLook((look) => {
    if (look.outcome.kind === 'failed') console.warn('update check failed:', look.outcome.message);
  });

  function show(version: string): void {
    const update = found;
    if (!update) return;
    bar?.remove();
    const el = document.createElement('div');
    bar = el;
    el.className = 'update-bar';
    const offerIt = (lead: string, go: string): void => {
      el.innerHTML = `<span></span><button type="button" data-go>${go}</button><button type="button" data-later class="quiet">Later</button>`;
      el.querySelector('span')!.textContent = lead;
      el.querySelector<HTMLButtonElement>('[data-later]')!.onclick = () => {
        el.remove();
        if (bar === el) bar = null;
        schedule.putOff(version);
      };
      el.querySelector<HTMLButtonElement>('[data-go]')!.onclick = () => void install(update);
    };
    const install = async (u: Update): Promise<void> => {
      el.textContent = 'Downloading…';
      try {
        let total = 0;
        let got = 0;
        await u.downloadAndInstall((ev) => {
          if (ev.event === 'Started') total = ev.data.contentLength ?? 0;
          else if (ev.event === 'Progress') {
            got += ev.data.chunkLength;
            if (total) el.textContent = `Downloading… ${Math.round((got / total) * 100)}%`;
          } else if (ev.event === 'Finished') el.textContent = 'Installing…';
        });
        await relaunch();
      } catch (err) {
        // The bar stays, with the reason and another go, rather than vanishing.
        say(`update failed: ${String(err)}`, true);
        offerIt(`Version ${version} did not install: ${String(err)}`, 'Try again');
      }
    };
    offerIt(`Version ${version} is available.`, 'Update and restart');
    host.prepend(el);
  }

  void schedule.launched();
  setInterval(() => void schedule.periodic(), EVERY);
  const toFront = (): void => {
    if (document.visibilityState === 'visible') void schedule.toFront();
  };
  document.addEventListener('visibilitychange', toFront);
  window.addEventListener('focus', toFront);

  return {
    version: () => getVersion(),
    checkNow: () => schedule.checkNow(),
    last: () => schedule.last(),
    onLook: (fn) => schedule.onLook(fn),
  };
}
