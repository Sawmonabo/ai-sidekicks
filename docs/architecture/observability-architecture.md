# Observability Architecture

## Purpose

Define how the system exposes runtime truth for debugging, audit, rebuild, and operational response.

## Scope

This document covers logs, traces, health signals, canonical event visibility, rebuild, and failure diagnostics.

## Context

An agentic coding runtime is only operable if the user and their agents can understand what happened, what is happening now, and what failed. Observability must therefore span local execution and control-plane coordination.

## Responsibilities

- provide a canonical event history for rebuild and audit
- expose live runtime status and traces for the local daemon and the control plane
- support the person's own diagnosis of provider failures and session desyncs on the machine, through the daemon's diagnostic logs and `sidekicks daemon status`
- power user-facing transcript and attention surfaces from authoritative data

## Component Boundaries

| Component | Responsibility |
| --- | --- |
| `Canonical Event Log` | Durable ordered history of session and run events. |
| `Health Signals` | Runtime health, queue state, and run latency and duration, given out in the daemon's diagnostic logs and `sidekicks daemon status`. |
| `Tracing Layer` | Cross-component request and execution traces for local daemon and control-plane flows. |
| `Audit Projection` | Human-readable history of approvals, interventions, and artifacts. A device's `device.linked`, `device.renamed` and `device.revoked` are statements on the account's statement chain, kept because the machines verify them and never shown as an activity list. |
| `Projection Rebuild Service` | Rebuilds or rehydrates projections from canonical events. |

## Data Flow

1. Local daemon and control-plane components emit canonical events, health signals, and traces.
2. Each component stores its signals where they are produced; none is forwarded to a shared sink.
3. Session and audit projections derive structured views from the canonical event log.
4. Clients read those projections to understand live state and past actions.

## Trust Boundaries

- Audit data must preserve provenance.
- Reasoning or tool-output observability must respect artifact visibility and permission policy.
- Diagnostic logs and traces stay where they are written, and none carries a machine-local secret off the runtime node.

## Failure Modes

- Health signals and traces look healthy but canonical event projection is stale, producing misleading UI.
- Projections cannot be rebuilt because retained history is incomplete.
- Diagnostics on the person's relay record more than the relay may see. The relay carries sealed channel frames and knows only ids, the channel profile, frame sizes and times; a diagnostic surface that logs anything beyond that breaks the boundary.

## Related Domain Docs

- [Run State Machine](../domain/run-state-machine.md)
- [Queue And Intervention Model](../domain/queue-and-intervention-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

## Related Specs

- [Session Event Taxonomy And Audit Log](../specs/005-session-event-taxonomy-and-audit-log.md)
- [Transcript And Reasoning](../specs/011-transcript-and-reasoning.md)
- [Persistence And Recovery](../specs/013-persistence-and-recovery.md)
- [Observability And Failure Recovery](../specs/018-observability-and-failure-recovery.md)

## Related ADRs

- [SQLite Local State And Postgres Control Plane](../decisions/004-sqlite-local-state-and-postgres-control-plane.md)
