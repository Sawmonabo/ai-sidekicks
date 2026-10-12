// A step payload as the rows its list window draws, so only the rows in view are in the page
// whatever the payload's size. Table rows: each item's number and pairing, each member of its
// data, a markdown string one block at a time, and each file it names. JSON rows: the stored JSON
// cut at its items, which joined back are exactly what was stored. Either is built only as far as
// it is drawn: strings are parsed in order as the list nears its end, an item stringified when its
// row is.

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

/** What reading one string as a markdown document came to: its rows, or why it has none. */
export type MarkdownDocumentOutcome =
  | { readonly status: "read"; readonly document: ParsedMarkdownDocument }
  | { readonly status: "failed"; readonly reason: string };

/** Reads one string as a markdown document and hands `settle` what that came to, once. */
export type MarkdownDocumentRead = (
  text: string,
  settle: (outcome: MarkdownDocumentOutcome) => void,
) => void;

/** One row of the Table view. */
export type PayloadTableRow =
  | { readonly kind: "item"; readonly heading: readonly FigureSentencePart[] }
  /** A value drawn exactly as stored, its line breaks kept. */
  | { readonly kind: "value"; readonly place: PayloadValuePlace; readonly text: string }
  | {
      readonly kind: "markdown";
      readonly place: PayloadValuePlace;
      readonly row: MarkdownDocumentRow;
      readonly context: MarkdownRenderContext;
    }
  | { readonly kind: "file"; readonly line: readonly FigureSentencePart[] };

/**
 * The Table view's rows, drawn only as far as every string before them is read: a string's rows
 * join the end of the list once its parse lands and every string before it has, so no row is ever
 * drawn before what it shows is ready, and the list only grows at its end. The rows still waiting
 * are counted in lines, a string by its own and any other row as one, so the list can keep their
 * room below it. A string with no
 * whitespace is one token (a name, a path, an id) and draws exactly as stored, so a path like
 * `src/__init__.py` is never read as emphasis. Any other string goes to the markdown parser: it
 * draws as markdown when the parser finds any (a heading, a list, code, emphasis, a link), and
 * otherwise as the text it is, line breaks kept. Item numbers count from 0, as an expression
 * reads them (`$input.all()[0]`), so an item's number and its pairing agree.
 */
export class PayloadTableRows {
  readonly #readMarkdown: MarkdownDocumentRead;
  /** The rows drawn, every string before the last of them read. */
  readonly #rows: PayloadTableRow[] = [];
  /** Every row after them, oldest first: a row ready to draw, or a string still to read. */
  readonly #waiting: WaitingRow[] = [];
  /** The waiting strings asked to be read. */
  readonly #asked = new Set<WaitingRow>();
  /** How many lines the waiting rows stand for. */
  #waitingLineCount = 0;
  /** Why a string's parse failed, once one has. */
  #failure: string | undefined;

  public constructor(items: readonly WorkflowItem[], readMarkdown: MarkdownDocumentRead) {
    this.#readMarkdown = readMarkdown;
    items.forEach((item, index) => {
      this.#wait({
        kind: "ready",
        row: { kind: "item", heading: itemHeadWords(index, item) },
      });
      forEachValue(item.json, (value, place) => {
        this.#wait(
          isReadableString(value)
            ? { kind: "string", text: value, place, lineCount: lineCountOf(value), rows: undefined }
            : { kind: "ready", row: { kind: "value", place, text: valueText(value) } },
        );
      });
      for (const file of Object.values(item.binary ?? {})) {
        this.#wait({ kind: "ready", row: { kind: "file", line: fileLine(file) } });
      }
    });
    this.#drawWhatIsReady();
  }

  /** The rows drawn so far, in order; the list only grows, at its end. */
  public get rows(): readonly PayloadTableRow[] {
    return this.#rows;
  }

  /** How many lines the rows not yet drawn stand for: a string's own, one for any other row. */
  public get waitingLineCount(): number {
    return this.#waitingLineCount;
  }

  /** Why a string's parse failed, or `undefined` while none has. */
  public get failure(): string | undefined {
    return this.#failure;
  }

  /**
   * Read, in order, every string among the waiting rows that stand for the next `lineCount` lines,
   * those not asked for before. As each parse lands, the rows it lets draw join the list, and
   * `onRead` hears that the rows changed, or that a parse failed.
   */
  public readAhead(lineCount: number, onRead: () => void): void {
    const toRead: Extract<WaitingRow, { readonly kind: "string" }>[] = [];
    let lines = 0;
    for (const waiting of this.#waiting) {
      if (lines >= lineCount) {
        break;
      }
      lines += waiting.kind === "string" ? waiting.lineCount : 1;
      if (waiting.kind === "string" && !this.#asked.has(waiting)) {
        toRead.push(waiting);
      }
    }
    for (const string of toRead) {
      // Marked before the read, which a kept tree answers at once by drawing the string.
      this.#asked.add(string);
      this.#readMarkdown(string.text, (outcome) => {
        if (outcome.status === "failed") {
          this.#failure = outcome.reason;
        } else {
          string.rows = this.#rowsOf(string.text, string.place, outcome.document);
          this.#drawWhatIsReady();
        }
        onRead();
      });
    }
  }

  /** Move the waiting rows that are ready, up to the first string still being read, to the list. */
  #drawWhatIsReady(): void {
    let drawnCount = 0;
    for (const waiting of this.#waiting) {
      if (waiting.kind === "ready") {
        this.#rows.push(waiting.row);
        this.#waitingLineCount -= 1;
      } else if (waiting.rows === undefined) {
        break;
      } else {
        this.#rows.push(...waiting.rows);
        this.#asked.delete(waiting);
        this.#waitingLineCount -= waiting.lineCount;
      }
      drawnCount += 1;
    }
    this.#waiting.splice(0, drawnCount);
  }

  #wait(waiting: WaitingRow): void {
    this.#waiting.push(waiting);
    this.#waitingLineCount += waiting.kind === "string" ? waiting.lineCount : 1;
  }

  /** A string's rows once read: one block of markdown to a row, or the text as one row. */
  #rowsOf(
    text: string,
    place: PayloadValuePlace,
    document: ParsedMarkdownDocument,
  ): PayloadTableRow[] {
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

/** A Table view row not drawn yet: ready to draw, or a string whose read has not landed. */
type WaitingRow =
  | { readonly kind: "ready"; readonly row: PayloadTableRow }
  | {
      readonly kind: "string";
      readonly text: string;
      readonly place: PayloadValuePlace;
      /** How many lines its text holds. */
      readonly lineCount: number;
      /** Its rows once its read lands. */
      rows: readonly PayloadTableRow[] | undefined;
    };

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
  const head: readonly FigureSentencePart[] = [`Item ${formatCount(index)}`];
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
