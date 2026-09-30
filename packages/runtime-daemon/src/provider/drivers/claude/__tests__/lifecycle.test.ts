// `lifecycle.ts`: the session and run operations, the spawn settings every spawn must carry, the
// session slot held across each transition, thread routing and metering, the text-neutralization
// tripwire on the provider-bound path, compaction, provider commands and transcript replay.

import {
  DRIVER_OUTPUT_SPEED_REASON_MAX_LEN,
  DRIVER_PROVIDER_COMMAND_ENTRIES_MAX,
  DRIVER_PROVIDER_COMMAND_NAME_MAX_LEN,
  type ExecutionPosture,
} from "@ai-sidekicks/contracts";
import { describe, expect, it, vi } from "vitest";

import type { DriverDiagnosticsEmitter } from "../../../driver-diagnostics.js";
import { TextNeutralizationRefusedError } from "../../../outbound-frame.js";
import type { RunId, SessionId } from "@ai-sidekicks/contracts";

import type { SubagentLifecycleEmission, ThreadFrameRoute } from "../../../thread-frame-router.js";
import type { MeteredUsageDelta } from "../../../usage-delta-accountant.js";
import { MemoDeliveryCoordinator } from "../../../transcript/memo-delivery.js";
import {
  memoSettlementAsReplayResult,
  TranscriptReconstitutionRouter,
  type NativeReplayDisposition,
} from "../../../transcript/transcript-reconstitution.js";
import { MAX_DEFINITELY_UNSENT_DISPATCH_ATTEMPTS } from "../../../transcript/failure-mapping.js";
import {
  PostReplayAssertionFailedError,
  ReplayTargetAbandonedError,
} from "../../../transcript/replay-assertion.js";
import type { ClaudeTranscriptSeedingSurface } from "../capabilities.js";
import {
  ClaudeAuthenticationRequiredError,
  ClaudeSessionUnavailableError,
} from "../session-errors.js";
import {
  ClaudeControlRequestRefusedError,
  CLAUDE_COMPACTION_WAIT_MS,
  type ClaudeHandshakeDeclaration,
  type ClaudeRunDispatch,
} from "../session-transport.js";
import { ClaudeSessionLifecycle } from "../lifecycle.js";
import { ClaudeTranscriptReplayUnsupportedError } from "../transcript-replay.js";
import {
  ClaudeSubagentConcurrencyGate,
  CLAUDE_SUBAGENT_MAX_DEPTH_CEILING,
} from "../subagent-policy.js";
import {
  CLAUDE_CALLBACK_MCP_SERVER_NAME,
  CLAUDE_CALLBACK_TOOL_TRANSPORT_UNAVAILABLE_DETAIL,
  composeClaudeCallbackMcpServer,
  composeClaudeProviderToolName,
  composeClaudeSandboxSettings,
} from "../spawn-settings.js";
import { type ClaudeSessionLifecycleDependencies } from "../session-state.js";
import type { CompactionWaitScheduler } from "../../../compaction-wait.js";
import {
  buildCreateSessionParams,
  FakeClaudeSessionChannel,
  TEST_SECOND_RUN_ID,
  buildStartRunParams,
  FakeClaudeRunDispatchResolver,
  FakeClaudeSessionTransport,
  makeSilentDriverDiagnostics,
  TEST_BINDING_ID,
  TEST_PINNED_PROVIDER_SESSION_ID,
  TEST_RUN_ID,
  TEST_SESSION_ID,
} from "./claude-test-doubles.js";
import {
  CLAUDE_ORDINARY_TURN_RESULT_FRAME,
  CLAUDE_ZERO_TURN_RESULT_FRAME,
} from "../__fixtures__/turn-evidence-transcripts.js";
import {
  DriverResumeResultSchema,
  DriverTranscriptReplayResultSchema,
  type CallbackToolResult,
  type SubagentPolicy,
} from "../../../provider-driver.js";

interface RecordedTextNeutralizationFailure {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly providerFailureDetail: string;
}

interface LifecycleHarness {
  readonly lifecycle: ClaudeSessionLifecycle;
  readonly transport: FakeClaudeSessionTransport;
  readonly runDispatchResolver: FakeClaudeRunDispatchResolver;
  readonly diagnostics: DriverDiagnosticsEmitter;
  readonly textNeutralizationFailures: RecordedTextNeutralizationFailure[];
}

function buildHarness(
  overrides: Partial<ClaudeSessionLifecycleDependencies> = {},
): LifecycleHarness {
  const transport = new FakeClaudeSessionTransport();
  const runDispatchResolver = new FakeClaudeRunDispatchResolver();
  const diagnostics = makeSilentDriverDiagnostics();
  const textNeutralizationFailures: RecordedTextNeutralizationFailure[] = [];
  const dependencies: ClaudeSessionLifecycleDependencies = {
    transport,
    runDispatchResolver,
    diagnostics,
    mintProviderSessionId: () => TEST_PINNED_PROVIDER_SESSION_ID,
    mintBindingId: () => TEST_BINDING_ID,
    // Required so no construction site can leave a swallowed turn without a user-visible terminal.
    onTextNeutralizationFailure: (sessionId, runId, failure) => {
      textNeutralizationFailures.push({
        sessionId,
        runId,
        providerFailureDetail: failure.providerFailureDetail,
      });
    },
    ...overrides,
  };
  return {
    lifecycle: new ClaudeSessionLifecycle(dependencies),
    transport,
    runDispatchResolver,
    diagnostics: dependencies.diagnostics,
    textNeutralizationFailures,
  };
}

const SANDBOXED_POSTURE: ExecutionPosture = {
  mode: "workspace-sandboxed",
  credentialPolicyRef: "policy://default",
  networkAccess: "none",
  writableRoots: ["/workspace"],
};

const READONLY_POSTURE: ExecutionPosture = {
  mode: "readonly-sandboxed",
  credentialPolicyRef: "policy://default",
  networkAccess: "none",
  writableRoots: ["/workspace"],
};

const TRUSTED_POSTURE: ExecutionPosture = {
  mode: "trusted",
  networkAccess: "full",
  writableRoots: ["/workspace"],
};

const RESUME_FAILURE_MECHANISMS: ReadonlyArray<{
  readonly label: string;
  readonly arrange: (harness: LifecycleHarness) => Promise<void> | void;
}> = [
  {
    label: "transport rejection",
    arrange: (harness) => {
      harness.transport.resumeFailure = new Error("claude exited before init");
    },
  },
  {
    label: "identity divergence",
    arrange: (harness) => {
      harness.transport.announcedProviderSessionId = "provider-session-fresh";
    },
  },
  {
    label: "contract-invalid resumed arm",
    arrange: (harness) => {
      harness.transport.resumedSessionPosition = -1;
    },
  },
  {
    label: "resume beside a live session",
    arrange: async (harness) => {
      await harness.lifecycle.createSession(buildCreateSessionParams());
    },
  },
];

describe("ClaudeSessionLifecycle.createSession", () => {
  it("pins the provider session id it minted and returns it as the resume handle", async () => {
    const harness = buildHarness();

    const handle = await harness.lifecycle.createSession(buildCreateSessionParams());

    expect(harness.transport.spawnRequests).toHaveLength(1);
    expect(harness.transport.spawnRequests[0]?.providerSessionId).toBe(
      TEST_PINNED_PROVIDER_SESSION_ID,
    );
    expect(handle).toStrictEqual({
      providerSessionId: TEST_PINNED_PROVIDER_SESSION_ID,
      resumeHandle: TEST_PINNED_PROVIDER_SESSION_ID,
    });
  });

  it("carries the cost cap, posture, callback tools, subagent policy and schema to the spawn", async () => {
    const harness = buildHarness();
    const onCallbackToolCall = async (): Promise<CallbackToolResult> => ({
      status: "completed",
      output: "ok",
    });

    await harness.lifecycle.createSession({
      sessionId: TEST_SESSION_ID,
      config: { model: "claude-sonnet-4-5" },
      admittedCostCapUsdMicros: 5_000_000,
      executionPosture: SANDBOXED_POSTURE,
      callbackTools: [{ name: "ask", description: "ask", inputSchema: {} }],
      subagentPolicy: { enabled: false },
      outputSchema: { type: "object" },
      onCallbackToolCall,
    });

    const request = harness.transport.spawnRequests[0];
    expect(request?.admittedCostCapUsdMicros).toBe(5_000_000);
    expect(request?.executionPosture).toStrictEqual(SANDBOXED_POSTURE);
    expect(request?.callbackTools).toHaveLength(1);
    expect(request?.subagentPolicy).toStrictEqual({ enabled: false });
    expect(request?.outputSchema).toStrictEqual({ type: "object" });
    expect(request?.onCallbackToolCall).toBe(onCallbackToolCall);
    expect(request?.config).toStrictEqual({ model: "claude-sonnet-4-5" });
  });

  it("refuses a second create for a session that already holds a live channel", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());

    await expect(harness.lifecycle.createSession(buildCreateSessionParams())).rejects.toMatchObject(
      {
        code: "driver.unavailable",
        fields: { reason: "session_already_live" },
      },
    );
    expect(harness.transport.spawnRequests).toHaveLength(1);
  });

  it("disposes and refuses a spawned process that announces a divergent session id", async () => {
    const harness = buildHarness();
    harness.transport.announcedProviderSessionId = "provider-session-other";

    await expect(harness.lifecycle.createSession(buildCreateSessionParams())).rejects.toMatchObject(
      {
        code: "driver.unavailable",
        fields: { reason: "session_id_pin_diverged" },
      },
    );
    expect(harness.transport.spawnedChannels[0]?.disposals).toStrictEqual([
      "spawn_identity_diverged",
    ]);
  });
});

describe("ClaudeSessionLifecycle.resumeSession", () => {
  it("returns the resumed arm with a minted binding id and a contract-valid position", async () => {
    const harness = buildHarness();
    harness.transport.resumedSessionPosition = 42;

    const result = await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
    });

    expect(result).toStrictEqual({
      status: "resumed",
      bindingId: TEST_BINDING_ID,
      sessionPosition: 42,
    });
    expect(DriverResumeResultSchema.safeParse(result).success).toBe(true);
  });

  it("re-realizes the cost cap, posture, schema and subagent policy on the resume spawn", async () => {
    const harness = buildHarness();

    await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
      admittedCostCapUsdMicros: 7_500_000,
      executionPosture: SANDBOXED_POSTURE,
      outputSchema: { type: "object" },
      subagentPolicy: { enabled: false },
    });

    const request = harness.transport.resumeRequests[0];
    expect(request?.resumeHandle).toBe("provider-session-earlier");
    expect(request?.admittedCostCapUsdMicros).toBe(7_500_000);
    expect(request?.executionPosture).toStrictEqual(SANDBOXED_POSTURE);
    expect(request?.outputSchema).toStrictEqual({ type: "object" });
    expect(request?.subagentPolicy).toStrictEqual({ enabled: false });
  });

  it("a rejected resume yields recovery-needed and leaves no replacement session", async () => {
    const harness = buildHarness();
    harness.transport.resumeFailure = new Error("claude exited before init");

    const result = await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("unreachable: the resume must fail");
    }
    expect(result.recoveryCondition).toBe("recovery-needed");
    expect(result.recoverySpanClassification).toBe("unclassifiable");
    expect(result.providerFailureDetail).toContain("claude exited before init");
    expect(DriverResumeResultSchema.safeParse(result).success).toBe(true);
    // No silent replacement: no channel was adopted, no run route exists, and the
    // canonical session is still free for an explicit re-create.
    expect(harness.transport.spawnedChannels).toHaveLength(0);
    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeUndefined();
    await expect(
      harness.lifecycle.createSession(buildCreateSessionParams()),
    ).resolves.toBeDefined();
  });

  it("a provider answering with a FRESH session is refused and disposed", async () => {
    const harness = buildHarness();
    // Claude's documented behavior on a working-directory mismatch: the resume silently becomes
    // a new session announcing its own id.
    harness.transport.announcedProviderSessionId = "provider-session-fresh";

    const result = await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("unreachable: the resume must fail");
    }
    expect(result.recoveryCondition).toBe("recovery-needed");
    expect(result.providerFailureDetail).toContain("provider-session-fresh");
    expect(harness.transport.spawnedChannels[0]?.disposals).toStrictEqual([
      "resume_identity_diverged",
    ]);
    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeUndefined();
    // The canonical session was left free: once the divergence is gone, an
    // explicit re-create is admitted — nothing was silently holding the slot.
    harness.transport.announcedProviderSessionId = undefined;
    await expect(
      harness.lifecycle.createSession(buildCreateSessionParams()),
    ).resolves.toBeDefined();
  });

  it("a resumed arm failing the driver contract becomes a failure, not a success", async () => {
    const harness = buildHarness();
    harness.transport.resumedSessionPosition = -1;

    const result = await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
    });

    expect(result.status).toBe("failed");
    expect(harness.transport.spawnedChannels[0]?.disposals).toStrictEqual([
      "resume_result_invalid",
    ]);
    expect(DriverResumeResultSchema.safeParse(result).success).toBe(true);
  });

  it("a resume beside a live session is refused without touching the live channel", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());

    const result = await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: TEST_PINNED_PROVIDER_SESSION_ID,
    });

    expect(result.status).toBe("failed");
    expect(harness.transport.resumeRequests).toHaveLength(0);
    expect(harness.transport.spawnedChannels[0]?.disposals).toStrictEqual([]);
  });

  it("classifies a typed credential failure as reauth-required, not recovery-needed", async () => {
    const harness = buildHarness();
    harness.transport.resumeFailure = new ClaudeAuthenticationRequiredError(
      "the stored Claude credential has expired",
    );

    const result = await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("unreachable: the resume must fail");
    }
    expect(result.recoveryCondition).toBe("reauth-required");
  });

  it("produces a contract-valid failure detail from a whitespace-only rejection message", async () => {
    const harness = buildHarness();
    harness.transport.resumeFailure = new Error("\u0000   ");

    const result = await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
    });

    expect(DriverResumeResultSchema.safeParse(result).success).toBe(true);
    if (result.status !== "failed") {
      throw new Error("unreachable: the resume must fail");
    }
    expect(result.providerFailureDetail).not.toContain("\u0000");
    expect(result.providerFailureDetail).toMatch(/\S/);
  });

  it.each(RESUME_FAILURE_MECHANISMS)(
    "issues no createSession call on a failed resume ($label)",
    async ({ arrange }) => {
      const harness = buildHarness();
      await arrange(harness);
      // Spied after arrangement so the live-session mechanism's own setup call is not counted.
      const createSessionSpy = vi.spyOn(harness.lifecycle, "createSession");
      const spawnCountBeforeResume = harness.transport.spawnRequests.length;

      const result = await harness.lifecycle.resumeSession({
        sessionId: TEST_SESSION_ID,
        resumeHandle: "provider-session-earlier",
      });

      expect(result.status).toBe("failed");
      expect(createSessionSpy).not.toHaveBeenCalled();
      // The spy sees only the driver's own entry point, so assert the spawn count directly too.
      expect(harness.transport.spawnRequests).toHaveLength(spawnCountBeforeResume);
    },
  );
});

describe("ClaudeSessionLifecycle.startRun", () => {
  it("routes the run to its resolved session and writes exactly one opening frame", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "review the diff",
    });

    await harness.lifecycle.startRun(buildStartRunParams());

    const channel = harness.transport.spawnedChannels[0];
    expect(channel?.sentWireTexts).toStrictEqual(["review the diff"]);
    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBe(channel);
  });

  it("refuses a run the daemon resolved no dispatch for", async () => {
    const harness = buildHarness();

    await expect(harness.lifecycle.startRun(buildStartRunParams())).rejects.toMatchObject({
      code: "driver.unavailable",
      fields: { reason: "run_dispatch_unresolved" },
    });
  });

  it("refuses a run whose resolved session holds no live channel", async () => {
    const harness = buildHarness();
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "review the diff",
    });

    await expect(harness.lifecycle.startRun(buildStartRunParams())).rejects.toMatchObject({
      fields: { reason: "no_live_session" },
    });
  });

  it("refuses a second dispatch while the run's opening frame is still pending", async () => {
    // The tripwire attributes a settle by one frame per run key: position 0 gets the real
    // classification and later frames are unrecognized, so a duplicate dispatch would
    // quarantine the session.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "review the diff",
    });
    await harness.lifecycle.startRun(buildStartRunParams());

    await expect(harness.lifecycle.startRun(buildStartRunParams())).rejects.toMatchObject({
      code: "driver.unavailable",
      fields: { reason: "run_already_dispatched" },
    });

    // Refused before compose and register: nothing reached the wire, the accepted frame's route
    // (how its terminal is found) is untouched, and the first dispatch's turn still settles
    // benignly.
    expect(harness.transport.spawnedChannels[0]?.sentWireTexts).toStrictEqual(["review the diff"]);
    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeDefined();
    harness.transport.spawnedChannels[0]?.emitStreamFrame("result/success");
    expect(harness.textNeutralizationFailures).toStrictEqual([]);
  });

  it("admits a re-dispatch once the first opening frame's turn has settled", async () => {
    // The guard keys on the pending frame only: a run whose turn settled may be dispatched again.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "review the diff",
    });
    await harness.lifecycle.startRun(buildStartRunParams());
    harness.transport.spawnedChannels[0]?.emitStreamFrame("result/success");

    await harness.lifecycle.startRun(buildStartRunParams());

    expect(harness.transport.spawnedChannels[0]?.sentWireTexts).toStrictEqual([
      "review the diff",
      "review the diff",
    ]);
  });

  it("never starts a run whose posture disagrees with the spawned sandbox", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession({
      sessionId: TEST_SESSION_ID,
      config: {},
      executionPosture: SANDBOXED_POSTURE,
    });
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "review the diff",
    });

    await expect(
      harness.lifecycle.startRun({ ...buildStartRunParams(), executionPosture: TRUSTED_POSTURE }),
    ).rejects.toMatchObject({ fields: { reason: "execution_posture_mismatch" } });
    expect(harness.transport.spawnedChannels[0]?.sentWireTexts).toStrictEqual([]);
  });

  it("never starts a schema-constrained run inside a session spawned without a schema", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "review the diff",
    });

    await expect(
      harness.lifecycle.startRun({ ...buildStartRunParams(), outputSchema: { type: "object" } }),
    ).rejects.toMatchObject({ fields: { reason: "output_schema_unbound" } });
  });
});

// Positive controls for `assertClaudeSpawnBoundRealization` in `spawn-legs.ts`: without them a
// guard that refuses too much would pass every mismatch test above by accident.
describe("ClaudeSessionLifecycle.startRun spawn-bound realization (agreeing runs start)", () => {
  function arrangeDispatch(harness: LifecycleHarness): void {
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "review the diff",
    });
  }

  it("starts a run whose posture agrees with the spawned sandbox by value, not by reference", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession({
      sessionId: TEST_SESSION_ID,
      config: {},
      executionPosture: SANDBOXED_POSTURE,
    });
    arrangeDispatch(harness);

    // A distinct object with the same posture: the daemon re-materializes it per call, so a
    // reference-equality guard would refuse every real run.
    await harness.lifecycle.startRun({
      ...buildStartRunParams(),
      executionPosture: { ...SANDBOXED_POSTURE },
    });

    expect(harness.transport.spawnedChannels[0]?.sentWireTexts).toStrictEqual(["review the diff"]);
  });
});

