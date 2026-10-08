# Workflow Builder And Runs Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

```ts
// ---- The builder, the catalog and the runs surface ----

// WorkflowDefinitionUpdate — workflow.definitionUpdate. A save writes a NEW IMMUTABLE VERSION and never
// mutates an existing one, so this operation mints a version rather than editing bytes. It is optimistic
// on the version the author loaded: a stale expectation is refused with `workflow.version_stale`, never
// silently rebased onto a version the author never saw. Save, Restore and the `/workflow schedule` verb
// all ride it. The response names the new version of the definition the request addressed; a document
// identical to the latest version mints none, and the response names that latest version.
interface WorkflowDefinitionUpdateRequest {
  definitionId: WorkflowDefinitionId;
  expectedVersionNumber: number;
  document: WorkflowDocument;
  // Present on a Restore: the older version the document repeats, whose package locks the new version
  // keeps, so a restored version installs the packages it ran with.
  restoredVersionNumber?: number;
}
interface WorkflowDefinitionUpdateResponse {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
  workflowVersionId: string;
  contentHash: string;
  createdAt: string;
}

// WorkflowDefinitionDelete — workflow.definitionDelete. A SOFT delete: the definition leaves the catalog
// and the runs that pinned its versions stay readable against those versions, which is why the response
// states how many runs that is — the confirm names the count before it acts, and it is not undoable.
interface WorkflowDefinitionDeleteRequest {
  definitionId: WorkflowDefinitionId;
}
interface WorkflowDefinitionDeleteResponse {
  definitionId: WorkflowDefinitionId;
  deleted: true;
  retainedRunCount: number;
}

// WorkflowDefinitionExport — workflow.definitionExport. Writes the canonical file form of one version — the
// hashed body plus the optional non-hashed layout section, with each Code node's package lock — to the file
// the person picked with the platform's own save dialog. It is a SERVER operation rather than a client-side
// serialization of a version read, because the canonical bytes and their content hash are the store's own
// and a round trip in either direction must reproduce them exactly. The renderer never names a path and
// never holds the file's bytes: it sends the `FilePathRef` token `native.showSaveDialog` returned, and
// main's relay puts the path that token stands for in `filePath` before the request reaches the daemon
// (Preload Bridge Contract).
interface WorkflowDefinitionExportRequest {
  definitionId: WorkflowDefinitionId;
  version?: number; // omit for latest
  includeLayout?: boolean; // default true; the layout section is outside the hashed body either way
  filePath: string;
}
interface WorkflowDefinitionExportResponse {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
  contentHash: string;
}

// WorkflowDefinitionImport — workflow.definitionImport. Reads the file the person picked with the platform's
// own open dialog — its `FilePathRef` token, which main's relay puts in `filePath` as the path it stands
// for — parses it, and submits it through the ORDINARY create path with the ordinary validation, all or
// nothing, answering as workflow.definitionCreate does, into the one library. A tool binding with an
// approval setting and an unknown top-level key are each refused as parse errors naming the field. A file
// whose schema version the daemon does not know is refused with `workflow.import_schema_unknown`. A Code
// node keeps the package lock the file carries, and one without a lock is locked on import, or kept with
// `Packages not locked` where the lock cannot be made. A document with no layout
// section is laid out deterministically on open, so an imported file is never unopenable.
interface WorkflowDefinitionImportRequest {
  filePath: string;
}

// WorkflowEnabledSet — workflow.enabledSet. Arms or disarms EVERY trigger one workflow declares; there is
// no per-trigger arming, because a workflow is enabled or it is not. A workflow with no trigger that can
// arm cannot be enabled and the operation REFUSES with `workflow.trigger_unarmable`, saying which trigger
// could not arm, rather than accepting and leaving a toggle that reads on while nothing fires.
interface WorkflowEnabledSetRequest {
  definitionId: WorkflowDefinitionId;
  enabled: boolean;
}
interface WorkflowEnabledSetResponse {
  definitionId: WorkflowDefinitionId;
  enabled: boolean;
  // How many of the definition's triggers are armed now. Zero on a disarm; on an arm it equals the
  // triggers the definition declares, since a partial arm refuses instead.
  armedTriggerCount: number;
}

// WorkflowRunList — workflow.runList. The runs enumeration, with the filters the runs table narrows
// on — workflow, status, trigger, and a date range — and one narrowing beside them: the version scope the
// Versions panel's Show runs hands in, which the table draws as one removable chip, never keeps, and
// Clear filters clears. Filters narrow the TABLE alone — whatever stands above it is unfiltered, which is
// why the runs that need someone are workflow.runAttentionList, a separate read rather than a filtered
// slice of this one.
interface WorkflowRunListRequest {
  sessionId?: SessionId; // omit for every run this daemon ran
  definitionId?: WorkflowDefinitionId;
  // The version scope Show runs hands in: only runs pinned to this version. Sent only with
  // `definitionId`, which Show runs sets to the same workflow.
  workflowVersionId?: string;
  status?: [WorkflowRunStatus, ...WorkflowRunStatus[]];
  triggerKind?: [WorkflowTriggerKind, ...WorkflowTriggerKind[]]; // the trigger filter
  startedAfter?: string;
  startedBefore?: string;
  limit?: number;
  cursor?: string;
}
// One row of the runs table, in the order the row reads it. A row carries no version: the pinned version
// is read in the header of the run's own page. Only a waiting run names the kind of wait, so a wait on a
// person and a wait on a spent provider account read apart. Only an account wait carries `resumeAt`,
// and only where the wait armed one: the instant it will resume itself. Where none is armed, no instant
// is invented.
type WorkflowRunSummary = {
  workflowRunId: WorkflowRunId;
  // The session the run lives in: the chat that started it, or the one session the workflow owns for a
  // run nobody started from a chat. The row opens it.
  sessionId: SessionId;
  definitionId: WorkflowDefinitionId;
  definitionName: string;
  mode: WorkflowRunMode;
  triggerKind: WorkflowTriggerKind; // the trigger column reads it
  startedBy: WorkflowStartedBy;
  startedAt: string;
  durationMs?: number; // present once the run has ended; absent while it is `new`, `running` or `waiting` and on a `failed` run parked on its failed step
  stepCount: number;
  // Where the run is and what it is doing, present only while the run is going: the live step's place in
  // the run (1-based, never past `total`) and its name. It goes back to the finished step count when the
  // run ends, so the row never grows a second line.
  liveStep?: { index: number; total: number; nodeName: string };
  // Present only where a provider was billed, carrying the account that paid. A row that was never billed
  // carries none, and reads `$0.00` with no account.
  cost?: WorkflowCost;
  // Whether the person marked the run Keep, which the row shows as a mark and `Delete runs older than…`
  // leaves.
  keep: boolean;
} & (
  | { status: "waiting"; waitCause: "account"; resumeAt?: string }
  | { status: "waiting"; waitCause: Exclude<WorkflowWaitCause, "account"> }
  | { status: Exclude<WorkflowRunStatus, "waiting"> }
);
interface WorkflowRunListResponse {
  runs: WorkflowRunSummary[]; // one page; each run is listed once across pages
  // How many runs the request's filters match, so the tab's count reads right on first paint; never
  // fewer than the page holds.
  totalCount: number;
  nextCursor?: string;
}

// WorkflowVersionChainRead — workflow.versionChainRead. The chain one run's pinned version belongs to,
// addressed BY THAT VERSION ID rather than by the definition: a run pins its version, and a run whose
// definition was deleted still opens, so the read must work from the only handle such a run holds.
interface WorkflowVersionChainReadRequest {
  workflowVersionId: string;
}
interface WorkflowVersionChainReadResponse {
  definitionId: WorkflowDefinitionId;
  // Oldest first, never empty. Every version the chain holds, each addressable by `workflow.versionRead`.
  versions: Array<{
    workflowVersionId: string;
    versionNumber: number;
    contentHash: string;
    createdAt: string;
    // Who saved it: the person, or the agent that did. The Versions panel names it on each row, beside
    // the one-line count below.
    savedBy: { kind: "user" } | { kind: "agent"; agentId: AgentId };
    // How many nodes and edges this version changed over the one before it, counted over the hashed
    // body only, so a moved node never counts. Absent on the first version.
    changesFromPrevious?: {
      nodesAdded: number;
      nodesRemoved: number;
      nodesChanged: number;
      edgesAdded: number;
      edgesRemoved: number;
    };
  }>;
}

// WorkflowStepRead — workflow.stepRead. One step's input, output or log, by ref, paged and redacted. Every
// resolved secret value is added to the run's redaction set BEFORE the first log line is written, so
// redaction is a property of what was stored rather than of this read.
interface WorkflowStepReadRequest extends WorkflowStepKey {
  which: "input" | "output" | "log";
  limit?: number;
  cursor?: string;
}
interface WorkflowStepReadResponse {
  nodeId: WorkflowNodeId;
  executionIndex: number;
  which: "input" | "output" | "log";
  payload: WorkflowPayloadRef;
  nextCursor?: string;
}

// WorkflowStepTabArtifactCreate — workflow.stepTabArtifactCreate. A step-panel tab's `Open as artifact`:
// the daemon stores what that tab holds — an inline input, output or log, the step's cost or its
// error — as an artifact of the run's session through ArtifactPublish (artifact-payloads.md §Plan-011), and answers its id.
interface WorkflowStepTabArtifactCreateRequest extends WorkflowStepKey {
  which: "input" | "output" | "log" | "cost" | "error";
}
interface WorkflowStepTabArtifactCreateResponse {
  artifactId: ArtifactId;
}

// WorkflowRunRetry — workflow.runRetry. Re-runs from a NAMED STEP: that step and its descendants run
// again, with the prior run's data pinned upstream so the retry feeds on exactly what the original fed on.
// It mints a new run in `retry` mode rather than mutating the original, which stays readable. It is
// refused with `workflow.retry_unavailable` — `reason: "source_running"` while the source run is still
// going — and with `workflow.invalid_transition` for a step that did not fail.
interface WorkflowRunRetryRequest {
  workflowRunId: WorkflowRunId;
  fromNodeId: WorkflowNodeId;
}
interface WorkflowRunRetryResponse {
  workflowRunId: WorkflowRunId; // the new run, never the source
  sourceWorkflowRunId: WorkflowRunId;
  status: "new" | "running";
}

// WorkflowRunRerun — workflow.runRerun. Re-run on a run's page: a NEW run of the named run's own pinned
// version, with the input and the mode that run was started with, in the session that run lives in. The
// daemon reads all three from the source run, so the request names only the run; the workflow's later
// versions and current inputs play no part. It is the person's own start and passes no policy check, and
// it is offered whatever state the source run is in. The answer is a start's answer.
interface WorkflowRunRerunRequest {
  workflowRunId: WorkflowRunId; // the run to re-run
}
// → WorkflowRunStartResponse, naming the new run

// WorkflowNodeExecute — workflow.nodeExecute. Executes one node in the builder against pinned or prior
// input. Run-this-node is the single-node case and run-from-here is the same call with the ancestors
// included: the target's ancestors plus the target run, clean step data is REUSED and only dirty nodes are
// re-executed. The dirty set lives in the builder, but the filtered run is computed by the DAEMON, which
// is authoritative — a client's lattice is a hint, never the plan. It runs a SAVED version and never
// unsaved bytes: a dirty draft is saved first and the version saved is the version run. Pinned data is
// honored here and IGNORED by every trigger-started run.
interface WorkflowNodeExecuteRequest {
  workflowVersionId: string;
  // Omitted from the builder, where the run lives in the one session the workflow owns and works in the
  // repository the trigger's `Repository` names; a chat that asks for a node run names its own session,
  // as workflow.runStart does, and works in that session's recorded folder.
  sessionId?: SessionId;
  // The project the builder's `Repository` panel names for a node run on a `chat` or `sub-workflow`
  // trigger, which carries no `Repository` of its own; absent for `None`, and on every other trigger,
  // whose `Repository` the daemon reads. A version holding a Git, Read a repo diff or Run tests step
  // with none named is refused `workflow.repository_required`.
  projectId?: ProjectId;
  nodeId: WorkflowNodeId;
  // `node` runs the one node; `fromHere` runs its ancestors and it.
  scope: "node" | "fromHere";
  // The nodes the builder believes are dirty. The daemon intersects this with what it can reuse and
  // answers with the set it actually ran, so a stale hint costs a re-execution and never a wrong result.
  dirtyNodeIds?: WorkflowNodeId[];
}
interface WorkflowNodeExecuteResponse {
  workflowRunId: WorkflowRunId;
  // The nodes the daemon actually executed, in execution order — the authoritative answer to what the
  // filtered run did.
  executedNodeIds: WorkflowNodeId[];
  reusedNodeIds: WorkflowNodeId[];
}

// WorkflowResultsPost — workflow.resultsPost. Posts a run's results into the session that asks for them, as
// the results row. The `/workflow results` verb sends the session it was typed in, and the daemon checks
// that session is the caller's own before it posts; the agent's `workflow_results_post` tool takes no
// session at all, the daemon deriving it from the invoking turn. Results are pulled into a session only
// from inside that session, never pushed into one that did not ask, and a run page carries no send-to-chat
// action at all. A run that has not finished is refused with `workflow.invalid_transition`. The post
// appends `workflow.results_posted` after the run's terminal status.
interface WorkflowResultsPostRequest {
  workflowRunId: WorkflowRunId;
  sessionId: SessionId;
}
interface WorkflowResultsPostResponse {
  workflowRunId: WorkflowRunId;
  posted: true;
}

// WorkflowSubscribe — workflow.subscribe. Run, step, schedule and definition notifications for the runs
// table, the Workflows tab and the canvas overlay: ONE subscription for the whole surface rather than one
// per row, which is what keeps a long table from opening a subscription per run. Its first notification is
// the scheduler hold and its waiting count as they stand, and every change to them rides it after, so a
// hold set on one device shows on another without a poll. A definition's change and a run's removal ride it
// too, so no open view keeps a row that is gone. A Notify step mints nothing here: it is one informational
// entry on the attention projection (attention-payloads.md §Plan-016 — Notifications And Attention Model).
interface WorkflowSubscribeRequest {
  sessionId?: SessionId; // omit for every run this daemon ran
  definitionId?: WorkflowDefinitionId;
}
type WorkflowSubscribeNotification =
  | { kind: "run"; run: WorkflowRunSummary }
  | { kind: "runsRemoved"; workflowRunIds: [WorkflowRunId, ...WorkflowRunId[]] }
  | { kind: "definition"; definition: WorkflowDefinitionSummary }
  | { kind: "definitionRemoved"; definitionId: WorkflowDefinitionId }
  | { kind: "step"; workflowRunId: WorkflowRunId; step: WorkflowStep }
  // A schedule armed, disarmed, or fired — and a fire the overlap policy SKIPPED, which shows on the
  // workflow's row and on that trigger's panel and is deliberately never a run.
  | {
      kind: "schedule";
      definitionId: WorkflowDefinitionId;
      nodeId: WorkflowNodeId;
      event: "armed" | "disarmed" | "fired" | "skipped";
      scheduledAt: string;
      nextFireAt?: string;
    }
  | { kind: "runsPause"; paused: boolean; waitingStartCount: number };

// WorkflowKindList — workflow.kindList. The node catalog with its param specs, so the palette, the
// inspector and an agent all read ONE list. One declarative description drives the parameter form, the
// canvas ports, the palette entry and the validation; everything that renders a node is a generic renderer
// over it.
// The request is `EmptyPayload`: it takes no members.
interface WorkflowHandleSpec<Mode extends "inputs" | "outputs"> {
  // `<mode>/<type>/<index>`, such as `outputs/main/1`: the mode is the side the spec stands on, and the
  // type is the spec's own `type`, so a handle is addressable from a stored edge without a lookup. The
  // index is a whole number from 0, with no leading zeros.
  id: `${Mode}/${"main" | "tool"}/${number}`;
  label: string;
  // `main` carries items; `tool` carries a capability.
  type: "main" | "tool";
  maxConnections?: number;
  required?: boolean;
}
// A param's declaration. The `collection` arm is the one that nests, holding a field list and optionally
// repeating; every other param is a leaf of one declared type. `showWhen` is the whole conditional-form
// engine: a param is drawn when the named sibling params hold one of the listed values.
type WorkflowParamSpec =
  | {
      id: string;
      label: string;
      type:
        | "string"
        | "text"
        | "number"
        | "boolean"
        | "select"
        | "multiselect"
        | "json"
        | "expression"
        | "path"
        | "glob"
        | "cron"
        | "secret"
        | "agent"
        | "mcp-tool"
        | "callback-tool" // one of the daemon's own callback tools, chosen from callbackTool.list
        | "session"
        | "project"; // a trigger's Repository: one of the person's projects, or None (absent)
      required?: boolean;
      // The only params a `secret://<scope>/<name>` reference resolves in: a step's Credential field, and an
      // HTTP request step's auth and headers. A node never stores a secret: the daemon resolves the
      // reference at step launch, the step record stores the reference and never the value, and a
      // reference in any other param, an expression included, is refused at save.
      sensitive?: boolean;
      default?: unknown;
      help?: string;
      options?: Array<{ value: unknown; label: string }>;
      showWhen?: Record<string, unknown[]>;
    }
  | {
      id: string;
      label: string;
      type: "collection";
      fields: WorkflowParamSpec[];
      multiple?: boolean;
    };
