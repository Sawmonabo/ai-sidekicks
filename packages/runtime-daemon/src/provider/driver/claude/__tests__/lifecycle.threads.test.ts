// `lifecycle.ts` threads: inbound frames routed to the right thread and metered once as per-turn
// deltas, child subagents kept off the parent's transcript, a reply stored as it streams, and text
// naming no message recorded.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { describe, expect, it, vi } from "vitest";

import type { ThreadFrameRoute } from "../../../thread-frame-router.js";
import type { MeteredUsageDelta } from "../../../usage-delta-accountant.js";
import type { ClaudeSessionLifecycleDependencies } from "../session/state.js";
import {
  type FakeClaudeProviderProcess,
  TEST_PINNED_PROVIDER_SESSION_ID,
  TEST_RUN_ID,
  TEST_SESSION_ID,
} from "../__fixtures__/transport-doubles.js";
import {
  buildHarness,
  createLiveSession,
  openGate,
  resumeTestSession,
  rewindTestSession,
  SANDBOXED_POSTURE,
  spawnedChannel,
  startLiveRun,
  type LifecycleHarness,
} from "./lifecycle.test-support.js";

const CHILD_SUBAGENT_ID = "subagent-7";

interface RoutingHarness extends LifecycleHarness {
  readonly meteredUsage: { sessionId: SessionId; delta: MeteredUsageDelta }[];
  readonly releasedRoutes: ThreadFrameRoute[];
}

function buildRoutingHarness(
  overrides: Partial<ClaudeSessionLifecycleDependencies> = {},
): RoutingHarness {
  const meteredUsage: RoutingHarness["meteredUsage"] = [];
  const releasedRoutes: ThreadFrameRoute[] = [];
  const harness = buildHarness({
    onMeteredUsage: (sessionId, delta) => meteredUsage.push({ sessionId, delta }),
    onReleasedFrameRoute: (_sessionId, _observation, route) => releasedRoutes.push(route),
    ...overrides,
  });
  return Object.assign(harness, { meteredUsage, releasedRoutes });
}

// The helper rows the lifecycle delivered on the lead run, by type.
function subagentRowTypes(harness: RoutingHarness): string[] {
  return harness.deliveries.flatMap((delivery) =>
    delivery.kind === "session_row" && delivery.row.type.startsWith("subagent.")
      ? [delivery.row.type]
      : [],
  );
}

function meteredInput(harness: RoutingHarness): (number | undefined)[] {
  return harness.meteredUsage.map((entry) => entry.delta.axisDeltas.input);
}

// A frame carrying the provider's running input-token total for one thread.
function usageObservation(
  totalInputTokens: number,
  subagentId: string | null = null,
): Parameters<FakeClaudeProviderProcess["emitStreamFrame"]>[1] {
  return {
    subagentId,
    cumulativeUsage: { namedTurnId: "turn-A", cumulative: { input: totalInputTokens } },
  };
}

function announceChild(channel: FakeClaudeProviderProcess): void {
  channel.emitStreamFrame("system/task_started", {
    subagentLifecycle: {
      signal: "SubagentStart",
      subagentId: CHILD_SUBAGENT_ID,
      parentToolUseId: "toolu_parent",
    },
  });
}

function announceChildStop(channel: FakeClaudeProviderProcess): void {
  // The helper's end arrives on the lead's own thread, which names no helper.
  channel.emitStreamFrame("system/task_notification", {
    subagentLifecycle: {
      signal: "SubagentStop",
      subagentId: CHILD_SUBAGENT_ID,
      parentToolUseId: "toolu_parent",
    },
  });
}

