// A shell whose requests a case raises by hand, standing in for the main process.
//
// The `shell` namespace is the one on `SidekicksBridge` that runs main → renderer,
// so every suite that exercises it needs a process no renderer suite runs. This is
// that stand-in, and it lives here rather than beside a caller because two families
// reach for it — the seat that lands the request and the composer that answers it —
// and a second copy would be a second answer to what the shell does.

import type { ConsoleBridge } from "./console-bridge.js";
import { createFixtureBridge } from "./fixture/call-plane/bridge.js";
import { FIRST_RUN_SCENARIO } from "./scenarios/first-run.js";

/** One bridge whose shell is the case's to drive, and the two acts it offers. */
export interface ShellProbe {
  readonly bridge: ConsoleBridge;
  /** Raise one composer-focus request, as `webContents.send` would. */
  raiseComposerFocusRequest: () => void;
  /** How many subscriptions this bridge is currently holding. */
  openSubscriptionCount: () => number;
}

/**
 * A real `ConsoleBridge` whose `shell` namespace is the case's to drive.
 *
 * Built by replacing ONE namespace on a real fixture bridge rather than hand-drawing
 * a bridge: everything a consumer reaches on the way to that namespace is then the
 * shipped thing, and the stand-in is exactly the part no renderer suite can have — a
 * main process on the other end of the channel.
 */
export function shellProbe(): ShellProbe {
  const handlers = new Set<() => void>();
  const fixture = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });
  return {
    bridge: {
      ...fixture,
      sidekicks: {
        ...fixture.sidekicks,
        shell: {
          subscribeToComposerFocusRequest: (handler: () => void) => {
            handlers.add(handler);
            return () => {
              handlers.delete(handler);
            };
          },
        },
      },
    },
    raiseComposerFocusRequest: () => {
      for (const handler of handlers) {
        handler();
      }
    },
    openSubscriptionCount: () => handlers.size,
  };
}
