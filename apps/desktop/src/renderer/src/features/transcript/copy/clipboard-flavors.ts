// The two flavors a reply goes onto the clipboard in: its markdown, and a formatted flavor beside
// it. A whole reply's markdown is its body. The formatted flavor is always made from markdown by
// the markdown worker, which parses it, never copied from the screen, so it carries no app
// classes, and it follows the screen's own policy.

import { markdownWorker } from "#renderer/components/Markdown/worker/connection.js";
import type { PiecedText } from "#renderer/lib/text-pieces.js";
import type { PiecedTextClipboardContent } from "#renderer/services/platform/clipboard/late-copy.js";

/**
 * A reply's two flavors, each in pieces: the markdown as written, and the formatted flavor the
 * markdown worker makes from it, rejecting when the worker fails.
 */
export async function replyClipboardContent(
  markdown: PiecedText,
): Promise<PiecedTextClipboardContent> {
  return { text: markdown, html: await markdownWorker.html(markdown.text, markdown.pieces) };
}
