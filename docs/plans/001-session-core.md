# Plan-001: Session Core

| Field | Value |
| --- | --- |
| **Status** | `completed` |
| **NNN** | `001` |
| **Slug** | `session-core` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-001: Session Core](../specs/001-session-core.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-002](../decisions/002-local-execution-shared-control-plane.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-006](../decisions/006-worktree-first-execution-mode.md), [ADR-014](../decisions/014-v1-feature-scope-definition.md), [ADR-016](../decisions/016-shared-event-sourcing-scope.md), [ADR-017](../decisions/017-cross-version-compatibility.md), [ADR-018](../decisions/018-windows-v1-tier-and-pty-sidecar.md), [ADR-021](../decisions/021-v1-toolchain-selection.md), [ADR-022](../decisions/022-v1-ci-cd-and-release-automation.md). **Phase 1**: [ADR-022](../decisions/022-v1-ci-cd-and-release-automation.md) governs the engineering CI surface that lands in Phase 1. **Phase 5**: [ADR-018](../decisions/018-windows-v1-tier-and-pty-sidecar.md) governs CP-001-1 / CP-001-2; [ADR-006](../decisions/006-worktree-first-execution-mode.md) bakes worktree paths into the daemon's session-spawn entry point per CP-001-2. |
| **Dependencies** | Phase 1–Phase 4: None (the entry plan; creates the first tables of the daemon's one schema and the control plane's one schema, among them the columns [Plan-004](./004-session-event-taxonomy-and-audit-log.md), [Plan-015](./015-hosted-account-and-identity.md) and [Plan-019](./019-data-retention-and-gdpr.md) give meaning to). Phase 6: [Plan-024](./024-agent-definitions-and-peer-invocation.md) Phase 3 for a definition-led lead, and [Plan-003](./003-provider-driver-contract-and-capabilities.md)'s driver close, `forkConversation`, running set and resume by id. Phase 5 only: [Plan-005](./005-local-ipc-and-daemon-control.md) partial-deliverable (the IPC wire substrate + `session.*` namespace + SDK Zod layer per [Spec-006 §Wire Format](../specs/006-local-ipc-and-daemon-control.md#wire-format)). See [Plan-005 §Execution Windows](./005-local-ipc-and-daemon-control.md#execution-windows-v1-carve-out). |
| **Cross-Plan Deps** | Cross-Plan Dependency Graph |

## Goal

Implement the minimum session creation, snapshot, and rebuild foundation used by all later features.

## Scope

This plan covers session ids, lead-agent creation, session-owner binding, local event append, and typed session read or subscribe APIs, and the session directory and lifecycle the desktop app drives: create with the lead and the place it works, list, rename and the session's own title, archive, unarchive and close, pin and mute, converting a chat to a project, fork, search, the `@` file search, a chat's managed workspace, and an idle Claude Code session's sleep and wake.

## Non-Goals

- The machine's registration with the control plane
- Queue and intervention behavior

## Invariants

The following invariants are **load-bearing** and MUST be preserved across all Plan-001 PRs and downstream extensions.

### I-001-1 — Sequence is the canonical order key

