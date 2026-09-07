// Plan-004 T1.1–T1.3, T1.6, T1.7 plus the three CP-004-3 shapes no Phase-1
// task names — the `runControl.ts` contract surface: queue items, the
// intervention request union, the state-split intervention response, the
// run-state change event, the forward rolled-back event, the pause/resume
// triggers, the two `run.subscribe*` request shapes, and the run-read
// accessor shape.
//
// Backstops `Spec-004 §Interfaces And Contracts` and the invariants these
// contracts carry:
//   • I-004-4 — the MANDATORY `expectedRunVersion` comparand. Every arm of
//     the intervention union is pinned to reject its absence, so the
//     stale-replay guard cannot be bypassed by omitting the field.
//   • I-004-7 — the same guard extended to the orchestration-layer pause and
//     resume verbs, which hold no `InterventionType` membership.
//   • I-004-20 / I-004-21 — the settlement-time boundary reclassification and
//     the committed-then-failed composite. Both are pinned through the shapes
//     that make them legible: `newestBoundaryPosition` required-and-nullable,
//     and `resendDisposition` REQUIRED on the composite-only arm.
//
// Coverage shape:
//   • Every member of every enum parses and an out-of-set value is rejected,
//     so each pin is a real accept/reject boundary rather than a one-sided
//     smoke test.
//   • The `InterventionRequestPayload` union is driven against the IMPORTED
//     `InterventionType`, so a widening of that Plan-005-owned union without a
//     matching arm here fails at compile time rather than at a consumer.
//   • Every parse refusal the contract claims is exercised WITH its positive
//     control: a class-crossing `resendDisposition`, a disposition-less
//     terminal, a state/disposition mismatch, a `result` on a non-disposition
//     state, a `rejected` response with no cause, and a rollback whose
//     `targetPosition` is a float or negative.
//   • `ExecutionPosture` is validated through the module-private parser this
//     module composes over the Plan-005-owned type — both network arms against
//     both mode arms, plus the two shapes the intersection forbids.
//   • The three canonical `RunStateChangeEvent` members this module cannot yet
//     type (`agentId`, `linkType`, `effectiveRunConfig`) are pinned as
//     REJECTED, so their absence is a recorded decision rather than a silent
//     gap a producer could stumble into.
//   • The two arms of the `run.subscribeState` stream are pinned AGAINST
//     EACH OTHER: the stream carries no wire tag, so each schema is shown to
//     reject the other's well-formed payload — the property that makes one
//     untagged stream safe to parse.
//   • The two `run.subscribe*` request shapes are pinned against the two
//     members a copy of a neighbouring subscribe shape would bring with it: a
//     `runId` filter (the subscription is session-scoped and fans out per run
//     client-side) and a replay cursor (`run.*` is local-IPC JSON-RPC, so no
//     `Last-Event-ID` is injected pre-validation).
//   • The `index.ts` barrel re-exports every symbol this task provides — the
//     barrel-gap regression Plan-001 GitHub PR-#30 round-1 caught.
import { describe, expect, it } from "vitest";

import * as contracts from "../index.js";
import type { InterventionType } from "../provider-driver.js";
import { RECOVERY_CONDITIONS, RECOVERY_SPAN_CLASSIFICATIONS } from "../provider-driver.js";
import {
  InterventionRequestPayloadSchema,
  InterventionRequestResponseSchema,
  InterventionStateSchema,
  QueueItemCancelRequestSchema,
  QueueItemCancelResponseSchema,
  QueueItemCreateRequestSchema,
  QueueItemCreateResponseSchema,
  QueueItemListRequestSchema,
  QueueItemListResponseSchema,
  QueueItemStateSchema,
  QueueItemSummarySchema,
  RollbackAppliedResultSchema,
  RollbackCompositeRejectionGuardSchema,
  RollbackDegradedResultSchema,
  RollbackInterventionResultSchema,
  RunControlAckSchema,
  RunFailureCategorySchema,
  RunPauseRequestSchema,
  RunQueueSubscribeRequestSchema,
  RunReadSnapshotSchema,
  RunResumeRequestSchema,
  RunRolledBackEventSchema,
  RunStateChangeEventSchema,
  RunStateSchema,
  RunStateSubscribeRequestSchema,
  type InterventionState,
  type QueueItemState,
  type RunFailureCategory,
  type RunState,
} from "../runControl.js";

const SESSION_ID = "0f2b4d5e-1111-4111-8111-111111111111";
const CHANNEL_ID = "0f2b4d5e-2222-4222-8222-222222222222";
const WORKSPACE_ID = "0f2b4d5e-3333-4333-8333-333333333333";
const QUEUE_ITEM_ID = "0f2b4d5e-4444-4444-8444-444444444444";
const INTERVENTION_ID = "0f2b4d5e-5555-4555-8555-555555555555";
const RUN_ID = "0f2b4d5e-6666-4666-8666-666666666666";
const PARENT_RUN_ID = "0f2b4d5e-7777-4777-8777-777777777777";
const NODE_ID = "0f2b4d5e-8888-4888-8888-888888888888";
const IDEMPOTENCY_KEY = "0f2b4d5e-9999-4999-8999-999999999999";
const TIMESTAMP = "2026-08-31T12:00:00.000Z";

// --------------------------------------------------------------------------
// Shared enums
// --------------------------------------------------------------------------

describe("run-control shared enums", () => {
  const queueItemStates: ReadonlyArray<QueueItemState> = [
    "queued",
    "admitted",
    "superseded",
    "canceled",
    "expired",
  ];
  it.each(queueItemStates)("admits the queue-item state %s", (state) => {
    expect(QueueItemStateSchema.parse(state)).toBe(state);
  });

  it("rejects a queue-item state outside the five", () => {
    // The British spelling is the realistic drift, not a random string.
    expect(() => QueueItemStateSchema.parse("cancelled")).toThrow();
  });

  const interventionStates: ReadonlyArray<InterventionState> = [
    "requested",
    "accepted",
    "applied",
    "rejected",
    "degraded",
    "expired",
  ];
  it.each(interventionStates)("admits the intervention state %s", (state) => {
    expect(InterventionStateSchema.parse(state)).toBe(state);
  });

  it("rejects an intervention state outside the six", () => {
    expect(() => InterventionStateSchema.parse("partially-applied")).toThrow();
  });

  const runStates: ReadonlyArray<RunState> = [
    "queued",
    "starting",
    "running",
    "waiting_for_approval",
    "waiting_for_input",
    "paused",
    "completed",
    "interrupted",
    "failed",
  ];
  it.each(runStates)("admits the run state %s", (state) => {
    expect(RunStateSchema.parse(state)).toBe(state);
  });

  it("rejects a run state outside the nine", () => {
    expect(() => RunStateSchema.parse("cancelled")).toThrow();
  });

  const failureCategories: ReadonlyArray<RunFailureCategory> = [
    "provider failure",
    "transport failure",
    "local persistence failure",
    "projection failure",
  ];
  it.each(failureCategories)("admits the space-containing wire literal %s", (category) => {
    // The space is the contract. A kebab- or snake-cased variant is exactly
    // the drift this pin exists to catch.
    expect(RunFailureCategorySchema.parse(category)).toBe(category);
  });

  it("rejects a normalized spelling of a failure category", () => {
    expect(() => RunFailureCategorySchema.parse("provider_failure")).toThrow();
    expect(() => RunFailureCategorySchema.parse("provider-failure")).toThrow();
  });
});

