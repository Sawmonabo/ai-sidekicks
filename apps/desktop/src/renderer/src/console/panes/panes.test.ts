// The pane seat board holds reserved lines and nothing else.
//
// Its whole value is that six branches can each replace one line without touching
// another's. That property survives only while the file stays composition-only: a
// condition, a shared local, or a registration made outside a family's own line
// turns six one-line diffs back into six edits to one region.
//
// So this file reads the seat board's SOURCE. The behavioural checks below are the
// stronger claim about what is registered today, but they say nothing about whether
// the six seats still exist, in order, spelled the way the branches are cutting
// against. A branch that renamed or reordered them would pass every behavioural
// assertion and conflict with five other branches.
//
// THE SEAT TABLE IS PER TASK AND NOT PER LINE, so a family filling its own seat
// needs no edit here. Each seat is satisfied by EITHER its reserved comment or that
// family's own registration call — the two states a seat is ever in — which is what
// keeps this test from becoming the second shared spine the first one exists to
// avoid. What it still pins is the SET and the ORDER.
//
// `node:fs` is banned in renderer programs (`Spec-023 §Trust Stance`), so the
// source arrives inlined at transform time through Vite's raw glob — the form
// `runtime-node-attach/__tests__/NodeRoster.test.tsx` established for CP-003-3's
// source-text reads.

import { describe, expect, it } from "vitest";

import { ConsolePaneRegistry } from "../workspace/index.js";
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

/** The seat board's own text. One entry, keyed by the glob's resolved path. */
const seatBoardSource: string = Object.values(seatBoardSources).join("");

/** The six seats, in the order the branches cut against. */
const RESERVED_LINES: readonly string[] = [
  "// T-023p-1C-2 timeline",
  "// T-023p-1C-3 runs approvals inspector",
  "// T-023p-1C-4 agent-console",
  "// T-023p-1C-5 diff artifact",
  "// T-023p-1C-6 workflow-run workflow-builder",
  "// T-023p-1C-7 browser terminal",
];

/**
 * A filled seat: exactly one registration call and nothing else on the line.
 *
 * Anchored at both ends on purpose. An unanchored pattern would accept a line that
 * carried a condition or a second statement beside the call, which is the shape this
 * whole file exists to keep out of the seat board.
 */
const FILLED_SEAT = /^register[A-Za-z]+Panes\(registry\);$/u;

/** Whether a body line satisfies the seat at its position. */
function satisfiesSeat(line: string, reserved: string): boolean {
  return line === reserved || FILLED_SEAT.test(line);
}

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

  it("carries the six seats in task order, each reserved or filled", () => {
    const lines = seatBoardFunctionBody(seatBoardSource)
      .split("\n")
      .map((line) => line.trim());
    expect(lines).toHaveLength(RESERVED_LINES.length);
    expect(
      lines.map((line, seatIndex) => satisfiesSeat(line, RESERVED_LINES[seatIndex] ?? "")),
    ).toStrictEqual(RESERVED_LINES.map(() => true));
  });

  it("negative control: a seventh line, or a line that is neither state, is rejected", () => {
    // Without this, the case above would pass over an implementation of
    // `seatBoardFunctionBody` that returned the seats whatever the file said, over a
    // regex that matched a prefix of a longer body, and over a `satisfiesSeat` that
    // answered `true` for anything.
    const withStrayStatement = seatBoardSource.replace(
      "  // T-023p-1C-2 timeline\n",
      "  const registrations = registry;\n",
    );
    expect(withStrayStatement).not.toBe(seatBoardSource);
    const lines = seatBoardFunctionBody(withStrayStatement)
      .split("\n")
      .map((line) => line.trim());
    expect(
      lines.map((line, seatIndex) => satisfiesSeat(line, RESERVED_LINES[seatIndex] ?? "")),
    ).not.toStrictEqual(RESERVED_LINES.map(() => true));
  });
});

describe("pane seat board — composing it today", () => {
  it("claims each pane kind once, and files each descriptor under its own kind", () => {
    // Which kinds are claimed is each family's own claim, asserted in that family's
    // own test; what the BOARD owes is that composing it leaves no kind claimed
    // twice and no descriptor filed under a kind it does not name — the two ways a
    // seat line can be wrong without any family's own test noticing.
    const registry = new ConsolePaneRegistry();
    registerConsolePanes(registry);
    const kinds = registry.registeredPaneKinds();
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds.map((kind) => registry.descriptorFor(kind)?.kind)).toStrictEqual([...kinds]);
  });

  it("survives being composed twice, as a hot reload does it", () => {
    const registry = new ConsolePaneRegistry();
    expect(() => {
      registerConsolePanes(registry);
      registerConsolePanes(registry);
    }).not.toThrow();
  });

  it("composes into a registry the caller owns, not a singleton", () => {
    // The seat signature takes a registry so a test can compose into its own and an
    // auxiliary window can compose a subset. A family that reached for the
    // module-scope singleton would leave this one empty while still "working".
    const first = new ConsolePaneRegistry();
    const second = new ConsolePaneRegistry();
    registerConsolePanes(first);
    expect(second.registeredPaneKinds()).toStrictEqual([]);
    registerConsolePanes(second);
    expect(second.registeredPaneKinds()).toStrictEqual(first.registeredPaneKinds());
  });

  it("negative control: a fresh registry claims nothing on its own", () => {
    // Every case above reads the registry back, and all of them would pass over a
    // registry that reported kinds nobody registered.
    expect(new ConsolePaneRegistry().registeredPaneKinds()).toStrictEqual([]);
  });
});
