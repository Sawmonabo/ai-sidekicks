// Codex driver lifecycle against a fake provider: the fake implements `PtyHost` and speaks JSON-RPC
// over the same byte channel, so every test drives the real framing, correlation, deadline and
// teardown code.

import { describe, expect, it, vi } from "vitest";

import {
  CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME,
  DRIVER_FAILURE_DETAIL_MAX_LEN,
  DRIVER_PROVIDER_COMMAND_ENTRIES_MAX,
  type DriverCompactionResult,
  type SessionId,
  type ApplyInterventionParams,
  type ExecutionPosture,
  type SessionCallbackTool,
} from "@ai-sidekicks/contracts";
import { bindCallbackToolsForSpawn, CallbackToolHost } from "../../../callback-tool-host.js";
import { createCallbackToolAskResponder } from "../callback-tool-ask-responder.js";
import {
  DriverDiagnosticsEmitter,
  type DriverDiagnosticRecord,
} from "../../../driver-diagnostics.js";
import {
  TEXT_NEUTRALIZATION_REFUSAL_CODE,
  TextNeutralizationRefusedError,
} from "../../../outbound-frame.js";
import type { CumulativeAxisReadings } from "../../../usage-delta-accountant.js";
import {
  PermanentStructuralRefusalError,
  type UserTurnReadbackReader,
} from "../../../transcript/failure-mapping.js";
import {
  CodexAppServerConnection,
  CodexDriver,
  CodexLifecycleManager,
  CodexSessionAlreadyLiveError,
  CodexProviderRequestError,
  CodexRequestTimeoutError,
  CodexRewindBoundaryUnsupportedError,
  CodexTransportError,
  CODEX_APP_SERVER_READY_SENTINEL,
  CODEX_APP_SERVER_SHELL_ARGV0,
  CODEX_APP_SERVER_SHELL_PRELUDE,
  CodexDriverConfigError,
  composeCodexTransportArgv,
  type CodexWebsocketBearerCredential,
  describeCodexPostureDivergence,
  normalizeProviderFailureDetail,
  parseCodexSessionConfig,
  type CodexSessionConfig,
  type CodexTransportDiagnostic,
  type CodexTransportSelection,
} from "../index.js";
import { assertRealizedTurnPostureMembers } from "../session-config.js";
import { CODEX_CALLBACK_TOOL_REGISTRATION_UNAVAILABLE_DETAIL } from "../server-requests.js";
import { COMPACTION_WAIT_MS } from "../../../compaction-wait.js";
import {
  type DriverResumeResult,
  type CallbackToolInvocation,
  STEER_FALLBACK_ACTION,
} from "../../../provider-driver.js";
import {
  EXECUTABLE_PATH,
  FakeCodexAppServer,
  type Harness,
  type JsonRpcAnswer,
  type ManagerHarness,
  type ManagerHarnessOptions,
  RESUME_SPAWN_CONFIG,
  RUN_ID,
  SECOND_RUN_ID,
  SECOND_TURN_ID,
  SESSION_CONFIG,
  SESSION_CWD,
  SESSION_ID,
  STUB_MODEL_CATALOG_READ,
  TEST_MODEL,
  THREAD_ID,
  TURN_ID,
  createHarness,
  createManagerHarness,
  createdSession,
  makeCapabilities,
  modelOutputItemFrame,
  resolveNoDeniedCredentialNames,
  routedAskHarness,
  threadStartResult,
  turnCompletedFrame,
  zeroTurnCompletedFrame,
} from "./codex-test-doubles.js";
import { drainMicrotasks } from "../../../__fixtures__/drain-microtasks.js";
import { makeManualScheduler } from "../../../__fixtures__/manual-scheduler.js";
import { makeSilentDriverDiagnostics } from "../../../__fixtures__/silent-driver-diagnostics.js";

// --------------------------------------------------------------------------
// Spawn and handshake
// --------------------------------------------------------------------------

describe("CodexDriver spawn and handshake", () => {
  it("spawns the provider behind the termios prelude and declines experimental surfaces", async () => {
    const harness = createHarness();
    await createdSession(harness);

    const spawnRequest = harness.server.spawnRequests[0];
    expect(spawnRequest).toBeDefined();
    expect(spawnRequest?.command).toBe("/bin/sh");
    // The stdio default: the prelude script, its `$0` label, and the word naming the subcommand.
    // `"$@"` carries the transport argv as positional parameters the shell never re-parses.
    expect(spawnRequest?.args).toEqual([
      "-c",
      CODEX_APP_SERVER_SHELL_PRELUDE,
      CODEX_APP_SERVER_SHELL_ARGV0,
      "app-server",
    ]);
    expect(spawnRequest?.cwd).toBe(SESSION_CWD);

    const initialize = harness.server.framesForMethod("initialize")[0];
    expect(initialize?.["params"]).toMatchObject({
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    expect(harness.server.framesForMethod("initialized")).toHaveLength(1);
  });

  it("passes exactly the supplied environment plus the binary path, never process.env", async () => {
    const harness = createHarness();
    await createdSession(harness);

    // Exact equality: a leaked `process.env` would add entries, and the driver must never
    // consult it.
    expect(harness.server.spawnRequests[0]?.env).toEqual([
      ["HOME", "/home/agent"],
      ["PATH", "/usr/bin"],
      [CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME, EXECUTABLE_PATH],
    ]);
  });

  it("waits for the prelude sentinel before writing anything", async () => {
    const harness = createHarness();
    harness.server.emitSentinelOnSubscribe = false;
    harness.server.on("thread/start", () => threadStartResult());

    const pending = harness.driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    // Drained, not counted: the create path resolves its credential policy before it opens a
    // connection, so the number of microtasks before the subscribe is not this test's concern.
    await drainMicrotasks();
    expect(harness.server.writtenLines).toHaveLength(0);

    harness.server.emitLine(CODEX_APP_SERVER_READY_SENTINEL);
    await pending;
    expect(harness.server.framesForMethod("initialize")).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
// createSession / startRun / interruptRun / closeSession
// --------------------------------------------------------------------------

describe("CodexDriver lifecycle operations", () => {
  it("starts a thread and returns the provider handle split", async () => {
    const harness = createHarness();
    harness.server.on("thread/start", () => threadStartResult());

    const handle = await harness.driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });

    // `thread.id` is the resume key; `thread.sessionId` groups a thread tree
    // (forks and subagents share it), so the two are not interchangeable.
    expect(handle).toEqual({ providerSessionId: "session-tree-1", resumeHandle: THREAD_ID });
    expect(harness.server.framesForMethod("thread/start")[0]?.["params"]).toEqual({
      cwd: SESSION_CWD,
      approvalsReviewer: "user",
    });
  });

  it("starts a turn with the pinned UserInput shape", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));

    await harness.driver.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "review the diff" },
    });

    expect(harness.server.framesForMethod("turn/start")[0]?.["params"]).toEqual({
      threadId: THREAD_ID,
      // `text_elements` is REQUIRED on the pinned `UserInput` text arm.
      input: [{ type: "text", text: "review the diff", text_elements: [] }],
      approvalsReviewer: "user",
    });
  });

  it("carries a per-turn output schema when the caller supplies one", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));

    await harness.driver.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "summarize" },
      outputSchema: { type: "object" },
    });

    expect(harness.server.framesForMethod("turn/start")[0]?.["params"]).toMatchObject({
      outputSchema: { type: "object" },
    });
  });

  it("interrupts the turn bound to the run", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("turn/interrupt", () => ({ result: {} }));

    await harness.driver.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    await harness.driver.interruptRun({ runId: RUN_ID });

    expect(harness.server.framesForMethod("turn/interrupt")[0]?.["params"]).toEqual({
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
  });

  it("unsubscribes from the thread and closes the process", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("thread/unsubscribe", () => ({ result: {} }));

    await harness.driver.closeSession({ sessionId: SESSION_ID });

    expect(harness.server.framesForMethod("thread/unsubscribe")[0]?.["params"]).toEqual({
      threadId: THREAD_ID,
    });
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });

  it("still tears the process down when the unsubscribe is refused", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("thread/unsubscribe", () => ({
      error: { code: -32600, message: "thread not found" },
    }));

    await expect(harness.driver.closeSession({ sessionId: SESSION_ID })).resolves.toBeUndefined();
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });
});

// --------------------------------------------------------------------------
// Resume failure never becomes a new session
// --------------------------------------------------------------------------

describe("CodexDriver resumeSession", () => {
  it("returns the typed resumed result carrying the provider's turn count", async () => {
    const harness = createHarness();
    harness.server.on("thread/resume", () => threadStartResult(3));

    const result = await harness.driver.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });

    expect(result).toEqual({ status: "resumed", bindingId: "binding-abc", sessionPosition: 3 });
  });

  it("round-trips the resume handle byte-identically into thread/resume", async () => {
    const harness = createHarness();
    harness.server.on("thread/start", () => threadStartResult());
    const handle = await harness.driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    harness.server.on("thread/resume", () => threadStartResult(1));

    await harness.driver.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: handle.resumeHandle,
    });

    expect(harness.server.framesForMethod("thread/resume")[0]?.["params"]).toEqual({
      threadId: handle.resumeHandle,
      approvalsReviewer: "user",
    });
  });

  it("refuses a resume answered by a DIFFERENT thread, even with a well-formed history", async () => {
    const harness = createHarness();
    const createSessionSpy = vi.spyOn(harness.driver, "createSession");
    const replacementThreadId = "01a04202-0148-7ae2-8560-000000000999";
    // `turns: []` is a well-formed history, so the position check cannot tell this from a genuine
    // zero-turn resume; only the id can, which is why the identity check runs first.
    harness.server.on("thread/resume", () => ({
      result: { thread: { id: replacementThreadId, sessionId: "session-tree-9", turns: [] } },
    }));

    const result = await harness.driver.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });

    expect(result).toMatchObject({
      status: "failed",
      recoveryCondition: "recovery-needed",
    });
    // Both ids named, so the person can see which thread answered.
    const detail = (result as { providerFailureDetail: string }).providerFailureDetail;
    expect(detail).toContain(THREAD_ID);
    expect(detail).toContain(replacementThreadId);
    // Typed result, no createSession call, and no `thread/start` frame on the wire.
    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(harness.server.framesForMethod("thread/start")).toHaveLength(0);
    // The refused process is released rather than left running.
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });

  it("does not install a session record for a resume answered by a different thread", async () => {
    const harness = createManagerHarness();
    harness.server.on("thread/resume", () => ({
      result: { thread: { id: "01a04202-0148-7ae2-8560-000000000999", sessionId: "s", turns: [] } },
    }));

    const result = await harness.manager.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });
    expect(result.status).toBe("failed");

    // Nothing installed: a later create must be admitted, which it could not be if the refused
    // resume had taken the slot.
    harness.server.on("thread/start", () => threadStartResult());
    await expect(
      harness.manager.createSession({
        model: TEST_MODEL,
        sessionId: SESSION_ID,
        config: SESSION_CONFIG,
      }),
    ).resolves.toMatchObject({ resumeHandle: THREAD_ID });
  });

  it("surfaces recovery-needed and creates NO replacement session when resume is refused", async () => {
    const harness = createHarness();
    // The verbatim refusal the pinned binary returns for an unknown or never-persisted thread
    // (probed against codex-cli 0.149.1).
    harness.server.on("thread/resume", () => ({
      error: { code: -32600, message: `no rollout found for thread id ${THREAD_ID}` },
    }));
    const createSessionSpy = vi.spyOn(harness.driver, "createSession");

    const result = await harness.driver.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });

    expect(result).toEqual({
      status: "failed",
      recoveryCondition: "recovery-needed",
      providerFailureDetail: expect.stringContaining("no rollout found"),
    });
    // A replacement can slip in through the public create or a private helper, so both the spy
    // and the wire are checked.
    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(harness.server.framesForMethod("thread/start")).toHaveLength(0);
    // and the failed attempt's process is not left running
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });

  it("returns the typed failure when the process dies before answering", async () => {
    const harness = createHarness();
    harness.server.emitSentinelOnSubscribe = false;

    const pending = harness.driver.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });
    // Drained, not counted: the slot claim defers the establishment body by a microtask, so a
    // fixed hop count would leave the connection unsubscribed and the exit would reach nobody.
    await drainMicrotasks();
    harness.server.emitExit(126);

    await expect(pending).resolves.toMatchObject({
      status: "failed",
      recoveryCondition: "recovery-needed",
    });
  });

  it("spawns the resume process with the caller-supplied resume context", async () => {
    const harness = createHarness();
    harness.server.on("thread/resume", () => threadStartResult(1));

    await harness.driver.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });

    // A resume is a fresh spawn and `ResumeSessionParams` carries no spawn context, so an empty
    // environment here would look like a bad handle.
    expect(harness.server.spawnRequests[0]?.cwd).toBe(RESUME_SPAWN_CONFIG.cwd);
    expect(harness.server.spawnRequests[0]?.env).toEqual([
      ["HOME", "/home/agent"],
      [CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME, EXECUTABLE_PATH],
    ]);
  });

  it("releases the superseded leg's process once the resume has succeeded", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.spawnResponse = { kind: "spawn_response", session_id: "pty-session-2" };
    harness.server.on("thread/resume", () => threadStartResult(3));

    await expect(
      harness.driver.resumeSession({
        model: TEST_MODEL,
        sessionId: SESSION_ID,
        resumeHandle: THREAD_ID,
      }),
    ).resolves.toMatchObject({ status: "resumed" });

    // A resume is a fresh spawn, so the earlier process would be orphaned by a driver that only
    // overwrote its session record.
    expect(harness.server.spawnRequests).toHaveLength(2);
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });

  it("leaves the prior leg untouched when the resume fails", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.spawnResponse = { kind: "spawn_response", session_id: "pty-session-2" };
    harness.server.on("thread/resume", () => ({
      error: { code: -32600, message: "thread not found" },
    }));

    await expect(
      harness.driver.resumeSession({
        model: TEST_MODEL,
        sessionId: SESSION_ID,
        resumeHandle: THREAD_ID,
      }),
    ).resolves.toMatchObject({ recoveryCondition: "recovery-needed" });

    // Only the process that just failed is torn down. Killing the live one would make a refused
    // resume destructive: the daemon decides what happens next and still needs a session to
    // decide about.
    expect(harness.server.closedSessions).toEqual(["pty-session-2"]);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await expect(
      harness.driver.startRun({
        runId: RUN_ID,
        agentConfig: { sessionId: SESSION_ID, input: "carry on" },
      }),
    ).resolves.toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// Session identity and process ownership
// --------------------------------------------------------------------------

describe("CodexDriver session ownership", () => {
  it("refuses a second createSession for a live session, spawning nothing", async () => {
    const harness = createHarness();
    await createdSession(harness);

    await expect(
      harness.driver.createSession({
        model: TEST_MODEL,
        sessionId: SESSION_ID,
        config: SESSION_CONFIG,
      }),
    ).rejects.toBeInstanceOf(CodexSessionAlreadyLiveError);
    // A replace would leave the first child running with nothing routing to it.
    expect(harness.server.spawnRequests).toHaveLength(1);
    expect(harness.server.closedSessions).toEqual([]);
  });

  // Driven at the connection, because `createSession` has its own guard that would release
  // the child anyway. `open()` must never leave a child behind, for every caller.
  it("open() itself releases the child when the subscriber throws", async () => {
    const server = new FakeCodexAppServer();
    const scheduler = makeManualScheduler();
    const connection = new CodexAppServerConnection({
      ptyHost: server,
      subscribeToPtySession: () => {
        throw new Error("subscription registry refused the attach");
      },
      reportDiagnostic: () => {},
      scheduleTimeout: scheduler.schedule,
      executablePath: EXECUTABLE_PATH,
    });

    await expect(connection.open(RESUME_SPAWN_CONFIG)).rejects.toThrow(/refused the attach/);
    expect(server.spawnRequests).toHaveLength(1);
    expect(server.closedSessions).toEqual(["pty-session-1"]);
  });

  it("fails a superseded leg's unsettled frame as a supersede, never as a swallowed turn", async () => {
    // Text that may not have reached the model must never vanish silently. The resume replaces
    // the binding the frame was written on, so no terminal for it can arrive, and a dropped
    // frame would look like a run whose words landed.
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    // Started and never settled: no terminal notification is sent, so the opening frame is
    // still pending when the resume supersedes the leg.
    await harness.driver.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "please rebase onto develop" },
    });

    harness.server.spawnResponse = { kind: "spawn_response", session_id: "pty-session-2" };
    harness.server.on("thread/resume", () => threadStartResult(2));
    await harness.driver.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });

    expect(harness.textNeutralizationFailures).toHaveLength(1);
    expect(harness.textNeutralizationFailures[0]?.runId).toBe(RUN_ID);

    // Borrowing the trip's detail would publish a swallow nobody observed, and that detail's
    // registered code has a fixed parseable form that consumers act on.
    const detail = harness.textNeutralizationFailures[0]?.providerFailureDetail ?? "";
    expect(detail).not.toContain(TEXT_NEUTRALIZATION_REFUSAL_CODE);
    expect(detail).toContain("superseded");
    // The user's own words are never quoted into the detail.
    expect(detail).not.toContain("rebase");
  });

  it("reports one failure per run, not one per frame", async () => {
    // Two frames on one run (the opening frame and a steer) and one supersede: one cause, so
    // one report, not one per frame.
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("turn/steer", () => ({ result: { turnId: TURN_ID } }));
    await harness.driver.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "please rebase onto develop" },
    });
    await harness.driver.applyIntervention({
      type: "steer",
      targetRunId: RUN_ID,
      expectedRunVersion: 1,
      clientIdempotencyKey: "9a1d8f30-0000-4000-8000-0000000000ab",
      payload: { content: "and squash the fixups", expectedTurnId: TURN_ID },
    });

    harness.server.spawnResponse = { kind: "spawn_response", session_id: "pty-session-2" };
    harness.server.on("thread/resume", () => threadStartResult(2));
    await harness.driver.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });

    expect(harness.textNeutralizationFailures).toHaveLength(1);
    const reported = harness.diagnostics.filter(
      (diagnostic) => diagnostic.kind === "superseded-frames-failed",
    );
    expect(reported).toHaveLength(1);
    // The frame count is the person's only sight of the writes the superseded binding was
    // carrying, so it is not collapsed to the report count.
    expect(reported[0]).toMatchObject({ abandonedFrameCount: 2, reportedRunCount: 1 });
  });
});