// --------------------------------------------------------------------------
// T1.1 — Queue item contracts
// --------------------------------------------------------------------------

describe("QueueItemCreateRequest", () => {
  const minimal = { sessionId: SESSION_ID, payload: {} };

  it("parses with only the two required members", () => {
    expect(QueueItemCreateRequestSchema.parse(minimal)).toEqual(minimal);
  });

  it("parses with every optional member supplied", () => {
    const full = {
      sessionId: SESSION_ID,
      channelId: CHANNEL_ID,
      workspaceId: WORKSPACE_ID,
      priority: 7,
      payload: { kind: "user-send", position: 4 },
    };
    expect(QueueItemCreateRequestSchema.parse(full)).toEqual(full);
  });

  it("admits a negative priority and refuses a fractional one", () => {
    // "higher = more urgent", so a negative priority is a meaningful
    // de-prioritization; a float would round on the way into the INTEGER
    // column and silently reorder the drain.
    expect(QueueItemCreateRequestSchema.parse({ ...minimal, priority: -5 }).priority).toBe(-5);
    expect(() => QueueItemCreateRequestSchema.parse({ ...minimal, priority: 1.5 })).toThrow();
  });

  it("refuses a missing payload, a non-UUID session id, and an unknown key", () => {
    expect(() => QueueItemCreateRequestSchema.parse({ sessionId: SESSION_ID })).toThrow();
    expect(() => QueueItemCreateRequestSchema.parse({ ...minimal, sessionId: "s-1" })).toThrow();
    expect(() => QueueItemCreateRequestSchema.parse({ ...minimal, targetRunId: RUN_ID })).toThrow();
  });
});

describe("QueueItemCreateResponse", () => {
  const valid = { queueItemId: QUEUE_ITEM_ID, state: "queued", createdAt: TIMESTAMP };

  it("parses a well-formed response", () => {
    expect(QueueItemCreateResponseSchema.parse(valid)).toEqual(valid);
  });

  it("refuses a timestamp without an offset and an out-of-set state", () => {
    expect(() =>
      QueueItemCreateResponseSchema.parse({ ...valid, createdAt: "2026-08-31 12:00:00" }),
    ).toThrow();
    expect(() => QueueItemCreateResponseSchema.parse({ ...valid, state: "draining" })).toThrow();
  });
});

describe("QueueItemList", () => {
  it("parses the request with and without its two filters", () => {
    expect(QueueItemListRequestSchema.parse({ sessionId: SESSION_ID })).toEqual({
      sessionId: SESSION_ID,
    });
    const filtered = { sessionId: SESSION_ID, state: "admitted", channelId: CHANNEL_ID };
    expect(QueueItemListRequestSchema.parse(filtered)).toEqual(filtered);
  });

  it("refuses an unknown filter rather than silently ignoring it", () => {
    // A dropped filter would return MORE rows than the caller asked for, which
    // is the failure a permissive shape makes invisible.
    expect(() =>
      QueueItemListRequestSchema.parse({ sessionId: SESSION_ID, priority: 1 }),
    ).toThrow();
  });

  it("parses a response whose items carry every summary member", () => {
    const response = {
      items: [
        {
          id: QUEUE_ITEM_ID,
          state: "queued",
          priority: 0,
          channelId: CHANNEL_ID,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        },
      ],
    };
    expect(QueueItemListResponseSchema.parse(response)).toEqual(response);
    expect(QueueItemListResponseSchema.parse({ items: [] })).toEqual({ items: [] });
  });

  it("propagates summary strictness through the array", () => {
    const summary = {
      id: QUEUE_ITEM_ID,
      state: "queued",
      priority: 0,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    };
    // Positive control: the summary itself is valid, so the array refusal
    // below is the smuggled key and not a malformed fixture.
    expect(QueueItemSummarySchema.parse(summary)).toEqual(summary);
    expect(() =>
      QueueItemListResponseSchema.parse({ items: [{ ...summary, payload: {} }] }),
    ).toThrow();
  });
});

describe("QueueItemCancel", () => {
  it("parses the request and closes the response state at the single terminal", () => {
    expect(QueueItemCancelRequestSchema.parse({ queueItemId: QUEUE_ITEM_ID })).toEqual({
      queueItemId: QUEUE_ITEM_ID,
    });
    const response = { queueItemId: QUEUE_ITEM_ID, state: "canceled" };
    expect(QueueItemCancelResponseSchema.parse(response)).toEqual(response);
    // A cancel that reports any other lifecycle state is reporting an outcome
    // it did not produce.
    expect(() =>
      QueueItemCancelResponseSchema.parse({ queueItemId: QUEUE_ITEM_ID, state: "expired" }),
    ).toThrow();
  });
});

// --------------------------------------------------------------------------
// T1.2 — InterventionRequestPayload
// --------------------------------------------------------------------------

const guards = {
  targetRunId: RUN_ID,
  expectedRunVersion: 4,
  clientIdempotencyKey: IDEMPOTENCY_KEY,
} as const;

