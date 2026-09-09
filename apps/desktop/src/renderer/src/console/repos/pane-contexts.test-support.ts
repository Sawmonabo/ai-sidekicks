/**
 * The two contexts this family's surfaces are mounted under.
 *
 * Seven suites wrote one of these by hand and four of them closed it with
 * `as unknown as`, which is what let a hand-written context drift from the seat it
 * claims to be: a section context is four members and needs no cast at all, and a
 * cast that hides that also hides a member the seat later adds.
 *
 * AT THE FAMILY ROOT rather than in the shared surfaces tier, because a suite
 * co-located with its component cannot import from `test/` — nothing under
 * `src/renderer/src/console/` does — while the surfaces tier already reaches into
 * `src/`. One home reachable by all seven callers has to sit on this side.
 */

import type { ConsoleBridge } from "../bridge/index.js";
import type {
  ConsolePaneAddress,
  ConsolePaneContext,
  SidebarSectionContext,
} from "../seats/index.js";
import {
  sectionContext as seatSectionContext,
  type SectionBindings,
} from "../seats/slots/section-context.test-support.js";
import { type SessionStore } from "../store/index.js";

/**
 * A section context with real collaborators, in this family's own vocabulary.
 *
 * A ONE-LINE WRAPPER over `seats/slots/section-context.test-support.ts` and not a second
 * builder. That module states the rule — a family WRAPS the seat's context rather than
 * replacing it — and this file used to hold a byte-equivalent copy of the body instead,
 * which is exactly the drift that rule exists to prevent: two builders for one seat,
 * each with its own idea of which member a case has to state.
 *
 * It stays as a name in this family because seven repos suites reach it by this
 * specifier and the seat's own bindings type is what they were already passing.
 */
export function sectionContext(reached: SectionBindings): SidebarSectionContext {
  return seatSectionContext(reached);
}

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
