# ADR-007: Device Trust and Permission Model

| Field         | Value                        |
| ------------- | ---------------------------- |
| **Status**    | `accepted`                   |
| **Type**      | `Type 2 (one-way door)`      |
| **Domain**    | `Security And Authorization` |
| **Date**      | `2026-04-14`                 |
| **Author(s)** | `Codex`                      |
| **Reviewers** | `Accepted 2026-04-15`        |

## Context

One user drives a session from any of their linked devices, and the work executes on the machine the session was started on. That creates a security challenge no single flat check answers: which device may act as the user, and what an agent may do once a run is under way, are related but not identical. A flat trust model would either let anything holding the account credential act on every machine, or turn every agent action into a prompt.

## Problem Statement

How should the system separate device trust from what an agent may do?

### Trigger

The security architecture and approvals spec need a durable model for trust and permission decisions across the user's devices, the user's machines, and the agents running on them.

## Decision

We will use a layered trust model that separates device trust — which device, acting for the account, may call at all — from what an agent may do: the session's permission level, which decides whether anything asks at all; remembered rules, which answer an ask for one subject at the session's or the project's scope; and trust, which is given per project and never per machine.

Device trust is the account's statement chain. Every machine verifies the chain itself and trusts a key only when a path of `runtimenode.added`, `device.linked` and `passkey.added` statements reaches it from its own machine key, each signed while its signer was still trusted at that point in the chain. A `device.revoked`, `runtimenode.removed` or `passkey.removed` ends the key it names at that point: a statement that key signs afterward is refused, and what it signed before stands, so every device, machine and passkey it added stays trusted. An ended key is never trusted again. Every linked device reads and acts on everything: there is no per-device permission and no view-only device, and a device that should not act is revoked.

Run-control interventions — `steer`, `interrupt`, `cancel` and `faster_model_retry` — sit in the device-trust layer and are not scoped by run authorship: any non-revoked device of the owning account may intervene in any run of that session ([Spec-010](../specs/010-approvals-permissions-and-trust-boundaries.md), [Spec-003](../specs/003-queue-steer-pause-resume.md)). A run always executes on its session's own machine, so no intervention reaches another machine.

### Thesis — Why This Option

Layering matches the real boundary structure of the system. A device can be linked to the account and drive a session without being trusted to execute anything — it executes nothing at all. A machine executes for its owner and holds no trust of its own, so nothing about the machine bypasses the session's permission level or its remembered rules. Holding the account credential lets the user manage their own devices without that being a standing grant over every tool an agent might reach for. This model is strict enough to preserve local-machine trust and flexible enough to drive a session from a phone.

### Antithesis — The Strongest Case Against

Multiple permission layers risk confusing users and implementers. A simpler model where the account credential implies broad session execution rights would be easier to explain and implement. A fully explicit every-action approval model would be more secure in theory, but could be too disruptive in practice.

### Synthesis — Why It Still Holds

The simpler flat model is unacceptable because it collapses account authentication into device trust: anything holding the account's sign-in would drive every machine the account owns. Here a device acts only with a key the chain trusts, which every machine checks in the handshake, and a stolen phone is revoked from any other device. The fully explicit model is safer but too friction-heavy for real coding workflows. Layered trust gives a principled middle path: durable device identity on the chain, plus the session's permission level and auditable remembered rules, with trust given per project.

## Alternatives Considered

### Option A: Layered Device + Action Trust (Chosen)

- **What:** Separate device trust from the session's permission level, remembered rules, and trust given per project.
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
| 1 | Trusting a device to drive a session is not the same as allowing an agent's action. | Vision and security docs explicitly separate driving a session from executing it locally. | A flatter model could be enough. |
| 2 | Users need bounded remembered grants for practical workflows. | Approval and queue semantics assume repeated interactions over long sessions. | Per-action-only approval might be acceptable. |
| 3 | The Local Runtime Daemon can reliably enforce local permission checks. | Local Runtime Daemon is the execution authority in the architecture. | Enforcement would need to move elsewhere. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| Users misunderstand which scope granted an action | Med | Med | Approval audit and UI mismatch reports | Keep approval surfaces explicit and auditable |
| Remembered rules drift beyond intended scope | Med | High | Actions succeed unexpectedly under old rules | Keep a revoke per rule; a rule carries the permission level it was made at and is honored only at that level or a less careful one |
| A linked device's reach is mistaken for an agent's permission in implementation | Low | High | An agent action runs that no permission level, remembered rule or answer allowed | Enforce daemon-side policy checks and security review |

## Reversibility Assessment

- **Reversal cost:** High. It would affect security, approvals, device linking, audit, and user expectations.
- **Blast radius:** Device model, the statement chain, local daemon policy, UI approval flows, and operations.
- **Migration path:** Introduce a new authorization model, migrate stored grants, and potentially invalidate historic assumptions.
- **Point of no return:** After approval records, remembered rules, and device identity are stored and enforced through one shared model.

## Consequences

### Positive

- Preserves local-machine trust when a session is driven from another device
- Allows a session to be driven from anywhere without flat over-authorization

### Negative (accepted trade-offs)

- More concepts for users and developers to learn
- More policy surface to test and document

### Unknowns

- How much remembered-rule customization the person will want beyond the base model

## Decision Validation

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Device trust alone never authorizes an agent action that the session's permission level, a remembered rule or a person's answer has not allowed | 100% of execution checks | Security and integration tests | Each run of the security and integration tests |
| Approval records clearly identify granted scope | 100% of approval records | Audit review | At every audit review |

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| `specs/010-approvals-permissions-and-trust-boundaries.md` | Canonical spec | Approval and permission scopes are part of the core product contract | [specs/010-approvals-permissions-and-trust-boundaries.md](../specs/010-approvals-permissions-and-trust-boundaries.md) |
| `architecture/security-architecture.md` | Canonical architecture doc | Security boundary follows device identity, the session's permission level, and transport separation | [architecture/security-architecture.md](../architecture/security-architecture.md) |

### Related Domain Docs

- [User And Device Model](../domain/user-and-device-model.md)
- [Runtime Node Model](../domain/runtime-node-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

### Related Architecture Docs

- [Security Architecture](../architecture/security-architecture.md)
- [Control Plane Architecture](../architecture/control-plane.md)
- [Daemon Architecture](../architecture/daemon.md)

### Related Specs

- [Machine Registration](../specs/002-runtime-node-attach.md)
- [Approvals Permissions And Trust Boundaries](../specs/010-approvals-permissions-and-trust-boundaries.md)

### Related ADRs

- [Local Execution Shared Control Plane](./002-local-execution-shared-control-plane.md)
- [Default Transports And Relay Boundaries](./008-default-transports-and-relay-boundaries.md)
