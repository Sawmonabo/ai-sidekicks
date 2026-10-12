// What a selection in the conversation copies of each row it runs across; `conversation-copy.ts`
// joins the parts in log order. The rows come from the viewport's record of the selection, not from
// the drawn rows, so rows the window let go between its ends are copied too. Each end row gives the
// part selected in it as it was drawn, and every row between gives its whole text from the source
// it is drawn from (`row-text.ts`). A long table's rows and a command output's lines the window has
// not drawn inside an end row's part are read from the source the screen drew them from, named by
// each spacer, so a copy never waits for them to draw (`undrawn-items.ts`). A long part is read
// into its text by the markdown worker, so its part comes once the worker answers. A part inside
// one table is copied as a table of what was selected. A message row gives only its body, never its
// author line, stamp or controls: a reply's part as the markdown rebuilt from what was selected,
// and the person's own message or a reasoning aside as plain text. Any other row gives the text
// selected in it. Plain text is read the way the screen lays it out, a block's lines on lines of
// their own, and no control's label is ever part of it. An end row's part that reaches a large
// body, which draws only its control, holds the body read in full in the control's place, from
// where the part begins, so the body is never dropped and the control's words never copied; a
// message's body is its row's text, so its part is the whole. A formula copies as its TeX source,
// whole, once. A selection crossing the conversation copies only the conversation's part.

import { isElement } from "@floating-ui/utils/dom";
import { fromDom } from "hast-util-from-dom";

import { type CopyFlavor } from "#renderer/components/Markdown/drawn-text.js";
import {
  makeDrawnText,
  type DrawnPartCopy,
  type MarkdownWorkerConnection,
} from "#renderer/components/Markdown/worker/connection.js";
import type { PiecedText } from "#renderer/lib/text/pieces.js";
import { resolveRowTextPosition } from "../viewport/selection/preservation.js";
import { type RowSelection } from "../viewport/selection/record.js";
import { type DrawnWindowSource } from "#renderer/components/TranscriptBodyViewport/drawn-window-sources.js";
import { withUndrawnItems, withUndrawnItemsText } from "./undrawn-items.js";

/** One row's share of a copy: its text, and the flavor it copies as. */
export interface SelectedPart {
  readonly flavor: CopyFlavor;
  readonly text: string;
  /**
   * A long text the copy read in pieces, which `text` joins: work on the page reads it a piece at
   * a time, never `text` whole.
   */
  readonly pieces?: readonly string[];
  /** The part's formatted flavor, when the markdown worker made it with the part's text. */
  readonly html?: PiecedText;
}

