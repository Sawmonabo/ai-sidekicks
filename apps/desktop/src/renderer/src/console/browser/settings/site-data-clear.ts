// Closing the pane and then clearing the partition, as one act with an order.
//
// `Spec-023 §Console Design (Meridian)` 13.16 puts "a clear-site-data control per
// partition that closes the pane first" on EVERY partition. A partition whose pane is
// open is therefore the case the control exists for, not the case it withdraws from:
// removing the control there leaves the documented flow with no way to start, and the
// operator with a status chip that describes a state and offers no exit from it.
//
// SO THE ORDER IS THE CONTRACT, AND IT LIVES HERE. Two steps, the second reached only
// when the first succeeded, each answering for itself. Kept out of the page because
// an order is exactly the kind of claim a test should be able to drive without
// rendering anything, and because the page's own job is to project what it is handed.
//
// WHY BOTH STEPS ARE HANDED IN. Neither `browser.closePane` nor a site-data reset is
// registered anywhere in the corpus — the growth port carries five pane-keyed
// navigation verbs, one navigation subscription, and nothing else — so this module
// invents no method string and reaches no registry. It takes the two acts as
// parameters, which is what the page already does for the clear, and what keeps the
// eventual wiring an edit at the composition root rather than here.

import { refuse, type ConsoleRefusal } from "../../core/index.js";

/** The subsystem name the sequence's own refusals carry. */
const SITE_DATA_REFUSAL_ORIGIN = "browser-site-data";

/** What one step answered. A refusal is rendered; it is never swallowed. */
export type SiteDataActOutcome =
  | { readonly status: "done" }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/** One step of the act, as whoever mounts the settings page supplies it. */
export type SiteDataAct = (sessionId: string) => Promise<SiteDataActOutcome>;

/**
 * The two steps, in the order they run. Closed, and named rather than counted,
 * because a refusal has to say WHICH step refused: "the pane would not close" and
 * "the profile directory would not go" are different problems with different fixes.
 */
export const CLEAR_SITE_DATA_STEPS = ["closing-pane", "clearing"] as const;

export type ClearSiteDataStep = (typeof CLEAR_SITE_DATA_STEPS)[number];

/** How the whole act settled. */
export type ClearSiteDataOutcome =
  | { readonly status: "cleared" }
  | {
      readonly status: "refused";
      readonly at: ClearSiteDataStep;
      readonly refusal: ConsoleRefusal;
    };

export interface ClearSiteDataRequest {
  readonly sessionId: string;
  /**
   * Whether a browser pane still holds the partition open — the daemon's reading,
   * carried through unchanged. The sequence never decides this for itself: a
   * renderer that did would be a second source of truth for pane liveness.
   */
  readonly hasOpenPane: boolean;
  /** Absent while no close verb is registered on this build. */
  readonly closePane: SiteDataAct | undefined;
  readonly clearSiteData: SiteDataAct;
  /** Told which step is about to run, so a control can say what it is waiting on. */
  readonly onStep?: ((step: ClearSiteDataStep) => void) | undefined;
}

/**
 * Close the pane if one is open, and clear only once it has closed.
 *
 * Fail-closed at both edges. An open pane with no close act refuses rather than
 * clearing underneath a live pane, and a close that refuses stops the act there —
 * proceeding would delete the profile directory of a pane that is still reading it,
 * which is the outcome 13.16's ordering exists to prevent.
 */
export async function closeThenClearSiteData(
  request: ClearSiteDataRequest,
): Promise<ClearSiteDataOutcome> {
  if (request.hasOpenPane) {
    if (request.closePane === undefined) {
      return {
        status: "refused",
        at: "closing-pane",
        refusal: refuse(
          SITE_DATA_REFUSAL_ORIGIN,
          "pane-close-unregistered",
          "This session's site data can only be cleared once its browser pane is closed, and this build exposes no way to close one from here. Closing the pane in the workspace makes the clear available.",
        ),
      };
    }
    request.onStep?.("closing-pane");
    const closed = await request.closePane(request.sessionId);
    if (closed.status === "refused") {
      return { status: "refused", at: "closing-pane", refusal: closed.refusal };
    }
  }

  request.onStep?.("clearing");
  const cleared = await request.clearSiteData(request.sessionId);
  return cleared.status === "refused"
    ? { status: "refused", at: "clearing", refusal: cleared.refusal }
    : { status: "cleared" };
}
