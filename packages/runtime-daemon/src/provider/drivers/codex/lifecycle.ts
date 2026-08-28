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
// `docs/reference/provider-wire/codex.md` (pinned `codex-cli 0.149.1`),
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

import { CodexTerminalEmissionGate } from "./event-normalizer.js";
import type { CodexSteerAcknowledgement, CodexSteerRunRequest } from "./intervention.js";

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
 * generated `ServerRequest` union at `codex-cli 0.149.1` (regenerate, never
 * transcribe — `docs/reference/provider-wire/codex.md`; re-verified against the
 * installed binary's own generation on 2026-08-27).
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
 * generation ONLY. Direct comparison of three default generations
 * (`codex-cli 0.149.1` and the installed `0.150.1`) against the experimental
 * one: `ThreadStartParams` carries 15 properties by default and 26 under
 * `--experimental`, and `dynamicTools` is one of the eleven that appear only
 * there. This driver negotiates `experimentalApi: false` — the posture T3.23
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
 * 0.149.1` publishes exactly these eight `thread/realtime/*` names. V1 ships no
 * realtime voice surface, so every one of them would reach the normalizer's
 * default branch and land on the diagnostic channel as an unmapped wire kind —
 * a per-audio-delta record on a stream that emits deltas continuously. Opting
 * out at negotiation suppresses them at the source instead, which is the
 * provider's own mechanism for exactly this (`InitializeCapabilities
 * .optOutNotificationMethods`: "Exact notification method names that should be
 * suppressed for this connection").
 *
 * SUPPRESSION IS NOT A CENSUS EXEMPTION. The list is exact-match by design and
 * this census is one release's snapshot: the installed `0.150.1` generation
 * already publishes three further names (`thread/realtime/item/started`,
 * `thread/realtime/item/completed`, `thread/realtime/item/transcript/delta`)
 * that this pin does not. Those are deliberately NOT suppressed here — a name
 * beyond the pin backstops through the normalizer's default branch and becomes
 * a diagnostic, which is how the growth is discovered rather than absorbed.
 * Re-derive this list when the pin moves; never widen it to quiet a diagnostic.
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
]);

/**
 * The provider's ONLY terminal-turn notification.
 *
 * Read from the generated `ServerNotification` union at `codex-cli 0.149.1`
 * (regenerated 2026-08-27): the `turn/*` family is exactly `turn/started`,
 * `turn/completed`, `turn/diff/updated`, `turn/plan/updated`, and
 * `turn/moderationMetadata`. There is no `turn/failed` and no `turn/interrupted`
 * — a failed or interrupted turn arrives on THIS method and is discriminated by
 * `turn.status`, so a terminal set keyed on method strings would be wrong.
 */
const CODEX_TURN_COMPLETED_NOTIFICATION = "turn/completed";

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
 * How many unmatched terminal turn ids one session remembers (see `startRun`).
 *
 * Small and fixed: the memory exists to survive a same-chunk response/completion
 * interleave, whose window is one microtask, plus the ordinary post-interrupt
 * duplicate. Anything that accumulates beyond a handful is a provider emitting
 * terminals for turns this driver never started, which is exactly the case an
 * unbounded set must not turn into a leak.
 */
const CODEX_TERMINATED_TURN_MEMORY = 64;

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
    this.providerErrorData = providerErrorData;
  }
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
   * A `thread/fork` response carried no readable turn list, so the forked
   * thread's boundary ledger was rebuilt from the local ordinal rather than from
   * the provider's own answer (T3.15 leg 1).
   *
   * Reported rather than fatal: the fork ITSELF succeeded and the rewind is
   * real, so failing the operation would discard a completed rewind over a
   * bookkeeping disagreement. What is lost is only the corroboration that the
   * daemon's ordinal and the provider's history agree — which is exactly the
   * kind of divergence an operator needs told about and a caller cannot act on.
   */
  | { kind: "fork-turn-ledger-unconfirmed"; expectedTurnCount: number }
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
  | { kind: "subagent-definition-withheld"; definitionName: string; reason: string };

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
  return { cwd, env };
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
      // Exactly the caller-supplied pairs plus the binary path the prelude reads.
      // `process.env` is never consulted (asserted by test).
      env: [
        ...config.env.map((pair) => [pair[0], pair[1]] as [string, string]),
        [CODEX_APP_SERVER_BIN_ENV_VAR, this.#executablePath] as [string, string],
      ],
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
          // for why the list is the pin's eight names and not the installed
          // build's eleven.
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
    // this function then SUSPENDS on the write below before `return settled`
    // gives the caller a handler. A child exit during that window rejects a
    // promise nobody is attached to, and Node's default
    // `--unhandled-rejections=throw` turns that into a dead daemon. Worse, if
    // the write then rejects too, the catch finds `#pending` already emptied and
    // rethrows, so `return settled` never runs and the rejection is permanently
    // unhandled.
    //
    // Attaching a no-op handler marks `settled` handled without consuming it:
    // the caller still receives the rejection through the returned promise,
    // because `.catch()` observes rather than replaces.
    settled.catch(() => {
      /* the returned promise is the caller's channel; this only marks it handled */
    });

    try {
      await this.#writeFrame({ jsonrpc: "2.0", id: requestId, method, params });
    } catch (cause) {
      const pending = this.#pending.get(key);
      if (pending !== undefined) {
        this.#pending.delete(key);
        pending.cancelDeadline();
      }
      throw cause;
    }
    return settled;
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

  async #writeFrame(frame: Record<string, unknown>): Promise<void> {
    const ptySessionId = this.#ptySessionId;
    if (ptySessionId === null) {
      throw new CodexTransportError("The Codex app-server connection is not open.");
    }
    // Single write site: every outbound byte of this protocol passes here, so a
    // transport-level change (framing, neutralization at T3.18) lands once.
    await this.#ptyHost.write(ptySessionId, this.#encoder.encode(`${JSON.stringify(frame)}\n`));
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
   * DELIBERATELY UNCAPPED, unlike `terminatedTurnIds` beside it. That memory is
   * a short race window whose oldest entry is the least relevant; this ledger IS
   * the position axis, so evicting its head would silently re-map every later
   * ordinal and a rewind would land on the wrong turn. A turn id is a UUID: a
   * session long enough for this to cost memory does not exist, and a wrong
   * rewind would.
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
  readonly spawnConfig: CodexSessionConfig;
  readonly activeTurnIdByRunId: Map<RunId, string>;
  /**
   * Turn ids whose terminal notification arrived while no route pointed at them.
   * Insertion-ordered and capped (`CODEX_TERMINATED_TURN_MEMORY`); consumed by
   * `startRun`. See the note there for the interleave this exists to survive.
   */
  readonly terminatedTurnIds: Set<string>;
}

