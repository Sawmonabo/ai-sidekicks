// The HTML a markdown text makes under the screen's own policy: no anchor and no image, and a raw
// HTML line is text, never markup. The page and the markdown worker both make it here, so a text
// made into HTML off the page's thread is the same bytes as one made on it.

import { toHtml } from "hast-util-to-html";
import { toHast, type Handlers } from "mdast-util-to-hast";

import { parseMarkdown } from "./parse.js";

/** The HTML `markdown` makes, as the screen would draw it. */
export function markdownToHtml(markdown: string): string {
  return toHtml(markdownToHast(markdown));
}

/** The elements `markdown` makes under the screen's own policy, as a tree. */
export function markdownToHast(markdown: string): ReturnType<typeof toHast> {
  return toHast(parseMarkdown(markdown), { handlers: SCREEN_POLICY_HANDLERS });
}

/** The screen draws a link as its text, an image as its alt text and raw HTML as literal text. */
const SCREEN_POLICY_HANDLERS: Handlers = {
  link: (state, node) => state.all(node),
  linkReference: (state, node) => state.all(node),
  image: (_state, node: { alt?: string | null }) => ({ type: "text", value: node.alt ?? "" }),
  imageReference: (_state, node: { alt?: string | null }) => ({
    type: "text",
    value: node.alt ?? "",
  }),
  html: (_state, node: { value: string }) => ({ type: "text", value: node.value }),
};
