// Moving a Codex conversation onto a changed config, its window or its level's config keys: a fork
// with the new config at the next turn boundary, which the session moves onto, at once when idle
// and once a running turn settled. A turn never runs on config other than the chosen one, the
// session's binding names the fork, and records the conversation left behind, before anything else
// moves, so a daemon restart resumes the fork; that conversation's command rows stay live, and it
// is let go only once no command of it runs.

import { describe, expect, it } from "vitest";

import type { RunId } from "@ai-sidekicks/contracts/run/id";

import { drainMicrotasks } from "../../../__fixtures__/drain-microtasks.js";
import { withScratchBindingStore } from "../../../__fixtures__/binding-store.js";
import { readLeftConversations } from "../../../left-conversations.js";
import { composeResumeSessionParams, RuntimeBindingStore } from "../../../runtime-binding-store.js";
import {
  BASE_INSTRUCTIONS,
  createHarness,
  createdSession,
  deliveriesOf,
  forkedThreadId,
  type Harness,
  type HarnessOptions,
  type JsonRpcAnswer,
  RUN_ID,
  runConfig,
  SECOND_RUN_ID,
  sentContextWindow,
  SESSION_ID,
  TEST_MODEL,
  TEST_POSTURE,
  THREAD_ID,
  threadReply,
  turnCompletedFrame,
} from "../__fixtures__/app-server-doubles.js";
import { CREATE_PARAMS } from "./lifecycle.test-support.js";

const DEFAULT_WINDOW = 272_000;
const LARGER_WINDOW = 872_000;

// Answers each `turn/start` with a turn of its own: `turn-1`, `turn-2`, …
function answerTurnStarts(harness: Harness): void {
  let started = 0;
  harness.server.on("turn/start", () => {
    started += 1;
    return { result: { turn: { id: `turn-${started}` } } };
  });
}

async function startRunOnWindow(
  harness: Harness,
  runId: RunId,
  window: { model?: string; largerWindow?: number } = {},
): Promise<void> {
  await harness.driver.startRun({ runId, agentConfig: { ...runConfig("go"), ...window } });
}

// The order of the requests that fork, let go of and run the conversation.
function forkOrder(harness: Harness): unknown[] {
  return harness.server
    .writtenFrames()
    .map((frame) => frame["method"])
    .filter((method) =>
      ["thread/fork", "thread/unsubscribe", "thread/resume", "turn/start"].includes(String(method)),
    );
}

// An item frame of a command on the session's first conversation, in its first turn.
function commandFrame(method: string, item: Record<string, unknown>): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method,
    params: { threadId: THREAD_ID, turnId: "turn-1", item: { type: "commandExecution", ...item } },
  };
}

// Answers `thread/backgroundTerminals/list` with the commands `running` names at each read.
function answerRunningCommands(harness: Harness, running: () => unknown[]): void {
  harness.server.on("thread/backgroundTerminals/list", () => ({
    result: { data: running(), nextCursor: null },
  }));
}

// The rebind the daemon registers, over `bindings`.
function rebindOn(
  bindings: RuntimeBindingStore,
): NonNullable<HarnessOptions["rebindRuntimeBinding"]> {
  return async (rebind) => {
    await bindings.rebind(rebind);
  };
}

// A binding on the test session's first conversation.
async function createBinding(bindings: RuntimeBindingStore): Promise<string> {
  const binding = await bindings.create({
    runId: RUN_ID,
    driverName: "codex",
    contractVersion: "1.0.0",
    resumeHandle: THREAD_ID,
    spawnConfig: { executionPosture: TEST_POSTURE },
  });
  return binding.id;
}

// A session on its model's larger window, as created from the larger picker row.
async function largerWindowSession(): Promise<Harness> {
  const harness = createHarness();
  harness.server.catalogDump = JSON.stringify({
    models: [
      { slug: TEST_MODEL, context_window: DEFAULT_WINDOW, max_context_window: LARGER_WINDOW },
    ],
  });
  await harness.driver.createSession({ ...CREATE_PARAMS, largerWindow: LARGER_WINDOW });
  answerTurnStarts(harness);
  return harness;
}

