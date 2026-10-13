// A text whose last block is one long table, parsed in pieces and its table read a row at a time.
// Each piece is the table's head and delimiter lines over a run of its rows (`table-cut.ts`), so the
// worker parses a bounded text however long the table is. A table row is one line, and its cells
// read only that line and the head's columns, so a row parsed in a piece is the row the whole text
// parses to: each piece is checked to end in one table holding every line it was given, and a text
// whose pieces do not falls back to one parse of the whole. The first piece also holds the blocks
// before the table, which are read from it; one that defines a link a later piece cannot see sends
// the text to the whole parse too. The pieces' binary trees are kept in one cache bounded in bytes
// for every table, so a long table holds no more than the cache however long it is: a row is read
// only while its piece's tree is held or still kept, and a piece let go is parsed again when its
// rows are held anew. The block's tree holds one table whose rows are read from those trees, each
// restored as a whole parse reads it and placed where it sits in the block. A text that continues
// one parsed in pieces, as a streaming table grows, takes the earlier parse's pieces it still holds
// and parses only the rest.

import type { Nodes, Root, RootContent, Table, TableRow } from "mdast";
import { materializeNode } from "satteri/mdast-materializer";
import { MdastReader, NodeType } from "satteri/mdast-reader";

import { ByteBoundedCache } from "#renderer/lib/byte-bounded-cache.js";
import { hasPrefix } from "#renderer/lib/text/prefix.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import type { MarkdownParseAnswer } from "../worker/messages.js";
import { mayHoldLiteralText, restoreLiteralText } from "./literal-text.js";
import { materializeMarkdownTree, shiftPoint, shiftPositions } from "./materialized-tree.js";
import type { Point } from "./position.js";
import { offsetShiftOf, type TableCut, type TablePiece } from "./table-cut.js";

declare module "mdast" {
  interface TableData {
    /** The rows of a table read in pieces, each read only while its piece's tree is read. */
    readonly piecedRows?: PiecedRows;
  }
}

/**
 * The body rows of a table read in pieces. A row can be read while its piece's tree is held or
 * still kept; reading one that cannot throws, so a reader holds the rows it reads first.
 */
export interface PiecedRows {
  /** Whether body row `index`, counted from the first row below the head, can be read now. */
  isRowRead(index: number): boolean;
  /** The body rows read with row `index`: the first and the last row of its piece. */
  pieceSpanOf(index: number): RowSpan;
  /**
   * Keeps body rows `firstIndex` to `lastIndex` readable until the returned call lets them go, and
   * calls `onRead` once every one is, before returning when they already are; or with why a piece
   * could not be parsed again, once, after which the rows it holds stay unread.
   */
  holdRows(
    firstIndex: number,
    lastIndex: number,
    onRead: (failure: string | undefined) => void,
  ): Unsubscribe;
  /**
   * Hands `visit` the body rows from `firstIndex` to `lastIndex` that can be read, in order, while
   * it answers true, and answers the first index it was not handed. Each row is read anew and kept
   * by nothing, so a pass over a whole table leaves no rows behind it.
   */
  passRows(
    firstIndex: number,
    lastIndex: number,
    visit: (row: TableRow, index: number) => boolean,
  ): number;
}

/** A run of a table's body rows, from its first to its last. */
export interface RowSpan {
  readonly firstIndex: number;
  readonly lastIndex: number;
}

/** One piece's binary tree, and the stand-in its dollars read as text took. */
export interface ParsedTablePiece {
  readonly buffer: ArrayBuffer;
  readonly dollarStandIn: string | undefined;
}

/** Parses one text and hands `settle` what it came to, as the markdown worker does. */
export type PieceParser = (text: string, settle: (answer: MarkdownParseAnswer) => void) => void;

/** What parsing a block in pieces came to. */
export type PiecedTableOutcome =
  | { readonly status: "parsed"; readonly root: Root; readonly rows: PiecedRows }
  /** A piece is not one table holding every line it was given: the block is to be parsed whole. */
  | { readonly status: "not-one-table" }
  | { readonly status: "failed"; readonly reason: string };

/**
 * The most bytes of piece trees kept for every table at once. Measured, a piece of the bench's
 * rows parses into a tree of about 373 KB, eleven times its text, so this keeps every piece of a
 * table of about 2.5 MiB; past that, the pieces read last are kept and the rest parsed again.
 */
