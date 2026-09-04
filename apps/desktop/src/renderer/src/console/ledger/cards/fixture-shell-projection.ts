// The fixture shell's row projection — this window's event log, read as rows.
//
// THE SECOND HALF OF THE SHELL, AND IT DIES WITH THE FIRST. `FixtureShellRows.tsx`
// renders one row; this decides which rows there are. Both exist for the same
// bounded reason and both are deleted by the change that registers the timeline
// subtree's real rows, because that subtree brings its own read.
//
// WHY A PROJECTION IS NEEDED AT ALL, WHICH IS A FACT ABOUT THE WIRE
//
// `TimelineRow` is a READ PROJECTION the daemon builds. No bridge namespace serves
// it: there is no timeline read on the growth port, and the subscription this
// console does hold delivers `ConsoleSessionEvent` — session id, sequence, wire
// type, instant, actor, payload — which is the raw log and not the projection. So
// the surface has two honest options: render nothing until the read exists, or
// state what the log itself supports and NAME every member the log cannot supply.
// The shell exists to take the second, and this module is where the naming happens.
//
// WHAT IS WIRE-VERBATIM HERE
//
//   • `sessionId`, `sequence`, `type`, `timestamp`, `actor`, `payload` — copied,
//     never reinterpreted.
//   • `category` — asked of `SESSION_EVENT_CATEGORY_BY_TYPE`, the registered
//     census, rather than inferred from the type string's prefix. A kind the
//     census does not carry is DROPPED AND COUNTED rather than filed under a
//     guess: a row under the wrong category is filtered and grouped wrongly by
//     every surface downstream, which is worse than a row that is missing and
//     said to be missing.
//   • `runId` on the run arm — read from the payload members the registered shapes
//     carry, derived from those shapes rather than listed, and only when the value
//     is a string.
//   • A boundary row's `position` — `RunRolledBackEvent.targetPosition`, verbatim,
//     which is what the arm's own schema refines it against.
//
// WHAT THIS MODULE DERIVES LOCALLY, AND WHY EACH IS SOUND FOR A SHELL
//
//   • `id`. The daemon's canonical event id never reaches this renderer — the
//     delivered envelope carries no id member at all — so rows are keyed by the
//     one identity the log does carry, `sequence`, which is unique and monotonic
//     within a session by construction. The real row arrives carrying its own.
//   • `position`. The arm's `position` is the daemon's projection-resolved run
//     position. What the log supports is the row's ORDINAL WITHIN ITS RUN in this
//     window, which is the property every consumer here actually spends —
//     chapters fold on it, bands rank on it, the rail lays marks out along it —
//     and which agrees with the daemon's ordering even though it is not the
//     daemon's number.
//   • `epoch`. Re-execution reuses ordinals, and the wire says nothing about which
//     execution a row belongs to. What the log DOES show is every rollback that
//     landed, so a run's epoch here counts the boundaries seen before the row. A
//     run that was never rewound is epoch zero, which is also what it would be.
//   • `summary`. The row's own wire type, restated — and that is the whole of it.
//     No registered payload carries a summary; the daemon composes one and serves
//     it through a read this console does not have. The growth slate's
//     `hydrated-event-read` row is where that missing read is written down, so the
//     absence is a registered fact rather than a claim made here. The member is REQUIRED and
//     non-empty by contract (`wireFreeFormString` layers `.min(1)`), so leaving it
//     blank is not open either: the contract's own validator refuses the row. So
//     the shell restates the one human-readable string the delivered envelope
//     actually carries rather than composing a sentence the daemon never said,
//     and the real summary arrives with the read that brings the real rows.
//
// A ROLLBACK RESETS THE COUNT, WHICH IS WHAT "RE-EXECUTION REUSES ORDINALS" MEANS.
// A rewind advances the epoch AND returns the run to the anchor the wire named, so
// the row after a boundary is at `targetPosition` — in the new epoch — and the rows
// after it count up from there. Letting the count run on instead would put
// re-executed rows at ordinals no rewind ever reached, and `superseded-bands.ts`
// ranks a row against the cutoff of a boundary IN ITS OWN EPOCH: a second rewind to
// the same anchor would then find every row of the new epoch above its cutoff and
// dim the whole of it. That comparison is already epoch-scoped; what it needs from
// here is that both sides of it are measured from one origin.
//
// The `SessionId` / `RunId` casts are the same one `row-fixtures.ts` takes: the
// brand is a compile-time nominal tag over `string` with no runtime witness, and
// the value under it is the wire's own.

