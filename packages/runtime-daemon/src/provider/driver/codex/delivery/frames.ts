// What each frame of a session's Codex threads becomes for the run engine: a turn's boundary and
// end, its tool calls' rows (a command's end even after its turn ended or the session moved off
// its conversation), the reply, reasoning and plan streamed as pieces, a plan's record, a
// command's live output, a helper's own rows on its child run, the reviewer's flags and blocks,
// the provider's notices, a model switch with its sentence, and the live safety hold. Every
// delivery is dispatched as its frame is read, in frame order; a tool call's end waits only for
// its start, and a helper's rows for its child run's start.

import { CommandIdSchema } from "@ai-sidekicks/contracts/command";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionNoticePayload } from "@ai-sidekicks/contracts/session/controls/events";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { eventIdOf } from "../../../../session/run/inbound.js";
import type { PendingCompactionRegistry } from "../../../compaction-wait.js";
import type { CommandOutputPublisher } from "../../../port/command-output-publisher.js";
import type { PortRegistration } from "../../../port/registration.js";
import type { ReviewerDenialPort } from "../../../port/reviewer-denial.js";
import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import type { TerminalEmissionGate } from "../../../terminal-emission-gate.js";
import type { ThreadFrameRoute } from "../../../thread-frame-router.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import { composePlanProposedPayload } from "../../plan-record.js";
import { CODEX_DRIVER_NAME } from "../capabilities.js";
import type { CodexRunBinding, CodexRunRoutes } from "../run/routes.js";
import type { CodexAskKind } from "../server-requests.js";
import {
  codexCompactionWaitKey,
  type CodexRoutableFrame,
  type CodexSessionRecord,
} from "../session/state.js";
import {
  reportDiagnosticFromDetachedFrame,
  type CodexDiagnosticSink,
} from "../transport/diagnostics.js";
import { composeCodexTurnTerminal } from "../turn-evidence.js";
import { CodexChildRuns, isCodexSpawnCall } from "./children.js";
import type { CodexDeliveryDispatch } from "./dispatch.js";
import { CODEX_CONTEXT_WINDOW_EXCEEDED_ERROR, readCodexTurnFailureCause } from "./failure-cause.js";
import {
  assignTurnEpoch,
  type CodexRunningCommand,
  forgetTurn,
  isTurnTakenByNoRun,
  readCodexErrorKind,
} from "./memory.js";
import {
  holdReroute,
  readCodexConfigWarning,
  readCodexDeprecationNotice,
  readCodexWarning,
  releaseReroute,
} from "./notices.js";
import { CodexReviewerDelivery, holdGuardianWarning } from "./reviewer.js";
import {
  CODEX_COMMAND_ITEM_TYPE,
  composeCodexRowInbound,
  type CodexItemRow,
  type CodexProseRowType,
  type CodexRowDelivery,
  type CodexRowRun,
  composeCodexProsePiece,
  isCodexToolItem,
  readCodexFrameItem,
  readCodexItemCompletedRow,
  readCodexItemProse,
  readCodexToolStartRow,
} from "./rows.js";

// The item echoing a tool output a client starts a turn with in place of a message.
const CODEX_TOOL_OUTPUT_ITEM_TYPE = "functionCallOutput";

// The streamed pieces of an item's prose, by method, and the row each is written as.
const CODEX_PROSE_DELTA_ROW_TYPES: Readonly<Record<string, CodexProseRowType>> = {
  "item/agentMessage/delta": "assistant.message",
  "item/plan/delta": "assistant.message",
  "item/reasoning/summaryTextDelta": "assistant.thinking_update",
  "item/reasoning/summaryPartAdded": "assistant.thinking_update",
  "item/reasoning/textDelta": "assistant.thinking_update",
};

// The run an item frame's rows go on, with the turn it belongs to.
interface CodexItemRun {
  readonly turnId: string;
  readonly row: CodexRowRun;
}

// Frames that draw nothing and go to the daemon's log only.
const CODEX_LOGGED_ONLY_METHODS: ReadonlySet<string> = new Set([
  "turn/moderationMetadata",
  "model/verification",
  "modelProvider/authRecoveryStarted",
  "modelProvider/authRecoveryCompleted",
  "windows/worldWritableWarning",
]);

