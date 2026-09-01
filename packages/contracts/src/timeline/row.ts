// Plan-013 T1.1 — the `TimelineRow` discriminated union: the single row shape
// every timeline surface returns, on read windows, on `childRunExpand`, and on
// the live subscribe stream alike.
//
// PROVENANCE. The canonical shapes are
// `docs/architecture/contracts/api-payload-contracts.md` §"Plan-013 — Live
// Timeline Visibility And Reasoning Surfaces"; the behavior they serve is
// `Spec-013 §Timeline Entry Types`, `Spec-013 §Required Behavior` (the
// superseded-turn rendering bullet), and `Spec-013 §Fallback Behavior` (the
// compacted-stub arms). This module APPLIES all three; it decides none of
// them. Adding, removing, or renaming a member is a doc edit first.
//
// ----------------------------------------------------------------------------
// Why the discriminator is `kind` and not `type`
// ----------------------------------------------------------------------------
//
// `type` is the projection's free-form event-type string — deliberately
// `string` and not the `SessionEventType` census union, because a row projected
// from a higher-MINOR producer's event must still parse (`ADR-018 §Decision`
// #5, #8, #9, the same tolerance `EventEnvelope.type` carries). A consumer that
// discriminated on it would be probing an open vocabulary and would have to
// guess which of the four attribution shapes it was holding.
//
// `kind` is the closed four-value literal the projector stamps from the event
// family, so `row.kind === "run"` narrows STRUCTURALLY to a row that carries
// the full attribution triple. Arm selection is by `kind` FIRST: a run-scoped
// row missing any of `runId` / `position` / `epoch` fails ITS OWN arm and is
// never re-offered to the `general` or `legacy_stub` arm, which is exactly what
// `z.discriminatedUnion` buys over `z.union` and exactly what I-013-1's
// all-or-none attribution requires (`Plan-013 §Invariants` I-013-1; the
// malformed-row case in `Plan-013 §Test And Verification Plan`).
//
// ----------------------------------------------------------------------------
// Why the `superseded` marker is one field
// ----------------------------------------------------------------------------
//
// I-013-3: the marker is `{ targetPosition }` and nothing else. Its run
// identity and source epoch ARE the containing row's own `runId` + `epoch`, so
// there are no duplicated fields that could disagree, and the marker a live
// subscriber computes from a boundary's cutoff is identical BY CONSTRUCTION to
// the one a replay window arrives with. `.strict()` on the marker is what
// enforces that: a producer that helpfully added `runId` to the marker is
// refused rather than accepted into a second source of attribution truth.
//
// ----------------------------------------------------------------------------
// Parse cost
// ----------------------------------------------------------------------------
//
// A row is parsed once per subscription delivery, so every arm here is a flat
// `z.object().strict()` over scalar checks. The one cross-field refinement in
// the file is the boundary arm's three-way agreement check — three comparisons,
// no allocation, no iteration — and it runs only on `rollback_boundary` rows,
// which are one row per accepted rollback rather than one per delivery.
import { z } from "zod";

import { EVENT_ENVELOPE_SEQUENCE_MAX, EVENT_FIELD_MAX_LEN, EventCategorySchema } from "../event.js";
import type { EventCategory } from "../event.js";
import { RunIdSchema, type RunId } from "../provider-driver.js";
import { RunRolledBackEventSchema, type RunRolledBackEvent } from "../runControl.js";
import { SessionIdSchema, wireFreeFormString, type SessionId } from "../session.js";

import { ChildRunSummarySchema, type ChildRunSummary } from "./child-run-summary.js";

/**
 * Cap on `TimelineRowBase.summary`, the row's human-readable one-liner. Sized
 * an order of magnitude above `EVENT_FIELD_MAX_LEN` because a summary is prose
 * rather than an identifier, and an order of magnitude below the free-form
 * error/diagnostic caps because a summary that needs 8 KiB is a payload the
 * row should be carrying in `payload` instead.
 */
export const TIMELINE_ROW_SUMMARY_MAX_LEN = 4096;

/**
 * The `run.rolled_back` event-type literal the boundary arm pins its `type` to.
 * Declared here rather than spelled at the two use sites so the arm's schema
 * and its interface cannot drift; the string itself is Plan-006's, registered
 * in `SESSION_EVENT_TYPES`.
 */
