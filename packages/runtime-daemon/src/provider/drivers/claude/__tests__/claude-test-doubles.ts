// Typed test doubles for the Claude driver bands (Plan-005 Phase 3, T3.6 + T3.7).
//
// Every double implements the REAL port from `lifecycle.ts`, so a drifted port
// signature fails the typecheck rather than silently passing a test against a
// shape that no longer exists. Nothing here spawns a process, touches the
// filesystem, or reads an environment variable.

import type {
  ApplyInterventionParams,
  ChannelId,
  CreateSessionParams,
  RunId,
  SessionId,
  StartRunParams,
} from "@ai-sidekicks/contracts";

import type {
  ClaudeChannelDisposalReason,
  ClaudeControlRequest,
  ClaudeControlResponse,
  ClaudeResumedSessionAttachment,
  ClaudeRunDispatch,
  ClaudeRunDispatchResolver,
  ClaudeSessionAttachment,
  ClaudeSessionChannel,
  ClaudeSessionResumeRequest,
  ClaudeSessionSpawnRequest,
  ClaudeSessionTransport,
  ClaudeUserTextFrame,
} from "../lifecycle.js";

export const TEST_SESSION_ID: SessionId = "session-1" as SessionId;
export const TEST_CHANNEL_ID: ChannelId = "channel-1" as ChannelId;
export const TEST_RUN_ID: RunId = "run-1" as RunId;
export const TEST_SECOND_RUN_ID: RunId = "run-2" as RunId;
export const TEST_PINNED_PROVIDER_SESSION_ID: string = "provider-session-pinned";
export const TEST_BINDING_ID: string = "binding-1";

export class FakeClaudeSessionChannel implements ClaudeSessionChannel {
  readonly providerSessionId: string;
  readonly sentTextFrames: ClaudeUserTextFrame[] = [];
  readonly controlRequests: ClaudeControlRequest[] = [];
  readonly disposals: ClaudeChannelDisposalReason[] = [];
  controlResponse: ClaudeControlResponse = { subtype: "success" };
  controlRequestFailure: Error | undefined = undefined;
  sendUserTextFailure: Error | undefined = undefined;
  disposeFailure: Error | undefined = undefined;

  constructor(providerSessionId: string) {
    this.providerSessionId = providerSessionId;
  }

  get outboundCallCount(): number {
    return this.sentTextFrames.length + this.controlRequests.length;
  }

  async sendUserText(frame: ClaudeUserTextFrame): Promise<void> {
    if (this.sendUserTextFailure !== undefined) {
      throw this.sendUserTextFailure;
    }
    this.sentTextFrames.push(frame);
    await Promise.resolve();
  }

  async sendControlRequest(request: ClaudeControlRequest): Promise<ClaudeControlResponse> {
    this.controlRequests.push(request);
    if (this.controlRequestFailure !== undefined) {
      throw this.controlRequestFailure;
    }
    await Promise.resolve();
    return this.controlResponse;
  }

  // Implements the `onTurnTerminal` transport obligation rather than exposing a
  // bare "fire the listener" switch: `emitStreamFrame` owns the terminal-vs-
  // non-terminal discriminant exactly as a real transport does, so a test that
  // drives a `result/*` frame exercises that decision instead of asserting it.
  onTurnTerminal(listener: () => void): void {
    this.turnTerminalListener = listener;
  }

  turnTerminalListener: (() => void) | undefined = undefined;

  emitStreamFrame(frameKind: string): void {
    if (!frameKind.startsWith("result/")) {
      return;
    }
    this.turnTerminalListener?.();
  }

  // Parks dispose until a test releases it, so the CLOSING window can be held
  // open and inspected. The reason is recorded BEFORE parking: a test needs to
  // know the disposal was actually reached, not merely scheduled.
  disposeGate: Promise<void> | undefined = undefined;

  async dispose(reason: ClaudeChannelDisposalReason): Promise<void> {
    this.disposals.push(reason);
    await this.disposeGate;
    if (this.disposeFailure !== undefined) {
      throw this.disposeFailure;
    }
    await Promise.resolve();
  }
}

