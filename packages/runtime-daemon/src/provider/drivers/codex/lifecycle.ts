// Codex driver — app-server transport + the five lifecycle operations (Plan-005
// Phase 3, T3.1).
//
// This module owns TWO layers that deliberately live in one file:
//   1. `CodexAppServerConnection` — the JSONL/JSON-RPC transport over a single
//      `PtyHost` session (framing, request correlation, deadlines, teardown).
//   2. `CodexLifecycleManager` — the five lifecycle operations expressed in
//      Codex `app-server` method calls (`createSession`, `resumeSession`,
//      `startRun`, `interruptRun`, `closeSession`).
//
// They are NOT split behind a transport port. The transport is not swappable at
// this task (T3.15 leg 6 introduces `DriverTransportConfig` selection), and the
// unit tests drive the REAL framing code through a fake `PtyHost` — a port would
// let the framing go untested behind a stub, which is the failure mode that
// matters here (see the MAX_CANON note below for why framing is load-bearing).
//
// ---------------------------------------------------------------------------
// The termios prelude — why the spawn command is `/bin/sh -c`, not the binary
// ---------------------------------------------------------------------------
//
// The substrate this driver is required to consume is `PtyHost` (Plan-024), and
// a PTY slave starts in CANONICAL mode with ECHO on. `codex app-server` is not a
// TUI and never calls `tcsetattr`, so nothing turns them off. Both defaults are
// fatal to a line-delimited protocol:
//
//   * MAX_CANON — in canonical mode the line discipline caps a single input line
//     (Darwin: 1024 bytes). A longer line is DISCARDED SILENTLY: no error, no
//     short read, no response, ever. Measured against `codex-cli 0.149.1` on
//     Darwin 25.6.0: a 1015-byte frame is answered, a 1045-byte frame is not, and
//     nothing above it ever is. Splitting one frame across several small writes
//     does NOT evade the cap (the limit is per line, not per write) and in
//     practice performs strictly worse. Any real `turn/start` exceeds 1024 bytes,
//     so an unconfigured PTY cannot carry this protocol at all.
//   * ECHO — written frames are echoed back on the read side, so the reader sees
//     its own requests interleaved with server output.
//
// Both are removed by configuring the tty before the server starts. The prelude
// runs `stty` on the pty slave (its own stdin), announces readiness, and then
// `exec`s the provider binary so the shell is REPLACED — the child that `PtyHost`
// signals and reaps is the provider itself, with no shell left in the tree.
//
// Three properties of the command string are load-bearing:
//   * `&&`, not `;` — if `stty` fails, the prelude aborts and the sentinel never
//     arrives, so the caller gets a typed startup failure. With `;` the server
//     would start in canonical mode and silently swallow every large frame,
//     which is a far worse failure than refusing to start.
//   * the sentinel — writing before the prelude has run would race it, and those
//     early writes ARE echoed (verified). Waiting for the sentinel closes the
//     race deterministically rather than tolerating it. The echo filter below is
//     retained anyway as defense in depth, not as the primary mechanism.
//   * the binary path travels in the ENV ARRAY (`CODEX_APP_SERVER_BIN`), never
//     interpolated into the shell string — so a path can never become shell
//     syntax, and the "env is exactly what the caller supplied" property holds.
//
// POSIX-only. ADR-019 puts Windows on a Rust PTY sidecar; that platform needs an
// equivalent termios step (or a non-PTY transport) before this driver runs there.
// That is a T3.15 leg-6 concern, not a silent assumption of this module.
//
// ---------------------------------------------------------------------------
// I-005-5 — resume failure NEVER becomes a new session
// ---------------------------------------------------------------------------
//
// `resumeSession` catches every failure of the resume path and converts it into
// the typed `{ status: 'failed', recoveryCondition: 'recovery-needed', ... }`
// result. It contains NO call to `createSession`, no `thread/start` write, and no
// fallback that could manufacture a fresh thread. Escalation is the daemon's
// decision, made on an explicit condition — never the driver's, made silently.
//
// The typed result is produced through `DriverResumeResultSchema.parse`, so the
// shape is mechanically enforced rather than asserted. That parse is preceded by
// `normalizeProviderFailureDetail`, because the schema's `wireFreeFormString`
// REJECTS empty, whitespace-only, NUL-bearing, and overlength strings — a
// provider error with a blank message would otherwise turn the typed failure back
// into a thrown exception, which is exactly the loss this invariant forbids.
//
// ---------------------------------------------------------------------------
// The session slot — one process per session, held across every transition
// ---------------------------------------------------------------------------
//
// Every operation that can spawn or dispose a provider process runs inside a
// claimed SLOT for its session id. A slot is EMPTY, or held as `establishing`,
// `live`, or `closing`, and it is held from the first synchronous instant of a
// transition until that transition has fully settled — never merely across the
// step that mutates the record.
//
// That last clause is the whole design, and it is stated in the negative because
// every failure in this class has had the same shape: a guard that was correct
// about the MAP and silent about the WINDOW. Three of them shipped and were
// caught in review:
//
//   * a create that tested only `#sessions`, so two overlapping creates both
//     passed the guard, both spawned, and the later install orphaned the earlier
//     process;
//   * a claim that waited for the slot to go ABSENT and then took it, so two
//     waiters released by the same settlement both found it free;
//   * a close that deleted the record and THEN awaited an unsubscribe and a
//     process close, so for the length of that teardown the slot read as empty
//     while the child was still exiting, and a create could spawn beside it.
//
// The invariant that rules out the whole class, rather than these three
// instances: NO PROCESS THIS MANAGER OWNS EXISTS WITHOUT A HELD SLOT. Applied to
// each site — a create holds `establishing` across spawn, handshake, and install;
// a resume holds it across those plus the predecessor release; a close holds
// `closing` across the unsubscribe, the process close, and the record delete; and
// `startRun` disposing an ambiguous session claims `closing` for the kill. A
// `startRun` that merely INSTALLS a route holds no slot, so it re-reads the slot
// after its await and refuses if the record it started under is no longer the
// settled holder.
//
// `#claimSessionSlot` is the only way a slot is ever taken, in either direction.
// A second mechanism would be a second definition of "taken", and the two would
// disagree exactly once.
//
// ---------------------------------------------------------------------------
// Error vocabulary
// ---------------------------------------------------------------------------
//
// Only codes already registered in `docs/architecture/contracts/error-contracts.md §Driver` are used:
// `driver.unavailable` (503) for transport/process failures and `driver.timeout`
// (504) for a deadline. Provider-reported request errors and malformed driver
// config carry NO dotted code by design — classifying provider failures beyond
// transport errors is T3.14/T3.22's leg, and minting a code here would add an
// unregistered row to that census.
//
// Spec coverage: `Spec-005 §Required Behavior` (the normalized driver contract's
// lifecycle surface); `Spec-005 §Fallback Behavior` (a failed resume handle
// surfaces a recovery-needed condition — AC3).
//
// Refs: Plan-005 §Phase 3 / T3.1, `Spec-005 §Required Behavior`,
// `Spec-005 §Fallback Behavior`, invariant I-005-5, ADR-011, ADR-019,
// `docs/reference/provider-wire/codex.md` (pinned `codex-cli 0.150.1`),
// `docs/architecture/contracts/error-contracts.md §Driver`.

import { randomUUID } from "node:crypto";

import {
  DRIVER_AUTH_DETAIL_MAX_LEN,
  DRIVER_FAILURE_DETAIL_MAX_LEN,
  DriverAuthProbeResultSchema,
  DriverGoalResultSchema,
  DriverResumeResultSchema,
  DriverRollbackResultSchema,
  SessionIdSchema,
  type ClearSessionGoalParams,
  type CloseSessionParams,
  type CreateSessionParams,
  type DriverAuthProbeResult,
  type DriverCapabilityFlag,
  type DriverGoalResult,
  type DriverResumeResult,
  type DriverRollbackResult,
  type DriverTransportConfig,
  type ExecutionPosture,
  type InterruptRunParams,
  type ProviderSessionHandle,
  type PtyHost,
  type RecoveryCondition,
  type ResumeSessionParams,
  type RollbackToParams,
  type RunId,
  type SessionId,
  type SetSessionGoalParams,
  type SpawnRequest,
  type SubagentPolicy,
  type StartRunParams,
} from "@ai-sidekicks/contracts";

// TYPE-ONLY, and only in this direction. `intervention.ts` declares the port this
// manager structurally satisfies and imports nothing from here, so the runtime
// module graph stays exactly as acyclic as it was — a type-only import erases at
// compile time. Importing the two steer shapes rather than restating them is what
// makes a drift between the port and its implementation a compile error instead
// of a silently-unsatisfied `runtime:` binding at the `index.ts` composition.
import type { DriverDiagnosticsEmitter } from "../../driver-diagnostics.js";
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
  ProviderBindingQuarantine,
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
import type { CodexSteerAcknowledgement, CodexSteerRunRequest } from "./intervention.js";
// RUNTIME import, and acyclic: `capabilities.ts` imports the probe, refresh, and
// writer modules and `./tools.js`, none of which reaches back into this module.
// The driver id is taken from its one declaration rather than restated as a
// literal, so a rename cannot leave a refusal naming a driver that no longer
// exists under that key.
import { CODEX_DRIVER_NAME } from "./capabilities.js";

// --------------------------------------------------------------------------
// Transport constants
// --------------------------------------------------------------------------

/** Env var carrying the provider binary path into the prelude (never interpolated). */
export const CODEX_APP_SERVER_BIN_ENV_VAR: string = "CODEX_APP_SERVER_BIN";

/** Line the prelude emits once the tty is configured and before `exec`. */
export const CODEX_APP_SERVER_READY_SENTINEL: string = "__codex_app_server_ready__";

/**
 * See the termios-prelude note in this file's header for every clause's
 * rationale.
 *
 * The trailing `"$@"` is the transport-argv seam (T3.15 leg 6). Extra argv
 * words reach the provider as the shell's POSITIONAL PARAMETERS — supplied
 * after the `sh -c` script and its `$0` label — which the shell expands as
 * separate words and never re-parses. That is what lets a daemon-configured
 * endpoint path or credential-file path carry spaces, quotes, or shell
 * metacharacters without either quoting them here or admitting an injection:
 * string-splicing them into this script would do exactly the opposite. With no
 * extra words supplied — the `stdio` default — `"$@"` expands to nothing and
 * the command is byte-identical to what this driver has always spawned.
 */
export const CODEX_APP_SERVER_SHELL_PRELUDE: string =
  `stty -icanon -echo` +
  ` && printf '%s\\n' ${CODEX_APP_SERVER_READY_SENTINEL}` +
  ` && exec "$${CODEX_APP_SERVER_BIN_ENV_VAR}" "$@"`;

/**
 * The `$0` the prelude script is given. Never read by the script; it exists
 * because a `sh -c` invocation assigns its FIRST following operand to `$0`, so
 * omitting it would silently consume the first real argument.
 */
export const CODEX_APP_SERVER_SHELL_ARGV0: string = "codex-app-server";

/** Default provider binary; overridable so a node-pinned path can be supplied. */
export const CODEX_DEFAULT_EXECUTABLE_PATH: string = "codex";

// --------------------------------------------------------------------------
// Transport axis (Plan-005 T3.15 leg 6).
// --------------------------------------------------------------------------
//
// `DriverTransportConfig` configures HOW THE DAEMON REACHES a driver process,
// and the entrypoint resolves it ONCE at driver construction. Everything below
// is a first-party reading of `codex app-server --help` at the installed
// `codex-cli 0.150.1`, quoted where it is load-bearing:
//
//   --listen <URL>   "Transport endpoint URL. Supported values: `stdio://`
//                    (default), `unix://`, `unix://PATH`, `ws://IP:PORT`,
//                    `off`"
//   --stdio          "Use stdio as the transport (equivalent to
//                    `--listen stdio://`)"
//   --ws-auth <MODE> "Websocket auth mode for non-loopback listeners"
//                    [capability-token, signed-bearer-token]
//   --ws-token-file / --ws-token-sha256 / --ws-shared-secret-file /
//   --ws-issuer / --ws-audience
//   proxy --sock <SOCKET_PATH>
//                    "Proxy stdio bytes to the running app-server control
//                    socket" / "Path to the app-server Unix domain socket to
//                    connect to"
//
// THE ENDPOINT IS THE TRANSPORT, NOT AN ADDITION TO IT. `--stdio` being
// *equivalent to* `--listen stdio://` says the two are one setting: an
// app-server started on a socket endpoint does not also answer on stdio, which
// a direct probe confirms (a `--listen unix://` process refuses a stdio
// `initialize` outright rather than answering it). So each arm below is a
// different way of REACHING a process, never a listener bolted onto the stdio
// one:
//
//   stdio         — spawn the app-server on its default endpoint and speak to
//                   it over this driver's PTY substrate. The V1 default.
//   unix-socket   — reach an operator-configured listener through the
//                   provider's OWN first-party stdio bridge, `app-server proxy
//                   --sock <path>`. The line-delimited JSON-RPC connection this
//                   module already implements is unchanged; the bridge is the
//                   whole of the difference, which is why this arm needs no
//                   socket client of its own.
//   websocket     — reach a listener over ws. The provider publishes no stdio
//                   bridge for ws, so the BYTE transport is an injected
//                   connector rather than something this band invents; every
//                   part that IS this band's — selection, credential resolution
//                   at connection time, and the fail-closed refusals — is here.
//
// CREDENTIALS ARE REFERENCES ON BOTH SIDES OF THE SEAM. `bearerTokenRef` is a
// daemon-config reference resolved at CONNECTION time, and the provider's own
// flags take a FILE PATH or a SHA-256 DIGEST rather than a token value — so a
// resolved credential never becomes an argv word, where any local process
// could read it out of the process table. The ref-not-value discipline is the
// provider's too, not only ours.

/** How the daemon reaches one Codex app-server process. */
export type CodexTransportSelection =
  | { readonly transport: "stdio" }
  | { readonly transport: "unix-socket"; readonly socketPath: string }
  | {
      readonly transport: "websocket";
      readonly endpoint: string;
      readonly bearerTokenRef: string;
    };

/**
 * A resolved websocket bearer credential, in one of the two modes the provider
 * accepts. Both arms carry PATHS and digests, never token bytes: the resolver's
 * job is to place the secret somewhere the provider can read it and to name
 * that place, not to hand the value to this module.
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
 * Resolves a daemon-config `bearerTokenRef` to the credential the listener is
 * started with. Injected, asynchronous, and called at CONNECTION time — never
 * at construction and never cached — so a rotated credential is picked up by
 * the next connection rather than pinned for the driver's lifetime.
 */
export type CodexBearerCredentialResolver = (
  bearerTokenRef: string,
) => Promise<CodexWebsocketBearerCredential>;

/**
 * Bridges this driver's line-delimited JSON-RPC to a websocket listener.
 *
 * Deliberately a seam rather than an implementation in this file: the unix arm
 * rides the provider's own `proxy --sock` bridge and needs no client, while ws
 * has no such bridge — and a socket client is not what a driver lifecycle
 * module is. Absence is FAIL-CLOSED, never a silent fallback to stdio: a
 * websocket-configured driver constructed without a connector refuses at
 * construction, because falling back would reach a DIFFERENT process than the
 * operator configured while reporting success.
 */
export interface CodexWebsocketTransportConnector {
  /** Called after the credential resolves; the endpoint is verbatim from config. */
  connect(request: {
    readonly endpoint: string;
    readonly credential: CodexWebsocketBearerCredential;
  }): Promise<void>;
}

/**
 * Resolve the driver's transport selection from its registry config.
 *
 * Absent config is `stdio` — the V1 default, and the only arm that needs no
 * operator action. A `unix-socket` endpoint is normalized off the `unix://`
 * scheme the provider prints in its own `--listen` help, so an operator may
 * write either the scheme form or a bare path; a `websocket` endpoint is
 * carried VERBATIM, because its host and port are the provider's to parse and
 * a driver that rewrote them could reach an address the operator did not name.
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
  // Restated rather than trusted: the contract types `bearerTokenRef` as
  // required on this arm, and an empty string satisfies the type while naming
  // no credential — which is the unauthenticated listener the discriminated
  // shape exists to make unrepresentable.
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
 * The provider argv for one transport selection, as POSITIONAL words appended
 * after the prelude's `$0` label.
 *
 * Composed here rather than at the spawn site so the argv for each arm is
 * stated once and asserted directly: "the listener starts with bearer auth" is
 * a property of these words, decidable without a live remote peer.
 */
