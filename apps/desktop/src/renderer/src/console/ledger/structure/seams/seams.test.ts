// The epoch rule, held to the reads that fail silently.
//
// Every case here pins something whose violation still renders: a census answered
// from a hand-copied list still reports, and a boundary read off the wrong member
// still draws a seam at some position. None of it throws, so each clean assertion is
// paired with a negative control that fails when the rule is removed.
//
// TWO SIBLINGS DRIVE THE REST OF THIS DIRECTORY. `seam-vocabulary.test.ts` drives the
// closed table this classifies into, and `superseded-bands.test.ts` drives the other
// half of the design's rule — superseded turns stay present but visibly past.

import { SESSION_EVENT_CATEGORY_BY_TYPE, type TimelineRow } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  generalRow,
  legacyStubRow,
  rollbackBoundaryRow,
  runRow,
} from "../timeline-rows.test-support.js";
import { SWITCH_CONTINUITY_MEMO } from "./seam-vocabulary.js";
import { LedgerSeamIndex, type LedgerSeam } from "./seams.js";

function classifyOne(row: TimelineRow): LedgerSeam {
  const seam = new LedgerSeamIndex().classify(row);
  if (seam === undefined) {
    throw new Error(`expected ${row.type} to classify as a seam`);
  }
  return seam;
}

describe("seams — registration is asked of the contract, never hand-copied", () => {
  const index = new LedgerSeamIndex();

  it("reads the registered census from the contract's own map", () => {
    // Both halves matter: the census must answer yes for a type it carries and no
    // for one it does not, or the honesty report below is vacuous.
    expect(index.isRegisteredWireType("usage.context_compacted")).toBe(true);
    expect(SESSION_EVENT_CATEGORY_BY_TYPE.has("usage.context_compacted")).toBe(true);
    expect(index.isRegisteredWireType("agent.provider_switched")).toBe(false);
  });

  it("negative control: an invented type is not quietly admitted", () => {
    expect(index.isRegisteredWireType("run.definitely_not_a_wire_type")).toBe(false);
  });

  it("names exactly the four seam wire types the contract does not register", () => {
    expect(index.unregisteredWireTypes()).toStrictEqual([
      "agent.provider_switched",
      "agent.provider_switch_failed",
      "run.resumed",
      "run.unblocked",
    ]);
  });

  it("names only the kinds with no registered type at all", () => {
    // `run-blocked` is deliberately absent: both of its types are registered. A
    // report that listed it would tell an operator the block indicator is dead
    // when it is the one part of this vocabulary that works today.
    expect(index.unregisteredSeamKinds()).toStrictEqual([
      "provider-switch",
      "provider-switch-failed",
      "run-resumed",
      "run-unblocked",
    ]);
  });
});