describe("CodexDriver approval reviewer pinning", () => {
  // Every approval request must reach the daemon's own approval pipeline, so no config or
  // profile override may select `auto_review`. `approvalsReviewer` exists on the thread start,
  // thread resume and turn start params (checked against the generated schema of
  // `codex-cli 0.150.1`), and the per-turn field overrides routing for "this turn and
  // subsequent turns", so a thread-level pin alone would be defeated by a per-turn override.
  it("pins the reviewer on the thread AND on every turn, not just at thread start", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));

    await harness.driver.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "one" },
    });
    await harness.driver.startRun({
      runId: SECOND_RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "two" },
    });

    expect(harness.server.framesForMethod("thread/start")[0]?.["params"]).toMatchObject({
      approvalsReviewer: "user",
    });
    const turnFrames = harness.server.framesForMethod("turn/start");
    expect(turnFrames).toHaveLength(2);
    // Every turn, not just the first: skipping the idempotent pin on later turns is the gap a
    // per-turn override would use.
    for (const frame of turnFrames) {
      expect(frame["params"]).toMatchObject({ approvalsReviewer: "user" });
    }
  });
});

// --------------------------------------------------------------------------
// Zero-turn auth probe — `getAuthStatus` over a dedicated connection
// --------------------------------------------------------------------------

describe("CodexLifecycleManager probeAuth", () => {
  function probingHarness(answer: JsonRpcAnswer | undefined): ManagerHarness {
    const harness = createManagerHarness();
    if (answer !== undefined) {
      harness.server.on("getAuthStatus", () => answer);
    }
    return harness;
  }

  it("never asks the provider to refresh, and never asks for the token", async () => {
    const harness = probingHarness({ result: { authMethod: "chatgpt", authToken: null } });

    await harness.manager.probeAuth();

    // `refreshToken: false` is the load-bearing half: the pinned providers rotate refresh tokens
    // single-use with no grace window, so a refreshing probe would end the login it checks.
    // Both members are asserted present, not just falsy: `GetAuthStatusParams` types them
    // required-but-nullable, so omitting one leaves the behavior to the provider's default.
    expect(harness.server.framesForMethod("getAuthStatus")[0]?.["params"]).toEqual({
      includeToken: false,
      refreshToken: false,
    });
  });

  it("reports authenticated and names the auth method, never the token", async () => {
    const harness = probingHarness({
      result: {
        authMethod: "chatgpt",
        authToken: "sk-should-never-be-read",
        requiresOpenaiAuth: true,
      },
    });

    const result = await harness.manager.probeAuth();

    expect(result.status).toBe("authenticated");
    expect(result.detail).toContain("chatgpt");
    // `authMethod` is a closed mechanism enum and safe as diagnostics; the token is credential
    // material this driver must never echo.
    expect(JSON.stringify(result)).not.toContain("sk-should-never-be-read");
  });

  it("reports unauthenticated when no auth method is resolved", async () => {
    const harness = probingHarness({
      result: { authMethod: null, authToken: null, requiresOpenaiAuth: true },
    });

    await expect(harness.manager.probeAuth()).resolves.toMatchObject({
      status: "unauthenticated",
    });
  });

  it("reports indeterminate — not unauthenticated — when the probe surface refuses", async () => {
    const harness = probingHarness({
      error: { code: -32601, message: "Method not found" },
    });

    const result = await harness.manager.probeAuth();

    // Probe health and credential state are different facts with different actions for the person;
    // `unauthenticated` here would send the person to re-authenticate a credential never in
    // question.
    expect(result.status).toBe("indeterminate");
  });

  it("reports indeterminate when the answer is unreadable", async () => {
    const harness = probingHarness({ result: { authMethod: 17 } });

    await expect(harness.manager.probeAuth()).resolves.toMatchObject({
      status: "indeterminate",
    });
  });

  it("spawns from the constructed resume environment and tears the child down", async () => {
    const harness = probingHarness({ result: { authMethod: "apikey" } });

    await harness.manager.probeAuth();

    // The probe is a spawn like any other: its environment is constructed from
    // `resumeSpawnConfig`, never inherited from the daemon.
    const spawn = harness.server.spawnRequests[0];
    expect(spawn?.cwd).toBe(RESUME_SPAWN_CONFIG.cwd);
    expect(spawn?.env).toEqual([
      ["HOME", "/home/agent"],
      [CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME, EXECUTABLE_PATH],
    ]);
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });

  it("starts no thread — the probe is zero-turn, not a discardable session", async () => {
    const harness = probingHarness({ result: { authMethod: "chatgpt" } });

    await harness.manager.probeAuth();

    expect(harness.server.framesForMethod("thread/start")).toEqual([]);
    expect(harness.server.framesForMethod("turn/start")).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// Credential-policy strip at the spawn seam
// --------------------------------------------------------------------------

describe("CodexDriver credential-policy strip at the spawn seam", () => {
  const DENIED_ENV_VAR = "ANTHROPIC_API_KEY";

  // The daemon's resolution of the posture's `credentialPolicyRef`. The driver is handed the
  // names because it never expands a reference, which would disclose what the ref hides.
  const DENY_POLICY = { denyEnvVars: [DENIED_ENV_VAR], envNameMatch: "case-sensitive" } as const;

  it("strips a denied name from a created session's child", async () => {
    // Also the no-posture arm of the create path: with no `executionPosture`, the config bag's
    // own policy governs and the resolver is never consulted.
    const harness = createHarness();
    harness.server.on("thread/start", () => threadStartResult());

    await harness.driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: {
        cwd: SESSION_CWD,
        env: [
          ["HOME", "/home/agent"],
          [DENIED_ENV_VAR, "sk-live"],
        ],
        credentialEnvPolicy: DENY_POLICY,
      },
    });

    // Byte-exact, so a builder that also dropped or reordered something else fails.
    expect(harness.server.spawnRequests[0]?.env).toEqual([
      ["HOME", "/home/agent"],
      [CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME, EXECUTABLE_PATH],
    ]);
  });

  it("strips it on a resume relaunch, which is a fresh spawn from a different config", async () => {
    // Every path goes through one builder; this config never passes through `createSession`,
    // so a create-site composition would have shed the strip here.
    const harness = createHarness({
      resumeSpawnConfig: {
        cwd: "/work/resume",
        env: [
          ["HOME", "/home/agent"],
          [DENIED_ENV_VAR, "sk-live"],
        ],
        credentialEnvPolicy: DENY_POLICY,
      },
    });
    harness.server.on("thread/resume", () => threadStartResult(1));

    await harness.driver.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });

    expect(harness.server.spawnRequests[0]?.env).toEqual([
      ["HOME", "/home/agent"],
      [CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME, EXECUTABLE_PATH],
    ]);
  });

  // The two postures a spawn can be established under. A session's posture can change between
  // create and resume, and the child must follow the current one in both directions; both
  // paths resolve through the same rule, so the create and resume arms below share these.
  const SANDBOXED_POSTURE: ExecutionPosture = {
    mode: "workspace-sandboxed",
    credentialPolicyRef: "policy://resume",
    networkAccess: "none",
    writableRoots: [SESSION_CWD],
  };

  it("strips under the CREATED posture's policy though the config bag declared none", async () => {
    // A sandboxed posture requires a `credentialPolicyRef`, but the config bag is untyped and
    // can omit `credentialEnvPolicy`. That silence must not read as "deny nothing", which would
    // open the child holding the credential the posture withholds. Resume already re-derives the
    // policy; this is the same rule reached from the create composer.
    const harness = createHarness({
      resolveCredentialEnvPolicy: () => Promise.resolve(DENY_POLICY),
    });
    harness.server.on("thread/start", () => threadStartResult());

    await harness.driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: {
        cwd: SESSION_CWD,
        env: [
          ["HOME", "/home/agent"],
          [DENIED_ENV_VAR, "sk-live"],
        ],
      },
      executionPosture: SANDBOXED_POSTURE,
    });

    expect(harness.server.spawnRequests[0]?.env).toEqual([
      ["HOME", "/home/agent"],
      [CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME, EXECUTABLE_PATH],
    ]);
  });

  it("lets the CREATED posture's policy override a bag that named a different one", async () => {
    // The precedence arm, the only one where both channels speak. A resolution that merely
    // filled in for an absent bag policy would pass the other arms. Here the bag denies one name
    // and the posture resolves another: the posture's answer must govern whole, not be merged
    // with or deferred to the bag's.
    const OTHER_DENIED_ENV_VAR = "OPENAI_API_KEY";
    const harness = createHarness({
      resolveCredentialEnvPolicy: () =>
        Promise.resolve({
          denyEnvVars: [OTHER_DENIED_ENV_VAR],
          envNameMatch: "case-sensitive",
        }),
    });
    harness.server.on("thread/start", () => threadStartResult());

    await harness.driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: {
        cwd: SESSION_CWD,
        env: [
          ["HOME", "/home/agent"],
          [DENIED_ENV_VAR, "sk-live"],
          [OTHER_DENIED_ENV_VAR, "sk-other"],
        ],
        credentialEnvPolicy: DENY_POLICY,
      },
      executionPosture: SANDBOXED_POSTURE,
    });

    // The posture's name is gone and the bag's name survives: a fallback-only resolution fails
    // the survival, and an ignore-the-posture composition fails the strip.
    expect(harness.server.spawnRequests[0]?.env).toEqual([
      ["HOME", "/home/agent"],
      [DENIED_ENV_VAR, "sk-live"],
      [CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME, EXECUTABLE_PATH],
    ]);
  });

  it("refuses a CREATED posture that resolves to no policy, before anything is spawned", async () => {
    // The create twin of the resume refusal, through a different channel: `resumeSession`
    // returns a typed `failed` result, while `createSession` has no result type and raises the
    // same typed config error its bag parse raises.
    const harness = createHarness({
      resolveCredentialEnvPolicy: () => Promise.resolve(undefined),
    });
    harness.server.on("thread/start", () => threadStartResult());

    const refused = await harness.driver
      .createSession({
        model: TEST_MODEL,
        sessionId: SESSION_ID,
        config: {
          cwd: SESSION_CWD,
          env: [
            ["HOME", "/home/agent"],
            [DENIED_ENV_VAR, "sk-live"],
          ],
        },
        executionPosture: SANDBOXED_POSTURE,
      })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );

    expect(refused).toBeInstanceOf(CodexDriverConfigError);
    // The field is the create request's own parameter path. The shared helper takes it as an
    // argument, so without this a caller passing the resume label would name a parameter the
    // person never sent, and nothing would fail.
    expect((refused as CodexDriverConfigError).field).toBe(
      "CreateSessionParams.executionPosture.credentialPolicyRef",
    );
    // Nothing was spawned: the composition runs before the connection object exists, so no child
    // held the environment the policy filters.
    expect(harness.server.spawnRequests).toEqual([]);
  });

  it("hands the create's RESOLVED policy to a resume that states no posture", async () => {
    // The create's posture resolves a policy the bag never declared, and the record stores that
    // resolution rather than the bag, so a resume stating no posture inherits the policy the child
    // ran under. Inheriting the bag's absence would relaunch unfiltered.
    const harness = createHarness({
      resolveCredentialEnvPolicy: () => Promise.resolve(DENY_POLICY),
    });
    harness.server.on("thread/start", () => threadStartResult());
    await harness.driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: {
        cwd: SESSION_CWD,
        env: [
          ["HOME", "/home/agent"],
          [DENIED_ENV_VAR, "sk-live"],
        ],
      },
      executionPosture: SANDBOXED_POSTURE,
    });
    harness.server.on("thread/resume", () => threadStartResult(1));

    await harness.driver.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });

    expect(harness.server.spawnRequests[1]?.env).toEqual([
      ["HOME", "/home/agent"],
      [CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME, EXECUTABLE_PATH],
    ]);
  });

  it("strips under the RESUMED posture's policy though the create-time posture had none", async () => {
    // The create leg carries no policy, so the session's recorded spawn config denies nothing.
    // A resume reusing that record would relaunch the child holding the credential the current
    // posture withholds.
    const harness = createHarness({
      resolveCredentialEnvPolicy: () => Promise.resolve(DENY_POLICY),
    });
    harness.server.on("thread/start", () => threadStartResult());
    await harness.driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: {
        cwd: SESSION_CWD,
        env: [
          ["HOME", "/home/agent"],
          [DENIED_ENV_VAR, "sk-live"],
        ],
      },
    });
    harness.server.on("thread/resume", () => threadStartResult(1));

    await harness.driver.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
      executionPosture: SANDBOXED_POSTURE,
    });

    // The second spawn is the resume's. Byte-exact, so a strip that also dropped or reordered
    // the inherited process context would fail.
    expect(harness.server.spawnRequests[1]?.env).toEqual([
      ["HOME", "/home/agent"],
      [CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME, EXECUTABLE_PATH],
    ]);
  });

  it("honors the resumed posture on a COLD resume, which has no record to reuse", async () => {
    // The daemon-restart case: `resumeSpawnConfig` is one construction-time object, so it can
    // carry at most one policy for every session on the node (here, none).
    const harness = createHarness({
      resumeSpawnConfig: {
        cwd: "/work/resume",
        env: [
          ["HOME", "/home/agent"],
          [DENIED_ENV_VAR, "sk-live"],
        ],
      },
      resolveCredentialEnvPolicy: () => Promise.resolve(DENY_POLICY),
    });
    harness.server.on("thread/resume", () => threadStartResult(1));

    await harness.driver.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
      executionPosture: SANDBOXED_POSTURE,
    });

    expect(harness.server.spawnRequests[0]?.env).toEqual([
      ["HOME", "/home/agent"],
      [CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME, EXECUTABLE_PATH],
    ]);
  });

  it("refuses a posture that resolves to no policy, and refuses it as a RESULT", async () => {
    // Two properties, one guarantee. A non-`trusted` posture requires `credentialPolicyRef`, so an
    // unresolved policy is a wiring fault; degrading it to "deny nothing" would launch the child
    // holding the credentials the reference exists to withhold.
    const harness = createHarness({
      resolveCredentialEnvPolicy: () => Promise.resolve(undefined),
    });
    harness.server.on("thread/resume", () => threadStartResult(1));

    const result = await harness.driver.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
      executionPosture: SANDBOXED_POSTURE,
    });

    expect(result.status).toBe("failed");
    // Nothing was spawned: the refusal lands before `open()`, so no child held the environment
    // the policy filters.
    expect(harness.server.spawnRequests).toEqual([]);
  });

  it("strips it on the auth probe's child, the third spawn path", async () => {
    const harness = createManagerHarness({
      resumeSpawnConfig: {
        cwd: "/work/resume",
        env: [
          ["HOME", "/home/agent"],
          [DENIED_ENV_VAR, "sk-live"],
        ],
        credentialEnvPolicy: DENY_POLICY,
      },
    });

    await harness.manager.probeAuth();

    expect(harness.server.spawnRequests[0]?.env).toEqual([
      ["HOME", "/home/agent"],
      [CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME, EXECUTABLE_PATH],
    ]);
  });

  it("refuses a policy it cannot read rather than spawning with nothing stripped", () => {
    // Absent and malformed are different answers: defaulting a malformed policy to "deny nothing"
    // would spawn the child with the variables the policy exists to withhold. `envNameMatch` is
    // refused when missing for the same reason: the mode decides whether `path` slips past a list
    // naming `PATH`, and this side of the wire does not know the host.
    const unreadablePolicies: readonly unknown[] = [
      {},
      { denyEnvVars: [], envNameMatch: "whatever-the-host-does" },
      { denyEnvVars: ["A"] },
      { denyEnvVars: "ANTHROPIC_API_KEY", envNameMatch: "case-sensitive" },
      { denyEnvVars: [""], envNameMatch: "case-sensitive" },
      { denyEnvVars: [1], envNameMatch: "case-sensitive" },
      "case-sensitive",
    ];
    for (const credentialEnvPolicy of unreadablePolicies) {
      expect(() => parseCodexSessionConfig({ ...SESSION_CONFIG, credentialEnvPolicy })).toThrow(
        CodexDriverConfigError,
      );
    }
  });
});

// --------------------------------------------------------------------------
// Provider-account precedence at the spawn seam
// --------------------------------------------------------------------------

