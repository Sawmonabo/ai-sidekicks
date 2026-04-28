# ADR-002: Local Execution Shared Control Plane

| Field         | Value                      |
| ------------- | -------------------------- |
| **Status**    | `accepted`                 |
| **Type**      | `Type 2 (one-way door)`    |
| **Domain**    | `Distributed Architecture` |
| **Date**      | `2026-04-14`               |
| **Author(s)** | `Codex`                    |
| **Reviewers** | `Accepted 2026-04-15`      |

## Context

The product must support shared sessions across people while allowing each participant to contribute local runtime nodes from their own machines. That creates a natural split between collaboration coordination and code execution. Choosing the wrong side of that split would either centralize too much trust in a hosted service or make multi-user collaboration brittle and peer-to-peer only.

## Problem Statement

How should the system divide responsibilities between local execution and shared collaboration?

### Trigger

The system context, control-plane architecture, and runtime-node model all depend on this boundary.

## Decision

We will keep code execution local to participant-controlled runtime nodes and use a shared control plane for identity, invites, membership, presence, relay, notifications, and shared metadata.

### Thesis — Why This Option

This split matches the product goal directly. Local nodes retain filesystem, tool, and provider authority, while the control plane coordinates shared session state without becoming the code-execution authority. It also supports hosted and self-hosted collaboration topologies without forcing repo content and shell execution into one central service.

### Antithesis — The Strongest Case Against

A hosted execution plane would simplify collaboration and reduce node-to-node complexity. A purely local peer-to-peer design would simplify trust boundaries and reduce backend scope. The chosen split inherits complexity from both: Local Runtime Daemon management plus Collaboration Control Plane coordination.

### Synthesis — Why It Still Holds

Hosted execution fails the product's local-runtime contribution requirement and increases trust burden dramatically. Pure peer-to-peer collaboration makes durable invites, presence, notifications, and multi-user coordination harder than necessary. The split is more complex, but it preserves the correct trust boundary and supports the target collaboration model.

## Alternatives Considered

### Option A: Local Execution + Shared Control Plane (Chosen)

- **What:** Execution stays on local runtime nodes; coordination lives in shared services.
- **Steel man:** Best match for privacy, local code access, and multi-user collaboration.
- **Weaknesses:** Requires careful transport, replay, and presence design.

### Option B: Central Hosted Execution Plane (Rejected)

- **What:** Run providers, tools, and repo access inside hosted infrastructure.
- **Steel man:** Simplifies collaboration and cross-user scheduling.
- **Why rejected:** Breaks the local-runtime contribution requirement and expands the trust boundary too far.

### Option C: Pure Peer-To-Peer Collaboration (Rejected)

- **What:** Avoid a control plane and coordinate sessions only through direct node connectivity.
- **Steel man:** Keeps trust local and reduces backend dependency.
- **Why rejected:** Weak fit for invites, durable membership, notifications, and reconnect-friendly shared session state.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | Users need local repo and tool execution to remain on their own machines. | `vision.md` requires participant-contributed local agents. | Hosted execution might be more appropriate. |
| 2 | Collaboration metadata can be shared without centralizing execution. | System context, participant-and-membership modeling, and join specs keep membership, presence, and node attachment separate from execution authority. | The control plane might need broader authority than intended. |
| 3 | The product can tolerate control-plane dependency for collaborative features. | Deployment topology includes `local-only` fallback for non-collaborative use. | Shared-session behavior could be too fragile under outages. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| Control-plane outage breaks collaboration while local execution remains available | Med | High | Join, invite, or presence operations fail | Preserve `local-only` continuity and explicit degraded mode |
| Local nodes become hard to discover or reconnect | Med | Med | Presence churn and repeated attach failures | Strong heartbeat, grace windows, and relay fallback |
| Security boundary between control plane and local node erodes | Low | High | Unexpected remote execution authority or broad grants appear | Enforce daemon-side policy and explicit capability declaration |

## Reversibility Assessment

- **Reversal cost:** High. It would affect deployment, trust, transport, storage, and operations.
- **Blast radius:** Runtime-node attach, control-plane services, session join, security, and recovery.
- **Migration path:** Would require moving execution or collaboration authority to a new deployment center and reworking all session flows.
- **Point of no return:** After runtime-node attach, session join, and storage flows all assume the split.

## Consequences

### Positive

- Preserves local execution authority
- Makes shared collaboration possible without central hosted execution

### Negative (accepted trade-offs)

- More moving parts than purely local or purely hosted designs
- Requires explicit degraded behavior when the control plane is unavailable

### Unknowns

- How much relay complexity typical deployments will need in practice

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
| Local filesystem and tool execution remains Local Runtime Daemon-owned | 100% of execution paths | Architecture and security review | `2026-04-14` |
| Collaboration Control Plane remains free of direct code execution responsibilities | 100% of control-plane components | Architecture review | `2026-04-14` |

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| `vision.md` | Canonical product vision | Local runtime contribution and shared session collaboration are both required | [vision.md](../vision.md) |
| `architecture/system-context.md` | Canonical architecture doc | The split enables both local execution and shared coordination | [architecture/system-context.md](../architecture/system-context.md) |
| `specs/002-invite-membership-and-presence.md` | Canonical spec | Membership, presence, and runtime-node attachment are distinct layers and join does not require execution attach | [specs/002-invite-membership-and-presence.md](../specs/002-invite-membership-and-presence.md) |
| `specs/008-control-plane-relay-and-session-join.md` | Canonical spec | Join, presence, and relay coordination do not make the control plane the execution authority | [specs/008-control-plane-relay-and-session-join.md](../specs/008-control-plane-relay-and-session-join.md) |

### Related Domain Docs

- [Session Model](../domain/session-model.md)
- [Participant And Membership Model](../domain/participant-and-membership-model.md)
- [Runtime Node Model](../domain/runtime-node-model.md)

### Related Architecture Docs

- [System Context](../architecture/system-context.md)
- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)
- [Security Architecture](../architecture/security-architecture.md)

### Related Specs

- [Shared Session Core](../specs/001-shared-session-core.md)
- [Runtime Node Attach](../specs/003-runtime-node-attach.md)
- [Control Plane Relay And Session Join](../specs/008-control-plane-relay-and-session-join.md)

### Related ADRs

- [Session Is The Primary Domain Object](./001-session-is-the-primary-domain-object.md)
- [Default Transports And Relay Boundaries](./008-default-transports-and-relay-boundaries.md)

## Decision Log

| Date       | Event        | Notes                                                           |
| ---------- | ------------ | --------------------------------------------------------------- |
| 2026-04-14 | Proposed     | Initial draft                                                   |
| 2026-04-14 | Re-baselined | Reviewer assignment and acceptance validation remain incomplete |
| 2026-04-15 | Accepted     | ADR accepted                                                    |
