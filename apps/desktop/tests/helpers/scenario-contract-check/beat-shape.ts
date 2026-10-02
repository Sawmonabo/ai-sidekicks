// Is this beat a wire event at all, and does the shape registered for it accept its payload?
//
// `@ai-sidekicks/contracts` ships three schemas and every beat meets all three:
//
// - `SESSION_EVENT_CATEGORY_BY_TYPE`, the census. A `kind` that is not a key is a type no daemon
//   emits. This catches an invented name: `run.started` reads like a real event and is not one
//   (`run.starting` is).
// - `EventEnvelopeSchema`, the version-tolerant carrier the app's decode boundary parses each
//   delivery with (`services/daemon/session-event-payload.ts`). A beat that fails here would be
//   counted as an unreadable delivery and dropped.
// - `SessionEventSchema`, the strict layer. It registers a payload variant for some types, and
//   where one exists the beat must satisfy it. This catches an invented member: `session.created`
//   carrying `{title}` names a real type with a payload the schema rejects.
//
// The strict layer is declared per event, not per payload, so the probe is a whole envelope. It is
// composed by `services/daemon/event-envelope.fixture.ts`, the function the fixture daemon
// delivers through, so this check validates the record a subscriber actually receives.
//
// A Zod discriminated union that matches no branch reports a single issue at `path: ["type"]`,
// while a branch it did enter reports issues inside that branch. A failure whose every issue is
// on the discriminator therefore means the strict layer registers nothing for this kind yet, and
// the beat is held to the other legs. That escape is scoped: `run-and-queue-semantics.ts` covers
// the `run.` root and the `queue_item.` root between four legs, each keyed off a table declared
// `satisfies Record<<census-derived union>, ...>`, so a run or queue kind cannot fall into the
// escape by being forgotten; it would have to leave both its stream and the excluded-payload
// table, and each is a compile error in its own module.

import {
  EventEnvelopeSchema,
  SESSION_EVENT_CATEGORY_BY_TYPE,
  SessionEventSchema,
  type SessionEventType,
} from "@ai-sidekicks/contracts";

import { describeSchemaIssue } from "./scenario-contract-defect.js";
import { describeRunAndQueueSemanticsDefect } from "./run-and-queue-semantics.js";
import { composeScenarioEventEnvelope } from "@renderer/services/daemon/event-envelope.fixture.js";
import type { ScenarioBeat } from "../../../fixtures/scenario.js";

/** What is wrong with one beat, or `undefined` when the wire could have emitted it. */
export function describeBeatDefect(beat: ScenarioBeat): string | undefined {
  if (SESSION_EVENT_CATEGORY_BY_TYPE.get(beat.event.kind as SessionEventType) === undefined) {
    // First and apart from the parses, since its remedy is a name; either schema would report a
    // missing category or unmatched discriminator that says nothing about the intended kind.
    return (
      `"${beat.event.kind}" is not a registered event type, so no daemon emits it. ` +
      "Script the registered type this beat means instead — the census is " +
      "`SESSION_EVENT_CATEGORY_BY_TYPE` in `packages/contracts/src/event.ts`."
    );
  }
  const semantics = describeRunAndQueueSemanticsDefect(beat);
  if (semantics !== undefined) {
    return semantics;
  }
  const envelope = composeScenarioEventEnvelope(beat.event);
  const carried = EventEnvelopeSchema.safeParse(envelope);
  if (!carried.success) {
    return (
      "the canonical envelope rejects this beat, so the app's decode boundary " +
      `would count it unreadable and drop it: ${carried.error.issues.map(describeSchemaIssue).join("; ")}.`
    );
  }
  const parsed = SessionEventSchema.safeParse(envelope);
  if (parsed.success) {
    return undefined;
  }
  if (parsed.error.issues.every((issue) => issue.path[0] === "type")) {
    // No strict variant is registered for this kind yet; every other leg has already passed.
    return undefined;
  }
  return (
    `the registered "${beat.event.kind}" shape rejects this beat: ` +
    `${parsed.error.issues.map(describeSchemaIssue).join("; ")}.`
  );
}
