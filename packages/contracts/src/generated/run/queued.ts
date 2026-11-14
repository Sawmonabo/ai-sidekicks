// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The `agent.run.queued` payload: a run's creation, and the one durable record of how it came to be.

import type {
  AgentId,
  AgentProviderBinding,
  AgentResolvedConfiguration,
} from "../agent/definition.js";
import type { AgentBindingSwitchPending } from "../agent/provider-binding.js";
import type { AgentTreeMember, ChildHandle } from "../agent/tree.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import type { OrchestrationRunConfig } from "../orchestration.js";
import type { ProviderAccountId } from "../provider/account/record.js";
import type { ObservedProviderOption } from "../provider/declaration.js";
import type { ProviderOutputSpeedState } from "../provider/driver/output-speed.js";
import type { ProviderId } from "../provider/id.js";
import type { ToolCallId } from "../provider/tool-call.js";
import type { SessionId } from "../session/id.js";
import type { RunId } from "./id.js";
import type { SubagentId } from "./subagent.js";

/**
 * How a child run was reached: a provider's own subagent, a run another agent asked for through
 * the bridge, or a workflow step. Internal to the agent index; the screen never shows it.
 */
export type ChildRunProvenance = "providerSubagent" | "bridgeRun" | "workflowStep";
/**
 * A run created and placed in the queue. It names its agent exactly once: by id for an agent
 * already in the session, or as the agent minted from a saved definition with this run.
 */
export type AgentRunQueuedPayload =
  | {
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The run.
       */
      runId: RunId;
      /**
       * The run's version at creation.
       */
      runVersion: number;
      /**
       * Always `queued`.
       */
      newState: "queued";
      /**
       * The agent.
       */
      agentId: AgentId;
      /**
       * Only a run for an agent resolved from a definition carries it.
       */
      resolvedAgent?: never;
      /**
       * The provider's own helper the run is for; present only on a run reached as
       * `providerSubagent`.
       */
      providerChild?: ProviderChildStart;
      /**
       * The run this one is a child of.
       */
      parentRunId?: RunId;
      /**
       * How the child was reached; present with `parent_run_id`.
       */
      reachedBy?: ChildRunProvenance;
      /**
       * The limits admission resolved, the request's own else the session's default, so a
       * rebuild restores them even if the defaults change mid-run.
       */
      effectiveRunConfig?: OrchestrationRunConfig;
      /**
       * The model family as of admission, which derived pricing keys off.
       */
      admittedModelFamily?: string;
      /**
       * The account the run was admitted against, resolved before its provider is called.
       */
      admittedProviderAccountId: ProviderAccountId;
    }
  | {
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The run.
       */
      runId: RunId;
      /**
       * The run's version at creation.
       */
      runVersion: number;
      /**
       * Always `queued`.
       */
      newState: "queued";
      /**
       * The agent the run mints.
       */
      resolvedAgent: ResolvedAgent;
      /**
       * Only a run for an agent already in the session names it by id.
       */
      agentId?: never;
      /**
       * Only a run reached as a provider's own helper names that helper.
       */
      providerChild?: never;
      /**
       * The run this one is a child of.
       */
      parentRunId?: RunId;
      /**
       * How the child was reached; present with `parent_run_id`.
       */
      reachedBy?: ChildRunProvenance;
      /**
       * The limits admission resolved, the request's own else the session's default, so a
       * rebuild restores them even if the defaults change mid-run.
       */
      effectiveRunConfig?: OrchestrationRunConfig;
      /**
       * The model family as of admission, which derived pricing keys off.
       */
      admittedModelFamily?: string;
      /**
       * The account the run was admitted against, resolved before its provider is called.
       */
      admittedProviderAccountId: ProviderAccountId;
    };

/**
 * An agent minted from a saved definition with the run that creates it: the one shape
 * `agent.subscribe` describes an agent in, with the configuration it was resolved from always
 * named.
 */
export interface ResolvedAgent {
  /**
   * The agent.
   */
  agentId: AgentId;
  /**
   * Its name.
   */
  name: string;
  /**
   * The binding it runs under now, never the pending one.
   */
  binding: AgentProviderBinding;
  /**
   * The speed the provider declared on the live binding; absent until it declares one.
   */
  observedOutputSpeed?: ProviderOutputSpeedState;
  /**
   * The session options as the provider reports them on the live binding; absent where
   * no binding is live or its driver declares none, never read as off.
   *
   * @minItems 1
   */
  observedOptions?: [ObservedProviderOption, ...ObservedProviderOption[]];
  /**
   * Present exactly while a switch waits, so every client learns of it, after a
   * restart too.
   */
  pendingSwitch?: AgentBindingSwitchPending;
  /**
   * The configuration it was resolved from, whose definition it names.
   */
  resolvedConfiguration: AgentResolvedConfiguration;
  /**
   * From the lead down to this agent's parent; empty for the lead.
   */
  ancestry: AgentTreeMember[];
  /**
   * When it joined the session.
   */
  createdAt: WireInstant;
}
/**
 * A provider's own helper as the run it starts names it: the handle the daemon minted for it, the
 * ids its provider gave it and its parent, and the model and effort the start names.
 */
export interface ProviderChildStart {
  /**
   * The handle the daemon minted for the helper at its first start.
   */
  childHandle: ChildHandle;
  /**
   * The provider that started the helper.
   */
  provider: ProviderId;
  /**
   * The provider's own id for the helper.
   */
  subagentId: SubagentId;
  /**
   * The provider's id for the helper it runs under; absent under the lead.
   */
  parentSubagentId?: SubagentId;
  /**
   * The handle of the helper it runs under; absent under the lead or where no node holds it.
   */
  parentChildHandle?: ChildHandle;
  /**
   * The name its provider gave it, where the provider names helpers.
   */
  name?: string;
  /**
   * The role its provider started it in.
   */
  role?: string;
  /**
   * Its path in its provider's tree, where the provider keeps one.
   */
  providerPath?: string;
  /**
   * The model its provider started it on, where the start names one.
   */
  modelId?: string;
  /**
   * The reasoning effort its provider started it at, in the provider's own word, where the start
   * names one.
   */
  effort?: string;
  /**
   * The provider's call that started this run of the helper, where the provider names one.
   */
  startCallId?: ToolCallId;
}

export {
  validateAgentRunQueuedPayload,
  validateChildRunProvenance,
  validateProviderChildStart,
  validateResolvedAgent,
} from "../checks/run/queued.js";