import {
  RunRolledBackEventSchema,
  type AssistantOutputPayload,
  type InterventionRequestPayload,
  type RunRolledBackEvent,
  type RunStateChangeEvent,
  type ToolActivityPayload,
  SESSION_EVENT_CATEGORY_BY_TYPE,
  TIMELINE_ROLLBACK_BOUNDARY_TYPE,
  TIMELINE_RUN_ATTRIBUTION_PAYLOAD_KEYS,
  TIMELINE_RUN_LIFECYCLE_CATEGORY,
  type EventCategory,
  type RunId,
  type SessionId,
  type TimelineRow,
} from "@ai-sidekicks/contracts";

import { type ConsoleSessionEvent } from "../../store/index.js";

/**
 * What one projection pass produced, and what it could not.
 *
 * The count travels with the rows rather than being logged and forgotten, on the
 * drops-and-counts precedent the approvals reader set: a surface that quietly
 * showed fewer rows than the session holds is a surface nobody can debug, and rule
 * 8's five kinds of nothing all need to know that something WAS dropped.
 */
export interface FixtureShellProjection {
  readonly rows: readonly TimelineRow[];
  /**
   * Events the registered census does not carry a category for.
   *
   * Zero in every fixture build — the scenario wire-truth suite holds every beat
   * to the census — so a non-zero count is the console meeting an event the
   * contract package has not registered, which is a fact worth rendering.
   */
  readonly unprojectableEventCount: number;
}

/**
 * The registered census, read by a free-form wire type.
 *
 * The census is keyed by the registered union, and `ConsoleSessionEvent.kind` is a
 * wire-verbatim `string` by contract — an event whose type this build does not know
 * is exactly the case this lookup exists to answer, so narrowing the key first
 * would be assuming the answer. The widening is on a READ-ONLY map, so nothing can
 * be written under an unregistered key.
 */
const CATEGORY_BY_WIRE_TYPE: ReadonlyMap<string, EventCategory> = SESSION_EVENT_CATEGORY_BY_TYPE;

/** Nothing projected. A frozen module constant, so an empty pass allocates none. */
const EMPTY_PROJECTION: FixtureShellProjection = { rows: [], unprojectableEventCount: 0 };

/**
 * The payload members that attribute a row to a run — THE CONTRACT'S OWN LIST.
 *
 * `TIMELINE_RUN_ATTRIBUTION_PAYLOAD_KEYS` is `["runId", "targetRunId"]`, and the
 * second one is the whole finding: `Spec-006` spells run identity `runId` on every
 * run-attributed family except interventions, whose registered shape names the run
 * `targetRunId`. This shell read the first member and nothing else, so every
 * `intervention.*` event projected as a session-level `general` row and sat outside
 * the run chapter it belongs to — on a ledger whose whole shape is runs.
 *
 * CONSUMED RATHER THAN RE-DERIVED, because the contracts package already declares
 * this set once, with its reasoning, in the package that owns the wire. A second
 * list here would be the drift a closed set is declared once to prevent.
 */
const RUN_ATTRIBUTION_PAYLOAD_MEMBERS: readonly string[] = TIMELINE_RUN_ATTRIBUTION_PAYLOAD_KEYS;

