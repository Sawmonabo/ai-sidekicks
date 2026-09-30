/**
 * Per-capability zero-turn detection: one table entry per `DriverCapabilityFlag` per driver, naming
 * the mechanism that decides it or the admissibility conjunct that fails.
 *
 * - A probe must be zero-turn, non-mutating and decisive at the granularity the flag is consumed
 *   at; otherwise the flag is `static` and resolves from the driver's matrix.
 * - Resolution is withdraw-only (`declared && !withdrawn`): a probe never grants a `false` flag.
 * - Only a name-level refusal withdraws; an unclassifiable reply withdraws too (fail-closed), and
 *   ambiguity resolves toward `accepted`. A negative control that answers, or a rejecting
 *   transport, fails the whole read.
 * - `mcp_set_servers` replaces a live session's full server set, so no probe may issue it.
 */

import type { DriverCapabilityFlag } from "@ai-sidekicks/contracts";

import type { FlooredDriverName } from "./capability-refresh.js";
import type { CapabilityDetectionSource } from "./provider-driver.js";

/** The three conjuncts an admissible probe must satisfy; a `static` entry names those that fail. */
export type ProbeAdmissibilityConjunct =
  | "zero-turn"
  | "non-mutating"
  | "decisive-at-consumption-granularity";

/** A non-empty tuple: a `static` entry naming no failing conjunct would be unjustified. */
type FailingConjuncts = readonly [ProbeAdmissibilityConjunct, ...ProbeAdmissibilityConjunct[]];

/** One admissible probe: the wire name(s) issued, and why the answer decides. */
interface CapabilityProbe {
  /**
   * The wire names this probe issues, with no payload. All must classify `accepted`; a name-level
   * refusal on any one withdraws the flag.
   */
  readonly probeNames: readonly [string, ...string[]];
  /** Why the answer is decisive at the granularity the flag is consumed at. */
  readonly decisiveness: string;
}

/**
 * How one flag's value is arrived at for one driver, discriminated on the wire literal
 * `CapabilityDetectionSource`.
 */
export type CapabilityDetectionMechanism =
  | {
      readonly detectionSource: "static";
      readonly failingConjuncts: FailingConjuncts;
      readonly rationale: string;
    }
  | { readonly detectionSource: "probed"; readonly probe: CapabilityProbe };

/** One mechanism per flag, total over the flag union, so an unanswered flag fails to compile. */
export type DriverCapabilityDetectionTable = Readonly<
  Record<DriverCapabilityFlag, CapabilityDetectionMechanism>
>;

/**
 * Codex's detection table. The one zero-turn channel is the client-request method enumeration;
 * flags delivered by turn parameters, server-to-client frames or handshake state fail decisiveness.
 */
