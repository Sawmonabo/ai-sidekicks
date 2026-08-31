// Coverage map for `lifecycle.ts` (Plan-005 Phase 3, T3.6):
//   * `Spec-005 §Required Behavior` — the five lifecycle operations of the normalized
//     driver surface (`createSession`, `resumeSession`, `startRun`,
//     `interruptRun`, `closeSession`), including the spawn-bound parity legs a
//     resume must re-realize because resume is a FRESH process spawn.
//   * `Spec-005 §Fallback Behavior` (AC3) — a resume-handle failure surfaces `provider failure`
//     detail plus a visible recovery condition.
//   * I-005-5 — a failed resume returns the typed `failed` arm AND leaves no
//     replacement Claude session behind: the refused channel is disposed, no
//     route is registered, and the canonical session is left free for an explicit
//     re-create. Exercised across all four failure mechanisms this band can see
//     (transport rejection, identity divergence, contract-invalid position, and a
//     resume attempted beside a live session), plus the `reauth-required`
//     classification a typed credential failure must produce. The enforcement
//     check the `Plan-005 §Invariants` I-005-5 entry names by hand — no
//     `createSession()` call is issued, watched by a spy on the driver's own
//     method — runs against every one of those four mechanisms.
//   * Positive controls for the spawn-bound realization gate: an agreeing cap,
//     posture, and output schema each START a run, so a guard that refused too
//     much could not hide behind the mismatch tests.
//   * `Spec-016 §Cost Derivation And Absent-Cost Semantics` — the cap rule is
//     ONE-DIRECTIONAL. A cap-declaring run is refused against both an uncapped
//     and a differently-capped process; a run declaring no cap is admitted into a
//     capped session, because the native cap sits beneath the daemon accountant
//     rather than being it.
//   * P0-5 (T3.14) — the zero-turn auth probe classifies the transport's reading
//     onto the contract's three values, is TOTAL over every throw, and keeps
//     `unauthenticated` distinguishable from `indeterminate` through a typed
//     error rather than a message-substring test.

import {
  DRIVER_OUTPUT_SPEED_REASON_MAX_LEN,
  DRIVER_PROVIDER_COMMAND_ENTRIES_MAX,
  DRIVER_PROVIDER_COMMAND_NAME_MAX_LEN,
  DriverResumeResultSchema,
  DriverTranscriptReplayResultSchema,
  type CallbackToolResult,
  type ExecutionPosture,
  type SubagentPolicy,
} from "@ai-sidekicks/contracts";
import { describe, expect, it, vi } from "vitest";

import type { DriverDiagnosticsEmitter } from "../../../driver-diagnostics.js";
import type { RunId, SessionId } from "@ai-sidekicks/contracts";

import type { SubagentLifecycleEmission, ThreadFrameRoute } from "../../../thread-frame-router.js";
import type { MeteredUsageDelta } from "../../../usage-delta-accountant.js";
import { buildProviderSpawnEnv, hostEnvNameMatchForPlatform } from "../../../spawn-env.js";
import {
  MemoDeliveryCoordinator,
  TranscriptReconstitutionRouter,
  memoSettlementAsReplayResult,
  type NativeReplayDisposition,
} from "../../../transcript/memo-projection.js";
import { MAX_DEFINITELY_UNSENT_DISPATCH_ATTEMPTS } from "../../../transcript/failure-mapping.js";
import {
  PostReplayAssertionFailedError,
  ReplayTargetAbandonedError,
} from "../../../transcript/replay-assertion.js";
import type { ClaudeTranscriptSeedingSurface } from "../capabilities.js";
import {
  ClaudeAuthenticationRequiredError,
  ClaudeControlRequestRefusedError,
  ClaudeSessionLifecycle,
  ClaudeSessionUnavailableError,
  ClaudeTranscriptReplayUnsupportedError,
  ClaudeSubagentConcurrencyGate,
  CLAUDE_CALLBACK_MCP_SERVER_NAME,
  CLAUDE_CALLBACK_TOOL_TRANSPORT_UNAVAILABLE_DETAIL,
  CLAUDE_SUBAGENT_MAX_DEPTH_CEILING,
  composeClaudeCallbackMcpServer,
  composeClaudeProviderToolName,
  composeClaudeSandboxSettings,
  CLAUDE_COMPACTION_WAIT_MS,
  type ClaudeHandshakeDeclaration,
  type ClaudeSessionLifecycleDependencies,
} from "../lifecycle.js";
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
    // Required rather than optional (T3.18): a trip's run terminal is the only
    // user-visible surface a swallowed turn has, so no construction site may
    // leave it unbound.
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

// Every way this band can refuse a resume. `Plan-005 §Invariants` I-005-5 asks for
// one specific check against all of them — "verifying that no `createSession()`
// call is issued ... (mock-spy on the driver's `createSession` method)" — because
// the typed `failed` arm alone cannot distinguish a driver that refused from one
// that refused AND quietly spawned a replacement behind the daemon's back.
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

  it("carries every spawn-bound parity leg through to the transport", async () => {
    const harness = buildHarness();
    const onCallbackToolCall = async (): Promise<CallbackToolResult> => ({
      status: "completed",
      output: "ok",
    });

    await harness.lifecycle.createSession({
      sessionId: TEST_SESSION_ID,
      config: { model: "claude-sonnet-4-5" },
      admittedCostCapCents: 500,
      executionPosture: SANDBOXED_POSTURE,
      callbackTools: [{ name: "ask", description: "ask", inputSchema: {} }],
      subagentPolicy: { enabled: false },
      outputSchema: { type: "object" },
      onCallbackToolCall,
    });

    const request = harness.transport.spawnRequests[0];
    expect(request?.admittedCostCapCents).toBe(500);
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

  it("re-realizes every spawn-bound parity leg on the resume spawn", async () => {
    const harness = buildHarness();

    await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
      admittedCostCapCents: 750,
      executionPosture: SANDBOXED_POSTURE,
      outputSchema: { type: "object" },
      subagentPolicy: { enabled: false },
    });

    const request = harness.transport.resumeRequests[0];
    expect(request?.resumeHandle).toBe("provider-session-earlier");
    expect(request?.admittedCostCapCents).toBe(750);
    expect(request?.executionPosture).toStrictEqual(SANDBOXED_POSTURE);
    expect(request?.outputSchema).toStrictEqual({ type: "object" });
    expect(request?.subagentPolicy).toStrictEqual({ enabled: false });
  });

  it("I-005-5: a rejected resume yields recovery-needed and leaves no replacement session", async () => {
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

  it("I-005-5: a provider answering with a FRESH session is refused and disposed", async () => {
    const harness = buildHarness();
    // The documented Claude behaviour on a working-directory mismatch: the
    // resume silently becomes a brand-new session announcing its own id.
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

  it("I-005-5: a resumed arm failing the driver contract becomes a failure, not a success", async () => {
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

  it("I-005-5: a resume beside a live session is refused without touching the live channel", async () => {
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
    "I-005-5: issues no createSession call on a failed resume ($label)",
    async ({ arrange }) => {
      const harness = buildHarness();
      await arrange(harness);
      // Spied AFTER arrangement so the live-session mechanism's own setup call is
      // not counted: what the invariant forbids is a create issued IN ANSWER TO
      // the failure.
      const createSessionSpy = vi.spyOn(harness.lifecycle, "createSession");
      const spawnCountBeforeResume = harness.transport.spawnRequests.length;

      const result = await harness.lifecycle.resumeSession({
        sessionId: TEST_SESSION_ID,
        resumeHandle: "provider-session-earlier",
      });

      expect(result.status).toBe("failed");
      expect(createSessionSpy).not.toHaveBeenCalled();
      // The spy only watches the driver's own entry point, so assert the spawn
      // count directly too: a replacement reached by any other path moves it.
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
    // The one-frame-per-run-key invariant the tripwire's settle attributes by:
    // position 0 gets the terminal's real classification and every later frame
    // under the key is ruled unrecognized, which trips. A duplicate dispatch
    // admitted here would therefore quarantine the session over the duplicate,
    // not over a swallowed participant.
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

    // Refused before compose and register: the duplicate reached the wire as
    // nothing, and the first dispatch's turn still settles benignly — one frame,
    // one real classification, no false trip.
    expect(harness.transport.spawnedChannels[0]?.sentWireTexts).toStrictEqual(["review the diff"]);
    harness.transport.spawnedChannels[0]?.emitStreamFrame("result/success");
    expect(harness.textNeutralizationFailures).toStrictEqual([]);
  });

  it("admits a re-dispatch once the first opening frame's turn has settled", async () => {
    // The guard keys on the PENDING frame and on nothing longer-lived: a run
    // whose turn settled holds no frame, so dispatching it again is admitted.
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

  it("refuses a DIFFERENT run's start while another run's opening frame is pending", async () => {
    // The session-scoped completion of the duplicate guard: Claude's settling
    // envelope carries no run id, so with two runs' frames pending on one
    // session the tripwire could rule only the oldest-bound run on the real
    // verdict and every other unrecognized — quarantining a healthy session
    // over a perfectly valid queued start.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "review the diff",
    });
    harness.runDispatchResolver.dispatchByRunId.set(TEST_SECOND_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "and now the second directive",
    });
    await harness.lifecycle.startRun(buildStartRunParams());

    await expect(
      harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID }),
    ).rejects.toMatchObject({
      code: "driver.unavailable",
      fields: { reason: "session_turn_in_flight" },
    });

    // Refused before compose and register: nothing reached the wire, no route
    // was bound, and the pending run's turn still settles benignly.
    expect(harness.transport.spawnedChannels[0]?.sentWireTexts).toStrictEqual(["review the diff"]);
    expect(harness.lifecycle.findChannelForRun(TEST_SECOND_RUN_ID)).toBeUndefined();
    harness.transport.spawnedChannels[0]?.emitStreamFrame("result/success");
    expect(harness.textNeutralizationFailures).toStrictEqual([]);
  });

  // `Spec-016 §Cost Derivation And Absent-Cost Semantics` names both refusal
  // shapes for a cap-declaring run: "an existing uncapped (or differently-capped)
  // process forces a capped relaunch ... never a start inside an uncapped
  // process." Both are asserted, since only the uncapped one is restated in the
  // sentence's final clause and a guard could pass it while missing the other.
  it("never starts a cap-admitted run inside a session spawned with NO cap", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "review the diff",
    });

    await expect(
      harness.lifecycle.startRun({ ...buildStartRunParams(), admittedCostCapCents: 500 }),
    ).rejects.toMatchObject({ fields: { reason: "cost_cap_mismatch" } });
    expect(harness.transport.spawnedChannels[0]?.sentWireTexts).toStrictEqual([]);
    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeUndefined();
  });

  it("never starts a cap-admitted run inside a session spawned with a DIFFERENT cap", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession({
      ...buildCreateSessionParams(),
      admittedCostCapCents: 250,
    });
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "review the diff",
    });

    await expect(
      harness.lifecycle.startRun({ ...buildStartRunParams(), admittedCostCapCents: 500 }),
    ).rejects.toMatchObject({ fields: { reason: "cost_cap_mismatch" } });
    expect(harness.transport.spawnedChannels[0]?.sentWireTexts).toStrictEqual([]);
    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeUndefined();
  });

  it("starts a run declaring NO cap inside a capped session: the rule is one-directional", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession({
      ...buildCreateSessionParams(),
      admittedCostCapCents: 250,
    });
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "review the diff",
    });

    // The spec constrains a native-cap RUN; it does not prohibit the converse.
    // The native cap is "defense-in-depth beneath this accountant, never as the
    // accountant" (same section), so the daemon accountant enforces and a
    // provider-side early stop surfaces as an ordinary visible provider stop.
    // Refusing here would strand every capless run in a capped session behind a
    // relaunch no spec sentence orders.
    await harness.lifecycle.startRun(buildStartRunParams());

    expect(harness.transport.spawnedChannels[0]?.sentWireTexts).toStrictEqual(["review the diff"]);
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

