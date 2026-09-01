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
//   • AC2 (`Spec-005 §Acceptance Criteria`) — a capability flag outside the 17-flag
//     `DriverCapabilityFlag` union is a TS error (`@ts-expect-error`, self-
//     verifying via TS2578 if the invalid flag ever became valid).
//   • T1.7 flag currency — `DRIVER_CAPABILITY_FLAGS` carries exactly the seventeen
//     canonical flags in canonical §Shared Enums order, `transcript_replay`
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
  DECLARED_LOSS_KINDS,
  DRIVER_AUTH_DETAIL_MAX_LEN,
  DRIVER_BINDING_ID_MAX_LEN,
  DRIVER_CAPABILITY_FLAGS,
  DRIVER_FAILURE_DETAIL_MAX_LEN,
  DRIVER_FALLBACK_ACTION_MAX_LEN,
  DRIVER_MCP_SERVER_NAME_MAX_LEN,
  DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN,
  DRIVER_PROVIDER_COMMAND_ENTRIES_MAX,
  DRIVER_TOOL_CALL_ID_MAX_LEN,
  DRIVER_TOOL_DESCRIPTION_MAX_LEN,
  DRIVER_TOOL_NAME_MAX_LEN,
  DRIVER_WIRE_CATALOG_ENTRIES_MAX,
  DRIVER_WIRE_CONTRACT_VERSION_MAX_LEN,
  DRIVER_WIRE_HANDLE_MAX_LEN,
  DRIVER_WIRE_REASON_MAX_LEN,
  DRIVER_WIRE_STEER_ATTACHMENTS_MAX,
  DRIVER_WIRE_STEER_CONTENT_MAX_LEN,
  DRIVER_WIRE_TOKEN_MAX_LEN,
  RECOVERY_CONDITIONS,
  RECOVERY_SPAN_CLASSIFICATIONS,
  ApplyInterventionParamsSchema,
  CallbackToolInvocationSchema,
  DriverAckResultSchema,
  DriverCapabilitiesSchema,
  DriverCapabilityReportSchema,
  DriverReadParamsSchema,
  DriverSubscribeEventsParamsSchema,
  InterruptRunParamsSchema,
  ListCapabilitiesResultSchema,
  ListModelsResultSchema,
  ListModesResultSchema,
  ProviderModelSchema,
  ProviderModeSchema,
  RecoveryConditionSchema,
  RecoverySpanClassificationSchema,
  RespondToRequestParamsSchema,
  RunIdSchema,
  DriverAuthProbeResultSchema,
  DriverGoalResultSchema,
  DriverInterventionResultSchema,
  DriverResumeResultSchema,
  DriverRollbackResultSchema,
  CompactContextRequestSchema,
  DriverCompactionResultSchema,
  ListProviderCommandsRequestSchema,
  ProviderCommandBindingGroupSchema,
  ProviderCommandListResultSchema,
  DriverTranscriptExportResultSchema,
  DriverTranscriptReplayResultSchema,
  IdempotencyClassSchema,
  McpServerStatusEmissionSchema,
  ProviderCommandEntrySchema,
  ProviderToolMetadataSchema,
  type ApplyInterventionParams,
  type CallbackToolResult,
  type CapabilityDetectionSource,
  type ClearSessionGoalParams,
  type CloseSessionParams,
  type CompactContextParams,
  type CreateSessionParams,
  type DriverAuthProbeResult,
  type DriverCapabilities,
  type DriverCapabilityFlag,
  type DriverCompactionResult,
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
  type ListProviderCommandsParams,
  type McpServerStatusUpdate,
  type NormalizedProviderToolMetadata,
  type ProviderDriver,
  type ProviderCommandBindingGroup,
  type ProviderCommandListResult,
  type ProviderModel,
  type ProviderMode,
  type ProviderSessionHandle,
  type ProviderUsageLimitCause,
  type ProviderUsageLimitResetBoundary,
  type ProviderUsageLimitResetProvenance,
  type ProviderUsageLimitSignal,
  type RecoveryCondition,
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
import * as contracts from "../index.js";

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
// The class below implements ALL 18 operations with correctly-typed params and
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
        context_compaction: true,
        provider_commands: true,
        output_speed: false,
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
      // The reconciliation rule a conformant driver applies, in the one place a
      // reader looks to learn what one does: the bound is inclusive, and the
      // turns already in hand are the only thing it is applied to.
      frames: params.transcript.turns
        .filter((turn) => turn.position <= params.boundary)
        .map((turn) => ({ position: turn.position })),
      declaredLosses: ["provider_private_reasoning"],
    });
  }

  public replayTranscript(params: ReplayTranscriptParams): Promise<DriverTranscriptReplayResult> {
    // The degraded arm is the memo floor standing in, and a memo settlement that
    // named no loss would be rejected by the envelope's own schema — so the mock
    // declares it rather than modelling a driver the contract refuses.
    return params.frames.length === 0
      ? Promise.resolve({
          status: "degraded",
          declaredLosses: ["conversation_history_summarized"],
        })
      : Promise.resolve({ status: "applied", declaredLosses: [] });
  }

  public compactContext(params: CompactContextParams): Promise<DriverCompactionResult> {
    // `boundaryPosition` is REQUIRED on the applied arm, so a conformant driver
    // cannot report a compaction it has no boundary for — the mock states one
    // rather than reaching for a member the discriminated union does not admit.
    return params.bindingId === ""
      ? Promise.resolve({ status: "refused", reason: "command_absent" })
      : Promise.resolve({ status: "applied", boundaryPosition: 7 });
  }

  public listProviderCommands(
    _params: ListProviderCommandsParams,
  ): Promise<ProviderCommandListResult> {
    // ONE group: the params name one binding, and one binding has one
    // enumeration. `enabled` is absent rather than synthesized `true`, which is
    // what a provider publishing no enabled/disabled distinction looks like.
    //
    // `runId` is the SOLE-LIVE-RUN arm here. The mock states a run because the
    // conformance surface needs the non-null arm exercised; the two `null` arms
    // — zero live runs and two live runs — are resolved by each driver against
    // its own session record and asserted there.
    return Promise.resolve({
      bindings: [
        {
          runId: RUN_ID,
          binding: { driverName: "mock", providerAccountId: "account-1" },
          entries: [
            {
              name: "compact",
              kind: "command",
              binding: { driverName: "mock", providerAccountId: "account-1" },
            },
          ],
          complete: true,
        },
      ],
    });
  }
}

