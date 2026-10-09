// Codex session lifecycle against a fake service: a session's slot is never double-claimed or
// wedged, a resume forks the conversation onto the session's config and a failed one never
// replaces or destroys a session, a close ends what the conversation left running and keeps the
// service, and a conversation never runs without its permission profile.

import { describe, expect, it, vi } from "vitest";

import { DRIVER_FAILURE_DETAIL_MAX_LEN } from "@ai-sidekicks/contracts/provider/driver/length-limits";

import { captureRejection } from "../../../../__fixtures__/capture-failure.js";
import { drainMicrotasks } from "../../../__fixtures__/drain-microtasks.js";
import {
  BASE_INSTRUCTIONS,
  createHarness,
  createdSession,
  DEFAULT_CODEX_HOME,
  forkedThreadId,
  type JsonRpcAnswer,
  RUN_ID,
  runConfig,
  SECOND_SESSION_ID,
  SESSION_ID,
  THREAD_ID,
  TURN_ID,
} from "../__fixtures__/app-server-doubles.js";
import {
  CodexSessionAlreadyLiveError,
  CodexTransportError,
  normalizeProviderFailureDetail,
} from "../session/errors.js";
import { CREATE_PARAMS, RESUME_PARAMS } from "./lifecycle.test-support.js";

describe("Codex session close", () => {
  it("ends the running commands before it unsubscribes, and keeps the service", async () => {
    // A command outlives its turn; a close that only unsubscribed would leave it running.
    const harness = createHarness();
    harness.server.on("thread/backgroundTerminals/list", () => ({
      result: { data: [{ itemId: "item-7", processId: "proc-7" }], nextCursor: null },
    }));
    await createdSession(harness);

    await harness.driver.closeSession({ sessionId: SESSION_ID });

    const teardown = harness.server
      .writtenFrames()
      .map((frame) => frame["method"])
      .filter((method) =>
        [
          "thread/backgroundTerminals/terminate",
          "thread/backgroundTerminals/clean",
          "thread/unsubscribe",
        ].includes(String(method)),
      );
    expect(teardown).toEqual([
      "thread/backgroundTerminals/terminate",
      "thread/backgroundTerminals/clean",
      "thread/unsubscribe",
    ]);
    expect(harness.server.paramsFor("thread/backgroundTerminals/terminate")[0]).toEqual({
      threadId: THREAD_ID,
      processId: "proc-7",
    });
    // The service serves the account's other sessions, so it stays, and the next one reuses it.
    expect(harness.server.runningProcessCount()).toBe(1);
    await createdSession(harness, { sessionId: SECOND_SESSION_ID });
    expect(harness.server.launchCountFor(DEFAULT_CODEX_HOME)).toBe(1);
  });

  it("closes even when the provider refuses the unsubscribe", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("thread/unsubscribe", () => ({
      error: { code: -32600, message: "thread not found" },
    }));

    await expect(harness.driver.closeSession({ sessionId: SESSION_ID })).resolves.toBeUndefined();
    // The slot is free again: a create is admitted.
    await expect(createdSession(harness)).resolves.toMatchObject({ resumeHandle: "thread-2" });
  });
});

describe("Codex permission profile", () => {
  it("refuses a conversation started under no permission profile, and lets it go", async () => {
    // A conversation Codex started with no profile would run with whatever its config allows.
    const harness = createHarness();
    harness.server.on("thread/start", () => ({
      result: { thread: { id: THREAD_ID, sessionId: "session-tree-1", turns: [] } },
    }));

    const fault = await captureRejection(createdSession(harness));

    expect(fault).toBeInstanceOf(CodexTransportError);
    expect((fault as CodexTransportError).fields).toMatchObject({ activeProfile: "none" });
    expect(harness.server.paramsFor("thread/unsubscribe")).toEqual([{ threadId: THREAD_ID }]);
    // Nothing was installed for the session.
    await expect(
      harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig() }),
    ).rejects.toBeInstanceOf(CodexTransportError);
  });
});

