// The pane seat board holds reserved lines and nothing else.
//
// Its whole value is that six branches can each fill one seat without touching
// another's. That property survives only while the file stays composition-only: a
// condition, a shared local, or a registration made outside a family's own seat
// turns six one-line diffs back into six edits to one region.
//
// So this file reads the seat board's SOURCE. The behavioural checks below are the
// stronger claim about what composing DOES, but they say nothing about whether the
// six reserved lines still exist, in order, spelled the way the branches are
// cutting against. A branch that renamed or reordered them would pass every
// behavioural assertion and conflict with five other branches.
//
// The assertions are deliberately blind to WHICH seats are filled. A case pinning
// today's occupants would have to be edited by every branch that fills one, which
// makes this file a second seat board and reintroduces the conflict the first one
// exists to avoid. What is pinned is the SHAPE: six comment lines in task order,
// every other line a registration call, and no kind registered for a seat whose
// call has not landed.
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

/** The reserved lines, in the order the branches cut against. */
const RESERVED_LINES: readonly string[] = [
  "// T-023p-1C-2 timeline",
  "// T-023p-1C-3 runs approvals inspector",
  "// T-023p-1C-4 agent-console",
  "// T-023p-1C-5 diff artifact",
  "// T-023p-1C-6 workflow-run workflow-builder",
  "// T-023p-1C-7 browser terminal",
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

/** The body's comment lines, in source order — the seat board proper. */
function reservedLines(source: string): readonly string[] {
  return seatBoardFunctionBody(source)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("//"));
}

/** The body's non-comment lines — the calls families have added beneath their seats. */
function registrationLines(source: string): readonly string[] {
  return seatBoardFunctionBody(source)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//"));
}

/**
 * The pane kinds one reserved line names.
 *
 * A seat's line is `// <task id> <kind> [<kind> …]`, and the kinds it names are the
 * ones that seat may claim. Reading them lets the composition cases assert about
 * UNFILLED seats without naming which seats those are today.
 */
function kindsNamedBy(reservedLine: string): readonly string[] {
  return reservedLine.split(/\s+/u).slice(2);
}

describe("pane seat board — reserved lines only", () => {
  it("reads its own source", () => {
    // The glob would silently resolve to nothing if the pattern stopped matching,
    // and every assertion below would then run against an empty string and pass
    // vacuously. This case is what makes the rest of the file mean anything.
    expect(Object.keys(seatBoardSources)).toHaveLength(1);
    expect(seatBoardSource).toContain("export function registerConsolePanes");
  });

  it("carries the six reserved lines in task order", () => {
    expect(reservedLines(seatBoardSource)).toStrictEqual([...RESERVED_LINES]);
  });

  it("adds nothing to the body but registration calls", () => {
    // Composition only. A condition, a local, or a `try` here would turn six
    // one-line diffs back into six edits to one region — and would do it while
    // every behavioural case below still passed.
    for (const line of registrationLines(seatBoardSource)) {
      expect(line).toMatch(/^register[A-Za-z]+\(registry\);$/u);
    }
  });

  it("negative control: a body carrying a statement of its own is rejected", () => {
    // Without this, the case above would pass over an implementation of
    // `registrationLines` that returned nothing whatever the file said — and over
    // a regex that matched a prefix of a longer body.
    const withStatement = seatBoardSource.replace(
      "  // T-023p-1C-2 timeline\n",
      "  // T-023p-1C-2 timeline\n  if (registry === undefined) return;\n",
    );
    expect(withStatement).not.toBe(seatBoardSource);
    expect(registrationLines(withStatement)).toContain("if (registry === undefined) return;");
    expect(
      registrationLines(withStatement).every((line) =>
        /^register[A-Za-z]+\(registry\);$/u.test(line),
      ),
    ).toBe(false);
  });
});

describe("pane seat board — composing it today", () => {
  it("registers only kinds a reserved line names", () => {
    // The seat board is also a manifest: each line names the kinds that seat may
    // claim, so a family registering a kind outside its own line is a family that
    // took a seat it was not given — which the registry would happily accept,
    // because it is keyed by kind and not by seat.
    const declared = new Set(reservedLines(seatBoardSource).flatMap(kindsNamedBy));
    const registry = new ConsolePaneRegistry();
    registerConsolePanes(registry);
    for (const kind of registry.registeredPaneKinds()) {
      expect(declared.has(kind)).toBe(true);
    }
  });

  it("registers nothing for a seat whose call has not landed", () => {
    // The reserved line names the kinds its seat may claim, so an unfilled seat is
    // checkable without this file knowing which seats are unfilled today. This is
    // the "reserved, not stubbed" rule at the deck's own registry.
    const registry = new ConsolePaneRegistry();
    registerConsolePanes(registry);
    const registered = new Set<string>(registry.registeredPaneKinds());
    const body = seatBoardFunctionBody(seatBoardSource)
      .split("\n")
      .map((line) => line.trim());
    for (const [index, line] of body.entries()) {
      if (!line.startsWith("//")) {
        continue;
      }
      const next = body[index + 1];
      const isFilled = next !== undefined && !next.startsWith("//") && next !== "";
      if (isFilled) {
        continue;
      }
      for (const kind of kindsNamedBy(line)) {
        expect(registered.has(kind)).toBe(false);
      }
    }
  });

  it("survives being composed twice, as a hot reload does it", () => {
    const registry = new ConsolePaneRegistry();
    expect(() => {
      registerConsolePanes(registry);
      registerConsolePanes(registry);
    }).not.toThrow();
  });

  it("negative control: the registry itself does report a claimed kind", () => {
    // Every case above reads `registeredPaneKinds`, and all of them would pass
    // over an implementation that always answered `[]`.
    const registry = new ConsolePaneRegistry();
    expect(registry.registeredPaneKinds()).not.toContain("timeline");
    registry.register({
      kind: "timeline",
      owner: "panes-test",
      render: () => null,
      openInWindow: true,
    });
    expect(registry.registeredPaneKinds()).toContain("timeline");
  });
});
