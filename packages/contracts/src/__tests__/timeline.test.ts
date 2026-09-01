// Plan-013 Phase 1 (T1.1–T1.4) — timeline contract coverage.
//
// THE FAILURE MATRIX IS THE SPEC OF THIS FILE. `Plan-013 §Test And
// Verification Plan`'s superseded-rendering bullet enumerates the parse
// outcomes Phase 1 must encode, and every row below names the class, the
// required outcome, and the `describe` block that asserts it. A schema change
// that loosens one of these is a matrix row that stops failing.
//
//   MUST FAIL — arm selection and attribution (§"arm selection")
//     F1   run arm, epoch missing .................... run arm fails, NO fallthrough
//     F2   run arm, position missing ................. run arm fails, NO fallthrough
//     F3   run arm, runId missing .................... run arm fails, NO fallthrough
//     F4   run arm, whole triple missing ............. run arm fails, NO fallthrough
//     F5   general arm carrying the triple ........... strict refuses
//     F6   general arm carrying `superseded` ......... strict refuses
//     F7   legacy_stub carrying `position` ........... strict refuses
//     F8   legacy_stub carrying `epoch` .............. strict refuses
//     F9   legacy_stub carrying `superseded` ......... strict refuses
//     F10  legacy_stub missing `runId` ............... refuses
//     F11  boundary runId != payload.runId ........... refinement refuses
//     F12  boundary sessionId != payload.sessionId ... refinement refuses
//     F13  boundary position != payload.targetPosition refinement refuses
//     F14  boundary `type` not `run.rolled_back` ..... refuses
//     F15  boundary payload not a RunRolledBackEvent . refuses (typed at projection)
//     F16  unknown `kind` value ...................... discriminatedUnion refuses
//     F17  `kind` absent ............................. refuses
//     F18  `superseded` carrying runId / epoch ....... strict refuses (single-field)
//     F19  `superseded` without targetPosition ....... refuses
//     F20  run arm with an unknown extra key ......... strict refuses
//     F21  negative position / negative epoch ........ refuses
//     F22  fractional position ....................... refuses
//
//   MUST FAIL — reasoning-surface availability (§"availability")
//     F23  `available` without reasoningEntries ...... refuses
//     F24  `policy_redacted` without policyReason .... refuses
//     F25  `unavailable` carrying reasoningEntries ... strict refuses
//     F26  `unavailable` carrying policyReason ....... strict refuses
//     F27  `compacted` carrying reasoningEntries ..... strict refuses
//     F28  `compacted` carrying policyReason ......... strict refuses
//     F29  `available` carrying policyReason ......... strict refuses
//     F30  legacy `{ available: true, … }` ........... refuses (no tolerant arm)
//     F31  legacy `{ available: false }` ............. refuses (no tolerant arm)
//     F32  unknown availability value ................ refuses
//     F33  reasoningEntries above the bound .......... refuses
//
//   MUST FAIL — summary and request shapes (§"child-run summary", §"read window")
//     F34  ChildRunSummary missing eventCount ........ refuses
//     F35  ChildRunSummary unknown `state` ........... refuses
//     F36  ChildRunSummary extra key ................. strict refuses
//     F37  read `limit` above the cap ................ refuses (bounded window)
//     F38  read `limit` of zero ...................... refuses
//
//   MUST FAIL — the incompleteness marker (§"completeness marker")
//     F39  `completeness` absent ..................... refuses (required member)
//     F40  incomplete arm without `cause` ............ refuses
//     F41  incomplete arm without `observedAt` ....... refuses
//     F42  cause outside the closed set .............. refuses
//     F43  `state` outside the two arms .............. selects no arm
//     F44  complete arm carrying `cause` ............. strict refuses
//     F45  complete arm carrying `observedAt` ........ strict refuses
//     F46  `observedAt` not an ISO-8601 instant ...... refuses
//     F47  incomplete arm with an unknown extra key .. strict refuses
//
//   MUST FAIL — the reasoning-surface request (§"read window")
//     F48  request carrying a principal member ....... strict refuses (no wire principal)
//
//   MUST PASS
//     P1   general row, minimal
//     P2   run row, full triple, unmarked (current)
//     P3   run row + `superseded { targetPosition }`
//     P4   new-epoch row reusing a superseded ordinal, unmarked
//     P5   attributed compacted stub on the run arm
//     P6   vacuous-era legacy stub: runId kept, position/epoch absent
//     P7   rollback boundary whose outer triple agrees with its payload
//     P8   a boundary row itself superseded by a later, lower cut
//     P9   position 0 / epoch 0
//     P10  childRunSummary carried on a general row and on a run row
//     P11  each of the four availability states round-trips
//     P12  ONE row schema parses a read-window row and a live-stream row
//     P13  the `complete` arm round-trips
//     P14  each of the three causes round-trips on the incomplete arm
//     P15  an incomplete row still parses — the marker never removes the row
//
// Refs: Spec-013, Plan-013 (I-013-1, I-013-3, I-013-4, I-013-5, I-013-7,
// I-013-8), ADR-018 (no legacy tolerant arm — the shape has no shipped parser
// before this one).

import { describe, expect, it } from "vitest";

