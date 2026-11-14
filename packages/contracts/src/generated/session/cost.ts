// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A session's spend: the committed figure and each agent's share of it, and the cost receipt the inspector reads by provider and account, all in whole micro-dollars.

import type { AgentTreeMember } from "../agent/tree.js";
import type { BillingMode, ProviderAccountId } from "../provider/account/record.js";
import type { ProviderId } from "../provider/id.js";
import type { SessionId } from "./id.js";

/**
 * A cost in whole micro-dollars, the one money unit on the wire.
 */
export type UsdMicros = number;
/**
 * A `Tokens per run` limit: input and output tokens together, for one run; at least one.
 */
export type TokensPerRun = number;

/**
 * One agent's spend in the session's tree, the lead included: `ownUsdMicros` is what its own
 * requests cost, and `subtreeUsdMicros` that plus every descendant's at any depth. A helper
 * request, such as a reviewer's, counts on the agent it belongs to.
 */
export interface AgentSpend {
  /**
   * The agent.
   */
  agent: AgentTreeMember;
  /**
   * What the agent's own requests cost.
   */
  ownUsdMicros: UsdMicros;
  /**
   * The agent's own spend plus every descendant's; never less than its own.
   */
  subtreeUsdMicros: UsdMicros;
}
/**
 * The session's two limits, its committed spend and each agent's share of it. A limit of `null`
 * is `Unlimited`. The committed figure is the one session cost every screen shows, never a sum a
 * client takes over the rows it holds.
 */
export interface SessionBudgetState {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The spend limit, or `null` for `Unlimited`.
   */
  spendLimitUsdMicros: UsdMicros | null;
  /**
   * The `Tokens per run` limit, or `null` for `Unlimited`.
   */
  tokensPerRun: TokensPerRun | null;
  /**
   * The session's committed spend.
   */
  committedSpendUsdMicros: UsdMicros;
  /**
   * Each agent's spend.
   */
  agentSpend: AgentSpend[];
}
/**
 * The session whose spend `session.budget.read` answers with.
 */
export interface SessionBudgetReadRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * The session whose cost receipt `session.costReceipt.read` answers with.
 */
export interface SessionCostReceiptReadRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * One provider account's spend: its tokens and its dollars. `billingMode` labels the figure and
 * never changes how it is derived; `unknown` is never presented as billed dollars.
 */
export interface SessionCostReceiptAccountRow {
  /**
   * The account.
   */
  providerAccountId: ProviderAccountId;
  /**
   * How the account is charged.
   */
  billingMode: BillingMode;
  /**
   * The tokens the session spent on the account.
   */
  tokens: number;
  /**
   * What those tokens cost.
   */
  usdMicros: UsdMicros;
}
/**
 * A provider's voice calls: their length and their cost at the voice model's price.
 */
export interface SessionCostReceiptVoiceRow {
  /**
   * How long the calls ran, in seconds.
   */
  seconds: number;
  /**
   * What the calls cost.
   */
  usdMicros: UsdMicros;
}
/**
 * One provider the session spent on: a row per account it spent on, its voice row where the
 * session made voice calls on it, and a subtotal the daemon computes.
 */
export interface SessionCostReceiptProvider {
  /**
   * The provider.
   */
  providerName: ProviderId;
  /**
   * A row per account the session spent on.
   */
  accounts: SessionCostReceiptAccountRow[];
  /**
   * The provider's voice calls, where the session made any.
   */
  voice?: SessionCostReceiptVoiceRow;
  /**
   * The provider's subtotal.
   */
  subtotalUsdMicros: UsdMicros;
}
/**
 * The session's spend, decomposed by provider and account, beside the committed figure it adds up
 * to. Providers are in the order the session first spent on them, the session's own provider
 * first; a session that has spent nothing has none.
 */
export interface SessionCostReceipt {
  /**
   * The session's committed spend and limits.
   */
  sessionTotal: SessionBudgetState;
  /**
   * The providers the session spent on.
   */
  providers: SessionCostReceiptProvider[];
}

export { validateTokensPerRun, validateUsdMicros } from "../checks/session/cost.js";