export const PIECE_TREE_BYTE_CAP = 33_554_432;

/**
 * The pieces' trees of the long tables one set of markdown trees parsed: kept in a cache bounded in
 * bytes, a piece held while its rows are read, and one let go parsed again when it is held anew.
 */
export class TablePieceTrees {
  /** Parses one piece's text, as the markdown worker does. */
  public readonly parse: PieceParser;
  readonly #kept: ByteBoundedCache<ParsedTablePiece>;
  /** What waits on each piece being parsed again, by its key. */
  readonly #waiting = new Map<string, Set<(outcome: PieceParse) => void>>();
  #keyCount = 0;

  public constructor(parse: PieceParser, byteCap: number) {
    this.parse = parse;
    this.#kept = new ByteBoundedCache(byteCap, (parsed) => parsed.buffer.byteLength);
  }

  /** A key no piece was kept under before. */
  public newKey(): string {
    this.#keyCount += 1;
    return String(this.#keyCount);
  }

  /** Keeps `parsed` under `key` until newer trees take its room. */
  public keep(key: string, parsed: ParsedTablePiece): void {
    this.#kept.set(key, parsed);
  }

  /** The tree kept under `key`, if it still is, now the one read last. */
  public read(key: string): ParsedTablePiece | undefined {
    return this.#kept.get(key);
  }

  /**
   * Holds the tree under `key` until the returned call lets it go, parsing `text()` again when it
   * was let go and taking that parse only where `check` passes it; `onHeld` hears once it is held,
   * before returning when it was kept, or why it could not be.
   */
  public hold(
    key: string,
    text: () => string,
    check: (parsed: ParsedTablePiece) => boolean,
    onHeld: (failure: string | undefined) => void,
  ): Unsubscribe {
    let isHeld = this.#kept.hold(key);
    let isLetGo = false;
    let waiters: Set<(outcome: PieceParse) => void> | undefined;
    const waiter = (outcome: PieceParse): void => {
      if (outcome.status === "failed") {
        onHeld(outcome.reason);
        return;
      }
      isHeld = true;
      onHeld(undefined);
    };
    const letGo: Unsubscribe = () => {
      if (isLetGo) {
        return;
      }
      isLetGo = true;
      waiters?.delete(waiter);
      if (isHeld) {
        this.#kept.release(key);
      }
    };
    if (isHeld) {
      onHeld(undefined);
      return letGo;
    }
    waiters = this.#waiting.get(key);
    if (waiters !== undefined) {
      waiters.add(waiter);
      return letGo;
    }
    const pieceWaiters = new Set([waiter]);
    waiters = pieceWaiters;
    this.#waiting.set(key, pieceWaiters);
    this.parse(text(), (answer) => {
      this.#waiting.delete(key);
      this.#land(key, pieceWaiters, answer, check);
    });
    return letGo;
  }

  /** Hands each waiter a hold of the piece parsed again, or why it was not. */
  #land(
    key: string,
    waiters: ReadonlySet<(outcome: PieceParse) => void>,
    answer: MarkdownParseAnswer,
    check: (parsed: ParsedTablePiece) => boolean,
  ): void {
    if (answer.status === "failed") {
      for (const waiter of [...waiters]) {
        waiter(answer);
      }
      return;
    }
    const parsed = { buffer: answer.buffer, dollarStandIn: answer.dollarStandIn };
    if (!check(parsed)) {
      const failure = { status: "failed", reason: PARSED_ANEW_ELSEWISE } as const;
      for (const waiter of [...waiters]) {
        waiter(failure);
      }
      return;
    }
    if (waiters.size === 0) {
      this.keep(key, parsed);
      return;
    }
    let isStored = false;
    for (const waiter of [...waiters]) {
      // Stored held, so a cache full of held trees cannot let it go before its holders hold it.
      if (isStored) {
        this.#kept.hold(key);
      } else {
        this.#kept.setHeld(key, parsed);
        isStored = true;
      }
      waiter({ status: "parsed" });
    }
  }
}

/** Whether `node` is a table read in pieces, whose rows are read only while they are held. */
export function isReadInPieces(node: Nodes): boolean {
  return node.type === "table" && node.data?.piecedRows !== undefined;
}

/** The rows of `table` read in pieces, or `undefined` for a table whose rows are all at hand. */
export function piecedRowsOf(table: Table): PiecedRows | undefined {
  return table.data?.piecedRows;
}

