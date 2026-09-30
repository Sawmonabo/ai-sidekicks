// The declared list is compared to `PANE_KINDS` in order: `registeredPaneKinds()` answers in
// declaration order, so a reorder is a real change, and adding or dropping a kind edits both.

import { describe, expect, it } from "vitest";

import { PANE_KINDS, isPaneKind, type PaneKind } from "./pane-kinds.js";

/** The eight kinds, in their declared order. */
const DECLARED_PANE_KINDS: readonly string[] = [
  "transcript",
  "inspector",
  "diff",
  "workflow-run",
  "workflow-builder",
  "browser",
  "terminal",
  "agents",
];

describe("pane kinds — the closed set", () => {
  it("carries the declared members in the declared order", () => {
    expect([...PANE_KINDS]).toStrictEqual([...DECLARED_PANE_KINDS]);
  });

  it("declares each kind exactly once", () => {
    // The list comparison above passes if both lists repeat a member, as a merge of two
    // concurrent additions could produce.
    expect(new Set(PANE_KINDS).size).toBe(PANE_KINDS.length);
  });
});

describe("pane kinds — the guard layout restore drops against", () => {
  it("admits every declared kind", () => {
    for (const kind of PANE_KINDS) {
      expect(isPaneKind(kind)).toBe(true);
    }
  });

  it("negative control: refuses everything else, including near misses", () => {
    // Without it the case above passes for an `isPaneKind` that answers `true` for every
    // string, which is what remains if the membership test is dropped.
    const refused: readonly unknown[] = [
      "Transcript",
      "workflow_run",
      "agent",
      "pane",
      "",
      " transcript",
      null,
      undefined,
      11,
      ["transcript"],
      { kind: "transcript" },
    ];
    for (const value of refused) {
      expect(isPaneKind(value)).toBe(false);
    }
  });

  it("narrows to the union rather than merely answering a boolean", () => {
    // A predicate typed `boolean` would pass every case above and still leave a layout
    // reader casting; assigning the narrowed value to a `PaneKind` is the compile-time check.
    const fromSnapshot: unknown = "terminal";
    expect(isPaneKind(fromSnapshot)).toBe(true);
    if (!isPaneKind(fromSnapshot)) {
      throw new Error("guard admitted a declared kind and then refused to narrow it");
    }
    const narrowed: PaneKind = fromSnapshot;
    expect(narrowed).toBe("terminal");
  });
});
