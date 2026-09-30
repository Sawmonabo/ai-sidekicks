/**
 * Codex app-server transport (`CodexAppServerConnection`, JSONL JSON-RPC over one `PtyHost`) and
 * lifecycle (`CodexLifecycleManager`). No port separates them, so tests drive the real framing
 * through a fake `PtyHost`.
 * - `/bin/sh -c` spawns the provider (see the prelude): a PTY slave starts canonical with echo on,
 *   and `codex app-server` never calls `tcsetattr`. Canonical mode silently drops an input line
 *   over MAX_CANON (Darwin 1024 bytes; `codex-cli 0.149.1` answered a 1015-byte frame, not 1045).
 * - A failed resume never becomes a new session: it returns the typed `recovery-needed` failure.
 * - Every spawn or dispose runs inside `#claimSessionSlot` (`establishing`, `live`, `closing`),
 *   held until fully settled, so no owned process exists without a held slot; a `startRun` that
 *   only installs a route re-reads the slot after its await.
 * - Errors use registered codes only: `driver.unavailable` (503), `driver.timeout` (504).
 */

import {
  CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME,
  DRIVER_AUTH_DETAIL_MAX_LEN,
  DRIVER_FAILURE_DETAIL_MAX_LEN,
  DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN,
  DRIVER_PROVIDER_COMMAND_ENTRIES_MAX,
  DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN,
  DriverAuthProbeResultSchema,
  DriverResumeResultSchema,
  ForkConversationResultSchema,
  ProviderCommandEntrySchema,
  SessionIdSchema,
  wireFreeFormString,
  type ClearSessionGoalParams,
  type CloseSessionParams,
  type CompactContextParams,
  type CreateSessionParams,
  type DriverAuthProbeResult,
  type DriverCapabilityFlag,
  type DriverCompactionResult,
  type ListProviderCommandsParams,
  type ProviderCommandEntry,
  type ProviderCommandListResult,
  type DriverResumeResult,
  type ForkConversationResult,
  type DriverTransportConfig,
  type ExecutionPosture,
  type InterruptRunParams,
  type DriverTranscriptReplayResult,
  type ProviderSessionHandle,
  type ReplayTranscriptParams,
  type PtyHost,
  type RecoveryCondition,
  type ResumeSessionParams,
  type ForkConversationParams,
  type RunId,
  type SessionId,
  type SetSessionGoalParams,
  type SpawnRequest,
  type SubagentPolicy,
  type StartRunParams,
} from "@ai-sidekicks/contracts";

import type { DriverDiagnosticsEmitter } from "../../driver-diagnostics.js";
import { PendingCompactionRegistry } from "../../compaction-wait.js";
import {
  ThreadFrameRouter,
  type ChildThreadAnnouncement,
  type RoutableProviderFrame,
  type SubagentLifecycleEmission,
  type ThreadFrameRoute,
  type ThreadFrameRouterConfig,
} from "../../thread-frame-router.js";
import {
  UsageDeltaAccountant,
  type CumulativeAxisReadings,
  type CumulativeUsageReading,
  type MeteredUsageDelta,
} from "../../usage-delta-accountant.js";
import {
  buildProviderSpawnEnv,
  hostEnvNameMatchForPlatform,
  type CredentialEnvPolicy,
  type SpawnEnvNameMatch,
} from "../../spawn-env.js";
import {
  AmbiguousDeliveryReconciler,
  classifyProviderRequestFailure,
  PermanentStructuralRefusalError,
  type UserTurnReadbackReader,
  type ProviderRefusalShape,
  type ProviderRequestFailureObservation,
} from "../../transcript/failure-mapping.js";
import {
  assertReplayReconstituted,
  PostReplayAssertionFailedError,
  ReplayTargetLedger,
  type PostReplayVerdict,
  type ReplayTargetAbandonmentCause,
  type ReplayTargetReadback,
  type ReplayTargetReadbackReader,
  type SeededTranscriptFrame,
} from "../../transcript/replay-assertion.js";

import {
  CODEX_SKILLS_CHANGED_METHOD,
  CODEX_THREAD_COMPACTED_METHOD,
  CODEX_THREAD_STARTED_METHOD,
  CODEX_THREAD_TOKEN_USAGE_METHOD,
  CODEX_TURN_COMPLETED_METHOD,
  classifyCodexTurnEvidence,
  classifyCodexTurnEvidenceObservation,
  CodexTerminalEmissionGate,
  classifyCodexFrameFamilyForRouting,
  deriveCodexChildThreadAnnouncement,
} from "./event-normalizer.js";
import {
  OutboundFrameTripwire,
  OutboundTextFrameWriter,
  RuntimeBindingQuarantine,
  UNRECOGNIZED_TURN_EVIDENCE,
  observedTurnEvidence,
  composeSupersededDeliveryRunFailure,
  composeTextNeutralizationRunFailure,
  type CallerDeclaredFrameOrigin,
  type OutboundTextFrame,
  type TextNeutralityMechanismGrade,
  type TextNeutralizationRunFailure,
  type TripwireDecision,
  type TurnEvidenceClass,
  type TurnEvidenceClassification,
} from "../outbound-frame.js";
// Type-only: `intervention.ts` declares the port this manager satisfies and imports nothing here.
import type { CodexSteerAcknowledgement, CodexSteerRunRequest } from "./intervention.js";
// Runtime import, acyclic: `capabilities.ts` never imports this module.
import { CODEX_DRIVER_NAME } from "./capabilities.js";
import { mintUuidV7 } from "../../../ids/uuid-v7.js";

/**
 * Line the prelude emits once the tty is configured; nothing is written before it, because early
 * writes are echoed.
 */
export const CODEX_APP_SERVER_READY_SENTINEL: string = "__codex_app_server_ready__";

/**
 * The `sh -c` script: `stty`, readiness sentinel, then `exec` of the provider; `&&` makes a failed
 * `stty` a typed startup failure, and `"$@"` passes argv words unparsed so no path becomes shell
 * syntax. Windows needs an equivalent termios step or a non-PTY transport.
 */
export const CODEX_APP_SERVER_SHELL_PRELUDE: string =
  `stty -icanon -echo` +
  ` && printf '%s\\n' ${CODEX_APP_SERVER_READY_SENTINEL}` +
  ` && exec "$${CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME}" "$@"`;

/** The script's `$0` label; without it `sh -c` would take the first real argument as `$0`. */
export const CODEX_APP_SERVER_SHELL_ARGV0: string = "codex-app-server";

/** Default provider binary; overridable so a node-pinned path can be supplied. */
const CODEX_DEFAULT_EXECUTABLE_PATH: string = "codex";

/**
 * How the daemon reaches one app-server process. The endpoint is the transport: a `--listen
 * unix://` server refuses a stdio `initialize`, so each arm reaches a process and never adds a
 * listener to the stdio one.
 */
export type CodexTransportSelection =
  | { readonly transport: "stdio" }
  | { readonly transport: "unix-socket"; readonly socketPath: string }
  | {
      readonly transport: "websocket";
      readonly endpoint: string;
      readonly bearerTokenRef: string;
    };

/**
 * A resolved websocket bearer credential in one of the modes the provider accepts. Every arm
 * carries paths or digests, never token bytes, so a token never appears in argv.
 */
export type CodexWebsocketBearerCredential =
  | {
      readonly mode: "capability-token";
      /** Absolute path, per `--ws-token-file <PATH>`. */
      readonly tokenFilePath: string;
    }
  | {
      readonly mode: "capability-token-digest";
      /** Hex SHA-256, per `--ws-token-sha256 <HEX>`. */
      readonly tokenSha256: string;
    }
  | {
      readonly mode: "signed-bearer-token";
      /** Absolute path, per `--ws-shared-secret-file <PATH>`. */
      readonly sharedSecretFilePath: string;
      readonly issuer: string;
      readonly audience: string;
    };

/**
 * Resolves a `bearerTokenRef` to the credential the listener starts with. Called at connection
 * time and never cached, so a rotated credential is picked up by the next connection.
 */
export type CodexBearerCredentialResolver = (
  bearerTokenRef: string,
) => Promise<CodexWebsocketBearerCredential>;

/**
 * Bridges the JSONL JSON-RPC connection to a websocket listener (the unix arm needs none: the
 * provider ships `proxy --sock`). A websocket driver built without one refuses at construction,
 * never falling back to stdio, which would reach a different process.
 */
export interface CodexWebsocketTransportConnector {
  /** Called after the credential resolves; the endpoint is verbatim from config. */
  connect(request: {
    readonly endpoint: string;
    readonly credential: CodexWebsocketBearerCredential;
  }): Promise<void>;
}

/**
 * Resolves the transport from registry config; absent config is `stdio`. A unix endpoint may be
 * `unix://` or a bare path; a websocket endpoint stays verbatim (the provider parses host and
 * port). Throws `CodexDriverConfigError` for an empty endpoint or `bearerTokenRef`.
 */
export function resolveCodexTransportSelection(
  config: DriverTransportConfig | undefined,
): CodexTransportSelection {
  if (config === undefined || config.transport === "stdio") {
    return { transport: "stdio" };
  }
  if (config.transport === "unix-socket") {
    const socketPath = config.endpoint.startsWith(CODEX_UNIX_ENDPOINT_SCHEME)
      ? config.endpoint.slice(CODEX_UNIX_ENDPOINT_SCHEME.length)
      : config.endpoint;
    if (socketPath.length === 0) {
      throw new CodexDriverConfigError(
        "DriverTransportConfig.endpoint named no unix socket path.",
        "DriverTransportConfig.endpoint",
      );
    }
    return { transport: "unix-socket", socketPath };
  }
  if (config.endpoint.length === 0) {
    throw new CodexDriverConfigError(
      "DriverTransportConfig.endpoint named no websocket endpoint.",
      "DriverTransportConfig.endpoint",
    );
  }
  // The type only requires the string; an empty one names no credential, which would be an
  // unauthenticated listener.
  if (config.bearerTokenRef.length === 0) {
    throw new CodexDriverConfigError(
      "DriverTransportConfig.bearerTokenRef named no credential; an unauthenticated websocket listener is refused.",
      "DriverTransportConfig.bearerTokenRef",
    );
  }
  return {
    transport: "websocket",
    endpoint: config.endpoint,
    bearerTokenRef: config.bearerTokenRef,
  };
}

const CODEX_UNIX_ENDPOINT_SCHEME = "unix://";

/**
 * The provider argv for one transport selection, as positional words appended after the prelude's
 * `$0`. Throws `CodexDriverConfigError` for a websocket selection with no resolved credential.
 */
export function composeCodexTransportArgv(
  selection: CodexTransportSelection,
  credential: CodexWebsocketBearerCredential | null,
): readonly string[] {
  switch (selection.transport) {
    case "stdio":
      // Left implicit: the default endpoint is the provider's own; no flag spelling is relied on.
      return ["app-server"];
    case "unix-socket":
      return ["app-server", "proxy", "--sock", selection.socketPath];
    case "websocket": {
      if (credential === null) {
        throw new CodexDriverConfigError(
          "A websocket transport was selected with no resolved bearer credential; refusing to start an unauthenticated listener.",
          "DriverTransportConfig.bearerTokenRef",
        );
      }
      // Flags at `codex-cli 0.150.1`: `--listen <URL>` (`stdio://` default, `unix://`,
      // `ws://IP:PORT`, `off`) and `--ws-auth capability-token|signed-bearer-token`.
      const argv = ["app-server", "--listen", selection.endpoint];
      switch (credential.mode) {
        case "capability-token":
          argv.push("--ws-auth", "capability-token", "--ws-token-file", credential.tokenFilePath);
          return argv;
        case "capability-token-digest":
          argv.push("--ws-auth", "capability-token", "--ws-token-sha256", credential.tokenSha256);
          return argv;
        case "signed-bearer-token":
          argv.push(
            "--ws-auth",
            "signed-bearer-token",
            "--ws-shared-secret-file",
            credential.sharedSecretFilePath,
            "--ws-issuer",
            credential.issuer,
            "--ws-audience",
            credential.audience,
          );
          return argv;
      }
    }
  }
}

/**
 * Ceiling on one unterminated inbound line (UTF-16 code units, since counting bytes rescans the
 * tail on every chunk) and on one outbound frame (UTF-8 bytes; the provider publishes no limit).
 * It stops a peer that never sends a newline from growing the buffer until the daemon dies.
 */
export const CODEX_MAX_LINE_LENGTH: number = 32 * 1024 * 1024;

/**
 * The refusal reason substituted for an answer too large for the wire: a constant, so it cannot
 * itself exceed the bound. The answer is refused, never truncated (a truncated tool output reads
 * as complete), and the loss is recorded on both diagnostic sinks.
 */
export const CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON: string =
  "The daemon composed an answer larger than this transport will send; refusing rather than delivering a truncated result.";

/**
 * Bound on a provider `turnId` before it enters a refusal reason or diagnostic; matches
 * `DRIVER_TOOL_CALL_ID_MAX_LEN`, the same kind of opaque handle.
 */
const CODEX_ROUTED_ASK_TURN_ID_MAX_LEN = 256;

/**
 * The ten server-initiated request methods of the pinned protocol (`ServerRequest` union at
 * `codex-cli 0.150.1`; regenerate, do not transcribe). An observability annotation, not a routing
 * filter: routing is keyed on the descriptors below, and any other method gets `-32601`.
 */
const CODEX_SERVER_REQUEST_METHODS: ReadonlySet<string> = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
  "item/tool/call",
  "account/chatgptAuthTokens/refresh",
  "attestation/generate",
  "applyPatchApproval",
  "execCommandApproval",
]);

// Server-request routing: this table connects inbound asks to the normalizer's
// `approval.requested`, `question.asked` and `tool.invoked`; otherwise every method+id frame gets
// `-32601`.
// Routed: `item/tool/call`, the three modern approval methods, the legacy pair (routed so the
// answer does not depend on the provider's spelling) and `mcpServer/elicitation/request`.
// Unrouted, so `-32601`: `item/tool/requestUserInput` (experimental, unreachable at
// `experimentalApi: false`), `attestation/generate` (declined at negotiation) and
// `account/chatgptAuthTokens/refresh` (credential brokering this driver does not do).
// Fail-closed: a routed method with no responder, a refusing one or a throwing one answers with
// the method's own refusal shape, never `-32601` (a protocol error where a decision was asked) and
// never silence (which hangs the turn).

/** The provider result for one answered ask, composed by its own descriptor. */
type CodexServerRequestResult = Record<string, unknown>;

/** One routed server-request method and the two answers it can carry. */
interface CodexRoutedServerRequestDescriptor {
  /** Which host answers the ask: the callback-tool host, or the approval evaluation seam. */
  readonly askKind: "callback-tool" | "approval";
  /**
   * The allowed answer. `payload` carries data the daemon supplies (a granted permission profile,
   * an elicitation's content) and is merged, not substituted for the decision member.
   */
  readonly composeAllowedResult: (
    payload: Readonly<Record<string, unknown>> | undefined,
  ) => CodexServerRequestResult;
  /** The refusal answer. Never carries data: a refusal grants nothing. */
  readonly composeRefusedResult: (reason: string) => CodexServerRequestResult;
}

/**
 * The routed methods and their answer shapes, read from the pinned response types. A refusal
 * answers `decline` or `denied`, never `cancel` or `abort`, which would interrupt the turn.
 * Permissions has no decline arm, so its refusal is an empty grant.
 */
const CODEX_ROUTED_SERVER_REQUEST_DESCRIPTORS: ReadonlyMap<
  string,
  CodexRoutedServerRequestDescriptor
> = new Map<string, CodexRoutedServerRequestDescriptor>([
  [
    "item/tool/call",
    {
      askKind: "callback-tool",
      composeAllowedResult: (payload) => ({
        success: true,
        contentItems: readContentItems(payload),
      }),
      composeRefusedResult: (reason) => ({
        success: false,
        contentItems: [{ type: "inputText", text: reason }],
      }),
    },
  ],
  [
    "item/commandExecution/requestApproval",
    {
      askKind: "approval",
      composeAllowedResult: () => ({ decision: "accept" }),
      composeRefusedResult: () => ({ decision: "decline" }),
    },
  ],
  [
    "item/fileChange/requestApproval",
    {
      askKind: "approval",
      composeAllowedResult: () => ({ decision: "accept" }),
      composeRefusedResult: () => ({ decision: "decline" }),
    },
  ],
  [
    "item/permissions/requestApproval",
    {
      askKind: "approval",
      // The granted profile is the daemon's to compose, so an allowed answer with no supplied
      // profile grants nothing rather than guessing a widening.
      composeAllowedResult: (payload) => ({
        permissions: readGrantedPermissionProfile(payload),
        scope: "turn",
      }),
      composeRefusedResult: () => ({ permissions: {}, scope: "turn" }),
    },
  ],
  [
    "execCommandApproval",
    {
      askKind: "approval",
      composeAllowedResult: () => ({ decision: "approved" }),
      composeRefusedResult: (reason) => ({ decision: { denied: { rejection: reason } } }),
    },
  ],
  [
    "applyPatchApproval",
    {
      askKind: "approval",
      composeAllowedResult: () => ({ decision: "approved" }),
      composeRefusedResult: (reason) => ({ decision: { denied: { rejection: reason } } }),
    },
  ],
  [
    "mcpServer/elicitation/request",
    {
      askKind: "approval",
      composeAllowedResult: (payload) =>
        payload === undefined ? { action: "accept" } : { action: "accept", content: payload },
      composeRefusedResult: () => ({ action: "decline" }),
    },
  ],
]);

/** The routed method names, for the responder port. */
export const CODEX_ROUTED_SERVER_REQUEST_METHODS: readonly string[] = Object.freeze([
  ...CODEX_ROUTED_SERVER_REQUEST_DESCRIPTORS.keys(),
]);

/**
 * Why no callback-tool registration is attempted: `dynamicTools` is experimental-only in
 * `ThreadStartParams` (`codex-cli 0.150.1`: 15 properties, 26 under `--experimental`), and
 * `experimentalApi` would also un-dormant experimental frames the normalizer does not expect.
 */
export const CODEX_CALLBACK_TOOL_REGISTRATION_UNAVAILABLE_DETAIL: string =
  "ThreadStartParams.dynamicTools is experimental-generation-only at the pin and this driver negotiates experimentalApi: false, so no provider-side callback-tool registration is reachable";

/** One inbound ask, as the daemon-side responder sees it. */
export interface CodexInboundServerRequest {
  /** The JSON-RPC method, verbatim and untrusted; a key and a label only. */
  readonly method: string;
  readonly askKind: "callback-tool" | "approval";
  /** The raw `params`, untrusted; the responder parses what it needs. */
  readonly params: unknown;
}

/**
 * The daemon-side answer to one ask. `payload` is read only by arms whose provider response
 * carries daemon-composed content (a granted permission profile, an elicitation's answer).
 */
export type CodexServerRequestDecision =
  | { readonly decision: "allow"; readonly payload?: Record<string, unknown> | undefined }
  | { readonly decision: "refuse"; readonly reason: string };

/**
 * The port the daemon binds to answer routed asks: the callback-tool host for `item/tool/call`,
 * the approval evaluation seam otherwise. With no responder the driver fails closed. It also
 * projects `approval.requested` and `question.asked`, which need identity the transport lacks.
 */
export interface CodexServerRequestResponder {
  answer(request: CodexInboundServerRequest): Promise<CodexServerRequestDecision>;
}

// Ask choice sets: providers publish an ask's choices in provider-specific shapes, so they are
// normalized here, where session and run identity is stamped, for the input-ask card. The reading
// is derived (`params` still travels verbatim); an unreadable or over-large set is dropped because
// the free-text arm still answers.

/**
 * One selectable answer of a provider ask: `value` is what a chooser sends back, `label` what a
 * person reads (the titled MCP form publishes a distinct pair, the other only a label).
 */
interface ProviderAskOption {
  readonly value: string;
  readonly label: string;
}

/** The most options one ask may carry; string-length bounds do not limit how many a set holds. */
export const CODEX_ASK_OPTION_SET_MAX = 64;

/** Option string bounds; the label gets the wider width because a titled MCP `title` is prose. */
const CODEX_ASK_OPTION_VALUE_MAX_LEN = DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN;
const CODEX_ASK_OPTION_LABEL_MAX_LEN = DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN;

const codexAskOptionValueSchema = wireFreeFormString(
  CODEX_ASK_OPTION_VALUE_MAX_LEN,
  "ProviderAskOption.value",
);
const codexAskOptionLabelSchema = wireFreeFormString(
  CODEX_ASK_OPTION_LABEL_MAX_LEN,
  "ProviderAskOption.label",
);

/**
 * What one ask's payload yielded when read for a choice set. `absent` (no choices) is distinct
 * from `dropped` (choices this driver refused to carry), so only the latter earns a diagnostic.
 */
export type CodexAskOptionSetReading =
  | { readonly kind: "absent" }
  | { readonly kind: "read"; readonly options: readonly ProviderAskOption[] }
  | { readonly kind: "dropped"; readonly reason: string; readonly declaredCount: number };

const ABSENT_ASK_OPTION_SET: CodexAskOptionSetReading = Object.freeze({ kind: "absent" as const });

/**
 * Reads the choice set an inbound ask publishes, if any. Pure: it emits no diagnostic, so the
 * caller decides what a `dropped` reading is worth. `item/tool/requestUserInput` is read although
 * gated off by `experimentalApi: false`, so its disposition is defined when the gate opens.
 */
export function readCodexAskOptionSet(method: string, params: unknown): CodexAskOptionSetReading {
  if (method === "item/tool/requestUserInput") {
    return readCodexRequestUserInputOptionSet(params);
  }
  if (method === "mcpServer/elicitation/request") {
    return readCodexElicitationOptionSet(params);
  }
  // Approval methods publish a decision vocabulary the daemon composes; it must not appear on the
  // user's card.
  return ABSENT_ASK_OPTION_SET;
}

/**
 * Reads `ToolRequestUserInputParams.questions[].options`. An option has no value member at the
 * pin, so `value === label`; `description` is not carried, to keep prose out of the answer slot.
 * Eligible only for a single-question ask, since a flat set has no question identity.
 */
function readCodexRequestUserInputOptionSet(params: unknown): CodexAskOptionSetReading {
  if (!isPlainObject(params)) {
    return ABSENT_ASK_OPTION_SET;
  }
  const questions = params["questions"];
  if (!Array.isArray(questions)) {
    return ABSENT_ASK_OPTION_SET;
  }
  const optionBearing = questions.filter(
    (question): question is Record<string, unknown> =>
      isPlainObject(question) &&
      Array.isArray(question["options"]) &&
      question["options"].length > 0,
  );
  if (optionBearing.length === 0) {
    return ABSENT_ASK_OPTION_SET;
  }
  // The ask's own question count decides, not the option-bearing subset.
  if (questions.length > 1) {
    return {
      kind: "dropped",
      reason:
        "the ask declares more than one question and a single flat choice set carries no question identity, so no answer built from it could satisfy the ask",
      declaredCount: questions.length,
    };
  }
  const declared = optionBearing[0]?.["options"];
  if (!Array.isArray(declared)) {
    return ABSENT_ASK_OPTION_SET;
  }
  return boundCodexAskOptionSet(
    declared.map((option) => {
      const label = isPlainObject(option) ? option["label"] : undefined;
      return { value: label, label };
    }),
  );
}

/**
 * Reads the `McpServerElicitationRequestParams` single-select enum set; only `form` mode has a
 * typed schema, so other modes read absent. Multi-select (an array answer) is not read, and only a
 * one-property form is eligible, since the answer is keyed by property.
 */
function readCodexElicitationOptionSet(params: unknown): CodexAskOptionSetReading {
  if (!isPlainObject(params) || params["mode"] !== "form") {
    return ABSENT_ASK_OPTION_SET;
  }
  const requestedSchema = params["requestedSchema"];
  if (!isPlainObject(requestedSchema)) {
    return ABSENT_ASK_OPTION_SET;
  }
  const properties = requestedSchema["properties"];
  if (!isPlainObject(properties)) {
    return ABSENT_ASK_OPTION_SET;
  }
  const declaredSets = Object.values(properties)
    .map((property) => readCodexElicitationEnumArm(property))
    .filter((candidates): candidates is readonly unknown[] => candidates !== null);
  if (declaredSets.length === 0) {
    return ABSENT_ASK_OPTION_SET;
  }
  // The form's own property count decides, not the enum-bearing subset; a sibling's `required` is
  // not consulted, since an optional text sibling is equally unanswerable by a bare value.
  const propertyNames = Object.keys(properties);
  if (propertyNames.length > 1) {
    return {
      kind: "dropped",
      reason:
        "the elicitation form declares more than one property and a flat choice set carries no property identity, so no answer built from it could satisfy the form",
      declaredCount: propertyNames.length,
    };
  }
  const candidates = declaredSets[0] ?? [];
  return boundCodexAskOptionSet(candidates);
}

/** The `{ value, label }` candidates one elicitation property declares, or `null`. */
function readCodexElicitationEnumArm(property: unknown): readonly unknown[] | null {
  if (!isPlainObject(property)) {
    return null;
  }
  const titled = property["oneOf"];
  if (Array.isArray(titled) && titled.length > 0) {
    return titled.map((option) => {
      if (!isPlainObject(option)) {
        return { value: undefined, label: undefined };
      }
      return { value: option["const"], label: option["title"] };
    });
  }
  const values = property["enum"];
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const names = property["enumNames"];
  return values.map((value, index) => {
    const declaredName = Array.isArray(names) ? names[index] : undefined;
    // The legacy arm pairs by position and its names array may be short; a missing caption falls
    // back to the value.
    return { value, label: typeof declaredName === "string" ? declaredName : value };
  });
}

/**
 * Bounds one candidate set, or says why it was refused. All-or-nothing: a partial set would hide a
 * choice the provider offered, whereas the free-text arm can express any answer.
 */
function boundCodexAskOptionSet(candidates: readonly unknown[]): CodexAskOptionSetReading {
  if (candidates.length === 0) {
    return ABSENT_ASK_OPTION_SET;
  }
  if (candidates.length > CODEX_ASK_OPTION_SET_MAX) {
    return {
      kind: "dropped",
      reason: `the ask declares more options than the ${CODEX_ASK_OPTION_SET_MAX}-entry cardinality bound admits`,
      declaredCount: candidates.length,
    };
  }
  const options: ProviderAskOption[] = [];
  for (const candidate of candidates) {
    const source = isPlainObject(candidate) ? candidate : {};
    const value = codexAskOptionValueSchema.safeParse(source["value"]);
    const label = codexAskOptionLabelSchema.safeParse(source["label"]);
    if (!value.success || !label.success) {
      return {
        kind: "dropped",
        reason:
          "at least one declared option carried an unreadable or out-of-bounds value or label, and a partial set would hide a choice the provider is waiting for",
        declaredCount: candidates.length,
      };
    }
    options.push({ value: value.data, label: label.data });
  }
  return { kind: "read", options: Object.freeze(options) };
}

/**
 * One routed ask with the identity needed to adjudicate and project it. `runId` is `null`, never
 * invented, when the ask cannot be attributed to a run (asked outside a run, or its turn has no
 * live route while two runs are live). A callback-tool ask is never unattributed: it is refused.
 */
export interface CodexSessionServerRequest extends CodexInboundServerRequest {
  readonly sessionId: SessionId;
  readonly runId: RunId | null;
  /**
   * The normalized choice set this ask published, if readable; absent means none is carried. An
   * over-large or unreadable set is dropped and recorded; `params` still holds the original. See
   * {@link readCodexAskOptionSet}.
   */
  readonly options?: readonly ProviderAskOption[] | undefined;
}

