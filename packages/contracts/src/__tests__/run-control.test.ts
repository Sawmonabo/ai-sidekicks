// Contract tests for `run-control.ts`: the intervention request union, the state-split
// response, the run-state change and rolled-back events, the pause and resume requests, the
// two `run.subscribe*` requests and the run-read snapshot.
//
// Every arm of the intervention union, and the pause and resume requests, must refuse a missing
// `expectedRunVersion`, so the stale-replay guard cannot be bypassed by omitting it. Each enum
// is checked on both sides of its boundary, and each refusal comes with a positive control.
// The `run.subscribeState` arms carry no wire tag, so each schema must reject the others'
// payloads. The creation row's members (linkage, limits, admission stamps) must be refused on
// a state transition, and the `index.ts` barrel must re-export every symbol tested here.
import { describe, expect, it } from "vitest";

import * as contracts from "../index.js";
import type { InterventionType } from "../provider-driver.js";
import { RECOVERY_CONDITIONS, RECOVERY_SPAN_CLASSIFICATIONS } from "../provider-driver-recovery.js";
import {
  InterventionRequestPayloadSchema,
  InterventionRequestResponseSchema,
  InterventionStateSchema,
  RunControlAckSchema,
  RunFailureCategorySchema,
  RUN_CONTROL_METHOD_DESCRIPTORS,
  RunPauseRequestSchema,
  RunReadSnapshotSchema,
  RunRecoveryResolvedPayloadSchema,
  RunRecoveryResolveRequestSchema,
  RunResumeRequestSchema,
  RunRolledBackEventSchema,
  RunStateChangeEventSchema,
  RunStateSubscribeRequestSchema,
  type InterventionState,
  type RunFailureCategory,
} from "../run-control.js";
import { RunQueueSubscribeRequestSchema } from "../run-queue.js";
import { RunStateSchema, type RunState } from "../run-state.js";
import { RunSafetyBufferingUpdatedPayloadSchema } from "../session-controls.js";
import { FILE_PATH_MAX_LEN } from "../session.js";

const SESSION_ID = "0f2b4d5e-1111-4111-8111-111111111111";
const QUEUE_ITEM_ID = "0f2b4d5e-4444-4444-8444-444444444444";
const INTERVENTION_ID = "0f2b4d5e-5555-4555-8555-555555555555";
const RUN_ID = "0f2b4d5e-6666-4666-8666-666666666666";
const PARENT_RUN_ID = "0f2b4d5e-7777-4777-8777-777777777777";
const IDEMPOTENCY_KEY = "0f2b4d5e-9999-4999-8999-999999999999";
// Two DISTINCT artifact ids, so an order assertion over the steer carrier can
// tell the elements apart.
const FIRST_ARTIFACT_ID = "0f2b4d5e-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_ARTIFACT_ID = "0f2b4d5e-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TIMESTAMP = "2026-08-31T12:00:00.000Z";

