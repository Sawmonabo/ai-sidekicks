// How the Codex driver dispatches turns: a turn the provider may have taken is never sent twice,
// a turn's route lives exactly as long as the turn, posture is never caller-overridable, a profile
// Codex reports that was never asked for is put back, steers go out in order without waiting for a
// step's end and never into a retired turn, and a rewind forks exactly where it was asked to.

import { describe, expect, it } from "vitest";

import {
  CodexDriverConfigError,
  CodexProviderRequestError,
  CodexRequestTimeoutError,
  CodexRequestTooLargeError,
  CodexRewindBoundaryUnsupportedError,
  CodexTransportError,
} from "../session/errors.js";
import { drainMicrotasks } from "../../../__fixtures__/drain-microtasks.js";
import {
  type Harness,
  DEFAULT_CODEX_HOME,
  RUN_ID,
  SESSION_ID,
  TEST_POSTURE,
  THREAD_ID,
  TURN_ID,
  createHarness,
  createdSession,
  runConfig,
  threadReply,
  turnCompletedFrame,
} from "../__fixtures__/app-server-doubles.js";
import { CREATE_PARAMS, RESUME_PARAMS } from "./lifecycle.test-support.js";
import { captureRejection } from "../../../../__fixtures__/capture-failure.js";

/** A harness with one live session. */
async function liveSession(): Promise<Harness> {
  const harness = createHarness();
  await createdSession(harness);
  return harness;
}

function startRun(harness: Harness, input = "go"): Promise<void> {
  return harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig(input) });
}

// Hands the run a steer the way the run queue does.
function steer(
  harness: Harness,
  clientIdempotencyKey: string,
  content = "focus on the failing test",
): ReturnType<Harness["driver"]["applyIntervention"]> {
  return harness.driver.applyIntervention({
    type: "steer",
    targetRunId: RUN_ID,
    expectedRunVersion: 1,
    clientIdempotencyKey,
    payload: { content, expectedTurnId: TURN_ID },
  });
}

/** Whether the run still has a live turn here, read by whether an interrupt reaches it. */
async function takesInterrupt(harness: Harness): Promise<boolean> {
  harness.server.on("turn/interrupt", () => ({ result: {} }));
  try {
    await harness.driver.interruptRun({ runId: RUN_ID });
    return true;
  } catch (e) {
    if (e instanceof CodexTransportError) {
      return false;
    }
    throw e;
  }
}

