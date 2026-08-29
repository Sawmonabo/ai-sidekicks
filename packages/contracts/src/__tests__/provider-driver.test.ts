// Plan-005 Phase 1 T1.5 — contract-conformance tests for the internal
// provider-driver contract (`provider-driver.ts`).
//
// Phase-1 scope is TYPE-SYSTEM CONFORMANCE + CONTRACT-VALIDATION UNITS only:
// the nominal-TypeScript surfaces are proven by COMPILATION (a fully-typed mock
// driver that must typecheck, plus `@ts-expect-error` negatives), and the three
// Zod result/ingress schemas are proven by `.parse()` / `.safeParse()` units.
// There are NO behavioral round-trips here — the daemon-side hydration seam and
// the persistence/event projections that exercise these shapes at runtime ship
// in Phase 2-3 (Plan-005 T2.x / T3.x). This file ratifies the CONTRACT, not its
// consumers.
//
// Coverage map (cite → block):
//   • AC1 (`Spec-005 §Acceptance Criteria`) — a mock fully implementing `ProviderDriver` (all 16
//     ops, correctly-typed params + returns) compiles with no session-domain
//     change. The compile is the assertion; a runtime smoke confirms the mock
//     is constructable and a method returns the expected shape.
//   • AC2 (`Spec-005 §Acceptance Criteria`) — a capability flag outside the 14-flag
//     `DriverCapabilityFlag` union is a TS error (`@ts-expect-error`, self-
//     verifying via TS2578 if the invalid flag ever became valid).
//   • T1.7 flag currency — `DRIVER_CAPABILITY_FLAGS` carries exactly the fourteen
//     campaign flags in canonical §Shared Enums order, `transcript_replay`
//     INSERTED at its canonical position rather than appended, and DELIBERATELY
//     excludes `pause`, whose exclusion is permanent (ADR-011).
//   • T1.8 parity ops — the four added operations (`rollbackTo`,
//     `setSessionGoal`, `clearSessionGoal`, `probeAuth`) and the three result
//     envelopes they answer (`DriverRollbackResultSchema`,
//     `DriverGoalResultSchema`, `DriverAuthProbeResultSchema`) plus the two
//     driver-normalized seam schemas (`CallbackToolInvocationSchema`,
//     `McpServerStatusEmissionSchema`) parse valid shapes, reject invalid ones,
//     and reject unknown keys (`.strict()` on all five).
//   • T1.8 `InterventionType` widening — the union carries FOUR members while
//     `ApplyInterventionParams` stays THREE-armed; a `rollback` dispatch arm is
//     a compile error, which is the structural form of "rollback's driver leg is
//     the dedicated `rollbackTo` operation, not an `applyIntervention` route".
//   • T1.8 `RecoveryCondition` re-type — the `failed` resume variant now accepts
//     BOTH conditions where T1.6 accepted only the `recovery-needed` literal.
//   • T1.8 `GetCapabilitiesResult.cliVersion` — REQUIRED, so a capability report
//     omitting it is a compile error (fail-closed by construction).
//   • I-005-5 — narrowing a `DriverResumeResult` to `status: "failed"` makes
//     `.bindingId` AND `.sessionPosition` type errors; the `failed` variant
//     structurally carries `recoveryCondition` + `recoverySpanClassification` +
//     `providerFailureDetail`, and the `resumed` variant carries neither failure
//     axis. Silent replacement (a binding alongside a failure signal) is
//     inexpressible.
//   • Resume-result currency — the `resumed` arm's REQUIRED `sessionPosition`
//     (the position the daemon compares against its recorded one, which is what
//     catches a provider silently answering with a FRESH session) and the
//     `failed` arm's REQUIRED `recoverySpanClassification` (four-valued, with
//     `unclassifiable` as the fail-closed member a driver emits rather than
//     omitting — omission is a schema failure).
//   • `ApplyInterventionParams.clientIdempotencyKey` — MANDATORY on all three
//     dispatch arms (the requester-generated UUID the daemon dedupes on), so an
//     absent key is a compile error rather than a non-deduped intervention.
//   • I-005-3 — `ProviderToolMetadataSchema` defaults an omitted
//     `idempotency_class` to `manual_reconcile_only` at parse time, and passes
//     an explicit value through unchanged.
//   • Result-envelope schemas (the provider→daemon trust boundary) —
//     `DriverInterventionResultSchema`, `DriverResumeResultSchema`, and the
//     leaf `IdempotencyClassSchema` parse valid shapes and reject invalid ones
//     (including `.strict()` extra-key rejection on the result-envelope schemas;
//     `ProviderToolMetadataSchema`, by contrast, STRIPS unknown keys per
//     `Spec-005 §Default Behavior` forward-compat). Every untrusted free-form string these
//     schemas parse is length / non-whitespace / NUL-bounded via
//     `wireFreeFormString` — exercised per field below.
//
// Idiom: matches the sibling unit tests in this directory — typed-variable
// assignment as the compile-time proof (session-id.test.ts), `.parse()` /
// `.safeParse(...).success` for schema units (session-create.test.ts /
// session-event.test.ts), relative `../provider-driver.js` import. The package
// uses no `expectTypeOf` / `assertType` helper, so the compile-time assertions
// here are typed-binding + `@ts-expect-error`, exactly as the siblings do.
//
// Refs: `Spec-005 §Acceptance Criteria` (AC1 — driver implementable with no session-domain change),
// `Spec-005 §Acceptance Criteria` (AC2 — off-union capability flag is a type error), `Spec-005 §Fallback Behavior`
// (resume-failure surfacing), `Spec-005 §idempotency_class` (idempotency default), Plan-005
// Phase 1, I-005-3, I-005-5.
import { describe, expect, it } from "vitest";

import {
  DRIVER_AUTH_DETAIL_MAX_LEN,
  DRIVER_BINDING_ID_MAX_LEN,
  DRIVER_CAPABILITY_FLAGS,
  DRIVER_FAILURE_DETAIL_MAX_LEN,
  DRIVER_FALLBACK_ACTION_MAX_LEN,
  DRIVER_MCP_SERVER_NAME_MAX_LEN,
  DRIVER_TOOL_CALL_ID_MAX_LEN,
  DRIVER_TOOL_DESCRIPTION_MAX_LEN,
  DRIVER_TOOL_NAME_MAX_LEN,
  CallbackToolInvocationSchema,
  DriverAuthProbeResultSchema,
  DriverGoalResultSchema,
  DriverInterventionResultSchema,
  DriverResumeResultSchema,
  DriverRollbackResultSchema,
  DriverTranscriptExportResultSchema,
  DriverTranscriptReplayResultSchema,
  IdempotencyClassSchema,
  McpServerStatusEmissionSchema,
  ProviderToolMetadataSchema,
  type ApplyInterventionParams,
  type CallbackToolResult,
  type ClearSessionGoalParams,
  type CloseSessionParams,
  type CreateSessionParams,
  type DriverAuthProbeResult,
  type DriverCapabilities,
  type DriverCapabilityFlag,
  type DriverGoalResult,
  type DriverInterventionResult,
  type DriverResumeResult,
  type DriverRollbackResult,
  type DriverTranscriptExportResult,
  type DriverTranscriptReplayResult,
  type DriverTransportConfig,
  type ExecutionPosture,
  type ExportTranscriptParams,
  type GetCapabilitiesResult,
  type InterruptRunParams,
  type InterventionType,
  type McpServerStatusUpdate,
  type NormalizedProviderToolMetadata,
  type ProviderDriver,
  type ProviderModel,
  type ProviderMode,
  type ProviderSessionHandle,
  type RecoverySpanClassification,
  type ReplayTranscriptParams,
  type RespondToRequestParams,
  type ResumeSessionParams,
  type RollbackToParams,
  type RunId,
  type SessionCallbackTool,
  type SetSessionGoalParams,
  type StartRunParams,
  type SubagentPolicy,
} from "../provider-driver.js";
import { type ChannelId, type SessionId } from "../session.js";

// Real RFC 9562 UUIDs reused as branded-id runtime values (the brands are
// TS-only; the runtime is a plain UUID string). Cast at the brand boundary the
// same way the sibling fixtures feed wire strings into branded slots.
const SESSION_UUID = "550e8400-e29b-41d4-a716-446655440000";
const RUN_UUID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f00";
const CHANNEL_UUID = "880e8400-e29b-41d4-a716-446655440003";

const SESSION_ID = SESSION_UUID as SessionId;
const RUN_ID = RUN_UUID as RunId;
const CHANNEL_ID = CHANNEL_UUID as ChannelId;

// The requester-generated intervention idempotency key. A real UUID rather than
// a label token: the contract types it as a plain `string`, but the value the
// daemon dedupes on is a caller-minted UUID, and a fixture that looked like a
// slug would quietly normalize the reader's expectation of what callers send.
const CLIENT_IDEMPOTENCY_KEY = "6f9619ff-8b86-4011-b42d-00cf4fc964ff";

// ===========================================================================
// AC1 (`Spec-005 §Acceptance Criteria`) — a mock fully implementing `ProviderDriver` compiles.
// ===========================================================================
//
// The class below implements ALL 16 operations with correctly-typed params and
// return shapes. The fact that it typechecks under `implements ProviderDriver`
// (with `exactOptionalPropertyTypes` + `isolatedDeclarations` on) IS the
// acceptance assertion: a provider integration can satisfy this contract with
// zero changes to the session domain (`SessionId` / `ChannelId` are consumed,
// not redefined). The runtime `it` block adds a smoke assertion so the compile
// proof is anchored to an executing test.
//
// `isolatedDeclarations` requires explicit return annotations only on EXPORTED
// declarations; this class is test-local (never exported), so the method
// bodies need no extra annotation beyond the interface they satisfy.