describe("InterventionRequestPayload", () => {
  // Driven against the IMPORTED Plan-005-owned union through an exhaustive
  // keyed record: a member added there without an arm here is a missing
  // property (TS2739), so the drift guard fails at compile time rather than
  // silently shrinking coverage (an array of union members would still
  // compile with an arm missing).
  const armPayloads: Record<InterventionType, Record<string, unknown>> = {
    steer: { ...guards, type: "steer", content: "please use the async client" },
    interrupt: { ...guards, type: "interrupt", reason: "wrong branch" },
    cancel: { ...guards, type: "cancel" },
    rollback: { ...guards, type: "rollback", targetPosition: 12 },
  };
  const arms: ReadonlyArray<[InterventionType, Record<string, unknown>]> = (
    Object.entries(armPayloads) as Array<[InterventionType, Record<string, unknown>]>
  ).map(([armType, payload]) => [armType, payload]);

  it.each(arms)("round-trips the %s arm", (_type, payload) => {
    expect(InterventionRequestPayloadSchema.parse(payload)).toEqual(payload);
  });

  it.each(arms)("refuses the %s arm without its mandatory comparand", (_type, payload) => {
    // I-004-4. An optional comparand would let a caller bypass the
    // stale-replay guard by omitting it, so absence must refuse on EVERY arm.
    const { expectedRunVersion: _omitted, ...withoutComparand } = payload;
    expect(() => InterventionRequestPayloadSchema.parse(withoutComparand)).toThrow();
  });

  it.each(arms)("refuses the %s arm without its idempotency key", (_type, payload) => {
    const { clientIdempotencyKey: _omitted, ...withoutKey } = payload;
    expect(() => InterventionRequestPayloadSchema.parse(withoutKey)).toThrow();
  });

  it("refuses a non-UUID idempotency key", () => {
    // The key lands in a durable receipt under a UNIQUE constraint; an
    // unbounded caller-chosen string would make replay keying depend on client
    // discipline.
    expect(() =>
      InterventionRequestPayloadSchema.parse({
        ...guards,
        type: "cancel",
        clientIdempotencyKey: "k1",
      }),
    ).toThrow();
  });

  it("refuses a fractional or negative expectedRunVersion", () => {
    expect(() =>
      InterventionRequestPayloadSchema.parse({
        ...guards,
        type: "cancel",
        expectedRunVersion: 1.5,
      }),
    ).toThrow();
    expect(() =>
      InterventionRequestPayloadSchema.parse({ ...guards, type: "cancel", expectedRunVersion: -1 }),
    ).toThrow();
  });

  it("refuses an unknown intervention type and an unknown member on a known arm", () => {
    expect(() =>
      InterventionRequestPayloadSchema.parse({ ...guards, type: "rewind", targetPosition: 1 }),
    ).toThrow();
    expect(() =>
      InterventionRequestPayloadSchema.parse({ ...guards, type: "cancel", targetPosition: 1 }),
    ).toThrow();
  });

  it("bounds the steer body against empty, whitespace-only, and NUL content", () => {
    const steer = { ...guards, type: "steer" };
    expect(() => InterventionRequestPayloadSchema.parse({ ...steer, content: "" })).toThrow();
    expect(() => InterventionRequestPayloadSchema.parse({ ...steer, content: "   " })).toThrow();
    expect(() => InterventionRequestPayloadSchema.parse({ ...steer, content: "a\0b" })).toThrow();
    // Positive control: an ordinary body still parses.
    expect(InterventionRequestPayloadSchema.parse({ ...steer, content: "retry with -v" })).toEqual({
      ...steer,
      content: "retry with -v",
    });
  });

  it("carries the steer attachments and expectedTurnId members", () => {
    const payload = {
      ...guards,
      type: "steer",
      content: "see the attached trace",
      attachments: [{ kind: "blob" }],
      expectedTurnId: "turn-19",
    };
    expect(InterventionRequestPayloadSchema.parse(payload)).toEqual(payload);
  });

  describe("the rollback arm", () => {
    const rollback = { ...guards, type: "rollback" };

    it("admits position zero and refuses a fractional or negative position", () => {
      // Position 0 is a legitimate rewind target — the run's first boundary.
      // Whether the position names a RECORDED boundary strictly below the
      // run's current position is a daemon admission check against durable
      // state, deliberately not a parse concern.
      expect(InterventionRequestPayloadSchema.parse({ ...rollback, targetPosition: 0 })).toEqual({
        ...rollback,
        targetPosition: 0,
      });
      expect(() =>
        InterventionRequestPayloadSchema.parse({ ...rollback, targetPosition: 2.5 }),
      ).toThrow();
      expect(() =>
        InterventionRequestPayloadSchema.parse({ ...rollback, targetPosition: -1 }),
      ).toThrow();
    });

    it("treats an absent replacementSend as an ordinary bare rollback", () => {
      const bare = { ...rollback, targetPosition: 9 };
      expect(InterventionRequestPayloadSchema.parse(bare)).toEqual(bare);
      expect("replacementSend" in InterventionRequestPayloadSchema.parse(bare)).toBe(false);
    });

    it("selects the composite on presence alone and bounds its body", () => {
      const composite = {
        ...rollback,
        targetPosition: 9,
        replacementSend: { content: "the corrected message" },
      };
      expect(InterventionRequestPayloadSchema.parse(composite)).toEqual(composite);
      expect(() =>
        InterventionRequestPayloadSchema.parse({
          ...rollback,
          targetPosition: 9,
          replacementSend: { content: "" },
        }),
      ).toThrow();
    });

    it("refuses an attachment member on replacementSend", () => {
      // No attachment member in V1: the leg replaces a participant message body
      // and nothing else, so an unregistered field must fail closed rather than
      // be silently dropped.
      expect(() =>
        InterventionRequestPayloadSchema.parse({
          ...rollback,
          targetPosition: 9,
          replacementSend: { content: "corrected", attachments: [] },
        }),
      ).toThrow();
    });
  });
});

// --------------------------------------------------------------------------
// T1.3 — Rollback result vocabulary
// --------------------------------------------------------------------------

const RESTORED_ENUMERATIONS = {
  overwrittenIgnoredPaths: ["build/out.js"],
  divergentGitlinks: ["vendor/lib"],
} as const;