export const CODEX_CAPABILITY_DETECTION_TABLE: DriverCapabilityDetectionTable = Object.freeze({
  resume: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Thread resumption is delivered through the thread lifecycle rather than through a single client-request method the wire reference establishes, so the method enumeration cannot decide it in either direction.",
  },
  steer: {
    detectionSource: "probed",
    probe: {
      probeNames: ["turn/steer"],
      decisiveness:
        "The flag asserts native mid-turn steering exists on the wire, and `turn/steer` is precisely the method its consumers call. The method takes the turn identity the driver already holds, so acceptance leaves no parameter-level fact unestablished — the failure mode that makes the sibling `rollback` entry static.",
    },
  },
  interactive_requests: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "The provider RAISES these requests; they are server-to-client frames and appear in no client-request enumeration, so the one zero-turn channel cannot observe them.",
  },
  mcp: {
    detectionSource: "static",
    failingConjuncts: ["zero-turn", "non-mutating"],
    rationale:
      "The flag asserts only that the provider can invoke MCP server tools, and the sole direct probe of that is invoking one — which consumes a turn and performs the tool's own effect. It resolves from the matrix.",
  },
  tool_calls: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Tool invocations are surfaced as server-to-client items; the client-request enumeration says nothing about the shape of the frames the provider emits.",
  },
  reasoning_stream: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "A stream-output property. No client-request method names it, so the method enumeration cannot decide it in either direction.",
  },
  model_mutation: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Delivered as per-turn overrides on `turn/start`. Acceptance of `turn/start` establishes the method, never that this build's turn parameters carry the override — the same parameter-level gap the `rollback` entry names.",
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
      "The enumeration establishes that `thread/fork` is accepted, not that `ThreadForkParams.lastTurnId` is present — the wire reference verifies that field at the 0.150.1 pin rather than at the 0.141.0 admission floor. The flag resolves from the matrix until a parameter-level probe exists, and the gap is closed at INVOCATION instead: a build that accepts the method and then refuses the boundary field is classified at `CodexLifecycleManager.forkConversation`'s fork dispatch as `driver.capability_unsupported`, rather than surfacing as an opaque provider fault the caller would have to read a deserializer message to understand. That classification covers the refusing build only — one that instead IGNORES an unrecognized boundary field forks the whole thread and is answered by that same leg's turn-ledger check, which is a diagnostic and not a refusal.",
  },
  session_goals: {
    detectionSource: "probed",
    probe: {
      probeNames: ["thread/goal/set", "thread/goal/clear"],
      decisiveness:
        "The flag asserts durable per-thread goal operations exist on the wire, and these are the two methods its consumers call — the driver's `setSessionGoal` and `clearSessionGoal` legs. Both take the thread identity the driver already holds, so method acceptance is decisive at the consumed granularity; probing only the setter would leave a build that accepts goals it cannot clear reported as fully capable.",
    },
  },
  callback_tools: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Daemon-registered tools reach the model through turn construction and return over the tool-call surface; no client-request method names the capability, so the enumeration cannot decide it.",
  },
  subagents: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Peer agents are spawned from WITHIN a turn; the wire reference establishes no client-request method for them, so the enumeration cannot decide it in either direction.",
  },
  transcript_replay: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "An item-injection method being accepted does not establish that a seeded history is faithfully adopted — which is what the flag's consumers depend on, and what the post-replay assertion is the only admissible evidence of.",
  },
  context_compaction: {
    detectionSource: "probed",
    probe: {
      probeNames: ["thread/compact/start"],
      decisiveness:
        "The flag asserts that user-triggered compaction exists on the wire, and this is precisely the method its consumer — the driver's `compactContext` leg — calls. Unlike the sibling `rollback` entry, acceptance leaves NO parameter-level fact unestablished: the method's whole parameter set is the thread identity the driver already holds, so a build that accepts the method accepts every argument this driver will ever send it.",
    },
  },
  provider_commands: {
    detectionSource: "probed",
    probe: {
      probeNames: ["skills/list"],
      decisiveness:
        "The flag asserts that the provider publishes an enumerable command and skill surface, and this is the method the driver's `listProviderCommands` leg reads it through. Every parameter it takes is OPTIONAL, so — as with the compaction entry above — method acceptance is decisive at the granularity the flag is consumed at rather than leaving a required argument unprobed.",
    },
  },
  output_speed: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "FALSE on this driver, and a complete declaration rather than an unprobed gap. The failing conjunct here is DECISIVENESS and not zero-turn — deliberately a different conjunct from the sibling Claude entry. This driver DOES have a zero-turn channel bearing on the axis: the model catalog read, which carries a per-model service-tier list. It still cannot decide the flag, because a service tier is three free-form strings and reading one of them as an output-SPEED tier is a semantic judgment rather than a decidable read. The `false` rests on the two conjuncts the axis itself requires — no statically declarable level vocabulary and no declared-state read — and deliberately NOT on a census of the method root, which bounds availability from below and not above.",
  },
});

/**
 * Claude's detection table. The one zero-turn channel is the control-request registry: an unknown
 * subtype answers `Unsupported control request subtype: <name>`. No entry is currently `probed`.
 */
