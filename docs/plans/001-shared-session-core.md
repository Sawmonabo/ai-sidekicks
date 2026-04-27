# Plan-001: Shared Session Core

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `001` |
| **Slug** | `shared-session-core` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-001: Shared Session Core](../specs/001-shared-session-core.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-002](../decisions/002-local-execution-shared-control-plane.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-017](../decisions/017-shared-event-sourcing-scope.md), [ADR-018](../decisions/018-cross-version-compatibility.md), [ADR-022](../decisions/022-v1-toolchain-selection.md), [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md). **PR #1 ship-gate**: [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md) governs the engineering CI surface that lands in PR #1 (accepted 2026-04-26 per [BL-100](../backlog.md)). |
| **Dependencies** | None (tier-entry plan; owns `0001-initial.sql` migration and forward-declares schema shape consumed by [Plan-003](./003-runtime-node-attach.md), [Plan-006](./006-session-event-taxonomy-and-audit-log.md), [Plan-022](./022-data-retention-and-gdpr.md)) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Implement the minimum session creation, join, snapshot, and replay foundation used by all later features.

## Scope

This plan covers session ids, default channel creation, owner membership bootstrap, local event append, and typed session read or subscribe APIs.

## Non-Goals

- Invite lifecycle
- Runtime-node attach
- Queue and intervention behavior

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted (plan body)
- [x] **PR #1 ship-gate**: [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md) — V1 CI/CD, Pre-Commit Hooks, and Release Automation accepted 2026-04-26 per [BL-100](../backlog.md). The engineering CI surface that lands in PR #1 (`.github/workflows/{ci,release}.yml`, lefthook 2.1.6 pre-commit framework, commitlint 20.5.2, Renovate dependency-update config, Gitleaks v8.30+ secret scanner, release-please-action@v5 + actions/attest@v4 release skeleton, code-signing custody artifacts) is now governed by an accepted ADR.
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

**Engineering CI surface** — `.github/workflows/{ci,release}.yml`, lefthook 2.1.6 pre-commit hook framework + `lefthook.yml`, `lint-staged.config.mjs`, commitlint 20.5.2 config (10-type set, drops `style`), Renovate config (`renovate.json5` with `minimumReleaseAge: 14 days`), `CODEOWNERS`, Gitleaks v8.30+ workflow, and code-signing custody artifacts (Apple Developer Individual + Azure Artifact Signing OIDC + Sigstore keyless + AWS KMS Ed25519 hot key + YubiHSM 2 cold key envelope) are owned by [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md) (accepted 2026-04-26 per [BL-100](../backlog.md)). PR #1 lands the concrete artifact list per ADR-023 §Decision.

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
| C1 | `SessionId.parse rejects malformed UUIDs` | id format invariant | Foundation for AC1, AC3, AC4 |
| C2 | `SessionCreate payload validates required fields` | request schema | AC1 |
| C3 | `SessionEvent discriminated union round-trips through JSON` | event serialization | AC1, AC6 |
| C4 | `Resource limit error matches resource.limit_exceeded shape` | error contract | AC8 |

### Daemon Projection Layer (`packages/runtime-daemon/src/session/`)

| ID | Test | Asserts | Spec-001 AC |
| --- | --- | --- | --- |
| D1 | `Single SessionCreated event yields snapshot with owner membership and main channel` | bootstrap projection | AC1 |
| D2 | `Replay reads events by sequence ASC and reproduces snapshot deterministically` | replay correctness; `sequence` is the canonical ordering key per [ADR-017](../decisions/017-shared-event-sourcing-scope.md) | AC6 |
| D3 | `Replay uses sequence not monotonic_ns even when monotonic_ns is non-monotonic across rows` | clock-skew defense; `monotonic_ns` is within-daemon debug data, never the replay key (per [local-sqlite-schema §session_events](../architecture/schemas/local-sqlite-schema.md)) | AC6 |
| D4 | `Snapshot survives daemon restart and yields identical projection on rehydrate` | durability across restart | AC2, AC6 |

### Control Plane Layer (`packages/control-plane/`)

| ID | Test | Asserts | Spec-001 AC |
| --- | --- | --- | --- |
| P1 | `SessionCreate returns stable session id and persists to directory` | shared write | AC1, AC2 |
| P2 | `Second SessionCreate by same client does not silently fork` | no shadow sessions | AC5 |
| P3 | `SessionJoin verifies membership and returns existing timeline cursor` | join contract | AC4, AC5 |

### SDK And Integration Layer (`packages/client-sdk/`, integration)

| ID | Test | Asserts | Spec-001 AC |
| --- | --- | --- | --- |
| I1 | `SessionCreate then SessionRead returns identical session id` | round-trip | AC1, AC3 |
| I2 | `Second client SessionJoin sees existing event history` | no fork on join | AC4 |
| I3 | `SessionSubscribe yields events in sequence ASC across reconnect` | reconnect ordering by canonical key | AC3, AC7 |
| I4 | `Reconnect after lost stream restores from snapshot, not client cache` | snapshot authority | AC6 |

### Verification

