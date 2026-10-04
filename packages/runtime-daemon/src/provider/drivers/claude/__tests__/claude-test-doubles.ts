// Typed test doubles for the Claude driver. Each implements the real port from
// `session-transport.ts`, so a drifted signature fails the typecheck. Nothing here spawns a
// process, touches the filesystem or reads an environment variable.

import type { ApplyInterventionParams, RunId } from "@ai-sidekicks/contracts/provider-driver";
import type { SessionId } from "@ai-sidekicks/contracts/session";

import type { OutboundTextFrame } from "../../../outbound-frame.js";
import type { SpawnEnvPair } from "../../../spawn-env.js";
import { CLAUDE_DRIVER_DESCRIPTOR } from "../claude-driver-descriptor.js";
import type { ThreadFrameRoute } from "../../../thread-frame-router.js";
import type {
  ClaudeAuthProbeReading,
  ClaudeAuthProbeRequest,
  ClaudeChannelDisposalReason,
  ClaudeControlRequest,
  ClaudeControlResponse,
  ClaudeInboundFrameObservation,
  ClaudeResumedSessionAttachment,
  ClaudeRunDispatch,
  ClaudeRunDispatchResolver,
  ClaudeSessionAttachment,
  ClaudeProviderProcess,
  ClaudeSessionResumeRequest,
  ClaudeSessionRewindRequest,
  ClaudeSessionSpawnRequest,
  ClaudeSessionTransport,
  ClaudeUserTextDelivery,
  ClaudeUserTextWriteAttempt,
} from "../session-transport.js";
import type { CreateSessionParams, StartRunParams } from "../../../provider-driver.js";

/** The session id every test session uses. */
export const TEST_SESSION_ID: SessionId = "session-1" as SessionId;
/** The test session's model. */
export const TEST_MODEL = "claude-sonnet-4-5";
/** The run id of the first run in a test session. */
export const TEST_RUN_ID: RunId = "run-1" as RunId;
/** The run id of a second run in the same test session. */
export const TEST_SECOND_RUN_ID: RunId = "run-2" as RunId;
/** The provider session id the driver pins when a test mints one. */
export const TEST_PINNED_PROVIDER_SESSION_ID: string = "provider-session-pinned";
/** The binding id a test driver mints. */
export const TEST_BINDING_ID: string = "binding-1";

/**
 * The route decisions that reach the normalize consumer, mirrored from the DELIVER column of
 * {@link ClaudeProviderProcess.onInboundFrame}. Delivering only `project` would enforce a rule the
 * lifecycle does not have.
 */
const DELIVERED_ROUTE_DECISIONS: ReadonlySet<ThreadFrameRoute["decision"]> = new Set([
  "project",
  "route-connection-scoped",
  "carve-out-interactive-request",
]);

/** In-memory channel that records every write and control request and lets a test drive frames. */
export class FakeClaudeProviderProcess implements ClaudeProviderProcess {
  readonly providerSessionId: string;
  readonly sentTextFrames: OutboundTextFrame[] = [];
  readonly controlRequests: ClaudeControlRequest[] = [];
  readonly disposals: ClaudeChannelDisposalReason[] = [];
  controlResponse: ClaudeControlResponse = { subtype: "success" };
  /** A write failure the double reports, as the port obliges a transport to. */
  sendUserTextFailure: Error | undefined = undefined;
  /**
   * How `sendUserTextFailure` is classified. Defaults to fail-closed: `unsent` claims the bytes
   * never left, and a test must claim that explicitly.
   */
  sendUserTextDelivery: ClaudeUserTextDelivery = "indeterminate";
  /** A write failure the double throws instead of reporting, like a transport breaking the port. */
  sendUserTextRejection: Error | undefined = undefined;
  /** Whether a turn terminal can still arrive, as the port defines it. */
  isClosed = false;
  disposeFailure: Error | undefined = undefined;
  /** Every `sendUserText` call, failures included; `sentTextFrames` holds only written frames. */
  sendUserTextAttempts = 0;

  constructor(providerSessionId: string) {
    this.providerSessionId = providerSessionId;
  }

