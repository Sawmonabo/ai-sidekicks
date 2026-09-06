// What a hand-off IS: its vocabulary, its value shapes, and its route grammar.
//
// SPLIT FROM THE CLASS THAT PERFORMS ONE, because the two answer different questions.
// `aux-handoff.ts` owns the STATE of a surface's hand-offs — what is detached right
// now, what crashed, which subscription is open. This file owns what those values
// look like and what a request has to satisfy to become a window route at all, and
// it holds no state and reaches no wire, so every rule in it can be checked without
// constructing a hand-off.
//
// The four gates `aux-handoff.ts` runs are stated there, in the order it runs them.
// Gates 1 and 3 are decided by this file's own imports and by {@link auxiliaryTarget};
// gates 2 and 4 are facts about the build and about the wire, which this file has no
// way to know.

import { refuse, type NarrowedRefusal } from "../../core/index.js";
import {
  InvalidAuxiliaryRouteTargetError,
  formatAuxiliaryFragment,
  type AuxiliaryRouteName,
} from "../../routing/index.js";
import { type PaneKind } from "../../seats/index.js";

/**
 * Why a hand-off was refused, or how one ended badly. Closed; a seventh is a decision.
 *
 * Two members are not an act being refused: nothing was asked for and nothing was
 * denied. `window-lost` is a window that was open and stopped being open, and
 * `signal-ended` is the subscription that would have reported such a window ending
 * of its own accord while panes are still in windows — the producer closed the
 * stream, so no crash will be reported again and the placeholder has to say so.
 * Both are in this vocabulary rather than beside it because the console has exactly
 * one shape for "here is a code and the sentence that came with it", and a second
 * vocabulary for the odd member would be a second answer to which strings this
 * subsystem may put on a screen.
 */
export const AUXILIARY_HANDOFF_REFUSAL_CODES = [
  "kind-not-detachable",
  "route-not-implemented",
  "signal-ended",
  "target-context-invalid",
  "wire-unregistered",
  "window-lost",
] as const;

/** One hand-off refusal code. Derived, so the vocabulary is declared once. */
export type AuxiliaryHandoffRefusalCode = (typeof AUXILIARY_HANDOFF_REFUSAL_CODES)[number];

/** The subsystem name every refusal this module raises carries. */
export const AUXILIARY_HANDOFF_REFUSAL_ORIGIN = "aux-handoff";

/** A typed hand-off refusal — `core`'s one refusal shape, narrowed on `code`. */
export type AuxiliaryHandoffRefusal = NarrowedRefusal<AuxiliaryHandoffRefusalCode>;

export function refuseHandoff(
  code: AuxiliaryHandoffRefusalCode,
  detail: string,
): AuxiliaryHandoffRefusal {
  return refuse(AUXILIARY_HANDOFF_REFUSAL_ORIGIN, code, detail);
}

/**
 * Build the fragment a target loads, or the refusal its own grammar raised.
 *
 * The `try` lives HERE, beside the producer half of the grammar, rather than in the
 * class: the only exception this call can raise is that module's own refusal, and a
 * caller catching it would be a second reading of what a bad target means. The
 * offending value is never echoed — an id that failed a shape check is untrusted
 * input, which is that module's own rule.
 */
export function formatAuxiliaryTargetOrRefuse(
  target: Parameters<typeof formatAuxiliaryFragment>[0],
): string | { readonly refusal: AuxiliaryHandoffRefusal } {
  try {
    return formatAuxiliaryFragment(target);
  } catch (error) {
    if (!(error instanceof InvalidAuxiliaryRouteTargetError)) {
      throw error;
    }
    return {
      refusal: refuseHandoff(
        "target-context-invalid",
        "This pane does not name enough of a session to open in a window of its own.",
      ),
    };
  }
}

/** One pane currently shown in a window of its own. */
export interface DetachedPane {
  readonly paneId: string;
  readonly route: AuxiliaryRouteName;
  readonly windowId: string;
  /** The fragment that window loaded, produced by the shared route grammar. */
  readonly fragment: string;
  /** Set when the window was lost rather than closed — rendered in the error slot. */
  readonly lostReason: string | undefined;
}

/**
 * A window that stopped being open, kept for the slot its pane went back to.
 *
 * `lostReason` is not optional here, unlike on {@link DetachedPane}: this record
 * exists only because a window was lost, so a member that could be absent would be
 * a record that could claim nothing happened.
 */
export interface LostAuxiliaryWindow extends DetachedPane {
  readonly lostReason: string;
}

/** What a detach attempt did. A refusal is a value, not an exception. */
export type AuxiliaryHandoffOutcome =
  | { readonly outcome: "detached"; readonly detached: DetachedPane }
  | { readonly outcome: "refused"; readonly refusal: AuxiliaryHandoffRefusal };

/** Where a pane is detached to. Route-shaped, so an incoherent target cannot be built. */
export interface AuxiliaryHandoffRequest {
  readonly paneId: string;
  readonly kind: PaneKind;
  readonly sessionId: string | undefined;
  /** Required by the `agent-console` route's grammar, and forbidden by `timeline`'s. */
  readonly agentId?: string;
}

/**
 * A lost window as the slot renders it.
 *
 * Producer and consumer share this function rather than the component spelling the
 * code: which string names this condition is the hand-off's to decide, and a second
 * author of it is how a code on a screen stops matching the code in the module that
 * raised it. The reason is the signal's own sentence, carried verbatim.
 */
export function lostWindowNotice(lost: LostAuxiliaryWindow): AuxiliaryHandoffRefusal {
  return refuseHandoff("window-lost", lost.lostReason);
}

/**
 * The route-discriminated target for a request.
 *
 * A switch rather than a spread, for `parseAuxiliaryFragment`'s own reason:
 * building a member of a discriminated union is the one step that genuinely needs
 * per-route code, and the `never` fall-through makes a third route a compile error
 * here rather than a silently unhandled arm. An absent context member produces the
 * BARE arm, which the grammar then refuses or admits on its own terms — this
 * function never decides that.
 */
export function auxiliaryTarget(
  route: AuxiliaryRouteName,
  request: AuxiliaryHandoffRequest,
): Parameters<typeof formatAuxiliaryFragment>[0] {
  switch (route) {
    case "timeline":
      return request.sessionId === undefined ? { route } : { route, sessionId: request.sessionId };
    case "agent-console":
      return request.sessionId === undefined || request.agentId === undefined
        ? { route }
        : { route, sessionId: request.sessionId, agentId: request.agentId };
    default: {
      const unhandled: never = route;
      return unhandled;
    }
  }
}
