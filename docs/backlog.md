# Backlog

## Purpose

This file is the active development backlog for the product defined in [vision.md](./vision.md).

## How To Use This Backlog

- Add items only when they represent real remaining work.
- Link every item to the governing spec, plan, ADR, or operations doc where possible.
- Keep items outcome-oriented. A backlog item should describe a deliverable, not a vague area of concern.
- Remove or rewrite stale items instead of letting the file become a historical log.
- When work is complete, update the canonical docs it depends on first, then move the item to [Backlog Archive](./archive/backlog-archive.md).
- If information in a backlog item becomes durable product truth, move that information into the canonical docs and keep only the remaining work here.

## Status Values

- `todo`
- `in_progress`
- `blocked`
- `completed`

## Priority Values

- `P0` — blocks all implementation or blocks a critical feature
- `P1` — blocks a specific feature or must resolve before v1
- `P2` — should resolve before v1 ship

---

## Item Template

Use this shape for new backlog items:

```md
### BL-0XX: Short Title

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Relevant Spec](./specs/000-spec-template.md), [Relevant Plan](./plans/000-plan-template.md)
- Summary: One or two sentences describing the deliverable or change.
- Exit Criteria: Concrete condition that makes this item complete.
```

---

## Active Items

The seven items below were surfaced by the [plan-readiness-audit Tier 1](./operations/plan-implementation-readiness-audit-runbook.md) audit (commit `05125dc`, 2026-04-28). Each tracks a cross-cutting governance amendment that the Tier 1 plan amendments deferred via `BLOCKED-ON-CN` tags. Resolution unblocks the corresponding Tier 1 plan content for first-code-execution PRs.

### BL-101: C-3 — Plan-023 Tier-8 substrate carve-out from Tier 1

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- References: [Plan-001](./plans/001-shared-session-core.md) Phase 1 + Phase 5 (BLOCKED-ON-C3 tags), [Plan-024](./plans/024-rust-pty-sidecar.md) Phase 4 (BLOCKED-ON-C3), [Plan-023](./plans/023-desktop-shell-and-renderer.md), [cross-plan-dependencies.md §3 + §5](./architecture/cross-plan-dependencies.md)
- Summary: Plan-001 Phase 5 imports `apps/desktop/main/src/sidecar-lifecycle.ts` (Plan-023 Tier-8 CREATE-domain). Same defect class as the canonical substrate-import bug fixed by commit `a230a50` (`docs(repo): re-tier Plan-007 partial + Plan-008 carve-out to Tier 1`). Pick one resolution: (1) Plan-023 carve-out into Tier 1 mirroring Plan-007-partial / Plan-008-bootstrap pattern; (2) defer Plan-001 Phase 5 sidecar-lifecycle work to a Phase 5b at Tier 8; (3) transfer CP-001-1 ownership to Plan-023.
- Exit Criteria: Plan-001 / Plan-024 BLOCKED-ON-C3 tags resolved or replaced with carve-out citation; cross-plan-deps §3 / §5 / §2 coordinated; Plan-001 Phase 5 first-code-execution PR unblocked.

### BL-102: C-6 — `api-payload-contracts.md` forward-declared type stubs

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- References: [Plan-001](./plans/001-shared-session-core.md) Phase 2 (BLOCKED-ON-C6 ×7), [Plan-007](./plans/007-local-ipc-and-daemon-control.md) Phase 2 + Phase 3 (BLOCKED-ON-C6 ×20), [Plan-008](./plans/008-control-plane-relay-and-session-join.md) Phase 1 (BLOCKED-ON-C6 ×14), [api-payload-contracts.md](./architecture/contracts/api-payload-contracts.md)
- Summary: Multiple Tier 1 plan tasks block on `api-payload-contracts.md` stubs not yet authored: `SessionEvent` discriminated union, `protocolVersion` integer-vs-string typing, JSON-RPC method-name canonical-format registry (`session.create` vs `session/create`), `session.subscribe` daemon-transport SSE streaming shape, SSE wire frame (Content-Type, data: encoding, retry:, Last-Event-ID, heartbeat cadence). Author stubs OR sub-spec entries in `api-payload-contracts.md` Plan-007 / Plan-008 sections.
- Exit Criteria: All BLOCKED-ON-C6 working-copy tags in Plan-001 / Plan-007 / Plan-008 resolved with `api-payload-contracts.md` citation; downstream test code asserts on canonical shapes from this file; F-001-2-02, F-007p-2-01 / 03 / 3-01 / 3-02, F-008b-1-01 closed.

