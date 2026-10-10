// Shared setup for the `lifecycle.ts` tests: a lifecycle wired to the transport and dispatch
// doubles, plus the arrangements most tests open with.

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { ProviderOutputSpeedState } from "@ai-sidekicks/contracts/provider/driver/output-speed";
import type { ProcessExit } from "@ai-sidekicks/contracts/run/control";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionNoticePayload } from "@ai-sidekicks/contracts/session/controls/events";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { InboundDelivery, InboundOutcome } from "../../../../session/run/inbound.js";
import type { PermissionAskPort } from "../../../port/permission-ask.js";
import type { QuestionPort } from "../../../port/question.js";
import { PortRegistration } from "../../../port/registration.js";
import type { ReviewerDenialPort } from "../../../port/reviewer-denial.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import type {
  CreateSessionParams,
  DriverResumeResult,
  MoveSessionToForkResult,
  ResumeSessionParams,
} from "../../contract.js";
import { makeSilentDriverDiagnostics } from "../../../__fixtures__/silent-driver-diagnostics.js";
import { ClaudeSessionLifecycle } from "../lifecycle.js";
import type { ClaudeSessionLifecycleDependencies } from "../session/state.js";
import {
  buildCreateSessionParams,
  buildStartRunParams,
  FakeClaudeProviderProcess,
  FakeClaudeRunDispatchResolver,
  FakeClaudeSessionTransport,
  TEST_BINDING_ID,
  TEST_MODEL,
  TEST_PINNED_PROVIDER_SESSION_ID,
  TEST_RUN_ID,
  TEST_SESSION_ID,
} from "../__fixtures__/transport-doubles.js";
import { DARWIN_PROVIDER_OPERATING_SYSTEM } from "../../../operating-system/darwin.js";

/** The id of the `ordinal`th run the daemon started in a test, a valid UUID. */
export function daemonTurnRunId(ordinal: number): RunId {
  return `00000000-0000-7000-8000-${String(ordinal).padStart(12, "0")}` as RunId;
}

/** A lifecycle under test together with the doubles and recorders it was built over. */
export interface LifecycleHarness {
  readonly lifecycle: ClaudeSessionLifecycle;
  /** What the lifecycle was built over, for a driver built over the same doubles. */
  readonly dependencies: ClaudeSessionLifecycleDependencies;
  readonly transport: FakeClaudeSessionTransport;
  readonly runDispatchResolver: FakeClaudeRunDispatchResolver;
  readonly diagnostics: DriverDiagnosticsEmitter;
  /** Every delivery the lifecycle handed the run engine, in the order it dispatched them. */
  readonly deliveries: InboundDelivery[];
  /** Answers one delivery; a test replaces it to refuse or to answer otherwise. */
  answerDelivery: (delivery: InboundDelivery) => Promise<InboundOutcome>;
  /** Each run move the lifecycle delivered, in order. */
  readonly runMoves: Extract<InboundDelivery, { kind: "run_lifecycle" }>["change"][];
  /** Each run failure the lifecycle delivered for a run whose turn a rewind superseded. */
  readonly supersededRunFailures: {
    readonly runId: RunId;
    readonly providerFailureDetail: string;
  }[];
  /** Each session notice the lifecycle delivered, in order. */
  readonly sessionNotices: SessionNoticePayload[];
  /** Each run the lifecycle ended because its process exited on its own. */
  readonly processExitRunEnds: { readonly runId: RunId; readonly processExit: ProcessExit }[];
  /** Each settled output speed the lifecycle reported to the run engine. */
  readonly settledOutputSpeeds: {
    readonly sessionId: SessionId;
    readonly runId: RunId;
    readonly state: ProviderOutputSpeedState;
  }[];
  /** Each resume the driver started itself, with its result. */
  readonly relaunches: { readonly sessionId: SessionId; readonly result: DriverResumeResult }[];
  /** Each run the run engine started for a turn the daemon started on a session itself. */
  readonly daemonTurnRuns: { readonly runId: RunId; readonly sessionId: SessionId }[];
  readonly permissionAsks: PortRegistration<PermissionAskPort>;
  readonly questions: PortRegistration<QuestionPort>;
  readonly reviewerDenials: PortRegistration<ReviewerDenialPort>;
  /** Runs the restart waits the lifecycle scheduled, at once; answers how many ran. */
  readonly runScheduledRestarts: () => number;
}