describe("ClaudeSessionLifecycle thread routing and usage metering", () => {
  it("never projects a frame naming a thread nobody announced", async () => {
    const harness = buildRoutingHarness();
    const channel = await createLiveSession(harness);

    const route = channel.emitStreamFrame("system/task_progress", {
      subagentId: "some-unannounced-subagent",
    });

    expect(route.decision).toBe("held-pending-registration");
    expect(channel.deliveredFrameKinds).toStrictEqual([]);
  });

  it("meters a per-turn delta, never the provider's cumulative counter", async () => {
    // The provider reports a running total that never resets: 150 is the session's whole spend,
    // 50 is what the second turn cost.
    const harness = buildRoutingHarness();
    const channel = await createLiveSession(harness);

    channel.emitStreamFrame("system/task_progress", usageObservation(100));
    channel.emitStreamFrame("system/task_progress", usageObservation(150));

    expect(meteredInput(harness)).toEqual([100, 50]);
  });

  it("keeps a child's content off the parent's transcript while metering its spend", async () => {
    const harness = buildRoutingHarness();
    const channel = await startLiveRun(harness);

    announceChild(channel);
    const contentRoute = channel.emitStreamFrame("system/task_progress", {
      subagentId: CHILD_SUBAGENT_ID,
    });
    channel.emitStreamFrame("system/task_progress", usageObservation(40, CHILD_SUBAGENT_ID));
    announceChildStop(channel);

    expect(contentRoute.decision).toBe("child-transcript");
    // Only the start and stop announcements on the lead's thread reach the consumer.
    expect(channel.deliveredFrameKinds).toStrictEqual([
      "system/task_started",
      "system/task_notification",
    ]);
    expect(harness.meteredUsage).toMatchObject([
      { delta: { threadId: CHILD_SUBAGENT_ID, axisDeltas: { input: 40 } } },
    ]);
    // The started/completed pair is the suppressed child's whole presence.
    expect(subagentRowTypes(harness)).toEqual(["subagent.started", "subagent.completed"]);
  });

  it("keeps a child's usage base across a duplicate announcement", async () => {
    // Re-basing on the repeat would meter 150 instead of the 50 the child spent since.
    const harness = buildRoutingHarness();
    const channel = await startLiveRun(harness);

    announceChild(channel);
    channel.emitStreamFrame("system/task_progress", usageObservation(100, CHILD_SUBAGENT_ID));
    announceChild(channel);
    channel.emitStreamFrame("system/task_progress", usageObservation(150, CHILD_SUBAGENT_ID));

    expect(meteredInput(harness)).toEqual([100, 50]);
    expect(subagentRowTypes(harness)).toEqual(["subagent.started"]);
  });

  it("meters and delivers a child's frame that raced its announcement", async () => {
    const harness = buildRoutingHarness();
    const channel = await createLiveSession(harness);

    const heldRoute = channel.emitStreamFrame(
      "system/task_progress",
      usageObservation(40, CHILD_SUBAGENT_ID),
    );
    expect(heldRoute.decision).toBe("held-pending-registration");
    expect(harness.meteredUsage).toStrictEqual([]);
    announceChild(channel);

    // Charged on release rather than shed at the hold timeout, and the decision reaches a
    // consumer because no observer call is in flight to answer.
    expect(meteredInput(harness)).toEqual([40]);
    expect(harness.releasedRoutes).toEqual([
      {
        decision: "carve-out-usage",
        childThreadId: CHILD_SUBAGENT_ID,
        attribution: { kind: "subagent", subagentId: CHILD_SUBAGENT_ID },
      },
    ]);
  });

  it("delivers a child's tool-approval ask, which the provider blocks on", async () => {
    // Asks ride the connection-level control channel; withholding one would hang the child.
    const harness = buildRoutingHarness();
    const channel = await createLiveSession(harness);
    announceChild(channel);

    const route = channel.emitStreamFrame("control_request/can_use_tool", {
      subagentId: CHILD_SUBAGENT_ID,
    });

    expect(route.decision).toBe("route-connection-scoped");
    expect(channel.deliveredFrameKinds).toContain("control_request/can_use_tool");
  });

  it("routes the predecessor's frames during a rewind and quarantines them after it", async () => {
    // Quarantining during the fork would hole the transcript of a session that continues if the
    // fork fails; projecting after would let an undead process write into a slot it lost.
    const harness = buildRoutingHarness();
    const predecessorChannel = await createLiveSession(harness);
    const { gate, release } = openGate();
    harness.transport.establishmentGate = gate;
    harness.transport.announcedForkedProviderSessionId = "forked-provider-session";

    const rollback = rewindTestSession(harness);
    await Promise.resolve();
    const duringRewind = predecessorChannel.emitStreamFrame(
      "system/task_progress",
      usageObservation(30),
    );
    release();
    expect((await rollback).status).toBe("applied");
    const afterRewind = predecessorChannel.emitStreamFrame(
      "system/task_progress",
      usageObservation(60),
    );

    expect(duringRewind.decision).toBe("project");
    expect(afterRewind.decision).toBe("quarantined");
    expect(meteredInput(harness)).toEqual([30]);
  });

  it("leaves the predecessor routing and metering across a rewind that fails", async () => {
    const harness = buildRoutingHarness();
    const predecessorChannel = await createLiveSession(harness);
    const { gate, release } = openGate();
    harness.transport.establishmentGate = gate;
    harness.transport.rewindFailure = new Error("the provider refused the rewind");

    const rollback = rewindTestSession(harness);
    await Promise.resolve();
    predecessorChannel.emitStreamFrame("system/task_progress", usageObservation(30));
    release();
    expect((await rollback).status).toBe("degraded");
    predecessorChannel.emitStreamFrame("system/task_progress", usageObservation(75));

    expect(meteredInput(harness)).toEqual([30, 45]);
  });

  it("quarantines a frame from a channel the session no longer holds; meters nothing", async () => {
    const harness = buildRoutingHarness();
    const staleChannel = await createLiveSession(harness);
    await harness.lifecycle.closeSession({ sessionId: TEST_SESSION_ID });

    // The driver holds no kill, so a disowned process can still emit.
    const route = staleChannel.emitStreamFrame("system/task_progress", usageObservation(9_999));

    expect(route.decision).toBe("quarantined");
    expect(harness.meteredUsage).toStrictEqual([]);
    expect(staleChannel.deliveredFrameKinds).toStrictEqual([]);
  });

  it("meters only the excess over the sum already emitted before a resume", async () => {
    const harness = buildRoutingHarness({ readPriorEmittedUsage: () => ({ input: 500 }) });
    await resumeTestSession(harness, { executionPosture: SANDBOXED_POSTURE });

    spawnedChannel(harness).emitStreamFrame("system/task_progress", usageObservation(520));

    expect(meteredInput(harness)).toEqual([20]);
  });

  it("bases a rewind on the predecessor's emitted sum, not the fork's new thread id", async () => {
    // Only the predecessor's id has a sum, so a lookup keyed by the fork's id would charge 520.
    const harness = buildRoutingHarness({
      readPriorEmittedUsage: (_sessionId, threadId) =>
        threadId === TEST_PINNED_PROVIDER_SESSION_ID ? { input: 500 } : undefined,
    });
    await createLiveSession(harness);
    harness.transport.announcedForkedProviderSessionId = "forked-provider-session";
    expect((await rewindTestSession(harness)).status).toBe("applied");

    spawnedChannel(harness, 1).emitStreamFrame("system/task_progress", usageObservation(520));

    expect(meteredInput(harness)).toEqual([20]);
  });

  // When the sum already emitted before a resume cannot be read, the first reading re-meters the
  // pre-resume total; the record is the only trace of that overcharge. A throwing reader sits
  // inside the adoption window, so it must not escape and orphan the resumed process.
  it.each<{ label: string; overrides: Partial<ClaudeSessionLifecycleDependencies> }>([
    { label: "no reader is bound", overrides: {} },
    {
      label: "the reader throws",
      overrides: {
        readPriorEmittedUsage: () => {
          throw new Error("the event store was unreachable");
        },
      },
    },
  ])("resumes and records the overcharge when $label", async ({ overrides }) => {
    const harness = buildRoutingHarness(overrides);

    const result = await resumeTestSession(harness, { executionPosture: SANDBOXED_POSTURE });

    expect(result.status).toBe("resumed");
    expect(harness.diagnostics.recentRecordsOfKind("usage_resume_base_unavailable")).toHaveLength(
      1,
    );
  });
});

