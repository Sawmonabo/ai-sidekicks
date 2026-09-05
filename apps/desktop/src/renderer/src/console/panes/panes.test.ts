// The pane seat board holds one line per family and nothing else.
//
// Its whole value is that six branches can each replace one line without touching
// another's. That property survives only while the file stays composition-only: a
// condition, a shared local, or a registration made outside a family's own line
// turns six one-line diffs back into six edits to one region.
//
// So this file reads the seat board's SOURCE. The behavioural checks below — which
// kinds a compose claims — are the stronger claim about today, but they say nothing
// about whether the lines still stand in order, one per family, spelled the way the
// branches are cutting against. A branch that renamed or reordered them would pass
// every behavioural assertion and conflict with five other branches.
//
// A line is expected as EITHER the reserved comment or that family's own
// registration call, because the board is filled one family at a time and a test
// pinning today's occupants would have to be edited by every branch that fills a
// seat — which makes it a second seat board and reintroduces the conflict the first
// one exists to avoid.
//
// `node:fs` is banned in renderer programs (`Spec-023 §Trust Stance`), so the
// source arrives inlined at transform time through Vite's raw glob — the form
// `runtime-node-attach/__tests__/NodeRoster.test.tsx` established for CP-003-3's
// source-text reads.

import { describe, expect, it } from "vitest";

import { PANE_KINDS, ConsolePaneRegistry } from "../seats/index.js";
import { registerConsolePanes } from "./index.js";

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

/**
 * Every module this directory holds, so the board can be checked to hold only itself.
 *
 * The same raw glob rather than a directory read, for the reason above it: `node:fs` is
 * banned in renderer programs, and this suite runs as one.
 */
const boardDirectoryModules = import.meta.glob("./**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * What the pane board directory is allowed to contain besides this suite.
 *
 * Vite resolves a glob against every module but the one doing the importing, so this
 * file is absent from the reading by construction rather than by an exclusion somebody
 * has to remember.
 */
const BOARD_DIRECTORY_MODULES: readonly string[] = ["./index.ts"];

/** The seat board's own text. One entry, keyed by the glob's resolved path. */
const seatBoardSource: string = Object.values(seatBoardSources).join("");

/** One seat: its reserved comment, and the call the owning family replaces it with. */
interface PaneSeat {
  readonly reservedLine: string;
  readonly registrationCall: string;
}

/** The seats, in the order the branches cut against. */
const PANE_SEATS: readonly PaneSeat[] = [
  {
    reservedLine: "// T-023p-1C-2 timeline",
    // The ledger's seat carries a composition argument: the shared pane chrome is
    // `workspace/`'s and a view family may not import a sibling, so the board — one of
    // the two files that may name more than one family — names the component here. A
    // seat is still ONE line, which is what keeps six branches from colliding.
    registrationCall: "registerLedgerPanes(registry, { paneHeader: PaneHeader });",
  },
  {
    reservedLine: "// T-023p-1C-3 runs approvals inspector",
    registrationCall: "registerConversationPanes(registry);",
  },
  {
    reservedLine: "// T-023p-1C-4 agent-console",
    registrationCall: "registerCollaborationPanes(registry);",
  },
  {
    reservedLine: "// T-023p-1C-5 diff artifact",
    registrationCall: "registerReposPanes(registry);",
  },
  {
    reservedLine: "// T-023p-1C-6 workflow-run workflow-builder",
    registrationCall: "registerWorkflowsPanes(registry);",
  },
  {
    reservedLine: "// T-023p-1C-7 browser terminal",
    registrationCall: "registerBrowserTerminalPanes(registry);",
  },
];

/** The body of `registerConsolePanes`, from its brace to the matching close. */
function seatBoardFunctionBody(source: string): string {
  const bodyMatch =
    /export function registerConsolePanes\([^)]*\): void \{\n(?<body>[\s\S]*?)\n\}/u.exec(source);
  if (bodyMatch?.groups?.["body"] === undefined) {
    throw new Error("registerConsolePanes was not found in the seat board's source");
  }
  return bodyMatch.groups["body"];
}

