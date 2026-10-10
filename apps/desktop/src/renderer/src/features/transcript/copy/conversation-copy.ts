// A copy of the conversation's rows, built a slice at a time so no copy holds a frame however many
// rows it runs across: each row's part in log order, then, whenever a reply is part of it, the
// formatted flavor a part at a time, joined by a blank line into the content of one clipboard
// write. A large body is read in full just before its row and let go once the row's part is read,
// so a copy holds one at a time. A copy built in slices is the same bytes as one built at once.

import type { HydratedSessionEventContent } from "@ai-sidekicks/contracts/event/envelope";
import { toHtml } from "hast-util-to-html";

import type { TextClipboardContent } from "#shared/preload-api.js";
import { RefusalError } from "#renderer/lib/refusal/contract.js";
import { workInSlices } from "#renderer/lib/work-slices.js";
import { type FullBodyReads } from "../rows/full-body-reads.js";
import { type RowSelection } from "../viewport/selection/record.js";
import { markdownToHtml } from "./clipboard-flavors.js";
import {
  PART_SEPARATOR,
  readRowPart,
  type RowSpanSelection,
  type SelectedPart,
} from "./conversation-selection.js";

/** A large body a copy read in full, by its row's id; `undefined` for a body not read. */
export type FullBodyOf = (rowId: string) => HydratedSessionEventContent | undefined;

/** The rows a copy runs across, and where each one's text is read. */
export interface ConversationCopyRows {
  readonly selection: RowSelection;
  /** The keys of the rows the selection runs across, in log order. */
  readonly rowKeys: readonly string[];
  /** An end row as it is drawn, or `undefined` when no drawing of it is kept. */
  readonly endRowElement: (rowKey: string) => Element | undefined;
  /** A whole row's text, its large body as `fullBodyOf` holds it. */
  readonly rowText: (rowKey: string, fullBodyOf: FullBodyOf) => SelectedPart | undefined;
  /** The text of a row's body alone, read as `rowText` reads it. */
  readonly rowBodyText: (rowKey: string, fullBodyOf: FullBodyOf) => string | undefined;
  /** The id of the row whose large body its text reads, which is read in full first. */
  readonly largeBodyRowIdOf: (rowKey: string) => string | undefined;
  /** What a large body is read in full through, or `undefined` where none is read. */
  readonly fullBodyReads: Pick<FullBodyReads, "readFullBody"> | undefined;
}

/**
 * Where a copy's build stands: built, holding its content (`undefined` when no row holds
 * copyable text, so the platform's own copy stands), or not yet.
 */
export type ConversationCopyStep =
  | { readonly isBuilt: true; readonly content: TextClipboardContent | undefined }
  | { readonly isBuilt: false };

/**
 * One copy of the conversation's rows, built a slice at a time: `buildWhile` builds what one slice
 * has time for, and `finish` builds the rest in slices, reading each large body as its row comes.
 */
export class ConversationCopyBuild {
  readonly #rows: ConversationCopyRows;
  readonly #span: RowSpanSelection;
  #rowIndex = 0;
  /** The parts read so far that hold text. */
  readonly #parts: SelectedPart[] = [];
  /** The formatted flavor of each part made so far. */
  readonly #partHtml: string[] = [];
  /** The large body the next row reads, once it is read in full. */
  #fullBody: { readonly rowId: string; readonly content: HydratedSessionEventContent } | undefined;
  /** The id of the next row's large body while it waits to be read in full. */
  #unreadBodyRowId: string | undefined;
  #step: ConversationCopyStep = NOT_BUILT;

