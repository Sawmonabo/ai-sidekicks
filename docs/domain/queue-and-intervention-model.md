# Queue And Intervention Model

## Purpose

Define how deferred work is stored and how control actions against active or queued work are represented.

## Scope

This document covers `QueueItem` and `Intervention`.

## Definitions

- `QueueItem`: a persisted unit of deferred work waiting for execution admission.
- `Intervention`: an auditable control action against an active run or queued work item.
- `Admission`: the agent taking a queue item. A message sent while a run is active is admitted into that same run at its next step boundary; orchestration-authored work is admitted as a new run.

## What This Is

This model defines how the system stores follow-up work, prioritizes it, and records deliberate changes to execution.

## What This Is Not

- A queue item is not a run.
- A queue is not a client draft buffer.
- An intervention is not a normal user message.

## Invariants

- Queue items are persisted by the runtime, not only by the client.
- Every queue item belongs to exactly one session and targets a defined execution context.
- Every intervention has an origin, a target, a timestamp, and an outcome.
- Every intervention records the **origin** it was admitted through — `user` or `system` — and, on the `user` arm only, the device it came from: the machine's own screen or a linked device's channel, as the daemon finds it from the connection at acceptance. No request names a person, and the device is never an authorization input ([Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior)). A queued message records its device the same way, and an orchestration-authored queue item records none. The two arms are exhaustive and mutually exclusive, so a system-originated intervention carries no device and can never be mistaken for a user's act.
- Queue admission and intervention effects must be visible in the session timeline.
- A failed or downgraded intervention must still be recorded as an outcome.

## Relationships To Adjacent Concepts

- A `QueueItem` that is a user message sent while a run is active is delivered into that run; an orchestration-authored `QueueItem` starts a new `Run` when it is admitted.
- An `Intervention` targets a `Run` via `targetRunId`. Queue-item cancellation uses `QueueItemCancel`, not the intervention model.
- `Approval` can be required before certain interventions take effect.

## State Model

Queue item states:

| State | Meaning |
| --- | --- |
| `queued` | Waiting for admission. |
| `admitted` | Taken by the agent. A user message sent while a run is active is admitted into that run at its next step boundary, on both V1 providers, and never becomes a second run ([Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior)); an orchestration-authored item is admitted as a new run. |
| `superseded` | Replaced in place by an edit before the agent took it: the edit is one `run.queueCreate` carrying `replacesQueueItemId`, the edited message keeps the old item's place, and the old item stays in history reading `superseded`. |
| `canceled` | Removed before the agent took it (`Remove`, `run.queueCancel`); nothing reaches the agent. |
| `not_delivered` | The daemon took the message but could not deliver it: it waited longer than the daemon's own delivery timeout, or its delivery failed outright. The item carries its reason and is sent again from itself (`Retry`). While the daemon is only unreachable the item stays `queued` and reads as waiting to be delivered. |

Intervention states:

| State | Meaning |
| --- | --- |
| `requested` | Recorded and awaiting evaluation. |
| `accepted` | Determined to be valid for the target. |
| `applied` | Successfully changed runtime or scheduling state. |
| `rejected` | Determined to be invalid or unauthorized. Authorization failure produces `rejected`. |
| `degraded` | The intervention took partial or fallback effect, with the outcome detail naming what degraded: the driver could not deliver the type at all — neither through a provider verb of its own nor through the orchestration leg above it — and the orchestration layer fell back (e.g., a driver that can accept nothing mid-run degrades steer to queue plus interrupt; neither V1 provider is such a driver). |
| `expired` | No longer meaningful because the target state changed first. Version guard mismatch produces `expired`. |

### Intervention State Transition Table

| From | To | Trigger | Condition |
| --- | --- | --- | --- |
| `requested` | `accepted` | Valid target, authorized | Target run is in a state that accepts this intervention type |
| `requested` | `rejected` | Invalid target, unauthorized, or static capability refusal | Target run state incompatible, the policy refuses it, or the type has no documented fallback under a driver capability exclusion (`driver.capability_unsupported` — §Driver Result To Lifecycle Mapping) |
| `requested` | `expired` | Version guard mismatch | `expectedRunVersion` does not match current run version |
| `accepted` | `applied` | Driver successfully executed | Provider confirmed the intervention took effect |
| `accepted` | `degraded` | Driver fallback used | Driver can deliver this type neither natively nor through the orchestration leg above it, and the orchestration layer fell back — a path neither V1 provider reaches |
| `accepted` | `expired` | Target state changed | Run transitioned between accept and apply (e.g., run completed before steer could be applied) |

