# ADR-001: Session Is The Primary Domain Object

| Field         | Value                   |
| ------------- | ----------------------- |
| **Status**    | `accepted`              |
| **Type**      | `Type 2 (one-way door)` |
| **Domain**    | `Domain Model`          |
| **Date**      | `2026-04-14`            |
| **Author(s)** | `Codex`                 |
| **Reviewers** | `Accepted 2026-04-15`   |

## Context

The product goal requires a live session the user can pick up from any of their devices, with durable state and with the user's own machine that runs it doing the work. A model centered on one agent thread or one workspace would be simpler, but it would force device access, queue state, approvals, and repo activity to bolt onto a concept that does not actually contain all relevant actors.

## Problem Statement

What primary domain object should anchor the product: agent, thread, workspace, or session?

### Trigger

The greenfield documentation program needs one vocabulary and one architectural center before specs and implementation plans can be written safely.

## Decision

We will use `Session` as the primary domain object for the product.

### Thesis — Why This Option

`Session` is the only candidate that can naturally contain the user, their devices, agents, runs, repo mounts, approvals, and artifacts, on the one machine that runs it, while preserving a single ordered event log. It matches the product's defining requirement: the user must be able to pick up a live session from another device and keep driving it without breaking the runtime model.

### Antithesis — The Strongest Case Against

Making session primary adds modeling overhead. Agent- or thread-centric designs are faster to ship because provider runtimes already expose those concepts. A session-centric design risks over-generalization and could slow single-device flows by forcing remote-access abstractions into every path.

### Synthesis — Why It Still Holds

The single-device case, the person at the desktop app on the machine that runs the session, remains a valid session with no other device, so session-centric design does not prevent simple flows. By contrast, an agent- or thread-centric design cannot grow into a session driven from several devices without semantic breakage. The modeling overhead is real, but the reversal cost of choosing the wrong center is much higher once specs, storage, and UI projections are built.

## Alternatives Considered

### Option A: Session-Centric Model (Chosen)

- **What:** Use `Session` as the durable container for all core product state.
- **Steel man:** Supports single-device, multi-agent, and multi-device flows with one shared event model.
- **Weaknesses:** Adds more explicit domain modeling work up front.

### Option B: Agent-Thread-Centric Model (Rejected)

- **What:** Treat a provider-backed agent thread as the primary unit and attach other concerns later.
- **Steel man:** Maps closely to existing provider runtimes and is fast for single-device execution.
- **Why rejected:** It cannot cleanly model several devices driving one session, device liveness, or a session that stays on the machine it started on while any of those devices drives it, without semantic drift.

### Option C: Workspace-Centric Model (Rejected)

- **What:** Treat the repo or workspace as the primary object and hang device access and execution off it.
- **Steel man:** Fits coding workflows and repo-bound views well.
- **Why rejected:** A workspace is execution context, not a durable conversation or ownership boundary.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | Driving one live session from any of the user's devices is a core requirement, not a later add-on. | `vision.md` makes this the defining requirement. | A simpler agent-centric design might be preferable. |
| 2 | Single-device flows can still feel lightweight inside a session model. | Domain and spec drafts keep single-device sessions valid. | Session-centric design could feel unnecessarily heavy. |
| 3 | Provider thread ids are not a safe long-term product identity. | The session model explicitly rejects provider threads as the root object, and Spec-001 forbids treating provider thread ids as session ids. | Session identity might become overly abstracted from runtime reality. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| Session model becomes over-complex for the common single-device flow | Med | Med | Product usage shows excessive setup and thin sessions | Keep defaults minimal: one owner, the machine it was started on, no setup step |
| Teams still use agent or thread language inconsistently | Med | High | Spec wording and implementation names drift | Enforce glossary and domain-doc review gates |
| Session projections become performance-heavy | Low | Med | Projection lag and large replay windows | Add compaction and projection tuning without changing session semantics |

## Reversibility Assessment

- **Reversal cost:** High. It would require rewriting domain docs, event taxonomy, storage keys, projections, and large parts of the UI.
- **Blast radius:** Session storage, the event log, device access, queue, approvals, and multi-agent orchestration.
- **Migration path:** A reversal would require introducing a new root aggregate and remapping all existing session-owned records.
- **Point of no return:** After session ids become the durable identifier in storage and external APIs.

## Consequences

### Positive

- One model for single-device and multi-device flows
- Cleaner semantics for device linking, device liveness, and the one machine a session runs on

### Negative (accepted trade-offs)

- More up-front domain modeling work
- Some flows must pass through multi-device abstractions even when only one device is connected

### Unknowns

- How much projection tuning large long-lived sessions will require

## Decision Validation

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Canonical docs reuse one stable session-centric vocabulary | 100% of foundational docs | Reading the domain, architecture and spec docs | At every review of a domain, architecture or spec document |
| Multi-device features do not require parallel root models | 0 duplicate root aggregates | Architecture and spec review | At every architecture and spec review |

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| `vision.md` | Canonical product vision | A session reachable from any of the user's devices is the defining product requirement | [vision.md](../vision.md) |
| `domain/session-model.md` | Canonical domain doc | Session can contain all core nouns coherently | [domain/session-model.md](../domain/session-model.md) |
| `specs/001-session-core.md` | Canonical spec | Session is the stable container and provider thread ids are not session ids | [specs/001-session-core.md](../specs/001-session-core.md) |

### Related Domain Docs

- [Session Model](../domain/session-model.md)
- [User And Device Model](../domain/user-and-device-model.md)
- [Agent And Run Model](../domain/agent-and-run-model.md)

### Related Architecture Docs

- [System Context](../architecture/system-context.md)
- [Container Architecture](../architecture/container-architecture.md)

### Related Specs

- [Session Core](../specs/001-session-core.md)
- [Machine Registration](../specs/002-machine-registration.md)

### Related ADRs

- [Local Execution Shared Control Plane](./002-local-execution-shared-control-plane.md) — execution and coordination split inside the session model
