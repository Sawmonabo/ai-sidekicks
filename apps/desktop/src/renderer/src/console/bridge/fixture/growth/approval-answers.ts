// The fixture's approvals answers: two reads a person acts on, and the two acts.
//
// A MODULE OF ITS OWN RATHER THAN A BLOCK IN THE PORT, on `shell/shell-answers.ts`'
// rule. The four share one settle-then-narrow shape and one unscripted disposition,
// and the reasoning that admits them is the same argument for all four — so the plane
// and its reasoning stay one unit. It sits in `growth/` rather than beside a group of
// its own because these are folds of the growth port itself: no scenario-facing
// approvals plane exists in this directory for them to sit beside.
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
// The two session-goal operations are deliberately absent: `call-plane/served-operations.ts`
// carries that reasoning beside the rest of the membership argument.

import {
  readApprovalProjection,
  readRememberedRuleList,
  type ParsedRows,
} from "../../approvals/index.js";
import { answerFromScriptedReply } from "./scripted-answer.js";
import {
  growthUnscriptedReply,
  mapGrowthServed,
  type GrowthOutcome,
  type GrowthPort,
} from "../../growth-port/index.js";
import type { ScenarioEngine } from "../../scenario-runtime/index.js";

/**
 * The four approvals operations the fixture answers.
 *
 * Declared here and spread into `FIXTURE_SERVED_GROWTH_OPERATION_IDS` next door, on
 * `FIXTURE_SERVED_SHELL_OPERATION_IDS`' rule: the ids and the implementations below
 * are one set with one home, and a second tuple in the served module would agree with
 * this one until an operation landed in only one of them.
 */
export const FIXTURE_SERVED_APPROVAL_OPERATION_IDS = [
  "approvalProjectionRead",
  "approvalRuleList",
  "approvalResolve",
  "approvalRuleRevoke",
] as const;

/** One approvals operation the fixture serves. Derived, so the set has one home. */
export type FixtureServedApprovalOperationId =
  (typeof FIXTURE_SERVED_APPROVAL_OPERATION_IDS)[number];

/**
 * The fixture's four approvals answers for one running scenario.
 *
 * `Pick` over the port rather than a shape of its own, on `fixtureShellAnswers`'
 * reason: a handler whose signature drifts from the operation it serves is a compile
 * error here rather than a surface rendering a value no daemon sends.
 */
export function fixtureApprovalAnswers(
  engine: ScenarioEngine,
): Pick<GrowthPort, FixtureServedApprovalOperationId> {
  return {
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