  public constructor(rows: ConversationCopyRows) {
    this.#rows = rows;
    const fullBodyOf: FullBodyOf = (rowId) =>
      this.#fullBody?.rowId === rowId ? this.#fullBody.content : undefined;
    this.#span = {
      selection: rows.selection,
      rowKeys: rows.rowKeys,
      endRowElement: (rowKey) => rows.endRowElement(rowKey),
      rowText: (rowKey) => rows.rowText(rowKey, fullBodyOf),
      rowBodyText: (rowKey) => rows.rowBodyText(rowKey, fullBodyOf),
    };
  }

  /**
   * Builds one part after another while `hasTime` answers true, one at the least, and stops
   * before a row whose large body is still to be read in full.
   */
  public buildWhile(hasTime: () => boolean): ConversationCopyStep {
    this.#step = this.#buildWhile(hasTime);
    return this.#step;
  }

  /**
   * Builds the rest of the copy in slices in `view`, reading each large body in full, one at a
   * time, as its row comes. Resolves `undefined` once `isCurrent` answers false, as when a newer
   * copy took over; throws a `RefusalError` when a body's read is refused, so nothing is copied.
   */
  public async finish(
    view: Window,
    isCurrent: () => boolean,
  ): Promise<TextClipboardContent | undefined> {
    for (;;) {
      if (this.#step.isBuilt) {
        return this.#step.content;
      }
      const isStopped = !(await this.#readUnreadBody(isCurrent));
      if (isStopped) {
        return undefined;
      }
      const isDone = await workInSlices(
        view,
        (hasTime) => this.buildWhile(hasTime).isBuilt || this.#unreadBodyRowId !== undefined,
        () => !isCurrent(),
      );
      if (!isDone) {
        return undefined;
      }
    }
  }

  #buildWhile(hasTime: () => boolean): ConversationCopyStep {
    const { rowKeys } = this.#rows;
    while (this.#rowIndex < rowKeys.length) {
      if (!this.#readNextRow()) {
        return NOT_BUILT;
      }
      if (!hasTime()) {
        return NOT_BUILT;
      }
    }
    const parts = this.#parts;
    if (parts.length === 0) {
      return { isBuilt: true, content: undefined };
    }
    if (!parts.some((part) => part.flavor === "markdown")) {
      return { isBuilt: true, content: { text: textOf(parts) } };
    }
    while (this.#partHtml.length < parts.length) {
      const part = parts[this.#partHtml.length] ?? throwLostPlace("a part follows the last made");
      this.#partHtml.push(partHtmlOf(part));
      if (!hasTime() && this.#partHtml.length < parts.length) {
        return NOT_BUILT;
      }
    }
    return { isBuilt: true, content: { text: textOf(parts), html: this.#partHtml.join("") } };
  }

  /**
   * Reads the next row's part, its large body let go after it; `false`, reading nothing, when the
   * row's large body is still to be read in full.
   */
  #readNextRow(): boolean {
    const rowKey =
      this.#rows.rowKeys[this.#rowIndex] ?? throwLostPlace("a row follows the last read");
    const largeBodyRowId =
      this.#rows.fullBodyReads === undefined ? undefined : this.#rows.largeBodyRowIdOf(rowKey);
    if (largeBodyRowId !== undefined && this.#fullBody?.rowId !== largeBodyRowId) {
      this.#unreadBodyRowId = largeBodyRowId;
      return false;
    }
    const part = readRowPart(this.#span, rowKey);
    if (part !== undefined && part.text.trim() !== "") {
      this.#parts.push(part);
    }
    this.#fullBody = undefined;
    this.#rowIndex += 1;
    return true;
  }

  /** Reads in full the large body the next row waits on; `false` once a newer copy took over. */
  async #readUnreadBody(isCurrent: () => boolean): Promise<boolean> {
    const rowId = this.#unreadBodyRowId;
    const fullBodyReads = this.#rows.fullBodyReads;
    if (rowId === undefined || fullBodyReads === undefined) {
      return true;
    }
    const reply = await fullBodyReads.readFullBody(rowId);
    if (!isCurrent()) {
      return false;
    }
    if (reply.status === "refused") {
      throw new RefusalError(reply.refusal);
    }
    this.#fullBody = { rowId, content: reply.value };
    this.#unreadBodyRowId = undefined;
    return true;
  }
}

const NOT_BUILT: ConversationCopyStep = { isBuilt: false };

/** The text of a copy's parts, a blank line between each. */
function textOf(parts: readonly SelectedPart[]): string {
  return parts.map((part) => part.text).join(PART_SEPARATOR);
}

/** A part's formatted flavor: a reply's markdown as the screen draws it, other text as itself. */
function partHtmlOf(part: SelectedPart): string {
  return part.flavor === "markdown" ? markdownToHtml(part.text) : plainHtml(part.text);
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

function throwLostPlace(what: string): never {
  throw new Error(`A copy lost its place: ${what}.`);
}