describe("seams — one row's classification", () => {
  it("reads the rollback boundary's cutoff through the arm's own typed payload", () => {
    const seam = classifyOne(
      rollbackBoundaryRow({
        id: "rb",
        sequence: 9,
        runId: "run-a",
        position: 6,
        targetPosition: 2,
      }),
    );
    expect(seam.kind).toBe("rollback");
    expect(seam.boundaryPosition).toBe(2);
    expect(seam.wireRegistration).toBe("registered");
  });

  it("reads a compaction's boundary off the row's own run-scoped position", () => {
    // `usage.context_compacted` names no boundary member in any registered payload,
    // so the read that reached for one on the payload was permanently absent. The
    // registered carrier is the run arm's `position` — the same comparand a
    // rollback's cutoff is ranked against.
    const seam = classifyOne(
      runRow({
        id: "c1",
        sequence: 3,
        type: "usage.context_compacted",
        category: "usage_telemetry",
        runId: "run-a",
        position: 7,
      }),
    );
    expect(seam.kind).toBe("compaction");
    expect(seam.boundaryPosition).toBe(7);
  });

  it("negative control: a payload member of that name is not what is read", () => {
    // The reading the old code took. A row whose position and whose payload member
    // disagree is what discriminates the two: over the payload read this answered
    // 99, and over a boundary hard-coded to the position it would answer 3 either
    // way — so the position and the decoy are deliberately different numbers.
    const seam = classifyOne(
      runRow({
        id: "c1b",
        sequence: 3,
        type: "usage.context_compacted",
        category: "usage_telemetry",
        runId: "run-a",
        position: 3,
        payload: { boundaryPosition: 99 },
      }),
    );
    expect(seam.boundaryPosition).toBe(3);
  });

  it("negative control: a compacted stub carries no position, and renders an absence", () => {
    // The `legacy_stub` arm structurally has no position — it is the one shape a
    // compaction row can take without one — so this is the absence the row draws
    // rather than a zero.
    const seam = classifyOne(
      legacyStubRow({
        id: "c2",
        sequence: 4,
        type: "usage.context_compacted",
        category: "usage_telemetry",
        runId: "run-a",
      }),
    );
    expect(seam.kind).toBe("compaction");
    expect(seam.boundaryPosition).toBeUndefined();
  });

  it("carries a memo switch's declared losses verbatim", () => {
    const seam = classifyOne(
      runRow({
        id: "s1",
        sequence: 5,
        type: "agent.provider_switched",
        runId: "run-a",
        position: 5,
        payload: {
          continuity: SWITCH_CONTINUITY_MEMO,
          declaredLosses: ["turn_content_truncated", "a_kind_this_console_has_never_heard_of"],
        },
      }),
    );
    expect(seam.continuity).toBe("memo");
    // Verbatim, unknown member included: the vocabulary is widened by amendment,
    // so a renderer that mapped the unrecognized one onto a fallback phrase would
    // stop reporting the newest kind of loss.
    expect(seam.declaredLosses).toStrictEqual([
      "turn_content_truncated",
      "a_kind_this_console_has_never_heard_of",
    ]);
    expect(seam.wireRegistration).toBe("unregistered");
  });

  it("negative control: an in-place switch carries no loss clause even when the payload names one", () => {
    // The loss clause is rendered ONLY for `memo`. A classifier that read the
    // list unconditionally would put "context was lost" under a switch that lost
    // nothing.
    const seam = classifyOne(
      runRow({
        id: "s2",
        sequence: 6,
        type: "agent.provider_switched",
        runId: "run-a",
        position: 6,
        payload: { continuity: "in_place", declaredLosses: ["turn_content_truncated"] },
      }),
    );
    expect(seam.continuity).toBe("in_place");
    expect(seam.declaredLosses).toStrictEqual([]);
  });

  it("names which state a block is waiting on", () => {
    const seam = classifyOne(
      runRow({
        id: "b1",
        sequence: 7,
        type: "run.waiting_for_input",
        runId: "run-a",
        position: 7,
      }),
    );
    expect(seam.kind).toBe("run-blocked");
    expect(seam.blockedOn).toBe("run.waiting_for_input");
  });

  it("negative control: an ordinary row is not a seam", () => {
    const index = new LedgerSeamIndex();
    expect(
      index.classify(
        runRow({ id: "r1", sequence: 1, type: "run.running", runId: "run-a", position: 1 }),
      ),
    ).toBeUndefined();
    expect(
      index.classify(
        generalRow({
          id: "g1",
          sequence: 2,
          type: "session.renamed",
          category: "session_lifecycle",
        }),
      ),
    ).toBeUndefined();
  });

  it("collects a window's seams in log order", () => {
    const seams = new LedgerSeamIndex().seams([
      runRow({ id: "r1", sequence: 1, type: "run.running", runId: "run-a", position: 1 }),
      runRow({ id: "p1", sequence: 2, type: "run.paused", runId: "run-a", position: 2 }),
      rollbackBoundaryRow({
        id: "rb",
        sequence: 3,
        runId: "run-a",
        position: 3,
        targetPosition: 1,
      }),
    ]);
    expect(seams.map((seam) => seam.rowId)).toStrictEqual(["p1", "rb"]);
    expect(seams.map((seam) => seam.kind)).toStrictEqual(["run-paused", "rollback"]);
  });
});