import type { RunRolledBackEvent } from "../runControl.js";
import {
  CHILD_RUN_INCOMPLETE_CAUSES,
  ChildRunCompletenessSchema,
  ChildRunExpandRequestSchema,
  ChildRunExpandResponseSchema,
  ChildRunSummarySchema,
  REASONING_AVAILABILITY_STATES,
  REASONING_SURFACE_ENTRIES_MAX,
  ReasoningSurfaceReadRequestSchema,
  ReasoningSurfaceReadResponseSchema,
  TIMELINE_CHILD_RUN_EXPAND_METHOD,
  TIMELINE_METHOD_DESCRIPTORS,
  TIMELINE_METHOD_NAMES,
  TIMELINE_READ_LIMIT_MAX,
  TIMELINE_READ_METHOD,
  TIMELINE_REASONING_SURFACE_READ_METHOD,
  TIMELINE_ROLLBACK_BOUNDARY_TYPE,
  TIMELINE_ROW_KINDS,
  TIMELINE_SUBSCRIBE_METHOD,
  TimelineReadRequestSchema,
  TimelineReadResponseSchema,
  TimelineRowSchema,
  TimelineSubscribeRequestSchema,
  TimelineSubscribeResponseSchema,
  type TimelineRow,
} from "../timeline/index.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const SESSION_ID = "6f1c9a6e-1f2b-4a3c-8d5e-0a1b2c3d4e5f";
const OTHER_SESSION_ID = "7a2d0b7f-2e3c-4b4d-9e6f-1b2c3d4e5f60";
const RUN_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_RUN_ID = "22222222-3333-4444-8555-666666666666";
const PARENT_RUN_ID = "33333333-4444-4555-8666-777777777777";
const NODE_ID = "44444444-5555-4666-8777-888888888888";
const SUBSCRIPTION_ID = "55555555-6666-4777-8888-999999999999";
const TIMESTAMP = "2026-09-01T12:00:00.000Z";

/** The members every arm carries — spread into each fixture below. */
const rowCommon = {
  id: "evt-0001",
  sessionId: SESSION_ID,
  sequence: 42,
  category: "run_lifecycle",
  type: "run.started",
  summary: "Run started",
  timestamp: TIMESTAMP,
  payload: { detail: "opaque" },
} as const;

const generalRow = { ...rowCommon, kind: "general" } as const;

const runScopedRow = {
  ...rowCommon,
  kind: "run",
  runId: RUN_ID,
  position: 7,
  epoch: 0,
} as const;

const legacyStubRow = {
  ...rowCommon,
  kind: "legacy_stub",
  type: "event.compacted",
  summary: "Compacted range",
  runId: RUN_ID,
} as const;

/**
 * The rewind cutoff a boundary row carries. `targetPosition` 5 with the
 * boundary's own `position` 5 is the confirmed-rewind-floor rule the arm
 * refines on.
 */
const rolledBackPayload: RunRolledBackEvent = {
  sessionId: SESSION_ID as RunRolledBackEvent["sessionId"],
  runId: RUN_ID as RunRolledBackEvent["runId"],
  runVersion: 12,
  targetPosition: 5,
};

const rollbackBoundaryRow = {
  ...rowCommon,
  kind: "rollback_boundary",
  type: TIMELINE_ROLLBACK_BOUNDARY_TYPE,
  summary: "Run rewound to position 5",
  runId: RUN_ID,
  position: 5,
  epoch: 0,
  payload: rolledBackPayload,
} as const;

const childRunSummary = {
  runId: RUN_ID,
  parentRunId: PARENT_RUN_ID,
  state: "running",
  producingNodeId: NODE_ID,
  eventCount: 17,
  completeness: { state: "complete" },
} as const;

/** The incomplete arm, spelled out once so the cause axis can vary against it. */
const incompleteCompleteness = {
  state: "incomplete",
  cause: "detail_fetch_failed",
  observedAt: "2026-09-01T12:00:00Z",
} as const;

/** Assert a value parses AND that the parse output round-trips unchanged. */
const expectRoundTrip = (schema: { parse: (value: unknown) => unknown }, value: unknown): void => {
  expect(schema.parse(value)).toStrictEqual(value);
};

// ----------------------------------------------------------------------------
// TimelineRow — arm selection and attribution (T1.1, I-013-1, I-013-3, I-013-4)
// ----------------------------------------------------------------------------

