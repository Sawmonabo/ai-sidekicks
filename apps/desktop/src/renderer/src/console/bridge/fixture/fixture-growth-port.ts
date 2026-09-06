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
// them, and `fixture-scripted-answer.ts` maps a scripted settlement onto an outcome.
//

import {
  readApprovalProjection,
  readRememberedRuleList,
  type ParsedRows,
} from "../approvals/index.js";
import { deriveAttentionProjection } from "./fixture-attention-derivation.js";
import { answerFromScriptedReply } from "./fixture-scripted-answer.js";
import {
  FixtureShellChannel,
  SHELL_STATUS_SCRIPT,
  startingReport,
  stoppedReport,
} from "./fixture-shell-status.js";
import type { GrowthOperationId } from "../growth-port/growth-entry.js";
import type { GrowthOperationSignatures } from "../growth-signatures/index.js";
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
  PROVIDER_SESSION_IMPORT_SUBSCRIBE_CALL,
  SHELL_NOTIFICATION_PERMISSION_CALL,
} from "../scenarios/bring-your-history.js";
import type { ScenarioEngine } from "../scenario-runtime/index.js";
import type { ShellReport } from "../../store/index.js";

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
  // One channel per port, so the feed and the three controls answer about one
  // shell and a control pressed in this window cannot move another window's.
  const shellChannel = new FixtureShellChannel(engine);
  const served: Pick<GrowthPort, FixtureServedGrowthOperationId> = {
    // workflow — spread from the module that implements them, so the served ids next
    // door and the handlers here are held to each other by the `Pick` above.
    ...fixtureWorkflowReads(engine),
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
      // `answerScriptedWrite` below states in full: this fixture serves the
      // operation, so `wire-unregistered` would be false about the build and would
      // send a reader to a document owing a wire that already has a stand-in.
      answerFromScriptedReply(
        engine,
        "gitflow.branchContextRead",
        "gitflowBranchContextRead",
        request,
        () => growthUnscriptedReply("gitflowBranchContextRead", "gitflow.branchContextRead"),
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
      answerFromScriptedReply(engine, "invites.list", "invitesList", request, () => ({
        status: "served",
        value: [],
      })),
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
      await answerScriptedWrite(engine, "agent.attach", "agentAttach", request),
    agentConfigUpdate: async (request) =>
      await answerScriptedWrite(engine, "agent.configUpdate", "agentConfigUpdate", request),
    agentDetach: async (request) =>
      await answerScriptedWrite(engine, "agent.detach", "agentDetach", request),
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
      await answerScriptedWrite(
        engine,
        "sidekick.peerInvocationSet",
        "sidekickPeerInvocationSet",
        request,
      ),
    // The shell's notification permission, from the script and from nowhere else. It
    // is a READ with no empty form, which puts it beside the subject-addressed
    // workflow reads rather than beside the enumerations: `granted`, `denied` and
    // `not-determined` are three answers and none of them is "nobody asked", so a
    // scenario that scripts nothing has left the question unasked and the read says
    // so. Answering `granted` by default would be worse than refusing — the centre
    // would stop saying it is the only surface, on a fixture where no notification
    // can be delivered at all.
    shellNotificationPermissionRead: async (request) =>
      await answerFromScriptedReply(
        engine,
        SHELL_NOTIFICATION_PERMISSION_CALL,
        "shellNotificationPermissionRead",
        request,
        () =>
          growthUnscriptedReply(
            "shellNotificationPermissionRead",
            SHELL_NOTIFICATION_PERMISSION_CALL,
          ),
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
    providerSessionImportSubscribe: async (request) =>
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
    // The shell's own condition — the one FEED this port serves, opened from the
    // frames a scenario declares and refused by a scenario that declares none.
    //
    // That refusal is the SCENARIO's gap and never the build's, which is why it takes
    // the unscripted code rather than `wire-unregistered`: this port implements the
    // feed, and `wire-unregistered` would send a reader to the document owing a wire
    // the fixture already stands in for. What is missing is the scenario's own
    // `shellStatus` declaration, so the sentence names that rather than a call.
    shellStatusSubscribe: async () => {
      const stream = shellChannel.open();
      return stream === undefined
        ? growthUnscriptedReply("shellStatusSubscribe", SHELL_STATUS_SCRIPT)
        : { status: "served", value: stream };
    },
    // The three daemon controls answer about the same shell the feed does, through
    // the one channel above, and refuse for the same reason and by the same name
    // where the scenario declares no shell condition — a control that moved a shell
    // nobody declared would be the fixture inventing the state the feed will not.
    daemonStatusRead: async () => {
      const current = shellChannel.current();
      return current?.negotiation === undefined
        ? growthUnscriptedReply("daemonStatusRead", SHELL_STATUS_SCRIPT)
        : {
            status: "served",
            value: {
              state: current.connection.kind,
              version: current.negotiation.daemonProtocolVersion,
            },
          };
    },
    daemonStop: async () => publishShellControl(shellChannel, "daemonStop", stoppedReport),
    daemonRestart: async () => publishShellControl(shellChannel, "daemonRestart", startingReport),
    daemonStart: async () => publishShellControl(shellChannel, "daemonStart", startingReport),
    // onboarding — keyed by OPERATION ID under the `growth:` prefix rather than by a
    // method string, because none of these rows declares an expected wire method:
    // the five daemon methods are a Plan-026 registration the corpus has not made,
    // and the two bridge methods cross the preload boundary rather than the wire.
    // `reply-walk.ts` admits exactly this shape for a row with no name to transcribe.
    onboardingStateRead: async (request) =>
      answerFromScriptedReply(
        engine,
        "growth:onboardingStateRead",
        "onboardingStateRead",
        request,
        // The one onboarding answer with an honest empty form. A node nobody has
        // onboarded has completed no step and is not complete — that is a state the
        // walkthrough draws on its own first frame, and it is the state a fresh
        // install is genuinely in, so serving it invents nothing.
        () => ({ status: "served", value: { completedStepIds: [], isComplete: false } }),
      ),
    onboardingStepAdvance: async (request) =>
      await answerScriptedWrite(
        engine,
        "growth:onboardingStepAdvance",
        "onboardingStepAdvance",
        request,
      ),
    onboardingStepSkip: async (request) =>
      await answerScriptedWrite(engine, "growth:onboardingStepSkip", "onboardingStepSkip", request),
    onboardingComplete: async (request) =>
      await answerScriptedWrite(engine, "growth:onboardingComplete", "onboardingComplete", request),
    onboardingProviderSignInHandoff: async (request) =>
      await answerScriptedWrite(
        engine,
        "growth:onboardingProviderSignInHandoff",
        "onboardingProviderSignInHandoff",
        request,
      ),
    onboardingPresentChoice: async (request) =>
      await answerScriptedWrite(
        engine,
        "growth:onboardingPresentChoice",
        "onboardingPresentChoice",
        request,
      ),
    onboardingTelemetryPrompt: async (request) =>
      await answerScriptedWrite(
        engine,
        "growth:onboardingTelemetryPrompt",
        "onboardingTelemetryPrompt",
        request,
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
    await answerFromScriptedReply(engine, call, operationId, request, () =>
      growthUnscriptedReply(operationId, call),
    ),
    narrow,
  );
}

/**
 * Answer one WRITE from the script, and refuse where the scenario scripts none.
 *
 * A read has an empty state and a write does not: "this session has no agents" is a
 * state the console draws, and there is no such thing as "the attach that happened
 * and produced nothing". So a write that no scenario answers cannot take the served
 * arm with a synthesized receipt — that would tell a surface the daemon did
 * something no author ever said it did, and for an attach it would mint an identity
 * every later read is keyed by.
 *
 * The precondition is checked here rather than inside the seam because it is a fact
 * about the SCENARIO rather than about the settlement — `callerParticipantRead` next
 * door reads its own precondition off `engine.scenario` for the same reason. What is
 * left after the check is exactly the settlement the seam reports, so the parked,
 * abandoned, and over-cap arms all keep their own answers.
 */
async function answerScriptedWrite<TOperationId extends GrowthOperationId>(
  engine: ScenarioEngine,
  call: string,
  operationId: TOperationId,
  request: unknown,
): Promise<GrowthOutcome<GrowthOperationSignatures[TOperationId]["value"]>> {
  if (engine.replyFor(call) === undefined) {
    // The SCENARIO's gap and never the build's. `growthUnavailable` would compose
    // "this build does not carry the wire", which is false for an operation this
    // fixture serves and would send a reader to the document that owes a wire the
    // fixture already stands in for — the distinction `growthUnscriptedReply`'s own
    // header draws, and the one `fixture-growth-port.test.ts` holds every served
    // operation to.
    return growthUnscriptedReply(operationId, call);
  }
  return await answerFromScriptedReply<TOperationId>(engine, call, operationId, request, () => {
    // Unreachable: the guard above already refused every unscripted call, and the
    // seam reports `unscripted` only for exactly that. Named rather than cast, so a
    // later change that moves the guard fails here loudly instead of serving a value
    // that was never scripted.
    throw new Error(`${call} reached the unscripted arm behind its own scripted guard`);
  });
}

/**
 * Move the fixture's shell with one control, or refuse where none is scripted.
 *
 * The three controls differ only in the report they produce, so the refusal rule —
 * and the fact that a control answers `void` rather than a state — is written once.
 */
function publishShellControl(
  channel: FixtureShellChannel,
  operationId: "daemonStop" | "daemonRestart" | "daemonStart",
  next: (current: ShellReport) => ShellReport,
): GrowthOutcome<void> {
  const current = channel.current();
  if (current === undefined) {
    return growthUnscriptedReply(operationId, SHELL_STATUS_SCRIPT);
  }
  channel.publish(next(current));
  return { status: "served", value: undefined };
}
