// What a Codex turn's terminal frame proves about how the turn ended, and the run's end it reports:
// the one place a Codex turn's terminal becomes a run state change.

import type { RunFailureCause } from "@ai-sidekicks/contracts/run/failure-cause";
import type { RunId } from "@ai-sidekicks/contracts/run/id";

import type { RunTransitionRequest } from "../../../session/run/engine.js";
import type { TerminalEmissionGate } from "../../terminal-emission-gate.js";
import type { ThreadFrameRoute } from "../../thread-frame-router.js";
import {
  UNRECOGNIZED_TURN_EVIDENCE,
  observedTurnEvidence,
  type TurnEvidenceClass,
  type TurnEvidenceClassification,
} from "../../turn-evidence.js";
import { isPlainObject } from "../../record-readers.js";

/** The `ThreadItem` variant that IS model output at the pin. */
const CODEX_MODEL_OUTPUT_ITEM_TYPE = "agentMessage";

/**
 * `TurnStatus` members that declare a non-completion; `interrupted` is a deliberate daemon act.
 * `completed` is excluded on purpose: a client-side command dispatch reports success, which would
 * make the check unreachable.
 */
const CODEX_DECLARED_NON_COMPLETION_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "interrupted",
]);

/** Every `TurnStatus` member the pin's generated schema carries. */
const CODEX_TURN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "failed",
  "inProgress",
]);

/** One in-flight turn-evidence reading, keyed by the turn it belongs to. */
export interface CodexTurnEvidenceObservation {
  readonly turnId: string;
  readonly observation: TurnEvidenceClass;
}

/**
 * Reads one in-flight notification for evidence that a turn is producing model output (an
 * `agentMessage` item, not the `userMessage` echo), or `null`. Evidence must accrue mid-turn
 * because `turn/completed` can carry `itemsView: "notLoaded"` with empty `items` (measured).
 */
export function classifyCodexTurnEvidenceObservation(
  method: string,
  params: unknown,
): CodexTurnEvidenceObservation | null {
  if (!method.startsWith("item/")) {
    return null;
  }
  if (!isPlainObject(params)) {
    return null;
  }
  const turnId = params["turnId"];
  if (typeof turnId !== "string" || turnId.length === 0) {
    return null;
  }
  const item = params["item"];
  if (!isPlainObject(item) || item["type"] !== CODEX_MODEL_OUTPUT_ITEM_TYPE) {
    return null;
  }
  return { turnId, observation: "model_output" };
}

/**
 * Reads a settling `turn/completed` payload for typed evidence that a model turn happened. No
 * message text is read (`TurnError.message` is vendor prose, so only its presence counts), and
 * `durationMs` is not evidence: a measured quota-exhausted turn carried `durationMs: 2838`.
 */
export function classifyCodexTurnEvidence(params: unknown): TurnEvidenceClassification {
  if (!isPlainObject(params)) {
    return UNRECOGNIZED_TURN_EVIDENCE;
  }
  const turn = params["turn"];
  if (!isPlainObject(turn)) {
    return UNRECOGNIZED_TURN_EVIDENCE;
  }
  const status = turn["status"];
  if (typeof status !== "string" || !CODEX_TURN_STATUSES.has(status)) {
    return UNRECOGNIZED_TURN_EVIDENCE;
  }

  const observations: TurnEvidenceClass[] = [];
  const items = turn["items"];
  if (
    Array.isArray(items) &&
    items.some((entry) => isPlainObject(entry) && entry["type"] === CODEX_MODEL_OUTPUT_ITEM_TYPE)
  ) {
    observations.push("model_output");
  }
  const turnError = turn["error"];
  if (
    CODEX_DECLARED_NON_COMPLETION_STATUSES.has(status) &&
    isPlainObject(turnError) &&
    typeof turnError["message"] === "string"
  ) {
    observations.push("declared_turn_failure");
  } else if (status === "interrupted") {
    // An interrupt need not carry an error payload, so the status alone is the declaration.
    observations.push("declared_turn_failure");
  }
  return observedTurnEvidence(...observations);
}

