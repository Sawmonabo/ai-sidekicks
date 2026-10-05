// Claude Code's static facts: what the daemon reads about it before any session exists.

import { CLAUDE_UPDATE_SWITCH_NAMES } from "@ai-sidekicks/contracts/machine-settings";

import type { DriverCapabilityDetectionTable, ProbeAnswer } from "../../capability/probe.js";
import type {
  ProviderDriverDescriptor,
  ReportedVersionReading,
} from "../provider-driver-descriptor.js";
import { isPlainObject } from "../../record-readers.js";
import { CLAUDE_BUILT_IN_TOOLS } from "./tools.js";

/** The control request whose reply reports the fast-mode state before any turn. */
const CLAUDE_FAST_MODE_PROBE_NAME = "initialize";

/**
 * The detection table. The one zero-turn channel is the control-request registry: an unknown
 * subtype answers `Unsupported control request subtype: <name>`. Only `output_speed` is `probed`.
 */
const CLAUDE_CAPABILITY_DETECTION_TABLE: DriverCapabilityDetectionTable = Object.freeze({
  resume: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Delivered by launch-time flags (`--resume`, `--fork-session`), which the " +
      "control-request channel cannot interrogate; the wire reference's own rule is that a " +
      "flag's presence in a binary census is never promoted to availability.",
  },
  steer: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "FALSE on this driver: it sends no steer to the provider, and the steer intervention " +
      "degrades to queue-plus-interrupt as a REPORTED degradation. A probe cannot grant a " +
      "flag anyway (resolution is withdraw-only), so the channel has nothing to decide here.",
  },
  interactive_requests: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "The flag is consumed as the round trips the PROVIDER raises — `can_use_tool` and " +
      "`elicitation`. `request_user_dialog` is not one of them: Claude Code sends it only " +
      "for a dialog kind the host declared at start, and the daemon's kinds are the refusal " +
      "and usage-credits choices, which are run events rather than asks. The control-request " +
      "census is a census of the registry, not of the inbound dispatcher's accepted set. A " +
      "first-party probe of the pinned build answers the identical name-level refusal for " +
      "both as for the negative control, so probing them would withdraw the flag on every " +
      "read of a build that fully carries it. The channel therefore cannot decide a " +
      "capability delivered by frames flowing the other way, in either direction.",
  },
  mcp: {
    detectionSource: "static",
    failingConjuncts: ["zero-turn", "non-mutating"],
    rationale:
      "The flag asserts only that the provider can invoke MCP server tools, and the sole " +
      "direct probe of that is invoking one — which consumes a turn and performs the " +
      "tool's own effect. It resolves from the matrix. The set-replacing `mcp_set_servers` " +
      "reconcile is NOT a probe of this flag and is not issued here at all.",
  },
  tool_calls: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "A property of the streamed output surface. No control-request subtype reports it, so " +
      "the channel cannot decide it in either direction.",
  },
  reasoning_stream: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Thinking blocks are a stream-output shape; the control-request channel observes no " +
      "output frames.",
  },
  model_mutation: {
    detectionSource: "static",
    failingConjuncts: ["non-mutating"],
    rationale:
      "The subtype that would decide it (`set_model`) is defined to CHANGE the session's " +
      "model. Deciding the flag by issuing it rests on an unstated assumption that a payload " +
      "the handler rejects performs nothing — an assumption the wire reference does not " +
      "record and whose worst case is that the model is actually set.",
  },
  structured_output: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Delivered by the launch-time `--json-schema` flag, which the control-request channel " +
      "cannot interrogate.",
  },
  rollback: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Composed from launch-time resume-at plus `--fork-session`. The conversation-rewind " +
      "subtype is absent from the control-request census, and the file-side `rewind_files` " +
      "sibling restores files, a different capability, so the channel cannot decide this flag.",
  },
  session_fork: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Delivered by the launch-time `--resume-session-at` with `--fork-session`, which the " +
      "control-request channel cannot interrogate.",
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
      "Delivered by a daemon-hosted ephemeral MCP server bound at launch. The capability is " +
      "the daemon's to deliver, so no provider answer decides it.",
  },
  subagents: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Delivered by the `agents` map on the session's `initialize` request, which the " +
      "control-request channel cannot interrogate afterward.",
  },
  context_compaction: {
    detectionSource: "static",
    failingConjuncts: ["zero-turn", "non-mutating"],
    rationale:
      "The compaction this driver's leg dispatches is the provider's OWN command, and the " +
      "evidence that command exists on this build is the command enumeration. The session " +
      "handshake carries it as part of a turn-bearing exchange, so that reading costs a turn; " +
      "`reload_plugins` answers the same lists with no turn, but by reloading the process's " +
      "skills, commands and plugins. The enumeration WOULD decide the flag; no channel " +
      "yields it both free and without effect.",
  },
  provider_commands: {
    detectionSource: "static",
    failingConjuncts: ["zero-turn", "non-mutating"],
    rationale:
      "The enumeration IS the capability here, and it arrives on the same two channels as " +
      "the compaction entry above: the turn-bearing session handshake and the reloading " +
      "`reload_plugins`. Same failing conjuncts for the same reason: the reading is " +
      "decisive and not obtainable both free and without effect.",
  },
  output_speed: {
    detectionSource: "probed",
    probe: {
      probeNames: [CLAUDE_FAST_MODE_PROBE_NAME],
      decisiveness:
        "The `initialize` reply reports `fast_mode_state` before any turn (`off` with " +
        "`sdk_opt_in_required` before the opt-in), on a connection that starts no session, " +
        "and a state present there is the axis. The reply classifier reads that member, so " +
        "a build whose reply carries no state withdraws the flag. The settable levels stay " +
        "declared in this driver's table: the provider reports a state and lists no modes.",
    },
  },
});

