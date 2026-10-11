// A drawn part of a reply read back into the text it copies as: the markdown that drew it, rebuilt
// from the drawing's own elements, or its plain text laid out as the screen lays it out. A long
// table's rows the screen never drew stand in the tree as one row naming its table and the rows,
// which are asked for from the parse the page drew the table from, as many at a time as the page
// hands over in a slice, and drawn under the screen's own policy, so they read exactly as drawn
// rows do. Each answer's rows are rebuilt as markdown and made into HTML, padded to the widths of
// the whole run, and put in the place of a row that stands for them in the rest of the part, so no
// tree of a whole long table is held. The page and the markdown worker both read a part here, so a
// part read off the page's thread is the same text as one read on it.

import { type fromDom } from "hast-util-from-dom";
import { defaultHandlers, toMdast, type Handle } from "hast-util-to-mdast";
import { toText } from "hast-util-to-text";
import type { Table, TableRow } from "mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown, type Handle as MarkdownHandle, type Options } from "mdast-util-to-markdown";

import {
  markdownToHtml,
  screenTableBodyRows,
  tableBodyRowsHtml,
  type MarkdownHastElement,
} from "./html.js";

/** A tree of drawn elements, as the DOM reader builds it. */
export type DrawnTree = ReturnType<typeof fromDom>;

/** One element of a drawn tree. */
export type DrawnElement = Parameters<Handle>[1];

/** How a drawn part is copied: as the markdown that drew it, or as plain text. */
export type CopyFlavor = "markdown" | "text";

/** A run of a long table's body rows the screen did not draw, and the table they belong to. */
export interface UndrawnTableRows {
  /** What names the table among one drawn part's tables. */
  readonly tableKey: string;
  /** The first and last undrawn body rows, counted from the first row below the head. */
  readonly firstIndex: number;
  readonly lastIndex: number;
}

/**
 * Where a drawn part's undrawn rows are read from: each table's column alignment by its key, and
 * its body rows, asked for from a first to a last and answered from the first with as many as the
 * holder hands over at once, at least one.
 */
export interface UndrawnRowsSource {
  readonly alignments: ReadonlyMap<string, Table["align"]>;
  readonly pull: (
    tableKey: string,
    firstIndex: number,
    lastIndex: number,
  ) => Promise<readonly TableRow[]>;
}

/** The markdown a drawn part copies as and the HTML it makes, each in pieces that join to it. */
export interface DrawnMarkdown {
  readonly markdown: readonly string[];
  readonly html: readonly string[];
}

/**
 * What stands for undrawn rows in a text while the rest of it is read: a noncharacter, which
 * Unicode keeps for a program's own use and no text exchanged holds. One code unit, so no piece of
 * a text cuts it in two.
 */
export const UNDRAWN_ROWS_MARKER = "\uFDD0";

/** The text the drawn part `tree`, holding no stand-in for undrawn rows, copies as in `flavor`. */
export function drawnTreeText(tree: DrawnTree, flavor: CopyFlavor): string {
  return flavor === "markdown" ? rebuildMarkdown(tree) : toText(tree);
}

/**
 * The markdown the drawn part `tree` copies as, and the HTML that markdown makes under the screen's
 * policy, each stand-in's rows read in its place from `undrawnRows`, twice: once for the widths
 * their columns pad to, once to write them. Reads `tree` by changing it, so a tree is read once.
 * Rejects when a stand-in names a table `undrawnRows` holds no alignment for, or a pull is answered
 * with no rows.
 */
export async function drawnTreeMarkdown(
  tree: DrawnTree,
  undrawnRows: UndrawnRowsSource,
): Promise<DrawnMarkdown> {
  const standIns: UndrawnRowsStandIn[] = [];
  if ("children" in tree) {
    findUndrawnRuns(tree, undrawnRows.alignments, standIns);
  }
  for (const { parent, index, run } of standIns) {
    parent.children[index] = markerRow(run.align, await undrawnRowsWidths(run, undrawnRows.pull));
  }
  const markdown = rebuildMarkdown(tree);
  const html = markdownToHtml(markdown);
  return standIns.length === 0
    ? { markdown: [markdown], html: [html] }
    : withUndrawnRuns(
        markdown,
        html,
        standIns.map((standIn) => standIn.run),
        undrawnRows.pull,
      );
}

/** How many characters of text `tree` holds. */
export function drawnTreeLength(tree: DrawnTree): number {
  if (tree.type === "text") {
    return tree.value.length;
  }
  if (!("children" in tree)) {
    return 0;
  }
  let length = 0;
  for (const child of tree.children) {
    length += drawnTreeLength(child);
  }
  return length;
}

