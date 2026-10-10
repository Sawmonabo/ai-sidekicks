// Thread routing and usage metering, driven through the real ingest path: notifications go into
// the fake service's connection and the assertions read what comes out of the driver. A frame
// routed to the wrong transcript leaks one conversation into another, and a misbased meter bills
// spend twice or not at all.

import { describe, expect, it } from "vitest";

import { captureRejection } from "../../../../__fixtures__/capture-failure.js";
import { drainMicrotasks } from "../../../__fixtures__/drain-microtasks.js";
import type { CumulativeAxisReadings } from "../../../usage-delta-accountant.js";
import type { MoveSessionToForkResult } from "../../contract.js";
import {
  announceChildThread,
  CHILD_THREAD_ID,
  childRunId,
  createHarness,
  forkedThreadId,
  type Harness,
  type HarnessOptions,
  RUN_ID,
  runConfig,
  SECOND_RUN_ID,
  SESSION_ID,
  THREAD_ID,
  threadReply,
  TURN_ID,
  turnCompletedFrame,
} from "../__fixtures__/app-server-doubles.js";
import { CodexTransportError } from "../session/errors.js";
import { CREATE_PARAMS, RESUME_PARAMS } from "./lifecycle.test-support.js";

const FORKED_THREAD_ID = "01a04202-0148-7ae2-8560-f04bed000001";

// Per-thread running totals, so `last` is the per-turn figure a real provider would send and the
// accountant's cross-check stays quiet.
const emittedCumulativeByThreadId = new Map<string, number>();

async function driverWithSession(options: HarnessOptions = {}): Promise<Harness> {
  const harness = createHarness(options);
  // A fresh accountant starts its base registers at zero, so the fixture's totals restart with it.
  emittedCumulativeByThreadId.clear();
  await harness.driver.createSession(CREATE_PARAMS);
  return harness;
}

/** Emits one token-usage notification with every axis populated on both `total` and `last`. */
function emitUsage(harness: Harness, threadId: string, totalInputTokens: number): void {
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

function emitTaskList(harness: Harness, threadId: string): void {
  harness.server.emitFrame({
    jsonrpc: "2.0",
    method: "turn/plan/updated",
    params: { threadId, turnId: "child-turn", plan: [] },
  });
}

/** Starts the test run, whose live turn a helper the conversation announces belongs to. */
async function startLeadRun(harness: Harness): Promise<void> {
  harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
  await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("go") });
}

/** The kinds of deliveries made since `from`, each row named by its type. */
function deliveredSince(harness: Harness, from: number): string[] {
  return harness.deliveries
    .slice(from)
    .map((delivery) =>
      delivery.kind === "session_row" ? `${delivery.kind}:${delivery.row.type}` : delivery.kind,
    );
}

function meteredInputs(harness: Harness): Array<{ threadId: string; input: unknown }> {
  return harness.meteredUsage.map((entry) => ({
    threadId: entry.delta.threadId,
    input: entry.delta.axisDeltas.input,
  }));
}

function unroutedThreads(harness: Harness): string[] {
  return harness.diagnostics.flatMap((diagnostic) =>
    diagnostic.kind === "unrouted-thread-frame" ? [diagnostic.threadId] : [],
  );
}

