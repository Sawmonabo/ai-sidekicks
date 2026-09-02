// The attention projection the fixture derives from one scenario's playback.
//
// The shape lives in `attention-projection.ts`; the port that serves it lives in
// `fixture-growth-port.ts`; the fold from beats to items lives here. Split out
// because it is a distinct failure: the port is wrong when an operation answers
// where it should refuse, and this fold is wrong when an item is raised for a state
// the corpus does not classify, resolved late, or attributed to the wrong run.
//
// WHY THE PROJECTION IS DERIVED HERE AND NOT IN A SURFACE
//
// `Spec-019 §State And Data Implications` makes attention "a derived projection from
// canonical events", and Plan-019 I-019-4 requires clients to READ that projection
// rather than recompute it from a partial local view — the failure it names is a
// session badge and its run badges drifting apart. The fixture bridge is the daemon's
// stand-in, so the derivation belongs on this side of the seam, exactly where the
// daemon's projector will be. A notification centre that folded the event stream
// itself would be the client-side aggregation that invariant forbids, and it would
// keep being that after the wire landed.
//
// WHAT THE DERIVATION CLAIMS, AND WHAT IT DELIBERATELY DOES NOT
//
// Three of the six registered triggers are derived, and they are exactly the three
// `Spec-019 §Default Behavior` classifies: "Pending approval or required input is
// actionable attention by default" covers `run.waiting_for_approval` and
// `run.waiting_for_input`; "Run completion and invite receipt are informational
// attention by default" covers `run.completed`. The other three are not derived, and
// each is left out for a reason rather than for lack of time:
//
//   • `run_failed` — the spec classifies neither severity for it, and Plan-019 T2.3
//     owns the trigger-to-severity mapping. A fixture that picked one would be
//     teaching every surface a wire fact no document states.
//   • `invite_received` — `invite.created` is registered, but no scenario plays one,
//     so the fold would have no input; it lands with the scenario that needs it.
//   • `mention` — the event census registers no mention type at all, so there is
//     nothing canonical to fold.

import type {
  AttentionItem,
  AttentionProjection,
  AttentionSeverity,
  AttentionTrigger,
} from "./attention-projection.js";
import type { ConsoleScenario } from "./scenario.js";

/** How one run state reaches a participant, where `Spec-019` classifies it. */
interface AttentionClassification {
  readonly trigger: AttentionTrigger;
  readonly severity: AttentionSeverity;
  /** The one line a surface renders. Prose; the item carries the identifiers. */
  readonly summary: string;
}

/**
 * The run states that are attention, and what kind of attention each one is.
 *
 * Keyed by the run state itself rather than by the event kind that announced it,
 * because a run's ATTENTION follows its current state: `Spec-019 §Required Behavior`
 * derives emission "from canonical session or run state", and the state is what the
 * transition's `newState` carries. Keying on the kind would have made resolution a
 * second mechanism — some rule about which later kinds cancel which earlier ones —
 * where here it is the same one fact, read again.
 *
 * Three entries, and the three are exactly what `Spec-019 §Default Behavior`
 * classifies; the header says why the other three registered triggers are absent.
 */
const ATTENTION_BY_RUN_STATE: Readonly<Record<string, AttentionClassification>> = {
  waiting_for_approval: {
    trigger: "pending_approval",
    severity: "actionable",
    summary: "A run is waiting for an approval decision.",
  },
  waiting_for_input: {
    trigger: "pending_input",
    severity: "actionable",
    summary: "A run is waiting for participant input.",
  },
  completed: {
    trigger: "run_completed",
    severity: "informational",
    summary: "A run finished.",
  },
};

/**
 * The scenario's attention projection at one point in its playback.
 *
 * `deliveredBeatCount` rather than the whole script, so the projection is the state
 * the frozen clock has actually reached: a surface that advances the engine sees
 * attention arrive and resolve exactly as a live session would, and a screenshot
 * pinned at a tick is pinned against what the console could really have known then.
 */
