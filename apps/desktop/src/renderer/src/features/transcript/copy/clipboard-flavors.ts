// The two flavors a reply goes onto the clipboard in: its markdown, and a formatted flavor beside
// it. A whole reply's markdown is its body; a selected part's markdown is rebuilt from the drawn
// elements the selection holds. The formatted flavor is always made from markdown, never copied
// from the screen, so it carries no app classes, and it follows the screen's own policy.

import { type fromDom } from "hast-util-from-dom";
import { defaultHandlers, toMdast, type Handle } from "hast-util-to-mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";

import type { TextClipboardContent } from "#shared/preload-api.js";
import {
  makeMarkdownHtml,
  markdownWorker,
} from "#renderer/components/Markdown/worker/connection.js";

/** A tree of drawn elements, as the DOM reader builds it. */
export type DrawnTree = ReturnType<typeof fromDom>;

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

/** The markdown that made the drawn reply elements in `tree`, rebuilt from them. */
export function rebuildMarkdown(tree: DrawnTree): string {
  const markdownTree = toMdast(tree, { handlers: DRAWN_MARKDOWN_HANDLERS });
  // `-` is the bullet agents and people write most; the drawing does not keep which one was used.
  return toMarkdown(markdownTree, { bullet: "-", extensions: [gfmToMarkdown()] }).trimEnd();
}

/** What one element handler answers, derived from the library's own handler. */
type RebuiltNodes = ReturnType<Handle>;

/** One element of a drawn tree, as a handler is handed it. */
type DrawnElement = Parameters<Handle>[1];

/**
 * How the markdown drawing's own elements read back: a heading is a `p` carrying its level, a
 * list item is tight unless marked loose, a fenced block names its language on the `pre`, and a
 * table cell carries its column's alignment as `data-align`, which the table's reader takes from
 * `align`.
 */
const DRAWN_MARKDOWN_HANDLERS: Record<string, Handle> = {
  p: (state, element) => {
    const level = Number(element.properties["ariaLevel"]);
    return element.properties["role"] === "heading" && isHeadingDepth(level)
      ? ({ type: "heading", depth: level, children: state.all(element) } as RebuiltNodes)
      : defaultHandlers.p(state, element);
  },
  li: (state, element) => ({
    ...defaultHandlers.li(state, element),
    spread: element.properties["dataSpread"] !== undefined,
  }),
  pre: (state, element) => {
    const language = element.properties["dataLanguage"];
    const code = defaultHandlers.pre(state, element);
    return typeof language === "string" ? { ...code, lang: language } : code;
  },
  table: (state, element) => {
    alignCellsOf(element);
    return defaultHandlers.table(state, element);
  },
};

/** Gives each cell of a drawn table, nested tables aside, the `align` its `data-align` names. */
function alignCellsOf(parent: DrawnElement): void {
  for (const child of parent.children) {
    if (child.type !== "element" || child.tagName === "table") {
      continue;
    }
    const alignment = child.properties["dataAlign"];
    if ((child.tagName === "td" || child.tagName === "th") && typeof alignment === "string") {
      child.properties["align"] = alignment;
    }
    alignCellsOf(child);
  }
}

function isHeadingDepth(level: number): level is 1 | 2 | 3 | 4 | 5 | 6 {
  return Number.isInteger(level) && level >= 1 && level <= 6;
}
