// What a selection in the conversation copies: each row it touches, in the order the rows are
// read, joined by a blank line. A message row gives only its body, never its author line, stamp
// or controls: a reply's part as the markdown rebuilt from what was selected, and the person's
// own message or a reasoning aside as plain text. Any other row gives the text selected in it.
// Plain text is read the way the screen lays it out, a block's lines on lines of their own, and
// no control's label is ever part of it. A formula copies as its TeX source, whole, once. A
// formatted flavor rides beside the text whenever a reply is part of it.

import { isElement } from "@floating-ui/utils/dom";
import { fromDom } from "hast-util-from-dom";
import { toHtml } from "hast-util-to-html";
import { toText } from "hast-util-to-text";

import type { TextClipboardContent } from "#shared/preload-api.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "#renderer/lib/windowed-row-markers.js";
import { markdownToHtml, rebuildMarkdown } from "./clipboard-flavors.js";

/** The attribute a message row's body carries, naming the flavor its selected part copies as. */
export const COPY_FLAVOR_ATTRIBUTE = "data-copy-flavor";

/** How a body's selected part is copied: a reply's markdown, or plain text. */
export type CopyFlavor = "markdown" | "text";

/** What joins two rows' parts, of a selection or of a reply: a blank line, as they are read. */
export const PART_SEPARATOR = "\n\n";

/**
 * What `range` copies out of the conversation drawn in `conversation`, or `undefined` when it
 * touches no row's copyable text, so the platform's own copy stands.
 */
export function readConversationSelection(
  range: Range,
  conversation: Element,
): TextClipboardContent | undefined {
  // The window draws its rows in the order they are read, so document order is reading order.
  const rows = [
    ...conversation.querySelectorAll<HTMLElement>(`[${WINDOWED_ROW_INDEX_ATTRIBUTE}]`),
  ].filter((row) => range.intersectsNode(row));
  const parts = rows
    .map((row) => selectedPartOf(range, row))
    .filter((part) => part.text.trim() !== "");
  if (parts.length === 0) {
    return undefined;
  }
  const text = parts.map((part) => part.text).join(PART_SEPARATOR);
  if (!parts.some((part) => part.flavor === "markdown")) {
    return { text };
  }
  return {
    text,
    html: parts
      .map((part) =>
        part.flavor === "markdown" ? markdownToHtml(part.text) : plainHtml(part.text),
      )
      .join(""),
  };
}

/** One row's share of the selection. */
interface SelectedPart {
  readonly flavor: CopyFlavor;
  readonly text: string;
}

function selectedPartOf(range: Range, row: HTMLElement): SelectedPart {
  const body = row.querySelector(`[${COPY_FLAVOR_ATTRIBUTE}]`);
  // A selection holding only the row's author line or controls clamps to nothing in its body.
  const part = clampedTo(range, body ?? row);
  return body?.getAttribute(COPY_FLAVOR_ATTRIBUTE) === "markdown"
    ? { flavor: "markdown", text: rebuildMarkdown(selectedContentOf(part, "markdown")) }
    : { flavor: "text", text: toText(fromDom(selectedContentOf(part, "text"))) };
}

/**
 * What `part` holds, without the controls drawn among it, since a button's label is no one's
 * text, and with each formula as its TeX source: as text, or as a math block the markdown rebuild
 * reads as one.
 */
function selectedContentOf(part: Range, flavor: CopyFlavor): DocumentFragment {
  // A formula draws its hidden MathML before its glyphs, so a part of one would miss its source.
  const startFormula = formulaHolding(part.startContainer);
  if (startFormula !== null) {
    part.setStartBefore(startFormula);
  }
  const endFormula = formulaHolding(part.endContainer);
  if (endFormula !== null) {
    part.setEndAfter(endFormula);
  }
  const content = part.cloneContents();
  for (const control of content.querySelectorAll("button")) {
    control.remove();
  }
  for (const formula of content.querySelectorAll(FORMULA_SELECTOR)) {
    formula.replaceWith(formulaSourceNode(formula, flavor));
  }
  return content;
}

/** `MathBlock` marks every formula it draws with `data-math`. */
const FORMULA_SELECTOR = "[data-math]";

/** The formula `node` sits in, or `null` outside any. */
function formulaHolding(node: Node): Element | null {
  return (isElement(node) ? node : node.parentElement)?.closest(FORMULA_SELECTOR) ?? null;
}

/** The node a copied formula becomes: its TeX source, fenced as math for the markdown flavor. */
function formulaSourceNode(formula: Element, flavor: CopyFlavor): Node {
  const ownerDocument = formula.ownerDocument;
  const source = ownerDocument.createTextNode(formulaSourceOf(formula));
  if (flavor === "text") {
    return source;
  }
  const code = ownerDocument.createElement("code");
  code.append(source);
  const block = ownerDocument.createElement("pre");
  block.setAttribute("data-language", "math");
  block.append(code);
  return block;
}

/**
 * A drawn formula's TeX source: KaTeX's annotation once typeset, or the `code` the source arm
 * shows before then or when it cannot be typeset. Throws for a formula holding neither.
 */
function formulaSourceOf(formula: Element): string {
  const sourceHolder = formula.querySelector("annotation") ?? formula.querySelector("code");
  if (sourceHolder === null) {
    throw new Error("A drawn formula holds no TeX source.");
  }
  return sourceHolder.textContent;
}

/** The part of `range` inside `element`. */
function clampedTo(range: Range, element: Element): Range {
  const part = range.cloneRange();
  const whole = element.ownerDocument.createRange();
  whole.selectNodeContents(element);
  if (range.compareBoundaryPoints(Range.START_TO_START, whole) < 0) {
    part.setStart(whole.startContainer, whole.startOffset);
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, whole) > 0) {
    part.setEnd(whole.endContainer, whole.endOffset);
  }
  return part;
}

/** Plain text as a formatted paragraph, its line breaks kept. */
function plainHtml(text: string): string {
  const lines = text.split("\n");
  return toHtml({
    type: "element",
    tagName: "p",
    properties: {},
    children: lines.flatMap((line, index) => [
      ...(index === 0
        ? []
        : [{ type: "element" as const, tagName: "br", properties: {}, children: [] }]),
      { type: "text" as const, value: line },
    ]),
  });
}