  get outboundCallCount(): number {
    return this.sentTextFrames.length + this.controlRequests.length;
  }

  /** The bytes each written frame put on the wire, in order (`wireText`, not the author's text). */
  get sentWireTexts(): string[] {
    return this.sentTextFrames.map((frame) => frame.wireText);
  }

  /** The author's bytes behind each written frame; neutralization must never change them. */
  get sentAuthoredTexts(): string[] {
    return this.sentTextFrames.map((frame) => frame.authoredText);
  }

  async sendUserText(frame: OutboundTextFrame): Promise<ClaudeUserTextWriteAttempt> {
    this.sendUserTextAttempts += 1;
    if (this.sendUserTextRejection !== undefined) {
      throw this.sendUserTextRejection;
    }
    if (this.sendUserTextFailure !== undefined) {
      // A failed frame is not recorded, so `sentWireTexts` means "written", not "offered".
      await Promise.resolve();
      return {
        settled: "failed",
        delivery: this.sendUserTextDelivery,
        cause: this.sendUserTextFailure,
      };
    }
    this.sentTextFrames.push(frame);
    await Promise.resolve();
    return { settled: "written" };
  }

  async sendControlRequest(request: ClaudeControlRequest): Promise<ClaudeControlResponse> {
    this.controlRequests.push(request);
    await Promise.resolve();
    return this.controlResponse;
  }

  // Makes a transport refuse `onTurnTerminal` registration, the last step of the adoption window.
  // `emitStreamFrame` decides terminal versus non-terminal as a real transport does.
  onTurnTerminalFailure: Error | undefined = undefined;

  onTurnTerminal(listener: (terminalFrame: unknown) => void): void {
    if (this.onTurnTerminalFailure !== undefined) {
      throw this.onTurnTerminalFailure;
    }
    this.turnTerminalListener = listener;
  }

  turnTerminalListener: ((terminalFrame: unknown) => void) | undefined = undefined;

  /**
   * The terminal `result` body handed to the turn-terminal hook. When unset, a body with positive
   * turn evidence is used so an ordinary terminal does not trip the text-neutralization tripwire;
   * a tripwire test overrides it with a zero-turn or unrecognized body.
   */
  terminalFrameBody: unknown = undefined;

  onInboundFrame(observer: (observation: ClaudeInboundFrameObservation) => ThreadFrameRoute): void {
    this.inboundFrameObserver = observer;
  }

  inboundFrameObserver:
    | ((observation: ClaudeInboundFrameObservation) => ThreadFrameRoute)
    | undefined = undefined;

  /** The frames this double handed to its own normalize consumer. */
  readonly deliveredFrameKinds: string[] = [];

  /**
   * Drives one inbound stream frame as a real transport would: observe first, deliver only the
   * decisions in the DELIVER column of {@link ClaudeProviderProcess.onInboundFrame}, and call the
   * turn-terminal hook with the frame body for a `result/*` frame.
   */
  emitStreamFrame(
    frameKind: string,
    observationParts?: {
      readonly subagentId?: string | null;
      readonly cumulativeUsage?: ClaudeInboundFrameObservation["cumulativeUsage"];
      readonly subagentLifecycle?: ClaudeInboundFrameObservation["subagentLifecycle"];
      readonly handshake?: ClaudeInboundFrameObservation["handshake"];
      readonly compactionBoundary?: ClaudeInboundFrameObservation["compactionBoundary"];
    },
  ): ThreadFrameRoute {
    // Absent parts default to `null`: the observation is a closed shape under
    // `exactOptionalPropertyTypes`, so a key cannot be omitted.
    const observation: ClaudeInboundFrameObservation = {
      frameKind,
      subagentId: observationParts?.subagentId ?? null,
      cumulativeUsage: observationParts?.cumulativeUsage ?? null,
      subagentLifecycle: observationParts?.subagentLifecycle ?? null,
      handshake: observationParts?.handshake ?? null,
      compactionBoundary: observationParts?.compactionBoundary ?? null,
    };
    const route: ThreadFrameRoute = this.inboundFrameObserver?.(observation) ?? {
      decision: "project",
    };
    if (!DELIVERED_ROUTE_DECISIONS.has(route.decision)) {
      return route;
    }
    this.deliveredFrameKinds.push(frameKind);
    if (frameKind.startsWith("result/")) {
      this.turnTerminalListener?.(
        this.terminalFrameBody ?? synthesizeTurnEvidenceResult(frameKind),
      );
    }
    return route;
  }