export const TIMELINE_ROLLBACK_BOUNDARY_TYPE = "run.rolled_back" as const;

/**
 * The single-field superseded marker (I-013-3). Present exactly when the row's
 * turn is superseded; ABSENCE means current — there is no `superseded: false`
 * spelling, because two ways to say "current" is two things to keep in sync.
 *
 * `targetPosition` is the superseding rollback's rewind cutoff: the first
 * accepted rollback in the run's lineage, at the row's epoch or later, that
 * rewound the surviving history containing the row.
 */
export interface SupersededMarker {
  targetPosition: number;
}

/**
 * Runtime validator for {@link SupersededMarker}. `.strict()` is load-bearing
 * rather than defensive — see the single-field rationale in this file's header.
 */
export const SupersededMarkerSchema: z.ZodType<SupersededMarker> = z
  .object({ targetPosition: z.number().int().nonnegative() })
  .strict();

/**
 * The members every timeline row carries, whatever its `kind`.
 *
 * `payload` is `Record<string, unknown>` on three of the four arms and the
 * typed `RunRolledBackEvent` on the fourth — see {@link TimelineRollbackBoundary}.
 */
export interface TimelineRowBase {
  /** Opaque on the wire — the canonical event id this row projects from. */
  id: string;
  sessionId: SessionId;
  /**
   * The SESSION event sequence. Never a run position: reused ordinals mean the
   * two are not interchangeable, which is why a run-scoped row carries
   * `position` separately (`Plan-013 §API And Transport Changes`).
   */
  sequence: number;
  category: EventCategory;
  /** Free-form by contract — narrow on `kind`, never on this. */
  type: string;
  actor?: string | undefined;
  /** Human-readable summary. */
  summary: string;
  timestamp: string;
  /** Present when this row is a summarized child-run row. */
  childRunSummary?: ChildRunSummary | undefined;
  payload: Record<string, unknown>;
}

/**
 * Single-sourced base shape. Every arm spreads this, so a member added to the
 * base reaches all four arms and the arms cannot drift on shared-field
 * validation — the `buildCommonShape()` idiom `event.ts` uses for the same
 * reason. A function rather than a shared object literal so each arm gets its
 * own schema instances and no arm can mutate a sibling's.
 */
const buildTimelineRowCommonShape = () => ({
  id: wireFreeFormString(EVENT_FIELD_MAX_LEN, "TimelineRow.id"),
  sessionId: SessionIdSchema,
  sequence: z.number().int().nonnegative().max(EVENT_ENVELOPE_SEQUENCE_MAX),
  category: EventCategorySchema,
  type: wireFreeFormString(EVENT_FIELD_MAX_LEN, "TimelineRow.type"),
  actor: wireFreeFormString(EVENT_FIELD_MAX_LEN, "TimelineRow.actor").optional(),
  summary: wireFreeFormString(TIMELINE_ROW_SUMMARY_MAX_LEN, "TimelineRow.summary"),
  timestamp: z.iso.datetime({ offset: true }),
  childRunSummary: ChildRunSummarySchema.optional(),
});

/**
 * The open projected payload the three non-boundary arms carry.
 *
 * Deliberately WITHOUT the `__proto__` pre-guard `EventEnvelopeSchema` applies
 * to its own payload. That guard exists because the envelope's parse output is
 * hashed: a key Zod's record parser silently drops would collapse two distinct
 * wire byte-strings onto one `row_hash`. A timeline row is a read projection —
 * never hashed, never chained, never signed (`Spec-013 §State And Data
 * Implications`: "timeline rows are read projections, not canonical events
 * themselves") — so the collapse hazard does not reach it, and the anti-
 * pollution drop Zod performs is the whole of the security requirement here.
 */
const projectedPayloadSchema = z.record(z.string(), z.unknown());

/**
 * `kind: "general"` — the NON-RUN arm. Carries no run attribution
 * structurally: the projector stamps `kind` from the event family, so a
 * run-scoped family can never arrive here, and `.strict()` refuses a row that
 * tried to smuggle `runId` / `position` / `epoch` / `superseded` onto it.
 */
export interface TimelineEntry extends TimelineRowBase {
  kind: "general";
}

