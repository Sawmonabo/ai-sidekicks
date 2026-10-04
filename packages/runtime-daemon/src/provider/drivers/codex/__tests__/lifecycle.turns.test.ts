// How the Codex driver dispatches turns: a turn the provider may have taken is never sent twice
// nor reported as delivered without proof, a swallowed message condemns its process, posture is
// never caller-overridable, and a rewind forks exactly where it was asked to.

import { describe, expect, it } from "vitest";

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider-driver";
import { TextNeutralizationRefusedError } from "../../../outbound-frame.js";
import type { SubagentPolicy } from "../../../provider-driver.js";
import {
  PermanentStructuralRefusalError,
  type UserTurnReadbackReader,
} from "../../../transcript/failure-mapping.js";
import {
  CodexDriverConfigError,
  CodexProviderRequestError,
  CodexRequestTimeoutError,
  CodexRewindBoundaryUnsupportedError,
  CodexTransportError,
} from "../index.js";
import { assertRealizedTurnPostureMembers } from "../session-config.js";
import {
  type Harness,
  type ManagerHarness,
  type ManagerHarnessOptions,
  RUN_ID,
  SECOND_RUN_ID,
  SESSION_ID,
  TEST_MODEL,
  THREAD_ID,
  TURN_ID,
  createHarness,
  createManagerHarness,
  createdSession,
  modelOutputItemFrame,
  threadStartResult,
  turnCompletedFrame,
  zeroTurnCompletedFrame,
} from "./codex-test-doubles.js";
import { CREATE_PARAMS } from "./lifecycle.test-support.js";
import { captureRejection } from "../../../../__fixtures__/capture-failure.js";
import { drainMicrotasks } from "../../../__fixtures__/drain-microtasks.js";

/** A manager harness with one live session. */
async function liveSession(options: ManagerHarnessOptions = {}): Promise<ManagerHarness> {
  const harness = createManagerHarness(options);
  await harness.manager.createSession(CREATE_PARAMS);
  return harness;
}

function startRun(
  harness: ManagerHarness,
  input = "go",
  extra: { runId?: typeof RUN_ID; frameOrigin?: string } = {},
): Promise<void> {
  return harness.manager.startRun({
    runId: extra.runId ?? RUN_ID,
    agentConfig: {
      sessionId: SESSION_ID,
      input,
      ...(extra.frameOrigin === undefined ? {} : { frameOrigin: extra.frameOrigin }),
    },
  });
}

const SIGKILLED = [{ sessionId: "pty-session-1", signal: "SIGKILL" }];

describe("Codex turn posture", () => {
  it("refuses every posture field a caller declares, and any turn member it cannot realize", async () => {
    const harness = createHarness();
    await createdSession(harness);

    for (const field of [
      "cwd",
      "sandboxPolicy",
      "permissions",
      "permissionProfile",
      "approvalPolicy",
      "approvalsReviewer",
    ]) {
      await expect(
        harness.driver.startRun({
          runId: RUN_ID,
          agentConfig: { sessionId: SESSION_ID, input: "review the diff", [field]: "anything" },
        }),
      ).rejects.toBeInstanceOf(CodexDriverConfigError);
    }
    // Refused before the wire, not filtered on it.
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(0);

    // The guard every turn composer calls: an unrealized member, the pair the provider accepts
    // with no documented precedence, and the member the provider build refuses.
    for (const members of [
      { permissions: "profile-id" },
      { sandboxPolicy: { mode: "workspace-write" }, permissions: "profile-id" },
      { permissionProfile: "profile-id" },
    ]) {
      expect(() => assertRealizedTurnPostureMembers({ threadId: THREAD_ID, ...members })).toThrow(
        CodexDriverConfigError,
      );
    }
  });

  it("refuses a run whose config declares a frame origin, before any byte is written", async () => {
    // The origin is minted at the boundary; the exempt one would deliver command-shaped words
    // verbatim to the provider's command layer and excuse a swallowed turn from the tripwire.
    const harness = await liveSession();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));

    await expect(startRun(harness, "/compact", { frameOrigin: "driver_command" })).rejects.toThrow(
      CodexDriverConfigError,
    );
    expect(harness.server.framesForMethod("turn/start")).toStrictEqual([]);
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
  });

  it("carries the steer's idempotency key verbatim, so a retry is deduplicated", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("turn/steer", () => ({ result: { turnId: TURN_ID } }));
    await harness.driver.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "one" },
    });

    await harness.driver.applyIntervention({
      type: "steer",
      targetRunId: RUN_ID,
      expectedRunVersion: 1,
      clientIdempotencyKey: "9a1d8f30-0000-4000-8000-0000000000aa",
      payload: { content: "focus on the failing test", expectedTurnId: TURN_ID },
    });

    expect(harness.server.framesForMethod("turn/steer")[0]?.["params"]).toMatchObject({
      clientUserMessageId: "9a1d8f30-0000-4000-8000-0000000000aa",
    });
  });
});