export const CLAUDE_CAPABILITY_DETECTION_TABLE: DriverCapabilityDetectionTable = Object.freeze({
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
      "FALSE on this driver: no mid-turn content-injection subtype exists, and the steer intervention degrades to queue-plus-interrupt as a REPORTED degradation. A probe cannot grant a flag anyway (resolution is withdraw-only), so the channel has nothing to decide here.",
  },
  interactive_requests: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "The flag is consumed as the round trips the PROVIDER raises — `can_use_tool` and `elicitation`. `request_user_dialog` is not one of them: Claude Code sends it only for dialog kinds the host declares at start, and the daemon declares none, so it never arrives. The control-request census is a census of the registry, not of the inbound dispatcher's accepted set. A first-party probe of the pinned build answers the identical name-level refusal for both as for the negative control, so probing them would withdraw the flag on every read of a build that fully carries it. The channel therefore cannot decide a capability delivered by frames flowing the other way, in either direction.",
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
  transcript_replay: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "No stable prior-turn seeding contract is published for this provider, so no control-request answer establishes that a seeded history is adopted. The matrix cell records this as an open probe; supplying it is future work, together with the post-replay assertion that is the only admissible evidence a replay worked.",
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

/** The per-driver tables, keyed by the driver id the version floor uses. */
export const CAPABILITY_DETECTION_TABLES: Readonly<
  Record<FlooredDriverName, DriverCapabilityDetectionTable>
> = Object.freeze({
  claude: CLAUDE_CAPABILITY_DETECTION_TABLE,
  codex: CODEX_CAPABILITY_DETECTION_TABLE,
});

/**
 * The deliberately unsupported name each driver's channel must still refuse, since a channel that
 * stopped refusing would report every capability available. Dispatched only when a probe exists.
 */
export const CAPABILITY_PROBE_NEGATIVE_CONTROLS: Readonly<Record<FlooredDriverName, string>> =
  Object.freeze({
    claude: "zzq_nonexistent_subtype",
    codex: "zzq/nonexistent_method",
  });

/**
 * Wire names no probe may issue, screened when a table is read and at every dispatch. Starting a
 * thread or turn would break the never-started-session property that keeps probes non-mutating.
 */
export const CAPABILITY_PROBE_PROHIBITED_WIRE_NAMES: readonly string[] = Object.freeze([
  "mcp_set_servers",
  "turn/start",
  "thread/start",
]);

/** Which of a driver's two request surfaces a probe name belongs to. */
export type CapabilityProbeChannel = "control_request" | "client_request";

/** Each driver's one zero-turn probe channel. */
export const CAPABILITY_PROBE_CHANNELS: Readonly<
  Record<FlooredDriverName, CapabilityProbeChannel>
> = Object.freeze({
  claude: "control_request",
  codex: "client_request",
});

/** One probe dispatch. It has no message body, turn identity or payload, so no turn is billed. */
export interface CapabilityProbeRequest {
  readonly driverName: FlooredDriverName;
  readonly channel: CapabilityProbeChannel;
  readonly probeName: string;
  /**
   * The resolved executable path the version handshake proved, carried through (never re-resolved)
   * so each request and the reading name the executable being reported.
   */
  readonly boundExecutablePath: string;
}

/**
 * The injected probe transport, with no default. The implementer owns the deadline and must probe
 * on a connection that has never started a thread (Codex) or sent a user message (Claude).
 * Returns `unknown` because it is untrusted provider output.
 */
export type CapabilityProbeExchange = (request: CapabilityProbeRequest) => Promise<unknown>;

/**
 * Base class for a failure of the probe surface itself. It has no wire `code`, so the refresh
 * scheduler discriminates on the class.
 */
export abstract class CapabilityProbeError extends Error {}

/** The negative control was answered, so the channel's refusals cannot be trusted. */
export class CapabilityProbeNegativeControlError extends CapabilityProbeError {
  readonly driverName: FlooredDriverName;
  readonly probeName: string;

  constructor(driverName: FlooredDriverName, probeName: string) {
    super(
      `capability probe negative control '${probeName}' was answered by driver '${driverName}'; refusing to report capabilities from a channel that does not refuse`,
    );
    this.name = "CapabilityProbeNegativeControlError";
    this.driverName = driverName;
    this.probeName = probeName;
  }
}

/** The transport rejected: no reading exists, so nothing is declared. */
export class CapabilityProbeTransportError extends CapabilityProbeError {
  readonly driverName: FlooredDriverName;
  readonly probeName: string;

  constructor(driverName: FlooredDriverName, probeName: string, options: { cause: unknown }) {
    super(
      `capability probe '${probeName}' transport failed for driver '${driverName}'`,
      // `cause` is provider- or transport-originated; it stays data and is never put in a message.
      options,
    );
    this.name = "CapabilityProbeTransportError";
    this.driverName = driverName;
    this.probeName = probeName;
  }
}

/** A probe name the table or a caller must never issue reached the dispatcher. */
export class CapabilityProbeProhibitedNameError extends CapabilityProbeError {
  readonly probeName: string;

  constructor(probeName: string) {
    super(`capability probe refused: '${probeName}' is a prohibited probe wire name`);
    this.name = "CapabilityProbeProhibitedNameError";
    this.probeName = probeName;
  }
}

/**
 * Throws `CapabilityProbeProhibitedNameError` for a wire name no probe may issue, wherever it came
 * from.
 */
export function assertProbeWireNameAdmissible(probeName: string): void {
  if (CAPABILITY_PROBE_PROHIBITED_WIRE_NAMES.includes(probeName)) {
    throw new CapabilityProbeProhibitedNameError(probeName);
  }
}

/** True for every failure of the probe surface; the refresh scheduler uses it to tag its leg. */
export function isCapabilityProbeError(value: unknown): value is CapabilityProbeError {
  return value instanceof CapabilityProbeError;
}

/**
 * What one probe's answer says about its name. `accepted` includes a handler's own typed refusal;
 * only a name-level refusal withdraws.
 */
type ProbeAnswer = "accepted" | "unknown-name" | "unrecognized";

const CLAUDE_UNSUPPORTED_SUBTYPE_PREFIX = "Unsupported control request subtype:";

/**
 * Measured at the pinned build: the Codex app-server answers this for both an unaccepted name and
 * an accepted name whose payload does not deserialize, so the code alone classifies nothing.
 */
const CODEX_INVALID_REQUEST_CODE = -32600;

/**
 * The standard JSON-RPC method-not-found code. The pinned build does not emit it for an
 * unaccepted name, but a build that adopts it must not be read as acceptance.
 */
const CODEX_METHOD_NOT_FOUND_CODE = -32601;

/**
 * The deserializer's unknown-variant message: the refused variant, then the accepted set. Anchored
 * on those fragments because the `Invalid request: ` preamble does not discriminate.
 */
const CODEX_UNKNOWN_VARIANT_PATTERN = /unknown variant `([^`]*)`, expected one of (.+)$/s;

/** Every backtick-quoted name in an unknown-variant enumeration tail. */
function parseEnumeratedWireNames(enumerationTail: string): readonly string[] {
  return [...enumerationTail.matchAll(/`([^`]*)`/g)].map((match) => match[1] ?? "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Classify one Claude `control_response`, given the full envelope or the inner response object.
 */
export function classifyClaudeProbeReply(payload: unknown): ProbeAnswer {
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
 * Classify one Codex reply about `probeName`. `-32600` is `unknown-name` only when the message's
 * unknown-variant enumeration names the probe as refused and its accepted set lacks it; every
 * ambiguous arm resolves toward `accepted`, since a wrong `unknown-name` disables a capability.
 */
export function classifyCodexProbeReply(payload: unknown, probeName: string): ProbeAnswer {
  const envelope = asRecord(payload);
  if (envelope === undefined) {
    return "unrecognized";
  }
  if ("result" in envelope) {
    return "accepted";
  }
  const error = asRecord(envelope["error"]);
  if (error === undefined) {
    return "unrecognized";
  }
  const code = error["code"];
  if (typeof code !== "number") {
    return "unrecognized";
  }
  if (code === CODEX_METHOD_NOT_FOUND_CODE) {
    return "unknown-name";
  }
  if (code !== CODEX_INVALID_REQUEST_CODE) {
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

/** Only the Codex classifier uses `probeName`; the Claude refusal is name-level already. */
type ProbeReplyClassifier = (payload: unknown, probeName: string) => ProbeAnswer;

const PROBE_REPLY_CLASSIFIERS: Readonly<Record<FlooredDriverName, ProbeReplyClassifier>> =
  Object.freeze({
    claude: classifyClaudeProbeReply,
    codex: classifyCodexProbeReply,
  });

/** One reason a detection table is not admissible. */
export interface CapabilityDetectionTableViolation {
  readonly driverName: FlooredDriverName;
  readonly flag: DriverCapabilityFlag;
  readonly reason: string;
}

/**
 * Report every entry that is not admissible: the runtime half of what the tuple types enforce at
 * compile time, for a table that may arrive from elsewhere.
 */
export function findCapabilityDetectionTableViolations(
  driverName: FlooredDriverName,
  table: DriverCapabilityDetectionTable,
): readonly CapabilityDetectionTableViolation[] {
  const violations: CapabilityDetectionTableViolation[] = [];
  for (const [flag, mechanism] of Object.entries(table) as [
    DriverCapabilityFlag,
    CapabilityDetectionMechanism,
  ][]) {
    if (mechanism.detectionSource === "static") {
      if (mechanism.failingConjuncts.length === 0) {
        violations.push({
          driverName,
          flag,
          reason: "a `static` entry must name at least one failing admissibility conjunct",
        });
      }
      if (mechanism.rationale.trim() === "") {
        violations.push({ driverName, flag, reason: "a `static` entry must carry a rationale" });
      }
      continue;
    }
    const { probeNames } = mechanism.probe;
    if (probeNames.length === 0) {
      violations.push({
        driverName,
        flag,
        reason: "a `probed` entry must declare at least one probe wire name",
      });
    }
    // A probe issues every name, so a prohibited one anywhere reaches the wire.
    for (const probeName of probeNames) {
      if (probeName.trim() === "") {
        violations.push({
          driverName,
          flag,
          reason: "a `probed` entry must declare a non-empty probe wire name",
        });
      }
      if (CAPABILITY_PROBE_PROHIBITED_WIRE_NAMES.includes(probeName)) {
        violations.push({
          driverName,
          flag,
          reason: `a probe may never issue the prohibited wire name '${probeName}'`,
        });
      }
    }
    if (mechanism.probe.decisiveness.trim() === "") {
      violations.push({
        driverName,
        flag,
        reason: "a `probed` entry must state why its answer is decisive",
      });
    }
  }
  return violations;
}

/** One flag withdrawn by its own probe, with the disposition that withdrew it. */
interface CapabilityProbeDiagnostic {
  readonly driverName: FlooredDriverName;
  readonly flag: DriverCapabilityFlag;
  /** The first name, in table order, that withdrew the flag; the rest are not dispatched. */
  readonly probeName: string;
  /** `unrecognized-reply` is an answer that could not be classified, never read as availability. */
  readonly disposition: "unknown-name" | "unrecognized-reply";
}

/**
 * One live detection reading for one driver. `detectionSource` is total over the flag set;
 * `withdrawnFlags` is separate because a flag is `probed` whether its probe confirmed or withdrew.
 */
export interface CapabilityDetectionReading {
  readonly driverName: FlooredDriverName;
  /** The build this reading describes, so a composition site can refuse a mixed report. */
  readonly boundExecutablePath: string;
  readonly detectionSource: Readonly<Record<DriverCapabilityFlag, CapabilityDetectionSource>>;
  readonly withdrawnFlags: readonly DriverCapabilityFlag[];
  readonly diagnostics: readonly CapabilityProbeDiagnostic[];
}

/** What one detection read needs: the driver, the build, and the transport. */
export interface CapabilityDetectionReadRequest {
  readonly driverName: FlooredDriverName;
  /**
   * The resolved executable path the version handshake proved
   * (`SpawnedProviderVersionReading.resolvedExecutablePath`). Never re-resolved: a second
   * resolution can differ (a `PATH` change, an installer swap).
   */
  readonly boundExecutablePath: string;
  readonly exchange: CapabilityProbeExchange;
}

/**
 * Read one driver's detection sources through `exchange`; with no probe declared, nothing is sent.
 * Throws `CapabilityProbeNegativeControlError` when the negative control is answered,
 * `CapabilityProbeTransportError` when the transport rejects, and the prohibited-name error.
 */
export async function readCapabilityDetection(
  request: CapabilityDetectionReadRequest,
): Promise<CapabilityDetectionReading> {
  const { driverName, boundExecutablePath, exchange } = request;
  const table = CAPABILITY_DETECTION_TABLES[driverName];
  const violations = findCapabilityDetectionTableViolations(driverName, table);
  if (violations.length > 0) {
    // A malformed table is a daemon fault, not provider misbehavior.
    throw new Error(
      `capability detection table for driver '${driverName}' is inadmissible: ${violations
        .map((violation) => `${violation.flag}: ${violation.reason}`)
        .join("; ")}`,
    );
  }

  const tableEntries = Object.entries(table) as [
    DriverCapabilityFlag,
    CapabilityDetectionMechanism,
  ][];
  const declaresProbe = tableEntries.some(
    ([, mechanism]) => mechanism.detectionSource === "probed",
  );

  // Runs first: a channel that answers a name that cannot exist would accept every probe.
  if (declaresProbe) {
    const negativeControlName = CAPABILITY_PROBE_NEGATIVE_CONTROLS[driverName];
    const negativeControlAnswer = await dispatchProbe(
      driverName,
      negativeControlName,
      boundExecutablePath,
      exchange,
    );
    if (negativeControlAnswer !== "unknown-name") {
      throw new CapabilityProbeNegativeControlError(driverName, negativeControlName);
    }
  }

  const detectionSource: Record<DriverCapabilityFlag, CapabilityDetectionSource> = {} as Record<
    DriverCapabilityFlag,
    CapabilityDetectionSource
  >;
  const withdrawnFlags: DriverCapabilityFlag[] = [];
  const diagnostics: CapabilityProbeDiagnostic[] = [];

  // Table order, one dispatch per distinct probe name (two flags sharing a name issue it once).
  const answersByProbeName = new Map<string, ProbeAnswer>();
  for (const [flag, mechanism] of tableEntries) {
    detectionSource[flag] = mechanism.detectionSource;
    if (mechanism.detectionSource !== "probed") {
      continue;
    }
    // All names must classify `accepted`; the first that does not withdraws the flag.
    for (const probeName of mechanism.probe.probeNames) {
      let answer = answersByProbeName.get(probeName);
      if (answer === undefined) {
        answer = await dispatchProbe(driverName, probeName, boundExecutablePath, exchange);
        answersByProbeName.set(probeName, answer);
      }
      if (answer === "accepted") {
        continue;
      }
      withdrawnFlags.push(flag);
      diagnostics.push({
        driverName,
        flag,
        probeName,
        disposition: answer === "unknown-name" ? "unknown-name" : "unrecognized-reply",
      });
      break;
    }
  }

  return Object.freeze({
    driverName,
    boundExecutablePath,
    detectionSource: Object.freeze(detectionSource),
    withdrawnFlags: Object.freeze(withdrawnFlags),
    diagnostics: Object.freeze(diagnostics),
  });
}

async function dispatchProbe(
  driverName: FlooredDriverName,
  probeName: string,
  boundExecutablePath: string,
  exchange: CapabilityProbeExchange,
): Promise<ProbeAnswer> {
  // Screened here as well as at the table, so a name from anywhere else is refused too.
  assertProbeWireNameAdmissible(probeName);
  let payload: unknown;
  try {
    payload = await exchange({
      driverName,
      channel: CAPABILITY_PROBE_CHANNELS[driverName],
      probeName,
      boundExecutablePath,
    });
  } catch (cause) {
    throw new CapabilityProbeTransportError(driverName, probeName, { cause });
  }
  return PROBE_REPLY_CLASSIFIERS[driverName](payload, probeName);
}

/**
 * Intersect a driver's declared matrix with what the probes found: `declared && !withdrawn`, since
 * a probe must never declare a capability the driver code does not implement. Returns a fresh
 * record because the matrix constant is frozen and shared.
 */
export function applyCapabilityDetection(
  declared: Readonly<Record<DriverCapabilityFlag, boolean>>,
  reading: CapabilityDetectionReading,
): Record<DriverCapabilityFlag, boolean> {
  const resolved: Record<DriverCapabilityFlag, boolean> = { ...declared };
  for (const flag of reading.withdrawnFlags) {
    resolved[flag] = false;
  }
  return resolved;
}
