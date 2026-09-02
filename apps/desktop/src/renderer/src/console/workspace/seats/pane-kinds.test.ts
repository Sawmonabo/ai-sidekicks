// The pane-kind set is the spec's set, in the spec's order.
//
// `Spec-023 §Console Design (Meridian)` fixes both. The bullet, verbatim:
//
//   "**Pane kinds, a closed set:** `timeline` (session- or channel-scoped),
//   `inspector`, `runs`, `approvals`, `diff`, `artifact`, `workflow-run`,
//   `workflow-builder`, `browser`, `terminal`, `agent-console`."
//
// The transcription below is compared to `PANE_KINDS` by `toStrictEqual`, which
// is an ORDERED comparison — a reorder fails here, and a reorder is not cosmetic:
// `registeredPaneKinds()` answers in declaration order and the gallery renders in
// it. Reading the spec file itself would be the stronger check and is not
// available: `node:fs` is banned in renderer programs (`Spec-023 §Trust Stance`),
// and the governance corpus sits outside this package's Vite root, so the honest
// arrangement is a transcription that a reviewer can diff against the quote above.

import { describe, expect, it } from "vitest";

import { PANE_KINDS, isPaneKind, type PaneKind } from "./pane-kinds.js";

/** The eleven kinds of the spec bullet quoted above, in its own order. */
const SPEC_PANE_KINDS: readonly string[] = [
  "timeline",
  "inspector",
  "runs",
  "approvals",
  "diff",
  "artifact",
  "workflow-run",
  "workflow-builder",
  "browser",
  "terminal",
  "agent-console",
];

describe("pane kinds — the closed set Spec-023 fixes", () => {
  it("carries the spec's members in the spec's order", () => {
    expect([...PANE_KINDS]).toStrictEqual([...SPEC_PANE_KINDS]);
  });

  it("declares each kind exactly once", () => {
    // `toStrictEqual` above would pass over a set that repeated a member if the
    // transcription repeated it too, and a repeat is what a merge of two
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
      "Timeline",
      "workflow_run",
      "agentconsole",
      "pane",
      "",
      " timeline",
      null,
      undefined,
      11,
      ["timeline"],
      { kind: "timeline" },
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
    const fromSnapshot: unknown = "artifact";
    expect(isPaneKind(fromSnapshot)).toBe(true);
    if (!isPaneKind(fromSnapshot)) {
      throw new Error("guard admitted a declared kind and then refused to narrow it");
    }
    const narrowed: PaneKind = fromSnapshot;
    expect(narrowed).toBe("artifact");
  });
});
