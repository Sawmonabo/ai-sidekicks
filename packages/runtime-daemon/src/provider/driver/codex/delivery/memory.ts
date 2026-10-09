// What one Codex session's deliveries remember between frames: each turn's run epoch for the
// session's terminal gate, the runs whose turn is starting, a turn's last error, the reviewer's
// and the reroute's pending halves, the helpers' child runs, and the reorder buffer rows pass.

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import type { RunId } from "@ai-sidekicks/contracts/run/id";

import { isPlainObject } from "../../../record-readers.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import { StreamedText } from "../../streamed-text.js";
import { NormalizedEventReorderBuffer } from "../../reorder-buffer.js";
import { CODEX_DRIVER_NAME } from "../capabilities.js";
import type { CodexRowDelivery, CodexRowRun } from "./rows.js";

// Bounds on the tool rows a completion can wait for its start: Codex sends an item's start before
// its end on one ordered connection, so a held completion is a fault, reported when flushed.
const REORDER_MAX_BUFFERED_EVENTS = 64;
const REORDER_PAIRING_TIMEOUT_MS = 5_000;

/** A turn's last error that Codex will not retry, which the turn's failure carries. */
interface CodexTurnErrorReading {
  readonly message: string;
  /** Codex's typed reason: a string arm, or the object arm's one key; `null` when none. */
  readonly errorKind: string | null;
}

/** Codex's typed reason for an error: a string arm, the object arm's one key, or `null`. */
export function readCodexErrorKind(error: unknown): string | null {
  const info = isPlainObject(error) ? error["codexErrorInfo"] : undefined;
  if (typeof info === "string") {
    return info;
  }
  if (isPlainObject(info)) {
    const keys = Object.keys(info);
    return keys.length === 1 ? (keys[0] ?? null) : null;
  }
  return null;
}

/** A helper-spawning tool call in flight on a thread, with the run that made it. */
export interface CodexSpawnCall {
  readonly toolCallId: string;
  readonly run: CodexRowRun;
}

/**
 * A helper's child run once started: its own id, the run it was started beneath, and the event of
 * its `subagent.started` row, `undefined` when that row was refused.
 */
export interface CodexStartedChildRun {
  readonly childRunId: RunId;
  readonly parentRunId: RunId;
  readonly startRowEventId: Promise<string | undefined>;
}

/** A helper Codex started, as its child run, and the spawn call and binding it came from. */
export interface CodexChildRun {
  /** Settles once the start was delivered; `undefined` when it was absorbed or refused. */
  readonly started: Promise<CodexStartedChildRun | undefined>;
  /** The helper's own rows, delivered in frame order once its start settles; never rejects. */
  rows: Promise<void>;
  readonly agentId: AgentId;
  readonly bindingId: string;
  readonly subagentId: string;
  readonly parentToolCallId: string | undefined;
}

/** A command whose row is open, kept past its turn's end, since a command can outlive its turn. */
export interface CodexRunningCommand {
  /** The conversation it runs in, which may be one the session has since moved off. */
  readonly threadId: string;
  /** The run and binding its row went out on. */
  readonly row: CodexRowRun;
  readonly startedAtMs: number;
}

/** A turn Codex started by itself whose run is opening. */
interface CodexSelfStartedTurnOpening {
  readonly turnId: string;
  /** Settles once the run opened or failed to; never rejects. */
  readonly opened: Promise<void>;
}

