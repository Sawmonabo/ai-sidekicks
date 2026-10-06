// Codex driver lifecycle against a fake provider: the fake implements `PtyHost` and speaks JSON-RPC
// over the same byte channel, so every test drives the real framing, correlation, deadline and
// teardown code. This file guards process ownership: no child is orphaned, no session slot is
// double-claimed or wedged, and a failed resume never replaces or destroys a session.

import { describe, expect, it, vi } from "vitest";

import { CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME } from "@ai-sidekicks/contracts/machine-settings";
import { DRIVER_FAILURE_DETAIL_MAX_LEN } from "@ai-sidekicks/contracts/provider/driver/driver";
import { TEXT_NEUTRALIZATION_REFUSAL_CODE } from "../../../outbound-frame.js";
import {
  CodexAppServerConnection,
  CodexSessionAlreadyLiveError,
  CodexTransportError,
  CODEX_APP_SERVER_READY_SENTINEL,
  normalizeProviderFailureDetail,
} from "../index.js";
import {
  EXECUTABLE_PATH,
  FakeCodexAppServer,
  type JsonRpcAnswer,
  RESUME_SPAWN_CONFIG,
  RUN_ID,
  SECOND_RUN_ID,
  SESSION_CWD,
  SESSION_ID,
  THREAD_ID,
  TURN_ID,
  createHarness,
  createManagerHarness,
  createdSession,
  threadStartResult,
} from "./test-doubles.js";
import { CREATE_PARAMS, RESUME_PARAMS } from "./lifecycle.test-support.js";
import { captureRejection } from "../../../../__fixtures__/capture-failure.js";
import { drainMicrotasks } from "../../../__fixtures__/drain-microtasks.js";
import { makeManualScheduler } from "../../../__fixtures__/manual-scheduler.js";

describe("CodexDriver process ownership", () => {
  it("spawns in the session's directory with exactly the supplied environment", async () => {
    const harness = createHarness();
    await createdSession(harness);

    // A child in the wrong directory edits the wrong files.
    expect(harness.server.spawnRequests[0]?.cwd).toBe(SESSION_CWD);
    // Exact equality: a leaked `process.env` would add entries, credentials among them.
    expect(harness.server.spawnRequests[0]?.env).toEqual([
      ["HOME", "/home/agent"],
      ["PATH", "/usr/bin"],
      [CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME, EXECUTABLE_PATH],
    ]);
  });

  it("waits for the prelude sentinel before writing anything", async () => {
    // Bytes written before the prelude has set the terminal up are lost or echoed.
    const harness = createHarness();
    harness.server.emitSentinelOnSubscribe = false;
    harness.server.on("thread/start", () => threadStartResult());

    const pending = harness.driver.createSession(CREATE_PARAMS);
    await drainMicrotasks();
    expect(harness.server.writtenLines).toHaveLength(0);

    harness.server.emitLine(CODEX_APP_SERVER_READY_SENTINEL);
    await pending;
    expect(harness.server.framesForMethod("initialize")).toHaveLength(1);
  });

  it("tears the process down on close, even if the provider refuses the unsubscribe", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("thread/unsubscribe", () => ({
      error: { code: -32600, message: "thread not found" },
    }));

    await expect(harness.driver.closeSession({ sessionId: SESSION_ID })).resolves.toBeUndefined();
    expect(harness.server.framesForMethod("thread/unsubscribe")[0]?.["params"]).toEqual({
      threadId: THREAD_ID,
    });
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });

  it("refuses a second createSession for a live session, spawning nothing", async () => {
    const harness = createHarness();
    await createdSession(harness);

    await expect(harness.driver.createSession(CREATE_PARAMS)).rejects.toBeInstanceOf(
      CodexSessionAlreadyLiveError,
    );
    // A replace would leave the first child running with nothing routing to it.
    expect(harness.server.spawnRequests).toHaveLength(1);
    expect(harness.server.closedSessions).toEqual([]);
  });

  // Driven at the connection, because `createSession` has its own guard that would release the
  // child anyway. `open()` must never leave a child behind, for every caller.
  it("open() itself releases the child when the subscriber throws", async () => {
    const server = new FakeCodexAppServer();
    const connection = new CodexAppServerConnection({
      ptyHost: server,
      providerBaseEnvironment: [],
      subscribeToPtySession: () => {
        throw new Error("subscription registry refused the attach");
      },
      reportDiagnostic: () => {},
      scheduleTimeout: makeManualScheduler().schedule,
      executablePath: EXECUTABLE_PATH,
    });

    await expect(connection.open(RESUME_SPAWN_CONFIG)).rejects.toThrow(/refused the attach/);
    expect(server.spawnRequests).toHaveLength(1);
    expect(server.closedSessions).toEqual(["pty-session-1"]);
  });
});

