// Which host carries the view, and the value that stands in for none.
//
// `Spec-023 §Console Design (Meridian)` 12.11: "The one platform-shaped decision is
// the wiring table that picks the host: a scripted host under fixture and end-to-end
// runs, the real view where a window exists, and an **unavailable** host otherwise.
// Unavailable is a value, never a null, so every path that consumes a host gets one
// sentence back instead of a dereference and one missed check cannot become a crash
// inside a tool call. The unavailable host is also what gates the tool set: no host,
// no tools."
//
// The module is separate from `pane-geometry.ts` because it answers a different
// question — WHERE a sample goes, rather than what the sample is — and because the
// dependency has to run one way: this file consumes the sample, and the publisher
// consumes this file's host type.

import type { ConsoleBridge } from "../../bridge/index.js";
import { refuse, type ConsoleRefusal } from "../../core/index.js";
import type { PaneGeometrySample } from "./pane-geometry.js";

/** The subsystem name every refusal this module raises carries. */
export const PANE_VIEW_HOST_REFUSAL_ORIGIN = "browser-view-host";

/**
 * Why the host refused. `host-unavailable` is the wiring table's answer where no view
 * can exist; `pane-gone` is the host saying the pane it was addressing has been
 * destroyed, which makes the publisher unsubscribe rather than retry.
 */
export const PANE_VIEW_HOST_REFUSAL_CODES = ["host-unavailable", "pane-gone"] as const;

export type PaneViewHostRefusalCode = (typeof PANE_VIEW_HOST_REFUSAL_CODES)[number];

/** What a host says back. A rejection ends the subscription; it never retries. */
export type PaneRectOutcome =
  | { readonly status: "accepted" }
  | { readonly status: "rejected"; readonly refusal: ConsoleRefusal };

/** A host that can actually carry a view. */
export interface AttachedPaneViewHost {
  readonly state: "attached";
  /** How the host is reached, for diagnostics — `"scripted"` under the fixture. */
  readonly transport: string;
  setRect(sample: PaneGeometrySample): PaneRectOutcome;
}

/** 12.11's value instead of a null host: one sentence back, never a dereference. */
export interface UnavailablePaneViewHost {
  readonly state: "unavailable";
  readonly refusal: ConsoleRefusal;
}

export type PaneViewHost = AttachedPaneViewHost | UnavailablePaneViewHost;

/** Build the unavailable host, with the sentence a surface renders. */
export function unavailablePaneViewHost(detail: string): UnavailablePaneViewHost {
  const code: PaneViewHostRefusalCode = "host-unavailable";
  return { state: "unavailable", refusal: refuse(PANE_VIEW_HOST_REFUSAL_ORIGIN, code, detail) };
}

/** The sentence a window with no view host renders under its empty viewport. */
const NO_HOST_IN_THIS_WINDOW =
  "No view host is wired in this window, so the pane reports its rectangle to nothing and shows no page.";

/**
 * 12.11's wiring table — "a scripted host under fixture and end-to-end runs, the real
 * view where a window exists, and an unavailable host otherwise". It selects on what
 * it was HANDED and never on a platform check, because 12.11's point is that the pane
 * exists in one shape everywhere. The real-view arm is deliberately absent: this task
 * mints no main-process host.
 *
 * WHAT IT IS HANDED IS THE BRIDGE, and that is the correction. It took an options bag
 * carrying an optional scripted host, and the only caller that ever filled one in was
 * a test: the pane called it with `{}`, so under the fixture and the end-to-end runs
 * the table could only ever reach its unavailable arm and every geometry publish was
 * suppressed. The bridge is what a pane already holds and what already knows which
 * window it is — the fixture publishes a scripted host, the live bridge publishes
 * none — so the table now selects on a value no caller can forget to supply.
 *
 * The pane id is bound HERE rather than travelled on the sample, because the host is
 * addressed per pane and a publisher holds exactly one: binding it once at resolution
 * is what makes a stale publisher's writes impossible rather than merely unlikely.
 */
export function resolvePaneViewHost(options: {
  readonly bridge: ConsoleBridge;
  readonly paneId: string;
}): PaneViewHost {
  const script = options.bridge.paneViewHostScript;
  if (script === undefined) {
    return unavailablePaneViewHost(NO_HOST_IN_THIS_WINDOW);
  }
  const paneId = options.paneId;
  return {
    state: "attached",
    transport: script.transport,
    // The sample never crosses into the bridge. What the host below decides is
    // whether the pane is still addressable; the rectangle, the sample's shape, and
    // the refusal code are this module's, which is why the seam costs no second
    // declaration of any of them.
    setRect: (_sample: PaneGeometrySample) => {
      const holding = script.holdsPane(paneId);
      const code: PaneViewHostRefusalCode = "pane-gone";
      return holding.holds
        ? { status: "accepted" }
        : {
            status: "rejected",
            refusal: refuse(PANE_VIEW_HOST_REFUSAL_ORIGIN, code, holding.detail),
          };
    },
  };
}