class MockProviderDriver implements ProviderDriver {
  public createSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    return Promise.resolve({
      providerSessionId: `provider-${params.sessionId}`,
      resumeHandle: "resume-handle-opaque",
    });
  }

  public resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    // A successful resume returns the `resumed` variant — carries a binding AND
    // the confirmed position, never a failure signal (the discriminated union
    // forbids both at once). `sessionPosition` is REQUIRED, so a mock that
    // reported a resume the daemon could not position-compare would not compile.
    return Promise.resolve({
      status: "resumed",
      bindingId: `binding-for-${params.resumeHandle}`,
      sessionPosition: 17,
    });
  }

  public startRun(_params: StartRunParams): Promise<void> {
    return Promise.resolve();
  }

  public interruptRun(_params: InterruptRunParams): Promise<void> {
    return Promise.resolve();
  }

  public applyIntervention(_params: ApplyInterventionParams): Promise<DriverInterventionResult> {
    return Promise.resolve({ status: "applied" });
  }

  // T1.8 parity ops, in the interface's own order. `rollbackTo` echoes the
  // requested position back as the confirmed floor: the REQUIRED
  // `sessionPosition` on the `applied` arm is what makes "succeeded without a
  // confirmed floor" unrepresentable, so a mock that omitted it would not compile.
  public rollbackTo(params: RollbackToParams): Promise<DriverRollbackResult> {
    return Promise.resolve({ status: "applied", sessionPosition: params.position });
  }

  public respondToRequest(_params: RespondToRequestParams): Promise<void> {
    return Promise.resolve();
  }

  public setSessionGoal(_params: SetSessionGoalParams): Promise<DriverGoalResult> {
    return Promise.resolve({ status: "applied" });
  }

  public clearSessionGoal(_params: ClearSessionGoalParams): Promise<DriverGoalResult> {
    return Promise.resolve({ status: "applied" });
  }

  public closeSession(_params: CloseSessionParams): Promise<void> {
    return Promise.resolve();
  }

  public listModels(): Promise<ProviderModel[]> {
    return Promise.resolve([{ id: "model-1", name: "Model One", capabilities: ["tool_calls"] }]);
  }

  public listModes(): Promise<ProviderMode[]> {
    return Promise.resolve([{ id: "mode-1", name: "Mode One" }]);
  }

  public getCapabilities(): Promise<GetCapabilitiesResult> {
    const capabilities: DriverCapabilities = {
      // Every flag MUST be answered — `Record<DriverCapabilityFlag, boolean>`
      // is total, the structural form of I-005-2 (no capability inferred from
      // absence). Omitting one is a type error, exercised in AC2 below.
      flags: {
        resume: true,
        steer: true,
        interactive_requests: false,
        mcp: false,
        tool_calls: true,
        reasoning_stream: false,
        model_mutation: false,
        structured_output: false,
        rollback: true,
        session_goals: true,
        callback_tools: false,
        subagents: false,
        transcript_replay: false,
        cost_cap: false,
      },
      contractVersion: "1.0",
    };
    return Promise.resolve({
      capabilities,
      // `tools` is the INGRESS shape — a driver MAY omit `idempotency_class`;
      // normalization happens at the daemon hydration seam, not here.
      tools: [{ name: "read_file" }, { name: "write_file", idempotency_class: "compensable" }],
      // T1.8: REQUIRED. A capability report whose provider version did not parse
      // never reaches the daemon, so the mock must supply the pair — omitting it
      // is a compile error, asserted directly in the T1.8 block below.
      cliVersion: { raw: "mock-provider-cli 1.4.2 (build 9)", semver: "1.4.2" },
    });
  }

  public probeAuth(): Promise<DriverAuthProbeResult> {
    return Promise.resolve({ status: "authenticated" });
  }

  public exportTranscript(params: ExportTranscriptParams): Promise<DriverTranscriptExportResult> {
    return Promise.resolve({
      frames: params.transcript.turns.map((turn) => ({ position: turn.position })),
      declaredLosses: ["provider_private_reasoning"],
    });
  }

  public replayTranscript(params: ReplayTranscriptParams): Promise<DriverTranscriptReplayResult> {
    return Promise.resolve({
      status: params.frames.length === 0 ? "degraded" : "applied",
      declaredLosses: [],
    });
  }
}

describe("ProviderDriver contract: a mock implements all 16 operations", () => {
  // Type-level proof that the mock satisfies the contract interface: assigning
  // it to a `ProviderDriver`-typed binding will fail to compile if any of the
  // 16 method signatures drifts from the contract. This is the AC1 assertion;
  // the runtime checks below merely anchor it to an executing test.
  const driver: ProviderDriver = new MockProviderDriver();

  it("is constructable and surfaces all 16 contract operations as callable methods", () => {
    // Interface order, so a drift in the declaration order shows up as a diff
    // here rather than silently reordering.
    const operationNames = [
      "createSession",
      "resumeSession",
      "startRun",
      "interruptRun",
      "applyIntervention",
      "rollbackTo",
      "respondToRequest",
      "setSessionGoal",
      "clearSessionGoal",
      "closeSession",
      "listModels",
      "listModes",
      "getCapabilities",
      "probeAuth",
      "exportTranscript",
      "replayTranscript",
    ] as const;
    expect(operationNames).toHaveLength(16);
    expect(driver).toBeInstanceOf(MockProviderDriver);
    for (const operationName of operationNames) {
      expect(typeof (driver as unknown as Record<string, unknown>)[operationName]).toBe("function");
    }
  });

  it("createSession resolves the expected ProviderSessionHandle shape (runtime smoke)", async () => {
    const handle = await driver.createSession({ sessionId: SESSION_ID, config: {} });
    expect(handle).toEqual({
      providerSessionId: `provider-${SESSION_UUID}`,
      resumeHandle: "resume-handle-opaque",
    });
  });

  it("resumeSession resolves the `resumed` arm carrying BOTH the binding and the confirmed position (runtime smoke)", async () => {
    // Sits beside the `rollbackTo` smoke below for the same reason: the `resumed`
    // arm's REQUIRED `sessionPosition` is what the daemon compares against its
    // RECORDED position, so without one a provider that silently answered with a
    // fresh session would be indistinguishable from a genuine resume. Asserting
    // the whole object (not just `status`) keeps both required members exercised
    // rather than merely compiled — the mock derives `bindingId` from the handle
    // it was handed, so this also shows the param reaching the driver.
    const resumed = await driver.resumeSession({
      sessionId: SESSION_ID,
      resumeHandle: "resume-handle-opaque",
    });
    expect(resumed).toEqual({
      status: "resumed",
      bindingId: "binding-for-resume-handle-opaque",
      sessionPosition: 17,
    });
  });

  it("getCapabilities answers every one of the 14 flags and returns ingress tools", async () => {
    const result = await driver.getCapabilities();
    // The canonical 14-flag `DriverCapabilityFlag` set, written alphabetically
    // and SPELLED OUT rather than derived from `DRIVER_CAPABILITY_FLAGS`: a
    // derived literal would agree with the const by construction and could never
    // catch a flag silently added or removed there. Keeping it hand-written is
    // what makes this an independent lockstep check.
    const canonicalCapabilityFlags = [
      "callback_tools",
      "cost_cap",
      "interactive_requests",
      "mcp",
      "model_mutation",
      "reasoning_stream",
      "resume",
      "rollback",
      "session_goals",
      "steer",
      "structured_output",
      "subagents",
      "tool_calls",
      "transcript_replay",
    ];
    // I-005-2 structural check: the flag record is total — exactly the 14
    // canonical flags, every one answered with a boolean.
    expect(Object.keys(result.capabilities.flags).sort()).toEqual(canonicalCapabilityFlags);
    expect(result.tools).toHaveLength(2);
  });

  it("getCapabilities carries the REQUIRED cliVersion pair (T1.8, fail-closed by construction)", async () => {
    const result = await driver.getCapabilities();
    expect(result.cliVersion).toEqual({
      raw: "mock-provider-cli 1.4.2 (build 9)",
      semver: "1.4.2",
    });
  });

  it("probeAuth resolves a DriverAuthProbeResult (runtime smoke; NOT capability-gated)", async () => {
    // `probeAuth` is required of every driver and declares no capability flag,
    // so there is no flag to consult before calling it.
    const probe = await driver.probeAuth();
    expect(probe.status).toBe("authenticated");
  });

  it("rollbackTo returns the confirmed post-rollback floor (runtime smoke)", async () => {
    const rolled = await driver.rollbackTo({
      sessionId: SESSION_ID,
      position: 12,
      bindingId: "binding-abc",
    });
    expect(rolled).toEqual({ status: "applied", sessionPosition: 12 });
  });

  it("both goal operations resolve an applied DriverGoalResult (runtime smoke)", async () => {
    const setResult = await driver.setSessionGoal({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
      runId: RUN_ID,
      goalText: "land the migration",
    });
    const clearResult = await driver.clearSessionGoal({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
      runId: RUN_ID,
    });
    expect(setResult.status).toBe("applied");
    expect(clearResult.status).toBe("applied");
  });

  it("applyIntervention resolves an applied DriverInterventionResult (runtime smoke)", async () => {
    const result = await driver.applyIntervention({
      type: "steer",
      targetRunId: RUN_ID,
      expectedRunVersion: 3,
      clientIdempotencyKey: CLIENT_IDEMPOTENCY_KEY,
      payload: { content: "stay on task" },
    });
    expect(result.status).toBe("applied");
  });

  it("rejects a steer intervention with an empty payload at compile time", () => {
    // @ts-expect-error — `steer` is coupled to SteerPayload; `content` is
    // mandatory, so the empty `payload: {}` below makes this assignment a type
    // error (an empty payload is structurally unrepresentable for `steer`).
    const malformed: ApplyInterventionParams = {
      type: "steer",
      targetRunId: RUN_ID,
      expectedRunVersion: 1,
      clientIdempotencyKey: CLIENT_IDEMPOTENCY_KEY,
      payload: {},
    };
    void malformed;
  });

  it("consumes session-domain branded ids without redefining them (no session-domain change)", () => {
    // The contract imports `SessionId` / `ChannelId` from session.ts. Binding
    // the same brands here proves the driver reuses the session domain rather
    // than forking it — the structural form of "no session-domain change".
    const startParams: StartRunParams = {
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: {},
    };
    expect(startParams.runId).toBe(RUN_UUID);
    expect(startParams.channelId).toBe(CHANNEL_UUID);
  });

  it("carries the native-cap admitted cap on both the start and resume seams", () => {
    // The omitting fixtures above prove the field is optional; these prove the
    // typed presence form on both seams — recovery must be able to re-thread
    // the run.queued server-stamped cap (campaign B6).
    const cappedStart: StartRunParams = {
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: {},
      admittedCostCapCents: 2500,
    };
    const cappedResume: ResumeSessionParams = {
      sessionId: SESSION_ID,
      resumeHandle: "resume-handle-opaque",
      admittedCostCapCents: 2500,
    };
    const cappedCreate: CreateSessionParams = {
      sessionId: SESSION_ID,
      config: {},
      admittedCostCapCents: 2500,
    };
    expect(cappedStart.admittedCostCapCents).toBe(2500);
    expect(cappedResume.admittedCostCapCents).toBe(2500);
    expect(cappedCreate.admittedCostCapCents).toBe(2500);
  });
});

// ===========================================================================
// AC2 (`Spec-005 §Acceptance Criteria`) — a capability flag outside the 14-flag union is a TS error.
// ===========================================================================
//
// `DriverCapabilities.flags` is `Record<DriverCapabilityFlag, boolean>`. The
// `@ts-expect-error` directives below assert the type system REJECTS:
//   (a) an extra flag key not in the 14-member union, and
//   (b) an incomplete record that omits a required flag.
// Self-verifying: an UNUSED `@ts-expect-error` is itself a TS2578 error, so if
// the off-union flag ever became valid (e.g. the union gained `pause`,
// excluded per ADR-011) the full `tsc -p tsconfig.test.json` pass would fail.
// No `as any` / `as never` escape hatch is used — that would silence the very
// error this case exists to surface.

describe("ProviderDriver contract: off-union capability flag is a type error", () => {
  it("rejects a capability flag outside the 14-flag DriverCapabilityFlag union at compile time", () => {
    const flagsWithExtra: DriverCapabilities["flags"] = {
      resume: true,
      steer: true,
      interactive_requests: false,
      mcp: false,
      tool_calls: true,
      reasoning_stream: false,
      model_mutation: false,
      structured_output: false,
      rollback: false,
      session_goals: false,
      callback_tools: false,
      subagents: false,
      transcript_replay: false,
      cost_cap: false,
      // `pause` is intentionally NOT in the union (ADR-011 models pause as an
      // orchestration-layer construct — interrupt run, persist state, queue
      // resume — not a driver capability and not an `InterventionType` value
      // (`InterventionType = "steer" | "interrupt" | "cancel" | "rollback"`)).
      // An excess key on a `Record<Union, …>` literal is a type error — the
      // directive below MUST consume it.
      // @ts-expect-error pause is not a DriverCapabilityFlag (ADR-011: pause is an orchestration-layer construct — interrupt + persist + queue-resume — not a driver capability)
      pause: true,
    };
    // Runtime read keeps the binding "used" for lint and anchors the type
    // proof to an executing assertion; the load-bearing check is the compile.
    expect(flagsWithExtra.resume).toBe(true);
  });

  it("rejects an incomplete flag record that omits a required capability (totality)", () => {
    // `Record<DriverCapabilityFlag, boolean>` is total: omitting `cost_cap`
    // is a type error, so a driver cannot silently leave a capability
    // unanswered (capabilities are explicit, never inferred from absence).
    // Omitting one of the T1.7 ADDITIONS (rather than an original seven flag)
    // is the load-bearing choice here: it proves the totality requirement
    // actually extended to the widened union rather than lagging behind it.
    // @ts-expect-error missing `cost_cap` — the flag record is total and must answer every flag
    const incompleteFlags: DriverCapabilities["flags"] = {
      resume: true,
      steer: true,
      interactive_requests: false,
      mcp: false,
      tool_calls: true,
      reasoning_stream: false,
      model_mutation: false,
      structured_output: false,
      rollback: false,
      session_goals: false,
      callback_tools: false,
      subagents: false,
      transcript_replay: false,
    };
    expect(incompleteFlags.resume).toBe(true);
  });
});

