# Cross-Plan Dependency Graph and Ownership Map

## Purpose

Define the canonical build order, shared-resource ownership, and inter-plan dependencies so that implementation agents can execute plans in the correct sequence without discovering conflicts at build time.

## How to Use This Document

1. **Before starting any plan**: check its Dependencies row in the plan header. All listed plans must be complete.
2. **Before creating a table or directory**: check the Ownership Maps below. Only the owning plan issues `CREATE`. Dependent plans `EXTEND` with an explicit dependency declaration.
3. **Build order**: follow the Canonical Build Order (Section 5). Each tier's prerequisites are the prior tier's completion.

---

## 1. Table Ownership Map

These tables are claimed by multiple plans. The table below resolves each conflict.

| Table | Owning Plan (CREATE) | Extending Plan(s) (ALTER/USE) | Rationale |
| --- | --- | --- | --- |
| `session_memberships` | Plan-001 (Shared Session Core) | Plan-002 (Invite Membership And Presence) | Plan-001 is the session foundation; Spec-002 depends on Spec-001. Plan-001 creates the table with core columns (id, session_id, participant_id, role, state, joined_at, updated_at). Plan-002 adds invite-driven membership flows but does not own the schema. |
| `branch_contexts` | Plan-010 (Worktree Lifecycle And Execution Modes) | Plan-011 (Gitflow PR And Diff Attribution) | Plan-011 already declares Plan-010 as a dependency. Plan-010 creates the table as part of worktree infrastructure (id, worktree_id FK, base_branch, head_branch, upstream_ref, created_at, updated_at). Plan-011 extends it for PR and diff attribution. |
| `participant_keys` (SQLite) | Plan-001 (initial migration `0001-initial.sql`) | Plan-022 (schema origin and CRUD code paths) | **Forward-declared split per Plan-022 header.** Plan-022 authors the `participant_keys` schema but forward-declares the `CREATE TABLE` into Plan-001's Tier 1 migration so V1 session-core cannot ship without the GDPR crypto-envelope schema (per ADR-015 V1 scope). Plan-022's implementation code paths (store, rotation, wrap-codec) land at Tier 5. |
| `session_events.pii_payload` (SQLite column) | Plan-001 (initial migration `0001-initial.sql`) | Plan-022 (column origin; reader/writer code paths at Tier 5) | **Forward-declared split per Plan-022 header.** Plan-022 adds this BLOB column to Plan-001's `session_events` schema in the Tier 1 migration so the crypto envelope does not require a breaking schema migration after V1 ships. |
| `participants` (Postgres) | Plan-001 (initial migration `0001-initial.sql` — minimal `id UUID PK`, `created_at TIMESTAMPTZ`) | Plan-018 (Identity And Participant State — additive ALTER migrations for `display_name`, `identity_ref`, `metadata` + the `identity_mappings` side table) | **Forward-declared split per Plan-001 body line 50.** Plan-001 owns the physical CREATE of the minimal identity-anchor shape at Tier 1 because `session_memberships.participant_id`, `session_invites.inviter_id`, and `runtime_node_attachments.participant_id` all `REFERENCES participants(id)` (Plans 001/002/003 execute before Plan-018 per §5 Canonical Build Order). Plan-018 extends with identity/profile columns and the `identity_mappings` side table via additive ALTER migrations at Tier 5. |

### Uncontested Tables

All other tables have a single owning plan. See `docs/plans/NNN-*.md` Data And Storage Changes sections for canonical column definitions. The table below lists the plan responsible for each table group:

