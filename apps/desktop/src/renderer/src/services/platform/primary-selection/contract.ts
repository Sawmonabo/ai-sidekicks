// The system's primary selection, the text a middle-click pastes in another window, which a
// selection settled in the conversation, by a drag or the keys, puts its text on where the system
// keeps one. The kept one and none are modules of their own.

import type { PiecedText } from "#renderer/lib/text/pieces.js";

/**
 * What this operating system does with the text of a selection settled in the conversation, and
 * whether a middle-click pastes it.
 */
export interface PrimarySelection {
  /**
   * Whether a middle-button release pastes the primary selection, so a paste following one reads
   * that selection and not the clipboard.
   */
  readonly isPastedByMiddleClick: boolean;
  /**
   * Puts a settled selection's text, read only where the system keeps a primary selection, on it,
   * its pieces sent a few a slice in `view`; a read that resolves `undefined` puts nothing.
   * Rejects when the read or main's write does.
   */
  takeSettledSelection(
    readText: () => Promise<PiecedText | undefined>,
    view: Window,
  ): Promise<void>;
}
