// Claude Code's static facts: what the daemon reads about it before any session exists.

import { CLAUDE_UPDATE_SWITCH_NAMES } from "@ai-sidekicks/contracts";

import type { DriverCapabilityDetectionTable, ProbeAnswer } from "../../capability-probe.js";
import type {
  ProviderDriverDescriptor,
  ReportedVersionReading,
} from "../../provider-driver-descriptor.js";
import { CLAUDE_BUILT_IN_TOOLS } from "./tools.js";

/**
 * The detection table. The one zero-turn channel is the control-request registry: an unknown
 * subtype answers `Unsupported control request subtype: <name>`. No entry is currently `probed`.
 */
const CLAUDE_CAPABILITY_DETECTION_TABLE: DriverCapabilityDetectionTable = Object.freeze({
  resume: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Delivered by launch-time flags (`--resume`, `--fork-session`), which the control-request channel cannot interrogate; the wire reference's own rule is that a flag's presence in a binary census is never promoted to availability.",
  },
  steer: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "FALSE on this driver: it sends no steer to the provider, and the steer intervention degrades to queue-plus-interrupt as a REPORTED degradation. A probe cannot grant a flag anyway (resolution is withdraw-only), so the channel has nothing to decide here.",
  },
  interactive_requests: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "The flag is consumed as the round trips the PROVIDER raises — `can_use_tool` and `elicitation`. `request_user_dialog` is not one of them: Claude Code sends it only for a dialog kind the host declared at start, and the daemon's kinds are the refusal and usage-credits choices, which are run events rather than asks. The control-request census is a census of the registry, not of the inbound dispatcher's accepted set. A first-party probe of the pinned build answers the identical name-level refusal for both as for the negative control, so probing them would withdraw the flag on every read of a build that fully carries it. The channel therefore cannot decide a capability delivered by frames flowing the other way, in either direction.",
  },
  mcp: {
    detectionSource: "static",
    failingConjuncts: ["zero-turn", "non-mutating"],
    rationale:
      "The flag asserts only that the provider can invoke MCP server tools, and the sole direct probe of that is invoking one — which consumes a turn and performs the tool's own effect. It resolves from the matrix. The set-replacing `mcp_set_servers` reconcile is NOT a probe of this flag and is not issued here at all.",
  },
  tool_calls: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "A property of the streamed output surface. No control-request subtype reports it, so the channel cannot decide it in either direction.",
  },
  reasoning_stream: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Thinking blocks are a stream-output shape; the control-request channel observes no output frames.",
  },
  model_mutation: {
    detectionSource: "static",
    failingConjuncts: ["non-mutating"],
    rationale:
      "The subtype that would decide it (`set_model`) is defined to CHANGE the session's model. Deciding the flag by issuing it rests on an unstated assumption that a payload the handler rejects performs nothing — an assumption the wire reference does not record and whose worst case is that the model is actually set.",
  },
  structured_output: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Delivered by the launch-time `--json-schema` flag, which the control-request channel cannot interrogate.",
  },
  rollback: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Composed from launch-time resume-at plus `--fork-session`. The conversation-rewind " +
      "subtype is absent from the control-request census, and the file-side `rewind_files` " +
      "sibling restores files, a different capability, so the channel cannot decide this flag.",
  },
  session_goals: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "FALSE on this driver, which exposes no goal operation. A probe cannot grant a flag " +
      "(resolution is withdraw-only), so the channel has nothing to decide here.",
  },
  callback_tools: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Delivered by a daemon-hosted ephemeral MCP server bound at launch. The capability is the daemon's to deliver, so no provider answer decides it.",
  },
  subagents: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Delivered by the launch-time `--agents` definitions, which the control-request channel cannot interrogate.",
  },
  context_compaction: {
    detectionSource: "static",
    failingConjuncts: ["zero-turn"],
    rationale:
      "The compaction this driver's leg dispatches is the provider's OWN command, and the only evidence that command exists on this build is its presence in the session-handshake command enumeration — which the provider emits as part of a turn-bearing exchange. Reading it therefore costs a turn, so the one conjunct that fails is zero-turn rather than decisiveness: the enumeration WOULD decide the flag, and is simply not free to obtain.",
  },
  provider_commands: {
    detectionSource: "static",
    failingConjuncts: ["zero-turn"],
    rationale:
      "The enumeration IS the capability here, and it rides that same turn-bearing session handshake. Same failing conjunct as the compaction entry above and for the same reason: the reading is decisive and simply not free.",
  },
  output_speed: {
    detectionSource: "static",
    failingConjuncts: ["zero-turn"],
    rationale:
      "TRUE on this driver. The declared speed state arrives on the same turn-bearing session handshake, so obtaining it costs a user-message request — which is exactly the conjunct that keeps this entry static, and exactly why the axis's value set is declared from this driver's own table rather than read from the provider: a vocabulary obtained by reading would contradict its own detection source.",
  },
});

const CLAUDE_UNSUPPORTED_SUBTYPE_PREFIX = "Unsupported control request subtype:";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Classifies one `control_response`, given the full envelope or the inner response object. The
 * refusal is name-level already, so the probe name is not read.
 */
function classifyClaudeProbeReply(payload: unknown): ProbeAnswer {
  const envelope = asRecord(payload);
  if (envelope === undefined) {
    return "unrecognized";
  }
  const response = asRecord(envelope["response"]) ?? envelope;
  const subtype = response["subtype"];
  if (subtype === "success") {
    return "accepted";
  }
  if (subtype !== "error") {
    return "unrecognized";
  }
  const error = response["error"];
  if (typeof error !== "string") {
    // An error without a string reason cannot be told from a name-level refusal.
    return "unrecognized";
  }
  return error.startsWith(CLAUDE_UNSUPPORTED_SUBTYPE_PREFIX) ? "unknown-name" : "accepted";
}

/**
 * Claude Code answers `get_binary_version` with `{ version, buildTime }`; the version is adopted
 * as-is.
 */
function readClaudeReportedVersion(payload: unknown): ReportedVersionReading {
  const version = asRecord(payload)?.["version"];
  return typeof version === "string" ? { version } : { unreadableReply: "" };
}

/** Claude Code's static facts. */
export const CLAUDE_DRIVER_DESCRIPTOR: ProviderDriverDescriptor = Object.freeze({
  capabilityDetectionTable: CLAUDE_CAPABILITY_DETECTION_TABLE,
  capabilityProbeChannel: "control_request",
  capabilityProbeNegativeControl: "zzq_nonexistent_subtype",
  // Replaces a live session's full server set.
  capabilityProbeProhibitedNames: Object.freeze(["mcp_set_servers"]),
  classifyCapabilityProbeReply: classifyClaudeProbeReply,
  cliVersionFloor: "2.1.234",
  readReportedVersion: readClaudeReportedVersion,
  // Presence-style gates: the pinned build honors them when set.
  autoUpdateOptOutEnvironment: Object.freeze(
    Object.fromEntries(CLAUDE_UPDATE_SWITCH_NAMES.map((name) => [name, "1"])),
  ),
  // The pinned build declares its state from a three-value vocabulary; only these two are
  // requestable, the third is entered by the provider after a rate limit.
  outputSpeedLevels: Object.freeze(["off", "on"]),
  builtInTools: CLAUDE_BUILT_IN_TOOLS,
});
