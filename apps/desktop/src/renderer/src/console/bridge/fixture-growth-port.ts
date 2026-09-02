// The growth port the fixture bridge actually serves.
//
// Every other growth operation refuses under both bridges, which is what makes the
// "not checked" absence a true statement rather than a placeholder. Four do not:
// the two the console cannot function without — a session snapshot read and a
// session directory read — the attention projection read, which is the only one of
// them the console must not compute for itself, and the gitflow branch-context
// read, whose whole answer today is that there is none.
//
// WHY THE TWO SESSION READS ARE SERVED AND THE REST ARE NOT
//
// A `SessionStore` admits nothing until a read gives it a base state. With no read
// registered anywhere, every store this renderer opens buffers its stream and
// projects none of it — so the window binds no stream at all, the store layer is
// dormant in every build, and the endurance tier measures an idle console. The
// directory read is the same shape one level up: without it the only session set a
// surface can name is the set this window happens to have open, so a fresh window
// shows "nothing" for a node with sessions on it.
//
// Serving them here — from the scenario, under the fixture define — is what lets
// the whole store layer run against a scripted session while the wire is still
// unregistered. The live bridge keeps refusing both, so nothing about what a
// release build renders changes.
//
// WHY THE SNAPSHOT IS NOT `SessionReadResponse` FROM `@ai-sidekicks/contracts`
//
// It is the registered reply and it is the wrong shape for this seam, on two
// counts that both matter. It carries no console-orderable cursor, no entities and
// no join log — the three things `SessionStore.initialise` needs — so adopting it
// would leave the adapter fabricating all three anyway. And `SessionId` is a
// UUID-branded scalar while a scenario's session ids are scripted names, so the
// fixture could not produce a schema-valid value without a cast that switches off
// exactly the checking the reuse was for. The port's value is therefore the
// console's own `SessionSnapshot`, which mints no second shape, and the slate row
// names the registered request and reply as the half the corpus already owns.
//
// WHAT THE BASE STATE HONESTLY IS
//
// Cursor zero, no entities, and the scenario's join log. Zero rather than a
// position derived from the scenario's beats, because a base state ahead of the
// stream would make the store discard every beat below it; the subscription is
// replay-then-tail, so nothing is missed by starting at the bottom. A re-read
// therefore lands behind an initialised store's cursor and is a silent no-op,
// which is `SessionStore.admitsSnapshotAt`'s documented behaviour and not a defect
// of this port: repairing a degraded store needs a read that carries a position,
// and this one cannot until the wire does.
//
// WHY THE ATTENTION PROJECTION IS DERIVED HERE AND NOT IN A SURFACE
//
// `Spec-019 §State And Data Implications` makes attention "a derived projection from
// canonical events", and Plan-019 I-019-4 requires clients to READ that projection
// rather than recompute it from a partial local view — the failure it names is a
// session badge and its run badges drifting apart. The fixture bridge is the daemon's
// stand-in, so the derivation belongs here, on the far side of the seam, exactly
// where the daemon's projector will be. A notification centre that folded the event
// stream itself would be the client-side aggregation that invariant forbids, and it
// would keep being that after the wire landed.
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
//
// WHY THE BRANCH-CONTEXT READ IS SERVED AND ANSWERS NOTHING
//
// It is served so the repos surface can render the two different kinds of nothing
// `Spec-023 §Console Design (Meridian)` distinguishes. "Nobody asked" is the port's
// refusal and is what a release build still renders for this wire; "we asked and
// this workspace has no branch context" is a state the summary has to draw too, and
// under a refusing port it was unreachable — so the surface could only ever be built
// against half of its own empty states.
//
// The answer is the absence for every scenario, and that is a fact about the corpus
// rather than a stub. Two things would have to be true for a scenario to state a
// branch context, and neither is:
//
//   • `ConsoleScenario` carries no repo mount, no workspace, and no branch. Its
//     fields are a session id, a join order, beats, replies, and a start instant.
//   • No registered event payload names a branch. The `repo.*` / `workspace.*` /
//     `worktree.*` family payload is `{sessionId, repoMountId?, workspaceId?,
//     worktreeId?, state, actor?}` (`packages/contracts/src/repo.ts`), so a fold
//     over beats could reach a workspace and a worktree and would still have to
//     invent both branch names — and `BranchContextReadResponse` requires them.
//
// So the honest answer is that there is none, and `findScenariosNamingABranch` in
// the suite beside this file is what keeps the claim true: the day a scenario does
// carry a branch, that test fails and this derivation is what has to change.