### BL-103: C-7 — `error-contracts.md` JSON-RPC error code registration

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Plan-007](./plans/007-local-ipc-and-daemon-control.md) Phase 2 (BLOCKED-ON-C7 ×9), [error-contracts.md](./architecture/contracts/error-contracts.md)
- Summary: Plan-007 Phase 2 JSON-RPC error model is unspecified. `error.ts` shapes are not mapped to JSON-RPC standard codes (-32700 parse error / -32600 invalid request / -32601 method not found / -32602 invalid params / -32603 internal error) plus custom domain codes (`unknown_setting`, `resource.limit_exceeded`, etc.). Register codes in `error-contracts.md`; map daemon-side error envelopes to canonical wire shapes.
- Exit Criteria: All BLOCKED-ON-C7 tags resolved with `error-contracts.md` citation; F-007p-2-02 closed; T-007p-1-4 unknown_setting test asserts on full envelope shape (not just code string).

### BL-104: C-4 — ADR-014 runtime authorization reconciliation (Cloudflare Workers vs Fastify)

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- References: [Plan-008](./plans/008-control-plane-relay-and-session-join.md) §Preconditions (BLOCKED-ON-C4 ×8), [ADR-014](./decisions/014-trpc-control-plane-api.md), [Plan-003](./plans/003-runtime-node-attach.md)
- Summary: ADR-014 authorizes Cloudflare Workers for the tRPC v11 control-plane API; Plan-008 declares Fastify host without ADR backing. Pick one resolution: (a) ADR-014 amendment authorizing Fastify v5 for Tier 1 bootstrap (with rationale tied to local-first development + dev-loop ergonomics + workerd-emulation cost); (b) Plan-008 amendment to use Cloudflare Workers + workerd local emulation for Tier 1 bootstrap; (c) ADR-NNN supersedes ADR-014 for Tier 1 bootstrap runtime selection.
- Exit Criteria: ADR-014 consistent with Plan-008's runtime declaration; every "Fastify host" reference in Plan-008 either replaced with the C-4-resolved adapter OR remains because ADR-014 amendment authorizes Fastify; Plan-003 line 79 reference updated in lockstep; F-008b-1-02 closed.

### BL-105: C-8 + C-9 — Spec-006 event registry amendments

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Plan-001](./plans/001-shared-session-core.md) Phase 2 (BLOCKED-ON-C8 ×2), [Plan-007](./plans/007-local-ipc-and-daemon-control.md) Phase 3 (BLOCKED-ON-C9 ×5), [Spec-006](./specs/006-session-event-taxonomy-and-audit-log.md)
- Summary: Spec-006 event registry needs two amendments: (1) define `MemberJoined` event semantics OR rename to `MembershipRoleChanged` (Plan-001 Phase 2 references with no source-of-truth definition); (2) register `security.default.override` and `security.update.available` events (Plan-007 Phase 3 references).
- Exit Criteria: Spec-006 §Event Registry contains canonical definitions for all three; Plan-001 / Plan-007 BLOCKED-ON-C8 / BLOCKED-ON-C9 tags resolved; F-001-2-01 closed.

### BL-106: C-5 + C-16 — Plan-024 calendar-window decoupling from `completed` status

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Plan-024](./plans/024-rust-pty-sidecar.md) Phase 5 (BLOCKED-ON-C5 ×6), [ADR-019](./decisions/019-windows-v1-tier-and-pty-sidecar.md)
- Summary: Plan-024 calendar-window completion gate (2-week monitoring) contradicts the Tier 1 promotion gate (per runbook §Status Promotion Gate). ADR-019 monitoring-window scope must clarify whether the 2-week window is a (a) substrate-promotion gate (delays `RustSidecarPtyHost` from default-on to default-on at Tier 5), or (b) plan-completion gate (delays Plan-024 status flip to `completed`). Recommended: (a). Plan-024 Phase 5 amendment + ADR-019 monitoring-window scope clarification land together.
- Exit Criteria: ADR-019 monitoring-window scope explicitly carved out from Plan-024 `completed` status; Plan-024 Phase 5 BLOCKED-ON-C5 tags resolved with ADR-019 citation; F-024-5-01 closed.

### BL-107: C-13 + C-2 — `cross-plan-dependencies.md` §3 missing edges + §2 ownership rows

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [cross-plan-dependencies.md §3](./architecture/cross-plan-dependencies.md) (rows 115 + 116), [cross-plan-dependencies.md §2](./architecture/cross-plan-dependencies.md), Plan-007 + Plan-008 dep-trace
- Summary: cross-plan-dependencies.md §3 (dependency edges) is missing rows for Plan-007 (row 115) and Plan-008 (row 116) edges to upstream Plan-001 substrate types. §2 (path ownership) lacks ownership rows for substrate dirs introduced by Plan-007-partial / Plan-008-bootstrap (`packages/runtime-daemon/src/ipc/`, `packages/control-plane/src/server/`).
- Exit Criteria: §3 rows 115 + 116 authored with typed edges; §2 substrate-dir ownership rows added; partial-plan dep-trace (D3 / D4) verifiable mechanically.

---

_Closed items live in [Backlog Archive](./archive/backlog-archive.md)._