// `ExecutionPosture` is an intersection of two discriminated unions, so a comparison over `mode`
// and `networkAccess` alone would admit a run into a process whose sandbox differs on another
// axis. One test per axis keeps a re-narrowing from passing on the popular ones.
describe("ClaudeSessionLifecycle.startRun execution-posture axes", () => {
  const ALLOWED_DOMAINS_POSTURE: ExecutionPosture = {
    mode: "workspace-sandboxed",
    credentialPolicyRef: "policy://default",
    networkAccess: "allowed-domains",
    allowedDomains: ["api.example.com", "docs.example.com"],
    writableRoots: ["/workspace", "/tmp/scratch"],
    profileName: "default",
  };

  async function arrangeSession(
    harness: LifecycleHarness,
    executionPosture: ExecutionPosture,
  ): Promise<void> {
    await harness.lifecycle.createSession({
      sessionId: TEST_SESSION_ID,
      config: {},
      executionPosture,
    });
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "review the diff",
    });
  }

  const DIVERGENT_POSTURES: ReadonlyArray<{
    readonly axis: string;
    readonly runPosture: ExecutionPosture;
  }> = [
    {
      axis: "allowedDomains (an added domain widens the network reach)",
      runPosture: {
        ...ALLOWED_DOMAINS_POSTURE,
        allowedDomains: ["api.example.com", "docs.example.com", "exfil.example.net"],
      },
    },
    {
      axis: "writableRoots (an added root widens what the process may write)",
      runPosture: {
        ...ALLOWED_DOMAINS_POSTURE,
        writableRoots: ["/workspace", "/tmp/scratch", "/etc"],
      },
    },
    {
      axis: "credentialPolicyRef",
      runPosture: { ...ALLOWED_DOMAINS_POSTURE, credentialPolicyRef: "policy://elevated" },
    },
    {
      axis: "profileName",
      runPosture: { ...ALLOWED_DOMAINS_POSTURE, profileName: "permissive" },
    },
    {
      axis: "writableRoots (a duplicated root is a real difference, not noise)",
      runPosture: {
        ...ALLOWED_DOMAINS_POSTURE,
        writableRoots: ["/workspace", "/workspace"],
      },
    },
  ];

  it.each(DIVERGENT_POSTURES)("never starts a run diverging on $axis", async ({ runPosture }) => {
    const harness = buildHarness();
    await arrangeSession(harness, ALLOWED_DOMAINS_POSTURE);

    await expect(
      harness.lifecycle.startRun({ ...buildStartRunParams(), executionPosture: runPosture }),
    ).rejects.toMatchObject({
      code: "driver.unavailable",
      fields: { reason: "execution_posture_mismatch" },
    });
    expect(harness.transport.spawnedChannels[0]?.sentWireTexts).toStrictEqual([]);
  });

  it("admits a posture whose set axes agree but are ordered differently", async () => {
    const harness = buildHarness();
    await arrangeSession(harness, ALLOWED_DOMAINS_POSTURE);

    // The same roots and domains in another order are the same posture; refusing would force
    // relaunches over serialization order.
    await harness.lifecycle.startRun({
      ...buildStartRunParams(),
      executionPosture: {
        ...ALLOWED_DOMAINS_POSTURE,
        allowedDomains: ["docs.example.com", "api.example.com"],
        writableRoots: ["/tmp/scratch", "/workspace"],
      },
    });

    expect(harness.transport.spawnedChannels[0]?.sentWireTexts).toStrictEqual(["review the diff"]);
  });

  it("never starts a posture-declaring run in a session spawned with no posture", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "review the diff",
    });

    await expect(
      harness.lifecycle.startRun({
        ...buildStartRunParams(),
        executionPosture: ALLOWED_DOMAINS_POSTURE,
      }),
    ).rejects.toMatchObject({ fields: { reason: "execution_posture_mismatch" } });
  });

  it("admits a run declaring no posture into a posture-bound session", async () => {
    const harness = buildHarness();
    await arrangeSession(harness, ALLOWED_DOMAINS_POSTURE);

    await harness.lifecycle.startRun(buildStartRunParams());

    expect(harness.transport.spawnedChannels[0]?.sentWireTexts).toStrictEqual(["review the diff"]);
  });
});

// A boolean "is a schema bound?" would admit a run carrying schema B into a process spawned with
// schema A. Identity is a canonical digest: key order is not semantic in JSON, array order is.
describe("ClaudeSessionLifecycle.startRun output-schema identity", () => {
  const SPAWN_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: { verdict: { type: "string" }, score: { type: "number" } },
    required: ["verdict", "score"],
  };

  async function arrangeSchemaBoundSession(
    harness: LifecycleHarness,
    outputSchema: Record<string, unknown>,
  ): Promise<void> {
    await harness.lifecycle.createSession({ ...buildCreateSessionParams(), outputSchema });
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "review the diff",
    });
  }

  it("never starts a run whose schema differs from the spawn-bound one", async () => {
    const harness = buildHarness();
    await arrangeSchemaBoundSession(harness, SPAWN_SCHEMA);

    await expect(
      harness.lifecycle.startRun({
        ...buildStartRunParams(),
        outputSchema: {
          type: "object",
          properties: { verdict: { type: "string" } },
          required: ["verdict"],
        },
      }),
    ).rejects.toMatchObject({
      code: "driver.unavailable",
      fields: { reason: "output_schema_mismatch" },
    });
    expect(harness.transport.spawnedChannels[0]?.sentWireTexts).toStrictEqual([]);
  });

  it("admits the same schema written with its keys in a different order", async () => {
    const harness = buildHarness();
    await arrangeSchemaBoundSession(harness, SPAWN_SCHEMA);

    await harness.lifecycle.startRun({
      ...buildStartRunParams(),
      outputSchema: {
        required: ["verdict", "score"],
        properties: { score: { type: "number" }, verdict: { type: "string" } },
        type: "object",
      },
    });

    expect(harness.transport.spawnedChannels[0]?.sentWireTexts).toStrictEqual(["review the diff"]);
  });

  it("refuses a schema differing only in ARRAY order, which is semantic", async () => {
    const harness = buildHarness();
    await arrangeSchemaBoundSession(harness, SPAWN_SCHEMA);

    await expect(
      harness.lifecycle.startRun({
        ...buildStartRunParams(),
        outputSchema: { ...SPAWN_SCHEMA, required: ["score", "verdict"] },
      }),
    ).rejects.toMatchObject({ fields: { reason: "output_schema_mismatch" } });
  });

  it("admits a run declaring no schema into a schema-bound session", async () => {
    const harness = buildHarness();
    await arrangeSchemaBoundSession(harness, SPAWN_SCHEMA);

    await harness.lifecycle.startRun(buildStartRunParams());

    expect(harness.transport.spawnedChannels[0]?.sentWireTexts).toStrictEqual(["review the diff"]);
  });
});

describe("ClaudeSessionLifecycle.interruptRun", () => {
  it("throws rather than reporting success when the CLI refuses the control request", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "review the diff",
    });
    await harness.lifecycle.startRun(buildStartRunParams());
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("unreachable: the session must have spawned a channel");
    }
    channel.controlResponse = {
      subtype: "error",
      error: "Unsupported control request subtype: interrupt",
    };

    await expect(harness.lifecycle.interruptRun({ runId: TEST_RUN_ID })).rejects.toBeInstanceOf(
      ClaudeControlRequestRefusedError,
    );
  });

  it("refuses an interrupt for a run with no live channel", async () => {
    const harness = buildHarness();

    await expect(harness.lifecycle.interruptRun({ runId: TEST_RUN_ID })).rejects.toMatchObject({
      code: "driver.unavailable",
      fields: { reason: "no_live_run" },
    });
  });
});

describe("ClaudeSessionLifecycle.closeSession", () => {
  it("disposes the channel with the intended-close reason and drops every run route", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "review the diff",
    });
    await harness.lifecycle.startRun(buildStartRunParams());

    await harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID });

    expect(harness.transport.spawnedChannels[0]?.disposals).toStrictEqual(["session_closed"]);
    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeUndefined();
  });

  // A dispose that rejects leaves a provider process running, so the slot is quarantined with the
  // channel retained (the only handle on that process); freeing it would allow a second process
  // under one canonical session.
  it("quarantines the session when disposal fails, and still surfaces the failure", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("unreachable: the session must have spawned a channel");
    }
    channel.disposeFailure = new Error("the provider process would not exit");
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "review the diff",
    });
    await harness.lifecycle.startRun(buildStartRunParams());

    await expect(harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID })).rejects.toThrow(
      "the provider process would not exit",
    );

    // (a) Routes go unconditionally: no run may reach a closing process.
    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeUndefined();
    // (b) The slot is held so no second process can be spawned beneath it. The reason stays the
    // closed-set `session_already_live` while the message names quarantine.
    await expect(harness.lifecycle.createSession(buildCreateSessionParams())).rejects.toMatchObject(
      {
        code: "driver.unavailable",
        fields: { reason: "session_already_live" },
      },
    );
    await expect(harness.lifecycle.createSession(buildCreateSessionParams())).rejects.toThrow(
      /quarantined/,
    );
    expect(harness.transport.spawnRequests).toHaveLength(1);
  });

  it("refuses a resume for a quarantined session through the failed arm", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("unreachable: the session must have spawned a channel");
    }
    channel.disposeFailure = new Error("the provider process would not exit");
    await expect(harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID })).rejects.toThrow();

    const result = await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: TEST_PINNED_PROVIDER_SESSION_ID,
    });

    expect(result.status).toBe("failed");
    expect(harness.transport.resumeRequests).toHaveLength(0);
  });

  it("retries the RETAINED channel on the next close and frees the slot on success", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("unreachable: the session must have spawned a channel");
    }
    channel.disposeFailure = new Error("the provider process would not exit");
    await expect(harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID })).rejects.toThrow();

    // Once the process exits the retry must reach that channel, not report success against a
    // session record that no longer exists.
    channel.disposeFailure = undefined;
    await expect(
      harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID }),
    ).resolves.toBeUndefined();

    expect(channel.disposals).toStrictEqual(["session_closed", "session_closed"]);
    // Only now is the slot free.
    await expect(
      harness.lifecycle.createSession(buildCreateSessionParams()),
    ).resolves.toBeDefined();
    expect(harness.transport.spawnRequests).toHaveLength(2);
  });

  it("keeps the slot quarantined when the retry also fails", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("unreachable: the session must have spawned a channel");
    }
    channel.disposeFailure = new Error("the provider process would not exit");

    await expect(harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID })).rejects.toThrow();
    await expect(harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID })).rejects.toThrow(
      "the provider process would not exit",
    );

    await expect(harness.lifecycle.createSession(buildCreateSessionParams())).rejects.toMatchObject(
      { fields: { reason: "session_already_live" } },
    );
  });
});

// Both entry points await a transport spawn between checking the session slot and registering
// the channel. Without a claim taken before that await both would spawn and the second
// registration would orphan the first process. Each test holds the transport open and asserts
// its spawn count: exactly one process.
describe("ClaudeSessionLifecycle establishment races", () => {
  function openEstablishmentGate(): { gate: Promise<void>; release: () => void } {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { gate, release };
  }

  it("admits exactly one of two concurrent creates for one session", async () => {
    const harness = buildHarness();
    const { gate, release } = openEstablishmentGate();
    harness.transport.establishmentGate = gate;

    const winner = harness.lifecycle.createSession(buildCreateSessionParams());
    const loser = harness.lifecycle.createSession(buildCreateSessionParams());
    const loserOutcome = await loser.then(
      () => "admitted",
      (error: unknown) => error,
    );
    release();
    await expect(winner).resolves.toBeDefined();

    expect(loserOutcome).toMatchObject({
      code: "driver.unavailable",
      fields: { reason: "session_already_live" },
    });
    // The refusal must mean the loser never spawned: one process, one channel.
    expect(harness.transport.spawnRequests).toHaveLength(1);
    expect(harness.transport.spawnedChannels).toHaveLength(1);
  });

  it("refuses a resume that arrives while a create is still in flight", async () => {
    const harness = buildHarness();
    const { gate, release } = openEstablishmentGate();
    harness.transport.establishmentGate = gate;

    const creating = harness.lifecycle.createSession(buildCreateSessionParams());
    const resumed = await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
    });
    release();
    await expect(creating).resolves.toBeDefined();

    // Resume's failure channel is the `failed` arm, never a throw, whichever collision caused it.
    expect(resumed.status).toBe("failed");
    if (resumed.status !== "failed") {
      throw new Error("unreachable: the resume must fail");
    }
    expect(resumed.recoveryCondition).toBe("recovery-needed");
    expect(harness.transport.resumeRequests).toHaveLength(0);
    expect(harness.transport.spawnedChannels).toHaveLength(1);
  });

  it("refuses a create that arrives while a resume is still in flight", async () => {
    const harness = buildHarness();
    const { gate, release } = openEstablishmentGate();
    harness.transport.establishmentGate = gate;

    const resuming = harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: TEST_PINNED_PROVIDER_SESSION_ID,
    });
    const createOutcome = await harness.lifecycle.createSession(buildCreateSessionParams()).then(
      () => "admitted",
      (error: unknown) => error,
    );
    release();
    await expect(resuming).resolves.toMatchObject({ status: "resumed" });

    expect(createOutcome).toMatchObject({
      code: "driver.unavailable",
      fields: { reason: "session_already_live" },
    });
    expect(harness.transport.spawnRequests).toHaveLength(0);
    expect(harness.transport.spawnedChannels).toHaveLength(1);
  });

  it("closes a session whose establishment was still in flight instead of no-opping", async () => {
    const harness = buildHarness();
    const { gate, release } = openEstablishmentGate();
    harness.transport.establishmentGate = gate;

    const creating = harness.lifecycle.createSession(buildCreateSessionParams());
    const closing = harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID });
    release();
    await creating;
    await closing;

    // A close that read the slot as empty would return before the channel was registered and the
    // process would outlive the daemon's record of it.
    expect(harness.transport.spawnedChannels).toHaveLength(1);
    expect(harness.transport.spawnedChannels[0]?.disposals).toStrictEqual(["session_closed"]);
    // The slot is genuinely free afterwards, not merely emptied of its record.
    await expect(
      harness.lifecycle.createSession(buildCreateSessionParams()),
    ).resolves.toBeDefined();
  });
});

// The slot must be held across every async transition, not merely re-taken after one. If the
// session record were dropped before awaiting `dispose`, the slot would read empty during
// teardown, a concurrent create would spawn a replacement, and a failing dispose would
// quarantine beside the new channel: two processes under one session. These tests hold each
// transition open and assert the slot refuses throughout.
describe("ClaudeSessionLifecycle slot is held across every transition", () => {
  function openGate(): { gate: Promise<void>; release: () => void } {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { gate, release };
  }

  async function arrangeClosingSession(harness: LifecycleHarness): Promise<{
    channel: FakeClaudeSessionChannel;
    closing: Promise<void>;
    release: () => void;
  }> {
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("unreachable: the session must have spawned a channel");
    }
    const { gate, release } = openGate();
    channel.disposeGate = gate;
    const closing = harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID });
    // The disposal was entered, so the slot is closing rather than merely scheduled to be.
    expect(channel.disposals).toStrictEqual(["session_closed"]);
    return { channel, closing, release };
  }

  it("refuses a create that arrives while a close is still disposing", async () => {
    const harness = buildHarness();
    const { closing, release } = await arrangeClosingSession(harness);

    const createOutcome = await harness.lifecycle.createSession(buildCreateSessionParams()).then(
      () => "admitted",
      (error: unknown) => error,
    );
    release();
    await closing;

    expect(createOutcome).toMatchObject({
      code: "driver.unavailable",
      fields: { reason: "session_already_live" },
    });
    // No replacement process was spawned beneath a session whose own process was still dying.
    expect(harness.transport.spawnRequests).toHaveLength(1);
  });

  it("refuses a resume that arrives while a close is still disposing", async () => {
    const harness = buildHarness();
    const { closing, release } = await arrangeClosingSession(harness);

    const resumed = await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: TEST_PINNED_PROVIDER_SESSION_ID,
    });
    release();
    await closing;

    expect(resumed.status).toBe("failed");
    expect(harness.transport.resumeRequests).toHaveLength(0);
  });

  it("frees the slot only after the disposal settles", async () => {
    const harness = buildHarness();
    const { closing, release } = await arrangeClosingSession(harness);

    await expect(
      harness.lifecycle.createSession(buildCreateSessionParams()),
    ).rejects.toBeInstanceOf(ClaudeSessionUnavailableError);
    release();
    await closing;

    // EMPTY at last: the same call that was refused a moment ago now succeeds.
    await expect(
      harness.lifecycle.createSession(buildCreateSessionParams()),
    ).resolves.toBeDefined();
    expect(harness.transport.spawnRequests).toHaveLength(2);
  });

  it("chains a concurrent close instead of disposing the same channel twice", async () => {
    const harness = buildHarness();
    const { channel, closing, release } = await arrangeClosingSession(harness);

    const secondClose = harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID });
    release();
    await closing;
    await secondClose;

    // The second close chained onto the first, saw an empty slot and returned, instead of issuing
    // a second teardown against a process already gone.
    expect(channel.disposals).toStrictEqual(["session_closed"]);
  });

  it("holds the slot across the QUARANTINED retry's own disposal", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("unreachable: the session must have spawned a channel");
    }
    channel.disposeFailure = new Error("the provider process would not exit");
    await expect(harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID })).rejects.toThrow();

    // The retry is itself an async transition and must hold the slot too.
    channel.disposeFailure = undefined;
    const { gate, release } = openGate();
    channel.disposeGate = gate;
    const retry = harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID });
    const createOutcome = await harness.lifecycle.createSession(buildCreateSessionParams()).then(
      () => "admitted",
      (error: unknown) => error,
    );
    release();
    await retry;

    expect(createOutcome).toMatchObject({ fields: { reason: "session_already_live" } });
    expect(harness.transport.spawnRequests).toHaveLength(1);
    await expect(
      harness.lifecycle.createSession(buildCreateSessionParams()),
    ).resolves.toBeDefined();
  });
});

// Claude's interrupt is channel-level, so a run route that outlives its turn is not inert: a
// late interrupt for the finished run would land on whatever turn the channel runs now. Routes
// are retired when the transport reports a terminal stream frame.
describe("ClaudeSessionLifecycle run-route retirement on turn terminal", () => {
  async function arrangeRunningTurn(harness: LifecycleHarness): Promise<FakeClaudeSessionChannel> {
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "review the diff",
    });
    await harness.lifecycle.startRun(buildStartRunParams());
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("unreachable: the session must have spawned a channel");
    }
    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBe(channel);
    return channel;
  }

  it("retires the route when the turn ends in an error terminal", async () => {
    const harness = buildHarness();
    const channel = await arrangeRunningTurn(harness);

    // Either terminal ends the route because the turn is over, not because it succeeded. The
    // double owns the terminal discriminant, as a transport does.
    channel.emitStreamFrame("result/error_max_turns");

    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeUndefined();
  });

  it("keeps the route across a non-terminal frame", async () => {
    const harness = buildHarness();
    const channel = await arrangeRunningTurn(harness);

    // A thread-scoped, non-terminal kind must route and project, so this asserts the terminal
    // discriminant rather than a frame the router would have refused anyway.
    const route = channel.emitStreamFrame("system/task_progress");

    expect(route).toStrictEqual({ decision: "project" });
    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBe(channel);
  });

  it("refuses a late interrupt for a completed run instead of hitting the live turn", async () => {
    const harness = buildHarness();
    const channel = await arrangeRunningTurn(harness);
    channel.emitStreamFrame("result/success");

    await expect(harness.lifecycle.interruptRun({ runId: TEST_RUN_ID })).rejects.toMatchObject({
      code: "driver.unavailable",
      fields: { reason: "no_live_run" },
    });
    // Nothing reached the channel: the newer turn was never touched.
    expect(channel.controlRequests).toStrictEqual([]);
  });

  it("ignores a terminal from a channel that is no longer the live one", async () => {
    const harness = buildHarness();
    const staleChannel = await arrangeRunningTurn(harness);
    // The first process refuses to exit, so its channel is quarantined; a later
    // close succeeds and frees the slot, and a new session takes it.
    staleChannel.disposeFailure = new Error("the provider process would not exit");
    await expect(harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID })).rejects.toThrow();
    staleChannel.disposeFailure = undefined;
    await harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID });
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_SECOND_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "now the next task",
    });
    await harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID });
    const liveChannel = harness.transport.spawnedChannels[1];

    // The driver holds no kill, so the old process can still emit after the daemon stopped
    // listening; that terminal belongs to nobody.
    staleChannel.emitStreamFrame("result/success");

    expect(harness.lifecycle.findChannelForRun(TEST_SECOND_RUN_ID)).toBe(liveChannel);
  });

  it("leaves the session LIVE and startable after a turn terminal", async () => {
    const harness = buildHarness();
    const channel = await arrangeRunningTurn(harness);
    channel.emitStreamFrame("result/success");

    // It is the RUN that ended, not the session: a next run must still start.
    harness.runDispatchResolver.dispatchByRunId.set(TEST_SECOND_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "now the next task",
    });
    await harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID });

    expect(harness.lifecycle.findChannelForRun(TEST_SECOND_RUN_ID)).toBe(channel);
    expect(channel.sentWireTexts).toStrictEqual(["review the diff", "now the next task"]);
  });
});

