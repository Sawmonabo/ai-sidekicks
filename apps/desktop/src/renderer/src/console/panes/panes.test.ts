// The pane seat board holds one seat per task and nothing else.
//
// Its whole value is that six branches can each fill one seat without touching
// another's. That property survives only while the file stays composition-only: a
// condition, a shared local, or a registration made outside a family's own seat
// turns six one-line diffs back into six edits to one region.
//
// So this file reads the seat board's SOURCE. The behavioural check below — which
// kinds composing claims — is the stronger claim about today, but it says nothing
// about whether the seats still exist, in order, spelled the way the branches are
// cutting against: a branch that renamed or reordered them would pass every
// behavioural assertion and conflict with five other branches.
//
// WHAT THIS FILE MAY NOT CONTAIN, WHICH IS WHY IT READS A CENSUS AND NOT A LIST.
// Every one of those six branches carries this file, and they have to carry it
// BYTE-IDENTICAL or the merge that was supposed to be six one-line diffs becomes
// six divergent copies of the suite that polices them. Its first version compared
// the body against an ordered literal of the exact seat lines, which is
// family-specific by construction — each branch fills a different seat, so each
// branch has to edit the literal. What replaced it is a census over the board's
// GRAMMAR (`seat-census.test-support.ts`), which is the same text on every branch:
// nothing below names a family, a pane kind, or which seats are filled today.
//
// `node:fs` is banned in renderer programs (`Spec-023 §Trust Stance`), so the
// source arrives inlined at transform time through Vite's raw glob — the form
// `runtime-node-attach/__tests__/NodeRoster.test.tsx` established for CP-003-3's
// source-text reads.

import { describe, expect, it } from "vitest";

import { ConsolePaneRegistry, consolePaneRegistry } from "../seats/index.js";
import { registerFreePaneKindProbe } from "../seats/pane-probe.test-support.js";
import { registerConsolePanes } from "./index.js";
import {
  filledSeatLine,
  PANE_SEAT_TASK_ORDINALS,
  readSeatBoardCensus,
  reservedSeatLine,
  seatBoardSourceFrom,
  type SeatBoardOffence,
  type SeatGroup,
} from "./seat-census.test-support.js";

declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { query: "?raw"; import: "default"; eager: true },
    ) => Record<string, string>;
  }
}

