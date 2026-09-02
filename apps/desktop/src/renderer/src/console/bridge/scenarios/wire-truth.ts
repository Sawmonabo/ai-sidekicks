// Does a scenario script events the daemon can actually emit?
//
// NOT a family scenario, despite living beside them. `scenarios/index.ts` is the
// seat board six family branches each add one line to; this is the predicate that
// reads whatever ends up on it. It sits here rather than in the test tier because
// a test that reimplemented the rule would be checking its own copy of it, and
// because the rule has to be one function for every family's scenario file to be
// held to it — a family that lands `bridge/scenarios/<family>.ts` with the same
// defects the substrate's own two scenarios shipped with must fail, and it does,
// without that family or its reviewer having to know this module exists.
//
// WHAT WIRE TRUTH IS HERE. `packages/contracts/src/event.ts` ships three schemas a
// scenario is measured against, and every beat meets all three — then the rules those
// schemas do not carry, because the run state machine is prose in `docs/domain/` and
// the run-lifecycle payloads have no registered variant at all. Not one of the latter
// is restated here: each is read off the single module in this tree that already owns
// it, so a beat this predicate admits is a beat the consumer of that rule admits too:
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
//     (`frame/session-event-payload.ts`). This is the leg that says the fixture can
//     deliver this beat at all: a beat that fails here is one the console would
//     count as an unreadable delivery and drop, which in a fixture reads as a
//     scenario that plays a beat nothing renders.
//   • `SessionEventSchema` — the strict layer. It registers a payload variant for
//     some of those types and not others, so where one exists the beat has to
//     satisfy it. This is the leg that catches an invented MEMBER, which is the
//     quieter defect: `session.created` carrying `{title}` names a real event type
//     and a payload the schema rejects outright, and nothing renders differently
//     until the day the console reads the payload.
//   • The run state machine's transition table. This is the leg that catches a beat
//     whose members are each individually registered and whose combination is not:
//     `previousState` equal to `newState` is a self-transition, and the table
//     defines one for no state. It is checked here rather than by either layer
//     above because neither can see it — the census knows kinds, the strict layer
//     registers no variant for the run-lifecycle kinds at all, and the machine is
//     prose in `docs/domain/run-state-machine.md`.
//   • The queue payload's own required member. The five `queue_item.*` kinds are
//     census-only in the strict layer too, so a beat that omits `state` — which
//     `Spec-006 §Queue Events` makes required — passes all three legs above. This
//     is the leg that refuses it, on the same terms as the transition table: a rule
//     the shipped schemas do not carry, checked against the one module that owns
//     the mapping rather than against a second reading of it here.
//   • The projection the run-lifecycle stream delivers. The strict layer registers no
//     variant for ANY run-lifecycle kind, so every rule about one of those payloads
//     has to come from somewhere other than the schemas above — and there is exactly
//     one place it already lives in full: `run-stream-projection.ts`, which is what
//     the fixture runs to build the `RunStateChangeEvent` or `RunRolledBackEvent` a
//     `run.subscribeState` subscriber receives. This leg calls that projection and
//     reports its refusal. It is not a second reading of the run payloads; it is the
//     first one, borrowed. What it catches: a beat carrying `{newState: "starting"}`
//     and nothing else names a registered kind, announces a registered state, and
//     passes every leg above — while the fixture refuses it at delivery as
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
// replies rather than about a beat. The beat-scoped half of the queue rule is the leg
// above; the row-read half is the delivery tier's
// (`test/console/architecture/scenario-delivery-shape.test.ts`), where a scenario is
// actually played.
//
// WHY THE PROBE IS A WHOLE ENVELOPE, AND WHOSE ENVELOPE IT IS. The strict layer is
// declared per EVENT, not per payload — there is no exported payload-only schema to
// reach for, and the one place the two are paired is inside the discriminated union.
// So the check presents each beat as the wire event it claims to be. It does not
// compose that envelope itself: `../scenario-envelope.ts` composes it, and that is
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
// A kind reaches the escape and stops there only when `session-event-streams.ts`
// claims it on neither narrowed stream — `runStateStreamArmFor` and
// `runQueueStreamStateFor` both answering `undefined`. Those two tables are declared
// `satisfies Record<<census-derived union>, …>`, so their key sets are compile-time
// facts: the run-state arms are the census filtered to the `run.` root, intersected
// with the registered `RunState` vocabulary, less the initial state, plus the
// rollback row; the queue states are the census filtered to the `queue_item.` root.
// A run-lifecycle or queue kind therefore cannot fall into the escape by being
// forgotten here — it would have to be removed from the stream that carries it, which
// is a compile error in that module.