/**
 * `kind: "run"` — the REQUIRED-ATTRIBUTION arm (I-013-1).
 *
 * `runId` + `position` + `epoch` are all-or-none by construction: they are
 * three required members of one arm, and the arm is selected by `kind` before
 * they are read, so a partial row fails HERE and is never re-offered to
 * `general` or `legacy_stub`.
 *
 * `position` is the projection-resolved originating run position (Plan-004
 * T3.14's uniform row-to-turn assignment) — the comparand the `run.rolled_back`
 * live rule ranks against the boundary's carried cutoff. `epoch` is the
 * projection-resolved execution epoch, and it is a separate member rather than
 * something derivable because re-execution REUSES ordinals: `position` alone
 * can never recover it (I-013-4).
 */
export interface RunScopedTimelineEntry extends TimelineRowBase {
  kind: "run";
  runId: RunId;
  position: number;
  epoch: number;
  superseded?: SupersededMarker | undefined;
}

/**
 * `kind: "legacy_stub"` — a run-scoped audit stub compacted in the
 * vacuous-attribution era (`Spec-006 §Compacted Event Format`).
 *
 * `runId` is PRESERVED (every run-scoped stub preserves it) while `position`
 * and `epoch` are structurally ABSENT because they are unknowable, not because
 * they were omitted. `.strict()` makes that structural: offering either one
 * fails parse rather than being accepted as an invented ordinal.
 *
 * The arm carries no `superseded` marker and cannot: such a row can never be
 * ranked, and Plan-004's span check treats a run holding one as the
 * standing-refusal class, so that run can never admit a rollback while the stub
 * exists (`Spec-013 §Fallback Behavior`). The row renders the compaction
 * placeholder alone.
 */
export interface LegacyStubTimelineEntry extends TimelineRowBase {
  kind: "legacy_stub";
  runId: RunId;
}

/**
 * `kind: "rollback_boundary"` — the typed `run.rolled_back` boundary entry
 * (I-013-5).
 *
 * `payload` is the TYPED {@link RunRolledBackEvent}, not the open projected
 * record the other three arms carry: the live client rule reads
 * `payload.targetPosition` and must never reach it through a cast. A payload
 * that fails that validation is a projection defect surfaced at emission, never
 * delivered untyped.
 *
 * `type` is pinned to the `run.rolled_back` literal, narrowing the base's
 * free-form `type` — the one arm where the event-type string is closed, because
 * the arm exists to carry exactly that one event.
 *
 * OUTER ATTRIBUTION AND PAYLOAD CANNOT DISAGREE. The schema refines
 * `runId === payload.runId`, `sessionId === payload.sessionId`, and
 * `position === payload.targetPosition` — the boundary row ranks at the
 * confirmed rewind floor, which is why a later rollback cutting below it
 * supersedes it in turn (hence this arm's own `superseded` marker).
 *
 * The `Omit` is why this is not the plain `TimelineRowBase &` intersection the
 * canonical doc sketched: intersecting `payload: Record<string, unknown>` with
 * `payload: RunRolledBackEvent` yields a member no `RunRolledBackEvent`-typed
 * value satisfies (an interface has no implicit index signature), so the typed
 * payload would be unconstructible and `RunRolledBackEventSchema` would not
 * type against it. Replacing the member says what the doc's own comment means.
 */
export interface TimelineRollbackBoundary extends Omit<TimelineRowBase, "type" | "payload"> {
  kind: "rollback_boundary";
  runId: RunId;
  /** The boundary row's own originating position — the confirmed rewind floor. */
  position: number;
  /** The epoch the rollback rewound. */
  epoch: number;
  superseded?: SupersededMarker | undefined;
  type: typeof TIMELINE_ROLLBACK_BOUNDARY_TYPE;
  payload: RunRolledBackEvent;
}

// ---------------------------------------------------------------------------
// Cross-field rules shared by the arms
// ---------------------------------------------------------------------------

