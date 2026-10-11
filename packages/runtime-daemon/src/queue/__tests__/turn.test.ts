// A person's turn end to end, with the run queue wired as the daemon wires it: over a real
// database, event log, run engine and inbound dispatch, through the `run.*` methods, onto each
// provider's real driver over its fake process. A send is written whole, starts a run whose turn
// carries the message, ends `completed` on the provider's own end and is streamed so; a message
// sent mid-turn reaches Claude Code at once and Codex only at its next tool boundary.

import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { JsonRpcNotification } from "@ai-sidekicks/contracts/jsonrpc/message";
import {
  SUBSCRIPTION_NOTIFY_METHOD,
  type SubscriptionNotifyParams,
} from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { RunStateStreamEvent, RunStateStreamFrame } from "@ai-sidekicks/contracts/run/control";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { QueueItemCreateResponse, QueueItemId } from "@ai-sidekicks/contracts/run/queue";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { DeviceIdSchema } from "@ai-sidekicks/contracts/trust-statement";

import { registerRunQueueMethods } from "../../ipc/handlers/run/queue.js";
import { registerRunStateSubscribe, RunSafetyHolds } from "../../ipc/handlers/run/state.js";
import type { OutboundQueue } from "../../ipc/handlers/session/subscribe.js";
import { MethodRegistryImpl } from "../../ipc/registry.js";
import { StreamingPrimitive } from "../../ipc/streaming-primitive.js";
import {
  DriverDiagnosticsEmitter,
  type DriverDiagnosticRecord,
} from "../../provider/driver/diagnostics.js";
import { FakeAttachmentResolver } from "../../provider/driver/__fixtures__/attachment-doubles.js";
import { ClaudeDriver } from "../../provider/driver/claude/index.js";
import {
  buildHarness,
  spawnedChannel,
  type LifecycleHarness,
} from "../../provider/driver/claude/__tests__/lifecycle.test-support.js";
import {
  createHarness,
  THREAD_ID,
  TURN_ID,
  turnCompletedFrame,
  type Harness,
} from "../../provider/driver/codex/__fixtures__/app-server-doubles.js";
import type { ProviderDriver } from "../../provider/driver/contract.js";
import { PortRegistration } from "../../provider/port/registration.js";
import type { RunStatePublisher } from "../../provider/port/run-state-publisher.js";
import { RuntimeBindingStore } from "../../provider/runtime-binding-store.js";
import { bindingStoreWithCursors, RunBindingCursors } from "../../session/run/binding-cursors.js";
import { ExecutionEpochs } from "../../session/run/epochs.js";
import type { RunEngine } from "../../session/run/engine.js";
import { RunInboundDispatch } from "../../session/run/inbound.js";
import {
  openRunEngineFixture,
  TEST_EXECUTION_POSTURE,
  type RunEngineFixture,
} from "../../session/run/__tests__/engine.test-support.js";
import { ProviderSessions } from "../provider-session.js";
import { RunQueue } from "../service.js";
import { QueueItemReader, type QueueItemRecord } from "../store.js";

import { openUnspacedMemoryGate } from "./service.test-support.js";

const GIBIBYTE = 1024 * 1024 * 1024;
const TRANSPORT_ID = 1;
const ALWAYS_ROOM: OutboundQueue = { isFull: () => false, onceDrained: () => () => undefined };

/** A driver as the daemon holds it: the contract, and the read of its session's process id. */
type TurnDriver = ProviderDriver & Pick<ClaudeDriver, "readProcessId">;

/** What a provider's driver is built over: the run engine, its inbound dispatch, and the queue. */
interface DriverWiring {
  readonly engine: RunEngine;
  readonly inbound: RunInboundDispatch;
  /** The queue the driver is wired to, built once the driver is. */
  readonly queue: () => RunQueue;
}

/** The queue, the engine under it, and what the `run.*` methods answered and streamed. */
interface TurnFixture {
  readonly engine: RunEngineFixture;
  readonly queue: RunQueue;
  readonly serviceLog: string[];
  /** Every diagnostic the inbound dispatch recorded. */
  readonly diagnosticRecords: DriverDiagnosticRecord[];
  /** Sends `content` through `run.queueCreate` from this machine's device. */
  send(content: string): Promise<QueueItemCreateResponse>;
  /** The run the item was queued for. */
  runOf(itemId: QueueItemId): RunId;
  /** Where the item stands in the queue. */
  readItemState(itemId: QueueItemId): QueueItemRecord["state"] | undefined;
  /** Every run state change `run.subscribeState` streamed, in order. */
  streamedStates(): RunStateStreamEvent[];
  countRows(sql: string): number;
  close(): Promise<void>;
}