describe("a turn moving to the larger window", () => {
  it("forks the conversation onto it before the turn, which runs on the fork", async () => {
    const harness = createHarness();
    await createdSession(harness);
    answerTurnStarts(harness);

    await startRunOnWindow(harness, RUN_ID, { model: TEST_MODEL, largerWindow: LARGER_WINDOW });

    expect(forkOrder(harness)).toEqual(["thread/fork", "thread/unsubscribe", "turn/start"]);
    const [fork] = harness.server.paramsFor("thread/fork");
    expect(fork).toMatchObject({
      threadId: THREAD_ID,
      excludeTurns: true,
      baseInstructions: BASE_INSTRUCTIONS,
    });
    expect(sentContextWindow(harness, "thread/fork")).toBe(LARGER_WINDOW);
    expect(harness.server.paramsFor("turn/start")[0]?.["threadId"]).toBe(forkedThreadId(1));
    expect(harness.server.paramsFor("thread/unsubscribe")).toStrictEqual([{ threadId: THREAD_ID }]);

    harness.server.emitFrame(turnCompletedFrame("turn-1", "completed", forkedThreadId(1)));
    await drainMicrotasks();
    // The fork writes no notice.
    expect(
      deliveriesOf(harness, "session_notice").filter(
        (delivery) => delivery.notice.kind === "conversation_reloaded",
      ),
    ).toStrictEqual([]);
  });

  it("fails the turn with the fork's failure, and the next turn forks again", async () => {
    const harness = createHarness();
    await createdSession(harness);
    answerTurnStarts(harness);
    harness.server.on("thread/fork", () => ({
      error: { code: -32603, message: "fork refused" },
    }));

    await expect(
      startRunOnWindow(harness, RUN_ID, { model: TEST_MODEL, largerWindow: LARGER_WINDOW }),
    ).rejects.toThrow("fork refused");
    // Never on the window the conversation does not run on.
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(0);

    harness.server.on("thread/fork", (params) => threadReply("thread-retried", params));
    await startRunOnWindow(harness, SECOND_RUN_ID, {
      model: TEST_MODEL,
      largerWindow: LARGER_WINDOW,
    });

    expect(harness.server.framesForMethod("thread/fork")).toHaveLength(2);
    expect(sentContextWindow(harness, "thread/fork")).toBe(LARGER_WINDOW);
    expect(harness.server.paramsFor("turn/start")[0]?.["threadId"]).toBe("thread-retried");
  });
});

describe("a fork's conversation across a daemon restart", () => {
  it("is the one the restart resumes, and the one it left is recorded with it", async () => {
    // Resuming the conversation the session moved off would lose every turn since the fork, and
    // an unrecorded one would outlive the session's purge on the provider.
    await withScratchBindingStore(async (bindings, database) => {
      const bindingId = await createBinding(bindings);
      const rebindRuntimeBinding = rebindOn(bindings);
      const beforeRestart = createHarness({ rebindRuntimeBinding });
      await createdSession(beforeRestart);
      answerTurnStarts(beforeRestart);
      await beforeRestart.driver.startRun({
        runId: RUN_ID,
        agentConfig: {
          ...runConfig("go"),
          bindingId,
          model: TEST_MODEL,
          largerWindow: LARGER_WINDOW,
        },
      });
      expect(
        readLeftConversations(database.reader, SESSION_ID).map((left) => [
          left.driverName,
          left.conversationId,
        ]),
      ).toStrictEqual([["codex", THREAD_ID]]);

      // A new daemon over the same database resumes the session from its stored binding.
      const afterRestart = createHarness({ rebindRuntimeBinding });
      afterRestart.server.on("thread/fork", (params) =>
        threadReply("thread-after-restart", params),
      );
      const stored = bindings.findById(bindingId);
      if (stored === undefined) {
        throw new Error("the session's binding row is gone");
      }
      await expect(
        afterRestart.driver.resumeSession(
          composeResumeSessionParams(SESSION_ID, stored, TEST_MODEL, LARGER_WINDOW, "build", {}),
        ),
      ).resolves.toMatchObject({ status: "resumed", resumeHandle: "thread-after-restart" });

      expect(afterRestart.server.paramsFor("thread/fork")[0]?.["threadId"]).toBe(forkedThreadId(1));
    });
  });

  it("is the one the first run's binding names when the fork came before any run", async () => {
    // With no binding yet the fork is recorded by none, so the first run's binding must name it.
    await withScratchBindingStore(async (bindings, database) => {
      const bindingId = await createBinding(bindings);
      const rebindRuntimeBinding = rebindOn(bindings);
      const harness = createHarness({ rebindRuntimeBinding });
      await createdSession(harness);
      answerTurnStarts(harness);
      await harness.driver.updatePermissionLevel({ sessionId: SESSION_ID, level: "yolo" });
      await drainMicrotasks();

      await harness.driver.startRun({
        runId: RUN_ID,
        agentConfig: { ...runConfig("go"), bindingId },
      });

      expect(bindings.findById(bindingId)?.resumeHandle).toBe(forkedThreadId(1));
      expect(
        readLeftConversations(database.reader, SESSION_ID).map((left) => left.conversationId),
      ).toStrictEqual([THREAD_ID]);
    });
  });
});

