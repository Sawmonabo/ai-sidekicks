// A run queue over the run engine's scratch fixture: one scripted driver stands for the session's
// provider, its provider session opens at once, the memory gate is the daemon's own over a
// machine whose free memory the test sets, on a clock that never holds a start for spacing, and
// the queue follows every committed event as the daemon wires it, reading a session's record again
// at a gap. An interrupt goes through the daemon's own intervention service.

import { randomUUID } from "node:crypto";

import { expect, vi } from "vitest";

import type {
  ApplyInterventionParams,
  DriverInterventionResult,
  InterruptPendingChoice,
  PickedSkill,
} from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { InterventionRequestResponse } from "@ai-sidekicks/contracts/run/control";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type {
  QueueItemCreateResponse,
  QueueItemId,
  QueuedSkillPick,
} from "@ai-sidekicks/contracts/run/queue";
import { encodeEventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import { DeviceIdSchema, type DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import {
  createMemoryGate,
  type AdmissionWork,
  type MemoryGate,
} from "../../admission/memory-gate.js";
import { InterventionService } from "../../interventions/service.js";
import { InterventionReader } from "../../interventions/store.js";
import { FakeProviderDriver } from "../../provider/driver/__fixtures__/contract-doubles.js";
import type { ProviderDriver, StartRunParams } from "../../provider/driver/contract.js";
import type {
  WithdrawQueuedMessageParams,
  WithdrawQueuedMessageResult,
} from "../../provider/driver/run-control.js";
import {
  TEST_EXECUTION_POSTURE,
  openRunEngineFixture,
  type RunEngineFixture,
} from "../../session/run/__tests__/engine.test-support.js";
import { RunQueue } from "../service.js";
import { QueueItemReader, type QueueItemRecord } from "../store.js";

const GIBIBYTE = 1024 * 1024 * 1024;

/** How the fixture's provider and machine behave. */
export interface RunQueueFixtureOptions {
  readonly driverName: ProviderName;
  /** Bytes the machine has free; the default never holds a run back. */
  readonly availableMemoryBytes?: number;
  readonly deliveryTimeoutMs?: number;
  readonly withdrawDeadlineMs?: number;
  /** The one clock the engine and the queue stamp their rows with; the default is the machine's. */
  readonly now?: () => string;
}

/** A run queue over a scratch database, and what its provider was handed. */
export interface RunQueueFixture {
  readonly engine: RunEngineFixture;
  readonly queue: RunQueue;
  /** The daemon's memory gate the queue admits runs through. */
  readonly memoryGate: MemoryGate;
  /** Each run start the driver was handed, in order. */
  readonly startedRuns: StartRunParams[];
  /** The opening text of each run start, in order: Codex's turn input, Claude Code's dispatch. */
  readonly openings: string[];
  /** Each steer the driver was handed, in order. */
  readonly steers: ApplyInterventionParams[];
  /** Each withdraw the driver was asked for, in order. */
  readonly withdraws: WithdrawQueuedMessageParams[];
  /** Each place at the memory gate the queue asked for, in order. */
  readonly enqueuedWork: AdmissionWork[];
  /** Answers each run start the driver is handed, once it is recorded; the default starts it. */
  answerStart: (params: StartRunParams) => Promise<void>;
  /** Answers each steer the driver is handed; the default applies it at once. */
  answerSteer: (params: ApplyInterventionParams) => Promise<DriverInterventionResult>;
  /** Answers each interrupt the driver is handed; the default applies it at once. */
  answerInterrupt: (params: ApplyInterventionParams) => Promise<DriverInterventionResult>;
  /** Answers each withdraw the driver is asked for; the default gives the message back. */
  answerWithdraw: (params: WithdrawQueuedMessageParams) => Promise<WithdrawQueuedMessageResult>;
  /** The skills Codex lists with their files; the default lists none. */
  skillFiles: readonly PickedSkill[];
  /** How many times the queue read Codex's skills. */
  skillReads: number;
  /** Whether a Codex read would start the account's service; the default finds it running. */
  startsCodexAccountService: boolean;
  /** The id of the provider's process, `undefined` while none runs; the default is one running. */
  providerProcessId: number | undefined;
  /** The device every send comes from. */
  readonly deviceId: DeviceId;
  /** Every line the queue wrote to the service log. */
  readonly serviceLog: string[];
  /** Each opening of the session's provider session, as `open`, in order with what a test adds. */
  readonly startSteps: string[];
  /**
   * Sends `content` from the fixture's device, under `clientIdempotencyKey` when one is given,
   * with the skills picked for it.
   */
  send(
    content: string,
    clientIdempotencyKey?: string,
    skills?: QueuedSkillPick[],
  ): Promise<QueueItemCreateResponse>;
  /**
   * Interrupts `runId` from the fixture's device through the intervention service, with `pending`
   * as its choice for the waiting messages, at `expectedRunVersion`, else the version the run reads
   * now.
   */
  interrupt(
    runId: RunId,
    pending: InterruptPendingChoice,
    deliverFirst?: QueueItemId,
    expectedRunVersion?: number,
  ): Promise<InterventionRequestResponse>;
  readItem(itemId: QueueItemId): QueueItemRecord | undefined;
  /** The run each start the driver was handed was for, in order. */
  startedRunIds(): RunId[];
  /** The types of the session's events after its creation, in log order. */
  readEventTypes(): string[];
  /** Detaches the queue from the event log, so it misses every change after it. */
  stopFollowing(): void;
  close(): Promise<void>;
}

/**
 * A memory gate on a 16 GiB machine with `availableMemoryBytes` free, whose clock reads a minute
 * later on each read, so the spacing between estimated starts has always passed.
 */
export function openUnspacedMemoryGate(availableMemoryBytes: number): MemoryGate {
  let clockMs = 0;
  return createMemoryGate({
    peakReader: { readPeakBytes: () => Promise.resolve(undefined) },
    readAvailableMemory: () => availableMemoryBytes,
    physicalMemoryBytes: 16 * GIBIBYTE,
    clock: {
      now: () => (clockMs += 60_000),
      schedule: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref();
        return () => {
          clearTimeout(timer);
        };
      },
    },
  });
}

/** Settles once the run a send started has taken its opening, so no start outlives the test. */
export async function waitForOpening(
  fixture: RunQueueFixture,
  sent: QueueItemCreateResponse,
): Promise<void> {
  await vi.waitFor(() => {
    expect(fixture.readItem(sent.queueItemId)?.state).toBe("admitted");
  });
}

/** Sends `content` as the opening of the session's first run and answers that run once it runs. */
export async function startFirstRun(fixture: RunQueueFixture, content: string): Promise<RunId> {
  await waitForOpening(fixture, await fixture.send(content));
  const [runId] = fixture.startedRunIds();
  if (runId === undefined) {
    throw new Error("The opening started no run");
  }
  return runId;
}

/** Opens a run queue whose session runs on a scripted `driverName` driver. */
export async function openRunQueueFixture(
  options: RunQueueFixtureOptions,
): Promise<RunQueueFixture> {
  const engine = await openRunEngineFixture(options.now);
  const { database, sessionEvents, sessionId } = engine;
  const deviceId: DeviceId = DeviceIdSchema.parse(randomUUID());
  const startedRuns: StartRunParams[] = [];
  const openings: string[] = [];
  const steers: ApplyInterventionParams[] = [];
  const withdraws: WithdrawQueuedMessageParams[] = [];
  const enqueuedWork: AdmissionWork[] = [];
  const serviceLog: string[] = [];
  const startSteps: string[] = [];

  const driver: ProviderDriver = new FakeProviderDriver(() =>
    Promise.reject(new Error("No capability read is part of this test")),
  );
  driver.startRun = async (params) => {
    startedRuns.push(params);
    const claudeDispatch = await queue.admission.resolveRunDispatch(params);
    const codexInput = params.agentConfig["input"];
    openings.push(
      claudeDispatch?.openingText ?? (typeof codexInput === "string" ? codexInput : ""),
    );
    await fixture.answerStart(params);
  };
  driver.applyIntervention = (params) => {
    if (params.type === "interrupt") {
      return fixture.answerInterrupt(params);
    }
    steers.push(params);
    return fixture.answerSteer(params);
  };
  driver.withdrawQueuedMessage = (params) => {
    withdraws.push(params);
    return fixture.answerWithdraw(params);
  };

  const memoryGate = openUnspacedMemoryGate(options.availableMemoryBytes ?? 64 * GIBIBYTE);
  const selectHead = database.reader.prepare<[string], { head: number }>(
    "SELECT MAX(sequence) AS head FROM session_events WHERE session_id = ?",
  );
  const queue = new RunQueue({
    sessionEvents,
    reader: database.reader,
    writer: database.writer,
    readNewestCursor: (readSessionId) =>
      encodeEventCursor(selectHead.get(readSessionId)?.head ?? 0),
    engine: engine.engine,
    providerSessions: {
      readExecutionPosture: () => Promise.resolve(TEST_EXECUTION_POSTURE),
      open: () => {
        startSteps.push("open");
        return Promise.resolve();
      },
      openRunBinding: (runId) => Promise.resolve(`binding-${runId}`),
      forget: () => undefined,
    },
    sessions: {
      providerRegistry: { lookup: () => driver },
      resolveDriverForSession: () => options.driverName,
    },
    memoryGate: {
      enqueue: (work) => {
        enqueuedWork.push(work);
        return memoryGate.enqueue(work);
      },
      weigh: () => {
        memoryGate.weigh();
      },
    },
    startsCodexAccountService: () => Promise.resolve(fixture.startsCodexAccountService),
    readCodexSkillFiles: () => {
      fixture.skillReads += 1;
      return Promise.resolve(fixture.skillFiles);
    },
    readProviderProcessId: () => fixture.providerProcessId,
    writeServiceLog: (line) => {
      serviceLog.push(line);
    },
    ...(options.deliveryTimeoutMs === undefined
      ? {}
      : { deliveryTimeoutMs: options.deliveryTimeoutMs }),
    ...(options.withdrawDeadlineMs === undefined
      ? {}
      : { withdrawDeadlineMs: options.withdrawDeadlineMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const detachFollow = sessionEvents.followAll(
    (event) => {
      queue.lifecycle.observe(event);
    },
    (gapSessionId) => void queue.lifecycle.reconcile(gapSessionId),
  );
  const interventions = new InterventionService({
    runs: engine.runs,
    interventions: new InterventionReader(database.reader),
    sessionEvents,
    resolveDriver: () => driver,
    retryOnFasterModel: () => Promise.reject(new Error("No faster-model retry is sent here")),
    runEngine: engine.engine,
    queue,
  });
  const items = new QueueItemReader(database.reader);
  const selectEventTypes = database.reader.prepare<[string], { type: string }>(
    `SELECT type FROM session_events
      WHERE session_id = ? AND type <> 'session.created' ORDER BY sequence`,
  );

  const fixture: RunQueueFixture = {
    engine,
    queue,
    memoryGate,
    startedRuns,
    openings,
    steers,
    withdraws,
    enqueuedWork,
    answerStart: () => Promise.resolve(),
    answerSteer: () => Promise.resolve({ status: "applied" }),
    answerInterrupt: () => Promise.resolve({ status: "applied" }),
    answerWithdraw: () => Promise.resolve({ status: "withdrawn" }),
    skillFiles: [],
    skillReads: 0,
    startsCodexAccountService: false,
    providerProcessId: 4242,
    deviceId,
    serviceLog,
    startSteps,
    send: (content, clientIdempotencyKey, skills) =>
      queue.create(
        {
          sessionId,
          clientIdempotencyKey: clientIdempotencyKey ?? randomUUID(),
          content,
          ...(skills === undefined ? {} : { skills }),
        },
        deviceId,
      ),
    interrupt: (runId, pending, deliverFirst, expectedRunVersion) =>
      interventions.applyIntervention(
        {
          type: "interrupt",
          targetRunId: runId,
          expectedRunVersion: expectedRunVersion ?? engine.runs.getRun(runId)?.version ?? 0,
          clientIdempotencyKey: randomUUID(),
          pending,
          ...(deliverFirst === undefined ? {} : { deliverFirst }),
        },
        { actor: deviceId },
      ),
    readItem: (itemId) => items.get(itemId),
    startedRunIds: () => startedRuns.map((params) => params.runId),
    readEventTypes: () => selectEventTypes.all(sessionId).map((row) => row.type),
    stopFollowing: detachFollow,
    close: async () => {
      detachFollow();
      await engine.close();
    },
  };
  return fixture;
}