async function openTurnFixture(
  driverName: ProviderName,
  buildDriver: (wiring: DriverWiring) => TurnDriver,
): Promise<TurnFixture> {
  const engine = await openRunEngineFixture();
  const { database, sessionEvents, sessionId } = engine;
  const diagnosticRecords: DriverDiagnosticRecord[] = [];
  const diagnostics = new DriverDiagnosticsEmitter({
    logSink: {
      record: (record) => {
        diagnosticRecords.push(record);
      },
    },
    counterSink: { increment: () => undefined },
  });
  const serviceLog: string[] = [];
  const readNewestCursor = (readSessionId: SessionId) =>
    sessionEvents.readNewestCursor(readSessionId);
  const holds = new RunSafetyHolds(readNewestCursor);
  const runStatePublisher = new PortRegistration<RunStatePublisher>("run state publisher");
  runStatePublisher.register(holds);
  const epochs = new ExecutionEpochs({ diagnostics });
  const inbound = new RunInboundDispatch({
    sessionEvents,
    engine: engine.engine,
    epochs,
    diagnostics,
    runStatePublisher,
  });
  const runtimeBindings = new RuntimeBindingStore(database);
  const bindingCursors = new RunBindingCursors({
    store: runtimeBindings,
    epochs,
    runs: engine.runs,
  });

  const queueRegistration = new PortRegistration<RunQueue>("run queue");
  const requireQueue = (): RunQueue => queueRegistration.requirePort();
  const driver = buildDriver({ engine: engine.engine, inbound, queue: requireQueue });
  const sessions = {
    providerRegistry: {
      lookup: (name: ProviderName) => (name === driverName ? driver : undefined),
    },
    resolveDriverForSession: () => driverName,
  };
  const queue = new RunQueue({
    sessionEvents,
    reader: database.reader,
    writer: database.writer,
    readNewestCursor,
    engine: engine.engine,
    providerSessions: new ProviderSessions({
      runtimeBindings: bindingStoreWithCursors(runtimeBindings, bindingCursors),
      resolveDriver: () => driver,
      readContractVersion: () => "1.0.0",
      composeOpening: (openingSessionId) =>
        Promise.resolve({
          driverName,
          createParams: {
            sessionId: openingSessionId,
            config: {},
            model: "test-model",
            largerWindow: undefined,
            executionPosture: TEST_EXECUTION_POSTURE,
          },
          functionLegsFor: () => ({}),
        }),
      readSessionLeg: () => undefined,
      readSessionMode: () => "build",
    }),
    sessions,
    memoryGate: openUnspacedMemoryGate(64 * GIBIBYTE),
    startsCodexAccountService: () => Promise.resolve(false),
    readCodexSkillFiles: () => Promise.reject(new Error("No skill read is part of this test")),
    readProviderProcessId: (readSessionId) => driver.readProcessId(readSessionId),
    writeServiceLog: (line) => {
      serviceLog.push(line);
    },
  });
  queueRegistration.register(queue);
  const detachFollow = sessionEvents.followAll((event) => {
    bindingCursors.observe(event);
    queue.lifecycle.observe(event);
  });

  const registry = new MethodRegistryImpl();
  const notifications: JsonRpcNotification<unknown>[] = [];
  const streamingPrimitive = new StreamingPrimitive({
    registry,
    send: (_transportId, notification) => {
      notifications.push(notification);
    },
  });
  registerRunQueueMethods(registry, {
    queue,
    recorder: queue.recorder,
    sessions,
    streamingPrimitive,
    outboundQueue: ALWAYS_ROOM,
  });
  registerRunStateSubscribe(registry, {
    streamingPrimitive,
    outboundQueue: ALWAYS_ROOM,
    readNewestCursor,
    followSession: (followedSessionId, afterCursor, listener) =>
      sessionEvents.follow(followedSessionId, afterCursor, listener),
    holds,
  });
  const context = { transportId: TRANSPORT_ID, deviceId: DeviceIdSchema.parse(randomUUID()) };
  await registry.dispatch("run.subscribeState", { sessionId }, context);
  const items = new QueueItemReader(database.reader);

  return {
    engine,
    queue,
    serviceLog,
    diagnosticRecords,
    send: async (content) =>
      (await registry.dispatch(
        "run.queueCreate",
        { sessionId, clientIdempotencyKey: randomUUID(), content },
        context,
      )) as QueueItemCreateResponse,
    runOf: (itemId) => {
      const runId = items.get(itemId)?.targetRunId;
      if (runId === undefined) {
        throw new Error(`Queue item ${itemId} names no run`);
      }
      return runId;
    },
    readItemState: (itemId) => items.get(itemId)?.state,
    streamedStates: () =>
      notifications.flatMap((notification) =>
        notification.method === SUBSCRIPTION_NOTIFY_METHOD
          ? (
              notification.params as SubscriptionNotifyParams<RunStateStreamFrame>
            ).value.changes.map((change) => change.event)
          : [],
      ),
    countRows: (sql) => database.reader.prepare<[], { count: number }>(sql).get()?.count ?? 0,
    close: async () => {
      detachFollow();
      await driver.shutdown();
      await engine.close();
    },
  };
}