// Between the transport handing back a live channel and that channel being registered, three
// things can throw: the injected binding minter, the spawn-binding digest of a caller-supplied
// output schema, and the transport's own `onTurnTerminal`. An escaping throw would skip both
// disposal and registration while the slot claim cleared, leaving an unreferenced running
// process and a free slot. Every exit from this window must register or dispose.
describe("ClaudeSessionLifecycle adoption window", () => {
  // A schema whose digest cannot be computed: `JSON.stringify` throws on BigInt.
  const UNSERIALIZABLE_OUTPUT_SCHEMA: Record<string, unknown> = { limit: 10n };

  it("disposes the resumed process when the binding minter throws", async () => {
    const harness = buildHarness({
      mintBindingId: () => {
        throw new Error("the runtime_bindings store is unreachable");
      },
    });

    const result = await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
    });

    // Resume's failure channel is the arm, never a throw.
    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("unreachable: the resume must fail");
    }
    expect(result.recoveryCondition).toBe("recovery-needed");
    expect(result.providerFailureDetail).toContain("runtime_bindings");
    expect(DriverResumeResultSchema.safeParse(result).success).toBe(true);
    // The process the transport handed back was disposed, not orphaned.
    expect(harness.transport.spawnedChannels[0]?.disposals).toStrictEqual(["establishment_failed"]);
    // The slot is free, so recovery is an ordinary create.
    await expect(
      harness.lifecycle.createSession(buildCreateSessionParams()),
    ).resolves.toBeDefined();
  });

  it("disposes the resumed process when the transport refuses terminal registration", async () => {
    const harness = buildHarness();
    harness.transport.onTurnTerminalFailure = new Error("the stream consumer is already closed");

    const result = await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
    });

    expect(result.status).toBe("failed");
    expect(harness.transport.spawnedChannels[0]?.disposals).toStrictEqual(["establishment_failed"]);
    // The slot is free once the transport is healthy again.
    harness.transport.onTurnTerminalFailure = undefined;
    await expect(
      harness.lifecycle.createSession(buildCreateSessionParams()),
    ).resolves.toBeDefined();
  });

  it("disposes the resumed process when the spawn-binding digest cannot be computed", async () => {
    const harness = buildHarness();

    const result = await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
      outputSchema: UNSERIALIZABLE_OUTPUT_SCHEMA,
    });

    expect(result.status).toBe("failed");
    expect(harness.transport.spawnedChannels[0]?.disposals).toStrictEqual(["establishment_failed"]);
  });

  it("disposes the spawned process when create cannot adopt it, and re-throws the cause", async () => {
    const harness = buildHarness();
    harness.transport.onTurnTerminalFailure = new Error("the stream consumer is already closed");

    // `createSession` has no degraded arm, so throwing is its failure channel, but the channel
    // must still be disposed.
    await expect(harness.lifecycle.createSession(buildCreateSessionParams())).rejects.toThrow(
      "the stream consumer is already closed",
    );

    expect(harness.transport.spawnedChannels[0]?.disposals).toStrictEqual(["establishment_failed"]);
    // The slot never latched: a retry is admitted.
    harness.transport.onTurnTerminalFailure = undefined;
    await expect(
      harness.lifecycle.createSession(buildCreateSessionParams()),
    ).resolves.toBeDefined();
    expect(harness.transport.spawnRequests).toHaveLength(2);
  });

  it("disposes the spawned process when create's output schema cannot be digested", async () => {
    const harness = buildHarness();

    await expect(
      harness.lifecycle.createSession({
        ...buildCreateSessionParams(),
        outputSchema: UNSERIALIZABLE_OUTPUT_SCHEMA,
      }),
    ).rejects.toThrow();

    expect(harness.transport.spawnedChannels[0]?.disposals).toStrictEqual(["establishment_failed"]);
    await expect(
      harness.lifecycle.createSession(buildCreateSessionParams()),
    ).resolves.toBeDefined();
  });
});

describe("ClaudeSessionLifecycle.probeAuth", () => {
  it("reports authenticated when the transport takes the reading", async () => {
    const harness = buildHarness();

    const result = await harness.lifecycle.probeAuth();

    expect(result.status).toBe("authenticated");
    expect(harness.transport.probeAuthCallCount).toBe(1);
  });

  it("reports unauthenticated only for the TYPED logged-out signal", async () => {
    const harness = buildHarness();
    harness.transport.probeAuthFailure = new ClaudeAuthenticationRequiredError(
      "no credentials on this node",
    );

    await expect(harness.lifecycle.probeAuth()).resolves.toMatchObject({
      status: "unauthenticated",
    });
  });

  it("reports indeterminate for a probe it could not take", async () => {
    const harness = buildHarness();
    harness.transport.probeAuthFailure = new Error("claude binary not found");

    // Fail-closed for admission yet distinguishable: sending an operator to re-authenticate a
    // credential never in question misleads them.
    const result = await harness.lifecycle.probeAuth();

    expect(result.status).toBe("indeterminate");
    expect(result.detail).toContain("claude binary not found");
  });

  it("classifies by type, not by message text", async () => {
    const harness = buildHarness();
    // A generic failure whose words look like a credential problem; a substring test would
    // misclassify it as a determinate logout.
    harness.transport.probeAuthFailure = new Error("not authenticated: upstream 401");

    await expect(harness.lifecycle.probeAuth()).resolves.toMatchObject({
      status: "indeterminate",
    });
  });

  it("never throws, even when the transport throws a non-Error", async () => {
    const harness = buildHarness();
    harness.transport.probeAuthFailure = "just a string" as unknown as Error;

    await expect(harness.lifecycle.probeAuth()).resolves.toMatchObject({
      status: "indeterminate",
    });
  });

  it("establishes nothing, so a create still succeeds after it", async () => {
    const harness = buildHarness();

    await harness.lifecycle.probeAuth();

    // A probe that spawned a session would not be zero-turn, and one holding the session slot
    // would stall the admission check it exists to make cheap.
    expect(harness.transport.spawnRequests).toStrictEqual([]);
    await expect(
      harness.lifecycle.createSession(buildCreateSessionParams()),
    ).resolves.toMatchObject({ providerSessionId: TEST_PINNED_PROVIDER_SESSION_ID });
  });
});

// `providerFailureDetail` is rendered by a module-private helper that must be total over
// arbitrary thrown values: every caller is a catch block, and the refused-channel disposal path
// must not throw. Exercised through the resume failure path, which persists the detail.
describe("provider failure detail rendering", () => {
  function buildErrorWithHostileProperties(hostile: {
    readonly message?: boolean;
    readonly name?: boolean;
  }): Error {
    const error = new Error("this message is never reachable");
    if (hostile.message === true) {
      Object.defineProperty(error, "message", {
        get: () => {
          throw new Error("the message getter exploded");
        },
      });
    }
    if (hostile.name === true) {
      Object.defineProperty(error, "name", {
        get: () => {
          throw new Error("the name getter exploded");
        },
      });
    }
    return error;
  }

  async function resumeFailureDetail(failure: unknown): Promise<string> {
    const harness = buildHarness();
    harness.transport.resumeFailure = failure as Error;
    const result = await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
    });
    if (result.status !== "failed") {
      throw new Error("unreachable: the resume must fail");
    }
    // Whatever the value did, the arm is still contract-valid.
    expect(DriverResumeResultSchema.safeParse(result).success).toBe(true);
    return result.providerFailureDetail;
  }

  it("falls back to the error name when the message getter throws", async () => {
    const detail = await resumeFailureDetail(buildErrorWithHostileProperties({ message: true }));

    expect(detail).toBe("Error");
  });

  it("falls back to the constant when both the message and name getters throw", async () => {
    const detail = await resumeFailureDetail(
      buildErrorWithHostileProperties({ message: true, name: true }),
    );

    expect(detail).toContain("no describable detail");
  });

  it("never renders a non-string message, which would stringify an arbitrary object", async () => {
    const error = new Error("unused");
    // An unreadable value is reported as undescribable, never rendered best-effort: a `toString`
    // on a config-bearing object is how credential material would reach a durable row.
    Object.defineProperty(error, "message", {
      value: { toString: () => "sk-live-should-never-appear" },
    });

    const detail = await resumeFailureDetail(error);

    expect(detail).toBe("Error");
    expect(detail).not.toContain("sk-live");
  });
});

describe("ClaudeSessionLifecycle.forkConversation", () => {
  it("reports the rebinding `bindingId` on the applied arm", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());

    // The input binding is deliberately not the minted one, so a driver that echoed the caller's
    // `bindingId` (the binding of the process just replaced) fails here.
    const result = await harness.lifecycle.forkConversation({
      sessionId: TEST_SESSION_ID,
      bindingId: "binding-predecessor",
      position: 4,
    });

    // The rewind relaunches the process, so an applied rollback reporting the predecessor's
    // binding would leave the caller pointing at a process that is gone.
    expect(result).toStrictEqual({
      status: "applied",
      sessionPosition: 4,
      bindingId: TEST_BINDING_ID,
    });
  });

  it("refuses a rewind the provider answered with the SAME session id", async () => {
    // A rewind answering with the id it was given did not fork: the conversation the fork was
    // meant to preserve is gone.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.transport.announcedForkedProviderSessionId = TEST_PINNED_PROVIDER_SESSION_ID;

    const result = await harness.lifecycle.forkConversation({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
      position: 4,
    });

    expect(result.status).toBe("degraded");
    expect((result as { fallbackAction: string }).fallbackAction).toContain("rewind-not-forked");
  });
});

describe("ClaudeSessionLifecycle resume credential policy", () => {
  it("hands a resume the policy ref of the posture BEING RESUMED", async () => {
    // A routing assertion, not a strip assertion: the deny strip belongs to the transport under
    // the spawn-environment obligation, so this band owes handing that transport the ref of the
    // posture the resume states. Both paths build their legs from `params` through one builder.
    const harness = buildHarness();

    await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
      executionPosture: SANDBOXED_POSTURE,
    });

    expect(harness.transport.resumeRequests[0]?.sandboxSettings?.credentialPolicyRef).toBe(
      SANDBOXED_POSTURE.credentialPolicyRef,
    );
  });

  it("hands a `trusted` resume no policy ref at all", async () => {
    // The other direction, which a "still carries a ref" assertion cannot catch: `trusted` types
    // `credentialPolicyRef?: never`, so settings carrying one would hand the transport a policy
    // the posture does not declare.
    const harness = buildHarness();

    await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
      executionPosture: TRUSTED_POSTURE,
    });

    expect(
      harness.transport.resumeRequests[0]?.sandboxSettings?.credentialPolicyRef,
    ).toBeUndefined();
  });
});

describe("ClaudeSessionLifecycle callback-tool registry", () => {
  const SEARCH_TOOL = {
    name: "search_workspace",
    description: "Searches the workspace.",
    inputSchema: { type: "object" },
  };

  it("serves the registry as an ephemeral MCP server when a dispatcher is bound", async () => {
    const harness = buildHarness();

    await harness.lifecycle.createSession({
      ...buildCreateSessionParams(),
      callbackTools: [SEARCH_TOOL],
      onCallbackToolCall: async (): Promise<CallbackToolResult> =>
        await Promise.resolve({ status: "completed" }),
    });

    const spawnRequest = harness.transport.spawnRequests[0];
    expect(spawnRequest?.callbackToolServer?.serverName).toBe(CLAUDE_CALLBACK_MCP_SERVER_NAME);
    expect(spawnRequest?.callbackTools).toStrictEqual([SEARCH_TOOL]);
  });

  it("injects NO registry and records the withholding when no dispatcher is bound", async () => {
    const harness = buildHarness();

    await harness.lifecycle.createSession({
      ...buildCreateSessionParams(),
      callbackTools: [SEARCH_TOOL],
    });

    // Withheld rather than served-and-refused: a tool the model never learns of costs no turns.
    const spawnRequest = harness.transport.spawnRequests[0];
    expect(spawnRequest?.callbackTools).toBeUndefined();
    expect(spawnRequest?.callbackToolServer).toBeUndefined();
    const withholdings = harness.diagnostics.recentRecordsOfKind("callback_tool_registry_withheld");
    expect(withholdings).toHaveLength(1);
    expect(withholdings[0]?.details["reason"]).toBe("no-dispatcher-bound");
  });

  it("injects NO registry when the bound transport does not realize the registration", async () => {
    // The third gate. Whether the model ever sees the registry depends on whichever transport
    // writes the process arguments; unasked, the daemon would host a live registry for tools the
    // model was never told about, invisible because an uncalled tool looks like a declined one.
    const harness = buildHarness();
    harness.transport.realizesCallbackToolRegistration = false;

    await harness.lifecycle.createSession({
      ...buildCreateSessionParams(),
      callbackTools: [SEARCH_TOOL],
      onCallbackToolCall: async (): Promise<CallbackToolResult> =>
        await Promise.resolve({ status: "completed" }),
    });

    const spawnRequest = harness.transport.spawnRequests[0];
    expect(spawnRequest?.callbackTools).toBeUndefined();
    expect(spawnRequest?.callbackToolServer).toBeUndefined();
    const withholdings = harness.diagnostics.recentRecordsOfKind("callback_tool_registry_withheld");
    expect(withholdings).toHaveLength(1);
    expect(withholdings[0]?.details["reason"]).toBe("transport-registration-unavailable");
    expect(withholdings[0]?.details["withheldToolCount"]).toBe(1);
    expect(withholdings[0]?.dispositionReason).toBe(
      CLAUDE_CALLBACK_TOOL_TRANSPORT_UNAVAILABLE_DETAIL,
    );
  });

  it("withholds on the resume path too, since a resume is a fresh spawn", async () => {
    const harness = buildHarness();
    harness.transport.realizesCallbackToolRegistration = false;

    await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
      callbackTools: [SEARCH_TOOL],
      onCallbackToolCall: async (): Promise<CallbackToolResult> =>
        await Promise.resolve({ status: "completed" }),
    });

    expect(harness.transport.resumeRequests[0]?.callbackToolServer).toBeUndefined();
    expect(harness.diagnostics.recentRecordsOfKind("callback_tool_registry_withheld")).toHaveLength(
      1,
    );
  });
});

describe("composeClaudeCallbackMcpServer", () => {
  it("mangles each tool into the provider-facing MCP name and maps every served tool back", () => {
    const descriptor = composeClaudeCallbackMcpServer([
      { name: "search_workspace", description: "d", inputSchema: {} },
    ]);

    expect(composeClaudeProviderToolName(descriptor.serverName, "search_workspace")).toBe(
      "mcp__sessions__search_workspace",
    );
    expect(descriptor.registryNamesByProviderName.get("mcp__sessions__search_workspace")).toBe(
      "search_workspace",
    );

    // No invocation can arrive unmappable.
    const tools = ["alpha", "beta", "gamma"].map((name) => ({
      name,
      description: name,
      inputSchema: {},
    }));
    const servedDescriptor = composeClaudeCallbackMcpServer(tools);
    expect(servedDescriptor.registryNamesByProviderName.size).toBe(servedDescriptor.tools.length);
    for (const tool of servedDescriptor.tools) {
      const providerName = composeClaudeProviderToolName(servedDescriptor.serverName, tool.name);
      expect(servedDescriptor.registryNamesByProviderName.get(providerName)).toBe(tool.name);
    }
  });

  it("de-duplicates a repeated name last-wins rather than serving it twice", () => {
    // Serving one provider-facing name twice would make the reverse map depend on iteration order.
    const descriptor = composeClaudeCallbackMcpServer([
      { name: "search", description: "first", inputSchema: {} },
      { name: "search", description: "second", inputSchema: {} },
    ]);

    expect(descriptor.tools).toHaveLength(1);
    expect(descriptor.tools[0]?.description).toBe("second");
  });
});

describe("ClaudeSubagentConcurrencyGate", () => {
  function buildGate(maxConcurrent: number): {
    readonly gate: ClaudeSubagentConcurrencyGate;
    readonly diagnostics: DriverDiagnosticsEmitter;
  } {
    const diagnostics = makeSilentDriverDiagnostics();
    return {
      gate: new ClaudeSubagentConcurrencyGate({
        sessionId: TEST_SESSION_ID,
        diagnostics,
        maxConcurrent,
      }),
      diagnostics,
    };
  }

  it("never admits beyond the cap, even when a release and an arrival interleave", async () => {
    // Hand-over race: a release that decremented and then woke a waiter in a microtask leaves a
    // window in which a third caller reads a free slot the waiter was already promised.
    const { gate } = buildGate(1);
    const releaseFirst = await gate.admit("subagent-a");
    const secondAdmission = gate.admit("subagent-b");
    expect(gate.heldSlotCount).toBe(1);

    releaseFirst();
    const thirdAdmission = gate.admit("subagent-c");

    expect(gate.heldSlotCount).toBe(1);
    const releaseSecond = await secondAdmission;
    expect(gate.heldSlotCount).toBe(1);
    releaseSecond();
    await thirdAdmission;
    expect(gate.heldSlotCount).toBe(1);
  });

  it("admits waiters in arrival order", async () => {
    const { gate } = buildGate(1);
    const release = await gate.admit("holder");
    const admitted: string[] = [];
    const waiters = ["first", "second", "third"].map(async (name) => {
      const releaseWaiter = await gate.admit(name);
      admitted.push(name);
      releaseWaiter();
    });

    release();
    await Promise.all(waiters);

    // A waiter set resolved in arbitrary order starves an unlucky subagent inside a run that has
    // a wall-clock budget.
    expect(admitted).toStrictEqual(["first", "second", "third"]);
  });

  it("frees exactly one slot for a doubly-released admission", async () => {
    const { gate } = buildGate(2);
    const release = await gate.admit("subagent-a");
    await gate.admit("subagent-b");

    release();
    release();

    expect(gate.heldSlotCount).toBe(1);
  });

  it("floors a sub-one cap at one rather than deadlocking every call", async () => {
    const { gate } = buildGate(0);

    const release = await gate.admit("subagent-a");

    expect(gate.heldSlotCount).toBe(1);
    release();
  });

  it("fails every waiter on disposal rather than hanging the provider turn", async () => {
    const { gate } = buildGate(1);
    await gate.admit("holder");
    const waiting = gate.admit("waiter");

    gate.dispose();

    await expect(waiting).rejects.toBeInstanceOf(ClaudeSessionUnavailableError);
    await expect(gate.admit("later")).rejects.toBeInstanceOf(ClaudeSessionUnavailableError);
  });
});

/** The realized depth ceiling on a spawn's enabled policy, or `undefined`. */
function readRealizedMaxDepth(harness: LifecycleHarness): number | undefined {
  const policy = harness.transport.spawnRequests[0]?.subagentPolicy;
  return policy?.enabled === true ? policy.maxDepth : undefined;
}

describe("ClaudeSessionLifecycle subagent admission", () => {
  const ENABLED_POLICY: SubagentPolicy = {
    enabled: true,
    maxConcurrent: 2,
    maxDepth: 1,
    definitions: [],
  };

  it("installs a FRESH gate on a rewind rather than carrying the predecessor's", async () => {
    // A rewind relaunches the process, so the old gate's subagents died with it; carrying them
    // forward would hold a permanently reduced cap.
    const harness = buildHarness();
    await harness.lifecycle.createSession({
      ...buildCreateSessionParams(),
      subagentPolicy: ENABLED_POLICY,
    });
    const predecessorGate = harness.transport.spawnRequests[0]?.subagentAdmission;
    await predecessorGate?.admit("held-across-the-rewind");

    await harness.lifecycle.forkConversation({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
      position: 4,
    });

    const rewoundGate = harness.transport.rewindRequests[0]?.subagentAdmission;
    expect(rewoundGate).toBeDefined();
    expect(rewoundGate).not.toBe(predecessorGate);
    // The predecessor's own waiters are failed instead of left hanging on a gone process.
    await expect(predecessorGate?.admit("orphan")).rejects.toBeInstanceOf(
      ClaudeSessionUnavailableError,
    );
  });

  it("fails the gate's waiters when the session is closed", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession({
      ...buildCreateSessionParams(),
      subagentPolicy: ENABLED_POLICY,
    });
    const gate = harness.transport.spawnRequests[0]?.subagentAdmission;

    await harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID });

    await expect(gate?.admit("after-close")).rejects.toBeInstanceOf(ClaudeSessionUnavailableError);
  });

  it("records every definition it could not hold at the daemon boundary", async () => {
    const harness = buildHarness();

    await harness.lifecycle.createSession({
      ...buildCreateSessionParams(),
      subagentPolicy: {
        enabled: true,
        maxConcurrent: 2,
        maxDepth: 1,
        definitions: [
          // `bypassPermissions` skips the daemon's interception point, so this definition's
          // beyond-cap calls could not be held at a boundary that is not there.
          { name: "unmediated", permissionMode: "bypassPermissions" },
          { name: "mediated", permissionMode: "default" },
        ],
      },
    });

    const withheld = harness.diagnostics.recentRecordsOfKind("subagent_definition_disabled");
    expect(withheld).toHaveLength(1);
    expect(withheld[0]?.details["definitionName"]).toBe("unmediated");
    // The admitted one still ships: withholding is per definition, not per spawn.
    const realizedPolicy = harness.transport.spawnRequests[0]?.subagentPolicy;
    expect(
      realizedPolicy?.enabled === true
        ? realizedPolicy.definitions.map((definition) => definition.name)
        : undefined,
    ).toStrictEqual(["mediated"]);
  });

  it("clamps the depth ceiling while honoring a policy that asked for less", async () => {
    const clampedHarness = buildHarness();
    await clampedHarness.lifecycle.createSession({
      ...buildCreateSessionParams(),
      subagentPolicy: { enabled: true, maxConcurrent: 1, maxDepth: 99, definitions: [] },
    });
    const modestHarness = buildHarness();
    await modestHarness.lifecycle.createSession({
      ...buildCreateSessionParams(),
      subagentPolicy: { enabled: true, maxConcurrent: 1, maxDepth: 2, definitions: [] },
    });

    expect(readRealizedMaxDepth(clampedHarness)).toBe(CLAUDE_SUBAGENT_MAX_DEPTH_CEILING);
    expect(readRealizedMaxDepth(modestHarness)).toBe(2);
  });
});

