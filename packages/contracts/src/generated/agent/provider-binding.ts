// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// How a change to an agent's provider binding settles for every client, not only the asker: the switch, its disposition and its two settlement events.

import type { ProviderAccountId } from "../provider/account/record.js";
import type { ProviderOptionSetting } from "../provider/declaration.js";
import type { DeclaredLossKind } from "../provider/driver/declared-loss.js";
import type { ProviderId } from "../provider/id.js";
import type { SessionId } from "../session/id.js";
import type { DeviceId } from "../trust-statement.js";
import type { AgentId, AgentProviderBinding } from "./definition.js";

/** The event a deferred switch settles with when it applied. */
export const AGENT_PROVIDER_BINDING_CHANGED_EVENT = "agent.providerBinding.changed" as const;

/** The event a deferred switch settles with when it could not be applied. */
export const AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT =
  "agent.providerBinding.changeFailed" as const;

/** The longest switch id the daemon mints. */
export const AGENT_SWITCH_ID_MAX_LEN = 256 as const;

/**
 * How the conversation crossed the switch: `inPlace`, the same provider carried it on; or
 * `brief`, a switch across providers that started from a hand-over brief with the old
 * transcript beside it as a file, never presented as an ordinary success.
 */
export type AgentBindingContinuity = "inPlace" | "brief";
/**
 * Why an accepted switch could not be applied; a switch refused before it was accepted is an
 * error on the request instead.
 */
export type AgentBindingSwitchFailureReason =
  | "providerUnavailable"
  | "modelUnavailable"
  | "effortUnavailable"
  | "accountUnavailable"
  | "outputSpeedUnavailable"
  | "interruptRefused"
  | "targetUnstartable";
/**
 * Why the account a switch lands on cannot carry the run; only `reauthRequired` offers a sign
 * in again. Listed in full, so a new account health state cannot widen it silently.
 */
export type AgentBindingSwitchAccountState =
  | "reauthRequired"
  | "homeMissing"
  | "indeterminate"
  | "notRegistered";
/**
 * Where a pending switch applies, resolved by the daemon against the target driver: the next
 * turn or the end of the run in flight; a switch moving several members takes the widest.
 */
export type AgentBindingSwitchBoundary = "turnBoundary" | "runBoundary";
/**
 * What `agent.config.update` answers with, told apart by `status`. `pending` is the
 * ordinary answer, and `unchanged` the answer to a pick back to the binding the agent is
 * on; the other three come only when the caller asked to interrupt and switch, settled
 * on the held-open request as a result, not an error. `applied` is exactly a conversation
 * that arrived whole and `degraded` exactly one that did not, so no client re-derives
 * that rule.
 */
export type AgentBindingSwitchDisposition =
  | {
      status: "pending";
      /**
       * The switch.
       */
      switchId: string;
      /**
       * Where it applies.
       */
      appliesAt: AgentBindingSwitchBoundary;
      /**
       * Whether the daemon interrupts to reach the boundary; never re-derived from `appliesAt`.
       */
      interruptRequested: boolean;
      /**
       * What it moves.
       */
      pendingAxes: AgentBindingSwitchTarget;
      /**
       * The earlier pending switch this one displaced, and the only record of it.
       */
      replacedSwitchId?: string;
    }
  | {
      status: "unchanged";
      /**
       * The pending switch the pick back canceled.
       */
      replacedSwitchId?: string;
    }
  | {
      status: "applied";
      /**
       * The switch.
       */
      switchId: string;
      /**
       * Always `inPlace`.
       */
      continuity: "inPlace";
      /**
       * Always empty: nothing of the conversation was dropped.
       *
       * @maxItems 0
       */
      declaredLosses: [];
    }
  | ({
      declaredLosses?: unknown[];
    } & {
      status: "degraded";
      /**
       * The switch.
       */
      switchId: string;
      /**
       * Always `brief`.
       */
      continuity: "brief";
      /**
       * What was lost: at least the summarized history and the private reasoning.
       */
      declaredLosses: DeclaredLossKind[];
    })
  | {
      status: "failed";
      /**
       * The switch.
       */
      switchId: string;
      /**
       * Why it failed.
       */
      reason: AgentBindingSwitchFailureReason;
      /**
       * Why the account cannot carry the run, exactly on `accountUnavailable`.
       */
      accountState?: AgentBindingSwitchAccountState;
    };

