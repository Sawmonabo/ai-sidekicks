// Thread routing and usage metering, driven through the real ingest path: raw JSON-RPC
// notifications go into the fake provider's byte channel and the assertions read what comes out of
// the manager. A frame routed to the wrong transcript leaks one conversation into another, and a
// misbased meter bills spend twice or not at all.

import { describe, expect, it } from "vitest";

import type { CumulativeAxisReadings } from "../../../usage-delta-accountant.js";
import { CodexTransportError, type CodexLifecycleManager } from "../index.js";
import {
  type ManagerHarness,
  type ManagerHarnessOptions,
  RUN_ID,
  SECOND_RUN_ID,
  SESSION_ID,
  THREAD_ID,
  TURN_ID,
  createManagerHarness,
  threadStartResult,
  turnCompletedFrame,
} from "./codex-test-doubles.js";
import { CREATE_PARAMS, RESUME_PARAMS } from "./lifecycle.test-support.js";
import { captureRejection } from "../../../../__fixtures__/capture-failure.js";
import { drainMicrotasks } from "../../../__fixtures__/drain-microtasks.js";

const CHILD_THREAD_ID = "01a04202-0148-7ae2-8560-child0000001";
const FORKED_THREAD_ID = "01a04202-0148-7ae2-8560-f04bed000001";

// Per-thread running totals, so `last` is the per-turn figure a real provider would send and the
// accountant's cross-check stays quiet.
const emittedCumulativeByThreadId = new Map<string, number>();

async function managerWithSession(
  options: ManagerHarnessOptions = { onServerNotification: true },
): Promise<ManagerHarness> {
  const harness = createManagerHarness(options);
  // A fresh accountant starts its base registers at zero, so the fixture's totals restart with it.
  emittedCumulativeByThreadId.clear();
  await harness.manager.createSession(CREATE_PARAMS);
  return harness;
}

/** Emits one token-usage notification with every axis populated on both `total` and `last`. */
function emitUsage(harness: ManagerHarness, threadId: string, totalInputTokens: number): void {
  const priorCumulative = emittedCumulativeByThreadId.get(threadId) ?? 0;
  emittedCumulativeByThreadId.set(threadId, totalInputTokens);
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
      turnId: TURN_ID,
      tokenUsage: {
        total: breakdown(totalInputTokens),
        last: breakdown(totalInputTokens - priorCumulative),
      },
    },
  });
}

function emitQueueChanged(harness: ManagerHarness, threadId: string): void {
  harness.server.emitFrame({
    jsonrpc: "2.0",
    method: "thread/queue/changed",
    params: { threadId },
  });
}

function announceChild(harness: ManagerHarness, threadSourceKind: string): void {
  harness.server.emitFrame({
    jsonrpc: "2.0",
    method: "thread/started",
    params: { thread: { id: CHILD_THREAD_ID, parentThreadId: THREAD_ID, threadSourceKind } },
  });
}

function meteredInputs(harness: ManagerHarness): Array<{ threadId: string; input: unknown }> {
  return harness.meteredUsage.map((entry) => ({
    threadId: entry.delta.threadId,
    input: entry.delta.axisDeltas.input,
  }));
}

function heldFrameCount(harness: ManagerHarness): number {
  return harness.manager.frameRouterFor(SESSION_ID).pendingHeldFrameCount();
}

