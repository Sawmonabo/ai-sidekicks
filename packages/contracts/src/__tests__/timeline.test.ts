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
//   MUST FAIL — review folds (§"availability", §"arm selection", §"read window")
//     F49  `available` carrying zero entries ......... refuses (collapses onto unavailable)
//     F50  `hasMore: true` without `nextCursor` ...... arm selection refuses
//     F51  terminal window WITH a cursor ............. PARSES — see below
//     F52  response entry list above the cap ......... refuses (shared with the request cap)
//     F53  non-boundary arm carrying `run.rolled_back` refuses (untyped cutoff)
//     F54  marker at or below the row's position ..... refuses (cutoff is the retained floor)
//
//   MUST FAIL — frame safety, ordering, and lineage (§"category", §"lineage", §"paged")
//     F55  general arm carrying `run_lifecycle` ...... refuses (run event with no run identity)
//     F63  general arm carrying a run-scoped TYPE ..... refuses (category alone is not enough)
//     F63  general arm whose payload names a run ...... refuses (per-row, for optional-run types)
//     F64  run arm whose payload contradicts the row .. refuses (two attributions, one row)
//     F56  boundary arm carrying another category .... refuses (its event is registered one way)
//     F57  runId === parentRunId ..................... refuses (cyclic lineage), summary + expansion
//     F58  entries out of sequence order ............. refuses (oldest-to-newest)
//     F62  reasoning entries out of sequence order ... refuses (same rule, same surface)
//     F59  expansion entry from another run .......... refuses (general arm exempt)
//     F60  page over the frame byte budget ........... refuses — including a page AT the row cap
//     F61  paged `available` without its cursor ...... refuses; unpaged states carry no `hasMore`
//
//   REVERSED BY A REVIEW FOLD — each was asserted the other way when first shipped
//     F49  now REFUSES the empty `available` list (was: accepted)
//     F51  now ACCEPTS a cursor on the terminal arm (was: refused)
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
//     P16  a page built by `countEntriesFittingOneFrame` is accepted by the schema
//
// Refs: Spec-013, Plan-013 (I-013-1, I-013-3, I-013-4, I-013-5, I-013-7,
// I-013-8), ADR-018 (no legacy tolerant arm — the shape has no shipped parser
// before this one).

import { describe, expect, it } from "vitest";

