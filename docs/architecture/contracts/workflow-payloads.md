# Workflow Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-014 — Workflow Authoring And Execution

A definition has ONE form on the wire and in the store: the node-graph document in [Workflow Document Payload Contracts](./workflow-document-payloads.md). An author writes nodes and edges; the engine runs them, its agent and human node kinds delegating at run time to the daemon's own run-admission, orchestration, approval and form paths, so no second definition form exists to keep in step with it ([Spec-015 §Core SDK and persistence contracts](../../specs/015-workflow-authoring-and-execution.md#core-sdk-and-persistence-contracts)). `WorkflowGateResolveResponse` carries the id of the answer's row in `workflow_gate_resolutions`, the row `workflow.gate_resolved` names. A member is required unless it is marked optional, and every optional member says when it is absent.

The visual builder ([Spec-015 §Visual Workflow Builder](../../specs/015-workflow-authoring-and-execution.md#visual-workflow-builder), ADR-024) is why `WorkflowToolBinding` exists. Neither Duplicate nor the submit half of a file import mints an operation of its own: both ride `workflow.definitionCreate`. Every workflow is in one library ([Workflow Graph Model §One workflow library (SA-33)](../../domain/workflow-graph-model.md#one-workflow-library-sa-33)): no request or reply carries a scope, and a name another workflow holds is refused with `workflow.definition_refused`, finding `name_taken`.

Order, fan-out and join are the document's own edges ([Workflow Graph Model §Graph model — nodes, ports, and edges (SA-29)](../../domain/workflow-graph-model.md#graph-model--nodes-ports-and-edges-sa-29)): a node runs when every one of its `main` inputs is settled, a fan-in waits in a per-node partial-input buffer until every slot is filled, and a document whose nodes declare no edges runs as the sequential chain its node order gives. Nothing outside the document declares that order.

```ts
// WorkflowDefinitionCreate — workflow.definitionCreate
interface WorkflowDefinitionCreateRequest {
  // A save from the Save panel, a Duplicate, and a file import all ride this one operation into the
  // one library, with no role check; the name is the document's own, and one another workflow holds
  // is refused. A document the daemon's re-check refuses answers `workflow.definition_refused`,
  // carrying every finding with the rule it breaks and the nodes it names.
  // The authored body is the NODE-GRAPH DOCUMENT in workflow-document-payloads.md: exactly one trigger node, the other
  // nodes, and the edges between them. There is no second, compiled form: the agent and
  // human kinds are node kinds like any other, and their executors call the existing
  // run-admission, orchestration, approval and form paths at run time.
  document: WorkflowDocument;
}

interface WorkflowDefinitionCreateResponse {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
  // So a caller can pin the version it just authored without a follow-up read.
  contentHash: string; // BLAKE3 over RFC 8785 JCS canonicalization
  // The opaque server-minted reference to the just-authored version — the exact value
  // workflow.runStart accepts as `workflowVersionId`, so an author can start what it
  // just created without a follow-up read.
  workflowVersionId: string;
  createdAt: string;
}

// WorkflowDefinitionRead — workflow.definitionRead
interface WorkflowDefinitionReadRequest {
  definitionId: WorkflowDefinitionId;
  version?: number; // omit for latest
}
interface WorkflowDefinitionReadResponse {
  id: WorkflowDefinitionId;
  name: string;
  versionNumber: number;
  // The opaque server-minted reference to the returned version — the exact value
  // workflow.runStart accepts as `workflowVersionId`.
  workflowVersionId: string;
  contentHash: string;
  document: WorkflowDocument;
  // The workflow's own level, which every run of it uses and the builder's level pill reads.
  permissionLevel: PermissionLevel;
  createdAt: string;
  // The webhook token's dates, present only where the document's trigger is a webhook and a token
  // exists. The token itself is never read back — only its hash is kept, and
  // workflow.webhookTokenRotate shows a new one once — so the trigger's Address section reads
  // `Created <date>` and `Last used <time>` from here. With no token, every call to the workflow's
  // address is refused; `webhookTokenLastUsedAt` is absent until a call has presented the token, and
  // never present without `webhookTokenCreatedAt`.
  webhookTokenCreatedAt?: string;
  webhookTokenLastUsedAt?: string;
  // The last call to the webhook address and what became of it: it started a run, the trigger's
  // overlap choice skipped it because a run was still going, it waits to run once the going run
  // finishes, or it was refused for a token that does not match the kept hash
  // (`workflow.webhook_token_mismatch`).
  webhookLastFire?: {
    at: string;
    outcome: "started" | "skipped" | "waiting" | "token_mismatch";
  };
  // When the workflow was deleted, absent while it is not. A deleted workflow still reads, as its
  // versions do through workflow.versionRead, so the run filter names it by its real name and the
  // Builder opens the Workflows tab with `That workflow is not here.`; `workflow.not_found` means
  // the definition was never created.
  deletedAt?: string;
}

// WorkflowDefinitionList — workflow.definitionList. The one enumeration of saved workflows: the
// Workflows tab, the `/workflow` name completion, the CLI `list` subcommand and an agent's
// `workflow_list` all read it, and every caller gets every workflow in the one library.
interface WorkflowDefinitionListRequest {
  limit?: number;
  cursor?: string;
}
interface WorkflowDefinitionListResponse {
  definitions: WorkflowDefinitionSummary[]; // one page; each definition is listed once across pages
  nextCursor?: string;
}
interface WorkflowDefinitionSummary {
  id: WorkflowDefinitionId;
  name: string;
  latestVersionNumber: number;
  // The opaque server-minted reference to that latest version — the exact value
  // workflow.runStart accepts as `workflowVersionId`; clients pass it through
  // verbatim and never synthesize it. `latestVersionNumber` stays alongside it
  // because workflow.versionRead addresses by (definitionId, versionNumber).
  latestWorkflowVersionId: string;
  // So the caller that just listed an entry can pin it.
  contentHash: string;
  // The facts a catalog row shows beside the name, so the table needs no second read per row.
  // The kind of the document's one trigger.
  triggerKind: WorkflowNodeKindId;
  // `lastRun` is absent where the definition has never run — a different fact from a run that failed.
  lastRun?: { workflowRunId: WorkflowRunId; status: WorkflowRunStatus; startedAt: string };
  // The armed schedule in words plus its next fire, absent where the definition declares no schedule.
  // The next fire is computed in the trigger's own timezone, which is a param on the schedule trigger,
  // and is absent while the workflow is off.
  schedule?: { expression: string; timeZone: string; nextFireAt?: string };
  // The last fire the trigger's overlap choice skipped because a run was still going, with that run's
  // start, so the row reads "3:00 AM skipped · the 2:00 AM run was still going". A skipped fire is never
  // a run.
  lastSkippedFire?: { scheduledAt: string; runningSince: string };
  // Whether every trigger this definition declares is armed. It is the toggle's own truth, so the row
  // reverts visibly when the daemon refuses rather than holding an optimistic value.
  enabled: boolean;
  // The tags the row writes on its second line, and the tag filter narrows on.
  tags: string[];
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

// WorkflowVersionRead — workflow.versionRead. Reads one immutable version body.
// Versions are content-hashed and never mutated; a definition edit mints a new one.
interface WorkflowVersionReadRequest {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
}
interface WorkflowVersionReadResponse {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
  // The opaque server-minted reference to THIS version — the exact value
  // workflow.runStart accepts as `workflowVersionId`; see the constructibility
  // note there.
  workflowVersionId: string;
  contentHash: string;
  // The canonical body itself, without which nothing could reproduce the canonical bytes
  // or their content hash; its schema-version marker is the document's own
  // `schemaVersion` ([Spec-015 §Required Behavior](../../specs/015-workflow-authoring-and-execution.md#required-behavior)). The file form has exactly two top-level parts, the hashed
  // definition body and the optional non-hashed `layout`
  // ([Workflow Graph Model §Definition file form — export and import (C-17)](../../domain/workflow-graph-model.md#definition-file-form--export-and-import-c-17)), so the name, the
  // trigger node and the node sequence all live INSIDE this document rather than beside
  // it. How a run begins is the document's own trigger node — exactly one, of a kind in the
  // trigger family, every one of which ships
  // ([Workflow Graph Model §Entry node and the V1 trigger surface (SA-34)](../../domain/workflow-graph-model.md#entry-node-and-the-v1-trigger-surface-sa-34)). There is no
  // second entry record beside it and no start mode the daemon materializes.
  document: WorkflowDocument;
  createdAt: string;
}

// WorkflowRunStart. Callers: CLI, desktop, the intercepted `/workflow run` verb, and the
// `workflow_run` callback tool — all one operation;
// no chat caller mints a start mode (Spec-015 SA-34/SA-35). An agent's start, and each run a
// trigger fires, is judged under the SA-36 named Cedar operation action `workflow::start` and
// refused with `workflow.start_denied`; the person's own start passes no policy check.
interface WorkflowRunStartRequest {
  // The opaque server-minted version reference — the immutable version row's
  // primary key, returned verbatim by workflow.versionRead,
  // workflow.definitionRead, workflow.definitionList, and
  // workflow.definitionCreate. Clients pass it through and never synthesize or
  // parse it: no delimiter or encoding over (definitionId, versionNumber) exists
  // on the wire.
  workflowVersionId: string;
  // The session the run lives in. A start made from a chat names that chat's session, which is the
  // only session its progress row and its results row ever reach; a session that does not exist is
  // refused `session.not_found`. A start from outside a chat — Run now from the Workflows screen or
  // the builder — omits it, and the run lives in the one session the workflow owns, created on its
  // first such run and reused by every later one. A run started in a session works in that session's
  // recorded folder, unless a chat's start names a project.
  sessionId?: SessionId;
  // The project whose repository the run works in, in that project's own folder: the one the Run now
  // panel's `Repository` names, or, on a start in a chat, the one the chat's `Repository` panel or the
  // agent's `workflow_run` names. Absent for `None`, and on a chat's start that names none, which works
  // in the chat's own folder; either has no checkout, no snapshot and no `Open in Review`. A project
  // session's run names none, because its session already names the folder, and the daemon refuses a
  // `projectId` sent beside a project session's `sessionId` with `workflow.project_on_project_session`.
  projectId?: ProjectId;
  // The items the run starts on. A workflow declares the inputs it asks for on its trigger, each one
  // named, typed and carrying the value it starts on; the start affordance seeds a field per input and
  // this member carries what was filled in. Absent where the workflow declares none.
  input?: WorkflowItem[];
  // How this start was made. It is an INPUT here and the recorded outcome on the run: a chat caller mints
  // no start mode of its own, and `retry` and `sub-workflow` are minted by the operations that produce
  // them rather than requested.
  mode?: Exclude<WorkflowRunMode, "retry" | "sub-workflow">;
}
interface WorkflowRunStartResponse {
  workflowRunId: WorkflowRunId;
  // The session the run lives in: the chat the request named, or the workflow's own.
  sessionId: SessionId;
  // Two of the run statuses are reachable from a start: the run is admitted and not yet dispatched, or
  // it is already running. Narrowing here keeps callers from switching on statuses a start cannot produce.
  state: "new" | "running";
}

// WorkflowRunRead — workflow.runRead. Run header plus the step array;
// the projection rebuilds from session_events (Spec-015 §State And Data Implications),
// so a read never consults request state.
interface WorkflowRunReadRequest {
  workflowRunId: WorkflowRunId;
}
interface WorkflowRunReadResponse {
  workflowRunId: WorkflowRunId;
  // The session the run lives in: the chat that started it, the one session the workflow owns for a run
  // nobody started from a chat, or, for a sub-workflow child, its parent's.
  sessionId: SessionId;
  // The workflow the run came from, which the header links to. A run whose definition was deleted still
  // opens, because it pins its version.
  definitionId: WorkflowDefinitionId;
  workflowVersionId: string;
  // The status list, and nothing else is displayed: a run is new, running, waiting on a person or a
  // provider, succeeded, failed, canceled or crashed. A gated run is `waiting`, which is the one status
  // never swept on a daemon start and never pruned, so a run parked on a person survives a restart. The
  // stored status CHECK is in lockstep with this union.
  state: WorkflowRunStatus;
  // The step array, one entry per execution of one node, each carrying its input, output and log
  // refs. It is the record a run page draws its graph and its step panel from: the graph is the
  // workflow's OWN canvas, read-only, every node in the place the builder put it and colored by
  // that node's step status, and the panel holds one step at a time. A waiting step says what it
  // waits on and when it resumes itself on its own record, so one workflow.runRead renders why the
  // run waits, per branch, with no rebuild from the transcript (Spec-015 §Park surfacing on the read model).
  // A `waiting` run always carries at least one `waiting` step: a run waits only while a step does.
  steps: WorkflowStep[];
  // How the run was started and by whom, which the run row and the run header both read. `startedBy`
  // carries the message anchor on a chat-borne start, which is how a run links back to the message that
  // started it. `triggerKind` is the kind of trigger node that started it, which the header's trigger
  // fact reads.
  mode: WorkflowRunMode;
  triggerKind: WorkflowTriggerKind;
  startedBy: WorkflowStartedBy;
  // The first run of this run's chain; its own id for a first run. A run started by an Execute workflow
  // step, by an error trigger, or by a session-event or file-watch trigger on something a run of a chain
  // did joins that chain, and the header names the chain's first run only when `chainRoot.runId` is not
  // this run's own id. `runCount` is how many runs the chain has started from that first run, the first
  // run included, which the chain's question and a held step's live line both read.
  chainRoot: {
    runId: WorkflowRunId;
    definitionId: WorkflowDefinitionId;
    workflowName: string;
    startedAt: string;
    runCount: number;
  };
  // Whether the daemon captured this run's execution context and pins its snapshot points at the start,
  // at each approval pause and at the end. True for a run that works in a project's repository, a
  // chat's run naming a project among them; false for a chat's run in the chat's own folder or a
  // `None` run, which has no Review. It decides whether `Open in Review` opens
  // what the run changed.
  executionContextCaptured: boolean;
  // Whether the person marked the run Keep, which `workflow.runsDelete` leaves untouched.
  keep: boolean;
  // The session a failed step's `Fix in a fresh session` opened, which the header links to for the life
  // of the run.
  fixSessionId?: SessionId;
  failureReason?: string; // preserved on any bound breach (SA-1, SA-2); also carries
  // the cancellation reason when `state` is `canceled`, mirroring the
  // `workflow_runs.failure_reason` / `failure_detail` split
  startedAt: string;
  // Present exactly once the run has ended. A `failed` run parked on its failed step has not ended and
  // carries none, which is how the header tells it from a failed run that ended: `Cancel` and `Resume`
  // act on the first and refuse on the second.
  endedAt?: string;
  // Summed from the steps' stored amounts and rounded once; absent where no provider was billed.
  cost?: WorkflowCost;
  // Present only on a `new`, `running` or `waiting` run: the live step's place in the run (1-based,
  // never past `total`) and its node's name, which the live line reads.
  liveStep?: { index: number; total: number; nodeName: string };
  // How many items went through each edge of the run's graph, summed over every pass; one entry per
  // edge items went through, which the graph's edge counts read.
  edgeItemCounts: Array<{ edgeId: string; itemCount: number }>;
  // Present only on a finished run whose execution context was captured. Pinned, it names the
  // execution whose start and end snapshots `Open in Review` compares; missing, it carries why the end
  // snapshot could not be taken, and the door stays in place saying so.
  review?: { state: "pinned"; epoch: number } | { state: "missing"; reason: string };
  // Present only on the chain's first run, once the chain's question has been asked: open, or answered
  // with the decision and the run count it was taken at, which its receipt reads (`Kept going at 100
  // runs`). It is an approval the engine raises on the first run and answers through
  // workflow.gateResolve naming no node: `approved` keeps the chain going, `rejected` stops every run of
  // it.
  chainQuestion?:
    | { state: "open" }
    | { state: "answered"; decision: ApprovalDecision; runCount: number; answeredAt: string };
}

// WorkflowRunCancel — workflow.runCancel. It is the named producer of the `canceled` run
// status and the reachable caller of Plan-014 T5.20's engine
// cancelability rule. This operation and the
// workflow.canceled event type mint TOGETHER — a cancellation that moved run status
// without appending its canonical event would break the SA-24 rebuild, because a
// rebuild would restore the last suspension payload's wait cause and schedule and
// resurrect a run the person canceled (I-014-21).
interface WorkflowRunCancelRequest {
  workflowRunId: WorkflowRunId;
  // The person's own cause, recorded on the run and carried in the
  // workflow.canceled payload. Non-empty and at most 8 KiB, counted as the UTF-8 bytes
  // of its JSON form rather than in characters, and never reaching a step output,
  // artifact, or agent-visible context.
  reason?: string;
}
interface WorkflowRunCancelResponse {
  workflowRunId: WorkflowRunId;
  // A literal rather than the run-status union: a successful cancel has exactly
  // one outcome, and narrowing here keeps callers from switching on states this
  // operation cannot produce.
  state: "canceled";
  // The `session_events.id` of the workflow.canceled event this call appended, in
  // the same unit of work as the status write (I-014-21). Returned so a caller can
  // correlate without a transcript read.
  canceledEventId: string;
  // True when the run was ALREADY `canceled` and this call returned the saved
  // result: no second status write, no second event, and `canceledEventId` names
  // the original. Deliberately NOT how a run that already ended otherwise answers — a
  // cancel against a run that has ended refuses `workflow.run_not_cancelable`, because
  // reporting success for a run that had already ended would misinform the person about
  // what their action did. A run parked on a failed step reads `failed` while it waits
  // and has not ended, so a cancel acts on it.
  alreadyCanceled: boolean;
}

// WorkflowRunResume — workflow.runResume. Resumes a parked
// run and carries the OPTIONAL explicit re-pin of
// Spec-015 §Frozen-definition repair (SA-38). The re-pin is a member of this request
// rather than a method of its own by design: SA-38 defines the repair only as an
// action ON a resume, so a separate method would admit the re-pin-without-resume
// shape that spec refuses.
interface WorkflowRunResumeRequest {
  workflowRunId: WorkflowRunId;
  // Omit for an ordinary resume, which continues on the frozen pinned version.
  // Supplying it requests the SA-38 repair EXPLICITLY — no timer, no armed schedule,
  // and no ordinary resume ever re-pins.
  versionRepin?: {
    // The version the caller intends to join. REQUIRED within this member: a repair
    // that resolved "latest" server-side would race the definition's own edits and
    // leave the audited from/to pair unverifiable against what the person saw.
    targetWorkflowVersionId: string;
  };
}
interface WorkflowRunResumeResponse {
  workflowRunId: WorkflowRunId;
  // `running` in the ordinary case. `waiting` where the engine immediately
  // re-parked — an SA-37 usage-limit park whose account is still spent re-parks on
  // the next dispatch. That is a legal outcome rather than a refusal, and the
  // re-park emits its own workflow.phase_suspended, which is how the person sees
  // what happened. Resuming ahead of an armed `resumeAt` is therefore permitted
  // and needs no override flag: the machine's own schedule was advisory pacing, and
  // the worst case is one observable re-park.
  state: "running" | "waiting";
  // Present only on an ACCEPTED re-pin, and then both: the version the run left and the
  // one it joined — the same pair the audited workflow.resumed payload carries, so the
  // projected run row stays a function of the log.
  repinnedFromWorkflowVersionId?: string;
  repinnedToWorkflowVersionId?: string;
}

// WorkflowStepOutputList — workflow.stepOutputList. A run's step outputs for a caller outside the run
// page — the CLI or an SDK — and only the agent and human steps' output summaries and artifact
// references: one step's full input, output or log comes only from workflow.stepRead. Outputs stay
// addressable after their step completes, and a retry adds entries rather than changing one.
interface WorkflowStepOutputListRequest {
  workflowRunId: WorkflowRunId;
}
interface WorkflowStepOutputListResponse {
  steps: Array<{
    // The finished step, keyed as workflow.stepRead keys it. `status` is the step's, not the run's.
    nodeId: WorkflowNodeId;
    executionIndex: number;
    status: "succeeded" | "failed";
    outputs: WorkflowStepOutput[];
  }>;
}
// One saved output. An `artifact_ref` output points at a Plan-011 manifest; Plan-014 stores the
// reference, never the bytes, and adds no second upload path. An `inline` output carries no artifact.
type WorkflowStepOutput =
  | { valueKind: "inline"; summary: string; producedAt: string }
  | { valueKind: "artifact_ref"; artifactId: ArtifactId; summary: string; producedAt: string };

// WorkflowGateResolve — workflow.gateResolve. Answers an approval: an approval step's Approve or Reject,
// from the approvals surface or from the step's own panel, through the one approval pipeline and its
// Cedar check; and the question the engine raises on a chain's first run once the chain has started as
// many runs as the person's setting allows, where `approved` is Keep going and `rejected` is Stop them
// all. The first answer settles the wait everywhere. An answer on a step no longer waiting, or after the
// step's `Timeout` instant even before its timer has run, is refused with `workflow.step_not_waiting`.
interface WorkflowGateResolveRequest {
  workflowRunId: WorkflowRunId;
  // The approval step being answered. Absent for a chain's question, which belongs to the run named
  // above — the chain's first run — rather than to a node.
  nodeId?: WorkflowNodeId;
  decision: ApprovalDecision;
  feedback?: string; // non-empty where present
}
interface WorkflowGateResolveResponse {
  // The answer's row in workflow_gate_resolutions, which the workflow.gate_resolved event names.
  gateResolutionId: string;
  // When the answer was recorded, which the step panel's past-tense receipt reads.
  decidedAt: string;
}

// WorkflowHumanFormDraftSave — workflow.humanFormDraftSave.
// Ships at V1: the form kind activates it. Each save writes the daemon-held draft
// in human_phase_form_state, keyed by run and node (Spec-015 §Human form drafts
// (SA-26)), as the person types, so a half-filled form survives a reload; a client
// never keeps a form draft in window storage. A save carrying a stale
// `expectedRevision` is refused with `workflow.revision_stale`.
//
// A step is addressed by its run, its node and which execution of that node, because a
// loop runs one node many times. workflow.humanFormRead and workflow.fixSessionCreate
// take this key as their whole request.
interface WorkflowStepKey {
  workflowRunId: WorkflowRunId;
  nodeId: WorkflowNodeId;
  executionIndex: number;
}
interface WorkflowHumanFormDraftSaveRequest extends WorkflowStepKey {
  formState: Record<string, unknown>;
  expectedRevision?: number; // a positive draft revision
}
interface WorkflowHumanFormDraftSaveResponse {
  revision: number;
  savedAt: string;
}

// WorkflowHumanFormSubmit — workflow.humanFormSubmit. Optimistic concurrency: a submit
// carrying a stale `expectedRevision` is refused with `workflow.revision_stale`, never
// silently overwritten, and a submit on a step no longer waiting is refused with
// `workflow.step_not_waiting`. The current revision is read from
// workflow.humanFormRead's `formRevision`: a fresh attempt reads 0,
// so a first submit carries expectedRevision: 0, and after an accepted submission
// any further submit against the same attempt is stale. An abandoned claim writes
// nothing, so the revision stays 0 and the next claimant's first submit succeeds
// (Spec-015 §Fallback Behavior re-claim). The draft save above carries its own draft
// counter (its store initializes at 1); that counter guards draft saves only and is
// never this submit token, which derives from the step's stored output alone (`workflow_steps`).
interface WorkflowHumanFormSubmitRequest extends WorkflowStepKey {
  // One value per field of the form's input schema, except a `path` field's. A form has
  // no artifact field: a value that names a file or folder is a `path` field, picked
  // through the platform's own chooser, and its answer rides `paths`.
  fields: Record<string, unknown>;
  // One answer per `path` field, at most once each; `field` is its dotted place in the
  // form (`target.0.folder`). Main's relay swaps the picker's token for the path here.
  paths?: { field: string; path: string }[];
  expectedRevision: number;
}
interface WorkflowHumanFormSubmitResponse {
  submittedAt: string; // when the answer was accepted
}

// ---- The durable workflow events ----
// The `workflow.*` types across the workflow families Spec-005 registers
// (§Workflow Lifecycle through §Workflow Gate Resolution). They ride the existing `EventEnvelope`
// and mint no second envelope schema: `causationId` carries the parent-event relationship, and the
// identity a type names — a run, one step, or an armed trigger — rides the payload, which is
// what the three bases below are. The engine is the only emitter; the registry
// census is Spec-005's and is never restated here.
interface WorkflowRunEventPayload {
  sessionId: SessionId;
  workflowRunId: WorkflowRunId;
  definitionId: WorkflowDefinitionId;
  workflowVersionId: string;
}
// workflow.started — how the run was started and by whom, so the run row rebuilds from events.
interface WorkflowStartedPayload extends WorkflowRunEventPayload {
  mode: WorkflowRunMode;
  startedBy: WorkflowStartedBy;
}
// workflow.results_posted — a finished run's results landed as the results row in `sessionId`, the
// session that asked. It follows the run's final status.
interface WorkflowResultsPostedPayload {
  sessionId: SessionId;
  workflowRunId: WorkflowRunId;
}
// workflow.created names a definition rather than a run — no run exists when a version is written —
// so it carries the definition and the version alone (Spec-005 §Workflow Lifecycle).
interface WorkflowCreatedPayload {
  sessionId: SessionId;
  definitionId: WorkflowDefinitionId;
  workflowVersionId: string;
}
// One execution of one node, its `StepRunId`: the run, the node, the attempt and the execution
// index, the members `WorkflowStep` keys a step by. The `workflow.phase_*` and
// `workflow.step_*` events both carry it, so an event and the step row it belongs to are
// addressable by one identity.
interface WorkflowStepEventPayload {
  sessionId: SessionId;
  workflowRunId: WorkflowRunId;
  nodeId: WorkflowNodeId;
  attempt: number;
  executionIndex: number;
}
// Arming and firing happen before any run exists, so these carry the workflow and the trigger node
// instead of a run. `scheduledInstant` is present on the two fired types and absent on the armed
// ones: with the workflow and the node it is the occurrence's dedup key, which is what keeps a
// restart or a double-arm from firing the same occurrence twice.
interface WorkflowTriggerEventPayload {
  sessionId: SessionId;
  definitionId: WorkflowDefinitionId;
  nodeId: WorkflowNodeId;
  scheduledInstant?: string; // RFC 3339 UTC
}

// workflow.resumed — the structured resumption point Spec-015 §Cadence requires, so a reader
// reconstructs where the run picked up without rebuilding from its whole history, plus the version pair on an
// accepted frozen-definition repair and only then: the same pair WorkflowRunResumeResponse carries, so
// the projected run row stays a function of the log (Spec-015 §Frozen-definition repair (SA-38)).
interface WorkflowResumedPayload extends WorkflowRunEventPayload {
  resumptionPoint: {
    activeSteps: Array<{ nodeId: WorkflowNodeId; attempt: number; executionIndex: number }>;
    pendingGates: WorkflowNodeId[];
  };
  repinnedFromWorkflowVersionId?: string;
  repinnedToWorkflowVersionId?: string;
}
// workflow.canceled — appended in the same unit of work as the status write, so a projection
// rebuild cannot apply the last suspension again and resurrect a canceled run. `reason` is the person's own,
// present when one was given and bounded as the cancel request's is; a chain's `Stop them all`
// cancels with none.
interface WorkflowCanceledPayload extends WorkflowRunEventPayload {
  reason?: string;
}
// workflow.phase_failed — non-null exactly where a sibling branch's failure ended the run and
// so canceled this phase, rather than the phase failing on its own work.
interface WorkflowPhaseFailedPayload extends WorkflowStepEventPayload {
  cancellationReason: "sibling_failure" | null;
}
// workflow.phase_suspended — a step started waiting: its `waitCause`, the durable resume instant where
// the wait armed one, and, for an `account` wait, the spent account the attention read groups it under.
// The deadline a `Timeout` arms is written on the step's row as truth and rides no event.
interface WorkflowPhaseSuspendedPayload extends WorkflowStepEventPayload {
  waitCause: WorkflowWaitCause;
  resumeAt?: string; // RFC 3339 UTC — only on an account wait; absent, only the person resumes it
  providerAccountId?: ProviderAccountId; // present exactly on an `account` wait
}
// workflow.phase_waiting_on_pool — diagnostic, for a step the engine's one memory gate holds before it
// starts (`waiting-memory`). Memory is the only real pool behind the gate: there is no step count and no
// terminal slot pool, so the payload names no pool. It is emitted on entry to the held state and every
// 30 seconds while held, so `waitingSinceSeq` — the envelope sequence the wait began at — is what
// correlates the repeats back to one wait (Spec-015 §Cadence).
interface WorkflowPhaseWaitingOnPoolPayload extends WorkflowStepEventPayload {
  waitingSinceSeq: number;
}
// The step boundaries. A started event names the input it ran on, a finished event the output
// and log it produced plus its cost where a provider was billed, a failed event the error and the
// item index that failed, a canceled event the step alone, and a skipped event why it was skipped.
// A step's started event precedes its finished, failed or canceled event.
interface WorkflowStepStartedPayload extends WorkflowStepEventPayload {
  inputRef: WorkflowPayloadRef;
}
interface WorkflowStepFinishedPayload extends WorkflowStepEventPayload {
  outputRef: WorkflowPayloadRef;
  logRef: WorkflowPayloadRef;
  cost?: WorkflowCost;
}
interface WorkflowStepFailedPayload extends WorkflowStepEventPayload {
  error: WorkflowStepError;
  failedItemIndex?: number;
}
type WorkflowStepCanceledPayload = WorkflowStepEventPayload;
interface WorkflowStepSkippedPayload extends WorkflowStepEventPayload {
  reason: "no-items" | "disabled";
}
// workflow.gate_resolved — the answer an approval took, in the same vocabulary
// WorkflowGateResolveRequest uses, on the step it answered or, for a chain's question, on the
// chain's first run. The gate's answer is a session event, and the answering device is recorded
// by its id; the event names the answer's row in workflow_gate_resolutions by that row's id.
interface WorkflowGateResolvedPayload extends WorkflowRunEventPayload {
  nodeId?: WorkflowNodeId; // the human.approval node answered; absent for a chain's question
  outcome: ApprovalDecision;
  deviceId: DeviceId; // the answering device's id
  gateResolutionId: string; // the answer's row id in workflow_gate_resolutions
}
```

**Method-string registry — Plan-014** (daemon JSON-RPC; the `workflow` root, root plus camelCase tail per the Plan-013 convention in orchestration-payloads.md). Each row below has its shape above, in workflow-document-payloads.md or in workflow-builder-and-runs-payloads.md. Which of them the daemon serves is in [§Operations Not Yet Built](./api-payload-contracts.md#operations-not-yet-built).

| Method | Procedure type | Request → Response | Notes |
| --- | --- | --- | --- |
| `workflow.definitionCreate` | `mutation` | `WorkflowDefinitionCreateRequest` → `WorkflowDefinitionCreateResponse` | Content-hashes and persists version 1; the daemon re-checks the whole document and refuses `workflow.definition_refused` with every finding |
| `workflow.definitionRead` | `query` | `WorkflowDefinitionReadRequest` → `WorkflowDefinitionReadResponse` | Latest version unless `version` is supplied; carries a webhook workflow's token dates and last fire, never the token; a deleted workflow still reads, with `deletedAt` set |
| `workflow.definitionList` | `query` | `WorkflowDefinitionListRequest` → `WorkflowDefinitionListResponse` | Every workflow in the one library with the facts its catalog row shows, paged |
| `workflow.versionRead` | `query` | `WorkflowVersionReadRequest` → `WorkflowVersionReadResponse` | Immutable version body; a running instance stays pinned to its own |
| `workflow.runStart` | `mutation` | `WorkflowRunStartRequest` → `WorkflowRunStartResponse` | Binds a run to a pinned version, in the asking chat's session or the workflow's own, working in the repository `projectId` names, else in the asking session's recorded folder, else, with neither, in the run's own folder; refuses `workflow.project_on_project_session` for a `projectId` beside a project session's `sessionId`; emits `workflow.started`; judges an agent's start and a trigger's fire under `workflow::start` and refuses `workflow.start_denied` (ADR-025); refuses `workflow.repository_required` for a start that names no project's repository — a `None` run, or a chat's start naming none — of a version holding a Git, Read a repo diff or Run tests step |
| `workflow.runRead` | `query` | `WorkflowRunReadRequest` → `WorkflowRunReadResponse` | Projection read; rebuildable from `session_events`. Carries the step array with each waiting step's cause, instants and question and each answered step's resolution, the chain's first run with its run count, whether the run's execution context was captured, the Keep mark, the fix session, the run's cost, a going run's live step, the per-edge item counts, a finished run's review epoch and the chain's question on its first run, so a waiting run renders from this one call (Spec-015 §Park surfacing on the read model) |
| `workflow.runCancel` | `mutation` | `WorkflowRunCancelRequest` → `WorkflowRunCancelResponse` | The named producer of the `canceled` run status; emits `workflow.canceled` in the same unit of work as the status write (I-014-21); refuses `workflow.run_not_cancelable` against a run that has ended; a `failed` run parked on its failed step has not ended and is canceled (a cancel on an already-`canceled` run returns the saved result) |
| `workflow.runResume` | `mutation` | `WorkflowRunResumeRequest` → `WorkflowRunResumeResponse` | The person's resumption of a parked run, carrying the optional explicit SA-38 re-pin as a request member rather than a method of its own; emits `workflow.resumed` (with the re-pin member on an accepted repair); refuses `workflow.resume_not_parked`, or one of the `workflow.repair_*` codes on the re-pin leg |
| `workflow.stepOutputList` | `query` | `WorkflowStepOutputListRequest` → `WorkflowStepOutputListResponse` | The agent and human steps' output summaries and artifact references, for the CLI and an SDK; one step's full input, output or log comes only from `workflow.stepRead`; a retry adds entries, never changes one (SA-16) |
| `workflow.gateResolve` | `mutation` | `WorkflowGateResolveRequest` → `WorkflowGateResolveResponse` | Answers an approval step, or a chain's question (`approved` keeps going, `rejected` stops them all); appends one `workflow_gate_resolutions` row; emits `workflow.gate_resolved`; refuses `workflow.step_not_waiting` on a step no longer waiting |
| `workflow.humanFormDraftSave` | `mutation` | `WorkflowHumanFormDraftSaveRequest` → `WorkflowHumanFormDraftSaveResponse` | Writes the daemon-held draft of a form step as it is typed; each save bumps the draft's own revision, and a stale one refuses `workflow.revision_stale` (SA-26) |
| `workflow.humanFormSubmit` | `mutation` | `WorkflowHumanFormSubmitRequest` → `WorkflowHumanFormSubmitResponse` | Optimistic-concurrency submit that resumes the run; refuses `workflow.revision_stale` or `workflow.step_not_waiting` |
| `workflow.definitionUpdate` | `mutation` | `WorkflowDefinitionUpdateRequest` → `WorkflowDefinitionUpdateResponse` | A new immutable version of an existing definition, optimistic on the expected version (`workflow.version_stale` when it is stale) |
| `workflow.definitionDelete` | `mutation` | `WorkflowDefinitionDeleteRequest` → `WorkflowDefinitionDeleteResponse` | Soft delete; the runs that pinned its versions stay readable, and the response states how many |
| `workflow.definitionExport` | `mutation` | `WorkflowDefinitionExportRequest` → `WorkflowDefinitionExportResponse` | Writes the canonical file form of one version, layout section and package locks included, to the file the platform's save dialog picked |
| `workflow.definitionImport` | `mutation` | `WorkflowDefinitionImportRequest` → `WorkflowDefinitionCreateResponse` | Reads the file the platform's open dialog picked and submits it through the create path, all or nothing; refuses `workflow.import_schema_unknown` for an unknown schema version |
| `workflow.enabledSet` | `mutation` | `WorkflowEnabledSetRequest` → `WorkflowEnabledSetResponse` | Arms or disarms every trigger of one workflow; refuses `workflow.trigger_unarmable` where a trigger cannot arm |
| `workflow.runList` | `query` | `WorkflowRunListRequest` → `WorkflowRunListResponse` | The runs enumeration, with the filters the table narrows on, the version scope Show runs hands in, the total and paging |
| `workflow.versionChainRead` | `query` | `WorkflowVersionChainReadRequest` → `WorkflowVersionChainReadResponse` | The chain one run's pinned version belongs to, addressed by that version id |
| `workflow.stepRead` | `query` | `WorkflowStepReadRequest` → `WorkflowStepReadResponse` | One step's input, output or log by ref, paged and redacted |
| `workflow.stepTabArtifactCreate` | `mutation` | `WorkflowStepTabArtifactCreateRequest` → `WorkflowStepTabArtifactCreateResponse` | Stores what one step-panel tab holds — an inline payload, the step's cost or its error — as an artifact through `ArtifactPublish`, answering its id |
| `workflow.runRetry` | `mutation` | `WorkflowRunRetryRequest` → `WorkflowRunRetryResponse` | Re-runs from a named step with the prior run's data pinned upstream; mints a new run in `retry` mode; refuses `workflow.retry_unavailable` or `workflow.invalid_transition` |
| `workflow.runRerun` | `mutation` | `WorkflowRunRerunRequest` → `WorkflowRunStartResponse` | Starts a new run of the named run's own pinned version with the input and mode it was started with, in its session; emits `workflow.started`; the person's own start, judged by no policy |
| `workflow.nodeExecute` | `mutation` | `WorkflowNodeExecuteRequest` → `WorkflowNodeExecuteResponse` | Executes one node, or it and its ancestors, against pinned or prior input, in the trigger's `Repository`, or, on a `chat` or `sub-workflow` trigger, the one `projectId` names; the daemon computes the filtered run |
| `workflow.resultsPost` | `mutation` | `WorkflowResultsPostRequest` → `WorkflowResultsPostResponse` | Posts a run's results into the session the verb was typed in, which the daemon checks is the caller's own; the agent's tool takes no session, the daemon deriving it from the invoking turn; refuses `workflow.invalid_transition` for an unfinished run |
| `workflow.subscribe` | `subscription` | `WorkflowSubscribeRequest` → `WorkflowSubscribeNotification` (stream) | The scheduler hold and its count first, then run, step, schedule and definition notifications and removals, for the runs table, the Workflows tab and the canvas overlay |
| `workflow.kindList` | `query` | `WorkflowKindListRequest` → `WorkflowKindListResponse` | The node catalog with its param specs, so the palette, the inspector and an agent read one list |
| `workflow.runsPauseSet` | `mutation` | `WorkflowRunsPauseSetRequest` → `WorkflowRunsPauseState` | The scheduler-wide hold on starting new runs; takes no run id and answers with how many starts are waiting |
| `workflow.layoutSet` | `mutation` | `WorkflowLayoutSetRequest` → `WorkflowDefinitionSettingResponse` | The canvas layout, saved beside the definition without a new version |
| `workflow.tagsSet` | `mutation` | `WorkflowTagsSetRequest` → `WorkflowDefinitionSettingResponse` | The workflow's tags, saved beside the definition without a new version |
| `workflow.permissionLevelUpdate` | `mutation` | `WorkflowPermissionLevelUpdateRequest` → `WorkflowPermissionLevelUpdateResponse` | The workflow's own permission level, saved beside the definition without a new version |
| `workflow.pinDataSet` | `mutation` | `WorkflowPinDataSetRequest` → `WorkflowPinDataSetResponse` | Pins or unpins a node's test data without a new version; honored only in manual runs |
| `workflow.draftUpdate` | `mutation` | `WorkflowDraftUpdateRequest` → `WorkflowDraftUpdateResponse` | The builder's unsaved draft, held by the daemon so it survives a reload, one per saved workflow and one for a new workflow |
| `workflow.draftRead` | `query` | `WorkflowDraftReadRequest` → `WorkflowDraftReadResponse` | The draft read back after a reload, by the id the builder's address carries |
| `workflow.expressionPreview` | `query` | `WorkflowExpressionPreviewRequest` → `WorkflowExpressionPreviewResponse` | An expression's value against the last run, evaluated in the daemon; never resolves a secret |
| `workflow.versionDiffRead` | `query` | `WorkflowVersionDiffReadRequest` → `WorkflowVersionDiffReadResponse` | The structural difference between two versions, over the hashed body only |
| `workflow.runDelete` | `mutation` | `WorkflowRunDeleteRequest` → `WorkflowRunDeleteResponse` | Deletes one run with its step data and snapshots; refuses `workflow.run_not_deletable` on a `new`, `running` or `waiting` run |
| `workflow.runsDeletePreview` | `query` | `WorkflowRunsDeleteRequest` → `WorkflowRunsDeletePreviewResponse` | What "Delete runs older than…" would remove, counted before it runs |
| `workflow.runsDelete` | `mutation` | `WorkflowRunsDeleteRequest` → `WorkflowRunsDeleteResponse` | Deletes the runs older than an instant; runs marked Keep and runs in `waiting` are untouched |
| `workflow.runKeepSet` | `mutation` | `WorkflowRunKeepSet` → `WorkflowRunKeepSet` | Marks a run Keep, which deleting old runs leaves, or clears the mark |
| `workflow.fixSessionCreate` | `mutation` | `WorkflowStepKey` → `WorkflowFixSessionCreateResponse` | Opens a fresh session to fix a failed step, which the run links to; refuses `workflow.invalid_transition` on a step that did not fail |
| `workflow.humanFormRead` | `query` | `WorkflowStepKey` → `WorkflowHumanFormReadResponse` | A waiting form: prompt, fields, the saved draft and the submit revision; refuses `workflow.step_not_waiting` |
| `workflow.runAttentionList` | `query` | `WorkflowRunAttentionListRequest` → `WorkflowRunAttentionListResponse` | The runs waiting on a person, oldest first, under one `account` entry per spent provider account keyed by its `providerAccountId`; no filter narrows it |
| `workflow.webhookTokenRotate` | `mutation` | `WorkflowWebhookTokenRotateRequest` → `WorkflowWebhookTokenRotateResponse` | Creates or rotates a workflow's webhook token, returned once; only its hash is kept, so the old token is refused from that moment |
| `workflow.webhookListenerRead` | `query` | `WorkflowWebhookListenerReadRequest` → `WorkflowWebhookListenerReadResponse` | The webhook listener's port and whether it listens |
| `workflow.secretList` | `query` | `EmptyPayload` → `WorkflowSecretListResponse` | Every secret, the shared ones and each project's, by name, for a step's Credential chooser; never a value |
| `workflow.secretCreate` | `mutation` | `WorkflowSecretCreateRequest` → `WorkflowSecretSummary` | Seals a new secret's value in the keychain under a scope and name; refuses `workflow.secret_name_invalid` or `workflow.secret_store_unavailable` |
| `workflow.secretReplace` | `mutation` | `WorkflowSecretReplaceRequest` → `WorkflowSecretActResponse` | Replaces a secret's value in the keychain; refuses `workflow.secret_store_unavailable` |
| `workflow.secretDelete` | `mutation` | `WorkflowSecretDeleteRequest` → `WorkflowSecretActResponse` | Deletes a secret's record and its keychain entry |
| `workflow.keptVarsClear` | `mutation` | `WorkflowKeptVarsClearRequest` → `WorkflowKeptVarsClearResponse` | Clears the values `Keep for later runs` kept for one workflow |

The canonical file form of a definition ([Workflow Graph Model §Definition file form — export and import (C-17)](../../domain/workflow-graph-model.md#definition-file-form--export-and-import-c-17)) is a serialization of these same shapes — the file the authoring commitment names, carrying the schema-version marker, whose canonical bytes are the JCS-canonicalized JSON of the parsed document. It is not a second dialect and has no contract types of its own. `layout` is an optional top-level section of that document, outside the hashed body, and it is persisted in a column beside the definition body and carried by the file, so moving a node mints no version ([Workflow Graph Model §Canvas layout is not definition bytes (SA-32)](../../domain/workflow-graph-model.md#canvas-layout-is-not-definition-bytes-sa-32)). Export and import are the operations in workflow-builder-and-runs-payloads.md rather than client-side work over the create and version reads: the canonical bytes and their content hash belong to the store, a round trip in either direction must reproduce them exactly, and an import must run the create path's whole validation so it can carry no governance state. Both act on the file the person picked with the platform's own dialog: the renderer hands the daemon the dialog's `FilePathRef` token, main's relay turns it into the path, and the daemon alone reads or writes the file, so no path string and no file text crosses the bridge ([Preload Bridge Contract](preload-bridge-contract.md)). `workflow.definitionImport` submits through `workflow.definitionCreate`'s own path for that reason and adds no second parse.

Starting a workflow from chat likewise adds **no** method: the chat surfaces are client-surface sugar over `workflow.runStart` (ADR-025), and `workflow_run` below is a callback tool, not a JSON-RPC method.

The session's workflow callback tools (ADR-025; [Spec-015 §Interfaces And Contracts](../../specs/015-workflow-authoring-and-execution.md#interfaces-and-contracts); Plan-014 T5.8 / CP-014-7) are each a `SessionCallbackTool` of the provider-driver-capability-payloads.md shape: a JSON-Schema input, a Cedar action, an approval category, and a `tool_activity` record on every invocation. They register into the Plan-003 callback-tool host registry at session spawn and every invocation routes through the CP-003-5 Cedar seam. Born-withheld: while the daemon's approval service is not running the whole registry is withheld at spawn and a stray invocation answers `denied` — never `completed` without Cedar. An agent's own tool allowlist decides which of them that agent holds.

| Tool | Adjudicated as |
| --- | --- |
| `workflow_kinds`, `workflow_list`, `workflow_read`, `workflow_runs`, `workflow_run_read`, `workflow_step_read`, `workflow_validate` | reads, gated on the session itself |
| `workflow_create`, `workflow_update`, `workflow_schedule_set`, `workflow_enable` (which takes the enabled flag, so it serves both the enable and the disable verb) | `Action::"workflow::author"` |
| `workflow_run`, `workflow_node_execute` | `Action::"workflow::start"` |
| `workflow_cancel` | `Action::"workflow::cancel"` |
| `workflow_resume` | `Action::"workflow::resume"` |
| `workflow_results_post` | `Action::"workflow::author"`, with the session derived from the invoking turn and never tool-supplied |

No tool in the set takes the session it acts on as an argument, per [Spec-010 §Interfaces And Contracts](../../specs/010-approvals-permissions-and-trust-boundaries.md#interfaces-and-contracts): the daemon derives it from the invoking turn's own context, validates the derived value, and refuses a smuggled one, so a forged target cannot be reached. `workflow_run` and `workflow_node_execute` take a definition by name, which names one workflow in the one library, issuing the same start path as `workflow.runStart` in the invoking turn's session and its recorded folder; in a chat, `workflow_run` also takes an optional `project`, a project's name as `session_options` lists it, and the run then works in that project's own folder; a Cedar denial answers `denied` carrying `workflow.start_denied`. None of these tools is a JSON-RPC method: the chat-start surface adds no registry row of its own.

Error vocabulary: [error-contracts.md](./error-contracts.md) §Workflow. Every refusal point on this surface carries a code of its own in the registry's `<root>.<noun>_<condition>` form, registered in its contract before the capability is implemented, and none ships unregistered ([Spec-015 §Loud-errors discipline (C-12)](../../specs/015-workflow-authoring-and-execution.md#loud-errors-discipline-c-12) forbids untyped refusals). A state refusal is 409, well-formed input the daemon cannot act on is 422, and findings ride the error as an extension list. The calls above refuse with: `workflow.not_found`; `workflow.start_denied` for a denied or unresolvable start; `workflow.repository_required` (422, `nodeIds`) for a start or a node run (`workflow.nodeExecute`) that names no project's repository, of a version holding a Git, Read a repo diff or Run tests step; `workflow.project_on_project_session` (422) for a start in a project session that names a project; `workflow.run_not_cancelable` and `workflow.resume_not_parked` for cancel and resume; the [Spec-015 §Frozen-definition repair (SA-38)](../../specs/015-workflow-authoring-and-execution.md#frozen-definition-repair-sa-38) re-pin refusals `workflow.repair_not_parked`, `workflow.repair_attempt_in_flight` and `workflow.repair_version_unaccountable`; `workflow.definition_refused` (422), carrying `findings: [{rule, nodeIds, detail?}]` — the whole list the daemon's re-check finds, each `rule` from `WORKFLOW_DEFINITION_FINDING_RULES` in `packages/contracts/src/workflow/definition/document.ts`; `workflow.revision_stale` (409) for a stale form revision; `workflow.version_stale` (409) for a stale definition version; `workflow.step_not_waiting` (409) for a form submitted or read, or an approval answered, on a step no longer waiting; `workflow.retry_unavailable` (409, `reason: source_running`); `workflow.run_not_deletable` (409) on a `new`, `running` or `waiting` run; `workflow.invalid_transition` (409) for a run or step move its state does not allow, such as retrying a step that did not fail or posting results from an unfinished run; `workflow.trigger_unarmable` for a trigger that cannot arm; `workflow.import_schema_unknown` for an import whose schema version is unknown; and, on the secret verbs, `workflow.secret_name_invalid` (`reason: pattern | taken`) and `workflow.secret_store_unavailable` (`cause: locked | unavailable`). The webhook listener refuses a call whose token does not match with `workflow.webhook_token_mismatch`. A step that fails carries its code on its `error` and on the `workflow.step_failed` event, for the life of the run record: `workflow.code_over_budget`, `workflow.code_install_failed` (`reason: disk_space | tool_error`), `workflow.step_thread_failed` (`reason: out_of_memory | start_timeout | exited`), `workflow.sandbox_unavailable` (`provider: claude | codex`), `workflow.step_timed_out` (`cause: step_timeout | run_cap`), `workflow.secret_not_found` (carrying only the reference) and `workflow.secret_store_unavailable`. The park, pacing and cancelability rules mint no code of their own. Durable events owned by Plan-014: the `workflow.*` types across the workflow families enumerated in [Spec-015 §Event types (SA-19)](../../specs/015-workflow-authoring-and-execution.md#event-types-sa-19) and registered in the [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md) census, whose categories that spec carries as its own sections; their typed payloads are the `Workflow*Payload` shapes above.