// Positive controls for `#assertSpawnBoundRealization`. Without these, a guard
// that refuses too much would be invisible: every mismatch test above would still
// refuse — correctly, but by accident — and the happy-path test declares none of
// the three axes, so all three checks pass there on `undefined` alone.
describe("ClaudeSessionLifecycle.startRun spawn-bound realization (agreeing runs start)", () => {
  function arrangeDispatch(harness: LifecycleHarness): void {
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "review the diff",
    });
  }

  it("starts a run whose admitted cap equals the cap its session was spawned with", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession({
      ...buildCreateSessionParams(),
      admittedCostCapCents: 500,
    });
    arrangeDispatch(harness);

    await harness.lifecycle.startRun({ ...buildStartRunParams(), admittedCostCapCents: 500 });

    expect(harness.transport.spawnedChannels[0]?.sentWireTexts).toStrictEqual(["review the diff"]);
  });

  it("starts a run whose posture agrees with the spawned sandbox by value, not by reference", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession({
      sessionId: TEST_SESSION_ID,
      config: {},
      executionPosture: SANDBOXED_POSTURE,
    });
    arrangeDispatch(harness);

    // A distinct object carrying the same posture: the daemon re-materializes the
    // posture per call, so a reference-equality guard would refuse every real run.
    await harness.lifecycle.startRun({
      ...buildStartRunParams(),
      executionPosture: { ...SANDBOXED_POSTURE },
    });

    expect(harness.transport.spawnedChannels[0]?.sentWireTexts).toStrictEqual(["review the diff"]);
  });

  it("starts a schema-constrained run inside a session that was spawned schema-bound", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession({
      ...buildCreateSessionParams(),
      outputSchema: { type: "object" },
    });
    arrangeDispatch(harness);

    await harness.lifecycle.startRun({
      ...buildStartRunParams(),
      outputSchema: { type: "object" },
    });

    expect(harness.transport.spawnedChannels[0]?.sentWireTexts).toStrictEqual(["review the diff"]);
  });
});

// `ExecutionPosture` is an intersection of two discriminated unions: `mode`,
// `networkAccess`, `allowedDomains` (allowed-domains arm only), `writableRoots`,
// `profileName`, and `credentialPolicyRef` (sandboxed arms only). Comparing a
// projection of that — as an earlier revision did, on `mode` + `networkAccess`
// alone — admits a run into a process whose sandbox differs on an axis nobody
// checked, and the run's recorded effective posture is then a lie. One test per
// axis, so a re-narrowing cannot pass by covering only the popular ones.
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

  it("names the first divergent axis in the refusal detail", async () => {
    const harness = buildHarness();
    await arrangeSession(harness, ALLOWED_DOMAINS_POSTURE);

    // The detail rides the error MESSAGE (`fields` carries only the closed-set
    // reason), so an operator reading a refusal learns WHICH axis diverged
    // without having to diff two postures by hand.
    await expect(
      harness.lifecycle.startRun({
        ...buildStartRunParams(),
        executionPosture: { ...ALLOWED_DOMAINS_POSTURE, writableRoots: ["/etc"] },
      }),
    ).rejects.toThrow(/writableRoots/);
  });

  it("admits a posture whose set axes agree but are ordered differently", async () => {
    const harness = buildHarness();
    await arrangeSession(harness, ALLOWED_DOMAINS_POSTURE);

    // A caller that lists the same roots and domains in another order has
    // declared the SAME posture; refusing it would force relaunches over
    // serialization order rather than over a real difference.
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

    // The one-directional rule is unchanged by the axis widening.
    await harness.lifecycle.startRun(buildStartRunParams());

    expect(harness.transport.spawnedChannels[0]?.sentWireTexts).toStrictEqual(["review the diff"]);
  });
});

// A boolean "is a schema bound?" admits a run carrying schema B into a process
// spawned with schema A, so the provider constrains output to a shape the run
// never asked for. Identity is a canonical digest: key ORDER is not semantic in
// JSON, array order is.
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

  it("keeps the unbound arm: a schema-declaring run in a schema-less session", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "review the diff",
    });

    await expect(
      harness.lifecycle.startRun({ ...buildStartRunParams(), outputSchema: SPAWN_SCHEMA }),
    ).rejects.toMatchObject({ fields: { reason: "output_schema_unbound" } });
  });

  it("admits a run declaring no schema into a schema-bound session", async () => {
    const harness = buildHarness();
    await arrangeSchemaBoundSession(harness, SPAWN_SCHEMA);

    await harness.lifecycle.startRun(buildStartRunParams());

    expect(harness.transport.spawnedChannels[0]?.sentWireTexts).toStrictEqual(["review the diff"]);
  });
});

describe("ClaudeSessionLifecycle.interruptRun", () => {
  it("sends the interrupt control request against the run's live channel", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "review the diff",
    });
    await harness.lifecycle.startRun(buildStartRunParams());

    await harness.lifecycle.interruptRun({ runId: TEST_RUN_ID });

    expect(harness.transport.spawnedChannels[0]?.controlRequests).toStrictEqual([
      { subtype: "interrupt", cancelQueued: false },
    ]);
  });

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

  it("is idempotent for a session that holds no live channel", async () => {
    const harness = buildHarness();

    await expect(
      harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID }),
    ).resolves.toBeUndefined();
  });

  // A dispose that rejects leaves a provider process RUNNING. Freeing the slot
  // then would let the next create spawn a second process under one canonical
  // session — the double-process hazard the slot claim exists to prevent,
  // reached by a different road — so the slot is quarantined with the channel
  // retained, which is the only remaining handle on that process.
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
    // (b) The slot is held, so no second process can be spawned beneath it. The
    // reason stays the closed-set `session_already_live` — the slot IS taken —
    // while the message names quarantine, so an operator can tell a live session
    // from a process that would not die. No reason arm is minted for a state
    // nothing branches on.
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

    // The process finally exits: the retry must reach THAT channel, not report a
    // success against a session record that no longer exists.
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

// Two callers can be inside an establishment at once: both entry points await a
// transport spawn between checking the session slot and registering the channel.
// Without a claim taken BEFORE that await, both pass the check, both spawn, and
// the second registration overwrites the first — the loser's channel is then
// unreachable by `closeSession` and its CLI process outlives the daemon's record
// of it. Each test holds the transport open so both callers are provably in
// flight, then asserts the transport's own spawn count: exactly one process.
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
    // The refusal is worth nothing if the loser spawned anyway: one process, one
    // channel, and the survivor is the one the lifecycle actually holds.
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

    // Through the `failed` arm, never a throw: resume's contract failure channel
    // is that arm regardless of which shape of collision caused it.
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

    // A close that read the slot as empty would return before the channel was
    // ever registered, and the process would outlive the daemon's record of it.
    expect(harness.transport.spawnedChannels).toHaveLength(1);
    expect(harness.transport.spawnedChannels[0]?.disposals).toStrictEqual(["session_closed"]);
    // The slot is genuinely free afterwards, not merely emptied of its record.
    await expect(
      harness.lifecycle.createSession(buildCreateSessionParams()),
    ).resolves.toBeDefined();
  });
});

// The slot must be HELD across every async transition, not merely re-taken after
// one. An earlier revision dropped the session record BEFORE awaiting `dispose`,
// so for the whole teardown the slot read EMPTY: a concurrent create spawned a
// replacement, and a dispose that then rejected installed its quarantine beside
// the NEW live channel — two processes under one canonical session, which is the
// exact condition the quarantine was added to prevent. These tests hold each
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
    // The disposal was entered, so the slot is genuinely CLOSING rather than
    // merely scheduled to be.
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
    // The decisive assertion: no replacement process was spawned beneath a
    // session whose own process was still dying.
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

    // The second close chained onto the first, observed EMPTY, and returned —
    // rather than issuing a second teardown against a process already gone.
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

    // The retry is itself an async transition and must hold the slot too, or the
    // window simply reopens one state later.
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

// Claude's interrupt is CHANNEL-level. A run route that outlives its turn is
// therefore not an inert stale entry: a late interrupt for the finished run would
// land on whatever turn the channel is running now. Routes are retired when the
// transport reports a terminal stream frame.
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

  it("retires the route when the turn ends in success", async () => {
    const harness = buildHarness();
    const channel = await arrangeRunningTurn(harness);

    channel.emitStreamFrame("result/success");

    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeUndefined();
  });

  it("retires the route when the turn ends in an error terminal", async () => {
    const harness = buildHarness();
    const channel = await arrangeRunningTurn(harness);

    // The driver's response is the same for either terminal — the route is over
    // because the TURN is over, not because it succeeded. The double owns the
    // terminal-vs-non-terminal discriminant, exactly as a transport does.
    channel.emitStreamFrame("result/error_max_turns");

    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeUndefined();
  });

  it("keeps the route across a non-terminal frame", async () => {
    const harness = buildHarness();
    const channel = await arrangeRunningTurn(harness);

    // A censused, thread-scoped, NON-terminal kind: it must route and project,
    // so what this asserts is the terminal discriminant rather than a frame the
    // router would have refused anyway.
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

    // The driver holds no kill, so the old process can still emit long after the
    // daemon stopped listening to it. That terminal belongs to nobody.
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

// The window between "the transport handed us a live channel" and "that channel
// is registered" contains three things that can throw, none of them the
// provider's doing: the injected binding minter, the spawn-binding digest of a
// caller-supplied output schema, and the transport's own `onTurnTerminal`. An
// escaping throw would skip BOTH the disposal paths and the registration, while
// the outer slot claim cleared the slot in its settle path — leaving a running
// process nobody holds a reference to and a free slot for the next create to
// spawn beside it. Every exit from this window must register or dispose.
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

    // Resume's contractual failure channel is the arm, never a throw.
    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("unreachable: the resume must fail");
    }
    expect(result.recoveryCondition).toBe("recovery-needed");
    expect(result.providerFailureDetail).toContain("runtime_bindings");
    expect(DriverResumeResultSchema.safeParse(result).success).toBe(true);
    // The process the transport handed back was disposed, not orphaned.
    expect(harness.transport.spawnedChannels[0]?.disposals).toStrictEqual(["establishment_failed"]);
    // And the slot is free, so recovery is an ordinary create rather than a
    // session id that can never be used again.
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

    // `createSession` has no degraded arm, so throwing IS its failure channel —
    // but the channel must still be disposed on the way out.
    await expect(harness.lifecycle.createSession(buildCreateSessionParams())).rejects.toThrow(
      "the stream consumer is already closed",
    );

    expect(harness.transport.spawnedChannels[0]?.disposals).toStrictEqual(["establishment_failed"]);
    // The slot never latched: a retry is admitted rather than refused by a
    // half-registered session.
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

// `providerFailureDetail` is rendered by a module-private helper whose contract
// is TOTALITY over arbitrary thrown values: every caller is a catch block, and
// the refused-channel disposal path's whole job is to not throw, so a renderer
// that could throw would defeat the guard calling it. Exercised through the
// resume failure path, which is the surface that persists the detail.
describe("ClaudeSessionLifecycle.probeAuth (T3.14 P0-5)", () => {
  it("reports authenticated when the transport takes the reading", async () => {
    const harness = buildHarness();

    const result = await harness.lifecycle.probeAuth();

    expect(result.status).toBe("authenticated");
    expect(harness.transport.probeAuthCallCount).toBe(1);
  });

  it("carries the transport's own detail when it supplied one", async () => {
    const harness = buildHarness();
    harness.transport.probeAuthDetail = "credential home: default";

    await expect(harness.lifecycle.probeAuth()).resolves.toMatchObject({
      status: "authenticated",
      detail: "credential home: default",
    });
  });

  it("names the evidence rather than a credential source when the transport gave no detail", async () => {
    const harness = buildHarness();

    const result = await harness.lifecycle.probeAuth();

    // The pinned CLI publishes no authless protocol probe, so reaching the
    // provider IS the whole of the evidence — the default detail must not imply
    // a credential source the probe never observed.
    expect(result.detail).toBe("the provider answered the zero-turn auth probe");
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

    // Fail-closed for admission, and still distinguishable: an operator sent to
    // re-authenticate a credential that was never in question has been told the
    // wrong thing.
    const result = await harness.lifecycle.probeAuth();

    expect(result.status).toBe("indeterminate");
    expect(result.detail).toContain("claude binary not found");
  });

  it("classifies by type, not by message text", async () => {
    const harness = buildHarness();
    // A generic failure whose WORDS look like a credential problem. A
    // substring test would misclassify it as a determinate logout.
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

    // A probe that spawned a session would not be zero-turn, and one that held
    // the session slot would stall the admission check it exists to make cheap.
    expect(harness.transport.spawnRequests).toStrictEqual([]);
    await expect(
      harness.lifecycle.createSession(buildCreateSessionParams()),
    ).resolves.toMatchObject({ providerSessionId: TEST_PINNED_PROVIDER_SESSION_ID });
  });
});

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
    // The posture this locks: an unreadable value is reported as undescribable,
    // never rendered best-effort. A `toString` on a config-bearing object is how
    // credential material would reach a durable row.
    Object.defineProperty(error, "message", {
      value: { toString: () => "sk-live-should-never-appear" },
    });

    const detail = await resumeFailureDetail(error);

    expect(detail).toBe("Error");
    expect(detail).not.toContain("sk-live");
  });

  it("still renders an ordinary error unchanged", async () => {
    const detail = await resumeFailureDetail(new Error("claude exited before init"));

    expect(detail).toBe("Error: claude exited before init");
  });
});

