# Run Control Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-002 — Queue Steer Pause Resume

```ts
// The daemon-minted handle of a provider's own helper inside its parent's run. Opaque, and resolved only
// by the daemon, whose parent-to-child index minted it.
type ChildHandle = string & { readonly __brand: "ChildHandle" };

// QueueItemCreate — one message the person sends to the lead, whether a turn is running or not.
interface QueueItemCreateRequest {
  sessionId: SessionId;
  to?: SessionId; // addresses another session instead: the message arrives there as that session's own row
  // Binds the run a send starts to its repository; neither it nor `priority` reorders what the person
  // sees, which is the daemon's order (`run.queueReorder`).
  workspaceId?: WorkspaceId;
  priority?: number; // a whole number; a negative one de-prioritizes
  clientIdempotencyKey: string; // a UUID; a retried send returns the saved result
  content: string;
  attachments?: ArtifactId[]; // in staging order; how many a message carries is what the daemon and the provider accept
  // Each skill the person picked from the composer's `/` and `$` list, in the order picked: the row's
  // front-matter name and its folder, both as `skill.list` gives them. The daemon writes the
  // provider's call form into the text either way; to a Codex agent each pick also travels in the
  // turn's input as Codex's own skill item `{type: "skill", name, path}`, its `path` the `SKILL.md`
  // file the daemon builds from the folder, so of two Codex folders sharing one name the row picked
  // is the one that runs. A Claude Code agent receives only the `/name` text. Absent when nothing was
  // picked. The folder crosses in from the client and reaches the provider as a file it loads, so the
  // daemon accepts a pick only when its name and folder match a row of `skill.list`, and refuses the
  // send otherwise (`skill.path_refused`, `not_listed`).
  skills?: { name: string; folderPath: string }[];
  // An edit of a message still waiting, made in one call: the named item reads `superseded` and this
  // one takes its place in the order, so the edited message keeps its position. Refused once the agent
  // has taken the named message (`queue.change_refused`, `already_taken`). The daemon does the replacing
  // itself — on Claude Code a cancel and a resend inside this call, on Codex a replacement in its own
  // hold, because a resend there would move the message to the end of the queue — and a client never
  // sends a cancel and a resend for an edit.
  replacesQueueItemId?: QueueItemId;
  // The question this send answers: Codex's non-waiting question, answered by an ordinary message.
  // The daemon copies it onto the `user.message` row it writes, the mark that settles the question
  // on every device. Absent on a send that answers no question.
  answersQuestionId?: QuestionId;
}
interface QueueItemCreateResponse {
  queueItemId: QueueItemId;
  state: QueueItemState;
  createdAt: string;
}
// Orchestration seam (D-013-9): Plan-013's orchestration-run-service composes with
// the daemon queue-admission service IN-PROCESS, passing an OrchestrationRunLinkCarrier (see
// orchestration-payloads.md §Plan-013) after its own admission pipeline passes. The in-process admission API returns the
// minted RunId (the run.queued emission's runId) alongside queueItemId, and run.queued carries the
// carrier fields durably (Spec-005 §Run Lifecycle run.queued row). The wire run.queueCreate method never
// accepts the carrier — child-run creation goes through orchestration.runCreate only.

// QueueItemList — a queue in the daemon's order.
interface QueueItemListRequest {
  sessionId: SessionId;
  // A live child's own queue in place of the lead's. The same member narrows run.subscribeQueue,
  // run.queueCancel and run.queueReorder, so a child's pending rows work as the lead's do.
  childHandle?: ChildHandle;
  state?: QueueItemState; // filter
}
interface QueueItemListResponse {
  items: QueueItemSummary[];
}

// One queued message, as a pending row draws it.
interface QueueItemSummary {
  id: QueueItemId;
  state: QueueItemState;
  priority: number;
  content: string;
  attachments?: ArtifactId[];
  childHandle?: ChildHandle; // the child whose queue holds it; absent on the lead's
  notDeliveredReason?: string; // the daemon's reason; present exactly on a not_delivered item
  createdAt: string;
  updatedAt: string;
}

// QueueItemCancel
interface QueueItemCancelRequest {
  queueItemId: QueueItemId;
  childHandle?: ChildHandle; // the child whose queue holds the item
}
interface QueueItemCancelResponse {
  queueItemId: QueueItemId;
  state: "canceled";
}

// QueueReorder — one daemon-held order over the items still waiting, on the lead's queue or a child's.
// `queueItemIds` is the full new order, naming each item once, and is refused unless it names exactly the
// items still waiting (`queue.change_refused`, `order_mismatch`). On Codex the daemon reorders its own
// hold; on Claude Code it cancels and resends in the new order. The daemon holds the order itself because
// a cancel and a resend on Codex would put the message last. The answer is the queue in its new order.
interface QueueReorderRequest {
  sessionId: SessionId;
  childHandle?: ChildHandle;
  queueItemIds: QueueItemId[]; // at least one
}

// InterventionRequest (discriminated union by type)
// `expectedRunVersion` is the MANDATORY optimistic-concurrency comparand (Plan-002 D-002-2,
// fail-closed): every intervention carries the run version the caller last observed, and the
// daemon rejects the request as `expired` when it does not match the run's current `runVersion`
// (surfaced on RunStateChangeEvent / RunControlAck / InterventionRequestResponse below). The field
// is required — an absent comparand is rejected, never applied (an optional field would let a caller
// bypass the stale-request guard by omitting it). The compared-against counter is `runVersion`
// (Plan-002 D-002-1): an any-run-progression counter that advances on every run progression,
// applied interventions included — distinct from the immutable EventEnvelope `.version` wire-contract
// field (Spec-005 §EventEnvelope Version Semantics).
// `clientIdempotencyKey` is the second mandatory guard — a requester-generated UUID
// giving at-least-once delivery exactly-once application: the daemon persists it on the
// interventions row (UNIQUE(target_run_id, client_idempotency_key)); an identical retry returns
// the saved result without re-dispatching, and key reuse with a differing payload
// is rejected as `intervention.idempotency_conflict` (Spec-004 §Required Behavior). The two
// guards are orthogonal: `expectedRunVersion` is the stale-request guard, refusing OUTDATED intent;
// `clientIdempotencyKey` is the duplicate-request guard, refusing a second application of the SAME
// intent.
type InterventionRequestPayload =
  | {
      // The lead's interrupt. `Interrupt everything` is this arm on the lead's run plus `run.childrenStop`
      // on the same run (§Run-Control Method-Name Registry below).
      type: "interrupt";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      reason?: string;
      // The messages still waiting when the turn ends: sent at once as the next turn (`nextTurn`), or
      // put back into the draft one line per message in send order (`returnToDraft`, which
      // `Interrupt everything` sends).
      pending: "nextTurn" | "returnToDraft";
      // `Send now` on a waiting message: the interrupt ends the turn and this item goes first, the rest
      // following in order as the next turn's messages. Only with `pending: "nextTurn"`.
      deliverFirst?: QueueItemId;
    }
  | {
      // Codex's retry on the faster model its safety check names (Spec-004 §Required Behavior): the
      // daemon interrupts the turn, forks the conversation to just before it and sends the same message
      // again on `model`. A turn that is no longer the latest, or whose reply has started, is `rejected`.
      type: "faster_model_retry";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      expectedTurnId: string;
      model: string;
    };

// On a retry (same clientIdempotencyKey, identical payload) the daemon returns the saved result:
// this response, reconstructed from the persisted intervention row — same interventionId, current
// state, current runVersion — never a second application.
//
// Undo is not an intervention. Putting a session back to before one of its messages, or to one of its
// snapshots, is the session's own call, `session.restore`, read first through its dry run
// `session.restorePreview`, which takes the same session, target and scope and changes nothing; the dry
// run's request and figures are in persistence-payloads.md §Plan-012 — Persistence And Recovery, and the undo's
// request and result are these. The request names a `target` — one of the person's own
// messages by its cursor, or one of the session's snapshots by its id, never a numeric or provider
// position — and a `scope`: "conversation-and-files" | "conversation" | "files". One undo is one intent
// with one result: `requested` (the scope asked for), `restored` (the scope that applied, or "nothing"),
// and, for each requested part that did not apply, `failures.conversation` / `failures.files` carrying
// its `reason`, because the conversation cut can land while the files cannot be put back, or the reverse.
// Edit and resend is the same one call, and a call carrying `resend` takes the scope
// `conversation-and-files`, so a cut that landed while the resend failed is its own outcome,
// `resend-unapplied`, reported as that result and never as a second call's failure; the edited message
// goes back in the composer. The conversation cut alone is recorded by `run.rolled_back`
// (RunRolledBackEvent below), and every undo's outcome by `session.restore_finished`.
type SnapshotId = string & { readonly __brand: "SnapshotId" }; // daemon-minted, opaque to every client
type SessionRestoreTarget =
  | { kind: "message"; anchorCursor: EventCursor } // before one of the person's own messages
  | { kind: "snapshot"; snapshotId: SnapshotId };
type SessionRestoreScope = "conversation-and-files" | "conversation" | "files";
interface SessionRestoreRequest {
  sessionId: SessionId;
  target: SessionRestoreTarget;
  scope: SessionRestoreScope; // "conversation-and-files" whenever `resend` is present
  clientIdempotencyKey: string; // a UUID, unique within the session: a retried call never cuts twice
  includeAlsoChanged: boolean; // false unless the person pressed the include line: also put back the paths another session in the same folder changed since the point
  // The edited message an edit and resend sends once the undo has applied, with its files; its presence
  // makes edit and resend one call.
  resend?: { content: string; attachments?: ArtifactId[] };
}
type SessionRestoreResult =
  | {
      outcome: "restore-finished";
      requested: SessionRestoreScope;
      restored: SessionRestoreScope | "nothing";
      // What the files part actually did, present exactly when the files went back (`restored` is
      // "files" or "conversation-and-files"). These are the undo's own figures, not the dry run's,
      // because the folder can change between the two.
      files?: {
        restoredFileCount: number;
        restoredLineCount: number;
        skipped: Array<{ path: string; reason: SessionRestoreSkipReason }>; // persistence-payloads.md §Plan-012
      };
      // Every requested part that did not go back carries the daemon's reason here.
      failures?: {
        conversation?: { reason: string }; // the conversation part was requested and did not apply
        files?: { reason: string }; // the files part was requested and did not apply
      };
    }
  // An edit and resend whose undo applied and whose send failed, with the send's reason.
  | { outcome: "resend-unapplied"; reason: string };
interface InterventionResponseBase {
  interventionId: InterventionId;
  interventionType: InterventionType;
  runVersion: number; // post-application run counter (D-002-1) — the caller threads this into the next intervention's `expectedRunVersion`. Carried on the response because an applied native steer advances the run version WITHOUT a `run.*` state change (Spec-003 §Driver-Level Steer Mechanics), so for that path the response is the only place the caller can read the fresh comparand.
}
// A `rejected` answer always carries its `rejectionReason` and a `failed` one its `failureReason`;
// no other state carries a reason. No state carries a result: what an intervention did reaches the screen as the run's own events.
type InterventionRequestResponse = InterventionResponseBase &
  (
    | {
        state: "rejected";
        rejectionReason: string; // machine-readable cause on a `rejected` OUTCOME, which is a normal `run.intervene` response and not a JSON-RPC transport error, so the CLI renders WHY (e.g. `driver.capability_unsupported`). A request-admission refusal (e.g. `intervention.idempotency_conflict`, 422) is a JsonRpcError that produces no intervention row, so it never rides here. Durable across a retry: the cause persists in the intervention row's own `rejection_reason` column (Plan-002 T1.4 DDL), so a retry that returns the saved result reconstructs the SAME machine-readable reason from that column, never fabricating one.
      }
    | {
        state: "failed";
        failureReason: string; // what the dispatch threw: a daemon error's code, else its message, persisted in the row's `failure_reason` column so a retry under the same key answers the same reason
      }
    | { state: "requested" | "accepted" | "applied" | "degraded" | "expired" }
  );

// RunStateChange (event, not request/response). The `run.failed` variant carries the
// `providerFailureDetail` surface that mirrors the `failed`-variant `providerFailureDetail` of `DriverResumeResult`
// (provider-driver-payloads.md §Plan-003) — Spec-004 §Fallback Behavior requires resume-failure detail to reach the canonical audit
// log so Plan-012's recovery dispatcher and Plan-010's transcript can render the actionable
// reason for the failure without re-querying the driver. Plan-003 CP-003-3; Plan-004 Phase 3. A typed cause rides `failureCause`, never this text.
interface RunStateChangeEvent {
  runId: RunId;
  runVersion: number; // run-progression counter (D-002-1): the optimistic-concurrency comparand clients read via run.subscribeState and pass back as `expectedRunVersion`. Advances on every run progression, applied interventions included. A no-state-change advance with no per-type event of its own (e.g. native steer) is NOT emitted as a discrete run.subscribeState event (no transition to record, [Spec-003 §Driver-Level Steer Mechanics](../../specs/003-queue-steer-pause-resume.md#driver-level-steer-mechanics)); the carve-out is an undo's conversation cut — it transitions no state, but its per-type RunRolledBackEvent below rides the same stream carrying the fresh runVersion, so subscribers are never blind to a rewind. A non-intervening subscriber may still hold a stale comparand after a steer-like advance until its next guarded request is correctly rejected `expired`, whereupon it re-reads run-state and retries (reject→re-read→retry; V1 adds no broadcast push for such no-per-type-event bumps — Spec-005 §Security Events / Run Lifecycle). Distinct from the immutable EventEnvelope `.version` (Spec-005 §EventEnvelope Version Semantics) — that is the wire-contract semver; this is the run aggregate's concurrency token.
  previousState: RunState;
  newState: RunState;
  failureCategory?: RunFailureCategory;
  recoveryCondition?: RecoveryCondition; // named type in provider-driver-payloads.md §Plan-003: 'recovery-needed' | 'reauth-required'
  // The run's typed failure cause, present only on a `run.failed` (Spec-005 §Run Lifecycle):
  // `failureCause: { cause, origin }`, a named, closed failure-cause union in `packages/contracts`
  // (`run/control.ts`); each provider's own causes are normalized into it by its driver. The refusal
  // carries the refusing model and the provider's words; the usage limit carries the driver's
  // usage-limit signal (provider-driver-payloads.md §Plan-003) as it stood when the turn failed, so `Limit reached · resets
  // at <time>` is redrawn after a reload from this record alone; the spent retries draw
  // `<Provider> did not answer`; a setup gate's failure carries the gate's own error. `origin` is
  // `provider` where the driver normalized the provider's own cause and `daemon` where the app's own
  // refusal or failure ended the run.
  failureCause?:
    | {
        cause: "refused";
        origin: "provider" | "daemon";
        model: string;
        sentence?: string; // the provider's own sentence, absent when it sent none
        explanation?: string; // the provider's explanation, shown verbatim
        safetyCategory?: string; // the provider's open safety category, such as "cyber" or "bio"
      }
    | {
        cause: ProviderUsageLimitCause; // "plan-allowance-exhausted"
        origin: "provider";
        resetBoundary?: ProviderUsageLimitResetBoundary; // absent when no reset instant was known
      }
    | {
        // The provider's own retries ran out: Claude Code's turn ending after its last announced
        // `api_retry`, Codex's after its last reconnect attempt (`willRetry: false`).
        cause: "retries-exhausted";
        origin: "provider";
      }
    | {
        // A setup gate threw before the provider started the run, which ends it starting -> failed
        // with failureCategory "setup failure".
        cause: "setup-failed";
        origin: "daemon";
        code?: string; // the gate's error code, such as "workspace.execution_root_unresolved"
        message: string; // the gate's own words
      };
  // The provider's own failure prose on a `run.failed` with failureCategory "provider failure",
  // shown as given; a typed cause is `failureCause`, never this text.
  providerFailureDetail?: string;
  // Present only on a `run.failed` whose provider process ended on its own under the turn: exactly one
  // of the exit code and the signal, and the last lines the process printed. A process the daemon
  // closed itself, or a sleep, records none.
  processExit?:
    | { exitCode: number; signal?: never; outputTail: string }
    | { signal: string; exitCode?: never; outputTail: string };
  completionKind?: "turn" | "task"; // on `run.completed`: whether the completion closes a conversational turn or the whole task; every `run.completed` emitter sets it (Spec-005 §Run Lifecycle run-state payload)
  intendedClose?: true; // daemon-initiated closeSession clean-terminal discriminator: present only on that path, absent on every other terminal; consumers MUST NOT classify such a terminal as a crash (Spec-005 §Run Lifecycle "Intended-close discriminator")
  executionPosture?: ExecutionPosture; // named type in provider-driver-capability-payloads.md (same shape, shared with the CreateSessionParams/StartRunParams spawn/turn carriers). Stamped only on run.running — the post-setup-gate spawn-success transition, where the resolved workspace root and effective posture are final (Plan-002 gate seam; a run.starting stamp would be premature) — recording the run's effective sandbox/permission posture for audit (Spec-005 §Run Lifecycle run-state payload; shape owned by Spec-004, policy semantics per Spec-010 §Required Behavior). Optionality covers non-running rows only: run.running emitters MUST stamp the complete posture object — including credentialPolicyRef, which every run carries.
  trigger?:
    | "step_limit"
    | "spend_limit"
    | "token_limit"
    | "workflow_phase_canceled"
    | "daemon_restart"; // stop-condition provenance (ADR-017): rides run.interrupted when the service stops a run itself, at the step limit, the spend limit or the token limit the person set (D-013-6), because its workflow phase was canceled, or because a restart ended a child held in a pause. Absent on natural completion and user-initiated paths, including the person's interrupt a restart settles. The console has no runs pane to render it in: a stopped run's cause is told on the working line, which is where a run is paused and interrupted, and in the transcript's own state-changing rows ([Spec-021 §Required Behavior](../../specs/021-desktop-app-and-renderer.md#required-behavior)).
  // A run's linkage and its admission stamps ride the run.queued row alone (RunQueuedPayload, orchestration-payloads.md §Plan-013),
  // never this stream.
  timestamp: string;
}

