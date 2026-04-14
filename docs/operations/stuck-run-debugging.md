# Stuck Run Debugging

## Purpose

Diagnose runs that appear active but are no longer making observable progress.

## Symptoms

- Run stays in `running` or `starting` without new progress events beyond the stuck threshold
- UI shows activity spinner without new timeline rows
- Scope and blast radius: one run, sometimes one driver or one RuntimeNode

## Detection

- Read `StuckRunInspect` or equivalent health projection
- Compare current run state with last canonical event time and last driver heartbeat
- Check whether the run is actually blocked on approval or input instead of truly stuck

## Preconditions

- Access to the affected session and RuntimeNode
- Ability to inspect run state, queue state, and provider health
- Authority to interrupt or retry the run if needed

## Recovery Steps

1. Confirm the run is not in a legitimate blocking state such as approval or input wait.
2. Inspect last progress event, driver health, and workspace health for the run.
3. If the driver is healthy but the run is stalled, issue a safe interrupt and record the outcome.
4. If interrupt succeeds, decide whether to queue a retry or create a replacement run.
5. If interrupt cannot be delivered, treat the situation as provider or daemon recovery failure and follow the relevant runbooks.

## Validation

- The run reaches a terminal or valid blocking state
- No orphaned queue or intervention state remains attached to the run
- Replacement work, if created, starts with clear provenance

## Escalation

- Escalate when repeated stuck runs cluster by driver, node, or specific workspace and cannot be cleared through safe interrupt

## Related Architecture Docs

- [Observability Architecture](../architecture/observability-architecture.md)
- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)

## Related Specs

- [Queue Steer Pause Resume](../specs/004-queue-steer-pause-resume.md)
- [Observability And Failure Recovery](../specs/020-observability-and-failure-recovery.md)

## Related Plans

- [Queue Steer Pause Resume](../plans/004-queue-steer-pause-resume.md)
- [Provider Driver Contract And Capabilities](../plans/005-provider-driver-contract-and-capabilities.md)