| Plan | Tables Owned |
| --- | --- |
| Plan-001 | `sessions`, `session_memberships` (Postgres); `session_events`, `session_snapshots` (SQLite) |
| Plan-002 | `session_invites` (Postgres) |
| Plan-003 | `node_capabilities`, `node_trust_state` (SQLite); `runtime_node_attachments`, `runtime_node_presence` (Postgres) |
| Plan-004 | `queue_items`, `interventions`, `command_receipts` (SQLite) |
| Plan-005 | `runtime_bindings`, `driver_capabilities` (SQLite) |
| Plan-006 | No owned tables; extends `session_events` (Plan-001) |
| Plan-008 | `session_directory`, `relay_connections` (Postgres) |
| Plan-009 | `repo_mounts`, `workspaces` (SQLite) |
| Plan-010 | `worktrees`, `ephemeral_clones`, `branch_contexts` (SQLite) |
| Plan-011 | `diff_artifacts`, `pr_preparations` (SQLite) |
| Plan-012 | `approval_requests`, `approval_resolutions`, `remembered_approval_rules` (SQLite) |
| Plan-014 | `artifact_manifests`, `artifact_payload_refs` (SQLite) |
| Plan-015 | `replay_cursors`, `recovery_checkpoints` (SQLite) |
| Plan-016 | `channels`, `run_links` (SQLite) |
| Plan-017 | `workflow_definitions`, `workflow_versions`, `workflow_runs`, `workflow_phase_states`, `phase_outputs`, `workflow_gate_resolutions`, `parallel_join_state`, `workflow_channels`, `human_phase_form_state` (SQLite; full 9-table Pass G §2 schema per Spec-017 amendment SA-24 / BL-097) |
| Plan-018 | `identity_mappings` (Postgres) |
| Plan-019 | `notification_preferences` (Postgres) |
| Plan-020 | `health_snapshots` (Postgres) |
| Plan-021 | `admin_bans`, `rate_limit_escalations` (Postgres). Does **not** own `ratelimit_*` — those are auto-created by `rate-limiter-flexible` v11.0.0 on first use per Plan-025 §Data And Storage Changes. |
| Plan-022 | No owned tables beyond the forward-declared rows in the Contested table above (participant_keys + session_events.pii_payload). |
| Plan-023 | No owned tables (desktop shell + renderer is UI only). |
| Plan-024 | No owned tables (Rust PTY sidecar is binary + contract only). |
| Plan-025 | No owned tables (self-host relay deploys Plan-008's schema; Plan-018's identity tables; Plan-021's admin_bans tables). |
| Plan-026 | No owned tables (onboarding choice state is ephemeral/IPC-only per Spec-026). |

---

## 2. Package Path Ownership Map

These directories or files are targeted by multiple plans. The owning plan creates the directory; dependent plans add files within it.

| Path | Owning Plan (CREATE) | Extending Plan(s) | Files Added by Extending Plans |
| --- | --- | --- | --- |
| `packages/control-plane/src/presence/` | Plan-002 | Plan-008, Plan-018 | Plan-008: `presence-register-service.ts`; Plan-018: `presence-aggregation-service.ts` |
| `packages/runtime-daemon/src/provider/runtime-binding-store.ts` | Plan-005 | Plan-015 | Plan-015 extends the store with recovery-aware persistence methods |
| `packages/runtime-daemon/src/artifacts/` | Plan-014 | Plan-011 | Plan-011: `diff-artifact-service.ts` |
| `packages/runtime-daemon/src/workspace/` | Plan-009 | Plan-010 | Plan-010: `execution-root-service.ts`, `execution-mode-service.ts` |
| `packages/runtime-daemon/src/workflows/` | Plan-017 (creates the subdirectory at Tier 8 per §5) | (no extenders yet) | Subdirectory follows the standard runtime-daemon ownership pattern (matches `artifacts/`, `workspace/`). Plan-017's workflow execution code paths land here; cross-plan reuse will surface extenders as adjacent plans integrate the workflow runtime. |
| `apps/desktop/renderer/` | Plan-023 (creates the React + Vite renderer app at Tier 8) | Plan-001 (`renderer/src/session-bootstrap/`), Plan-002 (`renderer/src/session-members/`), Plan-003 (`renderer/src/runtime-node-attach/`), Plan-004 (`renderer/src/run-controls/`), Plan-006 (`renderer/src/timeline/` audit-stub), Plan-007 (`renderer/src/daemon-status/`), Plan-008 (`renderer/src/session-join/`), Plan-009 (workspace/repo renderer views), Plan-010 (`renderer/src/execution-mode-picker/`), Plan-011 (`renderer/src/diff-review/`), Plan-012 (approvals renderer views), Plan-013 (`renderer/src/timeline/` live), Plan-014 (artifacts renderer views), Plan-015 (`renderer/src/recovery-status/`), Plan-016 (channels renderer views), Plan-017 (`renderer/src/workflows/`), Plan-018 (`renderer/src/participants/`), Plan-019 (notifications renderer views), Plan-020 (`renderer/src/health-and-recovery/`), Plan-026 (`renderer/src/onboarding/`) | Each extending plan adds renderer views as thin projections over the Spec-023 preload-bridge surface (`window.sidekicks`). Extending plans must not bypass the bridge to reach daemon or control-plane state directly. Tier-ordering detail: extensions land at each plan's canonical tier, but renderer-tree construction begins at Plan-023's Tier 8 — pre-Tier-8 extender plans ship non-renderer deliverables first and add the renderer subtree at Tier 8 or the plan's own tier, whichever is later. Plan-013's live timeline components land under `renderer/src/timeline/` (Plan-013's Tier 8 placement is the earliest tier at which `apps/desktop/renderer/` exists; Plan-006's audit-stub rendering folds into the same subtree). |
| `packages/contracts/src/` | No single owner — single-file-per-contract convention | Plan-024 (`pty-host.ts` precedent), Plan-021 (`rate-limiter.ts`) | The directory is a shared home for cross-plan contract files. No two plans edit the same file, so no shared-resource conflict exists. |
| `packages/contracts/src/workflows/` | Plan-017 (creates the subdirectory at Tier 8 per §5) | (no extenders yet) | First subdirectory member of `packages/contracts/src/`, diverging from the parent row's "single-file-per-contract" convention. Convention-extension call (single-file-only vs single-file-or-single-subdirectory) deferred per [BL-097 Resolution §7(d)](../backlog.md#bl-097-workflow-authoring-and-execution-v1-scope-research-and-session-m-absorption) — resolution blocked on a second subdirectory candidate surfacing in another plan. |
| `packages/crypto-paseto/` | Plan-025 (steps 1–4 first-deliverable — see Tier 5 co-dep carve-out in §5) | Plan-018 (PASETO v4.public issuer; imports this package to compile) | **Symmetric co-dep per Plan-025 §Risks And Blockers line 159.** Plan-025 formally depends on Plan-018's issuer key-publication surface, but the shared crypto primitive package must land first (from Plan-025) or Plan-018 cannot compile. Plan-025's first-four steps ship at Tier 5 alongside Plan-018; the rest of Plan-025 lands at Tier 7. |
| `packages/pty-sidecar/` + 5 platform packages (`@ai-sidekicks/pty-sidecar-{win32-x64,darwin-arm64,darwin-x64,linux-x64,linux-arm64}`) | Plan-024 | Plan-005 (consumes the `PtyHost` contract from `packages/contracts/src/pty-host.ts`) | Plan-024 publishes the umbrella + platform packages via the esbuild-precedent `optionalDependencies` + `os`/`cpu` filter pattern. Plan-005 runtime bindings import the `PtyHost` contract, not the binary directly. |

### Ownership Rule

The owning plan creates the directory structure and any shared types or base services. Extending plans add new files but must not modify files owned by the creating plan without an explicit contract (interface, type export, or extension point).

---

## 3. Inter-Plan Dependency Graph

Each dependency is annotated with its type:
- **spec-declared**: the corresponding spec explicitly lists the other spec in its Depends On field
- **implementation-derived**: the plans share tables, package paths, or cross-cutting concerns that create a build-order dependency not captured in spec Depends On
- **declared in plan header**: the dependency is declared in the target plan's header Dependencies row — not in the spec's Depends On field, and not an implementation-derived table-sharing relationship

| Plan | Dependencies | Type |
| --- | --- | --- |
| Plan-001 | None | — |
| Plan-002 | Plan-001 (session tables, membership schema) | spec-declared |
| Plan-003 | Plan-001 (session model, node attachment to sessions) | spec-declared |
| Plan-004 | Plan-001 (session core), Plan-005 (driver capability checks for steer/pause routing) | spec-declared, implementation-derived |
| Plan-005 | Plan-024 (consumes `PtyHost` contract from `packages/contracts/src/pty-host.ts` for runtime-binding provider surface) | implementation-derived |
| Plan-006 | Plan-001 (extends session_events, session_snapshots) | implementation-derived |
| Plan-007 | None | — |
| Plan-008 | Plan-001 (session core), Plan-002 (invite acceptance, presence register) | spec-declared |
| Plan-009 | None | — |
| Plan-010 | Plan-009 (workspace infrastructure) | spec-declared |
| Plan-011 | Plan-010 (worktree infrastructure), Plan-014 (artifact manifests) | declared in plan header |
| Plan-012 | None | — |
| Plan-013 | Plan-006 (event taxonomy for timeline replay) | spec-declared |
| Plan-014 | None | — |
| Plan-015 | Plan-006 (event log replay) | spec-declared |
| Plan-015 | Plan-001 (session events), Plan-004 (queue state recovery), Plan-005 (runtime binding restoration), Plan-012 (approval record recovery) | implementation-derived |
| Plan-016 | Plan-001 (session core), Plan-004 (queue/steer orchestration) | spec-declared |
| Plan-017 | Plan-006 (event taxonomy, integrity protocol), Plan-012 (approval records, Cedar policy), Plan-014 (artifact manifests, OWASP upload), Plan-015 (recovery, writer worker, replay), Plan-016 (channel lifecycle), Plan-004 (queue/steer) | spec-declared |
| Plan-018 | Plan-002 (presence infrastructure) | spec-declared |
| Plan-018 | Plan-025 (symmetric co-dep on `packages/crypto-paseto/` — Plan-025's first-deliverable must land before Plan-018 can compile; see §2 row and Tier 5 co-dep carve-out) | implementation-derived |
| Plan-019 | Plan-013 (timeline visibility) | spec-declared |
| Plan-020 | Plan-015 (persistence layer) | spec-declared |
| Plan-021 | Plan-008 (relay + control-plane tRPC surface — middleware wired here), Plan-018 (PASETO v4.public tokens for admin endpoints), Plan-007 (scope **exclusion** — daemon IPC is not rate-limited; confirmed non-dep) | declared in plan header |
| Plan-022 | Plan-001 (forward-declares `participant_keys` + `session_events.pii_payload` into Plan-001's `0001-initial.sql` per §1 Contested rows), Plan-007 (local daemon IPC host for 501 GDPR stub routes) | declared in plan header |
| Plan-023 | Plan-007 (daemon supervised via `utilityProcess.fork`), Plan-018 (PASETO access/refresh tokens forwarded by main process), Plan-008 (control-plane tRPC/WebSocket transport), Plan-024 (PTY sidecar supervised by daemon — not by this shell; non-dep documented) | declared in plan header |
| Plan-024 | None (upstream of Plan-005 via `PtyHost` contract in `packages/contracts/src/pty-host.ts`) | — |
| Plan-025 | Plan-008 (v2 relay wire protocol — deployed, not re-implemented), Plan-018 (PASETO key publication — see symmetric co-dep note in §2), Plan-021 (`RateLimiter` contract + `PostgresRateLimiter` + `AdminBansStore` — instantiated, not re-implemented) | declared in plan header |
| Plan-026 | Plan-023 (preload-bridge `onboarding.*` namespace), Plan-007 (five new `Onboarding*` IPC methods), Plan-025 (Option 2 TOFU probe target), Plan-008 (Option 3 hosted-SaaS redirect), Plan-006 (`onboarding.choice_made`/`choice_reset` event registration via BL-086) | declared in plan header |

### Dependency Diagram

```
Plan-001 ──────┬──────────────────────────────────────────┐
               │                                          │
          Plan-002 ──── Plan-008                     Plan-003
               │              │
          Plan-018        (relay)
               │
          (presence)

Plan-005 ──────┬──────────────────────────────────────────┐
               │                                          │
          Plan-004 ──── Plan-016 ──── Plan-017       Plan-015
               │                                     ▲   ▲
               └─────────────────────────────────────┘   │
                                                          │
Plan-006 ──── Plan-013 ──── Plan-019                     │
   │                                                      │
   └──────────────────────────────────────────────────────┘

Plan-009 ──── Plan-010 ──── Plan-011
Plan-014 ──── Plan-011

Plan-012 ──── Plan-015

Plan-007 (standalone)

Plan-015 ──── Plan-020

Plan-024 (standalone) ──── Plan-005 (via PtyHost contract)

Plan-001 ──── Plan-022 (forward-declared schema)
Plan-007 ──── Plan-022

Plan-008 ──┬─── Plan-021 ───┐
           │                │
Plan-018 ──┘                ▼
Plan-025 ◀═══ symmetric co-dep on packages/crypto-paseto/ ═══▶ Plan-018
Plan-025 ──── Plan-026

Plan-007 ──┐
Plan-018 ──┤
Plan-008 ──┼──── Plan-023 ──── Plan-026
Plan-024 ──┘                   ▲
                               │
Plan-006, Plan-008, Plan-025 ──┘
```

---

## 4. Plans With No Inter-Plan Dependencies

These plans depend only on domain models and architecture docs, not on other plans. They can begin as early as their tier in the build order allows.

| Plan | Why Standalone |
| --- | --- |
| Plan-001 | Session foundation — everything depends on this |
| Plan-007 | Local IPC — daemon control surface, no shared tables |
| Plan-009 | Workspace binding — repo/workspace model, no shared tables with earlier plans |
| Plan-012 | Approvals/permissions — approval model is self-contained |
| Plan-014 | Artifacts — artifact model is self-contained |
| Plan-024 | Rust PTY sidecar — binary + `PtyHost` contract only; upstream of Plan-005 via the contract file, no inter-plan dependency in the other direction |

---

## 5. Canonical Build Order

Implementation must follow this tier sequence. Plans in a tier can generally run in parallel, but some tiers contain intra-tier ordering noted in the Prerequisites column. All plans in a tier must complete before the next tier begins.

V1 scope is 17 features per [ADR-015: V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md) (amended 2026-04-22 per BL-097 — workflow V1.1→V1). All tiers below are the V1 tier set. Plans outside the V1 set are listed in the V1.1+ subsection after this table.

| Tier | Plans | Prerequisites | Shared Resources to Coordinate |
| --- | --- | --- | --- |
| **1** | Plan-001, Plan-024 | None | Plan-001 creates `sessions`, `session_memberships`, `session_events` (with forward-declared `pii_payload` column per §1 Contested), `session_snapshots`, and the `participant_keys` table (forward-declared per §1 Contested). Plan-024 publishes the `packages/pty-sidecar/` umbrella + 5 platform packages and the `packages/contracts/src/pty-host.ts` contract; upstream of Plan-005. |
| **2** | Plan-002 | Plan-001 complete | Extends `session_memberships`; creates `presence/` directory |
| **3** | Plan-003 | Plan-001 complete | Creates `runtime_node_attachments`, `runtime_node_presence` (Postgres) per `docs/architecture/schemas/shared-postgres-schema.md` |
| **4** | Plan-005, Plan-006, Plan-007 | Tier 1 complete (Plan-005 consumes `PtyHost` contract from Plan-024; Plan-006 needs Plan-001 tables; Plan-007 is standalone) | Plan-005 creates `runtime-binding-store.ts`; Plan-006 creates `timeline/` directory and extends `session_events` |
| **5** | Plan-004, Plan-008, Plan-018, Plan-022, Plan-025 (steps 1–4 only — see co-dep carve-out below) | Plan-004 needs Plan-001 + Plan-005; Plan-008 needs Plan-001 + Plan-002; Plan-018 needs Plan-002 and `packages/crypto-paseto/` (from Plan-025 first-deliverable); Plan-022 needs Plan-001 + Plan-007 (implementation code paths; schema already forward-declared in Tier 1) | Plan-004 creates `queue_items`, `interventions`; Plan-008 extends `presence/`; Plan-018 extends `presence/`; Plan-025's first-deliverable publishes `packages/crypto-paseto/` that Plan-018 imports (see §2 co-dep row) |
| **6** | Plan-009, Plan-010, Plan-012, Plan-016, Plan-021 | Plan-009 is standalone; Plan-010 needs Plan-009; Plan-012 is standalone; Plan-016 needs Plan-001 + Plan-004 (**V1 feature #16 Multi-Agent Channels per ADR-015**); Plan-021 needs Plan-008 + Plan-018 + Plan-007 (scope exclusion) | Plan-009 creates `workspace/` directory; Plan-010 extends `workspace/` and creates `branch_contexts`; Plan-021 creates `admin_bans`, `rate_limit_escalations` + `packages/contracts/src/rate-limiter.ts` |
| **7** | Plan-011, Plan-014, Plan-015, Plan-025 (remaining steps) | Plan-011 needs Plan-010 + Plan-014; Plan-014 is standalone; Plan-015 needs Plans 001, 004, 005, 006, 012; Plan-025 remainder needs Plan-008 + Plan-018 + Plan-021 all complete | Plan-014 creates `artifacts/` directory; Plan-011 extends `artifacts/` and `branch_contexts`; Plan-025 publishes `packages/node-relay/` and the `docker-compose.yml` + operator runbook |
| **8** | Plan-013, Plan-017, Plan-019, Plan-020, Plan-023 | Plan-013 needs Plan-006; Plan-017 needs Plan-006 + Plan-012 + Plan-014 + Plan-015 + Plan-016 + Plan-004 (all Tier 4–7 deps resolved by Tier 7 end); Plan-019 needs Plan-013; Plan-020 needs Plan-015; Plan-023 needs Plan-007 + Plan-018 + Plan-008 + Plan-024 | Plan-013 extends `timeline/`; Plan-017 creates 9-table workflow schema (see §1) + `packages/contracts/src/workflows/` and `packages/runtime-daemon/src/workflows/`; Plan-017 also extends `apps/desktop/renderer/` per §2 (workflow renderer subtree at `src/workflows/`); Plan-023 creates `apps/desktop/` (main + preload + `apps/desktop/renderer/`) — see §2 for the renderer subtree ownership map |
| **9** | Plan-026 | Plan-026 needs Plan-023 + Plan-007 + Plan-025 + Plan-008 + Plan-006 | Plan-026 adds the `onboarding.*` namespace to the Spec-023 preload bridge, five `Onboarding*` IPC methods to Plan-007's JSON-RPC surface, and registers `onboarding.choice_made`/`choice_reset` in Plan-006's taxonomy (via BL-086) |

### Plan-025 / Plan-018 Symmetric Co-Dep Carve-Out (Tier 5)

Plan-025's `Dependencies` header declares Plan-018 as a dependency (PASETO issuer key publication), but Plan-018 cannot compile without `packages/crypto-paseto/` which Plan-025 owns (Plan-025 §Risks And Blockers line 159). Resolution: Plan-025 steps 1–4 — create `packages/crypto-paseto/` exporting the PASETO v4.public `sign`, `verify`, and key-management primitives (built on `@noble/curves` Ed25519 + `@noble/ciphers`, plus the PASETO RFC conformance vector test suite per Plan-025 line 23) — land at Tier 5 alongside Plan-018. The rest of Plan-025 (Fastify surface, `docker-compose.yml`, operator runbook) waits for Tier 7 after Plan-021 is ready to instantiate. This is the only tier-straddling plan in V1. Plan-018's header must cite "Plan-025 steps 1–4 at Tier 5" as a dependency for `packages/crypto-paseto/`; header-alignment propagation is BL-055 scope.

### V1.1+ Plans (Out Of V1 Tier Set)

Plans below are not part of V1 per ADR-015 and are **not** placed in the numbered tier sequence above. Their tier placement will be decided at V1.1 plan-authoring time, against the then-current V1 build state.

No plans currently deferred to V1.1+ tier set. (Plan-017 was promoted to V1 per [ADR-015 Amendment 2026-04-22](../decisions/015-v1-feature-scope-definition.md#amendment-history) / BL-097; placed at Tier 8 above.)

### Spec-024 (V1 Gap — Implementation Plan Pending)

[Spec-024: Cross-Node Dispatch And Approval](../specs/024-cross-node-dispatch-and-approval.md) is **V1 scope**, recorded here per BL-054 exit criteria as an implicit dependency of Plan-002, Plan-003, Plan-008, and Plan-012 (the V1 plans whose runtime surface Spec-024 governs at cross-node boundaries). Spec-024 depends on Spec-003 and Spec-012, which map to Plan-003 and Plan-012 — **the dependency direction is Spec-024 → Plan-003/012, not the reverse.** Plan-003 and Plan-012 do **not** pick up new work from Spec-024.

**Open V1 Gap (carried past BL-077):** Spec-024 has no implementation plan. The spec header carries an Implementation-Plan annotation explicitly recording this gap and back-pointing to this section ([Spec-024:11](../specs/024-cross-node-dispatch-and-approval.md)). BL-077 (Session F, 2026-04-19) ran without resolving this gap — Plans 002/003/008/012 were flipped to `approved` without Spec-024 Dependencies citations. The remaining resolution paths are (a) file a dedicated plan-authoring backlog item to own the `cross_node_dispatch_approvals` table per [Spec-024 §State And Data Implications](../specs/024-cross-node-dispatch-and-approval.md#state-and-data-implications) (target plan number TBD — the `024` slot is taken by the Rust PTY Sidecar plan), or (b) incorporate Spec-024 Dependencies into the relevant plan headers as a follow-up pass (Session H-interim audit introduces this patch at C12). When the plan is authored, this document must be updated with its tier placement, its `cross_node_dispatch_approvals` table ownership row in §1, and any package-path ownership it introduces.

### Optimization Notes

- Plan-003 (Tier 3) depends only on Plan-001. It could move to Tier 2 alongside Plan-002 if parallelism is desired.
- Plan-012 (Tier 6) and Plan-014 (Tier 7) have no inter-plan dependencies. They could move to earlier tiers. Their current placement is conservative.
- Within Tier 6, Plan-010 depends on Plan-009. If Plan-009 finishes before Plan-012, Plan-010 can start immediately without waiting for Plan-012.
- Plan-024 (Tier 1) has no inter-plan deps and could land at any point before Plan-005 begins; placed at Tier 1 to document the standalone status explicitly.

---

## 6. Maintenance

When adding a new plan:
1. Check the Dependency Graph (Section 3) for any shared tables or package paths with existing plans.
2. Add the plan to the Table Ownership Map (Section 1) if it creates or extends a shared table.
3. Add the plan to the Package Path Ownership Map (Section 2) if it creates or extends a shared directory.
4. Add the plan to the Build Order (Section 5) in the earliest tier where all its dependencies are satisfied.
5. Update the plan's header with a `Dependencies` row listing all inter-plan dependencies.

### Forward-Declared Table Migration Ownership

Schema-first plans (e.g., Plan-022 forward-declaring `participant_keys` and `session_events.pii_payload` onto Plan-001's `0001-initial.sql`) retain authoring ownership of post-V1 migrations against the forward-declared surface. The §1 Contested rows encode this split: Plan-001 appears as "Owning Plan (CREATE)" because it ships the Tier 1 initial DDL, and Plan-022 appears as "Extending Plan(s) (ALTER/USE)" because it originated the schema and therefore owns all subsequent `ALTER TABLE` work. Plan-001 must not author post-V1 migrations against `participant_keys` or `session_events.pii_payload`; that responsibility stays with Plan-022.
