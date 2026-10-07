import type { ClipboardContent } from "#shared/preload-api.js";

/** One copy a block offers: what its control reads and what it puts on the clipboard. */
export interface BlockCopyOffer {
  readonly label: string;
  /** Built when the copy is pressed, so costly content is made only for a copy asked for. */
  readonly content: () => ClipboardContent | Promise<ClipboardContent>;
}