describe("Codex resumeSession", () => {
  it("forks the created thread on the session's config, then runs on the fork", async () => {
    // A resume of a conversation another client holds would apply none of the session's config.
    const harness = createHarness();
    const handle = await harness.driver.createSession(CREATE_PARAMS);

    const result = await harness.driver.resumeSession({
      ...RESUME_PARAMS,
      resumeHandle: handle.resumeHandle,
    });

    // `thread.id` is the resume key; `thread.sessionId` groups a thread tree, so swapping them
    // would fork the wrong conversation.
    expect(handle.resumeHandle).toBe(THREAD_ID);
    expect(harness.server.framesForMethod("thread/resume")).toHaveLength(0);
    const [fork] = harness.server.paramsFor("thread/fork");
    expect(fork).toMatchObject({
      threadId: THREAD_ID,
      excludeTurns: true,
      baseInstructions: BASE_INSTRUCTIONS,
      config: expect.any(Object),
    });
    expect(fork?.["config"]).toStrictEqual(harness.server.paramsFor("thread/start")[0]?.["config"]);
    expect(result).toMatchObject({ status: "resumed", resumeHandle: forkedThreadId(1) });
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("go") });
    expect(harness.server.paramsFor("turn/start")[0]?.["threadId"]).toBe(forkedThreadId(1));
  });

  const failedResumeAnswers: ReadonlyArray<readonly [string, JsonRpcAnswer]> = [
    // The verbatim refusal the provider returns for an unknown or never-persisted thread.
    [
      "refused",
      { error: { code: -32600, message: `no rollout found for thread id ${THREAD_ID}` } },
    ],
    // `turns: []` is a well-formed history, so only the thread id tells this from a real fork.
    [
      "answered by the thread it forks",
      {
        result: {
          thread: { id: THREAD_ID, sessionId: "tree-9", turns: [] },
          activePermissionProfile: { id: "sidekicks-ask", extends: null },
        },
      },
    ],
  ];

  it.each(failedResumeAnswers)(
    "never replaces the session when the resume is %s",
    async (_label, answer) => {
      const harness = createHarness();
      const createSessionSpy = vi.spyOn(harness.driver, "createSession");
      harness.server.on("thread/fork", () => answer);

      const result = await harness.driver.resumeSession(RESUME_PARAMS);

      expect(result).toMatchObject({ status: "failed", recoveryCondition: "recovery-needed" });
      // A replacement can slip in through the public create or a private helper, so both the spy
      // and the wire are checked.
      expect(createSessionSpy).not.toHaveBeenCalled();
      expect(harness.server.framesForMethod("thread/start")).toHaveLength(0);
      // Nothing was installed: a later create is admitted, which a taken slot would refuse.
      await expect(harness.driver.createSession(CREATE_PARAMS)).resolves.toMatchObject({
        resumeHandle: THREAD_ID,
      });
    },
  );

  it("leaves the prior conversation live when the resume fails", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("thread/fork", () => ({
      error: { code: -32600, message: "thread not found" },
    }));

    await expect(harness.driver.resumeSession(RESUME_PARAMS)).resolves.toMatchObject({
      recoveryCondition: "recovery-needed",
    });

    // A refused resume that let the live conversation go would be destructive.
    expect(harness.server.framesForMethod("thread/unsubscribe")).toHaveLength(0);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await expect(
      harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("carry on") }),
    ).resolves.toBeUndefined();
  });

  it("fails the run whose turn a resume superseded, once, without quoting its words", async () => {
    // The resume replaces the conversation the turn ran on, so no terminal for it can arrive.
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.driver.startRun({
      runId: RUN_ID,
      agentConfig: runConfig("please rebase onto develop"),
    });

    await harness.driver.resumeSession(RESUME_PARAMS);

    expect(harness.lostRuns.map((lost) => lost.runId)).toEqual([RUN_ID]);
    const detail = harness.lostRuns[0]?.failure.providerFailureDetail ?? "";
    expect(detail).toContain("superseded by a resume");
    // The person's own words are never quoted into the detail.
    expect(detail).not.toContain("rebase");
  });
});

describe("Codex session slot", () => {
  it("refuses a create that overlaps an establishment still in flight, starting once", async () => {
    const harness = createHarness();

    // Both issued in one tick: a guard that read only the installed records would start a second
    // conversation whose handle the later install would orphan.
    const first = harness.driver.createSession(CREATE_PARAMS);
    const refusal = await captureRejection(harness.driver.createSession(CREATE_PARAMS));
    await first;

    expect(refusal).toBeInstanceOf(CodexSessionAlreadyLiveError);
    expect((refusal as CodexSessionAlreadyLiveError).holderState).toBe("establishing");
    expect(harness.server.framesForMethod("thread/start")).toHaveLength(1);
  });

  it("makes closeSession wait for an in-flight establishment instead of no-opping", async () => {
    const harness = createHarness();
    const release = harness.server.holdAnswers("thread/start");

    const creating = harness.driver.createSession(CREATE_PARAMS);
    await drainMicrotasks();
    // A close that read the installed records would find none and leave the conversation open
    // under a session the daemon believes closed.
    const closing = harness.driver.closeSession({ sessionId: SESSION_ID });
    release();
    await creating;
    await closing;

    expect(harness.server.paramsFor("thread/unsubscribe")).toEqual([{ threadId: THREAD_ID }]);
  });

  it("refuses a turn/start whose session was closed while it was in flight", async () => {
    const harness = createHarness();
    await createdSession(harness);
    let closing: Promise<void> | undefined;
    harness.server.on("turn/start", () => {
      // The provider accepts the turn but the session is gone when the answer lands.
      closing = harness.driver.closeSession({ sessionId: SESSION_ID });
      return { result: { turn: { id: TURN_ID } } };
    });

    const outcome = await captureRejection(
      harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("go") }),
    );
    await closing;

    // Success would strand a route no sweep can reach.
    expect(outcome).toBeInstanceOf(CodexTransportError);
    expect((outcome as Error).message).toContain("stopped holding its slot");
    await expect(harness.driver.interruptRun({ runId: RUN_ID })).rejects.toThrow(
      /No active Codex turn/,
    );
  });
});

describe("Codex auth status", () => {
  it("never asks the provider to refresh or for the token, on probe or failed resume", async () => {
    // The providers rotate refresh tokens single-use with no grace window, so a refreshing read
    // would end the login it checks. Both members are sent explicitly: omitted, the provider's
    // default decides.
    const probing = createHarness();
    await probing.driver.probeAuth();
    const resuming = createHarness();
    resuming.server.on("thread/fork", () => ({
      error: { code: -32600, message: "thread not found" },
    }));
    await resuming.driver.resumeSession(RESUME_PARAMS);

    for (const harness of [probing, resuming]) {
      expect(harness.server.paramsFor("getAuthStatus")[0]).toEqual({
        includeToken: false,
        refreshToken: false,
      });
    }
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
      const harness = createHarness();
      harness.server.on("getAuthStatus", () => answer);

      const result = await harness.driver.probeAuth();

      expect(result.status).toBe(status);
      expect(JSON.stringify(result)).not.toContain("sk-should-never-be-read");
    },
  );

  it("reports reauth-required when a refused resume resolves no auth method", async () => {
    // An expired credential must not be reported as "reconcile this by hand".
    const harness = createHarness();
    harness.server.on("thread/fork", () => ({
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
    // value carries, which is how configuration and its credentials could get there.
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