/** Makes `row`, a drawn table's row, the stand-in for the body rows `undrawnRows` names. */
export function markUndrawnRows(row: DrawnElement, undrawnRows: UndrawnTableRows): void {
  row.properties[UNDRAWN_ROWS_PROPERTIES.tableKey] = undrawnRows.tableKey;
  row.properties[UNDRAWN_ROWS_PROPERTIES.firstIndex] = undrawnRows.firstIndex;
  row.properties[UNDRAWN_ROWS_PROPERTIES.lastIndex] = undrawnRows.lastIndex;
}

/**
 * The plain text of body rows `firstIndex` to `lastIndex` of `table`, as the screen draws them,
 * read as a drawn table's rows read: each row a line of its own, its cells joined by a tab.
 */
export function drawnRowsText(table: Table, firstIndex: number, lastIndex: number): string {
  return toText({
    type: "element",
    tagName: "table",
    properties: {},
    children: screenTableBodyRows(
      table.align,
      table.children.slice(firstIndex + 1, lastIndex + 2),
    ).map(asDrawnRow),
  });
}

/** The properties a stand-in row carries the undrawn rows it stands for on, one per member. */
const UNDRAWN_ROWS_PROPERTIES = {
  tableKey: "dataUndrawnTableKey",
  firstIndex: "dataUndrawnFirstRow",
  lastIndex: "dataUndrawnLastRow",
} as const;

/** The undrawn rows `element` stands for, or `undefined` for an element standing for none. */
function undrawnRowsOf(element: DrawnElement): UndrawnTableRows | undefined {
  const property = (name: keyof typeof UNDRAWN_ROWS_PROPERTIES): unknown =>
    element.properties[UNDRAWN_ROWS_PROPERTIES[name]];
  const tableKey = property("tableKey");
  const firstIndex = property("firstIndex");
  const lastIndex = property("lastIndex");
  return typeof tableKey === "string" &&
    typeof firstIndex === "number" &&
    typeof lastIndex === "number"
    ? { tableKey, firstIndex, lastIndex }
    : undefined;
}

/** A node of a drawn tree that holds children. */
type ParentNode = Extract<DrawnTree, { children: unknown }>;

/** A run of a table's undrawn body rows, from the first to the last. */
interface UndrawnRowsRun {
  readonly tableKey: string;
  readonly align: Table["align"];
  readonly firstIndex: number;
  readonly lastIndex: number;
}

/** A stand-in for undrawn rows: where it is in the tree, and the run it stands for. */
interface UndrawnRowsStandIn {
  readonly parent: ParentNode;
  readonly index: number;
  readonly run: UndrawnRowsRun;
}

/**
 * Lists each stand-in under `parent` in `standIns`, in the order they are drawn, its table's
 * alignment taken from `alignments`. Throws for a stand-in whose table has none there.
 */
function findUndrawnRuns(
  parent: ParentNode,
  alignments: ReadonlyMap<string, Table["align"]>,
  standIns: UndrawnRowsStandIn[],
): void {
  parent.children.forEach((child, index) => {
    if (child.type !== "element") {
      return;
    }
    const undrawnRows = undrawnRowsOf(child);
    if (undrawnRows === undefined) {
      findUndrawnRuns(child, alignments, standIns);
      return;
    }
    if (!alignments.has(undrawnRows.tableKey)) {
      throw new Error("A copied table's undrawn rows have no table to be read from.");
    }
    const { tableKey, firstIndex, lastIndex } = undrawnRows;
    const align = alignments.get(tableKey);
    standIns.push({ parent, index, run: { tableKey, align, firstIndex, lastIndex } });
  });
}

/**
 * Reads `run`'s rows as `pull` answers for them, handing `read` each answer's rows and the index
 * of the first. Throws for an answer holding no rows, after which the reading would never end.
 */
async function forEachChunkOf(
  run: UndrawnRowsRun,
  pull: UndrawnRowsSource["pull"],
  read: (rows: readonly TableRow[], firstIndex: number) => void,
): Promise<void> {
  let firstIndex = run.firstIndex;
  while (firstIndex <= run.lastIndex) {
    const rows = await pull(run.tableKey, firstIndex, run.lastIndex);
    if (rows.length === 0) {
      throw new Error("A copied table's undrawn rows were asked for and none came.");
    }
    read(rows, firstIndex);
    firstIndex += rows.length;
  }
}

/**
 * The length of the widest cell in each column of `run`'s rows as markdown, as the table's
 * rebuilding measures a cell before it pads its column.
 */