describe("composeClaudeSandboxSettings", () => {
  it("pins the always-armed permission prompt on every sandboxed arm", () => {
    // `supervised` maps to `on-request` unconditionally; on this provider that is realized as
    // `allowUnsandboxedCommands: false`, so no tool call reaches the model without the daemon.
    for (const posture of [SANDBOXED_POSTURE, READONLY_POSTURE]) {
      const settings = composeClaudeSandboxSettings(posture);
      expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
      expect(settings.sandbox.enabled).toBe(true);
      // A host whose sandbox cannot start must refuse rather than run unsandboxed under a
      // recorded sandboxed posture.
      expect(settings.sandbox.failIfUnavailable).toBe(true);
    }
  });

  it("writes nowhere on the read-only arm, with an EMPTY list rather than an omitted one", () => {
    // An omitted list requests the provider's default, which is not the same as "writes nowhere".
    expect(
      composeClaudeSandboxSettings(READONLY_POSTURE).sandbox.filesystem.allowWrite,
    ).toStrictEqual([]);
  });

  it("omits the network restriction entirely for `full`, and empties it for `none`", () => {
    const trusted = composeClaudeSandboxSettings(TRUSTED_POSTURE);
    const denied = composeClaudeSandboxSettings(SANDBOXED_POSTURE);

    // The absence is the statement; an empty list would mean the opposite.
    expect(trusted.sandbox.network).toBeUndefined();
    expect(denied.sandbox.network).toStrictEqual({ allowedDomains: [] });
  });
});

// The routing and metering band, driven through the real inbound seam. The double honors the
// whole `onInboundFrame` transport obligation (observe before projecting, project only on
// `project`), so these assert what a real transport does with the driver's answer.

describe("ClaudeSessionLifecycle thread routing and usage metering", () => {
  const CHILD_SUBAGENT_ID = "subagent-7";

  interface RoutingHarness extends LifecycleHarness {
    readonly meteredUsage: { sessionId: SessionId; delta: MeteredUsageDelta }[];
    readonly subagentLifecycle: { sessionId: SessionId; emission: SubagentLifecycleEmission }[];
    readonly releasedRoutes: ThreadFrameRoute[];
  }

  function buildRoutingHarness(
    overrides: Partial<ClaudeSessionLifecycleDependencies> = {},
  ): RoutingHarness {
    const meteredUsage: { sessionId: SessionId; delta: MeteredUsageDelta }[] = [];
    const subagentLifecycle: { sessionId: SessionId; emission: SubagentLifecycleEmission }[] = [];
    const releasedRoutes: ThreadFrameRoute[] = [];
    const harness = buildHarness({
      onMeteredUsage: (sessionId, delta) => meteredUsage.push({ sessionId, delta }),
      onSubagentLifecycle: (sessionId, emission) => subagentLifecycle.push({ sessionId, emission }),
      onReleasedFrameRoute: (_sessionId, _observation, route) => releasedRoutes.push(route),
      ...overrides,
    });
    return { ...harness, meteredUsage, subagentLifecycle, releasedRoutes };
  }

  async function liveChannel(harness: RoutingHarness): Promise<FakeClaudeSessionChannel> {
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("unreachable: the session must have spawned a channel");
    }
    return channel;
  }

  function usageObservation(
    totalInputTokens: number,
    subagentId: string | null = null,
  ): Parameters<FakeClaudeSessionChannel["emitStreamFrame"]>[1] {
    return {
      subagentId,
      cumulativeUsage: {
        namedTurnId: "turn-A",
        cumulative: { input: totalInputTokens },
      },
    };
  }

  it("closing a session releases its routing band rather than leaking or resurrecting it", async () => {
    const harness = buildRoutingHarness();
    const channel = await liveChannel(harness);
    const providerSessionId = channel.providerSessionId;
    channel.emitStreamFrame("assistant/message", usageObservation(10));
    expect(
      harness.lifecycle.usageAccountantFor(TEST_SESSION_ID)?.hasThread(providerSessionId),
    ).toBe(true);

    await harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID });

    // Gone, not replaced: the accessors do not create, so a read after close answers `undefined`
    // instead of minting a band nothing will delete.
    expect(harness.lifecycle.usageAccountantFor(TEST_SESSION_ID)).toBeUndefined();
    expect(harness.lifecycle.frameRouterFor(TEST_SESSION_ID)).toBeUndefined();
  });

  it("a frame naming a FOREIGN thread never projects", async () => {
    const harness = buildRoutingHarness();
    const channel = await liveChannel(harness);

    const route = channel.emitStreamFrame("system/task_progress", {
      subagentId: "some-unannounced-subagent",
    });

    expect(route.decision).toBe("held-pending-registration");
    expect(channel.deliveredFrameKinds).toStrictEqual([]);
  });

  it("a usage frame meters a per-turn DELTA, never the cumulative counter", async () => {
    const harness = buildRoutingHarness();
    const channel = await liveChannel(harness);

    channel.emitStreamFrame("system/task_progress", usageObservation(100));
    channel.emitStreamFrame("system/task_progress", usageObservation(150));

    // This provider reports a running total that resets at no turn boundary: 150 is the
    // session's whole spend, 50 is what the second turn cost.
    expect(harness.meteredUsage.map((entry) => entry.delta.axisDeltas.input)).toEqual([100, 50]);
  });

  it("an announced child's content is suppressed while its spend carves through", async () => {
    const harness = buildRoutingHarness();
    const channel = await liveChannel(harness);

    channel.emitStreamFrame("control_request/hook_callback", {
      subagentLifecycle: {
        signal: "SubagentStart",
        subagentId: CHILD_SUBAGENT_ID,
        parentToolUseId: "toolu_parent",
      },
    });
    const contentRoute = channel.emitStreamFrame("system/task_progress", {
      subagentId: CHILD_SUBAGENT_ID,
    });
    channel.emitStreamFrame("system/task_progress", usageObservation(40, CHILD_SUBAGENT_ID));

    expect(contentRoute.decision).toBe("suppress-child-transcript");
    // The announcement rides the connection-scoped control channel and is delivered; the
    // child's own content frame never reaches the consumer.
    expect(channel.deliveredFrameKinds).toStrictEqual(["control_request/hook_callback"]);
    expect(harness.meteredUsage).toHaveLength(1);
    expect(harness.meteredUsage[0]?.delta.threadId).toBe(CHILD_SUBAGENT_ID);
    expect(harness.meteredUsage[0]?.delta.axisDeltas.input).toBe(40);
  });

  it("the session's own terminal projects, and reaches the turn-terminal hook", async () => {
    const harness = buildRoutingHarness();
    const channel = await liveChannel(harness);
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "review the diff",
    });
    await harness.lifecycle.startRun(buildStartRunParams());
    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBe(channel);

    const route = channel.emitStreamFrame("result/success");

    expect(route).toStrictEqual({ decision: "project" });
    expect(channel.deliveredFrameKinds).toStrictEqual(["result/success"]);
    // Projected and consumed: the terminal retires the route (a channel-level interrupt must not
    // outlive its turn).
    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeUndefined();
  });

  it("a fully suppressed child still leaves its started/completed pair", async () => {
    const harness = buildRoutingHarness();
    const channel = await liveChannel(harness);

    channel.emitStreamFrame("control_request/hook_callback", {
      subagentLifecycle: {
        signal: "SubagentStart",
        subagentId: CHILD_SUBAGENT_ID,
        parentToolUseId: "toolu_parent",
      },
    });
    for (const childFrameKind of ["system/task_progress", "system/tool_use_summary"]) {
      channel.emitStreamFrame(childFrameKind, { subagentId: CHILD_SUBAGENT_ID });
    }
    channel.emitStreamFrame("control_request/hook_callback", {
      subagentId: CHILD_SUBAGENT_ID,
      subagentLifecycle: {
        signal: "SubagentStop",
        subagentId: CHILD_SUBAGENT_ID,
        parentToolUseId: "toolu_parent",
      },
    });

    // No child content on the parent's timeline: the two delivered frames are the child's
    // start/stop announcements on the control channel; both `system/*` child frames were
    // suppressed.
    expect(channel.deliveredFrameKinds).toStrictEqual([
      "control_request/hook_callback",
      "control_request/hook_callback",
    ]);
    // The child is not invisible: this pair is its whole presence.
    expect(
      harness.subagentLifecycle.map((entry) => ({
        eventType: entry.emission.eventType,
        subagentId: entry.emission.subagentId,
        parentReference: entry.emission.parentReference,
      })),
    ).toEqual([
      {
        eventType: "subagent.started",
        subagentId: CHILD_SUBAGENT_ID,
        parentReference: "toolu_parent",
      },
      {
        eventType: "subagent.completed",
        subagentId: CHILD_SUBAGENT_ID,
        parentReference: "toolu_parent",
      },
    ]);
  });

  it("a DUPLICATE SubagentStart retains the child's usage base rather than re-basing it", async () => {
    const harness = buildRoutingHarness();
    const channel = await liveChannel(harness);
    const announceChild = (): void => {
      channel.emitStreamFrame("control_request/hook_callback", {
        subagentLifecycle: {
          signal: "SubagentStart",
          subagentId: CHILD_SUBAGENT_ID,
          parentToolUseId: "toolu_parent",
        },
      });
    };

    announceChild();
    channel.emitStreamFrame("system/task_progress", usageObservation(100, CHILD_SUBAGENT_ID));
    // The provider re-announces a known child; re-establishing would zero the base mid-stream
    // and meter 150 instead of the 50 the child spent since.
    announceChild();
    channel.emitStreamFrame("system/task_progress", usageObservation(150, CHILD_SUBAGENT_ID));

    expect(harness.meteredUsage.map((entry) => entry.delta.axisDeltas.input)).toEqual([100, 50]);
    expect(harness.subagentLifecycle).toHaveLength(1);
    expect(harness.subagentLifecycle[0]?.emission.eventType).toBe("subagent.started");
    expect(
      harness.diagnostics.recentRecordsOfKind("thread_duplicate_child_announcement"),
    ).toHaveLength(1);
  });

  it("a child's frames that RACED its announcement are released, metered, and DELIVERED", async () => {
    const harness = buildRoutingHarness();
    const channel = await liveChannel(harness);

    // The child's first usage frame arrives before the `SubagentStart` announcing it: the race
    // the pending hold exists for.
    const heldRoute = channel.emitStreamFrame(
      "system/task_progress",
      usageObservation(40, CHILD_SUBAGENT_ID),
    );
    expect(heldRoute.decision).toBe("held-pending-registration");
    expect(harness.meteredUsage).toStrictEqual([]);

    channel.emitStreamFrame("control_request/hook_callback", {
      subagentLifecycle: {
        signal: "SubagentStart",
        subagentId: CHILD_SUBAGENT_ID,
        parentToolUseId: "toolu_parent",
      },
    });

    // Released, then routed for real: the spend that raced the announcement is charged, not shed
    // at the hold timeout.
    expect(harness.meteredUsage).toHaveLength(1);
    expect(harness.meteredUsage[0]?.delta.axisDeltas.input).toBe(40);
    // The decision also reached a consumer: a released frame has no observer call in flight to
    // answer.
    expect(harness.releasedRoutes).toEqual([
      {
        decision: "carve-out-usage",
        childThreadId: CHILD_SUBAGENT_ID,
        attribution: { kind: "subagent", subagentId: CHILD_SUBAGENT_ID },
      },
    ]);
  });

  it("a child's control-channel ask is connection-scoped on this provider, so it is never suppressed", async () => {
    const harness = buildRoutingHarness();
    const channel = await liveChannel(harness);
    channel.emitStreamFrame("control_request/hook_callback", {
      subagentLifecycle: {
        signal: "SubagentStart",
        subagentId: CHILD_SUBAGENT_ID,
        parentToolUseId: "toolu_parent",
      },
    });

    // Tool-approval asks ride the control channel, which is connection-level and carries no
    // thread identity, so the ask routes without one and stays answerable.
    const route = channel.emitStreamFrame("control_request/can_use_tool", {
      subagentId: CHILD_SUBAGENT_ID,
    });
    expect(route.decision).toBe("route-connection-scoped");
    // Answerable means delivered: the provider blocks on the answer, so withholding it on
    // anything but `project` would hang the child's tool call.
    expect(channel.deliveredFrameKinds).toContain("control_request/can_use_tool");
  });

  it("connection-scoped telemetry reaches the normalize consumer rather than being withheld", async () => {
    const harness = buildRoutingHarness();
    const channel = await liveChannel(harness);

    // Neither frame names a thread and neither is `project`; they are the session's rate-limit
    // and retry telemetry, and withholding them would hide that the provider is throttling.
    const rateLimitRoute = channel.emitStreamFrame("system/rate_limit_event");
    const retryRoute = channel.emitStreamFrame("system/api_retry");

    expect(rateLimitRoute.decision).toBe("route-connection-scoped");
    expect(retryRoute.decision).toBe("route-connection-scoped");
    expect(channel.deliveredFrameKinds).toStrictEqual([
      "system/rate_limit_event",
      "system/api_retry",
    ]);
  });

  it("PREDECESSOR frames route for the whole in-flight rewind, and quarantine once the fork lands", async () => {
    const harness = buildRoutingHarness();
    const predecessorChannel = await liveChannel(harness);
    let releaseRewind = (): void => undefined;
    harness.transport.establishmentGate = new Promise<void>((resolve) => {
      releaseRewind = resolve;
    });
    harness.transport.announcedForkedProviderSessionId = "forked-provider-session";

    const rollback = harness.lifecycle.forkConversation({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
      position: 4,
    });
    // The claim is written synchronously, but the tick makes the ordering an assertion of the
    // test, not of the implementation's call shape.
    await Promise.resolve();

    // The predecessor's process keeps emitting for the whole multi-second fork; quarantining
    // these would hole the transcript of a session that continues if the fork fails.
    const duringRewind = predecessorChannel.emitStreamFrame(
      "system/task_progress",
      usageObservation(30),
    );
    expect(duringRewind.decision).toBe("project");
    expect(harness.meteredUsage[0]?.delta.axisDeltas.input).toBe(30);

    releaseRewind();
    expect((await rollback).status).toBe("applied");

    // Once the successor is installed the predecessor is no longer the bound channel, so an
    // undead process emitting into a slot it no longer holds is refused, not projected.
    const afterRewind = predecessorChannel.emitStreamFrame(
      "system/task_progress",
      usageObservation(60),
    );
    expect(afterRewind.decision).toBe("quarantined");
    expect(harness.meteredUsage).toHaveLength(1);
  });

  it("a rewind that FAILS leaves the predecessor routing, with no hole for the attempt", async () => {
    const harness = buildRoutingHarness();
    const predecessorChannel = await liveChannel(harness);
    let releaseRewind = (): void => undefined;
    harness.transport.establishmentGate = new Promise<void>((resolve) => {
      releaseRewind = resolve;
    });
    harness.transport.rewindFailure = new Error("the provider refused the rewind");

    const rollback = harness.lifecycle.forkConversation({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
      position: 4,
    });
    await Promise.resolve();
    predecessorChannel.emitStreamFrame("system/task_progress", usageObservation(30));

    releaseRewind();
    expect((await rollback).status).toBe("degraded");
    predecessorChannel.emitStreamFrame("system/task_progress", usageObservation(75));

    // Non-destructive on failure covers the transcript too: the session stays running, startable
    // and un-rewound, and every frame emitted across the failed attempt was routed and metered.
    expect(harness.meteredUsage.map((entry) => entry.delta.axisDeltas.input)).toEqual([30, 45]);
  });

  it("a frame arriving on a channel the session no longer holds is quarantined, never metered", async () => {
    const harness = buildRoutingHarness();
    const staleChannel = await liveChannel(harness);
    await harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID });

    // The driver holds no kill, so a disowned process can still emit.
    const route = staleChannel.emitStreamFrame("system/task_progress", usageObservation(9_999));

    expect(route.decision).toBe("quarantined");
    expect(harness.meteredUsage).toStrictEqual([]);
    expect(staleChannel.deliveredFrameKinds).toStrictEqual([]);
  });

  it("a resume with NO prior-emitted reader bound records the overstatement rather than hiding it", async () => {
    const harness = buildRoutingHarness();
    await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
      executionPosture: SANDBOXED_POSTURE,
    });

    // Unbound reader: the daemon's emitted sum could not be rebuilt, so the base is zero and the
    // first reading re-meters the pre-resume total.
    expect(harness.diagnostics.recentRecordsOfKind("usage_resume_base_unavailable")).toHaveLength(
      1,
    );
  });

  it("a reader that THROWS is recorded rather than escaping the adoption window", async () => {
    const harness = buildRoutingHarness({
      readPriorEmittedUsage: () => {
        throw new Error("the event store was unreachable");
      },
    });

    const result = await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
      executionPosture: SANDBOXED_POSTURE,
    });

    // The throw happens inside the adoption invariant's window, where escaping would orphan a
    // resumed running process. Over-metering is recoverable from the record; an orphan is not.
    expect(result.status).toBe("resumed");
    expect(harness.diagnostics.recentRecordsOfKind("usage_resume_base_unavailable")).toHaveLength(
      1,
    );
  });

  it("a REWIND bases on the PREDECESSOR's prior-emitted sum, not the fork's brand-new id", async () => {
    // Keyed by thread id on purpose: a reader answering the same sum for every id would pass
    // even with the successor's id keying the lookup. Only the predecessor has a sum.
    const harness = buildRoutingHarness({
      readPriorEmittedUsage: (_sessionId, threadId) =>
        threadId === TEST_PINNED_PROVIDER_SESSION_ID ? { input: 500 } : undefined,
    });
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.transport.announcedForkedProviderSessionId = "forked-provider-session";

    const rollback = await harness.lifecycle.forkConversation({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
      position: 4,
    });
    expect(rollback.status).toBe("applied");

    const forkedChannel = harness.transport.spawnedChannels[1];
    if (forkedChannel === undefined) {
      throw new Error("unreachable: the rewind must have adopted a forked channel");
    }
    forkedChannel.emitStreamFrame("system/task_progress", usageObservation(520));

    // 20, not 520: pre-rewind spend already emitted is not charged twice, and the routine rewind
    // path records nothing (the resume-base diagnostic is for a reader that could not answer).
    expect(harness.meteredUsage[0]?.delta.axisDeltas.input).toBe(20);
    expect(harness.diagnostics.recentRecordsOfKind("usage_resume_base_unavailable")).toStrictEqual(
      [],
    );
  });

  it("a resume WITH a prior-emitted sum meters only the excess over it", async () => {
    const harness = buildRoutingHarness({ readPriorEmittedUsage: () => ({ input: 500 }) });
    await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
      executionPosture: SANDBOXED_POSTURE,
    });
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("unreachable: the resume must have adopted a channel");
    }

    channel.emitStreamFrame("system/task_progress", usageObservation(520));

    expect(harness.diagnostics.recentRecordsOfKind("usage_resume_base_unavailable")).toHaveLength(
      0,
    );
    expect(harness.meteredUsage[0]?.delta.axisDeltas.input).toBe(20);
  });
});