// The SERIALIZED form of one kind. The catalog's two computed members do not cross a wire: a kind whose
// output set derives from its params, and a kind's one-line summary of a configured node, are both
// functions of the params, and a function cannot be sent. `outputsDeriveFromParams` states that the set is
// computed so a reader knows the declared list is the base case rather than the whole truth, and the
// summary is composed by the client that holds the catalog's own code. An agent authoring a document
// reads everything below and needs neither.
interface WorkflowNodeKindSpec {
  kind: WorkflowNodeKindId;
  version: number;
  category: "trigger" | "agent" | "human" | "files" | "browser" | "developer" | "flow" | "output";
  displayName: string;
  description: string;
  icon: string;
  aliases?: string[]; // palette search only
  inputs: WorkflowHandleSpec<"inputs">[];
  outputs: WorkflowHandleSpec<"outputs">[];
  outputsDeriveFromParams: boolean;
  params: WorkflowParamSpec[];
  // True where the kind runs once per item rather than once over all of them.
  perItem?: boolean;
  capabilities?: {
    cancelable: boolean;
    resumable: boolean;
    sideEffects: "none" | "local" | "external";
  };
}
interface WorkflowKindListResponse {
  kinds: WorkflowNodeKindSpec[];
}

// WorkflowRunsPauseSet — workflow.runsPauseSet. The scheduler-wide hold on STARTING new runs. It takes no
// run id, because it is neither of the two per-run operations: one state per daemon over its whole
// scheduler. With the hold on, a run already going finishes and every new start waits — a schedule fire, a
// webhook, a file event, a chat verb, an agent's tool and a manual start alike — and turning it off
// starts what waited. The count is what the control reads, and the reply is the same pair the
// subscription's `runsPause` notification carries.
interface WorkflowRunsPauseSetRequest {
  paused: boolean;
}
interface WorkflowRunsPauseState {
  paused: boolean;
  waitingStartCount: number;
}

