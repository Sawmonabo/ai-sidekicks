// Is this beat a wire event at all, and does the shape registered for it accept its payload?
//
// `@ai-sidekicks/contracts` ships three checks and every beat meets all three:
//
// - `SESSION_EVENT_CATEGORY_BY_TYPE`, the census. A `kind` that is not a key is a type no daemon
//   emits. This catches an invented name: `agent.run.started` reads like a real event and is not
//   one (`agent.run.starting` is).
// - `validateEventEnvelope`, the version-tolerant carrier every delivered event takes. A beat
//   that fails here is a record no daemon sends, which the app would read as typed regardless.
// - `validateSessionEvent`, the strict layer, which registers a payload for every type in the
//   census. This catches an invented member: `session.created` carrying `{title}` names a real
//   type with a payload the check refuses.
//
// The envelope is composed by `services/daemon/event/envelope.fixture.ts`, the function the fixture
// daemon delivers through, so this check reads the record a subscriber actually receives.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts/event/category-by-type";
import { validateEventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import { validateSessionEvent } from "@ai-sidekicks/contracts/event/session";

import { describeCheckFaults } from "../defect.js";
import { describeRunAndQueueSemanticsDefect } from "../run-and-queue-semantics.js";
import { composeScenarioEventEnvelope } from "#renderer/services/daemon/event/envelope.fixture.js";
import type { ScenarioBeat } from "#fixtures/scenario.js";

/** What is wrong with one beat, or `undefined` when the wire could have emitted it. */
export function describeBeatDefect(beat: ScenarioBeat): string | undefined {
  if (SESSION_EVENT_CATEGORY_BY_TYPE.get(beat.event.kind as SessionEventType) === undefined) {
    // First and apart from the checks, since its remedy is a name; either check would report a
    // missing category or unmatched type that says nothing about the intended kind.
    return (
      `"${beat.event.kind}" is not a registered event type, so no daemon emits it. ` +
      "Script the registered type this beat means instead — the census is " +
      "`SESSION_EVENT_CATEGORY_BY_TYPE` in `packages/contracts/src/event/category-by-type.ts`."
    );
  }
  const semantics = describeRunAndQueueSemanticsDefect(beat);
  if (semantics !== undefined) {
    return semantics;
  }
  const envelope = composeScenarioEventEnvelope(beat.event);
  if (!validateEventEnvelope(envelope)) {
    return (
      "the canonical envelope refuses this beat, so no daemon would send it: " +
      `${describeCheckFaults(validateEventEnvelope)}.`
    );
  }
  if (validateSessionEvent({ type: envelope.type, payload: envelope.payload })) {
    return undefined;
  }
  return (
    `the registered "${beat.event.kind}" shape refuses this beat: ` +
    `${describeCheckFaults(validateSessionEvent)}.`
  );
}
