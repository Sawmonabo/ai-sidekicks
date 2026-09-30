// A session's spend: the committed figure and each agent's share of it, the cost receipt the
// inspector reads by provider and account, and who a unit of work is attributed to.
//
// Every amount is integer micro-dollars. Each request is priced once, when it completes, and
// never repriced, so small requests add up exactly and a figure is rounded once, where it is
// drawn. The budget read and the receipt come from one fold over the per-turn usage rows, so
// the two cannot disagree.
import { z } from "zod";

import { AgentTreeMemberSchema, type AgentTreeMember } from "./agent.js";
import {
  BillingModeSchema,
  ProviderAccountIdSchema,
  type BillingMode,
  type ProviderAccountId,
} from "./provider-account.js";
import { DRIVER_WIRE_TOKEN_MAX_LEN } from "./provider-driver-wire.js";
import {
  SessionIdSchema,
  UserIdSchema,
  wireFreeFormString,
  type SessionId,
  type UserId,
} from "./session.js";

/** A cost in whole micro-dollars, the one money unit on the wire. */
export const UsdMicrosSchema: z.ZodType<number, number> = z.number().int().nonnegative();

/**
 * The party a unit of work is attributed to, resolved by the daemon for each turn and never
 * supplied by a client or a driver. Two arms rather than one nullable id, so an unstamped value
 * and a deliberately unattributed one differ in shape. Spend no user caused, such as a sweep, an
 * idle settlement or a recovery turn, lands on the `system` arm.
 */
export type EffectivePrincipal = { kind: "user"; userId: UserId } | { kind: "system" };
/** Parses an {@link EffectivePrincipal}; a `system` arm carrying a user is refused. */
export const EffectivePrincipalSchema: z.ZodType<EffectivePrincipal, EffectivePrincipal> =
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("user"), userId: UserIdSchema }).strict(),
    z.object({ kind: z.literal("system") }).strict(),
  ]);

// orchestration.budgetRead

/**
 * One agent's spend in the session's tree, the lead included: `ownUsdMicros` is what its own
 * requests cost, and `subtreeUsdMicros` that plus every descendant's at any depth. A helper
 * request, such as a reviewer's, counts on the agent it belongs to.
 */
export interface AgentSpend {
  agent: AgentTreeMember;
  ownUsdMicros: number;
  subtreeUsdMicros: number;
}
/** Parses an {@link AgentSpend}; a subtree never costs less than its own agent. */
export const AgentSpendSchema: z.ZodType<AgentSpend> = z
  .object({
    agent: AgentTreeMemberSchema,
    ownUsdMicros: UsdMicrosSchema,
    subtreeUsdMicros: UsdMicrosSchema,
  })
  .strict()
  .refine((spend) => spend.subtreeUsdMicros >= spend.ownUsdMicros, {
    path: ["subtreeUsdMicros"],
    message: "A subtree's spend includes its own agent's.",
  });

/**
 * The session's committed spend and each agent's share of it. The committed figure is the one
 * session cost every surface shows, never a sum a client takes over the rows it holds.
 */
export interface OrchestrationBudgetState {
  sessionId: SessionId;
  committedSpendUsdMicros: number;
  agentSpend: AgentSpend[];
}
/** Parses an {@link OrchestrationBudgetState}. */
export const OrchestrationBudgetStateSchema: z.ZodType<OrchestrationBudgetState> = z
  .object({
    sessionId: SessionIdSchema,
    committedSpendUsdMicros: UsdMicrosSchema,
    agentSpend: z.array(AgentSpendSchema),
  })
  .strict();

/** The session whose spend `orchestration.budgetRead` answers with. */
export interface OrchestrationBudgetReadRequest {
  sessionId: SessionId;
}
/** Parses an {@link OrchestrationBudgetReadRequest}. */
export const OrchestrationBudgetReadRequestSchema: z.ZodType<
  OrchestrationBudgetReadRequest,
  OrchestrationBudgetReadRequest
> = z.object({ sessionId: SessionIdSchema }).strict();

// orchestration.costReceiptRead

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
 * One provider account's spend: its tokens and its dollars. `billingMode` labels the figure and
 * never changes how it is derived; `unknown` is never presented as billed dollars.
 */
export interface SessionCostReceiptAccountRow {
  providerAccountId: ProviderAccountId;
  billingMode: BillingMode;
  tokens: number;
  usdMicros: number;
}
/** Parses a {@link SessionCostReceiptAccountRow}. */
export const SessionCostReceiptAccountRowSchema: z.ZodType<SessionCostReceiptAccountRow> = z
  .object({
    providerAccountId: ProviderAccountIdSchema,
    billingMode: BillingModeSchema,
    tokens: z.number().int().nonnegative(),
    usdMicros: UsdMicrosSchema,
  })
  .strict();

/** A provider's voice calls: their length and their cost at the voice model's price. */
export interface SessionCostReceiptVoiceRow {
  seconds: number;
  usdMicros: number;
}

/**
 * One provider the session spent on: a row per account it spent on, its voice row where the
 * session made voice calls on it, and a subtotal the daemon computes.
 */
export interface SessionCostReceiptProvider {
  driverName: string;
  accounts: SessionCostReceiptAccountRow[];
  voice?: SessionCostReceiptVoiceRow | undefined;
  subtotalUsdMicros: number;
}
/** Parses a {@link SessionCostReceiptProvider}. */
export const SessionCostReceiptProviderSchema: z.ZodType<SessionCostReceiptProvider> = z
  .object({
    driverName: wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, "driverName"),
    accounts: z.array(SessionCostReceiptAccountRowSchema),
    voice: z
      .object({ seconds: z.number().int().nonnegative(), usdMicros: UsdMicrosSchema })
      .strict()
      .optional(),
    subtotalUsdMicros: UsdMicrosSchema,
  })
  .strict();

/**
 * The session's spend, decomposed by provider and account, beside the committed figure it adds
 * up to. Providers are in the order the session first spent on them, the session's own provider
 * first; a session that has spent nothing has none.
 */
export interface SessionCostReceipt {
  sessionTotal: OrchestrationBudgetState;
  providers: SessionCostReceiptProvider[];
}
/** Parses a {@link SessionCostReceipt}. */
export const SessionCostReceiptSchema: z.ZodType<SessionCostReceipt> = z
  .object({
    sessionTotal: OrchestrationBudgetStateSchema,
    providers: z.array(SessionCostReceiptProviderSchema),
  })
  .strict();
