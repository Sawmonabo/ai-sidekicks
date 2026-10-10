// What a selection in the conversation copies of each row it runs across; `conversation-copy.ts`
// joins the parts in log order. The rows come from the viewport's record of the selection, not from
// the drawn rows, so rows the window let go between its ends are copied too. Each end row gives the
// part selected in it as it was drawn, and every row between gives its whole text from the source
// it is drawn from (`row-text.ts`). A long table's rows the window has not drawn inside an end
// row's part are read from the text of the row's body, from that same source, through the text
// range each spacer row names, so a copy never waits for rows to draw. A long part is read into its
// text by the markdown worker, so its part comes once the worker answers. A part inside one table
// is copied as a table of what was selected. A message row gives only its body, never its author
// line, stamp or controls: a reply's part as the markdown rebuilt from what was selected, and the
// person's own message or a reasoning aside as plain text. Any other row gives the text selected in
// it. Plain text is read the way the screen lays it out, a block's lines on lines of their own, and
// no control's label is ever part of it. An end row's part that reaches a large body, which draws
// only its control, holds the body read in full in the control's place, from where the part begins,
// so the body is never dropped and the control's words never copied; a message's body is its row's
// text, so its part is the whole. A formula copies as its TeX source, whole, once. A selection
// crossing the conversation copies only the conversation's part.

import { isElement } from "@floating-ui/utils/dom";
import { fromDom } from "hast-util-from-dom";

import { type CopyFlavor } from "#renderer/components/Markdown/drawn-text.js";
import {
  makeDrawnText,
  type MarkdownWorkerConnection,
} from "#renderer/components/Markdown/worker/connection.js";
import { resolveRowTextPosition } from "../viewport/selection/preservation.js";
import { type RowSelection } from "../viewport/selection/record.js";
import { withUndrawnTableRows } from "./undrawn-table-rows.js";

/** One row's share of a copy: its text, and the flavor it copies as. */
export interface SelectedPart {
  readonly flavor: CopyFlavor;
  readonly text: string;
}

/** A selection across the conversation's rows, as a copy reads it. */
export interface RowSpanSelection {
  readonly selection: RowSelection;
  /** The keys of the rows it runs across, in log order. */
  readonly rowKeys: readonly string[];
  /** An end row as it was drawn, or `undefined` when no drawing of it is kept. */
  readonly endRowElement: (rowKey: string) => Element | undefined;
  /** A whole row's text from the source it is drawn from, or `undefined` for a row with none. */
  readonly rowText: (rowKey: string) => SelectedPart | undefined;
  /**
   * The text of a row's body alone, from the same source, which an end row's part reads a long
   * table's undrawn rows and a large body from; `undefined` for a row that draws no body.
   */
  readonly rowBodyText: (rowKey: string) => string | undefined;
  /** What reads a long end row's part into its text off the page's thread. */
  readonly markdownWorker: Pick<MarkdownWorkerConnection, "drawnText">;
}

/** The attribute a row's copyable body carries, naming the flavor its selected part copies as. */
export const COPY_FLAVOR_ATTRIBUTE = "data-copy-flavor";

/**
 * The attribute the place of a body its row carries as its size alone holds, around the control
 * that reads it: an end row's part reaching it copies the body read in full in its place.
 */
export const LARGE_BODY_ATTRIBUTE = "data-large-body";

/** What joins two rows' parts, of a selection or of a reply: a blank line, as they are read. */
export const PART_SEPARATOR = "\n\n";

/**
 * The part of a drawn row that `range` selects: at once, or once `markdownWorker` has read a long
 * part into its text, rejecting with the worker's `Error`; the row is read before anything is
 * waited on. `readBodyText` reads the text of the row's body, which a long table's undrawn rows
 * and a large body drawn as its control are read from; it is read only when the part holds one.
 * Throws when the part holds one and the body has no text.
 */
export function readSelectedPart(
  range: Range,
  row: Element,
  readBodyText: () => string | undefined,
  markdownWorker: Pick<MarkdownWorkerConnection, "drawnText">,
): SelectedPart | Promise<SelectedPart> {
  const body = row.querySelector(`[${COPY_FLAVOR_ATTRIBUTE}]`);
  // A selection holding only the row's author line or controls clamps to nothing in its body.
  const part = clampedTo(range, body ?? row);
  const flavor = body?.getAttribute(COPY_FLAVOR_ATTRIBUTE) === "markdown" ? "markdown" : "text";
  const tree = withUndrawnTableRows(
    fromDom(selectedContentOf(part, flavor, readBodyText)),
    readBodyText,
  );
  const text = makeDrawnText(tree, flavor, markdownWorker);
  return typeof text === "string"
    ? { flavor, text }
    : text.then((madeText) => ({ flavor, text: madeText }));
}

