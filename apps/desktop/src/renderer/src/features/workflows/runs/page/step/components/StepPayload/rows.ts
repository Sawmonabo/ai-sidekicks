// A step payload as the rows its list window draws, so only the rows in view are in the page
// whatever the payload's size. Table rows: each item's number and pairing, each member of its
// data, a markdown string one block at a time, and each file it names. JSON rows: the stored JSON
// cut at its items, which joined back are exactly what was stored. Either is built only as far as
// it is drawn: a string is parsed when its row is first drawn, an item stringified when its row is.

import type {
  WorkflowBinaryRef,
  WorkflowItem,
  WorkflowPairedItem,
} from "@ai-sidekicks/contracts/workflow/definition/document";

import type { MarkdownDocumentRow, ParsedMarkdownDocument } from "./markdown-document-rows.js";
import type { MarkdownRenderContext } from "#renderer/components/Markdown/MarkdownNodes.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import { byteFigurePart, type FigureSentencePart } from "#renderer/lib/figure-sentence.js";

/**
 * Where a value row sits: under a member of an object, naming the member on its first row only,
 * or as an item's whole data.
 */
export type PayloadValuePlace =
  | { readonly kind: "member"; readonly key: string | undefined }
  | { readonly kind: "whole" };

/** One row of the Table view. */
export type PayloadTableRow =
  | { readonly kind: "item"; readonly heading: readonly FigureSentencePart[] }
  /** A value drawn exactly as stored, its line breaks kept. */
  | { readonly kind: "value"; readonly place: PayloadValuePlace; readonly text: string }
  /**
   * A string not yet read as markdown or text, which is read once its row is drawn. `lineCount`
   * sizes the row until then.
   */
  | {
      readonly kind: "unread";
      readonly place: PayloadValuePlace;
      readonly stringIndex: number;
      readonly lineCount: number;
    }
  | {
      readonly kind: "markdown";
      readonly place: PayloadValuePlace;
      readonly row: MarkdownDocumentRow;
      readonly context: MarkdownRenderContext;
    }
  | { readonly kind: "file"; readonly line: readonly FigureSentencePart[] };

/**
 * The Table view's rows, reading each string only once its row is drawn. A string with no
 * whitespace is one token (a name, a path, an id) and draws exactly as stored, so a path like
 * `src/__init__.py` is never read as emphasis. Any other string goes to the markdown parser: it
 * draws as markdown when the parser finds any (a heading, a list, code, emphasis, a link), and
 * otherwise as the text it is, line breaks kept. Item numbers count from 0, as an expression
 * reads them (`$input.all()[0]`), so an item's number and its pairing agree. A read replaces only
 * its own string's row; every other row stays the object it was.
 */
export class PayloadTableRows {
  readonly #parseMarkdown: (text: string) => ParsedMarkdownDocument;
  /** Each string to read as markdown or text, with its place, in the order the rows meet them. */
  readonly #strings: { readonly text: string; readonly place: PayloadValuePlace }[] = [];
  /** Where each string's rows begin, by its place among `#strings`. */
  readonly #stringRowStarts: number[] = [];
  /** The strings read so far, by their place among `#strings`. */
  readonly #readStrings = new Set<number>();
  readonly #rows: PayloadTableRow[] = [];
  /** Each row's key, given the first time it is asked for and kept while the row stands. */
  readonly #rowKeys = new WeakMap<PayloadTableRow, number>();
  #nextRowKey = 0;

  public constructor(
    items: readonly WorkflowItem[],
    parseMarkdown: (text: string) => ParsedMarkdownDocument,
  ) {
    this.#parseMarkdown = parseMarkdown;
    items.forEach((item, index) => {
      this.#rows.push({ kind: "item", heading: itemHeadWords(index, item) });
      forEachValue(item.json, (value, place) => {
        if (!isReadableString(value)) {
          this.#rows.push({ kind: "value", place, text: valueText(value) });
          return;
        }
        const stringIndex = this.#strings.length;
        this.#strings.push({ text: value, place });
        this.#stringRowStarts.push(this.#rows.length);
        this.#rows.push({ kind: "unread", place, stringIndex, lineCount: lineCountOf(value) });
      });
      for (const file of Object.values(item.binary ?? {})) {
        this.#rows.push({ kind: "file", line: fileLine(file) });
      }
    });
  }

  /** The rows as far as the payload has been read. */
  public get rows(): readonly PayloadTableRow[] {
    return this.#rows;
  }

  /**
   * A key for the row at `rowIndex` that stays with that row while reads before it move it down,
   * so the list window keeps each drawn row's measured height. `-1` past the last row.
   */
  public rowKey(rowIndex: number): number {
    const row = this.#rows[rowIndex];
    if (row === undefined) {
      return -1;
    }
    let key = this.#rowKeys.get(row);
    if (key === undefined) {
      key = this.#nextRowKey;
      this.#nextRowKey += 1;
      this.#rowKeys.set(row, key);
    }
    return key;
  }

