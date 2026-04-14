# ADR-007: Collaboration Trust And Permission Model

| Field | Value |
| -------------- | ------------------------------------------------------------------------ |
| **Status** | `accepted` |
| **Type** | `Type 2 (one-way door)` |
| **Domain** | `Security And Authorization` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Reviewers** | `TBD` |

## Context

The product brings multiple humans and multiple local runtime nodes into one shared session. That creates a security challenge: collaboration authority, node trust, and sensitive execution permissions are related but not identical. A flat trust model would either over-authorize participants or make collaboration unusably rigid.

## Problem Statement

How should the system separate membership, runtime-node trust, and approval scopes?

### Trigger

The security architecture and approvals spec need a durable model for shared-session trust and permission decisions.

## Decision

We will use a layered trust model that separates session membership, runtime-node trust, run-level approval policy, and tool- or resource-level permission grants.

### Thesis — Why This Option

Layering matches the real boundary structure of the system. A participant can belong to a session without being trusted to execute on another node. A node can be attached without granting every capability. A run can still require explicit approvals for sensitive actions. This model is strict enough to preserve local-machine trust and flexible enough for shared sessions.

### Antithesis — The Strongest Case Against

Multiple permission layers risk confusing users and implementers. A simpler model where membership implies broad session execution rights would be easier to explain and implement. A fully explicit every-action approval model would be more secure in theory, but could be too disruptive in practice.

### Synthesis — Why It Still Holds

The simpler flat model is unacceptable because it collapses human collaboration into machine trust. The fully explicit model is safer but too friction-heavy for real coding workflows. Layered trust gives a principled middle path: durable membership plus explicit node and action scopes with auditable remembered grants where appropriate.

## Alternatives Considered

### Option A: Layered Membership + Node + Action Trust (Chosen)

- **What:** Separate session membership, node trust, and action-level approvals.
- **Steel man:** Preserves the true trust boundaries of collaborative local execution.
- **Weaknesses:** More concepts to teach and implement.

### Option B: Flat Session-Wide Trust (Rejected)

- **What:** Membership implies broad authority over session execution surfaces.
- **Steel man:** Simple to understand and easy to implement.
- **Why rejected:** Over-authorizes collaborators and violates the local-execution trust boundary.

### Option C: Per-Action Approval Only, No Durable Trust Layers (Rejected)

- **What:** Avoid durable trust and require repeated action approvals for nearly everything.
- **Steel man:** Maximum explicitness and reduced long-lived privilege.
- **Why rejected:** Too much friction for normal development workflows and poor fit for contributed runtime nodes.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
|---|-----------|----------|----------------------|
| 1 | Membership and machine trust are not the same thing. | Vision and security docs explicitly separate collaboration from local execution. | A flatter model could be enough. |
| 2 | Users need bounded remembered grants for practical workflows. | Approval and queue semantics assume repeated interactions over long sessions. | Per-action-only approval might be acceptable. |
| 3 | The Local Runtime Daemon can reliably enforce local permission checks. | Local Runtime Daemon is the execution authority in the architecture. | Enforcement would need to move elsewhere. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
|----------|-----------|--------|-----------|------------|
| Users misunderstand which scope granted an action | Med | Med | Approval audit and UI mismatch reports | Keep approval surfaces explicit and auditable |
| Remembered grants drift beyond intended scope | Med | High | Actions succeed unexpectedly under old grants | Require revocation paths and trust-change invalidation |
| Membership and node trust accidentally collapse in implementation | Low | High | Cross-node execution becomes possible without explicit grant | Enforce daemon-side policy checks and security review |

## Reversibility Assessment

- **Reversal cost:** High. It would affect security, approvals, runtime attach, audit, and user expectations.
- **Blast radius:** Membership model, runtime-node attach, local daemon policy, UI approval flows, and operations.
- **Migration path:** Introduce a new authorization model, migrate stored grants, and potentially invalidate historic assumptions.
- **Point of no return:** After approval records, node trust, and membership roles are stored and enforced through one shared model.

## Consequences

### Positive

- Preserves local-machine trust in shared sessions
- Allows practical collaboration without flat over-authorization

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
|--------|--------|--------------------|------------|
| Membership alone never authorizes cross-node local execution | 100% of execution checks | Security and integration tests | `2026-04-14` |
| Approval records clearly identify granted scope | 100% of approval records | Audit review | `2026-04-14` |

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
|--------|------|-------------|--------------|
| `008-security-permissions-trust.md` | Extraction note | Trust must be layered across membership, node capability, and action-level grants | [tmp/extraction/008-security-permissions-trust.md](../tmp/extraction/008-security-permissions-trust.md) |
| `specs/012-approvals-permissions-and-trust-boundaries.md` | Canonical spec | Approval and permission scopes are part of the core product contract | [specs/012-approvals-permissions-and-trust-boundaries.md](../specs/012-approvals-permissions-and-trust-boundaries.md) |
| `architecture/security-architecture.md` | Canonical architecture doc | Security boundary follows membership, node trust, and transport separation | [architecture/security-architecture.md](../architecture/security-architecture.md) |

### Related Domain Docs

- [Participant And Membership Model](../domain/participant-and-membership-model.md)
- [Runtime Node Model](../domain/runtime-node-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

### Related Architecture Docs

- [Security Architecture](../architecture/security-architecture.md)
- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)
- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)

### Related Specs

- [Invite Membership And Presence](../specs/002-invite-membership-and-presence.md)
- [Runtime Node Attach](../specs/003-runtime-node-attach.md)
- [Approvals Permissions And Trust Boundaries](../specs/012-approvals-permissions-and-trust-boundaries.md)

### Related ADRs

- [Local Execution Shared Control Plane](./002-local-execution-shared-control-plane.md)
- [Default Transports And Relay Boundaries](./008-default-transports-and-relay-boundaries.md)

## Decision Log

| Date | Event | Notes |
|------|-------|-------|
| 2026-04-14 | Proposed | Initial draft |
| 2026-04-14 | Accepted | Required for collaborative local execution safety |