const CLAUDE_UNSUPPORTED_SUBTYPE_PREFIX = "Unsupported control request subtype:";

/**
 * Classifies one `control_response`, given the full envelope or the inner response object. The
 * refusal is name-level already; the probe name is read only for the fast-mode probe, whose
 * acceptance counts only when the reply carries the state.
 */
function classifyClaudeProbeReply(payload: unknown, probeName: string): ProbeAnswer {
  if (!isPlainObject(payload)) {
    return "unrecognized";
  }
  const inner = payload["response"];
  const response = isPlainObject(inner) ? inner : payload;
  const subtype = response["subtype"];
  if (subtype === "success") {
    if (probeName !== CLAUDE_FAST_MODE_PROBE_NAME) {
      return "accepted";
    }
    const body = response["response"];
    return isPlainObject(body) && typeof body["fast_mode_state"] === "string"
      ? "accepted"
      : "unrecognized";
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
  const version = isPlainObject(payload) ? payload["version"] : undefined;
  return typeof version === "string" ? { version } : { unreadableReply: "" };
}

/** The requestable level that turns fast output on. */
export const CLAUDE_FAST_OUTPUT_SPEED = "on";

/** The requestable level for standard speed, and the one any level outside the table runs at. */
export const CLAUDE_STANDARD_OUTPUT_SPEED = "off";

/** Claude Code's static facts. */
export const CLAUDE_DRIVER_DESCRIPTOR: ProviderDriverDescriptor = Object.freeze({
  capabilityDetectionTable: CLAUDE_CAPABILITY_DETECTION_TABLE,
  capabilityProbeChannel: "control_request",
  capabilityProbeNegativeControl: "zzq_nonexistent_subtype",
  // Replaces a live session's full server set.
  capabilityProbeProhibitedNames: Object.freeze(["mcp_set_servers"]),
  classifyCapabilityProbeReply: classifyClaudeProbeReply,
  readReportedVersion: readClaudeReportedVersion,
  // Presence-style gates: the pinned build honors them when set.
  autoUpdateOptOutEnvironment: Object.freeze(
    Object.fromEntries(CLAUDE_UPDATE_SWITCH_NAMES.map((name) => [name, "1"])),
  ),
  // The pinned build declares its state from a three-value vocabulary; only these two are
  // requestable, the third is entered by the provider after a rate limit.
  outputSpeedLevels: Object.freeze([CLAUDE_STANDARD_OUTPUT_SPEED, CLAUDE_FAST_OUTPUT_SPEED]),
  builtInTools: CLAUDE_BUILT_IN_TOOLS,
});