describe("ClaudeSessionUnavailableError", () => {
  it("rides an error code already registered in the driver namespace", () => {
    const error = new ClaudeSessionUnavailableError("no_live_run", { runId: TEST_RUN_ID });

    expect(error.code).toBe("driver.unavailable");
    expect(error.fields.driverId).toBe("claude");
    expect(error).toBeInstanceOf(Error);
  });
});

// --------------------------------------------------------------------------
// T3.15 — the R8 parity driver legs, Claude arm.
// --------------------------------------------------------------------------
//
// Spec coverage under test:
//   `Spec-005 §Interfaces And Contracts` — `rollbackTo` reports the `bindingId`
//     the daemon rebinds on; the goal operations answer the typed results.
//   `Spec-005 §Parity Capability Mechanism Grades` — this provider's EMULATED
//     cells: the goal as a spawn-bound system-prompt append, the concurrency cap
//     as a daemon-side boundary serialization, and the callback-tool registry as
//     a daemon-hosted ephemeral MCP server.
//   `Spec-012 §Required Behavior` — a registry with no dispatcher to adjudicate
//     through is withheld rather than offered.
//   `Spec-016 §Provider-Native Subagents` — a definition that cannot be held at
//     the daemon boundary is withheld and recorded, never silently admitted.
//   CP-005-1 — a rewind is a spawn, so it re-realizes every spawn-bound leg.

describe("ClaudeSessionLifecycle.rollbackTo (T3.15 leg 1, EMULATED as a fork)", () => {
  it("reports the rebinding `bindingId` on the applied arm", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());

    // The INPUT binding is deliberately NOT the minted one, so a driver that
    // echoed the caller's `bindingId` back — reporting the binding of the
    // process the rewind just replaced — fails here.
    const result = await harness.lifecycle.rollbackTo({
      sessionId: TEST_SESSION_ID,
      bindingId: "binding-predecessor",
      position: 4,
    });

    // The rewind relaunches the process, so the daemon rebinds onto a new one;
    // an applied rollback reporting the predecessor's binding would leave the
    // caller pointing at a process that is gone.
    expect(result).toStrictEqual({
      status: "applied",
      sessionPosition: 4,
      bindingId: TEST_BINDING_ID,
    });
  });

  it("refuses a rewind the provider answered with the SAME session id", async () => {
    // A rewind that answers with the id it was given did not fork: the
    // pre-rewind conversation the fork was supposed to preserve is gone.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.transport.announcedForkedProviderSessionId = TEST_PINNED_PROVIDER_SESSION_ID;

    const result = await harness.lifecycle.rollbackTo({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
      position: 4,
    });

    expect(result.status).toBe("degraded");
    expect((result as { fallbackAction: string }).fallbackAction).toContain("rewind-not-forked");
  });
});

describe("ClaudeSessionLifecycle session goals (T3.15 leg 2, EMULATED)", () => {
  it("answers `degraded` and names the boundary the goal binds at", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());

    const result = await harness.lifecycle.setSessionGoal({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
      runId: TEST_RUN_ID,
      goalText: "land the parity legs",
    });

    // The goal is realized as a system-prompt append, which is bound at process
    // start; answering `applied` would tell the daemon the session is governed
    // by an instruction its model has never seen.
    expect(result).toStrictEqual({
      status: "degraded",
      fallbackAction: "goal-appended-at-next-session-spawn",
    });
  });

  it("answers `applied` for a clear on a session that carried no goal", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());

    expect(
      await harness.lifecycle.clearSessionGoal({
        sessionId: TEST_SESSION_ID,
        bindingId: TEST_BINDING_ID,
        runId: TEST_RUN_ID,
      }),
    ).toStrictEqual({
      status: "applied",
    });
  });

  it("carries a goal recorded AFTER the spawn into the rewind's relaunch", async () => {
    // The rewind IS the "next session spawn" the set answer named. Reusing the
    // predecessor's legs verbatim would skip the very next spawn.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    await harness.lifecycle.setSessionGoal({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
      runId: TEST_RUN_ID,
      goalText: "land the parity legs",
    });

    await harness.lifecycle.rollbackTo({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
      position: 4,
    });

    expect(harness.transport.rewindRequests[0]?.goalText).toBe("land the parity legs");
  });

  it("does not RE-drop the goal on a second rewind", async () => {
    // The regression a verbatim leg reuse would leave: the first rewind picks
    // the goal up, and the second reads legs that must already carry it.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    await harness.lifecycle.setSessionGoal({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
      runId: TEST_RUN_ID,
      goalText: "land the parity legs",
    });

    await harness.lifecycle.rollbackTo({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
      position: 4,
    });
    await harness.lifecycle.rollbackTo({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
      position: 3,
    });

    expect(harness.transport.rewindRequests[1]?.goalText).toBe("land the parity legs");
  });
});

// --------------------------------------------------------------------------
// Auto-update suppression on every spawn-bound leg
// --------------------------------------------------------------------------

describe("ClaudeSessionLifecycle mandated spawn environment", () => {
  // Taken from the shared builder rather than written out, so this suite fails
  // if the driver stops routing through it — and pinned against the literal
  // pairs beside it, so a builder that returned nothing could not make both
  // sides vacuously agree.
  const MANDATED = buildProviderSpawnEnv({
    driverName: "claude",
    baseEnv: [],
    hostEnvNameMatch: hostEnvNameMatchForPlatform(process.platform),
  });

  it("realizes this provider's documented opt-out, presence-style", () => {
    expect(MANDATED).toEqual([
      ["DISABLE_AUTOUPDATER", "1"],
      ["DISABLE_UPDATES", "1"],
    ]);
  });

  it("carries it on a created session's spawn", async () => {
    const harness = buildHarness();

    await harness.lifecycle.createSession(buildCreateSessionParams());

    expect(harness.transport.spawnRequests[0]?.mandatedEnvironment).toEqual(MANDATED);
  });

  it("carries it on a resume, which is a fresh process and not a reattach", async () => {
    // The leg that would shed it. A resume relaunches the CLI, so suppression
    // bound at create and omitted here would expire at the first relaunch — and
    // `ResumeSessionParams` carries no config to rebuild it from.
    const harness = buildHarness();

    await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
    });

    expect(harness.transport.resumeRequests[0]?.mandatedEnvironment).toEqual(MANDATED);
  });

  it("carries it on a rewind, which spawns a forked process of its own", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());

    await harness.lifecycle.rollbackTo({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
      position: 4,
    });

    expect(harness.transport.rewindRequests[0]?.mandatedEnvironment).toEqual(MANDATED);
  });

  it("carries it on the auth probe, which starts a child of its own", async () => {
    // The fourth spawn path, and the one whose seam could not receive the pairs
    // at all until the probe took a request. It is also the path where losing
    // them costs most: a probe runs on a cadence and its child is short-lived,
    // so an unsuppressed probe can update the installation underneath the very
    // version and capability readings the next admission is decided against.
    const harness = buildHarness();

    const result = await harness.lifecycle.probeAuth();

    expect(harness.transport.probeAuthRequests[0]?.mandatedEnvironment).toEqual(MANDATED);
    // The double REFUSES a child started without them, so a passing probe is
    // itself evidence — an `indeterminate` here would mean the guard fired.
    expect(result.status).toBe("authenticated");
  });

  it("hands a resume the policy ref of the posture BEING RESUMED", async () => {
    // The Claude analogue of the codex resume fix, and a ROUTING assertion
    // rather than a strip assertion: the deny strip belongs to the transport
    // under the P0-4 obligation, so what this band owes is handing that
    // transport the ref of the posture the resume states. Both paths build
    // their legs from `params` through the one shared builder, which is why
    // there is no stale-policy path here to close — this pins that.
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
    // The other direction, which a "still carries a ref" assertion cannot
    // catch. `trusted` types `credentialPolicyRef?: never`, so settings
    // carrying one would hand the transport a policy to enforce that the
    // posture does not declare.
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

  it("cannot start a probe child without them — the guard, driven directly", async () => {
    // The negative control. Without it the arm above proves only that some
    // pairs were recorded, not that the transport double would object to their
    // absence, and a guard that never refuses makes every arm in this suite
    // vacuous.
    const harness = buildHarness();

    await expect(harness.transport.probeAuth({ mandatedEnvironment: [] })).rejects.toThrow(
      /without the mandated DISABLE_AUTOUPDATER=1/,
    );
  });
});

describe("ClaudeSessionLifecycle callback-tool registry (T3.15 leg 3, Claude arm)", () => {
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

    // Withheld rather than served-and-refused: a tool the model never learns
    // exists costs it no turns.
    const spawnRequest = harness.transport.spawnRequests[0];
    expect(spawnRequest?.callbackTools).toBeUndefined();
    expect(spawnRequest?.callbackToolServer).toBeUndefined();
    const withholdings = harness.diagnostics.recentRecordsOfKind("callback_tool_registry_withheld");
    expect(withholdings).toHaveLength(1);
    expect(withholdings[0]?.details["reason"]).toBe("no-dispatcher-bound");
  });

  it("injects NO registry when the bound transport does not realize the registration", async () => {
    // THE THIRD GATE. The first two questions — did the daemon offer tools, is
    // a dispatcher bound — are answerable from `params`. Whether the model ever
    // SEES the registry is a property of whichever transport writes the process
    // arguments, and left unasked it produced exactly the failure the Codex
    // pin-withholding exists to prevent: a live daemon-side registry for tools
    // the model was never told about, invisible because a tool the model never
    // calls looks identical to a tool it chose not to call.
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

  it("serves no registry and records nothing when no tools were offered", async () => {
    const harness = buildHarness();

    await harness.lifecycle.createSession(buildCreateSessionParams());

    expect(harness.transport.spawnRequests[0]?.callbackToolServer).toBeUndefined();
    expect(harness.diagnostics.recentRecordsOfKind("callback_tool_registry_withheld")).toHaveLength(
      0,
    );
  });
});

