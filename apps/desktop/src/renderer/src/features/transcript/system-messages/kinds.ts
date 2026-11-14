// The system message vocabulary: which system messages the transcript draws, what each reads, and
// how it is marked. A system message is one line, never a message row or block, with only the last
// lines a dead provider process printed under it. Each binding carries its wire types verbatim.
// Classification is in `classifier.ts`, which takes this table as its closed input.

import {
  AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT,
  AGENT_PROVIDER_BINDING_CHANGED_EVENT,
  type AgentProviderBindingChangeFailedPayload,
} from "@ai-sidekicks/contracts/agent/provider-binding";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import type { ProcessExit } from "@ai-sidekicks/contracts/run/control";
import type { AgentRunFailedPayload } from "@ai-sidekicks/contracts/run/events";
import { TRANSCRIPT_ROLLBACK_BOUNDARY_TYPE } from "@ai-sidekicks/contracts/transcript/row";
import { processEndCause, processEndWords, type ProcessEnd } from "#shared/signal-words.js";

import { formatWholeDuration } from "#renderer/lib/wire/figures.js";
import type { SessionPartitions } from "#renderer/store/session/entities/partitions.js";
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
  "turn-ended",
] as const;

/** The closed set of system message kinds. */
export type SystemMessageKind = (typeof SYSTEM_MESSAGE_KINDS)[number];

/** A provider's name as a person reads it, from the background service's provider list. */
export type ProviderNameOf = (providerId: ProviderId) => string;

/** What one system message kind reads, and how it is drawn. */
export interface SystemMessageBinding {
  readonly kind: SystemMessageKind;
  /**
   * The act's name the one-line row reads for `row`, the app's words and never the wire's, or
   * `undefined` where the row is not this system message: a run that failed with no process exit.
   * `runs` are the session store's runs by id, whose bodies name the provider each run is on.
   */
  readonly labelOf: (
    row: ProjectedTranscriptRow,
    providerNameOf: ProviderNameOf,
    runs: SessionPartitions["run"],
  ) => string | undefined;
  /** The last lines a process printed, drawn verbatim under the label, on a kind that has them. */
  readonly lastLinesOf?: (row: ProjectedTranscriptRow) => string | undefined;
  /** The wire event types that produce this system message, verbatim. */
  readonly wireTypes: readonly SessionEventType[];
  /** Whether the system message is drawn as a caution: a failed switch and a turn a crash ended. */
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
  "turn-ended": {
    kind: "turn-ended",
    labelOf: turnEndedLabel,
    lastLinesOf: (row) => processExitOf(row)?.outputTail,
    wireTypes: ["agent.run.failed"],
    isCaution: true,
  },
};

// The switch it tried, by the provider it was moving to: `Switch to Codex failed`. A switch that
// names no provider stays on the one it had.
function failedSwitchLabel(row: ProjectedTranscriptRow, providerNameOf: ProviderNameOf): string {
  // The row's payload is its event's, an open record on the row type, read as the type the service
  // checked it as when it stored it.
  const failed = row.payload as unknown as AgentProviderBindingChangeFailedPayload;
  const provider = failed.attempted.providerName ?? failed.from.providerName;
  return `Switch to ${providerNameOf(provider)} failed`;
}

// The turn a provider process's end cut, by the run's provider and how the process ended:
// `Turn ended · Claude Code ended unexpectedly · killed by the system`. The run's provider is the
// one its start reported; a run whose start the store never read names only the cause.
function turnEndedLabel(
  row: ProjectedTranscriptRow,
  providerNameOf: ProviderNameOf,
  runs: SessionPartitions["run"],
): string | undefined {
  const processExit = processExitOf(row);
  if (processExit === undefined) {
    return undefined;
  }
  const end = processEndOf(processExit);
  // The run's body carries its start's `provider` wire-verbatim, as the service reported it.
  const runId = (row.payload as unknown as AgentRunFailedPayload).runId;
  const provider = runs[runId]?.body?.["provider"] as ProviderId | undefined;
  const words =
    provider === undefined
      ? [processEndCause(end)]
      : processEndWords(providerNameOf(provider), end);
  return ["Turn ended", ...words].join(" · ");
}

// How the provider process ended under the turn, on a run that failed because it did.
function processExitOf(row: ProjectedTranscriptRow): ProcessExit | undefined {
  // The row's payload is its event's, read as the type the service checked it as.
  return (row.payload as unknown as AgentRunFailedPayload).processExit;
}

// The wire's one arm of three as the words read it, a silence as whole minutes.
function processEndOf(processExit: ProcessExit): ProcessEnd {
  if (processExit.exitCode !== undefined) {
    return { kind: "exitCode", exitCode: processExit.exitCode };
  }
  if (processExit.signal !== undefined) {
    return { kind: "signal", signal: processExit.signal };
  }
  return {
    kind: "silence",
    silentFor: formatWholeDuration(processExit.silentSeconds / 60, "minute"),
  };
}