// How the fake run engine answers a delivery: a child run is started under a minted id, an ask is
// admitted, and everything else is published.
function answerDeliveryByDefault(delivery: InboundDelivery, childRunCount: number): InboundOutcome {
  switch (delivery.kind) {
    case "child_run":
      return {
        disposition: "child_run_started",
        runId: `child-run-${String(childRunCount)}` as RunId,
      };
    case "permission_ask":
      return { disposition: "ask_admitted" };
    default:
      return { disposition: "published" };
  }
}

/** The message id the test run's opening text is sent under. */
export const TEST_MESSAGE_ID = "0b7c2e9a-1d3f-4a5b-8c6d-7e8f9a0b1c2d";

/** Builds a lifecycle over fresh doubles; `overrides` replace individual dependencies. */
export function buildHarness(
  overrides: Partial<ClaudeSessionLifecycleDependencies> = {},
): LifecycleHarness {
  const transport = new FakeClaudeSessionTransport();
  const runDispatchResolver = new FakeClaudeRunDispatchResolver();
  const deliveries: InboundDelivery[] = [];
  const processExitRunEnds: LifecycleHarness["processExitRunEnds"] = [];
  const settledOutputSpeeds: LifecycleHarness["settledOutputSpeeds"] = [];
  const relaunches: LifecycleHarness["relaunches"] = [];
  const daemonTurnRuns: LifecycleHarness["daemonTurnRuns"] = [];
  const scheduledRestarts: (() => void)[] = [];
  const permissionAsks = new PortRegistration<PermissionAskPort>("permission ask");
  const questions = new PortRegistration<QuestionPort>("question");
  const reviewerDenials = new PortRegistration<ReviewerDenialPort>("reviewer denial");
  let childRunCount = 0;
  const dependencies: ClaudeSessionLifecycleDependencies = {
    transport,
    providerBaseEnvironment: [],
    spawnContext: {
      resolveSpawnContext: async () => {
        await Promise.resolve();
        return {
          workingDirectory: "/workspace",
          environmentRows: undefined,
          accountFolders: undefined,
          memoryFolders: [],
          advisorModel: null,
          outputStyle: null,
        };
      },
    },
    credentialPolicy: {
      resolveCredentialPolicy: async (credentialPolicyRef) => {
        await Promise.resolve();
        return { credentialPolicyRef, denyPaths: [], denyEnvVars: [] };
      },
    },
    runEngine: {
      // The run is queued and started under a minted id (a UUID, as the run's own rows require),
      // its start the driver's own.
      startDaemonTurn: async (request) => {
        const runId = daemonTurnRunId(daemonTurnRuns.length + 1);
        daemonTurnRuns.push({ runId, sessionId: request.sessionId });
        await request.startTurn(runId);
        return runId;
      },
      endTurnOnProcessExit: async (runId, processExit) => {
        await Promise.resolve();
        processExitRunEnds.push({ runId, processExit });
      },
      recordSettledOutputSpeed: async (sessionId, runId, state) => {
        settledOutputSpeeds.push({ sessionId, runId, state });
        await Promise.resolve();
      },
    },
    inbound: {
      // Recorded at the call, as the real dispatch attributes a delivery when it is called.
      dispatch: async (delivery) => {
        deliveries.push(delivery);
        return await harness.answerDelivery(delivery);
      },
    },
    permissionAsks,
    questions,
    reviewerDenials,
    stagedChanges: {
      openStagedWorktree: async () => {
        await Promise.resolve();
        return { folder: "/staged", close: async () => await Promise.resolve() };
      },
    },
    onSessionRelaunched: (sessionId, result) => {
      relaunches.push({ sessionId, result });
    },
    rebindRuntimeBinding: async () => {
      await Promise.resolve();
    },
    // A folder that does not exist, so no test reads this machine's own managed settings.
    operatingSystem: {
      ...DARWIN_PROVIDER_OPERATING_SYSTEM,
      claudeManagedSettingsFolder: "/nonexistent/claude-managed-settings",
    },
    restartScheduler: (callback) => {
      scheduledRestarts.push(callback);
      return (): void => {
        const index = scheduledRestarts.indexOf(callback);
        if (index >= 0) {
          scheduledRestarts.splice(index, 1);
        }
      };
    },
    runDispatchResolver,
    diagnostics: makeSilentDriverDiagnostics(),
    mintProviderSessionId: () => TEST_PINNED_PROVIDER_SESSION_ID,
    mintBindingId: () => TEST_BINDING_ID,
    ...overrides,
  };
  const runMovesOf = (): LifecycleHarness["runMoves"] =>
    deliveries.flatMap((delivery) => (delivery.kind === "run_lifecycle" ? [delivery.change] : []));
  const harness: LifecycleHarness = {
    lifecycle: new ClaudeSessionLifecycle(dependencies),
    dependencies,
    transport,
    runDispatchResolver,
    diagnostics: dependencies.diagnostics,
    deliveries,
    answerDelivery: async (delivery) => {
      await Promise.resolve();
      if (delivery.kind === "child_run") {
        childRunCount += 1;
      }
      return answerDeliveryByDefault(delivery, childRunCount);
    },
    get runMoves() {
      return runMovesOf();
    },
    get supersededRunFailures() {
      return runMovesOf().flatMap((change) =>
        change.newState === "failed" &&
        change.providerFailureDetail?.includes("superseded by a rewind") === true
          ? [{ runId: change.runId, providerFailureDetail: change.providerFailureDetail }]
          : [],
      );
    },
    get sessionNotices() {
      return deliveries.flatMap((delivery) =>
        delivery.kind === "session_notice" ? [delivery.notice] : [],
      );
    },
    daemonTurnRuns,
    processExitRunEnds,
    settledOutputSpeeds,
    relaunches,
    permissionAsks,
    questions,
    reviewerDenials,
    runScheduledRestarts: () => {
      const due = scheduledRestarts.splice(0);
      for (const restart of due) {
        restart();
      }
      return due.length;
    },
  };
  return harness;
}

