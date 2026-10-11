// What the page and the markdown worker say to each other: a reply's markdown asked for as HTML,
// or a drawn part asked for as the text it copies as, and the text the worker made or why it made
// none. A text travels as the UTF-8 bytes of its pieces, each buffer moved to the other side rather
// than copied, so neither side's task grows with the text; a drawn part's tree is copied. Both
// sides import these shapes, so a message is checked by the compiler on each end.

import type { BlockParseSource } from "../parse.js";
import type { CopyFlavor, DrawnTree } from "../drawn-text.js";

/** What a block was parsed from, its text as the UTF-8 bytes of its pieces. */
export type BlockParseSourceMessage = Omit<BlockParseSource, "source"> & {
  readonly source: readonly ArrayBuffer[];
};

/**
 * What the page asks the markdown worker: a reply's HTML under the screen's policy, or the text a
 * drawn part copies as in its flavor.
 */
export type MarkdownWorkerRequest =
  | {
      readonly kind: "html";
      /** Pairs the reply with this request. */
      readonly requestId: number;
      /** The markdown, as the UTF-8 bytes of its pieces. */
      readonly markdown: readonly ArrayBuffer[];
    }
  | {
      readonly kind: "drawn-text";
      readonly requestId: number;
      readonly tree: DrawnTree;
      readonly flavor: CopyFlavor;
      /** What each long table's block was parsed from, by the key its undrawn rows name. */
      readonly blockSources: ReadonlyMap<string, BlockParseSourceMessage>;
    };

/** What one request came to: the text made, as its pieces' UTF-8 bytes, or why there is none. */
export type MarkdownWorkerReply =
  | { readonly status: "made"; readonly requestId: number; readonly text: readonly ArrayBuffer[] }
  | { readonly status: "failed"; readonly requestId: number; readonly reason: string };