describe("RollbackAppliedResult", () => {
  it("round-trips both applied dispositions, bare and with the admitted literal", () => {
    for (const bare of [
      { disposition: "files-restored", ...RESTORED_ENUMERATIONS },
      { disposition: "conversation-only" },
    ]) {
      expect(RollbackAppliedResultSchema.parse(bare)).toEqual(bare);
      const composite = { ...bare, resendDisposition: "admitted" };
      expect(RollbackAppliedResultSchema.parse(composite)).toEqual(composite);
    }
  });

  it("requires both never-silent enumerations on files-restored", () => {
    // Spec-010's turn-boundary snapshot mandate: absence is a parse failure, so
    // a consumer can never mistake absence for none.
    expect(() => RollbackAppliedResultSchema.parse({ disposition: "files-restored" })).toThrow();
    expect(() =>
      RollbackAppliedResultSchema.parse({
        disposition: "files-restored",
        overwrittenIgnoredPaths: [],
      }),
    ).toThrow();
    // Empty-when-none is the legal shape, and is what makes absence meaningful.
    expect(
      RollbackAppliedResultSchema.parse({
        disposition: "files-restored",
        overwrittenIgnoredPaths: [],
        divergentGitlinks: [],
      }),
    ).toEqual({
      disposition: "files-restored",
      overwrittenIgnoredPaths: [],
      divergentGitlinks: [],
    });
  });

  it("refuses the degraded class and the degraded resend literal", () => {
    expect(() => RollbackAppliedResultSchema.parse({ disposition: "pause-only" })).toThrow();
    expect(() =>
      RollbackAppliedResultSchema.parse({
        disposition: "conversation-only",
        resendDisposition: "unapplied",
      }),
    ).toThrow();
  });

  it("refuses a path carrying a NUL byte", () => {
    expect(() =>
      RollbackAppliedResultSchema.parse({
        disposition: "files-restored",
        overwrittenIgnoredPaths: ["build/\0out.js"],
        divergentGitlinks: [],
      }),
    ).toThrow();
    // Positive control: a path that is entirely whitespace is LEGAL on POSIX
    // and must still parse — the enumerations are not free-form wire prose.
    expect(
      RollbackAppliedResultSchema.parse({
        disposition: "files-restored",
        overwrittenIgnoredPaths: [" "],
        divergentGitlinks: [],
      }).disposition,
    ).toBe("files-restored");
  });
});

describe("RollbackDegradedResult", () => {
  const degradedArms: ReadonlyArray<Record<string, unknown>> = [
    { disposition: "files-partially-restored", failedStep: "read-tree", ...RESTORED_ENUMERATIONS },
    { disposition: "files-unrestored" },
    { disposition: "pause-only" },
    { disposition: "nothing-applied" },
    { disposition: "position-mismatch", requestedPosition: 12, confirmedPosition: 9 },
    { disposition: "boundary-diverged", confirmedPosition: 9, newestBoundaryPosition: 11 },
    { disposition: "resend-unapplied", resendDisposition: "unapplied", ...RESTORED_ENUMERATIONS },
  ];

  it.each(degradedArms)("round-trips %o", (arm) => {
    expect(RollbackDegradedResultSchema.parse(arm)).toEqual(arm);
  });

  it("carries the seven dispositions and no more", () => {
    // Re-derived by counting the arms above rather than asserted.
    expect(degradedArms).toHaveLength(7);
    expect(() => RollbackDegradedResultSchema.parse({ disposition: "files-restored" })).toThrow();
  });

  it("requires resendDisposition on the composite-only arm and nowhere else", () => {
    // The arm is reachable only from a composite request, so unlike every other
    // outcome its result DOES identify its request as composite — which is what
    // makes requiredness expressible here alone.
    expect(() =>
      RollbackDegradedResultSchema.parse({
        disposition: "resend-unapplied",
        ...RESTORED_ENUMERATIONS,
      }),
    ).toThrow();
    // ...while pause-only parses without it.
    expect(RollbackDegradedResultSchema.parse({ disposition: "pause-only" })).toEqual({
      disposition: "pause-only",
    });
  });

  it("requires files-restored's two enumerations on the composite-only arm", () => {
    // The arm DISPLACES a completed file leg, so dropping them would silence a
    // restore that did mutate the tree.
    expect(() =>
      RollbackDegradedResultSchema.parse({
        disposition: "resend-unapplied",
        resendDisposition: "unapplied",
      }),
    ).toThrow();
  });

  it("takes newestBoundaryPosition as required-and-nullable, never optional", () => {
    // `null` states the position-less-compaction-row cause; an ABSENT member
    // could not be distinguished from a producer that forgot to populate it.
    expect(
      RollbackDegradedResultSchema.parse({
        disposition: "boundary-diverged",
        confirmedPosition: 9,
        newestBoundaryPosition: null,
      }),
    ).toEqual({
      disposition: "boundary-diverged",
      confirmedPosition: 9,
      newestBoundaryPosition: null,
    });
    expect(() =>
      RollbackDegradedResultSchema.parse({
        disposition: "boundary-diverged",
        confirmedPosition: 9,
      }),
    ).toThrow();
  });

  it("refuses the applied class and the applied resend literal", () => {
    expect(() =>
      RollbackDegradedResultSchema.parse({ disposition: "conversation-only" }),
    ).toThrow();
    expect(() =>
      RollbackDegradedResultSchema.parse({
        disposition: "pause-only",
        resendDisposition: "admitted",
      }),
    ).toThrow();
  });

  it("refuses an unknown disposition", () => {
    expect(() =>
      RollbackDegradedResultSchema.parse({ disposition: "files-half-restored" }),
    ).toThrow();
  });
});

describe("RollbackInterventionResult", () => {
  it("admits both classes through the composed union", () => {
    expect(RollbackInterventionResultSchema.parse({ disposition: "conversation-only" })).toEqual({
      disposition: "conversation-only",
    });
    expect(RollbackInterventionResultSchema.parse({ disposition: "pause-only" })).toEqual({
      disposition: "pause-only",
    });
  });

  it("still refuses a class-crossing resend literal through the union", () => {
    // The union is where a naive composition would lose the state-scoping, so
    // this is the pin that matters most on the composed shape.
    expect(() =>
      RollbackInterventionResultSchema.parse({
        disposition: "pause-only",
        resendDisposition: "admitted",
      }),
    ).toThrow();
  });
});

// --------------------------------------------------------------------------
// T1.3 — InterventionRequestResponse
// --------------------------------------------------------------------------

const responseBase = {
  interventionId: INTERVENTION_ID,
  runVersion: 5,
} as const;

