// How a change to an agent's provider binding settles for every client, not only the
// one that asked for it.
//
// A switch that applies at once answers on its own request. A switch deferred to a
// turn or run boundary settles later, and two events carry that settlement to every
// client watching the session: one when the switch applied, one when it could not be.
// They are two events rather than one because different surfaces wait on them for
// opposite reasons: the applied event is the settlement the agent card and the runs
// view draw, and the failed event is the caution the composer's target chip draws.
import type { DeclaredLossKind } from "./provider-driver.js";
import type { SessionId } from "./session.js";

/** The event a deferred provider switch settles with when it applied. */
export const AGENT_PROVIDER_BINDING_CHANGED_EVENT = "agent.provider_binding_changed" as const;
/** The event a deferred provider switch settles with when it could not be applied. */
export const AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT =
  "agent.provider_binding_change_failed" as const;

/**
 * Which mechanism carried the conversation across the switch. Four different acts,
 * not degrees of one:
 *
 * - `in_place`: a per-turn setting carried into the next turn on the running process.
 * - `resumed`: a fresh process of the same provider reopened its own conversation.
 * - `brief`: the new binding started from a hand-over brief, with the old transcript
 *   written beside it as a file the provider reads on demand.
 * - `replayed`: a same-provider reopen did not load, so the transcript was sent as
 *   text and the conversation restarted.
 *
 * `in_place` and `resumed` are applied switches; `brief` and `replayed` are degraded
 * ones and are never presented as an ordinary success.
 */
export type AgentBindingContinuity = "in_place" | "resumed" | "brief" | "replayed";

/**
 * The payload of {@link AGENT_PROVIDER_BINDING_CHANGED_EVENT}: a deferred switch that
 * applied, with how the conversation arrived and what it lost.
 *
 * `declaredLosses` is required, and an empty list is a claim that nothing was dropped.
 * It is empty on `in_place` and `resumed`, and never empty on `brief` or `replayed`. It
 * speaks about the conversation only: whether a requested setting took effect on the
 * new binding is read back on the agent, not reported as a loss.
 */
export interface AgentProviderBindingChangedPayload {
  sessionId: SessionId;
  agentId: string;
  /** The id the switch was acknowledged with, so a client can match its own request. */
  switchId: string;
  continuity: AgentBindingContinuity;
  declaredLosses: DeclaredLossKind[];
}

/**
 * Why an accepted switch could not be applied. A switch refused before it was
 * accepted, for an unknown axis or an invalid value, is an error on the request and
 * never reaches this vocabulary.
 */
export const AGENT_BINDING_CHANGE_FAILURE_REASONS = [
  "driver_unavailable",
  "model_unavailable",
  "effort_unavailable",
  "account_unavailable",
  "output_speed_unavailable",
  "interrupt_refused",
  "target_unstartable",
] as const;
/** One of {@link AGENT_BINDING_CHANGE_FAILURE_REASONS}. */
export type AgentBindingChangeFailureReason = (typeof AGENT_BINDING_CHANGE_FAILURE_REASONS)[number];

/**
 * The payload of {@link AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT}: a deferred switch
 * that was accepted and could not be applied, and why.
 */
export interface AgentProviderBindingChangeFailedPayload {
  sessionId: SessionId;
  agentId: string;
  /** The id the switch was acknowledged with, so a client can match its own request. */
  switchId: string;
  reason: AgentBindingChangeFailureReason;
}