/** A sandboxed posture with one writable root. */
export const SANDBOXED_POSTURE: ExecutionPosture = {
  mode: "sandboxed",
  credentialPolicyRef: "policy://default",
  writableRoots: ["/workspace"],
};

/** Returns the channel the transport spawned at `index`, failing the test if there is none. */
export function spawnedChannel(harness: LifecycleHarness, index = 0): FakeClaudeProviderProcess {
  const channel = harness.transport.spawnedChannels.at(index);
  if (channel === undefined) {
    throw new Error(`expected a spawned channel at index ${index}`);
  }
  return channel;
}

/** Creates the test session and returns its channel. */
export async function createLiveSession(
  harness: LifecycleHarness,
  params: Partial<CreateSessionParams> = {},
): Promise<FakeClaudeProviderProcess> {
  await harness.lifecycle.createSession({ ...buildCreateSessionParams(), ...params });
  return spawnedChannel(harness, -1);
}

/** Resolves `runId` onto a session, as the daemon does before the driver starts it. */
export function armRunDispatch(
  harness: LifecycleHarness,
  runId: RunId = TEST_RUN_ID,
  openingText = "review the diff",
  sessionId: SessionId = TEST_SESSION_ID,
): void {
  harness.runDispatchResolver.dispatchByRunId.set(runId, {
    sessionId,
    bindingId: TEST_BINDING_ID,
    openingText,
    messageId: TEST_MESSAGE_ID,
  });
}

/** Creates the test session, starts the test run on it with `openingText`, returns the channel. */
export async function startLiveRun(
  harness: LifecycleHarness,
  openingText = "review the diff",
): Promise<FakeClaudeProviderProcess> {
  const channel = await createLiveSession(harness);
  armRunDispatch(harness, TEST_RUN_ID, openingText);
  await harness.lifecycle.startRun(buildStartRunParams());
  return channel;
}

/** Rewinds the test session to position 4, which forks a fresh provider process. */
export async function rewindTestSession(
  harness: LifecycleHarness,
): Promise<MoveSessionToForkResult> {
  return await harness.lifecycle.moveSessionToFork({
    sessionId: TEST_SESSION_ID,
    bindingId: "binding-predecessor",
    position: 4,
  });
}

/** Resumes the test session from an earlier provider session. */
export async function resumeTestSession(
  harness: LifecycleHarness,
  params: Partial<ResumeSessionParams> = {},
): Promise<DriverResumeResult> {
  return await harness.lifecycle.resumeSession({
    model: TEST_MODEL,
    largerWindow: undefined,
    mode: "build",
    sessionId: TEST_SESSION_ID,
    resumeHandle: "provider-session-earlier",
    ...params,
  });
}

/** A promise held open until `release` is called, for parking a transition mid-flight. */
export function openGate(): { readonly gate: Promise<void>; readonly release: () => void } {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}