describe("ProviderDriver contract: a mock implements all 18 operations", () => {
  // Type-level proof that the mock satisfies the contract interface: assigning
  // it to a `ProviderDriver`-typed binding will fail to compile if any of the
  // 18 method signatures drifts from the contract. This is the AC1 assertion;
  // the runtime checks below merely anchor it to an executing test.
  const driver: ProviderDriver = new MockProviderDriver();

  it("is constructable and surfaces all 18 contract operations as callable methods", () => {
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
      "compactContext",
      "listProviderCommands",
    ] as const;
    expect(operationNames).toHaveLength(18);
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

  it("getCapabilities answers every one of the 17 flags and returns ingress tools", async () => {
    const result = await driver.getCapabilities();
    // The canonical 17-flag `DriverCapabilityFlag` set, written alphabetically
    // and SPELLED OUT rather than derived from `DRIVER_CAPABILITY_FLAGS`: a
    // derived literal would agree with the const by construction and could never
    // catch a flag silently added or removed there. Keeping it hand-written is
    // what makes this an independent lockstep check.
    const canonicalCapabilityFlags = [
      "callback_tools",
      "context_compaction",
      "cost_cap",
      "interactive_requests",
      "mcp",
      "model_mutation",
      "output_speed",
      "provider_commands",
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
    // I-005-2 structural check: the flag record is total — exactly the 17
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

  it("rejects the refusal code beside status 'applied' (cross-field contradiction)", () => {
    // The code IS the classification that the participant's text was swallowed,
    // and a swallowed text is precisely what `applied` denies — accepted, the
    // pair hands callers a result whose two readers disagree (success by
    // `status`, failure by `refusalCode`).
    const result = DriverInterventionResultSchema.safeParse({
      status: "applied",
      refusalCode: "driver.text_neutralization_failed",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("refusalCode");
    }
  });

  it("still parses a bare `applied` and a bare `degraded` (the refinement narrows only the pair)", () => {
    expect(DriverInterventionResultSchema.safeParse({ status: "applied" }).success).toBe(true);
    expect(DriverInterventionResultSchema.safeParse({ status: "degraded" }).success).toBe(true);
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
// T1.7 — capability-flag currency: seventeen flags, canonical order, one
//        permanent exclusion.
// ===========================================================================
//
// `DRIVER_CAPABILITY_FLAGS` is the single source the union, the migration CHECK
// list, the write-seam cardinality guard, and the driver fixtures all derive
// from — so drift here is drift everywhere. These checks are written against
// HAND-SPELLED expectations rather than against the const itself: a check
// derived from the thing it checks is vacuous.

describe("DRIVER_CAPABILITY_FLAGS — T1.7 seventeen-flag currency", () => {
  it("carries exactly seventeen flags, in canonical §Shared Enums order", () => {
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
      "context_compaction",
      "provider_commands",
      "output_speed",
    ]);
    expect(DRIVER_CAPABILITY_FLAGS).toHaveLength(17);
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
    expect(DRIVER_CAPABILITY_FLAGS.at(-1)).toBe("output_speed");
  });

  it("APPENDS the three console-parity flags after `cost_cap`, where the canonical order puts them", () => {
    // The counterpart to the insertion above, and the reason the two rules
    // coexist rather than contradict: position is canonical, and canonical
    // position for these three IS the end. Asserted by INDEX for the same reason
    // — a re-ordering that kept membership would pass a `toContain` and break
    // every surface that reads position.
    expect(DRIVER_CAPABILITY_FLAGS.indexOf("context_compaction")).toBe(14);
    expect(DRIVER_CAPABILITY_FLAGS.indexOf("provider_commands")).toBe(15);
    expect(DRIVER_CAPABILITY_FLAGS.indexOf("output_speed")).toBe(16);
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
    // the AC2 totality literals ABOVE, whose hand-written seventeen-key
    // `Record<DriverCapabilityFlag, boolean>` fails as INCOMPLETE the moment the
    // union outgrows the const. It compiles today BECAUSE the union is
    // `(typeof DRIVER_CAPABILITY_FLAGS)[number]` rather than a second listing.
    const flags: readonly DriverCapabilityFlag[] = DRIVER_CAPABILITY_FLAGS;
    // A DELIBERATE runtime anchor, not a redundant identity check: the
    // assertion this test makes is the compile above, so the executing
    // expectation restates the cardinality the union is derived from rather
    // than `toBe`-ing the const against itself, which would hold for any value.
    expect(flags).toHaveLength(17);
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
// T4.8 — the hoisted recovery vocabularies: REFERENCED, never re-inlined.
// ===========================================================================
//
// `Plan-005 §Phase 4 — Client SDK exposure + degraded-fallback` T4.8 P3-4 requires the hoisted `RecoveryCondition` to be
// "referenced, never re-inlined" at every carrying surface. These tests are
// written to go red if a carrier drifts back to restating the values, which is
// the one shape of drift the type system does NOT catch: `z.ZodType` is
// COVARIANT in its output, so a re-inlined `z.enum` narrower than the union
// still satisfies a `z.ZodType<RecoveryCondition>` annotation. Measured on this
// workspace before the hoist — widening the union by a third member left
// `tsc -b --force` at zero errors, while narrowing it produced two TS2375s — so
// the compile-time guard fired only in the direction the corpus never takes.
// Widening is the direction it DID take (`recovery-needed` -> `+
// reauth-required`), and its failure mode is a new condition dead-lettering at
// parse at whichever carrier nobody updated.

describe("Recovery vocabularies — T4.8 hoist", () => {
  it("carries exactly the two canonical conditions", () => {
    // Hand-spelled rather than read off the array under test: a list derived
    // from the thing it checks would agree by construction and could never
    // catch a member silently added. Removal is caught by the other half — an
    // entry here that left the union would not compile.
    const canonicalConditions: RecoveryCondition[] = ["recovery-needed", "reauth-required"];
    expect([...RECOVERY_CONDITIONS]).toEqual(canonicalConditions);
  });

  it("carries exactly the four canonical span classifications", () => {
    const canonicalClassifications: RecoverySpanClassification[] = [
      "read_only",
      "idempotent_write",
      "irreversible",
      "unclassifiable",
    ];
    expect([...RECOVERY_SPAN_CLASSIFICATIONS]).toEqual(canonicalClassifications);
  });

  it("admits every member of its own array at each exported parser", () => {
    for (const recoveryCondition of RECOVERY_CONDITIONS) {
      expect(RecoveryConditionSchema.parse(recoveryCondition)).toBe(recoveryCondition);
    }
    for (const spanClassification of RECOVERY_SPAN_CLASSIFICATIONS) {
      expect(RecoverySpanClassificationSchema.parse(spanClassification)).toBe(spanClassification);
    }
  });

  it("keeps each parser closed — against the sibling vocabulary and against free strings", () => {
    // The negative control for the hoist: single-sourcing the values did not
    // make either parser permissive, and the two axes stayed disjoint, so a
    // consumer switching on one can never fall into the other's arm.
    for (const spanClassification of RECOVERY_SPAN_CLASSIFICATIONS) {
      expect(RecoveryConditionSchema.safeParse(spanClassification).success).toBe(false);
    }
    for (const recoveryCondition of RECOVERY_CONDITIONS) {
      expect(RecoverySpanClassificationSchema.safeParse(recoveryCondition).success).toBe(false);
    }
    expect(RecoveryConditionSchema.safeParse("retry-later").success).toBe(false);
    expect(RecoverySpanClassificationSchema.safeParse("").success).toBe(false);
  });

  it("reaches the live resume carrier for the FULL cross product of both arrays", () => {
    // The drift tripwire, and the reason it is driven from the arrays instead
    // of from a written-out list: a member added upstream must reach this
    // carrier, so a re-inlined `z.enum` here would reject it and turn this red
    // rather than dead-lettering the new member at parse in production.
    for (const recoveryCondition of RECOVERY_CONDITIONS) {
      for (const recoverySpanClassification of RECOVERY_SPAN_CLASSIFICATIONS) {
        const parsed: DriverResumeResult = DriverResumeResultSchema.parse({
          status: "failed",
          recoveryCondition,
          recoverySpanClassification,
          providerFailureDetail: "provider session diverged mid-turn",
        });
        if (parsed.status !== "failed") {
          throw new Error(`expected the failed variant, got status=${parsed.status}`);
        }
        expect(parsed.recoveryCondition).toBe(recoveryCondition);
        expect(parsed.recoverySpanClassification).toBe(recoverySpanClassification);
      }
    }
  });

  it("still rejects an off-union member at the resume carrier, one axis at a time", () => {
    // Both axes, each with the other held valid, so the sole defect is the one
    // under test and the refusal cannot be attributed to the wrong field.
    expect(
      DriverResumeResultSchema.safeParse({
        status: "failed",
        recoveryCondition: "retry-later",
        recoverySpanClassification: "unclassifiable",
        providerFailureDetail: "provider credential expired",
      }).success,
    ).toBe(false);
    expect(
      DriverResumeResultSchema.safeParse({
        status: "failed",
        recoveryCondition: "recovery-needed",
        recoverySpanClassification: "destructive",
        providerFailureDetail: "provider credential expired",
      }).success,
    ).toBe(false);
  });

  it("keeps both axes REQUIRED on the live resume return", () => {
    // The hoist changed which parser validates the field, never whether the
    // field must be there: a resume failure is produced fresh and never
    // replayed, so there is no pre-amendment history for optionality to admit.
    for (const omitted of ["recoveryCondition", "recoverySpanClassification"] as const) {
      const failedResult: Record<string, unknown> = {
        status: "failed",
        recoveryCondition: "recovery-needed",
        recoverySpanClassification: "unclassifiable",
        providerFailureDetail: "provider closed the stream mid-tool-call",
      };
      delete failedResult[omitted];
      expect(DriverResumeResultSchema.safeParse(failedResult).success).toBe(false);
    }
  });

  it("reaches consumers through the `index.ts` barrel as the same instances", () => {
    // All four symbols are newly public with this task. `index.ts` re-exports
    // this module with `export *`, so a consumer outside the package sees them
    // only through that line — importing via `../index.js` rather than
    // `../provider-driver.js` is what exercises it. Identity is the
    // load-bearing half: a shadow copy would satisfy a mere defined-ness check
    // while drifting from the parser the daemon actually validates against.
    expect(contracts.RecoveryConditionSchema).toBe(RecoveryConditionSchema);
    expect(contracts.RecoverySpanClassificationSchema).toBe(RecoverySpanClassificationSchema);
    expect(contracts.RECOVERY_CONDITIONS).toBe(RECOVERY_CONDITIONS);
    expect(contracts.RECOVERY_SPAN_CLASSIFICATIONS).toBe(RECOVERY_SPAN_CLASSIFICATIONS);
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
    context_compaction: false,
    provider_commands: false,
    output_speed: false,
  };

  it("requires `cliVersion` on GetCapabilitiesResult (fail-closed by construction)", () => {
    // @ts-expect-error `cliVersion` is REQUIRED — a report without a parseable provider version never reaches the daemon
    const reportWithoutVersion: GetCapabilitiesResult = {
      capabilities: { flags: allFlagsDenied, contractVersion: "1.0" },
      tools: [],
    };
    void reportWithoutVersion;
  });

  // ---- T3.24 — `detectionSource`, additive-optional and live-scoped ----

  it("accepts a report WITHOUT `detectionSource` — the hydrate arm", () => {
    // ADDITIVE-OPTIONAL by contract, and the optionality is load-bearing rather
    // than lenient: `DriverCapabilitiesWriter.hydrate()` reconstructs this
    // wrapper from a cache that persists flag VALUES and not provenance, so a
    // REQUIRED member would be unsatisfiable there and would have forced a
    // durable column whose only content is a fact about a reading that is over.
    const hydrated: GetCapabilitiesResult = {
      capabilities: { flags: allFlagsDenied, contractVersion: "1.0" },
      tools: [],
      cliVersion: { raw: "2.1.251", semver: "2.1.251" },
    };
    expect(Object.hasOwn(hydrated, "detectionSource")).toBe(false);
  });

  it("requires `detectionSource` to be TOTAL over the flag set when present", () => {
    const live: GetCapabilitiesResult = {
      capabilities: { flags: allFlagsDenied, contractVersion: "1.0" },
      tools: [],
      cliVersion: { raw: "2.1.251", semver: "2.1.251" },
      detectionSource: {
        resume: "static",
        steer: "probed",
        interactive_requests: "probed",
        mcp: "static",
        tool_calls: "static",
        reasoning_stream: "static",
        model_mutation: "static",
        structured_output: "static",
        rollback: "static",
        session_goals: "probed",
        callback_tools: "static",
        subagents: "static",
        transcript_replay: "static",
        cost_cap: "static",
        // The three console-parity flags. `output_speed` is `static` on BOTH
        // shipped drivers and the other two split, so a fixture that made them
        // uniform would stop exercising the mixed-provenance shape this member
        // exists to carry.
        context_compaction: "probed",
        provider_commands: "probed",
        output_speed: "static",
      },
    };
    expect(Object.keys(live.detectionSource ?? {})).toHaveLength(DRIVER_CAPABILITY_FLAGS.length);

    const partial: GetCapabilitiesResult = {
      capabilities: { flags: allFlagsDenied, contractVersion: "1.0" },
      tools: [],
      cliVersion: { raw: "2.1.251", semver: "2.1.251" },
      // @ts-expect-error `Record<DriverCapabilityFlag, …>` is TOTAL — a partial provenance map would leave a flag's origin unstated
      detectionSource: { resume: "static" },
    };
    void partial;
  });

  it("closes `CapabilityDetectionSource` at exactly `static` and `probed`", () => {
    const declared: CapabilityDetectionSource = "static";
    const read: CapabilityDetectionSource = "probed";
    expect([declared, read]).toStrictEqual(["static", "probed"]);

    // @ts-expect-error the union is closed — a third provenance would need a spec amendment, not a free string
    const invented: CapabilityDetectionSource = "assumed";
    void invented;
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

describe("DECLARED_LOSS_KINDS — the closed declared-loss vocabulary", () => {
  it("is exactly the canonical member list, in canonical order", () => {
    // A LITERAL pin, deliberately not derived from the const it is checking.
    // Every other assertion over this vocabulary in the workspace compares
    // against `DECLARED_LOSS_KINDS` itself and therefore passes whatever the
    // const happens to say — which is precisely the drift this one exists to
    // catch. The canonical contract owns the set and a member joins it by
    // amendment; a build whose enum lags then reports an "upper bound" that
    // bounds nothing and refuses, as unreadable, a marker a peer wrote correctly.
    //
    // ORDER is pinned with membership because two callers normalize a loss list
    // by filtering this array, so it is the reported ordering of every
    // declared-loss list and not merely a set.
    expect(DECLARED_LOSS_KINDS).toStrictEqual([
      "provider_private_reasoning",
      "context_truncated",
      "tool_call_history_repaired",
      "conversation_history_summarized",
      "turn_content_unavailable",
      "turn_content_truncated",
    ]);
  });

  it("admits every member through the validator, so the enum and the schema cannot diverge", () => {
    // The pin above fixes the list; this one fixes the list's relationship to
    // the boundary. A member added to the array but not reachable through the
    // schema would be a vocabulary the daemon can name and the trust boundary
    // rejects.
    for (const kind of DECLARED_LOSS_KINDS) {
      const parsed = DriverTranscriptExportResultSchema.parse({
        frames: [],
        declaredLosses: [kind],
      });
      expect(parsed.declaredLosses).toEqual([kind]);
    }
  });
});

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

  it("rejects a degraded settlement whose declared-loss list is empty", () => {
    // An empty list is the positive claim that nothing was dropped, so this
    // value would tell a caller the memo summary IS the verbatim conversation.
    const result = DriverTranscriptReplayResultSchema.safeParse({
      status: "degraded",
      declaredLosses: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a degraded settlement that declares other losses but not the summarization", () => {
    // The case a mere non-empty rule would let through: losses are named, the
    // one that says the conversation was summarized is not.
    const result = DriverTranscriptReplayResultSchema.safeParse({
      status: "degraded",
      declaredLosses: ["provider_private_reasoning", "tool_call_history_repaired"],
    });
    expect(result.success).toBe(false);
  });

  it("accepts an applied replay with an empty declared-loss list", () => {
    // The negative control for the rule above: requiredness is scoped to the
    // degraded arm, so a replay that carried everything across still gets to say
    // so with an empty list.
    const parsed: DriverTranscriptReplayResult = DriverTranscriptReplayResultSchema.parse({
      status: "applied",
      declaredLosses: [],
    });
    expect(parsed.declaredLosses).toEqual([]);
  });

  it("rejects an applied replay that declares the summarization", () => {
    // The inverse of the degraded rule, and the reason the pair exists. The
    // summarization kind names the memo floor standing in for the conversation,
    // which IS the degraded settlement — so a result claiming both that native
    // replay landed the conversation and that a summary replaced it states no
    // reachable outcome. A one-way rule leaves it parseable, and a consumer
    // reading `status` then publishes native-replay continuity for a session
    // holding only a bounded summary.
    const result = DriverTranscriptReplayResultSchema.safeParse({
      status: "applied",
      declaredLosses: ["conversation_history_summarized"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects it even beside losses an applied replay may legitimately declare", () => {
    // The kind is refused on its own terms rather than as a proxy for "the list
    // is suspicious": stripping private reasoning is an ordinary applied-arm
    // loss, and carrying it alongside does not launder the contradiction.
    const result = DriverTranscriptReplayResultSchema.safeParse({
      status: "applied",
      declaredLosses: ["provider_private_reasoning", "conversation_history_summarized"],
    });
    expect(result.success).toBe(false);
  });

  it("keeps every OTHER kind admissible on the applied arm", () => {
    // The negative control for the inverse rule: it is scoped to exactly one
    // kind, so the applied arm keeps its full latitude over the rest. A rule
    // that had over-reached to "applied declares nothing structural" would fail
    // here.
    const parsed: DriverTranscriptReplayResult = DriverTranscriptReplayResultSchema.parse({
      status: "applied",
      declaredLosses: [
        "provider_private_reasoning",
        "context_truncated",
        "tool_call_history_repaired",
        "turn_content_unavailable",
        "turn_content_truncated",
      ],
    });
    // Every member of the vocabulary except the one the inverse rule forbids
    // here, so the count is a quantifier over the enum rather than a tally: a
    // member admitted to `DECLARED_LOSS_KINDS` without being listed here would
    // leave "every OTHER kind" claiming more than the case drives.
    expect(parsed.declaredLosses).toHaveLength(DECLARED_LOSS_KINDS.length - 1);
  });
});

describe("transcript operation params — nominal shapes", () => {
  it("states the inclusive bound beside the projection, in the segments' own position vocabulary", () => {
    const params: ExportTranscriptParams = {
      sessionId: "session-transcript-1" as SessionId,
      transcript: {
        sessionId: "session-transcript-1" as SessionId,
        runId: "run-transcript-1" as RunId,
        builtAtPosition: 41,
        turns: [
          {
            position: 7,
            role: "participant",
            segments: [{ kind: "text", position: 7, text: "go" }],
          },
          {
            // Two consecutive same-role events folded into ONE turn: it opened at
            // 12 and took more content at 30, which is past the bound below.
            position: 12,
            role: "assistant",
            segments: [
              { kind: "text", position: 12, text: "going" },
              { kind: "text", position: 30, text: "and past" },
            ],
          },
          {
            position: 35,
            role: "participant",
            segments: [{ kind: "text", position: 35, text: "later still" }],
          },
        ],
      },
      boundary: 12,
    };
    expect([...Object.keys(params)].sort()).toStrictEqual(["boundary", "sessionId", "transcript"]);
    // `boundary` and `CanonicalTranscriptSegment.position` speak one vocabulary,
    // so "export up to and including the bound" is a filter over the segments
    // already in hand — the driver needs no access to anything else to apply it,
    // and the bound is inclusive, so the segment AT it comes along. Applied per
    // SEGMENT: the middle turn's own position is inside the bound while half its
    // content is not, so a turn-level filter would carry position 30 across.
    const exported = params.transcript.turns
      .map((turn) => ({
        ...turn,
        segments: turn.segments.filter((segment) => segment.position <= params.boundary),
      }))
      .filter((turn) => turn.segments.length > 0);
    expect(exported.map((turn) => turn.position)).toStrictEqual([7, 12]);
    expect(
      exported.flatMap((turn) => turn.segments.map((segment) => segment.position)),
    ).toStrictEqual([7, 12]);
  });

  it("requires the bound on an export request rather than leaving it to be inferred", () => {
    // @ts-expect-error `boundary` is REQUIRED — an export with no stated bound would leave a driver to decide for itself where the transcript ends
    const unbounded: ExportTranscriptParams = {
      sessionId: "session-transcript-2" as SessionId,
      transcript: {
        sessionId: "session-transcript-2" as SessionId,
        runId: "run-transcript-2" as RunId,
        builtAtPosition: 9,
        turns: [
          {
            position: 9,
            role: "participant",
            segments: [{ kind: "text", position: 9, text: "go" }],
          },
        ],
      },
    };
    void unbounded;
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

describe("DriverCompactionResultSchema — the two structural rules, made checkable", () => {
  // This schema is NOT a wire guard and no dispatch path parses through it: the
  // compaction result is composed daemon-side from the wait's own settlement.
  // What it exists for is exactly what this suite asserts — the two structural
  // rules the canonical doc states are enforced by the type rather than narrated
  // in prose beside it, so a later widening that broke either one fails here.

  it("REQUIRES `boundaryPosition` on the applied arm", () => {
    // A driver reporting a compaction it has no boundary for is reporting a
    // compaction it cannot prove: the boundary row IS the typed evidence, and an
    // applied arm without one would let the operation settle on the request
    // having been accepted, which is the exact failure both mechanisms invite.
    const withoutPosition = { status: "applied" };
    expect(DriverCompactionResultSchema.safeParse(withoutPosition).success).toBe(false);
    expect(
      DriverCompactionResultSchema.safeParse({ status: "applied", boundaryPosition: 12 }).success,
    ).toBe(true);
  });

  it("accepts a NULL position as the positive statement that the frame named none", () => {
    // `.nullable()` and not `.optional()` — see the shape's own doctrine. This is
    // the one case where "no number" is a fact about the provider's frame rather
    // than a gap in the driver's reporting.
    const parsed = DriverCompactionResultSchema.safeParse({
      status: "applied",
      boundaryPosition: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("admits `capability_undeclared` as NO arm's reason", () => {
    // Dropped deliberately: the static capability gate refuses an undeclared
    // compaction BEFORE the driver is called, so an arm for it would be a second
    // and contradictory encoding of one refusal. Both refusal-shaped arms are
    // probed, so this cannot pass by the reason landing on the other one.
    expect(
      DriverCompactionResultSchema.safeParse({
        status: "refused",
        reason: "capability_undeclared",
      }).success,
    ).toBe(false);
    expect(
      DriverCompactionResultSchema.safeParse({
        status: "failed",
        reason: "capability_undeclared",
      }).success,
    ).toBe(false);
  });

  it("keeps the three failure reasons and the two refusal reasons on their own arms", () => {
    // The split is not cosmetic: a refusal is a decision (the command is absent,
    // the caller was denied) and a failure is an outcome (the evidence never
    // arrived). Crossing them would let a denied caller read as a wedged
    // provider.
    for (const reason of ["wait_expired", "binding_lost", "provider_error"]) {
      expect(DriverCompactionResultSchema.safeParse({ status: "failed", reason }).success).toBe(
        true,
      );
      expect(DriverCompactionResultSchema.safeParse({ status: "refused", reason }).success).toBe(
        false,
      );
    }
    for (const reason of ["command_absent", "not_permitted"]) {
      expect(DriverCompactionResultSchema.safeParse({ status: "refused", reason }).success).toBe(
        true,
      );
      expect(DriverCompactionResultSchema.safeParse({ status: "failed", reason }).success).toBe(
        false,
      );
    }
  });

  it("rejects an unknown key on every arm", () => {
    expect(
      DriverCompactionResultSchema.safeParse({
        status: "applied",
        boundaryPosition: 1,
        elapsedMs: 900,
      }).success,
    ).toBe(false);
  });
});

describe("ProviderCommandEntrySchema — the routing pair a consumer cannot lose", () => {
  const wellFormedEntry = {
    name: "compact",
    kind: "command",
    binding: { driverName: "codex", providerAccountId: "account-1" },
  } as const;

  it("carries a NULL account rather than synthesizing a placeholder", () => {
    // A session need not have bound a provider account at all. `null` states that
    // positively; `""` or `"unknown"` would make the routing invariant
    // unenforceable while looking enforced, since two accountless bindings on
    // different providers would then compare equal on the half of the pair that
    // is supposed to separate them.
    expect(
      ProviderCommandEntrySchema.safeParse({
        ...wellFormedEntry,
        binding: { driverName: "codex", providerAccountId: null },
      }).success,
    ).toBe(true);
    expect(
      ProviderCommandEntrySchema.safeParse({
        ...wellFormedEntry,
        binding: { driverName: "codex", providerAccountId: "" },
      }).success,
    ).toBe(false);
  });

  it("REQUIRES the binding pair — an absent account key does not parse", () => {
    // The difference `null` is carrying: absence would be indistinguishable from
    // a driver that forgot to report one, and the pair is the routing key.
    expect(
      ProviderCommandEntrySchema.safeParse({
        ...wellFormedEntry,
        binding: { driverName: "codex" },
      }).success,
    ).toBe(false);
    const { binding: _binding, ...withoutBinding } = wellFormedEntry;
    expect(ProviderCommandEntrySchema.safeParse(withoutBinding).success).toBe(false);
  });

  it("keeps `enabled` optional so an absent flag is not synthesized `true`", () => {
    // A provider publishing no enabled/disabled distinction reports no flag; a
    // synthesized `true` would claim an offerability the provider never stated.
    const parsed = ProviderCommandEntrySchema.parse(wellFormedEntry);
    expect(Object.hasOwn(parsed, "enabled")).toBe(false);
    expect(
      ProviderCommandEntrySchema.safeParse({ ...wellFormedEntry, enabled: false }).success,
    ).toBe(true);
  });

  it('refuses an EMPTY description, so a driver must omit rather than forward `""`', () => {
    // Not hypothetical: the Codex skills surface types its description as
    // REQUIRED, so a skill whose front matter declares none arrives as `""`. A
    // driver that forwarded it verbatim would fail its own enumeration on an
    // honest provider reading. Omission is also the truthful encoding — absence
    // says the provider published no description, where `""` would say it
    // published one and it was blank.
    expect(
      ProviderCommandEntrySchema.safeParse({ ...wellFormedEntry, description: "" }).success,
    ).toBe(false);
    expect(
      ProviderCommandEntrySchema.safeParse({ ...wellFormedEntry, description: "   " }).success,
    ).toBe(false);
    expect(ProviderCommandEntrySchema.safeParse(wellFormedEntry).success).toBe(true);
  });

  it("bounds both provider-authored strings and refuses an unknown key", () => {
    // A local skill file's front matter is operator-writable and the assembled
    // list travels to a client, so the description is bounded like every other
    // untrusted free-form string in this module.
    expect(
      ProviderCommandEntrySchema.safeParse({
        ...wellFormedEntry,
        description: "x".repeat(DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN + 1),
      }).success,
    ).toBe(false);
    expect(
      ProviderCommandEntrySchema.safeParse({ ...wellFormedEntry, invocationHandle: "/compact" })
        .success,
    ).toBe(false);
  });
});

describe("ProviderCommandBindingGroup — provenance that is stated, never synthesized", () => {
  // The group's `runId` and `binding` pair is PROVENANCE a client reads, not an
  // addressing handle, and both halves are nullable for the same reason: a
  // binding outlives any one of its runs and need not have bound an account at
  // all, so the shape must be able to say "none" without saying it by omission.
  //
  // The RESOLUTION of which arm applies is each driver's, against its own session
  // record; what is asserted here is that the contract admits all three answers
  // and that no arm is reachable only by dropping a key.

  const bindingPair = { driverName: "codex", providerAccountId: "account-1" } as const;
  const entry = { name: "compact", kind: "command", binding: bindingPair } as const;

  it("admits the sole-live-run arm, the zero-run arm, and the two-live-runs arm", () => {
    // Arm 1 — exactly one live run: that run answers.
    const soleLiveRun: ProviderCommandBindingGroup = {
      runId: RUN_ID,
      binding: bindingPair,
      entries: [entry],
      complete: true,
    };
    // Arm 2 — the ordinary pre-first-turn palette read. It SUCCEEDS with null
    // rather than refusing: a binding that has not run anything yet is not an
    // error, and the entries it enumerates are perfectly real.
    const zeroLiveRuns: ProviderCommandBindingGroup = {
      runId: null,
      binding: bindingPair,
      entries: [entry],
      complete: true,
    };
    // Arm 3 — two live turns on one binding. No single run is attributable, and
    // picking either would be a coin flip presented as provenance.
    const noSingleAttributableRun: ProviderCommandBindingGroup = {
      runId: null,
      binding: bindingPair,
      entries: [entry],
      complete: true,
    };

    expect(soleLiveRun.runId).toBe(RUN_ID);
    expect(zeroLiveRuns.runId).toBeNull();
    expect(noSingleAttributableRun.runId).toBeNull();
  });

  it("keeps the key PRESENT on every arm, so absence is never the encoding", () => {
    // The distinction the nullable buys: an omitted key would be
    // indistinguishable from a producer that forgot to report one, which is the
    // exact ambiguity the pair exists to remove.
    const zeroLiveRuns: ProviderCommandBindingGroup = {
      runId: null,
      binding: { driverName: "codex", providerAccountId: null },
      entries: [],
      complete: true,
    };
    expect(Object.hasOwn(zeroLiveRuns, "runId")).toBe(true);
    expect(Object.hasOwn(zeroLiveRuns.binding, "providerAccountId")).toBe(true);
  });

  it("scopes truncation PER GROUP, so one truncated binding never marks another", () => {
    const result: ProviderCommandListResult = {
      bindings: [
        { runId: RUN_ID, binding: bindingPair, entries: [entry], complete: false },
        { runId: null, binding: bindingPair, entries: [entry], complete: true },
      ],
    };
    expect(result.bindings.map((group) => group.complete)).toEqual([false, true]);
  });
});

// --------------------------------------------------------------------------
// T4.2 — client-facing SDK-seam wire schemas
// --------------------------------------------------------------------------
//
// A DIFFERENT boundary from everything above: these schemas guard CLIENT input
// crossing into the daemon over JSON-RPC and the daemon's own replies going back
// out. The blocks below assert the three things that boundary is for — that a
// caller cannot send a shape the daemon would have to guess at, that a reply
// carries exactly the members the spec routes to a client and no more, and that
// the two structural refusals this seam owns (a `rollback` dispatch arm, a
// missing answer) are refusals rather than conventions.

const A_RUN_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const ANOTHER_UUID = "0b1c2d3e-4f50-4162-8374-859607a8b9c0";

/** Every declared flag answered `false` — the totality `DriverCapabilities` requires. */
function allFlagsFalse(): Record<string, boolean> {
  return Object.fromEntries(DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, false]));
}

describe("RunIdSchema — the brand's validator, co-located with the brand (CP-005-6)", () => {
  it("accepts a UUID and brands it", () => {
    expect(RunIdSchema.parse(A_RUN_ID)).toBe(A_RUN_ID);
  });

  it("REFUSES a non-UUID run id", () => {
    // The whole point of validating rather than casting: a run id crossing the
    // client boundary is untrusted, and a path fragment or SQL fragment reaching
    // a store lookup keyed on this value is exactly what shape-rejection stops.
    expect(RunIdSchema.safeParse("../../etc/passwd").success).toBe(false);
    expect(RunIdSchema.safeParse("run-1").success).toBe(false);
    expect(RunIdSchema.safeParse("").success).toBe(false);
  });
});

describe("DriverReadParams / DriverAckResult — the two empty envelopes", () => {
  it("accepts the empty object on both", () => {
    expect(DriverReadParamsSchema.parse({})).toEqual({});
    expect(DriverAckResultSchema.parse({})).toEqual({});
  });

  it("REFUSES a driver selector on the read request — the reads are no-arg by ratified signature", () => {
    // Plan-005 §Phase 4 T4.3 ratifies `listCapabilities()` / `listModels()` /
    // `listModes()` no-arg while the three run-addressed verbs take a param. A
    // `{ driverName }` request would contradict that signature, and `.strict()`
    // is what makes the contradiction a refusal instead of a silently ignored
    // key that a caller would then believe had filtered the reply.
    expect(DriverReadParamsSchema.safeParse({ driverName: "claude" }).success).toBe(false);
    expect(DriverAckResultSchema.safeParse({ status: "ok" }).success).toBe(false);
  });
});

describe("DriverCapabilitiesSchema — flag totality is derived, never hand-listed", () => {
  it("accepts a report answering every declared flag", () => {
    const parsed = DriverCapabilitiesSchema.parse({
      flags: allFlagsFalse(),
      contractVersion: "1.0.0",
    });
    expect(Object.keys(parsed.flags).sort()).toEqual([...DRIVER_CAPABILITY_FLAGS].sort());
  });

  it("REFUSES a flags object that omits a declared flag", () => {
    // The runtime half of I-005-2's structural claim. `Record<DriverCapability
    // Flag, boolean>` makes omission a compile error inside the daemon; over the
    // wire there is no compiler, so the schema has to carry it — otherwise a
    // client would read "undeclared" for a capability the driver declared true.
    const flags = allFlagsFalse();
    delete flags["steer"];
    expect(DriverCapabilitiesSchema.safeParse({ flags, contractVersion: "1.0.0" }).success).toBe(
      false,
    );
  });

  it("REFUSES a flag outside the declared set, so the shape cannot be widened over the wire", () => {
    expect(
      DriverCapabilitiesSchema.safeParse({
        flags: { ...allFlagsFalse(), telepathy: true },
        contractVersion: "1.0.0",
      }).success,
    ).toBe(false);
  });

  it("bounds contractVersion at the same value the event boundary uses", () => {
    // Deliberately the same 64 as `CAPABILITY_CONTRACT_VERSION_MAX_LEN`: a
    // version string that survives this reply must also survive the
    // `runtime_node.capability_*` event, or the two surfaces disagree about one
    // value.
    expect(DRIVER_WIRE_CONTRACT_VERSION_MAX_LEN).toBe(64);
    expect(
      DriverCapabilitiesSchema.safeParse({
        flags: allFlagsFalse(),
        contractVersion: "v".repeat(DRIVER_WIRE_CONTRACT_VERSION_MAX_LEN + 1),
      }).success,
    ).toBe(false);
    expect(
      DriverCapabilitiesSchema.safeParse({ flags: allFlagsFalse(), contractVersion: "" }).success,
    ).toBe(false);
  });
});

describe("ListCapabilitiesResultSchema — what crosses to a client, and what stops at the driver", () => {
  const report = {
    driverName: "claude",
    capabilities: { flags: { ...allFlagsFalse(), output_speed: true }, contractVersion: "1.0.0" },
    outputSpeedLevels: ["off", "on"],
  };

  it("carries the flags and the output-speed vocabulary", () => {
    const parsed = ListCapabilitiesResultSchema.parse({ drivers: [report] });
    expect(parsed.drivers[0]?.outputSpeedLevels).toEqual(["off", "on"]);
    expect(parsed.drivers[0]?.capabilities.flags.output_speed).toBe(true);
  });

  it("REFUSES detectionSource, cliVersion, and tools — the three members that stop at the driver", () => {
    // `Spec-005 §Capability discovery` scopes this reply to the flags, and
    // §Required Behavior rules that the mechanism grades and `cliVersion` alike
    // do not reach it. `.strict()` is what turns those sentences into something
    // a test can fail on: without it a daemon that composed the whole
    // `GetCapabilitiesResult` would ship provenance to every client and nothing
    // would notice.
    for (const forbidden of [
      { detectionSource: { steer: "static" } },
      { cliVersion: { raw: "2.1.251", semver: "2.1.251" } },
      { tools: [{ name: "bash", idempotency_class: "idempotent" }] },
    ]) {
      expect(
        ListCapabilitiesResultSchema.safeParse({ drivers: [{ ...report, ...forbidden }] }).success,
      ).toBe(false);
    }
  });

  it("keeps outputSpeedLevels ABSENT rather than defaulting it to an empty list", () => {
    // Absent and empty are different readings — an empty vocabulary asserts an
    // axis with nothing settable on it. A `.default([])` here would erase the
    // distinction at the parse meant to preserve it.
    const { outputSpeedLevels: _levels, ...withoutLevels } = report;
    const parsed = DriverCapabilityReportSchema.parse(withoutLevels);
    expect(Object.hasOwn(parsed, "outputSpeedLevels")).toBe(false);
  });

  it("bounds the vocabulary's tokens and its length", () => {
    expect(
      DriverCapabilityReportSchema.safeParse({
        ...report,
        outputSpeedLevels: ["x".repeat(DRIVER_WIRE_TOKEN_MAX_LEN + 1)],
      }).success,
    ).toBe(false);
    expect(
      DriverCapabilityReportSchema.safeParse({
        ...report,
        outputSpeedLevels: Array.from({ length: DRIVER_WIRE_CATALOG_ENTRIES_MAX + 1 }, () => "on"),
      }).success,
    ).toBe(false);
  });

  it("REFUSES an empty driverName — the reply quotes the daemon's own registry key", () => {
    expect(
      ListCapabilitiesResultSchema.safeParse({ drivers: [{ ...report, driverName: "" }] }).success,
    ).toBe(false);
  });
});

describe("ListModelsResultSchema / ListModesResultSchema — provenance survives the reply", () => {
  const claudeModel = { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", capabilities: [] };

  it("groups entries per driver rather than flattening them", () => {
    const parsed = ListModelsResultSchema.parse({
      drivers: [
        { driverName: "claude", models: [claudeModel] },
        { driverName: "codex", models: [{ id: "gpt-5.6-luna", name: "Luna", capabilities: [] }] },
      ],
    });
    // The grouping IS the provenance: model ids collide across providers and
    // carry no vendor marker, so a flat array would hand a caller one driver's
    // catalog with no way to tell which.
    expect(parsed.drivers.map((entry) => entry.driverName)).toEqual(["claude", "codex"]);
  });

  it("keeps effortLevels ABSENT for a model that exposes no effort axis", () => {
    const parsed = ProviderModelSchema.parse(claudeModel);
    expect(Object.hasOwn(parsed, "effortLevels")).toBe(false);
    expect(
      ProviderModelSchema.safeParse({ ...claudeModel, effortLevels: ["low", "high"] }).success,
    ).toBe(true);
  });

  it("bounds model tokens and the per-driver catalog length", () => {
    expect(
      ProviderModelSchema.safeParse({
        ...claudeModel,
        id: "x".repeat(DRIVER_WIRE_TOKEN_MAX_LEN + 1),
      }).success,
    ).toBe(false);
    expect(ProviderModelSchema.safeParse({ ...claudeModel, id: "" }).success).toBe(false);
    expect(
      ListModelsResultSchema.safeParse({
        drivers: [
          {
            driverName: "claude",
            models: Array.from({ length: DRIVER_WIRE_CATALOG_ENTRIES_MAX + 1 }, () => claudeModel),
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("REFUSES an unknown key on a model, a mode, and either group", () => {
    expect(ProviderModelSchema.safeParse({ ...claudeModel, deprecated: true }).success).toBe(false);
    expect(ProviderModeSchema.safeParse({ id: "plan", name: "Plan", default: true }).success).toBe(
      false,
    );
    expect(
      ListModesResultSchema.safeParse({
        drivers: [{ driverName: "codex", modes: [{ id: "plan", name: "Plan" }], count: 1 }],
      }).success,
    ).toBe(false);
  });

  it("accepts a well-formed mode reply", () => {
    const parsed = ListModesResultSchema.parse({
      drivers: [{ driverName: "codex", modes: [{ id: "plan", name: "Plan" }] }],
    });
    expect(parsed.drivers[0]?.modes[0]?.id).toBe("plan");
  });
});

describe("InterruptRunParamsSchema — the run-addressed wire shape, RunIdSchema's first consumer", () => {
  it("accepts the run id alone and with a reason", () => {
    expect(InterruptRunParamsSchema.parse({ runId: A_RUN_ID }).runId).toBe(A_RUN_ID);
    expect(
      InterruptRunParamsSchema.safeParse({ runId: A_RUN_ID, reason: "user asked to stop" }).success,
    ).toBe(true);
  });

  it("REFUSES a session selector beside the run id", () => {
    // A run id is globally unique, so a `sessionId` here would be a second
    // addressing key with no honest answer when the two disagree. T4.9's
    // console-parity verbs are the deliberate contrast — their targets are only
    // identified within a session.
    expect(
      InterruptRunParamsSchema.safeParse({ runId: A_RUN_ID, sessionId: ANOTHER_UUID }).success,
    ).toBe(false);
  });

  it("REFUSES a non-UUID run id and an over-length reason", () => {
    expect(InterruptRunParamsSchema.safeParse({ runId: "run-1" }).success).toBe(false);
    expect(
      InterruptRunParamsSchema.safeParse({
        runId: A_RUN_ID,
        reason: "x".repeat(DRIVER_WIRE_REASON_MAX_LEN + 1),
      }).success,
    ).toBe(false);
  });
});

describe("ApplyInterventionParamsSchema — three arms, and the fourth is a parse refusal", () => {
  const base = {
    targetRunId: A_RUN_ID,
    expectedRunVersion: 3,
    clientIdempotencyKey: ANOTHER_UUID,
  };

  it("accepts all three V1 intervention arms", () => {
    expect(
      ApplyInterventionParamsSchema.safeParse({
        ...base,
        type: "steer",
        payload: { content: "use the other branch" },
      }).success,
    ).toBe(true);
    expect(
      ApplyInterventionParamsSchema.safeParse({ ...base, type: "interrupt", payload: {} }).success,
    ).toBe(true);
    expect(
      ApplyInterventionParamsSchema.safeParse({
        ...base,
        type: "cancel",
        payload: { reason: "abandoned" },
      }).success,
    ).toBe(true);
  });

  it("REFUSES a rollback arm at the discriminator, not merely at its payload", () => {
    // `InterventionType` carries four members; this dispatch surface carries
    // three. Rollback's driver leg is the dedicated `rollbackTo` operation with
    // its own params and its own result envelope, so a `rollback` request must
    // fail PARSE rather than reach a handler that would have to invent a
    // refusal for it.
    //
    // The payload here is `{}` — VALID for the interrupt and cancel arms —
    // deliberately, so the refusal can only be coming from the discriminator. A
    // rollback-shaped payload would refuse under any of the three arms' own
    // `.strict()` and would therefore prove nothing about the arm set. The
    // second assertion adds the rollback-shaped case for completeness, and the
    // third pins the issue path to the discriminant so a future arm rename
    // cannot make this test pass for the wrong reason.
    expect(
      ApplyInterventionParamsSchema.safeParse({ ...base, type: "rollback", payload: {} }).success,
    ).toBe(false);
    expect(
      ApplyInterventionParamsSchema.safeParse({
        ...base,
        type: "rollback",
        payload: { targetPosition: 4 },
      }).success,
    ).toBe(false);
    const refusal = ApplyInterventionParamsSchema.safeParse({
      ...base,
      type: "rollback",
      payload: {},
    });
    expect(refusal.success).toBe(false);
    expect(refusal.error?.issues.some((issue) => issue.path.join(".") === "type")).toBe(true);
  });

  it("REFUSES a non-UUID idempotency key — this is the seam that validates it", () => {
    // The §1 param shape carries no schema precisely because this boundary owns
    // the check. A caller-chosen free string would land in a durable receipt and
    // make replay keying depend on client discipline.
    expect(
      ApplyInterventionParamsSchema.safeParse({
        ...base,
        clientIdempotencyKey: "my-key",
        type: "interrupt",
        payload: {},
      }).success,
    ).toBe(false);
  });

  it("REFUSES a fractional or negative expectedRunVersion", () => {
    // Optimistic-concurrency state: either would compare unequal to every stored
    // version and turn the check into an unconditional refusal that reads as a
    // conflict.
    for (const version of [1.5, -1]) {
      expect(
        ApplyInterventionParamsSchema.safeParse({
          ...base,
          expectedRunVersion: version,
          type: "interrupt",
          payload: {},
        }).success,
      ).toBe(false);
    }
  });

  it("bounds steer content, its attachment count, and the turn handle", () => {
    expect(
      ApplyInterventionParamsSchema.safeParse({
        ...base,
        type: "steer",
        payload: { content: "x".repeat(DRIVER_WIRE_STEER_CONTENT_MAX_LEN + 1) },
      }).success,
    ).toBe(false);
    expect(
      ApplyInterventionParamsSchema.safeParse({
        ...base,
        type: "steer",
        payload: {
          content: "ok",
          attachments: Array.from({ length: DRIVER_WIRE_STEER_ATTACHMENTS_MAX + 1 }, () => ({})),
        },
      }).success,
    ).toBe(false);
    expect(
      ApplyInterventionParamsSchema.safeParse({
        ...base,
        type: "steer",
        payload: { content: "ok", expectedTurnId: "t".repeat(DRIVER_WIRE_HANDLE_MAX_LEN + 1) },
      }).success,
    ).toBe(false);
  });

  it("REFUSES an empty steer directive and an unknown payload key", () => {
    expect(
      ApplyInterventionParamsSchema.safeParse({ ...base, type: "steer", payload: { content: "" } })
        .success,
    ).toBe(false);
    expect(
      ApplyInterventionParamsSchema.safeParse({
        ...base,
        type: "steer",
        payload: { content: "ok", priority: "high" },
      }).success,
    ).toBe(false);
  });
});

describe("RespondToRequestParamsSchema — a missing answer is not an answer", () => {
  const base = { runId: A_RUN_ID, requestId: "req-42" };

  it("accepts every legitimate JSON answer, `null` and `false` included", () => {
    for (const response of [null, false, 0, "", { choice: "b" }, []]) {
      expect(RespondToRequestParamsSchema.safeParse({ ...base, response }).success).toBe(true);
    }
  });

  it("REFUSES a request that omits the response key", () => {
    // `z.unknown()` would accept this: `unknown` admits `undefined`, so an
    // omitted key parses clean and the daemon forwards "no answer" to a provider
    // that is blocked waiting for one. The explicit presence predicate is what
    // makes the omission a refusal without narrowing the answer's shape.
    expect(RespondToRequestParamsSchema.safeParse(base).success).toBe(false);
    expect(RespondToRequestParamsSchema.safeParse({ ...base, response: undefined }).success).toBe(
      false,
    );
  });

  it("bounds the provider-minted request handle", () => {
    expect(
      RespondToRequestParamsSchema.safeParse({
        ...base,
        requestId: "r".repeat(DRIVER_WIRE_HANDLE_MAX_LEN + 1),
        response: null,
      }).success,
    ).toBe(false);
    expect(
      RespondToRequestParamsSchema.safeParse({ ...base, requestId: "", response: null }).success,
    ).toBe(false);
  });
});

describe("DriverSubscribeEventsParamsSchema — run-scoped, and answered by the shared ack", () => {
  it("accepts the run id and refuses anything beside it", () => {
    expect(DriverSubscribeEventsParamsSchema.parse({ runId: A_RUN_ID }).runId).toBe(A_RUN_ID);
    expect(
      DriverSubscribeEventsParamsSchema.safeParse({ runId: A_RUN_ID, afterCursor: "c1" }).success,
    ).toBe(false);
    expect(DriverSubscribeEventsParamsSchema.safeParse({}).success).toBe(false);
  });
});

// --------------------------------------------------------------------------
// T3.16 — the typed provider usage-limit signal, as a SIBLING axis
// --------------------------------------------------------------------------

describe("ProviderUsageLimitSignal — a sibling axis, never a RecoveryCondition member", () => {
  it("keeps the two cause vocabularies mutually unassignable in BOTH directions", () => {
    // The row's rule — "the signal is never emitted as a `RecoveryCondition`
    // member" — is a claim about the TYPES, so it is asserted where it can
    // actually fail. A runtime check could only ever sample the values a test
    // happened to write down; these two lines fail the build the moment either
    // union grows into the other, which is the drift that would let a
    // self-clearing pause be routed into the operator-remediation queue.
    //
    // BOTH directions, deliberately. A one-way check would still pass if
    // `RecoveryCondition` were widened to contain the usage-limit cause, which
    // is precisely the widening this axis exists to prevent.
    // @ts-expect-error — a usage-limit cause is not a recovery condition.
    const conditionFromCause: RecoveryCondition = "plan-allowance-exhausted";
    // @ts-expect-error — a recovery condition is not a usage-limit cause.
    const causeFromCondition: ProviderUsageLimitCause = "reauth-required";
    void conditionFromCause;
    void causeFromCondition;

    // The runtime companion: the value sets are disjoint too, so a consumer
    // switching on one can never fall into the other's arm.
    const recoveryConditions: readonly RecoveryCondition[] = ["recovery-needed", "reauth-required"];
    const usageLimitCauses: readonly ProviderUsageLimitCause[] = ["plan-allowance-exhausted"];
    for (const cause of usageLimitCauses) {
      expect(recoveryConditions).not.toContain(cause as string);
    }
  });

  it("restates the V1 capability matrix UNWIDENED — recognition is a uniform obligation", () => {
    // T3.16 adds NO capability flag, on the `probeAuth` precedent: a flag would
    // let a driver declare the obligation away, and a run refused for spend
    // would then sit in the generic failure path with nothing saying why.
    expect(DRIVER_CAPABILITY_FLAGS).toHaveLength(17);
    for (const flag of DRIVER_CAPABILITY_FLAGS) {
      expect(flag).not.toMatch(/usage|limit|rate/);
    }
  });

  it("makes a bare instant and a bare provenance stamp both inexpressible", () => {
    // The boundary is ONE object rather than two sibling optionals, which is
    // what stops a consumer holding an instant it cannot weigh.
    const boundary: ProviderUsageLimitResetBoundary = {
      resetsAt: "2026-09-01T00:00:00.000Z",
      provenance: "provider-stated",
    };
    expect(boundary.provenance).toBe("provider-stated");

    // @ts-expect-error — an instant with no provenance stamp does not typecheck.
    const instantOnly: ProviderUsageLimitResetBoundary = { resetsAt: "2026-09-01T00:00:00.000Z" };
    // @ts-expect-error — a provenance stamp naming no instant does not either.
    const provenanceOnly: ProviderUsageLimitResetBoundary = { provenance: "runtime-derived" };
    void instantOnly;
    void provenanceOnly;

    const provenances: readonly ProviderUsageLimitResetProvenance[] = [
      "provider-stated",
      "runtime-derived",
    ];
    expect(provenances).toHaveLength(2);
  });

  it("carries a REQUIRED cause and an OPTIONAL boundary, because the absences differ", () => {
    // A recognized refusal parks whether or not a window was reported; a missing
    // boundary changes only whether a resume is SCHEDULED.
    const withoutBoundary: ProviderUsageLimitSignal = { cause: "plan-allowance-exhausted" };
    expect(withoutBoundary.resetBoundary).toBeUndefined();

    const withBoundary: ProviderUsageLimitSignal = {
      cause: "plan-allowance-exhausted",
      resetBoundary: { resetsAt: "2026-09-01T00:00:00.000Z", provenance: "runtime-derived" },
    };
    expect(withBoundary.resetBoundary?.provenance).toBe("runtime-derived");

    // @ts-expect-error — a signal with no cause is not a signal.
    const causeless: ProviderUsageLimitSignal = {
      resetBoundary: { resetsAt: "2026-09-01T00:00:00.000Z", provenance: "provider-stated" },
    };
    void causeless;
  });
});

// --------------------------------------------------------------------------
// T3.17 — additive-optional provider-account identity on the spawn carriers
// --------------------------------------------------------------------------

describe("provider-account identity on CreateSessionParams / ResumeSessionParams", () => {
  it("leaves a no-identifier create structurally identical to the pre-amendment shape", () => {
    // ADDITIVE-OPTIONAL means the unchanged path stays unchanged: a create that
    // names no account carries no member for one, so nothing downstream can read
    // an absent account as a present-but-empty one.
    const preAmendmentCreate: CreateSessionParams = {
      sessionId: SESSION_ID,
      config: { cwd: "/tmp/session" },
    };
    expect(Object.keys(preAmendmentCreate).sort()).toEqual(["config", "sessionId"]);
    expect("providerAccountId" in preAmendmentCreate).toBe(false);
    expect(preAmendmentCreate.providerAccountId).toBeUndefined();

    const preAmendmentResume: ResumeSessionParams = {
      sessionId: SESSION_ID,
      resumeHandle: "provider-handle-1",
    };
    expect(Object.keys(preAmendmentResume).sort()).toEqual(["resumeHandle", "sessionId"]);
    expect("providerAccountId" in preAmendmentResume).toBe(false);
  });

  it("admits the identifier on BOTH carriers, because resume is a fresh spawn", () => {
    const create: CreateSessionParams = {
      sessionId: SESSION_ID,
      config: {},
      providerAccountId: "acct-01J8ZK",
    };
    const resume: ResumeSessionParams = {
      sessionId: SESSION_ID,
      resumeHandle: "provider-handle-1",
      providerAccountId: "acct-01J8ZK",
    };
    // The SAME identity on both, which is the property: a resume that re-realized
    // whichever account is default now would move a live run's spend onto an
    // account it was never admitted against.
    expect(resume.providerAccountId).toBe(create.providerAccountId);
  });

  it("keeps the identifier OPAQUE — a structured value is not admitted", () => {
    // The driver may not parse it, so the contract does not hand it anything
    // parseable: it is a string, not a record naming a home or a credential.
    const structured: CreateSessionParams = {
      sessionId: SESSION_ID,
      config: {},
      // @ts-expect-error — an account identity is opaque, never a structure.
      providerAccountId: { accountId: "acct-01J8ZK", credentialHome: "/home/.codex" },
    };
    void structured;
  });
});

// --------------------------------------------------------------------------
// T4.9 — the two console-parity wire requests + the group-list reply schemas
// --------------------------------------------------------------------------

describe("CompactContextRequestSchema / ListProviderCommandsRequestSchema — session-addressed, and no binding member exists", () => {
  const AGENT_UUID = "770e8400-e29b-41d4-a716-446655440002";
  const compactRequest = { sessionId: SESSION_UUID, runId: RUN_UUID };
  const listRequest = { sessionId: SESSION_UUID, agentId: AGENT_UUID };

  it("accepts the canonical session-scoped pair on both requests", () => {
    expect(CompactContextRequestSchema.parse(compactRequest)).toEqual(compactRequest);
    expect(ListProviderCommandsRequestSchema.parse(listRequest)).toEqual(listRequest);
  });

  it("REFUSES a bindingId beside either pair — the wire admits NO binding member", () => {
    // The canonical contract publishes no `bindingId` anywhere on the client
    // surface, and `.strict()` is what turns that sentence into a refusal: a
    // caller naming a binding believes it holds an addressing key the daemon
    // deliberately never handed out, and a silently ignored key would leave it
    // believing the dispatch was binding-routed.
    expect(
      CompactContextRequestSchema.safeParse({ ...compactRequest, bindingId: "binding-1" }).success,
    ).toBe(false);
    expect(
      ListProviderCommandsRequestSchema.safeParse({ ...listRequest, bindingId: "binding-1" })
        .success,
    ).toBe(false);
  });

  it("REFUSES a non-UUID value in every addressing slot", () => {
    // All three are untrusted caller-supplied strings; UUID-shape rejection is
    // what stops a path or SQL fragment from reaching a store lookup (the
    // `RunIdSchema` doctrine, applied to the whole address).
    expect(
      CompactContextRequestSchema.safeParse({ ...compactRequest, sessionId: "../../etc" }).success,
    ).toBe(false);
    expect(
      CompactContextRequestSchema.safeParse({ ...compactRequest, runId: "run-1" }).success,
    ).toBe(false);
    expect(
      ListProviderCommandsRequestSchema.safeParse({ ...listRequest, agentId: "agent-1" }).success,
    ).toBe(false);
  });

  it("REFUSES a request missing either half of its pair", () => {
    expect(CompactContextRequestSchema.safeParse({ sessionId: SESSION_UUID }).success).toBe(false);
    expect(CompactContextRequestSchema.safeParse({ runId: RUN_UUID }).success).toBe(false);
    expect(ListProviderCommandsRequestSchema.safeParse({ sessionId: SESSION_UUID }).success).toBe(
      false,
    );
    expect(ListProviderCommandsRequestSchema.safeParse({ agentId: AGENT_UUID }).success).toBe(
      false,
    );
  });
});

describe("ProviderCommandBindingGroupSchema / ProviderCommandListResultSchema — the reply's first schemas", () => {
  const bindingPair = { driverName: "codex", providerAccountId: "account-1" };
  const entry = { name: "compact", kind: "command", binding: bindingPair };
  const group = { runId: RUN_UUID, binding: bindingPair, entries: [entry], complete: true };

  it("parses the sole-live-run arm and the null-attribution arm alike", () => {
    expect(ProviderCommandBindingGroupSchema.safeParse(group).success).toBe(true);
    expect(ProviderCommandBindingGroupSchema.safeParse({ ...group, runId: null }).success).toBe(
      true,
    );
  });

  it("REFUSES an absent runId key — `.nullable()` is not `.optional()`", () => {
    // The §1 provenance rule: absence would be indistinguishable from a
    // producer that forgot to attribute the group, which is the exact ambiguity
    // the nullable member exists to remove.
    const { runId: _runId, ...withoutRunId } = group;
    expect(ProviderCommandBindingGroupSchema.safeParse(withoutRunId).success).toBe(false);
  });

  it("mirrors the entry schema's binding-pair doctrine: null account parses, placeholder-shaped values refuse", () => {
    expect(
      ProviderCommandBindingGroupSchema.safeParse({
        ...group,
        binding: { driverName: "codex", providerAccountId: null },
      }).success,
    ).toBe(true);
    expect(
      ProviderCommandBindingGroupSchema.safeParse({
        ...group,
        binding: { driverName: "codex", providerAccountId: "" },
      }).success,
    ).toBe(false);
    expect(
      ProviderCommandBindingGroupSchema.safeParse({
        ...group,
        binding: { driverName: "codex" },
      }).success,
    ).toBe(false);
  });

  it("bounds entries at the SAME 512 the provider boundary admits, not this seam's 256", () => {
    // A smaller reply-side cap would turn a legitimate 300-command enumeration
    // that §2 already admitted into a result-validation internal error; the
    // shared constant is what keeps the two boundaries from disagreeing about
    // one list.
    const atCap = {
      ...group,
      entries: Array.from({ length: DRIVER_PROVIDER_COMMAND_ENTRIES_MAX }, () => entry),
    };
    expect(ProviderCommandBindingGroupSchema.safeParse(atCap).success).toBe(true);
    const overCap = {
      ...group,
      entries: Array.from({ length: DRIVER_PROVIDER_COMMAND_ENTRIES_MAX + 1 }, () => entry),
    };
    expect(ProviderCommandBindingGroupSchema.safeParse(overCap).success).toBe(false);
  });

  it("REFUSES an unknown key on the group and on the reply envelope", () => {
    expect(ProviderCommandBindingGroupSchema.safeParse({ ...group, truncatedAt: 12 }).success).toBe(
      false,
    );
    expect(ProviderCommandListResultSchema.safeParse({ bindings: [group], total: 1 }).success).toBe(
      false,
    );
  });

  it("REFUSES the empty group list — a success reply is never empty", () => {
    // The handler refuses an agent with no live binding as `driver.unavailable`
    // BEFORE any dispatch, so zero groups on a resolved reply is a composition
    // bug and `.min(1)` makes it parse as one.
    expect(ProviderCommandListResultSchema.safeParse({ bindings: [] }).success).toBe(false);
    expect(ProviderCommandListResultSchema.safeParse({ bindings: [group] }).success).toBe(true);
    expect(
      ProviderCommandListResultSchema.safeParse({ bindings: [group, { ...group, runId: null }] })
        .success,
    ).toBe(true);
  });
});