export function composeCodexTransportArgv(
  selection: CodexTransportSelection,
  credential: CodexWebsocketBearerCredential | null,
): readonly string[] {
  switch (selection.transport) {
    case "stdio":
      // Left implicit rather than passing `--listen stdio://`: the default is
      // the provider's own, and naming it would make every stdio spawn depend
      // on a flag spelling that the pinned help calls merely equivalent.
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
 * Hard ceiling on a single unterminated inbound line, in UTF-16 code units.
 *
 * The read buffer is fed from a sink the PROVIDER controls, and a newline is the
 * only thing that ever drains it. Without a ceiling, any peer that never emits
 * one grows the buffer until the daemon dies — and the least-guarded window is
 * before the prelude sentinel, where a refused `stty` leaves shell diagnostics
 * accumulating against a tty nobody configured. That is a liveness hazard for
 * the whole node, not merely for one session (`Spec-005 §Pitfalls To Avoid`).
 *
 * The unit is code units rather than bytes ON PURPOSE. Measuring UTF-8 bytes of
 * the retained tail means re-scanning the whole tail on every chunk, which is
 * quadratic in exactly the case the ceiling exists to survive. A code unit costs
 * a fixed two bytes of retained memory whatever it encodes, so this bound is a
 * direct bound on the hazard; and since a UTF-8 encoding is never SHORTER than
 * the code-unit count, a line that trips this ceiling has always exceeded the
 * same figure in bytes too.
 */
export const CODEX_MAX_LINE_LENGTH: number = 32 * 1024 * 1024;

/**
 * The ten server-initiated REQUEST methods of the pinned protocol, read from the
 * generated `ServerRequest` union at `codex-cli 0.150.1` (regenerate, never
 * transcribe — `docs/reference/provider-wire/codex.md`; re-verified against the
 * pinned binary's own generation on 2026-08-28, where `ServerRequest.json` came
 * back byte-identical to the `0.149.1` generation — this root did not move).
 *
 * An OBSERVABILITY ANNOTATION, deliberately NOT a routing filter — and that is
 * still true now that {@link CODEX_ROUTED_SERVER_REQUEST_DESCRIPTORS} routes a
 * subset of these methods (T3.15 leg 3 + the `driver_ask` reachability leg).
 * The routing table is keyed on ITS OWN descriptor map, and every method
 * outside that map — censused or not — still reaches the same fail-closed
 * `-32601` answer. Membership here rides the `unhandled-server-request`
 * diagnostic as `censused`, so a request method added by a newer admitted build
 * is loud without being treated as unanswerable, and is never left hanging a
 * turn forever.
 *
 * Module-private: a shared export of this set belongs with the event normalizer
 * (T3.5), not with the transport.
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

// --------------------------------------------------------------------------
// Server-request routing (T3.15 leg 3 + the `driver_ask` reachability leg).
// --------------------------------------------------------------------------
//
// WHY THIS BAND EXISTS. The normalizer already maps seven inbound methods to
// `driver_ask.requested` and one to `tool.invoked`. Until this band, every one
// of those descriptors was unreachable: the transport answered EVERY method+id
// frame `-32601`, so a Cedar-governed approval could never have been asked for,
// and a callback tool could never have been invoked. The descriptors were
// correct and dead. This table is what connects them.
//
// WHAT IS ROUTED, AND WHAT DELIBERATELY IS NOT, across the pinned ten:
//
//   ROUTED (7) — `item/tool/call`, the modern approval trio
//   (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
//   `item/permissions/requestApproval`), the legacy approval pair
//   (`execCommandApproval`, `applyPatchApproval`), and
//   `mcpServer/elicitation/request`. All seven are reachable at the negotiated
//   posture and all seven are asks: T3.14 P1-4-driver enumerates exactly this
//   set as the Codex interactive-request mechanism. Routing the modern trio
//   while leaving the legacy pair on `-32601` would make the daemon's answer
//   depend on which spelling the provider chose for the same question.
//
//   NOT ROUTED — `item/tool/requestUserInput` is EXPERIMENTAL at the pin and
//   unreachable while this driver negotiates `experimentalApi: false`; it is
//   asserted unreachable off the normalizer's own
//   `CODEX_NEGOTIATION_GATED_METHODS` rather than given a handler that could
//   never run. `attestation/generate` is declined at negotiation
//   (`requestAttestation: false`), and `account/chatgptAuthTokens/refresh` is
//   credential brokering this band does not perform — for both, `-32601` is the
//   honest answer, not a gap.
//
// FAIL-CLOSED ON EVERY PATH. A routed method with no responder injected, a
// responder that refuses, and a responder that throws all answer the provider
// with the method's own REFUSAL shape — never `-32601`, which for an approval
// would be a protocol error where a decision was asked for, and never silence,
// which would hang the turn. The refusal shapes below are read from the pinned
// generation's response types, not invented.

/** The provider result for one answered ask, composed by its own descriptor. */
type CodexServerRequestResult = Record<string, unknown>;

/** One routed server-request method and the two answers it can carry. */
interface CodexRoutedServerRequestDescriptor {
  /**
   * `callback-tool` invocations go to the callback-tool host; `approval` asks
   * go to the Plan-012 evaluation seam through the same responder. The split
   * is what the responder switches on.
   */
  readonly askKind: "callback-tool" | "approval";
  /**
   * The allowed answer. `payload` carries the arms that need data the daemon
   * supplies — the granted permission profile, an elicitation's content — and
   * is merged rather than replacing the decision member.
   */
  readonly composeAllowedResult: (
    payload: Readonly<Record<string, unknown>> | undefined,
  ) => CodexServerRequestResult;
  /** The refusal answer. Never carries data: a refusal grants nothing. */
  readonly composeRefusedResult: (reason: string) => CodexServerRequestResult;
}

/**
 * The routed methods and their answer shapes, each read from the pinned
 * generation's own response type:
 *
 *   `DynamicToolCallResponse`                    `{ success, contentItems }`
 *   `CommandExecutionRequestApprovalResponse`    `{ decision }`, decision in
 *                                                `accept | acceptForSession |
 *                                                 decline | cancel | {…}`
 *   `FileChangeRequestApprovalResponse`          same decision vocabulary
 *   `PermissionsRequestApprovalResponse`         `{ permissions, scope? }` —
 *                                                NO decline arm, so a refusal
 *                                                is an EMPTY granted profile
 *   `ExecCommandApprovalResponse` /
 *   `ApplyPatchApprovalResponse`                 `{ decision }`, `ReviewDecision`
 *                                                whose refusal arm is the
 *                                                object `{ denied: { rejection } }`
 *   `McpServerElicitationRequestResponse`        `{ action }`, action in
 *                                                `accept | decline | cancel`
 *
 * `decline` rather than `cancel` on the two modern approval arms, and the
 * `denied` object rather than `abort` on the legacy pair, because both pairs
 * mean different things: the refusing member lets the agent continue the turn
 * and try something else, while the cancelling member interrupts the turn
 * outright. A policy that refuses ONE tool call has not asked for the turn to
 * end, so answering `cancel` would convert every denial into an interruption.
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
      // The granted profile is the daemon's to compose — it is the CONTENT of
      // the grant, not a yes/no — so an allowed answer with no supplied profile
      // grants nothing rather than guessing a widening.
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

/** The routed method names, for census assertions and for the responder port. */
export const CODEX_ROUTED_SERVER_REQUEST_METHODS: readonly string[] = Object.freeze([
  ...CODEX_ROUTED_SERVER_REQUEST_DESCRIPTORS.keys(),
]);

/**
 * Why this leg registers no provider-side callback-tool surface at the pin
 * (T3.15 leg 3, the Codex half).
 *
 * `dynamicTools` is a property of `ThreadStartParams` in the EXPERIMENTAL
 * generation ONLY. Direct comparison of the default generations at `codex-cli
 * 0.149.1` and the pinned `0.150.1` against the experimental one:
 * `ThreadStartParams` carries 15 properties by default and 26 under
 * `--experimental`, and `dynamicTools` is one of the eleven that appear only
 * there. Both generated files are byte-identical across the pin hop, so the
 * counts are re-verified at `0.150.1` rather than carried. This driver negotiates `experimentalApi: false` — the posture T3.23
 * ratified, and the posture that keeps the twelve
 * `CODEX_NEGOTIATION_GATED_METHODS` dormant — so the registration surface is
 * unreachable.
 *
 * WITHHELD RATHER THAN ATTEMPTED, for the same reason the no-seam withholding
 * exists: a registration the provider ignores would leave the model unaware of
 * the tools while the daemon believed it had offered them. `item/tool/call`
 * stays routed regardless — a build that offers a tool this daemon did not
 * register still gets an adjudicated answer rather than a `-32601`.
 *
 * Flipping `experimentalApi` to reach it is NOT the fix and is deliberately not
 * done here: it would simultaneously un-dormant every experimental notification
 * and request the normalizer maps but does not expect, which is a negotiation
 * change owned by the version-gate leg rather than a side effect of a tool
 * registry.
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
 * The daemon-side answer to one ask.
 *
 * `payload` is present only on the arms whose provider response carries
 * content the daemon composes (a granted permission profile, an elicitation's
 * structured answer); every other arm ignores it.
 */
export type CodexServerRequestDecision =
  | { readonly decision: "allow"; readonly payload?: Record<string, unknown> | undefined }
  | { readonly decision: "refuse"; readonly reason: string };

/**
 * The port the daemon binds to answer routed asks: the callback-tool host for
 * `item/tool/call`, and the Plan-012 evaluation seam for the approval methods.
 *
 * Declared here rather than imported from the host so this module stays free of
 * a dependency on a sibling band, and so a driver composed with no responder is
 * a representable — and fail-closed — configuration rather than a broken one.
 * Every routed ask ALSO projects its `driver_ask.requested` event; that is the
 * responder's, because projection needs the session and run identity the
 * transport deliberately does not hold.
 */
export interface CodexServerRequestResponder {
  answer(request: CodexInboundServerRequest): Promise<CodexServerRequestDecision>;
}

/**
 * One routed ask WITH the identity the daemon needs to adjudicate and project
 * it. The transport cannot supply this — it holds no session or run state — so
 * the lifecycle manager resolves it and wraps the daemon's responder per
 * connection.
 *
 * `runId` is `null` when no turn is active on the session. A real case rather
 * than a defensive one: a provider may ask during establishment or after a
 * turn has retired, and inventing a run id there would attribute the ask — and
 * its `driver_ask.requested` projection — to a run that did not raise it.
 */
export interface CodexSessionServerRequest extends CodexInboundServerRequest {
  readonly sessionId: SessionId;
  readonly runId: RunId | null;
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

/** JSON-RPC "method not found" — the fail-closed answer to an unhandled server request. */
const JSON_RPC_METHOD_NOT_FOUND = -32601;

/**
 * The `thread/realtime/*` server notifications suppressed for this connection
 * (Plan-005 T3.15 leg 7, `docs/reference/provider-wire/codex.md` C-16).
 *
 * Read from the generated `ServerNotification` union at the pin: `codex-cli
 * 0.150.1` publishes exactly these eleven `thread/realtime/*` names. V1 ships no
 * realtime voice surface, so every one of them would reach the normalizer's
 * default branch and land on the diagnostic channel as an unmapped wire kind —
 * a per-audio-delta record on a stream that emits deltas continuously. Opting
 * out at negotiation suppresses them at the source instead, which is the
 * provider's own mechanism for exactly this (`InitializeCapabilities
 * .optOutNotificationMethods`: "Exact notification method names that should be
 * suppressed for this connection").
 *
 * RE-DERIVED AT THE `0.150.1` PIN, AND THE THREE NEW NAMES ARE ADDITIONS, NOT
 * RENAMES. The `0.149.1` list carried eight; `thread/realtime/item/started`,
 * `thread/realtime/item/transcript/delta` and `thread/realtime/item/completed`
 * join them because a full-list-vs-full-list set difference between the two
 * default generations shows four arms ADDED and zero removed — the older
 * `itemAdded` / `transcript/delta` / `transcript/done` spellings are still
 * published at this pin and keep their entries. Dropping them as though they had
 * been renamed would un-suppress three names the provider still emits.
 *
 * SUPPRESSION IS NOT A CENSUS EXEMPTION. The list is exact-match by design and
 * this census is one release's snapshot: a `thread/realtime/*` name a later
 * build adds is deliberately NOT pre-listed here — a name beyond the pin
 * backstops through the normalizer's default branch and becomes a diagnostic,
 * which is how the growth is discovered rather than absorbed. Re-derive this
 * list when the pin moves; never widen it to quiet a diagnostic.
 *
 * The pin hop's fourth added notification, `mcpServer/event/stream/notification`,
 * is deliberately absent: it is not a realtime name, this list is the realtime
 * opt-out, and it takes the default-branch diagnostic path exactly as the
 * paragraph above describes.
 */
export const CODEX_SUPPRESSED_REALTIME_NOTIFICATION_METHODS: readonly string[] = Object.freeze([
  "thread/realtime/started",
  "thread/realtime/closed",
  "thread/realtime/error",
  "thread/realtime/itemAdded",
  "thread/realtime/sdp",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "thread/realtime/item/started",
  "thread/realtime/item/transcript/delta",
  "thread/realtime/item/completed",
]);

/**
 * The provider's ONLY terminal-turn notification.
 *
 * Read from the generated `ServerNotification` union — the vendor regeneration
 * `Spec-005 §References` records at codex-cli `0.150.1` (2026-08-28), which is
 * now the pin itself: the `turn/*` family is exactly `turn/started`,
 * `turn/completed`, `turn/diff/updated`, `turn/plan/updated`, and
 * `turn/moderationMetadata`. There is no `turn/failed` and no `turn/interrupted`
 * — a failed or interrupted turn arrives on THIS method and is discriminated by
 * `turn.status`, so a terminal set keyed on method strings would be wrong.
 *
 * Aliased to the normalizer's constant rather than re-spelled: this method is
 * also the router's classified `turn/*` lifecycle member and the CHILD-THREAD
 * TERMINAL, so two spellings would let the route retirement and the child
 * completion drift apart.
 */
const CODEX_TURN_COMPLETED_NOTIFICATION = CODEX_TURN_COMPLETED_METHOD;

/**
 * The `TurnStatus` values that end a turn.
 *
 * The generated enum is `completed | interrupted | failed | inProgress`.
 * `inProgress` is excluded ON PURPOSE rather than by oversight: the notification
 * carries the whole `Turn`, and treating a non-terminal status as terminal would
 * retire a route while the provider is still running the turn — a steer or
 * interrupt would then be refused as "no active turn" mid-flight. Fail closed by
 * keeping the route.
 */
const CODEX_TERMINAL_TURN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "failed",
]);

/**
 * How many turns one session remembers evidence for while nothing is correlated
 * with them (see `startRun`).
 *
 * Small and fixed: the memory exists to survive a same-chunk response/completion
 * interleave, whose window is one microtask, plus the ordinary post-interrupt
 * duplicate. Anything that accumulates beyond a handful is a provider emitting
 * frames for turns this driver never started, which is exactly the case an
 * unbounded map must not turn into a leak.
 */
const CODEX_UNMATCHED_TURN_MEMORY = 64;

/**
 * The hard ceiling the evidence memory may grow to while a claim on it is still
 * possible, past which the session fails closed.
 *
 * Eviction from that memory is not free the way an ordinary LRU's is: the entry
 * evicted may be the very terminal a suspended `turn/start` continuation is
 * about to claim, and losing a terminal turns a future trip into a silent pass —
 * a whole read chunk drains synchronously, so one large chunk can push 64
 * entries through the memory before any continuation gets to run. So while a
 * `turn/start` is in flight, entries are IMMUNE and the memory is allowed to
 * grow past its ordinary bound. This is what bounds that growth, on the same
 * prune-then-refuse-and-never-evict discipline `OutboundFrameTripwire.#admit`
 * states: at the ceiling the driver can no longer promise to rule what it holds,
 * so it says so — quarantine and teardown — rather than discarding evidence.
 *
 * Four times the ordinary bound. The window it covers is one provider round
 * trip, so reaching even the bound means a session emitting terminals for turns
 * this driver never started; the headroom is there so an unusually large drain
 * degrades nothing, not to make the refusal reachable only in theory.
 */
const CODEX_UNMATCHED_TURN_MEMORY_CEILING = CODEX_UNMATCHED_TURN_MEMORY * 4;

/**
 * The ceiling on how many interrupted runs one session holds turn correlations
 * for while their terminals are still owed (see
 * `CodexSessionRecord.interruptedRunIdByTurnId`).
 *
 * Same figure as the evidence memory above, but a REFUSAL ceiling rather than a
 * prune bound. The two memories beside this one earn their free-prune windows
 * from a claim predicate that can be zero — while no `turn/start` or
 * `turn/steer` is in flight, nothing can ask about what they hold. This memory
 * has no such window: every entry it holds is owed a terminal that may arrive
 * in the very next read chunk, so there is never a moment when pruning the
 * oldest is provably free, and an evicted entry is a terminal ruled against no
 * run — the interrupted run's subscribers hear nothing, which is the exact
 * silence the map exists to prevent. At the ceiling the driver refuses and
 * takes the loud path instead. The window an entry covers is one provider
 * round trip and Codex serializes turns per thread, so a session that reaches
 * even this figure is one whose interrupted turns are not terminating at all.
 */
const CODEX_INTERRUPTED_ROUTE_MEMORY = 64;

/**
 * How many settled turn ids one session remembers while NO steer is in flight
 * (see `CodexSessionRecord.settledTurnIds`).
 *
 * Same figure as the two memories above, and the same shape of argument — but
 * the argument has to be made on this memory's own reader, because this one is
 * asked a question whose wrong answer is silent.
 *
 * The reader is `#canStillRuleFrameOnTurn`, and it reads ABSENCE as "a terminal
 * for that turn is still owed". That reading is only sound while nothing this
 * memory ever held has been dropped: an id evicted between its terminal and the
 * question resolves to absent, the steer's frame is moved onto a turn that will
 * never emit a second terminal, and it sits as occupancy until the scope is
 * released — a swallowed directive reported as nothing at all, which is the one
 * outcome the tripwire exists to prevent. Aging is a slower road to exactly the
 * hazard the acknowledgement guard was built to close.
 *
 * So the bound governs only the window in which nothing can ask. See
 * {@link CODEX_SETTLED_TURN_MEMORY_CEILING} and `rememberSettledTurn`.
 */
const CODEX_SETTLED_TURN_MEMORY = 64;

/**
 * How far the settled-turn memory may grow while a steer IS in flight.
 *
 * The claim window is one `turn/steer` round trip: the acknowledgement can name
 * any turn id at all, so while one is outstanding EVERY id in this memory is
 * potentially the one the continuation is about to ask about, and none of them
 * can be evicted. The headroom is the same multiple `CODEX_UNMATCHED_TURN_MEMORY`
 * takes, for the same reason — a large synchronous drain arriving in the steer
 * response's own read chunk degrades nothing — and the refusal beyond it is the
 * same prune-then-refuse-and-never-evict discipline rather than a choice about
 * which turn's settlement to forget.
 */
const CODEX_SETTLED_TURN_MEMORY_CEILING = CODEX_SETTLED_TURN_MEMORY * 4;

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * `turn/start` gets its own knob. It is believed to return as soon as the turn is
 * ACCEPTED (`TurnStatus` includes `inProgress`, and `turn/steer` requires an
 * already-active turn), so the default matches the ordinary request deadline. It
 * is separate so that if that reading is ever wrong the fix is a configuration
 * change rather than a code change.
 */
const DEFAULT_TURN_START_TIMEOUT_MS = 60_000;

/**
 * Deadline for the courtesy `thread/unsubscribe` that precedes teardown.
 *
 * Deliberately NOT the ordinary request deadline. The process is going away
 * regardless, so this call buys tidiness, not correctness -- and inheriting the
 * 60s default means a wedged provider holds `closeSession` (and any shutdown
 * drain waiting on it) for a minute to no purpose. Seconds are enough for a
 * responsive peer; an unresponsive one is exactly the peer not worth waiting on.
 */
const UNSUBSCRIBE_TIMEOUT_MS = 5_000;

/**
 * The pinned in-band, zero-turn authentication probe surface (P0-5 / C-17).
 *
 * `getAuthStatus` is a member of the DEFAULT-generated `ClientRequest` union —
 * not an experimental one — so it is answerable over the same connection this
 * driver already negotiates with `experimentalApi: false`. It is preferred over
 * the `codex login status` and `codex doctor --json` CLI surfaces the same
 * decision names because those spawn a second process and parse human- or
 * report-shaped output, while this reads the provider's own typed answer on the
 * channel the driver already owns.
 */
const CODEX_AUTH_STATUS_METHOD = "getAuthStatus";

/**
 * Deadline for the probe's single request.
 *
 * Deliberately far shorter than a turn's: `getAuthStatus` reads local credential
 * state and answers immediately, and the probe exists to refuse admission BEFORE
 * work queues behind it. A probe that took a full turn deadline to fail would
 * cost more than the turn it is protecting.
 */
const CODEX_AUTH_PROBE_TIMEOUT_MS = 10_000;

/**
 * Deadline for the resume-failure auth classification (P3-3).
 *
 * Deliberately tighter than the admission probe's. The two answer different
 * questions: the probe runs BEFORE work is admitted and can afford to wait,
 * while this one runs on a caller that is ALREADY FAILING and is waiting on a
 * result it will get either way. The classification only refines which operator
 * action to name, so it must never be the reason a failed resume takes ten
 * seconds to say it failed.
 */
const CODEX_RESUME_AUTH_CLASSIFICATION_TIMEOUT_MS = 2_000;

const DEFAULT_PTY_ROWS = 24;
const DEFAULT_PTY_COLS = 120;

/** Substituted when a provider failure carries no usable message (see I-005-5 note). */
const UNSPECIFIED_PROVIDER_FAILURE_DETAIL =
  "Codex app-server reported a failure with no diagnostic message.";

// --------------------------------------------------------------------------
// Typed errors
// --------------------------------------------------------------------------

/**
 * Transport or process-level failure. Mirrors the house convention for
 * REGISTERED codes (a stable `code` literal plus leak-safe structured
 * `fields`) used by `provider-registry.ts`; internal validation errors like
 * `ProviderOutputValidationError` carry no code — class identity
 * discriminates.
 */
export class CodexTransportError extends Error {
  readonly code = "driver.unavailable" as const;
  readonly fields: Readonly<Record<string, string>>;

  constructor(message: string, fields: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "CodexTransportError";
    this.fields = fields;
  }
}

/**
 * A single inbound line exceeded `CODEX_MAX_LINE_LENGTH` before terminating.
 *
 * A SUBCLASS rather than a peer: the condition is a transport death, so it
 * inherits the already-registered `driver.unavailable` code and mints no new
 * error-contract row, while staying independently catchable by the diagnostics
 * and classification legs that come later.
 *
 * Framing is unrecoverable once this fires. The retained tail is a fragment of a
 * frame whose remainder is now unbounded, so it can never complete validly, and
 * every subsequent byte on the connection is offset against a boundary the
 * driver can no longer locate. The connection is torn down rather than resynced.
 */
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

/** A request outlived its deadline. Registered as `driver.timeout` (504). */
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
 * The provider answered a request with a JSON-RPC error.
 *
 * Deliberately carries NO dotted `code`: mapping provider-reported failures onto
 * the daemon's typed vocabulary is T3.14/T3.22's classification leg, and this
 * task must not mint an unregistered error-contract row. The provider's own
 * numeric code, message, and `data` member are preserved so that leg has
 * something to classify.
 *
 * `providerMessage` is retained BESIDE the composed `message` rather than left
 * to be re-extracted from it. A classifier reading `message` would be matching
 * against a sentence this module composed — method name and quoting included —
 * so what it actually tests is this class's formatting rather than the
 * provider's answer. The verbatim member is the one the wire produced.
 *
 * `providerErrorData` is carried VERBATIM and is deliberately typed `unknown`:
 * the JSON-RPC `error.data` member is where the pinned provider puts its
 * structured refusal detail (steer, revert, and thread-usage refusals all
 * answer with it), and dropping it here is irreversible — no later task can
 * recover a member the transport never kept. Parsing or narrowing it is the
 * classification leg's decision, not this one's, so nothing is read off it.
 * This restores the symmetry the notification path already has, which hands
 * `params` on whole.
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

/**
 * The `ThreadForkParams` member that carries the rewind boundary.
 *
 * Declared once because the classification below compares against what the
 * provider's deserializer prints, and a second spelling of this name here would
 * be a second answer to the question of which field a rewind depends on.
 */
const CODEX_REWIND_BOUNDARY_FIELD = "lastTurnId";

/**
 * The refusal spellings that INDICT A NAMED FIELD, as opposed to a method.
 *
 * Measured, not guessed. `docs/reference/provider-wire/codex.md` §Refusal shapes
 * on the client-request channel records, at the `0.150.1` pin and verbatim from
 * a binary probe, that an accepted method sent without its required parameter
 * answers ``Invalid request: missing field `threadId` `` — and records that this
 * was measured on `thread/fork` ITSELF, not inferred from a sibling method. The
 * `unknown field` spelling is the same deserializer's answer when a field is
 * present but not declared on the params type, which is the shape a RENAMED
 * boundary member produces. It is not separately measured at this pin and is
 * admitted anyway: the indictment it carries is unambiguous, and excluding it
 * would let exactly the rename case the T3.24 rationale names fall through to a
 * generic provider error.
 *
 * `unknown variant` is deliberately NOT here, and that exclusion is the point of
 * matching a phrase AND a backticked field name rather than a phrase alone. The
 * same reference records that `unknown variant` names either the method string
 * that was sent or an enum VALUE nested inside an accepted request, and warns in
 * its own words that "a parser that only looks for the phrase reads a rejected
 * parameter as a missing method". `lastTurnId` is a string-typed field and never
 * a variant name, so a build that has no `thread/fork` at all — the condition
 * the version floor and the capability matrix govern — refuses with the method
 * named, not this field, and stays the generic provider error it is.
 */
const CODEX_FIELD_LEVEL_REFUSAL_PHRASES: readonly string[] = ["missing field", "unknown field"];

/**
 * Does this provider message indict the rewind boundary member specifically?
 *
 * CONSERVATIVE BY CONSTRUCTION. Both conjuncts are load-bearing: the phrase says
 * the deserializer refused a FIELD, and the backticked name says WHICH. A
 * refusal that indicts any other field, or that names no field at all, is a
 * generic provider failure and is left as one — the classification below only
 * ever narrows a refusal that provably names this member.
 */
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
 * The running build accepts `thread/fork` but refuses its boundary member.
 *
 * The DYNAMIC twin of the registry's static gate, and the condition
 * `Spec-005 §Per-Driver Capability Matrix` detection reasoning for this leg
 * names outright: the Codex `rollback` flag resolves `static` from the matrix
 * because the method enumeration establishes that `thread/fork` is accepted and
 * not that `ThreadForkParams.lastTurnId` exists, and `lastTurnId` is verified at
 * the `0.150.1` pin rather than at the `0.141.0` admission floor. A build in
 * that gap passes the static gate and then refuses at the parameter, so the
 * refusal has to be classified where the invocation happens.
 *
 * Rides the REGISTERED `driver.capability_unsupported` (400,
 * `docs/architecture/contracts/error-contracts.md` §Driver, closed at seven) and
 * mints no code — "registry membership is not availability" is the same rule the
 * Claude leg's `ClaudeControlRequestRefusedError` states for its own control
 * refusals, and this is that rule on the Codex rewind path.
 *
 * A LOCAL class rather than the registry's `DriverCapabilityUnsupportedError`,
 * on that same precedent: the registry class is the realization of I-005-2 at
 * the DECLARATION gate and carries `{ driverId, flag }` with nowhere to put the
 * wire evidence, while the evidence is the whole basis on which this refusal
 * claims to be a capability answer at all. The canonical message is deliberately
 * reused verbatim — a caller cannot tell which of the two gates refused, and
 * should not need to, because both say the same thing about the same flag.
 *
 * Leak-safe: `providerError` is normalized through
 * {@link normalizeProviderFailureDetail} rather than carried raw, so a blank,
 * NUL-bearing, or enormous provider message cannot ride out on a field.
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

/**
 * Narrows a `thread/fork` failure to the capability refusal, or leaves it alone.
 *
 * TOTAL AND NON-SWALLOWING: every value it does not recognize is returned
 * unchanged for the caller to rethrow, so this can only ever re-label a failure
 * and never absorb one. The `method` conjunct is kept even though the single
 * call site already scopes the catch to `thread/fork` — the classification is
 * about a member of THAT method's params type, and a future caller that reuses
 * this helper on another request must not inherit the claim by accident.
 *
 * Not folded into a `degraded` result: `DriverRollbackResult` closes at
 * `applied` and `degraded`, a new `fallbackAction` value would be a wire growth
 * this round does not carry, and the promise this delivers — `Plan-005` T3.24 —
 * is a refusal AT INVOCATION rather than a fallback the caller is asked to
 * absorb. A degraded answer would tell the daemon to try something else; this
 * one tells it the capability is not there.
 */
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
 * What holds a session slot.
 *
 * A slot is EMPTY (absent from every view) or held in exactly one of these
 * states, and it stays held across every async step of the transition that owns
 * it — spawn, handshake, supersede, and teardown alike. `establishing` and
 * `closing` are TRANSITION states, published synchronously by the manager's slot
 * claim; `live` is the settled state of an installed record.
 *
 * The distinction is what a refusal can SAY, not how the slot behaves: a create
 * is refused identically in all three, because in all three a second spawn would
 * orphan a process this manager still owns.
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
 * `createSession` was called for a session that already has a live process.
 *
 * Codeless, like the config error below: this is a caller-sequencing defect, not
 * a provider condition, and this task must not mint an error-contract row.
 *
 * Mirrors the Claude leg's `session_already_live` refusal. The alternative --
 * replacing the record -- has no legitimate caller: the superseded child would
 * keep running with nothing routing to it, and `closeSession` would then dispose
 * only the replacement, so the orphan would outlive the session that spawned it.
 * Resume is where a session legitimately re-spawns, and `resumeSession` releases
 * the superseded leg explicitly.
 */
export class CodexSessionAlreadyLiveError extends Error {
  readonly sessionId: string;
  /**
   * Which holder refused the create. Discriminated by CLASS-LOCAL state rather
   * than by a second dotted code: the error-contract registry is closed, and
   * all three arms are the same refusal — a create that would orphan a process —
   * differing only in where that process is in its lifecycle.
   */
  readonly holderState: CodexSessionSlotState;

  constructor(sessionId: string, holderState: CodexSessionSlotState) {
    super(describeSlotRefusal(sessionId, holderState));
    this.name = "CodexSessionAlreadyLiveError";
    this.sessionId = sessionId;
    this.holderState = holderState;
  }
}

/**
 * The daemon-supplied config bag did not carry the shape this driver requires.
 *
 * Codeless for the same reason as above, and because this is a caller/wiring
 * defect rather than a provider condition.
 */
export class CodexDriverConfigError extends Error {
  readonly field: string;

  constructor(message: string, field: string) {
    super(message);
    this.name = "CodexDriverConfigError";
    this.field = field;
  }
}

// --------------------------------------------------------------------------
// Injected ports
// --------------------------------------------------------------------------

/** Per-session view of the two process-wide `PtyHost` sinks. */
export interface CodexPtySessionListeners {
  onData(chunk: Uint8Array): void;
  onExit(exitCode: number, signalCode?: number): void;
}

/**
 * Subscribes to ONE pty session's data/exit stream; returns an unsubscribe.
 *
 * `PtyHost.onData` / `PtyHost.onExit` are PROCESS-WIDE sinks on the host object,
 * so a driver that installed its own would evict every other consumer of the same
 * host. Demultiplexing by session id is therefore the composition root's job, and
 * this port is how the driver consumes it.
 */
export type CodexPtySessionSubscriber = (
  ptySessionId: string,
  listeners: CodexPtySessionListeners,
) => () => void;

/** Cancellable timeout scheduler. Injected so tests never wait on real time. */
export type CodexScheduleTimeout = (callback: () => void, delayMs: number) => () => void;

/**
 * Everything the transport observed but could not route.
 *
 * A closed union rather than a log line, so nothing is silently dropped and a
 * consumer can branch on cause. `unconsumed-server-notification` is the seam the
 * event normalizer (T3.5) mounts on: supply `onServerNotification` and the
 * provider event stream stops arriving here.
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
  | { kind: "notification-write-failed"; method: string }
  | { kind: "unconsumed-server-notification"; method: string }
  /**
   * The notification CONSUMER threw, so this notification was dropped.
   *
   * The ruling this arm encodes: a throwing consumer is a dropped-and-reported
   * notification, never a dead connection. The consumer is the daemon's own
   * event normalizer, designed pure and total over its census, so a throw from
   * it is OUR defect — and tearing the provider connection down would punish the
   * session for a bug on this side of the boundary. The frame is already parsed
   * and correlated by the time the consumer sees it, so the loss is bounded to
   * exactly one notification, and this arm is what keeps that loss recorded
   * rather than silent. Contrast the provider-side ambiguity rulings elsewhere in
   * this file, which ARE connection-fatal: there the unknown is what the PROVIDER
   * did, and no amount of local correctness can resolve it.
   *
   * `detail` is built through `normalizeProviderFailureDetail`, so a consumer
   * that throws a hostile value cannot serialize it into a diagnostic sink.
   */
  | { kind: "notification-consumer-failed"; method: string; detail: string }
  | { kind: "process-exited"; exitCode: number; signalCode: number | null }
  /**
   * A caller-supplied subscription disposer threw during teardown on a path with
   * no caller to rethrow to (the PTY exit callback). `detail` is normalized, so
   * a hostile or malformed thrown value cannot reach a sink through this arm.
   */
  | { kind: "subscription-dispose-failed"; detail: string }
  /**
   * A `thread/fork` response's turn list did not corroborate the rewind: it
   * carried no readable turns at all, or a count that disagrees with the
   * position the caller asked for (T3.15 leg 1).
   *
   * Reported rather than fatal: the fork ITSELF succeeded and the rewind is
   * real, so failing the operation would discard a completed rewind over a
   * bookkeeping disagreement. What is lost is only the corroboration that the
   * daemon's ordinal and the provider's history agree — which is exactly the
   * kind of divergence an operator needs told about and a caller cannot act on.
   *
   * `confirmedTurnCount` carries the provider's own count beside the expected
   * one, so the disagreement is legible from the record rather than only from
   * the fact that a record exists. A response with no readable list reads as
   * zero — the reader cannot tell an absent list from an empty one, and the
   * ledger rebuild below cannot either.
   */
  | {
      kind: "fork-turn-ledger-unconfirmed";
      expectedTurnCount: number;
      confirmedTurnCount: number;
    }
  /**
   * A posture asked for a domain ALLOW-LIST and the provider's network axis is a
   * boolean, so the session was spawned with network DENIED (T3.15 leg 5).
   *
   * `deniedDomainCount` records how many domains the posture named, so the
   * narrowing is measurable rather than merely mentioned.
   */
  | { kind: "posture-network-allowlist-narrowed"; deniedDomainCount: number }
  /**
   * The sandbox policy the provider reported realizing is WIDER than the one the
   * posture demanded (T3.15 leg 5).
   *
   * The check exists because the provider's config table accepts and silently
   * ignores keys it does not recognize, so a posture leg that stopped applying
   * would otherwise be indistinguishable from one that applied. Reported rather
   * than fatal: the session is already running under the reported policy, and
   * refusing the spawn would replace a knowable divergence with an outage.
   */
  | {
      kind: "posture-realization-diverged";
      requestedNetworkAccess: boolean;
      realizedNetworkAccess: boolean;
    }
  /**
   * A subagent definition was withheld from the spawn rather than admitted
   * unenforceable (T3.15 leg 4's fail-closed rule).
   */
  | { kind: "subagent-definition-withheld"; definitionName: string; reason: string }
  /**
   * A session's unmatched turn-evidence memory hit its ceiling while a
   * `turn/start` was in flight, so the binding was refused rather than evicting
   * evidence a suspended continuation may still be owed.
   */
  | { kind: "turn-evidence-memory-overflowed"; retainedTurnCount: number }
  /**
   * A session's settled-turn memory hit its ceiling while a `turn/steer` was in
   * flight, so the binding was refused rather than evicting a settlement the
   * acknowledgement continuation may be about to read as liveness.
   *
   * A SEPARATE kind from the evidence overflow beside it rather than a shared
   * one with a discriminator, because the two name different losses: that one is
   * a terminal a suspended `turn/start` was owed, this one is a turn that ended
   * and would read as still running. An operator reading either needs to know
   * which memory could not hold, and one kind for both would answer neither.
   */
  | { kind: "settled-turn-memory-overflowed"; retainedTurnCount: number }
  /**
   * A session's interrupted-route memory hit its ceiling, so the binding was
   * refused rather than evicting a correlation whose terminal is still owed —
   * an evicted entry is that terminal ruled against no run.
   *
   * A THIRD separate kind on the same ground the settled-turn kind states:
   * this loss is a run that was interrupted and would never hear its turn end.
   * Unlike both siblings it names no in-flight condition, because the memory it
   * reports on has no free-prune window at all (see
   * `CODEX_INTERRUPTED_ROUTE_MEMORY`).
   */
  | { kind: "interrupted-route-memory-overflowed"; retainedTurnCount: number }
  /**
   * A binding was taken away from turns that were still live, so the frames it
   * was carrying were ruled fail-closed rather than dropped.
   *
   * `reportedRunCount` is lower than `ruledFrameCount` whenever several frames
   * belonged to one run, or the run had already been failed by the very ruling
   * that condemned the binding — a duplicate report is suppressed, the ruling
   * itself never is.
   */
  | { kind: "abandoned-frames-ruled"; ruledFrameCount: number; reportedRunCount: number }
  /**
   * A resume superseded a live binding that was still carrying unsettled frames,
   * so those frames were failed on their runs as unproven deliveries.
   *
   * Distinct from `abandoned-frames-ruled` because the CAUSE is: nothing was
   * observed swallowing the text here, the answer simply became unreachable. The
   * runs are failed and deliberately NOT quarantined — the fresh binding is
   * where their future work belongs.
   *
   * `reportedRunCount` is lower than `abandonedFrameCount` whenever several
   * frames belonged to one run, or a frame's join key resolved to no run at all.
   */
  | {
      kind: "superseded-frames-failed";
      abandonedFrameCount: number;
      reportedRunCount: number;
    };

/** Required — a no-op default would reintroduce silent drops. */
export type CodexDiagnosticSink = (diagnostic: CodexTransportDiagnostic) => void;

/**
 * Reports a diagnostic from a frame that has NO CALLER, containing a sink that
 * throws.
 *
 * The discriminator is the frame, not the method it happens to live in: does
 * this call stack terminate in caller code that can act on a failure, or does it
 * terminate in a `PtyHost` event callback (or a detached `.catch`) where an
 * exception has nowhere to go? Every diagnostic reachable from `onData` or
 * `onExit` is in the second category, and there the cost of a throwing sink is
 * not the lost diagnostic — it is that the exception unwinds the READ-CHUNK
 * DRAIN. Frames already parsed out of that chunk are dropped, every request
 * whose response was behind the throw hangs to its own deadline, and the fault
 * escapes into the host's emit loop where no code of ours is running.
 *
 * Deliberately NOT used on request/response paths that DO have a caller: there a
 * sink fault reaches someone who can act on it, and swallowing it would hide a
 * broken sink behind requests that appear to work.
 */
function reportDiagnosticFromDetachedFrame(
  sink: CodexDiagnosticSink,
  diagnostic: CodexTransportDiagnostic,
): void {
  try {
    sink(diagnostic);
  } catch {
    // Nothing to report it to — the sink IS the reporting channel, and the work
    // this frame was in the middle of matters more than the record of it.
  }
}

/** Server-initiated notification sink (the provider event stream). */
export type CodexServerNotificationSink = (method: string, params: unknown) => void;

// --------------------------------------------------------------------------
// Driver-declared config read-shapes
// --------------------------------------------------------------------------

/**
 * What this driver requires inside `CreateSessionParams.config`.
 *
 * The contract types that bag as `Record<string, unknown>` and no corpus document
 * fixes its members, so the driver declares the shape it needs and parses it
 * fail-closed rather than guessing at call time. `env` is the COMPLETE child
 * environment: this module never reads `process.env`, so a variable absent here
 * is absent from the child.
 */
export interface CodexSessionConfig {
  cwd: string;
  env: ReadonlyArray<readonly [string, string]>;
  /**
   * The effective credential policy AS RESOLVED by the daemon, whose denied
   * names are stripped from the child environment this connection spawns with.
   *
   * The RESOLUTION, never the `credentialPolicyRef` the posture carries: this
   * driver reads no credential axis and expands no reference, which is exactly
   * why `#composeThreadEstablishmentLegs` forwards none. Absent under a
   * `trusted` posture, which denies nothing.
   *
   * SCOPED TO THE SPAWN IT ACCOMPANIES, and POSTURE-DERIVED on BOTH spawn
   * paths. A create and a resume alike re-derive it from the posture the request
   * states, through {@link CodexLifecycleOptions.resolveCredentialEnvPolicy} and
   * the single {@link CodexLifecycleManager} helper both call, rather than
   * carrying a declared or recorded one forward. Only a request that states no
   * posture at all falls back to what its own context declared. What a session
   * was launched under is not a statement about what a later relaunch is
   * authorized for.
   */
  credentialEnvPolicy?: CredentialEnvPolicy | undefined;
}

/**
 * The origin a run's opening frame is written under (T3.18).
 *
 * A CONSTANT rather than an input. The text this driver opens a run with is
 * the participant's own message, composed by the daemon's run pipeline, so the
 * origin is a fact of the code path and not a claim a caller gets to make.
 */
const RUN_OPENING_FRAME_ORIGIN: CallerDeclaredFrameOrigin = "participant_text";

/**
 * The posture-affecting `turn/start` fields the DAEMON derives, and which a
 * caller's run bag therefore may not carry (`Spec-012 §Required Behavior`).
 *
 * The class, not a sample of it. `StartRunParams.agentConfig` is an untyped bag
 * the daemon's run pipeline fills, so nothing but this refusal stands between a
 * caller-declared value and the wire — and a posture-affecting field that
 * reached the wire from a caller would run the turn under a policy the daemon
 * never authorized and never recorded.
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
 * The posture members V1 does NOT realize, asserted absent from every
 * constructed `turn/start` (`Spec-005 §Required Behavior`).
 *
 * `sandboxPolicy` and `permissions` are documented un-combinable, and the pair
 * cannot be adjudicated by asking the provider: a DEFAULT connection refuses
 * `permissions` outright as `-32600`, while an `experimentalApi` connection
 * accepts BOTH together with no refusal and no documented precedence. So the
 * exclusion has to hold on this side of the wire. V1 realizes the
 * non-experimental `sandboxPolicy`; `permissions` is the un-realized member and
 * is refused rather than passed through. `permissionProfile` is not a member of
 * the pair at all — it refuses `-32602` at the pin — and is listed for the same
 * reason it appears in the caller-refusal table above: a field that is never
 * constructed is cheaper to keep never-constructed than to diagnose from a
 * provider-side error code.
 *
 * NOT a cardinality check. "Exactly one" is the rule for a turn that HAS a
 * posture, and a turn with none legitimately carries neither member — the spawn
 * posture governs it, and inventing a turn-level one here would narrow a session
 * the daemon deliberately left ungoverned at the turn boundary.
 */
export const UNREALIZED_TURN_POSTURE_MEMBERS: readonly string[] = [
  "permissions",
  "permissionProfile",
];

/**
 * Fail-closed assertion over the params of a constructed `turn/start`.
 *
 * Applied to the object that is HANDED TO the request, after every spread that
 * contributes to it, because a check against the inputs would pass for a
 * composer that added a member downstream of it. `#requestTurnStart` is this
 * driver's only `turn/start` construction site — `turn/steer` requires an
 * already-active turn and creates none — which is what makes one assertion here
 * total rather than representative.
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
 * What this driver requires inside `StartRunParams.agentConfig`.
 *
 * `StartRunParams` carries no session key and no turn text, so both travel here.
 * `conversationHistory` is NOT read as the turn input — it is prior-transcript
 * material for the ADR-029 replay leg (T3.19-T3.22), not the new message.
 */
export interface CodexRunConfig {
  sessionId: SessionId;
  input: string;
  model?: string | undefined;
  clientUserMessageId?: string | undefined;
}

// --------------------------------------------------------------------------
// Execution posture + subagent policy -> Codex config (T3.15 legs 4 + 5)
// --------------------------------------------------------------------------
//
// Every provider key named below is verified against the pinned build's OWN
// definitions rather than transcribed from prose: the wire types come from the
// generated `v2/` schema (`ThreadStartParams.sandbox` / `.approvalPolicy` /
// `.config`, `TurnStartParams.sandboxPolicy`, `SandboxMode`, `SandboxPolicy`,
// `AskForApproval`) and the config-table keys from the binary's own serde field
// names (`agents.max_concurrent_threads_per_session`, `agents.max_depth`).
// See `docs/reference/provider-wire/codex.md` for the pin this reference tracks.

/**
 * The approval supervision every non-`trusted` posture runs under.
 *
 * RATIFIED MAPPING (user decision, 2026-08-25): a `supervised` posture maps to
 * `on-request` UNCONDITIONALLY — there is no conditional arm, and no posture
 * axis, profile, or provider capability may soften it. Recorded here rather than
 * only in the plan because this constant is the enforcement, and a reader
 * changing it must see that they are reversing a ratified decision.
 *
 * `"never"` is used for `trusted` alone, which is what `trusted` means: the
 * posture that records no enforced constraint.
 */
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
 * The provider's own network axis is a BOOLEAN on both sandboxed policy arms, so
 * a domain ALLOW-LIST has no native encoding at this pin.
 *
 * Resolved DOWNWARD, never upward: an allow-list becomes `false` (no network),
 * which is a strict subset of what the posture permits. Mapping it to `true`
 * would be the only alternative, and it would hand a run unrestricted network on
 * the strength of a posture that named three domains. The narrowing is reported
 * as a diagnostic so it is never silent.
 */
function codexNetworkAccessEnabled(posture: ExecutionPosture): boolean {
  return posture.networkAccess === "full";
}

/**
 * The config key carrying the network axis at THREAD scope.
 *
 * `ThreadStartParams.sandbox` is a `SandboxMode` STRING at this pin — a mode
 * selector with no axes — while `TurnStartParams.sandboxPolicy` is the richer
 * `SandboxPolicy` that does carry `networkAccess`. So a thread's own network
 * axis is reachable only through the config table, and only on the
 * `workspace-write` arm: verified against the pinned build, this key moves
 * `ThreadStartResponse.sandbox.networkAccess` on `workspace-write` and moves
 * nothing at all on `read-only`, whose realized policy stays network-denied.
 *
 * Snake_case is load-bearing. The config layer SILENTLY IGNORES a key it does
 * not recognize (a camelCase spelling of this same key leaves the readback
 * unmoved and raises no error at the pin), which is why every spawn asserts the
 * realized posture against the requested one rather than trusting the write.
 */
const CODEX_WORKSPACE_NETWORK_ACCESS_CONFIG_KEY = "sandbox_workspace_write.network_access";

/** Thread-level posture legs — `sandbox` + `approvalPolicy` on `thread/start`. */
export interface CodexThreadPostureParams {
  readonly sandbox: string;
  readonly approvalPolicy: string;
}

export function composeCodexThreadPosture(posture: ExecutionPosture): CodexThreadPostureParams {
  const sandbox = CODEX_SANDBOX_MODE_BY_POSTURE_MODE[posture.mode];
  return {
    sandbox,
    approvalPolicy:
      posture.mode === "trusted" ? CODEX_TRUSTED_APPROVAL_POLICY : CODEX_SUPERVISED_APPROVAL_POLICY,
  };
}

/**
 * The config-table half of the thread-level posture: the network axis the
 * `SandboxMode` selector cannot express.
 *
 * Empty on the two arms where the key has no effect — `trusted` (whose policy
 * has no network axis) and `readonly-sandboxed` (where the workspace key is
 * inert). On those arms the turn-level `sandboxPolicy` is the only expression
 * of the axis, and every run supplies it.
 */
export function composeCodexThreadPostureConfig(
  posture: ExecutionPosture,
): Record<string, unknown> {
  if (posture.mode !== "workspace-sandboxed") {
    return {};
  }
  return { [CODEX_WORKSPACE_NETWORK_ACCESS_CONFIG_KEY]: codexNetworkAccessEnabled(posture) };
}

/**
 * The sandbox policy the provider says it realized, compared against the one the
 * posture demanded.
 *
 * Exists because the config table fails OPEN: an unrecognized key is accepted
 * and ignored, so a posture leg that stopped applying — a renamed key, a
 * changed default, a build that dropped the axis — would look exactly like one
 * that applied. The response carries the provider's own account of the realized
 * policy, so the divergence is checkable rather than assumed, and this is the
 * only place that check can be made.
 *
 * Returns the divergence, or `null` when the realization matches. Never throws
 * and never fails the spawn: the session IS running under the policy the
 * provider reports, and the daemon needs that reported, not withheld.
 */
export function describeCodexPostureDivergence(
  posture: ExecutionPosture,
  realizedSandbox: unknown,
): { readonly requestedNetworkAccess: boolean; readonly realizedNetworkAccess: boolean } | null {
  // Scoped to the ONE arm whose request is expressible at thread scope. The
  // `trusted` arm has no network axis to diverge on, and `read-only` cannot
  // carry one here at all — verified: the workspace config key moves nothing
  // there — so its realization is always network-denied and reporting that
  // would be reporting the design. On that arm the turn-level `sandboxPolicy`
  // is the axis's only expression, and every run supplies it.
  if (posture.mode !== "workspace-sandboxed" || !isPlainObject(realizedSandbox)) {
    return null;
  }
  const realizedNetworkAccess = realizedSandbox["networkAccess"];
  if (typeof realizedNetworkAccess !== "boolean") {
    return null;
  }
  const requestedNetworkAccess = codexNetworkAccessEnabled(posture);
  // BOTH directions, on the one arm where the request is expressible. Wider than
  // requested is the obvious hazard; NARROWER is the one this check was built
  // for, because an unrecognized config key is accepted and ignored at this pin
  // — leaving the axis at its `false` default — so a leg that silently stopped
  // applying looks exactly like a leg that applied a denial.
  if (realizedNetworkAccess !== requestedNetworkAccess) {
    return { requestedNetworkAccess, realizedNetworkAccess };
  }
  return null;
}

/**
 * Per-turn posture — `TurnStartParams.sandboxPolicy`, the richer shape that
 * carries the writable roots the thread-level `SandboxMode` cannot.
 *
 * Sent on EVERY turn rather than once at thread start, because the provider
 * documents the thread-level `sandbox` as a mode selector while the turn-level
 * policy carries the roots: a session that set only the mode would run
 * `workspace-write` against whatever roots the provider defaulted to, which is
 * exactly the silent partial application the posture exists to prevent.
 *
 * `excludeTmpdirEnvVar` and `excludeSlashTmp` are both pinned `true`: a writable
 * temp directory the posture never listed is still a writable root, and the
 * daemon's `writableRoots` is the complete list by construction.
 */
export function composeCodexTurnSandboxPolicy(posture: ExecutionPosture): Record<string, unknown> {
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
 * The provider's own floor on its concurrency cap, and the reason "off" is not
 * spelled with a zero there.
 *
 * VERIFIED against the pinned build rather than assumed: `thread/start` with
 * `agents.max_concurrent_threads_per_session: 0` is REFUSED outright —
 * `-32600 "failed to load configuration: agents.max_concurrent_threads_per_session
 * must be at least 1"` — so a zero cap would not disable subagents, it would
 * fail every session establishment that tried to disable them.
 *
 * `agents.max_depth: 0` IS accepted, and depth is the axis that actually
 * forbids a spawn: a child thread announces itself at depth 1, so a ceiling of
 * 0 admits none. The disabled arm therefore carries the disable on the depth
 * axis and sends the concurrency floor beside it.
 */
const CODEX_SUBAGENT_CONCURRENCY_FLOOR = 1;

/** The depth ceiling that admits no child thread at all. */
const CODEX_SUBAGENT_DEPTH_NONE = 0;

/**
 * Normalizes a caller-supplied cap into the `i32` the provider's config layer
 * parses.
 *
 * A non-integer or non-finite value is refused BY THE PROVIDER with a type
 * error that fails the whole spawn (`invalid type: string ..., expected i32`
 * at the pin), so it is floored here into the nearest value that still means
 * what the caller asked for. Negative and fractional inputs resolve DOWNWARD,
 * which is the direction a ceiling may safely move.
 */
function normalizeCodexSubagentCap(value: number, floor: number): number {
  if (!Number.isFinite(value)) {
    return floor;
  }
  return Math.max(floor, Math.floor(value));
}

/**
 * The `[agents]` config overrides one subagent policy realizes (T3.15 leg 4).
 *
 * `maxConcurrent` enforcement is NATIVE here — the provider owns the cap — which
 * is the half of this leg that needs no daemon interception at all.
 *
 * A DISABLED policy is realized as an explicit zero DEPTH ceiling rather than as
 * silence. Silence would leave the provider's own defaults in force, so
 * "subagents off" would become "subagents on with whatever the installation
 * configured" — the one outcome a fail-closed leg must not produce.
 *
 * An ENABLED policy whose own concurrency cap is below the provider's floor is
 * routed to the same disabled encoding rather than clamped UP to the floor:
 * clamping up would answer a caller who asked for no concurrent subagents by
 * granting one, which is the only direction this leg may never resolve.
 */
export function composeCodexSubagentConfigOverrides(
  policy: SubagentPolicy,
): Record<string, unknown> {
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
 * Why every `SubagentDefinition` is withheld from the Codex config at this pin.
 *
 * The provider's per-role config entry carries exactly `description`,
 * `config_file`, and `nickname_candidates` (its own serde field names at the
 * pinned build). It expresses no model, tools, permission-mode, effort, or
 * max-turns axis inline — those live in the FILE a role points at. Realizing a
 * definition would therefore require this driver to author a config file on
 * disk, a filesystem side effect this band does not own, and registering the
 * role WITHOUT those axes would run a subagent under a configuration nobody
 * chose while the daemon believed the definition had been applied.
 *
 * So definitions are disabled at spawn — the leg-4 fail-closed rule — and the
 * two numeric caps, which the provider DOES enforce natively, are still sent.
 * The single-supervisor invariant is never traded for coverage.
 */
export const CODEX_SUBAGENT_DEFINITION_WITHHELD_REASON: string =
  "the provider's per-role config entry carries no inline model, tools, permission-mode, effort, or max-turns axis at the pinned build, so the definition cannot be realized without authoring a config file this driver does not own";

/**
 * The one place this module decides what "an object" means on a parse path.
 *
 * A value that passes indexes directly, so no use site re-states with a cast
 * what the guard has already proved (the `runtime-binding-store.ts` idiom).
 * Arrays are excluded: `typeof [] === "object"`, and every caller here means a
 * keyed record, so admitting an array would let `[]["thread"]` read `undefined`
 * and turn a malformed frame into a merely-absent field.
 */
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
  return { cwd, env, ...parseCredentialEnvPolicy(source["credentialEnvPolicy"]) };
}

const ENV_NAME_MATCH_MODES: readonly SpawnEnvNameMatch[] = ["case-sensitive", "case-insensitive"];

/**
 * Fail-closed parse of the daemon's resolved credential policy.
 *
 * ABSENT and MALFORMED are deliberately different answers. Absent is a
 * legitimate state — a `trusted` posture resolves to no policy — so it yields no
 * member rather than an empty one. Malformed REFUSES: a policy that arrived as
 * an unreadable shape has denied names in it that this parse could not read, and
 * defaulting to "deny nothing" would spawn the child with exactly the variables
 * the policy exists to withhold.
 *
 * `envNameMatch` is required whenever a policy is present, and is not defaulted
 * for the same reason. The mode is a property of the HOST the daemon canonicalized
 * the names against; guessing it here would silently decide whether `path` slips
 * past a list that names `PATH`.
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
  // `find`, not `some`: the match narrows the value to the union without a cast,
  // so the parse cannot claim a mode the check did not actually admit.
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
  // Earned, not asserted. `SessionId` is a branded UUID, and a cast here would
  // have let any non-empty string wear the brand into the session map, where the
  // mismatch surfaces as a puzzling "no live session" instead of a parse
  // refusal. The Zod failure is re-thrown as this module's typed config error so
  // the caller still sees one failure class from this function.
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
  // T3.18. Read only to REFUSE, never to carry: the run-opening boundary mints
  // its own frame origin (see `#composeRunOpeningFrame`), so this bag cannot
  // name one. Accepting a declared origin here would put the tripwire-EXEMPT
  // arm inside an untyped record the daemon's run pipeline fills — and that arm
  // both delivers command-shaped bytes verbatim and excuses the turn from the
  // tripwire, so a caller that named it would get the participant's words
  // dispatched as a provider command and the swallow reported as a completed
  // turn. No type can reach a bag, so the refusal is the enforcement.
  //
  // The minted value alone is tolerated, because declaring the truth is a
  // no-op; anything else — the exempt arm, another union member, or a value off
  // the union entirely — fails the run loudly rather than being silently
  // dropped, which would hide the caller's bug on the one axis that matters.
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
  // Read only to REFUSE, exactly like `frameOrigin` above — but refused
  // UNIFORMLY, including a value that happens to match what the daemon derived.
  // That is the one place this differs from the `frameOrigin` precedent, and
  // deliberately: an origin has a single legitimate value a caller could only be
  // restating, whereas a posture is a decision, and a caller that agrees with
  // today's derivation would still be asserting authority over tomorrow's.
  // Tolerating a match would also oblige this parse to COMPARE a posture — a
  // structural equality over roots, network axes and a policy reference — where
  // a flat refusal needs no comparison to be correct.
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
 * Builds a probe result, TOTALLY — an over-long or refused detail never throws.
 *
 * The envelope bounds `detail` at `DRIVER_AUTH_DETAIL_MAX_LEN`, two orders of
 * magnitude tighter than the failure-detail bound a normalized provider cause is
 * cut to, so the two cannot share one normalizer. When the envelope still
 * refuses the bounded string the detail is DROPPED rather than allowed to throw:
 * `status` alone carries the fail-closed admission decision and the detail only
 * tells an operator why, so losing it costs diagnostics and never correctness.
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
 * Maps a `getAuthStatus` answer onto the contract's three-value probe result.
 *
 * `GetAuthStatusResponse` is `{ authMethod, authToken, requiresOpenaiAuth }` at
 * the pin, and only the first is read. `authToken` is deliberately never touched
 * on any path — the request asks for it not to be sent at all, and a driver that
 * then read it would be one binary change away from logging a credential.
 *
 * `authMethod` is a closed mechanism enum (`chatgpt`, `apikey`, `bedrockApiKey`,
 * …), so it is safe as `detail` in a way the `account/read` descriptor the
 * contract warns about is not: that one carries a plan name and a seat EMAIL,
 * and this probe never asks for it.
 *
 * The `null` case reports UNAUTHENTICATED even when the provider says it
 * requires no OpenAI sign-in. That reading is deliberately the conservative one:
 * "no OpenAI credential is needed" is not evidence that whatever credential this
 * configuration DOES need is present, and the difference is carried in `detail`
 * so an operator can tell a genuine logout from a non-OpenAI configuration
 * without the probe having to guess on the admission side.
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
    // Present but not a string: the surface answered in a shape this driver
    // cannot read, which is probe ill-health rather than a credential verdict.
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
 * Asks one connection the auth question, with the credential-safety pin applied.
 *
 * Both askers route through here so the two `false` members live in ONE place.
 * They are not stylistic: `includeToken: false` keeps credential material off
 * the wire, and `refreshToken: false` is what keeps the question non-destructive
 * — the pinned providers rotate refresh tokens single-use with no grace window,
 * so an asker that refreshed would end the login it was checking. A second call
 * site that inlined its own params could lose either half silently, and the loss
 * would only show up as operators being logged out by the thing meant to observe
 * them. Both are sent explicitly because `GetAuthStatusParams` types them
 * required-but-nullable.
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
 * Classifies a FAILED resume into the closed `RecoveryCondition` (P3-3).
 *
 * The two conditions name two different operator actions — `reauth-required`
 * means "re-authenticate this provider on the node, then recovery may retry",
 * `recovery-needed` means "reconcile this by hand" — so the classification is
 * made by ASKING, not by reading the refusal. This provider publishes no typed
 * auth error code for the app-server surface, and its `account/read` answers
 * without credentials at all (so a success there is not evidence a credential is
 * usable). A message-substring sniff over the refusal text would therefore be
 * both the only alternative and an unstable one. Instead the still-open
 * connection is asked the credential question directly, which is a positive
 * determination of the state the operator would have to act on.
 *
 * IT IS ASKED ONLY OF A PROVIDER THAT DEMONSTRABLY ANSWERED. The ask is gated on
 * the resume having failed with `CodexProviderRequestError` — a typed JSON-RPC
 * refusal, which is proof that the child is alive, parsing, and replying, and
 * which does not close the transport. Every other cause (a deadline, a transport
 * fault, a handshake failure, an exited process, or a local defect on our own
 * side of the boundary) carries no such proof, and asking a wedged or dead
 * connection would make a failing recovery path wait out a second deadline to
 * learn nothing. This is the difference between one more question and a second
 * way to hang.
 *
 * ORDERING IS LOAD-BEARING: this runs BEFORE the connection is released, because
 * it is that connection's credential state that is in question.
 *
 * FAIL-SAFE DIRECTION. Every path that does not produce a determinate logged-out
 * reading answers `recovery-needed` — the conservative arm, which asks for
 * reconciliation rather than promising an operator that re-authenticating will
 * fix this. `indeterminate` deliberately does not earn `reauth-required` either:
 * an unhealthy probe is not evidence about the credential. The resume's own
 * cause is not lost on any path; it is already carried on
 * `providerFailureDetail`.
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
    // Contained: this classification must never displace the typed `failed`
    // result I-005-5 requires the resume path to return.
    return "recovery-needed";
  }
}

/**
 * Makes any caught value safe for `DriverResumeResult.providerFailureDetail`.
 *
 * The schema's `wireFreeFormString` rejects empty, whitespace-only, NUL-bearing,
 * and overlength strings. Without this the typed `recovery-needed` result would
 * THROW on a provider error whose message is blank or enormous — converting the
 * invariant's typed failure back into an exception. Exported for direct test.
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
    // Totality by CONSTRUCTION rather than by enumeration. `readFailureText`
    // already contains every coercion known to throw, so this outer guard should
    // be unreachable — but "should be unreachable" is exactly the reasoning that
    // put a throwing coercion on this path in the first place. The function's
    // contract is that it is total over arbitrary JS values, and only a structure
    // makes that true; an argument about which values throw does not.
    return UNSPECIFIED_PROVIDER_FAILURE_DETAIL;
  }
}

/**
 * Extracts failure TEXT from an arbitrary thrown value, or "" if it cannot.
 *
 * Every step here is a coercion an attacker-shaped or merely-sloppy value can
 * break, and each one was verified against the runtime rather than assumed:
 *
 *   * `String(value)` throws `TypeError` for a null-prototype object
 *     (`Object.create(null)` has no `toString`/`valueOf` to reach), and for any
 *     object whose `toString` returns a non-primitive;
 *   * `error.message` is a plain property in the spec but a GETTER in practice on
 *     anything that wants to be, and a getter can throw or return a non-string;
 *   * a non-string `message` then breaks `replaceAll`, which is not a method of
 *     numbers — so reading it is not enough, the type has to be checked.
 *
 * Why this matters more here than the code size suggests: this function is what
 * `resumeSession`'s catch path calls to build the typed `recovery-needed` result.
 * A throw here converts I-005-5's typed failure back into an exception — the
 * precise loss that invariant exists to forbid — and it would do so on the path
 * that is ALREADY handling a failure, where the original cause is least likely to
 * be well-formed.
 */
function readFailureText(cause: unknown): string {
  try {
    if (cause instanceof Error) {
      const message: unknown = cause.message;
      if (typeof message === "string" && message.trim().length > 0) {
        return message;
      }
      // An Error with no usable message still has a class, and the class is
      // worth more than nothing: `TypeError` names the failure where "no
      // diagnostic message" names only our inability to describe it.
      const name: unknown = cause.name;
      return typeof name === "string" ? name : "";
    }
    if (typeof cause === "string") {
      return cause;
    }
    // Everything else falls through to the unspecified constant, and the
    // omission is the POINT rather than an accident of the type checks above.
    // `providerFailureDetail` is persisted and operator-visible, so serializing
    // an arbitrary rejection value here — via `String()`, which invokes whatever
    // `toString` the value carries — is how spawn configuration, up to and
    // including credential material the transport was handed, reaches a durable
    // row. Reading `message` and `name` off an `Error` is a different act: those
    // are two named strings on a known shape, not a walk of an unknown object.
    // The Claude leg refuses the same serialization for the same reason; this is
    // one posture across both drivers, not two local judgements.
    return "";
  } catch {
    // An unreadable cause is indistinguishable from an absent one for the
    // operator, and both map to the same unspecified detail. Losing the text is
    // the point of the trade: the typed result survives.
    return "";
  }
}

// --------------------------------------------------------------------------
// Transport
// --------------------------------------------------------------------------

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
  /**
   * How the daemon reaches this process (T3.15 leg 6). Resolved ONCE by the
   * entrypoint at driver construction and handed down already-decided, so no
   * per-connection code re-reads registry config and no two connections of one
   * driver can disagree about which process they are talking to.
   */
  readonly transportSelection?: CodexTransportSelection | undefined;
  /** Resolves `bearerTokenRef` at connection time; required on the ws arm. */
  readonly resolveBearerCredential?: CodexBearerCredentialResolver | undefined;
  /** Bridges to a ws listener; required on the ws arm (absence fails closed). */
  readonly websocketConnector?: CodexWebsocketTransportConnector | undefined;
  /**
   * Answers the routed server requests (T3.15 leg 3). OPTIONAL: a connection
   * driven with no responder still ANSWERS every routed ask — with the
   * method's refusal shape — so the absence degrades the session rather than
   * hanging it.
   */
  readonly serverRequestResponder?: CodexServerRequestResponder | undefined;
}

/**
 * How far a failed request's bytes provably got.
 *
 * The transport is the only layer that can answer this, and the answer is not
 * recoverable downstream: by the time a rejection reaches a caller the
 * connection may already be marked closed by an exit that arrived AFTER the
 * write, so the error carries no trace of which side of the write it came from.
 * The pre-write refusal and the rejection that kills an in-flight response are
 * the same error class with near-identical text, which is why this is carried
 * as a field the transport sets rather than inferred by a caller.
 *
 * - `unsent` — provably no byte of this request was handed to the host. The
 *   connection refused ahead of the write, or the frame would not encode.
 * - `refused` — the provider answered with a JSON-RPC error. An answer is proof
 *   it received the request, processed it, and declined: the same reading the
 *   ambiguous-turn-start rule already takes of a clean provider error.
 * - `indeterminate` — the host took the bytes. Whether the provider received,
 *   parsed, or acted on them is unknown, and unknowable from here.
 */
export type CodexRequestDelivery = "unsent" | "refused" | "indeterminate";

/**
 * The outcome of one request, with a failure's delivery classified.
 *
 * Returned instead of thrown so classification is structural: a caller that
 * must act differently on "never sent" than on "may already have been acted on"
 * reads a field, and has no path back to sniffing an error message. `request`
 * stays for the callers that only ever need the answer.
 */
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
 * One `codex app-server` process reached over one `PtyHost` session.
 *
 * Owns framing (newline-delimited JSON, CR-tolerant), request correlation with
 * per-request deadlines, the fail-closed answer to unhandled server requests, and
 * teardown that leaves no promise pending.
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
   * Spawns the process, waits for the termios prelude's sentinel, then performs
   * the `initialize` / `initialized` handshake.
   *
   * Any failure after a successful spawn tears the process down before
   * rethrowing, so a half-open connection never leaks a child process.
   */
  async open(config: CodexSessionConfig): Promise<void> {
    // CONNECTION TIME, not construction time (T3.15 leg 6): a credential
    // resolved here is the one this connection starts with, so a rotation
    // between two connections of the same driver is picked up rather than
    // pinned. `null` on every arm but websocket — the other two carry no
    // credential at all, and manufacturing one would invent a secret the
    // operator never configured.
    //
    // The ternary, rather than an unconditional `await` on a function that
    // answers `null`: awaiting would insert a microtask tick before the spawn
    // on EVERY arm, including the stdio default, which reorders this method's
    // spawn against a caller that has not yet subscribed. The arm that needs a
    // credential is the only arm that pays for one.
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
      // Exactly the caller-supplied pairs, minus what the effective credential
      // policy denies, plus the binary path the prelude reads. `process.env` is
      // never consulted (asserted by test).
      //
      // Through the shared builder rather than composed here, and this is the
      // ONE seam every Codex spawn reaches — create, resume against a live
      // record, resume after a daemon restart, and the zero-turn auth probe all
      // arrive at this method. A per-call-site composition would put the
      // suppression obligation on four call sites and shed it from whichever one
      // a later leg forgets.
      //
      // The binary path rides as a MANDATED pair, so the deny strip cannot
      // remove it: it is the exact-build-path pin that stands in for this
      // provider's absent environment opt-out, and a strippable pin would leave
      // the child running whatever the launcher resolves to.
      // Name matching is THIS host's, derived from the running platform rather
      // than read off the policy: whether the base's `path` and a denied `PATH`
      // are one variable is an operating-system fact, and a `trusted` posture
      // carries no policy to read it from at all.
      env: buildProviderSpawnEnv({
        driverName: "codex",
        baseEnv: config.env,
        hostEnvNameMatch: hostEnvNameMatchForPlatform(process.platform),
        credentialEnvPolicy: config.credentialEnvPolicy,
        additionalMandatedPairs: [[CODEX_APP_SERVER_BIN_ENV_VAR, this.#executablePath]],
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
      // Inside the guard, not before it. The subscriber is caller-supplied code
      // and can throw; outside, a throw would leave a spawned child running with
      // nothing reading it and nothing owning its teardown, which is exactly the
      // leak this method's contract says never happens.
      this.#unsubscribe = this.#subscribeToPtySession(response.session_id, {
        onData: (chunk) => {
          this.#ingest(chunk);
        },
        onExit: (exitCode, signalCode) => {
          this.#handleExit(exitCode, signalCode ?? null);
        },
      });
      await this.#awaitReadySentinel();
      // Only the ws arm has a bridge to raise; the other two already speak
      // line-delimited JSON-RPC over this PTY (stdio directly, unix through
      // the provider's own `proxy --sock`). Before the handshake, because an
      // `initialize` sent into an unbridged transport would time out on a
      // deadline that describes the wrong failure.
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
          // Defense in depth, mirroring the wire reference: experimental surfaces
          // are opt-in and attestation requests are declined outright. The
          // realtime opt-out is the T3.15 leg-7 suppression — see the constant
          // for why the list is the pin's eleven names, and why the three
          // item-scoped ones were ADDED to it rather than swapped in.
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

  // Every refusal here is a REFUSAL, never a downgrade: a websocket driver that
  // could not resolve its credential must not fall back to an unauthenticated
  // listener or to stdio, both of which would report success while reaching
  // something other than what the operator configured.
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
    // Not caught and softened: a resolver that throws is a credential that
    // could not be obtained, which is the same refusal by another route.
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
   * Sends a request and REPORTS the outcome, classifying a failure by delivery.
   *
   * The classifying counterpart of `request`, for the callers whose correctness
   * turns on whether the provider may have acted: `request` collapses every
   * failure into one rejection, and a caller cannot reconstruct the difference
   * afterwards without reading an error message, which is a guess. Here the
   * phases are separated in the only place that observes them — encode, write,
   * await — so each failure is labelled where it actually happens.
   *
   * `indeterminate` is the default for everything past the write, including a
   * transport error the connection raised on its own exit: the exit may have
   * arrived after the provider read and acted on the request, and nothing
   * reachable from here distinguishes the two. Fail-closed by construction —
   * a new failure mode lands in `indeterminate` unless it is proven unsent.
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
      // Encoding resolves the destination and serializes; both wholly precede
      // the first byte, so a failure here provably put nothing on the wire.
      encodedFrame = this.#encodeFrame({ jsonrpc: "2.0", id: armed.requestId, method, params });
    } catch (cause) {
      this.#cancelPendingResponse(armed.key);
      return { settled: "failed", delivery: "unsent", cause };
    }
    try {
      await this.#writeEncodedFrame(encodedFrame.ptySessionId, encodedFrame.bytes);
    } catch (cause) {
      this.#cancelPendingResponse(armed.key);
      // The host was handed the bytes and its write rejected. The host contract
      // promises no delivery either way, so how many of them reached the child
      // is not knowable here — and a partially written line is exactly the shape
      // that gets read as a whole request by a child that saw the newline.
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

  /**
   * Reserves the response slot and its deadline for one request id.
   *
   * Synchronous on purpose: it is called from the same tick as the write it
   * belongs to, and inserting an await here would widen the window in which a
   * child exit finds a pending rejector with no handler attached.
   */
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
    // `reject` is reachable from `#pending` the moment the executor returns, but
    // the caller then SUSPENDS on its write before the returned promise reaches
    // anyone who could handle it. A child exit during that window rejects a
    // promise nobody is attached to, and Node's default
    // `--unhandled-rejections=throw` turns that into a dead daemon. Worse, if
    // the write then rejects too, the caller rethrows and never returns this
    // promise, so no handler can arrive later either.
    //
    // Attaching a no-op handler marks `settled` handled without consuming it:
    // the caller still receives the rejection through the returned promise,
    // because `.catch()` observes rather than replaces.
    settled.catch(() => {
      /* the returned promise is the caller's channel; this only marks it handled */
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
      // A notification has no reply to await, so a failed write would otherwise
      // vanish. Reported rather than thrown: the caller is mid-handshake and the
      // next request's own failure is the actionable signal.
      this.#reportDiagnosticQuietly({ kind: "notification-write-failed", method });
    });
  }

  /**
   * Tears the connection down. Idempotent: a second call resolves without
   * throwing and without a second `PtyHost.close`.
   */
  async close(): Promise<void> {
    // Guarded on the PTY release, not on `#closed`: an exited child marks the
    // transport unusable but has not released the host's per-session record, and
    // teardown still owes that release.
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
    // Exception-ORDERED, and the ordering is the property. The disposer is
    // caller-supplied code and can throw; when it threw ahead of the release
    // below, `close()` returned before the process was ever handed back to the
    // host — so the child kept running while every layer above treated the
    // session as closed, and a replacement could go live beside it. The fault is
    // held rather than swallowed: it is rethrown once the teardown that must not
    // depend on it has run. Boxed because `undefined` is a throwable value.
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
        // The child may already have been reaped, in which case the host may not
        // know the session. Teardown must not fail on a resource that is gone.
      }
    }
    if (disposeFault !== null) {
      // Rethrown rather than reported: `close()` could already fail this way, so
      // the caller's contract is unchanged — what changed is that the process is
      // gone by the time it does. The teardown paths that must not be displaced
      // by a host-level fault swallow it at their own call site, deliberately
      // and with a reason.
      throw disposeFault.cause;
    }
  }

  /**
   * Tears the connection down HARD, with no graceful phase.
   *
   * For an outcome that leaves provider-side state AMBIGUOUS — a `turn/start`
   * that may or may not have been accepted — the child cannot be left to wind
   * down on its own, because it may be executing tools for a turn no route
   * addresses. `PtyHost` documents no signal for `close(sessionId)` (only
   * `shutdown()` specifies the SIGTERM-then-SIGKILL drain), so the signal is sent
   * explicitly here rather than assumed from the interface. `close()` still runs
   * afterwards: the per-session resource release is owed however the child died.
   */
  async killAndClose(): Promise<void> {
    const ptySessionId = this.#ptySessionId;
    if (ptySessionId !== null && !this.#ptyClosed) {
      try {
        await this.#ptyHost.kill(ptySessionId, "SIGKILL");
      } catch {
        // Already reaped, or a host that no longer knows the session. The close
        // below still owes the resource release either way.
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

  // Kept `async` so a resolution failure surfaces as a REJECTION rather than a
  // synchronous throw: `notify` sends fire-and-forget through `.catch()`, and a
  // synchronous throw here would escape it into the handshake caller.
  async #writeFrame(frame: Record<string, unknown>): Promise<void> {
    const encodedFrame = this.#encodeFrame(frame);
    await this.#writeEncodedFrame(encodedFrame.ptySessionId, encodedFrame.bytes);
  }

  /**
   * Everything that precedes the first byte: destination resolution and
   * serialization.
   *
   * Split from the write so a failure on this side is provably unsent. Nothing
   * here touches the host, so a caller that must know whether the provider may
   * have acted can read the split rather than guess from an error class.
   */
  #encodeFrame(frame: Record<string, unknown>): CodexEncodedFrame {
    const ptySessionId = this.#ptySessionId;
    if (ptySessionId === null) {
      throw new CodexTransportError("The Codex app-server connection is not open.");
    }
    return { ptySessionId, bytes: this.#encoder.encode(`${JSON.stringify(frame)}\n`) };
  }

  /**
   * Single write site: every outbound byte of this protocol passes here, so a
   * transport-level change (framing, neutralization) lands once — and so the
   * boundary past which delivery is no longer knowable has exactly one address.
   *
   * Deliberately NOT `async`: it returns the host's own promise, so awaiting it
   * costs the same microtask hops as awaiting `PtyHost.write` directly and the
   * frame interleavings this transport's tests pin do not move.
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
      // The readiness wait is NOT a pending request, so process death and close
      // must fail it explicitly. Without this, a provider binary that exits
      // during startup (a missing executable exits 126 before the server ever
      // speaks) leaves `open()` unsettled forever.
      this.#onReadyFailed = (error) => {
        cancelDeadline();
        this.#clearReadyWait();
        reject(error);
      };
    });
  }

  #ingest(chunk: Uint8Array): void {
    // A released transport keeps no buffer. Data can still arrive between the
    // synchronous decision to tear down and the host's acknowledgement of it,
    // and appending it would re-grow the very buffer teardown just abandoned.
    if (this.#ptyClosed) {
      return;
    }
    // `stream: true` so a multi-byte character split across chunks is not mangled.
    this.#readBuffer += this.#decoder.decode(chunk, { stream: true });
    let newlineIndex = this.#readBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      // Measured BEFORE the slice. A line that crosses the ceiling and then
      // terminates inside the same chunk leaves a short tail behind, so the
      // post-loop check below would never see it — and by then it would already
      // have been parsed and dispatched. The ceiling is a property of the LINE,
      // so it is enforced where lines are cut.
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
    // The other half: an UNTERMINATED tail, which the loop above never sees
    // because it has no line to cut. That tail is the quantity that grows
    // without bound; a stream of ordinary frames larger than the ceiling in
    // aggregate is not a breach, and is not treated as one.
    if (this.#readBuffer.length > CODEX_MAX_LINE_LENGTH) {
      this.#failFraming(this.#readBuffer.length);
    }
  }

  /**
   * Abandons an over-long line and the connection carrying it.
   *
   * The tail is DISCARDED UNPARSED rather than truncated: handing a prefix of a
   * frame to the line handler would either fail to parse (reporting a fabricated
   * `unparsable-line` for a frame the provider never sent) or, worse, parse as a
   * valid but incomplete object and be dispatched as if the provider had meant
   * it. Neither is a thing a caller can be told apart from the truth.
   *
   * In-flight callers are failed with the typed error BEFORE the release path
   * runs, so they learn why the transport died rather than receiving the generic
   * closed-connection error; the startup waiter is failed by the same act, which
   * is what bounds the pre-sentinel window (a prelude that never emits a newline
   * would otherwise hold `open()` until the startup deadline while growing the
   * buffer the whole time).
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
    // Signalled explicitly, then released. `PtyHost.close` is specified as
    // "tear down the session and release all per-session resources" and does
    // NOT promise to signal the child -- `shutdown()` documents the graceful
    // per-session kill as a separate dispatch -- so `close()` alone could leave
    // a still-running process writing into a PTY nobody reads.
    //
    // `SIGKILL` rather than `SIGTERM` for this condition specifically: there is
    // no protocol left to negotiate an orderly stop over, and a peer already
    // emitting an unbounded line is the last peer to give a shutdown window to.
    // The graceful path stays where it belongs, on `closeSession`.
    const ptySessionId = this.#ptySessionId;
    if (ptySessionId !== null) {
      void this.#ptyHost.kill(ptySessionId, "SIGKILL").catch(() => {
        /* already reaped, or the host lost it; `close()` still owes the release */
      });
    }
    void this.close().catch(() => {
      /* teardown of an already-doomed transport changes nothing here */
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
      // Shell diagnostics, provider stderr, or a truncated frame. Reported, not
      // dropped — this is the channel on which a mis-set tty becomes visible.
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
        // Our own frame, echoed back by a tty whose ECHO was still on. Never
        // answered: a response to it would corrupt the server's correlation.
        this.#reportDiagnosticQuietly({ kind: "echoed-client-frame", method });
        return;
      }
      // Routed asks — the callback-tool invocation and the six approval /
      // elicitation methods — are answered through the daemon's own pipeline
      // (T3.15 leg 3). Everything the routing table does not name falls through
      // to the same fail-closed error answer as before.
      const routed = CODEX_ROUTED_SERVER_REQUEST_DESCRIPTORS.get(method);
      if (routed !== undefined) {
        void this.#answerRoutedServerRequest(id, method, routed, message["params"]);
        return;
      }
      // Fail closed, for EVERY other method+id frame — censused or not.
      // Answering with an error refuses cleanly and can never be mistaken for
      // consent, while leaving it unanswered would hang the provider's turn.
      // That hang is the whole reason membership in the pinned census does not
      // gate this arm: a newer admitted build may speak a request method this
      // pin never saw.
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
        /* connection already gone; the exit path reports it */
      });
      return;
    }
    if (this.#onServerNotification !== undefined) {
      // Contained here as well as at the manager's own delegate call, because
      // this class is exported and driven standalone: a consumer wired directly
      // to a connection would otherwise unwind `#ingest` from inside the host's
      // data callback, dropping every frame still queued behind this one in the
      // same chunk and hanging their callers to their deadlines. Containing at
      // the OUTERMOST call into consumer code is what makes that true for every
      // composition rather than for the one this driver happens to build.
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
   * True only for a frame this connection SENT and is still awaiting a reply to.
   *
   * Correlation, not a name test: an echo is by definition one of our own
   * outbound requests coming back, so it must match a pending entry on BOTH the
   * id and the method. Matching the id alone would be wrong — the two directions
   * mint request ids in independent namespaces, so a server request can carry an
   * id we also used — and matching the method alone would be wrong for the same
   * reason in reverse.
   *
   * The pending entry is deliberately left in place: the real reply is still
   * owed, and consuming the entry here would strand the caller until its
   * deadline. In practice this arm is near-dead — the termios prelude disables
   * ECHO before the sentinel, and no request is sent before the sentinel — which
   * is precisely why the OTHER arm has to be the safe default.
   */
  /**
   * Answer one routed server request through the daemon's responder.
   *
   * EVERY path answers, and every path answers with the METHOD'S OWN refusal
   * shape rather than a JSON-RPC error: for an approval, `-32601` says "I do
   * not implement this question", which the provider is entitled to treat as a
   * protocol fault, whereas a refusal answers the question that was actually
   * asked. A missing responder, a refusing responder, and a throwing responder
   * therefore converge on the same wire answer and differ only in the recorded
   * reason.
   *
   * `void`-called by the frame handler on purpose: the ingest loop is
   * synchronous and must not await one ask while other frames from the same
   * chunk queue behind it. The rejection path is absorbed here rather than at
   * the call site so no answer depends on the caller remembering to catch.
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
        // A responder that throws has not decided, and an undecided ask is a
        // refusal — never an allow, and never an unanswered frame.
        const detail = normalizeProviderFailureDetail(cause);
        this.#reportDiagnosticQuietly({
          kind: "server-request-responder-failed",
          method,
          detail,
        });
        result = descriptor.composeRefusedResult(detail);
      }
    }
    await this.#writeFrame({ jsonrpc: "2.0", id, result }).catch(() => {
      /* connection already gone; the exit path reports it */
    });
  }

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
          // Read with no shape assumption and no narrowing: absent stays absent.
          errorRecord["data"],
        ),
      );
      return;
    }
    pending.resolve(message["result"]);
  }

  /**
   * The child exited. Runs inside a `PtyHost` event callback, which is what makes
   * every caller-supplied call in it dangerous in a way `close()` is not.
   *
   * `close()` has a caller and an awaited promise, so a fault there has somewhere
   * to go. This does not: it is invoked from the host's emit loop, so an
   * exception escapes into the host and — worse than being lost — takes the
   * cleanup below with it. Every pending request would then sit until its own
   * deadline, and a connection still waiting on the prelude sentinel would never
   * fail at all, on the one code path whose whole job is to fail them.
   *
   * So both caller-supplied surfaces here (the diagnostic sink and the
   * subscription disposer) are contained, and the cleanup runs unconditionally.
   */
  #handleExit(exitCode: number, signalCode: number | null): void {
    this.#exitDescription = `exit ${exitCode}${signalCode === null ? "" : ` signal ${signalCode}`}`;
    this.#reportDiagnosticQuietly({ kind: "process-exited", exitCode, signalCode });
    // Mark closed BEFORE rejecting: a rejection handler that retries must be
    // refused a write rather than hitting the dead fd (a write to an exited pty
    // raises an asynchronous EIO that no caller can catch).
    this.#closed = true;
    // Boxed and held, exactly as `close()` does it — but REPORTED rather than
    // rethrown, because there is no caller to rethrow to. Swallowing silently
    // would be the wrong trade: the disposer failing means a listener may still
    // be registered against a dead session, which is an operator-visible fact.
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
      // Reported AFTER the cleanup, so a sink that throws in response cannot cost
      // the callers their rejections.
      this.#reportDiagnosticQuietly({
        kind: "subscription-dispose-failed",
        detail: normalizeProviderFailureDetail(disposeFault.cause),
      });
    }
  }

  /**
   * Every diagnostic this transport emits, contained.
   *
   * All of them qualify under the rule in `reportDiagnosticFromDetachedFrame`,
   * which is why there is no bare call left in this class rather than a mixture
   * a later edit would have to re-classify: the framing, correlation, and exit
   * diagnostics all originate in `onData` / `onExit`, and `notify`'s originates
   * in a detached `.catch` on a `void`-ed promise — where a throwing sink is
   * worse than anywhere else, because it becomes an unhandled rejection, which
   * this file already documents as fatal to the daemon under Node's default.
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

// --------------------------------------------------------------------------
// Lifecycle manager
// --------------------------------------------------------------------------

interface CodexSessionRecord {
  readonly sessionId: SessionId;
  readonly connection: CodexAppServerConnection;
  /**
   * The thread this session is currently bound to.
   *
   * MUTABLE, uniquely among this record's identity fields, and only `rollbackTo`
   * moves it: `thread/fork` mints a NEW thread and the rewound session continues
   * on it, so the leg's thread is a value that changes while the leg's identity
   * does not. Re-pointing in place rather than installing a replacement record
   * is what keeps that true — in-flight closures hold this record by reference
   * and `#isRecordInstalled` compares it by identity, so swapping the object
   * would silently invalidate both.
   */
  threadId: string;
  /**
   * The ordered turn ids of this thread, oldest first — the session-position
   * axis `RollbackToParams.position` indexes into (position N names
   * `turnBoundaries[N - 1]`, the Nth turn, which is the inclusive `lastTurnId`
   * a fork through position N must carry).
   *
   * Seeded from the provider's own `thread.turns` on resume and on fork (the
   * generated `Thread` type documents those two responses, plus `thread/read`,
   * as the ones that populate it) and appended at each accepted `turn/start`.
   *
   * DELIBERATELY UNCAPPED, unlike `unmatchedTurnEvidence` beside it. That
   * memory is a short race window whose oldest entry is the least relevant; this
   * ledger IS the position axis, so evicting its head would silently re-map
   * every later ordinal and a rewind would land on the wrong turn. A turn id is
   * a UUID: a session long enough for this to cost memory does not exist, and a
   * wrong rewind would.
   */
  readonly turnBoundaries: string[];
  /**
   * The posture this session was spawned under, retained so EVERY turn can
   * re-send its `sandboxPolicy` (T3.15 leg 5).
   *
   * `StartRunParams` also carries a posture, and it is the one that wins when
   * present — that is the per-run effective posture. This one is the floor a run
   * that declares nothing inherits, so a turn is never dispatched with no policy
   * at all just because its run was silent on the axis.
   */
  readonly executionPosture: ExecutionPosture | undefined;
  /**
   * The subagent policy this session was spawned under, retained for the same
   * reason the posture is: a `thread/fork` establishes a NEW thread, and a fork
   * that did not re-send the caps would leave the rewound session running under
   * the provider's installation defaults while the daemon believed the policy
   * still held.
   */
  readonly subagentPolicy: SubagentPolicy | undefined;
  /**
   * The context this leg's process was launched in, reused as the PROCESS
   * CONTEXT of a resume that supersedes it — `cwd` and `env`, which say where
   * the binary runs and how it finds its credential home, and which a live
   * record answers better than the manager-wide default.
   *
   * Its `credentialEnvPolicy` is deliberately NOT reused: a resume re-derives
   * that from the posture it is being resumed under, so a posture change
   * between create and resume reaches the child rather than being masked by the
   * record. What it holds is the create's own RESOLVED answer and not the raw
   * config bag, which is why the one arm that does inherit it — a resume that
   * states no posture — inherits the policy the child actually ran under.
   * See `#composeCreateSpawnConfig` and `#composeResumeSpawnConfig`.
   */
  readonly spawnConfig: CodexSessionConfig;
  /**
   * Every live turn on this session, keyed by TURN id, newest last.
   *
   * Turn-keyed and not run-keyed, and that direction is the whole point. A run
   * may hold MORE THAN ONE live turn: nothing serializes two `startRun` calls
   * for one run, and when both are accepted the provider names a turn for each.
   * A `Map<RunId, string>` can hold one, so the second acceptance overwrote the
   * first — and a terminal for the first turn then matched no route, so its
   * ruling reached the session and never the run. That is the swallowed turn
   * whose `run.failed` nobody hears.
   *
   * Keying by the turn makes the correlation TOTAL: every accepted turn installs
   * its own entry, every terminal resolves its own run by direct lookup, and a
   * settlement consumes only the entry for the turn that settled. The derived
   * question — "which live turn does this run have" — is answered by scanning
   * this map where a caller genuinely needs it (`hasActiveTurn`,
   * `#requireActiveTurn`), which is the rarer direction and the one that has an
   * honest answer under N live routes.
   */
  readonly runIdByActiveTurnId: Map<string, RunId>;
  /**
   * Turn evidence that arrived while no route — and no tripwire correlation —
   * pointed at the turn it belongs to.
   *
   * Insertion-ordered and capped (`CODEX_UNMATCHED_TURN_MEMORY`); consumed by
   * `startRun`. See the note there for the interleave this exists to survive.
   *
   * It carries the EVIDENCE and not merely the turn id, because the consuming
   * side has to rule the tripwire, not just retire a route: a memory holding ids
   * alone would let `startRun` learn that the turn ended and still have nothing
   * to rule it on, so a zero-turn interception landing in this window would be
   * reported as a completed turn.
   */
  readonly unmatchedTurnEvidence: Map<string, UnmatchedTurnEvidence>;
  /**
   * How many `turn/start` requests are awaiting an answer on this session.
   *
   * The claim predicate for `unmatchedTurnEvidence`, and the reason it is exact
   * rather than a heuristic: an entry there can be claimed by ONE caller only —
   * the `startRun` continuation that is handed the turn id the provider names —
   * so while this is zero, nothing in that memory can ever be claimed again. A
   * later start cannot claim one either, because the provider mints a fresh
   * UUIDv7 per turn and never reuses an id, which is the same fact the consume
   * in `startRun` already relies on.
   *
   * That makes eviction safe exactly when this is zero and unsafe otherwise,
   * which is the distinction `rememberUnmatchedTurn` enforces.
   */
  inFlightTurnStarts: number;
  /**
   * The turn ids whose terminal this session has already ingested, newest last.
   *
   * A DIFFERENT question from `unmatchedTurnEvidence` above, which is why it is
   * not folded into it. That memory answers "what is a run whose route is not
   * installed yet still owed", so it is written only when no route matched and
   * `startRun` CONSUMES an entry when it claims one. This one answers "has this
   * turn ended", for a caller that is owed nothing and consumes nothing: it is
   * written for every terminal, matched or not, and read by `steerRun` to decide
   * whether the turn a provider acknowledged can still rule a frame. Folding the
   * two would make one map's consume erase the other's fact.
   *
   * Insertion-ordered, and pruned to `CODEX_SETTLED_TURN_MEMORY` only while
   * `inFlightSteers` is zero — see that field and `rememberSettledTurn` for why
   * a plain cap here reads as liveness the session cannot vouch for.
   */
  readonly settledTurnIds: Set<string>;
  /**
   * How many `turn/steer` requests are awaiting an answer on this session.
   *
   * The claim predicate for `settledTurnIds`, and the exact analogue of
   * `inFlightTurnStarts` above: the only reader of that memory is the steer
   * acknowledgement continuation, so while this is zero NOTHING in it can be
   * asked about and pruning the oldest is provably free. While one IS in flight
   * the acknowledgement may name any turn id, so every entry is potentially the
   * one about to be read and none may be dropped.
   *
   * A count rather than a flag because a run may hold several live turns and
   * each can be steered independently; the pin has to outlast the LAST of them.
   */
  inFlightSteers: number;
  /**
   * Runs whose route an INTERRUPT retired while their turn's terminal was still
   * owed, keyed by the turn id that terminal will carry.
   *
   * `turn/interrupt` resolves when the provider accepts the interrupt, not when
   * the turn ends: the `turn/completed` notification follows, and it is the
   * frame the tripwire is ruled on. Retiring the route at interrupt — which is
   * correct, because the run must stop reporting an active turn immediately —
   * therefore leaves the later ruling with no run to report against, and a trip
   * would quarantine the session while the run's own subscribers heard nothing.
   * This map is the correlation that survives that gap, and it holds ONLY what
   * the reporting needs: a route here is not a live route, so `hasActiveTurn`
   * and the intervention paths still read the run as having no turn.
   *
   * Insertion-ordered and bounded by REFUSAL at `CODEX_INTERRUPTED_ROUTE_MEMORY`,
   * never by eviction — see the constant for why this memory, unlike
   * `unmatchedTurnEvidence` above, has no in-flight window outside which
   * pruning is provably free. An entry lives from an interrupt to the terminal
   * that immediately follows it, so anything that accumulates toward the
   * ceiling is a provider not terminating the turns it accepted interrupts
   * for. Released when the terminal is ruled, and collected with the record on
   * teardown or supersede.
   */
  readonly interruptedRunIdByTurnId: Map<string, RunId>;
}