describe("Codex turn posture", () => {
  it.each([
    ["readonly", "user", "writes"],
    ["ask", "user", "writes"],
    ["reviewed", "auto_review", "writes"],
    ["sandboxed", "user", "writes"],
    ["yolo", "user", "approve"],
  ] as const)(
    "sends a %s session's reviewer on its thread and turns, and its connectors' defaults",
    async (level, reviewer, connectorApprovalMode) => {
      // Codex reads a connector ask's reviewer from `apps` before the conversation's, and a turn's
      // reviewer routes every later turn; only `apps._default` is set, so the person's own value
      // for one app or tool keeps winning for it.
      const harness = createHarness();
      harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
      await createdSession(harness, { posture: { ...TEST_POSTURE, mode: level } });
      await startRun(harness);

      const threadStart = harness.server.paramsFor("thread/start")[0];
      expect(threadStart?.["approvalsReviewer"]).toBe(reviewer);
      expect(threadStart?.["config"]).toMatchObject({
        "apps._default.approvals_reviewer": reviewer,
        "apps._default.default_tools_approval_mode": connectorApprovalMode,
      });
      expect(harness.server.paramsFor("turn/start")[0]?.["approvalsReviewer"]).toBe(reviewer);
    },
  );

  it("asks again for the session's posture when Codex reports a profile it never asked for", async () => {
    const harness = createHarness();
    await createdSession(harness, { posture: { ...TEST_POSTURE, mode: "ask" } });
    const askProfile = harness.server.paramsFor("thread/start")[0]?.["permissions"];
    const reportProfile = (id: unknown): void => {
      harness.server.emitFrame({
        jsonrpc: "2.0",
        method: "thread/settings/updated",
        params: { threadId: THREAD_ID, threadSettings: { activePermissionProfile: { id } } },
      });
    };
    const drifts = () =>
      harness.diagnostics.filter((diagnostic) => diagnostic.kind === "permission-profile-drifted");

    // The profile the conversation started on is no drift, and a move into Plan keeps it.
    await harness.driver.updateSessionMode({ sessionId: SESSION_ID, mode: "plan" });
    // Plan is Codex's own plan mode alone: no profile or approval rule of the daemon's rides it.
    expect(harness.server.paramsFor("thread/settings/update")).toStrictEqual([
      {
        threadId: THREAD_ID,
        collaborationMode: {
          mode: "plan",
          settings: {
            model: harness.server.paramsFor("thread/start")[0]?.["model"],
            reasoning_effort: null,
            developer_instructions: null,
          },
        },
      },
    ]);
    reportProfile(askProfile);
    await drainMicrotasks();
    expect(drifts()).toHaveLength(0);
    const sentBeforeDrift = harness.server.paramsFor("thread/settings/update").length;

    reportProfile(":danger-full-access");
    await drainMicrotasks();

    expect(drifts()).toStrictEqual([
      {
        kind: "permission-profile-drifted",
        threadId: THREAD_ID,
        activeProfile: ":danger-full-access",
        expectedProfile: askProfile,
      },
    ]);
    expect(
      harness.server
        .paramsFor("thread/settings/update")
        .slice(sentBeforeDrift)
        .map((params) => params?.["permissions"]),
    ).toStrictEqual([askProfile]);
    expect(askProfile).toMatch(/^sidekicks-ask-/);
  });

  it("refuses every declared posture field before the wire", async () => {
    const harness = await liveSession();

    for (const field of [
      "cwd",
      "sandbox",
      "sandboxPolicy",
      "permissions",
      "permissionProfile",
      "approvalPolicy",
      "approvalsReviewer",
    ]) {
      await expect(
        harness.driver.startRun({
          runId: RUN_ID,
          agentConfig: { ...runConfig("review the diff"), [field]: "anything" },
        }),
      ).rejects.toBeInstanceOf(CodexDriverConfigError);
    }
    // Refused before the wire, not filtered on it.
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(0);
  });

  it("sends steers mid-step in order, each once Codex answered the one before", async () => {
    const harness = await liveSession();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("turn/steer", () => ({ result: { turnId: TURN_ID } }));
    await startRun(harness, "one");
    // A step is in flight, and no `item/completed` ends it during this test.
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { type: "commandExecution", id: "i-1", command: "pnpm test", status: "inProgress" },
      },
    });

    // The run queue hands every waiting message over at once, before Codex echoed any of them.
    const keys = [
      "9a1d8f30-0000-4000-8000-0000000000aa",
      "9a1d8f30-0000-4000-8000-0000000000ab",
      "9a1d8f30-0000-4000-8000-0000000000ac",
    ];
    const releaseAnswers = harness.server.holdAnswers("turn/steer");
    const sent = keys.map((key, index) => steer(harness, key, `message ${String(index + 1)}`));
    await drainMicrotasks();
    // The first is on the wire before the step ends; the next wait for Codex to answer it.
    expect(harness.server.paramsFor("turn/steer")).toHaveLength(1);
    releaseAnswers();
    expect(await Promise.all(sent)).toEqual(keys.map(() => ({ status: "applied" })));
    // Each goes out once, in the order it came, carrying its own key for Codex's echo.
    expect(
      harness.server.paramsFor("turn/steer").map((params) => ({
        key: params?.["clientUserMessageId"],
        input: params?.["input"],
      })),
    ).toStrictEqual(
      keys.map((key, index) => ({
        key,
        input: [{ type: "text", text: `message ${String(index + 1)}`, text_elements: [] }],
      })),
    );

    // A send Codex refuses fails the steer rather than leaving it answered as taken, and the
    // steer after it still goes out.
    harness.server.on("turn/steer", () => ({ error: { code: -32600, message: "no active turn" } }));
    const refused = captureRejection(steer(harness, "9a1d8f30-0000-4000-8000-0000000000bb"));
    expect(await refused).toBeInstanceOf(CodexProviderRequestError);
    harness.server.on("turn/steer", () => ({ result: { turnId: TURN_ID } }));
    expect(await steer(harness, "9a1d8f30-0000-4000-8000-0000000000bc")).toEqual({
      status: "applied",
    });
  });

  it("fails a steer that waited behind another once an interrupt retired its turn", async () => {
    const harness = await liveSession();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("turn/steer", () => ({ result: { turnId: TURN_ID } }));
    harness.server.on("turn/interrupt", () => ({ result: {} }));
    await startRun(harness, "one");
    const releaseAnswers = harness.server.holdAnswers("turn/steer");
    const first = steer(harness, "9a1d8f30-0000-4000-8000-0000000000da");
    const waiting = captureRejection(steer(harness, "9a1d8f30-0000-4000-8000-0000000000db"));
    await drainMicrotasks();

    await harness.driver.interruptRun({ runId: RUN_ID });
    releaseAnswers();

    expect(await first).toEqual({ status: "applied" });
    expect(await waiting).toBeInstanceOf(CodexTransportError);
    // Only the steer sent while its turn was live reached Codex.
    expect(
      harness.server.paramsFor("turn/steer").map((params) => params?.["clientUserMessageId"]),
    ).toStrictEqual(["9a1d8f30-0000-4000-8000-0000000000da"]);
  });
});

