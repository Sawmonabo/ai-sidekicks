// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The choices a provider asks the person to make while a run waits on the answer: the retry-or-edit choice after a refusal and the switch-or-credits choice when a model needs usage credits.

import type { SessionId } from "../session/id.js";
import type { DeviceId } from "../trust-statement.js";
import type { RunId } from "./id.js";

/**
 * The person's answer when the provider's safety check refuses a turn and names a fallback model:
 * `retryFallback` goes on on the fallback model, and `editPrompt` ends the turn refused and
 * returns the message to the composer. The driver translates each value to the provider's own
 * answer.
 */
export type RunRefusalChoice = "retryFallback" | "editPrompt";
/**
 * How the retry-or-edit choice ended with no answer: `canceled` is an interrupt or a message sent
 * while it waits, or an interrupted end of its run, and the driver maps the provider's own cancel
 * answer to it; `runEnded` is any other end of its run, a restart of the background service
 * among them.
 */
export type RunRefusalChoiceUnanswered = "canceled" | "runEnded";
/**
 * How the retry-or-edit choice settled: the person's answer, or an end with none.
 */
export type RunRefusalChoiceSettlement = RunRefusalChoice | RunRefusalChoiceUnanswered;
/**
 * The person's answer when a turn's model needs usage credits: `switchDefault` moves the turn to
 * the fallback model, and `consent` goes on on usage credits, which the provider accepts only
 * while credits are on. The driver translates each value to the provider's own answer.
 */
export type RunUsageCreditsChoice = "switchDefault" | "consent";
/**
 * How the switch-or-credits choice ended with no answer: `interrupted` is an interrupt or an
 * undo while it waits, which ends the turn on that model, or an interrupted end of its run;
 * `unanswered` is the provider settling it when a message is sent while it waits; `runEnded` is
 * any other end of its run, a restart of the background service among them.
 */
export type RunUsageCreditsChoiceUnanswered = "interrupted" | "unanswered" | "runEnded";
/**
 * How the switch-or-credits choice settled: the person's answer, or an end with none.
 */
export type RunUsageCreditsChoiceSettlement =
  | RunUsageCreditsChoice
  | RunUsageCreditsChoiceUnanswered;

/**
 * Answers the retry-or-edit choice a refused run waits on (`agent.run.refusalChoice.resolve`). The
 * first answer settles it; a second or late one is refused with `agent.run.invalidTransition`.
 */
export interface AgentRunRefusalChoiceResolveRequest {
  /**
   * The run that waits.
   */
  runId: RunId;
  /**
   * The answer.
   */
  choice: RunRefusalChoice;
}
/**
 * The payload of `agent.run.refusalChoice.requested`: the refusing model, the fallback it names,
 * the provider's own sentence and check category when it sends them, and the ids of the rows
 * already streamed for the refused answer, which leave the flow when the choice is answered.
 */
export interface AgentRunRefusalChoiceRequestedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run that waits.
   */
  runId: RunId;
  /**
   * The model that refused.
   */
  refusedModel: string;
  /**
   * The model a retry goes on on.
   */
  fallbackModel: string;
  /**
   * The provider's own sentence, where it sent one.
   */
  sentence?: string;
  /**
   * The provider's open safety category, where it sent one.
   */
  safetyCategory?: string;
  /**
   * The rows already streamed for the refused answer.
   */
  retractedMessageIds?: string[];
}
/**
 * The payload of `agent.run.refusalChoice.resolved`: the answer that settled the choice, and the
 * device that sent a person's answer.
 */
export interface AgentRunRefusalChoiceResolvedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * How it settled.
   */
  choice: RunRefusalChoiceSettlement;
  /**
   * The device that sent a person's answer.
   */
  deviceId?: DeviceId;
}
/**
 * Answers the switch-or-credits choice a run waits on (`agent.run.usageCreditsChoice.resolve`).
 * The first answer settles it; a second or late one is refused with `agent.run.invalidTransition`.
 */
export interface AgentRunUsageCreditsChoiceResolveRequest {
  /**
   * The run that waits.
   */
  runId: RunId;
  /**
   * The answer.
   */
  choice: RunUsageCreditsChoice;
}
/**
 * The payload of `agent.run.usageCreditsChoice.requested`: the model that needs credits, whether
 * credits are on, the balance and its currency when the provider reports them, and the model a
 * switch moves to when the provider's model list names one.
 */
export interface AgentRunUsageCreditsChoiceRequestedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run that waits.
   */
  runId: RunId;
  /**
   * The model that needs credits.
   */
  modelName: string;
  /**
   * Whether usage credits are on.
   */
  overagesEnabled: boolean;
  /**
   * The credit balance in cents, where the provider reports it.
   */
  balanceCents?: number;
  /**
   * The balance's currency, where the provider reports it.
   */
  currency?: string;
  /**
   * The model a switch moves to, where the provider's model list names one.
   */
  fallbackModel?: string;
}
/**
 * The payload of `agent.run.usageCreditsChoice.resolved`: how the choice settled, and the device
 * that sent a person's answer.
 */
export interface AgentRunUsageCreditsChoiceResolvedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * How it settled.
   */
  choice: RunUsageCreditsChoiceSettlement;
  /**
   * The device that sent a person's answer.
   */
  deviceId?: DeviceId;
}

export {
  validateAgentRunRefusalChoiceRequestedPayload,
  validateAgentRunRefusalChoiceResolveRequest,
  validateAgentRunRefusalChoiceResolvedPayload,
  validateAgentRunUsageCreditsChoiceRequestedPayload,
  validateAgentRunUsageCreditsChoiceResolveRequest,
  validateAgentRunUsageCreditsChoiceResolvedPayload,
  validateRunRefusalChoice,
  validateRunRefusalChoiceSettlement,
  validateRunRefusalChoiceUnanswered,
  validateRunUsageCreditsChoice,
  validateRunUsageCreditsChoiceSettlement,
  validateRunUsageCreditsChoiceUnanswered,
} from "../checks/run/provider-choice.js";