/**
 * What was observed about a turn no correlated frame had been re-keyed onto yet.
 *
 * Both halves are needed and neither substitutes for the other: the in-flight
 * observations are what a `notLoaded` terminal cannot restate, and the terminal
 * classification is what says the turn is over. Ruling on the terminal alone
 * would trip a real turn whose item notifications shared the same read chunk.
 */
interface UnmatchedTurnEvidence {
  readonly observations: Set<TurnEvidenceClass>;
  /** The settling classification, once this turn's terminal has arrived. */
  terminal: TurnEvidenceClassification | undefined;
}

/**
 * How a session's own thread bases its usage registers at one establishment.
 *
 * A union rather than a bare string discriminant, so the resume arm cannot be
 * constructed without naming the thread whose prior-emitted sum it bases on.
 * The thread to base FROM is not always the thread being established: a
 * provider-native resume answers with the id it was handed, so the two
 * coincide there, but a REWIND forks — `thread/fork` mints a brand-new thread
 * the daemon has never emitted a single token against, so keying the lookup on
 * it would resolve to nothing on every rewind and silently base the successor
 * at zero. The predecessor's id is the only key the daemon's own emitted sum
 * exists under. Stated in the type so that omission is a compile error rather
 * than a re-meter nobody sees until a receipt.
 */
