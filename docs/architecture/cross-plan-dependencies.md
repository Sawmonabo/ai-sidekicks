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
| Plan-017 | `workflow_definitions`, `workflow_versions`, `workflow_runs`, `workflow_phase_states` (SQLite) |
| Plan-018 | `participants`, `identity_mappings` (Postgres) |
| Plan-019 | `notification_preferences` (Postgres) |
| Plan-020 | `health_snapshots` (Postgres) |
| Spec-022 | `participant_keys` (SQLite) |

---

## 2. Package Path Ownership Map

These directories or files are targeted by multiple plans. The owning plan creates the directory; dependent plans add files within it.

| Path | Owning Plan (CREATE) | Extending Plan(s) | Files Added by Extending Plans |
| --- | --- | --- | --- |
| `packages/control-plane/src/presence/` | Plan-002 | Plan-008, Plan-018 | Plan-008: `presence-register-service.ts`; Plan-018: `presence-aggregation-service.ts` |
| `packages/runtime-daemon/src/provider/runtime-binding-store.ts` | Plan-005 | Plan-015 | Plan-015 extends the store with recovery-aware persistence methods |
| `packages/runtime-daemon/src/artifacts/` | Plan-014 | Plan-011 | Plan-011: `diff-artifact-service.ts` |
| `packages/runtime-daemon/src/workspace/` | Plan-009 | Plan-010 | Plan-010: `execution-root-service.ts`, `execution-mode-service.ts` |
| `apps/desktop/renderer/src/timeline/` | Plan-006 | Plan-013 | Plan-013: live timeline rendering components (row renderers, streaming hooks) |

### Ownership Rule

The owning plan creates the directory structure and any shared types or base services. Extending plans add new files but must not modify files owned by the creating plan without an explicit contract (interface, type export, or extension point).

---

## 3. Inter-Plan Dependency Graph

Each dependency is annotated with its type:
- **spec-declared**: the corresponding spec explicitly lists the other spec in its Depends On field
- **implementation-derived**: the plans share tables, package paths, or cross-cutting concerns that create a build-order dependency not captured in spec Depends On

| Plan | Dependencies | Type |
| --- | --- | --- |
| Plan-001 | None | — |
| Plan-002 | Plan-001 (session tables, membership schema) | spec-declared |
| Plan-003 | Plan-001 (session model, node attachment to sessions) | spec-declared |
| Plan-004 | Plan-001 (session core), Plan-005 (driver capability checks for steer/pause routing) | spec-declared, implementation-derived |
| Plan-005 | None | — |
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
| Plan-017 | Plan-016 (orchestration routing), Plan-004 (queue/steer) | spec-declared |
| Plan-018 | Plan-002 (presence infrastructure) | spec-declared |
| Plan-019 | Plan-013 (timeline visibility) | spec-declared |
| Plan-020 | Plan-015 (persistence layer) | spec-declared |

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
```

---

## 4. Plans With No Inter-Plan Dependencies

These plans depend only on domain models and architecture docs, not on other plans. They can begin as early as their tier in the build order allows.

| Plan | Why Standalone |
| --- | --- |
| Plan-001 | Session foundation — everything depends on this |
| Plan-005 | Driver contract — defines capability interface independently |
| Plan-007 | Local IPC — daemon control surface, no shared tables |
| Plan-009 | Workspace binding — repo/workspace model, no shared tables with earlier plans |
| Plan-012 | Approvals/permissions — approval model is self-contained |
| Plan-014 | Artifacts — artifact model is self-contained |

---

## 5. Canonical Build Order

Implementation must follow this tier sequence. Plans in a tier can generally run in parallel, but some tiers contain intra-tier ordering noted in the Prerequisites column. All plans in a tier must complete before the next tier begins.

| Tier | Plans | Prerequisites | Shared Resources to Coordinate |
| --- | --- | --- | --- |
| **1** | Plan-001 | None | Creates `sessions`, `session_memberships`, `session_events`, `session_snapshots` |
| **2** | Plan-002 | Plan-001 complete | Extends `session_memberships`; creates `presence/` directory |
| **3** | Plan-003 | Plan-001 complete | Creates `runtime_nodes`, `node_attachments` |
| **4** | Plan-005, Plan-006, Plan-007 | Tier 1 complete (Plan-006 needs Plan-001 tables; Plan-005 and Plan-007 are standalone) | Plan-005 creates `runtime-binding-store.ts`; Plan-006 creates `timeline/` directory and extends `session_events` |
| **5** | Plan-004, Plan-008, Plan-018 | Plan-004 needs Plan-001 + Plan-005; Plan-008 needs Plan-001 + Plan-002; Plan-018 needs Plan-002 | Plan-004 creates `queue_items`, `intervention_records`; Plan-008 extends `presence/`; Plan-018 extends `presence/` |
| **6** | Plan-009, Plan-010, Plan-012 | Plan-009 is standalone; Plan-010 needs Plan-009; Plan-012 is standalone | Plan-009 creates `workspace/` directory; Plan-010 extends `workspace/` and creates `branch_contexts` |
| **7** | Plan-011, Plan-014, Plan-015 | Plan-011 needs Plan-010 + Plan-014; Plan-014 is standalone; Plan-015 needs Plans 001, 004, 005, 006, 012 | Plan-014 creates `artifacts/` directory; Plan-011 extends `artifacts/` and `branch_contexts` |
| **8** | Plan-013, Plan-019, Plan-020 | Plan-013 needs Plan-006; Plan-019 needs Plan-013; Plan-020 needs Plan-015 | Plan-013 extends `timeline/` |
| **9** | Plan-016, Plan-017 | Plan-016 needs Plan-001 + Plan-004; Plan-017 needs Plan-016 + Plan-004 | None |

### Optimization Notes

- Plan-003 (Tier 3) depends only on Plan-001. It could move to Tier 2 alongside Plan-002 if parallelism is desired.
- Plan-012 (Tier 6) and Plan-014 (Tier 7) have no inter-plan dependencies. They could move to earlier tiers. Their current placement is conservative.
- Within Tier 6, Plan-010 depends on Plan-009. If Plan-009 finishes before Plan-012, Plan-010 can start immediately without waiting for Plan-012.

---

## 6. Maintenance

When adding a new plan:
1. Check the Dependency Graph (Section 3) for any shared tables or package paths with existing plans.
2. Add the plan to the Table Ownership Map (Section 1) if it creates or extends a shared table.
3. Add the plan to the Package Path Ownership Map (Section 2) if it creates or extends a shared directory.
4. Add the plan to the Build Order (Section 5) in the earliest tier where all its dependencies are satisfied.
5. Update the plan's header with a `Dependencies` row listing all inter-plan dependencies.
