// Onboarding: the six answers, and the one piece of fixture state a caller MOVES.
//
// WHY THIS PLANE HAS A MODULE. `workflows/workflow-reads.ts` states the shape
// — a plane whose answers need reasoning of their own leaves the port and takes its
// served ids with it, so the ids and the handlers stay one set with one home. This
// plane earns it twice over, because it is the only one in the fixture whose read is
// not a pure function of the script: the walkthrough RECORDS steps, and a read that
// answered the same ids afterwards would be a fixture teaching every surface above it
// that the primary action of a first-run step changes nothing.
//
// THE LEDGER IS THE SCENARIO RUNTIME'S OWN MECHANISM, not a second one. A scenario is
// DATA and is replayed tick-for-tick, so it holds no mutable field and `resultFor` is
// contractually stateless; what holds per-port mutable state in this family is a
// CLASS the port owns, one instance per port — `FixtureShellChannel` in
// `shell/shell-status.ts` is the precedent and its header carries the reasoning.
// One instance per port is the load-bearing half: a step recorded in one window must
// not appear in another window's rail.
//
// THE SCRIPT STAYS THE BASELINE. The ledger does not replace the scripted read, it
// FOLDS OVER it — so the onboarding scenario still opens part-done with the relay step
// recorded, and what a person does from there is added to that. A ledger answering on
// its own would have made the scripted opening state unreachable, and that state is
// what the rail exists to show.
//
// AND A REFUSED MUTATION MOVES NOTHING. That rule has one home, `#recordIfServed`
// below, rather than a `status === "served"` test at each recording call site: copies
// of a guard are chances for the next verb to forget it, and a fixture that recorded a
// refused step would show a person progress the daemon refused them.
//
// KEYED BY OPERATION ID UNDER THE `growth:` PREFIX rather than by a method string,
// because none of these rows declares an expected wire method: the five daemon methods
// are a Plan-026 registration the corpus has not made, and the two bridge methods cross
// the preload boundary rather than the wire. `reply-walk.ts` admits exactly this shape
// for a row with no name to transcribe.

import { answerFromScriptedReply, answerScriptOnly } from "../growth/scripted-answer.js";
import { mapGrowthServed, type GrowthOutcome, type GrowthPort } from "../../growth-port/index.js";
import type { GrowthOperationSignatures } from "../../growth-signatures/index.js";
import type { ScenarioEngine } from "../../scenario/runtime/engine.js";

/**
 * The six onboarding operations the fixture answers.
 *
 * Declared here and spread into `FIXTURE_SERVED_GROWTH_OPERATION_IDS` in
 * `call-plane/served-operations.ts`, on
 * `FIXTURE_SERVED_WORKFLOW_OPERATION_IDS`' rule: the ids and the implementations below
 * are one set with one home, and a second tuple in the served module would agree with
 * this one until a verb landed in only one of them.
 */
export const FIXTURE_SERVED_ONBOARDING_OPERATION_IDS = [
  "onboardingStateRead",
  "onboardingStepAdvance",
  "onboardingStepSkip",
  "onboardingComplete",
  "onboardingPresentChoice",
  "onboardingTelemetryPrompt",
] as const;

/** One onboarding operation the fixture serves. Derived, so the set has one home. */
export type FixtureServedOnboardingOperationId =
  (typeof FIXTURE_SERVED_ONBOARDING_OPERATION_IDS)[number];

/** What the state read answers with, from the signature table rather than retyped. */
type OnboardingStateReading = GrowthOperationSignatures["onboardingStateRead"]["value"];

/**
 * What this port's caller has recorded since the scenario started playing.
 *
 * A class with private fields, on `FixtureShellChannel`'s reason: it owns state two
 * handlers have to agree about, and a module-level `let` would be one ledger shared by
 * every window the renderer ever opens.
 *
 * ONE SET AND NOT TWO. An advance and a skip both land in `completedStepIds`, because
 * that is the only set the read's own shape carries: `step-model.ts` reads it as the
 * RESOLVED set — `firstUnresolvedStep` walks it to decide where a resumed walkthrough
 * opens — so a skipped step held out of it would leave the rail pointing at a step the
 * person had already answered, for the life of the window. Which of the two verbs
 * resolved it is not a distinction this reply can carry, and minting a second member
 * for it here would be the fixture teaching a surface a shape no daemon sends.
 */
export class FixtureOnboardingLedger {
  readonly #resolvedStepIds = new Set<string>();
  #hasCompleted = false;

