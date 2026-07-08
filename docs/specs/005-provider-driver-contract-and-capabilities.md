# Spec-005: Provider Driver Contract And Capabilities

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `005` |
| **Slug** | `provider-driver-contract-and-capabilities` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Runtime Node Model](../domain/runtime-node-model.md), [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md), [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md), [Data Architecture](../architecture/data-architecture.md) |
| **Implementation Plan** | [Plan-005: Provider Driver Contract And Capabilities](../plans/005-provider-driver-contract-and-capabilities.md) |

> **Amendment (2026-07-05, capability-enhancement campaign B3 — amends the previously-`approved` spec; the header is flipped to `review` for the amendment's review window per the audit runbook's spec-amendment rule, and the campaign plan's Task 28 batch re-promotion restores `approved` after the W1.5 spec gate; dependent plans' code dispatch stays census-gated on that restoration).** This bundle lands the driver-wire and parity-surface changes; each affected section carries the normative text in place. (1) `getCapabilities` reports carry a mandatory `cliVersion` (`DriverCliVersionReport { raw, semver }`) with mechanical minimum-version floor enforcement; an unparseable version fails closed and a parseable below-floor version refuses attach/refresh (§Required Behavior; error codes `driver.cli_version_unparseable`, `driver.cli_version_below_floor`). (2) A zero-turn authentication probe `probeAuth` (`DriverAuthProbeResult`, `.strict()`) so a logged-out provider is detected before a turn is spent (§Required Behavior; §Fallback Behavior; error code `driver.not_authenticated`). (3) A mandatory requester-generated `clientIdempotencyKey` (UUID) on every intervention request — participant clients and the daemon’s system-intervention origination path (orchestration budget / idle / moderation interrupts, ADR-011) each synthesize it — at-least-once delivery becomes exactly-once application via replay-or-conflict semantics backed by the `interventions` schema's `UNIQUE(target_run_id, client_idempotency_key)` guard (§Required Behavior; §State And Data Implications; mirrors in [Queue And Intervention Model](../domain/queue-and-intervention-model.md) and [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md); error code `intervention.idempotency_conflict`). (4) The repeated inline recovery-condition union is hoisted to a named `RecoveryCondition` type declared once in [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) and widened with `reauth-required` for mid-run provider credential/session expiry (§Fallback Behavior). (5) The resume result's `resumed` variant carries a mandatory normalized `sessionPosition`; the `failed` variant structurally omits `bindingId` — unchanged invariant, now stated with the position-compare consumer (§Fallback Behavior; §Acceptance Criteria). (6) The driver-result ↔ intervention-lifecycle vocabulary is mapped normatively across its four carrying surfaces (§Required Behavior; the mapping table lives in [Queue And Intervention Model](../domain/queue-and-intervention-model.md)). (7) `contractVersion` is re-framed as change-detection, not negotiation (§Default Behavior). (8) Capability refresh cadence is sharpened to per-runtime-node, 15-minute bounded polling with optional provider push (§Resolved Questions and V1 Scope Decisions). (9) Event-normalization obligations: the driver stamps `windowSource` and computes `exceeded` at the normalize boundary (§Interfaces And Contracts). (10) An MCP-discovered tool is always `manual_reconcile_only`; deriving `idempotency_class` from MCP `ToolAnnotations` is prohibited; the only upgrade path is the operator-governed assignment (§Tool Metadata). (11) The `mcp: true` matrix row carries an explicit support-vs-visibility honesty note (§Per-Driver Capability Matrix; §Fallback Behavior). (12) CLI-currency matrix updates re-verified at authoring time against the pinned binaries per the campaign's regenerate-don't-transcribe rule: `steer` TRUE for Codex via `turn/steer`; `interactive_requests` two-provider with per-provider mechanisms; a new `structured_output` flag; per-provider effort vocabularies with the Codex per-turn override note; and the Codex driver's normative `approvalsReviewer: "user"` pin (§Per-Driver Capability Matrix; §Required Behavior). (13) R8 parity driver surfaces: mechanism grades (`native | emulated | absent`) on a new parity-capability matrix; new driver operations `rollbackTo`, `setSessionGoal` / `clearSessionGoal`; the session callback-tool registry, `subagentPolicy` pass-through, and `executionPosture` on spawn/turn params; and a config-gated Codex transport axis (§Required Behavior; §Interfaces And Contracts; §Per-Driver Capability Matrix; typed shapes in [API Payload Contracts](../architecture/contracts/api-payload-contracts.md); posture policy semantics per [Spec-012 §Required Behavior](012-approvals-permissions-and-trust-boundaries.md#required-behavior), campaign B20; the `rollback` intervention type is Spec-004 content landing via campaign B2 — a named merge prerequisite before any rollback emitter exists).