/** The session-scoped responder the daemon binds on `CodexLifecycleOptions`. */
export interface CodexSessionServerRequestResponder {
  answer(request: CodexSessionServerRequest): Promise<CodexServerRequestDecision>;
}

/** The `DynamicToolCallResponse.contentItems` array, or an empty one. */
function readContentItems(
  payload: Readonly<Record<string, unknown>> | undefined,
): readonly unknown[] {
  const contentItems = payload?.["contentItems"];
  return Array.isArray(contentItems) ? contentItems : [];
}

/** The `GrantedPermissionProfile`, or an empty grant. */
function readGrantedPermissionProfile(
  payload: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const permissions = payload?.["permissions"];
  return typeof permissions === "object" && permissions !== null
    ? (permissions as Record<string, unknown>)
    : {};
}

/**
 * A routed ask's `turnId`. An over-long id is never resolved (a truncated prefix could match a
 * shorter live turn) but is recorded as a marked truncation, since `null` would read as an ask
 * that named no turn.
 */
interface CodexRoutedAskTurnIdReading {
  /** Usable for a route lookup: the id exactly as sent, or `null`. */
  readonly resolvableTurnId: string | null;
  /** The same field rendered for a record: bounded, or `null` if none was sent. */
  readonly recordedTurnId: string | null;
  readonly recordedTurnIdTruncated: boolean;
}

const NO_ROUTED_ASK_TURN_ID: CodexRoutedAskTurnIdReading = Object.freeze({
  resolvableTurnId: null,
  recordedTurnId: null,
  recordedTurnIdTruncated: false,
});

/**
 * Reads the `turnId` a routed ask names, bounded here because it is untrusted text that reaches a
 * refusal reason and a diagnostic buffer. At the pin the legacy approvals have no `turnId` and
 * elicitation's is nullable, so the caller's disposition varies by ask kind.
 */
function readRoutedAskTurnId(params: unknown): CodexRoutedAskTurnIdReading {
  if (typeof params !== "object" || params === null) {
    return NO_ROUTED_ASK_TURN_ID;
  }
  const namedTurnId = (params as Record<string, unknown>)["turnId"];
  if (typeof namedTurnId !== "string" || namedTurnId.length === 0) {
    return NO_ROUTED_ASK_TURN_ID;
  }
  if (namedTurnId.length <= CODEX_ROUTED_ASK_TURN_ID_MAX_LEN) {
    return {
      resolvableTurnId: namedTurnId,
      recordedTurnId: namedTurnId,
      recordedTurnIdTruncated: false,
    };
  }
  // Cut on a code point boundary: a lone surrogate does not round-trip through a JSON log sink.
  const boundedPrefix = namedTurnId.slice(0, CODEX_ROUTED_ASK_TURN_ID_MAX_LEN);
  const lastUnit = boundedPrefix.charCodeAt(boundedPrefix.length - 1);
  const splitsSurrogatePair = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  return {
    resolvableTurnId: null,
    recordedTurnId: splitsSurrogatePair ? boundedPrefix.slice(0, -1) : boundedPrefix,
    recordedTurnIdTruncated: true,
  };
}

/**
 * The refusal text for one unattributable routed ask, composed from the bounded reading so a
 * provider turn id cannot size the string the provider and the log read back.
 */
function composeRoutedAskRefusalReason(
  method: string,
  turnIdReading: CodexRoutedAskTurnIdReading,
): string {
  if (turnIdReading.recordedTurnId === null) {
    return `The provider's "${method}" request named no turn, and this method's params require one, so the daemon cannot say which run raised it; refusing rather than attributing it to a run that did not.`;
  }
  if (turnIdReading.resolvableTurnId === null) {
    return `The provider's "${method}" request named a turn id past the length this daemon reads, so it cannot be resolved to a run; refusing rather than matching a truncated prefix against a live turn.`;
  }
  return `The provider's "${method}" request named turn "${turnIdReading.resolvableTurnId}", which this daemon holds no live route for; refusing rather than attributing it to a run that did not raise it.`;
}

/**
 * How one routed ask was attributed to a run: by its named turn, by fallback to the session's sole
 * active run when it named no usable turn, or refused when its turn cannot be resolved.
 */
type CodexRoutedAskAttribution =
  | { readonly outcome: "attributed"; readonly runId: RunId }
  | { readonly outcome: "unattributed"; readonly runId: RunId | null }
  | { readonly outcome: "refused"; readonly reason: string };

/** JSON-RPC "method not found" — the fail-closed answer to an unhandled server request. */
const JSON_RPC_METHOD_NOT_FOUND = -32601;

/**
 * The `thread/realtime/*` notifications opted out at negotiation (exact names, `codex-cli
 * 0.150.1`): V1 has no realtime surface, so each would be an unmapped-kind diagnostic per audio
 * delta. Re-derive when the pin moves; never widen it to quiet a diagnostic.
 */
const CODEX_SUPPRESSED_REALTIME_NOTIFICATION_METHODS: readonly string[] = Object.freeze([
  "thread/realtime/started",
  "thread/realtime/closed",
  "thread/realtime/error",
  // The older `itemAdded` and `transcript/*` names still publish beside the newer `item/*` ones.
  "thread/realtime/itemAdded",
  "thread/realtime/sdp",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "thread/realtime/item/started",
  "thread/realtime/item/transcript/delta",
  "thread/realtime/item/completed",
]);

/** The provider's native compaction trigger and its typed evidence frame. */
const CODEX_THREAD_COMPACT_START_METHOD = "thread/compact/start" as const;

/** The provider's live skill enumeration. */
const CODEX_SKILLS_LIST_METHOD = "skills/list" as const;

/**
 * The item-injection method the replay seeds a fresh thread through (`ThreadInjectItemsParams`,
 * non-experimental at the pin). `items` accepts any JSON, so an unrecognized frame is taken and
 * dropped while the request still succeeds, which is why the post-replay assertion exists.
 */
const CODEX_THREAD_INJECT_ITEMS_METHOD = "thread/inject_items" as const;

/**
 * How long the driver waits for a compaction's typed evidence before telling the caller: a bound
 * it publishes, not a provider figure. A later frame still normalizes, since the wait only taps
 * the route. Distinct from `DEFAULT_REQUEST_TIMEOUT_MS` because compaction is model work.
 */
export const CODEX_COMPACTION_WAIT_MS = 120_000;

/**
 * Reads the boundary position off the compaction evidence frame. `null` at the pin, since
 * `ContextCompactedNotification` is `{ threadId, turnId }`; only a non-negative integer
 * `boundaryPosition` is accepted, so a pin that starts publishing one is picked up.
 */
function readCodexCompactionBoundaryPosition(params: unknown): number | null {
  if (!isPlainObject(params)) {
    return null;
  }
  const declared = params["boundaryPosition"];
  if (typeof declared !== "number" || !Number.isInteger(declared) || declared < 0) {
    return null;
  }
  return declared;
}

/**
 * Maps the provider's `skills/list` reply onto command entries, concatenating per-directory
 * groups. Pure: rejections are returned, not emitted. `providerAccountId` is the bound account or
 * `null`, never `""` or a wildcard; entries are deep-frozen because the list is shared state.
 */
function readCodexProviderCommandEntries(
  response: unknown,
  providerAccountId: string | null,
): CodexProviderCommandReading {
  if (!isPlainObject(response)) {
    return CODEX_EMPTY_PROVIDER_COMMAND_READING;
  }
  const groups = response["data"];
  if (!Array.isArray(groups)) {
    return CODEX_EMPTY_PROVIDER_COMMAND_READING;
  }
  const entries: ProviderCommandEntry[] = [];
  const rejections: CodexProviderCommandRejection[] = [];
  for (const group of groups) {
    if (!isPlainObject(group)) {
      continue;
    }
    const skills = group["skills"];
    if (!Array.isArray(skills)) {
      continue;
    }
    for (const skill of skills) {
      const reading = readCodexProviderCommandEntry(skill, providerAccountId);
      if (reading.entry !== null) {
        entries.push(deepFreezeProviderCommandEntry(reading.entry));
      }
      rejections.push(...reading.rejections);
    }
  }
  return { entries: Object.freeze(entries), rejections: Object.freeze(rejections) };
}

/**
 * One field of one published entry that the contract's bounds refused. `dropped` says whether the
 * whole entry (name) or only the field was lost. The refused value is never carried (untrusted,
 * possibly enormous), only its length.
 */
interface CodexProviderCommandRejection {
  readonly rejectedField: "name" | "description" | "scope";
  readonly dropped: boolean;
  /** `null` where the provider published no string at all for the name. */
  readonly nameLength: number | null;
  /** `null` where the refused value was not a string. */
  readonly rejectedValueLength: number | null;
}

/** One `skills/list` reply's entries, and every field reading it refused. */
interface CodexProviderCommandReading {
  readonly entries: readonly ProviderCommandEntry[];
  readonly rejections: readonly CodexProviderCommandRejection[];
}

/** The shared frozen empty reading, so no unreadable-reply path returns a mutable array. */
const CODEX_EMPTY_PROVIDER_COMMAND_READING: CodexProviderCommandReading = Object.freeze({
  entries: Object.freeze([]),
  rejections: Object.freeze([]),
});

/**
 * Freezes one entry and its nested binding, keeping its declared type; a shallow freeze would let
 * `binding.providerAccountId` be rewritten, repointing a retained entry at another account.
 */
function deepFreezeProviderCommandEntry(entry: ProviderCommandEntry): ProviderCommandEntry {
  Object.freeze(entry.binding);
  return Object.freeze(entry);
}

const codexProviderCommandDescriptionSchema = wireFreeFormString(
  DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN,
  "ProviderCommandEntry.description",
);
const codexProviderCommandScopeSchema = wireFreeFormString(
  DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN,
  "ProviderCommandEntry.scope",
);

/**
 * One optional entry field: read, undeclared, or rejected by its bound. The rejected arm keeps a
 * refused value from reading as undeclared, a claim the provider never made.
 */
type CodexProviderCommandFieldReading =
  | { readonly kind: "read"; readonly value: string }
  | { readonly kind: "undeclared" }
  | { readonly kind: "rejected"; readonly valueLength: number | null };

/**
 * Reads one optional entry field against its bound; `blankIsUndeclared` is per field because only
 * some members can express "none" as a blank string.
 */
function readCodexProviderCommandField(
  raw: unknown,
  // Typed from the sibling const, not `z.ZodString`, because this module imports no zod.
  schema: typeof codexProviderCommandDescriptionSchema,
  blankIsUndeclared: boolean,
): CodexProviderCommandFieldReading {
  if (raw === undefined || raw === null) {
    return { kind: "undeclared" };
  }
  if (blankIsUndeclared && typeof raw === "string" && raw.trim().length === 0) {
    return { kind: "undeclared" };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) {
    return { kind: "read", value: parsed.data };
  }
  return { kind: "rejected", valueLength: typeof raw === "string" ? raw.length : null };
}

/**
 * One `SkillMetadata`, normalized, with every field reading it refused. `enabled` is the
 * provider's Boolean verbatim (absent when unpublished, never a synthesized `true`), and a
 * disabled entry is still returned.
 */
function readCodexProviderCommandEntry(
  skill: unknown,
  providerAccountId: string | null,
): {
  readonly entry: ProviderCommandEntry | null;
  readonly rejections: CodexProviderCommandRejection[];
} {
  if (!isPlainObject(skill)) {
    // Not an object, so there is no name to attribute a record to.
    return { entry: null, rejections: [] };
  }
  // Absence is a positive claim, so undeclared (absent, `null`, or a blank description) and
  // rejected stay apart: a rejected description or scope becomes absent and is recorded, and only
  // an unreadable name drops the entry.
  const rawName = skill["name"];
  const nameLength = typeof rawName === "string" ? rawName.length : null;
  const description = readCodexProviderCommandField(
    skill["description"],
    codexProviderCommandDescriptionSchema,
    true,
  );
  const scope = readCodexProviderCommandField(
    skill["scope"],
    codexProviderCommandScopeSchema,
    false,
  );
  const enabled = skill["enabled"];
  const rejections: CodexProviderCommandRejection[] = [];
  if (description.kind === "rejected") {
    rejections.push({
      rejectedField: "description",
      dropped: false,
      nameLength,
      rejectedValueLength: description.valueLength,
    });
  }
  if (scope.kind === "rejected") {
    rejections.push({
      rejectedField: "scope",
      dropped: false,
      nameLength,
      rejectedValueLength: scope.valueLength,
    });
  }
  // Parsed through the contract's entry schema so a field this driver forgot to bound is refused.
  const candidate = {
    name: rawName,
    kind: "skill" as const,
    ...(description.kind === "read" ? { description: description.value } : {}),
    ...(scope.kind === "read" ? { scope: scope.value } : {}),
    ...(typeof enabled === "boolean" ? { enabled } : {}),
    // Fixed here so a caller cannot label Codex entries as another provider's.
    binding: { driverName: CODEX_DRIVER_NAME, providerAccountId },
  };
  const parsed = ProviderCommandEntrySchema.safeParse(candidate);
  if (parsed.success) {
    return { entry: parsed.data, rejections };
  }
  // Only the name can still fail here. The field records are discarded with the dropped entry.
  return {
    entry: null,
    rejections: [{ rejectedField: "name", dropped: true, nameLength, rejectedValueLength: null }],
  };
}

const CODEX_TURN_COMPLETED_NOTIFICATION = CODEX_TURN_COMPLETED_METHOD;

/** Terminal `TurnStatus` values; `inProgress` is excluded so a live route is never retired. */
const CODEX_TERMINAL_TURN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "failed",
]);

/** Unmatched terminal evidence kept per session (see `startRun`); bounded so it cannot leak. */
const CODEX_UNMATCHED_TURN_MEMORY = 64;

/**
 * Ceiling for that memory while a `turn/start` is in flight and nothing may be evicted; past it
 * the session is torn down rather than discard evidence.
 */
const CODEX_UNMATCHED_TURN_MEMORY_CEILING = CODEX_UNMATCHED_TURN_MEMORY * 4;

/**
 * Ceiling on interrupted runs whose terminals are still owed (see
 * `CodexSessionRecord.interruptedRunIdByTurnId`); refuses instead of pruning, since an evicted
 * entry loses its terminal.
 */
const CODEX_INTERRUPTED_ROUTE_MEMORY = 64;

/**
 * Settled turn ids remembered while no steer is in flight (see
 * `CodexSessionRecord.settledTurnIds`); eviction is safe only then, since absence means a terminal
 * is still owed.
 */
const CODEX_SETTLED_TURN_MEMORY = 64;

/** Settled-turn memory ceiling while a `turn/steer` is in flight; past it the session refuses. */
const CODEX_SETTLED_TURN_MEMORY_CEILING = CODEX_SETTLED_TURN_MEMORY * 4;

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

const DEFAULT_TURN_START_TIMEOUT_MS = 60_000;

/**
 * Deadline for the courtesy `thread/unsubscribe`; short so a wedged provider cannot hold close.
 */
const UNSUBSCRIBE_TIMEOUT_MS = 5_000;

/** Zero-turn auth probe; answerable with `experimentalApi: false`. */
const CODEX_AUTH_STATUS_METHOD = "getAuthStatus";

/** Deadline for the auth probe, which reads local credential state and gates admission. */
const CODEX_AUTH_PROBE_TIMEOUT_MS = 10_000;

/** Deadline for the resume-failure auth classification; short so it never delays the failure. */
const CODEX_RESUME_AUTH_CLASSIFICATION_TIMEOUT_MS = 2_000;

const DEFAULT_PTY_ROWS = 24;
const DEFAULT_PTY_COLS = 120;

/** Substituted when a provider failure carries no usable message. */
const UNSPECIFIED_PROVIDER_FAILURE_DETAIL =
  "Codex app-server reported a failure with no diagnostic message.";

/** Transport or process-level failure: `driver.unavailable` plus leak-safe `fields`. */
export class CodexTransportError extends Error {
  readonly code = "driver.unavailable" as const;
  readonly fields: Readonly<Record<string, string>>;

  constructor(message: string, fields: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "CodexTransportError";
    this.fields = fields;
  }
}

/** Line over `CODEX_MAX_LINE_LENGTH`: framing is lost, so the connection is torn down. */
export class CodexLineTooLongError extends CodexTransportError {
  constructor(retainedLength: number, limit: number) {
    super(
      `The Codex app-server sent ${retainedLength} characters with no line terminator, ` +
        `exceeding the ${limit}-character framing limit.`,
      { retainedLength: String(retainedLength), limit: String(limit) },
    );
    this.name = "CodexLineTooLongError";
  }
}

/** A request outlived its deadline. Carries `driver.timeout`. */
export class CodexRequestTimeoutError extends Error {
  readonly code = "driver.timeout" as const;
  readonly fields: Readonly<Record<string, string>>;

  constructor(message: string, fields: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "CodexRequestTimeoutError";
    this.fields = fields;
  }
}

/**
 * A provider JSON-RPC error answer; the classifier maps it to a code. `providerMessage` is the
 * wire text; `providerErrorData` is verbatim because refusals carry structured detail.
 */
export class CodexProviderRequestError extends Error {
  readonly providerErrorCode: number;
  readonly method: string;
  readonly providerMessage: string;
  readonly providerErrorData: unknown;

  constructor(
    method: string,
    providerErrorCode: number,
    providerMessage: string,
    providerErrorData: unknown = undefined,
  ) {
    super(`Codex app-server rejected "${method}": ${providerMessage}`);
    this.name = "CodexProviderRequestError";
    this.providerErrorCode = providerErrorCode;
    this.method = method;
    this.providerMessage = providerMessage;
    this.providerErrorData = providerErrorData;
  }
}

const CODEX_REWIND_BOUNDARY_FIELD = "lastTurnId";

/**
 * Refusal spellings that name a field, not a method: at the pin ``missing field `threadId` `` for
 * a missing parameter and `unknown field` for an undeclared one. `unknown variant` is excluded
 * because it names a method.
 */
const CODEX_FIELD_LEVEL_REFUSAL_PHRASES: readonly string[] = ["missing field", "unknown field"];

function refusalIndictsRewindBoundaryField(providerMessage: string): boolean {
  return CODEX_FIELD_LEVEL_REFUSAL_PHRASES.some((phrase) =>
    providerMessage.includes(`${phrase} \`${CODEX_REWIND_BOUNDARY_FIELD}\``),
  );
}

/** Structured throw-site detail for {@link CodexRewindBoundaryUnsupportedError}. */
export interface CodexRewindBoundaryUnsupportedFields {
  readonly driverId: string;
  readonly flag: DriverCapabilityFlag;
  readonly providerError: string;
}

/**
 * The build accepts `thread/fork` but refuses its boundary member, which the static `rollback`
 * gate cannot see (`lastTurnId` is verified at the `0.150.1` pin, not the `0.141.0` floor).
 */
export class CodexRewindBoundaryUnsupportedError extends Error {
  readonly code = "driver.capability_unsupported" as const;
  readonly fields: CodexRewindBoundaryUnsupportedFields;

  constructor(providerError: string) {
    super("Requested capability is not supported by the driver");
    this.name = "CodexRewindBoundaryUnsupportedError";
    this.fields = {
      driverId: CODEX_DRIVER_NAME,
      flag: "rollback",
      providerError: normalizeProviderFailureDetail(providerError),
    };
  }
}

function classifyRewindForkFailure(cause: unknown): unknown {
  if (
    cause instanceof CodexProviderRequestError &&
    cause.method === "thread/fork" &&
    refusalIndictsRewindBoundaryField(cause.providerMessage)
  ) {
    return new CodexRewindBoundaryUnsupportedError(cause.providerMessage);
  }
  return cause;
}

/**
 * A slot is `live`, `establishing` or `closing`; a create is refused in all three, since a second
 * spawn would orphan a process.
 */
export type CodexSessionSlotState = "live" | "establishing" | "closing";

function describeSlotRefusal(sessionId: string, holderState: CodexSessionSlotState): string {
  switch (holderState) {
    case "live":
      return `A live Codex session is already bound to "${sessionId}"; create would orphan it.`;
    case "establishing":
      return `A create or resume for Codex session "${sessionId}" is already in flight; create would orphan whichever process loses.`;
    case "closing":
      return `Codex session "${sessionId}" is still being torn down; create would spawn a replacement beside a process that is still exiting.`;
  }
}

/**
 * A create for a session that already has a live process: a caller-sequencing defect, codeless.
 */
export class CodexSessionAlreadyLiveError extends Error {
  readonly sessionId: string;
  readonly holderState: CodexSessionSlotState;

  constructor(sessionId: string, holderState: CodexSessionSlotState) {
    super(describeSlotRefusal(sessionId, holderState));
    this.name = "CodexSessionAlreadyLiveError";
    this.sessionId = sessionId;
    this.holderState = holderState;
  }
}

/** The config bag lacks the shape this driver requires: a wiring defect, so codeless. */
export class CodexDriverConfigError extends Error {
  readonly field: string;

  constructor(message: string, field: string) {
    super(message);
    this.name = "CodexDriverConfigError";
    this.field = field;
  }
}

/** Per-session view of the two process-wide `PtyHost` sinks. */
export interface CodexPtySessionListeners {
  onData(chunk: Uint8Array): void;
  onExit(exitCode: number, signalCode?: number): void;
}

/**
 * Subscribes to one pty session's data/exit stream, returning an unsubscribe; the host's sinks are
 * process-wide, so the composition root demultiplexes.
 */
export type CodexPtySessionSubscriber = (
  ptySessionId: string,
  listeners: CodexPtySessionListeners,
) => () => void;

/** Cancelable timeout scheduler. Injected so tests never wait on real time. */
export type CodexScheduleTimeout = (callback: () => void, delayMs: number) => () => void;

/**
 * Everything the transport could not route, as a closed union so nothing drops silently. Supplying
 * `onServerNotification` moves provider events off `unconsumed-server-notification`.
 */
export type CodexTransportDiagnostic =
  | { kind: "unparsable-line"; line: string }
  | { kind: "line-too-long"; retainedLength: number; limit: number }
  | { kind: "unknown-response-id"; responseId: string }
  | { kind: "echoed-client-frame"; method: string }
  | { kind: "unhandled-server-request"; method: string; censused: boolean }
  | { kind: "unrouted-server-request-refused"; method: string }
  | { kind: "callback-tools-withheld"; withheldToolCount: number; reason: string }
  | { kind: "server-request-responder-failed"; method: string; detail: string }
  /**
   * A routed ask named a turn with no live route, so it is refused: the sole-active fallback would
   * decide the approval against a run that never asked. Asks that publish no turn id still use the
   * fallback.
   */
  | {
      kind: "routed-ask-turn-unresolved";
      method: string;
      turnId: string | null;
      turnIdTruncated: boolean;
      disposition: "refused";
    }
  /**
   * A routed ask's answer exceeded {@link CODEX_MAX_LINE_LENGTH} encoded, so the provider gets the
   * refusal {@link CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON}; twice if that does not fit either,
   * then nothing is sent.
   */
  | {
      kind: "server-request-answer-oversized";
      method: string;
      encodedByteLength: number;
      limit: number;
    }
  | { kind: "server-request-answer-write-failed"; method: string; detail: string }
  | { kind: "notification-write-failed"; method: string }
  | { kind: "unconsumed-server-notification"; method: string }
  /**
   * The notification consumer (the daemon's own pure normalizer) threw; the notification is
   * dropped, not the connection. `detail` is normalized.
   */
  | { kind: "notification-consumer-failed"; method: string; detail: string }
  | { kind: "process-exited"; exitCode: number; signalCode: number | null }
  /** A disposer threw during teardown with no caller to rethrow to; `detail` is normalized. */
  | { kind: "subscription-dispose-failed"; detail: string }
  /**
   * A `thread/fork` response's turn list did not corroborate the rewind (an absent list reads as
   * zero). Reported, not fatal.
   */
  | {
      kind: "fork-turn-ledger-unconfirmed";
      expectedTurnCount: number;
      confirmedTurnCount: number;
    }
  /** A domain allow-list was requested but the network axis is a boolean; spawned denied. */
  | { kind: "posture-network-allowlist-narrowed"; deniedDomainCount: number }
  /**
   * The realized sandbox policy is wider than the posture demanded (unrecognized config keys are
   * silently ignored). Reported, not fatal.
   */
  | {
      kind: "posture-realization-diverged";
      requestedNetworkAccess: boolean;
      realizedNetworkAccess: boolean;
    }
  /** A subagent definition was withheld from the spawn rather than admitted unenforceable. */
  | { kind: "subagent-definition-withheld"; definitionName: string; reason: string }
  | { kind: "turn-evidence-memory-overflowed"; retainedTurnCount: number }
  | { kind: "settled-turn-memory-overflowed"; retainedTurnCount: number }
  | { kind: "interrupted-route-memory-overflowed"; retainedTurnCount: number }
  /**
   * A binding was taken from turns still live, so their frames were ruled fail-closed.
   * `reportedRunCount` is lower than `ruledFrameCount` when frames share a run; a duplicate report
   * is suppressed, the ruling never.
   */
  | { kind: "abandoned-frames-ruled"; ruledFrameCount: number; reportedRunCount: number }
  /**
   * A resume superseded a live binding with unsettled frames, so they were failed as unproven
   * deliveries but not quarantined. `reportedRunCount` is lower than `abandonedFrameCount` when
   * frames share a run or a join key resolved to no run.
   */
  | {
      kind: "superseded-frames-failed";
      abandonedFrameCount: number;
      reportedRunCount: number;
    };

/** Required: a no-op default would reintroduce silent drops. */
export type CodexDiagnosticSink = (diagnostic: CodexTransportDiagnostic) => void;

/**
 * Reports a diagnostic from a frame with no caller to act on failure, so a throwing sink cannot
 * unwind the read-chunk drain and hang the requests behind it.
 */
function reportDiagnosticFromDetachedFrame(
  sink: CodexDiagnosticSink,
  diagnostic: CodexTransportDiagnostic,
): void {
  try {
    sink(diagnostic);
  } catch {
    // The sink is the reporting channel itself; the frame's remaining work matters more.
  }
}

/** Server-initiated notification sink (the provider event stream). */
export type CodexServerNotificationSink = (method: string, params: unknown) => void;

/**
 * What this driver requires inside the untyped `CreateSessionParams.config`; `env` is the complete
 * child environment (this module never reads `process.env`).
 */
export interface CodexSessionConfig {
  cwd: string;
  env: ReadonlyArray<readonly [string, string]>;
  /**
   * The provider account this leg's credential home is pinned to; the typed request member wins
   * over this one ({@link resolveBoundProviderAccountId}). Identity and credential environment
   * must never diverge; absence reaches command entries as `null`, which matches nothing.
   */
  providerAccountId?: string | undefined;
  /**
   * The effective credential policy resolved by the daemon, whose denied names are stripped from
   * the child environment; absent under `trusted`. Re-derived from the posture on every create and
   * resume, never inherited from the original launch.
   */
  credentialEnvPolicy?: CredentialEnvPolicy | undefined;
}

/**
 * The origin declared for a run's opening frame: a fact of the code path, not a caller's claim.
 */
const RUN_OPENING_FRAME_ORIGIN: CallerDeclaredFrameOrigin = "human_text";

/**
 * Posture-affecting `turn/start` fields the daemon derives; `StartRunParams.agentConfig` is
 * untyped, so this refusal keeps a caller-declared policy off the wire.
 */
export const CALLER_DERIVED_TURN_POSTURE_FIELDS: readonly string[] = [
  "cwd",
  "sandboxPolicy",
  "permissions",
  "permissionProfile",
  "approvalPolicy",
  "approvalsReviewer",
];

