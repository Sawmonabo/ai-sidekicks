# ADR-007: Collaboration Trust And Permission Model

| Field         | Value                        |
| ------------- | ---------------------------- |
| **Status**    | `accepted`                   |
| **Type**      | `Type 2 (one-way door)`      |
| **Domain**    | `Security And Authorization` |
| **Date**      | `2026-04-14`                 |
| **Author(s)** | `Codex`                      |
| **Reviewers** | `Accepted 2026-04-15`        |

## Context

One user drives a session from any of their linked devices, and the work executes on a runtime node that user owns. That creates a security challenge no single flat check answers: which device may act as the user, which machine may execute for the user, and what a sidekick may do once a run is under way are related but not identical. A flat trust model would either let anything holding the account credential execute anywhere, or turn every sidekick action into a prompt.

## Problem Statement

How should the system separate device trust, runtime-node trust, and approval scopes?

### Trigger

The security architecture and approvals spec need a durable model for trust and permission decisions across the user's devices, the user's machines, and the sidekicks running on them.

## Decision

We will use a layered trust model that separates device trust (which device, acting for the account, may call at all), runtime-node trust, run-level approval policy, and tool- or resource-level permission grants.

### Thesis — Why This Option

Layering matches the real boundary structure of the system. A device can be linked to the account and drive a session without being trusted to execute anything — it executes nothing at all. A runtime node can be trusted to execute for its owner without thereby bypassing action-level approvals. Holding the account credential lets the user manage their own devices without that being a standing grant over every tool a sidekick might reach for. This model is strict enough to preserve local-machine trust and flexible enough to drive a session from a phone.

### Antithesis — The Strongest Case Against

Multiple permission layers risk confusing users and implementers. A simpler model where the account credential implies broad session execution rights would be easier to explain and implement. A fully explicit every-action approval model would be more secure in theory, but could be too disruptive in practice.

### Synthesis — Why It Still Holds

The simpler flat model is unacceptable because it collapses account authentication into machine trust: a stolen phone would be an execution grant on every machine the account owns. The fully explicit model is safer but too friction-heavy for real coding workflows. Layered trust gives a principled middle path: durable device and node identity plus explicit action scopes with auditable remembered grants where appropriate.

## Alternatives Considered

### Option A: Layered Device + Node + Action Trust (Chosen)

- **What:** Separate device trust, node trust, and action-level approvals.
- **Steel man:** Preserves the true trust boundaries of remotely driven local execution.
- **Weaknesses:** More concepts to teach and implement.

### Option B: Flat Account-Wide Trust (Rejected)

- **What:** Authenticating as the account implies broad authority over every session execution surface.
- **Steel man:** Simple to understand and easy to implement.
- **Why rejected:** Over-authorizes any device holding a credential and violates the local-execution trust boundary.

### Option C: Per-Action Approval Only, No Durable Trust Layers (Rejected)

- **What:** Avoid durable trust and require repeated action approvals for nearly everything.
- **Steel man:** Maximum explicitness and reduced long-lived privilege.
- **Why rejected:** Too much friction for normal development workflows and a poor fit for long sessions on a machine the user already trusts.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | Device trust and machine trust are not the same thing. | Vision and security docs explicitly separate driving a session from executing it locally. | A flatter model could be enough. |
| 2 | Users need bounded remembered grants for practical workflows. | Approval and queue semantics assume repeated interactions over long sessions. | Per-action-only approval might be acceptable. |
| 3 | The Local Runtime Daemon can reliably enforce local permission checks. | Local Runtime Daemon is the execution authority in the architecture. | Enforcement would need to move elsewhere. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| Users misunderstand which scope granted an action | Med | Med | Approval audit and UI mismatch reports | Keep approval surfaces explicit and auditable |
| Remembered grants drift beyond intended scope | Med | High | Actions succeed unexpectedly under old grants | Require revocation paths and trust-change invalidation |
| Device trust and node trust accidentally collapse in implementation | Low | High | Execution becomes possible on a node that never accepted the session | Enforce daemon-side policy checks and security review |

