// The growth port the fixture bridge actually serves.
//
// Every other growth operation refuses under both bridges, which is what makes the
// "not checked" absence a true statement rather than a placeholder. Six do not:
// the two the console cannot function without — a session snapshot read and a
// session directory read — the attention projection read, which is the only one of
// them the console must not compute for itself, the gitflow branch-context read,
// whose whole answer today is that there is none, the caller-identity read, which is
// answered from a scenario that states its own viewer and refused from one that does
// not, and the invites list, which is answered from a scenario's own script and
// otherwise from the empty ledger.
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
//
// WHY THE CALLER-IDENTITY READ IS ANSWERED FROM A FIELD AND NOT FROM JOIN ORDER
//
// `ConsoleScenario` now carries `viewingParticipantId` — which of the roster this
// window IS — and the read is served from that field and from nothing else. The
// field exists because the fact had no other honest source: join order is who opened
// the session and who followed, on any machine, so reading its head as "me" is a
// fabrication, and a surface handed a fabricated identity renders a role gate as
// though it had been checked.
//
// A scenario that states no viewer is therefore not a gap to fill in with a guess.
// The operation refuses for it, exactly as it did before the field existed, and the
// refusal says "not checked" — which is true of a script that has not said. That is
// why the served set names this operation and the answer is still conditional: the
// operation IS scripted here, and whether a given scenario scripts the fact is the
// scenario's business. `wire-truth.ts` holds a stated viewer to the roster, so the
// served arm can never answer with an identity no surface could resolve a role from.
//
// WHY THE REGISTRY READS REFUSE HERE, AND WHY THAT IS NOT A GAP EITHER
//
// Two rows land beside it whose operations this fixture answers none of, and each
// refuses because a scenario states nothing it could answer FROM — not because the
// script has not caught up.
//
//   • The session's callback-tool registry. A scenario can play `tool.*` beats, and
//     folding those into a registry would answer the wrong question — a tool
//     OBSERVED being called is not a tool REGISTERED as callable, and telling them
//     apart is the whole reason the approvals pane wants this read. A fixture that
//     derived one from the other would teach the pane the conflation it is meant to
//     end. Nor is the empty list available: the registered set is legitimately
//     withheld at spawn while the approval seam is unregistered, so `[]` is a real
//     daemon answer, and returning it from a scenario that models no registry at all
//     would put a true-looking value in front of a surface for a fact nobody checked.
//
//   • The sidekick definition registry. Definitions are node-local configuration and
//     no scenario carries a node, so the same argument holds with nothing to weigh
//     against it — and unlike the branch-context read there is no absence to serve
//     either, because a node with no definitions and a node nobody asked are answers
//     to different questions.
//
// `findScenariosNaming` beside this file pins the callback-tool premise the way the
// branch finder pins its own, and pins the identity premise from the other side: no
// scenario states a viewer under any name but the one field the port reads.

import type {
  AttentionItem,
  AttentionProjection,
  AttentionSeverity,
  AttentionTrigger,
} from "./attention-projection.js";
import type { GrowthOperationId } from "./growth-entry.js";
import type { GrowthOutcome } from "./growth-outcome.js";
import {
  createRefusingGrowthPort,
  growthScriptedReplyUnavailable,
  growthUnavailable,
  type GrowthPort,
} from "./growth-port.js";
import type { GrowthSessionSummary } from "./growth-values.js";
import type { ConsoleScenario, ScenarioEngine } from "./scenario.js";
import { settleScriptedReply } from "./scripted-reply.js";

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
  // identity
  "callerParticipantRead",
  // invites
  "invitesList",
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
      value: directorySessionsOf(engine.scenario),
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
    gitflowBranchContextRead: async () =>
      // Routed through the scripted-reply seam so a repos scenario that DOES script
      // `gitflow.branchContextRead` is answered from the script, on the frozen clock,
      // with the loading window and the two non-arrival refusals a real read has. No
      // scenario scripts one today, and none can — see the header — so the unscripted
      // arm is the one that runs, and it answers with the absence rather than a
      // refusal: the operation IS answered here and what it found is nothing, whereas
      // a refusal would say the wire is missing, which under this bridge is not what
      // happened.
      answerFromScriptedReply(
        engine,
        "gitflow.branchContextRead",
        "gitflowBranchContextRead",
        () => ({
          branchContext: undefined,
        }),
      ),
    // identity
    callerParticipantRead: async (request) => {
      const { viewingParticipantId } = engine.scenario;
      // Refused rather than answered with an absence, and the distinction is the
      // opposite of the branch-context read's above. There, the operation was
      // answered and what it found was nothing — a state a surface has to draw.
      // Here there is no such state: a session always HAS a viewer, and a scenario
      // that has not said which one has left the question unasked rather than
      // answered it emptily. So this takes the same "not checked" refusal the live
      // bridge takes, which is the one honest reading.
      if (viewingParticipantId === undefined) {
        return growthUnavailable("callerParticipantRead");
      }
      // Scoped to the session the scenario is playing, on the `sessionRead` rule
      // next door: an identity is a fact about one session's roster, and lending
      // this session's viewer to another would tell a surface it holds a role in a
      // session it may not even be a member of.
      if (request.sessionId !== engine.scenario.sessionId) {
        return growthUnavailable("callerParticipantRead");
      }
      return { status: "served", value: { participantId: viewingParticipantId } };
    },
    // invites
    invitesList: async () =>
      // Routed through the scripted-reply seam on the branch-context read's rule, and
      // answered with the EMPTY LEDGER when a scenario scripts nothing. The two facts
      // are different and the surface draws them differently: "the read is not
      // registered" is what a release build renders, and "this session has sent
      // nobody an invitation" is a state the sent-invite ledger and the received-
      // invite shelf both have to draw and could reach from no scenario at all while
      // this operation refused.
      //
      // An empty array is a legitimate daemon answer here in a way it is NOT for the
      // callback-tool registry next door: an invite ledger with no rows is an ordinary
      // session, whereas a withheld tool registry and an empty one are different
      // answers to different questions.
      answerFromScriptedReply(engine, "invite.list", "invitesList", () => []),
  };
  return { ...createRefusingGrowthPort(), ...served };
}