/** How a turn's run stands when one of its frames arrives. */
type CodexTurnEnding = "live" | "interrupted" | "paused" | "retried";

/** The run one turn's frames belong to, with its binding and how the turn stands. */
interface CodexTurnRun {
  readonly runId: RunId;
  readonly binding: CodexRunBinding;
  readonly ending: CodexTurnEnding;
}

/** What the frame delivery reads and acts through. */
export interface CodexFrameDeliveryDependencies {
  readonly recordFor: (sessionId: SessionId) => CodexSessionRecord | undefined;
  /** The session's terminal gate, which drops a second terminal and marks a closing one. */
  readonly terminalGateFor: (sessionId: SessionId) => TerminalEmissionGate;
  readonly runRoutes: CodexRunRoutes;
  readonly dispatch: CodexDeliveryDispatch;
  readonly reviewerDenials: PortRegistration<ReviewerDenialPort>;
  /** The running-commands stream's live output; absent, a command's output is dropped. */
  readonly commandOutput: PortRegistration<CommandOutputPublisher>;
  /** Settles the card of an ask Codex resolved itself. */
  readonly withdrawAsk: (sessionId: SessionId, requestId: string, askKind: CodexAskKind) => void;
  readonly reportDiagnostic: CodexDiagnosticSink;
  /** The driver's diagnostic channel, recording a frame the driver has no row or cause for. */
  readonly diagnostics: DriverDiagnosticsEmitter;
  /** Cuts a turn too long for the model's window out of the conversation. */
  readonly cutOversizedTurn: (record: CodexSessionRecord, turnId: string) => void;
  /** The compaction waits, which a compaction's own turn ends. */
  readonly pendingCompactions: PendingCompactionRegistry;
  readonly now: () => number;
}

