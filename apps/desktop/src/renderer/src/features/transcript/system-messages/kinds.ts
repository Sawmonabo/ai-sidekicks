// The system message vocabulary: which system messages the transcript draws, what each reads, and
// how it is marked. A system message is one line, never a message row or block. Each binding
// carries its wire types verbatim. Classification is in `classifier.ts`, which takes this table as
// its closed input.

import {
  AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT,
  AGENT_PROVIDER_BINDING_CHANGED_EVENT,
} from "@ai-sidekicks/contracts/agent/provider-binding";
import { PROVIDER_LABELS } from "@ai-sidekicks/contracts/provider/name";
import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { readProviderBindingChangeFailedPayload } from "#renderer/services/daemon/payload/provider-binding-change-failed.js";

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

/** What one system message kind reads, and how it is drawn. */
export interface SystemMessageBinding {
  readonly kind: SystemMessageKind;
  /**
   * The act's name the one-line row reads for `row`: the app's words, never the wire's.
   * `undefined` where the row's payload is off contract and names nothing to word.
   */
  readonly labelOf: (row: TranscriptEventRow) => string | undefined;
  /** The wire event types that produce this system message, verbatim. */
  readonly wireTypes: readonly string[];
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
    wireTypes: ["usage.context_compacted"],
    isCaution: false,
  },
  rollback: {
    kind: "rollback",
    labelOf: () => "Rewound",
    wireTypes: ["run.rolled_back"],
    isCaution: false,
  },
};

// The switch it tried, by the provider it was moving to: `Switch to Codex failed`. A switch that
// names no provider stays on the one it had.
function failedSwitchLabel(row: TranscriptEventRow): string | undefined {
  const failed = readProviderBindingChangeFailedPayload(row.payload);
  if (failed === undefined) {
    return undefined;
  }
  const provider = failed.attempted.driverName ?? failed.from.driverName;
  return `Switch to ${PROVIDER_LABELS[provider]} failed`;
}