describe("Codex ambiguous turn/start", () => {
  it.each([
    ["misses its deadline", undefined, CodexRequestTimeoutError],
    // An answer with no addressable turn id leaves the same question open as no answer.
    ["is answered with no usable turn id", { result: { turn: {} } }, CodexTransportError],
  ] as const)(
    "kills the child, sends nothing again and frees the slot when turn/start %s",
    async (_label, answer, errorClass) => {
      // The readback is unbound, so the target cannot be read and the turn may have landed.
      const harness = await liveSession();
      harness.server.uniqueSpawnSessionIds = true;
      if (answer !== undefined) {
        harness.server.on("turn/start", () => answer);
      }

      const failure = captureRejection(startRun(harness));
      if (answer === undefined) {
        harness.scheduler.fireAll();
      }

      expect(await failure).toBeInstanceOf(errorClass);
      // Killed, not merely closed: an accepted turn keeps executing tools.
      expect(harness.server.killedSessions).toEqual(SIGKILLED);
      expect(harness.server.framesForMethod("turn/start")).toHaveLength(1);
      expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
      await harness.manager.createSession(CREATE_PARAMS);
      expect(harness.server.spawnRequests).toHaveLength(2);
    },
  );

  /** Answers a fixed user-turn count, recording how many starts the wire held when asked. */
  function countingReadback(
    userOriginatedTurns: number,
    turnStartFramesAtRead: number[],
    readHarness: () => ManagerHarness,
  ): UserTurnReadbackReader {
    return () => {
      turnStartFramesAtRead.push(readHarness().server.framesForMethod("turn/start").length);
      return Promise.resolve({ kind: "counted" as const, userOriginatedTurns });
    };
  }

  it("settles a start the readback proves landed as delivered, and never re-sends it", async () => {
    const framesAtRead: number[] = [];
    const harness: ManagerHarness = await liveSession({
      userTurnReadback: countingReadback(1, framesAtRead, () => harness),
    });
    harness.server.uniqueSpawnSessionIds = true;

    const failure = captureRejection(startRun(harness));
    harness.scheduler.fireAll();
    expect(await failure).toBeInstanceOf(CodexRequestTimeoutError);

    // Read once, before anything else reached the wire.
    expect(framesAtRead).toEqual([1]);
    // The landed turn is unaddressable, so the session is disposed and a re-dispatch cannot put a
    // second copy on the wire.
    expect(harness.server.killedSessions).toEqual(SIGKILLED);
    expect(await captureRejection(startRun(harness))).toBeInstanceOf(Error);
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(1);
  });

  it("clears a start the readback proves never landed for a retry on the same process", async () => {
    const framesAtRead: number[] = [];
    const harness: ManagerHarness = await liveSession({
      userTurnReadback: countingReadback(0, framesAtRead, () => harness),
    });

    const failure = captureRejection(startRun(harness));
    harness.scheduler.fireAll();
    expect(await failure).toBeInstanceOf(CodexRequestTimeoutError);

    expect(framesAtRead).toEqual([1]);
    expect(harness.server.killedSessions).toEqual([]);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await startRun(harness);
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(true);
    expect(harness.server.spawnRequests).toHaveLength(1);
  });

  /** A `turn/start` refusal carrying the provider's typed `CodexErrorInfo` member. */
  function typedRefusal(codexErrorInfo: string): Record<string, unknown> {
    return {
      error: {
        code: -32600,
        // Says "history" on purpose, so a classifier that read prose would pass for the wrong reason.
        message: "Invalid request: the thread history is not acceptable",
        data: { codexErrorInfo },
      },
    };
  }

  it("calls a provider that types the history unacceptable exactly once and condemns the binding", async () => {
    // A retry ladder over a poisoned history spends one request per rung for the same refusal.
    const harness = await liveSession();
    harness.server.on("turn/start", () => typedRefusal("badRequest"));

    const outcome = await captureRejection(startRun(harness));

    expect(outcome).toBeInstanceOf(PermanentStructuralRefusalError);
    expect((outcome as PermanentStructuralRefusalError).providerSessionId).toBe(THREAD_ID);
    expect((outcome as PermanentStructuralRefusalError).freshSessionRequired).toBe(true);
    expect(harness.server.killedSessions).toEqual(SIGKILLED);
    expect(await captureRejection(startRun(harness))).toBeInstanceOf(Error);
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(1);
  });

  it("does not condemn a typed refusal that names something other than the history", async () => {
    // A context ceiling is not a poisoned history; the next turn may not meet it.
    const harness = await liveSession();
    harness.server.on("turn/start", () => typedRefusal("contextWindowExceeded"));

    const outcome = await captureRejection(startRun(harness));

    expect(outcome).toBeInstanceOf(CodexProviderRequestError);
    expect(outcome).not.toBeInstanceOf(PermanentStructuralRefusalError);
    expect(harness.server.killedSessions).toEqual([]);
  });
});

