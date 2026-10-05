// Transcript rows keep the run attribution rollback projection keys on: a row never falls through
// to an arm that would drop it. Paged replies run oldest to newest, fit one frame and never
// continue empty.

import { describe, expect, it } from "vitest";

import { EVENT_FIELD_MAX_LEN } from "../../event/envelope.js";
import { EVENT_CURSOR_MAX_LEN } from "../../session/session.js";
import { MAX_MESSAGE_BYTES, jsonUtf8ByteLength } from "../../jsonrpc/jsonrpc.js";
import type { RunRolledBackEvent } from "../../run/control.js";
import { ChildRunSummarySchema } from "../child-run-summary.js";
import {
  countEntriesFittingOneFrame,
  ChildRunExpandResponseSchema,
  REASONING_ENTRY_CONTENT_MAX_LEN,
  REASONING_SURFACE_ENTRIES_MAX,
  ReasoningSurfaceReadResponseSchema,
  TRANSCRIPT_PAGE_MAX_BYTES,
  TRANSCRIPT_READ_LIMIT_MAX,
  TranscriptReadResponseSchema,
} from "../operations.js";
import { TranscriptBodyReadResponseSchema } from "../row/content.js";
import {
  TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
  TRANSCRIPT_EVENT_ROW_SUMMARY_MAX_LEN,
  TRANSCRIPT_RUN_LIFECYCLE_CATEGORY,
  TranscriptEventRowSchema,
} from "../row/row.js";
import { TranscriptSearchResponseSchema } from "../search.js";

const SESSION_ID = "6f1c9a6e-1f2b-4a3c-8d5e-0a1b2c3d4e5f";
const OTHER_SESSION_ID = "7a2d0b7f-2e3c-4b4d-9e6f-1b2c3d4e5f60";
const RUN_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_RUN_ID = "22222222-3333-4444-8555-666666666666";
const PARENT_RUN_ID = "33333333-4444-4555-8666-777777777777";
const TIMESTAMP = "2026-09-01T12:00:00.000Z";
const CURSOR = "seq-42";

const rowCommon = {
  id: "evt-0001",
  sessionId: SESSION_ID,
  sequence: 42,
  cursor: CURSOR,
  category: "run_lifecycle",
  type: "run.started",
  summary: "Run started",
  timestamp: TIMESTAMP,
  payload: { detail: "opaque" },
} as const;

// A non-run category: every `run_lifecycle` event is run-scoped, so the general arm refuses it.
const generalRow = {
  ...rowCommon,
  kind: "general",
  category: "session_lifecycle",
  type: "session.created",
  summary: "Session created",
} as const;

const runScopedRow = { ...rowCommon, kind: "run", runId: RUN_ID, position: 7, epoch: 0 } as const;

const rolledBackPayload: RunRolledBackEvent = {
  sessionId: SESSION_ID as RunRolledBackEvent["sessionId"],
  runId: RUN_ID as RunRolledBackEvent["runId"],
  runVersion: 12,
  targetPosition: 5,
};

const rollbackBoundaryRow = {
  ...rowCommon,
  kind: "rollback_boundary",
  type: TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE,
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

const childExpansion = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  runId: RUN_ID,
  parentRunId: PARENT_RUN_ID,
  state: "completed",
  entries: [],
  hasMore: false,
  ...overrides,
});

const rowAt = (sequence: number): Record<string, unknown> => ({
  ...runScopedRow,
  id: `evt-${String(sequence)}`,
  sequence,
});

const reasoningAt = (sequence: number): Record<string, unknown> => ({
  sequence,
  content: "considered the alternatives",
  timestamp: TIMESTAMP,
});

const reasoningPage = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  availability: "available",
  hasMore: false,
  ...overrides,
});

const searchHit = {
  rowId: "evt-0001",
  cursor: CURSOR,
  snippet: "the parser drops the last line",
  matchRanges: [{ start: 4, end: 10 }],
};

