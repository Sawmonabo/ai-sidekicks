// The pane layouts mounted in every window, and the one a palette act reaches: the newest in the
// window the act runs in.

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
  readonly #mounted: MountedPaneLayout[] = [];

  /**
   * Registers a layout's acts in the window `ownerDocument` belongs to, and returns the function
   * that releases them.
   */
  public adopt(acts: PaneLayoutActs, ownerDocument: Document): () => void {
    const mounted: MountedPaneLayout = { acts, ownerDocument };
    this.#mounted.push(mounted);
    return () => {
      const position = this.#mounted.lastIndexOf(mounted);
      if (position >= 0) {
        this.#mounted.splice(position, 1);
      }
    };
  }

  /**
   * Runs `act` on the newest layout mounted in the window `windowDocument` belongs to, or refuses
   * when that window has none. A layout in another window never takes the act.
   */
  public perform(
    act: PaneLayoutActName,
    windowDocument: Document | undefined,
  ): PaneLayoutActOutcome {
    const newest = this.#mounted.findLast((each) => each.ownerDocument === windowDocument);
    if (newest === undefined) {
      return { status: "refused", refusal: PANE_LAYOUT_NOT_MOUNTED_REFUSAL };
    }
    newest.acts[act]();
    return { status: "performed", act };
  }
}

/** One mounted layout's acts and the document of the window it is drawn in. */
interface MountedPaneLayout {
  readonly acts: PaneLayoutActs;
  readonly ownerDocument: Document;
}

/** Every window's mounted pane layouts. */
export const mountedPaneLayouts: MountedPaneLayouts = new MountedPaneLayouts();