describe("Codex thread routing and usage metering", () => {
  it("never projects a frame naming a thread no session here holds", async () => {
    // A shared service carries other conversations; one of them must not reach this transcript.
    const harness = await driverWithSession();
    const before = harness.deliveries.length;

    emitTaskList(harness, "some-other-session-thread");
    await Promise.resolve();

    expect(deliveredSince(harness, before)).toStrictEqual([]);
    expect(unroutedThreads(harness)).toStrictEqual(["some-other-session-thread"]);
  });

  it("meters a per-turn delta on every axis, never the cumulative counter", async () => {
    const harness = await driverWithSession();

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

  it("writes a helper's own rows on its child run, never the parent's, and meters its spend", async () => {
    const harness = await driverWithSession();
    await startLeadRun(harness);
    const before = harness.deliveries.length;

    announceChildThread(harness, "subAgent");
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: CHILD_THREAD_ID,
        turnId: "child-turn",
        item: { type: "agentMessage", id: "child-reply", text: "Found it in the parser." },
      },
    });
    emitUsage(harness, CHILD_THREAD_ID, 40);
    await drainMicrotasks();

    expect(deliveredSince(harness, before)).toStrictEqual([
      "child_run",
      "session_row:subagent.started",
      "session_row:assistant.message",
    ]);
    // On the run the engine minted for the helper, so its reply never lands on the lead's.
    expect(harness.deliveries.at(-1)).toMatchObject({
      row: { payload: { runId: childRunId(1) } },
      content: { body: "Found it in the parser." },
    });
    expect(meteredInputs(harness)).toEqual([{ threadId: CHILD_THREAD_ID, input: 40 }]);
  });

  it("keeps a re-announced child's usage base rather than re-basing it", async () => {
    const harness = await driverWithSession();

    announceChildThread(harness, "subAgent");
    emitUsage(harness, CHILD_THREAD_ID, 100);
    await Promise.resolve();
    announceChildThread(harness, "subAgent");
    emitUsage(harness, CHILD_THREAD_ID, 150);
    await Promise.resolve();

    // Re-basing would bill 150 instead of 50.
    expect(harness.meteredUsage.map((entry) => entry.delta.axisDeltas.input)).toEqual([100, 50]);
  });

  it("still charges a provider-internal child's spend, with no subagent events", async () => {
    const harness = await driverWithSession();
    await startLeadRun(harness);
    const before = harness.deliveries.length;

    announceChildThread(harness, "compaction");
    emitUsage(harness, CHILD_THREAD_ID, 25);
    await drainMicrotasks();

    expect(deliveredSince(harness, before)).toStrictEqual([]);
    expect(harness.meteredUsage.map((entry) => entry.delta.axisDeltas.input)).toEqual([25]);
  });

  it("keeps a fully suppressed child visible through its started and completed pair", async () => {
    const harness = await driverWithSession();
    await startLeadRun(harness);
    const before = harness.deliveries.length;

    announceChildThread(harness, "subAgentReview");
    emitTaskList(harness, CHILD_THREAD_ID);
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: CHILD_THREAD_ID, turn: { id: "child-turn", status: "completed" } },
    });
    await drainMicrotasks();

    expect(deliveredSince(harness, before)).toStrictEqual([
      "child_run",
      "session_row:subagent.started",
      "session_row:subagent.completed",
      "run_lifecycle",
    ]);
  });

  it("meters only the excess over a reopened session's prior-emitted sum", async () => {
    const harness = createHarness({ readPriorEmittedUsage: () => ({ input: 500 }) });
    emittedCumulativeByThreadId.clear();
    await harness.driver.resumeSession(RESUME_PARAMS);

    // The restart moved the session onto its fork.
    emitUsage(harness, forkedThreadId(1), 520);
    await Promise.resolve();

    expect(harness.meteredUsage[0]?.delta.axisDeltas.input).toBe(20);
  });
});

