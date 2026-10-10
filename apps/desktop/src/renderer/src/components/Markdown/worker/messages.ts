// What the page and the markdown worker say to each other: one text asked for as HTML, or as the
// body rows of the one table it makes, and what the worker made of it or why it made nothing. A
// text travels once, as UTF-8 bytes whose buffer is moved to the other side rather than copied, and
// so does the HTML made of it. Both sides import these shapes, so a message is checked by the
// compiler on each end.

import type { MarkdownHastChild } from "../html.js";

/**
 * What the page asks the markdown worker of one text: its HTML under the screen's policy, or the
 * body rows of the one table it makes.
 */
export interface MarkdownWorkerRequest {
  readonly kind: "html" | "table-rows";
  /** Pairs the reply with this request. */
  readonly requestId: number;
  /** The markdown, UTF-8 encoded. */
  readonly source: ArrayBuffer;
}

/** What one text came to: its HTML, UTF-8 encoded, its table's body rows, or why there is none. */
export type MarkdownWorkerReply =
  | { readonly status: "html"; readonly requestId: number; readonly html: ArrayBuffer }
  | {
      readonly status: "table-rows";
      readonly requestId: number;
      readonly rows: readonly MarkdownHastChild[];
    }
  | { readonly status: "failed"; readonly requestId: number; readonly reason: string };
