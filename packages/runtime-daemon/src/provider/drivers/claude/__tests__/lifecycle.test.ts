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
  DriverResumeResultSchema,
  type CallbackToolResult,
  type ExecutionPosture,
  type SubagentPolicy,
} from "@ai-sidekicks/contracts";
import { describe, expect, it, vi } from "vitest";

import type { DriverDiagnosticsEmitter } from "../../../driver-diagnostics.js";
import type { SessionId } from "@ai-sidekicks/contracts";

import type { SubagentLifecycleEmission, ThreadFrameRoute } from "../../../thread-frame-router.js";
import type { MeteredUsageDelta } from "../../../usage-delta-accountant.js";
import {
  ClaudeAuthenticationRequiredError,
  ClaudeControlRequestRefusedError,
  ClaudeSessionLifecycle,
  ClaudeSessionUnavailableError,
  ClaudeSubagentConcurrencyGate,
  CLAUDE_CALLBACK_MCP_SERVER_NAME,
  CLAUDE_SUBAGENT_MAX_DEPTH_CEILING,
  composeClaudeCallbackMcpServer,
  composeClaudeProviderToolName,
  composeClaudeSandboxSettings,
  type ClaudeSessionLifecycleDependencies,
} from "../lifecycle.js";
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

interface LifecycleHarness {
  readonly lifecycle: ClaudeSessionLifecycle;
  readonly transport: FakeClaudeSessionTransport;
  readonly runDispatchResolver: FakeClaudeRunDispatchResolver;
  readonly diagnostics: DriverDiagnosticsEmitter;
}

function buildHarness(
  overrides: Partial<ClaudeSessionLifecycleDependencies> = {},
): LifecycleHarness {
  const transport = new FakeClaudeSessionTransport();
  const runDispatchResolver = new FakeClaudeRunDispatchResolver();
  const diagnostics = makeSilentDriverDiagnostics();
  const dependencies: ClaudeSessionLifecycleDependencies = {
    transport,
    runDispatchResolver,
    diagnostics,
    mintProviderSessionId: () => TEST_PINNED_PROVIDER_SESSION_ID,
    mintBindingId: () => TEST_BINDING_ID,
    ...overrides,
  };
  return {
    lifecycle: new ClaudeSessionLifecycle(dependencies),
    transport,
    runDispatchResolver,
    diagnostics: dependencies.diagnostics,
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
    expect(channel?.sentTextFrames).toStrictEqual([{ text: "review the diff" }]);
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
    expect(harness.transport.spawnedChannels[0]?.sentTextFrames).toStrictEqual([]);
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
    expect(harness.transport.spawnedChannels[0]?.sentTextFrames).toStrictEqual([]);
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

    expect(harness.transport.spawnedChannels[0]?.sentTextFrames).toStrictEqual([
      { text: "review the diff" },
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
    expect(harness.transport.spawnedChannels[0]?.sentTextFrames).toStrictEqual([]);
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

    expect(harness.transport.spawnedChannels[0]?.sentTextFrames).toStrictEqual([
      { text: "review the diff" },
    ]);
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

    expect(harness.transport.spawnedChannels[0]?.sentTextFrames).toStrictEqual([
      { text: "review the diff" },
    ]);
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

    expect(harness.transport.spawnedChannels[0]?.sentTextFrames).toStrictEqual([
      { text: "review the diff" },
    ]);
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
    expect(harness.transport.spawnedChannels[0]?.sentTextFrames).toStrictEqual([]);
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

    expect(harness.transport.spawnedChannels[0]?.sentTextFrames).toStrictEqual([
      { text: "review the diff" },
    ]);
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

    expect(harness.transport.spawnedChannels[0]?.sentTextFrames).toStrictEqual([
      { text: "review the diff" },
    ]);
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
    expect(harness.transport.spawnedChannels[0]?.sentTextFrames).toStrictEqual([]);
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

    expect(harness.transport.spawnedChannels[0]?.sentTextFrames).toStrictEqual([
      { text: "review the diff" },
    ]);
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

    expect(harness.transport.spawnedChannels[0]?.sentTextFrames).toStrictEqual([
      { text: "review the diff" },
    ]);
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
    expect(channel.sentTextFrames).toStrictEqual([
      { text: "review the diff" },
      { text: "now the next task" },
    ]);
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

  it("closing a session releases its router and accountant rather than leaking them per session", async () => {
    const harness = buildRoutingHarness();
    const channel = await liveChannel(harness);
    const providerSessionId = channel.providerSessionId;
    channel.emitStreamFrame("assistant/message", usageObservation(10));
    expect(harness.lifecycle.usageAccountantFor(TEST_SESSION_ID).hasThread(providerSessionId)).toBe(
      true,
    );

    await harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID });

    // Get-or-create, so the accessor answers with a FRESH pair; the assertion
    // is that the old one did not survive, which the empty thread proves. The
    // routing and metering band is per-provider-session state, so a router
    // outliving its session would answer the next one with a thread registry
    // that session never made.
    expect(harness.lifecycle.usageAccountantFor(TEST_SESSION_ID).hasThread(providerSessionId)).toBe(
      false,
    );
    expect(harness.lifecycle.frameRouterFor(TEST_SESSION_ID).pendingHeldFrameCount()).toBe(0);
  });

  it("(a) a frame naming a FOREIGN thread never projects", async () => {
    const harness = buildRoutingHarness();
    const channel = await liveChannel(harness);

    const route = channel.emitStreamFrame("system/task_progress", {
      subagentId: "some-unannounced-subagent",
    });

    expect(route.decision).toBe("held-pending-registration");
    expect(channel.projectedFrameKinds).toStrictEqual([]);
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
    expect(channel.projectedFrameKinds).toStrictEqual([]);
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
    expect(channel.projectedFrameKinds).toStrictEqual(["result/success"]);
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

    // No child content on the parent's timeline...
    expect(channel.projectedFrameKinds).toStrictEqual([]);
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
  });

  it("a frame arriving on a channel the session no longer holds is quarantined, never metered", async () => {
    const harness = buildRoutingHarness();
    const staleChannel = await liveChannel(harness);
    await harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID });

    // The driver holds no kill, so a disowned process can still emit.
    const route = staleChannel.emitStreamFrame("system/task_progress", usageObservation(9_999));

    expect(route.decision).toBe("quarantined");
    expect(harness.meteredUsage).toStrictEqual([]);
    expect(staleChannel.projectedFrameKinds).toStrictEqual([]);
  });

  it("a resume with no prior-emitted sum records the overstatement rather than hiding it", async () => {
    const harness = buildRoutingHarness();
    await harness.lifecycle.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
      executionPosture: SANDBOXED_POSTURE,
    });

    expect(harness.diagnostics.recentRecordsOfKind("usage_resume_base_unavailable")).toHaveLength(
      1,
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