describe("composeClaudeCallbackMcpServer (T3.15 leg 3)", () => {
  it("mangles each tool into the provider-facing MCP name", () => {
    const descriptor = composeClaudeCallbackMcpServer([
      { name: "search_workspace", description: "d", inputSchema: {} },
    ]);

    expect(composeClaudeProviderToolName(descriptor.serverName, "search_workspace")).toBe(
      "mcp__sidekicks__search_workspace",
    );
    expect(descriptor.registryNamesByProviderName.get("mcp__sidekicks__search_workspace")).toBe(
      "search_workspace",
    );
  });

  it("maps EVERY served tool back, so no invocation can arrive unmappable", () => {
    const tools = ["alpha", "beta", "gamma"].map((name) => ({
      name,
      description: name,
      inputSchema: {},
    }));

    const descriptor = composeClaudeCallbackMcpServer(tools);

    expect(descriptor.registryNamesByProviderName.size).toBe(descriptor.tools.length);
    for (const tool of descriptor.tools) {
      const providerName = composeClaudeProviderToolName(descriptor.serverName, tool.name);
      expect(descriptor.registryNamesByProviderName.get(providerName)).toBe(tool.name);
    }
  });

  it("de-duplicates a repeated name last-wins rather than serving it twice", () => {
    // Serving one provider-facing name twice would make the reverse map's answer
    // depend on iteration order.
    const descriptor = composeClaudeCallbackMcpServer([
      { name: "search", description: "first", inputSchema: {} },
      { name: "search", description: "second", inputSchema: {} },
    ]);

    expect(descriptor.tools).toHaveLength(1);
    expect(descriptor.tools[0]?.description).toBe("second");
  });
});

describe("ClaudeSubagentConcurrencyGate (T3.15 leg 4)", () => {
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
    // The hand-over race: a release that decremented and then woke a waiter in a
    // microtask leaves a window in which a THIRD caller reads a free slot the
    // waiter has already been promised.
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

    // A waiter set resolved in arbitrary order starves whichever subagent is
    // unlucky, inside a run that has a wall-clock budget.
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

  it("records a breach at most once per new ceiling", () => {
    const { gate, diagnostics } = buildGate(2);

    gate.observeLiveSubagentCount(3);
    gate.observeLiveSubagentCount(3);
    gate.observeLiveSubagentCount(4);
    gate.observeLiveSubagentCount(2);

    // The provider can create subagents without any of them calling a tool, so
    // the daemon can see more live subagents than the gate ever admitted. That
    // is a breach, it is recorded, and it never fails a run.
    const breaches = diagnostics.recentRecordsOfKind("subagent_concurrency_breach");
    expect(breaches).toHaveLength(2);
    expect(breaches.map((record) => record.details["liveSubagentCount"])).toStrictEqual([3, 4]);
  });
});

/** The realized depth ceiling on a spawn's enabled policy, or `undefined`. */
function readRealizedMaxDepth(harness: LifecycleHarness): number | undefined {
  const policy = harness.transport.spawnRequests[0]?.subagentPolicy;
  return policy?.enabled === true ? policy.maxDepth : undefined;
}

