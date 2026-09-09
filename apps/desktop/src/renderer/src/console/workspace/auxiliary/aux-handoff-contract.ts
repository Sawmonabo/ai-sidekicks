// What a hand-off IS: its vocabulary, its value shapes, and its route grammar.
//
// SPLIT FROM THE CLASS THAT PERFORMS ONE, because the two answer different questions.
// `aux-handoff.ts` owns the STATE of a surface's hand-offs — what is detached right
// now, what crashed, which subscription is open. This file owns what those values
// look like and what a request has to satisfy to become a window route at all, and
// it holds no state and reaches no wire, so every rule in it can be checked without
// constructing a hand-off.
//
// Three of the four gates a detach passes are run HERE, by {@link admitDetachTarget},
// because all three are decided by values rather than by state. The fourth is the wire
// answering, which is `aux-handoff.ts`' to ask for.

import type { AuxiliaryWindowDetachRequest } from "@ai-sidekicks/contracts";

import { normalizeWireRejection, refuse, type NarrowedRefusal } from "../../core/index.js";
import type { AuxiliaryWindowOutcome, AuxiliaryWindowRefusal } from "../../bridge/index.js";
import {
  AUXILIARY_ROUTE_LABELS,
  InvalidAuxiliaryRouteTargetError,
  formatAuxiliaryFragment,
  isAuxiliaryRouteName,
  type AuxiliaryRouteName,
} from "../../routing/index.js";
import { type PaneKind } from "../../seats/index.js";

/**
 * Why a hand-off was refused, or how one ended badly. Closed; a ninth is a decision.
 *
 * `shell-absent` is the eighth and is a fact about the BUILD rather than about the
 * act: a renderer with no Electron main process underneath — browser-mode vitest, a
 * window whose preload never ran — has nothing that can open a window, and no retry
 * changes that. It is deliberately not folded into `wire-unregistered`, which now
 * says something false: `SidekicksBridge.window` IS registered and the shell serves
 * it, so a person told the wire is missing would go looking for a wire that is there.
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
  "shell-absent",
  "signal-ended",
  "target-context-invalid",
  "wire-rejected",
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
 * A plane answer that could not be served, in this subsystem's vocabulary.
 *
 * TWO CODES AND NOT ONE, because the port already knows which happened and throwing
 * that away would put "this build has no shell at all" and "the shell answered with a
 * fault" behind one word. The first is a fact about the build a person can do nothing
 * about; the second is a failure that may not happen again on the next press. The
 * sentence is the port's own either way — it names what went wrong, which is more
 * than this subsystem knows.
 */
export function refuseHandoffFromShell(refusal: AuxiliaryWindowRefusal): AuxiliaryHandoffRefusal {
  return refuseHandoff(
    refusal.code === "shell-absent" ? "shell-absent" : "wire-rejected",
    refusal.detail,
  );
}

/**
 * An act that rejected outright, in the same vocabulary — never a silent no-op.
 *
 * The backstop for a caller dispatching one of these acts from an effect or an event
 * handler. Every wire call inside them settles into an answer rather than rejecting,
 * so reaching this is a defect rather than a wire fault — and a defect that reaches a
 * person as a stated refusal is strictly better than one that reaches nobody at all,
 * which is what a bare `void` promise does with it.
 */