  /** Read one drawn string as markdown or text. Answers whether the rows changed. */
  public readString(stringIndex: number): boolean {
    const string = this.#strings[stringIndex];
    const start = this.#stringRowStarts[stringIndex];
    if (string === undefined || start === undefined || this.#readStrings.has(stringIndex)) {
      return false;
    }
    this.#readStrings.add(stringIndex);
    const read = this.#readRows(string.text, string.place);
    this.#rows.splice(start, 1, ...read);
    // The strings after it begin as many rows later as this one grew.
    for (let later = stringIndex + 1; later < this.#stringRowStarts.length; later += 1) {
      this.#stringRowStarts[later] = (this.#stringRowStarts[later] ?? 0) + read.length - 1;
    }
    return true;
  }

  /** A string's rows once read: one block of markdown to a row, or the text as one row. */
  #readRows(text: string, place: PayloadValuePlace): PayloadTableRow[] {
    const document = this.#parseMarkdown(text);
    if (!document.holdsMarkdown) {
      return [{ kind: "value", place, text }];
    }
    return document.rows.map((row, index) => ({
      kind: "markdown",
      // The member is named once, beside the document's first row.
      place: index === 0 || place.kind === "whole" ? place : { kind: "member", key: undefined },
      row,
      context: document.context,
    }));
  }
}

/** How many rows the JSON view has: one per item, plus the opening and closing brackets. */
export function payloadJsonRowCount(items: readonly WorkflowItem[]): number {
  return items.length === 0 ? 1 : items.length + 2;
}

/**
 * One row of the JSON view: the opening bracket, one item as indented JSON, or the closing
 * bracket. Every row but the last ends in its line break, so the rows joined are
 * `JSON.stringify(items, null, 2)`.
 */
export function payloadJsonRow(items: readonly WorkflowItem[], rowIndex: number): string {
  if (items.length === 0) {
    return "[]";
  }
  if (rowIndex === 0) {
    return "[\n";
  }
  if (rowIndex > items.length) {
    return "]";
  }
  const itemJson = JSON.stringify(items[rowIndex - 1], null, 2).replaceAll("\n", "\n  ");
  return `  ${itemJson}${rowIndex < items.length ? "," : ""}\n`;
}

/** Whether a value is a string to read as markdown or text: one holding whitespace. */
function isReadableString(value: unknown): value is string {
  return typeof value === "string" && /\s/u.test(value);
}

/** Each value an item's data holds: every member of an object, else the data whole. */
function forEachValue(
  json: unknown,
  visit: (value: unknown, place: PayloadValuePlace) => void,
): void {
  if (isPlainRecord(json)) {
    for (const [key, member] of Object.entries(json)) {
      visit(member, { kind: "member", key });
    }
  } else {
    visit(json, { kind: "whole" });
  }
}

function lineCountOf(text: string): number {
  let count = 1;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    count += 1;
  }
  return count;
}

/** A value as text: a string as written, anything else as its JSON. */
function valueText(value: unknown): string {
  // `JSON.stringify` answers `undefined` for `undefined`, which a member may hold.
  return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
}

/**
 * The item's number, its place in the payload, and where it came from input items, which the
 * pairing sent: `Item 2 · from item 0`.
 */
function itemHeadWords(index: number, item: WorkflowItem): readonly FigureSentencePart[] {
  const head: readonly FigureSentencePart[] = ["Item ", { derived: formatCount(index) }];
  if (item.pairedItem === undefined) {
    return head;
  }
  const sources = Array.isArray(item.pairedItem) ? item.pairedItem : [item.pairedItem];
  return sources.length === 0
    ? head
    : [
        ...head,
        " · from ",
        ...sources.flatMap((source, sourceIndex) => [
          ...(sourceIndex === 0 ? [] : [", "]),
          ...sourceWords(source),
        ]),
      ];
}

/** One input item an item came from, naming its input only where the pairing does. */
function sourceWords(source: WorkflowPairedItem): readonly FigureSentencePart[] {
  const item: readonly FigureSentencePart[] = ["item ", { wire: formatCount(source.item) }];
  return source.input === undefined
    ? item
    : [...item, " of input ", { wire: formatCount(source.input) }];
}

/** The file a binary field names, in place of its reference: `name · type · size`. */
function fileLine(file: WorkflowBinaryRef): readonly FigureSentencePart[] {
  return [
    { wire: file.fileName },
    " · ",
    { wire: file.mimeType },
    " · ",
    byteFigurePart("wire", file.size),
  ];
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