describe("Codex turn route and the swallowed-message tripwire", () => {
  /** A live session whose run has a started turn. */
  async function runningTurn(
    extra: { input?: string; frameOrigin?: string } = {},
  ): Promise<ManagerHarness> {
    const harness = await liveSession();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await startRun(harness, extra.input ?? "go", extra);
    return harness;
  }

  const SWALLOWED = {
    sessionId: SESSION_ID,
    runId: RUN_ID,
    providerFailureDetail: "driver.text_neutralization_failed origin=human_text",
  };

  // `turn/completed` is the only terminal notification; a failure or an interrupt arrives on it
  // too. A finished turn left active would take interventions aimed at a retired turn id, and one
  // retired mid-flight would refuse a live steer or interrupt.
  it.each([
    ["completed", false],
    ["interrupted", false],
    ["failed", false],
    ["inProgress", true],
  ] as const)("on a %s terminal, leaves the turn active: %s", async (status, stillActive) => {
    const harness = await runningTurn();

    harness.server.emitFrame(turnCompletedFrame(TURN_ID, status));
    await Promise.resolve();

    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(stillActive);
  });

  it("does not let a stale terminal retire a newer turn for the same run", async () => {
    const harness = await liveSession();
    let nextTurnId = TURN_ID;
    harness.server.on("turn/start", () => ({ result: { turn: { id: nextTurnId } } }));
    await startRun(harness, "one");
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await Promise.resolve();
    nextTurnId = "turn-02";
    await startRun(harness, "two");

    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await Promise.resolve();

    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(true);
  });

  it("trips when the swallowed turn terminates in the same read chunk as its start response", async () => {
    // The chunk is drained before `startRun` resumes, so the terminal settles a turn no frame is
    // correlated with yet; a memory holding only turn ids would report the swallow as completed.
    const harness = await liveSession();
    harness.server.on("turn/start", () => ({
      result: { turn: { id: TURN_ID } },
      trailingFrames: [zeroTurnCompletedFrame(TURN_ID)],
    }));

    await startRun(harness, "/status please", { frameOrigin: "human_text" });

    expect(harness.textNeutralizationFailures).toStrictEqual([SWALLOWED]);
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
  });

  it("does not trip a real turn that settles in the same chunk with an unloaded item list", async () => {
    // A false trip condemns a healthy session. The in-flight item is the evidence.
    const harness = await liveSession();
    harness.server.on("turn/start", () => ({
      result: { turn: { id: TURN_ID } },
      trailingFrames: [modelOutputItemFrame(TURN_ID), zeroTurnCompletedFrame(TURN_ID)],
    }));

    await startRun(harness, "review the diff", { frameOrigin: "human_text" });

    expect(harness.textNeutralizationFailures).toStrictEqual([]);
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
  });

  it("condemns the binding a trip was seen on, and admits a fresh spawn under the same session id", async () => {
    const harness = await runningTurn({ input: "/status please", frameOrigin: "human_text" });
    harness.server.uniqueSpawnSessionIds = true;
    harness.server.emitFrame(zeroTurnCompletedFrame(TURN_ID));
    await Promise.resolve();

    // A run-keyed quarantine would hand the next run back to the process that swallowed the
    // user's words; this one is refused before the provider is asked anything.
    const writtenAfterTrip = harness.server.writtenLines.length;
    await expect(startRun(harness, "carry on", { runId: SECOND_RUN_ID })).rejects.toThrow(
      TextNeutralizationRefusedError,
    );
    expect(harness.server.writtenLines).toHaveLength(writtenAfterTrip);

    // The quarantine names the binding, not the id, so recovery on a fresh process runs.
    await drainMicrotasks();
    await harness.manager.createSession(CREATE_PARAMS);
    await expect(startRun(harness, "carry on", { runId: SECOND_RUN_ID })).resolves.toBeUndefined();
  });

  it("keeps the frame of a steer that timed out after its bytes were written", async () => {
    // The provider may have intercepted the command-shaped message and be heading for a zero-turn
    // success; withdrawing the frame is how that swallow would escape.
    const harness = await runningTurn({ input: "review the diff", frameOrigin: "human_text" });
    harness.server.emitFrame(modelOutputItemFrame(TURN_ID));
    await Promise.resolve();

    const steer = harness.manager.steerRun({
      runId: RUN_ID,
      content: "/clear and start over",
      clientIdempotencyKey: "steer-1",
      frameOrigin: "system_narration",
    });
    await drainMicrotasks();
    expect(harness.server.framesForMethod("turn/steer")).toHaveLength(1);
    harness.scheduler.fireAll();
    await expect(steer).rejects.toBeInstanceOf(CodexRequestTimeoutError);

    // Every item this terminal carries precedes the steer, so none of them is evidence for it.
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await drainMicrotasks();

    expect(
      harness.textNeutralizationFailures.map((failure) => failure.providerFailureDetail),
    ).toEqual(["driver.text_neutralization_failed origin=system_narration"]);
    await expect(startRun(harness, "carry on", { runId: SECOND_RUN_ID })).rejects.toThrow(
      TextNeutralizationRefusedError,
    );
  });

  it("reports a trip on the run whose route an interrupt had already retired", async () => {
    // The interrupt resolves on acceptance and the terminal still follows; without a correlation
    // across that gap the run's subscribers would hear nothing while its process is condemned.
    const harness = await runningTurn({ input: "/status please", frameOrigin: "human_text" });
    harness.server.on("turn/interrupt", () => ({ result: {} }));
    await harness.manager.interruptRun({ runId: RUN_ID });
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);

    harness.server.emitFrame(zeroTurnCompletedFrame(TURN_ID));
    await drainMicrotasks();

    expect(harness.textNeutralizationFailures).toStrictEqual([SWALLOWED]);
    await expect(startRun(harness, "carry on", { runId: SECOND_RUN_ID })).rejects.toThrow(
      TextNeutralizationRefusedError,
    );
  });
});

