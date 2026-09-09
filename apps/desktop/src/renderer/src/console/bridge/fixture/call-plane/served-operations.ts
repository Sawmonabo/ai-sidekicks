// WHICH growth operations the fixture answers, and why each one.
//
// ONE RULE DECIDES WHICH, AND THE SET IS DECLARED ONCE. An operation is served when
// a scenario states something it can be answered FROM, and refuses otherwise —
// refuses under both bridges, which is what makes the "not checked" absence a true
// statement rather than a placeholder. Each entry below carries its own reason beside
// it, and this header deliberately neither enumerates nor counts them: one closed set
// with two homes goes stale in the direction nothing catches. The sweep in
// `growth/growth-port.test.ts` calls every registered operation and holds each answer
// to that tuple, so the set and what the port does cannot disagree.
//
// A MODULE OF ITS OWN, BESIDE THE PORT THAT IMPLEMENTS IT. The decision and the
// implementation fail differently: a served set that admits an operation no scenario
// can answer is wrong before any code runs, and a port whose answer is composed wrongly
// is wrong at the call. They are also read by different callers —
// `scenario-runtime/scenario-manifest.ts` ledgers the set and `bridge.ts`
// publishes it as the bridge's served set, while the builder in `growth/growth-port.ts`
// is reached only by the fixture bridge itself. What follows is the reasoning for every membership.
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
// in `growth/growth-port.gitflow.test.ts` is what keeps that claim
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
// `findScenariosNaming` in `growth/growth-port.test-support.ts` pins the callback-tool
// premise the way the
// branch finder pins its own, and pins the identity premise from the other side: no
// scenario states a viewer under any name but the one field the port reads.
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
// agent plane's own section in `growth/growth-port.ts` gives the reason: a session
// with no agents attached is what a fresh session IS, so the empty roster is a state
// the agent console and this chip both have to draw rather than a claim no script
// made. The chip reads that answer as knowing nothing about a binding, which is a
// different rendering from its refused arm.
//
// WHY THE TWO LEASE OPERATIONS ARE SERVED, AND WHY THAT IS ABOUT REFUSALS
//
// The terminal's write lease is the one surface in the console whose interesting
// states are all REFUSALS. `pty.permission_denied` before any lease comparison,
// `pty.control_held_by_other` carrying the holder, `pty.control_not_held` on a release
// by a non-holder — every one of them is the rejection of a CALL, and while these two
// operations were outside the served set no scenario could reach any of them: the
// refusing port answered `unavailable` by name and no script was ever consulted. So
// the surfaces that render them — the inline refusal, and the holder line beside it —
// were reachable from no scenario, no screenshot, and no bridge-driven test.
//
// AND THE SERVED ARM IS WHY THEY ARE WRITES RATHER THAN READS. Taking the shell moves
// it; a fixture that answered a take nobody scripted would be reporting a transition
// the scenario's own beats never made, and the pane's fold reads the holder off
// `pty.control_changed` and never off this reply. So both sit in the script-only
// subset below and refuse by name under a scenario that scripts neither, which is the
// `agentAttach` disposition and for the same reason.
//
// WHY THE BROWSER PROVENANCE READ IS THE ONE SERVED OPERATION IN ITS NAMESPACE.
// Every other operation in the browser namespace ACTS on a live view — navigate,
// select, capture, clear the partition — and a fixture that answered one would be
// reporting that a page this bridge does not host had moved. This one asks a
// question ABOUT THE SESSION'S OWN LOG: which of the artifacts the scenario already
// publishes came out of the browser. That is a fact a scenario can state, and while
// it could not, the produced-object shelf had exactly one source for it — the cards
// this window's own capture control minted — so a scenario's agent captures, its
// completed download, and its bundled asset set were folded out of the shelf and it
// reported that nothing had been produced.
//
// AND THE UNSCRIPTED ARM IS THE EMPTY SET rather than a refusal, on the invite
// ledger's rule: a session whose browser has produced nothing is an ordinary session
// and the shelf draws it, whereas a refusal here would claim the question was never
// asked. A scenario that publishes artifacts and names none of them as browser
// output is saying they came from somewhere else, which is the answer this serves.
// WHY THE WORKSPACE EXECUTION-CONTEXT READ IS SERVED, AND ONLY FROM A SCRIPT
//
// It is served so the repos scenario can drive the workspace card's three-path
// disclosure and its fallback badge, neither of which any registered reply can reach:
// the normalized checkout root is a column on a daemon table and the fallback marker is
// no field at all, so under a refusing port both were unreachable in every scenario,
// screenshot, and bridge-driven test.
//
// AND IT IS SCRIPT-ONLY, which is the `workflowRunRead` disposition and not the invite
// ledger's. This read is ADDRESSED BY A SUBJECT — it answers facts about one named
// workspace — so an empty form would assert that the workspace exists and is bound to
// no root at all, which for a workspace no author declared is an invention rather than
// an absence. A scenario that scripts nothing for a workspace therefore gets the
// unscripted refusal, and the disclosure draws the "not checked" it is owed.
//
// The two session-goal operations are on neither list and refuse under both bridges.
// No scenario carries a goal — no `session.goal_updated` beat, no scripted reply, and
// `ConsoleScenario` has no field for one — so there is nothing to answer from, and a
// mutation the fixture pretended to accept would leave the card waiting for a
// projection event the log will never grow. The refusal names Plan-016, which is the
// true state of that wire.