describe("ClaudeSessionLifecycle provider-bound text path", () => {
  async function startRunWith(
    harness: LifecycleHarness,
    openingText: string,
  ): Promise<FakeClaudeSessionTransport["spawnedChannels"][number]> {
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText,
    });
    await harness.lifecycle.startRun(buildStartRunParams());
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("expected the harness to have spawned a channel");
    }
    return channel;
  }

  it("neutralizes command-shaped run-opening text on the wire only", async () => {
    const harness = buildHarness();
    const channel = await startRunWith(harness, "/status please");

    // The wire bytes carry the sentinel; the author's bytes do not.
    expect(channel.sentWireTexts).toStrictEqual(["\n/status please"]);
    expect(channel.sentAuthoredTexts).toStrictEqual(["/status please"]);
  });

  it("neutralizes queue-admitted content too, which re-enters through the same path", async () => {
    // Run-opening and queue-admitted content both reach the provider through `startRun`; a second
    // run on the live session is the shape a queue admission takes.
    const harness = buildHarness();
    const channel = await startRunWith(harness, "first turn");
    channel.terminalFrameBody = CLAUDE_ORDINARY_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");

    harness.runDispatchResolver.dispatchByRunId.set(TEST_SECOND_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "/status please",
    });
    await harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID });

    expect(channel.sentWireTexts).toStrictEqual(["first turn", "\n/status please"]);
    expect(channel.sentAuthoredTexts).toStrictEqual(["first turn", "/status please"]);
  });

  it("leaves the daemon's own record of the text untouched", async () => {
    // The dispatch record is the daemon-owned value the persisted event row, the replayed
    // timeline and any rollback target are built from, and the driver never writes back to it.
    const harness = buildHarness();
    const channel = await startRunWith(harness, "/status please");

    const dispatch = harness.runDispatchResolver.dispatchByRunId.get(TEST_RUN_ID);
    expect(dispatch?.openingText).toBe("/status please");
    expect(dispatch?.openingText).toBe(channel.sentAuthoredTexts[0]);
    expect(channel.sentWireTexts[0]).not.toBe(dispatch?.openingText);
  });

  it("ignores an exempt origin smuggled onto the dispatch record", async () => {
    // `driver_command` both delivers command-shaped bytes verbatim and excuses the turn from the
    // tripwire. A dispatch record that could carry it would let the user's words run as a
    // provider command with the swallow reported as a completed turn. The cast is needed because
    // TypeScript already refuses it.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "/compact",
      frameOrigin: "driver_command",
    } as ClaudeRunDispatch);
    await harness.lifecycle.startRun(buildStartRunParams());
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("expected the harness to have spawned a channel");
    }

    // Neutralized on the wire and still watched: the zero-turn terminal fails the run under the
    // supplied origin rather than passing as an exempt frame.
    expect(channel.sentWireTexts).toStrictEqual(["\n/compact"]);
    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");

    expect(
      harness.textNeutralizationFailures.map((failure) => failure.providerFailureDetail),
    ).toStrictEqual(["driver.text_neutralization_failed origin=human_text"]);
  });

  it("fails the run with the exact composed detail and disposes its binding when the turn is swallowed", async () => {
    const harness = buildHarness();
    const channel = await startRunWith(harness, "/status please");

    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");

    expect(harness.textNeutralizationFailures).toStrictEqual([
      {
        sessionId: TEST_SESSION_ID,
        runId: TEST_RUN_ID,
        providerFailureDetail: "driver.text_neutralization_failed origin=human_text",
      },
    ]);
    // Refused, not `undefined`: a quiet `undefined` reads as "no channel yet" and invites a retry
    // into the same swallow.
    expect(() => harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toThrow(
      TextNeutralizationRefusedError,
    );
  });

  it("refuses a later run on the SESSION a trip disposed, not only the run that was on it", async () => {
    // `startRun` resolves a session, so a surviving slot would hand the next run back to the
    // process that swallowed the text. The refusal must be checked before the live-session
    // lookup: the trip also disposes the channel, and that lookup would answer `no_live_session`,
    // which reads as a race and invites a retry into the same swallow.
    const harness = buildHarness();
    const channel = await startRunWith(harness, "/status please");

    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");
    await drainMicrotasks();

    harness.runDispatchResolver.dispatchByRunId.set(TEST_SECOND_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "carry on",
    });
    await expect(
      harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID }),
    ).rejects.toThrow(TextNeutralizationRefusedError);
    // Nothing reached the provider.
    expect(channel.sentWireTexts).toStrictEqual(["\n/status please"]);
  });

  it("still reports a trip on a run that was interrupted before its terminal arrived", async () => {
    // The interrupt goes through the channel alone, touching neither the route map nor the slot,
    // so the terminal that follows still has a run to report against.
    const harness = buildHarness();
    const channel = await startRunWith(harness, "/status please");

    await harness.lifecycle.interruptRun({ runId: TEST_RUN_ID, reason: "user_stop" });
    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");
    await drainMicrotasks();

    expect(harness.textNeutralizationFailures).toStrictEqual([
      {
        sessionId: TEST_SESSION_ID,
        runId: TEST_RUN_ID,
        providerFailureDetail: "driver.text_neutralization_failed origin=human_text",
      },
    ]);
    // The next run must not resolve the same slot and dispatch into the swallowing process.
    harness.runDispatchResolver.dispatchByRunId.set(TEST_SECOND_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "carry on",
    });
    await expect(
      harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID }),
    ).rejects.toThrow(TextNeutralizationRefusedError);
  });

  it("refuses a second session-bound start pre-write, leaving no route its interrupt could aim", async () => {
    // The serialization guard fires at one pending frame, so `startRun` never fills the watch
    // budget. The refusal is pre-write, nothing already written is forgotten, and no run route
    // survives it. The route matters: this provider's interrupt is channel-scoped and carries no
    // run identity, so a surviving route would aim the refused run's interrupt at the older turn
    // running on the session.
    const harness = buildHarness();
    const channel = await startRunWith(harness, "first turn");
    harness.runDispatchResolver.dispatchByRunId.set(TEST_SECOND_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "one more",
    });

    await expect(
      harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID }),
    ).rejects.toMatchObject({
      code: "driver.unavailable",
      fields: { reason: "session_turn_in_flight" },
    });

    // Nothing reached the provider on the refused path.
    expect(channel.sentWireTexts).toHaveLength(1);
    expect(harness.lifecycle.findChannelForRun(TEST_SECOND_RUN_ID)).toBeUndefined();
    await expect(
      harness.lifecycle.interruptRun({ runId: TEST_SECOND_RUN_ID, reason: "user_stop" }),
    ).rejects.toThrow(ClaudeSessionUnavailableError);
    // Asserted on the control-request log, since a refusal raised after the request went out
    // would satisfy the rejection and still have interrupted another turn.
    expect(channel.controlRequests).toStrictEqual([]);

    // One terminal ends one turn, so the refused run never contends for its evidence.
    channel.terminalFrameBody = CLAUDE_ORDINARY_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");
    expect(harness.textNeutralizationFailures).toStrictEqual([]);
    expect(() => harness.lifecycle.findChannelForRun(TEST_RUN_ID)).not.toThrow();
  });

  it("tears the condemned channel down, so the promised recovery is a fresh spawn", async () => {
    // The refusal alone would leave the process running. The teardown is detached, since it runs
    // inside the channel's terminal listener, so it is observed after a drain.
    const harness = buildHarness();
    const channel = await startRunWith(harness, "/status please");

    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");
    await drainMicrotasks();

    expect(channel.disposals).toStrictEqual(["session_closed"]);
    // The run terminal still landed; the teardown does not replace it.
    expect(harness.textNeutralizationFailures).toHaveLength(1);
  });

  it("lets a fresh session under the same id run again after a trip", async () => {
    // The quarantine names a binding, not an identifier; refusing the id forever would refuse
    // the recovery.
    const harness = buildHarness();
    const channel = await startRunWith(harness, "/status please");
    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");
    await drainMicrotasks();

    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_SECOND_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "carry on",
    });

    await expect(
      harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID }),
    ).resolves.toBeUndefined();
  });

  it("does not fail an ordinary turn", async () => {
    // The negative control on the real driver path.
    const harness = buildHarness();
    const channel = await startRunWith(harness, "/status please");

    channel.terminalFrameBody = CLAUDE_ORDINARY_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");

    expect(harness.textNeutralizationFailures).toStrictEqual([]);
    expect(() => harness.lifecycle.findChannelForRun(TEST_RUN_ID)).not.toThrow();
  });

  /**
   * Arranges a live session whose next write fails with the given delivery, and returns the
   * channel. The delivery is always explicit because the cases test which arm it lands on.
   */
  async function arrangeFailingWrite(
    harness: LifecycleHarness,
    delivery: "unsent" | "indeterminate",
    openingText = "/status please",
  ): Promise<FakeClaudeSessionTransport["spawnedChannels"][number]> {
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("expected the harness to have spawned a channel");
    }
    channel.sendUserTextFailure = new Error("the provider stream is closed");
    channel.sendUserTextDelivery = delivery;
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText,
    });
    await expect(harness.lifecycle.startRun(buildStartRunParams())).rejects.toThrow(
      "the provider stream is closed",
    );
    return channel;
  }

  it("drops a provably unsent frame, so it cannot consume a later run's turn", async () => {
    // The channel refused ahead of its write, so no turn will account for the frame. A stale
    // registration, being older, would consume the next run's evidence and fail the run whose
    // text actually reached the provider.
    const harness = buildHarness();
    const channel = await arrangeFailingWrite(harness, "unsent");
    expect(channel.sentWireTexts).toStrictEqual([]);

    channel.sendUserTextFailure = undefined;
    harness.runDispatchResolver.dispatchByRunId.set(TEST_SECOND_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "second turn",
    });
    await harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID });

    channel.terminalFrameBody = CLAUDE_ORDINARY_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");

    expect(harness.textNeutralizationFailures).toStrictEqual([]);
    expect(() => harness.lifecycle.findChannelForRun(TEST_SECOND_RUN_ID)).not.toThrow();
  });

  it("retires the route of a provably unsent run, so its interrupt cannot stop another turn", async () => {
    // This provider's interrupt is channel-scoped, so a route left bound to a run that never
    // dispatched would let its interrupt stop whatever turn is running on the live session.
    const harness = buildHarness();
    const channel = await arrangeFailingWrite(harness, "unsent");

    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeUndefined();
    await expect(
      harness.lifecycle.interruptRun({ runId: TEST_RUN_ID, reason: "user_stop" }),
    ).rejects.toThrow(ClaudeSessionUnavailableError);
    expect(channel.controlRequests).toStrictEqual([]);
  });

  it("fails a run whose bytes may have been taken and whose turn then showed no model output", async () => {
    // The channel took the bytes and then failed, so the provider may have intercepted the text
    // and answered with a zero-turn success; the rejection says nothing either way. The
    // registration is retained and the turn's own terminal rules it.
    const harness = buildHarness();
    const channel = await arrangeFailingWrite(harness, "indeterminate");

    expect(channel.isClosed).toBe(false);
    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");
    await drainMicrotasks();

    expect(harness.textNeutralizationFailures).toStrictEqual([
      {
        sessionId: TEST_SESSION_ID,
        runId: TEST_RUN_ID,
        providerFailureDetail: "driver.text_neutralization_failed origin=human_text",
      },
    ]);
    expect(() => harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toThrow(
      TextNeutralizationRefusedError,
    );
  });

  it("does not fail a run whose ambiguous write was followed by a genuine model turn", async () => {
    // Retaining an ambiguous frame is not a deferred trip: when real evidence arrives the frame
    // passes, or every recoverable write hiccup would become an outage.
    const harness = buildHarness();
    const channel = await arrangeFailingWrite(harness, "indeterminate");

    channel.terminalFrameBody = CLAUDE_ORDINARY_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");
    await drainMicrotasks();

    expect(harness.textNeutralizationFailures).toStrictEqual([]);
    expect(() => harness.lifecycle.findChannelForRun(TEST_RUN_ID)).not.toThrow();
  });

  it("rules an ambiguous write immediately when the channel can no longer deliver a terminal", async () => {
    // Retention cannot cover a channel that can never deliver a terminal, so the frame is ruled
    // fail-closed at the write, with the same disposal the settlement path performs.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("expected the harness to have spawned a channel");
    }
    channel.sendUserTextFailure = new Error("the provider stream is closed");
    channel.sendUserTextDelivery = "indeterminate";
    channel.isClosed = true;
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "/status please",
    });
    await expect(harness.lifecycle.startRun(buildStartRunParams())).rejects.toThrow(
      "the provider stream is closed",
    );
    await drainMicrotasks();

    expect(harness.textNeutralizationFailures).toStrictEqual([
      {
        sessionId: TEST_SESSION_ID,
        runId: TEST_RUN_ID,
        providerFailureDetail: "driver.text_neutralization_failed origin=human_text",
      },
    ]);
    // Both quarantine axes, and the channel torn down.
    expect(() => harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toThrow(
      TextNeutralizationRefusedError,
    );
    expect(channel.disposals).toStrictEqual(["session_closed"]);

    harness.runDispatchResolver.dispatchByRunId.set(TEST_SECOND_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "carry on",
    });
    await expect(
      harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID }),
    ).rejects.toThrow(TextNeutralizationRefusedError);
  });

  it("treats a channel that raised instead of reporting as ambiguous, never as unsent", async () => {
    // A transport that throws breaks the port's contract. A rejection makes no claim about bytes
    // and "unsent" is one, so it lands on the fail-closed arm: the frame is retained and the
    // turn rules it.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("expected the harness to have spawned a channel");
    }
    channel.sendUserTextRejection = new Error("the transport threw instead of reporting");
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "/status please",
    });
    await expect(harness.lifecycle.startRun(buildStartRunParams())).rejects.toThrow(
      "the transport threw instead of reporting",
    );

    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");
    await drainMicrotasks();

    expect(harness.textNeutralizationFailures.map((failure) => failure.runId)).toStrictEqual([
      TEST_RUN_ID,
    ]);
  });

  it("keeps the predecessor's frames correlated when a rewind's adoption fails", async () => {
    // A rewind that fails after the fork is minted restores the predecessor, which is still
    // mid-turn and owes a ruling. Dropping its correlation before the successor is adopted would
    // let the evidence-free terminal below pass as a completed turn.
    const harness = buildHarness();
    const predecessorChannel = await startRunWith(harness, "/status please");

    // The transport refuses the terminal-hook registration, the last step of the adoption window.
    harness.transport.onTurnTerminalFailure = new Error("the transport refused the terminal hook");

    const rollback = await harness.lifecycle.forkConversation({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
      position: 4,
    });

    expect(rollback.status).toBe("degraded");
    // The predecessor is the bound channel again and the fork was released, so the ruling below
    // reads the predecessor's own frame.
    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBe(predecessorChannel);
    const forkChannel = harness.transport.spawnedChannels[1];
    if (forkChannel === undefined) {
      throw new Error("expected the rewind to have spawned a fork channel");
    }
    expect(forkChannel.disposals).toStrictEqual(["establishment_failed"]);

    predecessorChannel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    predecessorChannel.emitStreamFrame("result/success");

    expect(harness.textNeutralizationFailures.map((failure) => failure.runId)).toStrictEqual([
      TEST_RUN_ID,
    ]);
    expect(() => harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toThrow(
      TextNeutralizationRefusedError,
    );
  });

  it("still disposes the binding when the failure consumer throws", async () => {
    // A throwing listener must not lose the disposal, or the swallowed turn stays reachable as
    // well as unrecorded.
    const harness = buildHarness({
      onTextNeutralizationFailure: () => {
        throw new Error("the emission pipeline is unavailable");
      },
    });
    const channel = await startRunWith(harness, "/status please");

    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    expect(() => channel.emitStreamFrame("result/success")).not.toThrow();
    expect(() => harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toThrow(
      TextNeutralizationRefusedError,
    );
  });
});

// A pending opening frame is ruled or reported on every transition that takes its binding: a
// rewind that supersedes the binding owes the run a visible failure naming why, and a
// daemon-initiated close owes none, because its initiator already has a record of it.

type PendingFrameSettlement =
  | {
      readonly kind: "run-failure";
      /** In report order — the table asserts the order, not merely the set. */
      readonly runIds: readonly RunId[];
      readonly detailContains: string;
    }
  | { readonly kind: "daemon-intent" };

interface DrivenTransitionOutcome {
  readonly threw: unknown;
}

async function captureTransition(drive: () => Promise<unknown>): Promise<DrivenTransitionOutcome> {
  return await drive().then(
    () => ({ threw: undefined }),
    (threw: unknown) => ({ threw }),
  );
}

interface PendingFrameTransitionCase {
  readonly label: string;
  readonly drive: (harness: LifecycleHarness) => Promise<DrivenTransitionOutcome>;
  readonly expected: PendingFrameSettlement;
}

const PENDING_FRAME_TRANSITIONS: readonly PendingFrameTransitionCase[] = [
  {
    label: "a rewind that supersedes the binding the frame was written on",
    drive: async (harness) =>
      await captureTransition(
        async () =>
          await harness.lifecycle.forkConversation({
            sessionId: TEST_SESSION_ID,
            bindingId: "binding-predecessor",
            position: 4,
          }),
      ),
    expected: {
      kind: "run-failure",
      runIds: [TEST_RUN_ID],
      detailContains: "was superseded by a fresh spawn",
    },
  },
  {
    label: "a daemon-initiated close",
    drive: async (harness) =>
      await captureTransition(
        async () => await harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID }),
      ),
    expected: { kind: "daemon-intent" },
  },
];

describe("ClaudeSessionLifecycle pending-frame settlement", () => {
  async function arrangePendingFrame(harness: LifecycleHarness): Promise<void> {
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "/compact the thread please",
    });
    await harness.lifecycle.startRun(buildStartRunParams());
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("unreachable: the session must have spawned a channel");
    }
    // Every row starts with the bytes on the wire and no terminal accounting for them.
    expect(channel.sentWireTexts).toHaveLength(1);
    expect(harness.textNeutralizationFailures).toStrictEqual([]);
  }

  function assertSettlement(
    harness: LifecycleHarness,
    outcome: DrivenTransitionOutcome,
    expected: PendingFrameSettlement,
  ): void {
    if (expected.kind === "run-failure") {
      expect(harness.textNeutralizationFailures.map((failure) => failure.runId)).toStrictEqual([
        ...expected.runIds,
      ]);
      for (const failure of harness.textNeutralizationFailures) {
        expect(failure.sessionId).toBe(TEST_SESSION_ID);
        expect(failure.providerFailureDetail).toContain(expected.detailContains);
      }
      return;
    }
    // daemon-intent: no driver-composed failure, and the session is gone.
    expect(harness.textNeutralizationFailures).toStrictEqual([]);
    expect(outcome.threw).toBeUndefined();
    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeUndefined();
  }

  for (const transitionCase of PENDING_FRAME_TRANSITIONS) {
    it(`settles a pending frame through ${transitionCase.expected.kind} on ${transitionCase.label}`, async () => {
      const harness = buildHarness();
      await arrangePendingFrame(harness);

      const outcome = await transitionCase.drive(harness);

      assertSettlement(harness, outcome, transitionCase.expected);
    });
  }
});

// `unsent` is the one delivery classification that is a positive claim about bytes: the
// provider saw nothing, so a re-send duplicates neither a turn nor its spend. `indeterminate`
// must never be retried.
describe("ClaudeSessionLifecycle definitely-unsent dispatch retry", () => {
  async function arrangeSession(harness: LifecycleHarness): Promise<FakeClaudeSessionChannel> {
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "please summarize the thread",
    });
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("unreachable: the session must have spawned a channel");
    }
    return channel;
  }

  it("re-attempts a definitely-unsent write and stops at the ladder's ceiling", async () => {
    const harness = buildHarness();
    const channel = await arrangeSession(harness);
    channel.sendUserTextFailure = new Error("refused before a byte left");
    channel.sendUserTextDelivery = "unsent";

    await expect(harness.lifecycle.startRun(buildStartRunParams())).rejects.toThrow();

    // The bound is the assertion: a ladder with no ceiling would spin against a channel that
    // can never be written.
    expect(channel.sendUserTextAttempts).toBe(MAX_DEFINITELY_UNSENT_DISPATCH_ATTEMPTS);
    // Nothing reached the provider on either attempt, so the re-send cannot duplicate.
    expect(channel.sentWireTexts).toStrictEqual([]);
    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeUndefined();
  });

  it("starts the run when the second attempt succeeds, writing the text ONCE", async () => {
    const harness = buildHarness();
    const channel = await arrangeSession(harness);
    channel.sendUserTextFailure = new Error("refused before a byte left");
    channel.sendUserTextDelivery = "unsent";
    // The transport recovers after the first attempt; a permanently failing write only proves
    // the retry stops.
    channel.onSendUserTextAttempt = (attemptNumber): void => {
      if (attemptNumber === 2) {
        channel.sendUserTextFailure = undefined;
      }
    };

    await harness.lifecycle.startRun(buildStartRunParams());

    expect(channel.sendUserTextAttempts).toBe(2);
    // One frame on the wire, not two: the first attempt's bytes never left.
    expect(channel.sentWireTexts).toStrictEqual(["please summarize the thread"]);
    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeDefined();
  });

  it("never re-attempts an INDETERMINATE write", async () => {
    const harness = buildHarness();
    const channel = await arrangeSession(harness);
    channel.sendUserTextFailure = new Error("the write rejected mid-line");
    channel.sendUserTextDelivery = "indeterminate";

    await expect(harness.lifecycle.startRun(buildStartRunParams())).rejects.toThrow();

    // The bytes may have reached a child that read the newline, so a re-send risks a
    // duplicate turn and duplicate spend against a turn nobody can see.
    expect(channel.sendUserTextAttempts).toBe(1);
    expect(channel.sentWireTexts).toStrictEqual([]);
  });

  it("never re-attempts a write the transport REJECTED instead of reporting", async () => {
    const harness = buildHarness();
    const channel = await arrangeSession(harness);
    // A transport that breaks the port contract by rejecting. A rejection makes no claim about
    // bytes, and `unsent` is one, so the failure must take the fail-closed arm, not the retry.
    channel.sendUserTextRejection = new Error("transport rejected the write");

    await expect(harness.lifecycle.startRun(buildStartRunParams())).rejects.toThrow();

    expect(channel.sendUserTextAttempts).toBe(1);
  });
});