type CodexUsageEstablishment =
  | { readonly mode: "fresh" }
  | { readonly mode: "resume"; readonly priorEmittedThreadId: string };

/**
 * Gets or creates a turn's entry in a session's bounded FIFO evidence memory,
 * for the caller to record into — or `null` when the memory can neither make
 * room nor safely grow, which is a session-fatal condition.
 *
 * Re-inserted rather than skipped on a repeat so a later observation refreshes
 * the entry's position instead of aging out while still relevant — and so a
 * terminal MERGES into whatever in-flight evidence the same window already
 * collected rather than replacing it.
 *
 * ---------------------------------------------------------------------------
 * Eviction is scoped to entries nothing can claim, and never traded for room
 * ---------------------------------------------------------------------------
 *
 * An entry here is claimable by exactly one caller: the `startRun` continuation
 * that is about to be handed the turn id the provider named. A whole read chunk
 * drains SYNCHRONOUSLY while that continuation waits as a microtask, and child
 * threads multiplexed onto this connection are observed before any of them can
 * be routed — so a single large drain can push more entries through this memory
 * than it holds. Evicting oldest-first there discards the very terminal the
 * suspended continuation is owed, and the continuation then installs a live
 * route and a re-keyed frame whose only terminal has already gone by. Nothing
 * will ever rule that frame: a swallowed opening reported as a completed turn,
 * which is the one outcome the tripwire exists to prevent.
 *
 * So the claim window is read directly. While no `turn/start` is in flight on
 * this session, NOTHING in this memory can be claimed — turn ids are never
 * reused, so no future start can match an entry either — and oldest-first
 * eviction is provably free. While one IS in flight, every entry is potentially
 * the owed one, so none is evicted and the memory is allowed to grow to
 * `CODEX_UNMATCHED_TURN_MEMORY_CEILING`. At that ceiling the driver refuses
 * rather than choosing which evidence to lose, and the caller takes the loud
 * path. This is the same prune-then-refuse-and-never-evict discipline
 * `OutboundFrameTripwire.#admit` already states for the frame store, for the
 * same reason: discarding an entry to make room converts a future trip into a
 * silent pass.
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
    // Only a turn this memory does not already hold is refused. An entry that
    // is already here is always refreshed, whatever the size: it is one of the
    // claimable entries this refusal exists to protect, and dropping it to
    // report the overflow would make the refusal itself the loss.
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
 * Records that a turn's terminal has been ingested on this session — or refuses,
 * which is a session-fatal condition.
 *
 * Oldest-first and re-inserting on a repeat like the two memories above, and
 * unlike them never consumed: a turn that has ended stays ended, and a reader
 * that erased the fact by asking would hide it from the next one.
 *
 * ---------------------------------------------------------------------------
 * Eviction is scoped to entries nothing can ask about, and never traded for room
 * ---------------------------------------------------------------------------
 *
 * The one reader is the `turn/steer` acknowledgement continuation, which asks
 * whether the turn the provider named can still rule the steer's frame and takes
 * ABSENCE from this memory as yes. That makes eviction a fail-OPEN: an entry
 * dropped between its terminal and the question turns a settled turn back into a
 * live one, the frame is moved onto it, and no second terminal is ever coming.
 * The window is ordinary rather than exotic — a whole read chunk drains
 * SYNCHRONOUSLY while the continuation waits as a microtask, so a chunk carrying
 * the steer's own response plus a burst of terminals can push more ids through
 * this memory than it holds, and the acknowledged turn's own settlement is
 * exactly the entry a size-based prune throws away first.
 *
 * So the claim window is read directly, as `rememberUnmatchedTurn` above reads
 * its own. While no steer is in flight NOTHING here can be asked about — turn
 * ids are never reused, so a later steer cannot ask about an id from before it
 * either — and oldest-first pruning is provably free. While one IS in flight the
 * acknowledgement may name ANY id, so every entry is potentially the one about to
 * be read, none is evicted, and the memory may grow to
 * `CODEX_SETTLED_TURN_MEMORY_CEILING`. At that ceiling the driver refuses rather
 * than choosing which settlement to forget, and the caller takes the loud path.
 *
 * Returns whether the settlement was retained. `false` means the memory can no
 * longer hold what a live reader is owed, which is the same
 * prune-then-refuse-and-never-evict answer the frame store and the evidence
 * memory both give: discarding an entry to make room converts a future trip into
 * a silent pass.
 */
