// The props every transcript card is handed: the row renderer's contract plus the hydrated body
// and the footnote registry the message shares. Extending that contract means a member added
// to it reaches every card.

import type { HydratedSessionEventContent } from "@ai-sidekicks/contracts/event/envelope";

import { type PublishedText } from "../reveal/published-text.js";
import type { TranscriptRowProps } from "./renderer.js";
import type { FootnoteRegistry } from "./markdown/footnotes/registry.js";

/** What one transcript card is drawn from. */
export interface HydratedRowProps extends TranscriptRowProps {
  /**
   * The row's machine-authored body, as the read projection reports it. Optional because asking
   * for a body is a separate act from projecting a row: a collapsed tool row a reader never
   * opens costs no decryption, and `undefined` says "not asked" rather than "not there".
   */
  readonly content?: HydratedSessionEventContent | undefined;
  /**
   * Text the reveal engine is publishing for this row while it streams, as the lane's stable
   * handle; a card memoizes on its `revision`. A prop rather than a subscription: the row
   * renderer is what reads the engine, so a card that subscribed would be a second subscriber to
   * one fact.
   */
  readonly liveText?: PublishedText | undefined;
  /** Where this message's footnote definitions are registered. */
  readonly footnotes: FootnoteRegistry;
}