const seatBoardSources = import.meta.glob("./index.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The seat board's own text. One entry, keyed by the glob's resolved path. */
const seatBoardSource: string = Object.values(seatBoardSources).join("");

/** What a synthetic seat line claims. Deliberately not a real pane kind. */
const SYNTHETIC_KIND_WORDS = "seat-kind";

/** A seat still holding its reserved comment, as a case expects to read it back. */
function reserved(taskOrdinal: number): SeatGroup {
  return { taskOrdinal, filled: false, lineCount: 1 };
}

/** A seat a family filled, spending `lineCount` lines on it. */
function filled(taskOrdinal: number, lineCount: number): SeatGroup {
  return { taskOrdinal, filled: true, lineCount };
}

/**
 * A board body whose seats are reserved, except where `fills` names a line count.
 *
 * Fixture assembly rather than a second copy of the rule: what it produces is the
 * INPUT, and every case below states the census it expects back by hand. A helper
 * that derived the expectation from the same map would be comparing the fixture
 * with itself.
 */
function boardBody(fills: ReadonlyMap<number, number>): readonly string[] {
  return PANE_SEAT_TASK_ORDINALS.flatMap((taskOrdinal) => {
    const lineCount = fills.get(taskOrdinal);
    return lineCount === undefined
      ? [reservedSeatLine(taskOrdinal, SYNTHETIC_KIND_WORDS)]
      : Array.from({ length: lineCount }, () => filledSeatLine(taskOrdinal, SYNTHETIC_KIND_WORDS));
  });
}

/** One board the census is expected to read cleanly, and what it should read as. */
interface WellFormedBoardCase {
  readonly name: string;
  readonly body: readonly string[];
  readonly seats: readonly SeatGroup[];
}

const WELL_FORMED_BOARDS: readonly WellFormedBoardCase[] = [
  {
    name: "every seat reserved",
    body: boardBody(new Map()),
    seats: [reserved(2), reserved(3), reserved(4), reserved(5), reserved(6), reserved(7)],
  },
  {
    name: "one seat filled with a single line",
    body: boardBody(new Map([[4, 1]])),
    seats: [reserved(2), reserved(3), filled(4, 1), reserved(5), reserved(6), reserved(7)],
  },
  {
    name: "one seat filled with three lines",
    body: boardBody(new Map([[3, 3]])),
    seats: [reserved(2), filled(3, 3), reserved(4), reserved(5), reserved(6), reserved(7)],
  },
  {
    name: "two seats filled",
    body: boardBody(
      new Map([
        [2, 1],
        [7, 2],
      ]),
    ),
    seats: [filled(2, 1), reserved(3), reserved(4), reserved(5), reserved(6), filled(7, 2)],
  },
  {
    name: "every seat filled",
    body: boardBody(
      new Map(PANE_SEAT_TASK_ORDINALS.map((taskOrdinal): [number, number] => [taskOrdinal, 1])),
    ),
    seats: [filled(2, 1), filled(3, 1), filled(4, 1), filled(5, 1), filled(6, 1), filled(7, 1)],
  },
];

/** One malformed board, and every offence the census is expected to name for it. */
interface MalformedBoardCase {
  readonly name: string;
  readonly body: readonly string[];
  readonly offences: readonly SeatBoardOffence[];
}

const MALFORMED_BOARDS: readonly MalformedBoardCase[] = [
  {
    name: "a registration carrying no task marker",
    body: [...boardBody(new Map()), `  registerSeatPanes(registry); // ${SYNTHETIC_KIND_WORDS}`],
    offences: ["unmarked-line"],
  },
  {
    name: "a statement that is not a registration at all",
    body: [...boardBody(new Map()), "  const seatCount = 0;"],
    offences: ["unmarked-line"],
  },
  {
    name: "two seats out of task order",
    body: [2, 3, 4, 6, 5, 7].map((taskOrdinal) =>
      reservedSeatLine(taskOrdinal, SYNTHETIC_KIND_WORDS),
    ),
    offences: ["task-out-of-order"],
  },
  {
    name: "one task id spent on two seats",
    body: [2, 3, 4, 5, 6, 7, 3].map((taskOrdinal) =>
      reservedSeatLine(taskOrdinal, SYNTHETIC_KIND_WORDS),
    ),
    // Two groups carrying one ordinal cannot also be ascending, so both offences
    // are the honest answer and asserting only one would be asserting less than
    // the census says.
    offences: ["task-out-of-order", "duplicate-task"],
  },
  {
    name: "a task id the board reserves no seat for",
    body: [...boardBody(new Map()), reservedSeatLine(9, SYNTHETIC_KIND_WORDS)],
    offences: ["task-out-of-range"],
  },
  {
    name: "a reserved seat deleted rather than filled",
    body: [2, 3, 4, 6, 7].map((taskOrdinal) => reservedSeatLine(taskOrdinal, SYNTHETIC_KIND_WORDS)),
    offences: ["missing-task"],
  },
  {
    name: "one seat holding both forms at once",
    body: [
      reservedSeatLine(2, SYNTHETIC_KIND_WORDS),
      reservedSeatLine(3, SYNTHETIC_KIND_WORDS),
      reservedSeatLine(4, SYNTHETIC_KIND_WORDS),
      filledSeatLine(4, SYNTHETIC_KIND_WORDS),
      reservedSeatLine(5, SYNTHETIC_KIND_WORDS),
      reservedSeatLine(6, SYNTHETIC_KIND_WORDS),
      reservedSeatLine(7, SYNTHETIC_KIND_WORDS),
    ],
    offences: ["malformed-seat-group"],
  },
  {
    name: "one reserved seat written twice",
    body: [2, 3, 4, 5, 6, 6, 7].map((taskOrdinal) =>
      reservedSeatLine(taskOrdinal, SYNTHETIC_KIND_WORDS),
    ),
    offences: ["malformed-seat-group"],
  },
];

describe("pane seat board — the grammar every branch cuts against", () => {
  it.each(WELL_FORMED_BOARDS)("reads $name", ({ body, seats }) => {
    const census = readSeatBoardCensus(seatBoardSourceFrom(body));

    expect(census.offences).toStrictEqual([]);
    expect(census.seats).toStrictEqual(seats);
  });

  it.each(MALFORMED_BOARDS)("refuses $name", ({ body, offences }) => {
    // The negative controls, one board per malformation. Without them the clean
    // arms above would pass over a census that reported no offence whatever the
    // board said, which is the failure this class of reader is most prone to.
    const census = readSeatBoardCensus(seatBoardSourceFrom(body));

    expect(census.offences).toStrictEqual(offences);
  });

  it("refuses a source with no seat board in it at all", () => {
    expect(readSeatBoardCensus("export const seats = [];\n").offences).toStrictEqual([
      "board-not-found",
    ]);
  });

  it("reads the declaration and not a copy of it in a comment", () => {
    // The boundary claim, which is what a line reader has to earn: the declaration
    // is matched at column 0, so prose quoting an older board is not the board. A
    // reader that searched for the text anywhere would take the comment's fake
    // seats and report a one-seat board.
    const quoted = [
      "// The board used to read:",
      "// export function registerConsolePanes(registry: ConsolePaneRegistry): void {",
      `// ${reservedSeatLine(2, SYNTHETIC_KIND_WORDS).trim()}`,
      "// }",
      "",
      seatBoardSourceFrom(boardBody(new Map())),
    ].join("\n");

    const census = readSeatBoardCensus(quoted);

    expect(census.offences).toStrictEqual([]);
    expect(census.seats).toHaveLength(PANE_SEAT_TASK_ORDINALS.length);
  });
});

describe("pane seat board — the board this branch ships", () => {
  it("reads its own source", () => {
    // The glob would silently resolve to nothing if the pattern stopped matching,
    // and every assertion below would then run against an empty string. This case
    // is what makes the rest of the file mean anything.
    expect(Object.keys(seatBoardSources)).toHaveLength(1);
    expect(seatBoardSource).toContain("export function registerConsolePanes");
  });

  it("holds one well-formed seat per reserved task, in task order", () => {
    const census = readSeatBoardCensus(seatBoardSource);

    expect(census.offences).toStrictEqual([]);
    expect(census.seats.map((seat) => seat.taskOrdinal)).toStrictEqual([
      ...PANE_SEAT_TASK_ORDINALS,
    ]);
  });
});

describe("pane seat board — composing it today", () => {
  it("writes into the registry it was handed and into no singleton", () => {
    // The probe is what keeps this from being vacuous, and it is registered AFTER
    // the composition on a kind the composition left free — never before it on a
    // kind named here. A named kind is claimed twice the day the family that owns
    // it lands, and the closed set has no member left to name once all six have
    // landed.
    // On a board with every kind claimed the composition's own registrations are
    // the probe, which is the arm `seats/pane-probe.test-support.test.ts` proves.
    const registry = new ConsolePaneRegistry();

    registerConsolePanes(registry);
    registerFreePaneKindProbe(registry, "panes-test");

    expect(registry.registeredPaneKinds().length).toBeGreaterThan(0);
    // THE DISCRIMINATING ASSERTION, AND THE ONE THE PROBE CANNOT MAKE. A probe put
    // straight into the owned board never travels through the composition, so a
    // board registrar that reached for the module-scope singleton would leave this
    // registry holding the probe alone — non-empty, and disjoint from a singleton
    // holding the seats' claims, which is to say green over the leak. What names it
    // is the production board being EXACTLY empty once a caller has composed its
    // own: no family registers into it at import time, by this board's own
    // contract, so anything in it after this line arrived through a composition
    // that ignored the registry it was handed.
    expect(consolePaneRegistry.registeredPaneKinds()).toStrictEqual([]);
  });

  it("survives being composed twice, as a hot reload does it", () => {
    const registry = new ConsolePaneRegistry();
    expect(() => {
      registerConsolePanes(registry);
      registerConsolePanes(registry);
    }).not.toThrow();
  });

  it("negative control: a fresh registry reports only what was put in it", () => {
    // Without it, the non-empty reading above could come from a
    // `registeredPaneKinds` that answered from somewhere other than the instance it
    // belongs to — the module-scope singleton, or a constant — and the emptiness
    // claim beside it would be reading that same wrong place.
    expect(new ConsolePaneRegistry().registeredPaneKinds()).toStrictEqual([]);
  });
});
