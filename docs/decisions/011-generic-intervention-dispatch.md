# ADR-011: Generic Intervention Dispatch

| Field         | Value                             |
| ------------- | --------------------------------- |
| **Status**    | `accepted`                        |
| **Type**      | `Type 1 (two-way door)`           |
| **Domain**    | `Driver Contract / Orchestration` |
| **Date**      | `2026-04-15`                      |
| **Author(s)** | `Claude`                          |
| **Reviewers** | `Accepted 2026-04-15`             |

## Context

No reference app or provider runtime exposes pause or steer as driver-level operations. Vercel AI SDK uses a registry plus middleware pattern for cross-cutting concerns. Codex treats steer as a protocol-level turn extension, not a driver capability. Pause is fundamentally an orchestration concern: stop the run after the step in flight and persist its state. Encoding specific intervention verbs into the driver interface creates rigidity -- each new intervention type would require an interface change.

## Problem Statement

How should the driver contract expose mid-run interventions (pause, steer, and future verbs) without coupling every new intervention type to an interface change?

### Trigger

Neither reference apps nor provider runtimes support pause natively, and the list of interventions (steer, interject, reprioritize) keeps growing. A `pauseRun` method and capability flag, and one more of each for every later verb, would keep expanding the interface, so the contract needs a generic dispatch pattern before driver implementations multiply.

## Decision

Add `applyIntervention(type, payload)` as a generic dispatcher in the driver contract. `pause` is not a capability flag. Pause is an orchestration-layer construct: the daemon stops the run after the step in flight — with the provider's own hooks, registered for the session, where the provider has them, and with a boundary interrupt where it does not — and persists conversation history and run state. Nothing is queued to resume it: the same toggle, or anything sent to the run, continues it from where it stopped. Where the pause is a hook holding the agent's next tool call, the hold has no time limit and ends only by an answer, allow or deny, never by the hook timing out ([Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior)). Steer and other future interventions follow the same generic dispatch path.

**Authorization.** The caller of `applyIntervention` is the connection, which carries its device: on the daemon's local socket one of the owner's own clients, admitted by socket reachability and the session token; a linked device only inside its encrypted channel to the machine, from a device key the account's statement chain trusts. The write records the device it came from, never a person, and nothing checks session ownership or run authorship. A request carries no actor field.

**One intervention crosses a session boundary.** An interrupt taken on a session that is trading messages with another session ends the turn on both and empties the queue between them. It stays one ordinary interrupt per run: the daemon reads the pair from its own exchange table, dispatches the same `applyIntervention` call the single-session path dispatches to each of the two runs, and draws the outcome on each transcript ([Spec-014 §Sessions Talking To Each Other](../specs/014-multi-agent-orchestration.md#sessions-talking-to-each-other)). It is a **fan-out over the runs already in the exchange, not a cascade primitive**: no new intervention type is added, no verb spans two sessions, and the reach stops at the pair the table names — a session the interrupted pair was not talking to is untouched. Encoding the fan-out as its own verb is the rigidity this record rejected for pause.

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
- [Spec-003: Queue Steer Pause Resume](../specs/003-queue-steer-pause-resume.md)
- [ADR-005: Provider Drivers Use A Normalized Interface](./005-provider-drivers-use-a-normalized-interface.md)
- [Vercel AI SDK Registry Pattern](https://sdk.vercel.ai/docs)
