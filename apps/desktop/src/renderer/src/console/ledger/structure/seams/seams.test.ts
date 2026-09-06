// Seams and superseded bands, held to the rules that fail silently.
//
// Every case here pins something whose violation still renders: a seam vocabulary
// half the daemon cannot produce still draws marks, a superseded band off by one
// still dims rows, and an epoch-blind band dims the wrong ones. None of it throws,
// so each clean assertion is paired with a negative control that fails when the
// rule is removed.

import { SESSION_EVENT_CATEGORY_BY_TYPE, type TimelineRow } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  generalRow,
  legacyStubRow,
  rollbackBoundaryRow,
  runRow,
} from "../timeline-rows.test-support.js";
import {
  LEDGER_SEAM_KINDS,
  LedgerSeamIndex,
  SEAM_WIRE_BINDINGS,
  SWITCH_CONTINUITY_MEMO,
  type LedgerSeam,
} from "./seams.js";
import { SupersededIndex, deriveSupersededBands } from "./superseded-bands.js";

function classifyOne(row: TimelineRow): LedgerSeam {
  const seam = new LedgerSeamIndex().classify(row);
  if (seam === undefined) {
    throw new Error(`expected ${row.type} to classify as a seam`);
  }
  return seam;
}

describe("seams — the binding table is closed and total", () => {
  it("carries one binding per kind, keyed by the kind it names", () => {
    expect(LEDGER_SEAM_KINDS).toHaveLength(8);
    for (const kind of LEDGER_SEAM_KINDS) {
      expect(SEAM_WIRE_BINDINGS[kind].kind).toBe(kind);
      expect(SEAM_WIRE_BINDINGS[kind].wireTypes.length).toBeGreaterThan(0);
      // The label the one-line row draws. Every kind has one, so the renderer never
      // falls back to the wire type as a heading for a reader.
      expect(SEAM_WIRE_BINDINGS[kind].label.length).toBeGreaterThan(0);
    }
  });

  it("spends its one caution on the failed switch and on nothing else", () => {
    // Rule 3 rations amber and red to attention and failure. A table that had
    // drifted into marking every epoch seam would still render — in amber.
    const cautions = LEDGER_SEAM_KINDS.filter((kind) => SEAM_WIRE_BINDINGS[kind].isCaution);
    expect(cautions).toStrictEqual(["provider-switch-failed"]);
  });

  it("negative control: the successful switch is not a caution", () => {
    expect(SEAM_WIRE_BINDINGS["provider-switch"].isCaution).toBe(false);
    expect(SEAM_WIRE_BINDINGS.compaction.isCaution).toBe(false);
    expect(SEAM_WIRE_BINDINGS.rollback.isCaution).toBe(false);
  });

  it("binds the block seam to the two registered waiting types and never to `run.blocked`", () => {
    // The design's own parenthetical. `run.blocked` is not a wire type, and a
    // binding that read for it would draw no block indicator at all.
    expect(SEAM_WIRE_BINDINGS["run-blocked"].wireTypes).toStrictEqual([
      "run.waiting_for_approval",
      "run.waiting_for_input",
    ]);
    expect(SEAM_WIRE_BINDINGS["run-blocked"].wireTypes).not.toContain("run.blocked");
  });
});

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

describe("superseded bands — the rewind floor is EXCEEDS and nothing else", () => {
  /** Three turns and a boundary that rewound to the second of them. */
  function rewoundWindow(): readonly TimelineRow[] {
    return [
      runRow({ id: "a1", sequence: 1, type: "run.running", runId: "run-a", position: 1 }),
      runRow({ id: "a2", sequence: 2, type: "run.running", runId: "run-a", position: 2 }),
      runRow({ id: "a3", sequence: 3, type: "run.running", runId: "run-a", position: 3 }),
      rollbackBoundaryRow({
        id: "rb",
        sequence: 4,
        runId: "run-a",
        position: 4,
        targetPosition: 2,
      }),
    ];
  }

  it("marks the row past the cutoff", () => {
    const index = new SupersededIndex(rewoundWindow());
    expect(index.isSuperseded("a3")).toBe(true);
  });

  it("negative control: the row AT the cutoff is the retained floor and survives", () => {
    // Off by one here dims the exact turn a person rewound to — which is the turn
    // they are looking at.
    const index = new SupersededIndex(rewoundWindow());
    expect(index.isSuperseded("a2")).toBe(false);
    expect(index.isSuperseded("a1")).toBe(false);
  });

  it("scopes marks to the epoch, because re-execution reuses ordinals", () => {
    const index = new SupersededIndex([
      ...rewoundWindow(),
      // Same run, same ordinal, second epoch: a fresh attempt at position 3.
      runRow({
        id: "a3-again",
        sequence: 5,
        type: "run.running",
        runId: "run-a",
        position: 3,
        epoch: 1,
      }),
    ]);
    expect(index.isSuperseded("a3")).toBe(true);
    expect(index.isSuperseded("a3-again")).toBe(false);
  });

  it("negative control: a boundary in one run never reaches another run's rows", () => {
    const index = new SupersededIndex([
      ...rewoundWindow(),
      runRow({ id: "b9", sequence: 6, type: "run.running", runId: "run-b", position: 9 }),
    ]);
    expect(index.isSuperseded("b9")).toBe(false);
  });

  it("never ranks a legacy stub or a session-scoped row", () => {
    // Structural, not filtered: neither arm carries a position at all.
    const index = new SupersededIndex([
      ...rewoundWindow(),
      legacyStubRow({ id: "stub", sequence: 7, type: "event.compacted", runId: "run-a" }),
      generalRow({ id: "g1", sequence: 8, type: "session.renamed", category: "session_lifecycle" }),
    ]);
    expect(index.isSuperseded("stub")).toBe(false);
    expect(index.isSuperseded("g1")).toBe(false);
  });

  it("marks a row that arrived already carrying its own cutoff, with no boundary in the window", () => {
    const index = new SupersededIndex([
      runRow({
        id: "pre",
        sequence: 1,
        type: "run.running",
        runId: "run-a",
        position: 3,
        supersededTargetPosition: 1,
      }),
    ]);
    expect(index.isSuperseded("pre")).toBe(true);
  });

  it("takes the LOWEST applicable cutoff when a row is reached by two", () => {
    // `SupersededMarker` is defined as the FIRST accepted rollback that rewound
    // the surviving history containing the row, so a later, higher cutoff never
    // displaces an earlier, lower one.
    const bands = deriveSupersededBands([
      runRow({
        id: "a5",
        sequence: 1,
        type: "run.running",
        runId: "run-a",
        position: 5,
        supersededTargetPosition: 4,
      }),
      rollbackBoundaryRow({
        id: "rb",
        sequence: 2,
        runId: "run-a",
        position: 6,
        targetPosition: 2,
      }),
    ]);
    const bandForRow = bands.find((band) => band.rowIds.includes("a5"));
    expect(bandForRow?.targetPosition).toBe(2);
  });

  it("is idempotent over one window, because it derives a set and accumulates nothing", () => {
    const rows = rewoundWindow();
    const first = deriveSupersededBands(rows).flatMap((band) => band.rowIds);
    const second = deriveSupersededBands(rows).flatMap((band) => band.rowIds);
    expect(second).toStrictEqual(first);
  });

  it("computes its bands once and answers from them", () => {
    const index = new SupersededIndex(rewoundWindow());
    expect(index.bands()).toBe(index.bands());
  });
});
