# Provider Failure Runbook

## Purpose

Diagnose and contain driver-level provider failures that affect run execution or recovery.

## Symptoms

- New runs fail during `starting`
- Active runs transition to `failed` with `provider failure` detail or visible `recovery-needed` condition
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
- No affected run remains stuck in a non-terminal state without updated failure or recovery detail

## Escalation

- Escalate when a driver regression affects multiple nodes, resume failures are systemic, or provider transport semantics have changed without a compatible driver update

## CLI Commands

```bash
sidekicks driver status
sidekicks driver capabilities <driver-name>
sidekicks run retry <run-id>
sidekicks driver health <driver-name>
sidekicks driver logs <driver-name> --tail 50
sidekicks run inspect <run-id> --failure-detail
```

## SLOs and Thresholds

| Metric                                    | Target                                            |
| ----------------------------------------- | ------------------------------------------------- |
| Provider response timeout                 | 30s                                               |
| Retry budget                              | 3 attempts with exponential backoff (1s, 5s, 15s) |
| Provider driver capability probe interval | every 15s                                         |
| Capability refresh latency                | < 5s                                              |
| Recovery action timeout                   | 60s                                               |

## On-Call Routing

- **Severity 1** (service down): Page on-call engineer immediately. Escalate to team lead after 15min.
- **Severity 2** (degraded): Alert on-call via Slack. Investigate within 30min.
- **Severity 3** (warning): Log alert. Review during business hours.
- **Domain routing**: Provider issues route to **integrations on-call**.

## Related Architecture Docs

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Observability Architecture](../architecture/observability-architecture.md)

## Related Specs

- [Provider Driver Contract And Capabilities](../specs/005-provider-driver-contract-and-capabilities.md)
- [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md)
- [Observability And Failure Recovery](../specs/020-observability-and-failure-recovery.md)

## Related Plans

- [Provider Driver Contract And Capabilities](../plans/005-provider-driver-contract-and-capabilities.md)