describe("InterventionRequestResponse", () => {
  it("parses an applied rollback carrying an applied-class disposition", () => {
    const response = {
      ...responseBase,
      interventionType: "rollback",
      state: "applied",
      result: { disposition: "files-restored", ...RESTORED_ENUMERATIONS },
    };
    expect(InterventionRequestResponseSchema.parse(response)).toEqual(response);
  });

  it("parses a degraded rollback carrying a degraded-class disposition", () => {
    const response = {
      ...responseBase,
      interventionType: "rollback",
      state: "degraded",
      result: {
        disposition: "boundary-diverged",
        confirmedPosition: 9,
        newestBoundaryPosition: null,
      },
    };
    expect(InterventionRequestResponseSchema.parse(response)).toEqual(response);
  });

  it("refuses a state/disposition mismatch in both directions", () => {
    // `applied` + `files-unrestored` would exit-map 0 while rendering a failed
    // restore, because the CLI derives the POSIX code from `state`.
    expect(() =>
      InterventionRequestResponseSchema.parse({
        ...responseBase,
        interventionType: "rollback",
        state: "applied",
        result: { disposition: "files-unrestored" },
      }),
    ).toThrow();
    expect(() =>
      InterventionRequestResponseSchema.parse({
        ...responseBase,
        interventionType: "rollback",
        state: "degraded",
        result: { disposition: "conversation-only" },
      }),
    ).toThrow();
  });

  it("refuses a disposition-less terminal rollback response", () => {
    for (const state of ["applied", "degraded"]) {
      expect(() =>
        InterventionRequestResponseSchema.parse({
          ...responseBase,
          interventionType: "rollback",
          state,
        }),
      ).toThrow();
    }
  });

  it("requires the machine-readable cause on a rejected rollback", () => {
    expect(() =>
      InterventionRequestResponseSchema.parse({
        ...responseBase,
        interventionType: "rollback",
        state: "rejected",
      }),
    ).toThrow();
    const rejected = {
      ...responseBase,
      interventionType: "rollback",
      state: "rejected",
      rejectionReason: "driver.capability_unsupported",
    };
    expect(InterventionRequestResponseSchema.parse(rejected)).toEqual(rejected);
  });

  describe("the rejectionGuard member", () => {
    // The composite's four structural refusal guards, typed so a renderer maps
    // guard -> remedy by an exhaustive switch. `rejectionReason` is a
    // machine-readable cause and not prose (see the module comment), but its
    // vocabulary is OPEN — `error-contracts.md` §Intervention registers no code
    // for an intervention outcome — so it can be shown and not switched on.
    // Every fixture below therefore carries an identifier, never a sentence.
    const guards = [
      "no-active-turn",
      "no-pending-send",
      "participant-authored-target",
      "resumable-target",
    ] as const;

    it.each(guards)("admits %s beside the rejection reason", (guard) => {
      const rejected = {
        ...responseBase,
        interventionType: "rollback",
        state: "rejected",
        rejectionReason: "run.invalid_transition",
        rejectionGuard: guard,
      };
      expect(InterventionRequestResponseSchema.parse(rejected)).toEqual(rejected);
      expect(RollbackCompositeRejectionGuardSchema.parse(guard)).toBe(guard);
    });

    it("is optional — a non-composite refusal carries none", () => {
      const rejected = {
        ...responseBase,
        interventionType: "rollback",
        state: "rejected",
        rejectionReason: "driver.capability_unsupported",
      };
      expect(InterventionRequestResponseSchema.parse(rejected)).toEqual(rejected);
    });

    it("refuses a guard value outside the closed four", () => {
      // Negative control: a free string would leave the member as open as the
      // cause vocabulary it exists to close.
      expect(() => RollbackCompositeRejectionGuardSchema.parse("no-active-run")).toThrow();
      expect(() =>
        InterventionRequestResponseSchema.parse({
          ...responseBase,
          interventionType: "rollback",
          state: "rejected",
          rejectionReason: "run.invalid_transition",
          rejectionGuard: "no-active-run",
        }),
      ).toThrow();
    });

    it("refuses the member on arms that can never raise a composite guard", () => {
      // Arm-scoped, not base-scoped: only a rollback request can be a
      // composite, and only a `rejected` rollback settles on a guard.
      expect(() =>
        InterventionRequestResponseSchema.parse({
          ...responseBase,
          interventionType: "steer",
          state: "rejected",
          rejectionReason: "run.invalid_transition",
          rejectionGuard: "no-active-turn",
        }),
      ).toThrow();
      expect(() =>
        InterventionRequestResponseSchema.parse({
          ...responseBase,
          interventionType: "rollback",
          state: "expired",
          rejectionGuard: "no-active-turn",
        }),
      ).toThrow();
    });
  });

  it("refuses a result on rejected and on the three non-disposition states", () => {
    expect(() =>
      InterventionRequestResponseSchema.parse({
        ...responseBase,
        interventionType: "rollback",
        state: "rejected",
        rejectionReason: "driver.capability_unsupported",
        result: { disposition: "nothing-applied" },
      }),
    ).toThrow();
    for (const state of ["requested", "accepted", "expired"]) {
      // Positive control: the state itself parses without a result.
      expect(
        InterventionRequestResponseSchema.parse({
          ...responseBase,
          interventionType: "rollback",
          state,
        }),
      ).toEqual({ ...responseBase, interventionType: "rollback", state });
      expect(() =>
        InterventionRequestResponseSchema.parse({
          ...responseBase,
          interventionType: "rollback",
          state,
          result: { disposition: "nothing-applied" },
        }),
      ).toThrow();
    }
  });

  it("carries the class-scoped resend literal on both terminal arms", () => {
    const applied = {
      ...responseBase,
      interventionType: "rollback",
      state: "applied",
      result: { disposition: "conversation-only", resendDisposition: "admitted" },
    };
    expect(InterventionRequestResponseSchema.parse(applied)).toEqual(applied);
    // ...and refuses the crossing one through the response seam, not merely on
    // the bare result schema.
    expect(() =>
      InterventionRequestResponseSchema.parse({
        ...applied,
        result: { disposition: "conversation-only", resendDisposition: "unapplied" },
      }),
    ).toThrow();
  });

  it("parses the three non-rollback types with a permissive result and without one", () => {
    for (const interventionType of ["steer", "interrupt", "cancel"]) {
      const bare = { ...responseBase, interventionType, state: "applied" };
      expect(InterventionRequestResponseSchema.parse(bare)).toEqual(bare);
      const withResult = { ...bare, result: { deliveredAt: TIMESTAMP } };
      expect(InterventionRequestResponseSchema.parse(withResult)).toEqual(withResult);
    }
  });

  it("refuses a rollback result smuggled onto a non-rollback response", () => {
    // The permissive generic arm is exactly where a malformed rollback outcome
    // would otherwise cross the boundary, so the discriminator is pinned first.
    expect(() =>
      InterventionRequestResponseSchema.parse({
        ...responseBase,
        interventionType: "steer",
        state: "applied",
        rollbackResult: { disposition: "conversation-only" },
      }),
    ).toThrow();
  });

  it("refuses an unknown interventionType", () => {
    expect(() =>
      InterventionRequestResponseSchema.parse({
        ...responseBase,
        interventionType: "rewind",
        state: "applied",
      }),
    ).toThrow();
  });
});

