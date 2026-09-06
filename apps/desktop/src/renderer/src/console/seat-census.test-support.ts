// The seat boards' grammar, and the reader that holds both boards to it.
//
// TWO BOARDS, ONE GRAMMAR. `console/families.ts` seats the view families and
// `console/panes/index.ts` seats their pane bodies. They differ in what surrounds
// the seats — the pane board is composition-only, so its whole body is seats, while
// the family board composes the shipped families first and holds its seats at the
// foot — and in nothing else. One reader with a shape per board is what keeps that
// difference stated once rather than inferred twice, and it is why this module sits
// beside the two composition sites rather than inside either of them.
//
// WHY A GRAMMAR AND NOT A LIST OF LINES
//
// The first reader of this board compared its body against an ordered literal of
// the exact seat lines — every reserved comment spelled out and every landed
// family's call spelled out beside it. That literal is family-specific by
// construction: six branches each fill a different seat, so all six have to edit
// the one list, which is precisely the conflict the seat board exists to avoid.
// What the board actually states is a GRAMMAR — one group per task, in task order,
// each group either reserved or filled — and a grammar is the same text on every
// branch. So the reader below is a census over that grammar, and the claim a suite
// makes with it says nothing about which family has landed.
//
// WHAT A GROUP IS
//
// A group is a maximal run of consecutive body lines carrying one task ordinal. It
// is either exactly one RESERVED line — the comment a family has not replaced yet —
// or one or more FILLED lines, each a registration handed the boards it writes into
// and carrying that same ordinal. A
// family shipping two doors spends its seat on two lines and one shipping three
// spends it on three; both are one seat, which is what keeps the board's seat count
// stable as families land.
//
// WHAT THE READER REFUSES, AND WHY EACH REFUSAL IS ITS OWN NAME
//
// A line in the body that is neither blank nor a seat line, a group mixing the two
// forms or repeating the reserved one, groups out of task order, one ordinal in two
// groups, an ordinal the board does not reserve, and a reserved ordinal that has
// gone missing. Each is named separately because each has a different remedy, and a
// single "malformed" verdict would let a suite assert that something was wrong
// without ever saying what.
//
// WHY THIS IS A LINE READER AND NOT A PARSE
//
// `apps/desktop/AGENTS.md` sends a question about source text to the TypeScript
// parser, and `test/console/architecture/source-parse-home.test.ts` closes that
// road under `src/`: a co-located suite importing the parse home is TS6059, "not
// under rootDir", because the renderer project's `rootDir` is `src/`. Both readings
// point the same way here. The seats a board reserves are COMMENTS, which the
// compiler carries as trivia rather than as nodes, so a parse would answer with the
// calls and stay silent about the majority of the board.
//
// The boundary the parse rule is really about is closed a different way instead.
// The declaration is matched at column 0, so a copy of it inside a comment is not
// the board; the body ends at the first line that is exactly `}`, so an indented
// closing brace cannot truncate it; and every line a nested block would add is an
// unmarked line, which is an offence in its own right. What survives is a board
// whose text is written inside a block comment at column 0 — and its body lines
// would then be prose, which the reader refuses line by line.

/**
 * Where a board keeps its seats.
 *
 * `whole-body` is the pane board: it composes nothing else, so a line that is not a
 * seat is a line that does not belong. `at-the-foot` is the family board: it calls
 * the shipped families first, with the prose that explains each call, and its seats
 * are the run of lines that closes the function. The distinction is only about where
 * the block STARTS — inside it both boards obey the same grammar, which is what makes
 * a prose paragraph between two seats an offence on either one.
 */
type SeatBlockPlacement = "whole-body" | "at-the-foot";

/** How one seat board is written, so one reader can hold both to their grammar. */
export interface SeatBoardShape {
  /** How the board's function declares itself, matched at column 0. */
  readonly declarationPrefix: string;
  /** The task ordinals this board reserves a seat for, low to high. */
  readonly taskOrdinals: readonly number[];
  readonly seatBlock: SeatBlockPlacement;
}

