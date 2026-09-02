// What every ledger card is handed.
//
// `TimelineRowSlotProps` is the seat's contract — the row plus the three decisions the
// LIST makes about it (hue, supersession, density). A card needs those and two more
// things the seat cannot carry, because neither is a property of the row's position in
// a list: the hydrated body, and the footnote registry the message it belongs to shares.
//
// EXTENDING THE SEAT RATHER THAN RESTATING IT is the point. A member added to
// `TimelineRowSlotProps` reaches both cards without either one being edited, and no card
// can quietly disagree with the seat about what a row is.

import type { HydratedSessionEventContent } from "@ai-sidekicks/contracts";

import type { TimelineRowSlotProps } from "../../workspace/index.js";
import type { FootnoteRegistry } from "./markdown/index.js";

export interface LedgerCardProps extends TimelineRowSlotProps {
  /**
   * The row's machine-authored body, as the read projection reports it.
   *
   * Optional because asking for a body is a separate act from projecting a row: a
   * collapsed tool row a reader never opens costs no decryption, and `undefined` says
   * "not asked" rather than "not there". `MachineBody` renders all three states.
   */
  readonly content?: HydratedSessionEventContent | undefined;
  /**
   * Text the reveal engine is publishing for this row right now, while it streams.
   *
   * A PROP rather than a subscription: `ledger/frame/reveal-engine.ts` publishes per
   * lane and the viewport is what reads it, so a card that subscribed would be a second
   * subscriber to one fact and would re-render on frames its own text did not change in.
   */
  readonly liveText?: string | undefined;
  /** Where this message's footnote definitions are registered. */
  readonly footnotes: FootnoteRegistry;
}
