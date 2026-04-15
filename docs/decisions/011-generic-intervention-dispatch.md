# ADR-011: Generic Intervention Dispatch

| Field | Value |
| -------------- | ------------------------------------------------------------------------ |
| **Status** | `accepted` |
| **Domain** | `Driver Contract / Orchestration` |
| **Date** | `2026-04-15` |
| **Author(s)** | `Claude` |

## Context

No reference app or provider runtime exposes pause or steer as driver-level operations. Vercel AI SDK uses a registry plus middleware pattern for cross-cutting concerns. Codex treats steer as a protocol-level turn extension, not a driver capability. Pause is fundamentally an orchestration concern: interrupt the run, persist state, queue a resume event. Encoding specific intervention verbs into the driver interface creates rigidity -- each new intervention type would require an interface change.

## Decision

Add `applyIntervention(type, payload)` as a generic dispatcher in the driver contract. Remove `pause` from capability flags. Pause becomes an orchestration-layer construct: the daemon interrupts the run, persists checkpoint state, and queues a resume event. Steer and other future interventions follow the same generic dispatch path.

## Alternatives Considered

### Option A: Generic `applyIntervention` Dispatcher (Chosen)

- **What:** A single extensible method on the driver contract that accepts an intervention type and payload.
- **Steel man:** New intervention types require no interface changes. Keeps the driver contract stable and minimal.

### Option B: Specific `pauseRun` / `steerRun` Methods (Rejected)

- **What:** Add named methods for each intervention type to the driver interface.
- **Why rejected:** Rigid. Every new intervention verb requires a driver interface change and implementation across all providers.

### Option C: Keep `pause` as a Capability Flag Set to `false` (Rejected)

- **What:** Retain the flag in the capability set but always return `false`.
- **Why rejected:** Dead weight. A permanently-false flag signals nothing useful and confuses implementers.

## Consequences

### Positive

- Driver interface stays stable as new intervention types are added
- Pause semantics live in the orchestration layer where they belong
- Matches how reference apps handle mid-run control

### Negative (accepted trade-offs)

- Generic dispatch is less self-documenting than named methods; consumers must consult intervention type documentation
- Type safety requires a discriminated union or type registry rather than method signatures

## References

- [ADR-003: Daemon-Backed Queue And Interventions](./003-daemon-backed-queue-and-interventions.md)
- [ADR-005: Provider Drivers Use A Normalized Interface](./005-provider-drivers-use-a-normalized-interface.md)
- [Vercel AI SDK Registry Pattern](https://sdk.vercel.ai/docs)
