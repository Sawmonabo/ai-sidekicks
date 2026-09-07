// What happens when starting a session settles, beside what happens when a join does.
//
// The two acts this destination offers are the same question answered twice — the
// work does not exist yet, or it exists somewhere else — and until this module they
// were answered in two different shapes. A settled join carried the session it joined
// and the surface acted on it: it told the node's directory its list had moved and it
// navigated. A settled START carried nothing, because the component that performs the
// create is a shipped Tier-1 probe with no caller: it created from its own mount
// effect and handed the settlement to nobody, so the surface counted PRESSES and the
// session it had just made had a name no console surface could learn. This is the
// other half of that pair, and it exists so both acts settle the same way.
//
// FOUR THINGS, IN THIS ORDER, AND EACH ONE IS ONE FACT.
//
//   1. THE STORE OPENS. A session this window created is a session this window has
//      open, and the registry is where that is true. It matters before the navigation
//      rather than as a consequence of it: the all-sessions list merges the node's
//      directory with the registry's own set, so a create the node's directory has
//      not answered yet is on screen because the registry holds it. Opening is
//      idempotent, so this is not a rival of the route's own open one layer up.
//   2. THE ORIGIN IS STAMPED. Four markers, and this console is the only party that
//      can assert them for any session at all — it authored this one. They are
//      asserted at the PRESS rather than derived from a directory row, because the
//      directory carries no origin and never will: `GrowthSessionSummary` is a
//      session id, a title and a state, so a rule that read origins off it would be
//      guessing, and the rule's whole point is that it does not guess.
//   3. THE NODE'S DIRECTORY IS DECLARED STALE. The same door a settled join calls,
//      for the same reason and on the same terms — the act has settled and carries
//      the session it produced, so this schedules a read of something that HAPPENED.
//   4. THE WINDOW NAVIGATES. Last, because it is the one step a person sees, and
//      because it is the step that ends this surface's mount.
//
// THE PIN IS NOT ONE OF THE FOUR. Auto-pin fires on a first SEND, which is the
// composer's moment rather than this one; what this act does is record the evidence
// the rule needs, in the one place both families can reach.

import { recordConsoleStartedSession, requestSessionDirectoryRead } from "../../seats/index.js";
import type { ConsoleSurfaceContext, SessionOriginEvidence } from "../../seats/index.js";
import { pinSessionToFrontTier } from "../rows/session-pins.js";
import { readWindowAutoPinOnFirstSend } from "../rows/session-preferences.js";

/**
 * A session this window started: every marker known, none of them an exclusion.
 *
 * Declared HERE, at the act that asserts it, rather than beside the switch that
 * describes it. It is the one origin the console can report in full, and the reason
 * it can is that this module is where the session came from — so a second spelling of
 * it anywhere else would be a second claim about what a start press produces.
 */
export const STARTED_IN_THIS_WINDOW: SessionOriginEvidence = {
  isDraftPlaceholder: true,
  arrivedByImport: false,
  openedForChildWork: false,
  startedByWorkflow: false,
};

/**
 * The durable half of the auto-pin rule, as the two verbs this act hands over.
 *
 * NEITHER VERB NAMES A STORE, AND THAT IS THE WHOLE OF WHY IT IS A CONSTANT. Both
 * resolve the binding this window is holding at the moment they are CALLED, through
 * the window-lifetime holders `rows/session-pins.ts` and `rows/session-preferences.ts`
 * declare — so a first send made after somebody went back to the list, turned the
 * switch off and rearranged the tiers reads the switch they left and writes over the
 * map they left. Composed from this destination's own render-time bindings instead,
 * both verbs resolved through the holder that mount had built: a later mount built
 * another, and the record went on answering through the first.
 *
 * Frozen at module level rather than built per settled start, because it closes over
 * nothing — there is one auto-pin authority per window and it has no fields.
 */
const WINDOW_AUTO_PIN_AUTHORITY = {
  readAutoPinOnFirstSend: readWindowAutoPinOnFirstSend,
  pinToFront: pinSessionToFrontTier,
};

/** What the destination hands this act, and everything the act touches. */
export interface SessionStartSettlement {
  readonly bridge: ConsoleSurfaceContext["bridge"];
  readonly sessionStoreRegistry: ConsoleSurfaceContext["sessionStoreRegistry"];
  /** Where a settled start goes. The same navigation a settled join performs. */
  readonly openSession: (sessionId: string) => void;
  /** The session the daemon minted. Never a guess, and never a press. */
  readonly sessionId: string;
}

/**
 * Settle one start, having been told which session it produced.
 *
 * FOR A SETTLED CREATE AND NEVER FOR A PRESS. Every step below names a session, and
 * at the press there is no session to name — which is exactly why the probe had to
 * hand its settlement out before any of this was reachable.
 */
export function settleSessionStart(settlement: SessionStartSettlement): void {
  const { bridge, sessionStoreRegistry, openSession, sessionId } = settlement;
  // The disposed check is the remount window `frame/session-lifecycle.ts` names:
  // `open` is the one registry call that raises rather than returning a refusal, and
  // a settlement landing after this window's registry was replaced must not take the
  // rest of the act with it. Nothing is lost by skipping it — a disposed registry
  // belongs to a bridge this window has already left.
  if (!sessionStoreRegistry.isDisposed) {
    sessionStoreRegistry.open(sessionId);
  }
  recordConsoleStartedSession({
    bridge,
    sessionId,
    origin: STARTED_IN_THIS_WINDOW,
    // BOTH VERBS RESOLVE THE WINDOW'S DURABLE BINDING ON EVERY CALL. That is what
    // lets the record outlive this surface: the first send that consults it usually
    // happens after the navigation below has unmounted the destination, and a
    // captured VALUE would by then be a copy of a durable record rather than a
    // reading of it — while a binding captured from THIS mount would be a reading of
    // the store a later mount stopped writing to.
    authority: WINDOW_AUTO_PIN_AUTHORITY,
  });
  requestSessionDirectoryRead(bridge.growth);
  openSession(sessionId);
}
