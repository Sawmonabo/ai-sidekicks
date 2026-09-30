// Contract conformance for the provider-driver interface (`provider-driver.ts`). The nominal
// TypeScript surfaces are proven by compilation (a fully typed mock driver plus
// `@ts-expect-error` negatives) and the Zod result and ingress schemas by `.parse()` and
// `.safeParse()`. No driver runs end to end here.
import { describe, expect, it } from "vitest";

import {
  DECLARED_LOSS_KINDS,
  DriverCompactionResultSchema,
  DriverTranscriptExportResultSchema,
  DriverTranscriptReplayResultSchema,
  ProviderCommandEntrySchema,
  type CompactContextParams,
  type DriverCompactionResult,
  type DriverTranscriptExportResult,
  type DriverTranscriptReplayResult,
  type ExportTranscriptParams,
  type ListProviderCommandsParams,
  type ProviderCommandBindingGroup,
  type ProviderCommandListResult,
  type ReplayTranscriptParams,
} from "../provider-driver-transcript.js";
import {
  ArtifactIdSchema,
  CallbackToolInvocationSchema,
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
  DriverInterventionResultSchema,
  IdempotencyClassSchema,
  InterventionTypeSchema,
  McpServerStatusEmissionSchema,
  ProviderToolMetadataSchema,
  RunIdSchema,
  type ApplyInterventionParams,
  type CallbackToolResult,
  type CapabilityDetectionSource,
  type CloseSessionParams,
  type CreateSessionParams,
  type DriverCapabilities,
  type DriverCapabilityFlag,
  type DriverInterventionResult,
  type DriverTransportConfig,
  type ExecutionPosture,
  type GetCapabilitiesResult,
  type InterruptRunParams,
  type InterventionType,
  type McpServerStatusUpdate,
  type NormalizedProviderToolMetadata,
  type ProviderDriver,
  type ProviderMode,
  type ProviderModel,
  type ProviderSessionHandle,
  type RespondToRequestParams,
  type ResumeSessionParams,
  type RunId,
  type SessionCallbackTool,
  type StartRunParams,
  type SubagentPolicy,
} from "../provider-driver.js";
import {
  ApplyInterventionParamsSchema,
  CompactContextRequestSchema,
  DRIVER_WIRE_CATALOG_ENTRIES_MAX,
  DRIVER_WIRE_CONTRACT_VERSION_MAX_LEN,
  DRIVER_WIRE_HANDLE_MAX_LEN,
  DRIVER_WIRE_REASON_MAX_LEN,
  DRIVER_WIRE_TOKEN_MAX_LEN,
  DriverAckResultSchema,
  DriverCapabilitiesSchema,
  DriverCapabilityReportSchema,
  DriverReadParamsSchema,
  DriverSubscribeEventsParamsSchema,
  InterruptRunParamsSchema,
  ListCapabilitiesResultSchema,
  ListModelsRequestSchema,
  ListModelsResultSchema,
  ListModesResultSchema,
  ListProviderCommandsRequestSchema,
  ProviderCommandBindingGroupSchema,
  ProviderCommandListResultSchema,
  ProviderModeSchema,
  ProviderModelSchema,
} from "../provider-driver-wire.js";
import {
  DriverAuthProbeResultSchema,
  DriverResumeResultSchema,
  ForkConversationResultSchema,
  RECOVERY_CONDITIONS,
  RECOVERY_SPAN_CLASSIFICATIONS,
  RecoveryConditionSchema,
  RecoverySpanClassificationSchema,
  type ClearSessionGoalParams,
  type DriverAuthProbeResult,
  type DriverResumeResult,
  type ForkConversationParams,
  type ForkConversationResult,
  type ProviderUsageLimitCause,
  type ProviderUsageLimitResetBoundary,
  type ProviderUsageLimitResetProvenance,
  type ProviderUsageLimitSignal,
  type RecoveryCondition,
  type RecoverySpanClassification,
  type SetSessionGoalParams,
} from "../provider-driver-recovery.js";
import { type SessionId } from "../session.js";
import * as contracts from "../index.js";

// Real RFC 9562 UUIDs; the brands are type-only, so the runtime value is a plain string.
const SESSION_UUID = "550e8400-e29b-41d4-a716-446655440000";
const RUN_UUID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f00";

const SESSION_ID = SESSION_UUID as SessionId;
const RUN_ID = RUN_UUID as RunId;

// The requester-generated key the daemon dedupes on is a UUID, so the fixture is one.
const CLIENT_IDEMPOTENCY_KEY = "6f9619ff-8b86-4011-b42d-00cf4fc964ff";

// A mock implementing every `ProviderDriver` operation must typecheck under `implements` (with
// `exactOptionalPropertyTypes` and `isolatedDeclarations` on); the runtime tests anchor that
// compile proof to an executing test.