describe("CodexDriver provider-account precedence at the spawn seam", () => {
  const ADMITTED_ACCOUNT_ID = "account-admitted";
  const NODE_DEFAULT_ACCOUNT_ID = "account-node-default";

  /**
   * Reads the account the session's spawn config carries back through `listProviderCommands`,
   * which composes each entry's routing binding from `record.spawnConfig.providerAccountId`. A
   * private field read would not prove the value reaches the consumer that routes on it.
   */
  async function boundAccountId(harness: Harness): Promise<string | null> {
    const result = await harness.driver.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    return result.bindings[0]?.binding.providerAccountId ?? null;
  }

  function accountHarness(options: { resumeSpawnConfig?: CodexSessionConfig } = {}): Harness {
    const harness = createHarness(
      options.resumeSpawnConfig === undefined
        ? {}
        : { resumeSpawnConfig: options.resumeSpawnConfig },
    );
    // Required wherever a resume runs: the resume holds the new and the superseded connection at
    // once, and the fake's listener registry is keyed by pty session id, so shared ids let the
    // predecessor's unsubscribe delete the live reader. A fixture artifact, not a behavior.
    harness.server.uniqueSpawnSessionIds = true;
    harness.server.on("thread/start", () => threadStartResult());
    harness.server.on("thread/resume", () => threadStartResult(1));
    harness.server.on("thread/unsubscribe", () => ({ result: {} }));
    harness.server.on("skills/list", () => ({
      result: {
        data: [
          {
            cwd: SESSION_CWD,
            skills: [
              { name: "review", description: "Review a diff", scope: "repo", enabled: true },
            ],
            errors: [],
          },
        ],
      },
    }));
    return harness;
  }

  it("binds a create to the TYPED member when the config bag names none", async () => {
    // Without the typed member, a caller following the typed contract would spawn against the
    // node's default account for that provider while the receipt's per-paying-account key still
    // named the admitted one: a silent re-bill instead of a visible failure.
    const harness = accountHarness();

    await harness.driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
      providerAccountId: ADMITTED_ACCOUNT_ID,
    });

    expect(await boundAccountId(harness)).toBe(ADMITTED_ACCOUNT_ID);
  });

  it("binds a create through the config-bag channel when the typed member is absent", async () => {
    // In-tree callers name an account through the config bag, so it stays a fallback beside the
    // typed member.
    const harness = accountHarness();

    await harness.driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: { ...SESSION_CONFIG, providerAccountId: ADMITTED_ACCOUNT_ID },
    });

    expect(await boundAccountId(harness)).toBe(ADMITTED_ACCOUNT_ID);
  });

  it("REFUSES a create whose two channels name different accounts, before anything spawns", async () => {
    // Neither resolver may silently win: the typed one would override a caller that declared an
    // account, and the bag would reintroduce the silent re-bill. Refusing is the only answer that
    // cannot move a run's spend without saying so.
    const harness = accountHarness();

    const refused = await harness.driver
      .createSession({
        model: TEST_MODEL,
        sessionId: SESSION_ID,
        config: { ...SESSION_CONFIG, providerAccountId: NODE_DEFAULT_ACCOUNT_ID },
        providerAccountId: ADMITTED_ACCOUNT_ID,
      })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );

    expect(refused).toBeInstanceOf(CodexDriverConfigError);
    // The field names the TYPED member's own parameter path, so the person is
    // pointed at the authoritative channel rather than at the config bag.
    expect((refused as CodexDriverConfigError).field).toBe("CreateSessionParams.providerAccountId");
    // Both account ids are named, so the person can tell which resolver is wrong.
    expect((refused as CodexDriverConfigError).message).toContain(ADMITTED_ACCOUNT_ID);
    expect((refused as CodexDriverConfigError).message).toContain(NODE_DEFAULT_ACCOUNT_ID);
    // Nothing was spawned: the composition runs before the connection object exists, so no child
    // ran under an unsettled billing identity.
    expect(harness.server.spawnRequests).toEqual([]);
  });

  it("REFUSES a present-but-empty typed member, exactly as the bag parse does", async () => {
    // An empty string is a daemon that meant to bind an account and bound nothing, which differs
    // from a session that never had one; only the latter may enumerate under a `null` account.
    // Enforced on the typed channel too, because it reaches the composer without the bag parse.
    const harness = accountHarness();

    const refused = await harness.driver
      .createSession({
        model: TEST_MODEL,
        sessionId: SESSION_ID,
        config: SESSION_CONFIG,
        providerAccountId: "",
      })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );

    expect(refused).toBeInstanceOf(CodexDriverConfigError);
    expect(harness.server.spawnRequests).toEqual([]);
  });

  it("binds a COLD resume when the typed member and the node-wide default AGREE", async () => {
    // The cold arm's only admitting case; without it the refusals below would pass for an arm
    // that refuses every typed member.
    const harness = accountHarness({
      resumeSpawnConfig: { ...RESUME_SPAWN_CONFIG, providerAccountId: ADMITTED_ACCOUNT_ID },
    });

    const result = await harness.driver.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
      providerAccountId: ADMITTED_ACCOUNT_ID,
    });

    expect(result.status).toBe("resumed");
    expect(await boundAccountId(harness)).toBe(ADMITTED_ACCOUNT_ID);
  });

  it("REFUSES a COLD resume that names an account the available environment was not built for", async () => {
    // A cold resume has no record to relaunch from, so `cwd` and `env` come from the node-wide
    // `resumeSpawnConfig`, whose `env` was built for the default account. The driver never
    // locates credentials, so honoring the typed account would change only the metadata: the
    // binding would name one account while the child authenticated and billed as another.
    const harness = accountHarness({
      resumeSpawnConfig: { ...RESUME_SPAWN_CONFIG, providerAccountId: NODE_DEFAULT_ACCOUNT_ID },
    });

    const result = await harness.driver.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
      providerAccountId: ADMITTED_ACCOUNT_ID,
    });

    // The refusal arrives as a typed result, not a rejection.
    expect(result.status).toBe("failed");
    // Both accounts are named so the person can see which side is wrong.
    const detail = result.status === "failed" ? result.providerFailureDetail : "";
    expect(detail).toContain(ADMITTED_ACCOUNT_ID);
    expect(detail).toContain(NODE_DEFAULT_ACCOUNT_ID);
    // Refused before `open()`, so no child authenticated under the wrong credential home.
    expect(harness.server.spawnRequests).toEqual([]);
  });

  it("REFUSES a COLD resume that names an account while the node-wide default is UNBOUND", async () => {
    // A default carrying no account is an environment built for no bound account, not a wildcard
    // that matches every request. Treating absence as agreement would let any cold resume claim
    // any account.
    const harness = accountHarness();

    const result = await harness.driver.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
      providerAccountId: ADMITTED_ACCOUNT_ID,
    });

    expect(result.status).toBe("failed");
    const detail = result.status === "failed" ? result.providerFailureDetail : "";
    expect(detail).toContain(ADMITTED_ACCOUNT_ID);
    // The unbound side is spelled out in words because there is no id to print.
    expect(detail).toContain("no bound account");
    expect(harness.server.spawnRequests).toEqual([]);
  });

  it("falls back to the node-wide default on a cold resume that names no account", async () => {
    // Guards the precedence above against a composer that stopped reading the fallback.
    const harness = accountHarness({
      resumeSpawnConfig: { ...RESUME_SPAWN_CONFIG, providerAccountId: NODE_DEFAULT_ACCOUNT_ID },
    });

    await harness.driver.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });

    expect(await boundAccountId(harness)).toBe(NODE_DEFAULT_ACCOUNT_ID);
  });

  it("re-realizes the live record's account on a resume that names none", async () => {
    // A resume keeps the credential home the session was created under; an account that moved
    // mid-session would re-key the receipt's per-paying-account axis.
    const harness = accountHarness({
      resumeSpawnConfig: { ...RESUME_SPAWN_CONFIG, providerAccountId: NODE_DEFAULT_ACCOUNT_ID },
    });
    await harness.driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
      providerAccountId: ADMITTED_ACCOUNT_ID,
    });

    await harness.driver.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });

    // The record's account, not the node-wide default beside it.
    expect(await boundAccountId(harness)).toBe(ADMITTED_ACCOUNT_ID);
  });

  it("REFUSES a resume whose typed member contradicts the live record, as a RESULT", async () => {
    // The live record is what this session's process runs under, so a different typed account is
    // two resolvers disagreeing about one session's billing identity; the node-wide default
    // claims nothing about this session.
    const harness = accountHarness();
    await harness.driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
      providerAccountId: ADMITTED_ACCOUNT_ID,
    });
    const spawnsAfterCreate = harness.server.spawnRequests.length;

    const result = await harness.driver.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
      providerAccountId: NODE_DEFAULT_ACCOUNT_ID,
    });

    expect(result.status).toBe("failed");
    // No second child was spawned: the refusal lands before `open()`.
    expect(harness.server.spawnRequests).toHaveLength(spawnsAfterCreate);
    // A failed resume changes nothing: the predecessor stays live and bound to its account.
    expect(await boundAccountId(harness)).toBe(ADMITTED_ACCOUNT_ID);
  });

  it("REFUSES a WARM resume that names an account while the live record bound NONE", async () => {
    // Same divergence as the cold arm, from the other side: a warm resume relaunches under the
    // live record's environment, and a record whose create bound no account carries an ambient
    // one. Honoring the typed account would report it off a binding whose child authenticates as
    // whoever owns that ambient environment.
    //
    // This is a wiring fault, not a caller mistake, so it fails closed: the typed account is
    // composed from the durable record, so naming one while the live record names none means two
    // records disagree about one session.
    const harness = accountHarness({
      resumeSpawnConfig: { ...RESUME_SPAWN_CONFIG, providerAccountId: NODE_DEFAULT_ACCOUNT_ID },
    });
    // A create that binds no account through either channel.
    await harness.driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    const spawnsAfterCreate = harness.server.spawnRequests.length;

    const result = await harness.driver.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
      providerAccountId: ADMITTED_ACCOUNT_ID,
    });

    expect(result.status).toBe("failed");
    const detail = result.status === "failed" ? result.providerFailureDetail : "";
    expect(detail).toContain(ADMITTED_ACCOUNT_ID);
    // The unbound side is spelled out in words because there is no id to print.
    expect(detail).toContain("no bound account");
    // Asserts which arm refused: the message names the live record as the environment's source.
    // The node-wide default carries a different account, so a cold-arm refusal would name that
    // account instead and fail here.
    expect(detail).toContain("live session record");
    expect(detail).not.toContain(NODE_DEFAULT_ACCOUNT_ID);
    // No second child was spawned, and the predecessor stays live and accountless.
    expect(harness.server.spawnRequests).toHaveLength(spawnsAfterCreate);
    expect(await boundAccountId(harness)).toBeNull();
  });

  it("keeps a WARM resume of an accountless session accountless, never adopting the node default", async () => {
    // A warm resume relaunches under the live record's `cwd` and `env`, so the account is the
    // record's, and an unbound record's is none. Falling back to the node default would report an
    // account whose credentials this child never holds. The node default carries an account here
    // because only then do the two readings differ.
    const harness = accountHarness({
      resumeSpawnConfig: { ...RESUME_SPAWN_CONFIG, providerAccountId: NODE_DEFAULT_ACCOUNT_ID },
    });
    await harness.driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });

    const result = await harness.driver.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });

    expect(result.status).toBe("resumed");
    expect(await boundAccountId(harness)).toBeNull();
  });

  it("binds a WARM resume when the typed member matches the live record's account", async () => {
    // The warm arm's positive control. The node-wide default carries a different account so an
    // arm that reported the default would fail instead of passing by coincidence.
    const harness = accountHarness({
      resumeSpawnConfig: { ...RESUME_SPAWN_CONFIG, providerAccountId: NODE_DEFAULT_ACCOUNT_ID },
    });
    await harness.driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
      providerAccountId: ADMITTED_ACCOUNT_ID,
    });

    const result = await harness.driver.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
      providerAccountId: ADMITTED_ACCOUNT_ID,
    });

    expect(result.status).toBe("resumed");
    expect(await boundAccountId(harness)).toBe(ADMITTED_ACCOUNT_ID);
  });
});

describe("CodexDriver turn posture realization", () => {
  // These arms assert the observed wire frame, so a composer that emitted `permissions` fails here
  // even if `assertRealizedTurnPostureMembers` were deleted. They do not prove the guard's
  // placement: a second, unguarded `turn/start` composer is caught only if a test drives it.
  it("realizes the sandboxPolicy member from a stamped posture and never the other", async () => {
    const harness = createHarness();
    harness.server.on("thread/start", () => threadStartResult());
    await harness.driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
      executionPosture: WORKSPACE_POSTURE_WITH_NETWORK,
    });
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));

    await harness.driver.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "review the diff" },
    });

    const params = firstParamsFor(harness, "turn/start");
    expect(params["sandboxPolicy"]).toBeDefined();
    expect(Object.keys(params)).not.toContain("permissions");
    expect(Object.keys(params)).not.toContain("permissionProfile");
  });

  it("refuses every posture-affecting field a caller declares, the whole class", async () => {
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
          agentConfig: {
            sessionId: SESSION_ID,
            input: "review the diff",
            [field]: "anything at all",
          },
        }),
      ).rejects.toBeInstanceOf(CodexDriverConfigError);
    }

    // Refused before the wire, not filtered on it.
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(0);
  });

  it("refuses an unrealized member, the un-combinable pair, and the field the pin refuses", () => {
    // The wire assertions above would pass for a driver with no guard at all; this shows that
    // constructing the member would be caught.
    expect(() =>
      assertRealizedTurnPostureMembers({ threadId: THREAD_ID, permissions: "profile-id" }),
    ).toThrow(CodexDriverConfigError);
    // An `experimentalApi` connection accepts this pair with no documented precedence, so the
    // provider cannot adjudicate it and it must be refused here.
    expect(() =>
      assertRealizedTurnPostureMembers({
        threadId: THREAD_ID,
        sandboxPolicy: { mode: "workspace-write" },
        permissions: "profile-id",
      }),
    ).toThrow(CodexDriverConfigError);
    // Refused with `-32602` by the pinned provider build.
    expect(() =>
      assertRealizedTurnPostureMembers({ threadId: THREAD_ID, permissionProfile: "profile-id" }),
    ).toThrow(CodexDriverConfigError);
  });
});

describe("CodexDriver resume-failure taxonomy", () => {
  const REFUSED_RESUME: JsonRpcAnswer = {
    error: { code: -32600, message: "thread not found" },
  };

  function refusingHarness(authAnswer: JsonRpcAnswer): Harness {
    const harness = createHarness();
    harness.server.on("thread/resume", () => REFUSED_RESUME);
    harness.server.on("getAuthStatus", () => authAnswer);
    return harness;
  }

  async function resume(harness: Harness): Promise<DriverResumeResult> {
    return await harness.driver.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });
  }

  it("reports reauth-required when the refusing provider resolves no auth method", async () => {
    const harness = refusingHarness({ result: { authMethod: null, requiresOpenaiAuth: true } });

    // The two conditions call for different actions by the person; an expired credential must not
    // be reported as "reconcile this by hand".
    await expect(resume(harness)).resolves.toMatchObject({
      status: "failed",
      recoveryCondition: "reauth-required",
    });
  });

  it("never spends a credential rotation to classify a failure", async () => {
    const harness = refusingHarness({ result: { authMethod: null } });

    await resume(harness);

    // The pinned providers rotate refresh tokens single-use with no grace window, so classifying
    // a failure by refreshing would end the login it was asking about.
    expect(harness.server.framesForMethod("getAuthStatus")[0]?.["params"]).toEqual({
      includeToken: false,
      refreshToken: false,
    });
  });
});

describe("CodexLifecycleManager steer wire shape", () => {
  const STEER_KEY = "9a1d8f30-0000-4000-8000-0000000000aa";

  /** A harness with one live session and one live turn, ready to be steered. */
  async function steerableHarness(steerAnswer: JsonRpcAnswer): Promise<Harness> {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("turn/steer", () => steerAnswer);
    await harness.driver.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "one" },
    });
    return harness;
  }

  function steerIntervention(expectedTurnId?: string): ApplyInterventionParams {
    return {
      type: "steer",
      targetRunId: RUN_ID,
      expectedRunVersion: 1,
      clientIdempotencyKey: STEER_KEY,
      payload: {
        content: "focus on the failing test",
        ...(expectedTurnId === undefined ? {} : { expectedTurnId }),
      },
    };
  }

  it("carries the requester's idempotency key on the wire as clientUserMessageId", async () => {
    const harness = await steerableHarness({ result: { turnId: TURN_ID } });

    await harness.driver.applyIntervention(steerIntervention(TURN_ID));

    // Sent verbatim on the pinned `TurnSteerParams` member, the same carrier `turn/start` uses. A
    // key re-minted at the driver boundary would defeat the provider's dedupe on retry.
    expect(harness.server.framesForMethod("turn/steer")[0]?.["params"]).toMatchObject({
      threadId: THREAD_ID,
      expectedTurnId: TURN_ID,
      clientUserMessageId: STEER_KEY,
    });
  });

  it("pins the steer to the live turn when the caller named none", async () => {
    const harness = await steerableHarness({ result: { turnId: TURN_ID } });

    const result = await harness.driver.applyIntervention(steerIntervention());

    // The provider requires the precondition, so an absent caller expectation becomes the live
    // turn on the wire, and the acknowledgement is graded against that.
    expect(harness.server.framesForMethod("turn/steer")[0]?.["params"]).toMatchObject({
      expectedTurnId: TURN_ID,
    });
    expect(result).toEqual({ status: "applied" });
  });

  it("degrades rather than throwing when the acknowledgement names no turn", async () => {
    const harness = await steerableHarness({ result: {} });

    // The request was answered, so this is an acknowledgement with no evidence, not an outage;
    // throwing would report a live provider as unreachable.
    await expect(harness.driver.applyIntervention(steerIntervention(TURN_ID))).resolves.toEqual({
      status: "degraded",
      fallbackAction: STEER_FALLBACK_ACTION,
    });
  });
});

describe("CodexLifecycleManager establishment slot", () => {
  it("refuses a create that overlaps an establishment still in flight, spawning once", async () => {
    const harness = createManagerHarness();
    const release = harness.server.holdSpawns();

    // Both calls are issued in one tick, so the second runs its guard while the first is
    // suspended in its spawn. A guard that read only the live map would see it empty and spawn a
    // second process whose handle the later install would orphan.
    const first = harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    const second = harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    // Released before the outcome is read, so a guard that failed to refuse fails cleanly instead
    // of timing out.
    release();
    const refusal = await second.then(
      () => undefined,
      (error: unknown) => error,
    );
    await first;

    expect(refusal).toBeInstanceOf(CodexSessionAlreadyLiveError);
    expect((refusal as CodexSessionAlreadyLiveError).holderState).toBe("establishing");
    // The refused create cost no process.
    expect(harness.server.spawnRequests).toHaveLength(1);
  });

  it("serializes a BURST of resumes issued in one tick, releasing every superseded process", async () => {
    const harness = createManagerHarness();
    harness.server.uniqueSpawnSessionIds = true;
    harness.server.on("thread/resume", () => threadStartResult(1));

    // Three, not two: resume supersedes rather than refuses, so each resume must observe its
    // predecessor's installed record and release that connection. A slot that waits for absence
    // and then claims serializes the second caller but loses the third: two waiters released by
    // the same settlement both find the slot free, establish concurrently, and the later install
    // orphans the earlier process.
    const results = await Promise.all([
      harness.manager.resumeSession({
        model: TEST_MODEL,
        sessionId: SESSION_ID,
        resumeHandle: THREAD_ID,
      }),
      harness.manager.resumeSession({
        model: TEST_MODEL,
        sessionId: SESSION_ID,
        resumeHandle: THREAD_ID,
      }),
      harness.manager.resumeSession({
        model: TEST_MODEL,
        sessionId: SESSION_ID,
        resumeHandle: THREAD_ID,
      }),
    ]);

    expect(results.map((result) => result.status)).toEqual(["resumed", "resumed", "resumed"]);
    expect(harness.server.spawnRequests).toHaveLength(3);
    // Every process but the survivor is released, in supersession order; the survivor is the last
    // one spawned.
    expect(harness.server.closedSessions).toEqual(["pty-session-1", "pty-session-2"]);
  });

  it("makes closeSession wait for an in-flight establishment instead of no-opping", async () => {
    const harness = createManagerHarness();
    const release = harness.server.holdSpawns();

    const creating = harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    // Issued while the create is suspended: a close that read the live map would find it empty
    // and leave the create's process running under a session the daemon believes closed.
    const closing = harness.manager.closeSession({ sessionId: SESSION_ID });
    release();
    await creating;
    await closing;

    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });
});

