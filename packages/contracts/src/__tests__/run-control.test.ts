// The guards that keep a run's control stream honest: a stale or forged control is refused at
// the wire, before the daemon acts on it.
import { describe, expect, it } from "vitest";

import type { InterventionType } from "../provider-driver.js";
import { RECOVERY_CONDITIONS } from "../provider-driver-recovery.js";
import {
  InterventionRequestPayloadSchema,
  RunControlAckSchema,
  RUN_CONTROL_METHOD_DESCRIPTORS,
  RunPauseRequestSchema,
  RunResumeRequestSchema,
  RunRolledBackEventSchema,
  RunStateChangeEventSchema,
} from "../run-control.js";
import { RunStateSchema } from "../run-state.js";
import { RunSafetyBufferingUpdatedPayloadSchema } from "../session-controls.js";

const SESSION_ID = "0f2b4d5e-1111-4111-8111-111111111111";
const QUEUE_ITEM_ID = "0f2b4d5e-4444-4444-8444-444444444444";
const RUN_ID = "0f2b4d5e-6666-4666-8666-666666666666";
const IDEMPOTENCY_KEY = "0f2b4d5e-9999-4999-8999-999999999999";
// Two distinct artifact ids, so an order assertion over the steer carrier can tell them apart.
const FIRST_ARTIFACT_ID = "0f2b4d5e-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_ARTIFACT_ID = "0f2b4d5e-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TIMESTAMP = "2026-08-31T12:00:00.000Z";

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

  describe("the interrupt's pending messages", () => {
    const interrupt = { ...guards, type: "interrupt" };

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

const minimalRunStateChange = {
  runId: RUN_ID,
  runVersion: 3,
  previousState: "running",
  newState: "paused",
  timestamp: TIMESTAMP,
} as const;

describe("RunStateChangeEvent", () => {
  it("carries every member of the recovery vocabulary", () => {
    // Driven from the imported array so a member added to the vocabulary reaches this carrier; a
    // narrower local copy would still compile but dead-letter the member at parse.
    for (const recoveryCondition of RECOVERY_CONDITIONS) {
      const stateChange = {
        ...minimalRunStateChange,
        newState: "failed",
        failureCategory: "provider failure",
        recoveryCondition,
      };
      expect(RunStateChangeEventSchema.parse(stateChange)).toEqual(stateChange);
    }
  });

  it("rejects an off-union recovery condition", () => {
    // Referencing the shared parser must not widen the carrier into accepting free strings.
    expect(
      RunStateChangeEventSchema.safeParse({
        ...minimalRunStateChange,
        newState: "failed",
        recoveryCondition: "retry-later",
      }).success,
    ).toBe(false);
  });

  describe("a turn the provider refused", () => {
    const refusal = {
      cause: "refused",
      model: "claude-opus-4-1",
      explanation: "This request looks like it could help with a cyberattack.",
      safetyCategory: "cyber",
    };

    it("rides only the transition into failed, and only with the refusing model", () => {
      const failed = { ...minimalRunStateChange, newState: "failed", failureCause: refusal };
      expect(RunStateChangeEventSchema.parse(failed)).toEqual(failed);
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
    const base = { writableRoots: ["/workspace"], credentialPolicyRef: "policy://default" };

    it("admits a posture at each permission level, with or without a profile name", () => {
      const postures = [
        { ...base, mode: "readonly", writableRoots: [] },
        { ...base, mode: "sandboxed" },
        { ...base, mode: "reviewed" },
        { ...base, mode: "ask", profileName: "default" },
        { ...base, mode: "yolo", writableRoots: [] },
      ];
      for (const executionPosture of postures) {
        expect(
          RunStateChangeEventSchema.parse({ ...minimalRunStateChange, executionPosture }),
        ).toEqual({ ...minimalRunStateChange, executionPosture });
      }
    });

    it("refuses a posture with no credential policy or a mode outside the levels", () => {
      // A recorded posture missing its credential policy or naming a mode that is not a permission
      // level misstates the run's boundary.
      const { credentialPolicyRef: _omitted, ...withoutPolicy } = base;
      expect(() =>
        RunStateChangeEventSchema.parse({
          ...minimalRunStateChange,
          executionPosture: { ...withoutPolicy, mode: "yolo" },
        }),
      ).toThrow();
      expect(() =>
        RunStateChangeEventSchema.parse({
          ...minimalRunStateChange,
          executionPosture: { ...base, mode: "workspace-sandboxed" },
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

const safetyHold = {
  sessionId: SESSION_ID,
  runId: RUN_ID,
  turnId: "turn-3",
  active: true,
  fasterModel: "gpt-5.5-mini",
} as const;

describe("the run.subscribeState arms", () => {
  const stateStream = RUN_CONTROL_METHOD_DESCRIPTORS["run.subscribeState"].emissionSchema;

  it("keeps the state change, the rollback and the safety hold disjoint", () => {
    // The stream carries no wire tag, so the arms are told apart by shape and each must refuse
    // the others; a rollback paired with a previous and current state would corrupt the
    // transition stream consumers replay. Positive controls come first, so the refusals are the
    // crossing and not a bad fixture.
    expect(RunRolledBackEventSchema.parse(minimalRolledBack)).toEqual(minimalRolledBack);
    expect(RunStateChangeEventSchema.parse(minimalRunStateChange)).toEqual(minimalRunStateChange);
    expect(stateStream.parse(safetyHold)).toEqual(safetyHold);
    expect(() => RunStateChangeEventSchema.parse(minimalRolledBack)).toThrow();
    expect(() => RunRolledBackEventSchema.parse(minimalRunStateChange)).toThrow();
    expect(() =>
      RunRolledBackEventSchema.parse({
        ...minimalRolledBack,
        previousState: "running",
        newState: "paused",
      }),
    ).toThrow();
    expect(() => RunStateChangeEventSchema.parse(safetyHold)).toThrow();
    expect(() => RunRolledBackEventSchema.parse(safetyHold)).toThrow();
    expect(() => RunSafetyBufferingUpdatedPayloadSchema.parse(minimalRunStateChange)).toThrow();
    expect(() => RunSafetyBufferingUpdatedPayloadSchema.parse(minimalRolledBack)).toThrow();
  });
});

describe("run pause and resume", () => {
  const request = { targetRunId: RUN_ID, expectedRunVersion: 6 };

  it("admits `pausing`, the state a run holds while its step finishes after a pause", () => {
    expect(RunStateSchema.parse("pausing")).toBe("pausing");
    const ack = { runId: RUN_ID, newState: "pausing", runVersion: 7 };
    expect(RunControlAckSchema.parse(ack)).toEqual(ack);
  });

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
});
