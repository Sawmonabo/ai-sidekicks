// Every frame the router delivered off a Claude Code process becomes deliveries to the run engine,
// in frame order, on the binding of the run holding the session's turn: the turn's opening, its
// markers, its message and tool rows, the text and thinking Claude Code streams as stored pieces
// of their message, the provider's status, warnings and model switches, a helper's child run, and
// the turn's end. The end passes the terminal-emission gate once per turn;
// a turn whose end the daemon writes itself (a refusal the driver settled) delivers none, a turn
// an interrupt stopped delivers `interrupted`, and a turn that ended on the run's pause delivers
// `paused`. An end the run engine could not take is followed by a failed end, so no run is left
// open, and an ended run's per-run readings go with it.

import type { ProviderSpentRetriesSignal } from "@ai-sidekicks/contracts/provider/driver/usage-limit";
import type { RunRefusedCause } from "@ai-sidekicks/contracts/run/failure-cause";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { eventIdOf, type InboundDelivery } from "../../../../session/run/inbound.js";
import type { TerminalEmissionGate } from "../../../terminal-emission-gate.js";
import type { SubagentLifecycleEmission, ThreadFrameRoute } from "../../../thread-frame-router.js";
import { readNonEmptyString } from "../../../record-readers.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import { NormalizedEventReorderBuffer } from "../../reorder-buffer.js";
import { CLAUDE_DRIVER_NAME } from "../capabilities.js";
import { composeClaudeWireFrameKind } from "../event-normalizer.js";
import type { ClaudeSentPrompts } from "../run/prompts.js";
import type { ClaudeBoundRun, ClaudeRunRoutes } from "../run/routes.js";
import { CLAUDE_THREAD_FRAME_ROUTER_CONFIG, type LiveClaudeSession } from "../session/state.js";
import { classifyClaudeSpentRetries } from "../spent-retries-signal.js";
import type { ClaudeProviderDialogs } from "./dialogs.js";
import type { ClaudeDeliveryDispatch } from "./dispatch.js";
import {
  readClaudeAssistantRows,
  readClaudeUserRows,
  type ClaudeMessageRow,
  type ClaudeOpenToolCall,
} from "./messages.js";
import { readClaudeResultDenials, type ClaudeReviewerCapture } from "./reviewer.js";
import { ClaudeStreamedBlocks } from "./streamed-blocks.js";
import {
  readClaudeHelperEnd,
  readClaudeModelReroute,
  readClaudeAssistantRefusal,
  readClaudeProviderStatus,
  readClaudeRefusalWithoutFallback,
  readClaudeWarning,
  readClaudeWorkerShutdownReason,
} from "./system.js";
import { readClaudeTurnEnd, type ClaudeTurnEnd } from "./terminal.js";

/** What the stream delivers through and reads the session's state from. */
export interface ClaudeDeliveryStreamDependencies {
  readonly dispatch: ClaudeDeliveryDispatch;
  readonly diagnostics: DriverDiagnosticsEmitter;
  readonly runRoutes: ClaudeRunRoutes;
  /** The newest message each session was sent, which a turn too long to fit hands back. */
  readonly prompts: ClaudeSentPrompts;
  readonly dialogs: ClaudeProviderDialogs;
  readonly reviewer: ClaudeReviewerCapture;
  /** The session's terminal-emission gate, read at each turn end. */
  readonly gateFor: (sessionId: SessionId) => TerminalEmissionGate;
  /** The lead run whose pause took effect as its turn ended, taken once. */
  readonly takeLeadPauseEffect: (sessionId: SessionId) => RunId | undefined;
  /** A turn too long to fit even after compaction ended: Claude Code keeps it until it is cut. */
  readonly onTooLongTurn: (live: LiveClaudeSession, runId: RunId) => void;
  /** The session moved to another model for the rest of it, whose reply reserve may be unread. */
  readonly onRunningModelMoved: (live: LiveClaudeSession) => void;
  /** Sees every frame of the session's own thread, for a command waiting on its reply. */
  readonly observeLeadFrame: (
    sessionId: SessionId,
    frameKind: string,
    frame: Readonly<Record<string, unknown>>,
  ) => void;
  readonly now: () => number;
}

