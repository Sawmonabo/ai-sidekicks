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
// WHAT WIRE TRUTH IS HERE. `packages/contracts/src/event.ts` ships two layers, and
// a scenario is measured against both:
//
//   • `SESSION_EVENT_CATEGORY_BY_TYPE` — the census. Its keys are every event type
//     the taxonomy registers, so a `kind` that is not a key is a type no daemon
//     emits. This is the leg that catches an invented name: `run.started` reads
//     exactly like a real event and is not one (`run.starting` is), and a fixture
//     that plays it produces frames, screenshots, and end-to-end results about a
//     wire that does not exist.
//   • `SessionEventSchema` — the strict layer. It registers a payload variant for
//     some of those types and not others, so where one exists the beat has to
//     satisfy it. This is the leg that catches an invented MEMBER, which is the
//     quieter defect: `session.created` carrying `{title}` names a real event type
//     and a payload the schema rejects outright, and nothing renders differently
//     until the day the console reads the payload.
//
// WHERE A BEAT'S MEMBERS COME FROM WHEN THE STRICT LAYER REGISTERS NO VARIANT. This is
// the one rule every scenario on the board is written against, and it is stated here
// because this is the module that holds them all to it. The census and the strict layer
// are the CODE leg: they are what this predicate can execute, and they are not the whole
// registry. The per-family and per-type payload rows of
// `docs/specs/006-session-event-taxonomy-and-audit-log.md` are the TAXONOMY leg — the
// registry those strict variants are implemented from — and they name a registered
// type's members whether or not the variant for it has landed in code yet.
//
// So "`packages/contracts` names no members for this type" is never a reason for a
// scenario to decline a beat. A scenario that scripts such a type carries every member
// that spec's row makes REQUIRED of a post-amendment emitter, because a partial row
// teaches a surface to read a shape no daemon produces — the same class of defect as an
// invented member, and one nothing here can catch. A scenario that declines the beat
// declines it for a reason about the SESSION it is scripting, and says which.
//
// WHY THE PROBE IS A WHOLE ENVELOPE. The strict layer is declared per EVENT, not
// per payload — there is no exported payload-only schema to reach for, and the one
// place the two are paired is inside the discriminated union. So the check presents
// each beat as the wire event it claims to be: the scenario's own `sessionId`,
// `sequence`, `occurredAt`, and actor, the census's own category, and the beat's
// own payload, with only the opaque envelope `id` and the wire-contract `version`
// supplied by this module. That makes the leg STRONGER than a payload-only parse
// rather than weaker — a scenario whose `sessionId` is not the UUID the contract
// declares is caught here too, and a fabricated probe id would have hidden exactly
// that.
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
  SESSION_EVENT_CATEGORY_BY_TYPE,
  SessionEventSchema,
  type SessionEventType,
} from "@ai-sidekicks/contracts";

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

/**
 * The envelope id the probe supplies.
 *
 * The one member no scenario carries: `ConsoleSessionEvent` is a renderer-local
 * projection keyed on `sequence`, and the daemon's opaque row id is not part of
 * it. The contract accepts any non-empty bounded string here, so a fixed one
 * carries no information and hides none.
 */
const PROBE_ENVELOPE_ID = "console-scenario-wire-truth-probe";

/**
 * The wire-contract version the probe supplies.
 *
 * `"MAJOR.MINOR"` per ADR-018; the strict layer only checks the shape. Like the id
 * above it is a member the console's projection does not carry, so supplying it is
 * the probe's business rather than a scenario's.
 */
const PROBE_ENVELOPE_VERSION = "1.0";

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
    defects.push(...findDuplicateReplyCalls(scenario));
    const viewerDefect = describeViewerDefect(scenario);
    if (viewerDefect !== undefined) {
      defects.push(viewerDefect);
    }
  }
  return defects;
}

/** What is wrong with one beat, or `undefined` when the wire could have emitted it. */
function describeBeatDefect(beat: ScenarioBeat): string | undefined {
  const category = SESSION_EVENT_CATEGORY_BY_TYPE.get(beat.event.kind as SessionEventType);
  if (category === undefined) {
    return (
      `"${beat.event.kind}" is not a registered event type, so no daemon emits it. ` +
      "Script the registered type this beat means instead — the census is " +
      "`SESSION_EVENT_CATEGORY_BY_TYPE` in `packages/contracts/src/event.ts`."
    );
  }
  const parsed = SessionEventSchema.safeParse({
    id: PROBE_ENVELOPE_ID,
    sessionId: beat.event.sessionId,
    sequence: beat.event.sequence,
    occurredAt: beat.event.occurredAt,
    category,
    type: beat.event.kind,
    ...(beat.event.actorParticipantId === undefined
      ? {}
      : { actor: beat.event.actorParticipantId }),
    payload: beat.event.payload,
    version: PROBE_ENVELOPE_VERSION,
  });
  if (parsed.success) {
    return undefined;
  }
  if (parsed.error.issues.every((issue) => issue.path[0] === "type")) {
    // The strict layer registers no variant for this kind yet. The census leg
    // above has already passed, which is the whole of what can be checked here.
    return undefined;
  }
  return (
    `the registered "${beat.event.kind}" shape rejects this beat: ` +
    `${parsed.error.issues.map(describeIssue).join("; ")}.`
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
