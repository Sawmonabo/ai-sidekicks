// The session's live activity, answered from the scenario the fixture is playing.
//
// WHY IT IS HERE. `index.ts` beside this file states the rule: a module that exists
// so the fixture can ANSWER something belongs in this directory. This is the roster
// read's shape applied to a faster-moving fact — frames over scenario time, resolved
// by the latest one that has fallen due — and it deliberately shares that module's
// selection rule rather than restating it, because the two make one claim: a frame
// table is a sequence of READINGS and the newest due one is current.
//
// THREE ANSWERS, AND THE TWO REFUSALS ARE DIFFERENT FACTS FROM AN EMPTY ONE. A
// scenario that names no activity has not been asked; a request naming a session this
// scenario is not playing takes a refusal too rather than this session's readings,
// because activity is a fact about ONE session's Awareness room and lending another's
// would be a fabrication the indicators would render as confidently as a reading. An
// EMPTY reading is neither: a scenario that states a frame with both lists empty has
// been asked and answered, and the indicators render nothing — which is their
// ordinary state and the one `TypingActivity` returns `null` for.
//
// THE TWO REFUSALS CARRY DIFFERENT CODES, AND THAT IS THE POINT. A scenario that
// declares no frames has a gap in the SCRIPT — this fixture stands in for the wire
// perfectly well — so it takes `growthUnscriptedReply`, and a reader is sent to the
// scenario rather than to a document owing a wire that already has a stand-in. A
// request naming another session is not a gap in anything: this fixture is playing
// one room and is being asked about a different one, which no scenario could fix, so
// it names the unbuilt wire the live bridge would name.

import {
  growthUnavailable,
  growthUnscriptedReply,
  type GrowthOutcome,
} from "../growth-port/index.js";
import type { GrowthActivitySnapshot } from "../growth-values/index.js";
import type { ScenarioActivityFrame, ScenarioEngine } from "../scenario-runtime/index.js";

/** Read the session's live activity from the scenario. The fixture arm. */
export function readActivityFromScenario(
  engine: ScenarioEngine,
  request: { readonly sessionId: string },
): GrowthOutcome<GrowthActivitySnapshot> {
  const { scenario } = engine;
  if (request.sessionId !== scenario.sessionId) {
    return growthUnavailable("presenceActivityRead");
  }
  const frames = scenario.activity;
  const current =
    frames === undefined ? undefined : activityFrameDueAt(frames, engine.progress.elapsedMs);
  if (current === undefined) {
    return growthUnscriptedReply("presenceActivityRead", "the session's live activity");
  }
  return { status: "served", value: current.activity };
}

/**
 * The activity reading current at `elapsedMs`, or `undefined` before the first.
 *
 * Selected by the LATEST `atMs` that has fallen due rather than by array position,
 * and `>=` on the tie so two frames claiming one instant resolve to the later
 * DECLARATION. Both halves are the runtime-node roster's rule, and both are here for
 * its reason: nothing states, asserts, or enforces that a scenario's frame literal is
 * sorted, so a family appending a late frame above an earlier one would otherwise get
 * a silently stale reading for every tick past both.
 */
function activityFrameDueAt(
  frames: readonly ScenarioActivityFrame[],
  elapsedMs: number,
): ScenarioActivityFrame | undefined {
  return frames.reduce<ScenarioActivityFrame | undefined>(
    (current, frame) =>
      frame.atMs <= elapsedMs && (current === undefined || frame.atMs >= current.atMs)
        ? frame
        : current,
    undefined,
  );
}