describe("CodexLifecycleManager session slot across teardown", () => {
  it("holds the slot for the whole of teardown and releases it once teardown settles", async () => {
    const harness = createManagerHarness();
    harness.server.uniqueSpawnSessionIds = true;
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });

    // Gated on the host close, the last step of teardown: the record is already out of the live
    // map by then under any implementation, so this window tests only the claim.
    const releaseCloses = harness.server.holdCloses();
    const closing = harness.manager.closeSession({ sessionId: SESSION_ID });
    await drainMicrotasks();
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);

    const refusal = await harness.manager
      .createSession({ model: TEST_MODEL, sessionId: SESSION_ID, config: SESSION_CONFIG })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // Read before the gate is released, so an implementation that frees the slot during teardown
    // fails cleanly rather than timing out.
    expect(refusal).toBeInstanceOf(CodexSessionAlreadyLiveError);
    expect((refusal as CodexSessionAlreadyLiveError).holderState).toBe("closing");
    // The refused create cost no process; a second child admitted here would outlive the one
    // still exiting.
    expect(harness.server.spawnRequests).toHaveLength(1);

    releaseCloses();
    await closing;

    // The slot is genuinely released: the create refused a moment ago is now admitted.
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    expect(harness.server.spawnRequests).toHaveLength(2);
  });

  it("releases the process even when the subscription disposer throws during teardown", async () => {
    const harness = createManagerHarness({ throwingSubscriptionDisposer: true });
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });

    const outcome = await harness.manager.closeSession({ sessionId: SESSION_ID }).then(
      () => undefined,
      (error: unknown) => error,
    );

    // The fault still reaches the caller but must not stop the host release, or the process
    // would outlive a session reported closed.
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain("subscription disposer failed");
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
    // A session whose teardown threw must still be creatable: the record is dropped in a
    // `finally`, so a misbehaving disposer cannot wedge the slot.
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
  });

  it("refuses a turn/start whose session stopped holding its slot while it was in flight", async () => {
    const harness = createManagerHarness();
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });

    let closing: Promise<void> | undefined;
    harness.server.on("turn/start", () => {
      // Issued from inside the write, so teardown claims the slot while `startRun` is still
      // suspended on this answer: the provider accepts the turn but the session is gone when the
      // answer lands.
      closing = harness.manager.closeSession({ sessionId: SESSION_ID });
      return { result: { turn: { id: TURN_ID } } };
    });

    const outcome = await harness.manager
      .startRun({
        runId: RUN_ID,
        agentConfig: { sessionId: SESSION_ID, input: "go" },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await closing;

    // Reporting success would be a lie about a run whose process is dead, and would strand a
    // `CodexRunRoutes` entry no sweep can reach, since every sweep keys on a record that no
    // longer exists.
    expect(outcome).toBeInstanceOf(CodexTransportError);
    expect((outcome as Error).message).toContain("stopped holding its slot");
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });
});

describe("CodexLifecycleManager session slot across re-establishment", () => {
  it("kills the connection when a turn is accepted after the session loses its slot", async () => {
    const harness = createManagerHarness();
    harness.server.uniqueSpawnSessionIds = true;
    // The resume fails, the one displacing transition that does not dispose the predecessor: its
    // catch path releases only its own new connection and leaves the old process live. So the
    // post-await branch must dispose rather than rely on whoever took the slot to kill it.
    harness.server.on("thread/resume", () => ({
      error: { code: -32000, message: "no such thread" },
    }));
    let resuming: Promise<unknown> | undefined;
    let releaseSpawns: (() => void) | undefined;
    harness.server.on("turn/start", () => {
      // Issued from inside the write, so the slot is lost while `startRun` is suspended on this
      // answer, after its entrance guard passed; that is the only way to reach the post-await
      // branch.
      releaseSpawns = harness.server.holdSpawns();
      resuming = harness.manager.resumeSession({
        model: TEST_MODEL,
        sessionId: SESSION_ID,
        resumeHandle: THREAD_ID,
      });
      return { result: { turn: { id: TURN_ID } } };
    });
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });

    const starting = harness.manager.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    // Parks the resume inside its spawn so the answer lands while the transition is in flight;
    // otherwise the resume could settle first and the slot would read as live again.
    await drainMicrotasks();
    releaseSpawns?.();
    const outcome = await starting.then(
      () => undefined,
      (error: unknown) => error,
    );
    const resumeResult = await resuming;

    expect(resumeResult).toMatchObject({ status: "failed" });
    expect(outcome).toBeInstanceOf(CodexTransportError);
    expect((outcome as Error).message).toContain("stopped holding its slot");
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
    // The turn was accepted and nothing else was going to stop it, so it would keep executing
    // tools on a session the daemon would reuse.
    expect(harness.server.killedSessions).toEqual([
      { sessionId: "pty-session-1", signal: "SIGKILL" },
    ]);
  });
});

describe("CodexLifecycleManager turn/start ambiguity", () => {
  it("kills the child and frees the slot when turn/start misses its deadline", async () => {
    const harness = createManagerHarness();
    harness.server.uniqueSpawnSessionIds = true;
    // No `turn/start` handler is registered, so the request is never answered and its deadline is
    // the only way it settles: the case the provider may have accepted.
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });

    const starting = harness.manager.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    const failure = starting.then(
      () => undefined,
      (error: unknown) => error,
    );
    harness.scheduler.fireAll();

    expect(await failure).toBeInstanceOf(CodexRequestTimeoutError);
    // Killed, not merely closed: an accepted turn keeps executing tools, and `close` takes no
    // signal.
    expect(harness.server.killedSessions).toEqual([
      { sessionId: "pty-session-1", signal: "SIGKILL" },
    ]);
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
    // The retry is a clean establishment; leaving the session reusable would double the work
    // against a turn nobody can see.
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    expect(harness.server.spawnRequests).toHaveLength(2);
  });

  it("treats a turn/start response with an unusable turn id as ambiguous", async () => {
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: {} } }));
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });

    const outcome = await harness.manager
      .startRun({
        runId: RUN_ID,
        agentConfig: { sessionId: SESSION_ID, input: "go" },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // The provider answered, so this is not a deadline, but an answer with no addressable turn
    // id leaves the same question open.
    expect(outcome).toBeInstanceOf(CodexTransportError);
    expect(harness.server.killedSessions).toEqual([
      { sessionId: "pty-session-1", signal: "SIGKILL" },
    ]);
  });
});

/** A `turn/start` refusal carrying the pin's typed `CodexErrorInfo` member. */
function typedTurnStartRefusal(codexErrorInfo: string): Record<string, unknown> {
  return {
    error: {
      code: -32600,
      // Prose the classifier must never read. It says "history" on purpose, so a text-matching
      // classifier would pass for the wrong reason.
      message: "Invalid request: the thread history is not acceptable",
      data: { codexErrorInfo },
    },
  };
}

/**
 * What one positional read observed. The frame count at read time proves the reconcile happened
 * before any further send on the thread.
 */
interface RecordedUserTurnReads {
  readonly targetIds: string[];
  readonly turnStartFramesAtRead: number[];
}

/** Answers a fixed user-turn count, recording what the wire held when asked. */
function countingUserTurnReadback(
  userOriginatedTurns: number,
  reads: RecordedUserTurnReads,
  readHarness: () => ManagerHarness,
): UserTurnReadbackReader {
  return (targetProviderSessionId: string) => {
    reads.targetIds.push(targetProviderSessionId);
    reads.turnStartFramesAtRead.push(readHarness().server.framesForMethod("turn/start").length);
    return Promise.resolve({ kind: "counted" as const, userOriginatedTurns });
  };
}

describe("CodexLifecycleManager permanent structural refusal", () => {
  it("calls a permanently-refusing provider exactly ONCE and condemns the binding", async () => {
    const harness = createManagerHarness();
    let turnStartCalls = 0;
    harness.server.on("turn/start", () => {
      turnStartCalls += 1;
      return typedTurnStartRefusal("badRequest");
    });
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });

    const outcome = await harness.manager
      .startRun({
        runId: RUN_ID,
        agentConfig: { sessionId: SESSION_ID, input: "go" },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // Asserts the call count: the defect prevented is expenditure, since a ladder over a history
    // the provider typed as unacceptable spends one request per rung and draws the same refusal.
    expect(turnStartCalls).toBe(1);
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(1);
    expect(outcome).toBeInstanceOf(PermanentStructuralRefusalError);
    expect((outcome as PermanentStructuralRefusalError).providerSessionId).toBe(THREAD_ID);
    expect((outcome as PermanentStructuralRefusalError).freshSessionRequired).toBe(true);
    // Condemned, not merely failed: the binding is gone, so a caller cannot re-dispatch onto the
    // poisoned thread.
    expect(harness.server.killedSessions).toEqual([
      { sessionId: "pty-session-1", signal: "SIGKILL" },
    ]);
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
    const redispatch = await harness.manager
      .startRun({
        runId: RUN_ID,
        agentConfig: { sessionId: SESSION_ID, input: "go" },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(redispatch).toBeInstanceOf(Error);
    expect(turnStartCalls).toBe(1);
  });

  it("does NOT condemn a typed refusal that names something other than the history", async () => {
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => typedTurnStartRefusal("contextWindowExceeded"));
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });

    const outcome = await harness.manager
      .startRun({
        runId: RUN_ID,
        agentConfig: { sessionId: SESSION_ID, input: "go" },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // A ceiling is not a poisoned history; condemning the binding would cost a re-establish for a
    // condition the next turn may not meet.
    expect(outcome).toBeInstanceOf(CodexProviderRequestError);
    expect(outcome).not.toBeInstanceOf(PermanentStructuralRefusalError);
    expect(harness.server.killedSessions).toEqual([]);
  });
});

describe("CodexLifecycleManager ambiguous turn/start reconciliation", () => {
  it("settles an ambiguous start DELIVERED and re-sends nothing", async () => {
    const reads: RecordedUserTurnReads = { targetIds: [], turnStartFramesAtRead: [] };
    // One more turn than the daemon acknowledged: the ambiguous start landed at the provider
    // though its answer never came back. The reader closes over the harness and is only called
    // after the constructor returned.
    const built: ManagerHarness = createManagerHarness({
      userTurnReadback: countingUserTurnReadback(1, reads, () => built),
    });
    built.server.uniqueSpawnSessionIds = true;
    // Unanswered on purpose: the deadline is the only way this settles, and the provider may have
    // accepted the turn.
    await built.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });

    const starting = built.manager.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    const failure = starting.then(
      () => undefined,
      (error: unknown) => error,
    );
    built.scheduler.fireAll();
    expect(await failure).toBeInstanceOf(CodexRequestTimeoutError);

    // Read against the thread once, before anything else could reach the wire: the count depends
    // on reconcile-before-send ordering.
    expect(reads.targetIds).toEqual([THREAD_ID]);
    expect(reads.turnStartFramesAtRead).toEqual([1]);
    // Zero duplicate turns: the landed turn is unaddressable, so the session is disposed and a
    // re-dispatch cannot put a second copy of it on the wire.
    expect(built.server.framesForMethod("turn/start")).toHaveLength(1);
    expect(built.server.killedSessions).toEqual([
      { sessionId: "pty-session-1", signal: "SIGKILL" },
    ]);
    const redispatch = await built.manager
      .startRun({
        runId: RUN_ID,
        agentConfig: { sessionId: SESSION_ID, input: "go" },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(redispatch).toBeInstanceOf(Error);
    expect(built.server.framesForMethod("turn/start")).toHaveLength(1);
  });

  it("fails visibly and sends NOTHING when the target cannot be read back", async () => {
    let reads = 0;
    const harness = createManagerHarness({
      userTurnReadback: () => {
        reads += 1;
        return Promise.resolve({ kind: "unreadable" as const, reason: "no turn read on this pin" });
      },
    });
    harness.server.uniqueSpawnSessionIds = true;
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });

    const starting = harness.manager.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    const failure = starting.then(
      () => undefined,
      (error: unknown) => error,
    );
    harness.scheduler.fireAll();

    // A failed settlement, never a silent success, and zero re-sends: a re-send risks duplicate
    // spend and an assumed delivery suppresses the user's request.
    expect(await failure).toBeInstanceOf(CodexRequestTimeoutError);
    expect(reads).toBe(1);
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(1);
    expect(harness.server.killedSessions).toEqual([
      { sessionId: "pty-session-1", signal: "SIGKILL" },
    ]);
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
  });

  it("CLEARS an ambiguous start for retry when the target proves nothing landed", async () => {
    const reads: RecordedUserTurnReads = { targetIds: [], turnStartFramesAtRead: [] };
    // The thread holds exactly what the daemon already knows about, so the
    // ambiguous start never landed and a re-dispatch duplicates nothing.
    const harness: ManagerHarness = createManagerHarness({
      userTurnReadback: countingUserTurnReadback(0, reads, () => harness),
    });
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });

    const starting = harness.manager.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    const failure = starting.then(
      () => undefined,
      (error: unknown) => error,
    );
    harness.scheduler.fireAll();
    expect(await failure).toBeInstanceOf(CodexRequestTimeoutError);

    expect(reads.turnStartFramesAtRead).toEqual([1]);
    // The transient arm: the session is left live, so the caller's re-dispatch costs no
    // re-establish and reaches the same process.
    expect(harness.server.killedSessions).toEqual([]);
    expect(harness.server.closedSessions).toEqual([]);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(true);
    expect(harness.server.spawnRequests).toHaveLength(1);
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(2);
  });
});

describe("CodexLifecycleManager turn route lifetime", () => {
  // `turn/completed` is the provider's only terminal-turn notification at the pin; a failure or
  // an interrupt arrives on it too and is told apart by `turn.status`.
  it.each(["completed", "interrupted", "failed"])(
    "retires the route when the turn terminates as %s",
    async (status) => {
      const harness = createManagerHarness();
      harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
      await harness.manager.createSession({
        model: TEST_MODEL,
        sessionId: SESSION_ID,
        config: SESSION_CONFIG,
      });
      await harness.manager.startRun({
        runId: RUN_ID,
        agentConfig: { sessionId: SESSION_ID, input: "go" },
      });
      expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(true);

      harness.server.emitFrame(turnCompletedFrame(TURN_ID, status));
      await Promise.resolve();

      // Without retirement only interrupt and close clear a route: a finished turn would read as
      // active forever, and a later intervention would target a turn id the provider retired.
      expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
    },
  );

  it("trips when the swallowed turn terminates in the SAME read chunk as its start response", async () => {
    // The `turn/start` response resolves `startRun` as a microtask, but `#ingest` drains the rest
    // of the chunk synchronously, so the terminal settles a turn no frame is correlated with yet
    // and the re-key onto the turn id runs after that settlement has gone by. A memory holding
    // only turn ids would retire the route and report the swallowed turn as completed.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({
      result: { turn: { id: TURN_ID } },
      trailingFrames: [zeroTurnCompletedFrame(TURN_ID)],
    }));
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });

    await harness.manager.startRun({
      runId: RUN_ID,
      agentConfig: {
        sessionId: SESSION_ID,
        input: "/status please",
        frameOrigin: "human_text",
      },
    });

    expect(harness.textNeutralizationFailures).toStrictEqual([
      {
        sessionId: SESSION_ID,
        runId: RUN_ID,
        providerFailureDetail: "driver.text_neutralization_failed origin=human_text",
      },
    ]);
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
    expect(harness.manager.textNeutralizationDecisionForTurn(TURN_ID).refused).toBe(true);
  });

  it("does not trip a REAL turn that terminates in the same read chunk with an unloaded item list", async () => {
    // This provider can settle a turn with an empty item list (`itemsView: "notLoaded"`), so a
    // memory that kept only the terminal would rule this real turn evidence-free. The in-flight
    // `item/completed` is the evidence, and it arrives in the same chunk before any frame is
    // correlated with the turn.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({
      result: { turn: { id: TURN_ID } },
      trailingFrames: [modelOutputItemFrame(TURN_ID), zeroTurnCompletedFrame(TURN_ID)],
    }));
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });

    await harness.manager.startRun({
      runId: RUN_ID,
      agentConfig: {
        sessionId: SESSION_ID,
        input: "review the diff",
        frameOrigin: "human_text",
      },
    });

    expect(harness.textNeutralizationFailures).toStrictEqual([]);
    expect(harness.manager.textNeutralizationDecisionForTurn(TURN_ID).refused).toBe(false);
    // Still retired: the turn ended, whatever it produced.
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
  });

  it("refuses a later run on the SESSION a trip disposed, not only the run that was on it", async () => {
    // A run-keyed quarantine cannot reach this: `startRun` resolves a session, so the surviving
    // record would hand the next run back to the process that swallowed the user's words. The
    // refusal names the neutralization rather than a transport fault, so one cause reads as one
    // cause.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    await harness.manager.startRun({
      runId: RUN_ID,
      agentConfig: {
        sessionId: SESSION_ID,
        input: "/status please",
        frameOrigin: "human_text",
      },
    });
    harness.server.emitFrame(zeroTurnCompletedFrame(TURN_ID));
    await Promise.resolve();

    const writtenLinesAfterTrip = harness.server.writtenLines.length;
    await expect(
      harness.manager.startRun({
        runId: SECOND_RUN_ID,
        agentConfig: { sessionId: SESSION_ID, input: "carry on" },
      }),
    ).rejects.toThrow(TextNeutralizationRefusedError);
    // Refused before the provider was asked anything: a `turn/start` sent now would reach the
    // condemned process.
    expect(harness.server.writtenLines).toHaveLength(writtenLinesAfterTrip);
  });

  it("lets a fresh spawn under the same session id run again after a trip", async () => {
    // The quarantine names a binding, not an identifier: a refusal that outlived the process it
    // condemned would refuse the recovery, which is a fresh process.
    const harness = createManagerHarness();
    harness.server.uniqueSpawnSessionIds = true;
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    await harness.manager.startRun({
      runId: RUN_ID,
      agentConfig: {
        sessionId: SESSION_ID,
        input: "/status please",
        frameOrigin: "human_text",
      },
    });
    harness.server.emitFrame(zeroTurnCompletedFrame(TURN_ID));
    // The trip's teardown is detached (it runs inside the read-chunk drain and must not be
    // awaited there), so the slot reads `closing` until it settles and a create in that window is
    // refused. Recovery starts once the condemned child is gone.
    await drainMicrotasks();

    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });

    await expect(
      harness.manager.startRun({
        runId: SECOND_RUN_ID,
        agentConfig: { sessionId: SESSION_ID, input: "carry on" },
      }),
    ).resolves.toBeUndefined();
  });

  it("passes a steer on its acknowledgment when no item follows it", async () => {
    // The provider's typed answer to `turn/steer` is the transport's statement that it took the
    // steer, so a steer taken near the turn's end, with no item after it, passes rather than
    // tripping a healthy session. An answer proves receipt, not that the model read the text, so
    // the detectable swallows are an unanswered steer and an unrecognized settlement, which
    // outranks any answer.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("turn/steer", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    await harness.manager.startRun({
      runId: RUN_ID,
      agentConfig: {
        sessionId: SESSION_ID,
        input: "review the diff",
        frameOrigin: "human_text",
      },
    });
    // The opening frame's own evidence, observed before the steer is written.
    harness.server.emitFrame(modelOutputItemFrame(TURN_ID));
    await Promise.resolve();

    await harness.manager.steerRun({
      runId: RUN_ID,
      content: "/clear and start over",
      clientIdempotencyKey: "steer-1",
      frameOrigin: "system_narration",
    });
    // Every item the terminal carries precedes the steer. The acknowledgment alone rules the
    // steer; the items rule the opener.
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await drainMicrotasks();

    expect(harness.textNeutralizationFailures).toStrictEqual([]);
    expect(harness.manager.textNeutralizationDecisionForTurn(TURN_ID).refused).toBe(false);
  });

  it("keeps the frame of a steer that timed out after its bytes were written", async () => {
    // The write succeeded and the provider never answered: it may have taken the command-shaped
    // message, intercepted it client-side, and be heading for a zero-turn success, so the
    // caller's rejection carries no information. Withdrawing the frame is how a swallowed
    // message escapes, because the terminal would then rule only the opening frame. Retained,
    // the terminal rules the steer on its own merits.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    // `turn/steer` is deliberately not registered: the fake writes the line and answers nothing,
    // the shape of an intercepted message.
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    await harness.manager.startRun({
      runId: RUN_ID,
      agentConfig: {
        sessionId: SESSION_ID,
        input: "review the diff",
        frameOrigin: "human_text",
      },
    });
    // The opening frame's own evidence, observed before the steer is written, so the opening
    // frame passes on its own account and only the steer is at issue.
    harness.server.emitFrame(modelOutputItemFrame(TURN_ID));
    await Promise.resolve();

    const steer = harness.manager.steerRun({
      runId: RUN_ID,
      content: "/clear and start over",
      clientIdempotencyKey: "steer-1",
      // A different origin from the opening frame's, so the recorded detail names which frame
      // the turn failed to account for.
      frameOrigin: "system_narration",
    });
    await drainMicrotasks();
    // The line is on the wire before the deadline fires: a post-write failure, not a
    // refusal.
    expect(harness.server.framesForMethod("turn/steer")).toHaveLength(1);
    harness.scheduler.fireAll();
    await expect(steer).rejects.toBeInstanceOf(CodexRequestTimeoutError);

    // Every item this terminal carries precedes the steer, so none of them is evidence for it.
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await drainMicrotasks();

    expect(harness.textNeutralizationFailures).toHaveLength(1);
    expect(harness.textNeutralizationFailures[0]?.providerFailureDetail).toBe(
      "driver.text_neutralization_failed origin=system_narration",
    );
    // And the binding the swallow was observed on is condemned, not reused.
    await expect(
      harness.manager.startRun({
        runId: SECOND_RUN_ID,
        agentConfig: { sessionId: SESSION_ID, input: "carry on" },
      }),
    ).rejects.toThrow(TextNeutralizationRefusedError);
  });

  it("reports a trip on the run whose route an interrupt had already retired", async () => {
    // `turn/interrupt` resolves when the provider accepts the interrupt, not when the turn ends;
    // `turn/completed` still follows. The route is retired at acceptance so the run stops
    // reporting an active turn, but the tripwire is ruled on the terminal. Without a correlation
    // that survives that gap, the trip quarantines the session and process while the run's own
    // subscribers hear nothing.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("turn/interrupt", () => ({ result: {} }));
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    await harness.manager.startRun({
      runId: RUN_ID,
      agentConfig: {
        sessionId: SESSION_ID,
        input: "/status please",
        frameOrigin: "human_text",
      },
    });
    await harness.manager.interruptRun({ runId: RUN_ID });
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);

    harness.server.emitFrame(zeroTurnCompletedFrame(TURN_ID));
    await drainMicrotasks();

    expect(harness.textNeutralizationFailures).toStrictEqual([
      {
        sessionId: SESSION_ID,
        runId: RUN_ID,
        providerFailureDetail: "driver.text_neutralization_failed origin=human_text",
      },
    ]);
    // The session arm too: the run failure alone would leave the next run free to resolve this
    // record by session id and dispatch into the process that swallowed the user's words.
    await expect(
      harness.manager.startRun({
        runId: SECOND_RUN_ID,
        agentConfig: { sessionId: SESSION_ID, input: "carry on" },
      }),
    ).rejects.toThrow(TextNeutralizationRefusedError);
  });

  it("keeps the route while the turn is still inProgress", async () => {
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    await harness.manager.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });

    // `inProgress` is a member of the generated `TurnStatus` enum; retiring on it would refuse a
    // mid-flight steer or interrupt as "no active turn".
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "inProgress"));
    await Promise.resolve();

    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(true);
  });

  it("retires a turn that terminates in the SAME read chunk as its start response", async () => {
    const harness = createManagerHarness();
    // One chunk carrying both frames. The response resolves `startRun` as a microtask while
    // `#ingest` drains the rest of the chunk synchronously, so the terminal is processed before
    // the route is installed.
    harness.server.on("turn/start", () => ({
      result: { turn: { id: TURN_ID } },
      trailingFrames: [turnCompletedFrame(TURN_ID, "completed")],
    }));
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });

    await harness.manager.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });

    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
  });

  it("does not let a stale terminal retire a NEWER turn for the same run", async () => {
    const harness = createManagerHarness();
    let nextTurnId = TURN_ID;
    harness.server.on("turn/start", () => ({ result: { turn: { id: nextTurnId } } }));
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    await harness.manager.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "one" },
    });
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await Promise.resolve();

    nextTurnId = "turn-02";
    await harness.manager.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "two" },
    });

    // The sweep is keyed by turn id, so a late duplicate for the retired turn cannot reach the
    // turn running now.
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await Promise.resolve();
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(true);
  });

  it("refuses a run whose config declares a frame origin, before any byte is written", async () => {
    // The origin of a run's opening frame is minted at the boundary, so the untyped
    // `agentConfig` bag cannot name one, least of all the exempt origin, which would deliver
    // the user's command-shaped words verbatim to the provider's command layer and excuse a
    // swallowed turn from the tripwire. A bag has no type to enforce this, so the refusal does.
    const harness = createManagerHarness();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });

    await expect(
      harness.manager.startRun({
        runId: RUN_ID,
        agentConfig: {
          sessionId: SESSION_ID,
          input: "/compact",
          frameOrigin: "driver_command",
        },
      }),
    ).rejects.toThrow(CodexDriverConfigError);

    // Refused before the write: the text never reached the provider and no route or turn was
    // left behind.
    expect(harness.server.writtenLines.filter((line) => line.includes("turn/start"))).toStrictEqual(
      [],
    );
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Provider refusal detail
// --------------------------------------------------------------------------

