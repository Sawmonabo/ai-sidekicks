# Workflow Document Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

```ts
// ---- The node-graph document: what an author writes and what a version stores ----
// Type names here are prefixed `Workflow` where the unprefixed name is already taken by another
// domain in this file — `NodeId` is the runtime-node brand and `RunId` the provider-run brand, so a
// workflow node and a workflow run carry their own brands and no reader has to guess which domain a
// bare `NodeId` belongs to.

type WorkflowNodeId = string & { readonly __brand: "WorkflowNodeId" };
// A kind key, dotted and readable: the family, then the kind within it. It is data rather than a
// closed union, because the catalog is enumerated by `workflow.kindList` in workflow-builder-and-runs-payloads.md and a kind ships with
// its own spec and executor — a union here would have to be widened for every kind that lands.
type WorkflowNodeKindId = string;

// ONE JSON document, whose canonical bytes are its hashed field list (`name`, `description`,
// `trigger`, `nodes`, `edges`) canonicalized and hashed.
// Three members sit OUTSIDE the hashed body and therefore change no content hash: `layout`, which
// is canvas geometry, `pinData`, which is sample data an author pinned onto a node, and `tags`, the
// labels the Workflows tab shows and filters on. That is why moving a node on
// the canvas, pinning data to try a branch, or tagging a workflow mints no version.
interface WorkflowDocument {
  schemaVersion: "2";
  name: string;
  description?: string;
  // Exactly one, and it is a node of the trigger family. A workflow with no trigger that can arm cannot
  // be enabled, which `workflow.enabledSet` in workflow-builder-and-runs-payloads.md refuses rather than accepting silently.
  trigger: WorkflowTriggerNode;
  // Every node except the trigger. A node id names one node: no two nodes, the trigger included,
  // share one, and a parse refuses each repeat with an issue at that id whose `params` is the finding
  // `{ rule: "node_id_duplicate", nodeIds: [id] }`.
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  layout?: WorkflowLayout;
  pinData?: Record<string, WorkflowPinnedItem[]>; // by node id
  // `TagListSchema` (packages/contracts/src/tag.ts): each tag nested with `/`, never empty, with no
  // whitespace, no empty level around a `/` and no longer than a session name, and each held once
  // ignoring case. Set beside the
  // workflow's name in the builder header (`workflow.tagsSet`) or by an agent through the workflow
  // authoring call.
  tags?: string[];
}

// The builder's unsaved document. It may not have its trigger yet: the builder opens on the trigger
// picker, and a draft saved before one is placed still survives a reload. Its node ids are unique
// as a saved document's are, the trigger's included where it has one.
type WorkflowDraftDocument = Omit<WorkflowDocument, "trigger"> & { trigger?: WorkflowTriggerNode };

// The trigger node, which alone declares the inputs a run starts with: each named and typed, carrying
// the value it starts on, and marked required where a start must fill it. The Run now panel draws one
// field per input (a checkbox for a boolean, a list for a select, a folder picker for a path, a box
// otherwise), and `workflow.runStart`'s `input` carries what was filled in. A start fills inputs by
// name, so no two of a trigger's inputs share one.
interface WorkflowTriggerNode extends WorkflowNode {
  inputs?: WorkflowTriggerInput[];
}
type WorkflowTriggerInput = { name: string; required?: boolean } & (
  | { type: "boolean"; default: boolean }
  | { type: "string"; default: string }
  | { type: "path"; default: string }
  | { type: "select"; default: string; options: [string, ...string[]] } // default is one of them
);

interface WorkflowNode {
  id: WorkflowNodeId;
  kind: WorkflowNodeKindId;
  // Written once at insert and NEVER migrated in place: a kind ships side-by-side implementations and
  // the loader resolves the exact one the document names, so a saved workflow never needs a migration
  // pass to keep opening.
  kindVersion: number;
  name: string; // display label only; expressions address a node through its id, so a rename is metadata
  order: number; // sibling branch order, never geometry
  // By the ids the kind's param specs list. A secret is a `secret://shared/<name>` or
  // `secret://project/<name>` reference and stands only in a param the kind marks `sensitive`,
  // where a value starting `secret://` must be a whole reference; a `secret://` value in any
  // other param is refused at save (`secret_outside_sensitive_field`), and so is an expression
  // naming one. A `secret` param holds the reference alone.
  params: Record<string, unknown>;
  disabled?: boolean;
  notes?: string;
  // What a failure does is set ON THE NODE THAT FAILED, not in a document-wide settings block. The third
  // value materializes a real error output handle the failed items route to.
  onError?: "stop" | "continue" | "continue-error-output";
  retry?: { maxTries: number; waitMs: number }; // clamped engine-side
  executeOnce?: boolean;
  alwaysOutputData?: boolean;
}