// WorkflowLayoutSet — workflow.layoutSet. Saves the canvas layout — node positions, the viewport and the
// sticky notes — beside the definition body without minting a version: layout sits outside the hashed
// body, so dragging a node or Tidy up changes no byte, no hash and no version, and saved versions are
// untouched.
interface WorkflowLayoutSetRequest {
  definitionId: WorkflowDefinitionId;
  layout: WorkflowLayout;
}
// WorkflowTagsSet — workflow.tagsSet. Saves the workflow's tags from the builder header's chips and
// its `Add tag` field, at once and without minting a version: tags sit outside the hashed body. The
// whole set each time, so a remove and an add are one write. A tag that breaks the tag rule, or repeats
// another ignoring case, fails the request's parse with nothing written. It answers
// `WorkflowDefinitionSettingResponse`.
interface WorkflowTagsSetRequest {
  definitionId: WorkflowDefinitionId;
  tags: string[];
}
// When a setting kept beside the definition was stored.
interface WorkflowDefinitionSettingResponse {
  definitionId: WorkflowDefinitionId;
  updatedAt: string;
}

// WorkflowPermissionLevelUpdate — workflow.permissionLevelUpdate. Sets the workflow's own permission level from
// the builder's level pill; a new workflow starts at `yolo`. Every run of the workflow uses that level
// wherever the run lives, a chat's session or the workflow's own, and a live run takes a change from
// its next step. The level sits outside the hashed body, so a change mints no version.
interface WorkflowPermissionLevelUpdateRequest {
  definitionId: WorkflowDefinitionId;
  level: PermissionLevel;
}
interface WorkflowPermissionLevelUpdateResponse {
  definitionId: WorkflowDefinitionId;
  level: PermissionLevel;
}

