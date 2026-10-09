// A session's spend: the committed figure and each agent's share of it, and the cost receipt the
// inspector reads by provider and account.
//
// Every amount is integer micro-dollars. Each request is priced once, when it completes, and
// never repriced, so small requests add up exactly and a figure is rounded once, where it is
// drawn. The budget read and the receipt come from one fold over the per-turn usage rows, so
// the two cannot disagree.
import { z } from "zod";

import { AgentTreeMemberSchema, type AgentTreeMember } from "../agent/tree.js";
import {
  BillingModeSchema,
  ProviderAccountIdSchema,
  type BillingMode,
  type ProviderAccountId,
} from "../provider/account/record.js";
import { ProviderNameSchema, type ProviderName } from "../provider/name.js";
import { SessionIdSchema, type SessionId } from "./id.js";
import { countSchema } from "../internal/wire-scalars.js";

/** A cost in whole micro-dollars, the one money unit on the wire. */
export const UsdMicrosSchema: z.ZodType<number, number> = countSchema;

/** A `Tokens per run` limit: input and output tokens together, for one run; at least one. */
export const TokensPerRunSchema: z.ZodType<number, number> = z.number().int().positive();

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
 * The session's two limits, its committed spend and each agent's share of it. A limit of `null`
 * is `Unlimited`. The committed figure is the one session cost every screen shows, never a sum a
 * client takes over the rows it holds.
 */
export interface OrchestrationBudgetState {
  sessionId: SessionId;
  spendLimitUsdMicros: number | null;
  tokensPerRun: number | null;
  committedSpendUsdMicros: number;
  agentSpend: AgentSpend[];
}
/** Parses an {@link OrchestrationBudgetState}. */
export const OrchestrationBudgetStateSchema: z.ZodType<OrchestrationBudgetState> = z
  .object({
    sessionId: SessionIdSchema,
    spendLimitUsdMicros: UsdMicrosSchema.nullable(),
    tokensPerRun: TokensPerRunSchema.nullable(),
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
    tokens: countSchema,
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
  driverName: ProviderName;
  accounts: SessionCostReceiptAccountRow[];
  voice?: SessionCostReceiptVoiceRow | undefined;
  subtotalUsdMicros: number;
}
/** Parses a {@link SessionCostReceiptProvider}. */
export const SessionCostReceiptProviderSchema: z.ZodType<SessionCostReceiptProvider> = z
  .object({
    driverName: ProviderNameSchema,
    accounts: z.array(SessionCostReceiptAccountRowSchema),
    voice: z.object({ seconds: countSchema, usdMicros: UsdMicrosSchema }).strict().optional(),
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
