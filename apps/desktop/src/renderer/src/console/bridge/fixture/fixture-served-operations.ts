// WHICH growth operations the fixture answers, and why each one.
//
// ONE RULE DECIDES WHICH, AND THE SET IS DECLARED ONCE. An operation is served when
// a scenario states something it can be answered FROM, and refuses otherwise —
// refuses under both bridges, which is what makes the "not checked" absence a true
// statement rather than a placeholder. Each entry below carries its own reason beside
// it, and this header deliberately neither enumerates nor counts them: one closed set
// with two homes goes stale in the direction nothing catches. The sweep in
// `fixture-growth-port.test.ts` calls every registered operation and holds each answer
// to that tuple, so the set and what the port does cannot disagree.
//
// A MODULE OF ITS OWN, BESIDE THE PORT THAT IMPLEMENTS IT. The decision and the
// implementation fail differently: a served set that admits an operation no scenario
// can answer is wrong before any code runs, and a port whose answer is composed wrongly
// is wrong at the call. They are also read by different callers —
// `scenario-runtime/scenario-manifest.ts` ledgers the set and `fixture-bridge.ts`
// publishes it as the bridge's served set, while the builder next door is reached only
// by the fixture bridge itself. What follows is the reasoning for every membership.
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
// WHY THE BRANCH-CONTEXT READ IS SERVED FROM THE SCRIPT AND REFUSES WITHOUT ONE
//
// It is served so a scenario that states a branch context can drive the repos
// surface's prepared arm, which under a refusing port was unreachable — the summary
// could only ever be built against the "nobody asked" half of its own empty states.
//
// AND IT REFUSES FOR A SCENARIO THAT SCRIPTS NOTHING, which is a change from the
// served absence this port used to answer with. The registered
// `BranchContextReadResponse` is FLAT: it returns the context's fields directly and
// has no member on which "there is none" could ride, because a `(workspace, worktree)`
// pair resolving no row is a REFUSAL on that wire rather than an empty reply. So a
// served absence here would be a shape no daemon can send, which is the one thing a
// fixture must not script. The refusal is the same "not checked" the live bridge
// takes, which is the honest reading of a script that has not said — the
// `callerParticipantRead` posture below, for the same reason.
//
// The corpus premise behind that: two things would have to be true for a scenario to
// derive a branch context from its beats rather than script one, and neither is:
//
//   • `ConsoleScenario` carries no repo mount, no workspace, and no branch. What it
//     does carry is a session, its roster, beats, replies, and a start instant.
//   • No registered event payload names a branch. The `repo.*` / `workspace.*` /
//     `worktree.*` family payload is `{sessionId, repoMountId?, workspaceId?,
//     worktreeId?, state, actor?}` (`packages/contracts/src/repo.ts`), so a fold
//     over beats could reach a workspace and a worktree and would still have to
//     invent both branch names — and `BranchContextReadResponse` requires them.
//
// So a scenario says it in a reply or it does not say it, and `findScenariosNaming`
// in `fixture-growth-port.gitflow.test.ts` beside this file is what keeps that claim
// true: it names every scenario that states a branch, and the day the set changes
// that case fails and this derivation is what has to change.
//
// AND WHY ITS SIBLING ON THE SAME SLATE ROW REFUSES
//
// `gitflowPrPrepare` is registered in the signature table and is not in the served
// set, which reads as an omission and is the rule above applied twice over. A
// PREPARATION is not an absence a surface has to draw: a proposal was either assembled
// or it was not, so there is no "we asked and there is none" state here for the served
// arm to answer with, and the port would have to mint a `prPreparationId` and a
// `proposalBlob` out of nothing. `Spec-011 §Required Behavior` puts the
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
// WHY THE AGENT ROSTER READ IS SERVED
//
// Four shipped scenarios script `agent.list` and no caller could reach any of them
// while the operation refused: the composer's target chip took its refused arm on
// EVERY provider-bound composer — including the two reference surfaces built on a
// real fixture bridge — and the paying account, the pending switch, and the
// account-plane label join were unreachable through any scenario, screenshot, or
// bridge-driven test. A surface whose only reachable state is its refusal is a
// surface nothing has drawn.
//
// ITS UNSCRIPTED ARM IS THE INVITE LEDGER'S AND NOT THE APPROVALS READS', and the
// agent plane's own section in `fixture-growth-port.ts` gives the reason: a session
// with no agents attached is what a fresh session IS, so the empty roster is a state
// the agent console and this chip both have to draw rather than a claim no script
// made. The chip reads that answer as knowing nothing about a binding, which is a
// different rendering from its refused arm.
//
// The two session-goal operations are on neither list and refuse under both bridges.
// No scenario carries a goal — no `session.goal_updated` beat, no scripted reply, and
// `ConsoleScenario` has no field for one — so there is nothing to answer from, and a
// mutation the fixture pretended to accept would leave the card waiting for a
// projection event the log will never grow. The refusal names Plan-016, which is the
// true state of that wire.