function rememberSettledTurn(record: CodexSessionRecord, turnId: string): boolean {
  const memory = record.settledTurnIds;
  if (
    !memory.has(turnId) &&
    record.inFlightSteers > 0 &&
    memory.size >= CODEX_SETTLED_TURN_MEMORY_CEILING
  ) {
    // Only a turn this memory does not already hold is refused, on the same
    // ground the evidence memory states: an id already here is one of the
    // entries the refusal exists to protect, and dropping it to report the
    // overflow would make the refusal itself the loss.
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
 * Retains an interrupted run's turn correlation so the terminal that follows can
 * still be reported against it — or refuses, which is a session-fatal condition.
 *
 * Refuse-and-never-evict like `rememberSettledTurn` below, not prune-like
 * `rememberUnmatchedTurn` above, because this memory has no free-prune window
 * at all: its readers — the terminal path and the abandoned-frame resolver —
 * can be asked about ANY retained entry at any time, and every entry is by
 * construction still owed its terminal (the terminal's arrival is what deletes
 * it). An evicted correlation is that terminal ruled against no run, so at the
 * ceiling the driver says it can no longer account for what it holds rather
 * than silently choosing whose report to lose.
 *
 * A turn id already held is re-inserted rather than refused, on the ground the
 * two siblings both state: an entry already here is one of the entries the
 * refusal exists to protect, and the re-insert only refreshes it.
 *
 * Returns whether the correlation was retained.
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

/**
 * The NEWEST live turn a run holds on one session, or `undefined`.
 *
 * The derived direction of the turn-keyed routes, and the tie-break is the
 * point: an intervention names a run and acts on the turn that run is currently
 * taking, so when two overlapping starts left two live turns the one the
 * participant means is the LATEST — the turn their words are landing in. The
 * routes are insertion-ordered by acceptance, so the last match is that turn.
 * Under the ordinary single-turn shape this is the only match and the tie-break
 * never fires.
 */
function newestActiveTurnForRun(record: CodexSessionRecord, runId: RunId): string | undefined {
  let newest: string | undefined;
  for (const [turnId, routedRunId] of record.runIdByActiveTurnId) {
    if (routedRunId === runId) {
      newest = turnId;
    }
  }
  return newest;
}

/** A session slot held for the duration of one in-flight lifecycle transition. */
interface CodexSessionTransition {
  readonly kind: CodexSessionTransitionKind;
  /** Settlement of the transition, rejection-swallowed so a chained waiter cannot inherit its failure. */
  readonly settled: Promise<void>;
}

/**
 * The slot states a TRANSITION can publish.
 *
 * Derived from `CodexSessionSlotState` by exclusion rather than restated, so the
 * two can never drift into disagreeing about what a slot can be: `live` is the
 * one state no transition holds, because it is what a settled record IS.
 */
type CodexSessionTransitionKind = Exclude<CodexSessionSlotState, "live">;

/**
 * True when a `turn/start` outcome leaves provider-side turn state AMBIGUOUS.
 *
 * The asymmetry is the argument, not the enumeration. At this seam the driver
 * cannot distinguish "the provider never saw it" from "the provider accepted it
 * and the answer was lost": over-killing costs one re-establish, while
 * under-killing leaves a turn executing tools with no route to interrupt it, no
 * id to address it by, and a session the daemon will happily reuse — so a retry
 * doubles the work against a turn nobody can see. The class is therefore WIDE and
 * closed from the OTHER end: a clean JSON-RPC error response is the single
 * exemption, because a provider answering "no" is proof it processed the request
 * and started nothing. A deadline, a transport death, and a response carrying an
 * unusable turn id all leave the same question open and are treated the same way.
 *
 * `#assertWritable`'s already-closed refusal lands in the ambiguous class too,
 * deliberately: the teardown it triggers is idempotent, so paying for it twice
 * costs nothing, and exempting it would key the exemption on a call-site proxy
 * rather than on the semantic question the classifier asks.
 *
 * ADR-029 is what makes the wide class affordable: the daemon's canonical
 * transcript is authoritative and every provider session is a replay target, so
 * ambiguity about provider-side turn state is never worth carrying. Teardown and
 * replay is the designed recovery — deliberately NOT a `turn/started`
 * reconciliation, which would keep alive a turn the daemon has just reported as
 * having failed to start, and owe interrupt machinery for it.
 */
function isAmbiguousTurnStartOutcome(cause: unknown): boolean {
  return !(cause instanceof CodexProviderRequestError);
}

/**
 * Resolves the credential policy for the posture a RESUME is being established
 * under.
 *
 * Injected, asynchronous, and called PER SPAWN THAT STATES A POSTURE — on a
 * create exactly as on a resume, never at construction and never cached — so
 * the posture the request carries governs the child that request spawns, rather
 * than whichever policy happened to be in force when the session was first
 * created or was declared beside the posture in an untyped config bag.
 *
 * Handed the whole posture rather than the `credentialPolicyRef` inside it: this
 * driver reads no credential axis and expands no reference, which is the same
 * reason `#composeThreadEstablishmentLegs` forwards none. Called ONLY for a
 * posture whose `mode` is not `trusted`, and that is a fact of the type rather
 * than a convention — the trusted arm declares `credentialPolicyRef?: never`, so
 * there is nothing for a resolver to resolve.
 *
 * Answering `undefined` for a posture that carries a reference is a WIRING
 * FAULT, not a licence to strip nothing: the spawn refuses rather than
 * launching the child unfiltered.
 */
export type CodexCredentialEnvPolicyResolver = (
  posture: ExecutionPosture,
) => Promise<CredentialEnvPolicy | undefined>;

/** Construction inputs for the lifecycle manager. */
export interface CodexLifecycleOptions extends CodexConnectionOptions {
  /**
   * Spawn context for a RESUME when this process holds no record of the session
   * (the daemon-restart case, which is the ordinary one), and for the auth
   * probe, which holds no session at all.
   *
   * `ResumeSessionParams` carries neither `cwd` nor `env`, yet a spawn needs
   * both — and an empty environment is not a safe default: the provider locates
   * its credential home and its own tooling through environment variables, so a
   * resume launched bare would fail in a way that looks like a bad handle. The
   * resumed THREAD restores its own recorded working directory through
   * `thread/resume`, so `cwd` here is the process's directory rather than the
   * thread's. Required, never defaulted, so nothing is silently inherited from
   * the daemon process (this module reads `process.env` nowhere).
   *
   * WHAT ITS `credentialEnvPolicy` GOVERNS, stated because this driver has three
   * policy channels and conflating them is exactly how a stale policy reaches a
   * child:
   *
   *   * a CREATE that states a posture takes
   *     {@link CodexCredentialEnvPolicyResolver}'s answer for THAT posture, so
   *     this member's policy is not what such a create spawns under either. A
   *     create that states NO posture falls back to its own `params.config`
   *     policy, an untyped bag validated through
   *     {@link parseCodexSessionConfig} — which is what makes a malformed
   *     `credentialEnvPolicy` a refusal rather than a strip that silently
   *     removes nothing, and which is parsed on EVERY create whether or not a
   *     posture then supersedes its answer;
   *   * a RESUME that states a posture takes
   *     {@link CodexCredentialEnvPolicyResolver}'s answer for THAT posture, so
   *     this member's policy is never what such a resume spawns under. A resume
   *     that states NO posture inherits its base context's own policy, where
   *     inheriting is the conservative answer and widening would be the
   *     fail-open one — and this member is that base context only on a COLD
   *     resume; a LIVE one inherits from the record's own `spawnConfig`;
   *   * the AUTH PROBE spawns under this member's policy directly. The probe is
   *     posture-less by construction — it claims no session and answers a
   *     node-level question — so this is the only policy it can have.
   *
   * PROVENANCE. This value is CONSTRUCTION-TIME and typed: the composition root
   * supplies an already-resolved `CodexSessionConfig`, so it is validated by the
   * type system rather than at a parse boundary. A future construction root that
   * sources it from untyped input — configuration file, IPC payload, restored
   * record — must pass it through {@link parseCodexSessionConfig} first;
   * assigning an unvalidated bag here would put the deny strip's fail-closed
   * behaviour back at risk on the probe path, which is the one spawn path whose
   * policy still comes from here and which has no other parse.
   */
  readonly resumeSpawnConfig: CodexSessionConfig;
  /**
   * Answers a spawn's credential policy from the posture that spawn STATES —
   * the create request's and the resume request's alike.
   *
   * REQUIRED, on the same reasoning as `onTextNeutralizationFailure` and
   * `diagnostics` below. An optional arm would let a construction site that
   * simply never bound it fall back to a manager-wide policy that cannot
   * represent a per-session one — and a session whose posture tightened between
   * create and resume would relaunch under the looser policy with nothing
   * anywhere reporting it.
   */
  readonly resolveCredentialEnvPolicy: CodexCredentialEnvPolicyResolver;
  /** Mints `DriverResumeResult.bindingId`; supply the store's minter in the daemon. */
  readonly newBindingId?: (() => string) | undefined;
  /**
   * Answers the routed server requests with session and run identity attached
   * (T3.15 leg 3). The manager wraps it per connection and OVERRIDES the
   * transport-level `serverRequestResponder` with the wrapper, so a caller
   * cannot accidentally bind an identity-less responder to a session whose asks
   * need one.
   */
  readonly answerServerRequest?: CodexSessionServerRequestResponder | undefined;
  /**
   * This leg's declared text-neutrality parity grade (T3.18).
   *
   * Defaults to `emulated`, the grade `Spec-005 §Parity Capability Mechanism
   * Grades` records. The grade is a behavioral INPUT rather than a label, and
   * it is injected rather than derived from the driver's name so that a
   * re-grade is a one-value change with no code path behind it.
   *
   * Worth stating plainly, because the measurement invites the opposite
   * conclusion: this transport was probed at the pin and performs NO
   * client-side command parsing (`docs/reference/provider-wire/codex.md`). The
   * default is still `emulated`, because the spec's cell governs the code and
   * an amendment governs the cell — not a driver that re-grades itself against
   * a probe.
   */
  readonly textNeutralityMechanismGrade?: TextNeutralityMechanismGrade | undefined;
  /** Correlation minting for outbound text frames (T3.18). Injectable for tests. */
  readonly mintOutboundFrameCorrelationId?: (() => string) | undefined;
  /**
   * Receives the run terminal a text-neutralization tripwire trip produces
   * (T3.18). PRODUCER-ONLY: the driver states that the run failed and why, and
   * the emission pipeline mints the envelope. The trip never raises a JSON-RPC
   * error, so this is how the failure becomes visible.
   *
   * REQUIRED for the same reason `diagnostics` below is: this is the ONLY
   * user-visible surface a trip has. An optional arm would let a construction
   * site that simply never bound it swallow the run terminal, leaving a
   * neutralized turn indistinguishable from a completed one.
   */
  readonly onTextNeutralizationFailure: (
    sessionId: SessionId,
    runId: RunId,
    failure: TextNeutralizationRunFailure,
  ) => void;
  /**
   * The daemon-wide diagnostic band (T3.11).
   *
   * REQUIRED, and separate from `reportDiagnostic` on purpose: that sink is the
   * TRANSPORT channel — malformed frames, dead connections, unrouted requests —
   * while this one carries the POLICY facts the parity legs are obliged to
   * surface, `subagent_definition_disabled` among them. A leg whose fail-closed
   * record could be dropped because a sink was left unbound would be fail-closed
   * in name only, so there is no optional arm here.
   */
  readonly diagnostics: DriverDiagnosticsEmitter;
  /**
   * The daemon's own prior-emitted cumulative token sums for one thread, used
   * to base a PROVIDER-NATIVE RESUME (T3.11).
   *
   * Optional because the driver cannot rebuild it: the sums live in the
   * canonical event record, which the daemon owns and this module never reads.
   * Unbound, a resume bases at zero and the first post-resume reading re-meters
   * the whole provider-session total — recorded as a diagnostic rather than
   * left to be discovered on a receipt.
   */
  readonly readPriorEmittedUsage?:
    | ((sessionId: SessionId, threadId: string) => CumulativeAxisReadings | undefined)
    | undefined;
  /**
   * Receives each metered per-turn usage delta (T3.11). PRODUCER-ONLY here: the
   * driver states what was spent and the emission pipeline mints the
   * `usage_telemetry` envelope, so no driver mints a session event.
   */
  readonly onMeteredUsage?: ((sessionId: SessionId, delta: MeteredUsageDelta) => void) | undefined;
  /**
   * Receives the `subagent.started` / `subagent.completed` pair for each
   * provider-attributed child thread (T3.11). PRODUCER-ONLY, and the child's
   * ONLY timeline presence: a registered child's content and lifecycle frames
   * are transcript-suppressed, so this pair survives the suppression rather
   * than sharing it.
   */
  readonly onSubagentLifecycle?:
    | ((sessionId: SessionId, emission: SubagentLifecycleEmission) => void)
    | undefined;
}

/**
 * One inbound Codex notification as the thread-frame router sees it, with its
 * payload carried along.
 *
 * The payload rides the frame because a HELD frame must still be deliverable:
 * the router releases pending holds when the registration they were waiting for
 * lands, and a release that handed back only the routing members would have
 * shed the frame's content — which is the loss the pending hold exists to
 * prevent.
 */
interface CodexRoutableFrame extends RoutableProviderFrame {
  readonly params: unknown;
}

/**
 * The router's bounds for a Codex session.
 *
 * The quarantine is a DIAGNOSTIC buffer and the hold is a delivery buffer, so
 * they are sized differently on purpose. The hold covers one race — child
 * traffic arriving ahead of its own `thread/started` — which is short and
 * narrow; the timeout is the outer bound on that race and is deliberately far
 * below any human-visible latency, because a frame held longer than this is not
 * racing a registration, it is naming a thread that will never be announced.
 */
const CODEX_THREAD_FRAME_ROUTER_CONFIG: ThreadFrameRouterConfig = Object.freeze({
  maxQuarantinedFrames: 64,
  maxPendingHoldFrames: 128,
  pendingRegistrationTimeoutMs: 5_000,
});

/**
 * Read the thread identity a Codex frame carries.
 *
 * TOTAL and NON-THROWING: this runs inside the transport's `#ingest` drain, so
 * a throw here would unwind the read-chunk loop and take unrelated frames down
 * with it. An unreadable identity is `null`, which the router refuses
 * fail-closed on a thread-scoped family — the correct disposition for a frame
 * whose own shape did not say whose stream it came from.
 *
 * `thread/started` is read from its `Thread` body; every other thread-scoped
 * family carries the identity at the top level of `params`.
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
 * Read a `thread/started` notification's child announcement, or `null` when the
 * frame does not describe a child.
 *
 * Non-throwing for the same reason as {@link readCodexFrameThreadId}. A frame
 * naming no parent is not a child announcement at all — the router would refuse
 * the registration anyway, and dispatching one would spend a diagnostic on a
 * frame that is simply the session's own thread starting.
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
 * Read one `thread/tokenUsage/updated` frame into a cumulative usage reading.
 *
 * Returns `null` where the frame carries no usable thread identity or no
 * breakdown at all; a reading with SOME axes present is admitted, because the
 * accountant meters per axis and refusing the whole frame for one missing
 * member would drop spend the provider did report. Non-finite and unknown
 * members are the accountant's to refuse, not this reader's — one filter, in
 * one place.
 */
function readCodexCumulativeUsageReading(params: unknown): CumulativeUsageReading | null {
  const payload = isPlainObject(params) ? params : {};
  const threadId = payload["threadId"];
  if (typeof threadId !== "string" || threadId.length === 0) {
    return null;
  }
  const turnId = payload["turnId"];
  // `tokenUsage` is the container's PINNED member name, not a guess and not an
  // alias set: the generated `ThreadTokenUsageUpdatedNotification` is
  // `{ threadId, turnId, tokenUsage: ThreadTokenUsage }`, and `ThreadTokenUsage`
  // carries the required `total` (cumulative) beside the required `last`
  // (declared per-turn). No second spelling is accepted — a tolerated alias
  // that no source attests would turn a future wire rename from a recorded
  // rejection into a silent metering stop, which is the failure this whole
  // band exists to prevent.
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
 * Map one Codex `TokenUsageBreakdown` onto the accountant's axis vocabulary.
 *
 * `null` for a value that is not an object at all. Members are copied only when
 * the wire carries a number, so an absent axis stays absent rather than
 * becoming a zero — a fabricated zero would meter a negative delta on the next
 * reading and trip the floor arm for a member the provider never reported.
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

/**
 * Whether a `turn/completed` frame's `turn.status` ends the turn.
 *
 * Shared by the route-retirement path and the child-completion path so the two
 * cannot disagree about what a finished turn is.
 */
function readCodexTerminalTurnStatus(params: unknown): boolean {
  const payload = isPlainObject(params) ? params : {};
  const turn = isPlainObject(payload["turn"]) ? payload["turn"] : {};
  const status = turn["status"];
  return typeof status === "string" && CODEX_TERMINAL_TURN_STATUSES.has(status);
}

/**
 * The five lifecycle operations of `Spec-005 §Required Behavior`, expressed as
 * Codex `app-server` calls over one connection per session.
 */
export class CodexLifecycleManager {
  readonly #options: CodexLifecycleOptions;
  readonly #newBindingId: () => string;
  readonly #turnStartTimeoutMs: number;
  // T3.18. The writer is the ONLY composer of provider-bound text bytes on this
  // leg — both `turn/start` and `turn/steer` take their input element from a
  // frame it minted, and neither can build one itself. The tripwire correlates
  // each written frame with the turn that settles it; the quarantine holds
  // bindings a trip disposed.
  readonly #outboundTextFrameWriter: OutboundTextFrameWriter;
  readonly #outboundFrameTripwire: OutboundFrameTripwire;
  readonly #providerBindingQuarantine = new ProviderBindingQuarantine();
  readonly #sessions = new Map<SessionId, CodexSessionRecord>();
  // The P1-1 producer half. One gate per session, latched at the top of
  // `closeSession`; the terminal-emission boundary in `event-normalizer.ts` is
  // the CONSUMER that stamps the flag on the terminal payload, because that is
  // the module that owns the terminal frame.
  //
  // Keyed beside the record map rather than carried on `CodexSessionRecord`:
  // the intent must be recordable while the slot is ESTABLISHING or CLOSING —
  // states that hold no installed record — and a close arriving during an
  // establishment is exactly the case where mis-reading a clean shutdown as a
  // crash would be most misleading.
  readonly #terminalEmissionGates = new Map<SessionId, CodexTerminalEmissionGate>();
  // The T3.11 child-routing and usage-delta band, one instance of each per
  // provider session and held for that session's lifetime — the state
  // `Spec-005 §Interfaces And Contracts` describes as driver-session state, so
  // it is constructed here rather than composed from outside. Keyed beside the
  // record map for the same reason the gate is: a frame can arrive while the
  // slot is still ESTABLISHING, and a router that did not exist yet would shed
  // it.
  readonly #frameRouters = new Map<SessionId, ThreadFrameRouter<CodexRoutableFrame>>();
  readonly #usageAccountants = new Map<SessionId, UsageDeltaAccountant>();
  readonly #sessionIdByRunId = new Map<RunId, SessionId>();
  /**
   * Session ids with a lifecycle transition in flight, mapped to its kind and a
   * rejection-swallowed view of its settlement.
   *
   * ONE mechanism for both directions, which is the correction. An earlier shape
   * tracked establishments only, and that left teardown unguarded: `closeSession`
   * deleted the record and THEN awaited an unsubscribe and a process close, so
   * for the length of those awaits the slot read as empty while the child was
   * still exiting — and a create could admit a second process beside it. The rule
   * is now symmetric and has no direction in it: a slot is held from the first
   * synchronous instant of a transition until that transition has fully settled.
   */
  readonly #sessionTransitions = new Map<SessionId, CodexSessionTransition>();

  constructor(options: CodexLifecycleOptions) {
    this.#options = options;
    this.#newBindingId = options.newBindingId ?? ((): string => randomUUID());
    this.#turnStartTimeoutMs = options.turnStartTimeoutMs ?? DEFAULT_TURN_START_TIMEOUT_MS;
    this.#outboundTextFrameWriter = new OutboundTextFrameWriter({
      mechanismGrade: options.textNeutralityMechanismGrade ?? "emulated",
      mintCorrelationId: options.mintOutboundFrameCorrelationId,
    });
    // Constructed here rather than as a field initializer because the predicate
    // reads two fields declared after it, and a field initializer that captured
    // them would depend on declaration order to be correct.
    //
    // A session is retired once this manager no longer holds its record — the
    // teardown and supersede paths delete it — or once a trip has quarantined
    // the binding. Either way no turn on it can ever settle, so the frames it
    // left pending are owed no ruling and are pure occupancy. This is the only
    // reclamation the tripwire performs, and it is consulted only when a write
    // would otherwise be refused.
    this.#outboundFrameTripwire = new OutboundFrameTripwire({
      isScopeRetired: (scopeKey: string): boolean =>
        !this.#sessions.has(scopeKey as SessionId) ||
        this.#providerBindingQuarantine.isSessionDisposed(scopeKey),
    });
  }

  /**
   * Composes the one provider-bound text frame for a run's opening turn
   * (T3.18), and registers it with the tripwire under the run id.
   *
   * Registered under the RUN id and re-keyed to the turn id the moment the
   * provider names one, because the correlation has to exist before the write:
   * a turn that settles the instant the text lands would otherwise settle
   * against nothing and let a swallow through. `startRun`'s own failure path
   * drops THIS frame's registration — and only this frame's — on every path
   * where no turn will ever settle it.
   *
   * A REFUSED registration aborts the run before any byte is written, and that
   * ordering is the point: the frame is composed, offered to the tripwire, and
   * only then handed to `turn/start`. A caller must not send provider-bound
   * text the tripwire cannot watch, because a turn that settles against no
   * correlated frame passes — so taking the write anyway would convert this
   * session's backlog into a silent swallow on the very next turn.
   *
   * @throws {OutboundFrameCapacityRefusedError} when this session is holding
   *   more unsettled frames than the tripwire will watch.
   */
  #composeRunOpeningFrame(params: StartRunParams, runConfig: CodexRunConfig): OutboundTextFrame {
    // The origin is MINTED here from a literal rather than carried in from the
    // caller's config bag. A run's opening text is the participant's message by
    // construction on this path, and the arm a caller could otherwise have named
    // — `driver_command` — is the one that skips neutralization and exempts the
    // turn from the tripwire, so leaving it nameable through an untyped record
    // would put both halves of the hazard in a caller's hands. `parseCodexRunConfig`
    // refuses a declared origin; this is where the true one is stated.
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
    // Refused BEFORE anything is spawned, so a mis-sequenced caller costs no
    // process. See `CodexSessionAlreadyLiveError` for why replacing is wrong.
    //
    // The check reads EVERY view of the slot, and there is no `await` between
    // this read and the claim below. A create that tested only `#sessions` would
    // be a synchronous guard in front of two suspensions: two overlapping creates
    // for one session id would both pass it, both spawn, and the later install
    // would orphan the earlier process with nothing holding a reference to close
    // it. A `closing` holder refuses for the same reason and not a weaker one —
    // the child of a session mid-teardown is still alive, and still this
    // manager's to dispose.
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
    // Composed — and therefore REFUSED — before the connection object exists, so
    // a posture this manager cannot resolve costs no process. The resume path
    // composes inside its own `try` because I-005-5 owes it a typed `failed`
    // result; `createSession` has no result type to refuse into, so its refusal
    // is the same typed `CodexDriverConfigError` its config parse already raises.
    const config = await this.#composeCreateSpawnConfig(params);
    const connection = new CodexAppServerConnection(this.#connectionOptionsFor(params.sessionId));
    try {
      // Inside the guard: `open()` tears its own process down on the paths it
      // owns, but a caller-supplied subscriber that throws is not one of them,
      // and `close()` is idempotent, so guarding here costs nothing and closes
      // the window.
      await connection.open(config);
      const response = await connection.request("thread/start", {
        cwd: config.cwd,
        // Legs 5 and 4. Spread rather than always-present: a session with no
        // declared posture must not be given one by this driver, because
        // inventing `read-only` would refuse tool calls the daemon admitted and
        // inventing `danger-full-access` would grant what it did not.
        ...this.#composeThreadEstablishmentLegs(params.executionPosture, params.subagentPolicy),
        // Pinned as defense in depth so no config or profile override can select
        // an auto-review path that bypasses the daemon's approval pipeline.
        // `ThreadStartParams` carries this field (verified against the pinned
        // binary's own generated schema at `codex-cli 0.150.1`, regenerated
        // 2026-08-28 — `docs/reference/provider-wire/codex.md`), so the pin is
        // accepted rather than an unknown-field risk. It is NOT sufficient on its
        // own: see the per-turn pin in `startRun`.
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
      // The quarantine names a BINDING, not an identifier: a fresh process now
      // answers for this session id, so the refusal a prior trip installed is
      // released here rather than outliving the process it condemned.
      this.#providerBindingQuarantine.releaseSession(params.sessionId);
      // A daemon-created thread bases at ZERO and meters its first reading in
      // full: the provider's counter starts at zero, replay seeding spends
      // nothing, and the first turn's large input is real billed spend.
      this.#bindSessionThread(params.sessionId, thread.id, { mode: "fresh" });
      // `id` is the resume key; `sessionId` groups a thread tree (fork/subagent
      // threads share it), so the two are NOT interchangeable.
      return { providerSessionId: thread.sessionId, resumeHandle: thread.id };
    } catch (cause) {
      // Contained, not bare. `close()` can throw a caller-supplied disposer's
      // fault, and a bare `await connection.close()` here let that fault escape
      // BEFORE the rethrow — so a spawn or handshake failure was replaced by a
      // teardown artifact and the actionable cause was lost. Same reasoning as
      // the resume path, which has always contained it.
      await this.#releaseAbandonedConnection(connection);
      throw cause;
    }
  }

  /**
   * Resumes an existing Codex thread from its provider-owned handle.
   *
   * I-005-5: every failure path returns the typed `failed` result. This method
   * calls no session-creating operation, and the process it spawns is bound to
   * `thread/resume` alone — a failed resume tears that process down and reports,
   * it never converts into a fresh thread.
   */
  async resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    // Resume CLAIMS the slot rather than refusing a held one, which is a
    // deliberate divergence from the Claude leg (which refuses): this driver
    // supersedes a live leg on resume and releases it explicitly, so serializing
    // behind the holder is what makes that release reachable. A resume that read
    // the slot as empty mid-establishment would find `existing === undefined`,
    // install over the winner, and orphan its process. The same chaining carries
    // it behind a `closing` holder, where the correct behaviour is likewise to
    // wait rather than refuse: once that teardown settles there is simply nothing
    // to supersede, and the resume establishes cleanly.
    return await this.#claimSessionSlot(
      params.sessionId,
      "establishing",
      async () => await this.#establishResumedSession(params),
    );
  }

  /**
   * Builds the spawn context a create launches under.
   *
   * TWO SOURCES, split exactly as `#composeResumeSpawnConfig` splits them. The
   * PROCESS CONTEXT — `cwd` and `env` — is the create request's own, parsed
   * fail-closed out of its untyped `params.config`. The CREDENTIAL POLICY is
   * posture-derived, and that binding is what this method exists for: the bag
   * and the posture are two channels making one claim, and before they were
   * joined a `CreateSessionParams` carrying a sandboxed posture whose bag simply
   * omitted `credentialEnvPolicy` opened its child with nothing stripped — the
   * silence read as "deny nothing" even though the posture required a policy.
   *
   * The parse runs on EVERY create, whether or not the posture then supersedes
   * its answer, because a malformed policy must stay a refusal rather than
   * becoming dead input the posture happens to overwrite.
   *
   * Constructed member-by-member rather than spread-then-override for the reason
   * the resume path states: a spread carries the bag's `credentialEnvPolicy`
   * through whenever the posture resolves to none, which is precisely the
   * unwanted-policy path this binding closes.
   */
  async #composeCreateSpawnConfig(params: CreateSessionParams): Promise<CodexSessionConfig> {
    const declared = parseCodexSessionConfig(params.config);
    const credentialEnvPolicy = await this.#resolveCredentialEnvPolicyForPosture(
      declared.credentialEnvPolicy,
      params.executionPosture,
      "CreateSessionParams.executionPosture.credentialPolicyRef",
    );
    return {
      cwd: declared.cwd,
      env: declared.env,
      ...(credentialEnvPolicy === undefined ? {} : { credentialEnvPolicy }),
    };
  }

  /**
   * Builds the spawn context a resume relaunches under.
   *
   * TWO SOURCES, deliberately split, because they answer different questions.
   * The PROCESS CONTEXT — `cwd` and `env` — is not posture-derived: it says
   * where the provider binary runs and how it finds its credential home, and a
   * live record's own context is the better answer than the manager-wide
   * default because it is the context this session was actually established in.
   * The CREDENTIAL POLICY is entirely posture-derived, and inheriting it is the
   * bug this split exists to close: a session created under a `trusted` posture
   * and resumed under a sandboxed one would otherwise relaunch with the
   * unfiltered environment it was created with, and the reverse — sandboxed
   * create, `trusted` resume — would keep stripping names the current posture
   * denies nothing about.
   *
   * Constructed member-by-member rather than spread-then-override for the same
   * reason: a spread carries the base's `credentialEnvPolicy` through whenever
   * the posture resolves to none, which is precisely the stale-policy path.
   * Nothing here is inherited that was not named here.
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
    return {
      cwd: processContext.cwd,
      env: processContext.env,
      ...(credentialEnvPolicy === undefined ? {} : { credentialEnvPolicy }),
    };
  }

  /**
   * Answers which credential policy a spawned child is filtered by.
   *
   * ONE RULE, TWO CALLERS — the create composer and the resume composer both
   * reach it, and that sharing is the contract rather than a convenience. A
   * sibling copy on the create path is how the two spawn paths came apart in the
   * first place: a resume that re-derived and a create that read only its config
   * bag disagreed about the same session, and the disagreement was invisible
   * because each path was locally consistent. A future third spawn path inherits
   * the rule by calling this, or it is a fourth answer to a settled question.
   *
   * THREE ARMS, each derived from what `ExecutionPosture` can actually say
   * rather than from a convention:
   *
   *   * NO POSTURE STATED. The request declares nothing, so there is no posture
   *     to derive from and the policy its own context declared stands — the
   *     resume's base process context, the create's parsed config bag.
   *     Inheriting is the conservative arm; the alternative, resolving to
   *     nothing, would WIDEN an unfiltered child out of a caller's silence.
   *   * `trusted`. The arm types `credentialPolicyRef?: never`, so the posture is
   *     a positive statement that nothing is denied, and a policy sitting beside
   *     it in the context is a wiring inconsistency rather than a stricter grant
   *     the posture made. Dropped rather than honoured, on BOTH paths, for the
   *     symmetry this helper exists to hold: honouring it on create while the
   *     resume drops it would rebuild the very asymmetry being closed, mirror
   *     imaged — one session stripping on create and not on relaunch. The
   *     posture a request states is the authority; neither the session's history
   *     nor an untyped bag beside it is.
   *   * SANDBOXED. Both remaining arms REQUIRE `credentialPolicyRef`, so a
   *     resolution is owed and an absent one is a wiring fault. Refused rather
   *     than degraded to "deny nothing", which would spawn the child holding
   *     exactly the credentials the reference exists to withhold — the same
   *     fail-closed rule {@link parseCodexSessionConfig} applies to a malformed
   *     policy in a config bag.
   *
   * `postureRefusalField` is the caller's own parameter path, passed rather than
   * fixed here so the refusal names the request the operator actually sent.
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
    // Read INSIDE the claimed establishment, never at the call site: the claim
    // chains behind any predecessor, so this read must happen after that
    // predecessor has installed its record for the supersede to see it.
    const existing = this.#sessions.get(params.sessionId);
    const connection = new CodexAppServerConnection(this.#connectionOptionsFor(params.sessionId));
    try {
      // Composed INSIDE the `try`, and the placement is load-bearing rather than
      // tidy: the composition RESOLVES a posture's policy and refuses a posture
      // it cannot resolve, so raising it at the call site above would let that
      // refusal escape `resumeSession` as an exception. I-005-5 requires every
      // resume failure to arrive as the typed `failed` result, and this catch is
      // what makes it one.
      const spawnConfig = await this.#composeResumeSpawnConfig(existing, params);
      await connection.open(spawnConfig);
      const response = await connection.request("thread/resume", {
        threadId: params.resumeHandle,
        // CP-005-1: a resume is a FRESH SPAWN, so every spawn-bound leg is
        // re-realized rather than inherited. `ThreadResumeParams` carries the
        // same override members as `ThreadStartParams` at the pin, and a resume
        // that omitted them would run under whatever posture and subagent caps
        // the provider reloaded from the thread's own persisted config — a
        // second source of truth for a policy the daemon owns.
        ...this.#composeThreadEstablishmentLegs(params.executionPosture, params.subagentPolicy),
        // The same defense-in-depth pin as `thread/start`; `ThreadResumeParams`
        // carries the field at the pin (verified 2026-08-27 against the binary's
        // generated schema). A resumed thread must not inherit an auto-review
        // reviewer from whatever config the provider reloads with it.
        approvalsReviewer: "user",
      });
      const thread = readThread(response, "thread/resume");
      this.#assertPostureRealized(params.executionPosture, response);
      // I-005-5's identity gate, and it runs BEFORE the position check because it
      // is the stronger one. Codex may answer a resume it cannot honour by
      // handing back a DIFFERENT thread; for a zero-turn session that thread has
      // `turns: []`, which is a perfectly well-formed history, so the position
      // check below cannot tell it from a genuine resume. Only the id can.
      // Adopting it would be the silent replacement this invariant forbids.
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
        // `Thread.turns` is populated on `thread/resume` by contract. If it is
        // absent we cannot know the position, and fabricating 0 would make a
        // silently-fresh thread indistinguishable from a resumed one — the exact
        // confusion I-005-5 exists to prevent. Refuse instead.
        throw new CodexTransportError(
          "The Codex app-server resume response carried no turn history, so the session position is unknown.",
          { threadId: thread.id },
        );
      }
      // Built and VALIDATED before the swap, never after it. `bindingId` is
      // minted by a caller-supplied function and bounded by the schema's
      // `wireFreeFormString`, so an empty or overlength mint THROWS — and when
      // that throw landed after the record was installed and the predecessor
      // released, the catch below closed the new connection and left the session
      // mapped to it: create refused the session as live, every request on it hit
      // a dead transport, and only another resume could clear it. Minting and
      // parsing first makes the swap all-or-nothing, which is what lets the catch
      // path keep its promise that a failed resume changes nothing.
      const resumedResult = DriverResumeResultSchema.parse({
        status: "resumed",
        bindingId: this.#newBindingId(),
        sessionPosition: thread.turns.length,
      });
      // Resume is a FRESH SPAWN, so the withholding is re-reported rather than
      // inherited: the resumed leg offers the provider no callback-tool
      // registry either, and a report emitted only on the create path would
      // make a long-lived resumed session look as though it had one.
      this.#reportWithheldCallbackTools(params.sessionId, params.callbackTools);
      this.#sessions.set(params.sessionId, {
        sessionId: params.sessionId,
        connection,
        threadId: thread.id,
        // Seeded from the resumed thread's own history, so a rewind after a
        // resume indexes the SAME axis the pre-restart session did. An empty
        // seed would make every position on a resumed leg unresolvable.
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
      // Released for the same reason the create path releases it: a resume is a
      // fresh spawn, so the condemned binding is gone.
      this.#providerBindingQuarantine.releaseSession(params.sessionId);
      // A provider-native resume bases at the daemon's OWN prior-emitted
      // cumulative sum, never at the first post-resume reading: the provider's
      // counter is unaffected by the resume, so a zero base would re-meter the
      // whole pre-resume history onto the first post-resume turn.
      //
      // Keyed on the SAME id it establishes, and that is the resume case rather
      // than an assumption: a resume answers with the thread it was handed, so
      // the id the daemon emitted spend under and the id being based are one.
      // The rewind path is where the two come apart.
      this.#bindSessionThread(params.sessionId, thread.id, {
        mode: "resume",
        priorEmittedThreadId: thread.id,
      });
      // The frames the predecessor left unsettled are failed on their runs
      // BEFORE any route is swept, and that ordering is the mechanism rather
      // than a preference: `#forgetRunRoutes` clears `#sessionIdByRunId`, which
      // is the third and last source `#runIdForAbandonedFrame` consults, so a
      // sweep first would leave the frames with no run to report against.
      //
      // Not ruled fail-closed, unlike the quarantine teardown path, and not
      // dropped either — the two arms this path used to have to choose between.
      // A trip claims the provider swallowed the text, which nothing observed
      // here; a drop claims nothing at all, and a participant's words vanish
      // behind a session that resumed cleanly. `abandonScope` states the third
      // thing, which is the true one: the answer became unreachable when the
      // binding was superseded, and it will never arrive. The run fails on that.
      //
      // The superseded runs are deliberately NOT quarantined. A quarantine
      // condemns a binding, and this one is already gone — the fresh process is
      // exactly where any future work on those runs belongs, and refusing them
      // would take their interrupt and intervention controls away for nothing.
      this.#failSupersededDeliveries(existing, params.sessionId);
      // The replacement record starts with an empty turn map, so every route
      // that pointed at the superseded leg is now dead. Swept here rather than
      // at teardown: `closeSession` reads the LIVE record, which no longer knows
      // those runs, so a route left behind would never be collected and the map
      // would grow by one entry per in-flight run per resume, for the daemon's
      // whole lifetime.
      this.#forgetRunRoutes(params.sessionId);
      // A no-op in the ordinary case: `#failSupersededDeliveries` consumed the
      // scope's registrations already. Kept because it is the budget release's
      // one and only home, and a scope that somehow held a frame no record could
      // explain must still not hold its budget forever.
      this.#releaseOutboundFrameBudget(params.sessionId);
      // A resume is a fresh spawn, so any prior leg for this session is now
      // superseded and its process would otherwise be orphaned. Released AFTER
      // the new record is installed, which is what keeps a FAILED resume
      // non-destructive: on the catch path below, the prior leg is still the
      // live one and is left exactly as it was found.
      if (existing !== undefined) {
        await this.#releaseAbandonedConnection(existing.connection);
      }
      return resumedResult;
    } catch (cause) {
      // Quietly: teardown of the leg that just failed must not throw past the
      // typed result. A close that escaped here would turn the `recovery-needed`
      // condition back into an exception, which is exactly the loss I-005-5
      // forbids.
      // Classified BEFORE the release, because the classification asks this very
      // connection whether the credential is still good (P3-3). A refused resume
      // leaves the transport open, so the child is still there to answer.
      const recoveryCondition = await classifyResumeRecoveryCondition(connection, cause);
      await this.#releaseAbandonedConnection(connection);
      return DriverResumeResultSchema.parse({
        status: "failed",
        recoveryCondition,
        // The driver observed a refused resume, not the span of work that was in
        // flight; classifying that span needs run state the driver does not hold.
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
    // Raised BEFORE the request and lowered the instant its answer is in hand.
    // This is the window in which a terminal ingested by the synchronous read
    // drain may belong to the turn this call is about to be handed, and it is
    // exactly the window in which `rememberUnmatchedTurn` must not evict. It is
    // lowered in a `finally` rather than after the consume below because
    // everything from the answer to the consume is one synchronous run — no
    // notification can be ingested in between — so the shorter, exception-safe
    // scope costs nothing and cannot leak a raised counter onto a failed start.
    record.inFlightTurnStarts += 1;
    try {
      turnId = readTurnId(
        await this.#requestTurnStart(record, runConfig, params, openingFrame),
        "turn/start",
      );
    } catch (cause) {
      // The OPENING frame's counterpart of the steer classification below, and
      // deliberately not the same shape. The ambiguous class exists here too: a
      // `turn/start` can time out or lose its connection after the bytes were
      // written, and the provider may have intercepted the text and answered a
      // zero-turn success exactly as a steer's can be intercepted.
      //
      // FRAME-SCOPED, and the scope is the whole point. The join key is the RUN
      // id until the provider names a turn, and nothing serializes two starts
      // for one run — so a second attempt that registered while this one was in
      // flight is correlated under the very same key. A key-wide drop here would
      // take that live frame with it, its turn would then settle against no
      // correlated frame, and a settle with nothing correlated PASSES: the
      // swallowed turn reported as a completed one, which is the outcome the
      // tripwire exists to catch. The Claude leg reaches the same scoping from
      // the other side: `#ruleFailedOpeningFrame` there acts FRAME-scoped on
      // both arms where it acts at all — dropping the provably-unsent frame,
      // ruling the dead-channel one — for the stated reason that a sibling
      // frame on the same key whose delivery was never in doubt must not be
      // tripped alongside it.
      //
      // Dropping rather than ruling is still right for THIS frame: on the
      // ambiguous arm the session is torn down in the same act below — the slot
      // claimed, the record dropped, the routes swept, and the child KILLED — so
      // no terminal can ever arrive to rule it, and on the refusal arm the
      // provider answered "no", which is proof it started nothing. The steer
      // path cannot borrow either argument: its turn is still RUNNING and its
      // binding still serving, so it borrows the fail-closed ruling instead.
      //
      // The retained decision is deliberately left alone, unlike the key-wide
      // drop this replaced. It is keyed by RUN id only until `recorrelateFrame`
      // runs, `decisionFor` is read by turn id, and `register` clears the key's
      // decision on every retry — so no stale answer is reachable through it.
      //
      // No quarantine entry is installed here, and none is owed: disposal drops
      // the record, so session resolution refuses this binding by ABSENCE and
      // the only route back is a fresh spawn.
      this.#outboundFrameTripwire.forgetFrame(openingFrame);
      if (isAmbiguousTurnStartOutcome(cause)) {
        await this.#disposeAmbiguousSession(record);
      }
      throw cause;
    } finally {
      record.inFlightTurnStarts -= 1;
    }
    // The provider has named the turn, so THIS attempt's frame moves onto the key
    // the terminal notification will actually carry.
    //
    // Frame-scoped for the reason the drop above is: the run id is the key every
    // attempt on this run registers under, so a key-wide re-key would drag a
    // concurrent attempt's still-unnamed frame onto the turn THIS attempt opened
    // — and then the second attempt, finding nothing left under the run id, would
    // move nothing, leaving its own turn to settle against no correlated frame.
    // A settle with nothing correlated PASSES, which is the swallowed turn
    // reported as a completed one.
    this.#outboundFrameTripwire.recorrelateFrame(openingFrame, turnId);
    // Everything from here is ONE synchronous run, so a single slot check covers
    // both the install and the terminal-memory consume below it.
    if (!this.#stillHoldsSlot(record)) {
      // Reachable only through a transition that began AFTER dispatch, now that
      // the entrance demands a settled live slot. Three such transitions exist,
      // and the tempting argument is that each one disposes the connection this
      // turn was accepted on, so the turn dies with it and nothing more is owed.
      // That argument has an exception, which is why it is not the one used here:
      //
      //   * a close disposes the connection — subsumed;
      //   * a supersede-resume that SUCCEEDS releases the predecessor — subsumed;
      //   * a supersede-resume that FAILS releases only its own new connection and
      //     leaves the predecessor record installed and its process LIVE. The turn
      //     accepted on it keeps executing tools, with no route to interrupt it
      //     and a session the daemon will reuse.
      //
      // That third case is the same ambiguity the `turn/start` deadline is already
      // ruled connection-fatal for, so it gets the same answer rather than a
      // narrower one. Applied unconditionally instead of only to the third case:
      // the disposal is idempotent against a connection someone else already
      // released (`killAndClose` no-ops once closed, and the map work is
      // identity-gated), so the two subsumed cases cost nothing, and a rule with
      // no exception in it is the one that survives the next edit.
      //
      // The run is refused either way. Whatever the provider answered, this run is
      // not running, and reporting it started would strand a `#sessionIdByRunId`
      // entry no sweep can reach — every sweep keys on a record that is gone.
      await this.#disposeAmbiguousSession(record);
      throw new CodexTransportError(
        `Codex session "${record.sessionId}" stopped holding its slot while a turn was starting.`,
        { sessionId: record.sessionId, method: "turn/start" },
      );
    }
    // Keyed by the TURN the provider just named, so a second accepted start on
    // this same run ADDS a route rather than displacing the first one. The run
    // axis below is a set-membership fact ("this run has work on this session")
    // and is idempotent under a second entry; the turn axis is the correlation,
    // and it is the one that must never be overwritten.
    record.runIdByActiveTurnId.set(turnId, params.runId);
    this.#sessionIdByRunId.set(params.runId, record.sessionId);
    // Appended at ACCEPTANCE, not at completion: the provider has assigned the
    // id and the turn now occupies a position in the thread's history whatever
    // it goes on to do. A ledger written at completion would omit interrupted
    // and failed turns, and every later position would name the wrong turn.
    record.turnBoundaries.push(turnId);
    // The turn can already be OVER by the time this install runs. Resolving the
    // `turn/start` response schedules this continuation as a microtask, while
    // `#ingest` keeps draining the rest of the read chunk SYNCHRONOUSLY — so for
    // a fast turn whose response and `turn/completed` arrive in one chunk, the
    // sweep runs first, matches nothing, and this install would leave a route
    // that `hasActiveTurn` reports live for the daemon's lifetime. Consulting the
    // record's short memory of unmatched turns closes that window; the `delete`
    // is the consume, so a later turn reusing the id (it cannot — turn ids are
    // UUIDv7) could not be retired twice.
    //
    // T3.18. The SAME interleave beats the tripwire, and worse: the re-key above
    // ran after the terminal settled nothing, so the frame this run opened with
    // is pending under a turn id whose settlement has already gone by. A
    // consume that only retired the route would leave a swallowed turn reported
    // as a completed one, so the remembered evidence is replayed onto the
    // re-keyed frame and the terminal is ruled here instead.
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
      // In-flight evidence only. The turn is still running, so the route stays
      // installed and its own terminal will settle the frame in the ordinary
      // place.
      return;
    }
    this.#retireTurnRoute(record, turnId);
    const decision = this.#outboundFrameTripwire.settle(turnId, rememberedTerminal);
    if (!decision.tripped) {
      return;
    }
    this.#providerBindingQuarantine.disposeSession(record.sessionId);
    this.#providerBindingQuarantine.disposeRun(params.runId, record.sessionId);
    this.#reportTextNeutralizationFailure(
      record.sessionId,
      params.runId,
      composeTextNeutralizationRunFailure(decision),
    );
    this.#disposeQuarantinedSession(record);
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
      // T3.18. The bytes come off a frame this method cannot construct, so
      // the neutralization is structurally on the path rather than a call-site
      // convention. `runConfig.input` is deliberately NOT read here — the
      // author's text stays on the frame as `authoredText`, which is what the
      // daemon persists, events, and replays.
      input: [{ type: "text", text: openingFrame.wireText, text_elements: [] }],
      // The pin that actually carries the security property. A TURN is what
      // generates approval requests, and `TurnStartParams.approvalsReviewer` is
      // documented as overriding routing for "this turn and subsequent turns"
      // — so a config- or profile-selected `auto_review` reviewer would win on
      // every turn if only the thread-level pin were sent. Pinning it here is
      // idempotent rather than redundant, and `turn/steer` needs no pin because
      // it requires an already-active turn and creates none. Field verified
      // present on `TurnStartParams` at `codex-cli 0.150.1` (regenerated
      // 2026-08-28 — `docs/reference/provider-wire/codex.md`), on a params
      // type byte-identical back to the `0.141.0` floor.
      approvalsReviewer: "user",
      // Leg 5's per-turn half. The RUN's posture wins where it declares one,
      // and the session's spawn posture is the floor otherwise, so a turn is
      // never dispatched with no policy at all. Both arms send the roots the
      // thread-level mode selector cannot carry.
      ...this.#composeTurnPostureParams(record, params),
      ...(runConfig.model === undefined ? {} : { model: runConfig.model }),
      ...(runConfig.clientUserMessageId === undefined
        ? {}
        : { clientUserMessageId: runConfig.clientUserMessageId }),
      ...(params.outputSchema === undefined ? {} : { outputSchema: params.outputSchema }),
    };
    // Over the composed object, not over its inputs: every spread above has
    // already contributed, so this is the last moment at which what the provider
    // will receive is knowable in one place.
    assertRealizedTurnPostureMembers(turnStartParams);
    return await record.connection.request("turn/start", turnStartParams, this.#turnStartTimeoutMs);
  }

  /**
   * Disposes a session whose turn state is ambiguous: kill first, then release.
   *
   * Two entry points, one condition. Either the `turn/start` itself failed in a
   * way that leaves acceptance unknown, or it succeeded onto a record that had
   * stopped holding its slot — in both cases a turn may be live with no route to
   * it, which is the state this driver refuses to carry.
   *
   * Claimed like any other teardown, so nothing can slip into the window while
   * the child is dying — the dispose is a state transition of the slot, not a
   * side effect beside it. Scoped to the RECORD rather than to the session id: if
   * a resume superseded this leg while the turn was starting, that resume already
   * released this connection and installed its own, and this dispose must not
   * take the replacement down with it.
   *
   * No graceful `thread/unsubscribe` phase. The connection is precisely the thing
   * whose answers cannot be trusted, so asking it a question would buy a second
   * deadline and no information.
   */
  async #disposeAmbiguousSession(record: CodexSessionRecord): Promise<void> {
    await this.#claimSessionSlot(record.sessionId, "closing", async () => {
      if (this.#sessions.get(record.sessionId) === record) {
        this.#sessions.delete(record.sessionId);
        // RULED before either sweep, and before the routes it resolves runs
        // through are gone. With the record dropped no terminal on this binding
        // is ingested any more, so every frame still pending on it has just
        // become unrulable — which is a verdict, not an absence, and the runs
        // that wrote those frames are owed it.
        this.#ruleAbandonedFramesFailClosed(record);
        this.#forgetRunRoutes(record.sessionId);
        // Whatever the ruling left behind is now pure occupancy. Reclaimed at
        // the moment that becomes provably true, rather than left for the
        // tripwire's own pass when some later write would be refused.
        this.#releaseOutboundFrameBudget(record.sessionId);
      }
      try {
        await record.connection.killAndClose();
      } catch {
        // Swallowed: the caller is already throwing the typed cause that says WHY
        // the session was disposed, and a teardown artifact must not displace it.
      }
    });
  }

  /**
   * Zero-turn authentication probe (P0-5). NEVER throws.
   *
   * WHY A DEDICATED CONNECTION. `probeAuth()` takes no parameters and holds no
   * session, and its whole purpose is to detect a logged-out provider BEFORE a
   * turn is spent — so it cannot borrow a live session's connection (there may be
   * none, which is precisely the case that matters) and must not create one
   * (that would make the probe a session-establishing operation). It spawns its
   * own child from `resumeSpawnConfig`, the same CONSTRUCTED environment every
   * other spawn on this manager uses, asks one question, and tears the child down
   * in a `finally`. It claims NO session slot: it installs no record, starts no
   * thread, and is bound to no session id, so a probe running concurrently with a
   * create or a close cannot refuse either of them.
   *
   * WHY IT SPENDS NO CREDENTIAL. `includeToken: false` keeps credential material
   * off the wire entirely, and `refreshToken: false` is the load-bearing half:
   * the pinned providers rotate refresh tokens single-use with no grace window,
   * so a probe that refreshed on a cadence would not observe a credential — it
   * would END the login it was checking. Both members are sent explicitly because
   * `GetAuthStatusParams` types them required-but-nullable; omitting them would
   * leave the refresh behaviour to the provider's default.
   *
   * WHY IT IS TOTAL. Every unresolvable outcome — a spawn failure, a handshake
   * failure, a deadline, a refusal, an unreadable answer — becomes
   * `indeterminate`, which the contract defines as fail-closed for admission
   * while staying distinguishable from `unauthenticated`. Throwing instead would
   * hand the admission leg a third channel it has no rule for, and would collapse
   * "the probe is unhealthy" into "the transport is down".
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
      // Contained, so a teardown fault cannot displace the probe's answer — the
      // same containment the abandoned-establishment paths use, and for the same
      // reason. `close()` is idempotent, so this is safe on the path where
      // `open()` already tore its own child down.
      await this.#releaseAbandonedConnection(connection);
    }
  }

  /**
   * Connection options for a probe that owns no session.
   *
   * Deliberately NOT `#connectionOptionsFor`: that binds every inbound
   * notification to a session id, and this connection has none. Attributing a
   * probe's frames to a session would put a foreign process's notifications into
   * that session's stream — the exact confusion the thread-frame routing exists
   * to prevent. A probe starts no thread, so any notification it receives is by
   * construction unconsumed, and that is what it is recorded as.
   */
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
   * Interrupts the provider turn bound to a run.
   *
   * The route is retired here because the run must stop reporting an active
   * turn the moment the provider accepts the interrupt — a steer or a second
   * interrupt aimed at it afterwards has to be refused. But `turn/interrupt`
   * resolving is not the turn ENDING: `turn/completed` still follows, and that
   * is the frame the tripwire is ruled on. So the turn correlation is retained
   * before the route goes, and the terminal path releases it once the ruling is
   * made. Without it a trip on an interrupted turn quarantines the session and
   * the process while the run's own subscribers are told nothing, which is the
   * one outcome the run-failure report exists to prevent.
   */
  async interruptRun(params: InterruptRunParams): Promise<void> {
    const { record, turnId } = this.#requireActiveTurn(params.runId);
    await record.connection.request("turn/interrupt", {
      threadId: record.threadId,
      turnId,
    });
    // Retained whenever the turn has not already SETTLED, and on no narrower
    // condition. Whether a frame is pending is a point-in-time read consulted at
    // a later point in time, so gating on it would make the correlation correct
    // by argument about what can interleave rather than by construction — but
    // presence in `settledTurnIds` is not that kind of read: it is marked for
    // EVERY terminal and never consumed, so presence is proof the terminal this
    // correlation exists to route has already arrived and been ruled. Recording
    // it anyway would install an entry nothing will ever release — the read
    // chunk that settled the turn can drain entirely before this continuation
    // resumes — and stale entries now accumulate toward a refusal rather than
    // evicting live ones, so each one costs headroom a live interrupt needs.
    if (!record.settledTurnIds.has(turnId)) {
      if (!rememberInterruptedRun(record, turnId, params.runId)) {
        // The interrupt itself SUCCEEDED — `turn/interrupt` resolved above — so
        // this resolves rather than throws, and the caller's `applied` stays
        // truthful about the provider operation it grades. What failed is this
        // driver's promise to route the turn's terminal to the run, and the
        // refusal reports that the way its two siblings do: quarantine and
        // teardown, which rules the run's still-pending frame fail-closed so
        // the run hears `run.failed` rather than nothing.
        this.#refuseUnretainableInterruptedRoute(record);
        return;
      }
    }
    // Retires THIS turn's route and no other. An interrupt names one turn — the
    // one `#requireActiveTurn` resolved — so a run holding a second live turn
    // keeps its second route and the second turn's terminal still finds its run.
    this.#retireTurnRoute(record, turnId);
  }

  /**
   * Rewinds a session's conversation to a recorded turn boundary (T3.15 leg 1).
   *
   * CONVERSATION ONLY. The provider's own type says its rewind "does not revert
   * local file changes"; working-tree restore is the daemon's turn-snapshot leg,
   * and a driver claiming it here would be inventing a guarantee the provider
   * never made.
   *
   * MECHANISM: `thread/fork` at an inclusive `lastTurnId`, which mints a NEW
   * thread and leaves the pre-rewind thread intact and unreferenced. Three
   * consequences, all of them load-bearing:
   *
   *   * the caller's absolute position resolves to a BOUNDARY TURN ID, never to
   *     a drop-count, so a retried rewind re-forks from the same boundary
   *     instead of compounding a drop;
   *   * the session is re-pointed at the forked thread in the SAME operation, so
   *     no window exists in which the record names a thread the caller has
   *     rewound away from;
   *   * the result reports a freshly minted `bindingId`. That surrogate is the
   *     daemon's only channel for the new thread — an `applied` result without
   *     it would leave the run bound to a thread the store never recorded, and
   *     therefore un-resumable across a restart.
   *
   * SERIALIZED ON THE SESSION SLOT across the fork, so none of that re-pointing
   * is a read-decide-mutate over state a concurrent caller can move underneath
   * it. The claim is taken below rather than here, and what an unclaimed rewind
   * loses is recorded there.
   *
   * `params.bindingId` names the leg the DAEMON resolved and is not re-derived
   * here: this manager holds one live leg per session id, so the session id is
   * the key it can actually honour, and re-keying on a surrogate this class does
   * not mint would be a second identity axis with no second source.
   *
   * DEGRADES (I-005-4) rather than throwing on the two conditions the provider's
   * own contract makes unsatisfiable — an in-progress turn at the boundary, and
   * a position naming no recorded turn. Both are answers about THIS request,
   * not transport faults, and `degraded` is the vocabulary the contract reserves
   * for a driver that was invoked and could not apply.
   *
   * REFUSES, rather than degrading, when the running build accepts `thread/fork`
   * and rejects its boundary member: that is not a request this driver could not
   * apply, it is a capability the build does not have, and the distinction is
   * what the `rollback` flag's `static` detection source leaves to invocation
   * time. See {@link CodexRewindBoundaryUnsupportedError}.
   */
  async rollbackTo(params: RollbackToParams): Promise<DriverRollbackResult> {
    // HOISTED OUT OF THE CLAIM below, and it has to be: that claim is taken in
    // `establishing`, which is a state `#requireSession` REFUSES — read from
    // inside the claimed body, this operation would refuse its own claim. Every
    // claimed body in this class reads `#sessions` directly for that reason, and
    // this one reads it here, once, before the claim exists.
    const record = this.#requireSession(params.sessionId);
    if (record.runIdByActiveTurnId.size > 0) {
      // "The referenced turn cannot be in progress" is the provider's rule, and
      // Codex serializes turns per thread — so ANY live turn on this session is
      // either the boundary itself or a turn after it, and forking through it is
      // refused either way. Checked here so the refusal is a typed local answer
      // rather than an opaque provider error.
      return DriverRollbackResultSchema.parse({
        status: "degraded",
        fallbackAction: "rewind-deferred-turn-in-progress",
      });
    }
    // Position N names the Nth turn. Position 0 is deliberately NOT mapped onto
    // an omitted `lastTurnId`: omitting the boundary forks the WHOLE thread, so
    // a request to rewind to an empty history would be answered by a fork that
    // rewound nothing at all — the one outcome a rollback must never report as
    // applied.
    const boundaryTurnId =
      params.position >= 1 ? record.turnBoundaries[params.position - 1] : undefined;
    if (boundaryTurnId === undefined) {
      return DriverRollbackResultSchema.parse({
        status: "degraded",
        fallbackAction: "rewind-target-not-a-recorded-boundary",
      });
    }
    // THE SLOT IS HELD ACROSS THE FORK, which is what makes the rebind below
    // safe to perform at all. Every mutation past the `thread/fork` await — the
    // record's thread id, the routing and metering band, the boundary ledger —
    // is decided on state read BEFORE that suspension. Unclaimed, a `startRun`
    // dispatched while the fork is in flight registers its turn on the PRE-FORK
    // thread; the fork then moves the band, and every frame of that live turn is
    // held-then-shed, so the run neither projects nor meters, the ledger splice
    // discards its id, and an interrupt for it would carry the forked thread's.
    // Two concurrent rewinds would both report `applied` for the same reason.
    //
    // Claimed in `establishing` rather than in a kind of its own: a fork IS an
    // establishment — it mints the thread the session continues on, and
    // `#bindSessionThread` treats it as one — and `establishing` is the state
    // the entrance already refuses, so a concurrent turn is refused BEFORE it is
    // dispatched rather than unwound after one was accepted. A concurrent close
    // or resume chains behind this operation instead of racing it.
    //
    // Mirrors the Claude leg's `#withRewindSlotClaimed`, minus its
    // predecessor-restoring shape: that leg spawns a SUCCESSOR process and must
    // put the predecessor back when it does not install one, while this fork
    // runs on the session's own connection and installs no successor at all, so
    // a refused fork leaves the slot's own holder exactly as it was found.
    return await this.#claimSessionSlot(
      params.sessionId,
      "establishing",
      async () => await this.#establishRewoundSession(params, record, boundaryTurnId),
    );
  }

  async #establishRewoundSession(
    params: RollbackToParams,
    record: CodexSessionRecord,
    boundaryTurnId: string,
  ): Promise<DriverRollbackResult> {
    // Captured BEFORE the request, and used as the request's own `threadId`, so
    // the thread this fork descends from and the thread its usage base is keyed
    // to are provably the same value rather than two reads of a mutable field.
    const preForkThreadId = record.threadId;
    // SCOPED TO THE REQUEST AND NOTHING ELSE. The guard wraps the dispatch alone
    // so that only the provider's own reply is classified: `readThread` below
    // throws a transport error for a malformed RESULT, which is a different
    // failure entirely and must not be re-labelled a missing capability. Nothing
    // is caught here that is not rethrown — see `classifyRewindForkFailure`.
    let response: unknown;
    try {
      response = await record.connection.request("thread/fork", {
        threadId: preForkThreadId,
        lastTurnId: boundaryTurnId,
        // A fork mints a NEW thread, so it is a thread establishment and takes the
        // same re-realization rule a resume does: `ThreadForkParams` carries the
        // override members verbatim, and a fork that omitted them would leave the
        // rewound session governed by whatever the new thread inherited rather
        // than by the posture and caps its caller declared.
        ...this.#composeThreadEstablishmentLegs(record.executionPosture, record.subagentPolicy),
        approvalsReviewer: "user",
      });
    } catch (cause) {
      // THE CLASSIFICATION SITE the `rollback` detection rationale names. An
      // above-floor build that accepts `thread/fork` but does not declare
      // `ThreadForkParams.lastTurnId` refuses HERE, and refuses as the registered
      // `driver.capability_unsupported` rather than as an opaque provider fault
      // the caller would have to read a serde message to understand. Every other
      // fork failure is rethrown exactly as it arrived.
      //
      // Thrown rather than returned: nothing has mutated yet — the record still
      // names the pre-fork thread and the router and accountant are untouched —
      // and the slot claim releases this body's hold in its own `finally`, so a
      // later rewind on this session is attemptable with nothing to unwind.
      throw classifyRewindForkFailure(cause);
    }
    const forkedThread = readThread(response, "thread/fork");
    this.#assertPostureRealized(record.executionPosture, response);
    // THE FORK CHECK. A fork that answers with the thread it was HANDED did not
    // fork: it either rewound that thread in place or handed the same one back.
    // Adopting it would report `applied` for a rewind whose whole point — the
    // pre-rewind conversation surviving on a thread of its own — did not happen,
    // and would re-base this session's usage registers against its own emitted
    // sum for a thread that never changed. Refused rather than adopted, and
    // refused BEFORE the re-point below, so the record, the router, and the
    // accountant are all exactly as they were and a retry is safe.
    if (forkedThread.id === preForkThreadId) {
      return DriverRollbackResultSchema.parse({
        status: "degraded",
        fallbackAction: "rewind-not-forked",
      });
    }
    // THE SECOND IDENTITY REFUSAL, and a different question from the first: the
    // provider answered with a thread this session ALREADY METERS. A thread left
    // behind by an earlier rewind, or a live child thread, both pass the check
    // above and would then be RE-ESTABLISHED here — resetting register sets that
    // are carrying real spend, and handing the router a session identity whose
    // frames are already attributed elsewhere. Ordered after the fork check on
    // purpose: the pre-fork thread is itself registered, so this test alone would
    // answer the unforked case with the wrong token.
    if (this.usageAccountantFor(params.sessionId).hasThread(forkedThread.id)) {
      return DriverRollbackResultSchema.parse({
        status: "degraded",
        fallbackAction: "rewind-target-thread-already-registered",
      });
    }
    // RE-READ ACROSS THE SUSPENSION, immediately before the first mutation. The
    // claim is what makes this unreachable today — a turn dispatched while it is
    // held is refused at the entrance, and one already in flight is refused
    // post-await by `startRun`'s own slot check rather than registered — but the
    // guard at the top of `rollbackTo` read a MUTABLE map before the await, and
    // its stability is a property of those other call sites rather than of this
    // one. Answered with the pre-await guard's exact shape, so a caller cannot
    // tell which of the two refused. The cost of refusing here is a forked thread
    // the daemon never adopts; rebinding under a live turn would strand the turn
    // itself, which is the worse of the two.
    if (record.runIdByActiveTurnId.size > 0) {
      return DriverRollbackResultSchema.parse({
        status: "degraded",
        fallbackAction: "rewind-deferred-turn-in-progress",
      });
    }
    // Re-pointed only AFTER the fork is parsed. A failed or unreadable fork
    // leaves the session exactly where it was, which is what makes a retry safe.
    record.threadId = forkedThread.id;
    // The ROUTING AND METERING BAND moves with the record, in the same
    // synchronous act. Re-pointing the record alone would leave the router's
    // registered session thread naming the pre-fork id and the accountant
    // holding no registers for the forked one — so every post-rewind frame is
    // held pending a registration that never lands, shed on the hold timeout,
    // and the session meters nothing at all for the rest of its life.
    //
    // Based like a RESUME and keyed on the PRE-FORK thread: a fork continues a
    // session whose earlier spend the daemon has already emitted, and the
    // forked id is one it has never emitted a token against, so the
    // predecessor's id is the only key that sum exists under.
    //
    // Whether the provider's counter CONTINUES across a fork is not stated by
    // the pinned wire reference, and the two readings are not symmetric. If it
    // continues, this base is exact. If it restarts, the successor's readings
    // fall BELOW the base and the accountant's decrease-floor rule floors the
    // deltas at zero and records a diagnostic — loud under-metering that
    // repairs itself once the counter passes the base. Basing `fresh` has the
    // inverse failure: silent double-counting of every pre-rewind turn, which
    // reaches a receipt as real money and says nothing.
    this.#bindSessionThread(params.sessionId, forkedThread.id, {
      mode: "resume",
      priorEmittedThreadId: preForkThreadId,
    });
    // The predecessor's registers are RETIRED, not merely superseded. The
    // router's retirement is fused into the registration above — it holds one
    // session identity, so re-registering replaces it — but the accountant holds
    // a register set PER THREAD and has no such fusion. A rewind that skipped
    // this leaked one set per rewind for the session's whole life and left
    // `hasThread(preForkThreadId)` answering true for a thread the caller has
    // rewound away from — which is also what makes the refusal above answerable
    // at all: that check asks whether the session is STILL metering the answered
    // id, and an accountant that never forgets cannot tell a live thread from a
    // retired one.
    //
    // Released only HERE, after the successor is established: released before
    // the fork, a refused fork would leave the session running on a thread it
    // can no longer meter. Late frames naming the retired thread are
    // present-but-unregistered at the router after that same registration, so
    // none of them reach the accountant to find its registers gone.
    this.usageAccountantFor(params.sessionId).releaseThread(preForkThreadId);
    const forkedTurnIds = readThreadTurnIds(forkedThread.turns);
    // ONE report for BOTH disagreements, reported before either arm adopts,
    // because they are the same disagreement: an absent or unreadable turn list
    // reads as zero turns, which is itself a count that disagrees with the
    // position asked for (the entrance refuses position 0, so agreement at zero
    // is unreachable). The non-empty arm previously adopted the provider's ledger
    // verbatim while still reporting `sessionPosition: params.position`, so a
    // length the provider disagreed on was recorded nowhere at all — the silent
    // half of the corroboration the empty arm has always reported.
    if (forkedTurnIds.length !== params.position) {
      reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
        kind: "fork-turn-ledger-unconfirmed",
        expectedTurnCount: params.position,
        confirmedTurnCount: forkedTurnIds.length,
      });
    }
    if (forkedTurnIds.length > 0) {
      // The provider's own account of the forked history wins over the local
      // ordinal — it is the thread the session now runs on.
      record.turnBoundaries.splice(0, record.turnBoundaries.length, ...forkedTurnIds);
    } else {
      // Truncating to the requested position is what the INCLUSIVE boundary
      // means, so the ledger stays usable for the next rewind.
      record.turnBoundaries.length = params.position;
    }
    return DriverRollbackResultSchema.parse({
      status: "applied",
      sessionPosition: params.position,
      bindingId: this.#newBindingId(),
    });
  }

  /**
   * Binds the session's goal on the provider (T3.15 leg 2, native).
   *
   * `goalText` is already the daemon-RENDERED form: the structured goal is the
   * Spec-016 contract's, and rendering happens before this seam, so the driver
   * never sees the structure and cannot diverge from it.
   *
   * `objective` is the only member sent. The provider's params also carry
   * `status` and `tokenBudget`; both are provider-side goal STATE this daemon
   * does not own — sending either would make the driver a second author of a
   * value whose durable truth is the session's own goal events.
   */
  async setSessionGoal(params: SetSessionGoalParams): Promise<DriverGoalResult> {
    const record = this.#requireSession(params.sessionId);
    await record.connection.request("thread/goal/set", {
      threadId: record.threadId,
      objective: params.goalText,
    });
    return DriverGoalResultSchema.parse({ status: "applied" });
  }

  /**
   * Clears the session's goal on the provider (T3.15 leg 2, native).
   *
   * A `cleared: false` answer is still `applied`. The post-condition this
   * operation promises is that the session carries no goal, and a thread that
   * had none already satisfies it — reporting `degraded` there would tell the
   * caller to run a fallback for a state it has.
   */
  async clearSessionGoal(params: ClearSessionGoalParams): Promise<DriverGoalResult> {
    const record = this.#requireSession(params.sessionId);
    await record.connection.request("thread/goal/clear", { threadId: record.threadId });
    return DriverGoalResultSchema.parse({ status: "applied" });
  }

  /**
   * Unsubscribes from the thread and tears down the process. Idempotent: closing
   * an unknown or already-closed session resolves without throwing.
   */
  async closeSession(params: CloseSessionParams): Promise<void> {
    // Read and claim in ONE synchronous run, with no `await` between them. The
    // early return is not an optimization: claiming for a session this manager
    // does not hold would refuse a concurrent create for a slot that is genuinely
    // free, and a close of an unknown session is specified as a no-op.
    //
    // A close arriving mid-establishment does NOT take that branch — the slot
    // reads `establishing` — so it claims and chains, and the in-flight create or
    // resume can no longer install a record that outlives the session the daemon
    // believes it closed. Chaining also covers a QUEUE of transitions
    // transitively, since each claim already waits on its predecessor. Safe from
    // deadlock: no establishment path calls `closeSession` (each closes its own
    // CONNECTION directly), so the wait can never be on this call.
    //
    // P1-1 is latched FIRST, before the unknown-session early return and before
    // the claim: the daemon has expressed the intent by calling this method at
    // all, so every terminal from this point on belongs to a clean shutdown —
    // including the ones a chained close only reaches after the establishment
    // ahead of it settles.
    this.#intendedCloseGateFor(params.sessionId).signalIntendedClose();
    if (this.#describeSlotHolder(params.sessionId) === undefined) {
      // No slot means no session, so no terminal is left for the flag to
      // describe; the latch this call just set goes with it rather than
      // accumulating one entry per redundant close.
      this.#terminalEmissionGates.delete(params.sessionId);
      this.#frameRouters.delete(params.sessionId);
      this.#usageAccountants.delete(params.sessionId);
      return;
    }
    await this.#claimSessionSlot(params.sessionId, "closing", async () => {
      await this.#tearDownSession(params.sessionId);
    });
    // The gate dies with the session it scoped, after teardown rather than
    // before it: a terminal provoked by the teardown itself must still find the
    // latch set. The routing and metering band goes with it — both are
    // per-provider-session state, and a router surviving its session would
    // answer the next one with a thread registry that session never made.
    this.#terminalEmissionGates.delete(params.sessionId);
    this.#frameRouters.delete(params.sessionId);
    this.#usageAccountants.delete(params.sessionId);
  }

  /**
   * The terminal-emission gate for one session (T3.14 P1-1 / P1-2-driver).
   *
   * The emission pipeline reads it to stamp `intendedClose` and to suppress a
   * duplicate terminal for an already-settled `(runId, runVersion)` epoch. Read
   * LIVE at each terminal rather than captured, for the same reason the
   * capability snapshot is: a gate captured before a close would answer with a
   * latch the close has since set.
   */
  terminalEmissionGateFor(sessionId: SessionId): CodexTerminalEmissionGate {
    return this.#intendedCloseGateFor(sessionId);
  }

  /**
   * The thread-frame router for one session (T3.11).
   *
   * Read LIVE rather than captured, for the same reason the emission gate is:
   * a router captured before a registration would answer with a thread set the
   * registration has since widened.
   */
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

  /** The usage-delta accountant for one session (T3.11). */
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
   * Bind a session's OWN thread identity into the routing and metering band.
   *
   * Called at EVERY establishment — create, resume, and the rewind's fork —
   * with the arm the establishment actually took. ORDER IS THE CONTRACT: the
   * accountant's base registers are established BEFORE the router releases
   * anything, because a released usage frame meters immediately and an
   * unestablished thread would refuse it outright.
   *
   * The registration's released frames are RE-ROUTED rather than discarded: a
   * Codex session can receive traffic on its own thread before the establishing
   * response names that thread, and a discarding caller would shed it.
   *
   * Re-registering the session's own thread is also how the PREVIOUS one is
   * retired. The router holds a single session-thread identity and this
   * overwrites it, so after a rewind a frame naming the pre-fork thread is
   * present-but-unregistered rather than the session's own. That is the whole
   * retirement: the router exposes no separate retire entry point, and reaching
   * around it here would make this a second writer of a value it owns.
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
   * Read the daemon's own prior-emitted cumulative sum for one thread.
   *
   * The diagnostic is reserved for the genuinely FAULTY arm — no reader bound,
   * or a reader that threw. A bound reader answering `undefined` is a CORRECT
   * answer to a correct question: a session that legitimately emitted nothing
   * has a prior-emitted sum of zero, and basing at zero is exactly right for
   * it. Recording that case too would fire the record on every zero-spend
   * rewind and say nothing about any of them, and would claim spend was
   * re-metered where none exists.
   *
   * The reader is CALLER-SUPPLIED, so its throw is contained here rather than
   * allowed to escape. Two paths make that load-bearing: `rollbackTo` calls
   * this AFTER the record has been re-pointed at the forked thread, where a
   * throw would break that method's own promise that a failed rewind leaves the
   * session exactly as it was and would report a fork that DID happen as one
   * that did not; and `resumeSession` calls it against a live provider process,
   * where a throw would convert a resumed session into a typed failure the
   * daemon then tries to recover from. The base this returns is a telemetry
   * input, and an over-metered turn is recoverable from the record below —
   * neither of those two outcomes is.
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

  /**
   * Record a base the resume arm was taken with but could not obtain.
   *
   * Both thread ids travel because on a REWIND they differ: the sum was looked
   * up under the pre-fork thread while the registers being based belong to the
   * forked one, and an operator reconciling a receipt needs the pair to see
   * which key came up empty. The resume arm is still taken rather than swapped
   * for `fresh`, so the record says which arm ran and why it had nothing to
   * work with.
   */
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
   * Route one inbound notification and deliver whatever it releases.
   *
   * THE routing entry point, ahead of every projection decision. Non-throwing
   * by construction: it runs inside the transport's `#ingest` drain, where a
   * throw would unwind the read-chunk loop, so every reader it calls is total
   * and the delegate hand-off below is individually contained.
   *
   * Registration is dispatched from a `thread/started` announcement BEFORE the
   * announcement frame itself is routed — otherwise the announcement would be
   * held pending the very registration it carries.
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
            // A SECOND announcement for a child already carrying a base. The
            // router accepted it (re-registering a held identity is a no-op),
            // but re-establishing would reset this child's register to zero
            // mid-stream, so its next cumulative reading would re-meter every
            // token it has already spent — double-counted spend on the receipt
            // — and a second `subagent.started` would duplicate the child's
            // only timeline presence. Recorded rather than returned on: the
            // duplicate is a provider-side observation worth surfacing.
            this.#options.diagnostics.emit({
              provider: "codex",
              kind: "thread_duplicate_child_announcement",
              rawWireType: method,
              dispositionReason:
                "duplicate child-thread announcement for an already-registered child; usage base retained and no second started emission",
              details: { sessionId, childThreadId: registration.childThreadId },
            });
          } else {
            // A registered child is a BRAND-NEW provider thread, so its base
            // registers start at zero. Establishing it here rather than lazily
            // is what makes the usage carve-out reachable at all: the
            // accountant refuses an unestablished thread outright, so a child
            // whose spend was never established would carve out of the parent's
            // transcript and then be dropped on the floor — the child's cost
            // vanishing rather than being scoped, which is not what I-005-12
            // asks for.
            accountant.establishThread(registration.childThreadId, { mode: "fresh" });
            // A provider-attributed child opens its `subagent.*` pair here, at
            // the registration that admitted it. A provider-INTERNAL child (a
            // compaction thread) carries no subagent identity, so it opens no
            // pair — inventing one would put a subagent on the timeline that
            // the provider never attributed to anything.
            if (registration.attribution.kind === "subagent") {
              this.#options.onSubagentLifecycle?.(sessionId, {
                eventType: "subagent.started",
                subagentId: registration.attribution.subagentId,
                parentReference: announcement.declaredParentThreadId,
              });
            }
          }
          // Released unconditionally on BOTH arms. A hold can only exist for an
          // identity the router had not yet seen, so the duplicate arm releases
          // an empty list — but making the release conditional would couple the
          // hold's fate to a metering decision it has nothing to do with.
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
   * Apply the router's decision to each frame and hand only the projecting ones
   * to the normalize band.
   *
   * The carve-outs run AHEAD of suppression, which is the whole point of them:
   * a child's usage still meters and a child's interactive request still routes,
   * even though the child's transcript never projects.
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
        // A projecting usage frame meters against the session's own thread
        // before it reaches the normalize band, so the band never sees a
        // cumulative counter it might forward as a per-turn figure.
        this.#meterUsageFrame(sessionId, frame);
        this.#completeChildOnTerminal(sessionId, frame);
        this.#handOffToNormalizeBand(frame);
        return;
      case "carve-out-usage":
        this.#meterUsageFrame(sessionId, frame);
        return;
      case "carve-out-interactive-request":
        // A child's ask routes through the SAME dispatch and approval pipeline
        // as the parent's, answered on the child's own correlation identity —
        // suppressing it would not hide the child but hang it.
        this.#handOffToNormalizeBand(frame);
        return;
      case "suppress-child-transcript":
        // The child's own terminal releases the child's router state; its
        // content never reaches the parent's timeline.
        this.#completeChildOnTerminal(sessionId, frame);
        return;
      case "held-pending-registration":
      case "quarantined":
        // Both are already recorded by the router as diagnostics; neither is a
        // delivery, and neither is a silent drop.
        return;
    }
  }

  /** Meter one usage frame, if this frame is one. */
  #meterUsageFrame(sessionId: SessionId, frame: CodexRoutableFrame): void {
    if (frame.rawWireType !== CODEX_THREAD_TOKEN_USAGE_METHOD) {
      return;
    }
    const reading = readCodexCumulativeUsageReading(frame.params);
    if (reading === null) {
      // The one frame kind this provider reserves for token readings arrived
      // and could not be read. Recorded rather than returned on: a silent drop
      // here is spend that never reaches a receipt, and it is indistinguishable
      // from a session that simply cost nothing.
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
   * Release a child thread's router state on that child's own terminal.
   *
   * The child terminal is a CHILD THREAD'S `turn/completed` carrying a terminal
   * `turn.status`, and it is routable because the frame carries a top-level
   * `threadId`.
   *
   * The pinned union's two neighbouring candidates were both examined and
   * neither can serve. `thread/status/changed` DOES exist, but its `ThreadStatus`
   * has no terminal arm — `notLoaded | idle | systemError | active` — and `idle`
   * is the BETWEEN-TURNS state, so a completion keyed on it would end a child
   * that is merely waiting. `thread/closed` is a genuine thread-lifetime
   * terminal, but nothing at the pin establishes that the app-server emits it
   * for subagent threads, so binding release to it would risk never releasing;
   * it is deliberately left unclassified, which routes it to the router's
   * fail-closed quarantine WITH a diagnostic rather than to a silent drop — the
   * recorded signal that would justify adopting it.
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

  /** Hand one routed frame to the normalize / emission band. */
  #handOffToNormalizeBand(frame: CodexRoutableFrame): void {
    const delegate = this.#options.onServerNotification;
    if (delegate === undefined) {
      // Same containment as the transport's own: this runs inside `#ingest`.
      reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
        kind: "unconsumed-server-notification",
        method: frame.rawWireType,
      });
      return;
    }
    try {
      delegate(frame.rawWireType, frame.params);
    } catch (cause) {
      // A MODULE-BOUNDARY guard, kept deliberately even though the transport
      // contains this same fault one frame further out. The reason is ownership
      // rather than behaviour: this class should not depend on another module's
      // error handling to keep its own contract, and that transport is slated to
      // become swappable (T3.15 leg 6), at which point the outer catch stops
      // being guaranteed.
      reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
        kind: "notification-consumer-failed",
        method: frame.rawWireType,
        detail: normalizeProviderFailureDetail(cause),
      });
    }
  }

  // Get-or-create, so the intent latch survives whichever of close and
  // establishment reaches this session first.
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
   * Graceful teardown of whatever record holds the session, inside a claimed slot.
   *
   * The record is deleted in a `finally` at the END rather than up front, and
   * both halves of that are load-bearing. Deleting first freed the slot for the
   * length of the unsubscribe and the process close — the window a second create
   * used to spawn into. Deleting only on success would make a session whose
   * teardown threw permanently unclosable AND permanently un-creatable, which
   * trades a leaked process for a wedged slot.
   */
  async #tearDownSession(sessionId: SessionId): Promise<void> {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      // The establishment this close chained behind failed, so nothing was ever
      // installed; that path released its own connection on the way out.
      return;
    }
    // Routes are dropped up front, apart from the record: they are not the slot,
    // and `hasActiveTurn` must stop reporting a run live the instant its session
    // begins tearing down rather than when the process finally goes.
    this.#forgetRunRoutes(sessionId);
    try {
      if (!record.connection.isClosed) {
        try {
          // Best effort, and bounded: the process is going away regardless, so a
          // refused OR unanswered unsubscribe must not block teardown or surface
          // as a close failure. The explicit deadline is what makes "must not
          // block" true against a wedged provider.
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
      // AFTER the record delete, not beside the route sweep at the top. The
      // record survives every await above, so a turn terminating mid-teardown is
      // still ingested and still ruled — and dropping its frame early would turn
      // that last ruling into a silent pass on the way out.
      this.#releaseOutboundFrameBudget(sessionId);
    }
  }

  /** Steer is routed here by the intervention dispatcher (T3.2, enriched at T3.14). */
  async steerRun(request: CodexSteerRunRequest): Promise<CodexSteerAcknowledgement> {
    const { record, turnId } = this.#requireActiveTurn(request.runId);
    // The provider REQUIRES an active-turn precondition. A caller-supplied
    // expectation wins so a stale steer is refused by the provider rather than
    // silently retargeted at whatever turn is running now. Held in a local
    // because it is also half of the acknowledgement comparison: the dispatcher
    // grades the ack against what actually went on the wire, not against the
    // caller's optional hint (P3-1).
    const targetedTurnId = request.expectedTurnId ?? turnId;
    // T3.18. The steer directive is the SECOND provider-bound text path on this
    // leg and takes the identical treatment: composed by the writer, correlated
    // against the turn it is steering, and written as `wireText`. Registered
    // against `targetedTurnId` rather than the run id because a steer joins a
    // turn that already exists — there is no later re-keying moment.
    const steerFrame = this.#outboundTextFrameWriter.compose({
      text: request.content,
      origin: request.frameOrigin,
    });
    // Refuses BEFORE the write, exactly as the opening frame does: a steer this
    // tripwire cannot watch is a steer whose swallow would be invisible, and the
    // honest answer to a session whose turns are not settling is to refuse the
    // directive rather than to send it unwatched.
    this.#outboundFrameTripwire.register({
      scopeKey: record.sessionId,
      joinKey: targetedTurnId,
      // A steer joins a turn another frame opened, so no stream item can vouch
      // for it — it is consumed on the provider's answer to its own request,
      // recorded below.
      frameRole: "turn-joining",
      frame: steerFrame,
    });
    // T3.18. PINS the settled-turn memory for the whole round trip, including
    // the acknowledgement read below. The answer that read depends on is an
    // ABSENCE, and an absence is only evidence while nothing has been dropped:
    // the response's own read chunk can carry a burst of terminals that drains
    // synchronously before this continuation resumes, and a size-based prune
    // there would discard the very settlement the acknowledgement is about to
    // be graded against. Held across the read rather than released at the
    // await, so a later edit that introduces a suspension point between them
    // cannot silently reopen the window.
    record.inFlightSteers += 1;
    try {
      const attempt = await this.#requestTurnSteer(record, request, steerFrame, targetedTurnId);
      if (attempt.settled === "answered") {
        const acknowledgedTurnId = readSteeredTurnId(attempt.result);
        // T3.18. The answered request is the transport's statement that the
        // provider TOOK this frame — the only per-frame attribution it
        // produces, and the declared coverage boundary a joined frame is
        // consumed on (proof of receipt, not of the model reading the text;
        // the tripwire's class doc states the conjunction residual). Stream
        // items carry no frame attribution, so they credit the turn-opening
        // frame alone (the tripwire's attribution rule); without this record
        // every steer would reach its turn's settlement evidence-less and trip
        // a healthy session. Recorded for a NULL acknowledgment too: naming no
        // turn weakens the correlation, never the receipt — the dispatcher
        // already grades that answer degraded rather than applied (P3-1).
        this.#outboundFrameTripwire.recordRequestAnswered(steerFrame);
        if (acknowledgedTurnId !== null && acknowledgedTurnId !== targetedTurnId) {
          // T3.18. The provider named a turn OTHER than the one this steer
          // targeted, which is the provider's own statement about where the bytes
          // went. Leaving the frame on the disproven target gets both halves
          // wrong at once: the target's terminal would rule a frame whose text
          // never entered it — a trip on a turn that swallowed nothing — while
          // the turn that DID take the directive settles against no correlated
          // frame, and that PASSES. So the frame follows the acknowledgment,
          // carrying the answered-request record just written, which is what
          // rules it at the destination's settlement.
          //
          // A NULL acknowledgement is deliberately left where it is: naming no
          // turn disproves nothing, so the target remains the best evidence of
          // where the bytes went.
          //
          // The move is REFUSED when the acknowledged turn can no longer rule
          // anything — it settled already, ordinarily via a terminal sharing
          // this steer's own response read chunk and drained SYNCHRONOUSLY
          // before this continuation ran — and the frame is consumed here
          // instead, as a frame-scoped ruling on its own recorded
          // acknowledgment. A settled turn emits no second terminal, so a
          // frame left on one would sit as occupancy until scope release. This
          // arm once ruled fail-closed and condemned the session; that
          // contradicted the attribution rule this leg now carries — the
          // acknowledgment that vouches for a steer on the live-destination
          // path is the same statement here, and delivery it proves does not
          // stop being proven because the destination finished first. The
          // mismatch itself stays visible: the dispatcher grades this answer
          // degraded on the ack comparison (P3-1), so nothing here is silent.
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
   * Decides what a failed steer's frame is owed, by how far its bytes got.
   *
   * The classification is the whole point. A steer that provably never reached
   * the wire is owed nothing: no turn will ever account for it, and leaving it
   * registered would trip the live turn it joined — a run failed and a provider
   * session disposed over text the provider never saw. Forgetting it is
   * frame-scoped, because the frame that OPENED the turn is still correlated and
   * still owed its own ruling.
   *
   * A steer whose bytes were handed to the host is owed the opposite. The
   * provider may have received the directive, intercepted it as a client-side
   * command, and answered with the zero-turn success this tripwire exists to
   * catch — the rejection the caller sees says nothing either way. Withdrawing
   * the frame there is precisely how a swallowed directive escapes detection
   * while the unsafe binding stays reusable, so the registration is RETAINED and
   * the turn's own terminal rules it — and under the attribution rule that
   * ruling is DETERMINISTIC: a retained steer holds no answered request, and
   * stream items credit only the turn-opening frame, so an ordinary settlement
   * trips it fail-closed. Delivery left unproven by the transport fails the
   * run loudly rather than riding item timing. That costs one pending slot on
   * a scope that already admitted it, and session disposal still reclaims it.
   *
   * The connection's death is the one case retention cannot cover: no terminal
   * will ever arrive, so the frame would sit until the scope's budget is
   * released and be dropped as mere occupancy — silence in the exact case that
   * warrants the loudest answer. So it is ruled here, fail-closed, and ruled
   * FRAME-scoped: settling the whole turn would trip the opening frame too, and
   * that frame's request was answered, so its delivery was never in doubt.
   *
   * Residual, deliberately not closed here: a connection still live at this
   * moment that dies later without ever settling the turn leaves the retained
   * frame to scope release. Closing it would mean carrying "delivery
   * indeterminate" as tripwire state and ruling it at scope release, which fires
   * neutralization failures on ordinary session closes that happen to have a
   * turn in flight — a false trip on every clean shutdown, to cover a window
   * this path already narrows to one that opens after the classification.
   */
  #ruleFailedSteerFrame(
    record: CodexSessionRecord,
    runId: RunId,
    steerFrame: OutboundTextFrame,
    delivery: CodexRequestDelivery,
  ): void {
    if (delivery !== "indeterminate") {
      // `unsent` never left, and `refused` is a provider ANSWER — proof it
      // received the directive and declined it, so it started no turn and
      // swallowed nothing. Every other failure is indeterminate by default,
      // which is what makes the unclassifiable case retain rather than forget.
      this.#outboundFrameTripwire.forgetFrame(steerFrame);
      return;
    }
    if (!record.connection.isClosed) {
      return;
    }
    this.#ruleSteerFrameFailClosed(record, runId, steerFrame);
  }

  /**
   * Rules ONE steer frame fail-closed and reports it with the full loudness of
   * the settlement path (T3.18).
   *
   * Reached on the one condition under which no terminal will ever rule the
   * frame AND no answer was produced: a response phase that died with the
   * connection. An acknowledgment naming an already-settled turn once landed
   * here too; that arm now consumes the frame on its own answered request in
   * `steerRun` (`#consumeAnsweredSteerFrame`), because a receipt the provider
   * just attested is not one to condemn the session over.
   *
   * Frame-scoped: settling the whole turn would trip the frame that OPENED it,
   * which is still live and whose delivery was never in doubt.
   *
   * A frame that is no longer pending — one the targeted turn's own terminal
   * already consumed in the same read chunk — settles as `no-correlated-frame`
   * and falls out here, so a frame ruled once is never ruled twice.
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
    // The same disposal the settlement path performs, in the same order: the
    // session arm first, so a consumer reacting synchronously to the run failure
    // cannot attach to the condemned process in between.
    this.#providerBindingQuarantine.disposeSession(record.sessionId);
    this.#ruleTurnTerminalAgainstRun(record.sessionId, runId, decision);
    this.#disposeQuarantinedSession(record);
  }

  /**
   * Consumes a steer's frame on its own answered request when the turn the
   * acknowledgment named can no longer be ruled by any terminal (T3.18).
   *
   * The expected outcome is a pass: the answered-request record was written on
   * this same synchronous path moments earlier, and the classification handed
   * in is recognized. The decision is still READ rather than discarded,
   * because the pass rests on an ordering this method cannot see —
   * `recordRequestAnswered` no-ops on a frame that is no longer pending, so an
   * edit that reorders the record after a consumption point would leave this
   * settlement to trip. A discarded return value turns that trip into
   * silence; handling it here gives it the settlement path's full disposal
   * and loudness instead.
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
    this.#providerBindingQuarantine.disposeSession(record.sessionId);
    this.#ruleTurnTerminalAgainstRun(record.sessionId, runId, decision);
    this.#disposeQuarantinedSession(record);
  }

  /**
   * Whether a terminal on `record` can still rule a frame correlated to
   * `turnId` (T3.18).
   *
   * Two ways the answer is no, and both end a frame's chance of ever being
   * ruled by the ordinary path:
   *
   *   * the turn has already settled — its terminal has been ingested and no
   *     second one is coming;
   *   * the record is no longer the one this manager holds for the session. The
   *     test is IDENTITY rather than presence: a supersede-resume installs a new
   *     record under the same session id and ingests nothing further on the old
   *     connection, so the replacement's memories are statements about a
   *     different process and answering from them would answer for the wrong
   *     leg.
   *
   * That second arm is defence in depth and is deliberately labelled as such:
   * every path that replaces or drops a record releases the predecessor's frames
   * in the SAME act, so the frame is already gone by the time this could be
   * asked and both answers lead to the same no-op. No test can tell the arms
   * apart today. It is kept because the predicate's meaning — can a terminal on
   * THIS leg still rule this frame — is what the caller depends on, and a rule
   * with no exception in it is the one that survives the next edit.
   *
   * ---------------------------------------------------------------------------
   * Why the LIVE route maps are not consulted, and what makes the absence sound
   * ---------------------------------------------------------------------------
   *
   * The obvious hardening — answer from positive liveness, `runIdByActiveTurnId`
   * or `interruptedRunIdByTurnId` — is refused because it answers the wrong
   * question. A provider may acknowledge a turn this leg never routed, and such a
   * turn is a perfectly good destination: the terminal path calls `settle` on
   * EVERY terminal it ingests, before any route lookup, so a frame moved onto an
   * unrouted turn is still ruled when that turn ends. Requiring a route would
   * fail those closed and trip a session over a directive the provider took
   * exactly where it said it did.
   *
   * Nor would it be defence in depth: a terminal retires its turn's route in the
   * same synchronous step that records the settlement, and turn ids are never
   * reused, so a routed turn is never a settled one and the two arms would agree
   * on every input. It would be an arm with no behaviour, which is noise.
   *
   * So the memory is asked, and absence is the answer — which is sound only
   * because `rememberSettledTurn` never drops an entry while a steer is in
   * flight. Without that pin this predicate would read an EVICTED settlement as
   * liveness and reopen, through aging, exactly the hazard the acknowledgement
   * guard closes.
   *
   * The residual, named rather than papered over: an acknowledgement that names a
   * turn which settled BEFORE this steer was sent and has since been pruned reads
   * as live here. No finite memory closes it — the ids a provider may name are
   * unbounded and this leg holds no other record of a turn it did not start — and
   * reaching it needs a provider that answers `turn/steer` with a turn it ended
   * dozens of turns ago, which is a different bug from the one this guards.
   */
  #canStillRuleFrameOnTurn(record: CodexSessionRecord, turnId: string): boolean {
    if (this.#sessions.get(record.sessionId) !== record) {
      return false;
    }
    return !record.settledTurnIds.has(turnId);
  }

  /** The `turn/steer` request itself, split out so `steerRun` reads as its policy. */
  async #requestTurnSteer(
    record: CodexSessionRecord,
    request: CodexSteerRunRequest,
    steerFrame: OutboundTextFrame,
    targetedTurnId: string,
  ): Promise<CodexRequestAttempt> {
    // Sent through the CLASSIFYING entry point: this caller's correctness turns
    // on whether the provider may have acted on the directive, and that is not
    // recoverable from the rejection `request` would raise.
    return await record.connection.attemptRequest("turn/steer", {
      threadId: record.threadId,
      input: [{ type: "text", text: steerFrame.wireText, text_elements: [] }],
      expectedTurnId: targetedTurnId,
      // P0-3: the REQUESTER's key, verbatim and never re-minted here — a fresh
      // value per retry is exactly what the daemon's `interventions` dedupe guard
      // exists to prevent. `clientUserMessageId` is the pinned home for a
      // caller-supplied message id, the same member `turn/start` above already
      // carries. Field verified present on `TurnSteerParams` in the default
      // generation of the pinned `codex-cli 0.150.1` (regenerated 2026-08-28);
      // `docs/reference/provider-wire/codex.md` does not print that params type,
      // but records the member on the sibling `TurnStartParams` as byte-identical
      // back to the `0.141.0` floor, and directs consumers to re-verify
      // load-bearing shapes against the then-installed binary.
      clientUserMessageId: request.clientIdempotencyKey,
    });
  }

  /**
   * True when the run has at least one live provider turn.
   *
   * A scan of the turn-keyed routes rather than a keyed lookup: the routes are
   * keyed by turn so that a run holding two live turns keeps both correlations,
   * and this question is the derived one. "At least one" is the honest reading
   * of the predicate under that shape — a run with two live turns has an active
   * turn by any account.
   */
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

  /**
   * Names the current holder of a session slot, or `undefined` when it is free.
   *
   * One predicate, so the live and in-flight views can never drift into
   * disagreeing about what "taken" means.
   */
  #describeSlotHolder(sessionId: SessionId): CodexSessionSlotState | undefined {
    // Transition FIRST. During a supersede-resume both views are occupied (the
    // predecessor's record plus the resume's claim), and during a teardown the
    // record deliberately stays installed until the transition settles — so
    // reading `#sessions` first would report `live` for a session that is dying.
    // The in-flight kind is the more specific truth in both cases.
    const transition = this.#sessionTransitions.get(sessionId);
    if (transition !== undefined) {
      return transition.kind;
    }
    return this.#sessions.has(sessionId) ? "live" : undefined;
  }

  /**
   * True when `record` is still the session's SETTLED, live holder.
   *
   * Stronger than an identity check on `#sessions`, and it has to be: a record
   * mid-teardown is still installed (that is what holds the slot), so identity
   * alone would report a dying session as usable.
   */
  #stillHoldsSlot(record: CodexSessionRecord): boolean {
    return (
      this.#describeSlotHolder(record.sessionId) === "live" &&
      this.#sessions.get(record.sessionId) === record
    );
  }

  /**
   * Claims the session slot in one state and runs the transition behind any
   * predecessor. The only way a slot is ever taken, in either direction.
   *
   * The read of the predecessor and the publication of the claim happen in ONE
   * synchronous run, which is the whole point. An `await` between them — even one
   * that finds the slot empty — yields a microtask, and two callers dispatched in
   * the same tick would both observe an empty slot, both proceed, and the second
   * would overwrite the first's claim while both transitions ran concurrently.
   *
   * `predecessor.then(runTransition)` rather than an inline async body, because
   * the two are not equivalent: an async IIFE runs synchronously up to its own
   * first `await`, so the transition would begin BEFORE the claim it depends on
   * was published — correct today only because nothing can interleave inside a
   * single synchronous run, which is an argument rather than a structure. `.then`
   * defers the body to a microtask, making "claimed before it runs" true by
   * construction. It also unifies the empty-slot case, which has no predecessor
   * to await and therefore no branch.
   *
   * Chaining rather than waiting-for-absence is what serializes a QUEUE: two
   * callers released by the same settlement would both observe a free slot.
   *
   * The stored view is rejection-swallowed: it exists to SEQUENCE, and a stored
   * promise that could reject would surface as an unhandled rejection whenever
   * nobody happened to be waiting on that session.
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
      // Identity-checked on the CLAIM OBJECT: only ever clear our own. A later
      // caller chains onto this one and publishes its own claim, so clearing
      // unconditionally would free a slot that is still occupied.
      if (this.#sessionTransitions.get(sessionId) === claim) {
        this.#sessionTransitions.delete(sessionId);
      }
    }
  }

  /**
   * Per-session connection options, with the manager interposed on the server
   * notification stream.
   *
   * The manager has to SEE the stream to retire routes on turn termination, but
   * it is not the consumer of it — the event normalizer (T3.5) is. Interposing
   * rather than competing keeps one sink: the manager observes, then hands the
   * frame on unchanged, in order, with the delegate's `(method, params)` shape
   * untouched. When no delegate is supplied the transport's own
   * `unconsumed-server-notification` diagnostic is preserved by re-reporting it
   * here, since the sink is now always present from the transport's point of
   * view.
   *
   * FRAME ROUTING IS CONSUMED HERE, NOT OWNED HERE. Both pinned providers
   * multiplex subagent, review, and compaction CHILD threads over the session's
   * own connection, so a frame arriving on this connection is not by that fact
   * the session's own. Deciding whose stream it came from — the thread-identity
   * registry, the fail-closed routing decision, and the bounded quarantine — is
   * `provider/thread-frame-router.ts`'s (T3.11). This seam therefore adds NO
   * routing decision of its own: it stamps the session this CONNECTION belongs
   * to and hands the frame on, and the terminal-emission boundary downstream
   * consumes the router's decision rather than re-deriving one. A second
   * decision here would be a second source of truth for the same question, and
   * the two would disagree exactly when a child thread's terminal must not
   * settle the parent's run.
   */
  #connectionOptionsFor(sessionId: SessionId): CodexConnectionOptions {
    const reportDiagnostic = this.#options.reportDiagnostic;
    const answerServerRequest = this.#options.answerServerRequest;
    return {
      ...this.#options,
      // Overridden rather than spread through: the transport-level port carries
      // no session or run identity, so binding one directly to a session would
      // hand the daemon an ask it cannot attribute. Resolving the run id HERE,
      // at answer time, is also what makes the attribution current — a run id
      // captured when the connection was built would name a turn that had
      // already retired.
      serverRequestResponder:
        answerServerRequest === undefined
          ? undefined
          : {
              answer: async (
                request: CodexInboundServerRequest,
              ): Promise<CodexServerRequestDecision> =>
                await answerServerRequest.answer({
                  ...request,
                  sessionId,
                  runId: this.#activeRunIdFor(sessionId),
                }),
            },
      onServerNotification: (method: string, params: unknown): void => {
        this.#observeServerNotification(sessionId, method, params);
        // EVERY inbound frame goes through the router before any projection
        // decision, and the delegate is reached only from inside that path
        // (`#handOffToNormalizeBand`), which carries the same module-boundary
        // containment this seam used to hold directly.
        //
        // Honest limit, recorded rather than left to be discovered: that guard
        // is NOT independently observable today. Delete the transport's
        // containment and a test fails; delete the inner one and none does,
        // because the outer catch reports an identical diagnostic (the
        // manager's own observation has already run by the time the delegate is
        // called, so nothing is skipped either way).
        try {
          this.#routeInboundNotification(sessionId, method, params);
        } catch (cause) {
          // The routing band is written to be total, so this is a backstop
          // rather than a path: it runs inside `#ingest`, and an escaping throw
          // would unwind the caller's read-chunk drain and take unrelated
          // frames down with it.
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
   * Record that a spawn offered the provider no callback-tool registry.
   *
   * NEVER SILENT, and never a refusal either: a session whose callback tools
   * are unreachable is degraded, not failed, so the daemon's request is
   * recorded as withheld and the session proceeds. An operator whose tools
   * stopped appearing finds the reason here rather than inferring it from an
   * absence. See {@link CODEX_CALLBACK_TOOL_REGISTRATION_UNAVAILABLE_DETAIL}.
   */
  /**
   * The spawn-time posture legs, plus the diagnostic for the one axis this
   * provider cannot express (T3.15 leg 5).
   *
   * `profileName` is deliberately NOT forwarded. It resolves to DAEMON-SIDE
   * presets, provider-uniform: by the time a posture reaches a driver the preset
   * has already been expanded into the mode, roots, and network axes carried
   * here, so forwarding the name would ask the provider to resolve a second time
   * against its own table and could disagree with what the daemon recorded. The
   * provider's own permission-profile surface is additionally experimental-gated
   * at this pin and unreachable while `experimentalApi` is `false`.
   *
   * The credential deny-list is realized in the CHILD ENVIRONMENT, not here: the
   * posture carries a content-addressed `credentialPolicyRef` rather than the
   * names, and the daemon composes the process environment this driver spawns
   * with. That is why this method reads no credential axis.
   */
  /**
   * The complete set of thread-establishment legs one posture and one subagent
   * policy realize, composed ONCE so the two cannot clobber each other.
   *
   * Both legs write into the SAME `config` table, and spreading two records that
   * each carry a `config` key would silently keep only the last — so the merge
   * happens here, structurally, rather than at each call site where the next
   * leg to acquire a config key would reintroduce the bug.
   *
   * Used by BOTH thread-establishing paths. `thread/fork` takes the same
   * override members as `thread/start` and applies them to the new thread, so
   * re-supplying them at a rewind is what keeps a forked session governed by the
   * posture its caller declared rather than by whatever the fork inherited.
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

  #composeSpawnPostureParams(posture: ExecutionPosture | undefined): Record<string, unknown> {
    if (posture === undefined) {
      return {};
    }
    this.#reportNarrowedNetworkAllowlist(posture);
    const { sandbox, approvalPolicy } = composeCodexThreadPosture(posture);
    // Destructured rather than spread: the named result type is what pins the
    // two keys to the provider's own vocabulary, and widening it to an index
    // signature to satisfy the spread would give that pin away.
    return { sandbox, approvalPolicy };
  }

  /**
   * Compares the realized sandbox against the requested posture and records a
   * divergence. Called on every path that establishes a thread.
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
    // Reported per TURN as well as per spawn when the run brings its own
    // posture: the narrowing is a property of the policy actually applied, and a
    // run that introduces an allow-list on a session spawned without one would
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
   * Records every subagent definition this spawn withheld (T3.15 leg 4's
   * fail-closed rule).
   *
   * The caps ARE still sent even though the definitions are not — they are the
   * half the provider enforces natively, and dropping them because the other
   * half could not be realized would leave a session with no concurrency
   * ceiling at all. Composing them is `composeCodexSubagentConfigOverrides`'s
   * job; this method only reports, which is why it returns nothing.
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
        // UNTRUSTED caller-supplied text carried verbatim as data, so an
        // operator can see WHICH definition was withheld.
        details: { definitionName: definition.name },
      });
    }
  }

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
    // BOTH sinks, and the duplication is the point: the local transport arm is
    // this driver's own structured record, while the censused kind is the one
    // the daemon's counters name. Reporting only the local arm would leave a
    // withholding invisible to every operator surface that reads the counters.
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
   * The run whose turn is currently active on a session, or `null`.
   *
   * Answered only when every live turn on the session belongs to ONE run. The
   * routed ask this attributes carries no turn id — `CodexInboundServerRequest`
   * holds a method, a kind, and raw params — so with turns from TWO runs live
   * there is nothing to disambiguate them with, and picking either would
   * attribute the ask, and its `driver_ask.requested` projection, to a run that
   * may not have raised it. But the count that decides is of RUNS, not turns:
   * two overlapping accepted starts on one run — the very shape the turn-keyed
   * routes retain — put two turns on the session whose values all name the same
   * run, and that attribution is unambiguous at any turn count, so a turn-count
   * gate here would drop the association in exactly the state the routing
   * supports.
   *
   * This deliberately replaces a "first entry wins" pick justified by Codex
   * serializing turns per thread. That serialization is a claim about the
   * PROVIDER; it says nothing about the daemon. A `null` here is the same real
   * answer the establishment and post-retirement windows already produce, and
   * it is what {@link CodexSessionServerRequest} documents as the un-attributed
   * case.
   */
  #activeRunIdFor(sessionId: SessionId): RunId | null {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      return null;
    }
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

  /**
   * Retires the route bound to a turn the provider has just ended.
   *
   * Without this, only `interruptRun` and `closeSession` ever clear a route, so a
   * turn that simply FINISHES leaks both map entries for the daemon's lifetime
   * and `hasActiveTurn` keeps reporting the run live — which would let a later
   * intervention target a turn id the provider retired long ago.
   */
  #observeServerNotification(sessionId: SessionId, method: string, params: unknown): void {
    // T3.18, in-flight half. Evidence accrues across the turn because this
    // provider's terminal notification does not always carry the item list —
    // `itemsView` can read `notLoaded` — so a classifier that only ever read
    // the settling frame would call a real turn evidence-free. The observation
    // is keyed by turn id, which is what the item notifications carry.
    const inFlightEvidence = classifyCodexTurnEvidenceObservation(method, params);
    if (inFlightEvidence !== null) {
      this.#outboundFrameTripwire.observe(inFlightEvidence.turnId, inFlightEvidence.observation);
      const observingRecord = this.#sessions.get(sessionId);
      if (
        observingRecord !== undefined &&
        !this.#outboundFrameTripwire.hasPendingFrame(inFlightEvidence.turnId)
      ) {
        // Nothing is correlated onto this turn YET. The frame may still be
        // waiting on the `turn/start` continuation that re-keys it, so the
        // observation is remembered rather than dropped — without it, evidence
        // that exonerates a real turn would be lost and `startRun` would rule
        // the re-keyed frame on the terminal alone and trip it.
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
      // No record means no route can exist for this turn yet, and none can be
      // installed against a session this manager does not hold. Nothing to
      // remember.
      return;
    }
    // T3.18. Marked for EVERY terminal, before any of the ruling below and
    // whether or not a route or a correlated frame is waiting on it. The two
    // memories beside it are both conditional — one is written only when no
    // route matched, the other only for interrupted runs — so neither can be
    // asked the plain question "has this turn ended", which is what `steerRun`
    // needs before it moves a frame onto a turn the provider named.
    //
    // A refusal returns WITHOUT ruling this terminal, and that is the stricter
    // answer rather than a dropped one: the refusal quarantines the binding and
    // tears it down, and the teardown rules every frame still pending on the
    // scope fail-closed — this turn's included — where ruling here would have
    // settled only the frames correlated to this one turn.
    if (!rememberSettledTurn(record, turnId)) {
      this.#refuseUnretainableSettledTurn(record);
      return;
    }
    // Keyed by TURN id throughout, never by run id. A run whose route was
    // superseded (by a resume), already retired (by an interrupt), or that holds
    // a SECOND live turn must not have a turn beside this one cleared out from
    // under it by this terminal. The decision is retained by the tripwire, which
    // is what lets the intervention dispatcher answer a steer already ruled on.
    const classification = classifyCodexTurnEvidence(params);
    const decision = this.#outboundFrameTripwire.settle(turnId, classification);
    if (decision.tripped) {
      // Quarantine first, then report: a consumer reacting synchronously to the
      // terminal must not be able to attach to the process that just swallowed
      // the text. BOTH axes, because a run-keyed refusal alone leaves the
      // session record live and a later `startRun` resolves that record by
      // session id without ever consulting the run key.
      this.#providerBindingQuarantine.disposeSession(sessionId);
    }

    let matchedRoute = false;
    // A DIRECT LOOKUP on the settling turn's own route, which is what makes the
    // ruling reach the run under N live turns. The scan this replaced compared
    // each run's single recorded turn against this one, so a run whose second
    // accepted start had overwritten the first's entry matched nothing when the
    // FIRST turn settled: the trip quarantined the session and the run heard
    // nothing at all. Consuming the settling turn's own route — and only it —
    // leaves every other live turn on this run still correlated.
    const routedRunId = record.runIdByActiveTurnId.get(turnId);
    if (routedRunId !== undefined) {
      this.#retireTurnRoute(record, turnId);
      this.#ruleTurnTerminalAgainstRun(sessionId, routedRunId, decision);
      matchedRoute = true;
    }
    // The interrupted half. A run whose route an interrupt retired is not in the
    // live map above and never will be again, so without this the ruling for its
    // turn would reach the session and not the run. Disjoint from the loop by
    // construction rather than by luck: `interruptRun` deletes the live route in
    // the same synchronous step that records this correlation, and a turn id is
    // never reused, so no run can be in both sets for one turn.
    const interruptedRunId = record.interruptedRunIdByTurnId.get(turnId);
    if (interruptedRunId !== undefined) {
      // Released whatever the ruling was — the terminal this entry was waiting
      // for has arrived, so a benign one frees it exactly as a trip does.
      record.interruptedRunIdByTurnId.delete(turnId);
      this.#ruleTurnTerminalAgainstRun(sessionId, interruptedRunId, decision);
      matchedRoute = true;
    }
    if (decision.tripped) {
      // The promised recovery is a FRESH SPAWN, so the condemned process is torn
      // down rather than merely refused. Fire-and-forget because this runs inside
      // the synchronous read-chunk drain: an awaited teardown would stall the
      // frames behind it and a thrown one would unwind the whole drain.
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
   * Applies a settled turn's tripwire ruling to one run (T3.18).
   *
   * Quarantines the run's binding and reports the failure on the run itself. The
   * SESSION arm is not here: it is applied once per terminal by the caller,
   * before any run is touched, so a consumer reacting synchronously to the first
   * run's failure cannot attach to the process in between.
   */
  #ruleTurnTerminalAgainstRun(
    sessionId: SessionId,
    runId: RunId,
    decision: TripwireDecision,
  ): void {
    if (!decision.tripped) {
      return;
    }
    this.#providerBindingQuarantine.disposeRun(runId, sessionId);
    this.#reportTextNeutralizationFailure(
      sessionId,
      runId,
      composeTextNeutralizationRunFailure(decision),
    );
  }

  /**
   * The loud path for a session whose turn-evidence memory can no longer hold
   * what it is owed (T3.18).
   *
   * Reached only from `rememberUnmatchedTurn`'s refusal, which fires when the
   * memory is at its ceiling while a `turn/start` is in flight — so every entry
   * in it may be the terminal that start's continuation will claim, and the
   * incoming one cannot be admitted beside them. There is no quiet answer here:
   * dropping the newcomer loses this turn's evidence, and evicting to admit it
   * loses somebody else's. Both losses are silent, and a lost terminal is a
   * swallowed turn reported as a completed one.
   */
  #refuseUnretainableTurnEvidence(record: CodexSessionRecord): void {
    this.#refuseUnretainableTurnMemory(record, {
      kind: "turn-evidence-memory-overflowed",
      retainedTurnCount: record.unmatchedTurnEvidence.size,
    });
  }

  /**
   * The same loud path for a session whose SETTLED-turn memory can no longer
   * hold what a live reader is owed (T3.18).
   *
   * Reached only from `rememberSettledTurn`'s refusal, which fires when that
   * memory is at its ceiling while a `turn/steer` is in flight — so every entry
   * in it may be the settlement the acknowledgement continuation is about to
   * read, and evicting one would answer "still running" for a turn that ended.
   * The loss is the mirror image of the evidence memory's and just as silent:
   * there the terminal goes missing, here the turn's END does, and both end with
   * a frame nothing will ever rule.
   */
  #refuseUnretainableSettledTurn(record: CodexSessionRecord): void {
    this.#refuseUnretainableTurnMemory(record, {
      kind: "settled-turn-memory-overflowed",
      retainedTurnCount: record.settledTurnIds.size,
    });
  }

  /**
   * The same loud path for a session whose INTERRUPTED-route memory can no
   * longer hold what the terminal path is owed (T3.18).
   *
   * Reached only from `rememberInterruptedRun`'s refusal. Unlike its two
   * siblings this fires under no in-flight condition, because that memory has
   * no free-prune window to fall back to outside one — every retained entry is
   * still owed its terminal, so evicting any of them would rule that terminal
   * against no run and the interrupted run's subscribers would hear nothing.
   */
  #refuseUnretainableInterruptedRoute(record: CodexSessionRecord): void {
    this.#refuseUnretainableTurnMemory(record, {
      kind: "interrupted-route-memory-overflowed",
      retainedTurnCount: record.interruptedRunIdByTurnId.size,
    });
  }

  /**
   * Refuses a binding whose per-session turn memory overflowed, reporting which
   * one (T3.18).
   *
   * The session is quarantined and torn down, which rules every frame still
   * pending on it fail-closed and reports the runs that wrote them — the same
   * treatment an ambiguous `turn/start` gets, and for the same reason: this
   * driver will not carry a session whose turns it can no longer account for.
   *
   * One body for the three memories rather than three, because "the same
   * loudness the ordinary path would have" is the claim each of them makes, and
   * several copies of it are several things to keep equal.
   */
  #refuseUnretainableTurnMemory(
    record: CodexSessionRecord,
    diagnostic: CodexTransportDiagnostic,
  ): void {
    if (this.#providerBindingQuarantine.isSessionDisposed(record.sessionId)) {
      // Already condemned, so the refusal is made and nothing here is a second
      // decision. Guarded because the drain that overflowed the memory keeps
      // running after this: every remaining frame in the chunk would otherwise
      // re-refuse a session already going away and bury the one report that
      // matters under a storm of duplicates.
      return;
    }
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, diagnostic);
    this.#providerBindingQuarantine.disposeSession(record.sessionId);
    this.#disposeQuarantinedSession(record);
  }

  /**
   * Rules every frame a departing binding leaves unsettled, fail-closed (T3.18).
   *
   * Called where a session is taken away from turns that were still LIVE — a
   * quarantine teardown, an ambiguous `turn/start` disposal, a resume that
   * supersedes the leg its predecessor's turns are running on. Those turns will
   * never deliver a terminal to this driver, so the frames written into them are
   * owed a ruling that nothing else will ever make. Dropping them, which is what
   * releasing the scope alone does, is the swallowed turn reported as nothing at
   * all: the participant's words went to a provider process the daemon then
   * killed, and no run heard a thing.
   *
   * Ruled with `UNRECOGNIZED_TURN_EVIDENCE` because that is exactly what the
   * driver knows — no settling envelope was ever seen — and it is the same
   * classification the steer path's fail-closed arm uses. Exempt frames still
   * pass, since `#rule` answers on the frame before the classification.
   *
   * Reported at most ONCE per run: a run whose binding this driver already
   * disposed has already had its `run.failed` composed from the ruling that
   * disposed it, and a second report for the same cause would read as a second
   * failure. The quarantine is the record of that, which is why it is consulted
   * rather than a set built here.
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
      if (runId === undefined || this.#providerBindingQuarantine.isRunDisposed(runId)) {
        continue;
      }
      reportedRunIds.add(runId);
      this.#ruleTurnTerminalAgainstRun(record.sessionId, runId, ruling.decision);
    }
    // Emitted whenever a teardown ruled anything, INCLUDING the case where every
    // ruling was a duplicate of a report already made. The two counts are the
    // point: the first says how many writes this binding was carrying when it
    // was taken away, and it is the operator's only sight of them, since a frame
    // ruled here delivers no terminal of its own. A pass that reported nothing
    // is not a pass that did nothing.
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
      kind: "abandoned-frames-ruled",
      ruledFrameCount: rulings.length,
      reportedRunCount: reportedRunIds.size,
    });
  }

  /**
   * Fails the runs whose frames a RESUME superseded before the provider settled
   * them (T3.18).
   *
   * The visible-failure guarantee this closes: a participant's text that
   * provably may not have reached the model never silently vanishes. A resume
   * replaces the binding those frames were written on, so no terminal for them
   * can ever arrive — and before this existed the frames were dropped with the
   * scope's budget, leaving the run to look exactly like one whose words landed.
   *
   * Reported through the SAME seam a trip reports through, and with a
   * deliberately different cause on it. The seam is "the driver states that the
   * run failed and why", which is what happened; the cause is
   * `composeSupersededDeliveryRunFailure`, which carries no dotted code and
   * claims only what is known. Borrowing the trip's detail would publish a
   * swallow nobody observed, and the registered code's parseable form is read by
   * a consumer that would then read it as one.
   *
   * Reported at most ONCE per run. Several frames can belong to one run — an
   * opening frame and a steer, or two steers — and one supersede is one cause,
   * not one cause per frame.
   *
   * `record` is the leg being superseded, captured before the swap. It is
   * `undefined` only where the resume found no predecessor, in which case there
   * is no route map to resolve through and the third source below is the whole
   * answer.
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
    // Emitted whenever a supersede abandoned anything, INCLUDING the case where
    // no frame resolved to a run. The two counts are the point: the first says
    // how many writes the superseded binding was carrying, and it is the
    // operator's only sight of them, since a frame abandoned here delivers no
    // terminal of its own.
    reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
      kind: "superseded-frames-failed",
      abandonedFrameCount: abandoned.length,
      reportedRunCount: reportedRunIds.size,
    });
  }

  /**
   * The run a join key names when there is no record to route through — the
   * third of `#runIdForAbandonedFrame`'s three sources, on its own.
   *
   * Matched against the run axis rather than cast, for that method's reason: a
   * turn id that outlived its route maps must not be mistaken for a run.
   */
  #runIdBoundToSession(joinKey: string, sessionId: SessionId): RunId | undefined {
    for (const [runId, boundSessionId] of this.#sessionIdByRunId) {
      if (runId === joinKey && boundSessionId === sessionId) {
        return runId;
      }
    }
    return undefined;
  }

  /**
   * The run an abandoned frame's correlation key names, or `undefined`.
   *
   * Three sources, in the order a frame moves through them: a live turn's route,
   * an interrupted turn's retained correlation, and — for a frame the provider
   * never named a turn for — the run id the frame was registered under. The last
   * is matched against the run axis rather than cast, so a turn id that outlived
   * both route maps cannot be mistaken for a run and reported against.
   *
   * `undefined` is a real answer, and the case it covers is already accounted
   * for elsewhere: an opening frame whose `turn/start` has not been answered yet
   * is keyed by a run whose session binding is not installed until that answer,
   * and every failure path of that call THROWS to its caller — which is how the
   * run learns, and why `startRun` withdraws that frame itself rather than
   * leaving it to be ruled here.
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
   * Tears down a session whose binding a tripwire trip condemned (T3.18).
   *
   * Reuses the ambiguous-turn disposal rather than inventing a second teardown:
   * the condition is the same one that path already names — a connection whose
   * answers cannot be trusted — so it claims the slot, drops the record under the
   * same identity gate, and kills the child the same way.
   *
   * Detached on purpose. Every caller is either inside the synchronous read-chunk
   * drain or on the settlement path of a turn that has already been ruled, and
   * neither may be made to wait on a child's death or be unwound by one.
   *
   * The teardown is BEST-EFFORT and the refusal is not: the quarantine entry is
   * installed synchronously by the caller before this runs, so every later
   * resolution path refuses whether or not the child actually dies.
   */
  #disposeQuarantinedSession(record: CodexSessionRecord): void {
    void this.#disposeAmbiguousSession(record).catch(() => {
      // Unreachable by construction — that path already contains its own
      // teardown fault and does nothing else that can throw. Guarded anyway
      // because an unhandled rejection out of the read-chunk drain would be a
      // second failure on top of the one being handled.
    });
  }

  /**
   * The retained tripwire decision for a turn (T3.18).
   *
   * Read by the intervention dispatcher so a steer whose turn has ALREADY been
   * ruled swallowed can settle `degraded` carrying the refusal code. That is
   * the whole of the member's best-effort character: the dispatcher asks once,
   * at the moment its own result resolves, and never holds the call open
   * waiting for a settlement that may be arbitrarily far away.
   */
  textNeutralizationDecisionForTurn(turnId: string): { readonly refused: boolean } {
    return { refused: this.#outboundFrameTripwire.decisionFor(turnId)?.tripped === true };
  }

  // A throwing consumer must not become a second failure on top of the one being
  // reported: the run terminal is the guarantee, and losing it because a
  // listener threw would leave the swallowed turn with no record at all.
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
   * Tears down a connection whose outcome no longer matters, without letting the
   * teardown change the outcome of the operation that abandoned it.
   *
   * `close()` swallows a host that no longer knows the session, but an injected
   * subscription disposer is caller code and can throw. All three call sites need
   * that failure contained, and each already holds the outcome that matters: a
   * succeeded resume has produced its `resumed` result, a failed resume is
   * mid-flight to the typed `recovery-needed` result I-005-5 requires, and a
   * failed create is about to rethrow the spawn or handshake cause that explains
   * itself. `closeSession` deliberately does NOT route through here — a close has
   * no other outcome to protect, so its caller is exactly who should hear that
   * the disposer misbehaved.
   */
  async #releaseAbandonedConnection(connection: CodexAppServerConnection): Promise<void> {
    try {
      await connection.close();
    } catch {
      // Deliberately swallowed — see the note above. The transport is abandoned
      // either way; a refusing teardown is a host-level condition, not a result.
    }
  }

  /**
   * Retires ONE turn's route, and the run's session binding with it only when
   * that turn was the run's last.
   *
   * The two axes retire on different conditions and always have — the turn axis
   * is per turn, the run axis is per run — but while the routes were run-keyed
   * the two conditions coincided and one `delete` each was enough. Under N live
   * turns they come apart: dropping `#sessionIdByRunId` when a run still holds
   * another live turn would strand that turn's own steer and interrupt paths,
   * which resolve the session through exactly that map, and `hasActiveTurn`
   * would report the run idle while the provider was still working for it.
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
   * Drops every run route bound to a session, scanning BY VALUE.
   *
   * Keyed lookup is not available: the routes are keyed by run, and the record
   * that could enumerate them is either gone or replaced by the time a sweep is
   * owed. Mirrors the Claude leg's `#forgetSession`.
   */
  #forgetRunRoutes(sessionId: SessionId): void {
    for (const [runId, boundSessionId] of this.#sessionIdByRunId) {
      if (boundSessionId === sessionId) {
        this.#sessionIdByRunId.delete(runId);
      }
    }
  }

  /**
   * Drops the unsettled frames of a binding this manager no longer holds.
   *
   * Called only where the record is already gone or replaced — the point past
   * which `#observeServerNotification` ingests nothing for this session, so no
   * ruling can be owed. Retained DECISIONS deliberately survive: they are keyed
   * by turn and the intervention dispatcher reads them back after the binding
   * has been torn down, which is exactly when it most needs the answer.
   */
  #releaseOutboundFrameBudget(sessionId: SessionId): void {
    this.#outboundFrameTripwire.forgetScope(sessionId);
  }

  #requireSession(sessionId: SessionId): CodexSessionRecord {
    // T3.18, and FIRST for the same reason `#requireActiveTurn` consults the
    // run axis first: a trip condemns the provider process, not just the run
    // that was on it, and this is the one resolution every later operation on
    // the session — `startRun` included — passes through. Without it a new run
    // would resolve the surviving record by session id and dispatch into the
    // process that swallowed the participant's words. Released at establishment,
    // so the promised recovery — a fresh spawn — is the thing that lifts it.
    this.#providerBindingQuarantine.assertSessionAttachable(sessionId);
    // The entrance requires a SETTLED live slot, not merely a non-closing one.
    // Both transition states have to refuse, and for the same reason: a record
    // stays installed across its whole transition — that is what holds the slot —
    // so "installed" has stopped implying "usable" in either direction.
    //
    // `closing` is the obvious half. `establishing` is the half that was missed:
    // a supersede-resume publishes it while the PREDECESSOR record is still in
    // `#sessions`, so a guard that only rejected `closing` handed that predecessor
    // out and let a turn be dispatched to a connection the resume was about to
    // release. If the answer then landed before the resume settled, the run was
    // refused post-await with the turn already ACCEPTED — and if that resume went
    // on to FAIL, its catch path left the predecessor live, so the turn kept
    // executing tools on a session the daemon would happily reuse. Refusing at
    // the entrance is what keeps that turn from being started at all.
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
   * Resolves the live turn a steer or an interrupt acts on.
   *
   * The quarantine is consulted FIRST, and the ordering is the point (T3.18).
   * A trip disposes the run's binding and retires its route, so without this
   * check the very next steer would fail with "no active turn" — a plausible
   * wrong cause that reads as a race and invites a retry into the process that
   * already swallowed the participant's words. This is the Codex half of the
   * assertion that separates FAILED THE RUN from QUARANTINED THE PROCESS; the
   * Claude half sits on `findChannelForRun`, which its interrupt and cancel
   * paths both pass through. The coverage is symmetric even though the call
   * sites are not: Claude has no native steer, and its dispatcher degrades that
   * arm without resolving the run at all, so there is no Claude steer path for
   * a quarantine to guard.
   */
  #requireActiveTurn(runId: RunId): { record: CodexSessionRecord; turnId: string } {
    this.#providerBindingQuarantine.assertRunAttachable(runId);
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