describe("CodexProviderRequestError", () => {
  it("carries the JSON-RPC error data member verbatim", async () => {
    const harness = createHarness();
    await createdSession(harness);
    // The shape the pinned provider answers a refused steer with. The transport carries it
    // whole and unparsed because dropping it would be irreversible.
    const codexErrorInfo = {
      codexErrorInfo: { kind: "turn_not_interruptible", detail: ["no active turn"] },
    };
    harness.server.on("turn/interrupt", () => ({
      error: { code: -32602, message: "cannot interrupt", data: codexErrorInfo },
    }));
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.driver.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });

    await expect(harness.driver.interruptRun({ runId: RUN_ID })).rejects.toMatchObject({
      providerErrorCode: -32602,
      providerErrorData: codexErrorInfo,
    });
  });
});

describe("Codex driver config read-shapes", () => {
  it.each([
    ["a missing cwd", { env: [] }],
    ["an empty cwd", { cwd: "", env: [] }],
    ["a missing env", { cwd: "/work" }],
    ["a non-string env value", { cwd: "/work", env: [["NAME", 7]] }],
  ])("refuses %s", (_label, config) => {
    expect(() => parseCodexSessionConfig(config)).toThrow(/CreateSessionParams\.config/);
  });

  it("normalizes provider failure detail into something the schema accepts", () => {
    expect(normalizeProviderFailureDetail(new Error("boom"))).toBe("boom");
    expect(normalizeProviderFailureDetail("   ")).toMatch(/no diagnostic message/);
    expect(normalizeProviderFailureDetail(undefined)).toMatch(/no diagnostic message/);
    expect(normalizeProviderFailureDetail("with\0nul")).toBe("withnul");
    expect(
      normalizeProviderFailureDetail("x".repeat(DRIVER_FAILURE_DETAIL_MAX_LEN + 10)),
    ).toHaveLength(DRIVER_FAILURE_DETAIL_MAX_LEN);
  });

  it("never serializes an arbitrary rejection value into the persisted detail", () => {
    // `providerFailureDetail` reaches a durable row the person sees, and `String()` runs
    // whatever `toString` the value carries, which is how spawn configuration, credentials
    // included, could get there. The constant is the designed output.
    const hostile = {
      toString(): string {
        return "ANTHROPIC_API_KEY=sk-secret-value";
      },
    };

    const detail = normalizeProviderFailureDetail(hostile);

    expect(detail).not.toContain("sk-secret-value");
    expect(detail).toMatch(/no diagnostic message/);
  });
});

// --------------------------------------------------------------------------
// Session-control driver methods.
// --------------------------------------------------------------------------
//
// `forkConversation`, `setSessionGoal` and `clearSessionGoal` reach the native `thread/fork` and
// `thread/goal/*` methods. The two subagent caps the provider enforces are supplied at every
// thread establishment, and a resumed or forked thread re-realizes every spawn-bound setting.

/** The params of the first frame the provider received for a method. */
function firstParamsFor(harness: Harness, method: string): Record<string, unknown> {
  return (harness.server.framesForMethod(method)[0]?.["params"] ?? {}) as Record<string, unknown>;
}

function readConfigOverrides(params: unknown): Record<string, unknown> {
  const config = (params as Record<string, unknown>)["config"];
  return (config ?? {}) as Record<string, unknown>;
}

const WORKSPACE_POSTURE_WITH_NETWORK: ExecutionPosture = {
  mode: "workspace-sandboxed",
  credentialPolicyRef: "policy://default",
  networkAccess: "full",
  writableRoots: ["/work/session"],
};

/**
 * A live session whose turn ledger is already populated.
 *
 * Seeded through `resumeSession` rather than by running turns: a resumed thread carries its
 * own history, the axis a rewind indexes, without tying the rollback assertions to turn
 * dispatch.
 */
async function resumedSessionWithTurns(
  harness: Harness,
  turnCount: number,
  params: Partial<Parameters<CodexDriver["resumeSession"]>[0]> = {},
): Promise<void> {
  harness.server.on("thread/resume", () => threadStartResult(turnCount));
  await harness.driver.resumeSession({
    model: TEST_MODEL,
    sessionId: SESSION_ID,
    resumeHandle: THREAD_ID,
    ...params,
  });
}

describe("CodexDriver forkConversation (native `thread/fork`)", () => {
  it("reports the rebinding `bindingId` on the applied arm", async () => {
    const harness = createHarness();
    await resumedSessionWithTurns(harness, 2);
    harness.server.on("thread/fork", () => ({
      result: {
        thread: { id: "thread-forked", sessionId: "session-tree-1", turns: [{ id: "turn-0" }] },
      },
    }));

    // The input binding is deliberately not the minted one: with the same string for both, a
    // driver that echoed the caller's `bindingId` back would pass this assertion.
    const result = await harness.driver.forkConversation({
      sessionId: SESSION_ID,
      bindingId: "binding-predecessor",
      position: 1,
    });

    // The daemon rebinds the run onto the new provider thread, so an applied rollback must
    // report the minted binding, not the predecessor's.
    expect(result).toStrictEqual({
      status: "applied",
      sessionPosition: 1,
      bindingId: "binding-abc",
    });
  });

  it("re-realizes posture and subagent caps on the fork", async () => {
    const harness = createHarness();
    await resumedSessionWithTurns(harness, 2, {
      executionPosture: WORKSPACE_POSTURE_WITH_NETWORK,
      subagentPolicy: { enabled: true, maxConcurrent: 3, maxDepth: 1, definitions: [] },
    });
    harness.server.on("thread/fork", () => ({
      result: {
        thread: { id: "thread-forked", sessionId: "session-tree-1", turns: [{ id: "turn-0" }] },
        sandbox: { networkAccess: true },
      },
    }));

    await harness.driver.forkConversation({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
      position: 1,
    });

    const forkParams = firstParamsFor(harness, "thread/fork");
    expect(forkParams["sandbox"]).toBe("workspace-write");
    // A fork mints a new thread; omitting the overrides would leave the rewound session
    // governed by whatever that thread inherited.
    expect(readConfigOverrides(forkParams)).toStrictEqual({
      "sandbox_workspace_write.network_access": true,
      "agents.max_concurrent_threads_per_session": 3,
      "agents.max_depth": 1,
    });
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
    // The refusal is local: a fork that omitted the boundary would rewind the whole thread,
    // the one outcome a rollback must never report.
    expect(harness.server.framesForMethod("thread/fork")).toHaveLength(0);
  });

  // The `rollback` flag's static detection leaves a parameter-level gap: the method list
  // shows `thread/fork` is accepted but says nothing about `ThreadForkParams.lastTurnId`,
  // which is verified at the `0.150.1` pin and not at the `0.141.0` admission floor. A build
  // in that gap passes the capability gate and refuses at the parameter, so the refusal is
  // classified at invocation. The success path is covered by the applied-arm test above.
  const BOUNDARY_FIELD_REFUSALS: readonly string[] = [
    // Measured verbatim on `thread/fork` at the pin: the deserializer's answer when a
    // required field is absent.
    "Invalid request: missing field `lastTurnId`",
    // The deserializer's answer when the field is present but not declared on the params
    // type, which is what a renamed boundary member produces.
    "Invalid request: unknown field `lastTurnId`",
  ];

  it("classifies a fork refusing the boundary field as the registered capability refusal", async () => {
    for (const providerMessage of BOUNDARY_FIELD_REFUSALS) {
      const harness = createHarness();
      await resumedSessionWithTurns(harness, 2);
      harness.server.on("thread/fork", () => ({
        error: { code: -32600, message: providerMessage },
      }));

      const refused = await harness.driver
        .forkConversation({ sessionId: SESSION_ID, bindingId: "binding-abc", position: 1 })
        .then(
          () => undefined,
          (cause: unknown) => cause,
        );

      expect(refused).toBeInstanceOf(CodexRewindBoundaryUnsupportedError);
      // The registered code, carried by class identity: an unregistered dotted literal would
      // be a new error-contract row.
      expect((refused as CodexRewindBoundaryUnsupportedError).code).toBe(
        "driver.capability_unsupported",
      );
      expect((refused as CodexRewindBoundaryUnsupportedError).fields).toStrictEqual({
        driverId: "codex",
        flag: "rollback",
        providerError: providerMessage,
      });

      // The transition slot is not leaked: a throw out of the claimed establishment body must
      // still release it, or the session could never be rewound, resumed or closed again. A
      // second rollback that reaches the wire proves it.
      harness.server.on("thread/fork", () => ({
        result: {
          thread: { id: "thread-forked", sessionId: "session-tree-1", turns: [{ id: "turn-0" }] },
        },
      }));
      const retried = await harness.driver.forkConversation({
        sessionId: SESSION_ID,
        bindingId: "binding-abc",
        position: 1,
      });
      expect(retried).toStrictEqual({
        status: "applied",
        sessionPosition: 1,
        bindingId: "binding-abc",
      });
    }
  });
});

describe("CodexDriver resumeSession re-realization", () => {
  it("re-sends posture and subagent caps on `thread/resume`", async () => {
    // A resume is a fresh spawn; omitting the overrides would leave the thread under the
    // provider's persisted config rather than the one its caller declared.
    const harness = createHarness();
    await resumedSessionWithTurns(harness, 1, {
      executionPosture: WORKSPACE_POSTURE_WITH_NETWORK,
      subagentPolicy: { enabled: true, maxConcurrent: 2, maxDepth: 1, definitions: [] },
    });

    const resumeParams = firstParamsFor(harness, "thread/resume");
    expect(resumeParams["sandbox"]).toBe("workspace-write");
    expect(readConfigOverrides(resumeParams)).toStrictEqual({
      "sandbox_workspace_write.network_access": true,
      "agents.max_concurrent_threads_per_session": 2,
      "agents.max_depth": 1,
    });
  });
});

describe("CodexDriver session goals (native)", () => {
  it("sends only the daemon-owned objective on `thread/goal/set`", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("thread/goal/set", () => ({ result: {} }));

    await expect(
      harness.driver.setSessionGoal({
        sessionId: SESSION_ID,
        bindingId: "binding-abc",
        runId: RUN_ID,
        goalText: "land the parity legs",
      }),
    ).resolves.toStrictEqual({ status: "applied" });
    // `status` and `tokenBudget` are provider-side goal state the daemon does not own;
    // sending either would make the driver a second author of them.
    expect(firstParamsFor(harness, "thread/goal/set")).toStrictEqual({
      threadId: THREAD_ID,
      objective: "land the parity legs",
    });
  });

  it("sends `thread/goal/clear` and resolves on a thread that carried no goal", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("thread/goal/clear", () => ({ result: { cleared: false } }));

    await expect(
      harness.driver.clearSessionGoal({
        sessionId: SESSION_ID,
        bindingId: "binding-abc",
        runId: RUN_ID,
      }),
    ).resolves.toStrictEqual({ status: "applied" });
    expect(firstParamsFor(harness, "thread/goal/clear")).toStrictEqual({ threadId: THREAD_ID });
  });
});

describe("CodexDriver subagent caps", () => {
  it("disables subagents on the DEPTH axis, never with a zero concurrency cap", async () => {
    // Verified against the pinned build: `agents.max_concurrent_threads_per_session: 0` is
    // refused with `-32600`, so a zero cap would fail every session that tried to disable
    // subagents.
    const harness = createHarness();
    harness.server.on("thread/start", () => threadStartResult());

    await harness.driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
      subagentPolicy: { enabled: false },
    });

    expect(readConfigOverrides(firstParamsFor(harness, "thread/start"))).toStrictEqual({
      "agents.max_concurrent_threads_per_session": 1,
      "agents.max_depth": 0,
    });
  });

  it("routes an enabled policy below the provider floor to the same disabled encoding", async () => {
    // Fail-closed rather than clamped up: clamping would grant a subagent slot to a caller
    // who asked for none.
    const harness = createHarness();
    harness.server.on("thread/start", () => threadStartResult());

    await harness.driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
      subagentPolicy: { enabled: true, maxConcurrent: 0, maxDepth: 3, definitions: [] },
    });

    expect(readConfigOverrides(firstParamsFor(harness, "thread/start"))).toStrictEqual({
      "agents.max_concurrent_threads_per_session": 1,
      "agents.max_depth": 0,
    });
  });
});

describe("CodexDriver posture realization", () => {
  it("records a divergence when the provider's readback narrows the requested axis", async () => {
    // The provider's config table fails open (an unrecognized key is accepted and ignored),
    // so a setting that silently stopped applying looks like one that applied a denial. The
    // readback is the only check.
    const harness = createHarness();
    harness.server.on("thread/start", () => ({
      result: {
        thread: { id: THREAD_ID, sessionId: "session-tree-1", turns: [] },
        sandbox: { networkAccess: false },
      },
    }));

    await harness.driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
      executionPosture: WORKSPACE_POSTURE_WITH_NETWORK,
    });

    const diverged = harness.diagnostics.filter(
      (diagnostic) => diagnostic.kind === "posture-realization-diverged",
    );
    expect(diverged).toHaveLength(1);
    expect(diverged[0]).toMatchObject({
      requestedNetworkAccess: true,
      realizedNetworkAccess: false,
    });
  });

  it("reports a realization WIDER than the request as well as a narrower one", () => {
    expect(
      describeCodexPostureDivergence(
        {
          mode: "workspace-sandboxed",
          credentialPolicyRef: "policy://default",
          networkAccess: "none",
          writableRoots: [],
        },
        { networkAccess: true },
      ),
    ).toStrictEqual({ requestedNetworkAccess: false, realizedNetworkAccess: true });
  });
});