/** Parses `value` and asserts it is refused with an issue at `path`. */
function expectRefusedAt(
  schema: { safeParse: (value: unknown) => SafeParseOutcome },
  value: unknown,
  path: string,
): void {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain(path);
}

interface SafeParseOutcome {
  success: boolean;
  error?: { issues: readonly { path: readonly PropertyKey[] }[] };
}

describe("rollback projection keeps every row's run attribution", () => {
  it.each([
    ["epoch missing", { ...runScopedRow, epoch: undefined }],
    ["position missing", { ...runScopedRow, position: undefined }],
    ["runId missing", { ...runScopedRow, runId: undefined }],
    [
      "whole triple missing",
      { ...runScopedRow, runId: undefined, position: undefined, epoch: undefined },
    ],
  ] as const)("%s: a partial run row fails its own arm and never falls through", (_, row) => {
    const withoutUndefinedKeys = Object.fromEntries(
      Object.entries(row).filter(([, value]) => value !== undefined),
    );
    const result = TranscriptEventRowSchema.safeParse(withoutUndefinedKeys);
    expect(result.success).toBe(false);
    // A fallthrough would show as `invalid_union` at `kind` or as `unrecognized_keys` from the
    // general arm, which would strip the attribution the rollback rule keys on.
    expect(result.error?.issues.length).toBeGreaterThan(0);
    for (const issue of result.error?.issues ?? []) {
      expect(issue.code).toBe("invalid_type");
      expect(["runId", "position", "epoch"]).toContain(String(issue.path[0]));
    }
  });

  it("the general arm refuses every form of run attribution", () => {
    // A general row carries no runId, position or epoch, so rollback could never reach a run's
    // row misfiled there and it would render as permanently current.
    const artifactRow = {
      ...generalRow,
      category: "artifact_publication",
      type: "artifact.published",
    };
    const misfiled: readonly [Record<string, unknown>, string][] = [
      [{ ...generalRow, runId: RUN_ID, position: 7, epoch: 0 }, ""],
      [{ ...generalRow, runId: RUN_ID }, ""],
      [{ ...generalRow, category: TRANSCRIPT_RUN_LIFECYCLE_CATEGORY }, "category"],
      [{ ...generalRow, category: "assistant_output", type: "assistant.message" }, "type"],
      [{ ...generalRow, category: "assistant_output", type: "tool.result" }, "type"],
      [{ ...generalRow, category: "assistant_output", type: "intervention.applied" }, "type"],
      // `artifact.published` is session-scoped on one row and run-scoped on the next, so the
      // payload decides.
      [{ ...artifactRow, payload: { runId: RUN_ID } }, "payload.runId"],
      [{ ...artifactRow, payload: { targetRunId: RUN_ID } }, "payload.targetRunId"],
    ];
    for (const [row, path] of misfiled) {
      if (path === "") {
        expect(TranscriptEventRowSchema.safeParse(row).success).toBe(false);
      } else {
        expectRefusedAt(TranscriptEventRowSchema, row, path);
      }
    }
    expect(TranscriptEventRowSchema.safeParse(generalRow).success).toBe(true);
    expect(TranscriptEventRowSchema.safeParse(artifactRow).success).toBe(true);
  });

  it("only the boundary arm carries the rollback event type", () => {
    // A run row typed `run.rolled_back` would reach a consumer narrowing on `kind` as an ordinary
    // row, with the rewind cutoff unread in its untyped payload.
    for (const row of [runScopedRow, generalRow]) {
      expectRefusedAt(
        TranscriptEventRowSchema,
        { ...row, type: TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE },
        "type",
      );
      expect(TranscriptEventRowSchema.safeParse(row).success).toBe(true);
    }
    expect(TranscriptEventRowSchema.safeParse(rollbackBoundaryRow).success).toBe(true);
  });

  it("a boundary row agrees with its payload, and a broken payload fails without throwing", () => {
    expectRefusedAt(
      TranscriptEventRowSchema,
      { ...rollbackBoundaryRow, runId: OTHER_RUN_ID },
      "runId",
    );
    expectRefusedAt(
      TranscriptEventRowSchema,
      { ...rollbackBoundaryRow, sessionId: OTHER_SESSION_ID },
      "sessionId",
    );
    expectRefusedAt(TranscriptEventRowSchema, { ...rollbackBoundaryRow, position: 9 }, "position");
    // None may escape the cross-field refinement as a TypeError.
    for (const payload of [
      { detail: "opaque" },
      { ...rolledBackPayload, runVersion: undefined },
      { ...rolledBackPayload, targetPosition: "5" },
      { ...rolledBackPayload, unexpected: true },
      null,
      "run.rolled_back",
    ]) {
      expect(TranscriptEventRowSchema.safeParse({ ...rollbackBoundaryRow, payload }).success).toBe(
        false,
      );
    }
    const parsed = TranscriptEventRowSchema.parse(rollbackBoundaryRow);
    expect(parsed.kind === "rollback_boundary" && parsed.payload.targetPosition).toBe(5);
  });

  it("a run row's payload attribution must agree with the row", () => {
    // Otherwise a row filed under run A could be sourced from run B, permanently and silently.
    const otherRunId = "99999999-8888-4777-8666-555555555555";
    for (const [payloadKey, payloadValue] of [
      ["runId", otherRunId],
      ["targetRunId", otherRunId],
      ["sourceEpoch", runScopedRow.epoch + 1],
      ["sourcePosition", runScopedRow.position + 1],
    ] as const) {
      expectRefusedAt(
        TranscriptEventRowSchema,
        { ...runScopedRow, payload: { detail: "opaque", [payloadKey]: payloadValue } },
        `payload.${payloadKey}`,
      );
    }
    const agreeing = {
      ...runScopedRow,
      payload: { runId: RUN_ID, sourceEpoch: 0, sourcePosition: 7 },
    };
    expect(TranscriptEventRowSchema.safeParse(agreeing).success).toBe(true);
    expect(TranscriptEventRowSchema.safeParse(runScopedRow).success).toBe(true);
  });

  it("a superseded marker must rank below the row it marks", () => {
    const marked = (position: number) => ({
      ...runScopedRow,
      position,
      superseded: { targetPosition: 7 },
    });
    expectRefusedAt(TranscriptEventRowSchema, marked(7), "superseded.targetPosition");
    expect(TranscriptEventRowSchema.safeParse(marked(6)).success).toBe(false);
    expect(TranscriptEventRowSchema.safeParse(marked(8)).success).toBe(true);
  });
});

