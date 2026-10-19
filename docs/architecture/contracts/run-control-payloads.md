# Run Control Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-002 — Queue Steer Pause Resume

```ts
// The daemon-minted handle of a provider's own helper in its session, minted once from the
// provider's own helper id and kept across every run of that helper. Opaque, and resolved only by
// the daemon, whose parent-to-child index minted it.
type ChildHandle = string & { readonly __brand: "ChildHandle" };

// `agent.queueItem.create`: one message the person sends to the lead, whether a turn is running
// or not.
interface AgentQueueItemCreateRequest {
  sessionId: SessionId;
  // addresses another session instead: the message arrives there as that session's own row
  to?: SessionId;
  // Binds the run a send starts to its repository; it never reorders what the person sees, which is
  // the daemon's order (`agent.queueItem.reorder`).
  workspaceId?: WorkspaceId;
  clientIdempotencyKey: string; // a UUID; a retried send returns the saved result
  content: string;
  // in staging order; how many a message carries is what the daemon and the provider accept
  attachments?: ArtifactId[];
  // Each skill the person picked from the composer's `/` and `$` list, in the order picked: the
  // row's front-matter name and its folder, both as `skill.list` gives them. The composer inserts
  // the provider's call form (`/name`, `$name`) into `content`, and the daemon passes the text
  // through unchanged; to a Codex agent each pick also travels in the turn's input as Codex's own
  // skill item `{type: "skill", name, path}`, its `path` the `SKILL.md` file Codex's own
  // `skills/list` names for a skill of that name in that folder, so of two Codex folders sharing
  // one name the row picked is the one that runs. A Claude Code agent receives the text alone.
  // Absent when nothing was picked. The folder crosses in from the client, so the daemon accepts a
  // pick only when its name and folder match a row of `skill.list`, and for a Codex agent a skill
  // Codex lists there, and refuses the send otherwise (`skill.pathRefused`, `notListed`); no path a
  // client sent reaches a provider.
  skills?: { name: string; folderPath: string }[];
  // An edit of a message still waiting, made in one call: the named item reads `superseded` and
  // this one takes its place in the order, so the edited message keeps its position. Refused once
  // the agent has taken the named message (`agent.queueItem.changeRefused`, `alreadyTaken`), when
  // Claude Code does not give it back, which then reads not delivered (`notDelivered`), and when
  // the queue holds no such item (`agent.queueItem.notFound`). The daemon does the replacing itself
  // — on Claude Code a cancel and a resend inside this call, on Codex a replacement in its own
  // hold, because a resend there would move the message to the end of the queue — and a client
  // never sends a cancel and a resend for an edit.
  replacesQueueItemId?: QueueItemId;
  // The question this send answers: Codex's non-waiting question, answered by an ordinary message.
  // The daemon copies it onto the `user.message.sent` row it writes, the mark that settles the
  // question on every device. Absent on a send that answers no question.
  answersQuestionId?: QuestionId;
  // The output-speed level this send's turn alone runs at, the agent's own level unchanged: `Use
  // standard` on a turn that failed for want of flex capacity resends the same words with the
  // provider's standard level here, which Codex takes as `turn/start.serviceTierForTurn`, and the
  // next turn runs on the agent's level again. Absent on every other send.
  outputSpeedForTurn?: string;
}
interface AgentQueueItemCreateResponse {
  queueItemId: QueueItemId;
  state: QueueItemState;
  // present exactly on a notDelivered item, as a retried send of one whose delivery failed answers
  notDeliveredReason?: QueueItemNotDeliveredReason;
  createdAt: string;
}
// Orchestration seam (D-013-9): Plan-013's orchestration-run-service composes with the daemon
// queue-admission service IN-PROCESS, passing an OrchestrationRunLinkCarrier (see
// orchestration-payloads.md §Plan-013) after its own admission pipeline passes. The in-process
// admission API returns the minted RunId (the agent.run.queued emission's runId) alongside
// queueItemId, and agent.run.queued carries the carrier fields durably (Spec-005 §Run Lifecycle
// agent.run.queued row). The wire agent.queueItem.create method never accepts the carrier —
// child-run creation goes through agent.run.create only.

// `agent.queueItem.list`: a queue in the daemon's order.
interface AgentQueueItemListRequest {
  sessionId: SessionId;
  // A live child's own queue in place of the lead's. The same member narrows
  // agent.queueItem.subscribe, agent.queueItem.cancel and agent.queueItem.reorder, so a child's
  // pending rows work as the lead's do.
  childHandle?: ChildHandle;
  // The items in this state; absent, the items still waiting and those not delivered, never the
  // ones the agent took or that ended otherwise.
  state?: QueueItemState;
}
interface AgentQueueItemListResponse {
  items: QueueItemSummary[];
}

// Why a message the daemon accepted was never delivered: the run it waited for waited at the memory
// gate past the daemon's own delivery timeout to start (`timedOut`), or its delivery failed
// outright (`failed`). Either way it can be sent again.
type QueueItemNotDeliveredReason = "timedOut" | "failed";