describe("ClaudeSessionLifecycle subagent admission wiring (T3.15 leg 4)", () => {
  const ENABLED_POLICY: SubagentPolicy = {
    enabled: true,
    maxConcurrent: 2,
    maxDepth: 1,
    definitions: [],
  };

  it("installs a gate for an enabled policy and none for a disabled one", async () => {
    const enabledHarness = buildHarness();
    await enabledHarness.lifecycle.createSession({
      ...buildCreateSessionParams(),
      subagentPolicy: ENABLED_POLICY,
    });
    const disabledHarness = buildHarness();
    await disabledHarness.lifecycle.createSession({
      ...buildCreateSessionParams(),
      subagentPolicy: { enabled: false },
    });

    expect(enabledHarness.transport.spawnRequests[0]?.subagentAdmission).toBeDefined();
    expect(disabledHarness.transport.spawnRequests[0]?.subagentAdmission).toBeUndefined();
  });

  it("installs a FRESH gate on a rewind rather than carrying the predecessor's", async () => {
    // A rewind relaunches the process, so every subagent the old gate held slots
    // for died with it; carrying it forward would hold a permanently reduced cap
    // against calls that no longer exist.
    const harness = buildHarness();
    await harness.lifecycle.createSession({
      ...buildCreateSessionParams(),
      subagentPolicy: ENABLED_POLICY,
    });
    const predecessorGate = harness.transport.spawnRequests[0]?.subagentAdmission;
    await predecessorGate?.admit("held-across-the-rewind");

    await harness.lifecycle.rollbackTo({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
      position: 4,
    });

    const rewoundGate = harness.transport.rewindRequests[0]?.subagentAdmission;
    expect(rewoundGate).toBeDefined();
    expect(rewoundGate).not.toBe(predecessorGate);
    // And the predecessor's own waiters are failed rather than left hanging on a
    // process that is gone.
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
          // `bypassPermissions` skips the daemon's interception point, so this
          // definition's beyond-cap calls could not be held at a boundary that
          // is not there.
          { name: "unmediated", permissionMode: "bypassPermissions" },
          { name: "mediated", permissionMode: "default" },
        ],
      },
    });

    const withheld = harness.diagnostics.recentRecordsOfKind("subagent_definition_disabled");
    expect(withheld).toHaveLength(1);
    expect(withheld[0]?.details["definitionName"]).toBe("unmediated");
    // The admitted one still ships: withholding is per-definition, not per-spawn.
    const realizedPolicy = harness.transport.spawnRequests[0]?.subagentPolicy;
    expect(
      realizedPolicy?.enabled === true
        ? realizedPolicy.definitions.map((definition) => definition.name)
        : undefined,
    ).toStrictEqual(["mediated"]);
  });

  it("clamps the depth ceiling while honouring a policy that asked for less", async () => {
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

describe("composeClaudeSandboxSettings (T3.15 leg 5)", () => {
  it("pins the always-armed permission prompt on every sandboxed arm", () => {
    // RATIFIED MAPPING (user decision, 2026-08-25): `supervised` maps to
    // `on-request` UNCONDITIONALLY. On this provider that is realized as
    // `allowUnsandboxedCommands: false`, so no tool call reaches the model's
    // hands without passing the daemon.
    for (const posture of [SANDBOXED_POSTURE, READONLY_POSTURE]) {
      const settings = composeClaudeSandboxSettings(posture);
      expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
      expect(settings.sandbox.enabled).toBe(true);
      // A host whose sandbox cannot be brought up must REFUSE to start rather
      // than start unsandboxed under a recorded sandboxed posture.
      expect(settings.sandbox.failIfUnavailable).toBe(true);
    }
  });

  it("writes nowhere on the read-only arm, with an EMPTY list rather than an omitted one", () => {
    // An omitted list requests the provider's default, which is a different
    // statement from "writes nowhere".
    expect(
      composeClaudeSandboxSettings(READONLY_POSTURE).sandbox.filesystem.allowWrite,
    ).toStrictEqual([]);
  });

  it("omits the network restriction entirely for `full`, and empties it for `none`", () => {
    const trusted = composeClaudeSandboxSettings(TRUSTED_POSTURE);
    const denied = composeClaudeSandboxSettings(SANDBOXED_POSTURE);

    // The ABSENCE is the statement; an empty list would mean the opposite.
    expect(trusted.sandbox.network).toBeUndefined();
    expect(denied.sandbox.network).toStrictEqual({ allowedDomains: [] });
  });
});

// ---------------------------------------------------------------------------
// T3.11 — the routing / metering band, driven through the REAL inbound seam.
// ---------------------------------------------------------------------------
//
// The double honours the whole `onInboundFrame` transport obligation: it
// observes before projecting and projects only on `project`. So these assert
// what a real transport would do with the driver's answer, not what a test
// helper decided to record.

describe("ClaudeSessionLifecycle thread routing and usage metering (T3.11, I-005-11, I-005-12)", () => {
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

    // GONE, not replaced. The accessors are non-creating, so a read after the
    // close answers `undefined` rather than minting a fresh band nothing will
    // ever delete — per-provider-session state accumulating for a session that
    // no longer exists, and a router that would answer the next session with a
    // thread registry that session never made.
    expect(harness.lifecycle.usageAccountantFor(TEST_SESSION_ID)).toBeUndefined();
    expect(harness.lifecycle.frameRouterFor(TEST_SESSION_ID)).toBeUndefined();
  });

  it("the band is built at registration, so it exists for a live session and not before one", async () => {
    const harness = buildRoutingHarness();

    // Nothing has been established, so nothing holds a band. A get-or-create
    // accessor would answer here and leave a band behind for a session that was
    // never created.
    expect(harness.lifecycle.frameRouterFor(TEST_SESSION_ID)).toBeUndefined();

    await liveChannel(harness);

    expect(harness.lifecycle.frameRouterFor(TEST_SESSION_ID)?.pendingHeldFrameCount()).toBe(0);
    expect(harness.lifecycle.usageAccountantFor(TEST_SESSION_ID)).toBeDefined();
  });

  it("(a) a frame naming a FOREIGN thread never projects", async () => {
    const harness = buildRoutingHarness();
    const channel = await liveChannel(harness);

    const route = channel.emitStreamFrame("system/task_progress", {
      subagentId: "some-unannounced-subagent",
    });

    expect(route.decision).toBe("held-pending-registration");
    expect(channel.deliveredFrameKinds).toStrictEqual([]);
  });

  it("(b) a usage frame meters a per-turn DELTA, never the cumulative counter", async () => {
    const harness = buildRoutingHarness();
    const channel = await liveChannel(harness);

    channel.emitStreamFrame("system/task_progress", usageObservation(100));
    channel.emitStreamFrame("system/task_progress", usageObservation(150));

    // This provider reports a running total that resets at no turn boundary.
    // 150 is the session's whole spend; 50 is what the second turn cost.
    expect(harness.meteredUsage.map((entry) => entry.delta.axisDeltas.input)).toEqual([100, 50]);
  });

  it("(c) an announced child's content is suppressed while its spend carves through", async () => {
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
    // The announcement rides the control channel, which is connection-scoped
    // and therefore delivered; what never reaches the consumer is the child's
    // own CONTENT frame, and neither `system/task_progress` is here.
    expect(channel.deliveredFrameKinds).toStrictEqual(["control_request/hook_callback"]);
    expect(harness.meteredUsage).toHaveLength(1);
    expect(harness.meteredUsage[0]?.delta.threadId).toBe(CHILD_SUBAGENT_ID);
    expect(harness.meteredUsage[0]?.delta.axisDeltas.input).toBe(40);
  });

  it("(d) the session's own terminal projects, and reaches the turn-terminal hook", async () => {
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
    // Projected AND consumed: the route retired, which is the terminal's whole
    // job on this provider (a channel-level interrupt must not outlive its turn).
    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeUndefined();
  });

  it("the eleventh I-005-12 case: a fully suppressed child still leaves its started/completed pair", async () => {
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

    // No child content on the parent's timeline — the two delivered frames are
    // the child's own start/stop announcements, which ride the connection-scoped
    // control channel; both `system/*` child frames were suppressed.
    expect(channel.deliveredFrameKinds).toStrictEqual([
      "control_request/hook_callback",
      "control_request/hook_callback",
    ]);
    // ...and yet the child is not invisible: this pair is its whole presence.
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
    // The provider re-announces a child it already announced. Re-establishing
    // here would zero the base mid-stream, so the 150 reading below would meter
    // 150 rather than the 50 the child actually spent since.
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

    // The child's first usage frame arrives before the `SubagentStart` that
    // announces it — the exact race the pending hold exists for.
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

    // Released, then routed for real: the spend that raced the announcement is
    // charged rather than shed at the hold timeout.
    expect(harness.meteredUsage).toHaveLength(1);
    expect(harness.meteredUsage[0]?.delta.axisDeltas.input).toBe(40);
    // And the decision reached a consumer. A released frame has no observer
    // call in flight to answer, so without this seam its route would have been
    // computed and then dropped.
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

    // This provider carries tool-approval asks on the control channel, which is
    // a connection-level discipline in both directions and carries no thread
    // identity. So the ask routes without one and stays answerable — the same
    // outcome the child carve-out buys on a provider that DOES thread them.
    const route = channel.emitStreamFrame("control_request/can_use_tool", {
      subagentId: CHILD_SUBAGENT_ID,
    });
    expect(route.decision).toBe("route-connection-scoped");
    // Answerable means DELIVERED. The provider is blocking on the answer to
    // this ask, so a transport that withheld it on anything but `project` would
    // hang the child's tool call rather than hide it.
    expect(channel.deliveredFrameKinds).toContain("control_request/can_use_tool");
  });

  it("connection-scoped telemetry reaches the normalize consumer rather than being withheld", async () => {
    const harness = buildRoutingHarness();
    const channel = await liveChannel(harness);

    // Neither frame names a thread and neither is `project`. They are the
    // session's rate-limit and retry telemetry: withholding them would leave
    // the read model unable to say the provider is throttling at all.
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

    const rollback = harness.lifecycle.rollbackTo({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
      position: 4,
    });
    // The claim is written synchronously, but the tick makes the ordering an
    // assertion of the test rather than of the implementation's call shape.
    await Promise.resolve();

    // The predecessor's process is still up and still emitting for the whole
    // multi-second fork. Quarantining these would put a hole in the transcript
    // of a session that — if the fork below failed — simply continues.
    const duringRewind = predecessorChannel.emitStreamFrame(
      "system/task_progress",
      usageObservation(30),
    );
    expect(duringRewind.decision).toBe("project");
    expect(harness.meteredUsage[0]?.delta.axisDeltas.input).toBe(30);

    releaseRewind();
    expect((await rollback).status).toBe("applied");

    // Once the successor is installed the predecessor is no longer the bound
    // channel, so the narrower rule takes over again: an undead process emitting
    // into a slot it no longer holds is refused rather than projected.
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

    const rollback = harness.lifecycle.rollbackTo({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
      position: 4,
    });
    await Promise.resolve();
    predecessorChannel.emitStreamFrame("system/task_progress", usageObservation(30));

    releaseRewind();
    expect((await rollback).status).toBe("degraded");
    predecessorChannel.emitStreamFrame("system/task_progress", usageObservation(75));

    // Non-destructive on failure has to mean the TRANSCRIPT too: the session is
    // running, startable, un-rewound — and every frame it emitted across the
    // failed attempt was routed and metered rather than diagnosed away.
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

    // Unbound reader: the daemon's own emitted sum could not be rebuilt at all,
    // so the base is zero and the first reading re-meters the pre-resume total.
    expect(harness.diagnostics.recentRecordsOfKind("usage_resume_base_unavailable")).toHaveLength(
      1,
    );
  });

  it("a bound reader answering NOTHING bases at zero silently — that is a correct answer", async () => {
    const harness = buildRoutingHarness({ readPriorEmittedUsage: () => undefined });
    await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
      executionPosture: SANDBOXED_POSTURE,
    });
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("unreachable: the resume must have adopted a channel");
    }

    channel.emitStreamFrame("system/task_progress", usageObservation(20));

    // A session that legitimately emitted no spend HAS a prior-emitted sum, and
    // it is zero. Recording that as unavailable would fire the diagnostic on
    // every ordinary rewind and tell an operator nothing about any of them.
    expect(harness.diagnostics.recentRecordsOfKind("usage_resume_base_unavailable")).toStrictEqual(
      [],
    );
    expect(harness.meteredUsage[0]?.delta.axisDeltas.input).toBe(20);
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

    // The throw happens inside the adoption invariant's window, where escaping
    // would orphan a resumed, running provider process. Over-metering is
    // recoverable from the record; an orphaned process is not.
    expect(result.status).toBe("resumed");
    expect(harness.diagnostics.recentRecordsOfKind("usage_resume_base_unavailable")).toHaveLength(
      1,
    );
  });

  it("a REWIND bases on the PREDECESSOR's prior-emitted sum, not the fork's brand-new id", async () => {
    // Keyed by thread id on purpose: a reader answering the same sum for every
    // id would pass with the successor's own id keying the lookup, which is the
    // exact defect this asserts against. Only the predecessor has a sum.
    const harness = buildRoutingHarness({
      readPriorEmittedUsage: (_sessionId, threadId) =>
        threadId === TEST_PINNED_PROVIDER_SESSION_ID ? { input: 500 } : undefined,
    });
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.transport.announcedForkedProviderSessionId = "forked-provider-session";

    const rollback = await harness.lifecycle.rollbackTo({
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

    // 20, not 520: the pre-rewind spend the daemon already emitted is not
    // charged a second time. And the routine rewind path records nothing — the
    // resume-base diagnostic is reserved for a reader that could not answer.
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

// ---------------------------------------------------------------------------
// The pending-frame settlement matrix (T3.18).
//
// The invariant, stated once and enforced by ENUMERATION rather than by
// whichever cell a review happened to name: no reachable lifecycle transition
// leaves a frame whose delivery was never proven both unruled and unreported.
// Every row below drives one transition against a session that is holding a
// pending opening frame, and every row declares which of four settlements the
// surrounding contract owes for that cell. A transition added to this driver
// without a row here is the gap this table exists to make loud.
//
// Four settlements, and the distinctions between them are the adjudication:
//
//   * `provider-evidence` — the provider's own terminal accounted for the turn,
//     so the frame is ruled by the ordinary path and nothing is owed.
//   * `run-failure` — the binding was taken away from a turn that was still
//     live, so the frame can never be ruled by a terminal and the run is owed a
//     visible failure naming why.
//   * `refusal` — the transition is refused while the frame is pending, so the
//     binding is untouched and the frame stays watched.
//   * `daemon-intent` — the daemon itself destroyed the session, so the run's
//     ending is a consequence of an act the initiator already holds a record
//     of, and a driver-composed failure would be a second record of it.
// ---------------------------------------------------------------------------

/** A `result` body a real classifier reads as carrying no turn evidence at all. */
const ZERO_TURN_RESULT_BODY: Record<string, unknown> = {
  type: "result",
  subtype: "success",
  num_turns: 0,
};

type PendingFrameSettlement =
  | {
      readonly kind: "run-failure";
      /** In report order — the table asserts the order, not merely the set. */
      readonly runIds: readonly RunId[];
      readonly detailContains: string;
    }
  | { readonly kind: "refusal" }
  | { readonly kind: "provider-evidence" }
  | { readonly kind: "daemon-intent" };

interface DrivenTransitionOutcome {
  readonly threw: unknown;
  readonly returned: unknown;
}

async function captureTransition(drive: () => Promise<unknown>): Promise<DrivenTransitionOutcome> {
  return await drive().then(
    (returned) => ({ threw: undefined, returned }),
    (threw: unknown) => ({ threw, returned: undefined }),
  );
}

interface PendingFrameTransitionCase {
  readonly label: string;
  readonly drive: (
    harness: LifecycleHarness,
    channel: FakeClaudeSessionChannel,
  ) => Promise<DrivenTransitionOutcome>;
  readonly expected: PendingFrameSettlement;
}

const PENDING_FRAME_TRANSITIONS: readonly PendingFrameTransitionCase[] = [
  {
    label: "a turn terminal carrying model output",
    drive: async (_harness, channel) =>
      await captureTransition(() => Promise.resolve(channel.emitStreamFrame("result/success"))),
    expected: { kind: "provider-evidence" },
  },
  {
    label: "a turn terminal carrying no evidence at all",
    drive: async (_harness, channel) => {
      channel.terminalFrameBody = ZERO_TURN_RESULT_BODY;
      return await captureTransition(() =>
        Promise.resolve(channel.emitStreamFrame("result/success")),
      );
    },
    expected: {
      kind: "run-failure",
      runIds: [TEST_RUN_ID],
      detailContains: "driver.text_neutralization_failed",
    },
  },
  {
    label: "an interrupt, then the interrupted turn's own terminal",
    drive: async (harness, channel) =>
      await captureTransition(async () => {
        await harness.lifecycle.interruptRun({ runId: TEST_RUN_ID });
        return channel.emitStreamFrame("result/success");
      }),
    expected: { kind: "provider-evidence" },
  },
  {
    label: "a SECOND run's start while the first frame is still pending",
    drive: async (harness) =>
      await captureTransition(async () => {
        // Refused by the session-serialization guard before a byte is
        // composed: with no run id on the settling envelope, a second run's
        // frame in this scope could only ever be ruled unrecognized — the
        // false trip the guard exists to prevent. The first run's frame stays
        // watched, still owed its own ruling, and this cell's refusal
        // expectation is what proves the guard fired instead of the write.
        harness.runDispatchResolver.dispatchByRunId.set(TEST_SECOND_RUN_ID, {
          sessionId: TEST_SESSION_ID,
          openingText: "and now the second directive",
        });
        return await harness.lifecycle.startRun({
          ...buildStartRunParams(),
          runId: TEST_SECOND_RUN_ID,
        });
      }),
    expected: { kind: "refusal" },
  },
  {
    label: "an overlapping start on the SAME run whose write is refused before a byte leaves",
    drive: async (harness, channel) =>
      await captureTransition(async () => {
        // A retry beside the attempt it retries. Both frames carry one run id,
        // so both share the single run-keyed route — and the refused one is
        // withdrawn frame-scoped while the accepted one is still on the wire and
        // still owed a ruling. Deleting the route unconditionally here retires
        // the ACCEPTED frame's only correlation, and the terminal below then
        // finds no correlated run to rule.
        channel.sendUserTextFailure = new Error("refused before a byte left");
        channel.sendUserTextDelivery = "unsent";
        await harness.lifecycle.startRun(buildStartRunParams()).then(
          () => {
            throw new Error("unreachable: a refused write must reject its caller");
          },
          () => undefined,
        );
        channel.sendUserTextFailure = undefined;
        channel.sendUserTextDelivery = "indeterminate";
        // The FIRST frame is still unaccounted for, so a terminal carrying no
        // turn evidence is its ruling — the ordinary path, reached only if the
        // route survived the withdrawal above.
        channel.terminalFrameBody = ZERO_TURN_RESULT_BODY;
        return channel.emitStreamFrame("result/success");
      }),
    expected: {
      kind: "run-failure",
      runIds: [TEST_RUN_ID],
      detailContains: "driver.text_neutralization_failed",
    },
  },
  {
    label: "a rewind that supersedes the binding the frame was written on",
    drive: async (harness) =>
      await captureTransition(
        async () =>
          await harness.lifecycle.rollbackTo({
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
    label: "a resume attempted beside the live binding",
    drive: async (harness) =>
      await captureTransition(
        async () =>
          await harness.lifecycle.resumeSession({
            sessionId: TEST_SESSION_ID,
            resumeHandle: TEST_PINNED_PROVIDER_SESSION_ID,
          }),
      ),
    expected: { kind: "refusal" },
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

describe("ClaudeSessionLifecycle pending-frame settlement matrix (T3.18)", () => {
  async function arrangePendingFrame(harness: LifecycleHarness): Promise<FakeClaudeSessionChannel> {
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
    // The premise every row runs against: the bytes are on the wire and no
    // terminal has accounted for them.
    expect(channel.sentWireTexts).toHaveLength(1);
    expect(harness.textNeutralizationFailures).toStrictEqual([]);
    return channel;
  }

  async function assertSettlement(
    harness: LifecycleHarness,
    outcome: DrivenTransitionOutcome,
    expected: PendingFrameSettlement,
  ): Promise<void> {
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
    // Every remaining settlement owes NO driver-composed failure, and each owes
    // a different second thing — which is what keeps the three from collapsing
    // into one assertion that any of them would pass.
    expect(harness.textNeutralizationFailures).toStrictEqual([]);
    if (expected.kind === "refusal") {
      const returned = outcome.returned;
      const refusedByArm =
        typeof returned === "object" && returned !== null && "status" in returned
          ? (returned as { readonly status: unknown }).status === "failed"
          : false;
      expect(outcome.threw !== undefined || refusedByArm).toBe(true);
      // The binding was NOT taken away, so the frame is still watched and the
      // run still resolves to the channel it was written on.
      expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeDefined();
      return;
    }
    expect(outcome.threw).toBeUndefined();
    if (expected.kind === "provider-evidence") {
      // The RUN ended and the SESSION did not. Proven by STARTING a next run on
      // the same binding and watching its bytes reach the wire, rather than by
      // asking whether a run that never dispatched has a channel — which is
      // `undefined` on a healthy session and on a condemned one alike.
      expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeUndefined();
      harness.runDispatchResolver.dispatchByRunId.set(TEST_SECOND_RUN_ID, {
        sessionId: TEST_SESSION_ID,
        openingText: "carry on",
      });
      await harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID });
      // The first entry is the neutralized form of the opening text this suite
      // arranges; the second is the follow-on run's, delivered verbatim because
      // it is not command-shaped. Both reaching the wire is the proof.
      expect(harness.transport.spawnedChannels[0]?.sentWireTexts).toStrictEqual([
        "\n/compact the thread please",
        "carry on",
      ]);
      return;
    }
    // `daemon-intent`: the session is gone, which is the record of the ending.
    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeUndefined();
  }

  for (const transitionCase of PENDING_FRAME_TRANSITIONS) {
    it(`settles a pending frame through ${transitionCase.expected.kind} on ${transitionCase.label}`, async () => {
      const harness = buildHarness();
      const channel = await arrangePendingFrame(harness);

      const outcome = await transitionCase.drive(harness, channel);

      await assertSettlement(harness, outcome, transitionCase.expected);
    });
  }

  it("covers every settlement kind, so no kind is enumerated and never driven", () => {
    // The table's own negative control. A row deleted or retyped to the
    // convenient settlement would otherwise shrink the matrix silently.
    expect(new Set(PENDING_FRAME_TRANSITIONS.map((row) => row.expected.kind))).toStrictEqual(
      new Set(["provider-evidence", "run-failure", "refusal", "daemon-intent"]),
    );
  });
});

// The route is RUN-keyed and the registration is FRAME-keyed, so the unsent arm
// has to decide between them. These two cases pin both directions of that
// decision: the deletion still happens where it was always right, and stops
// happening where it took a sibling's correlation with it. A guard asked in the
// wrong order passes one and fails the other, which is why neither alone is
// enough.
describe("ClaudeSessionLifecycle unsent opening frame — route retirement (T3.18)", () => {
  async function arrangeSession(harness: LifecycleHarness): Promise<FakeClaudeSessionChannel> {
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "/compact the thread please",
    });
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("unreachable: the session must have spawned a channel");
    }
    return channel;
  }

  it("retires the route when the refused write was the run's ONLY frame", async () => {
    const harness = buildHarness();
    const channel = await arrangeSession(harness);
    channel.sendUserTextFailure = new Error("refused before a byte left");
    channel.sendUserTextDelivery = "unsent";

    await expect(harness.lifecycle.startRun(buildStartRunParams())).rejects.toThrow();

    // No turn can ever exist for this run, so a surviving route would aim a
    // later CHANNEL-scoped interrupt at whatever older turn the channel is
    // genuinely running.
    expect(channel.sentWireTexts).toStrictEqual([]);
    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeUndefined();
  });

  it("keeps the accepted frame's route when a duplicate dispatch is refused", async () => {
    // This test once drove the unsent arm of the failed-opening-frame ruling —
    // a second same-run frame whose write dies before a byte leaves, withdrawn
    // while its sibling's route survives. The duplicate-dispatch guard now
    // refuses that second start BEFORE compose and register, so the arm is
    // unreachable through startRun and the sibling-aware predicate it consults
    // is pinned at the tripwire unit level instead (outbound-frame.test.ts).
    // What this test still owns: the refusal names the run-keyed cause and
    // leaves the accepted frame's write and route untouched — that route is
    // the only way its terminal will be found.
    const harness = buildHarness();
    const channel = await arrangeSession(harness);
    await harness.lifecycle.startRun(buildStartRunParams());
    expect(channel.sentWireTexts).toHaveLength(1);

    await expect(harness.lifecycle.startRun(buildStartRunParams())).rejects.toMatchObject({
      code: "driver.unavailable",
      fields: { reason: "run_already_dispatched" },
    });

    expect(channel.sentWireTexts).toHaveLength(1);
    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeDefined();
  });
});

// --------------------------------------------------------------------------
// T3.22 — the transient arm at the Claude dispatch seam
// --------------------------------------------------------------------------
//
// `unsent` is the one delivery on this leg that is a POSITIVE claim about bytes:
// the provider saw nothing, so no turn exists on account of the frame and a
// re-send duplicates neither a turn nor its spend. Every other delivery here is
// `indeterminate`, and the ladder must not touch it — the whole point of the
// classification is that the two classes are provably distinguishable rather
// than merged into one hopeful retry.
describe("ClaudeSessionLifecycle definitely-unsent dispatch retry (T3.22)", () => {
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

    // BOUNDED, and the bound is the assertion. A ladder with no ceiling would
    // spin against a permanently-unwritable channel; one rung is what the
    // transient class is worth.
    expect(channel.sendUserTextAttempts).toBe(MAX_DEFINITELY_UNSENT_DISPATCH_ATTEMPTS);
    // Nothing reached the provider on either rung, which is what makes the
    // re-send free of duplicates rather than merely unlikely to produce one.
    expect(channel.sentWireTexts).toStrictEqual([]);
    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeUndefined();
  });

  it("starts the run when the second attempt succeeds, writing the text ONCE", async () => {
    const harness = buildHarness();
    const channel = await arrangeSession(harness);
    channel.sendUserTextFailure = new Error("refused before a byte left");
    channel.sendUserTextDelivery = "unsent";
    // The transport recovers after the first rung, which is the case a ladder
    // exists for at all — a permanently-failing write only ever proves it stops.
    channel.onSendUserTextAttempt = (attemptNumber): void => {
      if (attemptNumber === 2) {
        channel.sendUserTextFailure = undefined;
      }
    };

    await harness.lifecycle.startRun(buildStartRunParams());

    expect(channel.sendUserTextAttempts).toBe(2);
    // ONE frame on the wire, not two: the first rung's bytes never left, so the
    // participant's text is delivered exactly once.
    expect(channel.sentWireTexts).toStrictEqual(["please summarize the thread"]);
    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeDefined();
  });

  it("never re-attempts an INDETERMINATE write", async () => {
    const harness = buildHarness();
    const channel = await arrangeSession(harness);
    channel.sendUserTextFailure = new Error("the write rejected mid-line");
    channel.sendUserTextDelivery = "indeterminate";

    await expect(harness.lifecycle.startRun(buildStartRunParams())).rejects.toThrow();

    // The two classes are distinguishable, and this is the half that proves it:
    // the bytes may have reached a child that read the newline, so a re-send
    // risks a duplicate turn and duplicate spend against a turn nobody can see.
    expect(channel.sendUserTextAttempts).toBe(1);
    expect(channel.sentWireTexts).toStrictEqual([]);
  });

  it("never re-attempts a write the transport REJECTED instead of reporting", async () => {
    const harness = buildHarness();
    const channel = await arrangeSession(harness);
    // A transport in breach of the port's obligation. A rejection carries no
    // claim about bytes, and `unsent` is precisely a claim about bytes, so the
    // containment must land on the fail-closed arm and stay off the ladder.
    channel.sendUserTextRejection = new Error("transport rejected the write");

    await expect(harness.lifecycle.startRun(buildStartRunParams())).rejects.toThrow();

    expect(channel.sendUserTextAttempts).toBe(1);
  });
});

// The condemnation arm of the failed opening write, driven from the only place
// it can still be reached now that starts are session-serialized: the FIRST
// write on a session dying with indeterminate delivery on a channel that is
// already closed. The bytes may have left and no terminal will ever arrive, so
// retention cannot cover it — the frame is ruled fail-closed and the binding is
// condemned, because silence here is exactly a swallowed directive escaping
// detection.
describe("ClaudeSessionLifecycle indeterminate opening-write death (T3.18)", () => {
  it("rules the frame fail-closed and condemns the binding on both axes", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "/compact the thread please",
    });
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("unreachable: the session must have spawned a channel");
    }
    channel.isClosed = true;
    channel.sendUserTextFailure = new Error("the channel died mid-write");

    await expect(harness.lifecycle.startRun(buildStartRunParams())).rejects.toThrow(
      "the channel died mid-write",
    );

    expect(harness.textNeutralizationFailures.map((failure) => failure.runId)).toStrictEqual([
      TEST_RUN_ID,
    ]);
    expect(harness.textNeutralizationFailures[0]?.providerFailureDetail).toContain(
      "driver.text_neutralization_failed",
    );
    // Condemned on the SESSION axis too: the next run cannot dispatch into the
    // process whose delivery is in doubt.
    harness.runDispatchResolver.dispatchByRunId.set(TEST_SECOND_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "carry on",
    });
    await expect(
      harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID }),
    ).rejects.toThrow();
  });
});