// An edge names the two handles it joins, not just the two nodes: a node may carry several handles of
// each direction, and a connection that named only the nodes could not say which port it entered.
interface WorkflowEdge {
  id: string;
  source: WorkflowNodeId;
  sourceHandle: string;
  target: WorkflowNodeId;
  targetHandle: string;
}

// Canvas geometry, outside the hashed body but part of the document and persisted beside its body, so
// an exported or agent-authored workflow carries its picture. A document opened with NO layout is laid
// out deterministically, so it is never unopenable and opens the same way twice.
interface WorkflowLayout {
  nodes: Record<string, { x: number; y: number }>;
  viewport?: { x: number; y: number; zoom: number };
  notes?: Array<{ id: string; text: string; x: number; y: number; width: number; height: number }>;
}

// Data between nodes is ALWAYS an array of items, never a bare value: a node runs once over all the
// items of its input, or once per item where its kind declares that, and returns one array per output
// handle — an empty array meaning that branch is dead. Bytes never travel inside a run record: a binary
// value is an artifact reference plus its media type, name and size.
interface WorkflowItem {
  json: unknown;
  binary?: Record<
    string,
    { artifactId: ArtifactId; mimeType: string; fileName: string; size: number }
  >;
  // Lineage: which input item this output came from, so an expression can walk back across a branch and
  // a merge. The engine fills it for one-to-one, one-to-many and equal-count transforms and for the empty
  // item an always-output node emits; a kind that genuinely mints or collapses items sets it itself. A
  // missing or ambiguous lineage is a TYPED error shown in the inspector, never a thrown stack.
  pairedItem?: { item: number; input?: number } | Array<{ item: number; input?: number }>;
  error?: WorkflowStepError;
}

// An item pinned onto a node as test data. It carries no binary value, because a node whose items carry
// one cannot be pinned.
type WorkflowPinnedItem = Omit<WorkflowItem, "binary">;

interface WorkflowStepError {
  message: string;
  // The node the failure belongs to. A per-item error rides the item itself, so one item can fail while
  // the rest of a batch succeeds.
  nodeId?: WorkflowNodeId;
  // The input item the step failed on: the same zero-based index an expression reads as `$itemIndex`,
  // drawn as it stands (`Item 1` for 1) beside the error's first line on the failed node.
  itemIndex?: number;
  // The step failure's own code where one names it (a timed-out step, a sandbox that did not start, a
  // Code step over its budget …), in the `workflow.<condition>` form, with that code's details. A step
  // whose agent could not resolve (its park on an account a removal took first) carries
  // `agent.resolution_refused`, its details that refusal's own, `reason` among them. A failure with no
  // code of its own carries the message alone, and `details` never appears without `code`.
  code?: string;
  details?: Record<string, unknown>;
}

// A reference to a step payload the run record does not inline. Under the inline bound — 64 KiB of its
// JSON encoding — the payload is carried as items; above it the payload is an artifact, and the panel
// that renders it says which — a reader must never be left guessing whether it is seeing the whole
// thing. An artifact names how many items it holds, so a count is drawn without reading it. Step data
// is kept until the person deletes the run or its session.
type WorkflowPayloadRef =
  | { kind: "inline"; items: WorkflowItem[] }
  | { kind: "artifact"; artifactId: ArtifactId; sizeBytes: number; itemCount: number };

// Run statuses are the list below, and nothing else is displayed. `waiting` is never swept to `crashed` on
// a daemon start and is never pruned, so a run parked on a person survives a restart and rehydrates.
type WorkflowRunStatus =
  | "new"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "canceled"
  | "crashed";