// One queued message, as a pending row draws it.
interface QueueItemSummary {
  id: QueueItemId;
  state: QueueItemState;
  // Its place in its queue's order, lowest first; an edit takes the place of the message it
  // replaced.
  position: number;
  content: string;
  attachments?: ArtifactId[];
  childHandle?: ChildHandle; // the child whose queue holds it; absent on the lead's
  notDeliveredReason?: QueueItemNotDeliveredReason; // present exactly on a notDelivered item
  createdAt: string;
  updatedAt: string;
}

// `agent.queueItem.cancel`: `Remove`. Refused for an item the queue does not hold
// (`agent.queueItem.notFound`), one the agent has taken (`agent.queueItem.changeRefused`,
// `alreadyTaken`), and one Claude Code does not give back, which then reads not delivered
// (`notDelivered`).
interface AgentQueueItemCancelRequest {
  queueItemId: QueueItemId;
  childHandle?: ChildHandle; // the child whose queue holds the item
}
interface AgentQueueItemCancelResponse {
  queueItemId: QueueItemId;
  state: "canceled";
}

// `agent.queueItem.reorder`: one daemon-held order over the items still waiting, on the lead's
// queue or a child's. `queueItemIds` is the full new order, naming each item once, and is refused
// unless it names exactly the items still waiting (`agent.queueItem.changeRefused`,
// `orderMismatch`). On Codex the daemon reorders its own hold; on Claude Code it cancels and
// resends in the new order. The daemon holds the order itself because a cancel and a resend on
// Codex would put the message last. The answer is the queue in its new order.
interface AgentQueueItemReorderRequest {
  sessionId: SessionId;
  childHandle?: ChildHandle;
  queueItemIds: QueueItemId[]; // at least one
}