describe("child runs", () => {
  it("a child run that is its own parent is refused", () => {
    // Nesting and cost attribution walk the lineage, so a self-parent would loop each walk.
    expectRefusedAt(
      ChildRunSummarySchema,
      { ...childRunSummary, parentRunId: RUN_ID },
      "parentRunId",
    );
    expect(ChildRunSummarySchema.safeParse(childRunSummary).success).toBe(true);
    expect(
      ChildRunExpandResponseSchema.safeParse(childExpansion({ parentRunId: RUN_ID })).success,
    ).toBe(false);
    expect(ChildRunExpandResponseSchema.safeParse(childExpansion({})).success).toBe(true);
  });

  it("an incomplete summary must say so: the marker, its cause and its time are required", () => {
    // An absent marker or a cause-less one would read as a complete child run.
    const { completeness: _dropped, ...withoutMarker } = childRunSummary;
    expect(ChildRunSummarySchema.safeParse(withoutMarker).success).toBe(false);
    const incomplete = {
      state: "incomplete",
      cause: "detail_fetch_failed",
      observedAt: "2026-09-01T12:00:00Z",
    };
    const { cause: _cause, ...withoutCause } = incomplete;
    const { observedAt: _observedAt, ...withoutTime } = incomplete;
    for (const completeness of [withoutCause, withoutTime]) {
      expect(ChildRunSummarySchema.safeParse({ ...childRunSummary, completeness }).success).toBe(
        false,
      );
    }
    expect(
      ChildRunSummarySchema.safeParse({ ...childRunSummary, completeness: incomplete }).success,
    ).toBe(true);
  });

  it("an expansion carries only the expanded run's rows", () => {
    // A row from another run inside X's expansion renders as X's activity.
    expectRefusedAt(
      ChildRunExpandResponseSchema,
      childExpansion({ entries: [{ ...runScopedRow, runId: OTHER_RUN_ID }] }),
      "entries.0.runId",
    );
    const foreignBoundary = {
      ...rollbackBoundaryRow,
      runId: OTHER_RUN_ID,
      payload: { ...rolledBackPayload, runId: OTHER_RUN_ID },
    };
    expect(
      ChildRunExpandResponseSchema.safeParse(childExpansion({ entries: [foreignBoundary] }))
        .success,
    ).toBe(false);
    // A session-scoped row carries no run, so it is context, not misattribution.
    expect(
      ChildRunExpandResponseSchema.safeParse(childExpansion({ entries: [generalRow] })).success,
    ).toBe(true);
  });
});