import {
  EventEnvelopeSchema,
  MembershipRoleSchema,
  SESSION_EVENT_CATEGORY_BY_TYPE,
  SessionEventSchema,
  type SessionEventType,
} from "@ai-sidekicks/contracts";

import { projectRunStreamDelivery } from "../run-stream-projection.js";
import { composeScenarioEventEnvelope } from "../scenario-envelope.js";
import type { ConsoleScenario, ScenarioBeat } from "../scenario.js";
import {
  RUN_STATE_EVENT_STREAM,
  runQueueStreamStateFor,
  runStateStreamArmFor,
} from "../session-event-streams.js";

/**
 * One way a scenario contradicts the shipped wire contract.
 *
 * A list of these rather than a thrown error, so one run reports every defect in
 * every scenario at once. A predicate that threw on the first would make fixing a
 * family's scenario a one-defect-per-run loop.
 */
export interface ScenarioWireTruthDefect {
  readonly scenarioId: string;
  /** The beat or reply at fault, in the form a failure message prints. */
  readonly subject: string;
  /** What is wrong, and what would make it right. */
  readonly reason: string;
}

/** Every wire-truth defect across the given scenarios. Empty is the passing state. */
export function findScenarioWireTruthDefects(
  scenarios: readonly ConsoleScenario[],
): readonly ScenarioWireTruthDefect[] {
  const defects: ScenarioWireTruthDefect[] = [];
  for (const scenario of scenarios) {
    for (const [beatIndex, beat] of scenario.beats.entries()) {
      const reason = describeBeatDefect(beat);
      if (reason !== undefined) {
        defects.push({
          scenarioId: scenario.id,
          subject: `beat ${String(beatIndex)} (${beat.event.kind})`,
          reason,
        });
      }
    }
    defects.push(...findBeatOrderDefects(scenario));
    defects.push(...findDuplicateReplyCalls(scenario));
    const viewerDefect = describeViewerDefect(scenario);
    if (viewerDefect !== undefined) {
      defects.push(viewerDefect);
    }
    defects.push(...findMembershipRoleDefects(scenario));
  }
  return defects;
}

