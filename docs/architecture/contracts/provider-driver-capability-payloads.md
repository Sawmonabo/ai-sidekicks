# Provider Driver Capability Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

```ts
// NO `outputSpeedState` MEMBER. This is the driver-constructed RETURN of `createSession`, a
// one-time value, while the provider's declared speed state changes over the binding's life:
// Codex declares it on establishment and again on its settings-changed notification, and Claude
// Code reports it on its `initialize` reply and again on each session handshake. A member here
// would be a snapshot the next declaration makes stale, so the observation is binding-held state
// instead; see `ProviderOutputSpeedState` below
// (`packages/contracts/src/provider/driver/output-speed.ts`).
interface ProviderSessionHandle {
  providerSessionId: string;
  resumeHandle: string;
}

// The provider's own report — never a probe of its own and never synthesized from the request.
// IT IS BINDING-HELD DRIVER-SESSION STATE, NOT A SPAWN RETURN.
// The provider declares it from the start of a live binding and again whenever it changes: on
// Codex the establishment reply and the settings-changed notification, on Claude Code the
// `initialize` reply before any turn and the session handshake after it, so no synthetic turn is
// ever spent to obtain it. The driver records each declaration against the binding as it arrives
// and holds the latest for the binding's life — the same held-state shape `listProviderCommands`
// already uses — so a live binding carries an observation from spawn or establishment onward. A
// binding that is not live HAS NO OBSERVATION, and every reader of it is absent-until-observed
// rather than defaulted.
// READ AND DISCARDED WITH THE SESSION: it is deliberately NOT written to `runtime_bindings.spawn_config`, which records
// what was REQUESTED so a resume can re-realize it, and not to `agents.output_speed`, which
// records the person's accepted choice. Persisting an observation into either would create a
// second, staler record of a fact the live session already holds — and would make a mode that
// stopped being available look accepted after a restart. It reaches clients as a LIVE-SCOPED
// projection on `AgentListResponse.agents[]`, present only while the binding it was read on is
// live.
//
// `declared` is carried VERBATIM and is deliberately not narrowed to `outputSpeedLevels`: that
// vocabulary bounds what a caller may REQUEST, while this is what the provider REPORTED, and a
// provider that returns a level the vocabulary does not list is reporting a real state under
// version skew — coercing it to `off` would fabricate exactly the false reading this member
// exists to prevent. `reason` is the provider's own explanation, present only where the provider
// supplied one; its absence means the provider gave no reason, never that there was none. Both
// strings are provider-authored and `wireFreeFormString`-bounded per the head of provider-driver-payloads.md §Plan-003.
interface ProviderOutputSpeedState {
  declared: string;
  reason?: string;
}

interface ProviderModel {
  id: string;
  name: string;
  capabilities: string[];
  effortLevels?: string[]; // per-model reasoning-effort vocabulary, copied verbatim from the provider's own catalog read — the lists differ per model WITHIN one provider, so there is no provider-wide list (Spec-004 §Provider Parameter Vocabularies); absent = the model exposes no effort selection
  // Per-model output-speed vocabulary where the provider publishes one on its catalog read —
  // Codex's service-tier ids, copied verbatim, by the `effortLevels` rule (Spec-004 §The
  // output-speed axis); absent = the model exposes no speed selection. A provider that publishes
  // no per-model set (Claude Code) declares its set on `GetCapabilitiesResult.outputSpeedLevels`.
  outputSpeedLevels?: string[];
  // Whether the model has a fast output mode, as its provider reports it (Claude Code's
  // `supportsFastMode`, the Codex tier its catalog names `Fast`). Required so a missing reading
  // never looks like "no fast mode".
  fast: boolean;
  // Whether this row is the model's larger window, offered beside its default row; the driver fills
  // it from the provider (Codex's catalog `max_context_window`, Claude Code's `[1m]` mark on the
  // model id). On Codex the row's `contextWindow` is the figure a pick of it records; a Claude
  // larger row is picked by its own id.
  largerWindow: boolean;
  // The window in tokens as the provider reports it; absent until a reading arrives, never filled
  // from a table or a default.
  contextWindow?: number;
}

interface ProviderMode {
  id: string;
  name: string;
}

// Effective sandbox/permission posture (shape owned by Spec-004, policy semantics by Spec-010 §Required
// Behavior). Referenced by RunStateChangeEvent.executionPosture? (the run.running
// audit stamp) and by CreateSessionParams/StartRunParams (the spawn/turn carriers).
// This is what a DRIVER APPLIES, not what a person chooses: a person chooses one of the five
// permission levels, the posture carries that level verbatim as its `mode` (`PermissionLevel`
// in api-payload-contracts.md §Shared Enums), and each driver resolves it into the filesystem composition below
// against its own provider's modes, per Spec-010 §Required Behavior. The level-to-provider-mode
// realization is each driver's, recorded per driver in Spec-010 §Required Behavior; no table here
// restates it, and the posture carries no vocabulary of its own beside the level.
type ExecutionPosture = {
  mode: PermissionLevel; // the session's permission level (api-payload-contracts.md §Shared Enums) — the only posture vocabulary in the product (Spec-010 §Required Behavior)
  writableRoots: string[];
  credentialPolicyRef: string; // a plain reference naming the credential deny list the daemon handed the provider — REQUIRED on every run. The provider's own rule enforces the list (Claude Code's deny rules hold in every permission mode; Codex's filesystem denies hold wherever its sandbox runs, which Full Access does not) (Spec-010 §Required Behavior).
};

// Daemon-curated callback tool exposed into a session (authorization semantics
// Spec-010). Mirrors the function-form provider tool shape (name + description +
// JSON-Schema input) — served on the daemon's shared `sidekicks` MCP tool server through one `url`
// entry per session (Claude Code through `--mcp-config`, Codex as a `url` entry in the
// conversation's `mcp_servers` at `thread/start`), never Codex `dynamicTools`; Claude Code surfaces
// the tools as `mcp__sidekicks__<tool>` and Codex as `mcp__sidekicks.<tool>`. Every invocation flows through the daemon's approval pipeline and
// lands as an ordinary `tool_activity` row (Spec-005). Daemon-constructed and daemon-trusted —
// never provider output.
interface SessionCallbackTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema for the tool's arguments
}

// Callback-tool dispatch seam (Plan-003 T1.8 / T3.15 leg 3). The daemon injects
// `onCallbackToolCall` at spawn (CreateSessionParams in provider-driver-payloads.md); when the provider issues a callback-tool
// request (a tool call on the daemon's MCP `url` entry, from either provider), the driver translates the wire request
// into a `CallbackToolInvocation`, invokes the injected dispatcher, and answers the provider with the
// `CallbackToolResult` — no invocation is left unanswered, no approval bypass invented. The daemon-side
// dispatcher is Plan-003's callback-tool host (`provider/callback-tool-host.ts`), routing every
// invocation through Plan-009's Cedar approval pipeline by the daemon's own approval service — the
// in-process request create that `approval.requestCreate` names, which the daemon raises from a
// provider callback and no client calls (CP-003-5 covers driver-host permission callbacks) —
// Plan-003 authors no Plan-009 symbols — and landing the outcome as an ordinary `tool_activity` row. `CallbackToolInvocation` is normalized
// at the driver boundary from untrusted provider output; `CallbackToolResult` is daemon-constructed
// and trusted. Fail-closed availability: exposure is keyed on the daemon's approval service, not on
// any wire registration. While that service is not running, spawn WITHHOLDS the callbackTools
// registry (tools not exposed) and the host's runtime backstop answers any stray invocation `denied`
// + a DriverDiagnosticRecord — never `completed` without Cedar, never unanswered; the allow path
// opens once Plan-009's approval service runs (CP-003-5).
interface CallbackToolInvocation {
  toolName: string; // untrusted provider output — wireFreeFormString-bounded (the trust-boundary header's string enumeration); resolved against the session's registered SessionCallbackTool set, and an UNKNOWN name answers `failed` without dispatch
  arguments: Record<string, unknown>; // validated against the registered tool's inputSchema BEFORE any Cedar round-trip — schema-invalid arguments answer `failed` without dispatch, so malformed provider output never reaches the approval pipeline
  toolCallId: string; // untrusted provider correlation id — wireFreeFormString-bounded, copied verbatim onto the answered result (tool-event pairing is exact-string match)
  sessionId: SessionId;
  runId: RunId;
}
type CallbackToolResult =
  | { status: "completed"; output?: unknown; error?: never }
  | { status: "denied"; output?: never; error?: string }
  | { status: "failed"; output?: never; error?: string };

// MCP server-status producer seam (Plan-003 T1.8 / T3.13). Producer-only: the daemon
// injects `onMcpServerStatus` at spawn (CreateSessionParams in provider-driver-payloads.md); the driver emits the per-session MCP
// SERVER inventory (name + status) at init plus status-change updates through it — never an untyped
// record. Servers only, never a per-server tool-list assumption (support is not visibility, Spec-004
// §Per-Driver Capability Matrix). Driver telemetry surface: nothing is persisted,
// so no table is created. The consumer is Plan-022's status normalizer (Spec-024 — mcp-governance-payloads.md §Plan-022 — MCP Governance Contract Surfaces); consumer semantics live there.
type McpServerStatus = "unknown" | "starting" | "connected" | "needs-auth" | "failed";
// Driver-emitted shape: serverName + status ONLY. The driver NEVER supplies leg identity — the daemon
// pre-binds the injected producer closure to the leg at spawn (sessionId + the store-minted bindingId,
// pre-minted before the spawn per the relaunch write-seam pattern), so a driver cannot misattribute —
// or spoof — another leg's rows, and the init census emitted DURING createSession needs no id the driver
// does not have. `serverName` is untrusted provider/CLI output — wireFreeFormString-
// bounded at the driver normalization seam (the string enumeration at the head of provider-driver-payloads.md) before it reaches the
// producer.
interface McpServerStatusEmission {
  serverName: string;
  status: McpServerStatus;
}
// Daemon-stamped consumer-facing record (what the Plan-022 status normalizer reads): the pre-bound
// producer closure stamps the leg identity onto every emission.
interface McpServerStatusUpdate {
  sessionId: SessionId;
  bindingId: string; // leg key — daemon-stamped from the injection context, never driver-supplied; run→bindings is 1:many (the SetSessionGoalParams.bindingId precedent), so statuses key per (binding, server): a relaunched leg's fresh census supersedes its OWN predecessor without clobbering a concurrent live leg's rows
  serverName: string;
  status: McpServerStatus;
}
type McpServerStatusProducer = (emission: McpServerStatusEmission) => void;

// Provider-native in-session subagent policy (orchestration semantics Spec-014). Single-supervisor invariant: the daemon is the only cross-session supervisor —
// provider subagents run in-session only, their usage aggregates into the run's own budgets, and
// their tool calls flow through the same approval pipeline. `maxConcurrent` is the person's
// `Helpers at once` for that provider: absent, the default, is no limit, and the daemon lifts the
// provider's own built-in limit; `0` runs none, and the daemon withholds the provider's helper tool;
// any other number N is passed as Codex's own limit, `features.multi_agent_v2.max_concurrent_threads_per_session` set to N + 1,
// because Codex counts the lead among those threads (its helper limit is that setting minus one), and
// on Claude Code, which has no such setting, the daemon's pre-tool hook on the Agent tool holds a new helper's start
// until one of that session's running helpers finishes.
// There is no ceiling of the app's own (Spec-004 §Parity Capability Mechanism Grades; Spec-014
// §Provider-Native Subagents).
type SubagentPolicy =
  // Discriminated on `enabled`: a disabled policy carries no limits or definitions —
  // "off but configured" is unrepresentable; the daemon sends the full arm on enable.
  | { enabled: false }
  // Both limit members are OPTIONAL and neither is the daemon's own. The daemon sets no depth and
  // no concurrency ceiling of its own: `maxDepth` carries the person's own provider setting where
  // they have set one and is absent where they have not, and `maxConcurrent` reads as above. The
  // provider's own nesting limit is what bounds
  // the tree, and where the provider refuses a level its refusal is shown in the provider's words.
  // A driver passes each member through as it stands and clamps nothing — a driver-side ceiling
  // would refuse what neither the person nor the provider bounded
  // (Spec-014 §Provider-Native Subagents).
  | {
      enabled: true;
      maxDepth?: number;
      maxConcurrent?: number;
      definitions: SubagentDefinition[];
    };

// Unified per-subagent definition the driver maps onto its provider form (Claude Code's --agents
// entries; Codex [agents] config). Fields beyond `name` are optional — each leg maps
// what its provider supports and ignores the rest (tolerant mapping, graded on the matrix).
interface SubagentDefinition {
  name: string;
  description?: string;
  model?: string;
  tools?: string[];
  effort?: string;
  maxTurns?: number;
}

interface DriverCapabilities {
  flags: Record<DriverCapabilityFlag, boolean>;
  contractVersion: string; // change-detection signal, not negotiation: recorded at daemon start, compared on each refresh to invalidate capability snapshots; the daemon never version-gates behavior on it (Spec-004 §Default Behavior)
}

// Per-tool idempotency classification a tool declares (Spec-004 §Tool Metadata), shown per tool on
// Settings › MCP servers. A restart re-executes no call whatever its class
// (Spec-013 §In-Flight Receipts After A Restart).
type IdempotencyClass = "idempotent" | "compensable" | "manual_reconcile_only";

// Durable MCP Tasks recovery handle (Plan-003 T5.1). A task-augmented MCP call under MCP 2025-11-25's
// experimental Tasks utility carries a receiver-generated `taskId` (from the `CreateTaskResult`
// acceptance response). It is NOT a new RPC payload: the daemon persists it on the receipt as the
// additive nullable `command_receipts.mcp_task_id` column (Plan-003 EXTENDs Plan-002's table per
// cross-plan-dependencies.md; DDL in local-sqlite-schema.md §Queue and Intervention Tables —
// bounded ≤256 code points + non-empty + NUL-reject: the id is untrusted remote-peer output, and
// the write seam mirrors it). That column is the durable handle Spec-013 recovery reads to poll
// `tasks/get` + `tasks/result` instead of halting the run; NULL until the
// receiver accepts — a crash before that leaves the halt intact (Spec-004 §Recovery Consequences).

// INGRESS shape — what a provider driver DECLARES via `getCapabilities()`. `idempotency_class`
// is OPTIONAL: a driver MAY omit it and an undeclared class is NOT a contract violation. Were the
// field required here, Zod would reject a conformant-but-silent driver at ingress BEFORE the
// default could apply — defeating Spec-004 §idempotency_class. The daemon's capability-normalization seam
// (Plan-003 T2.4 hydration) resolves an omitted class to `manual_reconcile_only` (the conservative
// default per Spec-004 §idempotency_class), producing a `NormalizedProviderToolMetadata`.
interface ProviderToolMetadata {
  name: string;
  idempotency_class?: IdempotencyClass;
  description?: string;
}

// NORMALIZED shape — the daemon-side projection AFTER the normalization seam has applied the
// `manual_reconcile_only` default. `idempotency_class` is REQUIRED, so the type system forbids
// persisting an un-normalized value into the NOT NULL `driver_tools.idempotency_class` column.
// This is the only tool-metadata shape that crosses the persistence boundary; ingress
// `ProviderToolMetadata` never does.
interface NormalizedProviderToolMetadata {
  name: string;
  idempotency_class: IdempotencyClass;
  description?: string;
}

// CLI-version report: two facts. `rawVersion` is the verbatim provider-printed version string,
// always present (untrusted provider output on the nominal `GetCapabilitiesResult` return — bounded at
// the Plan-003 write seam like `contractVersion`, not the Zod trust boundary); `parsedVersion` is the
// driver-parsed MAJOR.MINOR.PATCH, present only when the printed version parses. Nothing writes
// `"unknown"` as a version. Every version runs, parsed or not; nothing refuses on it. Both values
// are read from the version the SPAWNED process reports in-band, not from
// a launcher symlink.
interface DriverCliVersionReport {
  rawVersion: string;
  parsedVersion?: string;
}

// Zero-turn authentication probe result. Zod `.strict()` — a result
// envelope rejecting unknown keys, correct for an internal owned contract paired with
// contract versioning. The probe feeds the account's sign-in reading, never a check before a
// session starts: a start runs, and a real sign-in failure arrives as the provider's own refusal.
// `indeterminate` (probe surface unavailable or unparseable) stays distinguishable so the person
// can tell probe health from credential state, and it never refuses a start (Spec-004 §Required
// Behavior). Mid-run credential expiry is a different surface: the
// provider's typed auth-failure signals map to RecoveryCondition 'reauth-required'.
interface DriverAuthProbeResult {
  status: "authenticated" | "unauthenticated" | "indeterminate";
  detail?: string; // provider-reported account/plan detail (untrusted free-form, bounded)
}

// Return type of `ProviderDriver.getCapabilities()`. Spec-004 §Tool Metadata semantically
// separates whole-driver capability flags from per-tool metadata; the wrapper keeps
// `DriverCapabilities` pure (flags + contractVersion only) while still carrying both
// surfaces in a single round-trip. Precedent: MCP separates `initialize`
// server capabilities from `tools/list`; LSP separates `ServerCapabilities` from
// registered tool surfaces. `cliVersion` is REQUIRED and always carries the printed version;
// its parsed form is present only where the version parses.
interface GetCapabilitiesResult {
  capabilities: DriverCapabilities;
  tools: ProviderToolMetadata[];
  cliVersion: DriverCliVersionReport;
  // Per-flag provenance of the reading above (Spec-004 §Required Behavior). `probed` means decided against the installed
  // build by a zero-turn probe whose negative control still refused; `static` means declared
  // from the driver's own per-driver table, which Spec-004 admits only where the flag has no
  // ADMISSIBLE probe -- zero-turn, non-mutating, and decisive at the consumed granularity --
  // and requires the mechanism table to name the conjunct that fails. Sibling of `cliVersion` for the same reason `cliVersion` is
  // one: it is a property of THIS reading, not of a capability, so `DriverCapabilities` stays
  // pure (flags + contractVersion). ADDITIVE-OPTIONAL and LIVE-SCOPED, not required — present
  // and TOTAL over the flag set whenever the wrapper is a live driver read; absent exactly
  // when it was reconstructed by `DriverCapabilitiesWriter.hydrate()` from the durable cache,
  // which persists flag VALUES for change detection and NOT provenance (so no column is
  // minted, and a required member would be unsatisfiable on that path). Absence therefore
  // reads as "cache reconstruction", never as "unknown provenance" — a consumer that needs
  // provenance re-reads the driver. Driver-side only: deliberately NOT carried on the client-facing
  // `driver.listCapabilities` payload, which this member does not widen. The client-facing `driver.*`
  // set is the method table in `packages/contracts/src/provider/driver/methods.ts`: `driver.listModes`,
  // `driver.listModels`, `driver.listCapabilities`, `driver.interruptRun`,
  // `driver.applyIntervention`, `driver.compactContext` and `driver.listProviderCommands`
  // (`{sessionId, agentId}` → `ProviderCommandListResult`, an agent's `/` list read once),
  // registered under Plan-005's CP-005-4. Each
  // reads the driver or acts on an already-existing session, and none establishes, restores, starts,
  // or tears a session down; every other operation in provider-driver-payloads.md is daemon-internal, and the session's `/`
  // list reaches a client as `session.providerCommandsSubscribe` (running-command-payloads.md §Running-Command Method Registry).
  detectionSource?: Record<DriverCapabilityFlag, CapabilityDetectionSource>;
  // The output-speed axis's VALUE VOCABULARY for a driver whose provider publishes no per-model
  // set (Spec-004 §Provider Parameter Vocabularies + §The output-speed axis). WHERE the set is
  // published decides where it lives: the Codex catalog read publishes a tier list on each model
  // row, so that leg's set is `ProviderModel.outputSpeedLevels`, per model, and this member is
  // absent for it; the Claude leg's provider reports the mode's state but publishes no list of
  // modes, so its set is STATICALLY DECLARED here from the driver's per-driver table. Present iff
  // `capabilities.flags.output_speed` is `true` and the driver declares a static set. A mutation
  // validates against the model's own list where one is published, else this one; absent or
  // empty on both, the axis is unsettable for that model and an `agent.configUpdate` carrying
  // `outputSpeed` refuses fail-closed rather than forwarding an unvalidated value. Unlike
  // `detectionSource`, this member IS served on the client-facing `driver.listCapabilities`
  // payload — its reader is a client control that must offer the choice set, the same reason
  // `ProviderModel.effortLevels` travels to the client that renders the effort selector. The
  // values themselves are the provider's own; this contract names none of them.
  //
  // PRESENT ON BOTH READ PATHS, and that is a consequence of being static rather than a second
  // rule. Because the static vocabulary is a property of the DRIVER, not of a reading, the
  // wrapper carries it identically whether it was built by a live `getCapabilities()` call or
  // reconstructed by `DriverCapabilitiesWriter.hydrate()` — the hydrating path re-derives it from
  // the same per-driver table the live path reads, so nothing has to survive the durable cache.
  // This is exactly why it does NOT follow `detectionSource` into absence-on-hydrate: that member
  // is a fact about one reading and cannot be re-derived, while this one is a constant of the
  // driver and always can. Consequently the durable capability cache gains NO column. A
  // client therefore never receives a statically declared `output_speed: true` without the values
  // it must render, on either path, so Plan-013's fail-closed refusal rule can never be triggered
  // by the cache; the per-model set rides the live `driver.listModels` read.
  outputSpeedLevels?: string[];
  // Each provider's BUILT-IN TOOLS, in the provider's own spelling — Claude Code: `Read`, `Edit`,
  // `Write`, `Bash`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Agent`; Codex: `shell`, `apply_patch`,
  // `web_search` — the list an agent definition's tool allowlist picks from, beside the daemon's
  // callback tools and the MCP catalog. `Agent` is Claude Code's canonical name for its spawn tool,
  // whose alias `Task` is what its init frame shows. STATIC like `outputSpeedLevels`, from the same
  // per-driver table, so it is present on both read paths and the durable capability cache gains no
  // column; served on the client-facing `driver.listCapabilities` payload and bounded there like
  // `outputSpeedLevels`. The words a person reads for each tool are the renderer's, never this list's.
  builtInTools: string[];
}

type CapabilityDetectionSource = "static" | "probed";
```
