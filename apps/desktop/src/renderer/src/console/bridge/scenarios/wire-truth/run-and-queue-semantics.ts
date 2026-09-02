// The rules the shipped schemas do not carry, each read off the module that owns it.
//
// `SessionEventSchema` registers no payload variant for any run-lifecycle kind and
// none for any of the five queue kinds, so every rule about one of those payloads has
// to come from somewhere the contracts package does not reach. None of them is
// restated here:
//
//   • The run state machine's transition table. This is the leg that catches a beat
//     whose members are each individually registered and whose combination is not:
//     `previousState` equal to `newState` is a self-transition, and the table
//     defines one for no state. It is checked here rather than by either schema
//     layer because neither can see it — the census knows kinds, the strict layer
//     registers no variant for the run-lifecycle kinds at all, and the machine is
//     prose in `docs/domain/run-state-machine.md`.
//   • The queue payload's own required member. The five `queue_item.*` kinds are
//     census-only in the strict layer too, so a beat that omits `state` — which
//     `Spec-006 §Queue Events` makes required — passes all three schema legs. This
//     is the leg that refuses it, on the same terms as the transition table: a rule
//     the shipped schemas do not carry, checked against the one module that owns
//     the mapping rather than against a second reading of it here.
//   • The projection the run-lifecycle stream delivers. The strict layer registers no
//     variant for ANY run-lifecycle kind, so every rule about one of those payloads
//     has to come from somewhere other than those schemas — and there is exactly
//     one place it already lives in full: `run-stream-projection.ts`, which is what
//     the fixture runs to build the `RunStateChangeEvent` or `RunRolledBackEvent` a
//     `run.subscribeState` subscriber receives. This leg calls that projection and
//     reports its refusal. It is not a second reading of the run payloads; it is the
//     first one, borrowed. What it catches: a beat carrying `{newState: "starting"}`
//     and nothing else names a registered kind, announces a registered state, and
//     passes every leg it meets — while the fixture refuses it at delivery as
//     unprojectable for want of `sessionId`, `runId`, `runVersion`, and
//     `previousState`, and the run-lifecycle projector, which yields no mutation for
//     a payload naming no `runId`, drops it too. Green gate, nothing on screen, on
//     both consumers at once. Two narrower legs used to stand here — one for the
//     state the kind announces, one for the rollback payload's own session — and each
//     was a partial copy of a rule that module owned whole. A partial copy is exactly
//     what lets a scenario pass this predicate and fail at delivery, so both are
//     retired into the call.
//
// WHY THE QUEUE LEG IS NOT THE SAME CALL. The queue arm of that module projects a
// `QueueItemSummary`, which carries `priority` and `createdAt` — row members no queue
// EVENT carries, sourced from the scenario's own `run.queueList` reply. Routing the
// queue kinds through it would make this predicate refuse every scenario that scripts
// a queue beat without also scripting that reply, which is a claim about a scenario's
// replies rather than about a beat. The beat-scoped half of the queue rule is the
// queue leg here; the row-read half is the delivery tier's
// (`test/console/architecture/scenario-delivery-shape.test.ts`), where a scenario is
// actually played.

import { projectRunStreamDelivery } from "../../run-stream-projection.js";
import type { ScenarioBeat } from "../../scenario.js";
import {
  RUN_STATE_EVENT_STREAM,
  runQueueStreamStateFor,
  runStateStreamArmFor,
} from "../../session-event-streams.js";

/**
 * What one beat gets wrong about the run or queue rule its kind is under, or
 * `undefined` when it gets nothing wrong.
 *
 * The three legs in the order the defects compound: a self-transition is a beat about
 * a move that never happens, a missing queue state is a row summarized from half its
 * own payload, and the projection is the whole registered shape. Each answers
 * `undefined` for a kind it does not claim, so a beat under none of them reaches the
 * schema legs unremarked.
 */
export function describeRunAndQueueSemanticsDefect(beat: ScenarioBeat): string | undefined {
  return (
    describeSelfTransitionDefect(beat) ??
    describeQueueStateDefect(beat) ??
    describeRunStreamProjectionDefect(beat)
  );
}

