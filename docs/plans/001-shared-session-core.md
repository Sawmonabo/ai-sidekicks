# Plan-001: Shared Session Core

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `001` |
| **Slug** | `shared-session-core` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-001: Shared Session Core](../specs/001-shared-session-core.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-002](../decisions/002-local-execution-shared-control-plane.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-006](../decisions/006-worktree-first-execution-mode.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-017](../decisions/017-shared-event-sourcing-scope.md), [ADR-018](../decisions/018-cross-version-compatibility.md), [ADR-019](../decisions/019-windows-v1-tier-and-pty-sidecar.md), [ADR-022](../decisions/022-v1-toolchain-selection.md), [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md). **Phase 1 ship-gate**: [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md) governs the engineering CI surface that lands in Phase 1 (accepted 2026-04-26 per [BL-100](../backlog.md)). **Phase 5 ship-gate (governance)**: [ADR-019](../decisions/019-windows-v1-tier-and-pty-sidecar.md) governs CP-001-1 / CP-001-2; [ADR-006](../decisions/006-worktree-first-execution-mode.md) bakes worktree paths into the daemon's session-spawn entry point per CP-001-2. |
| **Dependencies** | Phase 1–Phase 4: None (tier-entry plan; owns `0001-initial.sql` migration and forward-declares schema shape consumed by [Plan-003](./003-runtime-node-attach.md), [Plan-006](./006-session-event-taxonomy-and-audit-log.md), [Plan-022](./022-data-retention-and-gdpr.md)). Phase 5 only: [Plan-007](./007-local-ipc-and-daemon-control.md) partial-deliverable (Tier 1 IPC wire substrate + `session.*` namespace + SDK Zod layer per Spec-007 §Wire Format) and [Plan-008](./008-control-plane-relay-and-session-join.md) bootstrap-deliverable (Tier 1 tRPC v11 server skeleton + `sessionRouter` HTTP handlers + SSE substrate for `SessionSubscribe`). See [cross-plan-dependencies.md §5 Plan-007 + Plan-008 Tier 1 carve-outs](../architecture/cross-plan-dependencies.md#plan-007-substrate-vs-namespace-carve-out-tier-1--tier-4). |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

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

**Verification.** Plan-001 Phase 4 ships P4 (lock-ordering test against the `Querier` abstraction); Phase 5 strengthens that test via I7 to discriminate which `Querier` instance issued each statement (see `TODO(Plan-001 Phase 5)` in `packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts`). Plan-002 PRs that add new transactional callers MUST extend the same test with their caller name.

### I-001-2 — Sequence is the canonical replay key

Local Runtime Daemon SQLite replay MUST order `session_events` by `sequence ASC`, never by `monotonic_ns`. The `monotonic_ns` column is within-daemon debug data only (per [local-sqlite-schema §session_events](../architecture/schemas/local-sqlite-schema.md)); it can be non-monotonic across rows after clock adjustments and MUST NOT influence replay or projection.

**Why load-bearing.** Replay determinism is the foundation for [ADR-017](../decisions/017-shared-event-sourcing-scope.md) event-sourcing semantics. Plan-006 (event taxonomy + integrity protocol) and Plan-015 (replay/recovery) build on this invariant.

**Verification.** Test D3 in §Test And Verification Plan asserts `Replay uses sequence not monotonic_ns even when monotonic_ns is non-monotonic across rows`.

### I-001-3 — Forward-declared columns are immutable in scope at Tier 1

The forward-declared columns and tables enumerated in §Cross-Plan Forward-Declared Schema (Plan-001 emits the DDL, downstream plans own the semantics) MUST NOT be re-shaped by Plan-001 PRs. Plan-001 ships the column types and nullability authoritatively at the Tier 1 migration; the corresponding semantics owners (Plan-006 integrity, Plan-022 GDPR, Plan-018 identity, Plan-003 version-floor) author all read/write logic at their own tiers.

**Why load-bearing.** Re-shaping a forward-declared column post-Tier-1 would force a breaking schema migration after V1 ships — the entire point of the forward-declaration pattern is that V1 ships immutable initial DDL.

**Verification.** Test D5 (migration-shape regression) reads `0001-initial.sql` via `PRAGMA table_info()` for `session_events`, `session_snapshots`, `participant_keys`, and `schema_version`, asserts the column set matches the canonical schema docs.

## Cross-Plan Obligations

Plan-001 owns the daemon-side session lifecycle and the `PtyHost.spawn` entry-point wrapper. Two daemon-layer obligations are declared by Plan-024 (Rust PTY Sidecar) and surface here for bidirectional citation locality, so a Plan-001 reviewer sees the obligations without first reading Plan-024. Each entry mirrors the Plan-003 §Cross-Plan Obligations shape: the obligation, the source citation, and the resolution.

### CP-001-1 — Sidecar-cleanup handler registers BEFORE Electron `will-quit`

[Plan-024 §Invariants I-024-4](./024-rust-pty-sidecar.md#i-024-4--daemons-sidecar-cleanup-handler-registers-before-electron-will-quit) declares that the daemon's sidecar-cleanup handler MUST register before Electron's `will-quit` handler. Under Electron's event-emitter semantics, registration order is run order; if the daemon's cleanup handler is late-registered, the renderer process terminates before active PTY sessions drain and child processes orphan to the global console (the `microsoft/node-pty#904` SIGABRT-on-exit class — primary source cited at [Plan-024 §Windows Implementation Gotchas Gotcha 4](./024-rust-pty-sidecar.md#4-electron-will-quit-ordering-vs-sidecar-shutdown)).

**Resolution.** Plan-001 Phase 5 (Client SDK and Desktop Bootstrap) authors the desktop-shell sidecar-lifecycle wiring under `apps/desktop/src/main/` (the path is owned by [Plan-023 Tier 1 Partial substrate](./023-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) per BL-101 (a) resolution; Plan-001 Phase 5 authors the file content per CP-001-1 content-ownership) so the cleanup handler registers in the Electron `app.on('will-quit', ...)` slot **before** any other handler that depends on the renderer. The handler invokes `PtyHost.close(sessionId)` for every active session, awaits the per-session `ExitCodeNotification` with a bounded 2 s timeout, then closes the sidecar's stdin and awaits the sidecar process exit (second bounded timeout). Escalation to `taskkill /T /F /PID <sidecar-pid>` on hard timeout matches §Invariants CP-001-2 below for the same hard-stop pattern.

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
- [x] **Plan-readiness audit complete per [`docs/operations/plan-implementation-readiness-audit-runbook.md`](../operations/plan-implementation-readiness-audit-runbook.md)** — Tier 1 audit pilot landed via PR #15 (merged 2026-04-28); see [Status Promotion Gate §1](../operations/plan-implementation-readiness-audit-runbook.md#status-promotion-gate). Plan-007 / Plan-008 / Plan-023 partial-substrate carve-outs awaiting per-phase audit-checkbox semantics; tracked as a follow-up governance question alongside [NS-13a spec-status promotion gate](../architecture/cross-plan-dependencies.md#6-active-next-steps-dag).

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
- `turbo.json` — `build`, `test`, `lint`, `typecheck`, and `dev` task pipelines
- `tsconfig.base.json` — strict + `isolatedDeclarations: true` + ESM-only; per-package `tsconfig.json` extends base
- `.npmrc` — `node-linker=isolated` (required by [ADR-022](../decisions/022-v1-toolchain-selection.md) two-ABI native binding constraint)
- `.nvmrc` — pins the lower-tier Node target per [ADR-022](../decisions/022-v1-toolchain-selection.md)
- `eslint.config.mjs` and `prettier.config.js` at root

**Engineering CI surface** — `.github/workflows/{ci,release}.yml`, lefthook 2.1.6 pre-commit hook framework + `lefthook.yml`, `lint-staged.config.mjs`, commitlint 20.5.2 config (10-type set, drops `style`), Renovate config (`renovate.json5` with `minimumReleaseAge: 14 days`), `CODEOWNERS`, Gitleaks v8.30+ workflow, and code-signing custody artifacts (Apple Developer Individual + Azure Artifact Signing OIDC + Sigstore keyless + AWS KMS Ed25519 hot key + YubiHSM 2 cold key envelope) are owned by [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md) (accepted 2026-04-26 per [BL-100](../backlog.md)). Phase 1 lands the concrete artifact list per ADR-023 §Decision.

### Per-Package Scaffolding

Every `packages/*` and `apps/*` member receives a `package.json` (with `"type": "module"`, `engines.node` matching its tier per [ADR-022](../decisions/022-v1-toolchain-selection.md), and an `exports` map), a `tsconfig.json` extending base, and a `src/` directory.

Electron-bound packages (`apps/desktop/*`, `packages/runtime-daemon/*`) use the lower-tier Node target. Control-plane packages (`packages/control-plane/*`) use the upper-tier target. Shared packages consumed by both sides (`packages/contracts/*`, `packages/client-sdk/*`) target the lower tier as the lowest common denominator.

Vitest test file convention (project-wide): `packages/<name>/test/*.test.ts`. Per-package `vitest.config.ts` extends a workspace `vitest.workspace.ts` declaring all `packages/*` and `apps/*` projects. The Phase 1 sanity test lives at `packages/contracts/test/sanity.test.ts`.

## Data And Storage Changes

Plan-001 owns two initial migrations — `packages/runtime-daemon/src/migrations/0001-initial.sql` (SQLite local-runtime) and `packages/control-plane/src/migrations/0001-initial.sql` (Postgres shared control-plane) — and declares the schema shape downstream plans depend on. The two engines are distinct per [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md) and ship under separate migration trees. The column-level definitions are canonical in the schema docs below; this plan body enumerates which elements are forward-declared for cross-plan consumers.

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

| Forward-Declared Element | Semantics Owner | Invariant / Protocol |
| --- | --- | --- |
| `session_events.pii_payload` | [Plan-022](./022-data-retention-and-gdpr.md) | Encrypted under per-participant AES-256-GCM key (key in `participant_keys.encrypted_key_blob`); deleting the participant's key row crypto-shreds this column by construction per [Spec-022 §Shred Fan-Out](../specs/022-data-retention-and-gdpr.md) Path 1 |
| `session_events.monotonic_ns / prev_hash / row_hash / daemon_signature / participant_signature` | [Plan-006](./006-session-event-taxonomy-and-audit-log.md) | BLAKE3 hash chain + Ed25519 signatures over RFC 8785 JCS canonical bytes; `pii_payload` is excluded from canonical bytes but a `pii_ciphertext_digest` is embedded (one-way BLAKE3 over ciphertext) so signatures remain verifiable after crypto-shred per [Spec-022 §Signature Safety Under Shred](../specs/022-data-retention-and-gdpr.md) |
| `participant_keys` (table) | [Plan-022](./022-data-retention-and-gdpr.md) | Wrapped under daemon master key (XChaCha20-Poly1305); row DELETE = crypto-shred for all events authored by that participant; rotation updates `key_version` and stamps `rotated_at` |
| `sessions.min_client_version` | [Plan-003](./003-runtime-node-attach.md) | Attach-time floor check: daemons below floor are admitted in read-only state; below-floor write attempts return typed `VERSION_FLOOR_EXCEEDED` per [ADR-018](../decisions/018-cross-version-compatibility.md) §Decision #4. Ejection is never the response (graceful degradation per [Spec-003 §Required Behavior](../specs/003-runtime-node-attach.md#required-behavior)) |
| `participants` (minimal anchor: `id`, `created_at`) | [Plan-018](./018-identity-and-participant-state.md) | Plan-001 creates the anchor row shape; no participant rows are inserted until Plan-018's registration flow lands; Plan-018 adds `display_name`, `identity_ref`, `metadata`, and `identity_mappings` via additive ALTER migrations per [Shared Postgres Schema §Participants and Identity](../architecture/schemas/shared-postgres-schema.md#participants-and-identity-plan-018) |

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

| ID | Test | Asserts | Spec-001 AC |
| --- | --- | --- | --- |
| C1 | `SessionId.parse rejects malformed UUIDs` | id format invariant | (no direct AC; format invariant — precondition for AC1/AC3/AC4) |
| C2 | `SessionCreate payload rejects unknown fields` | request schema strictness | AC1 |
| C3 | `SessionEvent discriminated union round-trips through JSON` | event serialization | AC1, AC6 |
| C4 | `Resource limit error matches resource.limit_exceeded shape` | error contract | AC8 (wire shape) |

### Daemon Projection Layer (`packages/runtime-daemon/src/session/`)

| ID | Test | Asserts | Spec-001 AC |
| --- | --- | --- | --- |
| D1 | `Single SessionCreated event yields snapshot with owner membership and main channel` | bootstrap projection | AC1 |
| D2 | `Replay reads events by sequence ASC and reproduces snapshot deterministically` | replay correctness; `sequence` is the canonical ordering key per [ADR-017](../decisions/017-shared-event-sourcing-scope.md) | AC6 |
| D3 | `Replay uses sequence not monotonic_ns even when monotonic_ns is non-monotonic across rows` | clock-skew defense; `monotonic_ns` is within-daemon debug data, never the replay key (per [local-sqlite-schema §session_events](../architecture/schemas/local-sqlite-schema.md)) | AC6 |
| D4 | `Snapshot survives daemon restart and yields identical projection on rehydrate` | durability across restart | AC2, AC6 |
| D5 | `Migration-shape regression: column set in 0001-initial.sql matches canonical schema docs` | invariant verification — `PRAGMA table_info()` for `session_events`, `session_snapshots`, `participant_keys`, `schema_version` matches canonical-schema-doc snapshot fixture | (no AC; verifies I-001-3) |

### Control Plane Layer (`packages/control-plane/`)

| ID | Test | Asserts | Spec-001 AC |
| --- | --- | --- | --- |
| P1 | `SessionCreate returns stable session id and persists to directory` | shared write | AC1, AC2 |
| P2 | `Second SessionCreate by same client does not silently fork` | no shadow sessions | AC5 |
| P3 | `SessionJoin verifies membership and returns existing timeline cursor` | join contract | AC4, AC5 |
| P4 | `createSession lock-ordering test asserts FOR UPDATE on sessions row precedes any session_memberships statement under the same transaction (Querier abstraction)` | invariant verification (I-001-1) — file: `packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts` | (no AC; verifies I-001-1) |
| P5 | `SessionJoin returns resource.limit_exceeded when session has 10 active memberships and participant limit is the default` | AC8 enforcement at control plane (Spec-001 §Resource Limits, default 10 participants) | AC8 (enforcement) |

### SDK And Integration Layer (`packages/client-sdk/`, integration)

| ID | Test | Asserts | Spec-001 AC |
| --- | --- | --- | --- |
| I1 | `SessionCreate then SessionRead returns identical session id` | round-trip | AC1, AC3 |
| I2 | `Second client SessionJoin sees existing event history` | no fork on join | AC4 |
| I3 | `SessionSubscribe yields events in sequence ASC across reconnect` | reconnect ordering by canonical key | AC3, AC7 |
| I4 | `Reconnect after lost stream restores from snapshot, not client cache` | snapshot authority | AC6 |
| I5 | `Sidecar drain on app.on('will-quit') completes within 2 s; escalation to taskkill on hard timeout` | verifies obligation CP-001-1 (also verifies inherited Plan-024 I-024-4) — file: `apps/desktop/src/main/__tests__/sidecar-lifecycle.integration.test.ts` | (no AC; verifies CP-001-1) |
| I6 | `PtyHost.spawn rewrites worktree-path cwd to stable parent dir + cd-prefix or CWD-env; round-trip on Windows CI does not surface ERROR_SHARING_VIOLATION` | verifies obligation CP-001-2 (also verifies inherited Plan-024 I-024-5) — file: `packages/runtime-daemon/src/session/__tests__/spawn-cwd-translator.windows.test.ts` | (no AC; verifies CP-001-2) |
| I7 | `Strengthened createSession lock-ordering: FOR UPDATE routed through in-transaction Querier checkout, NOT outer pool checkout` | regression discriminator on I-001-1 — file: `packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts` (discharge `TODO(Plan-001 Phase 5)`) | (no AC; verifies I-001-1) |

### Verification

- `pnpm turbo test` at workspace root green across all packages
- Manual smoke: create session in one desktop client, join from second client, verify timeline parity
- All 19 enumerated tests above pass before Plan-001 is marked complete (4 C-tier + 5 D-tier + 5 P-tier + 4 I-tier + 1 W-tier tooling — see Phase 1 §Tests; CP-001-1 / CP-001-2 coverage via I5 / I6 lands at Phase 5 against the [Plan-023 Tier 1 Partial substrate](./023-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) per BL-101 (a) resolution).
- Test ID prefixes map to Phases as follows: W → Phase 1, C → Phase 2, D → Phase 3, P → Phase 4, I → Phase 5. Each Phase's Goal line names the ID range it owns.
- Spec-001 AC7 (concurrent participants, channels, and runs without timeline corruption) receives full coverage at the integration boundary in [Plan-008](./008-control-plane-relay-and-session-join.md) when cross-daemon relay flows land. Plan-001 covers AC7 only partially via I3's reconnect-ordering invariant — single-daemon concurrent SQL writes serialize on SQLite's `UNIQUE(session_id, sequence)` constraint, leaving cross-daemon concurrency as the residual coverage gap.

## Implementation Phase Sequence

Plan-001 implementation lands as a sequence of small PRs. Each PR exercises one slice of the contract → daemon → control-plane → SDK vertical. Phase 1 is workspace scaffolding only; subsequent PRs add behavior.

### Phase 1 — Workspace Bootstrap

**Precondition:** [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md) accepted (per [BL-100](../backlog.md)) — gates Phase 1 only.

**Goal:** All packages compile; one passing tooling test verifies the workspace is healthy; the daemon's native-binding rebuild path is exercised at bootstrap; the engineering CI surface (per [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md)) is wired and gates subsequent PRs.

**Ship-gate:** [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md) — V1 CI/CD, Pre-Commit Hooks, and Release Automation — accepted 2026-04-26 per [BL-100](../backlog.md). The CI workflow files, lefthook + commitlint pre-commit framework, Renovate dependency-update config, Gitleaks secret scanner, `CODEOWNERS`, and code-signing custody scaffolding authored by ADR-023 land in this PR.

- Create root scaffolding (per § Repo Layout And Bootstrap above)
- Create empty `packages/contracts/`, `packages/client-sdk/`, `packages/runtime-daemon/`, `packages/control-plane/` skeletons with `package.json` + `tsconfig.json` + `src/index.ts` (no exports). At Phase 1, `apps/desktop/` is scaffolded as a placeholder workspace package only (single `src/index.ts` with the forward-declaration comment "split into `apps/desktop/src/{main,preload,renderer}/` per the electron-vite zero-config convention"); the substrate split (`apps/desktop/src/{main,preload,renderer}/`) is owned by [Plan-023 Tier 1 Partial](./023-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) and lands as a separate Tier 1 PR before Plan-001 Phase 5 (BL-101 (a) resolution). The `apps/desktop/src/renderer/src/session-bootstrap/` extension at Phase 5 lands once Plan-023 Tier 1 Partial repositions the placeholder.
- Install `better-sqlite3` 12.9+ as a workspace dep on `packages/runtime-daemon/` per [ADR-022](../decisions/022-v1-toolchain-selection.md). Even without imports, this exercises the postinstall native-binding rebuild path for the daemon target under `node-linker=isolated` at bootstrap time, surfacing native-rebuild integration risk before behavior PRs land.
- Install `pg` 8.20+ as a workspace dep on `packages/control-plane/` per [ADR-022](../decisions/022-v1-toolchain-selection.md)
- Wire engineering CI surface per [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md): `.github/workflows/{ci,release}.yml`, lefthook 2.1.6 + `lefthook.yml`, `lint-staged.config.mjs`, commitlint 20.5.2 config, Renovate config, Gitleaks workflow, `CODEOWNERS`, release-please-action@v5 + actions/attest@v4 release-automation skeleton (no actual release runs yet — first release is post-Plan-001 ship). The literal-file content for `lefthook.yml`, `CODEOWNERS`, `renovate.json5`, `eslint.config.mjs`, `prettier.config.js`, `commitlint.config.mjs`, and the three workflow files is the Phase 1 PR's authoring scope; ADR-023 §Decision pins versions and policy choices, the implementer of this Phase materializes the literal artifact contents.
- Verify: `pnpm install`, `pnpm turbo build`, `pnpm turbo typecheck`, and `pnpm turbo lint` all green; CI runs green on this PR; pre-commit hooks active locally; required-checks gate is enforced on subsequent PRs
- Single passing test (in `packages/contracts/test/sanity.test.ts`): trivial sanity check that Vitest is wired (test ID **W1** per § Test And Verification Plan)

#### Tasks

##### T1.1 — Workspace root scaffolding

**Files:** `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.npmrc`, `.nvmrc` **Reference:** [§Repo Layout And Bootstrap →§Root Scaffolding](#root-scaffolding); [ADR-022](../decisions/022-v1-toolchain-selection.md) **Acceptance:** `pnpm install` succeeds; `pnpm-workspace.yaml` declares `packages/*` and `apps/*`; `tsconfig.base.json` has `"strict": true` + `"isolatedDeclarations": true` + ESM-only; `.npmrc` has `node-linker=isolated`; `.nvmrc` pins lower-tier Node target. **Verifies invariant:** none (workspace bootstrap)

##### T1.2 — Per-package skeletons (`apps/desktop/` ships placeholder; Plan-023 Tier 1 Partial repositions)

**Files:** `packages/{contracts,client-sdk,runtime-daemon,control-plane}/{package.json,tsconfig.json,src/index.ts}` + `apps/desktop/{package.json,tsconfig.json,src/index.ts}` (placeholder) **Acceptance:** each `package.json` has `"type": "module"`, `engines.node` per ADR-022 two-tier rule (lower for `contracts`/`client-sdk`/`runtime-daemon`/`apps/desktop`, upper for `control-plane`); each `tsconfig.json` extends `../../tsconfig.base.json`; each `src/index.ts` is empty (no exports). The `apps/desktop/src/index.ts` placeholder carries a forward-declaration comment ("split into `apps/desktop/src/{main,preload,renderer}/` per the electron-vite zero-config convention") that [Plan-023 Tier 1 Partial T-023p-1-1](./023-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) repositions during the substrate-split PR. **Verifies invariant:** none

##### T1.3 — Native-binding installation surface

**Acceptance:** `better-sqlite3@^12.9` declared in `packages/runtime-daemon/package.json`; `pg@^8.20` declared in `packages/control-plane/package.json`; `pnpm install` triggers `better-sqlite3` postinstall native rebuild against the lower-tier Node ABI under `node-linker=isolated` without error. **Verifies invariant:** none

##### T1.4 — Lint, format, type-check config

**Files:** `eslint.config.mjs`, `prettier.config.js` **Acceptance:** ESLint flat-config preset assembled per ADR-023; Prettier rules per repo convention; `pnpm turbo lint` and `pnpm turbo format:check` pass at workspace root. **Verifies invariant:** none

##### T1.5 — Engineering CI surface (per ADR-023)

**Files:** `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/workflows/gitleaks.yml`, `lefthook.yml`, `lint-staged.config.mjs`, `commitlint.config.mjs`, `renovate.json5`, `CODEOWNERS` **Acceptance:** `pnpm turbo build`, `pnpm turbo typecheck`, `pnpm turbo lint`, `pnpm turbo test` all green; CI workflow runs green on this PR; pre-commit hooks active locally; required-checks gate enforced on subsequent PRs. **Verifies invariant:** none

##### T1.6 — Vitest sanity test

**File:** `packages/contracts/test/sanity.test.ts` **Acceptance:** `vitest run` returns exit 0; W1 (per § Tests below) green. **Verifies invariant:** none (tooling readiness)

#### Tests

| ID | Test | Asserts | Spec-001 AC |
| --- | --- | --- | --- |
| W1 | `vitest sanity: trivial assertion in packages/contracts passes` | Vitest 4.x project graph resolves; CI test job exits 0 | n/a (tooling) |

### Phase 2 — Contracts Package

**Precondition:** Phase 1 merged (workspace + CI surface in place).

**Goal:** Tests C1–C4 from § Test And Verification Plan go green.

- `packages/contracts/src/session.ts` — `SessionId`, `SessionCreate`, `SessionRead`, `SessionJoin`, `SessionSubscribe` payload schemas. Plan-001 also exports `SessionSubscribeStream = AsyncIterable<EventEnvelope>` typed against an opaque `EventEnvelope` placeholder per **C-6** (forward-stub for Plan-006); the stub is narrowed when Plan-006 ships at Tier 4.
- `packages/contracts/src/event.ts` — `SessionEvent` discriminated union (V1 subset: `SessionCreated`, `MembershipCreated`, `ChannelCreated`). [BL-105](../archive/backlog-archive.md) closed 2026-05-01 — `MembershipCreated` is registered as `membership.created` in [Spec-006 §Invite and Membership](../specs/006-session-event-taxonomy-and-audit-log.md) (resource-lifecycle naming parallels `session.created` / `channel.created` / `invite.created`). The discriminator surface in `api-payload-contracts.md` (per C-6) lands the same Phase as this file.
- `packages/contracts/src/error.ts` — `resource.limit_exceeded` shape; also `version.floor_exceeded` and `version.ceiling_exceeded` shapes per [ADR-018 §Decision #4](../decisions/018-cross-version-compatibility.md). The runtime guards land in later Phases / Plans; Phase 2 ships the wire-shape contracts only.

#### Tasks

##### T2.1 — `SessionId`, `SessionCreate`, `SessionRead`, `SessionJoin`, `SessionSubscribe` payload schemas

**Files:** `packages/contracts/src/session.ts`, `packages/contracts/test/session.test.ts` **Spec coverage:** Spec-001 AC1, AC3, AC4 **Verifies invariant:** none (contract layer)

##### T2.2 — `SessionEvent` discriminated union

**Files:** `packages/contracts/src/event.ts`, `packages/contracts/test/event.test.ts` **Spec coverage:** Spec-001 AC1, AC6 **Verifies invariant:** none **Note:** [BL-105](../archive/backlog-archive.md) closed 2026-05-01 — `membership.created` is registered in [Spec-006 §Invite and Membership](../specs/006-session-event-taxonomy-and-audit-log.md). The Phase 2 deliverable ships the wire string `membership.created` and the typed `MembershipCreatedEvent` symbol.

##### T2.3 — Error contracts: `resource.limit_exceeded`, `version.floor_exceeded`, `version.ceiling_exceeded`

**Files:** `packages/contracts/src/error.ts`, `packages/contracts/test/error.test.ts` **Spec coverage:** Spec-001 AC8 (wire shape); ADR-018 §Decision #4 version-error shapes **Verifies invariant:** none

### Phase 3 — Daemon Migration And Projection

**Precondition:** Phase 2 merged (contract types — `SessionEvent` discriminated union — are imported by the projector).

**Goal:** Tests D1–D5 go green.

- `packages/runtime-daemon/src/migrations/0001-initial.sql` migration creates `session_events`, `session_snapshots`, `participant_keys`, `schema_version` (per § Data And Storage Changes; columns forward-declared but only `session_events` core columns are populated by Plan-001). The migration also INSERTs `(version=1, applied_at=now())` into `schema_version` so downstream plans (`0002-*.sql` from Plan-002 onward) have a row to upsert against.
- **Pragmas.** Daemon bootstrap (or migration runner) MUST set `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000` per [Local SQLite Schema §Pragmas](../architecture/schemas/local-sqlite-schema.md) before the first projector apply().
- **Integrity-column placeholder convention.** Plan-001's projector writes `Buffer.alloc(32)` (32-byte zero buffer) into `prev_hash`, `row_hash`, and `daemon_signature` to satisfy NOT NULL during the Tier 1 → Tier 4 gap. Plan-006 ships a backfill+migration that overwrites these placeholders with computed values and adds the integrity-protocol invariant test. See [§Cross-Plan Forward-Declared Schema](#cross-plan-forward-declared-schema).
- `packages/runtime-daemon/src/session/session-projector.ts` — single-event-to-snapshot projection. Projector signatures: `apply(snapshot: Snapshot, event: SessionEvent): Snapshot`; `replay(events: ReadonlyArray<EventRow>): Snapshot` ordered by `sequence ASC` per I-001-2. `Snapshot` shape per [api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md) (Tier 1 Plan-001 block, `SessionSnapshot`).
- `packages/runtime-daemon/src/session/session-service.ts` — append + replay paths. Service signatures: `SessionService.create(req: SessionCreateRequest): Promise<SessionCreateResponse>`; `read(req: SessionReadRequest): Promise<SessionReadResponse>`; `join(req: SessionJoinRequest): Promise<SessionJoinResponse>`; `subscribe(req: SessionSubscribeRequest): SessionSubscribeStream` (LocalSubscription per Plan-007 partial substrate's IPC shape).
- Storage driver: `better-sqlite3` 12.9+ per [ADR-022](../decisions/022-v1-toolchain-selection.md) (already installed in Phase 1). Replay key: `sequence` per [ADR-017](../decisions/017-shared-event-sourcing-scope.md).

#### Tasks

##### T3.1 — `0001-initial.sql` migration + pragmas

**Files:** `packages/runtime-daemon/src/migrations/0001-initial.sql`, daemon bootstrap shim that applies pragmas **Spec coverage:** Spec-001 AC2 (durability) **Verifies invariant:** I-001-3 (forward-declared shape stable, verified by D5)

##### T3.2 — Projector reducer + replay

**Files:** `packages/runtime-daemon/src/session/session-projector.ts`, `packages/runtime-daemon/src/session/test/session-projector.test.ts` **Spec coverage:** Spec-001 AC1, AC6 **Verifies invariant:** I-001-2 (sequence ASC replay)

##### T3.3 — Service surface (create/read/join/subscribe)

**Files:** `packages/runtime-daemon/src/session/session-service.ts`, `packages/runtime-daemon/src/session/test/session-service.test.ts` **Spec coverage:** Spec-001 AC1, AC2, AC4, AC6 **Verifies invariant:** none (driver-agnostic; D1-D4 verify behavior)

##### T3.4 — Migration-shape regression test

**Files:** `packages/runtime-daemon/src/migrations/test/migration-shape.test.ts` **Spec coverage:** none (invariant-only) **Verifies invariant:** I-001-3 (D5)

### Phase 4 — Control Plane Directory

**Precondition:** Phase 2 merged (control-plane imports `SessionCreate` / `SessionRead` / `SessionJoin` payload schemas from contracts). Phase 3 is independent and may land in either order; the two are decoupled at the contract boundary.

**Goal:** Tests P1–P5 go green.

- `packages/control-plane/src/migrations/0001-initial.sql` migration creates `participants` (minimal anchor: `id`, `created_at`), `sessions` (with `min_client_version`), `session_memberships` (per § Data And Storage Changes), plus the canonical indexes per [Shared Postgres Schema §Sessions and Membership](../architecture/schemas/shared-postgres-schema.md#sessions-and-membership-plan-001-plan-002) (`idx_sessions_state`, `idx_session_memberships_session`, `idx_session_memberships_participant`).
- **Migration-order invariant.** `CREATE TABLE participants` MUST precede `CREATE TABLE sessions` and `CREATE TABLE session_memberships` per [Shared Postgres Schema §Migration-order invariant](../architecture/schemas/shared-postgres-schema.md#participants-identity-anchor-plan-001) — both `session_memberships.participant_id` and any future Plan-002/003 FK-bearing tables resolve against the anchor.
- **`min_client_version` boundary.** The column ships forward-declared (NULL default) only; Plan-001 ships the column shape but does NOT author read/write logic per [§Cross-Plan Forward-Declared Schema](#cross-plan-forward-declared-schema) and [I-001-3](#i-001-3--forward-declared-columns-are-immutable-in-scope-at-tier-1). Attach-time floor enforcement is owned by [Plan-003](./003-runtime-node-attach.md) per [Spec-003 §Required Behavior](../specs/003-runtime-node-attach.md#required-behavior).
- `packages/control-plane/src/sessions/session-directory-service.ts` — create, read, join paths. `createSession` accepts a daemon-assigned `id` (UUID v7 per RFC 9562; see [Shared Postgres Schema §BL-069 invariant](../architecture/schemas/shared-postgres-schema.md#sessions-and-membership-plan-001-plan-002)) and uses idempotent upsert (`ON CONFLICT (id) DO UPDATE` returning the row) for retry-after-crash safety per [domain/session-model.md §Local-Only Reconciliation](../domain/session-model.md). Join path enforces participants-per-session limit (default 10 per [Spec-001 §Resource Limits](../specs/001-shared-session-core.md#resource-limits)); over-limit returns `resource.limit_exceeded` per [§Limit Enforcement](../specs/001-shared-session-core.md#limit-enforcement).
- **Lock-ordering test (P4).** `packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts` asserts `FOR UPDATE` on `sessions` row precedes any `session_memberships` statement under the same transaction (Querier abstraction). Verifies I-001-1; Phase 5 strengthens via I7.
- Storage driver: `pg` 8.20+ per [ADR-022](../decisions/022-v1-toolchain-selection.md) (already installed in Phase 1).

#### Tasks

##### T4.1 — `0001-initial.sql` Postgres migration

**Files:** `packages/control-plane/src/migrations/0001-initial.sql` **Spec coverage:** Spec-001 AC2 (durability) **Verifies invariant:** none (migration only; I-001-3 verified by D5 schema-shape)

##### T4.2 — `SessionDirectoryService` create/read/join paths

**Files:** `packages/control-plane/src/sessions/session-directory-service.ts` **Spec coverage:** Spec-001 AC1, AC2, AC4, AC5, AC8 **Verifies invariant:** I-001-1 (lock-ordering, verified by P4)

##### T4.3 — Lock-ordering test (P4)

**Files:** `packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts` **Spec coverage:** none (invariant-only) **Verifies invariant:** I-001-1 (P4)

##### T4.4 — Resource-limit-exceeded enforcement test (P5)

**Files:** `packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts` (extends) **Spec coverage:** Spec-001 AC8 (enforcement) **Verifies invariant:** none

### Phase 5 — Client SDK And Desktop Bootstrap

**Goal:** Tests I1–I4 go green; manual two-client smoke test passes.

**Precondition:** Phase 5 ships in four lanes with per-task gating, not as a single monolithic gate. Each lane unblocks when its named upstream substrate is at HEAD on `develop`. The per-task `Files:` rows at T5.1–T5.6 below define the per-lane boundaries.

- **Lane A** (T5.1, T5.5, T5.6 — `sessionClient.ts` + `pg.Pool`-backed `Querier` composition + `createSession` lock-ordering test strengthening): unblocks once this amendment lands. T5.1 consumes the merged [Plan-007 Tier 1 Partial sequence PRs #1–#3](./007-local-ipc-and-daemon-control.md#tier-1-partial-pr-sequence) (GitHub PRs #16 / #17 / #19 — SecureDefaults Bootstrap, Wire Substrate, `session.*` Handlers + SDK Layer) and the merged [Plan-008 Tier 1 Bootstrap Phase 1](./008-control-plane-relay-and-session-join.md#tier-1-bootstrap-pr-sequence) (GitHub PR #21 — tRPC v11 server + `sessionRouter` + SSE substrate). T5.5 + T5.6 are pure `packages/control-plane/` work with no cross-plan substrate dependency.
- **Lane B** (T5.4 — `spawn-cwd-translator.ts`): unblocks once [Plan-024 T-024-2-1](./024-rust-pty-sidecar.md) ships the `PtyHostContract` interface at `packages/contracts/src/pty-host.ts`. Cross-plan PR pair tracked at [cross-plan-dependencies.md §6 NS-04](../architecture/cross-plan-dependencies.md#6-active-next-steps-dag).
- **Lane C** (T5.2 — `apps/desktop/src/renderer/src/session-bootstrap/` renderer wiring): unblocks once [Plan-023 Tier 1 Partial Phase 1](./023-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) ships the `apps/desktop/src/{main,preload,renderer}/` workspace package substrate (BL-101 (a) resolution): the directory tree + electron-vite v5 toolchain + minimal entrypoints that T5.2 extends with content. Tracked at [cross-plan-dependencies.md §6 NS-06](../architecture/cross-plan-dependencies.md#6-active-next-steps-dag).
- **Lane D** (T5.3 — `apps/desktop/src/main/sidecar-lifecycle.ts`): unblocks once both (i) [Plan-023 Tier 1 Partial Phase 1](./023-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) AND (ii) [Plan-024 Phase 3](./024-rust-pty-sidecar.md) ship — the latter supplies the `PtyHost.close(sessionId)` + `KillRequest` primitives the lifecycle handler consumes. Tracked at [cross-plan-dependencies.md §6 NS-08](../architecture/cross-plan-dependencies.md#6-active-next-steps-dag).

See [cross-plan-dependencies.md §5 Tier 1 carve-outs](../architecture/cross-plan-dependencies.md#plan-007-substrate-vs-namespace-carve-out-tier-1--tier-4) for the canonical tier graph and [cross-plan-dependencies.md §6 NS-02 / NS-04 / NS-06 / NS-08](../architecture/cross-plan-dependencies.md#6-active-next-steps-dag) for per-lane Next Steps DAG entries. Phase 1–Phase 4 may proceed independently; the per-lane substrate dependencies only bind at Phase 5.

- `packages/client-sdk/src/sessionClient.ts` — `create`, `read`, `join`, `subscribe` methods over the daemon and control-plane transports.
  - **Daemon transport** (`create` / `read` / `join` / `subscribe` over local IPC): consumes the Plan-007 partial-deliverable substrate — JSON-RPC 2.0 + LSP-style Content-Length framing, the `session.*` JSON-RPC method namespace, and the SDK Zod layer (~500–1000 LOC per [Spec-007 §Wire Format](../specs/007-local-ipc-and-daemon-control.md#wire-format)). `subscribe` rides the JSON-RPC 2.0 streaming primitive (Plan-007 partial substrate's `LocalSubscription` shape).
  - **Control-plane transport** (`create` / `read` / `join` / `subscribe` over HTTP/SSE): consumes the Plan-008 bootstrap-deliverable substrate — tRPC v11 server skeleton + `sessionRouter` HTTP handlers wrapping the existing `packages/control-plane/src/sessions/session-directory-service.ts` (shipped in Phase 4). `subscribe` is request-only on the wire — the response is an `AsyncIterable<EventEnvelope>` SSE stream per `packages/contracts/src/session.ts:388`.
- `apps/desktop/src/renderer/src/session-bootstrap/` — minimal renderer wiring that calls `sessionClient.create` and renders the resulting session. The directory tree is owned by [Plan-023 Tier 1 Partial](./023-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence); Plan-001 Phase 5 authors the file content here per BL-101 (a) resolution.
- `apps/desktop/src/main/sidecar-lifecycle.ts` — sidecar-cleanup handler registered **before** Electron `app.on('will-quit', ...)` per §Cross-Plan Obligations CP-001-1; drains active PTY sessions via `PtyHost.close(sessionId)` with a 2 s per-session bounded timeout, closes sidecar stdin, awaits sidecar process exit (second bounded timeout: **2 s**), escalates to `taskkill /T /F /PID <sidecar-pid>` on hard timeout. The `apps/desktop/src/main/` directory is owned by [Plan-023 Tier 1 Partial](./023-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence); Plan-001 Phase 5 authors the file content here per BL-101 (a) resolution + CP-001-1 content-ownership.
- `packages/runtime-daemon/src/session/spawn-cwd-translator.ts` — daemon-layer `PtyHost.spawn(spec)` wrapper per §Cross-Plan Obligations CP-001-2; substitutes a stable parent dir for `SpawnRequest.cwd` and prepends a `cd <worktree-path> && ` shell prefix (or sets `CWD=<worktree-path>` env per agent CLI conventions). Wraps both `RustSidecarPtyHost` and `NodePtyHost` because the constraint is OS-level. **AMBIGUOUS** — the per-driver dispatch (cd-prefix for shell sessions; CWD-env for `claude-driver` / `codex-driver` agent CLIs that consume `CWD` env) is named per-target in the implementer's PR; if the dispatch table is non-trivial, a Plan-001 amendment lands the explicit driver→strategy mapping (currently the working assumption: shell sessions use cd-prefix; agent CLIs use CWD env). The cd-prefix strategy mutates the command string (visible to Plan-006 audit-log canonical hash); CWD-env mutates process environment (invisible to canonical bytes) — pick is consequential to integrity protocol but Plan-006 owns the integrity test that catches inconsistency.
- Compose a `pg.Pool`-backed `Querier` for `SessionDirectoryService` (the Phase 4 service is constructed against `Querier` and is driver-agnostic; Phase 4 ships only a PGlite path because the integration tests run on the in-process driver). Strengthen the `createSession` lock-ordering test (I7) to discriminate which `Querier` instance issued each statement so a regression that routes `FOR UPDATE` through the outer pool checkout instead of the in-transaction checkout is caught — see the `TODO(Plan-001 Phase 5)` in `packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts`.

#### Tasks

##### T5.1 — `sessionClient.ts` daemon + control-plane transport

**Files:** `packages/client-sdk/src/sessionClient.ts`, `packages/client-sdk/test/sessionClient.integration.test.ts` **Spec coverage:** Spec-001 AC1, AC3, AC4, AC6 **Verifies invariant:** none (integration-layer wrapper)

##### T5.2 — `apps/desktop/src/renderer/src/session-bootstrap/` renderer wiring

**Files:** `apps/desktop/src/renderer/src/session-bootstrap/index.ts`, `apps/desktop/src/renderer/src/session-bootstrap/SessionBootstrap.tsx`, `apps/desktop/src/renderer/src/session-bootstrap/__tests__/SessionBootstrap.test.tsx` **Acceptance:** the component invokes `sessionClient.create` (over the bridge → daemon transport per T5.1) on mount, renders a placeholder while pending, swaps to a session-summary view on resolve, and surfaces the error envelope on reject. The `App.tsx` placeholder shipped by [Plan-023 Tier 1 Partial T-023p-1-5](./023-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) routes to this component; manual two-client smoke test passes per §Verification. **Spec coverage:** Spec-001 AC1, AC4 **Verifies invariant:** none (renderer composition over the bridge surface)

##### T5.3 — `apps/desktop/src/main/sidecar-lifecycle.ts` will-quit drain orchestration

**Files:** `apps/desktop/src/main/sidecar-lifecycle.ts`, `apps/desktop/src/main/__tests__/sidecar-lifecycle.integration.test.ts` (verifies I5 — CP-001-1 + Plan-024 I-024-4) **Acceptance:** module exports `registerSidecarLifecycle(app: App, ptyHost: PtyHost): void`; calling it before any `app.on('will-quit', ...)` registration in `apps/desktop/src/main/index.ts` (per [Plan-023 T-023p-1-3](./023-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) — the entrypoint exposes the registration slot) drains active PTY sessions via `PtyHost.close(sessionId)` with a 2 s per-session bounded timeout, closes sidecar stdin, awaits sidecar process exit (second bounded timeout: **2 s**), and escalates to `taskkill /T /F /PID <sidecar-pid>` on hard timeout. Plan-024 T-024-3-1 supplies `PtyHost.close(sessionId)` + `KillRequest` primitives. The integration test exercises a synthetic PTY session against the real `RustSidecarPtyHost` and asserts ≤ 2 s drain, taskkill escalation on hung sidecar. **Spec coverage:** none (verifies obligation CP-001-1 + inherited Plan-024 I-024-4) **Verifies invariant:** I5 (= CP-001-1 + I-024-4)

##### T5.4 — `spawn-cwd-translator.ts` daemon-layer cwd-translator

**Files:** `packages/runtime-daemon/src/session/spawn-cwd-translator.ts`, `packages/runtime-daemon/src/session/test/spawn-cwd-translator.test.ts` (Linux/Mac unit-only) + `packages/runtime-daemon/src/session/__tests__/spawn-cwd-translator.windows.test.ts` (Windows CI integration — verifies I6 / CP-001-2) **Spec coverage:** none (daemon-internal wrapper) **Verifies invariant:** none (verifies obligation CP-001-2; verifies inherited Plan-024 I-024-5)

##### T5.5 — `pg.Pool`-backed `Querier` composition

**Files:** `packages/control-plane/src/sessions/session-directory-service.ts` (constructor wiring), `packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts` (extends with pool-checkout-and-release path) **Spec coverage:** Spec-001 AC1, AC2, AC4 **Verifies invariant:** none (driver-agnostic Querier composition)

##### T5.6 — Strengthen `createSession` lock-ordering test (I7)

**Files:** `packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts` (discharge `TODO(Plan-001 Phase 5)`) **Spec coverage:** Spec-001 AC2 (deterministic create), AC4 (deterministic join) **Verifies invariant:** I-001-1 (regression discriminator)

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
      - docs/decisions/007-collaboration-trust-and-permission-model.md
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
      - docs/domain/participant-and-membership-model.md
      - docs/domain/queue-and-intervention-model.md
      - docs/domain/repo-workspace-worktree-model.md
      - docs/domain/run-state-machine.md
      - docs/domain/runtime-node-model.md
      - docs/domain/session-model.md
      - docs/domain/trust-and-identity.md
      - docs/domain/workflow-model.md
      - docs/domain/workflow-phase-model.md
      - docs/operations/cedar-policy-signing-and-rotation.md
      - docs/operations/control-plane-runbook.md
      - docs/operations/invite-session-desync-recovery.md
      - docs/operations/local-daemon-runbook.md
      - docs/operations/local-persistence-repair-and-restore.md
      - docs/operations/provider-failure-runbook.md
      - docs/operations/replay-and-audit-runbook.md
      - docs/operations/repo-and-worktree-recovery.md
      - docs/operations/self-host-secure-defaults.md
      - docs/operations/stuck-run-debugging.md
      - docs/plans/000-plan-template.md
      - docs/plans/001-shared-session-core.md
      - docs/plans/002-invite-membership-and-presence.md
      - docs/plans/003-runtime-node-attach.md
      - docs/plans/004-queue-steer-pause-resume.md
      - docs/plans/005-provider-driver-contract-and-capabilities.md
      - docs/plans/006-session-event-taxonomy-and-audit-log.md
      - docs/plans/007-local-ipc-and-daemon-control.md
      - docs/plans/008-control-plane-relay-and-session-join.md
      - docs/plans/009-repo-attachment-and-workspace-binding.md
    verifies_invariant: []
    spec_coverage: []
    notes: |
      Phase 1 — Workspace Bootstrap. Multi-task PR predates NS-02 atomic-PR-per-task discipline. Backfilled 2026-05-10 via operator hand-curation; cross-validated against scripts/rebuild-shipment-manifest.mjs gh ground truth.
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
      - packages/contracts/src/__tests__/session-join.test.ts
      - packages/contracts/src/error.ts
      - packages/contracts/src/event.ts
      - packages/contracts/src/index.ts
      - packages/contracts/src/session.ts
      - pnpm-lock.yaml
    verifies_invariant: []
    spec_coverage: ["Spec-001 AC1", "Spec-001 AC3", "Spec-001 AC4", "Spec-001 AC6", "Spec-001 AC8"]
    notes: |
      Phase 2 — Contracts Package. Multi-task PR predates NS-02. Backfilled 2026-05-10.
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
      Phase 3 — Daemon Migration And Projection. Multi-task PR predates NS-02. Backfilled 2026-05-10.
  - phase: 4
    task: [T4.1, T4.2, T4.3, T4.4]
    pr: 10
    sha: c723b18
    merged_at: 2026-04-27
    files:
      - docs/architecture/cross-plan-dependencies.md
      - docs/architecture/schemas/shared-postgres-schema.md
      - docs/plans/001-shared-session-core.md
      - packages/contracts/src/session.ts
      - packages/control-plane/package.json
      - packages/control-plane/src/index.ts
      - packages/control-plane/src/migrations/0001-initial.ts
      - packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts
      - packages/control-plane/src/sessions/migration-runner.ts
      - packages/control-plane/src/sessions/session-directory-service.ts
      - packages/control-plane/vitest.config.ts
      - pnpm-lock.yaml
    verifies_invariant: [I-001-1]
    spec_coverage: ["Spec-001 AC1", "Spec-001 AC2", "Spec-001 AC4", "Spec-001 AC5", "Spec-001 AC8"]
    notes: |
      Phase 4 — Control Plane Directory. Multi-task PR predates NS-02. Backfilled 2026-05-10.
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
      - docs/plans/001-shared-session-core.md
      - docs/superpowers/plans/2026-05-03-plan-execution-housekeeper-implementation.md
      - packages/client-sdk/src/index.ts
      - packages/client-sdk/src/sessionClient.ts
      - packages/client-sdk/test/sessionClient.integration.test.ts
    verifies_invariant: []
    spec_coverage: ["Spec-001 AC1", "Spec-001 AC3", "Spec-001 AC4", "Spec-001 AC6"]
    notes: |
      Phase 5 Lane A T5.1 — sessionClient.ts (daemon JSON-RPC + control-plane tRPC/SSE transports). First atomic post-NS-02 PR for Plan-001. See `### Notes` subsection for the full PR #30 round-trip narrative.
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
    verifies_invariant: [I-001-1]
    spec_coverage: ["Spec-001 AC2", "Spec-001 AC4"]
    notes: |
      Phase 5 Lane A T5.6 — strengthens the `createSession` lock-ordering regression test (Codex R4) to discriminate WHICH Querier instance issued each in-transaction statement, discharging the `TODO(Plan-001 PR #5)` annotation that T5.5's pg.Pool adapter unlocked. The `wrapWithLog` test helper now captures `{querierId, sql}` pairs (was bare `string`) and re-wraps the in-tx Querier with a fresh `${outerId}.tx-<n>` id so a regression that routes any of the four load-bearing statements (session upsert, FOR UPDATE, owner-mismatch probe, membership upsert) through `this.#querier` instead of the transaction-bound `tx` is caught by `entry.querierId !== "outer"`. Under pg.Pool semantics that misroute would lock on a different pool checkout than the transaction's held client and fail to serialize concurrent createSession calls. Pre-T5.6 assertions (presence, ordering, count) preserved; strengthening is additive. Cross-equality assertion also catches a hypothetical regression that introduced a sibling transaction (different tx-scoped ids would split across four statements). Validated by mutating `session-directory-service.ts` to route FOR UPDATE through `this.#querier`, re-running the suite (R4 fails as expected), and reverting. Verifies I-001-1 (lock-ordering: sessions → session_memberships) as a regression discriminator. **Closes NS-02 Lane A** — Plan-001 Phase 5 Lane A complete with T5.1 (PR #30), T5.5 (PR #36), T5.6 (PR #38).
```

### Notes

<!-- Per-PR human commentary (round-trips, learnings, partial-ship details). -->

- **PR #30** (squash-commit `7e4ae47` on `develop`, merged 2026-05-05): Phase 5 Lane A T5.1 — `sessionClient.ts`. Two factories shipped at `packages/client-sdk/src/sessionClient.ts`: `createDaemonSessionClient(client: JsonRpcClient): SessionClient` (consumes Plan-007 §CP-007-4 transport) + `createControlPlaneSessionClient(opts: ControlPlaneSessionClientOptions): SessionClient` (consumes Plan-008 tRPC `sessionRouter` + native SSE per BL-104 path-(b)). Shared `SessionClient` interface with `create` / `read` / `join` / `subscribe(): AsyncIterable<EventEnvelope>`. Acceptance criteria green: I1 (SessionCreate→SessionRead identity, daemon), I2 (two-client SessionJoin replay history, daemon), I3 (SessionSubscribe ASC sequence across reconnect, CP/SSE), I4 (reconnect after lost stream restores from snapshot, CP/SSE) — covering Spec-001 AC1 / AC3 / AC4 / AC6. Pre-Phase-A landed two prerequisite commits on the PR branch: `8c73268 fix(repo): require code-type prefix in plan-execution preflight Gate 3` (Gate 3 was false-matching doc/chore PRs against `Plan-NNN.*Phase N` patterns; tightened to `feat|fix|refactor|perf` Conventional Commit prefixes per CONTRIBUTING.md) and `777a765 docs(repo): seal preflight.mjs cite ripple after Gate 3 line shift` (CAT-06 inbound `:NNN` cite update in housekeeper plan after preflight.mjs:537 → :544 shift). Round-trips: round 1 surfaced ACTIONABLE barrel-export gap (`src/index.ts` missing `sessionClient.js` re-export — broke external consumers' import surface); round 2 surfaced asymmetric type-soundness gap (factory exported but `JsonRpcClient` parameter type only re-exported transitively, blocking TypeScript consumers from naming the dependency); round 3 closed both with wide transport re-exports (`export * from "./transport/jsonRpcClient.js"` + `"./transport/types.js"`) — task converged at round-trip cap (3 rounds) without cap-firing. Phase D (PR-scoped, full-diff) returned 0 POLISH / 0 ACTIONABLE across all three reviewers (spec / code-quality / code). Self-flagged learnings inline: async-generator priming pitfall (body executes only on first `next()` pull, not on iterator construction — caught in I2 test setup) + stale-citation correction (early reference to "mutation precedent in `sse-roundtrip.test.ts`" was self-corrected with primary-source citation to `@trpc/server@11.17.0` source — the cited test was subscribe-only). Post-Phase-D Codex external review then ran 5 rounds against successive HEADs and produced 8 findings (1 P1, 7 P2) across the same `sessionClient.ts` surface — all addressed inline with regression tests C1-C8: pre-abort guards on both transports (RT-1 + RT-2), CRLF-tolerant SSE frame parsing per WHATWG HTML §9.2.6 (RT-1), cursor validation via `EventCursorSchema.parse` at the trust boundary (RT-2), graceful mid-stream abort on the CP read loop (RT-3 / `5eef5fc`), graceful request-setup abort closing the third abort window (RT-4 / `6c179dc`), daemon abort race-close after listener attach (RT-5 / `101fa29`), and SSE Content-Type validation against silent-empty-stream misreports from non-SSE 200 responses (RT-5). Three abort windows now uniformly handled on the CP path matching the daemon path's `addEventListener("abort", () => subscription.cancel())` contract. Bundled CI hardening landed in the same PR: lychee CI split into required-inbound + advisory-outbound (`cdae21c`) per ADR-023 §Axis 2 D-1 (gates fail-closed; drift detectors warn) and the advisory-outbound failure flipped to yellow `::warning::` annotation (`49102db`) so the workflow header reflects the actual signal class. Final test count: 35 client-sdk tests (16 integration including C1-C8). Plan-001 Phase 5 Lane A T5.1 closes; T5.2-T5.6 remain unscheduled.

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
- [ ] All `TODO(Plan-001 Phase N)` annotations in the source tree are discharged or migrated to a follow-up issue. Specifically: `TODO(Plan-001 Phase 5)` in `packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts` (lock-ordering test strengthening — see Phase 5 §Implementation Phase Sequence). Grep `TODO(Plan-001 ` to confirm zero residual annotations before marking the plan `completed`.
