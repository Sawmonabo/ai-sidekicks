// What the page and the PNG encoder worker say to each other: a picture's size, then its strips of
// rows drawn at its copy size on its ground, top to bottom, each taken before the next is sent,
// then the end; and the PNG's bytes or why it could not be encoded.

/** What the page sends the worker, in order: one start, each strip, one end. */
export type PngEncodeRequest =
  | { readonly kind: "start"; readonly width: number; readonly height: number }
  | {
      readonly kind: "strip";
      /** The strip drawn with rows above and below it, which are not the strip's. */
      readonly bitmap: ImageBitmap;
      readonly firstRow: number;
      readonly rows: number;
    }
  | { readonly kind: "end" };

/**
 * The worker's answer: a strip taken, the PNG's bytes moved to the page once it ends, or why it
 * could not encode them.
 */
export type PngEncodeReply =
  | { readonly status: "taken" }
  | { readonly status: "encoded"; readonly png: ArrayBuffer }
  | { readonly status: "failed"; readonly reason: string };