// WHY THE ACTIVITY READ IS SERVED, AND WHY THE COMPOSER'S TWO WRITES ARE NOT
//
// The read is served so a scenario that states who is composing where can drive the
// indicators at all: every one of them rendered permanently empty while the operation
// refused, which is a surface whose only reachable state is its absence. Its
// unscripted arm REFUSES rather than serving two empty lists, on the runtime-node
// roster's rule — a scenario that has not said has left the question unasked, and
// "nobody is composing" is a claim about the room that nothing checked.
//
// The composer's `presenceComposingSet` / `presenceComposingClear` are writes with no
// empty state and no receipt, and there is a second reason beside that one: what a
// publish PRODUCES is somebody else's reading, so the fixture serving them would have
// to write into the very snapshot the read above answers from — a fixture publishing
// to itself, which would show this window its own indicator, something no real
// Awareness client ever does. They refuse, and the emitter's own fail-closed rule
// (it stops after a refusal) is exercised by that refusal rather than around it.
//
// WHY THE PENDING-INVITE NAMESPACE IS SERVED IN FULL
//
// All five, because the surface is a lifecycle rather than a read: a confirmation
// that could be shown but never confirmed, or confirmed but never answered, leaves
// three of its four outcome arms unreachable from any scenario, screenshot, or
// bridge-driven test. `fixture-pending-invites.ts` holds the whole of it and states
// why the reference is spent where it is.
//
// WHY THE CONTROL-PLANE HOST READ IS SERVED FROM THE SCENARIO AND FROM NOWHERE ELSE
//
// A minted invitation is only sendable as a link, and the link is composed from this
// host — so leaving the read refusing left the one-time reveal permanently unable to
// show what a person would actually paste, which is the whole act. It is served from
// a scenario member the author writes down, exactly as the caller-identity read is,
// and refused by a scenario that names none. What it may never do is INVENT one: a
// plausible hostname nobody declared would put a copyable link in front of a person
// that opens nothing, and that is worse than the sentence saying the host has not
// been read. A scenario declaring one is not that — it is a fixture stating a fact
// about the node it stands for, like every other fact in it.

import { FIXTURE_SERVED_WORKFLOW_OPERATION_IDS } from "./fixture-workflow-reads.js";

/**
 * The operations the fixture answers rather than refuses.
 *
 * A tuple, so the served set is declared once: `scenario-manifest.ts` ledgers it,
 * `fixture-bridge.ts` publishes it as the bridge's served set, and the `Pick` the
 * port builds against makes a member with no implementation — or an implementation
 * with no member — a compile error rather than a runtime surprise.
 *
 * Written as an annotated tuple rather than `as const`, on the
 * `GROWTH_PORT_REFUSAL_CODES` precedent: `isolatedDeclarations` cannot infer an array
 * carrying a spread, so the workflow ids reach the annotation as
 * `...typeof FIXTURE_SERVED_WORKFLOW_OPERATION_IDS`. They are named in one place and
 * spread in the other, and the compiler holds the two to each other.
 */