describe("CodexDriver resumeSession", () => {
  it("resumes the thread the create returned, byte for byte", async () => {
    const harness = createHarness();
    harness.server.on("thread/start", () => threadStartResult());
    const handle = await harness.driver.createSession(CREATE_PARAMS);
    harness.server.on("thread/resume", () => threadStartResult(1));

    await harness.driver.resumeSession({ ...RESUME_PARAMS, resumeHandle: handle.resumeHandle });

    // `thread.id` is the resume key; `thread.sessionId` groups a thread tree, so swapping them
    // would resume the wrong conversation.
    expect(handle.resumeHandle).toBe(THREAD_ID);
    expect(harness.server.framesForMethod("thread/resume")[0]?.["params"]).toMatchObject({
      threadId: THREAD_ID,
    });
  });

  const failedResumeAnswers: ReadonlyArray<readonly [string, JsonRpcAnswer]> = [
    // The verbatim refusal the provider returns for an unknown or never-persisted thread.
    [
      "refused",
      { error: { code: -32600, message: `no rollout found for thread id ${THREAD_ID}` } },
    ],
    // `turns: []` is a well-formed history, so only the thread id tells this from a real resume.
    [
      "answered by a different thread",
      {
        result: {
          thread: { id: "01a04202-0148-7ae2-8560-000000000999", sessionId: "tree-9", turns: [] },
        },
      },
    ],
  ];

  it.each(failedResumeAnswers)(
    "never replaces the session when the resume is %s",
    async (_label, answer) => {
      const harness = createHarness();
      const createSessionSpy = vi.spyOn(harness.driver, "createSession");
      harness.server.on("thread/resume", () => answer);

      const result = await harness.driver.resumeSession(RESUME_PARAMS);

      expect(result).toMatchObject({ status: "failed", recoveryCondition: "recovery-needed" });
      // A replacement can slip in through the public create or a private helper, so both the spy
      // and the wire are checked.
      expect(createSessionSpy).not.toHaveBeenCalled();
      expect(harness.server.framesForMethod("thread/start")).toHaveLength(0);
      // The refused process is released rather than left running.
      expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
      // Nothing was installed: a later create is admitted, which a taken slot would refuse.
      harness.server.on("thread/start", () => threadStartResult());
      await expect(harness.driver.createSession(CREATE_PARAMS)).resolves.toMatchObject({
        resumeHandle: THREAD_ID,
      });
    },
  );

  it("returns the typed failure when the process dies before answering", async () => {
    const harness = createHarness();
    harness.server.emitSentinelOnSubscribe = false;

    const pending = harness.driver.resumeSession(RESUME_PARAMS);
    await drainMicrotasks();
    harness.server.emitExit(126);

    await expect(pending).resolves.toMatchObject({
      status: "failed",
      recoveryCondition: "recovery-needed",
    });
  });

  it("releases the superseded leg's process once the resume has succeeded", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.spawnResponse = { kind: "spawn_response", session_id: "pty-session-2" };
    harness.server.on("thread/resume", () => threadStartResult(3));

    await expect(harness.driver.resumeSession(RESUME_PARAMS)).resolves.toMatchObject({
      status: "resumed",
    });

    // A resume is a fresh spawn, so a driver that only overwrote its record would orphan the first.
    expect(harness.server.spawnRequests).toHaveLength(2);
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });

  it("leaves the prior leg live when the resume fails", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.spawnResponse = { kind: "spawn_response", session_id: "pty-session-2" };
    harness.server.on("thread/resume", () => ({
      error: { code: -32600, message: "thread not found" },
    }));

    await expect(harness.driver.resumeSession(RESUME_PARAMS)).resolves.toMatchObject({
      recoveryCondition: "recovery-needed",
    });

    // Only the process that just failed is torn down; killing the live one would make a refused
    // resume destructive.
    expect(harness.server.closedSessions).toEqual(["pty-session-2"]);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await expect(
      harness.driver.startRun({
        runId: RUN_ID,
        agentConfig: { sessionId: SESSION_ID, input: "carry on" },
      }),
    ).resolves.toBeUndefined();
  });

  it("fails a superseded leg's unsettled frame as a supersede, not a swallowed turn", async () => {
    // The resume replaces the binding the frame was written on, so no terminal for it can arrive,
    // and a dropped frame would look like a run whose words landed.
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.driver.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "please rebase onto develop" },
    });

    harness.server.spawnResponse = { kind: "spawn_response", session_id: "pty-session-2" };
    harness.server.on("thread/resume", () => threadStartResult(2));
    await harness.driver.resumeSession(RESUME_PARAMS);

    expect(harness.textNeutralizationFailures).toHaveLength(1);
    expect(harness.textNeutralizationFailures[0]?.runId).toBe(RUN_ID);
    const detail = harness.textNeutralizationFailures[0]?.providerFailureDetail ?? "";
    // The swallow code has a parseable form consumers act on; borrowing it would report a swallow
    // nobody observed.
    expect(detail).not.toContain(TEXT_NEUTRALIZATION_REFUSAL_CODE);
    expect(detail).toContain("superseded");
    // The user's own words are never quoted into the detail.
    expect(detail).not.toContain("rebase");
  });
});