// `agent.run.intervene` (discriminated union by type)
// `expectedRunVersion` is the MANDATORY optimistic-concurrency comparand (Plan-002 D-002-2,
// fail-closed): every intervention carries the run version the caller last observed, and the daemon
// rejects the request as `expired` when it does not match the run's current `runVersion` (surfaced
// on RunStateChangeEvent / AgentRunControlResponse / AgentRunInterveneResponse below). The field is
// required — an absent comparand is rejected, never applied (an optional field would let a caller
// bypass the stale-request guard by omitting it). The compared-against counter is `runVersion`
// (Plan-002 D-002-1): an any-run-progression counter that advances on every run progression,
// applied interventions included — distinct from the immutable EventEnvelope `.version`
// wire-contract field (Spec-005 §EventEnvelope Version Semantics). `clientIdempotencyKey` is the
// second mandatory guard — a requester-generated UUID giving at-least-once delivery exactly-once
// application: the daemon persists it on the interventions row (UNIQUE(target_run_id,
// client_idempotency_key)); an identical retry returns the saved result without re-dispatching, and
// key reuse with a differing payload is rejected as `agent.intervention.idempotencyConflict`
// (Spec-004 §Required Behavior). The two guards are orthogonal: `expectedRunVersion` is the
// stale-request guard, refusing OUTDATED intent; `clientIdempotencyKey` is the duplicate-request
// guard, refusing a second application of the SAME intent.
type AgentRunInterveneRequest =
  | {
      // The lead's interrupt. `Interrupt everything` is this arm on the lead's run plus
      // `agent.childRun.stopAll` on the same run (§Run-Control Method-Name Registry below).
      type: "interrupt";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      reason?: string;
      // The messages still waiting when the turn ends: sent at once as the next turn (`nextTurn`),
      // or put back into the draft one line per message in send order (`returnToDraft`, which
      // `Interrupt everything` sends).
      pending: "nextTurn" | "returnToDraft";
      // `Send now` on a waiting message on Codex: the interrupt ends the turn and this item goes
      // first, the rest following in order as the next turn's messages. Only with
      // `pending: "nextTurn"`. On Claude Code `Send now` is no interrupt: the daemon takes back the
      // rows ahead, sends this one with `priority: "now"` and resends the rows ahead after it, with
      // no `Turn interrupted` row.
      deliverFirst?: QueueItemId;
    }
  | {
      // Codex's retry on the faster model its safety check names (Spec-004 §Required Behavior): the
      // daemon interrupts the turn, forks the conversation to just before it and sends the same
      // message again on `model`. A turn that is no longer the latest, or whose reply has started,
      // is `rejected`.
      type: "fasterModelRetry";
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
// Undo is not an intervention. Putting a session back to before one of its messages, or to one of
// its snapshots, is the session's own call, `session.restore`, read first through its dry run
// `session.restore.preview`, which takes the same session, target and scope and changes nothing;
// the dry run's request and figures are in persistence-payloads.md §Plan-012 — Persistence And
// Recovery, and the undo's request and result are these. The request names a `target` — one of the
// person's own messages by its cursor, or one of the session's snapshots by its id, never a numeric
// or provider position — and a `scope`: "conversationAndFiles" | "conversation" | "files". One undo
// is one intent with one result: `requested` (the scope asked for), `restored` (the scope that
// applied, or "nothing"), and, for each requested part that did not apply, `failures.conversation`
// / `failures.files` carrying its `reason`, because the conversation cut can land while the files
// cannot be put back, or the reverse. Edit and resend is the same one call, and a call carrying
// `resend` takes the scope `conversationAndFiles`, so a cut that landed while the resend failed is
// its own outcome, `resendUnapplied`, reported as that result and never as a second call's failure;
// the edited message goes back in the composer. The conversation cut alone is recorded by
// `agent.run.rolledBack` (AgentRunRolledBackEvent below), and every undo's outcome by
// `session.restore.completed`.
// daemon-minted, opaque to every client
type SnapshotId = string & { readonly __brand: "SnapshotId" };
type SessionRestoreTarget =
  | { kind: "message"; anchorCursor: EventCursor } // before one of the person's own messages
  | { kind: "snapshot"; snapshotId: SnapshotId };
type SessionRestoreScope = "conversationAndFiles" | "conversation" | "files";
interface SessionRestoreRequest {
  sessionId: SessionId;
  target: SessionRestoreTarget;
  scope: SessionRestoreScope; // "conversationAndFiles" whenever `resend` is present
  // a UUID, unique within the session: a retried call never cuts twice
  clientIdempotencyKey: string;
  // false unless the person pressed the include line: also put back the paths another session in
  // the same folder changed since the point
  includeAlsoChanged: boolean;
  // The edited message an edit and resend sends once the undo has applied, with its files; its
  // presence makes edit and resend one call.
  resend?: { content: string; attachments?: ArtifactId[] };
}
type SessionRestoreOutcome =
  | {
      outcome: "restoreFinished";
      requested: SessionRestoreScope;
      restored: SessionRestoreScope | "nothing";
      // What the files part actually did, present exactly when the files went back (`restored` is
      // "files" or "conversationAndFiles"). These are the undo's own figures, not the dry run's,
      // because the folder can change between the two.
      files?: {
        restoredFileCount: number;
        restoredLineCount: number;
        // persistence-payloads.md §Plan-012
        skipped: Array<{ path: string; reason: SessionRestoreSkipReason }>;
      };
      // Every requested part that did not go back carries the daemon's reason here.
      failures?: {
        conversation?: { reason: string }; // the conversation part was requested and did not apply
        files?: { reason: string }; // the files part was requested and did not apply
      };
    }
  // An edit and resend whose undo applied and whose send failed, with the send's reason.
  | { outcome: "resendUnapplied"; reason: string };
interface InterventionResponseBase {
  interventionId: InterventionId;
  interventionType: InterventionType;
  // post-application run counter (D-002-1) — the caller threads this into the next intervention's
  // `expectedRunVersion`. Carried on the response because an applied native steer advances the run
  // version WITHOUT an `agent.run.*` state change (Spec-003 §Driver-Level Steer Mechanics), so for
  // that path the response is the only place the caller can read the fresh comparand.
  runVersion: number;
}
// A `rejected` answer always carries its `rejectionReason` and a `failed` one its `failureReason`;
// no other state carries a reason. No state carries a result: what an intervention did reaches the
// screen as the run's own events.
type AgentRunInterveneResponse = InterventionResponseBase &
  (
    | {
        state: "rejected";
        // machine-readable cause on a `rejected` OUTCOME, which is a normal `agent.run.intervene`
        // response and not a JSON-RPC transport error, so the CLI renders WHY (e.g.
        // `provider.capability.unsupported`). A request-admission refusal (e.g.
        // `agent.intervention.idempotencyConflict`, 422) is a JsonRpcError that produces no
        // intervention row, so it never rides here. Durable across a retry: the cause persists in
        // the intervention row's own `rejection_reason` column (Plan-002 T1.4 DDL), so a retry that
        // returns the saved result reconstructs the SAME machine-readable reason from that column,
        // never fabricating one.
        rejectionReason: string;
      }
    | {
        state: "failed";
        // what the dispatch threw: a daemon error's code, else its message, the restart that kept
        // it from completing, or the run's end and continue that kept it from being sent,
        // persisted in the row's `failure_reason` column so a retry under the same key answers
        // the same reason
        failureReason: string;
      }
    | { state: "requested" | "accepted" | "applied" | "degraded" | "expired" }
  );

// RunStateChange (event, not request/response). The `agent.run.failed` variant carries the
// `providerFailureDetail` surface that mirrors the `failed`-variant `providerFailureDetail` of
// `DriverResumeResult` (provider-driver-payloads.md §Plan-003) — Spec-004 §Fallback Behavior
// requires resume-failure detail to reach the canonical audit log so Plan-012's recovery dispatcher
// and Plan-010's transcript can render the actionable reason for the failure without re-querying
// the driver. Plan-003 CP-003-3; Plan-004 Phase 3. A typed cause rides `failureCause`, never this
// text.
interface RunStateChangeEvent {
  runId: RunId;
  // run-progression counter (D-002-1): the optimistic-concurrency comparand clients read via
  // agent.run.subscribe and pass back as `expectedRunVersion`. Advances on every run progression,
  // applied interventions included. A no-state-change advance with no per-type event of its own
  // (e.g. native steer) is NOT emitted as a discrete agent.run.subscribe event (no transition to
  // record, [Spec-003 §Driver-Level Steer
  // Mechanics](../../specs/003-queue-steer-pause-resume.md#driver-level-steer-mechanics)); the
  // carve-out is an undo's conversation cut — it transitions no state, but its per-type
  // AgentRunRolledBackEvent below rides the same stream carrying the fresh runVersion, so
  // subscribers are never blind to a rewind. A non-intervening subscriber may still hold a stale
  // comparand after a steer-like advance until its next guarded request is correctly rejected
  // `expired`, whereupon it re-reads run-state and retries (reject→re-read→retry; V1 adds no
  // broadcast push for such no-per-type-event bumps — Spec-005 §Security Events / Run Lifecycle).
  // Distinct from the immutable EventEnvelope `.version` (Spec-005 §EventEnvelope Version
  // Semantics) — that is the wire-contract semver; this is the run aggregate's concurrency token.
  runVersion: number;
  previousState: RunState;
  newState: RunState;
  failureCategory?: RunFailureCategory;
  // named type in provider-driver-payloads.md §Plan-003: 'recoveryNeeded' | 'reauthRequired'
  recoveryCondition?: RecoveryCondition;
  // The run's typed failure cause, present only on an `agent.run.failed` (Spec-005 §Run Lifecycle):
  // `failureCause: { cause, origin }`, a named, closed failure-cause union in `packages/contracts`
  // (`run/failure-cause.ts`); each provider's own causes are normalized into it by its driver. The
  // refusal carries the refusing model and the provider's words; the usage limit carries the
  // driver's usage-limit signal (provider-driver-payloads.md §Plan-003) as it stood when the turn
  // failed, so `Limit reached · resets at <time>` is redrawn after a reload from this record alone;
  // the spent retries draw `<Provider> did not answer`; a setup gate's failure carries the gate's
  // own error; a turn too long for the window returns its message; no flex capacity draws `Use
  // standard` beside `Try again`. `origin` is `provider` where the driver normalized the provider's
  // own cause and `daemon` where the app's own refusal or failure ended the run.
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
        cause: ProviderUsageLimitCause; // "planAllowanceExhausted"
        origin: "provider";
        resetBoundary?: ProviderUsageLimitResetBoundary; // absent when no reset instant was known
      }
    | {
        // The provider's own retries ran out: Claude Code's turn ending after its last announced
        // `api_retry`, Codex's after its last reconnect attempt (`willRetry: false`).
        cause: "retriesExhausted";
        origin: "provider";
      }
    | {
        // A setup gate threw before the provider started the run, which ends it starting -> failed
        // with failureCategory "setupFailure".
        cause: "setupFailed";
        origin: "daemon";
        code?: string; // the gate's error code, such as "workspace.executionRoot.unresolved"
        message: string; // the gate's own words
      }
    | {
        // A turn too long for the context window even after compaction, cut back out of the
        // conversation; the person's message goes back to the composer as a failed send.
        cause: "contextWindowExceeded";
        origin: "provider";
        returnedMessageId: string;
      }
    | {
        // A turn sent on the flex speed that the provider failed for want of flex capacity, which
        // it does not retry: `Flex capacity unavailable · Try again · Use standard`.
        cause: "flexCapacityUnavailable";
        origin: "provider";
      };
  // The provider's own failure prose on an `agent.run.failed` with failureCategory
  // "providerFailure", shown as given; a typed cause is `failureCause`, never this text.
  providerFailureDetail?: string;
  // Present only on an `agent.run.failed` whose provider process ended on its own under the turn:
  // exactly one of the exit code and the signal, and the last lines the process printed. A process
  // the daemon closed itself, or a sleep, records none.
  processExit?:
    | { exitCode: number; signal?: never; outputTail: string }
    | { signal: string; exitCode?: never; outputTail: string };
  // daemon-initiated closeSession clean-terminal discriminator: present only on that path, absent
  // on every other terminal; consumers MUST NOT classify such a terminal as a crash (Spec-005 §Run
  // Lifecycle "Intended-close discriminator")
  intendedClose?: true;
  // named type in provider-driver-capability-payloads.md (same shape, shared with the
  // CreateSessionParams/StartRunParams spawn/turn carriers). Stamped only on agent.run.running —
  // the post-setup-gate spawn-success transition, where the resolved workspace root and effective
  // posture are final (Plan-002 gate seam; an agent.run.starting stamp would be premature) —
  // recording the run's effective sandbox/permission posture for audit (Spec-005 §Run Lifecycle
  // run-state payload; shape owned by Spec-004, policy semantics per Spec-010 §Required Behavior).
  // Optionality covers non-running rows only: agent.run.running emitters MUST stamp the complete
  // posture object — including credentialPolicyRef, which every run carries.
  executionPosture?: ExecutionPosture;
  // stop-condition provenance (ADR-017): rides agent.run.interrupted when the service interrupts a
  // run itself, at the step limit or the spend limit the person set (D-013-6), because its workflow
  // phase was canceled, or because a restart ended a child held in a pause; and rides
  // agent.run.stopped as `tokenLimit` at the run's token limit, which ends the run. A restart that
  // settles the daemon's pending limit stop writes the limit's own value. Absent on natural
  // completion and user-initiated paths, including the person's interrupt a restart settles. The
  // console has no runs pane to render it in: a stopped run's cause is told on the working line,
  // which is where a run is paused and interrupted, and in the transcript's own state-changing rows
  // ([Spec-021 §Required Behavior](../../specs/021-desktop-app-and-renderer.md#required-behavior)).
  // Typed per state: InterruptReason on interrupted, "tokenLimit" on stopped, never elsewhere.
  trigger?: InterruptReason | "tokenLimit";
  // A run's linkage and its admission stamps ride the agent.run.queued row alone
  // (AgentRunQueuedPayload, orchestration-payloads.md §Plan-013), never this stream.
  timestamp: string;
}