// WorkflowPinDataSet — workflow.pinDataSet. Pins test data onto one node, or unpins it with `items: null`,
// from the inspector's Output panel, a run's step panel, or Copy this run into the builder — without a new
// version, because pinned data sits outside the hashed body. Pinned data is honored only in manual runs and
// ignored by every trigger-started run, and a node can be pinned only where it has a single `main` output
// and its items carry no binary payload.
interface WorkflowPinDataSetRequest {
  definitionId: WorkflowDefinitionId;
  nodeId: WorkflowNodeId;
  items: WorkflowPinnedItem[] | null;
}
interface WorkflowPinDataSetResponse {
  definitionId: WorkflowDefinitionId;
  nodeId: WorkflowNodeId;
  pinned: boolean;
}

// WorkflowDraftUpdate — workflow.draftUpdate. Holds the builder's unsaved draft in the daemon, so a reload
// loses nothing and nothing is kept in window storage. The daemon holds one draft per saved workflow,
// keyed by its definition id, and one for a new workflow, which names no definition; the Builder's
// address names the workflow and carries no draft, so a reload of `#/workflows/builder/<definitionId>`
// or `#/workflows/builder` reads its own draft back. A draft of a saved workflow names the version it was
// opened from, and `basedOnVersionNumber` never appears without `definitionId`. The whole document
// replaces the one held, and it may not have its trigger yet; saving the version clears the draft.
type WorkflowDraftUpdateRequest =
  | {
      definitionId: WorkflowDefinitionId;
      basedOnVersionNumber?: number;
      document: WorkflowDraftDocument;
    }
  // The new workflow's draft names no definition, and so no version.
  | { document: WorkflowDraftDocument };
