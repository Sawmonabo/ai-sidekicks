// Where a code block's color spans come from. The renderer only paints them; whoever mounts it
// supplies the reader, which asks the daemon and keeps what came back.

import type { HighlightLanguage } from "@ai-sidekicks/contracts/highlight";

/** One code block a reader is asked about. */
export interface CodeSpanRequest {
  readonly language: HighlightLanguage;
  readonly source: string;
}

/**
 * The color spans for code blocks: packed `[offset, length, class]` triples over the source, in
 * UTF-16 code units.
 */
export interface CodeSpanReader {
  /** The spans already held for this block, or `undefined` when none are. */
  heldSpans(request: CodeSpanRequest): Uint32Array | undefined;
  /**
   * Read this block's spans and hold them. Answers `undefined` when the read was refused, which
   * the reader has already recorded; the block stays plain, since its source is on screen.
   */
  readSpans(request: CodeSpanRequest, signal: AbortSignal): Promise<Uint32Array | undefined>;
}