async function undrawnRowsWidths(
  run: UndrawnRowsRun,
  pull: UndrawnRowsSource["pull"],
): Promise<number[]> {
  const widths: number[] = [];
  const measureCells: MarkdownHandle = (table: Table, _parent, state, info) => {
    const exitTable = state.enter("table");
    for (const row of table.children) {
      const exitRow = state.enter("tableRow");
      row.children.forEach((cell, column) => {
        const width = state.handle(cell, row, state, info).length;
        widths[column] = Math.max(widths[column] ?? 0, width);
      });
      exitRow();
    }
    exitTable();
    return "";
  };
  await forEachChunkOf(run, pull, (rows) => {
    toMarkdown(rebuiltRows(run.align, rows, []), {
      ...markdownOptions(),
      handlers: { table: measureCells },
    });
  });
  return widths;
}

/**
 * A row standing for undrawn rows while the rest of their part is rebuilt: a cell as wide as each
 * column of `widths`, so the part's table is padded as wide as with the rows in it, the first cell
 * opening on `UNDRAWN_ROWS_MARKER`.
 */
function markerRow(align: Table["align"], widths: readonly number[]): DrawnElement {
  return {
    type: "element",
    tagName: "tr",
    properties: {},
    children: widths.map((width, column) =>
      sizedCell(
        "td",
        align,
        column,
        column === 0 ? UNDRAWN_ROWS_MARKER + "a".repeat(Math.max(0, width - 1)) : "a".repeat(width),
      ),
    ),
  };
}

/** A cell of `tagName` holding `text`, aligned as column `column` of a table aligned `align`. */
function sizedCell(
  tagName: "td" | "th",
  align: Table["align"],
  column: number,
  text: string,
): DrawnElement {
  const alignment = align?.[column];
  return {
    type: "element",
    tagName,
    properties: alignment === null || alignment === undefined ? {} : { align: alignment },
    children: [{ type: "text", value: text }],
  };
}

/**
 * The markdown and the HTML of `runs`' rows put in the place of their marker rows in `markdown`
 * and `html`, each in pieces. Each run is padded to the widths its marker row's line was padded
 * to, and its lines take that line's leading marks, its rows read as `pull` answers for them.
 * Throws when a run's marker row is not there.
 */
async function withUndrawnRuns(
  markdown: string,
  html: string,
  runs: readonly UndrawnRowsRun[],
  pull: UndrawnRowsSource["pull"],
): Promise<DrawnMarkdown> {
  const markdownPieces: string[] = [];
  const htmlPieces: string[] = [];
  let markdownAt = 0;
  let htmlAt = 0;
  for (const run of runs) {
    const markdownMarkerAt = markdown.indexOf(UNDRAWN_ROWS_MARKER, markdownAt);
    const htmlMarkerAt = html.indexOf(UNDRAWN_ROWS_MARKER, htmlAt);
    if (markdownMarkerAt === -1 || htmlMarkerAt === -1) {
      throw new Error("A copied table's undrawn rows lost their place in the text.");
    }
    const lineStart = markdown.lastIndexOf("\n", markdownMarkerAt) + 1;
    const lineBreakAt = markdown.indexOf("\n", markdownMarkerAt);
    const lineEnd = lineBreakAt === -1 ? markdown.length : lineBreakAt;
    const markerLine = markdown.slice(lineStart, lineEnd);
    const marks = markerLine.slice(0, markerLine.indexOf("|"));
    // Each cell between two pipes is padded by a space on either side.
    const columnWidths = markerLine
      .slice(marks.length + 1, -1)
      .split("|")
      .map((cell) => cell.length - 2);
    const rowStart = html.lastIndexOf("<tr>", htmlMarkerAt);
    const rowEnd = html.indexOf("</tr>", htmlMarkerAt) + "</tr>".length;
    markdownPieces.push(markdown.slice(markdownAt, lineStart));
    htmlPieces.push(html.slice(htmlAt, rowStart));
    await forEachChunkOf(run, pull, (rows, firstIndex) => {
      const chunk = undrawnRowsChunk(run.align, rows, columnWidths);
      const lineBefore = firstIndex === run.firstIndex ? "" : "\n";
      markdownPieces.push(lineBefore + chunk.lines.map((line) => marks + line).join("\n"));
      htmlPieces.push(lineBefore + chunk.html);
    });
    markdownAt = lineEnd;
    htmlAt = rowEnd;
  }
  markdownPieces.push(markdown.slice(markdownAt));
  htmlPieces.push(html.slice(htmlAt));
  return { markdown: markdownPieces, html: htmlPieces };
}

