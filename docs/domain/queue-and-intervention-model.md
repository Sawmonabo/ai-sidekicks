# Queue And Intervention Model

## Purpose

Define how deferred work is stored and how control actions against active or queued work are represented.

## Scope

This document covers `QueueItem` and `Intervention`.

## Definitions

- `QueueItem`: a persisted unit of deferred work waiting for execution admission.
- `Intervention`: an auditable control action against an active run or queued work item.
- `Admission`: the act of converting a queue item into a running lifecycle.

## What This Is

This model defines how the system stores follow-up work, prioritizes it, and records deliberate operator changes to execution.

## What This Is Not

- A queue item is not a run.
- A queue is not a client draft buffer.
- An intervention is not a normal user message.

## Invariants

- Queue items are persisted by the runtime, not only by the client.
- Every queue item belongs to exactly one session and targets a defined execution context.
- Every intervention has an initiator, a target, a timestamp, and an outcome.
- Every intervention records the **origin** it was admitted through — `participant` or `system` — and, on the `participant` arm only, the **admitting principal**: the identity the daemon itself resolved from the transport at acceptance. The initiator is routing and audit metadata supplied by the caller; the admitting principal is the daemon's own finding and is the sole identity any later authorization decision may read (2026-08-18 amendment; [Spec-004 §Required Behavior](../specs/004-queue-steer-pause-resume.md#required-behavior)). The two arms are exhaustive and mutually exclusive, so a system-originated intervention carries no principal and can never be mistaken for a participant's act.
- Queue admission and intervention effects must be visible in the session timeline.
- A failed or downgraded intervention must still be recorded as an outcome.

## Relationships To Adjacent Concepts

- A `QueueItem` can create a future `Run`.
- An `Intervention` targets a `Run` via `targetRunId`. Queue-item cancellation uses `QueueItemCancel`, not the intervention model.
- `Approval` can be required before certain interventions take effect.
- `Channel` context determines where admitted queued work will publish.

## State Model

Queue item states:

