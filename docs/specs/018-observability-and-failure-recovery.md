# Spec-018: Observability And Failure Recovery

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `018` |
| **Slug** | `observability-and-failure-recovery` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Persistence Recovery And Replay](../specs/013-persistence-recovery-and-replay.md), [Observability Architecture](../architecture/observability-architecture.md), [Data Architecture](../architecture/data-architecture.md) |
| **Implementation Plan** | [Plan-017: Observability And Failure Recovery](../plans/017-observability-and-failure-recovery.md) |

## Purpose

Define the contract by which the person detects failures, diagnoses them, and recovers from degraded runtime conditions.

## Scope

This spec covers failure categories, the daemon's health signals and where each is read, the product's retry rules, an app and its service on different versions, and degraded-mode behavior.

## Non-Goals

- Full incident response procedures
- Specific dashboards or vendor tooling
- Business analytics

## Domain Dependencies

- [Run State Machine](../domain/run-state-machine.md)
- [Queue And Intervention Model](../domain/queue-and-intervention-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

## Architectural Dependencies

- [Observability Architecture](../architecture/observability-architecture.md)
- [Data Architecture](../architecture/data-architecture.md)
- [ADR-003: Daemon Backed Queue And Interventions](../decisions/003-daemon-backed-queue-and-interventions.md)
- [ADR-004: SQLite Local State And Postgres Control Plane](../decisions/004-sqlite-local-state-and-postgres-control-plane.md)
- [ADR-005: Provider Drivers Use A Normalized Interface](../decisions/005-provider-drivers-use-a-normalized-interface.md)

## Required Behavior

- The daemon must keep health and failure signals for itself, provider drivers, replay state, queue state, control-plane connectivity, and run latency and run duration distributions, and it gives them out in two places, neither of them a console read: its diagnostic logs and `sidekicks daemon status`. No `health.*` read serves the console. Settings › Runtime shows the service's status as its supervisor reports it, and reads the service's processor and memory when the page opens and again on `Check again`, each reading stamped with its time, never on a timer.
- A failed recovery is never silent. A provider-session recovery that fails leaves the session showing that the provider ended, with `Restart`; a projection rebuild that fails puts the daemon in the degraded read-only mode of §Fallback Behavior.
- The person must be able to distinguish:
  - transport failure
  - provider failure
  - local persistence failure
  - projection failure
  - policy or approval blockage
- The person must be able to distinguish canonical `RunState` from derived health signals, failure categories, and recovery conditions.
- Degraded modes must be explicit and must preserve as much read visibility as possible.
- Non-canonical observability payloads such as driver raw events, raw command output, high-volume tool traces and the workflow engine's event record must use explicit bounded retention separate from canonical event and failure-detail retention.
- Losing the connection to the local daemon must be one explicit reading in one place — never a banner, a toast, a modal, or a badge. In the console that place is the session's working line: it turns amber, reads `Connection lost` where the action words stand, says `Reconnecting…` while the connection is still being retried and `Not connected.` once retrying has stopped, keeps the elapsed clock of a turn that was under way and omits it on an idle session, and carries a `Retry` at its right that asks for the connection again and says so while it tries. Nothing is said while the connection is healthy — no green line, no `Connected` word — and the reading raises no notification and no second mark anywhere ([Spec-017 §Required Behavior](017-notifications-and-attention-model.md#required-behavior)). It arms only once the daemon has answered at least once since the client started, so a client started into an outage reports a daemon that would not start rather than a connection that was lost.
- A connection gap must not empty what was already read. No session row dims, grays, moves, or leaves its list; no pane closes; no control is disabled; a draft keeps its text; a surface holding last-read facts keeps them until the daemon has re-read them rather than drawing its own empty state; and a list that could not be refreshed says only that it could not be refreshed. When the connection returns, the reading goes back to what it showed before, or away if nothing was running.
- A provider process that ends on its own under a running session is a provider failure the product states rather than absorbs. The statement names the provider and carries the exit code or signal the daemon observed — never one the product composed — with the last output the process produced before it went, so a person can tell whether restarting will help, and it offers a restart that puts the provider back on the same session. The turn that was running ends where it was and leaves one record in the session's transcript: live calls stop at the figure they reached, the approval the process held dies, the command it was waiting on ends, and the agents it had dispatched end with it — each reading as having ended with the process rather than as having been stopped by a person. It is never silent, never attributed to a person, and never reported as an interruption.
- A provider process the daemon slept is not a failure, and nothing on screen reports it. An idle Claude Code session is slept once it has been idle for 30 minutes and holds nothing the stop would end — no turn running, no message queued, no approval or question open, no background task, no pending wake-up or session-only scheduled job, no side question and no voice call. The next message to it wakes it through Claude Code's own resume on the same conversation, account, folder, settings and permission level, with nothing on screen: no banner, no row. Codex is never slept, and no process is stopped for memory pressure.
- The app and the service accept being one version apart: each app accepts the service version before its own. Outside that range the console is read-only, and the session's working line names in words the side that is behind — the background service or the app — with a press that opens its fix: the service update on Settings › Runtime, or the app update on Settings › General. There is no separate banner for it.
- The product's retry policy is the providers' own retries plus three bounded rules of the daemon's, and nothing else:
  - Claude Code retries a rate limit or an overload itself: ten tries over about three minutes, shown as `Retrying…` on the working line, and when they give out the turn ends with `<Provider> did not answer · Try again`. Codex retries a transport error itself, shown the same way. A plan limit is not retried on either provider.
  - The daemon retries a failed read for a pane — a diff, a file's lines, a directory listing — once, after 100 ms, before anything reaches the screen.
  - The daemon restarts a Codex service that died at once and resumes its conversations. A Codex service that dies three times within five minutes is left down, and each of its sessions shows that the provider ended, with `Restart`.
  - Nothing retries a turn on the person's behalf: `Try again` and `Restart` are the person's own acts.

  A driver marks a failure non-retryable and never defines a retry budget of its own.

## Default Behavior

- A run's failure detail, carried on its run event, remains durable after the diagnostic log files that hold raw payloads are deleted.

## Fallback Behavior

- If projection rebuild fails, the system enters degraded read-only mode instead of accepting unsafe new mutable work.
- If provider recovery fails, the affected run remains visible in canonical state `failed` with `provider failure` detail and `recovery-needed` condition rather than disappearing.
- If bounded diagnostic payload retention has expired, diagnosis must fall back to canonical events and the run event's failure detail rather than failing closed.

## Interfaces And Contracts

- No `health.*` method exists. What a runtime surface prints about the service — whether it is answering, since when, its version, and how much of the machine's processor and memory it uses, each reading with the time it was taken — is `daemon.status.read` ([Plan-005 §Phase R1 — Namespace Handlers](../plans/005-local-ipc-and-daemon-control.md#phase-r1--namespace-handlers)), which Settings › Runtime and `sidekicks daemon status` read, backed by the supervisor's own status.
- A run's failure carries its machine-readable failure category on the run's state-transition event, with the recovery condition where one applies. For a provider process that exited, the session's record carries the exit code or signal the daemon observed and the last output the process produced, so the one-line statement is not the only evidence of why it went.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Failure and recovery signals must be derived from canonical state and observability pipelines.
- Recovery actions and outcomes must be auditable.
- Raw diagnostic payloads are non-canonical observability records with bounded retention and must not become the only source for audit or recovery truth.

## PII in Diagnostics

Diagnostic pipelines (driver raw events, raw command output, tool traces, the workflow engine's event record) carry PII-carrying content by default of their purpose — they capture the full model prompt, the full command arguments, the full tool-call result — so the baseline question is not _"does this carry PII"_ but _"what redaction and retention discipline keeps diagnostics from holding the person's content after they deleted it."_ This section establishes that discipline as a required-behavior policy; Spec-020 owns the storage-and-erasure side.

### Required Behavior (policy)

- **Nothing leaves the machine.** The daemon runs no telemetry exporter and sends no diagnostic content to any sink off the machine. The providers' own telemetry is pointed at the daemon on this machine and written to the service's own diagnostic logs, which drop it past `Keep diagnostic logs for`; none of it is forwarded to a telemetry destination the person set. Each request the daemon prices from it becomes an event on its session, the same spend event stream-priced requests write, so the inspector's `Cost` section counts it; it is never a transcript row. A crash report is built on the machine that crashed, stripped of personal data there, and kept there under `Keep crash reports`.
- **Bounded local retention.** Local diagnostic buckets (`driver_raw_events`, `command_output`, `tool_traces`, and `workflow_engine_events`, the files the workflow engine's event record of [Spec-015 §Engine event record (SA-41)](015-workflow-authoring-and-execution.md#engine-event-record-sa-41) writes, per [Spec-020 §PII Data Map](020-data-retention-and-gdpr.md#pii-data-map) bounded-retention tier) are log files in the daemon's data folder, never database tables, and MUST apply a 7-day TTL by default. `Keep diagnostic logs for` sets the TTL and takes any period.
- **Bound and erase.** Every diagnostic log file MUST be deleted whole once it is past `Keep diagnostic logs for` ([Spec-020 §Erasure Paths](020-data-retention-and-gdpr.md#erasure-paths) Path 3), and `Erase all data` deletes it with the data folder. A diagnostic pipeline that keeps PII-carrying records outside both is a spec violation. There is no per-person flush.
- **The two diagnostic switches record only while on.** `Record traces` and `Record raw provider messages`, on Settings › Runtime, are both off by default. While `Record traces` is off nothing is written to `tool_traces`; while `Record raw provider messages` is off nothing is written to `driver_raw_events`, the folder the page names. While it is on, `driver_raw_events` holds every message Claude Code or Codex sends the daemon, word for word, so a turn the daemon translated wrongly can be debugged. Each log they write is a diagnostic log under the bound and the erase above.

### Cross-Reference To Spec-020

- [Spec-020 §PII Data Map — bounded-retention tier](020-data-retention-and-gdpr.md#pii-data-map) — owns the durability-and-retention side of the diagnostic buckets
- [Spec-020 §Erasure Paths — Path 3](020-data-retention-and-gdpr.md#erasure-paths) — owns the age bound and the erase for the bounded-retention diagnostic tier

## Example Flows

- `Example: The Codex service for one account dies. The daemon restarts it at once and resumes its conversations, each transcript carrying one faint row that says so. It dies twice more within five minutes, so the daemon leaves it down: each of its sessions shows that Codex ended, with Restart, and nothing restarts it until the person presses Restart.`
- `Example: Replay rebuild fails on startup. The daemon enters degraded read-only mode, surfaces a recovery error, and refuses new mutable work until repaired.`

## Implementation Notes

- Observability is not separate from recovery; it is the mechanism that makes recovery safe to reason about.
- Failure categories should be enumerable and stable for automation and operations docs.
- Degraded read-only mode is preferable to silent partial mutation during uncertain recovery state.
- Operational handling for policy and approval blockage is covered by approval-UX surfaces in Spec-010 and is not a separate runbook in V1.

## Pitfalls To Avoid

- Treating all failures as generic provider errors
- Accepting new mutable work during uncertain replay state
- Hiding recovery failures behind silent retries only

## Acceptance Criteria

- [ ] No `health.*` method is registered, and Settings › Runtime shows the service status from `daemon.status.read`, with processor and memory read only when the page opens and on `Check again`.
- [ ] A Claude Code session slept after 30 idle minutes wakes on the next message with no banner and no row, and a Codex session is never slept.
- [ ] An app running against the service version before its own works normally; with any other pair of different versions the console is read-only and the working line names the side that is behind, with a press that opens its fix.
- [ ] A Codex service that dies three times within five minutes is not restarted a fourth time until the person presses `Restart`, and no turn is retried except by `Try again` or `Restart`.
- [ ] Recovery failures remain visible and auditable until resolved.

## Open Questions

None.

## References

- [Persistence Recovery And Replay](../specs/013-persistence-recovery-and-replay.md)
- [Observability Architecture](../architecture/observability-architecture.md)
- [Data Architecture](../architecture/data-architecture.md)