/**
 * Every payload member in the registered shapes that NAMES a run, decided.
 *
 * THE COMPLETENESS PROOF FOR THE LIST ABOVE, and it catches what a shared runtime
 * constant cannot: a run-naming member added to a payload type that nobody adds to
 * that constant either. The union takes every member of every arm called `runId`
 * or ending in `RunId` — matched per arm, because a naked `keyof` over a union
 * yields only the members all its arms share — and the table is total over it, so
 * such a member fails to compile here until somebody says which run it names.
 *
 * Deciding every member rather than listing the attributing ones is what keeps
 * `parentRunId` out: `run.queued` carries it beside its own `runId`, and reading
 * whichever run-naming member turned up first would file a child run's rows in its
 * parent's chapter — the same defect pointing the other way.
 *
 * THE TWO ARTIFACTS ARE BOTH LIVE, and they meet in `runIdOf`: the contract names
 * the candidates and this table decides each one, so a member the contract grows
 * and this file has not decided is SKIPPED rather than trusted — a row that stays
 * session-level, which is the fail-closed direction, instead of one attributed to
 * whichever run a member nobody has read happens to name.
 */
type RunNamingMemberOf<TPayload> = TPayload extends unknown
  ? Extract<keyof TPayload, "runId" | `${string}RunId`>
  : never;

type RunNamingPayloadMember = RunNamingMemberOf<
  | AssistantOutputPayload
  | ToolActivityPayload
  | RunStateChangeEvent
  | RunRolledBackEvent
  | InterventionRequestPayload
>;

/** Whether a member names the run the event is ABOUT, or some other run. */
type RunAttributionRole = "this-run" | "another-run";

const RUN_ATTRIBUTION_BY_PAYLOAD_MEMBER = {
  runId: "this-run",
  targetRunId: "this-run",
  parentRunId: "another-run",
} as const satisfies Readonly<Record<RunNamingPayloadMember, RunAttributionRole>>;

/** The decided members that attribute, as the lookup below asks them. */
const ATTRIBUTING_PAYLOAD_MEMBERS: ReadonlySet<string> = new Set(
  Object.entries(RUN_ATTRIBUTION_BY_PAYLOAD_MEMBER)
    .filter(([, role]) => role === "this-run")
    .map(([member]) => member),
);

/**
 * Read the run this event belongs to, or `undefined` where it belongs to none.
 *
 * Typed as `unknown` on the way in and narrowed on the way out, because
 * `ConsoleSessionEvent.payload` is an open record by contract — the projector that
 * claims a kind is what narrows it, and this shell claims every kind.
 */