export const FIXTURE_SERVED_GROWTH_OPERATION_IDS: readonly [
  "sessionRead",
  "sessionList",
  "attentionProjectionRead",
  ...typeof FIXTURE_SERVED_WORKFLOW_OPERATION_IDS,
  "gitflowBranchContextRead",
  "callerParticipantRead",
  "approvalProjectionRead",
  "approvalRuleList",
  "approvalResolve",
  "approvalRuleRevoke",
  "invitesList",
  "agentList",
  "agentAttach",
  "agentConfigUpdate",
  "agentDetach",
  "orchestrationChildRunLinkRead",
  "sidekickDefinitionList",
  "sidekickPeerInvocationSet",
  "presenceActivityRead",
  "invitePendingSubscribe",
  "inviteOutcomeSubscribe",
  "inviteConfirmPending",
  "inviteRetryPending",
  "inviteDismissPending",
  "controlPlaneHostRead",
] = [
  // The two the console cannot function without — a store admits nothing until a read
  // gives it a base state, and without the directory the only sessions a surface can
  // name are the ones this window happens to have open.
  "sessionRead",
  "sessionList",
  // The one projection the console must not compute for itself.
  "attentionProjectionRead",
  // workflow — the reads a workflows scenario scripts, taken from the module that
  // implements them so the ids and the handlers cannot disagree. The six operations
  // they leave out are five mutations and the gate-chain verification;
  // `fixture-workflow-reads.ts` carries the whole of that reasoning.
  ...FIXTURE_SERVED_WORKFLOW_OPERATION_IDS,
  // gitflow — the branch-context read, answered from a scenario that scripts one and
  // refused for one that does not. Its sibling `gitflowPrPrepare` is on the same slate
  // row and refuses under every scenario, which is the rule above rather than an
  // omission: see the branch-context section of the header.
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
  // invites
  "invitesList",
  // agent plane — five operations that were `daemon.call` strings until the call door
  // closed. The scenarios that answer them are unchanged: each routes through the
  // scripted-reply seam under its own wire method, so a scenario's `agent.list` entry
  // answers `agentList` exactly as it answered the cast before.
  "agentList",
  "agentAttach",
  "agentConfigUpdate",
  "agentDetach",
  "orchestrationChildRunLinkRead",
  // sidekick — the definition picker's read, from the same script.
  "sidekickDefinitionList",
  "sidekickPeerInvocationSet",
  // presence — the activity read, answered from a scenario that states its own
  // activity frames and refused from one that does not. The composer's two writes
  // are deliberately absent: see the header.
  "presenceActivityRead",
  // invite — the whole pending-invite lifecycle, so the confirmation's four outcome
  // arms are each reachable from a scenario rather than only from a unit case.
  "invitePendingSubscribe",
  "inviteOutcomeSubscribe",
  "inviteConfirmPending",
  "inviteRetryPending",
  "inviteDismissPending",
  // The node's own control-plane host, so a minted invitation can be revealed as the
  // link it will be sent as. Answered from a scenario that names one; refused by a
  // scenario that does not, which is the state a console that has not been told its
  // own control plane is in.
  "controlPlaneHostRead",
];

/** One operation the fixture serves. Derived, so the set has exactly one home. */
export type FixtureServedGrowthOperationId = (typeof FIXTURE_SERVED_GROWTH_OPERATION_IDS)[number];

/**
 * Which of those the port implements but can only answer FROM A SCRIPT.
 *
 * Every other served operation has an honest answer for a scenario that scripts
 * nothing — an empty ledger, an empty roster, a workspace with no branch context —
 * and answers `served` under any scenario at all. Two classes have no such answer.
 * A WRITE: there is no such thing as "the attach that happened and produced nothing",
 * and serving a synthesized receipt would tell a surface the daemon did something no
 * author said it did. And a READ ADDRESSED BY A SUBJECT: a run's snapshot, a finished
 * phase's outputs, a definition's version chain — each answers with facts ABOUT a
 * named thing, so an empty form would assert that the thing exists and holds nothing,
 * which for a run no author declared is the same invention as a receipt. The
 * enumerations beside them stay out of this set: a list of none is a real answer to
 * "what does this session hold". So these are implemented, and refuse by name under a
 * scenario that does not script them.
 *
 * A declared subset rather than a rule the sweep re-derives, because the sweep cannot
 * see the difference: both arms answer through the same port method, and what
 * separates them is whether an empty answer would be a lie.
 */
export const FIXTURE_SCRIPT_ONLY_GROWTH_OPERATION_IDS: readonly FixtureServedGrowthOperationId[] = [
  "agentAttach",
  "agentConfigUpdate",
  "agentDetach",
  "sidekickPeerInvocationSet",
  "workflowRunRead",
  "workflowPhaseOutputRead",
  "workflowVersionChainRead",
  // The three acts on a pending invitation. Each addresses a reference the scenario
  // minted, so a scenario that scripted no invitation has no reference for any of
  // them to name — and serving a receipt for one would tell the confirmation that
  // main accepted an invitation no author ever wrote down.
  "inviteConfirmPending",
  "inviteRetryPending",
  "inviteDismissPending",
  // Neither has an honest empty answer. "Nobody is composing anywhere" is a claim
  // about the room that nothing checked, and there is no empty host — a node either
  // answers on one or this fixture has not been told which.
  "presenceActivityRead",
  "controlPlaneHostRead",
];
