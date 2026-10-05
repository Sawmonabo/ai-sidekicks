// Codex's static facts: what the daemon reads about it before any session exists.

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/jsonrpc";
import semver from "semver";

import type { DriverCapabilityDetectionTable, ProbeAnswer } from "../../capability/probe.js";
import type {
  ProviderDriverDescriptor,
  ReportedVersionReading,
} from "../provider-driver-descriptor.js";
import { isPlainObject } from "../../record-readers.js";
import { CODEX_BUILT_IN_TOOLS } from "./tools.js";

/**
 * The detection table. The one zero-turn channel is the client-request method enumeration; flags
 * delivered by turn parameters, server-to-client frames or handshake state fail decisiveness.
 */
const CODEX_CAPABILITY_DETECTION_TABLE: DriverCapabilityDetectionTable = Object.freeze({
  resume: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Thread resumption is delivered through the thread lifecycle rather than through a " +
      "single client-request method the wire reference establishes, so the method " +
      "enumeration cannot decide it in either direction.",
  },
  steer: {
    detectionSource: "probed",
    probe: {
      probeNames: ["turn/steer"],
      decisiveness:
        "The flag asserts native mid-turn steering exists on the wire, and `turn/steer` is " +
        "precisely the method its consumers call. The method takes the turn identity the " +
        "driver already holds, so acceptance leaves no parameter-level fact unestablished " +
        "— the failure mode that makes the sibling `rollback` entry static.",
    },
  },
  interactive_requests: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "The provider RAISES these requests; they are server-to-client frames and appear in no " +
      "client-request enumeration, so the one zero-turn channel cannot observe them.",
  },
  mcp: {
    detectionSource: "static",
    failingConjuncts: ["zero-turn", "non-mutating"],
    rationale:
      "The flag asserts only that the provider can invoke MCP server tools, and the sole " +
      "direct probe of that is invoking one — which consumes a turn and performs the " +
      "tool's own effect. It resolves from the matrix.",
  },
  tool_calls: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Tool invocations are surfaced as server-to-client items; the client-request " +
      "enumeration says nothing about the shape of the frames the provider emits.",
  },
  reasoning_stream: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "A stream-output property. No client-request method names it, so the method " +
      "enumeration cannot decide it in either direction.",
  },
  model_mutation: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Delivered as per-turn overrides on `turn/start`. Acceptance of `turn/start` " +
      "establishes the method, never that this build's turn parameters carry the override " +
      "— the same parameter-level gap the `rollback` entry names.",
  },
  structured_output: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "A `turn/start` parameter, decided at parameter granularity and not at method granularity.",
  },
  rollback: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "The enumeration establishes that `thread/fork` is accepted, not that " +
      "`ThreadForkParams.lastTurnId` is present — the wire reference verifies that field " +
      "at its pin, not at every older build the driver may admit. The flag resolves from the " +
      "matrix until a parameter-level probe exists, and the gap is closed at INVOCATION " +
      "instead: a build that accepts the method and then refuses the boundary field is " +
      "classified at `CodexLifecycleManager.forkConversation`'s fork dispatch as " +
      "`driver.capability_unsupported`, rather than surfacing as an opaque provider fault " +
      "the caller would have to read a deserializer message to understand. That " +
      "classification covers the refusing build only — one that instead IGNORES an " +
      "unrecognized boundary field forks the whole thread and is answered by that same leg's " +
      "turn-ledger check, which is a diagnostic and not a refusal.",
  },
  session_fork: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "The enumeration establishes that `thread/fork` is accepted, not that its inclusive-turn " +
      "boundary field is; a build that refuses the field is classified at fork dispatch as " +
      "`driver.capability_unsupported`.",
  },
  session_goals: {
    detectionSource: "probed",
    probe: {
      probeNames: ["thread/goal/set", "thread/goal/clear"],
      decisiveness:
        "The flag asserts durable per-thread goal operations exist on the wire, and these " +
        "are the two methods its consumers call — the driver's `setSessionGoal` and " +
        "`clearSessionGoal` legs. Both take the thread identity the driver already holds, so " +
        "method acceptance is decisive at the consumed granularity; probing only the setter " +
        "would leave a build that accepts goals it cannot clear reported as fully capable.",
    },
  },
  callback_tools: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Delivered as the daemon's per-session MCP url entry, never as a thread's dynamic " +
      "tools. The capability is the daemon's to deliver, so no provider answer decides it.",
  },
  subagents: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Peer agents are spawned from WITHIN a turn; the wire reference establishes no " +
      "client-request method for them, so the enumeration cannot decide it in either direction.",
  },
  context_compaction: {
    detectionSource: "probed",
    probe: {
      probeNames: ["thread/compact/start"],
      decisiveness:
        "The flag asserts that user-triggered compaction exists on the wire, and this is " +
        "precisely the method its consumer — the driver's `compactContext` leg — calls. " +
        "Unlike the sibling `rollback` entry, acceptance leaves NO parameter-level fact " +
        "unestablished: the method's whole parameter set is the thread identity the driver " +
        "already holds, so a build that accepts the method accepts every argument this " +
        "driver will ever send it.",
    },
  },
  provider_commands: {
    detectionSource: "probed",
    probe: {
      probeNames: ["skills/list"],
      decisiveness:
        "The flag asserts that the provider publishes an enumerable command and skill " +
        "surface, and this is the method the driver's `listProviderCommands` leg reads it " +
        "through. Every parameter it takes is OPTIONAL, so — as with the compaction entry " +
        "above — method acceptance is decisive at the granularity the flag is consumed at " +
        "rather than leaving a required argument unprobed.",
    },
  },
  output_speed: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Declared TRUE from this table, and the failing conjunct is DECISIVENESS, not zero-turn — " +
      "deliberately a different conjunct from the sibling Claude entry. This driver DOES have a " +
      "zero-turn channel bearing on the axis: the model catalog read, which carries a per-model " +
      "service-tier list and is where this driver's levels come from. It still cannot decide " +
      "the flag, because a service tier is three free-form strings and reading one of them as " +
      "an output-SPEED tier is a semantic judgment rather than a decidable read. The declaration " +
      "rests on the two things the axis requires and this driver has: the per-model level " +
      "vocabulary on that catalog read, and the thread's declared tier on its establishment " +
      "reply and on the settings-changed notification.",
  },
});

