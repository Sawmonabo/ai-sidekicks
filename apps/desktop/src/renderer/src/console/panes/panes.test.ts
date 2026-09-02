// The pane seat board holds reserved lines and nothing else.
//
// Its whole value is that six branches can each replace one line without touching
// another's. That property survives only while the file stays composition-only: a
// condition, a shared local, or a registration made outside a family's own line
// turns six one-line diffs back into six edits to one region.
//
// So this file reads the seat board's SOURCE. The behavioural check below — that
// composing registers nothing — is the stronger claim about today, but it says
// nothing about whether the six reserved lines still exist, in order, spelled the
// way the branches are cutting against. A branch that renamed or reordered them
// would pass every behavioural assertion and conflict with five other branches.
//
// `node:fs` is banned in renderer programs (`Spec-023 §Trust Stance`), so the
// source arrives inlined at transform time through Vite's raw glob — the form
// `runtime-node-attach/__tests__/NodeRoster.test.tsx` established for CP-003-3's
// source-text reads.

import { describe, expect, it } from "vitest";

import { ConsolePaneRegistry, type PaneKind } from "../workspace/index.js";
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

/**
 * The lines still reserved, in the order the branches cut against.
 *
 * A family that lands REPLACES its line, so this list shrinks by exactly one entry
 * per family and the assertion below stays a claim about the seats nobody has taken
 * yet. `T-023p-1C-3` is gone from it because that family's three registrations are
 * on the board; the case that pins them is in the composition block.
 */
const RESERVED_LINES: readonly string[] = [
  "// T-023p-1C-2 timeline",
  "// T-023p-1C-4 agent-console",
  "// T-023p-1C-5 diff artifact",
  "// T-023p-1C-6 workflow-run workflow-builder",
  "// T-023p-1C-7 browser terminal",
];

/** Kinds a landed family has claimed, in the declaration order the deck answers in. */
const CLAIMED_PANE_KINDS: readonly PaneKind[] = ["inspector", "runs", "approvals"];

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

  it("carries every unclaimed seat's reserved line, in task order", () => {
    const body = seatBoardFunctionBody(seatBoardSource);
    const commentLines = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("//"));
    expect(commentLines).toStrictEqual([...RESERVED_LINES]);
  });

  it("negative control: a body that lost a reserved line is rejected", () => {
    // Without this, the case above would pass over an implementation of
    // `seatBoardFunctionBody` that returned the reserved lines whatever the file
    // said — and over a regex that matched a prefix of a longer body.
    const withoutSeat = seatBoardSource.replace("  // T-023p-1C-2 timeline\n", "");
    expect(withoutSeat).not.toBe(seatBoardSource);
    expect(
      seatBoardFunctionBody(withoutSeat)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("//")),
    ).not.toStrictEqual([...RESERVED_LINES]);
  });
});

describe("pane seat board — composing it today", () => {
  it("claims exactly the kinds the landed families own", () => {
    const registry = new ConsolePaneRegistry();
    registerConsolePanes(registry);
    expect(registry.registeredPaneKinds()).toStrictEqual([...CLAIMED_PANE_KINDS]);
  });

  it("survives being composed twice, as a hot reload does it", () => {
    const registry = new ConsolePaneRegistry();
    expect(() => {
      registerConsolePanes(registry);
      registerConsolePanes(registry);
    }).not.toThrow();
  });

  it("negative control: a kind no family claimed is absent", () => {
    // The list above would also be produced by a `registeredPaneKinds` that
    // answered every declared kind, which would make the case vacuous.
    const registry = new ConsolePaneRegistry();
    registerConsolePanes(registry);
    expect(registry.registeredPaneKinds()).not.toContain("timeline");
    // And the registry does report a kind once someone claims it, so the absence
    // above is a fact about the seat board rather than about the registry.
    registry.register({
      kind: "timeline",
      owner: "panes-test",
      render: () => null,
      openInWindow: true,
    });
    expect(registry.registeredPaneKinds()).toContain("timeline");
  });
});