// Forward, NON-STATE conversation-cut event (Spec-005 §Run Lifecycle, its per-type row). Emitted when an
// undo's conversation cut lands — `session.restore` with a scope that includes the conversation; a
// files-only undo emits none. `targetPosition` is the daemon's own normalized position of the turn
// boundary the run landed at: the daemon and the provider adapter keep that position, and it never
// appears in the undo request, which names a message or a snapshot. Non-terminal — zero interaction with
// the at-most-once terminal backstop — and deliberately NO previousState/newState: a cut is not a state
// transition, and fabricating one would corrupt the transition stream consumers rebuild from. Rides
// `run.subscribeState` alongside `RunStateChangeEvent` (the RPC table below).
interface RunRolledBackEvent {
  sessionId: SessionId;
  runId: RunId;
  runVersion: number; // the progression value after the cut, which advanced it
  targetPosition: number; // the turn-boundary anchor the run landed at (normalized session position)
}

// Run-control mutations (Spec-003 §Required Behavior). `pause` interrupts the active run + persists conversation/run
// state + queues a resume (orchestration-layer, never driver-gated per I-002-9); `resume` returns the
// `paused` run to active execution with the SAME run id. Both carry a MANDATORY `expectedRunVersion`
// optimistic-concurrency guard with the SAME fail-closed semantics as InterventionRequestPayload: a stale
// comparand rejects the request (the run is left untouched), never silently applied. This
// extends Plan-002 D-002-2's mandatory-comparand obligation to these orchestration-layer verbs — `pause` /
// `resume` hold no InterventionType membership (ADR-011), so the guard binds them by extension, not as
// interventions.
interface RunPauseRequest {
  targetRunId: RunId;
  expectedRunVersion: number;
}
interface RunResumeRequest {
  targetRunId: RunId;
  expectedRunVersion: number;
}
// Shared pause/resume ack: echoes the post-transition run state + the advanced `runVersion`, so the
// caller threads the fresh comparand into its next guarded request without a round-trip to run.subscribeState.
interface RunControlAck {
  runId: RunId;
  newState: RunState;
  runVersion: number;
}