  // Parks `dispose` until a test releases it, so the closing window can be inspected. The reason
  // is recorded before parking, which shows the disposal was reached.
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

/** In-memory transport that records spawn, resume, rewind and probe requests and mints channels. */
export class FakeClaudeSessionTransport implements ClaudeSessionTransport {
  // Whether the transport writes the callback `--mcp-config`; a test sets `false` to model one
  // that does not.
  realizesCallbackToolRegistration: boolean = true;
  readonly spawnRequests: ClaudeSessionSpawnRequest[] = [];
  readonly resumeRequests: ClaudeSessionResumeRequest[] = [];
  readonly spawnedChannels: FakeClaudeProviderProcess[] = [];
  resumeFailure: Error | undefined = undefined;
  // When set, spawn, resume and rewind park here until released, so a concurrency test has two
  // callers provably in flight without depending on microtask counts.
  establishmentGate: Promise<void> | undefined = undefined;
  // Applied to every channel this transport mints.
  onTurnTerminalFailure: Error | undefined = undefined;
  // When set, the spawned or resumed process announces this id instead of the pinned or requested
  // one, as the Claude CLI does when it starts a fresh session on a mismatch.
  announcedProviderSessionId: string | undefined = undefined;
  resumedSessionPosition: number = 12;
  // Rewind defaults to the happy path: the fork announces a new provider session id, which the
  // driver's fork check requires.
  readonly rewindRequests: ClaudeSessionRewindRequest[] = [];
  rewindFailure: Error | undefined = undefined;
  // When set, the fork announces this id, modeling a provider that did not fork.
  announcedForkedProviderSessionId: string | undefined = undefined;
  // The zero-turn auth probe's outcome. A `ClaudeAuthenticationRequiredError` failure models a
  // determinate logged-out reading; any other failure models a probe that could not be taken.
  probeAuthFailure: Error | undefined = undefined;
  probeAuthCallCount: number = 0;

  /**
   * Refuses to start a child without the daemon's mandated environment pairs. A refusal rather
   * than a recording, because a spawn path that dropped the pairs would still return a working
   * channel and every other assertion would keep passing. Keyed on the canonical opt-out table so
   * the guard follows it.
   */
  #requireMandatedEnvironment(mandatedEnvironment: readonly SpawnEnvPair[]): void {
    for (const [name, value] of Object.entries(
      CLAUDE_DRIVER_DESCRIPTOR.autoUpdateOptOutEnvironment,
    )) {
      if (mandatedEnvironment.find((pair) => pair[0] === name)?.[1] !== value) {
        throw new Error(
          `A Claude child was started without the mandated ${name}=${value}, which the ` +
            `transport obligations forbid.`,
        );
      }
    }
  }

  async spawnSession(request: ClaudeSessionSpawnRequest): Promise<ClaudeSessionAttachment> {
    this.spawnRequests.push(request);
    this.#requireMandatedEnvironment(request.mandatedEnvironment);
    await this.establishmentGate;
    await Promise.resolve();
    const announced = this.announcedProviderSessionId ?? request.providerSessionId;
    const channel = new FakeClaudeProviderProcess(announced);
    channel.onTurnTerminalFailure = this.onTurnTerminalFailure;
    this.spawnedChannels.push(channel);
    return { providerSessionId: announced, channel };
  }