## Intervention Entity Relationship

- `InterventionRequest`: the inbound command that initiates an intervention.
- `InterventionResult`: the outcome record produced after evaluation and execution.
- `Intervention`: the lifecycle entity encompassing both the request and the result.

Lifecycle: an `InterventionRequest` is created by a user or the orchestration layer, validated against the target run state and version guard, and then produces an `Intervention` entity that progresses through the state transitions defined above. When the intervention reaches a terminal state (`applied`, `rejected`, `degraded`, or `expired`), the system records an `InterventionResult` capturing the final outcome and any fallback action taken.

One `InterventionRequest` produces exactly one `Intervention`, which produces exactly one `InterventionResult`. This is a strict 1:1:1 cardinality.

The `interventions` SQLite table (Plan-002) stores the full lifecycle entity — request fields, current state, and result — in a single row rather than splitting request and result into separate tables. See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for column definitions.

## Intervention Payloads

Intervention payloads are a discriminated union by type:

- `steer`: `{targetRunId, expectedTurnId?, expectedRunVersion, clientIdempotencyKey, content, attachments?}`
- `interrupt`: `{targetRunId, expectedRunVersion, clientIdempotencyKey, reason?}`
- `cancel`: `{targetRunId, expectedRunVersion, clientIdempotencyKey, reason?}`

