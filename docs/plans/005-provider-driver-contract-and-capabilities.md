# Plan-005: Provider Driver Contract And Capabilities

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `005` |
| **Slug** | `provider-driver-contract-and-capabilities` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-005: Provider Driver Contract And Capabilities](../specs/005-provider-driver-contract-and-capabilities.md) |
| **Required ADRs** | [ADR-005](../decisions/005-provider-drivers-use-a-normalized-interface.md), [ADR-011](../decisions/011-generic-intervention-dispatch.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-017](../decisions/017-shared-event-sourcing-scope.md) |
| **Dependencies** | [Plan-001](./001-shared-session-core.md) (consumes migration runner substrate from Phase 3, shipped; consumes branded `SessionId` / `ChannelId` from `packages/contracts/src/session.ts` Phase 2, shipped — the `RunId` brand and `RunIdSchema` are NOT in `session.ts`; they originate in this plan's `provider-driver.ts` per CP-005-6), [Plan-007-partial](./007-local-ipc-and-daemon-control.md) (consumes JSON-RPC client transport `packages/client-sdk/src/transport/jsonRpcClient.ts` Phase 3, shipped; consumes the registry's typed surface for `driver.*` namespace registration per CP-007-6 reciprocal), [Plan-024](./024-rust-pty-sidecar.md) (consumes `PtyHost` contract from `packages/contracts/src/pty-host.ts` Phase 2, shipped) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |
| **References** | [Updated Spec-005](../specs/005-provider-driver-contract-and-capabilities.md) (applyIntervention, the capability-flag matrix — thirteen flags post-B3/B6 (twelve B3 + `cost_cap`), seven as shipped — idempotency_class), [api-payload-contracts.md §Plan-005](../architecture/contracts/api-payload-contracts.md), [error-contracts.md driver-namespace codes](../architecture/contracts/error-contracts.md) |

## Goal

Implement the normalized provider driver contract, capability registry, and runtime binding persistence. Drivers execute within the local daemon as the execution authority (per Spec-005:44); the contract is the boundary between the session domain and provider-specific lifecycles. Phase 4 SDK exposure ships under a dedicated `driver.*` JSON-RPC namespace registered through Plan-007's namespace registry.

## Scope