describe("paged replies", () => {
  it("every paged reply runs oldest to newest", () => {
    expectRefusedAt(
      TranscriptReadResponseSchema,
      { entries: [rowAt(10), rowAt(3)], hasMore: false },
      "entries.1.sequence",
    );
    expectRefusedAt(
      ReasoningSurfaceReadResponseSchema,
      reasoningPage({ reasoningEntries: [reasoningAt(10), reasoningAt(3)] }),
      "reasoningEntries.1.sequence",
    );
    expect(
      ChildRunExpandResponseSchema.safeParse(childExpansion({ entries: [rowAt(10), rowAt(3)] }))
        .success,
    ).toBe(false);
    // Nondecreasing, not strictly increasing: a projection may emit two rows for one event.
    expect(
      TranscriptReadResponseSchema.safeParse({ entries: [rowAt(3), rowAt(3)], hasMore: false })
        .success,
    ).toBe(true);
    expect(
      ReasoningSurfaceReadResponseSchema.safeParse(
        reasoningPage({ reasoningEntries: [reasoningAt(3), reasoningAt(3)] }),
      ).success,
    ).toBe(true);
  });

  it.each([
    {
      reply: "transcript.read",
      schema: TranscriptReadResponseSchema,
      page: (entries: unknown[], more: object) => ({ entries, ...more }),
      entry: generalRow,
    },
    {
      reply: "childRun.expand",
      schema: ChildRunExpandResponseSchema,
      page: (entries: unknown[], more: object) => childExpansion({ entries, ...more }),
      entry: runScopedRow,
    },
    {
      reply: "reasoning surface",
      schema: ReasoningSurfaceReadResponseSchema,
      page: (entries: unknown[], more: object) =>
        reasoningPage({ reasoningEntries: entries, ...more }),
      entry: reasoningAt(1),
    },
    {
      reply: "transcript.search",
      schema: TranscriptSearchResponseSchema,
      page: (entries: unknown[], more: object) => ({ matchCount: 9, hits: entries, ...more }),
      entry: searchHit,
    },
  ])("$reply never continues empty or without a cursor", ({ schema, page, entry }) => {
    // An empty continuing page makes the client re-ask from the same cursor forever, and one
    // without a cursor cannot say where to resume.
    expect(schema.safeParse(page([], { hasMore: true, nextCursor: CURSOR })).success).toBe(false);
    expect(schema.safeParse(page([entry], { hasMore: true })).success).toBe(false);
    expect(schema.safeParse(page([entry], { hasMore: true, nextCursor: CURSOR })).success).toBe(
      true,
    );
    // An empty final page is the honest end of a continuation or a read that matched nothing.
    expect(schema.safeParse(page([], { hasMore: false })).success).toBe(true);
  });

  it("a search match range stays inside its snippet and never overlaps the one before", () => {
    const withRanges = (matchRanges: { start: number; end: number }[]) => ({
      matchCount: 2,
      hits: [{ ...searchHit, matchRanges }],
      hasMore: false,
    });
    expect(
      TranscriptSearchResponseSchema.safeParse(withRanges([{ start: 28, end: 34 }])).success,
    ).toBe(false);
    expect(
      TranscriptSearchResponseSchema.safeParse(
        withRanges([
          { start: 4, end: 10 },
          { start: 8, end: 10 },
        ]),
      ).success,
    ).toBe(false);
    expect(
      TranscriptSearchResponseSchema.safeParse(withRanges([{ start: 4, end: 10 }])).success,
    ).toBe(true);
  });
});