/**
 * The deck's pane bodies.
 *
 * Six ordinals and not the family board's seven: `console/families.ts` reserves a
 * seat for a family that claims no pane kind at all, so the two ranges are
 * deliberately different lengths and neither is derived from the other.
 */
export const PANE_SEAT_BOARD: SeatBoardShape = {
  declarationPrefix: "export function registerConsolePanes(",
  taskOrdinals: [2, 3, 4, 5, 6, 7],
  seatBlock: "whole-body",
};

/** The console's view families. */
export const FAMILY_SEAT_BOARD: SeatBoardShape = {
  declarationPrefix: "export function registerConsoleFamilies(",
  taskOrdinals: [2, 3, 4, 5, 6, 7, 8],
  seatBlock: "at-the-foot",
};

/**
 * Everything that can be wrong with a seat board, in the order a census reports it.
 *
 * The tuple is the declaration and the union is derived from it, for the reason
 * `seats/pane-kinds.ts` gives about its own set: a union written beside a
 * hand-repeated array is two closed sets that agree until someone widens one.
 */
const SEAT_BOARD_OFFENCES = [
  "board-not-found",
  "unmarked-line",
  "malformed-seat-group",
  "task-out-of-order",
  "duplicate-task",
  "task-out-of-range",
  "missing-task",
] as const;

/** One thing a seat board got wrong. Derived from the enumeration, never restated. */
export type SeatBoardOffence = (typeof SEAT_BOARD_OFFENCES)[number];

/** One seat, as the board spells it. */
export interface SeatGroup {
  /** The task ordinal every line of the group carries. */
  readonly taskOrdinal: number;
  /** Whether the seat holds registrations rather than its reserved comment. */
  readonly filled: boolean;
  /** How many lines the seat spends — one while reserved, one per door once filled. */
  readonly lineCount: number;
}

/** What a board reads as: the seats it holds, and everything wrong with it. */
interface SeatBoardCensus {
  readonly seats: readonly SeatGroup[];
  readonly offences: readonly SeatBoardOffence[];
}

/**
 * How a seat names its task, written once and spent by both the reader and the
 * synthetic boards the reader is proved over.
 *
 * A governance marker in comment text and in a census pattern, which is the shape
 * this board already uses; nothing here reaches a runtime string.
 */
const SEAT_TASK_MARKER_PREFIX = "T-023p-1C-";

/** What a seat line names after its marker: the kinds that line claims. */
const SEAT_KIND_WORDS = "[a-z][a-z-]*(?: [a-z][a-z-]*)*";

/**
 * What a registration is handed: the boards it writes into, named.
 *
 * A LIST AND NOT ONE ARGUMENT, because a board hands out as many registries as it
 * owns and a family writes into every one it claims a place on. The pane board has a
 * single parameter and its seats therefore pass one name; `console/families.ts` hands
 * out five, so no parameter of it is called `registry` and each of its seats passes
 * the subset that family needs. An earlier form pinned the literal `(registry)`,
 * which reads the pane board and can never read the other: every family seat parsed
 * as an unmarked line, the block began at the first still-reserved comment below it,
 * and the census reported the filled ordinal `missing-task` — a board refusing the
 * one edit it exists to accept.
 *
 * IDENTIFIERS AND NOT ARBITRARY TEXT, which is the half that keeps the grammar a
 * grammar. What a seat may pass is the names its board was handed; a call expression,
 * an object literal, or an empty list is not one, so each of those is an unmarked
 * line and not a seat — the same verdict prose gets, and for the same reason. A seat
 * needing a value that is not a board names it above the block, where the
 * composition and its prose already live, and passes that name here.
 */
const SEAT_REGISTRY_ARGUMENTS = "[A-Za-z]+(?:, [A-Za-z]+)*";

