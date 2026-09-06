// The runtime-node roster, answered from the scenario the fixture is playing.
//
// WHY IT IS HERE. `index.ts` beside this file states the rule: a module that exists so
// the fixture can ANSWER something belongs in this directory, and a roster is the first
// example that header gives. Declared beside the seam's vocabulary instead, this read
// was the only thing under `bridge/runtime-nodes/` that reached `scenario-runtime/` at
// all — so the feed directory carried an edge into the scripting engine for one
// function, and the reason it gave for not being `daemon/` was manufactured by that
// edge rather than by the feed it folds.
//
// WHAT IT TAKES FROM THE SEAM, AND WHAT IT DECLARES ITSELF. The outcome shape both arms
// answer with and the one constructor that stamps this seam's `origin` come through
// `runtime-nodes/index.js`; the refusal codes are the FIXTURE's own and are declared
// here, beside the arm that raises them. The live arms are
// `runtime-nodes/runtime-node-roster-transport.ts`, and neither arm can invent a name
// the other does not know, because both refuse through `runtimeNodeRefusal`.

import type { RuntimeNodeRosterRequest } from "@ai-sidekicks/contracts";

import {
  runtimeNodeRefusal,
  type RuntimeNodeRefused,
  type RuntimeNodeRosterOutcome,
} from "../runtime-nodes/index.js";
import type { ScenarioEngine, ScenarioRuntimeNodeRosterFrame } from "../scenario-runtime/index.js";

/**
 * The codes this arm raises. Both are facts about the scenario.
 *
 * Kept apart from `RUNTIME_NODE_ROSTER_WIRE_REFUSAL_CODES`, which the transport module
 * declares, rather than pooled with it: each set is TOTAL for the arm that raises it
 * and the two arms are driven by different suites. Pooled, neither census could claim
 * every code it declares is reachable, and a code nothing raises is exactly the drift a
 * census exists to catch.
 */
export const RUNTIME_NODE_ROSTER_SCENARIO_REFUSAL_CODES: readonly [
  "roster-unscripted",
  "session-not-played",
] = ["roster-unscripted", "session-not-played"];

/**
 * Read the roster from the scenario the fixture is playing. The fixture arm.
 *
 * Three answers, and the two refusals are different facts a surface draws
 * differently. A scenario that names no roster has not been asked — the honest
 * "not checked" absence, which is what a fixture build of a page whose data nobody
 * scripted must show. A request naming a session this scenario is not playing takes
 * the same refusal rather than this session's nodes: a roster is a fact about ONE
 * session's attachments, and lending another session's machines to it would be a
 * fabrication the surface would render as confidently as a reading.
 *
 * An EMPTY node set is NOT one of those: the registered response admits an empty
 * array — a session with no attachments yet — so a scenario that names a roster
 * with no rows has been asked and answered, and the surface draws its empty state.
 */
export function readRuntimeNodeRosterFromScenario(
  engine: ScenarioEngine,
  request: RuntimeNodeRosterRequest,
): RuntimeNodeRosterOutcome {
  const { scenario } = engine;
  if (request.sessionId !== scenario.sessionId) {
    return refusedByScenario(
      "session-not-played",
      `Not checked — scenario "${scenario.id}" plays session ${scenario.sessionId} and holds no roster for the session this read names.`,
    );
  }
  const frames = scenario.runtimeNodeRoster;
  const current = frames === undefined ? undefined : frameDueAt(frames, engine.progress.elapsedMs);
  if (current === undefined) {
    return refusedByScenario(
      "roster-unscripted",
      `Not checked — scenario "${scenario.id}" names no runtime-node roster at this tick. Add one to the scenario rather than letting the surface render an empty roster for a read that was never answered.`,
    );
  }
  // Copied out rather than handed over: `RuntimeNodeRosterResponse.nodes` is a
  // mutable array on the wire type, and a caller that sorted it in place would be
  // reordering the scenario itself for every later read in the window.
  return { status: "served", value: { nodes: [...current.nodes] } };
}

/** The roster reading current at `elapsedMs`, or `undefined` before the first. */
function frameDueAt(
  frames: readonly ScenarioRuntimeNodeRosterFrame[],
  elapsedMs: number,
): ScenarioRuntimeNodeRosterFrame | undefined {
  // Selected by the LATEST `atMs` that has fallen due, not by array position. Frames
  // are readings of one roster over scenario time, so the newest due one is current —
  // and a fold that kept the last MATCHING entry said that only while the literal
  // happened to be sorted ascending, which nothing states, asserts, or enforces. A
  // family appending a late frame above an earlier one would have got a silently stale
  // roster for every read past both ticks, with no gate reporting it.
  //
  // `>=` rather than `>`, so two frames claiming one instant resolve to the later
  // DECLARATION — the only thing that distinguishes two readings of one tick, and the
  // answer the previous fold gave for the sorted case it happened to be right about.
  return frames.reduce<ScenarioRuntimeNodeRosterFrame | undefined>(
    (current, frame) =>
      frame.atMs <= elapsedMs && (current === undefined || frame.atMs >= current.atMs)
        ? frame
        : current,
    undefined,
  );
}

/**
 * The refusal this arm raises, held to its own closed vocabulary.
 *
 * Two doors rather than one widened builder, on the growth port's pattern: the two
 * refusals are reached from opposite sides. This one's code is a fact about the
 * scenario and belongs to the set declared above, so passing a wire code through it is
 * a compile error rather than a convention.
 */
function refusedByScenario(
  code: (typeof RUNTIME_NODE_ROSTER_SCENARIO_REFUSAL_CODES)[number],
  detail: string,
): RuntimeNodeRefused {
  return runtimeNodeRefusal(code, detail);
}