interface WorkflowDraftUpdateResponse {
  updatedAt: string;
}

// WorkflowDraftRead — workflow.draftRead. The draft read back after a reload, by the workflow the Builder's
// address names. A draft that is no longer held is an answer (`draft: null`), not a refusal.
interface WorkflowDraftReadRequest {
  definitionId?: WorkflowDefinitionId; // omit for the new workflow's draft
}
interface WorkflowDraftReadResponse {
  // What the last update sent, and when it was stored.
  draft: (WorkflowDraftUpdateRequest & { updatedAt: string }) | null;
}

// WorkflowExpressionPreview — workflow.expressionPreview. An expression's value against the current item of
// the last run that executed the node, shown live under the field. Expressions are evaluated in the daemon
// only, on the same engine a run uses, with no time limit; the engine's cooperative yielding and
// cancellation stay. The preview never resolves a secret: a sensitive field previews the secret's name,
// never its value.
interface WorkflowExpressionPreviewRequest {
  // The workflow the expression sits in, omitted for a new workflow. The daemon evaluates it in that
  // workflow's held draft, or in its latest saved version where no draft is held.
  definitionId?: WorkflowDefinitionId;
  nodeId: WorkflowNodeId;
  expression: string;
  itemIndex?: number; // the item the inspector's data panels show
}
type WorkflowExpressionPreviewResponse =
  | { ok: true; value: unknown }
  // Why it cannot resolve, in words the field shows in place of a value.
  | { ok: false; reason: string };