// Subscription request shapes. Both subscriptions are session-scoped: the canonical event stream is
// per-session (Spec-005) and ADR-001 makes the session the authorization unit, so a caller subscribes
// within a session it can reach and fans out per run client-side via RunStateChangeEvent.runId.
interface RunStateSubscribeRequest {
  sessionId: SessionId;
}
interface RunQueueSubscribeRequest {
  sessionId: SessionId;
  childHandle?: ChildHandle; // a live child's own queue in place of the lead's
}

// A child's three controls: the session's own steer, interrupt and pause addressed at one live child
// (Spec-003 §Required Behavior). A child is addressed by the run it belongs to, `targetRunId`, PLUS
// `childHandle`, the handle the daemon's parent-to-child index holds for the provider's own subagent —
// never a bare child id. `childHandle` names only a provider's own subagent: a child the daemon bridges
// as a run of its own is steered, interrupted and paused through that run's own verbs. Each request
// carries the same guards as InterventionRequestPayload, on the run the child belongs to. A refusal is
// `run.child_control_refused` with `reason` `child_unknown` | `child_ended` | `provider_refused`, shared
// by all of them; a lost hold is a result, never a refusal.
interface ChildSteerRequest {
  targetRunId: RunId;
  childHandle: ChildHandle;
  content: string;
  expectedRunVersion: number;
  clientIdempotencyKey: string; // a UUID
}
// A child's steer goes onto the child's own queue, held by the daemon, so it answers as a queue
// send does (QueueItemCreateResponse), and the child's pending rows take the lead's four actions:
// reorder, `Edit`, `Remove` and `Send now`. An interrupt reaches that child only; its pending
// messages go as its next turn.
interface ChildInterruptRequest {
  targetRunId: RunId;
  childHandle: ChildHandle;
  expectedRunVersion: number;
  clientIdempotencyKey: string; // a UUID
  // `Send now` on one of the child's pending rows: the interrupt ends the child's turn and this
  // item goes first, the rest following in order as its next turn's messages.
  deliverFirst?: QueueItemId;
}
// Where the child stands after the interrupt; a child that had already finished answers the state it
// finished in.
interface ChildInterruptResponse {
  childHandle: ChildHandle;
  state: RunState;
}
// The pause toggle: `paused: true` takes the hold, and `paused: false`, the toggle's second press,
// answers the held callback with allow.
interface ChildPauseSetRequest {
  targetRunId: RunId;
  childHandle: ChildHandle;
  paused: boolean;
  expectedRunVersion: number;
  clientIdempotencyKey: string; // a UUID
}
interface ChildPauseSetResponse {
  childHandle: ChildHandle;
  paused: boolean; // the hold as it now stands
  // Present only when the hold was gone before the continue reached it (the provider canceled the held
  // call): the pause is LOST, the child is not paused, and it was never read as a release. Never beside
  // `paused: true`.
  holdLost?: true;
}
// The one stop that reaches a subtree: every child under the run, at every depth, one stop per id
// walked from the daemon's own parent-to-child index, never relayed through the lead — `stop_task`
// per child on Claude Code (final) and `turn/interrupt` per helper on Codex.
interface ChildrenStopRequest {
  runId: RunId;
}
interface ChildrenStopResponse {
  // One row per child the walk reached, so a failure is reported on its own row and never hides the
  // rest; nothing is atomic.
  children: Array<{
    child: AgentTreeMember; // orchestration-payloads.md §Plan-013: an agent by its id, or a provider's own helper by run and handle
    outcome: "stopped" | "already_ended" | "failed";
    reason?: string; // the daemon's reason, present exactly when outcome = 'failed'
  }>;
}
```

## Run-Control Method-Name Registry

Plan-002's queue / intervention / pause-resume operations and a child's controls are exposed as the `run.*` methods registered here as the canonical wire contract; the ones that act on the lead's run are defined in Plan-002 (D-002-3 / CP-002-4); the reciprocal namespace `provides` is recorded on [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) (the `run.*` method-name owner) in the cross-plan dependency map. Method-name strings are `dotted-camelCase` per `METHOD_NAME_FORMAT`, defined in local-ipc-payloads.md §Plan-005-Partial — Local IPC Daemon Control — the `run.*` namespace token is the run-aggregate domain noun, distinct from the `run_lifecycle` **event** taxonomy in [Spec-005 §Run Lifecycle](../../specs/005-session-event-taxonomy-and-audit-log.md#run-lifecycle-run_lifecycle) (the underscore form is a valid event name but is rejected as a method name by `METHOD_NAME_FORMAT`).

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `run.queueList` | `query` | `QueueItemListRequest` | `QueueItemListResponse` |
| `run.queueCreate` | `mutation` | `QueueItemCreateRequest` | `QueueItemCreateResponse` |
| `run.queueCancel` | `mutation` | `QueueItemCancelRequest` | `QueueItemCancelResponse` |
| `run.queueReorder` | `mutation` | `QueueReorderRequest` | `QueueItemListResponse` |
| `run.intervene` | `mutation` | `InterventionRequestPayload` | `InterventionRequestResponse` |
| `run.pause` | `mutation` | `RunPauseRequest` | `RunControlAck` |
| `run.resume` | `mutation` | `RunResumeRequest` | `RunControlAck` |
| `run.childSteer` | `mutation` | `ChildSteerRequest` | `QueueItemCreateResponse` |
| `run.childInterrupt` | `mutation` | `ChildInterruptRequest` | `ChildInterruptResponse` |
| `run.childPauseSet` | `mutation` | `ChildPauseSetRequest` | `ChildPauseSetResponse` |
| `run.childrenStop` | `mutation` | `ChildrenStopRequest` | `ChildrenStopResponse` |
| `run.subscribeState` | `subscription` | `RunStateSubscribeRequest` | `RunStateChangeEvent \| RunRolledBackEvent \| RunSafetyBufferingUpdatedPayload` (stream) |
| `run.subscribeQueue` | `subscription` | `RunQueueSubscribeRequest` | `QueueItemSummary` (stream) |

**What `run.pause` and `run.resume` realize, per provider.** Pause is a daemon feature, not a provider verb, and it writes no file. On a Claude Code lead it is two hooks registered in the session's `initialize` request and answered over the wire; on a child, on either provider, it is the daemon's pre-tool hook holding that child's next tool call, taken through the approval pipeline the daemon already owns; on a Codex lead it is the boundary interrupt. A hold ends only by an answer — allow from the resume, or deny carrying the person's typed words, which the child reads as its instruction — never by ending the hook, because any exit but a deny lets the held call run. The daemon sets each hook's timeout far past any wait a person would sit through — on Codex the largest timeout Codex accepts, which the Codex driver measures, with the hook answering deny a few seconds before it, because a Codex hook that times out lets the call run — so a hold is lossless: the held call simply goes unanswered, the leg burns no tokens and loses nothing. A cancellation of a held callback is treated as a LOST pause and never as a release. There is no separate "pause now" operation: `run.pause` and `run.resume` are the whole control, and a continue after a pause is a send rather than an operation of its own.

**A child's steer, interrupt and pause.** A live child gets the same three controls its session has, as calls of its own — `run.childSteer`, `run.childInterrupt` and `run.childPauseSet {paused}` — because the lead's steer and interrupt act on the lead; each rests on a provider-driver operation of its own beside the lead's. `run.childrenStop {runId}` is the one call that stops a subtree. What each satisfies:

- **The target.** A child's durable handle is the run it belongs to PLUS the provider's own child handle together, never a bare child id: `targetRunId` and `childHandle`, the task id from Claude Code's task-started frame or the thread id from Codex's turn-started frame, each persisted by the daemon at dispatch so a restart re-attaches every child by id. `childHandle` names only a provider's own subagent; a child the daemon bridges as a run of its own is addressed through that run's own verbs.
- **The mechanism, the same on both providers.** For a provider's own helper at any depth, a steer to a running child is the daemon's post-tool hook returning the words as added context aimed at that child — `agent_id` on Claude Code, the helper the hook input names on Codex — or, when it arrives as the child finishes, the continuation the helper-finish hook (`SubagentStop`) returns; the pause is the daemon's pre-tool hook holding the child's next call; the interrupt is that hold plus the end of its running command — never the provider's own stop-task tool; a steer to a held child answers the held call deny with the typed words; and a finished child is continued through its parent, which is asked to message it (`SendMessage` on Claude Code, `followup_task` on Codex). A steer lands at the child's next tool call, or as it finishes. Every helper a Codex agent starts is a multi-agent v2 helper, to which Codex refuses `turn/start` and `turn/steer`, so neither is ever sent to one; `turn/interrupt` reaches it.
- **The pause toggle.** `run.childPauseSet {paused: true}` takes the hold; `paused: false`, the toggle's second press, answers the held callback with allow. A cancellation of a held callback is a LOST pause, reported on the result as `holdLost`, never read as a release.
- **Offered on every child.** Each control is the daemon's own hook on both providers, at any depth. What gates it is the provider's own support, read from the `capabilities` array of Claude Code's init frame and from Codex's schema and model lists, never from a version compare; a hook the CLI refuses at `initialize` keeps the control, with the reason as its hover title. A control the provider then refuses answers `run.child_control_refused` with `provider_refused`, and the mechanism is never named to the person.
- **No fan-out.** An interrupt of one child reaches that child and nothing under it, and whatever dispatched it keeps running. The three stops that do reach a subtree — interrupt everything (`run.intervene {type: "interrupt"}` on the lead's run plus `run.childrenStop` on the same run), stop all running (`run.childrenStop`), and the undo's stop of the children started after its point — are one stop per id walked from the daemon's own parent-to-child index at every depth, never a relay through the lead, because neither provider's lead can stop a subtree: `stop_task` per child on Claude Code, which is final (the CLI refuses every later message to that child), and `turn/interrupt` per helper on Codex, where each child keeps its box. `run.childrenStop` reports each child's outcome on its own row, so one failure never hides the rest.

A refusal of any of the three is `run.child_control_refused`, with `reason` `child_unknown`, `child_ended` or `provider_refused`. Spec-003's V1 control set is the same three controls; these address them at a child.

`run.queueList` is the only `query` (idempotent read); the mutations are state-changing per the tRPC procedure-type convention in remote-control-payloads.md §Plan-025 — Remote Control Bootstrap. The lead's interrupt is `run.intervene {type: "interrupt"}`, and the person's steer is always a queue send, `run.queueCreate`: an edit of a waiting message is one `run.queueCreate` carrying `replacesQueueItemId`, and a new order is one `run.queueReorder`, never a client's cancel and resend. The `subscription`s stream their payload type per emission rather than returning a single response — `run.subscribeState` streams `RunStateChangeEvent | RunRolledBackEvent | RunSafetyBufferingUpdatedPayload` (the last is Codex's live safety-check hold, never appended; the state shape carries the `runVersion` comparand clients pass back as `expectedRunVersion`; the per-type non-state rollback arm — [Spec-005 §Run Lifecycle (run_lifecycle)](../../specs/005-session-event-taxonomy-and-audit-log.md#run-lifecycle-run_lifecycle) — rides the same stream so subscribers observe position rewinds without a fabricated transition), and `run.subscribeQueue` streams the `QueueItemSummary` projection (no separate queue-change event type exists). All request/response shapes are the interfaces defined directly above; the canonical Zod schemas live in `packages/contracts/src/run/control.ts` (CP-002-3), with the queue's in `run/queue.ts` and a child's controls in `run/children.ts`, per the api-payload-contracts.md §Source-of-Truth Policy.