function readThread(response: unknown, method: string): ThreadView {
  const record = isPlainObject(response) ? response : {};
  const thread = record["thread"];
  // Routed through the shared guard so an ARRAY is refused here too. The former
  // `typeof thread !== "object"` check admitted one, and an array's `["id"]`
  // reads `undefined`, so a malformed response reached the identity check as a
  // merely-absent field rather than as the wrong shape it is.
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
 * Reads the ordered turn ids out of a `Thread.turns` array.
 *
 * TOTAL rather than throwing. This list is a BOOKKEEPING seed, not an identity:
 * `readThread` has already refused a response whose thread cannot be identified,
 * and a resume or fork whose history is unreadable is still a resume or fork
 * that happened. Throwing here would convert a degraded position axis into a
 * failed lifecycle operation, which is a strictly worse trade.
 *
 * Non-string and empty entries are SKIPPED rather than preserved as holes: an
 * entry that cannot name a turn cannot be a rewind boundary either, and keeping
 * a placeholder would shift every later ordinal onto the wrong turn.
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
 * Reads the turn a `turn/steer` acknowledgement named, or `null` when it named none.
 *
 * TOTAL rather than throwing, unlike `readTurnId` beside it, and the difference
 * is the point: a steer whose ack is unreadable is not a transport fault — the
 * request WAS answered — it is an acknowledgement carrying no evidence, and
 * P3-1 grades that as a degraded intervention rather than as an outage. Throwing
 * here would tell the orchestration layer to treat a live provider as unreachable.
 *
 * `TurnSteerResponse` is the flat `{ turnId }` at the pin, deliberately NOT the
 * `{ turn: { id } }` shape `turn/start` answers with — reading the wrong one
 * would return `null` for every successful steer.
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
