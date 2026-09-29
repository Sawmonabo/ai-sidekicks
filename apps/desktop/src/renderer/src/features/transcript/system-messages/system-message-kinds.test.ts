// The seam vocabulary, held to the two properties a drifted table still renders.
//
// A binding table that had lost a label still draws a row, and one that had spread
// its caution across every epoch seam still draws them — in amber. Neither throws,
// so each clean assertion here is paired with a negative control that fails when
// the rule is removed.
//
// THE CLASSIFIER IS NOT HERE. `system-message-classifier.test.ts` drives the epoch rule — which rows are
// seams and what one row's seam reads — on the same split the source takes.

import { describe, expect, it } from "vitest";

import { SYSTEM_MESSAGE_KINDS, SYSTEM_MESSAGE_BINDINGS } from "./system-message-kinds.js";

describe("seams — the binding table is closed and total", () => {
  it("carries one binding per kind, keyed by the kind it names", () => {
    expect(SYSTEM_MESSAGE_KINDS).toHaveLength(8);
    for (const kind of SYSTEM_MESSAGE_KINDS) {
      expect(SYSTEM_MESSAGE_BINDINGS[kind].kind).toBe(kind);
      expect(SYSTEM_MESSAGE_BINDINGS[kind].wireTypes.length).toBeGreaterThan(0);
      // The label the one-line row draws. Every kind has one, so the renderer never
      // falls back to the wire type as a heading for a reader.
      expect(SYSTEM_MESSAGE_BINDINGS[kind].label.length).toBeGreaterThan(0);
    }
  });

  it("spends its one caution on the failed switch and on nothing else", () => {
    // Rule 3 rations amber and red to attention and failure. A table that had
    // drifted into marking every epoch seam would still render — in amber.
    const cautions = SYSTEM_MESSAGE_KINDS.filter((kind) => SYSTEM_MESSAGE_BINDINGS[kind].isCaution);
    expect(cautions).toStrictEqual(["provider-switch-failed"]);
  });

  it("negative control: the successful switch is not a caution", () => {
    expect(SYSTEM_MESSAGE_BINDINGS["provider-switch"].isCaution).toBe(false);
    expect(SYSTEM_MESSAGE_BINDINGS.compaction.isCaution).toBe(false);
    expect(SYSTEM_MESSAGE_BINDINGS.rollback.isCaution).toBe(false);
  });

  it("binds the block seam to the two registered waiting types and never to `run.blocked`", () => {
    // The design's own parenthetical. `run.blocked` is not a wire type, and a
    // binding that read for it would draw no block indicator at all.
    expect(SYSTEM_MESSAGE_BINDINGS["run-blocked"].wireTypes).toStrictEqual([
      "run.waiting_for_approval",
      "run.waiting_for_input",
    ]);
    expect(SYSTEM_MESSAGE_BINDINGS["run-blocked"].wireTypes).not.toContain("run.blocked");
  });
});