| State | Meaning |
| --- | --- |
| `queued` | Waiting for admission. |
| `admitted` | Accepted by the run engine. An unbound item (`target_run_id` NULL) is being converted into a **new** run; a run-bound item (`target_run_id` stamped — in V1 solely by the [Spec-004 §Required Behavior](../specs/004-queue-steer-pause-resume.md#required-behavior) edit-and-resend composite's admission, 2026-08-16 amendment) is delivered into its bound run as that run's next provider send on `run.resume`, never converted into a new run. |
| `superseded` | No longer eligible because newer work replaced it. |
| `canceled` | Intentionally removed before admission. |
| `expired` | No longer valid because its context or timing window lapsed. |

Intervention states (6 canonical states):

| State | Meaning |
| --- | --- |
| `requested` | Recorded and awaiting evaluation. |
| `accepted` | Determined to be valid for the target. |
| `applied` | Successfully changed runtime or scheduling state. |
| `rejected` | Determined to be invalid or unauthorized. Authorization failure produces `rejected`. |
| `degraded` | The intervention took partial or fallback effect, with the outcome detail naming what degraded: the driver does not support the type natively and the orchestration layer fell back (e.g., steer degrades to queue + interrupt), or a multi-leg intervention's later leg failed after a confirmed earlier leg (rollback's file leg after a confirmed conversation rewind — campaign B2 — a confirmed floor the settlement-time compaction-boundary reclassification finds crossing, the `boundary-diverged` arm (2026-08-16 amendment), or, on a rollback carrying that amendment's optional `replacementSend`, its replacement-send leg: the `resend-unapplied` arm in §Driver Result To Lifecycle Mapping). |
| `expired` | No longer meaningful because the target state changed first. Version guard mismatch produces `expired`. |

### Intervention State Transition Table

| From | To | Trigger | Condition |
| --- | --- | --- | --- |
| `requested` | `accepted` | Valid target, authorized | Target run is in a state that accepts this intervention type |
| `requested` | `rejected` | Invalid target, unauthorized, static capability refusal, or fail-closed pre-dispatch refusal | Target run state incompatible, participant lacks permission, the type has no documented fallback under a driver capability exclusion (`driver.capability_unsupported` — §Driver Result To Lifecycle Mapping), or a rollback fail-closed pre-dispatch refusal (campaign B2 — [Spec-004 §Required Behavior](../specs/004-queue-steer-pause-resume.md#required-behavior): Spec-010 restore precondition unmet, a `targetPosition` outside the validated rewind domain — non-integer, negative, current-or-future, or naming no recorded turn boundary; current-position targets stay admissible solely as the Spec-004 file-leg recovery carve-out — a rewind span intersecting already-compacted history, the **uncompacted-rewind-span** check (recorded here 2026-09-06: this cell had omitted the one family [Spec-004 §Required Behavior](../specs/004-queue-steer-pause-resume.md#required-behavior)'s rewind-span-must-be-live rule and Plan-004 T3.12's own refusal enumeration both carry) — or a terminal-source rollback's execution root `busy` under another run), or one of the 2026-08-16 rewind-hardening refusals ([Spec-004 §Required Behavior](../specs/004-queue-steer-pause-resume.md#required-behavior)): a boundary-crossing `targetPosition` classified against the run's newest current provider-side compaction, or — on a rollback carrying the optional `replacementSend` edit-and-resend leg only — a `running` target (the pause-first path does not extend to that leg), a run holding a pending send (accepted-but-undelivered, or undrained-queued ahead of the composite), a target boundary not opened by a participant-authored `user.message` of that run, or a non-resumable rootless target (execution context released with no existing root, or an execution context — live or already released — whose recorded checkout root is gone (a live one the confirmed rollback releases into that class at the confirmed re-open; a terminal-source one arrives in it) — the leg's promised next-resume delivery can never occur, while bare rollback of it stays admissible conversation-only) |
| `requested` | `expired` | Version guard mismatch | `expectedRunVersion` does not match current run version |
| `accepted` | `applied` | Driver successfully executed | Provider confirmed the intervention took effect |
| `accepted` | `degraded` | Driver fallback used, or multi-leg partial effect | Driver does not support this type natively and the orchestration layer fell back; or a later leg failed after a confirmed earlier leg (rollback file leg, campaign B2) |
| `accepted` | `expired` | Target state changed | Run transitioned between accept and apply (e.g., run completed before steer could be applied) |

## Intervention Entity Relationship

- `InterventionRequest`: the inbound command that initiates an intervention.
- `InterventionResult`: the outcome record produced after evaluation and execution.
- `Intervention`: the lifecycle entity encompassing both the request and the result.

Lifecycle: an `InterventionRequest` is created by a participant or the orchestration layer, validated against the target run state and version guard, and then produces an `Intervention` entity that progresses through the state transitions defined above. When the intervention reaches a terminal state (`applied`, `rejected`, `degraded`, or `expired`), the system records an `InterventionResult` capturing the final outcome and any fallback action taken.

One `InterventionRequest` produces exactly one `Intervention`, which produces exactly one `InterventionResult`. This is a strict 1:1:1 cardinality.

The `interventions` SQLite table (Plan-004) stores the full lifecycle entity — request fields, current state, and result — in a single row rather than splitting request and result into separate tables. See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for column definitions.

## Intervention Payloads

Intervention payloads are a discriminated union by type:

- `steer`: `{targetRunId, expectedTurnId?, expectedRunVersion, clientIdempotencyKey, content, attachments?}`
- `interrupt`: `{targetRunId, expectedRunVersion, clientIdempotencyKey, reason?}`
- `cancel`: `{targetRunId, expectedRunVersion, clientIdempotencyKey, reason?}`
- `rollback` (campaign B2): `{targetRunId, expectedRunVersion, clientIdempotencyKey, targetPosition, replacementSend?}` — `targetPosition` is the normalized session position (a `number`) of the turn boundary to rewind to; the optional `replacementSend` (2026-08-16 amendment) carries the corrected message body of the atomic edit-and-resend composite, and its presence alone selects that composite's four additional pre-dispatch refusal guards, its admission-conditioned run-bound resend with the structural `resendDisposition` result member, and its `resend-unapplied` disposition ([Spec-004 §Required Behavior](../specs/004-queue-steer-pause-resume.md#required-behavior))

All intervention types carry a **mandatory** version guard (`expectedRunVersion`) — the guard is **fail-closed**: the comparand is required on every intervention request and an absent comparand is **rejected**, never applied (an optional guard would let a caller bypass stale-replay protection by omitting the field). See [Spec-004 §Interfaces And Contracts](../specs/004-queue-steer-pause-resume.md#interfaces-and-contracts) and [Plan-004 D-004-2](../plans/004-queue-steer-pause-resume.md#ratified-design-decisions-tier-5-audit-2026-05-30). A guard mismatch produces `expired`. An authorization failure produces `rejected`.

All intervention types also carry a **mandatory** requester-generated `clientIdempotencyKey` (UUID; [Spec-005 §Required Behavior](../specs/005-provider-driver-contract-and-capabilities.md#required-behavior), campaign B3). The daemon persists it on the `interventions` row (`UNIQUE(target_run_id, client_idempotency_key)`) and applies replay-or-conflict semantics: an identical retry returns the originally recorded outcome without re-dispatching the driver; reuse of a key with a differing payload is rejected as `intervention.idempotency_conflict`. For the composite's PII-bearing `replacementSend` body, same-vs-differing is adjudicated by **decrypt-and-compare** (2026-08-16 amendment): the stored envelope is decrypted under the requester's live participant key via the injected `PiiEncryptor` and compared as plaintext — never by ciphertext comparison (the envelope is nonce-randomized, so equal plaintexts encrypt unequal) and never by a persisted plaintext digest (a digest of erased text would survive Path-1 crypto-shred as a guessing oracle) — and a stored body rendered undecryptable by participant-key shred settles the reuse fail-closed as `intervention.idempotency_conflict` ([Spec-004 §Interfaces And Contracts](../specs/004-queue-steer-pause-resume.md#interfaces-and-contracts)). The two guards are orthogonal — `expectedRunVersion` defeats stale replays of **outdated** intent, `clientIdempotencyKey` defeats duplicate applications of the **same** intent. System-originated interventions (the orchestration layer’s budget / idle / moderation interrupts — ADR-011 dispatch, Plan-016) carry a key synthesized by the daemon’s origination path at enqueue time under the same replay-or-conflict semantics; the field keeps its wire-standard `client` prefix because the requester is the client toward the driver boundary.

## Field-Level Consistency

The following field inventory maps each intervention payload to the canonical sources and confirms cross-document consistency.

**`steer` payload:**

| Field | Required | Source: API Contracts | Source: Spec-005 `ApplyInterventionParams` |
| --- | --- | --- | --- |
| `targetRunId` | yes | `InterventionRequestPayload` | `ApplyInterventionParams.targetRunId` |
| `expectedRunVersion` | yes | `InterventionRequestPayload` | `ApplyInterventionParams.expectedRunVersion` |
| `clientIdempotencyKey` | yes | `InterventionRequestPayload` | `ApplyInterventionParams.clientIdempotencyKey` |
| `content` | yes | `InterventionRequestPayload` | `SteerPayload.content` |
| `attachments` | no | `InterventionRequestPayload` (optional) | `SteerPayload.attachments` (optional) |
| `expectedTurnId` | no | `InterventionRequestPayload` (optional) | `SteerPayload.expectedTurnId` (optional) |

At-rest routing (2026-08-18 amendment): `content` is participant-authored directive text, so it rests on the durable intervention row inside the participant-keyed PII envelope (`interventions.pii_payload`) rather than in the plaintext `payload` column — the same at-rest split `replacementSend` takes, for the same reason ([Spec-004 §Required Behavior](../specs/004-queue-steer-pause-resume.md#required-behavior)). This changes neither the wire shape above nor what the driver receives: the split happens daemon-side at persist, and the driver leg is handed the decrypted text as before. `attachments` are references, not bodies, and are unaffected.

**`interrupt` payload:**

| Field | Required | Source: API Contracts | Source: Spec-005 `ApplyInterventionParams` |
| --- | --- | --- | --- |
| `targetRunId` | yes | `InterventionRequestPayload` | `ApplyInterventionParams.targetRunId` |
| `expectedRunVersion` | yes | `InterventionRequestPayload` | `ApplyInterventionParams.expectedRunVersion` |
| `clientIdempotencyKey` | yes | `InterventionRequestPayload` | `ApplyInterventionParams.clientIdempotencyKey` |
| `reason` | no | `InterventionRequestPayload` (optional) | `InterruptPayload.reason` (optional) |

**`cancel` payload:**

| Field | Required | Source: API Contracts | Source: Spec-005 `ApplyInterventionParams` |
| --- | --- | --- | --- |
| `targetRunId` | yes | `InterventionRequestPayload` | `ApplyInterventionParams.targetRunId` |
| `expectedRunVersion` | yes | `InterventionRequestPayload` | `ApplyInterventionParams.expectedRunVersion` |
| `clientIdempotencyKey` | yes | `InterventionRequestPayload` | `ApplyInterventionParams.clientIdempotencyKey` |
| `reason` | no | `InterventionRequestPayload` (optional) | `CancelPayload.reason` (optional) |

**`rollback` payload (campaign B2):**

| Field | Required | Source: API Contracts | Source: Spec-005 driver boundary |
| --- | --- | --- | --- |
| `targetRunId` | yes | `InterventionRequestPayload` | daemon-resolved — the driver leg is addressed by the run's **live provider binding** (`RollbackToParams.bindingId`, the same per-binding leg key as goal delivery; run→bindings is 1:many) with session context (`RollbackToParams.sessionId`); clients address the run, never a binding |
| `expectedRunVersion` | yes | `InterventionRequestPayload` | daemon-enforced pre-dispatch (Plan-004 D-004-2); never forwarded to the driver |
| `clientIdempotencyKey` | yes | `InterventionRequestPayload` | daemon-enforced replay-or-conflict; never forwarded to the driver |
| `targetPosition` | yes | `InterventionRequestPayload` | `RollbackToParams.position` |
| `replacementSend` | no (2026-08-16 amendment) | `InterventionRequestPayload` | daemon-only — the body persisted on the durable intervention row before dispatch through the participant-keyed PII envelope (`interventions.pii_payload`, never plaintext `payload` — Spec-004 §Required Behavior at-rest split), then **enqueued run-bound** as a queue item (persisted queue-state `queued`; the run-bound arm of `admitted` is reached only when the `run.resume` drain delivers it; that queue row carries its own copy of the body under the same participant-keyed envelope in `queue_items.pii_payload`, 2026-08-18 amendment — one send, two durable rows, both shredded by the one key deletion) through the ordinary participant-send path in the same durable transaction that settles the intervention after the confirmed rewind (the run still lands `paused`; no auto-resume, no second driver call); never forwarded to the driver's `rollbackTo` leg |

Note: The `ApplyInterventionParams` interface in Spec-005 splits the payload into `targetRunId`, `expectedRunVersion`, and `clientIdempotencyKey` at the top level and routes the remaining type-specific fields through `SteerPayload`, `InterruptPayload`, or `CancelPayload`. The `InterventionRequestPayload` in the API contracts flattens all fields into a single discriminated union. Both representations carry the same field set per intervention type. The `DriverInterventionResult` returned by the driver uses `status: 'applied' | 'degraded'` — the orchestration layer maps this to the full 6-state lifecycle per the normative table below.

The `rollback` type (campaign B2) is the deliberate exception at the driver boundary: it is a full member of the `InterventionRequestPayload` union on the client→daemon wire, but its driver leg dispatches through the dedicated capability-gated `rollbackTo(RollbackToParams {sessionId, position, bindingId})` parity operation returning `DriverRollbackResult` — not through `ApplyInterventionParams` ([Spec-004 §Interfaces And Contracts](../specs/004-queue-steer-pause-resume.md#interfaces-and-contracts), campaign B2; operation contract per [Spec-005](../specs/005-provider-driver-contract-and-capabilities.md), campaign B3). The daemon enforces both guards pre-dispatch and resolves `targetRunId` into the run's live provider binding (`bindingId`) plus session context — which is why neither guard field appears in `RollbackToParams`, and why clients never send a binding key. `DriverRollbackResult` maps into the same 6-state lifecycle per the normative table below (`applied {sessionPosition, bindingId?}` → `applied`, the optional `bindingId` repointing the run's live binding when the mechanism forked; `degraded {fallbackAction?}` → `degraded`), and the daemon's file-restore leg (Spec-010 turn-boundary snapshots, campaign B21) composes fail-closed around the driver leg per [Spec-004 §Required Behavior](../specs/004-queue-steer-pause-resume.md#required-behavior).

## Driver Result To Lifecycle Mapping

The driver-result and intervention-lifecycle vocabularies are distinct and map normatively ([Spec-005 §Required Behavior](../specs/005-provider-driver-contract-and-capabilities.md#required-behavior), campaign B3). The driver-level result vocabulary is exactly `applied | degraded`; a driver never produces `rejected` or `expired`, and the daemon never reclassifies a driver verdict.

| Lifecycle state | Producer | Trigger |
| --- | --- | --- |
| `requested` / `accepted` | daemon (pre-dispatch) | Recording and validation states before any driver involvement |
| `rejected` | daemon (pre-dispatch) | Authorization failure or invalid target — the driver is never invoked |
| `expired` | daemon | `expectedRunVersion` guard mismatch (pre-dispatch), or target state changed between accept and apply |
| `applied` | driver → daemon | Driver returned `status: 'applied'` — the intervention took effect natively |
| `degraded` | driver → daemon; or daemon (post-driver) | Driver returned `status: 'degraded'` — the type is unsupported at the driver boundary and the orchestration layer fell back (`fallbackAction`); or the daemon renders a multi-leg partial or zero-effect outcome — a rollback composite concluding after dispatch with less than full effect: internal-pause-only (`pause-only` — the conversation never rewound on a `running` source), zero-effect `nothing-applied` (no rewind from any other source; campaign B9, Codex round 5 completes this no-rewind-source enumeration), position-mismatch (driver-confirmed floor ≠ `targetPosition`), `boundary-diverged` (2026-08-16 amendment: the confirmed floor reclassified at settlement against the then-current compaction-boundary set concluded crossing — file leg skipped fail-closed, any staged replacement suppressed, run at conversation truth, non-resumable in V1 per the resume backstop), `files-unrestored`, or `files-partially-restored` (campaign B2, [Spec-004 §Required Behavior](../specs/004-queue-steer-pause-resume.md#required-behavior)) — joined by `resend-unapplied` (2026-08-16 amendment, the committed-then-failed arm: reserved for a `replacementSend` admission that itself failed after a fully-successful rewind, the suppression arms keeping their earlier-failing leg's disposition, every composite `degraded` settlement carrying `resendDisposition: 'unapplied'`; the caller's text stays recoverable on the durable intervention row under the requester's participant key (the Spec-004 at-rest PII split)); the same zero-effect landing takes a dispatched frame whose command-shaped-text neutralization the runtime tripwire found not to have held (2026-08-25 amendment, [Spec-005 §Required Behavior](../specs/005-provider-driver-contract-and-capabilities.md#required-behavior)) — the author's text undelivered and no `fallbackAction` (dispatch occurred, so pre-dispatch `rejected` is definitionally unavailable), with the cause carried to this caller **best-effort** on the closed-literal `DriverInterventionResult.refusalCode` (set only when the trip is classified before the call resolves; the run terminal below is the guarantee, an absent member never evidence of no trip); and because the provider may have executed an unrecognized client-side action against the session state the run depends on, the trip also **fails the run** — `driver.text_neutralization_failed` on the `run.failed` terminal's `providerFailureDetail` beside a `recovery-needed` condition — and **disposes the run's provider binding**, so no later run re-binds to that session |

Static capability refusal is a separate, earlier surface with a narrow carve-out: the daemon MAY refuse dispatch outright with `driver.capability_unsupported` ONLY for an intervention type that has no documented orchestration fallback under the excluded flag. A type with a documented fallback — e.g. `steer` under Claude's `steer: false`, which degrades to the queue+interrupt composite per `Spec-005 §Per-Driver Capability Matrix` — MUST enter the lifecycle and terminate `degraded`, so the fallback is recorded on the intervention row (`fallbackAction`); static refusal never substitutes for a documented degraded path ([Plan-005](../plans/005-provider-driver-contract-and-capabilities.md) adjudicates the static/dynamic split within that rule). `rollback` (campaign B2) sits on the static side of that split: it has **no documented orchestration fallback** — a synthesized rollback (replaying truncated history into a fresh run) would violate [Spec-004 §Required Behavior](../specs/004-queue-steer-pause-resume.md#required-behavior)'s same-run resurrection invariant — so a driver whose capabilities exclude the `rollback` flag is refused statically with `driver.capability_unsupported`, recorded as lifecycle `rejected`.

## Boundary: Interventions vs Interactive Requests

- `respondToRequest` (from Spec-005 `ProviderDriver` interface) is the driver's mechanism for handling PROVIDER-initiated interactive requests (tool confirmations, clarification questions). It is REACTIVE — the provider asked for input.
- `applyIntervention(type: "steer")` is PARTICIPANT-initiated content injection into an active run. It is PROACTIVE — the participant wants to redirect.
- The two never overlap: a steer targets a `running` state, a response targets a `waiting_for_input` state.
- `interrupt` intervention targets `running` specifically — it stops active computation.
- `cancel` intervention targets any non-terminal state — it ends the run regardless of whether it is `running`, `paused`, or waiting.
- `rollback` intervention (campaign B2) targets `paused`, the two waiting states (voiding the pending approval or input block), and the three terminal states — the only intervention legal against a terminal run; a `running` target is paused first on a **bare** rollback, while a rollback carrying the 2026-08-16 amendment's optional `replacementSend` refuses a `running` target outright at admission instead ([Spec-004 §Required Behavior](../specs/004-queue-steer-pause-resume.md#required-behavior); [Run State Machine §Rollback Transitions](run-state-machine.md#rollback-transitions-campaign-b2)).
- Queue-item cancellation (`QueueItemCancel`) is separate from `cancel` intervention — `QueueItemCancel` targets queue items that have not yet been admitted as runs, while `cancel` intervention targets runs that already exist in the run state machine.

## Example Flows

- Example: A queued follow-up becomes a persisted `QueueItem` and is later steered into the active run.
- Example: A user requests `pause` against a running task. The orchestration layer records an intervention, interrupts the run, persists state, and queues a resume event. The driver never needs to know about pause.
- Example: A later urgent fix supersedes an older queued follow-up. The old queue item is marked `superseded`, not silently discarded.

## Edge Cases

- A steer intervention against a run with no active steer capability must be rejected or degraded to a new queue item explicitly.
- A queued item can expire if its required workspace, branch, or participant authority is no longer valid.
- A canceled queue item remains in history for audit and replay.

## Related Specs

- [Queue Steer Pause Resume](../specs/004-queue-steer-pause-resume.md)
- [Provider Driver Contract And Capabilities](../specs/005-provider-driver-contract-and-capabilities.md)
- [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md)
- [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md)

## Related ADRs

- [Daemon Backed Queue And Interventions](../decisions/003-daemon-backed-queue-and-interventions.md)
- [Generic Intervention Dispatch](../decisions/011-generic-intervention-dispatch.md)