/**
 * Records a terminal turn id in a session's bounded FIFO memory.
 *
 * Re-inserted rather than skipped on a repeat so a duplicate terminal refreshes
 * its position instead of aging out while still relevant. Eviction is oldest
 * first, which is the right end: the hazard this memory covers is resolved
 * within one microtask of the turn starting, so the oldest entry is always the
 * least likely to still be claimed.
 */
function rememberTerminatedTurn(record: CodexSessionRecord, turnId: string): void {
  const memory = record.terminatedTurnIds;
  memory.delete(turnId);
  memory.add(turnId);
  while (memory.size > CODEX_TERMINATED_TURN_MEMORY) {
    const oldest = memory.values().next();
    if (oldest.done === true) {
      break;
    }
    memory.delete(oldest.value);
  }
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

/** Construction inputs for the lifecycle manager. */
export interface CodexLifecycleOptions extends CodexConnectionOptions {
  /**
   * Spawn context for a RESUME when this process holds no record of the session
   * (the daemon-restart case, which is the ordinary one).
   *
   * `ResumeSessionParams` carries neither `cwd` nor `env`, yet a spawn needs
   * both — and an empty environment is not a safe default: the provider locates
   * its credential home and its own tooling through environment variables, so a
   * resume launched bare would fail in a way that looks like a bad handle. The
   * resumed THREAD restores its own recorded working directory through
   * `thread/resume`, so `cwd` here is the process's directory rather than the
   * thread's. Required, never defaulted, so nothing is silently inherited from
   * the daemon process (this module reads `process.env` nowhere).
   */
  readonly resumeSpawnConfig: CodexSessionConfig;
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
}

/**
 * The five lifecycle operations of `Spec-005 §Required Behavior`, expressed as
 * Codex `app-server` calls over one connection per session.
 */
export class CodexLifecycleManager {
  readonly #options: CodexLifecycleOptions;
  readonly #newBindingId: () => string;
  readonly #turnStartTimeoutMs: number;
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
    const config = parseCodexSessionConfig(params.config);
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
        // binary's own generated schema at `codex-cli 0.149.1`, regenerated
        // 2026-08-27 — `docs/reference/provider-wire/codex.md`), so the pin is
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
        activeTurnIdByRunId: new Map(),
        terminatedTurnIds: new Set(),
      });
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

  async #establishResumedSession(params: ResumeSessionParams): Promise<DriverResumeResult> {
    // Read INSIDE the claimed establishment, never at the call site: the claim
    // chains behind any predecessor, so this read must happen after that
    // predecessor has installed its record for the supersede to see it.
    const existing = this.#sessions.get(params.sessionId);
    const spawnConfig = existing?.spawnConfig ?? this.#options.resumeSpawnConfig;
    const connection = new CodexAppServerConnection(this.#connectionOptionsFor(params.sessionId));
    try {
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
        activeTurnIdByRunId: new Map(),
        terminatedTurnIds: new Set(),
      });
      // The replacement record starts with an empty turn map, so every route
      // that pointed at the superseded leg is now dead. Swept here rather than
      // at teardown: `closeSession` reads the LIVE record, which no longer knows
      // those runs, so a route left behind would never be collected and the map
      // would grow by one entry per in-flight run per resume, for the daemon's
      // whole lifetime.
      this.#forgetRunRoutes(params.sessionId);
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
    let turnId: string;
    try {
      turnId = readTurnId(await this.#requestTurnStart(record, runConfig, params), "turn/start");
    } catch (cause) {
      if (isAmbiguousTurnStartOutcome(cause)) {
        await this.#disposeAmbiguousSession(record);
      }
      throw cause;
    }
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
    record.activeTurnIdByRunId.set(params.runId, turnId);
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
    // record's short memory of unmatched terminals closes that window; the
    // `delete` is the consume, so a later turn reusing the id (it cannot — turn
    // ids are UUIDv7) could not be retired twice.
    if (record.terminatedTurnIds.delete(turnId)) {
      record.activeTurnIdByRunId.delete(params.runId);
      this.#sessionIdByRunId.delete(params.runId);
    }
  }

  /** The `turn/start` request itself, split out so `startRun` reads as its policy. */
  async #requestTurnStart(
    record: CodexSessionRecord,
    runConfig: CodexRunConfig,
    params: StartRunParams,
  ): Promise<unknown> {
    return await record.connection.request(
      "turn/start",
      {
        threadId: record.threadId,
        input: [{ type: "text", text: runConfig.input, text_elements: [] }],
        // The pin that actually carries the security property. A TURN is what
        // generates approval requests, and `TurnStartParams.approvalsReviewer` is
        // documented as overriding routing for "this turn and subsequent turns"
        // — so a config- or profile-selected `auto_review` reviewer would win on
        // every turn if only the thread-level pin were sent. Pinning it here is
        // idempotent rather than redundant, and `turn/steer` needs no pin because
        // it requires an already-active turn and creates none. Field verified
        // present on `TurnStartParams` at `codex-cli 0.149.1` (regenerated
        // 2026-08-27 — `docs/reference/provider-wire/codex.md`).
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
      },
      this.#turnStartTimeoutMs,
    );
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
        this.#forgetRunRoutes(record.sessionId);
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

  /** Interrupts the provider turn bound to a run. */
  async interruptRun(params: InterruptRunParams): Promise<void> {
    const { record, turnId } = this.#requireActiveTurn(params.runId);
    await record.connection.request("turn/interrupt", {
      threadId: record.threadId,
      turnId,
    });
    record.activeTurnIdByRunId.delete(params.runId);
    this.#sessionIdByRunId.delete(params.runId);
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
   */
  async rollbackTo(params: RollbackToParams): Promise<DriverRollbackResult> {
    const record = this.#requireSession(params.sessionId);
    if (record.activeTurnIdByRunId.size > 0) {
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
    const response = await record.connection.request("thread/fork", {
      threadId: record.threadId,
      lastTurnId: boundaryTurnId,
      // A fork mints a NEW thread, so it is a thread establishment and takes the
      // same re-realization rule a resume does: `ThreadForkParams` carries the
      // override members verbatim, and a fork that omitted them would leave the
      // rewound session governed by whatever the new thread inherited rather
      // than by the posture and caps its caller declared.
      ...this.#composeThreadEstablishmentLegs(record.executionPosture, record.subagentPolicy),
      approvalsReviewer: "user",
    });
    const forkedThread = readThread(response, "thread/fork");
    this.#assertPostureRealized(record.executionPosture, response);
    // Re-pointed only AFTER the fork is parsed. A failed or unreadable fork
    // leaves the session exactly where it was, which is what makes a retry safe.
    record.threadId = forkedThread.id;
    const forkedTurnIds = readThreadTurnIds(forkedThread.turns);
    if (forkedTurnIds.length > 0) {
      // The provider's own account of the forked history wins over the local
      // ordinal — it is the thread the session now runs on.
      record.turnBoundaries.splice(0, record.turnBoundaries.length, ...forkedTurnIds);
    } else {
      // Truncating to the requested position is what the INCLUSIVE boundary
      // means, so the ledger stays usable for the next rewind; the diagnostic is
      // what keeps the missing corroboration from passing as agreement.
      record.turnBoundaries.length = params.position;
      reportDiagnosticFromDetachedFrame(this.#options.reportDiagnostic, {
        kind: "fork-turn-ledger-unconfirmed",
        expectedTurnCount: params.position,
      });
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
      return;
    }
    await this.#claimSessionSlot(params.sessionId, "closing", async () => {
      await this.#tearDownSession(params.sessionId);
    });
    // The gate dies with the session it scoped, after teardown rather than
    // before it: a terminal provoked by the teardown itself must still find the
    // latch set.
    this.#terminalEmissionGates.delete(params.sessionId);
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
    const response = await record.connection.request("turn/steer", {
      threadId: record.threadId,
      input: [{ type: "text", text: request.content, text_elements: [] }],
      expectedTurnId: targetedTurnId,
      // P0-3: the REQUESTER's key, verbatim and never re-minted here — a fresh
      // value per retry is exactly what the daemon's `interventions` dedupe guard
      // exists to prevent. `clientUserMessageId` is the pinned home for a
      // caller-supplied message id, the same member `turn/start` above already
      // carries. Field verified present on `TurnSteerParams` in the default
      // generation of the installed `codex-cli 0.150.1` (regenerated 2026-08-28);
      // `docs/reference/provider-wire/codex.md` pins `0.149.1` and does not print
      // that params type, but records the member on the sibling `TurnStartParams`
      // as byte-identical back to the `0.141.0` floor, and directs consumers to
      // re-verify load-bearing shapes against the then-installed binary.
      clientUserMessageId: request.clientIdempotencyKey,
    });
    return { targetedTurnId, acknowledgedTurnId: readSteeredTurnId(response) };
  }

  /** True when the run has a live provider turn. */
  hasActiveTurn(runId: RunId): boolean {
    const sessionId = this.#sessionIdByRunId.get(runId);
    if (sessionId === undefined) {
      return false;
    }
    return this.#sessions.get(sessionId)?.activeTurnIdByRunId.has(runId) === true;
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
    const delegate = this.#options.onServerNotification;
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
        if (delegate === undefined) {
          // Same containment as the transport's own, and for the same reason:
          // this callback is invoked from inside `#ingest`, so a throwing sink
          // here unwinds the caller's read-chunk drain just as surely.
          reportDiagnosticFromDetachedFrame(reportDiagnostic, {
            kind: "unconsumed-server-notification",
            method,
          });
          return;
        }
        try {
          delegate(method, params);
        } catch (cause) {
          // A MODULE-BOUNDARY guard, kept deliberately even though the transport
          // contains this same fault one frame further out. The reason is
          // ownership rather than behaviour: this class should not depend on
          // another module's error handling to keep its own contract, and that
          // transport is slated to become swappable (T3.15 leg 6), at which point
          // the outer catch stops being guaranteed.
          //
          // Honest limit, recorded rather than left to be discovered: this guard
          // is NOT independently observable today. Delete the transport's
          // containment and a test fails; delete this one and none does, because
          // the outer catch reports an identical diagnostic (the manager's own
          // observation has already run by the time the delegate is called, so
          // nothing is skipped either way).
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
   * Codex serializes turns per thread, so at most one route is live at a time;
   * the first entry is therefore the answer rather than an arbitrary pick. A
   * `null` is returned rather than a fabricated id — see
   * {@link CodexSessionServerRequest}.
   */
  #activeRunIdFor(sessionId: SessionId): RunId | null {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      return null;
    }
    for (const runId of record.activeTurnIdByRunId.keys()) {
      return runId;
    }
    return null;
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
    // Keyed by TURN id, not by run id. A run whose route was superseded (by a
    // resume) or already retired (by an interrupt) must not have a NEWER turn
    // cleared out from under it by a late terminal for the old one.
    let matchedRoute = false;
    for (const [runId, activeTurnId] of record.activeTurnIdByRunId) {
      if (activeTurnId === turnId) {
        record.activeTurnIdByRunId.delete(runId);
        this.#sessionIdByRunId.delete(runId);
        matchedRoute = true;
      }
    }
    if (!matchedRoute) {
      rememberTerminatedTurn(record, turnId);
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

  #requireSession(sessionId: SessionId): CodexSessionRecord {
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
        `Codex session "${sessionId}" is being re-established; its connection is about to be replaced.`,
        { sessionId, holderState },
      );
    }
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      throw new CodexTransportError(`No live Codex session for "${sessionId}".`, { sessionId });
    }
    return record;
  }

  #requireActiveTurn(runId: RunId): { record: CodexSessionRecord; turnId: string } {
    const sessionId = this.#sessionIdByRunId.get(runId);
    const record = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
    const turnId = record?.activeTurnIdByRunId.get(runId);
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
