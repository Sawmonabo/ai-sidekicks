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
- Every intervention has a target, a timestamp, and an outcome.
- Every intervention records the device it came from — the machine's own screen or a linked device's channel, as the daemon finds it from the connection at acceptance — and an empty device means the daemon's own stop. No request names a person, and the device is never an authorization input ([Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior)). A queued message records its device the same way, and an orchestration-authored queue item records none. A daemon stop carries no device, and its `agent.intervention.*` events carry `'daemon'` as their actor where a device's carry the device, so it can never be mistaken for a person's act.
- Queue admission and intervention effects must be visible in the session transcript.
- A failed or downgraded intervention must still be recorded as an outcome.

## Relationships To Adjacent Concepts

- A `QueueItem` that is a user message sent while a run is active is delivered into that run; an orchestration-authored `QueueItem` starts a new `Run` when it is admitted.
- An `Intervention` targets a `Run` via `targetRunId`. Queue-item cancellation uses `agent.queueItem.cancel`, not the intervention model.
- `Approval` can be required before certain interventions take effect.

## State Model

Queue item states:

| State | Meaning |
| --- | --- |
| `queued` | Waiting for admission. |
| `admitted` | Taken by the agent. A user message sent while a run is active is admitted into that run at its next step boundary, on every provider, and never becomes a second run ([Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior)); an orchestration-authored item is admitted as a new run. |
| `superseded` | Replaced in place by an edit before the agent took it: the edit is one `agent.queueItem.create` carrying `replacesQueueItemId`, the edited message keeps the old item's place, and the old item stays in history reading `superseded`. |
| `canceled` | Removed before the agent took it (`Remove`, `agent.queueItem.cancel`); nothing reaches the agent. |
| `notDelivered` | The daemon took the message but could not deliver it: the run it waited for waited at the memory gate longer than the daemon's own delivery timeout to start, and ended failed, or its delivery failed outright. The item carries its reason and is sent again from itself (`Retry`). While the daemon is only unreachable the item stays `queued` and reads as waiting to be delivered. A Claude Code message whose withdraw went unanswered reads `notDelivered` and turns `admitted` if Claude Code then shows it took it. |

Intervention states:

| State | Meaning |
| --- | --- |
| `requested` | Recorded and awaiting evaluation. |
| `accepted` | Determined to be valid for the target. |
| `applied` | Successfully changed runtime or scheduling state. |
| `rejected` | Determined to be invalid or unauthorized. Authorization failure produces `rejected`. |
| `degraded` | The intervention took partial or fallback effect, with the outcome detail naming what degraded: the driver could not deliver the type at all — neither through a provider verb of its own nor through the orchestration leg above it — and the orchestration layer fell back; neither Claude Code nor Codex reaches it. |
| `expired` | No longer meaningful because the run moved before dispatch: a version guard mismatch at acceptance, or the run's start failing while an interrupt waited for it, produces `expired`, as does a restart that finds a faster-model retry unsent, and the driver is never called. The daemon's own interrupt at a limit never expires: when its run ended first, the run's end is already done and its row ends `applied`. |
| `failed` | The dispatch threw, never completed (a daemon death among them), or was never sent because the run ended and was continued before it, so the request never stays `accepted`; the row records what was thrown, that the daemon restarted before the outcome, or that the run ended and was continued before the dispatch, as its `failureReason`. |

### Intervention State Transition Table