describe("ClaudeSessionLifecycle rewind supersede (T3.18)", () => {
  async function arrangePendingFrameAcrossRewind(harness: LifecycleHarness): Promise<void> {
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "/compact the thread please",
    });
    await harness.lifecycle.startRun(buildStartRunParams());
    await harness.lifecycle.rollbackTo({
      sessionId: TEST_SESSION_ID,
      bindingId: "binding-predecessor",
      position: 4,
    });
  }

  it("does NOT condemn the superseded run, whose future work belongs to the fresh binding", async () => {
    const harness = buildHarness();
    await arrangePendingFrameAcrossRewind(harness);

    // A quarantine condemns a BINDING, and the superseded one is already gone.
    // Refusing the run would take its interrupt and intervention controls away
    // for a process nobody can reach anyway.
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
    // The negative control the supersede sweep needs: an ordinary rewind of an
    // idle session must stay silent, or the fix would fail every rewind.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());

    await harness.lifecycle.rollbackTo({
      sessionId: TEST_SESSION_ID,
      bindingId: "binding-predecessor",
      position: 4,
    });

    expect(harness.textNeutralizationFailures).toStrictEqual([]);
  });

  it("reports NOTHING for a rewind whose pending frame the turn's own terminal already settled", async () => {
    // The second half of the same control: a frame the ordinary path consumed
    // is not owed a supersede failure on top of the ruling it already had.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "/compact the thread please",
    });
    await harness.lifecycle.startRun(buildStartRunParams());
    harness.transport.spawnedChannels[0]?.emitStreamFrame("result/success");

    await harness.lifecycle.rollbackTo({
      sessionId: TEST_SESSION_ID,
      bindingId: "binding-predecessor",
      position: 4,
    });

    expect(harness.textNeutralizationFailures).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Console parity — `Spec-005 §Desktop Console Parity Surfaces` (T3.26)
// ---------------------------------------------------------------------------

/**
 * A hand-fired stand-in for the declared compaction bound.
 *
 * Records rather than merely honours: a test that only fired timers could not
 * tell a wait that was never armed from one that was armed and cancelled, and
 * the binding-loss leg's whole claim is that it settles WITHOUT the timer ever
 * running.
 */
interface ManualCompactionScheduler {
  readonly schedule: CompactionWaitScheduler;
  fireAll(): void;
  armedCount(): number;
  armedDelays(): number[];
  cancelledCount(): number;
}

function makeManualCompactionScheduler(): ManualCompactionScheduler {
  const armed: Array<{ readonly callback: () => void; readonly delayMs: number }> = [];
  let cancelledCount = 0;
  return {
    schedule: (callback, delayMs) => {
      armed.push({ callback, delayMs });
      return (): void => {
        cancelledCount += 1;
      };
    },
    fireAll: () => {
      for (const entry of [...armed]) {
        entry.callback();
      }
    },
    armedCount: () => armed.length,
    armedDelays: () => armed.map((entry) => entry.delayMs),
    cancelledCount: () => cancelledCount,
  };
}

// The measured shape of a live `system/init` frame, first-party against the
// pinned build: `slash_commands` and `skills` carry BARE names, and
// `terminal_slash_commands` is a separate member holding the two names that run
// only in the provider's own terminal UI.
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

// The daemon resolves a run onto a session; the driver never invents one. Every
// console-parity test that needs a LIVE TURN arms this first.
function armRunDispatch(harness: LifecycleHarness, runId: RunId): void {
  harness.runDispatchResolver.dispatchByRunId.set(runId, {
    sessionId: TEST_SESSION_ID,
    openingText: "keep going",
  });
}

