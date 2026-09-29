// Types the Preview pane's modules share.
//
// The navigation reading is what the pane KNOWS about the page, as opposed to what it
// draws: the chrome never derives navigability, so the pane's content takes the reading
// as a prop and holds no second copy of its shape.

import type { PreviewPage } from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
import type { ReadingState } from "@renderer/console/primitives/index.js";

/**
 * What the pane knows about the page right now.
 *
 * `ended` is a fact and not the absence of one: a subscription that finished cleanly
 * is neither a reading nor a refusal, and a pane holding the last state it was sent
 * would present an address, a title and two history depths as current while nothing reports
 * them. It carries no last state for that reason.
 */
export type NavigationReading =
  /** No answer has come back yet, which is not the same as "no page". */
  | Extract<ReadingState, { readonly kind: "reading" }>
  | (Extract<ReadingState, { readonly kind: "served" }> & {
      readonly state: PreviewPage;
    })
  /** The producer finished. The pane was being told, and is not being told now. */
  | { readonly kind: "ended" };

/**
 * The pair a pane-scoped resource belongs to.
 *
 * Both members, because both decide where an act goes: every pane-keyed call is made
 * on ONE bridge with ONE `paneId`, so a publisher produced under either of the other
 * combinations is not a publisher for this one. The holder also keys on the view host
 * the publisher writes to. It is the argument the geometry binding is opened with rather
 * than a stamp anything compares — the console's subject-scoped holder addresses a
 * resource by its subject during the render that first sees a new one, so there is
 * nothing left here to compare.
 */
export interface PaneSubject {
  readonly bridge: ConsoleBridge;
  readonly paneId: string;
}
