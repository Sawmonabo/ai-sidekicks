// A block that is one long table, parsed in pieces and read a row at a time. Each piece is the
// table's head and delimiter lines over a run of its rows, so the worker parses a bounded text
// however long the table is, and each piece's binary tree stays as the parser wrote it, off the
// JavaScript heap. The block's tree holds one table whose rows are read from those trees when a
// caller reads them, each restored as a whole parse reads it and placed where it sits in the
// block, and only the rows of the few pieces read last are kept, so a long table holds no tree of
// its rows while it is drawn. A table row is one line, and its cells read only that line and the
// head's columns, so a row parsed in a piece is the row the whole block parses to: each piece is
// checked to be one table holding every line it was given, and a block whose pieces are not falls
// back to one parse of the whole.

import type { Nodes, Root, Table, TableRow } from "mdast";
import { materializeNode } from "satteri/mdast-materializer";
import { MdastReader, NodeType } from "satteri/mdast-reader";

import { restoreLiteralText } from "./literal-text.js";

declare module "mdast" {
  interface TableData {
    /** The table's rows are read from its pieces' trees as they are asked for, none held. */
    readonly isReadInPieces?: true;
  }
}

/** One piece of a long table: the text parsed, and where its rows sit in the block. */
export interface TablePiece {
  /** The definitions, the head and delimiter lines, then the piece's rows. */
  readonly text: string;
  /** The block's first body row this piece holds, counted from the first row below the head. */
  readonly firstRowIndex: number;
  readonly rowCount: number;
  /** How far the piece's rows sit past where they sit in `text`, in UTF-16 code units. */
  readonly offsetShift: number;
}

/** One piece's binary tree, and the stand-in its dollars read as text took. */
export interface ParsedTablePiece {
  readonly buffer: ArrayBuffer;
  readonly dollarStandIn: string | undefined;
}

/**
 * The pieces `blockSource` parses in, each preceded by `definitionPreamble`: `undefined` unless the
 * block opens on a table's head and delimiter lines and is longer than one piece. A block that
 * passes may still hold more than one table; reading its pieces finds that out.
 */
export function tablePiecesOf(
  blockSource: string,
  definitionPreamble: string,
): readonly TablePiece[] | undefined {
  if (blockSource.length <= TABLE_PIECE_CHARACTERS) {
    return undefined;
  }
  const headEnd = lineEndOf(blockSource, lineEndOf(blockSource, 0) + 1);
  const delimiterLine = blockSource.slice(lineEndOf(blockSource, 0) + 1, headEnd);
  if (!blockSource.slice(0, headEnd).includes("|") || !DELIMITER_ROW.test(delimiterLine)) {
    return undefined;
  }
  const head = blockSource.slice(0, headEnd + 1);
  // A block is cut through the blank lines that end it, which hold no row.
  const rowsEnd = withoutTrailingLineEndings(blockSource);
  const pieces: TablePiece[] = [];
  let rowsStart = headEnd + 1;
  let firstRowIndex = 0;
  while (rowsStart < rowsEnd) {
    const cut = blockSource.indexOf("\n", rowsStart + TABLE_PIECE_CHARACTERS);
    const pieceEnd = cut === -1 || cut >= rowsEnd ? rowsEnd : withoutLineEnding(blockSource, cut);
    const rows = blockSource.slice(rowsStart, pieceEnd);
    const rowCount = countLines(rows);
    pieces.push({
      text: definitionPreamble + head + rows,
      firstRowIndex,
      rowCount,
      offsetShift: rowsStart - head.length,
    });
    firstRowIndex += rowCount;
    rowsStart = cut === -1 || cut >= rowsEnd ? rowsEnd : cut + 1;
  }
  return pieces;
}

/** Whether `node` is a table read in pieces, which a copy of its rows would read whole. */
export function isReadInPieces(node: Nodes): boolean {
  return node.type === "table" && node.data?.isReadInPieces === true;
}

/**
 * The block's tree read from its pieces' trees: one table whose rows are read as they are asked
 * for. `undefined` when a piece is not one table holding every line it was given, and the block
 * is to be parsed whole.
 */
export function piecedTableRoot(
  pieces: readonly TablePiece[],
  parsed: readonly ParsedTablePiece[],
  definitionPreamble: string,
): Root | undefined {
  const pieceTrees: PieceTree[] = [];
  for (const [index, piece] of pieces.entries()) {
    const pieceParse = parsed[index];
    const tree =
      pieceParse === undefined ? undefined : pieceTreeOf(piece, pieceParse, definitionPreamble);
    if (tree === undefined) {
      return undefined;
    }
    pieceTrees.push(tree);
  }
  const rows = new PiecedTableRows(pieceTrees);
  return { type: "root", children: [rows.table] };
}

