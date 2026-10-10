import { createContext, type Context } from "react";

import type { ClipboardContent } from "#shared/preload-api.js";

/** One copy a block offers: what its control reads and what it puts on the clipboard. */
export interface BlockCopyOffer {
  readonly label: string;
  /** Built when the copy is pressed, so costly content is made only for a copy asked for. */
  readonly content: () => ClipboardContent | Promise<ClipboardContent>;
}

/** Draws one copy a block offers as the app's copy control. */
export type BlockCopyRenderer = (offer: BlockCopyOffer) => React.ReactNode;

/**
 * The app's one block copy control, provided once by the app so a markdown body outside the
 * conversation draws the same copies a reply does; `undefined` outside the app.
 */
export const BlockCopyRendererContext: Context<BlockCopyRenderer | undefined> = createContext<
  BlockCopyRenderer | undefined
>(undefined);
