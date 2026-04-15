# ADR-005: Provider Drivers Use A Normalized Interface

| Field | Value |
| -------------- | ------------------------------------------------------------------------ |
| **Status** | `accepted` |
| **Type** | `Type 2 (one-way door)` |
| **Domain** | `Provider Architecture` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Reviewers** | `Accepted 2026-04-15` |

## Context

The product must support multiple providers, multiple local runtime nodes, and consistent run semantics across them. Providers differ materially in transport, lifecycle, permissions, and persistence. If those differences leak into the core runtime, session and run semantics will drift by provider.

## Problem Statement

How should the core runtime interact with provider-specific execution runtimes?

### Trigger

Provider capability and recovery behavior are foundational to Local Runtime Daemon architecture and the shared run model.

## Decision

We will require every provider integration to implement a normalized driver interface with explicit capability advertisement.

### Thesis — Why This Option

A normalized driver boundary keeps session, run, queue, approval, and artifact semantics provider-agnostic. It also makes recovery and capability-aware control surfaces possible without scattering provider-name branches across the product.

### Antithesis — The Strongest Case Against

Abstraction can leak. Provider-specific features often arrive faster than normalized contracts can evolve, and building to one provider first could get the product to market faster. A normalized interface might either become too generic or too brittle.

### Synthesis — Why It Still Holds

Leaky abstraction is a manageable risk if the driver contract is intentionally small and capability-based. Waiting to abstract until later would bake provider-specific assumptions into session, run, and UI semantics, making later extraction far more expensive. Capability flags let the runtime expose product behavior honestly even when providers differ.

## Alternatives Considered

### Option A: Normalized Driver Interface (Chosen)

- **What:** Use a provider driver contract with lifecycle methods, normalized events, and capability flags.
- **Steel man:** Keeps core runtime semantics stable and multi-provider by design.
- **Weaknesses:** Requires thoughtful contract design and evolution.

### Option B: Provider-Specific Branching In Core Runtime (Rejected)

- **What:** Let the session engine and UI branch directly on provider behavior.
- **Steel man:** Faster access to provider-specific features and fewer adapter layers.
- **Why rejected:** Pollutes core runtime semantics and makes multi-provider correctness much harder.

### Option C: Single-Provider-First Architecture (Rejected)

- **What:** Build deeply around one provider and abstract later.
- **Steel man:** Fastest route to an initial product.
- **Why rejected:** Contradicts the product goal of Codex and Claude support first and raises reversal cost sharply.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
|---|-----------|----------|----------------------|
| 1 | Providers differ materially enough that the product must not expose provider-native semantics as core runtime truth. | The provider-driver spec requires normalized driver contracts and capability-aware control exposure at the daemon edge. | A thinner abstraction might be enough. |
| 2 | Session and run semantics must remain provider-agnostic. | Core domain and specs depend on stable shared vocabulary. | UI and runtime could become provider-specialized. |
| 3 | Capability flags can honestly model the differences users need to see. | Spec `005` already frames feature exposure around capability checks. | The contract may need more provider-specific escape hatches. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
|----------|-----------|--------|-----------|------------|
| Driver abstraction becomes too generic and blocks useful provider features | Med | Med | Feature work repeatedly needs driver bypasses | Add capability extensions and diagnostic side channels without breaking core semantics |
| Provider-native behavior leaks into session engine anyway | Med | High | Provider-name branches appear in core code and docs | Enforce adapter-only normalization boundary in review |
| Capability declarations become stale or inaccurate | Med | Med | UI offers unsupported controls or hides valid ones | Refresh capabilities on attach and capability-change events |

## Reversibility Assessment

- **Reversal cost:** High. It would affect daemon architecture, recovery, capabilities, and UI controls.
- **Blast radius:** Provider drivers, session engine, control surfaces, recovery, and tests.
- **Migration path:** Introduce provider-specific control paths and gradually unwind normalized contract usage.
- **Point of no return:** After multiple providers and control surfaces rely on the normalized interface.

## Consequences

### Positive

- Stable multi-provider runtime model
- Capability-aware control surfaces and recovery behavior

### Negative (accepted trade-offs)

- More adapter code and contract maintenance
- Occasional lag in exposing provider-specific features through the normalized model

### Unknowns

- How often the contract will need versioned expansion for new provider behaviors

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
| New providers integrate without changing session or run semantics | 100% of supported providers | Driver integration review | `2026-04-14` |
| Unsupported controls are hidden or degraded correctly | 100% of capability-checked controls | Spec and UI test coverage | `2026-04-14` |

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
|--------|------|-------------|--------------|
| `specs/005-provider-driver-contract-and-capabilities.md` | Canonical spec | Provider integrations use a normalized contract with explicit capability advertisement | [specs/005-provider-driver-contract-and-capabilities.md](../specs/005-provider-driver-contract-and-capabilities.md) |
| `architecture/component-architecture-local-daemon.md` | Canonical architecture doc | Driver management belongs inside the local daemon edge | [architecture/component-architecture-local-daemon.md](../architecture/component-architecture-local-daemon.md) |
| `specs/020-observability-and-failure-recovery.md` | Canonical spec | Provider failures are surfaced through canonical product failure categories rather than provider-specific runtime truth | [specs/020-observability-and-failure-recovery.md](../specs/020-observability-and-failure-recovery.md) |

### Related Domain Docs

- [Runtime Node Model](../domain/runtime-node-model.md)
- [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md)

### Related Architecture Docs

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Data Architecture](../architecture/data-architecture.md)
- [Observability Architecture](../architecture/observability-architecture.md)

### Related Specs

- [Provider Driver Contract And Capabilities](../specs/005-provider-driver-contract-and-capabilities.md)
- [Runtime Node Attach](../specs/003-runtime-node-attach.md)
- [Observability And Failure Recovery](../specs/020-observability-and-failure-recovery.md)

### Related ADRs

- [Local Execution Shared Control Plane](./002-local-execution-shared-control-plane.md)

## Decision Log

| Date | Event | Notes |
|------|-------|-------|
| 2026-04-14 | Proposed | Initial draft |
| 2026-04-14 | Re-baselined | Reviewer assignment and acceptance validation remain incomplete |
| 2026-04-15 | Accepted | ADR accepted |