describe("a level move that changes config `thread/settings/update` cannot carry", () => {
  it("forks an idle conversation at once with the new level's config", async () => {
    // Without it, connector tools keep the old level's approval mode until a crash.
    const harness = createHarness();
    await createdSession(harness);

    await harness.driver.updatePermissionLevel({ sessionId: SESSION_ID, level: "yolo" });
    await drainMicrotasks();

    const forks = harness.server.paramsFor("thread/fork");
    expect(forks).toHaveLength(1);
    expect(forks[0]?.["config"]).toMatchObject({
      "apps._default.default_tools_approval_mode": "approve",
      default_permissions: ":danger-full-access",
    });
    expect(harness.server.framesForMethod("thread/resume")).toHaveLength(0);
  });

  it("forks a busy conversation once its running turn settled", async () => {
    // Forking mid-turn would move the session off the reply the person is reading.
    const harness = createHarness();
    await createdSession(harness);
    answerTurnStarts(harness);
    await startRunOnWindow(harness, RUN_ID);

    await harness.driver.updatePermissionLevel({ sessionId: SESSION_ID, level: "yolo" });
    await drainMicrotasks();
    expect(harness.server.framesForMethod("thread/fork")).toHaveLength(0);

    harness.server.emitFrame(turnCompletedFrame("turn-1", "completed"));
    await drainMicrotasks();
    expect(harness.server.paramsFor("thread/fork").map((params) => params["threadId"])).toEqual([
      THREAD_ID,
    ]);
  });

  it("holds a turn that arrives while the fork runs until the session is on the fork", async () => {
    const harness = createHarness();
    await createdSession(harness);
    answerTurnStarts(harness);
    const releaseFork = harness.server.holdAnswers("thread/fork");
    await harness.driver.updatePermissionLevel({ sessionId: SESSION_ID, level: "yolo" });
    await drainMicrotasks();

    const starting = startRunOnWindow(harness, RUN_ID);
    await drainMicrotasks();
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(0);

    releaseFork();
    await starting;
    expect(harness.server.paramsFor("turn/start")[0]?.["threadId"]).toBe(forkedThreadId(1));
  });
});

describe("the conversation a fork leaves", () => {
  it("keeps a command's row live past the fork, and is let go once the command ends", async () => {
    // Codex unloads a conversation no client holds, and the commands it runs end with it.
    const harness = createHarness();
    await createdSession(harness);
    answerTurnStarts(harness);
    let runningCommands: unknown[] = [{ processId: 7 }];
    answerRunningCommands(harness, () => runningCommands);
    await startRunOnWindow(harness, RUN_ID);
    harness.server.emitFrame(commandFrame("item/started", { id: "command-1" }));
    harness.server.emitFrame(turnCompletedFrame("turn-1", "completed"));
    await drainMicrotasks();

    await harness.driver.updatePermissionLevel({ sessionId: SESSION_ID, level: "yolo" });
    await drainMicrotasks();
    expect(harness.server.paramsFor("thread/backgroundTerminals/list")).toStrictEqual([
      { threadId: THREAD_ID },
    ]);
    expect(harness.server.framesForMethod("thread/unsubscribe")).toHaveLength(0);

    runningCommands = [];
    harness.server.emitFrame(
      commandFrame("item/completed", { id: "command-1", status: "completed" }),
    );
    await drainMicrotasks();
    // The command's end closes the row its start opened, on the run that ran it.
    expect(
      deliveriesOf(harness, "session_row").map((delivery) => [
        delivery.row.type,
        delivery.bindingId,
        delivery.operation,
      ]),
    ).toStrictEqual([
      ["tool.invoked", "binding-abc", { correlationKey: "command-1", isOpening: true }],
      ["tool.result", "binding-abc", { correlationKey: "command-1", isOpening: false }],
    ]);
    expect(harness.server.paramsFor("thread/unsubscribe")).toStrictEqual([{ threadId: THREAD_ID }]);
  });

  it("stays held while its running commands cannot be read", async () => {
    // Letting it go unread would end a command that may still run.
    const harness = createHarness();
    await createdSession(harness);
    let listAnswer: () => JsonRpcAnswer = () => ({
      error: { code: -32603, message: "list unavailable" },
    });
    harness.server.on("thread/backgroundTerminals/list", () => listAnswer());

    await harness.driver.updatePermissionLevel({ sessionId: SESSION_ID, level: "yolo" });
    await drainMicrotasks();
    expect(harness.server.framesForMethod("thread/unsubscribe")).toHaveLength(0);

    listAnswer = () => ({ result: { data: [], nextCursor: null } });
    // A command still running there writes output: the conversation's next frame.
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "item/commandExecution/outputDelta",
      params: { threadId: THREAD_ID, turnId: "turn-1", itemId: "command-1", delta: "ok\n" },
    });
    await drainMicrotasks();
    expect(harness.server.framesForMethod("thread/backgroundTerminals/list")).toHaveLength(2);
    expect(harness.server.paramsFor("thread/unsubscribe")).toStrictEqual([{ threadId: THREAD_ID }]);
  });
});

