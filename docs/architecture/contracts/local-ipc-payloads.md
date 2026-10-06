# Local IPC Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-005-Partial — Local IPC Daemon Control

[Plan-005 Phase 3](../../plans/005-local-ipc-and-daemon-control.md) defines the JSON-RPC IPC surface served by the local runtime daemon to in-tree clients (CLI, desktop renderer). The subset of that surface built beside Plan-001's session-core types ([Plan-005 §Execution Windows (V1 Carve-Out)](../../plans/005-local-ipc-and-daemon-control.md#execution-windows-v1-carve-out)) is declared here: (1) the canonical method-name format that [Plan-005 §I-005-8](../../plans/005-local-ipc-and-daemon-control.md#i-005-8--method-names-conform-to-the-canonical-format-declared-in-api-payload-contractsmd) requires the registry to enforce mechanically at `register(method, ...)` call time and (2) the JSON-RPC handshake `protocolVersion` field type, an ISO 8601 `YYYY-MM-DD` date string with current value `"2026-05-01"` ([§JSON-RPC Handshake `protocolVersion` Field](#json-rpc-handshake-protocolversion-field) below). The rest of Plan-005's shapes are canonical elsewhere and not mirrored here: the `MethodRegistry` runtime shape in `packages/contracts/src/jsonrpc/registry.ts`; the `LocalSubscriptionProducer<T>` shape in `packages/contracts/src/jsonrpc/streaming.ts` (its client-side consumer `LocalSubscriptionConsumer<T>` lives in `packages/client-sdk/src/transport/subscription-consumer.ts`); and the JSON-RPC error envelope in [error-contracts.md §JSON-RPC Wire Mapping](./error-contracts.md#json-rpc-wire-mapping).

### JSON-RPC Method-Name Registry

**Canonical format**: `dotted-camelCase`. Method-name strings match the regex:

```
/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/
```

Every dot-delimited segment starts with a lowercase letter and may contain camelCase (`[a-z][a-zA-Z0-9]*`) — the first segment (the namespace root) included. This is the dotted-camelCase segment style of the LSP precedent ([Language Server Protocol §General Messages](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) — e.g. `workspace.executeCommand`, and camelCase-rooted names such as `textDocument.didOpen`) and the MCP precedent ([Model Context Protocol §Protocol Messages](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) — `tools.list`, `tools.call`), applied uniformly to every segment, the root included. A segment may carry an uppercase letter inside it but never start with one, in any position (`Session.create` fails), and a name has at least two segments. Most roots are one lowercase word (`session`, `daemon`, `run`, `repo`, `voice`); a camelCase root such as `providerAccount` or `callbackTool` passes the same rule. Each root's methods are documented in the section of the plan that owns them, and [§Operations Not Yet Built](./api-payload-contracts.md#operations-not-yet-built) lists every documented method no handler serves yet. The V1 `session.*` surface (`session.create`, `session.read`, `session.subscribe`) uses all-lowercase segments; nested-namespace operations like `run.subscribeState` and `driver.listCapabilities` (lowercase root + camelCase tail) are permitted under this regex, as is a camelCase root such as `providerAccount.list`.

The regex accepts the registered surface and rejects:

- `session/create` — slash-style (visually conflated with HTTP path segments; ambiguous in JSON-RPC contexts where method names appear in the JSON `method` field, not URLs).
- `SessionCreate` — PascalCase (collides with the project's TypeScript type-name convention; `Session.create` is rejected on the same ground — the root widening admits an uppercase letter _inside_ a segment, never at its start; `SessionCreate` is already a request-payload type symbol per `packages/contracts/src/session/methods.ts`, so a string-form would be ambiguous at every call site).
- `sessionCreate` — bare camelCase without a namespace dot (cannot express the namespace/operation split without a convention-internal delimiter; doesn't scale to nested namespaces).

**Method-name table** (Plan-005 Phase 3 surface):

| Method | Procedure type | Notes |
| --- | --- | --- |
| `session.create` | RPC (request/response) | Materialize new session row + emit `SessionCreated`. |
| `session.read` | RPC (request/response) | Resolve session by id. |
| `session.subscribe` | Long-lived (`SessionSubscribeResponse`, then `SessionStreamFrame` notifications) | Event stream that catches up, then follows. |

**Cross-transport consistency**: This same `dotted-camelCase` format is used by Plan-025's tRPC HTTP procedures (per remote-control-payloads.md §Plan-025 — Remote Control Bootstrap). Both transport surfaces share the convention so that client SDK call-site shape is symmetric across local IPC and remote control-plane calls.

**Register-time enforcement** ([Plan-005 §I-005-8](../../plans/005-local-ipc-and-daemon-control.md#i-005-8--method-names-conform-to-the-canonical-format-declared-in-api-payload-contractsmd)): the method registry's `register(method, handler)` call MUST evaluate `method` against this regex and throw on mismatch. This is mechanical validation, not human review — out-of-format names cannot reach the dispatcher.

```ts
const METHOD_NAME_FORMAT = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

function register(method: string, handler: Handler): void {
  if (!METHOD_NAME_FORMAT.test(method)) {
    throw new Error(`method name "${method}" violates dotted-camelCase canonical format`);
  }
  // ... registry insertion
}
```

The runtime regex check is owed by the Plan-005 substrate at `packages/runtime-daemon/src/ipc/registry.ts#isCanonicalMethodName` (the `register()`-time guard), which imports the canonical regex as the `METHOD_NAME_FORMAT` constant exported from `packages/contracts/src/jsonrpc/registry.ts` (the single source — no per-package re-declaration); the `MethodRegistry` interface itself is likewise canonical in code there per the api-payload-contracts.md §Source-of-Truth Policy.

### JSON-RPC Handshake `protocolVersion` Field

The field is carried across the [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) JSON-RPC handshake substrate (`packages/contracts/src/jsonrpc/message.ts`, `packages/contracts/src/jsonrpc/negotiation.ts`, `packages/runtime-daemon/src/ipc/protocol-negotiation.ts`, and the client-SDK transport surface).

**Canonical format**: ISO 8601 date-string in `YYYY-MM-DD` form. The substrate Zod schema at `packages/contracts/src/jsonrpc/negotiation.ts#ProtocolVersionSchema` MUST be:

```ts
const ProtocolVersionSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
```

**Current value**: `"2026-05-01"` — the date string is the V1 protocol version. The supported set is one list, `SUPPORTED_PROTOCOL_VERSIONS` in `packages/contracts/src/jsonrpc/negotiation.ts`: the daemon accepts exactly it and a client offers exactly it in `daemon.hello`. It is `["2026-05-01"]` for V1; a later revision advances the date and appends it, keeping the version before it, so an app and a service one release apart agree.

**Ordering convention**: ISO 8601 date-strings are lexicographically equivalent to chronologically ordered. The `negotiateProtocol` algorithm uses string-sort() (`[...].sort.at(-1)!`) for max-version selection, with no separate semver parser. Floor / ceiling discrimination uses the same lex order against the daemon's supported set.

**Rationale**: This project is an AI-agent IPC running `claude-driver` and `codex-driver` provider processes; the [Model Context Protocol (MCP) §Architecture overview](https://modelcontextprotocol.io/docs/learn/architecture) is the closest analog, and MCP uses date-string `protocolVersion` (e.g. `"2025-06-18"`) for the same handshake semantics. Date-strings encode release date inherently, dodge the semver "v1.5 with no v1.4" ambiguity, and are immediately readable in logs and error reports without a parser.

**Distinction from `EventEnvelopeVersion`**: `protocolVersion` is the JSON-RPC handshake field on every request — it identifies the wire-protocol revision the client and daemon speak. `EventEnvelopeVersion` (per [ADR-017](../../decisions/017-cross-version-compatibility.md), defined in session-event-payloads.md §Plan-004 — Session Event Taxonomy) is a semver `MAJOR.MINOR` brand on event envelopes — it identifies the event-data schema revision. The two surfaces are independent and evolve on independent cadences, and neither stands in for the other.

### JSON-RPC Request `id` Bound

**Canonical bound**: a request `id` may not exceed `JSON_RPC_ID_MAX_BYTES` (256) bytes once JSON-encoded. The constant is declared at `packages/contracts/src/jsonrpc/message.ts` beside the frame's message-size limit and re-exported unchanged by `packages/runtime-daemon/src/ipc/local-gateway.ts`, which enforces it.

**Where it is enforced**: at the **request** boundary, before dispatch — an over-bound id refuses as `-32600 Invalid Request` with `data.type: "invalid_envelope"`, and that refusal carries `id: null` rather than echoing the offending value. Enforcement is two-sited and both sites are required: the envelope's id gate refuses the request, and the gateway's id-extraction helper — through which the `jsonrpc` and `method` gates build their error frames, and which answers _before_ the id gate — falls back to a null id, without which the one frame guaranteed to be small would be the one carrying the oversized echo.

**Why a request-side bound rather than a response-side subtraction**: JSON-RPC requires a response to echo the request's `id`, so the id is the one response member a response schema does not choose. A reply is bounded by the substrate's absolute message-size limit ([Spec-006 §Wire Format](../../specs/006-local-ipc-and-daemon-control.md#wire-format)), and an oversized reply cannot carry its own error — the send path drops the connection instead. Without this bound, a 900 KB id inside an otherwise-valid request makes every reply to it unencodable and the session unrecoverable from contract-valid data alone.

**Why the encoded form**: measuring the JSON encoding rather than the JavaScript string length covers escaping (a control character encodes to six ASCII bytes) and lets one rule read identically for the string, number, and null id forms the envelope admits.

**Consumers**: any page builder sizing a reply against the frame it will become subtracts a framing reserve that includes this bound — see [Plan-010](../../plans/010-transcript-and-reasoning.md) T1.5 and its `TRANSCRIPT_PAGE_FRAME_RESERVE_BYTES` derivation. The reserve is therefore derived from an enforced rule rather than an assumed allowance.

## Plan-005 — Local IPC And Daemon Control

```ts
// JSON-RPC 2.0 method shapes

// DaemonHello — `DaemonHello` and `DaemonHelloAck` in `packages/contracts/src/jsonrpc/negotiation.ts`.
// A protocol version is a `YYYY-MM-DD` date; each list holds at most 32 entries, and each free-form
// string is 1 to 256 characters.
interface DaemonHello {
  protocolVersion: string; // the client's preferred version
  supportedProtocols?: string[]; // at least one; defaults to `[protocolVersion]`
  clientId?: string;
  // The daemon session token, read from its file at this connect. Optional in the shape so the
  // daemon answers its absence with `auth.token_invalid`, as it does a wrong one; nothing more is
  // served on a connection whose hello lacks the right token.
  sessionToken?: string;
  capabilities?: string[];
}
interface DaemonHelloAck {
  compatible: boolean; // false leaves the connection to read-only calls
  protocolVersion: string; // the negotiated version; when incompatible, the daemon's preferred one
  reason?:
    | "version.floor_exceeded"
    | "version.ceiling_exceeded"
    | "protocol.handshake_already_completed"; // only when incompatible
  serverCapabilities?: string[];
  daemonSupportedProtocols?: string[]; // on an incompatible first handshake, so the client can pick a version to retry with
  // The connecting device's own id (for a local connection, the service's own device id): the one a
  // terminal lease names as its holder (`holderDeviceId` on `pty.control_changed`), so a client tells
  // this device holding a shell apart from another device holding it, and, by `holderRunId`, from an
  // agent's run holding it. Lands with Plan-005 Phase 2B (T-005p-2B-1).
  deviceId: DeviceId;
}

// DaemonStatusRead
// A process as the system knows it (`packages/contracts/src/process-identity.ts`).
interface ProcessIdentity {
  processId: number; // the operating-system process id
  bootId: string; // the id of the boot it runs in: Linux's boot id, macOS's boot session id
  processStartTime: string; // the system's own record of its start, compared only for equality
}
interface DaemonStatusReadParams {}
interface DaemonStatusReadResult {
  processState: "running" | "starting" | "stopping" | "degraded";
  // The service's own process as the system knows it, by which a client that found it running ends it
  // and never a process that took over its id.
  processIdentity: ProcessIdentity;
  protocolVersion: string;
  transportEndpoint: string;
  // The service's own facts for Settings › Runtime and `sidekicks daemon status`. Processor and
  // memory are read only when this is called — the page opening, `Check again` — never on a timer,
  // each stamped with the time it was read, so every reply carries both. They count the service's
  // own processes and nothing else: the daemon and every process it started (on a Windows computer
  // whose service runs in WSL, read inside the distribution, plus the service's Windows half and its
  // `wsl.exe`; the WSL virtual machine is not counted).
  version: string;
  startedAt: string; // ISO 8601
  uptimeMs: number; // how long the service has run, as of this reply
  processor: { percent: number; readAt: string } | null; // percent of the whole machine, 0 to 100; null when the reading failed at this call
  memory: { residentBytes: number; readAt: string } | null; // null when the reading failed at this call
  // The data directory this daemon holds. A second daemon cannot hold it, which is why the sign-in and
  // sign-out verbs refuse while this one is up and name what to stop — so the status read has to say
  // which directory is held, not merely that something is.
  dataDirectory: string;
  // The path of the file the daemon keeps its secrets in, mode 0600, present ONLY on Linux where no
  // Secret Service answers and on a Mac while its secrets are in `secrets.json`: from the time the
  // approved service that runs while the person is logged out takes over until `sidekicks daemon
  // uninstall` moves them back, including after that service is turned off in Login Items &
  // Extensions, and never while it waits for approval. Settings › Runtime then shows `Secrets are
  // kept unencrypted in <path>, readable by this account alone, because no Secret Service is
  // running.`, or on that Mac the same line ending `because the service runs while you are logged
  // out.` Absent on every other machine.
  secretsFile?: string;
  recovery: DaemonRecoveryStatus; // healthy, rebuilding, degraded or blocked, per session (persistence-payloads.md §Plan-012, T12.4)
  // The relay block, present ONLY while a relay is configured — absent otherwise, never an empty block
  // and never a disabled one, in the text output and the machine-readable output alike. Its fields are
  // Remote Control's own relay wire; nothing here is a second reading of it.
  relay?: {
    devices: Array<{
      name: string;
      connected: boolean;
      // Ages rather than timestamps, because the figure a person reads is how long ago; absent means no
      // frame has gone that way at all, which is a different fact from a frame long ago.
      lastFrameOutAgeMs?: number;
      lastFrameInAgeMs?: number;
      reconnectCount: number;
      // Counts each frame the relay refuses as malformed or unauthenticated; there is no per-device quota.
      rejectedFrameCount: number;
    }>;
    // The pinned relay presented a key other than the one pinned when it was linked
    // (`relay.pin_refused` in session-event-payloads.md).
    pinRefused: boolean;
  };
}

// DaemonStop / DaemonRestart (no DaemonStart: a service that is not running answers no method, so starting it is never an IPC method. The command line starts it with `sidekicks daemon start` (Plan-005 T-005r-3-4); the desktop app's main process starts it through the preload bridge's `daemon.requestStart()`, and quitting the app leaves the service and every run running)
// Separate per-method schemas (no shared `action` discriminator). Stop and restart take no
// parameters. A stop or restart is: flush pending writes, ask, wait up to the service's drain
// bound (DAEMON_STOP_DRAIN_BOUND_MS) for it to exit, and only if it still runs SIGTERM, then
// SIGKILL 2 s later, from the app and from `sidekicks daemon stop` and `restart` alike. A
// confirmed stop or restart wins: another connected client never refuses it, so both results are
// the uniform { accepted: true }.
interface DaemonStopParams {}
interface DaemonStopResult {
  accepted: true;
}
interface DaemonRestartParams {}
interface DaemonRestartResult {
  accepted: true;
}

// DaemonFlush — `daemon.flush`, sent before a quit: every write pending when it arrives is made
// durable. It never stops the service, and every run and shell keeps running.
interface DaemonFlushParams {}
interface DaemonFlushResult {
  flushed: true;
}

// DaemonPing — `daemon.ping`, main's liveness check on its link to the service. Main sends it only
// after 5 s with no frame from the service, so a busy link carries none; after 20 s with no frame
// main counts the link as dead, shows it on the connection state and restarts the service with its
// backoff. The answer is the evidence of life, so it carries nothing.
interface DaemonPingParams {}
interface DaemonPingResult {}

// DaemonConfigRead / DaemonConfigUpdate — `daemon.configRead` / `daemon.configUpdate`, the
// machine-wide service settings Settings › Runtime edits, one configuration surface (Spec-006).
// Separate from the per-session `session.maxStepsUpdate`, `session.spendLimitUpdate` and
// `session.tokensPerRunUpdate`.
interface DaemonConfigReadParams {}
interface DaemonConfig {
  workflowListenerPort: number; // a taken port is saved, not refused; `workflow.webhookListenerRead` says whether it listens
  runTimeLimitMinutes: 30 | 60 | 240 | 720 | 1440 | null; // `Stop a run after`; null is `No limit`
  workflowChainAskAfterRuns: 25 | 100 | 500 | 2000 | null; // `Ask me after one start leads to`: 25, 100 (the default), 500 or 2,000 runs; null is `Never ask`
  maxStepsPerTurn: number | null; // null is `Unlimited`: each provider does what it does on its own
  spendLimitUsdMicros: number | null; // `Spend limit`, what each new session starts from; null is `Unlimited`
  tokensPerRun: number | null; // `Tokens per run`, what each new session starts from; null is `Unlimited`
  toolMemoryCapBytes: number | null;
  toolMemoryCapEnforceable: boolean;
  packageCacheLimitBytes: number | null; // the package caches' `Cache limit`; null is `Unlimited`, and then the service never clears a cache on its own. With a size set, after each successful install the service reads that tool's cache and clears it when it is larger, leaving the other tool's cache alone
  recordTraces: boolean;
  recordProviderMessages: boolean;
  providerMessagesPath: string; // the folder raw provider messages are written to, which the page names
}
type DaemonConfigReadResult = DaemonConfig;
// Exactly one member per press, never none and never two, like `providerAccount.update`; the two
// facts the page draws beside the settings, `toolMemoryCapEnforceable` and `providerMessagesPath`, are not
// settable. The reply is the whole configuration after the change. A value that is not a port or
// not a size is refused, and nothing changes.
type DaemonConfigUpdateParams = Partial<
  Omit<DaemonConfig, "toolMemoryCapEnforceable" | "providerMessagesPath">
>;
type DaemonConfigUpdateResult = DaemonConfig;

// DaemonPackageCacheRead — `daemon.packageCacheRead`, what each workflow package cache holds: one
// walk of each cache folder, taken only when called (the page opening, `Check again`) and, under a
// custom `Cache limit`, after an install; nothing samples it on a timer. The page adds the total.
interface DaemonPackageCacheReadParams {}
interface DaemonPackageCacheReadResult {
  bun: { bytes: number; readAt: string };
  uv: { bytes: number; readAt: string };
}
// DaemonPackageCacheClear — `daemon.packageCacheClear`: `uv`'s cache through `uv cache clean`, bun's
// by removing its folder; never a step's code folder or the Python the service manages, so a step
// already installed keeps working. A clear waits for the installs using that cache and an install
// waits for a clear; the reply is the new reading.
interface DaemonPackageCacheClearParams {
  cache: "bun" | "uv" | "all";
}
type DaemonPackageCacheClearResult = DaemonPackageCacheReadResult;

// SessionTerminalProviderSessionList — `session.terminalProviderSessionList`: the provider sessions a
// person typed in a terminal that are inside a provider's shared service, each working, idle or not
// reachable, with `provider` as data, read off
// the same directory entries the agents' session listing names, so Runtime and the agents read one
// fact. `Stop`'s confirm counts them and the service update's waiting step counts the working ones;
// read when a confirm opens and while an update waits, never on a timer. Empty while `Reach Codex
// sessions started in a terminal` is off.
interface SessionTerminalProviderSessionListParams {}
interface TerminalProviderSession {
  provider: ProviderName;
  name: string;
  threadId: string;
  state: "working" | "idle" | "unreachable";
}
interface SessionTerminalProviderSessionListResult {
  sessions: TerminalProviderSession[];
}

// LocalSubscription
interface LocalSubscriptionParams {
  sessionId: SessionId;
  afterCursor?: EventCursor;
  categories?: EventCategory[]; // filter to specific categories
}
// Response: a JSON-RPC notification stream of LocalSubscriptionFrame on the already-registered
// $/subscription/notify method — one frame per batch, never one frame per event.

// The batched subscription frame (Plan-005 Phase 2D). The producer coalesces what it is
// handed into one frame per 16 ms or 50 events, whichever comes first, and the window opens on the
// FIRST event rather than the last: a throttle, not a debounce, so a lone event is never held for a
// whole window while a burst still collapses into one delivery.
interface LocalSubscriptionFrame {
  // Changes only, never the whole record, and every change carries its own cursor — which is what
  // lets a consumer say where it got to without the producer keeping a position per consumer.
  changes: Array<{ cursor: EventCursor; value: EventEnvelope }>;
  // Present on the first frame that fits after the producer dropped for this consumer, and on that
  // frame alone — never left standing on every frame after it, which would make one gap and a
  // continuing one indistinguishable. The producer never waits for a consumer, so a consumer that
  // falls behind is dropped for; a drop it is not told about is the single failure this member
  // exists to make impossible. Seeing it, the consumer repairs against the daemon's own record by
  // cursor through `afterCursor` above, and past the point that record can still fill it takes a
  // snapshot read from beyond the gap instead of a fill. So what a consumer holds is either
  // complete or visibly short, never silently short, and the record rather than the screen is the
  // truth.
  gap?: true;
}
```

The frame above is defined here because it is a cross-cutting wire primitive, the class api-payload-contracts.md §Source-of-Truth Policy keeps in this file; the producer that emits it, `LocalSubscriptionProducer<T>`, stays canonical in code at `packages/contracts/src/jsonrpc/streaming.ts` under that same policy, and the Zod schema there governs on any divergence. Nothing is minted for the batching: the frame rides the registered `$/subscription/notify` method, the repair is the `afterCursor` read this surface already takes, and no method name, error code, or setting is added. Producer side: [Plan-005 §Phase 2D](../../plans/005-local-ipc-and-daemon-control.md#phase-2d--substrate-supplement-the-subscription-frame-is-batched-carries-changes-only-and-never-waits-for-a-consumer). Consumer side: [Plan-020](../../plans/020-desktop-app-and-renderer.md)'s transcript frame, which repairs by snapshot on the `gap` flag.