/**
 * The binding members a switch moves and the value each moves to; an omitted member does not
 * move. `largerWindow` as a number moves to that window in tokens and `null` back to the model's
 * default.
 */
export interface AgentBindingSwitchTarget {
  /**
   * The provider.
   */
  providerName?: ProviderId;
  /**
   * The model.
   */
  modelId?: string;
  /**
   * The account; an account move sets only the account.
   */
  providerAccountId?: ProviderAccountId;
  /**
   * The effort.
   */
  effort?: string;
  /**
   * The speed.
   */
  outputSpeed?: string;
  /**
   * The session options it moves, each to its value; an option left out does not move.
   *
   * @minItems 1
   */
  options?: [ProviderOptionSetting, ...ProviderOptionSetting[]];
  /**
   * The window in tokens, or `null` for the model's default.
   */
  largerWindow?: number | null;
}
/**
 * A switch the daemon accepted and has not applied: at most one per agent, a later one
 * replacing it. The same record is the acknowledgment, the agent row's stored switch and
 * `agent.subscribe`'s `pendingSwitch`, so `switching to …` survives a reload and reaches
 * another device.
 */
export interface AgentBindingSwitchPending {
  /**
   * Always `pending`.
   */
  status: "pending";
  /**
   * The switch.
   */
  switchId: string;
  /**
   * Where it applies.
   */
  appliesAt: AgentBindingSwitchBoundary;
  /**
   * Whether the daemon interrupts to reach the boundary; never re-derived from `appliesAt`.
   */
  interruptRequested: boolean;
  /**
   * What it moves.
   */
  pendingAxes: AgentBindingSwitchTarget;
  /**
   * The earlier pending switch this one displaced, and the only record of it.
   */
  replacedSwitchId?: string;
}
/**
 * The payload of [`AGENT_PROVIDER_BINDING_CHANGED_EVENT`]: a switch that applied. The landed
 * account is kept apart from `to`'s, so an agent that follows the current account is never
 * pinned to it.
 */
export interface AgentProviderBindingChangedPayload {
  /**
   * The switch.
   */
  switchId: string;
  /**
   * What was lost.
   */
  declaredLosses: DeclaredLossKind[];
  /**
   * How the conversation crossed.
   */
  continuity: AgentBindingContinuity;
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The agent.
   */
  agentId: AgentId;
  /**
   * The device whose connection carried the switch, recorded at acceptance so a settlement
   * after a restart still names it.
   */
  actor: DeviceId;
  /**
   * The binding before.
   */
  from: AgentProviderBinding;
  /**
   * The binding after.
   */
  to: AgentProviderBinding;
  /**
   * The account the switch landed on.
   */
  landedProviderAccountId: ProviderAccountId;
}
/**
 * The payload of [`AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT`]: an accepted switch that could
 * not be applied. The agent stays on `from`; exactly one of the two events ends every switch not
 * replaced.
 */
export interface AgentProviderBindingChangeFailedPayload {
  /**
   * The switch.
   */
  switchId: string;
  /**
   * Why it failed.
   */
  reason: AgentBindingSwitchFailureReason;
  /**
   * Why the account cannot carry the run, exactly on `accountUnavailable`.
   */
  accountState?: AgentBindingSwitchAccountState;
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The agent.
   */
  agentId: AgentId;
  /**
   * The device whose connection carried the switch.
   */
  actor: DeviceId;
  /**
   * The binding the agent stays on.
   */
  from: AgentProviderBinding;
  /**
   * What the switch tried to move.
   */
  attempted: AgentBindingSwitchTarget;
}

export {
  validateAgentBindingContinuity,
  validateAgentBindingSwitchAccountState,
  validateAgentBindingSwitchBoundary,
  validateAgentBindingSwitchFailureReason,
  validateAgentBindingSwitchPending,
  validateAgentBindingSwitchTarget,
  validateAgentProviderBindingChangeFailedPayload,
  validateAgentProviderBindingChangedPayload,
} from "../checks/agent/provider-binding.js";