import type {
  AttentionItem,
  AttentionProjection,
  AttentionSeverity,
  AttentionTrigger,
} from "./attention-projection.js";
import {
  createRefusingGrowthPort,
  type GrowthPort,
  type GrowthSessionSummary,
} from "./growth-port.js";
import type { ConsoleScenario, ScenarioEngine } from "./scenario.js";

/**
 * The operations the fixture answers rather than refuses.
 *
 * A tuple, so the served set is declared once: `scenario-manifest.ts` ledgers it,
 * `fixture-bridge.ts` publishes it as the bridge's served set, and the `Pick`
 * below makes a member with no implementation — or an implementation with no
 * member — a compile error rather than a runtime surprise.
 */
export const FIXTURE_SERVED_GROWTH_OPERATION_IDS = [
  "sessionRead",
  "sessionList",
  "attentionProjectionRead",
  // gitflow
  "gitflowBranchContextRead",
] as const;

/** One operation the fixture serves. Derived, so the set has exactly one home. */
export type FixtureServedGrowthOperationId = (typeof FIXTURE_SERVED_GROWTH_OPERATION_IDS)[number];

/**
 * Build the fixture's growth port for one running scenario.
 *
 * Starts from the refusing port so an operation added to the ledger and not to the
 * served set refuses by name instead of being absent — the port's shape is checked
 * against `GROWTH_OPERATIONS` by `failure-modes.test.ts`, and a spread that dropped
 * a method would fail that check rather than silently render `undefined is not a
 * function` in a surface.
 */
export function createFixtureGrowthPort(engine: ScenarioEngine): GrowthPort {
  const served: Pick<GrowthPort, FixtureServedGrowthOperationId> = {
    sessionRead: async (request) => ({
      status: "served",
      value: {
        cursor: 0,
        entities: [],
        // The join log is the scenario's only where the scenario is the session
        // being read. Another id gets an empty one rather than this session's
        // roster: hue allocation keys on join order, and lending one session's
        // order to another would colour a stranger's rows as if they were hers.
        participantJoinLog:
          request.sessionId === engine.scenario.sessionId
            ? engine.scenario.participantIdsInJoinOrder
            : [],
      },
    }),
    sessionList: async () => ({
      status: "served",
      value: [
        {
          sessionId: engine.scenario.sessionId,
          // A scenario plays one live session, so `active` is a reading rather
          // than a guess. No title: a scenario declares none as a field, and
          // lifting one out of a beat's payload would have the fixture inventing
          // a wire fact for the one surface that renders it.
          state: "active",
        } satisfies GrowthSessionSummary,
      ],
    }),
    attentionProjectionRead: async (request) => ({
      status: "served",
      value:
        request.sessionId === engine.scenario.sessionId
          ? deriveAttentionProjection(engine.scenario, engine.progress.deliveredBeatCount)
          : // A session this fixture is not playing has no canonical state here, and an
            // empty projection is the true answer rather than a refusal: the operation
            // IS served, and what it found for that session is nothing.
            { items: [] },
    }),
    // gitflow
    gitflowBranchContextRead: async () => ({
      status: "served",
      // No scenario states one, and none can — see the header. Served rather than
      // refused, because the operation IS answered here and what it found is
      // nothing; a refusal would say the wire is missing, which under this bridge
      // is not what happened.
      value: { branchContext: undefined },
    }),
  };
  return { ...createRefusingGrowthPort(), ...served };
}

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
function deriveAttentionProjection(
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