All intervention types carry a **mandatory** version guard (`expectedRunVersion`) — the guard is **fail-closed**: the comparand is required on every intervention request and an absent comparand is **rejected**, never applied (an optional guard would let a caller bypass stale-replay protection by omitting the field). See [Spec-003 §Interfaces And Contracts](../specs/003-queue-steer-pause-resume.md#interfaces-and-contracts) and [Plan-002 D-002-2](../plans/002-queue-steer-pause-resume.md). A guard mismatch produces `expired`. An authorization failure produces `rejected`.

All intervention types also carry a **mandatory** requester-generated `clientIdempotencyKey` (UUID; [Spec-004 §Required Behavior](../specs/004-provider-driver-contract-and-capabilities.md#required-behavior)). The daemon persists it on the `interventions` row (`UNIQUE(target_run_id, client_idempotency_key)`) and applies replay-or-conflict semantics: an identical retry returns the originally recorded outcome without re-dispatching the driver; reuse of a key with a differing payload is rejected as `intervention.idempotency_conflict`. For a steer's `content`, same-vs-differing is adjudicated by comparing the stored text with the retry's, as plain text ([Spec-003 §Interfaces And Contracts](../specs/003-queue-steer-pause-resume.md#interfaces-and-contracts)). The guards are orthogonal — `expectedRunVersion` defeats stale replays of **outdated** intent, `clientIdempotencyKey` defeats duplicate applications of the **same** intent. System-originated interventions (the orchestration layer’s spend-limit and token-limit interrupts — ADR-011 dispatch, Plan-013) carry a key synthesized by the daemon’s origination path at enqueue time under the same replay-or-conflict semantics; the field keeps its wire-standard `client` prefix because the requester is the client toward the driver boundary.

## Field-Level Consistency

The following field inventory maps each intervention payload to its sources.

**`steer` payload:**

| Field | Required | Source: API Contracts | Source: Spec-004 `ApplyInterventionParams` |
| --- | --- | --- | --- |
| `targetRunId` | yes | `InterventionRequestPayload` | `ApplyInterventionParams.targetRunId` |
| `expectedRunVersion` | yes | `InterventionRequestPayload` | `ApplyInterventionParams.expectedRunVersion` |
| `clientIdempotencyKey` | yes | `InterventionRequestPayload` | `ApplyInterventionParams.clientIdempotencyKey` |
| `content` | yes | `InterventionRequestPayload` | `SteerPayload.content` |
| `attachments` | no | `InterventionRequestPayload` (optional, `ArtifactId[]`) | `SteerPayload.attachments` (optional, `ArtifactId[]`) |
| `expectedTurnId` | no | `InterventionRequestPayload` (optional) | `SteerPayload.expectedTurnId` (optional) |

At-rest routing: `content` rests on the durable intervention row in its `payload` column, as plain text like every other column ([Spec-003 §State And Data Implications](../specs/003-queue-steer-pause-resume.md#state-and-data-implications)), and the driver leg is handed the same text. `attachments` are references, not bodies.

Element type: both `attachments` columns above are `ArtifactId[]` — ids into [Spec-012](../specs/012-artifacts-files-and-attachments.md)'s manifest space. The two are one carrier seen from its two ends, so the ordering rule, the cause-bearing unresolved-marker rule, and both count bounds are stated once, on `SteerPayload` in [api-payload-contracts.md §Plan-003 — Provider Driver Contract (Internal Interface)](../architecture/contracts/api-payload-contracts.md#plan-003--provider-driver-contract-internal-interface), and cited from the intervention arm rather than restated.

**`interrupt` payload:**

| Field | Required | Source: API Contracts | Source: Spec-004 `ApplyInterventionParams` |
| --- | --- | --- | --- |
| `targetRunId` | yes | `InterventionRequestPayload` | `ApplyInterventionParams.targetRunId` |
| `expectedRunVersion` | yes | `InterventionRequestPayload` | `ApplyInterventionParams.expectedRunVersion` |
| `clientIdempotencyKey` | yes | `InterventionRequestPayload` | `ApplyInterventionParams.clientIdempotencyKey` |
| `reason` | no | `InterventionRequestPayload` (optional) | `InterruptPayload.reason` (optional) |

**`cancel` payload:**

| Field | Required | Source: API Contracts | Source: Spec-004 `ApplyInterventionParams` |
| --- | --- | --- | --- |
| `targetRunId` | yes | `InterventionRequestPayload` | `ApplyInterventionParams.targetRunId` |
| `expectedRunVersion` | yes | `InterventionRequestPayload` | `ApplyInterventionParams.expectedRunVersion` |
| `clientIdempotencyKey` | yes | `InterventionRequestPayload` | `ApplyInterventionParams.clientIdempotencyKey` |
| `reason` | no | `InterventionRequestPayload` (optional) | `CancelPayload.reason` (optional) |

Note: The `ApplyInterventionParams` interface in Spec-004 splits the payload into `targetRunId`, `expectedRunVersion`, and `clientIdempotencyKey` at the top level and routes the remaining type-specific fields through `SteerPayload`, `InterruptPayload`, or `CancelPayload`. The `InterventionRequestPayload` in the API contracts flattens all fields into a single discriminated union. Both representations carry the same field set per intervention type. The `DriverInterventionResult` returned by the driver uses `status: 'applied' | 'degraded'` — the orchestration layer maps this to the full 6-state lifecycle per the normative table below.

## Driver Result To Lifecycle Mapping

The driver-result and intervention-lifecycle vocabularies are distinct and map normatively ([Spec-004 §Required Behavior](../specs/004-provider-driver-contract-and-capabilities.md#required-behavior)). The driver-level result vocabulary is exactly `applied | degraded`; a driver never produces `rejected` or `expired`, and the daemon never reclassifies a driver verdict.

| Lifecycle state | Producer | Trigger |
| --- | --- | --- |
| `requested` / `accepted` | daemon (pre-dispatch) | Recording and validation states before any driver involvement |
| `rejected` | daemon (pre-dispatch) | Authorization failure or invalid target — the driver is never invoked |
| `expired` | daemon | `expectedRunVersion` guard mismatch (pre-dispatch), or target state changed between accept and apply |
| `applied` | driver → daemon | Driver returned `status: 'applied'` — the intervention was delivered, whether by the driver's own provider verb or by the orchestration leg above it |
| `degraded` | driver → daemon; or daemon (post-driver) | Driver returned `status: 'degraded'` — the type could be delivered neither by a provider verb of the driver's own nor by the orchestration leg above it, so the orchestration layer fell back (`fallbackAction`), which neither V1 provider reaches |

Static capability refusal is a separate, earlier path with a narrow carve-out: the daemon MAY refuse dispatch outright with `driver.capability_unsupported` ONLY for an intervention type that has no documented orchestration fallback under the excluded flag. A type with a documented fallback — one a driver can neither perform natively nor have performed for it above the driver, which degrades to the queue+interrupt composite per [Spec-004 §Fallback Behavior](../specs/004-provider-driver-contract-and-capabilities.md#fallback-behavior-1) — MUST enter the lifecycle and terminate `degraded`, so the fallback is recorded on the intervention row (`fallbackAction`); **neither V1 provider reaches that path**, Claude declaring `steer: true` and delivering the steer inside the same run. Static refusal never substitutes for a documented degraded path ([Plan-003](../plans/003-provider-driver-contract-and-capabilities.md) adjudicates the static/dynamic split within that rule).

## Boundary: Interventions vs Interactive Requests

- `respondToRequest` (from Spec-004 `ProviderDriver` interface) is the driver's mechanism for handling PROVIDER-initiated interactive requests (tool confirmations, clarification questions). It is REACTIVE — the provider asked for input.
- `applyIntervention(type: "steer")` is USER-initiated content injection into an active run. It is PROACTIVE — the user wants to redirect.
- The two never overlap: a steer targets a `running` state, a response targets a `waiting_for_input` state.
- `interrupt` intervention targets `running` specifically — it stops active computation.
- `cancel` intervention targets any non-terminal state — it ends the run regardless of whether it is `running`, `paused`, or waiting.
- Undo is not an intervention. `Undo to here` on the person's own message, a snapshot's `Restore` and the rewind menu's rows are one operation, `session.restore({ target, scope })`: `target` is a stable message or snapshot identity, never a numeric or provider position, and `scope` is `"conversation-and-files"`, `"conversation"` or `"files"`. `session.restorePreview` takes the same and changes nothing. The result carries `requested` (the same values), `restored` (`"conversation-and-files"`, `"conversation"`, `"files"` or `"nothing"`) and, for each requested part that did not apply, `failures.conversation` / `failures.files` with a `reason`; edit and resend is the same call carrying the edited message, one intent with one result. Every outcome is stored as one event, `session.restore_finished`, and `run.rolled_back` records the conversation cut alone ([Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior)). The conversation half is the driver's `rewindConversation`; the driver's `forkConversation` serves `session.fork` and is never an undo. An undo is never refused because the run is `running`: it stops the later work and ends the turn itself ([Run State Machine §Rollback Transitions](run-state-machine.md#rollback-transitions)).
- Queue-item cancellation (`QueueItemCancel`) is separate from `cancel` intervention — `QueueItemCancel` targets queue items the agent has not yet taken (`Remove`, `run.queueCancel`), while `cancel` intervention targets runs that already exist in the run state machine.

## Example Flows

- Example: A queued follow-up becomes a persisted `QueueItem` and is later steered into the active run.
- Example: A user presses `Pause` on a running task. The daemon stops the run through the provider's own hooks, registered for the session and never written to a file: on a Claude Code lead one hook ends the turn after the step in flight and another denies any tool call while paused; on a child, on either provider, the daemon's pre-tool hook holds the child's next tool call; on a Codex lead the daemon's pre-tool hook holds the next call, the daemon sends `turn/interrupt`, and the hook denies the parked call. The daemon persists the run's state; the second press, or any send, continues it from exactly where it stopped (`turn/start` on Codex). No intervention is recorded and no resume event is queued; the driver never needs to know about pause.
- Example: A user edits a waiting follow-up before the agent takes it. The edit is one `run.queueCreate` carrying `replacesQueueItemId`: the old item is marked `superseded`, not silently discarded, and the edited message keeps its place in the order.

## Edge Cases

- A steer intervention against a run whose driver can deliver the type neither natively nor through the orchestration leg above it must be rejected or degraded to a new queue item explicitly. Both V1 providers declare `steer: true` and deliver a steer inside the running run, so neither reaches that case.
- A waiting message has a deadline: once it has waited longer than the daemon's own delivery timeout it is `not_delivered`, carries its reason and can be sent again from itself. While the daemon is only unreachable it keeps waiting.
- A canceled queue item remains in history for audit and replay.

## Related Specs

- [Queue Steer Pause Resume](../specs/003-queue-steer-pause-resume.md)
- [Provider Driver Contract And Capabilities](../specs/004-provider-driver-contract-and-capabilities.md)
- [Session Event Taxonomy And Audit Log](../specs/005-session-event-taxonomy-and-audit-log.md)
- [Persistence Recovery And Replay](../specs/013-persistence-recovery-and-replay.md)

## Related ADRs

- [Daemon Backed Queue And Interventions](../decisions/003-daemon-backed-queue-and-interventions.md)
- [Generic Intervention Dispatch](../decisions/011-generic-intervention-dispatch.md)
