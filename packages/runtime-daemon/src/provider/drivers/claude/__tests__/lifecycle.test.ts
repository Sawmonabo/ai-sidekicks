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

import {
  DriverResumeResultSchema,
  type CallbackToolResult,
  type ExecutionPosture,
} from "@ai-sidekicks/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  ClaudeAuthenticationRequiredError,
  ClaudeControlRequestRefusedError,
  ClaudeSessionLifecycle,
  ClaudeSessionUnavailableError,
  type ClaudeSessionLifecycleDependencies,
} from "../lifecycle.js";
import {
  buildCreateSessionParams,
  buildStartRunParams,
  FakeClaudeRunDispatchResolver,
  FakeClaudeSessionTransport,
  TEST_BINDING_ID,
  TEST_PINNED_PROVIDER_SESSION_ID,
  TEST_RUN_ID,
  TEST_SESSION_ID,
} from "./claude-test-doubles.js";

interface LifecycleHarness {
  readonly lifecycle: ClaudeSessionLifecycle;
  readonly transport: FakeClaudeSessionTransport;
  readonly runDispatchResolver: FakeClaudeRunDispatchResolver;
}

function buildHarness(): LifecycleHarness {
  const transport = new FakeClaudeSessionTransport();
  const runDispatchResolver = new FakeClaudeRunDispatchResolver();
  const dependencies: ClaudeSessionLifecycleDependencies = {
    transport,
    runDispatchResolver,
    mintProviderSessionId: () => TEST_PINNED_PROVIDER_SESSION_ID,
    mintBindingId: () => TEST_BINDING_ID,
  };
  return { lifecycle: new ClaudeSessionLifecycle(dependencies), transport, runDispatchResolver };
}

const SANDBOXED_POSTURE: ExecutionPosture = {
  mode: "workspace-sandboxed",
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

  it("drops the route even when disposal fails, and surfaces the disposal failure", async () => {
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("unreachable: the session must have spawned a channel");
    }
    channel.disposeFailure = new Error("the provider process would not exit");

    await expect(harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID })).rejects.toThrow(
      "the provider process would not exit",
    );
    // The session is forgotten, so a later create is admitted rather than
    // refused by a stale live-session record.
    await expect(
      harness.lifecycle.createSession(buildCreateSessionParams()),
    ).resolves.toBeDefined();
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

describe("ClaudeSessionUnavailableError", () => {
  it("rides an error code already registered in the driver namespace", () => {
    const error = new ClaudeSessionUnavailableError("no_live_run", { runId: TEST_RUN_ID });

    expect(error.code).toBe("driver.unavailable");
    expect(error.fields.driverId).toBe("claude");
    expect(error).toBeInstanceOf(Error);
  });
});
