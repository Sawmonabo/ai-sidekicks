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
  };
  return { ...createRefusingGrowthPort(), ...served };
}
