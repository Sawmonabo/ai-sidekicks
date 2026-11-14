// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Syntax color spans: the daemon colors code once and every client paints what it is handed.

/** How many numbers one span takes in a reply: offset, length, class. */
export const HIGHLIGHT_SPAN_WIDTH = 3 as const;

/**
 * The largest source the daemon colors, in UTF-8 bytes of its JSON as it travels. A larger
 * block is left plain: coloring it would cost more than the span cache holds for everything
 * else.
 */
export const HIGHLIGHT_SOURCE_MAX_BYTES = 262144 as const;

/**
 * The largest span list a reply carries, in UTF-8 bytes of its JSON as it travels: its own
 * figure, which the reply with its envelope keeps well inside the message limit.
 */
export const HIGHLIGHT_SPANS_MAX_BYTES = 998976 as const;

/** The longest block id a `highlight.read` carries. */
export const HIGHLIGHT_BLOCK_ID_MAX_LENGTH = 128 as const;

/** Every language the daemon can color. */
export const HIGHLIGHT_LANGUAGES = [
  "bash",
  "css",
  "diff",
  "go",
  "html",
  "javascript",
  "json",
  "jsx",
  "markdown",
  "python",
  "rust",
  "sql",
  "tsx",
  "typescript",
  "yaml",
] as const;

/** The classes a span paints as, in wire order. */
export const HIGHLIGHT_SPAN_CLASSES = [
  "keyword",
  "name",
  "string",
  "number",
  "comment",
  "inserted",
  "deleted",
  "hunk",
  "heading",
  "emphasis",
  "inlineCode",
] as const;

/**
 * One language the daemon can color.
 */
export type HighlightLanguage =
  | "bash"
  | "css"
  | "diff"
  | "go"
  | "html"
  | "javascript"
  | "json"
  | "jsx"
  | "markdown"
  | "python"
  | "rust"
  | "sql"
  | "tsx"
  | "typescript"
  | "yaml";
/**
 * One class a span paints as; plain text has no span. The first five mark code; the rest mark a
 * diff's lines and Markdown's own syntax. A span names its class by its index in `VARIANTS`.
 */
export type HighlightSpanClass =
  | "keyword"
  | "name"
  | "string"
  | "number"
  | "comment"
  | "inserted"
  | "deleted"
  | "hunk"
  | "heading"
  | "emphasis"
  | "inlineCode";
/**
 * A source's color spans: `[offset, length, class, …]` in source order.
 */
export type HighlightSpans = number[];

/**
 * The code a client wants colored.
 */
export interface HighlightReadRequest {
  /**
   * The language.
   */
  language: HighlightLanguage;
  /**
   * The source, at most [`HIGHLIGHT_SOURCE_MAX_BYTES`] as its JSON travels.
   */
  source: string;
  /**
   * The code block on screen this read is for, unique among the client's blocks; a newer read
   * with the same block id on the same connection replaces this one while it waits.
   */
  blockId?: string;
}
/**
 * A source's color spans, in source order, never overlapping.
 */
export interface HighlightReadResponse {
  /**
   * The spans.
   */
  spans: HighlightSpans;
}

/** The methods of {@link HIGHLIGHT_METHOD_DESCRIPTORS}, each with its kind. */
export interface HighlightMethodDescriptors {
  readonly "highlight.read": {
    readonly method: "highlight.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
}
/** The params, result and emission types of each method of {@link HIGHLIGHT_METHOD_DESCRIPTORS}. */
export interface HighlightMethodTypes {
  readonly "highlight.read": {
    readonly params: HighlightReadRequest;
    readonly result: HighlightReadResponse;
  };
}
/** The `highlight.*` methods: one read, answered by the daemon's colorer. */
export const HIGHLIGHT_METHOD_DESCRIPTORS: HighlightMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "highlight.read": /* @__PURE__ */ Object.freeze({
      method: "highlight.read",
      procedureType: "query",
      mutating: false,
    }),
  });