  /**
   * Fold what has been recorded into the scripted read.
   *
   * The scripted ids come FIRST and in their own order, and a recorded id already among
   * them is not repeated: the read answers a set, and a duplicate would make
   * `completedStepIds.length` say something the set does not.
   *
   * A refusal travels through untouched — `mapGrowthServed`'s whole reason — so a
   * scenario whose state read is unanswered still refuses by name rather than being
   * handed a reading the fixture composed for it.
   */
  public foldInto(
    read: GrowthOutcome<OnboardingStateReading>,
  ): GrowthOutcome<OnboardingStateReading> {
    return mapGrowthServed(read, (scripted) => ({
      completedStepIds: [
        ...scripted.completedStepIds,
        ...[...this.#resolvedStepIds].filter(
          (stepId) => !scripted.completedStepIds.includes(stepId),
        ),
      ],
      isComplete: scripted.isComplete || this.#hasCompleted,
    }));
  }

  /** Record a step the daemon accepted as answered. Answers the write untouched. */
  public recordStepResolved(stepId: string, write: GrowthOutcome<void>): GrowthOutcome<void> {
    return this.#recordIfServed(write, () => {
      this.#resolvedStepIds.add(stepId);
    });
  }

  /** Record an accepted completion. Answers the write untouched. */
  public recordCompleted(write: GrowthOutcome<void>): GrowthOutcome<void> {
    return this.#recordIfServed(write, () => {
      this.#hasCompleted = true;
    });
  }

  /**
   * The one place a mutation moves this ledger, and the one place it is guarded.
   *
   * A THROWN refusal never reaches here at all — `answerFromScriptedReply` rethrows a
   * scripted `refusal` verbatim, so the call site's `await` rejects and nothing is
   * recorded by construction. What this guard is for is the other refusal: an
   * `unavailable` outcome, which RESOLVES, and which a recorder that looked only at
   * whether the promise fulfilled would happily write down.
   */
  #recordIfServed(write: GrowthOutcome<void>, record: () => void): GrowthOutcome<void> {
    if (write.status === "served") {
      record();
    }
    return write;
  }
}

/**
 * The fixture's six onboarding answers for one running scenario.
 *
 * `Pick` over the port rather than a shape of its own, on `fixtureWorkflowReads`'
 * reason: a handler whose signature drifts from the operation it serves is a compile
 * error here rather than a surface rendering a value no daemon sends.
 *
 * The ledger is minted HERE and closed over, which is what makes it one per port. It is
 * deliberately not a parameter: a caller that could supply one could supply the same
 * one to two ports, and the windows would share a walkthrough.
 */
export function fixtureOnboardingAnswers(
  engine: ScenarioEngine,
): Pick<GrowthPort, FixtureServedOnboardingOperationId> {
  const ledger = new FixtureOnboardingLedger();
  return {
    onboardingStateRead: async (request) =>
      ledger.foldInto(
        await answerFromScriptedReply(
          engine,
          "growth:onboardingStateRead",
          "onboardingStateRead",
          request,
          // The one onboarding answer with an honest empty form. A node nobody has
          // onboarded has completed no step and is not complete — that is a state the
          // walkthrough draws on its own first frame, and it is the state a fresh
          // install is genuinely in, so serving it invents nothing. The ledger folds
          // over this arm too, which is what lets a scenario scripting no state read
          // still show a step a person has just recorded.
          () => ({ status: "served", value: { completedStepIds: [], isComplete: false } }),
        ),
      ),
    onboardingStepAdvance: async (request) =>
      ledger.recordStepResolved(
        request.stepId,
        await answerScriptOnly(
          engine,
          "growth:onboardingStepAdvance",
          "onboardingStepAdvance",
          request,
        ),
      ),
    onboardingStepSkip: async (request) =>
      ledger.recordStepResolved(
        request.stepId,
        await answerScriptOnly(engine, "growth:onboardingStepSkip", "onboardingStepSkip", request),
      ),
    onboardingComplete: async (request) =>
      ledger.recordCompleted(
        await answerScriptOnly(engine, "growth:onboardingComplete", "onboardingComplete", request),
      ),
    // The two writes that move nothing this fixture answers. Both prompts answer with
    // what a person typed in main's own window, so there is no state here for them to
    // record: what the script decides is only whether the call was accepted.
    onboardingPresentChoice: async (request) =>
      await answerScriptOnly(
        engine,
        "growth:onboardingPresentChoice",
        "onboardingPresentChoice",
        request,
      ),
    onboardingTelemetryPrompt: async (request) =>
      await answerScriptOnly(
        engine,
        "growth:onboardingTelemetryPrompt",
        "onboardingTelemetryPrompt",
        request,
      ),
  };
}