// Forward, NON-STATE conversation-cut event (Spec-005 §Run Lifecycle, its per-type row). Emitted
// when an undo's conversation cut lands — `session.restore` with a scope that includes the
// conversation; a files-only undo emits none. `targetPosition` is the daemon's own normalized
// position of the turn boundary the run landed at: the daemon and the provider adapter keep that
// position, and it never appears in the undo request, which names a message or a snapshot.
// Non-terminal — zero interaction with the at-most-once terminal backstop — and deliberately NO
// previousState/newState: a cut is not a state transition, and fabricating one would corrupt the
// transition stream consumers rebuild from. Rides `agent.run.subscribe` alongside
// `RunStateChangeEvent` (the RPC table below).
interface AgentRunRolledBackEvent {
  sessionId: SessionId;
  runId: RunId;
  runVersion: number; // the progression value after the cut, which advanced it
  // the turn-boundary anchor the run landed at (normalized session position)
  targetPosition: number;
}

// agent.run.safetyBuffering.updated — Codex's `model/safetyBuffering/updated`, its
// `showBufferingUi` carried as `active` (Spec-005 §Run Lifecycle). A LIVE event on the run's own
// state stream, `agent.run.subscribe`, outside the session-event union: the daemon never appends
// it, so it has no sequence, is not kept in the session's history and is not resent; a re-opened
// session does not show it. While `active` is true the working line's action words read Codex's own
// sentence in place of the verb, and when Codex clears the flag or the reply starts, the verb
// returns. It draws no flow row, and a Claude Code session carries none, because Claude Code
// sends no such signal.
interface RunSafetyBufferingUpdatedPayload {
  sessionId: SessionId;
  runId: RunId;
  turnId: string;
  active: boolean;
  fasterModel?: string; // the faster model Codex names, carried as sent
}