/**
 * Posture members V1 does not realize, asserted absent from every `turn/start`. The provider does
 * not adjudicate `sandboxPolicy` with `permissions` (a default connection refuses `permissions`
 * with `-32600`, an `experimentalApi` one accepts both), so V1 realizes `sandboxPolicy`;
 * `permissionProfile` refuses `-32602` at the pin.
 */
export const UNREALIZED_TURN_POSTURE_MEMBERS: readonly string[] = [
  "permissions",
  "permissionProfile",
];

/**
 * Throws `CodexDriverConfigError` if a constructed `turn/start` carries an unrealized posture
 * member; `#requestTurnStart` is the only construction site.
 */
export function assertRealizedTurnPostureMembers(params: Record<string, unknown>): void {
  for (const member of UNREALIZED_TURN_POSTURE_MEMBERS) {
    if (member in params) {
      throw new CodexDriverConfigError(
        `turn/start must not carry ${member}; V1 realizes the sandboxPolicy member of the posture pair.`,
        `turn/start.${member}`,
      );
    }
  }
}

/**
 * Required contents of `StartRunParams.agentConfig`, which carries the session id and turn text.
 */
export interface CodexRunConfig {
  sessionId: SessionId;
  input: string;
  model?: string | undefined;
  clientUserMessageId?: string | undefined;
}

// Provider keys below come from the pinned build's `v2/` schema and serde field names.

/** Approval supervision for every non-`trusted` posture; `never` is for `trusted` alone. */
const CODEX_SUPERVISED_APPROVAL_POLICY = "on-request" as const;
const CODEX_TRUSTED_APPROVAL_POLICY = "never" as const;

/** Thread-level sandbox selection per posture mode (`SandboxMode` at the pin). */
const CODEX_SANDBOX_MODE_BY_POSTURE_MODE: Readonly<Record<ExecutionPosture["mode"], string>> =
  Object.freeze({
    trusted: "danger-full-access",
    "workspace-sandboxed": "workspace-write",
    "readonly-sandboxed": "read-only",
  });

/**
 * Whether the posture allows network access. A domain allow-list resolves down to `false` (the
 * provider's axis is a boolean) and is reported as a diagnostic.
 */
function codexNetworkAccessEnabled(posture: ExecutionPosture): boolean {
  return posture.networkAccess === "full";
}

/**
 * Config key for the thread-scope network axis (`ThreadStartParams.sandbox` has none); at the pin
 * it moves the realized policy on `workspace-write` only. Snake_case is load-bearing: the config
 * layer silently ignores an unrecognized key.
 */
const CODEX_WORKSPACE_NETWORK_ACCESS_CONFIG_KEY = "sandbox_workspace_write.network_access";

/** Thread-level posture: `sandbox` and `approvalPolicy` on `thread/start`. */
interface CodexThreadPostureParams {
  readonly sandbox: string;
  readonly approvalPolicy: string;
}

function composeCodexThreadPosture(posture: ExecutionPosture): CodexThreadPostureParams {
  const sandbox = CODEX_SANDBOX_MODE_BY_POSTURE_MODE[posture.mode];
  return {
    sandbox,
    approvalPolicy:
      posture.mode === "trusted" ? CODEX_TRUSTED_APPROVAL_POLICY : CODEX_SUPERVISED_APPROVAL_POLICY,
  };
}

function composeCodexThreadPostureConfig(posture: ExecutionPosture): Record<string, unknown> {
  if (posture.mode !== "workspace-sandboxed") {
    return {};
  }
  return { [CODEX_WORKSPACE_NETWORK_ACCESS_CONFIG_KEY]: codexNetworkAccessEnabled(posture) };
}

/**
 * Compares the sandbox policy the provider says it realized with the posture's; returns the
 * divergence or `null`. Never throws and never fails the spawn.
 */
export function describeCodexPostureDivergence(
  posture: ExecutionPosture,
  realizedSandbox: unknown,
): { readonly requestedNetworkAccess: boolean; readonly realizedNetworkAccess: boolean } | null {
  // Only `workspace-sandboxed` can express its request at thread scope.
  if (posture.mode !== "workspace-sandboxed" || !isPlainObject(realizedSandbox)) {
    return null;
  }
  const realizedNetworkAccess = realizedSandbox["networkAccess"];
  if (typeof realizedNetworkAccess !== "boolean") {
    return null;
  }
  const requestedNetworkAccess = codexNetworkAccessEnabled(posture);
  // Both directions: an ignored unrecognized key leaves network `false`, so a narrower result
  // means the request silently stopped applying.
  if (realizedNetworkAccess !== requestedNetworkAccess) {
    return { requestedNetworkAccess, realizedNetworkAccess };
  }
  return null;
}

/**
 * Per-turn `sandboxPolicy`, sent every turn because it carries the writable roots the thread-level
 * mode cannot; the two exclude flags are pinned `true` so `writableRoots` is the complete list.
 */
function composeCodexTurnSandboxPolicy(posture: ExecutionPosture): Record<string, unknown> {
  const networkAccess = codexNetworkAccessEnabled(posture);
  switch (posture.mode) {
    case "trusted":
      return { type: "dangerFullAccess" };
    case "readonly-sandboxed":
      return { type: "readOnly", networkAccess };
    case "workspace-sandboxed":
      return {
        type: "workspaceWrite",
        writableRoots: posture.writableRoots,
        networkAccess,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      };
  }
}

/**
 * The provider's floor on its concurrency cap: `agents.max_concurrent_threads_per_session: 0` is
 * refused at the pin, so zero cannot disable subagents; `agents.max_depth: 0` is accepted and
 * forbids any spawn (a child announces itself at depth 1), so the disable rides on depth.
 */
const CODEX_SUBAGENT_CONCURRENCY_FLOOR = 1;

/** The depth ceiling that admits no child thread at all. */
const CODEX_SUBAGENT_DEPTH_NONE = 0;

/** Normalizes a cap into the provider's `i32`; fractions round down, never below `floor`. */
function normalizeCodexSubagentCap(value: number, floor: number): number {
  if (!Number.isFinite(value)) {
    return floor;
  }
  return Math.max(floor, Math.floor(value));
}

/**
 * The `[agents]` config overrides realizing one subagent policy. A disabled policy, or one below
 * the provider's floor, is sent as a zero depth ceiling: omitting it keeps the installation's
 * defaults and clamping up would grant a subagent.
 */
function composeCodexSubagentConfigOverrides(policy: SubagentPolicy): Record<string, unknown> {
  if (!policy.enabled || policy.maxConcurrent < CODEX_SUBAGENT_CONCURRENCY_FLOOR) {
    return {
      "agents.max_concurrent_threads_per_session": CODEX_SUBAGENT_CONCURRENCY_FLOOR,
      "agents.max_depth": CODEX_SUBAGENT_DEPTH_NONE,
    };
  }
  return {
    "agents.max_concurrent_threads_per_session": normalizeCodexSubagentCap(
      policy.maxConcurrent,
      CODEX_SUBAGENT_CONCURRENCY_FLOOR,
    ),
    "agents.max_depth": normalizeCodexSubagentCap(policy.maxDepth, CODEX_SUBAGENT_DEPTH_NONE),
  };
}

/**
 * Why every `SubagentDefinition` is withheld: the provider's per-role config entry carries only
 * `description`, `config_file` and `nickname_candidates` (serde names at the pin); the rest lives
 * in a file this driver would have to write.
 */
const CODEX_SUBAGENT_DEFINITION_WITHHELD_REASON: string =
  "the provider's per-role config entry carries no inline model, tools, permission-mode, effort, or max-turns axis at the pinned build, so the definition cannot be realized without authoring a config file this driver does not own";

/** The one meaning of "an object" on a parse path; arrays are excluded. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new CodexDriverConfigError(`${label} must be an object.`, label);
  }
  return value;
}

function readRequiredString(source: Record<string, unknown>, key: string, label: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CodexDriverConfigError(`${label} must be a non-empty string.`, label);
  }
  return value;
}

function readOptionalString(
  source: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = source[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new CodexDriverConfigError(`${label} must be a non-empty string when present.`, label);
  }
  return value;
}

/** Fail-closed parse of `CreateSessionParams.config`. */
export function parseCodexSessionConfig(config: unknown): CodexSessionConfig {
  const source = readRecord(config, "CreateSessionParams.config");
  const cwd = readRequiredString(source, "cwd", "CreateSessionParams.config.cwd");
  const rawEnv = source["env"];
  if (!Array.isArray(rawEnv)) {
    throw new CodexDriverConfigError(
      "CreateSessionParams.config.env must be an array of [name, value] pairs.",
      "CreateSessionParams.config.env",
    );
  }
  const env = rawEnv.map((entry, index) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string" ||
      entry[0].length === 0
    ) {
      throw new CodexDriverConfigError(
        `CreateSessionParams.config.env[${index}] must be a [name, value] string pair.`,
        "CreateSessionParams.config.env",
      );
    }
    return [entry[0], entry[1]] as const;
  });
  // A present-but-empty account id refuses rather than reading as absent.
  const providerAccountId = readOptionalString(
    source,
    "providerAccountId",
    "CreateSessionParams.config.providerAccountId",
  );
  return {
    cwd,
    env,
    ...(providerAccountId === undefined ? {} : { providerAccountId }),
    ...parseCredentialEnvPolicy(source["credentialEnvPolicy"]),
  };
}

/**
 * Picks which claim names a spawn's provider account, for both spawn composers: the typed
 * `requested` member wins, `recorded` answers only when it is absent (never the manager-wide
 * `resumeSpawnConfig`), and two differing accounts throw because either choice would move the
 * run's spend silently. An empty `requested` throws too, since it skips the config parse.
 */
function resolveBoundProviderAccountId(claims: {
  readonly requested: string | undefined;
  readonly requestedField: string;
  readonly recorded: string | undefined;
  readonly recordedField: string;
}): string | undefined {
  const { requested, requestedField, recorded, recordedField } = claims;
  if (requested !== undefined && requested.length === 0) {
    throw new CodexDriverConfigError(
      `${requestedField} must be a non-empty string when present.`,
      requestedField,
    );
  }
  if (requested === undefined) {
    return recorded;
  }
  if (recorded === undefined || recorded === requested) {
    return requested;
  }
  throw new CodexDriverConfigError(
    `${requestedField} names provider account ${requested} while ${recordedField} names ${recorded}; a spawn is billed to one account and neither resolver may silently win.`,
    requestedField,
  );
}

const ENV_NAME_MATCH_MODES: readonly SpawnEnvNameMatch[] = ["case-sensitive", "case-insensitive"];

/**
 * Fail-closed parse of the daemon's resolved credential policy. Absent is legitimate (a `trusted`
 * posture); a malformed one throws, since defaulting to "deny nothing" would spawn with the
 * variables the policy withholds. `envNameMatch` is required: guessing it could let `path` slip
 * past a list naming `PATH`.
 */
function parseCredentialEnvPolicy(
  value: unknown,
): { credentialEnvPolicy: CredentialEnvPolicy } | Record<string, never> {
  if (value === undefined) {
    return {};
  }
  const label = "CreateSessionParams.config.credentialEnvPolicy";
  const source = readRecord(value, label);
  const rawDenyEnvVars = source["denyEnvVars"];
  if (!Array.isArray(rawDenyEnvVars)) {
    throw new CodexDriverConfigError(`${label}.denyEnvVars must be an array of names.`, label);
  }
  const denyEnvVars = rawDenyEnvVars.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new CodexDriverConfigError(
        `${label}.denyEnvVars[${index}] must be a non-empty string.`,
        label,
      );
    }
    return entry;
  });
  // `find`, not `some`: the match narrows the value to the union without a cast.
  const envNameMatch = ENV_NAME_MATCH_MODES.find((mode) => mode === source["envNameMatch"]);
  if (envNameMatch === undefined) {
    throw new CodexDriverConfigError(
      `${label}.envNameMatch must be one of ${ENV_NAME_MATCH_MODES.join(" | ")}.`,
      label,
    );
  }
  return { credentialEnvPolicy: { denyEnvVars, envNameMatch } };
}

/** Fail-closed parse of `StartRunParams.agentConfig`. */
export function parseCodexRunConfig(agentConfig: unknown): CodexRunConfig {
  const source = readRecord(agentConfig, "StartRunParams.agentConfig");
  // Parsed, not cast, so a malformed id fails here as a config error.
  const rawSessionId = readRequiredString(
    source,
    "sessionId",
    "StartRunParams.agentConfig.sessionId",
  );
  let sessionId: SessionId;
  try {
    sessionId = SessionIdSchema.parse(rawSessionId);
  } catch {
    throw new CodexDriverConfigError(
      "StartRunParams.agentConfig.sessionId must be a session id.",
      "StartRunParams.agentConfig.sessionId",
    );
  }
  const input = readRequiredString(source, "input", "StartRunParams.agentConfig.input");
  const model = readOptionalString(source, "model", "StartRunParams.agentConfig.model");
  const clientUserMessageId = readOptionalString(
    source,
    "clientUserMessageId",
    "StartRunParams.agentConfig.clientUserMessageId",
  );
  // Read only to refuse: the run-opening boundary mints its own frame origin, and a
  // caller-declared tripwire-exempt origin would deliver the user's words as a provider command.
  const declaredFrameOrigin = readOptionalString(
    source,
    "frameOrigin",
    "StartRunParams.agentConfig.frameOrigin",
  );
  if (declaredFrameOrigin !== undefined && declaredFrameOrigin !== RUN_OPENING_FRAME_ORIGIN) {
    throw new CodexDriverConfigError(
      `StartRunParams.agentConfig.frameOrigin cannot be declared; a run's opening text is written as "${RUN_OPENING_FRAME_ORIGIN}".`,
      "StartRunParams.agentConfig.frameOrigin",
    );
  }
  // Refused even when the value matches what the daemon derived; no comparison needed.
  for (const field of CALLER_DERIVED_TURN_POSTURE_FIELDS) {
    if (source[field] !== undefined) {
      throw new CodexDriverConfigError(
        `StartRunParams.agentConfig.${field} cannot be declared; the daemon derives every posture-affecting turn field.`,
        `StartRunParams.agentConfig.${field}`,
      );
    }
  }
  return {
    sessionId,
    input,
    ...(model === undefined ? {} : { model }),
    ...(clientUserMessageId === undefined ? {} : { clientUserMessageId }),
  };
}

/**
 * Builds a probe result without throwing. `detail` is bounded tighter than failure detail and
 * dropped if the envelope still refuses it; `status` carries the decision.
 */
function buildAuthProbeResult(
  status: DriverAuthProbeResult["status"],
  detail: string,
): DriverAuthProbeResult {
  const bounded =
    detail.length > DRIVER_AUTH_DETAIL_MAX_LEN
      ? detail.slice(0, DRIVER_AUTH_DETAIL_MAX_LEN)
      : detail;
  const parsed = DriverAuthProbeResultSchema.safeParse({ status, detail: bounded });
  return parsed.success ? parsed.data : DriverAuthProbeResultSchema.parse({ status });
}

/**
 * Maps a `getAuthStatus` answer onto the probe result. Only `authMethod` is read, never
 * `authToken`; it is a closed mechanism enum, safe as `detail` (unlike `account/read`, which
 * carries a plan name and seat email). A `null` method is `unauthenticated` even if no OpenAI
 * sign-in is required.
 */
function classifyCodexAuthStatus(response: unknown): DriverAuthProbeResult {
  if (!isPlainObject(response)) {
    return buildAuthProbeResult(
      "indeterminate",
      `the Codex app-server "${CODEX_AUTH_STATUS_METHOD}" response was not an object`,
    );
  }
  const authMethod = response["authMethod"];
  if (typeof authMethod === "string" && authMethod.length > 0) {
    return buildAuthProbeResult("authenticated", `auth method: ${authMethod}`);
  }
  if (authMethod !== null && authMethod !== undefined) {
    // Present but not a string: an unreadable shape is probe ill-health, not a credential verdict.
    return buildAuthProbeResult(
      "indeterminate",
      `the Codex app-server "${CODEX_AUTH_STATUS_METHOD}" response carried an unreadable authMethod`,
    );
  }
  return buildAuthProbeResult(
    "unauthenticated",
    response["requiresOpenaiAuth"] === false
      ? "no auth method is resolved; the configured provider reports it requires no OpenAI sign-in"
      : "no auth method is resolved for this credential home",
  );
}

/**
 * Asks one connection the auth question without token material (`includeToken: false`) and
 * without a refresh (`refreshToken: false`): the pinned providers rotate refresh tokens
 * single-use, so a refresh would end the login being checked. Both are sent because
 * `GetAuthStatusParams` types them required-but-nullable.
 */
async function requestCodexAuthStatus(
  connection: CodexAppServerConnection,
  timeoutMs: number,
): Promise<unknown> {
  return await connection.request(
    CODEX_AUTH_STATUS_METHOD,
    { includeToken: false, refreshToken: false },
    timeoutMs,
  );
}

/**
 * Classifies a failed resume as `reauth-required` or `recovery-needed`. The still-open
 * connection is asked the credential question directly (the provider has no typed auth error),
 * and only after a `CodexProviderRequestError`, which proves the child is alive; asking a
 * wedged connection would wait out a second deadline. Anything short of a determinate
 * logged-out reading, an `indeterminate` probe included, is `recovery-needed`.
 */
async function classifyResumeRecoveryCondition(
  connection: CodexAppServerConnection,
  cause: unknown,
): Promise<RecoveryCondition> {
  if (!(cause instanceof CodexProviderRequestError) || connection.isClosed) {
    return "recovery-needed";
  }
  try {
    const reading = classifyCodexAuthStatus(
      await requestCodexAuthStatus(connection, CODEX_RESUME_AUTH_CLASSIFICATION_TIMEOUT_MS),
    );
    return reading.status === "unauthenticated" ? "reauth-required" : "recovery-needed";
  } catch {
    // Contained: a failed probe must not replace the typed `failed` result the resume path returns.
    return "recovery-needed";
  }
}

/**
 * Makes any caught value safe for `DriverResumeResult.providerFailureDetail`, whose
 * `wireFreeFormString` schema rejects empty, whitespace-only, NUL-bearing and overlength text.
 * Total over arbitrary values.
 */
export function normalizeProviderFailureDetail(cause: unknown): string {
  try {
    const trimmed = readFailureText(cause).replaceAll("\0", "").trim();
    if (trimmed.length === 0) {
      return UNSPECIFIED_PROVIDER_FAILURE_DETAIL;
    }
    return trimmed.length > DRIVER_FAILURE_DETAIL_MAX_LEN
      ? trimmed.slice(0, DRIVER_FAILURE_DETAIL_MAX_LEN)
      : trimmed;
  } catch {
    return UNSPECIFIED_PROVIDER_FAILURE_DETAIL;
  }
}

/**
 * Extracts failure text from an arbitrary thrown value, or "" if it cannot. It never throws:
 * `String(value)` throws for a null-prototype object, and `error.message` can be a throwing
 * getter or a non-string.
 */
function readFailureText(cause: unknown): string {
  try {
    if (cause instanceof Error) {
      const message: unknown = cause.message;
      if (typeof message === "string" && message.trim().length > 0) {
        return message;
      }
      const name: unknown = cause.name;
      return typeof name === "string" ? name : "";
    }
    if (typeof cause === "string") {
      return cause;
    }
    // Other values are never serialized: the detail is persisted, and a serialized rejection could
    // carry spawn configuration, credential material included, into a durable row.
    return "";
  } catch {
    return "";
  }
}

const defaultScheduleTimeout: CodexScheduleTimeout = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  return () => {
    clearTimeout(handle);
  };
};

interface PendingRequest {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cancelDeadline: () => void;
}

/** Construction inputs shared by the connection and the manager. */
export interface CodexConnectionOptions {
  readonly ptyHost: PtyHost;
  readonly subscribeToPtySession: CodexPtySessionSubscriber;
  readonly reportDiagnostic: CodexDiagnosticSink;
  readonly executablePath?: string | undefined;
  readonly scheduleTimeout?: CodexScheduleTimeout | undefined;
  readonly onServerNotification?: CodexServerNotificationSink | undefined;
  readonly startupTimeoutMs?: number | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly turnStartTimeoutMs?: number | undefined;
  readonly rows?: number | undefined;
  readonly cols?: number | undefined;
  /** How the daemon reaches this process. */
  readonly transportSelection?: CodexTransportSelection | undefined;
  /** Resolves `bearerTokenRef` at connection time; required on the ws arm. */
  readonly resolveBearerCredential?: CodexBearerCredentialResolver | undefined;
  /** Bridges to a ws listener; required on the ws arm (absence fails closed). */
  readonly websocketConnector?: CodexWebsocketTransportConnector | undefined;
  /** Answers routed server requests; without one, every routed ask is refused. */
  readonly serverRequestResponder?: CodexServerRequestResponder | undefined;
}

/**
 * How far a failed request's bytes provably got: `unsent` (no byte reached the host), `refused`
 * (the provider answered with a JSON-RPC error), or `indeterminate` (the host took the bytes and
 * whether the provider acted on them is unknowable). Only the transport can tell, because the
 * error classes for "refused before the write" and "killed in flight" are near-identical.
 */
export type CodexRequestDelivery = "unsent" | "refused" | "indeterminate";

/** The outcome of one request, returned rather than thrown, with a failure's delivery. */
export type CodexRequestAttempt =
  | { readonly settled: "answered"; readonly result: unknown }
  | {
      readonly settled: "failed";
      readonly delivery: CodexRequestDelivery;
      readonly cause: unknown;
    };

/** A frame resolved to its destination and its bytes, one step short of the wire. */
interface CodexEncodedFrame {
  readonly ptySessionId: string;
  readonly bytes: Uint8Array;
}

/**
 * One `codex app-server` process reached over one `PtyHost` session. Owns newline-delimited JSON
 * framing, request correlation with deadlines, the fail-closed answer to unhandled server
 * requests, and teardown that leaves no promise pending.
 */
export class CodexAppServerConnection {
  readonly #ptyHost: PtyHost;
  readonly #subscribeToPtySession: CodexPtySessionSubscriber;
  readonly #reportDiagnostic: CodexDiagnosticSink;
  readonly #scheduleTimeout: CodexScheduleTimeout;
  readonly #onServerNotification: CodexServerNotificationSink | undefined;
  readonly #executablePath: string;
  readonly #startupTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #rows: number;
  readonly #cols: number;

  readonly #pending = new Map<string, PendingRequest>();
  readonly #decoder = new TextDecoder("utf-8");
  readonly #encoder = new TextEncoder();

  #ptySessionId: string | null = null;
  #unsubscribe: (() => void) | null = null;
  #readBuffer = "";
  #nextRequestId = 1;
  #sawReadySentinel = false;
  #onReady: (() => void) | null = null;
  #onReadyFailed: ((error: Error) => void) | null = null;
  #closed = false;
  #ptyClosed = false;
  #exitDescription: string | null = null;
  readonly #transportSelection: CodexTransportSelection;
  readonly #resolveBearerCredential: CodexBearerCredentialResolver | undefined;
  readonly #websocketConnector: CodexWebsocketTransportConnector | undefined;
  readonly #serverRequestResponder: CodexServerRequestResponder | undefined;

  constructor(options: CodexConnectionOptions) {
    this.#ptyHost = options.ptyHost;
    this.#subscribeToPtySession = options.subscribeToPtySession;
    this.#reportDiagnostic = options.reportDiagnostic;
    this.#scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout;
    this.#onServerNotification = options.onServerNotification;
    this.#executablePath = options.executablePath ?? CODEX_DEFAULT_EXECUTABLE_PATH;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#rows = options.rows ?? DEFAULT_PTY_ROWS;
    this.#cols = options.cols ?? DEFAULT_PTY_COLS;
    this.#transportSelection = options.transportSelection ?? { transport: "stdio" };
    this.#resolveBearerCredential = options.resolveBearerCredential;
    this.#websocketConnector = options.websocketConnector;
    this.#serverRequestResponder = options.serverRequestResponder;
  }

  /** The transport this connection reaches its provider process over. */
  get transportSelection(): CodexTransportSelection {
    return this.#transportSelection;
  }

  /** The pty session id, once spawned. Exposed for teardown bookkeeping and tests. */
  get ptySessionId(): string | null {
    return this.#ptySessionId;
  }

  /** True once `close()` ran or the child exited. */
  get isClosed(): boolean {
    return this.#closed;
  }