describe("CodexDriver realtime suppression", () => {
  it("opts out of every realtime method the pin publishes, in the `initialize` frame it sends", async () => {
    // Read off the frame the provider received, not the exported constant: asserting the
    // constant against itself would pass with the negotiation deleted.
    const harness = createHarness();
    await createdSession(harness);

    const capabilities = firstParamsFor(harness, "initialize")["capabilities"];
    const optOut = (capabilities as Record<string, unknown>)["optOutNotificationMethods"];
    expect(optOut).toStrictEqual([
      "thread/realtime/started",
      "thread/realtime/closed",
      "thread/realtime/error",
      "thread/realtime/itemAdded",
      "thread/realtime/sdp",
      "thread/realtime/outputAudio/delta",
      "thread/realtime/transcript/delta",
      "thread/realtime/transcript/done",
      // The `0.150.1` pin publishes these beside the `itemAdded`, `transcript/delta` and
      // `transcript/done` spellings, so both sets are suppressed.
      "thread/realtime/item/started",
      "thread/realtime/item/transcript/delta",
      "thread/realtime/item/completed",
    ]);
  });
});

describe("CodexDriver transport construction", () => {
  const websocketTransportConfig = {
    transport: "websocket" as const,
    endpoint: "wss://codex.internal/app-server",
    bearerTokenRef: "keyring://codex/app-server",
  };

  function buildDriverOptions(): ConstructorParameters<typeof CodexDriver>[0] {
    return {
      ptyHost: new FakeCodexAppServer(),
      modelCatalogExchange: STUB_MODEL_CATALOG_READ,
      diagnostics: makeSilentDriverDiagnostics(),
      subscribeToPtySession: () => () => undefined,
      reportDiagnostic: () => undefined,
      onTextNeutralizationFailure: () => undefined,
      scheduleTimeout: makeManualScheduler().schedule,
      executablePath: EXECUTABLE_PATH,
      resumeSpawnConfig: RESUME_SPAWN_CONFIG,
      resolveCredentialEnvPolicy: resolveNoDeniedCredentialNames,
      newBindingId: () => "binding-abc",
      readCapabilities: () => makeCapabilities(true),
    };
  }

  it("resolves the bearer ref at connection time, once per connection, never at construction", async () => {
    // The ref is a locator, exchanged for a credential when a connection is opened. A
    // resolver called at construction, or once and cached, would pin one credential for the
    // driver's lifetime, so a rotation would go unnoticed and later connections would
    // present a retired secret.
    const resolvedRefs: string[] = [];
    const server = new FakeCodexAppServer();
    server.on("initialize", () => ({ result: { userAgent: "codex-driver/0.149.1" } }));
    server.on("getAuthStatus", () => ({ result: { authMethod: "chatgpt", authToken: null } }));
    server.on("thread/start", () => threadStartResult());
    const connectedEndpoints: string[] = [];
    const driver = new CodexDriver({
      ...buildDriverOptions(),
      ptyHost: server,
      subscribeToPtySession: (ptySessionId, listeners) => server.subscribe(ptySessionId, listeners),
      transportConfig: websocketTransportConfig,
      resolveBearerCredential: async (bearerTokenRef): Promise<CodexWebsocketBearerCredential> => {
        resolvedRefs.push(bearerTokenRef);
        return await Promise.resolve({
          mode: "capability-token",
          tokenFilePath: "/run/codex/ws.token",
        });
      },
      websocketConnector: {
        connect: async (request): Promise<void> => {
          connectedEndpoints.push(request.endpoint);
          await Promise.resolve();
        },
      },
    });

    // Constructed, not yet connected: nothing has asked the keyring anything.
    expect(resolvedRefs).toStrictEqual([]);

    await driver.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    expect(resolvedRefs).toStrictEqual([websocketTransportConfig.bearerTokenRef]);

    // A second connection re-resolves rather than reusing the first answer.
    await driver.createSession({
      model: TEST_MODEL,
      sessionId: "22222222-2222-4222-8222-222222222222" as SessionId,
      config: SESSION_CONFIG,
    });
    expect(resolvedRefs).toStrictEqual([
      websocketTransportConfig.bearerTokenRef,
      websocketTransportConfig.bearerTokenRef,
    ]);
    expect(connectedEndpoints).toStrictEqual([
      websocketTransportConfig.endpoint,
      websocketTransportConfig.endpoint,
    ]);
  });
});

describe("composeCodexTransportArgv (the authenticated listener)", () => {
  it("starts a websocket listener WITH bearer auth on every credential mode", () => {
    const selection: CodexTransportSelection = {
      transport: "websocket",
      endpoint: "ws://127.0.0.1:8451",
      // A reference to the credential, resolved at connection time; no secret value is held here.
      bearerTokenRef: "keyring://codex/ws",
    };

    expect(
      composeCodexTransportArgv(selection, {
        mode: "capability-token",
        tokenFilePath: "/run/codex/ws.token",
      }),
    ).toStrictEqual([
      "app-server",
      "--listen",
      "ws://127.0.0.1:8451",
      "--ws-auth",
      "capability-token",
      "--ws-token-file",
      "/run/codex/ws.token",
    ]);
    expect(
      composeCodexTransportArgv(selection, {
        mode: "capability-token-digest",
        tokenSha256: "a".repeat(64),
      }),
    ).toStrictEqual([
      "app-server",
      "--listen",
      "ws://127.0.0.1:8451",
      "--ws-auth",
      "capability-token",
      "--ws-token-sha256",
      "a".repeat(64),
    ]);
  });

  it("refuses to compose an UNAUTHENTICATED websocket listener", () => {
    // A listener started without auth is reachable by anything that can open a socket to it.
    expect(() =>
      composeCodexTransportArgv(
        {
          transport: "websocket",
          endpoint: "ws://127.0.0.1:8451",
          bearerTokenRef: "keyring://codex/ws",
        },
        null,
      ),
    ).toThrow(CodexDriverConfigError);
  });
});

// ---------------------------------------------------------------------------
// The routing / metering band, driven through the real ingest path: raw JSON-RPC notifications go
// into the fake provider's byte channel and the assertions read what comes out of the manager,
// proving the driver consults the router and the accountant (which are never called directly).
// ---------------------------------------------------------------------------

describe("CodexLifecycleManager thread routing and usage metering", () => {
  const CHILD_THREAD_ID = "01a04202-0148-7ae2-8560-child0000001";

  async function managerWithSession(
    options: ManagerHarnessOptions = { onServerNotification: true },
  ): Promise<ManagerHarness> {
    const harness = createManagerHarness(options);
    // A fresh accountant starts its base registers at zero, so the fixture's running totals restart
    // with it; otherwise `last` would derive from a previous test's cumulative.
    emittedCumulativeByThreadId.clear();
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    return harness;
  }

  // Per-thread running totals, so `last` is the per-turn figure a real provider would send and the
  // accountant's cross-check stays quiet.
  const emittedCumulativeByThreadId = new Map<string, number>();

  /**
   * Emit one token-usage notification with every member of the pinned `TokenUsageBreakdown`
   * populated on both `total` and `last`, so a wrong axis map cannot pass unnoticed.
   */
  function emitUsage(
    harness: ManagerHarness,
    threadId: string,
    totalInputTokens: number,
    turnId = TURN_ID,
  ): void {
    const priorCumulative = emittedCumulativeByThreadId.get(threadId) ?? 0;
    emittedCumulativeByThreadId.set(threadId, totalInputTokens);
    const perTurn = totalInputTokens - priorCumulative;
    const breakdown = (value: number): Record<string, number> => ({
      totalTokens: value,
      inputTokens: value,
      cachedInputTokens: value,
      cacheWriteInputTokens: value,
      outputTokens: value,
      reasoningOutputTokens: value,
    });
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        turnId,
        // The container member is `tokenUsage`, as in the pinned
        // `ThreadTokenUsageUpdatedNotification`.
        tokenUsage: { total: breakdown(totalInputTokens), last: breakdown(perTurn) },
      },
    });
  }

  function announceChild(harness: ManagerHarness, threadSourceKind: string): void {
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "thread/started",
      params: {
        thread: {
          id: CHILD_THREAD_ID,
          parentThreadId: THREAD_ID,
          threadSourceKind,
        },
      },
    });
  }

  it("a frame naming a FOREIGN thread never reaches the normalize band", async () => {
    const harness = await managerWithSession();

    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "thread/queue/changed",
      params: { threadId: "some-other-session-thread" },
    });
    await Promise.resolve();

    // Held, not projected: an unannounced thread may be a child racing its announcement.
    expect(harness.notifications).toStrictEqual([]);
    expect(harness.manager.frameRouterFor(SESSION_ID).pendingHeldFrameCount()).toBe(1);
  });

  it("a usage frame meters a per-turn DELTA, and the cumulative counter never reaches the band as one", async () => {
    const harness = await managerWithSession();

    emitUsage(harness, THREAD_ID, 100);
    emitUsage(harness, THREAD_ID, 150);
    await Promise.resolve();

    // The wire reports a running total (100, then 150); the daemon must meter 100, then 50.
    expect(harness.meteredUsage.map((entry) => entry.delta.axisDeltas.input)).toEqual([100, 50]);
    expect(harness.meteredUsage.map((entry) => entry.sessionId)).toEqual([SESSION_ID, SESSION_ID]);
    expect(harness.meteredUsage[0]?.delta.attributedTurnId).toBe(TURN_ID);

    // Every axis of the breakdown meters, asserted by name: an axis the reader spells outside the
    // accountant's closed axis union is refused and recorded, and would be missing from the delta.
    expect(Object.keys(harness.meteredUsage[1]?.delta.axisDeltas ?? {}).sort()).toEqual([
      "cacheWriteInput",
      "cachedInput",
      "input",
      "output",
      "reasoningOutput",
      "total",
    ]);
    // The wire's per-turn figure agrees with the derived interval on every axis, so the cross-check
    // stays silent.
    expect(harness.driverDiagnostics.recentRecordsOfKind("usage_cross_check_mismatch")).toEqual([]);
    expect(harness.driverDiagnostics.recentRecordsOfKind("usage_axis_reading_rejected")).toEqual(
      [],
    );
  });

  it("a child announcement then a child frame routes to the carve-outs, never to the parent's transcript", async () => {
    const harness = await managerWithSession();

    announceChild(harness, "subAgent");
    await Promise.resolve();
    // The announcement names the child's identity, so it routes as the child's first frame and is
    // suppressed; the lifecycle event survives.
    expect(harness.subagentLifecycle.map((entry) => entry.emission.eventType)).toEqual([
      "subagent.started",
    ]);

    // The child's content is suppressed...
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "thread/queue/changed",
      params: { threadId: CHILD_THREAD_ID },
    });
    // ...while its spend still meters, under the child's own attribution.
    emitUsage(harness, CHILD_THREAD_ID, 40);
    await Promise.resolve();

    expect(harness.notifications).toStrictEqual([]);
    expect(harness.meteredUsage).toHaveLength(1);
    expect(harness.meteredUsage[0]?.delta.threadId).toBe(CHILD_THREAD_ID);
    expect(harness.meteredUsage[0]?.delta.axisDeltas.input).toBe(40);
  });

  it("a DUPLICATE thread/started retains the child's usage base rather than re-basing it", async () => {
    const harness = await managerWithSession();

    announceChild(harness, "subAgent");
    emitUsage(harness, CHILD_THREAD_ID, 100);
    await Promise.resolve();
    // A re-announced child must keep its base; re-basing would meter 150 instead of 50.
    announceChild(harness, "subAgent");
    emitUsage(harness, CHILD_THREAD_ID, 150);
    await Promise.resolve();

    expect(harness.meteredUsage.map((entry) => entry.delta.axisDeltas.input)).toEqual([100, 50]);
    expect(harness.subagentLifecycle.map((entry) => entry.emission.eventType)).toEqual([
      "subagent.started",
    ]);
    expect(
      harness.driverDiagnostics.recentRecordsOfKind("thread_duplicate_child_announcement"),
    ).toHaveLength(1);
  });

  it("a provider-INTERNAL child (compaction) carves its spend to the parent run rather than to a subagent", async () => {
    const harness = await managerWithSession();

    announceChild(harness, "compaction");
    emitUsage(harness, CHILD_THREAD_ID, 25);
    await Promise.resolve();

    // A provider-internal child spawns nothing user-facing, so no subagent events; the spend is
    // still charged.
    expect(harness.subagentLifecycle).toStrictEqual([]);
    expect(harness.meteredUsage).toHaveLength(1);
    expect(harness.meteredUsage[0]?.delta.axisDeltas.input).toBe(25);
  });

  it("the session's OWN terminal projects through to the normalize band", async () => {
    const harness = await managerWithSession();

    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "completed", items: [] } },
    });
    await Promise.resolve();

    expect(harness.notifications.map((entry) => entry.method)).toEqual(["turn/completed"]);
  });

  it("a fully suppressed child still leaves its started/completed pair", async () => {
    const harness = await managerWithSession();

    announceChild(harness, "subAgentReview");
    // Every content frame the child produces is suppressed...
    for (const childFrameMethod of ["thread/queue/changed", "thread/goal/updated"]) {
      harness.server.emitFrame({
        jsonrpc: "2.0",
        method: childFrameMethod,
        params: { threadId: CHILD_THREAD_ID },
      });
    }
    // ...including its own terminal.
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: CHILD_THREAD_ID, turn: { id: "child-turn", status: "completed" } },
    });
    await Promise.resolve();

    // Nothing of the child's content reached the parent's timeline...
    expect(harness.notifications).toStrictEqual([]);
    // ...yet the child stays visible through its started/completed pair.
    expect(
      harness.subagentLifecycle.map((entry) => ({
        eventType: entry.emission.eventType,
        subagentId: entry.emission.subagentId,
      })),
    ).toEqual([
      { eventType: "subagent.started", subagentId: CHILD_THREAD_ID },
      { eventType: "subagent.completed", subagentId: CHILD_THREAD_ID },
    ]);
    // The child's registers are released with its terminal.
    expect(harness.manager.usageAccountantFor(SESSION_ID).hasThread(CHILD_THREAD_ID)).toBe(false);
  });

  it("a resume WITH a prior-emitted sum meters only the excess over it", async () => {
    const harness = createManagerHarness({
      onServerNotification: true,
      readPriorEmittedUsage: () => ({ input: 500 }),
    });
    harness.server.on("thread/resume", () => threadStartResult(1));
    await harness.manager.resumeSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      resumeHandle: THREAD_ID,
    });

    emitUsage(harness, THREAD_ID, 520);
    await Promise.resolve();

    expect(
      harness.driverDiagnostics.recentRecordsOfKind("usage_resume_base_unavailable"),
    ).toHaveLength(0);
    expect(harness.meteredUsage[0]?.delta.axisDeltas.input).toBe(20);
  });

  it("closing a session releases its router and accountant rather than leaking them per session", async () => {
    const harness = await managerWithSession();
    emitUsage(harness, THREAD_ID, 10);
    await Promise.resolve();
    expect(harness.manager.usageAccountantFor(SESSION_ID).hasThread(THREAD_ID)).toBe(true);

    await harness.manager.closeSession({ sessionId: SESSION_ID });

    // The accessor creates on demand, so an empty thread proves the old accountant did not survive.
    expect(harness.manager.usageAccountantFor(SESSION_ID).hasThread(THREAD_ID)).toBe(false);
    expect(harness.manager.frameRouterFor(SESSION_ID).pendingHeldFrameCount()).toBe(0);
  });

  // ------------------------------------------------------------------------
  // The rewind rebind: `thread/fork` mints a new thread the session continues on, so the router and
  // accountant must move to it. A router left on the pre-fork thread holds then sheds every
  // post-rewind frame, and the session stops projecting and metering.
  // ------------------------------------------------------------------------

  const FORKED_THREAD_ID = "01a04202-0148-7ae2-8560-f04bed000001";

  /**
   * A prior-emitted sum on every axis; an axis left at zero would meter the whole cumulative and
   * trip the cross-check.
   */
  function priorEmittedBreakdown(value: number): CumulativeAxisReadings {
    return {
      total: value,
      input: value,
      cachedInput: value,
      cacheWriteInput: value,
      output: value,
      reasoningOutput: value,
    };
  }

  /**
   * A session created, metered, and rewound onto {@link FORKED_THREAD_ID}. The prior-emitted reader
   * answers only for the pre-fork thread and records every key it is asked for, so a lookup keyed
   * on the forked id shows up as a missing base.
   */
  async function rewoundSession(
    options: {
      /**
       * What the prior-emitted reader does. `prior-sum` answers for the pre-fork thread only;
       * `nothing` is a bound reader with no emitted sum, a correct answer rather than a fault.
       */
      readonly readerAnswer?: "prior-sum" | "nothing" | "throws";
      /** Whether the session meters anything before it is rewound. */
      readonly meterBeforeFork?: boolean;
      /** The thread id the provider's `thread/fork` answers with. */
      readonly forkAnswersThreadId?: string;
      /**
       * The turn ledger `thread/fork` answers with. Defaults to the one turn the fixture ran, which
       * agrees with the requested position.
       */
      readonly forkAnswersTurnIds?: readonly string[];
      /**
       * Announces a live child thread before the rewind: an id registered with the accountant that
       * is not the pre-fork thread.
       */
      readonly announceChildBeforeFork?: boolean;
    } = {},
  ): Promise<{
    harness: ManagerHarness;
    readerCalls: { sessionId: SessionId; threadId: string }[];
    rollbackResult: Awaited<ReturnType<CodexLifecycleManager["forkConversation"]>>;
  }> {
    const readerAnswer = options.readerAnswer ?? "prior-sum";
    const readerCalls: { sessionId: SessionId; threadId: string }[] = [];
    const harness = await managerWithSession({
      onServerNotification: true,
      readPriorEmittedUsage: (sessionId, threadId) => {
        readerCalls.push({ sessionId, threadId });
        if (readerAnswer === "throws") {
          throw new Error("prior-emitted usage reader failed");
        }
        if (readerAnswer === "nothing") {
          return undefined;
        }
        return threadId === THREAD_ID ? priorEmittedBreakdown(100) : undefined;
      },
    });

    // A turn gives the rewind a boundary to fork through; a metered reading gives the successor
    // real emitted spend to base on.
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    if (options.meterBeforeFork !== false) {
      emitUsage(harness, THREAD_ID, 100);
    }
    // The boundary turn must be over; a fork through a live turn is refused.
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await Promise.resolve();

    if (options.announceChildBeforeFork === true) {
      announceChild(harness, "subAgent");
      await drainMicrotasks();
    }

    harness.server.on("thread/fork", () => ({
      result: {
        thread: {
          id: options.forkAnswersThreadId ?? FORKED_THREAD_ID,
          sessionId: "session-tree-1",
          turns: (options.forkAnswersTurnIds ?? [TURN_ID]).map((turnId) => ({ id: turnId })),
        },
      },
    }));
    const rollbackResult = await harness.manager.forkConversation({
      sessionId: SESSION_ID,
      bindingId: "binding-predecessor",
      position: 1,
    });

    // Seed the forked id's ledger with what the daemon already emitted, so `last` is the per-turn
    // figure a continuing provider counter would report. Only when spend was emitted: otherwise
    // `last` would come out negative on every axis.
    if (options.meterBeforeFork !== false) {
      emittedCumulativeByThreadId.set(FORKED_THREAD_ID, 100);
    }
    return { harness, readerCalls, rollbackResult };
  }

  it("a rewind rebinds the band onto the forked thread and bases it on the PRE-FORK thread's emitted sum", async () => {
    const { harness, readerCalls, rollbackResult } = await rewoundSession();

    expect(rollbackResult.status).toBe("applied");
    // The sum must be looked up under the pre-fork thread, the one the daemon emitted spend
    // against; keyed on the forked thread it resolves to nothing and bases the session at zero. An
    // unrebound band asks nothing, so the wrong states are told apart.
    expect(readerCalls).toStrictEqual([{ sessionId: SESSION_ID, threadId: THREAD_ID }]);

    emitUsage(harness, FORKED_THREAD_ID, 150);
    await Promise.resolve();

    // Routed, not held: the forked thread is the session's own now.
    expect(harness.manager.frameRouterFor(SESSION_ID).pendingHeldFrameCount()).toBe(0);
    // Metered at 50, not 150: spend emitted before the fork is not charged twice.
    expect(
      harness.meteredUsage.map((entry) => ({
        threadId: entry.delta.threadId,
        input: entry.delta.axisDeltas.input,
      })),
    ).toStrictEqual([
      { threadId: THREAD_ID, input: 100 },
      { threadId: FORKED_THREAD_ID, input: 50 },
    ]);
    // No mis-based register fired: `usage_resume_base_unavailable` means a lookup keyed on the
    // forked id, `usage_delta_floor_hit` a base above the successor's readings, and the cross-check
    // compares the wire's per-turn figure with the derived interval.
    expect(harness.driverDiagnostics.recentRecordsOfKind("usage_resume_base_unavailable")).toEqual(
      [],
    );
    expect(harness.driverDiagnostics.recentRecordsOfKind("usage_delta_floor_hit")).toEqual([]);
    expect(harness.driverDiagnostics.recentRecordsOfKind("usage_cross_check_mismatch")).toEqual([]);
    // The forked history agrees with the requested position, so no disagreement is recorded.
    expect(
      harness.diagnostics.filter((entry) => entry.kind === "fork-turn-ledger-unconfirmed"),
    ).toStrictEqual([]);
  });

  it("a rewind retires the pre-fork thread as the session's own rather than leaving two", async () => {
    const { harness } = await rewoundSession();

    // The forked thread projects: it is the session now.
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "thread/queue/changed",
      params: { threadId: FORKED_THREAD_ID },
    });
    await Promise.resolve();
    expect(harness.notifications.map((entry) => entry.method)).toContain("thread/queue/changed");

    // The pre-fork thread does not: the router holds one session identity, so a late frame from the
    // abandoned thread is unregistered and waits instead of projecting into the rewound timeline.
    const projectedBeforeStaleFrame = harness.notifications.length;
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "thread/queue/changed",
      params: { threadId: THREAD_ID },
    });
    await Promise.resolve();

    expect(harness.notifications).toHaveLength(projectedBeforeStaleFrame);
    expect(harness.manager.frameRouterFor(SESSION_ID).pendingHeldFrameCount()).toBe(1);
  });

  it("refuses a rewind the provider did not FORK, leaving the session on its original thread", async () => {
    // The provider answers with the thread it was handed: not a fork, and the pre-rewind
    // conversation a fork should preserve is lost either way.
    const { harness, readerCalls, rollbackResult } = await rewoundSession({
      forkAnswersThreadId: THREAD_ID,
    });

    expect(rollbackResult).toStrictEqual({
      status: "degraded",
      fallbackAction: "rewind-not-forked",
    });
    // Refused before the re-point, so nothing is rebound or re-based.
    expect(readerCalls).toStrictEqual([]);

    // The session is unchanged, still routing and metering on its original thread, so the refusal
    // is safe to retry.
    emitUsage(harness, THREAD_ID, 150);
    await Promise.resolve();
    expect(harness.manager.frameRouterFor(SESSION_ID).pendingHeldFrameCount()).toBe(0);
    expect(
      harness.meteredUsage.map((entry) => ({
        threadId: entry.delta.threadId,
        input: entry.delta.axisDeltas.input,
      })),
    ).toStrictEqual([
      { threadId: THREAD_ID, input: 100 },
      { threadId: THREAD_ID, input: 50 },
    ]);
  });

  it("refuses a fork answered with a thread the session ALREADY meters, leaving both sets of registers intact", async () => {
    // A live child thread is registered with the accountant and is not the pre-fork thread.
    // Adopting it would reset registers carrying the child's spend and give the router an identity
    // already attributed elsewhere.
    const { harness, readerCalls, rollbackResult } = await rewoundSession({
      announceChildBeforeFork: true,
      forkAnswersThreadId: CHILD_THREAD_ID,
    });

    expect(rollbackResult).toStrictEqual({
      status: "degraded",
      fallbackAction: "rewind-target-thread-already-registered",
    });
    // Refused before the re-point, so no base was rebuilt.
    expect(readerCalls).toStrictEqual([]);
    expect(harness.manager.usageAccountantFor(SESSION_ID).hasThread(CHILD_THREAD_ID)).toBe(true);
    expect(harness.manager.usageAccountantFor(SESSION_ID).hasThread(THREAD_ID)).toBe(true);

    // Both still meter on their own bases: the child under its own attribution, the session on the
    // thread it never left.
    emitUsage(harness, CHILD_THREAD_ID, 40);
    emitUsage(harness, THREAD_ID, 150);
    await drainMicrotasks();
    expect(
      harness.meteredUsage.map((entry) => ({
        threadId: entry.delta.threadId,
        input: entry.delta.axisDeltas.input,
      })),
    ).toStrictEqual([
      { threadId: THREAD_ID, input: 100 },
      { threadId: CHILD_THREAD_ID, input: 40 },
      { threadId: THREAD_ID, input: 50 },
    ]);
  });

  /**
   * A rewind suspended at its `thread/fork` request, with the answer left to the test. No handler
   * is registered, so the request stays in flight and a concurrent caller can be dispatched inside
   * the window between request and answer.
   */
  async function rewindSuspendedAtFork(): Promise<{
    harness: ManagerHarness;
    rewind: ReturnType<CodexLifecycleManager["forkConversation"]>;
    answerFork: () => Promise<void>;
  }> {
    const harness = await managerWithSession({
      onServerNotification: true,
      readPriorEmittedUsage: (_sessionId, threadId) =>
        threadId === THREAD_ID ? priorEmittedBreakdown(100) : undefined,
    });
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    emitUsage(harness, THREAD_ID, 100);
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await drainMicrotasks();

    const rewind = harness.manager.forkConversation({
      sessionId: SESSION_ID,
      bindingId: "binding-predecessor",
      position: 1,
    });
    // Drained so the request has reached the wire.
    await drainMicrotasks();
    expect(harness.server.framesForMethod("thread/fork")).toHaveLength(1);

    return {
      harness,
      rewind,
      answerFork: async (): Promise<void> => {
        harness.server.emitFrame({
          jsonrpc: "2.0",
          id: harness.server.framesForMethod("thread/fork")[0]?.["id"],
          result: {
            thread: {
              id: FORKED_THREAD_ID,
              sessionId: "session-tree-1",
              turns: [{ id: TURN_ID }],
            },
          },
        });
        await drainMicrotasks();
      },
    };
  }

  it("refuses a turn dispatched while a rewind's fork is IN FLIGHT, and the rewound session still projects and meters", async () => {
    const { harness, rewind, answerFork } = await rewindSuspendedAtFork();
    const turnStartFramesBeforeRewind = harness.server.framesForMethod("turn/start").length;

    // Dispatched inside the fork's suspension. If accepted it would run on the pre-fork thread; the
    // fork then moves the band off it and every frame the turn produces is held then shed, though
    // the caller was told the turn started.
    const refusal = await harness.manager
      .startRun({
        runId: SECOND_RUN_ID,
        agentConfig: { sessionId: SESSION_ID, input: "second" },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(refusal).toBeInstanceOf(CodexTransportError);
    expect((refusal as Error).message).toContain("being re-established");
    // Refused at the entrance: nothing reached the wire, so no turn is stranded on the abandoned
    // thread.
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(turnStartFramesBeforeRewind);
    expect(harness.manager.hasActiveTurn(SECOND_RUN_ID)).toBe(false);

    await answerFork();
    await expect(rewind).resolves.toStrictEqual({
      status: "applied",
      sessionPosition: 1,
      bindingId: "binding-abc",
    });

    // The rewound session still works: the forked thread projects and meters against the pre-fork
    // thread's emitted sum.
    emittedCumulativeByThreadId.set(FORKED_THREAD_ID, 100);
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "thread/queue/changed",
      params: { threadId: FORKED_THREAD_ID },
    });
    emitUsage(harness, FORKED_THREAD_ID, 150);
    await drainMicrotasks();

    expect(harness.notifications.map((entry) => entry.method)).toContain("thread/queue/changed");
    expect(harness.manager.frameRouterFor(SESSION_ID).pendingHeldFrameCount()).toBe(0);
    expect(
      harness.meteredUsage.map((entry) => ({
        threadId: entry.delta.threadId,
        input: entry.delta.axisDeltas.input,
      })),
    ).toStrictEqual([
      { threadId: THREAD_ID, input: 100 },
      { threadId: FORKED_THREAD_ID, input: 50 },
    ]);
  });

  it("meters a forked-thread frame held across the fork against the base the rebind establishes", async () => {
    const { harness, rewind, answerFork } = await rewindSuspendedAtFork();

    // The provider has forked and the new thread is already emitting, but the daemon's continuation
    // has not run, so the router does not know the thread and holds the frame. Seeded first so the
    // fixture's per-thread `last` is a per-turn figure.
    emittedCumulativeByThreadId.set(FORKED_THREAD_ID, 100);
    emitUsage(harness, FORKED_THREAD_ID, 150);
    await drainMicrotasks();
    expect(harness.manager.frameRouterFor(SESSION_ID).pendingHeldFrameCount()).toBe(1);
    expect(harness.meteredUsage).toHaveLength(1);

    await answerFork();
    await expect(rewind).resolves.toMatchObject({ status: "applied" });

    // Released by the registration inside the rebind and metered at 50. This also covers the
    // rebind's order: if released before the base is established, `meterReading` answers null and
    // the reading is dropped without a record.
    expect(harness.manager.frameRouterFor(SESSION_ID).pendingHeldFrameCount()).toBe(0);
    expect(
      harness.meteredUsage.map((entry) => ({
        threadId: entry.delta.threadId,
        input: entry.delta.axisDeltas.input,
      })),
    ).toStrictEqual([
      { threadId: THREAD_ID, input: 100 },
      { threadId: FORKED_THREAD_ID, input: 50 },
    ]);
  });
});

