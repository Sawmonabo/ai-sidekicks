// What the two approval reads answer with, and the one place an `unknown` reply
// becomes something this surface may render.
//
// `SidekicksBridge.daemon.call` answers `DaemonResult<M>`, which resolves to
// `unknown` until Plan-007's method union lands, and `packages/contracts` registers
// no approval payload at all — so a surface that rendered whatever arrived would
// render a row for a malformed emission as confidently as for a real one. Every
// field below is parsed before it reaches a component, on the same posture
// `shell/composer/.../queue-feed.ts` takes with the registered queue schema.
//
// TWO DECISIONS THIS MODULE MAKES ON PURPOSE.
//
//   • **Wire strings stay strings.** `category` and `state` are parsed as `string`
//     and classified at render time through `approval-vocabulary.ts`. Parsing them
//     as enums would make one unrecognized token drop a whole record, and §7.6's
//     history rule is that an unfiltered read renders every record it returns and
//     drops nothing.
//   • **A malformed record is dropped and COUNTED, never silently skipped.** The
//     count is what the pane renders beside the list, because "the daemon returned
//     eleven and we could read nine" is a fact an operator has to be able to see.
//
//   • **The registered reply is ADAPTED here, at one boundary.** The daemon answers
//     `{ approvals: [{ id, runId, requestedBy, category, scope, resourceDescriptor,
//     state, createdAt, updatedAt, ... }] }`, and this module is the only place that
//     shape becomes the shape a component reads. `id` keeps the console-side name
//     `approvalRequestId` because that is what the registered resolve REQUEST calls
//     the same value, so the rename is an adaptation between two registered spellings
//     of one identity rather than drift; `scope` keeps the console-side name
//     `requestedScope` because the reply carries a second scope — `effectiveScope` —
//     and one word for two of them is how a surface starts showing the granted scope
//     where the requested one belongs.
//
// WHAT IS DELIBERATELY ABSENT: a barrier identifier. §7.6 states the wait-for-all
// barrier, and no member of this reply groups the requests one turn raised. The
// pane states the rule in copy rather than inventing a field to group by, because
// a fabricated grouping key would silently claim that two unrelated requests must
// resolve together.
//
// AND TWO MEMBERS THAT ARE NOT ON THIS READ AT ALL. `askId` is registered on the
// approval-flow EVENT payload and persisted on the request row; `auditMetadata` is a
// member of the resolve REQUEST. Neither is on the projection reply, so neither is a
// member of the record below — a console cannot render a distinction the read it made
// does not carry, and a member kept alive by a fixture is a member kept alive by
// nothing.

import { z } from "zod";

/**
 * One approval record, as this surface holds it.
 *
 * Written out rather than inferred from the schema below because
 * `isolatedDeclarations` needs the exported shape to be readable without running
 * the checker over zod's inference — and because the resolved quad is FOUR
 * independently-optional members rather than a nested object, which is how the
 * reply carries them and what makes the pane's claim about their PRESENCE
 * checkable: a record that says `approved` and carries no `resolvedAt` is one the
 * console renders as incomplete rather than as resolved-at-unknown.
 */
export interface ApprovalRecord {
  /** The reply's `id`. Named as the registered resolve REQUEST names the same value. */
  readonly approvalRequestId: string;
  /** Which run raised this. Required on the wire, and the first thing anyone asks. */
  readonly runId: string;
  readonly category: string;
  readonly state: string;
  readonly requestedBy: string;
  /** The reply's `scope` — what was asked for, never what was granted. */
  readonly requestedScope: string;
  /**
   * The audit-grade target, required and structured. A row carrying a string here,
   * or nothing, is a row this build cannot read — counted, never rendered as a
   * decision about an action nobody can see.
   */
  readonly resourceDescriptor: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  /** The last state-transition instant. Expired and canceled rows settle here. */
  readonly updatedAt: string;
  readonly expiryAt?: string | undefined;
  readonly resolvedAt?: string | undefined;
  readonly decision?: string | undefined;
  readonly approverId?: string | undefined;
  readonly effectiveScope?: string | undefined;
  /** Present where the resolution minted a rule; the shape the rule list carries. */
  readonly rememberedScope?: RememberedScope | undefined;
}

/**
 * Every member of {@link ApprovalRecord}, as a value.
 *
 * A closed set has to be countable at runtime for a test to hold it, and the claim
 * this list carries is that the record's member set IS the registered reply's — so a
 * member invented back in fails an assertion rather than quietly reaching a card.
 * The annotation does the other half: a name the interface does not carry is a
 * compile error here rather than a string nobody checks.
 */
export const APPROVAL_RECORD_MEMBERS: readonly (keyof ApprovalRecord)[] = [
  "approvalRequestId",
  "runId",
  "category",
  "state",
  "requestedBy",
  "requestedScope",
  "resourceDescriptor",
  "createdAt",
  "updatedAt",
  "expiryAt",
  "resolvedAt",
  "decision",
  "approverId",
  "effectiveScope",
  "rememberedScope",
];

/** What a remembered rule covers. `kind` is a wire string, classified at render. */
export interface RememberedScope {
  readonly kind: string;
  /** Absent means category-wide within the boundary, and the surface says so. */
  readonly pattern?: string | undefined;
}

