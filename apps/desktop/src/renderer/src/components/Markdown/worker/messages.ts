// What the page and the markdown worker say to each other: one text asked for as HTML, and the
// HTML it made or why it made none. Each text travels once, as UTF-8 bytes whose buffer is moved to
// the other side rather than copied. Both sides import these shapes, so a message is checked by
// the compiler on each end.

/** What the page asks the markdown worker: one text made into HTML under the screen's policy. */
export interface MarkdownWorkerRequest {
  readonly kind: "html";
  /** Pairs the reply with this request. */
  readonly requestId: number;
  /** The markdown, UTF-8 encoded. */
  readonly source: ArrayBuffer;
}

/** What one text came to: its HTML, UTF-8 encoded, or why the worker made none. */
export type MarkdownWorkerReply =
  | { readonly status: "html"; readonly requestId: number; readonly html: ArrayBuffer }
  | { readonly status: "failed"; readonly requestId: number; readonly reason: string };
