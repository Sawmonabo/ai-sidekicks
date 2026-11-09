// A failed provider switch, decoded at the bridge, so the transcript's system message reads which
// provider the switch tried from what this returns and never from the check.

import {
  validateAgentProviderBindingChangeFailedPayload,
  type AgentProviderBindingChangeFailedPayload,
} from "@ai-sidekicks/contracts/agent/provider-binding";

/**
 * Read an `agent.providerBinding.changeFailed` payload, or `undefined` where the wire's is off
 * contract and names no switch the transcript can word.
 */
export function readProviderBindingChangeFailedPayload(
  payload: unknown,
): AgentProviderBindingChangeFailedPayload | undefined {
  return validateAgentProviderBindingChangeFailedPayload(payload) ? payload : undefined;
}