/**
 * The rollback event type belongs to the boundary arm and nowhere else.
 *
 * Without this, a producer could emit `kind: "run"` carrying
 * `type: "run.rolled_back"` and it would parse: the `run` arm's `type` is the
 * base's free-form string. The row would then reach a consumer that narrows on
 * `kind` — the narrowing this module exists to guarantee — as an ordinary run
 * row, and the rewind cutoff it carries in its untyped `payload` would never be
 * read. That is the exact failure I-013-5 forbids ("no consumer receives an
 * untyped cutoff"), reached by the back door of the discriminator being right
 * and the type being wrong.
 *
 * Refusing it here means the two fields cannot disagree in the one direction
 * that loses data. The reverse direction is already closed: the boundary arm
 * pins `type` to the literal, so it cannot carry anything else.
 */
const refuseBoundaryTypeOnNonBoundaryArm = (
  row: { type: string },
  issueContext: z.RefinementCtx,
): void => {
  if (row.type === TIMELINE_ROLLBACK_BOUNDARY_TYPE) {
    issueContext.addIssue({
      code: "custom",
      path: ["type"],
      message:
        `the ${TIMELINE_ROLLBACK_BOUNDARY_TYPE} event type is carried only by the ` +
        "rollback_boundary arm, whose payload is validated into the typed event; a row " +
        "carrying it under any other kind would deliver the rewind cutoff untyped",
    });
  }
};

/**
 * A superseded marker must actually supersede the row that carries it.
 *
 * `Spec-013 §Required Behavior` states the comparison exactly: the boundary
 * entry instructs the client to mark "that run's already-delivered rows whose
 * carried run position exceeds the carried rewind cutoff". EXCEEDS — so a row
 * at the cutoff is the retained floor and is NOT superseded, and a row below it
 * survives. A marker on either is a projection defect, and the marker is
 * deliberately single-field (I-013-3) precisely so that the row's own position
 * is the only thing it can be ranked against.
 *
 * Epoch is NOT compared here, and that is not an omission. I-013-3 keeps the
 * marker single-field so identity is read from the containing row; the row's
 * epoch selects WHICH cutoff applies upstream, in the projection, and there is
 * no second epoch inside the marker for a row-local check to compare against.
 * The in-row invariant is exactly this ordering.
 */
const requireMarkerToOutrankRow = (
  row: { position: number; superseded?: SupersededMarker | undefined },
  issueContext: z.RefinementCtx,
): void => {
  const marker: SupersededMarker | undefined = row.superseded;
  if (marker === undefined) {
    return;
  }
  if (row.position <= marker.targetPosition) {
    issueContext.addIssue({
      code: "custom",
      path: ["superseded", "targetPosition"],
      message:
        `a superseded row must rank ABOVE the rewind cutoff: position ${String(row.position)} ` +
        `does not exceed targetPosition ${String(marker.targetPosition)}, so this row is at or ` +
        "below the retained floor and is not superseded by that cutoff",
    });
  }
};

const timelineGeneralArmSchema = z
  .object({
    ...buildTimelineRowCommonShape(),
    kind: z.literal("general"),
    payload: projectedPayloadSchema,
  })
  .strict()
  .superRefine(refuseBoundaryTypeOnNonBoundaryArm);

const runScopedTimelineArmSchema = z
  .object({
    ...buildTimelineRowCommonShape(),
    kind: z.literal("run"),
    runId: RunIdSchema,
    position: z.number().int().nonnegative(),
    epoch: z.number().int().nonnegative(),
    superseded: SupersededMarkerSchema.optional(),
    payload: projectedPayloadSchema,
  })
  .strict()
  .superRefine((runRow, issueContext) => {
    refuseBoundaryTypeOnNonBoundaryArm(runRow, issueContext);
    requireMarkerToOutrankRow(runRow, issueContext);
  });

const legacyStubTimelineArmSchema = z
  .object({
    ...buildTimelineRowCommonShape(),
    kind: z.literal("legacy_stub"),
    runId: RunIdSchema,
    payload: projectedPayloadSchema,
  })
  .strict()
  .superRefine(refuseBoundaryTypeOnNonBoundaryArm);

