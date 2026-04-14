# Observability Architecture

## Purpose

Define how the system exposes runtime truth for debugging, audit, replay, and operational response.

## Scope

This document covers logs, traces, metrics, canonical event visibility, replay, and failure diagnostics.

## Context

A collaborative agent runtime is only operable if humans and agents can understand what happened, what is happening now, and what failed. Observability must therefore span local execution and shared coordination.

## Responsibilities

- provide a canonical event history for replay and audit
- expose live runtime status, traces, and metrics for local and shared services
- support operator diagnosis of stuck runs, provider failures, and session desyncs
- power user-facing timeline and attention surfaces from authoritative data

## Component Boundaries

| Component | Responsibility |
| --- | --- |
| `Canonical Event Log` | Durable ordered history of session and run events. |
| `Metrics Layer` | Runtime health, queue depth, run latency, failure-rate, and projection-lag metrics. |
| `Tracing Layer` | Cross-component request and execution traces for local daemon and control-plane flows. |
| `Audit Projection` | Human-readable history of approvals, interventions, artifacts, and membership changes. |
| `Replay Service` | Rebuilds or rehydrates projections from canonical events. |

## Data Flow

1. Local daemon and control-plane components emit canonical events, metrics, and traces.
2. Observability pipelines store or forward those signals to local and shared sinks.
3. Replay and audit projections derive structured views from the canonical event log.
4. Clients and operators read those projections to understand live state and past actions.

## Trust Boundaries

- Audit data must preserve provenance and tamper visibility.
- Reasoning or tool-output observability must respect artifact visibility and permission policy.
- Shared telemetry must not expose machine-local secrets that were never meant to leave the runtime node.

## Failure Modes

- Metrics and traces are healthy but canonical event projection is stale, producing misleading UI.
- Replay cannot rebuild projections because event integrity is broken or retained history is incomplete.
- Operator diagnostics expose more data than a participant is authorized to view.

## Related Domain Docs

- [Run State Machine](../domain/run-state-machine.md)
- [Queue And Intervention Model](../domain/queue-and-intervention-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

## Related Specs

- [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md)
- [Live Timeline Visibility And Reasoning Surfaces](../specs/013-live-timeline-visibility-and-reasoning-surfaces.md)
- [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md)
- [Observability And Failure Recovery](../specs/020-observability-and-failure-recovery.md)

## Related ADRs

- [SQLite Local State And Postgres Control Plane](../decisions/004-sqlite-local-state-and-postgres-control-plane.md)
