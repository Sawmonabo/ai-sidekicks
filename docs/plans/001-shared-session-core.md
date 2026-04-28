# Plan-001: Shared Session Core

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**          | `approved`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **NNN**             | `001`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Slug**            | `shared-session-core`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Date**            | `2026-04-14`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Author(s)**       | `Codex`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Spec**            | [Spec-001: Shared Session Core](../specs/001-shared-session-core.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Required ADRs**   | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-002](../decisions/002-local-execution-shared-control-plane.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-017](../decisions/017-shared-event-sourcing-scope.md), [ADR-018](../decisions/018-cross-version-compatibility.md), [ADR-022](../decisions/022-v1-toolchain-selection.md), [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md). **Phase 1 ship-gate**: [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md) governs the engineering CI surface that lands in Phase 1 (accepted 2026-04-26 per [BL-100](../backlog.md)).                                                                                                      |
| **Dependencies**    | Phase 1–Phase 4: None (tier-entry plan; owns `0001-initial.sql` migration and forward-declares schema shape consumed by [Plan-003](./003-runtime-node-attach.md), [Plan-006](./006-session-event-taxonomy-and-audit-log.md), [Plan-022](./022-data-retention-and-gdpr.md)). Phase 5 only: [Plan-007](./007-local-ipc-and-daemon-control.md) partial-deliverable (Tier 1 IPC wire substrate + `session.*` namespace + SDK Zod layer per Spec-007 §Wire Format) and [Plan-008](./008-control-plane-relay-and-session-join.md) bootstrap-deliverable (Tier 1 tRPC v11 server skeleton + `sessionRouter` HTTP handlers + SSE substrate for `SessionSubscribe`). See [cross-plan-dependencies.md §5 Plan-007 + Plan-008 Tier 1 carve-outs](../architecture/cross-plan-dependencies.md#plan-007-substrate-vs-namespace-carve-out-tier-1--tier-4). |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Goal

Implement the minimum session creation, join, snapshot, and replay foundation used by all later features.

## Scope

This plan covers session ids, default channel creation, owner membership bootstrap, local event append, and typed session read or subscribe APIs.

## Non-Goals

- Invite lifecycle
- Runtime-node attach
- Queue and intervention behavior

## Invariants

The following invariants are **load-bearing** and MUST be preserved across all Plan-001 PRs and downstream extensions. Any change that would weaken or remove an invariant requires a coordinated cross-plan amendment (see [cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md)).

### I-001-1 — Lock-ordering: `sessions` → `session_memberships`

Any transaction that touches both `sessions` and `session_memberships` MUST acquire row locks in the order `sessions` → `session_memberships`. This is the canonical ordering enforced by `createSession` in `packages/control-plane/src/sessions/session-directory-service.ts` (see the "Lock-acquisition order" docstring paragraph).

**Why load-bearing.** Plan-002 ownership-transfer, co-owner promotion, and invite-accept paths mutate `session_memberships` while validating `sessions`. Inconsistent lock acquisition across Plan-001 + Plan-002 callers would produce cross-plan deadlocks under concurrent membership churn. The invariant is also recorded in [cross-plan-dependencies.md §1 Lock Ordering Across Shared Tables](../architecture/cross-plan-dependencies.md#lock-ordering-across-shared-tables) so Plan-002 implementers see it before reaching the source docstring.

**Verification.** Plan-001 Phase 4 ships a lock-ordering test against the `Querier` abstraction; Phase 5 strengthens that test to discriminate which `Querier` instance issued each statement (see `TODO(Plan-001 Phase 5)` in `packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts`). Plan-002 PRs that add new transactional callers MUST extend the same test with their caller name.

### I-001-2 — Sequence is the canonical replay key

Local Runtime Daemon SQLite replay MUST order `session_events` by `sequence ASC`, never by `monotonic_ns`. The `monotonic_ns` column is within-daemon debug data only (per [local-sqlite-schema §session_events](../architecture/schemas/local-sqlite-schema.md)); it can be non-monotonic across rows after clock adjustments and MUST NOT influence replay or projection.

**Why load-bearing.** Replay determinism is the foundation for [ADR-017](../decisions/017-shared-event-sourcing-scope.md) event-sourcing semantics. Plan-006 (event taxonomy + integrity protocol) and Plan-015 (replay/recovery) build on this invariant.

**Verification.** Test D3 in §Test And Verification Plan asserts `Replay uses sequence not monotonic_ns even when monotonic_ns is non-monotonic across rows`.

### I-001-3 — Forward-declared columns are immutable in scope at Tier 1

The forward-declared columns and tables enumerated in §Cross-Plan Forward-Declared Schema (Plan-001 emits the DDL, downstream plans own the semantics) MUST NOT be re-shaped by Plan-001 PRs. Plan-001 ships the column types and nullability authoritatively at the Tier 1 migration; the corresponding semantics owners (Plan-006 integrity, Plan-022 GDPR, Plan-018 identity, Plan-003 version-floor) author all read/write logic at their own tiers.

**Why load-bearing.** Re-shaping a forward-declared column post-Tier-1 would force a breaking schema migration after V1 ships — the entire point of the forward-declaration pattern is that V1 ships immutable initial DDL.

**Verification.** Migration-shape regression test asserts the column set in `0001-initial.sql` matches the canonical schema docs.

## Cross-Plan Obligations

Plan-001 owns the daemon-side session lifecycle and the `PtyHost.spawn` entry-point wrapper. Two daemon-layer obligations are declared by Plan-024 (Rust PTY Sidecar) and surface here for bidirectional citation locality, so a Plan-001 reviewer sees the obligations without first reading Plan-024. Each entry mirrors the Plan-003 §Cross-Plan Obligations shape: the obligation, the source citation, and the resolution.

### CP-001-1 — Sidecar-cleanup handler registers BEFORE Electron `will-quit`

[Plan-024 §Invariants I-024-4](./024-rust-pty-sidecar.md#i-024-4--daemons-sidecar-cleanup-handler-registers-before-electron-will-quit) declares that the daemon's sidecar-cleanup handler MUST register before Electron's `will-quit` handler. Under Electron's event-emitter semantics, registration order is run order; if the daemon's cleanup handler is late-registered, the renderer process terminates before active PTY sessions drain and child processes orphan to the global console (the `microsoft/node-pty#904` SIGABRT-on-exit class — primary source cited at [Plan-024 §Windows Implementation Gotchas Gotcha 4](./024-rust-pty-sidecar.md#4-electron-will-quit-ordering-vs-sidecar-shutdown)).

**Resolution.** Plan-001 Phase 5 (Client SDK and Desktop Bootstrap) authors the desktop-shell sidecar-lifecycle wiring under `apps/desktop/main/` so the cleanup handler registers in the Electron `app.on('will-quit', ...)` slot **before** any other handler that depends on the renderer. The handler invokes `PtyHost.close(sessionId)` for every active session, awaits the per-session `ExitCodeNotification` with a bounded 2 s timeout, then closes the sidecar's stdin and awaits the sidecar process exit (second bounded timeout). Escalation to `taskkill /T /F /PID <sidecar-pid>` on hard timeout matches §Invariants CP-001-2 below for the same hard-stop pattern.

**Why surfaced in Plan-001.** This obligation lives at the desktop-shell session-lifecycle layer (Plan-001 owns the session-lifecycle daemon code), not at the sidecar protocol layer (Plan-024 supplies only the `PtyHost.close(sessionId)` and `KillRequest` primitives). Without the bidirectional citation, a Plan-001 reviewer would have no signal that the will-quit handler exists as a Plan-001 obligation; the asymmetry that the audit caught.

### CP-001-2 — `PtyHost.spawn(spec)` performs daemon-layer cwd-translation for worktree paths

[Plan-024 §Invariants I-024-5](./024-rust-pty-sidecar.md#i-024-5--spawnrequestcwd-carries-a-stable-path-daemon-performs-worktree-translation) declares that the sidecar's `SpawnRequest.cwd` MUST always carry a stable, unmovable parent directory; worktree paths live in the command-string-or-env layer above. Without daemon-layer translation, the sidecar would forward worktree paths verbatim to `portable-pty::PtySize::spawn_command`, Windows would lock the worktree directory (`ERROR_SHARING_VIOLATION`), and `git worktree remove` would fail until every spawned session under that worktree exited (the `microsoft/node-pty#647` class — primary source cited at [Plan-024 §Windows Implementation Gotchas Gotcha 5](./024-rust-pty-sidecar.md#5-spawn-locks-cwd-on-windows)).

**Resolution.** Plan-001 Phase 5 (Client SDK and Desktop Bootstrap) ships a daemon-layer `PtyHost.spawn` wrapper that intercepts `spec.cwd`, substitutes a stable parent directory (the daemon's working dir or user-home root) for the protocol-level `SpawnRequest.cwd`, and prepends a `cd <worktree-path> && ` shell prefix (or sets `CWD=<worktree-path>` env, depending on whether the agent CLI consumes `cd` semantics or env-based cwd). The wrapper sits in `packages/runtime-daemon/src/session/` (Plan-001's session lifecycle layer) so both `RustSidecarPtyHost` and `NodePtyHost` inherit the same translation — the constraint is OS-level, not backend-specific, per Plan-024 I-024-5.

**Why surfaced in Plan-001.** ADR-006 (Worktree-First Execution Mode) bakes worktree paths into the daemon's session-spawn entry point. The translation MUST happen between the daemon's logical worktree-path API and the sidecar's wire-protocol `SpawnRequest.cwd` — i.e., in Plan-001's session-lifecycle code, not in Plan-024's sidecar code (the sidecar deliberately does not know about worktree semantics, per Plan-024 I-024-3 / I-024-5). Plan-024 Phase 3 carries an explicit `**Precondition:**` line on this wrapper because the sidecar end-to-end test would surface `ERROR_SHARING_VIOLATION` on Windows CI without it.

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted (plan body)
- [x] **Phase 1 ship-gate**: [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md) — V1 CI/CD, Pre-Commit Hooks, and Release Automation accepted 2026-04-26 per [BL-100](../backlog.md). The engineering CI surface that lands in Phase 1 (`.github/workflows/{ci,release}.yml`, lefthook 2.1.6 pre-commit framework, commitlint 20.5.2, Renovate dependency-update config, Gitleaks v8.30+ secret scanner, release-please-action@v5 + actions/attest@v4 release skeleton, code-signing custody artifacts) is now governed by an accepted ADR.
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/session.ts`
- `packages/client-sdk/src/sessionClient.ts`
- `packages/runtime-daemon/src/session/session-service.ts`
- `packages/runtime-daemon/src/session/session-projector.ts`
- `packages/control-plane/src/sessions/session-directory-service.ts`
- `apps/desktop/renderer/src/session-bootstrap/`

## Repo Layout And Bootstrap

Workspace topology is authoritative in [Container Architecture](../architecture/container-architecture.md). Toolchain primitives, version pins, and two-tier Node target rules are authoritative in [ADR-022](../decisions/022-v1-toolchain-selection.md). Plan-001's first migration owns the bootstrap artifacts that wire those choices into the repo.

### Root Scaffolding

- `package.json` — workspace root with `"private": true`, `packageManager` and `engines.node` constraints per [ADR-022](../decisions/022-v1-toolchain-selection.md)
- `pnpm-workspace.yaml` — declares `packages/*` and `apps/*`
- `turbo.json` — `build`, `test`, `lint`, `typecheck`, and `dev` task pipelines
- `tsconfig.base.json` — strict + `isolatedDeclarations: true` + ESM-only; per-package `tsconfig.json` extends base
- `.npmrc` — `node-linker=isolated` (required by [ADR-022](../decisions/022-v1-toolchain-selection.md) two-ABI native binding constraint)
- `.nvmrc` — pins the lower-tier Node target per [ADR-022](../decisions/022-v1-toolchain-selection.md)
- `eslint.config.mjs` and `prettier.config.js` at root

**Engineering CI surface** — `.github/workflows/{ci,release}.yml`, lefthook 2.1.6 pre-commit hook framework + `lefthook.yml`, `lint-staged.config.mjs`, commitlint 20.5.2 config (10-type set, drops `style`), Renovate config (`renovate.json5` with `minimumReleaseAge: 14 days`), `CODEOWNERS`, Gitleaks v8.30+ workflow, and code-signing custody artifacts (Apple Developer Individual + Azure Artifact Signing OIDC + Sigstore keyless + AWS KMS Ed25519 hot key + YubiHSM 2 cold key envelope) are owned by [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md) (accepted 2026-04-26 per [BL-100](../backlog.md)). Phase 1 lands the concrete artifact list per ADR-023 §Decision.

### Per-Package Scaffolding

Every `packages/*` and `apps/*` member receives a `package.json` (with `"type": "module"`, `engines.node` matching its tier per [ADR-022](../decisions/022-v1-toolchain-selection.md), and an `exports` map), a `tsconfig.json` extending base, and a `src/` directory.

Electron-bound packages (`apps/desktop/*`, `packages/runtime-daemon/*`) use the lower-tier Node target. Control-plane packages (`packages/control-plane/*`) use the upper-tier target. Shared packages consumed by both sides (`packages/contracts/*`, `packages/client-sdk/*`) target the lower tier as the lowest common denominator.

## Data And Storage Changes

Plan-001 owns the initial migration (`0001-initial.sql`) and declares the schema shape downstream plans depend on. The column-level definitions are canonical in the schema docs below; this plan body enumerates which elements are forward-declared for cross-plan consumers.

- Add the minimal `participants` identity-anchor table (`id UUID PK`, `created_at TIMESTAMPTZ`) to Collaboration Control Plane storage **before** any FK-bearing shared table. This anchor is required at Plan-001 migration time because `session_memberships.participant_id`, `session_invites.inviter_id`, and `runtime_node_attachments.participant_id` all `REFERENCES participants(id)`, and Plan-001/002/003 execute before Plan-018 per [cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md). Plan-001 owns the physical CREATE of the minimal shape only; identity/profile columns (`display_name`, `identity_ref`, `metadata`) and the `identity_mappings` side table are added by Plan-018 via additive ALTER migrations. See [Shared Postgres Schema §Participants Identity Anchor](../architecture/schemas/shared-postgres-schema.md#participants-identity-anchor-plan-001).
- Add shared `sessions` and `session_memberships` tables to Collaboration Control Plane storage. The `sessions` table carries `min_client_version TEXT` — NULL = no floor — forward-declared here per [ADR-018](../decisions/018-cross-version-compatibility.md) §Decision #1 (semver `"MAJOR.MINOR"` format) and §Decision #3 (monotonic session-floor enforcement); the control plane is authoritative for this field ([ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md)).
- Add local `session_events` and `session_snapshots` tables to Local Runtime Daemon SQLite.
- Forward-declare `session_events.pii_payload BLOB` (NULLable) per [Spec-022 §PII Data Map](../specs/022-data-retention-and-gdpr.md) — semantics owned by Plan-022 (crypto-shred fan-out Path 1).
- Forward-declare the integrity-protocol columns on `session_events` — `monotonic_ns INTEGER NOT NULL`, `prev_hash BLOB NOT NULL`, `row_hash BLOB NOT NULL`, `daemon_signature BLOB NOT NULL`, `participant_signature BLOB` — per [Spec-006 §Integrity Protocol](../specs/006-session-event-taxonomy-and-audit-log.md) (BLAKE3 row_hash + Ed25519 daemon_signature + RFC 8785 JCS canonical serialization hash chain; semantics owned by Plan-006).
- Forward-declare the `participant_keys` table (per-participant AES-256-GCM key custody; columns: `participant_id` PK, `encrypted_key_blob`, `key_version`, `created_at`, `rotated_at`) per [Spec-022 §Participant Keys](../specs/022-data-retention-and-gdpr.md) — semantics and DELETE-as-crypto-shred lifecycle owned by Plan-022.
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for canonical column definitions of `session_events`, `session_snapshots`, and `participant_keys`.
- See [Shared Postgres Schema](../architecture/schemas/shared-postgres-schema.md) for canonical column definitions of `sessions` (including `min_client_version`) and `session_memberships`.

## Cross-Plan Forward-Declared Schema

Plan-001 emits the DDL above at tier entry (first migration). The downstream plans below own the read/write semantics and invariants for each forward-declared element. Engineers implementing Plan-001 MUST NOT add read/write logic for these columns; that logic belongs in the owner plan's implementation window.

| Forward-Declared Element                                                                        | Semantics Owner                                           | Invariant / Protocol                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_events.pii_payload`                                                                    | [Plan-022](./022-data-retention-and-gdpr.md)              | Encrypted under per-participant AES-256-GCM key (key in `participant_keys.encrypted_key_blob`); deleting the participant's key row crypto-shreds this column by construction per [Spec-022 §Shred Fan-Out](../specs/022-data-retention-and-gdpr.md) Path 1                                                                                                                      |
| `session_events.monotonic_ns / prev_hash / row_hash / daemon_signature / participant_signature` | [Plan-006](./006-session-event-taxonomy-and-audit-log.md) | BLAKE3 hash chain + Ed25519 signatures over RFC 8785 JCS canonical bytes; `pii_payload` is excluded from canonical bytes but a `pii_ciphertext_digest` is embedded (one-way BLAKE3 over ciphertext) so signatures remain verifiable after crypto-shred per [Spec-022 §Signature Safety Under Shred](../specs/022-data-retention-and-gdpr.md)                                    |
| `participant_keys` (table)                                                                      | [Plan-022](./022-data-retention-and-gdpr.md)              | Wrapped under daemon master key (XChaCha20-Poly1305); row DELETE = crypto-shred for all events authored by that participant; rotation updates `key_version` and stamps `rotated_at`                                                                                                                                                                                             |
| `sessions.min_client_version`                                                                   | [Plan-003](./003-runtime-node-attach.md)                  | Attach-time floor check: daemons below floor are admitted in read-only state; below-floor write attempts return typed `VERSION_FLOOR_EXCEEDED` per [ADR-018](../decisions/018-cross-version-compatibility.md) §Decision #4. Ejection is never the response (graceful degradation per [Spec-003 §Required Behavior](../specs/003-runtime-node-attach.md#required-behavior))      |
| `participants` (minimal anchor: `id`, `created_at`)                                             | [Plan-018](./018-identity-and-participant-state.md)       | Plan-001 creates the anchor row shape; no participant rows are inserted until Plan-018's registration flow lands; Plan-018 adds `display_name`, `identity_ref`, `metadata`, and `identity_mappings` via additive ALTER migrations per [Shared Postgres Schema §Participants and Identity](../architecture/schemas/shared-postgres-schema.md#participants-and-identity-plan-018) |

## API And Transport Changes

- Add `SessionCreate`, `SessionRead`, `SessionJoin`, and `SessionSubscribe` to the shared client SDK and daemon/control-plane contracts.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define session contracts and ids in `packages/contracts`.
2. Implement shared Collaboration Control Plane session directory create or read or join paths.
3. Implement Local Runtime Daemon session event append and snapshot projection.
4. Add client SDK methods and desktop bootstrap wiring for create, join, read, and subscribe.

## Parallelization Notes

- Contract definitions and Collaboration Control Plane storage work can proceed in parallel with Local Runtime Daemon projection scaffolding.
- Desktop renderer integration should wait until client SDK contracts are stable.

## Test And Verification Plan

The TDD test list below is enumerated and ordered by implementation dependency. Each test maps to one or more [Spec-001 acceptance criteria](../specs/001-shared-session-core.md#acceptance-criteria). Tests run via Vitest 4.x projects per [ADR-022](../decisions/022-v1-toolchain-selection.md).

### Contract Layer (`packages/contracts/`)

| ID  | Test                                                         | Asserts             | Spec-001 AC                  |
| --- | ------------------------------------------------------------ | ------------------- | ---------------------------- |
| C1  | `SessionId.parse rejects malformed UUIDs`                    | id format invariant | Foundation for AC1, AC3, AC4 |
| C2  | `SessionCreate payload validates required fields`            | request schema      | AC1                          |
| C3  | `SessionEvent discriminated union round-trips through JSON`  | event serialization | AC1, AC6                     |
| C4  | `Resource limit error matches resource.limit_exceeded shape` | error contract      | AC8                          |

### Daemon Projection Layer (`packages/runtime-daemon/src/session/`)

| ID  | Test                                                                                        | Asserts                                                                                                                                                                          | Spec-001 AC |
| --- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| D1  | `Single SessionCreated event yields snapshot with owner membership and main channel`        | bootstrap projection                                                                                                                                                             | AC1         |
| D2  | `Replay reads events by sequence ASC and reproduces snapshot deterministically`             | replay correctness; `sequence` is the canonical ordering key per [ADR-017](../decisions/017-shared-event-sourcing-scope.md)                                                      | AC6         |
| D3  | `Replay uses sequence not monotonic_ns even when monotonic_ns is non-monotonic across rows` | clock-skew defense; `monotonic_ns` is within-daemon debug data, never the replay key (per [local-sqlite-schema §session_events](../architecture/schemas/local-sqlite-schema.md)) | AC6         |
| D4  | `Snapshot survives daemon restart and yields identical projection on rehydrate`             | durability across restart                                                                                                                                                        | AC2, AC6    |

### Control Plane Layer (`packages/control-plane/`)

| ID  | Test                                                                   | Asserts            | Spec-001 AC |
| --- | ---------------------------------------------------------------------- | ------------------ | ----------- |
| P1  | `SessionCreate returns stable session id and persists to directory`    | shared write       | AC1, AC2    |
| P2  | `Second SessionCreate by same client does not silently fork`           | no shadow sessions | AC5         |
| P3  | `SessionJoin verifies membership and returns existing timeline cursor` | join contract      | AC4, AC5    |

### SDK And Integration Layer (`packages/client-sdk/`, integration)

| ID  | Test                                                                   | Asserts                             | Spec-001 AC |
| --- | ---------------------------------------------------------------------- | ----------------------------------- | ----------- |
| I1  | `SessionCreate then SessionRead returns identical session id`          | round-trip                          | AC1, AC3    |
| I2  | `Second client SessionJoin sees existing event history`                | no fork on join                     | AC4         |
| I3  | `SessionSubscribe yields events in sequence ASC across reconnect`      | reconnect ordering by canonical key | AC3, AC7    |
| I4  | `Reconnect after lost stream restores from snapshot, not client cache` | snapshot authority                  | AC6         |

### Verification

- `pnpm turbo test` at workspace root green across all packages
- Manual smoke: create session in one desktop client, join from second client, verify timeline parity
- All 15 enumerated tests above pass before Plan-001 is marked complete
- Spec-001 AC7 (concurrent participants, channels, and runs without timeline corruption) receives full coverage at the integration boundary in [Plan-008](./008-control-plane-relay-and-session-join.md) when cross-daemon relay flows land. Plan-001 covers AC7 only partially via I3's reconnect-ordering invariant — single-daemon concurrent SQL writes serialize on SQLite's `UNIQUE(session_id, sequence)` constraint, leaving cross-daemon concurrency as the residual coverage gap.

## Implementation Phase Sequence

Plan-001 implementation lands as a sequence of small PRs. Each PR exercises one slice of the contract → daemon → control-plane → SDK vertical. Phase 1 is workspace scaffolding only; subsequent PRs add behavior.

### Phase 1 — Workspace Bootstrap

**Precondition:** [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md) accepted (per [BL-100](../backlog.md)) — gates Phase 1 only.

**Goal:** All packages compile; one passing tooling test verifies the workspace is healthy; the daemon's native-binding rebuild path is exercised at bootstrap; the engineering CI surface (per [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md)) is wired and gates subsequent PRs.

**Ship-gate:** [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md) — V1 CI/CD, Pre-Commit Hooks, and Release Automation — accepted 2026-04-26 per [BL-100](../backlog.md). The CI workflow files, lefthook + commitlint pre-commit framework, Renovate dependency-update config, Gitleaks secret scanner, `CODEOWNERS`, and code-signing custody scaffolding authored by ADR-023 land in this PR.

- Create root scaffolding (per § Repo Layout And Bootstrap above)
- Create empty `packages/contracts/`, `packages/client-sdk/`, `packages/runtime-daemon/`, `packages/control-plane/`, `apps/desktop/` skeletons with `package.json` + `tsconfig.json` + `src/index.ts` (no exports)
- Install `better-sqlite3` 12.9+ as a workspace dep on `packages/runtime-daemon/` per [ADR-022](../decisions/022-v1-toolchain-selection.md). Even without imports, this exercises the postinstall native-binding rebuild path for the daemon target under `node-linker=isolated` at bootstrap time, surfacing native-rebuild integration risk before behavior PRs land.
- Install `pg` 8.20+ as a workspace dep on `packages/control-plane/` per [ADR-022](../decisions/022-v1-toolchain-selection.md)
- Wire engineering CI surface per [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md): `.github/workflows/{ci,release}.yml`, lefthook 2.1.6 + `lefthook.yml`, `lint-staged.config.mjs`, commitlint 20.5.2 config, Renovate config, Gitleaks workflow, `CODEOWNERS`, release-please-action@v5 + actions/attest@v4 release-automation skeleton (no actual release runs yet — first release is post-Plan-001 ship)
- Verify: `pnpm install`, `pnpm turbo build`, `pnpm turbo typecheck`, and `pnpm turbo lint` all green; CI runs green on this PR; pre-commit hooks active locally; required-checks gate is enforced on subsequent PRs
- Single passing test (in `packages/contracts/`): trivial sanity check that Vitest is wired

### Phase 2 — Contracts Package

**Precondition:** Phase 1 merged (workspace + CI surface in place).

**Goal:** Tests C1–C4 from § Test And Verification Plan go green.

- `packages/contracts/src/session.ts` — `SessionId`, `SessionCreate`, `SessionRead`, `SessionJoin`, `SessionSubscribe` payload schemas
- `packages/contracts/src/event.ts` — `SessionEvent` discriminated union (V1 subset: `SessionCreated`, `MemberJoined`, `ChannelCreated`)
- `packages/contracts/src/error.ts` — `resource.limit_exceeded` shape

### Phase 3 — Daemon Migration And Projection

**Precondition:** Phase 2 merged (contract types — `SessionEvent` discriminated union — are imported by the projector).

**Goal:** Tests D1–D4 go green.

- `0001-initial.sql` migration creates `session_events`, `session_snapshots`, `participant_keys` (per § Data And Storage Changes; columns forward-declared but only `session_events` core columns are populated by Plan-001)
- `packages/runtime-daemon/src/session/session-projector.ts` — single-event-to-snapshot projection
- `packages/runtime-daemon/src/session/session-service.ts` — append + replay paths
- Storage driver: `better-sqlite3` (already installed in Phase 1)

### Phase 4 — Control Plane Directory

**Precondition:** Phase 2 merged (control-plane imports `SessionCreate` / `SessionRead` / `SessionJoin` payload schemas from contracts). Phase 3 is independent and may land in either order; the two are decoupled at the contract boundary.

**Goal:** Tests P1–P3 go green.

- Migration creates `participants` (minimal anchor: `id`, `created_at`), `sessions` (with `min_client_version`), `session_memberships` (per § Data And Storage Changes)
- `packages/control-plane/src/sessions/session-directory-service.ts` — create, read, join paths
- Storage driver: `pg` (already installed in Phase 1)

### Phase 5 — Client SDK And Desktop Bootstrap

**Goal:** Tests I1–I4 go green; manual two-client smoke test passes.

**Precondition:** Phase 5 cannot start until both upstream substrates are merged:

- [Plan-007 Tier 1 Partial PRs #1–#3](./007-local-ipc-and-daemon-control.md#tier-1-partial-pr-sequence) — SecureDefaults Bootstrap, Wire Substrate, `session.*` Handlers + SDK Layer.
- [Plan-008 Tier 1 Bootstrap Phase 1](./008-control-plane-relay-and-session-join.md#tier-1-bootstrap-pr-sequence) — tRPC v11 server + `sessionRouter` + SSE substrate.

See [cross-plan-dependencies.md §5 Tier 1 carve-outs](../architecture/cross-plan-dependencies.md#plan-007-substrate-vs-namespace-carve-out-tier-1--tier-4) for the canonical tier graph. Phase 1–Phase 4 may proceed independently; the substrate dependency only binds at Phase 5.

- `packages/client-sdk/src/sessionClient.ts` — `create`, `read`, `join`, `subscribe` methods over the daemon and control-plane transports.
  - **Daemon transport** (`create` / `read` / `join` / `subscribe` over local IPC): consumes the Plan-007 partial-deliverable substrate — JSON-RPC 2.0 + LSP-style Content-Length framing, the `session.*` JSON-RPC method namespace, and the SDK Zod layer (~500–1000 LOC per [Spec-007 §Wire Format](../specs/007-local-ipc-and-daemon-control.md#wire-format)). `subscribe` rides the JSON-RPC 2.0 streaming primitive (Plan-007 partial substrate's `LocalSubscription` shape).
  - **Control-plane transport** (`create` / `read` / `join` / `subscribe` over HTTP/SSE): consumes the Plan-008 bootstrap-deliverable substrate — tRPC v11 server skeleton + `sessionRouter` HTTP handlers wrapping the existing `packages/control-plane/src/sessions/session-directory-service.ts` (shipped in Phase 4). `subscribe` is request-only on the wire — the response is an `AsyncIterable<EventEnvelope>` SSE stream per `packages/contracts/src/session.ts:388`.
- `apps/desktop/renderer/src/session-bootstrap/` — minimal renderer wiring that calls `sessionClient.create` and renders the resulting session
- `apps/desktop/main/src/sidecar-lifecycle.ts` — sidecar-cleanup handler registered **before** Electron `app.on('will-quit', ...)` per §Cross-Plan Obligations CP-001-1; drains active PTY sessions via `PtyHost.close(sessionId)` with a 2 s per-session bounded timeout, closes sidecar stdin, awaits sidecar exit, escalates to `taskkill /T /F /PID <sidecar-pid>` on hard timeout
- `packages/runtime-daemon/src/session/spawn-cwd-translator.ts` — daemon-layer `PtyHost.spawn(spec)` wrapper per §Cross-Plan Obligations CP-001-2; substitutes a stable parent dir for `SpawnRequest.cwd` and prepends a `cd <worktree-path> && ` shell prefix (or sets `CWD=<worktree-path>` env per agent CLI conventions). Wraps both `RustSidecarPtyHost` and `NodePtyHost` because the constraint is OS-level
- Compose a `pg.Pool`-backed `Querier` for `SessionDirectoryService` (the Phase 4 service is constructed against `Querier` and is driver-agnostic; Phase 4 ships only a PGlite path because the integration tests run on the in-process driver). Strengthen the `createSession` lock-ordering test to discriminate which `Querier` instance issued each statement so a regression that routes `FOR UPDATE` through the outer pool checkout instead of the in-transaction checkout is caught — see the `TODO(Plan-001 Phase 5)` in `packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts`.

After Phase 5 lands green and the manual smoke passes, Plan-001 is complete. Plan-002 (Invite, Membership, Presence) can then begin.

## Rollout Order

1. Ship contracts and storage migrations
2. Enable create and read behind internal feature flag
3. Enable join and live subscribe once replay is stable

## Rollback Or Fallback

- Disable create or join endpoints and keep `local-only` session bootstrap if shared session flows regress.

## Risks And Blockers

- Event ordering mistakes between local and shared projections
- Unresolved `local-only` session promotion semantics

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
- [ ] All `TODO(Plan-001 Phase N)` annotations in the source tree are discharged or migrated to a follow-up issue. Specifically: `TODO(Plan-001 Phase 5)` in `packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts` (lock-ordering test strengthening — see Phase 5 §Implementation Phase Sequence). Grep `TODO(Plan-001 ` to confirm zero residual annotations before marking the plan `completed`.