/** A seat still holding its reserved comment. */
const RESERVED_SEAT_LINE = new RegExp(
  `^// ${SEAT_TASK_MARKER_PREFIX}(\\d+) ${SEAT_KIND_WORDS}$`,
  "u",
);

/** A seat a family has filled: one registration, marked with that seat's task. */
const FILLED_SEAT_LINE = new RegExp(
  `^register[A-Za-z]+\\(${SEAT_REGISTRY_ARGUMENTS}\\); // ${SEAT_TASK_MARKER_PREFIX}(\\d+) ${SEAT_KIND_WORDS}$`,
  "u",
);

/** The line that closes it, which a composition-only body reaches at column 0. */
const BOARD_CLOSING_LINE = "}";

/** One body line that carries a seat marker. */
interface SeatLine {
  readonly taskOrdinal: number;
  readonly filled: boolean;
}

/** A maximal run of consecutive body lines carrying one task ordinal. */
interface SeatLineRun {
  readonly taskOrdinal: number;
  readonly lines: readonly SeatLine[];
}

/** Read one trimmed body line as a seat, or report that it is not one. */
function readSeatLine(text: string): SeatLine | undefined {
  const reservedMatch = RESERVED_SEAT_LINE.exec(text);
  if (reservedMatch?.[1] !== undefined) {
    return { taskOrdinal: Number(reservedMatch[1]), filled: false };
  }
  const filledMatch = FILLED_SEAT_LINE.exec(text);
  if (filledMatch?.[1] !== undefined) {
    return { taskOrdinal: Number(filledMatch[1]), filled: true };
  }
  return undefined;
}

/**
 * The lines between the board's declaration and its close, or nothing if absent.
 *
 * The declaration is matched at COLUMN 0 — prose quoting an older board is indented
 * behind a `//` and is therefore not the board — and its parameter list may run over
 * several lines, which is what the family board's five parameters make it do. So the
 * body opens at the first line from the declaration onward that ENDS in a brace, and
 * closes at the first line that is exactly one: a composition-only body reaches that
 * closing brace at column 0, and a nested block's would be indented.
 */
function boardBodyLines(source: string, board: SeatBoardShape): readonly string[] | undefined {
  const lines = source.split("\n");
  const declaration = lines.findIndex((line) => line.startsWith(board.declarationPrefix));
  if (declaration === -1) {
    return undefined;
  }
  const opening = lines.findIndex((line, index) => index >= declaration && line.endsWith("{"));
  if (opening === -1) {
    return undefined;
  }
  const closing = lines.indexOf(BOARD_CLOSING_LINE, opening + 1);
  return closing === -1 ? undefined : lines.slice(opening + 1, closing);
}

/**
 * The lines of `bodyLines` the seat grammar governs.
 *
 * On a `whole-body` board that is all of them. On an `at-the-foot` board it is
 * everything from the first seat line onward — the composition and the prose that
 * explains it sit above and are not the census's business, while a line inside the
 * block is. That boundary is the whole rule: a paragraph between two seats reads to
 * a branch exactly like a paragraph above them, and only one of the two leaves the
 * six one-line diffs at six distinct positions.
 */
function seatBlockLines(bodyLines: readonly string[], board: SeatBoardShape): readonly string[] {
  if (board.seatBlock === "whole-body") {
    return bodyLines;
  }
  const firstSeat = bodyLines.findIndex((line) => readSeatLine(line.trim()) !== undefined);
  return firstSeat === -1 ? [] : bodyLines.slice(firstSeat);
}

/** Group consecutive seat lines by the ordinal they carry. */
function seatLineRuns(seatLines: readonly SeatLine[]): readonly SeatLineRun[] {
  const runs: { taskOrdinal: number; lines: SeatLine[] }[] = [];
  for (const seatLine of seatLines) {
    const openRun = runs.at(-1);
    if (openRun !== undefined && openRun.taskOrdinal === seatLine.taskOrdinal) {
      openRun.lines.push(seatLine);
    } else {
      runs.push({ taskOrdinal: seatLine.taskOrdinal, lines: [seatLine] });
    }
  }
  return runs;
}