export function deriveAttentionProjection(
  scenario: ConsoleScenario,
  deliveredBeatCount: number,
): AttentionProjection {
  // Keyed by run, holding the run's CURRENT attention: a later transition into an
  // unclassified state deletes the entry, which is how an item resolves. There is
  // no separate resolution pass, and no `resolvedAt` on a served item — this
  // projection answers what is outstanding now.
  const byRunId = new Map<string, AttentionItem>();
  for (const beat of scenario.beats.slice(0, deliveredBeatCount)) {
    const transition = readRunStateTransition(beat.event.payload);
    if (transition === undefined) {
      continue;
    }
    const classification = ATTENTION_BY_RUN_STATE[transition.newState];
    if (classification === undefined) {
      byRunId.delete(transition.runId);
      continue;
    }
    byRunId.set(transition.runId, {
      id: `${transition.runId}:${classification.trigger}`,
      sessionId: scenario.sessionId,
      runId: transition.runId,
      trigger: classification.trigger,
      severity: classification.severity,
      summary: classification.summary,
      // The console's event projection keys on `sequence` and carries no opaque
      // daemon row id (`scenarios/wire-truth.ts` supplies one only to probe the
      // strict layer), so the reference is composed from the two members that do
      // identify the event. An invented opaque-looking id would read as a wire
      // fact and be traceable to nothing.
      sourceEventId: `${scenario.sessionId}:${String(beat.event.sequence)}`,
      createdAt: beat.event.occurredAt,
    });
  }
  const runScoped = [...byRunId.values()];
  const aggregate = deriveSessionAggregate(scenario.sessionId, runScoped);
  return { items: aggregate === undefined ? runScoped : [...runScoped, aggregate] };
}

/** One run state transition, or `undefined` when this payload is not one. */
function readRunStateTransition(
  payload: Readonly<Record<string, unknown>> | undefined,
): { readonly runId: string; readonly newState: string } | undefined {
  if (payload === undefined) {
    return undefined;
  }
  const { runId, newState } = payload;
  // Both members, not either: a run-lifecycle payload is a state transition
  // carrying both, and a payload with a `runId` and no `newState` is some other
  // event that merely mentions a run — folding it in would clear attention on a
  // usage reading or a tool result.
  return typeof runId === "string" && typeof newState === "string"
    ? { runId, newState }
    : undefined;
}

/**
 * The session-scoped aggregate over the run-scoped contributors, or `undefined`
 * when there are none.
 *
 * Plan-019 D-019-2's rule, transcribed rather than reinvented: the aggregate is an
 * `AttentionItem` with no `runId`; `severity` is `actionable` while ANY contributor
 * is, `informational` only when every one is; and `trigger` and `sourceEventId` come
 * from one representative contributor chosen by highest severity, then earliest
 * `createdAt`, then lexicographically smallest `id`. The chain is total, so two
 * readers of one projection state never disagree about which contributor the
 * aggregate names. `summary` and `createdAt` follow the representative too — the
 * aggregate has no birth of its own, and inventing one would be the only alternative.
 */
function deriveSessionAggregate(
  sessionId: string,
  contributors: readonly AttentionItem[],
): AttentionItem | undefined {
  const representative = contributors.reduce<AttentionItem | undefined>(
    (chosen, candidate) =>
      chosen === undefined || outranksAsRepresentative(candidate, chosen) ? candidate : chosen,
    undefined,
  );
  if (representative === undefined) {
    return undefined;
  }
  return {
    id: `${sessionId}:session`,
    sessionId,
    trigger: representative.trigger,
    severity: contributors.some((item) => item.severity === "actionable")
      ? "actionable"
      : "informational",
    summary: representative.summary,
    sourceEventId: representative.sourceEventId,
    createdAt: representative.createdAt,
  };
}

/** D-019-2's tiebreak chain: severity, then `createdAt`, then `id`. */
function outranksAsRepresentative(candidate: AttentionItem, chosen: AttentionItem): boolean {
  if (candidate.severity !== chosen.severity) {
    return candidate.severity === "actionable";
  }
  if (candidate.createdAt !== chosen.createdAt) {
    return candidate.createdAt < chosen.createdAt;
  }
  return candidate.id < chosen.id;
}
