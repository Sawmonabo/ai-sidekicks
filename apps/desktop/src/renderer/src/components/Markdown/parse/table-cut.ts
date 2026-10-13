// Where a text whose last block is a long table is cut into the pieces it parses in. Each piece is
// the table's head and delimiter lines over a run of its rows, cut at the end of a row; the first
// piece also carries the blocks before the table, as a streaming tail holds them, so the pieces
// after it hold only the table.

/** One piece of a long table: the text it parses, and where its rows sit in the block. */
export interface TablePiece {
  /** Where the piece's text starts in the block: at its start for the first, at the head after. */
  readonly textStart: number;
  readonly rowsStart: number;
  readonly rowsEnd: number;
  /** The block's first body row this piece holds, counted from the first row below the head. */
  readonly firstRowIndex: number;
  readonly rowCount: number;
  /** How many lines on the block holds each line of the piece's rows. */
  readonly lineShift: number;
}

/** A block cut into the pieces it parses in: where its table's head runs, then the pieces. */
export interface TableCut {
  /** Where the head line starts: how long the blocks before the table are. */
  readonly headStart: number;
  /** Where the head and delimiter lines end, with the line ending after them. */
  readonly headEnd: number;
  readonly pieces: readonly TablePiece[];
}

/**
 * The most characters of a block's rows one piece holds, cut at the end of a row; a block no longer
 * than this is never cut. Measured on the bench's rows, a piece this long parses in under a
 * millisecond into a tree of about 373 KB.
 */
export const TABLE_PIECE_CHARACTERS = 32_768;

/**
 * The pieces `blockSource` parses in: `undefined` unless it is longer than one piece and its last
 * block, after a blank line or at its start, opens on a table's head and delimiter lines. A block
 * that passes may still not end in one table; reading its pieces finds that out.
 */
export function tableCutOf(blockSource: string): TableCut | undefined {
  if (blockSource.length <= TABLE_PIECE_CHARACTERS) {
    return undefined;
  }
  // A block is cut through the blank lines that end it, which hold no row.
  const rowsEnd = withoutTrailingLineEndings(blockSource);
  const headStart = lastBlockStartOf(blockSource, rowsEnd);
  const delimiterStart = lineEndOf(blockSource, headStart) + 1;
  const delimiterEnd = lineEndOf(blockSource, delimiterStart);
  if (
    !blockSource.slice(headStart, delimiterStart).includes("|") ||
    !DELIMITER_ROW.test(blockSource.slice(delimiterStart, delimiterEnd))
  ) {
    return undefined;
  }
  const headEnd = delimiterEnd + 1;
  const leadLineCount = headStart === 0 ? 0 : countLines(blockSource, 0, headStart) - 1;
  const pieces: TablePiece[] = [];
  let rowsStart = headEnd;
  let firstRowIndex = 0;
  while (rowsStart < rowsEnd) {
    const cut = blockSource.indexOf("\n", rowsStart + TABLE_PIECE_CHARACTERS);
    const isLast = cut === -1 || cut >= rowsEnd;
    const pieceEnd = isLast ? rowsEnd : withoutLineEnding(blockSource, cut);
    const rowCount = countLines(blockSource, rowsStart, pieceEnd);
    const isFirst = pieces.length === 0;
    pieces.push({
      textStart: isFirst ? 0 : headStart,
      rowsStart,
      rowsEnd: pieceEnd,
      firstRowIndex,
      rowCount,
      lineShift: isFirst ? 0 : firstRowIndex + leadLineCount,
    });
    firstRowIndex += rowCount;
    rowsStart = isLast ? rowsEnd : cut + 1;
  }
  return { headStart, headEnd, pieces };
}

/** How many code units on the block holds each character of `piece`'s rows. */
export function offsetShiftOf(cut: TableCut, piece: TablePiece): number {
  return piece.rowsStart - (cut.headEnd - piece.textStart);
}

/** A table's delimiter line, as GFM reads one: cells of dashes, each with optional colons. */
const DELIMITER_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*\r?$/u;

/**
 * Where the last block before `end` starts: the line after the last blank line before it, or the
 * text's start. A blank line holding spaces is not looked for; a block found before it fails the
 * head's test or its pieces' check, and is parsed whole.
 */
function lastBlockStartOf(text: string, end: number): number {
  const blankLine = Math.max(
    text.lastIndexOf("\n\n", end - 1),
    text.lastIndexOf("\n\r\n", end - 1),
  );
  return blankLine === -1 ? 0 : text.indexOf("\n", blankLine + 1) + 1;
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

/** How many lines `text` holds from `start` to `end`. */
function countLines(text: string, start: number, end: number): number {
  let count = 1;
  for (
    let index = text.indexOf("\n", start);
    index !== -1 && index < end;
    index = text.indexOf("\n", index + 1)
  ) {
    count += 1;
  }
  return count;
}