describe("ClaudeSessionLifecycle rewind supersede", () => {
  async function arrangePendingFrameAcrossRewind(harness: LifecycleHarness): Promise<void> {
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "/compact the thread please",
    });
    await harness.lifecycle.startRun(buildStartRunParams());
    await harness.lifecycle.forkConversation({
      sessionId: TEST_SESSION_ID,
      bindingId: "binding-predecessor",
      position: 4,
    });
  }

  it("does NOT condemn the superseded run, whose future work belongs to the fresh binding", async () => {
    const harness = buildHarness();
    await arrangePendingFrameAcrossRewind(harness);

    // A quarantine condemns a binding, and the superseded one is already gone; refusing the
    // run would remove its interrupt and intervention controls for a process nobody can reach.
    expect(() => harness.lifecycle.findChannelForRun(TEST_RUN_ID)).not.toThrow();
  });

  it("leaves the rewound session startable, so the report is a run failure and not a session one", async () => {
    const harness = buildHarness();
    await arrangePendingFrameAcrossRewind(harness);

    harness.runDispatchResolver.dispatchByRunId.set(TEST_SECOND_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "carry on from the fork",
    });
    await harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID });

    const forkedChannel = harness.transport.spawnedChannels[1];
    expect(harness.lifecycle.findChannelForRun(TEST_SECOND_RUN_ID)).toBe(forkedChannel);
  });

  it("reports NOTHING for a rewind of a session holding no pending frame", async () => {
    // Negative control: an ordinary rewind of an idle session must stay silent.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());

    await harness.lifecycle.forkConversation({
      sessionId: TEST_SESSION_ID,
      bindingId: "binding-predecessor",
      position: 4,
    });

    expect(harness.textNeutralizationFailures).toStrictEqual([]);
  });

  it("reports NOTHING for a rewind whose pending frame the turn's own terminal already settled", async () => {
    // A frame the ordinary path already ruled on is not owed a supersede failure as well.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "/compact the thread please",
    });
    await harness.lifecycle.startRun(buildStartRunParams());
    harness.transport.spawnedChannels[0]?.emitStreamFrame("result/success");

    await harness.lifecycle.forkConversation({
      sessionId: TEST_SESSION_ID,
      bindingId: "binding-predecessor",
      position: 4,
    });

    expect(harness.textNeutralizationFailures).toStrictEqual([]);
  });
});

/**
 * A hand-fired stand-in for the compaction wait timer. It records arms and cancels so a test
 * can tell a wait that was never armed from one that was armed and canceled.
 */
interface ManualCompactionScheduler {
  readonly schedule: CompactionWaitScheduler;
  fireAll(): void;
  armedCount(): number;
  armedDelays(): number[];
  canceledCount(): number;
}

function makeManualCompactionScheduler(): ManualCompactionScheduler {
  const armed: Array<{ readonly callback: () => void; readonly delayMs: number }> = [];
  let canceledCount = 0;
  return {
    schedule: (callback, delayMs) => {
      armed.push({ callback, delayMs });
      return (): void => {
        canceledCount += 1;
      };
    },
    fireAll: () => {
      for (const entry of [...armed]) {
        entry.callback();
      }
    },
    armedCount: () => armed.length,
    armedDelays: () => armed.map((entry) => entry.delayMs),
    canceledCount: () => canceledCount,
  };
}

// Shape of a measured live `system/init` frame: `slash_commands` and `skills` hold bare names,
// and `terminal_slash_commands` holds the names that run only in the provider's terminal UI.
function buildHandshake(
  overrides: Partial<ClaudeHandshakeDeclaration> = {},
): ClaudeHandshakeDeclaration {
  return {
    slashCommands: ["compact", "autocompact", "clear"],
    skills: ["pdf-processing"],
    terminalSlashCommands: ["doctor", "color"],
    fastModeState: "off",
    fastModeDisabledReason: "sdk_opt_in_required",
    ...overrides,
  };
}

// The daemon resolves a run onto a session; the driver never invents one. Tests that need a
// live turn arm this first.
function armRunDispatch(harness: LifecycleHarness, runId: RunId): void {
  harness.runDispatchResolver.dispatchByRunId.set(runId, {
    sessionId: TEST_SESSION_ID,
    openingText: "keep going",
  });
}

/**
 * Drains the microtask queue by yielding to the macrotask queue once. A counted
 * `await Promise.resolve()` would pin the tests to an exact number of microtask hops.
 */
async function drainMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("ClaudeSessionLifecycle.compactContext — the two substitute guards", () => {
  it("refuses `command_absent` and SENDS NOTHING when the provider does not enumerate the command", async () => {
    // The dispatched frame is tripwire-exempt, so discovering the command's absence after
    // writing would put provider-interpreted text on the wire with nothing watching it.
    const scheduler = makeManualCompactionScheduler();
    const harness = buildHarness({ compactionWaitScheduler: scheduler.schedule });
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    channel?.emitStreamFrame("system/init", {
      handshake: buildHandshake({ slashCommands: ["clear", "cost"] }),
    });

    const result = await harness.lifecycle.compactContext({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });

    expect(result).toStrictEqual({ status: "refused", reason: "command_absent" });
    expect(channel?.sentWireTexts).toStrictEqual([]);
    expect(channel?.outboundCallCount).toBe(0);
    // Nothing was armed: an armed wait would burn the declared bound for a dispatch that
    // never happened.
    expect(scheduler.armedCount()).toBe(0);
  });

  it("refuses `command_absent` before the handshake has been observed at all", async () => {
    // "Not yet known" fails closed: the driver cannot prove the command exists, so it sends
    // nothing.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());

    const result = await harness.lifecycle.compactContext({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });

    expect(result).toStrictEqual({ status: "refused", reason: "command_absent" });
    expect(harness.transport.spawnedChannels[0]?.sentWireTexts).toStrictEqual([]);
  });

  it("refuses `command_absent` when the held enumeration was read under a DIFFERENT provider process", async () => {
    // A rewind forks a new provider process behind the same session id, and the fork publishes
    // its own handshake. Answering from the dead process's enumeration could dispatch a command
    // the live binding lacks. Two mechanisms produce the refusal (`#registerLiveSession` clears
    // the record when it adopts the fork; the read-side stamp refuses a stale one), so the test
    // pins the outcome only.
    let issuedProviderSessionIds = 0;
    const harness = buildHarness({
      mintProviderSessionId: (): string => {
        issuedProviderSessionIds += 1;
        return `provider-session-${issuedProviderSessionIds}`;
      },
    });
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: buildHandshake(),
    });
    // The fork announces its own id by default, so the held stamp no longer matches.
    await harness.lifecycle.forkConversation({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
      position: 4,
    });

    const result = await harness.lifecycle.compactContext({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });

    expect(result).toStrictEqual({ status: "refused", reason: "command_absent" });
    expect(harness.transport.spawnedChannels[1]?.sentWireTexts).toStrictEqual([]);
  });

  it("refuses a handshake a RETIRED channel publishes after its successor is already live", async () => {
    // A retired channel can still deliver a `system/init` after its successor is live. Such a
    // frame must install nothing (no palette entry, no dispatchable name), so a read is never
    // answered from a connection the caller is not talking to. `#isChannelCurrentlyBound`
    // refuses the frame before the declaration tap runs, and the read-side stamp would refuse
    // it again; the test pins the outcome, not which guard produced it.
    let issuedProviderSessionIds = 0;
    const harness = buildHarness({
      mintProviderSessionId: (): string => {
        issuedProviderSessionIds += 1;
        return `provider-session-${issuedProviderSessionIds}`;
      },
    });
    await harness.lifecycle.createSession(buildCreateSessionParams());
    await harness.lifecycle.forkConversation({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
      position: 4,
    });

    // The retired channel speaks last, stamped with an id the live session no longer has.
    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: buildHandshake(),
    });

    await expect(
      harness.lifecycle.compactContext({
        sessionId: TEST_SESSION_ID,
        bindingId: TEST_BINDING_ID,
      }),
    ).resolves.toStrictEqual({ status: "refused", reason: "command_absent" });
    expect(harness.transport.spawnedChannels[1]?.sentWireTexts).toStrictEqual([]);
    expect(
      (
        await harness.lifecycle.listProviderCommands({
          sessionId: TEST_SESSION_ID,
          bindingId: TEST_BINDING_ID,
        })
      ).bindings[0]?.entries,
    ).toStrictEqual([]);
  });

  it("sends a tripwire-exempt `driver_command` frame and does NOT settle until the typed evidence arrives", async () => {
    // The command frame is never answered, so settling on the write would report a compaction
    // that may never happen.
    const scheduler = makeManualCompactionScheduler();
    const harness = buildHarness({ compactionWaitScheduler: scheduler.schedule });
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    channel?.emitStreamFrame("system/init", { handshake: buildHandshake() });

    let settled: unknown = undefined;
    const pending = harness.lifecycle
      .compactContext({ sessionId: TEST_SESSION_ID, bindingId: TEST_BINDING_ID })
      .then((result) => {
        settled = result;
      });
    await drainMicrotasks();

    // The wire text carries the slash the enumeration omits.
    expect(channel?.sentWireTexts).toStrictEqual(["/compact"]);
    // Tripwire-exempt, which is why the presence check before dispatch matters.
    expect(channel?.sentTextFrames[0]?.tripwireExempt).toBe(true);
    // The wait is armed at the declared bound.
    expect(scheduler.armedDelays()).toStrictEqual([CLAUDE_COMPACTION_WAIT_MS]);
    // Still unsettled: the provider accepted the frame and said nothing.
    expect(settled).toBeUndefined();

    channel?.emitStreamFrame("system/compact_boundary", {
      compactionBoundary: { boundaryPosition: 41 },
    });
    await pending;
    expect(settled).toStrictEqual({ status: "applied", boundaryPosition: 41 });
  });

  it("does not block a subsequent run — the command frame is never registered with the tripwire", async () => {
    // `startRun` refuses a run while the scope holds a pending frame, so registering the
    // compaction frame would let one compaction block every later run on the session.
    const scheduler = makeManualCompactionScheduler();
    const harness = buildHarness({ compactionWaitScheduler: scheduler.schedule });
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    channel?.emitStreamFrame("system/init", { handshake: buildHandshake() });
    armRunDispatch(harness, TEST_RUN_ID);
    void harness.lifecycle.compactContext({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });
    await drainMicrotasks();

    await expect(harness.lifecycle.startRun(buildStartRunParams())).resolves.toBeUndefined();
  });

  it("carries `boundaryPosition: null` when the provider's frame names no position", async () => {
    const scheduler = makeManualCompactionScheduler();
    const harness = buildHarness({ compactionWaitScheduler: scheduler.schedule });
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    channel?.emitStreamFrame("system/init", { handshake: buildHandshake() });

    const pending = harness.lifecycle.compactContext({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });
    await drainMicrotasks();
    channel?.emitStreamFrame("system/compact_boundary", {
      compactionBoundary: { boundaryPosition: null },
    });

    // A positive statement that the frame named no position, not an absence of evidence.
    await expect(pending).resolves.toStrictEqual({ status: "applied", boundaryPosition: null });
  });

  it("settles `wait_expired` on the bound AND still hands a LATE boundary frame off to the routing band", async () => {
    // Bounding the operation never bounds the boundary's record: a late compaction frame
    // still travels its ordinary route and still normalizes.
    const scheduler = makeManualCompactionScheduler();
    const observedRoutes: string[] = [];
    const harness = buildHarness({
      compactionWaitScheduler: scheduler.schedule,
      onReleasedFrameRoute: undefined,
    });
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    channel?.emitStreamFrame("system/init", { handshake: buildHandshake() });

    const pending = harness.lifecycle.compactContext({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });
    await drainMicrotasks();
    scheduler.fireAll();

    await expect(pending).resolves.toStrictEqual({ status: "failed", reason: "wait_expired" });
    const records = harness.diagnostics.recentRecordsOfKind("compaction_wait_terminal");
    expect(records).toHaveLength(1);
    expect(records[0]?.details).toStrictEqual({
      sessionId: TEST_SESSION_ID,
      terminal: "wait_expired",
    });

    // The boundary arrives after the operation gave up and is still routed; the tap sits
    // beside the hand-off, never in place of it.
    const lateRoute = channel?.emitStreamFrame("system/compact_boundary", {
      compactionBoundary: { boundaryPosition: 88 },
    });
    observedRoutes.push(lateRoute?.decision ?? "none");
    expect(observedRoutes).toStrictEqual(["project"]);
    // Nothing is waiting, so there is no second diagnostic.
    expect(harness.diagnostics.recentRecordsOfKind("compaction_wait_terminal")).toHaveLength(1);
  });

  it("settles `binding_lost` IMMEDIATELY when the session closes mid-wait, without the bound elapsing", async () => {
    // Driven through real disposal with a timer that never fires: a binding lost at t=0 settles
    // at t=0, which a poller could not do.
    const scheduler = makeManualCompactionScheduler();
    const harness = buildHarness({ compactionWaitScheduler: scheduler.schedule });
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    channel?.emitStreamFrame("system/init", { handshake: buildHandshake() });

    const pending = harness.lifecycle.compactContext({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });
    await drainMicrotasks();
    await harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID });

    await expect(pending).resolves.toStrictEqual({ status: "failed", reason: "binding_lost" });
    expect(scheduler.armedCount()).toBe(1);
    expect(scheduler.canceledCount()).toBe(1);
    const records = harness.diagnostics.recentRecordsOfKind("compaction_wait_terminal");
    expect(records).toHaveLength(1);
    expect(records[0]?.details).toStrictEqual({
      sessionId: TEST_SESSION_ID,
      terminal: "binding_lost",
    });
  });

  it("answers `provider_error` when the dispatch write fails, on either delivery — and WITHDRAWS its wait", async () => {
    for (const delivery of ["unsent", "indeterminate"] as const) {
      const scheduler = makeManualCompactionScheduler();
      const harness = buildHarness({ compactionWaitScheduler: scheduler.schedule });
      await harness.lifecycle.createSession(buildCreateSessionParams());
      const channel = harness.transport.spawnedChannels[0];
      channel?.emitStreamFrame("system/init", { handshake: buildHandshake() });
      if (channel !== undefined) {
        channel.sendUserTextFailure = new Error("stdin closed");
        channel.sendUserTextDelivery = delivery;
      }

      await expect(
        harness.lifecycle.compactContext({
          sessionId: TEST_SESSION_ID,
          bindingId: TEST_BINDING_ID,
        }),
      ).resolves.toStrictEqual({ status: "failed", reason: "provider_error" });

      // The wait is armed before the write, which closes the race with a provider fast enough
      // to compact in between, and withdrawn when the write fails so no timer outlives its
      // caller.
      expect(scheduler.armedCount()).toBe(1);
      expect(scheduler.canceledCount()).toBe(1);

      // The diagnostic carries the delivery classification the result cannot: both deliveries
      // answer `provider_error`, and only this record separates "never reached the provider"
      // from "may have applied, acknowledgement lost".
      const written = harness.diagnostics.recentRecordsOfKind("compaction_wait_terminal");
      expect(written).toHaveLength(1);
      expect(written[0]?.details).toStrictEqual({
        sessionId: TEST_SESSION_ID,
        terminal: "provider_error",
        delivery,
      });
      expect(written[0]?.dispositionReason).toBe("Error: stdin closed");

      // The withdrawal is total: this double's canceler does not stop its timer, so firing the
      // bound exercises a host whose clear races the fire. No second record appears.
      scheduler.fireAll();
      await drainMicrotasks();
      expect(harness.diagnostics.recentRecordsOfKind("compaction_wait_terminal")).toHaveLength(1);
    }
  });

  it("withdraws only its OWN wait — a concurrent caller still settles on the evidence", async () => {
    // Settlement is per key (one provider compaction) but withdrawal is per waiter: a caller
    // whose write failed must not settle another user whose compaction is still running.
    const scheduler = makeManualCompactionScheduler();
    const harness = buildHarness({ compactionWaitScheduler: scheduler.schedule });
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    channel?.emitStreamFrame("system/init", { handshake: buildHandshake() });

    const surviving = harness.lifecycle.compactContext({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });
    await drainMicrotasks();

    // The second caller's write fails while the first is still waiting on evidence.
    if (channel !== undefined) {
      channel.sendUserTextFailure = new Error("stdin closed");
      channel.sendUserTextDelivery = "unsent";
    }
    await expect(
      harness.lifecycle.compactContext({
        sessionId: TEST_SESSION_ID,
        bindingId: TEST_BINDING_ID,
      }),
    ).resolves.toStrictEqual({ status: "failed", reason: "provider_error" });

    // Two waits armed, one withdrawn; a withdrawal that took the whole key would cancel both
    // and settle the survivor on the other caller's write failure.
    expect(scheduler.armedCount()).toBe(2);
    expect(scheduler.canceledCount()).toBe(1);

    channel?.emitStreamFrame("system/compact_boundary", {
      compactionBoundary: { boundaryPosition: 12 },
    });
    await expect(surviving).resolves.toStrictEqual({ status: "applied", boundaryPosition: 12 });
  });

  it("withdraws its wait when the armed span THROWS, and lets the throw propagate", async () => {
    // Composing the frame mints a correlation value through an injected dependency. A minter
    // that throws must not leave an armed wait behind for a caller that has already unwound.
    const scheduler = makeManualCompactionScheduler();
    let mintShouldThrow = false;
    const harness = buildHarness({
      compactionWaitScheduler: scheduler.schedule,
      mintOutboundFrameCorrelationId: (): string => {
        if (mintShouldThrow) {
          throw new Error("correlation minting failed");
        }
        return "correlation-ok";
      },
    });
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    channel?.emitStreamFrame("system/init", { handshake: buildHandshake() });

    mintShouldThrow = true;
    // The throw propagates: `failed` would claim something was sent, and the refusal arm is
    // closed at `command_absent` / `not_permitted`.
    await expect(
      harness.lifecycle.compactContext({
        sessionId: TEST_SESSION_ID,
        bindingId: TEST_BINDING_ID,
      }),
    ).rejects.toThrow("correlation minting failed");

    expect(scheduler.armedCount()).toBe(1);
    expect(scheduler.canceledCount()).toBe(1);

    // As above, the double's canceler does not stop its timer, so firing the bound exercises a
    // host whose clear races the fire. No waiter remains, so no terminal diagnostic appears.
    scheduler.fireAll();
    await drainMicrotasks();
    expect(harness.diagnostics.recentRecordsOfKind("compaction_wait_terminal")).toStrictEqual([]);
  });

  it("throws rather than inventing a result arm when no live session holds the id", async () => {
    // `failed` claims something was sent and the refusal arm is closed at
    // `command_absent` / `not_permitted`; neither describes a missing session.
    const harness = buildHarness();

    await expect(
      harness.lifecycle.compactContext({
        sessionId: TEST_SESSION_ID,
        bindingId: TEST_BINDING_ID,
      }),
    ).rejects.toBeInstanceOf(ClaudeSessionUnavailableError);
  });

  it("never borrows another session's enumeration to satisfy the presence guard", async () => {
    // The held declaration answers only for the provider process it was read from, so a
    // session whose own handshake never published `compact` refuses even while a sibling
    // session's enumeration carries it.
    const otherSessionId = "session-peer" as SessionId;
    const harness = buildHarness({
      mintProviderSessionId: (() => {
        let issued = 0;
        return (): string => {
          issued += 1;
          return `provider-session-${issued}`;
        };
      })(),
    });
    await harness.lifecycle.createSession(buildCreateSessionParams());
    await harness.lifecycle.createSession({
      ...buildCreateSessionParams(),
      sessionId: otherSessionId,
    });
    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: buildHandshake(),
    });
    harness.transport.spawnedChannels[1]?.emitStreamFrame("system/init", {
      handshake: buildHandshake({ slashCommands: ["clear"] }),
    });

    await expect(
      harness.lifecycle.compactContext({
        sessionId: otherSessionId,
        bindingId: TEST_BINDING_ID,
      }),
    ).resolves.toStrictEqual({ status: "refused", reason: "command_absent" });
    expect(harness.transport.spawnedChannels[1]?.sentWireTexts).toStrictEqual([]);
  });

  it("refuses when the command is published ONLY as terminal-only — the guard reads the invocable set alone", async () => {
    // The provider publishes `terminal_slash_commands` to say they are not invocable over this
    // transport. A guard that merged the sets would dispatch a frame the provider cannot act on
    // and then wait out the whole declared bound, so the guard must read the invocable set
    // alone.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    channel?.emitStreamFrame("system/init", {
      handshake: buildHandshake({
        slashCommands: ["clear", "cost"],
        skills: ["compact"],
        terminalSlashCommands: ["compact", "doctor"],
      }),
    });

    await expect(
      harness.lifecycle.compactContext({
        sessionId: TEST_SESSION_ID,
        bindingId: TEST_BINDING_ID,
      }),
    ).resolves.toStrictEqual({ status: "refused", reason: "command_absent" });
    expect(channel?.sentWireTexts).toStrictEqual([]);

    // The same name is still enumerated under its terminal scope: the guard narrows what may
    // be dispatched, never what is reported.
    const result = await harness.lifecycle.listProviderCommands({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });
    expect(result.bindings[0]?.entries.filter((entry) => entry.name === "compact")).toStrictEqual([
      {
        name: "compact",
        kind: "skill",
        binding: { driverName: "claude", providerAccountId: null },
      },
      {
        name: "compact",
        kind: "command",
        scope: "terminal",
        binding: { driverName: "claude", providerAccountId: null },
      },
    ]);
  });
});