async function drainMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("ClaudeSessionLifecycle.compactContext — the two substitute guards", () => {
  it("refuses `command_absent` and SENDS NOTHING when the provider does not enumerate the command", async () => {
    // Guard one, standing alone. The dispatched frame is tripwire-exempt, so a
    // driver that discovered the command's absence AFTER writing would have put
    // provider-interpreted text on the wire with nothing watching it.
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
    // Nothing was armed either: an armed wait would burn the declared bound for
    // a dispatch that never happened.
    expect(scheduler.armedCount()).toBe(0);
  });

  it("refuses `command_absent` before the handshake has been observed at all", async () => {
    // The fail-closed reading of "not yet known". The driver cannot prove the
    // command exists, so it does not send one.
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
    // A rewind forks a new provider process behind the same canonical session
    // id, and the fork publishes its own handshake. Answering from the dead
    // process's enumeration would dispatch a command the live binding may not
    // have, so the refusal — not the palette — is the contract here.
    //
    // Two mechanisms produce it and the test does not pretend to separate them:
    // `#registerLiveSession` clears the record when it adopts the fork, and the
    // read-side stamp would refuse the predecessor's record if it survived.
    // Mutating either alone leaves this green; the assertion is on the outcome.
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
    // The fork announces its own id by default, so the held stamp no longer
    // matches the live session.
    await harness.lifecycle.rollbackTo({
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
    // Disposal races in-flight frames: a predecessor channel can deliver a
    // `system/init` the provider had already written AFTER its successor is
    // live. The end state asserted here is that such a frame installs NOTHING —
    // no palette entry, no dispatchable name — so a read is never answered from
    // a connection the caller is not talking to.
    //
    // What actually produces that end state is named honestly rather than
    // guessed at: `#isChannelCurrentlyBound` refuses the frame upstream, before
    // the declaration tap runs, so the record is never written in the first
    // place; the read-side stamp would refuse it a second time if it were. The
    // test pins the OUTCOME, which is the part this leg depends on, and does not
    // claim to discriminate which of the two guards produced it — mutating
    // either one alone leaves this green.
    let issuedProviderSessionIds = 0;
    const harness = buildHarness({
      mintProviderSessionId: (): string => {
        issuedProviderSessionIds += 1;
        return `provider-session-${issuedProviderSessionIds}`;
      },
    });
    await harness.lifecycle.createSession(buildCreateSessionParams());
    await harness.lifecycle.rollbackTo({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
      position: 4,
    });

    // The RETIRED channel speaks last. It is stamped with its own id, which the
    // live session's id no longer equals.
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
    // Guard two, standing alone. The command frame is never answered, so a
    // driver settling on the write would report a compaction that may never
    // happen.
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

    // The bytes are on the wire, composed with the slash the enumeration omits.
    expect(channel?.sentWireTexts).toStrictEqual(["/compact"]);
    // Tripwire-exempt, which is what makes the pre-dispatch guard load-bearing.
    expect(channel?.sentTextFrames[0]?.tripwireExempt).toBe(true);
    // And the wait is armed at the DECLARED bound.
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
    // `startRun`'s session-serialization guard refuses a run while the scope
    // holds a pending frame, so registering the compaction frame would make one
    // compaction block every later run on the session.
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

    // A POSITIVE statement that the frame named none, not an absence of evidence
    // about whether the compaction happened.
    await expect(pending).resolves.toStrictEqual({ status: "applied", boundaryPosition: null });
  });

  it("emits NO diagnostic on the applied path", async () => {
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
      compactionBoundary: { boundaryPosition: 7 },
    });
    await pending;

    expect(harness.diagnostics.recentRecordsOfKind("compaction_wait_terminal")).toStrictEqual([]);
  });

  it("settles `wait_expired` on the bound AND still hands a LATE boundary frame off to the routing band", async () => {
    // BOTH halves in one test, because the claim is a conjunction: bounding the
    // OPERATION never bounds the BOUNDARY'S RECORD. A late compaction frame
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

    // THE SECOND HALF. The boundary arrives after the operation gave up and is
    // still routed — the tap is beside the hand-off, never in place of it.
    const lateRoute = channel?.emitStreamFrame("system/compact_boundary", {
      compactionBoundary: { boundaryPosition: 88 },
    });
    observedRoutes.push(lateRoute?.decision ?? "none");
    expect(observedRoutes).toStrictEqual(["project"]);
    // And it settles nothing, because nothing is waiting: no second diagnostic.
    expect(harness.diagnostics.recentRecordsOfKind("compaction_wait_terminal")).toHaveLength(1);
  });

  it("settles `binding_lost` IMMEDIATELY when the session closes mid-wait, without the bound elapsing", async () => {
    // Driven through the real disposal path with a timer that is NEVER fired: a
    // binding lost at t=0 must settle at t=0, which a poller could not do.
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
    expect(scheduler.cancelledCount()).toBe(1);
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

      // The wait was ARMED before the write — that ordering is what closes the
      // race with a provider fast enough to compact between them — and is
      // WITHDRAWN when the write fails, rather than left to elapse. A
      // registration left behind holds a timer for the whole declared bound
      // after its caller has already returned.
      expect(scheduler.armedCount()).toBe(1);
      expect(scheduler.cancelledCount()).toBe(1);

      // DIAGNOSED, with the delivery classification the result cannot carry.
      // `unsent` and `indeterminate` both answer `provider_error` — neither can
      // claim a compaction happened — so this record is the only place the
      // difference between "never reached the provider" and "may have applied
      // with the acknowledgement lost" survives.
      const written = harness.diagnostics.recentRecordsOfKind("compaction_wait_terminal");
      expect(written).toHaveLength(1);
      expect(written[0]?.details).toStrictEqual({
        sessionId: TEST_SESSION_ID,
        terminal: "provider_error",
        delivery,
      });
      expect(written[0]?.dispositionReason).toBe("Error: stdin closed");

      // And the withdrawal is TOTAL, not merely a cancellation request: this
      // double's canceller does not stop its timer, so firing the bound here
      // exercises exactly the host whose clear races the fire. No SECOND record
      // appears, because no waiter remains to settle — the write-failure record
      // above stands alone.
      scheduler.fireAll();
      await drainMicrotasks();
      expect(harness.diagnostics.recentRecordsOfKind("compaction_wait_terminal")).toHaveLength(1);
    }
  });

  it("withdraws only its OWN wait — a concurrent caller still settles on the evidence", async () => {
    // Settlement is per-key because one provider compaction is one compaction;
    // withdrawal is per-waiter. A caller whose write failed must not settle a
    // participant who asked independently and whose compaction is still running.
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

    // The SECOND caller's write is the one that fails, so the first is still
    // waiting on evidence when the second withdraws.
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

    // Two waits armed, exactly one withdrawn. A withdrawal that took the whole
    // key down would cancel both and settle the survivor on the other caller's
    // write failure.
    expect(scheduler.armedCount()).toBe(2);
    expect(scheduler.cancelledCount()).toBe(1);

    channel?.emitStreamFrame("system/compact_boundary", {
      compactionBoundary: { boundaryPosition: 12 },
    });
    await expect(surviving).resolves.toStrictEqual({ status: "applied", boundaryPosition: 12 });
  });

  it("withdraws its wait when the armed span THROWS, and lets the throw propagate", async () => {
    // The reported-failure arm is not the only exit from the armed span:
    // composing the frame mints a correlation value through an injected
    // dependency, so a minter that throws leaves the driver holding an armed
    // registration whose caller has already unwound. Untreated, that is the
    // identical orphan the reported arm withdraws — one timer for the whole
    // declared bound, per failed dispatch.
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
    // PROPAGATES rather than converting: `failed` would claim something was
    // sent, and the refusal arm is closed at `command_absent` / `not_permitted`.
    await expect(
      harness.lifecycle.compactContext({
        sessionId: TEST_SESSION_ID,
        bindingId: TEST_BINDING_ID,
      }),
    ).rejects.toThrow("correlation minting failed");

    expect(scheduler.armedCount()).toBe(1);
    expect(scheduler.cancelledCount()).toBe(1);

    // TOTAL, exactly as on the reported arm: this double's canceller does not
    // really stop its timer, so firing the bound exercises the host whose clear
    // raced the fire. No terminal diagnostic appears, because no waiter remains.
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
    // The routing guard on this leg, stated structurally: the held declaration
    // answers only for the provider process it was read from, so a session whose
    // own handshake never published `compact` refuses even while a sibling
    // session's enumeration carries it.
    const otherSessionId = "session-console-parity-peer" as SessionId;
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
    // The negative that makes the three-set separation load-bearing rather than
    // cosmetic, and the one test that joins the two legs. The provider publishes
    // `terminal_slash_commands` precisely to say "these are not invocable over
    // this transport". A guard built by merging the sets would find the name,
    // dispatch a frame the provider cannot act on, and then wait out the whole
    // declared bound for evidence that can never arrive — a refusal at t=0
    // rewritten as a two-minute hang.
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

    // AND the same name is still ENUMERATED, under its honest scope: the guard
    // narrows what may be dispatched, never what is reported.
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
      // Carried, not merged and not dropped: the provider publishes them under
      // a separate member because they are not invocable over this transport.
      ["doctor", "command", "terminal"],
      ["color", "command", "terminal"],
    ]);
    for (const entry of group?.entries ?? []) {
      // KEY-PRESENCE, not `toBeUndefined()`: a synthesized `enabled: true` and
      // an absent key are different claims, and only the second is honest here.
      expect("enabled" in entry).toBe(false);
      // The provider publishes no description on either member; forwarding `""`
      // would fail the contract's own non-empty bound AND assert the provider
      // published a blank one.
      expect("description" in entry).toBe(false);
      expect(entry.name.startsWith("/")).toBe(false);
    }
    // `scope` is present ONLY on the terminal arm — the two published sets stay
    // distinguishable without inventing a third kind.
    expect("scope" in (group?.entries[0] ?? {})).toBe(false);
  });

  it("DROPS an entry whose provider-published name the contract refuses, keeping every sibling", async () => {
    // A skill name is read out of an operator-writable local file's front
    // matter, so the three handshake sets carry provider output verbatim into
    // this composition. Each refusal shape is exercised on a DIFFERENT set, so a
    // guard applied to only one of the three cannot pass this.
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

    // The SURVIVORS are the whole point: one unusable name must not empty a
    // participant's palette, so the drop is per-entry rather than per-set.
    expect(result.bindings[0]?.entries.map((entry) => entry.name)).toStrictEqual([
      "clear",
      "pdf-processing",
      "doctor",
    ]);
    // `complete` is the CAP marker and nothing else — no tail was dropped by the
    // cap here, and a refused entry must not be reported as a truncation.
    expect(result.bindings[0]?.complete).toBe(true);

    const rejected = harness.diagnostics.recentRecordsOfKind("provider_command_entry_rejected");
    expect(rejected).toHaveLength(4);
    // The failing FIELD and the offending LENGTH, never the value — the value is
    // exactly the untrusted string the bound just refused.
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

  it("emits NO rejection diagnostic for a handshake whose every name is in bounds", async () => {
    // The negative control that makes the drop test above non-vacuous: a guard
    // that refused everything would satisfy the survivors assertion only by
    // accident, and would go red here.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: buildHandshake(),
    });

    await harness.lifecycle.listProviderCommands({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });

    expect(
      harness.diagnostics.recentRecordsOfKind("provider_command_entry_rejected"),
    ).toStrictEqual([]);
  });

  it("emits exactly one entry per declared name across the three sets, deduping across none of them", async () => {
    // The count assertion is the one a merge-or-dedup refactor cannot survive:
    // the same name legitimately appears in two sets (a skill and a terminal
    // command may share a word), and collapsing them would silently delete a
    // published capability from the palette. Cardinality is asserted as the SUM
    // rather than as a literal so the claim survives the fixture changing.
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
      // KEY-ABSENCE on both published-as-invocable arms: under
      // `exactOptionalPropertyTypes` a present `scope: undefined` type-checks
      // and would read to any consumer as a scope the driver failed to decide,
      // which is a different claim from "the provider published none".
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
    // `complete` is the contract's CAP marker and nothing else: no tail was
    // dropped, which is true of an empty list. The read succeeds rather than
    // refusing — the pre-first-turn palette read is an answerable question.
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
    // The property that makes the cap safe: it trims what a client is shown,
    // never what the driver knows, so leg (a)'s presence check still finds a
    // command this cap dropped from the palette.
    const scheduler = makeManualCompactionScheduler();
    const harness = buildHarness({ compactionWaitScheduler: scheduler.schedule });
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    const filler = Array.from(
      { length: DRIVER_PROVIDER_COMMAND_ENTRIES_MAX + 5 },
      (_unused, index) => `filler-${index}`,
    );
    // `compact` sits PAST the cap, so a driver that capped its held knowledge
    // would refuse the dispatch below.
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
    // The retained window is the leading one — `declared.slice(0, MAX)` and not
    // an arbitrary or reordered subset. Asserted against the fixture's own head
    // so a future sort, filter, or tail-preferring cap is caught rather than
    // absorbed by the length check above.
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

    // AND the dispatch still works, which is the whole point.
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

  it("emits NO truncation diagnostic for an enumeration that fits", async () => {
    // Negative control: a diagnostic that fired on every read would say nothing.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: buildHandshake(),
    });

    await harness.lifecycle.listProviderCommands({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });

    expect(
      harness.diagnostics.recentRecordsOfKind("provider_command_entries_truncated"),
    ).toStrictEqual([]);
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
    // The replacement the read-side stamp cannot catch. Claude resumes BY
    // SESSION ID, so the resumed process announces the same
    // `providerSessionId` its predecessor had — a held declaration that
    // survived the predecessor by any route would compare EQUAL to the
    // successor's stamp and be answered from, which is a live read of a
    // connection that no longer exists. The resume path therefore discards
    // unconditionally at its head rather than trusting the disposal that
    // preceded it.
    //
    // The resume's own success is asserted: a `resumeSession` beside a live or
    // quarantined slot is REFUSED through the `failed` arm, and a test that
    // skipped this check would read a refused resume's untouched palette as a
    // successful resume's stale one and pass while proving nothing.
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

    // And the SUCCESSOR's own handshake is answered from, so this is a discard
    // and not a permanent blinding of the session.
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
    // STATED, never synthesized. The consuming routing check treats `null` as
    // matching nothing, so a placeholder would make that check compare equal
    // across two accountless bindings and look enforced while enforcing nothing.
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

  it("answers `runId: null` when NO run holds a live turn", async () => {
    // The ordinary pre-first-turn palette read. It SUCCEEDS.
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
    // The filter half of the derivation. Two sessions each holding a live turn
    // must each answer with their OWN run: a scan that forgot the session
    // comparison would answer `null` for both, which reads as "no run is
    // attributable" when in fact one is.
    const peerSessionId = "session-console-parity-runs" as SessionId;
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

  it("cannot reach the two-live-runs arm at all — this driver serializes turns per session", async () => {
    // The honest control for the `null`-on-two-runs arm. `startRun` refuses a
    // second dispatch while the session's scope holds a pending frame, and a
    // turn terminal retires every route on the session, so a Claude session
    // holds AT MOST ONE live run. The arm is therefore fail-closed defensive
    // code against state drift rather than a reachable branch — the same
    // posture `#ruleTextNeutralizationTripwire`'s two-pending-run else-arm
    // takes, and it is recorded here rather than left as an untested claim.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    armRunDispatch(harness, TEST_RUN_ID);
    armRunDispatch(harness, TEST_SECOND_RUN_ID);
    await harness.lifecycle.startRun(buildStartRunParams());

    await expect(
      harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID }),
    ).rejects.toBeInstanceOf(ClaudeSessionUnavailableError);
    const result = await harness.lifecycle.listProviderCommands({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });
    expect(result.bindings[0]?.runId).toBe(TEST_RUN_ID);
  });
});

