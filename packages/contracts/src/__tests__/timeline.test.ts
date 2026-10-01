// Contract tests for timeline rows and paged reads. A row's `kind` selects its arm, and a row that
// fails its arm never falls through to the general arm, which would strip the attribution rollback
// projection keys on. Each arm refuses what would misfile that attribution: run attribution on the
// general arm, a payload that contradicts its row, a boundary row that disagrees with its typed
// payload, and a superseded marker at or below its row. A child-run summary always says whether it
// is complete; the reasoning surface says which of its three states it is in. Paged replies run
// oldest to newest, fit one frame and never continue empty; an expansion carries only its own
// run's rows and no run is its own parent. Body reads fit one frame, and search hits keep their
// match ranges and counts coherent.

import { describe, expect, it } from "vitest";

import { EVENT_FIELD_MAX_LEN } from "../event-envelope.js";
import { EVENT_CURSOR_MAX_LEN } from "../session.js";
import { MAX_MESSAGE_BYTES, jsonUtf8ByteLength } from "../jsonrpc.js";
import type { RunRolledBackEvent } from "../run-control.js";
import {
  CHILD_RUN_INCOMPLETE_CAUSES,
  countEntriesFittingOneFrame,
  ChildRunCompletenessSchema,
  ChildRunExpandResponseSchema,
  ChildRunSummarySchema,
  REASONING_ENTRY_CONTENT_MAX_LEN,
  REASONING_SURFACE_ENTRIES_MAX,
  ReasoningSurfaceReadResponseSchema,
  TIMELINE_PAGE_FRAME_RESERVE_BYTES,
  TIMELINE_PAGE_MAX_BYTES,
  TIMELINE_READ_LIMIT_MAX,
  TIMELINE_ROLLBACK_BOUNDARY_TYPE,
  TIMELINE_ROW_SUMMARY_MAX_LEN,
  TIMELINE_RUN_ATTRIBUTION_PAYLOAD_KEYS,
  TIMELINE_RUN_LIFECYCLE_CATEGORY,
  TimelineReadResponseSchema,
  TimelineRowSchema,
  TimelineBodyReadRequestSchema,
  TimelineBodyReadResponseSchema,
  TimelineSearchRequestSchema,
  TimelineSearchResponseSchema,
} from "../timeline/index.js";

const SESSION_ID = "6f1c9a6e-1f2b-4a3c-8d5e-0a1b2c3d4e5f";
const OTHER_SESSION_ID = "7a2d0b7f-2e3c-4b4d-9e6f-1b2c3d4e5f60";
const RUN_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_RUN_ID = "22222222-3333-4444-8555-666666666666";
const PARENT_RUN_ID = "33333333-4444-4555-8666-777777777777";
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
 * The general arm carries a non-run category: every `run_lifecycle` event is run-scoped, so the
 * arm with no run identity refuses that category.
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