## Purpose

Define the normalized driver boundary between the core runtime and provider-specific execution transports.

## Scope

This spec covers required driver operations, capability advertisement, normalized event shapes, and runtime binding persistence.

## Non-Goals

- UI behavior for every capability
- Provider-specific prompt tuning
- Provider commercial or billing concerns

## Domain Dependencies

- [Runtime Node Model](../domain/runtime-node-model.md)
- [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md)
- [Run State Machine](../domain/run-state-machine.md)

## Architectural Dependencies

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Data Architecture](../architecture/data-architecture.md)
- [ADR-005: Provider Drivers Use A Normalized Interface](../decisions/005-provider-drivers-use-a-normalized-interface.md)

## Required Behavior

- Every provider integration must implement a normalized driver contract.
- Provider drivers must execute within a participant-owned or operator-owned runtime node governed by a local daemon. V1 must not depend on a shared hosted driver service as the execution authority.
- The driver contract must support create session, resume session, start run, interrupt run, `applyIntervention`, respond to interactive request, close session, and enumerate models or modes or both where available.
- The `applyIntervention` operation is a generic dispatcher that routes intervention requests (steer, interrupt, cancel) to the appropriate driver-specific handler based on the intervention type and the driver's declared capabilities. `cancel` maps to the `interrupted` terminal state in the run state machine — it is a user-initiated interruption. Drivers that do not support a given intervention type must return a `degraded` result, allowing the orchestration layer to fall back (e.g., steer degrades to queue + interrupt for providers without native steer support). The driver-level result vocabulary is exactly `applied | degraded`; `rejected` and `expired` are orchestration-layer verdicts rendered by the daemon's authorization and version-guard checks around driver dispatch and are never returned by a driver — the normative mapping onto the six-state intervention lifecycle lives in [Queue And Intervention Model §Driver Result To Lifecycle Mapping](../domain/queue-and-intervention-model.md#driver-result-to-lifecycle-mapping).
- The contract additionally defines capability-gated parity operations — `rollbackTo` (conversation rollback to a normalized session position; gated on the `rollback` flag) and `setSessionGoal` / `clearSessionGoal` (session-goal injection; gated on `session_goals`) — plus a zero-turn `probeAuth` required of every driver: provider authentication state must be knowable without spending a billed turn. Dispatch of a capability-gated parity operation follows the same static/dynamic split as interventions ([Queue And Intervention Model](../domain/queue-and-intervention-model.md)): a call against a flag the driver does not declare is refused statically with `driver.capability_unsupported` before driver dispatch (these direct operations have no documented orchestration fallback), while `degraded` is the dynamic outcome of an invoked driver that could not deliver the operation natively and reports the fallback it took — never an opaque failure.
- Every intervention request carries a mandatory requester-generated `clientIdempotencyKey` (UUID) — generated by the participant client, or by the daemon’s origination path for system interventions (orchestration budget / idle / moderation interrupts per ADR-011), which reuses its synthesized key across its own retry loop. The daemon applies replay-or-conflict semantics — an identical retry returns the originally recorded outcome without re-dispatching the driver; reuse of a key with a differing payload is rejected as `intervention.idempotency_conflict` — following the converging idempotency-key practice ([Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests); the expired IETF draft [draft-ietf-httpapi-idempotency-key-header](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)). The key rides through `ApplyInterventionParams` so drivers can propagate it to provider-remote invocations that honor dedupe keys (the `compensable` pattern, §Tool Metadata).
- Every `getCapabilities` report must include `cliVersion` — a `DriverCliVersionReport` carrying the verbatim provider-reported version string (`raw`) and its parsed semantic version (`semver`). The daemon enforces a per-driver minimum-version floor mechanically at attach and refresh (semantic-version comparison against the configured floor; V1 shipped floors: Claude Code `2.1.198`, codex-cli `0.141.0` — the 2026-07-02 CLI-currency audit pair). An unparseable version report fails closed: the report cannot be constructed (`semver` is required, so unparsed-but-attached state is unrepresentable), the driver refuses attach, and the failure surfaces as `driver.cli_version_unparseable`. A version that parses cleanly but sits below the configured floor likewise refuses attach/refresh fail-closed, surfacing as `driver.cli_version_below_floor` (distinct from `version.floor_exceeded`, which governs client/event-envelope contract floors, not provider CLI installs).
- Every driver must implement `probeAuth` — a zero-turn authentication probe returning `DriverAuthProbeResult` (`authenticated | unauthenticated | indeterminate`). `indeterminate` (probe surface unavailable or unparseable) is treated as not authenticated for admission — fail closed — while remaining distinguishable so operators can separate probe health from credential state. Run admission against a driver that does not probe `authenticated` is refused as `driver.not_authenticated` before any turn is spent.
- The Codex driver must pin `approvalsReviewer: "user"` at session spawn so every approval routes through the daemon's approval pipeline ([Spec-012](012-approvals-permissions-and-trust-boundaries.md)); provider-side guardian / auto-review auto-adjudication is disabled by contract. The generated protocol's own default is already `user`, so the pin is defense-in-depth against a config/profile override — and guardian / auto-approval notifications normalize as observability rows, never as approval decisions.
- Spawn/turn parameters carry the parity surfaces: a session callback-tool registry (`SessionCallbackTool[]` — the daemon exposes a curated tool set into every run; Codex leg `dynamicTools` + the `item/tool/call` server request, Claude leg a daemon-hosted ephemeral MCP server via `--mcp-config`; every callback invocation flows through the daemon's approval pipeline per [Spec-012](012-approvals-permissions-and-trust-boundaries.md) and lands as ordinary `tool_activity` rows per [Spec-006](006-session-event-taxonomy-and-audit-log.md)), a `subagentPolicy { enabled, maxDepth, maxConcurrent, definitions[] }` pass-through under the single-supervisor invariant (the daemon is the only cross-session supervisor; orchestration semantics land in Spec-016 via campaign B6), and the run's `executionPosture` (shape owned by this spec and typed in [API Payload Contracts](../architecture/contracts/api-payload-contracts.md); authorization and policy semantics in [Spec-012 §Required Behavior](012-approvals-permissions-and-trust-boundaries.md#required-behavior), campaign B20).
- Drivers must emit normalized runtime events rather than leaking provider-native event types into the session engine.
- Drivers must declare capability flags for at least `resume`, `steer`, `interactive_requests`, `mcp`, `tool_calls`, `reasoning_stream`, `model_mutation`, `structured_output`, `rollback`, `session_goals`, `callback_tools`, `subagents`, and `cost_cap`. A flag declares that the driver delivers the capability through its own mechanism at the driver boundary — natively or driver-emulated; **how** it delivers is recorded as a mechanism grade on the parity capability matrix (a capability delivered by the orchestration layer above the driver, like steer-for-Claude, keeps its driver flag `false`). The `pause` flag is intentionally excluded — no current provider implements native pause. Pause is an orchestration-layer construct (interrupt run, persist state, queue resume) that does not require driver support.
- Drivers must persist provider-owned resume handles separately from canonical session and run ids.
- The runtime must treat undeclared capabilities as unsupported.
- Drivers must declare a per-tool `idempotency_class ∈ {idempotent, compensable, manual_reconcile_only}` alongside their tool list. This metadata controls crash-recovery behavior for in-flight side-effecting tool calls; see [Spec-015 § Idempotency Protocol](015-persistence-recovery-and-replay.md#idempotency-protocol) for recovery semantics.

## Default Behavior

- Driver capability declarations are required at attach time and may be refreshed when provider state changes.
- Initial provider drivers are local-runtime-node integrations. They may call remote provider APIs or services, but driver control and execution authority remain attached to the local runtime node.
- Driver transport defaults to `stdio`. The Codex driver may additionally be configured — config-gated, off by default — to attach over `unix://` or `ws://` app-server listeners with bearer auth (`DriverTransportConfig`; the credential is held as a daemon-config reference, never inline). The Claude CLI exposes no local listener; remote Claude participation is cross-node dispatch per [Spec-024](024-cross-node-dispatch-and-approval.md) — recorded as the parity mechanism, not a driver transport.
- Unknown capability fields are ignored (tolerant reader). The declared `contractVersion` is a change-detection signal — the daemon records it at attach and compares it on refresh to detect contract drift and invalidate capability snapshots — not a negotiation surface: the daemon never version-gates its behavior on it, and additive contract evolution with tolerant reading replaces negotiated feature-unlocking.
- The runtime must only surface controls that correspond to supported capabilities for the active run.

<a id="fallback-behavior-resume"></a>

## Fallback Behavior

- If a driver cannot resume a previously persisted handle, it must surface `provider failure` detail and a visible `recovery-needed` condition; it must not silently create a replacement provider session under the same canonical run. Recovery conditions form the closed `RecoveryCondition` set — `recovery-needed` (generic: operator reconciliation required) and `reauth-required` (the provider session or credential expired: detected mid-run via the provider's typed auth-failure signals or at resume/probe time; remediation is re-authenticating the provider CLI on the runtime node, after which recovery may retry). The named type is declared once in [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) and referenced at every carrying surface.
- On successful resume the driver reports `sessionPosition` — its normalized monotonic position (turn/event ordinal) for the resumed provider session. The daemon compares it against the recorded position; reconciliation semantics (divergence halts for human decision) are Spec-015's, landing via campaign B5 per [ADR-017](../decisions/017-shared-event-sourcing-scope.md)'s local-log-authoritative ruling. A provider that silently returns a fresh session on resume (for example on a working-directory mismatch) is caught by this comparison rather than silently adopted.
- If a provider offers provider-native data that cannot be normalized safely, the runtime must store it as diagnostic metadata only, not as canonical domain state.
- If a driver does not support dynamic model or mode mutation, the runtime must require a new run or agent configuration rather than simulating mutation.
- If a requested integration path would require shared hosted execution outside the local runtime boundary, v1 must reject or mark that path unsupported rather than routing execution through the collaboration control plane.

## Interfaces And Contracts

- Required driver operations:
  - `createSession`
  - `resumeSession`
  - `startRun`
  - `interruptRun`
  - `applyIntervention` — generic dispatcher for steer, interrupt, cancel; checks capability flags and returns `degraded` for unsupported intervention types
  - `rollbackTo` — conversation rollback to a normalized session position (gated on the `rollback` flag; file-state restore is the daemon's turn-snapshot leg, [Plan-010](../plans/010-worktree-lifecycle-and-execution-modes.md), never the driver's)
  - `respondToRequest`
  - `setSessionGoal` / `clearSessionGoal` — session-goal injection (gated on `session_goals`; the daemon supplies the rendered goal text and the target `bindingId` (+ `runId`) — delivery is per-binding (`run` → bindings is 1:many; one call per live binding, the fan-out ack unit) — the structured goal shape is owned by the Spec-016 goal contract, campaign B6)
  - `closeSession`
  - `listModels`
  - `listModes`
  - `getCapabilities`
  - `probeAuth` — zero-turn authentication probe (required of every driver)
- Required normalized event families:
  - run lifecycle
  - assistant output
  - tool activity
  - interactive request
  - artifact publication
  - usage or quota telemetry where available
- Normalization obligations bind at the driver's normalize boundary: usage/quota telemetry is provenance-stamped by the driver — it sets `windowSource` (`provider_reported | model_default | estimated`) and computes the `exceeded` headroom predicate at normalization ([Spec-006 §Usage Telemetry](006-session-event-taxonomy-and-audit-log.md#usage-telemetry-usage_telemetry)) — never deferring provenance or the derived predicate to consumers.

## State And Data Implications

- Runtime bindings must store driver name, contract version, resume handle, the `cliVersion` report, and runtime metadata needed for recovery.
- Intervention idempotency keys persist on the `interventions` row (`client_idempotency_key`, unique per `(target_run_id, client_idempotency_key)`) so replay-or-conflict semantics survive daemon restart; see [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md).
- Capability changes must be emitted as events so clients and projections can adjust behavior safely.
- Diagnostic raw events may be retained separately from canonical normalized events.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## Per-Driver Capability Matrix

| Flag | Codex | Claude | Description |
| --- | --- | --- | --- |
| `resume` | true | true | Can resume a paused run from a saved handle |
| `steer` | true | false | Supports native mid-run content injection (Codex `turn/steer` — always-on, verified at codex-cli 0.141.0 against the generated protocol schema; the request carries the active-turn id precondition) |
| `interactive_requests` | true | true | Can issue tool confirmations and clarification questions |
| `mcp` | true | true | Supports MCP server tool calls. Support is not visibility: `true` means the provider can invoke MCP server tools, not that the daemon knows the provider's MCP tool census — an MCP-discovered tool is always `manual_reconcile_only` unless an operator-governed assignment upgrades it (§Tool Metadata) |
| `tool_calls` | true | true | Supports structured tool/function calling |
| `reasoning_stream` | false | true | Exposes reasoning/thinking tokens in output |
| `model_mutation` | false | true | Supports switching models mid-session |
| `structured_output` | true | true | Schema-constrained final output (Claude `--json-schema`; Codex `turn/start.outputSchema`). Named consumers: Spec-024 dispatch results and Plan-016 orchestration reads |
| `rollback` | true | true | Conversation rollback to a normalized session position via `rollbackTo` (Codex `thread/rollback`, native; Claude resume-at + fork-session, native composed). File-state restore is the daemon's turn-snapshot leg, never the driver's |
| `session_goals` | true | true | Session-goal injection via `setSessionGoal` / `clearSessionGoal` (Codex `thread/goal/*`, native live; Claude system-prompt composition applied from the next turn boundary — driver-emulated, see grades) |
| `callback_tools` | true | true | Daemon-curated callback-tool registry exposed into runs (Codex `dynamicTools` + `item/tool/call`; Claude daemon-hosted ephemeral MCP server) |
| `subagents` | true | true | Provider-native in-session subagents under the daemon-supplied `subagentPolicy` (Codex `[agents]` config; Claude `--agents` definitions) |
| `cost_cap` | false | true | Realizes a daemon-supplied hard cost cap natively at spawn (Claude `--max-budget-usd`). Consumed by Spec-016's native-cap unpriced admission: the escape reserves only against legs whose driver declares this flag (campaign B6, 2026-07-06). |

### Fallback Behavior

For each `false` in the matrix:

- **Codex `reasoning_stream: false`**: reasoning surface shows "unavailable" in timeline UI. No degradation — reasoning simply isn't exposed.
- **Codex `model_mutation: false`**: model switching requires a new run. The orchestration layer interrupts the current run and starts a new one with the desired model.
- **Codex `cost_cap: false`**: the native-cap unpriced-family escape refuses reservation on that leg (`orchestration.budget_exhausted`, `reason: 'driver_capless'`, fail-closed — Spec-016 §Cost Derivation And Absent-Cost Semantics). Priced families are unaffected: daemon-ledger accounting needs no provider-side cap.
- **Claude `steer: false`**: steer intervention degrades to queue + interrupt (see [Spec-004](../specs/004-queue-steer-pause-resume.md) § Driver-Level Steer Mechanics). InterventionResult state = `degraded`.

And for the `true` cell whose support is narrower than it reads:

- **`mcp: true` (both drivers)**: support is not visibility — the provider can invoke MCP server tools, but the daemon does not know the provider's MCP tool census from this flag. An MCP-discovered tool is **always** `manual_reconcile_only` unless an operator-governed assignment upgrades it (§Tool Metadata); the fallback for an unknown MCP tool census is the conservative default, never a class inferred from annotation self-claims.

This matrix is the initial V1 capability set. Drivers self-report capabilities via `getCapabilities()`. The matrix above documents expected V1 values; actual runtime values may differ as drivers evolve.

### Parity Capability Mechanism Grades

Boolean flags answer **whether** the driver delivers a capability; mechanism grades record **how** the system delivers it end-to-end (`native | emulated | absent`), generalizing the `mcp: true` honesty rule above. Grades are matrix/documentation truth — the wire declares driver-boundary booleans; the grade combines the driver leg with any daemon/orchestration leg. The grade token is always exactly one of the three; a row may qualify it parenthetically (e.g. `native` (partial: …), `absent` (upstream-gated: …)) without widening the vocabulary. Per-provider mechanisms below were re-verified at authoring time against the pinned binaries (Codex claims from the binary's own generated protocol schema, per the campaign's regenerate-don't-transcribe rule).

| Capability | Codex | Claude |
| --- | --- | --- |
| Session time-travel (rollback) | `native` — `thread/rollback` (drop-N-turns; the protocol schema itself notes it does not revert local file changes — the daemon's turn-snapshot git leg restores files, [Plan-010](../plans/010-worktree-lifecycle-and-execution-modes.md)) | `native` (composed) — `--resume-session-at <message-uuid>` + `--fork-session`; the driver runs with `--replay-user-messages` so message-UUID rewind targets appear on the wire |
| Session goals | `native` — `thread/goal/set` / `thread/goal/clear` (the `objective` text field) | `emulated` — daemon-stored goal composed into the system prompt at the next turn/resume boundary (no live mid-turn mutation) |
| Session callback tools | `native` — `dynamicTools` (function-form specs) + `item/tool/call` server request | `native` (MCP-shaped) — daemon-hosted ephemeral MCP server via `--mcp-config`; tools surface as `mcp__<server>__<tool>` |
| Remote provider transports | `native` — app-server `--listen unix:// \| ws://` + bearer auth, config-gated | `emulated` (architectural) — no local listener; remote Claude rides [Spec-024](024-cross-node-dispatch-and-approval.md) cross-node dispatch |
| Provider-native subagents | `native` — `multi_agent` + `[agents]` config (`maxConcurrent` enforced natively) | `native` — `--agents` `AgentDefinition`s (per-subagent model/tools/permissionMode/effort/maxTurns; depth cap 5); the spawn-side concurrency cap is docs-silent, so `maxConcurrent` is **boundary-serialized** on this leg — the daemon holds beyond-cap subagents at their next daemon-mediated tool call until a slot frees (never failed; breach diagnostic = observability; subagents disabled at spawn when the leg cannot mediate tool calls) per [Spec-016 §Provider-Native Subagents](016-multi-agent-channels-and-orchestration.md#provider-native-subagents) |
| Execution postures / sandbox profiles | `native` — sandbox modes + `[permissions.<name>]` profiles + per-turn `sandboxPolicy` | `native` (partial: Bash-scoped) — OS-level Bash-tool sandbox via `--settings`, with the permission system covering Read/Edit/MCP tools; per-knob grading and policy semantics in [Spec-012 §Required Behavior](012-approvals-permissions-and-trust-boundaries.md#required-behavior) |
| Realtime voice | `absent` (upstream-gated: `thread/realtime/*` exists behind an upstream feature flag (OFF) — not deliverable end-to-end today; no emitter until it stabilizes) | `absent` — no mechanism; no emulation claimed |

Realtime voice carries no boolean flag in V1 — the reserved `realtime_*` event family ([Spec-006](006-session-event-taxonomy-and-audit-log.md)) and this grade row record the truth; a wire flag lands when the upstream gate lifts. `interactive_requests` is two-provider with distinct mechanisms: Claude via the `can_use_tool` control round-trip (`--permission-prompt-tool`); Codex via the native `item/tool/requestUserInput` server request plus `mcpServer/elicitation/request` MCP elicitation.

### Provider Parameter Vocabularies

Effort vocabularies differ per provider and are surfaced per model: Claude `low | medium | high | max`; Codex `minimal | low | medium | high | xhigh` (no `max`), with per-model level lists carried on `ProviderModel.effortLevels`. Codex accepts per-turn model/effort/sandbox/approval overrides (`turn/start` params — the daemon surfaces per-turn posture via `StartRunParams.executionPosture`; other per-turn knobs ride `agentConfig`), where Claude binds these per session at spawn.

## Tool Metadata

Driver capabilities describe what the driver supports as a whole (e.g., `resume`, `steer`). Driver **tool metadata** is per-tool information the driver exposes for each tool in its catalog. The canonical V1 per-tool metadata field is `idempotency_class`, used by the daemon's two-phase command-receipt protocol during crash recovery.

### `idempotency_class`

| Value | Meaning |
| --- | --- |
| `idempotent` | Safe to re-execute on recovery. Either a pure read (`file.read`, `shell.stat`) or a write whose external target is server-side idempotent (for example `S3 PutObject` with `If-Match`). |
| `compensable` | Re-executable only when paired with a caller-supplied `dedupe_key` that the remote side honors (for example [Stripe idempotency keys](https://docs.stripe.com/api/idempotent_requests)). The driver is responsible for propagating `dedupe_key` to the remote invocation so that a duplicate request is rejected or treated as a no-op. |
| `manual_reconcile_only` | **Not** safe to re-execute automatically. Recovery halts the run with a `recovery-needed` condition (see §Fallback Behavior) and requires operator reconciliation. |

If a driver does not declare `idempotency_class` for a tool, the runtime MUST treat it as `manual_reconcile_only`. This is the conservative default and matches the existing rule that the runtime treats undeclared capabilities as unsupported.

An MCP-discovered tool is **always** `manual_reconcile_only`. The runtime MUST NOT derive `idempotency_class` from MCP `ToolAnnotations`: the MCP specification's current revision binds clients to treat tool annotations as untrusted unless they come from trusted servers ([MCP 2025-11-25 Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), MUST-strength) — and the MUST binds trust classification, not behavior derivation, so classes bind on the operator-managed assignment surface, never on annotation self-claims. The only upgrade path is the operator-governed assignment (MCP governance, [ADR-015](../decisions/015-v1-feature-scope-definition.md) feature #18 — governed by Spec-028, authored by the campaign's B18 bundle and not yet in the corpus). The consequence is stated outright: a `manual_reconcile_only` tool in flight at daemon crash halts the run's recovery with a `recovery-needed` condition, and the halted run blocks its co-participants' dependent work in that session until an operator reconciles.

### Recovery Consequences

Recovery behavior for a receipt that was in-flight at daemon restart (Phase 2 started, Phase 3 not reached) is dispatched on `idempotency_class`. The runtime emits `tool.replayed` for an `idempotent` or `compensable` re-execution and `tool.skipped_during_recovery` for a halt; full semantics live in [Spec-015 § Idempotency Protocol](015-persistence-recovery-and-replay.md#idempotency-protocol), and event-type registration lives in [Spec-006](006-session-event-taxonomy-and-audit-log.md) (full taxonomy-row integration tracked in [BL-064](../archive/backlog-archive.md)).

## Example Flows

- `Example: A local Codex driver starts a session through its native transport, exposes resume and steer capability, and emits normalized run events into the daemon.`
- `Example: A local Claude driver calls a remote provider API from the participant's runtime node. The provider service is remote, but the canonical driver authority and policy enforcement remain local.`
- `Example: A user pauses a run. No driver supports native pause. The orchestration layer implements pause as: interrupt the active run, persist conversation history and run state to local SQLite, queue a resume. When the user resumes, a new turn is started with the full saved context. The driver only sees interruptRun followed later by startRun — it never needs to know about pause.`
- `Example: A user steers a Codex run. The orchestration layer calls applyIntervention(type: "steer", payload). The Codex driver supports steer natively via turn/steer and applies it. For a Claude run, applyIntervention returns degraded, and the orchestration layer falls back to queuing the steer content and interrupting the current turn.`
- `Example: A client retries a steer whose response was lost in transit. The retry carries the same clientIdempotencyKey; the daemon finds the persisted intervention row and returns the originally recorded outcome without dispatching the driver a second time. A different steer accidentally reusing that key is rejected as intervention.idempotency_conflict.`

## Implementation Notes

- Keep the contract small but explicit. The runtime should not need provider-name branches to answer common lifecycle questions.
- Contract versioning should allow additive capability expansion without breaking older drivers.
- Resume handle persistence belongs to the runtime binding layer, not the user-facing domain model.

## Pitfalls To Avoid

- Letting provider-native ids replace canonical ids
- Treating missing capability declarations as implicitly supported
- Making the session engine understand transport-specific details such as JSON-RPC framing or stdio protocol

## Acceptance Criteria

- [ ] A new driver can be integrated without changing session or run domain semantics.
- [ ] Unsupported capabilities remain unavailable to the user and cannot be invoked accidentally.
- [ ] Driver recovery failure produces explicit `provider failure` detail and a `RecoveryCondition` (`recovery-needed` or `reauth-required`) rather than silent session replacement.
- [ ] An intervention retried with the same `clientIdempotencyKey` never applies twice: the retry returns the original outcome, and key reuse with a differing payload is rejected.
- [ ] A logged-out provider is detected by the zero-turn `probeAuth` before any billed turn is spent.
- [ ] A successful resume reports the driver's normalized `sessionPosition`; an unparseable CLI version or below-floor provider install refuses attach fail-closed.

## ADR Triggers

- If the runtime stops using a normalized driver interface, create or update `../decisions/005-provider-drivers-use-a-normalized-interface.md`.

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- V1 decision: driver capability and account-state declarations are refreshed **per runtime node on a bounded periodic cadence — 15 minutes in V1** — and may also be updated live where the provider pushes (e.g. Codex `account/rateLimits/updated` push alongside the `account/rateLimits/read` pull; the zero-turn `probeAuth` rides the same refresh). Correctness must not depend on push-only updates.
- V1 decision: the first implementation supports local-runtime-node drivers only. Shared hosted execution drivers are out of scope, even when a local driver talks to a remote provider API.

## References

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Runtime Node Model](../domain/runtime-node-model.md)
- [Run State Machine](../domain/run-state-machine.md)
- [Spec-012: Approvals Permissions And Trust Boundaries](012-approvals-permissions-and-trust-boundaries.md) — execution-posture policy semantics; callback-tool authorization
- [Spec-024: Cross Node Dispatch And Approval](024-cross-node-dispatch-and-approval.md) — the remote-Claude parity mechanism
- [MCP specification 2025-11-25 — Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) — the MUST-strength annotation-trust rule grounding §Tool Metadata
- [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests) and [draft-ietf-httpapi-idempotency-key-header](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/) (expired IETF draft) — the converging idempotency-key practice behind `clientIdempotencyKey`