/**
 * The session state a scenario declares for its own session, if it declares one.
 *
 * A scenario's `session.read` reply is its statement of what that session IS, so
 * the reply is where the state is read from. The alternative — lifting a state out
 * of a beat's payload — would have the fixture folding the event stream to
 * re-derive a fact the scenario already states, and would disagree with the read
 * the same window performs a moment later.
 *
 * `undefined` when the scenario scripts no session read: a scenario that declares
 * nothing about its session has not said the session exists, and inventing a state
 * for it here would be the fixture answering a question nobody asked it.
 */
function declaredSessionState(scenario: ConsoleScenario): string | undefined {
  const sessionRead = scenario.replies.find((reply) => reply.call === "session.read");
  // Read out of `unknown` by narrowing, the way `readRunStateTransition` below
  // reads a beat's payload: a scenario's `result` is deliberately untyped so a
  // scenario can carry any registered reply, and a cast here would assert a shape
  // the type system was never given.
  return readSessionState(readMember(readMember(sessionRead?.result, "session"), "state"));
}

/** One member of a value that may not be an object at all. */
function readMember(value: unknown, member: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)[member]
    : undefined;
}

function readSessionState(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Session states that put a session in the node's directory.
 *
 * The directory answers what this node HAS, and `provisioning` is the state of a
 * session that is still being created — the one a first run is sitting in, and the
 * whole reason the first-run scenario exists. Listing it would make a freshly
 * installed console show a session row where `Spec-023 §Console Design (Meridian)`
 * §The five kinds of nothing requires the EMPTY kind: "no sessions yet", a stated
 * fact with a next action.
 *
 * An allow-list rather than a deny-list, so a state nobody has thought about yet
 * stays out of the directory rather than appearing in it by default. The directory
 * is the surface a person reads to find out what exists; the failure that matters
 * is a row for something that does not.
 */
const DIRECTORY_SESSION_STATES: ReadonlySet<string> = new Set(["active", "paused", "archived"]);

/**
 * The node's session directory, derived from what the scenario declares.
 *
 * Not "the scenario's session, always". `sessionId` is a required member of every
 * scenario because the beats and the reads are keyed on it, so its presence says
 * which session a scenario is ABOUT and says nothing about whether that session
 * exists yet — and answering with a row regardless made the first-run scenario, a
 * fresh install with nothing in it, list a session on the surface whose committed
 * screenshot baselines exist to pin the empty state.
 *
 * No title: a scenario declares none as a field, and lifting one out of a beat's
 * payload would have the fixture inventing a wire fact for the one surface that
 * renders it.
 */
function directorySessionsOf(scenario: ConsoleScenario): readonly GrowthSessionSummary[] {
  const state = declaredSessionState(scenario);
  if (state === undefined || !DIRECTORY_SESSION_STATES.has(state)) {
    return [];
  }
  return [{ sessionId: scenario.sessionId, state } satisfies GrowthSessionSummary];
}

/**
 * Answer one served operation from the scenario's script, or from its own absence.
 *
 * The four settlements `scripted-reply.ts` reports land here as three different kinds
 * of answer, and the mapping is the whole reason this helper exists rather than four
 * inline arms per operation:
 *
 *   • **Unscripted** is not a failure on this port. Every operation the fixture serves
 *     has an honest answer of its own for a scenario that scripts nothing — the branch
 *     read's is that this workspace has no branch context — so the caller supplies it
 *     and the port serves it. `reply-unscripted` therefore stays what it has always
 *     been: `fixture-bridge.ts`'s authoring error, raised where a call really has no
 *     answer at all.
 *   • **Resolved** is served verbatim. The cast is the seam's own property rather than
 *     a shortcut: a `ScenarioReply` carries `unknown`, exactly as it does for the
 *     bridge's `daemon.call`, and there is no registered reply schema to narrow it
 *     against until the wire lands.
 *   • **Unanswered** refuses by name. This is the rule the codes exist for: a reply
 *     the frozen clock never released must never reach a surface as an absent value,
 *     because an absent value renders as "there is none" — a claim about the session
 *     that nothing checked.
 *   • **Refused** is thrown VERBATIM, unwrapped, exactly as the bridge throws it. A
 *     scripted refusal is the DAEMON's, and this port's outcome union has no arm for
 *     one; adding a code for it would paraphrase the daemon's own `{code, message}`
 *     into a growth-scoped vocabulary, which is the one thing a fixture must not do.
 *     A rejection is also what the caller will get once the wire lands and the
 *     operation becomes an ordinary bridge call, so the fixture is not teaching a
 *     shape the real seam will not produce.
 */
async function answerFromScriptedReply<TValue>(
  engine: ScenarioEngine,
  call: string,
  operationId: GrowthOperationId,
  whenUnscripted: () => TValue,
): Promise<GrowthOutcome<TValue>> {
  const settlement = await settleScriptedReply(engine, call);
  switch (settlement.status) {
    case "unscripted":
      return { status: "served", value: whenUnscripted() };
    case "resolved":
      return { status: "served", value: settlement.value as TValue };
    case "unanswered":
      return growthScriptedReplyUnavailable(operationId, settlement.code, settlement.detail);
    case "refused":
      throw settlement.refusal;
  }
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