const rememberedScopeSchema: z.ZodType<RememberedScope> = z
  .object({
    kind: z.string().min(1),
    pattern: z.string().optional(),
  })
  .loose();

/**
 * The registered projection row, and the one place its spelling becomes ours.
 *
 * Loose rather than strict: a member this build does not know is a member a later
 * daemon added, and refusing the whole row over one would turn an additive wire
 * change into an approvals pane that renders nothing. The transform then builds the
 * record EXPLICITLY, so an unknown member is dropped at the boundary instead of
 * riding along into a component that never declared it.
 */
const approvalRecordSchema: z.ZodType<ApprovalRecord> = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    requestedBy: z.string().min(1),
    category: z.string().min(1),
    scope: z.string().min(1),
    resourceDescriptor: z.record(z.string(), z.unknown()),
    state: z.string().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    /** Verbatim. The console performs no expiry arithmetic of its own. */
    expiryAt: z.string().optional(),
    resolvedAt: z.string().optional(),
    decision: z.string().optional(),
    approverId: z.string().optional(),
    effectiveScope: z.string().optional(),
    rememberedScope: rememberedScopeSchema.optional(),
  })
  .loose()
  .transform(
    (row): ApprovalRecord => ({
      approvalRequestId: row.id,
      runId: row.runId,
      category: row.category,
      state: row.state,
      requestedBy: row.requestedBy,
      requestedScope: row.scope,
      resourceDescriptor: row.resourceDescriptor,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      expiryAt: row.expiryAt,
      resolvedAt: row.resolvedAt,
      decision: row.decision,
      approverId: row.approverId,
      effectiveScope: row.effectiveScope,
      rememberedScope: row.rememberedScope,
    }),
  );

/** One standing permission, as this surface holds it. */
export interface RememberedRule {
  readonly ruleId: string;
  readonly sessionId: string;
  /** The GRANTOR. An audit and membership-invalidation key, never a match key. */
  readonly participantId: string;
  readonly nodeId: string;
  /** Present exactly when the scope kind is `run`. */
  readonly runId?: string | undefined;
  readonly category: string;
  readonly scope: RememberedScope;
  readonly grantedAt: string;
  readonly revokedAt?: string | undefined;
  readonly invalidationTrigger?: string | undefined;
}

const rememberedRuleSchema: z.ZodType<RememberedRule> = z
  .object({
    ruleId: z.string().min(1),
    sessionId: z.string().min(1),
    participantId: z.string().min(1),
    nodeId: z.string().min(1),
    runId: z.string().optional(),
    category: z.string().min(1),
    scope: rememberedScopeSchema,
    grantedAt: z.string().min(1),
    revokedAt: z.string().optional(),
    invalidationTrigger: z.string().optional(),
  })
  .loose();

/**
 * A read that answered, with what it could not read counted rather than hidden.
 *
 * `unreadableCount` is not an error state. The read succeeded; some rows were
 * shaped in a way this build cannot render, and both halves of that are true at
 * once — which is exactly the conflation `Spec-023 §Console Design (Meridian)`
 * rule 8 exists to prevent.
 */
export interface ParsedRows<TRow> {
  readonly rows: readonly TRow[];
  readonly unreadableCount: number;
}

const approvalProjectionSchema = z.object({ approvals: z.array(z.unknown()) });
const rememberedRuleListSchema = z.object({ rules: z.array(z.unknown()) });

/**
 * Narrow an `approval.projectionRead` reply.
 *
 * Throws on a reply that is not even shaped like the read — a caller renders that
 * as a refusal, because a reply with no `approvals` array is the daemon answering
 * something else entirely and an empty list would report it as "nothing pending".
 */
export function readApprovalProjection(reply: unknown): ParsedRows<ApprovalRecord> {
  return parseRows(approvalProjectionSchema.parse(reply).approvals, approvalRecordSchema);
}

/** Narrow an `approval.ruleList` reply. Throws for `readApprovalProjection`'s reason. */
export function readRememberedRuleList(reply: unknown): ParsedRows<RememberedRule> {
  return parseRows(rememberedRuleListSchema.parse(reply).rules, rememberedRuleSchema);
}

function parseRows<TRow>(
  candidates: readonly unknown[],
  schema: z.ZodType<TRow>,
): ParsedRows<TRow> {
  const rows: TRow[] = [];
  let unreadableCount = 0;
  for (const candidate of candidates) {
    const parsed = schema.safeParse(candidate);
    if (parsed.success) {
      rows.push(parsed.data);
    } else {
      unreadableCount += 1;
    }
  }
  return { rows, unreadableCount };
}

/**
 * Whether a record's resolved quad is complete.
 *
 * §7.6 requires the quad "present exactly when the state is `approved` or
 * `rejected`", so a resolved record missing a member of it is a record the surface
 * labels rather than renders as if it were whole.
 */
export function hasCompleteResolvedQuad(record: ApprovalRecord): boolean {
  return (
    record.resolvedAt !== undefined &&
    record.decision !== undefined &&
    record.approverId !== undefined &&
    record.effectiveScope !== undefined
  );
}

/** True for the two states the resolved quad is required on. */
export function isResolvedState(state: string): boolean {
  return state === "approved" || state === "rejected";
}