describe("pane seat board — reserved lines only", () => {
  it("reads its own source", () => {
    // The glob would silently resolve to nothing if the pattern stopped matching,
    // and every assertion below would then run against an empty string and pass
    // vacuously. This case is what makes the rest of the file mean anything.
    expect(Object.keys(seatBoardSources)).toHaveLength(1);
    expect(seatBoardSource).toContain("export function registerConsolePanes");
  });

  it("holds the board and this suite, and no pane body", () => {
    // WHY THIS IS THE BOARD'S OWN CLAIM AND NOT A FAMILY'S. The layering gate names
    // this directory a composition site and subtracts it from BOTH endpoints of the
    // view-family rules — that is what lets one file name every family without being
    // read as one. The subtraction is a path prefix, so anything parked under here is
    // invisible to the rule that keeps six concurrently-built families from importing
    // each other. A pane body is view code and belongs in its own family, beside the
    // rest of it; while this directory holds only the board and this suite, every body
    // in the console is inside a family and therefore inside that rule's reach.
    expect(Object.keys(boardDirectoryModules).sort()).toStrictEqual(BOARD_DIRECTORY_MODULES);
  });

  it("carries one line per seat, in task order, each reserved or filled", () => {
    const body = seatBoardFunctionBody(seatBoardSource);
    const lines = body.split("\n").map((line) => line.trim());
    expect(lines).toHaveLength(PANE_SEATS.length);
    for (const [position, seat] of PANE_SEATS.entries()) {
      expect([seat.reservedLine, seat.registrationCall]).toContain(lines[position]);
    }
  });

  it("negative control: a body carrying anything else is rejected", () => {
    // Without this, the case above would pass over an implementation of
    // `seatBoardFunctionBody` that returned the seat lines whatever the file said —
    // and over a regex that matched a prefix of a longer body. The planted line is
    // a shared local, which is exactly the shape that turns six one-line diffs back
    // into six edits to one region.
    const withSharedLocal = seatBoardSource.replace(
      "  registerLedgerPanes(registry, { paneHeader: PaneHeader });\n",
      "  const shared = registry;\n",
    );
    expect(withSharedLocal).not.toBe(seatBoardSource);
    const lines = seatBoardFunctionBody(withSharedLocal)
      .split("\n")
      .map((line) => line.trim());
    const firstSeat = PANE_SEATS[0];
    if (firstSeat === undefined) {
      throw new Error("the seat table is empty");
    }
    expect([firstSeat.reservedLine, firstSeat.registrationCall]).not.toContain(lines[0]);
  });
});

describe("pane seat board — composing it today", () => {
  it("claims only the kinds a filled seat names, into the registry it was handed", () => {
    // Deliberately about the SHAPE rather than about which kinds are in it, on
    // `families.test.ts`' reasoning: a case pinning today's occupants would be
    // edited by every branch that fills a seat. What is asserted is that composing
    // claims something, and claims only declared kinds.
    const registry = new ConsolePaneRegistry();
    registerConsolePanes(registry);
    const kinds = registry.registeredPaneKinds();
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      expect(PANE_KINDS).toContain(kind);
    }
  });

  it("composes into a registry the caller owns, not a singleton", () => {
    const first = new ConsolePaneRegistry();
    const second = new ConsolePaneRegistry();
    registerConsolePanes(first);
    expect(second.registeredPaneKinds()).toStrictEqual([]);
    registerConsolePanes(second);
    expect(second.registeredPaneKinds()).toStrictEqual(first.registeredPaneKinds());
  });

  it("survives being composed twice, as a hot reload does it", () => {
    // Same owners re-claiming the same kinds: the owner-scoped policy replaces. A
    // family that changed its owner string between composes would raise here, which
    // is the correct answer — the owner is what the policy is about.
    const registry = new ConsolePaneRegistry();
    expect(() => {
      registerConsolePanes(registry);
      registerConsolePanes(registry);
    }).not.toThrow();
  });

  it("negative control: the registry itself does report a claimed kind", () => {
    // The empty result the case above reads would also be produced by a
    // `registeredPaneKinds` that always answered `[]`, which would make that case
    // vacuous. The kind is one no filled seat claims, so this stays a claim about
    // the registry rather than about which family happens to have landed.
    const registry = new ConsolePaneRegistry();
    registry.register({ kind: "agent-console", owner: "panes-test", render: () => null });
    expect(registry.registeredPaneKinds()).toStrictEqual(["agent-console"]);
  });
});
