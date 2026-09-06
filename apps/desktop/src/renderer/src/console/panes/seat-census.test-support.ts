// The pane seat board's grammar, and the reader that holds the board to it.
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
// or one or more FILLED lines, each a registration carrying that same ordinal. A
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
 * Which task ordinals the pane seat board reserves, low to high.
 *
 * The board's own range and not the surface board's: `console/families.ts` reserves
 * a seat for a family that claims no pane kind at all, so the two boards' ordinal
 * sets are deliberately different lengths and neither is derived from the other.
 */
export const PANE_SEAT_TASK_ORDINALS: readonly number[] = [2, 3, 4, 5, 6, 7];

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

/** A seat still holding its reserved comment. */
const RESERVED_SEAT_LINE = new RegExp(
  `^// ${SEAT_TASK_MARKER_PREFIX}(\\d+) ${SEAT_KIND_WORDS}$`,
  "u",
);

/** A seat a family has filled: one registration, marked with that seat's task. */
const FILLED_SEAT_LINE = new RegExp(
  `^register[A-Za-z]+\\(registry\\); // ${SEAT_TASK_MARKER_PREFIX}(\\d+) ${SEAT_KIND_WORDS}$`,
  "u",
);

/** How the board's one function declares itself, matched at column 0. */
const BOARD_DECLARATION_PREFIX = "export function registerConsolePanes(";

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

/** The lines between the board's declaration and its close, or nothing if absent. */
function boardBodyLines(source: string): readonly string[] | undefined {
  const lines = source.split("\n");
  const declaration = lines.findIndex(
    (line) => line.startsWith(BOARD_DECLARATION_PREFIX) && line.endsWith("{"),
  );
  if (declaration === -1) {
    return undefined;
  }
  const closing = lines.indexOf(BOARD_CLOSING_LINE, declaration + 1);
  return closing === -1 ? undefined : lines.slice(declaration + 1, closing);
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
export function readSeatBoardCensus(source: string): SeatBoardCensus {
  const bodyLines = boardBodyLines(source);
  if (bodyLines === undefined) {
    return { seats: [], offences: ["board-not-found"] };
  }

  const raised = new Set<SeatBoardOffence>();
  const seatLines: SeatLine[] = [];
  for (const line of bodyLines) {
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
  if (!ordinals.every((ordinal) => PANE_SEAT_TASK_ORDINALS.includes(ordinal))) {
    raised.add("task-out-of-range");
  }
  if (!PANE_SEAT_TASK_ORDINALS.every((ordinal) => ordinals.includes(ordinal))) {
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
 * be proved over text the real file never has.
 */
export function seatBoardSourceFrom(bodyLines: readonly string[]): string {
  return [
    'import type { ConsolePaneRegistry } from "../seats/index.js";',
    "",
    "export function registerConsolePanes(registry: ConsolePaneRegistry): void {",
    ...bodyLines,
    "}",
    "",
  ].join("\n");
}
