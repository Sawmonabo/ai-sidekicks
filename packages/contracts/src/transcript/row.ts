// The `TranscriptEventRow` union every transcript read returns, discriminated on the closed `kind`
// literal (`run`, `rollback_boundary`, `general`). `type` is a free-form string so a row
// projected from a newer producer's event still parses; consumers narrow on `kind`, never on it.
// Every row is parsed on read, so each arm is a flat `.strict()` object with cheap refinements.
import { z } from "zod";

import {
  ASSISTANT_OUTPUT_EVENT_TYPES,
  INTERACTIVE_REQUEST_EVENT_TYPES,
  RUN_LIFECYCLE_EVENT_TYPES,
  TOOL_ACTIVITY_EVENT_TYPES,
} from "../event/registry.js";
import {
  EVENT_ENVELOPE_SEQUENCE_MAX,
  EVENT_FIELD_MAX_LEN,
  EventCategorySchema,
  SOURCE_EPOCH_PAYLOAD_KEY,
  SOURCE_POSITION_PAYLOAD_KEY,
  type EventCategory,
} from "../event/envelope.js";
import { RunIdSchema, type RunId } from "../run/id.js";
import { RunRolledBackEventSchema, type RunRolledBackEvent } from "../run/control.js";
import { wireFreeFormString, FILE_PATH_MAX_LEN } from "../free-form-string.js";
import { EventCursorSchema, SessionIdSchema, type SessionId } from "../session/id.js";
import { type EventCursor } from "../session/event-cursor.js";

import { ChildRunSummarySchema, type ChildRunSummary } from "./child-run-summary.js";
import { TRANSCRIPT_EVENT_ROW_SUMMARY_MAX_LEN } from "./limits.js";
import { countSchema, isoDateTimeSchema } from "../internal/wire-scalars.js";

/** The event type the `rollback_boundary` arm pins, as registered in `SessionEventType`. */
export const TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE = "run.rolled_back" as const;

/**
 * The category every `run_lifecycle` event belongs to, and the one the boundary arm pins. Every
 * type in it is run-scoped, which is why the `general` arm refuses the category outright.
 */
export const TRANSCRIPT_RUN_LIFECYCLE_CATEGORY = "run_lifecycle" as const;

/**
 * The payload keys that name a run: `runId` everywhere, and `targetRunId` on interventions.
 * Both are checked, since a guard reading only `runId` would let intervention rows through the
 * `general` arm.
 */
export const TRANSCRIPT_RUN_ATTRIBUTION_PAYLOAD_KEYS: readonly string[] = Object.freeze([
  "runId",
  "targetRunId",
] as const);

/**
 * The `interactive_request` types whose payload does not always name a run: queue events
 * (the target run lives in the queue item, not the event), `user.message` (accepted before
 * any run exists) and `question.asked` (a workflow step names its wait instead). The payload
 * decides these per row. The rest of the category is run-scoped, so the run-scoped set
 * subtracts these rather than re-listing them, and a newly added type defaults to run-scoped.
 */
const INTERACTIVE_REQUEST_TYPES_WITHOUT_REQUIRED_RUN: ReadonlySet<string> = new Set([
  "queue_item.created",
  "queue_item.admitted",
  "queue_item.superseded",
  "queue_item.canceled",
  "queue_item.not_delivered",
  "user.message",
  "question.asked",
]);

/**
 * The `usage_telemetry` types whose payload requires `runId`, listed positively because the
 * category's shared shape leaves it optional. The other usage types, and every
 * `artifact_publication` type, are decided per row by the payload: a session-scoped budget
 * warning is a real row and must keep the `general` arm.
 */
const USAGE_TELEMETRY_TYPES_WITH_REQUIRED_RUN: readonly string[] = Object.freeze([
  "usage.context_compacted",
  "usage.model_rerouted",
] as const);

/**
 * The `approval_flow` types whose payload requires `runId`, listed positively because the
 * category also holds types that name no run. An ask, its answer and its end belong to the run
 * that raised it. `approval.rule_revoked` leaves the run optional (a rule is also revoked with
 * no ask in flight), so the payload decides it per row.
 */