describe("ClaudeSessionLifecycle assistant text", () => {
  it("stores a reply's streamed pieces before its assistant frame, which adds only the rest", async () => {
    const harness = buildHarness();
    const channel = await startLiveRun(harness);
    channel.emitStreamFrame("system/status");
    const streamEvent = (event: Record<string, unknown>): void => {
      channel.emitStreamFrame("stream_event", undefined, {
        type: "stream_event",
        api_message_id: "msg-streamed",
        parent_tool_use_id: null,
        event,
      });
    };
    const replyRows = () =>
      harness.deliveries.flatMap((delivery) =>
        delivery.kind === "session_row" && delivery.row.type === "assistant.message"
          ? [{ payload: delivery.row.payload, body: delivery.content?.body }]
          : [],
      );
    const textDelta = (text: string) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    });

    streamEvent({ type: "message_start", message: { id: "msg-streamed" } });
    streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } });
    streamEvent(textDelta("Streamed "));
    streamEvent(textDelta("first"));
    // In the event log while the block is still being written.
    await vi.waitFor(() => {
      expect(replyRows().map((row) => row.body)).toStrictEqual(["Streamed first"]);
    });

    channel.emitStreamFrame("assistant", undefined, {
      type: "assistant",
      uuid: "wire-streamed",
      message: {
        id: "msg-streamed",
        content: [{ type: "text", text: "Streamed first, then the rest." }],
      },
    });
    streamEvent({ type: "content_block_stop", index: 0 });

    await vi.waitFor(() => {
      expect(replyRows().map((row) => row.body)).toStrictEqual([
        "Streamed first",
        ", then the rest.",
      ]);
    });
    expect(replyRows().map((row) => row.payload.providerMessageId)).toStrictEqual([
      "msg-streamed",
      "msg-streamed",
    ]);
  });

  // Text the provider sent is never lost: Claude Code keys a message with no id by the frame.
  it("writes text naming no message under the frame's own id", async () => {
    const harness = buildHarness();
    const channel = await startLiveRun(harness);
    channel.emitStreamFrame("system/status");

    channel.emitStreamFrame("assistant", undefined, {
      type: "assistant",
      uuid: "wire-unnamed",
      message: { content: [{ type: "text", text: "no message names this" }] },
    });

    await vi.waitFor(() => {
      expect(
        harness.deliveries.flatMap((delivery) =>
          delivery.kind === "session_row" && delivery.row.type === "assistant.message"
            ? [{ payload: delivery.row.payload, content: delivery.content }]
            : [],
        ),
      ).toMatchObject([
        {
          payload: { runId: TEST_RUN_ID, providerMessageId: "wire-unnamed" },
          content: { body: "no message names this" },
        },
      ]);
    });
  });
});
