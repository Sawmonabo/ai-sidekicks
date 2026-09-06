// The rules the shipped schemas do not carry, each read off the module that owns it.
//
// `SessionEventSchema` registers no payload variant for any run-lifecycle kind and
// none for any of the five queue kinds, so every rule about one of those payloads has
// to come from somewhere the contracts package does not reach. Where a module in this
// tree already owns the rule, it is READ rather than restated; where none does, the
// rule is written down here ONCE, sourced to the corpus row that fixes it, and this is
// the only place in the console that carries it:
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
//   • The registered payload of a run-lifecycle kind NO stream projects. Four of the
//     thirteen run rows reach a subscriber only through `session.subscribe` — the
//     creation row `run.queued` and the three forward, non-state rows
//     (`run.provider_initialized`, `run.turn_started`, `run.worker_shutdown`) — so
//     the projection leg below claims none of them, and the strict layer registers no
//     variant for them either. That left every member of those four payloads
//     unchecked: `run.queued` with no `runVersion` and no `newState`, and
//     `run.provider_initialized` with no `provider`, each passed every leg they met
//     and were then folded into a run entity built out of half a payload. This is the
//     leg that holds them, and its table is keyed by the census's `run.` root LESS
//     the kinds `session-event-streams.ts` puts on a narrowed stream — so a fifth
//     excluded kind is a compile error here rather than a hole nobody notices.
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

import { RunIdSchema, SessionIdSchema } from "@ai-sidekicks/contracts";
import type { SessionEventType } from "@ai-sidekicks/contracts";
import { z } from "zod";
import type { ZodType } from "zod";

import { describeSchemaIssue } from "./defect.js";
import { projectRunStreamDelivery } from "../../run-streams/index.js";
import type { ScenarioBeat } from "../../scenario-runtime/index.js";
import {
  RUN_STATE_EVENT_STREAM,
  runQueueStreamStateFor,
  runStateStreamArmFor,
  type RunStateStreamKind,
} from "../../daemon/index.js";

/**
 * What one beat gets wrong about the run or queue rule its kind is under, or
 * `undefined` when it gets nothing wrong.
 *
 * The four legs in the order the defects compound: a self-transition is a beat about
 * a move that never happens, a missing queue state is a row summarized from half its
 * own payload, an unprojected run payload is the registered shape of a kind no stream
 * carries, and the projection is the whole registered shape of one that does. Each
 * answers `undefined` for a kind it does not claim, so a beat under none of them
 * reaches the schema legs unremarked.
 *
 * The last two partition the `run.` root between them by construction — one claims
 * exactly the kinds `runStateStreamArmFor` names and the other exactly the kinds it
 * does not — so no run beat meets both and none meets neither.
 */
export function describeRunAndQueueSemanticsDefect(beat: ScenarioBeat): string | undefined {
  return (
    describeSelfTransitionDefect(beat) ??
    describeQueueStateDefect(beat) ??
    describeUnprojectedRunPayloadDefect(beat) ??
    describeRunStreamProjectionDefect(beat)
  );
}

/**
 * One kind of the census's run-lifecycle root.
 *
 * `Extract`ed from the shipped census rather than listed, on the same terms as the
 * two stream tables: the root is what the taxonomy registers under `run.`, and a
 * kind added there has to be decided here rather than silently admitted.
 */
type RunLifecycleKind = Extract<SessionEventType, `run.${string}`>;

/**
 * The run kinds NO narrowed stream projects — the complement, taken as a type.
 *
 * `RunStateStreamKind` is `session-event-streams.ts`'s own union of the kinds
 * `run.subscribeState` carries, so this subtraction is the routing table read
 * backwards and never a second list. It is what makes the payload table below TOTAL:
 * a run kind that leaves that stream lands here and fails to compile until its
 * registered payload is written down, and one that joins the stream leaves here and
 * fails to compile until its row is removed.
 */
type UnprojectedRunLifecycleKind = Exclude<RunLifecycleKind, RunStateStreamKind>;