const APPROVAL_FLOW_TYPES_WITH_REQUIRED_RUN: readonly string[] = Object.freeze([
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.canceled",
  "approval.remembered",
  "approval.reviewer_denied",
  "moderation.review_flagged",
  "plan.proposed",
] as const);

/**
 * Every event type whose payload always names a run, built from the run-scoped category arrays in
 * `../event/registry.js` so a type added there joins on its own. The `general` arm refuses these
 * by type because a projected payload is a summary that may omit `runId`, as a `tool.result`
 * row's can.
 */
export const TRANSCRIPT_RUN_SCOPED_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  ...RUN_LIFECYCLE_EVENT_TYPES,
  ...ASSISTANT_OUTPUT_EVENT_TYPES,
  ...TOOL_ACTIVITY_EVENT_TYPES,
  ...INTERACTIVE_REQUEST_EVENT_TYPES.filter(
    (eventType) => !INTERACTIVE_REQUEST_TYPES_WITHOUT_REQUIRED_RUN.has(eventType),
  ),
  ...USAGE_TELEMETRY_TYPES_WITH_REQUIRED_RUN,
  ...APPROVAL_FLOW_TYPES_WITH_REQUIRED_RUN,
]);

/**
 * The superseded marker: present exactly when the row's turn is superseded, and absent means
 * current. `targetPosition` is the rewind cutoff of the first accepted rollback in the run's
 * lineage, at the row's epoch or later, that rewound the surviving history containing the row.
 */
export interface SupersededMarker {
  targetPosition: number;
}

/**
 * Parses a {@link SupersededMarker}. It is `.strict()` so a producer cannot add a `runId` and
 * create a second source of attribution.
 */
export const SupersededMarkerSchema: z.ZodType<SupersededMarker> = z
  .object({ targetPosition: countSchema })
  .strict();

/**
 * One file whose patch a tool call's row left out, and the patch's size in bytes.
 * The row draws like one whose patch traveled; `transcript.patchRead` fetches every
 * left-out patch of the call in one read.
 */
export interface TranscriptOmittedPatch {
  path: string;
  size: number;
}
const TranscriptOmittedPatchSchema: z.ZodType<TranscriptOmittedPatch> = z
  .object({
    path: wireFreeFormString(FILE_PATH_MAX_LEN, "TranscriptOmittedPatch.path"),
    size: countSchema,
  })
  .strict();

/**
 * The members every transcript row carries, whatever its `kind`. `payload` is an open record on
 * two arms and the typed `RunRolledBackEvent` on {@link TranscriptRollbackBoundary}.
 */
export interface TranscriptEventRowBase {
  /** The id of the event this row projects from; opaque on the wire. */
  id: string;
  sessionId: SessionId;
  /** The session event sequence, never a run position: re-execution reuses run ordinals. */
  sequence: number;
  /**
   * The position the session's stream delivers this event at, opaque and relayed verbatim, so a
   * link naming a message by its cursor finds the row however the row was read.
   */
  cursor: EventCursor;
  category: EventCategory;
  /** Free-form by contract — narrow on `kind`, never on this. */
  type: string;
  actor?: string | undefined;
  /** Human-readable summary. */
  summary: string;
  timestamp: string;
  /** Present when this row is a summarized child-run row. */
  childRunSummary?: ChildRunSummary | undefined;
  /** Present on a tool call's row that left out one or more patches. */
  omittedPatches?: TranscriptOmittedPatch[] | undefined;
  payload: Record<string, unknown>;
}

// Every arm spreads this shape; its field schemas are built once and shared, since Zod schemas
// are immutable.
const TRANSCRIPT_EVENT_ROW_COMMON_SHAPE = {
  id: wireFreeFormString(EVENT_FIELD_MAX_LEN, "TranscriptEventRow.id"),
  sessionId: SessionIdSchema,
  sequence: countSchema.max(EVENT_ENVELOPE_SEQUENCE_MAX),
  cursor: EventCursorSchema,
  category: EventCategorySchema,
  type: wireFreeFormString(EVENT_FIELD_MAX_LEN, "TranscriptEventRow.type"),
  actor: wireFreeFormString(EVENT_FIELD_MAX_LEN, "TranscriptEventRow.actor").optional(),
  summary: wireFreeFormString(TRANSCRIPT_EVENT_ROW_SUMMARY_MAX_LEN, "TranscriptEventRow.summary"),
  timestamp: isoDateTimeSchema,
  childRunSummary: ChildRunSummarySchema.optional(),
  omittedPatches: z.array(TranscriptOmittedPatchSchema).min(1).optional(),
};