/**
 * Parses `blockSource`, cut as `cut`, a piece at a time with `trees` against `definitionPreamble`,
 * and hands `settle` what it came to. A text continuing `earlier`, the last block parsed in pieces,
 * takes the pieces it still holds unchanged and parses only the rest.
 */
export function parsePiecedTable(
  trees: TablePieceTrees,
  blockSource: string,
  definitionPreamble: string,
  cut: TableCut,
  earlier: PiecedRows | undefined,
  settle: (outcome: PiecedTableOutcome) => void,
): void {
  const reused =
    earlier instanceof PiecedTableRows
      ? earlier.piecesContinuedBy(blockSource, definitionPreamble, cut)
      : undefined;
  new PiecedTableParse(trees, { blockSource, definitionPreamble, cut }, reused, settle).start();
}

/** A block's text cut into pieces, and the definitions each piece is parsed after. */
interface PiecedBlock {
  readonly blockSource: string;
  readonly definitionPreamble: string;
  readonly cut: TableCut;
}

/** One piece checked against its first parse: what reading its rows again needs. */
interface CheckedPiece {
  readonly piece: TablePiece;
  /** The key its tree is kept under. */
  readonly key: string;
  /** The piece's table in its tree. */
  readonly tableId: number;
}

/** What a text takes from its first piece: the blocks before its table, and the table's head. */
interface BlockHead {
  /** The blocks before the table, read as a whole parse reads them. */
  readonly lead: readonly RootContent[];
  readonly row: TableRow;
  readonly align: Table["align"];
  readonly start: Point | undefined;
}

/** The pieces an earlier parse checked that a text continuing it takes, and its head. */
interface ReusedPieces {
  readonly pieces: readonly CheckedPiece[];
  readonly head: BlockHead;
}

/** What parsing one piece again came to. */
type PieceParse =
  | { readonly status: "parsed" }
  | { readonly status: "failed"; readonly reason: string };

/**
 * How many pieces are asked for at once, so the trees that land are checked and given to the
 * cache as they come rather than all held until the last lands.
 */
const PIECE_ASKS_IN_FLIGHT = 4;

/** How many pieces' rows a table keeps read for the rows it draws: those, and the ones before. */
const KEPT_PIECE_READINGS = 4;

/** Why a piece parsed again cannot be read: its text no longer parses to the table it did. */
const PARSED_ANEW_ELSEWISE = "A long table's piece parsed again to another table.";

/** A block being parsed in pieces: a few pieces asked for at a time, each checked as it lands. */
class PiecedTableParse {
  readonly #trees: TablePieceTrees;
  readonly #block: PiecedBlock;
  readonly #settle: (outcome: PiecedTableOutcome) => void;
  readonly #checked: (CheckedPiece | undefined)[];
  #head: BlockHead | undefined;
  #end: Point | undefined;
  #nextIndex: number;
  #landedCount: number;
  #isSettled = false;

  public constructor(
    trees: TablePieceTrees,
    block: PiecedBlock,
    reused: ReusedPieces | undefined,
    settle: (outcome: PiecedTableOutcome) => void,
  ) {
    this.#trees = trees;
    this.#block = block;
    this.#settle = settle;
    this.#checked = [...(reused?.pieces ?? [])];
    this.#head = reused?.head;
    this.#nextIndex = this.#checked.length;
    this.#landedCount = this.#checked.length;
  }

  public start(): void {
    for (let asked = 0; asked < PIECE_ASKS_IN_FLIGHT; asked += 1) {
      this.#askNext();
    }
  }

