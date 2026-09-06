// Is this beat a wire event at all, and does the shape registered for it accept the
// payload it carries?
//
// `packages/contracts/src/event.ts` ships three schemas a scenario is measured
// against, and every beat meets all three:
//
//   • `SESSION_EVENT_CATEGORY_BY_TYPE` — the census. Its keys are every event type
//     the taxonomy registers, so a `kind` that is not a key is a type no daemon
//     emits. This is the leg that catches an invented name: `run.started` reads
//     exactly like a real event and is not one (`run.starting` is), and a fixture
//     that plays it produces frames, screenshots, and end-to-end results about a
//     wire that does not exist.
//   • `EventEnvelopeSchema` — the version-tolerant carrier. It fixes the canonical
//     membership for EVERY kind, registered payload variant or not, and it is the
//     schema the console's own decode boundary parses each delivery with
//     (`bridge/daemon/session-event-payload.ts`). This is the leg that says the fixture can
//     deliver this beat at all: a beat that fails here is one the console would
//     count as an unreadable delivery and drop, which in a fixture reads as a
//     scenario that plays a beat nothing renders.
//   • `SessionEventSchema` — the strict layer. It registers a payload variant for
//     some of those types and not others, so where one exists the beat has to
//     satisfy it. This is the leg that catches an invented MEMBER, which is the
//     quieter defect: `session.created` carrying `{title}` names a real event type
//     and a payload the schema rejects outright, and nothing renders differently
//     until the day the console reads the payload.
//
// WHY THE PROBE IS A WHOLE ENVELOPE, AND WHOSE ENVELOPE IT IS. The strict layer is
// declared per EVENT, not per payload — there is no exported payload-only schema to
// reach for, and the one place the two are paired is inside the discriminated union.
// So the check presents each beat as the wire event it claims to be. It does not
// compose that envelope itself: `../../scenario-runtime/scenario-envelope.ts` composes it, and that is
// the same function `fixture-bridge.ts` delivers through. Two compositions would be
// two answers to "what does this beat travel as", and this check would then be
// validating a record no subscriber ever receives — which is the shape of the defect
// that made the console's decode boundary and the fixture agree with each other and
// with nothing the daemon sends.
//
// HOW "NO VARIANT REGISTERED" IS TOLD FROM "VARIANT REJECTED THE BEAT". A Zod
// discriminated union that matches no branch never enters one: it reports a single
// issue at `path: ["type"]` and nothing else. A branch it DID enter reports issues
// inside that branch, under `payload` or beside it. So a failure whose every issue
// sits on the discriminator means the strict layer registers nothing for this kind
// — Plan-006 registers sixteen of the census's types today and the rest arrive with
// their owning plans — and the beat is held to the legs that do not need one. Any
// other failure is the beat's.
//
// AND WHAT THAT ESCAPE IS NOW SCOPED TO. It no longer means "held to the census and
// nothing else": it means "held to whatever OTHER registered shape exists for this
// kind", and the set of kinds for which there is none is DERIVED rather than listed.
// `run-and-queue-semantics.ts` covers the whole `run.` root and the `queue_item.`
// root between three of its legs, each keyed off a table declared
// `satisfies Record<<census-derived union>, …>` so its key set is a compile-time
// fact. The nine kinds a narrowed stream projects are held to that projection; the
// four the streams leave out — the creation row and the three forward, non-state rows
// — are held to their own registered payloads; the five queue kinds are held to the
// member their payload requires. A run-lifecycle or queue kind therefore cannot fall
// into the escape by being forgotten there: it would have to leave the stream that
// carries it AND leave the excluded-payload table, and each is a compile error in its
// own module.

import {
  EventEnvelopeSchema,
  SESSION_EVENT_CATEGORY_BY_TYPE,
  SessionEventSchema,
  type SessionEventType,
} from "@ai-sidekicks/contracts";

import { describeSchemaIssue } from "./defect.js";
import { describeRunAndQueueSemanticsDefect } from "./run-and-queue-semantics.js";
import { composeScenarioEventEnvelope } from "../../scenario-runtime/index.js";
import type { ScenarioBeat } from "../../scenario-runtime/index.js";

/** What is wrong with one beat, or `undefined` when the wire could have emitted it. */
export function describeBeatDefect(beat: ScenarioBeat): string | undefined {
  if (SESSION_EVENT_CATEGORY_BY_TYPE.get(beat.event.kind as SessionEventType) === undefined) {
    // First, and separately from the two parses, because it is the one defect
    // whose remedy is a NAME. Reported by either schema it would surface as a
    // missing category or an unmatched discriminator, which says nothing about the
    // kind the author meant to script.
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
      "the canonical envelope rejects this beat, so the console's decode boundary " +
      `would count it unreadable and drop it: ${carried.error.issues.map(describeSchemaIssue).join("; ")}.`
    );
  }
  const parsed = SessionEventSchema.safeParse(envelope);
  if (parsed.success) {
    return undefined;
  }
  if (parsed.error.issues.every((issue) => issue.path[0] === "type")) {
    // The strict layer registers no variant for this kind yet. The census leg, the
    // semantics legs, and the carrier have all passed already, which is the whole of
    // what can be checked for such a kind.
    return undefined;
  }
  return (
    `the registered "${beat.event.kind}" shape rejects this beat: ` +
    `${parsed.error.issues.map(describeSchemaIssue).join("; ")}.`
  );
}