// Run-control mutations (Spec-003 §Required Behavior). `pause` holds the run at its next tool
// boundary + persists conversation/run state and queues nothing (orchestration-layer, never
// driver-gated per I-002-9); `Pause` is a toggle, and `resume`, the toggle pressed again or a send,
// returns the `pausing` or `paused` run to active execution with the SAME run id. Both carry a
// MANDATORY `expectedRunVersion` optimistic-concurrency guard with the SAME fail-closed semantics
// as AgentRunInterveneRequest: a stale comparand rejects the request (the run is left untouched),
// never silently applied. This extends Plan-002 D-002-2's mandatory-comparand obligation to these
// orchestration-layer verbs — `pause` / `resume` hold no InterventionType membership (ADR-011), so
// the guard binds them by extension, not as interventions.
interface AgentRunPauseRequest {
  targetRunId: RunId;
  expectedRunVersion: number;
}
interface AgentRunResumeRequest {
  targetRunId: RunId;
  expectedRunVersion: number;
}
// Shared pause/resume ack: echoes the post-transition run state + the advanced `runVersion`, so the
// caller threads the fresh comparand into its next guarded request without a round-trip to
// agent.run.subscribe.
interface AgentRunControlResponse {
  runId: RunId;
  newState: RunState;
  runVersion: number;
}

// Subscription request shapes. Both subscriptions are session-scoped: the canonical event stream is
// per-session (Spec-005) and ADR-001 makes the session the authorization unit, so a caller
// subscribes within a session it can reach and fans out per run client-side by each change's
// `runId`. Each takes an optional resume cursor, the newest one the subscriber holds: the daemon
// first replays from its record what changed past it, then follows live. Without one the stream
// starts at the newest event.
interface AgentRunSubscribeRequest {
  sessionId: SessionId;
  // Replays each run-state change after this cursor before the live ones.
  afterCursor?: EventCursor;
}
interface AgentQueueItemSubscribeRequest {
  sessionId: SessionId;
  childHandle?: ChildHandle; // a live child's own queue in place of the lead's
  // Replays each item that changed after this cursor, at the cursor of its newest change, and each
  // item still waiting that nothing changed, at the newest cursor, before the live changes.
  afterCursor?: EventCursor;
}