/** A selection across the conversation's rows, as a copy reads it. */
export interface RowSpanSelection {
  readonly selection: RowSelection;
  /** The keys of the rows it runs across, in log order. */
  readonly rowKeys: readonly string[];
  /** An end row as it was drawn, or `undefined` when no drawing of it is kept. */
  readonly endRowElement: (rowKey: string) => Element | undefined;
  /**
   * A whole row's text from the source it is drawn from, at once or once it is read in slices, or
   * `undefined` for a row with none.
   */
  readonly rowText: (rowKey: string) => SelectedPart | Promise<SelectedPart> | undefined;
  /**
   * The text of a row's body alone, from the same source, which an end row's part reads a large
   * body from; `undefined` for a row that draws no body.
   */
  readonly rowBodyText: (rowKey: string) => string | undefined;
  /** The source a spacer's key names, which its undrawn items are read from. */
  readonly drawnSourceOf: (sourceKey: string) => DrawnWindowSource | undefined;
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
 * The part of a drawn row that `range` selects: at once, or once the items its windows have not
 * drawn are read in slices or `markdownWorker` has read a long part into its text, rejecting with
 * the worker's `Error`; the row is read before anything is waited on. `readBodyText` reads the text
 * of the row's body, which a large body drawn as its control is read from, only when the part holds
 * one; `drawnSourceOf` answers the source a spacer names. Throws when the part holds a large body
 * and the body has no text, or a spacer whose source is not held.
 */
export function readSelectedPart(
  range: Range,
  row: Element,
  readBodyText: () => string | undefined,
  markdownWorker: Pick<MarkdownWorkerConnection, "drawnText">,
  drawnSourceOf: (sourceKey: string) => DrawnWindowSource | undefined,
): SelectedPart | Promise<SelectedPart> {
  const body = row.querySelector(`[${COPY_FLAVOR_ATTRIBUTE}]`);
  // A selection holding only the row's author line or controls clamps to nothing in its body.
  const part = clampedTo(range, body ?? row);
  const flavor = body?.getAttribute(COPY_FLAVOR_ATTRIBUTE) === "markdown" ? "markdown" : "text";
  const reading = withUndrawnItems(
    fromDom(selectedContentOf(part, flavor, readBodyText)),
    flavor,
    drawnSourceOf,
  );
  const drawnText = makeDrawnText(reading.tree, flavor, reading.tables, markdownWorker);
  if (reading.textRuns.length > 0) {
    const text =
      drawnText instanceof Promise ? drawnText.then((made) => made.text) : drawnText.text;
    return withUndrawnItemsText(text, reading.textRuns, viewOf(row)).then((withItems) =>
      partOf(flavor, { text: withItems }),
    );
  }
  return drawnText instanceof Promise
    ? drawnText.then((made) => partOf(flavor, made))
    : partOf(flavor, drawnText);
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
  return readSelectedPart(
    range,
    rowElement,
    () => span.rowBodyText(rowKey),
    span.markdownWorker,
    span.drawnSourceOf,
  );
}

/**
 * What `part` holds, with a large body's place holding the body read in full as preformatted text,
 * without the controls or the hidden frames drawn among it, and with each formula as its TeX
 * source: as text, or as a math block the markdown rebuild reads as one. A part inside one table,
 * between rows or cells, is put back in that table, so it copies as a table rather than as loose
 * rows.
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
  // A button's label is no one's text, and an inert frame is drawn hidden only to measure rows.
  for (const unread of content.querySelectorAll("button, [inert]")) {
    unread.remove();
  }
  for (const formula of content.querySelectorAll(FORMULA_SELECTOR)) {
    formula.replaceWith(formulaSourceNode(formula, flavor));
  }
  const tableContent = withinItsTable(content, part.commonAncestorContainer);
  return flavor === "text"
    ? withinItsPreformattedBox(tableContent, part.commonAncestorContainer)
    : tableContent;
}

/**
 * `content` put back in the preformatted box its common ancestor sits in, a copy of the box alone,
 * as a browser wraps a part of one it copies, so the part's text keeps its lines and spaces. A part
 * reaching past the box holds its own copy of it, and is left as it is.
 */
function withinItsPreformattedBox(
  content: DocumentFragment,
  commonAncestor: Node,
): DocumentFragment {
  const ancestor = isElement(commonAncestor) ? commonAncestor : commonAncestor.parentElement;
  const box = ancestor?.closest("pre") ?? null;
  if (box === null) {
    return content;
  }
  const boxCopy = box.cloneNode(false) as Element;
  boxCopy.append(content);
  const wrapped = box.ownerDocument.createDocumentFragment();
  wrapped.append(boxCopy);
  return wrapped;
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

/**
 * The node a copied formula becomes: its TeX source, and for the markdown flavor an inline formula
 * as inline math and a display one fenced as math.
 */
function formulaSourceNode(formula: Element, flavor: CopyFlavor): Node {
  const ownerDocument = formula.ownerDocument;
  const source = ownerDocument.createTextNode(formulaSourceOf(formula));
  if (flavor === "text") {
    return source;
  }
  const code = ownerDocument.createElement("code");
  code.append(source);
  if (formula.getAttribute("data-math") === "inline") {
    code.setAttribute("data-language", "math");
    return code;
  }
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

/** The part `made` makes in `flavor`, its pieces kept when it has more than one. */
function partOf(flavor: CopyFlavor, made: DrawnPartCopy): SelectedPart {
  const { text, pieces } = made.text;
  return {
    flavor,
    text,
    ...(pieces.length > 1 ? { pieces } : {}),
    ...(made.html === undefined ? {} : { html: made.html }),
  };
}

/** The window `row` is drawn in. Throws for a row whose window has closed. */
function viewOf(row: Element): Window {
  const view = row.ownerDocument.defaultView;
  if (view === null) {
    throw new Error("A copied row's window has closed.");
  }
  return view;
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