export class FakeClaudeSessionTransport implements ClaudeSessionTransport {
  readonly spawnRequests: ClaudeSessionSpawnRequest[] = [];
  readonly resumeRequests: ClaudeSessionResumeRequest[] = [];
  readonly spawnedChannels: FakeClaudeSessionChannel[] = [];
  spawnFailure: Error | undefined = undefined;
  resumeFailure: Error | undefined = undefined;
  // When set, BOTH establishment paths park here until the test releases it. A
  // concurrency test needs two callers provably in flight at the same time; a
  // fake that merely yields a microtask makes that depend on how many ticks the
  // implementation happens to take, which is not a property worth asserting.
  establishmentGate: Promise<void> | undefined = undefined;
  // When set, the spawned/resumed process announces THIS id instead of the one
  // that was pinned or requested — the fresh-session-on-mismatch behaviour the
  // Claude CLI exhibits, and the mechanism I-005-5's identity gate catches.
  announcedProviderSessionId: string | undefined = undefined;
  resumedSessionPosition: number = 12;

  async spawnSession(request: ClaudeSessionSpawnRequest): Promise<ClaudeSessionAttachment> {
    this.spawnRequests.push(request);
    await this.establishmentGate;
    if (this.spawnFailure !== undefined) {
      throw this.spawnFailure;
    }
    await Promise.resolve();
    const announced = this.announcedProviderSessionId ?? request.providerSessionId;
    const channel = new FakeClaudeSessionChannel(announced);
    this.spawnedChannels.push(channel);
    return { providerSessionId: announced, channel };
  }

  async resumeSession(
    request: ClaudeSessionResumeRequest,
  ): Promise<ClaudeResumedSessionAttachment> {
    this.resumeRequests.push(request);
    await this.establishmentGate;
    if (this.resumeFailure !== undefined) {
      throw this.resumeFailure;
    }
    await Promise.resolve();
    const announced = this.announcedProviderSessionId ?? request.resumeHandle;
    const channel = new FakeClaudeSessionChannel(announced);
    this.spawnedChannels.push(channel);
    return {
      providerSessionId: announced,
      channel,
      sessionPosition: this.resumedSessionPosition,
    };
  }
}

export class FakeClaudeRunDispatchResolver implements ClaudeRunDispatchResolver {
  readonly dispatchByRunId: Map<RunId, ClaudeRunDispatch> = new Map();
  readonly resolvedRunIds: RunId[] = [];

  async resolveRunDispatch(params: StartRunParams): Promise<ClaudeRunDispatch | undefined> {
    this.resolvedRunIds.push(params.runId);
    await Promise.resolve();
    return this.dispatchByRunId.get(params.runId);
  }
}

export function buildCreateSessionParams(): CreateSessionParams {
  return { sessionId: TEST_SESSION_ID, config: { model: "claude-sonnet-4-5" } };
}

export function buildStartRunParams(): StartRunParams {
  return { runId: TEST_RUN_ID, channelId: TEST_CHANNEL_ID, agentConfig: {} };
}

export function buildSteerParams(content: string): ApplyInterventionParams {
  return {
    type: "steer",
    targetRunId: TEST_RUN_ID,
    expectedRunVersion: 3,
    clientIdempotencyKey: "3f1d2b4c-0000-4000-8000-000000000001",
    payload: { content },
  };
}

export function buildInterruptParams(): ApplyInterventionParams {
  return {
    type: "interrupt",
    targetRunId: TEST_RUN_ID,
    expectedRunVersion: 3,
    clientIdempotencyKey: "3f1d2b4c-0000-4000-8000-000000000002",
    payload: { reason: "participant pressed stop" },
  };
}

export function buildCancelParams(): ApplyInterventionParams {
  return {
    type: "cancel",
    targetRunId: TEST_RUN_ID,
    expectedRunVersion: 3,
    clientIdempotencyKey: "3f1d2b4c-0000-4000-8000-000000000003",
    payload: { reason: "participant cancelled the run" },
  };
}