// --------------------------------------------------------------------------
// T1.3 — RunStateChangeEvent
// --------------------------------------------------------------------------

const minimalRunStateChange = {
  runId: RUN_ID,
  runVersion: 3,
  previousState: "running",
  currentState: "paused",
  timestamp: TIMESTAMP,
} as const;

describe("RunStateChangeEvent", () => {
  it("parses the five required members alone", () => {
    expect(RunStateChangeEventSchema.parse(minimalRunStateChange)).toEqual(minimalRunStateChange);
  });

  it("parses every optional member this module can type", () => {
    const full = {
      ...minimalRunStateChange,
      currentState: "failed",
      failureCategory: "provider failure",
      recoveryCondition: "reauth-required",
      recoverySpanClassification: "irreversible",
      healthSignal: "stuck-suspected",
      providerFailureDetail: "driver.text_neutralization_failed origin=participant_text",
      completionKind: "turn",
      intendedClose: true,
      executionPosture: { networkAccess: "none", writableRoots: ["/w"], mode: "trusted" },
      trigger: "workflow_phase_cancelled",
      parentRunId: PARENT_RUN_ID,
      internalHelper: false,
      producingNodeId: NODE_ID,
      admittedUnpricedCapCents: 500,
      admittedModelFamily: "claude-opus",
    };
    expect(RunStateChangeEventSchema.parse(full)).toEqual(full);
  });

  it("carries every member of both Plan-005 recovery vocabularies", () => {
    // Driven from the IMPORTED arrays, not from a list written out here, and
    // for the same reason the `InterventionType` fan-out above is: this module
    // is the second of the four surfaces `Plan-005 §Phase 4 — Client SDK exposure + degraded-fallback` T4.8 P3-4 binds to
    // REFERENCE the hoisted vocabularies rather than restate them. It used to
    // restate them, as two module-private `z.enum` mirrors, and the
    // `z.ZodType<T>` annotations that were said to hold those mirrors in
    // lockstep do not: `ZodType` is covariant in its output, so a mirror
    // NARROWER than the imported union compiles clean. A member added upstream
    // must reach this carrier, and if a mirror ever returns here it will not —
    // this test goes red instead of the member dead-lettering at parse.
    for (const recoveryCondition of RECOVERY_CONDITIONS) {
      for (const recoverySpanClassification of RECOVERY_SPAN_CLASSIFICATIONS) {
        const stateChange = {
          ...minimalRunStateChange,
          currentState: "failed",
          failureCategory: "provider failure",
          recoveryCondition,
          recoverySpanClassification,
        };
        expect(RunStateChangeEventSchema.parse(stateChange)).toEqual(stateChange);
      }
    }
  });

  it("keeps both recovery members OPTIONAL on this replay-visible projection", () => {
    // The asymmetry against the live `DriverResumeResult`, where both are
    // REQUIRED: optionality here exists only to admit pre-amendment history,
    // and importing the parsers did not quietly import their requiredness.
    expect(RunStateChangeEventSchema.parse(minimalRunStateChange)).toEqual(minimalRunStateChange);
  });

  it("rejects an off-union value on either recovery member", () => {
    // The negative control for the two loops above: referencing the hoisted
    // parsers did not widen this carrier into accepting free strings.
    for (const member of ["recoveryCondition", "recoverySpanClassification"] as const) {
      expect(
        RunStateChangeEventSchema.safeParse({
          ...minimalRunStateChange,
          currentState: "failed",
          [member]: "retry-later",
        }).success,
      ).toBe(false);
    }
  });

  it("closes intendedClose at the present-only discriminator", () => {
    // A `false` would read as "this terminal was a crash", which is a claim the
    // absent member deliberately does not make.
    expect(() =>
      RunStateChangeEventSchema.parse({ ...minimalRunStateChange, intendedClose: false }),
    ).toThrow();
  });

  it("refuses an unlisted stop-condition trigger", () => {
    expect(() =>
      RunStateChangeEventSchema.parse({ ...minimalRunStateChange, trigger: "user_cancelled" }),
    ).toThrow();
  });

  it("refuses the three orchestration-linkage members this module cannot type", () => {
    // `agentId`, `linkType`, and `effectiveRunConfig` are typed by Plan-016
    // symbols no TypeScript in this workspace declares. Their absence is a
    // recorded decision, so a producer that emits one must FAIL rather than
    // have it silently dropped — and the fix is to add them here, never to
    // relax the strict shape at a consumer.
    //
    // DELETE THIS CASE in the same diff that adds the three members. It asserts
    // a temporary gap, not designed behaviour: left standing, it is a passing
    // test that says the opposite of what the adding task needs.
    for (const smuggled of [
      { agentId: "agent-1" },
      { linkType: "spawn" },
      { effectiveRunConfig: { turnLimit: 8 } },
    ]) {
      expect(() =>
        RunStateChangeEventSchema.parse({ ...minimalRunStateChange, ...smuggled }),
      ).toThrow();
    }
    // The linkage members that CAN be typed are carried, so the refusals above
    // are the three named omissions and not a blanket rejection of the block.
    expect(
      RunStateChangeEventSchema.parse({
        ...minimalRunStateChange,
        parentRunId: PARENT_RUN_ID,
        internalHelper: true,
        producingNodeId: NODE_ID,
      }).parentRunId,
    ).toBe(PARENT_RUN_ID);
  });

  describe("the executionPosture member", () => {
    const base = { writableRoots: ["/workspace"] };

    it("admits both network arms against both mode arms", () => {
      const postures = [
        { ...base, networkAccess: "none", mode: "trusted" },
        { ...base, networkAccess: "full", mode: "trusted", profileName: "default" },
        {
          ...base,
          networkAccess: "full",
          mode: "workspace-sandboxed",
          credentialPolicyRef: "sha256:abc",
        },
        {
          ...base,
          networkAccess: "allowed-domains",
          allowedDomains: ["registry.npmjs.org"],
          mode: "trusted",
        },
        {
          ...base,
          networkAccess: "allowed-domains",
          allowedDomains: ["registry.npmjs.org"],
          mode: "readonly-sandboxed",
          credentialPolicyRef: "sha256:def",
        },
      ];
      for (const executionPosture of postures) {
        expect(
          RunStateChangeEventSchema.parse({ ...minimalRunStateChange, executionPosture }),
        ).toEqual({ ...minimalRunStateChange, executionPosture });
      }
    });

    it("refuses an empty allowed-domains list", () => {
      // The type is a NON-EMPTY tuple: an `allowed-domains` posture with no
      // domains permits nothing while claiming to permit something.
      expect(() =>
        RunStateChangeEventSchema.parse({
          ...minimalRunStateChange,
          executionPosture: {
            ...base,
            networkAccess: "allowed-domains",
            allowedDomains: [],
            mode: "trusted",
          },
        }),
      ).toThrow();
    });

    it("refuses a sandboxed mode without a credential policy reference", () => {
      expect(() =>
        RunStateChangeEventSchema.parse({
          ...minimalRunStateChange,
          executionPosture: { ...base, networkAccess: "none", mode: "workspace-sandboxed" },
        }),
      ).toThrow();
    });

    it("refuses a credential policy reference on the trusted mode", () => {
      expect(() =>
        RunStateChangeEventSchema.parse({
          ...minimalRunStateChange,
          executionPosture: {
            ...base,
            networkAccess: "none",
            mode: "trusted",
            credentialPolicyRef: "sha256:abc",
          },
        }),
      ).toThrow();
    });

    it("refuses an allowedDomains list on a non-allowed-domains posture", () => {
      expect(() =>
        RunStateChangeEventSchema.parse({
          ...minimalRunStateChange,
          executionPosture: {
            ...base,
            networkAccess: "full",
            allowedDomains: ["example.test"],
            mode: "trusted",
          },
        }),
      ).toThrow();
    });
  });
});

