// Plus the three shapes no Phase-1 task names — the `run-control.ts`
// contract surface: the intervention request union, the
// state-split intervention response, the run-state change event, the
// forward rolled-back event, the pause/resume triggers, the two
// `run.subscribe*` request shapes, and the run-read accessor shape.
//
// Backstops and the invariants these contracts carry:
//   • The MANDATORY `expectedRunVersion` comparand. Every arm of the
//     intervention union is pinned to reject its absence, so the
//     stale-replay guard cannot be bypassed by omitting the field.
//   • The same guard extended to the orchestration-layer pause and resume
//     verbs, which hold no `InterventionType` membership.
//
// Coverage shape:
//   • Every member of every enum parses and an out-of-set value is rejected,
//     so each pin is a real accept/reject boundary rather than a one-sided
//     smoke test.
//   • Every parse refusal the contract claims is exercised WITH its positive
//     control.
//   • The creation row's own members (the linkage, the limits, the admission
//     stamps) are pinned as REJECTED on the state stream: `run.queued`'s payload carries
//     them, and a producer that put them on a transition must fail rather than
//     have them silently dropped.
//   • The three arms of the `run.subscribeState` stream are pinned AGAINST
//     EACH OTHER: the stream carries no wire tag, so each schema is shown to
//     reject the others' well-formed payloads — the property that makes one
//     untagged stream safe to parse.
//   • The two `run.subscribe*` request shapes are pinned against the two
//     members a copy of a neighboring subscribe shape would bring with it: a
//     `runId` filter (the subscription is session-scoped and fans out per run
//     client-side) and a replay cursor (`run.*` carries none).
//   • The `index.ts` barrel re-exports every symbol this task provides — the
//     barrel-gap regression.
import { describe, expect, it } from "vitest";

import * as contracts from "../index.js";
import type { InterventionType } from "../provider-driver.js";
import { RECOVERY_CONDITIONS, RECOVERY_SPAN_CLASSIFICATIONS } from "../provider-driver.js";
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

// --------------------------------------------------------------------------
// Shared enums
// --------------------------------------------------------------------------

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

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------

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
    // An optional comparand would let a caller bypass the stale-replay guard
    // by omitting it, so absence must refuse on EVERY arm.
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
    // The arm was `unknown[]` until the 2026-09-08 discharge, and an
    // `unknown[]` arm can enforce neither the carrier count cap, nor order
    // preservation, nor the unresolved-marker contract — it cannot even carry
    // an id a resolver could look up. These are the negative controls that make
    // the element type load-bearing rather than decorative: each one PASSED
    // before the discharge and refuses after it.
    const steerCarrying = (attachments: readonly unknown[]): Record<string, unknown> => ({
      ...guards,
      type: "steer",
      content: "see the attached trace",
      attachments,
    });

    it("REFUSES a non-id element", () => {
      // The exact shape the pre-discharge suite admitted.
      expect(() =>
        InterventionRequestPayloadSchema.parse(steerCarrying([{ kind: "blob" }])),
      ).toThrow();
      expect(() => InterventionRequestPayloadSchema.parse(steerCarrying([{}]))).toThrow();
      expect(() => InterventionRequestPayloadSchema.parse(steerCarrying([17]))).toThrow();
    });

    it("REFUSES a string that is not an artifact id", () => {
      // `ArtifactId` is UUID-shaped because ratifies it as an RFC 9562 UUID the
      // daemon mints at manifest creation, not because this seam chose a shape: a
      // caller-supplied id reaching a manifest lookup must not be a path or a
      // store-key fragment, and a bare `z.string()` element would admit both.
      expect(() =>
        InterventionRequestPayloadSchema.parse(steerCarrying(["../../etc/passwd"])),
      ).toThrow();
      // A plausible-looking opaque handle is still refused, and the reason is the
      // encoding rather than the characters: `artifact-1` is not an RFC 9562 UUID.
      expect(() => InterventionRequestPayloadSchema.parse(steerCarrying(["artifact-1"]))).toThrow(
        /uuid/i,
      );
    });

    it("accepts the empty carrier and preserves declared order", () => {
      // Order preservation is the daemon's delivery obligation and not
      // something a schema can assert; what the parse must not do is REORDER
      // or DROP, so the round-trip pins the sequence it was handed.
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

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------

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

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------

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
    // Driven from the IMPORTED arrays, not from a list written out here, and for
    // the same reason the `InterventionType` fan-out above is: this module is the
    // second of the four surfaces bound to REFERENCE the hoisted vocabularies
    // rather than restate them. It used to restate them, as two module-private
    // `z.enum` mirrors, and the `z.ZodType<T>` annotations that were said to hold
    // those mirrors in lockstep do not: `ZodType` is covariant in its output, so a
    // mirror NARROWER than the imported union compiles clean. A member added
    // upstream must reach this carrier, and if a mirror ever returns here it will
    // not — this test goes red instead of the member dead-lettering at parse.
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
    // The linkage, the limits and the admission stamps are `run.queued`'s,
    // recorded once on the run's creation. A transition that carried them would be
    // a second record of one fact, so a producer that emits one must FAIL rather
    // than have it silently dropped.
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
// --------------------------------------------------------------------------

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

  it("refuses a non-UUID session or run id", () => {
    expect(() =>
      RunRolledBackEventSchema.parse({ ...minimalRolledBack, sessionId: "s-1" }),
    ).toThrow();
    expect(() => RunRolledBackEventSchema.parse({ ...minimalRolledBack, runId: "r-1" })).toThrow();
  });

  it("refuses a fabricated state transition", () => {
    // A rollback transitions no state. A producer pairing the rewind with a
    // synthesized previous/current pair would corrupt the transition stream
    // consumers replay, so the pair must fail parse rather than ride along.
    expect(() =>
      RunRolledBackEventSchema.parse({
        ...minimalRolledBack,
        previousState: "running",
        newState: "paused",
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

// --------------------------------------------------------------------------
// Pause / resume triggers
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
    // The guard extended to the orchestration-layer verbs, which hold no
    // InterventionType membership and so inherit nothing implicitly.
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

// --------------------------------------------------------------------------
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
    // `SessionSubscribeRequest` declares `afterCursor` for replay. `run.*`
    // replays nothing, so neither cursor member has a producer here and the
    // absence is a decision — copying the neighboring shape must fail.
    expect(() => schema.parse({ sessionId: SESSION_ID, afterCursor: "0" })).toThrow();
    expect(() => schema.parse({ sessionId: SESSION_ID, lastEventId: "0" })).toThrow();
  });
});

// --------------------------------------------------------------------------
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
    expect(() => RunReadSnapshotSchema.parse({ ...snapshot, state: "resuming" })).toThrow();
  });
});

// --------------------------------------------------------------------------
// Barrel-gap regression
// --------------------------------------------------------------------------

describe("index.ts re-exports run-control contracts", () => {
  // A module can be complete and still invisible to consumers if the
  // `export * from "./run-control.js"` line is missing or dropped in a later
  // refactor. Importing through `../index.js` (not `../run-control.js`) is what
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
