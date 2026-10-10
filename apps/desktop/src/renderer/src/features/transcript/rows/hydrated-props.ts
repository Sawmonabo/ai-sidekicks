// The props every transcript card is handed: the row renderer's contract plus the hydrated body
// and the footnote registry the message shares. Extending that contract means a member added
// to it reaches every card.

import type { TranscriptRowContent } from "@ai-sidekicks/contracts/transcript/content";

import { type PublishedText } from "../reveal/published-text.js";
import type { TranscriptRowProps } from "./renderer.js";
import type { FootnoteRegistry } from "./markdown/footnotes/registry.js";

/** What one transcript card is drawn from. */
export interface HydratedRowProps extends TranscriptRowProps {
  /**
   * The row's machine-authored body, as the row a read returned carries it; a large one is its
   * size alone. `undefined` on a row the stream delivered, which carries no body, so it says "not
   * read" rather than "not there".
   */
  readonly content?: TranscriptRowContent | undefined;
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
   * Keep a pressed control inside the body where it stands while the row's height changes, called
   * before the change; absent where the card is drawn outside a transcript's list.
   */
  readonly holdControlInPlace?: ((control: HTMLElement) => void) | undefined;
}
