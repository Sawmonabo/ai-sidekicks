// The pane layouts mounted in this window, and the one a palette act reaches: the newest.

import { refuse, type Refusal } from "@renderer/lib/refusal.js";
import type { PaneLayoutActName, PaneLayoutActs } from "./pane-layout-acts.js";

/** What an act says when no pane layout is mounted in this window; one refusal for all acts. */
export const PANE_LAYOUT_NOT_MOUNTED_REFUSAL: Refusal = refuse(
  "pane-layout",
  "pane-layout.not_mounted",
  "No panes are open in this window. Open a session and try again.",
);

/** What asking the mounted pane layout to perform an act produced. */
export type PaneLayoutActOutcome =
  | { readonly status: "performed"; readonly act: PaneLayoutActName }
  | { readonly status: "refused"; readonly refusal: Refusal };

/**
 * The mounted pane layouts, in mount order; the newest is the one a command acts on.
 *
 * Release is by identity rather than position, so a StrictMode double mount or a route change
 * never leaves a gone layout in the list.
 */
export class MountedPaneLayouts {
  readonly #mounted: PaneLayoutActs[] = [];

  /** Registers a layout's acts and returns the function that releases them. */
  public adopt(acts: PaneLayoutActs): () => void {
    this.#mounted.push(acts);
    return () => {
      const position = this.#mounted.lastIndexOf(acts);
      if (position >= 0) {
        this.#mounted.splice(position, 1);
      }
    };
  }

  /** Runs `act` on the newest mounted layout, or refuses when none is mounted. */
  public perform(act: PaneLayoutActName): PaneLayoutActOutcome {
    const newest = this.#mounted.at(-1);
    if (newest === undefined) {
      return { status: "refused", refusal: PANE_LAYOUT_NOT_MOUNTED_REFUSAL };
    }
    newest[act]();
    return { status: "performed", act };
  }
}

/** This window's mounted pane layouts. Module scope is window scope. */
export const mountedPaneLayouts: MountedPaneLayouts = new MountedPaneLayouts();