describe("Codex ambiguous turn/start", () => {
  it.each([
    ["misses its deadline", undefined, CodexRequestTimeoutError],
    // An answer with no addressable turn id leaves the same question open as no answer.
    ["is answered with no usable turn id", { result: { turn: {} } }, CodexTransportError],
  ] as const)(
    "lets the conversation go, sends nothing again and keeps the service when turn/start %s",
    async (_label, answer, errorClass) => {
      // With no clean answer the turn may have landed, and no route could ever reach it.
      const harness = await liveSession();
      if (answer !== undefined) {
        harness.server.on("turn/start", () => answer);
      }

      const failure = captureRejection(startRun(harness));
      await drainMicrotasks();
      if (answer === undefined) {
        harness.scheduler.fireAll();
      }

      expect(await failure).toBeInstanceOf(errorClass);
      await drainMicrotasks();
      expect(harness.server.framesForMethod("turn/start")).toHaveLength(1);
      expect(harness.server.paramsFor("thread/unsubscribe")).toEqual([{ threadId: THREAD_ID }]);
      // One conversation's fault never ends the account's service, which other sessions share.
      await createdSession(harness);
      expect(harness.server.launchCountFor(DEFAULT_CODEX_HOME)).toBe(1);
      expect(harness.server.runningProcessCount()).toBe(1);
    },
  );

  it("keeps the session when the provider answers turn/start with a refusal", async () => {
    // The refusal proves the turn never started, so there is nothing to let go.
    const harness = await liveSession();
    harness.server.on("turn/start", () => ({
      error: { code: -32600, message: "Invalid request" },
    }));

    const outcome = await captureRejection(startRun(harness));

    expect(outcome).toBeInstanceOf(CodexProviderRequestError);
    expect(harness.server.framesForMethod("thread/unsubscribe")).toHaveLength(0);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await startRun(harness);
    expect(await takesInterrupt(harness)).toBe(true);
  });

  it("refuses a turn past the size Codex takes before sending it, keeping the session", async () => {
    // Codex closes its socket on a message past the limit it names, which would end every
    // conversation on the account's service, so the request never goes out.
    const harness = await liveSession();
    harness.server.sentMessageByteLimit = 4096;

    const outcome = await captureRejection(startRun(harness, "x".repeat(4096)));

    expect(outcome).toBeInstanceOf(CodexRequestTooLargeError);
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(0);
    expect(harness.server.framesForMethod("thread/unsubscribe")).toHaveLength(0);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await startRun(harness);
    expect(await takesInterrupt(harness)).toBe(true);
  });
});

