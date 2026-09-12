# Plan-001: Session Core

| Field | Value |
| --- | --- |
| **Status** | `completed` |
| **NNN** | `001` |
| **Slug** | `session-core` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-001: Session Core](../specs/001-session-core.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-002](../decisions/002-local-execution-shared-control-plane.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-006](../decisions/006-worktree-first-execution-mode.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-017](../decisions/017-shared-event-sourcing-scope.md), [ADR-018](../decisions/018-cross-version-compatibility.md), [ADR-019](../decisions/019-windows-v1-tier-and-pty-sidecar.md), [ADR-022](../decisions/022-v1-toolchain-selection.md), [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md). **Phase 1 ship-gate**: [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md) governs the engineering CI surface that lands in Phase 1 (accepted 2026-04-26 per [BL-100](../backlog.md)). **Phase 5 ship-gate (governance)**: [ADR-019](../decisions/019-windows-v1-tier-and-pty-sidecar.md) governs CP-001-1 / CP-001-2; [ADR-006](../decisions/006-worktree-first-execution-mode.md) bakes worktree paths into the daemon's session-spawn entry point per CP-001-2. |
| **Dependencies** | Phase 1–Phase 4: None (tier-entry plan; owns `0001-initial.ts` migration and forward-declares schema shape consumed by [Plan-002](./002-runtime-node-attach.md), [Plan-005](./005-session-event-taxonomy-and-audit-log.md), [Plan-020](./020-data-retention-and-gdpr.md)). Phase 5 only: [Plan-006](./006-local-ipc-and-daemon-control.md) partial-deliverable (Tier 1 IPC wire substrate + `session.*` namespace + SDK Zod layer per `Spec-006 §Wire Format`) and the Tier 1 control-plane bootstrap-deliverable (tRPC v11 server skeleton + `sessionRouter` HTTP handlers + SSE substrate for `SessionSubscribe`, now owned by [Plan-028](./028-remote-control.md)). See [Plan-006 §Execution Windows](./006-local-ipc-and-daemon-control.md#execution-windows-v1-carve-out). |
| **Cross-Plan Deps** | Cross-Plan Dependency Graph |

## Goal

Implement the minimum session creation, snapshot, and replay foundation used by all later features.

## Scope

This plan covers session ids, default channel creation, session-owner binding, local event append, and typed session read or subscribe APIs.

## Non-Goals

- Runtime-node attach
- Queue and intervention behavior

## Invariants

The following invariants are **load-bearing** and MUST be preserved across all Plan-001 PRs and downstream extensions. Any change that would weaken or remove an invariant requires a coordinated cross-plan amendment (see cross-plan-dependencies.md).

### I-001-2 — Sequence is the canonical replay key

Local Runtime Daemon SQLite replay MUST order `session_events` by `sequence ASC`, never by `monotonic_ns`. The `monotonic_ns` column is within-daemon debug data only (per [local-sqlite-schema §session_events](../architecture/schemas/local-sqlite-schema.md#session-events-plan-001-extended-by-plans-005-008-015)); it can be non-monotonic across rows after clock adjustments and MUST NOT influence replay or projection.

**Why load-bearing.** Replay determinism is the foundation for [ADR-017](../decisions/017-shared-event-sourcing-scope.md) event-sourcing semantics. Plan-005 (event taxonomy + integrity protocol) and Plan-013 (replay/recovery) build on this invariant.

**Verification.** Test D3 in §Test And Verification Plan asserts `Replay uses sequence not monotonic_ns even when monotonic_ns is non-monotonic across rows`.

### I-001-3 — Forward-declared columns are immutable in scope at Tier 1

The forward-declared columns and tables enumerated in §Cross-Plan Forward-Declared Schema (Plan-001 emits the DDL, downstream plans own the semantics) MUST NOT be re-shaped by Plan-001 PRs. Plan-001 ships the column types and nullability authoritatively at the Tier 1 migration; the corresponding semantics owners (Plan-005 integrity, Plan-020 GDPR, Plan-016 identity, Plan-002 version-floor) author all read/write logic at their own tiers.

**Why load-bearing.** Re-shaping a forward-declared column post-Tier-1 would force a breaking schema migration after V1 ships — the entire point of the forward-declaration pattern is that V1 ships immutable initial DDL.

**Verification.** Test D5 (migration-shape regression) reads `0001-initial.ts` via `PRAGMA table_info()` for `session_events`, `session_snapshots`, `user_keys`, and `schema_version`, asserts the column set matches the canonical schema docs.

## Cross-Plan Obligations

Plan-001 owns the daemon-side session lifecycle and the `PtyHost.spawn` entry-point wrapper. Two daemon-layer obligations (CP-001-1, CP-001-2) are declared by Plan-022 (Rust PTY Sidecar) and surface here for bidirectional citation locality, so a Plan-001 reviewer sees the obligations without first reading Plan-022. Each entry mirrors the `Plan-002 §Cross-Plan Obligations` shape: the obligation, the source citation, and the resolution.

### CP-001-1 — Sidecar-cleanup handler registers BEFORE Electron `will-quit`

[Plan-022 §Invariants I-022-4](./022-rust-pty-sidecar.md#i-022-4--daemons-sidecar-cleanup-handler-registers-before-electron-will-quit) declares that the daemon's sidecar-cleanup handler MUST register before Electron's `will-quit` handler. Under Electron's event-emitter semantics, registration order is run order; if the daemon's cleanup handler is late-registered, the renderer process terminates before active PTY sessions drain and child processes orphan to the global console (the `microsoft/node-pty#904` SIGABRT-on-exit class — primary source cited at [Plan-022 §Windows Implementation Gotchas Gotcha 4](./022-rust-pty-sidecar.md#4-electron-will-quit-ordering-vs-sidecar-shutdown)).

**Resolution.** Plan-001 Phase 5 (Client SDK and Desktop Bootstrap) authors the desktop-shell sidecar-lifecycle wiring at `apps/desktop/src/main/sidecar-lifecycle.ts` (the `apps/desktop/src/main/` directory is owned by [Plan-021 Tier 1 Partial substrate](./021-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) per BL-101 (a) resolution; Plan-001 Phase 5 authors the file content per CP-001-1 content-ownership) so the cleanup handler registers in the Electron `app.on('will-quit', ...)` slot **before** any other handler that depends on the renderer. The handler delegates to a single polymorphic `PtyHost.shutdown({ perSessionTimeoutMs, hostTimeoutMs })` call — both backends (`RustSidecarPtyHost` out-of-process; `NodePtyHost` in-process) implement the drain protocol per `packages/contracts/src/pty-host.ts`, so the wiring layer never sees a backend-specific surface (`ADR-019 §Decision` item 8: "Consumers never see the backend choice"). The contract pins the drain semantics: per-session `SIGTERM` → wait for `ExitCodeNotification` up to `perSessionTimeoutMs` → escalate to `SIGKILL` on timeout; then close the sidecar's stdin → wait for sidecar exit up to `hostTimeoutMs` → escalate to `taskkill /T /F /PID <sidecar-pid>` on hard timeout. In-process `NodePtyHost` vacuously satisfies the host fields (`sidecarExitedCleanly: true, taskkillEscalated: false`). Escalation matches §Cross-Plan Obligations CP-001-2 below for the same hard-stop pattern.

**Why surfaced in Plan-001.** This obligation lives at the desktop-shell session-lifecycle layer (Plan-001 owns the session-lifecycle daemon code), not at the sidecar protocol layer (Plan-022 supplies only the `PtyHost.close(sessionId)` and `KillRequest` primitives). Without the bidirectional citation, a Plan-001 reviewer would have no signal that the will-quit handler exists as a Plan-001 obligation; the asymmetry that the audit caught.

### CP-001-2 — `PtyHost.spawn(spec)` performs daemon-layer cwd-translation for worktree paths

[Plan-022 §Invariants I-022-5](./022-rust-pty-sidecar.md#i-022-5--spawnrequestcwd-carries-a-stable-path-daemon-performs-worktree-translation) declares that the sidecar's `SpawnRequest.cwd` MUST always carry a stable, unmovable parent directory; worktree paths live in the command-string-or-env layer above. Without daemon-layer translation, the sidecar would forward worktree paths verbatim to `portable-pty::PtySize::spawn_command`, Windows would lock the worktree directory (`ERROR_SHARING_VIOLATION`), and `git worktree remove` would fail until every spawned session under that worktree exited (the `microsoft/node-pty#647` class — primary source cited at [Plan-022 §Windows Implementation Gotchas Gotcha 5](./022-rust-pty-sidecar.md#5-spawn-locks-cwd-on-windows)).

**Resolution.** Plan-001 Phase 5 (Client SDK and Desktop Bootstrap) ships a daemon-layer `PtyHost.spawn` wrapper that intercepts `spec.cwd`, substitutes a stable parent directory (the daemon's working dir or user-home root) for the protocol-level `SpawnRequest.cwd`, and prepends a `cd <worktree-path> && ` shell prefix (or sets `CWD=<worktree-path>` env, depending on whether the agent CLI consumes `cd` semantics or env-based cwd). The wrapper sits in `packages/runtime-daemon/src/session/` (Plan-001's session lifecycle layer) so both `RustSidecarPtyHost` and `NodePtyHost` inherit the same translation — the constraint is OS-level, not backend-specific, per Plan-022 I-022-5.

**Why surfaced in Plan-001.** ADR-006 (Worktree-First Execution Mode) bakes worktree paths into the daemon's session-spawn entry point. The translation MUST happen between the daemon's logical worktree-path API and the sidecar's wire-protocol `SpawnRequest.cwd` — i.e., in Plan-001's session-lifecycle code, not in Plan-022's sidecar code (the sidecar deliberately does not know about worktree semantics, per Plan-022 I-022-3 / I-022-5). Plan-022 Phase 3 carries an explicit `**Precondition:**` line on this wrapper because the sidecar end-to-end test would surface `ERROR_SHARING_VIOLATION` on Windows CI without it.

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted (plan body)
- [x] **Phase 1 ship-gate**: [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md) — V1 CI/CD, Pre-Commit Hooks, and Release Automation accepted 2026-04-26 per [BL-100](../backlog.md). The engineering CI surface that lands in Phase 1 (`.github/workflows/{ci,release}.yml`, lefthook 2.1.6 pre-commit framework, commitlint 20.5.2, Renovate dependency-update config, Gitleaks v8.30+ secret scanner, release-please-action@v5 + actions/attest@v4 release skeleton, code-signing custody artifacts) is now governed by an accepted ADR.
- [x] Blocking open questions are resolved or explicitly deferred
- [x] **Plan-readiness audit complete per [`docs/operations/plan-implementation-readiness-audit-runbook.md`](../operations/plan-implementation-readiness-audit-runbook.md)** — Tier 1 audit pilot landed via PR #15 (merged 2026-04-28); see [Status Promotion Gate §1](../operations/plan-implementation-readiness-audit-runbook.md#status-promotion-gate). The Plan-006 / Plan-021 partial-substrate carve-out governance question is resolved via the `audit_status` phase-level precondition + `substrate_exempt` predicate per [runbook §Per-Phase Audit Semantics](../operations/plan-implementation-readiness-audit-runbook.md#per-phase-audit-semantics). Plan-021 carries the `substrate_exempt` declaration on its Tier 1 phase. Plan-006 partial Phases 1-3 were a legacy pre-audit coverage gap (NOT a `substrate_exempt` precedent — they ship Spec AC and fail criterion (3); see [runbook §Lessons Learned — Plan-006 partial is a coverage gap](../operations/plan-implementation-readiness-audit-runbook.md#plan-006-partial-is-a-coverage-gap-not-a-substrate-exemption-2026-05-17)), tracked via BL-113 and **closed 2026-05-18 via the Approach C full G1-G6 retroactive runbook pass** (see [BL-113 archive entry](../archive/backlog-archive.md) + `Plan-006 §Retroactive Audit Memo (BL-113, 2026-05-18)`); per-phase `audit_status: complete` YAML now lives on Plan-006 Phases 1-3 admitting `gatePhaseAuditCheckbox` for Plan-006 remainder Tier 3 dispatch. Audit-surfaced Spec AC follow-ups are tracked separately as BL-114 (`Spec-006 §Acceptance Criteria` — the per-method ACs for the `session.*` namespace — does NOT block Plan-001 Phase 5 because Plan-001 Phase 5 consumes the transport surface CP-006-4, not the spec ACs themselves), BL-115 (`LocalSubscription` producer/consumer rename — now `LocalSubscriptionProducer<T>` / `LocalSubscriptionConsumer<T>`), and BL-116 (cross-plan-dependencies row-89 wording).

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/session.ts`
- `packages/client-sdk/src/sessionClient.ts`
- `packages/runtime-daemon/src/session/session-service.ts`
- `packages/runtime-daemon/src/session/session-projector.ts`
- `packages/control-plane/src/sessions/session-directory-service.ts`
- `apps/desktop/src/renderer/src/session-bootstrap/`

## Repo Layout And Bootstrap

Workspace topology is authoritative in [Container Architecture](../architecture/container-architecture.md). Toolchain primitives, version pins, and two-tier Node target rules are authoritative in [ADR-022](../decisions/022-v1-toolchain-selection.md). Plan-001's first migration owns the bootstrap artifacts that wire those choices into the repo.

### Root Scaffolding

- `package.json` — workspace root with `"private": true`, `packageManager` and `engines.node` constraints per [ADR-022](../decisions/022-v1-toolchain-selection.md)
- `pnpm-workspace.yaml` — declares `packages/*` and `apps/*`
- `turbo.json` — `build`, `test`, `lint`, `typecheck`, and `dev` task pipelines at scaffold time; later tasks are added by the work that owns them (`test:coverage`, 2026-08-25)
- `tsconfig.base.json` — strict + `isolatedDeclarations: true` + ESM-only; per-package `tsconfig.json` extends base
- `.npmrc` — `node-linker=isolated` (required by [ADR-022](../decisions/022-v1-toolchain-selection.md) two-ABI native binding constraint)
- `.nvmrc` — pins the lower-tier Node target per [ADR-022](../decisions/022-v1-toolchain-selection.md)
- `eslint.config.mjs` and `prettier.config.js` at root

**Engineering CI surface** — `.github/workflows/{ci,release}.yml`, lefthook 2.1.6 pre-commit hook framework + `lefthook.yml`, `lint-staged.config.mjs`, commitlint 20.5.2 config (10-type set, drops `style`), Renovate config (`renovate.json5` with `minimumReleaseAge: 14 days`), `CODEOWNERS`, Gitleaks v8.30+ workflow, and code-signing custody artifacts (Apple Developer Individual + Azure Artifact Signing OIDC + Sigstore keyless + AWS KMS Ed25519 hot key + YubiHSM 2 cold key envelope) are owned by [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md) (accepted 2026-04-26 per [BL-100](../backlog.md)). Phase 1 lands the concrete artifact list per `ADR-023 §Decision`.

### Per-Package Scaffolding

Every `packages/*` and `apps/*` member receives a `package.json` (with `"type": "module"`, `engines.node` matching its tier per [ADR-022](../decisions/022-v1-toolchain-selection.md), and an `exports` map), a `tsconfig.json` extending base, and a `src/` directory.

Electron-bound packages (`apps/desktop/*`, `packages/runtime-daemon/*`) use the lower-tier Node target. Control-plane packages (`packages/control-plane/*`) use the upper-tier target. Shared packages consumed by both sides (`packages/contracts/*`, `packages/client-sdk/*`) target the lower tier as the lowest common denominator.

Vitest test-file discovery is owned by each package's own standalone `vitest.config.ts` — a plain `defineConfig` with no workspace-level config above it and no single project-wide test path; the suites aggregate through Turbo's `test` task (`turbo run test`), which invokes each package's own `vitest run`. The prevailing discovery glob is `src/**/__tests__/**/*.test.ts`; the exceptions are `packages/client-sdk/` (that glob plus `test/**/*.test.ts` for cross-workspace integration tests) and `apps/desktop/` (whose config declares two in-package `projects` — a Node `main` project on `test/**/*.test.ts` and a happy-dom `renderer` project on `src/renderer/**/__tests__/**/*.test.{ts,tsx}`). Several config headers name a root-level `vitest.config.ts` with `projects: [...]` as the longer-term shape per [ADR-022](../decisions/022-v1-toolchain-selection.md); it has not been authored. The Phase 1 sanity test lives at `packages/contracts/src/__tests__/sanity.test.ts`.

## Data And Storage Changes

Plan-001 owns two initial migrations — `packages/runtime-daemon/src/migrations/0001-initial.ts` (SQLite local-runtime) and `packages/control-plane/src/migrations/0001-initial.ts` (Postgres shared control-plane) — and declares the schema shape downstream plans depend on. The two engines are distinct per [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md) and ship under separate migration trees. The column-level definitions are canonical in the schema docs below; this plan body enumerates which elements are forward-declared for cross-plan consumers.

- Add the minimal `users` identity-anchor table (`id UUID PK`, `created_at TIMESTAMPTZ`) to Control Plane storage **before** any FK-bearing shared table. This anchor is required at Plan-001 migration time because `sessions.owner_user_id` and `runtime_node_attachments.user_id` both `REFERENCES users(id)`, and Plan-001/003 execute before Plan-016. Plan-001 owns the physical CREATE of the minimal shape only; identity/profile columns (`display_name`, `identity_ref`, `metadata`) and the `identity_mappings` side table are added by Plan-016 via additive ALTER migrations. See [Shared Postgres Schema §Users Identity Anchor](../architecture/schemas/shared-postgres-schema.md#users-identity-anchor-plan-001).
- Add the shared `sessions` table to Control Plane storage, with the session owner bound at create time on `owner_user_id UUID NOT NULL REFERENCES users(id)`. The `sessions` table carries `min_client_version TEXT` — NULL = no floor — forward-declared here per [ADR-018](../decisions/018-cross-version-compatibility.md) §Decision #1 (semver `"MAJOR.MINOR"` format) and §Decision #3 (monotonic session-floor enforcement); the control plane is authoritative for this field ([ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md)).
- Add local `session_events` and `session_snapshots` tables to Local Runtime Daemon SQLite.
- Forward-declare `session_events.pii_payload BLOB` (NULLable) per [Spec-020 §PII Data Map](../specs/020-data-retention-and-gdpr.md#pii-data-map) — semantics owned by Plan-020 (crypto-shred fan-out Path 1).
- Forward-declare the integrity-protocol columns on `session_events` — `monotonic_ns INTEGER NOT NULL`, `prev_hash BLOB NOT NULL`, `row_hash BLOB NOT NULL`, `daemon_signature BLOB NOT NULL`, `user_signature BLOB` — per [Spec-005 §Integrity Protocol](../specs/005-session-event-taxonomy-and-audit-log.md#integrity-protocol) (BLAKE3 row_hash + Ed25519 daemon_signature + RFC 8785 JCS canonical serialization hash chain; semantics owned by Plan-005).
- Forward-declare the `user_keys` table (per-user AES-256-GCM key custody; columns: `user_id` PK, `encrypted_key_blob`, `key_version`, `created_at`, `rotated_at`) per [Spec-020 §User Keys](../specs/020-data-retention-and-gdpr.md#user-keys) — semantics and DELETE-as-crypto-shred lifecycle owned by Plan-020.
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for canonical column definitions of `session_events`, `session_snapshots`, and `user_keys`.
- See [Shared Postgres Schema](../architecture/schemas/shared-postgres-schema.md) for canonical column definitions of `sessions` (including `owner_user_id` and `min_client_version`).

## Cross-Plan Forward-Declared Schema

Plan-001 emits the DDL above at tier entry (first migration). The downstream plans below own the read/write semantics and invariants for each forward-declared element. Engineers implementing Plan-001 MUST NOT add read/write logic for these columns; that logic belongs in the owner plan's implementation window.

| Forward-Declared Element | Semantics Owner | Invariant / Protocol |
| --- | --- | --- |
| `session_events.pii_payload` | [Plan-020](./020-data-retention-and-gdpr.md) | Encrypted under per-user AES-256-GCM key (key in `user_keys.encrypted_key_blob`); deleting the user's key row crypto-shreds this column by construction per [Spec-020 §Shred Fan-Out](../specs/020-data-retention-and-gdpr.md#shred-fan-out) Path 1 |
| `session_events.monotonic_ns / prev_hash / row_hash / daemon_signature / user_signature` | [Plan-005](./005-session-event-taxonomy-and-audit-log.md) | BLAKE3 hash chain + Ed25519 signatures over RFC 8785 JCS canonical bytes; `pii_payload` is excluded from canonical bytes but a `pii_ciphertext_digest` is embedded (one-way BLAKE3 over ciphertext) so signatures remain verifiable after crypto-shred per [Spec-020 §Signature Safety Under Shred](../specs/020-data-retention-and-gdpr.md#signature-safety-under-shred) |
| `user_keys` (table) | [Plan-020](./020-data-retention-and-gdpr.md) | Wrapped under daemon master key (XChaCha20-Poly1305); row DELETE = crypto-shred for all events authored by that user; rotation updates `key_version` and stamps `rotated_at` |
| `sessions.min_client_version` | [Plan-002](./002-runtime-node-attach.md) | Attach-time floor check: daemons below floor are admitted in read-only state; below-floor write attempts return typed `VERSION_FLOOR_EXCEEDED` per [ADR-018](../decisions/018-cross-version-compatibility.md) §Decision #4. Ejection is never the response (graceful degradation per [Spec-002 §Required Behavior](../specs/002-runtime-node-attach.md#required-behavior)) |
| `users` (minimal anchor: `id`, `created_at`) | [Plan-016](./016-identity-and-user-state.md) | Plan-001 creates the anchor row shape; no user rows are inserted until Plan-016's registration flow lands; Plan-016 adds `display_name`, `identity_ref`, `metadata`, and `identity_mappings` via additive ALTER migrations per [Shared Postgres Schema §Users and Identity](../architecture/schemas/shared-postgres-schema.md#users-and-identity-plan-016) |

## API And Transport Changes

- Add `SessionCreate`, `SessionRead`, and `SessionSubscribe` to the shared client SDK and daemon/control-plane contracts.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define session contracts and ids in `packages/contracts`.
2. Implement shared Control Plane session directory create and read paths.
3. Implement Local Runtime Daemon session event append and snapshot projection.
4. Add client SDK methods and desktop bootstrap wiring for create, read, and subscribe.

## Parallelization Notes

- Contract definitions and Control Plane storage work can proceed in parallel with Local Runtime Daemon projection scaffolding.
- Desktop renderer integration should wait until client SDK contracts are stable.

## Test And Verification Plan

The TDD test list below is enumerated and ordered by implementation dependency. Each test maps to one or more [Spec-001 acceptance criteria](../specs/001-session-core.md#acceptance-criteria). Tests run via Vitest 4.x projects per [ADR-022](../decisions/022-v1-toolchain-selection.md).

### Contract Layer (`packages/contracts/`)

| ID | Test | Asserts | Spec-001 AC |
| --- | --- | --- | --- |
| C1 | `SessionId.parse rejects malformed UUIDs` | id format invariant | (no direct AC; format invariant — precondition for AC1/AC3/AC4) |
| C2 | `SessionCreate payload rejects unknown fields` | request schema strictness | AC1 |
| C3 | `SessionEvent discriminated union round-trips through JSON` | event serialization | AC1, AC6 |
| C4 | `Resource limit error matches resource.limit_exceeded shape` | error contract | AC8 (wire shape) |

### Daemon Projection Layer (`packages/runtime-daemon/src/session/`)

| ID | Test | Asserts | Spec-001 AC |
| --- | --- | --- | --- |
| D1 | `Single SessionCreated event yields snapshot with session owner and main channel` | bootstrap projection | AC1 |
| D2 | `Replay reads events by sequence ASC and reproduces snapshot deterministically` | replay correctness; `sequence` is the canonical ordering key per [ADR-017](../decisions/017-shared-event-sourcing-scope.md) | AC6 |
| D3 | `Replay uses sequence not monotonic_ns even when monotonic_ns is non-monotonic across rows` | clock-skew defense; `monotonic_ns` is within-daemon debug data, never the replay key (per [local-sqlite-schema §session_events](../architecture/schemas/local-sqlite-schema.md#session-events-plan-001-extended-by-plans-005-008-015)) | AC6 |
| D4 | `Snapshot survives daemon restart and yields identical projection on rehydrate` | durability across restart | AC2, AC6 |
| D5 | `Migration-shape regression: column set in 0001-initial.ts matches canonical schema docs` | invariant verification — `PRAGMA table_info()` for `session_events`, `session_snapshots`, `user_keys`, `schema_version` matches canonical-schema-doc snapshot fixture | (no AC; verifies I-001-3) |

### Control Plane Layer (`packages/control-plane/`)

| ID | Test | Asserts | Spec-001 AC |
| --- | --- | --- | --- |
| P1 | `SessionCreate returns stable session id and persists to directory` | shared write | AC1, AC2 |
| P2 | `Second SessionCreate by same client does not silently fork` | no shadow sessions | AC5 |

### SDK And Integration Layer (`packages/client-sdk/`, integration)

| ID | Test | Asserts | Spec-001 AC |
| --- | --- | --- | --- |
| I1 | `SessionCreate then SessionRead returns identical session id` | round-trip | AC1, AC3 |
| I3 | `SessionSubscribe yields events in sequence ASC across reconnect` | reconnect ordering by canonical key | AC3, AC7 |
| I4 | `Reconnect after lost stream restores from snapshot, not client cache` | snapshot authority | AC6 |
| I5 | `Sidecar drain via PtyHost.shutdown() on app.on('will-quit'): registration position 0; per-session SIGTERM→SIGKILL escalation; host stdin-close→taskkill escalation; -1 crash sentinel suppressed; concurrent spawn during shutdown rejected` | verifies obligation CP-001-1 (also verifies inherited Plan-022 I-022-4) — files: `apps/desktop/test/sidecar-lifecycle.test.ts` (FIFO position 0 + drain orchestration), `packages/runtime-daemon/src/pty/__tests__/node-pty-host.shutdown.test.ts` (in-process backend drain semantics), `packages/runtime-daemon/src/pty/__tests__/rust-sidecar-pty-host.shutdown.test.ts` (out-of-process backend drain semantics + sidecar wind-down + crash-budget suppression) | (no AC; verifies CP-001-1) |
| I6 | `PtyHost.spawn rewrites worktree-path cwd to stable parent dir + cd-prefix or CWD-env; round-trip on Windows CI does not surface ERROR_SHARING_VIOLATION` | verifies obligation CP-001-2 (also verifies inherited Plan-022 I-022-5) — file: `packages/runtime-daemon/src/session/__tests__/spawn-cwd-translator.windows.test.ts` | (no AC; verifies CP-001-2) |

### Verification

- `pnpm turbo test` at workspace root green across all packages
- Manual smoke: create a session in the desktop client, reload it, and verify the timeline replays from the authoritative snapshot
- All 17 enumerated tests above pass before Plan-001 is marked complete (4 C-tier + 5 D-tier + 2 P-tier + 5 I-tier + 1 W-tier tooling — see Phase 1 §Tests; CP-001-1 / CP-001-2 coverage via I5 / I6 lands at Phase 5 against the [Plan-021 Tier 1 Partial substrate](./021-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) per BL-101 (a) resolution).
- Test ID prefixes map to Phases as follows: W → Phase 1, C → Phase 2, D → Phase 3, P → Phase 4, I → Phase 5. Each Phase's Goal line names the ID range it owns.
- Spec-001 AC7 (concurrent channels and runs without timeline corruption) receives full coverage at the integration boundary in [Plan-028](./028-remote-control.md) when the relay flows land. Plan-001 covers AC7 only partially via I3's reconnect-ordering invariant — single-daemon concurrent SQL writes serialize on SQLite's `UNIQUE(session_id, sequence)` constraint, leaving cross-daemon concurrency as the residual coverage gap.

## Implementation Phase Sequence

Plan-001 implementation lands as a sequence of small PRs. Each PR exercises one slice of the contract → daemon → control-plane → SDK vertical. Phase 1 is workspace scaffolding only; subsequent PRs add behavior.

### Phase 1 — Workspace Bootstrap

**Precondition:** [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md) accepted (per [BL-100](../backlog.md)) — gates Phase 1 only.

**Goal:** All packages compile; one passing tooling test verifies the workspace is healthy; the daemon's native-binding rebuild path is exercised at bootstrap; the engineering CI surface (per [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md)) is wired and gates subsequent PRs.

**Ship-gate:** [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md) — V1 CI/CD, Pre-Commit Hooks, and Release Automation — accepted 2026-04-26 per [BL-100](../backlog.md). The CI workflow files, lefthook + commitlint pre-commit framework, Renovate dependency-update config, Gitleaks secret scanner, `CODEOWNERS`, and code-signing custody scaffolding authored by ADR-023 land in this PR.

- Create root scaffolding (per § Repo Layout And Bootstrap above)
- Create empty `packages/contracts/`, `packages/client-sdk/`, `packages/runtime-daemon/`, `packages/control-plane/` skeletons with `package.json` + `tsconfig.json` + `src/index.ts` (no exports). At Phase 1, `apps/desktop/` is scaffolded as a placeholder workspace package only (single `src/index.ts` with the forward-declaration comment "split into `apps/desktop/src/{main,preload,renderer}/` per the electron-vite zero-config convention"); the substrate split (`apps/desktop/src/{main,preload,renderer}/`) is owned by [Plan-021 Tier 1 Partial](./021-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) and lands as a separate Tier 1 PR before Plan-001 Phase 5 (BL-101 (a) resolution). The `apps/desktop/src/renderer/src/session-bootstrap/` extension at Phase 5 lands once Plan-021 Tier 1 Partial repositions the placeholder.
- Install `better-sqlite3` 12.9+ as a workspace dep on `packages/runtime-daemon/` per [ADR-022](../decisions/022-v1-toolchain-selection.md). Even without imports, this exercises the postinstall native-binding rebuild path for the daemon target under `node-linker=isolated` at bootstrap time, surfacing native-rebuild integration risk before behavior PRs land.
- Install `pg` 8.20+ as a workspace dep on `packages/control-plane/` per [ADR-022](../decisions/022-v1-toolchain-selection.md)
- Wire engineering CI surface per [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md): `.github/workflows/{ci,release}.yml`, lefthook 2.1.6 + `lefthook.yml`, `lint-staged.config.mjs`, commitlint 20.5.2 config, Renovate config, Gitleaks workflow, `CODEOWNERS`, release-please-action@v5 + actions/attest@v4 release-automation skeleton (no actual release runs yet — first release is post-Plan-001 ship). The literal-file content for `lefthook.yml`, `CODEOWNERS`, `renovate.json5`, `eslint.config.mjs`, `prettier.config.js`, `commitlint.config.mjs`, and the three workflow files is the Phase 1 PR's authoring scope; `ADR-023 §Decision` pins versions and policy choices, the implementer of this Phase materializes the literal artifact contents.
- Verify: `pnpm install`, `pnpm turbo build`, `pnpm turbo typecheck`, and `pnpm turbo lint` all green; CI runs green on this PR; pre-commit hooks active locally; required-checks gate is enforced on subsequent PRs
- Single passing test (in `packages/contracts/src/__tests__/sanity.test.ts`): trivial sanity check that Vitest is wired (test ID **W1** per § Test And Verification Plan)

#### Tasks

##### T1.1 — Workspace root scaffolding

**Files:** `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.npmrc`, `.nvmrc` **Reference:** [§Repo Layout And Bootstrap →§Root Scaffolding](#root-scaffolding); [ADR-022](../decisions/022-v1-toolchain-selection.md) **Acceptance:** `pnpm install` succeeds; `pnpm-workspace.yaml` declares `packages/*` and `apps/*`; `tsconfig.base.json` has `"strict": true` + `"isolatedDeclarations": true` + ESM-only; `.npmrc` has `node-linker=isolated`; `.nvmrc` pins lower-tier Node target. **Spec coverage:** none (workspace-root bootstrap) **Verifies invariant:** none (workspace bootstrap)

##### T1.2 — Per-package skeletons (`apps/desktop/` ships placeholder; Plan-021 Tier 1 Partial repositions)

**Files:** `packages/{contracts,client-sdk,runtime-daemon,control-plane}/{package.json,tsconfig.json,src/index.ts}` + `apps/desktop/{package.json,tsconfig.json,src/index.ts}` (placeholder) **Acceptance:** each `package.json` has `"type": "module"`, `engines.node` per ADR-022 two-tier rule (lower for `contracts`/`client-sdk`/`runtime-daemon`/`apps/desktop`, upper for `control-plane`); each `tsconfig.json` extends `../../tsconfig.base.json`; each `src/index.ts` is empty (no exports). The `apps/desktop/src/index.ts` placeholder carries a forward-declaration comment ("split into `apps/desktop/src/{main,preload,renderer}/` per the electron-vite zero-config convention") that [Plan-021 Tier 1 Partial T-021p-1-1](./021-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) repositions during the substrate-split PR. **Spec coverage:** none (per-package scaffold) **Verifies invariant:** none

##### T1.3 — Native-binding installation surface

**Acceptance:** `better-sqlite3@^12.9` declared in `packages/runtime-daemon/package.json`; `pg@^8.20` declared in `packages/control-plane/package.json`; `pnpm install` triggers `better-sqlite3` postinstall native rebuild against the lower-tier Node ABI under `node-linker=isolated` without error. **Spec coverage:** none (native-binding install surface) **Verifies invariant:** none

##### T1.4 — Lint, format, type-check config

**Files:** `eslint.config.mjs`, `prettier.config.js` **Acceptance:** ESLint flat-config preset assembled per ADR-023; Prettier rules per repo convention; `pnpm turbo lint` and `pnpm turbo format:check` pass at workspace root. **Spec coverage:** none (lint/format/type-check config) **Verifies invariant:** none

##### T1.5 — Engineering CI surface (per ADR-023)

**Files:** `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/workflows/gitleaks.yml`, `lefthook.yml`, `lint-staged.config.mjs`, `commitlint.config.mjs`, `renovate.json5`, `CODEOWNERS` **Acceptance:** `pnpm turbo build`, `pnpm turbo typecheck`, `pnpm turbo lint`, `pnpm turbo test` all green; CI workflow runs green on this PR; pre-commit hooks active locally; required-checks gate enforced on subsequent PRs. **Spec coverage:** none (engineering CI surface) **Verifies invariant:** none

##### T1.6 — Vitest sanity test

**File:** `packages/contracts/src/__tests__/sanity.test.ts` **Acceptance:** `vitest run` returns exit 0; W1 (per § Tests below) green. **Spec coverage:** none (tooling readiness) **Verifies invariant:** none (tooling readiness)

#### Tests

| ID | Test | Asserts | Spec-001 AC |
| --- | --- | --- | --- |
| W1 | `vitest sanity: trivial assertion in packages/contracts passes` | Vitest 4.x project graph resolves; CI test job exits 0 | n/a (tooling) |

### Phase 2 — Contracts Package

**Precondition:** Phase 1 merged (workspace + CI surface in place).

**Goal:** Tests C1–C4 from § Test And Verification Plan go green.

- `packages/contracts/src/session.ts` — `SessionId`, `SessionCreate`, `SessionRead`, `SessionSubscribe` payload schemas. Plan-001 also exports `SessionSubscribeStream = AsyncIterable<EventEnvelope>` typed against an opaque `EventEnvelope` placeholder per **C-6** (forward-stub for Plan-005); the stub is narrowed when Plan-005 ships at Tier 3.
- `packages/contracts/src/event.ts` — `SessionEvent` discriminated union (V1 subset: `SessionCreated`, `ChannelCreated`). The discriminator surface in `api-payload-contracts.md` (per C-6) lands the same Phase as this file.
- `packages/contracts/src/error.ts` — `resource.limit_exceeded` shape; also `version.floor_exceeded` and `version.ceiling_exceeded` shapes per [ADR-018 §Decision #4](../decisions/018-cross-version-compatibility.md#decision). The runtime guards land in later Phases / Plans; Phase 2 ships the wire-shape contracts only.

#### Tasks

##### T2.1 — `SessionId`, `SessionCreate`, `SessionRead`, `SessionSubscribe` payload schemas

**Files:** `packages/contracts/src/session.ts`, `packages/contracts/test/session.test.ts` **Spec coverage:** Spec-001 AC1, AC3 **Verifies invariant:** none (contract layer)

##### T2.2 — `SessionEvent` discriminated union

**Files:** `packages/contracts/src/event.ts`, `packages/contracts/test/event.test.ts` **Spec coverage:** Spec-001 AC1, AC6 **Verifies invariant:** none

##### T2.3 — Error contracts: `resource.limit_exceeded`, `version.floor_exceeded`, `version.ceiling_exceeded`

**Files:** `packages/contracts/src/error.ts`, `packages/contracts/test/error.test.ts` **Spec coverage:** Spec-001 AC8 (wire shape); ADR-018 §Decision #4 version-error shapes **Verifies invariant:** none

### Phase 3 — Daemon Migration And Projection

**Precondition:** Phase 2 merged (contract types — `SessionEvent` discriminated union — are imported by the projector).

**Goal:** Tests D1–D5 go green.

- `packages/runtime-daemon/src/migrations/0001-initial.ts` migration creates `session_events`, `session_snapshots`, `user_keys`, `schema_version` (per § Data And Storage Changes; columns forward-declared but only `session_events` core columns are populated by Plan-001). The migration also INSERTs `(version=1, applied_at=now())` into `schema_version` so downstream plans (`0002-*.ts` onward) have a row to upsert against.
- **Pragmas.** Daemon bootstrap (or migration runner) MUST set `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000` per [Local SQLite Schema §Pragmas](../architecture/schemas/local-sqlite-schema.md#pragmas) before the first projector apply().
- **Integrity-column placeholder convention.** Plan-001's append path (`SessionService.append`, not the projector — `session-projector.ts` is a pure reducer) writes zero-fill placeholders into `prev_hash` and `row_hash` (`Buffer.alloc(32)` — 32 zero bytes each) and into `daemon_signature` (`Buffer.alloc(64)` — 64 zero bytes, the width `0001-initial.ts`'s `CHECK(length(daemon_signature) = 64)` enforces) to satisfy NOT NULL during the Tier 1 → Tier 3 gap. Plan-005 does NOT backfill or overwrite them: a row still carrying all three placeholders is refused fail-closed at verification time — `verifyRow` returns the twelfth `failureMode` value `signature_placeholder` before any Ed25519 verification is attempted, and the row is never "repaired" by signing it with a current key, because retro-signing an old record with a later key is a published attack no raw-Ed25519 verifier can detect after the fact (per [Spec-005 §Integrity Protocol](../specs/005-session-event-taxonomy-and-audit-log.md#integrity-protocol); the retired T2.6 backfill migration's provenance is in [Plan-005 §Progress Log](./005-session-event-taxonomy-and-audit-log.md#progress-log)). No such row exists in any durable database — a verified state rather than a forecast: `runtime-daemon` has no dependents in any workspace `package.json`, declares no `bin` entry, is `private` at version `0.0.0` with no release, and every `openDatabase` caller sits under `__tests__/`, so no production writer is wired anywhere yet. Plan-005 T3.1's `EventLogService.append` is the INTENDED sole durable writer and it signs; what made that hold in practice was a sequencing obligation rather than a property of the code as it then stood, because `SessionService.append` below wrote the three placeholders unguarded and Plan-002's shipped `RuntimeNodeEventEmitter` routed through it. Plan-005 T3.1 therefore carries the precondition to retire or guard this path before any durable writer is wired — **guard + decouple legs discharged 2026-07-28 (PR #272)**: `SessionService.append` now throws unless constructed with the test-only `allowUnsignedPlaceholderAppend` opt-in, and Plan-002's emitter depends on the structural `SessionEventLog` seam in `node-event-emitter.ts` rather than on `SessionService` — a seam that is synchronous-transactional by contract (the emitter refuses a thenable `append` result fail-closed), so the remaining leg rides T3.1 itself as a re-point: T3.1 re-points the emitter onto its durable append path and restructures the producers' dual-write atomicity around `withSessionAppendLock`, rather than injecting the async `EventLogService.append` into this seam. See [§Cross-Plan Forward-Declared Schema](#cross-plan-forward-declared-schema).
- `packages/runtime-daemon/src/session/session-projector.ts` — single-event-to-snapshot projection. Projector signatures: `apply(snapshot: Snapshot, event: SessionEvent): Snapshot`; `replay(events: ReadonlyArray<EventRow>): Snapshot` ordered by `sequence ASC` per I-001-2. `Snapshot` shape per [api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md) (Tier 1 Plan-001 block, `SessionSnapshot`).
- `packages/runtime-daemon/src/session/session-service.ts` — append + replay paths. Service signatures: `SessionService.create(req: SessionCreateRequest): Promise<SessionCreateResponse>`; `read(req: SessionReadRequest): Promise<SessionReadResponse>`; `subscribe(req: SessionSubscribeRequest): SessionSubscribeStream` (`LocalSubscriptionProducer<T>` per Plan-006 partial substrate's IPC shape).
- Storage driver: `better-sqlite3` 12.9+ per [ADR-022](../decisions/022-v1-toolchain-selection.md) (already installed in Phase 1). Replay key: `sequence` per [ADR-017](../decisions/017-shared-event-sourcing-scope.md).

#### Tasks

##### T3.1 — `0001-initial.ts` migration + pragmas

**Files:** `packages/runtime-daemon/src/migrations/0001-initial.ts`, daemon bootstrap shim that applies pragmas **Spec coverage:** Spec-001 AC2 (durability) **Verifies invariant:** I-001-3 (forward-declared shape stable, verified by D5)

##### T3.2 — Projector reducer + replay

**Files:** `packages/runtime-daemon/src/session/session-projector.ts`, `packages/runtime-daemon/src/session/test/session-projector.test.ts` **Spec coverage:** Spec-001 AC1, AC6 **Verifies invariant:** I-001-2 (sequence ASC replay)

##### T3.3 — Service surface (create/read/subscribe)

**Files:** `packages/runtime-daemon/src/session/session-service.ts`, `packages/runtime-daemon/src/session/test/session-service.test.ts` **Spec coverage:** Spec-001 AC1, AC2, AC6 **Verifies invariant:** none (driver-agnostic; D1-D4 verify behavior)

##### T3.4 — Migration-shape regression test

**Files:** `packages/runtime-daemon/src/migrations/test/migration-shape.test.ts` **Spec coverage:** none (invariant-only) **Verifies invariant:** I-001-3 (D5)

### Phase 4 — Control Plane Directory

**Precondition:** Phase 2 merged (control-plane imports `SessionCreate` / `SessionRead` payload schemas from contracts). Phase 3 is independent and may land in either order; the two are decoupled at the contract boundary.

**Goal:** Tests P1–P2 go green.

- `packages/control-plane/src/migrations/0001-initial.ts` migration creates `users` (minimal anchor: `id`, `created_at`) and `sessions` (with `owner_user_id` and `min_client_version`, per § Data And Storage Changes), plus the canonical indexes per [Shared Postgres Schema §Sessions](../architecture/schemas/shared-postgres-schema.md#sessions-plan-001) (`idx_sessions_state`, `idx_sessions_owner_user`).
- **Migration-order invariant.** `CREATE TABLE users` MUST precede `CREATE TABLE sessions` per [Shared Postgres Schema §Migration-order invariant](../architecture/schemas/shared-postgres-schema.md#users-identity-anchor-plan-001) — both `sessions.owner_user_id` and any later FK-bearing table resolve against the anchor.
- **`min_client_version` boundary.** The column ships forward-declared (NULL default) only; Plan-001 ships the column shape but does NOT author read/write logic per [§Cross-Plan Forward-Declared Schema](#cross-plan-forward-declared-schema) and [I-001-3](#i-001-3--forward-declared-columns-are-immutable-in-scope-at-tier-1). Attach-time floor enforcement is owned by [Plan-002](./002-runtime-node-attach.md) per [Spec-002 §Required Behavior](../specs/002-runtime-node-attach.md#required-behavior).
- `packages/control-plane/src/sessions/session-directory-service.ts` — create and read paths. `createSession` accepts a daemon-assigned `id` (UUID v7 per RFC 9562; see [Shared Postgres Schema §Sessions](../architecture/schemas/shared-postgres-schema.md#sessions-plan-001)) and uses idempotent upsert (`ON CONFLICT (id) DO UPDATE` returning the row) for retry-after-crash safety per [domain/session-model.md §Local-Only Reconciliation](../domain/session-model.md#local-only-reconciliation). Owner identity binds at first create: the conflict clause does not assign `owner_user_id`, so `RETURNING owner_user_id` yields the persisted owner and a mismatch against the caller is rejected before commit.
- Storage driver: `pg` 8.20+ per [ADR-022](../decisions/022-v1-toolchain-selection.md) (already installed in Phase 1).

#### Tasks

##### T4.1 — `0001-initial.ts` Postgres migration

**Files:** `packages/control-plane/src/migrations/0001-initial.ts` **Spec coverage:** Spec-001 AC2 (durability) **Verifies invariant:** none (migration only; I-001-3 verified by D5 schema-shape)

##### T4.2 — `SessionDirectoryService` create/read paths

**Files:** `packages/control-plane/src/sessions/session-directory-service.ts` **Spec coverage:** Spec-001 AC1, AC2, AC5 **Verifies invariant:** none (idempotent-upsert owner binding, verified by P2)

### Phase 5 — Client SDK And Desktop Bootstrap

**Goal:** Tests I1, I3, and I4 go green; the manual desktop smoke test passes.

**Precondition:** Phase 5 ships in four lanes with per-task gating, not as a single monolithic gate. Each lane unblocks when its named upstream substrate is at HEAD on `develop`. The per-task `Files:` rows at T5.1–T5.5 below define the per-lane boundaries.

- **Lane A** (T5.1, T5.5 — `sessionClient.ts` + `pg.Pool`-backed `Querier` composition): unblocks once this amendment lands. T5.1 consumes the merged [Plan-006 Tier 1 Partial sequence PRs #1–#3](./006-local-ipc-and-daemon-control.md#tier-1-partial-pr-sequence) (GitHub PRs #16 / #17 / #19 — SecureDefaults Bootstrap, Wire Substrate, `session.*` Handlers + SDK Layer) and the merged Tier 1 control-plane bootstrap (GitHub PR #21 — tRPC v11 server + `sessionRouter` + SSE substrate). T5.5 is pure `packages/control-plane/` work with no cross-plan substrate dependency.
- **Lane B** (T5.4 — `spawn-cwd-translator.ts`): unblocks once [Plan-022 T-022-2-1](./022-rust-pty-sidecar.md) ships the `PtyHostContract` interface at `packages/contracts/src/pty-host.ts`.
- **Lane C** (T5.2 — `apps/desktop/src/renderer/src/session-bootstrap/` renderer wiring): unblocks once [Plan-021 Tier 1 Partial Phase 1](./021-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) ships the `apps/desktop/src/{main,preload,renderer}/` workspace package substrate (BL-101 (a) resolution): the directory tree + electron-vite v5 toolchain + minimal entrypoints that T5.2 extends with content. T5.2 also installs the renderer-unit-test infrastructure (`@testing-library/react`, `happy-dom`, `apps/desktop/vitest.config.ts`, renderer sibling test-tsconfig (`apps/desktop/src/renderer/tsconfig.test.json`)) not shipped by Plan-021 Tier 1 Partial Phase 1's substrate — substrate-gap completion bundled with the feature work in PR #77.
- **Lane D** (T5.3 — `apps/desktop/src/main/sidecar-lifecycle.ts`): unblocks once both (i) [Plan-021 Tier 1 Partial Phase 1](./021-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) AND (ii) [Plan-022 Phase 3](./022-rust-pty-sidecar.md) ship — the latter supplies the `PtyHost.close(sessionId)` + `KillRequest` primitives the lifecycle handler consumes.

Phase 1–Phase 4 may proceed independently; the per-lane substrate dependencies only bind at Phase 5.

- `packages/client-sdk/src/sessionClient.ts` — `create`, `read`, `subscribe` methods over the daemon and control-plane transports.
  - **Daemon transport** (`create` / `read` / `subscribe` over local IPC): consumes the Plan-006 partial-deliverable substrate — JSON-RPC 2.0 + LSP-style Content-Length framing, the `session.*` JSON-RPC method namespace, and the SDK Zod layer (~500–1000 LOC per [Spec-006 §Wire Format](../specs/006-local-ipc-and-daemon-control.md#wire-format)). `subscribe` rides the JSON-RPC 2.0 streaming primitive (Plan-006 partial substrate's `LocalSubscriptionProducer<T>` shape).
  - **Control-plane transport** (`create` / `read` / `subscribe` over HTTP/SSE): consumes the Tier 1 control-plane bootstrap substrate (now owned by [Plan-028](./028-remote-control.md)) — tRPC v11 server skeleton + `sessionRouter` HTTP handlers wrapping the existing `packages/control-plane/src/sessions/session-directory-service.ts` (shipped in Phase 4). `subscribe` is request-only on the wire — the response is an `AsyncIterable<EventEnvelope>` SSE stream per `packages/contracts/src/session.ts#SessionSubscribeRequest`.
- `apps/desktop/src/renderer/src/session-bootstrap/` — minimal renderer wiring that calls `sessionClient.create` and renders the resulting session. The directory tree is owned by [Plan-021 Tier 1 Partial](./021-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence); Plan-001 Phase 5 authors the file content here per BL-101 (a) resolution.
- `apps/desktop/src/main/sidecar-lifecycle.ts` — sidecar-cleanup handler registered **before** Electron `app.on('will-quit', ...)` per §Cross-Plan Obligations CP-001-1. Delegates to the polymorphic `PtyHost.shutdown({ perSessionTimeoutMs: 2000, hostTimeoutMs: 2000 })` (defined on the `PtyHost` interface at `packages/contracts/src/pty-host.ts`) which runs per-session SIGTERM→SIGKILL escalation (2 s per-session bounded timeout) AND sidecar-process stdin-close → child-exit await → `taskkill /T /F /PID` escalation (2 s host bounded timeout). The lifecycle wiring layer never touches a backend-specific surface (`ADR-019 §Decision` item 8 polymorphism: "Consumers never see the backend choice"). The `apps/desktop/src/main/` directory is owned by [Plan-021 Tier 1 Partial](./021-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence); Plan-001 Phase 5 authors the file content here per BL-101 (a) resolution + CP-001-1 content-ownership.
- `packages/runtime-daemon/src/session/spawn-cwd-translator.ts` — daemon-layer `PtyHost.spawn(spec)` wrapper per §Cross-Plan Obligations CP-001-2; substitutes a stable parent dir for `SpawnRequest.cwd` and prepends a `cd <worktree-path> && ` shell prefix (or sets `CWD=<worktree-path>` env per agent CLI conventions). Wraps both `RustSidecarPtyHost` and `NodePtyHost` because the constraint is OS-level. **AMBIGUOUS** — the per-driver dispatch (cd-prefix for shell sessions; CWD-env for `claude-driver` / `codex-driver` agent CLIs that consume `CWD` env) is named per-target in the implementer's PR; if the dispatch table is non-trivial, a Plan-001 amendment lands the explicit driver→strategy mapping (currently the working assumption: shell sessions use cd-prefix; agent CLIs use CWD env). The cd-prefix strategy mutates the command string (visible to Plan-005 audit-log canonical hash); CWD-env mutates process environment (invisible to canonical bytes) — pick is consequential to integrity protocol but Plan-005 owns the integrity test that catches inconsistency.
- Compose a `pg.Pool`-backed `Querier` for `SessionDirectoryService` (the Phase 4 service is constructed against `Querier` and is driver-agnostic; Phase 4 ships only a PGlite path because the integration tests run on the in-process driver).

#### Tasks

##### T5.1 — `sessionClient.ts` daemon + control-plane transport

**Files:** `packages/client-sdk/src/sessionClient.ts`, `packages/client-sdk/test/sessionClient.integration.test.ts` **Spec coverage:** Spec-001 AC1, AC3, AC6 **Verifies invariant:** none (integration-layer wrapper)

##### T5.2 — `apps/desktop/src/renderer/src/session-bootstrap/` renderer wiring

**Files:** `apps/desktop/src/renderer/src/session-bootstrap/index.ts`, `apps/desktop/src/renderer/src/session-bootstrap/SessionBootstrap.tsx`, `apps/desktop/src/renderer/src/session-bootstrap/__tests__/SessionBootstrap.test.tsx`, `apps/desktop/src/renderer/src/App.tsx`, `apps/desktop/package.json`, `apps/desktop/vitest.config.ts`, `apps/desktop/src/renderer/tsconfig.json`, `apps/desktop/src/renderer/tsconfig.test.json` **Acceptance:** the component invokes `sessionClient.create` (over the bridge → daemon transport per T5.1) on mount, renders a placeholder while pending, swaps to a session-summary view on resolve, and surfaces the error envelope on reject. The `App.tsx` placeholder shipped by [Plan-021 Tier 1 Partial T-021p-1-5](./021-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) routes to this component; the manual desktop smoke test passes per §Verification. **Spec coverage:** Spec-001 AC1 **Verifies invariant:** none (renderer composition over the bridge surface)

##### T5.3 — `apps/desktop/src/main/sidecar-lifecycle.ts` will-quit drain orchestration via polymorphic `PtyHost.shutdown()`

**Files:** `packages/contracts/src/pty-host.ts` (extends `PtyHost` interface with `shutdown(options): Promise<DrainResult>` + exports `DrainResult`), `packages/runtime-daemon/src/pty/node-pty-host.ts` (in-process `shutdown()` implementation), `packages/runtime-daemon/src/pty/rust-sidecar-pty-host.ts` (out-of-process `shutdown()` implementation with sidecar wind-down + crash-budget suppression), `packages/runtime-daemon/src/session/__tests__/spawn-cwd-translator.windows.test.ts` (RecordingPtyHost structural-conformance stub), `apps/desktop/src/main/sidecar-lifecycle.ts` (lifecycle wiring module — Shape A lazy `PtyHostGetter`), `apps/desktop/src/main/index.ts` (registers `registerSidecarLifecycle(app, () => null)` at position 0), `apps/desktop/test/sidecar-lifecycle.test.ts` (FIFO position 0 + drain orchestration tests), `packages/runtime-daemon/src/pty/__tests__/node-pty-host.shutdown.test.ts` (in-process backend tests), `packages/runtime-daemon/src/pty/__tests__/rust-sidecar-pty-host.shutdown.test.ts` (out-of-process backend tests — verifies I5 — CP-001-1 + Plan-022 I-022-4) **Acceptance:** module exports `registerSidecarLifecycle(app: App, getPtyHost: PtyHostGetter, deps?: SidecarLifecycleDeps): void`; calling it before any `app.on('will-quit', ...)` registration in `apps/desktop/src/main/index.ts` (per [Plan-021 T-021p-1-3](./021-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) — the entrypoint exposes the registration slot) handles will-quit by delegating to the polymorphic `PtyHost.shutdown({ perSessionTimeoutMs: 2000, hostTimeoutMs: 2000 })` which drains active sessions via per-session SIGTERM→SIGKILL escalation (2 s per-session bounded timeout) and winds down the sidecar process via stdin-close → child-exit wait → taskkill /T /F /PID escalation (2 s host bounded timeout). The host shutdown sequence is terminal — the host instance refuses new spawns post-shutdown entry; the deliberate sidecar exit suppresses the `-1` crash sentinel and skips crash-budget accounting per `shuttingDown` flag. ADR-019 §Decision item 8 polymorphism preserved: the wiring layer never touches a backend-specific surface. **Spec coverage:** none (verifies obligation CP-001-1 + inherited Plan-022 I-022-4) **Verifies invariant:** I-022-4 (inherited from Plan-022 together with obligation CP-001-1; exercised end-to-end by test I5)

##### T5.4 — `spawn-cwd-translator.ts` daemon-layer cwd-translator

**Files:** `packages/runtime-daemon/src/session/spawn-cwd-translator.ts`, `packages/runtime-daemon/src/session/__tests__/spawn-cwd-translator.test.ts` (Linux/Mac unit-only) + `packages/runtime-daemon/src/session/__tests__/spawn-cwd-translator.windows.test.ts` (Windows CI integration — verifies I6 / CP-001-2) **Spec coverage:** none (daemon-internal wrapper) **Verifies invariant:** none (verifies obligation CP-001-2; verifies inherited Plan-022 I-022-5)

##### T5.5 — `pg.Pool`-backed `Querier` composition

**Files:** `packages/control-plane/src/sessions/session-directory-service.ts` (constructor wiring), `packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts` (extends with pool-checkout-and-release path) **Spec coverage:** Spec-001 AC1, AC2 **Verifies invariant:** none (driver-agnostic Querier composition)

After Phase 5 lands green and the manual smoke passes, Plan-001 is complete.

## Rollout Order

1. Ship contracts and storage migrations
2. Enable create and read behind internal feature flag
3. Enable live subscribe once replay is stable

## Rollback Or Fallback

- Disable the create endpoint and keep `local-only` session bootstrap if shared session flows regress.

## Risks And Blockers

- Event ordering mistakes between local and shared projections
- Unresolved `local-only` session promotion semantics

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
    pr: 6
    sha: ca22530
    merged_at: 2026-04-27
    files:
      - .claude/skills/claude-md-audit/SKILL.md
      - .claude/skills/claude-md-audit/evals/README.md
      - .claude/skills/claude-md-audit/evals/test-suite.json
      - .claude/skills/plan-execution/SKILL.md
      - .claude/skills/plan-execution/references/failure-modes.md
      - .claude/skills/plan-execution/references/state-recovery.md
      - .claude/skills/plan-execution/references/subagent-roles.md
      - .claude/skills/update-docs/SKILL.md
      - .github/CODEOWNERS
      - .github/workflows/ci.yml
      - .github/workflows/gitleaks.yml
      - .github/workflows/release.yml
      - .gitignore
      - .markdownlint-cli2.yaml
      - .npmrc
      - .nvmrc
      - .prettierignore
      - .release-please-manifest.json
      - AGENTS.md
      - CLAUDE.md
      - CONTRIBUTING.md
      - README.md
      - apps/desktop/package.json
      - apps/desktop/src/index.ts
      - apps/desktop/tsconfig.json
      - apps/desktop/tsconfig.test.json
      - assets/hero/cli-terminal.html
      - assets/hero/desktop-app.html
      - commitlint.config.mjs
      - docs/architecture/component-architecture-control-plane.md
      - docs/architecture/component-architecture-desktop-app.md
      - docs/architecture/component-architecture-local-daemon.md
      - docs/architecture/container-architecture.md
      - docs/architecture/contracts/api-payload-contracts.md
      - docs/architecture/contracts/error-contracts.md
      - docs/architecture/cross-plan-dependencies.md
      - docs/architecture/data-architecture.md
      - docs/architecture/deployment-topology.md
      - docs/architecture/observability-architecture.md
      - docs/architecture/schemas/local-sqlite-schema.md
      - docs/architecture/security-architecture.md
      - docs/architecture/v1-feature-scope.md
      - docs/archive/backlog-archive.md
      - docs/decisions/000-adr-template.md
      - docs/decisions/001-session-is-the-primary-domain-object.md
      - docs/decisions/002-local-execution-shared-control-plane.md
      - docs/decisions/003-daemon-backed-queue-and-interventions.md
      - docs/decisions/004-sqlite-local-state-and-postgres-control-plane.md
      - docs/decisions/005-provider-drivers-use-a-normalized-interface.md
      - docs/decisions/006-worktree-first-execution-mode.md
      - docs/decisions/007-device-trust-and-permission-model.md
      - docs/decisions/008-default-transports-and-relay-boundaries.md
      - docs/decisions/009-json-rpc-ipc-wire-format.md
      - docs/decisions/010-paseto-webauthn-mls-auth.md
      - docs/decisions/011-generic-intervention-dispatch.md
      - docs/decisions/012-cedar-approval-policy-engine.md
      - docs/decisions/013-reserved.md
      - docs/decisions/014-trpc-control-plane-api.md
      - docs/decisions/015-v1-feature-scope-definition.md
      - docs/decisions/016-electron-desktop-shell.md
      - docs/decisions/017-shared-event-sourcing-scope.md
      - docs/decisions/018-cross-version-compatibility.md
      - docs/decisions/019-windows-v1-tier-and-pty-sidecar.md
      - docs/decisions/020-v1-deployment-model-and-oss-license.md
      - docs/decisions/021-cli-identity-key-storage-custody.md
      - docs/decisions/022-v1-toolchain-selection.md
      - docs/decisions/023-v1-ci-cd-and-release-automation.md
      - docs/decisions/024-agentic-plan-execution-methodology.md
      - docs/domain/agent-channel-and-run-model.md
      - docs/domain/artifact-diff-and-approval-model.md
      - docs/domain/glossary.md
      - docs/domain/queue-and-intervention-model.md
      - docs/domain/repo-workspace-worktree-model.md
      - docs/domain/run-state-machine.md
      - docs/domain/runtime-node-model.md
      - docs/domain/session-model.md
      - docs/domain/trust-and-identity.md
      - docs/domain/user-and-device-model.md
      - docs/domain/workflow-model.md
      - docs/domain/workflow-phase-model.md
      - docs/operations/cedar-policy-signing-and-rotation.md
      - docs/operations/control-plane-runbook.md
      - docs/operations/local-daemon-runbook.md
      - docs/operations/local-persistence-repair-and-restore.md
      - docs/operations/provider-failure-runbook.md
      - docs/operations/replay-and-audit-runbook.md
      - docs/operations/repo-and-worktree-recovery.md
      - docs/operations/self-host-secure-defaults.md
      - docs/operations/stuck-run-debugging.md
      - docs/plans/000-plan-template.md
      - docs/plans/001-session-core.md
      - docs/plans/002-runtime-node-attach.md
      - docs/plans/003-queue-steer-pause-resume.md
      - docs/plans/004-provider-driver-contract-and-capabilities.md
      - docs/plans/005-session-event-taxonomy-and-audit-log.md
      - docs/plans/006-local-ipc-and-daemon-control.md
      - docs/plans/007-repo-attachment-and-workspace-binding.md
    verifies_invariant: []
    spec_coverage: []
    notes: |
      Phase 1 — Workspace Bootstrap. Multi-task PR predates atomic-PR-per-task discipline. Backfilled 2026-05-10 via operator hand-curation; cross-validated against scripts/rebuild-shipment-manifest.mjs gh ground truth.
  - phase: 2
    task: [T2.1, T2.2, T2.3]
    pr: 8
    sha: 6166fa9
    merged_at: 2026-04-27
    files:
      - packages/contracts/package.json
      - packages/contracts/src/__tests__/error.test.ts
      - packages/contracts/src/__tests__/session-create.test.ts
      - packages/contracts/src/__tests__/session-event.test.ts
      - packages/contracts/src/__tests__/session-id.test.ts
      - packages/contracts/src/error.ts
      - packages/contracts/src/event.ts
      - packages/contracts/src/index.ts
      - packages/contracts/src/session.ts
      - pnpm-lock.yaml
    verifies_invariant: []
    spec_coverage: ["Spec-001 AC1", "Spec-001 AC3", "Spec-001 AC4", "Spec-001 AC6", "Spec-001 AC8"]
    notes: |
      Phase 2 — Contracts Package. Multi-task PR predates. Backfilled 2026-05-10.
  - phase: 3
    task: [T3.1, T3.2, T3.3, T3.4]
    pr: 9
    sha: 93f1e35
    merged_at: 2026-04-27
    files:
      - .npmrc
      - packages/runtime-daemon/package.json
      - packages/runtime-daemon/src/index.ts
      - packages/runtime-daemon/src/migrations/0001-initial.ts
      - packages/runtime-daemon/src/session/__tests__/migration-race-loader.mjs
      - packages/runtime-daemon/src/session/__tests__/migration-race-worker.mjs
      - packages/runtime-daemon/src/session/__tests__/session-projector.test.ts
      - packages/runtime-daemon/src/session/__tests__/session-service.test.ts
      - packages/runtime-daemon/src/session/index.ts
      - packages/runtime-daemon/src/session/migration-runner.ts
      - packages/runtime-daemon/src/session/session-projector.ts
      - packages/runtime-daemon/src/session/session-service.ts
      - packages/runtime-daemon/src/session/types.ts
      - packages/runtime-daemon/vitest.config.ts
      - pnpm-lock.yaml
    verifies_invariant: [I-001-2, I-001-3]
    spec_coverage: ["Spec-001 AC1", "Spec-001 AC2", "Spec-001 AC4", "Spec-001 AC6"]
    notes: |
      Phase 3 — Daemon Migration And Projection. Multi-task PR predates. Backfilled 2026-05-10.
  - phase: 4
    task: [T4.1, T4.2, T4.3, T4.4]
    pr: 10
    sha: c723b18
    merged_at: 2026-04-27
    files:
      - docs/architecture/cross-plan-dependencies.md
      - docs/architecture/schemas/shared-postgres-schema.md
      - docs/plans/001-session-core.md
      - packages/contracts/src/session.ts
      - packages/control-plane/package.json
      - packages/control-plane/src/index.ts
      - packages/control-plane/src/migrations/0001-initial.ts
      - packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts
      - packages/control-plane/src/sessions/migration-runner.ts
      - packages/control-plane/src/sessions/session-directory-service.ts
      - packages/control-plane/vitest.config.ts
      - pnpm-lock.yaml
    verifies_invariant: []
    spec_coverage: ["Spec-001 AC1", "Spec-001 AC2", "Spec-001 AC4", "Spec-001 AC5", "Spec-001 AC8"]
    notes: |
      Phase 4 — Control Plane Directory. Multi-task PR predates. Backfilled 2026-05-10.
  - phase: 5
    task: T5.1
    pr: 30
    sha: 7e4ae47
    merged_at: 2026-05-06
    files:
      - .claude/skills/plan-execution/scripts/__tests__/preflight.test.mjs
      - .claude/skills/plan-execution/scripts/preflight-contract.md
      - .claude/skills/plan-execution/scripts/preflight.mjs
      - .github/workflows/docs-corpus.yml
      - docs/plans/001-session-core.md
      - docs/superpowers/plans/2026-05-03-plan-execution-housekeeper-implementation.md
      - packages/client-sdk/src/index.ts
      - packages/client-sdk/src/sessionClient.ts
      - packages/client-sdk/test/sessionClient.integration.test.ts
    verifies_invariant: []
    spec_coverage: ["Spec-001 AC1", "Spec-001 AC3", "Spec-001 AC4", "Spec-001 AC6"]
    notes: |
      Phase 5 Lane A T5.1 — sessionClient.ts (daemon JSON-RPC + control-plane tRPC/SSE transports). First atomic post-PR for Plan-001. See `### Notes` subsection for the full PR #30 round-trip narrative.
  - phase: 5
    task: T5.5
    pr: 36
    sha: a1ef5be
    merged_at: 2026-05-11
    files:
      - packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts
      - packages/control-plane/src/sessions/session-directory-service.ts
    verifies_invariant: []
    spec_coverage: ["Spec-001 AC1", "Spec-001 AC2", "Spec-001 AC4"]
    notes: |
      Phase 5 Lane A T5.5 — `pg.Pool`-backed `Querier` composition for `SessionDirectoryService`. Adds three factories: `createPgPoolQuerier(pool: Pool): Querier` (per-query auto-checkout/release), `createPoolClientQuerier(client: PoolClient): Querier` (in-tx held-client adapter that rejects nested transactions), and `createSessionDirectoryServiceFromPool(pool: Pool): SessionDirectoryService` (convenience factory). Transaction logic: `pool.connect()` + manual BEGIN/COMMIT/ROLLBACK with try/finally release; ROLLBACK errors swallowed but the original fn error always re-raises; no follow-up ROLLBACK after COMMIT failure (Postgres auto-rolls-back). 14 new tests in the `createPgPoolQuerier — pool-checkout-and-release path` describe block exercise query/exec routing, transaction connect-once + held-client routing, nested-tx rejection, ROLLBACK paths, COMMIT-throws + BEGIN-throws, and AC1/AC2/AC4 through pg.Pool. Cast comments document the substrate-vs-surface generic-shape mismatch (`pool.query<R extends QueryResultRow>` constrains R while the Querier surface is generic on free T). Driver-agnostic — no I-001-N invariant exercised at runtime.
  - phase: 5
    task: T5.6
    pr: 38
    sha: 2b230ea
    merged_at: 2026-05-11
    files:
      - packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts
    verifies_invariant: []
    spec_coverage: ["Spec-001 AC2", "Spec-001 AC4"]
    notes: |
      Phase 5 Lane A T5.6 — strengthens the `createSession` lock-ordering regression test (Codex R4) to discriminate WHICH Querier instance issued each in-transaction statement, discharging the `TODO(Plan-001 PR #5)` annotation that T5.5's pg.Pool adapter unlocked. The `wrapWithLog` test helper now captures `{querierId, sql}` pairs (was bare `string`) and re-wraps the in-tx Querier with a fresh `${outerId}.tx-<n>` id so a regression that routes any of the four load-bearing statements (session upsert, FOR UPDATE, owner-mismatch probe, owner upsert) through `this.#querier` instead of the transaction-bound `tx` is caught by `entry.querierId !== "outer"`. Under pg.Pool semantics that misroute would lock on a different pool checkout than the transaction's held client and fail to serialize concurrent createSession calls. Pre-T5.6 assertions (presence, ordering, count) preserved; strengthening is additive. Cross-equality assertion also catches a hypothetical regression that introduced a sibling transaction (different tx-scoped ids would split across four statements). Validated by mutating `session-directory-service.ts` to route FOR UPDATE through `this.#querier`, re-running the suite (R4 fails as expected), and reverting. **Closes Lane A** — Plan-001 Phase 5 Lane A complete with T5.1 (PR #30), T5.5 (PR #36), T5.6 (PR #38).
  - phase: 5
    task: T5.4
    pr: 48
    sha: de47f65
    merged_at: 2026-05-11
    files:
      - packages/runtime-daemon/src/session/__tests__/spawn-cwd-translator.test.ts
      - packages/runtime-daemon/src/session/__tests__/spawn-cwd-translator.windows.test.ts
      - packages/runtime-daemon/src/session/index.ts
      - packages/runtime-daemon/src/session/spawn-cwd-translator.ts
    verifies_invariant: []
    spec_coverage: []
    notes: |
      Phase 5 Lane B T5.4 — `spawn-cwd-translator.ts` pure-function daemon-layer cwd-translator at `packages/runtime-daemon/src/session/`. Two strategies: `cd-prefix` (mutates the command string with a `cd <wt> && exec <cmd>` shell wrapper — visible to Plan-005 audit-log canonical hash; used for shell-driver sessions) and `cwd-env` (appends `["CWD", worktreePath]` to env tuples — invisible to canonical bytes; used for agent-driver CLIs that read `CWD` from env). Both strategies replace `SpawnRequest.cwd` with the stable parent so the OS-level lock moves off the worktree directory before spawn, mitigating Windows `ERROR_SHARING_VIOLATION` per inherited Plan-022 I-022-5 (microsoft/node-pty#647). Two wrapping-shell flavors: POSIX (`/bin/sh -c "cd '<wt>' && exec '<cmd>' <args>"` with `'\''` close-escape-reopen quoting) and Windows-cmd (`cmd.exe /d /s /v:off /c "cd /d "<wt>" && "<cmd>" <args>"` with caret-escape `^&|<>%` order-sensitive metachar handling). `/v:off` defends against the registry-flippable `HKLM\Software\Microsoft\Command Processor\DelayedExpansion` default so a literal `!` in the command or worktree path never triggers variable expansion. 32 cross-platform unit tests cover both strategies + both wrapping shells + POSIX/cmd.exe quoting edge cases (spaces, single quotes, metacharacters, `%PATH%`-style boundaries, escape-order regression guard, `/v:off` arg-position invariant, `!VAR!` literal preservation). 2 platform-gated Windows-CI integration tests use a `RecordingPtyHost` mock and `describe.skipIf(process.platform !== "win32")` — they assert translated `SpawnRequest.cwd === stableParent` and the worktree path is recoverable from `args[4]` of the cmd.exe `/d /s /v:off /c <script>` arg list. **No I-NNN-N invariant verified directly** — T5.4 discharges contractual obligation CP-001-2 (daemon-layer cwd-translator) and verifies inherited Plan-022 I-022-5 (Windows ERROR_SHARING_VIOLATION mitigation) by construction. Pre-merge Codex review surfaced 3 findings across 3 round-trips on `feat/plan-001-cwd-translator` (HEADs `46f5ea6` → `42f7e24` → `7bb4d73`): (1) P2 — vacuous worktree teardown test (rmSync force:true succeeded on a path that was never mkdirSync'd); fixed by mkdirSync in beforeEach + force:false on teardown. (2) P2 — cmd.exe metachar escape gap (`quoteWindowsCmd` only doubled `"`); fixed with order-sensitive caret-escape pass on `^&|<>%`. (3) P1 — Windows-CI test args-slice/index drift (when `/v:off` was inserted between `/s` and `/c`, only the cross-platform unit test got its `args.slice(0, 4)` / `args[4]` updates; the platform-gated Windows test was missed because `describe.skipIf` hides it on dev); fixed in `7bb4d73` with assertion realignment + JSDoc summary refresh on `WrappingShell` that still showed the pre-/v:off args form. Final CI: 8/8 green, 246 tests pass + 3 skipped (2 Windows-gated + 1 unrelated todo). **Closes** — both PR-rows ticked (T-022-2-1 via PR #45, T5.4 via PR #48); (Plan-022 Phase 2 NodePtyHost) promotes from `blocked` → `ready` since its only two upstream NS-XX entries are both now `completed`. (Plan-022 Phase 3 RustSidecarPtyHost) advances one upstream-dep closer — now gated on alone.
  - phase: 5
    task: T5.2
    pr: 77
    sha: 637a3f0
    merged_at: 2026-05-19
    files:
      - apps/desktop/package.json
      - apps/desktop/src/renderer/src/App.tsx
      - apps/desktop/src/renderer/src/session-bootstrap/SessionBootstrap.tsx
      - apps/desktop/src/renderer/src/session-bootstrap/__tests__/SessionBootstrap.test.tsx
      - apps/desktop/src/renderer/src/session-bootstrap/index.ts
      - apps/desktop/src/renderer/tsconfig.json
      - apps/desktop/src/renderer/tsconfig.test.json
      - apps/desktop/vitest.config.ts
      - docs/backlog.md
      - docs/plans/001-session-core.md
      - pnpm-lock.yaml
    verifies_invariant: []
    spec_coverage: ["Spec-001 AC1"]
    notes: |
      Phase 5 Lane C T5.2 — `apps/desktop/src/renderer/src/session-bootstrap/` renderer wiring on top of the Plan-021-partial Tier 1 preload bridge. `SessionBootstrap.tsx` invokes `window.sidekicks.daemon.call("session.create", {})` on mount via a React `useEffect` async IIFE (the Tier 1 stub bridge — `createTier1Bridge` in `packages/contracts/src/desktop-bridge.ts` — throws synchronously, not via promise rejection; the async IIFE normalizes sync-throw and async-reject through a single `try`/`catch`); renders three branches (`pending` placeholder, `resolved` session-summary surfacing only the session id, `error` envelope surfacing the typed `NotImplementedAtTier1Error` per the Tier 1 stub). Net ~5 production lines wired into `App.tsx` swap the Plan-021 Tier 1 Partial T-021p-1-5 placeholder for `<SessionBootstrap/>`. 4-test happy-dom Vitest suite at `__tests__/SessionBootstrap.test.tsx` covers (a) pending render while the create promise is unresolved, (b) resolved render with a deterministic `SessionCreateResponse` payload, (c) error render on async rejection with `NotImplementedAtTier1Error`, (d) error render on synchronous throw (production-shape parity — the Tier 1 stub wires every method to ` => tier1Throw(...)`). Renderer test toolchain wired in the same PR: per-app `apps/desktop/vitest.config.ts` (vitest 4 `projects` API splits `main` (node env) from `renderer` (happy-dom env) discovery globs) + sibling `apps/desktop/src/renderer/tsconfig.test.json` (`composite: false`, `noEmit`, `vitest/globals` isolated) so renderer test types never leak into renderer production code's typegraph. **No I-NNN-N invariant verified** (renderer composition over the bridge surface). Two audit amendments preceded the code: T-amend-001 (commit `8827345`) reconciled the T5.2 Tasks-row Files list with the prose by adding `App.tsx`; T-amend-002 (commit `32a4b40`) widened the Files list to include the renderer-unit-test substrate (`apps/desktop/package.json`, `apps/desktop/vitest.config.ts`, `apps/desktop/src/renderer/tsconfig.json`) after attempt-1 surfaced the substrate gap. `Spec coverage` was narrowed from `Spec-001 AC1, AC4` to `Spec-001 AC1` in the Phase D round-trip (commit `6fb2513`) — AC4 governs `SessionJoin` semantics (T5.1's `sessionClient.join` responsibility), not T5.2's renderer-side `session.create` wiring; the reject-branch render is task AC T5.2(d), not a Spec-001 AC. **Closes** — Plan-001 Phase 5 Lane C complete on the single-PR shape. No downstream NS-XX promotion (no §6 entry lists `Upstream:`). Plan-001 Phase 5 has only Lane D (T5.3 — sidecar-lifecycle) remaining.
  - phase: 5
    task: T5.3
    pr: 83
    sha: a70de3e
    merged_at: 2026-05-20
    files:
      - .claude/skills/plan-execution/SKILL.md
      - apps/desktop/src/main/index.ts
      - apps/desktop/src/main/sidecar-lifecycle.ts
      - apps/desktop/test/sidecar-lifecycle.test.ts
      - docs/plans/001-session-core.md
      - docs/plans/022-rust-pty-sidecar.md
      - packages/contracts/src/pty-host.ts
      - packages/runtime-daemon/src/pty/__tests__/node-pty-host.shutdown.test.ts
      - packages/runtime-daemon/src/pty/__tests__/rust-sidecar-pty-host.shutdown.test.ts
      - packages/runtime-daemon/src/pty/node-pty-host.ts
      - packages/runtime-daemon/src/pty/rust-sidecar-pty-host.ts
      - packages/runtime-daemon/src/pty/taskkill-windows.ts
      - packages/runtime-daemon/src/session/__tests__/spawn-cwd-translator.windows.test.ts
    verifies_invariant: [I-022-4]
    spec_coverage: []
    notes: |
      Phase 5 Lane D T5.3 — polymorphic `PtyHost.shutdown({ perSessionTimeoutMs: 2000, hostTimeoutMs: 2000 })` extension on both backends + `apps/desktop/src/main/sidecar-lifecycle.ts` will-quit drain orchestration registered at index.ts FIFO position 0 (Shape A lazy PtyHostGetter per CP-001-1). NodePtyHost (in-process) drives SIGTERM→SIGKILL per-session escalation; RustSidecarPtyHost (out-of-process) drives stdin-close → child-exit wait → taskkill /T /F /PID escalation with `shuttingDown`-flag crash-budget suppression. 5 s hard wall-clock cap (`HARD_QUIT_CAP_MS`) + `drainCompleted` re-entry guard preserve Electron's `app.quit` chain semantics. Verifies I5 (= CP-001-1 + Plan-022 I-022-4) end-to-end against the real RustSidecarPtyHost. Codex follow-ups in-PR: P1 #6 added cross-platform child-process tree-kill via `packages/runtime-daemon/src/pty/taskkill-windows.ts`; P2 #1 corrected `DrainResult.forced` count; P2 #2 fixed crash-before-drain `-1` sentinel misreport. **Closes** — Plan-001 Phase 5 fully shipped (T5.1–T5.6 complete); no downstream NS-XX promotion (is a leaf — no §6 entry lists `Upstream:`).
  - phase: 5
    task: P5-residuals
    pr: 87
    sha: bc33f30
    merged_at: 2026-05-21
    files:
      - docs/plans/001-session-core.md
      - packages/contracts/src/__tests__/error.test.ts
      - packages/contracts/src/error.ts
      - packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts
      - packages/control-plane/src/sessions/errors.ts
      - packages/control-plane/src/sessions/session-directory-service.ts
      - packages/control-plane/src/sessions/session-router.factory.ts
      - packages/control-plane/src/sessions/trpc.ts
      - packages/runtime-daemon/src/session/__tests__/__snapshots__/migration-shape.test.ts.snap
      - packages/runtime-daemon/src/session/__tests__/migration-shape.test.ts
    verifies_invariant: []
    spec_coverage: []
    notes: |
      Backfill (BL-110 Gate 6 baseline reconciliation, 2026-07-06): follow-up PR shipped outside a plan-execution run; descriptive task label, not a DAG task id. Closed the Tier-1 closing audit's Plan-001 acceptance gaps (A1 G2/G3/G4) and promoted the plan to completed.
```

### Notes

<!-- Per-PR human commentary (round-trips, learnings, partial-ship details). -->

- **PR #30** (squash-commit `7e4ae47` on `develop`, merged 2026-05-05): Phase 5 Lane A T5.1 — `sessionClient.ts`. Two factories shipped at `packages/client-sdk/src/sessionClient.ts`: `createDaemonSessionClient(client: JsonRpcClient): SessionClient` (consumes Plan-006 §CP-006-4 transport) + `createControlPlaneSessionClient(opts: ControlPlaneSessionClientOptions): SessionClient` (consumes the control-plane tRPC `sessionRouter` + native SSE per BL-104 path-(b)). Shared `SessionClient` interface with `create` / `read` / `join` / `subscribe(): AsyncIterable<EventEnvelope>`. Acceptance criteria green: I1 (SessionCreate→SessionRead identity, daemon), I2 (two-client SessionJoin replay history, daemon), I3 (SessionSubscribe ASC sequence across reconnect, CP/SSE), I4 (reconnect after lost stream restores from snapshot, CP/SSE) — covering Spec-001 AC1 / AC3 / AC4 / AC6. Pre-Phase-A landed two prerequisite commits on the PR branch: `8c73268 fix(repo): require code-type prefix in plan-execution preflight Gate 3` (Gate 3 was false-matching doc/chore PRs against `Plan-NNN.*Phase N` patterns; tightened to `feat|fix|refactor|perf` Conventional Commit prefixes per CONTRIBUTING.md) and `777a765 docs(repo): seal preflight.mjs cite ripple after Gate 3 line shift` (CAT-06 inbound `:NNN` cite update in housekeeper plan after preflight.mjs:537 → :544 shift). Round-trips: round 1 surfaced ACTIONABLE barrel-export gap (`src/index.ts` missing `sessionClient.js` re-export — broke external consumers' import surface); round 2 surfaced asymmetric type-soundness gap (factory exported but `JsonRpcClient` parameter type only re-exported transitively, blocking TypeScript consumers from naming the dependency); round 3 closed both with wide transport re-exports (`export * from "./transport/jsonRpcClient.js"` + `"./transport/types.js"`) — task converged at round-trip cap (3 rounds) without cap-firing. Phase D (PR-scoped, full-diff) returned 0 POLISH / 0 ACTIONABLE across all three reviewers (spec / code-quality / code). Self-flagged learnings inline: async-generator priming pitfall (body executes only on first `next()` pull, not on iterator construction — caught in I2 test setup) + stale-citation correction (early reference to "mutation precedent in `sse-roundtrip.test.ts`" was self-corrected with primary-source citation to `@trpc/server@11.17.0` source — the cited test was subscribe-only). Post-Phase-D Codex external review then ran 5 rounds against successive HEADs and produced 8 findings (1 P1, 7 P2) across the same `sessionClient.ts` surface — all addressed inline with regression tests C1-C8: pre-abort guards on both transports (RT-1 + RT-2), CRLF-tolerant SSE frame parsing per WHATWG HTML §9.2.6 (RT-1), cursor validation via `EventCursorSchema.parse` at the trust boundary (RT-2), graceful mid-stream abort on the CP read loop (RT-3 / `5eef5fc`), graceful request-setup abort closing the third abort window (RT-4 / `6c179dc`), daemon abort race-close after listener attach (RT-5 / `101fa29`), and SSE Content-Type validation against silent-empty-stream misreports from non-SSE 200 responses (RT-5). Three abort windows now uniformly handled on the CP path matching the daemon path's `addEventListener("abort", () => subscription.cancel())` contract. Bundled CI hardening landed in the same PR: lychee CI split into required-inbound + advisory-outbound (`cdae21c`) per ADR-023 §Axis 2 D-1 (gates fail-closed; drift detectors warn) and the advisory-outbound failure flipped to yellow `::warning::` annotation (`49102db`) so the workflow header reflects the actual signal class. Final test count: 35 client-sdk tests (16 integration including C1-C8). Plan-001 Phase 5 Lane A T5.1 closes; T5.2-T5.6 remain unscheduled. _BL-113 retroactive audit footnote (2026-05-18):_ the re-entrant unsubscribe precondition (`Plan-006 §Invariants` I-006-11 — `LocalSubscriptionProducer<T>.onCancel` fires across all externally-imposed cancel paths) is named on `SessionSubscribeDeps.subscribeToSession`'s returned function — PR #30's three-abort-window handling already satisfied this contract implicitly (no remaining T5.x lane consumes `subscribeToSession` — T5.2 / T5.3 are renderer-wiring + sidecar-lifecycle; T5.4-T5.6 remain unscheduled and may or may not touch the subscribe surface); future maintenance authors of `subscribeToSession` and future Plan-006-remainder consumers of subscribe-shape primitives must preserve snapshot-during-emit / queued-removal tolerance, because PR #19 F5's `onCancel` handlers fire from inside the upstream's `onEvent` call stack (canonical statement: `packages/runtime-daemon/src/ipc/handlers/session-subscribe.ts#SessionSubscribeDeps`, the subscribeToSession re-entrancy contract).

## Done Checklist

- [x] Code changes implemented — Phases 1–4 shipped via PRs #6 / #8 / #9 / #10 (2026-04-27); Phase 5 Lane A (T5.1 / T5.5) shipped via PRs #30 / #36 / #38; Phase 5 Lane B (T5.4) via PR #48; Phase 5 Lane C (T5.2) via PR #77; Phase 5 Lane D (T5.3) via PR #83 (sha `a70de3e`, merged 2026-05-20); Plan-001 residuals (D5 migration-shape test, T2.3 version-error envelopes) via this PR (Tier 1 closing audit Path A).
- [x] Tests added or updated — full coverage chain: C1–C4 (PR #8 contracts package), D1–D5 (PR #9 daemon migration + projection + the D5 migration-shape snapshot test landed in this PR), P1–P2 (PR #10 control-plane directory), the I-tier suite (Phase 5 Lane A test files), 32 cross-platform unit tests + 2 platform-gated Windows-CI tests for T5.4 (PR #48), 4-test happy-dom suite for T5.2 (PR #77), per-backend shutdown tests + FIFO-position-0 lifecycle tests for T5.3 (PR #83). Beyond that chain, PR #30 added eight client-sdk transport-hardening regression tests labeled C1–C8 inside `packages/client-sdk/test/sessionClient.integration.test.ts` (see `Plan-001 §Progress Log`); that series is package-local, numbered per Codex round-trip finding, and shares no namespace with the C-tier contract tests above.
- [x] Verification completed — anchored in the §Decision Log entries below. Phase 5 ship-evidence is the I-tier unit/integration suite on merged `develop`.
- [x] Related docs updated — §Shipment Manifest T5.3 row appended (this commit); §Decision Log section added (this commit); §Status promoted to `completed` (this commit).
- [x] All `TODO(Plan-001 Phase N)` annotations in the source tree are discharged or migrated to a follow-up issue. `rg "TODO\(Plan-001 " packages/ apps/` returns zero matches at HEAD (verified 2026-05-20); the `TODO(Plan-001 Phase 5)` annotation was discharged in PR #38.

## Decision Log

| Date | Event | Notes |
| --- | --- | --- |
| 2026-05-20 | Plan-001 promoted `approved` → `completed` (Tier 1 closing audit Path A) | Bundled the audit's three scribe edits (§Status flip, T5.3 §Shipment Manifest row, §Done Checklist flips) with the three functional gaps the audit surfaced (A1 G2 / G3 / G4) in a single PR. Functional commits: feat(daemon) migration-shape snapshot test (D5); feat(contracts) version.floor_exceeded + version.ceiling_exceeded envelopes (T2.3); feat(control-plane) tRPC aisError formatter. Closes Tier 1 closing audit DQ-1 (Path A) + A2 R1 + A2 R2 + A8 promotion. |
| 2026-05-20 | D5 migration-shape test path correction (erratum) | Plan-001 T3.4 cited `migrations/test/migration-shape.test.ts` for the D5 regression test. The `packages/runtime-daemon/vitest.config.ts` discovery glob is `src/**/__tests__/**/*.test.ts` — the cited path would be silently skipped (no test discovery, no failure). The test ships at `packages/runtime-daemon/src/session/__tests__/migration-shape.test.ts` to match the glob; T3.4's acceptance is satisfied at the corrected path. Recorded as an erratum because the spec text (`Plan-001 §T3.4 — Migration-shape regression test`) still cites the original path; future audits should reconcile the prose against the shipped reality. |
| 2026-05-20 | ErrorFormatter precedent for typed wire envelopes | Tier 1 closing audit A1 G3 (this PR's Commit 3) introduces the `errorFormatter` + `data.aisError` envelope pattern at `packages/control-plane/src/sessions/trpc.ts` and the catch-and-rethrow scaffolding at `session-router.factory.ts`. This pattern is the reference for later plans' typed exceptions: each new typed error class (e.g. emit-site throws of the `VersionFloorExceededError` + `VersionCeilingExceededError` envelopes landed in this PR's Commit 2) reuses the formatter hook by adding one `instanceof` branch + one router catch arm. If 3+ typed exceptions accumulate, refactor the thrown classes into an `AisWireException` base class so the formatter matches a single `instanceof` per [error-contracts.md](../architecture/contracts/error-contracts.md) §Future Shape. |
| 2026-07-28 | `SessionService.append` guarded test-only + emitter seam decoupled (Plan-005 T3.1 precondition — guard + decouple legs) | Enhancement-lane PR #272, a post-completion change to this plan's shipped code authorized by the [Plan-005 §Phase 3](./005-session-event-taxonomy-and-audit-log.md#phase-3--persistence--maintenance-packagesruntime-daemonsrcevents) T3.1 precondition (added 2026-07-27 by PR #256 Codex round 3): `append()` now throws unless the service was constructed with the explicit test-only `allowUnsignedPlaceholderAppend` opt-in (pinned by the exported-title negative control `packages/runtime-daemon/src/session/__tests__/session-service.test.ts#DEFAULT_CONSTRUCTED_APPEND_REFUSAL_TEST`) — the zero-fill placeholder rows it writes are exactly what Plan-005's `verifyRow` refuses fail-closed (`signature_placeholder`), so no production composition root can reach the unsigned path by accident. The opt-in takes the nominal `UnsignedPlaceholderAppendToken` (`packages/runtime-daemon/src/session/session-service.ts#UnsignedPlaceholderAppendToken`), issued only by its `forTestsOnly()` static and identity-checked against the module-private singleton at construction (pinned by `packages/runtime-daemon/src/session/__tests__/session-service.test.ts#FORGED_TOKEN_REFUSAL_TEST`), so no configuration- or environment-derived value can ever BE the token — a literal-`true` option was refuted as a barrier by PR #272 Codex round 2 (`condition ? true : undefined` typechecks — the branches carry the literal types `true` and `undefined` ([TypeScript Handbook, "Literal Types"](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#literal-types)) — and an `if` narrows `boolean` to `true` by truthiness narrowing ([TypeScript Handbook, "Truthiness narrowing"](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#truthiness-narrowing))) — and round 3 scoped the guarantee honestly: an in-package composition root could still gate a genuine `forTestsOnly()` call behind an environment check, so an ESLint `no-restricted-syntax` boundary in `eslint.config.mjs` now denies the factory in `packages/runtime-daemon/src/**` outside `__tests__/` (a lint-suppressed bypass stays expressible; the loud name is the review signal). The token is deliberately not exported from the package root, and the package `exports` map ([`packages/runtime-daemon/package.json`](../../packages/runtime-daemon/package.json)) declares only `.`, so Node itself refuses deep imports from outside the package: when a package defines `exports`, all subpaths not listed there "are encapsulated and no longer available to importers" ([Node.js packages documentation, "exports"](https://nodejs.org/api/packages.html#exports)). Reads (`readEvents`/`replay`) need no opt-in. All 15 in-tree construction sites sit under `__tests__/`; every site that exercises `append` genuinely opts in (10 of 15), and the remaining five deliberately do not — two default-constructed reopen sites proving reads need no opt-in, plus the guard suite's default-construction negative control, round 2's forged-token negative control, and the read-only proof — so the opted-in green suite is not vacuous (census corrected 14→15 in round 3, which had omitted the forged-token site from the arithmetic). Plan-002's `RuntimeNodeEventEmitter` was simultaneously re-typed onto the structural `SessionEventLog` seam, hardened in round 2 so the seam's `append` (`packages/runtime-daemon/src/node/node-event-emitter.ts#SessionEventLog`) returns `undefined` — a Promise-returning implementation fails at compile time because TypeScript's permissive treatment of returned values is documented for `void` return types only ([TypeScript Handbook, "Return type void"](https://www.typescriptlang.org/docs/handbook/2/functions.html#return-type-void)), so an `undefined` return type takes ordinary assignability and rejects a `Promise`; the rejection is pinned by the exported-title compile control `packages/runtime-daemon/src/node/__tests__/node-event-emitter.test.ts#COMPILE_TIME_ASYNC_APPEND_REJECTION_TEST` and backstopped by the runtime thenable refusal — and the log-derive allocator computes the maximum `sequence` explicitly (the seam promises no row order) — see [Plan-002 §Progress Log](./002-runtime-node-attach.md#progress-log), same date. The [§Data And Storage Changes](#data-and-storage-changes) placeholder-convention bullet carries the discharge note. |
| 2026-08-10 | Phase 2/3 test-file path errata + T2.1 direct-coverage completion (erratum) | Follow-up to the D5 path-correction erratum above — same root cause, swept as a unit. Both `packages/contracts/vitest.config.ts#include` and `packages/runtime-daemon/vitest.config.ts#include` discover tests via the `src/**/__tests__/**/*.test.ts` glob, so every Phase 2/3 Files-row path under a bare `test/` directory was never discoverable — and none ever existed in history (the bare paths quoted next are the Files rows' promised text, not live cites): T2.1's `packages/contracts/test/session.test.ts` shipped (PR #8) as a split across `packages/contracts/src/__tests__/session-id.test.ts#SessionIdSchema` and `packages/contracts/src/__tests__/session-create.test.ts#SessionCreateResponseSchema`; T2.2's `test/event.test.ts` shipped as `packages/contracts/src/__tests__/session-event.test.ts#SessionEventSchema`; T2.3's `test/error.test.ts` shipped as `packages/contracts/src/__tests__/error.test.ts#ResourceLimitExceededErrorSchema`; T3.2's and T3.3's `session/test/` paths shipped (PR #9) under `packages/runtime-daemon/src/session/__tests__/`. T3.4 is already adjudicated by the D5 erratum. The Files rows are kept verbatim per the keep-row-plus-erratum convention; future audits should reconcile the prose against the shipped reality. The split also left the T2.1 promise partially met: the SessionRead and SessionSubscribe schema families had NO direct unit coverage in the contracts package (exercised only transitively via consumer suites — daemon IPC handler tests, control-plane SSE factory), Completed this date by `packages/contracts/src/__tests__/session-read.test.ts#SessionReadResponseSchema` + `packages/contracts/src/__tests__/session-subscribe.test.ts#SessionSubscribeRequestSchema` (this PR), pinning request/response strictness at every nesting level, the optional replay-cursor arms (`afterCursor` / `lastEventId`), RFC 3339 offset acceptance on snapshot datetimes, and cursor length bounds. |