// ===========================================================================
// I-005-5 — silent provider-session replacement is structurally inexpressible.
// ===========================================================================
//
// `DriverResumeResult` is a `status`-discriminated union. The `failed` variant
// carries a `RecoveryCondition` + a `RecoverySpanClassification` +
// `providerFailureDetail` and has NO `bindingId` and NO `sessionPosition`; the
// `resumed` variant carries `bindingId` + `sessionPosition` and neither failure
// axis. So a resume CANNOT return a binding while signalling failure — the
// type system forbids conflating a failed resume with a successful one
// (`Spec-005 §Fallback Behavior`: resume failure must surface provider-failure detail + a visible
// recovery-needed condition, and must NOT silently create a replacement
// session under the same canonical run).

describe("ProviderDriver contract: failed resume cannot carry a binding", () => {
  it("forbids accessing `.bindingId` after narrowing to status:'failed' (compile-time)", () => {
    // Parse through the schema so the static type is the genuine
    // `DriverResumeResult` UNION (not a narrow object literal) — this is the
    // sibling idiom (session-event.test.ts narrows a `.parse()` result). It
    // makes the discriminator guard a REAL narrowing: the `@ts-expect-error`
    // below is then checked against the narrowed `failed` variant, where
    // `.bindingId` genuinely does not exist.
    const resume: DriverResumeResult = DriverResumeResultSchema.parse({
      status: "failed",
      recoveryCondition: "recovery-needed",
      recoverySpanClassification: "irreversible",
      providerFailureDetail: "provider endpoint returned 410 Gone",
    });

    if (resume.status === "failed") {
      // The `failed` variant structurally carries BOTH recovery axes.
      expect(resume.recoveryCondition).toBe("recovery-needed");
      expect(resume.recoverySpanClassification).toBe("irreversible");
      expect(resume.providerFailureDetail).toBe("provider endpoint returned 410 Gone");

      // …and CANNOT carry a binding. Accessing `.bindingId` on the narrowed
      // `failed` variant is a type error — the structural proof that silent
      // replacement (a binding alongside a failure) is inexpressible.
      // @ts-expect-error `bindingId` does not exist on the `failed` variant (I-005-5: no binding alongside a failure)
      const leakedBinding = resume.bindingId;
      // Nor a position. A failed resume confirms NO position, so there is
      // nothing for the daemon to compare against its recorded one — the same
      // structural argument as the binding, applied to the second success-only
      // member.
      // @ts-expect-error `sessionPosition` does not exist on the `failed` variant (a failure confirms no position to compare)
      const leakedPosition = resume.sessionPosition;
      // Both read `undefined` at runtime (the properties are absent); the
      // load-bearing assertions are the compile errors consumed above.
      expect(leakedBinding).toBeUndefined();
      expect(leakedPosition).toBeUndefined();
    } else {
      throw new Error(`expected the failed variant, got status=${resume.status}`);
    }
  });

  it("the resumed variant carries a binding and no failure signal (the other arm)", () => {
    const success: DriverResumeResult = DriverResumeResultSchema.parse({
      status: "resumed",
      bindingId: "binding-xyz",
      sessionPosition: 4,
    });

    if (success.status === "resumed") {
      expect(success.bindingId).toBe("binding-xyz");
      expect(success.sessionPosition).toBe(4);
      // Symmetric proof: the `resumed` variant has NEITHER failure axis.
      // @ts-expect-error `recoveryCondition` does not exist on the `resumed` variant (I-005-5: success carries no failure signal)
      const leakedRecovery = success.recoveryCondition;
      // @ts-expect-error `recoverySpanClassification` does not exist on the `resumed` variant (the span classification is a FAILURE axis)
      const leakedClassification = success.recoverySpanClassification;
      expect(leakedRecovery).toBeUndefined();
      expect(leakedClassification).toBeUndefined();
    } else {
      throw new Error(`expected the resumed variant, got status=${success.status}`);
    }
  });
});

// ===========================================================================
// I-005-3 — `ProviderToolMetadataSchema` parse-time idempotency normalization.
// ===========================================================================
//
// This package's first TRANSFORMING schema (Input ≠ Output): an OMITTED
// `idempotency_class` defaults to `manual_reconcile_only` on the OUTPUT (a
// driver may omit it at ingress; the daemon-side normalized shape requires it).
// `Spec-005 §idempotency_class` — an undeclared class is NOT a contract violation; the safe
// default applies at the normalization seam.

describe("ProviderToolMetadataSchema: ingress→normalized idempotency default", () => {
  it("defaults an omitted idempotency_class to 'manual_reconcile_only' at parse time", () => {
    const normalized: NormalizedProviderToolMetadata = ProviderToolMetadataSchema.parse({
      name: "delete_branch",
    });
    expect(normalized.idempotency_class).toBe("manual_reconcile_only");
    expect(normalized.name).toBe("delete_branch");
  });

  it.each(["idempotent", "compensable", "manual_reconcile_only"] as const)(
    "passes an explicitly-declared idempotency_class through unchanged: %s",
    (declaredClass) => {
      const normalized = ProviderToolMetadataSchema.parse({
        name: "list_files",
        idempotency_class: declaredClass,
      });
      expect(normalized.idempotency_class).toBe(declaredClass);
    },
  );

  it("preserves an optional description when present", () => {
    const normalized = ProviderToolMetadataSchema.parse({
      name: "read_file",
      description: "Reads a file from the workspace.",
    });
    expect(normalized.description).toBe("Reads a file from the workspace.");
    // The default still fires for the omitted class alongside a present description.
    expect(normalized.idempotency_class).toBe("manual_reconcile_only");
  });

  it("rejects a missing `name` (the only required ingress field; field surfaced in the issue path)", () => {
    const result = ProviderToolMetadataSchema.safeParse({ idempotency_class: "idempotent" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("name");
    }
  });

  it("rejects an off-enum idempotency_class value", () => {
    expect(
      ProviderToolMetadataSchema.safeParse({ name: "x", idempotency_class: "best_effort" }).success,
    ).toBe(false);
  });

  it("strips an unknown extra key (forward-compat — unknown fields ignored)", () => {
    // The extensible tool-metadata DECLARATION surface must IGNORE unknown keys
    // (`Spec-005 §Default Behavior`), in deliberate contrast to the `.strict()` result envelopes.
    // The load-bearing assertion is ABSENCE of the unknown key from the
    // normalized output (`toEqual`, not a `success`-only check) — a passthrough
    // schema would also `success`, so only checking the exact output shape
    // discriminates "stripped" from "leaked".
    const result = ProviderToolMetadataSchema.safeParse({ name: "read_file", future_field: "x" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        name: "read_file",
        idempotency_class: "manual_reconcile_only",
      });
    }
  });
});

// ===========================================================================
// ProviderToolMetadataSchema — trust-boundary string bounds (wireFreeFormString).
// ===========================================================================
//
// `name` and `description` parse UNTRUSTED provider output. Both are bounded via
// `wireFreeFormString`: empty, whitespace-only, NUL-containing, and over-max
// strings are REJECTED (no truncation). Over-max fixtures are built from the
// EXPORTED `*_MAX_LEN` constant so the test tracks the contract value.

