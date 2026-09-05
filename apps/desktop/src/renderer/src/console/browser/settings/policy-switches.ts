// The two node-wide browser switches, as the console names them.
//
// Held apart from the page and the row that render them because both take the same
// three shapes, and a shape exported by one and imported by the other would close a
// cycle between siblings that only ever read it.
//
// CLOSED AT TWO. `Spec-023 §Console Design (Meridian)` 13.16 — "Hold the two node-wide
// switches the browser pane's policy reads, and nothing else about the browser" — and
// the union is DERIVED from the tuple, so a third cannot be added to one without the
// other.

import type { ReadingState } from "../../primitives/index.js";

/** The two switches, as console-local ids. */
export const BROWSER_POLICY_SWITCHES = ["file-boundary", "page-tools"] as const;

export type BrowserPolicySwitchId = (typeof BROWSER_POLICY_SWITCHES)[number];

/**
 * What the node reported about one switch, or why it did not.
 *
 * Two arms rather than `boolean | undefined`: an absent reading has a REASON, and a
 * row that could not render the reason would be back to showing a bare off position
 * for a question nobody put.
 *
 * Both arms are `ReadingState`'s, with this family's payload on the served one, so the
 * words for "answered" and "refused" are the console's rather than a third spelling of
 * them beside `site-partitions.ts`'s and `navigation-state.ts`'s.
 */
export type BrowserPolicySwitchReading =
  | (Extract<ReadingState, { readonly kind: "served" }> & { readonly enabled: boolean })
  | Extract<ReadingState, { readonly kind: "refused" }>;

/**
 * Flip one switch. Absent while no writer is registered, in which case the rows
 * render read-only and say so, rather than offering a control whose press goes
 * nowhere.
 */
export type BrowserPolicySwitchWriter = (
  switchId: BrowserPolicySwitchId,
  nextEnabled: boolean,
) => void;
