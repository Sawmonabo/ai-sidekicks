// What the page and the markdown worker say to each other: a reply's markdown asked for as HTML, or
// a drawn part asked for as the text it copies as; the worker's asks for a long table's undrawn
// rows and the page's answers; and the text the worker made, with its HTML for a part copied as
// markdown, or why it made none. A text travels as the UTF-8 bytes of its pieces, each buffer moved
// to the other side rather than copied, so neither side's task grows with the text; a drawn part's
// tree is copied, and a table's rows go as the JSON of each. Both sides import these shapes, so a
// message is checked by the compiler on each end.

import type { Table } from "mdast";

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
      /** The markdown, as the UTF-8 bytes of its pieces. */
      readonly markdown: readonly ArrayBuffer[];
    }
  | {
      readonly kind: "drawn-text";
      readonly requestId: number;
      readonly tree: DrawnTree;
      readonly flavor: CopyFlavor;
      /** The column alignment of each long table whose undrawn rows the tree names, by its key. */
      readonly tableAlignments: ReadonlyMap<string, Table["align"]>;
    };

/**
 * The page's answer to the worker's last ask for a request's undrawn rows: from the first asked
 * for, as many as one slice of the page's thread wrote, at least one, each as its JSON.
 */
export interface UndrawnRowsAnswer {
  readonly kind: "undrawn-rows";
  readonly requestId: number;
  readonly rows: readonly string[];
}

/** What the page sends the markdown worker. */
export type MarkdownWorkerMessage = MarkdownWorkerRequest | UndrawnRowsAnswer;

/** What the worker made for one request, each text as the UTF-8 bytes of its pieces. */
export interface MarkdownWorkerMade {
  /** The HTML asked for, or the text a drawn part copies as. */
  readonly text: readonly ArrayBuffer[];
  /** The HTML a drawn part copied as markdown makes. */
  readonly html?: readonly ArrayBuffer[];
}

/**
 * What the worker says about one request: an ask for body rows `firstIndex` to `lastIndex` of the
 * table `tableKey` names, what it made, or why it made nothing. A request has one ask unanswered
 * at most.
 */
export type MarkdownWorkerReply =
  | {
      readonly status: "pull";
      readonly requestId: number;
      readonly tableKey: string;
      readonly firstIndex: number;
      readonly lastIndex: number;
    }
  | ({ readonly status: "made"; readonly requestId: number } & MarkdownWorkerMade)
  | { readonly status: "failed"; readonly requestId: number; readonly reason: string };