describe("a person's turn through the run queue", () => {
  let fixture: TurnFixture | undefined;

  afterEach(async () => {
    expect(fixture?.serviceLog).toEqual([]);
    expect(fixture?.diagnosticRecords).toEqual([]);
    await fixture?.close();
    fixture = undefined;
  });

  // What a send wrote, each counted once.
  function expectSendWritten(turnFixture: TurnFixture): void {
    expect(turnFixture.countRows("SELECT COUNT(*) AS count FROM queue_items")).toBe(1);
    for (const type of ["user.message", "run.queued"]) {
      expect(
        turnFixture.countRows(
          `SELECT COUNT(*) AS count FROM session_events WHERE type = '${type}'`,
        ),
      ).toBe(1);
    }
  }

  async function expectStreamedCompleted(turnFixture: TurnFixture, runId: RunId): Promise<void> {
    await vi.waitFor(() => {
      expect(turnFixture.engine.runs.getRun(runId)?.state).toBe("completed");
      expect(turnFixture.streamedStates()).toContainEqual(
        expect.objectContaining({ runId, newState: "completed" }),
      );
    });
  }

  // Mutations: wiring the Claude driver's run dispatch to anything but the queue's admission
  // leaves the start unresolved and the run failed; holding Claude's mid-turn message for a tool
  // boundary, as Codex's are, leaves the second frame unwritten until the turn ends.
  // Leaving `onMessageTaken` unwired never admits the replayed message.
  // Recording the run's binding without opening its epoch cursor leaves the run `running`.
  // Ending a run at a turn that left a steer untaken completes it before Claude Code's own next
  // turn, whose replay then finds no run and leaves the kept message waiting.
  it("runs on Claude Code, which takes a mid-turn message at once", async () => {
    let harness: LifecycleHarness | undefined;
    fixture = await openTurnFixture("claude", ({ engine, inbound, queue }) => {
      harness = buildHarness({
        runEngine: engine,
        inbound,
        runDispatchResolver: {
          resolveRunDispatch: async (params) => await queue().admission.resolveRunDispatch(params),
          openDaemonTurnBinding: async (runId, sessionId) =>
            await queue().admission.openDaemonTurnBinding(runId, sessionId),
        },
        attachments: new FakeAttachmentResolver(),
        onMessageTaken: (sessionId, messageId, takenRunId) => {
          queue().delivery.messageTaken(sessionId, messageId, takenRunId);
        },
      });
      return new ClaudeDriver({
        ...harness.dependencies,
        readBuild: () => Promise.reject(new Error("No build is read here")),
      });
    });
    if (harness === undefined) {
      throw new Error("The Claude harness was not built");
    }
    const claude = harness;

    const sent = await fixture.send("Add the retry");
    expectSendWritten(fixture);
    const runId = fixture.runOf(sent.queueItemId);

    await vi.waitFor(() => {
      expect(fixture?.engine.runs.getRun(runId)?.state).toBe("running");
    });
    const channel = spawnedChannel(claude);
    expect(channel.sentUserFrames).toStrictEqual([
      {
        type: "user",
        uuid: sent.queueItemId,
        message: { role: "user", content: "Add the retry" },
      },
    ]);

    const steered = await fixture.send("Cover the timeout too");
    await vi.waitFor(() => {
      expect(channel.sentUserFrames.at(1)).toMatchObject({
        uuid: steered.queueItemId,
        message: { content: "Cover the timeout too" },
      });
    });
    expect(fixture.runOf(steered.queueItemId)).toBe(runId);
    expect(fixture.readItemState(steered.queueItemId)).toBe("queued");

    // Claude Code's replay of the message is how it says its turn took it.
    channel.emitStreamFrame("user", undefined, {
      type: "user",
      isReplay: true,
      parent_tool_use_id: null,
      uuid: steered.queueItemId,
      message: { role: "user", content: "Cover the timeout too" },
    });
    await vi.waitFor(() => {
      expect(fixture?.readItemState(steered.queueItemId)).toBe("admitted");
    });

    channel.emitStreamFrame("result/success", undefined, { type: "result", subtype: "success" });
    await expectStreamedCompleted(fixture, runId);

    // A message the next turn did not take: Claude Code keeps it and starts a turn of its own
    // with it, which the run goes on into.
    const next = await fixture.send("Then the docs");
    const nextRunId = fixture.runOf(next.queueItemId);
    await vi.waitFor(() => {
      expect(fixture?.engine.runs.getRun(nextRunId)?.state).toBe("running");
    });
    const kept = await fixture.send("And the changelog");
    await vi.waitFor(() => {
      expect(channel.sentUserFrames.at(-1)).toMatchObject({ uuid: kept.queueItemId });
    });
    channel.emitStreamFrame("result/success", undefined, { type: "result", subtype: "success" });
    await fixture.queue.delivery.settle(fixture.engine.sessionId);
    expect(fixture.engine.runs.getRun(nextRunId)?.state).toBe("running");
    expect(fixture.readItemState(kept.queueItemId)).toBe("queued");

    channel.emitStreamFrame("user", undefined, {
      type: "user",
      isReplay: true,
      parent_tool_use_id: null,
      uuid: kept.queueItemId,
      message: { role: "user", content: "And the changelog" },
    });
    await vi.waitFor(() => {
      expect(fixture?.readItemState(kept.queueItemId)).toBe("admitted");
    });
    channel.emitStreamFrame("result/success", undefined, { type: "result", subtype: "success" });
    await expectStreamedCompleted(fixture, nextRunId);
    expect(channel.sentUserFrames.map((frame) => frame.uuid)).toStrictEqual([
      sent.queueItemId,
      steered.queueItemId,
      next.queueItemId,
      kept.queueItemId,
    ]);
  });

  // Mutations: leaving `onToolBoundary` unwired on the Codex driver never steers the held
  // messages; handing Codex a message at once, as Claude Code's are, steers before the boundary;
  // dropping `clientUserMessageId` from the turn's opening fails the `turn/start` check.
  // Recording the run's binding without opening its epoch cursor leaves the run `running`.
  it("runs on Codex, which takes mid-turn messages only at a tool boundary", async () => {
    let harness: Harness | undefined;
    fixture = await openTurnFixture("codex", ({ engine, inbound, queue }) => {
      harness = createHarness({
        runEngine: engine,
        inbound,
        onToolBoundary: (boundary) => {
          queue().delivery.onToolBoundary(boundary);
        },
        openDaemonTurnBinding: async (runId, sessionId) =>
          await queue().admission.openDaemonTurnBinding(runId, sessionId),
      });
      return harness.driver;
    });
    if (harness === undefined) {
      throw new Error("The Codex harness was not built");
    }
    const codex = harness;
    codex.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    codex.server.on("turn/steer", () => ({ result: { turnId: TURN_ID } }));

    const sent = await fixture.send("Add the retry");
    expectSendWritten(fixture);
    const runId = fixture.runOf(sent.queueItemId);

    await vi.waitFor(() => {
      expect(fixture?.engine.runs.getRun(runId)?.state).toBe("running");
    });
    expect(codex.server.paramsFor("turn/start")).toStrictEqual([
      expect.objectContaining({
        threadId: THREAD_ID,
        clientUserMessageId: sent.queueItemId,
        input: [{ type: "text", text: "Add the retry", text_elements: [] }],
      }),
    ]);

    const first = await fixture.send("Cover the timeout too");
    const second = await fixture.send("And the log line");
    // A reply ending is no tool boundary, so both still wait.
    const emitItemCompleted = (item: Record<string, unknown>): void => {
      codex.server.emitFrame({
        jsonrpc: "2.0",
        method: "item/completed",
        params: { threadId: THREAD_ID, turnId: TURN_ID, item, completedAtMs: 0 },
      });
    };
    emitItemCompleted({ type: "agentMessage", id: "reply-1", text: "running the tests" });
    await fixture.queue.delivery.settle(fixture.engine.sessionId);
    expect(codex.server.paramsFor("turn/steer")).toStrictEqual([]);

    emitItemCompleted({
      type: "commandExecution",
      id: "command-1",
      command: "pnpm test",
      status: "completed",
    });
    await vi.waitFor(() => {
      expect(
        codex.server.paramsFor("turn/steer").map((params) => params["clientUserMessageId"]),
      ).toStrictEqual([first.queueItemId, second.queueItemId]);
    });

    codex.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await expectStreamedCompleted(fixture, runId);
  });
});