  /**
   * Spawns the process, waits for the prelude's ready sentinel, then performs the `initialize`
   * handshake. A failure after the spawn tears the process down before rethrowing.
   */
  async open(config: CodexSessionConfig): Promise<void> {
    // Resolved per connection so a credential rotation is picked up; `null` on arms without one.
    // The ternary avoids an unconditional `await`, whose microtask tick would reorder the spawn.
    const bearerCredential =
      this.#transportSelection.transport === "websocket"
        ? await this.#resolveWebsocketCredential(this.#transportSelection.bearerTokenRef)
        : null;
    const spawnRequest: SpawnRequest = {
      kind: "spawn_request",
      command: "/bin/sh",
      args: [
        "-c",
        CODEX_APP_SERVER_SHELL_PRELUDE,
        CODEX_APP_SERVER_SHELL_ARGV0,
        ...composeCodexTransportArgv(this.#transportSelection, bearerCredential),
      ],
      // The caller's pairs minus what the credential policy denies, plus the binary path the
      // prelude reads (mandated, so the deny strip cannot remove it); `process.env` is never
      // consulted. Name matching follows the running platform, not the policy: whether `path` and
      // `PATH` are one variable is an OS fact, and a `trusted` posture carries no policy.
      env: buildProviderSpawnEnv({
        driverName: "codex",
        baseEnv: config.env,
        hostEnvNameMatch: hostEnvNameMatchForPlatform(process.platform),
        credentialEnvPolicy: config.credentialEnvPolicy,
        additionalMandatedPairs: [[CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME, this.#executablePath]],
      }).map((pair) => [pair[0], pair[1]] as [string, string]),
      cwd: config.cwd,
      rows: this.#rows,
      cols: this.#cols,
    };

    const response = await this.#ptyHost.spawn(spawnRequest);
    if (response.error !== undefined && response.error.length > 0) {
      throw new CodexTransportError("Failed to spawn the Codex app-server process.", {
        ptyError: response.error,
      });
    }
    if (response.session_id.length === 0) {
      throw new CodexTransportError(
        "PtyHost returned an empty session id for the Codex app-server spawn.",
      );
    }
    this.#ptySessionId = response.session_id;

    try {
      // Inside the guard: a throwing subscriber outside it would leave the child running.
      this.#unsubscribe = this.#subscribeToPtySession(response.session_id, {
        onData: (chunk) => {
          this.#ingest(chunk);
        },
        onExit: (exitCode, signalCode) => {
          this.#handleExit(exitCode, signalCode ?? null);
        },
      });
      await this.#awaitReadySentinel();
      // Only the ws arm has a bridge to raise; it precedes the handshake so an `initialize` into
      // an unbridged transport does not time out with a misleading failure.
      if (this.#transportSelection.transport === "websocket" && bearerCredential !== null) {
        await this.#requireWebsocketConnector().connect({
          endpoint: this.#transportSelection.endpoint,
          credential: bearerCredential,
        });
      }
      await this.request(
        "initialize",
        {
          clientInfo: { name: "codex-driver", title: "AI Sidekicks", version: "1" },
          capabilities: {
            experimentalApi: false,
            requestAttestation: false,
            optOutNotificationMethods: CODEX_SUPPRESSED_REALTIME_NOTIFICATION_METHODS,
          },
        },
        this.#startupTimeoutMs,
      );
      this.notify("initialized", {});
    } catch (cause) {
      await this.close();
      throw cause;
    }
  }

  // Every failure refuses instead of downgrading to an unauthenticated listener or to stdio.
  async #resolveWebsocketCredential(
    bearerTokenRef: string,
  ): Promise<CodexWebsocketBearerCredential> {
    const resolve = this.#resolveBearerCredential;
    if (resolve === undefined) {
      throw new CodexDriverConfigError(
        "A websocket transport is configured but no bearer-credential resolver was injected; refusing to start an unauthenticated listener.",
        "DriverTransportConfig.bearerTokenRef",
      );
    }
    // Not caught: a throwing resolver is a credential that could not be obtained.
    return await resolve(bearerTokenRef);
  }

  #requireWebsocketConnector(): CodexWebsocketTransportConnector {
    const connector = this.#websocketConnector;
    if (connector === undefined) {
      throw new CodexDriverConfigError(
        "A websocket transport is configured but no transport connector was injected; refusing to fall back to a different process.",
        "DriverTransportConfig.endpoint",
      );
    }
    return connector;
  }

  /** Sends a request and resolves with its `result`, or rejects with a typed error. */
  async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    this.#assertWritable(method);
    const armed = this.#armPendingResponse(method, timeoutMs);
    try {
      await this.#writeFrame({ jsonrpc: "2.0", id: armed.requestId, method, params });
    } catch (cause) {
      this.#cancelPendingResponse(armed.key);
      throw cause;
    }
    return armed.settled;
  }

  /**
   * Sends a request and reports the outcome, classifying a failure by delivery. Everything past
   * the write is `indeterminate` unless the provider answered with an error.
   */
  async attemptRequest(
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<CodexRequestAttempt> {
    try {
      this.#assertWritable(method);
    } catch (cause) {
      return { settled: "failed", delivery: "unsent", cause };
    }
    const armed = this.#armPendingResponse(method, timeoutMs);
    let encodedFrame: CodexEncodedFrame;
    try {
      // Encoding precedes the first byte, so a failure here put nothing on the wire.
      encodedFrame = this.#encodeFrame({ jsonrpc: "2.0", id: armed.requestId, method, params });
    } catch (cause) {
      this.#cancelPendingResponse(armed.key);
      return { settled: "failed", delivery: "unsent", cause };
    }
    try {
      await this.#writeEncodedFrame(encodedFrame.ptySessionId, encodedFrame.bytes);
    } catch (cause) {
      this.#cancelPendingResponse(armed.key);
      // The host promises no delivery either way, and a partial line can read as a whole request.
      return { settled: "failed", delivery: "indeterminate", cause };
    }
    try {
      return { settled: "answered", result: await armed.settled };
    } catch (cause) {
      return {
        settled: "failed",
        delivery: cause instanceof CodexProviderRequestError ? "refused" : "indeterminate",
        cause,
      };
    }
  }

  /** Reserves the response slot and deadline for one request id. Synchronous on purpose. */
  #armPendingResponse(
    method: string,
    timeoutMs: number | undefined,
  ): { readonly requestId: number; readonly key: string; readonly settled: Promise<unknown> } {
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    const key = String(requestId);
    const deadlineMs = timeoutMs ?? this.#requestTimeoutMs;

    const settled = new Promise<unknown>((resolve, reject) => {
      const cancelDeadline = this.#scheduleTimeout(() => {
        this.#pending.delete(key);
        reject(
          new CodexRequestTimeoutError(
            `Codex app-server did not answer "${method}" within ${deadlineMs}ms.`,
            { method, timeoutMs: String(deadlineMs) },
          ),
        );
      }, deadlineMs);
      this.#pending.set(key, { method, resolve, reject, cancelDeadline });
    });
    // A child exit while the caller is suspended on its write would reject an unhandled promise,
    // which kills the daemon under Node's default; this marks it handled without consuming it.
    settled.catch(() => {
      /* the returned promise is the caller's channel */
    });
    return { requestId, key, settled };
  }

  /** Withdraws a reserved response slot whose request never got to be answered. */
  #cancelPendingResponse(key: string): void {
    const pending = this.#pending.get(key);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(key);
    pending.cancelDeadline();
  }

  /** Fire-and-forget notification. Failures surface through the diagnostic sink. */
  notify(method: string, params: unknown): void {
    this.#assertWritable(method);
    void this.#writeFrame({ jsonrpc: "2.0", method, params }).catch(() => {
      // Reported, not thrown: the caller is mid-handshake and the next request's failure is the
      // actionable signal.
      this.#reportDiagnosticQuietly({ kind: "notification-write-failed", method });
    });
  }

  /** Tears the connection down. Idempotent: a second call does not close the host session again. */
  async close(): Promise<void> {
    // Guarded on the PTY release, not `#closed`: an exited child has not released the host record.
    if (this.#ptyClosed) {
      return;
    }
    this.#ptyClosed = true;
    this.#closed = true;
    const closedError = new CodexTransportError("The Codex app-server connection was closed.", {
      reason: this.#exitDescription ?? "closed",
    });
    this.#rejectAllPending(closedError);
    this.#onReadyFailed?.(closedError);
    // The disposer can throw; the fault is held and rethrown after the release below, or the child
    // could keep running beside a replacement. Boxed because `undefined` is a throwable value.
    let disposeFault: { readonly cause: unknown } | null = null;
    if (this.#unsubscribe !== null) {
      const dispose = this.#unsubscribe;
      this.#unsubscribe = null;
      try {
        dispose();
      } catch (cause) {
        disposeFault = { cause };
      }
    }
    const ptySessionId = this.#ptySessionId;
    if (ptySessionId !== null) {
      try {
        await this.#ptyHost.close(ptySessionId);
      } catch {
        // The child may already be reaped; teardown must not fail on a resource that is gone.
      }
    }
    if (disposeFault !== null) {
      // Rethrown so `close()`'s failure contract holds; the process is already gone by now.
      throw disposeFault.cause;
    }
  }

  /**
   * Kills the child, then closes, with no graceful phase; for an ambiguous outcome such as a
   * `turn/start` that may or may not have been accepted. `PtyHost.close` documents no signal.
   */
  async killAndClose(): Promise<void> {
    const ptySessionId = this.#ptySessionId;
    if (ptySessionId !== null && !this.#ptyClosed) {
      try {
        await this.#ptyHost.kill(ptySessionId, "SIGKILL");
      } catch {
        // Already reaped, or the host lost the session; the close below still releases it.
      }
    }
    await this.close();
  }

  #assertWritable(method: string): void {
    if (this.#closed) {
      throw new CodexTransportError(
        `Cannot send "${method}": the Codex app-server connection is closed.`,
        { method, reason: this.#exitDescription ?? "closed" },
      );
    }
  }

  // `async` so an encode failure is a rejection: `notify` handles it through `.catch()`.
  async #writeFrame(frame: Record<string, unknown>): Promise<void> {
    const encodedFrame = this.#encodeFrame(frame);
    await this.#writeEncodedFrame(encodedFrame.ptySessionId, encodedFrame.bytes);
  }

  /** Destination resolution and serialization; touches no host state, so a failure is unsent. */
  #encodeFrame(frame: Record<string, unknown>): CodexEncodedFrame {
    const ptySessionId = this.#ptySessionId;
    if (ptySessionId === null) {
      throw new CodexTransportError("The Codex app-server connection is not open.");
    }
    return { ptySessionId, bytes: this.#encoder.encode(`${JSON.stringify(frame)}\n`) };
  }

  /**
   * The single write site; past it, delivery is unknowable. Not `async`, so the microtask hops
   * match awaiting `PtyHost.write` directly.
   */
  #writeEncodedFrame(ptySessionId: string, bytes: Uint8Array): Promise<void> {
    return this.#ptyHost.write(ptySessionId, bytes);
  }

  #awaitReadySentinel(): Promise<void> {
    if (this.#sawReadySentinel) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const cancelDeadline = this.#scheduleTimeout(() => {
        this.#clearReadyWait();
        reject(
          new CodexTransportError(
            `The Codex app-server prelude did not report readiness within ${this.#startupTimeoutMs}ms.`,
            { timeoutMs: String(this.#startupTimeoutMs) },
          ),
        );
      }, this.#startupTimeoutMs);
      this.#onReady = () => {
        cancelDeadline();
        this.#clearReadyWait();
        resolve();
      };
      // Not a pending request, so exit and close must fail it explicitly, or a binary that dies
      // during startup (a missing executable exits 126) leaves `open()` unsettled forever.
      this.#onReadyFailed = (error) => {
        cancelDeadline();
        this.#clearReadyWait();
        reject(error);
      };
    });
  }

  #ingest(chunk: Uint8Array): void {
    // Data can arrive after teardown; appending it would re-grow the abandoned buffer.
    if (this.#ptyClosed) {
      return;
    }
    // `stream: true` so a multi-byte character split across chunks is not mangled.
    this.#readBuffer += this.#decoder.decode(chunk, { stream: true });
    let newlineIndex = this.#readBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      // Measured before the slice: an over-long line that terminates in the same chunk leaves a
      // short tail the post-loop check would miss.
      if (newlineIndex > CODEX_MAX_LINE_LENGTH) {
        this.#failFraming(newlineIndex);
        return;
      }
      const line = this.#readBuffer.slice(0, newlineIndex);
      this.#readBuffer = this.#readBuffer.slice(newlineIndex + 1);
      // Output post-processing is left on, so server lines arrive CRLF-terminated.
      this.#handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      newlineIndex = this.#readBuffer.indexOf("\n");
    }
    // Only an unterminated tail grows without bound; many ordinary frames in aggregate are fine.
    if (this.#readBuffer.length > CODEX_MAX_LINE_LENGTH) {
      this.#failFraming(this.#readBuffer.length);
    }
  }

  /**
   * Abandons an over-long line and its connection. The tail is discarded unparsed, never
   * truncated: a prefix could parse as a valid but incomplete frame. In-flight callers and the
   * startup waiter fail with the typed error before the release, so they see why it died.
   */
  #failFraming(retainedLength: number): void {
    const error = new CodexLineTooLongError(retainedLength, CODEX_MAX_LINE_LENGTH);
    this.#readBuffer = "";
    this.#reportDiagnosticQuietly({
      kind: "line-too-long",
      retainedLength,
      limit: CODEX_MAX_LINE_LENGTH,
    });
    this.#rejectAllPending(error);
    this.#onReadyFailed?.(error);
    // `PtyHost.close` does not signal the child, so `close()` alone could leave it running.
    // `SIGKILL`: no protocol is left for an orderly stop; the graceful path is `closeSession`.
    const ptySessionId = this.#ptySessionId;
    if (ptySessionId !== null) {
      void this.#ptyHost.kill(ptySessionId, "SIGKILL").catch(() => {
        /* already reaped, or the host lost it */
      });
    }
    void this.close().catch(() => {
      /* teardown of an already-doomed transport */
    });
  }

  #handleLine(line: string): void {
    if (line.length === 0) {
      return;
    }
    if (!this.#sawReadySentinel && line === CODEX_APP_SERVER_READY_SENTINEL) {
      this.#sawReadySentinel = true;
      this.#onReady?.();
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      // Shell diagnostics, provider stderr or a truncated frame; a mis-set tty shows up here.
      this.#reportDiagnosticQuietly({ kind: "unparsable-line", line });
      return;
    }
    if (!isPlainObject(frame)) {
      this.#reportDiagnosticQuietly({ kind: "unparsable-line", line });
      return;
    }
    const message = frame;
    const method = message["method"];
    if (typeof method === "string") {
      this.#handleInboundMethod(method, message);
      return;
    }
    this.#handleInboundResponse(message, line);
  }

  #handleInboundMethod(method: string, message: Record<string, unknown>): void {
    const id = message["id"];
    const isRequest = id !== undefined && id !== null;
    if (isRequest) {
      if (this.#isEchoOfOurOwnRequest(id, method)) {
        // Our own frame echoed by a tty with ECHO on; answering it would corrupt correlation.
        this.#reportDiagnosticQuietly({ kind: "echoed-client-frame", method });
        return;
      }
      // Routed asks (callback tools, approvals, elicitations) go through the daemon's pipeline.
      const routed = CODEX_ROUTED_SERVER_REQUEST_DESCRIPTORS.get(method);
      if (routed !== undefined) {
        void this.#answerRoutedServerRequest(id, method, routed, message["params"]);
        return;
      }
      // Every other request fails closed, censused or not (a newer build may speak a method this
      // pin never saw): an error answer cannot be mistaken for consent, and silence hangs the turn.
      this.#reportDiagnosticQuietly({
        kind: "unhandled-server-request",
        method,
        censused: CODEX_SERVER_REQUEST_METHODS.has(method),
      });
      void this.#writeFrame({
        jsonrpc: "2.0",
        id,
        error: {
          code: JSON_RPC_METHOD_NOT_FOUND,
          message: `The driver does not handle "${method}" at this lifecycle stage.`,
        },
      }).catch(() => {
        /* connection gone; the exit path reports it */
      });
      return;
    }
    if (this.#onServerNotification !== undefined) {
      // Contained here too: a throwing consumer would unwind `#ingest` and drop the frames queued
      // behind this one in the same chunk.
      try {
        this.#onServerNotification(method, message["params"]);
      } catch (cause) {
        this.#reportDiagnosticQuietly({
          kind: "notification-consumer-failed",
          method,
          detail: normalizeProviderFailureDetail(cause),
        });
      }
      return;
    }
    this.#reportDiagnosticQuietly({ kind: "unconsumed-server-notification", method });
  }

  /**
   * Answers one routed server request through the daemon's responder. Every path answers, with
   * the method's own refusal shape rather than `-32601`, which the provider may treat as a
   * protocol fault. Rejections are absorbed here because the caller does not await it.
   */
  async #answerRoutedServerRequest(
    id: unknown,
    method: string,
    descriptor: CodexRoutedServerRequestDescriptor,
    params: unknown,
  ): Promise<void> {
    const responder = this.#serverRequestResponder;
    let result: CodexServerRequestResult;
    if (responder === undefined) {
      const reason = `The daemon has no responder registered for "${method}"; refusing rather than answering without adjudication.`;
      this.#reportDiagnosticQuietly({ kind: "unrouted-server-request-refused", method });
      result = descriptor.composeRefusedResult(reason);
    } else {
      try {
        const decision = await responder.answer({
          method,
          askKind: descriptor.askKind,
          params,
        });
        result =
          decision.decision === "allow"
            ? descriptor.composeAllowedResult(decision.payload)
            : descriptor.composeRefusedResult(decision.reason);
      } catch (cause) {
        // A responder that throws has not decided; an undecided ask is refused, never allowed.
        const detail = normalizeProviderFailureDetail(cause);
        this.#reportDiagnosticQuietly({
          kind: "server-request-responder-failed",
          method,
          detail,
        });
        result = descriptor.composeRefusedResult(detail);
      }
    }
    const encodedAnswer = this.#encodeBoundedAnswerFrame(id, method, descriptor, result);
    if (encodedAnswer === null) {
      // Both attempts are already reported.
      return;
    }
    await this.#writeEncodedFrame(encodedAnswer.ptySessionId, encodedAnswer.bytes).catch(
      (cause: unknown) => {
        // A rejected answer leaves the provider waiting on the ask forever, so it is reported.
        this.#reportDiagnosticQuietly({
          kind: "server-request-answer-write-failed",
          method,
          detail: normalizeProviderFailureDetail(cause),
        });
      },
    );
  }

  /**
   * Encodes one answer frame within the line-length bound, measured on the encoded bytes,
   * substituting a refusal with {@link CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON} for an oversized
   * one. Returns `null` when nothing is sendable; every failed attempt has been reported.
   */
  #encodeBoundedAnswerFrame(
    id: unknown,
    method: string,
    descriptor: CodexRoutedServerRequestDescriptor,
    result: CodexServerRequestResult,
  ): CodexEncodedFrame | null {
    const composedAnswer = this.#encodeAnswerFrameOrReport(id, method, result);
    if (composedAnswer === null) {
      return null;
    }
    if (composedAnswer.bytes.length <= CODEX_MAX_LINE_LENGTH) {
      return composedAnswer;
    }
    this.#reportDiagnosticQuietly({
      kind: "server-request-answer-oversized",
      method,
      encodedByteLength: composedAnswer.bytes.length,
      limit: CODEX_MAX_LINE_LENGTH,
    });
    const substitutedRefusal = this.#encodeAnswerFrameOrReport(
      id,
      method,
      descriptor.composeRefusedResult(CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON),
    );
    if (substitutedRefusal === null) {
      return null;
    }
    if (substitutedRefusal.bytes.length <= CODEX_MAX_LINE_LENGTH) {
      return substitutedRefusal;
    }
    // Reachable only when the provider's request `id` is itself past the bound.
    this.#reportDiagnosticQuietly({
      kind: "server-request-answer-oversized",
      method,
      encodedByteLength: substitutedRefusal.bytes.length,
      limit: CODEX_MAX_LINE_LENGTH,
    });
    return null;
  }

  /** The frame encode with its throw recorded rather than raised. */
  #encodeAnswerFrameOrReport(
    id: unknown,
    method: string,
    result: CodexServerRequestResult,
  ): CodexEncodedFrame | null {
    try {
      return this.#encodeFrame({ jsonrpc: "2.0", id, result });
    } catch (cause) {
      // A closed connection or an unserializable `result` must not escape into the ingest loop.
      this.#reportDiagnosticQuietly({
        kind: "server-request-answer-write-failed",
        method,
        detail: normalizeProviderFailureDetail(cause),
      });
      return null;
    }
  }

  /**
   * True for an echo of our own pending request. Both id and method must match: the two
   * directions mint ids independently. The pending entry stays, since the real reply is owed.
   */
  #isEchoOfOurOwnRequest(id: unknown, method: string): boolean {
    if (typeof id !== "number" && typeof id !== "string") {
      return false;
    }
    return this.#pending.get(String(id))?.method === method;
  }

  #handleInboundResponse(message: Record<string, unknown>, line: string): void {
    const id = message["id"];
    if (typeof id !== "number" && typeof id !== "string") {
      this.#reportDiagnosticQuietly({ kind: "unparsable-line", line });
      return;
    }
    const key = String(id);
    const pending = this.#pending.get(key);
    if (pending === undefined) {
      this.#reportDiagnosticQuietly({ kind: "unknown-response-id", responseId: key });
      return;
    }
    this.#pending.delete(key);
    pending.cancelDeadline();
    const error = message["error"];
    if (error !== undefined && error !== null) {
      const errorRecord = isPlainObject(error) ? error : {};
      const rawCode = errorRecord["code"];
      const rawMessage = errorRecord["message"];
      const providerErrorCode = typeof rawCode === "number" ? rawCode : 0;
      const providerMessage = typeof rawMessage === "string" ? rawMessage : "";
      pending.reject(
        new CodexProviderRequestError(
          pending.method,
          providerErrorCode,
          providerMessage,
          errorRecord["data"],
        ),
      );
      return;
    }
    pending.resolve(message["result"]);
  }

  /**
   * Handles the child exiting, inside a `PtyHost` event callback: the diagnostic sink and the
   * disposer are contained so an exception cannot skip the cleanup.
   */
  #handleExit(exitCode: number, signalCode: number | null): void {
    this.#exitDescription = `exit ${exitCode}${signalCode === null ? "" : ` signal ${signalCode}`}`;
    this.#reportDiagnosticQuietly({ kind: "process-exited", exitCode, signalCode });
    // Closed before rejecting, so a retrying handler is refused: a write to an exited pty raises
    // an asynchronous EIO no caller can catch.
    this.#closed = true;
    // A disposer failure is reported, not rethrown (there is no caller).
    let disposeFault: { readonly cause: unknown } | null = null;
    if (this.#unsubscribe !== null) {
      const dispose = this.#unsubscribe;
      this.#unsubscribe = null;
      try {
        dispose();
      } catch (cause) {
        disposeFault = { cause };
      }
    }
    const exitError = new CodexTransportError("The Codex app-server process exited.", {
      reason: this.#exitDescription,
    });
    this.#rejectAllPending(exitError);
    this.#onReadyFailed?.(exitError);
    if (disposeFault !== null) {
      // After the cleanup, so a throwing sink cannot cost callers their rejections.
      this.#reportDiagnosticQuietly({
        kind: "subscription-dispose-failed",
        detail: normalizeProviderFailureDetail(disposeFault.cause),
      });
    }
  }

  /**
   * Reports a diagnostic contained (see `reportDiagnosticFromDetachedFrame`): these originate in
   * detached callbacks, where a throwing sink would be a daemon-fatal unhandled rejection.
   */
  #reportDiagnosticQuietly(diagnostic: CodexTransportDiagnostic): void {
    reportDiagnosticFromDetachedFrame(this.#reportDiagnostic, diagnostic);
  }

  #clearReadyWait(): void {
    this.#onReady = null;
    this.#onReadyFailed = null;
  }

  #rejectAllPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.cancelDeadline();
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

interface CodexSessionRecord {
  readonly sessionId: SessionId;
  readonly connection: CodexAppServerConnection;
  /**
   * The thread this session is bound to. Only `forkConversation` changes it, in place, because
   * in-flight closures hold this record and check `#sessions` still maps to it.
   */
  threadId: string;
  /**
   * This thread's turn ids, oldest first; `ForkConversationParams.position` N is
   * `turnBoundaries[N - 1]`. Seeded from `thread.turns` on resume and fork, appended at each
   * accepted `turn/start`. Uncapped: evicting the head would re-map every later ordinal.
   */
  readonly turnBoundaries: string[];
  /** The posture re-sent as each turn's `sandboxPolicy` when its `StartRunParams` declare none. */
  readonly executionPosture: ExecutionPosture | undefined;
  /** The subagent policy, re-sent on `thread/fork` so the new thread keeps its caps. */
  readonly subagentPolicy: SubagentPolicy | undefined;
  /**
   * The config this process was launched with. A resume reuses its `cwd` and `env` but
   * re-derives `credentialEnvPolicy` from its own posture, inheriting this one only when it
   * states none (see `#composeResumeSpawnConfig`).
   */
  readonly spawnConfig: CodexSessionConfig;
  /**
   * Every live turn, keyed by turn id, newest last. Turn-keyed because a run can hold several
   * live turns; a run-keyed map would lose the first one's terminal route.
   */
  readonly runIdByActiveTurnId: Map<string, RunId>;
  /**
   * Turn evidence that arrived before any route pointed at its turn; insertion-ordered, capped
   * (`CODEX_UNMATCHED_TURN_MEMORY`), consumed by `startRun`, which rules the tripwire on the
   * evidence itself (an id alone would report a zero-turn interception as a completed turn).
   */
  readonly unmatchedTurnEvidence: Map<string, UnmatchedTurnEvidence>;
  /** `turn/start` requests awaiting an answer; at zero nothing can claim evidence. */
  inFlightTurnStarts: number;
  /**
   * Turn ids whose terminal was ingested, newest last, so `steerRun` can ask whether an
   * acknowledged turn has ended. Written for every terminal, never consumed; pruned to
   * `CODEX_SETTLED_TURN_MEMORY` only while `inFlightSteers` is zero.
   */
  readonly settledTurnIds: Set<string>;
  /** `turn/steer` requests awaiting an answer; a count, as each live turn steers on its own. */
  inFlightSteers: number;
  /**
   * Runs whose route an interrupt retired before their turn's terminal arrived, keyed by that
   * turn id: `turn/interrupt` resolves on acceptance, and the tripwire is ruled on the later
   * `turn/completed`. Not a live route. Bounded by refusal at `CODEX_INTERRUPTED_ROUTE_MEMORY`,
   * never eviction; released when the terminal is ruled.
   */
  readonly interruptedRunIdByTurnId: Map<string, RunId>;
}

/**
 * What was observed about a turn before any correlated frame was re-keyed onto it. The
 * tripwire is ruled on both parts: a `notLoaded` terminal alone cannot restate the observations.
 */
interface UnmatchedTurnEvidence {
  readonly observations: Set<TurnEvidenceClass>;
  /** The settling classification, once this turn's terminal has arrived. */
  terminal: TurnEvidenceClassification | undefined;
}

/**
 * How a session's thread bases its usage registers. The resume arm names the thread whose
 * prior-emitted sum it bases on, which after a rewind is not the new forked thread.
 */
type CodexUsageEstablishment =
  | { readonly mode: "fresh" }
  | { readonly mode: "resume"; readonly priorEmittedThreadId: string };

/**
 * Gets or creates a turn's entry in the bounded evidence memory, or returns `null` when it can
 * neither evict nor grow, which is session-fatal. While a `turn/start` is in flight nothing is
 * evicted (one synchronous drain can outrun the waiting `startRun` continuation, and dropping
 * its terminal would report a swallowed opening as a completed turn) and the memory may grow to
 * `CODEX_UNMATCHED_TURN_MEMORY_CEILING`. With none in flight, oldest-first eviction is free.
 */
function rememberUnmatchedTurn(
  record: CodexSessionRecord,
  turnId: string,
): UnmatchedTurnEvidence | null {
  const memory = record.unmatchedTurnEvidence;
  const existing = memory.get(turnId);
  if (
    existing === undefined &&
    record.inFlightTurnStarts > 0 &&
    memory.size >= CODEX_UNMATCHED_TURN_MEMORY_CEILING
  ) {
    // Only a turn not already held is refused; dropping a held one would make the refusal the loss.
    return null;
  }
  const remembered = existing ?? { observations: new Set(), terminal: undefined };
  memory.delete(turnId);
  memory.set(turnId, remembered);
  if (record.inFlightTurnStarts === 0) {
    while (memory.size > CODEX_UNMATCHED_TURN_MEMORY) {
      const oldest = memory.keys().next();
      if (oldest.done === true) {
        break;
      }
      memory.delete(oldest.value);
    }
  }
  return remembered;
}

/**
 * Records that a turn's terminal was ingested; false (session-fatal) means the memory is full.
 * `turn/steer` reads absence as "still live", so with a steer in flight nothing is evicted and
 * the memory refuses at `CODEX_SETTLED_TURN_MEMORY_CEILING`; otherwise oldest-first pruning.
 */
function rememberSettledTurn(record: CodexSessionRecord, turnId: string): boolean {
  const memory = record.settledTurnIds;
  if (
    !memory.has(turnId) &&
    record.inFlightSteers > 0 &&
    memory.size >= CODEX_SETTLED_TURN_MEMORY_CEILING
  ) {
    return false;
  }
  memory.delete(turnId);
  memory.add(turnId);
  if (record.inFlightSteers === 0) {
    while (memory.size > CODEX_SETTLED_TURN_MEMORY) {
      const oldest = memory.values().next();
      if (oldest.done === true) {
        break;
      }
      memory.delete(oldest.value);
    }
  }
  return true;
}

/**
 * Retains an interrupted run's turn correlation for its coming terminal; false (session-fatal)
 * at the ceiling. Never evicts: every entry is still owed its terminal, and an evicted one
 * would leave that terminal ruled against no run.
 */
function rememberInterruptedRun(record: CodexSessionRecord, turnId: string, runId: RunId): boolean {
  const memory = record.interruptedRunIdByTurnId;
  if (!memory.has(turnId) && memory.size >= CODEX_INTERRUPTED_ROUTE_MEMORY) {
    return false;
  }
  memory.delete(turnId);
  memory.set(turnId, runId);
  return true;
}

/** The newest live turn a run holds on one session, or `undefined`; interventions land there. */
function newestActiveTurnForRun(record: CodexSessionRecord, runId: RunId): string | undefined {
  let newest: string | undefined;
  for (const [turnId, routedRunId] of record.runIdByActiveTurnId) {
    if (routedRunId === runId) {
      newest = turnId;
    }
  }
  return newest;
}