class MockProviderDriver implements ProviderDriver {
  public createSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    return Promise.resolve({
      providerSessionId: `provider-${params.sessionId}`,
      resumeHandle: "resume-handle-opaque",
    });
  }

  public resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    // `resumed` carries a binding and the confirmed position, never a failure signal;
    // `sessionPosition` is required.
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

  // `forkConversation` echoes the requested position as the confirmed floor; `sessionPosition`
  // is required on the `applied` arm.
  public forkConversation(params: ForkConversationParams): Promise<ForkConversationResult> {
    return Promise.resolve({ status: "applied", sessionPosition: params.position });
  }

  public respondToRequest(_params: RespondToRequestParams): Promise<void> {
    return Promise.resolve();
  }

  public setSessionGoal(_params: SetSessionGoalParams): Promise<void> {
    return Promise.resolve();
  }

  public clearSessionGoal(_params: ClearSessionGoalParams): Promise<void> {
    return Promise.resolve();
  }

  public closeSession(_params: CloseSessionParams): Promise<void> {
    return Promise.resolve();
  }

  public listModels(): Promise<ProviderModel[]> {
    return Promise.resolve([
      { id: "model-1", name: "Model One", capabilities: ["tool_calls"], fast: false },
    ]);
  }

  public listModes(): Promise<ProviderMode[]> {
    return Promise.resolve([{ id: "mode-1", name: "Mode One" }]);
  }

  public getCapabilities(): Promise<GetCapabilitiesResult> {
    const capabilities: DriverCapabilities = {
      // The flag record is total: omitting one is a type error.
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
        context_compaction: true,
        provider_commands: true,
        output_speed: false,
      },
      contractVersion: "1.0",
    };
    return Promise.resolve({
      capabilities,
      // `tools` is the ingress shape: `idempotency_class` may be omitted.
      tools: [{ name: "read_file" }, { name: "write_file", idempotency_class: "compensable" }],
      // `cliVersion` is required: a report whose provider version did not parse never reaches
      // the daemon.
      cliVersion: { raw: "mock-provider-cli 1.4.2 (build 9)", semver: "1.4.2" },
    });
  }

  public probeAuth(): Promise<DriverAuthProbeResult> {
    return Promise.resolve({ status: "authenticated" });
  }

  public exportTranscript(params: ExportTranscriptParams): Promise<DriverTranscriptExportResult> {
    return Promise.resolve({
      // A conformant driver keeps the turns up to and including the boundary.
      frames: params.transcript.turns
        .filter((turn) => turn.position <= params.boundary)
        .map((turn) => ({ position: turn.position })),
      declaredLosses: ["provider_private_reasoning"],
    });
  }

  public replayTranscript(params: ReplayTranscriptParams): Promise<DriverTranscriptReplayResult> {
    // A memo settlement that names no loss is rejected by the envelope schema, so the degraded
    // arm declares one.
    return params.frames.length === 0
      ? Promise.resolve({
          status: "degraded",
          declaredLosses: ["conversation_history_summarized"],
        })
      : Promise.resolve({ status: "applied", declaredLosses: [] });
  }

  public compactContext(params: CompactContextParams): Promise<DriverCompactionResult> {
    // `boundaryPosition` is required on the applied arm.
    return params.bindingId === ""
      ? Promise.resolve({ status: "refused", reason: "command_absent" })
      : Promise.resolve({ status: "applied", boundaryPosition: 7 });
  }

  public listProviderCommands(
    _params: ListProviderCommandsParams,
  ): Promise<ProviderCommandListResult> {
    // One group: the params name one binding. `enabled` is absent, as for a provider that
    // publishes no enabled/disabled distinction. `runId` is the sole-live-run arm; the `null`
    // arms (zero or two live runs) are resolved by each driver.
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
  // Assigning the mock to a `ProviderDriver` binding fails to compile if any method signature
  // drifts; the runtime checks below anchor it.
  const driver: ProviderDriver = new MockProviderDriver();

  it("is constructable and surfaces all 18 contract operations as callable methods", () => {
    // Interface order, so a change in declaration order shows up as a diff.
    const operationNames = [
      "createSession",
      "resumeSession",
      "startRun",
      "interruptRun",
      "applyIntervention",
      "forkConversation",
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
    // The daemon compares the `resumed` arm's required `sessionPosition` with its recorded one;
    // without it a provider answering with a fresh session would look like a real resume. The
    // whole object is asserted so both required members are exercised.
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

  it("getCapabilities answers every one of the 16 flags and returns ingress tools", async () => {
    const result = await driver.getCapabilities();
    // Hand-written, not derived from `DRIVER_CAPABILITY_FLAGS`, so a flag added or removed
    // there is caught.
    const canonicalCapabilityFlags = [
      "callback_tools",
      "context_compaction",
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
    // The flag record is total: every canonical flag, each answered with a boolean.
    expect(Object.keys(result.capabilities.flags).sort()).toEqual(canonicalCapabilityFlags);
    expect(result.tools).toHaveLength(2);
  });

  it("getCapabilities carries the REQUIRED cliVersion pair (fail-closed by construction)", async () => {
    const result = await driver.getCapabilities();
    expect(result.cliVersion).toEqual({
      raw: "mock-provider-cli 1.4.2 (build 9)",
      semver: "1.4.2",
    });
  });

  it("probeAuth resolves a DriverAuthProbeResult (runtime smoke; NOT capability-gated)", async () => {
    // `probeAuth` is required of every driver and has no capability flag.
    const probe = await driver.probeAuth();
    expect(probe.status).toBe("authenticated");
  });

  it("forkConversation returns the confirmed post-rollback floor (runtime smoke)", async () => {
    const rolled = await driver.forkConversation({
      sessionId: SESSION_ID,
      position: 12,
      bindingId: "binding-abc",
    });
    expect(rolled).toEqual({ status: "applied", sessionPosition: 12 });
  });

  it("both goal operations resolve with no result (runtime smoke)", async () => {
    await expect(
      driver.setSessionGoal({
        sessionId: SESSION_ID,
        bindingId: "binding-abc",
        runId: RUN_ID,
        goalText: "land the migration",
      }),
    ).resolves.toBeUndefined();
    await expect(
      driver.clearSessionGoal({ sessionId: SESSION_ID, bindingId: "binding-abc", runId: RUN_ID }),
    ).resolves.toBeUndefined();
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
    // @ts-expect-error — `steer` requires non-empty `content`, so an empty payload is a type error.
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
    // Binding the session-domain brands here shows the driver reuses them rather than forking.
    const startParams: StartRunParams = {
      runId: RUN_ID,
      agentConfig: {},
    };
    expect(startParams.runId).toBe(RUN_UUID);
  });

  it("carries the native-cap admitted cap on both the start and resume seams", () => {
    // The omitting fixtures above show the field is optional; recovery must be able to
    // re-thread the admitted cap, so the typed presence form is checked on each seam.
    const cappedStart: StartRunParams = {
      runId: RUN_ID,
      agentConfig: {},
      admittedCostCapUsdMicros: 25_000_000,
    };
    const cappedResume: ResumeSessionParams = {
      sessionId: SESSION_ID,
      resumeHandle: "resume-handle-opaque",
      admittedCostCapUsdMicros: 25_000_000,
    };
    const cappedCreate: CreateSessionParams = {
      sessionId: SESSION_ID,
      config: {},
      admittedCostCapUsdMicros: 25_000_000,
    };
    expect(cappedStart.admittedCostCapUsdMicros).toBe(25_000_000);
    expect(cappedResume.admittedCostCapUsdMicros).toBe(25_000_000);
    expect(cappedCreate.admittedCostCapUsdMicros).toBe(25_000_000);
  });
});

// An off-union capability flag is a type error. `DriverCapabilities.flags` is
// `Record<DriverCapabilityFlag, boolean>`, so the `@ts-expect-error` directives below assert that
// an extra key and an incomplete record are both rejected. An unused directive is itself a TS2578
// error, so the check fails if the invalid flag ever became valid.

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
      // `pause` is deliberately not a driver capability (it is an orchestration-layer construct)
      // and not an intervention type. An excess key on a `Record<Union, …>` literal is a type error.
      // @ts-expect-error pause is not a DriverCapabilityFlag
      pause: true,
    };
    // The runtime read keeps the binding used; the compile is the check.
    expect(flagsWithExtra.resume).toBe(true);
  });

  it("rejects an incomplete flag record that omits a required capability (totality)", () => {
    // The flag record is total, so a driver cannot leave a capability unanswered. Omitting the
    // three newest flags shows totality covers the whole union, not only the original flags.
    // @ts-expect-error the flag record is total and must answer every flag
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

// Silent provider-session replacement is inexpressible: `DriverResumeResult` is a
// `status`-discriminated union. `failed` carries the recovery condition, span classification
// and failure detail but no `bindingId` or `sessionPosition`; `resumed` carries those two and
// neither failure axis. A failed resume must surface the failure, never quietly create a
// replacement session under the same run.

describe("ProviderDriver contract: failed resume cannot carry a binding", () => {
  it("forbids accessing `.bindingId` after narrowing to status:'failed' (compile-time)", () => {
    // Parse through the schema so the static type is the full `DriverResumeResult` union; the
    // `@ts-expect-error` below is then checked against the narrowed `failed` variant.
    const resume: DriverResumeResult = DriverResumeResultSchema.parse({
      status: "failed",
      recoveryCondition: "recovery-needed",
      recoverySpanClassification: "irreversible",
      providerFailureDetail: "provider endpoint returned 410 Gone",
    });

    if (resume.status === "failed") {
      expect(resume.recoveryCondition).toBe("recovery-needed");
      expect(resume.recoverySpanClassification).toBe("irreversible");
      expect(resume.providerFailureDetail).toBe("provider endpoint returned 410 Gone");

      // A binding on the `failed` variant is a type error: silent replacement is inexpressible.
      // @ts-expect-error bindingId does not exist on the failed variant
      const leakedBinding = resume.bindingId;
      // Nor a position: a failed resume confirms none for the daemon to compare.
      // @ts-expect-error sessionPosition does not exist on the failed variant
      const leakedPosition = resume.sessionPosition;
      // Both are undefined at runtime; the compile errors above are the check.
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
      // The `resumed` variant has neither failure axis.
      // @ts-expect-error recoveryCondition does not exist on the resumed variant
      const leakedRecovery = success.recoveryCondition;
      // @ts-expect-error recoverySpanClassification is a failure axis, absent on resumed
      const leakedClassification = success.recoverySpanClassification;
      expect(leakedRecovery).toBeUndefined();
      expect(leakedClassification).toBeUndefined();
    } else {
      throw new Error(`expected the resumed variant, got status=${success.status}`);
    }
  });
});

// `ProviderToolMetadataSchema` is a transforming schema (input differs from output): an
// omitted `idempotency_class` defaults to `manual_reconcile_only` in the output. A driver may
// omit it at ingress; an undeclared class is not a contract violation.

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
    // Tool metadata declarations ignore unknown keys, unlike the `.strict()` result envelopes.
    // `toEqual` on the output shows the key was stripped, not passed through.
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

// `name` and `description` parse untrusted provider output through `wireFreeFormString`: empty,
// whitespace-only, NUL-containing and over-max strings are rejected, not truncated. Over-max
// fixtures use the exported `*_MAX_LEN` constants.

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

  // `.max()` is inclusive; asserting only `MAX_LEN + 1` would let an off-by-one bound pass.
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

// Parses untrusted provider output. A flat object, not a union: `applied` and `degraded` differ
// only by the optional `fallbackAction` hint and `refusalCode`; `.strict()` rejects unknown keys.

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

  // `refusalCode` is a closed literal because its consumers (a client render, a driver-side
  // settlement) branch on the one value; a free string would let a provider report refusals no
  // reader recognizes.
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
    // The code says the user's text was swallowed, which `applied` denies; accepted, the two
    // fields would disagree.
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

  // Inclusive `.max()`: an exactly-MAX_LEN value is accepted.
  it("accepts a `fallbackAction` at exactly DRIVER_FALLBACK_ACTION_MAX_LEN (inclusive boundary)", () => {
    expect(
      DriverInterventionResultSchema.safeParse({
        status: "degraded",
        fallbackAction: "a".repeat(DRIVER_FALLBACK_ACTION_MAX_LEN),
      }).success,
    ).toBe(true);
  });
});

