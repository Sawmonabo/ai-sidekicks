// What the page and the markdown worker say to each other: the parser the worker loads, and the
// text-compression module it compiles on its own for the page's packed texts; a text to parse and
// the trees the worker sends back as the parser's own binary buffers; a text to cut into
// blocks and where each block ends; a reply's markdown asked for as HTML, or a drawn part asked for
// as the text it copies as; the worker's asks for a long table's undrawn rows and the page's
// answers; and the text the worker made, with its HTML for a part copied as markdown, or why it
// made none. A copied text travels as the UTF-8 bytes of its pieces and a tree as its buffer, each
// moved to the other side rather than copied, so neither side's task grows with the text; a drawn
// part's tree is copied, and a table's rows go as the JSON of each. Both sides import these
// shapes, so a message is checked by the compiler on each end.

import type { Table } from "mdast";

import type { CopyFlavor, DrawnTree } from "../drawn-text.js";

/**
 * What the page sends a worker first: the parser's WebAssembly module, which the app compiles once
 * and every later worker instantiates, or `undefined` when none is compiled yet, and the worker
 * compiles it and sends it back; and whether the page's text codec still wants its module, which
 * the worker then compiles apart from the parser and sends.
 */
export interface MarkdownParserLoad {
  readonly kind: "load";
  readonly parser: WebAssembly.Module | undefined;
  readonly shouldCompileTextCompression: boolean;
}

/**
 * The text-compression module the worker compiled, or why it compiled none: a failure there never
 * fails the parser, and the page holds every text's chunks plain until a later worker compiles it.
 */
export type CompiledTextCompression =
  | { readonly status: "compiled"; readonly module: WebAssembly.Module }
  | { readonly status: "absent"; readonly reason: string };

/** One text to parse, the body's definitions already ahead of it. */
export interface MarkdownParseRequest {
  readonly kind: "parse";
  /** Pairs the tree with this request. */
  readonly requestId: number;
  readonly source: string;
}

/** One body's text to cut into blocks, from where its last block cut ends. */
export interface MarkdownCutRequest {
  readonly kind: "cut";
  /** Pairs the blocks with this request. */
  readonly requestId: number;
  readonly source: string;
  /** Whether the text is whole, so its last blocks are cut too, rather than held back. */
  readonly isFinal: boolean;
}

/**
 * What cutting one text came to: where each block cut ends in it, ascending, the first starting at
 * its start, or why the parser gave none.
 */
export type MarkdownCutAnswer =
  | { readonly status: "cut"; readonly blockEnds: Uint32Array }
  | { readonly status: "failed"; readonly reason: string };

/**
 * What parsing one text came to: the parser's binary tree and the stand-in its dollars read as
 * text took, or why the parser gave none.
 */
export type MarkdownParseAnswer =
  | {
      readonly status: "parsed";
      readonly buffer: ArrayBuffer;
      readonly dollarStandIn: string | undefined;
    }
  | { readonly status: "failed"; readonly reason: string };

/**
 * What the page asks the markdown worker to make: a reply's HTML under the screen's policy, or the
 * text a drawn part copies as in its flavor.
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
export type MarkdownWorkerMessage =
  | MarkdownParserLoad
  | MarkdownParseRequest
  | MarkdownCutRequest
  | MarkdownWorkerRequest
  | UndrawnRowsAnswer;

/**
 * One parsed text: the parser's binary tree, which the page reads into mdast, and the character
 * that stands in the text for each dollar the parse read as text, if the worker put one in.
 */
export interface SerializedMarkdownTree {
  readonly requestId: number;
  readonly buffer: ArrayBuffer;
  readonly dollarStandIn: string | undefined;
}

/** Where the blocks of one text the worker cut end, in UTF-16 code units, by the request's id. */
export interface MarkdownBlockEnds {
  readonly requestId: number;
  readonly blockEnds: Uint32Array;
}

/** What the worker made for one request, each text as the UTF-8 bytes of its pieces. */
export interface MarkdownWorkerMade {
  /** The HTML asked for, or the text a drawn part copies as. */
  readonly text: readonly ArrayBuffer[];
  /** The HTML a drawn part copied as markdown makes. */
  readonly html?: readonly ArrayBuffer[];
}

/**
 * What the worker says: the parser it compiled, which the page keeps for later workers; the
 * text-compression module it compiled, or why it compiled none, which the page's codec takes; the
 * trees of the texts it parsed since it last sent trees, and where the blocks of the texts it cut
 * since it last sent cuts end, each sent together so the page lands them in one pass; that the
 * parser failed to load or failed on a text, after which the page ends this worker; or, about one
 * request to make, an ask for body rows `firstIndex` to `lastIndex` of the table `tableKey` names,
 * what it made, or why it made nothing. A request has one ask unanswered at most.
 */
export type MarkdownWorkerReply =
  | { readonly status: "compiled"; readonly parser: WebAssembly.Module }
  | {
      readonly status: "text-compression";
      readonly textCompression: CompiledTextCompression;
    }
  | { readonly status: "parsed"; readonly trees: readonly SerializedMarkdownTree[] }
  | { readonly status: "cut"; readonly cuts: readonly MarkdownBlockEnds[] }
  | { readonly status: "load-failed"; readonly reason: string }
  | { readonly status: "parser-failed"; readonly reason: string }
  | {
      readonly status: "pull";
      readonly requestId: number;
      readonly tableKey: string;
      readonly firstIndex: number;
      readonly lastIndex: number;
    }
  | ({ readonly status: "made"; readonly requestId: number } & MarkdownWorkerMade)
  | { readonly status: "failed"; readonly requestId: number; readonly reason: string };