/**
 * The run whose turn is active on one session record, or `null` unless every live turn belongs
 * to one run. Record-scoped: a resume installs a fresh record under the same session id.
 */
function soleActiveRunIdIn(record: CodexSessionRecord): RunId | null {
  let soleActiveRunId: RunId | null = null;
  for (const runId of record.runIdByActiveTurnId.values()) {
    if (soleActiveRunId === null) {
      soleActiveRunId = runId;
      continue;
    }
    if (soleActiveRunId !== runId) {
      return null;
    }
  }
  return soleActiveRunId;
}

/** A session slot held for the duration of one in-flight lifecycle transition. */
interface CodexSessionTransition {
  readonly kind: CodexSessionTransitionKind;
  /** Settlement of the transition; rejections are swallowed so a waiter does not inherit them. */
  readonly settled: Promise<void>;
}

/** The slot states a transition can publish: all but `live`, which is what a settled record is. */
type CodexSessionTransitionKind = Exclude<CodexSessionSlotState, "live">;

// A failed `turn/start` is ambiguous unless the provider returned a clean JSON-RPC error: a
// deadline, transport death or unusable turn id may hide an accepted turn, and leaving it running
// unreachable (or replaying it) costs more than one re-establish. `#assertWritable`'s
// already-closed refusal counts too. Recovery is teardown and replay; the positional reconcile in
// `startRun` adopts no turn.

/**
 * Reduces `error.data.codexErrorInfo` to the classifier's shape (message prose is never read).
 * Only `badRequest` is structural; where a rejection carries the member is undocumented at the
 * pin.
 */
function readCodexProviderRefusalShape(
  providerErrorData: unknown,
): ProviderRefusalShape | undefined {
  if (
    typeof providerErrorData !== "object" ||
    providerErrorData === null ||
    Array.isArray(providerErrorData)
  ) {
    return undefined;
  }
  const codexErrorInfo = (providerErrorData as Record<string, unknown>)["codexErrorInfo"];
  // Object-shaped members are never the structural class.
  if (typeof codexErrorInfo !== "string") {
    return undefined;
  }
  return codexErrorInfo === CODEX_STRUCTURAL_REFUSAL_ERROR_INFO
    ? "history-structurally-invalid"
    : "request-otherwise-refused";
}

/** The one `CodexErrorInfo` member that indicts the thread's own history. */
const CODEX_STRUCTURAL_REFUSAL_ERROR_INFO = "badRequest";

/** One failed `turn/start` for the shared classifier; anything unanswered is `indeterminate`. */
function observeCodexTurnStartFailure(cause: unknown): ProviderRequestFailureObservation {
  return cause instanceof CodexProviderRequestError
    ? {
        delivery: "consumed-and-refused",
        refusalShape: readCodexProviderRefusalShape(cause.providerErrorData),
      }
    : { delivery: "indeterminate" };
}

/**
 * Resolves the credential policy for the posture a spawn states, per spawn and never cached.
 * `undefined` for a posture that carries a reference is a wiring fault: the spawn refuses.
 */
export type CodexCredentialEnvPolicyResolver = (
  posture: ExecutionPosture,
) => Promise<CredentialEnvPolicy | undefined>;

/** Construction inputs for the lifecycle manager. */
export interface CodexLifecycleOptions extends CodexConnectionOptions {
  /**
   * Spawn context for a cold resume and the auth probe; required, since a bare environment hides
   * the credential home and fails like a bad handle. Parse untyped input with
   * `parseCodexSessionConfig`.
   */
  readonly resumeSpawnConfig: CodexSessionConfig;
  /**
   * Answers a spawn's credential policy from its posture. Required: a manager-wide fallback
   * cannot represent a per-session policy and would relaunch a tightened posture unreported.
   */
  readonly resolveCredentialEnvPolicy: CodexCredentialEnvPolicyResolver;
  /** Mints `DriverResumeResult.bindingId`; supply the store's minter in the daemon. */
  readonly newBindingId?: (() => string) | undefined;
  /**
   * Answers routed server requests with session and run identity attached. The manager wraps it
   * per connection and overrides the transport-level `serverRequestResponder` with the wrapper.
   */
  readonly answerServerRequest?: CodexSessionServerRequestResponder | undefined;
  /**
   * This leg's declared text-neutrality parity grade, default `emulated`. Injected rather than
   * derived from the driver's name; the default stays `emulated` although the transport was
   * probed at the pin and does no client-side command parsing.
   */
  readonly textNeutralityMechanismGrade?: TextNeutralityMechanismGrade | undefined;
  /** Correlation minting for outbound text frames. Injectable for tests. */
  readonly mintOutboundFrameCorrelationId?: (() => string) | undefined;
  /**
   * Receives the run terminal a tripwire trip produces (producer-only). Required: a trip raises no
   * JSON-RPC error, so this is the only user-visible surface.
   */
  readonly onTextNeutralizationFailure: (
    sessionId: SessionId,
    runId: RunId,
    failure: TextNeutralizationRunFailure,
  ) => void;
  /**
   * The daemon-wide diagnostic band for policy facts such as `subagent_definition_disabled`;
   * required, and separate from `reportDiagnostic`, the transport channel.
   */
  readonly diagnostics: DriverDiagnosticsEmitter;
  /**
   * The daemon's prior-emitted cumulative token sums for one thread, used to base a native resume.
   * Optional because the sums live in the event record this module never reads; unbound, a resume
   * bases at zero, re-meters the whole total once, and reports a diagnostic.
   */
  readonly readPriorEmittedUsage?:
    | ((sessionId: SessionId, threadId: string) => CumulativeAxisReadings | undefined)
    | undefined;
  /** Receives each metered per-turn usage delta; the emission pipeline mints the envelope. */
  readonly onMeteredUsage?: ((sessionId: SessionId, delta: MeteredUsageDelta) => void) | undefined;
  /**
   * Receives the `subagent.started` / `subagent.completed` pair per provider-attributed child
   * thread; the child's only timeline presence.
   */
  readonly onSubagentLifecycle?:
    | ((sessionId: SessionId, emission: SubagentLifecycleEmission) => void)
    | undefined;
  /**
   * Reads a replay target's turns back as text for the post-replay assertion (same shape as
   * `MemoTargetGateway.readTurnsForMarkerReconciliation`). Unbound: the pinned Codex documents no
   * read returning turn bodies, so `replayTranscript` abandons the target and refuses.
   */
  readonly transcriptReplayReadback?: ReplayTargetReadbackReader | undefined;
  /**
   * Reads how many user-originated turns a thread holds, for the positional reconcile of an
   * ambiguous `turn/start` against `turnBoundaries` (`transcriptReplayReadback` bodies include
   * assistant turns). Unbound, the ambiguity reports `unrecoverable`: nothing is re-sent.
   */
  readonly userTurnReadback?: UserTurnReadbackReader | undefined;
}

/**
 * One inbound Codex notification as the thread-frame router sees it; `params` rides along so a
 * held frame still carries its content when its registration lands.
 */
interface CodexRoutableFrame extends RoutableProviderFrame {
  readonly params: unknown;
}

/**
 * The router's bounds. The hold covers one short race (child traffic ahead of its
 * `thread/started`), so its timeout is far below any human-visible latency.
 */
const CODEX_THREAD_FRAME_ROUTER_CONFIG: ThreadFrameRouterConfig = Object.freeze({
  maxQuarantinedFrames: 64,
  maxPendingHoldFrames: 128,
  pendingRegistrationTimeoutMs: 5_000,
});

/**
 * The compaction-wait key: session and thread together, since a fork or superseding resume moves
 * the thread and a session-only key would settle on the replacement's `thread/compacted`.
 * NUL-joined because every bounded string on this leg rejects NUL.
 */
function codexCompactionWaitKey(sessionId: SessionId, threadId: string): string {
  return `${sessionId}\u0000${threadId}`;
}

/**
 * Reads the thread identity a Codex frame carries, or `null` when unreadable (the router refuses
 * that fail-closed). Never throws: it runs inside the transport's `#ingest` drain.
 */
function readCodexFrameThreadId(method: string, params: unknown): string | null {
  const payload = isPlainObject(params) ? params : {};
  if (method === CODEX_THREAD_STARTED_METHOD) {
    const thread = isPlainObject(payload["thread"]) ? payload["thread"] : {};
    const threadId = thread["id"];
    return typeof threadId === "string" && threadId.length > 0 ? threadId : null;
  }
  const threadId = payload["threadId"];
  return typeof threadId === "string" && threadId.length > 0 ? threadId : null;
}

/**
 * Reads a `thread/started` child announcement, or `null` when the frame names no parent (the
 * session's own thread starting). Never throws, like {@link readCodexFrameThreadId}.
 */
function readCodexChildThreadAnnouncement(params: unknown): ChildThreadAnnouncement | null {
  const payload = isPlainObject(params) ? params : {};
  const thread = isPlainObject(payload["thread"]) ? payload["thread"] : {};
  const threadId = thread["id"];
  const parentThreadId = thread["parentThreadId"];
  const threadSourceKind = thread["threadSourceKind"];
  if (typeof threadId !== "string" || threadId.length === 0) {
    return null;
  }
  if (typeof parentThreadId !== "string" || parentThreadId.length === 0) {
    return null;
  }
  return deriveCodexChildThreadAnnouncement({
    threadId,
    parentThreadId,
    threadSourceKind: typeof threadSourceKind === "string" ? threadSourceKind : "",
  });
}

/**
 * Reads a `thread/tokenUsage/updated` frame into a cumulative reading, or `null` without a usable
 * thread identity or breakdown. Partial axes are admitted; the accountant refuses non-finite ones.
 */
function readCodexCumulativeUsageReading(params: unknown): CumulativeUsageReading | null {
  const payload = isPlainObject(params) ? params : {};
  const threadId = payload["threadId"];
  if (typeof threadId !== "string" || threadId.length === 0) {
    return null;
  }
  const turnId = payload["turnId"];
  // `tokenUsage` is the wire's member name (`total` cumulative, `last` per-turn); no alias is
  // accepted, so a wire rename cannot become a silent metering stop.
  const tokenUsage = payload["tokenUsage"];
  if (!isPlainObject(tokenUsage)) {
    return null;
  }
  const cumulative = readCodexTokenBreakdown(tokenUsage["total"]);
  if (cumulative === null) {
    return null;
  }
  const declaredPerTurn = readCodexTokenBreakdown(tokenUsage["last"]);
  return {
    threadId,
    namedTurnId: typeof turnId === "string" && turnId.length > 0 ? turnId : null,
    cumulative,
    declaredPerTurn,
  };
}

/**
 * Maps one Codex `TokenUsageBreakdown` onto the accountant's axes, or `null` for a non-object.
 * Absent axes stay absent: a fabricated zero would meter a negative delta on the next reading.
 */
function readCodexTokenBreakdown(value: unknown): CumulativeAxisReadings | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const readings: Record<string, number> = {};
  const wireNamesByAxis: Readonly<Record<string, string>> = {
    input: "inputTokens",
    cachedInput: "cachedInputTokens",
    cacheWriteInput: "cacheWriteInputTokens",
    output: "outputTokens",
    reasoningOutput: "reasoningOutputTokens",
    total: "totalTokens",
  };
  for (const [axis, wireName] of Object.entries(wireNamesByAxis)) {
    const reading = value[wireName];
    if (typeof reading === "number") {
      readings[axis] = reading;
    }
  }
  return Object.keys(readings).length === 0 ? null : (readings as CumulativeAxisReadings);
}

/** Whether a `turn/completed` status ends the turn, by the set route retirement also uses. */
function readCodexTerminalTurnStatus(params: unknown): boolean {
  const payload = isPlainObject(params) ? params : {};
  const turn = isPlainObject(payload["turn"]) ? payload["turn"] : {};
  const status = turn["status"];
  return typeof status === "string" && CODEX_TERMINAL_TURN_STATUSES.has(status);
}

/** Lifecycle operations as Codex `app-server` calls, one connection per session. */
export class CodexLifecycleManager {
  readonly #options: CodexLifecycleOptions;
  readonly #newBindingId: () => string;
  readonly #turnStartTimeoutMs: number;
  readonly #outboundTextFrameWriter: OutboundTextFrameWriter;
  readonly #outboundFrameTripwire: OutboundFrameTripwire;
  readonly #runtimeBindingQuarantine = new RuntimeBindingQuarantine();
  readonly #sessions = new Map<SessionId, CodexSessionRecord>();
  /** Burned replay targets by provider session id; they outlive the daemon-side session. */
  readonly #replayTargets: ReplayTargetLedger = new ReplayTargetLedger();
  /**
   * Settles an ambiguous `turn/start` positionally; its per-thread serialization keeps one
   * reconcile's read and ruling atomic. A concurrent successful start can only inflate the read,
   * which can only settle `delivered` (re-sends nothing), never `cleared-for-retry`.
   */
  readonly #ambiguousDeliveryReconciler: AmbiguousDeliveryReconciler;
  // The intended-close producer: one gate per session, latched at the top of `closeSession`, which
  // `event-normalizer.ts` stamps on the terminal payload. Keyed beside the record map because a
  // close during establishment holds no installed record.
  readonly #terminalEmissionGates = new Map<SessionId, CodexTerminalEmissionGate>();
  // One router and one usage accountant per provider session, keyed beside the record map: a frame
  // can arrive while the slot is establishing, before a record exists.
  readonly #frameRouters = new Map<SessionId, ThreadFrameRouter<CodexRoutableFrame>>();
  readonly #usageAccountants = new Map<SessionId, UsageDeltaAccountant>();
  // Manager-scoped so disposal settles a compaction wait armed against a torn-down session.
  readonly #pendingCompactions: PendingCompactionRegistry;
  // Live command enumeration per session, held uncapped: the cap applies when a result is
  // composed. Discarded on `skills/changed` and with the session.
  readonly #providerCommandEnumerations = new Map<SessionId, readonly ProviderCommandEntry[]>();
  // The invalidation epoch each held enumeration was read under: a `skills/list` in flight during
  // `skills/changed` would otherwise store a pre-change listing. Symbols, not a counter, since a
  // reused session id could match a reset counter.
  readonly #providerCommandEnumerationEpochs = new Map<SessionId, symbol>();
  readonly #sessionIdByRunId = new Map<RunId, SessionId>();
  /** In-flight create, resume, fork or close per session, held until it fully settles. */
  readonly #sessionTransitions = new Map<SessionId, CodexSessionTransition>();