- `pnpm turbo test` at workspace root green across all packages
- Manual smoke: create session in one desktop client, join from second client, verify timeline parity
- All 15 enumerated tests above pass before Plan-001 is marked complete
- Spec-001 AC7 (concurrent participants, channels, and runs without timeline corruption) receives full coverage at the integration boundary in [Plan-008](./008-control-plane-relay-and-session-join.md) when cross-daemon relay flows land. Plan-001 covers AC7 only partially via I3's reconnect-ordering invariant — single-daemon concurrent SQL writes serialize on SQLite's `UNIQUE(session_id, sequence)` constraint, leaving cross-daemon concurrency as the residual coverage gap.

## First Commit Slice

Plan-001 implementation lands as a sequence of small PRs. Each PR exercises one slice of the contract → daemon → control-plane → SDK vertical. PR #1 is workspace scaffolding only; subsequent PRs add behavior.

### PR #1 — Workspace Bootstrap

**Goal:** All packages compile; one passing tooling test verifies the workspace is healthy; the daemon's native-binding rebuild path is exercised at bootstrap; the engineering CI surface (per [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md)) is wired and gates subsequent PRs.

**Ship-gate:** [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md) — V1 CI/CD, Pre-Commit Hooks, and Release Automation — accepted 2026-04-26 per [BL-100](../backlog.md). The CI workflow files, lefthook + commitlint pre-commit framework, Renovate dependency-update config, Gitleaks secret scanner, `CODEOWNERS`, and code-signing custody scaffolding authored by ADR-023 land in this PR.

- Create root scaffolding (per § Repo Layout And Bootstrap above)
- Create empty `packages/contracts/`, `packages/client-sdk/`, `packages/runtime-daemon/`, `packages/control-plane/`, `apps/desktop/` skeletons with `package.json` + `tsconfig.json` + `src/index.ts` (no exports)
- Install `better-sqlite3` 12.9+ as a workspace dep on `packages/runtime-daemon/` per [ADR-022](../decisions/022-v1-toolchain-selection.md). Even without imports, this exercises the postinstall native-binding rebuild path for the daemon target under `node-linker=isolated` at bootstrap time, surfacing native-rebuild integration risk before behavior PRs land.
- Install `pg` 8.20+ as a workspace dep on `packages/control-plane/` per [ADR-022](../decisions/022-v1-toolchain-selection.md)
- Wire engineering CI surface per [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md): `.github/workflows/{ci,release}.yml`, lefthook 2.1.6 + `lefthook.yml`, `lint-staged.config.mjs`, commitlint 20.5.2 config, Renovate config, Gitleaks workflow, `CODEOWNERS`, release-please-action@v5 + actions/attest@v4 release-automation skeleton (no actual release runs yet — first release is post-Plan-001 ship)
- Verify: `pnpm install`, `pnpm turbo build`, `pnpm turbo typecheck`, and `pnpm turbo lint` all green; CI runs green on this PR; pre-commit hooks active locally; required-checks gate is enforced on subsequent PRs
- Single passing test (in `packages/contracts/`): trivial sanity check that Vitest is wired

### PR #2 — Contracts Package

**Goal:** Tests C1–C4 from § Test And Verification Plan go green.

- `packages/contracts/src/session.ts` — `SessionId`, `SessionCreate`, `SessionRead`, `SessionJoin`, `SessionSubscribe` payload schemas
- `packages/contracts/src/event.ts` — `SessionEvent` discriminated union (V1 subset: `SessionCreated`, `MemberJoined`, `ChannelCreated`)
- `packages/contracts/src/error.ts` — `resource.limit_exceeded` shape

### PR #3 — Daemon Migration And Projection

**Goal:** Tests D1–D4 go green.

- `0001-initial.sql` migration creates `session_events`, `session_snapshots`, `participant_keys` (per § Data And Storage Changes; columns forward-declared but only `session_events` core columns are populated by Plan-001)
- `packages/runtime-daemon/src/session/session-projector.ts` — single-event-to-snapshot projection
- `packages/runtime-daemon/src/session/session-service.ts` — append + replay paths
- Storage driver: `better-sqlite3` (already installed in PR #1)

### PR #4 — Control Plane Directory

**Goal:** Tests P1–P3 go green.

- Migration creates `participants` (minimal anchor: `id`, `created_at`), `sessions` (with `min_client_version`), `session_memberships` (per § Data And Storage Changes)
- `packages/control-plane/src/sessions/session-directory-service.ts` — create, read, join paths
- Storage driver: `pg` (already installed in PR #1)

### PR #5 — Client SDK And Desktop Bootstrap

**Goal:** Tests I1–I4 go green; manual two-client smoke test passes.

- `packages/client-sdk/src/sessionClient.ts` — `create`, `read`, `join`, `subscribe` methods over the daemon and control-plane transports
- `apps/desktop/renderer/src/session-bootstrap/` — minimal renderer wiring that calls `sessionClient.create` and renders the resulting session

After PR #5 lands green and the manual smoke passes, Plan-001 is complete. Plan-002 (Invite, Membership, Presence) can then begin.

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