/** Turns every frame the routing band keeps for a session into its deliveries. */
export class CodexFrameDelivery {
  readonly #dependencies: CodexFrameDeliveryDependencies;
  readonly #children: CodexChildRuns;
  readonly #reviewer: CodexReviewerDelivery;
  // The gate's run versions, counted for the whole lifecycle so no two turns of a run share one.
  #nextTurnEpoch = 1;
  readonly #mintTurnEpoch = (): number => {
    const epoch = this.#nextTurnEpoch;
    this.#nextTurnEpoch += 1;
    return epoch;
  };

  constructor(dependencies: CodexFrameDeliveryDependencies) {
    this.#dependencies = dependencies;
    this.#reviewer = new CodexReviewerDelivery(dependencies);
    this.#children = new CodexChildRuns(dependencies.dispatch, (runId) =>
      dependencies.runRoutes.bindingFor(runId),
    );
  }

  /** Starts the child run of a helper the session's conversation announced. */
  startChild(
    sessionId: SessionId,
    childThreadId: string,
    parentThreadId: string,
    subagentId: string,
  ): void {
    const record = this.#dependencies.recordFor(sessionId);
    if (record !== undefined) {
      this.#children.startChild(record, childThreadId, parentThreadId, subagentId);
    }
  }

  /**
   * Ends the child run of a helper whose last turn ended, the asks that turn still held and the
   * pieces it still had waiting.
   */
  completeChild(sessionId: SessionId, childThreadId: string, turnParams: unknown): void {
    const record = this.#dependencies.recordFor(sessionId);
    if (record === undefined) {
      return;
    }
    const params = isPlainObject(turnParams) ? turnParams : {};
    this.#withdrawEndedTurnAsks(record, params);
    const turn = isPlainObject(params["turn"]) ? params["turn"] : {};
    const turnId = readNonEmptyString(turn, "id");
    // Every other warning is answered by the review that follows it, so one still waiting as a
    // helper's turn ends interrupted is the one Codex's reviewer sent as it stopped the turn.
    const isStoppedByCodex = turn["status"] === "interrupted";
    this.#children.deliverOnChild(record, childThreadId, (run, startRowEventId) => {
      if (turnId !== undefined) {
        record.delivery.streamedText.endTurn(turnId);
      }
      this.#reviewer.endTurn(
        record.delivery,
        childThreadId,
        startRowEventId,
        turnId ?? null,
        isStoppedByCodex ? run : undefined,
      );
    });
    this.#children.completeChild(record, childThreadId, turnParams);
  }

  /**
   * Delivers one frame the routing band kept for a session, while the turn bookkeeping still
   * holds the turn's route. Never throws: it runs inside the connection's message handler.
   */
  deliver(sessionId: SessionId, frame: CodexRoutableFrame, route: ThreadFrameRoute): void {
    const record = this.#dependencies.recordFor(sessionId);
    if (record === undefined) {
      return;
    }
    const params = isPlainObject(frame.params) ? frame.params : {};
    const method = frame.rawWireType;
    switch (method) {
      case "turn/started":
        this.#deliverTurnStarted(record, params);
        return;
      case "turn/completed":
        this.#deliverTurnCompleted(record, params, route);
        return;
      case "item/started":
        this.#deliverItemStarted(record, params);
        return;
      case "item/completed":
        this.#deliverItemCompleted(record, params);
        return;
      case "item/agentMessage/delta":
      case "item/plan/delta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/summaryPartAdded":
      case "item/reasoning/textDelta":
        this.#deliverProseDelta(record, method, params);
        return;
      case "item/commandExecution/outputDelta":
        this.#deliverCommandOutput(record, params);
        return;
      case "error":
        this.#deliverError(record, params);
        return;
      case "guardianWarning":
      case "item/autoApprovalReview/completed":
      case "autoApprovalReview/strictReviewRequired":
        this.#deliverReviewerFrame(record, method, params);
        return;
      case "warning":
        this.#deliverWarning(record, params);
        return;
      case "deprecationNotice":
        this.#sendNotice(readCodexDeprecationNotice(record.sessionId, params), method);
        return;
      case "configWarning":
        this.#sendNotice(readCodexConfigWarning(record.sessionId, params), method);
        return;
      case "model/rerouted":
        this.#deliverReroute(record, params);
        return;
      case "model/safetyBuffering/updated":
        this.#deliverSafetyBuffering(record, params);
        return;
      case "serverRequest/resolved":
        this.#forgetResolvedRequest(record, params);
        return;
      default:
        if (CODEX_LOGGED_ONLY_METHODS.has(method)) {
          reportDiagnosticFromDetachedFrame(this.#dependencies.reportDiagnostic, {
            kind: "provider-notice-logged",
            method,
            sessionId,
          });
        }
    }
  }

  // A turn opens its execution on the run's binding; a turn whose `turn/start` answer has not
  // arrived yet belongs to the oldest run still starting, since Codex accepts turns in send order.
  #deliverTurnStarted(record: CodexSessionRecord, params: Readonly<Record<string, unknown>>): void {
    if (readNonEmptyString(params, "threadId") !== record.threadId) {
      return;
    }
    const turn = isPlainObject(params["turn"]) ? params["turn"] : {};
    const turnId = readNonEmptyString(turn, "id");
    if (turnId === undefined) {
      return;
    }
    if (
      !record.runIdByActiveTurnId.has(turnId) &&
      !record.settledTurnIds.has(turnId) &&
      !isTurnTakenByNoRun(record.delivery, turnId)
    ) {
      const startingRunId = record.delivery.startingTurnRunIds.shift();
      if (startingRunId !== undefined) {
        record.runIdByActiveTurnId.set(turnId, startingRunId);
        this.#dependencies.runRoutes.bindRun(startingRunId, record.sessionId, turnId);
      }
    }
    const turnRun = this.#turnRunFor(record, turnId);
    if (turnRun === undefined) {
      this.#reportUnattributed("turn/started", turnId);
      return;
    }
    assignTurnEpoch(record.delivery, turnId, this.#mintTurnEpoch);
    void this.#dependencies.dispatch.send(
      record.sessionId,
      { kind: "turn_boundary", bindingId: turnRun.binding.bindingId },
      "turn/started",
    );
    const marker = this.#dependencies.dispatch.send(
      record.sessionId,
      {
        kind: "run_marker",
        bindingId: turnRun.binding.bindingId,
        marker: { type: "run.turn_started", payload: { runId: turnRun.runId } },
      },
      "turn/started",
    );
    record.delivery.turnStartEventIdByTurnId.set(turnId, marker.then(eventIdOf));
  }

  // The turn's end: rows still held for their start go out, a switch still waiting for its
  // sentence goes without one, the reviewer's warning on a turn it stopped is flagged, and a live
  // turn's run ends through the terminal gate. An interrupted turn's end is written by the run
  // engine, a paused one's by run control, and a retried one's run goes on in the turn the retry
  // sends.
  #deliverTurnCompleted(
    record: CodexSessionRecord,
    params: Readonly<Record<string, unknown>>,
    route: ThreadFrameRoute,
  ): void {
    const threadId = readNonEmptyString(params, "threadId");
    if (threadId !== record.threadId) {
      return;
    }
    const turn = isPlainObject(params["turn"]) ? params["turn"] : {};
    const turnId = readNonEmptyString(turn, "id");
    if (turnId === undefined) {
      return;
    }
    this.#withdrawEndedTurnAsks(record, params);
    record.delivery.streamedText.endTurn(turnId);
    this.#sendRows(record, record.delivery.reorderBuffer.flushExpired(Number.POSITIVE_INFINITY));
    const reroute = releaseReroute(record.delivery, threadId);
    if (reroute !== undefined) {
      this.#sendRow(record, reroute);
    }
    this.#children.settleThreadSpawnCalls(record, threadId);
    const turnRun = this.#turnRunFor(record, turnId);
    // A live turn ending interrupted is one Codex itself stopped, since the daemon's own interrupt
    // takes the turn from its run first.
    const isStoppedByCodex = turnRun?.ending === "live" && turn["status"] === "interrupted";
    this.#reviewer.endTurn(
      record.delivery,
      threadId,
      record.delivery.turnStartEventIdByTurnId.get(turnId),
      turnId,
      turnRun !== undefined && isStoppedByCodex ? this.#rowRun(record, turnRun) : undefined,
    );
    if (turnRun === undefined) {
      // A turn no run holds is a compaction's own, whose frame came before this end if it compacted.
      this.#dependencies.pendingCompactions.observeTurnEnd(
        codexCompactionWaitKey(record.sessionId, threadId),
      );
      this.#reportUnattributed("turn/completed", turnId);
    } else if (turnRun.ending === "live") {
      this.#deliverTerminal(record, params, route, turnId, turnRun);
    } else if (turnRun.ending === "interrupted") {
      this.#dependencies.runRoutes.forgetRun(turnRun.runId);
    }
    forgetTurn(record.delivery, turnId);
    record.turnInputByTurnId.delete(turnId);
  }

  #deliverTerminal(
    record: CodexSessionRecord,
    params: Readonly<Record<string, unknown>>,
    route: ThreadFrameRoute,
    turnId: string,
    turnRun: CodexTurnRun,
  ): void {
    const memory = record.delivery;
    const turn = isPlainObject(params["turn"]) ? params["turn"] : {};
    const finalError = memory.finalErrorByTurnId.get(turnId);
    const errorKind = readCodexErrorKind(turn["error"]) ?? finalError?.errorKind ?? null;
    const change = composeCodexTurnTerminal({
      params,
      runId: turnRun.runId,
      turnEpoch: assignTurnEpoch(memory, turnId, this.#mintTurnEpoch),
      route,
      gate: this.#dependencies.terminalGateFor(record.sessionId),
      failureCause: readCodexTurnFailureCause(record, turnId, errorKind),
      fallbackDetail: finalError?.message,
    });
    if (change === undefined) {
      return;
    }
    void this.#dependencies.dispatch.send(
      record.sessionId,
      {
        kind: "run_lifecycle",
        bindingId: turnRun.binding.bindingId,
        operation: { correlationKey: turnId, isOpening: false },
        change,
      },
      "turn/completed",
    );
    this.#dependencies.runRoutes.forgetRun(turnRun.runId);
    if (change.newState !== "failed") {
      return;
    }
    if (errorKind === CODEX_CONTEXT_WINDOW_EXCEEDED_ERROR) {
      this.#dependencies.cutOversizedTurn(record, turnId);
    }
  }

  #deliverItemStarted(record: CodexSessionRecord, params: Readonly<Record<string, unknown>>): void {
    const item = readCodexFrameItem(params);
    const itemId = item === undefined ? undefined : readNonEmptyString(item, "id");
    const threadId = readNonEmptyString(params, "threadId");
    if (item === undefined || itemId === undefined || threadId === undefined) {
      return;
    }
    this.#withItemRun(record, params, "item/started", (run) => {
      const startedAtMs = params["startedAtMs"];
      const startedAtMsById =
        record.delivery.itemStartedAtMsByTurnId.get(run.turnId) ?? new Map<string, number>();
      record.delivery.itemStartedAtMsByTurnId.set(run.turnId, startedAtMsById);
      const itemStartedAtMs =
        typeof startedAtMs === "number" ? startedAtMs : this.#dependencies.now();
      startedAtMsById.set(itemId, itemStartedAtMs);
      if (item["type"] === CODEX_COMMAND_ITEM_TYPE) {
        record.delivery.runningCommandByItemId.set(itemId, {
          threadId,
          row: run.row,
          startedAtMs: itemStartedAtMs,
        });
      }
      if (item["type"] === "agentMessage") {
        record.delivery.replyStartedTurnIds.add(run.turnId);
        // A reply's start can already carry its first words, which no delta repeats.
        if (typeof item["text"] === "string") {
          this.#appendProse(record, run, itemId, "assistant.message", item["text"], "item/started");
        }
      }
      if (isCodexSpawnCall(item)) {
        this.#children.noteSpawnCall(record, threadId, itemId, run.row);
      }
      if (isCodexToolItem(item)) {
        this.#admitRow(record, readCodexToolStartRow(item, run.row, "item/started"));
      }
    });
  }

  #deliverItemCompleted(
    record: CodexSessionRecord,
    params: Readonly<Record<string, unknown>>,
  ): void {
    const item = readCodexFrameItem(params);
    const itemId = item === undefined ? undefined : readNonEmptyString(item, "id");
    const threadId = readNonEmptyString(params, "threadId");
    if (item === undefined || itemId === undefined || threadId === undefined) {
      return;
    }
    const command = this.#takeRunningCommand(record, params, itemId);
    if (command !== undefined) {
      this.#completeItem(record, item, itemId, threadId, params, {
        row: command.row,
        startedAtMs: command.startedAtMs,
      });
      return;
    }
    this.#withItemRun(record, params, "item/completed", (run) => {
      const startedAtMsById = record.delivery.itemStartedAtMsByTurnId.get(run.turnId);
      const startedAtMs = startedAtMsById?.get(itemId);
      startedAtMsById?.delete(itemId);
      this.#completeItem(record, item, itemId, threadId, params, { row: run.row, startedAtMs });
    });
  }

  // A finished item: its prose's last piece and, for a plan, the plan's record; a tool call's
  // result or failure; a review's end.
  #completeItem(
    record: CodexSessionRecord,
    item: Readonly<Record<string, unknown>>,
    itemId: string,
    threadId: string,
    params: Readonly<Record<string, unknown>>,
    run: { readonly row: CodexRowRun; readonly startedAtMs: number | undefined },
  ): void {
    const prose = readCodexItemProse(item);
    if (prose !== undefined) {
      const isWhole = record.delivery.streamedText.complete(itemId, prose.text, (piece) => {
        this.#admitRow(
          record,
          composeCodexProsePiece(run.row, itemId, prose.rowType, piece, "item/completed"),
        );
      });
      if (!isWhole) {
        reportDiagnosticFromDetachedFrame(this.#dependencies.reportDiagnostic, {
          kind: "streamed-text-diverged",
          threadId,
          itemId,
        });
      }
    }
    if (item["type"] === "plan" && prose !== undefined && prose.text.trim() !== "") {
      void this.#dependencies.dispatch.send(
        record.sessionId,
        {
          kind: "unstamped_row",
          bindingId: run.row.bindingId,
          row: {
            type: "plan.proposed",
            payload: composePlanProposedPayload({
              sessionId: record.sessionId,
              runId: run.row.runId,
              text: prose.text,
            }),
          },
        },
        "item/completed",
      );
    }
    if (isCodexSpawnCall(item) && item["status"] === "failed") {
      this.#children.settleSpawnCall(record, threadId, itemId);
    }
    record.delivery.toolRowEventIdByItemId.delete(itemId);
    if (item["type"] === CODEX_TOOL_OUTPUT_ITEM_TYPE) {
      this.#dependencies.diagnostics.emit({
        provider: CODEX_DRIVER_NAME,
        kind: "unmapped_wire_kind",
        rawWireType: "item/completed",
        dispositionReason:
          "the echo of a tool output a client started a turn with, which the daemon never " +
          "sends; it draws no row",
        details: { sessionId: record.sessionId, tool: readNonEmptyString(item, "name") ?? null },
      });
    }
    const completedAtMs = params["completedAtMs"];
    this.#admitRow(
      record,
      readCodexItemCompletedRow(item, run.row, "item/completed", {
        startedAtMs: run.startedAtMs,
        completedAtMs: typeof completedAtMs === "number" ? completedAtMs : this.#dependencies.now(),
      }),
    );
    if (item["type"] === "exitedReviewMode") {
      this.#dependencies.dispatch.sendNotice(
        { sessionId: record.sessionId, kind: "review_finished" },
        "item/completed",
      );
    }
  }

  // A streamed piece of a reply, its reasoning or a plan, which goes out within the piece interval.
  #deliverProseDelta(
    record: CodexSessionRecord,
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): void {
    const itemId = readNonEmptyString(params, "itemId");
    const rowType = CODEX_PROSE_DELTA_ROW_TYPES[method];
    // A new summary part is set off from the one before, as the finished reasoning joins them.
    const summaryIndex = params["summaryIndex"];
    const delta =
      method === "item/reasoning/summaryPartAdded"
        ? typeof summaryIndex === "number" && summaryIndex > 0
          ? "\n\n"
          : ""
        : params["delta"];
    if (itemId === undefined || rowType === undefined || typeof delta !== "string") {
      return;
    }
    this.#withItemRun(record, params, method, (run) => {
      this.#appendProse(record, run, itemId, rowType, delta, method);
    });
  }

  #appendProse(
    record: CodexSessionRecord,
    run: CodexItemRun,
    itemId: string,
    rowType: CodexProseRowType,
    delta: string,
    method: string,
  ): void {
    record.delivery.streamedText.append(itemId, run.turnId, delta, (piece) => {
      this.#admitRow(record, composeCodexProsePiece(run.row, itemId, rowType, piece, method));
    });
  }

  // A command's output as it prints, to the running-commands stream and never stored; the whole
  // output lands on the command's own end.
  #deliverCommandOutput(
    record: CodexSessionRecord,
    params: Readonly<Record<string, unknown>>,
  ): void {
    const publisher = this.#dependencies.commandOutput.port;
    const commandId = CommandIdSchema.safeParse(params["itemId"]);
    const data = params["delta"];
    // An item id outside the command id's bounds names no row the stream could show it in.
    if (publisher === undefined || !commandId.success || typeof data !== "string") {
      return;
    }
    publisher.publish({
      kind: "output",
      sessionId: record.sessionId,
      commandId: commandId.data,
      data,
    });
  }

  // An error Codex retries marks the turn retried; one it will not retry is the turn's final error.
  #deliverError(record: CodexSessionRecord, params: Readonly<Record<string, unknown>>): void {
    const turnId = readNonEmptyString(params, "turnId");
    if (turnId === undefined) {
      return;
    }
    const error = params["error"];
    if (params["willRetry"] === true) {
      record.delivery.retriedTurnIds.add(turnId);
    } else {
      const message = isPlainObject(error) ? readNonEmptyString(error, "message") : undefined;
      record.delivery.finalErrorByTurnId.set(turnId, {
        message: message ?? "",
        errorKind: readCodexErrorKind(error),
      });
    }
  }

  #deliverWarning(record: CodexSessionRecord, params: Readonly<Record<string, unknown>>): void {
    const reading = readCodexWarning(record.delivery, record.sessionId, params);
    if (reading.kind === "reroute") {
      this.#sendRow(record, reading.delivery);
    } else if (reading.kind === "notice") {
      this.#dependencies.dispatch.sendNotice(reading.notice, "warning");
    }
  }

  #deliverReroute(record: CodexSessionRecord, params: Readonly<Record<string, unknown>>): void {
    const run = this.#rowRunFor(record, params, "model/rerouted");
    if (run === undefined) {
      return;
    }
    const replaced = holdReroute(record.delivery, params, run.row);
    if (replaced !== undefined) {
      this.#sendRow(record, replaced);
    }
  }

  #deliverSafetyBuffering(
    record: CodexSessionRecord,
    params: Readonly<Record<string, unknown>>,
  ): void {
    const run = this.#rowRunFor(record, params, "model/safetyBuffering/updated");
    if (run === undefined) {
      return;
    }
    const fasterModel = readNonEmptyString(params, "fasterModel");
    void this.#dependencies.dispatch.send(
      record.sessionId,
      {
        kind: "live_run_state",
        bindingId: run.row.bindingId,
        state: {
          sessionId: record.sessionId,
          runId: run.row.runId,
          turnId: run.turnId,
          active: params["showBufferingUi"] === true,
          ...(fasterModel === undefined ? {} : { fasterModel }),
        },
      },
      "model/safetyBuffering/updated",
    );
  }

  // An ask a turn that ended still held can no longer be answered, so its card is withdrawn.
  #withdrawEndedTurnAsks(
    record: CodexSessionRecord,
    params: Readonly<Record<string, unknown>>,
  ): void {
    const threadId = readNonEmptyString(params, "threadId");
    const turn = isPlainObject(params["turn"]) ? params["turn"] : {};
    const turnId = readNonEmptyString(turn, "id");
    if (threadId === undefined || turnId === undefined) {
      return;
    }
    for (const forgotten of record.service.forgetHeldRequestsOfTurn(threadId, turnId)) {
      this.#dependencies.withdrawAsk(record.sessionId, forgotten.requestId, forgotten.askKind);
    }
  }

  // Codex settled an ask itself, such as at a turn's interrupt: no answer is sent for it, and its
  // card is withdrawn.
  #forgetResolvedRequest(
    record: CodexSessionRecord,
    params: Readonly<Record<string, unknown>>,
  ): void {
    const requestId = params["requestId"];
    if (typeof requestId !== "string" && typeof requestId !== "number") {
      return;
    }
    const askKind = record.service.forgetHeldRequest(String(requestId));
    if (askKind !== undefined) {
      this.#dependencies.withdrawAsk(record.sessionId, String(requestId), askKind);
    }
  }

  // A reviewer frame's work: on a helper's thread on its child run, in that helper's frame order,
  // a turn-wide flag about its `subagent.started` row; on the session's own thread on its turn's
  // run, about the turn's start. One no run owns is reported.
  #deliverReviewerFrame(
    record: CodexSessionRecord,
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): void {
    const threadId = readNonEmptyString(params, "threadId");
    const turnId = readNonEmptyString(params, "turnId");
    const deliver = (
      run: CodexRowRun | undefined,
      turnEventId: Promise<string | undefined> | undefined,
    ): void => {
      if (method === "guardianWarning") {
        holdGuardianWarning(record.delivery, params);
      } else if (method === "item/autoApprovalReview/completed") {
        this.#reviewer.completeReview(record.delivery, params, run);
      } else if (run !== undefined && turnId !== undefined) {
        this.#reviewer.requireReview(turnEventId, turnId, run);
      }
    };
    if (threadId !== record.threadId) {
      // A thread that is neither the session's own nor a live helper's has no run to own it.
      if (threadId === undefined || !this.#children.deliverOnChild(record, threadId, deliver)) {
        this.#reportUnattributed(method, turnId ?? null);
      }
      return;
    }
    const turnRun = turnId === undefined ? undefined : this.#turnRunFor(record, turnId);
    if (turnRun === undefined && method !== "guardianWarning") {
      this.#reportUnattributed(method, turnId ?? null);
    }
    deliver(
      turnRun === undefined ? undefined : this.#rowRun(record, turnRun),
      turnId === undefined ? undefined : record.delivery.turnStartEventIdByTurnId.get(turnId),
    );
  }

  #rowRun(record: CodexSessionRecord, turnRun: CodexTurnRun): CodexRowRun {
    return {
      sessionId: record.sessionId,
      runId: turnRun.runId,
      agentId: turnRun.binding.agentId,
      bindingId: turnRun.binding.bindingId,
    };
  }

  #admitRow(record: CodexSessionRecord, row: CodexItemRow | undefined): void {
    if (row === undefined) {
      return;
    }
    this.#sendRows(
      record,
      record.delivery.reorderBuffer.admit(
        { toolCallId: row.toolCallId, pairingRole: row.pairingRole, event: row.delivery },
        this.#dependencies.now(),
      ),
    );
  }

  #sendRows(record: CodexSessionRecord, rows: readonly CodexRowDelivery[]): void {
    for (const row of rows) {
      this.#sendRow(record, row);
    }
  }

  #sendRow(record: CodexSessionRecord, row: CodexRowDelivery): void {
    const sent = this.#dependencies.dispatch.send(
      record.sessionId,
      composeCodexRowInbound(row),
      row.method,
    );
    const toolCallId = row.row.type === "tool.invoked" ? row.row.payload.toolCallId : undefined;
    if (toolCallId !== undefined) {
      record.delivery.toolRowEventIdByItemId.set(toolCallId, sent.then(eventIdOf));
    }
  }

  #sendNotice(notice: SessionNoticePayload | undefined, method: string): void {
    if (notice !== undefined) {
      this.#dependencies.dispatch.sendNotice(notice, method);
    }
  }

  // The command an item's end closes, on the conversation it started in, even after its turn
  // ended or the session moved off that conversation; it leaves the memory here.
  #takeRunningCommand(
    record: CodexSessionRecord,
    params: Readonly<Record<string, unknown>>,
    itemId: string | undefined,
  ): CodexRunningCommand | undefined {
    const command =
      itemId === undefined ? undefined : record.delivery.runningCommandByItemId.get(itemId);
    if (
      itemId === undefined ||
      command === undefined ||
      command.threadId !== readNonEmptyString(params, "threadId")
    ) {
      return undefined;
    }
    record.delivery.runningCommandByItemId.delete(itemId);
    return command;
  }

  // Hands `act` the run an item frame's rows go on: a helper's child run once it started, in that
  // helper's frame order, else the run of the session's own turn.
  #withItemRun(
    record: CodexSessionRecord,
    params: Readonly<Record<string, unknown>>,
    method: string,
    act: (run: CodexItemRun) => void,
  ): void {
    const threadId = readNonEmptyString(params, "threadId");
    const turnId = readNonEmptyString(params, "turnId");
    if (
      threadId !== undefined &&
      threadId !== record.threadId &&
      turnId !== undefined &&
      this.#children.deliverOnChild(record, threadId, (row) => {
        act({ turnId, row });
      })
    ) {
      return;
    }
    const run = this.#rowRunFor(record, params, method);
    if (run !== undefined) {
      act(run);
    }
  }

  // The run a turn-scoped frame of the session's own thread belongs to, as rows name it.
  #rowRunFor(
    record: CodexSessionRecord,
    params: Readonly<Record<string, unknown>>,
    method: string,
  ): CodexItemRun | undefined {
    if (readNonEmptyString(params, "threadId") !== record.threadId) {
      return undefined;
    }
    const turnId = readNonEmptyString(params, "turnId");
    const turnRun = turnId === undefined ? undefined : this.#turnRunFor(record, turnId);
    if (turnId === undefined || turnRun === undefined) {
      this.#reportUnattributed(method, turnId ?? null);
      return undefined;
    }
    return { turnId, row: this.#rowRun(record, turnRun) };
  }

  // A live turn's run, else the run an interrupt, a pause or a retry took the turn from, whose
  // last frames still belong to it.
  #turnRunFor(record: CodexSessionRecord, turnId: string): CodexTurnRun | undefined {
    const candidates: readonly [RunId | undefined, CodexTurnEnding][] = [
      [record.runIdByActiveTurnId.get(turnId), "live"],
      [record.interruptedRunIdByTurnId.get(turnId), "interrupted"],
      [record.pausedRunIdByInterruptedTurnId.get(turnId), "paused"],
      [record.delivery.retriedRunIdByTurnId.get(turnId), "retried"],
    ];
    const [runId, ending] = candidates.find(([candidate]) => candidate !== undefined) ?? [
      undefined,
      "live",
    ];
    const binding =
      runId === undefined ? undefined : this.#dependencies.runRoutes.bindingFor(runId);
    return runId === undefined || binding === undefined ? undefined : { runId, binding, ending };
  }

  #reportUnattributed(method: string, turnId: string | null): void {
    reportDiagnosticFromDetachedFrame(this.#dependencies.reportDiagnostic, {
      kind: "unattributed-turn-frame",
      method,
      turnId,
    });
  }
}
