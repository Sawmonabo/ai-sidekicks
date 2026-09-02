// The growth port the fixture bridge actually serves.
//
// Every other growth operation refuses under both bridges, which is what makes the
// "not checked" absence a true statement rather than a placeholder. Five do not:
// the two the console cannot function without — a session snapshot read and a
// session directory read — the attention projection read, which is the only one of
// them the console must not compute for itself, the gitflow branch-context read,
// whose whole answer today is that there is none, and the caller-identity read,
// which is answered from a scenario that states its own viewer and refused from one
// that does not.
//
// WHAT THIS MODULE OWNS, AND WHAT ITS THREE NEIGHBOURS DO
//
// This one owns the decision: which operations are served, and with which outcome.
// The three answers with a job of their own live beside it, because each fails in a
// way this one cannot — `fixture-session-directory.ts` derives what the node HAS,
// `fixture-attention-derivation.ts` folds beats into an attention projection, and
// `fixture-scripted-answer.ts` maps a scripted settlement onto an outcome.
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
// So the honest answer is that there is none, and `findScenariosNaming` in
// `fixture-growth-port.gitflow.test.ts` beside this file is what keeps the claim
// true: the day a scenario does carry a branch, that test fails and this derivation
// is what has to change.
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

import { deriveAttentionProjection } from "./fixture-attention-derivation.js";
import { answerFromScriptedReply } from "./fixture-scripted-answer.js";
import { directorySessionsOf } from "./fixture-session-directory.js";
import { createRefusingGrowthPort, growthUnavailable, type GrowthPort } from "./growth-port.js";
import type { ScenarioEngine } from "./scenario-engine.js";

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
  };
  return { ...createRefusingGrowthPort(), ...served };
}