import { EVENT_FIELD_MAX_LEN } from "../event.js";
import { EVENT_CURSOR_MAX_LEN } from "../session.js";
import { MAX_MESSAGE_BYTES, jsonUtf8ByteLength } from "../jsonrpc.js";
import type { RunRolledBackEvent } from "../runControl.js";
import {
  CHILD_RUN_INCOMPLETE_CAUSES,
  countEntriesFittingOneFrame,
  ChildRunCompletenessSchema,
  ChildRunExpandRequestSchema,
  ChildRunExpandResponseSchema,
  ChildRunSummarySchema,
  REASONING_AVAILABILITY_STATES,
  REASONING_ENTRY_CONTENT_MAX_LEN,
  REASONING_SURFACE_ENTRIES_MAX,
  ReasoningSurfaceReadRequestSchema,
  ReasoningSurfaceReadResponseSchema,
  TIMELINE_CHILD_RUN_EXPAND_METHOD,
  TIMELINE_METHOD_DESCRIPTORS,
  TIMELINE_METHOD_NAMES,
  TIMELINE_PAGE_FRAME_RESERVE_BYTES,
  TIMELINE_PAGE_MAX_BYTES,
  TIMELINE_READ_LIMIT_MAX,
  TIMELINE_READ_METHOD,
  TIMELINE_REASONING_SURFACE_READ_METHOD,
  TIMELINE_ROLLBACK_BOUNDARY_TYPE,
  TIMELINE_ROW_KINDS,
  TIMELINE_ROW_SUMMARY_MAX_LEN,
  TIMELINE_RUN_ATTRIBUTION_PAYLOAD_KEYS,
  TIMELINE_RUN_LIFECYCLE_CATEGORY,
  TIMELINE_RUN_SCOPED_EVENT_TYPES,
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

/**
 * The general arm carries a NON-run category, and must: every
 * `run_lifecycle` event is run-scoped, so the arm that structurally has no run
 * identity refuses that category outright (F55).
 */
const generalRow = {
  ...rowCommon,
  kind: "general",
  category: "session_lifecycle",
  type: "session.created",
  summary: "Session created",
} as const;

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

  it("F53 — every non-boundary arm REFUSES the rollback event type", () => {
    // `kind` and `type` cannot disagree in the direction that loses data. A row
    // with kind "run" carrying type "run.rolled_back" would parse otherwise —
    // the run arm's `type` is the base's free-form string — and would reach a
    // consumer narrowing on `kind` as an ordinary run row, with the rewind
    // cutoff sitting unread in its untyped payload. That is the untyped-cutoff
    // delivery I-013-5 forbids, reached by the back door.
    const armFixtures: readonly [string, Record<string, unknown>][] = [
      ["run", runScopedRow],
      ["legacy_stub", legacyStubRow],
      ["general", generalRow],
    ];
    for (const [armName, fixture] of armFixtures) {
      const result = TimelineRowSchema.safeParse({
        ...fixture,
        type: TIMELINE_ROLLBACK_BOUNDARY_TYPE,
      });
      expect(result.success, `${armName} must refuse the rollback event type`).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.join(".") === "type")).toBe(true);
      }
      // Positive control per arm: the SAME fixture with its own type parses, so
      // the rejection is the literal and not the fixture.
      expect(TimelineRowSchema.safeParse(fixture).success).toBe(true);
    }
    // And the boundary arm — the one legitimate home — still accepts it.
    expect(TimelineRowSchema.safeParse(rollbackBoundaryRow).success).toBe(true);
  });

  it("F54 — a superseded marker must rank BELOW the row it marks", () => {
    // `Spec-013 §Required Behavior`: the boundary marks rows "whose carried run
    // position exceeds the carried rewind cutoff". Exceeds — so the cutoff row
    // itself is the retained floor and is not superseded.
    const at = { ...runScopedRow, position: 7, superseded: { targetPosition: 7 } };
    const below = { ...runScopedRow, position: 6, superseded: { targetPosition: 7 } };
    const above = { ...runScopedRow, position: 8, superseded: { targetPosition: 7 } };
    expect(TimelineRowSchema.safeParse(at).success, "equal position is the floor").toBe(false);
    expect(TimelineRowSchema.safeParse(below).success, "below the cut survives").toBe(false);
    expect(TimelineRowSchema.safeParse(above).success, "above the cut is superseded").toBe(true);
    const refused = TimelineRowSchema.safeParse(at);
    if (!refused.success) {
      expect(
        refused.error.issues.some((issue) => issue.path.join(".") === "superseded.targetPosition"),
      ).toBe(true);
    }
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

  it("F55 — the boundary row's OWN marker obeys the same ordering rule", () => {
    // A boundary row ranks at its confirmed rewind floor and can itself be
    // superseded by a later, lower cut — so the ordering rule applies to it
    // too, against its own position rather than its payload's.
    const boundaryPosition: number = rollbackBoundaryRow.position;
    expect(
      TimelineRowSchema.safeParse({
        ...rollbackBoundaryRow,
        superseded: { targetPosition: boundaryPosition },
      }).success,
    ).toBe(false);
    expect(
      TimelineRowSchema.safeParse({
        ...rollbackBoundaryRow,
        superseded: { targetPosition: boundaryPosition - 1 },
      }).success,
    ).toBe(true);
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
      hasMore: false,
    });
    // …and the paged form of the same state, which is a continuation and not a
    // fifth state — `REASONING_AVAILABILITY_STATES` stays four.
    expectRoundTrip(ReasoningSurfaceReadResponseSchema, {
      availability: "available",
      reasoningEntries: [reasoningEntry],
      hasMore: true,
      nextCursor: "seq-42",
    });
    expectRoundTrip(ReasoningSurfaceReadResponseSchema, { availability: "unavailable" });
    expectRoundTrip(ReasoningSurfaceReadResponseSchema, { availability: "compacted" });
    expectRoundTrip(ReasoningSurfaceReadResponseSchema, {
      availability: "policy_redacted",
      policyReason: "withheld by organization policy",
    });
  });

  it("F49 — a CONTINUING `available` page REFUSES an empty entry list", () => {
    // A continuing page with no entries promises more, supplies a cursor to ask
    // with, and delivers nothing: the client re-asks from the same cursor,
    // receives the same answer, and loops. The floor makes that unrepresentable
    // rather than discouraged.
    expect(
      ReasoningSurfaceReadResponseSchema.safeParse({
        availability: "available",
        reasoningEntries: [],
        hasMore: true,
        nextCursor: "seq-42",
      }).success,
    ).toBe(false);
    // Positive control on the same axis: one entry is enough.
    expectRoundTrip(ReasoningSurfaceReadResponseSchema, {
      availability: "available",
      reasoningEntries: [reasoningEntry],
      hasMore: true,
      nextCursor: "seq-42",
    });
  });

  it("F65 — a TERMINAL `available` page ACCEPTS an empty entry list", () => {
    // The second reversal on this axis, and the reason it is not a retreat from
    // the first: the collapse onto `unavailable` is a defect of a FIRST read,
    // and this arm is also how a continuation says it reached the end of a
    // surface that does exist. `unavailable` would say no reasoning was
    // captured, `compacted` that it was discarded, `policy_redacted` that it
    // was withheld — all three misstate a cursor that simply ran out.
    //
    // The schema cannot tell those two cases apart because the request is not
    // in its scope, so the first-page floor is enforced in the daemon binder,
    // where request and response are held together; the daemon suite owns that
    // assertion.
    expectRoundTrip(ReasoningSurfaceReadResponseSchema, {
      availability: "available",
      reasoningEntries: [],
      hasMore: false,
    });
  });

  it("F23 — `available` without `reasoningEntries` fails", () => {
    expect(
      ReasoningSurfaceReadResponseSchema.safeParse({ availability: "available", hasMore: false })
        .success,
    ).toBe(false);
  });

  it("F61 — the paged `available` state obeys the same cursor rule the window does", () => {
    // A reasoning surface that says there is more and cannot say where to
    // resume is the same broken promise a cursorless `hasMore: true` window
    // makes, on a surface `Spec-013 §Default Behavior` already calls
    // summary-first — so the page break is the normal case, not the edge one.
    expect(
      ReasoningSurfaceReadResponseSchema.safeParse({
        availability: "available",
        reasoningEntries: [reasoningEntry],
        hasMore: true,
      }).success,
    ).toBe(false);
    // `hasMore` is required on the state that pages: its absence would be a
    // third answer to a two-valued question.
    expect(
      ReasoningSurfaceReadResponseSchema.safeParse({
        availability: "available",
        reasoningEntries: [reasoningEntry],
      }).success,
    ).toBe(false);
    // The three unpaged states carry no continuation at all — `hasMore` on a
    // state that returns nothing would promise more of nothing.
    for (const unpagedState of ["unavailable", "compacted"]) {
      expect(
        ReasoningSurfaceReadResponseSchema.safeParse({
          availability: unpagedState,
          hasMore: false,
        }).success,
      ).toBe(false);
    }
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
        hasMore: false,
      }).success,
    ).toBe(true);
    expect(
      ReasoningSurfaceReadResponseSchema.safeParse({
        availability: "available",
        reasoningEntries: [...atCap, reasoningEntry],
        hasMore: false,
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
    expectRoundTrip(ReasoningSurfaceReadRequestSchema, { runId: RUN_ID, afterCursor: "seq-42" });
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

  it("F50 — `hasMore: true` REQUIRES `nextCursor`", () => {
    // A window promising more rows and supplying no way to ask for them leaves
    // the caller re-reading the same window or giving up, and both lose rows
    // the session holds. `Spec-013 §Interfaces And Contracts` requires
    // "cursor-based continuation"; this is that requirement made unskippable.
    expect(
      TimelineReadResponseSchema.safeParse({ entries: [generalRow], hasMore: true }).success,
    ).toBe(false);
    // Positive control: the same window with its cursor parses. `entries` is
    // non-empty on both, because F66 makes an empty continuing page a refusal
    // in its own right and a negative control that trips two rules at once
    // proves neither.
    expect(
      TimelineReadResponseSchema.safeParse({
        entries: [generalRow],
        hasMore: true,
        nextCursor: cursor,
      }).success,
    ).toBe(true);
  });

  it("F51 — the terminal window ALLOWS a cursor, and never requires one", () => {
    // This assertion is the reverse of the one first shipped here, and the
    // reversal is the finding. The two members answer different questions —
    // `hasMore` whether unread rows remain, `nextCursor` where this window
    // ended — so they do not contradict on a final page. A client that has
    // just read to the end and now wants `timeline.subscribe` to "support live
    // append plus replay recovery" from exactly there needs that position, and
    // forbidding it would make the client re-derive it or re-read the window
    // to recover something the producer already held.
    expectRoundTrip(TimelineReadResponseSchema, {
      entries: [],
      hasMore: false,
      nextCursor: cursor,
    });
    // …and it stays OPTIONAL: a producer with nothing more to say owes no
    // cursor. Both halves are asserted because neither implies the other.
    expectRoundTrip(TimelineReadResponseSchema, { entries: [], hasMore: false });
  });

  it("F52 — the response entry list is bounded by the SAME cap as the request", () => {
    // A response cap looser than the request cap would let a producer answer a
    // bounded ask with an unbounded window — the request bound read from the
    // other side. One shared constant, so the two cannot drift.
    const overCap = Array.from({ length: TIMELINE_READ_LIMIT_MAX + 1 }, () => generalRow);
    expect(TimelineReadResponseSchema.safeParse({ entries: overCap, hasMore: false }).success).toBe(
      false,
    );
    // Boundary control: exactly at the cap parses, so the rejection is the cap
    // and not the array.
    const atCap = Array.from({ length: TIMELINE_READ_LIMIT_MAX }, () => generalRow);
    expect(TimelineReadResponseSchema.safeParse({ entries: atCap, hasMore: false }).success).toBe(
      true,
    );
    // The child-run expansion is the same bounded window over a child's rows.
    expect(
      ChildRunExpandResponseSchema.safeParse({
        runId: RUN_ID,
        parentRunId: PARENT_RUN_ID,
        state: "completed",
        entries: overCap,
        hasMore: false,
      }).success,
    ).toBe(false);
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
    }) as { entries: TimelineRow[] };
    const live = TimelineRowSchema.parse(rollbackBoundaryRow);
    expect(window.entries[0]).toStrictEqual(live);
  });

  it("child-run expansion carries the same row union, with the same continuation", () => {
    expectRoundTrip(ChildRunExpandRequestSchema, { runId: RUN_ID });
    expectRoundTrip(ChildRunExpandRequestSchema, { runId: RUN_ID, afterCursor: cursor });
    // The request names the position to resume from `afterCursor`, matching its
    // sibling reads rather than spelling one namespace's cursor two ways.
    expect(ChildRunExpandRequestSchema.safeParse({ runId: RUN_ID, cursor: cursor }).success).toBe(
      false,
    );
    expectRoundTrip(ChildRunExpandResponseSchema, {
      runId: RUN_ID,
      parentRunId: PARENT_RUN_ID,
      state: "completed",
      entries: [runScopedRow],
      hasMore: false,
    });
    expectRoundTrip(ChildRunExpandResponseSchema, {
      runId: RUN_ID,
      parentRunId: PARENT_RUN_ID,
      state: "running",
      entries: [runScopedRow],
      hasMore: true,
      nextCursor: cursor,
    });
    // A child run is not inherently smaller than a session window, so the
    // continuing arm owes its cursor for the same reason F50 does.
    expect(
      ChildRunExpandResponseSchema.safeParse({
        runId: RUN_ID,
        parentRunId: PARENT_RUN_ID,
        state: "running",
        entries: [runScopedRow],
        hasMore: true,
      }).success,
    ).toBe(false);
    expect(
      ChildRunExpandResponseSchema.safeParse({
        runId: RUN_ID,
        parentRunId: PARENT_RUN_ID,
        state: "completed",
        entries: [{ ...runScopedRow, epoch: undefined }],
        hasMore: false,
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

// ----------------------------------------------------------------------------
// Category pinning and run-scoping (T1.1, I-013-1, I-013-5)
// ----------------------------------------------------------------------------

describe("row category is pinned where the event is", () => {
  it("F55 — the general arm REFUSES the run-scoped category", () => {
    // I-013-1's all-or-none attribution is enforced by ARM SELECTION: a
    // run-scoped row missing part of its triple fails the run arm and is never
    // re-offered. A row whose `kind` was stamped wrong never reaches that arm
    // at all, so the check never runs — and a `run_lifecycle` row would arrive
    // as a legitimately attribution-free general row. Every one of Spec-006's
    // thirteen `run_lifecycle` types is run-scoped, so there is no correct
    // projection this refusal costs.
    const misfiled = { ...generalRow, category: TIMELINE_RUN_LIFECYCLE_CATEGORY };
    const result = TimelineRowSchema.safeParse(misfiled);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "category")).toBe(true);
    }
    // Positive controls. The same category on the arms that SHOULD carry it
    // parses, so the refusal is the arm and not the category.
    expect(TimelineRowSchema.safeParse(runScopedRow).success).toBe(true);
    expect(TimelineRowSchema.safeParse(legacyStubRow).success).toBe(true);
    expect(runScopedRow.category).toBe(TIMELINE_RUN_LIFECYCLE_CATEGORY);
    // …and the general arm's own category still parses, so the fixture is not
    // failing for an unrelated reason.
    expect(TimelineRowSchema.safeParse(generalRow).success).toBe(true);
  });

  it("F56 — the boundary arm REFUSES any category but its event's own", () => {
    // `run.rolled_back` is registered `run_lifecycle` and nothing else. The arm
    // already pins `type`; leaving `category` open would leave the half that
    // can still disagree, and a renderer grouping by category would file the
    // rewind cutoff under the wrong family.
    const misCategorized = { ...rollbackBoundaryRow, category: "session_lifecycle" };
    const result = TimelineRowSchema.safeParse(misCategorized);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "category")).toBe(true);
    }
    expect(TimelineRowSchema.safeParse(rollbackBoundaryRow).success).toBe(true);
  });
});

