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
import type { GrowthBranchContext } from "../growth-values/gitflow.js";
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
    gitflowBranchContextRead: async (request) => {
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
      // and a fabricated empty context would be a shape no daemon sends.
      const scripted = await answerFromScriptedReply<GrowthBranchContext | undefined>(
        engine,
        "gitflow.branchContextRead",
        "gitflowBranchContextRead",
        request,
        () => undefined,
      );
      if (scripted.status === "unavailable") {
        return scripted;
      }
      return scripted.value === undefined
        ? growthUnavailable("gitflowBranchContextRead")
        : { status: "served", value: scripted.value };
    },
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
  };
  return { ...createRefusingGrowthPort(), ...served };
}
