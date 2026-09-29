// The pane layouts mounted in this window, and the one a palette act reaches: the newest.

import { refuse, type Refusal } from "@renderer/lib/refusal.js";
import type { PaneLayoutActName, PaneLayoutActs } from "./pane-layout-acts.js";

/**
 * What an act says when no pane layout is mounted in this window.
 *
 * One value rather than one per act: a person pressing a pane layout row from the settings
 * page needs to know the pane layout is not here, and naming which of the five they reached
 * for would answer a question they did not ask.
 */
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
 * The mounted pane layouts, in mount order.
 *
 * A class rather than a module-level array, and release is by IDENTITY rather than by
 * position: a StrictMode double mount and a route change must not leave the list
 * holding a pane layout that is gone. The newest mount is the one a command acts on.
 */
export class MountedPaneLayouts {
  readonly #mounted: PaneLayoutActs[] = [];

  public adopt(acts: PaneLayoutActs): () => void {
    this.#mounted.push(acts);
    return () => {
      const position = this.#mounted.lastIndexOf(acts);
      if (position >= 0) {
        this.#mounted.splice(position, 1);
      }
    };
  }

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
