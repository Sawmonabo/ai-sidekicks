// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The payloads of the usage telemetry events: the three metered readings, an account's quota snapshot, a provider's retry, a compaction of a run's context, and the provider's move of a turn onto another model.

import type { AgentId } from "../agent/definition.js";
import type { ContextWindowSource } from "../context-window.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import type { CredentialGeneration, ProviderAccountId } from "../provider/account/record.js";
import type { ProviderId } from "../provider/id.js";
import type { RunId } from "../run/id.js";
import type { SubagentId } from "../run/subagent.js";
import type { UsdMicros } from "../session/cost.js";
import type { SessionId } from "../session/id.js";
import type { SourceEpoch, SourcePosition } from "./envelope.js";

/**
 * Whether a usage row's input figure has the cache's read and written tokens taken out of it:
 * taken out where the provider's breakdown showed them inside its input, else left in.
 */
export type UsageContainment = "confirmedSubtracted" | "unconfirmedUnsubtracted";
/**
 * Where a priced request's figure came from; converts to its wire word.
 */
export type UsageCostSource = "providerReported" | "derivedExact";
/**
 * Why a provider retried a request mid-run, in the vocabulary every provider's retry is read
 * into; `unknown` holds a cause the provider names that the vocabulary lacks.
 */
export type ApiRetryErrorKind =
  | "authenticationFailed"
  | "oauthOrgNotAllowed"
  | "billingError"
  | "rateLimit"
  | "overloaded"
  | "invalidRequest"
  | "modelNotFound"
  | "serverError"
  | "maxOutputTokens"
  | "accountOnHold"
  | "verificationRequired"
  | "cloudCredentialError"
  | "unknown";
/**
 * How long a provider's move onto another model holds.
 */
export type ModelRerouteScope = "turn" | "session" | "local";
/**
 * Why the provider moved a turn onto another model.
 */
export type ModelRerouteCause = "safety" | "modelUnavailable" | "modelBlocked" | "outOfCredits";

/**
 * The `usage.tokenCount.recorded` payload: one turn's own token figures, never a running total, so
 * a run's or a session's total is the sum of its rows. A count is absent when the provider
 * reported none, never zero. The account is the one the turn was charged to: the account its
 * runtime binding names when the reading is recorded, never the provider's word, so a turn that
 * spans an account switch records its readings on each side of the switch under each account.
 */
export interface UsageTokenCountRecordedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run, absent on a turn no run owns.
   */
  runId?: RunId;
  /**
   * The turn's total, when the provider gives one.
   */
  tokenCount?: number;
  /**
   * The input tokens.
   */
  inputTokens?: number;
  /**
   * The output tokens.
   */
  outputTokens?: number;
  /**
   * The input tokens read from the provider's cache.
   */
  cacheReadTokens?: number;
  /**
   * The input tokens written to the provider's cache.
   */
  cacheWriteTokens?: number;
  /**
   * The reasoning tokens.
   */
  reasoningTokens?: number;
  /**
   * Whether `input_tokens` has the cache's read and written tokens taken out.
   */
  containment: UsageContainment;
  /**
   * The account the turn was charged to: its binding's account when the reading was recorded.
   */
  providerAccountId: ProviderAccountId;
  /**
   * The account's credential generation seen with the turn.
   */
  credentialGeneration: CredentialGeneration;
  /**
   * The model the provider attributes the reading to, absent when it attributes only
   * the run.
   */
  modelId?: string;
  /**
   * The subagent the provider attributes the reading to, paired with its start on the
   * run, the provider and this id.
   */
  subagentId?: SubagentId;
  /**
   * The provider's id of the request the row belongs to, shared by every row of that request;
   * absent where the provider names none.
   */
  requestKey?: string;
  /**
   * The speed tier the request ran at, in the provider's word; absent where it gave none.
   */
  speed?: string;
  /**
   * The region the request was processed in, in the driver's region word; absent for none.
   */
  processingRegion?: string;
  /**
   * The part of `cacheWriteTokens` written at the longer cache lifetime; absent where the
   * provider gave no split.
   */
  cacheWriteExtendedTokens?: number;
  /**
   * The web searches the request ran.
   */
  webSearchRequests?: number;
  /**
   * The speed tier the reading's thread declared when the reading was taken, which prices the
   * requests of helpers that thread spawned; absent where none was declared.
   */
  threadSpeed?: string;
  /**
   * The execution epoch a late row is attributed to; comes with `sourcePosition` and
   * `runId`.
   */
  sourceEpoch?: SourceEpoch;
  /**
   * The run position the row occupies within its epoch; comes with `sourceEpoch`.
   */
  sourcePosition?: SourcePosition;
}
/**
 * One token event's share of a priced request: the `usage.tokenCount.recorded` event and its
 * figure in whole millionths of a US dollar.
 */
