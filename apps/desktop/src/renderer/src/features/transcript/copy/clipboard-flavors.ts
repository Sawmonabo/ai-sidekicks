// The two flavors a reply goes onto the clipboard in: its markdown, and a formatted flavor beside
// it. A whole reply's markdown is its body; a selected part's markdown is rebuilt from the drawn
// elements the selection holds. The formatted flavor is always made from markdown, never copied
// from the screen, so it carries no app classes, and it follows the screen's own policy: no
// anchor and no image, and a raw HTML line is text, never markup.

import { fromDom } from "hast-util-from-dom";
import { toHtml } from "hast-util-to-html";
import { defaultHandlers, toMdast, type Handle } from "hast-util-to-mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { toHast, type Handlers } from "mdast-util-to-hast";
import { toMarkdown } from "mdast-util-to-markdown";

import type { ClipboardContent } from "#shared/preload-api.js";
import { parseMarkdown } from "#renderer/components/Markdown/parse/markdown-parse.js";

/** A reply's two flavors: the markdown as written, and the formatted flavor made from it. */
export function replyClipboardContent(markdown: string): ClipboardContent {
  return { text: markdown, html: markdownToHtml(markdown) };
}

/** The formatted flavor of `markdown`, as the screen would draw it. */
export function markdownToHtml(markdown: string): string {
  return toHtml(toHast(parseMarkdown(markdown), { handlers: SCREEN_POLICY_HANDLERS }));
}

/** The markdown that made the drawn reply elements in `fragment`, rebuilt from them. */
export function rebuildMarkdown(fragment: DocumentFragment): string {
  const tree = toMdast(fromDom(fragment), { handlers: DRAWN_MARKDOWN_HANDLERS });
  // `-` is the bullet agents and people write most; the drawing does not keep which one was used.
  return toMarkdown(tree, { bullet: "-", extensions: [gfmToMarkdown()] }).trimEnd();
}

/** One element as the markdown rebuild reads it, derived from the library's own handler. */
type DrawnElement = Parameters<Handle>[1];

/** What one element handler answers, derived the same way. */
type RebuiltNodes = ReturnType<Handle>;

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

/**
 * How the markdown drawing's own elements read back: a heading is a `p` carrying its level, a
 * list item is tight unless marked loose, a fenced block names its language on the `pre`, and
 * drawn math keeps its source in KaTeX's annotation.
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
  span: (state, element) => {
    const mathSource = drawnMathSource(element);
    return mathSource === undefined
      ? defaultHandlers.span(state, element)
      : { type: "code", lang: "math", meta: null, value: mathSource };
  },
};

/** The TeX source of a drawn math span, or `undefined` for any other span. */
function drawnMathSource(element: DrawnElement): string | undefined {
  const className = element.properties["className"];
  if (!Array.isArray(className) || !className.includes("meridian-math")) {
    return undefined;
  }
  const annotation = findElement(element, "annotation") ?? findElement(element, "code");
  return annotation === undefined ? undefined : textOf(annotation);
}

function findElement(element: DrawnElement, tagName: string): DrawnElement | undefined {
  for (const child of element.children) {
    if (child.type !== "element") {
      continue;
    }
    if (child.tagName === tagName) {
      return child;
    }
    const found = findElement(child, tagName);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function textOf(element: DrawnElement): string {
  return element.children
    .map((child) =>
      child.type === "text" ? child.value : child.type === "element" ? textOf(child) : "",
    )
    .join("");
}

function isHeadingDepth(level: number): level is 1 | 2 | 3 | 4 | 5 | 6 {
  return Number.isInteger(level) && level >= 1 && level <= 6;
}
