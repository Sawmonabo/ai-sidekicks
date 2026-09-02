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
// WHAT WIRE TRUTH IS HERE. `packages/contracts/src/event.ts` ships three things a
// scenario is measured against, and every beat meets all three — then a fourth leg
// the contracts package does not carry at all, because the run state machine lives
// in `docs/domain/` and nothing compiles it:
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
// their owning plans — and the beat is held to the census leg alone. Any other
// failure is the beat's.

import {
  EventEnvelopeSchema,
  MembershipRoleSchema,
  SESSION_EVENT_CATEGORY_BY_TYPE,
  SessionEventSchema,
  type SessionEventType,
} from "@ai-sidekicks/contracts";

import { composeScenarioEventEnvelope } from "../scenario-envelope.js";
import type { ConsoleScenario, ScenarioBeat } from "../scenario.js";

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
 * Beats scripted out of the order the clock reaches them in.
 *
 * `beats` is an ORDERED script, not a set: the engine advances a frozen clock and
 * consumes the contiguous prefix that has fallen due, so an entry whose `atMs` is
 * earlier than the entry in front of it is a beat the author wrote in one order
 * and the clock delivers in another. Nondecreasing rather than strictly
 * increasing, because beats sharing a tick are ordinary — a session event and the
 * run transition it triggers land together, and their array order is the order
 * they reach a subscriber in.
 *
 * The engine no longer duplicates or drops a beat over this, so the defect costs a
 * late delivery rather than a corrupted stream; it is still reported, because a
 * scenario whose beats arrive in an order the author did not write is a fixture
 * that rehearses a sequence no session produces, and the screenshot and endurance
 * tiers pin frames by advancing to an exact tick.
 */
function findBeatOrderDefects(scenario: ConsoleScenario): readonly ScenarioWireTruthDefect[] {
  const defects: ScenarioWireTruthDefect[] = [];
  for (const [beatIndex, beat] of scenario.beats.entries()) {
    const previousBeat = scenario.beats[beatIndex - 1];
    if (previousBeat === undefined || previousBeat.atMs <= beat.atMs) {
      continue;
    }
    defects.push({
      scenarioId: scenario.id,
      subject: `beat ${String(beatIndex)} (${beat.event.kind})`,
      reason:
        `it is due at ${String(beat.atMs)}ms, before the beat in front of it at ` +
        `${String(previousBeat.atMs)}ms. The engine consumes beats in array order as the ` +
        "frozen clock reaches them, so this one is delivered later than it is scripted for. " +
        "Order the beats by `atMs`, or change the tick this beat is due at.",
    });
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