describe("ProviderToolMetadataSchema — untrusted free-form string bounds", () => {
  it("accepts an in-bounds name + description", () => {
    const result = ProviderToolMetadataSchema.safeParse({
      name: "read_file",
      description: "Reads a file from the workspace.",
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ["empty string", ""],
    ["whitespace-only", "   "],
    ["NUL-containing", "a\u0000b"],
    ["over-max", "a".repeat(DRIVER_TOOL_NAME_MAX_LEN + 1)],
  ])("rejects a `name` that is %s", (_label, invalidName) => {
    expect(ProviderToolMetadataSchema.safeParse({ name: invalidName }).success).toBe(false);
  });

  it.each([
    ["empty string", ""],
    ["whitespace-only", "   "],
    ["NUL-containing", "a\u0000b"],
    ["over-max", "a".repeat(DRIVER_TOOL_DESCRIPTION_MAX_LEN + 1)],
  ])("rejects a `description` that is %s", (_label, invalidDescription) => {
    expect(
      ProviderToolMetadataSchema.safeParse({ name: "read_file", description: invalidDescription })
        .success,
    ).toBe(false);
  });

  // `wireFreeFormString`'s `.max()` is INCLUSIVE — an exactly-MAX_LEN string must
  // be ACCEPTED. Asserting only `MAX_LEN + 1` rejects would let an off-by-one
  // regression (exclusive bound) pass silently; pin the inclusive boundary.
  it("accepts a `name` at exactly DRIVER_TOOL_NAME_MAX_LEN (inclusive boundary)", () => {
    expect(
      ProviderToolMetadataSchema.safeParse({ name: "a".repeat(DRIVER_TOOL_NAME_MAX_LEN) }).success,
    ).toBe(true);
  });

  it("accepts a `description` at exactly DRIVER_TOOL_DESCRIPTION_MAX_LEN (inclusive boundary)", () => {
    expect(
      ProviderToolMetadataSchema.safeParse({
        name: "read_file",
        description: "a".repeat(DRIVER_TOOL_DESCRIPTION_MAX_LEN),
      }).success,
    ).toBe(true);
  });
});

// ===========================================================================
// IdempotencyClassSchema — the leaf enum guard.
// ===========================================================================

describe("IdempotencyClassSchema — the idempotency-class enum", () => {
  it.each(["idempotent", "compensable", "manual_reconcile_only"] as const)(
    "accepts the canonical member: %s",
    (member) => {
      const parsed = IdempotencyClassSchema.parse(member);
      expect(parsed).toBe(member);
    },
  );

  it.each([
    ["off-enum string", "best_effort"],
    ["empty string", ""],
    ["wrong-case member", "Idempotent"],
    ["number", 1],
    ["null", null],
    ["undefined", undefined],
  ])("rejects a non-member value: %s", (_label, value) => {
    expect(IdempotencyClassSchema.safeParse(value).success).toBe(false);
  });
});

// ===========================================================================
// DriverInterventionResultSchema — the applyIntervention result envelope.
// ===========================================================================
//
// Zod-validated because it parses UNTRUSTED provider output (the provider→daemon
// trust boundary). Flat object (not discriminated): `applied` and `degraded`
// differ only by the optional `fallbackAction` hint and the optional
// `refusalCode`. `.strict()` rejects any unknown key.

describe("DriverInterventionResultSchema — intervention result envelope (trust boundary)", () => {
  it("parses an `applied` result with no fallbackAction", () => {
    const parsed: DriverInterventionResult = DriverInterventionResultSchema.parse({
      status: "applied",
    });
    expect(parsed.status).toBe("applied");
    expect(parsed.fallbackAction).toBeUndefined();
  });

  it("parses a `degraded` result carrying a fallbackAction hint", () => {
    const parsed = DriverInterventionResultSchema.parse({
      status: "degraded",
      fallbackAction: "queue_and_interrupt",
    });
    expect(parsed.status).toBe("degraded");
    expect(parsed.fallbackAction).toBe("queue_and_interrupt");
  });

  it("rejects a status outside the applied | degraded union", () => {
    expect(DriverInterventionResultSchema.safeParse({ status: "exploded" }).success).toBe(false);
  });

  it("rejects an unknown extra key (.strict() guard)", () => {
    expect(
      DriverInterventionResultSchema.safeParse({ status: "applied", extra: "leak" }).success,
    ).toBe(false);
  });

  it("rejects a missing required `status` (field surfaced in the issue path)", () => {
    const result = DriverInterventionResultSchema.safeParse({
      fallbackAction: "queue_and_interrupt",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("status");
    }
  });

  it("rejects a non-string fallbackAction (wrong-type at the trust boundary)", () => {
    expect(
      DriverInterventionResultSchema.safeParse({ status: "degraded", fallbackAction: 123 }).success,
    ).toBe(false);
  });

  it("accepts an in-bounds fallbackAction hint", () => {
    expect(
      DriverInterventionResultSchema.safeParse({
        status: "degraded",
        fallbackAction: "queue_and_interrupt",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["empty string", ""],
    ["whitespace-only", "   "],
    ["NUL-containing", "a\u0000b"],
    ["over-max", "a".repeat(DRIVER_FALLBACK_ACTION_MAX_LEN + 1)],
  ])("rejects a `fallbackAction` that is %s (wireFreeFormString bound)", (_label, invalidValue) => {
    expect(
      DriverInterventionResultSchema.safeParse({ status: "degraded", fallbackAction: invalidValue })
        .success,
    ).toBe(false);
  });

  // `refusalCode` is a CLOSED LITERAL, not a free-form string, and these two
  // cases are what that choice buys. Its consumers key on identity — a client
  // render and a driver-side settlement both branch on the one value — so a
  // string-typed member would let a provider-facing surface report an arbitrary
  // refusal that every reader would have to treat as unrecognized.
  it("parses a `degraded` result carrying the text-neutralization refusal code", () => {
    const parsed: DriverInterventionResult = DriverInterventionResultSchema.parse({
      status: "degraded",
      refusalCode: "driver.text_neutralization_failed",
    });
    expect(parsed.refusalCode).toBe("driver.text_neutralization_failed");
    // No fallbackAction: a refusal names no alternative the caller could take.
    expect(parsed.fallbackAction).toBeUndefined();
  });

  it("rejects a refusalCode outside the closed literal", () => {
    expect(
      DriverInterventionResultSchema.safeParse({
        status: "degraded",
        refusalCode: "some.other.code",
      }).success,
    ).toBe(false);
  });

  it("still rejects an unknown key sitting beside a valid refusalCode (.strict() holds)", () => {
    expect(
      DriverInterventionResultSchema.safeParse({
        status: "degraded",
        refusalCode: "driver.text_neutralization_failed",
        extra: "leak",
      }).success,
    ).toBe(false);
  });

  // Inclusive `.max()`: an exactly-MAX_LEN fallbackAction must be ACCEPTED
  // (guards against an off-by-one exclusive-bound regression).
  it("accepts a `fallbackAction` at exactly DRIVER_FALLBACK_ACTION_MAX_LEN (inclusive boundary)", () => {
    expect(
      DriverInterventionResultSchema.safeParse({
        status: "degraded",
        fallbackAction: "a".repeat(DRIVER_FALLBACK_ACTION_MAX_LEN),
      }).success,
    ).toBe(true);
  });
});

// ===========================================================================
// DriverResumeResultSchema — the resumeSession result envelope.
// ===========================================================================
//
// Zod-validated provider output. Discriminated over `status`: the `resumed` arm
// requires `bindingId` + `sessionPosition`; the `failed` arm requires
// `recoveryCondition` (either of the two conditions), `recoverySpanClassification`
// (one of the four span classes), and `providerFailureDetail`. Each arm is
// `.strict()`, so neither a binding nor a position can ride along on a failure
// (the runtime mirror of I-005-5) and neither failure axis can ride along on a
// success.
//
// FIXTURE DISCIPLINE, load-bearing now that each arm carries more than one
// required member: every negative case below supplies a VALID value for every
// member it is NOT testing, so each fixture's sole defect is the one its title
// names. Otherwise a fixture keeps "failing to parse" because of a missing
// sibling and quietly stops exercising the bound it claims to guard — an
// off-by-one regression in `wireFreeFormString` would sail through a red test.

describe("DriverResumeResultSchema — resume result envelope (trust boundary)", () => {
  it("parses the `resumed` arm with a bindingId and a confirmed sessionPosition", () => {
    const parsed: DriverResumeResult = DriverResumeResultSchema.parse({
      status: "resumed",
      bindingId: "binding-abc",
      sessionPosition: 12,
    });
    expect(parsed.status).toBe("resumed");
    if (parsed.status === "resumed") {
      expect(parsed.bindingId).toBe("binding-abc");
      expect(parsed.sessionPosition).toBe(12);
    }
  });

  it("parses the `failed` arm with both recovery axes + providerFailureDetail", () => {
    const parsed = DriverResumeResultSchema.parse({
      status: "failed",
      recoveryCondition: "recovery-needed",
      recoverySpanClassification: "read_only",
      providerFailureDetail: "provider session expired",
    });
    expect(parsed.status).toBe("failed");
    if (parsed.status === "failed") {
      expect(parsed.recoveryCondition).toBe("recovery-needed");
      expect(parsed.recoverySpanClassification).toBe("read_only");
      expect(parsed.providerFailureDetail).toBe("provider session expired");
    }
  });

  // --- omitted required members (exactly one defect per fixture) ------------

  it("rejects a `resumed` object missing bindingId (field surfaced in the issue path)", () => {
    const result = DriverResumeResultSchema.safeParse({ status: "resumed", sessionPosition: 7 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("bindingId");
    }
  });

  it("rejects a `resumed` object missing sessionPosition (a resume the daemon could not position-compare)", () => {
    // The mirror of the rollback envelope's "no confirmed floor" case: with no
    // reported position there is nothing to compare against the RECORDED one, so
    // a provider that silently answered with a FRESH session would be
    // indistinguishable from one that genuinely resumed.
    const result = DriverResumeResultSchema.safeParse({
      status: "resumed",
      bindingId: "binding-abc",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("sessionPosition");
    }
  });

  it("rejects a `failed` object missing providerFailureDetail (field surfaced in the issue path)", () => {
    const result = DriverResumeResultSchema.safeParse({
      status: "failed",
      recoveryCondition: "recovery-needed",
      recoverySpanClassification: "irreversible",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("providerFailureDetail");
    }
  });

  it("rejects a `failed` object missing recoveryCondition (field surfaced in the issue path)", () => {
    const result = DriverResumeResultSchema.safeParse({
      status: "failed",
      recoverySpanClassification: "irreversible",
      providerFailureDetail: "provider session expired",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("recoveryCondition");
    }
  });

  it("rejects a `failed` object missing recoverySpanClassification (omission is a schema failure, not a silent unknown)", () => {
    // REQUIRED on this live driver return precisely so a driver that cannot
    // classify the halted span must SAY so — by emitting `unclassifiable`, which
    // the consumer handles exactly as `irreversible` — rather than by omitting
    // the axis and leaving the blast radius unrecorded.
    const result = DriverResumeResultSchema.safeParse({
      status: "failed",
      recoveryCondition: "recovery-needed",
      providerFailureDetail: "provider session expired",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("recoverySpanClassification");
    }
  });

  // --- off-union values on the two failed-arm enums -------------------------

  it("rejects a `failed` object whose recoveryCondition is not a RecoveryCondition member (cause surfaced on recoveryCondition)", () => {
    const result = DriverResumeResultSchema.safeParse({
      status: "failed",
      recoveryCondition: "all-good",
      recoverySpanClassification: "irreversible",
      providerFailureDetail: "provider session expired",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The defect is an off-union value on `recoveryCondition`, not a missing
      // field — assert the issue is attributed to that exact path. `all-good` is
      // outside BOTH `RecoveryCondition` members after the T1.8 re-type, so this
      // case still tests rejection rather than having silently become valid.
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("recoveryCondition");
    }
  });

  it("rejects a `failed` object whose recoverySpanClassification is off-union (cause surfaced on that path)", () => {
    // The negative control for the four-valued axis: admitting `unclassifiable`
    // as a legitimate driver answer did NOT make the classification open.
    const result = DriverResumeResultSchema.safeParse({
      status: "failed",
      recoveryCondition: "recovery-needed",
      recoverySpanClassification: "probably_fine",
      providerFailureDetail: "provider session expired",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("recoverySpanClassification");
    }
  });

  // --- arm-crossing members (.strict() on each arm) -------------------------

  it("rejects silent replacement — a `failed` object carrying a bindingId (.strict() arm guard; unrecognized key surfaced)", () => {
    // The runtime mirror of the I-005-5 compile proof above: a failed resume
    // that smuggles a `bindingId` is rejected because the `failed` arm is
    // `.strict()` and `bindingId` is not one of its keys. So neither the type
    // system NOR the runtime schema lets a failure carry a binding.
    const result = DriverResumeResultSchema.safeParse({
      status: "failed",
      recoveryCondition: "recovery-needed",
      recoverySpanClassification: "irreversible",
      providerFailureDetail: "provider session expired",
      bindingId: "binding-smuggled",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The rejection cause is specifically the smuggled `bindingId` key. A
      // `.strict()` rejection raises an `unrecognized_keys` issue whose path is
      // the object root (`[]`) and whose offending key names live on
      // `issue.keys` — so assert against `keys`, not `path`. This pins the
      // cause: a future fixture that grew a DIFFERENT defect cannot pass while
      // silently no longer exercising the binding-smuggle it claims to guard.
      const unrecognizedKeyIssue = result.error.issues.find(
        (issue) => issue.code === "unrecognized_keys",
      );
      expect(unrecognizedKeyIssue).toBeDefined();
      expect((unrecognizedKeyIssue as { keys?: readonly string[] })?.keys).toContain("bindingId");
    }
  });

  it("rejects a `failed` object carrying a sessionPosition (.strict(); a failure confirms no position)", () => {
    const result = DriverResumeResultSchema.safeParse({
      status: "failed",
      recoveryCondition: "recovery-needed",
      recoverySpanClassification: "irreversible",
      providerFailureDetail: "provider session expired",
      sessionPosition: 9,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const unrecognizedKeyIssue = result.error.issues.find(
        (issue) => issue.code === "unrecognized_keys",
      );
      expect((unrecognizedKeyIssue as { keys?: readonly string[] })?.keys).toContain(
        "sessionPosition",
      );
    }
  });

  it("rejects a `resumed` object carrying a recoverySpanClassification (.strict(); the span classification is a FAILURE axis)", () => {
    const result = DriverResumeResultSchema.safeParse({
      status: "resumed",
      bindingId: "binding-abc",
      sessionPosition: 3,
      recoverySpanClassification: "read_only",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const unrecognizedKeyIssue = result.error.issues.find(
        (issue) => issue.code === "unrecognized_keys",
      );
      expect((unrecognizedKeyIssue as { keys?: readonly string[] })?.keys).toContain(
        "recoverySpanClassification",
      );
    }
  });

  // --- wrong types + unknown discriminator ----------------------------------

  it("rejects a `resumed` object whose bindingId is a non-string (wrong-type at the trust boundary)", () => {
    expect(
      DriverResumeResultSchema.safeParse({
        status: "resumed",
        bindingId: 42,
        sessionPosition: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects a `failed` object whose providerFailureDetail is null (wrong-type at the trust boundary)", () => {
    expect(
      DriverResumeResultSchema.safeParse({
        status: "failed",
        recoveryCondition: "recovery-needed",
        recoverySpanClassification: "irreversible",
        providerFailureDetail: null,
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown status discriminator value", () => {
    expect(DriverResumeResultSchema.safeParse({ status: "pending" }).success).toBe(false);
  });

  // --- sessionPosition SHAPE bound (the recorded-position compare is Spec-015's)

  it.each([
    ["negative", -1],
    ["fractional", 2.5],
    ["not a number", "12"],
  ])(
    "rejects a resumed `sessionPosition` that is %s (shape bound only; the domain compare is the daemon's)",
    (_label, invalidValue) => {
      expect(
        DriverResumeResultSchema.safeParse({
          status: "resumed",
          bindingId: "binding-abc",
          sessionPosition: invalidValue,
        }).success,
      ).toBe(false);
    },
  );

  it("accepts a resumed `sessionPosition` of 0 (the inclusive floor — a session resumed at its first position)", () => {
    // `.min(0)` is INCLUSIVE: rejecting 0 would make a legitimately-at-the-start
    // session unreportable, and whether 0 is the position the daemon RECORDED is
    // the daemon's question, not this layer's.
    expect(
      DriverResumeResultSchema.safeParse({
        status: "resumed",
        bindingId: "binding-abc",
        sessionPosition: 0,
      }).success,
    ).toBe(true);
  });

  // wireFreeFormString bounds on the two untrusted free-form strings this
  // envelope persists / surfaces. `bindingId` carries `/\S/` + NUL guards as
  // defense-in-depth because it lands in `runtime_bindings` and on events — a
  // different rationale from the human-field guards, not a "stronger is better"
  // claim (see the schema comment in provider-driver.ts).

  it("accepts an in-bounds bindingId on the resumed arm", () => {
    expect(
      DriverResumeResultSchema.safeParse({
        status: "resumed",
        bindingId: "binding-abc",
        sessionPosition: 1,
      }).success,
    ).toBe(true);
  });

  it.each([
    ["empty string", ""],
    ["whitespace-only", "   "],
    ["NUL-containing", "a\u0000b"],
    ["over-max", "a".repeat(DRIVER_BINDING_ID_MAX_LEN + 1)],
  ])("rejects a `bindingId` that is %s (wireFreeFormString bound)", (_label, invalidValue) => {
    expect(
      DriverResumeResultSchema.safeParse({
        status: "resumed",
        bindingId: invalidValue,
        sessionPosition: 1,
      }).success,
    ).toBe(false);
  });

  it("accepts an in-bounds providerFailureDetail on the failed arm", () => {
    expect(
      DriverResumeResultSchema.safeParse({
        status: "failed",
        recoveryCondition: "recovery-needed",
        recoverySpanClassification: "irreversible",
        providerFailureDetail: "provider session expired",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["empty string", ""],
    ["whitespace-only", "   "],
    ["NUL-containing", "a\u0000b"],
    ["over-max", "a".repeat(DRIVER_FAILURE_DETAIL_MAX_LEN + 1)],
  ])(
    "rejects a `providerFailureDetail` that is %s (wireFreeFormString bound)",
    (_label, invalidValue) => {
      expect(
        DriverResumeResultSchema.safeParse({
          status: "failed",
          recoveryCondition: "recovery-needed",
          recoverySpanClassification: "irreversible",
          providerFailureDetail: invalidValue,
        }).success,
      ).toBe(false);
    },
  );

  // Inclusive `.max()` on both envelope strings: an exactly-MAX_LEN value must be
  // ACCEPTED (guards the inclusive boundary against an off-by-one regression).
  it("accepts a `bindingId` at exactly DRIVER_BINDING_ID_MAX_LEN (inclusive boundary)", () => {
    expect(
      DriverResumeResultSchema.safeParse({
        status: "resumed",
        bindingId: "a".repeat(DRIVER_BINDING_ID_MAX_LEN),
        sessionPosition: 1,
      }).success,
    ).toBe(true);
  });

  it("accepts a `providerFailureDetail` at exactly DRIVER_FAILURE_DETAIL_MAX_LEN (inclusive boundary)", () => {
    expect(
      DriverResumeResultSchema.safeParse({
        status: "failed",
        recoveryCondition: "recovery-needed",
        recoverySpanClassification: "irreversible",
        providerFailureDetail: "a".repeat(DRIVER_FAILURE_DETAIL_MAX_LEN),
      }).success,
    ).toBe(true);
  });
});

// ===========================================================================
// T1.7 — capability-flag currency: fourteen flags, canonical order, one
//        permanent exclusion.
// ===========================================================================
//
// `DRIVER_CAPABILITY_FLAGS` is the single source the union, the migration CHECK
// list, the write-seam cardinality guard, and the driver fixtures all derive
// from — so drift here is drift everywhere. These checks are written against
// HAND-SPELLED expectations rather than against the const itself: a check
// derived from the thing it checks is vacuous.

describe("DRIVER_CAPABILITY_FLAGS — T1.7 fourteen-flag currency", () => {
  it("carries exactly fourteen flags, in canonical §Shared Enums order", () => {
    expect([...DRIVER_CAPABILITY_FLAGS]).toEqual([
      "resume",
      "steer",
      "interactive_requests",
      "mcp",
      "tool_calls",
      "reasoning_stream",
      "model_mutation",
      "structured_output",
      "rollback",
      "session_goals",
      "callback_tools",
      "subagents",
      "transcript_replay",
      "cost_cap",
    ]);
    expect(DRIVER_CAPABILITY_FLAGS).toHaveLength(14);
  });

  it("declares no duplicate flag (the cardinality guard compares key COUNT, so a duplicate would mask an omission)", () => {
    expect(new Set(DRIVER_CAPABILITY_FLAGS).size).toBe(DRIVER_CAPABILITY_FLAGS.length);
  });

  it("places `transcript_replay` at its canonical position rather than at the end", () => {
    // The array order IS the canonical enum order, and the migration that
    // backfills a capability cache reads position, not membership — so a flag
    // appended for convenience would disagree with the enumeration every other
    // surface derives from. Asserted by INDEX so an append cannot pass.
    expect(DRIVER_CAPABILITY_FLAGS.indexOf("transcript_replay")).toBe(12);
    expect(DRIVER_CAPABILITY_FLAGS.at(-1)).toBe("cost_cap");
  });

  it("EXCLUDES `pause` — a permanent exclusion, not a pending one", () => {
    // ADR-011 models pause as an orchestration-layer construct (interrupt run,
    // persist state, queue resume), never a driver capability. Pinned by name so
    // the exclusion cannot be mistaken for an oversight.
    expect(DRIVER_CAPABILITY_FLAGS as readonly string[]).not.toContain("pause");
  });

  it("re-derives the DriverCapabilityFlag union from the runtime const (single source)", () => {
    // The binding below is a COMPILE-time assertion, and it catches exactly ONE
    // drift direction: a hand-written union that DROPPED a member would fail to
    // accept the const, because the const's element type would then carry a
    // literal the union lacks. The OPPOSITE direction — a union carrying a
    // member the const does not — still compiles here, and is caught instead by
    // the AC2 totality literals ABOVE, whose hand-written fourteen-key
    // `Record<DriverCapabilityFlag, boolean>` fails as INCOMPLETE the moment the
    // union outgrows the const. It compiles today BECAUSE the union is
    // `(typeof DRIVER_CAPABILITY_FLAGS)[number]` rather than a second listing.
    const flags: readonly DriverCapabilityFlag[] = DRIVER_CAPABILITY_FLAGS;
    // A DELIBERATE runtime anchor, not a redundant identity check: the
    // assertion this test makes is the compile above, so the executing
    // expectation restates the cardinality the union is derived from rather
    // than `toBe`-ing the const against itself, which would hold for any value.
    expect(flags).toHaveLength(14);
  });
});

// ===========================================================================
// T1.8 — `DriverRollbackResultSchema` (the `rollback`-gated parity envelope).
// ===========================================================================
//
// Same structural guarantee as `DriverResumeResult`, applied to a second
// operation: `sessionPosition` is REQUIRED on `applied`, so a rollback that
// "succeeded" without a confirmed floor cannot be expressed. `bindingId` stays
// optional (reserved for a future in-place mechanism, not for either shipped V1
// leg), and both arms are `.strict()`.

describe("DriverRollbackResultSchema — T1.8 rollback envelope", () => {
  it("parses an applied rollback carrying the confirmed floor", () => {
    const parsed: DriverRollbackResult = DriverRollbackResultSchema.parse({
      status: "applied",
      sessionPosition: 41,
    });
    expect(parsed).toEqual({ status: "applied", sessionPosition: 41 });
  });

  it("parses an applied rollback that repointed the run's live binding", () => {
    expect(
      DriverRollbackResultSchema.safeParse({
        status: "applied",
        sessionPosition: 0,
        bindingId: "binding-forked",
      }).success,
    ).toBe(true);
  });

  it("rejects an applied rollback with NO sessionPosition (a success without a confirmed floor)", () => {
    const result = DriverRollbackResultSchema.safeParse({ status: "applied" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("sessionPosition");
    }
  });

  it.each([
    ["negative", -1],
    ["fractional", 2.5],
    ["not a number", "12"],
  ])(
    "rejects a sessionPosition that is %s (shape bound; the domain checks are the daemon's)",
    (_label, invalidValue) => {
      expect(
        DriverRollbackResultSchema.safeParse({ status: "applied", sessionPosition: invalidValue })
          .success,
      ).toBe(false);
    },
  );

  it("forbids `sessionPosition` on the degraded arm after narrowing (compile-time)", () => {
    const degraded: DriverRollbackResult = DriverRollbackResultSchema.parse({
      status: "degraded",
      fallbackAction: "manual_rewind",
    });
    if (degraded.status === "degraded") {
      expect(degraded.fallbackAction).toBe("manual_rewind");
      // @ts-expect-error `sessionPosition` does not exist on the `degraded` variant (a degrade confirms no floor)
      const leakedPosition = degraded.sessionPosition;
      expect(leakedPosition).toBeUndefined();
    } else {
      throw new Error(`expected the degraded variant, got status=${degraded.status}`);
    }
  });

  it("rejects an unknown key on the applied arm (.strict())", () => {
    const result = DriverRollbackResultSchema.safeParse({
      status: "applied",
      sessionPosition: 3,
      forkedFrom: "turn-9",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const unrecognizedKeyIssue = result.error.issues.find(
        (issue) => issue.code === "unrecognized_keys",
      );
      expect((unrecognizedKeyIssue as { keys?: readonly string[] })?.keys).toContain("forkedFrom");
    }
  });

  it.each([
    ["empty string", ""],
    ["whitespace-only", "   "],
    ["NUL-containing", "a\u0000b"],
    ["over-max", "a".repeat(DRIVER_BINDING_ID_MAX_LEN + 1)],
  ])(
    "rejects a rollback `bindingId` that is %s (wireFreeFormString bound)",
    (_label, invalidValue) => {
      expect(
        DriverRollbackResultSchema.safeParse({
          status: "applied",
          sessionPosition: 1,
          bindingId: invalidValue,
        }).success,
      ).toBe(false);
    },
  );

  it("accepts a rollback `bindingId` at exactly DRIVER_BINDING_ID_MAX_LEN (inclusive boundary)", () => {
    expect(
      DriverRollbackResultSchema.safeParse({
        status: "applied",
        sessionPosition: 1,
        bindingId: "a".repeat(DRIVER_BINDING_ID_MAX_LEN),
      }).success,
    ).toBe(true);
  });

  it.each([
    ["empty string", ""],
    ["whitespace-only", "   "],
    ["NUL-containing", "a\u0000b"],
    ["over-max", "a".repeat(DRIVER_FALLBACK_ACTION_MAX_LEN + 1)],
  ])(
    "rejects a rollback `fallbackAction` that is %s (wireFreeFormString bound)",
    (_label, invalidValue) => {
      expect(
        DriverRollbackResultSchema.safeParse({ status: "degraded", fallbackAction: invalidValue })
          .success,
      ).toBe(false);
    },
  );
});

// ===========================================================================
// T1.8 — `DriverGoalResultSchema` (the `session_goals`-gated parity envelope).
// ===========================================================================

describe("DriverGoalResultSchema — T1.8 session-goal envelope", () => {
  it("parses a bare applied result", () => {
    const parsed: DriverGoalResult = DriverGoalResultSchema.parse({ status: "applied" });
    expect(parsed).toEqual({ status: "applied" });
  });

  it("REJECTS a fallbackAction on the applied arm (a fallback narrative on a success is unrepresentable)", () => {
    // The load-bearing case for choosing a discriminated union here over the
    // flat `DriverInterventionResult` shape: the flat shape would have accepted
    // this silently.
    const result = DriverGoalResultSchema.safeParse({
      status: "applied",
      fallbackAction: "queue_and_retry",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const unrecognizedKeyIssue = result.error.issues.find(
        (issue) => issue.code === "unrecognized_keys",
      );
      expect((unrecognizedKeyIssue as { keys?: readonly string[] })?.keys).toContain(
        "fallbackAction",
      );
    }
  });

  it("forbids `fallbackAction` on the applied arm after narrowing (compile-time mirror)", () => {
    const applied: DriverGoalResult = DriverGoalResultSchema.parse({ status: "applied" });
    if (applied.status === "applied") {
      // @ts-expect-error `fallbackAction` does not exist on the `applied` variant
      const leakedFallback = applied.fallbackAction;
      expect(leakedFallback).toBeUndefined();
    } else {
      throw new Error(`expected the applied variant, got status=${applied.status}`);
    }
  });

  it("parses a degraded result with and without a fallbackAction", () => {
    expect(DriverGoalResultSchema.safeParse({ status: "degraded" }).success).toBe(true);
    expect(
      DriverGoalResultSchema.safeParse({ status: "degraded", fallbackAction: "prompt_prefix" })
        .success,
    ).toBe(true);
  });

  it("rejects an unknown status discriminator value", () => {
    expect(DriverGoalResultSchema.safeParse({ status: "queued" }).success).toBe(false);
  });

  it.each([
    ["empty string", ""],
    ["whitespace-only", "   "],
    ["NUL-containing", "a\u0000b"],
    ["over-max", "a".repeat(DRIVER_FALLBACK_ACTION_MAX_LEN + 1)],
  ])(
    "rejects a goal `fallbackAction` that is %s (wireFreeFormString bound)",
    (_label, invalidValue) => {
      expect(
        DriverGoalResultSchema.safeParse({ status: "degraded", fallbackAction: invalidValue })
          .success,
      ).toBe(false);
    },
  );

  it("accepts a goal `fallbackAction` at exactly DRIVER_FALLBACK_ACTION_MAX_LEN (inclusive boundary)", () => {
    expect(
      DriverGoalResultSchema.safeParse({
        status: "degraded",
        fallbackAction: "a".repeat(DRIVER_FALLBACK_ACTION_MAX_LEN),
      }).success,
    ).toBe(true);
  });
});

// ===========================================================================
// T1.8 — `DriverAuthProbeResultSchema` (the flagless zero-turn probe).
// ===========================================================================
//
// Three values, not a boolean: `indeterminate` is fail-closed for admission but
// stays DISTINGUISHABLE from `unauthenticated`, so probe health and credential
// state never collapse into one another.

describe("DriverAuthProbeResultSchema — T1.8 auth-probe envelope", () => {
  it.each(["authenticated", "unauthenticated", "indeterminate"] as const)(
    "parses the %s status",
    (status) => {
      const parsed: DriverAuthProbeResult = DriverAuthProbeResultSchema.parse({ status });
      expect(parsed.status).toBe(status);
    },
  );

  it("preserves an optional provider-reported detail", () => {
    expect(
      DriverAuthProbeResultSchema.parse({
        status: "authenticated",
        detail: "Team plan — operator@example.test",
      }).detail,
    ).toBe("Team plan — operator@example.test");
  });

  it("rejects an off-enum status (a fourth probe verdict is unrepresentable)", () => {
    expect(DriverAuthProbeResultSchema.safeParse({ status: "expired" }).success).toBe(false);
  });

  it("rejects a missing status", () => {
    const result = DriverAuthProbeResultSchema.safeParse({ detail: "Pro plan" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("status");
    }
  });

  it("rejects an unknown key (.strict())", () => {
    const result = DriverAuthProbeResultSchema.safeParse({
      status: "authenticated",
      expiresAt: "2026-09-01T00:00:00Z",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const unrecognizedKeyIssue = result.error.issues.find(
        (issue) => issue.code === "unrecognized_keys",
      );
      expect((unrecognizedKeyIssue as { keys?: readonly string[] })?.keys).toContain("expiresAt");
    }
  });

  it.each([
    ["empty string", ""],
    ["whitespace-only", "   "],
    ["NUL-containing", "a\u0000b"],
    ["over-max", "a".repeat(DRIVER_AUTH_DETAIL_MAX_LEN + 1)],
  ])("rejects a probe `detail` that is %s (wireFreeFormString bound)", (_label, invalidValue) => {
    expect(
      DriverAuthProbeResultSchema.safeParse({ status: "authenticated", detail: invalidValue })
        .success,
    ).toBe(false);
  });

  it("accepts a probe `detail` at exactly DRIVER_AUTH_DETAIL_MAX_LEN (inclusive boundary)", () => {
    expect(
      DriverAuthProbeResultSchema.safeParse({
        status: "authenticated",
        detail: "a".repeat(DRIVER_AUTH_DETAIL_MAX_LEN),
      }).success,
    ).toBe(true);
  });
});

// ===========================================================================
// T1.8 — the two driver-normalized SEAM schemas.
// ===========================================================================
//
// `CallbackToolInvocation` and `McpServerStatusEmission` are built by the driver
// from untrusted provider wire output, and these parses are the last point
// before the values reach daemon-owned code. Both are `.strict()` — unlike the
// tolerant-reader `ProviderToolMetadataSchema` — because they are fixed-field
// DRIVER constructions, not extensible PROVIDER declarations.

describe("CallbackToolInvocationSchema — T1.8 callback-tool dispatch seam", () => {
  const validInvocation = {
    toolName: "request_approval",
    arguments: { path: "/workspace/src/index.ts" },
    toolCallId: "call_01H8XYZ",
    sessionId: SESSION_UUID,
    runId: RUN_UUID,
  };

  it("parses a well-formed invocation and preserves the correlation id verbatim", () => {
    const parsed = CallbackToolInvocationSchema.parse(validInvocation);
    // Verbatim, because tool-event pairing is exact-string match — a normalized
    // id would silently break the pairing rather than fail loudly.
    expect(parsed.toolCallId).toBe("call_01H8XYZ");
    expect(parsed.arguments).toEqual({ path: "/workspace/src/index.ts" });
  });

  it("accepts an empty arguments object (a zero-argument tool is legitimate)", () => {
    expect(
      CallbackToolInvocationSchema.safeParse({ ...validInvocation, arguments: {} }).success,
    ).toBe(true);
  });

  it("rejects a non-object `arguments` (a JSON-Schema-validated payload must be an object)", () => {
    expect(
      CallbackToolInvocationSchema.safeParse({ ...validInvocation, arguments: "path=x" }).success,
    ).toBe(false);
  });

  it("rejects a malformed runId (branded-uuid bound, without minting the deferred RunIdSchema)", () => {
    expect(
      CallbackToolInvocationSchema.safeParse({ ...validInvocation, runId: "run-7" }).success,
    ).toBe(false);
  });

  it("rejects a malformed sessionId", () => {
    expect(
      CallbackToolInvocationSchema.safeParse({ ...validInvocation, sessionId: "session-7" })
        .success,
    ).toBe(false);
  });

  it("rejects an unknown key (.strict() — an unknown key here is a driver bug, not forward-compat)", () => {
    const result = CallbackToolInvocationSchema.safeParse({
      ...validInvocation,
      providerRequestId: "req-9",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const unrecognizedKeyIssue = result.error.issues.find(
        (issue) => issue.code === "unrecognized_keys",
      );
      expect((unrecognizedKeyIssue as { keys?: readonly string[] })?.keys).toContain(
        "providerRequestId",
      );
    }
  });

  it.each([
    ["empty string", ""],
    ["whitespace-only", "   "],
    ["NUL-containing", "a\u0000b"],
    ["over-max", "a".repeat(DRIVER_TOOL_NAME_MAX_LEN + 1)],
  ])("rejects a `toolName` that is %s (wireFreeFormString bound)", (_label, invalidValue) => {
    expect(
      CallbackToolInvocationSchema.safeParse({ ...validInvocation, toolName: invalidValue })
        .success,
    ).toBe(false);
  });

  it.each([
    ["empty string", ""],
    ["whitespace-only", "   "],
    ["NUL-containing", "a\u0000b"],
    ["over-max", "a".repeat(DRIVER_TOOL_CALL_ID_MAX_LEN + 1)],
  ])("rejects a `toolCallId` that is %s (wireFreeFormString bound)", (_label, invalidValue) => {
    expect(
      CallbackToolInvocationSchema.safeParse({ ...validInvocation, toolCallId: invalidValue })
        .success,
    ).toBe(false);
  });

  it("accepts a `toolCallId` at exactly DRIVER_TOOL_CALL_ID_MAX_LEN (inclusive boundary)", () => {
    expect(
      CallbackToolInvocationSchema.safeParse({
        ...validInvocation,
        toolCallId: "a".repeat(DRIVER_TOOL_CALL_ID_MAX_LEN),
      }).success,
    ).toBe(true);
  });
});

describe("McpServerStatusEmissionSchema — T1.8 MCP status producer seam", () => {
  it.each(["unknown", "starting", "connected", "needs-auth", "failed"] as const)(
    "parses the %s server status",
    (status) => {
      expect(McpServerStatusEmissionSchema.parse({ serverName: "filesystem", status }).status).toBe(
        status,
      );
    },
  );

  it("rejects an off-enum status", () => {
    expect(
      McpServerStatusEmissionSchema.safeParse({ serverName: "filesystem", status: "degraded" })
        .success,
    ).toBe(false);
  });

  it("rejects a driver-supplied leg identity (.strict() — the daemon stamps it, never the driver)", () => {
    // The security property this schema enforces: a driver that tried to
    // attribute its emission to another leg is rejected outright rather than
    // having the field quietly stripped.
    const result = McpServerStatusEmissionSchema.safeParse({
      serverName: "filesystem",
      status: "connected",
      bindingId: "binding-of-another-leg",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const unrecognizedKeyIssue = result.error.issues.find(
        (issue) => issue.code === "unrecognized_keys",
      );
      expect((unrecognizedKeyIssue as { keys?: readonly string[] })?.keys).toContain("bindingId");
    }
  });

  it.each([
    ["empty string", ""],
    ["whitespace-only", "   "],
    ["NUL-containing", "a\u0000b"],
    ["over-max", "a".repeat(DRIVER_MCP_SERVER_NAME_MAX_LEN + 1)],
  ])("rejects a `serverName` that is %s (wireFreeFormString bound)", (_label, invalidValue) => {
    expect(
      McpServerStatusEmissionSchema.safeParse({ serverName: invalidValue, status: "connected" })
        .success,
    ).toBe(false);
  });

  it("accepts a `serverName` at exactly DRIVER_MCP_SERVER_NAME_MAX_LEN (inclusive boundary)", () => {
    expect(
      McpServerStatusEmissionSchema.safeParse({
        serverName: "a".repeat(DRIVER_MCP_SERVER_NAME_MAX_LEN),
        status: "connected",
      }).success,
    ).toBe(true);
  });

  it("stamps leg identity on the consumer-facing McpServerStatusUpdate (daemon-side shape)", () => {
    const update: McpServerStatusUpdate = {
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
      serverName: "filesystem",
      status: "connected",
    };
    expect(update.bindingId).toBe("binding-abc");
  });
});

// ===========================================================================
// T1.8 — `InterventionType` widens to four; the DISPATCH surface stays three.
// ===========================================================================
//
// The union is the intervention VOCABULARY; `ApplyInterventionParams`' arm set is
// the DISPATCH surface. They are deliberately not the same set, because a
// rollback's driver leg is the dedicated capability-gated `rollbackTo` operation.
// A fourth arm here would create a second, UNGATED route to the same provider
// mechanism — which is exactly what these cases pin.

describe("InterventionType — T1.8 three→four widening with a three-armed dispatch surface", () => {
  it("carries exactly the four canonical members", () => {
    const allInterventionTypes: InterventionType[] = ["steer", "interrupt", "cancel", "rollback"];
    expect(allInterventionTypes).toHaveLength(4);
    expect(allInterventionTypes).toContain("rollback");
  });

  it("still rejects `pause` as an InterventionType (ADR-011, unchanged by the widening)", () => {
    // @ts-expect-error `pause` is not an InterventionType — ADR-011 models pause as an orchestration-layer construct
    const notAnInterventionType: InterventionType = "pause";
    expect(notAnInterventionType).toBe("pause");
  });

  it("forbids a `rollback` arm on ApplyInterventionParams (compile-time; its leg is `rollbackTo`)", () => {
    const rollbackDispatch: ApplyInterventionParams = {
      // @ts-expect-error `ApplyInterventionParams` stays three-armed — there is no `rollback` dispatch arm
      type: "rollback",
      targetRunId: RUN_ID,
      expectedRunVersion: 1,
      clientIdempotencyKey: CLIENT_IDEMPOTENCY_KEY,
      payload: { reason: "rewind to the last green turn" },
    };
    void rollbackDispatch;
  });
});

// ===========================================================================
// B3 — `clientIdempotencyKey` is MANDATORY on every dispatch arm.
// ===========================================================================
//
// The requester-generated UUID the daemon dedupes on against the `interventions`
// UNIQUE guard — what converts an AT-LEAST-ONCE delivery into EXACTLY-ONCE
// application, so a retried steer re-applies nothing. Non-optional on all three
// arms for the same reason `expectedRunVersion` is: an absent key must be a type
// error, never a silently non-deduped intervention. Each arm declares the member
// SEPARATELY, so all three omissions are proven rather than one standing in for
// the set. Proven by COMPILATION; each `@ts-expect-error` is self-verifying
// under TS2578 (an unused directive is itself an error).

describe("ApplyInterventionParams — B3 mandatory clientIdempotencyKey", () => {
  it("carries the key on all three dispatch arms", () => {
    const steer: ApplyInterventionParams = {
      type: "steer",
      targetRunId: RUN_ID,
      expectedRunVersion: 1,
      clientIdempotencyKey: CLIENT_IDEMPOTENCY_KEY,
      payload: { content: "stay on task" },
    };
    const interrupt: ApplyInterventionParams = {
      type: "interrupt",
      targetRunId: RUN_ID,
      expectedRunVersion: 2,
      clientIdempotencyKey: CLIENT_IDEMPOTENCY_KEY,
      payload: { reason: "operator halt" },
    };
    const cancel: ApplyInterventionParams = {
      type: "cancel",
      targetRunId: RUN_ID,
      expectedRunVersion: 3,
      clientIdempotencyKey: CLIENT_IDEMPOTENCY_KEY,
      payload: { reason: "superseded" },
    };
    // The key is carried VERBATIM — the daemon dedupes on exact match, so a
    // contract that normalized it would silently break the dedupe rather than
    // fail loudly (the same verbatim discipline as `toolCallId` below).
    expect(steer.clientIdempotencyKey).toBe(CLIENT_IDEMPOTENCY_KEY);
    expect(interrupt.clientIdempotencyKey).toBe(CLIENT_IDEMPOTENCY_KEY);
    expect(cancel.clientIdempotencyKey).toBe(CLIENT_IDEMPOTENCY_KEY);
  });

  it("forbids omitting clientIdempotencyKey on the steer arm (compile-time)", () => {
    // @ts-expect-error `clientIdempotencyKey` is REQUIRED — an absent key would be a non-deduped steer, not a type-checked one
    const steerWithoutKey: ApplyInterventionParams = {
      type: "steer",
      targetRunId: RUN_ID,
      expectedRunVersion: 1,
      payload: { content: "stay on task" },
    };
    void steerWithoutKey;
  });

  it("forbids omitting clientIdempotencyKey on the interrupt arm (compile-time)", () => {
    // @ts-expect-error `clientIdempotencyKey` is REQUIRED on the interrupt arm too — each arm declares it separately
    const interruptWithoutKey: ApplyInterventionParams = {
      type: "interrupt",
      targetRunId: RUN_ID,
      expectedRunVersion: 1,
      payload: { reason: "operator halt" },
    };
    void interruptWithoutKey;
  });

  it("forbids omitting clientIdempotencyKey on the cancel arm (compile-time)", () => {
    // @ts-expect-error `clientIdempotencyKey` is REQUIRED on the cancel arm too — each arm declares it separately
    const cancelWithoutKey: ApplyInterventionParams = {
      type: "cancel",
      targetRunId: RUN_ID,
      expectedRunVersion: 1,
      payload: { reason: "superseded" },
    };
    void cancelWithoutKey;
  });
});

// ===========================================================================
// T1.8 — `RecoveryCondition` re-type on the resume `failed` variant.
// ===========================================================================

describe("DriverResumeResultSchema — T1.8 RecoveryCondition re-type", () => {
  it.each(["recovery-needed", "reauth-required"] as const)(
    "accepts the %s condition on the failed variant",
    (recoveryCondition) => {
      const parsed: DriverResumeResult = DriverResumeResultSchema.parse({
        status: "failed",
        recoveryCondition,
        recoverySpanClassification: "unclassifiable",
        providerFailureDetail: "provider credential expired",
      });
      if (parsed.status === "failed") {
        expect(parsed.recoveryCondition).toBe(recoveryCondition);
      } else {
        throw new Error(`expected the failed variant, got status=${parsed.status}`);
      }
    },
  );

  it("still rejects a third condition (the union is two-valued, not open)", () => {
    // The negative control for the widening: `reauth-required` now parses, but
    // the schema did not become permissive in the process. Every other member is
    // valid here, so the sole defect is the off-union condition.
    expect(
      DriverResumeResultSchema.safeParse({
        status: "failed",
        recoveryCondition: "retry-later",
        recoverySpanClassification: "unclassifiable",
        providerFailureDetail: "provider credential expired",
      }).success,
    ).toBe(false);
  });
});

// ===========================================================================
// `RecoverySpanClassification` — the SECOND recovery axis on the failed variant.
// ===========================================================================
//
// Not a widening of `RecoveryCondition` but a sibling of it: that axis names WHY
// the run needs an operator, this one names WHAT the halted span contains, so
// policy can tier on blast radius. V1 consumes it as AUDIT METADATA only (every
// divergence still halts for a human), which is exactly why recording it now
// makes tiered auto-resolution a future POLICY flip rather than a schema change.
//
// REQUIRED on this LIVE driver return — the optional form the replay-visible
// carriers take exists only to admit pre-amendment history, and a resume failure
// is produced fresh at resume time and never replayed. A driver that cannot
// classify emits `unclassifiable`, which the consumer must handle exactly as
// `irreversible` (the fail-closed default), rather than omitting the axis.

describe("DriverResumeResultSchema — RecoverySpanClassification on the failed variant", () => {
  it("carries exactly the four canonical members", () => {
    // Hand-spelled rather than derived from the type: a list derived from the
    // thing it checks would agree by construction and could never catch a member
    // silently added or removed. The typed binding is the lockstep proof — an
    // off-union entry here would not compile.
    const allSpanClassifications: RecoverySpanClassification[] = [
      "read_only",
      "idempotent_write",
      "irreversible",
      "unclassifiable",
    ];
    expect(allSpanClassifications).toHaveLength(4);
    expect(allSpanClassifications).toContain("unclassifiable");
  });

  it.each(["read_only", "idempotent_write", "irreversible", "unclassifiable"] as const)(
    "accepts the %s classification on the failed variant",
    (recoverySpanClassification) => {
      const parsed: DriverResumeResult = DriverResumeResultSchema.parse({
        status: "failed",
        recoveryCondition: "recovery-needed",
        recoverySpanClassification,
        providerFailureDetail: "provider session diverged mid-turn",
      });
      if (parsed.status === "failed") {
        expect(parsed.recoverySpanClassification).toBe(recoverySpanClassification);
      } else {
        throw new Error(`expected the failed variant, got status=${parsed.status}`);
      }
    },
  );

  it("accepts `unclassifiable` — the fail-closed answer a driver gives instead of omitting the axis", () => {
    // Called out on its own rather than left to the `it.each` above because it
    // is the member that makes the REQUIRED-ness workable: a driver with no way
    // to classify the span has a legitimate value to send, so omission is
    // unambiguously a protocol defect rather than an honest silence.
    const parsed: DriverResumeResult = DriverResumeResultSchema.parse({
      status: "failed",
      recoveryCondition: "reauth-required",
      recoverySpanClassification: "unclassifiable",
      providerFailureDetail: "provider closed the stream mid-tool-call",
    });
    if (parsed.status === "failed") {
      expect(parsed.recoverySpanClassification).toBe("unclassifiable");
    } else {
      throw new Error(`expected the failed variant, got status=${parsed.status}`);
    }
  });

  it("keeps the two axes independent — both conditions pair with any classification", () => {
    // The structural claim behind NOT folding this into `RecoveryCondition`: the
    // cross product is legal, so a `reauth-required` failure over a `read_only`
    // span is expressible and routes on remediation and blast radius separately.
    expect(
      DriverResumeResultSchema.safeParse({
        status: "failed",
        recoveryCondition: "reauth-required",
        recoverySpanClassification: "read_only",
        providerFailureDetail: "provider credential expired",
      }).success,
    ).toBe(true);
  });
});

// ===========================================================================
// T1.8 — spawn/turn parity surfaces: structural invariants, not runtime checks.
// ===========================================================================
//
// Everything in this block is proven by COMPILATION. Each `@ts-expect-error` is
// self-verifying: if the shape ever loosened, the unused directive would itself
// become a TS2578 error under `tsc -p tsconfig.test.json`.

describe("T1.8 spawn/turn parity surfaces — structural invariants", () => {
  const allFlagsDenied: DriverCapabilities["flags"] = {
    resume: false,
    steer: false,
    interactive_requests: false,
    mcp: false,
    tool_calls: false,
    reasoning_stream: false,
    model_mutation: false,
    structured_output: false,
    rollback: false,
    session_goals: false,
    callback_tools: false,
    subagents: false,
    transcript_replay: false,
    cost_cap: false,
  };

  it("requires `cliVersion` on GetCapabilitiesResult (fail-closed by construction)", () => {
    // @ts-expect-error `cliVersion` is REQUIRED — a report without a parseable provider version never reaches the daemon
    const reportWithoutVersion: GetCapabilitiesResult = {
      capabilities: { flags: allFlagsDenied, contractVersion: "1.0" },
      tools: [],
    };
    void reportWithoutVersion;
  });

  it("carries all five spawn-bound parity legs on CreateSessionParams", () => {
    const callbackTools: SessionCallbackTool[] = [
      {
        name: "request_approval",
        description: "Ask the operator.",
        inputSchema: { type: "object" },
      },
    ];
    const subagentPolicy: SubagentPolicy = {
      enabled: true,
      maxDepth: 2,
      maxConcurrent: 3,
      definitions: [{ name: "reviewer" }],
    };
    const posture: ExecutionPosture = {
      networkAccess: "allowed-domains",
      allowedDomains: ["api.example.test"],
      writableRoots: ["/workspace"],
      mode: "workspace-sandboxed",
      credentialPolicyRef: "sha256:0f1e2d",
    };
    const params: CreateSessionParams = {
      sessionId: SESSION_ID,
      config: {},
      executionPosture: posture,
      callbackTools,
      subagentPolicy,
      outputSchema: { type: "object", properties: { verdict: { type: "string" } } },
      onCallbackToolCall: () => Promise.resolve({ status: "completed", output: { ok: true } }),
      onMcpServerStatus: () => undefined,
    };
    expect(params.callbackTools).toHaveLength(1);
    expect(params.subagentPolicy).toEqual(subagentPolicy);
  });

  it("re-declares the same spawn-bound class on ResumeSessionParams (resume is a fresh spawn)", () => {
    // The security property: a resume that could not re-realize posture would
    // relaunch UNSANDBOXED. Binding the full set on the resume seam is the
    // compile-time proof that it is not narrower than the create seam.
    const posture: ExecutionPosture = {
      networkAccess: "none",
      writableRoots: ["/workspace"],
      mode: "readonly-sandboxed",
      credentialPolicyRef: "sha256:0f1e2d",
    };
    const resumeParams: ResumeSessionParams = {
      sessionId: SESSION_ID,
      resumeHandle: "resume-handle-opaque",
      executionPosture: posture,
      callbackTools: [],
      subagentPolicy: { enabled: false },
      outputSchema: { type: "object" },
      onCallbackToolCall: () => Promise.resolve({ status: "denied", error: "not approved" }),
      onMcpServerStatus: () => undefined,
    };
    expect(resumeParams.executionPosture).toBe(posture);
  });

  it("carries the per-turn posture and outputSchema on StartRunParams", () => {
    const startParams: StartRunParams = {
      runId: RUN_ID,
      channelId: CHANNEL_ID,
      agentConfig: {},
      executionPosture: { networkAccess: "full", writableRoots: [], mode: "trusted" },
      outputSchema: { type: "object" },
    };
    expect(startParams.outputSchema).toEqual({ type: "object" });
  });

  it("forbids `allowedDomains` outside the allowed-domains network mode (compile-time)", () => {
    // The tuple annotation is load-bearing: a bare `["api.example.test"]` widens
    // to `string[]`, and TS then reports an ARITY mismatch on the property line
    // rather than the EXCLUSION on the declaration — testing the wrong thing.
    // Annotated as the tuple, the only remaining defect is the exclusion itself.
    // @ts-expect-error `allowedDomains` is structurally absent unless networkAccess is "allowed-domains"
    const posture: ExecutionPosture = {
      networkAccess: "none",
      allowedDomains: ["api.example.test"] as [string, ...string[]],
      writableRoots: [],
      mode: "trusted",
    };
    void posture;
  });

  it("forbids an EMPTY allowedDomains list (non-empty by construction, so no fail-open reading)", () => {
    const posture: ExecutionPosture = {
      networkAccess: "allowed-domains",
      // @ts-expect-error `[string, ...string[]]` rejects `[]` — an allow-list mode with nothing allowed is unrepresentable
      allowedDomains: [],
      writableRoots: [],
      mode: "trusted",
    };
    void posture;
  });

  it("requires credentialPolicyRef on a sandboxed mode (compile-time)", () => {
    // @ts-expect-error `credentialPolicyRef` is REQUIRED on both sandboxed modes
    const posture: ExecutionPosture = {
      networkAccess: "full",
      writableRoots: ["/workspace"],
      mode: "workspace-sandboxed",
    };
    void posture;
  });

  it("forbids credentialPolicyRef under mode:'trusted' (a trusted run enforces no credential constraint)", () => {
    // @ts-expect-error a trusted posture carries no credentialPolicyRef
    const posture: ExecutionPosture = {
      networkAccess: "full",
      writableRoots: [],
      mode: "trusted",
      credentialPolicyRef: "sha256:0f1e2d",
    };
    void posture;
  });

  it("forbids output on a denied CallbackToolResult and an error on a completed one", () => {
    // @ts-expect-error a `denied` result carries no output
    const deniedWithOutput: CallbackToolResult = { status: "denied", output: { leaked: true } };
    // @ts-expect-error a `completed` result carries no error
    const completedWithError: CallbackToolResult = { status: "completed", error: "boom" };
    void deniedWithOutput;
    void completedWithError;
  });

  it("forbids a disabled SubagentPolicy that still carries limits (off-but-configured is unrepresentable)", () => {
    const policy: SubagentPolicy = {
      enabled: false,
      // @ts-expect-error the `enabled: false` arm carries no limits or definitions
      maxDepth: 2,
      maxConcurrent: 1,
      definitions: [],
    };
    void policy;
  });

  it("forbids an unauthenticated websocket DriverTransportConfig", () => {
    const stdio: DriverTransportConfig = { transport: "stdio" };
    expect(stdio.transport).toBe("stdio");
    // @ts-expect-error the websocket arm REQUIRES a bearerTokenRef — an unauthenticated ws listener is unrepresentable
    const unauthenticated: DriverTransportConfig = {
      transport: "websocket",
      endpoint: "ws://127.0.0.1:7000",
    };
    void unauthenticated;
  });
});

// ===========================================================================
// T3.19 — the canonical transcript export/replay envelopes.
// ===========================================================================
//
// Both envelopes parse UNTRUSTED driver output, so the units below assert what
// `.strict()` rejects as well as what the schemas accept. The frame array gets a
// dedicated round-trip case: `frames` is typed `z.array(z.unknown())`, and an
// `unknown` element inside a Zod object has surprising optionality semantics —
// so "the frames come back byte-for-byte" is asserted rather than assumed.

describe("DriverTranscriptExportResultSchema — the canonical transcript export envelope", () => {
  it("round-trips provider-shaped frames without stripping or reshaping them", () => {
    const frames: unknown[] = [
      { role: "participant", origin: "participant_text", segments: [{ kind: "text", text: "hi" }] },
      { role: "assistant", segments: [{ kind: "tool_call", toolCallId: "call-1" }] },
      "an opaque string frame",
      42,
      null,
    ];
    const parsed: DriverTranscriptExportResult = DriverTranscriptExportResultSchema.parse({
      frames,
      declaredLosses: ["provider_private_reasoning", "tool_call_history_repaired"],
    });
    expect(parsed.frames).toEqual(frames);
    expect(parsed.frames).toHaveLength(5);
    expect(parsed.declaredLosses).toEqual([
      "provider_private_reasoning",
      "tool_call_history_repaired",
    ]);
  });

  it("accepts an EMPTY declared-loss list as the positive claim that nothing was dropped", () => {
    const parsed = DriverTranscriptExportResultSchema.parse({ frames: [], declaredLosses: [] });
    expect(parsed.declaredLosses).toEqual([]);
  });

  it("admits the unreadable-body loss, so a fold that could not read one may say so", () => {
    const parsed = DriverTranscriptExportResultSchema.parse({
      frames: [],
      declaredLosses: ["turn_content_unavailable"],
    });
    expect(parsed.declaredLosses).toEqual(["turn_content_unavailable"]);
  });

  it("rejects a declared loss outside the closed set", () => {
    const result = DriverTranscriptExportResultSchema.safeParse({
      frames: [],
      declaredLosses: ["context_window_exceeded"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown key — the envelope is strict", () => {
    const result = DriverTranscriptExportResultSchema.safeParse({
      frames: [],
      declaredLosses: [],
      truncated: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing frames array rather than defaulting it to empty", () => {
    const result = DriverTranscriptExportResultSchema.safeParse({ declaredLosses: [] });
    expect(result.success).toBe(false);
  });
});

describe("DriverTranscriptReplayResultSchema — the canonical transcript replay envelope", () => {
  it("carries the declared-loss list on BOTH status arms", () => {
    const applied: DriverTranscriptReplayResult = DriverTranscriptReplayResultSchema.parse({
      status: "applied",
      declaredLosses: ["provider_private_reasoning"],
    });
    const degraded: DriverTranscriptReplayResult = DriverTranscriptReplayResultSchema.parse({
      status: "degraded",
      declaredLosses: ["conversation_history_summarized"],
    });
    expect(applied.declaredLosses).toEqual(["provider_private_reasoning"]);
    expect(degraded.declaredLosses).toEqual(["conversation_history_summarized"]);
  });

  it("rejects a third status — the driver result vocabulary stays two-valued", () => {
    const result = DriverTranscriptReplayResultSchema.safeParse({
      status: "failed",
      declaredLosses: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a status carrying no declared-loss list", () => {
    const result = DriverTranscriptReplayResultSchema.safeParse({ status: "applied" });
    expect(result.success).toBe(false);
  });
});

describe("transcript operation params — nominal shapes", () => {
  it("carries an already-bounded projection on an export request, and no second bound", () => {
    const params: ExportTranscriptParams = {
      sessionId: "session-transcript-1" as SessionId,
      transcript: {
        sessionId: "session-transcript-1" as SessionId,
        runId: "run-transcript-1" as RunId,
        builtAtPosition: 41,
        turns: [{ position: 7, role: "participant", segments: [{ kind: "text", text: "go" }] }],
      },
    };
    expect(params.transcript.turns).toHaveLength(1);
    // The bound lives in the turns the fold produced, not beside them: the
    // request carries no member a driver could read as a second answer to
    // "where does this transcript end?".
    expect([...Object.keys(params)].sort()).toStrictEqual(["sessionId", "transcript"]);
  });

  it("targets a session handle a replay writes into, never the source session", () => {
    const params: ReplayTranscriptParams = {
      target: { providerSessionId: "provider-fresh-1", resumeHandle: "resume-fresh-1" },
      frames: [{ role: "assistant", segments: [] }],
    };
    expect(params.target.providerSessionId).toBe("provider-fresh-1");
    expect(params.frames).toHaveLength(1);
  });
});