describe("Codex thread routing and usage metering", () => {
  it("holds a frame naming a foreign thread instead of projecting it", async () => {
    // An unannounced thread may be a child racing its announcement, or another session entirely.
    const harness = await managerWithSession();

    emitQueueChanged(harness, "some-other-session-thread");
    await Promise.resolve();

    expect(harness.notifications).toStrictEqual([]);
    expect(heldFrameCount(harness)).toBe(1);
  });

  it("meters a per-turn delta on every axis, never the cumulative counter", async () => {
    const harness = await managerWithSession();

    emitUsage(harness, THREAD_ID, 100);
    emitUsage(harness, THREAD_ID, 150);
    await Promise.resolve();

    // The wire reports a running total (100, then 150); the daemon must meter 100, then 50.
    expect(meteredInputs(harness)).toEqual([
      { threadId: THREAD_ID, input: 100 },
      { threadId: THREAD_ID, input: 50 },
    ]);
    // An axis spelled outside the accountant's closed union is refused and would go unbilled.
    expect(Object.keys(harness.meteredUsage[1]?.delta.axisDeltas ?? {}).sort()).toEqual([
      "cacheWriteInput",
      "cachedInput",
      "input",
      "output",
      "reasoningOutput",
      "total",
    ]);
  });

  it("keeps a subagent's content off the parent transcript while metering its spend", async () => {
    const harness = await managerWithSession();

    announceChild(harness, "subAgent");
    emitQueueChanged(harness, CHILD_THREAD_ID);
    emitUsage(harness, CHILD_THREAD_ID, 40);
    await Promise.resolve();

    expect(harness.notifications).toStrictEqual([]);
    expect(harness.subagentLifecycle.map((entry) => entry.emission.eventType)).toEqual([
      "subagent.started",
    ]);
    expect(meteredInputs(harness)).toEqual([{ threadId: CHILD_THREAD_ID, input: 40 }]);
  });

  it("keeps a re-announced child's usage base rather than re-basing it", async () => {
    const harness = await managerWithSession();

    announceChild(harness, "subAgent");
    emitUsage(harness, CHILD_THREAD_ID, 100);
    await Promise.resolve();
    announceChild(harness, "subAgent");
    emitUsage(harness, CHILD_THREAD_ID, 150);
    await Promise.resolve();

    // Re-basing would bill 150 instead of 50.
    expect(harness.meteredUsage.map((entry) => entry.delta.axisDeltas.input)).toEqual([100, 50]);
  });

  it("still charges a provider-internal child's spend, with no subagent events", async () => {
    const harness = await managerWithSession();

    announceChild(harness, "compaction");
    emitUsage(harness, CHILD_THREAD_ID, 25);
    await Promise.resolve();

    expect(harness.subagentLifecycle).toStrictEqual([]);
    expect(harness.meteredUsage.map((entry) => entry.delta.axisDeltas.input)).toEqual([25]);
  });

  it(
    "keeps a fully suppressed child visible through " +
      "its started/completed pair and releases it",
    async () => {
      const harness = await managerWithSession();

      announceChild(harness, "subAgentReview");
      emitQueueChanged(harness, CHILD_THREAD_ID);
      harness.server.emitFrame({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId: CHILD_THREAD_ID, turn: { id: "child-turn", status: "completed" } },
      });
      await Promise.resolve();

      expect(harness.notifications).toStrictEqual([]);
      expect(harness.subagentLifecycle.map((entry) => entry.emission.eventType)).toEqual([
        "subagent.started",
        "subagent.completed",
      ]);
      // The child's registers go with its terminal rather than accumulating per child.
      expect(harness.manager.usageAccountantFor(SESSION_ID).hasThread(CHILD_THREAD_ID)).toBe(false);
    },
  );

  it("meters only the excess over a resumed session's prior-emitted sum", async () => {
    const harness = createManagerHarness({
      onServerNotification: true,
      readPriorEmittedUsage: () => ({ input: 500 }),
    });
    harness.server.on("thread/resume", () => threadStartResult(1));
    await harness.manager.resumeSession(RESUME_PARAMS);

    emitUsage(harness, THREAD_ID, 520);
    await Promise.resolve();

    expect(harness.meteredUsage[0]?.delta.axisDeltas.input).toBe(20);
  });

  it("releases the session's router and accountant on close", async () => {
    const harness = await managerWithSession();
    emitUsage(harness, THREAD_ID, 10);
    await Promise.resolve();

    await harness.manager.closeSession({ sessionId: SESSION_ID });

    // The accessor creates on demand, so an empty thread proves the old accountant did not survive.
    expect(harness.manager.usageAccountantFor(SESSION_ID).hasThread(THREAD_ID)).toBe(false);
    expect(heldFrameCount(harness)).toBe(0);
  });
});

