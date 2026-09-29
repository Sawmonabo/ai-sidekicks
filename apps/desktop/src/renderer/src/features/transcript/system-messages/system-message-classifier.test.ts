// The epoch rule, held to the reads that fail silently.
//
// Every case here pins something whose violation still renders: a registration
// answered from a hand-copied list still draws, and a boundary read off the wrong
// member still draws a seam at some position. None of it throws, so each clean assertion is
// paired with a negative control that fails when the rule is removed.
//
// TWO SIBLINGS DRIVE THE REST OF THIS DIRECTORY. `system-message-kinds.test.ts` drives the
// closed table this classifies into, and `superseded-bands.test.ts` drives the other
// half of the design's rule — superseded turns stay present but visibly past.

import {
  AGENT_PROVIDER_BINDING_CHANGED_EVENT,
  SESSION_EVENT_CATEGORY_BY_TYPE,
  type TimelineRow,
} from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { generalRow, rollbackBoundaryRow, runRow } from "../timeline-rows.test-support.js";
import { SystemMessageClassifier, type SystemMessageReading } from "./system-message-classifier.js";

function classifyOne(row: TimelineRow): SystemMessageReading {
  const seam = new SystemMessageClassifier().classify(row);
  if (seam === undefined) {
    throw new Error(`expected ${row.type} to classify as a seam`);
  }
  return seam;
}

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
    // Asked of the contract's census, which carries this type.
    expect(SESSION_EVENT_CATEGORY_BY_TYPE.has("usage.context_compacted")).toBe(true);
    expect(seam.wireRegistration).toBe("registered");
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

  it("carries a switch's declared losses verbatim", () => {
    const seam = classifyOne(
      runRow({
        id: "s1",
        sequence: 5,
        type: AGENT_PROVIDER_BINDING_CHANGED_EVENT,
        runId: "run-a",
        position: 5,
        payload: {
          continuity: "brief",
          declaredLosses: ["turn_content_truncated", "a_kind_this_console_has_never_heard_of"],
        },
      }),
    );
    expect(seam.continuity).toBe("brief");
    // Verbatim, unknown member included: the vocabulary is widened by amendment,
    // so a renderer that mapped the unrecognized one onto a fallback phrase would
    // stop reporting the newest kind of loss.
    expect(seam.declaredLosses).toStrictEqual([
      "turn_content_truncated",
      "a_kind_this_console_has_never_heard_of",
    ]);
    // The census does not register the switch settlement yet, and the seam says so.
    expect(seam.wireRegistration).toBe("unregistered");
  });

  it("negative control: an ordinary row is not a seam", () => {
    const index = new SystemMessageClassifier();
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
    const seams = new SystemMessageClassifier().seams([
      runRow({ id: "r1", sequence: 1, type: "run.running", runId: "run-a", position: 1 }),
      runRow({
        id: "c1",
        sequence: 2,
        type: "usage.context_compacted",
        category: "usage_telemetry",
        runId: "run-a",
        position: 2,
      }),
      rollbackBoundaryRow({
        id: "rb",
        sequence: 3,
        runId: "run-a",
        position: 3,
        targetPosition: 1,
      }),
    ]);
    expect(seams.map((seam) => seam.rowId)).toStrictEqual(["c1", "rb"]);
    expect(seams.map((seam) => seam.kind)).toStrictEqual(["compaction", "rollback"]);
  });
});