This plan covers (a) the shared `ProviderDriver` interface + capability-flag schema (seven flags as shipped; twelve post-B3, thirteen with B6's `cost_cap`, via the campaign code leg) + per-tool `idempotency_class` metadata, (b) the in-daemon provider registry + runtime-binding persistence (`runtime_bindings`, `driver_capabilities` SQLite tables), (c) two initial drivers (Codex, Claude) implemented against the contract as local-runtime-node integrations, (d) capability refresh + recovery-aware binding storage extension points, and (e) typed SDK exposure of capability + intervention surfaces with degraded-fallback semantics (`status: "applied" | "degraded"`).

## Non-Goals

- Multi-agent workflow semantics (Plan-009)
- Provider-specific UI tuning beyond capability exposure (out-of-scope for V1)
- Support for every future provider in the first pass (post-V1)
- Shared hosted execution drivers — drivers execute within the local daemon per Spec-005:44 + ADR-005

## Preconditions

- [x] Paired spec is approved (campaign B3 note, 2026-07-05: Spec-005 is temporarily `review` for the amendment window — this box records the Tier-4 audit-time state; code dispatch for amendment surfaces stays blocked until the campaign's Task-28 batch re-promotion restores `approved`)
- [x] Required ADRs are accepted (verified: ADR-005 `accepted`, ADR-011 `accepted`, ADR-015 `accepted`, ADR-017 `accepted`)
- [x] Blocking open questions are resolved or explicitly deferred
- [x] Plan-001 Phase 3 migration runner shipped
- [x] Plan-001 Phase 2 branded-id contracts shipped
- [x] Plan-024 Phase 2 `PtyHost` contract shipped
- [x] Plan-007-partial Phase 3 JSON-RPC client transport shipped
- [x] **Plan-readiness audit complete per [`docs/operations/plan-implementation-readiness-audit-runbook.md`](../operations/plan-implementation-readiness-audit-runbook.md)** — Tier 4 audit (NS-16 / PR #124), ratified 2026-05-27; see [Status Promotion Gate §1](../operations/plan-implementation-readiness-audit-runbook.md#status-promotion-gate).

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

Phase 1 (contracts):

- `packages/contracts/src/provider-driver.ts` — typed `ProviderDriver` interface + 7-flag `DriverCapabilityFlag` literal-union + `DriverCapabilities` shape ({flags, contractVersion}) + `IdempotencyClass` enum + `ProviderToolMetadataSchema` with `ProviderToolMetadata` (ingress `z.input`) + `NormalizedProviderToolMetadata` (`z.output`) shapes + `GetCapabilitiesResult` wrapper ({capabilities, tools}) + `ApplyInterventionParams` + `DriverInterventionResultSchema` (Zod) + `DriverResumeResultSchema` (Zod discriminated union)

Phase 2 (runtime persistence):

- `packages/runtime-daemon/src/provider/provider-registry.ts` — in-daemon registry + capability cache
- `packages/runtime-daemon/src/provider/runtime-binding-store.ts` — `runtime_bindings` SQLite CRUD (Plan-005 owns; Plan-015 extends per CP-005-1)
- `packages/runtime-daemon/src/provider/driver-capabilities-writer.ts` — `driver_capabilities` SQLite writer
- `packages/runtime-daemon/src/migrations/0003-runtime-bindings.ts` — SQLite migration (+ `packages/runtime-daemon/src/session/migration-runner.ts` version-3 guarded-block registration)

Phase 3 (driver implementations):

- `packages/runtime-daemon/src/provider/drivers/codex/index.ts` — Codex driver entry
- `packages/runtime-daemon/src/provider/drivers/codex/lifecycle.ts` — createSession / resumeSession / startRun / interruptRun / closeSession
- `packages/runtime-daemon/src/provider/drivers/codex/intervention.ts` — applyIntervention generic dispatcher (steer / interrupt / cancel)
- `packages/runtime-daemon/src/provider/drivers/codex/capabilities.ts` — capability declaration + refresh
- `packages/runtime-daemon/src/provider/drivers/codex/tools.ts` — per-tool `idempotency_class` metadata
- `packages/runtime-daemon/src/provider/drivers/codex/event-normalizer.ts` — provider-native → normalized event mapping
- `packages/runtime-daemon/src/provider/drivers/claude/{index,lifecycle,intervention,capabilities,tools,event-normalizer}.ts` — symmetric file layout

Phase 4 (SDK exposure):

- `packages/runtime-daemon/src/ipc/handlers/driver-handlers.ts` — daemon-side `driver.*` JSON-RPC handlers (7 client-facing: 6 non-lifecycle verbs + `driver.subscribeEvents`; the 4 session/run lifecycle ops are daemon-internal, orchestration-invoked — see §Phase 4 decision #2)
- `packages/client-sdk/src/providerClient.ts` — `createDaemonProviderClient(JsonRpcClient): DriverClient` factory
- `packages/client-sdk/src/providerClient.test.ts` — SDK conformance + degraded-fallback unit tests

## Data And Storage Changes

Four SQLite tables ship in Phase 2 (Plan-005-owned per cross-plan-dependencies.md §1):

- `runtime_bindings` — persists driver-instance ↔ session/run bindings. **Campaign forward-note (B6, 2026-07-06):** the campaign's Plan-005 bundle also adds the driver-boundary subagent emitter/normalizer task — `subagent.started` / `subagent.completed` appends per the Plan-006 event-coverage registry's single-owner assignment; Plan-016's native-subagent governor consumes those rows and is gated on that task. Plan-015 extends with recovery-aware persistence methods (per CP-005-1; row-level recovery state lives in Plan-015's dedicated `recovery_checkpoints` table, not on `runtime_bindings`).
- `driver_capabilities` — caches the capability-flag matrix per active driver instance (seven flags as shipped; the campaign B3 amendment widened the canonical CHECK to twelve and B6 adds `cost_cap` (thirteen) — one catch-up migration on the campaign code leg), refreshed on capability change events.
- `driver_tools` — per-tool metadata keyed `(driver_name, tool_name)`, persisting each tool's `idempotency_class` so the daemon's two-phase command-receipt protocol (Spec-005:178-180) resolves crash-recovery dispatch class without round-tripping the driver. T2.4 hydrates it into `listCapabilities()` after restart.
- `driver_contract_meta` — per-driver parent row (`driver_name` PK) holding the advertised `contract_version` that cold-start cache hydration (T2.4) reconstructs into `GetCapabilitiesResult.capabilities.contractVersion` without round-tripping the driver (the cache-as-source-of-truth path). (Campaign B3 amendment, 2026-07-05: the canonical table additionally caches the `cli_version_raw`/`cli_version_semver` pair; hydration treats a NULL pair as a cache miss and refreshes from the driver, since the now-required `GetCapabilitiesResult.cliVersion` is never fabricated — the column/return-shape migration is the campaign code leg.)

See [Local SQLite Schema §Driver and Runtime Binding Tables](../architecture/schemas/local-sqlite-schema.md#driver-and-runtime-binding-tables-plan-005) for column definitions (all four rows carry the `Owner: Plan-005` annotation).

## API And Transport Changes

- Add typed driver capability + driver runtime events to the client SDK under a dedicated `driver.*` JSON-RPC namespace registered through Plan-007's namespace registry (per CP-007-6 reciprocal).
- Define the internal driver interface for 10 operations (canonical long-form names per [api-payload-contracts.md:614](../architecture/contracts/api-payload-contracts.md) `interface ProviderDriver`): `createSession`, `resumeSession`, `startRun`, `interruptRun`, `applyIntervention`, `respondToRequest`, `closeSession`, `listModels`, `listModes`, `getCapabilities`.
- Add three driver-namespace error codes to the JSON-RPC error registry (already present at [error-contracts.md](../architecture/contracts/error-contracts.md) lines 312-314): `driver.unavailable` (503), `driver.capability_unsupported` (400 — note that this is the SDK seam's wire-error for invocation of an undeclared capability, distinct from the per-call `degraded` status returned by `applyIntervention` per Spec-005:46; the two are not in conflict — `driver.capability_unsupported` covers the static "this driver does not support that capability at all" gate, `degraded` covers the dynamic "this intervention type is not supported but a fallback action is available" outcome). (Campaign B3 note, 2026-07-06: the driver namespace now also carries the three fail-closed admission codes — `driver.cli_version_unparseable`, `driver.cli_version_below_floor`, `driver.not_authenticated` ([error-contracts.md](../architecture/contracts/error-contracts.md) lines 315-317, all 409) — mapped and tested at this same Phase-4 seam by the campaign code leg.)
- SDK seam Zod schemas: `DriverInterventionResultSchema = z.object({ status: z.enum(['applied', 'degraded']), fallbackAction: z.string().optional() })` (per Phase 4 ratified envelope shape; see Phase 4 below).
- SDK factory pattern: daemon-only `createDaemonProviderClient(JsonRpcClient): DriverClient`. No control-plane variant per Spec-005:44 (drivers are local-daemon-resident; no V1.1 remote-provider workflow on roadmap).

## Implementation Phase Sequence

### Phase 1 — Driver contract + capability schema + idempotency_class

**Goal:** Author the typed driver-contract surface (10-op interface + 7-flag capability schema + per-tool `idempotency_class` metadata + `ApplyInterventionParams` + Zod-validated `DriverInterventionResult` shape).

#### Tasks

- **T1.1** — Author the 10-operation `ProviderDriver` interface in `packages/contracts/src/provider-driver.ts`.
  - Files: `packages/contracts/src/provider-driver.ts` (new)
  - Spec coverage: Spec-005:43 (normalized contract), :45 (10-op surface), :77 (Required driver operations anchor)
  - Verifies invariant: I-005-1 (driver authority remains local)
  - Consumes: `SessionId` / `ChannelId` from `packages/contracts/src/session.ts` (Plan-001 Phase 2, Tier 1 — shipped); `PtyHost` contract from `packages/contracts/src/pty-host.ts` (Plan-024 Phase 2, Tier 1 — shipped); typed shape at api-payload-contracts.md:614 (`interface ProviderDriver`)
  - Provides: the 10-op `ProviderDriver` interface **and** the `type RunId` brand (`string & { readonly __brand: "RunId" }`), co-located in `provider-driver.ts` per CP-005-6. `RunId` is NOT consumed from `session.ts` (Plan-001 ships no run-domain symbol); its lowest-tier consumer is this Plan-005 (Tier 4 — the `ProviderDriver` method params `startRun` / `interruptRun` / `applyIntervention` / `respondToRequest`), so it originates here. The paired `RunIdSchema` co-locates at T4.2 (its first consumer, `InterruptRunParamsSchema`); this task ships the `type` only.
  - Canonical method names (long-form): `createSession`, `resumeSession`, `startRun`, `interruptRun`, `applyIntervention`, `respondToRequest`, `closeSession`, `listModels`, `listModes`, `getCapabilities`
  - Non-trivial return shapes (authored in companion tasks): `resumeSession` → `Promise<DriverResumeResult>` (T1.6); `applyIntervention` → `Promise<DriverInterventionResult>` (T1.4); `getCapabilities` → `Promise<GetCapabilitiesResult>` (T1.3).
  - Estimate: 1 PR

- **T1.2** — Author the 7-flag `DriverCapabilityFlag` literal-union type and `DriverCapabilities` shape in `packages/contracts/src/provider-driver.ts`.
  - Files: `packages/contracts/src/provider-driver.ts` (extend T1.1)
  - Spec coverage: Spec-005:54 (7-flag enumeration + `pause` exclusion rationale per ADR-011), :56 (undeclared = unsupported)
  - Verifies invariant: I-005-2 (undeclared capability = unsupported)
  - Consumes: api-payload-contracts.md:175 (`type DriverCapabilityFlag` anchor), :873 (`interface DriverCapabilities` anchor)
  - Flags (7): `resume`, `steer`, `interactive_requests`, `mcp`, `tool_calls`, `reasoning_stream`, `model_mutation`. `pause` is intentionally excluded per Spec-005:54 + ADR-011.
  - Estimate: 1 PR (combined with T1.1)

- **T1.3** — Author the per-tool `IdempotencyClass` enum, `ProviderToolMetadata` shape, and `GetCapabilitiesResult` wrapper in `packages/contracts/src/provider-driver.ts`. Keep `DriverCapabilities` semantically pure (`{flags, contractVersion}`); introduce `GetCapabilitiesResult` as the typed return of `getCapabilities()` so per-tool metadata travels alongside whole-driver capability flags in a single round-trip without conflating the two concepts.
  - Files: `packages/contracts/src/provider-driver.ts` (extend T1.1/T1.2); `docs/architecture/contracts/api-payload-contracts.md` (doc-mirror update at line 895 — leave `interface DriverCapabilities` shape unchanged; add new `interface ProviderToolMetadata` (ingress) + `interface NormalizedProviderToolMetadata` (normalized) + `interface GetCapabilitiesResult` shapes immediately after)
  - Spec coverage: Spec-005:57 (three-value enum required), :160-162 (semantic separation between Driver capabilities and Tool metadata), :172 (`manual_reconcile_only` conservative default); Spec-015:112 (`### Idempotency Classes and Recovery Behavior` — recovery dispatch consumer), Spec-015:124 (`manual_reconcile_only` recovery-needed handoff)
  - Verifies invariant: I-005-3 (undeclared `idempotency_class` defaults to `manual_reconcile_only`)
  - Consumes: Spec-005 §Tool Metadata anchor; Spec-015 §Idempotency Protocol
  - Provides: `IdempotencyClass = "idempotent" \| "compensable" \| "manual_reconcile_only"`; `ProviderToolMetadataSchema = z.object({ name: z.string(), idempotency_class: IdempotencyClassSchema.optional().default("manual_reconcile_only"), description: z.string().optional() })`; `ProviderToolMetadata = z.input<typeof ProviderToolMetadataSchema>` (INGRESS — `idempotency_class` OPTIONAL: what a driver declares via `getCapabilities()`; an omitting driver is accepted, NOT rejected, since a required field would reject a conformant-but-silent driver before the default could apply per Spec-005:174); `NormalizedProviderToolMetadata = z.output<typeof ProviderToolMetadataSchema>` (NORMALIZED — `idempotency_class` REQUIRED after the schema's `.default("manual_reconcile_only")` applies at parse time; the only tool-metadata shape that crosses the persistence / event-payload boundary, so the type system forbids persisting or emitting an un-normalized value); `GetCapabilitiesResult = { capabilities: DriverCapabilities; tools: ProviderToolMetadata[] }` (ingress wrapper — semantically aligned with Spec-005:162-164 and MCP 2026 / LSP capability-vs-tool-list separation precedent)
  - Modern-precedent rationale: MCP 2026-07-28 release candidate separates `initialize` server-capabilities response from `tools/list` request; LSP separates `ServerCapabilities` from registered tool surfaces. The wrapper return preserves the 10-op interface count from Spec-005:77 while honoring the two-concept separation.
  - Estimate: 1 PR

- **T1.4** — Author `ApplyInterventionParams` + Zod-validated `DriverInterventionResultSchema` in `packages/contracts/src/provider-driver.ts`.
  - Files: `packages/contracts/src/provider-driver.ts` (extend T1.1)
  - Spec coverage: Spec-005:46 (generic dispatcher + degraded-fallback contract); ADR-011 (generic intervention dispatch)
  - Verifies invariant: I-005-4 (`applyIntervention` returns `degraded` for unsupported intervention types)
  - Consumes: api-payload-contracts.md:681 (`type ApplyInterventionParams` anchor), :701 (`interface DriverInterventionResult` anchor), :149 (cross-cutting `InterventionType` enum — resolution: co-locate the `InterventionType` re-export in `provider-driver.ts` since Plan-004's `runControl.ts` ships at Tier 5; Plan-004 imports the enum from Plan-005 at Tier 4)
  - Provides: `DriverInterventionResultSchema = z.object({ status: z.enum(['applied', 'degraded']), fallbackAction: z.string().optional() })`; `DriverInterventionResult = z.infer<typeof DriverInterventionResultSchema>` (Zod-validated wire envelope per Phase 4 ratified shape; distinct from orchestration `InterventionState` lifecycle enum per LSP/MCP separation-of-concerns precedent)
  - Estimate: 1 PR

- **T1.5** — Author contract-conformance test scaffolding in `packages/contracts/src/__tests__/provider-driver.test.ts`.
  - Files: `packages/contracts/src/__tests__/provider-driver.test.ts` (new)
  - Spec coverage: Spec-005 AC1 (Spec-005:204 — type-only conformance: a mock driver implementing the interface should compile and not require session-domain changes); Spec-005 AC2 (Spec-005:205 — capability-flag exhaustiveness: a flag not in the 7-flag enum should produce a type error)
  - Verifies invariant: I-005-1, I-005-2, I-005-3, I-005-4, I-005-5
  - Notes: Phase 1 tests are type-system tests + a minimal mock-driver scaffold. Behavioral conformance tests (resume-handle round-trip, capability refresh) ship in Phase 2-3. Type-level enforcement of I-005-5 is verified here: a mock driver whose `resumeSession` returns `void` on the failure path must produce a TS compile error against the T1.6 `DriverResumeResult` discriminated-union return type.
  - Estimate: 1 PR

- **T1.6** — Author the `DriverResumeResult` discriminated-union return shape for `resumeSession()` in `packages/contracts/src/provider-driver.ts`. Pattern matches existing `DriverInterventionResult` (T1.4): a `status`-discriminated union with explicit success and failure variants, validated via Zod.
  - Files: `packages/contracts/src/provider-driver.ts` (extend T1.1/T1.4); `docs/architecture/contracts/api-payload-contracts.md` (doc-mirror — add `interface DriverResumeResult` near the existing `DriverInterventionResult` shape)
  - Spec coverage: Spec-005:69 (resume-handle failure surfaces `provider failure` detail + `recovery-needed` condition; MUST NOT silently create replacement provider session); Spec-005:206 (AC3)
  - Verifies invariant: I-005-5 (the discriminated-union shape makes silent-replacement structurally inexpressible — the failure variant has no `bindingId` field, so a successful resume cannot be conflated with a failed one)
  - Consumes: T1.1 `resumeSession` signature anchor; api-payload-contracts.md:718 `interface DriverInterventionResult` precedent (sibling shape)
  - Provides: `DriverResumeResultSchema = z.discriminatedUnion('status', [z.object({ status: z.literal('resumed'), bindingId: z.string() }), z.object({ status: z.literal('failed'), recoveryCondition: z.literal('recovery-needed'), providerFailureDetail: z.string() })])`; `DriverResumeResult = z.infer<typeof DriverResumeResultSchema>`. `resumeSession()` signature becomes `(handle: string) => Promise<DriverResumeResult>` rather than the (Spec-005-silent) implicit throw-on-failure pattern. Timestamps live on `runtime_bindings.updated_at` (T2.1); the result shape carries only the discriminated-union semantic payload.
  - Modern-precedent rationale: Discriminated-union result types (success | failure) over thrown exceptions for expected-failure paths — the pattern used by Rust's `Result<T,E>` and by API SDKs that prefer structured error responses (Stripe SDK, AWS SDK) over throwing. Matches existing `DriverInterventionResult` (`{status: 'applied' | 'degraded'}`) precedent in this contract.
  - Estimate: 1 PR (combined with T1.4 since both author Zod-validated result discriminated unions)

**Phase 1 Acceptance Mapping:** T1.5 → Spec-005:204 (AC1) + Spec-005:205 (AC2). AC3 (Spec-005:206 — recovery-needed) is verified in Phase 3 (T3.1 Codex / T3.6 Claude lifecycle resume-failure tests) where `resumeSession()` returns the structured failure result, and in Phase 4 (T4.7 return-value contract test).

### Phase 2 — Provider registry + runtime-binding store + SQLite

**Goal:** Author the in-daemon provider registry, the `RuntimeBindingStore` CRUD class, the `driver_capabilities` cache writer, and the SQLite migration that materializes the two tables.

#### Tasks

- **T2.1** — Author the SQLite migration creating `runtime_bindings` + `driver_capabilities`.
  - Files: `packages/runtime-daemon/src/migrations/0003-runtime-bindings.ts` (new; `0003` is the next free migration number — `0001-initial.ts` + `0002-runtime-node.ts` are the only existing migrations); `packages/runtime-daemon/src/session/migration-runner.ts` (modify — register the version-3 guarded block: import the new SQL constant and add a `hasMigrationApplied(db, 3)` `db.transaction(...).immediate()` block mirroring the version-1/2 blocks. The runner is a hand-written per-version guarded sequence, deliberately NOT a registry loop — see its module docstring — so a new migration module is dead code until registered here; without this edit the migration never executes); `docs/architecture/schemas/local-sqlite-schema.md` (verify column definitions match the `runtime_bindings` block at lines 156-171 under the `## Driver and Runtime Binding Tables (Plan-005)` header at line 145)
  - Spec coverage: Spec-005:45 (driver-contract operations imply persistence of provider session handles), :55 (drivers persist provider-owned resume handles separately from canonical ids)
  - Verifies invariant: — (migration is structural; invariants apply at runtime)
  - Consumes: Plan-001 Phase 3 migration runner (`packages/runtime-daemon/src/session/migration-runner.ts`, shipped — `applyMigrations` hand-written per-version guarded blocks + `openDatabase` canonical handle factory)
  - Provides: `runtime_bindings` table (`id` TEXT PK, `run_id` TEXT NOT NULL, `driver_name` TEXT NOT NULL, `contract_version` TEXT NOT NULL, `resume_handle` TEXT nullable, `runtime_metadata` TEXT NOT NULL DEFAULT `'{}'`, `created_at` TEXT NOT NULL, `updated_at` TEXT NOT NULL; index `idx_runtime_bindings_run` on `run_id`) + `driver_capabilities` table (`driver_name` TEXT NOT NULL, `capability_flag` TEXT NOT NULL CHECK IN (`'resume'`, `'steer'`, `'interactive_requests'`, `'mcp'`, `'tool_calls'`, `'reasoning_stream'`, `'model_mutation'`), `supported` INTEGER NOT NULL DEFAULT 0, `refreshed_at` TEXT NOT NULL, PRIMARY KEY (`driver_name`, `capability_flag`)) + `driver_tools` table (`driver_name` TEXT NOT NULL, `tool_name` TEXT NOT NULL, `idempotency_class` TEXT NOT NULL CHECK IN (`'idempotent'`, `'compensable'`, `'manual_reconcile_only'`), `description` TEXT nullable, `refreshed_at` TEXT NOT NULL, PRIMARY KEY (`driver_name`, `tool_name`)) + `driver_contract_meta` table (`driver_name` TEXT PRIMARY KEY, `contract_version` TEXT NOT NULL, `refreshed_at` TEXT NOT NULL). Migration matches canonical [local-sqlite-schema.md §Driver and Runtime Binding Tables](../architecture/schemas/local-sqlite-schema.md#driver-and-runtime-binding-tables-plan-005) exactly for `runtime_bindings` + `driver_capabilities` as shipped (campaign B3 note, 2026-07-05: the canonical block has since gained the `cli_version_raw`/`cli_version_semver` pair on `runtime_bindings` + `driver_contract_meta` and widened the `capability_flag` CHECK to the twelve-flag union, thirteen with B6's `cost_cap` — the catch-up migration is the campaign code leg, so migration 0003 matches the pre-B3 canonical); `driver_tools` is the new co-owned per-tool-metadata surface (crash-recovery `idempotency_class` lookup per Spec-005:178-180 cannot round-trip the driver, so per-tool `idempotency_class` is persisted as normalized per-tool rows rather than a JSON blob — `(driver_name, tool_name)` composite PK mirrors the `(driver_name, capability_flag)` shape of `driver_capabilities`); `driver_contract_meta` is the per-driver parent holding the single `contract_version` that cold-start hydration (T2.4) needs to reconstruct `GetCapabilitiesResult.capabilities.contractVersion` without round-tripping the driver — kept out of `driver_capabilities` to avoid denormalizing the version across the per-flag rows, and distinct from the per-run `runtime_bindings.contract_version`. No FK to non-existent local `sessions` table (sessions is shared-Postgres-only per [shared-postgres-schema.md:43](../architecture/schemas/shared-postgres-schema.md)); session-level lookups compose the caller-supplied active-run ids (Plan-004's event-sourced run-state projection — there is no `runs` table) with the store's `findByRuns(runIds)` per the T2.2 seam below, intersected with the process supervisor's live provider-process registry — the liveness authority (`runtime_bindings` persists no liveness by design: a persisted flag would claim live across a daemon crash; superseded pre-relaunch rows never enumerate).
  - Note: `recovery_state` / `recovery_needed` columns do NOT belong on `runtime_bindings` — Plan-015 owns the `recovery_checkpoints` table at `local-sqlite-schema.md:1096` for row-level recovery state per CP-005-1 (recovery-aware persistence extension contract). Plan-005's invariant I-005-5 (resume-failure surfaces recovery-needed) is satisfied via a typed return-value contract from `resumeSession()` (T3.1, T3.6), which Plan-015's recovery dispatcher consumes and surfaces on the existing `run.failed` event with `recoveryCondition: 'recovery-needed'` per Spec-006:186 — no separate driver event, no persisted column state.
  - **Provider-output validation obligation (deferred from Phase 1 per the contract trust-boundary principle).** Phase 1 ships `DriverCapabilities` / `ProviderSessionHandle` as nominal TypeScript (no contract-level invariant forces a Zod schema at the contract-definition layer — see the trust-boundary §1 principle in `packages/contracts/src/provider-driver.ts`: every provider-output return without a contract-level invariant/normalization is bounded at its write/normalize seam, not at the contract layer). Therefore the Phase-2 write seam MUST bound these two persisted provider-output fields before they reach storage / events: (1) `contract_version` validated as **semver + length-bounded** (the canonical schema doc types it semver at [local-sqlite-schema.md:228](../architecture/schemas/local-sqlite-schema.md) — `contract_version TEXT NOT NULL, -- semver of the driver's advertised capability contract`); (2) `resume_handle` validated **non-empty + length-bounded + NUL-rejecting**. Enforce via a DB CHECK constraint authored here in T2.1 and/or a write-path Zod guard at T2.4 — mirroring the `wireFreeFormString` defense-in-depth (length + non-whitespace + NUL-rejection) that Phase 1 already applies to the `driver_tools` provider-declared strings. This converts the Phase-1 F1/F3 deferral into a criterion-gated Phase-2 obligation; it is NOT a contract-layer schema and must not be added to `provider-driver.ts`.
  - Estimate: 1 PR

- **T2.2** — Author `RuntimeBindingStore` CRUD class.
  - Files: `packages/runtime-daemon/src/provider/runtime-binding-store.ts` (new)
  - Spec coverage: Spec-005:55 (provider-owned resume handles persisted separately from session/run ids)
  - Verifies invariant: I-005-1 (driver authority local — store is daemon-resident)
  - Consumes: T2.1 migration; better-sqlite3 client (existing in `packages/runtime-daemon/src/session/`)
  - Provides: `RuntimeBindingStore` with methods `create(input)`, `findById(id)`, `findByRun(runId)`, `update(id, patch)`, `delete(id)`. `runtime_bindings` has no `session_id` column and no liveness column per canonical schema, and run state is event-sourced (no `runs` table to join) — so session-level resolution is a composition: the caller supplies the session's active run ids from the daemon's run-state projection, and the store owns **`findByRuns(runIds)`** (campaign B6, 2026-07-06; the batch form of `findByRun`) returning their binding rows — daemon-local by design: it feeds Plan-016 T2.10's local synchronous ack barrier (live legs = bindings of active runs; legs on other runtime nodes converge via Spec-016's goal-at-turn-dispatch precondition), an owned API so all-or-nothing delivery is never built on persona rows or ad-hoc queries. Code mirror: the shipped store exposes `findByRun` only — the batch method lands with the campaign's Plan-005 bundle, and Plan-016 T2.10's code dispatch is gated on it (same gate as the driver goal methods). Extension points for Plan-015 per CP-005-1 are declared as public-but-not-overridden method seams (e.g., `findResumableBindings(...)` is intentionally exposed as a queryable surface that Plan-015 extends with recovery-aware predicates).
  - Estimate: 1-2 PRs

- **T2.3** — Author `ProviderRegistry` class.
  - Files: `packages/runtime-daemon/src/provider/provider-registry.ts` (new)
  - Spec coverage: Spec-005:43 (every provider integration must implement a normalized driver contract), :56 (runtime treats undeclared capabilities as unsupported)
  - Verifies invariant: I-005-2 (undeclared capability = unsupported — enforced by registry capability check)
  - Consumes: T1.1-T1.4 contracts; T2.2 RuntimeBindingStore
  - Provides: `ProviderRegistry` with `register(driverInstance)`, `lookup(driverId)`, `checkCapability(driverId, flag)`, `listAvailable()`. Registry enforces capability-flag gating ONLY for direct capability-bound methods (e.g. a future `driver.steer` direct entrypoint, or `driver.getCapabilities` itself when called against an unregistered driver) — `applyIntervention` is **excluded from pre-dispatch gating** because its intervention-type-aware degraded-fallback per [ADR-011](../decisions/011-generic-intervention-dispatch.md) must reach the driver to return `{ status: 'degraded', fallbackAction }` (Spec-005:46). Direct capability-bound calls against undeclared flags throw `driver.capability_unsupported` (error-contracts.md:313) before reaching the driver; `applyIntervention` reaches the driver regardless of `(type → capability flag)` mapping so the driver-side dispatcher can return the typed degraded envelope (T3.7 verifies this for Claude `steer: false`).
  - Estimate: 1 PR

- **T2.4** — Author `driver_capabilities` cache writer logic.
  - Files: `packages/runtime-daemon/src/provider/driver-capabilities-writer.ts` (new); `packages/contracts/src/provider-driver.ts` (modify — hoist the existing `DriverCapabilityFlag` union to a runtime `DRIVER_CAPABILITY_FLAGS` `as const`, re-deriving the union via `(typeof DRIVER_CAPABILITY_FLAGS)[number]`, so the write-seam guard, migration-0003 CHECK, and integration fixtures share one canonical flag source (7 flags as shipped; the campaign B3 amendment widened the canonical union to twelve and B6 adds `cost_cap` (thirteen) — the code-side re-derivation rides the campaign code leg). Contract-preserving type-companion refactor of an already-shipped declaration — byte-equivalent union, NOT a provider-output Zod schema; the `assertValidCapabilityFlags` guard stays at the write seam in `provider-output-validation.ts` per the T2.1 provider-output validation obligation)
  - Spec coverage: Spec-005:56 (undeclared capabilities = unsupported — drives the cache-as-source-of-truth pattern); ADR-005 (normalized driver interface)
  - Verifies invariant: I-005-2
  - Consumes: T1.2 DriverCapabilities shape; T2.1 `driver_capabilities` + `driver_tools` + `driver_contract_meta` tables; T2.3 ProviderRegistry
  - Provides: Writes per-driver capability data on driver registration + on capability-refresh events, in one transaction across THREE per-driver-keyed tables: (1) per-flag rows to `driver_capabilities` (one row per `DriverCapabilityFlag` enum value with `supported INTEGER 0/1` and `refreshed_at`; thirteen values post-B3/B6, seven as shipped); (2) per-tool rows to `driver_tools` (one row per `NormalizedProviderToolMetadata` — the post-`.default()` shape, since the NOT NULL `idempotency_class` CHECK-enum column structurally rejects an un-normalized value — plus optional `description` and `refreshed_at`) so the daemon's two-phase command-receipt protocol (Spec-005:178-180) can read `idempotency_class` at crash-recovery dispatch time without round-tripping the driver; (3) ONE row to `driver_contract_meta` (`driver_name` PK, `contract_version`, `refreshed_at`) holding the driver's advertised capability-contract version. The contract version lives in its own per-driver table — NOT denormalized across the per-flag `driver_capabilities` rows, and distinct from `runtime_bindings.contract_version` (which is the version bound to a specific RUN, not the driver's advertised cache version). Reads on cold-start cache hydration join all three tables keyed by `driver_name` to reconstruct `GetCapabilitiesResult = { capabilities: { flags, contractVersion }, tools: ProviderToolMetadata[] }` — `contractVersion` comes from `driver_contract_meta`, so `listCapabilities()` returns the advertised version after a daemon restart WITHOUT round-tripping the driver (the cache-as-source-of-truth path; campaign B3 adds the cached `cliVersion` pair to that reconstruction, with a NULL pair treated as a cache miss). Refresh trigger emits `runtime_node.capability_updated` event per Spec-006:413 (existing event surface; payload `previousState` / `newState` carry the reconstructed wrapper-shape contents) — see CP-005-5.
  - Estimate: 1 PR

- **T2.5** — Author Phase 2 integration tests (RuntimeBindingStore + ProviderRegistry + capability-writer round-trip).
  - Files: `packages/runtime-daemon/src/provider/__tests__/phase-2-integration.test.ts` (new)
  - Spec coverage: Spec-005:56 (capability gating); Spec-005:55 (resume-handle persistence)
  - Verifies invariant: I-005-1, I-005-2
  - Notes: Tests use the real SQLite client (better-sqlite3 in-memory) per the no-mock-database policy (test-engineering memory). Migration applied at test setup.
  - Estimate: 1 PR

**Phase 2 Acceptance Mapping:** T2.5 → Spec-005:205 (AC2 — capability gating verified end-to-end against a real registry + store).

### Phase 3 — Codex + Claude driver implementations

**Goal:** Implement the two initial drivers (Codex, Claude) against the Phase 1 contract. Both drivers execute as local-runtime-node integrations per Spec-005:44 (no shared hosted driver service). Codex consumes the Plan-024 `PtyHost` contract for terminal-attached lifecycle.

**Driver capability matrix (V1 declared values per Spec-005 §Per-Driver Capability Matrix):**

| Capability             | Codex   | Claude  |
| ---------------------- | ------- | ------- |
| `resume`               | `true`  | `true`  |
| `steer`                | `true`  | `false` |
| `interactive_requests` | `true`  | `true`  |
| `mcp`                  | `true`  | `true`  |
| `tool_calls`           | `true`  | `true`  |
| `reasoning_stream`     | `false` | `true`  |
| `model_mutation`       | `false` | `true`  |
| `structured_output`    | `true`  | `true`  |
| `rollback`             | `true`  | `true`  |
| `session_goals`        | `true`  | `true`  |
| `callback_tools`       | `true`  | `true`  |
| `subagents`            | `true`  | `true`  |
| `cost_cap`             | `false` | `true`  |

`pause` is intentionally absent from both — orchestration-layer construct per Spec-005:54. The six campaign rows above (five B3 + B6's `cost_cap`) mirror the Spec-005 matrix; their driver declaration + refusal tests land with the campaign's Plan-005 bundle's driver tasks (Claude `cost_cap: true` via `--max-budget-usd`, Codex `false` fail-closed for native-cap admissions).

#### Tasks

- **T3.1** — Author Codex driver entry + lifecycle methods.
  - Files: `packages/runtime-daemon/src/provider/drivers/codex/index.ts` (new), `packages/runtime-daemon/src/provider/drivers/codex/lifecycle.ts` (new)
  - Spec coverage: Spec-005:45 (10-op contract surface); Spec-005:69 (resume-handle failure surfaces recovery-needed condition — AC3)
  - Verifies invariant: I-005-5 (resume-failure returns typed `recovery-needed` condition; no silent session replacement)
  - Consumes: T1.1 ProviderDriver interface; Plan-024 PtyHost contract from `packages/contracts/src/pty-host.ts` (Tier 1, shipped); Codex /resume substrate (PtyHost-based persistent process)
  - Provides: `createSession`, `resumeSession`, `startRun`, `interruptRun`, `closeSession` for Codex
  - Estimate: 2 PRs

- **T3.2** — Author Codex intervention dispatcher.
  - Files: `packages/runtime-daemon/src/provider/drivers/codex/intervention.ts` (new)
  - Spec coverage: Spec-005:46 (generic dispatcher + degraded-fallback); ADR-011 (generic intervention dispatch)
  - Verifies invariant: I-005-4 (degraded result for unsupported intervention types)
  - Consumes: T1.4 ApplyInterventionParams + DriverInterventionResultSchema; T1.2 capability flags
  - Provides: `applyIntervention(params)` for Codex — routes to native steer/interrupt/cancel handlers; returns `{ status: 'degraded', fallbackAction: 'queue_and_interrupt' }` when an intervention type maps to a capability flag the driver declared `false` (Codex declares all three intervention-relevant flags `true`; the degraded path is exercised more in T3.7 Claude where `steer: false`).
  - Estimate: 1 PR

- **T3.3** — Author Codex capability declaration + refresh.
  - Files: `packages/runtime-daemon/src/provider/drivers/codex/capabilities.ts` (new)
  - Spec coverage: Spec-005:54 (7-flag declaration); :56 (undeclared = unsupported)
  - Verifies invariant: I-005-2
  - Consumes: T1.2 DriverCapabilities; T1.3 GetCapabilitiesResult wrapper; T2.4 driver_capabilities writer
  - Provides: `getCapabilities()` for Codex returning the V1 `GetCapabilitiesResult` wrapper with declared capability flags (matrix above) + Codex-declared per-tool metadata array. Refresh trigger emits `runtime_node.capability_updated` event per Spec-006:413 (existing event surface; payload `previousState` / `newState` carry the wrapper-shape contents) — see CP-005-5.
  - Estimate: 1 PR

- **T3.4** — Author Codex per-tool metadata declaration.
  - Files: `packages/runtime-daemon/src/provider/drivers/codex/tools.ts` (new)
  - Spec coverage: Spec-005:57 (per-tool idempotency_class required), :172 (manual_reconcile_only conservative default)
  - Verifies invariant: I-005-3
  - Consumes: T1.3 IdempotencyClass + ProviderToolMetadata
  - Provides: Codex tool list with explicit `idempotency_class` annotations (any tool not annotated defaults to `manual_reconcile_only` per I-005-3)
  - Estimate: 1 PR

- **T3.5** — Author Codex event normalizer.
  - Files: `packages/runtime-daemon/src/provider/drivers/codex/event-normalizer.ts` (new)
  - Spec coverage: Spec-005:53 (drivers emit normalized runtime events, not provider-native types); :91-97 (required normalized event families)
  - Verifies invariant: — (normalization is structural; family-level coverage verified by Plan-006 taxonomy tests)
  - Consumes: Plan-006 normalized event-family contract (`packages/contracts/src/event.ts`, Tier 1 — shipped)
  - Provides: Mapping from Codex-native event types to Plan-006 normalized families (`run_lifecycle`, `assistant_output`, `tool_activity`, `interactive_request`, `artifact_publication`, `usage_telemetry`)
  - Estimate: 1-2 PRs

- **T3.6** through **T3.10** — Symmetric tasks for Claude driver (`drivers/claude/{index,lifecycle,intervention,capabilities,tools,event-normalizer}.ts`). Claude declares `steer: false` per the V1 capability matrix — T3.7 (Claude intervention dispatcher) exercises the degraded-fallback path: `applyIntervention({ type: 'steer', ... })` returns `{ status: 'degraded', fallbackAction: 'queue_and_interrupt' }` per ADR-011's documented fallback for no-native-steer providers.

**Phase 3 Acceptance Mapping:** T3.1 + T3.6 lifecycle tests → Spec-005:204 (AC1 — driver-integration semantics-preserving). T3.3 + T3.8 capability declaration tests → Spec-005:205 (AC2 — undeclared capabilities not invocable). T3.1 + T3.6 resume-failure tests → Spec-005:206 (AC3 — recovery-needed condition surfaces).

### Phase 4 — Client SDK exposure + degraded-fallback

**Goal:** Author the typed SDK surface for capability + intervention controls under a dedicated `driver.*` JSON-RPC namespace (per Plan-007 CP-007-6). Daemon-side IPC handlers + SDK-side Zod-validated wrappers ship together. Subscription primitive reuses `LocalSubscriptionProducer<T>` per Plan-007 CP-007-4 precedent.

**Ratified design decisions (Tier 4 audit, 2026-05-27):**

1. **Factory pattern**: daemon-only `createDaemonProviderClient(JsonRpcClient): DriverClient` — no control-plane variant. Aligns with Spec-005:44 (driver authority is local-daemon-resident; no V1.1 remote-provider workflow on roadmap). Matches MCP/LSP best practice (single-transport for local-only capability servers).
2. **Namespace**: dedicated `driver.*` (added to Plan-007 §Tier 4 namespace registry per CP-007-6). **7 client-facing method names** follow canonical long-form per ADR-009 + Plan-007 I-007-9: `driver.listCapabilities`, `driver.interruptRun`, `driver.applyIntervention`, `driver.respondToRequest`, `driver.listModels`, `driver.listModes`, plus the subscription method `driver.subscribeEvents`. **Reversal-with-rationale (Codex round-3 review, PR #124):** the 2026-05-27 ratified design originally exposed all 10 driver-contract operations + `subscribeEvents` (11) over the client JSON-RPC namespace. The four session/run **lifecycle** operations — `driver.createSession`, `driver.resumeSession`, `driver.startRun`, `driver.closeSession` — are now **daemon-internal**: invoked only by the session/run orchestration layer on the in-daemon `ProviderRegistry` (T2.3), never registered as client-callable JSON-RPC methods. Governing principle: a `driver.*` method is client-facing iff it operates on an already-existing session/run (capability introspection, intervention/control, model/mode reads, event subscription); methods that **establish, restore, start, or tear down** a session-or-run domain object are orchestration-owned, because orchestration must persist the runtime binding and emit the canonical lifecycle event around the driver call. This honors Spec-005:186 (the driver "only sees `interruptRun` followed later by `startRun`" — those lifecycle calls are driven BY orchestration, not by clients) and the Phase-4 goal above ("capability + intervention controls"). Exposing the lifecycle verbs as client-callable would let a renderer/CLI start or destroy a provider session/run while bypassing the orchestration that owns `runtime_bindings` persistence + canonical `run.*` event emission. The in-daemon 10-op `ProviderDriver` interface (T1.1) is unchanged — only its client JSON-RPC exposure narrows. Clients reach lifecycle indirectly through the orchestration namespaces (`session.*` per Plan-001 — `session.create` maps to `directoryService.createSession` per api-payload-contracts.md:269, NOT `driver.createSession`; `run.*` per Plan-004).
3. **Envelope shape**: Zod-validated `DriverInterventionResult` at SDK seam (`{ status: 'applied' | 'degraded'; fallbackAction?: string }`) mirroring driver-internal shape (Spec-005:46, 132) with wire-level validation. Distinct from orchestration `InterventionState` lifecycle enum per LSP/MCP separation-of-concerns precedent.
4. **Subscription primitive**: `driver.subscribeEvents` returns `LocalSubscriptionProducer<DriverEvent>` per Plan-007 CP-007-4 (the shared streaming primitive). `DriverEvent` is the Plan-006-owned union of existing event-category types relevant to driver runtime — `run_lifecycle`, `assistant_output`, `tool_activity`, `interactive_request`, `artifact_publication`, `usage_telemetry`, and `runtime_node_lifecycle` (the last category supplies `runtime_node.capability_declared` + `runtime_node.capability_updated` for driver-capability events per CP-005-5; no new category is introduced). `usage_telemetry` is the canonical category name per [Spec-006 §Usage Telemetry](../specs/006-session-event-taxonomy-and-audit-log.md#usage-telemetry-usage_telemetry) and `packages/contracts/src/event.ts` literal union.
5. **Recovery-needed surface**: surfaced via a typed return-value contract from `resumeSession()` (T3.1, T3.6), then propagated by Plan-015's recovery dispatcher to the existing `run.failed` event with `recoveryCondition: 'recovery-needed'` per Spec-006:186. Plan-005 does NOT emit a separate `driver.recovery_needed` event — see CP-005-5 for the full handoff sequence.

#### Tasks

- **T4.1** — Author daemon-side `driver.*` IPC handlers (7 client-facing: 6 non-lifecycle verbs + `driver.subscribeEvents`).
  - Files: `packages/runtime-daemon/src/ipc/handlers/driver-handlers.ts` (new); `packages/runtime-daemon/src/ipc/router.ts` (extend registration)
  - Spec coverage: Spec-005:77-90 (the 10-op surface is the in-daemon `ProviderDriver` interface; the client `driver.*` namespace exposes only the 6 non-lifecycle verbs + `subscribeEvents` per §Phase 4 decision #2)
  - Verifies invariant: I-005-1 (driver authority local — IPC handlers dispatch to in-daemon ProviderRegistry)
  - Consumes: T2.3 ProviderRegistry; Plan-007 NamespaceRegistry (Tier 4 — co-tier delivery; CP-007-6 reciprocal); T1.1 ProviderDriver interface
  - Provides: 7 typed client-facing handlers (6 non-lifecycle verbs + `driver.subscribeEvents`) registered against Plan-007's NamespaceRegistry as `driver.{method}` entries; the 4 lifecycle ops (`createSession`/`resumeSession`/`startRun`/`closeSession`) are NOT registered as JSON-RPC methods — the session/run orchestration layer invokes them on the in-daemon `ProviderRegistry` (T2.3)
  - Estimate: 2 PRs

- **T4.2** — Author Zod schemas + Zod-validated wire envelopes at SDK seam.
  - Files: `packages/contracts/src/provider-driver.ts` (extend T1.4 — add the SDK-seam Zod schemas for the remaining client-facing methods, e.g. `ListCapabilitiesResultSchema`, `InterruptRunParamsSchema`, `ListModelsResultSchema`, etc.; the 4 session/run lifecycle ops `createSession`/`resumeSession`/`startRun`/`closeSession` get NO client-facing SDK schema — they are daemon-internal per §Phase 4 decision #2, so no `CreateSessionParamsSchema`/`ResumeSessionParamsSchema` at the client seam)
  - Spec coverage: Spec-005:46 (applyIntervention degraded envelope)
  - Verifies invariant: I-005-4
  - Consumes: T1.4 DriverInterventionResultSchema; `type RunId` ← T1.1 (the co-located brand)
  - Provides: Full SDK-seam Zod schemas for the 7 client-facing driver.\* methods (6 non-lifecycle verbs + `driver.subscribeEvents`; request + response) **and** the `RunIdSchema` validator (`brandedUuidIdSchema<RunId>("RunId")`), co-located with the `type RunId` brand in `provider-driver.ts` per CP-005-6 — first consumed here by `InterruptRunParamsSchema` (`z.object({ runId: RunIdSchema, … })`). This is `RunIdSchema`'s lowest-tier consumer (Tier 4), so it homes here; Plan-004 (Tier 5) and Plan-012 (Tier 6) import it upward. Authoring it in Plan-004's `runControl.ts` (Tier 5) would be a backward import for this Tier-4 consumer — structurally forbidden.
  - Estimate: 1 PR

- **T4.3** — Author `createDaemonProviderClient` factory.
  - Files: `packages/client-sdk/src/providerClient.ts` (new); `packages/client-sdk/src/index.ts` (export)
  - Spec coverage: Spec-005:44 (driver authority local — SDK factory is daemon-only); Spec-005:45 (the 10-op contract surface is the in-daemon driver interface — the SDK exposes the 6 non-lifecycle client verbs + `subscribeEvents` per §Phase 4 decision #2, not the 4 lifecycle ops)
  - Verifies invariant: I-005-1
  - Consumes: T1.1 ProviderDriver interface; T1.4 DriverInterventionResultSchema; T4.2 SDK-seam schemas; Plan-007 `JsonRpcClient` transport from `packages/client-sdk/src/transport/jsonRpcClient.ts` (Tier 1 — shipped)
  - Provides: `interface DriverClient { listCapabilities(); interruptRun(p); applyIntervention(p); respondToRequest(p); listModels(); listModes(); subscribeEvents(): LocalSubscriptionConsumer<DriverEvent> }` (the 6 non-lifecycle client verbs + `subscribeEvents` = the 7 client-facing methods ratified at §Phase 4 decision #2; the 4 lifecycle ops `createSession`/`resumeSession`/`startRun`/`closeSession` are daemon-internal and deliberately absent from the client interface — exposing them would let a client bypass `runtime_bindings` persistence + canonical run/session event emission) + `createDaemonProviderClient(client: JsonRpcClient): DriverClient` factory. No `createControlPlaneProviderClient` per ratified decision #1.
  - Estimate: 1-2 PRs

- **T4.4** — Author `driver.subscribeEvents` subscription surface.
  - Files: `packages/runtime-daemon/src/ipc/handlers/driver-subscribe.ts` (new); `packages/client-sdk/src/providerClient.ts` (extend T4.3)
  - Spec coverage: Spec-005:53 (drivers emit normalized runtime events)
  - Verifies invariant: I-005-1
  - Consumes: T1.1 ProviderDriver interface; Plan-007 CP-007-4 `LocalSubscriptionProducer<T>` from `packages/contracts/src/jsonrpc-streaming.ts` (Tier 1 — shipped); T3.5 + T3.10 event normalizers
  - Provides: `driver.subscribeEvents(runId)` returns `LocalSubscriptionProducer<DriverEvent>` on the daemon side and `LocalSubscriptionConsumer<DriverEvent>` on the SDK side per the Plan-007 producer/consumer split.
  - Estimate: 1 PR

- **T4.5** — Author daemon-side capability cache + invalidation.
  - Files: `packages/runtime-daemon/src/provider/capability-cache.ts` (new)
  - Spec coverage: Spec-005:56 (undeclared = unsupported)
  - Verifies invariant: I-005-2
  - Consumes: T2.4 driver_capabilities writer; T3.3 + T3.8 driver capability declarations
  - Provides: Per-driver capability cache + invalidation on `runtime_node.capability_updated` event (Spec-006:413; subscribed via the daemon's audit-log fanout). SDK `listCapabilities()` reads the cache (no provider round-trip per call).
  - Estimate: 1 PR

- **T4.6** — Author degraded-fallback orchestration unit tests.
  - Files: `packages/client-sdk/src/providerClient.test.ts` (new)
  - Spec coverage: Spec-005:46 (degraded envelope); Spec-005 AC2 (Spec-005:205 — unsupported capability gated)
  - Verifies invariant: I-005-4, I-005-2
  - Notes: Tests assert `applyIntervention({ type: 'steer', ...})` against the Claude driver (which declares `steer: false`) returns `{ status: 'degraded', fallbackAction: 'queue_and_interrupt' }` — the client-facing `driver.applyIntervention` path. Tests also assert the in-daemon `ProviderRegistry` capability gate (T2.3) refuses a capability-bound invocation against an undeclared flag BEFORE it reaches the driver (throwing `driver.capability_unsupported`); because the lifecycle ops (`startRun` et al.) are daemon-internal, this gate sits at the orchestration→driver (`ProviderRegistry`) boundary, not at a client JSON-RPC layer.
  - Estimate: 1 PR

- **T4.7** — Author recovery-needed return-value contract tests.
  - Files: `packages/client-sdk/src/providerClient.recovery.test.ts` (new). No Plan-006 amendment needed — recovery-needed reuses the existing `run.failed.recoveryCondition` surface from Spec-006:186 per CP-005-5; the test asserts only the driver's return-value contract, not event emission.
  - Spec coverage: Spec-005:69 (resume-handle failure → recovery-needed condition); Spec-005 AC3 (Spec-005:206 — explicit recovery-needed condition rather than silent session replacement)
  - Verifies invariant: I-005-5
  - Consumes: T3.1 + T3.6 lifecycle resume-failure paths; Spec-006:186 existing `run.failed` event with `recoveryCondition: 'recovery-needed'`
  - Provides: Test that simulates Codex resume failure and asserts (a) `resumeSession()` returns a typed failure result carrying `recoveryCondition: 'recovery-needed'` and (b) the driver does NOT silently call `createSession()` to replace the failed binding. The downstream `run.failed` event emission (with `recoveryCondition: 'recovery-needed'`) is Plan-015's responsibility and is covered by Plan-015's tier-7 tests; this Phase-4 test verifies only the driver's return-value contract per Spec-005:69 + AC3.
  - Estimate: 1 PR

**Phase 4 Acceptance Mapping:** T4.6 → Spec-005:205 (AC2). T4.7 → Spec-005:206 (AC3). T4.3 SDK exposure → Spec-005:204 (AC1) for the externally-observable contract.

## Parallelization Notes

- Phase 1 (contracts) must complete before Phase 2-4 begin.
- Phase 2 (registry + persistence) blocks Phase 3 (drivers consume the registry).
- Phase 3 Codex + Claude tasks can proceed in parallel once T2.3 ProviderRegistry is shipped.
- Phase 4 SDK exposure can proceed in parallel with Phase 3 driver implementation once T2.3 + T2.4 ship — Phase 4 daemon-side IPC handlers depend on the registry, not on the specific drivers being implemented.

## Test And Verification Plan

- **Phase 1 contract tests** (T1.5): Type-system conformance via TypeScript compile check + minimal mock driver. Verifies AC1 + AC2.
- **Phase 2 integration tests** (T2.5): Real SQLite (better-sqlite3 in-memory) + ProviderRegistry round-trip. Verifies I-005-1, I-005-2 + AC2.
- **Phase 3 driver tests** (per-driver): Lifecycle (createSession → resumeSession → startRun → interruptRun → closeSession) + capability declaration + per-tool idempotency_class + event normalization. Verifies AC1 + AC2 + AC3.
- **Phase 4 SDK tests** (T4.6, T4.7): Degraded-fallback orchestration + recovery-needed return-value contract. Verifies AC2 + AC3 + I-005-4 + I-005-5.
- **Integration tests across phases**: Proving driver lifecycle and policy enforcement stay daemon-local even when the provider endpoint itself is remote — verifies I-005-1.

## Rollout Order

1. Land Phase 1 contracts (T1.1-T1.6) — blocks all downstream.
2. Land Phase 2 persistence + registry (T2.1-T2.5) — blocks Phase 3.
3. Land Phase 3 Codex driver (T3.1-T3.5) and Phase 3 Claude driver (T3.6-T3.10) in parallel.
4. Land Phase 4 SDK exposure (T4.1-T4.7) — may proceed in parallel with late-Phase-3 work once T2.3 ships.

## Rollback Or Fallback

- Keep one driver behind a compatibility adapter if the full contract rollout regresses.
- If Phase 4 SDK exposure regresses, fall back to direct daemon-internal use of ProviderRegistry (Phase 2 surface) until the SDK surface is restored.

## Risks And Blockers

- Contract churn while both initial drivers are under construction → mitigated by Phase 1 contract-stabilization gate before Phase 3 starts.
- Recovery semantics may diverge before enough conformance tests exist → mitigated by I-005-5 invariant + T4.7 explicit recovery-needed return-value contract test.
- Remote provider APIs can be mistaken for permission to centralize driver execution unless the local-runtime boundary stays explicit in code and docs → mitigated by I-005-1 invariant + Spec-005:44 reinforcement throughout this plan.
- Provider rollback/rewind methods are unconfirmed against a live binary — Codex `thread/rollback` is upstream-deprecated beyond the `0.141.0` pin and Claude `--resume-session-at` is binary-probe-only (absent from the live CLI reference) — so before any driver code invoking the provider-side rewind path lands, re-verify the method or its replacement against the then-installed provider binary per [ADR-017](../decisions/017-shared-event-sourcing-scope.md) Decision Log (2026-07-02) + [`codex.md`](../reference/provider-wire/codex.md) / [`claude.md`](../reference/provider-wire/claude.md) (§Gaps recorded). Rollback is feature #19, doc-gated on the campaign's B2 bundle per [cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md) §5.

## Invariants

The following load-bearing properties are promoted from Spec-005 and apply across all phases. Each invariant is referenced by Task `Verifies invariant:` fields above.

- **I-005-1** — Driver authority remains local even when provider endpoint is remote. Source: Spec-005:44, Spec-005:62. Enforced by: ProviderRegistry residing in-daemon (T2.3); SDK factory is daemon-only (T4.3). Test: integration test asserting driver lifecycle stays daemon-local with remote endpoint mock.
- **I-005-2** — Runtime treats undeclared capabilities as unsupported. Source: Spec-005:56. Enforced by: ProviderRegistry capability-check gating (T2.3); `DriverCapabilityFlag` enum exhaustiveness at the type system (T1.2 — seven flags as shipped, thirteen post-B3/B6). Test: SDK test asserts invocation against undeclared flag is rejected with `driver.capability_unsupported` (T4.6).
- **I-005-3** — Per-tool `idempotency_class` defaults to `manual_reconcile_only` when undeclared. Source: Spec-005:174. Enforced by: the `ProviderToolMetadataSchema` ingress field `idempotency_class: IdempotencyClassSchema.optional().default("manual_reconcile_only")` (T1.3) — a driver that OMITS the field is accepted, NOT rejected, at ingress, and parsing yields the `manual_reconcile_only` default in `z.output` (`NormalizedProviderToolMetadata`), so every value persisted to the NOT NULL `driver_tools.idempotency_class` column or emitted on a `runtime_node.capability_*` event is populated; Plan-015's recovery dispatch table reads the normalized value (Spec-015:124). Test: contract test asserts a tool declared WITHOUT `idempotency_class` is accepted at ingress AND resolves to `manual_reconcile_only` in the normalized (persisted / emitted) shape.
- **I-005-4** — Unsupported intervention types return structured `degraded` result; orchestration layer dispatches fallback. Source: Spec-005:46, Spec-005:134. Enforced by: DriverInterventionResultSchema Zod validation at SDK seam (T1.4 + T4.2); Claude driver intervention dispatcher (T3.7) returns `degraded` on `steer` invocation. Test: T4.6 asserts the Zod-validated result shape.
- **I-005-5** — Drivers MUST NOT silently create replacement provider sessions on resume failure; failure surfaces an explicit `recovery-needed` condition. Source: Spec-005:69, Spec-005:206 (AC3). Enforced by: lifecycle `resumeSession()` implementations (T3.1, T3.6) return a typed failure result carrying `recoveryCondition: 'recovery-needed'` rather than calling `createSession()`. Plan-015's recovery dispatcher (Tier 7) receives the typed result and emits the existing `run.failed` event with `recoveryCondition: 'recovery-needed'` per Spec-006:186 — no separate driver event. Test: T4.7 asserts the typed return shape from a simulated Codex resume failure path; verifying that no `createSession()` call is issued is covered by the same test (mock-spy on the driver's `createSession` method).

## Cross-Plan Obligations

This section makes Plan-005's reciprocal obligations to other plans visible to a Plan-005 reviewer without requiring them to read every consuming or consumed plan first. Mirrors the bidirectional-citation pattern established by [Plan-001 §Cross-Plan Obligations](./001-shared-session-core.md#cross-plan-obligations) and [Plan-007 §Cross-Plan Obligations](./007-local-ipc-and-daemon-control.md#cross-plan-obligations).

### CP-005-1 — `runtime-binding-store.ts` recovery-aware extension contract owed to [Plan-015](./015-persistence-recovery-and-replay.md)

Plan-005 Phase 2 (T2.2) owns `packages/runtime-daemon/src/provider/runtime-binding-store.ts`. Plan-015 at Tier 7 extends the store with recovery-aware persistence methods (per cross-plan-dependencies.md §2 line 80 ownership row). The extension contract:

- The `RuntimeBindingStore` exposes `findResumableBindings(...)` as a queryable seam where Plan-015 may add recovery-aware predicates (e.g., bindings with stale checkpoints, bindings marked recovery-needed via the dedicated `recovery_checkpoints` table at `local-sqlite-schema.md:1096`).
- Row-level recovery state lives in Plan-015's `recovery_checkpoints` table (not on `runtime_bindings`). Plan-005's `resumeSession()` returns the typed failure result (T3.1/T3.6); Plan-015's recovery dispatcher (Tier 7) receives the result and writes the corresponding row to `recovery_checkpoints` via a Plan-015-defined extension method on `RuntimeBindingStore`, then emits the existing `run.failed` event with `recoveryCondition: 'recovery-needed'` per Spec-006:186.
- Plan-005 does NOT add `recovery_state` / `recovery_reason` columns to `runtime_bindings`. The ownership boundary is: `runtime_bindings` carries identity + active binding state; `recovery_checkpoints` carries recovery-state-machine state. (Recovery state belongs to Plan-015's dedicated table.)

**Why bidirectional.** Plan-015 reviewers see the consumer dependency; Plan-005 reviewers (especially Phase 2 PR authors) must know that the binding-store's public method surface is contractually required to support Plan-015's recovery dispatch without further Plan-005 amendments.

### CP-005-2 — `idempotency_class` per-tool metadata shape owed to [Plan-015](./015-persistence-recovery-and-replay.md)

Plan-005 Phase 1 (T1.3) owns the `IdempotencyClass` enum + `ProviderToolMetadata` shape. Plan-015 at Tier 7 consumes these types in its `Spec-015 §Idempotency Protocol` recovery-dispatch table (Spec-015:112-124) — the `manual_reconcile_only` row (Spec-015:124) is load-bearing for Plan-015's recovery dispatcher: Plan-015 reads the `IdempotencyClass` enum to dispatch (replay vs skip vs halt), and on halt emits the existing `run.failed` event with `recoveryCondition: 'recovery-needed'` per Spec-006:186. The driver's `resumeSession()` failure-path return-value is the upstream signal that triggers Plan-015's dispatch; the event emission stays on Plan-015's side.

**Why bidirectional.** The `IdempotencyClass` symbol must exist in Plan-005's contracts file before Plan-015 can compile. Plan-005 cannot move this enum without coordinating with Plan-015's spec language.

### CP-005-3 — `PtyHost` contract consumption from [Plan-024](./024-rust-pty-sidecar.md)

Plan-005 Phase 3 Codex driver (T3.1) consumes the `PtyHost` contract from `packages/contracts/src/pty-host.ts`. Plan-024 Phase 2 ships this contract at Tier 1 (per NS-05). The boundary:

- Plan-005 imports the `PtyHost` interface; it does NOT depend on the Rust binary directly. The binary is a Plan-024-owned implementation detail behind the contract.
- The Codex /resume substrate (PtyHost-based persistent process for `resumeSession()`) is a Plan-024 contract surface — Plan-005's Codex driver consumes it. If Plan-024 changes the PtyHost contract, Plan-005 amendments may be required.

**Why bidirectional.** Plan-024's Phase 2 is the canonical landing-point for the `PtyHost` contract; Plan-005 reviewers must know which Plan-024 surface they're consuming so a Plan-024 contract change triggers a Plan-005 review.

### CP-005-4 — `driver.*` JSON-RPC namespace registration owed to [Plan-007](./007-local-ipc-and-daemon-control.md) Tier 4

Plan-005 Phase 4 (T4.1) registers 7 client-facing `driver.*` JSON-RPC method handlers (6 non-lifecycle verbs + `driver.subscribeEvents`; the 4 session/run lifecycle ops — `createSession`/`resumeSession`/`startRun`/`closeSession` — are daemon-internal per §Phase 4 decision #2, invoked by orchestration on the in-daemon `ProviderRegistry`) against Plan-007's NamespaceRegistry (`packages/contracts/src/jsonrpc-registry.ts` per Plan-007 CP-007-3 → no-mirror disposition; canonical source: code). Plan-007 §Tier 4 namespace enumeration must include `driver.*` for Plan-005's registration to land without orphaning.

**Why bidirectional.** Plan-007 Tier 4 PR authors must know that `driver.*` is part of the registered namespace set; otherwise the Plan-005 SDK seam fails to register at daemon startup. Plan-007 CP-007-6 is the reciprocal entry on Plan-007's side.

### CP-005-5 — Driver capability event surface owed to [Plan-006](./006-session-event-taxonomy-and-audit-log.md) / [Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md)

**Capability-declaration + capability-change events reuse existing Spec-006 surface.** Spec-006:412-413 already enumerates two events in the `runtime_node_lifecycle` category that name "provider driver" as a capability type:

- `runtime_node.capability_declared` — payload `{capability, capabilityDetails}`. Plan-005 emits this on driver registration (T2.3) and on cold-start (T4.5) with `capability: "provider-driver-{codex|claude}"` and `capabilityDetails: { flags: Record<DriverCapabilityFlag, boolean>, contractVersion: string, tools: NormalizedProviderToolMetadata[] }` (the wrapper-shape contents from T1.3; `tools` carries the normalized shape because the event crosses the persistence / event-payload boundary).
- `runtime_node.capability_updated` — payload `{capability, previousState, newState}`. Plan-005 emits this on capability refresh (T3.3, T3.8; consumed by T4.5 cache invalidation) with `capability: "provider-driver-{codex|claude}"` and previous/new state carrying the same shape as `capabilityDetails` above.

No new event types, no new category. The capability-flag matrix (twelve flags post-B3; thirteen with B6's `cost_cap`) + per-tool metadata travel inside the existing `capabilityDetails` / `previousState` / `newState` payload fields. Plan-006 audit confirms these payload shapes are admissible under the existing event surface (Spec-006:413 already lists "driver version bump, tool addition" as a documented example of `capability_updated`).

**Recovery-needed condition reuses existing `run.failed` surface.** Spec-005:69 calls for drivers to "surface a visible `recovery-needed` condition" on resume-handle failure. Spec-006:186 already declares this surface: `run.failed` payload includes `recoveryCondition?: 'recovery-needed'`. Plan-005 does NOT emit a separate `driver.recovery_needed` event. Instead:

1. Plan-005's `resumeSession()` returns a typed failure result (T3.1, T3.6).
2. Plan-015's recovery dispatcher (Tier 7) receives the typed result.
3. Plan-015 emits the existing `run.failed` event with `recoveryCondition: 'recovery-needed'`.

This keeps the recovery-needed signal on the canonical run-lifecycle surface where downstream consumers already subscribe; avoids creating a parallel driver-specific recovery event.

**Why bidirectional.** Plan-006 audit (concurrent Tier 4) confirms the existing `runtime_node.capability_declared` / `runtime_node.capability_updated` payload shapes accept the wrapper-shape contents — no new event types are added. Plan-005 reviewers (especially Phase 2-4 implementers) must know that the driver-capability event surface is the existing Spec-006:412-413 row, not a new category. Plan-005 reviewers must also know that recovery-needed flows through Plan-015 (not directly from the driver) so the driver's `resumeSession()` return-type stays a pure typed failure result.

**Resolution (Plan-006 audit synthesis 2026-05-28 — closes CP-005-5).** Plan-006 audit ratifies two concrete deliverables that discharge this carry-forward:

1. **Plan-006 Phase 1 T1.4 binds a typed `CapabilityDetails` interface** in `packages/contracts/src/event.ts` (extends top-level per Plan-001's contracts package layout precedent; resolved as "extend in place"). Shape: `{ flags: Record<DriverCapabilityFlag, boolean>, contractVersion: string, tools: readonly NormalizedProviderToolMetadata[] }` (`tools` is the normalized shape — `CapabilityDetails` is an event payload, so it crosses the boundary). Plan-006 Phase 1 T1.6 doc-mirrors the same shape into [`api-payload-contracts.md` §Plan-006](../architecture/contracts/api-payload-contracts.md) (between `GetCapabilitiesResult` and `EventEnvelope`) with explicit references to Spec-006:412-413 and this carry-forward.

2. **Plan-006 Phase 3 ratifies `providerFailureDetail?: string` on `run.failed` payload** ([`api-payload-contracts.md` `RunStateChangeEvent`](../architecture/contracts/api-payload-contracts.md) line ~1232). Mirrors the `failed`-variant `providerFailureDetail` field of `DriverResumeResult` (line 761, shipped by Plan-005 T1.6) — Plan-015's recovery dispatcher reads the typed failure detail from the driver result and emits it on the canonical `run.failed` event so the audit log carries the operator-actionable reason without re-querying the driver. ADR-018-compliant additive-only MINOR addition (no consumer breakage; optional field).

3. **Plan-006 Phase 4 confirms read-shape generic envelope is sufficient.** Replay endpoints (`EventReadAfterCursorResponse`, `EventReadWindowResponse`, `EventSubscription`) return `EventEnvelope[]` with `payload: Record<string, unknown>`. Consumers narrow via Phase 1's discriminated-union taxonomy (the typed `RuntimeNodeCapabilityDeclaredPayload` + `RuntimeNodeCapabilityUpdatedPayload` payload interfaces). No replay-shape tightening required.

**Status: CP-005-5 RESOLVED.** Discharge artifacts land in Plan-006 audit PR (this PR or its successor); Plan-005 author confirms by re-reading `api-payload-contracts.md` `CapabilityDetails` + `RunStateChangeEvent.providerFailureDetail` definitions and Plan-006 working-copy T1.4 + Phase 3 T3.x integration.

### CP-005-6 — Cross-cutting run-control symbol co-location (`InterventionType` enum + `RunId` brand / `RunIdSchema`) owed to [Plan-004](./004-queue-steer-pause-resume.md) + [Plan-012](./012-approvals-permissions-and-trust-boundaries.md)

The cross-cutting `InterventionType = "steer" | "interrupt" | "cancel"` enum (api-payload-contracts.md:149) is consumed by both Plan-004's `runControl.ts` (Tier 5) and Plan-005's `provider-driver.ts` (Tier 4). Resolution: Plan-005 Phase 1 (T1.4) co-locates the `InterventionType` re-export in `provider-driver.ts` since Plan-005 ships earlier. Plan-004 Tier 5 imports the enum from Plan-005 (Tier 4 → Tier 5 tier-consistent import).

The **`RunId` brand (`type RunId`) and its validator `RunIdSchema`** co-locate in the same `provider-driver.ts` by the identical logic, and for an additional structural reason: `RunId` is `InterventionType`'s struct-mate in `ApplyInterventionParams` (`{ type: InterventionType; targetRunId: RunId; … }`, api-payload-contracts.md:681-702). Lowest-tier-consumer placement governs each symbol independently: `type RunId` is first consumed by the Phase 1 `ProviderDriver` interface method params (T1.1, Tier 4), and `RunIdSchema` is first consumed by the Phase 4 `InterruptRunParamsSchema` (T4.2, Tier 4) — so both home in Plan-005 (Tier 4), the `type` and `Schema` paired in one file per the established `session.ts` `brandedUuidIdSchema` convention. Plan-004 (Tier 5) imports `RunId`; Plan-012 (Tier 6) imports both `RunId` and `RunIdSchema` — each an upward, forward edge. Authoring `RunIdSchema` in Plan-004's `runControl.ts` (Tier 5) — as the pre-correction `CP-012-3` cite asserted — would be a backward import for Plan-005's own Tier-4 `InterruptRunParamsSchema` consumer, i.e. structurally forbidden; that latent orphan is corrected by this plan (see §Cross-Plan Amendments).

**Precedent.** This matches Plan-001's ownership pattern for the brands it actually ships (`SessionId`, `ParticipantId`, `MembershipId`, `ChannelId` co-located in `session.ts` Phase 2 — each `type X` paired with its `XSchema` per the `brandedUuidIdSchema` convention; their lowest-tier consumer is Tier 1). The governing rule is **lowest-tier-consumer placement**: a cross-cutting symbol is declared in the contract file of its lowest-tier (earliest-shipping) consumer, and every higher-tier plan imports it upward — never re-inventing a parallel definition. `RunId` / `RunIdSchema` are **not** in Plan-001 / `session.ts` (Plan-001 ships no run-domain symbol); their lowest-tier consumer is Plan-005 (Tier 4), so they home in `provider-driver.ts`.

**Why bidirectional.** Plan-004 reviewers see the import-from-Plan-005 of `InterventionType` + `RunId`; Plan-012 reviewers see the import of `RunId` + `RunIdSchema`; Plan-005 reviewers must know these symbols are shared and must not relocate them without coordinating with Plan-004 + Plan-012.

### CP-005-7 — Driver approval-request normalization owed to [Plan-012](./012-approvals-permissions-and-trust-boundaries.md)

Plan-012 owns the normalizer that maps Plan-005's driver-surfaced permission asks (`interactive_request` driver events / driver-host permission callbacks) into canonical `approval.requestCreate` inputs; it lands with Plan-012's driver integration, not in Plan-005 (Tier-6 audit, 2026-06-10 — Plan-012 CP-012-6, A-18). Until that normalizer lands, the schema-validated `approval.requestCreate` boundary is the enforced normalization gate, and a driver that cannot surface granular permission requests inherits the stricter daemon boundary per [Spec-012:89](../specs/012-approvals-permissions-and-trust-boundaries.md).

**Why bidirectional.** Plan-012 reviewers see the consume edge on the Plan-012 §3 dependency row; Plan-005 reviewers must know the driver event surface has a downstream approval consumer and must not reshape `interactive_request` driver-event payloads without coordinating with Plan-012.

### Cross-Plan Amendments

**PR #157 (2026-06-15) — `RunId` brand / `RunIdSchema` provenance correction across the cross-plan corpus.**

Phase 1's `ProviderDriver` interface surfaced two latent provenance orphans in the doc corpus — branded symbols cited as living in a file that does not (and structurally cannot) author them:

1. **`type RunId`** was cited as consumed "from `packages/contracts/src/session.ts`" by this plan (L12 / T1.1), Plan-010 (T1.2 / T3.2), and Plan-016 (T1.1). But `session.ts` (Plan-001 Phase 2) ships no run-domain symbol — a repo-wide grep confirms `RunId` appears in zero files under `packages/`. `type RunId`'s lowest-tier consumer is this Plan-005 (Tier 4 — the `ProviderDriver` method params), so it originates in `provider-driver.ts` (T1.1) per CP-005-6.
2. **`RunIdSchema`** was cited as imported "from Plan-004's `runControl.ts` (Tier 5)" by Plan-012's `CP-012-3` cluster. But Plan-004 never authors `RunIdSchema` (its task bodies only _consume_ the `RunId` type in-package), and authoring it at Tier 5 is structurally impossible: Plan-005's own Phase 4 `InterruptRunParamsSchema` (Tier 4) consumes it, and a Tier-4 file cannot import from a Tier-5 file without a backward edge. `RunIdSchema`'s lowest-tier consumer is therefore Plan-005 (Tier 4); it co-locates with `type RunId` in `provider-driver.ts` (authored at T4.2) per CP-005-6.

This PR corrects the provenance cites at their source: this plan (L12 / T1.1 / T4.2 / CP-005-6), `cross-plan-dependencies.md` (§2 ownership row for `provider-driver.ts` + the Plan-012 §3 dependency-graph row), Plan-010 (T1.2 / T3.2), Plan-016 (T1.1), and Plan-012 (header dep, `CP-012-3` + its Phase-1 precondition, and the `RunId` / `RunIdSchema` consume cites on its Phase-1 + Phase-4 tasks). Plan-004's task bodies are left unchanged — their `RunId` "(in-package)" type-consume cites stay true (`provider-driver.ts` and `runControl.ts` are both in `packages/contracts/src/`); Plan-004's missing `RunIdSchema`-consume cite is an omission its own Tier-5 G4 audit closes against the now-corrected ownership map.

**Cross-plan touch rationale.** The Plan-010 / Plan-012 / Plan-016 plan docs and `cross-plan-dependencies.md` are normally each plan's own / the map's surface. We applied a fix-in-place housekeeping exception because: (a) the change is doc-cite-level only (provenance attribution; zero code, zero behavioral change), (b) Plan-005 Phase 1 is the first surfacer — its `ProviderDriver` interface is the originating declaration of `type RunId`, (c) the sweep is a one-time provenance correction well under the sub-30-LOC / sub-day bar, and (d) bundling the corpus sweep in the surfacing PR avoids cross-plan PR-coordination ceremony and stops the two orphans from propagating into Tier-4/5/6 code. This is a one-time correction, not Plan-005 claiming ongoing edit rights on Plan-010 / Plan-012 / Plan-016 files. Encoded per the §2 §Ownership Rule **Housekeeping Exception** clause ([cross-plan-dependencies.md §Ownership Rule](../architecture/cross-plan-dependencies.md#ownership-rule)).

**Refs:** [Plan-004](./004-queue-steer-pause-resume.md) (`runControl.ts` — `RunId` in-package consumer), [Plan-010](./010-worktree-lifecycle-and-execution-modes.md), [Plan-012](./012-approvals-permissions-and-trust-boundaries.md) (`CP-012-3`), [Plan-016](./016-multi-agent-channels-and-orchestration.md), [cross-plan-dependencies.md §Ownership Rule](../architecture/cross-plan-dependencies.md#ownership-rule).

**PR #157 (2026-06-15) — `InterventionDriverResult` → `DriverInterventionResult` naming canonicalization.**

Phase 1's T1.4 code authoring surfaced an internal naming inconsistency in the canonical contract doc: the two sibling driver result-envelope types used different conventions. `DriverResumeResult` (api-payload-contracts.md:785) leads with the `Driver` prefix, but its explicit sibling — the `applyIntervention` envelope at :701 — buried the qualifier in the middle as `InterventionDriverResult`. The doc is the defect; the fix is the doc, and Phase 1 code then mirrors the corrected doc (doc-first preserved).

Canonicalized to the `Driver`-prefixed form `DriverInterventionResult`, which aligns with (a) its explicit sibling `DriverResumeResult` (T1.6 — the plan itself calls this shape the "sibling" of T1.4's), (b) the `X` + `XSchema` pairing convention (the Zod schema is `DriverInterventionResultSchema`, T1.4), and (c) the `Driver`-prefixed contract family in this surface (`DriverCapabilityFlag`, `DriverCapabilities`). Renamed at source across `api-payload-contracts.md` (the `ProviderDriver.applyIntervention` return at :588 + the `interface` declaration at :639), this plan (T1.4 / T1.6 `Consumes:` cites + the §Done Checklist doc-mirror item), [Plan-004](./004-queue-steer-pause-resume.md) (the §Dependencies cell, `CP-004-1`, and the two T2.6 mapping-task consume cites), and [queue-and-intervention-model.md](../domain/queue-and-intervention-model.md) (the §Boundary note). Zero behavioral change — the `{ status: 'applied' | 'degraded'; fallbackAction? }` shape is untouched; only the type's name changes.

**Cross-plan touch rationale.** Plan-004's cites are normally Plan-004's own surface. We applied a fix-in-place housekeeping exception because: (a) the change is doc-cite-level / type-name only (zero code-behavior, identical shape), (b) Plan-005 Phase 1 T1.4 is the first surfacer — it authors the `DriverInterventionResult` code type that Plan-004 (Tier 5) consumes, so leaving Plan-004's cites on the old name would dangle them against the renamed type, (c) the sweep is a one-time correction well under the sub-30-LOC / sub-day bar, and (d) bundling it in the surfacing PR keeps the consumer cites resolvable rather than propagating a stale name into Tier-5 code. Encoded per the §2 §Ownership Rule **Housekeeping Exception** clause ([cross-plan-dependencies.md §Ownership Rule](../architecture/cross-plan-dependencies.md#ownership-rule)).

**Refs:** [Plan-004](./004-queue-steer-pause-resume.md) (`CP-004-1` consumer), [queue-and-intervention-model.md](../domain/queue-and-intervention-model.md), [api-payload-contracts.md §Plan-005](../architecture/contracts/api-payload-contracts.md), [cross-plan-dependencies.md §Ownership Rule](../architecture/cross-plan-dependencies.md#ownership-rule).

**PR #157 (2026-06-15) — stale "types do not exist yet" clause corrected in the `runtime-node.ts` forward-dep comment.**

Phase 1 ships `DriverCapabilityFlag` and `NormalizedProviderToolMetadata` in `provider-driver.ts`. The `capabilityDetails` forward-dependency comment in `packages/contracts/src/runtime-node.ts` (the interim-opaque `z.record` marker `Plan-006-Tier-4-binds-canonical`, authored by Plan-003 Phase 2 / PR #137) asserted those two types "DO NOT EXIST yet" — a claim this PR falsifies. Rather than swap one merge-timing-dependent claim ("now exist") for another, the comment is rewritten to be **merge-state-neutral**: it anchors the interim-opaque rationale on the timeless ownership fact (binding the canonical `CapabilityDetails` over this field is Plan-006 Tier 4's owned step, not this layer's) instead of on the types' non-existence. Zero behavioral change — the field stays `z.record(z.string(), z.unknown())`; only the comment's justification is corrected.

**Plan-003 plan-doc prose + the contracts-doc cross-plan note left intact (deliberate).** The same forward-dep narrative appears as point-in-time design prose in two other places: (1) [Plan-003](./003-runtime-node-attach.md) (the Phase-2 cross-plan-amendment at line 83 and the implementation step at line 325: "do not yet exist" / "absent" — two mentions), and (2) the [api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md) Plan-006-Tier-4 cross-plan note at line 961, which carries the identical now-false "Plan-005's `provider-driver.ts` types … do not yet exist" claim. Those are governance / implementation narrative, true as authored (PR #137, 2026-06-02), and explicitly scoped to **Plan-006 Tier 4** for removal when it binds the canonical `CapabilityDetails` (the documented removal trigger all four mentions share). The rewritten merge-neutral code comment no longer contradicts them, so leaving them is ownership discipline, not unresolved drift — Plan-006 Tier 4 retires the whole forward-dep narrative (code marker + both Plan-003 prose mentions + the api-payload-contracts.md cross-plan note at line 978) in one consistent atomic pass when it owns the bind. The contracts-doc note shares the identical Plan-006-Tier-4 removal trigger and is therefore deferred to that same atomic retirement, NOT rewritten here.

**Cross-plan touch rationale.** `runtime-node.ts` is Plan-003's file. We applied a fix-in-place housekeeping exception because: (a) the change is comment-only (zero code, zero behavioral change — the opaque `z.record` is untouched), (b) Plan-005 Phase 1 is the first surfacer — it authors the `DriverCapabilityFlag` / `NormalizedProviderToolMetadata` types whose existence falsifies the old clause, (c) it is a single comment correction well under the sub-30-LOC / sub-day bar, and (d) bundling it in the surfacing PR removes a now-false statement from shipped code rather than leaving it for a later tier. This is a one-time correction, not Plan-005 claiming ongoing edit rights on `runtime-node.ts`. Encoded per the §2 §Ownership Rule **Housekeeping Exception** clause ([cross-plan-dependencies.md §Ownership Rule](../architecture/cross-plan-dependencies.md#ownership-rule)).

**Refs:** [Plan-003](./003-runtime-node-attach.md) (`runtime-node.ts` owner — `CP-003-1` forward-dep marker), [Plan-006](./006-session-event-taxonomy-and-audit-log.md) (Tier 4 canonical `CapabilityDetails` bind — `CP-005-5` / `CP-006-5`), [cross-plan-dependencies.md §Ownership Rule](../architecture/cross-plan-dependencies.md#ownership-rule).

## Progress Log

### Shipment Manifest

<!-- Machine-readable. Housekeeper-emitted, orchestrator-written, preflight-read.
     Schema authoritative in:
       .claude/skills/plan-execution/scripts/lib/manifest.mjs -->

```yaml
manifest_schema_version: 1
shipped:
  - phase: 1
    task: [T1.1, T1.2, T1.3, T1.4, T1.5, T1.6]
    pr: 157
    sha: a81821e
    merged_at: 2026-06-15
    files:
      - docs/architecture/contracts/api-payload-contracts.md
      - docs/architecture/cross-plan-dependencies.md
      - docs/domain/queue-and-intervention-model.md
      - docs/plans/004-queue-steer-pause-resume.md
      - docs/plans/005-provider-driver-contract-and-capabilities.md
      - docs/plans/010-worktree-lifecycle-and-execution-modes.md
      - docs/plans/012-approvals-permissions-and-trust-boundaries.md
      - docs/plans/016-multi-agent-channels-and-orchestration.md
      - packages/contracts/src/__tests__/provider-driver.test.ts
      - packages/contracts/src/index.ts
      - packages/contracts/src/provider-driver.ts
      - packages/contracts/src/runtime-node.ts
    verifies_invariant: [I-005-3]
    spec_coverage:
      [
        Spec-005:43,
        Spec-005:45,
        Spec-005:46,
        Spec-005:54,
        Spec-005:56,
        Spec-005:57,
        Spec-005:69,
        Spec-005:77,
        Spec-005:162-164,
        Spec-005:174,
        Spec-005:204,
        Spec-005:205,
        Spec-005:206,
        Spec-015:112,
        Spec-015:124,
      ]
    notes: |
      Phase-1 tasks T1.1-T1.6 shipped as one contracts-only PR (no daemon/SDK; Phases 2-4 follow). AC1+AC2 verified; AC3 (recovery-needed, Spec-005:206) deferred to Phase 3/4 per the Plan-005 Acceptance Mapping. The two no-contract-invariant provider-output fields (DriverCapabilities.contractVersion, ProviderSessionHandle.resumeHandle) are bounded at the Phase-2 write seam (T2.1), not the contract layer. verifies_invariant records only the invariant canonically verified in Phase 1 — I-005-3 (omitted idempotency_class -> manual_reconcile_only at ingress, exercised by the T1.5 contract test). The Phase-1 surface also ships type/schema-level contributions toward I-005-1/2/4/5 (the @ts-expect-error enum-exhaustiveness and discriminated-union narrowing proofs), but their canonical Invariants Test lands later (I-005-1 cross-phase integration; I-005-2 + I-005-4 at T4.6; I-005-5 at T4.7), so each is recorded against its own phase.
  - phase: 2
    task: [T2.1, T2.2, T2.3, T2.4, T2.5]
    pr: 159
    sha: 9b93b55
    merged_at: 2026-06-16
    files:
      - docs/architecture/schemas/local-sqlite-schema.md
      - docs/plans/005-provider-driver-contract-and-capabilities.md
      - packages/contracts/src/provider-driver.ts
      - packages/runtime-daemon/package.json
      - packages/runtime-daemon/src/migrations/0003-runtime-bindings.ts
      - packages/runtime-daemon/src/provider/__tests__/driver-capabilities-writer.test.ts
      - packages/runtime-daemon/src/provider/__tests__/phase-2-integration.test.ts
      - packages/runtime-daemon/src/provider/__tests__/provider-registry.test.ts
      - packages/runtime-daemon/src/provider/__tests__/runtime-binding-store.test.ts
      - packages/runtime-daemon/src/provider/driver-capabilities-writer.ts
      - packages/runtime-daemon/src/provider/provider-output-validation.ts
      - packages/runtime-daemon/src/provider/provider-registry.ts
      - packages/runtime-daemon/src/provider/runtime-binding-store.ts
      - packages/runtime-daemon/src/session/__tests__/migration-shape.test.ts
      - packages/runtime-daemon/src/session/__tests__/session-service.test.ts
      - packages/runtime-daemon/src/session/migration-runner.ts
      - pnpm-lock.yaml
    verifies_invariant: [I-005-1, I-005-2]
    spec_coverage: [Spec-005:43, Spec-005:45, Spec-005:55, Spec-005:56]
    notes: |
      Phase-2 tasks T2.1-T2.5 shipped as one daemon-persistence PR (migration 0003 + RuntimeBindingStore + ProviderRegistry + DriverCapabilitiesWriter + integration suite).
      verifies_invariant = the audit DAG-task union {I-005-1, I-005-2}. I-005-1 is canonically verified by the T2.5 daemon-local-authority integration test (binding round-trips through a fresh store with a conceptually-remote mock provider -- the Plan-005 Invariants I-005-1 "integration test, daemon-local with remote endpoint mock"). I-005-2 is verified at the daemon-registry/integration boundary by T2.3 (a direct call against an undeclared flag throws driver.capability_unsupported), T2.4 (the cache-writer gate), and T2.5 (the gate matrix).
      I-005-2's SDK-layer surface re-verifies at T4.6 (Phase 4); recording the same invariant in both phases is the established multi-layer convention (cf. Plan-003 I-003-2 recorded in both its Phase 2 and Phase 3 entries; Plan-002 I-002-3 in two phases) and is consistent with the Phase-1 note's "I-005-2 + I-005-4 at T4.6" projection, which named the SDK-layer canonical test -- not the sole verification site. I-005-4 (T4.6) and I-005-5 (T4.7) remain Phase-4 obligations and are not verified here.
      spec_coverage is the union of the T2.1-T2.5 audit "Spec coverage:" cites. Phase 2 AC2 (Spec-005:205 -- capability gating verified end-to-end against a real registry + store) is verified by the T2.5 integration suite. The two persisted provider-output fields without a contract-level invariant (DriverCapabilities.contractVersion, ProviderSessionHandle.resumeHandle) are bounded here at the T2.2 write seam, discharging the Phase-1-tracked obligation. AC3 (recovery-needed) remains Phase 3/4.
```

### Notes

<!-- Per-PR human commentary (round-trips, learnings, partial-ship details). Append-only. -->

## Done Checklist

- [ ] Phase 1 — Driver contract + capability schema + idempotency_class (T1.1-T1.6)
- [ ] Phase 2 — Provider registry + runtime-binding store + SQLite (T2.1-T2.5)
- [ ] Phase 3 — Codex driver (T3.1-T3.5) + Claude driver (T3.6-T3.10)
- [ ] Phase 4 — SDK exposure + degraded-fallback (T4.1-T4.7)
- [ ] All 5 invariants (I-005-1 through I-005-5) verified via tests
- [ ] All 6 cross-plan obligations (CP-005-1 through CP-005-6) discharged
- [ ] Acceptance criteria AC1, AC2, AC3 verified per the Phase Acceptance Mapping rows
- [ ] Required ADRs cited from Tasks/Invariants/Cross-Plan Obligations (ADR-005, ADR-011, ADR-015, ADR-017)
- [ ] Related docs updated (api-payload-contracts.md doc-mirror per T1.3 — `IdempotencyClass` + `ProviderToolMetadata` (ingress) + `NormalizedProviderToolMetadata` (normalized) + `GetCapabilitiesResult` shapes added immediately after the existing `interface DriverCapabilities` declaration without modifying that declaration; api-payload-contracts.md doc-mirror per T1.6 — `DriverResumeResult` discriminated union added immediately after the existing `DriverInterventionResult` shape; cross-plan-dependencies.md §3 row 131 adds Plan-005 → Plan-007-partial edge; cross-plan-dependencies.md §2 row 90 adds `provider-driver.ts` to the Plan-005-owned extenders cell)
