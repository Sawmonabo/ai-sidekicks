// Typed test doubles for the Claude driver. Each implements the real port from
// `session/transport.ts`, so a drifted signature fails the typecheck. Nothing here spawns a
// process, touches the filesystem or reads an environment variable.

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import type {
  ApplyInterventionParams,
  InterruptPendingChoice,
} from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { ProcessExit } from "@ai-sidekicks/contracts/run/control";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { OutboundText } from "../../../outbound-text.js";
import type { SpawnEnvPair } from "../../../spawn-env.js";
import { CLAUDE_DRIVER_DESCRIPTOR } from "../descriptor.js";
import type { ThreadFrameRoute } from "../../../thread-frame-router.js";
import {
  composeClaudeUserFrame,
  type ClaudeAuthProbeReading,
  type ClaudeAuthProbeRequest,
  type ClaudeChannelDisposalReason,
  type ClaudeCreationFiguresReading,
  type ClaudeCreationFiguresRequest,
  type ClaudeReplyReserveReads,
  type ClaudeSessionFolderReadRequest,
  type ClaudeControlRequest,
  type ClaudeControlResponse,
  type ClaudeFastModeDeclaration,
  type ClaudeInboundFrameObservation,
  type ClaudeInboundRequestEvent,
  type ClaudeInitializeDeclaration,
  type ClaudeModelCatalogReading,
  type ClaudeOfferedModel,
  type ClaudeOneTurnReply,
  type ClaudeOneTurnRequest,
  type ClaudeResumedSessionAttachment,
  type ClaudeRunDispatch,
  type ClaudeRunDispatchResolver,
  type ClaudeSessionAttachment,
  type ClaudeProviderProcess,
  type ClaudeSessionResumeRequest,
  type ClaudeSessionRewindRequest,
  type ClaudeSessionSpawnRequest,
  type ClaudeSessionTransport,
  type ClaudeUserTextDelivery,
  type ClaudeUserFrame,
  type ClaudeUserTextWriteAttempt,
} from "../session/transport.js";
import type { CreateSessionParams, StartRunParams } from "../../contract.js";
import type { DaemonTurnBinding } from "../../run-control.js";