describe("run-control shared enums", () => {
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
    "pausing",
    "paused",
    "completed",
    "interrupted",
    "failed",
  ];
  it.each(runStates)("admits the run state %s", (state) => {
    expect(RunStateSchema.parse(state)).toBe(state);
  });

  it("rejects a run state outside the ten", () => {
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

const guards = {
  targetRunId: RUN_ID,
  expectedRunVersion: 4,
  clientIdempotencyKey: IDEMPOTENCY_KEY,
} as const;

describe("InterventionRequestPayload", () => {
  const armPayloads: Record<InterventionType, Record<string, unknown>> = {
    steer: { ...guards, type: "steer", content: "please use the async client" },
    interrupt: { ...guards, type: "interrupt", pending: "nextTurn", reason: "wrong branch" },
    cancel: { ...guards, type: "cancel" },
    faster_model_retry: {
      ...guards,
      type: "faster_model_retry",
      expectedTurnId: "turn-7",
      model: "faster-model",
    },
  };
  const arms: ReadonlyArray<[InterventionType, Record<string, unknown>]> = (
    Object.entries(armPayloads) as Array<[InterventionType, Record<string, unknown>]>
  ).map(([armType, payload]) => [armType, payload]);

  it.each(arms)("round-trips the %s arm", (_type, payload) => {
    expect(InterventionRequestPayloadSchema.parse(payload)).toEqual(payload);
  });

  it.each(arms)("refuses the %s arm without its mandatory comparand", (_type, payload) => {
    // An optional comparand would let a caller bypass the stale-replay guard, so absence must
    // refuse on every arm.
    const { expectedRunVersion: _omitted, ...withoutComparand } = payload;
    expect(() => InterventionRequestPayloadSchema.parse(withoutComparand)).toThrow();
  });

  it.each(arms)("refuses the %s arm without its idempotency key", (_type, payload) => {
    const { clientIdempotencyKey: _omitted, ...withoutKey } = payload;
    expect(() => InterventionRequestPayloadSchema.parse(withoutKey)).toThrow();
  });

  it("refuses a non-UUID idempotency key", () => {
    // The key lands in a durable receipt under a UNIQUE constraint; an unbounded caller-chosen
    // string would make replay keying depend on client discipline.
    expect(() =>
      InterventionRequestPayloadSchema.parse({
        ...guards,
        type: "cancel",
        clientIdempotencyKey: "k1",
      }),
    ).toThrow();
  });

  it("refuses a faster-model retry that names no turn or no model", () => {
    // Without the turn the daemon could not refuse a retry of a turn that has
    // moved on; without the model it would resend on the model that was held.
    const { expectedTurnId: _turn, ...withoutTurn } = armPayloads.faster_model_retry;
    const { model: _model, ...withoutModel } = armPayloads.faster_model_retry;
    expect(() => InterventionRequestPayloadSchema.parse(withoutTurn)).toThrow();
    expect(() => InterventionRequestPayloadSchema.parse(withoutModel)).toThrow();
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
      attachments: [FIRST_ARTIFACT_ID, SECOND_ARTIFACT_ID],
      expectedTurnId: "turn-19",
    };
    expect(InterventionRequestPayloadSchema.parse(payload)).toEqual(payload);
  });

  describe("the interrupt's pending messages", () => {
    const interrupt = { ...guards, type: "interrupt" };

    it("says where the waiting messages go: the next turn or back to the draft", () => {
      for (const pending of ["nextTurn", "returnToDraft"]) {
        expect(InterventionRequestPayloadSchema.safeParse({ ...interrupt, pending }).success).toBe(
          true,
        );
      }
      expect(InterventionRequestPayloadSchema.safeParse(interrupt).success).toBe(false);
    });

    it("delivers a named message first only when the rest go as the next turn", () => {
      expect(
        InterventionRequestPayloadSchema.safeParse({
          ...interrupt,
          pending: "nextTurn",
          deliverFirst: QUEUE_ITEM_ID,
        }).success,
      ).toBe(true);
      expect(
        InterventionRequestPayloadSchema.safeParse({
          ...interrupt,
          pending: "returnToDraft",
          deliverFirst: QUEUE_ITEM_ID,
        }).success,
      ).toBe(false);
    });
  });

  describe("the steer attachments element type", () => {
    // An `unknown[]` element could enforce neither the count cap nor order preservation, and
    // could not carry an id a resolver could look up. These negative controls make the element
    // type load-bearing.
    const steerCarrying = (attachments: readonly unknown[]): Record<string, unknown> => ({
      ...guards,
      type: "steer",
      content: "see the attached trace",
      attachments,
    });

    it("REFUSES a non-id element", () => {
      expect(() =>
        InterventionRequestPayloadSchema.parse(steerCarrying([{ kind: "blob" }])),
      ).toThrow();
      expect(() => InterventionRequestPayloadSchema.parse(steerCarrying([{}]))).toThrow();
      expect(() => InterventionRequestPayloadSchema.parse(steerCarrying([17]))).toThrow();
    });

    it("REFUSES a string that is not an artifact id", () => {
      // `ArtifactId` is an RFC 9562 UUID the daemon mints at manifest creation; a caller-supplied
      // id reaching a manifest lookup must not be a path or a store-key fragment, which a bare
      // `z.string()` element would admit.
      expect(() =>
        InterventionRequestPayloadSchema.parse(steerCarrying(["../../etc/passwd"])),
      ).toThrow();
      // A plausible-looking opaque handle is still refused: `artifact-1` is not an RFC 9562 UUID.
      expect(() => InterventionRequestPayloadSchema.parse(steerCarrying(["artifact-1"]))).toThrow(
        /uuid/i,
      );
    });

    it("accepts the empty carrier and preserves declared order", () => {
      // Ordering is the daemon's delivery duty; the parse must only not reorder or drop, so the
      // round-trip pins the sequence.
      expect(InterventionRequestPayloadSchema.parse(steerCarrying([]))).toEqual(steerCarrying([]));
      const ordered = [SECOND_ARTIFACT_ID, FIRST_ARTIFACT_ID];
      expect(
        (
          InterventionRequestPayloadSchema.parse(steerCarrying(ordered)) as {
            attachments: string[];
          }
        ).attachments,
      ).toEqual(ordered);
    });
  });
});

const responseBase = {
  interventionId: INTERVENTION_ID,
  runVersion: 5,
} as const;

describe("InterventionRequestResponse", () => {
  it("parses the three types with a permissive result and without one", () => {
    for (const interventionType of ["steer", "interrupt", "cancel"]) {
      const bare = { ...responseBase, interventionType, state: "applied" };
      expect(InterventionRequestResponseSchema.parse(bare)).toEqual(bare);
      const withResult = { ...bare, result: { deliveredAt: TIMESTAMP } };
      expect(InterventionRequestResponseSchema.parse(withResult)).toEqual(withResult);
    }
  });

  it("carries a machine-readable cause on a rejected response", () => {
    const rejected = {
      ...responseBase,
      interventionType: "cancel",
      state: "rejected",
      rejectionReason: "driver.capability_unsupported",
    };
    expect(InterventionRequestResponseSchema.parse(rejected)).toEqual(rejected);
  });

  it("refuses an unknown member rather than stripping it", () => {
    expect(() =>
      InterventionRequestResponseSchema.parse({
        ...responseBase,
        interventionType: "steer",
        state: "applied",
        outcome: { deliveredAt: TIMESTAMP },
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

const minimalRunStateChange = {
  runId: RUN_ID,
  runVersion: 3,
  previousState: "running",
  newState: "paused",
  timestamp: TIMESTAMP,
} as const;

describe("RunStateChangeEvent", () => {
  it("parses the five required members alone", () => {
    expect(RunStateChangeEventSchema.parse(minimalRunStateChange)).toEqual(minimalRunStateChange);
  });

  it("parses every optional member this module can type", () => {
    const full = {
      ...minimalRunStateChange,
      newState: "failed",
      failureCategory: "provider failure",
      recoveryCondition: "reauth-required",
      recoverySpanClassification: "irreversible",
      providerFailureDetail: "driver.text_neutralization_failed origin=human_text",
      completionKind: "turn",
      intendedClose: true,
      executionPosture: { networkAccess: "none", writableRoots: ["/w"], mode: "trusted" },
      trigger: "workflow_phase_canceled",
    };
    expect(RunStateChangeEventSchema.parse(full)).toEqual(full);
  });

  it("carries every member of both recovery vocabularies", () => {
    // Driven from the imported arrays so a member added to either vocabulary reaches this
    // carrier; a narrower local copy would still compile but dead-letter the member at parse.
    for (const recoveryCondition of RECOVERY_CONDITIONS) {
      for (const recoverySpanClassification of RECOVERY_SPAN_CLASSIFICATIONS) {
        const stateChange = {
          ...minimalRunStateChange,
          newState: "failed",
          failureCategory: "provider failure",
          recoveryCondition,
          recoverySpanClassification,
        };
        expect(RunStateChangeEventSchema.parse(stateChange)).toEqual(stateChange);
      }
    }
  });

  it("keeps both recovery members OPTIONAL on this replay-visible projection", () => {
    // Both are required on the live `DriverResumeResult` but optional on this replay-visible
    // projection.
    expect(RunStateChangeEventSchema.parse(minimalRunStateChange)).toEqual(minimalRunStateChange);
  });

  it("rejects an off-union value on either recovery member", () => {
    // Referencing the shared parsers must not widen the carrier into accepting free strings.
    for (const member of ["recoveryCondition", "recoverySpanClassification"] as const) {
      expect(
        RunStateChangeEventSchema.safeParse({
          ...minimalRunStateChange,
          newState: "failed",
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

  it("refuses the creation row's own members on a state transition", () => {
    // The linkage, limits and admission stamps belong to `run.queued`, recorded once at creation;
    // a producer that emits them on a transition must fail rather than have them silently dropped.
    for (const smuggled of [
      { agentId: "agent-1" },
      { parentRunId: PARENT_RUN_ID },
      { internalHelper: true },
      { effectiveRunConfig: { tokenLimit: 200_000 } },
      { admittedUnpricedCapUsdMicros: 5_000_000 },
      { admittedModelFamily: "claude-opus" },
    ]) {
      expect(() =>
        RunStateChangeEventSchema.parse({ ...minimalRunStateChange, ...smuggled }),
      ).toThrow();
    }
  });

  describe("a turn the provider refused", () => {
    const refusal = {
      cause: "refused",
      model: "claude-opus-4-1",
      explanation: "This request looks like it could help with a cyberattack.",
      safetyCategory: "cyber",
    };

    it("rides the transition into failed with the refusing model", () => {
      const failed = { ...minimalRunStateChange, newState: "failed", failureCause: refusal };
      expect(RunStateChangeEventSchema.parse(failed)).toEqual(failed);
    });

    it("is refused on any other transition and without the refusing model", () => {
      expect(
        RunStateChangeEventSchema.safeParse({ ...minimalRunStateChange, failureCause: refusal })
          .success,
      ).toBe(false);
      const { model: _omitted, ...withoutModel } = refusal;
      expect(
        RunStateChangeEventSchema.safeParse({
          ...minimalRunStateChange,
          newState: "failed",
          failureCause: withoutModel,
        }).success,
      ).toBe(false);
    });
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

    it("refuses a writable root longer than the longest path the wire carries", () => {
      const posture = (root: string) => ({
        ...minimalRunStateChange,
        executionPosture: { writableRoots: [root], networkAccess: "none", mode: "trusted" },
      });
      const longest = `/${"a".repeat(FILE_PATH_MAX_LEN - 1)}`;
      expect(RunStateChangeEventSchema.safeParse(posture(longest)).success).toBe(true);
      expect(RunStateChangeEventSchema.safeParse(posture(`${longest}a`)).success).toBe(false);
    });

    it("refuses an empty allowed-domains list", () => {
      // The type is a NON-EMPTY tuple: an `allowed-domains` posture with no domains permits
      // nothing while claiming to permit something.
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

const minimalRolledBack = {
  sessionId: SESSION_ID,
  runId: RUN_ID,
  runVersion: 8,
  targetPosition: 5,
} as const;

describe("RunRolledBackEvent", () => {
  it("parses the four required members", () => {
    expect(RunRolledBackEventSchema.parse(minimalRolledBack)).toEqual(minimalRolledBack);
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
    // Position 0 is the run's first boundary, a legitimate anchor as on the request side. A
    // fractional or negative counter could never equal a recorded position or run version.
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

  it("refuses a non-UUID session or run id", () => {
    expect(() =>
      RunRolledBackEventSchema.parse({ ...minimalRolledBack, sessionId: "s-1" }),
    ).toThrow();
    expect(() => RunRolledBackEventSchema.parse({ ...minimalRolledBack, runId: "r-1" })).toThrow();
  });

  it("refuses a fabricated state transition", () => {
    // A rollback is not a state change; an event pairing the rewind with a previous and current
    // state would corrupt the transition stream consumers replay.
    expect(() =>
      RunRolledBackEventSchema.parse({
        ...minimalRolledBack,
        previousState: "running",
        newState: "paused",
      }),
    ).toThrow();
  });

  it("is disjoint from the state-change arm it shares run.subscribeState with", () => {
    // The stream carries no wire tag, so the arms are told apart by shape and each must refuse
    // the other. Positive controls come first, so the refusals are the crossing and not a bad
    // fixture.
    expect(RunRolledBackEventSchema.parse(minimalRolledBack)).toEqual(minimalRolledBack);
    expect(RunStateChangeEventSchema.parse(minimalRunStateChange)).toEqual(minimalRunStateChange);
    expect(() => RunStateChangeEventSchema.parse(minimalRolledBack)).toThrow();
    expect(() => RunRolledBackEventSchema.parse(minimalRunStateChange)).toThrow();
  });
});

const safetyHold = {
  sessionId: SESSION_ID,
  runId: RUN_ID,
  turnId: "turn-3",
  active: true,
  fasterModel: "gpt-5.5-mini",
} as const;

describe("Codex's safety hold on run.subscribeState", () => {
  const stateStream = RUN_CONTROL_METHOD_DESCRIPTORS["run.subscribeState"].emissionSchema;

  it("delivers a hold frame on the run's state stream", () => {
    expect(stateStream.parse(safetyHold)).toEqual(safetyHold);
  });

  it("refuses a hold that names no turn", () => {
    const { turnId: _turnId, ...noTurn } = safetyHold;
    expect(stateStream.safeParse(noTurn).success).toBe(false);
  });

  it("is disjoint from the state change and the rollback", () => {
    expect(() => RunStateChangeEventSchema.parse(safetyHold)).toThrow();
    expect(() => RunRolledBackEventSchema.parse(safetyHold)).toThrow();
    expect(() => RunSafetyBufferingUpdatedPayloadSchema.parse(minimalRunStateChange)).toThrow();
    expect(() => RunSafetyBufferingUpdatedPayloadSchema.parse(minimalRolledBack)).toThrow();
  });
});

describe("the recovery question after a restart", () => {
  it("takes each of the four choices and records it on the event", () => {
    for (const choice of ["keep_provider", "undo_to_agreed", "continue_provider", "hand_over"]) {
      expect(RunRecoveryResolveRequestSchema.safeParse({ runId: RUN_ID, choice }).success).toBe(
        true,
      );
      expect(
        RunRecoveryResolvedPayloadSchema.safeParse({ sessionId: SESSION_ID, runId: RUN_ID, choice })
          .success,
      ).toBe(true);
    }
  });

  it("refuses a choice the question does not offer", () => {
    expect(
      RunRecoveryResolveRequestSchema.safeParse({ runId: RUN_ID, choice: "replay" }).success,
    ).toBe(false);
  });
});

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
    // The comparand guard applies to these orchestration-layer verbs too; they have no
    // intervention type to inherit it from.
    expect(() => schema.parse({ targetRunId: RUN_ID })).toThrow();
  });

  it.each([
    ["RunPauseRequestSchema", RunPauseRequestSchema],
    ["RunResumeRequestSchema", RunResumeRequestSchema],
  ] as const)("%s refuses an intervention-shaped extra member", (_name, schema) => {
    expect(() => schema.parse({ ...request, type: "interrupt" })).toThrow();
  });

  it("acks a pause with the state the run is in while its step finishes", () => {
    const ack = { runId: RUN_ID, newState: "pausing", runVersion: 7 };
    expect(RunControlAckSchema.parse(ack)).toEqual(ack);
    expect(() => RunControlAckSchema.parse({ runId: RUN_ID, newState: "paused" })).toThrow();
  });
});

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
    // The subscription is session-scoped and clients fan out per run; a silently dropped
    // `runId` would hand back every run of the session while reading as a filter.
    expect(() => schema.parse({ sessionId: SESSION_ID, runId: RUN_ID })).toThrow();
  });

  it.each(subscribeSchemas)("%s refuses a replay-cursor member", (_name, schema) => {
    // `SessionSubscribeRequest` declares `afterCursor` for replay; `run.*` replays nothing, so a
    // request copied from that neighbor must fail.
    expect(() => schema.parse({ sessionId: SESSION_ID, afterCursor: "0" })).toThrow();
    expect(() => schema.parse({ sessionId: SESSION_ID, lastEventId: "0" })).toThrow();
  });
});

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
    expect(() => RunReadSnapshotSchema.parse({ ...snapshot, state: "resuming" })).toThrow();
  });
});

describe("index.ts re-exports run-control contracts", () => {
  // Importing through `../index.js` rather than `../run-control.js` is what exercises the barrel.
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
    // A shadow copy would pass the callable check above but drift from the module's schema.
    expect(contracts.InterventionRequestResponseSchema).toBe(InterventionRequestResponseSchema);
    expect(contracts.RunStateChangeEventSchema).toBe(RunStateChangeEventSchema);
  });
});