  async resumeSession(
    request: ClaudeSessionResumeRequest,
  ): Promise<ClaudeResumedSessionAttachment> {
    this.resumeRequests.push(request);
    this.#requireMandatedEnvironment(request.mandatedEnvironment);
    await this.establishmentGate;
    if (this.resumeFailure !== undefined) {
      throw this.resumeFailure;
    }
    await Promise.resolve();
    const announced = this.announcedProviderSessionId ?? request.resumeHandle;
    const channel = new FakeClaudeProviderProcess(announced);
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
  ): Promise<ClaudeResumedSessionAttachment> {
    this.rewindRequests.push(request);
    this.#requireMandatedEnvironment(request.mandatedEnvironment);
    await this.establishmentGate;
    if (this.rewindFailure !== undefined) {
      throw this.rewindFailure;
    }
    await Promise.resolve();
    const announced =
      this.announcedForkedProviderSessionId ?? `forked-${String(this.rewindRequests.length)}`;
    const channel = new FakeClaudeProviderProcess(announced);
    channel.onTurnTerminalFailure = this.onTurnTerminalFailure;
    this.spawnedChannels.push(channel);
    return {
      providerSessionId: announced,
      channel,
      sessionPosition: request.targetPosition,
    };
  }

  async probeAuth(request: ClaudeAuthProbeRequest): Promise<ClaudeAuthProbeReading> {
    this.probeAuthCallCount += 1;
    // Checked before the failure arms: a probe that could not be taken still started a child.
    this.#requireMandatedEnvironment(request.mandatedEnvironment);
    await Promise.resolve();
    if (this.probeAuthFailure !== undefined) {
      throw this.probeAuthFailure;
    }
    // Mints no channel: a probe that established a session would not be zero-turn.
    return {};
  }
}

/** Resolver that answers run dispatches from `dispatchByRunId`. */
export class FakeClaudeRunDispatchResolver implements ClaudeRunDispatchResolver {
  readonly dispatchByRunId: Map<RunId, ClaudeRunDispatch> = new Map();

  async resolveRunDispatch(params: StartRunParams): Promise<ClaudeRunDispatch | undefined> {
    await Promise.resolve();
    return this.dispatchByRunId.get(params.runId);
  }
}

/** Minimal `createSession` params for the test session. */
export function buildCreateSessionParams(): CreateSessionParams {
  return { sessionId: TEST_SESSION_ID, model: TEST_MODEL, config: { model: TEST_MODEL } };
}

/** Minimal `startRun` params for the first test run. */
export function buildStartRunParams(): StartRunParams {
  return { runId: TEST_RUN_ID, agentConfig: {} };
}

/** A steer intervention on the first test run carrying `content`. */
export function buildSteerParams(content: string): ApplyInterventionParams {
  return {
    type: "steer",
    targetRunId: TEST_RUN_ID,
    expectedRunVersion: 3,
    clientIdempotencyKey: "3f1d2b4c-0000-4000-8000-000000000001",
    payload: { content },
  };
}

/** An interrupt intervention on the first test run. */
export function buildInterruptParams(): ApplyInterventionParams {
  return {
    type: "interrupt",
    targetRunId: TEST_RUN_ID,
    expectedRunVersion: 3,
    clientIdempotencyKey: "3f1d2b4c-0000-4000-8000-000000000002",
    payload: { reason: "user pressed stop" },
  };
}

/** A cancel intervention on the first test run. */
export function buildCancelParams(): ApplyInterventionParams {
  return {
    type: "cancel",
    targetRunId: TEST_RUN_ID,
    expectedRunVersion: 3,
    clientIdempotencyKey: "3f1d2b4c-0000-4000-8000-000000000003",
    payload: { reason: "user canceled the run" },
  };
}

/**
 * A `result` frame body with positive turn evidence: a real turn reports a non-zero turn count,
 * API duration and cost, and a populated per-model usage map, all together.
 */
function synthesizeTurnEvidenceResult(frameKind: string): Record<string, unknown> {
  return {
    type: "result",
    subtype: frameKind.slice("result/".length),
    is_error: frameKind !== "result/success",
    num_turns: 1,
    duration_api_ms: 2972,
    total_cost_usd: 0.67144,
    modelUsage: { "claude-fable-5": { inputTokens: 2, outputTokens: 98 } },
  };
}
