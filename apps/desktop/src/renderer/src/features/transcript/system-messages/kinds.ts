// The system message vocabulary: which system messages the transcript draws, what each reads, and
// how it is marked. A system message is one line, never a message row or block. Each binding
// carries its wire types verbatim. Classification is in `classifier.ts`, which takes this table as
// its closed input.

import {
  AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT,
  AGENT_PROVIDER_BINDING_CHANGED_EVENT,
  type AgentProviderBindingChangeFailedPayload,
} from "@ai-sidekicks/contracts/agent/provider-binding";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import { TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE } from "@ai-sidekicks/contracts/transcript/row";

import type { ProjectedTranscriptRow } from "#renderer/store/session/entities/vocabulary.js";

/**
 * Every system message the transcript draws. Closed; `SystemMessageKind` derives from this tuple
 * so the classifier's lookup and the binding table cannot come apart. A pause and a continue land
 * no row, so no run-state kind is here.
 */
export const SYSTEM_MESSAGE_KINDS = [
  "provider-switch",
  "provider-switch-failed",
  "compaction",
  "rollback",
] as const;

/** The closed set of system message kinds. */
export type SystemMessageKind = (typeof SYSTEM_MESSAGE_KINDS)[number];

/** A provider's name as a person reads it, from the background service's provider list. */
export type ProviderNameOf = (providerId: ProviderId) => string;

/** What one system message kind reads, and how it is drawn. */
export interface SystemMessageBinding {
  readonly kind: SystemMessageKind;
  /** The act's name the one-line row reads for `row`: the app's words, never the wire's. */
  readonly labelOf: (row: ProjectedTranscriptRow, providerNameOf: ProviderNameOf) => string;
  /** The wire event types that produce this system message, verbatim. */
  readonly wireTypes: readonly SessionEventType[];
  /** Whether the system message is drawn as a caution; only the failed switch is. */
  readonly isCaution: boolean;
}

/**
 * The binding table. Total over `SystemMessageKind`, so a new kind fails to compile here
 * before it reaches a classifier that would never match it.
 */
export const SYSTEM_MESSAGE_BINDINGS: Readonly<Record<SystemMessageKind, SystemMessageBinding>> = {
  "provider-switch": {
    kind: "provider-switch",
    labelOf: () => "Provider switched",
    wireTypes: [AGENT_PROVIDER_BINDING_CHANGED_EVENT],
    isCaution: false,
  },
  "provider-switch-failed": {
    kind: "provider-switch-failed",
    labelOf: failedSwitchLabel,
    wireTypes: [AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT],
    isCaution: true,
  },
  compaction: {
    kind: "compaction",
    labelOf: () => "Context compacted",
    wireTypes: ["agent.run.context.compacted"],
    isCaution: false,
  },
  rollback: {
    kind: "rollback",
    labelOf: () => "Rewound",
    wireTypes: [TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE],
    isCaution: false,
  },
};

// The switch it tried, by the provider it was moving to: `Switch to Codex failed`. A switch that
// names no provider stays on the one it had.
function failedSwitchLabel(row: ProjectedTranscriptRow, providerNameOf: ProviderNameOf): string {
  const failed = row.payload as AgentProviderBindingChangeFailedPayload;
  const provider = failed.attempted.providerName ?? failed.from.providerName;
  return `Switch to ${providerNameOf(provider)} failed`;
}