// `thread/fork` mints a new thread the session continues on, so the router and accountant must
// move to it. A router left on the pre-fork thread sheds every post-rewind frame.
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
  async function meteredSession(): Promise<{ harness: Harness; readerCalls: string[] }> {
    const readerCalls: string[] = [];
    const harness = await driverWithSession({
      readPriorEmittedUsage: (_sessionId, threadId) => {
        readerCalls.push(threadId);
        return threadId === THREAD_ID ? priorEmittedBreakdown(100) : undefined;
      },
    });
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("go") });
    emitUsage(harness, THREAD_ID, 100);
    // A fork through a live turn is refused, so the boundary turn ends first.
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await drainMicrotasks();
    return { harness, readerCalls };
  }

  async function rewind(harness: Harness): Promise<MoveSessionToForkResult> {
    return await harness.driver.moveSessionToFork({
      sessionId: SESSION_ID,
      bindingId: "binding-predecessor",
      position: 1,
    });
  }

  function answerForksWith(harness: Harness, threadId: string): void {
    harness.server.on("thread/fork", (params) => threadReply(threadId, params, 1));
  }

  /** A rewind suspended at its `thread/fork` request, with the answer left to the test. */
  async function rewindSuspendedAtFork(): Promise<{
    harness: Harness;
    rewinding: Promise<MoveSessionToForkResult>;
    answerFork: () => Promise<void>;
  }> {
    const { harness } = await meteredSession();
    answerForksWith(harness, FORKED_THREAD_ID);
    const release = harness.server.holdAnswers("thread/fork");
    const rewinding = rewind(harness);
    await drainMicrotasks();
    expect(harness.server.framesForMethod("thread/fork")).toHaveLength(1);
    return {
      harness,
      rewinding,
      answerFork: async (): Promise<void> => {
        release();
        await drainMicrotasks();
      },
    };
  }

  it("moves routing and metering to the forked thread, from the pre-fork sum", async () => {
    const { harness, readerCalls } = await meteredSession();
    answerForksWith(harness, FORKED_THREAD_ID);

    expect((await rewind(harness)).status).toBe("applied");
    // Keyed on the forked thread the sum resolves to nothing and the session re-bills from zero.
    expect(readerCalls).toStrictEqual([THREAD_ID]);

    emittedCumulativeByThreadId.set(FORKED_THREAD_ID, 100);
    emitUsage(harness, FORKED_THREAD_ID, 150);
    emitTaskList(harness, FORKED_THREAD_ID);
    await Promise.resolve();
    expect(unroutedThreads(harness)).toStrictEqual([]);
    expect(meteredInputs(harness)).toStrictEqual([
      { threadId: THREAD_ID, input: 100 },
      { threadId: FORKED_THREAD_ID, input: 50 },
    ]);
    // The abandoned thread was unsubscribed and let go.
    expect(harness.server.paramsFor("thread/unsubscribe")).toEqual([{ threadId: THREAD_ID }]);

    // A late frame from the abandoned thread never reaches the rewound transcript.
    const before = harness.deliveries.length;
    emitTaskList(harness, THREAD_ID);
    await Promise.resolve();
    expect(deliveredSince(harness, before)).toStrictEqual([]);
    expect(unroutedThreads(harness)).toStrictEqual([THREAD_ID]);
  });

  it("refuses a rewind the provider did not fork, and keeps metering on its thread", async () => {
    // Answered with the thread it was handed: not a fork, so the pre-rewind conversation is lost.
    const { harness, readerCalls } = await meteredSession();
    answerForksWith(harness, THREAD_ID);

    expect(await rewind(harness)).toStrictEqual({
      status: "degraded",
      fallbackAction: "rewind-not-forked",
    });

    expect(readerCalls).toStrictEqual([]);
    emitUsage(harness, THREAD_ID, 150);
    await Promise.resolve();
    expect(meteredInputs(harness)).toStrictEqual([
      { threadId: THREAD_ID, input: 100 },
      { threadId: THREAD_ID, input: 50 },
    ]);
  });

  it("refuses a fork answered with an already-metered thread, leaving both registers", async () => {
    // Adopting a live child would reset the registers carrying its spend.
    const { harness, readerCalls } = await meteredSession();
    announceChildThread(harness, "subAgent");
    await drainMicrotasks();
    answerForksWith(harness, CHILD_THREAD_ID);

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
      harness.driver.startRun({ runId: SECOND_RUN_ID, agentConfig: runConfig("second") }),
    );

    expect(refusal).toBeInstanceOf(CodexTransportError);
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(turnStartsBefore);
    await answerFork();
    await expect(rewinding).resolves.toMatchObject({ status: "applied" });
  });

  it("meters a forked-thread frame held across the fork against the rebind's base", async () => {
    const { harness, rewinding, answerFork } = await rewindSuspendedAtFork();

    // The provider has forked and the new thread is already emitting before the daemon knows it.
    emittedCumulativeByThreadId.set(FORKED_THREAD_ID, 100);
    emitUsage(harness, FORKED_THREAD_ID, 150);
    await drainMicrotasks();
    expect(meteredInputs(harness)).toStrictEqual([{ threadId: THREAD_ID, input: 100 }]);

    await answerFork();
    await expect(rewinding).resolves.toMatchObject({ status: "applied" });

    // Released after the base is established; released before, the reading would be dropped.
    expect(meteredInputs(harness)).toStrictEqual([
      { threadId: THREAD_ID, input: 100 },
      { threadId: FORKED_THREAD_ID, input: 50 },
    ]);
    expect(unroutedThreads(harness)).toStrictEqual([]);
  });
});
