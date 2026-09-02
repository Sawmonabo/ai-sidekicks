// Moving a pane into a window of its own, and bringing it back.
//
// `Spec-023 §Console Design (Meridian)` §4.5 — "Move a `timeline` or
// `agent-console` pane into its own hardened `BrowserWindow` and bring it back …
// The aux window loads the same renderer bundle at a window route, carries its own
// preload and its own bridge instance, and subscribes to the daemon itself; it
// shares no in-memory store with the main window."
//
// FOUR GATES, IN THIS ORDER, AND EACH ONE REFUSES LOCALLY BEFORE ASKING FOR A
// WINDOW. Asking first and refusing on the answer would mean a window flashes open
// for a route this build cannot render:
//
//   1. **The kind must be an auxiliary route.** `src/shared/auxiliary-routes.ts`
//      closes that set at two; a pane kind outside it has no window route to load.
//   2. **The route must be implemented in THIS build.** `IMPLEMENTED_AUXILIARY_ROUTES`
//      is a build-time fact, and opening a hardened window onto a hash route with
//      nothing behind it is the capability-claimed-but-not-built shape that module
//      exists to prevent.
//   3. **The target must satisfy the route's context grammar.** Built through
//      `formatAuxiliaryFragment`, which is the PRODUCER half of the grammar the
//      auxiliary renderer parses. Composing a fragment by hand here is exactly the
//      drift that module is written to make impossible.
//   4. **The wire must exist.** It does not: `window.detachPane` is on
//      `Plan-023 §Console growth slate` and reaches the console only through the
//      growth port, which refuses by name. That refusal is rendered, not swallowed.
//
// WHAT THE MAIN WINDOW KEEPS. The pane's SLOT, as a placeholder with a focus
// control, and no projection: §4.5's "never keeps a duplicate projection alive in
// the main window while the aux window shows it" is why `detached` records an id
// and a window handle rather than a copy of anything.

import { Emitter, refuse, type ConsoleRefusal, type Unsubscribe } from "../core/index.js";
import { type ConsoleBridge } from "../bridge/index.js";
import {
  AUXILIARY_ROUTE_LABELS,
  IMPLEMENTED_AUXILIARY_ROUTES,
  InvalidAuxiliaryRouteTargetError,
  formatAuxiliaryFragment,
  isAuxiliaryRouteName,
  type AuxiliaryRouteName,
} from "../../../../shared/auxiliary-routes.js";
import { type PaneKind } from "./seats/index.js";

/** Why a hand-off was refused. Closed, so a fifth cause is a decision. */
export const AUXILIARY_HANDOFF_REFUSAL_CODES = [
  "kind-not-detachable",
  "route-not-implemented",
  "target-context-invalid",
  "wire-unregistered",
] as const;

/** One hand-off refusal code. Derived, so the vocabulary is declared once. */
export type AuxiliaryHandoffRefusalCode = (typeof AUXILIARY_HANDOFF_REFUSAL_CODES)[number];

/** The subsystem name every refusal this module raises carries. */
export const AUXILIARY_HANDOFF_REFUSAL_ORIGIN = "aux-handoff";

/** A typed hand-off refusal — `core`'s one refusal shape, narrowed on `code`. */
export interface AuxiliaryHandoffRefusal extends ConsoleRefusal {
  readonly code: AuxiliaryHandoffRefusalCode;
}

