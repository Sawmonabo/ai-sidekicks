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
// WHAT IS DELIBERATELY ABSENT: a barrier identifier. §7.6 states the wait-for-all
// barrier, and no member of this reply groups the requests one turn raised. The
// pane states the rule in copy rather than inventing a field to group by, because
// a fabricated grouping key would silently claim that two unrelated requests must
// resolve together.

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
  readonly approvalRequestId: string;
  readonly category: string;
  readonly state: string;
  readonly requestedBy: string;
  readonly requestedScope: string;
  readonly resourceDescriptor?: string | undefined;
  readonly expiryAt?: string | undefined;
  readonly resolvedAt?: string | undefined;
  readonly decision?: string | undefined;
  readonly approverId?: string | undefined;
  readonly effectiveScope?: string | undefined;
  readonly rememberedScope?: string | undefined;
  readonly askId?: string | undefined;
  readonly auditMetadata?: Readonly<Record<string, string>> | undefined;
}

const approvalRecordSchema: z.ZodType<ApprovalRecord> = z
  .object({
    approvalRequestId: z.string().min(1),
    category: z.string().min(1),
    state: z.string().min(1),
    requestedBy: z.string().min(1),
    requestedScope: z.string().min(1),
    /** The command, path, or tool arguments the decision is about. */
    resourceDescriptor: z.string().optional(),
    /** Verbatim. The console performs no expiry arithmetic of its own. */
    expiryAt: z.string().optional(),
    resolvedAt: z.string().optional(),
    decision: z.string().optional(),
    approverId: z.string().optional(),
    effectiveScope: z.string().optional(),
    /** Present where the resolution minted a rule. */
    rememberedScope: z.string().optional(),
    /**
     * The originating driver ask, present on a permission-kind ask normalized into
     * the approval model (§7.8). Its presence is what routes a record to the ask
     * card; its absence is an ordinary approval.
     */
    askId: z.string().optional(),
    auditMetadata: z.record(z.string(), z.string()).optional(),
  })
  .loose();

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

const approvalProjectionSchema = z.object({ requests: z.array(z.unknown()) });
const rememberedRuleListSchema = z.object({ rules: z.array(z.unknown()) });

/**
 * Narrow an `approval.projectionRead` reply.
 *
 * Throws on a reply that is not even shaped like the read — a caller renders that
 * as a refusal, because a reply with no `requests` array is the daemon answering
 * something else entirely and an empty list would report it as "nothing pending".
 */
export function readApprovalProjection(reply: unknown): ParsedRows<ApprovalRecord> {
  return parseRows(approvalProjectionSchema.parse(reply).requests, approvalRecordSchema);
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