// --------------------------------------------------------------------------
// CP-004-3 — RunRolledBackEvent
// --------------------------------------------------------------------------

const minimalRolledBack = {
  sessionId: SESSION_ID,
  runId: RUN_ID,
  runVersion: 8,
  targetPosition: 5,
} as const;

describe("RunRolledBackEvent", () => {
  it("parses with and without the optional channel attribution", () => {
    expect(RunRolledBackEventSchema.parse(minimalRolledBack)).toEqual(minimalRolledBack);
    const channelScoped = { ...minimalRolledBack, channelId: CHANNEL_ID };
    expect(RunRolledBackEventSchema.parse(channelScoped)).toEqual(channelScoped);
  });

  it.each(["sessionId", "runId", "runVersion", "targetPosition"])(
    "refuses the event with no %s",
    (member) => {
      const incomplete: Record<string, unknown> = { ...minimalRolledBack };
      delete incomplete[member];
      expect(() => RunRolledBackEventSchema.parse(incomplete)).toThrow();
    },
  );

  it("admits a rewind to position zero and refuses a fractional or negative counter", () => {
    // Position 0 is the run's first boundary — a legitimate anchor, exactly as
    // on the request side. Both counters carry the same integer floor: a float
    // or a negative could never equal a recorded position or a stored run
    // version, so it would report a landing the run never made.
    expect(
      RunRolledBackEventSchema.parse({ ...minimalRolledBack, targetPosition: 0 }).targetPosition,
    ).toBe(0);
    for (const targetPosition of [2.5, -1]) {
      expect(() =>
        RunRolledBackEventSchema.parse({ ...minimalRolledBack, targetPosition }),
      ).toThrow();
    }
    for (const runVersion of [1.5, -1]) {
      expect(() => RunRolledBackEventSchema.parse({ ...minimalRolledBack, runVersion })).toThrow();
    }
  });

  it("refuses a non-UUID session, run, or channel id", () => {
    expect(() =>
      RunRolledBackEventSchema.parse({ ...minimalRolledBack, sessionId: "s-1" }),
    ).toThrow();
    expect(() => RunRolledBackEventSchema.parse({ ...minimalRolledBack, runId: "r-1" })).toThrow();
    expect(() =>
      RunRolledBackEventSchema.parse({ ...minimalRolledBack, channelId: "c-1" }),
    ).toThrow();
  });

  it("refuses a fabricated state transition", () => {
    // A rollback transitions no state. A producer pairing the rewind with a
    // synthesized previous/current pair would corrupt the transition stream
    // consumers replay, so the pair must fail parse rather than ride along.
    expect(() =>
      RunRolledBackEventSchema.parse({
        ...minimalRolledBack,
        previousState: "running",
        currentState: "paused",
      }),
    ).toThrow();
  });

  it("is disjoint from the state-change arm it shares run.subscribeState with", () => {
    // The stream carries no wire tag, so the two arms are told apart by shape
    // alone — which holds only while each REFUSES the other. Positive controls
    // first, so the two refusals are the crossing and not a malformed fixture.
    expect(RunRolledBackEventSchema.parse(minimalRolledBack)).toEqual(minimalRolledBack);
    expect(RunStateChangeEventSchema.parse(minimalRunStateChange)).toEqual(minimalRunStateChange);
    expect(() => RunStateChangeEventSchema.parse(minimalRolledBack)).toThrow();
    expect(() => RunRolledBackEventSchema.parse(minimalRunStateChange)).toThrow();
  });
});

// --------------------------------------------------------------------------
// T1.6 — Pause / resume triggers
// --------------------------------------------------------------------------

describe("run pause and resume", () => {
  const request = { targetRunId: RUN_ID, expectedRunVersion: 6 };

  it.each([
    ["RunPauseRequestSchema", RunPauseRequestSchema],
    ["RunResumeRequestSchema", RunResumeRequestSchema],
  ] as const)("%s round-trips its two members", (_name, schema) => {
    expect(schema.parse(request)).toEqual(request);
  });

  it.each([
    ["RunPauseRequestSchema", RunPauseRequestSchema],
    ["RunResumeRequestSchema", RunResumeRequestSchema],
  ] as const)("%s refuses a request with no comparand", (_name, schema) => {
    // I-004-7: D-004-2's guard extended to the orchestration-layer verbs, which
    // hold no InterventionType membership and so inherit nothing implicitly.
    expect(() => schema.parse({ targetRunId: RUN_ID })).toThrow();
  });

  it.each([
    ["RunPauseRequestSchema", RunPauseRequestSchema],
    ["RunResumeRequestSchema", RunResumeRequestSchema],
  ] as const)("%s refuses an intervention-shaped extra member", (_name, schema) => {
    expect(() => schema.parse({ ...request, type: "interrupt" })).toThrow();
  });

  it("acks with the post-transition state and the advanced comparand", () => {
    const ack = { runId: RUN_ID, currentState: "paused", runVersion: 7 };
    expect(RunControlAckSchema.parse(ack)).toEqual(ack);
    expect(() => RunControlAckSchema.parse({ ...ack, currentState: "pausing" })).toThrow();
    expect(() => RunControlAckSchema.parse({ runId: RUN_ID, currentState: "paused" })).toThrow();
  });
});

