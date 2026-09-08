// The growth port the fixture bridge actually serves.
//
// ONE RULE DECIDES WHICH OPERATIONS IT ANSWERS, and that rule and its whole membership
// list live in `fixture-served-operations.ts` beside this file. What is HERE is how each
// served operation composes its answer.
//
// WHAT THIS MODULE OWNS, AND WHAT ITS NEIGHBOURS DO
//
// This one owns the outcome each served operation answers with. The answers with a job
// of their own live beside it, because each fails in a way this one cannot —
// `fixture-session-snapshot.ts` derives the base state one session opens with,
// `fixture-session-directory.ts` derives what the node HAS,
// `fixture-attention-derivation.ts` folds beats into an attention projection,
// `fixture-workflow-scope.ts` derives which workflow subjects a script can answer for,
// `fixture-workflow-reads.ts` holds the workflow answers and the reasoning that governs
// them, `fixture-collaboration-reads.ts` the channel and membership answers,
// `fixture-diagnostics-reads.ts` the five the settings page's diagnostics regions
// are built on, `fixture-provider-account-writes.ts` the three verbs of the sign-in
// handoff, `fixture-mcp-governance.ts` the inventory read and the two mutations that
// move a row in it, `fixture-onboarding-answers.ts` the onboarding plane and the ledger
// its own mutations move, `fixture-shell-answers.ts` the shell plane and the one channel
// its feed and its three controls share, and `fixture-scripted-answer.ts` maps a scripted
// settlement onto an outcome — reads and writes both, including the script-only
// disposition those planes and this port all take.
//
// A PLANE LEAVES WITH ITS SERVED IDS. Each of those modules declares the operation ids
// it implements and this port spreads both the ids and the handlers, so a plane's set
// and its answers cannot disagree — `fixture-workflow-reads.ts` states the rule in full.
//

import {
  readApprovalProjection,
  readRememberedRuleList,
  type ParsedRows,
} from "../approvals/index.js";
import { readActivityFromScenario } from "./fixture-activity.js";
import { BROWSER_PRODUCED_ARTIFACTS_CALL } from "../scenarios/browser.js";
import { deriveAttentionProjection } from "./fixture-attention-derivation.js";
import type { FixtureInviteLedger } from "./fixture-invite-ledger.js";
import { FixturePendingInvites } from "./fixture-pending-invites.js";
import { fixtureDiagnosticsReads } from "./fixture-diagnostics-reads.js";
import { paceGrowthStreamOnScenarioClock } from "./fixture-due-frames.js";
import { fixtureMcpGovernance } from "./fixture-mcp-governance.js";
import { fixtureCollaborationReads } from "./fixture-collaboration-reads.js";
import type { FixtureChannelLifecycle } from "./fixture-channel-lifecycle.js";
import { fixtureOnboardingAnswers } from "./fixture-onboarding-answers.js";
import { fixtureProviderAccountWrites } from "./fixture-provider-account-writes.js";
import { answerFromScriptedReply, answerScriptOnly } from "./fixture-scripted-answer.js";
import { fixtureShellAnswers } from "./fixture-shell-answers.js";
import { directorySessionsOf } from "./fixture-session-directory.js";
import { fixtureSessionSnapshot } from "./fixture-session-snapshot.js";
import {
  createRefusingGrowthPort,
  growthUnavailable,
  growthUnscriptedReply,
  mapGrowthServed,
  type GrowthOutcome,
  type GrowthPort,
} from "../growth-port/index.js";
import type { FixtureServedGrowthOperationId } from "./fixture-served-operations.js";
import { fixtureWorkflowReads } from "./fixture-workflow-reads.js";
import {
  PROVIDER_SESSION_IMPORT_BEGIN_CALL,
  PROVIDER_SESSION_IMPORT_PROGRESS_FRAMES,
  PROVIDER_SESSION_IMPORT_SUBSCRIBE_CALL,
} from "../scenarios/bring-your-history.js";
// The routing keys themselves, from the scenario modules that mint them — the
// workflow enumeration's rule one file over: restated as literals here, a rename would
// move the constant and the reply and leave a handler answering a key nothing sends.
import {
  REPOS_ARTIFACT_READ_CALL,
  REPOS_DIFF_ARTIFACT_CREATE_CALL,
} from "../scenarios/repos-diff-replies.js";
import { REPOS_EXECUTION_CONTEXT_CALL } from "../scenarios/repos-mutation-replies.js";
import type { ScenarioEngine } from "../scenario-runtime/index.js";

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
 * and the `channel.list` fold — and `fixture-bridge.ts` states why one serves both.
 */
