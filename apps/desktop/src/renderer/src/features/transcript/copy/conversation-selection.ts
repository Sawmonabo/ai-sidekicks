// What a selection in the conversation copies: each row it touches, in the order the rows are
// read, joined by a blank line. A message row gives only its body, never its author line, stamp
// or controls: a reply's part as the markdown rebuilt from what was selected, and the person's
// own message or a reasoning aside as plain text. Any other row gives the text selected in it.
// A formatted flavor rides beside the text whenever a reply is part of it.

import { toHtml } from "hast-util-to-html";

import type { ClipboardContent } from "@shared/preload-api.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "@renderer/lib/windowed-row-markers.js";
import { markdownToHtml, rebuildMarkdown } from "./clipboard-flavors.js";

/** The attribute a message row's body carries, naming the flavor its selected part copies as. */
export const COPY_FLAVOR_ATTRIBUTE = "data-copy-flavor";

/** How a body's selected part is copied: a reply's markdown, or plain text. */
export type CopyFlavor = "markdown" | "text";

/** What joins two rows' parts: a blank line, as the conversation reads them. */
const PART_SEPARATOR = "\n\n";

/**
 * What `range` copies out of the conversation drawn in `conversation`, or `undefined` when it
 * touches no row's copyable text, so the platform's own copy stands.
 */
export function readConversationSelection(
  range: Range,
  conversation: Element,
): ClipboardContent | undefined {
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
  if (body === null) {
    return { flavor: "text", text: clampedTo(range, row).toString() };
  }
  // A selection holding only the row's author line or controls clamps to nothing here.
  const part = clampedTo(range, body);
  return body.getAttribute(COPY_FLAVOR_ATTRIBUTE) === "markdown"
    ? { flavor: "markdown", text: rebuildMarkdown(part.cloneContents()) }
    : { flavor: "text", text: part.toString() };
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