describe("ClaudeSessionLifecycle.listProviderCommands — the three handshake sets", () => {
  it("carries commands, skills, and terminal-only commands, with names verbatim and no synthesized enablement", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: buildHandshake(),
    });

    const result = await harness.lifecycle.listProviderCommands({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });

    const group = result.bindings[0];
    expect(result.bindings).toHaveLength(1);
    expect(group?.complete).toBe(true);
    expect(group?.entries.map((entry) => [entry.name, entry.kind, entry.scope])).toStrictEqual([
      ["compact", "command", undefined],
      ["autocompact", "command", undefined],
      ["clear", "command", undefined],
      ["pdf-processing", "skill", undefined],
      // Carried, not merged or dropped: the provider publishes them separately because they
      // are not invocable over this transport.
      ["doctor", "command", "terminal"],
      ["color", "command", "terminal"],
    ]);
    for (const entry of group?.entries ?? []) {
      // Key presence, not `toBeUndefined()`: a synthesized `enabled: true` and an absent key
      // are different claims, and only the absent key is honest here.
      expect("enabled" in entry).toBe(false);
      // The provider publishes no description; forwarding `""` would fail the contract's
      // non-empty bound and assert a blank one.
      expect("description" in entry).toBe(false);
      expect(entry.name.startsWith("/")).toBe(false);
    }
    // `scope` is present only on the terminal arm, which keeps the two sets distinguishable.
    expect("scope" in (group?.entries[0] ?? {})).toBe(false);
  });

  it("DROPS an entry whose provider-published name the contract refuses, keeping every sibling", async () => {
    // A skill name is read from an operator-writable file's front matter, so the handshake
    // sets carry provider output verbatim. Each refusal shape is on a different set, so a guard
    // on only one set cannot pass.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: buildHandshake({
        slashCommands: ["clear", `leak\u0000canary`],
        skills: ["pdf-processing", "   "],
        terminalSlashCommands: ["doctor", "x".repeat(DRIVER_PROVIDER_COMMAND_NAME_MAX_LEN + 1), ""],
      }),
    });

    const result = await harness.lifecycle.listProviderCommands({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });

    // One unusable name must not empty the palette, so the drop is per entry, not per set.
    expect(result.bindings[0]?.entries.map((entry) => entry.name)).toStrictEqual([
      "clear",
      "pdf-processing",
      "doctor",
    ]);
    // `complete` marks the cap only; a refused entry is not a truncation.
    expect(result.bindings[0]?.complete).toBe(true);

    const rejected = harness.diagnostics.recentRecordsOfKind("provider_command_entry_rejected");
    expect(rejected).toHaveLength(4);
    // The record holds the failing field and the length, never the value, which is the
    // untrusted string the bound just refused.
    expect(rejected.map((record) => record.details["rejectedField"])).toStrictEqual([
      "name",
      "name",
      "name",
      "name",
    ]);
    expect(rejected[0]?.details["nameLength"]).toBe("leak\u0000canary".length);
    expect(rejected[0]?.details["entryKind"]).toBe("command");
    expect(rejected[0]?.details["entryScope"]).toBeNull();
    expect(rejected[1]?.details["entryKind"]).toBe("skill");
    expect(rejected[2]?.details["entryScope"]).toBe("terminal");
    expect(rejected[2]?.details["nameLength"]).toBe(DRIVER_PROVIDER_COMMAND_NAME_MAX_LEN + 1);
    for (const record of rejected) {
      // Nothing in the record echoes the refused name back.
      expect(JSON.stringify(record)).not.toContain("canary");
    }
  });

  it("emits exactly one entry per declared name across the three sets, deduping across none of them", async () => {
    // The same name can appear in two sets (a skill and a terminal command); deduping would
    // silently delete a published capability from the palette. Cardinality is the sum of the
    // sets, not a literal, so the claim survives fixture changes.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const declaration = buildHandshake({
      slashCommands: ["compact", "clear", "shared-name"],
      skills: ["pdf-processing", "shared-name"],
      terminalSlashCommands: ["doctor", "shared-name"],
    });
    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: declaration,
    });

    const entries = (
      await harness.lifecycle.listProviderCommands({
        sessionId: TEST_SESSION_ID,
        bindingId: TEST_BINDING_ID,
      })
    ).bindings[0]?.entries;

    expect(entries).toHaveLength(
      declaration.slashCommands.length +
        declaration.skills.length +
        declaration.terminalSlashCommands.length,
    );
    const invocableEntries = entries?.slice(0, declaration.slashCommands.length) ?? [];
    const skillEntries =
      entries?.slice(
        declaration.slashCommands.length,
        declaration.slashCommands.length + declaration.skills.length,
      ) ?? [];
    const terminalEntries = entries?.slice(-declaration.terminalSlashCommands.length) ?? [];
    expect(invocableEntries.map((entry) => entry.name)).toStrictEqual(declaration.slashCommands);
    expect(skillEntries.map((entry) => entry.name)).toStrictEqual(declaration.skills);
    expect(terminalEntries.map((entry) => entry.name)).toStrictEqual(
      declaration.terminalSlashCommands,
    );
    for (const entry of invocableEntries) {
      expect(entry.kind).toBe("command");
      // Key absence on both invocable arms: under `exactOptionalPropertyTypes` a present
      // `scope: undefined` type-checks but would read as a scope the driver failed to decide.
      expect("scope" in entry).toBe(false);
    }
    for (const entry of skillEntries) {
      expect(entry.kind).toBe("skill");
      expect("scope" in entry).toBe(false);
    }
    for (const entry of terminalEntries) {
      expect(entry.kind).toBe("command");
      expect(entry.scope).toBe("terminal");
    }
  });

  it("enumerates EMPTY with `complete: true` before the handshake has been observed", async () => {
    // `complete` marks the cap only, and no tail was dropped from an empty list. The read
    // succeeds rather than refusing, since a palette read before the first turn is answerable.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());

    const result = await harness.lifecycle.listProviderCommands({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });

    expect(result.bindings).toStrictEqual([
      {
        runId: null,
        binding: { driverName: "claude", providerAccountId: null },
        entries: [],
        complete: true,
      },
    ]);
  });

  it("throws when no live session holds the id", async () => {
    const harness = buildHarness();

    await expect(
      harness.lifecycle.listProviderCommands({
        sessionId: TEST_SESSION_ID,
        bindingId: TEST_BINDING_ID,
      }),
    ).rejects.toBeInstanceOf(ClaudeSessionUnavailableError);
  });

  it("caps the REPLY while the held enumeration stays whole — a truncated command is still dispatchable", async () => {
    // The cap trims what a client is shown, never what the driver knows, so the presence check
    // still finds a command the cap dropped from the palette.
    const scheduler = makeManualCompactionScheduler();
    const harness = buildHarness({ compactionWaitScheduler: scheduler.schedule });
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    const filler = Array.from(
      { length: DRIVER_PROVIDER_COMMAND_ENTRIES_MAX + 5 },
      (_unused, index) => `filler-${index}`,
    );
    // `compact` sits past the cap, so a driver that capped its held knowledge would refuse the
    // dispatch below.
    channel?.emitStreamFrame("system/init", {
      handshake: buildHandshake({
        slashCommands: [...filler, "compact"],
        skills: [],
        terminalSlashCommands: [],
      }),
    });

    const result = await harness.lifecycle.listProviderCommands({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });

    const group = result.bindings[0];
    expect(group?.complete).toBe(false);
    expect(group?.entries).toHaveLength(DRIVER_PROVIDER_COMMAND_ENTRIES_MAX);
    expect(group?.entries.map((entry) => entry.name)).not.toContain("compact");
    // The retained window is the leading one (`declared.slice(0, MAX)`), asserted against the
    // fixture's head so a sort, filter or tail-preferring cap is caught.
    expect(group?.entries.map((entry) => entry.name)).toStrictEqual(
      filler.slice(0, DRIVER_PROVIDER_COMMAND_ENTRIES_MAX),
    );
    const records = harness.diagnostics.recentRecordsOfKind("provider_command_entries_truncated");
    expect(records).toHaveLength(1);
    expect(records[0]?.details).toStrictEqual({
      sessionId: TEST_SESSION_ID,
      declaredEntryCount: filler.length + 1,
      admittedEntryCount: DRIVER_PROVIDER_COMMAND_ENTRIES_MAX,
    });

    // The dispatch still works.
    const pending = harness.lifecycle.compactContext({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });
    await drainMicrotasks();
    expect(channel?.sentWireTexts).toStrictEqual(["/compact"]);
    channel?.emitStreamFrame("system/compact_boundary", {
      compactionBoundary: { boundaryPosition: 3 },
    });
    await expect(pending).resolves.toStrictEqual({ status: "applied", boundaryPosition: 3 });
  });

  it("discards the held enumeration with the session rather than answering the next one from it", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: buildHandshake(),
    });
    await harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID });
    await harness.lifecycle.createSession(buildCreateSessionParams());

    const result = await harness.lifecycle.listProviderCommands({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });

    expect(result.bindings[0]?.entries).toStrictEqual([]);
  });

  it("discards the held enumeration ACROSS A RESUME, whose provider session id is UNCHANGED", async () => {
    // The read-side stamp cannot catch this replacement. Claude resumes by session id, so the
    // resumed process announces the same `providerSessionId` as its predecessor, and a held
    // declaration that survived would match the successor's stamp and be answered from. The
    // resume path therefore discards unconditionally.
    //
    // The resume's own success is asserted: a `resumeSession` beside a live or quarantined slot
    // is refused through the `failed` arm, and without the check that refusal's untouched
    // palette would read as a stale one and the test would prove nothing.
    const harness = buildHarness({ mintProviderSessionId: () => "provider-session-stable" });
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: buildHandshake(),
    });
    expect(
      (
        await harness.lifecycle.listProviderCommands({
          sessionId: TEST_SESSION_ID,
          bindingId: TEST_BINDING_ID,
        })
      ).bindings[0]?.entries.length,
    ).toBeGreaterThan(0);
    await harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID });

    const resumed = await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-stable",
    });

    expect(resumed.status).toBe("resumed");
    const afterResume = await harness.lifecycle.listProviderCommands({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });
    expect(afterResume.bindings[0]?.entries).toStrictEqual([]);
    expect(afterResume.bindings[0]?.complete).toBe(true);

    // The successor's own handshake is answered from, so this is a discard and not a permanent
    // blinding of the session.
    harness.transport.spawnedChannels.at(-1)?.emitStreamFrame("system/init", {
      handshake: buildHandshake({
        slashCommands: ["compact"],
        skills: [],
        terminalSlashCommands: [],
      }),
    });
    expect(
      (
        await harness.lifecycle.listProviderCommands({
          sessionId: TEST_SESSION_ID,
          bindingId: TEST_BINDING_ID,
        })
      ).bindings[0]?.entries.map((entry) => entry.name),
    ).toStrictEqual(["compact"]);
  });

  it("states `providerAccountId: null` for an accountless session, on the entry AND the group", async () => {
    // Stated, never synthesized. The consuming routing check treats `null` as matching nothing,
    // so a placeholder would compare equal across two accountless bindings and enforce nothing.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: buildHandshake(),
    });

    const result = await harness.lifecycle.listProviderCommands({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });

    const group = result.bindings[0];
    expect(group?.binding).toStrictEqual({ driverName: "claude", providerAccountId: null });
    expect("providerAccountId" in (group?.binding ?? {})).toBe(true);
    for (const entry of group?.entries ?? []) {
      expect(entry.binding).toStrictEqual({ driverName: "claude", providerAccountId: null });
    }
  });

  it("carries the bound account through as-is when the daemon supplies one", async () => {
    // The contrast case that keeps the `null` above meaningful.
    const harness = buildHarness({ readBoundProviderAccountId: () => "account-primary" });
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: buildHandshake(),
    });

    const result = await harness.lifecycle.listProviderCommands({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });

    expect(result.bindings[0]?.binding).toStrictEqual({
      driverName: "claude",
      providerAccountId: "account-primary",
    });
  });

  it("stamps the account the CREATE was admitted against when no registry port is bound", async () => {
    // The typed `providerAccountId` on `CreateSessionParams` is the source. Stamping `null`
    // instead would make an account-bound session's enumeration unroutable, because the routing
    // check treats `null` as matching nothing. An unbound registry port is silence, not a
    // contradiction.
    const harness = buildHarness();
    await harness.lifecycle.createSession({
      ...buildCreateSessionParams(),
      providerAccountId: "account-admitted",
    });
    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: buildHandshake(),
    });

    const result = await harness.lifecycle.listProviderCommands({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });

    expect(result.bindings[0]?.binding).toStrictEqual({
      driverName: "claude",
      providerAccountId: "account-admitted",
    });
    // Stamped once: the group's binding and every entry's come from the one resolution.
    for (const entry of result.bindings[0]?.entries ?? []) {
      expect(entry.binding).toStrictEqual({
        driverName: "claude",
        providerAccountId: "account-admitted",
      });
    }
  });

  it("stamps once when the record and the registry AGREE", async () => {
    const harness = buildHarness({ readBoundProviderAccountId: () => "account-admitted" });
    await harness.lifecycle.createSession({
      ...buildCreateSessionParams(),
      providerAccountId: "account-admitted",
    });
    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: buildHandshake(),
    });

    const result = await harness.lifecycle.listProviderCommands({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });

    expect(result.bindings[0]?.binding).toStrictEqual({
      driverName: "claude",
      providerAccountId: "account-admitted",
    });
  });

  it("REFUSES the enumeration when a STALE registry names a different account", async () => {
    // A registry that has moved on since admission would route this user's palette onto an
    // account this process never authenticated as. Neither candidate is stamped: the record's
    // would assert an identity the registry contradicts, and the registry's would launder the
    // divergence into a correct-looking binding. A refused read costs a palette, not a run.
    const harness = buildHarness({ readBoundProviderAccountId: () => "account-stale" });
    await harness.lifecycle.createSession({
      ...buildCreateSessionParams(),
      providerAccountId: "account-admitted",
    });
    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: buildHandshake(),
    });

    const refused = await harness.lifecycle
      .listProviderCommands({ sessionId: TEST_SESSION_ID, bindingId: TEST_BINDING_ID })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );

    expect(refused).toBeInstanceOf(ClaudeSessionUnavailableError);
    expect((refused as ClaudeSessionUnavailableError).fields.reason).toBe(
      "provider_account_ambiguous",
    );
    // Both ids are named, so an operator can tell which resolver is wrong.
    expect((refused as ClaudeSessionUnavailableError).message).toContain("account-admitted");
    expect((refused as ClaudeSessionUnavailableError).message).toContain("account-stale");
    // A refused read disposes nothing.
    expect(harness.transport.spawnedChannels).toHaveLength(1);
  });

  it("keeps the registry as the ONLY source when the request named no account", async () => {
    // Pins that the registry is still consulted when the request names no account, so making
    // the record primary cannot be satisfied by dropping the port.
    const harness = buildHarness({ readBoundProviderAccountId: () => "account-registry" });
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: buildHandshake(),
    });

    const result = await harness.lifecycle.listProviderCommands({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });

    expect(result.bindings[0]?.binding).toStrictEqual({
      driverName: "claude",
      providerAccountId: "account-registry",
    });
  });

  it("carries the admitted account through a REWIND rather than re-reading it", async () => {
    // A fork continues the run the daemon already admitted and `ForkConversationParams` names
    // no account, so the successor inherits the predecessor's, as it does `spawnBinding`.
    // Re-reading the registry would let a rewind re-bill a session the daemon never
    // re-admitted; the registry port is unbound so only inheritance can produce this answer.
    const harness = buildHarness();
    await harness.lifecycle.createSession({
      ...buildCreateSessionParams(),
      providerAccountId: "account-admitted",
    });

    const rewound = await harness.lifecycle.forkConversation({
      sessionId: TEST_SESSION_ID,
      bindingId: "binding-predecessor",
      position: 4,
    });
    expect(rewound.status).toBe("applied");

    harness.transport.spawnedChannels.at(-1)?.emitStreamFrame("system/init", {
      handshake: buildHandshake(),
    });
    const result = await harness.lifecycle.listProviderCommands({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });

    expect(result.bindings[0]?.binding).toStrictEqual({
      driverName: "claude",
      providerAccountId: "account-admitted",
    });
  });

  it("REFUSES a create whose typed account member is present but EMPTY", async () => {
    // An empty string is a daemon that meant to bind an account and bound nothing. Folding it
    // to `null` would hide the wiring fault; carrying it would make two bindings stamped `""`
    // compare equal in the routing check that `null` exists to make match nothing.
    const harness = buildHarness();

    const refused = await harness.lifecycle
      .createSession({ ...buildCreateSessionParams(), providerAccountId: "" })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );

    expect(refused).toBeInstanceOf(ClaudeSessionUnavailableError);
    expect((refused as ClaudeSessionUnavailableError).fields.reason).toBe(
      "provider_account_unusable",
    );
    // Refused before the spawn: no process ran under an unsettled identity.
    expect(harness.transport.spawnedChannels).toHaveLength(0);
  });

  it("captures a RESUME's typed account member into the record it stamps from", async () => {
    // A resume here is a fresh spawn onto an empty slot, so the request is the only source for
    // the record it installs.
    const harness = buildHarness();
    await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
      providerAccountId: "account-admitted",
    });
    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: buildHandshake(),
    });

    const result = await harness.lifecycle.listProviderCommands({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });

    expect(result.bindings[0]?.binding).toStrictEqual({
      driverName: "claude",
      providerAccountId: "account-admitted",
    });
  });

  it("REFUSES a resume whose typed account member is EMPTY, through the `failed` ARM", async () => {
    // Resume reports failure through the `failed` arm, never a throw; a rejection would reach a
    // caller with no arm for it.
    const harness = buildHarness();

    const result = await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
      providerAccountId: "",
    });

    expect(result.status).toBe("failed");
    expect(result.status === "failed" ? result.providerFailureDetail : "").toContain(
      "present but empty",
    );
    // Refused before the spawn, so nothing was resumed.
    expect(harness.transport.resumeRequests).toHaveLength(0);
  });

  it("answers `runId: null` when NO run holds a live turn", async () => {
    // The ordinary pre-first-turn palette read succeeds.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: buildHandshake(),
    });

    const result = await harness.lifecycle.listProviderCommands({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });

    expect(result.bindings[0]?.runId).toBeNull();
    expect("runId" in (result.bindings[0] ?? {})).toBe(true);
  });

  it("answers with THAT run when exactly one holds a live turn", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: buildHandshake(),
    });
    armRunDispatch(harness, TEST_RUN_ID);
    await harness.lifecycle.startRun(buildStartRunParams());

    const result = await harness.lifecycle.listProviderCommands({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });

    expect(result.bindings[0]?.runId).toBe(TEST_RUN_ID);
  });

  it("answers `runId: null` again once that run's turn has settled", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    channel?.emitStreamFrame("system/init", { handshake: buildHandshake() });
    armRunDispatch(harness, TEST_RUN_ID);
    await harness.lifecycle.startRun(buildStartRunParams());
    channel?.emitStreamFrame("result/success");

    const result = await harness.lifecycle.listProviderCommands({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });

    expect(result.bindings[0]?.runId).toBeNull();
  });

  it("never attributes ANOTHER session's live run to this binding", async () => {
    // Two sessions each holding a live turn must each answer with their own run; a scan that
    // ignored the session would answer `null` for both.
    const peerSessionId = "session-peer-runs" as SessionId;
    let issuedProviderSessionIds = 0;
    const harness = buildHarness({
      mintProviderSessionId: (): string => {
        issuedProviderSessionIds += 1;
        return `provider-session-${issuedProviderSessionIds}`;
      },
    });
    await harness.lifecycle.createSession(buildCreateSessionParams());
    await harness.lifecycle.createSession({
      ...buildCreateSessionParams(),
      sessionId: peerSessionId,
    });
    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: buildHandshake(),
    });
    armRunDispatch(harness, TEST_RUN_ID);
    harness.runDispatchResolver.dispatchByRunId.set(TEST_SECOND_RUN_ID, {
      sessionId: peerSessionId,
      openingText: "the peer session's own turn",
    });
    await harness.lifecycle.startRun(buildStartRunParams());
    await harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID });

    const result = await harness.lifecycle.listProviderCommands({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });

    expect(result.bindings[0]?.runId).toBe(TEST_RUN_ID);
  });
});

