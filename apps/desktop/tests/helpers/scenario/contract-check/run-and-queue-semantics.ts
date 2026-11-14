// The run rules the generated checks do not carry, each read off the module that owns it. Every
// registered type's payload, the queue rows' `state` and the run rows' among them, is held by the
// strict session event check (`beat/shape.ts`), so no leg here repeats it.
//
// - The run state machine's transition table: a self-transition passes every check.
// - The projection `projection.fixture.ts` delivers to a `run.subscribeState` subscriber, called
//   rather than copied.

import { projectRunStateStreamDelivery } from "#renderer/services/run-streams/projection.fixture.js";
import type { ScenarioBeat } from "#fixtures/scenario.js";
import { RUN_STATE_EVENT_STREAM } from "#shared/daemon/streams.js";
import { runStateStreamArmFor } from "#renderer/services/daemon/session/event/stream-kinds.js";

/**
 * What one beat gets wrong about the run rule its kind is under, or `undefined`.
 *
 * Two legs in the order the defects compound: a self-transition, then the stream projection. Each
 * answers `undefined` for a kind it does not claim.
 */
export function describeRunAndQueueSemanticsDefect(beat: ScenarioBeat): string | undefined {
  return describeSelfTransitionDefect(beat) ?? describeRunStreamProjectionDefect(beat);
}

/**
 * A beat claiming a run moved from a state to itself, or `undefined` when it claims no such thing.
 *
 * The run state machine has no row whose `From` and `To` are the same state, so no daemon emits
 * one, yet it reads as real: both values are registered and no payload check catches it. A view
 * built against it learns to render a transition that never happens. Keyed on the two payload
 * members rather than the kind, so it holds for any run row a later taxonomy registers.
 */
function describeSelfTransitionDefect(beat: ScenarioBeat): string | undefined {
  const payload = beat.event.payload;
  if (payload === undefined) {
    return undefined;
  }
  const previousState = payload["previousState"];
  if (previousState === undefined || previousState !== payload["newState"]) {
    return undefined;
  }
  return (
    `this beat names "${String(previousState)}" as both \`previousState\` and \`newState\`, ` +
    "so it claims a run transitioned to the state it was already in. The run state " +
    "machine's transition table has no such row, so no daemon emits one — script the " +
    "transition this beat means, or, for a run being created, name the state it is in " +
    "and no state it came from."
  );
}

/**
 * A run-lifecycle beat the stream that carries it cannot project, or `undefined` when the
 * projection builds a delivery out of it.
 *
 * `projection.fixture.ts` owns the complete registered shape: it checks the candidate with the
 * generated check for the arm (`validateRunStateChangeEvent` or `validateAgentRunRolledBackEvent`)
 * and cross-checks the kind against the announced state and the envelope's session against the
 * payload's. Calling it rather than copying a fragment keeps a scenario from passing here and
 * failing one stream later; its refusal is reported in its own words.
 *
 * Scoped by `runStateStreamArmFor` rather than a kind list: `agent.run.queued` (delivered by
 * `session.subscribe`) and the forward rows have no registered projection.
 */
function describeRunStreamProjectionDefect(beat: ScenarioBeat): string | undefined {
  if (runStateStreamArmFor(beat.event.kind) === undefined) {
    return undefined;
  }
  const projected = projectRunStateStreamDelivery(beat.event);
  if (projected.status === "projected") {
    return undefined;
  }
  return (
    `the \`${RUN_STATE_EVENT_STREAM}\` projection refuses this beat, so the stream that ` +
    `carries it would deliver nothing for it: ${projected.detail}`
  );
}