/**
 * The deserializer's unknown-variant message: the refused variant, then the accepted set. Anchored
 * on those fragments because the `Invalid request: ` preamble does not discriminate.
 */
const CODEX_UNKNOWN_VARIANT_PATTERN = /unknown variant `([^`]*)`, expected one of (.+)$/s;

/** Every backtick-quoted name in an unknown-variant enumeration tail. */
function parseEnumeratedWireNames(enumerationTail: string): readonly string[] {
  return [...enumerationTail.matchAll(/`([^`]*)`/g)].map((match) => match[1] ?? "");
}

/**
 * Classify one Codex reply about `probeName`. `-32600` is `unknown-name` only when the message's
 * unknown-variant enumeration names the probe as refused and its accepted set lacks it; every
 * ambiguous arm resolves toward `accepted`, since a wrong `unknown-name` disables a capability.
 */
function classifyCodexProbeReply(payload: unknown, probeName: string): ProbeAnswer {
  if (!isPlainObject(payload)) {
    return "unrecognized";
  }
  if ("result" in payload) {
    return "accepted";
  }
  const error = payload["error"];
  if (!isPlainObject(error)) {
    return "unrecognized";
  }
  const code = error["code"];
  if (typeof code !== "number") {
    return "unrecognized";
  }
  // The pinned build does not emit method-not-found for an unaccepted name, but a build that
  // adopts it must not be read as acceptance.
  if (code === JsonRpcErrorCode.MethodNotFound) {
    return "unknown-name";
  }
  // The pinned build answers invalid-request both for an unaccepted name and for an accepted name
  // whose payload does not deserialize, so the code alone classifies nothing.
  if (code !== JsonRpcErrorCode.InvalidRequest) {
    return "accepted";
  }
  const message = error["message"];
  if (typeof message !== "string") {
    return "accepted";
  }
  const unknownVariant = CODEX_UNKNOWN_VARIANT_PATTERN.exec(message);
  const refusedVariant = unknownVariant?.[1];
  const enumerationTail = unknownVariant?.[2];
  if (refusedVariant === undefined || enumerationTail === undefined) {
    return "accepted";
  }
  if (refusedVariant !== probeName) {
    return "accepted";
  }
  return parseEnumeratedWireNames(enumerationTail).includes(probeName)
    ? "accepted"
    : "unknown-name";
}

/**
 * Reads the version out of the `initialize` reply's `userAgent`, which also carries the caller's
 * own version: only the token after `<clientName>/` counts, and it must be canonical semver, since
 * the gate's parser would find `X.Y.Z` inside a longer token. `server/diagnostics` needs the
 * experimental API and carries no version (measured at `0.149.1`), so there is no fallback.
 */
function readCodexReportedVersion(payload: unknown, clientName: string): ReportedVersionReading {
  if (clientName === "" || clientName.includes("/") || /\s/.test(clientName)) {
    throw new Error(
      "Codex version extraction requires a daemon-supplied clientInfo.name carrying no '/' " +
        "and no whitespace",
    );
  }
  const userAgent = isPlainObject(payload) ? payload["userAgent"] : undefined;
  if (typeof userAgent !== "string") {
    return { unreadableReply: "" };
  }
  const firstSlashIndex = userAgent.indexOf("/");
  if (firstSlashIndex === -1 || userAgent.slice(0, firstSlashIndex) !== clientName) {
    return { unreadableReply: userAgent };
  }
  const versionToken = /^\S*/.exec(userAgent.slice(firstSlashIndex + 1))?.[0] ?? "";
  // Reports the whole `userAgent`, not the carved fragment.
  return semver.valid(versionToken) === versionToken
    ? { version: versionToken }
    : { unreadableReply: userAgent };
}

/** Codex's static facts. */
export const CODEX_DRIVER_DESCRIPTOR: ProviderDriverDescriptor = Object.freeze({
  capabilityDetectionTable: CODEX_CAPABILITY_DETECTION_TABLE,
  capabilityProbeChannel: "client_request",
  capabilityProbeNegativeControl: "zzq/nonexistent_method",
  capabilityProbeProhibitedNames: Object.freeze(["turn/start", "thread/start"]),
  classifyCapabilityProbeReply: classifyCodexProbeReply,
  readReportedVersion: readCodexReportedVersion,
  // codex-cli documents no environment opt-out; the driver pins an exact build path instead.
  autoUpdateOptOutEnvironment: Object.freeze({}),
  // No static `outputSpeedLevels`: the provider publishes its service tiers on each model of the
  // catalog read, so the levels are `ProviderModel.outputSpeedLevels` and never a driver constant.
  builtInTools: CODEX_BUILT_IN_TOOLS,
});