describe("ClaudeSessionLifecycle.observedOutputSpeedFor — absent until observed", () => {
  it("has NO observation before the handshake arrives and one after", async () => {
    // Neither establishment path may block for this or spend a synthetic turn to provoke it,
    // so it stays absent until the user's own work produces the declaring exchange.
    const harness = buildHarness();
    const handle = await harness.lifecycle.createSession(buildCreateSessionParams());

    expect(harness.lifecycle.observedOutputSpeedFor(TEST_SESSION_ID)).toBeUndefined();
    // It is on neither establishment reply either; a value there would be fabricated.
    expect("outputSpeed" in handle).toBe(false);

    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: buildHandshake(),
    });

    expect(harness.lifecycle.observedOutputSpeedFor(TEST_SESSION_ID)).toStrictEqual({
      declared: "off",
      reason: "sdk_opt_in_required",
    });
  });

  it("carries a REPORTED `cooldown` verbatim even though it is not a SETTABLE level", async () => {
    // Reportable states are wider than settable ones: `outputSpeedLevels` lists only settable
    // levels, and coercing an observed `cooldown` into that set would fabricate a state the
    // provider is not in.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: buildHandshake({ fastModeState: "cooldown", fastModeDisabledReason: null }),
    });

    const observed = harness.lifecycle.observedOutputSpeedFor(TEST_SESSION_ID);

    expect(observed?.declared).toBe("cooldown");
    // The `reason` key is absent: the provider gave none, which is not the same as there being
    // none.
    expect("reason" in (observed ?? {})).toBe(false);
  });

  it("has NO observation and DIAGNOSES a declared state the contract's bounds refuse", async () => {
    // The handshake's state and reason are provider output that reaches a client, so `verbatim`
    // bounds length, emptiness and NUL, never vocabulary membership. A rejected reading takes
    // the absent answer, the only fail-closed one this shape carries; a placeholder `declared`
    // would put a state the provider is not in on a screen.
    for (const [label, declaration, rejectedField] of [
      ["NUL-bearing state", { fastModeState: `on\u0000x` }, "declared"],
      ["whitespace-only state", { fastModeState: "   " }, "declared"],
      [
        "over-long reason",
        {
          fastModeState: "off",
          fastModeDisabledReason: "r".repeat(DRIVER_OUTPUT_SPEED_REASON_MAX_LEN + 1),
        },
        "reason",
      ],
    ] as const) {
      const harness = buildHarness();
      await harness.lifecycle.createSession(buildCreateSessionParams());
      harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
        handshake: buildHandshake(declaration),
      });

      expect(harness.lifecycle.observedOutputSpeedFor(TEST_SESSION_ID), label).toBeUndefined();
      const rejected = harness.diagnostics.recentRecordsOfKind("output_speed_state_rejected");
      expect(rejected, label).toHaveLength(1);
      expect(rejected[0]?.details["rejectedField"], label).toBe(rejectedField);
      // The refused values never ride the record.
      expect(JSON.stringify(rejected[0]), label).not.toContain("rrrr");
    }
  });

  it("has no observation for a session that declares no fast-mode state at all", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: buildHandshake({ fastModeState: null, fastModeDisabledReason: null }),
    });

    expect(harness.lifecycle.observedOutputSpeedFor(TEST_SESSION_ID)).toBeUndefined();
  });

  it("ignores a CHILD thread's handshake — a subagent's surface is not the session's", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      subagentId: "child-1",
      handshake: buildHandshake({ fastModeState: "on" }),
    });

    expect(harness.lifecycle.observedOutputSpeedFor(TEST_SESSION_ID)).toBeUndefined();
  });

  it("carries the requested output-speed level through to BOTH spawn paths", async () => {
    // Spawn-bound: a level bound at create and omitted at resume would be silently shed at the
    // first relaunch, which `ClaudeSpawnBoundLegs` exists to prevent.
    const harness = buildHarness();

    await harness.lifecycle.createSession({
      ...buildCreateSessionParams(),
      outputSpeed: "on",
    });
    await harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID });
    await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: TEST_PINNED_PROVIDER_SESSION_ID,
      outputSpeed: "on",
    });

    expect(harness.transport.spawnRequests[0]?.outputSpeed).toBe("on");
    expect(harness.transport.resumeRequests[0]?.outputSpeed).toBe("on");
  });
});

describe("ClaudeSessionLifecycle.replayTranscript", () => {
  // `transcript_replay` is decided by a probe: replay refuses on a build that publishes no
  // seeding surface and drives the surface the probe carries on one that does.

  const TARGET = { providerSessionId: "claude-session-77", resumeHandle: "claude-session-77" };

  function frame(position: number, role: "user" | "assistant", text: string): unknown {
    return { position, role, segments: [{ kind: "text", position, text }] };
  }

  const TRANSCRIPT: readonly unknown[] = [
    frame(1, "user", "summarize the fold"),
    frame(2, "assistant", "identity map, strip, repair, render"),
    frame(3, "user", "and the order?"),
    frame(4, "assistant", "the order is the contract"),
  ];

  const SEEDED_BODIES: readonly string[] = [
    "summarize the fold",
    "identity map, strip, repair, render",
    "and the order?",
    "the order is the contract",
  ];

  interface SeedingDouble {
    readonly surface: ClaudeTranscriptSeedingSurface;
    readonly seededPositions: number[];
    readonly reads: number;
  }

  /**
   * A seeding surface whose target starts empty, accumulates what it is given,
   * and answers reads with whatever it was told to answer with.
   */
  function seedingDouble(options: {
    readonly answers: readonly string[];
    readonly priorTurns?: readonly string[];
    readonly refuseAtPosition?: number;
    readonly ambiguousAtPosition?: number;
    readonly unreadable?: boolean;
  }): SeedingDouble {
    const seededPositions: number[] = [];
    const record = { reads: 0 };
    let seeding = false;
    const surface: ClaudeTranscriptSeedingSurface = {
      seedFrame: (_targetProviderSessionId, seedFrameInput) => {
        seeding = true;
        if (seedFrameInput.position === options.refuseAtPosition) {
          return Promise.resolve({ delivery: "refused" as const, reason: "unsupported shape" });
        }
        if (seedFrameInput.position === options.ambiguousAtPosition) {
          // Applied-or-not, unknowably: the acknowledgment was lost.
          seededPositions.push(seedFrameInput.position);
          return Promise.resolve({ delivery: "ambiguous" as const, reason: "acknowledgment lost" });
        }
        seededPositions.push(seedFrameInput.position);
        return Promise.resolve({ delivery: "applied" as const });
      },
      readBack: () => {
        record.reads += 1;
        if (options.unreadable === true) {
          return Promise.resolve({ kind: "unreadable" as const, reason: "target gone" });
        }
        return Promise.resolve({
          kind: "turns" as const,
          turns: seeding ? [...options.answers] : [...(options.priorTurns ?? [])],
        });
      },
    };
    return {
      surface,
      seededPositions,
      get reads(): number {
        return record.reads;
      },
    };
  }

  function harnessWithSurface(double: SeedingDouble | null): LifecycleHarness {
    return buildHarness({
      transcriptReplaySurfaceReader: () =>
        Promise.resolve(
          double === null
            ? { supported: false, reason: "this build publishes no seeding surface" }
            : { supported: true, surface: double.surface },
        ),
    });
  }

  // No published build carries a prior-turn seeding surface, so the probe refuses, the flag
  // declares `false`, and the caller settles on the memo floor reported `degraded`. A refusal,
  // not a fault.
  it("refuses when the probe finds no seeding surface, leaving the target untouched", async () => {
    const harness = harnessWithSurface(null);
    await expect(
      harness.lifecycle.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toBeInstanceOf(ClaudeTranscriptReplayUnsupportedError);

    // Not abandoned: nothing was written, so the caller may hand this session to the memo floor
    // rather than establish a second one.
    await expect(
      harness.lifecycle.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toBeInstanceOf(ClaudeTranscriptReplayUnsupportedError);
  });

  it("refuses with no surface reader bound at all", async () => {
    const harness = buildHarness();
    await expect(
      harness.lifecycle.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toBeInstanceOf(ClaudeTranscriptReplayUnsupportedError);
  });

  it("seeds and CONFIRMS against the target's own answer when a surface exists", async () => {
    const double = seedingDouble({ answers: SEEDED_BODIES });
    const result = await harnessWithSurface(double).lifecycle.replayTranscript({
      target: TARGET,
      frames: [...TRANSCRIPT],
    });
    expect(result).toStrictEqual({ status: "applied", declaredLosses: [] });
    // Round-tripped through the wire schema: the `applied` arm has a refinement (it may not
    // declare `conversation_history_summarized`) that a shape comparison cannot see.
    expect(DriverTranscriptReplayResultSchema.parse(result)).toStrictEqual(result);
    expect(double.seededPositions).toStrictEqual([1, 2, 3, 4]);
    // Two reads: the pre-seed freshness read and the post-replay assertion's.
    expect(double.reads).toBe(2);
  });

  // A replay target is single-use. The pre-seed read would also catch a second replay, but as
  // `target-not-fresh`, which blames the caller and costs a round trip the ledger already
  // answers.
  it("burns a CONFIRMED target, so replaying the same handle twice is impossible", async () => {
    const double = seedingDouble({ answers: SEEDED_BODIES });
    const harness = harnessWithSurface(double);

    await harness.lifecycle.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] });
    expect(double.seededPositions).toStrictEqual([1, 2, 3, 4]);
    const readsAfterFirstReplay = double.reads;

    await expect(
      harness.lifecycle.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toBeInstanceOf(ReplayTargetAbandonedError);
    // Refused before both the seeding and the freshness read: the ledger is consulted before
    // the surface is touched.
    expect(double.seededPositions).toStrictEqual([1, 2, 3, 4]);
    expect(double.reads).toBe(readsAfterFirstReplay);
  });

  // The mandatory case: a surface that accepts every frame and whose target then answers empty.
  it("REFUSES a surface that accepts every frame and answers with zero turns", async () => {
    const double = seedingDouble({ answers: [] });
    await expect(
      harnessWithSurface(double).lifecycle.replayTranscript({
        target: TARGET,
        frames: [...TRANSCRIPT],
      }),
    ).rejects.toBeInstanceOf(PostReplayAssertionFailedError);
    expect(double.seededPositions).toStrictEqual([1, 2, 3, 4]);
  });

  // This driver keeps no turn ledger, so freshness costs a read. It is needed because the
  // assertion tolerates a target answering with more turns than were seeded, so a target that
  // arrived with a prior conversation would pass on a matching tail.
  it("reads the target BEFORE seeding and refuses one that already holds turns", async () => {
    const double = seedingDouble({
      answers: SEEDED_BODIES,
      priorTurns: ["a conversation that was already here"],
    });
    await expect(
      harnessWithSurface(double).lifecycle.replayTranscript({
        target: TARGET,
        frames: [...TRANSCRIPT],
      }),
    ).rejects.toThrow(/must be fresh/);
    expect(double.seededPositions).toStrictEqual([]);
  });

  // Across both targets: the abandoned one holds native frames and no memo, the replacement
  // holds the memo and no native frames, so no surviving session shows the same exchanges
  // twice, once truncated.
  it("abandons a target refused mid-seeding; the memo lands in a FRESH target", async () => {
    const double = seedingDouble({ answers: SEEDED_BODIES, refuseAtPosition: 3 });
    const harness = harnessWithSurface(double);
    await expect(
      harness.lifecycle.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toThrow(/abandoned and must not be reused/);
    // A prefix landed, which is what makes reuse unsafe rather than untidy.
    expect(double.seededPositions).toStrictEqual([1, 2]);

    await expect(
      harness.lifecycle.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toBeInstanceOf(ReplayTargetAbandonedError);
    expect(double.seededPositions).toStrictEqual([1, 2]);

    const memoTurnsBySession = new Map<string, string[]>();
    const coordinator = new MemoDeliveryCoordinator({
      readTurnsForMarkerReconciliation: (providerSessionId) =>
        Promise.resolve([...(memoTurnsBySession.get(providerSessionId) ?? [])]),
      sendMemoTurn: (outboundFrame) => {
        const turns = memoTurnsBySession.get(outboundFrame.targetProviderSessionId) ?? [];
        turns.push(outboundFrame.frame.wireText);
        memoTurnsBySession.set(outboundFrame.targetProviderSessionId, turns);
        return Promise.resolve();
      },
    });
    const replacementProviderSessionId = "claude-session-78";
    const settlement = await new TranscriptReconstitutionRouter(coordinator).route(
      { outcome: "refused" },
      {
        projection: {
          sessionId: "22222222-2222-4222-8222-222222222222" as SessionId,
          runId: "33333333-3333-4333-8333-333333333333" as RunId,
          builtAtPosition: 4,
          turns: [
            {
              position: 1,
              role: "user",
              segments: [{ kind: "text", position: 1, text: "summarize the fold" }],
            },
          ],
        },
        target: coordinator.establishTarget({
          providerSessionId: replacementProviderSessionId,
        }),
        budget: {
          targetContextWindowTokens: 200_000,
          budgetFraction: 0.1,
          protectedTailToolExchangeCount: 1,
        },
      },
    );
    expect(settlement.route).toBe("memo");

    // The abandoned target holds native frames and NO memo…
    expect(memoTurnsBySession.get(TARGET.providerSessionId)).toBeUndefined();
    // …and the replacement holds the memo and NO native frames.
    expect(memoTurnsBySession.get(replacementProviderSessionId)).toHaveLength(1);
    expect(double.seededPositions).toStrictEqual([1, 2]);
  });

  it("settles a replay-interior refusal on the memo floor with ONE reconstitution", async () => {
    const double = seedingDouble({ answers: SEEDED_BODIES, refuseAtPosition: 2 });
    const harness = harnessWithSurface(double);

    await expect(
      harness.lifecycle.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toThrow(/abandoned and must not be reused/);

    // Two callers recovering from the same refusal (the run's failure path and a retrying
    // caller) must between them start no second native reconstitution.
    await expect(
      harness.lifecycle.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toBeInstanceOf(ReplayTargetAbandonedError);
    await expect(
      harness.lifecycle.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toBeInstanceOf(ReplayTargetAbandonedError);

    expect(double.seededPositions.filter((position) => position === 1)).toHaveLength(1);
    expect(double.seededPositions).toStrictEqual([1]);

    // The settlement the user is owed is the memo floor's, never a silently applied replay.
    const coordinator = new MemoDeliveryCoordinator({
      readTurnsForMarkerReconciliation: () => Promise.resolve([]),
      sendMemoTurn: () => Promise.resolve(),
    });
    const settlement = await new TranscriptReconstitutionRouter(coordinator).route(
      { outcome: "refused" },
      {
        projection: {
          sessionId: "22222222-2222-4222-8222-222222222222" as SessionId,
          runId: "33333333-3333-4333-8333-333333333333" as RunId,
          builtAtPosition: 4,
          turns: [
            {
              position: 1,
              role: "user",
              segments: [{ kind: "text", position: 1, text: "summarize the fold" }],
            },
          ],
        },
        target: coordinator.establishTarget({ providerSessionId: "claude-session-79" }),
        budget: {
          targetContextWindowTokens: 200_000,
          budgetFraction: 0.1,
          protectedTailToolExchangeCount: 1,
        },
      },
    );
    expect(settlement.route).toBe("memo");
    expect(double.seededPositions).toStrictEqual([1]);
  });

  it("abandons a target whose delivery was AMBIGUOUS, rather than retrying it", async () => {
    const double = seedingDouble({ answers: SEEDED_BODIES, ambiguousAtPosition: 2 });
    const harness = harnessWithSurface(double);
    await expect(
      harness.lifecycle.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toThrow(/abandoned and must not be reused/);

    // A retry would duplicate frame 2 in a conversation a user reads, and
    // nothing downstream could tell the duplicate from a repeated turn.
    await expect(
      harness.lifecycle.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toBeInstanceOf(ReplayTargetAbandonedError);
    expect(double.seededPositions).toStrictEqual([1, 2]);
  });

  it("abandons a target that cannot be read, never assuming the seed took", async () => {
    const double = seedingDouble({ answers: SEEDED_BODIES, unreadable: true });
    const harness = harnessWithSurface(double);
    await expect(
      harness.lifecycle.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toThrow(/freshness is unknown/);
    await expect(
      harness.lifecycle.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toBeInstanceOf(ReplayTargetAbandonedError);
  });

  it("refuses a segment kind it cannot represent, rather than skipping it", async () => {
    const double = seedingDouble({ answers: SEEDED_BODIES });
    await expect(
      harnessWithSurface(double).lifecycle.replayTranscript({
        target: TARGET,
        frames: [
          frame(1, "user", "kept"),
          { position: 2, role: "assistant", segments: [{ kind: "hologram", position: 2 }] },
        ],
      }),
    ).rejects.toThrow(/unsupported segment kind/);
    // Parsed before anything is written, so the target stays pristine.
    expect(double.seededPositions).toStrictEqual([]);
  });

  it("refuses an empty transcript rather than confirming a replay of nothing", async () => {
    const double = seedingDouble({ answers: SEEDED_BODIES });
    await expect(
      harnessWithSurface(double).lifecycle.replayTranscript({ target: TARGET, frames: [] }),
    ).rejects.toThrow(/nothing to reconstitute/);
  });

  it("routes a `transcript_replay: false` refusal to the memo floor, reported degraded", async () => {
    const harness = harnessWithSurface(null);
    let disposition: NativeReplayDisposition = {
      outcome: "applied",
      declaredLosses: [],
    };
    try {
      await harness.lifecycle.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ClaudeTranscriptReplayUnsupportedError);
      disposition = { outcome: "unavailable" };
    }
    expect(disposition).toStrictEqual({ outcome: "unavailable" });

    const deliveredTurns: string[] = [];
    const coordinator = new MemoDeliveryCoordinator({
      readTurnsForMarkerReconciliation: () => Promise.resolve([...deliveredTurns]),
      sendMemoTurn: (outboundFrame) => {
        deliveredTurns.push(outboundFrame.frame.wireText);
        return Promise.resolve();
      },
    });
    const settlement = await new TranscriptReconstitutionRouter(coordinator).route(disposition, {
      projection: {
        sessionId: "22222222-2222-4222-8222-222222222222" as SessionId,
        runId: "33333333-3333-4333-8333-333333333333" as RunId,
        builtAtPosition: 4,
        turns: [
          {
            position: 1,
            role: "user",
            segments: [{ kind: "text", position: 1, text: "summarize the fold" }],
          },
          {
            position: 2,
            role: "assistant",
            segments: [{ kind: "text", position: 2, text: "identity map, strip, repair, render" }],
          },
        ],
      },
      target: coordinator.establishTarget({ providerSessionId: TARGET.providerSessionId }),
      budget: {
        targetContextWindowTokens: 200_000,
        budgetFraction: 0.1,
        protectedTailToolExchangeCount: 1,
      },
    });

    expect(settlement.route).toBe("memo");
    if (settlement.route !== "memo") {
      throw new Error("unreachable");
    }
    const reported = memoSettlementAsReplayResult(settlement.memo);
    expect(reported.status).toBe("degraded");
    // The schema requires this on a `degraded` result; it tells the user the conversation was
    // summarized.
    expect(reported.declaredLosses).toContain("conversation_history_summarized");
    expect(deliveredTurns).toHaveLength(1);
  });
});
