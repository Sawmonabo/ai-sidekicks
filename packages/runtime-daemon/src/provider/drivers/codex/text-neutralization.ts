// The text-neutralization tripwire on the Codex leg: composing and registering each run-opening
// frame, accruing turn evidence from the notification stream, and ruling every frame when its turn
// settles, its steer fails, its binding is condemned or a resume supersedes it. A trip quarantines
// the session and the run and reports the run failure.

import type { RunId } from "@ai-sidekicks/contracts/provider/driver/driver";
import type { SessionId } from "@ai-sidekicks/contracts/session/session";
import {
  type OutboundFrameTripwire,
  type OutboundTextFrame,
  type OutboundTextFrameWriter,
  type RuntimeBindingQuarantine,
  type TextNeutralizationRunFailure,
  type TripwireDecision,
  UNRECOGNIZED_TURN_EVIDENCE,
  composeSupersededDeliveryRunFailure,
  composeTextNeutralizationRunFailure,
  observedTurnEvidence,
  RUN_OPENING_FRAME_ORIGIN,
} from "../../outbound-frame.js";
import { CODEX_DRIVER_NAME } from "./capabilities.js";
import { CODEX_TURN_COMPLETED_METHOD } from "./event-normalizer.js";
import {
  classifyCodexTurnEvidence,
  classifyCodexTurnEvidenceObservation,
} from "./turn-evidence.js";
import {
  CODEX_TERMINAL_TURN_STATUSES,
  type CodexLifecycleOptions,
  type CodexSessionRecord,
  rememberSettledTurn,
  bufferTurnEvidence,
} from "./session-state.js";
import type { CodexRequestDelivery } from "./app-server-connection.js";
import { type CodexRunConfig } from "./session-config.js";
import { normalizeProviderFailureDetail } from "./session-errors.js";
import {
  type CodexTransportDiagnostic,
  reportDiagnosticFromDetachedFrame,
} from "./transport-diagnostics.js";
import { isPlainObject } from "../../record-readers.js";
import type { CodexRunRoutes } from "./run-routes.js";
import type { StartRunParams } from "../../provider-driver.js";

/** The lifecycle's frame machinery, its session records and the teardown a trip calls back into. */
export interface CodexTextNeutralizationDependencies {
  readonly options: Pick<
    CodexLifecycleOptions,
    "diagnostics" | "reportDiagnostic" | "onTextNeutralizationFailure"
  >;
  readonly outboundTextFrameWriter: OutboundTextFrameWriter;
  readonly outboundFrameTripwire: OutboundFrameTripwire;
  readonly runtimeBindingQuarantine: RuntimeBindingQuarantine;
  readonly sessions: ReadonlyMap<SessionId, CodexSessionRecord>;
  readonly runRoutes: CodexRunRoutes;
  /** Tears the condemned session down, detached. */
  readonly disposeQuarantinedSession: (record: CodexSessionRecord) => void;
}

/**
 * Registers each provider-bound text frame with the tripwire and rules it, quarantining and
 * reporting what a trip condemns.
 */
export class CodexTextNeutralization {
  readonly #options: CodexTextNeutralizationDependencies["options"];
  readonly #outboundTextFrameWriter: OutboundTextFrameWriter;
  readonly #outboundFrameTripwire: OutboundFrameTripwire;
  readonly #runtimeBindingQuarantine: RuntimeBindingQuarantine;
  readonly #sessions: ReadonlyMap<SessionId, CodexSessionRecord>;
  readonly #runRoutes: CodexRunRoutes;
  readonly #disposeQuarantinedSession: (record: CodexSessionRecord) => void;

  constructor(dependencies: CodexTextNeutralizationDependencies) {
    this.#options = dependencies.options;
    this.#outboundTextFrameWriter = dependencies.outboundTextFrameWriter;
    this.#outboundFrameTripwire = dependencies.outboundFrameTripwire;
    this.#runtimeBindingQuarantine = dependencies.runtimeBindingQuarantine;
    this.#sessions = dependencies.sessions;
    this.#runRoutes = dependencies.runRoutes;
    this.#disposeQuarantinedSession = dependencies.disposeQuarantinedSession;
  }