describe("TimelineRow arm selection", () => {
  // The load-bearing half of each assertion is the second: the row must fail its `kind`-selected
  // arm and must not be re-offered to the general arm, which would silently strip the attribution
  // a rollback rule keys on.
  const partialAttributionRows = [
    ["epoch missing", { ...runScopedRow, epoch: undefined }],
    ["position missing", { ...runScopedRow, position: undefined }],
    ["runId missing", { ...runScopedRow, runId: undefined }],
    [
      "whole triple missing",
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
      // Every reported issue must be the run arm's own missing-member complaint, at the path of an
      // attribution member. Two shapes are what a fallthrough would look like and neither may
      // appear: `invalid_union` at `kind` (no arm accepted the row, so `kind` stopped selecting
      // the arm) and `unrecognized_keys` (the row reached the general arm, where the surviving
      // attribution members are unknown keys).
      const attributionMembers = new Set(["runId", "position", "epoch"]);
      expect(result.error.issues.length).toBeGreaterThan(0);
      for (const issue of result.error.issues) {
        expect(issue.code).toBe("invalid_type");
        expect(attributionMembers.has(String(issue.path[0]))).toBe(true);
      }
    },
  );

  it("the general arm refuses smuggled run attribution", () => {
    expect(
      TimelineRowSchema.safeParse({ ...generalRow, runId: RUN_ID, position: 7, epoch: 0 }).success,
    ).toBe(false);
    expect(TimelineRowSchema.safeParse({ ...generalRow, runId: RUN_ID }).success).toBe(false);
  });

  it("every non-boundary arm refuses the rollback event type", () => {
    // `kind` and `type` cannot disagree in the direction that loses data: a row with kind "run"
    // carrying type "run.rolled_back" would otherwise parse (the run arm's `type` is a free-form
    // string) and reach a consumer narrowing on `kind` as an ordinary run row, with the rewind
    // cutoff unread in its untyped payload.
    const armFixtures: readonly [string, Record<string, unknown>][] = [
      ["run", runScopedRow],
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

  it("a superseded marker must rank below the row it marks", () => {
    // A superseded marker is set on rows whose run position exceeds the rewind cutoff.
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
});

describe("TimelineRollbackBoundary", () => {
  it("an agreeing boundary parses with a typed payload, no cast", () => {
    const parsed = TimelineRowSchema.parse(rollbackBoundaryRow);
    expect(parsed.kind).toBe("rollback_boundary");
    if (parsed.kind !== "rollback_boundary") {
      throw new Error("expected the rollback_boundary arm");
    }
    // The whole point of the arm: `targetPosition` is reachable as a number through the narrowed
    // payload rather than out of `Record<string, unknown>`.
    const cutoff: number = parsed.payload.targetPosition;
    expect(cutoff).toBe(5);
    expect(parsed.payload.runVersion).toBe(12);
  });

  it("a payload that is not a RunRolledBackEvent fails, and does not throw", () => {
    // Each shape below breaks the payload a different way; none may escape as a TypeError out of
    // the arm's cross-field refinement.
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

  it("refuses a boundary row whose runId, sessionId or position disagrees with its payload", () => {
    {
      const result = TimelineRowSchema.safeParse({ ...rollbackBoundaryRow, runId: OTHER_RUN_ID });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.join(".") === "runId")).toBe(true);
      }
    }
    {
      const result = TimelineRowSchema.safeParse({
        ...rollbackBoundaryRow,
        sessionId: OTHER_SESSION_ID,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.join(".") === "sessionId")).toBe(
          true,
        );
      }
    }
    {
      const result = TimelineRowSchema.safeParse({ ...rollbackBoundaryRow, position: 9 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.join(".") === "position")).toBe(true);
      }
    }
    expect(TimelineRowSchema.safeParse(rollbackBoundaryRow).success).toBe(true);
  });
});

describe("ChildRunSummary completeness marker", () => {
  const withCompleteness = (completeness: unknown): unknown => ({
    ...childRunSummary,
    completeness,
  });

  it("the complete arm round-trips and carries nothing else", () => {
    expectRoundTrip(ChildRunCompletenessSchema, { state: "complete" });
    expectRoundTrip(ChildRunSummarySchema, childRunSummary);
  });

  it("every cause in the closed set round-trips on the incomplete arm", () => {
    for (const cause of CHILD_RUN_INCOMPLETE_CAUSES) {
      expectRoundTrip(ChildRunCompletenessSchema, { ...incompleteCompleteness, cause });
      expectRoundTrip(
        ChildRunSummarySchema,
        withCompleteness({ ...incompleteCompleteness, cause }),
      );
    }
  });

  it("`completeness` is required; an absent marker is not a third state", () => {
    const { completeness: _dropped, ...withoutMarker } = childRunSummary;
    expect(ChildRunSummarySchema.safeParse(withoutMarker).success).toBe(false);
  });

  it("the incomplete arm requires `cause`", () => {
    const { cause: _dropped, ...withoutCause } = incompleteCompleteness;
    expect(ChildRunCompletenessSchema.safeParse(withoutCause).success).toBe(false);
    expect(ChildRunSummarySchema.safeParse(withCompleteness(withoutCause)).success).toBe(false);
  });

  it("the incomplete arm requires `observedAt`", () => {
    const { observedAt: _dropped, ...withoutTime } = incompleteCompleteness;
    expect(ChildRunCompletenessSchema.safeParse(withoutTime).success).toBe(false);
  });

  it("a cause outside the closed set is refused", () => {
    expect(
      ChildRunCompletenessSchema.safeParse({ ...incompleteCompleteness, cause: "node_offline" })
        .success,
    ).toBe(false);
    // Negative control: the rejection is the vocabulary, not the fixture.
    expect(
      ChildRunCompletenessSchema.safeParse({
        ...incompleteCompleteness,
        cause: "detail_fetch_failed",
      }).success,
    ).toBe(true);
  });

  it("a `state` outside the two arms selects no arm", () => {
    const result = ChildRunCompletenessSchema.safeParse({ state: "partial" });
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    // Discriminator failure, not a member failure: the union rejected the row before reading
    // anything else, which is what keeps the arms independent.
    expect(result.error.issues.some((issue) => issue.path.join(".") === "state")).toBe(true);
  });

  it("the complete arm refuses a cause or an observation time", () => {
    expect(
      ChildRunCompletenessSchema.safeParse({ state: "complete", cause: "detail_fetch_failed" })
        .success,
    ).toBe(false);
    expect(
      ChildRunCompletenessSchema.safeParse({
        state: "complete",
        observedAt: "2026-09-01T12:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("`observedAt` is an offset-bearing ISO-8601 instant, not a free string", () => {
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
});

describe("the reasoning surface's availability and paging", () => {
  const reasoningEntry = { sequence: 1, content: "normalized reasoning", timestamp: TIMESTAMP };

  it("each of the three states round-trips", () => {
    expectRoundTrip(ReasoningSurfaceReadResponseSchema, {
      availability: "available",
      reasoningEntries: [reasoningEntry],
      hasMore: false,
    });
    // The paged form of the same state is a continuation, not another state.
    expectRoundTrip(ReasoningSurfaceReadResponseSchema, {
      availability: "available",
      reasoningEntries: [reasoningEntry],
      hasMore: true,
      nextCursor: "seq-42",
    });
    expectRoundTrip(ReasoningSurfaceReadResponseSchema, { availability: "unavailable" });
  });

  it("a terminal `available` page accepts an empty entry list", () => {
    // This arm is how a continuation says it reached the end of a surface that exists:
    // `unavailable` would say no reasoning was captured, wrong for a cursor that simply ran out.
    expectRoundTrip(ReasoningSurfaceReadResponseSchema, {
      availability: "available",
      reasoningEntries: [],
      hasMore: false,
    });
  });

  it("`available` without `reasoningEntries` fails", () => {
    expect(
      ReasoningSurfaceReadResponseSchema.safeParse({ availability: "available", hasMore: false })
        .success,
    ).toBe(false);
  });

  it("the paged `available` state obeys the same cursor rule the window does", () => {
    // A reasoning surface that says there is more and cannot say where to resume is the same
    // broken promise as a cursorless `hasMore: true` window.
    expect(
      ReasoningSurfaceReadResponseSchema.safeParse({
        availability: "available",
        reasoningEntries: [reasoningEntry],
        hasMore: true,
      }).success,
    ).toBe(false);
    // `hasMore` is required on the state that pages: its absence would be a third answer to a
    // two-valued question.
    expect(
      ReasoningSurfaceReadResponseSchema.safeParse({
        availability: "available",
        reasoningEntries: [reasoningEntry],
      }).success,
    ).toBe(false);
    // The unpaged state carries no continuation at all: `hasMore` on a state that returns nothing
    // would promise more of nothing.
    expect(
      ReasoningSurfaceReadResponseSchema.safeParse({
        availability: "unavailable",
        hasMore: false,
      }).success,
    ).toBe(false);
  });

  it("entries on `unavailable` fail strict parse", () => {
    expect(
      ReasoningSurfaceReadResponseSchema.safeParse({
        availability: "unavailable",
        reasoningEntries: [reasoningEntry],
      }).success,
    ).toBe(false);
  });

  it("an `available: boolean` shape fails; there is no tolerant arm", () => {
    expect(
      ReasoningSurfaceReadResponseSchema.safeParse({
        available: true,
        reasoningEntries: [reasoningEntry],
      }).success,
    ).toBe(false);
    expect(ReasoningSurfaceReadResponseSchema.safeParse({ available: false }).success).toBe(false);
  });

  it("a continuing `available` page refuses an empty entry list", () => {
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
});

describe("run attribution is refused where it cannot be read, and pinned where it can", () => {
  it("the general arm refuses the run-scoped category", () => {
    // A row whose `kind` was stamped wrong never reaches that arm, so the check never runs, and a
    // `run_lifecycle` row would arrive as a legitimately attribution-free general row. Every
    // `run_lifecycle` type is run-scoped, so this refusal never rejects a correct projection.
    const misfiled = { ...generalRow, category: TIMELINE_RUN_LIFECYCLE_CATEGORY };
    const result = TimelineRowSchema.safeParse(misfiled);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "category")).toBe(true);
    }
    // Positive control. The same category on the arm that SHOULD carry it
    // parses, so the refusal is the arm and not the category.
    expect(TimelineRowSchema.safeParse(runScopedRow).success).toBe(true);
    expect(runScopedRow.category).toBe(TIMELINE_RUN_LIFECYCLE_CATEGORY);
    // …and the general arm's own category still parses, so the fixture is not
    // failing for an unrelated reason.
    expect(TimelineRowSchema.safeParse(generalRow).success).toBe(true);
  });

  it("the general arm refuses a run-scoped canonical type, whatever its category", () => {
    // The category leg alone is not enough: `assistant_output`, `tool_activity` and the
    // run-scoped part of `interactive_request` are as run-attributed as `run_lifecycle`, and a
    // general row of one of those types carries no outer runId, position or epoch, so rollback
    // projection could never reach it and it would render as permanently current.
    for (const runScopedType of ["assistant.message", "tool.result", "intervention.applied"]) {
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
    // Positive control: the same category with a type outside the run-scoped set parses, so the
    // refusal is the type and not the category.
    expect(
      TimelineRowSchema.safeParse({
        ...generalRow,
        category: "artifact_publication",
        type: "artifact.published",
      }).success,
    ).toBe(true);
  });

  it("the general arm refuses a payload that names a run, under either key", () => {
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
    // Positive control: the same row without the run key parses.
    expect(
      TimelineRowSchema.safeParse({
        ...generalRow,
        category: "artifact_publication",
        type: "artifact.published",
        payload: { detail: "opaque" },
      }).success,
    ).toBe(true);
  });

  it("the run arm refuses a payload whose attribution contradicts the row", () => {
    // A run row can state its identity twice: in the outer triple every consumer filters on, and
    // in the payload the detail view and canonical provenance are read from. Without agreement, a
    // row filed under run A could be sourced from run B, permanently and silently.
    const otherRunId = "99999999-8888-4777-8666-555555555555";
    const disagreements = [
      { payloadKey: "runId", payloadValue: otherRunId },
      // Both registered spellings are checked, not just the first. An intervention row is
      // projected under the run it targets, so its payload names that run as `targetRunId`; a
      // guard reading only `runId` would accept outer run A with payload run B, and the row would
      // be filtered, ranked and superseded under A while its detail named B.
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
    // Positive controls: agreement parses, since the check is on disagreement, not on the keys
    // being present…
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
    // to nothing and requires no particular payload content.
    expect(TimelineRowSchema.safeParse(runScopedRow).success).toBe(true);
  });
});

describe("child-run lineage is acyclic", () => {
  it("a summary that is its own parent is refused", () => {
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

  it("the expansion states the same relationship and refuses it the same way", () => {
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

describe("paged replies are ordered, run-scoped, and frame-safe", () => {
  const cursor = "seq-42";
  const rowAt = (sequence: number): Record<string, unknown> => ({
    ...runScopedRow,
    id: `evt-${String(sequence)}`,
    sequence,
  });

  it("a window whose entries go backwards is refused", () => {
    // Window rows run oldest to newest. A producer that ships them scrambled forces every
    // consumer to re-sort a window it already had in order, and a consumer that does not re-sort
    // renders the session's history out of sequence.
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
    // the rule is nondecreasing, because nothing forbids a projection from
    // emitting two rows for one event.
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

  it("a reasoning page whose entries go backwards is refused", () => {
    // `ReasoningEntry` carries the same `sequence` and its entries are ordered by it; a consumer
    // that does not re-sort a scrambled page renders a run's thinking out of order.
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
      // The issue path names the member the caller actually sent, not the timeline window's
      // `entries`: a path pointing at a member not on this response sends a producer looking in
      // the wrong place.
      expect(
        result.error.issues.some((issue) => issue.path.join(".") === "reasoningEntries.1.sequence"),
      ).toBe(true);
    }
    // Positive controls, as for the window: ascending parses and so does a repeated sequence,
    // because the rule is nondecreasing on both surfaces.
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

  it("an expansion carries only the expanded run's rows", () => {
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

  // A single JS unit that `JSON.stringify` escapes to a six-byte `\uXXXX` sequence: the true
  // worst case for the reserve derivation, and admissible because `wireFreeFormString` bans only
  // NUL and whitespace-only strings.
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

  it("the row-count ceiling alone does not bound the frame, and the byte budget does", () => {
    // Every field below is at its own contract bound, so this page is contract-valid on every
    // axis but its byte size.
    expect(jsonUtf8ByteLength(worstCasePage)).toBeGreaterThan(MAX_MESSAGE_BYTES);
    expect(
      TimelineReadResponseSchema.safeParse({ entries: worstCasePage, hasMore: false }).success,
    ).toBe(false);

    // The producer's half stops before the count ceiling: reaching the row cap is not what
    // usually ends a page.
    const fitted = countEntriesFittingOneFrame(worstCasePage, TIMELINE_READ_LIMIT_MAX);
    expect(fitted).toBeGreaterThan(0);
    expect(fitted).toBeLessThan(TIMELINE_READ_LIMIT_MAX);

    // The producer and the validator agree by construction: the page the fitting function
    // returns is accepted, and one row more is refused.
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

    // …and the frame that page becomes fits, which is the claim the reserve exists to make true:
    // the whole JSON-RPC response envelope, carrying a maximal continuation cursor and a maximal
    // echoed id, stays under the framer's cap.
    const maximalCursor = worstCaseUnit.repeat(EVENT_CURSOR_MAX_LEN);
    const frameBody = {
      jsonrpc: "2.0",
      id: maximalCursor,
      result: { entries: page, hasMore: true, nextCursor: maximalCursor },
    };
    expect(jsonUtf8ByteLength(frameBody)).toBeLessThan(MAX_MESSAGE_BYTES);
  });

  // This case parses a frame-sized payload on purpose, so its cost is the workload: well under a
  // second bare, past the 5 s default under coverage instrumentation.
  it("the same budget bounds the expansion and the reasoning surface", { timeout: 60_000 }, () => {
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
  });

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

  it("an over-budget first candidate is paged as one entry, then refused by the budget", () => {
    // The byte budget bounds aggregation but never bounds a page below one entry, so a first
    // candidate that alone exceeds the budget still counts as one: returning zero would leave
    // the caller with an empty page beside an unconsumed cursor, a continuation that never
    // advances and never names the offending row.
    const unfittableRow = {
      ...runScopedRow,
      payload: { blob: "x".repeat(TIMELINE_PAGE_MAX_BYTES) },
    };
    expect(countEntriesFittingOneFrame([unfittableRow], TIMELINE_READ_LIMIT_MAX)).toBe(1);
    // The floor does not put an oversized reply on the wire: the single-entry page it produces is
    // measured like any other and refused, naming the member. The floor decides where the
    // undeliverable row is reported (structurally, at the response boundary, on every producer),
    // not whether it is delivered.
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

  it("`hasMore: true` requires at least one entry, on both paged row replies", () => {
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

// Body and search reads.

/** A string whose JSON form is over one reply frame while its length is not. */
const overFrameText = "\u0001".repeat(Math.ceil(TIMELINE_PAGE_MAX_BYTES / 6) + 1);

describe("timeline.bodyRead", () => {
  it("accepts the request and each reply arm", () => {
    expectRoundTrip(TimelineBodyReadRequestSchema, { sessionId: SESSION_ID, rowId: "evt-0001" });
    expectRoundTrip(TimelineBodyReadResponseSchema, {
      status: "available",
      body: "the whole output",
      contentLength: 16,
    });
    expectRoundTrip(TimelineBodyReadResponseSchema, {
      status: "unavailable",
      reason: "absent",
    });
  });

  it("refuses a body too large for one reply frame", () => {
    expect(
      TimelineBodyReadResponseSchema.safeParse({ status: "available", body: overFrameText })
        .success,
    ).toBe(false);
  });
});

describe("timeline.search", () => {
  const hit = {
    rowId: "evt-0001",
    cursor: "seq-42",
    snippet: "the parser drops the last line",
    matchRanges: [{ offset: 4, length: 6 }],
  };

  it("accepts the request and a continuing and a final page", () => {
    expectRoundTrip(TimelineSearchRequestSchema, {
      sessionId: SESSION_ID,
      query: "parser",
      beforeCursor: "seq-90",
      limit: 20,
    });
    expectRoundTrip(TimelineSearchResponseSchema, {
      matchCount: 9,
      hits: [hit],
      hasMore: true,
      nextCursor: "seq-42",
    });
    expectRoundTrip(TimelineSearchResponseSchema, { matchCount: 0, hits: [], hasMore: false });
  });

  it("refuses a continuing page with no hits", () => {
    expect(
      TimelineSearchResponseSchema.safeParse({
        matchCount: 3,
        hits: [],
        hasMore: true,
        nextCursor: "seq-42",
      }).success,
    ).toBe(false);
  });

  it("refuses a match range outside its snippet or overlapping the one before", () => {
    expect(
      TimelineSearchResponseSchema.safeParse({
        matchCount: 1,
        hits: [{ ...hit, matchRanges: [{ offset: 28, length: 6 }] }],
        hasMore: false,
      }).success,
    ).toBe(false);
    expect(
      TimelineSearchResponseSchema.safeParse({
        matchCount: 2,
        hits: [
          {
            ...hit,
            matchRanges: [
              { offset: 4, length: 6 },
              { offset: 8, length: 2 },
            ],
          },
        ],
        hasMore: false,
      }).success,
    ).toBe(false);
  });

  it("refuses a whole-session count below the matches on the page", () => {
    expect(
      TimelineSearchResponseSchema.safeParse({ matchCount: 0, hits: [hit], hasMore: false })
        .success,
    ).toBe(false);
  });
});
