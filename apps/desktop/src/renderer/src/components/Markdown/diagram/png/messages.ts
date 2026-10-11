// What the page and the PNG encoder worker say to each other: a picture's size, then its tiles
// drawn at its copy size on its ground, a strip of rows at a time from the top and each strip's
// tiles from the left, each taken before the next is sent, then the end; and the PNG's bytes or why
// it could not be encoded.

/** What the page sends the worker, in order: one start, each tile, one end. */
export type PngEncodeRequest =
  | { readonly kind: "start"; readonly width: number; readonly height: number }
  | {
      readonly kind: "tile";
      /** The tile drawn with margins around it, which are not the tile's. */
      readonly bitmap: ImageBitmap;
      /** Where the tile starts inside the bitmap, past the margins above and to its left. */
      readonly firstColumn: number;
      readonly firstRow: number;
      readonly columns: number;
      readonly rows: number;
    }
  | { readonly kind: "end" };

/**
 * The worker's answer: a tile taken, the PNG's bytes moved to the page once it ends, or why it
 * could not encode them.
 */
export type PngEncodeReply =
  | { readonly status: "taken" }
  | { readonly status: "encoded"; readonly png: ArrayBuffer }
  | { readonly status: "failed"; readonly reason: string };
