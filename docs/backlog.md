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

The items below were surfaced by the [plan-readiness-audit Tier 1](./operations/plan-implementation-readiness-audit-runbook.md) audit (commit `05125dc`, 2026-04-28). Each tracks a cross-cutting governance amendment that the Tier 1 plan amendments deferred via `BLOCKED-ON-CN` tags. Resolution unblocks the corresponding Tier 1 plan content for first-code-execution PRs. BL-104 (C-4 — ADR-014 runtime authorization reconciliation) resolved 2026-04-30 and archived. BL-101 (C-3 — Plan-023 Tier-8 substrate carve-out from Tier 1) resolved 2026-04-30 via path (1) Plan-023 Tier 1 Partial carve-out and archived.

### BL-102: C-6 — `api-payload-contracts.md` forward-declared type stubs

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- References: [Plan-001](./plans/001-shared-session-core.md) Phase 2 (BLOCKED-ON-C6 ×7), [Plan-007](./plans/007-local-ipc-and-daemon-control.md) Phase 2 + Phase 3 (BLOCKED-ON-C6 ×20), [Plan-008](./plans/008-control-plane-relay-and-session-join.md) Phase 1 (BLOCKED-ON-C6 ×14), [api-payload-contracts.md](./architecture/contracts/api-payload-contracts.md)
- Summary: One Tier 1 plan task remains blocked on `api-payload-contracts.md` stubs not yet authored: cross-tier `SessionEvent` discriminated-union wire-form mirror — the canonical type already lives in `packages/contracts/src/event.ts` as a Zod-validated `z.discriminatedUnion("type", [...])`; whether it needs a wire-form mirror in this contracts file is a separate decision. Sub-items closed via partials: `protocolVersion` integer-vs-string typing + `session.subscribe` daemon-transport SSE streaming shape + SSE wire frame (Content-Type, data: encoding, retry:, Last-Event-ID, heartbeat cadence) closed via api-payload-contracts.md §Tier 1 (cont.): Plan-008 (PR #22, 2026-04-30); JSON-RPC method-name canonical-format registry (`session.create` vs `session/create`) closed via api-payload-contracts.md §Tier 1 (cont.): Plan-007 (2026-04-30).
- Exit Criteria: All BLOCKED-ON-C6 working-copy tags in Plan-001 / Plan-007 / Plan-008 resolved with `api-payload-contracts.md` citation; downstream test code asserts on canonical shapes from this file; F-001-2-02, F-007p-2-01 / 03 / 3-01 / 3-02, F-008b-1-01 closed.

### BL-103: C-7 — `error-contracts.md` JSON-RPC error code registration

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Plan-007](./plans/007-local-ipc-and-daemon-control.md) Phase 2 (BLOCKED-ON-C7 ×9), [error-contracts.md](./architecture/contracts/error-contracts.md)
- Summary: Plan-007 Phase 2 JSON-RPC error model is unspecified. `error.ts` shapes are not mapped to JSON-RPC standard codes (-32700 parse error / -32600 invalid request / -32601 method not found / -32602 invalid params / -32603 internal error) plus custom domain codes (`unknown_setting`, `resource.limit_exceeded`, etc.). Register codes in `error-contracts.md`; map daemon-side error envelopes to canonical wire shapes.
- Exit Criteria: All BLOCKED-ON-C7 tags resolved with `error-contracts.md` citation; F-007p-2-02 closed; T-007p-1-4 unknown_setting test asserts on full envelope shape (not just code string).

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

### BL-108: Plan-024 Windows + macOS signing procurement evidence

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [Plan-024](./plans/024-rust-pty-sidecar.md) §Preconditions + Phase 4 (T-024-4-3), [ADR-019](./decisions/019-windows-v1-tier-and-pty-sidecar.md) §Decision item 8, [ADR-023](./decisions/023-v1-ci-cd-and-release-automation.md) §Axis 5, [Spec-023](./specs/023-desktop-shell-and-renderer.md) §macOS
- Summary: Procurement evidence record for Plan-024 signing-identity gates (per F-024-4-06). Four artifacts: (a) Microsoft eligibility-determination response (Track A) OR vendor procurement contract + token-shipment confirmation (Track B); (b) signing-identity attestation matching Spec-023's Electron shell per ADR-019 §Decision item 8 + ADR-023 §Axis 5; (c) Plan-024 §Decision Log entry naming the chosen track + date; (d) macOS Developer ID Application certificate procurement evidence (cert thumbprint + team-ID + Apple Developer enrollment-confirmation email).
- Exit Criteria: All four artifacts attached; Plan-024 §Decision Log records the Windows signing-track choice + date; Plan-024 Phase 4 Preconditions row flips checked.

---

_Closed items live in [Backlog Archive](./archive/backlog-archive.md)._