// AND EVERY PLANE WITH A MODULE STATES ITS OWN MEMBERSHIP, in the module that
// implements it — read the import list below for the residents rather than a count
// written here, which is a closed set with two homes and goes stale the next time a
// plane leaves this file. The rule `workflows/workflow-reads.ts` set governs each: a
// plane that owns its handlers owns the reasoning that admits them, so the ids and the
// argument for them stay one unit — reasoning left here would go stale the first time a
// plane changed what it answers, and nothing would report it. What remains in this
// header is the reasoning for the ids declared HERE, which are the planes this
// directory holds no answer module for.

import { FIXTURE_SERVED_APPROVAL_OPERATION_IDS } from "../growth/approval-answers.js";
import { FIXTURE_SERVED_COLLABORATION_OPERATION_IDS } from "../collaboration/collaboration-reads.js";
import { FIXTURE_SERVED_SESSION_OPERATION_IDS } from "../collaboration/session-answers.js";
import { FIXTURE_SERVED_DIAGNOSTICS_OPERATION_IDS } from "../settings/diagnostics-reads.js";
import { FIXTURE_SERVED_INVITE_OPERATION_IDS } from "../invites/invite-answers.js";
import { FIXTURE_SERVED_MCP_OPERATION_IDS } from "../settings/mcp-governance.js";
import { FIXTURE_SERVED_ONBOARDING_OPERATION_IDS } from "../settings/onboarding-answers.js";
import { FIXTURE_SERVED_PRESENCE_OPERATION_IDS } from "../shell/presence-answers.js";
import { FIXTURE_SERVED_PROVIDER_ACCOUNT_OPERATION_IDS } from "../settings/provider-account-writes.js";
import { FIXTURE_SERVED_SHELL_OPERATION_IDS } from "../shell/shell-answers.js";
import { FIXTURE_SERVED_WORKFLOW_OPERATION_IDS } from "../workflows/workflow-reads.js";

/**
 * The operations the fixture answers rather than refuses.
 *
 * A tuple, so the served set is declared once: `scenario-manifest.ts` ledgers it,
 * `bridge.ts` publishes it as the bridge's served set, and the `Pick` the
 * port builds against makes a member with no implementation — or an implementation
 * with no member — a compile error rather than a runtime surprise.
 *
 * Written as an annotated tuple rather than `as const`, on the
 * `GROWTH_PORT_REFUSAL_CODES` precedent: `isolatedDeclarations` cannot infer an array
 * carrying a spread, so each plane that owns its own module reaches the annotation as
 * `...typeof FIXTURE_SERVED_WORKFLOW_OPERATION_IDS` and its siblings. Each is named in
 * one place and spread in the other, and the compiler holds the two to each other.
 */
