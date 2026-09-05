// The growth port the fixture bridge actually serves.
//
// ONE RULE DECIDES WHICH, AND THE SET IS DECLARED ONCE. An operation is served when
// a scenario states something it can be answered FROM, and refuses otherwise —
// refuses under both bridges, which is what makes the "not checked" absence a true
// statement rather than a placeholder. The served operations are
// `FIXTURE_SERVED_GROWTH_OPERATION_IDS` below and each entry carries its own reason
// beside it; this header used to enumerate and count them here as well, which is one
// closed set with two homes and goes stale in the direction nothing catches. The
// sweep in `fixture-growth-port.test.ts` calls every registered operation and holds
// each answer to that tuple, so the set and what the port does cannot disagree.
//
// WHAT THIS MODULE OWNS, AND WHAT ITS NEIGHBOURS DO
//
// This one owns the decision: which operations are served, and with which outcome.
// The four answers with a job of their own live beside it, because each fails in a
// way this one cannot — `fixture-session-snapshot.ts` derives the base state one
// session opens with, `fixture-session-directory.ts` derives what the node HAS,
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
// WHAT THE BASE STATE HONESTLY IS — and why it is not derived here. Cursor zero,
// the session's roster, and the memberships that roster holds, all of it
// `fixture-session-snapshot.ts`'s, whose header carries the reasoning for each.
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
//   • `ConsoleScenario` carries no repo mount, no workspace, and no branch. What it
//     does carry is a session, its roster, beats, replies, and a start instant.
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
// AND WHY ITS SIBLING ON THE SAME SLATE ROW REFUSES
//
// `gitflowPrPrepare` is registered in the signature table and is not in the served
// set, which reads as an omission and is the rule above applied twice over. A
// PREPARATION is not an absence a surface has to draw: a proposal was either assembled
// or it was not, so there is no "we asked and there is none" state here for the served
// arm to answer with, and the port would have to mint a `prPreparationId` and a
// `proposalBlob` out of nothing. Nor could a caller reach it: the request is keyed on a
// `branchContextId`, and the read next door answers the absence for every scenario, so
// under this bridge there is no id to send. `Spec-011 §Required Behavior` puts the
// review before any remote mutation, which is the last of it — a fixture that answered
// would be standing in for the review rather than for the wire.
//
// The finder pins that too, from the same side it pins the branch premise: no scenario
// states a prepared proposal, and the day one does, the case beside it fails.
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
// AND THE ANSWER IS RESOLVABLE, WHICH IT WAS NOT. Being in the roster made the
// identity well-formed and left it unusable: the base state carried no entities and
// the composition root registers no `membership.*` projector, so `membershipRoleOf`
// found nothing for the viewer under any scenario and every owner- and
// collaborator-gated control rendered closed against a store that had never held a
// participant — which looks, on screen, exactly like a member with no elevated role.
// The roster now arrives with the base state (`fixture-session-snapshot.ts`), so the
// identity this read serves resolves to the role the scenario declares for it.
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
//
// WHY THE FOUR `approval.*` OPERATIONS ARE SERVED, AND THE TWO GOAL ONES ARE NOT
//
// The approvals scenario scripts all four calls — two reads with the rows a person
// answers, and the two mutations with the replies the wire would send — so the rule
// is met by the same evidence the gitflow read is measured against, and the pane can
// be built against a projection it actually renders rather than against a refusal.
// The narrowing is this port's, not the pane's: the scripted reply is `unknown` and
// the corpus registers no shape for these methods, so `assertScriptedReplyOnContract`
// on the call arm has nothing to check and would pass anything through. What binds
// the script here is the console's OWN reading in `approvals/approval-records.ts` —
// the one parser both this fixture and the eventual `callDaemon` seam narrow with, so
// a scenario cannot teach the pane a row shape the surface will not accept later.
//
// A scenario that scripts none of them refuses rather than serving an empty
// projection, which is the `callerParticipantRead` disposition and not the branch
// read's: an empty approvals list is a claim that nothing is waiting on a decision,
// and a scenario that models no approvals has not made it.
//
// The two session-goal operations are on neither list and refuse under both bridges.
// No scenario carries a goal — no `session.goal_updated` beat, no scripted reply, and
// `ConsoleScenario` has no field for one — so there is nothing to answer from, and a
// mutation the fixture pretended to accept would leave the card waiting for a
// projection event the log will never grow. The refusal names Plan-016, which is the
// true state of that wire.