const timelineRollbackBoundaryArmSchema = z
  .object({
    // `type` below REPLACES the base shape's free-form parser by spread order:
    // this is the one arm where the event-type string is closed. The base
    // carries no `payload` member at all — each arm declares its own, because
    // this one's is the typed event and the other three's is the open record.
    ...buildTimelineRowCommonShape(),
    kind: z.literal("rollback_boundary"),
    runId: RunIdSchema,
    position: z.number().int().nonnegative(),
    epoch: z.number().int().nonnegative(),
    superseded: SupersededMarkerSchema.optional(),
    type: z.literal(TIMELINE_ROLLBACK_BOUNDARY_TYPE),
    payload: RunRolledBackEventSchema,
  })
  .strict()
  // The three-way agreement. `.superRefine()` returns `this`, so this stays a
  // ZodObject and remains a valid `z.discriminatedUnion` option (the same Zod-4
  // property `event.ts`'s `audit_integrity_failed` arm relies on).
  //
  // The payload-presence guard is deliberate and MEASURED rather than assumed:
  // zod 4.3.6 skips a schema's checks once the shape parse has failed (probed
  // directly — a `superRefine` on an object whose member failed does not run),
  // so on today's pin this branch is unreachable. It stays because the cost is
  // three lines and the failure it forecloses is not a wrong answer but a
  // CRASH: were that ordering to change, an unguarded
  // `boundaryRow.payload.runId` on a row whose payload was rejected would throw
  // a TypeError out of `.parse()` on a per-delivery hot path instead of
  // returning a parse failure. The three field comparisons below need no such
  // guard — an absent operand there yields a spurious issue beside the real
  // one, never an exception.
  .superRefine((boundaryRow, issueContext) => {
    const rolledBackEvent: RunRolledBackEvent | undefined | null = boundaryRow.payload;
    if (rolledBackEvent === undefined || rolledBackEvent === null) {
      return;
    }
    if (boundaryRow.runId !== rolledBackEvent.runId) {
      issueContext.addIssue({
        code: "custom",
        path: ["runId"],
        message:
          "rollback_boundary row attribution disagrees with its payload: runId must equal payload.runId — a boundary whose outer run differs from the rewound run would mark the wrong run's rows.",
      });
    }
    if (boundaryRow.sessionId !== rolledBackEvent.sessionId) {
      issueContext.addIssue({
        code: "custom",
        path: ["sessionId"],
        message:
          "rollback_boundary row attribution disagrees with its payload: sessionId must equal payload.sessionId.",
      });
    }
    // The boundary row can ITSELF be superseded, by a later rollback cutting
    // below it — so the same ordering rule applies to its own marker. Its
    // `position` is the confirmed rewind floor (pinned to the payload just
    // below), and a later, lower cut ranks it above that cut.
    requireMarkerToOutrankRow(boundaryRow, issueContext);
    if (boundaryRow.position !== rolledBackEvent.targetPosition) {
      issueContext.addIssue({
        code: "custom",
        path: ["position"],
        message:
          "rollback_boundary row attribution disagrees with its payload: position must equal payload.targetPosition — the boundary row ranks at the confirmed rewind floor.",
      });
    }
  });

/**
 * The row union every timeline surface returns — `TimelineReadResponse.entries`,
 * the `timeline.subscribe` stream, and `ChildRunExpandResponse.entries` are all
 * `TimelineRow`. Genuinely discriminated on the literal `kind`: consumers narrow
 * structurally, never by probing the free-form `type` and never by casting.
 */
export type TimelineRow =
  | TimelineRollbackBoundary
  | RunScopedTimelineEntry
  | LegacyStubTimelineEntry
  | TimelineEntry;

/**
 * Runtime validator for {@link TimelineRow}. Arm selection is by `kind`, so an
 * arm-specific failure is reported against THAT arm and never retried against a
 * sibling — the property I-013-1's all-or-none attribution rests on.
 */
export const TimelineRowSchema: z.ZodType<TimelineRow> = z.discriminatedUnion("kind", [
  timelineRollbackBoundaryArmSchema,
  runScopedTimelineArmSchema,
  legacyStubTimelineArmSchema,
  timelineGeneralArmSchema,
]);

/**
 * The closed `kind` vocabulary, in the union's own arm order. Exported so a
 * consumer switching on `row.kind` can assert exhaustiveness against the
 * contract rather than against a hand-copied list.
 */
export const TIMELINE_ROW_KINDS: readonly TimelineRow["kind"][] = Object.freeze([
  "rollback_boundary",
  "run",
  "legacy_stub",
  "general",
] as const);