| From | To | Trigger | Condition |
| --- | --- | --- | --- |
| `requested` | `accepted` | Valid target, authorized | Target run is in a state that accepts this intervention type |
| `requested` | `rejected` | Invalid target, unauthorized, or static capability refusal | Target run state incompatible, the policy refuses it, or the type has no documented fallback under a driver capability exclusion (`provider.capability.unsupported` — §Driver Result To Lifecycle Mapping) |
| `requested` | `expired` | Version guard mismatch, or a restart found a retry unsent | `expectedRunVersion` does not match current run version, or the daemon went down before accepting a faster-model retry, and the restart expires it unsent |
| `requested` | `applied` | A restart found the stop pending | The daemon went down before accepting the stop, and the restart settles the run as the stop would have: `interrupted`, or `stopped` for the daemon's stop at the run's token limit, keeping the stop's reason |
| `accepted` | `applied` | Driver successfully executed | Provider confirmed the intervention took effect; an interrupt whose driver finds no turn in flight has nothing to cut and applies too, its run resting `interrupted`, or `stopped` for the daemon's stop at the run's token limit |
| `accepted` | `applied` | The daemon ended a run no driver has | An interrupt of a run in its setup gates, or of a run whose failed start could not write its end, leaves the run `interrupted` without calling a driver |
| `accepted` | `degraded` | Driver fallback used | Driver can deliver this type neither natively nor through the orchestration leg above it, and the orchestration layer fell back — a path neither Claude Code nor Codex reaches |
| `accepted` | `expired` | The run ended before dispatch | An interrupt waited for the run's start to settle, and a failed setup gate or a failed driver start ended the run meanwhile; the daemon's own interrupt at a limit moves to `applied` instead, since the run's end it asked for is done |
| `accepted` | `rejected` | The daemon's own leg refused | The faster-model retry the daemon carries out itself refused after acceptance |
| `accepted` | `applied` | A restart found the stop pending | The daemon went down before the stop's outcome, and the restart settles the run as the stop would have: `interrupted`, or `stopped` for the daemon's stop at the run's token limit, keeping the stop's reason |
| `accepted` | `failed` | Dispatch threw, never completed or was never sent | The driver or the leg above it threw instead of returning a verdict; the daemon died before the outcome, so a restart that finds a faster-model retry `accepted` ends it `failed`; or the daemon's own interrupt at its token or spend limit found its run ended and continued since its acceptance, so it is never sent and the continued run's own stop at that limit cuts it |

An interrupt's `applied` or `degraded` record and the run's state change — `interrupted`, or `stopped` for the daemon's stop at the run's token limit — commit in one write, so no restart finds one without the other; a run that ended first keeps its end, and the record lands alone. A restart's own settling of a run with a pending stop moves that stop's record to `applied` in the same write, and the run's state change carries the reason the stop recorded.

## Intervention Entity Relationship

- `InterventionRequest`: the inbound command that initiates an intervention.
- `InterventionResult`: the outcome record produced after evaluation and execution.
- `Intervention`: the lifecycle entity encompassing both the request and the result.

Lifecycle: an `InterventionRequest` is created by a user or the orchestration layer, validated against the target run state and version guard, and then produces an `Intervention` entity that progresses through the state transitions defined above. When the intervention reaches a terminal state (`applied`, `rejected`, `degraded`, `expired`, or `failed`), the system records an `InterventionResult` capturing the final outcome and any fallback action taken.

One `InterventionRequest` produces exactly one `Intervention`, which produces exactly one `InterventionResult`. This is a strict 1:1:1 cardinality.

The `interventions` SQLite table (Plan-002) stores the full lifecycle entity — request fields, current state, and a rejection's reason — in a single row rather than splitting request and outcome into separate tables. See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for column definitions.

## Intervention Payloads

Intervention payloads are a discriminated union by type:

- `interrupt`: `{targetRunId, expectedRunVersion, clientIdempotencyKey, pending, deliverFirst?, reason?}`
- `fasterModelRetry`: `{targetRunId, expectedRunVersion, clientIdempotencyKey, expectedTurnId, model}`

A message the person sends mid-turn is not an intervention: it is a queue send (`agent.queueItem.create`), which the daemon delivers through the driver's own steer (§Field-Level Consistency) and which writes no `interventions` row and no `agent.intervention.*` event.