export interface UsagePricedEvent {
  /**
   * The token event's id.
   */
  eventId: string;
  /**
   * Its share of the request's price.
   */
  costUsdMicros: UsdMicros;
}
/**
 * The `usage.cost.updated` payload: one priced request on one account, priced once and never
 * again; `costUsdMicros` is the sum of `pricedEvents`' figures.
 */
export interface UsageCostUpdatedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run every one of the account's rows of the request was counted toward; absent where
   * they name different runs or none. Each row's own run is on the token event `pricedEvents`
   * names.
   */
  runId?: RunId;
  /**
   * The request's price on the account in whole millionths of a US dollar: the sum of
   * `pricedEvents`' figures.
   */
  costUsdMicros: UsdMicros;
  /**
   * Where the figure came from.
   */
  costSource: UsageCostSource;
  /**
   * The account's token events of the request, each with its share of the figure.
   *
   * @minItems 1
   */
  pricedEvents: [UsagePricedEvent, ...UsagePricedEvent[]];
  /**
   * The model the request was priced at.
   */
  modelId?: string;
  /**
   * The helper every one of the account's rows of the request was attributed to; absent where
   * they name different helpers or none. Each row's own helper is on the token event
   * `pricedEvents` names.
   */
  subagentId?: SubagentId;
  /**
   * The execution epoch a late row is attributed to; comes with `sourcePosition` and
   * `runId`.
   */
  sourceEpoch?: SourceEpoch;
  /**
   * The run position the row occupies within its epoch; comes with `sourceEpoch`.
   */
  sourcePosition?: SourcePosition;
}
/**
 * The `usage.contextWindow.updated` payload: the context window's reading. The two counts
 * travel together, absent only where the provider gave none (a bare signal that the window is
 * exceeded), and are never estimated.
 */
export interface UsageContextWindowUpdatedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run, absent on a turn no run owns.
   */
  runId?: RunId;
  /**
   * The tokens the conversation uses; comes with `windowMaxTokens`.
   */
  windowUsedTokens?: number;
  /**
   * The tokens the window holds; comes with `windowUsedTokens`.
   */
  windowMaxTokens?: number;
  /**
   * Where the window's figures came from.
   */
  windowSource: ContextWindowSource;
  /**
   * Whether the provider's own reading shows the conversation past the window.
   */
  exceeded: boolean;
  /**
   * The model the provider attributes the reading to, absent when it attributes only
   * the run.
   */
  modelId?: string;
  /**
   * The subagent the provider attributes the reading to, paired with its start on the
   * run, the provider and this id.
   */
  subagentId?: SubagentId;
  /**
   * The execution epoch a late row is attributed to; comes with `sourcePosition` and
   * `runId`.
   */
  sourceEpoch?: SourceEpoch;
  /**
   * The run position the row occupies within its epoch; comes with `sourceEpoch`.
   */
  sourcePosition?: SourcePosition;
}
/**
 * One window of an account's whole set of quota readings: its limit, absent naming the default
 * limit, and its length in minutes.
 */
export interface UsageRateLimitWindowKey {
  /**
   * Which of the account's limits the window belongs to; absent names the default limit.
   */
  limitId?: string;
  /**
   * The window's length in minutes.
   */
  windowMins: number;
}
/**
 * The `usage.rateLimit.updated` payload: a snapshot of one of an account's quotas, keyed by the
 * account, `limitId` and `windowMins`. It names no session and no run; the envelope binds it to
 * the machine's sentinel session, and its `occurredAt` is when the quota was read. A display
 * reading only, never an input to a security or admission decision.
 */
