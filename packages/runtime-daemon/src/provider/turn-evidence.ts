// The provider-neutral reading of how a model turn ended, which each driver's classifier fills
// from its own settling frame.

/**
 * The closed set of typed evidence that a model turn happened. `declared_turn_failure` covers a
 * turn that ended for a stated reason (quota, context window) with no output or accounting.
 */
export type TurnEvidenceClass = "model_output" | "turn_accounting" | "declared_turn_failure";

/**
 * One driver's reading of a settling frame; `recognized: false` means the frame was not one the
 * classifier knows, which is not the same as a turn with no evidence.
 */
export interface TurnEvidenceClassification {
  readonly recognized: boolean;
  readonly observations: readonly TurnEvidenceClass[];
}

/** A recognized settling frame carrying the given evidence, each class once. */
export function observedTurnEvidence(
  ...observations: readonly TurnEvidenceClass[]
): TurnEvidenceClassification {
  return { recognized: true, observations: Object.freeze([...new Set(observations)]) };
}

/** A settling frame the driver's classifier does not recognize. */
export const UNRECOGNIZED_TURN_EVIDENCE: TurnEvidenceClassification = Object.freeze({
  recognized: false,
  observations: Object.freeze([]),
});