describe("CodexDriver model catalog", () => {
  function buildCatalogDriverOptions(): ConstructorParameters<typeof CodexDriver>[0] {
    return {
      ptyHost: new FakeCodexAppServer(),
      modelCatalogExchange: STUB_MODEL_CATALOG_READ,
      diagnostics: makeSilentDriverDiagnostics(),
      subscribeToPtySession: () => () => undefined,
      reportDiagnostic: () => undefined,
      onTextNeutralizationFailure: () => undefined,
      scheduleTimeout: makeManualScheduler().schedule,
      executablePath: EXECUTABLE_PATH,
      resumeSpawnConfig: RESUME_SPAWN_CONFIG,
      resolveCredentialEnvPolicy: resolveNoDeniedCredentialNames,
      newBindingId: () => "binding-abc",
      readCapabilities: () => makeCapabilities(true),
    };
  }

  it("serves the live read's catalog", async () => {
    const driver = new CodexDriver({
      ...buildCatalogDriverOptions(),
      modelCatalogExchange: async () => ({
        data: [
          {
            id: "gpt-future-9",
            displayName: "GPT-Future-9",
            supportedReasoningEfforts: [{ reasoningEffort: "glacial" }],
          },
        ],
        nextCursor: null,
      }),
    });

    const models = await driver.listModels();

    // A level this file never enumerates: the vocabulary is the build's, not this driver's, so the
    // catalog stays current without an edit.
    expect(models).toEqual([
      {
        id: "gpt-future-9",
        name: "GPT-Future-9",
        capabilities: [],
        effortLevels: ["glacial"],
        fast: false,
      },
    ]);
  });

  it("propagates a failed live read", async () => {
    const driver = new CodexDriver({
      ...buildCatalogDriverOptions(),
      modelCatalogExchange: async () => ({ data: [], nextCursor: "page-2" }),
    });

    await expect(driver.listModels()).rejects.toThrow(/paginated/);
  });
});

// Callback-tool round trip through the composed path a production spawn uses: a provider
// `item/tool/call` frame reaches `CallbackToolHost` and the host's answer returns as a
// `DynamicToolCallResponse`. Passing `createCallbackToolAskResponder` as `answerServerRequest`
// makes the compiler check that the host's port and `CodexSessionServerRequestResponder` still
// agree.

const SEARCH_CALLBACK_TOOL: SessionCallbackTool = {
  name: "search_workspace",
  description: "Searches the session's mounted workspace.",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

interface CallbackToolRoundTripHarness {
  readonly askProvider: (method: string, params?: unknown) => Promise<Record<string, unknown>>;
  readonly executedInvocations: CallbackToolInvocation[];
  readonly evaluatedToolNames: string[];
  readonly hostDiagnostics: DriverDiagnosticRecord[];
  /** The manager's counted records, which the diagnostic counters read. */
  readonly driverDiagnosticRecords: DriverDiagnosticRecord[];
  /** Transport-local diagnostics, captured beside the counted records. */
  readonly transportDiagnostics: CodexTransportDiagnostic[];
  readonly startTurn: () => Promise<void>;
  /** A second run with its own live turn, which the sole-active fallback cannot attribute. */
  readonly startSecondTurn: () => Promise<void>;
}

async function callbackToolRoundTripHarness(): Promise<CallbackToolRoundTripHarness> {
  const executedInvocations: CallbackToolInvocation[] = [];
  const evaluatedToolNames: string[] = [];
  const hostDiagnostics: DriverDiagnosticRecord[] = [];
  const host = new CallbackToolHost({
    provider: "codex",
    diagnostics: new DriverDiagnosticsEmitter({
      logSink: { record: (record) => hostDiagnostics.push(record) },
      counterSink: { increment: () => undefined },
    }),
    executor: {
      execute: async (invocation) => {
        executedInvocations.push(invocation);
        return await Promise.resolve({ status: "completed", output: "2 matches" });
      },
    },
    activitySink: { record: () => undefined },
    approvalSeam: {
      evaluate: async (request) => {
        evaluatedToolNames.push(request.toolName);
        return await Promise.resolve({ decision: "allow", basis: "policy" });
      },
    },
  });
  bindCallbackToolsForSpawn(host, {
    sessionId: SESSION_ID,
    requestedTools: [SEARCH_CALLBACK_TOOL],
    providerRegistrationAvailable: true,
    providerRegistrationUnavailableDetail: CODEX_CALLBACK_TOOL_REGISTRATION_UNAVAILABLE_DETAIL,
  });
  const { harness, askProvider, driverDiagnosticRecords } = await routedAskHarness(
    createCallbackToolAskResponder({ host, approvalAskResponder: null }),
  );
  const startTurn = async (): Promise<void> => {
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.driver.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "search the workspace" },
    });
  };
  const startSecondTurn = async (): Promise<void> => {
    harness.server.on("turn/start", () => ({ result: { turn: { id: SECOND_TURN_ID } } }));
    await harness.driver.startRun({
      runId: SECOND_RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "search the workspace again" },
    });
  };
  return {
    askProvider,
    executedInvocations,
    evaluatedToolNames,
    hostDiagnostics,
    driverDiagnosticRecords,
    transportDiagnostics: harness.diagnostics,
    startTurn,
    startSecondTurn,
  };
}