function refuseHandoff(code: AuxiliaryHandoffRefusalCode, detail: string): AuxiliaryHandoffRefusal {
  return { ...refuse(AUXILIARY_HANDOFF_REFUSAL_ORIGIN, code, detail), code };
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
 * The growth port, reached as the bridge's own member rather than by importing the
 * port type.
 *
 * `bridge/index.ts` exports the bridge and not the port, deliberately — the port is
 * reached THROUGH a bridge and never held on its own — so this alias takes the type
 * off the door that is open rather than asking for a second one.
 */
type ConsoleGrowthPort = ConsoleBridge["growth"];

export class AuxiliaryHandoff {
  readonly #growth: ConsoleGrowthPort;
  readonly #detachedByPaneId = new Map<string, DetachedPane>();
  readonly #changes = new Emitter<readonly DetachedPane[]>("auxiliary hand-off change");

  public constructor(options: { readonly growth: ConsoleGrowthPort }) {
    this.#growth = options.growth;
  }

  /** Every pane currently shown in a window, in detach order. */
  public detached(): readonly DetachedPane[] {
    return [...this.#detachedByPaneId.values()];
  }

  public detachedPane(paneId: string): DetachedPane | undefined {
    return this.#detachedByPaneId.get(paneId);
  }

  public subscribe(listener: (detached: readonly DetachedPane[]) => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /**
   * Whether this build could detach a pane of `kind` at all.
   *
   * Gates 1 and 2, without gate 3 or 4: a caller renders an open-in-window control
   * from this and would otherwise have to attempt a detach to find out whether to
   * draw one. Gates 3 and 4 depend on the target and on the daemon, and both are
   * answered at the moment of the act.
   */
  public canDetach(kind: PaneKind): boolean {
    return isAuxiliaryRouteName(kind) && IMPLEMENTED_AUXILIARY_ROUTES.includes(kind);
  }

  /** The label the control uses, or `undefined` where the kind is not detachable. */
  public routeLabel(kind: PaneKind): string | undefined {
    return isAuxiliaryRouteName(kind) ? AUXILIARY_ROUTE_LABELS[kind] : undefined;
  }

  /** Run all four gates and, if they pass, ask for the window. */
  public async detach(request: AuxiliaryHandoffRequest): Promise<AuxiliaryHandoffOutcome> {
    if (!isAuxiliaryRouteName(request.kind)) {
      return {
        outcome: "refused",
        refusal: refuseHandoff(
          "kind-not-detachable",
          "Only a timeline and an agent console can move into a window of their own.",
        ),
      };
    }
    if (!IMPLEMENTED_AUXILIARY_ROUTES.includes(request.kind)) {
      return {
        outcome: "refused",
        refusal: refuseHandoff(
          "route-not-implemented",
          `This build cannot open a ${AUXILIARY_ROUTE_LABELS[request.kind].toLowerCase()} in its own window yet.`,
        ),
      };
    }

    let fragment: string;
    try {
      fragment = formatAuxiliaryFragment(auxiliaryTarget(request.kind, request));
    } catch (error) {
      if (!(error instanceof InvalidAuxiliaryRouteTargetError)) {
        throw error;
      }
      // The route's own grammar refused. Never echo the offending value: an id that
      // failed a shape check is untrusted input, which is that module's own rule.
      return {
        outcome: "refused",
        refusal: refuseHandoff(
          "target-context-invalid",
          "This pane does not name enough of a session to open in a window of its own.",
        ),
      };
    }

    const answer = await this.#growth.windowDetachPane({ paneId: request.paneId });
    if (answer.status === "unavailable") {
      return { outcome: "refused", refusal: refuseHandoff("wire-unregistered", answer.detail) };
    }

    const detached: DetachedPane = {
      paneId: request.paneId,
      route: request.kind,
      windowId: answer.value.windowId,
      fragment,
      lostReason: undefined,
    };
    this.#detachedByPaneId.set(request.paneId, detached);
    this.#publish();
    return { outcome: "detached", detached };
  }

  /** Bring the window to the front. The placeholder's one control. */
  public async focus(paneId: string): Promise<AuxiliaryHandoffRefusal | undefined> {
    const detached = this.#detachedByPaneId.get(paneId);
    if (detached === undefined) {
      return undefined;
    }
    const answer = await this.#growth.windowFocusAuxiliary({ windowId: detached.windowId });
    return answer.status === "unavailable"
      ? refuseHandoff("wire-unregistered", answer.detail)
      : undefined;
  }

  /**
   * Return the pane to the deck, closing its window.
   *
   * The local record is dropped whether or not the close succeeded. A window this
   * process can no longer reach is a window whose pane must come back — leaving the
   * placeholder up would strand the pane in a window nobody can focus, which is
   * strictly worse than one stray window.
   */
  public async returnToDeck(paneId: string): Promise<AuxiliaryHandoffRefusal | undefined> {
    const detached = this.#detachedByPaneId.get(paneId);
    if (detached === undefined) {
      return undefined;
    }
    this.#detachedByPaneId.delete(paneId);
    this.#publish();
    const answer = await this.#growth.windowCloseAuxiliary({ windowId: detached.windowId });
    return answer.status === "unavailable"
      ? refuseHandoff("wire-unregistered", answer.detail)
      : undefined;
  }

  /**
   * Record that a window was lost rather than closed.
   *
   * The pane returns to the deck — §4.5's "a crashed aux window returns the pane to
   * the deck" — and the reason is kept for the pane's error slot, because a pane
   * that silently reappears tells the person nothing about why.
   */
  public noteWindowLost(paneId: string, reason: string): DetachedPane | undefined {
    const detached = this.#detachedByPaneId.get(paneId);
    if (detached === undefined) {
      return undefined;
    }
    this.#detachedByPaneId.delete(paneId);
    this.#publish();
    return { ...detached, lostReason: reason };
  }

  #publish(): void {
    this.#changes.emit(this.detached());
  }
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
function auxiliaryTarget(
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