describe("run attribution is refused where it cannot be read, and pinned where it can", () => {
  it("F63 — the run-scoped type census is DERIVED from the taxonomy, and its size is pinned", () => {
    // The count is pinned so a taxonomy growth that should change this set
    // fails here instead of changing it silently. Re-derive it by reading
    // `Spec-006`'s per-category payload shapes when it moves — do not simply
    // re-pin the number.
    //
    // 34 = 13 `run_lifecycle` + 2 `assistant_output` + 7 `tool_activity`
    //    + 10 `interactive_request` (6 `intervention.*` carrying required
    //      `targetRunId`, 4 `driver_ask.*` carrying required `runId`)
    //    + 2 `usage_telemetry` (`context_compacted`, `model_rerouted`, the two
    //      whose per-type shapes pin `runId` required).
    expect(TIMELINE_RUN_SCOPED_EVENT_TYPES.size).toBe(34);
    // Membership spot-checks across all five contributing categories, so the
    // count is not carried by one category swelling while another emptied.
    for (const runScopedType of [
      "run.completed",
      "assistant.message",
      "tool.result",
      "subagent.started",
      "intervention.applied",
      "driver_ask.requested",
      "usage.context_compacted",
      "usage.model_rerouted",
    ]) {
      expect(TIMELINE_RUN_SCOPED_EVENT_TYPES.has(runScopedType)).toBe(true);
    }
    // NEGATIVE CONTROLS — the exclusions are the whole reason this is a census
    // and not a category list. Each of these is genuinely session-scoped on at
    // least some rows, so admitting it would refuse a correct projection.
    for (const notAlwaysRunScoped of [
      // Queue events: the target run lives in the `queue_items` row, never in
      // the event payload.
      "queue_item.created",
      "queue_item.admitted",
      // `runId?` optional — a message accepted before any run exists is
      // session-scoped.
      "user.message",
      // Account-plane, bound to the node-scope sentinel session; no run at all.
      "usage.rate_limit_update",
      // `runId?` optional across the whole `artifact_publication` family.
      "artifact.published",
      "diff.created",
      // `runId?` optional in the shared usage shape.
      "usage.budget_warning",
      "usage.token_count",
      // Not run-attributed in any form.
      "session.created",
      "membership.created",
    ]) {
      expect(TIMELINE_RUN_SCOPED_EVENT_TYPES.has(notAlwaysRunScoped)).toBe(false);
    }
  });

  it("F63 — the general arm REFUSES a run-scoped canonical type, whatever its category", () => {
    // The category leg alone was not enough: `assistant_output`,
    // `tool_activity`, and the run-scoped part of `interactive_request` are
    // every bit as run-attributed as `run_lifecycle`, and a `general` row of
    // one of those types carries no outer runId / position / epoch — so
    // rollback projection can never reach it and it renders as permanently
    // current.
    for (const runScopedType of ["assistant.message", "tool.result", "driver_ask.requested"]) {
      const misfiled = {
        ...generalRow,
        category: "assistant_output",
        type: runScopedType,
      };
      const result = TimelineRowSchema.safeParse(misfiled);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.join(".") === "type")).toBe(true);
      }
    }
    // POSITIVE CONTROL: the same category with a type outside the census
    // parses, so the refusal is the type and not the category.
    expect(
      TimelineRowSchema.safeParse({
        ...generalRow,
        category: "artifact_publication",
        type: "artifact.published",
      }).success,
    ).toBe(true);
  });

  it("F63 — the general arm REFUSES a payload that names a run, under either key", () => {
    // The per-row leg. `artifact.published` is legitimately session-scoped on
    // one row and run-scoped on the next, because its registered `runId` is
    // optional — so the type cannot decide and the payload must.
    expect(TIMELINE_RUN_ATTRIBUTION_PAYLOAD_KEYS).toStrictEqual(["runId", "targetRunId"]);
    for (const runKey of TIMELINE_RUN_ATTRIBUTION_PAYLOAD_KEYS) {
      const runCarrying = {
        ...generalRow,
        category: "artifact_publication",
        type: "artifact.published",
        payload: { detail: "opaque", [runKey]: RUN_ID },
      };
      const result = TimelineRowSchema.safeParse(runCarrying);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((issue) => issue.path.join(".") === `payload.${runKey}`),
        ).toBe(true);
      }
    }
    // POSITIVE CONTROL: the same row without the run key parses.
    expect(
      TimelineRowSchema.safeParse({
        ...generalRow,
        category: "artifact_publication",
        type: "artifact.published",
        payload: { detail: "opaque" },
      }).success,
    ).toBe(true);
  });

  it("F64 — the run arm REFUSES a payload whose attribution contradicts the row", () => {
    // A run row can state its identity twice — once in the outer triple every
    // consumer filters on, once in the payload the detail view and canonical
    // provenance are read from. Nothing forced agreement, so a row filed under
    // run A could be sourced from run B, permanently and silently.
    const otherRunId = "99999999-8888-4777-8666-555555555555";
    const disagreements = [
      { payloadKey: "runId", payloadValue: otherRunId },
      // BOTH registered spellings, not just the first. An intervention row is
      // projected under the run it targets, so its payload names that run as
      // `targetRunId`; a guard reading only `runId` accepted outer run A with
      // payload run B and the row was then filtered, ranked, and superseded
      // under A while its detail named B — the same two-identity split, reached
      // through the one key the check did not read.
      { payloadKey: "targetRunId", payloadValue: otherRunId },
      { payloadKey: "sourceEpoch", payloadValue: runScopedRow.epoch + 1 },
      { payloadKey: "sourcePosition", payloadValue: runScopedRow.position + 1 },
    ] as const;
    for (const { payloadKey, payloadValue } of disagreements) {
      const contradicted = {
        ...runScopedRow,
        payload: { detail: "opaque", [payloadKey]: payloadValue },
      };
      const result = TimelineRowSchema.safeParse(contradicted);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((issue) => issue.path.join(".") === `payload.${payloadKey}`),
        ).toBe(true);
      }
    }
    // POSITIVE CONTROLS. Agreement parses — the check is on disagreement, not
    // on the keys being present…
    expect(
      TimelineRowSchema.safeParse({
        ...runScopedRow,
        payload: {
          detail: "opaque",
          runId: runScopedRow.runId,
          sourceEpoch: runScopedRow.epoch,
          sourcePosition: runScopedRow.position,
        },
      }).success,
    ).toBe(true);
    // …and ABSENCE parses, because a projection may summarize a payload down
    // to nothing and `Spec-013` requires no particular payload content.
    expect(TimelineRowSchema.safeParse(runScopedRow).success).toBe(true);
  });

  it("F64 — the legacy-stub arm REFUSES the same contradiction, under either key", () => {
    // A stub preserves its `runId` and loses only its ordinals, so a stub whose
    // payload names a different run splits its identity exactly as a run row
    // does. The arm carries no epoch or position, so the run-identity half of
    // the check is the whole of it here.
    const otherRunId = "99999999-8888-4777-8666-555555555555";
    for (const payloadKey of ["runId", "targetRunId"] as const) {
      const contradicted = {
        ...legacyStubRow,
        payload: { detail: "opaque", [payloadKey]: otherRunId },
      };
      const result = TimelineRowSchema.safeParse(contradicted);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((issue) => issue.path.join(".") === `payload.${payloadKey}`),
        ).toBe(true);
      }
    }
    // POSITIVE CONTROLS: agreement parses, and so does absence.
    expect(
      TimelineRowSchema.safeParse({
        ...legacyStubRow,
        payload: { detail: "opaque", targetRunId: legacyStubRow.runId },
      }).success,
    ).toBe(true);
    expect(TimelineRowSchema.safeParse(legacyStubRow).success).toBe(true);
  });
});