// WorkflowVersionDiffRead — workflow.versionDiffRead. The structural difference between two versions,
// computed in the daemon over the hashed body only, so node positions never count as a change. The
// canvas highlight and the inspector's old and new params read it, and so does an agent reading what
// changed. A changed node carries its params before and after; the trigger counts as a node.
interface WorkflowVersionDiffReadRequest {
  fromWorkflowVersionId: string;
  toWorkflowVersionId: string;
}
interface WorkflowVersionDiffReadResponse {
  nodesAdded: WorkflowNode[];
  nodesRemoved: WorkflowNode[];
  nodesChanged: Array<{ before: WorkflowNode; after: WorkflowNode }>;
  edgesAdded: WorkflowEdge[];
  edgesRemoved: WorkflowEdge[];
}

// WorkflowRunDelete — workflow.runDelete. Deletes one run's record, its steps and their data, and its
// capture folder with the run's snapshot points and their base pins; it is not undoable. A run that is
// `new`, `running` or `waiting`, a failed run parked on its failed step, and a chain's first run while
// a later run of its chain is one of those, is refused with `workflow.run_not_deletable`, which reads
// "Cancel it first.", and nothing is deleted. The write that deletes the run's rows appends `workflow.run_deleted`, so a
// rebuild of the runs from the session log leaves the run out. The removal rides workflow.subscribe.
interface WorkflowRunDeleteRequest {
  workflowRunId: WorkflowRunId;
}
interface WorkflowRunDeleteResponse {
  workflowRunId: WorkflowRunId;
  deleted: true;
}