/** One session's delivery memory; replaced with the session record on every establishment. */
export interface CodexDeliveryMemory {
  /** Each routed turn's epoch, the gate's run version; it leaves with the turn's terminal. */
  readonly turnEpochByTurnId: Map<string, number>;
  /** Runs whose `turn/start` is on the wire, oldest first: Codex accepts them in send order. */
  readonly startingTurnRunIds: RunId[];
  /** The last error per turn Codex will not retry, by turn id. */
  readonly finalErrorByTurnId: Map<string, CodexTurnErrorReading>;
  /** Turns Codex retried after an error, so a final error on one means its retries ran out. */
  readonly retriedTurnIds: Set<string>;
  /**
   * Runs whose turn a faster-model retry stopped, by that turn's id: its end is the retry's, never
   * the run's, and the run's binding stays for the turn the retry sends.
   */
  readonly retriedRunIdByTurnId: Map<string, RunId>;
  /**
   * The id of each turn's `run.turn_started` event once written, which a flag about the whole turn
   * points at; `undefined` when the marker was not written. Each leaves with its turn's terminal.
   */
  readonly turnStartEventIdByTurnId: Map<string, Promise<string | undefined>>;
  /**
   * The id of each tool call's start event once written, by item id, which a reviewer flag about
   * the call points at; `undefined` when the row was not written. Each leaves with its item's end.
   */
  readonly toolRowEventIdByItemId: Map<string, Promise<string | undefined>>;
  /** Turns whose reply has started, by turn id; each leaves with its turn's terminal. */
  readonly replyStartedTurnIds: Set<string>;
  /** A reviewer warning waiting for the next review on its thread, by thread id. */
  readonly guardianWarningByThreadId: Map<string, string>;
  /** A reroute row waiting for its sentence, by thread id. */
  readonly pendingRerouteByThreadId: Map<string, CodexRowDelivery>;
  /** Helpers' child runs, by the helper's thread id. */
  readonly childRunByThreadId: Map<string, CodexChildRun>;
  /** Each started child run's helper thread, by the child's run id. */
  readonly childThreadIdByRunId: Map<RunId, string>;
  /** Each helper-spawning tool call in flight, by its thread; oldest first. */
  readonly spawnCallsByThreadId: Map<string, CodexSpawnCall[]>;
  /** When each tool item started, by turn id then item id, for its row's duration. */
  readonly itemStartedAtMsByTurnId: Map<string, Map<string, number>>;
  /** Each command whose row is open, by item id; it leaves on the command's own end. */
  readonly runningCommandByItemId: Map<string, CodexRunningCommand>;
  /**
   * The turn Codex started by itself whose run is opening, and the opening's end, which never
   * rejects; `undefined` when none opens.
   */
  selfStartedTurnOpening: CodexSelfStartedTurnOpening | undefined;
  /** Turns Codex started by itself whose run did not open: no run takes them. */
  readonly unownedTurnIds: Set<string>;
  readonly reorderBuffer: NormalizedEventReorderBuffer<CodexRowDelivery>;
  /** The replies, reasoning and plans being streamed, by item id, sent as stored pieces. */
  readonly streamedText: StreamedText;
}

/** A fresh delivery memory for one session record. */
export function createCodexDeliveryMemory(
  diagnostics: DriverDiagnosticsEmitter,
): CodexDeliveryMemory {
  return {
    turnEpochByTurnId: new Map(),
    startingTurnRunIds: [],
    finalErrorByTurnId: new Map(),
    retriedTurnIds: new Set(),
    retriedRunIdByTurnId: new Map(),
    turnStartEventIdByTurnId: new Map(),
    toolRowEventIdByItemId: new Map(),
    replyStartedTurnIds: new Set(),
    guardianWarningByThreadId: new Map(),
    pendingRerouteByThreadId: new Map(),
    childRunByThreadId: new Map(),
    childThreadIdByRunId: new Map(),
    spawnCallsByThreadId: new Map(),
    itemStartedAtMsByTurnId: new Map(),
    runningCommandByItemId: new Map(),
    selfStartedTurnOpening: undefined,
    unownedTurnIds: new Set(),
    reorderBuffer: new NormalizedEventReorderBuffer<CodexRowDelivery>({
      provider: CODEX_DRIVER_NAME,
      diagnostics,
      maxBufferedEvents: REORDER_MAX_BUFFERED_EVENTS,
      pairingTimeoutMs: REORDER_PAIRING_TIMEOUT_MS,
    }),
    streamedText: new StreamedText(),
  };
}

/**
 * A turn's run epoch, given once, at the turn's first frame. `mintEpoch` counts across every
 * record of the session, since its terminal gate outlives a resume.
 */
export function assignTurnEpoch(
  memory: CodexDeliveryMemory,
  turnId: string,
  mintEpoch: () => number,
): number {
  const assigned = memory.turnEpochByTurnId.get(turnId);
  if (assigned !== undefined) {
    return assigned;
  }
  const epoch = mintEpoch();
  memory.turnEpochByTurnId.set(turnId, epoch);
  return epoch;
}

/** Forgets what the memory held for a turn once its terminal was handled. */
export function forgetTurn(memory: CodexDeliveryMemory, turnId: string): void {
  memory.turnEpochByTurnId.delete(turnId);
  memory.finalErrorByTurnId.delete(turnId);
  memory.retriedTurnIds.delete(turnId);
  memory.retriedRunIdByTurnId.delete(turnId);
  memory.turnStartEventIdByTurnId.delete(turnId);
  memory.replyStartedTurnIds.delete(turnId);
  memory.itemStartedAtMsByTurnId.delete(turnId);
  memory.unownedTurnIds.delete(turnId);
}

/**
 * Whether a turn's start is for no run to take: its run is opening as the session's own, or its
 * opening failed.
 */
export function isTurnTakenByNoRun(memory: CodexDeliveryMemory, turnId: string): boolean {
  return memory.selfStartedTurnOpening?.turnId === turnId || memory.unownedTurnIds.has(turnId);
}