/** What a turn's terminal is composed from: the frame, its run and epoch, and what failed it. */
export interface CodexTurnTerminalInput {
  readonly params: unknown;
  readonly runId: RunId;
  /** The turn's epoch, the gate's run version. */
  readonly turnEpoch: number;
  readonly route: ThreadFrameRoute;
  readonly gate: TerminalEmissionGate;
  /** Why a failed turn failed, where Codex's readings name it: a usage limit or spent retries. */
  readonly failureCause: RunFailureCause | undefined;
  /** Codex's last error message on the turn, for a failed turn whose own error carries none. */
  readonly fallbackDetail: string | undefined;
}

/**
 * The run's end a settling `turn/completed` reports, admitted through the session's terminal gate:
 * `completed`, `interrupted`, or `failed` with the usage limit or spent retries that failed it.
 * `undefined` when the gate suppressed it or the frame's status is not one Codex declares.
 */
export function composeCodexTurnTerminal(
  input: CodexTurnTerminalInput,
): RunTransitionRequest | undefined {
  const evidence = classifyCodexTurnEvidence(input.params);
  const turn = isPlainObject(input.params) ? input.params["turn"] : undefined;
  const status = isPlainObject(turn) ? turn["status"] : undefined;
  if (!evidence.recognized || status === "inProgress") {
    return undefined;
  }
  const decision = input.gate.admitTerminalFrame({
    runId: input.runId,
    runVersion: input.turnEpoch,
    rawWireType: "turn/completed",
    route: input.route,
  });
  if (!decision.emit) {
    return undefined;
  }
  return composeRunEnd(input.runId, turn, {
    completionKind: "turn",
    intendedClose: decision.intendedClose,
    failureCause: input.failureCause,
    fallbackDetail: input.fallbackDetail,
  });
}

/**
 * The end a helper's last turn gives its child run: `completed` as a task, `interrupted`, or
 * `failed` for any other status. A helper's turns carry no epoch of the session's runs, so no
 * terminal gate admits it; the child run ends once.
 */
export function composeCodexChildTerminal(
  childRunId: RunId,
  turnParams: unknown,
): RunTransitionRequest {
  const turn = isPlainObject(turnParams) ? turnParams["turn"] : undefined;
  return composeRunEnd(childRunId, turn, {
    completionKind: "task",
    intendedClose: false,
    failureCause: undefined,
    fallbackDetail: undefined,
  });
}

// A turn's status as its run's end; any status but completed or interrupted fails the run.
function composeRunEnd(
  runId: RunId,
  turn: unknown,
  end: {
    readonly completionKind: "turn" | "task";
    readonly intendedClose: boolean;
    readonly failureCause: RunFailureCause | undefined;
    readonly fallbackDetail: string | undefined;
  },
): RunTransitionRequest {
  const status = isPlainObject(turn) ? turn["status"] : undefined;
  const closing = end.intendedClose ? { intendedClose: true as const } : {};
  if (status === "completed") {
    return { runId, newState: "completed", completionKind: end.completionKind, ...closing };
  }
  if (status === "interrupted") {
    return { runId, newState: "interrupted", ...closing };
  }
  const turnError = isPlainObject(turn) ? turn["error"] : undefined;
  const turnMessage = isPlainObject(turnError) ? turnError["message"] : undefined;
  const detail =
    typeof turnMessage === "string" && turnMessage.length > 0 ? turnMessage : end.fallbackDetail;
  return {
    runId,
    newState: "failed",
    failureCategory: "provider failure",
    ...(end.failureCause === undefined ? {} : { failureCause: end.failureCause }),
    ...(detail === undefined ? {} : { providerFailureDetail: detail }),
    ...closing,
  };
}