  /**
   * Composes and registers the run's opening text frame before any byte is written: text the
   * tripwire cannot watch must not be sent, or a turn settling against no frame would pass.
   *
   * @throws {OutboundFrameCapacityRefusedError} when the session holds more unsettled frames than
   *   the tripwire will watch.
   */
  composeRunOpeningFrame(params: StartRunParams, runConfig: CodexRunConfig): OutboundTextFrame {
    // A literal, not read from the caller's config: `driver_command` skips neutralization and the
    // tripwire, so it must not be nameable through an untyped record.
    const frame = this.#outboundTextFrameWriter.compose({
      text: runConfig.input,
      origin: RUN_OPENING_FRAME_ORIGIN,
    });
    this.#outboundFrameTripwire.register({
      scopeKey: runConfig.sessionId,
      joinKey: params.runId,
      frameRole: "turn-opening",
      frame,
    });
    return frame;
  }

  /**
   * For a turn whose notifications arrived before its `turn/start` answer, correlates the buffered
   * evidence onto the re-keyed opening frame and rules a buffered terminal.
   */
  correlateBufferedTurnEvidence(record: CodexSessionRecord, runId: RunId, turnId: string): void {
    // The turn can already be over: this continuation is a microtask while `#ingest` drains the
    // chunk synchronously, so the sweep may have matched nothing. The buffered evidence closes
    // that window and is correlated onto the re-keyed frame so the terminal is ruled here.
    const buffered = record.bufferedTurnEvidence.get(turnId);
    if (buffered === undefined) {
      return;
    }
    record.bufferedTurnEvidence.delete(turnId);
    for (const observation of buffered.observations) {
      this.#outboundFrameTripwire.observe(turnId, observation);
    }
    const bufferedTerminal = buffered.terminal;
    if (bufferedTerminal === undefined) {
      // In-flight evidence only: the turn is still running; its own terminal settles the frame.
      return;
    }
    this.#runRoutes.retireTurnRoute(record, turnId);
    const decision = this.#outboundFrameTripwire.settle(turnId, bufferedTerminal);
    if (!decision.tripped) {
      return;
    }
    this.#runtimeBindingQuarantine.disposeSession(record.sessionId);
    this.#runtimeBindingQuarantine.disposeRun(runId, record.sessionId);
    this.#reportTextNeutralizationFailure(
      record.sessionId,
      runId,
      composeTextNeutralizationRunFailure(decision),
    );
    this.#disposeQuarantinedSession(record);
  }

  /**
   * Decides what a failed steer's frame is owed by how far its bytes got. One that never reached
   * the wire is forgotten; one handed to the host is retained for the turn's terminal to rule,
   * and a dead connection rules it here, fail-closed. A connection that dies later leaves it to
   * scope release, since ruling there would false-trip clean shutdowns.
   */
  ruleFailedSteerFrame(
    record: CodexSessionRecord,
    runId: RunId,
    steerFrame: OutboundTextFrame,
    delivery: CodexRequestDelivery,
  ): void {
    if (delivery !== "indeterminate") {
      // `unsent` never left and `refused` is a provider answer, so nothing was swallowed.
      this.#outboundFrameTripwire.forgetFrame(steerFrame);
      return;
    }
    if (!record.connection.isClosed) {
      return;
    }
    this.#ruleSteerFrameFailClosed(record, runId, steerFrame);
  }

  /**
   * Rules one steer frame fail-closed when its response phase died with the connection, so no
   * terminal will ever rule it. Frame-scoped: settling the whole turn would trip the opening
   * frame, whose delivery was never in doubt. A frame already consumed settles as
   * `no-correlated-frame`.
   */
  #ruleSteerFrameFailClosed(
    record: CodexSessionRecord,
    runId: RunId,
    steerFrame: OutboundTextFrame,
  ): void {
    const decision = this.#outboundFrameTripwire.settleFrame(
      steerFrame,
      UNRECOGNIZED_TURN_EVIDENCE,
    );
    if (!decision.tripped) {
      return;
    }
    // The settlement path's disposal, session arm first, so a consumer reacting synchronously to
    // the run failure cannot attach to the condemned process.
    this.#runtimeBindingQuarantine.disposeSession(record.sessionId);
    this.#ruleTurnTerminalAgainstRun(record.sessionId, runId, decision);
    this.#disposeQuarantinedSession(record);
  }

  /**
   * Consumes a steer's frame on its own answered request when no terminal can rule the
   * acknowledged turn. The expected outcome is a pass, but a trip is handled with the full
   * disposal, not dropped.
   */
  consumeAnsweredSteerFrame(
    record: CodexSessionRecord,
    runId: RunId,
    steerFrame: OutboundTextFrame,
  ): void {
    const decision = this.#outboundFrameTripwire.settleFrame(steerFrame, observedTurnEvidence());
    if (!decision.tripped) {
      return;
    }
    this.#runtimeBindingQuarantine.disposeSession(record.sessionId);
    this.#ruleTurnTerminalAgainstRun(record.sessionId, runId, decision);
    this.#disposeQuarantinedSession(record);
  }

  /**
   * Whether a terminal on `record` can still rule a frame correlated to `turnId`: the turn has
   * not settled and `record` is still the session's record (identity, not presence).
   * Residual: an ack naming a turn that settled before the steer and was since pruned reads as
   * live; no finite memory closes it. Route maps are not consulted: a provider may ack a turn this
   * leg never routed.
   */
  canStillRuleFrameOnTurn(record: CodexSessionRecord, turnId: string): boolean {
    if (this.#sessions.get(record.sessionId) !== record) {
      return false;
    }
    return !record.settledTurnIds.has(turnId);
  }

  /**
   * Accrues turn evidence from one inbound notification and, on a terminal `turn/completed`, rules
   * the tripwire and retires the turn's route.
   */
  observeTurnNotification(sessionId: SessionId, method: string, params: unknown): void {
    // Evidence accrues across the turn because the terminal notification may not carry the item
    // list (`itemsView` can read `notLoaded`); keyed by turn id, which item notifications carry.
    const inFlightEvidence = classifyCodexTurnEvidenceObservation(method, params);
    if (inFlightEvidence !== null) {
      this.#outboundFrameTripwire.observe(inFlightEvidence.turnId, inFlightEvidence.observation);
      const observingRecord = this.#sessions.get(sessionId);
      if (
        observingRecord !== undefined &&
        !this.#outboundFrameTripwire.hasPendingFrame(inFlightEvidence.turnId)
      ) {
        // No frame is correlated onto this turn yet; it may still wait on the `turn/start`
        // continuation that re-keys it. Remembering the observation avoids tripping on the
        // terminal alone.
        const buffered = bufferTurnEvidence(observingRecord, inFlightEvidence.turnId);
        if (buffered === null) {
          this.#refuseUnretainableTurnEvidence(observingRecord);
          return;
        }
        buffered.observations.add(inFlightEvidence.observation);
      }
    }
    if (method !== CODEX_TURN_COMPLETED_METHOD) {
      return;
    }
    const payload = isPlainObject(params) ? params : {};
    const rawTurn = payload["turn"];
    const turn = isPlainObject(rawTurn) ? rawTurn : {};
    const turnId = turn["id"];
    const status = turn["status"];
    if (typeof turnId !== "string" || turnId.length === 0) {
      return;
    }
    if (typeof status !== "string" || !CODEX_TERMINAL_TURN_STATUSES.has(status)) {
      return;
    }
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      return;
    }
    // Marked for every terminal before any ruling: the other two memories are conditional, so
    // neither answers "has this turn ended", which `steerRun` needs. A refusal returns without
    // ruling: its teardown rules every frame pending on the scope fail-closed, this turn's
    // included.
    if (!rememberSettledTurn(record, turnId)) {
      this.#refuseUnretainableSettledTurn(record);
      return;
    }
    // Keyed by turn id, never run id, so a terminal cannot clear another live turn of the same
    // run. The tripwire retains the decision so the dispatcher can answer a steer already ruled
    // on.
    const classification = classifyCodexTurnEvidence(params);
    const decision = this.#outboundFrameTripwire.settle(turnId, classification);
    if (decision.tripped) {
      // Quarantine first, then report, so a consumer reacting synchronously to the terminal
      // cannot attach to the process that swallowed the text. Both axes: a later `startRun`
      // resolves the session record by session id.
      this.#runtimeBindingQuarantine.disposeSession(sessionId);
    }

    let matchedRoute = false;
    // Direct lookup on the settling turn's own route leaves the run's other live turns
    // correlated.
    const routedRunId = record.runIdByActiveTurnId.get(turnId);
    if (routedRunId !== undefined) {
      this.#runRoutes.retireTurnRoute(record, turnId);
      this.#ruleTurnTerminalAgainstRun(sessionId, routedRunId, decision);
      matchedRoute = true;
    }
    // A run whose route an interrupt retired is not in the live map. The two maps are disjoint:
    // `interruptRun` deletes the live route in the step that records this correlation, and turn
    // ids are never reused.
    const interruptedRunId = record.interruptedRunIdByTurnId.get(turnId);
    if (interruptedRunId !== undefined) {
      // Released whatever the ruling was: the terminal this entry waited for has arrived.
      record.interruptedRunIdByTurnId.delete(turnId);
      this.#ruleTurnTerminalAgainstRun(sessionId, interruptedRunId, decision);
      matchedRoute = true;
    }
    if (decision.tripped) {
      // The recovery is a fresh spawn, so the condemned process is torn down. Detached: this runs
      // in the synchronous read-chunk drain, where awaiting stalls frames and a throw unwinds the
      // drain.
      this.#disposeQuarantinedSession(record);
    }
    if (!matchedRoute) {
      const buffered = bufferTurnEvidence(record, turnId);
      if (buffered === null) {
        this.#refuseUnretainableTurnEvidence(record);
        return;
      }
      buffered.terminal = classification;
    }
  }

  /**
   * Applies a settled turn's tripwire ruling to one run: quarantines its binding and reports the
   * failure. The caller applies the session arm once per terminal first, so a consumer reacting
   * to the first run's failure cannot attach to the process in between.
   */
  #ruleTurnTerminalAgainstRun(
    sessionId: SessionId,
    runId: RunId,
    decision: TripwireDecision,
  ): void {
    if (!decision.tripped) {
      return;
    }
    this.#runtimeBindingQuarantine.disposeRun(runId, sessionId);
    this.#reportTextNeutralizationFailure(
      sessionId,
      runId,
      composeTextNeutralizationRunFailure(decision),
    );
  }

  /**
   * The loud path for a turn-evidence buffer at its ceiling while a `turn/start` is in flight,
   * when every entry may be the terminal that start will claim. Dropping or evicting would
   * silently lose a terminal and report a swallowed turn as completed.
   */
  #refuseUnretainableTurnEvidence(record: CodexSessionRecord): void {
    this.#refuseUnretainableTurnMemory(record, {
      kind: "turn-evidence-memory-overflowed",
      retainedTurnCount: record.bufferedTurnEvidence.size,
    });
  }

  /**
   * The same loud path for the settled-turn memory at its ceiling while a `turn/steer` is in
   * flight: evicting could answer "still running" for an ended turn and strand a frame nothing
   * rules.
   */
  #refuseUnretainableSettledTurn(record: CodexSessionRecord): void {
    this.#refuseUnretainableTurnMemory(record, {
      kind: "settled-turn-memory-overflowed",
      retainedTurnCount: record.settledTurnIds.size,
    });
  }

  /**
   * The same loud path for the interrupted-route memory: every entry is still owed its terminal.
   */
  refuseUnretainableInterruptedRoute(record: CodexSessionRecord): void {
    this.#refuseUnretainableTurnMemory(record, {
      kind: "interrupted-route-memory-overflowed",
      retainedTurnCount: record.interruptedRunIdByTurnId.size,
    });
  }

  /**
   * Refuses a binding whose per-session turn memory overflowed: quarantines and tears down the
   * session, which rules every pending frame fail-closed. One body keeps the three memories
   * equally loud.
   */
  #refuseUnretainableTurnMemory(
    record: CodexSessionRecord,
    diagnostic: CodexTransportDiagnostic,
  ): void {
    if (this.#runtimeBindingQuarantine.isSessionDisposed(record.sessionId)) {
      // Already condemned: the overflowing drain keeps running and would bury the one report that
      // matters under duplicates.
      return;
    }
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, diagnostic);
    this.#runtimeBindingQuarantine.disposeSession(record.sessionId);
    this.#disposeQuarantinedSession(record);
  }

  /**
   * Rules every frame a departing binding leaves unsettled, fail-closed, with
   * `UNRECOGNIZED_TURN_EVIDENCE` (exempt frames still pass): those turns will never deliver a
   * terminal. Reported at most once per run; a disposed run's `run.failed` was already composed.
   */
  ruleAbandonedFramesFailClosed(record: CodexSessionRecord): void {
    const rulings = this.#outboundFrameTripwire.settleScope(
      record.sessionId,
      UNRECOGNIZED_TURN_EVIDENCE,
    );
    if (rulings.length === 0) {
      return;
    }
    const reportedRunIds = new Set<RunId>();
    for (const ruling of rulings) {
      if (!ruling.decision.tripped) {
        continue;
      }
      const runId = this.#runRoutes.runIdForAbandonedFrame(record, ruling.joinKey);
      if (runId === undefined || this.#runtimeBindingQuarantine.isRunDisposed(runId)) {
        continue;
      }
      reportedRunIds.add(runId);
      this.#ruleTurnTerminalAgainstRun(record.sessionId, runId, ruling.decision);
    }
    // Emitted even if every ruling duplicated: the counts are the person's only sight of these
    // writes.
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
      kind: "abandoned-frames-ruled",
      ruledFrameCount: rulings.length,
      reportedRunCount: reportedRunIds.size,
    });
  }

  /**
   * Fails the runs whose frames a resume superseded, once per run, with
   * `composeSupersededDeliveryRunFailure`, which claims only what is known. `record` is the
   * superseded leg, `undefined` only when the resume found no predecessor.
   */
  failSupersededDeliveries(record: CodexSessionRecord | undefined, sessionId: SessionId): void {
    const abandoned = this.#outboundFrameTripwire.abandonScope(sessionId);
    if (abandoned.length === 0) {
      return;
    }
    const reportedRunIds = new Set<RunId>();
    for (const frame of abandoned) {
      const runId =
        record === undefined
          ? this.#runRoutes.runIdBoundToSession(frame.joinKey, sessionId)
          : this.#runRoutes.runIdForAbandonedFrame(record, frame.joinKey);
      if (runId === undefined || reportedRunIds.has(runId)) {
        continue;
      }
      reportedRunIds.add(runId);
      this.#reportTextNeutralizationFailure(
        sessionId,
        runId,
        composeSupersededDeliveryRunFailure(frame.detailOrigin),
      );
    }
    // Emitted even if no frame resolved to a run: the counts are the person's only sight of the
    // writes.
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
      kind: "superseded-frames-failed",
      abandonedFrameCount: abandoned.length,
      reportedRunCount: reportedRunIds.size,
    });
  }

  // A throwing consumer must not become a second failure: the run terminal is the guarantee, and
  // losing it would leave the swallowed turn with no record.
  #reportTextNeutralizationFailure(
    sessionId: SessionId,
    runId: RunId,
    failure: TextNeutralizationRunFailure,
  ): void {
    try {
      this.#options.onTextNeutralizationFailure(sessionId, runId, failure);
    } catch (cause) {
      this.#options.diagnostics.emit({
        provider: CODEX_DRIVER_NAME,
        kind: "text_neutralization_trip_report_failed",
        rawWireType: null,
        dispositionReason: normalizeProviderFailureDetail(cause),
        details: { sessionId, runId, providerFailureDetail: failure.providerFailureDetail },
      });
    }
  }

  /**
   * Drops the unsettled frames of a binding this manager has released. Retained decisions
   * survive: they are keyed by turn and the intervention dispatcher reads them after teardown.
   */
  releaseOutboundFrameBudget(sessionId: SessionId): void {
    this.#outboundFrameTripwire.forgetScope(sessionId);
  }
}
