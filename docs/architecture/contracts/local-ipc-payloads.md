# Local IPC Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-005-Partial — Local IPC Daemon Control

[Plan-005 Phase 3](../../plans/005-local-ipc-and-daemon-control.md) defines the JSON-RPC IPC surface served by the local runtime daemon to in-tree clients (CLI, desktop renderer). The subset of that surface built beside Plan-001's session-core types ([Plan-005 §Execution Windows (V1 Carve-Out)](../../plans/005-local-ipc-and-daemon-control.md#execution-windows-v1-carve-out)) is declared here: (1) the wire-name grammar every request, event and error code follows ([§Wire-Name Grammar](#wire-name-grammar) below), which [Plan-005 §I-005-8](../../plans/005-local-ipc-and-daemon-control.md#i-005-8--method-names-follow-the-wire-name-grammar) requires to be checked mechanically, and (2) the JSON-RPC handshake `protocolVersion` field type, an ISO 8601 `YYYY-MM-DD` date string with current value `"2026-05-01"` ([§JSON-RPC Handshake `protocolVersion` Field](#json-rpc-handshake-protocolversion-field) below). The rest of Plan-005's shapes are canonical elsewhere and not mirrored here: the method table, each method declared once with `methods!` (`crates/sidekicks-contracts/src/method.rs`) in the contract module that owns it; the subscription frames (`SubscribeAcknowledgmentResponse`, `SubscriptionNotifyParams<T>`, `SubscriptionEndParams`, `SubscriptionCancelRequest`) in `crates/sidekicks-contracts/src/jsonrpc/streaming.rs` (the daemon's lane that sends them is `crates/sidekicks-daemon/src/ipc/stream/subscriptions.rs`; the client-side `Subscription<T>` lives in `crates/sidekicks-client/src/transport/subscription.rs`); and the JSON-RPC error envelope in [error-contracts.md §JSON-RPC Wire Mapping](./error-contracts.md#json-rpc-wire-mapping).

### Wire-Name Grammar

One grammar names every request, event and error code on the app's own wire, `domain[.resource].action|occurrence|condition`:

- **A request** is `domain[.resource].action`: `session.create`, `session.hook.list`, `agent.run.create`.
- **An event** is `domain[.resource].occurrence`, a participle: past when done (`agent.run.completed`), present while under way and closed by a past-tense event (`agent.run.pausing`, then `agent.run.paused`). What kind of event it is (lifecycle, transcript record, telemetry, provider notice) is its registry category, never a word in its name.
- **An error code** is `domain[.resource].condition`: `session.notFound`, `terminal.control.heldByOther`. Each code is specific and carries one category ([Error Contracts §Categories](./error-contracts.md#categories)); a finer cause rides in `data.fields.reason`.
- **Every segment is lowerCamelCase**, `[a-z][a-zA-Z0-9]*`, joined by dots, two to four segments, the action, occurrence or condition last. A value the app itself defines (an enum value, a reason) is lowerCamelCase too; a value a provider or an outside standard sends stays as sent.
- **One word per concept,** singular, the glossary's or the screen's word: `terminal` not `pty`, `machine` not `runtimenode`, `provider` not `driver`, `git` not `gitflow`, `queueItem`, `repoMount`.
- **Fixed verbs** replace their synonyms; every other verb is the domain's own (`archive`, `fork`, `steer`, `install`, `generate`):

| Verb | Means |
| --- | --- |
| `read` | One thing, once |
| `list` | A collection, once |
| `subscribe` | A live feed, never called list or read |
| `create` | Make a new thing |
| `update` | Change a stored thing or one of its values |
| `delete` | Destroy a record that has its own id, or a stored value |
| `add` / `remove` | Put a member into a list or take it out; the member lives on |
| `purge` | Delete many by a rule |
| `clear` | Empty a value or a collection; the owner stays |
| `start` / `stop` / `cancel` / `interrupt` | Jobs, processes, unfinished work, the provider's current turn |

Protocol methods keep the slash form of the Language Server Protocol, `$/` and slash-joined segments (`$/cancelRequest`, `$/subscription/notify`, `$/subscription/cancel`, `$/subscription/end`), and no name starts `rpc.`, which JSON-RPC 2.0 reserves. The [Language Server Protocol](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) (`textDocument/didOpen`, `workspace/executeCommand`) and the [Model Context Protocol](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) (`tools/list`, `tools/call`) join every method's segments with slashes; this wire keeps slashes for its protocol methods alone, so an app name never reads as one, and joins its own names with dots, as [WebDriver BiDi](https://w3c.github.io/webdriver-bidi/) does (`browsingContext.navigate`), in lowerCamelCase segments as the Language Server Protocol and WebDriver BiDi spell theirs; the Model Context Protocol mixes in snake_case (`notifications/tools/list_changed`).

The grammar rejects:

- `session/create`: the slash form belongs to protocol methods.
- `SessionCreate` and `Session.create`: PascalCase is the type names' form, and `SessionCreate` is already the method descriptor in `crates/sidekicks-contracts/src/session/directory.rs`.
- `sessionCreate`: one segment names no domain.
- `session.not_found`: an underscore is no part of a segment.

**The build-time check.** One `const fn is_wire_name` in `crates/sidekicks-contracts`, beside the wire types, holds the grammar, with `is_protocol_method_name` for the `$/` form. Each name the contracts declare is asserted against it at build time where it is declared: in `methods!`, `refusal_codes!` and `session_event_types!`, and beside the two hand-built descriptors, `DaemonHandshake` and `SubscriptionCancel`. A name off the grammar fails the build (`not a wire name: Session.create`), so no name off it reaches the dispatcher, the event registry or the refusal table, and the method registry checks only that no name is registered twice. The assertion reads only the contract's own declared names and parses no source.

### JSON-RPC Method-Name Registry

**Method-name table** (Plan-005 Phase 3 surface; procedure types per [API Payload Contracts §Procedure Types](./api-payload-contracts.md#procedure-types)):

| Method | Procedure type | Notes |
| --- | --- | --- |
| `session.create` | `mutation` | Materialize new session row + emit `session.created`. |
| `session.read` | `query` | Resolve session by id. |
| `session.event.subscribe` | `subscription` (`SubscribeAckResponse`, then `SessionStreamFrame` notifications) | Event stream that catches up, then follows. |

Each domain's methods are documented in the section of the plan that owns them, and [§Operations Not Yet Built](./api-payload-contracts.md#operations-not-yet-built) lists every documented method no handler serves yet.

**Cross-transport consistency**: the control plane's HTTP procedures ([Remote Control Payload Contracts §Plan-025 — Remote Control Bootstrap](./remote-control-payloads.md#plan-025--remote-control-bootstrap-control-plane-http-routes)) take their names from the same grammar, so a client's call sites read alike over local IPC and the control plane.

### JSON-RPC Handshake `protocolVersion` Field

The field is carried across the [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) JSON-RPC handshake substrate (`crates/sidekicks-contracts/src/jsonrpc/message.rs`, `crates/sidekicks-contracts/src/jsonrpc/negotiation.rs`, `crates/sidekicks-daemon/src/ipc/protocol_negotiation.rs`, and `crates/sidekicks-client`'s transport).

**Canonical format**: ISO 8601 date-string in `YYYY-MM-DD` form. The substrate's `ProtocolVersion` text newtype in `crates/sidekicks-contracts/src/jsonrpc/negotiation.rs` MUST carry, as its garde pattern and its JSON Schema pattern, the pattern:

```text
^[0-9]{4}-[0-9]{2}-[0-9]{2}$
```

**Current value**: `"2026-05-01"` — the date string is the V1 protocol version. The supported set is one list, `SUPPORTED_PROTOCOL_VERSIONS` in `crates/sidekicks-contracts/src/jsonrpc/negotiation.rs`, written into the generated `packages/contracts/src/jsonrpc/negotiation.ts`: the daemon accepts exactly it and a client offers exactly it in `connection.initialize`. It is `["2026-05-01"]` for V1; a later revision advances the date and appends it, keeping the version before it, so an app and a service one release apart agree.

**Ordering convention**: ISO 8601 date-strings are lexicographically equivalent to chronologically ordered. The protocol negotiation picks the greatest version by plain string order, with no separate semver parser. Floor / ceiling discrimination uses the same lex order against the daemon's supported set.

**Rationale**: This project is an AI-agent IPC running `claude-driver` and `codex-driver` provider processes; the [Model Context Protocol (MCP) §Architecture overview](https://modelcontextprotocol.io/docs/learn/architecture) is the closest analog, and MCP uses date-string `protocolVersion` (e.g. `"2025-06-18"`) for the same handshake semantics. Date-strings encode release date inherently, dodge the semver "v1.5 with no v1.4" ambiguity, and are immediately readable in logs and error reports without a parser.

**Distinction from `EventEnvelopeVersion`**: `protocolVersion` is the JSON-RPC handshake field on every request — it identifies the wire-protocol revision the client and daemon speak. `EventEnvelopeVersion` (per [ADR-017](../../decisions/017-cross-version-compatibility.md), defined in session-event-payloads.md §Plan-004 — Session Event Taxonomy) is a semver `MAJOR.MINOR` brand on event envelopes — it identifies the event-data schema revision. The two surfaces are independent and evolve on independent cadences, and neither stands in for the other.

### JSON-RPC Request `id` Bound

**Canonical bound**: a request `id` may not exceed `JSON_RPC_ID_MAX_BYTES` (256) bytes once JSON-encoded. The constant is declared at `crates/sidekicks-contracts/src/jsonrpc/message.rs` beside the frame's message-size limit and used unchanged by the daemon's gateway, `crates/sidekicks-daemon/src/ipc/local_gateway.rs`, which enforces it.

**Where it is enforced**: at the **request** boundary, before dispatch — an over-bound id refuses as `-32600 Invalid Request` with `data.type: "request.envelopeInvalid"`, and that refusal carries `id: null` rather than echoing the offending value. Enforcement is two-sited and both sites are required: the envelope's id gate refuses the request, and the gateway's id-extraction helper — through which the `jsonrpc` and `method` gates build their error frames, and which answers _before_ the id gate — falls back to a null id, without which the one frame guaranteed to be small would be the one carrying the oversized echo.

**Why a request-side bound rather than a response-side subtraction**: JSON-RPC requires a response to echo the request's `id`, so the id is the one response member a response schema does not choose. A reply is bounded by the substrate's absolute message-size limit ([Spec-006 §Wire Format](../../specs/006-local-ipc-and-daemon-control.md#wire-format)), and an oversized reply cannot carry its own error — the send path drops the connection instead. Without this bound, a 900 KB id inside an otherwise-valid request makes every reply to it unencodable and the session unrecoverable from contract-valid data alone.

**Why the encoded form**: measuring the JSON encoding rather than the JavaScript string length covers escaping (a control character encodes to six ASCII bytes) and lets one rule read identically for the string, number, and null id forms the envelope admits.

**Consumers**: any page builder sizing a reply against the frame it will become subtracts a framing reserve that includes this bound — see [Plan-010](../../plans/010-transcript-and-reasoning.md) T1.5 and its `TRANSCRIPT_PAGE_FRAME_RESERVE_BYTES` derivation. The reserve is therefore derived from an enforced rule rather than an assumed allowance.

## Plan-005 — Local IPC And Daemon Control

```ts
// JSON-RPC 2.0 method shapes

// connection.initialize — `ConnectionInitializeRequest` and `ConnectionInitializeResponse` in
// `crates/sidekicks-contracts/src/jsonrpc/negotiation.rs`. A protocol version is a `YYYY-MM-DD`
// date; each list holds at most 32 entries, and each free-form string is 1 to 256 characters.
interface ConnectionInitializeRequest {
  protocolVersion: string; // the client's preferred version
  supportedProtocols?: string[]; // at least one; defaults to `[protocolVersion]`
  clientId?: string;
  // The daemon session token, read from its file at this connect. Absent from the packaged
  // desktop's client helper on macOS, which the daemon admits by its code signature; from any
  // other caller its absence is answered `auth.token.invalid`, as a wrong one is, and nothing more
  // is served on that connection. A process the daemon or a provider service it reaches started,
  // or one the system could not name or trace, is answered `auth.callerRefused` whatever token it
  // sends, with the same latch.
  sessionToken?: string;
  capabilities?: string[];
}
interface ConnectionInitializeResponse {
  compatible: boolean; // false leaves the connection to read-only calls
  protocolVersion: string; // the negotiated version; when incompatible, the daemon's preferred one
  reason?:
    | "connection.version.floorExceeded"
    | "connection.version.ceilingExceeded"
    | "connection.handshake.alreadyCompleted"; // only when incompatible
  serverCapabilities?: string[];
  // on an incompatible first handshake, so the client can pick a version to retry with
  daemonSupportedProtocols?: string[];
  // The connecting device's own id (for a local connection, the service's own device id): the one a
  // terminal lease names as its holder (`holderDeviceId` on `terminal.control.changed`), so a
  // client tells this device holding a shell apart from another device holding it, and, by
  // `holderRunId`, from an agent's run holding it. Lands with Plan-005 Phase 2B (T-005p-2B-1).
  deviceId: DeviceId;
}

// `daemon.status.read` takes `EmptyPayload`.
// A process as the system knows it (`crates/sidekicks-contracts/src/process_identity.rs`).
interface ProcessIdentity {
  processId: number; // the operating-system process id
  bootId: string; // the id of the boot it runs in: Linux's boot id, macOS's boot session id
  processStartTime: string; // the system's own record of its start, compared only for equality
}
interface DaemonStatusReadResponse {
  processState: "running" | "starting" | "stopping" | "degraded";
  // The service's own process as the system knows it, by which a client that found it running ends
  // it and never a process that took over its id.
  processIdentity: ProcessIdentity;
  protocolVersion: string;
  transportEndpoint: string;
  // The service's own facts for Settings › Runtime and `sidekicks daemon status`. Processor and
  // memory are read only when this is called — the page opening, `Check again` — never on a timer,
  // each stamped with the time it was read, so every reply carries both. They count the service's
  // own processes and nothing else: the daemon and every process it started, and on Windows, for
  // each running WSL server, its `wsl.exe` and its process tree read inside the distribution; the
  // WSL virtual machine is not counted.
  version: string;
  startedAt: string; // ISO 8601
  uptimeMs: number; // how long the service has run, as of this reply
  // percent of the whole machine, 0 to 100; null when the reading failed at this call
  processor: { percent: number; readAt: string } | null;
  // null when the reading failed at this call
  memory: { residentBytes: number; readAt: string } | null;
  // The data directory this daemon holds, through an exclusive `File::try_lock` on its
  // `daemon.lock` taken at start. A second daemon cannot hold it, so the status read says which
  // directory is held, not merely that something is.
  dataDirectory: string;
  // The file the daemon keeps its secrets in, mode 0600, present ONLY on Linux while the file
  // holds an item or cannot be opened, and on a Mac while its secrets are in `secrets.json`: from
  // the approved logged-out service's takeover until `sidekicks daemon uninstall` moves them back,
  // including after that service is turned off in Login Items & Extensions, and never while it
  // waits for approval. Settings › Runtime then shows the notice for the file's place, or why the
  // sealed file cannot be opened, with `path` in its own row under the notice's line (Spec-020
  // §Daemon Secrets). Absent on every other machine.
  secretsFile?: {
    path: string;
    // For a sealed file, the weakest key any item is sealed with.
    protection: "sealedWithChip" | "sealedWithSystemKey" | "plain";
    // Why a plain file on Linux is plain: systemd's credential service is absent, it refused to
    // seal at the first start, or it would bind each seal to the Secure Boot state. Absent for a
    // sealed file and on a Mac.
    reason?: "noSealService" | "sealFailed" | "bootBound";
    // Why the sealed file cannot be opened: the service is gone, it does not answer, the chip
    // cannot be used, or the key changed. Absent while it opens and for a plain file.
    cannotOpen?: "sealServiceMissing" | "sealServiceFailing" | "chipUnavailable" | "keyChanged";
  };
  // healthy, rebuilding, degraded or blocked, per session (persistence-payloads.md §Plan-012,
  // T12.4)
  recovery: DaemonRecoveryStatus;
  // The WSL block, present ONLY on a Windows computer with a WSL server running or a session in a
  // WSL 2 distribution, one entry per such distribution; `sidekicks daemon status` prints one line
  // each: `Ubuntu: running · 3 sessions`, `Debian: stopped · 1 session`,
  // `Arch: not answering since 2:14 PM`.
  wsl?: Array<{
    distro: string; // as `wsl -l` prints it
    // Where it stands, a union tagged by `state`; `since` is when WSL stopped answering (ISO 8601).
    status: { state: "running" } | { state: "stopped" } | { state: "notAnswering"; since: string };
    sessionCount: number;
  }>;
  // The relay block, present ONLY while a relay is configured — absent otherwise, never an empty
  // block and never a disabled one, in the text output and the machine-readable output alike. Its
  // fields are Remote Control's own relay wire; nothing here is a second reading of it.
  relay?: {
    devices: Array<{
      name: string;
      connected: boolean;
      // The carrier of this device's channel: the text output prints `direct (local network)`,
      // `direct (internet)` or `relay`, and the machine-readable output carries the value as sent.
      // Absent while the device holds no channel to this machine.
      path?: "directLocalNetwork" | "directInternet" | "relay";
      // Ages rather than timestamps, because the figure a person reads is how long ago; absent
      // means no frame has gone that way at all, which is a different fact from a frame long ago.
      lastFrameOutAgeMs?: number;
      lastFrameInAgeMs?: number;
      reconnectCount: number;
      // Counts each channel frame that failed decryption (`channel.decryptionFailed`), on either
      // carrier; there is no per-device quota.
      rejectedFrameCount: number;
    }>;
    // The pinned relay presented a key other than the one pinned when it was linked
    // (`relay.pin.refused` in session-event-payloads.md).
    pinRefused: boolean;
  };
}

// `daemon.stop` / `daemon.restart` (no `daemon.start`: a service that is not running answers no
// method, so starting it is never an IPC method. The command line starts it with `sidekicks daemon
// start` (Plan-005 T-005r-3-4); the desktop app's main process starts it through the preload
// bridge's `daemon.requestStart()`, and quitting the app leaves the service and every run running)
// Separate methods (no shared `action` discriminator). Stop and restart take `EmptyPayload`. A stop
// or restart is: flush pending writes, ask, wait up to the service's drain bound
// (DAEMON_STOP_DRAIN_BOUND_MS) for it to exit, and only if it still runs SIGTERM, then SIGKILL 2 s
// later, from the app and from `sidekicks daemon stop` and `restart` alike. A confirmed stop or
// restart wins: another connected client never refuses it, so both results are the uniform {
// accepted: true }, one type for both.
interface DaemonLifecycleAccepted {
  accepted: true;
}

// `daemon.flush`, sent before a quit and taking `EmptyPayload`: every write pending when it arrives
// is made durable. It never stops the service, and every run and shell keeps running.
interface DaemonFlushResponse {
  flushed: true;
}

// `daemon.ping`, the desktop client helper's liveness check on its link to the service. The helper
// sends it only after 5 s with no frame from the service, so a busy link carries none; after 20 s
// with no frame the helper counts the link as dead and reports it to main, which shows it on the
// connection state and restarts the service with its backoff. The answer is the evidence of life,
// so it carries nothing: it takes and answers `EmptyPayload`.

// `daemon.config.read` / `daemon.config.update`, the
// machine-wide service settings Settings › Runtime edits, one configuration surface (Spec-006).
// Separate from the per-session `session.maxSteps.update`, `session.spendLimit.update` and
// `session.tokensPerRun.update`. The read takes `EmptyPayload`, and both answer `DaemonConfig`.
interface DaemonConfig {
  // a taken port is saved, not refused; `workflow.webhookListener.read` says whether it listens
  workflowListenerPort: number;
  runTimeLimitMinutes: 30 | 60 | 240 | 720 | 1440 | null; // `Stop a run after`; null is `No limit`
  // `Ask me after one start leads to`: 25, 100 (the default), 500 or 2,000 runs; null is `Never
  // ask`
  workflowChainAskAfterRuns: 25 | 100 | 500 | 2000 | null;
  maxStepsPerTurn: number | null; // null is `Unlimited`: each provider does what it does on its own
  // `Spend limit`, what each new session starts from; null is `Unlimited`
  spendLimitUsdMicros: number | null;
  // `Tokens per run`, what each new session starts from; null is `Unlimited`
  tokensPerRun: number | null;
  toolMemoryCapBytes: number | null;
  toolMemoryCapEnforceable: boolean;
  // the package caches' `Cache limit`; null is `Unlimited`, and then the service never clears a
  // cache on its own. With a size set, after each successful install the service reads that tool's
  // cache and clears it when it is larger, leaving the other tool's cache alone
  packageCacheLimitBytes: number | null;
  recordTraces: boolean;
  recordProviderMessages: boolean;
  // the folder raw provider messages are written to, which the page names
  providerMessagesPath: string;
}
// Exactly one member per press, never none and never two, like `provider.account.update`; the two
// facts the page draws beside the settings, `toolMemoryCapEnforceable` and `providerMessagesPath`,
// are not settable. The reply is the whole configuration after the change. A value that is not a
// port or not a size is refused, and nothing changes.
type DaemonConfigUpdateRequest = Partial<
  Omit<DaemonConfig, "toolMemoryCapEnforceable" | "providerMessagesPath">
>;

// `daemon.packageCache.list`, taking `EmptyPayload`: what each workflow package cache holds: one
// walk of each cache folder, taken only when called (the page opening, `Check again`) and, under a
// custom `Cache limit`, after an install; nothing samples it on a timer. The page adds the total.
interface DaemonPackageCacheReading {
  bun: { bytes: number; readAt: string };
  uv: { bytes: number; readAt: string };
}
// `daemon.packageCache.clear`: `uv`'s cache through `uv cache clean`, bun's
// by removing its folder; never a step's code folder or the Python the service manages, so a step
// already installed keeps working. A clear waits for the installs using that cache and an install
// waits for a clear; the reply is the new reading, a `DaemonPackageCacheReading`.
interface DaemonPackageCacheClearRequest {
  cache: "bun" | "uv" | "all";
}

// `provider.terminalSession.list`, taking `EmptyPayload`: the provider sessions a
// person typed in a terminal that are inside a provider's shared service, each working, idle or not
// reachable, with `provider` as data, read off
// the same directory entries the agents' session listing names, so Runtime and the agents read one
// fact. `Stop`'s confirm counts them and the service update's waiting step counts the working ones;
// read when a confirm opens and while an update waits, never on a timer. Empty while `Reach Codex
// sessions started in a terminal` is off.
interface TerminalProviderSession {
  provider: ProviderId;
  name: string;
  threadId: string;
  state: "working" | "idle" | "unreachable";
}
interface ProviderTerminalSessionListResponse {
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

// The batched subscription frame (Plan-005 Phase 2D), framed by the rule of Spec-006 §Required
// Behavior: the first event of a quiet stream goes at once, and what follows is coalesced into
// frames, so a lone event is never held while a burst still collapses into one delivery.
interface LocalSubscriptionFrame {
  // Changes only, never the whole record, and every change carries its own cursor — which is what
  // lets a consumer say where it got to without the producer keeping a position per consumer. The
  // producer never waits for a consumer and drops nothing for it: it holds only the consumer's
  // cursor and reads the next frame from the daemon's record once the consumer's lane has credit,
  // so a consumer that falls behind receives every change late, in order, and never a hole. A
  // consumer further behind the record's newest than that rule's threshold is sent one frame with
  // no changes that says it is behind and carries the newest cursor; it takes a snapshot read in
  // place of every change, and the stream carries on from the newest. The record rather than the
  // screen is the truth.
  changes: Array<{ cursor: EventCursor; value: EventEnvelope }>;
}
```

The frame above is defined here because it is a cross-cutting wire primitive, the class api-payload-contracts.md §Source-of-Truth Policy keeps in this file; its type, `SubscriptionNotifyParams<T>`, stays canonical in code at `crates/sidekicks-contracts/src/jsonrpc/streaming.rs` under that same policy, and the Rust type there governs on any divergence. Nothing is minted for the batching: the frame rides the registered `$/subscription/notify` method, a consumer that is behind takes the snapshot read its surface already serves, and no method name, error code, or setting is added. Producer side: [Plan-005 §Phase 2D](../../plans/005-local-ipc-and-daemon-control.md#phase-2d--substrate-supplement-the-subscription-frame-is-batched-carries-changes-only-and-never-waits-for-a-consumer). Consumer side: [Plan-020](../../plans/020-desktop-app-and-renderer.md)'s transcript frame, which takes a snapshot read on the frame that says it is behind.