// The open payload of the two non-boundary arms. It omits the `__proto__` pre-guard the event
// envelope applies: that guard protects what the log stores, and a transcript row is a read
// projection, so Zod's own drop of such a key is enough.
const projectedPayloadSchema = z.record(z.string(), z.unknown());

/**
 * `kind: "general"`, the non-run arm. It carries no run attribution, and `.strict()` refuses a
 * row that adds `runId`, `position`, `epoch` or `superseded`.
 */
export interface TranscriptEntry extends TranscriptEventRowBase {
  kind: "general";
}

/**
 * `kind: "run"`, the arm that requires attribution. `runId`, `position` and `epoch` are all
 * required, and the arm is chosen by `kind` first, so a partial row fails here and is never
 * retried as `general`. `position` is the originating run position, compared against a
 * rollback's cutoff. `epoch` is separate because re-execution reuses ordinals.
 */
export interface RunScopedTranscriptEntry extends TranscriptEventRowBase {
  kind: "run";
  runId: RunId;
  position: number;
  epoch: number;
  superseded?: SupersededMarker | undefined;
}

/**
 * `kind: "rollback_boundary"`, the `run.rolled_back` row, whose typed payload must agree with the
 * row's `runId`, `sessionId` and `position`. It omits the base's open `payload` rather than
 * intersecting it, since that intersection leaves a member no typed value satisfies.
 */
export interface TranscriptRollbackBoundary extends Omit<
  TranscriptEventRowBase,
  "category" | "type" | "payload"
> {
  kind: "rollback_boundary";
  /** Pinned with `type`: `run.rolled_back` is registered under this category only. */
  category: typeof TRANSCRIPT_RUN_LIFECYCLE_CATEGORY;
  runId: RunId;
  /** The boundary row's own originating position, the confirmed rewind floor. */
  position: number;
  /** The epoch the rollback rewound. */
  epoch: number;
  superseded?: SupersededMarker | undefined;
  type: typeof TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE;
  payload: RunRolledBackEvent;
}

// Cross-field rules shared by the arms

/**
 * The rollback event type belongs to the boundary arm only. Otherwise a `run` row with that
 * type would parse and reach a consumer narrowing on `kind` with its rewind cutoff untyped.
 */
const refuseBoundaryTypeOnNonBoundaryArm = (
  row: { type: string },
  issueContext: z.RefinementCtx,
): void => {
  if (row.type === TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE) {
    issueContext.addIssue({
      code: "custom",
      path: ["type"],
      message:
        `the ${TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE} event type is carried only by the ` +
        "rollback_boundary arm, whose payload is validated into the typed event; a row " +
        "carrying it under any other kind would deliver the rewind cutoff untyped",
    });
  }
};

/**
 * A superseded marker must supersede its row: the row's position exceeds the marker's cutoff.
 * Epoch is not compared; this ordering is the whole in-row invariant.
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

/**
 * Refuses on the `general` arm a row that belongs to a run, by its category, its type or a
 * payload naming a run: misfiled, it escapes run filters and rollback, so a superseded turn
 * shows as current.
 */
