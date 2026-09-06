// The growth port the fixture bridge actually serves.
//
// ONE RULE DECIDES WHICH OPERATIONS IT ANSWERS, and that rule and its whole membership
// list live in `fixture-served-operations.ts` beside this file. What is HERE is how each
// served operation composes its answer.
//
// WHAT THIS MODULE OWNS, AND WHAT ITS NEIGHBOURS DO
//
// This one owns the outcome each served operation answers with. The four answers with
// a job of their own live beside it, because each fails in a way this one cannot —
// `fixture-session-snapshot.ts` derives the base state one session opens with,
// `fixture-session-directory.ts` derives what the node HAS,
// `fixture-attention-derivation.ts` folds beats into an attention projection, and
// `fixture-scripted-answer.ts` maps a scripted settlement onto an outcome.
//

import { deriveAttentionProjection } from "./fixture-attention-derivation.js";
import { answerFromScriptedReply } from "./fixture-scripted-answer.js";
import type { GrowthOperationId } from "../growth-port/growth-entry.js";
import type { GrowthOutcome } from "../growth-port/growth-outcome.js";
import { directorySessionsOf } from "./fixture-session-directory.js";
import { fixtureSessionSnapshot } from "./fixture-session-snapshot.js";
import {
  createRefusingGrowthPort,
  growthUnavailable,
  type GrowthPort,
} from "../growth-port/index.js";
import type { ScenarioEngine } from "../scenario-runtime/index.js";

import type { FixtureServedGrowthOperationId } from "./fixture-served-operations.js";

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
      answerFromScriptedReply(engine, "invites.list", "invitesList", request, () => []),
    // agent plane
    //
    // Each unscripted arm answers the EMPTY state of its own read rather than a
    // refusal, on the invite ledger's rule above: a session with no agents attached
    // and a session whose roster could not be read are different answers, and the
    // agent console draws them differently. A scenario that scripts nothing here has
    // a session with nobody in it, which is what a fresh session IS.
    agentList: async (request) =>
      answerFromScriptedReply(engine, "agent.list", "agentList", request, () => ({ agents: [] })),
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
        () => ({ links: [], rejectedCreates: [] }),
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
        () => [],
      ),
    sidekickPeerInvocationSet: async (request) =>
      await answerScriptedWrite(
        engine,
        "sidekick.peerInvocationSet",
        "sidekickPeerInvocationSet",
        request,
      ),
  };
  return { ...createRefusingGrowthPort(), ...served };
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
async function answerScriptedWrite<TValue>(
  engine: ScenarioEngine,
  call: string,
  operationId: GrowthOperationId,
  request: unknown,
): Promise<GrowthOutcome<TValue>> {
  if (engine.replyFor(call) === undefined) {
    return growthUnavailable(operationId);
  }
  return await answerFromScriptedReply<TValue>(engine, call, operationId, request, () => {
    // Unreachable: the guard above already refused every unscripted call, and the
    // seam reports `unscripted` only for exactly that. Named rather than cast, so a
    // later change that moves the guard fails here loudly instead of serving a value
    // that was never scripted.
    throw new Error(`${call} reached the unscripted arm behind its own scripted guard`);
  });
}
