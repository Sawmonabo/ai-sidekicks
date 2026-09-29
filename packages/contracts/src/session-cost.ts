// A session's cost receipt: who a unit of work is attributed to, the request for the
// receipt, and the members of its run and account rows that fix what each row claims.
import { z } from "zod";

import type { BillingMode, ProviderAccountId } from "./provider-account.js";
import type { RunId } from "./provider-driver.js";
import { SessionIdSchema, UserIdSchema, type SessionId, type UserId } from "./session.js";

/**
 * The party a unit of work is attributed to, resolved by the daemon for each turn and
 * never supplied by a client or a driver.
 *
 * Two closed arms, the user reference required on the user arm and absent on the
 * system arm, rather than one nullable id: an unstamped value and a deliberately
 * unattributed one would otherwise be the same shape. Spend no user caused, such as
 * a sweep, an idle settlement or a recovery turn, lands on the `system` arm.
 */
export type EffectivePrincipal = { kind: "user"; userId: UserId } | { kind: "system" };
/** Parses an {@link EffectivePrincipal}; a `system` arm carrying a user is refused. */
export const EffectivePrincipalSchema: z.ZodType<EffectivePrincipal, EffectivePrincipal> =
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("user"), userId: UserIdSchema }).strict(),
    z.object({ kind: z.literal("system") }).strict(),
  ]);

/** The session whose cost receipt `orchestration.costReceiptRead` answers with. */
export interface SessionCostReceiptRequest {
  sessionId: SessionId;
}
/** Parses a {@link SessionCostReceiptRequest}. */
export const SessionCostReceiptRequestSchema: z.ZodType<
  SessionCostReceiptRequest,
  SessionCostReceiptRequest
> = z.object({ sessionId: SessionIdSchema }).strict();

/**
 * One run's row on the receipt.
 *
 * `aggregationScope` is required and closed at one value: the receipt is the one
 * surface that shows run-scoped cost, and every row declaring it is what lets that be
 * checked positively rather than by nobody having added a second scope.
 */
export interface SessionCostReceiptRunRow {
  runId: RunId;
  aggregationScope: "run-only";
}

/**
 * One provider account's row on the receipt. `billingMode` labels the figure and
 * never changes how it is derived; `unknown` is never presented as billed dollars.
 */
export interface SessionCostReceiptAccountRow {
  providerAccountId: ProviderAccountId;
  billingMode: BillingMode;
}
