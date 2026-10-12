// A window's items it has not drawn, read back into a copy from the source the screen drew them
// from: a long table's rows from its parse, and a text window's items, a command output's chunks
// of lines or a diff's steps of rows, from their text. Each spacer standing for undrawn items names
// its source, which the feed holds while it is drawn, and the first and last item it stands for.
// Copied as markdown, a table's spacer row names its table and rows, and the drawn part's reading,
// off the page's thread, asks the page for the table's rows a slice at a time, its columns padded
// as the whole table's are. Copied as text, a spacer becomes a marker, a marker row in a table, and
// the items' text is read from the held source on the page a few items at a time, then put in the
// marker's place, the text kept in pieces. A text window copies only as text.

import type { Table } from "mdast";

import { type DrawnWindowSource } from "#renderer/components/TranscriptBodyViewport/drawn-window-sources.js";
import {
  drawnRowsText,
  escapeMarkers,
  MARKER_ESCAPE,
  markUndrawnRows,
  UNDRAWN_ROWS_MARKER,
  withoutMarkerEscapes,
  type DrawnElement,
  type DrawnTree,
} from "#renderer/components/Markdown/drawn-text.js";
import { joinPieces, piecesOf, type PiecedText } from "#renderer/lib/text-pieces.js";
import { workInSlices } from "#renderer/lib/work-slices.js";

/** A drawn part's tree with its undrawn items made ready to read. */
export interface UndrawnItemsReading {
  readonly tree: DrawnTree;
  /** The tables the undrawn rows are read from, by their key, for a part copied as markdown. */
  readonly tables: ReadonlyMap<string, Table>;
  /** The items each marker stands for, in drawn order, for a part copied as text. */
  readonly textRuns: readonly UndrawnTextRun[];
}

/** A run of undrawn items copied as text: a table's rows, or a text window's items. */
export type UndrawnTextRun =
  | {
      readonly kind: "table";
      readonly table: Table;
      readonly firstIndex: number;
      readonly lastIndex: number;
    }
  | {
      readonly kind: "text";
      readonly itemText: (index: number) => string;
      readonly itemSeparator: string;
      readonly firstIndex: number;
      readonly lastIndex: number;
    };

/**
 * `tree` with each spacer ready to read in `flavor`: a table's spacer row, copied as markdown,
 * naming its table and rows, its table listed; as text, a marker row, its rows listed; a text
 * window's spacer a marker, its items listed. `drawnSourceOf` answers the source a spacer's key
 * names. Throws for a spacer whose source is not held, since a copy missing items would look whole,
 * and for a text window's spacer copied as markdown, which no text window draws in.
 */
export function withUndrawnItems(
  tree: DrawnTree,
  flavor: "markdown" | "text",
  drawnSourceOf: (sourceKey: string) => DrawnWindowSource | undefined,
): UndrawnItemsReading {
  const tables = new Map<string, Table>();
  const textRuns: UndrawnTextRun[] = [];
  // Before the first spacer becomes a marker, the markers the part's own text holds are escaped.
  let isEscaped = flavor === "markdown";
  if ("children" in tree) {
    readSpacers(tree, (spacer, kind, sourceKey, firstIndex, lastIndex): DrawnContent => {
      if (!isEscaped) {
        escapeMarkers(tree);
        isEscaped = true;
      }
      const source = drawnSourceOf(sourceKey);
      if (source?.kind === "text" && kind === "text") {
        if (flavor === "markdown") {
          throw new Error("A text window's undrawn items were copied as markdown.");
        }
        textRuns.push({ ...source, firstIndex, lastIndex });
        return { type: "text", value: UNDRAWN_ROWS_MARKER };
      }
      if (source?.kind !== "table" || kind !== "table") {
        throw new Error("A copied window's undrawn items have no source to be read from.");
      }
      if (flavor === "text") {
        textRuns.push({ kind: "table", table: source.table, firstIndex, lastIndex });
        return markerRow();
      }
      tables.set(sourceKey, source.table);
      markUndrawnRows(spacer, { tableKey: sourceKey, firstIndex, lastIndex });
      return spacer;
    });
  }
  return { tree, tables, textRuns };
}

/**
 * `drawnText`, read from a tree `withUndrawnItems` made, with each of `textRuns`' items read as
 * text in its marker's place, a few items a slice in `view`, the text in pieces, and the markers
 * the part held read back from their escapes. Throws when the text holds the markers other than
 * once each.
 */
export async function withUndrawnItemsText(
  drawnText: PiecedText | Promise<PiecedText>,
  textRuns: readonly UndrawnTextRun[],
  view: Window,
): Promise<PiecedText> {
  const runPieces: string[][] = [];
  for (const run of textRuns) {
    runPieces.push(await undrawnPieces(run, view));
  }
  const pieces: string[] = [];
  let runIndex = 0;
  // An escape a piece ends on is read with the digit that opens the next.
  let escapeCarried = "";
  for (const piece of (await drawnText).pieces) {
    const carried = escapeCarried + piece;
    escapeCarried = carried.endsWith(MARKER_ESCAPE) ? MARKER_ESCAPE : "";
    const [first = "", ...afterMarkers] = carried
      .slice(0, carried.length - escapeCarried.length)
      .split(UNDRAWN_ROWS_MARKER)
      .map(withoutMarkerEscapes);
    pieces.push(first);
    for (const after of afterMarkers) {
      const rows = runPieces[runIndex];
      if (rows === undefined) {
        throw new Error("A copied window's undrawn items lost their place in the text.");
      }
      pieces.push(...rows, after);
      runIndex += 1;
    }
  }
  if (runIndex !== runPieces.length) {
    throw new Error("A copied window's undrawn items lost their place in the text.");
  }
  return { text: joinPieces(pieces), pieces };
}