/** What is wrong with one beat, or `undefined` when the wire could have emitted it. */
function describeBeatDefect(beat: ScenarioBeat): string | undefined {
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
  const selfTransition = describeSelfTransitionDefect(beat);
  if (selfTransition !== undefined) {
    return selfTransition;
  }
  const queueState = describeQueueStateDefect(beat);
  if (queueState !== undefined) {
    return queueState;
  }
  const runStreamProjection = describeRunStreamProjectionDefect(beat);
  if (runStreamProjection !== undefined) {
    return runStreamProjection;
  }
  const envelope = composeScenarioEventEnvelope(beat.event);
  const carried = EventEnvelopeSchema.safeParse(envelope);
  if (!carried.success) {
    return (
      "the canonical envelope rejects this beat, so the console's decode boundary " +
      `would count it unreadable and drop it: ${carried.error.issues.map(describeIssue).join("; ")}.`
    );
  }
  const parsed = SessionEventSchema.safeParse(envelope);
  if (parsed.success) {
    return undefined;
  }
  if (parsed.error.issues.every((issue) => issue.path[0] === "type")) {
    // The strict layer registers no variant for this kind yet. The two legs above
    // have already passed, which is the whole of what can be checked here.
    return undefined;
  }
  return (
    `the registered "${beat.event.kind}" shape rejects this beat: ` +
    `${parsed.error.issues.map(describeIssue).join("; ")}.`
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

/** One Zod issue as a sentence fragment: where it is, and what it says. */
function describeIssue(issue: {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}): string {
  const location = issue.path.length === 0 ? "the event" : issue.path.map(String).join(".");
  return `${location} — ${issue.message}`;
}

/**
 * A stated viewer who is not in the roster, or `undefined` when the scenario is sound.
 *
 * `viewingParticipantId` is the one field a surface resolves a ROLE from, and it
 * resolves it by looking the id up in the session's own participant projection. An id
 * outside `participantIdsInJoinOrder` therefore resolves to nothing, and a surface
 * handed one either renders a role gate closed for a member who has it or renders it
 * open for a stranger — neither of which is visible in the fixture, because both look
 * exactly like a session whose viewer simply has no elevated role.
 *
 * Scoped to scenarios that STATE one: an absent viewer is the deliberate state the
 * fixture refuses the caller-identity read from, not a defect.
 */
function describeViewerDefect(scenario: ConsoleScenario): ScenarioWireTruthDefect | undefined {
  const { viewingParticipantId } = scenario;
  if (viewingParticipantId === undefined) {
    return undefined;
  }
  if (scenario.participantIdsInJoinOrder.includes(viewingParticipantId)) {
    return undefined;
  }
  return {
    scenarioId: scenario.id,
    subject: `viewingParticipantId "${viewingParticipantId}"`,
    reason:
      "the stated viewer is not in `participantIdsInJoinOrder`, so no surface can " +
      "resolve their role from this session's roster. Name a participant the " +
      "scenario actually joins, or leave the field absent and let the caller-identity " +
      "read refuse.",
  };
}

/**
 * Declared memberships that name someone the scenario never joins, or a role the
 * contract does not register.
 *
 * `membershipRoleByParticipantId` is the fact every role gate resolves through: the
 * fixture's session read turns each entry into a `participant` row and
 * `store/selectors.ts`'s `membershipRoleOf` reads the role back off it. Both legs
 * therefore catch a defect that renders as nothing at all.
 *
 *   • A key outside `participantIdsInJoinOrder` mints a roster row for someone the
 *     session has no join order position for — so the hue wheel and the roster
 *     disagree about who is in the room, and the entry can only ever be reached by a
 *     lookup no surface performs.
 *   • A role the contract does not register is parsed back as ABSENT rather than as
 *     wrong: `membershipRoleOf` returns `undefined` for anything
 *     `MembershipRoleSchema` rejects, so a scenario writing `"admin"` produces a
 *     member with no role and looks identical to one whose role went unread.
 *
 * The second leg is not made redundant by the field's type. A scenario is data, and
 * data reaches this predicate from files that were authored against design notes and
 * cast into shape; the beats above are typed too, and are parsed here for the same
 * reason.
 */
function findMembershipRoleDefects(scenario: ConsoleScenario): readonly ScenarioWireTruthDefect[] {
  const defects: ScenarioWireTruthDefect[] = [];
  for (const [participantId, role] of Object.entries(
    scenario.membershipRoleByParticipantId ?? {},
  )) {
    const subject = `membershipRoleByParticipantId["${participantId}"]`;
    if (!scenario.participantIdsInJoinOrder.includes(participantId)) {
      defects.push({
        scenarioId: scenario.id,
        subject,
        reason:
          "a role is declared for someone this scenario never joins, so the roster and " +
          "the hue wheel disagree about who is in the room and no surface can reach the " +
          "entry. Add the participant to `participantIdsInJoinOrder`, or drop the role.",
      });
      continue;
    }
    if (!MembershipRoleSchema.safeParse(role).success) {
      defects.push({
        scenarioId: scenario.id,
        subject,
        reason:
          `"${role}" is not a registered \`MembershipRole\`, and the roster lookup reads an ` +
          "unregistered role as no role at all — so this renders as a member whose role " +
          "went unread rather than as anything wrong. Use one of the registered roles.",
      });
    }
  }
  return defects;
}

/**
 * The log position a scenario's first beat occupies.
 *
 * One past the position the fixture's own session read answers at —
 * `fixture-session-snapshot.ts` establishes every scenario's base state at
 * `BASE_STATE_CURSOR`, which is zero, and the store's reconciler counts the rows
 * between the cursor it was re-based to and the first delivery it admits. So a
 * scenario opening anywhere else is not a scenario numbered differently: it is one
 * whose opening rows the store believes it lost.
 */
const FIRST_LOG_POSITION = 1;

/**
 * Beats scripted out of the order the clock reaches them in, or out of the log
 * position the store reads them at.
 *
 * TWO CLAIMS, ONE WALK, because both are about a beat and the beat in front of it
 * and neither is about anything else.
 *
 * **The tick.** `beats` is an ORDERED script, not a set: the engine advances a
 * frozen clock and consumes the contiguous prefix that has fallen due, so an entry
 * whose `atMs` is earlier than the entry in front of it is a beat the author wrote
 * in one order and the clock delivers in another. Nondecreasing rather than strictly
 * increasing, because beats sharing a tick are ordinary — a session event and the
 * run transition it triggers land together, and their array order is the order they
 * reach a subscriber in. The engine no longer duplicates or drops a beat over this,
 * so the defect costs a late delivery rather than a corrupted stream; it is still
 * reported, because the screenshot and endurance tiers pin frames by advancing to an
 * exact tick.
 *
 * **The position.** `sequence` is the log position, and unlike `atMs` it is not a
 * scheduling convenience the store tolerates: `session.subscribe` represents the
 * whole log, the fixture's snapshot starts at cursor zero, and the store's own
 * reconciler reads a jump as a real GAP and a step backwards as a real DIVERGENCE.
 * Either one puts it into degradation and repair — where it can drop later rows —
 * over a script the author meant as an ordinary session, while every per-beat schema
 * parse passes and this suite stays green. So the rule here is strictly contiguous:
 * each beat's `sequence` is its predecessor's plus one. Two beats at one TICK still
 * take two positions, which is why this claim is not the tick claim relaxed by one.
 *
 * **And the position the FIRST beat takes**, which contiguity alone cannot reach:
 * a rule stated only over a beat and the one in front of it says nothing about the
 * beat that has none, so a script opening at 2 — and a single-beat script opening
 * anywhere at all — passed while the store read the position it never received as a
 * real gap and degraded on the first delivery. The missing half is the same fact the
 * paragraph above already rests on, applied one row earlier: the snapshot answers at
 * cursor zero, so the first row the reconciler admits has to be the one immediately
 * after it. That is a fact about the base state rather than a convention, which is
 * why the constant above carries the module that establishes it.
 *
 * NO INTENT MARKER IS DECLARED, and that is a finding rather than an omission: the
 * two shipped scenarios run 1..8 and 1..1, so nothing in the tree scripts a gap, a
 * regression, or a late opening on purpose and a marker minted here would be a field
 * ahead of its only reader. A family branch whose repair or degradation scenario
 * needs one adds it in the swap that needs it, as a declared per-scenario field this
 * walk reads — never as a silent pass.
 */
function findBeatOrderDefects(scenario: ConsoleScenario): readonly ScenarioWireTruthDefect[] {
  const defects: ScenarioWireTruthDefect[] = [];
  for (const [beatIndex, beat] of scenario.beats.entries()) {
    const previousBeat = scenario.beats[beatIndex - 1];
    const subject = `beat ${String(beatIndex)} (${beat.event.kind})`;
    if (previousBeat === undefined) {
      if (beat.event.sequence !== FIRST_LOG_POSITION) {
        defects.push({
          scenarioId: scenario.id,
          subject,
          reason:
            `it opens the script at log position ${String(beat.event.sequence)}, and a session's ` +
            `first delivered position is ${String(FIRST_LOG_POSITION)}. The fixture's session read ` +
            "answers at cursor zero and `session.subscribe` represents the whole log, so the store " +
            "counts every position between the two as missing and enters degradation and repair — " +
            "where it can drop later rows — before the second beat is even due. Number the beats " +
            `from ${String(FIRST_LOG_POSITION)}.`,
        });
      }
      continue;
    }
    if (previousBeat.atMs > beat.atMs) {
      defects.push({
        scenarioId: scenario.id,
        subject,
        reason:
          `it is due at ${String(beat.atMs)}ms, before the beat in front of it at ` +
          `${String(previousBeat.atMs)}ms. The engine consumes beats in array order as the ` +
          "frozen clock reaches them, so this one is delivered later than it is scripted for. " +
          "Order the beats by `atMs`, or change the tick this beat is due at.",
      });
    }
    const expectedSequence = previousBeat.event.sequence + 1;
    if (beat.event.sequence !== expectedSequence) {
      defects.push({
        scenarioId: scenario.id,
        subject,
        reason:
          `it is at log position ${String(beat.event.sequence)}, and the beat in front of it is ` +
          `at ${String(previousBeat.event.sequence)}, so this script ` +
          `${beat.event.sequence > expectedSequence ? "skips a position" : "steps backwards"}. ` +
          "The store reconciles a subscription against the whole log from cursor zero, so it " +
          "reads that as a real gap or a real divergence, enters degradation and repair, and " +
          `can drop later rows. Number the beats contiguously — this one is ${String(expectedSequence)}.`,
      });
    }
  }
  return defects;
}

/**
 * Replies whose `call` another reply in the same scenario already claims.
 *
 * `replyFor` answers with the FIRST match, so a second entry for one call is a
 * scripted answer that can never be served — and the two are usually a rename and
 * its leftover, where the leftover is the one that wins.
 */
function findDuplicateReplyCalls(scenario: ConsoleScenario): readonly ScenarioWireTruthDefect[] {
  const seenCalls = new Set<string>();
  const defects: ScenarioWireTruthDefect[] = [];
  for (const reply of scenario.replies) {
    if (seenCalls.has(reply.call)) {
      defects.push({
        scenarioId: scenario.id,
        subject: `reply "${reply.call}"`,
        reason:
          "a second reply claims this call, and the fixture serves the first — so this one " +
          "is unreachable. Keep one entry per call.",
      });
      continue;
    }
    seenCalls.add(reply.call);
  }
  return defects;
}
