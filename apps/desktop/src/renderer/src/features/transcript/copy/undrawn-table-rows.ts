// A long table's rows the window has not drawn, read back into a copy from the parse the screen
// drew the table from. Each spacer row standing for undrawn rows names its table, which the feed
// holds while it is drawn, and the first and last row it stands for. Copied as markdown, the spacer
// names its table, whose block's text goes beside the part, and the drawn part's reading parses the
// block again in its place, so the part's columns are padded in one pass, off the page's thread.
// Copied as text, the spacer becomes a marker row, and the rows' text is read from the held table
// on the page a few rows at a time, then put in the marker's place, the text kept in pieces.

import type { Table } from "mdast";

import {
  drawnRowsText,
  markUndrawnRows,
  type DrawnElement,
  type DrawnTree,
} from "#renderer/components/Markdown/drawn-text.js";
import { type BlockParseSource } from "#renderer/components/Markdown/parse.js";
import { joinPieces, piecesOf, type PiecedText } from "#renderer/lib/text-pieces.js";
import { workInSlices } from "#renderer/lib/work-slices.js";
import { type DrawnLongTable } from "../rows/markdown/table-window/drawn-tables.js";

/** A drawn part's tree with its undrawn rows made ready to read. */
export interface UndrawnRowsReading {
  readonly tree: DrawnTree;
  /** What each table's block was parsed from, by its key, for a part copied as markdown. */
  readonly blockSources: ReadonlyMap<string, BlockParseSource>;
  /** The rows each marker row stands for, in drawn order, for a part copied as text. */
  readonly textRuns: readonly UndrawnRowsTextRun[];
}

/** A run of undrawn rows copied as text. */
export interface UndrawnRowsTextRun {
  readonly table: Table;
  readonly firstIndex: number;
  readonly lastIndex: number;
}

/**
 * `tree` with each spacer row ready to read in `flavor`: copied as markdown, naming its table and
 * rows, its table's block listed; as text, a marker row, its rows listed. `drawnTableOf` answers
 * the table a spacer's key names. Throws for a spacer whose table is not held, since a copy missing
 * rows would look whole.
 */
export function withUndrawnTableRows(
  tree: DrawnTree,
  flavor: "markdown" | "text",
  drawnTableOf: (tableKey: string) => DrawnLongTable | undefined,
): UndrawnRowsReading {
  const blockSources = new Map<string, BlockParseSource>();
  const textRuns: UndrawnRowsTextRun[] = [];
  if ("children" in tree) {
    readSpacers(tree, (spacer, tableKey, firstIndex, lastIndex): DrawnElement => {
      const drawnTable = drawnTableOf(tableKey);
      if (drawnTable === undefined) {
        throw new Error("A copied table's undrawn rows have no table to be read from.");
      }
      if (flavor === "text") {
        textRuns.push({ table: drawnTable.table, firstIndex, lastIndex });
        return markerRow();
      }
      if (!blockSources.has(tableKey)) {
        blockSources.set(tableKey, drawnTable.readBlockParseSource());
      }
      markUndrawnRows(spacer, {
        tableKey,
        tableStart: drawnTable.table.position?.start.offset ?? 0,
        firstIndex,
        lastIndex,
      });
      return spacer;
    });
  }
  return { tree, blockSources, textRuns };
}

/**
 * `drawnText`, read from a tree `withUndrawnTableRows` made, with each of `textRuns`' rows read as
 * text in its marker's place, a few rows a slice in `view`, the text in pieces. Throws when the
 * text holds the markers other than once each.
 */
export async function withUndrawnRowsText(
  drawnText: PiecedText | Promise<PiecedText>,
  textRuns: readonly UndrawnRowsTextRun[],
  view: Window,
): Promise<PiecedText> {
  const runPieces: string[][] = [];
  for (const run of textRuns) {
    runPieces.push(await undrawnRowsPieces(run, view));
  }
  const pieces: string[] = [];
  let runIndex = 0;
  for (const piece of (await drawnText).pieces) {
    const [first = "", ...afterMarkers] = piece.split(UNDRAWN_ROWS_MARKER);
    pieces.push(first);
    for (const after of afterMarkers) {
      const rows = runPieces[runIndex];
      if (rows === undefined) {
        throw new Error("A copied table's undrawn rows lost their place in the text.");
      }
      pieces.push(...rows, after);
      runIndex += 1;
    }
  }
  if (runIndex !== runPieces.length) {
    throw new Error("A copied table's undrawn rows lost their place in the text.");
  }
  return { text: joinPieces(pieces), pieces };
}

