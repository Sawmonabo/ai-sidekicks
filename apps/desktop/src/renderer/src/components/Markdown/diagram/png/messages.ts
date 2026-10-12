// What the page and the PNG encoder worker say to each other: a picture's size, then its tiles
// drawn at its copy size on its ground, a strip of rows at a time from the top and each strip's
// tiles from the left, each taken before the next is sent, then the end; and the PNG's bytes or why
// it could not be encoded. Also how many pixels either side holds of a strip at a time.

/**
 * The most pixels the page draws of a strip cut into tiles, with its margins, and the most the
 * worker reads of a tile at a time. Measured on a loaded machine, a strip of a 120-node flowchart
 * this size took at most 2.3 ms to draw and 5.3 ms to hand to the worker.
 */
export const STRIP_PIXELS = 4_194_304;

/** What the page sends the worker, in order: one start, each tile, one end. */
export type PngEncodeRequest =
  | {
      readonly kind: "start";
      readonly width: number;
      readonly height: number;
      /** The color laid under every band, as a canvas fill style. */
      readonly groundColor: string;
    }
  | {
      readonly kind: "tile";
      /** The tile drawn with margins around it, which are not the tile's, on the ground or none. */
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