/** The session id every test session uses. */
export const TEST_SESSION_ID: SessionId = "session-1" as SessionId;
/** The agent every test session runs. */
const TEST_AGENT_ID: AgentId = "agent-1" as AgentId;
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
  /** Each written text as the user frame a real transport puts on stdin. */
  readonly sentUserFrames: ClaudeUserFrame[] = [];
  readonly controlRequests: ClaudeControlRequest[] = [];
  readonly disposals: ClaudeChannelDisposalReason[] = [];
  controlResponse: ClaudeControlResponse = { subtype: "success" };
  /** An answer for one subtype, over `controlResponse`. */
  readonly controlResponseBySubtype: Map<ClaudeControlRequest["subtype"], ClaudeControlResponse> =
    new Map();
  /** A rejection every control request settles with, as on an expired deadline. */
  controlRequestFailure: Error | undefined = undefined;
  /** Every answer the daemon gave a request this process sent it, in order. */
  readonly answeredRequests: { requestId: string; response: Record<string, unknown> }[] = [];
  /** How many times the process was stopped with SIGTERM. */
  terminations = 0;
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
  /** Every `sendUserText` call, failures included; `sentUserFrames` holds only written frames. */
  sendUserTextAttempts = 0;

  constructor(providerSessionId: string) {
    this.providerSessionId = providerSessionId;
  }

  get outboundCallCount(): number {
    return this.sentUserFrames.length + this.controlRequests.length;
  }

  /** The text each written frame carried, in order. */
  get sentTexts(): string[] {
    return this.sentUserFrames.map((frame) => frame.message.content);
  }

  async sendUserText(
    outboundText: OutboundText,
    messageUuid: string,
  ): Promise<ClaudeUserTextWriteAttempt> {
    this.sendUserTextAttempts += 1;
    if (this.sendUserTextRejection !== undefined) {
      throw this.sendUserTextRejection;
    }
    if (this.sendUserTextFailure !== undefined) {
      // A failed frame is not recorded, so `sentUserFrames` means "written", not "offered".
      await Promise.resolve();
      return {
        settled: "failed",
        delivery: this.sendUserTextDelivery,
        cause: this.sendUserTextFailure,
      };
    }
    this.sentUserFrames.push(composeClaudeUserFrame(outboundText, messageUuid));
    await Promise.resolve();
    return { settled: "written" };
  }

  // Parks each control request's answer until a test releases it, so a close or rewind can land
  // while the request is in flight.
  controlResponseGate: Promise<void> | undefined = undefined;

  async sendControlRequest(request: ClaudeControlRequest): Promise<ClaudeControlResponse> {
    this.controlRequests.push(request);
    await this.controlResponseGate;
    await Promise.resolve();
    if (this.controlRequestFailure !== undefined) {
      throw this.controlRequestFailure;
    }
    return this.controlResponseBySubtype.get(request.subtype) ?? this.controlResponse;
  }

  inboundRequestObserver: ((event: ClaudeInboundRequestEvent) => void) | undefined = undefined;

  onInboundRequest(observer: (event: ClaudeInboundRequestEvent) => void): void {
    this.inboundRequestObserver = observer;
  }

  /** Sends the daemon one request, as Claude Code does on its stdout. */
  emitInboundRequest(event: ClaudeInboundRequestEvent): void {
    this.inboundRequestObserver?.(event);
  }

  async answerInboundRequest(requestId: string, response: Record<string, unknown>): Promise<void> {
    this.answeredRequests.push({ requestId, response });
    await Promise.resolve();
  }

  exitObserver: ((exit: ProcessExit) => void) | undefined = undefined;

  onExit(observer: (exit: ProcessExit) => void): void {
    this.exitObserver = observer;
  }

  /** Ends the process with `exit`, as one that died on its own does. */
  emitExit(exit: ProcessExit): void {
    this.isClosed = true;
    this.exitObserver?.(exit);
  }

  async terminate(): Promise<void> {
    this.terminations += 1;
    await Promise.resolve();
    this.emitExit({ signal: "SIGTERM", outputTail: "(no output)" });
  }

  deliveredFrameConsumer:
    | ((frame: Readonly<Record<string, unknown>>, route: ThreadFrameRoute) => void)
    | undefined = undefined;

  onDeliveredFrame(
    consumer: (frame: Readonly<Record<string, unknown>>, route: ThreadFrameRoute) => void,
  ): void {
    this.deliveredFrameConsumer = consumer;
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
   * decisions in the DELIVER column of {@link ClaudeProviderProcess.onInboundFrame} with the frame
   * body, and then call the turn-terminal hook for a `result/*` frame. `frame` is the body; by
   * default it carries only the type and subtype `frameKind` names.
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
    frame?: Readonly<Record<string, unknown>>,
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
    const [type, subtype] = frameKind.split("/");
    const body = frame ?? { type, ...(subtype === undefined ? {} : { subtype }) };
    this.deliveredFrameConsumer?.(body, route);
    // A helper's `result` ends the helper's work, never the session's turn.
    if (type === "result" && (observationParts?.subagentId ?? null) === null) {
      this.turnTerminalListener?.(body);
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
  controlResponse: ClaudeControlResponse = { subtype: "success" };
  // When set, the spawned or resumed process announces this id instead of the pinned or requested
  // one, as the Claude CLI does when it starts a fresh session on a mismatch.
  announcedProviderSessionId: string | undefined = undefined;
  resumedSessionPosition: number = 12;
  // What every attached process's `initialize` reply reports; none by default.
  initializeFastMode: ClaudeFastModeDeclaration = {
    fastModeState: null,
    fastModeDisabledReason: null,
  };
  initializeAutoModeModels: ReadonlySet<string> = new Set();
  initializeOutputStyles: readonly string[] = [];
  initializeOutputStyle: string | undefined = undefined;
  initializeModels: readonly ClaudeOfferedModel[] = [];
  // What the control-only catalog process reports.
  modelCatalogReading: ClaudeModelCatalogReading = {
    initialize: undefined,
    contextUsage: undefined,
  };
  readonly modelCatalogRequests: ClaudeAuthProbeRequest[] = [];
  // Each creation-time read the driver asked for, and the failure every one ends on when set.
  readonly creationFiguresRequests: ClaudeCreationFiguresRequest[] = [];
  creationFiguresFailure: Error | undefined = undefined;
  // What the control-only process a session's creation runs reports: Claude Code's three
  // advisors, and context reads that refuse, so no reply reserve or window is derived.
  creationFiguresReading: ClaudeCreationFiguresReading = {
    outputStyleNames: [],
    outputStyle: { isListed: true, text: "Available styles:", outcome: undefined },
    advisor: {
      isListed: true,
      text: "Advisor: off\nUsage: /advisor <fable|opus|sonnet|off>",
      outcome: undefined,
    },
    replyReserveReads: { kind: "refused", detail: "get_context_usage: not in this double" },
    contextReads: [],
  };
  // Every one-turn process the driver ran, and the reply each answers with or the failure it ends
  // on.
  readonly oneTurnRequests: ClaudeOneTurnRequest[] = [];
  oneTurnReply: ClaudeOneTurnReply = {
    text: "",
    providerMessageId: undefined,
    refusal: undefined,
  };
  oneTurnFailure: Error | undefined = undefined;
  // Rewind defaults to the happy path: the fork announces a new provider session id, which the
  // driver's fork check requires.
  readonly rewindRequests: ClaudeSessionRewindRequest[] = [];
  rewindFailure: Error | undefined = undefined;
  // When set, the fork announces this id, modeling a provider that did not fork.
  announcedForkedProviderSessionId: string | undefined = undefined;
  // The zero-turn auth probe's outcome. A `ClaudeAuthenticationRequiredError` failure models a
  // determinate logged-out reading; any other failure models a probe that could not be taken.
  probeAuthFailure: Error | undefined = undefined;
  readonly probeAuthRequests: ClaudeAuthProbeRequest[] = [];

  /**
   * Refuses to start a child whose environment lacks the update opt-outs. A refusal rather than a
   * recording, because a spawn path that skipped the environment builder would still return a
   * working channel and every other assertion would keep passing. Keyed on the canonical opt-out
   * table so the guard follows it.
   */
  #requireMandatedEnvironment(spawnEnvironment: readonly SpawnEnvPair[]): void {
    for (const [name, value] of Object.entries(
      CLAUDE_DRIVER_DESCRIPTOR.autoUpdateOptOutEnvironment,
    )) {
      if (spawnEnvironment.find((pair) => pair[0] === name)?.[1] !== value) {
        throw new Error(
          `A Claude child was started without the mandated ${name}=${value}, which the ` +
            `transport obligations forbid.`,
        );
      }
    }
  }

  async spawnSession(request: ClaudeSessionSpawnRequest): Promise<ClaudeSessionAttachment> {
    this.spawnRequests.push(request);
    this.#requireMandatedEnvironment(request.spawnEnvironment);
    await this.establishmentGate;
    await Promise.resolve();
    const announced = this.announcedProviderSessionId ?? request.providerSessionId;
    const channel = new FakeClaudeProviderProcess(announced);
    channel.onTurnTerminalFailure = this.onTurnTerminalFailure;
    channel.controlResponse = this.controlResponse;
    this.spawnedChannels.push(channel);
    return {
      providerSessionId: announced,
      channel,
      initialize: this.#initializeDeclaration(),
      settingsReadback: { cleanupPeriodDays: null, attachedAdvisor: { kind: "unreported" } },
    };
  }

  async resumeSession(
    request: ClaudeSessionResumeRequest,
  ): Promise<ClaudeResumedSessionAttachment> {
    this.resumeRequests.push(request);
    this.#requireMandatedEnvironment(request.spawnEnvironment);
    await this.establishmentGate;
    if (this.resumeFailure !== undefined) {
      throw this.resumeFailure;
    }
    await Promise.resolve();
    const announced = this.announcedProviderSessionId ?? request.resumeHandle;
    const channel = new FakeClaudeProviderProcess(announced);
    channel.onTurnTerminalFailure = this.onTurnTerminalFailure;
    channel.controlResponse = this.controlResponse;
    this.spawnedChannels.push(channel);
    return {
      providerSessionId: announced,
      channel,
      initialize: this.#initializeDeclaration(),
      settingsReadback: { cleanupPeriodDays: null, attachedAdvisor: { kind: "unreported" } },
      sessionPosition: this.resumedSessionPosition,
    };
  }

  async rewindSession(
    request: ClaudeSessionRewindRequest,
  ): Promise<ClaudeResumedSessionAttachment> {
    this.rewindRequests.push(request);
    this.#requireMandatedEnvironment(request.spawnEnvironment);
    await this.establishmentGate;
    if (this.rewindFailure !== undefined) {
      throw this.rewindFailure;
    }
    await Promise.resolve();
    const announced =
      this.announcedForkedProviderSessionId ?? `forked-${String(this.rewindRequests.length)}`;
    const channel = new FakeClaudeProviderProcess(announced);
    channel.onTurnTerminalFailure = this.onTurnTerminalFailure;
    channel.controlResponse = this.controlResponse;
    this.spawnedChannels.push(channel);
    return {
      providerSessionId: announced,
      channel,
      initialize: this.#initializeDeclaration(),
      settingsReadback: { cleanupPeriodDays: null, attachedAdvisor: { kind: "unreported" } },
      sessionPosition: request.targetPosition,
    };
  }

  #initializeDeclaration(): ClaudeInitializeDeclaration {
    return {
      fastMode: this.initializeFastMode,
      models: this.initializeModels,
      autoModeModels: this.initializeAutoModeModels,
      outputStyles: this.initializeOutputStyles,
      outputStyle: this.initializeOutputStyle,
    };
  }

  async probeAuth(request: ClaudeAuthProbeRequest): Promise<ClaudeAuthProbeReading> {
    this.probeAuthRequests.push(request);
    // Checked before the failure arms: a probe that could not be taken still started a child.
    this.#requireMandatedEnvironment(request.spawnEnvironment);
    await Promise.resolve();
    if (this.probeAuthFailure !== undefined) {
      throw this.probeAuthFailure;
    }
    // Mints no channel: a probe that established a session would not be zero-turn.
    return {};
  }

  async readModelCatalog(request: ClaudeAuthProbeRequest): Promise<ClaudeModelCatalogReading> {
    this.modelCatalogRequests.push(request);
    this.#requireMandatedEnvironment(request.spawnEnvironment);
    await Promise.resolve();
    return this.modelCatalogReading;
  }

  async readCreationFigures(
    request: ClaudeCreationFiguresRequest,
  ): Promise<ClaudeCreationFiguresReading> {
    this.creationFiguresRequests.push(request);
    this.#requireMandatedEnvironment(request.spawnEnvironment);
    await Promise.resolve();
    if (this.creationFiguresFailure !== undefined) {
      throw this.creationFiguresFailure;
    }
    return this.creationFiguresReading;
  }

  async readReplyReserve(
    request: ClaudeSessionFolderReadRequest,
  ): Promise<ClaudeReplyReserveReads> {
    this.#requireMandatedEnvironment(request.spawnEnvironment);
    await Promise.resolve();
    return this.creationFiguresReading.replyReserveReads;
  }

  async runOneTurn(request: ClaudeOneTurnRequest): Promise<ClaudeOneTurnReply> {
    this.oneTurnRequests.push(request);
    this.#requireMandatedEnvironment(request.spawnEnvironment);
    await Promise.resolve();
    if (this.oneTurnFailure !== undefined) {
      throw this.oneTurnFailure;
    }
    return this.oneTurnReply;
  }

  // Starts no process of its own: every channel it minted is closed through the lifecycle.
  async stopEveryProcess(): Promise<void> {
    await Promise.resolve();
  }
}