/** One piece's tree, checked, with what a row read from it needs. */
interface PieceTree {
  /** Where the piece's rows sit in the block; not its text, which the parser's tree holds. */
  readonly piece: Omit<TablePiece, "text">;
  readonly parsed: ParsedTablePiece;
  /** The piece's table, its head row and the line its rows' lines move by. */
  readonly tableId: number;
  readonly lineShift: number;
}

/**
 * The most characters of a block's rows one piece holds, cut at the end of a row. Measured on the
 * bench's rows, a piece this long parses in under a millisecond into a tree of about 380 KB.
 */
const TABLE_PIECE_CHARACTERS = 32_768;

/** How many pieces' rows stay read at once: the drawn rows' pieces, and the one read before. */
const KEPT_PIECE_READINGS = 4;

/** A table's delimiter line, as GFM reads one: cells of dashes, each with optional colons. */
const DELIMITER_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*\r?$/u;

/** The rows of a table parsed in pieces, read from the pieces' trees as they are asked for. */
class PiecedTableRows {
  public readonly table: Table;
  readonly #pieces: readonly PieceTree[];
  /** The pieces read last, newest last, each with the rows read from it. */
  readonly #readings = new Map<number, PieceReading>();
  #headRow: TableRow | undefined;

  public constructor(pieces: readonly PieceTree[]) {
    this.#pieces = pieces;
    const rowCount = pieces.reduce((count, piece) => count + piece.piece.rowCount, 0);
    const first = this.#reading(0);
    const firstTable = materializeNode(first.reader, pieces[0]?.tableId ?? 0) as Table;
    const lastPiece = pieces.at(-1);
    const lastEnd =
      lastPiece === undefined
        ? undefined
        : shiftedPosition(
            new MdastReader(lastPiece.parsed.buffer).getPosition(lastPiece.tableId),
            lastPiece.piece.offsetShift,
            lastPiece.lineShift,
          )?.end;
    this.table = {
      type: "table",
      align: firstTable.align,
      data: { isReadInPieces: true },
      ...(firstTable.position === undefined || lastEnd === undefined
        ? {}
        : { position: { start: firstTable.position.start, end: lastEnd } }),
      children: rowsView(rowCount + 1, (index) =>
        index === 0 ? this.#readHeadRow() : this.#readBodyRow(index - 1),
      ),
    };
  }

  #readHeadRow(): TableRow {
    this.#headRow ??= this.#reading(0).row(0);
    return this.#headRow;
  }

  #readBodyRow(bodyIndex: number): TableRow {
    const pieceIndex = pieceIndexOf(this.#pieces, bodyIndex);
    const piece = this.#pieces[pieceIndex];
    if (piece === undefined) {
      throw new RangeError(`The table holds no body row ${String(bodyIndex)}.`);
    }
    return this.#reading(pieceIndex).row(1 + bodyIndex - piece.piece.firstRowIndex);
  }

  /** The piece's reading, made anew once it has been let go, and kept as read last. */
  #reading(pieceIndex: number): PieceReading {
    let reading = this.#readings.get(pieceIndex);
    if (reading === undefined) {
      const piece = this.#pieces[pieceIndex];
      if (piece === undefined) {
        throw new RangeError(`The table holds no piece ${String(pieceIndex)}.`);
      }
      reading = new PieceReading(piece);
    } else {
      this.#readings.delete(pieceIndex);
    }
    this.#readings.set(pieceIndex, reading);
    for (const readIndex of this.#readings.keys()) {
      if (this.#readings.size <= KEPT_PIECE_READINGS) {
        break;
      }
      this.#readings.delete(readIndex);
    }
    return reading;
  }
}

/**
 * The rows one piece's tree reads to: each restored and placed in the block once, and held while
 * the reading is. The parser's reader keeps each node it made for as long as the reader lives, so
 * letting a reading go lets its rows go.
 */
class PieceReading {
  public readonly reader: MdastReader;
  readonly #piece: PieceTree;
  readonly #rowIds: readonly number[];
  readonly #placedRowIds = new Set<number>();
  /** The text the piece's offsets count in, read from the parser's own copy of it. */
  readonly #parsedText: string;

  public constructor(piece: PieceTree) {
    this.#piece = piece;
    this.reader = new MdastReader(piece.parsed.buffer);
    this.#rowIds = this.reader.getChildIds(piece.tableId);
    this.#parsedText = this.reader.getStringPool();
  }