// What a `waiting` step waits on: an approval, a form or a chat reply when it waits on a person,
// `chain` when an Execute workflow step's child is held behind its chain's question, and `account`
// when it is parked on a spent provider account. A run's step, its runs-table row and the attention
// read all use this one list.
type WorkflowWaitCause = "approval" | "form" | "reply" | "chain" | "account";
// How the run was started, which is a different question from who started it.
type WorkflowRunMode =
  | "manual"
  | "trigger"
  | "webhook"
  | "chat"
  | "agent"
  | "retry"
  | "sub-workflow";
// The kind of trigger node that started the run, which the runs table's trigger column and filter
// read. A retry keeps its source run's kind. The mode cannot carry it, because `trigger` covers a
// schedule, a file event, a session event and another workflow failing alike.
type WorkflowTriggerKind =
  | "trigger.manual"
  | "trigger.schedule"
  | "trigger.file-watch"
  | "trigger.webhook"
  | "trigger.session-event"
  | "trigger.chat"
  | "trigger.sub-workflow"
  | "trigger.error";
// Who or what started it, as the run row renders it. A person's start records the device of the
// connection that made it, never a person.
type WorkflowStartedBy =
  | { kind: "user"; deviceId: DeviceId }
  | { kind: "schedule" }
  | { kind: "chat"; sessionId: SessionId; messageAnchorCursor?: EventCursor }
  | { kind: "agent"; agentId: AgentId }
  | { kind: "webhook" }
  | { kind: "fileEvent" }
  | { kind: "parentWorkflow"; parentWorkflowRunId: WorkflowRunId };

// A spent provider account as a wait names it: its id, its provider and the label `accountLabel`
// gives it, the one every surface names an account by, so no account id reaches the screen: a
// pasted-token or API-key account's typed name beside its credential's kind, else the identity its
// provider reports.
interface WorkflowSpentAccount {
  providerAccountId: ProviderAccountId;
  provider: "claude" | "codex";
  // Sized for the longest full reported identity — the email, plan and organization caps with the
  // two ` · ` separators (`PROVIDER_ACCOUNT_LABEL_MAX_LEN`) — not for a typed name alone.
  label: string;
}

// What a step or a run cost, in whole micro-dollars, and the account that paid. Present only where a
// provider was billed; a step that spent nothing carries none, and reads `$0.00` with no account.
interface WorkflowCost {
  usdMicros: number;
  providerAccountId: ProviderAccountId;
}