All intervention types carry a **mandatory** version guard (`expectedRunVersion`) — the guard is **fail-closed**: the comparand is required on every intervention request and an absent comparand is **rejected**, never applied (an optional guard would let a caller bypass the stale-request guard by omitting the field). See [Spec-003 §Interfaces And Contracts](../specs/003-queue-steer-pause-resume.md#interfaces-and-contracts) and [Plan-002 D-002-2](../plans/002-queue-steer-pause-resume.md). A guard mismatch produces `expired`. An authorization failure produces `rejected`.

All intervention types also carry a **mandatory** requester-generated `clientIdempotencyKey` (UUID; [Spec-004 §Required Behavior](../specs/004-provider-driver-contract-and-capabilities.md#required-behavior)). The daemon persists it on the `interventions` row (`UNIQUE(target_run_id, client_idempotency_key)`) and applies return-or-conflict semantics: an identical retry returns the saved result without re-dispatching the driver; reuse of a key with a differing payload is rejected as `agent.intervention.idempotencyConflict`. Same-vs-differing is adjudicated by comparing the stored payload with the retry's, as plain text ([Spec-003 §Interfaces And Contracts](../specs/003-queue-steer-pause-resume.md#interfaces-and-contracts)). The guards are orthogonal — `expectedRunVersion`, the stale-request guard, defeats a stale request carrying **outdated** intent; `clientIdempotencyKey`, the duplicate-request guard, defeats duplicate applications of the **same** intent. The daemon's own stops (the orchestration layer’s spend-limit and token-limit stops — ADR-011 dispatch, Plan-013) carry a key the daemon synthesizes at enqueue time under the same return-or-conflict semantics, and record their reason, the limit, on their `interventions` row, so a restart that finds one pending ends the run as that limit does; the field keeps its wire-standard `client` prefix because the requester is the client toward the driver boundary.

## Field-Level Consistency

The following field inventory maps each driver payload to its sources.

**The driver's `steer`** (built by the daemon from the queued message when it delivers it, Plan-002 T3.8; it is no intervention and writes no `interventions` row):

| Field | Required | Source: the queued message and the daemon | Source: the driver's `ApplyInterventionParams` |
| --- | --- | --- | --- |
| `targetRunId` | yes | the run the daemon delivers into | `ApplyInterventionParams.targetRunId` |
| `expectedRunVersion` | yes | the run's `runVersion` at delivery | `ApplyInterventionParams.expectedRunVersion` |
| `clientIdempotencyKey` | yes | the daemon's own id on the message | `ApplyInterventionParams.clientIdempotencyKey` |
| `content` | yes | `AgentQueueItemCreateRequest` (the message's text) | `SteerPayload.content` |
| `attachments` | no | `AgentQueueItemCreateRequest.attachments` (optional, `ArtifactId[]`) | `SteerPayload.attachments` (optional, `ArtifactId[]`) |
| `skills` | no | `AgentQueueItemCreateRequest.skills` (each `{name, folderPath}`), which the daemon resolves for a Codex agent to the skill Codex's own `skills/list` names | `SteerPayload.skills` (optional, `PickedSkill[]`, each `{name, path}`, `path` the absolute `SKILL.md` file Codex listed) |
| `expectedTurnId` | no | never set by the queue's delivery: a steer goes to the live turn | `SteerPayload.expectedTurnId` (optional) |

At-rest routing: `content` rests on the queue item's `payload` column, as plain text like every other column ([Spec-003 §State And Data Implications](../specs/003-queue-steer-pause-resume.md#state-and-data-implications)), beside its `user.message.sent` row, and the driver leg is handed the same text; no intervention row holds it. `attachments` are references, not bodies.

Element type: both `attachments` columns above are `ArtifactId[]` — ids into [Spec-012](../specs/012-artifacts-files-and-attachments.md)'s manifest space. The two are one carrier seen from its two ends, so the ordering rule, the cause-bearing unresolved-marker rule, and both count bounds are stated once, on `SteerPayload` in [provider-driver-payloads.md §Plan-003 — Provider Driver Contract (Internal Interface)](../architecture/contracts/provider-driver-payloads.md#plan-003--provider-driver-contract-internal-interface), and cited from `agent.queueItem.create` rather than restated.

**`interrupt` payload:**

| Field | Required | Source: API Contracts | Source: the driver's `ApplyInterventionParams` |
| --- | --- | --- | --- |
| `targetRunId` | yes | `AgentRunInterveneRequest` | `ApplyInterventionParams.targetRunId` |
| `expectedRunVersion` | yes | `AgentRunInterveneRequest` | `ApplyInterventionParams.expectedRunVersion` |
| `clientIdempotencyKey` | yes | `AgentRunInterveneRequest` | `ApplyInterventionParams.clientIdempotencyKey` |
| `pending` | yes | `AgentRunInterveneRequest` | `InterruptPayload.pending` |
| `deliverFirst` | no | `AgentRunInterveneRequest` (optional) | none: the daemon puts the named message first itself |
| `reason` | no | `AgentRunInterveneRequest` (optional) | `InterruptPayload.reason` (optional) |

Note: The driver's own `ApplyInterventionParams` (`crates/sidekicks-provider/src/driver/run_control.rs`) splits the payload into `targetRunId`, `expectedRunVersion`, and `clientIdempotencyKey` at the top level and routes the remaining type-specific fields through `SteerPayload` or `InterruptPayload`. The `AgentRunInterveneRequest` in the API contracts flattens an intervention's fields into one discriminated union, `interrupt` | `fasterModelRetry`: its `interrupt` arm carries the driver's fields plus `deliverFirst`, which the daemon acts on itself, and `fasterModelRetry` never reaches the driver. The driver's `steer` has no request arm: only the queue's delivery builds it. The `ApplyInterventionResponse` returned by the driver uses `status: 'applied' | 'degraded'` — the orchestration layer maps this to the full seven-state lifecycle per the normative table below.

## Driver Result To Lifecycle Mapping

The driver-result and intervention-lifecycle vocabularies are distinct and map normatively ([Spec-004 §Required Behavior](../specs/004-provider-driver-contract-and-capabilities.md#required-behavior)). The driver-level result vocabulary is exactly `applied | degraded`; a driver never produces `rejected` or `expired`, and the daemon never reclassifies a driver verdict. The line falls at dispatch: a run whose version moved before acceptance expires the request undispatched, so does an interrupt that waited for a run's start while the run ended, and once dispatched the driver's verdict is recorded whatever the run did meanwhile, advancing a live run's version from wherever it stands. A verdict that lands after the run's end is recorded on its intervention row and leaves the run's version as it is: nothing moves a run past its end event.

| Lifecycle state | Producer | Trigger |
| --- | --- | --- |
| `requested` / `accepted` | daemon (pre-dispatch) | Recording and validation states before any driver involvement |
| `rejected` | daemon | Authorization failure or invalid target before dispatch — the driver is never invoked — or a refusal from the faster-model retry the daemon carries out itself |
| `expired` | daemon (pre-dispatch) | `expectedRunVersion` guard mismatch at acceptance, an interrupt that waited for a run's start to settle while a failed setup gate or a failed driver start ended the run, or a faster-model retry a restart found unsent — the driver is never invoked |
| `failed` | daemon (dispatch) | The dispatch threw, never completed (a daemon death among them), or was never sent because the run ended and was continued before it, instead of returning a verdict; the row records the error's code, or its message when it has none, the restart that lost the outcome, or that the run ended and was continued before the dispatch |
| `applied` | driver → daemon; or daemon | Driver returned `status: 'applied'` — the intervention was delivered, whether by the driver's own provider verb or by the orchestration leg above it — or the daemon applied an interrupt of a run no driver has been handed: one still in its setup gates, or one whose failed start could not write its end |
| `degraded` | driver → daemon; or daemon (post-driver) | Driver returned `status: 'degraded'` — the type could be delivered neither by a provider verb of the driver's own nor by the orchestration leg above it, so the orchestration layer fell back (`fallbackAction`), which neither Claude Code nor Codex reaches |

Static capability refusal is a separate, earlier path with a narrow carve-out: the daemon MAY refuse dispatch outright with `provider.capability.unsupported` ONLY for an intervention type that has no documented orchestration fallback under the excluded flag. A type with a documented fallback — one a driver can neither perform natively nor have performed for it above the driver ([Spec-004 §Fallback Behavior](../specs/004-provider-driver-contract-and-capabilities.md#fallback-behavior-1)) — MUST enter the lifecycle and terminate `degraded`, so the fallback is recorded on the intervention row (`fallbackAction`); **neither Claude Code nor Codex reaches that path**. Static refusal never substitutes for a documented degraded path ([Plan-003](../plans/003-provider-driver-contract-and-capabilities.md) adjudicates the static/dynamic split within that rule).

An interrupt never waits behind a pending retry. A run's faster-model retries dispatch one at a time in arrival order, and its interrupts likewise among themselves, but an interrupt dispatches at once even while a retry is in flight; a retry still queued on that run when the interrupt applies meets the advanced version at its acceptance and expires. A message's delivery through the driver's steer takes neither turn: it follows the run queue's own order for the session. An interrupt of a run still in its setup gates calls no driver, since none has been handed the run: it applies at once, the run is never started, and it rests `interrupted`. An interrupt that arrives once the gates are done and before the driver has the run waits for that start to settle: once the driver has the run it dispatches as any interrupt does; when a failed gate or a failed driver start has ended the run `failed` it expires undispatched, as a stop that races a run's own end changes nothing; and when the start failed and the run's end could not be written it applies and leaves the run `interrupted`. The wait is bounded by the driver's start, which fails at its request deadline — every Claude Code control request and every Codex JSON-RPC request carries one — and by the end a failed start writes.

## Boundary: Interventions vs Interactive Requests

- `respondToRequest` (from Spec-004 `ProviderDriver` interface) is the driver's mechanism for handling PROVIDER-initiated interactive requests (tool confirmations, clarification questions). It is REACTIVE — the provider asked for input.
- `applyIntervention(type: "steer")` delivers a message the user sent mid-turn (a queue send, `agent.queueItem.create`) into the active run, recording no intervention. It is PROACTIVE — the user wants to redirect. On Codex the daemon's run queue holds every waiting message and hands it over at the thread's next tool boundary, so `Remove`, `Edit`, moving, `Waiting to be delivered` and `Not delivered · Retry` act on the daemon's hold; Codex's own `instant_interrupt` setting, read live and never written by the app, decides what that hand-over does: on, Codex's default, Codex stops a reply it has just begun and the turn goes on with the message, the stopped reply staying in the transcript as the text that streamed, ended where Codex stopped; off, a steer aimed at a request that has already gone out lands at the step after. A message from another session and a reminder that comes due take the same hold and the same `turn/steer` at the next tool boundary, never straight into a reply.
- The two never overlap: a steer reaches a run that is working — `running`, or on Claude Code also `waitingForApproval`, since Claude Code holds the message to its next tool boundary — while a message sent as the run waits on the person's input goes as the next turn instead, except on Claude Code's switch-or-credits choice, which the message settles; a response answers the `waitingForInput` request itself.
- `interrupt` intervention is the single abort: it targets any non-terminal state after admission and leaves the run `interrupted`, whether it is `starting`, `running`, `pausing`, `paused`, or waiting — except a `starting` run whose start fails while the interrupt waits for it, which ends `failed` on its own and expires the interrupt ([§Driver Result To Lifecycle Mapping](#driver-result-to-lifecycle-mapping)). A stop the daemon makes itself — at the step limit or the spend limit, because a workflow phase was canceled, or because a restart ended a child held in a pause — is the same interrupt, carrying its `trigger` ([Run State Machine](run-state-machine.md)). The run then rests `interrupted`, and its next turn continues it on the same run id: a send into it, or the waiting messages going as the next turn. At the token limit the daemon's stop ends the run `stopped` with `trigger: tokenLimit`, and the agent's next message, or one already waiting, starts a new run. While the interrupt is under way the queue hands the run nothing, and the interrupt's `pending` choice is written in the run's `interrupted` write: `returnToDraft` cancels every waiting message there, a starting run's opening with them, after taking back each message Claude Code holds, and `nextTurn` writes their places, the one `deliverFirst` names first. A run that ended on its own before the interrupt could end it keeps that end, and the choice still applies to its messages.
- Undo is not an intervention. `Undo to here` on the person's own message, a snapshot's `Restore` and the rewind menu's rows are one operation, `session.restore({ target, scope })`: `target` is a stable message or snapshot identity, never a numeric or provider position, and `scope` is `"conversationAndFiles"`, `"conversation"` or `"files"`. `session.restore.preview` takes the same and changes nothing. The result carries `requested` (the same values), `restored` (`"conversationAndFiles"`, `"conversation"`, `"files"` or `"nothing"`) and, for each requested part that did not apply, `failures.conversation` / `failures.files` with a `reason`; edit and resend is the same call carrying the edited message, one intent with one result. Every outcome is stored as one event, `session.restore.completed`, and `agent.run.rolledBack` records the conversation cut alone ([Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior)). The conversation half is the driver's `rewindConversation`; the driver's `forkConversation` serves `session.fork` and is never an undo. An undo is never refused because the run is `running`: it stops the later work and ends the turn itself ([Run State Machine §Rollback Transitions](run-state-machine.md#rollback-transitions)).
- Queue-item cancellation (`agent.queueItem.cancel`) is separate from the `interrupt` intervention — `agent.queueItem.cancel` targets queue items the agent has not yet taken (`Remove`, `agent.queueItem.cancel`), while an interrupt targets runs that already exist in the run state machine.

## Example Flows

- Example: A queued follow-up becomes a persisted `QueueItem` and is later steered into the active run.
- Example: A user presses `Pause` on a running task. The daemon stops the run through the provider's own hooks, registered for the session and never written to a file: on a Claude Code lead one hook ends the turn after the step in flight and another denies any tool call while paused; on a child, on any provider, the daemon's pre-tool hook holds the child's next tool call; on a Codex lead the daemon's pre-tool hook holds the next call, the daemon sends `turn/interrupt`, and the hook denies the parked call. The daemon persists the run's state; the second press, or any send, continues it from exactly where it stopped (`turn/start` on Codex). No intervention is recorded and no resume event is queued; the driver never needs to know about pause.
- Example: A user presses `Interrupt` with two follow-ups waiting and picks the next turn. The run rests `interrupted` with their places written in the same write; Claude Code starts its next turn with the messages it holds, and on Codex the daemon sends `turn/start` once `turn/completed` arrives `interrupted`. Either way the turn continues the same run, which goes back to `running` on its own id and on the memory-gate place it parked; a continue that fails leaves the run `interrupted` and its messages `notDelivered`.
- Example: A user edits a waiting follow-up before the agent takes it. The edit is one `agent.queueItem.create` carrying `replacesQueueItemId`: the old item is marked `superseded`, not silently discarded, and the edited message keeps its place in the order.

## Edge Cases

- A message whose run cannot start has a deadline: when the run it waits for has waited at the memory gate longer than the daemon's own delivery timeout, the run ends failed and the message is `notDelivered`, carries its reason and can be sent again from itself. A message waiting for a run that is working has no deadline, and while the daemon is only unreachable it keeps waiting.
- A canceled queue item remains in history for audit.

## Related Specs

- [Queue Steer Pause Resume](../specs/003-queue-steer-pause-resume.md)
- [Provider Driver Contract And Capabilities](../specs/004-provider-driver-contract-and-capabilities.md)
- [Session Event Taxonomy And Audit Log](../specs/005-session-event-taxonomy-and-audit-log.md)
- [Persistence And Recovery](../specs/013-persistence-and-recovery.md)

## Related ADRs

- [Daemon Backed Queue And Interventions](../decisions/003-daemon-backed-queue-and-interventions.md)
- [Generic Intervention Dispatch](../decisions/011-generic-intervention-dispatch.md)