## Reversibility Assessment

- **Reversal cost:** High. It would affect security, approvals, runtime attach, audit, and user expectations.
- **Blast radius:** Device model, runtime-node attach, local daemon policy, UI approval flows, and operations.
- **Migration path:** Introduce a new authorization model, migrate stored grants, and potentially invalidate historic assumptions.
- **Point of no return:** After approval records, node trust, and device identity are stored and enforced through one shared model.

## Consequences

### Positive

- Preserves local-machine trust when a session is driven from another device
- Allows a session to be driven from anywhere without flat over-authorization

### Negative (accepted trade-offs)

- More concepts for users and developers to learn
- More policy surface to test and document

### Unknowns

- How much remembered-grant customization organizations will want beyond the base model

## Decision Validation

### Pre-Implementation Checklist

- [ ] All unvalidated assumptions have a validation plan
- [x] At least one alternative was seriously considered and steel-manned
- [ ] Antithesis was reviewed by someone other than the author
- [x] Failure modes have detection mechanisms
- [x] Point of no return is identified and communicated to the team

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Device trust alone never authorizes local execution on a node that has not accepted the session | 100% of execution checks | Security and integration tests | `2026-04-14` |
| Approval records clearly identify granted scope | 100% of approval records | Audit review | `2026-04-14` |

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| `specs/012-approvals-permissions-and-trust-boundaries.md` | Canonical spec | Approval and permission scopes are part of the core product contract | [specs/012-approvals-permissions-and-trust-boundaries.md](../specs/012-approvals-permissions-and-trust-boundaries.md) |
| `architecture/security-architecture.md` | Canonical architecture doc | Security boundary follows device identity, node trust, and transport separation | [architecture/security-architecture.md](../architecture/security-architecture.md) |

### Related Domain Docs

- [User And Device Model](../domain/user-and-device-model.md)
- [Runtime Node Model](../domain/runtime-node-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

### Related Architecture Docs

- [Security Architecture](../architecture/security-architecture.md)
- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)
- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)

### Related Specs

- [Runtime Node Attach](../specs/003-runtime-node-attach.md)
- [Approvals Permissions And Trust Boundaries](../specs/012-approvals-permissions-and-trust-boundaries.md)

### Related ADRs

- [Local Execution Shared Control Plane](./002-local-execution-shared-control-plane.md)
- [Default Transports And Relay Boundaries](./008-default-transports-and-relay-boundaries.md)

## Decision Log

| Date | Event | Notes |
| --- | --- | --- |
| 2026-04-14 | Proposed | Initial draft |
| 2026-04-14 | Re-baselined | Reviewer assignment and acceptance validation remain incomplete |
| 2026-04-15 | Accepted | ADR accepted |
| 2026-08-03 | Reaffirmed | Run-control authorization amendment ([Spec-012](../specs/012-approvals-permissions-and-trust-boundaries.md) + [Spec-004](../specs/004-queue-steer-pause-resume.md), both flipped to `review` for their amendment window) evaluated against Spec-012 §ADR Triggers' "materially changes how trust and approval scopes work" trigger: **no decision change; Status stays `accepted`.** The amendment assigns run-control interventions (`steer` / `interrupt` / `cancel` / `rollback`) to this ADR's **device-trust layer**, unscoped by run authorship — any non-revoked device of the owning account may intervene in any run of that session — and leaves the node-trust, run-level-approval, and tool/resource-grant layers untouched: it operates inside the chosen layering rather than flattening it, so Option B (Flat Account-Wide Trust) stays rejected. §Success Criteria's device-trust criterion holds unchanged — an intervention against a run hosted on another of the user's machines is still admitted only under that node's per-dispatch approval ([Spec-024](../specs/024-cross-node-dispatch-and-approval.md); `Security Architecture §Inter-Node Trust Boundaries`). No layer is added, removed, or re-scoped. |
