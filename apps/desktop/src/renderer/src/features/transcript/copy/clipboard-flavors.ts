// The two flavors a reply goes onto the clipboard in: its markdown, and a formatted flavor beside
// it. A whole reply's markdown is its body. The formatted flavor is always made from markdown,
// never copied from the screen, so it carries no app classes, and it follows the screen's own
// policy.

import {
  makeMarkdownHtml,
  markdownWorker,
} from "#renderer/components/Markdown/worker/connection.js";
import type { PiecedText } from "#renderer/lib/text-pieces.js";
import type { PiecedTextClipboardContent } from "#renderer/services/platform/clipboard/late-copy.js";

/**
 * A reply's two flavors, each in pieces: the markdown as written, and the formatted flavor made
 * from it, at once for a short reply and by the markdown worker for a long one, rejecting when the
 * worker fails.
 */
export function replyClipboardContent(
  markdown: PiecedText,
): PiecedTextClipboardContent | Promise<PiecedTextClipboardContent> {
  const html = makeMarkdownHtml(markdown.text, markdownWorker, markdown.pieces);
  return html instanceof Promise
    ? html.then((madeHtml) => ({ text: markdown, html: madeHtml }))
    : { text: markdown, html };
}
