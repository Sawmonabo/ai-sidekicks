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

import { DriverDiagnosticsEmitter } from "../../../driver-diagnostics.js";
import type {
  ClaudeAuthProbeReading,
  ClaudeChannelDisposalReason,
  ClaudeControlRequest,
  ClaudeControlResponse,
  ClaudeResumedSessionAttachment,
  ClaudeRewoundSessionAttachment,
  ClaudeRunDispatch,
  ClaudeRunDispatchResolver,
  ClaudeSessionAttachment,
  ClaudeSessionChannel,
  ClaudeSessionResumeRequest,
  ClaudeSessionRewindRequest,
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
  // Lets a test model a transport that refuses registration — the last thing
  // that runs inside the driver's adoption window.
  onTurnTerminalFailure: Error | undefined = undefined;

  onTurnTerminal(listener: () => void): void {
    if (this.onTurnTerminalFailure !== undefined) {
      throw this.onTurnTerminalFailure;
    }
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
  // Applied to every channel this transport mints, so a test can arrange the
  // failure before the channel it will land on exists.
  onTurnTerminalFailure: Error | undefined = undefined;
  // When set, the spawned/resumed process announces THIS id instead of the one
  // that was pinned or requested — the fresh-session-on-mismatch behaviour the
  // Claude CLI exhibits, and the mechanism I-005-5's identity gate catches.
  announcedProviderSessionId: string | undefined = undefined;
  resumedSessionPosition: number = 12;
  // The rewind (T3.15 leg 1) leg. Defaults model the honest happy path: a fork
  // announces a NEW provider session id, which is exactly what the driver's
  // fork check requires — a fake that echoed the handle back would make every
  // rewind test exercise the refusal arm instead.
  readonly rewindRequests: ClaudeSessionRewindRequest[] = [];
  rewindFailure: Error | undefined = undefined;
  rewoundSessionPosition: number | undefined = undefined;
  mintForkedProviderSessionId: () => string = (): string =>
    `forked-${String(this.rewindRequests.length)}`;
  // When set, the fork announces THIS id — the "provider did not fork" arm.
  announcedForkedProviderSessionId: string | undefined = undefined;
  // When true, the fork hands back the SAME channel object it was rewinding, so
  // the disposal carve-out in the not-forked arm is reachable.
  rewindReturnsPredecessorChannel: boolean = false;
  // The zero-turn auth probe's outcome. Set the failure to drive the two
  // negative arms: a `ClaudeAuthenticationRequiredError` for a determinate
  // logged-out reading, anything else for a probe that could not be taken.
  probeAuthFailure: Error | undefined = undefined;
  probeAuthDetail: string | undefined = undefined;
  probeAuthCallCount: number = 0;

  async spawnSession(request: ClaudeSessionSpawnRequest): Promise<ClaudeSessionAttachment> {
    this.spawnRequests.push(request);
    await this.establishmentGate;
    if (this.spawnFailure !== undefined) {
      throw this.spawnFailure;
    }
    await Promise.resolve();
    const announced = this.announcedProviderSessionId ?? request.providerSessionId;
    const channel = new FakeClaudeSessionChannel(announced);
    channel.onTurnTerminalFailure = this.onTurnTerminalFailure;
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
    channel.onTurnTerminalFailure = this.onTurnTerminalFailure;
    this.spawnedChannels.push(channel);
    return {
      providerSessionId: announced,
      channel,
      sessionPosition: this.resumedSessionPosition,
    };
  }

  async rewindSession(
    request: ClaudeSessionRewindRequest,
  ): Promise<ClaudeRewoundSessionAttachment> {
    this.rewindRequests.push(request);
    await this.establishmentGate;
    if (this.rewindFailure !== undefined) {
      throw this.rewindFailure;
    }
    await Promise.resolve();
    const announced = this.announcedForkedProviderSessionId ?? this.mintForkedProviderSessionId();
    if (this.rewindReturnsPredecessorChannel) {
      const predecessor = this.spawnedChannels[this.spawnedChannels.length - 1];
      if (predecessor !== undefined) {
        return {
          providerSessionId: announced,
          channel: predecessor,
          sessionPosition: this.rewoundSessionPosition ?? request.targetPosition,
        };
      }
    }
    const channel = new FakeClaudeSessionChannel(announced);
    channel.onTurnTerminalFailure = this.onTurnTerminalFailure;
    this.spawnedChannels.push(channel);
    return {
      providerSessionId: announced,
      channel,
      sessionPosition: this.rewoundSessionPosition ?? request.targetPosition,
    };
  }

  async probeAuth(): Promise<ClaudeAuthProbeReading> {
    this.probeAuthCallCount += 1;
    await Promise.resolve();
    if (this.probeAuthFailure !== undefined) {
      throw this.probeAuthFailure;
    }
    // Spawns nothing and mints no channel, which is the point being modelled:
    // a probe that established a session would not be a zero-turn probe.
    return this.probeAuthDetail === undefined ? {} : { detail: this.probeAuthDetail };
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

/**
 * The T3.11 diagnostic band, silenced. The default log sink writes to the
 * console, which would make every policy diagnostic a line of test output; the
 * emitter still retains its records, which is what the assertions read.
 */
export function makeSilentDriverDiagnostics(): DriverDiagnosticsEmitter {
  return new DriverDiagnosticsEmitter({
    logSink: { record: () => undefined },
    counterSink: { increment: () => undefined },
  });
}
