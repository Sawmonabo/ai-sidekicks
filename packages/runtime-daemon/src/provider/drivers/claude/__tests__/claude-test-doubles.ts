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
import { PROVIDER_AUTO_UPDATE_OPT_OUT_ENV, type SpawnEnvPair } from "../../../spawn-env.js";
import type { ThreadFrameRoute } from "../../../thread-frame-router.js";
import type {
  ClaudeAuthProbeReading,
  ClaudeAuthProbeRequest,
  ClaudeChannelDisposalReason,
  ClaudeControlRequest,
  ClaudeControlResponse,
  ClaudeInboundFrameObservation,
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
  ClaudeUserTextDelivery,
  ClaudeUserTextFrame,
  ClaudeUserTextWriteAttempt,
} from "../lifecycle.js";

export const TEST_SESSION_ID: SessionId = "session-1" as SessionId;
export const TEST_CHANNEL_ID: ChannelId = "channel-1" as ChannelId;
export const TEST_RUN_ID: RunId = "run-1" as RunId;
export const TEST_SECOND_RUN_ID: RunId = "run-2" as RunId;
export const TEST_PINNED_PROVIDER_SESSION_ID: string = "provider-session-pinned";
export const TEST_BINDING_ID: string = "binding-1";

/**
 * The route decisions the transport obligation says reach the normalize
 * consumer, mirrored from {@link ClaudeSessionChannel.onInboundFrame}'s DELIVER
 * column. Held here as data so the double cannot drift into "only `project`",
 * which is the exact reading that once made this double enforce a rule the band
 * does not have.
 */
const DELIVERED_ROUTE_DECISIONS: ReadonlySet<ThreadFrameRoute["decision"]> = new Set([
  "project",
  "route-connection-scoped",
  "carve-out-interactive-request",
]);

export class FakeClaudeSessionChannel implements ClaudeSessionChannel {
  readonly providerSessionId: string;
  readonly sentTextFrames: ClaudeUserTextFrame[] = [];
  readonly controlRequests: ClaudeControlRequest[] = [];
  readonly disposals: ClaudeChannelDisposalReason[] = [];
  controlResponse: ClaudeControlResponse = { subtype: "success" };
  controlRequestFailure: Error | undefined = undefined;
  /**
   * A write failure the double REPORTS, the way the port obliges a transport to.
   *
   * Paired with `sendUserTextDelivery` rather than carrying its own
   * classification, so a test that sets a failure and forgets the delivery gets
   * the port's own fail-closed default instead of the convenient arm.
   */
  sendUserTextFailure: Error | undefined = undefined;
  /**
   * How `sendUserTextFailure` is classified. Defaults to the fail-closed arm for
   * the same reason the real transport's default is: `unsent` is a positive
   * claim about bytes, and a double that volunteered it would let a test assert
   * the forgiving path without anyone having claimed the bytes never left.
   */
  sendUserTextDelivery: ClaudeUserTextDelivery = "indeterminate";
  /**
   * A write failure the double RAISES instead of reporting — a transport in
   * breach of the port's obligation. Distinct from `sendUserTextFailure`
   * precisely so the driver's containment of a broken contract is reachable
   * from a test rather than taken on trust.
   */
  sendUserTextRejection: Error | undefined = undefined;
  /**
   * Whether a turn terminal can still arrive, as the port defines it. `false`
   * while the channel is serviceable, which is the state a live double is in.
   */
  isClosed = false;
  disposeFailure: Error | undefined = undefined;

  constructor(providerSessionId: string) {
    this.providerSessionId = providerSessionId;
  }

  get outboundCallCount(): number {
    return this.sentTextFrames.length + this.controlRequests.length;
  }

  /**
   * The bytes each frame actually put on the wire, in order.
   *
   * Read from `wireText` rather than from the frame object, which is what makes
   * an assertion on it a BYTE-level assertion: a neutralized frame and its
   * author's text are different strings, and a test comparing whole frame
   * objects would pass while reading neither.
   */
  get sentWireTexts(): string[] {
    return this.sentTextFrames.map((frame) => frame.wireText);
  }

  /**
   * The author's bytes behind each frame, in order — what the daemon persists,
   * events, replays, and rewinds to. Neutralization must never touch these.
   */
  get sentAuthoredTexts(): string[] {
    return this.sentTextFrames.map((frame) => frame.authoredText);
  }