// WorkflowRunsDeletePreview — workflow.runsDeletePreview. What "Delete runs older than…" would remove,
// counted before it runs, so its confirm names it: how many runs go, and how many older runs stay
// because they are marked Keep or are `waiting`. Its request is the one workflow.runsDelete takes: runs
// that started before the instant.
interface WorkflowRunsDeleteRequest {
  olderThan: string; // RFC 3339 UTC
}
interface WorkflowRunsDeletePreviewResponse {
  deleteCount: number;
  keptCount: number;
  waitingCount: number;
}

// WorkflowRunsDelete — workflow.runsDelete. Deletes the runs older than the instant, each as
// workflow.runDelete deletes one, with its own `workflow.run_deleted`; runs marked Keep and runs in
// `waiting` are untouched. The reply's count
// is the truth, since runs can change between the preview and the delete. It takes
// `WorkflowRunsDeleteRequest` above.
interface WorkflowRunsDeleteResponse {
  deletedCount: number;
}

// WorkflowRunKeepSet — workflow.runKeepSet. Marks a run Keep, which `workflow.runsDelete` leaves
// untouched, or clears the mark. The change rides workflow.subscribe. The request and the reply are
// one shape.
interface WorkflowRunKeepSet {
  workflowRunId: WorkflowRunId;
  keep: boolean;
}

// WorkflowFixSessionCreate — workflow.fixSessionCreate. Opens a new session on a failed step's own project
// and checkout — on a run with no project, a `None` run or a chat's run in the chat's own folder, a new
// chat — seeded with the step's name, the input it ran on, the output it failed with, and a link to
// the step's session for reading. The step's own transcript receives nothing; the run keeps a link to the
// new session for its life, and Resume then reruns the step from its original input against the fixed
// checkout. It changes nothing about the run, so it is not a run control like cancel and
// resume. A step that did not fail is refused with `workflow.invalid_transition`. Its request is the
// failed step's `WorkflowStepKey`.
interface WorkflowFixSessionCreateResponse {
  sessionId: SessionId;
}

// WorkflowHumanFormRead — workflow.humanFormRead. A waiting form as the step panel draws it: the node's
// prompt, one field per entry of its input schema in the same param declarations the inspector renders,
// the draft saved so far with its revision, and the submit revision workflow.humanFormSubmit expects
// (0 while the step has no accepted answer). Its request is the step's `WorkflowStepKey`. A form read on
// a step no longer waiting is refused with `workflow.step_not_waiting`.
interface WorkflowHumanFormReadResponse {
  prompt: string;
  fields: WorkflowParamSpec[];
  formRevision: number;
  draft?: { formState: Record<string, unknown>; revision: number; savedAt: string };
}

// WorkflowRunAttentionList — workflow.runAttentionList. The runs that need someone, which stand above the
// runs table and outside its filters. The runs waiting on a person — an approval, a form, a chat reply, a
// chain's question — come oldest first, the order Next waiting walks them in. Above them sit the runs
// parked on a spent provider account, folded into one entry per account with the count of runs it
// holds, because the entry is keyed by the account and never the run; nobody can answer those, so Next waiting never
// opens one. What it lists moves with workflow.subscribe's run notifications.
// The request is `EmptyPayload`: it takes no members.
interface WorkflowRunAttentionListResponse {
  // Every account line first, then the run lines; no account line follows a run line.
  entries: WorkflowRunAttentionEntry[];
  // How many run lines there are: the queue Next waiting walks. An account wait is never in it.
  waitingOnPersonCount: number;
}
type WorkflowRunAttentionEntry =
  | {
      kind: "run";
      workflowRunId: WorkflowRunId;
      workflowName: string;
      waitCause: Exclude<WorkflowWaitCause, "account">;
      waitingStepName: string; // the step that waits, which the entry names
      waitingSince: string;
    }
  | {
      kind: "account";
      account: WorkflowSpentAccount; // the spent account the entry groups by, named as the steps waiting on it name it
      affectedRunCount: number; // at least 1
      waitingSince: string; // the oldest of its runs
      resumeAt?: string; // where the wait armed one
    };

