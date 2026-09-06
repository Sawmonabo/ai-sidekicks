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
import type { ScenarioEngine } from "../scenario-runtime/index.js";

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
      // `answerScriptOnly` below states in full: this fixture serves the
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
      await answerScriptOnly(engine, "agent.attach", "agentAttach", request),
    agentConfigUpdate: async (request) =>
      await answerScriptOnly(engine, "agent.configUpdate", "agentConfigUpdate", request),
    agentDetach: async (request) =>
      await answerScriptOnly(engine, "agent.detach", "agentDetach", request),
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
    // diagnostics
    //
    // The two that answer under any scenario are the two whose empty form is a real
    // daemon reply, and neither is a fabrication: a status read that found no
    // components is not a verdict about the machine — `healthy` over an empty set is
    // what "nothing reported a problem" looks like on this wire — and the default
    // redaction posture is a policy with no bucket overrides, outbound denied, and no
    // retention override in force, which is the shape a fresh node is in.
    healthStatusRead: async (request) =>
      answerFromScriptedReply(engine, "health.statusRead", "healthStatusRead", request, () => ({
        status: "served",
        value: { overall: "healthy", components: [] },
      })),
    healthRedactionPolicyRead: async (request) =>
      answerFromScriptedReply(
        engine,
        "health.redactionPolicyRead",
        "healthRedactionPolicyRead",
        request,
        () => ({
          status: "served",
          value: { buckets: [], outboundDefault: "deny", retentionPolicyOverrideActive: false },
        }),
      ),
    // The three addressed by a subject, refusing by name without a script. A failure
    // detail and a stall reading answer with facts ABOUT one named run, so an empty
    // form would assert the run exists and that nothing is wrong with it; the recovery
    // request is a write, and a synthesized receipt would report that the daemon moved
    // a run no author ever declared.
    healthFailureDetailRead: async (request) =>
      await answerScriptOnly(
        engine,
        "health.failureDetailRead",
        "healthFailureDetailRead",
        request,
      ),
    healthStuckRunInspect: async (request) =>
      await answerScriptOnly(engine, "health.stuckRunInspect", "healthStuckRunInspect", request),
    healthRecoveryActionRequest: async (request) =>
      await answerScriptOnly(
        engine,
        "health.recoveryActionRequest",
        "healthRecoveryActionRequest",
        request,
      ),
    // provider accounts — three writes, and all three script-only. A brokered sign-in
    // answers with a verification URI and a daemon-minted attempt id; a cancel answers
    // what became of one; a registration answers with the account it created. None of
    // the three has an empty form: a synthesized attempt would put a URL on screen that
    // leads nowhere, and a synthesized account would mint an identity every later
    // registry read is keyed by. The registry READ they act on is not here at all — it
    // is `providerAccount.list` over the bound call door, answered from the scenario's
    // own scripted reply and parsed against the registered schema.
    providerAccountLogin: async (request) =>
      await answerScriptOnly(engine, "providerAccount.login", "providerAccountLogin", request),
    providerAccountLoginCancel: async (request) =>
      await answerScriptOnly(
        engine,
        "providerAccount.loginCancel",
        "providerAccountLoginCancel",
        request,
      ),
    providerAccountRegister: async (request) =>
      await answerScriptOnly(
        engine,
        "providerAccount.register",
        "providerAccountRegister",
        request,
      ),
    // MCP governance — the inventory read answers the EMPTY inventory for a scenario
    // that scripts nothing, on the invite ledger's rule: a node that governs no MCP
    // servers is an ordinary node and the operator page draws that state, whereas "the
    // inventory could not be read" is what a release build renders and is a different
    // sentence. The two mutations are script-only: each answers with the row as it now
    // stands plus per-leg outcomes, and a synthesized one would report that the daemon
    // reconciled live sessions no author ever declared.
    mcpList: async (request) =>
      answerFromScriptedReply(engine, "mcp.list", "mcpList", request, () => ({
        status: "served",
        value: { servers: [] },
      })),
    mcpSetEnabled: async (request) =>
      await answerScriptOnly(engine, "mcp.setEnabled", "mcpSetEnabled", request),
    mcpSetTrust: async (request) =>
      await answerScriptOnly(engine, "mcp.setTrust", "mcpSetTrust", request),
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
 * Answer one SCRIPT-ONLY operation from the script, and refuse where none is scripted.
 *
 * Two classes land here, and `fixture-served-operations.ts` names both because the
 * membership decision is that module's. A WRITE: "this session has no agents" is a
 * state the console draws and there is no such thing as "the attach that happened and
 * produced nothing", so a synthesized receipt would tell a surface the daemon did
 * something no author ever said it did — and for an attach it would mint an identity
 * every later read is keyed by. And a READ ADDRESSED BY A SUBJECT: one run's failure
 * detail, one run's stall reading, one run's snapshot — each answers with facts ABOUT
 * a named thing, so an empty form would assert the thing exists and holds nothing,
 * which for a run no author declared is the same invention as a receipt.
 *
 * The enumerations are deliberately not in either class: a list of none is a real
 * answer to "what does this session hold", and those operations serve it.
 *
 * The precondition is checked here rather than inside the seam because it is a fact
 * about the SCENARIO rather than about the settlement — `callerParticipantRead` next
 * door reads its own precondition off `engine.scenario` for the same reason. What is
 * left after the check is exactly the settlement the seam reports, so the parked,
 * abandoned, and over-cap arms all keep their own answers.
 */
async function answerScriptOnly<TOperationId extends GrowthOperationId>(
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