// Each notify's value on both run streams, the frame the session stream sends too
// (`SessionStreamFrame`, session-payloads.md §Plan-001 — Session Core), framed by the rule of
// Spec-006 §Required Behavior: the changes since the previous frame, oldest first, each with its
// own cursor. The daemon never waits for a subscriber and drops nothing for it: the subscription
// holds only the subscriber's cursor and reads its next frame from the daemon's record when the
// subscriber can take it. A subscriber further behind the stream's newest than that rule's
// threshold is sent one frame with no changes carrying the stream's newest cursor, which says it is
// behind, and takes a snapshot read in place of every change. A frame with changes carries no frame
// cursor.
interface StreamFrame<Change, Cursor> {
  changes: Change[]; // at most `STREAM_FRAME_MAX_CHANGES`
  cursor?: Cursor; // only on the frame with no changes, the one that says the subscriber is behind
}
// One change on agent.run.subscribe: the delivery and the cursor of the event it came from, or, for
// Codex's safety hold, which the session's history never records, the session's newest cursor when
// it went out.
interface RunStateStreamChange {
  cursor: EventCursor;
  event: RunStateChangeEvent | AgentRunRolledBackEvent | RunSafetyBufferingUpdatedPayload;
}
type RunStateStreamFrame = StreamFrame<RunStateStreamChange, EventCursor>;
// One change on agent.queueItem.subscribe: the item as it now stands, and the cursor of the
// `agent.queueItem.*` event that changed it, or, for a reorder, which no event records, the
// session's newest cursor when the change went out.
interface RunQueueStreamChange {
  cursor: EventCursor;
  item: QueueItemSummary;
}
type RunQueueStreamFrame = StreamFrame<RunQueueStreamChange, EventCursor>;

