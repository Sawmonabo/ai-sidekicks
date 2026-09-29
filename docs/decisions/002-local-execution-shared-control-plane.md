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

The product must let a user drive a session from any of their devices while the work executes on a machine that user owns. That creates a natural split between coordination and code execution. Choosing the wrong side of that split would either centralize too much trust in a hosted service or make remote control brittle and peer-to-peer only.

## Problem Statement

How should the system divide responsibilities between local execution and shared coordination?

### Trigger

The system context, control-plane architecture, and runtime-node model all depend on this boundary.

## Decision

We will keep code execution on the user's own machines, each session on the machine it was started on, and use the person's own control plane for identity, the account's statement chain and its device and machine registry, the relay between their devices and their machines, delivery of push notices each machine has already sealed, and shared metadata.

### Thesis — Why This Option

This split matches the product goal directly. The machines retain filesystem, tool, and provider authority, while the control plane links devices and relays their sealed channels without seeing session content or becoming the code-execution authority. It also lets the person run their control plane on their own Cloudflare account or their own server without forcing repo content and shell execution into one central service.

### Antithesis — The Strongest Case Against

A hosted execution plane would simplify remote access and reduce device-to-node complexity. A purely local peer-to-peer design would simplify trust boundaries and reduce backend scope. The chosen split inherits complexity from both: Local Runtime Daemon management plus Control Plane coordination.

### Synthesis — Why It Still Holds

Hosted execution fails the product's local-execution requirement and increases trust burden dramatically. Pure peer-to-peer coordination makes a durable device registry, device liveness, notifications, and reconnect handling harder than necessary. The split is more complex, but it preserves the correct trust boundary and lets any of the user's devices reach the machine that runs the work.

## Alternatives Considered

### Option A: Local Execution + Shared Control Plane (Chosen)

- **What:** Execution stays on local runtime nodes; coordination lives in shared services.
- **Steel man:** Best match for privacy, local code access, and driving a session from any device.
- **Weaknesses:** Requires careful transport, replay, and device-liveness design.

### Option B: Central Hosted Execution Plane (Rejected)

- **What:** Run providers, tools, and repo access inside hosted infrastructure.
- **Steel man:** Simplifies remote access and cross-machine scheduling.
- **Why rejected:** Breaks the local-execution requirement and expands the trust boundary too far.

### Option C: Pure Peer-To-Peer Coordination (Rejected)

- **What:** Avoid a control plane and coordinate sessions only through direct device-to-node connectivity.
- **Steel man:** Keeps trust local and reduces backend dependency.
- **Why rejected:** Weak fit for device linking, a durable device registry, notifications, and reconnect-friendly session state.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | Users need local repo and tool execution to remain on their own machines. | `vision.md` requires the work to run on the machine that holds the repo. | Hosted execution might be more appropriate. |
| 2 | Coordination metadata can be shared without centralizing execution. | System context, the user-and-device model, and Spec-002 keep the device registry, the statement chain, and machine registration separate from execution authority. | The control plane might need broader authority than intended. |
| 3 | The product can tolerate control-plane dependency for remote features. | Deployment topology includes `local-only` fallback for working on the machine itself. | Remote-control behavior could be too fragile under outages. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| Control-plane outage breaks remote control while local execution remains available | Med | High | Device-link, relay, or liveness operations fail | Preserve `local-only` continuity and explicit degraded mode |
| Machines become hard to reach or reconnect | Med | Med | Machine cards read `Not reachable`, and the relay block of `sidekicks daemon status` shows reconnects climbing | One outbound relay connection per machine, one live connection per key, and reachability read from that connection |
| Security boundary between control plane and machine erodes | Low | High | Unexpected remote execution authority or broad grants appear | Enforce daemon-side policy, and have every machine verify the statement chain itself |

## Reversibility Assessment

- **Reversal cost:** High. It would affect deployment, trust, transport, storage, and operations.
- **Blast radius:** Machine registration, control-plane services, device linking, security, and recovery.
- **Migration path:** Would require moving execution or coordination authority to a new deployment center and reworking all session flows.
- **Point of no return:** After machine registration, device linking, and storage flows all assume the split.

## Consequences

### Positive

- Preserves local execution authority
- Makes remote control possible without central hosted execution

### Negative (accepted trade-offs)

- More moving parts than purely local or purely hosted designs
- Requires explicit degraded behavior when the control plane is unavailable

### Unknowns

- How much of the relay's size budget one person's machines and devices use, which the relay's build measures against that budget and records as its baseline

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
| Local filesystem and tool execution remains Local Runtime Daemon-owned | 100% of execution paths | Architecture and security review | At every architecture and security review |
| Control Plane remains free of direct code execution responsibilities | 100% of control-plane components | Architecture review | At every architecture review |

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| `vision.md` | Canonical product vision | Local execution and driving a session from any device are both required | [vision.md](../vision.md) |
| `architecture/system-context.md` | Canonical architecture doc | The split enables both local execution and shared coordination | [architecture/system-context.md](../architecture/system-context.md) |

### Related Domain Docs

- [Session Model](../domain/session-model.md)
- [User And Device Model](../domain/user-and-device-model.md)
- [Runtime Node Model](../domain/runtime-node-model.md)

### Related Architecture Docs

- [System Context](../architecture/system-context.md)
- [Daemon Architecture](../architecture/daemon.md)
- [Control Plane Architecture](../architecture/control-plane.md)
- [Security Architecture](../architecture/security-architecture.md)

### Related Specs

- [Session Core](../specs/001-session-core.md)
- [Runtime Node Attach](../specs/002-runtime-node-attach.md)

### Related ADRs

- [Session Is The Primary Domain Object](./001-session-is-the-primary-domain-object.md)
- [Default Transports And Relay Boundaries](./008-default-transports-and-relay-boundaries.md)
