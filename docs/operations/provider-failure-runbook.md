# Provider Failure Runbook

## Purpose

Diagnose and contain driver-level provider failures that affect run execution or recovery.

## Symptoms

- New runs fail during `starting`
- Active runs enter `recovering` and later remain `failed` with `provider failure` detail or visible `recovery-needed` condition
- Driver capability data is missing or inconsistent
- Scope and blast radius: one provider driver, one RuntimeNode, or all nodes using the same driver

## Detection

- Read `HealthStatusRead` and `FailureDetailRead` for the affected run or RuntimeNode.
- Inspect driver capability refresh status and the latest `RuntimeBindingRead` for affected recovery handles.
- Compare canonical failure events with driver logs for startup failure, transport failure, capability refresh failure, or resume failure.

## Preconditions

- Access to the affected RuntimeNode
- Access to driver logs and runtime binding state
- Ability to disable new scheduling to the affected driver if needed

## Recovery Steps

1. Identify whether the failure is startup, active-run, capability-refresh, or resume-related.
2. Stop routing new work to the affected driver until health is understood.
3. If the failure is recovery-related, issue one bounded `RecoveryActionRequest` for driver health refresh and resume-handle adoption or resume.
4. If resume is impossible or the bounded recovery action fails, mark affected runs as `failed` with `provider failure` detail and visible `recovery-needed` condition rather than silently recreating sessions.
5. Re-enable scheduling only after a known-good test run starts, streams events, and reaches a terminal or valid blocking state normally.

## Validation

- Driver health returns to expected status
- Capability projection matches supported controls
- One test run succeeds or blocks cleanly without unexpected driver errors
- No affected run remains stuck in `recovering` without updated failure or recovery detail

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