export interface UsageRateLimitUpdatedPayload {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The account the quota belongs to.
   */
  providerAccountId: ProviderAccountId;
  /**
   * The account's credential generation when the reading was taken, so a reading from before a
   * sign-in again reads as stale.
   */
  credentialGeneration: CredentialGeneration;
  /**
   * Which of the account's limits this is; absent names the default limit.
   */
  limitId?: string;
  /**
   * The quota's window in minutes as the provider gave it; a reader drops a window at or below
   * zero.
   */
  windowMins: number;
  /**
   * The share of the window used, in percent as the provider gave it.
   */
  usedPercent: number;
  /**
   * When the window resets, absent when the provider did not say.
   */
  resetsAt?: WireInstant;
  /**
   * Every window the account's own limits read named, this one among them, on a reading that
   * read: the account's whole standing, so a stored window it does not name is gone. Absent on
   * what the provider pushes during a turn, which names only the windows that moved.
   *
   * @minItems 1
   */
  wholeSet?: [UsageRateLimitWindowKey, ...UsageRateLimitWindowKey[]];
}
/**
 * The `usage.apiRequest.retried` payload: the provider retried a request mid-run, so trouble with
 * the account, its billing or its rate limits shows rather than passing in silence. It takes the
 * epoch stamp.
 */
export interface UsageApiRequestRetriedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run whose request was retried.
   */
  runId?: RunId;
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * Why the request was retried.
   */
  errorKind: ApiRetryErrorKind;
  /**
   * How long the provider waits before the retry, in milliseconds.
   */
  retryDelayMs?: number;
  /**
   * Which attempt the retry is, as the provider counts them.
   */
  attempt?: number;
  /**
   * The execution epoch a late row is attributed to; comes with `sourcePosition` and `runId`.
   */
  sourceEpoch?: SourceEpoch;
  /**
   * The run position the row occupies within its epoch; comes with `sourceEpoch`.
   */
  sourcePosition?: SourcePosition;
}
/**
 * The `agent.run.context.compacted` payload: the provider shrank the run's own conversation
 * context, and no stored event changed. `summary` is the summary the provider kept, in its own
 * words and unchanged. It takes the epoch stamp.
 */
export interface AgentRunContextCompactedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run whose context was compacted.
   */
  runId: RunId;
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The tokens the context held before the compaction.
   */
  preCompactionTokens?: number;
  /**
   * The tokens the context holds after it; when present it replaces the run's last used-tokens
   * reading.
   */
  postCompactionTokens?: number;
  /**
   * The summary the provider kept, absent when it kept none.
   */
  summary?: string;
  /**
   * The execution epoch a late row is attributed to; comes with `sourcePosition`.
   */
  sourceEpoch?: SourceEpoch;
  /**
   * The run position the row occupies within its epoch; comes with `sourceEpoch`.
   */
  sourcePosition?: SourcePosition;
}
/**
 * The `agent.turn.rerouted` payload: the provider moved a turn onto another model and the turn
 * went on. `sentence`, `explanation` and `safetyCategory` are the provider's own. It takes the
 * epoch stamp.
 */
export interface AgentTurnReroutedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run whose turn moved.
   */
  runId: RunId;
  /**
   * The agent whose turn moved.
   */
  agentId?: AgentId;
  /**
   * The model the turn was asked of.
   */
  fromModel: string;
  /**
   * The model the turn ran on, and the model it is priced at; a session-long move makes it the
   * model the session runs on, so it takes a model id's bound.
   */
  toModel: string;
  /**
   * How long the move holds.
   */
  scope: ModelRerouteScope;
  /**
   * The provider's own sentence, absent when it sent none.
   */
  sentence?: string;
  /**
   * The provider's explanation, shown as sent.
   */
  explanation?: string;
  /**
   * Why the provider moved the turn.
   */
  cause: ModelRerouteCause;
  /**
   * The provider's open safety category, such as `cyber` or `bio`.
   */
  safetyCategory?: string;
  /**
   * The execution epoch a late row is attributed to; comes with `sourcePosition`.
   */
  sourceEpoch?: SourceEpoch;
  /**
   * The run position the row occupies within its epoch; comes with `sourceEpoch`.
   */
  sourcePosition?: SourcePosition;
}

export {
  validateAgentRunContextCompactedPayload,
  validateAgentTurnReroutedPayload,
  validateApiRetryErrorKind,
  validateModelRerouteCause,
  validateModelRerouteScope,
  validateUsageApiRequestRetriedPayload,
  validateUsageContainment,
  validateUsageContextWindowUpdatedPayload,
  validateUsageCostSource,
  validateUsageCostUpdatedPayload,
  validateUsagePricedEvent,
  validateUsageRateLimitUpdatedPayload,
  validateUsageRateLimitWindowKey,
  validateUsageTokenCountRecordedPayload,
} from "../checks/event/usage.js";