  constructor(options: CodexLifecycleOptions) {
    this.#options = options;
    this.#newBindingId = options.newBindingId ?? mintUuidV7;
    this.#turnStartTimeoutMs = options.turnStartTimeoutMs ?? DEFAULT_TURN_START_TIMEOUT_MS;
    // The same injected scheduler as the transport's deadlines.
    this.#pendingCompactions = new PendingCompactionRegistry(
      options.scheduleTimeout ?? defaultScheduleTimeout,
    );
    this.#ambiguousDeliveryReconciler = new AmbiguousDeliveryReconciler(options.userTurnReadback);
    this.#outboundTextFrameWriter = new OutboundTextFrameWriter({
      mechanismGrade: options.textNeutralityMechanismGrade ?? "emulated",
      mintCorrelationId: options.mintOutboundFrameCorrelationId,
    });
    // Built here because the predicate reads later-declared fields. A retired session's pending
    // frames are pure occupancy, reclaimed only when a write would otherwise be refused.
    this.#outboundFrameTripwire = new OutboundFrameTripwire({
      isScopeRetired: (scopeKey: string): boolean =>
        !this.#sessions.has(scopeKey as SessionId) ||
        this.#runtimeBindingQuarantine.isSessionDisposed(scopeKey),
    });
  }

  /**
   * Composes and registers the run's opening text frame before any byte is written: text the
   * tripwire cannot watch must not be sent, or a turn settling against no frame would pass.
   *
   * @throws {OutboundFrameCapacityRefusedError} when the session holds more unsettled frames than
   *   the tripwire will watch.
   */
  #composeRunOpeningFrame(params: StartRunParams, runConfig: CodexRunConfig): OutboundTextFrame {
    // A literal, not read from the caller's config: `driver_command` skips neutralization and the
    // tripwire, so it must not be nameable through an untyped record.
    const frame = this.#outboundTextFrameWriter.compose({
      text: runConfig.input,
      origin: RUN_OPENING_FRAME_ORIGIN,
    });
    this.#outboundFrameTripwire.register({
      scopeKey: runConfig.sessionId,
      joinKey: params.runId,
      frameRole: "turn-opening",
      frame,
    });
    return frame;
  }

  /** Spawns a process and starts a fresh Codex thread. */
  async createSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    // Refused before anything is spawned, reading every view of the slot with no `await` before
    // the claim: overlapping creates would orphan a process. A `closing` holder refuses too.
    const holderState = this.#describeSlotHolder(params.sessionId);
    if (holderState !== undefined) {
      throw new CodexSessionAlreadyLiveError(params.sessionId, holderState);
    }
    return await this.#claimSessionSlot(
      params.sessionId,
      "establishing",
      async () => await this.#establishCreatedSession(params),
    );
  }

  async #establishCreatedSession(params: CreateSessionParams): Promise<ProviderSessionHandle> {
    // Composed before the connection exists, so an unresolvable posture costs no process. Create
    // has no result type, so it raises the same `CodexDriverConfigError` as its config parse.
    const config = await this.#composeCreateSpawnConfig(params);
    const connection = new CodexAppServerConnection(this.#connectionOptionsFor(params.sessionId));
    try {
      // Inside the guard: `open()` tears down only the paths it owns, not a throwing
      // caller-supplied subscriber, and `close()` is idempotent.
      await connection.open(config);
      const response = await connection.request("thread/start", {
        cwd: config.cwd,
        // Spread so a session with no declared posture gets none: an invented posture would refuse
        // admitted tool calls or grant what was not.
        ...this.#composeThreadEstablishmentLegs(params.executionPosture, params.subagentPolicy),
        // Defense in depth: no config or profile override may select an auto-review path that
        // bypasses the approval pipeline. The per-turn pin in `#requestTurnStart` is needed too.
        approvalsReviewer: "user",
      });
      const thread = readThread(response, "thread/start");
      this.#assertPostureRealized(params.executionPosture, response);
      this.#reportWithheldCallbackTools(params.sessionId, params.callbackTools);
      this.#sessions.set(params.sessionId, {
        sessionId: params.sessionId,
        connection,
        threadId: thread.id,
        turnBoundaries: [],
        executionPosture: params.executionPosture,
        subagentPolicy: params.subagentPolicy,
        spawnConfig: config,
        runIdByActiveTurnId: new Map(),
        unmatchedTurnEvidence: new Map(),
        inFlightTurnStarts: 0,
        settledTurnIds: new Set(),
        inFlightSteers: 0,
        interruptedRunIdByTurnId: new Map(),
      });
      // A fresh process now answers for this session id, so a prior trip's refusal is released.
      this.#runtimeBindingQuarantine.releaseSession(params.sessionId);
      // Bases at zero: the provider's counter starts there, so the first turn is real spend.
      this.#bindSessionThread(params.sessionId, thread.id, { mode: "fresh" });
      // `id` is the resume key; `sessionId` groups a thread tree (fork and subagent threads share
      // it), so the two are not interchangeable.
      return { providerSessionId: thread.sessionId, resumeHandle: thread.id };
    } catch (cause) {
      // Contained so a throwing disposer in `close()` cannot replace the spawn or handshake error.
      await this.#releaseAbandonedConnection(connection);
      throw cause;
    }
  }

  /**
   * Resumes an existing Codex thread from its provider-owned handle. Every failure tears its
   * process down and returns the typed `failed` result; it never falls back to a fresh thread.
   */
  async resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    // Claims the slot rather than refusing a held one (unlike the Claude leg): this driver
    // supersedes a live leg on resume, which serializing behind the holder makes reachable.
    return await this.#claimSessionSlot(
      params.sessionId,
      "establishing",
      async () => await this.#establishResumedSession(params),
    );
  }

  /**
   * `cwd` and `env` come from the untyped `params.config`, parsed fail-closed on every create; the
   * credential policy is posture-derived. Members are built one by one, never spread, so a policy
   * the posture resolved away is not carried through.
   */
  async #composeCreateSpawnConfig(params: CreateSessionParams): Promise<CodexSessionConfig> {
    const declared = parseCodexSessionConfig(params.config);
    const credentialEnvPolicy = await this.#resolveCredentialEnvPolicyForPosture(
      declared.credentialEnvPolicy,
      params.executionPosture,
      "CreateSessionParams.executionPosture.credentialPolicyRef",
    );
    // The typed and config channels can both name the credential home; the typed one is checked
    // against the other, so a typed caller cannot silently spawn against the node default.
    const providerAccountId = resolveBoundProviderAccountId({
      requested: params.providerAccountId,
      requestedField: "CreateSessionParams.providerAccountId",
      recorded: declared.providerAccountId,
      recordedField: "CreateSessionParams.config.providerAccountId",
    });
    return {
      cwd: declared.cwd,
      env: declared.env,
      ...(providerAccountId === undefined ? {} : { providerAccountId }),
      ...(credentialEnvPolicy === undefined ? {} : { credentialEnvPolicy }),
    };
  }

  /**
   * `cwd` and `env` come from the live record's spawn config, else the manager default; the
   * credential policy is entirely posture-derived, since inheriting it would relaunch a session
   * created `trusted` and resumed sandboxed unfiltered. Members are built one by one, never spread.
   */
  async #composeResumeSpawnConfig(
    existing: CodexSessionRecord | undefined,
    params: ResumeSessionParams,
  ): Promise<CodexSessionConfig> {
    const processContext = existing?.spawnConfig ?? this.#options.resumeSpawnConfig;
    const credentialEnvPolicy = await this.#resolveCredentialEnvPolicyForPosture(
      processContext.credentialEnvPolicy,
      params.executionPosture,
      "ResumeSessionParams.executionPosture.credentialPolicyRef",
    );
    // Re-derived so a posture change reaches the child. The account is pinned for the leg's
    // lifetime, so a typed member contradicting the live record refuses.
    const requestedAccountId = resolveBoundProviderAccountId({
      requested: params.providerAccountId,
      requestedField: "ResumeSessionParams.providerAccountId",
      recorded: existing?.spawnConfig.providerAccountId,
      recordedField: "the live session record's own spawn config",
    });
    // A mismatch (an unbound environment account counts) refuses: this driver is handed a built
    // credential environment and cannot build another account's. Rebinding to the admitted account
    // happens above this seam, which supplies a resume spawn config built for it.
    const environmentAccountId = processContext.providerAccountId;
    if (requestedAccountId !== undefined && requestedAccountId !== environmentAccountId) {
      const environmentSource =
        existing === undefined
          ? `no live session record survives, so the only environment available is the node-wide default's, constructed for ${environmentAccountId ?? "no bound account"}`
          : `the live session record this resume relaunches from was established for ${environmentAccountId ?? "no bound account"}, so its environment is not that account's`;
      throw new CodexDriverConfigError(
        `ResumeSessionParams.providerAccountId names provider account ${requestedAccountId}, but ${environmentSource}; this driver is handed a constructed credential environment and cannot build another account's, so the relaunch is refused rather than spawned against an environment that bills elsewhere.`,
        "ResumeSessionParams.providerAccountId",
      );
    }
    const providerAccountId = environmentAccountId;
    return {
      cwd: processContext.cwd,
      env: processContext.env,
      ...(providerAccountId === undefined ? {} : { providerAccountId }),
      ...(credentialEnvPolicy === undefined ? {} : { credentialEnvPolicy }),
    };
  }

  /**
   * Answers which credential policy filters a spawned child; create and resume both call it, and a
   * new spawn path must too. No posture keeps the declared policy, `trusted` drops it, and an
   * unresolved sandboxed reference is refused rather than degraded to "deny nothing".
   */
  async #resolveCredentialEnvPolicyForPosture(
    declaredPolicy: CredentialEnvPolicy | undefined,
    posture: ExecutionPosture | undefined,
    postureRefusalField: string,
  ): Promise<CredentialEnvPolicy | undefined> {
    if (posture === undefined) {
      return declaredPolicy;
    }
    if (posture.mode === "trusted") {
      return undefined;
    }
    const resolved = await this.#options.resolveCredentialEnvPolicy(posture);
    if (resolved === undefined) {
      throw new CodexDriverConfigError(
        `The execution posture "${posture.mode}" carries a credential policy reference that resolved to no policy, so the spawned child cannot be filtered.`,
        postureRefusalField,
      );
    }
    return resolved;
  }

  async #establishResumedSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    // Read inside the claimed establishment, after any predecessor installed its record.
    const existing = this.#sessions.get(params.sessionId);
    const connection = new CodexAppServerConnection(this.#connectionOptionsFor(params.sessionId));
    try {
      // Composed inside the `try` so a posture refusal arrives as the typed `failed` result, not as
      // an exception out of `resumeSession`.
      const spawnConfig = await this.#composeResumeSpawnConfig(existing, params);
      await connection.open(spawnConfig);
      const response = await connection.request("thread/resume", {
        threadId: params.resumeHandle,
        // A resume is a fresh spawn, so the spawn-bound legs are re-realized; otherwise the
        // provider would apply caps reloaded from the thread's persisted config.
        ...this.#composeThreadEstablishmentLegs(params.executionPosture, params.subagentPolicy),
        // The same pin as `thread/start`: a resumed thread must not inherit an auto-review path.
        approvalsReviewer: "user",
      });
      const thread = readThread(response, "thread/resume");
      this.#assertPostureRealized(params.executionPosture, response);
      // Checked before the position: Codex may answer an unhonorable resume with a different
      // thread, and a zero-turn one has `turns: []`, like a genuine resume.
      if (thread.id !== params.resumeHandle) {
        throw new CodexTransportError(
          `Resume handle ${params.resumeHandle} was answered by thread ${thread.id}; the provider started a replacement thread rather than resuming.`,
          {
            method: "thread/resume",
            requestedThreadId: params.resumeHandle,
            answeredThreadId: thread.id,
          },
        );
      }
      if (!Array.isArray(thread.turns)) {
        // Populated on `thread/resume` by contract; a fabricated 0 would make a fresh thread look
        // resumed.
        throw new CodexTransportError(
          "The Codex app-server resume response carried no turn history, so the session position is unknown.",
          { threadId: thread.id },
        );
      }
      // Built and validated before the swap: the caller's minter can throw, and after the install
      // that would leave the session mapped to a closed connection.
      const resumedResult = DriverResumeResultSchema.parse({
        status: "resumed",
        bindingId: this.#newBindingId(),
        sessionPosition: thread.turns.length,
      });
      // Re-reported on resume: this leg offers the provider no callback-tool registry either.
      this.#reportWithheldCallbackTools(params.sessionId, params.callbackTools);
      this.#sessions.set(params.sessionId, {
        sessionId: params.sessionId,
        connection,
        threadId: thread.id,
        // Seeded from the thread's own history so a rewind indexes the same axis as before restart.
        turnBoundaries: readThreadTurnIds(thread.turns),
        executionPosture: params.executionPosture,
        subagentPolicy: params.subagentPolicy,
        spawnConfig,
        runIdByActiveTurnId: new Map(),
        unmatchedTurnEvidence: new Map(),
        inFlightTurnStarts: 0,
        settledTurnIds: new Set(),
        inFlightSteers: 0,
        interruptedRunIdByTurnId: new Map(),
      });
      // Discarded: the held enumeration is a read from the replaced process, and its
      // `skills/changed` cue would arrive on a dead connection.
      this.#discardProviderCommandEnumeration(params.sessionId);
      this.#runtimeBindingQuarantine.releaseSession(params.sessionId);
      // Bases at the daemon's prior-emitted sum: the provider's counter survives a resume, so a
      // zero base would re-meter the whole history onto the first turn.
      this.#bindSessionThread(params.sessionId, thread.id, {
        mode: "resume",
        priorEmittedThreadId: thread.id,
      });
      // Fails the predecessor's unsettled frames on their runs before routes are swept
      // (`#runIdForAbandonedFrame` reads `#sessionIdByRunId`). Not ruled swallowed, not dropped,
      // not quarantined: the runs keep their interrupt and intervention controls.
      this.#failSupersededDeliveries(existing, params.sessionId);
      // A compaction wait armed against the superseded leg can never get its evidence, so
      // `binding_lost` is owed now. Keyed on the superseded record's thread; no wait exists yet
      // against the replacement, as installation and this release are one synchronous run.
      if (existing !== undefined) {
        this.#pendingCompactions.releaseBinding(
          codexCompactionWaitKey(params.sessionId, existing.threadId),
        );
      }
      // Every route to the superseded leg is dead. Swept here because `closeSession` reads the live
      // record and would leak one entry per in-flight run per resume.
      this.#forgetRunRoutes(params.sessionId);
      // Usually a no-op, as `#failSupersededDeliveries` consumed the registrations; kept as the
      // budget release's one home.
      this.#releaseOutboundFrameBudget(params.sessionId);
      // Released after the install so a failed resume leaves the prior leg live.
      if (existing !== undefined) {
        await this.#releaseAbandonedConnection(existing.connection);
      }
      return resumedResult;
    } catch (cause) {
      // Classified before the release: it asks this connection whether the credential is still
      // good, and a refused resume leaves the transport open. The release is contained so its
      // fault cannot escape the typed result.
      const recoveryCondition = await classifyResumeRecoveryCondition(connection, cause);
      await this.#releaseAbandonedConnection(connection);
      return DriverResumeResultSchema.parse({
        status: "failed",
        recoveryCondition,
        // The driver saw a refused resume, not the span of work in flight; classifying that needs
        // run state it lacks.
        recoverySpanClassification: "unclassifiable",
        providerFailureDetail: normalizeProviderFailureDetail(cause),
      });
    }
  }

  /** Starts one provider turn for a run. */
  async startRun(params: StartRunParams): Promise<void> {
    const runConfig = parseCodexRunConfig(params.agentConfig);
    const record = this.#requireSession(runConfig.sessionId);
    const openingFrame = this.#composeRunOpeningFrame(params, runConfig);
    let turnId: string;
    // Raised until the answer is in hand: a terminal ingested by the synchronous read drain may
    // belong to the turn about to be named, so `rememberUnmatchedTurn` must not evict. Lowered in
    // a `finally` so a failed start cannot leak the count.
    record.inFlightTurnStarts += 1;
    try {
      turnId = readTurnId(
        await this.#requestTurnStart(record, runConfig, params, openingFrame),
        "turn/start",
      );
    } catch (cause) {
      // Dropped by frame, not key: nothing serializes two starts for one run, and a key-wide drop
      // would strand a concurrent attempt's frame so its turn passes uncorrelated. Safe here: the
      // reconcile proves the turn never started or kills the child (a steer's turn runs on).
      this.#outboundFrameTripwire.forgetFrame(openingFrame);
      // Classified before any teardown, as some dispositions need the live connection. Routing is
      // exhaustive over the shared classifier's union, not this leg's own error classes.
      const disposition = classifyProviderRequestFailure(
        observeCodexTurnStartFailure(cause),
      ).disposition;
      if (disposition === "permanent-structural-refusal") {
        // Condemned, not just torn down: the history was typed unacceptable, so only a fresh spawn
        // leads back. Session is quarantined first so a synchronous caller cannot resolve it.
        this.#runtimeBindingQuarantine.disposeSession(record.sessionId);
        this.#runtimeBindingQuarantine.disposeRun(params.runId, record.sessionId);
        await this.#disposeAmbiguousSession(record);
        throw new PermanentStructuralRefusalError({
          providerSessionId: record.threadId,
          runId: params.runId,
          cause,
        });
      }
      if (disposition === "reconcile-ambiguous-delivery") {
        await this.#settleAmbiguousTurnStart(record);
      }
      // `fail-consumed-and-declined` disposes nothing: the provider answered "no", so the session
      // stays usable. `retry-definitely-unsent` cannot occur, as `observeCodexTurnStartFailure`
      // never reports `unsent`; narrowing that needs a retry branch here.
      throw cause;
    } finally {
      record.inFlightTurnStarts -= 1;
    }
    // Frame-scoped like the drop above: the frame moves onto the key the terminal will carry, and
    // a key-wide re-key would drag a concurrent attempt's unnamed frame onto this turn.
    this.#outboundFrameTripwire.recorrelateFrame(openingFrame, turnId);
    // One synchronous run from here, so one slot check covers the install and the consume.
    if (!this.#stillHoldsSlot(record)) {
      // Reached only via a transition begun after dispatch. A failed supersede-resume leaves the
      // predecessor live, so the accepted turn would run with no route to interrupt it: dispose
      // unconditionally (idempotent) and refuse the run, which would strand a route no sweep
      // reaches.
      await this.#disposeAmbiguousSession(record);
      throw new CodexTransportError(
        `Codex session "${record.sessionId}" stopped holding its slot while a turn was starting.`,
        { sessionId: record.sessionId, method: "turn/start" },
      );
    }
    // A second accepted start on this run adds a route; the turn axis is never overwritten.
    record.runIdByActiveTurnId.set(turnId, params.runId);
    this.#sessionIdByRunId.set(params.runId, record.sessionId);
    // Appended at acceptance, not completion: a completion-time ledger would omit interrupted and
    // failed turns and misname later positions.
    record.turnBoundaries.push(turnId);
    // The turn can already be over: this continuation is a microtask while `#ingest` drains the
    // chunk synchronously, so the sweep may have matched nothing. The remembered evidence closes
    // that window and is replayed onto the re-keyed frame so the terminal is ruled here.
    const remembered = record.unmatchedTurnEvidence.get(turnId);
    if (remembered === undefined) {
      return;
    }
    record.unmatchedTurnEvidence.delete(turnId);
    for (const observation of remembered.observations) {
      this.#outboundFrameTripwire.observe(turnId, observation);
    }
    const rememberedTerminal = remembered.terminal;
    if (rememberedTerminal === undefined) {
      // In-flight evidence only: the turn is still running; its own terminal settles the frame.
      return;
    }
    this.#retireTurnRoute(record, turnId);
    const decision = this.#outboundFrameTripwire.settle(turnId, rememberedTerminal);
    if (!decision.tripped) {
      return;
    }
    this.#runtimeBindingQuarantine.disposeSession(record.sessionId);
    this.#runtimeBindingQuarantine.disposeRun(params.runId, record.sessionId);
    this.#reportTextNeutralizationFailure(
      record.sessionId,
      params.runId,
      composeTextNeutralizationRunFailure(decision),
    );
    this.#disposeQuarantinedSession(record);
  }

  /**
   * Settles an ambiguous `turn/start` by reading the thread's user-turn count back against
   * `turnBoundaries` (positional: a user may repeat words). The run fails on every arm;
   * `delivered` and `unrecoverable` dispose the session so no re-dispatch duplicates spend.
   */
  async #settleAmbiguousTurnStart(record: CodexSessionRecord): Promise<void> {
    await this.#ambiguousDeliveryReconciler.reconcileThenAct(
      {
        targetProviderSessionId: record.threadId,
        acknowledgedUserSends: record.turnBoundaries.length,
      },
      async (settlement) => {
        if (settlement.settlement === "cleared-for-retry") {
          return;
        }
        await this.#disposeAmbiguousSession(record);
      },
    );
  }

  /** The `turn/start` request itself, split out so `startRun` reads as its policy. */
  async #requestTurnStart(
    record: CodexSessionRecord,
    runConfig: CodexRunConfig,
    params: StartRunParams,
    openingFrame: OutboundTextFrame,
  ): Promise<unknown> {
    const turnStartParams: Record<string, unknown> = {
      threadId: record.threadId,
      // The bytes come off a frame this method cannot construct, so neutralization is on the
      // path; `runConfig.input` is unread on purpose: the author's text stays on the frame.
      input: [{ type: "text", text: openingFrame.wireText, text_elements: [] }],
      // The pin that carries the security property: `approvalsReviewer` on a turn overrides routing
      // for it and later turns, so a config-selected `auto_review` would otherwise win.
      // `turn/steer` creates no turn and needs none.
      approvalsReviewer: "user",
      // The run's posture wins and the session's spawn posture is the floor, so a turn never goes
      // out with no policy; both send the roots the thread-level selector cannot carry.
      ...this.#composeTurnPostureParams(record, params),
      ...(runConfig.model === undefined ? {} : { model: runConfig.model }),
      ...(runConfig.clientUserMessageId === undefined
        ? {}
        : { clientUserMessageId: runConfig.clientUserMessageId }),
      ...(params.outputSchema === undefined ? {} : { outputSchema: params.outputSchema }),
    };
    assertRealizedTurnPostureMembers(turnStartParams);
    return await record.connection.request("turn/start", turnStartParams, this.#turnStartTimeoutMs);
  }

  /**
   * Kills the child first, then releases the session, when a turn may be live with no route to it.
   * Scoped to the record, not the session id, so a resume that already superseded it is untouched.
   * There is no `thread/unsubscribe`: this connection's answers cannot be trusted.
   */
  async #disposeAmbiguousSession(record: CodexSessionRecord): Promise<void> {
    await this.#claimSessionSlot(record.sessionId, "closing", async () => {
      if (this.#sessions.get(record.sessionId) === record) {
        this.#sessions.delete(record.sessionId);
        // Rule before the sweeps, while the routes still exist: with the record dropped no
        // terminal is ingested, so pending frames become unrulable.
        this.#ruleAbandonedFramesFailClosed(record);
        this.#forgetRunRoutes(record.sessionId);
        // Covers the quarantine path too: `#disposeQuarantinedSession` delegates here.
        this.#pendingCompactions.releaseBinding(
          codexCompactionWaitKey(record.sessionId, record.threadId),
        );
        this.#discardProviderCommandEnumeration(record.sessionId);
        this.#releaseOutboundFrameBudget(record.sessionId);
      }
      try {
        await record.connection.killAndClose();
      } catch {
        // The caller is already throwing the typed cause; a teardown artifact must not displace it.
      }
    });
  }

  /**
   * Zero-turn authentication probe on its own child; claims no session slot. Never throws: any
   * unresolvable outcome becomes `indeterminate`, fail-closed for admission yet distinct from
   * `unauthenticated`.
   */
  async probeAuth(): Promise<DriverAuthProbeResult> {
    const connection = new CodexAppServerConnection(this.#probeConnectionOptions());
    try {
      await connection.open(this.#options.resumeSpawnConfig);
      return classifyCodexAuthStatus(
        await requestCodexAuthStatus(connection, CODEX_AUTH_PROBE_TIMEOUT_MS),
      );
    } catch (cause) {
      return buildAuthProbeResult("indeterminate", normalizeProviderFailureDetail(cause));
    } finally {
      // Contained so a teardown fault cannot displace the answer; `close()` is idempotent.
      await this.#releaseAbandonedConnection(connection);
    }
  }

  // Not `#connectionOptionsFor`: a probe's notifications must never enter a session's stream.
  #probeConnectionOptions(): CodexConnectionOptions {
    const reportDiagnostic = this.#options.reportDiagnostic;
    return {
      ...this.#options,
      onServerNotification: (method: string): void => {
        reportDiagnosticFromDetachedFrame(reportDiagnostic, {
          kind: "unconsumed-server-notification",
          method,
        });
      },
    };
  }

  /**
   * Interrupts the provider turn bound to a run and retires its route, so a later steer or second
   * interrupt is refused. The turn correlation is retained for the `turn/completed` that follows.
   */
  async interruptRun(params: InterruptRunParams): Promise<void> {
    const { record, turnId } = this.#requireActiveTurn(params.runId);
    await record.connection.request("turn/interrupt", {
      threadId: record.threadId,
      turnId,
    });
    // A settled turn's terminal was already ruled; retaining it would leave an entry nothing
    // releases.
    if (!record.settledTurnIds.has(turnId)) {
      if (!rememberInterruptedRun(record, turnId, params.runId)) {
        // The interrupt succeeded, so this resolves; quarantining rules the pending frame
        // fail-closed and the run hears `run.failed`.
        this.#refuseUnretainableInterruptedRoute(record);
        return;
      }
    }
    // Retires this turn's route only; a run holding a second live turn keeps that route.
    this.#retireTurnRoute(record, turnId);
  }

  /**
   * Forks the thread at a recorded turn boundary, re-points the session at the fork and returns a
   * fresh `bindingId`; files on disk are not restored. Degrades on a live turn or an unknown
   * position, and refuses when the build lacks the boundary member
   * ({@link CodexRewindBoundaryUnsupportedError}).
   */
  async forkConversation(params: ForkConversationParams): Promise<ForkConversationResult> {
    // Read before the claim: `#requireSession` refuses while the slot is `establishing`.
    const record = this.#requireSession(params.sessionId);
    if (record.runIdByActiveTurnId.size > 0) {
      // The provider refuses to fork through a live turn; answer locally with a typed result.
      return ForkConversationResultSchema.parse({
        status: "degraded",
        fallbackAction: "rewind-deferred-turn-in-progress",
      });
    }
    // Position 0 must not become an omitted `lastTurnId`, which forks the whole thread.
    const boundaryTurnId =
      params.position >= 1 ? record.turnBoundaries[params.position - 1] : undefined;
    if (boundaryTurnId === undefined) {
      return ForkConversationResultSchema.parse({
        status: "degraded",
        fallbackAction: "rewind-target-not-a-recorded-boundary",
      });
    }
    // Held across the fork: a `startRun` meanwhile would register on the pre-fork thread and its
    // frames would be shed, and two rewinds would both report `applied`. `establishing` because a
    // fork mints the thread the session continues on; the entrance refuses turns in that state.
    return await this.#claimSessionSlot(
      params.sessionId,
      "establishing",
      async () => await this.#establishRewoundSession(params, record, boundaryTurnId),
    );
  }

  async #establishRewoundSession(
    params: ForkConversationParams,
    record: CodexSessionRecord,
    boundaryTurnId: string,
  ): Promise<ForkConversationResult> {
    // One read of the mutable field: both the fork source and the usage-base key.
    const preForkThreadId = record.threadId;
    // Wraps the dispatch alone: a malformed result from `readThread` is not a missing capability.
    let response: unknown;
    try {
      response = await record.connection.request("thread/fork", {
        threadId: preForkThreadId,
        lastTurnId: boundaryTurnId,
        // A new thread must re-realize the posture and caps, as a resume does.
        ...this.#composeThreadEstablishmentLegs(record.executionPosture, record.subagentPolicy),
        approvalsReviewer: "user",
      });
    } catch (cause) {
      // A build without `ThreadForkParams.lastTurnId` becomes `driver.capability_unsupported`;
      // any other failure is rethrown as it arrived. Nothing has mutated yet.
      throw classifyRewindForkFailure(cause);
    }
    const forkedThread = readThread(response, "thread/fork");
    this.#assertPostureRealized(record.executionPosture, response);
    // Answering with the thread it was handed means no fork happened; adopting it would report
    // `applied` with no surviving pre-rewind thread.
    if (forkedThread.id === preForkThreadId) {
      return ForkConversationResultSchema.parse({
        status: "degraded",
        fallbackAction: "rewind-not-forked",
      });
    }
    // A thread this session already meters would have its spend registers reset. Ordered after the
    // fork check because the pre-fork thread is itself registered.
    if (this.usageAccountantFor(params.sessionId).hasThread(forkedThread.id)) {
      return ForkConversationResultSchema.parse({
        status: "degraded",
        fallbackAction: "rewind-target-thread-already-registered",
      });
    }
    // Re-read after the await, before the first mutation; rebinding under a live turn would strand
    // the turn.
    if (record.runIdByActiveTurnId.size > 0) {
      return ForkConversationResultSchema.parse({
        status: "degraded",
        fallbackAction: "rewind-deferred-turn-in-progress",
      });
    }
    record.threadId = forkedThread.id;
    // The routing and metering band moves with the record. Based like a resume on the pre-fork
    // thread, the only key the earlier spend exists under. The wire reference does not say whether
    // the counter continues across a fork: if it restarts, the decrease floor gives loud
    // under-metering, whereas `fresh` would silently double-count.
    this.#bindSessionThread(params.sessionId, forkedThread.id, {
      mode: "resume",
      priorEmittedThreadId: preForkThreadId,
    });
    // The router retires the old thread in the registration above; the accountant holds one set
    // per thread. Released only after the successor exists, so a refused fork can still meter.
    this.usageAccountantFor(params.sessionId).releaseThread(preForkThreadId);
    // Compaction waits on the predecessor settle `binding_lost`, their honest terminal.
    this.#pendingCompactions.releaseBinding(
      codexCompactionWaitKey(params.sessionId, preForkThreadId),
    );
    const forkedTurnIds = readThreadTurnIds(forkedThread.turns);
    // An absent or unreadable turn list reads as zero turns, which also disagrees.
    if (forkedTurnIds.length !== params.position) {
      reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
        kind: "fork-turn-ledger-unconfirmed",
        expectedTurnCount: params.position,
        confirmedTurnCount: forkedTurnIds.length,
      });
    }
    if (forkedTurnIds.length > 0) {
      // The provider's account of the forked history wins over the local ordinal.
      record.turnBoundaries.splice(0, record.turnBoundaries.length, ...forkedTurnIds);
    } else {
      record.turnBoundaries.length = params.position;
    }
    return ForkConversationResultSchema.parse({
      status: "applied",
      sessionPosition: params.position,
      bindingId: this.#newBindingId(),
    });
  }

  /**
   * Binds the session's goal on the provider natively. Only `objective` is sent; `status` and
   * `tokenBudget` are provider-side state the daemon does not own.
   */
  async setSessionGoal(params: SetSessionGoalParams): Promise<void> {
    const record = this.#requireSession(params.sessionId);
    await record.connection.request("thread/goal/set", {
      threadId: record.threadId,
      objective: params.goalText,
    });
  }

  /** Clears the session's goal natively; a `cleared: false` answer still resolves. */
  async clearSessionGoal(params: ClearSessionGoalParams): Promise<void> {
    const record = this.#requireSession(params.sessionId);
    await record.connection.request("thread/goal/clear", { threadId: record.threadId });
  }

  /**
   * Triggers a native context compaction and settles on the `thread/compacted` frame, not on the
   * request's empty acknowledgement. The wait is armed before dispatch so an early frame is seen.
   * Never returns `refused`; the daemon's gates answer that before any driver is called.
   */
  async compactContext(params: CompactContextParams): Promise<DriverCompactionResult> {
    const record = this.#requireSession(params.sessionId);
    const wait = this.#pendingCompactions.arm(
      codexCompactionWaitKey(params.sessionId, record.threadId),
      CODEX_COMPACTION_WAIT_MS,
    );
    try {
      await record.connection.request(CODEX_THREAD_COMPACT_START_METHOD, {
        threadId: record.threadId,
      });
    } catch (cause) {
      wait.abandon();
      this.#options.diagnostics.emit({
        provider: CODEX_DRIVER_NAME,
        kind: "compaction_wait_terminal",
        rawWireType: CODEX_THREAD_COMPACT_START_METHOD,
        dispositionReason: normalizeProviderFailureDetail(cause),
        details: { sessionId: params.sessionId, terminal: "provider_error" },
      });
      return { status: "failed", reason: "provider_error" };
    }
    const settlement = await wait.settled;
    if (settlement.terminal === "observed") {
      return { status: "applied", boundaryPosition: settlement.boundaryPosition };
    }
    this.#options.diagnostics.emit({
      provider: CODEX_DRIVER_NAME,
      kind: "compaction_wait_terminal",
      rawWireType: CODEX_THREAD_COMPACT_START_METHOD,
      dispositionReason:
        settlement.terminal === "wait_expired"
          ? "the declared compaction bound elapsed with no typed compaction frame; a later frame still normalizes into its boundary row"
          : "the binding stopped being live before a typed compaction frame arrived",
      details: {
        sessionId: params.sessionId,
        terminal: settlement.terminal,
        declaredBoundMs: CODEX_COMPACTION_WAIT_MS,
      },
    });
    return { status: "failed", reason: settlement.terminal };
  }

  /**
   * Reconstitutes the transcript into a fresh session, one `thread/inject_items` request per frame
   * so a failure leaves a known applied prefix, and returns only after the readback confirms it.
   * Every failure abandons the target ({@link ReplayTargetLedger}) and throws; a frame this leg
   * cannot represent is refused, never skipped, so `applied` carries no losses.
   */
  async replayTranscript(params: ReplayTranscriptParams): Promise<DriverTranscriptReplayResult> {
    const targetProviderSessionId: string = params.target.providerSessionId;
    this.#replayTargets.assertUsable(targetProviderSessionId);

    const record: CodexSessionRecord = this.#requireReplayTargetRecord(params.target);

    // A non-empty turn ledger proves the target already held a conversation.
    if (record.turnBoundaries.length > 0) {
      this.#abandonReplayTarget(record, targetProviderSessionId, "target-not-fresh");
      throw new CodexTransportError(
        `Refusing to replay into Codex thread "${record.threadId}": it already holds ${String(record.turnBoundaries.length)} turn(s), and a replay target must be fresh.`,
        { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
      );
    }

    const seeded: SeededTranscriptFrame[] = [];
    for (const frame of params.frames) {
      // Fail closed before any write: a skipped frame would falsify the empty loss list.
      seeded.push(readRenderedTranscriptFrameForReplay(frame));
    }
    if (seeded.length === 0) {
      throw new CodexTransportError(
        "Refusing to replay an empty transcript into a Codex thread: there is nothing to reconstitute, and a post-replay assertion over no frames confirms nothing.",
        { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
      );
    }

    for (const frame of seeded) {
      const attempt: CodexRequestAttempt = await record.connection.attemptRequest(
        CODEX_THREAD_INJECT_ITEMS_METHOD,
        { threadId: record.threadId, items: [codexResponsesItemForFrame(frame)] },
      );
      if (attempt.settled === "answered") {
        continue;
      }
      // `indeterminate` (bytes left, arrival unknowable) must not be recorded as a refusal.
      const cause: ReplayTargetAbandonmentCause =
        attempt.delivery === "indeterminate" ? "ambiguous-delivery" : "interior-refusal";
      this.#abandonReplayTarget(record, targetProviderSessionId, cause);
      throw new CodexTransportError(
        `Codex replay seeding stopped at transcript position ${String(frame.position)} (${attempt.delivery}); the target was abandoned and must not be reused.`,
        { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
      );
    }

    const readReadback: ReplayTargetReadbackReader | undefined =
      this.#options.transcriptReplayReadback;
    if (readReadback === undefined) {
      // Answered seeding calls are not proof; without a readback a discarded seed looks faithful.
      this.#abandonReplayTarget(record, targetProviderSessionId, "readback-unavailable");
      throw new CodexTransportError(
        `Codex replay into thread "${record.threadId}" seeded ${String(seeded.length)} frame(s) but no target-readback reader is bound, so the post-replay assertion cannot run; the target was abandoned.`,
        { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
      );
    }

    let readback: ReplayTargetReadback;
    try {
      readback = await readReadback(targetProviderSessionId);
    } catch (error: unknown) {
      // A rejecting reader is the `unreadable` arm of the readback contract.
      readback = {
        kind: "unreadable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    const verdict: PostReplayVerdict = assertReplayReconstituted(seeded, readback);
    if (verdict.outcome === "refuted") {
      const cause: ReplayTargetAbandonmentCause =
        verdict.refutation === "target-unreadable" ? "readback-unavailable" : "assertion-refuted";
      this.#abandonReplayTarget(record, targetProviderSessionId, cause);
      throw new PostReplayAssertionFailedError(targetProviderSessionId, seeded.length, verdict);
    }

    // Retired on success too: `thread/inject_items` leaves `turnBoundaries` empty, so the
    // freshness gate would not stop a second seeding through the same handle.
    this.#replayTargets.consume(targetProviderSessionId);

    return { status: "applied", declaredLosses: [] };
  }

  /** Finds the record whose current thread id is the handle's `resumeHandle`; a miss throws. */
  #requireReplayTargetRecord(target: ProviderSessionHandle): CodexSessionRecord {
    for (const record of this.#sessions.values()) {
      if (record.threadId === target.resumeHandle) {
        return record;
      }
    }
    throw new CodexTransportError(
      `No live Codex session is bound to replay target thread "${target.resumeHandle}".`,
      { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
    );
  }

  /**
   * Records the abandonment first, so the target is unusable even if disposal fails, then closes
   * its process. A disposal failure stays in `#sessions` and is swallowed: the caller is throwing.
   */
  #abandonReplayTarget(
    record: CodexSessionRecord,
    targetProviderSessionId: string,
    cause: ReplayTargetAbandonmentCause,
  ): void {
    this.#replayTargets.abandon(targetProviderSessionId, cause);
    void this.closeSession({ sessionId: record.sessionId }).catch(() => {
      // The caller is already throwing the replay error.
    });
  }

  /**
   * Enumerates the provider's command and skill surface, held for the session's life until
   * `skills/changed` discards it. The entry cap trims the reply, not the held list
   * (`complete: false` marks a trimmed tail); `runId` is the sole live run or `null`.
   */
  async listProviderCommands(
    params: ListProviderCommandsParams,
  ): Promise<ProviderCommandListResult> {
    const record = this.#requireSession(params.sessionId);
    const providerAccountId = record.spawnConfig.providerAccountId ?? null;
    const held = await this.#heldProviderCommandsFor(params.sessionId, record, providerAccountId);
    const complete = held.length <= DRIVER_PROVIDER_COMMAND_ENTRIES_MAX;
    const entries = complete ? [...held] : held.slice(0, DRIVER_PROVIDER_COMMAND_ENTRIES_MAX);
    if (!complete) {
      this.#options.diagnostics.emit({
        provider: CODEX_DRIVER_NAME,
        kind: "provider_command_entries_truncated",
        rawWireType: CODEX_SKILLS_LIST_METHOD,
        dispositionReason:
          "the provider published more entries than the wire-and-render cap admits; the reply's tail was dropped and the driver's held enumeration was left whole",
        details: {
          sessionId: params.sessionId,
          heldCount: held.length,
          returnedCount: entries.length,
        },
      });
    }
    return {
      bindings: [
        {
          // From this read's record, not by session id: a resume landing mid-request must not
          // stamp the successor's run here.
          runId: soleActiveRunIdIn(record),
          binding: { driverName: CODEX_DRIVER_NAME, providerAccountId },
          entries,
          complete,
        },
      ],
    };
  }

  /**
   * The held enumeration, read from the provider if absent. The epoch captured before the request
   * is re-checked before storing, so an invalidation mid-flight leaves the reading uncached.
   */
  async #heldProviderCommandsFor(
    sessionId: SessionId,
    record: CodexSessionRecord,
    providerAccountId: string | null,
  ): Promise<readonly ProviderCommandEntry[]> {
    const held = this.#providerCommandEnumerations.get(sessionId);
    if (held !== undefined) {
      return held;
    }
    const readEpoch = this.#providerCommandEnumerationEpochFor(sessionId);
    const response = await record.connection.request(CODEX_SKILLS_LIST_METHOD, {});
    const reading = readCodexProviderCommandEntries(response, providerAccountId);
    for (const rejection of reading.rejections) {
      this.#reportProviderCommandEntryRejected(sessionId, rejection);
    }
    if (this.#providerCommandEnumerationEpochs.get(sessionId) === readEpoch) {
      this.#providerCommandEnumerations.set(sessionId, reading.entries);
    }
    return reading.entries;
  }

  /**
   * Reports a field the contract's bounds refused; absence is a positive claim, so a silent drop
   * would misstate the provider. Only lengths are carried, never the refused value.
   */
  #reportProviderCommandEntryRejected(
    sessionId: SessionId,
    rejection: CodexProviderCommandRejection,
  ): void {
    this.#options.diagnostics.emit({
      provider: CODEX_DRIVER_NAME,
      kind: "provider_command_entry_rejected",
      rawWireType: CODEX_SKILLS_LIST_METHOD,
      dispositionReason: rejection.dropped
        ? "the provider published a command or skill entry the contract's own bounds refuse; it is dropped from this reply and its siblings are unaffected"
        : "the provider declared a command or skill field the contract's own bounds refuse; the entry is kept and the field reads ABSENT, which on this contract means the provider declared none",
      details: {
        sessionId,
        entryKind: "skill",
        rejectedField: rejection.rejectedField,
        dropped: rejection.dropped,
        nameLength: rejection.nameLength,
        rejectedValueLength: rejection.rejectedValueLength,
      },
    });
  }

  #providerCommandEnumerationEpochFor(sessionId: SessionId): symbol {
    const current = this.#providerCommandEnumerationEpochs.get(sessionId);
    if (current !== undefined) {
      return current;
    }
    const minted = Symbol("codex-provider-command-enumeration");
    this.#providerCommandEnumerationEpochs.set(sessionId, minted);
    return minted;
  }

  /** Clears list and epoch together; deleting the epoch fails an in-flight read's re-check. */
  #discardProviderCommandEnumeration(sessionId: SessionId): void {
    this.#providerCommandEnumerations.delete(sessionId);
    this.#providerCommandEnumerationEpochs.delete(sessionId);
  }

  /** Unsubscribes and tears down the process. Idempotent: an unknown session resolves. */
  async closeSession(params: CloseSessionParams): Promise<void> {
    // Claiming a free slot would refuse a concurrent create, hence the early return. A close during
    // establishment chains behind it. The latch comes first so every later terminal counts as
    // clean.
    this.#intendedCloseGateFor(params.sessionId).signalIntendedClose();
    if (this.#describeSlotHolder(params.sessionId) === undefined) {
      // No session: drop the latch just set rather than accumulate one per redundant close.
      this.#terminalEmissionGates.delete(params.sessionId);
      this.#frameRouters.delete(params.sessionId);
      this.#usageAccountants.delete(params.sessionId);
      this.#discardProviderCommandEnumeration(params.sessionId);
      return;
    }
    await this.#claimSessionSlot(params.sessionId, "closing", async () => {
      await this.#tearDownSession(params.sessionId);
    });
    // After teardown: a terminal it provokes must still find the latch set.
    this.#terminalEmissionGates.delete(params.sessionId);
    this.#frameRouters.delete(params.sessionId);
    this.#usageAccountants.delete(params.sessionId);
    this.#discardProviderCommandEnumeration(params.sessionId);
  }

  /**
   * The terminal-emission gate, which stamps `intendedClose` and suppresses a duplicate terminal
   * per `(runId, runVersion)`. Read live at each terminal, never captured.
   */
  terminalEmissionGateFor(sessionId: SessionId): CodexTerminalEmissionGate {
    return this.#intendedCloseGateFor(sessionId);
  }

  /** The thread-frame router for one session; read live so a widened thread set is seen. */
  frameRouterFor(sessionId: SessionId): ThreadFrameRouter<CodexRoutableFrame> {
    const existing = this.#frameRouters.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const router = new ThreadFrameRouter<CodexRoutableFrame>({
      provider: "codex",
      diagnostics: this.#options.diagnostics,
      config: CODEX_THREAD_FRAME_ROUTER_CONFIG,
    });
    this.#frameRouters.set(sessionId, router);
    return router;
  }

  /** The usage-delta accountant for one session. */
  usageAccountantFor(sessionId: SessionId): UsageDeltaAccountant {
    const existing = this.#usageAccountants.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const accountant = new UsageDeltaAccountant({
      provider: "codex",
      diagnostics: this.#options.diagnostics,
    });
    this.#usageAccountants.set(sessionId, accountant);
    return accountant;
  }

  /**
   * Binds the session's thread into the routing and metering band at every establishment. Base
   * registers come first because a released usage frame meters immediately. Registering
   * overwrites the router's session-thread identity, which is how a rewind retires the old thread.
   */
  #bindSessionThread(
    sessionId: SessionId,
    threadId: string,
    establishment: CodexUsageEstablishment,
  ): void {
    const accountant = this.usageAccountantFor(sessionId);
    if (establishment.mode === "fresh") {
      accountant.establishThread(threadId, { mode: "fresh" });
    } else {
      const priorEmittedCumulative = this.#readPriorEmittedSum(
        sessionId,
        threadId,
        establishment.priorEmittedThreadId,
      );
      accountant.establishThread(threadId, {
        mode: "resume",
        priorEmittedCumulative: priorEmittedCumulative ?? {},
      });
    }
    const releasedFrames = this.frameRouterFor(sessionId).registerSessionThread(threadId);
    this.#deliverRoutedFrames(sessionId, releasedFrames);
  }

  /**
   * Reads the daemon's prior-emitted cumulative sum, reporting only a missing or throwing reader
   * (`undefined` is correct for a session that emitted nothing). The throw is contained because the
   * base is telemetry and must not fail an already-applied fork or resume.
   */
  #readPriorEmittedSum(
    sessionId: SessionId,
    threadId: string,
    priorEmittedThreadId: string,
  ): CumulativeAxisReadings | undefined {
    const reader = this.#options.readPriorEmittedUsage;
    if (reader === undefined) {
      this.#emitResumeBaseUnavailable(
        sessionId,
        threadId,
        priorEmittedThreadId,
        "no prior-emitted usage reader is bound, so the daemon's own emitted sum could not be rebuilt; base registers start at zero, so the first reading meters already-emitted spend again",
      );
      return undefined;
    }
    try {
      return reader(sessionId, priorEmittedThreadId);
    } catch (cause) {
      this.#emitResumeBaseUnavailable(
        sessionId,
        threadId,
        priorEmittedThreadId,
        `the prior-emitted usage reader failed, so the daemon's own emitted sum could not be rebuilt (${normalizeProviderFailureDetail(cause)}); base registers start at zero, so the first reading meters already-emitted spend again`,
      );
      return undefined;
    }
  }

  // On a rewind the two thread ids differ: the sum is under the pre-fork thread, the registers
  // belong to the forked one.
  #emitResumeBaseUnavailable(
    sessionId: SessionId,
    threadId: string,
    priorEmittedThreadId: string,
    dispositionReason: string,
  ): void {
    this.#options.diagnostics.emit({
      provider: "codex",
      kind: "usage_resume_base_unavailable",
      rawWireType: null,
      dispositionReason,
      details: { sessionId, threadId, priorEmittedThreadId },
    });
  }

  /**
   * Routes one inbound notification and delivers what it releases. Must not throw: it runs inside
   * the transport's `#ingest` drain. A child is registered before its announcement is routed.
   */
  #routeInboundNotification(sessionId: SessionId, method: string, params: unknown): void {
    const router = this.frameRouterFor(sessionId);
    if (method === CODEX_THREAD_STARTED_METHOD) {
      const announcement = readCodexChildThreadAnnouncement(params);
      if (announcement !== null) {
        const registration = router.registerChildThread(announcement);
        if (registration.registered) {
          const accountant = this.usageAccountantFor(sessionId);
          if (accountant.hasThread(registration.childThreadId)) {
            // Re-establishing would zero the register and re-meter reported spend, and a second
            // `subagent.started` would duplicate a timeline entry.
            this.#options.diagnostics.emit({
              provider: "codex",
              kind: "thread_duplicate_child_announcement",
              rawWireType: method,
              dispositionReason:
                "duplicate child-thread announcement for an already-registered child; usage base retained and no second started emission",
              details: { sessionId, childThreadId: registration.childThreadId },
            });
          } else {
            accountant.establishThread(registration.childThreadId, { mode: "fresh" });
            // A provider-internal child (a compaction thread) has no subagent identity.
            if (registration.attribution.kind === "subagent") {
              this.#options.onSubagentLifecycle?.(sessionId, {
                eventType: "subagent.started",
                subagentId: registration.attribution.subagentId,
                parentReference: announcement.declaredParentThreadId,
              });
            }
          }
          this.#deliverRoutedFrames(sessionId, registration.releasedFrames);
        }
      }
    }

    const frame: CodexRoutableFrame = {
      rawWireType: method,
      familyClass: classifyCodexFrameFamilyForRouting(method),
      threadId: readCodexFrameThreadId(method, params),
      params,
    };
    this.#deliverRoutedFrames(sessionId, [frame]);
  }

  /**
   * Applies the router's decision to each frame. A child's usage still meters and its interactive
   * request still routes, though its transcript never projects.
   */
  #deliverRoutedFrames(sessionId: SessionId, frames: readonly CodexRoutableFrame[]): void {
    const router = this.frameRouterFor(sessionId);
    const nowMs = Date.now();
    for (const frame of frames) {
      const route = router.routeFrame(frame, nowMs);
      this.#applyRouteDecision(sessionId, frame, route);
    }
  }

  #applyRouteDecision(
    sessionId: SessionId,
    frame: CodexRoutableFrame,
    route: ThreadFrameRoute,
  ): void {
    switch (route.decision) {
      case "project":
      case "route-connection-scoped":
        // Metering first, so the normalize band never forwards a cumulative counter as per-turn.
        this.#meterUsageFrame(sessionId, frame);
        this.#observeCompactionBoundary(sessionId, frame);
        this.#completeChildOnTerminal(sessionId, frame);
        this.#handOffToNormalizeBand(frame);
        return;
      case "carve-out-usage":
        this.#meterUsageFrame(sessionId, frame);
        return;
      case "carve-out-interactive-request":
        // Same pipeline as the parent's, on the child's own correlation identity; suppressing it
        // would hang the child.
        this.#handOffToNormalizeBand(frame);
        return;
      case "suppress-child-transcript":
        this.#completeChildOnTerminal(sessionId, frame);
        return;
      case "held-pending-registration":
      case "quarantined":
        // The router already recorded both as diagnostics.
        return;
    }
  }

  /**
   * Settles a pending compaction wait on `thread/compacted`, beside the normalize hand-off so the
   * boundary row is still produced. Keyed on the frame's own thread id, not the record's, which
   * has moved to the successor at a rewind; an unarmed key is a no-op.
   */
  #observeCompactionBoundary(sessionId: SessionId, frame: CodexRoutableFrame): void {
    if (frame.rawWireType !== CODEX_THREAD_COMPACTED_METHOD || frame.threadId === null) {
      return;
    }
    this.#pendingCompactions.observeBoundary(
      codexCompactionWaitKey(sessionId, frame.threadId),
      readCodexCompactionBoundaryPosition(frame.params),
    );
  }

  #meterUsageFrame(sessionId: SessionId, frame: CodexRoutableFrame): void {
    if (frame.rawWireType !== CODEX_THREAD_TOKEN_USAGE_METHOD) {
      return;
    }
    const reading = readCodexCumulativeUsageReading(frame.params);
    if (reading === null) {
      // A silent drop is spend that never reaches a receipt.
      this.#options.diagnostics.emit({
        provider: "codex",
        kind: "usage_axis_reading_rejected",
        rawWireType: frame.rawWireType,
        dispositionReason:
          "the provider's token-usage notification carried no readable cumulative breakdown at the pinned payload shape; nothing was metered for this reading",
        details: { sessionId, threadId: frame.threadId },
      });
      return;
    }
    const metered = this.usageAccountantFor(sessionId).meterReading(reading);
    if (metered !== null) {
      this.#options.onMeteredUsage?.(sessionId, metered);
    }
  }

  /**
   * Releases a child's router state on its `turn/completed` with a terminal `turn.status`.
   * `thread/status/changed` has no terminal arm, and `thread/closed` is left unclassified because
   * nothing shows the app-server emits it for subagent threads.
   */
  #completeChildOnTerminal(sessionId: SessionId, frame: CodexRoutableFrame): void {
    if (frame.rawWireType !== CODEX_TURN_COMPLETED_METHOD || frame.threadId === null) {
      return;
    }
    if (!readCodexTerminalTurnStatus(frame.params)) {
      return;
    }
    const attribution = this.frameRouterFor(sessionId).childAttributionFor(frame.threadId);
    const completion = this.frameRouterFor(sessionId).completeChildThread(frame.threadId);
    if (!completion.wasRegistered) {
      return;
    }
    this.usageAccountantFor(sessionId).releaseThread(frame.threadId);
    if (attribution?.kind === "subagent") {
      this.#options.onSubagentLifecycle?.(sessionId, {
        eventType: "subagent.completed",
        subagentId: attribution.subagentId,
        parentReference: null,
      });
    }
  }

  #handOffToNormalizeBand(frame: CodexRoutableFrame): void {
    const delegate = this.#options.onServerNotification;
    if (delegate === undefined) {
      reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
        kind: "unconsumed-server-notification",
        method: frame.rawWireType,
      });
      return;
    }
    try {
      delegate(frame.rawWireType, frame.params);
    } catch (cause) {
      // Guarded here so this class does not depend on the transport's own containment.
      reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
        kind: "notification-consumer-failed",
        method: frame.rawWireType,
        detail: normalizeProviderFailureDetail(cause),
      });
    }
  }

  // Get-or-create, so the latch survives whichever of close and establishment comes first.
  #intendedCloseGateFor(sessionId: SessionId): CodexTerminalEmissionGate {
    const existing = this.#terminalEmissionGates.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const gate = new CodexTerminalEmissionGate();
    this.#terminalEmissionGates.set(sessionId, gate);
    return gate;
  }

  /**
   * Graceful teardown inside a claimed slot. The record is deleted in a `finally`: deleting first
   * would let a create spawn into the slot, and only on success would leave it permanently stuck.
   */
  async #tearDownSession(sessionId: SessionId): Promise<void> {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      // The establishment this close chained behind failed and released its connection.
      return;
    }
    // Dropped up front so `hasActiveTurn` stops reporting a live run once teardown begins.
    this.#forgetRunRoutes(sessionId);
    try {
      if (!record.connection.isClosed) {
        try {
          // Best effort and bounded: a refusal or a wedged provider must not block teardown.
          await record.connection.request(
            "thread/unsubscribe",
            { threadId: record.threadId },
            UNSUBSCRIBE_TIMEOUT_MS,
          );
        } catch {
          /* teardown proceeds */
        }
      }
      await record.connection.close();
    } finally {
      this.#sessions.delete(sessionId);
      // In the `finally` so a teardown that threw still releases the compaction waiters.
      this.#pendingCompactions.releaseBinding(codexCompactionWaitKey(sessionId, record.threadId));
      this.#discardProviderCommandEnumeration(sessionId);
      // After the record delete: a turn terminating mid-teardown must still be ingested and ruled.
      this.#releaseOutboundFrameBudget(sessionId);
    }
  }

  /** Steers the run's active turn; the intervention dispatcher routes steers here. */
  async steerRun(request: CodexSteerRunRequest): Promise<CodexSteerAcknowledgement> {
    const { record, turnId } = this.#requireActiveTurn(request.runId);
    // A caller-supplied expectation wins, so the provider refuses a stale steer rather than
    // retargeting it; kept local because the dispatcher grades against what went on the wire.
    const targetedTurnId = request.expectedTurnId ?? turnId;
    // Registered against the targeted turn: a steer joins an existing turn and is never re-keyed.
    const steerFrame = this.#outboundTextFrameWriter.compose({
      text: request.content,
      origin: request.frameOrigin,
    });
    // Refuses before the write: a steer the tripwire cannot watch could be swallowed invisibly.
    this.#outboundFrameTripwire.register({
      scopeKey: record.sessionId,
      joinKey: targetedTurnId,
      // No stream item vouches for a steer; it is consumed on its own request's answer.
      frameRole: "turn-joining",
      frame: steerFrame,
    });
    // Pins the settled-turn memory across the whole round trip, acknowledgement read included.
    record.inFlightSteers += 1;
    try {
      const attempt = await this.#requestTurnSteer(record, request, steerFrame, targetedTurnId);
      if (attempt.settled === "answered") {
        const acknowledgedTurnId = readSteeredTurnId(attempt.result);
        // The answer proves the provider took the frame; stream items credit only the opening
        // frame, so without this every steer would trip a healthy session. Also for a null ack.
        this.#outboundFrameTripwire.recordRequestAnswered(steerFrame);
        if (acknowledgedTurnId !== null && acknowledgedTurnId !== targetedTurnId) {
          // The provider says where the bytes went, so the frame follows the acknowledged turn;
          // left on the wrong turn it would trip a turn that swallowed nothing. A settled turn
          // emits no second terminal, so its frame is consumed on its recorded acknowledgment.
          if (this.#canStillRuleFrameOnTurn(record, acknowledgedTurnId)) {
            this.#outboundFrameTripwire.recorrelateFrame(steerFrame, acknowledgedTurnId);
          } else {
            this.#consumeAnsweredSteerFrame(record, request.runId, steerFrame);
          }
        }
        return { targetedTurnId, acknowledgedTurnId };
      }
      this.#ruleFailedSteerFrame(record, request.runId, steerFrame, attempt.delivery);
      throw attempt.cause;
    } finally {
      record.inFlightSteers -= 1;
    }
  }

  /**
   * Decides what a failed steer's frame is owed by how far its bytes got. One that never reached
   * the wire is forgotten; one handed to the host is retained for the turn's terminal to rule,
   * and a dead connection rules it here, fail-closed. A connection that dies later leaves it to
   * scope release, since ruling there would false-trip clean shutdowns.
   */
  #ruleFailedSteerFrame(
    record: CodexSessionRecord,
    runId: RunId,
    steerFrame: OutboundTextFrame,
    delivery: CodexRequestDelivery,
  ): void {
    if (delivery !== "indeterminate") {
      // `unsent` never left and `refused` is a provider answer, so nothing was swallowed.
      this.#outboundFrameTripwire.forgetFrame(steerFrame);
      return;
    }
    if (!record.connection.isClosed) {
      return;
    }
    this.#ruleSteerFrameFailClosed(record, runId, steerFrame);
  }

  /**
   * Rules one steer frame fail-closed when its response phase died with the connection, so no
   * terminal will ever rule it. Frame-scoped: settling the whole turn would trip the opening
   * frame, whose delivery was never in doubt. A frame already consumed settles as
   * `no-correlated-frame`.
   */
  #ruleSteerFrameFailClosed(
    record: CodexSessionRecord,
    runId: RunId,
    steerFrame: OutboundTextFrame,
  ): void {
    const decision = this.#outboundFrameTripwire.settleFrame(
      steerFrame,
      UNRECOGNIZED_TURN_EVIDENCE,
    );
    if (!decision.tripped) {
      return;
    }
    // The settlement path's disposal, session arm first, so a consumer reacting synchronously to
    // the run failure cannot attach to the condemned process.
    this.#runtimeBindingQuarantine.disposeSession(record.sessionId);
    this.#ruleTurnTerminalAgainstRun(record.sessionId, runId, decision);
    this.#disposeQuarantinedSession(record);
  }

  /**
   * Consumes a steer's frame on its own answered request when no terminal can rule the
   * acknowledged turn. The expected outcome is a pass, but a trip is handled with the full
   * disposal, not dropped.
   */
  #consumeAnsweredSteerFrame(
    record: CodexSessionRecord,
    runId: RunId,
    steerFrame: OutboundTextFrame,
  ): void {
    const decision = this.#outboundFrameTripwire.settleFrame(steerFrame, observedTurnEvidence());
    if (!decision.tripped) {
      return;
    }
    this.#runtimeBindingQuarantine.disposeSession(record.sessionId);
    this.#ruleTurnTerminalAgainstRun(record.sessionId, runId, decision);
    this.#disposeQuarantinedSession(record);
  }

  /**
   * Whether a terminal on `record` can still rule a frame correlated to `turnId`: the turn has
   * not settled and `record` is still the session's record (identity, not presence).
   */
  #canStillRuleFrameOnTurn(record: CodexSessionRecord, turnId: string): boolean {
    if (this.#sessions.get(record.sessionId) !== record) {
      return false;
    }
    return !record.settledTurnIds.has(turnId);
  }

  async #requestTurnSteer(
    record: CodexSessionRecord,
    request: CodexSteerRunRequest,
    steerFrame: OutboundTextFrame,
    targetedTurnId: string,
  ): Promise<CodexRequestAttempt> {
    // The classifying entry point: a rejection from `request` cannot say whether the provider
    // acted.
    return await record.connection.attemptRequest("turn/steer", {
      threadId: record.threadId,
      input: [{ type: "text", text: steerFrame.wireText, text_elements: [] }],
      expectedTurnId: targetedTurnId,
      // The requester's key, verbatim and never re-minted, or the intervention dedupe guard is
      // defeated. `clientUserMessageId` is the provider's caller-supplied message id field, as on
      // `turn/start`.
      clientUserMessageId: request.clientIdempotencyKey,
    });
  }

  /** True when the run has at least one live provider turn (scans the turn-keyed routes). */
  hasActiveTurn(runId: RunId): boolean {
    const sessionId = this.#sessionIdByRunId.get(runId);
    if (sessionId === undefined) {
      return false;
    }
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      return false;
    }
    for (const routedRunId of record.runIdByActiveTurnId.values()) {
      if (routedRunId === runId) {
        return true;
      }
    }
    return false;
  }

  /** Names the current holder of a session slot, or `undefined` when it is free. */
  #describeSlotHolder(sessionId: SessionId): CodexSessionSlotState | undefined {
    // Transition first: during a supersede-resume both views are occupied and a dying record
    // stays installed, so the in-flight kind is the more specific truth.
    const transition = this.#sessionTransitions.get(sessionId);
    if (transition !== undefined) {
      return transition.kind;
    }
    return this.#sessions.has(sessionId) ? "live" : undefined;
  }

  /**
   * True when `record` is still the session's settled, live holder; identity on `#sessions` alone
   * would call a record mid-teardown usable.
   */
  #stillHoldsSlot(record: CodexSessionRecord): boolean {
    return (
      this.#describeSlotHolder(record.sessionId) === "live" &&
      this.#sessions.get(record.sessionId) === record
    );
  }

  /**
   * Claims the session slot in one state and runs the transition behind any predecessor. The only
   * way a slot is taken.
   */
  async #claimSessionSlot<TSettled>(
    sessionId: SessionId,
    kind: CodexSessionTransitionKind,
    runTransition: () => Promise<TSettled>,
  ): Promise<TSettled> {
    const predecessor = this.#sessionTransitions.get(sessionId)?.settled ?? Promise.resolve();
    const transition = predecessor.then(runTransition);
    const claim: CodexSessionTransition = {
      kind,
      settled: transition.then(
        () => undefined,
        () => undefined,
      ),
    };
    this.#sessionTransitions.set(sessionId, claim);
    try {
      return await transition;
    } finally {
      // Identity-checked: a later caller chains onto this claim and publishes its own, so
      // clearing unconditionally would free an occupied slot.
      if (this.#sessionTransitions.get(sessionId) === claim) {
        this.#sessionTransitions.delete(sessionId);
      }
    }
  }

  /**
   * Per-session connection options, with the manager interposed on the server notification
   * stream: frames reach the delegate unchanged and in order. Which stream a frame belongs to is
   * decided only in `provider/thread-frame-router.ts`; a second decision here would disagree with
   * it.
   */
  #connectionOptionsFor(sessionId: SessionId): CodexConnectionOptions {
    const reportDiagnostic = this.#options.reportDiagnostic;
    const answerServerRequest = this.#options.answerServerRequest;
    return {
      ...this.#options,
      // Overridden rather than spread: the transport port carries no session or run identity. The
      // run id is resolved at answer time, since one captured at connection build could name a
      // retired turn.
      serverRequestResponder:
        answerServerRequest === undefined
          ? undefined
          : {
              answer: async (
                request: CodexInboundServerRequest,
              ): Promise<CodexServerRequestDecision> => {
                const attribution = this.#attributeRoutedAsk(sessionId, request);
                if (attribution.outcome === "refused") {
                  // Refused before adjudication and before the option-set read: an ask that
                  // cannot be attributed is not decided.
                  return { decision: "refuse", reason: attribution.reason };
                }
                // Normalized where both the raw ask and the session the diagnostic names are
                // known; `params` still travels verbatim.
                const optionSet = readCodexAskOptionSet(request.method, request.params);
                if (optionSet.kind === "dropped") {
                  // Never silent, never a refusal: the ask stays answerable through the free-text
                  // arm, so dropping the options degrades the card, not the turn.
                  this.#options.diagnostics.emit({
                    provider: CODEX_DRIVER_NAME,
                    kind: "interactive_request_option_set_dropped",
                    rawWireType: request.method,
                    dispositionReason: optionSet.reason,
                    details: {
                      sessionId,
                      declaredOptionCount: optionSet.declaredCount,
                      optionSetMax: CODEX_ASK_OPTION_SET_MAX,
                    },
                  });
                }
                return await answerServerRequest.answer({
                  ...request,
                  sessionId,
                  runId: attribution.runId,
                  // Conditionally spread: under `exactOptionalPropertyTypes` an absent key
                  // differs from undefined.
                  ...(optionSet.kind === "read" ? { options: optionSet.options } : {}),
                });
              },
            },
      onServerNotification: (method: string, params: unknown): void => {
        this.#observeServerNotification(sessionId, method, params);
        // Every inbound frame goes through the router before any projection; the delegate is
        // reached only from inside it (`#handOffToNormalizeBand`). That inner guard has no test
        // of its own: the outer catch reports an identical diagnostic.
        try {
          this.#routeInboundNotification(sessionId, method, params);
        } catch (cause) {
          // The routing band is total, so this is a backstop: an escaping throw would unwind the
          // `#ingest` read-chunk drain and take unrelated frames down with it.
          reportDiagnosticFromDetachedFrame(reportDiagnostic, {
            kind: "notification-consumer-failed",
            method,
            detail: normalizeProviderFailureDetail(cause),
          });
        }
      },
    };
  }

  /**
   * The thread-establishment legs one posture and one subagent policy realize. Both write the
   * `config` table, so they merge here; used by `thread/start` and `thread/fork`.
   */
  #composeThreadEstablishmentLegs(
    posture: ExecutionPosture | undefined,
    subagentPolicy: SubagentPolicy | undefined,
  ): Record<string, unknown> {
    const configOverrides: Record<string, unknown> = {
      ...(posture === undefined ? {} : composeCodexThreadPostureConfig(posture)),
      ...(subagentPolicy === undefined ? {} : composeCodexSubagentConfigOverrides(subagentPolicy)),
    };
    this.#reportWithheldSubagentDefinitions(subagentPolicy);
    return {
      ...this.#composeSpawnPostureParams(posture),
      ...(Object.keys(configOverrides).length === 0 ? {} : { config: configOverrides }),
    };
  }

  /**
   * The spawn-time posture legs (`sandbox`, `approvalPolicy`), plus the diagnostic for the one
   * axis this provider cannot express.
   */
  #composeSpawnPostureParams(posture: ExecutionPosture | undefined): Record<string, unknown> {
    if (posture === undefined) {
      return {};
    }
    this.#reportNarrowedNetworkAllowlist(posture);
    const { sandbox, approvalPolicy } = composeCodexThreadPosture(posture);
    return { sandbox, approvalPolicy };
  }

  /**
   * Compares the realized sandbox against the requested posture and records a divergence; called
   * on every path that establishes a thread.
   */
  #assertPostureRealized(posture: ExecutionPosture | undefined, response: unknown): void {
    if (posture === undefined || !isPlainObject(response)) {
      return;
    }
    const divergence = describeCodexPostureDivergence(posture, response["sandbox"]);
    if (divergence === null) {
      return;
    }
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
      kind: "posture-realization-diverged",
      requestedNetworkAccess: divergence.requestedNetworkAccess,
      realizedNetworkAccess: divergence.realizedNetworkAccess,
    });
  }

  #composeTurnPostureParams(
    record: CodexSessionRecord,
    params: StartRunParams,
  ): Record<string, unknown> {
    const posture = params.executionPosture ?? record.executionPosture;
    if (posture === undefined) {
      return {};
    }
    // Reported per turn too: a run adding an allow-list to a session spawned without one would
    // otherwise narrow silently.
    if (params.executionPosture !== undefined) {
      this.#reportNarrowedNetworkAllowlist(params.executionPosture);
    }
    return { sandboxPolicy: composeCodexTurnSandboxPolicy(posture) };
  }

  #reportNarrowedNetworkAllowlist(posture: ExecutionPosture): void {
    if (posture.networkAccess !== "allowed-domains") {
      return;
    }
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
      kind: "posture-network-allowlist-narrowed",
      deniedDomainCount: posture.allowedDomains.length,
    });
  }

  /**
   * Records every subagent definition this spawn withheld. The concurrency caps are still sent
   * (the half the provider enforces natively) by `composeCodexSubagentConfigOverrides`.
   */
  #reportWithheldSubagentDefinitions(policy: SubagentPolicy | undefined): void {
    if (policy === undefined || !policy.enabled) {
      return;
    }
    for (const definition of policy.definitions) {
      reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
        kind: "subagent-definition-withheld",
        definitionName: definition.name,
        reason: CODEX_SUBAGENT_DEFINITION_WITHHELD_REASON,
      });
      this.#options.diagnostics.emit({
        provider: "codex",
        kind: "subagent_definition_disabled",
        rawWireType: null,
        dispositionReason: CODEX_SUBAGENT_DEFINITION_WITHHELD_REASON,
        // Untrusted caller-supplied text, carried verbatim as data.
        details: { definitionName: definition.name },
      });
    }
  }

  /**
   * Records that a spawn offered the provider no callback-tool registry; the session is degraded,
   * not failed.
   */
  #reportWithheldCallbackTools(
    sessionId: SessionId,
    callbackTools: readonly unknown[] | undefined,
  ): void {
    const withheldToolCount = callbackTools?.length ?? 0;
    if (withheldToolCount === 0) {
      return;
    }
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
      kind: "callback-tools-withheld",
      withheldToolCount,
      reason: CODEX_CALLBACK_TOOL_REGISTRATION_UNAVAILABLE_DETAIL,
    });
    // Both sinks: the local transport arm is this driver's structured record; the censused kind
    // is the one the daemon's counters name.
    this.#options.diagnostics.emit({
      provider: "codex",
      kind: "callback_tool_registry_withheld",
      rawWireType: null,
      dispositionReason: CODEX_CALLBACK_TOOL_REGISTRATION_UNAVAILABLE_DETAIL,
      details: {
        sessionId,
        reason: "provider-registration-unavailable",
        withheldToolCount,
      },
    });
  }

  /**
   * Attributes one routed ask to the run that raised it, by the turn the ask names, before the
   * daemon's responder sees it. A named turn that cannot be resolved is refused, never attributed
   * to the sole active run.
   */
  #attributeRoutedAsk(
    sessionId: SessionId,
    request: CodexInboundServerRequest,
  ): CodexRoutedAskAttribution {
    const turnIdReading = readRoutedAskTurnId(request.params);
    const resolvableTurnId = turnIdReading.resolvableTurnId;
    if (resolvableTurnId !== null) {
      const routedRunId = this.#sessions.get(sessionId)?.runIdByActiveTurnId.get(resolvableTurnId);
      if (routedRunId !== undefined) {
        return { outcome: "attributed", runId: routedRunId };
      }
    }
    if (turnIdReading.recordedTurnId === null && request.askKind !== "callback-tool") {
      // No turn claim on a shape whose params need none (a legacy approval, an elicitation with a
      // `null` turn id): the sole-active fallback applies. `callback-tool` requires a turn, so
      // its absence is itself the fault and refuses.
      return { outcome: "unattributed", runId: this.#activeRunIdFor(sessionId) };
    }
    this.#reportRoutedAskTurnUnresolved(sessionId, request.method, turnIdReading, request.askKind);
    return {
      outcome: "refused",
      // Refused for every kind: the sole-active run would judge the ask under a newer run's
      // identity, and a decline is retryable where a wrong approval is not. An over-bound
      // `turnId` counts as named, since a truncated prefix could match another live turn. The
      // provider reads the reason.
      reason: composeRoutedAskRefusalReason(request.method, turnIdReading),
    };
  }

  /**
   * Records one refused routed ask that named an unresolvable turn. The transport arm takes every
   * refusal; the censused kind only callback-tool ones, since `callback_tool_invocation_refused`
   * counts those and other refusals would corrupt that count.
   */
  #reportRoutedAskTurnUnresolved(
    sessionId: SessionId,
    method: string,
    turnIdReading: CodexRoutedAskTurnIdReading,
    askKind: "callback-tool" | "approval",
  ): void {
    const turnId = turnIdReading.recordedTurnId;
    const turnIdTruncated = turnIdReading.recordedTurnIdTruncated;
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
      kind: "routed-ask-turn-unresolved",
      method,
      turnId,
      turnIdTruncated,
      disposition: "refused",
    });
    if (askKind !== "callback-tool") {
      return;
    }
    this.#options.diagnostics.emit({
      provider: "codex",
      kind: "callback_tool_invocation_refused",
      rawWireType: method,
      dispositionReason:
        "the invocation named no turn this daemon holds a live route for, so no run's tool registry could adjudicate it",
      // Untrusted provider text, bounded at the reader, carried verbatim to correlate with its
      // log.
      details: { sessionId, method, turnId, turnIdTruncated },
    });
  }

  /**
   * The run that owns every live turn on a session, or `null` when none does or two runs are
   * live. The id-keyed form of {@link soleActiveRunIdIn}; a caller holding the record calls that
   * directly, since re-resolving by id after an await can answer about a successor record.
   */
  #activeRunIdFor(sessionId: SessionId): RunId | null {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      return null;
    }
    return soleActiveRunIdIn(record);
  }

  /**
   * Observes every inbound server notification ahead of routing: invalidates the held command
   * list on `skills/changed`, accrues turn evidence, and on a terminal `turn/completed` rules the
   * tripwire and retires the turn's route.
   */
  #observeServerNotification(sessionId: SessionId, method: string, params: unknown): void {
    // The provider's skill-file invalidation signal (empty payload): discarding the held list
    // forces a full re-read. Observed ahead of the router so it lands even for a frame the router
    // disposes.
    if (method === CODEX_SKILLS_CHANGED_METHOD) {
      this.#discardProviderCommandEnumeration(sessionId);
    }
    // Evidence accrues across the turn because the terminal notification may not carry the item
    // list (`itemsView` can read `notLoaded`); keyed by turn id, which item notifications carry.
    const inFlightEvidence = classifyCodexTurnEvidenceObservation(method, params);
    if (inFlightEvidence !== null) {
      this.#outboundFrameTripwire.observe(inFlightEvidence.turnId, inFlightEvidence.observation);
      const observingRecord = this.#sessions.get(sessionId);
      if (
        observingRecord !== undefined &&
        !this.#outboundFrameTripwire.hasPendingFrame(inFlightEvidence.turnId)
      ) {
        // No frame is correlated onto this turn yet; it may still wait on the `turn/start`
        // continuation that re-keys it. Remembering the observation avoids tripping on the
        // terminal alone.
        const remembered = rememberUnmatchedTurn(observingRecord, inFlightEvidence.turnId);
        if (remembered === null) {
          this.#refuseUnretainableTurnEvidence(observingRecord);
          return;
        }
        remembered.observations.add(inFlightEvidence.observation);
      }
    }
    if (method !== CODEX_TURN_COMPLETED_NOTIFICATION) {
      return;
    }
    const payload = isPlainObject(params) ? params : {};
    const rawTurn = payload["turn"];
    const turn = isPlainObject(rawTurn) ? rawTurn : {};
    const turnId = turn["id"];
    const status = turn["status"];
    if (typeof turnId !== "string" || turnId.length === 0) {
      return;
    }
    if (typeof status !== "string" || !CODEX_TERMINAL_TURN_STATUSES.has(status)) {
      return;
    }
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      return;
    }
    // Marked for every terminal before any ruling: the other two memories are conditional, so
    // neither answers "has this turn ended", which `steerRun` needs. A refusal returns without
    // ruling: its teardown rules every frame pending on the scope fail-closed, this turn's
    // included.
    if (!rememberSettledTurn(record, turnId)) {
      this.#refuseUnretainableSettledTurn(record);
      return;
    }
    // Keyed by turn id, never run id, so a terminal cannot clear another live turn of the same
    // run. The tripwire retains the decision so the dispatcher can answer a steer already ruled
    // on.
    const classification = classifyCodexTurnEvidence(params);
    const decision = this.#outboundFrameTripwire.settle(turnId, classification);
    if (decision.tripped) {
      // Quarantine first, then report, so a consumer reacting synchronously to the terminal
      // cannot attach to the process that swallowed the text. Both axes: a later `startRun`
      // resolves the session record by session id.
      this.#runtimeBindingQuarantine.disposeSession(sessionId);
    }

    let matchedRoute = false;
    // Direct lookup on the settling turn's own route leaves the run's other live turns
    // correlated.
    const routedRunId = record.runIdByActiveTurnId.get(turnId);
    if (routedRunId !== undefined) {
      this.#retireTurnRoute(record, turnId);
      this.#ruleTurnTerminalAgainstRun(sessionId, routedRunId, decision);
      matchedRoute = true;
    }
    // A run whose route an interrupt retired is not in the live map. The two maps are disjoint:
    // `interruptRun` deletes the live route in the step that records this correlation, and turn
    // ids are never reused.
    const interruptedRunId = record.interruptedRunIdByTurnId.get(turnId);
    if (interruptedRunId !== undefined) {
      // Released whatever the ruling was: the terminal this entry waited for has arrived.
      record.interruptedRunIdByTurnId.delete(turnId);
      this.#ruleTurnTerminalAgainstRun(sessionId, interruptedRunId, decision);
      matchedRoute = true;
    }
    if (decision.tripped) {
      // The recovery is a fresh spawn, so the condemned process is torn down. Detached: this runs
      // in the synchronous read-chunk drain, where awaiting stalls frames and a throw unwinds the
      // drain.
      this.#disposeQuarantinedSession(record);
    }
    if (!matchedRoute) {
      const remembered = rememberUnmatchedTurn(record, turnId);
      if (remembered === null) {
        this.#refuseUnretainableTurnEvidence(record);
        return;
      }
      remembered.terminal = classification;
    }
  }

  /**
   * Applies a settled turn's tripwire ruling to one run: quarantines its binding and reports the
   * failure. The caller applies the session arm once per terminal first, so a consumer reacting
   * to the first run's failure cannot attach to the process in between.
   */
  #ruleTurnTerminalAgainstRun(
    sessionId: SessionId,
    runId: RunId,
    decision: TripwireDecision,
  ): void {
    if (!decision.tripped) {
      return;
    }
    this.#runtimeBindingQuarantine.disposeRun(runId, sessionId);
    this.#reportTextNeutralizationFailure(
      sessionId,
      runId,
      composeTextNeutralizationRunFailure(decision),
    );
  }

  /**
   * The loud path for a turn-evidence memory at its ceiling while a `turn/start` is in flight,
   * when every entry may be the terminal that start will claim. Dropping or evicting would
   * silently lose a terminal and report a swallowed turn as completed.
   */
  #refuseUnretainableTurnEvidence(record: CodexSessionRecord): void {
    this.#refuseUnretainableTurnMemory(record, {
      kind: "turn-evidence-memory-overflowed",
      retainedTurnCount: record.unmatchedTurnEvidence.size,
    });
  }

  /**
   * The same loud path for the settled-turn memory at its ceiling while a `turn/steer` is in
   * flight: evicting could answer "still running" for an ended turn and strand a frame nothing
   * rules.
   */
  #refuseUnretainableSettledTurn(record: CodexSessionRecord): void {
    this.#refuseUnretainableTurnMemory(record, {
      kind: "settled-turn-memory-overflowed",
      retainedTurnCount: record.settledTurnIds.size,
    });
  }

  /**
   * The same loud path for the interrupted-route memory: every entry is still owed its terminal.
   */
  #refuseUnretainableInterruptedRoute(record: CodexSessionRecord): void {
    this.#refuseUnretainableTurnMemory(record, {
      kind: "interrupted-route-memory-overflowed",
      retainedTurnCount: record.interruptedRunIdByTurnId.size,
    });
  }

  /**
   * Refuses a binding whose per-session turn memory overflowed: quarantines and tears down the
   * session, which rules every pending frame fail-closed. One body keeps the three memories
   * equally loud.
   */
  #refuseUnretainableTurnMemory(
    record: CodexSessionRecord,
    diagnostic: CodexTransportDiagnostic,
  ): void {
    if (this.#runtimeBindingQuarantine.isSessionDisposed(record.sessionId)) {
      // Already condemned: the overflowing drain keeps running and would bury the one report that
      // matters under duplicates.
      return;
    }
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, diagnostic);
    this.#runtimeBindingQuarantine.disposeSession(record.sessionId);
    this.#disposeQuarantinedSession(record);
  }

  /**
   * Rules every frame a departing binding leaves unsettled, fail-closed, with
   * `UNRECOGNIZED_TURN_EVIDENCE` (exempt frames still pass): those turns will never deliver a
   * terminal. Reported at most once per run; a disposed run's `run.failed` was already composed.
   */
  #ruleAbandonedFramesFailClosed(record: CodexSessionRecord): void {
    const rulings = this.#outboundFrameTripwire.settleScope(
      record.sessionId,
      UNRECOGNIZED_TURN_EVIDENCE,
    );
    if (rulings.length === 0) {
      return;
    }
    const reportedRunIds = new Set<RunId>();
    for (const ruling of rulings) {
      if (!ruling.decision.tripped) {
        continue;
      }
      const runId = this.#runIdForAbandonedFrame(record, ruling.joinKey);
      if (runId === undefined || this.#runtimeBindingQuarantine.isRunDisposed(runId)) {
        continue;
      }
      reportedRunIds.add(runId);
      this.#ruleTurnTerminalAgainstRun(record.sessionId, runId, ruling.decision);
    }
    // Emitted even if every ruling duplicated: the counts are the operator's only sight of these
    // writes.
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
      kind: "abandoned-frames-ruled",
      ruledFrameCount: rulings.length,
      reportedRunCount: reportedRunIds.size,
    });
  }

  /**
   * Fails the runs whose frames a resume superseded, once per run, with
   * `composeSupersededDeliveryRunFailure`, which claims only what is known. `record` is the
   * superseded leg, `undefined` only when the resume found no predecessor.
   */
  #failSupersededDeliveries(record: CodexSessionRecord | undefined, sessionId: SessionId): void {
    const abandoned = this.#outboundFrameTripwire.abandonScope(sessionId);
    if (abandoned.length === 0) {
      return;
    }
    const reportedRunIds = new Set<RunId>();
    for (const frame of abandoned) {
      const runId =
        record === undefined
          ? this.#runIdBoundToSession(frame.joinKey, sessionId)
          : this.#runIdForAbandonedFrame(record, frame.joinKey);
      if (runId === undefined || reportedRunIds.has(runId)) {
        continue;
      }
      reportedRunIds.add(runId);
      this.#reportTextNeutralizationFailure(
        sessionId,
        runId,
        composeSupersededDeliveryRunFailure(frame.detailOrigin),
      );
    }
    // Emitted even if no frame resolved to a run: the counts are the operator's only sight of the
    // writes.
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
      kind: "superseded-frames-failed",
      abandonedFrameCount: abandoned.length,
      reportedRunCount: reportedRunIds.size,
    });
  }

  /** The run a join key names when there is no record (matched against the run axis, not cast). */
  #runIdBoundToSession(joinKey: string, sessionId: SessionId): RunId | undefined {
    for (const [runId, boundSessionId] of this.#sessionIdByRunId) {
      if (runId === joinKey && boundSessionId === sessionId) {
        return runId;
      }
    }
    return undefined;
  }

  /**
   * The run an abandoned frame's join key names: a live turn's route, an interrupted turn's
   * correlation, or the run id the frame was registered under when the provider never named a
   * turn (matched against the run axis, not cast).
   */
  #runIdForAbandonedFrame(record: CodexSessionRecord, joinKey: string): RunId | undefined {
    const routed = record.runIdByActiveTurnId.get(joinKey);
    if (routed !== undefined) {
      return routed;
    }
    const interrupted = record.interruptedRunIdByTurnId.get(joinKey);
    if (interrupted !== undefined) {
      return interrupted;
    }
    for (const [runId, boundSessionId] of this.#sessionIdByRunId) {
      if (runId === joinKey && boundSessionId === record.sessionId) {
        return runId;
      }
    }
    return undefined;
  }

  /**
   * Tears down a session a tripwire trip condemned, reusing the ambiguous-turn disposal.
   * Detached: callers are inside the synchronous read-chunk drain or a settlement path that must
   * not wait on or be unwound by a child's death.
   */
  #disposeQuarantinedSession(record: CodexSessionRecord): void {
    void this.#disposeAmbiguousSession(record).catch(() => {
      // Unreachable by construction: the ambiguous-disposal path contains its own teardown fault.
      // Guarded because an unhandled rejection out of the read-chunk drain would be a second
      // failure.
    });
  }

  /**
   * The retained tripwire decision for a turn, read by the intervention dispatcher so a steer
   * whose turn was already ruled settles `degraded` with the refusal code. Asked once; never
   * waits.
   */
  textNeutralizationDecisionForTurn(turnId: string): { readonly refused: boolean } {
    return { refused: this.#outboundFrameTripwire.decisionFor(turnId)?.tripped === true };
  }

  // A throwing consumer must not become a second failure: the run terminal is the guarantee, and
  // losing it would leave the swallowed turn with no record.
  #reportTextNeutralizationFailure(
    sessionId: SessionId,
    runId: RunId,
    failure: TextNeutralizationRunFailure,
  ): void {
    try {
      this.#options.onTextNeutralizationFailure(sessionId, runId, failure);
    } catch (cause) {
      this.#options.diagnostics.emit({
        provider: "codex",
        kind: "text_neutralization_trip_report_failed",
        rawWireType: null,
        dispositionReason: normalizeProviderFailureDetail(cause),
        details: { sessionId, runId, providerFailureDetail: failure.providerFailureDetail },
      });
    }
  }

  /**
   * Closes an abandoned connection without letting a teardown fault (an injected disposer is
   * caller code) change the outcome of the operation that abandoned it. `closeSession` does not
   * use it: a close has no other outcome to protect.
   */
  async #releaseAbandonedConnection(connection: CodexAppServerConnection): Promise<void> {
    try {
      await connection.close();
    } catch {
      // Deliberately swallowed: the transport is abandoned either way, and a refusing teardown is
      // a host-level condition, not a result.
    }
  }

  /**
   * Retires one turn's route, and the run's session binding only when that turn was the run's
   * last: dropping it earlier would strand the steer and interrupt paths of the run's other live
   * turn.
   */
  #retireTurnRoute(record: CodexSessionRecord, turnId: string): void {
    const runId = record.runIdByActiveTurnId.get(turnId);
    if (runId === undefined) {
      return;
    }
    record.runIdByActiveTurnId.delete(turnId);
    if (newestActiveTurnForRun(record, runId) === undefined) {
      this.#sessionIdByRunId.delete(runId);
    }
  }

  /**
   * Drops every run route bound to a session, scanning by value: the record that could enumerate
   * them is gone or replaced by the time a sweep is owed.
   */
  #forgetRunRoutes(sessionId: SessionId): void {
    for (const [runId, boundSessionId] of this.#sessionIdByRunId) {
      if (boundSessionId === sessionId) {
        this.#sessionIdByRunId.delete(runId);
      }
    }
  }

  /**
   * Drops the unsettled frames of a binding this manager no longer holds. Retained decisions
   * survive: they are keyed by turn and the intervention dispatcher reads them after teardown.
   */
  #releaseOutboundFrameBudget(sessionId: SessionId): void {
    this.#outboundFrameTripwire.forgetScope(sessionId);
  }

  #requireSession(sessionId: SessionId): CodexSessionRecord {
    // Quarantine first: otherwise a new run would resolve the surviving record by session id and
    // dispatch into the process that swallowed the user's words. A fresh spawn lifts it.
    this.#runtimeBindingQuarantine.assertSessionAttachable(sessionId);
    // Both transition states refuse, not only `closing`: a record stays installed across its
    // whole transition, so a turn could reach a connection a supersede-resume is about to
    // release.
    const holderState = this.#describeSlotHolder(sessionId);
    if (holderState === "closing") {
      throw new CodexTransportError(`Codex session "${sessionId}" is being torn down.`, {
        sessionId,
        holderState,
      });
    }
    if (holderState === "establishing") {
      throw new CodexTransportError(
        `Codex session "${sessionId}" is being re-established; the leg it runs on is about to change.`,
        { sessionId, holderState },
      );
    }
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      throw new CodexTransportError(`No live Codex session for "${sessionId}".`, { sessionId });
    }
    return record;
  }

  /**
   * Resolves the live turn a steer or an interrupt acts on. The quarantine is checked first: a
   * trip retires the route, so the next steer would fail with a plausible wrong "no active turn"
   * and invite a retry into the process that swallowed the user's words.
   */
  #requireActiveTurn(runId: RunId): { record: CodexSessionRecord; turnId: string } {
    this.#runtimeBindingQuarantine.assertRunAttachable(runId);
    const sessionId = this.#sessionIdByRunId.get(runId);
    const record = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
    const turnId = record === undefined ? undefined : newestActiveTurnForRun(record, runId);
    if (record === undefined || turnId === undefined) {
      throw new CodexTransportError(`No active Codex turn for run "${runId}".`, { runId });
    }
    return { record, turnId };
  }
}

