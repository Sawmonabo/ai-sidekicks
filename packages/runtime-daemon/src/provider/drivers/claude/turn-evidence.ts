/**
 * Classifies what a Claude turn's `result` frame proves about how the turn ended, and binds the
 * terminal-emission gate to the Claude frame type.
 */

import { TerminalEmissionGate } from "../../terminal-emission-gate.js";
import {
  UNRECOGNIZED_TURN_EVIDENCE,
  observedTurnEvidence,
  type TurnEvidenceClass,
  type TurnEvidenceClassification,
} from "../../outbound-frame.js";
import { CLAUDE_WIRE_FRAME_KINDS } from "./event-normalizer.js";

// Terminal emission, as in the Codex normalizer, except `ClaudeChannelDisposalReason` carries an
// explicit `session_closed` intent, so an intended close is read, not inferred from timing.
// `closeSession` signals before disposing the channel, so the `result/*` it provokes is a clean
// shutdown, not a crash. Only a frame routed to the session's own thread settles a run, so a
// subagent's `result/*` never settles the parent's.

/** The Claude terminal-emission gate, one per provider session; empty, like Codex's subclass. */
export class ClaudeTerminalEmissionGate extends TerminalEmissionGate {}

// Derived from the census so a new subtype joins without a second edit. `success` is excluded:
// it is the subtype a swallowed turn wears.
const CLAUDE_DECLARED_FAILURE_RESULT_SUBTYPES: ReadonlySet<string> = new Set(
  CLAUDE_WIRE_FRAME_KINDS.filter((kind) => kind.startsWith("result/error_")).map((kind) =>
    kind.slice("result/".length),
  ),
);

const CLAUDE_RESULT_SUBTYPES: ReadonlySet<string> = new Set(
  CLAUDE_WIRE_FRAME_KINDS.filter((kind) => kind.startsWith("result/")).map((kind) =>
    kind.slice("result/".length),
  ),
);

/** True for a finite number greater than zero. */
export function isPositiveFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonEmptyRecord(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}

/**
 * Reads a settling `result` frame for typed evidence that a model turn happened. `num_turns`,
 * `duration_api_ms`, `total_cost_usd` and `modelUsage` move together on a real turn and are all
 * zero-valued on an intercepted one (measured on the pinned build).
 */
export function classifyClaudeTurnEvidence(terminalFrame: unknown): TurnEvidenceClassification {
  if (typeof terminalFrame !== "object" || terminalFrame === null || Array.isArray(terminalFrame)) {
    return UNRECOGNIZED_TURN_EVIDENCE;
  }
  const frame = terminalFrame as Record<string, unknown>;
  if (frame["type"] !== "result") {
    return UNRECOGNIZED_TURN_EVIDENCE;
  }
  const subtype = frame["subtype"];
  if (typeof subtype !== "string" || !CLAUDE_RESULT_SUBTYPES.has(subtype)) {
    return UNRECOGNIZED_TURN_EVIDENCE;
  }

  // Not read: `is_error` (false on an intercepted run, true on a refused real turn), the
  // `<synthetic>` model (an API-errored turn renders it too), and the `<local-command-stdout>`
  // wrapper or `is_meta`, whose shape set is open and would fail open.
  const observations: TurnEvidenceClass[] = [];
  if (
    isPositiveFiniteNumber(frame["num_turns"]) ||
    isPositiveFiniteNumber(frame["duration_api_ms"]) ||
    isPositiveFiniteNumber(frame["total_cost_usd"])
  ) {
    observations.push("turn_accounting");
  }
  if (isNonEmptyRecord(frame["modelUsage"])) {
    observations.push("model_output");
  }
  if (CLAUDE_DECLARED_FAILURE_RESULT_SUBTYPES.has(subtype)) {
    observations.push("declared_turn_failure");
  }
  return observedTurnEvidence(...observations);
}