export function refuseHandoffFromRejection(rejection: unknown): AuxiliaryHandoffRefusal {
  return refuseHandoff(
    "wire-rejected",
    normalizeWireRejection(AUXILIARY_HANDOFF_REFUSAL_ORIGIN, rejection).detail,
  );
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

/**
 * How one window stopped being open.
 *
 * A CLOSED PAIR RATHER THAN A REASON THAT MAY BE ABSENT, because the two are opposite
 * facts about the person's own act: a lost window is a fault to be noted in the pane's
 * error slot, and a returned one is somebody closing a window they opened. A single
 * shape with an optional reason would let a missing string decide which of the two a
 * reader was looking at.
 */
export type AuxiliaryWindowEnding =
  | { readonly ending: "lost"; readonly reason: string }
  | { readonly ending: "returned" };

/**
 * What a detach attempt did. A refusal is a value, not an exception.
 *
 * THREE ARMS AND NOT TWO, because a window can end between the shell creating it and
 * the reply reaching this process. The act neither failed — a window really was opened
 * — nor left a pane in a window, and reporting either would be false: the third arm is
 * the settlement of a hand-off whose window was already gone, and the pane is in the
 * deck with whatever the ending said about it recorded beside it.
 */
export type AuxiliaryHandoffOutcome =
  | { readonly outcome: "detached"; readonly detached: DetachedPane }
  | { readonly outcome: "window-ended"; readonly ending: AuxiliaryWindowEnding }
  | { readonly outcome: "refused"; readonly refusal: AuxiliaryHandoffRefusal };

/**
 * Everything a hand-off publishes, in one value held by identity across a change.
 *
 * A SNAPSHOT RATHER THAN FOUR READS, because the surface follows a hand-off through
 * `useSyncExternalStore`, which compares what a getter returns by identity: four
 * getters composed into an object per read would hand it a new value every time it
 * asked and loop the render it exists to settle. The two refusals travel SEPARATELY
 * rather than pre-picked — which of them a one-line slot renders is the surface's
 * decision, and it is stated where that line is rendered.
 */
export interface AuxiliaryHandoffSnapshot {
  readonly detached: readonly DetachedPane[];
  readonly lostWindows: readonly LostAuxiliaryWindow[];
  readonly paneErrorRefusal: AuxiliaryHandoffRefusal | undefined;
  readonly paneReturnRefusal: AuxiliaryHandoffRefusal | undefined;
}

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

/**
 * One plane call, in this subsystem's own two arms — and never a rejection.
 *
 * THE PLANE IS ALREADY TOTAL, so reaching the catch is a defect rather than a wire
 * fault. It is still here because the three acts that call it are dispatched from event
 * handlers, where a rejection reaches nobody: the press changes nothing, says nothing,
 * and the fault surfaces only as an unhandled rejection a shipped window does not
 * report. A defect a person sees stated is strictly better than one recorded nowhere.
 *
 * The refusal is built here rather than returned raw, so both callers read one arm:
 * a shell answer and a shell defect land in the same shape and neither caller has to
 * know which happened.
 */
export async function settledPlaneCall<TValue>(
  call: () => Promise<AuxiliaryWindowOutcome<TValue>>,
): Promise<
  | { readonly status: "served"; readonly value: TValue }
  | { readonly status: "unavailable"; readonly refusal: AuxiliaryHandoffRefusal }
> {
  try {
    const answer = await call();
    return answer.status === "served"
      ? { status: "served", value: answer.value }
      : { status: "unavailable", refusal: refuseHandoffFromShell(answer) };
  } catch (rejection: unknown) {
    return { status: "unavailable", refusal: refuseHandoffFromRejection(rejection) };
  }
}

/**
 * The three gates a detach passes before a window is asked for, in order.
 *
 * EACH ONE REFUSES LOCALLY, and that ordering is the point: asking the shell first and
 * refusing on its answer would mean a window flashes open for a route this build
 * cannot render.
 *
 *   1. **The kind must be an auxiliary route.** `src/shared/auxiliary-routes.ts` closes
 *      that set at two; a pane kind outside it has no window route to load.
 *   2. **The route must be implemented in THIS build.** A build-time fact, passed in
 *      rather than read here, so a caller can move it without owning a second copy of
 *      the rule: opening a hardened window onto a hash route with nothing behind it is
 *      the capability-claimed-but-not-built shape that module exists to prevent.
 *   3. **The target must satisfy the route's context grammar.** Built through
 *      `formatAuxiliaryFragment`, the PRODUCER half of the grammar the auxiliary
 *      renderer parses; composing a fragment by hand is the drift it forbids.
 *
 * The route comes back BOUND TO ITS OWN NAME rather than left on the request, because
 * the narrowing gate 1 makes does not survive a property read into a closure: the
 * checker re-widens `request.kind` inside a function expression, and the plane call
 * would then be composing a request against the whole pane-kind set.
 */
export function admitDetachTarget(
  request: AuxiliaryHandoffRequest,
  implementedRoutes: readonly AuxiliaryRouteName[],
):
  | { readonly route: AuxiliaryRouteName; readonly fragment: string }
  | { readonly refusal: AuxiliaryHandoffRefusal } {
  if (!isAuxiliaryRouteName(request.kind)) {
    return {
      refusal: refuseHandoff(
        "kind-not-detachable",
        "Only a timeline and an agent console can move into a window of their own.",
      ),
    };
  }
  const route: AuxiliaryRouteName = request.kind;
  if (!implementedRoutes.includes(route)) {
    return {
      refusal: refuseHandoff(
        "route-not-implemented",
        `This build cannot open a ${AUXILIARY_ROUTE_LABELS[route].toLowerCase()} in its own window yet.`,
      ),
    };
  }
  const fragment = formatAuxiliaryTargetOrRefuse(auxiliaryTarget(route, request));
  return typeof fragment === "string" ? { route, fragment } : fragment;
}

/**
 * One detach request, as the shell takes it.
 *
 * The optional context members are set conditionally rather than passed as
 * `undefined`, because `exactOptionalPropertyTypes` distinguishes an absent member
 * from a present one holding `undefined`, and the shell's own launch grammar reads
 * absence as "this route was asked for bare". Passing the member explicitly undefined
 * would make a bare timeline unrepresentable on the wire.
 *
 * Here rather than on the class for this file's own reason: it reads nothing a
 * hand-off holds, so it can be checked without constructing one — and a method
 * would invite a later edit to reach for the detached set while composing a
 * request that has not been admitted yet.
 */
export function detachRequestFor(
  request: AuxiliaryHandoffRequest,
  route: AuxiliaryRouteName,
): AuxiliaryWindowDetachRequest {
  return {
    paneId: request.paneId,
    route,
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
  };
}