/**
 * A beat claiming a run moved from a state to itself, or `undefined` when it claims
 * no such thing.
 *
 * A rule the strict layer cannot enforce and the census cannot see. The state
 * machine (`docs/domain/run-state-machine.md` §Complete Transition Table — its own
 * "single authoritative reference for every allowed run state transition") has no
 * row whose `From` and `To` are the same state, so a self-transition is an event no
 * daemon produces. It reads as a real one, though: both values are registered
 * members of the vocabulary, the payload variant that would have caught it is not
 * registered for the run-lifecycle kinds, and a surface built against such a beat
 * learns to render or count a transition that never happens in production.
 *
 * Deliberately keyed on the two payload members rather than on the event kind, so it
 * holds for every family's scenario and for any run row a later taxonomy registers.
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
 * A queue beat that names no state, or names one its kind contradicts.
 *
 * `Spec-006 §Queue Events` fixes the queue payload at
 * `{sessionId, queueItemId, channelId?, state}`, and `SessionEventSchema`
 * registers no variant for any of the five `queue_item.*` kinds — so `state` is
 * required by the corpus and enforced by nothing the contracts package ships. A
 * beat without it reads as a real queue event, and the queue stream's projection
 * would then have to take the row's state from the KIND alone, which is a summary
 * derived from half its own payload.
 *
 * The kind-to-state mapping is `session-event-streams.ts`'s, read here rather than
 * restated: that module is what routes these beats onto the queue stream in the
 * first place, and a second copy of the table would let a scenario pass this leg
 * and fail the projection that consumes it. A kind it does not claim is not a queue
 * beat and is not this leg's business.
 */
function describeQueueStateDefect(beat: ScenarioBeat): string | undefined {
  const announcedState = runQueueStreamStateFor(beat.event.kind);
  if (announcedState === undefined) {
    return undefined;
  }
  const statedState = beat.event.payload?.["state"];
  if (statedState === undefined) {
    return (
      "this beat names no `state`, which is a required member of every queue payload " +
      "the daemon emits. Name the state this row moved to — " +
      `\`"${announcedState}"\`, which is what its kind announces.`
    );
  }
  if (statedState !== announcedState) {
    return (
      `this beat announces "${announcedState}" by its kind and ` +
      `${JSON.stringify(statedState)} in its payload, so it reports two queue states at ` +
      "once. One of the two is the row this beat means; script that one."
    );
  }
  return undefined;
}

/**
 * A run-lifecycle beat the stream that carries it cannot project, or `undefined`
 * when the projection builds a delivery out of it.
 *
 * THE COMPLETE REGISTERED SHAPE, AND ONLY ONE READING OF IT. `SessionEventSchema`
 * registers no payload variant for any run-lifecycle kind, so a `run.starting` beat
 * carrying `{newState: "starting"}` and nothing else passes the census, passes the
 * canonical envelope, and takes the strict layer's discriminator escape. What it does
 * not pass is delivery: `run-stream-projection.ts` refuses it as unprojectable for
 * want of `sessionId`, `runId`, `runVersion`, and `previousState`, and the
 * run-lifecycle projector yields no mutation for a payload naming no `runId`. Both
 * consumers render nothing while this predicate stays green, which is the one outcome
 * it exists to prevent.
 *
 * THE RULE IS THAT MODULE'S, CALLED RATHER THAN COPIED. It composes the candidate the
 * fixture composes, parses it through the shape the corpus registers for the arm
 * (`RunStateChangeEventSchema` or `RunRolledBackEventSchema`), and makes the two
 * cross-checks no schema can — the kind against the state the payload names, and the
 * envelope's session against the payload's — so the beats admitted here are exactly
 * the beats a subscriber can be handed. Two narrower legs stood in this place before,
 * one for the announced state and one for the rollback payload's session, and each
 * restated a fragment of a rule that module owned whole. A fragment is what lets a
 * scenario pass this predicate and fail one stream later, which is the shape of defect
 * this whole file was written against.
 *
 * Scoped by the routing table rather than by a kind list, exactly as the queue leg
 * above is: `runStateStreamArmFor` is what decides a beat reaches `run.subscribeState`
 * at all, so a kind it does not claim has no registered projection to be held to.
 * Those are the creation row `run.queued`, whose subscriber is `session.subscribe`,
 * and the three forward, non-state run rows — each held to the legs that need no
 * registered variant.
 *
 * The refusal is reported in the projection's own words. It already names the beat,
 * the member, and what to script instead, and rephrasing it here would be a second
 * voice for one rule and a second thing to keep in step with the delivery path.
 */
function describeRunStreamProjectionDefect(beat: ScenarioBeat): string | undefined {
  if (runStateStreamArmFor(beat.event.kind) === undefined) {
    return undefined;
  }
  // The subscription name is the registered constant this module and the projection
  // both read, so the `undefined` arm — "this subscription registers no projection" —
  // is unreachable from here. It is handled rather than asserted away because the one
  // way to reach it is those two readings drifting apart, and an assertion would turn
  // that into a thrown fixture error where every other defect is a reported one.
  const projected = projectRunStreamDelivery(RUN_STATE_EVENT_STREAM, beat.event);
  if (projected === undefined || projected.status === "projected") {
    return undefined;
  }
  return (
    `the \`${RUN_STATE_EVENT_STREAM}\` projection refuses this beat, so the stream that ` +
    `carries it would deliver nothing for it: ${projected.detail}`
  );
}