/**
 * `rows`, of a table aligned `align`, as the lines of markdown they rebuild as, padded to
 * `columnWidths`, and the HTML those lines make, a line between each row.
 */
function undrawnRowsChunk(
  align: Table["align"],
  rows: readonly TableRow[],
  columnWidths: readonly number[],
): { readonly lines: readonly string[]; readonly html: string } {
  // A head as wide as each column pads every row as the whole table pads it.
  const widthCells = columnWidths.map((width, column) =>
    sizedCell("th", align, column, "a".repeat(width)),
  );
  const rebuilt = rebuiltRows(align, rows, widthCells);
  // The head's line and the delimiter row come first.
  const lines = toMarkdown(rebuilt, markdownOptions())
    .split("\n")
    .slice(2, 2 + rows.length);
  return { lines, html: tableBodyRowsHtml(rebuilt) };
}

/**
 * `rows`, of a table aligned `align`, drawn under the screen's policy below a head row of
 * `headCells`, rebuilt as a markdown table as a drawn table is.
 */
function rebuiltRows(
  align: Table["align"],
  rows: readonly TableRow[],
  headCells: readonly DrawnElement[],
): ReturnType<typeof toMdast> {
  const drawnRows: DrawnElement[] = screenTableBodyRows(align, rows).map(asDrawnRow);
  const head: DrawnElement[] =
    headCells.length === 0
      ? []
      : [{ type: "element", tagName: "tr", properties: {}, children: [...headCells] }];
  return toMdast(
    {
      type: "root",
      children: [
        { type: "element", tagName: "table", properties: {}, children: [...head, ...drawnRows] },
      ],
    },
    { handlers: DRAWN_MARKDOWN_HANDLERS },
  );
}

/**
 * `row` with only its cells, as the screen draws it: the parse puts a line break between cells,
 * which plain text would read as spaces around each cell.
 */
function asDrawnRow(row: MarkdownHastElement): MarkdownHastElement {
  return { ...row, children: row.children.filter((cell) => cell.type === "element") };
}

/** The markdown that made the drawn reply elements in `tree`, rebuilt from them. */
function rebuildMarkdown(tree: DrawnTree): string {
  const markdownTree = toMdast(tree, { handlers: DRAWN_MARKDOWN_HANDLERS });
  return toMarkdown(markdownTree, markdownOptions()).trimEnd();
}

/** How a drawn part's markdown is written, made per call as the extension is. */
function markdownOptions(): Options {
  // `-` is the bullet agents and people write most; the drawing does not keep which one was used.
  return { bullet: "-", extensions: [gfmToMarkdown()] };
}

/** What one element handler answers, derived from the library's own handler. */
type RebuiltNodes = ReturnType<Handle>;

/**
 * How the markdown drawing's own elements read back: a heading is a `p` carrying its level, a
 * list item is tight unless marked loose, a fenced block names its language on the `pre`, and a
 * table cell carries its column's alignment as `data-align`, which the table's reader takes from
 * `align`.
 */
const DRAWN_MARKDOWN_HANDLERS: Record<string, Handle> = {
  p: (state, element) => {
    const level = Number(element.properties["ariaLevel"]);
    return element.properties["role"] === "heading" && isHeadingDepth(level)
      ? ({ type: "heading", depth: level, children: state.all(element) } as RebuiltNodes)
      : defaultHandlers.p(state, element);
  },
  li: (state, element) => ({
    ...defaultHandlers.li(state, element),
    spread: element.properties["dataSpread"] !== undefined,
  }),
  pre: (state, element) => {
    const language = element.properties["dataLanguage"];
    const code = defaultHandlers.pre(state, element);
    return typeof language === "string" ? { ...code, lang: language } : code;
  },
  table: (state, element) => {
    alignCellsOf(element);
    return defaultHandlers.table(state, element);
  },
};

/** Gives each cell of a drawn table, nested tables aside, the `align` its `data-align` names. */
function alignCellsOf(parent: DrawnElement): void {
  for (const child of parent.children) {
    if (child.type !== "element" || child.tagName === "table") {
      continue;
    }
    const alignment = child.properties["dataAlign"];
    if ((child.tagName === "td" || child.tagName === "th") && typeof alignment === "string") {
      child.properties["align"] = alignment;
    }
    alignCellsOf(child);
  }
}

function isHeadingDepth(level: number): level is 1 | 2 | 3 | 4 | 5 | 6 {
  return Number.isInteger(level) && level >= 1 && level <= 6;
}