describe("config changes around a turn", () => {
  it("makes one fork, carrying the last, for two changes during one turn", async () => {
    const harness = createHarness();
    await createdSession(harness);
    answerTurnStarts(harness);
    await startRunOnWindow(harness, RUN_ID);

    await harness.driver.updatePermissionLevel({ sessionId: SESSION_ID, level: "readonly" });
    await harness.driver.updatePermissionLevel({ sessionId: SESSION_ID, level: "yolo" });
    harness.server.emitFrame(turnCompletedFrame("turn-1", "completed"));
    await drainMicrotasks();

    const forks = harness.server.paramsFor("thread/fork");
    expect(forks).toHaveLength(1);
    expect(forks[0]?.["config"]).toMatchObject({ default_permissions: ":danger-full-access" });
  });

  it("starts a turn waiting on a refused start, on the fork owed meanwhile", async () => {
    // A refused start leaves no turn whose end would wake the turn waiting behind it.
    const harness = createHarness();
    await createdSession(harness);
    let started = 0;
    harness.server.on("turn/start", () => {
      started += 1;
      return started === 1
        ? { error: { code: -32600, message: "turn refused" } }
        : { result: { turn: { id: `turn-${started}` } } };
    });
    const releaseStarts = harness.server.holdAnswers("turn/start");
    const refused = startRunOnWindow(harness, RUN_ID);
    await drainMicrotasks();
    await harness.driver.updatePermissionLevel({ sessionId: SESSION_ID, level: "yolo" });
    const waiting = startRunOnWindow(harness, SECOND_RUN_ID);
    await drainMicrotasks();
    expect(harness.server.framesForMethod("thread/fork")).toHaveLength(0);

    releaseStarts();
    await expect(refused).rejects.toThrow("turn refused");
    await waiting;
    expect(harness.server.paramsFor("turn/start")[1]?.["threadId"]).toBe(forkedThreadId(1));
  });
});

describe("a turn on the session's larger window", () => {
  it("moves back to the default window with a fork that sends none", async () => {
    const harness = await largerWindowSession();

    // A model named with no larger window is the model's default window.
    await startRunOnWindow(harness, RUN_ID, { model: TEST_MODEL });

    expect(harness.server.framesForMethod("thread/fork")).toHaveLength(1);
    expect(sentContextWindow(harness, "thread/fork")).toBe("omitted");
  });

  it("keeps the window, forking nothing, for a turn naming neither", async () => {
    const harness = await largerWindowSession();

    await startRunOnWindow(harness, RUN_ID);
    expect(harness.server.framesForMethod("thread/fork")).toHaveLength(0);

    // A later fork still carries the larger window.
    harness.server.emitFrame(turnCompletedFrame("turn-1", "completed"));
    await drainMicrotasks();
    await harness.driver.updatePermissionLevel({ sessionId: SESSION_ID, level: "yolo" });
    await drainMicrotasks();
    expect(sentContextWindow(harness, "thread/fork")).toBe(LARGER_WINDOW);
  });

  it("forks a faster-model retry on the default window", async () => {
    const harness = await largerWindowSession();
    harness.server.on("turn/interrupt", () => ({
      result: {},
      trailingFrames: [turnCompletedFrame("turn-1", "interrupted")],
    }));
    harness.server.on("thread/fork", (params) => threadReply("thread-retried", params));
    await startRunOnWindow(harness, RUN_ID);

    await expect(
      harness.driver.retryTurnOnFasterModel({
        sessionId: SESSION_ID,
        runId: RUN_ID,
        expectedTurnId: "turn-1",
        model: "gpt-5.5-mini",
      }),
    ).resolves.toStrictEqual({ state: "applied" });

    // The faster model runs on its own default window, which the retry's fork carries, so no
    // second fork follows.
    expect(sentContextWindow(harness, "thread/fork")).toBe("omitted");
    expect(harness.server.framesForMethod("thread/fork")).toHaveLength(1);
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(2);
  });
});