  async sendUserText(frame: ClaudeUserTextFrame): Promise<ClaudeUserTextWriteAttempt> {
    if (this.sendUserTextRejection !== undefined) {
      throw this.sendUserTextRejection;
    }
    if (this.sendUserTextFailure !== undefined) {
      // The frame is deliberately NOT recorded on either failure arm. A double
      // that recorded it would make `sentWireTexts` mean "offered" rather than
      // "written", and every assertion that nothing reached the provider would
      // pass for the wrong reason.
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

  onTurnTerminal(listener: (terminalFrame: unknown) => void): void {
    if (this.onTurnTerminalFailure !== undefined) {
      throw this.onTurnTerminalFailure;
    }
    this.turnTerminalListener = listener;
  }

  turnTerminalListener: ((terminalFrame: unknown) => void) | undefined = undefined;

  /**
   * The terminal `result` body this double hands the driver's turn-terminal
   * hook, overridable per test.
   *
   * The default carries POSITIVE turn evidence, so an ordinary terminal does
   * not trip the T3.18 tripwire and every test in this file that merely needs a
   * turn to end keeps meaning what it meant. A test exercising the tripwire
   * overrides it — with a zero-turn body, or with a shape the classifier does
   * not recognize.
   *
   * The double supplies a body at all because the transport obligation says it
   * must: the hook carries the frame, and a transport that passed nothing would
   * be handing the driver an unrecognized envelope on every turn.
   */
  terminalFrameBody: unknown = undefined;

  // The `onInboundFrame` half of the same discipline. Registration failure is
  // kept on its own switch because the two hooks register at different points
  // of the adoption window, and a test that models a transport refusing one
  // must not be forced to model it refusing both.
  onInboundFrameFailure: Error | undefined = undefined;

  onInboundFrame(observer: (observation: ClaudeInboundFrameObservation) => ThreadFrameRoute): void {
    if (this.onInboundFrameFailure !== undefined) {
      throw this.onInboundFrameFailure;
    }
    this.inboundFrameObserver = observer;
  }

  inboundFrameObserver:
    | ((observation: ClaudeInboundFrameObservation) => ThreadFrameRoute)
    | undefined = undefined;

  /** Every observation this double drove, paired with the route it was given. */
  readonly observedRoutes: {
    readonly observation: ClaudeInboundFrameObservation;
    readonly route: ThreadFrameRoute;
  }[] = [];

  /** The frames this double handed to its own normalize consumer. */
  readonly deliveredFrameKinds: string[] = [];

  /**
   * Drive one inbound stream frame, HONOURING the transport obligation in full.
   *
   * The double observes before delivering and delivers exactly the decisions
   * {@link ClaudeSessionChannel.onInboundFrame}'s DELIVER column names, because
   * a double that delivered regardless — or that delivered only `project` —
   * would let a routing regression pass every test in this file. The
   * terminal-vs-non-terminal discriminant stays here too: a real transport
   * knows which terminal it saw, and it is the transport that hands the hook
   * the terminal frame body.
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
    // Every optional part defaults to `null` rather than being omitted: the
    // observation is a closed shape under `exactOptionalPropertyTypes`, so an
    // omitted key would not compile, and a default of `null` keeps every
    // existing call site meaning exactly what it meant before the shape grew.
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
    this.observedRoutes.push({ observation, route });
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
  // Mutable so a test can model BOTH transports: one that writes the callback
  // `--mcp-config` and one that does not. Defaults `true` because every
  // pre-existing spawn assertion in this suite describes a transport that
  // realizes the registration, and a default of `false` would silently rewrite
  // what those tests are about instead of adding the new arm beside them.
  realizesCallbackToolRegistration: boolean = true;
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
  readonly probeAuthRequests: ClaudeAuthProbeRequest[] = [];

  /**
   * Refuses to start a child that was not handed the daemon's mandated pairs.
   *
   * The port's obligation modelled as a REFUSAL rather than as a recording,
   * because a recording only proves what some test remembers to read back. A
   * spawn path that quietly stopped supplying the pairs would still return a
   * working channel, and every assertion about the session it established would
   * keep passing — the lost suppression is invisible from every other property a
   * test could check. Here it is not invisible: nothing starts without them.
   *
   * Keyed on the canonical opt-out table rather than on a written-out pair, so a
   * re-graded provider entry moves this guard with it instead of leaving it
   * asserting a value the corpus no longer mandates.
   */
  #requireMandatedEnvironment(mandatedEnvironment: readonly SpawnEnvPair[]): void {
    for (const [name, value] of Object.entries(PROVIDER_AUTO_UPDATE_OPT_OUT_ENV.claude)) {
      if (mandatedEnvironment.find((pair) => pair[0] === name)?.[1] !== value) {
        throw new Error(
          `A Claude child was started without the mandated ${name}=${value}, which the transport obligations forbid.`,
        );
      }
    }
  }

  async spawnSession(request: ClaudeSessionSpawnRequest): Promise<ClaudeSessionAttachment> {
    this.spawnRequests.push(request);
    this.#requireMandatedEnvironment(request.mandatedEnvironment);
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
    this.#requireMandatedEnvironment(request.mandatedEnvironment);
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
    this.#requireMandatedEnvironment(request.mandatedEnvironment);
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

  async probeAuth(request: ClaudeAuthProbeRequest): Promise<ClaudeAuthProbeReading> {
    this.probeAuthCallCount += 1;
    this.probeAuthRequests.push(request);
    // Checked BEFORE the failure arms, because a probe that could not be taken
    // still started a child: the obligation is on the spawn, not on the answer.
    this.#requireMandatedEnvironment(request.mandatedEnvironment);
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

/**
 * A `result` frame body carrying positive turn evidence, for the default
 * terminal a test drives when the tripwire is not what it is testing.
 *
 * The numbers are shaped after the measured ordinary-turn reading recorded in
 * `docs/reference/provider-wire/claude.md` rather than invented: a real turn
 * reports a non-zero turn count, a non-zero API duration, a non-zero cost, and
 * a populated per-model usage map, and all four move together.
 */
export function synthesizeTurnEvidenceResult(frameKind: string): Record<string, unknown> {
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
