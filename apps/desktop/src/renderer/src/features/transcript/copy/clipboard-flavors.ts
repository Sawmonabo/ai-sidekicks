// The two flavors a reply goes onto the clipboard in: its markdown, and a formatted flavor beside
// it. A whole reply's markdown is its body. The formatted flavor is always made from markdown,
// never copied from the screen, so it carries no app classes, and it follows the screen's own
// policy.

import type { TextClipboardContent } from "#shared/preload-api.js";
import {
  makeMarkdownHtml,
  markdownWorker,
} from "#renderer/components/Markdown/worker/connection.js";

/**
 * A reply's two flavors: the markdown as written, and the formatted flavor made from it, at once
 * for a short reply and by the markdown worker for a long one, rejecting when the worker fails.
 */
export function replyClipboardContent(
  markdown: string,
): TextClipboardContent | Promise<TextClipboardContent> {
  const html = makeMarkdownHtml(markdown, markdownWorker);
  return typeof html === "string"
    ? { text: markdown, html }
    : html.then((madeHtml) => ({ text: markdown, html: madeHtml }));
}
