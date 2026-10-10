// What the page and the markdown worker say to each other: a reply's markdown asked for as HTML,
// or a drawn part asked for as the text it copies as, and the text the worker made or why it made
// none. Markdown travels as UTF-8 bytes whose buffer is moved to the other side rather than copied,
// and so does each text made; a drawn part's tree is copied. Both sides import these shapes, so a
// message is checked by the compiler on each end.

import type { CopyFlavor, DrawnTree } from "../drawn-text.js";

/**
 * What the page asks the markdown worker: a reply's HTML under the screen's policy, or the text a
 * drawn part copies as in its flavor.
 */
export type MarkdownWorkerRequest =
  | {
      readonly kind: "html";
      /** Pairs the reply with this request. */
      readonly requestId: number;
      /** The markdown, UTF-8 encoded. */
      readonly source: ArrayBuffer;
    }
  | {
      readonly kind: "drawn-text";
      readonly requestId: number;
      readonly tree: DrawnTree;
      readonly flavor: CopyFlavor;
    };

/** What one request came to: the text made, UTF-8 encoded, or why there is none. */
export type MarkdownWorkerReply =
  | { readonly status: "made"; readonly requestId: number; readonly text: ArrayBuffer }
  | { readonly status: "failed"; readonly requestId: number; readonly reason: string };