// --------------------------------------------------------------------------
// CP-004-3 — Subscription request shapes
// --------------------------------------------------------------------------

describe("run-control subscription requests", () => {
  const subscribeSchemas = [
    ["RunStateSubscribeRequestSchema", RunStateSubscribeRequestSchema],
    ["RunQueueSubscribeRequestSchema", RunQueueSubscribeRequestSchema],
  ] as const;

  it.each(subscribeSchemas)("%s round-trips its single member", (_name, schema) => {
    expect(schema.parse({ sessionId: SESSION_ID })).toEqual({ sessionId: SESSION_ID });
  });

  it.each(subscribeSchemas)("%s refuses an absent or non-UUID session id", (_name, schema) => {
    expect(() => schema.parse({})).toThrow();
    expect(() => schema.parse({ sessionId: "s-1" })).toThrow();
  });

  it.each(subscribeSchemas)("%s refuses a run-scoped filter member", (_name, schema) => {
    // The subscription is SESSION-scoped: the session is the authorization
    // unit and a subscriber fans out per run client-side. A silently dropped
    // `runId` would hand the caller every run of the session while reading as
    // a filter it asked for and got.
    expect(() => schema.parse({ sessionId: SESSION_ID, runId: RUN_ID })).toThrow();
  });

  it.each(subscribeSchemas)("%s refuses a replay-cursor member", (_name, schema) => {
    // `SessionSubscribeRequest` declares `afterCursor` / `lastEventId` because
    // its HTTP/SSE transport injects `Last-Event-ID` pre-validation. `run.*` is
    // local-IPC JSON-RPC, so neither member has a producer here and the
    // absence is a decision — copying the neighbouring shape must fail.
    expect(() => schema.parse({ sessionId: SESSION_ID, afterCursor: "0" })).toThrow();
    expect(() => schema.parse({ sessionId: SESSION_ID, lastEventId: "0" })).toThrow();
  });
});

// --------------------------------------------------------------------------
// T1.7 — Run-read accessor shape
// --------------------------------------------------------------------------

describe("RunReadSnapshot", () => {
  const snapshot = { version: 11, sessionId: SESSION_ID, state: "running" };

  it("carries the comparand, the owning session, and the run state", () => {
    expect(RunReadSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("refuses a snapshot missing the comparand the guard compares against", () => {
    expect(() =>
      RunReadSnapshotSchema.parse({ sessionId: SESSION_ID, state: "running" }),
    ).toThrow();
  });

  it("refuses an unknown member and an out-of-set state", () => {
    expect(() => RunReadSnapshotSchema.parse({ ...snapshot, runId: RUN_ID })).toThrow();
    expect(() => RunReadSnapshotSchema.parse({ ...snapshot, state: "pausing" })).toThrow();
  });
});

// --------------------------------------------------------------------------
// Barrel-gap regression
// --------------------------------------------------------------------------

describe("index.ts re-exports the Plan-004 run-control contracts", () => {
  // A module can be complete and still invisible to consumers if the
  // `export * from "./runControl.js"` line is missing or dropped in a later
  // refactor. Importing through `../index.js` (not `../runControl.js`) is what
  // makes this exercise the re-export layer.
  it.each([
    ["QueueItemIdSchema", contracts.QueueItemIdSchema],
    ["InterventionIdSchema", contracts.InterventionIdSchema],
    ["QueueItemStateSchema", contracts.QueueItemStateSchema],
    ["InterventionStateSchema", contracts.InterventionStateSchema],
    ["RunStateSchema", contracts.RunStateSchema],
    ["RunFailureCategorySchema", contracts.RunFailureCategorySchema],
    ["QueueItemCreateRequestSchema", contracts.QueueItemCreateRequestSchema],
    ["QueueItemCreateResponseSchema", contracts.QueueItemCreateResponseSchema],
    ["QueueItemListRequestSchema", contracts.QueueItemListRequestSchema],
    ["QueueItemListResponseSchema", contracts.QueueItemListResponseSchema],
    ["QueueItemSummarySchema", contracts.QueueItemSummarySchema],
    ["QueueItemCancelRequestSchema", contracts.QueueItemCancelRequestSchema],
    ["QueueItemCancelResponseSchema", contracts.QueueItemCancelResponseSchema],
    ["InterventionRequestPayloadSchema", contracts.InterventionRequestPayloadSchema],
    ["RollbackAppliedResultSchema", contracts.RollbackAppliedResultSchema],
    ["RollbackCompositeRejectionGuardSchema", contracts.RollbackCompositeRejectionGuardSchema],
    ["RollbackDegradedResultSchema", contracts.RollbackDegradedResultSchema],
    ["RollbackInterventionResultSchema", contracts.RollbackInterventionResultSchema],
    ["InterventionRequestResponseSchema", contracts.InterventionRequestResponseSchema],
    ["RunStateChangeEventSchema", contracts.RunStateChangeEventSchema],
    ["RunRolledBackEventSchema", contracts.RunRolledBackEventSchema],
    ["RunPauseRequestSchema", contracts.RunPauseRequestSchema],
    ["RunResumeRequestSchema", contracts.RunResumeRequestSchema],
    ["RunControlAckSchema", contracts.RunControlAckSchema],
    ["RunStateSubscribeRequestSchema", contracts.RunStateSubscribeRequestSchema],
    ["RunQueueSubscribeRequestSchema", contracts.RunQueueSubscribeRequestSchema],
    ["RunReadSnapshotSchema", contracts.RunReadSnapshotSchema],
  ] as const)("re-exports %s with a callable .parse", (_name, schema) => {
    expect(schema).toBeDefined();
    expect(typeof (schema as { parse?: unknown })?.parse).toBe("function");
  });

  it("resolves the same schema instance through the barrel as through the module", () => {
    // A shadow copy would pass the callable check above while diverging on the
    // next contract edit.
    expect(contracts.InterventionRequestResponseSchema).toBe(InterventionRequestResponseSchema);
    expect(contracts.RunStateChangeEventSchema).toBe(RunStateChangeEventSchema);
  });
});
