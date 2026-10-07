// The `app` members as the preload carries them: the facts main started the window with, and the
// machine's region and clock as main pushes each change. The newest clock is held here, so a page
// that subscribes late, or a push that came before it subscribed, still reads the current one.

import { readAppFactsSwitches, type MachineClock } from "#shared/app-facts.js";
import { MACHINE_CLOCK_CHANNEL } from "#shared/bridge-channels.js";
import type { PreloadApi } from "#shared/preload-api.js";
import { MainPushes } from "./main-pushes.js";
import type { PreloadIpc } from "./ipc.js";

/** The `app` member the preload exposes, over `ipc`, from the switches in `argv`. */
export function createAppBridge(
  ipc: Pick<PreloadIpc, "on">,
  argv: readonly string[],
): PreloadApi["app"] {
  const facts = readAppFactsSwitches(argv);
  const machineClock = new HeldMachineClock(facts);
  ipc.on(MACHINE_CLOCK_CHANNEL, (_event, clock) => {
    machineClock.deliver(clock as MachineClock);
  });
  return {
    ...facts,
    subscribeMachineClock: (handler) => machineClock.subscribe(handler),
  };
}

/** The machine's newest region and clock, and the page's handlers for each change. */
class HeldMachineClock {
  readonly #pushes = new MainPushes<MachineClock>();
  #newest: MachineClock;

  public constructor(started: MachineClock) {
    // Copied out of the facts, so the first handing carries the clock alone, as each push does.
    this.#newest = { regionLocale: started.regionLocale, hourCycle: started.hourCycle };
  }

  public deliver(clock: MachineClock): void {
    this.#newest = clock;
    this.#pushes.deliver(clock);
  }

  public subscribe(handler: (clock: MachineClock) => void): () => void {
    return this.#pushes.subscribe(handler, async () => this.#newest);
  }
}
