# Provider Failure Runbook

## Purpose

Diagnose and contain driver-level provider failures that affect run execution or recovery.

## Symptoms

- New runs fail during `starting`
- Active runs enter recovery-needed or provider-failed states
- Driver capability data is missing or inconsistent
- Scope and blast radius: one provider driver, one RuntimeNode, or all nodes using the same driver

## Detection

- Inspect provider health projections and capability refresh status
- Check driver-specific runtime binding recovery failures
- Read canonical failure events for affected runs and compare with driver logs

## Preconditions

- Access to the affected RuntimeNode
- Access to driver logs and runtime binding state
- Ability to disable new scheduling to the affected driver if needed

## Recovery Steps

1. Identify whether the failure is startup, active-run, capability-refresh, or resume-related.
2. Stop routing new work to the affected driver until health is understood.
3. Attempt driver health refresh and resume-handle adoption or resume if the failure is recovery-related.
4. If resume is impossible, mark affected runs as recovery-failed and surface operator action rather than silently recreating sessions.
5. Re-enable scheduling only after a known-good test run starts, streams events, and reaches a terminal state or blocking state normally.

## Validation

- Driver health returns to expected status
- Capability projection matches supported controls
- One test run succeeds or blocks cleanly without unexpected driver errors

## Escalation

- Escalate when a driver regression affects multiple nodes, resume failures are systemic, or provider transport semantics have changed without a compatible driver update

## Related Architecture Docs

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Observability Architecture](../architecture/observability-architecture.md)

## Related Specs

- [Provider Driver Contract And Capabilities](../specs/005-provider-driver-contract-and-capabilities.md)
- [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md)
- [Observability And Failure Recovery](../specs/020-observability-and-failure-recovery.md)

## Related Plans

- [Provider Driver Contract And Capabilities](../plans/005-provider-driver-contract-and-capabilities.md)