describe("CodexLifecycleManager session slot", () => {
  it("refuses a create that overlaps an establishment still in flight, spawning once", async () => {
    const harness = createManagerHarness();
    const release = harness.server.holdSpawns();

    // Both issued in one tick: a guard that read only the live map would spawn a second process
    // whose handle the later install would orphan.
    const first = harness.manager.createSession(CREATE_PARAMS);
    const second = harness.manager.createSession(CREATE_PARAMS);
    release();
    const refusal = await captureRejection(second);
    await first;

    expect(refusal).toBeInstanceOf(CodexSessionAlreadyLiveError);
    expect((refusal as CodexSessionAlreadyLiveError).holderState).toBe("establishing");
    expect(harness.server.spawnRequests).toHaveLength(1);
  });

  it("serializes a burst of same-tick resumes, releasing every superseded process", async () => {
    const harness = createManagerHarness();
    harness.server.uniqueSpawnSessionIds = true;
    harness.server.on("thread/resume", () => threadStartResult(1));

    // Three, not two: two waiters released by one settlement could both find the slot free, and
    // the later install would orphan the earlier process.
    const results = await Promise.all([
      harness.manager.resumeSession(RESUME_PARAMS),
      harness.manager.resumeSession(RESUME_PARAMS),
      harness.manager.resumeSession(RESUME_PARAMS),
    ]);

    expect(results.map((result) => result.status)).toEqual(["resumed", "resumed", "resumed"]);
    expect(harness.server.spawnRequests).toHaveLength(3);
    expect(harness.server.closedSessions).toEqual(["pty-session-1", "pty-session-2"]);
  });

  it("makes closeSession wait for an in-flight establishment instead of no-opping", async () => {
    const harness = createManagerHarness();
    const release = harness.server.holdSpawns();

    const creating = harness.manager.createSession(CREATE_PARAMS);
    // A close that read the live map would find it empty and leave the create's process running
    // under a session the daemon believes closed.
    const closing = harness.manager.closeSession({ sessionId: SESSION_ID });
    release();
    await creating;
    await closing;

    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });

  it("holds the slot for the whole of teardown and releases it once teardown settles", async () => {
    const harness = createManagerHarness();
    harness.server.uniqueSpawnSessionIds = true;
    await harness.manager.createSession(CREATE_PARAMS);

    const releaseCloses = harness.server.holdCloses();
    const closing = harness.manager.closeSession({ sessionId: SESSION_ID });
    await drainMicrotasks();

    // A second child admitted here would outlive the one still exiting.
    const refusal = await captureRejection(harness.manager.createSession(CREATE_PARAMS));
    expect(refusal).toBeInstanceOf(CodexSessionAlreadyLiveError);
    expect((refusal as CodexSessionAlreadyLiveError).holderState).toBe("closing");
    expect(harness.server.spawnRequests).toHaveLength(1);

    releaseCloses();
    await closing;
    await harness.manager.createSession(CREATE_PARAMS);
    expect(harness.server.spawnRequests).toHaveLength(2);
  });

  it("releases the process and the slot even when the subscription disposer throws", async () => {
    const harness = createManagerHarness({ throwingSubscriptionDisposer: true });
    await harness.manager.createSession(CREATE_PARAMS);

    const outcome = await captureRejection(harness.manager.closeSession({ sessionId: SESSION_ID }));

    // The fault reaches the caller but must not stop the host release or wedge the slot.
    expect((outcome as Error).message).toContain("subscription disposer failed");
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
    await harness.manager.createSession(CREATE_PARAMS);
  });

  it("refuses a turn/start whose session was closed while it was in flight", async () => {
    const harness = createManagerHarness();
    await harness.manager.createSession(CREATE_PARAMS);
    let closing: Promise<void> | undefined;
    harness.server.on("turn/start", () => {
      // Issued from inside the write: the provider accepts the turn but the session is gone when
      // the answer lands.
      closing = harness.manager.closeSession({ sessionId: SESSION_ID });
      return { result: { turn: { id: TURN_ID } } };
    });

    const outcome = await captureRejection(
      harness.manager.startRun({
        runId: RUN_ID,
        agentConfig: { sessionId: SESSION_ID, input: "go" },
      }),
    );
    await closing;

    // Success would be a lie about a dead process and strand a route no sweep can reach.
    expect(outcome).toBeInstanceOf(CodexTransportError);
    expect((outcome as Error).message).toContain("stopped holding its slot");
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
    expect(harness.server.closedSessions).toEqual(["pty-session-1"]);
  });

  it("kills the connection if a turn is accepted after a failed resume took the slot", async () => {
    // A failed resume releases only its own new connection, so the accepted turn would keep
    // executing tools on a process nobody else is going to stop.
    const harness = createManagerHarness();
    harness.server.uniqueSpawnSessionIds = true;
    harness.server.on("thread/resume", () => ({
      error: { code: -32000, message: "no such thread" },
    }));
    let resuming: Promise<unknown> | undefined;
    let releaseSpawns: (() => void) | undefined;
    harness.server.on("turn/start", () => {
      releaseSpawns = harness.server.holdSpawns();
      resuming = harness.manager.resumeSession(RESUME_PARAMS);
      return { result: { turn: { id: TURN_ID } } };
    });
    await harness.manager.createSession(CREATE_PARAMS);

    const starting = harness.manager.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    // Parks the resume inside its spawn so the answer lands while the transition is in flight.
    await drainMicrotasks();
    releaseSpawns?.();
    const outcome = await captureRejection(starting);

    expect(await resuming).toMatchObject({ status: "failed" });
    expect(outcome).toBeInstanceOf(CodexTransportError);
    expect(harness.manager.hasActiveTurn(RUN_ID)).toBe(false);
    expect(harness.server.killedSessions).toEqual([
      { sessionId: "pty-session-1", signal: "SIGKILL" },
    ]);
  });
});

