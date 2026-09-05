// Counting how many times the run-state stream was opened.
//
// IN THE BRIDGE FAMILY BECAUSE TAKING `sidekicks.daemon` IS. The chokepoint gate
// admits exactly this family to the raw namespace — a test in any other family is
// standing in for a surface, and a surface goes through the door — and counting
// subscriptions means wrapping the namespace's own `subscribe`. The run-state feed's
// re-open case needs the count and lives in the runs family, so the wrapper lives
// here, beside the frame readers for the stream it counts.

import { RUN_STATE_SUBSCRIBE_STREAM } from "./daemon-streams.js";
import type { ConsoleBridge } from "./console-bridge.js";

/** A bridge that counts run-state opens, and the count as it stands. */
export interface CountedRunStateOpens {
  readonly bridge: ConsoleBridge;
  /** How many times `run.subscribeState` has been opened on this bridge. */
  readonly openCount: () => number;
}

/**
 * Count the run-state subscriptions a bridge is asked for, leaving them all real.
 *
 * A spread over the bridge it is handed rather than a stand-in, so a case composes
 * it with whatever else that bridge already answers — a captured stream, a scripted
 * call arm — instead of choosing between counting and everything else.
 */
export function withCountedRunStateOpens(bridge: ConsoleBridge): CountedRunStateOpens {
  let opens = 0;
  const underlying = bridge.sidekicks.daemon.subscribe as (
    name: string,
    sink: (payload: unknown) => void,
  ) => () => void;
  return {
    openCount: () => opens,
    bridge: {
      ...bridge,
      sidekicks: {
        ...bridge.sidekicks,
        daemon: {
          ...bridge.sidekicks.daemon,
          subscribe: ((name: string, sink: (payload: unknown) => void) => {
            if (name === RUN_STATE_SUBSCRIBE_STREAM) {
              opens += 1;
            }
            return underlying(name, sink);
          }) as ConsoleBridge["sidekicks"]["daemon"]["subscribe"],
        },
      },
    } as ConsoleBridge,
  };
}