describe("TimelineRow arm selection (I-013-1)", () => {
  it("P2/P9 — a run row carrying the full triple parses and narrows on `kind`", () => {
    const parsed: TimelineRow = TimelineRowSchema.parse(runScopedRow);
    expect(parsed.kind).toBe("run");
    // The narrowing guarantee, exercised at runtime as well as at the type
    // level (`timeline.test-d.ts`): after `kind`, the triple is reachable
    // without probing the free-form `type`.
    if (parsed.kind !== "run") {
      throw new Error("expected the run arm");
    }
    expect(parsed.runId).toBe(RUN_ID);
    expect(parsed.position).toBe(7);
    expect(parsed.epoch).toBe(0);
    expect(parsed.superseded).toBeUndefined();
    expectRoundTrip(TimelineRowSchema, { ...runScopedRow, position: 0, epoch: 0 });
  });

  it("P1 — a general row parses and carries no attribution", () => {
    const parsed = TimelineRowSchema.parse(generalRow);
    expect(parsed.kind).toBe("general");
    expect(parsed).toStrictEqual(generalRow);
  });

  it("P3 — the superseded marker is a single field and round-trips", () => {
    const marked = { ...runScopedRow, superseded: { targetPosition: 5 } };
    const parsed = TimelineRowSchema.parse(marked);
    expect(parsed).toStrictEqual(marked);
  });

  it("P4 — a re-executed ordinal in a later epoch parses unmarked (I-013-4)", () => {
    // The two-rollback sequence Plan-004 T3.14 pins: epoch 0's turn 6 stays
    // superseded while epoch 1's re-executed turn 6 renders current. Both are
    // representable at once precisely because `epoch` is its own member.
    const supersededEpochZero = {
      ...runScopedRow,
      position: 6,
      epoch: 0,
      superseded: { targetPosition: 5 },
    };
    const currentEpochOne = { ...runScopedRow, id: "evt-0002", position: 6, epoch: 1 };
    expectRoundTrip(TimelineRowSchema, supersededEpochZero);
    const reExecuted = TimelineRowSchema.parse(currentEpochOne);
    expect(reExecuted).toStrictEqual(currentEpochOne);
    if (reExecuted.kind !== "run") {
      throw new Error("expected the run arm");
    }
    expect(reExecuted.superseded).toBeUndefined();
  });

  it("P5 — an ATTRIBUTED compacted stub populates the run arm from its preserved keys", () => {
    const attributedStub = {
      ...runScopedRow,
      type: "event.compacted",
      summary: "Compacted range",
      superseded: { targetPosition: 5 },
    };
    expectRoundTrip(TimelineRowSchema, attributedStub);
  });

  it("P6 — a vacuous-era stub takes `legacy_stub` with position/epoch absent", () => {
    const parsed = TimelineRowSchema.parse(legacyStubRow);
    expect(parsed.kind).toBe("legacy_stub");
    expect(parsed).toStrictEqual(legacyStubRow);
    expect("position" in parsed).toBe(false);
    expect("epoch" in parsed).toBe(false);
  });

  it("P10 — `childRunSummary` rides a general row and a run row alike", () => {
    expectRoundTrip(TimelineRowSchema, { ...generalRow, childRunSummary });
    expectRoundTrip(TimelineRowSchema, { ...runScopedRow, childRunSummary });
  });

  // F1–F4. The load-bearing half of each assertion is the SECOND one: the row
  // must fail its `kind`-selected arm and must not be re-offered to the
  // general or legacy_stub arm, which is what would silently strip the
  // attribution a rollback rule keys on.
  const partialAttributionRows = [
    ["F1 — epoch missing", { ...runScopedRow, epoch: undefined }],
    ["F2 — position missing", { ...runScopedRow, position: undefined }],
    ["F3 — runId missing", { ...runScopedRow, runId: undefined }],
    [
      "F4 — whole triple missing",
      { ...runScopedRow, runId: undefined, position: undefined, epoch: undefined },
    ],
  ] as const;

  it.each(partialAttributionRows)(
    "%s — a partial run row fails its own arm and never falls through",
    (_label, malformed) => {
      const withoutUndefinedKeys = Object.fromEntries(
        Object.entries(malformed).filter(([, value]) => value !== undefined),
      );
      const result = TimelineRowSchema.safeParse(withoutUndefinedKeys);
      expect(result.success).toBe(false);
      if (result.success) {
        return;
      }
      // The load-bearing half. Every reported issue must be the RUN arm's own
      // missing-member complaint, at the path of an attribution member. Two
      // shapes are what a fallthrough would look like and neither may appear:
      //   * `invalid_union` at `kind` — no arm accepted the row at all, which
      //     would mean `kind` stopped selecting the arm.
      //   * `unrecognized_keys` — the row reached the general or legacy_stub
      //     arm, where the surviving attribution members are unknown keys.
      const attributionMembers = new Set(["runId", "position", "epoch"]);
      expect(result.error.issues.length).toBeGreaterThan(0);
      for (const issue of result.error.issues) {
        expect(issue.code).toBe("invalid_type");
        expect(attributionMembers.has(String(issue.path[0]))).toBe(true);
      }
    },
  );

  it("F1–F4 negative control — the checker distinguishes a fallthrough from a strict arm", () => {
    // Without this, the loop above could be passing because the FIXTURE is
    // malformed rather than because the arm is strict. Two controls: the
    // complete triple parses, and a row that genuinely lands on the general
    // arm with smuggled attribution produces the `unrecognized_keys` shape the
    // loop forbids — so the loop's discriminator is real.
    expect(TimelineRowSchema.safeParse(runScopedRow).success).toBe(true);
    const fellThrough = TimelineRowSchema.safeParse({ ...generalRow, runId: RUN_ID });
    expect(fellThrough.success).toBe(false);
    if (!fellThrough.success) {
      expect(fellThrough.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(
        true,
      );
    }
  });

  it("F5 — the general arm refuses smuggled run attribution", () => {
    expect(
      TimelineRowSchema.safeParse({ ...generalRow, runId: RUN_ID, position: 7, epoch: 0 }).success,
    ).toBe(false);
    expect(TimelineRowSchema.safeParse({ ...generalRow, runId: RUN_ID }).success).toBe(false);
  });

  it("F6 — the general arm refuses a superseded marker", () => {
    expect(
      TimelineRowSchema.safeParse({ ...generalRow, superseded: { targetPosition: 5 } }).success,
    ).toBe(false);
  });

  it("F7/F8 — a legacy stub refuses position or epoch (unknowable, not omitted)", () => {
    expect(TimelineRowSchema.safeParse({ ...legacyStubRow, position: 7 }).success).toBe(false);
    expect(TimelineRowSchema.safeParse({ ...legacyStubRow, epoch: 0 }).success).toBe(false);
  });

  it("F9 — a legacy stub refuses a superseded marker (exempt by construction)", () => {
    expect(
      TimelineRowSchema.safeParse({ ...legacyStubRow, superseded: { targetPosition: 5 } }).success,
    ).toBe(false);
  });

  it("F10 — a legacy stub without `runId` is refused (every run-scoped stub preserves it)", () => {
    const { runId: _dropped, ...withoutRunId } = legacyStubRow;
    expect(TimelineRowSchema.safeParse(withoutRunId).success).toBe(false);
  });

  it("F16/F17 — an unknown or absent `kind` is refused", () => {
    expect(TimelineRowSchema.safeParse({ ...rowCommon, kind: "child_run" }).success).toBe(false);
    expect(TimelineRowSchema.safeParse({ ...rowCommon }).success).toBe(false);
  });

  it("F18/F19 — the superseded marker is single-field and requires its one field", () => {
    expect(
      TimelineRowSchema.safeParse({
        ...runScopedRow,
        superseded: { targetPosition: 5, runId: RUN_ID },
      }).success,
    ).toBe(false);
    expect(
      TimelineRowSchema.safeParse({
        ...runScopedRow,
        superseded: { targetPosition: 5, epoch: 0 },
      }).success,
    ).toBe(false);
    expect(TimelineRowSchema.safeParse({ ...runScopedRow, superseded: {} }).success).toBe(false);
  });

  it("F20 — an unknown extra key is refused on every arm", () => {
    expect(TimelineRowSchema.safeParse({ ...runScopedRow, extra: 1 }).success).toBe(false);
    expect(TimelineRowSchema.safeParse({ ...generalRow, extra: 1 }).success).toBe(false);
    expect(TimelineRowSchema.safeParse({ ...legacyStubRow, extra: 1 }).success).toBe(false);
    expect(TimelineRowSchema.safeParse({ ...rollbackBoundaryRow, extra: 1 }).success).toBe(false);
  });

  it("F21/F22 — position and epoch are non-negative integers", () => {
    expect(TimelineRowSchema.safeParse({ ...runScopedRow, position: -1 }).success).toBe(false);
    expect(TimelineRowSchema.safeParse({ ...runScopedRow, epoch: -1 }).success).toBe(false);
    expect(TimelineRowSchema.safeParse({ ...runScopedRow, position: 1.5 }).success).toBe(false);
    expect(
      TimelineRowSchema.safeParse({
        ...runScopedRow,
        superseded: { targetPosition: -1 },
      }).success,
    ).toBe(false);
  });

  it("the exported `kind` census names exactly the union's arms", () => {
    expect([...TIMELINE_ROW_KINDS]).toStrictEqual([
      "rollback_boundary",
      "run",
      "legacy_stub",
      "general",
    ]);
    // A `kind` that selects no arm reports `invalid_union` AT `kind` (probed
    // against zod 4.3.6). Every census member must select an arm; the negative
    // control below proves the discriminator fires on one that does not, so a
    // census member silently dropped from the union would fail here.
    const selectsNoArm = (kind: string): boolean => {
      const result = TimelineRowSchema.safeParse({ ...rowCommon, kind });
      return (
        !result.success &&
        result.error.issues.some(
          (issue) => issue.code === "invalid_union" && issue.path.join(".") === "kind",
        )
      );
    };
    for (const kind of TIMELINE_ROW_KINDS) {
      expect(selectsNoArm(kind)).toBe(false);
    }
    expect(selectsNoArm("child_run")).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// TimelineRollbackBoundary — the typed cutoff (T1.1, I-013-5)
// ----------------------------------------------------------------------------

describe("TimelineRollbackBoundary (I-013-5)", () => {
  it("P7 — an agreeing boundary parses with a TYPED payload, no cast", () => {
    const parsed = TimelineRowSchema.parse(rollbackBoundaryRow);
    expect(parsed.kind).toBe("rollback_boundary");
    if (parsed.kind !== "rollback_boundary") {
      throw new Error("expected the rollback_boundary arm");
    }
    // The whole point of the arm: `targetPosition` is reachable as a number
    // through the narrowed payload rather than out of `Record<string, unknown>`.
    const cutoff: number = parsed.payload.targetPosition;
    expect(cutoff).toBe(5);
    expect(parsed.payload.runVersion).toBe(12);
  });

  it("P8 — a boundary row can itself be superseded by a later, lower cut", () => {
    expectRoundTrip(TimelineRowSchema, {
      ...rollbackBoundaryRow,
      superseded: { targetPosition: 3 },
    });
  });

  it("F11 — outer `runId` disagreeing with `payload.runId` fails parse", () => {
    const result = TimelineRowSchema.safeParse({ ...rollbackBoundaryRow, runId: OTHER_RUN_ID });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "runId")).toBe(true);
    }
  });

  it("F12 — outer `sessionId` disagreeing with `payload.sessionId` fails parse", () => {
    const result = TimelineRowSchema.safeParse({
      ...rollbackBoundaryRow,
      sessionId: OTHER_SESSION_ID,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "sessionId")).toBe(true);
    }
  });

  it("F13 — outer `position` disagreeing with `payload.targetPosition` fails parse", () => {
    const result = TimelineRowSchema.safeParse({ ...rollbackBoundaryRow, position: 9 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "position")).toBe(true);
    }
  });

  it("F11–F13 negative control — the agreeing row parses", () => {
    expect(TimelineRowSchema.safeParse(rollbackBoundaryRow).success).toBe(true);
  });

  it("F14 — the boundary arm pins `type` to the rollback event type", () => {
    expect(
      TimelineRowSchema.safeParse({ ...rollbackBoundaryRow, type: "run.completed" }).success,
    ).toBe(false);
  });

  it("F15 — a payload that is not a RunRolledBackEvent fails, and does not throw", () => {
    // Each shape below breaks the payload a different way; none may escape as a
    // TypeError out of the arm's cross-field refinement.
    const badPayloads: unknown[] = [
      { detail: "opaque" },
      { ...rolledBackPayload, runVersion: undefined },
      { ...rolledBackPayload, targetPosition: "5" },
      { ...rolledBackPayload, unexpected: true },
      null,
      "run.rolled_back",
    ];
    for (const payload of badPayloads) {
      const result = TimelineRowSchema.safeParse({ ...rollbackBoundaryRow, payload });
      expect(result.success).toBe(false);
    }
  });
});