export function createFixtureGrowthPort(
  engine: ScenarioEngine,
  channelLifecycle: FixtureChannelLifecycle,
  inviteLedger: FixtureInviteLedger,
): GrowthPort {
  // The deep link's whole lifecycle, held for this engine's life. An instance rather
  // than five helpers, because the five operations share one table of references and
  // one open outcome feed — the reasoning is that module's own.
  const pendingInvites = new FixturePendingInvites(engine);
  const served: Pick<GrowthPort, FixtureServedGrowthOperationId> = {
    // workflow, collaboration, onboarding and shell — spread from the modules that
    // implement them, so the served ids next door and the handlers there are held to
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
      // `answerScriptOnly` in `fixture-scripted-answer.ts` states in full: this fixture
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
    // `fixture-served-operations.ts` separates a served empty answer from.
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
    // identity
    callerParticipantRead: async (request) => {
      const { viewingParticipantId } = engine.scenario;
      // Refused rather than answered with an absence, on the same reading the
      // branch-context read above takes: a scenario that has not said has left the
      // question unasked rather than answered it emptily, and a session always HAS a
      // viewer, so there is no "we asked and there is none" state to serve. Both
      // take the "not checked" refusal the live bridge takes.
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
    // invites
    invitesList: async (request) =>
      // Routed through the scripted-reply seam on the branch-context read's rule, and
      // answered with the EMPTY LEDGER when a scenario scripts nothing. The two facts
      // are different and the surface draws them differently: "the read is not
      // registered" is what a release build renders, and "this session has sent
      // nobody an invitation" is a state the sent-invite ledger and the received-
      // invite shelf both have to draw and could reach from no scenario at all while
      // this operation refused.
      //
      // The REQUEST travels with the call for the reason the seam states: a scenario
      // answers through `resultFor`, which is handed exactly what the caller sent, and
      // a helper called without it computes every answer about no session at all.
      //
      // An empty array is a legitimate daemon answer here in a way it is NOT for the
      // callback-tool registry next door: an invite ledger with no rows is an ordinary
      // session, whereas a withheld tool registry and an empty one are different
      // answers to different questions.
      //
      // AND THE ANSWER FOLDS THROUGH THE LEDGER, which is what makes a mint reach the
      // read that shows it: the two invite mutations settle on the OTHER door, and
      // `fixture-invite-ledger.ts` is the holder both share. Through `mapGrowthServed`
      // so a refusal travels back exactly as it arrived.
      mapGrowthServed(
        await answerFromScriptedReply(engine, "invites.list", "invitesList", request, () => ({
          status: "served",
          value: [],
        })),
        (rows) => inviteLedger.foldOverScripted(rows),
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
    // for the reason `fixture-served-operations.ts` gives: this read answers facts
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
    // module that implements them so the served ids next door and the handlers stay one
    // set. Two answer under any scenario and three refuse without a script; that
    // module's header carries the whole of why.
    ...fixtureDiagnosticsReads(engine),
    // provider accounts — the three verbs of the brokered sign-in handoff, all three
    // script-only. The registry READ they act on is not here at all: it is
    // `providerAccount.list` over the bound call door.
    ...fixtureProviderAccountWrites(engine),
    // MCP governance — the inventory read and the two mutations, ONE plane rather than
    // three reply rows, because the module that implements them holds the per-port
    // ledger that makes a mutation's row what the next read serves.
    ...fixtureMcpGovernance(engine),
    // presence — the session's live activity, resolved by the frame that has fallen
    // due on the frozen clock. Not routed through the scripted-reply seam, for the
    // runtime-node roster's reason: this answer is a function of the CLOCK, and the
    // reply table answers each call with one fixed value.
    presenceActivityRead: async (request) => readActivityFromScenario(engine, request),
    // invite — the pending lifecycle. The two feeds are opened per subscribe, so a
    // window that re-subscribes after a teardown is handed a live one rather than a
    // stream somebody else already closed.
    invitePendingSubscribe: async () => ({
      status: "served",
      value: pendingInvites.openPendingFeed(),
    }),
    inviteOutcomeSubscribe: async () => ({
      status: "served",
      value: pendingInvites.openOutcomeFeed(),
    }),
    inviteConfirmPending: async (request) => pendingInvites.confirm(request.reference),
    inviteRetryPending: async (request) => pendingInvites.retry(request.attempt),
    inviteDismissPending: async (request) => pendingInvites.dismiss(request.reference),
    // The node's control-plane host, from the scenario's own declaration. Refused as
    // the SCENARIO's gap where none is declared — this fixture serves the operation,
    // so naming an unbuilt wire would send a reader to a document owing something
    // that already has a stand-in — and never answered with a host this fixture
    // chose, which would compose a link that opens nothing and looks exactly like
    // one that works.
    controlPlaneHostRead: async () => {
      const { controlPlaneHost } = engine.scenario;
      if (controlPlaneHost === undefined) {
        return growthUnscriptedReply("controlPlaneHostRead", "this node's control-plane host");
      }
      return { status: "served", value: { host: controlPlaneHost } };
    },
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
    await answerFromScriptedReply(engine, call, operationId, request, () =>
      growthUnscriptedReply(operationId, call),
    ),
    narrow,
  );
}