/**
 * How many rows one read takes. Measured on a loaded machine, twenty of a 2 MiB table's rows read
 * in 1.9 ms at worst, which fits a slice of copy work inside a frame.
 */
const ROWS_PER_READ = 20;

/**
 * What a marker row reads as: a noncharacter, which Unicode keeps for a program's own use and no
 * text exchanged holds. One code unit, so no piece of the text cuts it in two.
 */
const UNDRAWN_ROWS_MARKER = "\uFDD0";

/** The text of `run`'s rows in pieces, a line each, read a few rows at a time in `view`. */
async function undrawnRowsPieces(run: UndrawnRowsTextRun, view: Window): Promise<string[]> {
  const pieces: string[] = [];
  let nextIndex = run.firstIndex;
  await workInSlices(
    view,
    (hasTime) => {
      do {
        const lastIndex = Math.min(nextIndex + ROWS_PER_READ - 1, run.lastIndex);
        const rowsText = drawnRowsText(run.table, nextIndex, lastIndex);
        pieces.push(...piecesOf(lastIndex < run.lastIndex ? `${rowsText}\n` : rowsText));
        nextIndex = lastIndex + 1;
      } while (nextIndex <= run.lastIndex && hasTime());
      return nextIndex > run.lastIndex;
    },
    () => false,
  );
  return pieces;
}

/** A node of a drawn tree that holds children. */
type ParentNode = Extract<DrawnTree, { children: unknown }>;

/**
 * Puts what `readSpacer` answers for each spacer row under `parent` in its place, handing it the
 * spacer, its table's key and the first and last row it stands for.
 */
function readSpacers(
  parent: ParentNode,
  readSpacer: (
    spacer: DrawnElement,
    tableKey: string,
    firstIndex: number,
    lastIndex: number,
  ) => DrawnElement,
): void {
  parent.children = parent.children.map((child) => {
    if (child.type !== "element") {
      return child;
    }
    const tableKey = child.properties[TABLE_KEY_PROPERTY];
    const firstIndex = numberOf(child.properties[FIRST_UNDRAWN_ROW_PROPERTY]);
    const lastIndex = numberOf(child.properties[LAST_UNDRAWN_ROW_PROPERTY]);
    if (
      child.tagName === "tr" &&
      typeof tableKey === "string" &&
      firstIndex !== undefined &&
      lastIndex !== undefined
    ) {
      return readSpacer(child, tableKey, firstIndex, lastIndex);
    }
    readSpacers(child, readSpacer);
    return child;
  });
}

/**
 * The properties the DOM reader names a spacer's `MARKDOWN_TABLE_KEY_ATTRIBUTE`,
 * `MARKDOWN_FIRST_UNDRAWN_ROW_ATTRIBUTE` and `MARKDOWN_LAST_UNDRAWN_ROW_ATTRIBUTE` by.
 */
const TABLE_KEY_PROPERTY = "dataMarkdownTable";
const FIRST_UNDRAWN_ROW_PROPERTY = "dataMarkdownFirstUndrawnRow";
const LAST_UNDRAWN_ROW_PROPERTY = "dataMarkdownLastUndrawnRow";

/** A property's number, read as the DOM reader keeps it: a number, or the attribute's text. */
function numberOf(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

/** A row of one cell holding the marker, which reads as a row of the table in the text. */
function markerRow(): DrawnElement {
  return {
    type: "element",
    tagName: "tr",
    properties: {},
    children: [
      {
        type: "element",
        tagName: "td",
        properties: {},
        children: [{ type: "text", value: UNDRAWN_ROWS_MARKER }],
      },
    ],
  };
}