interface ThreadView {
  id: string;
  sessionId: string;
  turns: unknown;
}

/**
 * Parses one exported transcript frame, fail-closed. A frame this leg cannot read is refused,
 * never skipped: no `DeclaredLossKind` names a driver-side drop, so a skip would falsify the
 * empty loss list the `applied` arm returns.
 */
function readRenderedTranscriptFrameForReplay(frame: unknown): SeededTranscriptFrame {
  if (!isPlainObject(frame)) {
    throw new CodexTransportError(
      "A transcript frame handed to the Codex replay leg was not an object.",
      { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
    );
  }
  const position = frame["position"];
  const role = frame["role"];
  const segments = frame["segments"];
  if (typeof position !== "number" || !Number.isInteger(position)) {
    throw new CodexTransportError(
      "A transcript frame handed to the Codex replay leg carried no integer position.",
      { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
    );
  }
  if (role !== "user" && role !== "assistant") {
    throw new CodexTransportError(
      `A transcript frame at position ${String(position)} carried the unrecognized role "${String(role)}".`,
      { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
    );
  }
  if (!Array.isArray(segments)) {
    throw new CodexTransportError(
      `The transcript frame at position ${String(position)} carried no segment list.`,
      { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
    );
  }
  // Only prose-bearing segments form the body (what the post-replay assertion compares);
  // consecutive prose segments join with a blank line.
  const bodyParts: string[] = [];
  for (const segment of segments) {
    if (!isPlainObject(segment)) {
      throw new CodexTransportError(
        `The transcript frame at position ${String(position)} carried a segment that was not an object.`,
        { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
      );
    }
    const kind = segment["kind"];
    if (kind === "text" || kind === "reasoning") {
      const text = segment["text"];
      if (typeof text !== "string") {
        throw new CodexTransportError(
          `A "${String(kind)}" segment of the transcript frame at position ${String(position)} carried no text.`,
          { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
        );
      }
      if (text.length > 0) {
        bodyParts.push(text);
      }
      continue;
    }
    if (kind === "tool_call" || kind === "tool_result") {
      continue;
    }
    // An unrecognized kind refuses, so a kind added to the canonical union fails on its first
    // use.
    throw new CodexTransportError(
      `The transcript frame at position ${String(position)} carried an unsupported segment kind "${String(kind)}"; refusing to seed a frame this driver cannot represent.`,
      { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
    );
  }
  return { position, role, text: bodyParts.join("\n\n") };
}

/**
 * Builds the Responses-API message item for one frame: `input_text` for a user turn,
 * `output_text` for an assistant one. It mints no id, timestamp or author, which a later export
 * could not map.
 */
function codexResponsesItemForFrame(frame: SeededTranscriptFrame): Record<string, unknown> {
  const contentType: string = frame.role === "user" ? "input_text" : "output_text";
  return {
    type: "message",
    role: frame.role === "user" ? "user" : "assistant",
    content: [{ type: contentType, text: frame.text }],
  };
}

function readThread(response: unknown, method: string): ThreadView {
  const record = isPlainObject(response) ? response : {};
  const thread = record["thread"];
  // The shared guard also refuses an array, whose `["id"]` would read `undefined`.
  if (!isPlainObject(thread)) {
    throw new CodexTransportError(`The Codex app-server "${method}" response carried no thread.`, {
      method,
    });
  }
  const id = thread["id"];
  const sessionId = thread["sessionId"];
  if (typeof id !== "string" || id.length === 0 || typeof sessionId !== "string") {
    throw new CodexTransportError(
      `The Codex app-server "${method}" response carried an unusable thread identity.`,
      { method },
    );
  }
  return { id, sessionId, turns: thread["turns"] };
}

/**
 * Reads the ordered turn ids out of a `Thread.turns` array. Total, not throwing: the list is a
 * bookkeeping seed. Non-string and empty entries are skipped, since a placeholder would shift
 * every later ordinal onto the wrong turn.
 */
function readThreadTurnIds(turns: unknown): string[] {
  if (!Array.isArray(turns)) {
    return [];
  }
  const turnIds: string[] = [];
  for (const turn of turns) {
    const id = isPlainObject(turn) ? turn["id"] : undefined;
    if (typeof id === "string" && id.length > 0) {
      turnIds.push(id);
    }
  }
  return turnIds;
}

/**
 * Reads the turn a `turn/steer` acknowledgement named, or `null`. Total, unlike `readTurnId`: an
 * unreadable ack is an acknowledgement with no evidence, graded degraded, not a transport fault.
 * It is the flat `{ turnId }`, not `turn/start`'s `{ turn: { id } }`.
 */
function readSteeredTurnId(response: unknown): string | null {
  const record = isPlainObject(response) ? response : {};
  const turnId = record["turnId"];
  return typeof turnId === "string" && turnId.length > 0 ? turnId : null;
}

function readTurnId(response: unknown, method: string): string {
  const record = isPlainObject(response) ? response : {};
  const turn = record["turn"];
  const turnRecord = isPlainObject(turn) ? turn : {};
  const id = turnRecord["id"];
  if (typeof id !== "string" || id.length === 0) {
    throw new CodexTransportError(`The Codex app-server "${method}" response carried no turn id.`, {
      method,
    });
  }
  return id;
}
