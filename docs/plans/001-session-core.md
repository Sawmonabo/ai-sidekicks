# Plan-001: Session Core

| Field | Value |
| --- | --- |
| **Status** | `completed` |
| **NNN** | `001` |
| **Slug** | `session-core` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-001: Session Core](../specs/001-session-core.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-002](../decisions/002-local-execution-shared-control-plane.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-006](../decisions/006-worktree-first-execution-mode.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-017](../decisions/017-shared-event-sourcing-scope.md), [ADR-018](../decisions/018-cross-version-compatibility.md), [ADR-019](../decisions/019-windows-v1-tier-and-pty-sidecar.md), [ADR-022](../decisions/022-v1-toolchain-selection.md), [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md). **Phase 1 ship-gate**: [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md) governs the engineering CI surface that lands in Phase 1. **Phase 5 ship-gate (governance)**: [ADR-019](../decisions/019-windows-v1-tier-and-pty-sidecar.md) governs CP-001-1 / CP-001-2; [ADR-006](../decisions/006-worktree-first-execution-mode.md) bakes worktree paths into the daemon's session-spawn entry point per CP-001-2. |
| **Dependencies** | Phase 1–Phase 4: None (the entry plan; owns `0001-initial.ts` migration and forward-declares schema shape consumed by [Plan-002](./002-runtime-node-attach.md), [Plan-005](./005-session-event-taxonomy-and-audit-log.md), [Plan-020](./020-data-retention-and-gdpr.md)). Phase 5 only: [Plan-006](./006-local-ipc-and-daemon-control.md) partial-deliverable (the IPC wire substrate + `session.*` namespace + SDK Zod layer per [Spec-006 §Wire Format](../specs/006-local-ipc-and-daemon-control.md#wire-format)) and the control-plane bootstrap-deliverable (tRPC v11 server skeleton + `sessionRouter` HTTP handlers + SSE substrate for `SessionSubscribe`, now owned by [Plan-028](./028-remote-control.md)). See [Plan-006 §Execution Windows](./006-local-ipc-and-daemon-control.md#execution-windows-v1-carve-out). |
| **Cross-Plan Deps** | Cross-Plan Dependency Graph |

## Goal

Implement the minimum session creation, snapshot, and replay foundation used by all later features.

## Scope

This plan covers session ids, default channel creation, session-owner binding, local event append, and typed session read or subscribe APIs.

## Non-Goals

- Runtime-node attach
- Queue and intervention behavior

## Invariants

The following invariants are **load-bearing** and MUST be preserved across all Plan-001 PRs and downstream extensions. Any change that would weaken or remove an invariant is coordinated across the plans that depend on it (see cross-plan-dependencies.md).

### I-001-2 — Sequence is the canonical replay key

Local Runtime Daemon SQLite replay MUST order `session_events` by `sequence ASC`, never by `monotonic_ns`. The `monotonic_ns` column is within-daemon debug data only (per [local-sqlite-schema §session_events](../architecture/schemas/local-sqlite-schema.md#session-events-plan-001-extended-by-plans-005-013)); it can be non-monotonic across rows after clock adjustments and MUST NOT influence replay or projection.

**Why load-bearing.** Replay determinism is the foundation for [ADR-017](../decisions/017-shared-event-sourcing-scope.md) event-sourcing semantics. Plan-005 (event taxonomy + integrity protocol) and Plan-013 (replay/recovery) build on this invariant.

**Verification.** Test D3 in §Test And Verification Plan asserts `Replay uses sequence not monotonic_ns even when monotonic_ns is non-monotonic across rows`.

### I-001-3 — Forward-declared columns are immutable in scope

The forward-declared columns and tables enumerated in §Cross-Plan Forward-Declared Schema (Plan-001 emits the DDL, downstream plans own the semantics) MUST NOT be re-shaped by Plan-001 PRs. Plan-001 ships the column types and nullability authoritatively at the first migration; the corresponding semantics owners (Plan-005 integrity, Plan-020 GDPR, Plan-016 identity, Plan-002 version-floor) author all read/write logic in their own plans.

**Why load-bearing.** Re-shaping a forward-declared column after the first migration would force a breaking schema migration after V1 ships — the entire point of the forward-declaration pattern is that V1 ships immutable initial DDL.

**Verification.** Test D5 (migration-shape regression) reads `0001-initial.ts` via `PRAGMA table_info()` for `session_events`, `session_snapshots`, `user_keys`, and `schema_version`, asserts the column set matches the canonical schema docs.

## Cross-Plan Obligations

Plan-001 owns the daemon-side session lifecycle and the `PtyHost.spawn` entry-point wrapper. Two daemon-layer obligations (CP-001-1, CP-001-2) are declared by Plan-022 (Rust PTY Sidecar) and surface here for bidirectional citation locality, so a Plan-001 reviewer sees the obligations without first reading Plan-022. Each entry mirrors the [Plan-002 §Cross-Plan Obligations](./002-runtime-node-attach.md#cross-plan-obligations) shape: the obligation, the source citation, and the resolution.

### CP-001-1 — Sidecar-cleanup handler registers BEFORE Electron `will-quit`

[Plan-022 §Invariants I-022-4](./022-rust-pty-sidecar.md#i-022-4--daemons-sidecar-cleanup-handler-registers-before-electron-will-quit) declares that the daemon's sidecar-cleanup handler MUST register before Electron's `will-quit` handler. Under Electron's event-emitter semantics, registration order is run order; if the daemon's cleanup handler is late-registered, the renderer process terminates before active PTY sessions drain and child processes orphan to the global console (the `microsoft/node-pty#904` SIGABRT-on-exit class — primary source cited at [Plan-022 §Windows Implementation Gotchas Gotcha 4](./022-rust-pty-sidecar.md#4-electron-will-quit-ordering-vs-sidecar-shutdown)).

**Resolution.** Plan-001 Phase 5 (Client SDK and Desktop Bootstrap) authors the desktop-shell sidecar-lifecycle wiring at `apps/desktop/src/main/sidecar-lifecycle.ts` (the `apps/desktop/src/main/` directory is owned by [Plan-021's partial substrate](./021-desktop-shell-and-renderer.md#partial-pr-sequence); Plan-001 Phase 5 authors the file content per CP-001-1 content-ownership) so the cleanup handler registers in the Electron `app.on('will-quit', ...)` slot **before** any other handler that depends on the renderer. The handler delegates to a single polymorphic `PtyHost.shutdown({ perSessionTimeoutMs, hostTimeoutMs })` call — both backends (`RustSidecarPtyHost` out-of-process; `NodePtyHost` in-process) implement the drain protocol per `packages/contracts/src/pty-host.ts`, so the wiring layer never sees a backend-specific surface ([ADR-019 §Decision](../decisions/019-windows-v1-tier-and-pty-sidecar.md#decision) item 8: "Consumers never see the backend choice"). The contract pins the drain semantics: per-session `SIGTERM` → wait for `ExitCodeNotification` up to `perSessionTimeoutMs` → escalate to `SIGKILL` on timeout; then close the sidecar's stdin → wait for sidecar exit up to `hostTimeoutMs` → escalate to `taskkill /T /F /PID <sidecar-pid>` on hard timeout. In-process `NodePtyHost` vacuously satisfies the host fields (`sidecarExitedCleanly: true, taskkillEscalated: false`). Escalation matches §Cross-Plan Obligations CP-001-2 below for the same hard-stop pattern.

**Why surfaced in Plan-001.** This obligation lives at the desktop-shell session-lifecycle layer (Plan-001 owns the session-lifecycle daemon code), not at the sidecar protocol layer (Plan-022 supplies only the `PtyHost.close(sessionId)` and `KillRequest` primitives). Without the bidirectional citation, a Plan-001 reviewer would have no signal that the will-quit handler exists as a Plan-001 obligation.

### CP-001-2 — `PtyHost.spawn(spec)` performs daemon-layer cwd-translation for worktree paths

[Plan-022 §Invariants I-022-5](./022-rust-pty-sidecar.md#i-022-5--spawnrequestcwd-carries-a-stable-path-daemon-performs-worktree-translation) declares that the sidecar's `SpawnRequest.cwd` MUST always carry a stable, unmovable parent directory; worktree paths live in the command-string-or-env layer above. Without daemon-layer translation, the sidecar would forward worktree paths verbatim to `portable-pty::PtySize::spawn_command`, Windows would lock the worktree directory (`ERROR_SHARING_VIOLATION`), and `git worktree remove` would fail until every spawned session under that worktree exited (the `microsoft/node-pty#647` class — primary source cited at [Plan-022 §Windows Implementation Gotchas Gotcha 5](./022-rust-pty-sidecar.md#5-spawn-locks-cwd-on-windows)).

**Resolution.** Plan-001 Phase 5 (Client SDK and Desktop Bootstrap) ships a daemon-layer `PtyHost.spawn` wrapper that intercepts `spec.cwd`, substitutes a stable parent directory (the daemon's working dir or user-home root) for the protocol-level `SpawnRequest.cwd`, and prepends a `cd <worktree-path> && ` shell prefix (or sets `CWD=<worktree-path>` env, depending on whether the agent CLI consumes `cd` semantics or env-based cwd). The wrapper sits in `packages/runtime-daemon/src/session/` (Plan-001's session lifecycle layer) so both `RustSidecarPtyHost` and `NodePtyHost` inherit the same translation — the constraint is OS-level, not backend-specific, per Plan-022 I-022-5.

**Why surfaced in Plan-001.** ADR-006 (Worktree-First Execution Mode) bakes worktree paths into the daemon's session-spawn entry point. The translation MUST happen between the daemon's logical worktree-path API and the sidecar's wire-protocol `SpawnRequest.cwd` — i.e., in Plan-001's session-lifecycle code, not in Plan-022's sidecar code (the sidecar deliberately does not know about worktree semantics, per Plan-022 I-022-3 / I-022-5). Plan-022 Phase 3 carries an explicit `**Precondition:**` line on this wrapper because the sidecar end-to-end test would surface `ERROR_SHARING_VIOLATION` on Windows CI without it.

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted (plan body)
- [x] **Phase 1 ship-gate**: [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md) — V1 CI/CD, Pre-Commit Hooks, and Release Automation. The engineering CI surface that lands in Phase 1 (`.github/workflows/{ci,release}.yml`, lefthook 2.1.6 pre-commit framework, commitlint 20.5.2, Renovate dependency-update config, Gitleaks v8.30+ secret scanner, release-please-action@v5 + actions/attest@v4 release skeleton, code-signing custody artifacts) is governed by that ADR.
- [x] Blocking open questions are resolved or explicitly deferred

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
- `turbo.json` — `build`, `test`, `lint`, `typecheck`, and `dev` task pipelines at scaffold time; later tasks (`test:coverage`, for one) are added by the work that owns them
- `tsconfig.base.json` — strict + `isolatedDeclarations: true` + ESM-only; per-package `tsconfig.json` extends base
- `.npmrc` — `node-linker=isolated` (required by [ADR-022](../decisions/022-v1-toolchain-selection.md) two-ABI native binding constraint)
- `.nvmrc` — pins the lower-tier Node target per [ADR-022](../decisions/022-v1-toolchain-selection.md)
- `eslint.config.mjs` and `prettier.config.js` at root

**Engineering CI surface** — `.github/workflows/{ci,release}.yml`, lefthook 2.1.6 pre-commit hook framework + `lefthook.yml`, `lint-staged.config.mjs`, commitlint 20.5.2 config (10-type set, drops `style`), Renovate config (`renovate.json5` with `minimumReleaseAge: 14 days`), `CODEOWNERS`, Gitleaks v8.30+ workflow, and code-signing custody artifacts (Apple Developer Individual + Azure Artifact Signing OIDC + Sigstore keyless + AWS KMS Ed25519 hot key + YubiHSM 2 cold key envelope) are owned by [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md). Phase 1 lands the concrete artifact list per [ADR-023 §Decision](../decisions/023-v1-ci-cd-and-release-automation.md#decision).

### Per-Package Scaffolding

Every `packages/*` and `apps/*` member receives a `package.json` (with `"type": "module"`, `engines.node` matching its tier per [ADR-022](../decisions/022-v1-toolchain-selection.md), and an `exports` map), a `tsconfig.json` extending base, and a `src/` directory.

Electron-bound packages (`apps/desktop/*`, `packages/runtime-daemon/*`) use the lower-tier Node target. Control-plane packages (`packages/control-plane/*`) use the upper-tier target. Shared packages consumed by both sides (`packages/contracts/*`, `packages/client-sdk/*`) target the lower tier as the lowest common denominator.

Vitest test-file discovery is owned by each package's own standalone `vitest.config.ts` — a plain `defineConfig` with no workspace-level config above it and no single project-wide test path; the suites aggregate through Turbo's `test` task (`turbo run test`), which invokes each package's own `vitest run`. The prevailing discovery glob is `src/**/__tests__/**/*.test.ts`; the exceptions are `packages/client-sdk/` (that glob plus `test/**/*.test.ts` for cross-workspace integration tests) and `apps/desktop/` (whose config declares two in-package `projects` — a Node `main` project on `test/**/*.test.ts` and a happy-dom `renderer` project on `src/renderer/**/__tests__/**/*.test.{ts,tsx}`). Several config headers name a root-level `vitest.config.ts` with `projects: [...]` as the longer-term shape per [ADR-022](../decisions/022-v1-toolchain-selection.md); it has not been authored. The Phase 1 sanity test lives at `packages/contracts/src/__tests__/sanity.test.ts`.

## Data And Storage Changes

Plan-001 owns two initial migrations — `packages/runtime-daemon/src/migrations/0001-initial.ts` (SQLite local-runtime) and `packages/control-plane/src/migrations/0001-initial.ts` (Postgres shared control-plane) — and declares the schema shape downstream plans depend on. The two engines are distinct per [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md) and ship under separate migration trees. The column-level definitions are canonical in the schema docs below; this plan body enumerates which elements are forward-declared for cross-plan consumers.

- Add the minimal `users` identity-anchor table (`id UUID PK`, `created_at TIMESTAMPTZ`) to Control Plane storage **before** any FK-bearing shared table. This anchor is required at Plan-001 migration time because `sessions.owner_user_id` and `runtime_node_attachments.user_id` both `REFERENCES users(id)`, and Plan-001/002 execute before Plan-016. Plan-001 owns the physical CREATE of the minimal shape only; identity/profile columns (`display_name`, `identity_ref`, `metadata`) and the `identity_mappings` side table are added by Plan-016 via additive ALTER migrations. See [Shared Postgres Schema §Users Identity Anchor](../architecture/schemas/shared-postgres-schema.md#users-identity-anchor-plan-001).
- Add the shared `sessions` table to Control Plane storage, with the session owner bound at create time on `owner_user_id UUID NOT NULL REFERENCES users(id)`. The `sessions` table carries `min_client_version TEXT` — NULL = no floor — forward-declared here per [ADR-018](../decisions/018-cross-version-compatibility.md) §Decision #1 (semver `"MAJOR.MINOR"` format) and §Decision #3 (monotonic session-floor enforcement); the control plane is authoritative for this field ([ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md)).
- Add local `session_events` and `session_snapshots` tables to Local Runtime Daemon SQLite.
- Add the local `session_console_state` table to Local Runtime Daemon SQLite — the session-scoped console store the composer draft, its staged attachments and the per-session step bound live in ([Local SQLite Schema §Session Console State (Plan-001)](../architecture/schemas/local-sqlite-schema.md#session-console-state-plan-001)).
- Forward-declare `session_events.pii_payload BLOB` (NULLable) per [Spec-020 §PII Data Map](../specs/020-data-retention-and-gdpr.md#pii-data-map) — semantics owned by Plan-020 (crypto-shred fan-out Path 1).
- Forward-declare the integrity-protocol columns on `session_events` — `monotonic_ns INTEGER NOT NULL`, `prev_hash BLOB NOT NULL`, `row_hash BLOB NOT NULL`, `daemon_signature BLOB NOT NULL`, `user_signature BLOB` — per [Spec-005 §Integrity Protocol](../specs/005-session-event-taxonomy-and-audit-log.md#integrity-protocol) (BLAKE3 row_hash + Ed25519 daemon_signature + RFC 8785 JCS canonical serialization hash chain; semantics owned by Plan-005).
- Forward-declare the `user_keys` table (per-user AES-256-GCM key custody; columns: `user_id` PK, `encrypted_key_blob`, `key_version`, `created_at`, `rotated_at`) per [Spec-020 §User Keys](../specs/020-data-retention-and-gdpr.md#user-keys) — semantics and DELETE-as-crypto-shred lifecycle owned by Plan-020.
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for canonical column definitions of `session_events`, `session_snapshots`, and `user_keys`.
- See [Shared Postgres Schema](../architecture/schemas/shared-postgres-schema.md) for canonical column definitions of `sessions` (including `owner_user_id` and `min_client_version`).

## Cross-Plan Forward-Declared Schema

Plan-001 emits the DDL above in the first migration. The downstream plans below own the read/write semantics and invariants for each forward-declared element. Engineers implementing Plan-001 MUST NOT add read/write logic for these columns; that logic belongs in the owner plan's implementation window.

| Forward-Declared Element | Semantics Owner | Invariant / Protocol |
| --- | --- | --- |
| `session_events.pii_payload` | [Plan-020](./020-data-retention-and-gdpr.md) | Encrypted under per-user AES-256-GCM key (key in `user_keys.encrypted_key_blob`); deleting the user's key row crypto-shreds this column by construction per [Spec-020 §Shred Fan-Out](../specs/020-data-retention-and-gdpr.md#shred-fan-out) Path 1 |
| `session_events.monotonic_ns / prev_hash / row_hash / daemon_signature / user_signature` | [Plan-005](./005-session-event-taxonomy-and-audit-log.md) | BLAKE3 hash chain + Ed25519 signatures over RFC 8785 JCS canonical bytes; `pii_payload` is excluded from canonical bytes but a `pii_ciphertext_digest` is embedded (one-way BLAKE3 over ciphertext) so signatures remain verifiable after crypto-shred per [Spec-020 §Signature Safety Under Shred](../specs/020-data-retention-and-gdpr.md#signature-safety-under-shred) |
| `user_keys` (table) | [Plan-020](./020-data-retention-and-gdpr.md) | Wrapped under daemon master key (XChaCha20-Poly1305); row DELETE = crypto-shred for all events authored by that user; rotation updates `key_version` and stamps `rotated_at` |
| `sessions.min_client_version` | [Plan-002](./002-runtime-node-attach.md) | Attach-time floor check: daemons below floor are admitted in read-only state; below-floor write attempts return typed `VERSION_FLOOR_EXCEEDED` per [ADR-018](../decisions/018-cross-version-compatibility.md) §Decision #4. Ejection is never the response (graceful degradation per [Spec-002 §Required Behavior](../specs/002-runtime-node-attach.md#required-behavior)) |
| `users` (minimal anchor: `id`, `created_at`) | [Plan-016](./016-identity-and-user-state.md) | Plan-001 creates the anchor row shape; no user rows are inserted until Plan-016's registration flow lands; Plan-016 adds `display_name`, `identity_ref`, `metadata`, and `identity_mappings` via additive ALTER migrations per [Shared Postgres Schema §Users and Identity](../architecture/schemas/shared-postgres-schema.md#users-and-identity-plan-016) |

## API And Transport Changes

- Add `SessionCreate`, `SessionRead`, and `SessionSubscribe` to the shared client SDK and daemon/control-plane contracts.
- `session.create` carries the session's one main agent — a saved agent definition named, or the axes spelled out — and its reply echoes the binding the daemon resolved for it: the driver, the model, the effort and the provider account ([Spec-001 §Interfaces And Contracts](../specs/001-session-core.md#interfaces-and-contracts)). The same resolved values ride `session.created`, which is where that agent's row in the session's `agents` projection is born, because no verb attaches an agent to a session ([Spec-005 §Event Type Enumeration](../specs/005-session-event-taxonomy-and-audit-log.md#event-type-enumeration)).
- `SessionSnapshot` carries two additive-optional members this plan's `session.read` answers with, both read by the session inspector and by nothing else. **`maxStepsPerTurn`** is that session's own bound on how many steps one turn may take, projected from the session record and absent where the person set none; its write is `session.maxStepsUpdate`, an owed verb registered in [api-payload-contracts.md §Session Method-Name Registry](../architecture/contracts/api-payload-contracts.md#session-method-name-registry) with the rest of the console's session mutations and built with them rather than here. **`address`** is the address another session writes to when it messages this one, read from the live provider process the session is bound to rather than stored on the record — so it is absent on a session with no live process, it is never cached, and it mints no read of its own. The override's durable home is `session_console_state` ([Local SQLite Schema §Session Console State (Plan-001)](../architecture/schemas/local-sqlite-schema.md#session-console-state-plan-001)), the daemon's own session-scoped store beside the draft and the staged attachments, created by an additive `0NNN-session-console-state.ts` with its paired `migration-runner.ts` guarded block in the same commit; the address is projected from a live process and adds no column anywhere.

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

### Daemon Projection Layer (`packages/runtime-daemon/src/session/`)

| ID | Test | Asserts | Spec-001 AC |
| --- | --- | --- | --- |
| D1 | `Single SessionCreated event yields snapshot with session owner and main channel` | bootstrap projection | AC1 |
| D2 | `Replay reads events by sequence ASC and reproduces snapshot deterministically` | replay correctness; `sequence` is the canonical ordering key per [ADR-017](../decisions/017-shared-event-sourcing-scope.md) | AC6 |
| D3 | `Replay uses sequence not monotonic_ns even when monotonic_ns is non-monotonic across rows` | clock-skew defense; `monotonic_ns` is within-daemon debug data, never the replay key (per [local-sqlite-schema §session_events](../architecture/schemas/local-sqlite-schema.md#session-events-plan-001-extended-by-plans-005-013)) | AC6 |
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
- All 16 enumerated tests above pass before Plan-001 is marked complete (3 C-tier + 5 D-tier + 2 P-tier + 5 I-tier + 1 W-tier tooling — see Phase 1 §Tests; CP-001-1 / CP-001-2 coverage via I5 / I6 lands at Phase 5 against the [Plan-021's partial substrate](./021-desktop-shell-and-renderer.md#partial-pr-sequence)).
- Test ID prefixes map to Phases as follows: W → Phase 1, C → Phase 2, D → Phase 3, P → Phase 4, I → Phase 5. Each Phase's Goal line names the ID range it owns.
- Spec-001 AC7 (concurrent channels and runs without timeline corruption) receives full coverage at the integration boundary in [Plan-028](./028-remote-control.md) when the relay flows land. Plan-001 covers AC7 only partially via I3's reconnect-ordering invariant — single-daemon concurrent SQL writes serialize on SQLite's `UNIQUE(session_id, sequence)` constraint, leaving cross-daemon concurrency as the residual coverage gap.

## Implementation Phase Sequence

Plan-001 implementation lands as a sequence of small PRs. Each PR exercises one slice of the contract → daemon → control-plane → SDK vertical. Phase 1 is workspace scaffolding only; subsequent PRs add behavior.

### Phase 1 — Workspace Bootstrap

**Precondition:** [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md) accepted — gates Phase 1 only.

**Goal:** All packages compile; one passing tooling test verifies the workspace is healthy; the daemon's native-binding rebuild path is exercised at bootstrap; the engineering CI surface (per [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md)) is wired and gates subsequent PRs.

**Ship-gate:** [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md) — V1 CI/CD, Pre-Commit Hooks, and Release Automation. The CI workflow files, lefthook + commitlint pre-commit framework, Renovate dependency-update config, Gitleaks secret scanner, `CODEOWNERS`, and code-signing custody scaffolding authored by ADR-023 land in this PR.

- Create root scaffolding (per § Repo Layout And Bootstrap above)
- Create empty `packages/contracts/`, `packages/client-sdk/`, `packages/runtime-daemon/`, `packages/control-plane/` skeletons with `package.json` + `tsconfig.json` + `src/index.ts` (no exports). At Phase 1, `apps/desktop/` is scaffolded as a placeholder workspace package only (single `src/index.ts` with the forward-declaration comment "split into `apps/desktop/src/{main,preload,renderer}/` per the electron-vite zero-config convention"); the substrate split (`apps/desktop/src/{main,preload,renderer}/`) is owned by [Plan-021's partial](./021-desktop-shell-and-renderer.md#partial-pr-sequence) and lands as a separate PR before Plan-001 Phase 5. The `apps/desktop/src/renderer/src/session-bootstrap/` extension at Phase 5 lands once Plan-021's partial repositions the placeholder.
- Install `better-sqlite3` 12.9+ as a workspace dep on `packages/runtime-daemon/` per [ADR-022](../decisions/022-v1-toolchain-selection.md). Even without imports, this exercises the postinstall native-binding rebuild path for the daemon target under `node-linker=isolated` at bootstrap time, surfacing native-rebuild integration risk before behavior PRs land.
- Install `pg` 8.20+ as a workspace dep on `packages/control-plane/` per [ADR-022](../decisions/022-v1-toolchain-selection.md)
- Wire engineering CI surface per [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md): `.github/workflows/{ci,release}.yml`, lefthook 2.1.6 + `lefthook.yml`, `lint-staged.config.mjs`, commitlint 20.5.2 config, Renovate config, Gitleaks workflow, `CODEOWNERS`, release-please-action@v5 + actions/attest@v4 release-automation skeleton (no actual release runs yet — first release is post-Plan-001 ship). The literal-file content for `lefthook.yml`, `CODEOWNERS`, `renovate.json5`, `eslint.config.mjs`, `prettier.config.js`, `commitlint.config.mjs`, and the three workflow files is the Phase 1 PR's authoring scope; [ADR-023 §Decision](../decisions/023-v1-ci-cd-and-release-automation.md#decision) pins versions and policy choices, the implementer of this Phase materializes the literal artifact contents.
- Verify: `pnpm install`, `pnpm turbo build`, `pnpm turbo typecheck`, and `pnpm turbo lint` all green; CI runs green on this PR; pre-commit hooks active locally; required-checks gate is enforced on subsequent PRs
- Single passing test (in `packages/contracts/src/__tests__/sanity.test.ts`): trivial sanity check that Vitest is wired (test ID **W1** per § Test And Verification Plan)

#### Tasks

##### T1.1 — Workspace root scaffolding

**Files:** `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.npmrc`, `.nvmrc` **Reference:** [§Repo Layout And Bootstrap →§Root Scaffolding](#root-scaffolding); [ADR-022](../decisions/022-v1-toolchain-selection.md) **Acceptance:** `pnpm install` succeeds; `pnpm-workspace.yaml` declares `packages/*` and `apps/*`; `tsconfig.base.json` has `"strict": true` + `"isolatedDeclarations": true` + ESM-only; `.npmrc` has `node-linker=isolated`; `.nvmrc` pins lower-tier Node target. **Spec coverage:** none (workspace-root bootstrap) **Verifies invariant:** none (workspace bootstrap)

##### T1.2 — Per-package skeletons (`apps/desktop/` ships placeholder; Plan-021's partial delivery repositions)

**Files:** `packages/{contracts,client-sdk,runtime-daemon,control-plane}/{package.json,tsconfig.json,src/index.ts}` + `apps/desktop/{package.json,tsconfig.json,src/index.ts}` (placeholder) **Acceptance:** each `package.json` has `"type": "module"`, `engines.node` per ADR-022 two-tier rule (lower for `contracts`/`client-sdk`/`runtime-daemon`/`apps/desktop`, upper for `control-plane`); each `tsconfig.json` extends `../../tsconfig.base.json`; each `src/index.ts` is empty (no exports). The `apps/desktop/src/index.ts` placeholder carries a forward-declaration comment ("split into `apps/desktop/src/{main,preload,renderer}/` per the electron-vite zero-config convention") that [Plan-021's partial T-021p-1-1](./021-desktop-shell-and-renderer.md#partial-pr-sequence) repositions during the substrate-split PR. **Spec coverage:** none (per-package scaffold) **Verifies invariant:** none

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

**Goal:** Tests C1–C3 from § Test And Verification Plan go green.

- `packages/contracts/src/session.ts` — `SessionId`, `SessionCreate`, `SessionRead`, `SessionSubscribe` payload schemas. `SessionCreate` names the one main agent on the request — a saved definition id, or the axes spelled out — and its response echoes the resolved binding (driver, model, effort, provider account) beside the session id, state and initial channels. Plan-001 also exports `SessionSubscribeStream = AsyncIterable<EventEnvelope>` typed against an opaque `EventEnvelope` placeholder per **C-6** (forward-stub for Plan-005); the stub is narrowed when Plan-005 ships.
- `packages/contracts/src/event.ts` — `SessionEvent` discriminated union (V1 subset: `SessionCreated`, `ChannelCreated`). `SessionCreated` carries a per-type payload rather than the shared state-transition shape: `{sessionId, mainAgent, actor?}`, where `mainAgent` holds every value the daemon resolved when it started the session — the agent id it minted, the definition id where one was named, the name, driver, model, provider account and effort, the four axes the daemon reads for itself (posture mode, tool allowlist, instructions, goal) and the resolved agent state — the same values the create reply echoes, so wire and durable record serialize identically ([Spec-005 §Event Type Enumeration](../specs/005-session-event-taxonomy-and-audit-log.md#event-type-enumeration)). The discriminator surface in `api-payload-contracts.md` (per C-6) lands the same Phase as this file.
- `packages/contracts/src/error.ts` — the `version.floor_exceeded` and `version.ceiling_exceeded` shapes per [ADR-018 §Decision #4](../decisions/018-cross-version-compatibility.md#decision). The runtime guards land in later Phases / Plans; Phase 2 ships the wire-shape contracts only.

#### Tasks

##### T2.1 — `SessionId`, `SessionCreate`, `SessionRead`, `SessionSubscribe` payload schemas

**Files:** `packages/contracts/src/session.ts`, `packages/contracts/src/__tests__/session-id.test.ts`, `packages/contracts/src/__tests__/session-create.test.ts`, `packages/contracts/src/__tests__/session-read.test.ts`, `packages/contracts/src/__tests__/session-subscribe.test.ts` **Spec coverage:** Spec-001 AC1, AC3; Spec-001 §Interfaces And Contracts (the main agent named on create and the resolved binding echoed in the reply) **Verifies invariant:** none (contract layer)

##### T2.2 — `SessionEvent` discriminated union

**Files:** `packages/contracts/src/event.ts`, `packages/contracts/src/__tests__/session-event.test.ts` **Spec coverage:** Spec-001 AC1, AC6; Spec-005 §Event Type Enumeration (`session.created`'s `mainAgent` payload) **Verifies invariant:** none

##### T2.3 — Error contracts: `version.floor_exceeded`, `version.ceiling_exceeded`

**Files:** `packages/contracts/src/error.ts`, `packages/contracts/src/__tests__/error.test.ts` **Spec coverage:** ADR-018 §Decision #4 version-error shapes **Verifies invariant:** none

### Phase 3 — Daemon Migration And Projection

**Precondition:** Phase 2 merged (contract types — `SessionEvent` discriminated union — are imported by the projector).

**Goal:** Tests D1–D5 go green.

- `packages/runtime-daemon/src/migrations/0001-initial.ts` migration creates `session_events`, `session_snapshots`, `user_keys`, `schema_version` (per § Data And Storage Changes; columns forward-declared but only `session_events` core columns are populated by Plan-001). The migration also INSERTs `(version=1, applied_at=now())` into `schema_version` so downstream plans (`0002-*.ts` onward) have a row to upsert against.
- **Pragmas.** Daemon bootstrap (or migration runner) MUST set `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000` per [Local SQLite Schema §Pragmas](../architecture/schemas/local-sqlite-schema.md#pragmas) before the first projector apply().
- **Integrity-column placeholder convention.** Plan-001's append path (`SessionService.append`, not the projector — `session-projector.ts` is a pure reducer) writes zero-fill placeholders into `prev_hash` and `row_hash` (`Buffer.alloc(32)` — 32 zero bytes each) and into `daemon_signature` (`Buffer.alloc(64)` — 64 zero bytes, the width `0001-initial.ts`'s `CHECK(length(daemon_signature) = 64)` enforces) to satisfy NOT NULL until Plan-005 lands. Plan-005 does NOT backfill or overwrite them: a row still carrying all three placeholders is refused fail-closed at verification time — `verifyRow` returns the twelfth `failureMode` value `signature_placeholder` before any Ed25519 verification is attempted, and the row is never "repaired" by signing it with a current key, because retro-signing an old record with a later key is a published attack no raw-Ed25519 verifier can detect after the fact (per [Spec-005 §Integrity Protocol](../specs/005-session-event-taxonomy-and-audit-log.md#integrity-protocol)). No durable writer reaches the placeholder path: `SessionService.append` throws unless the service is constructed with the test-only `allowUnsignedPlaceholderAppend` opt-in, whose nominal token is issued only by its `forTestsOnly()` static and identity-checked at construction, so no configuration- or environment-derived value can ever be the token. Plan-002's `RuntimeNodeEventEmitter` depends on the structural `SessionEventLog` seam in `node-event-emitter.ts` rather than on `SessionService` — a seam that is synchronous-transactional by contract (the emitter refuses a thenable `append` result fail-closed). Plan-005 T3.1's `EventLogService.append` is the sole durable writer and it signs; T3.1 re-points the emitter onto that durable append path and restructures the producers' dual-write atomicity around `withSessionAppendLock`. See [§Cross-Plan Forward-Declared Schema](#cross-plan-forward-declared-schema).
- `packages/runtime-daemon/src/session/session-projector.ts` — single-event-to-snapshot projection. Projector signatures: `apply(snapshot: Snapshot, event: SessionEvent): Snapshot`; `replay(events: ReadonlyArray<EventRow>): Snapshot` ordered by `sequence ASC` per I-001-2. `Snapshot` shape per [api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md) (the Plan-001 block, `SessionSnapshot`).
- `packages/runtime-daemon/src/session/session-service.ts` — append + replay paths. `create` resolves the main agent's binding before it appends — the driver, the model, the effort and the provider account, from the named definition or the axes the request spelled out — mints that agent's id, appends `session.created` carrying those resolved values as `mainAgent`, and echoes the same values in its reply; the projector reads that payload as the creating record of the agent's row, so a projector that ignored it could not rebuild one. Service signatures: `SessionService.create(req: SessionCreateRequest): Promise<SessionCreateResponse>`; `read(req: SessionReadRequest): Promise<SessionReadResponse>`; `subscribe(req: SessionSubscribeRequest): SessionSubscribeStream` (`LocalSubscriptionProducer<T>` per Plan-006 partial substrate's IPC shape).
- Storage driver: `better-sqlite3` 12.9+ per [ADR-022](../decisions/022-v1-toolchain-selection.md) (already installed in Phase 1). Replay key: `sequence` per [ADR-017](../decisions/017-shared-event-sourcing-scope.md).

#### Tasks

##### T3.1 — `0001-initial.ts` migration + pragmas

**Files:** `packages/runtime-daemon/src/migrations/0001-initial.ts`, daemon bootstrap shim that applies pragmas **Spec coverage:** Spec-001 AC2 (durability) **Verifies invariant:** I-001-3 (forward-declared shape stable, verified by D5)

##### T3.2 — Projector reducer + replay

**Files:** `packages/runtime-daemon/src/session/session-projector.ts`, `packages/runtime-daemon/src/session/__tests__/session-projector.test.ts` **Spec coverage:** Spec-001 AC1, AC6; Spec-005 §Event Type Enumeration (`session.created` is the creating record of the main agent's row, so replaying it is how that row exists) **Verifies invariant:** I-001-2 (sequence ASC replay)

##### T3.3 — Service surface (create/read/subscribe)

**Files:** `packages/runtime-daemon/src/session/session-service.ts`, `packages/runtime-daemon/src/session/__tests__/session-service.test.ts` **Spec coverage:** Spec-001 AC1, AC2, AC6; Spec-001 §Interfaces And Contracts (the resolved binding echoed on create and carried on `session.created`) **Verifies invariant:** none (driver-agnostic; D1-D4 verify behavior)

##### T3.4 — Migration-shape regression test

**Files:** `packages/runtime-daemon/src/session/__tests__/migration-shape.test.ts` **Spec coverage:** none (invariant-only) **Verifies invariant:** I-001-3 (D5)

### Phase 4 — Control Plane Directory

**Precondition:** Phase 2 merged (control-plane imports `SessionCreate` / `SessionRead` payload schemas from contracts). Phase 3 is independent and may land in either order; the two are decoupled at the contract boundary.

**Goal:** Tests P1–P2 go green.

- `packages/control-plane/src/migrations/0001-initial.ts` migration creates `users` (minimal anchor: `id`, `created_at`) and `sessions` (with `owner_user_id` and `min_client_version`, per § Data And Storage Changes), plus the canonical indexes per [Shared Postgres Schema §Sessions](../architecture/schemas/shared-postgres-schema.md#sessions-plan-001) (`idx_sessions_state`, `idx_sessions_owner_user`).
- **Migration-order invariant.** `CREATE TABLE users` MUST precede `CREATE TABLE sessions` per [Shared Postgres Schema §Migration-order invariant](../architecture/schemas/shared-postgres-schema.md#users-identity-anchor-plan-001) — both `sessions.owner_user_id` and any later FK-bearing table resolve against the anchor.
- **`min_client_version` boundary.** The column ships forward-declared (NULL default) only; Plan-001 ships the column shape but does NOT author read/write logic per [§Cross-Plan Forward-Declared Schema](#cross-plan-forward-declared-schema) and [I-001-3](#i-001-3--forward-declared-columns-are-immutable-in-scope). Attach-time floor enforcement is owned by [Plan-002](./002-runtime-node-attach.md) per [Spec-002 §Required Behavior](../specs/002-runtime-node-attach.md#required-behavior).
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

- **Lane A** (T5.1, T5.5 — `sessionClient.ts` + `pg.Pool`-backed `Querier` composition): T5.1 consumes the [Plan-006 partial sequence](./006-local-ipc-and-daemon-control.md#partial-pr-sequence) (SecureDefaults Bootstrap, Wire Substrate, `session.*` Handlers + SDK Layer) and the control-plane bootstrap (tRPC v11 server + `sessionRouter` + SSE substrate). T5.5 is pure `packages/control-plane/` work with no cross-plan substrate dependency.
- **Lane B** (T5.4 — `spawn-cwd-translator.ts`): unblocks once [Plan-022 T-022-2-1](./022-rust-pty-sidecar.md) ships the `PtyHostContract` interface at `packages/contracts/src/pty-host.ts`.
- **Lane C** (T5.2 — `apps/desktop/src/renderer/src/session-bootstrap/` renderer wiring): unblocks once [Plan-021's partial Phase 1](./021-desktop-shell-and-renderer.md#partial-pr-sequence) ships the `apps/desktop/src/{main,preload,renderer}/` workspace package substrate: the directory tree + electron-vite v5 toolchain + minimal entrypoints that T5.2 extends with content. T5.2 also installs the renderer-unit-test infrastructure (`@testing-library/react`, `happy-dom`, `apps/desktop/vitest.config.ts`, renderer sibling test-tsconfig (`apps/desktop/src/renderer/tsconfig.test.json`)) that Plan-021's partial Phase 1 substrate does not ship.
- **Lane D** (T5.3 — `apps/desktop/src/main/sidecar-lifecycle.ts`): unblocks once both (i) [Plan-021's partial Phase 1](./021-desktop-shell-and-renderer.md#partial-pr-sequence) AND (ii) [Plan-022 Phase 3](./022-rust-pty-sidecar.md) ship — the latter supplies the `PtyHost.close(sessionId)` + `KillRequest` primitives the lifecycle handler consumes.

Phase 1–Phase 4 may proceed independently; the per-lane substrate dependencies only bind at Phase 5.

- `packages/client-sdk/src/sessionClient.ts` — `create`, `read`, `subscribe` methods over the daemon and control-plane transports.
  - **Daemon transport** (`create` / `read` / `subscribe` over local IPC): consumes the Plan-006 partial-deliverable substrate — JSON-RPC 2.0 + LSP-style Content-Length framing, the `session.*` JSON-RPC method namespace, and the SDK Zod layer (~500–1000 LOC per [Spec-006 §Wire Format](../specs/006-local-ipc-and-daemon-control.md#wire-format)). `subscribe` rides the JSON-RPC 2.0 streaming primitive (Plan-006 partial substrate's `LocalSubscriptionProducer<T>` shape).
  - **Control-plane transport** (`create` / `read` / `subscribe` over HTTP/SSE): consumes the control-plane bootstrap substrate (now owned by [Plan-028](./028-remote-control.md)) — tRPC v11 server skeleton + `sessionRouter` HTTP handlers wrapping the existing `packages/control-plane/src/sessions/session-directory-service.ts` (shipped in Phase 4). `subscribe` is request-only on the wire — the response is an `AsyncIterable<EventEnvelope>` SSE stream per `packages/contracts/src/session.ts#SessionSubscribeRequest`.
- `apps/desktop/src/renderer/src/session-bootstrap/` — minimal renderer wiring that calls `sessionClient.create` and renders the resulting session. The directory tree is owned by [Plan-021's partial](./021-desktop-shell-and-renderer.md#partial-pr-sequence); Plan-001 Phase 5 authors the file content here.
- `apps/desktop/src/main/sidecar-lifecycle.ts` — sidecar-cleanup handler registered **before** Electron `app.on('will-quit', ...)` per §Cross-Plan Obligations CP-001-1. Delegates to the polymorphic `PtyHost.shutdown({ perSessionTimeoutMs: 2000, hostTimeoutMs: 2000 })` (defined on the `PtyHost` interface at `packages/contracts/src/pty-host.ts`) which runs per-session SIGTERM→SIGKILL escalation (2 s per-session bounded timeout) AND sidecar-process stdin-close → child-exit await → `taskkill /T /F /PID` escalation (2 s host bounded timeout). The lifecycle wiring layer never touches a backend-specific surface ([ADR-019 §Decision](../decisions/019-windows-v1-tier-and-pty-sidecar.md#decision) item 8 polymorphism: "Consumers never see the backend choice"). The `apps/desktop/src/main/` directory is owned by [Plan-021's partial](./021-desktop-shell-and-renderer.md#partial-pr-sequence); Plan-001 Phase 5 authors the file content here per CP-001-1 content-ownership.
- `packages/runtime-daemon/src/session/spawn-cwd-translator.ts` — daemon-layer `PtyHost.spawn(spec)` wrapper per §Cross-Plan Obligations CP-001-2; substitutes a stable parent dir for `SpawnRequest.cwd` and prepends a `cd <worktree-path> && ` shell prefix (or sets `CWD=<worktree-path>` env per agent CLI conventions). Wraps both `RustSidecarPtyHost` and `NodePtyHost` because the constraint is OS-level. The per-driver dispatch is named per target in the implementing change, on the working assumption that shell sessions use the cd-prefix and agent CLIs that read `CWD` from the environment (`claude-driver`, `codex-driver`) use the env strategy. The cd-prefix strategy mutates the command string (visible to Plan-005 audit-log canonical hash); CWD-env mutates process environment (invisible to canonical bytes) — pick is consequential to integrity protocol but Plan-005 owns the integrity test that catches inconsistency.
- Compose a `pg.Pool`-backed `Querier` for `SessionDirectoryService` (the Phase 4 service is constructed against `Querier` and is driver-agnostic; Phase 4 ships only a PGlite path because the integration tests run on the in-process driver).

#### Tasks

##### T5.1 — `sessionClient.ts` daemon + control-plane transport

**Files:** `packages/client-sdk/src/sessionClient.ts`, `packages/client-sdk/test/sessionClient.integration.test.ts` **Spec coverage:** Spec-001 AC1, AC3, AC6 **Verifies invariant:** none (integration-layer wrapper)

##### T5.2 — `apps/desktop/src/renderer/src/session-bootstrap/` renderer wiring

**Files:** `apps/desktop/src/renderer/src/session-bootstrap/index.ts`, `apps/desktop/src/renderer/src/session-bootstrap/SessionBootstrap.tsx`, `apps/desktop/src/renderer/src/session-bootstrap/__tests__/SessionBootstrap.test.tsx`, `apps/desktop/src/renderer/src/App.tsx`, `apps/desktop/package.json`, `apps/desktop/vitest.config.ts`, `apps/desktop/src/renderer/tsconfig.json`, `apps/desktop/src/renderer/tsconfig.test.json` **Acceptance:** the component invokes `sessionClient.create` (over the bridge → daemon transport per T5.1) on mount, renders a placeholder while pending, swaps to a session-summary view on resolve, and surfaces the error envelope on reject. The `App.tsx` placeholder shipped by [Plan-021's partial T-021p-1-5](./021-desktop-shell-and-renderer.md#partial-pr-sequence) routes to this component; the manual desktop smoke test passes per §Verification. **Spec coverage:** Spec-001 AC1 **Verifies invariant:** none (renderer composition over the bridge surface)

##### T5.3 — `apps/desktop/src/main/sidecar-lifecycle.ts` will-quit drain orchestration via polymorphic `PtyHost.shutdown()`

**Files:** `packages/contracts/src/pty-host.ts` (extends `PtyHost` interface with `shutdown(options): Promise<DrainResult>` + exports `DrainResult`), `packages/runtime-daemon/src/pty/node-pty-host.ts` (in-process `shutdown()` implementation), `packages/runtime-daemon/src/pty/rust-sidecar-pty-host.ts` (out-of-process `shutdown()` implementation with sidecar wind-down + crash-budget suppression), `packages/runtime-daemon/src/session/__tests__/spawn-cwd-translator.windows.test.ts` (RecordingPtyHost structural-conformance stub), `apps/desktop/src/main/sidecar-lifecycle.ts` (lifecycle wiring module — Shape A lazy `PtyHostGetter`), `apps/desktop/src/main/index.ts` (registers `registerSidecarLifecycle(app, () => null)` at position 0), `apps/desktop/test/sidecar-lifecycle.test.ts` (FIFO position 0 + drain orchestration tests), `packages/runtime-daemon/src/pty/__tests__/node-pty-host.shutdown.test.ts` (in-process backend tests), `packages/runtime-daemon/src/pty/__tests__/rust-sidecar-pty-host.shutdown.test.ts` (out-of-process backend tests — verifies I5 — CP-001-1 + Plan-022 I-022-4) **Acceptance:** module exports `registerSidecarLifecycle(app: App, getPtyHost: PtyHostGetter, deps?: SidecarLifecycleDeps): void`; calling it before any `app.on('will-quit', ...)` registration in `apps/desktop/src/main/index.ts` (per [Plan-021 T-021p-1-3](./021-desktop-shell-and-renderer.md#partial-pr-sequence) — the entrypoint exposes the registration slot) handles will-quit by delegating to the polymorphic `PtyHost.shutdown({ perSessionTimeoutMs: 2000, hostTimeoutMs: 2000 })` which drains active sessions via per-session SIGTERM→SIGKILL escalation (2 s per-session bounded timeout) and winds down the sidecar process via stdin-close → child-exit wait → taskkill /T /F /PID escalation (2 s host bounded timeout). The host shutdown sequence is terminal — the host instance refuses new spawns post-shutdown entry; the deliberate sidecar exit suppresses the `-1` crash sentinel and skips crash-budget accounting per `shuttingDown` flag. ADR-019 §Decision item 8 polymorphism preserved: the wiring layer never touches a backend-specific surface. **Spec coverage:** none (verifies obligation CP-001-1 + inherited Plan-022 I-022-4) **Verifies invariant:** I-022-4 (inherited from Plan-022 together with obligation CP-001-1; exercised end-to-end by test I5)

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

## Done Checklist

- [x] Code changes implemented — Phases 1-5 across contracts, daemon, control plane, client SDK and desktop bootstrap.
- [x] Tests added or updated — C1-C3 (contracts), D1-D5 (daemon migration + projection, including the D5 migration-shape snapshot), P1-P2 (control-plane directory), and the I-tier suite at Phase 5: cross-platform unit tests plus platform-gated Windows-CI tests for T5.4, a happy-dom renderer suite for T5.2, and per-backend shutdown plus FIFO-position-0 lifecycle tests for T5.3.
- [x] Verification completed — the I-tier unit and integration suite is green.
- [x] Related docs updated.
- [x] All `TODO(Plan-001 Phase N)` annotations in the source tree are resolved or moved to a follow-up issue: `rg "TODO\(Plan-001 " packages/ apps/` returned zero matches on 2026-05-20.
