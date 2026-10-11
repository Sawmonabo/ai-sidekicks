// A person's turn end to end, with the run queue wired as the daemon wires it: over a real
// database, event log, run engine and inbound dispatch, through the `run.*` methods and the
// intervention service, onto each provider's real driver over its fake process. A send is written
// whole, starts a run whose turn carries the message, ends `completed` on the provider's own end
// and is streamed so; a message sent mid-turn reaches Claude Code at once and Codex only at its
// next tool boundary. An interrupted run goes on, the same run, on the turn Claude Code starts with
// the message it kept, and on Codex's next turn a send starts.

import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { JsonRpcNotification } from "@ai-sidekicks/contracts/jsonrpc/message";
import {
  SUBSCRIPTION_NOTIFY_METHOD,
  type SubscriptionNotifyParams,
} from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type { InterruptPendingChoice } from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type {
  InterventionRequestResponse,
  RunStateStreamEvent,
  RunStateStreamFrame,
} from "@ai-sidekicks/contracts/run/control";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { QueueItemCreateResponse, QueueItemId } from "@ai-sidekicks/contracts/run/queue";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { DeviceIdSchema } from "@ai-sidekicks/contracts/trust-statement";

import { InterventionService } from "../../interventions/service.js";
import { InterventionReader } from "../../interventions/store.js";
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
import { ClaudeRunRoutes } from "../../provider/driver/claude/run/routes.js";
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
import { CodexTurnEndWaiters } from "../../provider/driver/codex/run/turn-end-waiters.js";
import type { ProviderDriver } from "../../provider/driver/contract.js";
import { PortRegistration } from "../../provider/port/registration.js";
import { RuntimeBindingStore, selectSessionLeg } from "../../provider/runtime-binding-store.js";
import { RunBindingCursors } from "../../session/run/binding-cursors.js";
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
  /** Interrupts `runId` from this machine's device at the version it reads now. */
  interrupt(runId: RunId, pending: InterruptPendingChoice): Promise<InterventionRequestResponse>;
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
  const epochs = new ExecutionEpochs({ diagnostics });
  const inbound = new RunInboundDispatch({
    sessionEvents,
    engine: engine.engine,
    epochs,
    diagnostics,
    runStatePublisher: holds,
  });
  const runtimeBindings = new RuntimeBindingStore(database);
  const selectRunIds = database.reader.prepare<[string], { runId: RunId }>(
    "SELECT run_id AS runId FROM runs WHERE session_id = ?",
  );
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
      runtimeBindings,
      bindingCursors,
      resolveDriver: () => driver,
      readContractVersion: () => "1.0.0",
      readPermissionLevel: () => "yolo",
      recordPermissionLevel: () => Promise.reject(new Error("No level move is part of this test")),
      composeOpening: (openingSessionId) =>
        Promise.resolve({
          driverName,
          gitFolder: "/work/repo/.git",
          createParams: {
            sessionId: openingSessionId,
            config: {},
            model: "test-model",
            largerWindow: undefined,
            executionPosture: TEST_EXECUTION_POSTURE,
          },
          functionLegsFor: () => ({}),
        }),
      readSessionLeg: (legSessionId) =>
        selectSessionLeg(
          runtimeBindings.findByRuns(selectRunIds.all(legSessionId).map((row) => row.runId)),
        ),
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
  const interventions = new InterventionService({
    runs: engine.runs,
    interventions: new InterventionReader(database.reader),
    sessionEvents,
    resolveDriver: () => driver,
    retryOnFasterModel: () => Promise.reject(new Error("No faster-model retry is sent here")),
    runEngine: engine.engine,
    queue,
  });

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
    interrupt: async (runId, pending) =>
      await interventions.applyIntervention(
        {
          type: "interrupt",
          targetRunId: runId,
          expectedRunVersion: engine.runs.getRun(runId)?.version ?? 0,
          clientIdempotencyKey: randomUUID(),
          pending,
        },
        { actor: context.deviceId },
      ),
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

