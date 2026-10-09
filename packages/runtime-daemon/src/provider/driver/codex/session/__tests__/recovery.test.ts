// What recovery does with a service's conversations: a move to a new build waits for a busy turn,
// leaves the old service and resumes once that unloaded it, and a reconnect ends the runs of turns
// that ended while the connection was down. A conversation a fork left, held while a command of it
// runs, outlives both: the old service stays up for it, and a reconnect subscribes to it again.

import { describe, expect, it } from "vitest";

import { drainMicrotasks } from "../../../../__fixtures__/drain-microtasks.js";
import {
  createHarness,
  createdSession,
  DEFAULT_CODEX_HOME,
  deliveriesOf,
  type Harness,
  RUN_ID,
  runConfig,
  SESSION_ID,
  THREAD_ID,
  TURN_ID,
  turnCompletedFrame,
} from "../../__fixtures__/app-server-doubles.js";

const BUILD_CHANGE = { fromVersion: "0.161.0", toVersion: "0.162.0" };

/**
 * A session whose level move forked it while a command of its first conversation runs, so the
 * release holds that conversation; the returned function ends the command.
 */
async function sessionHoldingItsFirstConversation(harness: Harness): Promise<() => void> {
  let isCommandRunning = true;
  harness.server.on("thread/backgroundTerminals/list", (params) => ({
    result: {
      data:
        isCommandRunning && (params as Record<string, unknown>)["threadId"] === THREAD_ID
          ? [{ processId: 7 }]
          : [],
      nextCursor: null,
    },
  }));
  await createdSession(harness);
  await harness.driver.updatePermissionLevel({ sessionId: SESSION_ID, level: "yolo" });
  await drainMicrotasks();
  return () => {
    isCommandRunning = false;
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: THREAD_ID,
        turnId: "turn-0",
        item: { type: "commandExecution", id: "command-1" },
      },
    });
  };
}

// The `thread/unsubscribe` requests that let go of the first conversation.
function firstConversationReleases(harness: Harness): unknown[] {
  return harness.server
    .paramsFor("thread/unsubscribe")
    .filter((params) => params["threadId"] === THREAD_ID);
}

describe("a busy session's move to a new build", () => {
  it("waits for the turn, then for the old service to unload it, then resumes once", async () => {
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("go") });

    await harness.driver.moveToProviderBuild(BUILD_CHANGE);
    await drainMicrotasks();
    // Leaving mid-turn would end the person's running reply.
    expect(harness.server.framesForMethod("thread/unsubscribe")).toHaveLength(0);
    expect(harness.server.launchCountFor(DEFAULT_CODEX_HOME)).toBe(2);

    // The old service holds the conversation for its unload delay after the turn ends.
    harness.server.on("thread/read", () => ({ result: { thread: { status: { type: "idle" } } } }));
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await drainMicrotasks();
    expect(harness.server.paramsFor("thread/unsubscribe")).toStrictEqual([{ threadId: THREAD_ID }]);
    // Resumed while the old one still writes it, Codex refuses the new one.
    expect(harness.server.framesForMethod("thread/resume")).toHaveLength(0);

    harness.server.on("thread/read", () => ({
      result: { thread: { status: { type: "notLoaded" } } },
    }));
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "thread/closed",
      params: { threadId: THREAD_ID },
    });
    await drainMicrotasks();

    expect(harness.server.paramsFor("thread/resume").map((params) => params["threadId"])).toEqual([
      THREAD_ID,
    ]);
    expect(harness.relaunched.map((relaunch) => relaunch.result.status)).toEqual(["resumed"]);
    expect(
      deliveriesOf(harness, "session_notice")
        .filter((delivery) => delivery.notice.kind === "provider_updated")
        .map((delivery) => delivery.notice.sessionId),
    ).toStrictEqual([SESSION_ID]);
  });
});

describe("a conversation held for its running command", () => {
  it("keeps the old service up across a build move until the command ends", async () => {
    // Stopping the old service would end the command, and the held entry would never leave.
    const harness = createHarness();
    const endCommand = await sessionHoldingItsFirstConversation(harness);

    await harness.driver.moveToProviderBuild(BUILD_CHANGE);
    await drainMicrotasks();
    expect(harness.relaunched.map((relaunch) => relaunch.result.status)).toEqual(["resumed"]);
    expect(harness.server.runningProcessCount()).toBe(2);
    expect(firstConversationReleases(harness)).toStrictEqual([]);

    endCommand();
    await drainMicrotasks();
    expect(firstConversationReleases(harness)).toStrictEqual([{ threadId: THREAD_ID }]);
    expect(harness.server.runningProcessCount()).toBe(1);
  });

  it("is subscribed to again after a reconnect, and let go once the command ends", async () => {
    // A new connection holds no subscription, so Codex would unload it and end the command.
    const harness = createHarness();
    const endCommand = await sessionHoldingItsFirstConversation(harness);

    harness.server.dropConnections(DEFAULT_CODEX_HOME);
    await drainMicrotasks();
    expect(harness.server.paramsFor("thread/resume")).toContainEqual({
      threadId: THREAD_ID,
      excludeTurns: true,
    });
    expect(firstConversationReleases(harness)).toStrictEqual([]);

    endCommand();
    await drainMicrotasks();
    expect(firstConversationReleases(harness)).toStrictEqual([{ threadId: THREAD_ID }]);
  });
});

describe("a reconnect to a service that kept running", () => {
  it("ends the run of a turn that ended while the connection was down", async () => {
    // Codex sends no `turn/completed` again, so the run would stay open for good.
    const harness = createHarness();
    await createdSession(harness);
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("go") });
    harness.server.on("thread/turns/list", () => ({
      result: {
        // A listed turn carries its status; its items are not loaded.
        data: [{ id: TURN_ID, status: "completed", items: [] }],
        nextCursor: null,
      },
    }));

    harness.server.dropConnections(DEFAULT_CODEX_HOME);
    await drainMicrotasks();

    expect(
      deliveriesOf(harness, "run_lifecycle").map((delivery) => [
        delivery.change.runId,
        delivery.change.newState,
      ]),
    ).toStrictEqual([[RUN_ID, "completed"]]);
    // Nothing restarted, so nothing says so.
    expect(harness.driverDiagnostics.recentRecordsOfKind("provider_restarted")).toStrictEqual([]);
  });
});
