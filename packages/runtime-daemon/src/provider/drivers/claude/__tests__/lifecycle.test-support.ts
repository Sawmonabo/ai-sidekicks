// Shared setup for the `lifecycle.ts` tests: a lifecycle wired to the transport and dispatch
// doubles, plus the arrangements most tests open with.

import type { ExecutionPosture, RunId } from "@ai-sidekicks/contracts/provider/driver/driver";
import type { SessionId } from "@ai-sidekicks/contracts/session/session";

import type { DriverDiagnosticsEmitter } from "../../../driver-diagnostics.js";
import type {
  CreateSessionParams,
  DriverResumeResult,
  ForkConversationResult,
  ResumeSessionParams,
} from "../../../provider-driver.js";
import { makeSilentDriverDiagnostics } from "../../../__fixtures__/silent-driver-diagnostics.js";
import { ClaudeSessionLifecycle } from "../lifecycle.js";
import type { ClaudeSessionLifecycleDependencies } from "../session-state.js";
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
} from "./claude-test-doubles.js";

/** A lifecycle under test together with the doubles and recorders it was built over. */
export interface LifecycleHarness {
  readonly lifecycle: ClaudeSessionLifecycle;
  readonly transport: FakeClaudeSessionTransport;
  readonly runDispatchResolver: FakeClaudeRunDispatchResolver;
  readonly diagnostics: DriverDiagnosticsEmitter;
  /** Each text-neutralization failure the lifecycle reported for a swallowed turn. */
  readonly textNeutralizationFailures: {
    readonly sessionId: SessionId;
    readonly runId: RunId;
    readonly providerFailureDetail: string;
  }[];
}

/** Builds a lifecycle over fresh doubles; `overrides` replace individual dependencies. */
export function buildHarness(
  overrides: Partial<ClaudeSessionLifecycleDependencies> = {},
): LifecycleHarness {
  const transport = new FakeClaudeSessionTransport();
  const runDispatchResolver = new FakeClaudeRunDispatchResolver();
  const textNeutralizationFailures: LifecycleHarness["textNeutralizationFailures"] = [];
  const dependencies: ClaudeSessionLifecycleDependencies = {
    transport,
    runDispatchResolver,
    diagnostics: makeSilentDriverDiagnostics(),
    mintProviderSessionId: () => TEST_PINNED_PROVIDER_SESSION_ID,
    mintBindingId: () => TEST_BINDING_ID,
    onTextNeutralizationFailure: (sessionId, runId, failure) => {
      textNeutralizationFailures.push({
        sessionId,
        runId,
        providerFailureDetail: failure.providerFailureDetail,
      });
    },
    ...overrides,
  };
  return {
    lifecycle: new ClaudeSessionLifecycle(dependencies),
    transport,
    runDispatchResolver,
    diagnostics: dependencies.diagnostics,
    textNeutralizationFailures,
  };
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
  harness.runDispatchResolver.dispatchByRunId.set(runId, { sessionId, openingText });
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
): Promise<ForkConversationResult> {
  return await harness.lifecycle.forkConversation({
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