/**
 * How many rows one read takes. Measured on a loaded machine, twenty of a 2 MiB table's rows read
 * in 1.9 ms at worst, which fits a slice of copy work inside a frame.
 */
const ROWS_PER_READ = 20;

/**
 * How many of a text window's items one read takes: an output's chunk or a diff's step holds at
 * most a few thousand characters, so a read joins tens of thousands, a small share of a slice.
 */
const TEXT_ITEMS_PER_READ = 16;

/** The text of `run`'s items in pieces, read a few items at a time in `view`. */
async function undrawnPieces(run: UndrawnTextRun, view: Window): Promise<string[]> {
  const pieces: string[] = [];
  let nextIndex = run.firstIndex;
  await workInSlices(
    view,
    (hasTime) => {
      do {
        const lastIndex = Math.min(nextIndex + itemsPerRead(run) - 1, run.lastIndex);
        pieces.push(...piecesOf(itemsText(run, nextIndex, lastIndex)));
        nextIndex = lastIndex + 1;
      } while (nextIndex <= run.lastIndex && hasTime());
      return nextIndex > run.lastIndex;
    },
    () => false,
  );
  return pieces;
}

function itemsPerRead(run: UndrawnTextRun): number {
  return run.kind === "table" ? ROWS_PER_READ : TEXT_ITEMS_PER_READ;
}

/**
 * The text of `run`'s items `firstIndex` to `lastIndex`: a table's rows a line each, and a text
 * window's items each followed by its separator, a line feed or a separator after all but the
 * run's last.
 */
function itemsText(run: UndrawnTextRun, firstIndex: number, lastIndex: number): string {
  if (run.kind === "table") {
    const rowsText = drawnRowsText(run.table, firstIndex, lastIndex);
    return lastIndex < run.lastIndex ? `${rowsText}\n` : rowsText;
  }
  const texts: string[] = [];
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    texts.push(run.itemText(index));
  }
  const itemsText = texts.join(run.itemSeparator);
  return lastIndex < run.lastIndex ? `${itemsText}${run.itemSeparator}` : itemsText;
}

/** A node of a drawn tree that holds children, and one of its children. */
type ParentNode = Extract<DrawnTree, { children: unknown }>;
type DrawnContent = ParentNode["children"][number];

/**
 * Puts what `readSpacer` answers for each spacer under `parent` in its place, handing it the
 * spacer, the kind of window that drew it, its source's key and the first and last item it stands
 * for.
 */
function readSpacers(
  parent: ParentNode,
  readSpacer: (
    spacer: DrawnElement,
    kind: DrawnWindowSource["kind"],
    sourceKey: string,
    firstIndex: number,
    lastIndex: number,
  ) => DrawnContent,
): void {
  parent.children = parent.children.map((child) => {
    if (child.type !== "element") {
      return child;
    }
    const spacer = spacerOf(child);
    if (spacer !== undefined) {
      return readSpacer(child, spacer.kind, spacer.sourceKey, spacer.firstIndex, spacer.lastIndex);
    }
    readSpacers(child, readSpacer);
    return child;
  });
}

/** What `element` stands for as a spacer, or `undefined` for an element that is none. */
function spacerOf(element: DrawnElement):
  | {
      readonly kind: DrawnWindowSource["kind"];
      readonly sourceKey: string;
      readonly firstIndex: number;
      readonly lastIndex: number;
    }
  | undefined {
  for (const spacer of SPACER_PROPERTIES) {
    const sourceKey = element.properties[spacer.sourceKey];
    const firstIndex = numberOf(element.properties[spacer.firstIndex]);
    const lastIndex = numberOf(element.properties[spacer.lastIndex]);
    if (
      (spacer.tagName === undefined || element.tagName === spacer.tagName) &&
      typeof sourceKey === "string" &&
      firstIndex !== undefined &&
      lastIndex !== undefined
    ) {
      return { kind: spacer.kind, sourceKey, firstIndex, lastIndex };
    }
  }
  return undefined;
}

/**
 * Each window's spacer as the DOM reader names it: its tag, and the properties it reads the
 * window's source key, first item and last item attributes by.
 */
const SPACER_PROPERTIES = [
  {
    kind: "table",
    tagName: "tr",
    sourceKey: "dataMarkdownTable",
    firstIndex: "dataMarkdownFirstUndrawnRow",
    lastIndex: "dataMarkdownLastUndrawnRow",
  },
  {
    kind: "text",
    tagName: undefined,
    sourceKey: "dataUndrawnTextSource",
    firstIndex: "dataFirstUndrawnItem",
    lastIndex: "dataLastUndrawnItem",
  },
] as const;

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