/** What the stream holds for one session while its process runs. */
interface ClaudeStreamSession {
  readonly openToolCalls: Map<string, ClaudeOpenToolCall>;
  readonly buffer: NormalizedEventReorderBuffer<InboundDelivery>;
  /** The run whose turn the stream has opened, until that turn's end. */
  turnRunId: RunId | undefined;
  /** How many turns each run took on this process, the epoch its turn end passes the gate under. */
  readonly turnEpochByRun: Map<RunId, number>;
  /** The runs whose `run.provider_initialized` was delivered. */
  readonly initializedRuns: Set<RunId>;
  /** The words Claude Code sent the model for each failed or denied call of the turn. */
  readonly failedCallWords: Map<string, string>;
  /** The refusal no other model took, which ends the turn refused. */
  refusal: RunRefusedCause | undefined;
  spentRetries: ProviderSpentRetriesSignal | undefined;
  /** The permission mode the process last reported it runs in. */
  permissionMode: string | undefined;
  /** The runs whose turn the driver's own interrupt is stopping. */
  readonly interruptedRuns: Set<RunId>;
  /**
   * The ids of the events each message of the open turn was written as, by its wire uuid, and
   * those of each streamed block's pieces, by the block's key.
   */
  readonly eventIdsByMessageKey: Map<string, Promise<string | undefined>[]>;
  /** The text and thinking the process is streaming. */
  readonly streamedBlocks: ClaudeStreamedBlocks;
}

/**
 * A run whose end the daemon writes itself: `confirmed` once that end is certain, and until then
 * the turn end held back in case it does not happen.
 */
interface ClaudeDaemonEndedRun {
  readonly sessionId: SessionId;
  confirmed: boolean;
  heldTurnEnd: ClaudeTurnEndDelivery | undefined;
}

// Why a run ended failed when the run engine could not take the end Claude Code reported.
const CLAUDE_UNRECORDED_TURN_END_DETAIL =
  "Claude Code ended this run's turn, but the end it reported could not be recorded.";

/** Turns each delivered frame of every session into the run engine's deliveries. */
export class ClaudeDeliveryStream {
  readonly #dependencies: ClaudeDeliveryStreamDependencies;
  readonly #sessions: Map<SessionId, ClaudeStreamSession> = new Map();
  readonly #daemonEndedRuns: Map<RunId, ClaudeDaemonEndedRun> = new Map();
  // Each helper's child run being started, by session and agent id, until it has its route.
  readonly #startingChildRuns: Map<SessionId, Map<string, Promise<void>>> = new Map();
  // The wire uuid of the message, or the key of the streamed block, each row delivery came from,
  // read when the delivery is sent.
  readonly #messageKeyByDelivery: WeakMap<InboundDelivery, string> = new WeakMap();

