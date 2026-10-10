// KaTeX's chunk, ready to draw in each window. KaTeX's code, its sheet and its fonts are a large
// download most sessions never need, so they arrive on their own chunk, which settles in a window
// only once that window's document has the faces in. One load per document, held weakly, shared by
// every formula drawn there and by the feed, which waits on it before it lists a finished formula.

import { MemoizedLoad } from "#renderer/lib/memoized-load.js";
import type { typesetFormula } from "./formula.js";

/**
 * The typesetter's load for `windowDocument`: its `loadedValue` typesets at once once it has
 * settled there, and `load()` settles once the chunk and the document's faces are in.
 */
export function typesetterLoadFor(windowDocument: Document): MemoizedLoad<typeof typesetFormula> {
  return typesetterLoads.loadFor(windowDocument);
}

/** One load per document, held weakly so a closed window's load goes with it. */
class TypesetterLoads {
  readonly #loadsByDocument = new WeakMap<Document, MemoizedLoad<typeof typesetFormula>>();

  public loadFor(windowDocument: Document): MemoizedLoad<typeof typesetFormula> {
    let load = this.#loadsByDocument.get(windowDocument);
    if (load === undefined) {
      load = new MemoizedLoad(async () => {
        const typesetter = await import("./formula.js");
        await typesetter.prepareMathDrawing(windowDocument);
        return typesetter.typesetFormula;
      });
      this.#loadsByDocument.set(windowDocument, load);
    }
    return load;
  }
}

const typesetterLoads = new TypesetterLoads();