// ----------------------------------------------------------------------------
// ChildRunSummary (T1.2)
// ----------------------------------------------------------------------------

describe("ChildRunSummary (T1.2)", () => {
  it("round-trips with and without the optional producing node", () => {
    expectRoundTrip(ChildRunSummarySchema, childRunSummary);
    const { producingNodeId: _omitted, ...withoutNode } = childRunSummary;
    expectRoundTrip(ChildRunSummarySchema, withoutNode);
  });

  it("F34 — `eventCount` is required", () => {
    const { eventCount: _dropped, ...withoutCount } = childRunSummary;
    expect(ChildRunSummarySchema.safeParse(withoutCount).success).toBe(false);
  });

  it("F35 — `state` is the shared RunState vocabulary, not a free string", () => {
    expect(ChildRunSummarySchema.safeParse({ ...childRunSummary, state: "spinning" }).success).toBe(
      false,
    );
    // Positive control on the same axis: a DIFFERENT valid member still parses,
    // so the rejection above is the vocabulary and not the fixture.
    expect(ChildRunSummarySchema.safeParse({ ...childRunSummary, state: "failed" }).success).toBe(
      true,
    );
  });

  it("F36 — the six-member set is closed", () => {
    // `completeness` is now a member (below), so this asserts the closure that
    // survives it: a producer spelling the marker its OWN way — the shape a
    // pre-marker producer would most plausibly reach for — is refused rather
    // than silently stripped and then missing from every consumer downstream.
    expect(ChildRunSummarySchema.safeParse({ ...childRunSummary, incomplete: true }).success).toBe(
      false,
    );
  });

  it("`eventCount` is a non-negative integer", () => {
    expect(ChildRunSummarySchema.safeParse({ ...childRunSummary, eventCount: -1 }).success).toBe(
      false,
    );
    expect(ChildRunSummarySchema.safeParse({ ...childRunSummary, eventCount: 0 }).success).toBe(
      true,
    );
  });
});

