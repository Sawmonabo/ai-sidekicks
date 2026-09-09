// The growth port the fixture bridge actually serves.
//
// ONE RULE DECIDES WHICH OPERATIONS IT ANSWERS, and that rule and its whole membership
// list live in `call-plane/served-operations.ts`. What is HERE is how each
// served operation composes its answer.
//
// WHAT THIS MODULE OWNS, AND WHAT ITS NEIGHBOURS DO
//
// This one owns the outcome each served operation answers with. The answers with a job
// of their own live beside it, because each fails in a way this one cannot —
// `collaboration/session-answers.ts` holds the base-state read, the node's directory and
// the viewer, over `collaboration/session-snapshot.ts`, which derives the base state one
// session opens with, and `collaboration/session-directory.ts`, which derives what the
// node HAS, `approval-answers.ts` the two approvals reads and the two acts,
// `invites/invite-answers.ts` the sent-invite ledger read and the pending lifecycle,
// `shell/presence-answers.ts` the activity read and the node's control-plane host,
// `collaboration/session-identity.ts` the header's own identity read,
// `shell/auxiliary-windows.ts` models the shell's own window plane,
// `attention-derivation.ts` folds beats into an attention projection,
// `workflows/workflow-scope.ts` derives which workflow subjects a script can answer for,
// `workflows/workflow-reads.ts` holds the workflow answers and the reasoning that governs
// them, `collaboration/collaboration-reads.ts` the channel and membership answers,
// `settings/diagnostics-reads.ts` the five the settings page's diagnostics regions
// are built on, `settings/provider-account-writes.ts` the three verbs of the sign-in
// handoff, `settings/mcp-governance.ts` the inventory read and the two mutations that
// move a row in it, `settings/onboarding-answers.ts` the onboarding plane and the ledger
// its own mutations move, `shell/shell-answers.ts` the shell plane and the one channel
// its feed and its three controls share, and `scripted-answer.ts` maps a scripted
// settlement onto an outcome — reads and writes both, including the script-only
// disposition those planes and this port all take.
//
// A PLANE LEAVES WITH ITS SERVED IDS. Each of those modules declares the operation ids
// it implements and this port spreads both the ids and the handlers, so a plane's set
// and its answers cannot disagree — `workflows/workflow-reads.ts` states the rule in full.
//

import { fixtureApprovalAnswers } from "./approval-answers.js";
import { FixtureAttachmentIngest, fixtureAttachmentIngest } from "./attachment-ingest.js";
import { BROWSER_PRODUCED_ARTIFACTS_CALL } from "../../scenarios/browser.js";
import { deriveAttentionProjection } from "./attention-derivation.js";
import type { FixtureInviteLedger } from "../invites/invite-ledger.js";
import { fixtureInviteAnswers } from "../invites/invite-answers.js";
import { fixtureDiagnosticsReads } from "../settings/diagnostics-reads.js";
import { paceGrowthStreamOnScenarioClock } from "./due-frames.js";
import { fixtureMcpGovernance } from "../settings/mcp-governance.js";
import { fixtureCollaborationReads } from "../collaboration/collaboration-reads.js";
import type { FixtureChannelLifecycle } from "../collaboration/channel-lifecycle.js";
import { fixtureOnboardingAnswers } from "../settings/onboarding-answers.js";
import { fixtureProviderAccountWrites } from "../settings/provider-account-writes.js";
import { fixtureRunRecordReads } from "./run-record-reads.js";
import { answerFromScriptedReply, answerScriptOnly } from "./scripted-answer.js";
import { fixtureShellAnswers } from "../shell/shell-answers.js";
import { fixturePresenceAnswers } from "../shell/presence-answers.js";
import { fixtureSessionAnswers } from "../collaboration/session-answers.js";
import { scenarioSessionIdentity } from "../collaboration/session-identity.js";
import {
  createRefusingGrowthPort,
  growthUnavailable,
  growthUnscriptedReply,
  mapGrowthServed,
  type GrowthPort,
} from "../../growth-port/index.js";
import { DAEMON_NEGOTIATION_READ_CALL } from "../../scenarios/negotiation-replies.js";
import type { FixtureServedGrowthOperationId } from "../call-plane/served-operations.js";
import { fixtureWorkflowReads } from "../workflows/workflow-reads.js";
import {
  PROVIDER_SESSION_IMPORT_BEGIN_CALL,
  PROVIDER_SESSION_IMPORT_PROGRESS_FRAMES,
  PROVIDER_SESSION_IMPORT_SUBSCRIBE_CALL,
} from "../../scenarios/bring-your-history.js";
// The routing keys themselves, from the scenario modules that mint them — the
// workflow enumeration's rule one file over: restated as literals here, a rename would
// move the constant and the reply and leave a handler answering a key nothing sends.
import {
  REPOS_ARTIFACT_READ_CALL,
  REPOS_DIFF_ARTIFACT_CREATE_CALL,
} from "../../scenarios/repos/repos-diff-replies.js";
import { REPOS_EXECUTION_CONTEXT_CALL } from "../../scenarios/repos/repos-mutation-replies.js";
import type { ScenarioEngine } from "../../scenario-runtime/index.js";