// `thread/fork` mints a new thread the session continues on, so the router and accountant must
// move to it. A router left on the pre-fork thread holds then sheds every post-rewind frame.
describe("Codex rewind rebind", () => {
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

  /** A session with one finished, metered turn, whose prior-emitted reader records its lookups. */
  async function meteredSession(): Promise<{
    harness: ManagerHarness;
    readerCalls: string[];
  }> {
    const readerCalls: string[] = [];
    const harness = await managerWithSession({
      onServerNotification: true,
      readPriorEmittedUsage: (_sessionId, threadId) => {
        readerCalls.push(threadId);
        return threadId === THREAD_ID ? priorEmittedBreakdown(100) : undefined;
      },
    });
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.manager.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "go" },
    });
    emitUsage(harness, THREAD_ID, 100);
    // A fork through a live turn is refused, so the boundary turn ends first.
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await drainMicrotasks();
    return { harness, readerCalls };
  }

  function rewind(harness: ManagerHarness): ReturnType<CodexLifecycleManager["forkConversation"]> {
    return harness.manager.forkConversation({
      sessionId: SESSION_ID,
      bindingId: "binding-predecessor",
      position: 1,
    });
  }

  function forkAnswer(threadId: string): Record<string, unknown> {
    return { thread: { id: threadId, sessionId: "session-tree-1", turns: [{ id: TURN_ID }] } };
  }

  /** A rewind suspended at its `thread/fork` request, with the answer left to the test. */
  async function rewindSuspendedAtFork(): Promise<{
    harness: ManagerHarness;
    rewinding: ReturnType<CodexLifecycleManager["forkConversation"]>;
    answerFork: () => Promise<void>;
  }> {
    const { harness } = await meteredSession();
    const rewinding = rewind(harness);
    await drainMicrotasks();
    expect(harness.server.framesForMethod("thread/fork")).toHaveLength(1);
    return {
      harness,
      rewinding,
      answerFork: async (): Promise<void> => {
        harness.server.emitFrame({
          jsonrpc: "2.0",
          id: harness.server.framesForMethod("thread/fork")[0]?.["id"],
          result: forkAnswer(FORKED_THREAD_ID),
        });
        await drainMicrotasks();
      },
    };
  }

  it("moves routing and metering to the forked thread, from the pre-fork sum", async () => {
    const { harness, readerCalls } = await meteredSession();
    harness.server.on("thread/fork", () => ({ result: forkAnswer(FORKED_THREAD_ID) }));

    expect((await rewind(harness)).status).toBe("applied");
    // Keyed on the forked thread the sum resolves to nothing and the session re-bills from zero.
    expect(readerCalls).toStrictEqual([THREAD_ID]);

    emittedCumulativeByThreadId.set(FORKED_THREAD_ID, 100);
    emitUsage(harness, FORKED_THREAD_ID, 150);
    emitQueueChanged(harness, FORKED_THREAD_ID);
    await Promise.resolve();
    expect(harness.notifications.map((entry) => entry.method)).toContain("thread/queue/changed");
    expect(heldFrameCount(harness)).toBe(0);
    expect(meteredInputs(harness)).toStrictEqual([
      { threadId: THREAD_ID, input: 100 },
      { threadId: FORKED_THREAD_ID, input: 50 },
    ]);

    // A late frame from the abandoned thread waits instead of projecting into the rewound
    // transcript.
    const projectedBeforeStaleFrame = harness.notifications.length;
    emitQueueChanged(harness, THREAD_ID);
    await Promise.resolve();
    expect(harness.notifications).toHaveLength(projectedBeforeStaleFrame);
    expect(heldFrameCount(harness)).toBe(1);
  });

  it("refuses a rewind the provider did not fork, and keeps metering on its thread", async () => {
    // Answered with the thread it was handed: not a fork, so the pre-rewind conversation is lost.
    const { harness, readerCalls } = await meteredSession();
    harness.server.on("thread/fork", () => ({ result: forkAnswer(THREAD_ID) }));

    expect(await rewind(harness)).toStrictEqual({
      status: "degraded",
      fallbackAction: "rewind-not-forked",
    });

    expect(readerCalls).toStrictEqual([]);
    emitUsage(harness, THREAD_ID, 150);
    await Promise.resolve();
    expect(heldFrameCount(harness)).toBe(0);
    expect(meteredInputs(harness)).toStrictEqual([
      { threadId: THREAD_ID, input: 100 },
      { threadId: THREAD_ID, input: 50 },
    ]);
  });

  it("refuses a fork answered with an already-metered thread, leaving both registers", async () => {
    // Adopting a live child would reset the registers carrying its spend.
    const { harness, readerCalls } = await meteredSession();
    announceChild(harness, "subAgent");
    await drainMicrotasks();
    harness.server.on("thread/fork", () => ({ result: forkAnswer(CHILD_THREAD_ID) }));

    expect(await rewind(harness)).toStrictEqual({
      status: "degraded",
      fallbackAction: "rewind-target-thread-already-registered",
    });

    expect(readerCalls).toStrictEqual([]);
    emitUsage(harness, CHILD_THREAD_ID, 40);
    emitUsage(harness, THREAD_ID, 150);
    await drainMicrotasks();
    expect(meteredInputs(harness)).toStrictEqual([
      { threadId: THREAD_ID, input: 100 },
      { threadId: CHILD_THREAD_ID, input: 40 },
      { threadId: THREAD_ID, input: 50 },
    ]);
  });

  it("refuses a turn dispatched while the fork is in flight", async () => {
    // Accepted, it would run on the pre-fork thread and every frame it produced would be shed,
    // though the caller was told the turn started.
    const { harness, rewinding, answerFork } = await rewindSuspendedAtFork();
    const turnStartsBefore = harness.server.framesForMethod("turn/start").length;

    const refusal = await captureRejection(
      harness.manager.startRun({
        runId: SECOND_RUN_ID,
        agentConfig: { sessionId: SESSION_ID, input: "second" },
      }),
    );

    expect(refusal).toBeInstanceOf(CodexTransportError);
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(turnStartsBefore);
    expect(harness.manager.hasActiveTurn(SECOND_RUN_ID)).toBe(false);
    await answerFork();
    await expect(rewinding).resolves.toMatchObject({ status: "applied" });
  });

  it(
    "meters a forked-thread frame held across the " +
      "fork against the base the rebind establishes",
    async () => {
      const { harness, rewinding, answerFork } = await rewindSuspendedAtFork();

      // The provider has forked and the new thread is already emitting before the daemon knows it.
      emittedCumulativeByThreadId.set(FORKED_THREAD_ID, 100);
      emitUsage(harness, FORKED_THREAD_ID, 150);
      await drainMicrotasks();
      expect(heldFrameCount(harness)).toBe(1);

      await answerFork();
      await expect(rewinding).resolves.toMatchObject({ status: "applied" });

      // Released after the base is established; released before, the reading would be dropped.
      expect(heldFrameCount(harness)).toBe(0);
      expect(meteredInputs(harness)).toStrictEqual([
        { threadId: THREAD_ID, input: 100 },
        { threadId: FORKED_THREAD_ID, input: 50 },
      ]);
    },
  );
});
