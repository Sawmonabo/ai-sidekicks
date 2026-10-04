// The rules that derive a session's attention: which run states are attention and of what
// kind, and how one session-level item is chosen from the run-level items under it.
//
// A run's attention follows its current state, so the table is keyed by run state rather than
// by the event that announced it. A later transition into a state the table does not list is
// how an item resolves; there is no separate resolution rule.
import type { AttentionSeverity, AttentionTrigger } from "@ai-sidekicks/contracts/attention";
import type { RunState } from "@ai-sidekicks/contracts/run-state";

import { normalizeOccurredAt } from "../events/canonicalizer.js";

/**
 * How one run state reaches a person, and which class it falls in.
 *
 * @consumedBy the attention projector
 */
export interface AttentionClassification {
  trigger: AttentionTrigger;
  severity: AttentionSeverity;
}

/**
 * The run states that are attention, and what kind each one is.
 *
 * A failed run is informational: it is terminal and blocks on no one, and its remedy
 * is a new run. Only a run waiting on the person is actionable.
 *
 * @consumedBy the attention projector
 */
export const ATTENTION_BY_RUN_STATE: Readonly<Partial<Record<RunState, AttentionClassification>>> =
  {
    waiting_for_approval: { trigger: "pending_approval", severity: "actionable" },
    waiting_for_input: { trigger: "pending_input", severity: "actionable" },
    completed: { trigger: "run_completed", severity: "informational" },
    failed: { trigger: "run_failed", severity: "informational" },
  };

/** The members of a run-level item the session-level choice reads. */
export interface AttentionContributor {
  id: string;
  severity: AttentionSeverity;
  /** An RFC 3339 timestamp, in `Z` or offset form. */
  createdAt: string;
}

/**
 * The session-level item's representative and severity, or `undefined` when no run
 * item exists.
 *
 * The severity is `actionable` while any contributor is, `informational` only when
 * every one is. The representative, whose trigger, source event and time the session
 * item carries, is chosen by highest severity, then earliest `createdAt`, then the
 * smallest `id`. The chain is total, so two readers of one projection never name
 * different representatives.
 *
 * Times are compared as instants, not as text: an offset stamp sorts after the `Z`
 * stamp of a moment it precedes, and two spellings of one moment must tie so the `id`
 * decides.
 */
export function deriveSessionAggregate<Contributor extends AttentionContributor>(
  contributors: readonly Contributor[],
): { representative: Contributor; severity: AttentionSeverity } | undefined {
  let representative: Contributor | undefined;
  for (const candidate of contributors) {
    if (representative === undefined || outranks(candidate, representative)) {
      representative = candidate;
    }
  }
  if (representative === undefined) {
    return undefined;
  }
  const severity = contributors.some((item) => item.severity === "actionable")
    ? "actionable"
    : "informational";
  return { representative, severity };
}

function outranks(candidate: AttentionContributor, chosen: AttentionContributor): boolean {
  if (candidate.severity !== chosen.severity) {
    return candidate.severity === "actionable";
  }
  // The normalized form is fixed-width UTC to the millisecond, so text order is time order.
  const candidateAt = normalizeOccurredAt(candidate.createdAt);
  const chosenAt = normalizeOccurredAt(chosen.createdAt);
  if (candidateAt !== chosenAt) {
    return candidateAt < chosenAt;
  }
  return candidate.id < chosen.id;
}