describe("a reply fits one frame", () => {
  // A unit `JSON.stringify` escapes to six bytes: the true worst case, admissible because
  // `wireFreeFormString` bans only NUL and whitespace-only strings.
  const worstCaseUnit = "\u0001";
  const worstCaseRow = {
    ...runScopedRow,
    id: worstCaseUnit.repeat(EVENT_FIELD_MAX_LEN),
    type: worstCaseUnit.repeat(EVENT_FIELD_MAX_LEN),
    actor: worstCaseUnit.repeat(EVENT_FIELD_MAX_LEN),
    summary: worstCaseUnit.repeat(TRANSCRIPT_EVENT_ROW_SUMMARY_MAX_LEN),
    childRunSummary,
    superseded: { targetPosition: 1 },
  };
  const worstCasePage = Array.from({ length: TRANSCRIPT_READ_LIMIT_MAX }, (_unused, index) => ({
    ...worstCaseRow,
    sequence: index,
  }));

  it("the byte budget, not the row cap, bounds a window that fits the framer", () => {
    // Every field is at its own bound, so this page is contract-valid on every axis but size.
    expect(jsonUtf8ByteLength(worstCasePage)).toBeGreaterThan(TRANSCRIPT_PAGE_MAX_BYTES);
    expect(
      TranscriptReadResponseSchema.safeParse({ entries: worstCasePage, hasMore: false }).success,
    ).toBe(false);

    const fitted = countEntriesFittingOneFrame(worstCasePage, TRANSCRIPT_READ_LIMIT_MAX);
    expect(fitted).toBeGreaterThan(0);
    expect(fitted).toBeLessThan(TRANSCRIPT_READ_LIMIT_MAX);
    // The producer and the validator agree: the fitted page parses and one row more does not.
    const page = worstCasePage.slice(0, fitted);
    expect(
      TranscriptReadResponseSchema.safeParse({ entries: page, hasMore: true, nextCursor: CURSOR })
        .success,
    ).toBe(true);
    expect(
      TranscriptReadResponseSchema.safeParse({
        entries: worstCasePage.slice(0, fitted + 1),
        hasMore: true,
        nextCursor: CURSOR,
      }).success,
    ).toBe(false);

    // The whole JSON-RPC envelope, with a maximal cursor and a maximal echoed id, stays under the
    // framer's cap.
    const maximalCursor = worstCaseUnit.repeat(EVENT_CURSOR_MAX_LEN);
    const frameBody = {
      jsonrpc: "2.0",
      id: maximalCursor,
      result: { entries: page, hasMore: true, nextCursor: maximalCursor },
    };
    expect(jsonUtf8ByteLength(frameBody)).toBeLessThan(MAX_MESSAGE_BYTES);
  });

  // Parses a frame-sized payload on purpose: well under a second bare, past the 5 s default
  // under coverage instrumentation.
  it(
    "the same budget bounds the expansion, the reasoning surface and a body",
    { timeout: 60_000 },
    () => {
      expect(
        ChildRunExpandResponseSchema.safeParse(childExpansion({ entries: worstCasePage })).success,
      ).toBe(false);

      const worstCaseEntries = Array.from(
        { length: REASONING_SURFACE_ENTRIES_MAX },
        (_unused, index) => ({
          sequence: index,
          content: worstCaseUnit.repeat(REASONING_ENTRY_CONTENT_MAX_LEN),
          timestamp: TIMESTAMP,
        }),
      );
      expect(jsonUtf8ByteLength(worstCaseEntries)).toBeGreaterThan(TRANSCRIPT_PAGE_MAX_BYTES);
      expect(
        ReasoningSurfaceReadResponseSchema.safeParse(
          reasoningPage({ reasoningEntries: worstCaseEntries }),
        ).success,
      ).toBe(false);
      const fitted = countEntriesFittingOneFrame(worstCaseEntries, REASONING_SURFACE_ENTRIES_MAX);
      expect(fitted).toBeGreaterThan(0);
      expect(
        ReasoningSurfaceReadResponseSchema.safeParse(
          reasoningPage({
            reasoningEntries: worstCaseEntries.slice(0, fitted),
            hasMore: true,
            nextCursor: CURSOR,
          }),
        ).success,
      ).toBe(true);

      // A body whose JSON form is over one frame while its length is not.
      const overFrameBody = worstCaseUnit.repeat(Math.ceil(TRANSCRIPT_PAGE_MAX_BYTES / 6) + 1);
      expectRefusedAt(
        TranscriptBodyReadResponseSchema,
        { status: "available", body: overFrameBody },
        "body",
      );
      expect(
        TranscriptBodyReadResponseSchema.safeParse({
          status: "available",
          body: "the whole output",
        }).success,
      ).toBe(true);
    },
  );

  it("the measure counts UTF-8 bytes of the JSON encoding and never throws", () => {
    // Each figure includes the two quotes.
    expect(jsonUtf8ByteLength("a")).toBe(3);
    expect(jsonUtf8ByteLength("é")).toBe(4);
    expect(jsonUtf8ByteLength("☃")).toBe(5);
    expect(jsonUtf8ByteLength("🙂")).toBe(6);
    expect(jsonUtf8ByteLength("\u0001")).toBe(8);
    // Unserializable measures as infinitely large, so a refinement reports an issue instead of
    // escaping `.parse()` as an exception.
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(jsonUtf8ByteLength(cyclic)).toBe(Number.POSITIVE_INFINITY);
    expect(jsonUtf8ByteLength(1n)).toBe(Number.POSITIVE_INFINITY);
  });

  it("the fitting function honors the count cap and pages an oversized first row alone", () => {
    const smallRow = { ...runScopedRow, sequence: 1 };
    expect(countEntriesFittingOneFrame([smallRow, smallRow], TRANSCRIPT_READ_LIMIT_MAX)).toBe(2);
    expect(countEntriesFittingOneFrame([smallRow, smallRow], 1)).toBe(1);
    expect(countEntriesFittingOneFrame([], TRANSCRIPT_READ_LIMIT_MAX)).toBe(0);
    expect(countEntriesFittingOneFrame([smallRow], 0)).toBe(0);
    // Returning zero for a row that alone exceeds the budget would leave an empty page beside an
    // unconsumed cursor, a continuation that never advances.
    const unfittableRow = {
      ...runScopedRow,
      payload: { blob: "x".repeat(TRANSCRIPT_PAGE_MAX_BYTES) },
    };
    expect(countEntriesFittingOneFrame([unfittableRow], TRANSCRIPT_READ_LIMIT_MAX)).toBe(1);
    // That single-row page is still refused at the boundary, never put on the wire.
    expectRefusedAt(
      TranscriptReadResponseSchema,
      { entries: [unfittableRow], hasMore: false },
      "entries",
    );
  });
});