  /** The piece's table row `index`, its head row first. */
  public row(index: number): TableRow {
    const rowId = this.#rowIds[index];
    if (rowId === undefined) {
      throw new RangeError(`The piece holds no row ${String(index)}.`);
    }
    const row = materializeNode(this.reader, rowId) as TableRow;
    if (!this.#placedRowIds.has(rowId)) {
      this.#placedRowIds.add(rowId);
      restoreLiteralText(row, this.#parsedText, this.#piece.parsed.dollarStandIn);
      if (index > 0) {
        shiftPositions(row, this.#piece.piece.offsetShift, this.#piece.lineShift);
      }
    }
    return row;
  }
}

/** The piece's tree checked to be one table holding every row line it was given. */
function pieceTreeOf(
  piece: TablePiece,
  parsed: ParsedTablePiece,
  definitionPreamble: string,
): PieceTree | undefined {
  const reader = new MdastReader(parsed.buffer);
  const tables = reader
    .getChildIds(0)
    .filter((id) => (reader.getPosition(id)?.start.offset ?? 0) >= definitionPreamble.length);
  const [tableId] = tables;
  if (
    tableId === undefined ||
    tables.length !== 1 ||
    reader.getNodeType(tableId) !== NodeType.Table ||
    reader.getChildIds(tableId).length !== piece.rowCount + 1 ||
    reader.getPosition(tableId)?.end.offset !== piece.text.length
  ) {
    return undefined;
  }
  const { firstRowIndex, rowCount, offsetShift } = piece;
  return {
    piece: { firstRowIndex, rowCount, offsetShift },
    parsed,
    tableId,
    lineShift: firstRowIndex,
  };
}

/**
 * An array of `length` rows read by `readRow` as each index is asked for, holding none of them:
 * mdast's shape, so every reader of a table reads it as it reads any other.
 */
function rowsView(length: number, readRow: (index: number) => TableRow): TableRow[] {
  return new Proxy(Array.from<TableRow>({ length }), {
    get: (target, property, receiver) =>
      typeof property === "string" && ARRAY_INDEX.test(property) && Number(property) < length
        ? readRow(Number(property))
        : Reflect.get(target, property, receiver),
    has: (target, property) =>
      typeof property === "string" && ARRAY_INDEX.test(property)
        ? Number(property) < length
        : Reflect.has(target, property),
  });
}

/** An array index as a property name reads it. */
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/u;

/** Which of `pieces`, in row order, holds body row `bodyIndex`. */
function pieceIndexOf(pieces: readonly PieceTree[], bodyIndex: number): number {
  let low = 0;
  let high = pieces.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((pieces[middle]?.piece.firstRowIndex ?? 0) <= bodyIndex) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/** `node` and every node below it moved `offsetShift` code units and `lineShift` lines on. */
function shiftPositions(node: Nodes, offsetShift: number, lineShift: number): void {
  node.position = shiftedPosition(node.position, offsetShift, lineShift);
  if ("children" in node) {
    for (const child of node.children) {
      shiftPositions(child, offsetShift, lineShift);
    }
  }
}

function shiftedPosition(
  position: Position | undefined,
  offsetShift: number,
  lineShift: number,
): Position | undefined {
  if (position === undefined) {
    return undefined;
  }
  return {
    start: shiftedPoint(position.start, offsetShift, lineShift),
    end: shiftedPoint(position.end, offsetShift, lineShift),
  };
}

function shiftedPoint(point: Point, offsetShift: number, lineShift: number): Point {
  return {
    line: point.line + lineShift,
    column: point.column,
    ...(point.offset === undefined ? {} : { offset: point.offset + offsetShift }),
  };
}

/** Where the line holding `from` ends: its line feed, or the text's end. */
function lineEndOf(text: string, from: number): number {
  const end = text.indexOf("\n", from);
  return end === -1 ? text.length : end;
}

/** Where `text` ends once every line ending at its end is cut off. */
function withoutTrailingLineEndings(text: string): number {
  let end = text.length;
  for (let trimmed = withoutLineEnding(text, end); trimmed < end; ) {
    end = trimmed;
    trimmed = withoutLineEnding(text, end);
  }
  return end;
}

/** `end`, moved back past the line ending before it, if one is there. */
function withoutLineEnding(text: string, end: number): number {
  let trimmed = end;
  if (text.charAt(trimmed - 1) === "\n") {
    trimmed -= 1;
  }
  if (text.charAt(trimmed - 1) === "\r") {
    trimmed -= 1;
  }
  return trimmed;
}

function countLines(text: string): number {
  let count = 1;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    count += 1;
  }
  return count;
}

/** A node's place in the parsed text, as mdast types it. */
type Position = NonNullable<Root["position"]>;

type Point = Position["start"];