/**
 * One row's part of a selection across the conversation's rows: an end row's selected part as it
 * was drawn, as `readSelectedPart` reads it, any other row's whole text, `undefined` for a row with
 * none. An end that lies outside
 * the scroller takes its row whole, and so does an end row with no drawing kept or a message row
 * whose part reaches its large body.
 */
export function readRowPart(
  span: RowSpanSelection,
  rowKey: string,
): SelectedPart | Promise<SelectedPart> | undefined {
  const { start, end } = span.selection;
  const startAt = start.at === "row" && rowKey === start.rowKey ? start.position : undefined;
  const endAt = end.at === "row" && rowKey === end.rowKey ? end.position : undefined;
  const rowElement =
    startAt === undefined && endAt === undefined ? undefined : span.endRowElement(rowKey);
  if (rowElement === undefined) {
    return span.rowText(rowKey);
  }
  const range = rowElement.ownerDocument.createRange();
  range.selectNodeContents(rowElement);
  const startPosition =
    startAt === undefined ? undefined : resolveRowTextPosition(rowElement, startAt);
  if (startPosition !== undefined) {
    range.setStart(startPosition.textNode, startPosition.offsetInNode);
  }
  const endPosition = endAt === undefined ? undefined : resolveRowTextPosition(rowElement, endAt);
  if (endPosition !== undefined) {
    range.setEnd(endPosition.textNode, endPosition.offsetInNode);
  }
  // A message's large body draws its control alone, so a part reaching it is the whole body, which
  // is the row's text, in the flavor the body copies as.
  const isMessageRow = rowElement.querySelector(`[${COPY_FLAVOR_ATTRIBUTE}]`) !== null;
  if (
    isMessageRow &&
    [...rowElement.querySelectorAll(`[${LARGE_BODY_ATTRIBUTE}]`)].some((largeBody) =>
      range.intersectsNode(largeBody),
    )
  ) {
    return span.rowText(rowKey);
  }
  return readSelectedPart(range, rowElement, () => span.rowBodyText(rowKey), span.markdownWorker);
}

/**
 * What `part` holds, with a large body's place holding the body read in full as preformatted text,
 * without the controls drawn among it, since a button's label is no one's text, and with each
 * formula as its TeX source: as text, or as a math block the markdown rebuild reads as one. A part
 * inside one table, between rows or cells, is put back in that table, so it copies as a table
 * rather than as loose rows.
 */
function selectedContentOf(
  part: Range,
  flavor: CopyFlavor,
  readBodyText: () => string | undefined,
): DocumentFragment {
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
  for (const largeBody of content.querySelectorAll(`[${LARGE_BODY_ATTRIBUTE}]`)) {
    largeBody.replaceWith(largeBodyNode(largeBody.ownerDocument, readBodyText));
  }
  for (const control of content.querySelectorAll("button")) {
    control.remove();
  }
  for (const formula of content.querySelectorAll(FORMULA_SELECTOR)) {
    formula.replaceWith(formulaSourceNode(formula, flavor));
  }
  return withinItsTable(content, part.commonAncestorContainer);
}

/**
 * `content` put back in the table its common ancestor sits in: a copy of the table and of each
 * section and row between it and the ancestor, as a browser wraps a part of a table it copies, so
 * the part still pastes as a table. Only what was selected is copied: a head the part does not
 * reach is left out. A part inside one cell, or outside any table, is left as it is.
 */
function withinItsTable(content: DocumentFragment, commonAncestor: Node): DocumentFragment {
  const ancestor = isElement(commonAncestor) ? commonAncestor : commonAncestor.parentElement;
  const table = ancestor?.closest("table") ?? null;
  if (ancestor === null || table === null || ancestor.closest("td, th") !== null) {
    return content;
  }
  // The elements from the table down to the ancestor, outermost first.
  const between: Element[] = [];
  for (let element: Element | null = ancestor; element !== table; element = element.parentElement) {
    if (element === null) {
      return content;
    }
    between.unshift(element);
  }
  const tableCopy = table.cloneNode(false) as Element;
  let innermost = tableCopy;
  for (const element of between) {
    const elementCopy = element.cloneNode(false) as Element;
    innermost.append(elementCopy);
    innermost = elementCopy;
  }
  innermost.append(content);
  const wrapped = table.ownerDocument.createDocumentFragment();
  wrapped.append(tableCopy);
  return wrapped;
}

/**
 * The node a large body's place becomes: its text read in full, preformatted, so its lines stay
 * lines. Throws for a body with no text, since a copy missing it would look whole.
 */
function largeBodyNode(ownerDocument: Document, readBodyText: () => string | undefined): Node {
  const bodyText = readBodyText();
  if (bodyText === undefined) {
    throw new Error("A copied large body has no text to be read from.");
  }
  const block = ownerDocument.createElement("pre");
  block.append(ownerDocument.createTextNode(bodyText));
  return block;
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