// One execution of one node. `executionIndex` is per-run monotonic and gives a faithful "what happened
// when" list for a branching run, independent of graph shape; `source` records the edge that ACTUALLY fed
// each input and which run of the source produced it, which is what lets a run page say that this run of
// a merge consumed the third run of a loop. A null entry marks an input slot nothing fed.
interface WorkflowStep {
  workflowRunId: WorkflowRunId;
  nodeId: WorkflowNodeId;
  attempt: number;
  executionIndex: number;
  source: Array<{ nodeId: WorkflowNodeId; outputIndex: number; executionIndex: number } | null>;
  // The step status list, the values of Spec-015 §Execution semantics. `waiting` is a step waiting on a person, a chain's question or a spent
  // provider account; `waiting-memory` is a step the engine's memory gate holds before it starts, which
  // starts itself when memory frees up and is never a blocker that needs a person; `canceled` is a step
  // that was running or waiting when its run ended failed or canceled, or a branch a first-to-arrive
  // merge stopped.
  status:
    | "pending"
    | "running"
    | "waiting"
    | "waiting-memory"
    | "succeeded"
    | "failed"
    | "skipped"
    | "canceled";
  // Present exactly on a `waiting` step: what it waits on. The status list is not widened for a wait: a
  // step parked on a spent provider account reads `waiting` with cause `account`.
  waitCause?: WorkflowWaitCause;
  // Present exactly on a step waiting on `account`: the spent account, which the run header names,
  // `The Claude Code account <label> is spent…`.
  waitAccount?: WorkflowSpentAccount;
  // Only on a `waiting` step, and only where the wait armed one: the instant it resumes itself. Where
  // none is armed, no instant is invented.
  resumeAt?: string; // RFC 3339 UTC
  // Only on a `waiting` step that waits on a person and whose node sets a `Timeout`: the instant the wait
  // gives up. An answer after it is refused with `workflow.step_not_waiting`, and at it the step fails
  // with `workflow.step_timed_out` and its node's `onError` decides what follows.
  waitDeadlineAt?: string; // RFC 3339 UTC
  // Present exactly on a step waiting on `reply`: the question it asked. `questionId` is the record
  // `question.resolve` answers and `waitId` the wait it settles — the same record the session's question
  // card answers — so the step panel and the card are two doors onto one wait and the first answer
  // through either settles both.
  question?: { questionId: QuestionId; waitId: string; prompt: string };
  // Present once a person has answered this step, and never on a waiting step: how they answered and
  // when, so the receipt it earns, `Approved at 2:14 PM`, reads the same after a reload. `declined` is
  // the `Decline` on a command step's own approval card, which fails that step.
  resolution?: { kind: "approved" | "rejected" | "answered" | "declined"; at: string };
  // Present on an approval step of a run that captured its checkout: the pause's snapshot. Pinned, it
  // names which execution of the run (each re-execution opens the next epoch) and which of its
  // approval pauses, counted from 1, and `Open in Review` on the step compares that pause to its
  // epoch's start. Missing, it carries why the snapshot could not be taken, and the door stays in
  // place saying so.
  reviewPause?:
    | { state: "pinned"; epoch: number; pauseNumber: number }
    | { state: "missing"; reason: string };
  // Present on an Execute workflow step: the child run it started, which the step panel links to.
  childWorkflowRunId?: WorkflowRunId;
  startedAt: string;
  finishedAt?: string;
  // The three refs a step panel reads. They are refs and not payloads, so a run read stays bounded
  // whatever the step produced.
  inputRef: WorkflowPayloadRef;
  outputRef: WorkflowPayloadRef;
  logRef: WorkflowPayloadRef;
  cost?: WorkflowCost;
  error?: WorkflowStepError;
  // Present only on a `failed` step whose process ended on its own — a command, a full-tier Code
  // step, Git, Run tests: exactly one of the exit code and the signal, and the last lines it printed,
  // which the step panel's Error tab reads. The same shape as `run.failed`'s `processExit`.
  processExit?:
    | { exitCode: number; signal?: never; outputTail: string }
    | { signal: string; exitCode?: never; outputTail: string };
  // Non-fatal hints the step attached — an unwired branch that dropped items, a deprecated param, a
  // truncated output. They render as a strip in the output panel and are never errors.
  advisories?: string[];
  // Present exactly where this step ran an agent under a saved definition: every field as actually
  // applied, including the binding the daemon resolved for it (agent-definition-payloads.md §Plan-024). It rides the step's own record
  // rather than the run read, because the node's axes are changeable for that one use and the record is
  // what a step panel reads to say what actually ran.
  resolvedConfiguration?: AgentResolvedConfiguration;
}

// The value of a node's `tool` param: a reference, and only a reference. Carries NO `enabled`,
// `approvalMode`, or `idempotencyClass` facet — a tool's approval lives only in Settings › MCP
// servers (Spec-024 §Tool-Level Overrides), resolved live at step launch through the Spec-004
// tool-metadata layer. A definition carrying one is refused as an ordinary parse error naming
// the field (Workflow Graph Model §Tool bindings are references, never inline policy (SA-31)).
// Identity COMPOSES the Plan-022-owned `McpServerBindingRef` discriminated union declared
// in mcp-governance-payloads.md §Plan-022 rather than restating its members: Plan-014 consumes that identity and
// authors none of it (CP-014-6), and re-declaring it flat would drop the scope rules the union
// enforces at the schema layer (`scopeRef` forbidden for `user`, required for `project` and `local`).
// That `scopeRef` is Spec-024's config scope.
interface WorkflowToolBinding {
  binding: McpServerBindingRef;
  toolName: string;
}
```