/**
 * The run identity every run-lifecycle payload carries, whichever kind it is.
 *
 * `Spec-006 §Run Lifecycle (run_lifecycle)` puts `{sessionId, runId, runVersion}` at
 * the head of the shared state-transition shape and re-lists all three in each of the
 * three forward, non-state per-type shapes, so it is one fact stated once here rather
 * than three times below. The branded id schemas are the contract's own, imported;
 * `runVersion` takes the same `z.number().int().nonnegative()` the contracts package
 * applies to every run-progression counter it registers.
 */
const runIdentityShape = {
  sessionId: SessionIdSchema,
  runId: RunIdSchema,
  runVersion: z.number().int().nonnegative(),
};

/**
 * The registered payload of each run kind no stream projects.
 *
 * READ OFF `Spec-006 §Run Lifecycle (run_lifecycle)`, whose per-type rows are the
 * only place these four shapes exist: the contracts package registers a Zod variant
 * for none of them, and `RunStateChangeEventSchema` is deliberately the `run.subscribeState`
 * WIRE projection rather than the durable payload — that module says so in as many
 * words, and it requires a `previousState` the creation row has no value for.
 *
 * NOT `.strict()`, and the looseness is a claim rather than a shortcut. What the spec
 * fixes for these kinds is which members are REQUIRED; the creation row's optional set
 * is openly growing — the orchestration linkage fields, the three admission stamps,
 * the resolved run config — and it grew three times while this console was being
 * written. A strict schema would refuse beats the daemon does emit, which is the
 * opposite of this file's job. Refusing an INVENTED member is `beat-shape.ts`'s
 * strict-layer leg, and that leg reaches exactly the kinds the contracts package
 * registers a variant for — which is none of these four.
 */
const REGISTERED_UNPROJECTED_RUN_PAYLOADS: Readonly<Record<UnprojectedRunLifecycleKind, ZodType>> =
  Object.freeze({
    // The run's CREATION. `newState` is pinned to the state the kind announces, which
    // is the same kind-is-prefix-plus-state derivation the routing table rests on;
    // `previousState` is deliberately unconstrained here, because whether a creation
    // row may name one at all is the self-transition leg's business and the shared
    // shape's, not this one's.
    "run.queued": z.object({ ...runIdentityShape, newState: z.literal("queued") }),
    // `{sessionId, runId, runVersion, provider, model?}`.
    "run.provider_initialized": z.object({
      ...runIdentityShape,
      provider: z.string().min(1),
      model: z.string().optional(),
    }),
    // `{sessionId, runId, runVersion, position?}` — `position` in the normalized
    // session-position vocabulary, so a non-negative integer.
    "run.turn_started": z.object({
      ...runIdentityShape,
      position: z.number().int().nonnegative().optional(),
    }),
    // `{sessionId, runId, runVersion, reason?}` — the sanitized provider-supplied
    // shutdown reason.
    "run.worker_shutdown": z.object({ ...runIdentityShape, reason: z.string().optional() }),
  } satisfies Record<UnprojectedRunLifecycleKind, ZodType>);

/**
 * A run beat whose registered payload rejects it, or `undefined` for every other kind.
 *
 * The half of the run root the projection leg cannot reach. A `run.queued` beat
 * carrying nothing but `{sessionId, runId}` names a registered kind, composes into a
 * carrier the envelope accepts, and takes the strict layer's discriminator escape —
 * and then the run-lifecycle projector, which keys a run's existence on `runId` and
 * its state on `newState`, folds it into a run entity with no progression counter and
 * no state. Nothing refuses it anywhere, which is why the check has to be here.
 *
 */
function describeUnprojectedRunPayloadDefect(beat: ScenarioBeat): string | undefined {
  const registeredPayload = Object.hasOwn(REGISTERED_UNPROJECTED_RUN_PAYLOADS, beat.event.kind)
    ? REGISTERED_UNPROJECTED_RUN_PAYLOADS[beat.event.kind as UnprojectedRunLifecycleKind]
    : undefined;
  if (registeredPayload === undefined) {
    return undefined;
  }
  const parsed = registeredPayload.safeParse(beat.event.payload ?? {});
  if (parsed.success) {
    return undefined;
  }
  return (
    `the registered "${beat.event.kind}" payload rejects this beat, and no narrowed stream ` +
    "projects this kind — so nothing downstream would refuse it either, and a surface would " +
    `read a run built out of half a payload: ${parsed.error.issues.map(describeSchemaIssue).join("; ")}.`
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