describe("Codex turn route", () => {
  // `turn/completed` is the only terminal notification; a failure or an interrupt arrives on it
  // too. A finished turn left active would take interventions aimed at a retired turn id, and one
  // retired mid-flight would refuse a live steer or interrupt.
  it.each([
    ["completed", false],
    ["interrupted", false],
    ["failed", false],
    ["inProgress", true],
  ] as const)("on a %s terminal, leaves the turn active: %s", async (status, stillActive) => {
    const harness = await liveSession();
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await startRun(harness);

    harness.server.emitFrame(turnCompletedFrame(TURN_ID, status));
    await drainMicrotasks();

    expect(await takesInterrupt(harness)).toBe(stillActive);
  });

  it("does not let a stale terminal retire a newer turn for the same run", async () => {
    const harness = await liveSession();
    let nextTurnId = TURN_ID;
    harness.server.on("turn/start", () => ({ result: { turn: { id: nextTurnId } } }));
    await startRun(harness, "one");
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await drainMicrotasks();
    nextTurnId = "turn-02";
    await startRun(harness, "two");

    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await drainMicrotasks();

    expect(await takesInterrupt(harness)).toBe(true);
  });

  it("gives no route to a turn that ended in the same read chunk as its start answer", async () => {
    // The terminal arrives before `startRun` resumes, so a route installed after it would hold a
    // dead turn active, which nothing retires.
    const harness = await liveSession();
    harness.server.on("turn/start", () => ({
      result: { turn: { id: TURN_ID } },
      trailingFrames: [turnCompletedFrame(TURN_ID, "completed")],
    }));

    await startRun(harness, "/status please");

    expect(await takesInterrupt(harness)).toBe(false);
  });
});

describe("Codex rewind", () => {
  const RESTARTED_THREAD_ID = "thread-restarted";
  const APPLIED = { status: "applied", sessionPosition: 1 };

  /**
   * A session reopened onto two turns of history, served newest first over two pages; the rewind's
   * fork holds the first turn alone.
   */
  async function resumedWithTurns(harness: Harness): Promise<void> {
    harness.server.on("thread/turns/list", (params) => {
      const request = params as Record<string, unknown>;
      if (request["threadId"] !== RESTARTED_THREAD_ID) {
        return { result: { data: [{ id: "turn-0" }], nextCursor: null } };
      }
      return request["cursor"] === undefined
        ? { result: { data: [{ id: "turn-1" }], nextCursor: "page-2" } }
        : { result: { data: [{ id: "turn-0" }], nextCursor: null } };
    });
    // The restart forks the whole conversation; a rewind forks at a boundary.
    harness.server.on("thread/fork", (params) =>
      (params as Record<string, unknown>)["lastTurnId"] === undefined
        ? threadReply(RESTARTED_THREAD_ID, params)
        : threadReply("thread-forked", params, 1),
    );
    await harness.driver.resumeSession(RESUME_PARAMS);
  }

  it("forks at the oldest-first boundary", async () => {
    // A boundary read newest first would cut the wrong turn.
    const harness = createHarness();
    await resumedWithTurns(harness);

    await expect(
      harness.driver.moveSessionToFork({
        sessionId: SESSION_ID,
        bindingId: "binding-predecessor",
        position: 1,
      }),
    ).resolves.toStrictEqual(APPLIED);
    expect(harness.server.paramsFor("thread/fork").at(-1)?.["lastTurnId"]).toBe("turn-0");
  });

  it("refuses a position naming no recorded boundary, never forking the whole thread", async () => {
    const harness = await liveSession();

    const result = await harness.driver.moveSessionToFork({
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
        harness.driver.moveSessionToFork({ sessionId: SESSION_ID, bindingId: "b", position: 1 }),
      );

      expect(refused).toBeInstanceOf(CodexRewindBoundaryUnsupportedError);
      expect((refused as CodexRewindBoundaryUnsupportedError).code).toBe(
        "driver.capability_unsupported",
      );
      // A leaked slot would leave the session unable to rewind, resume or close again.
      harness.server.on("thread/fork", (params) => threadReply("thread-forked", params, 1));
      await expect(
        harness.driver.moveSessionToFork({ sessionId: SESSION_ID, bindingId: "b", position: 1 }),
      ).resolves.toStrictEqual(APPLIED);
    },
  );
});

describe("Codex helper limit", () => {
  it("switches helpers off for a disabled policy", async () => {
    const harness = createHarness();

    await harness.driver.createSession({ ...CREATE_PARAMS, subagentPolicy: { enabled: false } });

    expect(harness.server.paramsFor("thread/start")[0]?.["config"]).toMatchObject({
      "features.multi_agent_v2": false,
      "agents.enabled": false,
    });
  });
});