describe("CodexDriver approval reviewer pinning", () => {
  // Every approval must reach the daemon's own pipeline. The per-turn field overrides routing for
  // later turns, so a thread-level pin alone would be defeated by one per-turn override.
  it("pins the reviewer on the thread and on every turn", async () => {
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
    for (const frame of turnFrames) {
      expect(frame["params"]).toMatchObject({ approvalsReviewer: "user" });
    }
  });
});

describe("Codex auth status", () => {
  it("never asks the provider to refresh or for the token, on probe or failed resume", async () => {
    // The providers rotate refresh tokens single-use with no grace window, so a refreshing read
    // would end the login it checks. Both members are sent explicitly: omitted, the provider's
    // default decides.
    const probing = createManagerHarness();
    await probing.manager.probeAuth();
    const resuming = createHarness();
    resuming.server.on("thread/resume", () => ({
      error: { code: -32600, message: "thread not found" },
    }));
    await resuming.driver.resumeSession(RESUME_PARAMS);

    for (const harness of [probing, resuming]) {
      expect(harness.server.framesForMethod("getAuthStatus")[0]?.["params"]).toEqual({
        includeToken: false,
        refreshToken: false,
      });
    }
    // The probe's child is released like any other.
    expect(probing.server.closedSessions).toEqual(["pty-session-1"]);
  });

  const probeAnswers: ReadonlyArray<readonly [string, string, JsonRpcAnswer]> = [
    [
      "a resolved auth method",
      "authenticated",
      { result: { authMethod: "chatgpt", authToken: "sk-should-never-be-read" } },
    ],
    ["no auth method", "unauthenticated", { result: { authMethod: null, authToken: null } }],
    // A refused or unreadable probe says nothing about the credential; `unauthenticated` would
    // send the person to re-authenticate a login never in question.
    ["a refused probe", "indeterminate", { error: { code: -32601, message: "Method not found" } }],
    ["an unreadable answer", "indeterminate", { result: { authMethod: 17 } }],
  ];

  it.each(probeAnswers)(
    "reads %s as %s, never echoing the token",
    async (_label, status, answer) => {
      const harness = createManagerHarness();
      harness.server.on("getAuthStatus", () => answer);

      const result = await harness.manager.probeAuth();

      expect(result.status).toBe(status);
      expect(JSON.stringify(result)).not.toContain("sk-should-never-be-read");
    },
  );

  it("reports reauth-required when a refused resume resolves no auth method", async () => {
    // An expired credential must not be reported as "reconcile this by hand".
    const harness = createHarness();
    harness.server.on("thread/resume", () => ({
      error: { code: -32600, message: "thread not found" },
    }));
    harness.server.on("getAuthStatus", () => ({ result: { authMethod: null } }));

    await expect(harness.driver.resumeSession(RESUME_PARAMS)).resolves.toMatchObject({
      status: "failed",
      recoveryCondition: "reauth-required",
    });
  });
});

describe("normalizeProviderFailureDetail", () => {
  it("persists only a bounded string, never an arbitrary value's toString", () => {
    // The detail reaches a durable row the person sees; `String()` runs whatever `toString` the
    // value carries, which is how spawn configuration and its credentials could get there.
    const hostile = {
      toString(): string {
        return "ANTHROPIC_API_KEY=sk-secret-value";
      },
    };
    expect(normalizeProviderFailureDetail(hostile)).not.toContain("sk-secret-value");
    // The row's schema refuses NUL and over-length text, which would lose the failure record.
    expect(normalizeProviderFailureDetail("with\0nul")).toBe("withnul");
    expect(
      normalizeProviderFailureDetail("x".repeat(DRIVER_FAILURE_DETAIL_MAX_LEN + 10)),
    ).toHaveLength(DRIVER_FAILURE_DETAIL_MAX_LEN);
    expect(normalizeProviderFailureDetail("   ")).toMatch(/no diagnostic message/);
  });
});