export const FIXTURE_SERVED_GROWTH_OPERATION_IDS: readonly [
  ...typeof FIXTURE_SERVED_SESSION_OPERATION_IDS,
  "attentionProjectionRead",
  ...typeof FIXTURE_SERVED_WORKFLOW_OPERATION_IDS,
  "gitflowBranchContextRead",
  "gitflowDiffArtifactCreate",
  "artifactRead",
  ...typeof FIXTURE_SERVED_APPROVAL_OPERATION_IDS,
  "agentList",
  "agentAttach",
  "agentConfigUpdate",
  "agentDetach",
  "orchestrationChildRunLinkRead",
  "sidekickDefinitionList",
  "sidekickPeerInvocationSet",
  "browserProducedArtifacts",
  "terminalAcquireWriteLease",
  "terminalReleaseWriteLease",
  "workspaceExecutionContextRead",
  ...typeof FIXTURE_SERVED_COLLABORATION_OPERATION_IDS,
  ...typeof FIXTURE_SERVED_INVITE_OPERATION_IDS,
  ...typeof FIXTURE_SERVED_PRESENCE_OPERATION_IDS,
  "providerSessionImportBegin",
  "providerSessionImportSubscribe",
  ...typeof FIXTURE_SERVED_SHELL_OPERATION_IDS,
  ...typeof FIXTURE_SERVED_ONBOARDING_OPERATION_IDS,
  ...typeof FIXTURE_SERVED_DIAGNOSTICS_OPERATION_IDS,
  ...typeof FIXTURE_SERVED_PROVIDER_ACCOUNT_OPERATION_IDS,
  ...typeof FIXTURE_SERVED_MCP_OPERATION_IDS,
] = [
  // sessions — the two the console cannot function without and the viewer that resolves
  // a role against them, taken from the module that implements them so the ids and the
  // handlers cannot disagree. `collaboration/session-answers.ts` carries the reasoning.
  ...FIXTURE_SERVED_SESSION_OPERATION_IDS,
  // The one projection the console must not compute for itself.
  "attentionProjectionRead",
  // workflow — the reads a workflows scenario scripts, taken from the module that
  // implements them so the ids and the handlers cannot disagree. The six operations
  // they leave out are five mutations and the gate-chain verification;
  // `workflows/workflow-reads.ts` carries the whole of that reasoning.
  ...FIXTURE_SERVED_WORKFLOW_OPERATION_IDS,
  // gitflow — the branch-context read, answered from a scenario that scripts one and
  // refused for one that does not. Its sibling `gitflowPrPrepare` is on the same slate
  // row and refuses under every scenario, which is the rule above rather than an
  // omission: see the branch-context section of the header.
  "gitflowBranchContextRead",
  // gitflow — the diff-artifact mint, and the artifact read its reply is only useful
  // through. Both are script-only below: a create answers with ids for a change set the
  // daemon computed, and a read answers with ONE named artifact's envelope and bytes, so
  // neither has an empty form that would be true of a scenario saying nothing. They are
  // served as a PAIR because a diff costs two calls — the mint carries no payload — so
  // serving either alone leaves the pane with an id it cannot read or bytes nothing
  // minted.
  "gitflowDiffArtifactCreate",
  "artifactRead",
  // approvals — the four calls the approvals scenario scripts, taken from the module
  // that implements them so the ids and the handlers cannot disagree. The two
  // session-goal operations are deliberately absent: see the header.
  ...FIXTURE_SERVED_APPROVAL_OPERATION_IDS,
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
  // browser — the one read in that namespace a scenario can answer, and the shelf's
  // only source of provenance. See the browser section of the header.
  "browserProducedArtifacts",
  // terminal lease — the two calls whose interesting answers are all refusals, served
  // so a scenario can script one. See the lease section of the header.
  "terminalAcquireWriteLease",
  "terminalReleaseWriteLease",
  // repos — the workspace's own execution context, answered from a scenario that
  // scripts one and refused for one that does not. See the header.
  "workspaceExecutionContextRead",
  // channels and memberships — the four lifecycle verbs, the channel roster read, the
  // membership roster read, and one participant's per-device presence, taken from the
  // module that implements them so the ids and the handlers cannot disagree. Every one
  // is script-only, and `collaboration/collaboration-reads.ts` carries the reasoning for each.
  ...FIXTURE_SERVED_COLLABORATION_OPERATION_IDS,
  // invite — the sent-invite ledger read and the whole pending lifecycle, so the
  // confirmation's six outcome arms are each reachable from a scenario rather than only
  // from a unit case. Taken from the module that implements them, which carries the
  // reasoning for each.
  ...FIXTURE_SERVED_INVITE_OPERATION_IDS,
  // presence — the activity read and the node's own control-plane host, from the same
  // kind of module. The composer's two writes are deliberately absent, and
  // `shell/presence-answers.ts` says why.
  ...FIXTURE_SERVED_PRESENCE_OPERATION_IDS,
  // provider-session import — the opening call and the progress subscription it
  // mints a subject for, both answered from a scenario that scripts the import and
  // refused by one that does not.
  "providerSessionImportBegin",
  "providerSessionImportSubscribe",
  // shell — the whole six-operation plane, taken from the module that implements it so
  // the ids and the handlers cannot disagree. Whether this machine will display an OS
  // notification comes from a scenario that says so and is refused by one that does
  // not. The shell's own condition is the first FEED this fixture serves, answered
  // from the frames a scenario declares against the frozen clock: it is script-only
  // for the reason the write operations are, since there is no such thing as "the
  // shell reported and said nothing", and a served stream that never yielded would
  // read on screen exactly like a shell that has not reported — one of which is a
  // scripting gap and the other the console's ordinary state. The three daemon
  // controls and the status read answer from the same channel the feed is answered
  // from, so a stop moves what the feed says rather than resolving into a shell
  // nothing reports, and all four refuse under a scenario that scripts no shell
  // condition for the same reason the feed does.
  ...FIXTURE_SERVED_SHELL_OPERATION_IDS,
  // onboarding — the whole six-operation surface, taken from the module that
  // implements it so the ids and the handlers cannot disagree. The split between them
  // is this module's own rule rather than a preference. The state read has an honest
  // answer for a scenario that scripts nothing: a node nobody has onboarded has no
  // completed steps and is not complete, which is a real state the walkthrough draws
  // and the state a fresh install is genuinely in. The other five are WRITES or
  // main-process dialogs — there is no such thing as "the step that was recorded and
  // recorded nothing", and a synthesized relay choice would tell the walkthrough a
  // person answered a question nobody was asked — so each of them refuses by name
  // under a scenario that does not script it.
  ...FIXTURE_SERVED_ONBOARDING_OPERATION_IDS,
  // diagnostics — the five reads the settings page is built from, taken from the module
  // that implements them so the ids and the handlers cannot disagree. Two answer under
  // any scenario and three are script-only; that module states which and why.
  ...FIXTURE_SERVED_DIAGNOSTICS_OPERATION_IDS,
  // provider accounts — the three verbs the bound registry read and its live tail do
  // not cover, from the same kind of module. All three are script-only.
  ...FIXTURE_SERVED_PROVIDER_ACCOUNT_OPERATION_IDS,
  // MCP governance — the inventory read answers the empty inventory under any scenario
  // and the two mutations refuse without a script, and the three are one plane rather
  // than three reply rows because the module holds the ledger that joins them.
  ...FIXTURE_SERVED_MCP_OPERATION_IDS,
];

/** One operation the fixture serves. Derived, so the set has exactly one home. */
export type FixtureServedGrowthOperationId = (typeof FIXTURE_SERVED_GROWTH_OPERATION_IDS)[number];
