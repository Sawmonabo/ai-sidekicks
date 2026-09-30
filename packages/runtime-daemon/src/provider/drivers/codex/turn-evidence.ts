/**
 * Classifies what a Codex turn's terminal frame proves about how the turn ended, and binds the
 * terminal-emission gate to the Codex frame type.
 */

import { TerminalEmissionGate, type TerminalRunFrame } from "../../terminal-emission-gate.js";
import {
  UNRECOGNIZED_TURN_EVIDENCE,
  observedTurnEvidence,
  type TurnEvidenceClass,
  type TurnEvidenceClassification,
} from "../outbound-frame.js";

// This module is the sole terminal-emission boundary for the Codex leg. It stamps `intendedClose`
// on a daemon-initiated close's terminal payload so recovery reads a clean shutdown, and it
// suppresses a duplicate terminal per `(runId, runVersion)`, which would otherwise hit the partial
// unique index. The gate settles a run only on a `project` route.

/**
 * The Codex-named alias of the provider-neutral terminal run frame; the suppression rule lives in
 * `provider/terminal-emission-gate.ts` because both driver legs share one uniqueness index.
 */
export type CodexTerminalRunFrame = TerminalRunFrame;

/** The Codex terminal-emission gate, one per provider session; an empty Codex-named subclass. */
export class CodexTerminalEmissionGate extends TerminalEmissionGate {}

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

/** The value as a plain record, or `null` for anything else (including arrays). */
export function readCodexRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
  const payload = readCodexRecord(params);
  if (payload === null) {
    return null;
  }
  const turnId = payload["turnId"];
  if (typeof turnId !== "string" || turnId.length === 0) {
    return null;
  }
  const item = readCodexRecord(payload["item"]);
  if (item === null || item["type"] !== CODEX_MODEL_OUTPUT_ITEM_TYPE) {
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
  const payload = readCodexRecord(params);
  if (payload === null) {
    return UNRECOGNIZED_TURN_EVIDENCE;
  }
  const turn = readCodexRecord(payload["turn"]);
  if (turn === null) {
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
    items.some((entry) => readCodexRecord(entry)?.["type"] === CODEX_MODEL_OUTPUT_ITEM_TYPE)
  ) {
    observations.push("model_output");
  }
  if (
    CODEX_DECLARED_NON_COMPLETION_STATUSES.has(status) &&
    typeof readCodexRecord(turn["error"])?.["message"] === "string"
  ) {
    observations.push("declared_turn_failure");
  } else if (status === "interrupted") {
    // An interrupt need not carry an error payload, so the status alone is the declaration.
    observations.push("declared_turn_failure");
  }
  return observedTurnEvidence(...observations);
}