Local Runtime Daemon SQLite rebuild MUST order `session_events` by `sequence ASC`, never by `monotonic_ns`. The `monotonic_ns` column is within-daemon debug data only (per [local-sqlite-schema §session_events](../architecture/schemas/local-sqlite-schema.md#session-events-plan-001-extended-by-plans-004-012)); it can be non-monotonic across rows after clock adjustments and MUST NOT influence rebuild or projection.

**Why load-bearing.** Rebuild determinism is the foundation for [ADR-016](../decisions/016-shared-event-sourcing-scope.md) event-sourcing semantics. Plan-004 (event taxonomy) and Plan-012 (persistence and recovery) build on this invariant.

**Verification.** Test D3 in §Test And Verification Plan asserts `Rebuild uses sequence not monotonic_ns even when monotonic_ns is non-monotonic across rows`.

### I-001-2 — Columns another plan owns carry no Plan-001 logic

The columns and tables listed in §Cross-Plan Schema Ownership (Plan-001 creates them in the one schema; other plans own what they mean) carry no read or write logic from Plan-001. Plan-001 creates their types and nullability as the schema docs define them; the owners (Plan-004 events, Plan-019 data retention, Plan-015 identity) author all read/write logic in their own plans.

**Why load-bearing.** Each of these columns has one owner, so what it means is written in one place.

**Verification.** Review of each Plan-001 change: it adds no read or write of these columns.

## Cross-Plan Obligations

Plan-001 owns the daemon-side session lifecycle and the `PtyHost.spawn` entry-point wrapper. Two daemon-layer obligations (CP-001-1, CP-001-2) are declared by Plan-021 (Rust PTY Sidecar) and surface here for bidirectional citation locality, so a Plan-001 reviewer sees the obligations without first reading Plan-021. Each entry states the obligation, the source citation, and the resolution.

### CP-001-1 — The sidecar drains when the service stops

[Plan-021 §Invariants I-021-4](./021-rust-pty-sidecar.md#i-021-4--the-apps-quit-never-stops-a-shell-the-sidecar-drains-only-when-the-service-stops) declares that the desktop app's quit never stops a shell: the sidecar is a child of the daemon, and the daemon is the person's own background service, never a child of the app, so quitting the app leaves the service, every run and every shell running. The sidecar drains only when the service itself stops — Runtime's `Stop` or `Restart`, or the operating system's service manager stopping it — and that drain must finish before the daemon exits, or child processes orphan to the global console (the `microsoft/node-pty#904` SIGABRT-on-exit class — primary source cited at [Plan-021 §Windows Implementation Gotchas Gotcha 4](./021-rust-pty-sidecar.md#4-the-apps-quit-and-the-sidecars-shutdown)).

**Resolution.** Plan-001 wires the drain into the daemon's own stop sequence, ahead of the daemon's exit; nothing in the app's quit reaches it. The stop delegates to a single polymorphic `PtyHost.shutdown({ perSessionTimeoutMs, hostTimeoutMs })` call — both backends (`RustSidecarPtyHost` out-of-process; `NodePtyHost` in-process) implement the drain protocol per `packages/runtime-daemon/src/pty/host/contract.ts`, so the stop sequence never sees a backend-specific surface ([ADR-018 §Decision](../decisions/018-windows-v1-tier-and-pty-sidecar.md#decision): "Consumers never see the backend choice"). The contract pins the drain semantics: per-session `SIGTERM` → wait for `ExitCodeNotification` up to `perSessionTimeoutMs` → escalate to `SIGKILL` on timeout; then close the sidecar's stdin → wait for sidecar exit up to `hostTimeoutMs` → escalate to `taskkill /T /F /PID <sidecar-pid>` on hard timeout. In-process `NodePtyHost` vacuously satisfies the host fields (`sidecarExitedCleanly: true, taskkillEscalated: false`). Escalation matches §Cross-Plan Obligations CP-001-2 below for the same hard-stop pattern. The two timeouts are `DAEMON_STOP_TERMINAL_DRAIN_MS` and `DAEMON_STOP_TERMINAL_HOST_DRAIN_MS` in `packages/contracts/src/daemon/lifecycle.ts`, and their sum is the drain bound, `DAEMON_STOP_DRAIN_BOUND_MS`: a client that ends the service (main's supervisor, the CLI, the Windows half) waits that long after the stop for the process to exit before it sends any signal, so no signal cuts the drain short.

**Why surfaced in Plan-001.** This obligation lives at the daemon's session-lifecycle layer (Plan-001 owns the session-lifecycle daemon code), not at the sidecar protocol layer (Plan-021 supplies only the `PtyHost.close(sessionId)` and `KillRequest` primitives). Without the bidirectional citation, a Plan-001 reviewer would have no signal that the drain at the service's stop is a Plan-001 obligation.

### CP-001-2 — `PtyHost.spawn(spec)` performs daemon-layer cwd-translation for worktree paths

[Plan-021 §Invariants I-021-5](./021-rust-pty-sidecar.md#i-021-5--spawnrequestcwd-carries-a-stable-path-daemon-performs-worktree-translation) declares that the sidecar's `SpawnRequest.cwd` MUST always carry a stable, unmovable parent directory; worktree paths live in the command-string-or-env layer above. Without daemon-layer translation, the sidecar would forward worktree paths verbatim to `portable-pty::PtySize::spawn_command`, Windows would lock the worktree directory (`ERROR_SHARING_VIOLATION`), and `git worktree remove` would fail until every spawned session under that worktree exited (the `microsoft/node-pty#647` class — primary source cited at [Plan-021 §Windows Implementation Gotchas Gotcha 5](./021-rust-pty-sidecar.md#5-spawn-locks-cwd-on-windows)).

**Resolution.** Plan-001 [Phase 5 — Client SDK And Daemon Wiring](#phase-5--client-sdk-and-daemon-wiring) ships a daemon-layer `PtyHost.spawn` wrapper that intercepts `spec.cwd`, substitutes a stable parent directory (the daemon's working dir or user-home root) for the protocol-level `SpawnRequest.cwd`, and prepends a `cd <worktree-path> && ` shell prefix (or sets `CWD=<worktree-path>` env, depending on whether the agent CLI consumes `cd` semantics or env-based cwd). The wrapper sits in `packages/runtime-daemon/src/session/` (Plan-001's session lifecycle layer) so both `RustSidecarPtyHost` and `NodePtyHost` inherit the same translation — the constraint is OS-level, not backend-specific, per Plan-021 I-021-5.

**Why surfaced in Plan-001.** ADR-006 (Worktree-First Execution Mode) bakes worktree paths into the daemon's session-spawn entry point. The translation MUST happen between the daemon's logical worktree-path API and the sidecar's wire-protocol `SpawnRequest.cwd` — i.e., in Plan-001's session-lifecycle code, not in Plan-021's sidecar code (the sidecar deliberately does not know about worktree semantics, per Plan-021 I-021-3 / I-021-5). Plan-021 Phase 3 carries an explicit `**Precondition:**` line on this wrapper because the sidecar end-to-end test would surface `ERROR_SHARING_VIOLATION` on Windows CI without it.

## Preconditions

- **Phase 1 CI surface**: [ADR-022](../decisions/022-v1-ci-cd-and-release-automation.md) — V1 CI/CD, Pre-Commit Hooks, and Release Automation. The engineering CI surface that lands in Phase 1 (`.github/workflows/{ci,release}.yml`, lefthook 2.1.16 pre-commit framework, commitlint 21.2.3, Renovate dependency-update config, Gitleaks 8.30.1 secret scanner, release-please-action@v5 release skeleton, code-signing custody artifacts) is governed by that ADR.

Target paths below assume the implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/session/id.ts` and `packages/contracts/src/session/methods.ts`
- `packages/client-sdk/src/session.ts`
- `packages/runtime-daemon/src/session/service.ts`
- `packages/runtime-daemon/src/session/projector.ts`

## Repo Layout And Bootstrap

Workspace topology is described in [Container Architecture](../architecture/container-architecture.md). Toolchain primitives, version pins, and two-tier Node target rules are set by [ADR-021](../decisions/021-v1-toolchain-selection.md). Plan-001 owns the bootstrap artifacts that wire those choices into the repo.

### Root Scaffolding

- `package.json` — workspace root with `"private": true` and the `packageManager` pin per [ADR-021](../decisions/021-v1-toolchain-selection.md), and no `engines` install gate
- `pnpm-workspace.yaml` — declares `packages/*` and `apps/*`
- `turbo.json` — `build`, `test`, `lint`, `typecheck`, and `dev` task pipelines at scaffold time; later tasks (`test:coverage`, for one) are added by the work that owns them
- `tsconfig.base.json` — strict + `isolatedDeclarations: true` + ESM-only; per-package `tsconfig.json` extends base
- `.npmrc` — `node-linker=isolated` (required by [ADR-021](../decisions/021-v1-toolchain-selection.md) two-ABI native binding constraint)
- `.nvmrc` — pins Node 24.21, the one Node line the daemon, the command line and the Electron app share, per [ADR-021](../decisions/021-v1-toolchain-selection.md)
- `eslint.config.mjs` and `prettier.config.js` at root

**Engineering CI surface** — `.github/workflows/{ci,release}.yml`, lefthook 2.1.16 pre-commit hook framework + `lefthook.yml`, `lint-staged.config.mjs`, commitlint 21.2.3 config (its type set leaves out `style`), Renovate config (`renovate.json5`), `CODEOWNERS`, Gitleaks 8.30.1 workflow, and code-signing custody artifacts (the self-signed macOS identity, then Apple Developer Individual, and SignPath Foundation for Windows) are owned by [ADR-022](../decisions/022-v1-ci-cd-and-release-automation.md). Phase 1 lands the concrete artifact list per [ADR-022 §Decision](../decisions/022-v1-ci-cd-and-release-automation.md#decision).

### Per-Package Scaffolding

Every `packages/*` and `apps/*` member receives a `package.json` (with `"type": "module"`, `engines.node` set to the packages' floor `>=24.21.0` per [ADR-021](../decisions/021-v1-toolchain-selection.md), and an `exports` map), a `tsconfig.json` extending base, and a `src/` directory.

The daemon and the command line run on Node 24.21 or later: the memory gate that decides when a step starts reads `process.availableMemory()`, which needs 24.16 or later, and 24.21 is the Node Electron 44 bundles; every package shares that one floor, and the desktop app runs the Node its Electron pin bundles.

Vitest test-file discovery is owned by each package's own standalone `vitest.config.ts` — a plain `defineConfig` with no workspace-level config above it and no single project-wide test path. The root `vitest.shared.ts` holds only the coverage options and test limits every config calls, a factory rather than one root config with `projects`, because Vitest 4 reads `coverage` only at the root once projects exist. The suites aggregate through Turbo's `test` task (`turbo run test`), which runs each package's own `test` script. Every package under `packages/` discovers `src/**/__tests__/**/*.test.ts`, and `packages/client-sdk/` adds `test/**/*.test.ts` for its integration tests. `apps/desktop/` declares Vitest `projects` in its config: `smoke` (Node, `tests/*.test.ts`, the Electron-spawning probes), `main-unit` (Node, the units of the main process, the preload, the shared code, the build and script trees and the test helpers), and the renderer tiers declared in `vitest/tier-projects.ts` — `renderer` (happy-dom, `src/renderer/src/**/*.test.{ts,tsx}`), then `browser`, `screenshot`, `accessibility`, `bundle`, `e2e` and `endurance`, each over its own folder under `tests/`; its `test` script runs them tier by tier through Turbo.

## Data And Storage Changes

Plan-001 creates the first tables of the daemon's one SQLite schema and the control plane's one Postgres schema, among them the columns and tables later plans give meaning to. The two engines are distinct per [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md). The column-level definitions are canonical in the schema docs below; this plan body lists the elements other plans own.

- Add the minimal `users` identity-anchor table (`id UUID PK`, `created_at TIMESTAMPTZ`) to Control Plane storage **before** any FK-bearing shared table. The anchor comes first because `runtime_nodes.user_id`, `devices.user_id` and the other user-bearing tables `REFERENCES users(id)`, and Plan-001 executes before Plan-015. Plan-001 owns the physical CREATE of the minimal shape only; the identity columns (`display_name`, `identity_ref`, `metadata`) are added to the control plane's one schema by Plan-015. See [Shared Postgres Schema §Users Identity Anchor](../architecture/schemas/shared-postgres-schema.md#users-identity-anchor-plan-001).
- Add local `session_events` and `session_snapshots` tables to Local Runtime Daemon SQLite.
- Add the local `session_console_state` table to Local Runtime Daemon SQLite — the session-scoped console store the composer draft, its staged attachments, the per-session step bound and a Claude Code session's own advisor live in ([Local SQLite Schema §Session Console State (Plan-001)](../architecture/schemas/local-sqlite-schema.md#session-console-state-plan-001)).
- The daemon's session record gains the members Phase 6 writes: `shape` (`chat` or `project`), set at create; the name; whether the session is pinned and its place among the pinned; `muted_at`, rebuilt from the mute events; the pending working-folder move; and `scratchForDefinitionId` for Try it's scratch session. The record also carries the session's `group`, an indexed column naming one of its project's groups. Beside the record the daemon keeps `session_groups` (each project's groups, a name unique in its project ignoring case), `session_links` (one row per pair of sessions and kind, with its count and its first and last time, indexed from both ends), `session_tags` (indexed by tag) and each session's precomputed related list ([Local SQLite Schema §Session Directory (Plan-001)](../architecture/schemas/local-sqlite-schema.md#session-directory-plan-001)). The daemon also keeps SQLite's built-in full-text index (FTS5) over session titles, message text, tool calls, group names and tags for `session.search`, and the wake-ups and session-only jobs a Claude Code session holds, kept from their tool results so the idle sleep can read them. No member carries a provider account supplied by a client.
- Create `session_events.monotonic_ns INTEGER NOT NULL` per [Spec-013 §Clock Handling](../specs/013-persistence-and-recovery.md#clock-handling) (semantics owned by Plan-004).
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for canonical column definitions of `session_events` and `session_snapshots`.

## Cross-Plan Schema Ownership

Plan-001 creates the elements above in the one schema of their database. The plans below own the read/write semantics and invariants of each. Engineers implementing Plan-001 MUST NOT add read/write logic for these columns; that logic belongs in the owner plan's implementation window.

| Element | Semantics Owner | Invariant / Protocol |
| --- | --- | --- |
| `session_events.monotonic_ns` | [Plan-004](./004-session-event-taxonomy-and-audit-log.md) | `process.hrtime.bigint()` at emit, for ordering within one daemon only, never the order key ([Spec-013 §Clock Handling](../specs/013-persistence-and-recovery.md#clock-handling)) |
| `users` (minimal anchor: `id`, `created_at`) | [Plan-015](./015-hosted-account-and-identity.md) | Plan-001 creates the anchor row shape; no user rows are inserted until Plan-015's registration flow lands; Plan-015 adds `display_name`, `identity_ref` and `metadata` to the control plane's one schema per [Shared Postgres Schema §Users and Identity](../architecture/schemas/shared-postgres-schema.md#users-and-identity-plan-015) |

## API And Transport Changes

- Add `SessionCreate`, `SessionRead`, and `SessionSubscribe` to the shared contracts, the daemon and the client SDK. Another of the user's devices calls the same methods on the machine's daemon over the relay ([Plan-025](./025-remote-control.md)); the control plane serves no session method.
- `session.create` carries the session's one lead agent — a saved agent definition named (`leadDefinitionId`), or the axes spelled out in `lead` (its driver, model and effort) — with the lead's model and effort, and in a project a `binding` naming the project and where the session works, a worktree of its own or the project's checkout; Try it's scratch session adds `scratch: true`. The request carries no provider-account member. Its reply echoes the binding the daemon resolved for the lead: the driver, the model, the effort and the provider account ([Spec-001 §Interfaces And Contracts](../specs/001-session-core.md#interfaces-and-contracts)). The same resolved values ride `session.created`, which is where that agent's row in the session's `agents` projection is born, because no verb attaches an agent to a session ([Spec-005 §Event Type Enumeration](../specs/005-session-event-taxonomy-and-audit-log.md#event-type-enumeration)).
- `SessionRecord` carries two additive-optional members this plan's `session.read` answers with, both read by the session inspector and by nothing else. **`maxStepsPerTurn`** is that session's own bound on how many steps one turn may take, projected from the session record and absent where the person set none; its write is `session.maxStepsUpdate`, an owed verb registered in [api-payload-contracts.md §Session Method-Name Registry](../architecture/contracts/api-payload-contracts.md#session-method-name-registry) with the rest of the console's session mutations and built with them rather than here. **`address`** is the address another session writes to when it messages this one: the inbox the daemon holds for the session, one socket, `sidekicks-<session-id>.sock` in Claude Code's socket directory on a Mac and on Linux and the named pipe `\\.\pipe\sidekicks-<session-id>` on Windows, stable for the session's whole life and derived from the session id, so it is present whether or not a process is running and it mints no read of its own. The override's durable home is `session_console_state` ([Local SQLite Schema §Session Console State (Plan-001)](../architecture/schemas/local-sqlite-schema.md#session-console-state-plan-001)), the daemon's own session-scoped store beside the draft and the staged attachments, a table of the daemon's one schema; the address is derived from the session id and adds no column anywhere.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define session contracts and ids in `packages/contracts`.
2. Create the control plane's `users` anchor.
3. Implement Local Runtime Daemon session event append and snapshot projection.
4. Add client SDK methods for create, read, and subscribe.
5. Serve the session directory and lifecycle verbs, a chat's managed workspace, an idle Claude Code session's sleep, and the groups, links and tags search reads, ship the terminal bridge plugin, and refuse to start a session whose provider is missing (Phase 6).

## Parallelization Notes

- Contract definitions and the control plane's `users` anchor can proceed in parallel with Local Runtime Daemon projection scaffolding.
- Desktop renderer integration should wait until client SDK contracts are stable.

## Test And Verification Plan

The TDD test list below is enumerated and ordered by implementation dependency. Each test maps to one or more [Spec-001 acceptance criteria](../specs/001-session-core.md#acceptance-criteria). Tests run via Vitest 4.x projects per [ADR-021](../decisions/021-v1-toolchain-selection.md).

### Contract Layer (`packages/contracts/`)

| ID | Test | Asserts | Spec-001 AC |
| --- | --- | --- | --- |
| C1 | `SessionId.parse rejects malformed UUIDs` | id format invariant | (no direct AC; format invariant — precondition for AC1/AC3/AC4) |
| C2 | `SessionCreate payload rejects unknown fields` | request schema strictness | AC1 |
| C3 | `SessionEvent discriminated union round-trips through JSON` | event serialization | AC1, AC6 |

### Daemon Projection Layer (`packages/runtime-daemon/src/session/`)

| ID | Test | Asserts | Spec-001 AC |
| --- | --- | --- | --- |
| D1 | `Single SessionCreated event yields snapshot with session owner and lead agent` | bootstrap projection | AC1 |
| D2 | `Rebuild reads events by sequence ASC and reproduces snapshot deterministically` | rebuild correctness; `sequence` is the canonical ordering key per [ADR-016](../decisions/016-shared-event-sourcing-scope.md) | AC6 |
| D3 | `Rebuild uses sequence not monotonic_ns even when monotonic_ns is non-monotonic across rows` | clock-skew defense; `monotonic_ns` is within-daemon debug data, never the order key (per [local-sqlite-schema §session_events](../architecture/schemas/local-sqlite-schema.md#session-events-plan-001-extended-by-plans-004-012)) | AC6 |
| D4 | `Snapshot survives daemon restart and yields identical projection on rehydrate` | durability across restart | AC2, AC6 |
| D5 | `The daemon's one schema accepts each contract member and refuses a non-member` | for each CHECK-constrained column of `session_events` and `session_snapshots`, an insert of each contract member succeeds and an insert of a non-member fails | (no AC) |

### SDK And Integration Layer (`packages/client-sdk/`, integration)

| ID | Test | Asserts | Spec-001 AC |
| --- | --- | --- | --- |
| I1 | `SessionCreate then SessionRead returns identical session id` | round-trip | AC1, AC3 |
| I3 | `SessionSubscribe yields events in sequence ASC across reconnect` | reconnect ordering by canonical key | AC3, AC7 |
| I4 | `Reconnect after lost stream restores from snapshot, not client cache` | snapshot authority | AC6 |
| I5 | `Sidecar drain via PtyHost.shutdown() at the service's stop: per-session SIGTERM→SIGKILL escalation; host stdin-close→taskkill escalation; -1 crash sentinel suppressed; concurrent spawn during shutdown rejected; the app's quit drains nothing` | verifies obligation CP-001-1 (also verifies inherited Plan-021 I-021-4) — files: `packages/runtime-daemon/src/pty/host/__tests__/node-pty.shutdown.test.ts` (in-process backend drain semantics), `packages/runtime-daemon/src/pty/sidecar/__tests__/host.shutdown.test.ts` (out-of-process backend drain semantics + sidecar wind-down + crash-budget suppression) | (no AC; verifies CP-001-1) |
| I6 | `PtyHost.spawn rewrites worktree-path cwd to stable parent dir + cd-prefix or CWD-env; round-trip on Windows CI does not surface ERROR_SHARING_VIOLATION` | verifies obligation CP-001-2 (also verifies inherited Plan-021 I-021-5) — file: `packages/runtime-daemon/src/session/__tests__/spawn-cwd-translator.windows.test.ts` | (no AC; verifies CP-001-2) |

### Verification

- `pnpm turbo test` at workspace root green across all packages
- Manual smoke: create a session in the desktop client, reload it, and verify the transcript is rebuilt from the authoritative snapshot
- Every enumerated test above passes (the C-, D-, I- and W-tier tooling tests — see Phase 1 §Tests; CP-001-1 / CP-001-2 coverage via I5 / I6 lands at Phase 5 in the daemon package), and each Phase 6 task's acceptance holds.
- Test ID prefixes map to Phases as follows: W → Phase 1, C → Phase 2, D → Phase 3, I → Phase 5. Each Phase's Goal line names the ID range it owns. Phases 4 and 6 own no ID range: Phase 4 creates the control plane's `users` anchor, and each Phase 6 task carries its own acceptance and tests.
- Spec-001 AC7 (concurrent agents and runs without transcript corruption) receives full coverage at the integration boundary in [Plan-025](./025-remote-control.md), where several devices drive one session through its machine over the relay. Plan-001 covers AC7 partially via I3's reconnect-ordering invariant: concurrent writes on the session's one daemon serialize on SQLite's `UNIQUE(session_id, sequence)` constraint.
- Spec-001 AC4 and AC5 (another device opening a session receives the same session id and full history, and nothing forks or resets) are proven at the same relay boundary in [Plan-025](./025-remote-control.md), where a device opens a session through its machine; in Plan-001, I1 proves that a read returns the created session's id.

## Implementation Phase Sequence

Plan-001 implementation lands as a sequence of small PRs. Each PR exercises one slice of the contract → daemon → SDK vertical; Phase 4 adds the control plane's `users` anchor beside it. Phase 1 is workspace scaffolding only; subsequent PRs add behavior.

### Phase 1 — Workspace Bootstrap

**Precondition:** none.

**Goal:** All packages compile; one passing tooling test verifies the workspace is healthy; the daemon's native-binding rebuild path is exercised at bootstrap; the engineering CI surface (per [ADR-022](../decisions/022-v1-ci-cd-and-release-automation.md)) is wired and reports on every PR.

**Ship-gate:** [ADR-022](../decisions/022-v1-ci-cd-and-release-automation.md) — V1 CI/CD, Pre-Commit Hooks, and Release Automation. The CI workflow files, lefthook + commitlint pre-commit framework, Renovate dependency-update config, Gitleaks secret scanner, `CODEOWNERS`, and code-signing custody scaffolding authored by ADR-022 land in this PR.

- Create root scaffolding (per § Repo Layout And Bootstrap above)
- Create empty `packages/contracts/`, `packages/client-sdk/`, `packages/runtime-daemon/`, `packages/control-plane/` skeletons with `package.json` + `tsconfig.json` + `src/index.ts` (no exports). At Phase 1, `apps/desktop/` is scaffolded as a placeholder workspace package only (single `src/index.ts` with the forward-declaration comment "split into `apps/desktop/src/{main,preload,renderer}/` per the electron-vite zero-config convention"); the substrate split (`apps/desktop/src/{main,preload,renderer}/`) is owned by [Plan-020's partial](./020-desktop-app-and-renderer.md#partial-pr-sequence) and lands as a separate PR before Plan-001 Phase 5.
- Install `better-sqlite3` at exactly `13.0.3` ([Spec-013 §Driver Pin](../specs/013-persistence-and-recovery.md#driver-pin)) as a workspace dep on `packages/runtime-daemon/` per [ADR-021](../decisions/021-v1-toolchain-selection.md). Even without imports, this exercises the postinstall native-binding rebuild path for the daemon target under `node-linker=isolated` at bootstrap time, surfacing native-rebuild integration risk before behavior PRs land.
- Install `pg` 8.20+ as a workspace dep on `packages/control-plane/` per [ADR-021](../decisions/021-v1-toolchain-selection.md)
- Wire engineering CI surface per [ADR-022](../decisions/022-v1-ci-cd-and-release-automation.md): `.github/workflows/{ci,release}.yml`, lefthook 2.1.16 + `lefthook.yml`, `lint-staged.config.mjs`, commitlint 21.2.3 config, Renovate config, Gitleaks workflow, `CODEOWNERS`, release-please-action@v5 release-automation skeleton (no actual release runs yet — first release is post-Plan-001 ship). The literal-file content for `lefthook.yml`, `CODEOWNERS`, `renovate.json5`, `eslint.config.mjs`, `prettier.config.js`, `commitlint.config.mjs`, and the three workflow files is the Phase 1 PR's authoring scope; [ADR-022 §Decision](../decisions/022-v1-ci-cd-and-release-automation.md#decision) pins versions and policy choices, the implementer of this Phase materializes the literal artifact contents.
- Verify: `pnpm install`, `pnpm turbo build`, `pnpm turbo typecheck`, and `pnpm turbo lint` all green; CI runs green on this PR; pre-commit hooks active locally
- Single passing test (a Vitest sanity test in `packages/contracts/src/__tests__/`): trivial sanity check that Vitest is wired (test ID **W1** per § Test And Verification Plan)

#### Tasks

##### T1.1 — Workspace root scaffolding

**Files:** `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.npmrc`, `.nvmrc` **Reference:** [§Repo Layout And Bootstrap →§Root Scaffolding](#root-scaffolding); [ADR-021](../decisions/021-v1-toolchain-selection.md) **Acceptance:** `pnpm install` succeeds; `pnpm-workspace.yaml` declares `packages/*` and `apps/*`; `tsconfig.base.json` has `"strict": true` + `"isolatedDeclarations": true` + ESM-only; `.npmrc` has `node-linker=isolated`; `.nvmrc` pins Node 24.21. **Spec coverage:** none (workspace-root bootstrap) **Verifies invariant:** none (workspace bootstrap)

##### T1.2 — Per-package skeletons (`apps/desktop/` ships placeholder; Plan-020's partial delivery repositions)

**Files:** `packages/{contracts,client-sdk,runtime-daemon,control-plane}/{package.json,tsconfig.json,src/index.ts}` + `apps/desktop/{package.json,tsconfig.json}` and a placeholder entry file **Acceptance:** each `package.json` has `"type": "module"`, `engines.node` per ADR-021 two-tier rule (lower for `contracts`/`client-sdk`/`runtime-daemon`/`apps/desktop`, upper for `control-plane`); each `tsconfig.json` extends `../../tsconfig.base.json`; each `src/index.ts` is empty (no exports). The desktop's placeholder entry file carries a forward-declaration comment ("split into `apps/desktop/src/{main,preload,renderer}/` per the electron-vite zero-config convention") that [Plan-020's partial T-020p-1-1](./020-desktop-app-and-renderer.md#partial-pr-sequence) repositions during the substrate-split PR. **Spec coverage:** none (per-package scaffold) **Verifies invariant:** none

##### T1.3 — Native-binding installation surface

**Acceptance:** `better-sqlite3@13.0.3` declared exactly in `packages/runtime-daemon/package.json`; `pg@^8.23.1` declared in `packages/control-plane/package.json`; `pnpm install` resolves `better-sqlite3`'s bundled Node-API prebuild under `node-linker=isolated` with no source compile. **Spec coverage:** none (native-binding install surface) **Verifies invariant:** none

##### T1.4 — Lint, format, type-check config

**Files:** `eslint.config.mjs`, `prettier.config.js` **Acceptance:** ESLint flat-config preset assembled per ADR-022; Prettier rules per repo convention; `pnpm turbo lint` and `pnpm turbo format:check` pass at workspace root. **Spec coverage:** none (lint/format/type-check config) **Verifies invariant:** none

##### T1.5 — Engineering CI surface (per ADR-022)

**Files:** `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/workflows/gitleaks.yml`, `lefthook.yml`, `lint-staged.config.mjs`, `commitlint.config.mjs`, `renovate.json5`, `CODEOWNERS` **Acceptance:** `pnpm turbo build`, `pnpm turbo typecheck`, `pnpm turbo lint`, `pnpm turbo test` all green; CI workflow runs green on this PR; pre-commit hooks active locally. **Spec coverage:** none (engineering CI surface) **Verifies invariant:** none

##### T1.6 — Vitest sanity test

**File:** a Vitest sanity test in `packages/contracts/src/__tests__/` **Acceptance:** `vitest run` returns exit 0; W1 (per § Tests below) green. **Spec coverage:** none (tooling readiness) **Verifies invariant:** none (tooling readiness)

#### Tests

| ID | Test | Asserts | Spec-001 AC |
| --- | --- | --- | --- |
| W1 | `vitest sanity: trivial assertion in packages/contracts passes` | Vitest 4.x project graph resolves; CI test job exits 0 | n/a (tooling) |

### Phase 2 — Contracts Package

**Precondition:** Phase 1 merged (workspace + CI surface in place).

**Goal:** Tests C1–C3 from § Test And Verification Plan go green.

- `packages/contracts/src/session/id.ts` and `packages/contracts/src/session/methods.ts` — `SessionId`, `SessionCreate`, `SessionRead`, `SessionSubscribe` payload schemas. `SessionCreate` names the one main agent on the request — a saved definition id, or the axes spelled out — and its response echoes the resolved binding (driver, model, effort, provider account) beside the session id and state. Plan-001 also exports `SessionSubscribeStream = AsyncIterable<EventEnvelope>` typed against an opaque `EventEnvelope` placeholder per **C-6** (forward-stub for Plan-004); the stub is narrowed when Plan-004 ships.
- `packages/contracts/src/event/session.ts` (`SessionEventSchema`) and `packages/contracts/src/event/variant-types.ts` (the `SessionEvent` type) — `SessionEvent` discriminated union (V1 subset: `SessionCreated`, declared in `packages/contracts/src/event/declared-variants.ts`). `SessionCreated` carries a per-type payload rather than the shared state-transition shape: `{sessionId, mainAgent, actor?}`, where `mainAgent` holds every value the daemon resolved when it started the session — the agent id it minted, the definition id where one was named, the name, driver, model, provider account and effort, the three axes the daemon reads for itself (tool allowlist, instructions, goal) and the resolved agent state — the same values the create reply echoes, so wire and durable record serialize identically ([Spec-005 §Event Type Enumeration](../specs/005-session-event-taxonomy-and-audit-log.md#event-type-enumeration)). The discriminator surface in `api-payload-contracts.md` (per C-6) lands the same Phase as this file.

#### Tasks

##### T2.1 — `SessionId`, `SessionCreate`, `SessionRead`, `SessionSubscribe` payload schemas

**Files:** `packages/contracts/src/session/id.ts`, `packages/contracts/src/session/methods.ts`, `packages/contracts/src/session/__tests__/id.test.ts`, `packages/contracts/src/session/__tests__/methods.read.test.ts`, `packages/contracts/src/session/__tests__/methods.subscribe.test.ts` **Spec coverage:** Spec-001 AC1, AC3; Spec-001 §Interfaces And Contracts (the main agent named on create and the resolved binding echoed in the reply) **Verifies invariant:** none (contract layer)

##### T2.2 — `SessionEvent` discriminated union

**Files:** `packages/contracts/src/event/session.ts`, `packages/contracts/src/event/variant-types.ts`, `packages/contracts/src/event/declared-variants.ts`, `packages/contracts/src/event/__tests__/session.test.ts` **Spec coverage:** Spec-001 AC1, AC6; Spec-005 §Event Type Enumeration (`session.created`'s `mainAgent` payload) **Verifies invariant:** none

### Phase 3 — Daemon Schema And Projection

**Precondition:** Phase 2 merged (contract types — `SessionEvent` discriminated union — are imported by the projector).

**Goal:** Tests D1–D5 go green.

- The daemon's one schema holds `session_events` and `session_snapshots` (per § Data And Storage Changes; Plan-001 populates only the `session_events` core columns, and the columns other plans own stay unpopulated until those plans land).
- **Pragmas.** Daemon bootstrap MUST set `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000` per [Local SQLite Schema §Pragmas](../architecture/schemas/local-sqlite-schema.md#pragmas) before the first projector apply().
- `packages/runtime-daemon/src/session/projector.ts` — single-event-to-snapshot projection. Projector signatures: `apply(snapshot: Snapshot, event: SessionEvent): Snapshot`; `rebuildSession(events: ReadonlyArray<EventRow>): Snapshot` ordered by `sequence ASC` per I-001-1. `Snapshot` shape per [api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md) (the Plan-001 block, `SessionRecord`).
- `packages/runtime-daemon/src/session/service.ts` — append + rebuild paths. `create` resolves the main agent's binding before it appends — the driver, the model, the effort and the provider account, from the named definition or the axes the request spelled out — mints that agent's id, appends `session.created` carrying those resolved values as `mainAgent`, and echoes the same values in its reply; the projector reads that payload as the creating record of the agent's row, so a projector that ignored it could not rebuild one. Service signatures: `SessionService.create(req: SessionCreateRequest): Promise<SessionCreateResponse>`; `read(req: SessionReadRequest): Promise<SessionReadResponse>`; `subscribe(req: SessionSubscribeRequest): SessionSubscribeStream` (`LocalSubscriptionProducer<T>` per Plan-005 partial substrate's IPC shape).
- Storage driver: `better-sqlite3` `13.0.3`, pinned exactly per [Spec-013 §Driver Pin](../specs/013-persistence-and-recovery.md#driver-pin) and [ADR-021](../decisions/021-v1-toolchain-selection.md) (already installed in Phase 1). Order key: `sequence` per [ADR-016](../decisions/016-shared-event-sourcing-scope.md).

#### Tasks

##### T3.1 — The daemon's one schema + pragmas

**Files:** the daemon's one schema, daemon bootstrap shim that applies pragmas **Spec coverage:** Spec-001 AC2 (durability) **Verifies invariant:** none (D5, the schema's test, proves its CHECK constraints)

##### T3.2 — Projector reducer + rebuild

**Files:** `packages/runtime-daemon/src/session/projector.ts`, `packages/runtime-daemon/src/session/__tests__/projector.test.ts` **Spec coverage:** Spec-001 AC1, AC6; Spec-005 §Event Type Enumeration (`session.created` is the creating record of the main agent's row, so rebuilding from it is how that row exists) **Verifies invariant:** I-001-1 (sequence ASC rebuild)

##### T3.3 — Service surface (create/read/subscribe)

**Files:** `packages/runtime-daemon/src/session/service.ts`, `packages/runtime-daemon/src/session/__tests__/service.test.ts` **Spec coverage:** Spec-001 AC1, AC2, AC6; Spec-001 §Interfaces And Contracts (the resolved binding echoed on create and carried on `session.created`) **Verifies invariant:** none (driver-agnostic; D1-D4 verify behavior)

##### T3.4 — The daemon schema's test

**Files:** the daemon schema's test **Spec coverage:** none **Verifies invariant:** none (D5: each contract member inserts and a non-member is refused)

### Phase 4 — The Control Plane's One Schema

**Precondition:** Phase 1 merged (the `packages/control-plane/` skeleton and its `pg` dependency). Phases 2 and 3 are independent of it.

**Goal:** the control plane's one schema holds the `users` anchor ahead of every table that references it.

- The control plane's one schema holds `users` (minimal anchor: `id`, `created_at`), per § Data And Storage Changes.
- **Table-order invariant.** `CREATE TABLE users` MUST precede every table that references it in the one schema per [Shared Postgres Schema §Users Identity Anchor](../architecture/schemas/shared-postgres-schema.md#users-identity-anchor-plan-001) — `runtime_nodes.user_id`, `devices.user_id` and every later FK-bearing table resolve against the anchor.
- Storage driver: `pg` 8.20+ per [ADR-021](../decisions/021-v1-toolchain-selection.md) (already installed in Phase 1).

#### Tasks

##### T4.1 — The control plane's one Postgres schema

**Files:** the control plane's one schema **Spec coverage:** none (the `users` anchor other tables reference) **Verifies invariant:** none (schema only)

### Phase 5 — Client SDK And Daemon Wiring

**Goal:** Tests I1, I3, and I4 go green; the manual desktop smoke test passes.

**Precondition:** Phase 5 ships in three lanes with per-task gating, not as a single monolithic gate. Each lane unblocks when its named upstream substrate has merged. The per-task `Files:` rows at T5.1, T5.2 and T5.3 below define the per-lane boundaries.

- **Lane A** (T5.1 — `session.ts`): consumes the [Plan-005 partial sequence](./005-local-ipc-and-daemon-control.md#partial-pr-sequence) (SecureDefaults Bootstrap, Wire Substrate, `session.*` Handlers + SDK Layer).
- **Lane B** (T5.3 — `spawn-cwd-translator.ts`): unblocks once [Plan-021 T-021-2-1](./021-rust-pty-sidecar.md) ships the `PtyHostContract` interface at `packages/runtime-daemon/src/pty/host/contract.ts`.
- **Lane D** (T5.2 — the drain at the service's stop): unblocks once [Plan-021 Phase 3](./021-rust-pty-sidecar.md) ships — it supplies the `PtyHost.close(sessionId)` + `KillRequest` primitives the drain consumes.

Phase 1–Phase 4 may proceed independently; the per-lane substrate dependencies only bind at Phase 5.

- `packages/client-sdk/src/session.ts` — `create`, `read`, `subscribe` methods over the daemon transport (local IPC): consumes the Plan-005 partial-deliverable substrate — JSON-RPC 2.0 + LSP-style Content-Length framing, the `session.*` JSON-RPC method namespace, and the SDK Zod layer (per [Spec-006 §Wire Format](../specs/006-local-ipc-and-daemon-control.md#wire-format)). `subscribe` rides the JSON-RPC 2.0 streaming primitive (Plan-005 partial substrate's `LocalSubscriptionProducer<T>` shape).
- The daemon's stop sequence — drains the sidecar per §Cross-Plan Obligations CP-001-1 before the daemon exits, whenever the service stops (Runtime `Stop` or `Restart`, or the operating system's service manager); the app's quit never reaches it. Delegates to the polymorphic `PtyHost.shutdown({ perSessionTimeoutMs: 2000, hostTimeoutMs: 2000 })` (defined on the `PtyHost` interface at `packages/runtime-daemon/src/pty/host/contract.ts`), which runs per-session SIGTERM→SIGKILL escalation (2 s per-session bounded timeout) AND sidecar-process stdin-close → child-exit await → `taskkill /T /F /PID` escalation (2 s host bounded timeout). The stop sequence never touches a backend-specific surface ([ADR-018 §Decision](../decisions/018-windows-v1-tier-and-pty-sidecar.md#decision): "Consumers never see the backend choice").
- `packages/runtime-daemon/src/session/spawn-cwd-translator.ts` — daemon-layer `PtyHost.spawn(spec)` wrapper per §Cross-Plan Obligations CP-001-2; substitutes a stable parent dir for `SpawnRequest.cwd` and prepends a `cd <worktree-path> && ` shell prefix (or sets `CWD=<worktree-path>` env per agent CLI conventions). Wraps both `RustSidecarPtyHost` and `NodePtyHost` because the constraint is OS-level. The per-driver dispatch is named per target in the implementing change, on the working assumption that shell sessions use the cd-prefix and agent CLIs that read `CWD` from the environment (`claude-driver`, `codex-driver`) use the env strategy. The cd-prefix strategy mutates the command string; CWD-env mutates the process environment.

#### Tasks

##### T5.1 — `session.ts` daemon transport

**Files:** `packages/client-sdk/src/session.ts`, `packages/client-sdk/src/__tests__/session.integration.test.ts` **Spec coverage:** Spec-001 AC1, AC3, AC6 **Verifies invariant:** none (integration-layer wrapper; I1, I3 and I4 run over the daemon transport)

##### T5.2 — The sidecar drain at the service's stop via polymorphic `PtyHost.shutdown()`

**Files:** `packages/runtime-daemon/src/pty/host/contract.ts` (extends `PtyHost` interface with `shutdown(options): Promise<DrainResult>` + exports `DrainResult`), `packages/runtime-daemon/src/pty/host/node-pty.ts` (in-process `shutdown()` implementation), `packages/runtime-daemon/src/pty/sidecar/host.ts` (out-of-process `shutdown()` implementation with sidecar wind-down + crash-budget suppression), `packages/runtime-daemon/src/session/__tests__/spawn-cwd-translator.windows.test.ts` (RecordingPtyHost structural-conformance stub), the daemon's stop sequence (calls the drain before the daemon exits), `packages/runtime-daemon/src/pty/host/__tests__/node-pty.shutdown.test.ts` (in-process backend tests), `packages/runtime-daemon/src/pty/sidecar/__tests__/host.shutdown.test.ts` (out-of-process backend tests — verifies I5 — CP-001-1 + Plan-021 I-021-4) **Acceptance:** when the service stops — Runtime `Stop` or `Restart`, or the operating system's service manager — the daemon's stop sequence delegates to the polymorphic `PtyHost.shutdown({ perSessionTimeoutMs: 2000, hostTimeoutMs: 2000 })` before the daemon exits, which drains active sessions via per-session SIGTERM→SIGKILL escalation (2 s per-session bounded timeout) and winds down the sidecar process via stdin-close → child-exit wait → taskkill /T /F /PID escalation (2 s host bounded timeout). The app's quit registers no drain and leaves every shell running. The host shutdown sequence is terminal — the host instance refuses new spawns post-shutdown entry; the deliberate sidecar exit suppresses the `-1` crash sentinel and skips crash-budget accounting per `shuttingDown` flag. The stop sequence never touches a backend-specific surface. **Spec coverage:** none (verifies obligation CP-001-1 + inherited Plan-021 I-021-4) **Verifies invariant:** I-021-4 (inherited from Plan-021 together with obligation CP-001-1; exercised end-to-end by test I5)

##### T5.3 — `spawn-cwd-translator.ts` daemon-layer cwd-translator

**Files:** `packages/runtime-daemon/src/session/spawn-cwd-translator.ts`, `packages/runtime-daemon/src/session/__tests__/spawn-cwd-translator.test.ts` (Linux/Mac unit-only) + `packages/runtime-daemon/src/session/__tests__/spawn-cwd-translator.windows.test.ts` (Windows CI integration — verifies I6 / CP-001-2) **Spec coverage:** none (daemon-internal wrapper) **Verifies invariant:** none (verifies obligation CP-001-2; verifies inherited Plan-021 I-021-5)

### Phase 6 — The Session Directory And Lifecycle

**Precondition:** Phases 2 and 3 merged. T6.5, T6.8 and T6.12 call the driver's close, `forkConversation`, running set and resume by id from [Plan-003](./003-provider-driver-contract-and-capabilities.md).

**Goal:** the daemon serves every session verb [Spec-001 §Interfaces And Contracts](../specs/001-session-core.md#interfaces-and-contracts) names, with a chat's managed workspace and an idle Claude Code session's sleep, each task done when its acceptance holds.

#### Tasks

##### T6.1 — `session.create` with the lead, the place it works and a chat's workspace

**Waits on:** Plan-024 Phase 3 merged — a definition-led lead resolves through [Plan-024 §Phase 3 — Resolution when a run starts](./024-agent-definitions-and-peer-invocation.md#phase-3--resolution-when-a-run-starts).

**Files:** `packages/contracts/src/session/methods.ts`, `packages/contracts/src/event/declared-variants.ts`, `packages/runtime-daemon/src/session/service.ts`, the daemon's managed-workspace service (`ManagedWorkspaceService`) under `packages/runtime-daemon/src/workspace/` **Acceptance:** `session.create` takes the lead (`leadDefinitionId`, the axes spelled out in `lead`, or both) with its model and effort and uses those, never a value from the machine's settings file; a `session.create` the person makes writes the lead's model and effort to the machine's settings file as the last-used pair, whether the remembering switch is on or off, so the next new session the app opens with the switch on starts from them (the app reads the pair through `machineSettings.read()` and the request carries it); a Claude Code session's `advisor_model` in `session_console_state` is copied at create from the machine settings file's `advisorModel`, and a later change to that default never reaches it; in a project its `binding` names the project and `provisioned-worktree` or `bound-root`, and the session is bound there in the same step; for a chat, `ManagedWorkspaceService.create` makes the git-initialized folder at `<home>/.ai-sidekicks/workspaces/<session-id>` and registers it as a mount whose origin is managed, in the same call; the service then reports each write the chat makes in that folder, every file and folder, as the write lands and never from a timer scan, so [Plan-011](./011-artifacts-files-and-attachments.md) T14.12 keeps each write as a new version; the request has no provider-account member and the reply echoes the account the daemon resolved; `session.created` names the lead; with `scratch: true` the record carries `scratchForDefinitionId`, so Try it finds its scratch session again rather than minting another; a session minted on a project still cloning holds its first message until the clone's attach. **Spec coverage:** Spec-001 §Interfaces And Contracts, §Default Behavior, §Required Behavior (the session shapes) **Verifies invariant:** none

##### T6.2 — `session.list`, `session.read` and the `shape` column

**Files:** `packages/contracts/src/session/methods.ts`, `packages/contracts/src/session/directory.ts` (`SessionListEntry`, `SessionListAck`, and `SESSION_ACTIVITY_RENEW_INTERVAL_MS`, whose `@consumedBy` tag leaves in this change), `packages/runtime-daemon/src/session/service.ts`, `packages/runtime-daemon/src/session/projector.ts` **Acceptance:** `shape` is a column on the session record set at create and read, never inferred from a path; `session.list` is live and each entry carries title, state, `shape`, a project entry its project's `repoMountId` (the key `repo.projectList` names the project by), the branch from the session record, `muted`, its `group` where it is in one, `activity` with its `activityRenewedAt`, and, during an exchange with another session, `exchange: {peerSessionId, peerName, messageCount}`; while a run is `running` or `waiting` and sends nothing else the daemon republishes its session's entry every 15 seconds (`SESSION_ACTIVITY_RENEW_INTERVAL_MS`), so a reader's `sessionActivityAsOf` ages a reading past 45 seconds to `idle` only when the daemon has stopped renewing it, and a `failed` reading is never aged; the list carries the count of chats the Chats header shows, counted by the daemon; archived and closed sessions are entries; a session typed in a terminal has none; `session.read` answers every fact Spec-001 lists for it, the draft and the staged files among them; a quiet running session's entry is published again at each 15-second renewal and a crashed daemon's last reading ages to `idle` after 45 seconds, both asserted on a fake clock; the chats count follows a chat's create and its convert to a project. **Spec coverage:** Spec-001 §Interfaces And Contracts, AC9 **Verifies invariant:** none

##### T6.3 — `session.subscribe` batching and the caught-up frame

**Files:** `packages/contracts/src/jsonrpc/streaming.ts` (the drop mark, a member of the shared stream frame rather than of one reply), `packages/runtime-daemon/src/session/service.ts` **Acceptance:** events leave in one frame per 16 ms or 50 events, whichever comes first, changes only, each with its cursor; the daemon never waits for a screen, drops for one that falls behind and says so on its next frame; a screen repairs by cursor and takes a snapshot past a gap of 1,024 events; a screen that caught up on its queue gets one frame with no changes carrying the drop mark and the newest cursor. The transport under the stream is [Plan-005](./005-local-ipc-and-daemon-control.md)'s. **Spec coverage:** Spec-001 §Interfaces And Contracts, AC6 **Verifies invariant:** none

##### T6.4 — Rename and the session's own title

**Files:** `packages/contracts/src/session/methods.ts`, `packages/runtime-daemon/src/session/service.ts`, the daemon's title pass (`SessionAutoTitle`) under `packages/runtime-daemon/src/session/` **Acceptance:** `session.rename` writes the name and appends `session.renamed`; after the first completed exchange `SessionAutoTitle` runs one throwaway provider pass and writes a few words through the rename path, falling back to the first words of the first message; it writes only while the session is unnamed and re-reads the name before writing, so a rename during the pass keeps the person's words; no rename touches the branch or the worktree. **Spec coverage:** Spec-001 §Interfaces And Contracts **Verifies invariant:** none

##### T6.5 — Archive, unarchive, close, and the managed workspace's end of life

**Files:** `packages/contracts/src/session/methods.ts`, `packages/runtime-daemon/src/session/service.ts`, `ManagedWorkspaceService` **Acceptance:** `session.archive` appends `session.archived` and leaves the provider process as it was; `session.reactivate` appends `session.reactivated` for an archived session only; `session.close` appends `session.closed` and ends the session's provider leg through the driver's close — on Claude Code its process, on Codex its running commands and its conversations, the account's service staying up for every other conversation on it ([Plan-003](./003-provider-driver-contract-and-capabilities.md) T3.24); a closed session stays readable and searchable until the purge removes it; at purge (the service's one purge, `daemon.retentionPurge`, `Delete old data`, [Plan-019](./019-data-retention-and-gdpr.md)) `ManagedWorkspaceService.delete` removes a chat's managed workspace whole, archiving keeps it, and the archive sweep ([Plan-007](./007-worktree-lifecycle-and-execution-modes.md)) skips a mount whose origin is managed; nothing claims provable destruction. **Spec coverage:** Spec-001 §Required Behavior (archive, unarchive and close; a managed workspace at end of life) **Verifies invariant:** none

##### T6.6 — Pin and mute

**Files:** `packages/contracts/src/session/methods.ts`, `packages/runtime-daemon/src/session/service.ts`, `packages/runtime-daemon/src/session/projector.ts` **Acceptance:** `session.pin` and `session.unpin` append `session.pinned` and `session.unpinned`, and pinned sessions keep the order they were pinned in; `session.mute {sessionId}` and `session.unmute {sessionId}` answer `{}`, append `session.muted {sessionId, at}` and `session.unmuted {sessionId, at}`, and append nothing when the session is already in that state; `muted_at` is rebuilt from those events and goes with the session; `muted` is on `session.list` and `session.read`. The notification gate that reads it and withdraws standing `Finished` and `Failed` banners is [Plan-016](./016-notifications-and-attention-model.md)'s (I-016-3). **Spec coverage:** Spec-001 §Required Behavior (pin and mute), §Interfaces And Contracts **Verifies invariant:** none

##### T6.7 — Convert a chat to a project

**Files:** `packages/contracts/src/session/convert.ts` and `packages/contracts/src/session/directory.ts`, `packages/runtime-daemon/src/session/service.ts`, `ManagedWorkspaceService` **Acceptance:** `session.convert {sessionId, path}` takes the typed path as data and checks it before anything is copied; it attaches the repository through [Plan-006](./006-repo-attachment-and-workspace-binding.md)'s attach, copies the workspace's files in, skips every path the repository already holds and leaves that file untouched, keeps the managed workspace and its history, changes the session's binding and `shape` in place with the same session id and transcript, appends `session.converted` and one system message counting what was and was not copied, and sends the session's agent one short message naming the skipped files. **Spec coverage:** Spec-001 §Required Behavior (a chat becomes a project in place), AC10 **Verifies invariant:** none

##### T6.8 — Fork

**Waits on:** Plan-024 Phase 3 merged — a definition-led lead resolves through [Plan-024 §Phase 3 — Resolution when a run starts](./024-agent-definitions-and-peer-invocation.md#phase-3--resolution-when-a-run-starts).

**Files:** `packages/contracts/src/session/directory.ts`, `packages/runtime-daemon/src/session/service.ts`, `ManagedWorkspaceService` **Acceptance:** `session.fork` takes a message anchor and returns the new session's id; the conversation is copied through the driver's `forkConversation`; the new session carries the transcript through that message, its posture, model, effort and tool configuration; a chat fork gets its own managed workspace and a project fork a new worktree off the parent's current one at its current commit; the parent is recorded on the new session's `session.created`; the parent's id, transcript and runs are unchanged; `/fork` forks at the session's newest item of either side. Tests: a `/fork` sent after a reply carries that reply into the new session. **Spec coverage:** Spec-001 §Required Behavior (forking a session), AC11 **Verifies invariant:** none

##### T6.9 — Search across sessions and the `@` file search

**Files:** `packages/contracts/src/session/methods.ts`, `packages/runtime-daemon/src/session/service.ts`; `session.fileSearch` imports its scorer from `packages/search-ranking` (`@ai-sidekicks/search-ranking`), and `packages/runtime-daemon` adds `fdir` and `ignore` **Acceptance:** `session.search` answers from an FTS5 index over session titles, message text, tool calls, group names and tags, archived sessions included, ranked as T6.15 sets out with no cap, hits grouped by session, each with its message anchor (the agents' `session_search` alone groups by project, then group, then session); `session.fileSearch {sessionId, query}` lists the working folder with `git ls-files`, or `fdir` and `ignore` outside git, ranks with the product's one scorer from `packages/search-ranking` (the file search supplies its own candidate fields: the file name first, then the whole relative path), returns at most a cap of paths (a daemon constant), and drops any path whose real location is outside the working folder, so it never follows a link out of it; it answers paths relative to the working folder, tells a list still being built (`Searching…`, never `No matching files`), a query with no match, a folder with nothing to match and a failed read apart, and retries a retryable read once. Dependency choice: `fuzzysort` 4.0.2 was considered and rejected, because it is a second scoring implementation beside the product's one scorer and is fast only while it holds a prepared copy of every path (119 to 203 MiB at 100,000 paths); Claude Code's `file_suggestions` and Codex's `fuzzyFileSearch` were considered and rejected as the sole path, because a sleeping Claude Code session and a machine without Codex must still answer. **Spec coverage:** Spec-001 §Interfaces And Contracts **Verifies invariant:** none

##### T6.10 — The pending working-folder move

**Files:** `packages/contracts/src/session/directory.ts`, `packages/runtime-daemon/src/session/service.ts` **Acceptance:** `session.setWorkingFolder` records one pending move on the session row; a call naming the current folder clears it; the move is applied when the session's active run reaches a boundary, by [Plan-007](./007-worktree-lifecycle-and-execution-modes.md)'s worktree handler. **Spec coverage:** Spec-001 §Interfaces And Contracts **Verifies invariant:** none

##### T6.11 — The daemon-held draft

**Files:** `packages/contracts/src/session/methods.ts` (`session.draftUpdate` and the draft on `session.read`), `packages/runtime-daemon/src/session/service.ts`, the `session_console_state` store **Acceptance:** `session.draftUpdate` saves the draft with the session, `session.read` returns it on every device, and sending the message clears it; no typed text is written to window storage. Staging files is [Plan-011](./011-artifacts-files-and-attachments.md)'s. **Spec coverage:** Spec-001 §Interfaces And Contracts **Verifies invariant:** none

##### T6.12 — An idle Claude Code session sleeps (`SessionIdleSleep`)

**Files:** `packages/runtime-daemon/src/session/` (the idle sleep, `SessionIdleSleep`, and the record of wake-ups and session-only jobs) **Acceptance:** every 5 minutes, and again under the session's lock at the stop, `SessionIdleSleep` stops the process of a Claude Code session the daemon started after 30 idle minutes, only while no turn, queued or untaken message, open approval or question, running background task (the driver's running set from `background_tasks_changed`, empty at each spawn), wake-up or session-only job, side question or voice call would end with it; wake-ups (`ScheduleWakeup`'s `scheduledFor`) and session-only jobs (`CronCreate` until its last run or `CronDelete`) are kept from their tool results and hold the session awake until two minutes after they fire; the stop closes the process's input and waits for it to exit, and `CLAUDE_CODE_EXIT_AFTER_STOP_DELAY` is never set; the daemon holds each session's inbox, `sidekicks-<session-id>.sock` in Claude Code's socket directory on a Mac and on Linux and the named pipe `\\.\pipe\sidekicks-<session-id>` on Windows, for the session's whole life and forwards each frame written to it to the live process, and while the session sleeps it takes the first frame, wakes the session through Claude Code's resume and delivers the frame as the message; a message, `session_send`, a frame on the inbox or a workflow step to a sleeping session resumes it by id first, on the same conversation, account, folder, settings and permission level, then delivers, re-reads the command list and tool servers, and re-baselines the spend counters; nothing is drawn. Codex sessions and a session the person runs in their own terminal are never stopped. Tests: a session with a running background shell, a background agent whose own shell still runs, a pending wake-up, a session-only job, a queued message or an open question is not slept; a message sent at the stop keeps it awake; a woken session answers on the same conversation; a frame written to a sleeping session's inbox wakes it and arrives as its message, and the inbox's name is the same before and after the sleep. **Spec coverage:** Spec-001 §Required Behavior (an idle Claude Code session sleeps) **Verifies invariant:** none

##### T6.13 — A kept session can always resume

**Files:** `packages/runtime-daemon/src/session/service.ts` **Acceptance:** a kept session can always resume, because the provider's conversation file it resumes from lives as long as the session and nothing deletes it automatically. [Plan-003](./003-provider-driver-contract-and-capabilities.md)'s driver passes `"cleanupPeriodDays": 36500` in the `--settings` of every Claude Code process the daemon starts and writes it into each account home's `settings.json` (Claude Code's own cleanup judges by file age across the whole home, and a repository's settings outrank the home's); after each spawn it reads `effective.cleanupPeriodDays` from `get_settings` and raises a `session.notice` of kind `settings_ignored` on the session when a managed policy holds it lower. Codex deletes nothing by age. The purge removes every file the provider keeps for each purged session from every account home it ran in and calls Codex's `thread/delete`, and never touches a terminal session's conversation in the person's own Codex folder. **Spec coverage:** [Spec-020](../specs/020-data-retention-and-gdpr.md) (a kept session holds its data until the person deletes it); Spec-001 §Interfaces And Contracts (`settings_ignored`) **Verifies invariant:** none

##### T6.14 — The terminal pane's overview read

**Files:** `packages/contracts/src/session/methods.ts`, `packages/runtime-daemon/src/session/service.ts` **Acceptance:** `session.overviewRead {afterRevision}` answers `{revision, sessions: [{id, title, provider, state, agents: [{name, provider, state}]}], remoteControl: {state}}` as soon as the sessions list or any session's agent list moves past `afterRevision`, or after 10 s with nothing changed, from the projections behind `session.list` (T6.2) and `agent.list`, never a second store; one held request per open pane, at most 6 answers a minute while nothing changes, each answer under 4 KB ([ADR-035](../decisions/035-claude-code-mods-are-an-optional-terminal-bridge.md)).

##### T6.15 — Groups, links and tags

**Files:** `packages/contracts/src/session/methods.ts` (the `group` member on a `session.list` entry, `groupId` on `session.create`, and the person's verbs: `session.groupCreate`, `session.groupMove`, `session.groupRename`, `session.groupUngroup`, `session.relatedList`, `session.linkAdd`, `session.linkRemove`, `session.tagAdd`, `session.tagRemove` and `session.tagList`, with the refusals `session.group_name_taken`, `session.group_refused`, `session.link_not_removable` and `session.tag_refused`), `packages/runtime-daemon/src/session/` (the groups, the links, the tags and the related-list ranking), the daemon's one schema (EXTEND — `session_groups`, the `group` column, `session_links`, `session_tags`, the stored related lists and the search index's new columns) **Acceptance:** a session is in at most one group of its project, a group's name is unique in its project ignoring case, and moving the last session out of a group leaves no empty group behind; the person moves a session into a group (`session.groupMove`, or `session.groupCreate` for `New group…`, which makes the group with that session in it), out of one (`session.groupMove` with no group), renames a group (`session.groupRename`), ungroups one (`session.groupUngroup`) and starts a new session in one (`groupId` on `session.create`), and an archived session keeps its group; the daemon writes a link at the moment its event is recorded — `started`, `copied_from`, `messaged` with its count, `asked` and `mentioned` — keyed by session id, so a rename changes none, and none of those can be removed; the person reads a session's ranked related list live (`session.relatedList`), adds a `related` link from the inspector's `Related` section through the `@` session picker (`session.linkAdd`) and removes one with `Unlink` (`session.linkRemove`, which refuses `session.link_not_removable` on every other kind), and an empty section reads `No related sessions yet` with `Link a session…`; the person adds a tag from the `Tags` line on the inspector's Identity (`session.tagAdd`), whose `Add tag` field suggests the tags in use (`session.tagList`), and removes one from its chip (`session.tagRemove`); the service refuses a tag holding a space, from the person and from an agent's `session_update` alike, with `session.tag_refused` and nothing written; tags nest with `/` and match ignoring case, and a search for `tag:billing` finds `billing/stripe`; each session's related list is personalized PageRank cut at two steps with the kind weights, use counts and 30-day halving of [Spec-001 §Groups, Links And Tags](../specs/001-session-core.md#groups-links-and-tags), stored under the session's id and re-scored in the background for the two sessions a new link joins and their neighbors; search merges the text rank and the relation rank by Reciprocal Rank Fusion and groups its results by project, group and session, each branch ordered by its best score; only settled messages are indexed, the index is merged when idle, and a prefix index serves search as the person types. Budget, measured on the daemon's own build at 10,000 sessions, 1,000,000 indexed messages, 100,000 links and 30,000 tags: a search under 50 ms at p95 and a related list under 1 ms. The agents' `session_group`, `session_update` and `session_search` call into this task's service ([Plan-013](./013-multi-agent-orchestration.md) T2.9). The screens that call these verbs are [Plan-020](./020-desktop-app-and-renderer.md) T-020r-5-5's. Tests: the group's case-insensitive uniqueness and one group per session; a tag with a space refused through both the person's verb and `session_update`, with nothing written; a link written by a fork, a start and a message, surviving a rename of both sessions and refused removal, while a `related` link unlinks; a two-step related session scored below a direct one; and the budget, measured on the seeded set. **Spec coverage:** Spec-001 §Groups, Links And Tags, AC8 **Verifies invariant:** none

##### T6.16 — The terminal bridge plugin

**Waits on:** T6.14 merged, and the daemon's session messaging and the agents projection behind `agent.list` ([Plan-013](./013-multi-agent-orchestration.md)) built.

**Files:** the terminal bridge's plugin folder, which the app ships and this task creates and names (NEW: its two function hooks and the `/sidekicks` pane); the daemon's minting of a terminal session's entry for the shared `sidekicks` server, under `packages/runtime-daemon/src/`; one more `patterns` item, naming that folder, in the existing `no-restricted-imports` rule of the `packages/runtime-daemon/src/**/*.ts` block in `eslint.config.mjs` (a second block would replace that rule's existing entries) **Acceptance:** an optional Claude Code plugin, and the daemon never depends on it ([ADR-035](../decisions/035-claude-code-mods-are-an-optional-terminal-bridge.md)). On `session.start` its hook asks the daemon for the terminal session's own daemon-minted entry for the shared `sidekicks` server, so the session holds every session tool but `session_remind`, under the same rules text as the connection's instructions; on `session.receive` with origin `peer` its hook hands a delivery the daemon did not send to the daemon first, so it is registered and drawn before the model reads it. It registers `/sidekicks`, which opens the read-only Sidekicks pane and closes it on a second press: one row per session (title, provider, state in the sessions list's words), its agents under it (name, provider mark, state in the Sidekicks pane's words) and one last row with Remote Control's state, nothing on it a control. The pane sends one held `session.overviewRead {afterRevision}` (T6.14) and on each answer keeps the rows, redraws and sends the next, so no timer runs; with the daemon unreachable it shows `The Sidekicks app isn't running.` and tries again 10 seconds later. It reaches the daemon with `$.http.fetch(url, { socketPath })`, loads only where Claude Code turns hooks modules on, works with whatever Claude Code is installed, and a failure shows in the daemon's logs. That ESLint entry refuses any import from the plugin's folder in `packages/runtime-daemon`. With the plugin absent, off or failing, `Copy address` and the peer frame read off the receiving session's stream stay the behavior. Budget: T6.14's, measured in this task's PR with 10 sessions on a live daemon, plus no work while the pane is closed. Putting the plugin into the person's Claude Code is `provider.terminalPluginUpdate` ([Plan-023](./023-provider-accounts-and-credential-homes.md) T4.4). **Tests:** on `session.receive` with origin `peer`, the hook hands a delivery the daemon did not send to the daemon before the model reads it; with the plugin absent, the peer frame on the receiving session's stream still arrives. **Spec coverage:** [Spec-014 §Sessions Talking To Each Other](../specs/014-multi-agent-orchestration.md#sessions-talking-to-each-other) **Verifies invariant:** none

##### T6.17 — A session whose provider is missing

**Files:** `packages/contracts/src/session/controls/events.ts` (the `provider_missing` notice kind beside the others), `packages/runtime-daemon/src/session/service.ts` **Acceptance:** before the daemon starts a session's provider — its first message, a resume, a restart — it checks that the provider's command is installed where the service runs, by the same check that reads `Not installed.` on Settings › Providers; where it is not, no provider process starts and the session gains one `session.notice` of kind `provider_missing` naming the provider, which the screen draws as one flow row that opens Settings › Providers on that provider's section. On a Windows computer where the place the service runs in has neither provider, the notice says so (`placeHasNeitherProvider`), and the row reads `Choose where Claude Code and Codex are installed` and opens the place row. Once the provider is installed, the next start runs it with nothing left over. Tests: a session on a provider that is not installed starts no process and appends exactly one `provider_missing` notice naming that provider; with neither provider in the place the notice carries `placeHasNeitherProvider: true`; after the command is installed the next send starts the provider. **Spec coverage:** Spec-001 §Fallback Behavior **Verifies invariant:** none

After Phase 6 lands green and the manual smoke passes, Plan-001 is complete.

## Rollout Order

1. Ship contracts and the storage schemas
2. Enable create and read behind internal feature flag
3. Enable live subscribe once rebuild is stable

## Rollback Or Fallback

- Disable the daemon's `session.create` if session creation regresses; sessions already created keep running on their machine.

## Risks And Blockers

- Event ordering mistakes between the daemon's event log and the snapshot a device rebuilds