// WorkflowWebhookTokenRotate — workflow.webhookTokenRotate. Creates a workflow's webhook token, or replaces
// it. The token is in this reply and in no other: only its hash is kept, so a rotation makes the old token
// invalid from that moment, and while no token exists every call to the workflow's address is refused. A
// call whose token does not match the kept hash, compared in constant time, is refused with
// `workflow.webhook_token_mismatch`.
interface WorkflowWebhookTokenRotateRequest {
  definitionId: WorkflowDefinitionId;
}
interface WorkflowWebhookTokenRotateResponse {
  definitionId: WorkflowDefinitionId;
  token: string; // shown once
  createdAt: string;
}

// WorkflowWebhookListenerRead — workflow.webhookListenerRead. The daemon's loopback webhook listener: the
// one port every workflow's address uses, set in Settings, and whether it listens. It does not listen when
// the port was already held at daemon start (`port_taken`); nothing moves to another port, and every
// webhook trigger shows that reason in place of its address.
// The request is `EmptyPayload`: it takes no members.
interface WorkflowWebhookListenerReadResponse {
  port: number; // 1 to 65535
  state: "listening" | "port_taken";
}

// ---- Workflow secrets. A secret's value is sealed in the keychain, or secrets.json (ADR-036), and is
// written to no document, step record, reply, event, log or error: `secretValue` is write-only and no read
// carries it. A secret's scope is `project` or `shared`, never a session. Its name is lowercase letters,
// digits and hyphens, starting with a letter or digit, at most 64 characters, and a sensitive param
// references it as `secret://<scope>/<name>`. A name that breaks that pattern, or that its scope already
// holds, is refused with `workflow.secret_name_invalid` (`reason: "pattern" | "taken"`). A keychain that is
// locked or unavailable refuses a write with `workflow.secret_store_unavailable`
// (`cause: "locked" | "unavailable"`). At step launch a secret the keychain does not hold fails the step
// with `workflow.secret_not_found`, carrying only the reference, and a locked or unavailable keychain fails
// it with `workflow.secret_store_unavailable`; either offers Retry from this step, and neither ever falls
// back to a plaintext value. ----
type WorkflowSecretScope = "project" | "shared";
type WorkflowSecretId = string & { readonly __brand: "WorkflowSecretId" }; // a UUID the daemon mints
// A secret's place: `project` with `scopeRef`, the project record's id, or `shared` with none. A
// `project/` reference resolves in the project the run works in, so a run in no project resolves
// only shared ones.
type WorkflowSecretPlace = { scope: "project"; scopeRef: ProjectId } | { scope: "shared" };
// One secret as the chooser lists it: its place and name, and never its value.
type WorkflowSecretSummary = { secretId: WorkflowSecretId; name: string } & WorkflowSecretPlace;

// WorkflowSecretList — workflow.secretList. The secrets a step's Credential chooser offers: every
// secret, the shared ones and each project's, by name. Metadata only. A workflow belongs to no
// project, so the request is the empty payload.
interface WorkflowSecretListResponse {
  secrets: WorkflowSecretSummary[];
}

// WorkflowSecretCreate — workflow.secretCreate. Seals a new secret's value in its store, then commits
// its record, so a record never names a value its store does not hold. It answers with the new
// secret's `WorkflowSecretSummary`.
type WorkflowSecretCreateRequest = { name: string; secretValue: string } & WorkflowSecretPlace;

// WorkflowSecretReplace — workflow.secretReplace. Replaces a secret's value, sealed in its store before
// the record's change commits.
interface WorkflowSecretReplaceRequest {
  secretId: WorkflowSecretId;
  secretValue: string;
}
// The secret a replace or a delete acted on.
interface WorkflowSecretActResponse {
  secretId: WorkflowSecretId;
}

// WorkflowSecretDelete — workflow.secretDelete. Removes the record and its keychain entry, recording the
// removal first so a crash between the two still finishes it. A version that still references the name
// fails its step with `workflow.secret_not_found`.
interface WorkflowSecretDeleteRequest {
  secretId: WorkflowSecretId;
}

// WorkflowKeptVarsClear — workflow.keptVarsClear. Clears the values `Keep for later runs` kept for one
// workflow. Kept values belong to the workflow, not to a version: saving, restoring or duplicating a
// version leaves them, a duplicate starts with none, and deleting the workflow deletes them.
interface WorkflowKeptVarsClearRequest {
  definitionId: WorkflowDefinitionId;
}
interface WorkflowKeptVarsClearResponse {
  definitionId: WorkflowDefinitionId;
  clearedCount: number;
}
```