import {
  readApprovalProjection,
  readRememberedRuleList,
  type ParsedRows,
} from "./approvals/approval-records.js";
import { deriveAttentionProjection } from "./fixture-attention-derivation.js";
import { answerFromScriptedReply } from "./fixture-scripted-answer.js";
import { directorySessionsOf } from "./fixture-session-directory.js";
import { fixtureSessionSnapshot } from "./fixture-session-snapshot.js";
import { mapGrowthServed, type GrowthOutcome } from "./growth-outcome.js";
import {
  createRefusingGrowthPort,
  growthUnavailable,
  growthUnscriptedReply,
  type GrowthPort,
} from "./growth-port.js";
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
  // The two the console cannot function without — a store admits nothing until a read
  // gives it a base state, and without the directory the only sessions a surface can
  // name are the ones this window happens to have open.
  "sessionRead",
  "sessionList",
  // The one projection the console must not compute for itself.
  "attentionProjectionRead",
  // gitflow — the branch-context read, whose whole answer today is that there is none.
  // Its sibling `gitflowPrPrepare` is on the same slate row and refuses, which is the
  // rule above rather than an omission: see the branch-context section of the header.
  "gitflowBranchContextRead",
  // identity — answered from a scenario that states its own viewer, refused from one
  // that does not.
  "callerParticipantRead",
  // approvals — the four calls the approvals scenario scripts, each answered from the
  // script and refused by a scenario that models no approvals. The two session-goal
  // operations are deliberately absent: see the header.
  "approvalProjectionRead",
  "approvalRuleList",
  "approvalResolve",
  "approvalRuleRevoke",
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
      value: fixtureSessionSnapshot(engine.scenario, request.sessionId),
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
    gitflowBranchContextRead: async (request) =>
      // Routed through the scripted-reply seam so a repos scenario that DOES script
      // `gitflow.branchContextRead` is answered from the script, on the frozen clock,
      // with the loading window and the two non-arrival refusals a real read has. No
      // scenario scripts one today, and none can — see the header — so the unscripted
      // arm is the one that runs, and it answers with the absence rather than a
      // refusal: the operation IS answered here and what it found is nothing, whereas
      // a refusal would say the wire is missing, which under this bridge is not what
      // happened.
      //
      // The REQUEST travels with the call because this operation is entity-scoped:
      // it names a workspace and a worktree, and a scenario answering it per worktree
      // reads exactly that. Discarded, every branch-context read in a session was
      // computed about no worktree, so a two-worktree session got one answer twice or
      // none at all.
      answerFromScriptedReply(
        engine,
        "gitflow.branchContextRead",
        "gitflowBranchContextRead",
        request,
        () => ({ status: "served", value: { branchContext: undefined } }),
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
    // approvals
    approvalProjectionRead: async (request) =>
      answerApprovalRead(
        engine,
        "approval.projectionRead",
        "approvalProjectionRead",
        request,
        readApprovalProjection,
      ),
    approvalRuleList: async (request) =>
      answerApprovalRead(
        engine,
        "approval.ruleList",
        "approvalRuleList",
        request,
        readRememberedRuleList,
      ),
    // The two mutations answer with nothing, and that is the wire's own shape rather
    // than a shortcut: what a record BECAME is the next projection read's answer, so
    // a reply carrying a state would invite a card to settle itself. What the script
    // decides here is only WHETHER the call was accepted.
    approvalResolve: async (request) =>
      mapGrowthServed(
        await answerFromScriptedReply(engine, "approval.resolve", "approvalResolve", request, () =>
          growthUnscriptedReply("approvalResolve", "approval.resolve"),
        ),
        () => undefined,
      ),
    approvalRuleRevoke: async (request) =>
      mapGrowthServed(
        await answerFromScriptedReply(
          engine,
          "approval.ruleRevoke",
          "approvalRuleRevoke",
          request,
          () => growthUnscriptedReply("approvalRuleRevoke", "approval.ruleRevoke"),
        ),
        () => undefined,
      ),
  };
  return { ...createRefusingGrowthPort(), ...served };
}

/**
 * Answer one approvals READ from the script, narrowed by the console's own reader.
 *
 * The two reads differ only in which call they consult and which narrowing they
 * apply, so they share this rather than repeating the four-line settle-then-narrow
 * shape twice — and sharing it is what keeps the unscripted disposition the same for
 * both, which is the half a second copy would drift on.
 *
 * The narrowing THROWS for a reply that is not even shaped like the read, and that
 * rejection is left to travel. It is a scenario authoring error of exactly the class
 * `assertScriptedReplyOnContract` raises on the call arm — a script teaching a surface
 * a frame the daemon cannot send — and the caller renders it as a refusal, which is
 * what it would do for the live wire's own rejection too.
 */
async function answerApprovalRead<TRow>(
  engine: ScenarioEngine,
  call: string,
  operationId: "approvalProjectionRead" | "approvalRuleList",
  request: unknown,
  narrow: (reply: unknown) => ParsedRows<TRow>,
): Promise<GrowthOutcome<ParsedRows<TRow>>> {
  return mapGrowthServed(
    await answerFromScriptedReply<unknown>(engine, call, operationId, request, () =>
      growthUnscriptedReply(operationId, call),
    ),
    narrow,
  );
}