describe("child-run lineage is acyclic (T1.2)", () => {
  it("F57 — a summary that is its own parent is refused", () => {
    // Every consumer of the lineage walks it: the renderer nests a child under
    // its parent, the one-layer nesting rule is checked against the chain, and
    // cost attribution sums along it. A self-parenting row turns each of those
    // walks into a loop, so it is refused once here rather than defended
    // against separately at every walk.
    const result = ChildRunSummarySchema.safeParse({ ...childRunSummary, parentRunId: RUN_ID });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "parentRunId")).toBe(
        true,
      );
    }
    // Positive control: a distinct parent parses.
    expect(ChildRunSummarySchema.safeParse(childRunSummary).success).toBe(true);
  });

  it("F57 — the expansion states the same relationship and refuses it the same way", () => {
    expect(
      ChildRunExpandResponseSchema.safeParse({
        runId: RUN_ID,
        parentRunId: RUN_ID,
        state: "completed",
        entries: [],
        hasMore: false,
      }).success,
    ).toBe(false);
    expect(
      ChildRunExpandResponseSchema.safeParse({
        runId: RUN_ID,
        parentRunId: PARENT_RUN_ID,
        state: "completed",
        entries: [],
        hasMore: false,
      }).success,
    ).toBe(true);
  });
});

