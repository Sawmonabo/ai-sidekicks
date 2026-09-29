// The pane-kind set is closed, and its order is the one `registeredPaneKinds()` answers in:
// `transcript`, `inspector`, `diff`, `workflow-run`, `workflow-builder`, `browser`,
// `terminal` and `agents`.
//
// The list below is compared to `PANE_KINDS` by `toStrictEqual`, which is an ORDERED
// comparison — a reorder fails here, and a reorder is not cosmetic:
// `registeredPaneKinds()` answers in declaration order and the gallery renders in it.
// Adding or dropping a kind is a change to both lists, made on purpose.

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
    // `toStrictEqual` above would pass over a set that repeated a member if the
    // list repeated it too, and a repeat is what a merge of two
    // concurrent additions produces.
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
    // Without this the case above would pass over an `isPaneKind` that answered
    // `true` for every string — which is exactly the shape a `typeof value ===
    // "string"` check degenerates into if the membership test is dropped.
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
    // The guard's whole job is the narrowing; a predicate typed `boolean` would
    // pass every case above and still leave a layout reader casting. Reading the
    // narrowed value into a `PaneKind` is the assertion, and it is a compile-time
    // one that this line makes runnable.
    const fromSnapshot: unknown = "terminal";
    expect(isPaneKind(fromSnapshot)).toBe(true);
    if (!isPaneKind(fromSnapshot)) {
      throw new Error("guard admitted a declared kind and then refused to narrow it");
    }
    const narrowed: PaneKind = fromSnapshot;
    expect(narrowed).toBe("terminal");
  });
});
