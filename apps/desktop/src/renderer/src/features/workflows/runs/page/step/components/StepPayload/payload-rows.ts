// A step payload as the rows its list window draws, so only the rows in view are in the page
// whatever the payload's size. Table rows: each item's number and pairing, each member of its
// data, a markdown string one block at a time, and each file it names. JSON rows: the stored JSON
// cut at its items, which joined back are exactly what was stored. Either is built only as far as
// it is drawn: a string is parsed when its row is first drawn, an item stringified when its row is.

import type {
  WorkflowBinaryRef,
  WorkflowItem,
  WorkflowPairedItem,
} from "@ai-sidekicks/contracts/workflow/definition/definition";

import type {
  MarkdownDocumentRow,
  ParsedMarkdownDocument,
} from "#renderer/components/Markdown/markdown-document-rows.js";
import type { MarkdownRenderContext } from "#renderer/components/Markdown/MarkdownNodes.js";
import { formatByteQuantity, formatCount } from "#renderer/lib/wire/figures.js";

/**
 * Where a value row sits: under a member of an object, naming the member on its first row only,
 * or as an item's whole data.
 */
export type PayloadValuePlace =
  | { readonly kind: "member"; readonly key: string | undefined }
  | { readonly kind: "whole" };

/** One row of the Table view. */
export type PayloadTableRow =
  | { readonly kind: "item"; readonly heading: string }
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
  | { readonly kind: "file"; readonly line: string };

/**
 * The Table view's rows, reading each string only once its row is drawn. A string with no
 * whitespace is one token (a name, a path, an id) and draws exactly as stored, so a path like
 * `src/__init__.py` is never read as emphasis. Any other string goes to the markdown parser: it
 * draws as markdown when the parser finds any (a heading, a list, code, emphasis, a link), and
 * otherwise as the text it is, line breaks kept. Item numbers count from 0, as an expression
 * reads them (`$input.all()[0]`), so an item's number and its pairing agree.
 */
export class PayloadTableRows {
  readonly #items: readonly WorkflowItem[];
  readonly #parseMarkdown: (text: string) => ParsedMarkdownDocument;
  /** The strings to read as markdown or text, in the order the rows meet them. */
  readonly #strings: string[] = [];
  /** Each string read so far, by its place among `#strings`: markdown, or text. */
  readonly #readings = new Map<number, ParsedMarkdownDocument | "text">();
  #rows: readonly PayloadTableRow[];

  public constructor(
    items: readonly WorkflowItem[],
    parseMarkdown: (text: string) => ParsedMarkdownDocument,
  ) {
    this.#items = items;
    this.#parseMarkdown = parseMarkdown;
    for (const item of items) {
      forEachValue(item.json, (value) => {
        if (isReadableString(value)) {
          this.#strings.push(value);
        }
      });
    }
    this.#rows = this.#buildRows();
  }

  /** The rows as far as the payload has been read. */
  public get rows(): readonly PayloadTableRow[] {
    return this.#rows;
  }

  /** Read one drawn string as markdown or text. Answers whether the rows changed. */
  public readString(stringIndex: number): boolean {
    if (this.#readings.has(stringIndex)) {
      return false;
    }
    const text = this.#strings[stringIndex];
    if (text === undefined) {
      return false;
    }
    const document = this.#parseMarkdown(text);
    this.#readings.set(stringIndex, document.holdsMarkdown ? document : "text");
    this.#rows = this.#buildRows();
    return true;
  }

  #buildRows(): PayloadTableRow[] {
    const rows: PayloadTableRow[] = [];
    let stringIndex = 0;
    const addValue = (value: unknown, place: PayloadValuePlace): void => {
      if (!isReadableString(value)) {
        rows.push({ kind: "value", place, text: valueText(value) });
        return;
      }
      const reading = this.#readings.get(stringIndex);
      if (reading === undefined) {
        rows.push({ kind: "unread", place, stringIndex, lineCount: lineCountOf(value) });
      } else if (reading === "text") {
        rows.push({ kind: "value", place, text: value });
      } else {
        reading.rows.forEach((row, index) => {
          rows.push({
            kind: "markdown",
            // The member is named once, beside the document's first row.
            place:
              index === 0 || place.kind === "whole" ? place : { kind: "member", key: undefined },
            row,
            context: reading.context,
          });
        });
      }
      stringIndex += 1;
    };
    this.#items.forEach((item, index) => {
      rows.push({ kind: "item", heading: itemHeadWords(index, item) });
      forEachValue(item.json, addValue);
      for (const file of Object.values(item.binary ?? {})) {
        rows.push({ kind: "file", line: fileLine(file) });
      }
    });
    return rows;
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

/** The item's number and, where it came from input items, which: `Item 2 · from item 0`. */
function itemHeadWords(index: number, item: WorkflowItem): string {
  const head = `Item ${formatCount(index)}`;
  if (item.pairedItem === undefined) {
    return head;
  }
  const sources = Array.isArray(item.pairedItem) ? item.pairedItem : [item.pairedItem];
  return sources.length === 0 ? head : `${head} · from ${sources.map(sourceWords).join(", ")}`;
}

/** One input item an item came from, naming its input only where the pairing does. */
function sourceWords(source: WorkflowPairedItem): string {
  const item = `item ${formatCount(source.item)}`;
  return source.input === undefined ? item : `${item} of input ${formatCount(source.input)}`;
}

/** The file a binary field names, in place of its reference: `name · type · size`. */
function fileLine(file: WorkflowBinaryRef): string {
  return [file.fileName, file.mimeType, formatByteQuantity(file.size).text].join(" · ");
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