describe("paged replies are ordered, run-scoped, and frame-safe (T1.3)", () => {
  const cursor = "seq-42";
  const rowAt = (sequence: number): Record<string, unknown> => ({
    ...runScopedRow,
    id: `evt-${String(sequence)}`,
    sequence,
  });

  it("F58 — a window whose entries go backwards is refused", () => {
    // `Spec-013 §Default Behavior`: rows run oldest to newest. A producer that
    // ships them scrambled forces every consumer to re-sort a window it
    // already had in order, and a consumer that does not re-sort renders the
    // session's history out of sequence.
    const result = TimelineReadResponseSchema.safeParse({
      entries: [rowAt(10), rowAt(3)],
      hasMore: false,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.path.join(".") === "entries.1.sequence"),
      ).toBe(true);
    }
    // Positive controls: ascending parses, and so does a repeated sequence —
    // the rule is nondecreasing, because nothing in Spec-013 forbids a
    // projection from emitting two rows for one event.
    expect(
      TimelineReadResponseSchema.safeParse({ entries: [rowAt(3), rowAt(10)], hasMore: false })
        .success,
    ).toBe(true);
    expect(
      TimelineReadResponseSchema.safeParse({ entries: [rowAt(3), rowAt(3)], hasMore: false })
        .success,
    ).toBe(true);
    // The expansion is the same window over a child's rows, so the same rule.
    expect(
      ChildRunExpandResponseSchema.safeParse({
        runId: RUN_ID,
        parentRunId: PARENT_RUN_ID,
        state: "completed",
        entries: [rowAt(10), rowAt(3)],
        hasMore: false,
      }).success,
    ).toBe(false);
  });

  it("F62 — a reasoning page whose entries go backwards is refused", () => {
    // The ordering rule is written about the SURFACE, not about one member.
    // `ReasoningEntry` carries the same `sequence`, its own doc comment says
    // the entries are "ordered by its originating `sequence`", and a reasoning
    // page arriving scrambled is the same defect with the same consequence —
    // a consumer that does not re-sort renders a run's thinking out of order.
    const reasoningAt = (sequence: number): unknown => ({
      sequence,
      content: "considered the alternatives",
      timestamp: "2026-09-01T00:00:00.000Z",
    });
    const result = ReasoningSurfaceReadResponseSchema.safeParse({
      availability: "available",
      reasoningEntries: [reasoningAt(10), reasoningAt(3)],
      hasMore: false,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The issue path names the member the caller actually sent, not the
      // timeline window's `entries` — a path pointing at a member that is not
      // on this response would send a producer looking in the wrong place.
      expect(
        result.error.issues.some((issue) => issue.path.join(".") === "reasoningEntries.1.sequence"),
      ).toBe(true);
    }
    // Positive controls, matching F58's: ascending parses and so does a
    // repeated sequence, because the rule is nondecreasing on both surfaces.
    expect(
      ReasoningSurfaceReadResponseSchema.safeParse({
        availability: "available",
        reasoningEntries: [reasoningAt(3), reasoningAt(10)],
        hasMore: false,
      }).success,
    ).toBe(true);
    expect(
      ReasoningSurfaceReadResponseSchema.safeParse({
        availability: "available",
        reasoningEntries: [reasoningAt(3), reasoningAt(3)],
        hasMore: false,
      }).success,
    ).toBe(true);
  });

  it("F59 — an expansion carries only the expanded run's rows", () => {
    // An expansion answers "what did child run X do". A row attributed to
    // another run is either a projection defect or a cross-run leak, and both
    // render as X's activity once the row is inside X's expansion.
    const foreignRow = { ...runScopedRow, runId: OTHER_RUN_ID };
    const result = ChildRunExpandResponseSchema.safeParse({
      runId: RUN_ID,
      parentRunId: PARENT_RUN_ID,
      state: "completed",
      entries: [foreignRow],
      hasMore: false,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "entries.0.runId")).toBe(
        true,
      );
    }
    // Every run-bearing kind is checked, not just the run arm.
    for (const foreign of [
      { ...legacyStubRow, runId: OTHER_RUN_ID },
      {
        ...rollbackBoundaryRow,
        runId: OTHER_RUN_ID,
        payload: { ...rolledBackPayload, runId: OTHER_RUN_ID },
      },
    ]) {
      expect(
        ChildRunExpandResponseSchema.safeParse({
          runId: RUN_ID,
          parentRunId: PARENT_RUN_ID,
          state: "completed",
          entries: [foreign],
          hasMore: false,
        }).success,
      ).toBe(false);
    }
    // The general arm is EXEMPT and must be: it structurally carries no
    // `runId`, so a session-scoped row inside a child's window is context,
    // not misattribution.
    expect(
      ChildRunExpandResponseSchema.safeParse({
        runId: RUN_ID,
        parentRunId: PARENT_RUN_ID,
        state: "completed",
        entries: [generalRow],
        hasMore: false,
      }).success,
    ).toBe(true);
  });

  // A single JS unit that `JSON.stringify` escapes to a six-byte `\uXXXX`
  // sequence — the true worst case for the reserve derivation, and admissible
  // because `wireFreeFormString` bans only NUL and whitespace-only strings.
  const worstCaseUnit = "\u0001";
  const worstCaseRow = {
    ...runScopedRow,
    id: worstCaseUnit.repeat(EVENT_FIELD_MAX_LEN),
    type: worstCaseUnit.repeat(EVENT_FIELD_MAX_LEN),
    actor: worstCaseUnit.repeat(EVENT_FIELD_MAX_LEN),
    summary: worstCaseUnit.repeat(TIMELINE_ROW_SUMMARY_MAX_LEN),
    childRunSummary,
    superseded: { targetPosition: 1 },
  };
  const worstCasePage = Array.from({ length: TIMELINE_READ_LIMIT_MAX }, (_unused, index) => ({
    ...worstCaseRow,
    sequence: index,
  }));

  it("F60 — the row-count ceiling alone does NOT bound the frame, and the byte budget does", () => {
    // The finding, stated as arithmetic rather than as a worry. Every field
    // below is at its own contract bound, so this page is contract-valid on
    // every axis except the one being added here.
    expect(jsonUtf8ByteLength(worstCasePage)).toBeGreaterThan(MAX_MESSAGE_BYTES);
    expect(
      TimelineReadResponseSchema.safeParse({ entries: worstCasePage, hasMore: false }).success,
    ).toBe(false);

    // The producer's half stops before the count ceiling, which is the whole
    // point: reaching 256 rows is not what usually ends a page.
    const fitted = countEntriesFittingOneFrame(worstCasePage, TIMELINE_READ_LIMIT_MAX);
    expect(fitted).toBeGreaterThan(0);
    expect(fitted).toBeLessThan(TIMELINE_READ_LIMIT_MAX);

    // P16 — the producer and the validator agree BY CONSTRUCTION: the page the
    // fitting function returns is accepted, and one row more is refused.
    const page = worstCasePage.slice(0, fitted);
    expect(
      TimelineReadResponseSchema.safeParse({ entries: page, hasMore: true, nextCursor: cursor })
        .success,
    ).toBe(true);
    expect(
      TimelineReadResponseSchema.safeParse({
        entries: worstCasePage.slice(0, fitted + 1),
        hasMore: true,
        nextCursor: cursor,
      }).success,
    ).toBe(false);

    // …and the frame that page becomes fits. This is the claim the reserve
    // exists to make true: the whole JSON-RPC response envelope, carrying a
    // maximal continuation cursor and a maximal echoed id, stays under the
    // framer's cap.
    const maximalCursor = worstCaseUnit.repeat(EVENT_CURSOR_MAX_LEN);
    const frameBody = {
      jsonrpc: "2.0",
      id: maximalCursor,
      result: { entries: page, hasMore: true, nextCursor: maximalCursor },
    };
    expect(jsonUtf8ByteLength(frameBody)).toBeLessThan(MAX_MESSAGE_BYTES);
  });

  // This case parses a frame-sized payload on purpose — REASONING_SURFACE_ENTRIES_MAX
  // entries of REASONING_ENTRY_CONTENT_MAX_LEN control characters, each encoded as
  // six JSON bytes — so its cost is the workload, not waste: 0.3 s bare, past the
  // 5 s default under coverage instrumentation on the runner. The bound is
  // explicit for the same reason the desktop's instrumented tier states its own.
  it(
    "F60 — the same budget bounds the expansion and the reasoning surface",
    { timeout: 60_000 },
    () => {
      expect(
        ChildRunExpandResponseSchema.safeParse({
          runId: RUN_ID,
          parentRunId: PARENT_RUN_ID,
          state: "completed",
          entries: worstCasePage,
          hasMore: false,
        }).success,
      ).toBe(false);

      const worstCaseEntries = Array.from(
        { length: REASONING_SURFACE_ENTRIES_MAX },
        (_unused, index) => ({
          sequence: index,
          content: worstCaseUnit.repeat(REASONING_ENTRY_CONTENT_MAX_LEN),
          timestamp: TIMESTAMP,
        }),
      );
      expect(jsonUtf8ByteLength(worstCaseEntries)).toBeGreaterThan(MAX_MESSAGE_BYTES);
      expect(
        ReasoningSurfaceReadResponseSchema.safeParse({
          availability: "available",
          reasoningEntries: worstCaseEntries,
          hasMore: false,
        }).success,
      ).toBe(false);
      // Positive control on the same axis: the fitted prefix parses.
      const fitted = countEntriesFittingOneFrame(worstCaseEntries, REASONING_SURFACE_ENTRIES_MAX);
      expect(fitted).toBeGreaterThan(0);
      expect(
        ReasoningSurfaceReadResponseSchema.safeParse({
          availability: "available",
          reasoningEntries: worstCaseEntries.slice(0, fitted),
          hasMore: true,
          nextCursor: cursor,
        }).success,
      ).toBe(true);
    },
  );

  it("the budget is the frame cap less a reserve, and the measure is exact", () => {
    expect(TIMELINE_PAGE_MAX_BYTES).toBe(MAX_MESSAGE_BYTES - TIMELINE_PAGE_FRAME_RESERVE_BYTES);
    // UTF-8 bytes of the JSON encoding, not JS string units — the distinction
    // the whole derivation rests on. Each figure includes the two quotes.
    expect(jsonUtf8ByteLength("a")).toBe(3);
    expect(jsonUtf8ByteLength("\u00e9")).toBe(4);
    expect(jsonUtf8ByteLength("\u2603")).toBe(5);
    expect(jsonUtf8ByteLength("\ud83d\ude42")).toBe(6);
    expect(jsonUtf8ByteLength("\u0001")).toBe(8);
    // An unserializable value measures as infinitely large rather than
    // throwing, so a refinement on a parse path reports an issue instead of
    // escaping `.parse()` as an exception.
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(jsonUtf8ByteLength(cyclic)).toBe(Number.POSITIVE_INFINITY);
    expect(jsonUtf8ByteLength(1n)).toBe(Number.POSITIVE_INFINITY);
  });

  it("the fitting function is exact at the boundary and floors at one", () => {
    const smallRow = { ...runScopedRow, sequence: 1 };
    // Nothing is dropped when everything fits.
    expect(countEntriesFittingOneFrame([smallRow, smallRow], TIMELINE_READ_LIMIT_MAX)).toBe(2);
    // The count ceiling still binds when it is the tighter of the two.
    expect(countEntriesFittingOneFrame([smallRow, smallRow], 1)).toBe(1);
    // An empty candidate list is genuinely empty — the floor answers "how
    // little may a page be", not "may a page exist at all".
    expect(countEntriesFittingOneFrame([], TIMELINE_READ_LIMIT_MAX)).toBe(0);
    // …and `maxCount` still wins where it is the smaller of the two, which is
    // the negative control that keeps the floor from reading as an absolute.
    expect(countEntriesFittingOneFrame([smallRow], 0)).toBe(0);
  });

  it("F66 — an over-budget FIRST candidate is paged as one entry, then refused by the budget", () => {
    // THE FLOOR, and where it stops. The byte budget bounds aggregation and
    // never bounds a page below one entry, so a first candidate that alone
    // exceeds the budget still counts as one: returning zero would leave the
    // caller with an empty page beside an unconsumed cursor, which is a
    // continuation that never advances and never names the offending row.
    const unfittableRow = {
      ...runScopedRow,
      payload: { blob: "x".repeat(TIMELINE_PAGE_MAX_BYTES) },
    };
    expect(countEntriesFittingOneFrame([unfittableRow], TIMELINE_READ_LIMIT_MAX)).toBe(1);
    // The floor does NOT put an oversized reply on the wire, and this is the
    // assertion that says so: the single-entry page it produces is measured
    // like any other and refused, naming the member. What the floor changed is
    // WHERE the undeliverable row is reported — structurally, at the response
    // boundary, on every producer — not whether it is delivered.
    const overBudgetPage = TimelineReadResponseSchema.safeParse({
      entries: [unfittableRow],
      hasMore: false,
    });
    expect(overBudgetPage.success).toBe(false);
    if (!overBudgetPage.success) {
      expect(overBudgetPage.error.issues.some((issue) => issue.path.join(".") === "entries")).toBe(
        true,
      );
    }
  });

  it("F66 — `hasMore: true` REQUIRES at least one entry, on both paged row replies", () => {
    // The producer's floor and the validator's floor are one rule seen from two
    // sides. A continuing page with no rows re-offers the same cursor forever:
    // the client obeys the contract, re-asks, and receives the same answer, and
    // nothing in the reply says anything is wrong.
    expect(
      TimelineReadResponseSchema.safeParse({ entries: [], hasMore: true, nextCursor: "seq-42" })
        .success,
    ).toBe(false);
    expect(
      ChildRunExpandResponseSchema.safeParse({
        runId: RUN_ID,
        parentRunId: PARENT_RUN_ID,
        state: "running",
        entries: [],
        hasMore: true,
        nextCursor: "seq-42",
      }).success,
    ).toBe(false);
    // POSITIVE CONTROLS, both directions. One row makes the same continuing
    // page legal…
    expect(
      TimelineReadResponseSchema.safeParse({
        entries: [generalRow],
        hasMore: true,
        nextCursor: "seq-42",
      }).success,
    ).toBe(true);
    // …and the TERMINAL arm keeps no floor, because an empty final page is the
    // honest answer to a continuation that reached the end and to a filtered
    // read that matched nothing.
    expect(TimelineReadResponseSchema.safeParse({ entries: [], hasMore: false }).success).toBe(
      true,
    );
    expect(
      ChildRunExpandResponseSchema.safeParse({
        runId: RUN_ID,
        parentRunId: PARENT_RUN_ID,
        state: "running",
        entries: [],
        hasMore: false,
      }).success,
    ).toBe(true);
  });
});