// A turn fixture on Claude Code's real driver, wired to the queue as the daemon wires it.
async function openClaudeTurnFixture(): Promise<{
  readonly fixture: TurnFixture;
  readonly claude: LifecycleHarness;
}> {
  let harness: LifecycleHarness | undefined;
  const fixture = await openTurnFixture("claude", ({ engine, inbound, queue }) => {
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
  return { fixture, claude: harness };
}

// A turn fixture on Codex's real driver, wired to the queue as the daemon wires it.
async function openCodexTurnFixture(): Promise<{
  readonly fixture: TurnFixture;
  readonly codex: Harness;
}> {
  let harness: Harness | undefined;
  const fixture = await openTurnFixture("codex", ({ engine, inbound, queue }) => {
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
  return { fixture, codex: harness };
}

describe("a person's turn through the run queue", () => {
  let fixture: TurnFixture | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
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
    const opened = await openClaudeTurnFixture();
    fixture = opened.fixture;
    const { claude } = opened;

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
    const opened = await openCodexTurnFixture();
    fixture = opened.fixture;
    const { codex } = opened;
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
  // Mutations: leaving out the stream's continue of the interrupted run leaves the kept turn's
  // frames on an ended run, the run interrupted and the message waiting; continuing the run from
  // the queue while Claude Code holds the message sends it a second time; leaving the stopped
  // turn's end unmarked records it, refused after the interrupt's own end, as a late event.
  it("continues an interrupted Claude run on the turn Claude Code starts with the message it kept", async () => {
    const opened = await openClaudeTurnFixture();
    fixture = opened.fixture;
    const sent = await fixture.send("Add the retry");
    const runId = fixture.runOf(sent.queueItemId);
    await vi.waitFor(() => {
      expect(fixture?.engine.runs.getRun(runId)?.state).toBe("running");
    });
    const channel = spawnedChannel(opened.claude);
    channel.processId = 4242;
    const emitAssistant = (uuid: string, text: string): void => {
      channel.emitStreamFrame("assistant", undefined, {
        type: "assistant",
        uuid,
        message: { id: `msg-${uuid}`, content: [{ type: "text", text }] },
      });
    };
    emitAssistant("wire-retry", "Adding the retry.");
    const kept = await fixture.send("Cover the timeout too");
    await vi.waitFor(() => {
      expect(channel.sentUserFrames.at(1)).toMatchObject({ uuid: kept.queueItemId });
    });

    expect((await fixture.interrupt(runId, "nextTurn")).state).toBe("applied");
    expect(fixture.engine.runs.getRun(runId)?.state).toBe("interrupted");
    expect(channel.controlRequests).toStrictEqual([{ subtype: "interrupt" }]);

    // Claude Code ends the stopped turn, then starts its next with the message it kept.
    channel.emitStreamFrame("result/error_during_execution", undefined, {
      type: "result",
      subtype: "error_during_execution",
    });
    channel.emitStreamFrame("user", undefined, {
      type: "user",
      isReplay: true,
      parent_tool_use_id: null,
      uuid: kept.queueItemId,
      message: { role: "user", content: "Cover the timeout too" },
    });
    emitAssistant("wire-kept", "Covering the timeout.");
    const runMessagesSql =
      "SELECT COUNT(*) AS count FROM session_events WHERE type = 'assistant.message' " +
      `AND json_extract(payload, '$.runId') = '${runId}'`;
    await vi.waitFor(() => {
      expect(fixture?.engine.runs.getRun(runId)?.state).toBe("running");
      expect(fixture?.readItemState(kept.queueItemId)).toBe("admitted");
      expect(fixture?.countRows(runMessagesSql)).toBe(2);
    });
    expect(fixture.runOf(kept.queueItemId)).toBe(runId);

    channel.emitStreamFrame("result/success", undefined, { type: "result", subtype: "success" });
    await expectStreamedCompleted(fixture, runId);
    expect(channel.sentUserFrames.map((frame) => frame.uuid)).toStrictEqual([
      sent.queueItemId,
      kept.queueItemId,
    ]);
  });

  // Mutation: starting Claude Code's next turn without waiting for it to end the stopped one
  // never waits for the turn's release and writes the send into the turn the interrupt stopped.
  it("continues an interrupted Claude run on the next turn a send starts, once the stopped turn ended", async () => {
    const opened = await openClaudeTurnFixture();
    fixture = opened.fixture;
    const sent = await fixture.send("Add the retry");
    const runId = fixture.runOf(sent.queueItemId);
    await vi.waitFor(() => {
      expect(fixture?.engine.runs.getRun(runId)?.state).toBe("running");
    });
    const channel = spawnedChannel(opened.claude);
    channel.processId = 4242;
    channel.emitStreamFrame("assistant", undefined, {
      type: "assistant",
      uuid: "wire-retry",
      message: { id: "msg-wire-retry", content: [{ type: "text", text: "Adding the retry." }] },
    });

    expect((await fixture.interrupt(runId, "returnToDraft")).state).toBe("applied");
    const waitForRelease = vi.spyOn(ClaudeRunRoutes.prototype, "whenTurnReleased");
    const next = await fixture.send("Then the docs");
    // Nothing more is written while Claude Code is still ending the stopped turn.
    await vi.waitFor(() => {
      expect(waitForRelease).toHaveBeenCalled();
    });
    expect(channel.sentUserFrames).toHaveLength(1);

    channel.emitStreamFrame("result/error_during_execution", undefined, {
      type: "result",
      subtype: "error_during_execution",
    });
    await vi.waitFor(() => {
      expect(fixture?.engine.runs.getRun(runId)?.state).toBe("running");
      expect(fixture?.readItemState(next.queueItemId)).toBe("admitted");
    });
    expect(fixture.runOf(next.queueItemId)).toBe(runId);
    expect(channel.sentUserFrames.map((frame) => frame.uuid)).toStrictEqual([
      sent.queueItemId,
      next.queueItemId,
    ]);

    channel.emitStreamFrame("result/success", undefined, { type: "result", subtype: "success" });
    await expectStreamedCompleted(fixture, runId);
  });

  // Mutations: starting a new run for a send while the newest run rests interrupted gives the
  // turn another run id; starting Codex's next turn without waiting for the stopped one to end
  // never waits for that end and folds the two.
  it("continues an interrupted Codex run on the next turn a send starts", async () => {
    const opened = await openCodexTurnFixture();
    fixture = opened.fixture;
    const { codex } = opened;
    const turnIds = [TURN_ID, "turn-02"];
    codex.server.on("turn/start", () => ({ result: { turn: { id: turnIds.shift() } } }));
    codex.server.on("turn/interrupt", () => ({ result: {} }));
    const sent = await fixture.send("Add the retry");
    const runId = fixture.runOf(sent.queueItemId);
    await vi.waitFor(() => {
      expect(fixture?.engine.runs.getRun(runId)?.state).toBe("running");
    });

    expect((await fixture.interrupt(runId, "returnToDraft")).state).toBe("applied");
    expect(fixture.engine.runs.getRun(runId)?.state).toBe("interrupted");
    const waitForStoppedTurns = vi.spyOn(CodexTurnEndWaiters.prototype, "waitForStoppedTurns");
    const next = await fixture.send("Then the docs");
    // No turn starts while Codex is still ending the stopped one.
    await vi.waitFor(() => {
      expect(waitForStoppedTurns).toHaveBeenCalled();
    });
    expect(codex.server.paramsFor("turn/start")).toHaveLength(1);
    // Codex ends the stopped turn, its own end finding the run already ended.
    codex.server.emitFrame(turnCompletedFrame(TURN_ID, "interrupted"));

    await vi.waitFor(() => {
      expect(fixture?.readItemState(next.queueItemId)).toBe("admitted");
      expect(fixture?.engine.runs.getRun(runId)?.state).toBe("running");
    });
    expect(fixture.runOf(next.queueItemId)).toBe(runId);
    expect(
      codex.server.paramsFor("turn/start").map((params) => params["clientUserMessageId"]),
    ).toStrictEqual([sent.queueItemId, next.queueItemId]);
    codex.server.emitFrame(turnCompletedFrame("turn-02", "completed"));
    await expectStreamedCompleted(fixture, runId);
    expect(fixture.streamedStates()).toStrictEqual(
      ["starting", "running", "interrupted", "running", "completed"].map((newState) =>
        expect.objectContaining({ runId, newState }),
      ),
    );
  });
});
