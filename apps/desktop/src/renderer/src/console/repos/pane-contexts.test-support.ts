/**
 * The context this family's pane suites mount a pane under.
 *
 * AT THE FAMILY ROOT rather than in the shared surfaces tier, because a suite
 * co-located with its component cannot import from `test/` — nothing under
 * `src/renderer/src/console/` does — while the surfaces tier already reaches into
 * `src/`.
 */

import type { ConsoleBridge } from "../bridge/index.js";
import type { ConsolePaneAddress, ConsolePaneContext } from "../seats/index.js";
import { type SessionStore } from "../store/index.js";

/**
 * A pane context at one address, with whichever collaborators the case reaches.
 *
 * The ADDRESS half is not cast — it is the seat's own union, so a case handing a
 * pane a subject that pane is never opened over fails to compile, and the address's
 * own arm survives into the return. The binding half IS cast: the persistence stack
 * is three constructions no co-located case observes, and a builder that made them
 * anyway would put every pane suite on stores it never reads. A surface tier that
 * DOES mount the real deck composes `paneBinding` instead.
 */
export function paneContext<TAddress extends ConsolePaneAddress>(reached: {
  readonly address: TAddress;
  readonly paneId: string;
  readonly bridge?: ConsoleBridge | undefined;
  readonly sessionStore?: SessionStore | undefined;
}): Extract<ConsolePaneContext, TAddress> {
  return {
    ...reached.address,
    paneId: reached.paneId,
    bridge: reached.bridge,
    sessionStore: reached.sessionStore,
  } as unknown as Extract<ConsolePaneContext, TAddress>;
}