/** Whether a run is one of the two shapes a seat is allowed to take. */
function isWellFormedRun(run: SeatLineRun): boolean {
  if (run.lines.every((line) => line.filled)) {
    return true;
  }
  return run.lines.length === 1 && run.lines.every((line) => !line.filled);
}

/**
 * Read a seat board off its own source text.
 *
 * A pure function over the text rather than a reader of the real module, so the
 * suite that owns it can drive it over boards written by hand whose verdict is
 * known — including every malformed one, which the real board is never allowed to
 * become and which a rule reachable only through the live file could never be shown
 * to catch.
 */
export function readSeatBoardCensus(source: string, board: SeatBoardShape): SeatBoardCensus {
  const bodyLines = boardBodyLines(source, board);
  if (bodyLines === undefined) {
    return { seats: [], offences: ["board-not-found"] };
  }

  const raised = new Set<SeatBoardOffence>();
  const seatLines: SeatLine[] = [];
  for (const line of seatBlockLines(bodyLines, board)) {
    const text = line.trim();
    if (text === "") {
      continue;
    }
    const seatLine = readSeatLine(text);
    if (seatLine === undefined) {
      raised.add("unmarked-line");
      continue;
    }
    seatLines.push(seatLine);
  }

  const runs = seatLineRuns(seatLines);
  if (!runs.every(isWellFormedRun)) {
    raised.add("malformed-seat-group");
  }

  const seats = runs.map((run) => ({
    taskOrdinal: run.taskOrdinal,
    filled: run.lines.every((line) => line.filled),
    lineCount: run.lines.length,
  }));

  let previousOrdinal = Number.NEGATIVE_INFINITY;
  for (const seat of seats) {
    if (seat.taskOrdinal <= previousOrdinal) {
      raised.add("task-out-of-order");
    }
    previousOrdinal = seat.taskOrdinal;
  }

  const ordinals = seats.map((seat) => seat.taskOrdinal);
  if (new Set(ordinals).size !== ordinals.length) {
    raised.add("duplicate-task");
  }
  if (!ordinals.every((ordinal) => board.taskOrdinals.includes(ordinal))) {
    raised.add("task-out-of-range");
  }
  if (!board.taskOrdinals.every((ordinal) => ordinals.includes(ordinal))) {
    raised.add("missing-task");
  }

  return { seats, offences: SEAT_BOARD_OFFENCES.filter((offence) => raised.has(offence)) };
}

/** A seat still holding its reserved comment, as the board writes one. */
export function reservedSeatLine(taskOrdinal: number, kindWords: string): string {
  return `  // ${SEAT_TASK_MARKER_PREFIX}${String(taskOrdinal)} ${kindWords}`;
}

/** One of the registrations a family replaces its reserved comment with. */
export function filledSeatLine(taskOrdinal: number, kindWords: string): string {
  return `  registerSeatPanes(registry); // ${SEAT_TASK_MARKER_PREFIX}${String(taskOrdinal)} ${kindWords}`;
}

/**
 * A whole seat board around `bodyLines`, as a module the reader can be run over.
 *
 * The surrounding text is deliberately more than the declaration: a board carries an
 * import above its function, and a reader that only worked on a bare function would
 * be proved over text the real file never has. `linesAboveTheBlock` is what an
 * `at-the-foot` board composes before its seats — the calls and the prose that
 * explains them — so a case can put a line above the block and another inside it and
 * show that only one of the two is an offence.
 */
export function seatBoardSourceFrom(
  board: SeatBoardShape,
  bodyLines: readonly string[],
  linesAboveTheBlock: readonly string[] = [],
): string {
  return [
    'import type { SeatRegistry } from "./seats/index.js";',
    "",
    `${board.declarationPrefix}registry: SeatRegistry): void {`,
    ...linesAboveTheBlock,
    ...bodyLines,
    "}",
    "",
  ].join("\n");
}