/**
 * Build the fixture's growth port for one running scenario.
 *
 * Starts from the refusing port so an operation added to the ledger and not to the
 * served set refuses by name instead of being absent — the port's shape is checked
 * against `GROWTH_OPERATIONS` by `failure-modes.test.ts`, and a spread that dropped
 * a method would fail that check rather than silently render `undefined is not a
 * function` in a surface.
 *
 * The CHANNEL LIFECYCLE arrives from the caller because two doors read it — these acts
 * and the `channel.list` fold — and `call-plane/bridge.ts` states why one serves both.
 */
export function createFixtureGrowthPort(
  engine: ScenarioEngine,
  channelLifecycle: FixtureChannelLifecycle,
  inviteLedger: FixtureInviteLedger,
): GrowthPort {
  // The ingest spools, held for this port's life on the reason
  // `invites/invite-answers.ts` states for its pending table: the three legs of one
  // upload are three calls over one accumulating record, so a handler that minted its
  // state per call could acknowledge no chunk and complete no stream.
  const attachmentSpools = new FixtureAttachmentIngest();
  const served: Pick<GrowthPort, FixtureServedGrowthOperationId> = {
    // workflow, collaboration, onboarding and shell — spread from the modules that
    // implement them, so the served ids in `call-plane/served-operations.ts` and the
    // handlers there are held to
    // each other by the `Pick` above. The onboarding and shell planes own the per-caller
    // state, which is why each is a module and not a block here: the onboarding ledger
    // and the shell channel are both minted per port inside those calls, so a step
    // recorded — or a control pressed — in this window reaches no other.
    ...fixtureWorkflowReads(engine),
    // Every channel and membership answer is script-only: the reasoning for each
    // refusal lives in that module.
    ...fixtureCollaborationReads(engine, channelLifecycle),
    ...fixtureOnboardingAnswers(engine),
    ...fixtureShellAnswers(engine),
    // sessions, approvals, invites and presence — the same shape: each plane declares
    // its own served ids beside the answers it composes, and the pending-invite table
    // is minted inside its own module for the reason the shell channel is.
    ...fixtureSessionAnswers(engine),
    ...fixtureApprovalAnswers(engine),
    ...fixtureInviteAnswers(engine, inviteLedger),
    ...fixturePresenceAnswers(engine),
    // The attachment ingest trio and its abort. Answered from the spool rather than
    // from the script, which is what makes every ingest state a surface renders
    // reachable by attaching a file instead of by authoring a reply.
    ...fixtureAttachmentIngest(attachmentSpools),
    // The header's identity, from the same scripted reply the base state comes from.
    // REFUSED rather than answered emptily for a session this scenario is not
    // playing or has said nothing about: a summary carries a required state, so
    // there is no absence to serve, and inventing one would put a session state on
    // screen that no author declared.
    sessionIdentityRead: async (request) => {
      const identity = scenarioSessionIdentity(engine.scenario, request.sessionId);
      return identity === undefined
        ? growthUnavailable("sessionIdentityRead")
        : { status: "served", value: identity };
    },
    // The negotiated ack the shell holds, from a script and from nothing else — the
    // health read's rule with a sharper edge. A negotiation outcome is an observation
    // of two builds meeting, and the reply's `compatible` admits no empty form: a
    // fabricated `true` would put the mismatch banner out of reach of every fixture
    // window, and a fabricated `false` would raise it in all of them.
    //
    // Keyed on the operation and not on `daemon.hello`: this row registers no expected
    // wire method, because the seam it needs is a bridge READ of a reply the shell
    // already holds and a window that re-sent the handshake would be refused by the
    // daemon's own per-connection latch. `negotiation-replies.ts` owns the key.
    daemonNegotiationRead: async (request) =>
      answerFromScriptedReply(
        engine,
        DAEMON_NEGOTIATION_READ_CALL,
        "daemonNegotiationRead",
        request,
        () => growthUnavailable("daemonNegotiationRead"),
      ),
    // The one accountant's own figure, from a script and from nothing else. An empty
    // form here would be a zero, and a zero is not an absence: it says this session
    // has spent nothing, which is a statement about money that no author made. The
    // receipt beside it stays unserved — a decomposition has the same problem three
    // times over, and no console surface reads one.
    orchestrationBudgetRead: async (request) =>
      answerFromScriptedReply(
        engine,
        "orchestration.budgetRead",
        "orchestrationBudgetRead",
        request,
        () => growthUnavailable("orchestrationBudgetRead"),
      ),
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
      // Routed through the scripted-reply seam so a scenario that DOES script
      // `gitflow.branchContextRead` is answered from the script, on the frozen clock,
      // with the loading window and the two non-arrival refusals a real read has.
      //
      // The REQUEST travels with the call because this operation is entity-scoped: it
      // names a workspace and a worktree, and a scenario answering it per worktree
      // reads exactly that. Discarded, every branch-context read in a session was
      // computed about no worktree, so a two-worktree session got one answer twice or
      // none at all.
      //
      // The unscripted arm REFUSES. The registered reply is flat and carries no
      // absence to serve — a pair that resolves no row refuses on that wire — so the
      // honest answer for a script that has not said is the "not checked" refusal,
      // and a fabricated empty context would be a shape no daemon sends. The fallback
      // this seam takes is a whole outcome, so that refusal is NAMED here rather than
      // smuggled through an absent value and re-read by the caller.
      //
      // It refuses as the SCENARIO's gap and never as an unbuilt wire, on the rule
      // `answerScriptOnly` in `scripted-answer.ts` states in full: this fixture
      // serves the operation, so `wire-unregistered` would be false about the build and
      // would send a reader to a document owing a wire that already has a stand-in.
      answerFromScriptedReply(
        engine,
        "gitflow.branchContextRead",
        "gitflowBranchContextRead",
        request,
        () => growthUnscriptedReply("gitflowBranchContextRead", "gitflow.branchContextRead"),
      ),
    // The diff-artifact mint and the payload read its ids are only useful through.
    //
    // BOTH ARE SCRIPT-ONLY AND BOTH REFUSE THE SAME WAY, on the branch-context read's
    // rule above. A mint that answered from nothing would tell a surface the daemon
    // computed a change set no author declared, and a payload read that answered from
    // nothing would have to invent bytes for a named artifact — the two inventions
    // `call-plane/served-operations.ts` separates a served empty answer from.
    gitflowDiffArtifactCreate: async (request) =>
      answerFromScriptedReply(
        engine,
        REPOS_DIFF_ARTIFACT_CREATE_CALL,
        "gitflowDiffArtifactCreate",
        request,
        () => growthUnscriptedReply("gitflowDiffArtifactCreate", REPOS_DIFF_ARTIFACT_CREATE_CALL),
      ),
    artifactRead: async (request) =>
      answerFromScriptedReply(engine, REPOS_ARTIFACT_READ_CALL, "artifactRead", request, () =>
        growthUnscriptedReply("artifactRead", REPOS_ARTIFACT_READ_CALL),
      ),
    // agent plane
    //
    // Each unscripted arm answers the EMPTY state of its own read rather than a
    // refusal, on the invite ledger's rule above: a session with no agents attached
    // and a session whose roster could not be read are different answers, and the
    // agent console draws them differently. A scenario that scripts nothing here has
    // a session with nobody in it, which is what a fresh session IS.
    agentList: async (request) =>
      answerFromScriptedReply(engine, "agent.list", "agentList", request, () => ({
        status: "served",
        value: { agents: [] },
      })),
    // The three WRITES have no empty state, and their unscripted arm says so. A write
    // that answered a synthesized receipt would tell a surface the daemon did
    // something no scenario ever said it did — and an attach in particular is what
    // mints an identity every later read is keyed by.
    agentAttach: async (request) =>
      await answerScriptOnly(engine, "agent.attach", "agentAttach", request),
    agentConfigUpdate: async (request) =>
      await answerScriptOnly(engine, "agent.configUpdate", "agentConfigUpdate", request),
    agentDetach: async (request) =>
      await answerScriptOnly(engine, "agent.detach", "agentDetach", request),
    // browser — the provenance the produced-object shelf joins the log against.
    //
    // Routed through the scripted-reply seam and answered with the EMPTY SET when a
    // scenario names nothing, on the invite ledger's rule: a session whose browser has
    // produced nothing is an ordinary session the shelf has to draw, and a refusal
    // here would say the question was never asked. A scenario that publishes artifacts
    // and scripts no reply is saying those artifacts came from somewhere else.
    browserProducedArtifacts: async (request) =>
      answerFromScriptedReply(
        engine,
        BROWSER_PRODUCED_ARTIFACTS_CALL,
        "browserProducedArtifacts",
        request,
        () => ({ status: "served", value: { artifactIds: [] } }),
      ),
    // terminal lease — the two calls whose interesting answers are all refusals. Both
    // route through the write seam rather than the read one: a take that nobody
    // scripted has no honest served form, since taking the shell MOVES it and the
    // pane's holder comes from the `pty.control_changed` beat rather than from this
    // reply. A scenario that scripts a refusal reaches the caller's own `catch`
    // exactly as a live rejection does, which is what makes the refusal renderings
    // reachable at all.
    terminalAcquireWriteLease: async (request) =>
      await answerScriptOnly(engine, "session.takeControl", "terminalAcquireWriteLease", request),
    terminalReleaseWriteLease: async (request) =>
      await answerScriptOnly(
        engine,
        "session.releaseControl",
        "terminalReleaseWriteLease",
        request,
      ),
    orchestrationChildRunLinkRead: async (request) =>
      answerFromScriptedReply(
        engine,
        "orchestration.childRunLinkRead",
        "orchestrationChildRunLinkRead",
        request,
        // A parent run with no children and no refused creates is the ordinary case,
        // and both halves are empty rather than absent: a fold with no rows is a
        // statement that nothing was refused, which is exactly what the panel draws.
        () => ({ status: "served", value: { links: [], rejectedCreates: [] } }),
      ),
    sidekickDefinitionList: async (request) =>
      answerFromScriptedReply(
        engine,
        "sidekick.definitionList",
        "sidekickDefinitionList",
        request,
        // A node with no saved definitions is an ordinary node — the attach form's
        // inline arm needs none — so the picker draws the empty registry rather than
        // a refusal.
        () => ({ status: "served", value: [] }),
      ),
    sidekickPeerInvocationSet: async (request) =>
      await answerScriptOnly(
        engine,
        "sidekick.peerInvocationSet",
        "sidekickPeerInvocationSet",
        request,
      ),
    // The provider-session import, both halves from the script. The opening call is a
    // WRITE — there is no "the import that began and produced nothing" — and the
    // subscription is addressed by the import that call minted, so neither has an
    // honest empty answer and both refuse under a scenario that scripts no import.
    providerSessionImportBegin: async (request) =>
      await answerFromScriptedReply(
        engine,
        PROVIDER_SESSION_IMPORT_BEGIN_CALL,
        "providerSessionImportBegin",
        request,
        () =>
          growthUnscriptedReply("providerSessionImportBegin", PROVIDER_SESSION_IMPORT_BEGIN_CALL),
      ),
    //
    // THE PROGRESS FEED IS PACED HERE, where the stream is opened, and it has to be:
    // a scenario reaches no clock, so a script that drained its own frames handed the
    // whole import to one turn — React batched the renders and the fixture painted
    // only the terminal `complete` frame, leaving the running states and a
    // mid-import cancellation reachable from nowhere. The values stay the script's;
    // what this adds is the schedule, taken from the ticks the script declares beside
    // them and spent on the frozen clock rather than on a timer.
    providerSessionImportSubscribe: async (request) =>
      mapGrowthServed(
        await answerFromScriptedReply(
          engine,
          PROVIDER_SESSION_IMPORT_SUBSCRIBE_CALL,
          "providerSessionImportSubscribe",
          request,
          () =>
            growthUnscriptedReply(
              "providerSessionImportSubscribe",
              PROVIDER_SESSION_IMPORT_SUBSCRIBE_CALL,
            ),
        ),
        (scripted) =>
          paceGrowthStreamOnScenarioClock(
            engine,
            scripted,
            PROVIDER_SESSION_IMPORT_PROGRESS_FRAMES,
          ),
      ),
    // repos — the workspace's own execution context.
    //
    // ITS UNSCRIPTED ARM IS THE WORKFLOW SUBJECT READS' AND NOT THE INVITE LEDGER'S,
    // for the reason `call-plane/served-operations.ts` gives: this read answers facts
    // about ONE named workspace, so an empty answer would assert that the workspace
    // exists and is bound to no root — an invention, where an invite ledger with no
    // rows is an ordinary session. Routed through the scripted seam so a scenario
    // answers per workspace, exactly as the entity-scoped `repo.*` reads beside it do.
    workspaceExecutionContextRead: async (request) =>
      answerFromScriptedReply(
        engine,
        REPOS_EXECUTION_CONTEXT_CALL,
        "workspaceExecutionContextRead",
        request,
        () => growthUnscriptedReply("workspaceExecutionContextRead", REPOS_EXECUTION_CONTEXT_CALL),
      ),
    // diagnostics — the five reads the settings page is built from, spread from the
    // module that implements them so the served ids in `call-plane/served-operations.ts`
    // and the handlers stay one
    // set. Two answer under any scenario and three refuse without a script; that
    // module's header carries the whole of why.
    ...fixtureDiagnosticsReads(engine),
    // The two durable run records — the run's intervention history and the queue's
    // run bindings.
    ...fixtureRunRecordReads(engine),
    // provider accounts — the three verbs of the brokered sign-in handoff, all three
    // script-only. The registry READ they act on is not here at all: it is
    // `providerAccount.list` over the bound call door.
    ...fixtureProviderAccountWrites(engine),
    // MCP governance — the inventory read and the two mutations, ONE plane rather than
    // three reply rows, because the module that implements them holds the per-port
    // ledger that makes a mutation's row what the next read serves.
    ...fixtureMcpGovernance(engine),
  };
  return { ...createRefusingGrowthPort(), ...served };
}