const refuseRunScopedRowOnGeneralArm = (
  row: { category: EventCategory; type: string; payload: Record<string, unknown> },
  issueContext: z.RefinementCtx,
): void => {
  if (row.category === TRANSCRIPT_RUN_LIFECYCLE_CATEGORY) {
    issueContext.addIssue({
      code: "custom",
      path: ["category"],
      message:
        `every ${TRANSCRIPT_RUN_LIFECYCLE_CATEGORY} event is run-scoped, so a row in that ` +
        "category belongs to the run arm and carries the full attribution triple; delivering " +
        "one under the general kind would present a run event as having no run identity",
    });
    return;
  }
  if (TRANSCRIPT_RUN_SCOPED_EVENT_TYPES.has(row.type)) {
    issueContext.addIssue({
      code: "custom",
      path: ["type"],
      message:
        `the canonical event type ${JSON.stringify(row.type)} names a run in every registered ` +
        "form of its payload, so a row of that type belongs to the run arm and carries the " +
        "full attribution triple; delivering one under the general kind would leave a " +
        "run-scoped row unreachable by run filtering and permanently current under rollback " +
        "projection",
    });
    return;
  }
  const carriedRunKey = TRANSCRIPT_RUN_ATTRIBUTION_PAYLOAD_KEYS.find(
    (payloadKey) => row.payload[payloadKey] !== undefined,
  );
  if (carriedRunKey !== undefined) {
    issueContext.addIssue({
      code: "custom",
      path: ["payload", carriedRunKey],
      message:
        `this row's payload names a run under ${JSON.stringify(carriedRunKey)}, so the row is ` +
        "run-attributed whatever its type; the general kind carries no outer runId, position, " +
        "or epoch, so the attribution would survive only inside an opaque payload that no " +
        "filter or rollback projection reads",
    });
  }
};

/**
 * The run arm refuses a payload that names a different run under either spelling in
 * {@link TRANSCRIPT_RUN_ATTRIBUTION_PAYLOAD_KEYS}. Reading only `runId` would let an intervention
 * row be filed under one run while its detail view names another.
 */
const requirePayloadRunIdentityToAgree = (
  row: { runId: RunId; payload: Record<string, unknown> },
  issueContext: z.RefinementCtx,
): void => {
  for (const attributionKey of TRANSCRIPT_RUN_ATTRIBUTION_PAYLOAD_KEYS) {
    const payloadRunIdentity = row.payload[attributionKey];
    if (payloadRunIdentity === undefined || payloadRunIdentity === row.runId) {
      continue;
    }
    issueContext.addIssue({
      code: "custom",
      path: ["payload", attributionKey],
      message:
        `payload ${attributionKey} ${JSON.stringify(payloadRunIdentity)} disagrees with the ` +
        `row's own runId ${JSON.stringify(row.runId)}: consumers filter and mark superseded ` +
        "on the outer value while the row's detail and provenance read the payload, so a row " +
        "that states two run identities is filed under one run and sourced from another",
    });
  }
};

/**
 * The run arm refuses a row whose payload contradicts its outer `runId`, `epoch` or `position`.
 * A row that names one run outside and another inside is filed under one and sourced from the
 * other. An echoed payload key that is absent passes; a disagreeing one fails, and the issue
 * path names the payload key because the payload copy is the derived one.
 */
const requirePayloadAttributionToAgree = (
  row: { runId: RunId; epoch: number; position: number; payload: Record<string, unknown> },
  issueContext: z.RefinementCtx,
): void => {
  requirePayloadRunIdentityToAgree(row, issueContext);
  const payloadEpoch = row.payload[SOURCE_EPOCH_PAYLOAD_KEY];
  if (payloadEpoch !== undefined && payloadEpoch !== row.epoch) {
    issueContext.addIssue({
      code: "custom",
      path: ["payload", SOURCE_EPOCH_PAYLOAD_KEY],
      message:
        `payload ${SOURCE_EPOCH_PAYLOAD_KEY} ${JSON.stringify(payloadEpoch)} disagrees with ` +
        `the row's own epoch ${String(row.epoch)}: the superseded marker is interpreted at the ` +
        "row's epoch, so a disagreeing origin epoch makes the rewind cutoff apply to a " +
        "different lineage than the one the row claims",
    });
  }
  const payloadPosition = row.payload[SOURCE_POSITION_PAYLOAD_KEY];
  if (payloadPosition !== undefined && payloadPosition !== row.position) {
    issueContext.addIssue({
      code: "custom",
      path: ["payload", SOURCE_POSITION_PAYLOAD_KEY],
      message:
        `payload ${SOURCE_POSITION_PAYLOAD_KEY} ${JSON.stringify(payloadPosition)} disagrees ` +
        `with the row's own position ${String(row.position)}: the superseded marker compares ` +
        "the rewind cutoff against the outer position, so a disagreeing origin position " +
        "decides supersession for a turn other than the one the payload describes",
    });
  }
};

