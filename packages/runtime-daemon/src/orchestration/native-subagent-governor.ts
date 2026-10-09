// The helpers a provider's own agents may start inside a session: the policy every spawn carries,
// assembled from the person's own `Helpers at once` for that provider, and the Claude Code setting
// that keeps its background agents from running outside the session.

import type { SubagentDefinition, SubagentPolicy } from "../provider/driver/contract.js";

/**
 * Claude Code settings carried in every spawn's `--settings`: they turn off `claude agents`,
 * `claude daemon`, `claude --bg`, `/background` and the on-demand supervisor, whose work would run
 * outside the session's agent tree, its stop and interrupt, and its receipt.
 */
export const CLAUDE_AGENT_VIEW_OFF_SETTINGS: { readonly disableAgentView: true } = Object.freeze({
  disableAgentView: true,
});

/** What a session's helper policy is assembled from. */
export interface NativeSubagentPolicyInput {
  /** The person's `Helpers at once` for this provider: `null` for no limit, `0` for none. */
  readonly helpersAtOnce: number | null;
  /** The helpers the session's agents may start, each mapped by the driver to its own form. */
  readonly definitions: readonly SubagentDefinition[];
}

/**
 * The policy a spawn carries. `0` disables helpers, so the driver withholds the provider's helper
 * tool; no limit is carried as `null`, never left out, so the driver lifts the provider's own.
 */
export function assembleSubagentPolicy(input: NativeSubagentPolicyInput): SubagentPolicy {
  if (input.helpersAtOnce === 0) {
    return { enabled: false };
  }
  return {
    enabled: true,
    helpersAtOnce: input.helpersAtOnce,
    definitions: [...input.definitions],
  };
}