describe("ClaudeSessionLifecycle.observedOutputSpeedFor — absent until observed", () => {
  it("has NO observation before the handshake arrives and one after", async () => {
    // Neither establishment path may block for this or spend a synthetic turn to
    // provoke it, so it is absent until the participant's own work produces the
    // declaring exchange.
    const harness = buildHarness();
    const handle = await harness.lifecycle.createSession(buildCreateSessionParams());

    expect(harness.lifecycle.observedOutputSpeedFor(TEST_SESSION_ID)).toBeUndefined();
    // And it is on NEITHER establishment reply — a value there would have to be
    // fabricated.
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
    // The settable-vs-reportable split. `outputSpeedLevels` is `["off", "on"]`;
    // coercing an observed `cooldown` into that set would fabricate a state the
    // provider is not in.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: buildHandshake({ fastModeState: "cooldown", fastModeDisabledReason: null }),
    });

    const observed = harness.lifecycle.observedOutputSpeedFor(TEST_SESSION_ID);

    expect(observed?.declared).toBe("cooldown");
    // KEY-PRESENCE: an absent reason means the provider gave none, never that
    // there was none.
    expect("reason" in (observed ?? {})).toBe(false);
  });

  it("has NO observation and DIAGNOSES a declared state the contract's bounds refuse", async () => {
    // The handshake's state and reason are provider output that reaches a
    // client, so `verbatim` bounds LENGTH, emptiness, and NUL — never vocabulary
    // membership. A rejected reading takes the absent answer because that is the
    // only fail-closed one this shape carries: inventing a placeholder
    // `declared` would put a state the provider is not in on a screen.
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
    // A spawn-bound leg: bound at create and omitted at resume would be silently
    // shed at the first relaunch, which is the shedding `ClaudeSpawnBoundLegs`
    // exists to make impossible.
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

describe("ClaudeSessionLifecycle.replayTranscript (T3.20)", () => {
  // Plan-005 T3.20 / invariant I-005-8. `Spec-005`'s Claude `transcript_replay`
  // cell is the matrix's only probe-valued one, so the leg ships behind that
  // probe: refusing on every build published at this pin, and driving the
  // surface the probe carries on any build that does publish one.

  const TARGET = { providerSessionId: "claude-session-77", resumeHandle: "claude-session-77" };

  function frame(position: number, role: "participant" | "assistant", text: string): unknown {
    return { position, role, segments: [{ kind: "text", position, text }] };
  }

  const TRANSCRIPT: readonly unknown[] = [
    frame(1, "participant", "summarize the fold"),
    frame(2, "assistant", "identity map, strip, repair, render"),
    frame(3, "participant", "and the order?"),
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

  // THE PIN'S ANSWER. No published build carries a prior-turn seeding surface,
  // so the probe refuses, the flag declares `false`, and the caller settles on
  // the memo floor reported `degraded`. A refusal, not a fault.
  it("refuses when the probe finds no seeding surface, leaving the target untouched", async () => {
    const harness = harnessWithSurface(null);
    await expect(
      harness.lifecycle.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toBeInstanceOf(ClaudeTranscriptReplayUnsupportedError);

    // NOT abandoned: nothing was written, so the caller may hand this very
    // session to the memo floor rather than establishing a second one.
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
    // Round-tripped through the WIRE envelope rather than compared structurally:
    // the `applied` arm carries a refinement of its own — it may not declare
    // `conversation_history_summarized` — that no shape comparison can see.
    expect(DriverTranscriptReplayResultSchema.parse(result)).toStrictEqual(result);
    expect(double.seededPositions).toStrictEqual([1, 2, 3, 4]);
    // Two reads: the pre-seed freshness read and the post-replay assertion's.
    expect(double.reads).toBe(2);
  });

  // A replay target is SINGLE-USE on both legs, and it is stated in one place
  // rather than left to the two freshness gates' shapes. This leg's pre-seed read
  // would in fact catch a second replay — but it would name it `target-not-fresh`,
  // which reads as "the caller handed us a used session" rather than "this daemon
  // already replayed into this one", and it would spend a round trip to learn
  // what the ledger already knows.
  it("burns a CONFIRMED target, so replaying the same handle twice is impossible", async () => {
    const double = seedingDouble({ answers: SEEDED_BODIES });
    const harness = harnessWithSurface(double);

    await harness.lifecycle.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] });
    expect(double.seededPositions).toStrictEqual([1, 2, 3, 4]);
    const readsAfterFirstReplay = double.reads;

    await expect(
      harness.lifecycle.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toBeInstanceOf(ReplayTargetAbandonedError);
    // Refused ahead of BOTH the seeding and the freshness read — the ledger is
    // consulted before the surface is touched at all.
    expect(double.seededPositions).toStrictEqual([1, 2, 3, 4]);
    expect(double.reads).toBe(readsAfterFirstReplay);
  });

  // THE MANDATORY CASE, on this leg's own transport: a surface that accepts
  // every frame and whose target then answers empty.
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

  // No turn ledger exists on this driver, so freshness costs a read — and it is
  // worth it: the assertion tolerates a target answering with MORE turns than
  // were seeded, so a target that arrived carrying a prior conversation would
  // otherwise pass on a matching tail.
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

  // NS-89's replay-target lifecycle, asserted ACROSS BOTH TARGETS: the abandoned
  // one holds native frames and never receives a memo, the replacement holds the
  // memo and never receives native frames, and no surviving session holds both —
  // which is the property that keeps a participant from reading the same
  // exchanges twice, once truncated.
  it("abandons a target refused mid-seeding; the memo lands in a FRESH target", async () => {
    const double = seedingDouble({ answers: SEEDED_BODIES, refuseAtPosition: 3 });
    const harness = harnessWithSurface(double);
    await expect(
      harness.lifecycle.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toThrow(/abandoned and must not be reused/);
    // A PREFIX landed, which is what makes reuse unsafe rather than untidy.
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
              role: "participant",
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

  // T3.22's half of the same seam, and it asserts a COUNT rather than a route:
  // a refusal raised inside the replay settles on the memo floor with exactly ONE
  // reconstitution attempted. The property is structural rather than counted at
  // runtime — the dispatch-seam ladder is absent from `replayTranscript`, so
  // there is no rung a replay could climb — and this is what makes the absence
  // observable: seeding a target begins at position 1, so the number of times
  // position 1 is seeded IS the number of reconstitutions attempted.
  it("settles a replay-interior refusal on the memo floor with ONE reconstitution", async () => {
    const double = seedingDouble({ answers: SEEDED_BODIES, refuseAtPosition: 2 });
    const harness = harnessWithSurface(double);

    await expect(
      harness.lifecycle.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toThrow(/abandoned and must not be reused/);

    // Two callers reaching for recovery after the same refusal — the run's own
    // failure path and a caller retrying the operation — must between them start
    // no second native reconstitution.
    await expect(
      harness.lifecycle.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toBeInstanceOf(ReplayTargetAbandonedError);
    await expect(
      harness.lifecycle.replayTranscript({ target: TARGET, frames: [...TRANSCRIPT] }),
    ).rejects.toBeInstanceOf(ReplayTargetAbandonedError);

    expect(double.seededPositions.filter((position) => position === 1)).toHaveLength(1);
    expect(double.seededPositions).toStrictEqual([1]);

    // And the settlement the participant is owed is the memo floor's, carrying
    // its declared loss — never a silently applied replay.
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
              role: "participant",
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

    // A retry would duplicate frame 2 in a conversation a participant reads, and
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
          frame(1, "participant", "kept"),
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

  // The other half of the `transcript_replay: false` contract: the refusal is a
  // ROUTE, not a dead end. A driver that declares the flag `false` settles
  // reconstitution on the memo projection and the caller reports `degraded`,
  // which is the outcome `Spec-005 §Fallback Behavior` names — so this composes
  // the driver's own refusal into the disposition the router consumes and drives
  // the real memo floor with it.
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
            role: "participant",
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
    // The schema requires it on a `degraded` result, and it is what tells a
    // participant the conversation they are looking at was summarized.
    expect(reported.declaredLosses).toContain("conversation_history_summarized");
    expect(deliveredTurns).toHaveLength(1);
  });
});