  constructor(dependencies: ClaudeDeliveryStreamDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * The ids of the events the open turn's messages named by `messageUuids` were written as, once
   * each write has settled; a message the turn never streamed, or a row that was not written,
   * names none.
   */
  async eventIdsForMessages(
    sessionId: SessionId,
    messageUuids: readonly string[],
  ): Promise<string[]> {
    const session = this.#sessions.get(sessionId);
    const written = session?.eventIdsByMessageKey;
    const eventIds = await Promise.all(
      messageUuids.flatMap((messageUuid) => {
        const blockKey = session?.streamedBlocks.blockKeyFor(messageUuid);
        return [
          ...(written?.get(messageUuid) ?? []),
          ...(blockKey === undefined ? [] : (written?.get(blockKey) ?? [])),
        ];
      }),
    );
    return eventIds.filter((eventId): eventId is string => eventId !== undefined);
  }

  /** The permission mode a session's process last reported it runs in, if any. */
  permissionModeFor(sessionId: SessionId): string | undefined {
    return this.#sessions.get(sessionId)?.permissionMode;
  }

  /**
   * Marks a run whose end the daemon writes itself, so the turn end Claude Code then sends is not
   * a second end: `confirmed` when that end is certain, else pending until
   * {@link confirmDaemonEnd} or {@link releaseDaemonEnd}. A run holding no turn has no turn end
   * coming, so nothing is marked.
   */
  markDaemonEnded(runId: RunId, confirmed: boolean): void {
    const marked = this.#daemonEndedRuns.get(runId);
    if (marked !== undefined) {
      marked.confirmed ||= confirmed;
      return;
    }
    const sessionId = this.#dependencies.runRoutes.sessionIdFor(runId);
    if (sessionId !== undefined) {
      this.#daemonEndedRuns.set(runId, { sessionId, confirmed, heldTurnEnd: undefined });
    }
  }

  /** The daemon's end of a marked run happened; a turn end held back for it is dropped. */
  confirmDaemonEnd(runId: RunId): void {
    const marked = this.#daemonEndedRuns.get(runId);
    if (marked === undefined) {
      return;
    }
    if (marked.heldTurnEnd !== undefined) {
      this.#daemonEndedRuns.delete(runId);
      return;
    }
    marked.confirmed = true;
  }

  /** The daemon's end of a marked run did not happen; the turn end it held back is delivered. */
  releaseDaemonEnd(runId: RunId): void {
    const marked = this.#daemonEndedRuns.get(runId);
    this.#daemonEndedRuns.delete(runId);
    if (marked?.heldTurnEnd !== undefined) {
      this.#deliverTurnEnd(marked.heldTurnEnd);
    }
  }

  /**
   * An interrupt of a marked run was answered, and the daemon writes the run's end from it: the
   * turn end held back, or the one still coming, is delivered as `interrupted`, so the run ends
   * whichever of the two ends lands first.
   */
  interruptDaemonEnd(runId: RunId): void {
    const marked = this.#daemonEndedRuns.get(runId);
    this.#daemonEndedRuns.delete(runId);
    if (marked === undefined) {
      return;
    }
    const held = marked.heldTurnEnd;
    if (held === undefined) {
      this.markInterrupted(marked.sessionId, runId);
      return;
    }
    // A turn end held as a pause kept the run's binding; as an interrupt the run ends here.
    this.#dependencies.runRoutes.forgetRun(runId);
    this.#deliverTurnEnd({ ...held, change: { runId, newState: "interrupted" } });
  }

  /**
   * Settles once a helper's child run that is being started on a session has its route, or
   * `undefined` when none is being started.
   */
  childRunStarting(sessionId: SessionId, agentId: string): Promise<void> | undefined {
    return this.#startingChildRuns.get(sessionId)?.get(agentId);
  }

  /**
   * Marks a run whose turn the driver's own interrupt is stopping, so the turn end Claude Code then
   * sends is delivered as `interrupted`; {@link unmarkInterrupted} takes it back if none was sent.
   */
  markInterrupted(sessionId: SessionId, runId: RunId): void {
    this.#sessionFor(sessionId).interruptedRuns.add(runId);
  }

  /** The interrupt was not sent: the run's turn end is delivered as Claude Code reports it. */
  unmarkInterrupted(sessionId: SessionId, runId: RunId): void {
    this.#sessions.get(sessionId)?.interruptedRuns.delete(runId);
  }

  /** Takes one frame the router delivered off a live session's process, whole and untrusted. */
  deliverFrame(
    live: LiveClaudeSession,
    frame: Readonly<Record<string, unknown>>,
    route: ThreadFrameRoute,
  ): void {
    const { runRoutes, observeLeadFrame } = this.#dependencies;
    const session = this.#sessionFor(live.sessionId);
    const frameKind = composeClaudeWireFrameKind(
      readNonEmptyString(frame, "type") ?? "",
      readNonEmptyString(frame, "subtype") ?? null,
    );
    observeLeadFrame(live.sessionId, frameKind, frame);
    this.#sendAll(session, session.buffer.flushExpired(this.#dependencies.now()));
    if (frameKind === "system/init" || frameKind === "system/status") {
      session.permissionMode =
        readNonEmptyString(frame, "permissionMode") ?? session.permissionMode;
    }
    // A background helper ends on its own route, also after the turn that started it ended.
    if (frameKind === "system/task_notification") {
      this.#endHelper(live.sessionId, frame);
      return;
    }
    const lead = runRoutes.leadRunOn(live.sessionId);
    if (lead === undefined) {
      // A frame of a turn no daemon run holds, such as one Claude Code started on its own.
      this.#recordUnheld(live.sessionId, frameKind);
      return;
    }
    this.#openTurn(session, lead);
    if (frame["type"] === "result") {
      this.#endTurn(live, session, lead, frame, route);
      return;
    }
    switch (frameKind) {
      case "system/init":
        this.#markInitialized(session, lead, readNonEmptyString(frame, "model"));
        return;
      case "system/status": {
        const status = readClaudeProviderStatus(frame);
        if (status !== undefined) {
          this.#sendRow(lead, frameKind, {
            type: "session.provider_status",
            payload: { sessionId: live.sessionId, runId: lead.runId, provider: "claude", status },
          });
        }
        return;
      }
      case "system/worker_shutting_down": {
        const reason = readClaudeWorkerShutdownReason(frame);
        this.#sendMarker(lead, frameKind, {
          type: "run.worker_shutdown",
          payload: { runId: lead.runId, ...(reason === undefined ? {} : { reason }) },
        });
        return;
      }
      case "system/api_retry":
        session.spentRetries = classifyClaudeSpentRetries(frame) ?? session.spentRetries;
        return;
      case "system/informational": {
        const text = readClaudeWarning(frame);
        if (text !== undefined) {
          void this.#dependencies.dispatch.send(
            {
              kind: "session_notice",
              notice: {
                sessionId: live.sessionId,
                kind: "provider_warning",
                source: "warning",
                text,
              },
            },
            frameKind,
          );
        }
        return;
      }
      case "system/model_refusal_fallback":
        // Another model took the refused turn, which Claude Code retracts, so it is no refusal.
        session.refusal = undefined;
        this.#reroute(live, lead, frameKind, frame);
        return;
      case "system/model_fallback":
      case "system/model_consent_fallback":
        this.#reroute(live, lead, frameKind, frame);
        return;
      case "system/model_refusal_no_fallback":
        session.refusal = readClaudeRefusalWithoutFallback(frame);
        return;
      case "system/permission_denied": {
        const toolCallId = readNonEmptyString(frame, "tool_use_id");
        const message = readNonEmptyString(frame, "message");
        if (toolCallId !== undefined && message !== undefined) {
          session.failedCallWords.set(toolCallId, message);
        }
        return;
      }
      case "stream_event":
        session.streamedBlocks.observe(
          frame,
          { sessionId: live.sessionId, runId: lead.runId },
          (rows, blockKey) => {
            this.#sendRows(session, lead, frameKind, rows, blockKey);
          },
        );
        return;
      case "assistant": {
        this.#dependencies.dialogs.observeAssistantError(lead.runId, frame);
        // As Claude Code reads a turn, its last refused message is the turn's refusal.
        session.refusal = readClaudeAssistantRefusal(frame) ?? session.refusal;
        const rows = readClaudeAssistantRows(
          frame,
          { sessionId: live.sessionId, runId: lead.runId },
          session.openToolCalls,
          this.#dependencies.now(),
        );
        const unstreamed = session.streamedBlocks.finish(frame, rows, (finished, blockKey) => {
          this.#sendRows(session, lead, frameKind, finished, blockKey);
        });
        this.#sendRows(session, lead, frameKind, unstreamed, readNonEmptyString(frame, "uuid"));
        return;
      }
      case "user": {
        const reading = readClaudeUserRows(
          frame,
          { sessionId: live.sessionId, runId: lead.runId },
          session.openToolCalls,
          this.#dependencies.now(),
        );
        for (const failed of reading.failedResults) {
          session.failedCallWords.set(failed.toolCallId, failed.text);
        }
        this.#sendRows(session, lead, frameKind, reading.rows, readNonEmptyString(frame, "uuid"));
        return;
      }
      default:
        return;
    }
  }

  /**
   * Delivers a helper's start or end that the routing read off its frames: a started helper gets
   * a child run beneath the lead run, and both ends get their `subagent.*` row on the lead run.
   */
  observeHelperLifecycle(sessionId: SessionId, emission: SubagentLifecycleEmission): void {
    const { dispatch, runRoutes } = this.#dependencies;
    const lead = runRoutes.leadRunOn(sessionId) ?? this.#helperParentRun(sessionId, emission);
    if (lead === undefined) {
      this.#recordUnheld(sessionId, emission.eventType);
      return;
    }
    // A helper's start can be its turn's first frame, which opens the turn before its rows; a
    // background helper's end after its turn ended opens none.
    if (runRoutes.leadRunOn(sessionId) !== undefined) {
      this.#openTurn(this.#sessionFor(sessionId), lead);
    }
    const parentToolCallId = emission.parentToolCallId;
    const operation =
      parentToolCallId === undefined
        ? undefined
        : { correlationKey: parentToolCallId, isOpening: false };
    if (emission.eventType === "subagent.started") {
      const started = dispatch.send(
        { kind: "child_run", bindingId: lead.bindingId, operation, parentRunId: lead.runId },
        "system/task_started",
      );
      const starting = this.#startingChildRuns.get(sessionId) ?? new Map<string, Promise<void>>();
      this.#startingChildRuns.set(sessionId, starting);
      const routed = started.then((outcome) => {
        if (outcome?.disposition === "child_run_started") {
          runRoutes.bindChildRun(outcome.runId, {
            sessionId,
            agentId: emission.subagentId,
            parentRunId: lead.runId,
            bindingId: lead.bindingId,
          });
        }
        if (starting.get(emission.subagentId) === routed) {
          starting.delete(emission.subagentId);
        }
      });
      starting.set(emission.subagentId, routed);
    }
    this.#sendRow(lead, emission.eventType, {
      type: emission.eventType,
      payload: {
        sessionId,
        runId: lead.runId,
        provider: "claude",
        subagentId: emission.subagentId,
        ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
      },
    });
  }

  /** Releases every row a session's buffer still holds, as its turn or its process ends. */
  drain(sessionId: SessionId): void {
    const session = this.#sessions.get(sessionId);
    if (session !== undefined) {
      this.#sendAll(session, session.buffer.flushExpired(Number.POSITIVE_INFINITY));
    }
  }

  /** Forgets a session whose process is gone, releasing what it streamed and buffered first. */
  forgetSession(sessionId: SessionId): void {
    this.#sessions.get(sessionId)?.streamedBlocks.endAll();
    this.drain(sessionId);
    this.#sessions.delete(sessionId);
    this.#startingChildRuns.delete(sessionId);
    for (const [runId, marked] of this.#daemonEndedRuns) {
      if (marked.sessionId === sessionId) {
        this.#daemonEndedRuns.delete(runId);
      }
    }
  }

  #sessionFor(sessionId: SessionId): ClaudeStreamSession {
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const session: ClaudeStreamSession = {
      openToolCalls: new Map(),
      buffer: new NormalizedEventReorderBuffer<InboundDelivery>({
        provider: CLAUDE_DRIVER_NAME,
        diagnostics: this.#dependencies.diagnostics,
        maxBufferedEvents: CLAUDE_THREAD_FRAME_ROUTER_CONFIG.maxPendingHoldFrames,
        pairingTimeoutMs: CLAUDE_THREAD_FRAME_ROUTER_CONFIG.pendingRegistrationTimeoutMs,
      }),
      turnRunId: undefined,
      turnEpochByRun: new Map(),
      initializedRuns: new Set(),
      failedCallWords: new Map(),
      refusal: undefined,
      spentRetries: undefined,
      permissionMode: undefined,
      interruptedRuns: new Set(),
      eventIdsByMessageKey: new Map(),
      streamedBlocks: new ClaudeStreamedBlocks(this.#dependencies.diagnostics),
    };
    this.#sessions.set(sessionId, session);
    return session;
  }

  // The first frame of a run's turn opens it: the boundary, then the turn's marker, and the
  // readings of the turn before start empty.
  #openTurn(session: ClaudeStreamSession, lead: ClaudeBoundRun): void {
    if (session.turnRunId === lead.runId) {
      return;
    }
    session.turnRunId = lead.runId;
    session.turnEpochByRun.set(lead.runId, (session.turnEpochByRun.get(lead.runId) ?? 0) + 1);
    session.failedCallWords.clear();
    session.eventIdsByMessageKey.clear();
    session.streamedBlocks.openTurn();
    session.refusal = undefined;
    session.spentRetries = undefined;
    void this.#dependencies.dispatch.send(
      { kind: "turn_boundary", bindingId: lead.bindingId },
      null,
    );
    this.#sendMarker(lead, null, { type: "run.turn_started", payload: { runId: lead.runId } });
  }

  #markInitialized(
    session: ClaudeStreamSession,
    lead: ClaudeBoundRun,
    model: string | undefined,
  ): void {
    if (session.initializedRuns.has(lead.runId)) {
      return;
    }
    session.initializedRuns.add(lead.runId);
    this.#sendMarker(lead, "system/init", {
      type: "run.provider_initialized",
      payload: { runId: lead.runId, provider: "claude", ...(model === undefined ? {} : { model }) },
    });
  }

  #reroute(
    live: LiveClaudeSession,
    lead: ClaudeBoundRun,
    frameKind: string,
    frame: Readonly<Record<string, unknown>>,
  ): void {
    const reroute = readClaudeModelReroute(frameKind, frame);
    if (reroute === undefined) {
      return;
    }
    // A session-long switch is the model every later process of the session starts on.
    if (reroute.scope === "session") {
      live.runningModel = reroute.toModel;
      this.#dependencies.onRunningModelMoved(live);
    }
    this.#sendRow(lead, frameKind, {
      type: "usage.model_rerouted",
      payload: { sessionId: live.sessionId, runId: lead.runId, ...reroute },
    });
  }

  // A helper's child run moves on its own `task_notification`, then its route retires.
  #endHelper(sessionId: SessionId, frame: Readonly<Record<string, unknown>>): void {
    const { runRoutes, dispatch } = this.#dependencies;
    const taskId = readNonEmptyString(frame, "task_id");
    const childRunId = taskId === undefined ? undefined : runRoutes.childRunFor(sessionId, taskId);
    const route = childRunId === undefined ? undefined : runRoutes.childRouteFor(childRunId);
    const change = childRunId === undefined ? undefined : readClaudeHelperEnd(frame, childRunId);
    if (childRunId === undefined || route === undefined || change === undefined) {
      return;
    }
    void dispatch.send(
      { kind: "run_lifecycle", bindingId: route.bindingId, change },
      "system/task_notification",
    );
    runRoutes.retireChildRun(childRunId);
  }

  // The turn's end, through the gate once per turn: `interrupted` when the driver's interrupt
  // stopped it, `paused` when the run's pause took effect, nothing when the daemon writes the run's
  // end itself, and the reviewer's blocks it listed.
  #endTurn(
    live: LiveClaudeSession,
    session: ClaudeStreamSession,
    lead: ClaudeBoundRun,
    frame: Readonly<Record<string, unknown>>,
    route: ThreadFrameRoute,
  ): void {
    const { gateFor, takeLeadPauseEffect, reviewer } = this.#dependencies;
    session.turnRunId = undefined;
    // A block the turn left unfinished keeps what streamed of it.
    session.streamedBlocks.endTurn(lead.runId);
    this.drain(live.sessionId);
    if (live.executionPosture?.mode === "reviewed") {
      for (const denial of readClaudeResultDenials(frame, (id) =>
        session.failedCallWords.get(id),
      )) {
        reviewer.capture({ sessionId: live.sessionId, runId: lead.runId, ...denial });
      }
    }
    // Taken whatever the gate decides, so a pause never outlives the turn it was asked in.
    const pausedRunId = takeLeadPauseEffect(live.sessionId);
    const decision = gateFor(live.sessionId).admitTerminalFrame({
      runId: lead.runId,
      runVersion: session.turnEpochByRun.get(lead.runId) ?? 0,
      rawWireType: "result",
      route,
    });
    if (!decision.emit) {
      return;
    }
    const end = readClaudeTurnEnd(
      frame,
      lead.runId,
      session.spentRetries,
      this.#dependencies.prompts.newestFor(live.sessionId),
    );
    const isInterrupted = session.interruptedRuns.delete(lead.runId);
    const isPaused =
      !isInterrupted && pausedRunId === lead.runId && end.change.newState === "completed";
    const change: ClaudeTurnEndDelivery = {
      kind: "run_lifecycle",
      bindingId: lead.bindingId,
      change: isInterrupted
        ? {
            runId: lead.runId,
            newState: "interrupted",
            ...(decision.intendedClose ? { intendedClose: true } : {}),
          }
        : isPaused
          ? { runId: lead.runId, expectedState: "pausing", newState: "paused" }
          : this.#composeTurnEnd(session, end, decision.intendedClose),
    };
    // A paused run takes its next turn on the same binding; every other run ended here.
    if (!isPaused) {
      this.#forgetEndedRun(session, lead.runId);
    }
    const marked = this.#daemonEndedRuns.get(lead.runId);
    if (marked !== undefined) {
      // The daemon writes this run's end; a turn end is held while that write is not certain.
      if (marked.confirmed) {
        this.#daemonEndedRuns.delete(lead.runId);
      } else {
        marked.heldTurnEnd = change;
      }
      return;
    }
    this.#deliverTurnEnd(change);
    if (end.isTooLong && !isInterrupted) {
      this.#dependencies.onTooLongTurn(live, lead.runId);
    }
  }

  // An end the run engine did not take leaves the run open with no turn to end it, so it ends
  // failed instead, naming why.
  #deliverTurnEnd(delivery: ClaudeTurnEndDelivery): void {
    const { dispatch } = this.#dependencies;
    void dispatch.send(delivery, "result").then(async (outcome) => {
      if (outcome !== undefined) {
        return;
      }
      await dispatch.send(
        {
          kind: "run_lifecycle",
          bindingId: delivery.bindingId,
          change: {
            runId: delivery.change.runId,
            newState: "failed",
            failureCategory: "provider failure",
            providerFailureDetail: CLAUDE_UNRECORDED_TURN_END_DETAIL,
          },
        },
        null,
      );
    });
  }

  // An ended run's readings: its binding, its turn count and its initialization, and the tool
  // calls its turn left open, which can no longer complete.
  #forgetEndedRun(session: ClaudeStreamSession, runId: RunId): void {
    this.#dependencies.runRoutes.forgetRun(runId);
    session.turnEpochByRun.delete(runId);
    session.initializedRuns.delete(runId);
    session.openToolCalls.clear();
  }

  // The lead run a helper was started beneath, for a background helper whose turn already ended.
  #helperParentRun(
    sessionId: SessionId,
    emission: SubagentLifecycleEmission,
  ): ClaudeBoundRun | undefined {
    const { runRoutes } = this.#dependencies;
    if (emission.eventType !== "subagent.completed") {
      return undefined;
    }
    const childRunId = runRoutes.childRunFor(sessionId, emission.subagentId);
    const route = childRunId === undefined ? undefined : runRoutes.childRouteFor(childRunId);
    return route === undefined
      ? undefined
      : { runId: route.parentRunId, bindingId: route.bindingId };
  }

  #composeTurnEnd(
    session: ClaudeStreamSession,
    end: ClaudeTurnEnd,
    intendedClose: boolean,
  ): ClaudeTurnEnd["change"] {
    const refusal = session.refusal;
    const change: ClaudeTurnEnd["change"] =
      refusal === undefined
        ? end.change
        : {
            runId: end.change.runId,
            newState: "failed",
            failureCategory: "refused",
            failureCause: refusal,
          };
    return intendedClose ? { ...change, intendedClose: true } : change;
  }

  // `messageKey` is the frame's own uuid, or the key of the block a piece streamed in, kept with
  // each row so a later choice can name its events.
  #sendRows(
    session: ClaudeStreamSession,
    lead: ClaudeBoundRun,
    wireType: string,
    rows: readonly ClaudeMessageRow[],
    messageKey: string | undefined,
  ): void {
    for (const row of rows) {
      const content = { body: row.body };
      const delivery: InboundDelivery =
        row.row.type === "assistant.thinking_update"
          ? {
              kind: "thinking_update",
              bindingId: lead.bindingId,
              payload: row.row.payload,
              content,
            }
          : {
              kind: "session_row",
              bindingId: lead.bindingId,
              operation: row.operation,
              row: row.row,
              content,
            };
      if (messageKey !== undefined) {
        this.#messageKeyByDelivery.set(delivery, messageKey);
      }
      this.#sendAll(
        session,
        session.buffer.admit(
          { toolCallId: row.toolCallId, pairingRole: row.pairingRole, event: delivery },
          this.#dependencies.now(),
        ),
        wireType,
      );
    }
  }

  #sendRow(
    lead: ClaudeBoundRun,
    wireType: string | null,
    row: Extract<InboundDelivery, { kind: "session_row" }>["row"],
  ): void {
    void this.#dependencies.dispatch.send(
      { kind: "session_row", bindingId: lead.bindingId, row },
      wireType,
    );
  }

  #sendMarker(
    lead: ClaudeBoundRun,
    wireType: string | null,
    marker: Extract<InboundDelivery, { kind: "run_marker" }>["marker"],
  ): void {
    void this.#dependencies.dispatch.send(
      { kind: "run_marker", bindingId: lead.bindingId, marker },
      wireType,
    );
  }

  // Sends what a session's buffer released, keeping the event id of each row of a message or block.
  #sendAll(
    session: ClaudeStreamSession,
    deliveries: readonly InboundDelivery[],
    wireType: string | null = null,
  ): void {
    for (const delivery of deliveries) {
      const sent = this.#dependencies.dispatch.send(delivery, wireType);
      const messageKey = this.#messageKeyByDelivery.get(delivery);
      if (messageKey !== undefined) {
        const written = session.eventIdsByMessageKey.get(messageKey) ?? [];
        written.push(sent.then(eventIdOf));
        session.eventIdsByMessageKey.set(messageKey, written);
      }
    }
  }

  #recordUnheld(sessionId: SessionId, frameKind: string): void {
    this.#dependencies.diagnostics.emit({
      provider: CLAUDE_DRIVER_NAME,
      kind: "unmapped_wire_kind",
      rawWireType: frameKind,
      dispositionReason:
        "a frame of a turn no daemon run holds has no binding to be attributed on, so it is " +
        "dropped with this record",
      details: { sessionId },
    });
  }
}

// A turn's end as the stream delivers it.
type ClaudeTurnEndDelivery = InboundDelivery & { kind: "run_lifecycle" };