describe("Codex rewind and re-realization", () => {
  const WORKSPACE_POSTURE: ExecutionPosture = {
    mode: "ask",
    credentialPolicyRef: "policy://default",
    writableRoots: ["/work/session"],
  };
  const FORKED = {
    result: {
      thread: { id: "thread-forked", sessionId: "session-tree-1", turns: [{ id: "turn-0" }] },
    },
  };
  const APPLIED = { status: "applied", sessionPosition: 1, bindingId: "binding-abc" };

  function paramsOf(harness: Harness, method: string): Record<string, unknown> {
    return (harness.server.framesForMethod(method)[0]?.["params"] ?? {}) as Record<string, unknown>;
  }

  /** A live session resumed with two turns of history, the axis a rewind indexes. */
  async function resumedWithTurns(
    harness: Harness,
    extra: Partial<Parameters<Harness["driver"]["resumeSession"]>[0]> = {},
  ): Promise<void> {
    harness.server.on("thread/resume", () => threadStartResult(2));
    await harness.driver.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
      ...extra,
    });
  }

  it("reports the minted binding, not the caller's, on an applied rewind", async () => {
    // The daemon rebinds the run onto the new thread; echoing the predecessor's binding would
    // route it to a dead one.
    const harness = createHarness();
    await resumedWithTurns(harness);
    harness.server.on("thread/fork", () => FORKED);

    await expect(
      harness.driver.forkConversation({
        sessionId: SESSION_ID,
        bindingId: "binding-predecessor",
        position: 1,
      }),
    ).resolves.toStrictEqual(APPLIED);
  });

  it("refuses a position that names no recorded boundary rather than forking the whole thread", async () => {
    const harness = createHarness();
    await createdSession(harness);

    const result = await harness.driver.forkConversation({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
      position: 0,
    });

    expect(result).toStrictEqual({
      status: "degraded",
      fallbackAction: "rewind-target-not-a-recorded-boundary",
    });
    expect(harness.server.framesForMethod("thread/fork")).toHaveLength(0);
  });

  it.each([
    "Invalid request: missing field `lastTurnId`",
    "Invalid request: unknown field `lastTurnId`",
  ])(
    "classifies a build refusing the boundary field (%s) and releases the transition slot",
    async (providerMessage) => {
      // The capability gate cannot see this parameter, so the refusal is classified at invocation.
      const harness = createHarness();
      await resumedWithTurns(harness);
      harness.server.on("thread/fork", () => ({
        error: { code: -32600, message: providerMessage },
      }));

      const refused = await captureRejection(
        harness.driver.forkConversation({ sessionId: SESSION_ID, bindingId: "b", position: 1 }),
      );

      expect(refused).toBeInstanceOf(CodexRewindBoundaryUnsupportedError);
      expect((refused as CodexRewindBoundaryUnsupportedError).code).toBe(
        "driver.capability_unsupported",
      );
      // A leaked slot would leave the session unable to rewind, resume or close again.
      harness.server.on("thread/fork", () => FORKED);
      await expect(
        harness.driver.forkConversation({ sessionId: SESSION_ID, bindingId: "b", position: 1 }),
      ).resolves.toStrictEqual(APPLIED);
    },
  );

  it.each(["thread/resume", "thread/fork"])(
    "re-sends posture and subagent caps on %s, which establishes a fresh thread",
    async (method) => {
      // Omitted, the thread runs under whatever the provider persisted, not what was declared.
      const harness = createHarness();
      await resumedWithTurns(harness, {
        executionPosture: WORKSPACE_POSTURE,
        subagentPolicy: { enabled: true, maxConcurrent: 3, maxDepth: 1, definitions: [] },
      });
      if (method === "thread/fork") {
        harness.server.on("thread/fork", () => FORKED);
        await harness.driver.forkConversation({
          sessionId: SESSION_ID,
          bindingId: "binding-abc",
          position: 1,
        });
      }

      const params = paramsOf(harness, method);
      expect(params["sandbox"]).toBe("workspace-write");
      expect(params["config"]).toStrictEqual({
        "agents.max_concurrent_threads_per_session": 3,
        "agents.max_depth": 1,
      });
    },
  );

  it.each([true, false])(
    "echoes the network access the thread reply reports (%s) on each turn's sandbox policy",
    async (networkAccess) => {
      // The person's own Codex config decides the network; omitting the member would turn it off.
      const harness = createHarness();
      harness.server.on("thread/start", () => ({
        result: {
          thread: { id: THREAD_ID, sessionId: "session-tree-1", turns: [] },
          sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess },
        },
      }));
      harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
      await harness.driver.createSession({ ...CREATE_PARAMS, executionPosture: WORKSPACE_POSTURE });

      await harness.driver.startRun({
        runId: RUN_ID,
        agentConfig: { sessionId: SESSION_ID, input: "go" },
      });

      expect(paramsOf(harness, "turn/start")["sandboxPolicy"]).toMatchObject({
        type: "workspaceWrite",
        networkAccess,
      });
    },
  );

  const disablingPolicies: ReadonlyArray<readonly [string, SubagentPolicy]> = [
    ["a disabled policy", { enabled: false }],
    // Clamping up would grant a subagent slot to a caller who asked for none.
    [
      "an enabled policy below the provider floor",
      { enabled: true, maxConcurrent: 0, maxDepth: 3, definitions: [] },
    ],
  ];

  it.each(disablingPolicies)(
    "disables subagents on the depth axis for %s",
    async (_label, subagentPolicy) => {
      // A zero concurrency cap is refused by the provider, which would fail every such session.
      const harness = createHarness();
      harness.server.on("thread/start", () => threadStartResult());

      await harness.driver.createSession({ ...CREATE_PARAMS, subagentPolicy });

      expect(paramsOf(harness, "thread/start")["config"]).toStrictEqual({
        "agents.max_concurrent_threads_per_session": 1,
        "agents.max_depth": 0,
      });
    },
  );
});