// ----------------------------------------------------------------------------
// The incompleteness marker (T1.2, I-013-10)
// ----------------------------------------------------------------------------

describe("ChildRunSummary completeness marker (I-013-10)", () => {
  const withCompleteness = (completeness: unknown): unknown => ({
    ...childRunSummary,
    completeness,
  });

  it("P13 — the complete arm round-trips and carries nothing else", () => {
    expectRoundTrip(ChildRunCompletenessSchema, { state: "complete" });
    expectRoundTrip(ChildRunSummarySchema, childRunSummary);
  });

  it("P14 — every cause in the closed set round-trips on the incomplete arm", () => {
    for (const cause of CHILD_RUN_INCOMPLETE_CAUSES) {
      expectRoundTrip(ChildRunCompletenessSchema, { ...incompleteCompleteness, cause });
      expectRoundTrip(
        ChildRunSummarySchema,
        withCompleteness({ ...incompleteCompleteness, cause }),
      );
    }
  });

  it("P15 — an incomplete row keeps its summary visible; the count is a lower bound", () => {
    // The point of the marker: the row still parses, so it still renders. A
    // failed detail fetch never removes the row, which is the whole rule.
    const parsed = ChildRunSummarySchema.parse(withCompleteness(incompleteCompleteness));
    expect(parsed).toStrictEqual(withCompleteness(incompleteCompleteness));
  });

  it("F39 — `completeness` is required; an absent marker is not a third state", () => {
    const { completeness: _dropped, ...withoutMarker } = childRunSummary;
    expect(ChildRunSummarySchema.safeParse(withoutMarker).success).toBe(false);
  });

  it("F40 — the incomplete arm requires `cause`", () => {
    const { cause: _dropped, ...withoutCause } = incompleteCompleteness;
    expect(ChildRunCompletenessSchema.safeParse(withoutCause).success).toBe(false);
    expect(ChildRunSummarySchema.safeParse(withCompleteness(withoutCause)).success).toBe(false);
  });

  it("F41 — the incomplete arm requires `observedAt`", () => {
    const { observedAt: _dropped, ...withoutTime } = incompleteCompleteness;
    expect(ChildRunCompletenessSchema.safeParse(withoutTime).success).toBe(false);
  });

  it("F42 — a cause outside the closed set is refused", () => {
    expect(
      ChildRunCompletenessSchema.safeParse({ ...incompleteCompleteness, cause: "node_offline" })
        .success,
    ).toBe(false);
    // Negative control: the rejection is the vocabulary, not the fixture.
    expect(
      ChildRunCompletenessSchema.safeParse({ ...incompleteCompleteness, cause: "compacted" })
        .success,
    ).toBe(true);
  });

  it("F43 — a `state` outside the two arms selects no arm", () => {
    const result = ChildRunCompletenessSchema.safeParse({ state: "partial" });
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    // Discriminator failure, not a member failure — the union rejected the row
    // before reading anything else, which is what keeps the arms independent.
    expect(result.error.issues.some((issue) => issue.path.join(".") === "state")).toBe(true);
  });

  it("F44/F45 — the complete arm refuses a cause or an observation time", () => {
    expect(
      ChildRunCompletenessSchema.safeParse({ state: "complete", cause: "compacted" }).success,
    ).toBe(false);
    expect(
      ChildRunCompletenessSchema.safeParse({
        state: "complete",
        observedAt: "2026-09-01T12:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("F46 — `observedAt` is an offset-bearing ISO-8601 instant, not a free string", () => {
    expect(
      ChildRunCompletenessSchema.safeParse({ ...incompleteCompleteness, observedAt: "yesterday" })
        .success,
    ).toBe(false);
    expect(
      ChildRunCompletenessSchema.safeParse({
        ...incompleteCompleteness,
        observedAt: "2026-09-01T12:00:00+02:00",
      }).success,
    ).toBe(true);
  });

  it("F47 — the incomplete arm is closed too", () => {
    expect(
      ChildRunCompletenessSchema.safeParse({ ...incompleteCompleteness, retryAfter: 30 }).success,
    ).toBe(false);
  });

  it("the exported cause census agrees with the schema's accepted set", () => {
    // Guards the one drift the type system cannot: the census const and the
    // `z.enum` list are two separate literal lists.
    const accepts = (cause: string): boolean =>
      ChildRunCompletenessSchema.safeParse({ ...incompleteCompleteness, cause }).success;
    for (const cause of CHILD_RUN_INCOMPLETE_CAUSES) {
      expect(accepts(cause)).toBe(true);
    }
    expect(CHILD_RUN_INCOMPLETE_CAUSES).toHaveLength(3);
    // Negative control, so the loop above cannot pass vacuously.
    expect(accepts("producer_unreachable")).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// ReasoningSurfaceRead (T1.3, I-013-7, I-013-8)
// ----------------------------------------------------------------------------

describe("ReasoningSurfaceReadResponse availability (I-013-7)", () => {
  const reasoningEntry = { sequence: 1, content: "normalized reasoning", timestamp: TIMESTAMP };

  it("P11 — each of the four states round-trips", () => {
    expectRoundTrip(ReasoningSurfaceReadResponseSchema, {
      availability: "available",
      reasoningEntries: [reasoningEntry],
    });
    expectRoundTrip(ReasoningSurfaceReadResponseSchema, { availability: "unavailable" });
    expectRoundTrip(ReasoningSurfaceReadResponseSchema, { availability: "compacted" });
    expectRoundTrip(ReasoningSurfaceReadResponseSchema, {
      availability: "policy_redacted",
      policyReason: "withheld by organization policy",
    });
  });

  it("`available` accepts an empty entry list — an empty surface is not an absent one", () => {
    expectRoundTrip(ReasoningSurfaceReadResponseSchema, {
      availability: "available",
      reasoningEntries: [],
    });
  });

  it("F23 — `available` without `reasoningEntries` fails", () => {
    expect(
      ReasoningSurfaceReadResponseSchema.safeParse({ availability: "available" }).success,
    ).toBe(false);
  });

  it("F24 — `policy_redacted` without `policyReason` fails", () => {
    expect(
      ReasoningSurfaceReadResponseSchema.safeParse({ availability: "policy_redacted" }).success,
    ).toBe(false);
  });

  it("F25–F28 — entries or a policy reason on `unavailable` / `compacted` fail strict parse", () => {
    for (const availability of ["unavailable", "compacted"] as const) {
      expect(
        ReasoningSurfaceReadResponseSchema.safeParse({
          availability,
          reasoningEntries: [reasoningEntry],
        }).success,
      ).toBe(false);
      expect(
        ReasoningSurfaceReadResponseSchema.safeParse({
          availability,
          policyReason: "withheld",
        }).success,
      ).toBe(false);
      // Negative control: the bare state parses, so the two rejections above
      // are the extra member and not the state.
      expect(ReasoningSurfaceReadResponseSchema.safeParse({ availability }).success).toBe(true);
    }
  });

  it("F29 — `available` carrying a policy reason fails strict parse", () => {
    expect(
      ReasoningSurfaceReadResponseSchema.safeParse({
        availability: "available",
        reasoningEntries: [reasoningEntry],
        policyReason: "withheld",
      }).success,
    ).toBe(false);
  });

  it("F30/F31 — the prior `available: boolean` shape fails; there is no tolerant arm", () => {
    expect(
      ReasoningSurfaceReadResponseSchema.safeParse({
        available: true,
        reasoningEntries: [reasoningEntry],
      }).success,
    ).toBe(false);
    expect(ReasoningSurfaceReadResponseSchema.safeParse({ available: false }).success).toBe(false);
    expect(
      ReasoningSurfaceReadResponseSchema.safeParse({
        available: false,
        policyReason: "withheld",
      }).success,
    ).toBe(false);
  });

  it("F32 — an unknown availability value fails", () => {
    expect(ReasoningSurfaceReadResponseSchema.safeParse({ availability: "redacted" }).success).toBe(
      false,
    );
  });

  it("F33 — `reasoningEntries` is bounded", () => {
    const atCap = Array.from({ length: REASONING_SURFACE_ENTRIES_MAX }, (_unused, index) => ({
      ...reasoningEntry,
      sequence: index,
    }));
    expect(
      ReasoningSurfaceReadResponseSchema.safeParse({
        availability: "available",
        reasoningEntries: atCap,
      }).success,
    ).toBe(true);
    expect(
      ReasoningSurfaceReadResponseSchema.safeParse({
        availability: "available",
        reasoningEntries: [...atCap, reasoningEntry],
      }).success,
    ).toBe(false);
  });

  it("no two states serialize identically — the census is the four arms", () => {
    expect([...REASONING_AVAILABILITY_STATES]).toStrictEqual([
      "available",
      "unavailable",
      "compacted",
      "policy_redacted",
    ]);
  });

  it("F48 — the request is run-scoped and carries no principal, in any spelling", () => {
    expectRoundTrip(ReasoningSurfaceReadRequestSchema, { runId: RUN_ID });
    // The principal is resolved from the transport, never supplied by the
    // caller. `.strict()` is what makes that a refusal rather than a silent
    // strip — a stripped member would let a caller believe it had scoped the
    // read to someone, which is exactly the second source of identity truth
    // the authenticated-principal model forbids. Every plausible spelling is
    // covered, because the failure mode is a producer guessing a name.
    for (const member of [
      "principalId",
      "principal",
      "actor",
      "participantId",
      "sub",
      "callerId",
    ]) {
      expect(
        ReasoningSurfaceReadRequestSchema.safeParse({ runId: RUN_ID, [member]: "p-1" }).success,
      ).toBe(false);
    }
  });
});

// ----------------------------------------------------------------------------
// TimelineRead / TimelineSubscribe / ChildRunExpand (T1.3, T1.4)
// ----------------------------------------------------------------------------

describe("timeline read window and live stream", () => {
  const cursor = "seq-42";

  it("a read window round-trips, with `hasMore` separate from `nextCursor`", () => {
    expectRoundTrip(TimelineReadRequestSchema, { sessionId: SESSION_ID });
    expectRoundTrip(TimelineReadRequestSchema, {
      sessionId: SESSION_ID,
      afterCursor: cursor,
      beforeCursor: cursor,
      limit: TIMELINE_READ_LIMIT_MAX,
      channelId: NODE_ID,
    });
    expectRoundTrip(TimelineReadResponseSchema, {
      entries: [generalRow, runScopedRow, legacyStubRow, rollbackBoundaryRow],
      nextCursor: cursor,
      hasMore: true,
    });
    expectRoundTrip(TimelineReadResponseSchema, { entries: [], hasMore: false });
  });

  it("F37/F38 — `limit` is a bounded window", () => {
    expect(
      TimelineReadRequestSchema.safeParse({
        sessionId: SESSION_ID,
        limit: TIMELINE_READ_LIMIT_MAX + 1,
      }).success,
    ).toBe(false);
    expect(TimelineReadRequestSchema.safeParse({ sessionId: SESSION_ID, limit: 0 }).success).toBe(
      false,
    );
    expect(TimelineReadRequestSchema.safeParse({ sessionId: SESSION_ID, limit: 1.5 }).success).toBe(
      false,
    );
  });

  it("the subscribe request declares no second resumption channel", () => {
    expectRoundTrip(TimelineSubscribeRequestSchema, { sessionId: SESSION_ID, afterCursor: cursor });
    // `lastEventId` is tRPC's header injection; the timeline rides daemon
    // JSON-RPC only, so the member would be a second way to say `afterCursor`.
    expect(
      TimelineSubscribeRequestSchema.safeParse({ sessionId: SESSION_ID, lastEventId: cursor })
        .success,
    ).toBe(false);
    expectRoundTrip(TimelineSubscribeResponseSchema, { subscriptionId: SUBSCRIPTION_ID });
  });

  it("P12 — ONE row schema parses a read-window row and a live-stream row", () => {
    // The reconnect-recovery guarantee: a replay row and a live row are
    // indistinguishable to a parser because there is exactly one parser. The
    // assertion is on schema IDENTITY, not on two structurally-equal parses.
    expect(TIMELINE_METHOD_DESCRIPTORS[TIMELINE_SUBSCRIBE_METHOD].emissionSchema).toBe(
      TimelineRowSchema,
    );
    const window = TimelineReadResponseSchema.parse({
      entries: [rollbackBoundaryRow],
      hasMore: false,
    });
    const live = TimelineRowSchema.parse(rollbackBoundaryRow);
    expect(window.entries[0]).toStrictEqual(live);
  });

  it("child-run expansion carries the same row union", () => {
    expectRoundTrip(ChildRunExpandRequestSchema, { runId: RUN_ID });
    expectRoundTrip(ChildRunExpandResponseSchema, {
      runId: RUN_ID,
      parentRunId: PARENT_RUN_ID,
      state: "completed",
      entries: [runScopedRow],
    });
    expect(
      ChildRunExpandResponseSchema.safeParse({
        runId: RUN_ID,
        parentRunId: PARENT_RUN_ID,
        state: "completed",
        entries: [{ ...runScopedRow, epoch: undefined }],
      }).success,
    ).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// Method-name registry (T1.4)
// ----------------------------------------------------------------------------

describe("timeline method-name registry (T1.4)", () => {
  it("registers exactly the four canonical method strings", () => {
    expect([...TIMELINE_METHOD_NAMES]).toStrictEqual([
      "timeline.read",
      "timeline.subscribe",
      "timeline.reasoningSurfaceRead",
      "timeline.childRunExpand",
    ]);
    expect(Object.keys(TIMELINE_METHOD_DESCRIPTORS).sort()).toStrictEqual(
      [...TIMELINE_METHOD_NAMES].sort(),
    );
  });

  it("every method string is BOUND to its own schema pair, not merely declared", () => {
    expect(TIMELINE_METHOD_DESCRIPTORS[TIMELINE_READ_METHOD].requestSchema).toBe(
      TimelineReadRequestSchema,
    );
    expect(TIMELINE_METHOD_DESCRIPTORS[TIMELINE_READ_METHOD].responseSchema).toBe(
      TimelineReadResponseSchema,
    );
    expect(TIMELINE_METHOD_DESCRIPTORS[TIMELINE_SUBSCRIBE_METHOD].requestSchema).toBe(
      TimelineSubscribeRequestSchema,
    );
    expect(TIMELINE_METHOD_DESCRIPTORS[TIMELINE_SUBSCRIBE_METHOD].responseSchema).toBe(
      TimelineSubscribeResponseSchema,
    );
    expect(TIMELINE_METHOD_DESCRIPTORS[TIMELINE_REASONING_SURFACE_READ_METHOD].requestSchema).toBe(
      ReasoningSurfaceReadRequestSchema,
    );
    expect(TIMELINE_METHOD_DESCRIPTORS[TIMELINE_REASONING_SURFACE_READ_METHOD].responseSchema).toBe(
      ReasoningSurfaceReadResponseSchema,
    );
    expect(TIMELINE_METHOD_DESCRIPTORS[TIMELINE_CHILD_RUN_EXPAND_METHOD].requestSchema).toBe(
      ChildRunExpandRequestSchema,
    );
    expect(TIMELINE_METHOD_DESCRIPTORS[TIMELINE_CHILD_RUN_EXPAND_METHOD].responseSchema).toBe(
      ChildRunExpandResponseSchema,
    );
  });

  it("mirrors the canonical registry's procedure types and read-only posture", () => {
    expect(TIMELINE_METHOD_DESCRIPTORS[TIMELINE_READ_METHOD].procedureType).toBe("query");
    expect(TIMELINE_METHOD_DESCRIPTORS[TIMELINE_SUBSCRIBE_METHOD].procedureType).toBe(
      "subscription",
    );
    expect(TIMELINE_METHOD_DESCRIPTORS[TIMELINE_REASONING_SURFACE_READ_METHOD].procedureType).toBe(
      "query",
    );
    expect(TIMELINE_METHOD_DESCRIPTORS[TIMELINE_CHILD_RUN_EXPAND_METHOD].procedureType).toBe(
      "query",
    );
    for (const method of TIMELINE_METHOD_NAMES) {
      expect(TIMELINE_METHOD_DESCRIPTORS[method].mutating).toBe(false);
      expect(TIMELINE_METHOD_DESCRIPTORS[method].method).toBe(method);
    }
  });

  it("the descriptor registry is frozen — a consumer cannot re-point a method's schemas", () => {
    expect(Object.isFrozen(TIMELINE_METHOD_DESCRIPTORS)).toBe(true);
    for (const method of TIMELINE_METHOD_NAMES) {
      expect(Object.isFrozen(TIMELINE_METHOD_DESCRIPTORS[method])).toBe(true);
    }
  });
});