const transcriptGeneralArmSchema = z
  .object({
    ...TRANSCRIPT_EVENT_ROW_COMMON_SHAPE,
    kind: z.literal("general"),
    payload: projectedPayloadSchema,
  })
  .strict()
  .superRefine((generalRow, issueContext) => {
    refuseBoundaryTypeOnNonBoundaryArm(generalRow, issueContext);
    refuseRunScopedRowOnGeneralArm(generalRow, issueContext);
  });

const runScopedTranscriptArmSchema = z
  .object({
    ...TRANSCRIPT_EVENT_ROW_COMMON_SHAPE,
    kind: z.literal("run"),
    runId: RunIdSchema,
    position: countSchema,
    epoch: countSchema,
    superseded: SupersededMarkerSchema.optional(),
    payload: projectedPayloadSchema,
  })
  .strict()
  .superRefine((runRow, issueContext) => {
    refuseBoundaryTypeOnNonBoundaryArm(runRow, issueContext);
    requireMarkerToOutrankRow(runRow, issueContext);
    requirePayloadAttributionToAgree(runRow, issueContext);
  });

const transcriptRollbackBoundaryArmSchema = z
  .object({
    // `category` and `type` below replace the base parsers by spread order: this arm carries
    // exactly one registered event. The base has no `payload`; each arm declares its own.
    ...TRANSCRIPT_EVENT_ROW_COMMON_SHAPE,
    kind: z.literal("rollback_boundary"),
    category: z.literal(TRANSCRIPT_RUN_LIFECYCLE_CATEGORY),
    runId: RunIdSchema,
    position: countSchema,
    epoch: countSchema,
    superseded: SupersededMarkerSchema.optional(),
    type: z.literal(TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE),
    payload: RunRolledBackEventSchema,
  })
  .strict()
  // The row and its payload agree on run, session and position. `.superRefine()` keeps this a
  // ZodObject, so it stays a valid `z.discriminatedUnion` option.
  .superRefine((boundaryRow, issueContext) => {
    const rolledBackEvent = boundaryRow.payload;
    if (boundaryRow.runId !== rolledBackEvent.runId) {
      issueContext.addIssue({
        code: "custom",
        path: ["runId"],
        message:
          "rollback_boundary row attribution disagrees with its payload: runId must equal " +
          "payload.runId, or the boundary would mark the wrong run's rows.",
      });
    }
    if (boundaryRow.sessionId !== rolledBackEvent.sessionId) {
      issueContext.addIssue({
        code: "custom",
        path: ["sessionId"],
        message:
          "rollback_boundary row attribution disagrees with its payload: sessionId must equal " +
          "payload.sessionId.",
      });
    }
    // A later, lower rollback can supersede the boundary row itself, so its marker follows the
    // same ordering rule.
    requireMarkerToOutrankRow(boundaryRow, issueContext);
    if (boundaryRow.position !== rolledBackEvent.targetPosition) {
      issueContext.addIssue({
        code: "custom",
        path: ["position"],
        message:
          "rollback_boundary row attribution disagrees with its payload: position must equal " +
          "payload.targetPosition, the confirmed rewind floor.",
      });
    }
  });

/**
 * The row union every transcript read returns, discriminated on the literal `kind`. Consumers
 * narrow on `kind`, never on the free-form `type` and never by casting.
 */
export type TranscriptEventRow =
  | TranscriptRollbackBoundary
  | RunScopedTranscriptEntry
  | TranscriptEntry;

/**
 * Parses a {@link TranscriptEventRow}. The arm is chosen by `kind`, so a failure is reported
 * against that arm and never retried against a sibling.
 */
export const TranscriptEventRowSchema: z.ZodType<TranscriptEventRow> = z.discriminatedUnion(
  "kind",
  [transcriptRollbackBoundaryArmSchema, runScopedTranscriptArmSchema, transcriptGeneralArmSchema],
);
