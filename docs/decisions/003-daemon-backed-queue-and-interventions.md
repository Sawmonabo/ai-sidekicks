# ADR-003: Daemon Backed Queue And Interventions

| Field | Value |
| -------------- | ------------------------------------------------------------------------ |
| **Status** | `accepted` |
| **Type** | `Type 2 (one-way door)` |
| **Domain** | `Runtime Control` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Reviewers** | `Accepted 2026-04-15` |

## Context

The product needs queue, steer, pause, resume, and interrupt semantics that survive reconnect, restart, and multiple clients observing the same session. Benchmark evidence shows that client-local queue state and UI-defined pause semantics are not sufficient.

## Problem Statement

Where should queue and intervention state live, and what authority should define their outcomes?

### Trigger

Spec `004-queue-steer-pause-resume.md` requires durable semantics for queued work and active-run control.

## Decision

We will store queue state and intervention state in daemon-backed durable runtime storage, and the daemon will be the authority that applies and records their outcomes.

### Thesis — Why This Option

Queue items and interventions change runtime truth. They must survive client restarts, transport loss, and multi-client observation. A daemon-backed model makes them durable, auditable, and consistent with the run state machine.

### Antithesis — The Strongest Case Against

Client-side queueing is simpler and faster to ship. Provider-native queueing could reduce local complexity. A daemon-backed scheduler adds persistence, replay, and concurrency concerns to the runtime.

### Synthesis — Why It Still Holds

Client-side queueing fails the durability and shared-observation requirements outright. Provider-native queueing cannot be relied on uniformly across drivers and does not model cross-driver interventions cleanly. The added daemon complexity is justified because queue and intervention semantics are part of the product, not just transport convenience.

## Alternatives Considered

### Option A: Daemon-Backed Queue And Interventions (Chosen)

- **What:** Persist queue items and intervention records in the local runtime authority.
- **Steel man:** Durable, replayable, and consistent with authoritative run state.
- **Weaknesses:** Requires scheduler persistence and concurrency control.

### Option B: Client-Side Queue (Rejected)

- **What:** Store queued follow-ups in the client and flush them later.
- **Steel man:** Simple implementation and fast feedback.
- **Why rejected:** Breaks on reconnect, restart, and multi-client observation; cannot define real pause or intervention semantics safely.

### Option C: Provider-Native Queue Only (Rejected)

- **What:** Delegate queue semantics entirely to provider-specific runtimes.
- **Steel man:** Reuses provider behavior and reduces local scheduling work.
- **Why rejected:** Capability coverage is inconsistent and provider-native queue models do not satisfy cross-driver product semantics.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
|---|-----------|----------|----------------------|
| 1 | Queue and intervention state must survive client restart. | Required by recovery and shared-session goals. | Client-local queue might be enough. |
| 2 | Drivers will not provide one uniform queue or pause model. | The queue spec and run-state model require canonical runtime-owned semantics with explicit degraded outcomes when providers cannot match them. | Provider-native queue could be the main authority. |
| 3 | The Local Runtime Daemon is the right enforcement point for run truth. | Existing architecture keeps execution local and authoritative there. | Another service would need to become the scheduler of record. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
|----------|-----------|--------|-----------|------------|
| Queue persistence is unavailable | Low | High | Queue creation fails and runtime health degrades | Block new queued work explicitly and expose repair state |
| Concurrent clients race on the same queue | Med | Med | Duplicate or conflicting intervention outcomes appear | Use daemon-owned receipts and serialized queue mutation |
| Intervention outcome is hidden from UI | Med | Med | Timeline and run state diverge from operator expectation | Make intervention results canonical events |

## Reversibility Assessment

- **Reversal cost:** High. It changes runtime truth, persistence, replay, and UI semantics.
- **Blast radius:** Queue UI, run engine, recovery, approvals, and timeline.
- **Migration path:** Would require moving queue truth to a different authority and reconciling outstanding queue items and interventions.
- **Point of no return:** After queue items and interventions are persisted as part of canonical runtime state.

## Consequences

### Positive

- Durable queue and intervention semantics
- Consistent run control across reconnect and restart

### Negative (accepted trade-offs)

- More scheduler and persistence complexity in the Local Runtime Daemon
- Higher need for good replay and idempotency design

### Unknowns

- How much prioritization and reordering logic is needed beyond FIFO in early versions

## Decision Validation

### Pre-Implementation Checklist

- [ ] All unvalidated assumptions have a validation plan
- [x] At least one alternative was seriously considered and steel-manned
- [ ] Antithesis was reviewed by someone other than the author
- [x] Failure modes have detection mechanisms
- [x] Point of no return is identified and communicated to the team

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
|--------|--------|--------------------|------------|
| Queue state survives daemon restart | 100% of persisted queue items | Recovery test suite | `2026-04-14` |
| Intervention outcomes are visible in canonical history | 100% of accepted or rejected interventions | Audit log review | `2026-04-14` |

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
|--------|------|-------------|--------------|
| `specs/004-queue-steer-pause-resume.md` | Canonical spec | Queue and intervention state belongs to runtime truth | [specs/004-queue-steer-pause-resume.md](../specs/004-queue-steer-pause-resume.md) |
| `domain/queue-and-intervention-model.md` | Canonical domain doc | Queue items and interventions are durable runtime-controlled records rather than client-local state | [domain/queue-and-intervention-model.md](../domain/queue-and-intervention-model.md) |
| `architecture/component-architecture-local-daemon.md` | Canonical architecture doc | Daemon is the local execution authority | [architecture/component-architecture-local-daemon.md](../architecture/component-architecture-local-daemon.md) |

### Related Domain Docs

- [Queue And Intervention Model](../domain/queue-and-intervention-model.md)
- [Run State Machine](../domain/run-state-machine.md)
- [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md)

### Related Architecture Docs

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Observability Architecture](../architecture/observability-architecture.md)

### Related Specs

- [Queue Steer Pause Resume](../specs/004-queue-steer-pause-resume.md)
- [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md)
- [Observability And Failure Recovery](../specs/020-observability-and-failure-recovery.md)

### Related ADRs

- [Local Execution Shared Control Plane](./002-local-execution-shared-control-plane.md)
- [SQLite Local State And Postgres Control Plane](./004-sqlite-local-state-and-postgres-control-plane.md)

## Decision Log

| Date | Event | Notes |
|------|-------|-------|
| 2026-04-14 | Proposed | Initial draft |
| 2026-04-14 | Re-baselined | Reviewer assignment and acceptance validation remain incomplete |
| 2026-04-15 | Accepted | ADR accepted |