describe("CodexDriver callback-tool round trip", () => {
  it("carries a provider tool call to the host and the host's answer back", async () => {
    const roundTrip = await callbackToolRoundTripHarness();
    await roundTrip.startTurn();

    const answer = await roundTrip.askProvider("item/tool/call", {
      tool: SEARCH_CALLBACK_TOOL.name,
      callId: "call-77",
      arguments: { query: "needle" },
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });

    // Adjudicated before executed, and answered in the provider's own shape.
    expect(roundTrip.evaluatedToolNames).toStrictEqual([SEARCH_CALLBACK_TOOL.name]);
    expect(roundTrip.executedInvocations[0]?.toolCallId).toBe("call-77");
    // The run id is resolved at answer time and reaches the invocation, so the call is
    // attributable.
    expect(roundTrip.executedInvocations[0]?.runId).toBe(RUN_ID);
    expect(answer["result"]).toStrictEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "2 matches" }],
    });
  });

  it("answers the provider's own refusal shape when the tool is not registered", async () => {
    const roundTrip = await callbackToolRoundTripHarness();
    await roundTrip.startTurn();

    const answer = await roundTrip.askProvider("item/tool/call", {
      tool: "delete_everything",
      callId: "call-78",
      arguments: {},
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });

    expect(answer["result"]).toMatchObject({ success: false });
    // Refused before adjudication: an unknown tool never reaches the approval seam or the executor.
    expect(roundTrip.evaluatedToolNames).toStrictEqual([]);
    expect(roundTrip.executedInvocations).toStrictEqual([]);
  });

  it("refuses a tool call that names no turn, BEFORE the host is reached", async () => {
    const roundTrip = await callbackToolRoundTripHarness();

    // `DynamicToolCallParams` carries a required non-nullable `turnId` in the pinned protocol, so
    // an ask without one cannot be attributed. Falling back to the sole-active run would let a
    // delayed request after an earlier run ended be misattributed.
    const answer = await roundTrip.askProvider("item/tool/call", {
      tool: SEARCH_CALLBACK_TOOL.name,
      callId: "call-80",
      arguments: { query: "needle" },
      threadId: THREAD_ID,
    });

    expect(answer["result"]).toMatchObject({ success: false });
    // An unattributable invocation is refused before adjudication, not adjudicated against a
    // guessed run.
    expect(roundTrip.hostDiagnostics).toStrictEqual([]);
    expect(roundTrip.executedInvocations).toStrictEqual([]);
    // Both sinks: the counted kind is what the diagnostic counters name.
    expect(roundTrip.driverDiagnosticRecords.map((record) => record.kind)).toStrictEqual([
      "callback_tool_invocation_refused",
    ]);
    expect(roundTrip.driverDiagnosticRecords[0]?.details["turnId"]).toBeNull();
    expect(
      roundTrip.transportDiagnostics.filter(
        (diagnostic) => diagnostic.kind === "routed-ask-turn-unresolved",
      ),
    ).toStrictEqual([
      {
        kind: "routed-ask-turn-unresolved",
        method: "item/tool/call",
        turnId: null,
        turnIdTruncated: false,
        disposition: "refused",
      },
    ]);
  });

  it("resolves the callback run from the turn the ask names, with two runs live", async () => {
    // With two live runs the sole-active fallback answers `null`; the turn the ask names resolves
    // the run exactly.
    const roundTrip = await callbackToolRoundTripHarness();
    await roundTrip.startTurn();
    await roundTrip.startSecondTurn();

    const answer = await roundTrip.askProvider("item/tool/call", {
      tool: SEARCH_CALLBACK_TOOL.name,
      callId: "call-81",
      arguments: { query: "needle" },
      threadId: THREAD_ID,
      turnId: SECOND_TURN_ID,
    });

    expect(answer["result"]).toMatchObject({ success: true });
    expect(roundTrip.executedInvocations[0]?.runId).toBe(SECOND_RUN_ID);
    // The first run's turn resolves to the first run over the same connection: attribution, not a
    // coin flip.
    await roundTrip.askProvider("item/tool/call", {
      tool: SEARCH_CALLBACK_TOOL.name,
      callId: "call-82",
      arguments: { query: "needle" },
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    expect(roundTrip.executedInvocations[1]?.runId).toBe(RUN_ID);
  });

  it("refuses a tool call naming a turn this daemon holds no live route for", async () => {
    // A delayed ask arrives after its turn retired while a newer run is live; misattributing it
    // would run the older turn's tool against the newer run's registry and approval seam.
    const roundTrip = await callbackToolRoundTripHarness();
    await roundTrip.startTurn();

    const answer = await roundTrip.askProvider("item/tool/call", {
      tool: SEARCH_CALLBACK_TOOL.name,
      callId: "call-83",
      arguments: { query: "needle" },
      threadId: THREAD_ID,
      turnId: "turn-that-already-retired",
    });

    expect(answer["result"]).toMatchObject({ success: false });
    expect(roundTrip.hostDiagnostics).toStrictEqual([]);
    expect(roundTrip.executedInvocations).toStrictEqual([]);
    expect(roundTrip.driverDiagnosticRecords[0]?.details["turnId"]).toBe(
      "turn-that-already-retired",
    );
  });
});

// Native compaction settles on the provider's typed evidence, never on the request being accepted.
// The wait is bounded and ends in one of two terminals (bound elapsed, binding lost), and bounding
// the wait never bounds the boundary's record.

describe("CodexLifecycleManager.compactContext (native)", () => {
  // A child thread of this session's own thread, declared here so a neighboring describe cannot
  // repoint it.
  const CHILD_THREAD_ID = "01a04202-0148-7ae2-8560-child0000002";

  async function compactionHarness(): Promise<ManagerHarness> {
    const harness = createManagerHarness({ onServerNotification: true });
    harness.server.on("thread/compact/start", () => ({ result: {} }));
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    return harness;
  }

  function emitCompactionBoundary(
    harness: ManagerHarness,
    params: Record<string, unknown> = { threadId: THREAD_ID, turnId: TURN_ID },
  ): void {
    harness.server.emitFrame({ jsonrpc: "2.0", method: "thread/compacted", params });
  }

  it("dispatches `thread/compact/start` for the session's own thread and settles `applied` on the typed frame", async () => {
    const harness = await compactionHarness();

    const compaction = harness.manager.compactContext({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    await drainMicrotasks();
    // The trigger names the session's current thread, read off the record, not a value the caller
    // supplied.
    expect(harness.server.framesForMethod("thread/compact/start")).toHaveLength(1);
    expect(harness.server.framesForMethod("thread/compact/start")[0]?.["params"]).toStrictEqual({
      threadId: THREAD_ID,
    });

    // The provider's typed evidence. `ContextCompactedNotification` is `{ threadId, turnId }` in
    // the pinned protocol and names no position, so `null` states that the frame carried none.
    emitCompactionBoundary(harness);

    await expect(compaction).resolves.toStrictEqual({
      status: "applied",
      boundaryPosition: null,
    });
  });

  it("does NOT settle `applied` on the empty acknowledgement alone", async () => {
    const harness = await compactionHarness();

    let observed: DriverCompactionResult | "still-waiting" = "still-waiting";
    const compaction = harness.manager.compactContext({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    void compaction.then((result) => {
      observed = result;
    });
    await drainMicrotasks();

    // `ThreadCompactStartResponse` is an empty acknowledgement returned when the provider accepts
    // the job. The request has resolved (the frame count shows the dispatch) and the operation is
    // still open.
    expect(harness.server.framesForMethod("thread/compact/start")).toHaveLength(1);
    expect(observed).toBe("still-waiting");
    // Non-vacuous: a wait is armed at the driver's declared bound, so the operation is open because
    // it waits, not because the request hung.
    expect(harness.scheduler.pendingDelays()).toContain(COMPACTION_WAIT_MS);

    emitCompactionBoundary(harness);
    await expect(compaction).resolves.toMatchObject({ status: "applied" });
  });

  it("settles `wait_expired` when the declared bound elapses — and a LATE compaction frame still normalizes", async () => {
    const harness = await compactionHarness();

    const compaction = harness.manager.compactContext({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    await drainMicrotasks();

    // Fire only the compaction bound, not `fireAll`: a live session also holds the transport's 60s
    // request deadline, and firing it would reject the in-flight request and settle
    // `provider_error` for the wrong reason.
    expect(harness.scheduler.fireDelay(COMPACTION_WAIT_MS)).toBe(1);

    await expect(compaction).resolves.toStrictEqual({
      status: "failed",
      reason: "wait_expired",
    });
    const terminals = harness.driverDiagnostics.recentRecordsOfKind("compaction_wait_terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.details["terminal"]).toBe("wait_expired");
    expect(terminals[0]?.details["declaredBoundMs"]).toBe(COMPACTION_WAIT_MS);

    // A boundary frame arriving after the wait expired settles nobody and still travels its
    // ordinary route into the normalize band; a tap written as a diversion would swallow it.
    const before = harness.notifications.length;
    emitCompactionBoundary(harness);
    await drainMicrotasks();
    expect(harness.notifications.slice(before).map((entry) => entry.method)).toEqual([
      "thread/compacted",
    ]);
  });

  it("settles `provider_error` when the trigger itself is refused, and records no false terminal", async () => {
    const harness = createManagerHarness({ onServerNotification: true });
    harness.server.on("thread/compact/start", () => ({
      error: { code: -32603, message: "compaction unavailable" },
    }));
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });

    await expect(
      harness.manager.compactContext({ sessionId: SESSION_ID, bindingId: "binding-abc" }),
    ).resolves.toStrictEqual({ status: "failed", reason: "provider_error" });
    const terminals = harness.driverDiagnostics.recentRecordsOfKind("compaction_wait_terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.details["terminal"]).toBe("provider_error");

    // The armed wait is withdrawn, not left to time out. A thrown request means the transport
    // failed, and `COMPACTION_WAIT_MS` is longer than the transport deadline that produces
    // such a throw, so a leftover registration would outlive its caller.
    expect(harness.scheduler.pendingDelays()).not.toContain(COMPACTION_WAIT_MS);

    // Nothing is left for the bound to fire, so a later elapse cannot revive a settled operation or
    // emit a second terminal.
    expect(harness.scheduler.fireDelay(COMPACTION_WAIT_MS)).toBe(0);
    await drainMicrotasks();
    expect(harness.driverDiagnostics.recentRecordsOfKind("compaction_wait_terminal")).toHaveLength(
      1,
    );
  });

  it("a registered CHILD thread's compaction never settles the user's wait", async () => {
    const harness = await compactionHarness();
    // A provider-internal compaction child is the adversarial case: it is itself a compaction, so
    // only the thread its boundary frame names separates it from the user's.
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "thread/started",
      params: {
        thread: {
          id: CHILD_THREAD_ID,
          parentThreadId: THREAD_ID,
          threadSourceKind: "compaction",
        },
      },
    });

    const compaction = harness.manager.compactContext({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    await drainMicrotasks();

    emitCompactionBoundary(harness, { threadId: CHILD_THREAD_ID, turnId: "child-turn" });
    await drainMicrotasks();

    // The child's boundary frame routed `carve-out-usage`, a different arm from the two the tap is
    // called from, so it reached neither the user's wait nor the parent's timeline.
    expect(harness.notifications).toStrictEqual([]);
    expect(harness.scheduler.pendingDelays()).toContain(COMPACTION_WAIT_MS);

    // The wait still runs out its own declared bound, so the child settled nothing; a tap comparing
    // nothing, or a routing regression, would already have resolved `applied`.
    expect(harness.scheduler.fireDelay(COMPACTION_WAIT_MS)).toBe(1);
    await expect(compaction).resolves.toStrictEqual({
      status: "failed",
      reason: "wait_expired",
    });
  });

  it("settles `binding_lost` the instant the binding goes, with no timer ever firing", async () => {
    const harness = await compactionHarness();

    const compaction = harness.manager.compactContext({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    await drainMicrotasks();

    await harness.manager.closeSession({ sessionId: SESSION_ID });

    await expect(compaction).resolves.toStrictEqual({
      status: "failed",
      reason: "binding_lost",
    });
    // Immediacy: the second terminal is pushed from the disposal path, not polled, so a binding
    // lost at t=0 settles at t=0. A poller could only settle when a timer ran.
    expect(harness.scheduler.firedDelays()).not.toContain(COMPACTION_WAIT_MS);
    const terminals = harness.driverDiagnostics.recentRecordsOfKind("compaction_wait_terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.details["terminal"]).toBe("binding_lost");
  });
});

// The command list is a live read held as driver-session state, not a stored registry; its entries
// carry the `(driverName, providerAccountId)` they were read under.
describe("CodexLifecycleManager.listProviderCommands (live read)", () => {
  interface SkillFixture {
    name: string;
    description?: unknown;
    scope?: unknown;
    enabled?: unknown;
  }

  function skillsListResult(skills: readonly SkillFixture[]): JsonRpcAnswer {
    // The pinned reply is nested: `{ data: SkillsListEntry[] }` where each entry is `{ cwd, skills,
    // errors }`, one group per scanned root.
    return {
      result: {
        data: [{ cwd: SESSION_CWD, skills: [...skills], errors: [] }],
      },
    };
  }

  async function enumerationHarness(
    skills: readonly SkillFixture[],
    options: ManagerHarnessOptions = {},
  ): Promise<ManagerHarness> {
    const harness = createManagerHarness({ onServerNotification: true, ...options });
    let current: readonly SkillFixture[] = skills;
    harness.server.on("skills/list", () => skillsListResult(current));
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: options.config ?? SESSION_CONFIG,
    });
    Object.assign(harness, {
      setSkills: (next: readonly SkillFixture[]) => {
        current = next;
      },
    });
    return harness;
  }

  it("returns disabled entries, carries `enabled` verbatim, and maps an empty description to an ABSENT key", async () => {
    const harness = await enumerationHarness([
      { name: "review", description: "Review a diff", scope: "repo", enabled: true },
      { name: "retired", description: "Not offerable", scope: "user", enabled: false },
      // `SkillMetadata.description` is a required string in the pinned protocol, and a skill file
      // may leave it blank.
      { name: "blank", description: "", scope: "repo", enabled: true },
      { name: "whitespace", description: "   ", scope: "repo", enabled: true },
      // A provider that publishes no boolean: absence stays absence, never a synthesized `true`.
      { name: "undeclared", description: "No enabled flag", scope: "system" },
    ]);

    const result = await harness.manager.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    const entries = result.bindings[0]?.entries ?? [];

    // Disabled entries are returned: the flag governs offerability, not presence, and filtering it
    // would hide the difference between a disabled command and one that does not exist.
    expect(entries.map((entry) => entry.name)).toEqual([
      "review",
      "retired",
      "blank",
      "whitespace",
      "undeclared",
    ]);
    expect(entries.map((entry) => entry.enabled)).toEqual([true, false, true, true, undefined]);
    // Key presence, not `toBeUndefined()`: under `exactOptionalPropertyTypes` a
    // present-but-undefined key differs from an absent one, and only absence means the provider
    // declared nothing.
    expect(Object.hasOwn(entries[4] as object, "enabled")).toBe(false);

    // Empty and whitespace-only descriptions become absent instead of refusing their entries:
    // `wireFreeFormString` rejects both, so carrying them through would drop two real commands.
    expect(Object.hasOwn(entries[2] as object, "description")).toBe(false);
    expect(Object.hasOwn(entries[3] as object, "description")).toBe(false);
    expect(entries[0]?.description).toBe("Review a diff");
    expect(entries.every((entry) => entry.kind === "skill")).toBe(true);
    expect(entries[0]?.scope).toBe("repo");
  });

  it("caps the REPLY at the wire bound while the held enumeration stays whole", async () => {
    const overCap = DRIVER_PROVIDER_COMMAND_ENTRIES_MAX + 3;
    const harness = await enumerationHarness(
      Array.from({ length: overCap }, (_unused, index) => ({
        name: `skill-${index}`,
        description: `entry ${index}`,
        scope: "repo",
        enabled: true,
      })),
    );

    const first = await harness.manager.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });

    expect(first.bindings[0]?.complete).toBe(false);
    expect(first.bindings[0]?.entries).toHaveLength(DRIVER_PROVIDER_COMMAND_ENTRIES_MAX);
    const truncations = harness.driverDiagnostics.recentRecordsOfKind(
      "provider_command_entries_truncated",
    );
    expect(truncations).toHaveLength(1);
    expect(truncations[0]?.details["heldCount"]).toBe(overCap);
    expect(truncations[0]?.details["returnedCount"]).toBe(DRIVER_PROVIDER_COMMAND_ENTRIES_MAX);

    // The held list was not truncated: the second read sends no new `skills/list` frame and the
    // diagnostic still reports the full held count. A cap applied to the held list would report the
    // capped number.
    const second = await harness.manager.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    expect(harness.server.framesForMethod("skills/list")).toHaveLength(1);
    expect(second.bindings[0]?.complete).toBe(false);
    expect(
      harness.driverDiagnostics.recentRecordsOfKind("provider_command_entries_truncated"),
    ).toHaveLength(2);
    expect(
      harness.driverDiagnostics.recentRecordsOfKind("provider_command_entries_truncated")[1]
        ?.details["heldCount"],
    ).toBe(overCap);

    // No presence-check assertion, deliberately: a truncated read cannot manufacture a
    // `command_absent` refusal because that check belongs to the emulated driver's pre-dispatch
    // step. This native driver performs none (the `refused` arm of `DriverCompactionResult` is
    // unreachable from `compactContext`).
  });

  it("re-reads in FULL on `skills/changed`, never patching the held list", async () => {
    const harness = (await enumerationHarness([
      { name: "alpha", description: "first", scope: "repo", enabled: true },
      { name: "beta", description: "second", scope: "repo", enabled: true },
    ])) as ManagerHarness & { setSkills: (next: readonly SkillFixture[]) => void };

    const first = await harness.manager.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    expect(first.bindings[0]?.entries.map((entry) => entry.name)).toEqual(["alpha", "beta"]);

    // A second read with no invalidation is served from held state.
    await harness.manager.listProviderCommands({ sessionId: SESSION_ID, bindingId: "binding-abc" });
    expect(harness.server.framesForMethod("skills/list")).toHaveLength(1);

    // `beta` is deleted upstream and `gamma` appears. `SkillsChangedNotification` is an empty
    // payload, so there is nothing to patch with.
    harness.setSkills([
      { name: "alpha", description: "first", scope: "repo", enabled: true },
      { name: "gamma", description: "third", scope: "user", enabled: false },
    ]);
    harness.server.emitFrame({ jsonrpc: "2.0", method: "skills/changed", params: {} });
    await drainMicrotasks();

    const third = await harness.manager.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });
    expect(harness.server.framesForMethod("skills/list")).toHaveLength(2);
    // A patch would have left `beta` behind; only a full re-read makes the list exactly the
    // provider's current one.
    expect(third.bindings[0]?.entries.map((entry) => entry.name)).toEqual(["alpha", "gamma"]);
  });

  it("sends empty params, and discards the held enumeration with the session", async () => {
    const harness = await enumerationHarness([
      { name: "review", description: "Review a diff", scope: "repo", enabled: true },
    ]);

    await harness.manager.listProviderCommands({ sessionId: SESSION_ID, bindingId: "binding-abc" });
    // `SkillsListParams` is `{ cwds?, forceReload? }`; an empty `cwds` defaults to the session's
    // working directory, which is this connection's spawn cwd. Restating it would narrow the read
    // if a later build scans more roots by default.
    expect(harness.server.framesForMethod("skills/list")[0]?.["params"]).toStrictEqual({});

    await harness.manager.closeSession({ sessionId: SESSION_ID });
    await harness.manager.createSession({
      model: TEST_MODEL,
      sessionId: SESSION_ID,
      config: SESSION_CONFIG,
    });
    await harness.manager.listProviderCommands({ sessionId: SESSION_ID, bindingId: "binding-abc" });

    // A held list that survived its session would answer the next session on this id with the
    // previous one's skills.
    expect(harness.server.framesForMethod("skills/list")).toHaveLength(2);
  });

  it("passes a bound account through verbatim to every entry", async () => {
    const harness = await enumerationHarness(
      [{ name: "review", description: "Review a diff", scope: "repo", enabled: true }],
      { config: { ...SESSION_CONFIG, providerAccountId: "account-7" } },
    );

    const result = await harness.manager.listProviderCommands({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
    });

    expect(result.bindings[0]?.binding).toStrictEqual({
      driverName: "codex",
      providerAccountId: "account-7",
    });
    expect(result.bindings[0]?.entries[0]?.binding.providerAccountId).toBe("account-7");
  });
});