  #askNext(): void {
    const index = this.#nextIndex;
    const piece = this.#block.cut.pieces[index];
    if (piece === undefined || this.#isSettled) {
      return;
    }
    this.#nextIndex += 1;
    const text = pieceTextOf(this.#block, piece);
    // A stand-in parser answers before the call returns, which asks for the next piece in it.
    this.#trees.parse(text, (answer) => {
      this.#land(index, piece, text, answer);
    });
  }

  #land(index: number, piece: TablePiece, text: string, answer: MarkdownParseAnswer): void {
    if (this.#isSettled) {
      return;
    }
    if (answer.status === "failed") {
      this.#isSettled = true;
      this.#settle(answer);
      return;
    }
    const parsed = { buffer: answer.buffer, dollarStandIn: answer.dollarStandIn };
    const checked = this.#check(index, piece, text, parsed);
    if (checked === undefined) {
      this.#isSettled = true;
      this.#settle({ status: "not-one-table" });
      return;
    }
    this.#checked[index] = checked;
    this.#trees.keep(checked.key, parsed);
    this.#landedCount += 1;
    if (this.#landedCount < this.#block.cut.pieces.length) {
      this.#askNext();
      return;
    }
    this.#isSettled = true;
    const head = this.#head;
    const pieces = this.#checked.filter((landed) => landed !== undefined);
    if (head === undefined || pieces.length !== this.#block.cut.pieces.length) {
      throw new Error("A long table's pieces all landed with its head or a piece unread.");
    }
    const rows = new PiecedTableRows(this.#trees, this.#block, pieces, head, this.#end);
    const root: Root = { type: "root", children: [...head.lead, rows.table] };
    this.#settle({ status: "parsed", root, rows });
  }

  /**
   * The piece checked to end in one table holding every row line it was given, and what the
   * text's tree reads from it: the blocks before the table and its head from the first piece, its
   * end from the last.
   */
  #check(
    index: number,
    piece: TablePiece,
    text: string,
    parsed: ParsedTablePiece,
  ): CheckedPiece | undefined {
    const reader = new MdastReader(parsed.buffer);
    const preambleLength = this.#block.definitionPreamble.length;
    const tableStart = preambleLength + this.#block.cut.headStart - piece.textStart;
    const tables = reader
      .getChildIds(0)
      .filter((id) => (reader.getPosition(id)?.start.offset ?? 0) >= tableStart);
    const [tableId] = tables;
    if (
      tableId === undefined ||
      tables.length !== 1 ||
      reader.getNodeType(tableId) !== NodeType.Table ||
      reader.getChildIds(tableId).length !== piece.rowCount + 1 ||
      reader.getPosition(tableId)?.end.offset !== text.length
    ) {
      return undefined;
    }
    const checked = { piece, key: this.#trees.newKey(), tableId };
    const position = reader.getPosition(tableId);
    if (index === 0) {
      const lead =
        tableStart === preambleLength ? [] : leadOf(parsed, text, preambleLength, tableStart);
      if (lead.some(holdsDefinition)) {
        return undefined;
      }
      this.#head = {
        lead,
        row: new PieceReading(checked, parsed, this.#block.cut).row(0),
        align: (materializeNode(reader, tableId) as Table).align,
        start: position?.start,
      };
    }
    if (index === this.#block.cut.pieces.length - 1 && position !== undefined) {
      const end = { ...position.end };
      shiftPoint(end, offsetShiftOf(this.#block.cut, piece), piece.lineShift);
      this.#end = end;
    }
    return checked;
  }
}

/**
 * The blocks the first piece's tree holds before its table, from `start` to `end` in `text`, read
 * whole as a whole parse reads them, so they keep nothing of the piece's tree.
 */
function leadOf(parsed: ParsedTablePiece, text: string, start: number, end: number): RootContent[] {
  return materializeMarkdownTree(parsed.buffer, text, parsed.dollarStandIn).children.filter(
    (child) => {
      const offset = child.position?.start.offset ?? 0;
      return offset >= start && offset < end;
    },
  );
}

/** Whether `node` is or holds a link's definition, which the table's later pieces cannot read. */
function holdsDefinition(node: Nodes): boolean {
  return node.type === "definition" || ("children" in node && node.children.some(holdsDefinition));
}

function pieceTextOf(block: PiecedBlock, piece: TablePiece): string {
  const { blockSource, definitionPreamble, cut } = block;
  return (
    definitionPreamble +
    blockSource.slice(piece.textStart, cut.headEnd) +
    blockSource.slice(piece.rowsStart, piece.rowsEnd)
  );
}

/** The rows of a table parsed in pieces, read from the pieces' trees as they are asked for. */
class PiecedTableRows implements PiecedRows {
  public readonly table: Table;
  readonly #trees: TablePieceTrees;
  readonly #block: PiecedBlock;
  readonly #pieces: readonly CheckedPiece[];
  readonly #head: BlockHead;
  /** The pieces whose rows were drawn last, newest last, each keeping the rows read from it. */
  readonly #readings = new Map<number, PieceReading>();

  public constructor(
    trees: TablePieceTrees,
    block: PiecedBlock,
    pieces: readonly CheckedPiece[],
    head: BlockHead,
    end: Point | undefined,
  ) {
    this.#trees = trees;
    this.#block = block;
    this.#pieces = pieces;
    this.#head = head;
    const rowCount = pieces.reduce((count, checked) => count + checked.piece.rowCount, 0);
    this.table = {
      type: "table",
      align: head.align,
      data: { piecedRows: this },
      ...(head.start === undefined || end === undefined
        ? {}
        : { position: { start: head.start, end } }),
      children: rowsView(rowCount + 1, (index) => {
        if (index === 0) {
          return head.row;
        }
        const row = this.#readBodyRow(index - 1);
        if (row === undefined) {
          throw new RangeError(
            `Body row ${String(index - 1)} of a table read in pieces was read before it was held.`,
          );
        }
        return row;
      }),
    };
  }

  public isRowRead(index: number): boolean {
    const pieceIndex = pieceIndexOf(this.#pieces, index);
    const checked = this.#pieces[pieceIndex];
    return (
      checked !== undefined &&
      (this.#readings.has(pieceIndex) || this.#trees.read(checked.key) !== undefined)
    );
  }

  public pieceSpanOf(index: number): RowSpan {
    const piece = this.#pieces[pieceIndexOf(this.#pieces, index)]?.piece;
    return piece === undefined
      ? { firstIndex: index, lastIndex: index }
      : { firstIndex: piece.firstRowIndex, lastIndex: piece.firstRowIndex + piece.rowCount - 1 };
  }

  public holdRows(
    firstIndex: number,
    lastIndex: number,
    onRead: (failure: string | undefined) => void,
  ): Unsubscribe {
    const lastPiece = pieceIndexOf(this.#pieces, lastIndex);
    const holds: Unsubscribe[] = [];
    let waitingCount = 0;
    let isAnswered = false;
    let isCounting = true;
    const landed = (failure: string | undefined): void => {
      if (isAnswered) {
        return;
      }
      if (failure !== undefined) {
        isAnswered = true;
        onRead(failure);
        return;
      }
      waitingCount -= 1;
      if (waitingCount === 0 && !isCounting) {
        isAnswered = true;
        onRead(undefined);
      }
    };
    for (let pieceIndex = pieceIndexOf(this.#pieces, firstIndex); pieceIndex <= lastPiece; ) {
      const checked = this.#pieces[pieceIndex];
      if (checked === undefined) {
        break;
      }
      // A piece whose rows are drawn is kept again as it stands, with no parse.
      const reading = this.#readings.get(pieceIndex);
      if (reading !== undefined && this.#trees.read(checked.key) === undefined) {
        this.#trees.keep(checked.key, reading.parsed);
      }
      waitingCount += 1;
      holds.push(
        this.#trees.hold(
          checked.key,
          () => pieceTextOf(this.#block, checked.piece),
          (parsed) => isSameTable(parsed, checked),
          landed,
        ),
      );
      pieceIndex += 1;
    }
    isCounting = false;
    if (waitingCount === 0 && !isAnswered) {
      isAnswered = true;
      onRead(undefined);
    }
    return () => {
      isAnswered = true;
      for (const hold of holds) {
        hold();
      }
    };
  }

  public passRows(
    firstIndex: number,
    lastIndex: number,
    visit: (row: TableRow, index: number) => boolean,
  ): number {
    let index = firstIndex;
    while (index <= lastIndex) {
      const pieceIndex = pieceIndexOf(this.#pieces, index);
      const checked = this.#pieces[pieceIndex];
      const parsed =
        checked === undefined
          ? undefined
          : (this.#readings.get(pieceIndex)?.parsed ?? this.#trees.read(checked.key));
      if (checked === undefined || parsed === undefined) {
        return index;
      }
      // A reader of its own, so the rows it reads go with it.
      const reading = new PieceReading(checked, parsed, this.#block.cut);
      const pieceLast = Math.min(
        lastIndex,
        checked.piece.firstRowIndex + checked.piece.rowCount - 1,
      );
      for (; index <= pieceLast; index += 1) {
        if (!visit(reading.row(1 + index - checked.piece.firstRowIndex), index)) {
          return index + 1;
        }
      }
    }
    return index;
  }

  /**
   * The pieces of this parse a text continuing it takes unchanged: each piece cut before the last
   * whose text the continuing text holds as it was, and the head they share.
   */
  public piecesContinuedBy(
    blockSource: string,
    definitionPreamble: string,
    cut: TableCut,
  ): ReusedPieces | undefined {
    const earlier = this.#block;
    if (
      definitionPreamble !== earlier.definitionPreamble ||
      cut.headStart !== earlier.cut.headStart ||
      cut.headEnd !== earlier.cut.headEnd
    ) {
      return undefined;
    }
    let count = 0;
    // The last piece ends where its text did, which the continuing text may carry on.
    while (count < this.#pieces.length - 1 && isSamePiece(cut.pieces[count], this.#pieces[count])) {
      count += 1;
    }
    const nextStart = this.#pieces[count]?.piece.rowsStart;
    if (
      count === 0 ||
      nextStart === undefined ||
      !hasPrefix(blockSource, earlier.blockSource.slice(0, nextStart))
    ) {
      return undefined;
    }
    return { pieces: this.#pieces.slice(0, count), head: this.#head };
  }

  #readBodyRow(bodyIndex: number): TableRow | undefined {
    const pieceIndex = pieceIndexOf(this.#pieces, bodyIndex);
    const checked = this.#pieces[pieceIndex];
    if (checked === undefined) {
      return undefined;
    }
    return this.#reading(pieceIndex, checked)?.row(1 + bodyIndex - checked.piece.firstRowIndex);
  }

  /** The piece's kept reading, made from its tree while it is kept, and kept as read last. */
  #reading(pieceIndex: number, checked: CheckedPiece): PieceReading | undefined {
    let reading = this.#readings.get(pieceIndex);
    if (reading === undefined) {
      const parsed = this.#trees.read(checked.key);
      if (parsed === undefined) {
        return undefined;
      }
      reading = new PieceReading(checked, parsed, this.#block.cut);
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
  public readonly parsed: ParsedTablePiece;
  readonly #reader: MdastReader;
  readonly #checked: CheckedPiece;
  readonly #offsetShift: number;
  readonly #rowIds: readonly number[];
  readonly #placedRowIds = new Set<number>();
  /** The text the piece's offsets count in, read from the parser's own copy of it. */
  readonly #parsedText: string;

  public constructor(checked: CheckedPiece, parsed: ParsedTablePiece, cut: TableCut) {
    this.parsed = parsed;
    this.#checked = checked;
    this.#offsetShift = offsetShiftOf(cut, checked.piece);
    this.#reader = new MdastReader(parsed.buffer);
    this.#rowIds = this.#reader.getChildIds(checked.tableId);
    this.#parsedText = this.#reader.getStringPool();
  }

  /** The piece's table row `index`, its head row first. */
  public row(index: number): TableRow {
    const rowId = this.#rowIds[index];
    if (rowId === undefined) {
      throw new RangeError(`The piece holds no row ${String(index)}.`);
    }
    const row = materializeNode(this.#reader, rowId) as TableRow;
    if (!this.#placedRowIds.has(rowId)) {
      this.#placedRowIds.add(rowId);
      // The piece's whole text is tested only for a row whose own text may need restoring.
      const dollarStandIn = this.parsed.dollarStandIn;
      const start = row.position?.start.offset ?? 0;
      const end = row.position?.end.offset ?? this.#parsedText.length;
      if (dollarStandIn !== undefined || mayHoldLiteralText(this.#parsedText.slice(start, end))) {
        restoreLiteralText(row, this.#parsedText, dollarStandIn);
      }
      if (index > 0) {
        shiftPositions(row, this.#offsetShift, this.#checked.piece.lineShift);
      }
    }
    return row;
  }
}

/** Whether `parsed`, a piece parsed again, holds the table its first parse checked. */
function isSameTable(parsed: ParsedTablePiece, checked: CheckedPiece): boolean {
  const reader = new MdastReader(parsed.buffer);
  return (
    checked.tableId < reader.nodeCount &&
    reader.getNodeType(checked.tableId) === NodeType.Table &&
    reader.getChildIds(checked.tableId).length === checked.piece.rowCount + 1
  );
}

function isSamePiece(piece: TablePiece | undefined, checked: CheckedPiece | undefined): boolean {
  return (
    piece !== undefined &&
    checked !== undefined &&
    piece.rowsStart === checked.piece.rowsStart &&
    piece.rowsEnd === checked.piece.rowsEnd &&
    piece.firstRowIndex === checked.piece.firstRowIndex
  );
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
function pieceIndexOf(pieces: readonly CheckedPiece[], bodyIndex: number): number {
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