// A child's three controls: the session's own steer, interrupt and pause addressed at one child
// (Spec-003 §Required Behavior). A steer names the helper itself, its session and `childHandle`, so
// it reaches a helper whose parent run has ended, which the daemon carries through the parent's
// current run; an interrupt and a pause reach only a live child, addressed by the run it belongs
// to, `targetRunId`, PLUS `childHandle`, the handle the daemon's parent-to-child index holds for
// the provider's own subagent — never a bare child id. `childHandle` names only a provider's own
// subagent: a child the daemon bridges as a run of its own is steered, interrupted and paused
// through that run's own verbs. The interrupt and the pause carry the same guards as
// AgentRunInterveneRequest, on the run the child belongs to; the steer carries the idempotency key
// alone. A `childHandle` that names no child of the run is `agent.childRun.notFound`; any other
// refusal is `agent.childRun.controlRefused` with `reason` `childEnded` | `providerRefused`, shared
// by all of them; a lost hold is a result, never a refusal.
interface AgentChildRunSteerRequest {
  sessionId: SessionId;
  childHandle: ChildHandle;
  content: string;
  clientIdempotencyKey: string; // a UUID; a retry's key is the failed steer's queue item id
  // A retry, with its own words, of a child's steer that reads not delivered: it goes again as a
  // new message at the end of the child's queue, and the failed one reads `superseded`.
  replacesQueueItemId?: QueueItemId;
}
// A child's steer goes onto the child's own queue, held by the daemon, so it answers as a queue
// send does (AgentQueueItemCreateResponse), and the child's pending rows take the lead's four
// actions: reorder, `Edit`, `Remove` and `Send now`. A steer into an interrupted child whose own
// parent run carries it continues the child's run; a steer into an ended child (completed, failed
// or stopped), or one that goes through a new parent run, starts the helper's next run under the
// parent's current run. An interrupt reaches that child only; its pending messages go as its next
// turn.
interface AgentChildRunInterruptRequest {
  targetRunId: RunId;
  childHandle: ChildHandle;
  expectedRunVersion: number;
  clientIdempotencyKey: string; // a UUID
  // `Send now` on one of the child's pending rows on Codex: the interrupt ends the child's turn
  // and this item goes first, the rest following in order as its next turn's messages. On Claude
  // Code a child's `Send now` is no interrupt, as the lead's is not.
  deliverFirst?: QueueItemId;
}
// Where the child stands after the interrupt; a child that had already finished answers the state
// it finished in.
interface AgentChildRunInterruptResponse {
  childHandle: ChildHandle;
  state: RunState;
}
// The pause toggle: `paused: true` takes the hold, and `paused: false`, the toggle's second press,
// answers the held callback with allow.
interface AgentChildRunPausedUpdateRequest {
  targetRunId: RunId;
  childHandle: ChildHandle;
  paused: boolean;
  expectedRunVersion: number;
  clientIdempotencyKey: string; // a UUID
}
interface AgentChildRunPausedUpdateResponse {
  childHandle: ChildHandle;
  paused: boolean; // the hold as it now stands
  // Present only when the hold was gone before the continue reached it (the provider canceled the
  // held call): the pause is LOST, the child is not paused, and it was never read as a release.
  // Never beside `paused: true`.
  holdLost?: true;
}
// The one stop that reaches a subtree: every child under the run, at every depth, one stop per id
// walked from the daemon's own parent-to-child index, never relayed through the lead — `stop_task`
// per child on Claude Code, which ends it `stopped` for good, and `turn/interrupt` per helper on
// Codex, which leaves it `interrupted`.
interface AgentChildRunStopAllRequest {
  runId: RunId;
}
interface AgentChildRunStopAllResponse {
  // One row per child the walk reached, so a failure is reported on its own row and never hides the
  // rest; nothing is atomic.
  children: Array<{
    // orchestration-payloads.md §Plan-013: an agent by its id, or a provider's own helper by run
    // and handle
    child: AgentTreeMember;
    // "stopped": the stop reached the child.
    outcome: "stopped" | "alreadyEnded" | "failed";
    // The run state the stop left the child in, present exactly when outcome = 'stopped':
    // `stopped` where the provider's stop is final, `interrupted` where a send can continue it.
    state?: "stopped" | "interrupted";
    reason?: string; // the daemon's reason, present exactly when outcome = 'failed'
  }>;
}
```

## Run-Control Method-Name Registry

Plan-002's queue / intervention / pause-resume operations and a child's controls are exposed as the `agent.run.*`, `agent.queueItem.*` and `agent.childRun.*` methods registered here as the canonical wire contract; the ones that act on the lead's run are defined in Plan-002 (D-002-3 / CP-002-4); the reciprocal namespace `provides` is recorded on [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) (the owner of these method names) in the cross-plan dependency map. Method-name strings follow the [wire-name grammar](./local-ipc-payloads.md#wire-name-grammar); the `run` resource segment is the run-aggregate noun, distinct from the `runLifecycle` **event** taxonomy in [Spec-005 §Run Lifecycle](../../specs/005-session-event-taxonomy-and-audit-log.md#run-lifecycle-runlifecycle).

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `agent.queueItem.list` | `query` | `AgentQueueItemListRequest` | `AgentQueueItemListResponse` |
| `agent.queueItem.create` | `mutation` | `AgentQueueItemCreateRequest` | `AgentQueueItemCreateResponse` |
| `agent.queueItem.cancel` | `mutation` | `AgentQueueItemCancelRequest` | `AgentQueueItemCancelResponse` |
| `agent.queueItem.reorder` | `mutation` | `AgentQueueItemReorderRequest` | `AgentQueueItemListResponse` |
| `agent.run.intervene` | `mutation` | `AgentRunInterveneRequest` | `AgentRunInterveneResponse` |
| `agent.run.pause` | `mutation` | `AgentRunPauseRequest` | `AgentRunControlResponse` |
| `agent.run.resume` | `mutation` | `AgentRunResumeRequest` | `AgentRunControlResponse` |
| `agent.childRun.steer` | `mutation` | `AgentChildRunSteerRequest` | `AgentQueueItemCreateResponse` |
| `agent.childRun.interrupt` | `mutation` | `AgentChildRunInterruptRequest` | `AgentChildRunInterruptResponse` |
| `agent.childRun.paused.update` | `mutation` | `AgentChildRunPausedUpdateRequest` | `AgentChildRunPausedUpdateResponse` |
| `agent.childRun.stopAll` | `mutation` | `AgentChildRunStopAllRequest` | `AgentChildRunStopAllResponse` |
| `agent.run.subscribe` | `subscription` | `AgentRunSubscribeRequest` | `SubscribeAckResponse`, then `RunStateStreamFrame` frames |
| `agent.queueItem.subscribe` | `subscription` | `AgentQueueItemSubscribeRequest` | `SubscribeAckResponse`, then `RunQueueStreamFrame` frames |

**What `agent.run.pause` and `agent.run.resume` realize, per provider.** Pause is a daemon feature, not a provider verb, and it writes no file. On a Claude Code lead it is two hooks registered in the session's `initialize` request and answered over the wire; on a child, on any provider, it is the daemon's pre-tool hook holding that child's next tool call, taken through the approval pipeline the daemon already owns; on a Codex lead it is the boundary interrupt. A hold ends only by an answer — allow from the resume, or deny carrying the person's typed words, which the child reads as its instruction — never by ending the hook, because any exit but a deny lets the held call run. The daemon sets each hook's timeout far past any wait a person would sit through — on Codex 10^12 seconds on the hook row and its entry's tool timeout together, because Codex cuts the call at the smaller of the two and a Codex hook that times out lets the call run — so a hold is lossless: the held call simply goes unanswered, the leg burns no tokens and loses nothing. A cancellation of a held callback is treated as a LOST pause and never as a release. There is no separate "pause now" operation: `agent.run.pause` and `agent.run.resume` are the whole control, and a continue after a pause is a send rather than an operation of its own.

**A child's steer, interrupt and pause.** A live child gets the same three controls its session has, as calls of its own — `agent.childRun.steer`, `agent.childRun.interrupt` and `agent.childRun.paused.update {paused}` — because the lead's steer and interrupt act on the lead; each rests on a provider-driver operation of its own beside the lead's. `agent.childRun.stopAll {runId}` is the one call that stops a subtree. What each satisfies:

- **The target.** A child's durable handle is the run it belongs to PLUS the provider's own child handle together, never a bare child id: `targetRunId` and `childHandle`, the task id from Claude Code's task-started frame or the thread id from Codex's turn-started frame, each persisted by the daemon at dispatch so a restart re-attaches every child by id. `childHandle` names only a provider's own subagent; a child the daemon bridges as a run of its own is addressed through that run's own verbs.
- **The mechanism, the same on every provider.** For a provider's own helper at any depth, a steer to a running child is the daemon's post-tool hook returning the words as added context aimed at that child — `agent_id` on Claude Code, the helper the hook input names on Codex — or, when it arrives as the child finishes, the continuation the helper-finish hook (`SubagentStop`) returns; the pause is the daemon's pre-tool hook holding the child's next call; the interrupt is that hold plus the end of its running command — never the provider's own stop-task tool; a steer to a held child answers the held call deny with the typed words; and a send into an ended child — completed, failed, or stopped at its token limit — goes through its parent, which is asked to message it (`SendMessage` on Claude Code, `followup_task` on Codex), and starts the helper's next run under the parent's current run. A steer lands at the child's next tool call, or as it finishes. Every helper a Codex agent starts is a multi-agent v2 helper, to which Codex refuses `turn/start` and `turn/steer`, so neither is ever sent to one; `turn/interrupt` reaches it.
- **The pause toggle.** `agent.childRun.paused.update {paused: true}` takes the hold; `paused: false`, the toggle's second press, answers the held callback with allow. A cancellation of a held callback is a LOST pause, reported on the result as `holdLost`, never read as a release.
- **Offered on every child.** Each control is the daemon's own hook on every provider, at any depth. What gates it is the provider's own support, read from the `capabilities` array of Claude Code's init frame and from Codex's schema and model lists, never from a version compare; a hook the CLI refuses at `initialize` keeps the control, with the reason as its hover label, which a press on the control also opens; the press shows only the reason and runs nothing. A control the provider then refuses answers `agent.childRun.controlRefused` with `providerRefused`, and the mechanism is never named to the person.
- **No fan-out.** An interrupt of one child reaches that child and nothing under it, and whatever dispatched it keeps running. The three stops that do reach a subtree — interrupt everything (`agent.run.intervene {type: "interrupt"}` on the lead's run plus `agent.childRun.stopAll` on the same run), stop all running (`agent.childRun.stopAll`), and the undo's stop of the children started after its point — are one stop per id walked from the daemon's own parent-to-child index at every depth, never a relay through the lead, because neither Claude Code's lead nor Codex's can stop a subtree: `stop_task` per child on Claude Code, which is final (the CLI refuses every later message to that child), and `turn/interrupt` per helper on Codex, where each child rests `interrupted` and keeps its box. `agent.childRun.stopAll` reports each child's outcome on its own row, so one failure never hides the rest.

A handle that names no child of the run answers `agent.childRun.notFound`; any other refusal of the three is `agent.childRun.controlRefused`, with `reason` `childEnded` or `providerRefused`. Spec-003's V1 control set is the same three controls; these address them at a child.

`agent.queueItem.list` is the only `query` (idempotent read); the mutations are state-changing, per [API Payload Contracts §Procedure Types](./api-payload-contracts.md#procedure-types). The lead's interrupt is `agent.run.intervene {type: "interrupt"}`, and the person's steer is always a queue send, `agent.queueItem.create`: an edit of a waiting message is one `agent.queueItem.create` carrying `replacesQueueItemId`, and a new order is one `agent.queueItem.reorder`, never a client's cancel and resend. The two `subscription`s answer the shared subscribe acknowledgment and then send `StreamFrame` frames, never single events: each frame carries a batch of changes, each change with the cursor of the event it came from, or, for a subscriber too far behind the record ([Spec-006 §Required Behavior](../../specs/006-local-ipc-and-daemon-control.md#required-behavior)), one frame with no changes carrying the newest event cursor, after which the screen takes its snapshot read; a request carrying `afterCursor` first gets what the record holds past it, in the same frames. An `agent.run.subscribe` change carries `RunStateChangeEvent | AgentRunRolledBackEvent | RunSafetyBufferingUpdatedPayload` (the last is Codex's live safety-check hold, never appended, whose change carries the session's newest cursor; the state shape carries the `runVersion` comparand clients pass back as `expectedRunVersion`; the per-type non-state rollback arm — [Spec-005 §Run Lifecycle (runLifecycle)](../../specs/005-session-event-taxonomy-and-audit-log.md#run-lifecycle-runlifecycle) — rides the same stream so subscribers observe position rewinds without a fabricated transition). An `agent.queueItem.subscribe` change carries the item as it now stands, the `QueueItemSummary` projection, with the cursor of the `agent.queueItem.*` event that changed it; a reorder, which no event records, carries the session's newest cursor (a reorder has no event type of its own). All request/response shapes are the interfaces defined directly above; the Rust types live in `crates/sidekicks-contracts/src/run/control.rs` (CP-002-3), with the queue's in `run/queue.rs`, the intervention's in `run/intervention.rs` and a child's controls in `run/children.rs`, the generated TypeScript at the matching `.ts` paths under `packages/contracts/src/`, per the api-payload-contracts.md §Source-of-Truth Policy.