function runIdOf(event: ConsoleSessionEvent): string | undefined {
  for (const member of RUN_ATTRIBUTION_PAYLOAD_MEMBERS) {
    if (!ATTRIBUTING_PAYLOAD_MEMBERS.has(member)) {
      continue;
    }
    const candidate = event.payload?.[member];
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * The row's key, from the one identity the delivered envelope carries.
 *
 * Session-scoped rather than global because a window holds one store per session
 * and rows never cross between them; sequence-keyed because that is what the store
 * dedupes and detects gaps on, so two rows can share this key only if the store
 * admitted the same sequence twice, which it refuses.
 *
 * EXPORTED, and taken as the two identity parts rather than as an envelope, because
 * the fixtures that drive this projection have to name a row by id and hold exactly
 * those two values. A second spelling of the composition over there would drift from
 * this one in silence: a case asking after a row nothing carries passes by finding
 * nothing.
 */
export function shellRowId(sessionId: string, sequence: number): string {
  return `${sessionId}:${String(sequence)}`;
}

/** How far one run has got: its next ordinal, and how many rewinds it has taken. */
interface RunProgression {
  nextPosition: number;
  epoch: number;
}

/**
 * The boundary arm alone, so a caller can read the cutoff it landed on.
 *
 * Extracted from the contract's own union rather than declared beside it: the arm
 * is `TimelineRow`'s, and a second hand-written shape here would be a second claim
 * about what a boundary row carries.
 */
type RollbackBoundaryRow = Extract<TimelineRow, { readonly kind: "rollback_boundary" }>;

/** The members every arm spreads, all of them wire-verbatim but `id` and `summary`. */
function commonRowFields(
  event: ConsoleSessionEvent,
  category: EventCategory,
): {
  readonly id: string;
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly category: EventCategory;
  readonly type: string;
  readonly summary: string;
  readonly timestamp: string;
  readonly actor?: string;
} {
  return {
    id: shellRowId(event.sessionId, event.sequence),
    sessionId: event.sessionId as SessionId,
    sequence: event.sequence,
    category,
    type: event.kind,
    // Restated, not composed. See this file's header.
    summary: event.kind,
    timestamp: event.occurredAt,
    ...(event.actorId === undefined ? {} : { actor: event.actorId }),
  };
}

/**
 * Project one rollback into the typed boundary arm, or `undefined` if it cannot be.
 *
 * The arm's payload is the TYPED event rather than the open record the other arms
 * carry, and its schema refines `position` against `payload.targetPosition` — so
 * the payload is PARSED here rather than cast. A rollback whose payload does not
 * satisfy the contract is dropped and counted rather than rendered as a boundary
 * whose cutoff nobody can trust: a band drawn from a bad cutoff hides real rows.
 */
function projectRollbackBoundary(
  event: ConsoleSessionEvent,
  progression: RunProgression,
): RollbackBoundaryRow | undefined {
  const parsed = RunRolledBackEventSchema.safeParse(event.payload);
  if (!parsed.success) {
    return undefined;
  }
  const boundary = parsed.data;
  return {
    ...commonRowFields(event, TIMELINE_RUN_LIFECYCLE_CATEGORY),
    kind: "rollback_boundary",
    category: TIMELINE_RUN_LIFECYCLE_CATEGORY,
    type: TIMELINE_ROLLBACK_BOUNDARY_TYPE,
    runId: boundary.runId as RunId,
    // Wire-verbatim, and the one the arm's own refinement compares against.
    position: boundary.targetPosition,
    epoch: progression.epoch,
    payload: boundary,
  };
}

/**
 * Read this window's event log as timeline rows.
 *
 * A pure fold over the log in the order the store holds it, so the same log
 * produces the same rows however many times it is projected — which is what lets
 * the caller memoize on the log's identity alone and what makes a replay of the
 * same window byte-identical between runs.
 */
export function projectFixtureShellRows(
  events: readonly ConsoleSessionEvent[],
): FixtureShellProjection {
  if (events.length === 0) {
    return EMPTY_PROJECTION;
  }

  const progressionByRunId = new Map<string, RunProgression>();
  const rows: TimelineRow[] = [];
  let unprojectableEventCount = 0;

  for (const event of events) {
    const category = CATEGORY_BY_WIRE_TYPE.get(event.kind);
    if (category === undefined) {
      unprojectableEventCount += 1;
      continue;
    }

    const runId = runIdOf(event);
    if (runId === undefined) {
      rows.push({
        ...commonRowFields(event, category),
        kind: "general",
        payload: event.payload ?? {},
      });
      continue;
    }

    const existing = progressionByRunId.get(runId);
    const progression = existing ?? { nextPosition: 0, epoch: 0 };
    if (existing === undefined) {
      progressionByRunId.set(runId, progression);
    }

    if (event.kind === TIMELINE_ROLLBACK_BOUNDARY_TYPE) {
      const boundary = projectRollbackBoundary(event, progression);
      if (boundary === undefined) {
        unprojectableEventCount += 1;
        continue;
      }
      rows.push(boundary);
      // Everything after this row is a later execution of the same run, which is
      // exactly what an epoch is — and why the increment lands AFTER the boundary
      // is pushed rather than before: the boundary belongs to the epoch it ended.
      progression.epoch += 1;
      // And the count returns to the anchor the rewind landed on, so the first
      // re-executed row takes the boundary's own position in the new epoch. The
      // value is the wire's `targetPosition`, read off the row rather than out of
      // the payload a second time, so the boundary a reader sees and the origin the
      // rows after it count from can never be two different numbers.
      progression.nextPosition = boundary.position;
      continue;
    }

    rows.push({
      ...commonRowFields(event, category),
      kind: "run",
      runId: runId as RunId,
      position: progression.nextPosition,
      epoch: progression.epoch,
      payload: event.payload ?? {},
    });
    progression.nextPosition += 1;
  }

  return { rows, unprojectableEventCount };
}
