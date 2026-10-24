# Workflow Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-014 — Workflow Authoring And Execution

A definition has ONE form on the wire and in the store: the node-graph document in [Workflow Document Payload Contracts](./workflow-document-payloads.md). An author writes nodes and edges; the engine runs them, its agent and human node kinds delegating at run time to the daemon's own run-admission, orchestration, approval and form paths, so no second definition form exists to keep in step with it ([Spec-015 §Core SDK and persistence contracts](../../specs/015-workflow-authoring-and-execution.md#core-sdk-and-persistence-contracts)). `WorkflowGateResolveResponse` carries the id of the answer's row in `workflow_gate_resolutions`, the row `workflow.gate.resolved` names. A member is required unless it is marked optional, and every optional member says when it is absent.

The visual builder ([Spec-015 §Visual Workflow Builder](../../specs/015-workflow-authoring-and-execution.md#visual-workflow-builder), ADR-024) is why `WorkflowToolBinding` exists. Neither Duplicate nor the submit half of a file import mints an operation of its own: both ride `workflow.definition.create`. Every workflow is in one library ([Workflow Graph Model §One workflow library (SA-33)](../../domain/workflow-graph-model.md#one-workflow-library-sa-33)): no request or reply carries a scope, and a name another workflow holds is refused with `workflow.definition.refused`, finding `nameTaken`.

Order, fan-out and join are the document's own edges ([Workflow Graph Model §Graph model — nodes, ports, and edges (SA-29)](../../domain/workflow-graph-model.md#graph-model--nodes-ports-and-edges-sa-29)): a node runs when every one of its `main` inputs is settled, a fan-in waits in a per-node partial-input buffer until every slot is filled, and a document whose nodes declare no edges runs as the sequential chain its node order gives. Nothing outside the document declares that order.

```ts
// WorkflowDefinitionCreate — workflow.definition.create
// Where a create comes from, tagged on `kind`.
type WorkflowCreateOrigin =
  // A Save of the editor's new workflow; the create clears the new-workflow draft in its write.
  | { kind: "newWorkflowDraft" }
  // A file import; it clears no draft.
  | { kind: "fileImport" }
  // A Duplicate names the version it copies and clears no draft; the daemon names the copy the
  // first free `<name> copy`, `<name> copy 2` and on after the document's name, and its first
  // version keeps that version's package locks while the document holds that version's content.
  // A version not in the library is refused `workflow.version.notFound`.
  | { kind: "duplicate"; copiedVersionId: WorkflowVersionId };

interface WorkflowDefinitionCreateRequest {
  // A save from the Save panel, a Duplicate, and a file import all ride this one operation into the
  // one library, with no role check, told apart by `origin`; the name is the document's own, except
  // a Duplicate's, which the daemon names, and one another workflow holds is refused. A document
  // the daemon's re-check refuses answers `workflow.definition.refused`, carrying every finding
  // with the rule it breaks and the nodes it names.
  // The authored body is the NODE-GRAPH DOCUMENT in workflow-document-payloads.md: exactly one trigger node, the other
  // nodes, and the edges between them. There is no second, compiled form: the agent and
  // human kinds are node kinds like any other, and their executors call the existing
  // run-admission, orchestration, approval and form paths at run time.
  document: WorkflowDocument;
  origin: WorkflowCreateOrigin;
}

interface WorkflowDefinitionCreateResponse {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
  // So a caller can pin the version it just authored without a follow-up read.
  contentHash: string; // BLAKE3 over RFC 8785 JCS canonicalization
  // The opaque server-minted reference to the just-authored version — the exact value
  // workflow.run.start accepts as `workflowVersionId`, so an author can start what it
  // just created without a follow-up read.
  workflowVersionId: string;
  createdAt: string;
}

// WorkflowDefinitionRead — workflow.definition.read
interface WorkflowDefinitionReadRequest {
  definitionId: WorkflowDefinitionId;
  version?: number; // omit for latest
}
interface WorkflowDefinitionReadResponse {
  id: WorkflowDefinitionId;
  name: string;
  versionNumber: number;
  // The opaque server-minted reference to the returned version — the exact value
  // workflow.run.start accepts as `workflowVersionId`.
  workflowVersionId: string;
  contentHash: string;
  document: WorkflowDocument;
  // The workflow's own level, which every run of it uses and the builder's level pill reads.
  permissionLevel: PermissionLevel;
  // The browser the workflow's runs use in the background, which the builder's browser pill reads;
  // a new workflow reads `settingsDefault`.
  backgroundBrowser: "settingsDefault" | "sandboxed" | "notSandboxed";
  createdAt: string;
  // The webhook token's dates, present only where the document's trigger is a webhook and a token
  // exists. The token itself is never read back — only its hash is kept, and
  // workflow.webhookToken.rotate shows a new one once — so the trigger's Address section reads
  // `Created <date>` and `Last used <time>` from here. With no token, every call to the workflow's
  // address is refused; `webhookTokenLastUsedAt` is absent until a call has presented the token, and
  // never present without `webhookTokenCreatedAt`.
  webhookTokenCreatedAt?: string;
  webhookTokenLastUsedAt?: string;
  // The last call to the webhook address and what became of it: it started a run, the trigger's
  // overlap choice skipped it because a run was still going, it waits to run once the going run
  // finishes, or it was refused for a token that does not match the kept hash
  // (`workflow.webhookToken.mismatch`).
  webhookLastFire?: {
    at: string;
    outcome: "started" | "skipped" | "waiting" | "tokenMismatch";
  };
  // When the workflow was deleted, absent while it is not. A deleted workflow still reads, as its
  // versions do through workflow.version.read, so the run filter names it by its real name and the
  // Builder opens the Workflows tab with `That workflow is not here.`; `workflow.definition.notFound`
  // means the definition was never created.
  deletedAt?: string;
}

// WorkflowDefinitionList — workflow.definition.list. The one enumeration of saved workflows: the
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
  // workflow.run.start accepts as `workflowVersionId`; clients pass it through
  // verbatim and never synthesize it. `latestVersionNumber` stays alongside it
  // because workflow.version.read addresses by (definitionId, versionNumber).
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

// WorkflowVersionRead — workflow.version.read. Reads one immutable version body.
// Versions are content-hashed and never mutated; a definition edit mints a new one.
interface WorkflowVersionReadRequest {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
}
interface WorkflowVersionReadResponse {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
  // The opaque server-minted reference to THIS version — the exact value
  // workflow.run.start accepts as `workflowVersionId`; see the constructibility
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
// refused with `workflow.run.startDenied`; the person's own start passes no policy check.
interface WorkflowRunStartRequest {
  clientIdempotencyKey: string; // a UUID: a resend under the same key after a reconnect answers the first start's run, never a second (return-or-conflict on the call's own record)
  // The opaque server-minted version reference — the immutable version row's
  // primary key, returned verbatim by workflow.version.read,
  // workflow.definition.read, workflow.definition.list, and
  // workflow.definition.create. Clients pass it through and never synthesize or
  // parse it: no delimiter or encoding over (definitionId, versionNumber) exists
  // on the wire.
  workflowVersionId: string;
  // The session the run lives in. A start made from a chat names that chat's session, which is the
  // only session its progress row and its results row ever reach; a session that does not exist is
  // refused `session.notFound`. A start from outside a chat — Run now from the Workflows screen or
  // the builder — omits it, and the run lives in the one session the workflow owns, created on its
  // first such run and reused by every later one. A run started in a session works in that session's
  // recorded folder, unless a chat's start names a project.
  sessionId?: SessionId;
  // The project whose repository the run works in, in that project's own folder: the one the Run
  // now panel's `Repository` names, or, on a start in a chat, the one the chat's `Repository` panel
  // or the agent's `workflow_run` names. Absent for `None`, and on a chat's start that names none,
  // which works in the chat's own folder; either has no checkout, no snapshot and no `Open in
  // Review`. A project session's run names none, because its session already names the folder, and
  // the daemon refuses a `projectId` sent beside a project session's `sessionId` with
  // `workflow.run.projectOnProjectSession`.
  projectId?: ProjectId;
  // The items the run starts on. A workflow declares the inputs it asks for on its trigger, each one
  // named, typed and carrying the value it starts on; the start affordance seeds a field per input and
  // this member carries what was filled in, as one item whose `json` holds the values by input name.
  // An optional input left out takes its starting value; a required one left unfilled, or any value
  // that does not fit its input, is refused `workflow.run.inputRequired`. Absent where the workflow
  // declares none.
  input?: WorkflowItem[];
  // How this start was made. It is an INPUT here and the recorded outcome on the run: a chat caller
  // mints no start mode of its own, and `retry` and `subWorkflow` are minted by the operations that
  // produce them rather than requested.
  mode?: Exclude<WorkflowRunMode, "retry" | "subWorkflow">;
}
interface WorkflowRunStartResponse {
  workflowRunId: WorkflowRunId;
  // The session the run lives in: the chat the request named, or the workflow's own.
  sessionId: SessionId;
  // Two of the run statuses are reachable from a start: the run is admitted and not yet dispatched, or
  // it is already running. Narrowing here keeps callers from switching on statuses a start cannot produce.
  status: "new" | "running";
}

// WorkflowRunRead — workflow.run.read. Run header plus the step array;
// the projection rebuilds from session_events (Spec-015 §State And Data Implications),
// so a read never consults request state.
interface WorkflowRunReadRequest {
  workflowRunId: WorkflowRunId;
}
// One workflow run as its row records it; the run read and the runs table's row are built from it.
// `status` is the status list, and nothing else is displayed: a run is new, running, waiting on a person
// or a provider, succeeded, failed, canceled or crashed. A gated run is `waiting`, which is the one
// status never swept on a daemon start and never pruned, so a run parked on a person survives a
// restart. The stored status CHECK is in lockstep with this union. `finishedAt` is present exactly once
// the run has ended. A `failed` run parked on its failed step has not ended and carries none, which is
// how the header tells it from a failed run that ended: `Cancel` and `Resume` act on the first and
// refuse on the second.
type WorkflowRun = {
  workflowRunId: WorkflowRunId;
  // The session the run lives in: the chat that started it, the one session the workflow owns for a run
  // nobody started from a chat, or, for a sub-workflow child, its parent's.
  sessionId: SessionId;
  // The workflow the run came from, which the header links to. A run whose definition was deleted still
  // opens, because it pins its version.
  definitionId: WorkflowDefinitionId;
  workflowVersionId: string;
  // How the run was started and by whom, which the run row and the run header both read. `startedBy`
  // carries the message anchor on a chat-borne start, which is how a run links back to the message that
  // started it. `triggerKind` is the kind of trigger node that started it, which the header's trigger
  // fact reads.
  mode: WorkflowRunMode;
  triggerKind: WorkflowTriggerKind;
  startedBy: WorkflowStartedBy;
  // Whether the person marked the run Keep, which `workflow.run.purge` leaves untouched.
  keep: boolean;
  startedAt: string;
} &
  // `error` says why a run that failed, was canceled or crashed did so: kept when the run cap
  // (`max_duration`, SA-2) or the retry bound (`max_retries`) fails the run, and carrying a person's
  // cancellation reason as its message, stored as `workflow_runs.error_json`. A going or succeeded
  // run carries none.
  (| { status: "new" | "running" | "waiting" }
    | { status: "failed"; finishedAt?: string; error?: WorkflowStepError }
    | { status: "succeeded"; finishedAt: string }
    | { status: "canceled" | "crashed"; finishedAt: string; error?: WorkflowStepError }
  );
type WorkflowRunReadResponse = WorkflowRun & {
  // The step array, one entry per execution of one node, each carrying its input, output and log
  // refs. It is the record a run page draws its graph and its step panel from: the graph is the
  // workflow's OWN canvas, read-only, every node in the place the builder put it and colored by
  // that node's step status, and the panel holds one step at a time. A waiting step says what it
  // waits on and when it resumes itself on its own record, so one workflow.run.read renders why the
  // run waits, per branch, with no rebuild from the transcript (Spec-015 §Park surfacing on the read model).
  // A `waiting` run always carries at least one `waiting` step: a run waits only while a step does.
  steps: WorkflowStep[];
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
  // The session a failed step's `Fix in a fresh session` opened, which the header links to for the life
  // of the run.
  fixSessionId?: SessionId;
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
  // Present only on the chain's first run, once the chain's question has been asked: open, or
  // answered with the decision and the run count it was taken at, which its receipt reads (`Kept
  // going at 100 runs`). It is an approval the engine raises on the first run and answers through
  // workflow.gate.resolve naming no node: `approved` keeps the chain going, `rejected` stops every
  // run of it.
  chainQuestion?:
    | { state: "open" }
    | { state: "answered"; decision: ApprovalDecision; runCount: number; answeredAt: string };
};

// WorkflowRunCancel — workflow.run.cancel. It is the named producer of the `canceled` run
// status and the reachable caller of Plan-014 T5.20's engine
// cancelability rule. This operation and the
// workflow.run.canceled event type mint TOGETHER — a cancellation that moved run status
// without appending its canonical event would break the SA-24 rebuild, because a
// rebuild would restore the last suspension payload's wait cause and schedule and
// resurrect a run the person canceled (I-014-21).
interface WorkflowRunCancelRequest {
  workflowRunId: WorkflowRunId;
  // The person's own cause, recorded on the run and carried in the
  // workflow.run.canceled payload. Non-empty and at most 8 KiB, counted as the UTF-8 bytes
  // of its JSON form rather than in characters, and never reaching a step output,
  // artifact, or agent-visible context.
  reason?: string;
}
interface WorkflowRunCancelResponse {
  workflowRunId: WorkflowRunId;
  // A literal rather than the run-status union: a successful cancel has exactly one outcome, and
  // narrowing here keeps callers from switching on statuses this operation cannot produce.
  status: "canceled";
  // The `session_events.id` of the workflow.run.canceled event this call appended, in
  // the same unit of work as the status write (I-014-21). Returned so a caller can
  // correlate without a transcript read.
  canceledEventId: string;
  // True when the run was ALREADY `canceled` and this call returned the saved
  // result: no second status write, no second event, and `canceledEventId` names
  // the original. Deliberately NOT how a run that already ended otherwise answers — a
  // cancel against a run that has ended refuses `workflow.run.notCancelable`, because
  // reporting success for a run that had already ended would misinform the person about
  // what their action did. A run parked on a failed step reads `failed` while it waits
  // and has not ended, so a cancel acts on it.
  alreadyCanceled: boolean;
}

// WorkflowRunResume — workflow.run.resume. Resumes a parked
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
type WorkflowRunResumeResponse = {
  workflowRunId: WorkflowRunId;
  // `running` in the ordinary case. `waiting` where the engine immediately
  // re-parked — an SA-37 usage-limit park whose account is still spent re-parks on
  // the next dispatch. That is a legal outcome rather than a refusal, and the
  // re-park emits its own workflow.phase.suspended, which is how the person sees
  // what happened. Resuming ahead of an armed `resumeAt` is therefore permitted
  // and needs no override flag: the machine's own schedule was advisory pacing, and
  // the worst case is one observable re-park.
  status: "running" | "waiting";
} & WorkflowVersionRepin;
// Present only on an ACCEPTED re-pin, and then both: the version the run left and the
// one it joined — the same pair the audited workflow.run.resumed payload carries, so the
// projected run row stays a function of the log.
type WorkflowVersionRepin =
  | { repinnedFromWorkflowVersionId?: undefined; repinnedToWorkflowVersionId?: undefined }
  | { repinnedFromWorkflowVersionId: string; repinnedToWorkflowVersionId: string };

// WorkflowStepOutputList — workflow.step.output.list. A run's step outputs for a caller outside the
// run page — the CLI or an SDK — and only the agent and human steps' output summaries and artifact
// references: one step's full input, output or log comes only from workflow.step.read. Outputs stay
// addressable after their step completes, and a retry adds entries rather than changing one.
interface WorkflowStepOutputListRequest {
  workflowRunId: WorkflowRunId;
}
interface WorkflowStepOutputListResponse {
  steps: Array<{
    // The finished step, keyed as workflow.step.read keys it. `status` is the step's, not the
    // run's.
    nodeId: WorkflowNodeId;
    executionIndex: number;
    status: "succeeded" | "failed";
    outputs: WorkflowStepOutput[];
  }>;
}
// One saved output. An `artifactRef` output points at a Plan-011 manifest; Plan-014 stores the
// reference, never the bytes, and adds no second upload path. An `inline` output carries no artifact.
type WorkflowStepOutput =
  | { valueKind: "inline"; summary: string; producedAt: string }
  | { valueKind: "artifactRef"; artifactId: ArtifactId; summary: string; producedAt: string };

// WorkflowGateResolve — workflow.gate.resolve. Answers an approval: an approval step's Approve or
// Reject, from the approvals surface or from the step's own panel, through the one approval
// pipeline and its Cedar check; and the question the engine raises on a chain's first run once the
// chain has started as many runs as the person's setting allows, where `approved` is Keep going and
// `rejected` is Stop them all. The first answer settles the wait everywhere. An answer on a step no
// longer waiting, or after the step's `Timeout` instant even before its timer has run, is refused
// with `workflow.step.notWaiting`.
interface WorkflowGateResolveRequest {
  workflowRunId: WorkflowRunId;
  // The approval step being answered. Absent for a chain's question, which belongs to the run named
  // above — the chain's first run — rather than to a node.
  nodeId?: WorkflowNodeId;
  decision: ApprovalDecision;
  feedback?: string; // non-empty where present
}
interface WorkflowGateResolveResponse {
  // The answer's row in workflow_gate_resolutions, which the workflow.gate.resolved event names.
  gateResolutionId: string;
  // When the answer was recorded, which the step panel's past-tense receipt reads.
  decidedAt: string;
}
// What a gate is: a `human.approval` step's question, or the question a chain's first run asks once the
// chain has started as many runs as the person allows.
type WorkflowGateKind = "human.approval" | "chain";
// One answer to a gate of a run, as its append-only workflow_gate_resolutions row holds it: answers are
// never rewritten, and `sequence` counts the run's answers from 1. An approval step's answer names the
// step's node; a chain's question belongs to the run and names none.
type WorkflowGateResolution = {
  gateResolutionId: string; // the id the workflow.gate.resolved event names
  workflowRunId: WorkflowRunId;
  sequence: number;
  approvalCategory?: ApprovalCategory; // where the approval request carries one
  approvalRequestId: ApprovalRequestId; // the approval request the answer answered
  outcome: ApprovalDecision;
  deviceId: DeviceId; // the device that answered
  resolvedAt: string;
  // What the answer was given about: its scope, the resource and the reason text.
  decisionContext: Record<string, unknown>;
} & ({ gateKind: "human.approval"; nodeId: WorkflowNodeId } | { gateKind: "chain" });

// WorkflowHumanFormDraftUpdate — workflow.humanForm.draft.update.
// Ships at V1: the form kind activates it. Each save writes the daemon-held draft
// in human_phase_form_state, keyed by run and node (Spec-015 §Human form drafts
// (SA-26)), as the person types, so a half-filled form survives a reload; a client
// never keeps a form draft in window storage. A save carrying a stale
// `expectedRevision` is refused with `workflow.humanForm.revisionStale`.
//
// A step is addressed by its run, its node, its attempt and which execution of that node,
// because a retry runs a node again and a loop runs one node many times. workflow.humanForm.read
// and workflow.fixSession.create take this key as their whole request.
interface WorkflowStepKey {
  workflowRunId: WorkflowRunId;
  nodeId: WorkflowNodeId;
  attempt: number; // counted from 1; each retry is a new attempt
  executionIndex: number;
}
interface WorkflowHumanFormDraftUpdateRequest extends WorkflowStepKey {
  formState: Record<string, unknown>;
  expectedRevision?: number; // a positive draft revision
}
interface WorkflowHumanFormDraftUpdateResponse {
  revision: number;
  savedAt: string;
}

// WorkflowHumanFormSubmit — workflow.humanForm.submit. Optimistic concurrency: a submit
// carrying a stale `expectedRevision` is refused with `workflow.humanForm.revisionStale`, never
// silently overwritten, and a submit on a step no longer waiting is refused with
// `workflow.step.notWaiting`. The current revision is read from
// workflow.humanForm.read's `formRevision`: a fresh attempt reads 0,
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
// workflow.run.started — how the run was started and by whom, so the run row rebuilds from events.
interface WorkflowRunStartedPayload extends WorkflowRunEventPayload {
  mode: WorkflowRunMode;
  startedBy: WorkflowStartedBy;
}
// workflow.results.posted — a finished run's results landed as the results row in `sessionId`, the
// session that asked. It follows the run's final status.
interface WorkflowResultsPostedPayload {
  sessionId: SessionId;
  workflowRunId: WorkflowRunId;
}
// workflow.version.created names a definition rather than a run — no run exists when a version is
// written — so it carries the definition and the version alone (Spec-005 §Workflow Lifecycle).
interface WorkflowVersionCreatedPayload {
  sessionId: SessionId;
  definitionId: WorkflowDefinitionId;
  workflowVersionId: string;
}
// One execution of one node, its `StepRunId`: the run, the node, the attempt and the execution
// index, the members `WorkflowStep` keys a step by. The `workflow.phase.*` and
// `workflow.step.*` events both carry it, so an event and the step row it belongs to are
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

// workflow.run.resumed — the structured resumption point Spec-015 §Cadence requires, so a reader
// reconstructs where the run picked up without rebuilding from its whole history, plus the version pair on an
// accepted frozen-definition repair and only then: the same pair WorkflowRunResumeResponse carries, so
// the projected run row stays a function of the log (Spec-015 §Frozen-definition repair (SA-38)).
type WorkflowRunResumedPayload = WorkflowRunEventPayload & {
  resumptionPoint: {
    activeSteps: Array<{ nodeId: WorkflowNodeId; attempt: number; executionIndex: number }>;
    pendingGates: WorkflowNodeId[];
  };
} & WorkflowVersionRepin;
// workflow.run.canceled — appended in the same unit of work as the status write, so a projection
// rebuild cannot apply the last suspension again and resurrect a canceled run. `reason` is the person's own,
// present when one was given and bounded as the cancel request's is; a chain's `Stop them all`
// cancels with none.
interface WorkflowRunCanceledPayload extends WorkflowRunEventPayload {
  reason?: string;
}
// workflow.run.deleted — appended in the same unit of work as the delete of the run's rows, so a
// projection rebuild leaves out a run the person deleted, whose earlier events the log keeps.
type WorkflowRunDeletedPayload = WorkflowRunEventPayload;
// workflow.phase.failed — non-null exactly where a sibling branch's failure ended the run and
// so canceled this phase, rather than the phase failing on its own work.
interface WorkflowPhaseFailedPayload extends WorkflowStepEventPayload {
  cancellationReason: "siblingFailure" | null;
}
// workflow.phase.suspended — a step started waiting: its `waitCause` and, for an `account` wait,
// the spent account the attention read groups it under and the durable resume instant where the
// wait armed one; absent, only the person resumes it. A wait on anything else names neither. The
// deadline a `Timeout` arms is written on the step's row as truth and rides no event.
type WorkflowPhaseSuspendedPayload = WorkflowStepEventPayload &
  (
    | { waitCause: "account"; providerAccountId: ProviderAccountId; resumeAt?: string } // RFC 3339 UTC
    | { waitCause: Exclude<WorkflowWaitCause, "account"> }
  );
// workflow.phase.waitingOnPool — diagnostic, for a step the engine's one memory gate holds before
// it starts (`waitingMemory`). Memory is the only real pool behind the gate: there is no step count
// and no terminal slot pool, so the payload names no pool. It is emitted on entry to the held state
// and every 30 seconds while held, so `waitingSinceSeq` — the envelope sequence the wait began at —
// is what correlates the repeats back to one wait (Spec-015 §Cadence).
interface WorkflowPhaseWaitingOnPoolPayload extends WorkflowStepEventPayload {
  waitingSinceSeq: number;
}
// The step boundaries. A started event names the input it ran on and, on an agent step whose
// account cannot run its run's level, the level it runs at in its place; a finished event the
// output and log it produced plus its cost where a provider was billed; a failed event the error,
// the item index that failed and the words typed with the `Decline` that failed a command step; a
// canceled event the step alone; and a skipped event why it was skipped. A step's started event
// precedes its finished, failed or canceled event.
interface WorkflowStepStartedPayload extends WorkflowStepEventPayload {
  inputRef: WorkflowPayloadRef;
  permissionLevel?: PermissionLevel;
}
interface WorkflowStepCompletedPayload extends WorkflowStepEventPayload {
  outputRef: WorkflowPayloadRef;
  logRef: WorkflowPayloadRef;
  cost?: WorkflowCost;
}
interface WorkflowStepFailedPayload extends WorkflowStepEventPayload {
  error: WorkflowStepError;
  failedItemIndex?: number;
  declineReason?: string; // only where words were typed on the `Decline`
}
type WorkflowStepCanceledPayload = WorkflowStepEventPayload;
interface WorkflowStepSkippedPayload extends WorkflowStepEventPayload {
  reason: "noItems" | "disabled";
}
// workflow.gate.resolved — the answer an approval took, in the same vocabulary
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

### Workflow Method-Name Registry

Daemon JSON-RPC; the `workflow` root, each name following the wire-name grammar, checked at build time ([Local IPC Payload Contracts §Wire-Name Grammar](./local-ipc-payloads.md#wire-name-grammar)). Each row below has its shape above, in workflow-document-payloads.md or in workflow-builder-and-runs-payloads.md. Which of them the daemon serves is in [§Operations Not Yet Built](./api-payload-contracts.md#operations-not-yet-built).

| Method | Procedure type | Request → Response | Notes |
| --- | --- | --- | --- |
| `workflow.definition.create` | `mutation` | `WorkflowDefinitionCreateRequest` → `WorkflowDefinitionCreateResponse` | Content-hashes and persists version 1; the daemon re-checks the whole document and refuses `workflow.definition.refused` with every finding, and `workflow.version.notFound` for a Duplicate's `copiedVersionId` not in the library |
| `workflow.definition.read` | `query` | `WorkflowDefinitionReadRequest` → `WorkflowDefinitionReadResponse` | Definition header plus the current version pointer and the workflow's own permission level; the latest version unless `version` is supplied; carries a webhook workflow's token dates and last fire, never the token; a deleted workflow still reads, with `deletedAt` set |
| `workflow.definition.list` | `query` | `WorkflowDefinitionListRequest` → `WorkflowDefinitionListResponse` | Every workflow in the one library with the facts its catalog row shows, each entry carrying its last run, its last skipped fire, its schedule and whether it is enabled, paged |
| `workflow.version.read` | `query` | `WorkflowVersionReadRequest` → `WorkflowVersionReadResponse` | Immutable version body, addressed by definition id and version number; a running instance stays pinned to its own |
| `workflow.run.start` | `mutation` | `WorkflowRunStartRequest` → `WorkflowRunStartResponse` | Binds a run to a pinned version, in the asking chat's session or the workflow's own, working in the repository `projectId` names, else in the asking session's recorded folder, else, with neither, in the run's own folder; refuses `workflow.run.projectOnProjectSession` for a `projectId` beside a project session's `sessionId`; emits `workflow.run.started`; judges an agent's start and a trigger's fire under `workflow::start` and refuses `workflow.run.startDenied` (ADR-025), while the person's own start passes no policy check; refuses `workflow.run.repositoryRequired` for a start that names no project's repository — a `None` run, or a chat's start naming none — of a version holding a Git, Read a repo diff or Run tests step; refuses `workflow.run.inputRequired` for a start that leaves a required declared input unfilled or gives an input a value that does not fit it |
| `workflow.run.read` | `query` | `WorkflowRunReadRequest` → `WorkflowRunReadResponse` | Projection read; rebuildable from `session_events`. Carries the step array with each waiting step's cause, instants and question and each answered step's resolution and an approval step's `reviewPause`, the chain's first run with its run count, whether the run's execution context was captured, the Keep mark, the fix session, the run's cost, a going run's live step, the per-edge item counts, a finished run's review epoch and the chain's question on its first run, so a waiting run renders from this one call (Spec-015 §Park surfacing on the read model) |
| `workflow.run.cancel` | `mutation` | `WorkflowRunCancelRequest` → `WorkflowRunCancelResponse` | The named producer of the `canceled` run status; emits `workflow.run.canceled` in the same unit of work as the status write (I-014-21); refuses `workflow.run.notCancelable` against a run that has ended; a `failed` run parked on its failed step has not ended and is canceled (a cancel on an already-`canceled` run returns the saved result) |
| `workflow.run.resume` | `mutation` | `WorkflowRunResumeRequest` → `WorkflowRunResumeResponse` | The person's resumption of a parked run, carrying the optional explicit SA-38 re-pin as a request member rather than a method of its own; emits `workflow.run.resumed` (with the re-pin member on an accepted repair); refuses `workflow.run.resumeNotParked`, or `workflow.run.repairNotParked`, `workflow.run.repairAttemptInFlight` or `workflow.run.repairVersionUnaccountable` on the re-pin leg |
| `workflow.step.output.list` | `query` | `WorkflowStepOutputListRequest` → `WorkflowStepOutputListResponse` | The agent and human steps' output summaries and artifact references, for the CLI and an SDK; one step's full input, output or log comes only from `workflow.step.read`; a retry adds entries, never changes one (SA-16) |
| `workflow.gate.resolve` | `mutation` | `WorkflowGateResolveRequest` → `WorkflowGateResolveResponse` | Answers an approval step, or a chain's question (`approved` keeps going, `rejected` stops them all); appends one `workflow_gate_resolutions` row; emits `workflow.gate.resolved`; refuses `workflow.step.notWaiting` on a step no longer waiting |
| `workflow.humanForm.draft.update` | `mutation` | `WorkflowHumanFormDraftUpdateRequest` → `WorkflowHumanFormDraftUpdateResponse` | Writes the daemon-held draft of a form step as it is typed; each save bumps the draft's own revision, and a stale one refuses `workflow.humanForm.revisionStale` (SA-26) |
| `workflow.humanForm.submit` | `mutation` | `WorkflowHumanFormSubmitRequest` → `WorkflowHumanFormSubmitResponse` | Optimistic-concurrency submit against the form's revision that writes the step's output and resumes the run; refuses `workflow.humanForm.revisionStale` or `workflow.step.notWaiting` |
| `workflow.definition.update` | `mutation` | `WorkflowDefinitionUpdateRequest` → `WorkflowDefinitionUpdateResponse` | A new immutable version of an existing definition, optimistic on the expected version (`workflow.version.stale` when it is stale) |
| `workflow.definition.delete` | `mutation` | `WorkflowDefinitionDeleteRequest` → `WorkflowDefinitionDeleteResponse` | Soft delete; the runs that pinned its versions stay readable, and the response states how many |
| `workflow.definition.export` | `mutation` | `WorkflowDefinitionExportRequest` → `WorkflowDefinitionExportResponse` | Writes the canonical file form of one version, layout section and package locks included, to the file the platform's save dialog picked |
| `workflow.definition.import` | `mutation` | `WorkflowDefinitionImportRequest` → `WorkflowDefinitionCreateResponse` | Reads the file the platform's open dialog picked and submits it through the create path, all or nothing, so an import carries no governance state; refuses `workflow.definition.importSchemaUnknown` for an unknown schema version |
| `workflow.enabled.update` | `mutation` | `WorkflowEnabledUpdateRequest` → `WorkflowEnabledUpdateResponse` | Arms or disarms every trigger of one workflow; refuses `workflow.trigger.unarmable` where a trigger cannot arm |
| `workflow.run.list` | `query` | `WorkflowRunListRequest` → `WorkflowRunListResponse` | The runs enumeration, with the filters the table narrows on, the version scope Show runs hands in, the total and paging |
| `workflow.version.list` | `query` | `WorkflowVersionListRequest` → `WorkflowVersionListResponse` | The chain one run's pinned version belongs to, addressed by that version id |
| `workflow.step.read` | `query` | `WorkflowStepReadRequest` → `WorkflowStepReadResponse` | One step's input, output or log by ref, paged and redacted |
| `workflow.step.tabArtifact.create` | `mutation` | `WorkflowStepTabArtifactCreateRequest` → `WorkflowStepTabArtifactCreateResponse` | Stores what one step-panel tab holds — an inline payload, the step's cost or its error — as an artifact through `ArtifactPublish`, answering its id |
| `workflow.run.retry` | `mutation` | `WorkflowRunRetryRequest` → `WorkflowRunRetryResponse` | Re-runs from a named step with the prior run's data pinned upstream; mints a new run in `retry` mode; refuses `workflow.run.stillRunning` or `workflow.invalidTransition` |
| `workflow.run.rerun` | `mutation` | `WorkflowRunRerunRequest` → `WorkflowRunStartResponse` | Starts a new run of the named run's own pinned version with the input and mode it was started with, in its session; emits `workflow.run.started`; the person's own start, judged by no policy, offered in every state of the source run |
| `workflow.node.execute` | `mutation` | `WorkflowNodeExecuteRequest` → `WorkflowNodeExecuteResponse` | Executes one node, or it and its ancestors, against pinned or prior input, in the trigger's `Repository`, or, on a `chat` or `subWorkflow` trigger, the one `projectId` names; the daemon computes the filtered run |
| `workflow.results.post` | `mutation` | `WorkflowResultsPostRequest` → `WorkflowResultsPostResponse` | Posts a run's results into the session the verb was typed in, which the daemon checks is the caller's own; the agent's tool takes no session, the daemon deriving it from the invoking turn; refuses `workflow.invalidTransition` for an unfinished run |
| `workflow.subscribe` | `subscription` | `WorkflowSubscribeRequest` → `WorkflowSubscribeNotification` (stream) | The scheduler hold and its count first, then run, step, schedule and definition notifications and removals, for the runs table, the Workflows tab and the canvas overlay |
| `workflow.kind.list` | `query` | `EmptyPayload` → `WorkflowKindListResponse` | The node catalog with its param specs, so the palette, the inspector and an agent read one list |
| `workflow.newRunHold.update` | `mutation` | `WorkflowNewRunHoldUpdateRequest` → `WorkflowNewRunHoldState` | The scheduler-wide hold on starting new runs; takes no run id, so it is not a per-run control, and answers with how many starts are waiting |
| `workflow.layout.update` | `mutation` | `WorkflowLayoutUpdateRequest` → `WorkflowDefinitionSettingResponse` | The canvas layout, saved beside the definition without a new version |
| `workflow.tags.update` | `mutation` | `WorkflowTagsUpdateRequest` → `WorkflowDefinitionSettingResponse` | The workflow's tags, saved beside the definition without a new version |
| `workflow.permissionLevel.update` | `mutation` | `WorkflowPermissionLevelUpdateRequest` → `WorkflowPermissionLevelUpdateResponse` | The workflow's own permission level, saved beside the definition without a new version |
| `workflow.backgroundBrowser.update` | `mutation` | `WorkflowBackgroundBrowserUpdateRequest` → `WorkflowBackgroundBrowserUpdateResponse` | The workflow's background-browser pick from the builder's browser pill, saved beside the definition without a new version; every later run uses it, a live run keeping the browser it started with |
| `workflow.pinData.update` | `mutation` | `WorkflowPinDataUpdateRequest` → `WorkflowPinDataUpdateResponse` | Pins or unpins a node's test data without a new version; honored only in manual runs |
| `workflow.draft.update` | `mutation` | `WorkflowDraftUpdateRequest` → `WorkflowDraftUpdateResponse` | The builder's unsaved draft, held by the daemon so it survives a reload, one per saved workflow and one for a new workflow |
| `workflow.draft.read` | `query` | `WorkflowDraftReadRequest` → `WorkflowDraftReadResponse` | The draft read back after a reload, by the id the builder's address carries |
| `workflow.expression.preview` | `query` | `WorkflowExpressionPreviewRequest` → `WorkflowExpressionPreviewResponse` | An expression's value against the last run, evaluated in the daemon; never resolves a secret |
| `workflow.version.diff.read` | `query` | `WorkflowVersionDiffReadRequest` → `WorkflowVersionDiffReadResponse` | The structural difference between two versions, over the hashed body only |
| `workflow.run.delete` | `mutation` | `WorkflowRunDeleteRequest` → `WorkflowRunDeleteResponse` | Deletes one run with its step data and snapshots, appending `workflow.run.deleted` in the write that deletes its rows; refuses `workflow.run.notDeletable` on a `new`, `running` or `waiting` run, on a failed run parked on its failed step, and on a chain's first run while a later run of its chain is one of those |
| `workflow.run.purge.preview` | `query` | `WorkflowRunPurgeRequest` → `WorkflowRunPurgePreviewResponse` | What "Delete runs older than…" would remove, counted before it runs |
| `workflow.run.purge` | `mutation` | `WorkflowRunPurgeRequest` → `WorkflowRunPurgeResponse` | Deletes the runs older than an instant, each with its own `workflow.run.deleted`; runs marked Keep, `new`, `running` and `waiting` runs, failed runs parked on their failed step, and a chain's first run while a later run of its chain is one of those are untouched |
| `workflow.run.keep.update` | `mutation` | `WorkflowRunKeepSet` → `WorkflowRunKeepSet` | Marks a run Keep, which deleting old runs leaves, or clears the mark |
| `workflow.fixSession.create` | `mutation` | `WorkflowStepKey` → `WorkflowFixSessionCreateResponse` | Opens a fresh session to fix a failed step, which the run links to; refuses `workflow.invalidTransition` on a step that did not fail |
| `workflow.humanForm.read` | `query` | `WorkflowStepKey` → `WorkflowHumanFormReadResponse` | A waiting form: prompt, fields, the saved draft and the submit revision; refuses `workflow.step.notWaiting` |
| `workflow.run.attention.list` | `query` | `EmptyPayload` → `WorkflowRunAttentionListResponse` | The runs waiting on a person, oldest first, under one `account` entry per spent provider account keyed by its `providerAccountId`; no filter narrows it |
| `workflow.webhookToken.rotate` | `mutation` | `WorkflowWebhookTokenRotateRequest` → `WorkflowWebhookTokenRotateResponse` | Creates or rotates a workflow's webhook token, returned once; only its hash is kept, so the old token is refused from that moment |
| `workflow.webhookListener.read` | `query` | `EmptyPayload` → `WorkflowWebhookListenerReadResponse` | The webhook listener's port and whether it listens |
| `workflow.secret.list` | `query` | `EmptyPayload` → `WorkflowSecretListResponse` | Every secret, the shared ones and each project's, by name, for a step's Credential chooser; never a value |
| `workflow.secret.create` | `mutation` | `WorkflowSecretCreateRequest` → `WorkflowSecretSummary` | Seals a new secret's value in the credential store, or the daemon's `secrets.json` on Linux and on a Mac whose secrets are in it, under a scope and name; refuses `workflow.secret.nameInvalid`, `workflow.secret.nameTaken` or `workflow.secret.storeUnavailable` |
| `workflow.secret.update` | `mutation` | `WorkflowSecretUpdateRequest` → `WorkflowSecretActResponse` | Replaces a secret's value in its store; refuses `workflow.secret.storeUnavailable` |
| `workflow.secret.delete` | `mutation` | `WorkflowSecretDeleteRequest` → `WorkflowSecretActResponse` | Deletes a secret's record and its stored value |
| `workflow.keptValue.clear` | `mutation` | `WorkflowKeptValueClearRequest` → `WorkflowKeptValueClearResponse` | Clears the values `Keep for later runs` kept for one workflow |

The canonical file form of a definition ([Workflow Graph Model §Definition file form — export and import (C-17)](../../domain/workflow-graph-model.md#definition-file-form--export-and-import-c-17)) is a serialization of these same shapes — the file the authoring commitment names, carrying the schema-version marker, whose canonical bytes are the JCS-canonicalized JSON of the parsed document. It is not a second dialect and has no contract types of its own. `layout` is an optional top-level section of that document, outside the hashed body, and it is persisted in a column beside the definition body and carried by the file, so moving a node mints no version ([Workflow Graph Model §Canvas layout is not definition bytes (SA-32)](../../domain/workflow-graph-model.md#canvas-layout-is-not-definition-bytes-sa-32)). Export and import are the operations in workflow-builder-and-runs-payloads.md rather than client-side work over the create and version reads: the canonical bytes and their content hash belong to the store, a round trip in either direction must reproduce them exactly, and an import must run the create path's whole validation so it can carry no governance state. Both act on the file the person picked with the platform's own dialog: the renderer hands the daemon the dialog's `FilePathRef` token, main's relay turns it into the path, and the daemon alone reads or writes the file, so no path string and no file text crosses the bridge ([Preload Bridge Contract](preload-bridge-contract.md)). `workflow.definition.import` submits through `workflow.definition.create`'s own path for that reason and adds no second parse.

Starting a workflow from chat likewise adds **no** method: the chat surfaces are client-surface sugar over `workflow.run.start` (ADR-025), and `workflow_run` below is a callback tool, not a JSON-RPC method.

The session's workflow callback tools (ADR-025; [Spec-015 §Interfaces And Contracts](../../specs/015-workflow-authoring-and-execution.md#interfaces-and-contracts); Plan-014 T5.8 / CP-014-7) are each a `SessionCallbackTool` of the provider-driver-capability-payloads.md shape: a JSON-Schema input, a Cedar action, an approval category, and a `toolActivity` record on every invocation. They register into the Plan-003 callback-tool host registry at session spawn and every invocation routes through the CP-003-5 Cedar seam. Born-withheld: while the daemon's approval service is not running the whole registry is withheld at spawn and a stray invocation answers `denied` — never `completed` without Cedar. An agent's own tool allowlist decides which of them that agent holds.

| Tool | Adjudicated as |
| --- | --- |
| `workflow_kinds`, `workflow_list`, `workflow_read`, `workflow_runs`, `workflow_run_read`, `workflow_step_read`, `workflow_validate` | reads, gated on the session itself |
| `workflow_create`, `workflow_update`, `workflow_schedule_set`, `workflow_enable` (which takes the enabled flag, so it serves both the enable and the disable verb) | `Action::"workflow::author"` |
| `workflow_run`, `workflow_node_execute` | `Action::"workflow::start"` |
| `workflow_cancel` | `Action::"workflow::cancel"` |
| `workflow_resume` | `Action::"workflow::resume"` |
| `workflow_results_post` | `Action::"workflow::author"`, with the session derived from the invoking turn and never tool-supplied |

No tool in the set takes the session it acts on as an argument, per [Spec-010 §Interfaces And Contracts](../../specs/010-approvals-permissions-and-trust-boundaries.md#interfaces-and-contracts): the daemon derives it from the invoking turn's own context, validates the derived value, and refuses a smuggled one, so a forged target cannot be reached. Every field a model reads is snake_case, and each tool whose input differs from its method's request maps it to that request's lowerCamelCase in the daemon, so `workflow_run`'s `definition_name` is `definitionName` on the wire; `workflow_list` takes `workflow.definition.list`'s request unchanged. The reads and the author tools name a workflow by its `definition_id` from `workflow_list`, and a run by its `workflow_run_id`. `workflow_run` and `workflow_node_execute` take a definition by name, `definition_name`, which names one workflow in the one library (`workflow_node_execute` also takes an optional `version`, its saved version number, the latest when omitted, which the daemon resolves to the version it runs), issuing the same start path as `workflow.run.start` in the invoking turn's session and its recorded folder; in a chat, either also takes an optional `project`, a project's name as `session_options` lists it, and the run then works in that project's own folder; a Cedar denial answers `denied` carrying `workflow.run.startDenied`. None of these tools is a JSON-RPC method: the chat-start surface adds no registry row of its own.

Error vocabulary: [error-contracts.md](./error-contracts.md) §Workflow. Every refusal point on this surface carries a code of its own, a new code named in the wire-name grammar's `domain[.resource].condition` form ([Local IPC Payload Contracts §Wire-Name Grammar](./local-ipc-payloads.md#wire-name-grammar)), registered in its contract before the capability is implemented, and none ships unregistered ([Spec-015 §Loud-errors discipline (C-12)](../../specs/015-workflow-authoring-and-execution.md#loud-errors-discipline-c-12) forbids untyped refusals). A state refusal is 409, well-formed input the daemon cannot act on is 422, and findings ride the error as an extension list. The calls above refuse with: `workflow.definition.notFound`, `workflow.version.notFound`, `workflow.run.notFound` and `workflow.step.notFound`, one per subject that does not exist; `workflow.run.startDenied` for a denied or unresolvable start; `workflow.run.repositoryRequired` (422, `nodeIds`) for a start or a node run (`workflow.node.execute`) that names no project's repository, of a version holding a Git, Read a repo diff or Run tests step; `workflow.run.projectOnProjectSession` (422) for a start in a project session that names a project; `workflow.run.inputRequired` (422, `inputNames`) for a start that leaves a required declared input unfilled or gives an input a value that does not fit it; `workflow.code.packagesNotLocked` (409, `nodeIds`) for a start of a version whose Code steps' packages are not locked; `workflow.run.notCancelable` and `workflow.run.resumeNotParked` for cancel and resume; `workflow.cursorUnresolvable` (400) for a `workflow.run.list`, `workflow.step.read` or `workflow.definition.list` cursor the daemon did not write, or one past the end of what it pages; `workflow.version.diffCrossWorkflow` (422) for a `workflow.version.diff.read` naming versions of two different workflows; the [Spec-015 §Frozen-definition repair (SA-38)](../../specs/015-workflow-authoring-and-execution.md#frozen-definition-repair-sa-38) re-pin refusals `workflow.run.repairNotParked`, `workflow.run.repairAttemptInFlight` and `workflow.run.repairVersionUnaccountable`; `workflow.definition.refused` (422), carrying `findings: [{rule, nodeIds, detail?}]` — the whole list the daemon's re-check finds, each `rule` from `WORKFLOW_DEFINITION_FINDING_RULES` in `crates/sidekicks-contracts/src/workflow/definition/refusals.rs`, save `nodeIdDuplicate`, which the document's read raises as the `params` of its refusal issue; `workflow.humanForm.revisionStale` (409) for a stale form revision; `workflow.version.stale` (409) for a stale definition version; `workflow.step.notWaiting` (409) for a form submitted or read, or an approval answered, on a step no longer waiting; `workflow.run.stillRunning` (409, `reason: sourceRunning`); `workflow.run.notDeletable` (409) on a `new`, `running` or `waiting` run, on a failed run parked on its failed step, and on a chain's first run while a later run of its chain is one of those; `workflow.invalidTransition` (409) for a run or step move its state does not allow, such as retrying a step that did not fail or posting results from an unfinished run; `workflow.trigger.unarmable` for a trigger that cannot arm; `workflow.definition.importSchemaUnknown` for an import whose schema version is unknown; and, on the secret verbs, `workflow.secret.nameInvalid` for a name that breaks the pattern, `workflow.secret.nameTaken` for one its scope already holds, and `workflow.secret.storeUnavailable` (`cause: locked | unavailable`). The webhook listener refuses a call whose token does not match, a call while no token exists and a call to an unknown hook id alike with `workflow.webhookToken.mismatch`, so the listener never reveals which ids exist. A step that fails carries its code on its `error` and on the `workflow.step.failed` event, for the life of the run record: `workflow.code.overBudget`, `workflow.code.installFailed` (`reason: diskSpace | toolError`), `workflow.step.threadFailed` (`reason: startFailed`), `workflow.sandboxUnavailable` (`provider`, the id of the provider whose sandbox did not start, and `detail`), `workflow.step.timedOut` (`cause: stepTimeout | runCap`), `workflow.secret.notFound` (carrying only the reference) and `workflow.secret.storeUnavailable`. The park, pacing and cancelability rules mint no code of their own. Durable events owned by Plan-014: the `workflow.*` types across the workflow families enumerated in [Spec-015 §Event types (SA-19)](../../specs/015-workflow-authoring-and-execution.md#event-types-sa-19) and registered in the [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md) census, whose categories that spec carries as its own sections; their typed payloads are the `Workflow*Payload` shapes above.