/** Resolver that answers run dispatches from `dispatchByRunId`. */
export class FakeClaudeRunDispatchResolver implements ClaudeRunDispatchResolver {
  readonly dispatchByRunId: Map<RunId, ClaudeRunDispatch> = new Map();

  async resolveRunDispatch(params: StartRunParams): Promise<ClaudeRunDispatch | undefined> {
    await Promise.resolve();
    return this.dispatchByRunId.get(params.runId);
  }

  /** Opens `daemon-binding-<runId>` on the test agent for a run the daemon started itself. */
  async openDaemonTurnBinding(runId: RunId): Promise<DaemonTurnBinding> {
    await Promise.resolve();
    return { bindingId: `daemon-binding-${runId}`, agentId: TEST_AGENT_ID };
  }
}

/** Minimal `createSession` params for the test session. */
export function buildCreateSessionParams(): CreateSessionParams {
  return {
    sessionId: TEST_SESSION_ID,
    model: TEST_MODEL,
    largerWindow: undefined,
    config: { model: TEST_MODEL },
  };
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

/** An interrupt intervention on the first test run, its waiting messages going as `pending`. */
export function buildInterruptParams(
  pending: InterruptPendingChoice = "nextTurn",
): ApplyInterventionParams {
  return {
    type: "interrupt",
    targetRunId: TEST_RUN_ID,
    expectedRunVersion: 3,
    clientIdempotencyKey: "3f1d2b4c-0000-4000-8000-000000000002",
    payload: { pending, reason: "user pressed stop" },
  };
}