// `DriverResumeResultSchema`, the resumeSession result envelope. Discriminated over `status`;
// each arm is `.strict()`, so neither a binding nor a position can ride along on a failure and
// neither failure axis on a success. Every negative fixture below is valid except for the one
// defect its title names; otherwise it could keep failing on a missing sibling and stop
// exercising the bound it guards.

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

  // Omitted required members.

  it("rejects a `resumed` object missing bindingId (field surfaced in the issue path)", () => {
    const result = DriverResumeResultSchema.safeParse({ status: "resumed", sessionPosition: 7 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("bindingId");
    }
  });

  it("rejects a `resumed` object missing sessionPosition (a resume the daemon could not position-compare)", () => {
    // With no reported position there is nothing to compare against the recorded one, so a
    // provider answering with a fresh session would look like a genuine resume.
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
    // Required so a driver that cannot classify the halted span says `unclassifiable` (handled
    // as `irreversible`) instead of omitting the axis and leaving the blast radius unrecorded.
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

  // Off-union values on the two failed-arm enums.

  it("rejects a `failed` object whose recoveryCondition is not a RecoveryCondition member (cause surfaced on recoveryCondition)", () => {
    const result = DriverResumeResultSchema.safeParse({
      status: "failed",
      recoveryCondition: "all-good",
      recoverySpanClassification: "irreversible",
      providerFailureDetail: "provider session expired",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The defect is an off-union value, not a missing field, so assert the issue's path.
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("recoveryCondition");
    }
  });

  it("rejects a `failed` object whose recoverySpanClassification is off-union (cause surfaced on that path)", () => {
    // Admitting `unclassifiable` as an answer must not make the classification open.
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

  // Arm-crossing members (`.strict()` on each arm).

  it("rejects silent replacement — a `failed` object carrying a bindingId (.strict() arm guard; unrecognized key surfaced)", () => {
    // The `failed` arm is `.strict()`, so a smuggled `bindingId` is rejected at runtime as well
    // as by the type.
    const result = DriverResumeResultSchema.safeParse({
      status: "failed",
      recoveryCondition: "recovery-needed",
      recoverySpanClassification: "irreversible",
      providerFailureDetail: "provider session expired",
      bindingId: "binding-smuggled",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // A `.strict()` rejection is an `unrecognized_keys` issue at the object root with the
      // offending names on `issue.keys`, so assert on `keys`; that pins the cause to the
      // smuggled `bindingId`.
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

  // Wrong types and an unknown discriminator.

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

  // `sessionPosition` shape bound; comparing it with the recorded position is the daemon's job.

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
    // `.min(0)` is inclusive: rejecting 0 would make a session at its first position
    // unreportable. Whether 0 is the recorded position is the daemon's question.
    expect(
      DriverResumeResultSchema.safeParse({
        status: "resumed",
        bindingId: "binding-abc",
        sessionPosition: 0,
      }).success,
    ).toBe(true);
  });

  // `bindingId` carries whitespace and NUL guards as defense in depth because it lands in
  // `runtime_bindings` and on events.

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

  // Inclusive `.max()` on both strings: an exactly-MAX_LEN value is accepted.
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

// `DRIVER_CAPABILITY_FLAGS` is the single source the flag union derives from, so these checks use
// hand-spelled expectations; a check derived from the const would be vacuous.

describe("DRIVER_CAPABILITY_FLAGS — sixteen-flag currency", () => {
  it("carries exactly sixteen flags, in canonical", () => {
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
      "context_compaction",
      "provider_commands",
      "output_speed",
    ]);
    expect(DRIVER_CAPABILITY_FLAGS).toHaveLength(16);
  });

  it("declares no duplicate flag (the cardinality guard compares key COUNT, so a duplicate would mask an omission)", () => {
    expect(new Set(DRIVER_CAPABILITY_FLAGS).size).toBe(DRIVER_CAPABILITY_FLAGS.length);
  });

  it("places `transcript_replay` at its canonical position rather than at the end", () => {
    // The array order is the canonical enum order; asserting by index means a flag appended
    // for convenience cannot pass.
    expect(DRIVER_CAPABILITY_FLAGS.indexOf("transcript_replay")).toBe(12);
    expect(DRIVER_CAPABILITY_FLAGS.at(-1)).toBe("output_speed");
  });

  it("APPENDS the three console-parity flags last, where the canonical order puts them", () => {
    // Position is canonical, and for these three it is the end. Asserted by index: a reordering
    // that kept membership would pass `toContain` and break every reader of position.
    expect(DRIVER_CAPABILITY_FLAGS.indexOf("context_compaction")).toBe(13);
    expect(DRIVER_CAPABILITY_FLAGS.indexOf("provider_commands")).toBe(14);
    expect(DRIVER_CAPABILITY_FLAGS.indexOf("output_speed")).toBe(15);
  });

  it("EXCLUDES `pause` — a permanent exclusion, not a pending one", () => {
    // Pause is an orchestration-layer construct (interrupt run, persist state, queue resume),
    // never a driver capability. Pinned by name so the exclusion is not read as an oversight.
    expect(DRIVER_CAPABILITY_FLAGS as readonly string[]).not.toContain("pause");
  });

  it("re-derives the DriverCapabilityFlag union from the runtime const (single source)", () => {
    // This compile-time binding catches one drift direction: a hand-written union that dropped a
    // member could not accept the const. It compiles because the union is
    // `(typeof DRIVER_CAPABILITY_FLAGS)[number]`, not a second listing.
    const flags: readonly DriverCapabilityFlag[] = DRIVER_CAPABILITY_FLAGS;
    // The runtime expectation anchors the compile check; comparing the const to itself would
    // hold for any value.
    expect(flags).toHaveLength(16);
  });
});

// The `rollback`-gated envelope. As with `DriverResumeResult`, `sessionPosition` is required on
// `applied`, so a rollback that succeeded without a confirmed floor cannot be expressed. When
// present, `bindingId` is the binding the fork minted. Both arms are `.strict()`.

describe("ForkConversationResultSchema — rollback envelope", () => {
  it("parses an applied rollback carrying the confirmed floor", () => {
    const parsed: ForkConversationResult = ForkConversationResultSchema.parse({
      status: "applied",
      sessionPosition: 41,
    });
    expect(parsed).toEqual({ status: "applied", sessionPosition: 41 });
  });

  it("parses an applied rollback that repointed the run's live binding", () => {
    expect(
      ForkConversationResultSchema.safeParse({
        status: "applied",
        sessionPosition: 0,
        bindingId: "binding-forked",
      }).success,
    ).toBe(true);
  });

  it("rejects an applied rollback with NO sessionPosition (a success without a confirmed floor)", () => {
    const result = ForkConversationResultSchema.safeParse({ status: "applied" });
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
        ForkConversationResultSchema.safeParse({ status: "applied", sessionPosition: invalidValue })
          .success,
      ).toBe(false);
    },
  );

  it("forbids `sessionPosition` on the degraded arm after narrowing (compile-time)", () => {
    const degraded: ForkConversationResult = ForkConversationResultSchema.parse({
      status: "degraded",
      fallbackAction: "manual_rewind",
    });
    if (degraded.status === "degraded") {
      expect(degraded.fallbackAction).toBe("manual_rewind");
      // @ts-expect-error sessionPosition does not exist on the degraded variant
      const leakedPosition = degraded.sessionPosition;
      expect(leakedPosition).toBeUndefined();
    } else {
      throw new Error(`expected the degraded variant, got status=${degraded.status}`);
    }
  });

  it("rejects an unknown key on the applied arm (.strict())", () => {
    const result = ForkConversationResultSchema.safeParse({
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
        ForkConversationResultSchema.safeParse({
          status: "applied",
          sessionPosition: 1,
          bindingId: invalidValue,
        }).success,
      ).toBe(false);
    },
  );

  it("accepts a rollback `bindingId` at exactly DRIVER_BINDING_ID_MAX_LEN (inclusive boundary)", () => {
    expect(
      ForkConversationResultSchema.safeParse({
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
        ForkConversationResultSchema.safeParse({ status: "degraded", fallbackAction: invalidValue })
          .success,
      ).toBe(false);
    },
  );
});

// `DriverAuthProbeResultSchema`, the flagless zero-turn probe. Three values, not a boolean:
// `indeterminate` fails closed for admission but stays distinguishable from `unauthenticated`,
// so probe health and credential state never merge.

describe("DriverAuthProbeResultSchema — auth-probe envelope", () => {
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

// `CallbackToolInvocation` and `McpServerStatusEmission` are built by the driver from untrusted
// provider wire output; these parses are the last check before daemon-owned code. Both are
// `.strict()`, unlike the tolerant `ProviderToolMetadataSchema`, because they are fixed-field
// driver constructions, not extensible provider declarations.

describe("CallbackToolInvocationSchema — callback-tool dispatch seam", () => {
  const validInvocation = {
    toolName: "request_approval",
    arguments: { path: "/workspace/src/index.ts" },
    toolCallId: "call_01H8XYZ",
    sessionId: SESSION_UUID,
    runId: RUN_UUID,
  };

  it("parses a well-formed invocation and preserves the correlation id verbatim", () => {
    const parsed = CallbackToolInvocationSchema.parse(validInvocation);
    // Verbatim: tool events pair by exact string match, so a normalized id would break the
    // pairing silently.
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

describe("McpServerStatusEmissionSchema — MCP status producer seam", () => {
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
    // The daemon stamps leg identity; a driver that attributes its emission to another leg is
    // rejected outright, not stripped.
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

// `InterventionType` is the intervention vocabulary; the arms of `ApplyInterventionParams` are
// the dispatch surface, one per intervention a driver applies.

describe("InterventionType — the vocabulary and the three dispatch arms", () => {
  it("accepts every member of the type", () => {
    // `Record<InterventionType, true>` fails to compile on a missing or extra member, so
    // accepting every key binds the runtime spelling to the type.
    const interventionTypeMembers: Record<InterventionType, true> = {
      steer: true,
      interrupt: true,
      cancel: true,
      faster_model_retry: true,
    };
    for (const member of Object.keys(interventionTypeMembers)) {
      expect(InterventionTypeSchema.safeParse(member).success).toBe(true);
    }
  });

  it("rejects `pause` as an InterventionType", () => {
    // @ts-expect-error pause is not an InterventionType
    const notAnInterventionType: InterventionType = "pause";
    expect(notAnInterventionType).toBe("pause");
  });

  it("forbids a `rollback` arm on ApplyInterventionParams (compile-time)", () => {
    const rollbackDispatch: ApplyInterventionParams = {
      // @ts-expect-error `ApplyInterventionParams` has no `rollback` dispatch arm
      type: "rollback",
      targetRunId: RUN_ID,
      expectedRunVersion: 1,
      clientIdempotencyKey: CLIENT_IDEMPOTENCY_KEY,
      payload: { reason: "rewind to the last green turn" },
    };
    void rollbackDispatch;
  });
});

// `clientIdempotencyKey` is mandatory on every dispatch arm: the requester-generated UUID the
// daemon dedupes on turns at-least-once delivery into exactly-once application. Like
// `expectedRunVersion` it is non-optional, so an absent key is a type error. Each arm declares
// it separately, so all three omissions are proven; each `@ts-expect-error` fails as unused
// (TS2578) if the requirement is dropped.

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
    // Carried verbatim: the daemon dedupes on exact match, so normalizing would break dedupe
    // silently.
    expect(steer.clientIdempotencyKey).toBe(CLIENT_IDEMPOTENCY_KEY);
    expect(interrupt.clientIdempotencyKey).toBe(CLIENT_IDEMPOTENCY_KEY);
    expect(cancel.clientIdempotencyKey).toBe(CLIENT_IDEMPOTENCY_KEY);
  });

  it("forbids omitting clientIdempotencyKey on the steer arm (compile-time)", () => {
    // @ts-expect-error clientIdempotencyKey is required
    const steerWithoutKey: ApplyInterventionParams = {
      type: "steer",
      targetRunId: RUN_ID,
      expectedRunVersion: 1,
      payload: { content: "stay on task" },
    };
    void steerWithoutKey;
  });

  it("forbids omitting clientIdempotencyKey on the interrupt arm (compile-time)", () => {
    // @ts-expect-error clientIdempotencyKey is required on the interrupt arm too
    const interruptWithoutKey: ApplyInterventionParams = {
      type: "interrupt",
      targetRunId: RUN_ID,
      expectedRunVersion: 1,
      payload: { reason: "operator halt" },
    };
    void interruptWithoutKey;
  });

  it("forbids omitting clientIdempotencyKey on the cancel arm (compile-time)", () => {
    // @ts-expect-error clientIdempotencyKey is required on the cancel arm too
    const cancelWithoutKey: ApplyInterventionParams = {
      type: "cancel",
      targetRunId: RUN_ID,
      expectedRunVersion: 1,
      payload: { reason: "superseded" },
    };
    void cancelWithoutKey;
  });
});

describe("DriverResumeResultSchema — RecoveryCondition re-type", () => {
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
    // `reauth-required` parses, but the schema is not open. Every other member is valid, so the
    // sole defect is the off-union condition.
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

// `RecoverySpanClassification` is the second recovery axis on the failed variant, a sibling of
// `RecoveryCondition`: that one names why the run needs an operator, this one what the halted
// span contains, so policy can tier on blast radius. It is required on this live return (a
// resume failure is produced fresh, never replayed); a driver that cannot classify emits
// `unclassifiable`, which the consumer handles as `irreversible`, instead of omitting the axis.

describe("DriverResumeResultSchema — RecoverySpanClassification on the failed variant", () => {
  it("carries exactly the four canonical members", () => {
    // Hand-spelled, not derived from the type; the typed binding fails to compile on an
    // off-union entry.
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
    // Its own test because it makes required-ness workable: a driver with no way to classify
    // the span has a legitimate value to send, so omission is a protocol defect.
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
    // The axes are independent: a `reauth-required` failure over a `read_only` span is
    // expressible and routes on remediation and blast radius separately.
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

// Each recovery vocabulary is referenced at every carrying surface, never re-inlined. The type
// system does not catch a re-inlined `z.enum` narrower than the union, because `z.ZodType` is
// covariant in its output and it still satisfies a `z.ZodType<RecoveryCondition>` annotation.
// The cost of that drift is a new condition dead-lettering at parse in whichever carrier nobody
// updated, so these tests go red on it.

describe("Recovery vocabularies — hoist", () => {
  it("carries exactly the two canonical conditions", () => {
    // Hand-spelled, not read off the array under test; an entry that left the union fails to
    // compile.
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
    // Single-sourcing the values must not make either parser permissive, and the two axes stay
    // disjoint so a consumer switching on one never falls into the other's arm.
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
    // The drift tripwire, driven from the arrays rather than a written-out list: a member added
    // upstream must reach this carrier, or a re-inlined `z.enum` here rejects it and turns this
    // red instead of dead-lettering the member at parse in production.
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
    // Each axis is tested with the other held valid, so the refusal cannot be attributed to the
    // wrong field.
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
    // A resume failure is produced fresh and never replayed, so neither axis is ever optional.
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
    // `index.ts` re-exports this module with `export *`, so consumers outside the package see
    // these symbols only through that line; importing via `../index.js` exercises it. Identity
    // matters: a shadow copy would pass a defined-ness check while drifting from the parser the
    // daemon validates against.
    expect(contracts.RecoveryConditionSchema).toBe(RecoveryConditionSchema);
    expect(contracts.RecoverySpanClassificationSchema).toBe(RecoverySpanClassificationSchema);
    expect(contracts.RECOVERY_CONDITIONS).toBe(RECOVERY_CONDITIONS);
    expect(contracts.RECOVERY_SPAN_CLASSIFICATIONS).toBe(RECOVERY_SPAN_CLASSIFICATIONS);
  });
});

// Structural invariants proven by compilation. Each `@ts-expect-error` fails as unused (TS2578)
// under `tsc -p tsconfig.test.json` if the shape loosens.

describe("spawn/turn parity surfaces — structural invariants", () => {
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
    context_compaction: false,
    provider_commands: false,
    output_speed: false,
  };

  it("requires `cliVersion` on GetCapabilitiesResult (fail-closed by construction)", () => {
    // @ts-expect-error cliVersion is required
    const reportWithoutVersion: GetCapabilitiesResult = {
      capabilities: { flags: allFlagsDenied, contractVersion: "1.0" },
      tools: [],
    };
    void reportWithoutVersion;
  });

  // `detectionSource`: optional and live-scoped.

  it("accepts a report WITHOUT `detectionSource` — the hydrate arm", () => {
    // Optional by contract: `DriverCapabilitiesWriter.hydrate()` rebuilds this wrapper from a
    // cache that stores flag values, not provenance, so a required member would be
    // unsatisfiable there.
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
        // A mix of `static` and `probed` keeps the fixture exercising mixed provenance.
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
      // @ts-expect-error a partial provenance map is a type error; the record is total
      detectionSource: { resume: "static" },
    };
    void partial;
  });

  it("closes `CapabilityDetectionSource` at exactly `static` and `probed`", () => {
    const declared: CapabilityDetectionSource = "static";
    const read: CapabilityDetectionSource = "probed";
    expect([declared, read]).toStrictEqual(["static", "probed"]);

    // @ts-expect-error the union is closed
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
    // A resume that could not re-realize the posture would relaunch unsandboxed. Binding the
    // full set here proves the resume seam is no narrower than the create seam.
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
      agentConfig: {},
      executionPosture: { networkAccess: "full", writableRoots: [], mode: "trusted" },
      outputSchema: { type: "object" },
    };
    expect(startParams.outputSchema).toEqual({ type: "object" });
  });

  it("forbids `allowedDomains` outside the allowed-domains network mode (compile-time)", () => {
    // The tuple annotation matters: a bare array literal widens to `string[]`, and TS would
    // report an arity mismatch on the property instead of the exclusion.
    // @ts-expect-error allowedDomains is absent unless networkAccess is "allowed-domains"
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
      // @ts-expect-error allowedDomains must be non-empty
      allowedDomains: [],
      writableRoots: [],
      mode: "trusted",
    };
    void posture;
  });

  it("requires credentialPolicyRef on a sandboxed mode (compile-time)", () => {
    // @ts-expect-error credentialPolicyRef is required on both sandboxed modes
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
    // @ts-expect-error the websocket arm requires a bearerTokenRef
    const unauthenticated: DriverTransportConfig = {
      transport: "websocket",
      endpoint: "ws://127.0.0.1:7000",
    };
    void unauthenticated;
  });
});

// Both envelopes parse untrusted driver output, so the tests assert what `.strict()` rejects as
// well as what is accepted. `frames` is `z.array(z.unknown())` and an `unknown` element inside a
// Zod object has surprising optionality, so a round-trip test asserts the frames come back
// unchanged.

describe("DECLARED_LOSS_KINDS — the closed declared-loss vocabulary", () => {
  it("is exactly the canonical member list, in canonical order", () => {
    // A literal list, not derived from `DECLARED_LOSS_KINDS`: an assertion against the const
    // passes whatever it says, which is the drift this test exists to catch. A member joins the
    // set deliberately; a build whose enum lags would report an upper bound that bounds nothing
    // and refuse a marker a peer wrote correctly. Order is pinned too, because callers
    // normalize a loss list by filtering this array, so it fixes the reported ordering.
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
    // The list pin above fixes membership; this ties it to the boundary. A member the schema
    // rejects would be a vocabulary the daemon can name and the trust boundary refuses.
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
      { role: "user", origin: "human_text", segments: [{ kind: "text", text: "hi" }] },
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
    // An empty list claims nothing was dropped, which would tell a caller the memo summary is
    // the verbatim conversation.
    const result = DriverTranscriptReplayResultSchema.safeParse({
      status: "degraded",
      declaredLosses: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a degraded settlement that declares other losses but not the summarization", () => {
    // A merely non-empty rule would let this through: losses are named but not the
    // summarization.
    const result = DriverTranscriptReplayResultSchema.safeParse({
      status: "degraded",
      declaredLosses: ["provider_private_reasoning", "tool_call_history_repaired"],
    });
    expect(result.success).toBe(false);
  });

  it("accepts an applied replay with an empty declared-loss list", () => {
    // Requiredness is scoped to the degraded arm; a replay that carried everything across may
    // still say so with an empty list.
    const parsed: DriverTranscriptReplayResult = DriverTranscriptReplayResultSchema.parse({
      status: "applied",
      declaredLosses: [],
    });
    expect(parsed.declaredLosses).toEqual([]);
  });

  it("rejects an applied replay that declares the summarization", () => {
    // The summarization kind names the memo floor standing in for the conversation, which is the
    // degraded settlement. A result claiming both native replay and a summary is contradictory,
    // and a consumer reading `status` would publish native-replay continuity for a session
    // holding only a bounded summary.
    const result = DriverTranscriptReplayResultSchema.safeParse({
      status: "applied",
      declaredLosses: ["conversation_history_summarized"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects it even beside losses an applied replay may legitimately declare", () => {
    // The kind is refused on its own terms: stripping private reasoning is an ordinary applied
    // loss, and listing it alongside does not launder the contradiction.
    const result = DriverTranscriptReplayResultSchema.safeParse({
      status: "applied",
      declaredLosses: ["provider_private_reasoning", "conversation_history_summarized"],
    });
    expect(result.success).toBe(false);
  });

  it("keeps every OTHER kind admissible on the applied arm", () => {
    // The rule is scoped to one kind; the applied arm keeps its latitude over the rest.
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
    // Every kind except the forbidden one, counted against the enum so a member added to
    // `DECLARED_LOSS_KINDS` but not listed here fails this test.
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
            role: "user",
            segments: [{ kind: "text", position: 7, text: "go" }],
          },
          {
            // Two same-role events folded into one turn: opened at 12, more content at 30, past
            // the bound below.
            position: 12,
            role: "assistant",
            segments: [
              { kind: "text", position: 12, text: "going" },
              { kind: "text", position: 30, text: "and past" },
            ],
          },
          {
            position: 35,
            role: "user",
            segments: [{ kind: "text", position: 35, text: "later still" }],
          },
        ],
      },
      boundary: 12,
    };
    expect([...Object.keys(params)].sort()).toStrictEqual(["boundary", "sessionId", "transcript"]);
    // `boundary` and `CanonicalTranscriptSegment.position` share one vocabulary, so "export up
    // to and including the bound" is a filter over the segments already in hand. It applies per
    // segment: the middle turn's position is inside the bound while half its content is not, so
    // a turn-level filter would carry position 30 across.
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
    // @ts-expect-error boundary is required
    const unbounded: ExportTranscriptParams = {
      sessionId: "session-transcript-2" as SessionId,
      transcript: {
        sessionId: "session-transcript-2" as SessionId,
        runId: "run-transcript-2" as RunId,
        builtAtPosition: 9,
        turns: [
          {
            position: 9,
            role: "user",
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
  // Not a wire guard, and no dispatch path parses through it: the compaction result is
  // composed daemon-side from the wait's own settlement. It exists so the two structural rules
  // are enforced by the type; a later widening that broke either fails here.

  it("REQUIRES `boundaryPosition` on the applied arm", () => {
    // A compaction with no boundary is one the driver cannot prove: the boundary row is the
    // typed evidence, and without it the operation could settle on the request merely having
    // been accepted.
    const withoutPosition = { status: "applied" };
    expect(DriverCompactionResultSchema.safeParse(withoutPosition).success).toBe(false);
    expect(
      DriverCompactionResultSchema.safeParse({ status: "applied", boundaryPosition: 12 }).success,
    ).toBe(true);
  });

  it("accepts a NULL position as the positive statement that the frame named none", () => {
    // Nullable, not optional: this is the one case where "no number" is a fact about the
    // provider's frame rather than a gap in the driver's reporting.
    const parsed = DriverCompactionResultSchema.safeParse({
      status: "applied",
      boundaryPosition: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("admits `capability_undeclared` as NO arm's reason", () => {
    // The static capability gate refuses an undeclared compaction before the driver is called,
    // so an arm for it would be a second, contradictory encoding of one refusal. Both
    // refusal-shaped arms are probed so the reason cannot pass by landing on the other.
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
    // A refusal is a decision (command absent, caller denied) and a failure is an outcome (the
    // evidence never arrived); crossing them would make a denied caller read as a wedged
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
    // A session need not have bound a provider account. `null` states that; `""` or
    // `"unknown"` would make the routing pair look enforced while accountless bindings on
    // different providers compared equal on the half meant to separate them.
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
    // Absence would look like a driver that forgot to report one, and the pair is the routing
    // key.
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
    // A provider with no enabled/disabled distinction reports no flag; a synthesized `true`
    // would claim an offerability it never stated.
    const parsed = ProviderCommandEntrySchema.parse(wellFormedEntry);
    expect(Object.hasOwn(parsed, "enabled")).toBe(false);
    expect(
      ProviderCommandEntrySchema.safeParse({ ...wellFormedEntry, enabled: false }).success,
    ).toBe(true);
  });

  it('refuses an EMPTY description, so a driver must omit rather than forward `""`', () => {
    // The Codex skills surface types its description as required, so a skill whose front matter
    // declares none arrives as `""`. Forwarding it verbatim would fail the driver's own
    // enumeration on an honest reading; omission also says truthfully that none was published.
    expect(
      ProviderCommandEntrySchema.safeParse({ ...wellFormedEntry, description: "" }).success,
    ).toBe(false);
    expect(
      ProviderCommandEntrySchema.safeParse({ ...wellFormedEntry, description: "   " }).success,
    ).toBe(false);
    expect(ProviderCommandEntrySchema.safeParse(wellFormedEntry).success).toBe(true);
  });

  it("bounds both provider-authored strings and refuses an unknown key", () => {
    // A local skill file's front matter is operator-writable and the list travels to a client,
    // so the description is bounded like every other untrusted string here.
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
  // The group's `runId` and `binding` are provenance a client reads, not an addressing handle.
  // Both are nullable because a binding outlives any one of its runs and need not have bound an
  // account; the shape must say "none" without omitting the key. Each driver resolves which arm
  // applies; this asserts the contract admits all three answers.

  const bindingPair = { driverName: "codex", providerAccountId: "account-1" } as const;
  const entry = { name: "compact", kind: "command", binding: bindingPair } as const;

  it("admits the sole-live-run arm, the zero-run arm, and the two-live-runs arm", () => {
    // Exactly one live run: that run answers.
    const soleLiveRun: ProviderCommandBindingGroup = {
      runId: RUN_ID,
      binding: bindingPair,
      entries: [entry],
      complete: true,
    };
    // Zero live runs (the ordinary pre-first-turn palette read) succeeds with null; a binding
    // that has not run anything yet is not an error.
    const zeroLiveRuns: ProviderCommandBindingGroup = {
      runId: null,
      binding: bindingPair,
      entries: [entry],
      complete: true,
    };
    // Two live turns on one binding: no single run is attributable.
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
    // An omitted key would look like a producer that forgot to report one.
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

// Client-facing wire schemas: client input crossing into the daemon over JSON-RPC and the
// daemon's replies going back. They refuse shapes the daemon would have to guess at, and each
// reply carries exactly the members meant for a client.
const A_RUN_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
/** An artifact id, the element of the steer payload's attachments. */
const AN_ARTIFACT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";
const ANOTHER_UUID = "0b1c2d3e-4f50-4162-8374-859607a8b9c0";

/** Every declared flag answered `false` — the totality `DriverCapabilities` requires. */
function allFlagsFalse(): Record<string, boolean> {
  return Object.fromEntries(DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, false]));
}

describe("RunIdSchema — the brand's validator, co-located with the brand", () => {
  it("accepts a UUID and brands it", () => {
    expect(RunIdSchema.parse(A_RUN_ID)).toBe(A_RUN_ID);
  });

  it("REFUSES a non-UUID run id", () => {
    // A run id crossing the client boundary is untrusted; a path or SQL fragment reaching a
    // store lookup keyed on it is what shape rejection stops.
    expect(RunIdSchema.safeParse("../../etc/passwd").success).toBe(false);
    expect(RunIdSchema.safeParse("run-1").success).toBe(false);
    expect(RunIdSchema.safeParse("").success).toBe(false);
  });
});

describe("ArtifactIdSchema — the attachment element brand, homed by the same rule", () => {
  it("accepts a UUID and brands it", () => {
    expect(ArtifactIdSchema.parse(AN_ARTIFACT_ID)).toBe(AN_ARTIFACT_ID);
  });

  it("REFUSES a non-UUID artifact id", () => {
    // Same reason as `RunIdSchema`: the value reaches an artifact manifest lookup, so a path or
    // store-key fragment must not arrive as one.
    expect(ArtifactIdSchema.safeParse("../../etc/passwd").success).toBe(false);
    expect(ArtifactIdSchema.safeParse("artifact-1").success).toBe(false);
    expect(ArtifactIdSchema.safeParse("").success).toBe(false);
  });

  it("is re-exported from the package barrel under its own name", () => {
    // Every consumer imports this symbol rather than declaring a sibling, so there is one
    // source of truth for what an artifact id is.
    expect(contracts.ArtifactIdSchema).toBe(ArtifactIdSchema);
  });

  it.each([
    ["the Max UUID, lowercase", "ffffffff-ffff-ffff-ffff-ffffffffffff"],
    ["the Max UUID, UPPERCASE", "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"],
    ["the Max UUID, MiXeD case", "FfFfFfFf-ffFF-FFff-fFfF-fFFFffffFFFF"],
    ["an uppercase v7", "0190F8A0-7E2D-7C4A-9B1C-1B7C5B3E8F00"],
    ["the Nil UUID", "00000000-0000-0000-0000-000000000000"],
  ])(
    "accepts %s — the ratified accept set is any RFC 9562 form, case-insensitively",
    (_label, value) => {
      // RFC 9562 section 4 admits upper- or lowercase hex, so the accept set is
      // case-insensitive; an id that parsed in one spelling and not the other would be wrong for
      // the Max UUID.
      expect(ArtifactIdSchema.parse(value)).toBe(value);
    },
  );

  it.each([
    ["a version-9 nibble", "550e8400-e29b-91d4-a716-446655440000"],
    ["a variant 0xxx form", "550e8400-e29b-41d4-0716-446655440000"],
    ["a variant 11xx form", "550e8400-e29b-41d4-c716-446655440000"],
    ["a 35-character string", "550e8400-e29b-41d4-a716-44665544000"],
  ])("REFUSES %s — case is the only widening", (_label, value) => {
    expect(ArtifactIdSchema.safeParse(value).success).toBe(false);
  });
});

describe("DriverReadParams / DriverAckResult — the two empty envelopes", () => {
  it("accepts the empty object on both", () => {
    expect(DriverReadParamsSchema.parse({})).toEqual({});
    expect(DriverAckResultSchema.parse({})).toEqual({});
  });

  it("REFUSES a driver selector on the read request — every reply answers for every driver", () => {
    // `.strict()` makes a `{ driverName }` request a refusal, not a silently ignored key the
    // caller would believe had filtered the reply.
    expect(DriverReadParamsSchema.safeParse({ driverName: "claude" }).success).toBe(false);
    expect(DriverAckResultSchema.safeParse({ status: "ok" }).success).toBe(false);
  });
});

describe("ListModelsRequest — the catalog is read for one session", () => {
  const sessionId = "550e8400-e29b-41d4-a716-446655440000";

  it("accepts the session whose model control asks", () => {
    expect(ListModelsRequestSchema.parse({ sessionId })).toEqual({ sessionId });
  });

  it("REFUSES a read that names no session, or names a driver", () => {
    expect(ListModelsRequestSchema.safeParse({}).success).toBe(false);
    expect(ListModelsRequestSchema.safeParse({ sessionId, driverName: "claude" }).success).toBe(
      false,
    );
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
    // `Record<DriverCapabilityFlag, boolean>` makes omission a compile error inside the daemon;
    // over the wire the schema must carry it, or a client would read "undeclared" for a
    // capability the driver declared true.
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

  it("bounds contractVersion at the same value the capability snapshot uses", () => {
    // The same 64 as `CAPABILITY_CONTRACT_VERSION_MAX_LEN`: a version string that survives this
    // reply must survive the `CapabilityDetails` snapshot too.
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
    builtInTools: ["Read", "Edit", "Bash"],
  };

  it("carries the flags and the output-speed vocabulary", () => {
    const parsed = ListCapabilitiesResultSchema.parse({ drivers: [report] });
    expect(parsed.drivers[0]?.outputSpeedLevels).toEqual(["off", "on"]);
    expect(parsed.drivers[0]?.capabilities.flags.output_speed).toBe(true);
  });

  it("REFUSES detectionSource, cliVersion, and tools — the three members that stop at the driver", () => {
    // This reply is scoped to the flags. `.strict()` makes that testable: a daemon that
    // composed the whole `GetCapabilitiesResult` would otherwise ship provenance to every
    // client unnoticed.
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
    // Absent and empty differ: an empty vocabulary asserts an axis with nothing settable on it,
    // and `.default([])` would erase that.
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

  it("carries each driver's built-in tools, and refuses a report without them", () => {
    // Every driver has tools of its own, so a report without the list is a composition fault,
    // not a driver with none.
    expect(DriverCapabilityReportSchema.parse(report).builtInTools).toEqual([
      "Read",
      "Edit",
      "Bash",
    ]);
    const { builtInTools: _tools, ...withoutTools } = report;
    expect(DriverCapabilityReportSchema.safeParse(withoutTools).success).toBe(false);
    expect(
      DriverCapabilityReportSchema.safeParse({
        ...report,
        builtInTools: ["x".repeat(DRIVER_WIRE_TOKEN_MAX_LEN + 1)],
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
  const claudeModel = {
    id: "claude-haiku-4-5-20251001",
    name: "Haiku 4.5",
    capabilities: [],
    fast: false,
  };

  it("groups entries per driver rather than flattening them", () => {
    const parsed = ListModelsResultSchema.parse({
      drivers: [
        { driverName: "claude", models: [claudeModel] },
        {
          driverName: "codex",
          models: [{ id: "gpt-5.6-luna", name: "Luna", capabilities: [], fast: true }],
        },
      ],
    });
    // The grouping is the provenance: model ids collide across providers and carry no vendor
    // marker, so a flat array would hand a caller one driver's catalog with no way to tell
    // which.
    expect(parsed.drivers.map((entry) => entry.driverName)).toEqual(["claude", "codex"]);
  });

  it("keeps effortLevels ABSENT for a model that exposes no effort axis", () => {
    const parsed = ProviderModelSchema.parse(claudeModel);
    expect(Object.hasOwn(parsed, "effortLevels")).toBe(false);
    expect(
      ProviderModelSchema.safeParse({ ...claudeModel, effortLevels: ["low", "high"] }).success,
    ).toBe(true);
  });

  it("REFUSES a model with no fast reading, since no fast mode and no reading must differ", () => {
    const { fast: _fast, ...withoutFast } = claudeModel;
    expect(ProviderModelSchema.safeParse(withoutFast).success).toBe(false);
  });

  it("keeps contextWindow ABSENT until a reading arrives, and takes a whole token count", () => {
    const parsed = ProviderModelSchema.parse(claudeModel);
    expect(Object.hasOwn(parsed, "contextWindow")).toBe(false);
    expect(
      ProviderModelSchema.parse({ ...claudeModel, contextWindow: 200_000 }).contextWindow,
    ).toBe(200_000);
    for (const contextWindow of [0, -1, 200_000.5]) {
      expect(ProviderModelSchema.safeParse({ ...claudeModel, contextWindow }).success).toBe(false);
    }
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
    // A run id is globally unique, so a `sessionId` would be a second addressing key with no
    // honest answer when the two disagree. The parity verbs contrast: their targets are
    // identified only within a session.
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
    // `rollback` is not an `InterventionType`, so it must fail parse rather than reach a handler
    // that has to invent a refusal. The payload is `{}`, valid for the interrupt and cancel arms,
    // so only the discriminator can refuse it; a rollback-shaped payload would fail any arm's
    // `.strict()` and prove nothing about the arm set. The issue path is pinned to `type` so an
    // arm rename cannot make this pass for the wrong reason.
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
    // A caller-chosen free string would land in a durable receipt and make replay keying depend
    // on client discipline.
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
    // Optimistic-concurrency state: either value would compare unequal to every stored version,
    // making the check an unconditional refusal that reads as a conflict.
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

  it("bounds the steer's turn handle", () => {
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

describe("DriverSubscribeEventsParamsSchema — run-scoped, and answered by the shared ack", () => {
  it("accepts the run id and refuses anything beside it", () => {
    expect(DriverSubscribeEventsParamsSchema.parse({ runId: A_RUN_ID }).runId).toBe(A_RUN_ID);
    expect(
      DriverSubscribeEventsParamsSchema.safeParse({ runId: A_RUN_ID, afterCursor: "c1" }).success,
    ).toBe(false);
    expect(DriverSubscribeEventsParamsSchema.safeParse({}).success).toBe(false);
  });
});

// Provider usage-limit signal, a sibling axis.

describe("ProviderUsageLimitSignal — a sibling axis, never a RecoveryCondition member", () => {
  it("keeps the two cause vocabularies mutually unassignable in BOTH directions", () => {
    // A `RecoveryCondition` must never carry the usage-limit cause; that is a claim about types,
    // so it is asserted where it can fail. These lines break the build if either union grows
    // into the other, which would route a self-clearing pause into the operator-remediation
    // queue. Both directions are checked: a one-way check would pass if `RecoveryCondition`
    // were widened to contain the cause.
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
    // No capability flag is added (as with `probeAuth`): a flag would let a driver declare the
    // obligation away, leaving a run refused for spend in the generic failure path with nothing
    // saying why.
    expect(DRIVER_CAPABILITY_FLAGS).toHaveLength(16);
    for (const flag of DRIVER_CAPABILITY_FLAGS) {
      expect(flag).not.toMatch(/usage|limit|rate/);
    }
  });

  it("makes a bare instant and a bare provenance stamp both inexpressible", () => {
    // The boundary is one object, not two optionals, so a consumer never holds an instant it
    // cannot weigh.
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

// Optional provider-account identity on the spawn carriers.

describe("provider-account identity on CreateSessionParams / ResumeSessionParams", () => {
  it("leaves a no-identifier create structurally identical to the pre-amendment shape", () => {
    // Optional means the unchanged path stays unchanged: a create that names no account carries
    // no member for one, so nothing can read an absent account as present-but-empty.
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
    // The same identity on both: a resume that re-realized whichever account is default now
    // would move a live run's spend onto an account it was never admitted against.
    expect(resume.providerAccountId).toBe(create.providerAccountId);
  });

  it("keeps the identifier OPAQUE — a structured value is not admitted", () => {
    // The driver may not parse the id, so it is a string, not a record naming a home or a
    // credential.
    const structured: CreateSessionParams = {
      sessionId: SESSION_ID,
      config: {},
      // @ts-expect-error — an account identity is opaque, never a structure.
      providerAccountId: { accountId: "acct-01J8ZK", credentialHome: "/home/.codex" },
    };
    void structured;
  });
});

// Console-parity wire requests and the group-list reply schemas.

describe("CompactContextRequestSchema / ListProviderCommandsRequestSchema — session-addressed, and no binding member exists", () => {
  const AGENT_UUID = "770e8400-e29b-41d4-a716-446655440002";
  const compactRequest = { sessionId: SESSION_UUID, runId: RUN_UUID };
  const listRequest = { sessionId: SESSION_UUID, agentId: AGENT_UUID };

  it("accepts the canonical session-scoped pair on both requests", () => {
    expect(CompactContextRequestSchema.parse(compactRequest)).toEqual(compactRequest);
    expect(ListProviderCommandsRequestSchema.parse(listRequest)).toEqual(listRequest);
  });

  it("REFUSES a bindingId beside either pair — the wire admits NO binding member", () => {
    // The client surface publishes no `bindingId`, and `.strict()` makes that a refusal: a
    // caller naming a binding believes it holds an addressing key the daemon never handed out,
    // and an ignored key would leave it believing the dispatch was binding-routed.
    expect(
      CompactContextRequestSchema.safeParse({ ...compactRequest, bindingId: "binding-1" }).success,
    ).toBe(false);
    expect(
      ListProviderCommandsRequestSchema.safeParse({ ...listRequest, bindingId: "binding-1" })
        .success,
    ).toBe(false);
  });

  it("REFUSES a non-UUID value in every addressing slot", () => {
    // All three are untrusted caller-supplied strings; UUID-shape rejection stops a path or SQL
    // fragment from reaching a store lookup.
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
    // An omitted key would look like a producer that forgot to report one.
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
    // A smaller reply-side cap would reject a legitimate 300-command enumeration; sharing the
    // constant keeps the two boundaries from disagreeing about one list.
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
    // The handler refuses an agent with no live binding as `driver.unavailable` before any
    // dispatch, so zero groups on a resolved reply is a composition bug, and `.min(1)` makes it
    // parse as one.
    expect(ProviderCommandListResultSchema.safeParse({ bindings: [] }).success).toBe(false);
    expect(ProviderCommandListResultSchema.safeParse({ bindings: [group] }).success).toBe(true);
    expect(
      ProviderCommandListResultSchema.safeParse({ bindings: [group, { ...group, runId: null }] })
        .success,
    ).toBe(true);
  });
});
