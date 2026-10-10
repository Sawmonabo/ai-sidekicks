// The props every transcript card is handed: the row renderer's contract plus the live text and
// the footnote registry the message shares, less whether a call's output was opened, which only
// the tool card reads, as its output's opening. A card's stored body is its row's own `content`.
// Extending that contract means a member added to it reaches every card.

import { type PublishedText } from "../reveal/published-text.js";
import type { TranscriptRowProps } from "./renderer.js";
import type { FootnoteRegistry } from "./markdown/footnotes/registry.js";

/** What one transcript card is drawn from. */
export interface TranscriptCardProps extends Omit<TranscriptRowProps, "isOutputOpened"> {
  /**
   * Text the reveal engine is publishing for this row while it streams, as the lane's stable
   * handle; a card memoizes on its `revision`. A prop rather than a subscription: the row
   * renderer is what reads the engine, so a card that subscribed would be a second subscriber to
   * one fact.
   */
  readonly liveText?: PublishedText | undefined;
  /** Where this message's footnote definitions are registered. */
  readonly footnotes: FootnoteRegistry;
  /**
   * Hold this row where it stands while a press inside the body changes its height, called before
   * the change; absent where the card is drawn outside a transcript's list.
   */
  readonly holdRowInPlace?: (() => void) | undefined;
}
