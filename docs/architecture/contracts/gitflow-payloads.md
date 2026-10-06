# Gitflow Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-008 — Gitflow PR And Diff Attribution

```ts
// BranchContextRead — the ship facts for the folder a session works in, keyed by the session. The daemon
// maps each session to its working folder and keeps one watch and one cache per folder, shared by every
// session working there, so two sessions in one checkout read one set of facts. The read answers before
// any run, and it carries everything the change-request form opens with — the base, the head, whether the
// act pushes first (`neverLeftMachine`) and the hosting service's request word — so no separate prepare
// call exists. It is re-read after every git act, on each `git.settled`, and when the working tree changes.
interface BranchContextReadRequest {
  sessionId: SessionId;
}
interface BranchContextReadResponse {
  headBranch: string;
  baseBranch: string; // the recorded base
  defaultBranch: string;
  upstreamRef?: string;
  uncommittedFileCount: number;
  aheadOfBase: number;
  behindBase: number;
  unpushedCommitCount: number;
  neverLeftMachine: boolean; // the branch has never been pushed, so opening a change request pushes first
  pendingOperation?: { kind: "merge" | "rebase" | "bisect"; endCommand: string }; // a git operation left half-done, with the command that ends it
  changeRequests: Array<{
    number: number;
    url: string;
    state: "open" | "merged" | "closed";
    mergeable?: "mergeable" | "conflicting" | "unknown";
    reviewDecision?: "approved" | "changes_requested" | "review_required";
  }>; // newest open first
  hosting?: { serviceName: string; requestWord: "pull_request" | "merge_request" }; // absent where no hosting service answers for the remote
}

// DiffRead — Review's diff. A pane read that is retried and re-read, so it mints nothing and stores
// nothing. Three scopes — the working changes against the last commit, untracked files included; the
// branch against a base (absent: the daemon's default base), narrowable to one of its commits; and one
// of the branch's change requests — plus a `workflow_run` arm that diffs two snapshot points of one
// workflow run, read from that run's own capture folder with the repository's objects as an alternate.
// One entry per path, composed into a single patch however many edits touched it; an untracked file
// the repository does not ignore reads as added. The reply is always the whole diff: the daemon never
// cuts a patch at a size.
type WorkflowRunSnapshotPoint =
  | { epoch: number; point: "start" }
  | { epoch: number; point: "pause"; pauseNumber: number } // an approval pause, counted from 1; epoch counted from 0
  | { epoch: number; point: "end" }; // each re-execution of the run opens the next epoch
type DiffReadRequest =
  | { sessionId: SessionId; scope: "changes" }
  | { sessionId: SessionId; scope: "branch"; base?: string; commitId?: string } // commitId narrows to one commit
  | { sessionId: SessionId; scope: "change_request"; changeRequestNumber: number }
  | {
      sessionId: SessionId;
      scope: "workflow_run";
      workflowRunId: WorkflowRunId;
      from: WorkflowRunSnapshotPoint;
      to: WorkflowRunSnapshotPoint;
    };
interface DiffReadResponse {
  head: string;
  base: string;
  files: Array<{
    path: string;
    oldPath?: string; // present exactly on a rename
    kind: "added" | "deleted" | "renamed" | "modified"; // a copy reads `added`
    modeChanged?: boolean;
    binary?: boolean;
    // why the lines are not shown; size never is
    unreadable?: "permission_denied" | "not_regular_file";
    additions: number;
    deletions: number;
    patch?: string; // the file's unified patch; absent for a binary file or one that could not be read
    // git's blob id for each side, as `git diff --full-index` gives it (the working file's hash on the
    // working side); a gap read and a held note's comparison key on it. Absent on the side where the file
    // does not exist.
    oldBlobId?: string;
    newBlobId?: string;
    newestTurn?: number; // the latest turn that changed the file; absent for a change made outside a turn
    // on the workflow_run arm only: the step that changed the file, its node id and the name it shows,
    // per file and never per line
    step?: { nodeId: WorkflowNodeId; nodeName: string };
  }>;
  // The branch scope's commits; `agent` names the agent whose run made a commit, read from its run
  // trailer, and a commit without one is the person's.
  commits?: Array<{
    commitId: string;
    shortId: string;
    subject: string;
    landedAt: string;
    agent?: { agentId: string; name: string };
  }>;
}

// The four ship acts. The preview and the act are built by the same daemon code, so the
// commands shown before the press are the commands that run.
type GitAct = "commit" | "push" | "pull" | "open_change_request";
interface GitActFormValues {
  commit?: { subject: string; body?: string };
  changeRequest?: {
    base: string;
    title: string;
    description: string;
    draft: boolean;
    reviewers: string[];
    labels: string[];
  };
}

// GitActionPreview — the exact commands an act will run, shown before the press.
interface GitActionPreviewRequest {
  sessionId: SessionId;
  act: GitAct;
  formValues: GitActFormValues;
}
interface GitActionPreviewResponse {
  commands: string[];
}

// GitActionExecute — runs one ship act in the session's working folder under the person's own git and
// hosting identity, with no amend and no force push. A failed command is a failed step on the act's
// progress stream, not an error reply, and `retryFromCommand` resumes at the command that failed.
interface GitActionExecuteRequest {
  sessionId: SessionId;
  action: GitAct;
  formValues: GitActFormValues;
  retryFromCommand?: number; // the index of the command to resume at
}
interface GitActionExecuteResponse {
  actId: string;
  commands: string[];
}

// GitActionSubscribe — the per-command progress of one running act, caught up, then followed. The durable
// record is `git.settled`; this stream lives only as long as the act.
interface GitActionSubscribeRequest {
  actId: string;
}
interface GitActionProgress {
  commands: Array<{
    index: number;
    text: string;
    state: "pending" | "running" | "done" | "failed";
    output?: string;
  }>;
  settled: boolean; // true once the act has ended
}

// CommitMessageGenerate / ChangeRequestTextGenerate — one throwaway turn on the session's provider
// and account that carries no conversation, runs read-only and outside the repository with thinking
// off, and reads the whole working folder's diff, the branch and recent commit subjects. A failure
// is refused under the code this contract registers for it (error-contracts.md §Gitflow), carrying
// the provider's own words, and never falls back to the other provider.
interface CommitMessageGenerateRequest {
  sessionId: SessionId;
}
interface CommitMessageGenerateResponse {
  subject: string;
  body: string;
}
interface ChangeRequestTextGenerateRequest {
  sessionId: SessionId;
}
interface ChangeRequestTextGenerateResponse {
  title: string;
  description: string;
}

// ChangeRequestSubscribe — the session's change requests, live. `summary` (state, can-merge, review
// decision) feeds the header's request word; `full` adds the description, the reviews and requested
// reviewers, the threads and the checks, for Review. While a subscriber holds it, the daemon sends
// the hosting service a conditional request every 60 s (an unchanged answer costs no quota); a
// `full` subscriber, the pull-request tab in view, re-reads every 60 s while the request is open
// and every five minutes once it is merged or closed. It refreshes at once after the person's own
// git and change-request acts; with no subscriber nothing asks the host. A failed read keeps the
// last state and says when the read failed, rather than ending the stream, and the next read waits
// as [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) D-008-10 sets out.
interface ChangeRequestSubscribeRequest {
  sessionId: SessionId;
  depth: "summary" | "full";
}
interface ChangeRequestUpdate {
  requests: Array<{
    number: number;
    url: string;
    state: "open" | "merged" | "closed";
    isDraft: boolean;
    mergeable?: "mergeable" | "conflicting" | "unknown";
    reviewDecision?: "approved" | "changes_requested" | "review_required";
    headCommitId: string;
    // Present at `full` depth only.
    author?: string;
    description?: string;
    reviews?: Array<{ reviewer: string; verdict: "comment" | "approve" | "request_changes" }>;
    requestedReviewers?: string[];
    threads?: Array<{
      threadId: string; // the hosting service's own thread handle, carried verbatim
      path?: string;
      line?: number;
      side?: "added" | "removed";
      state: "open" | "resolved" | "outdated";
      author: string;
      replies: Array<{ author: string; body: string }>;
    }>;
    checks?: Array<{
      checkId: string;
      name: string;
      status: "pending" | "success" | "failure";
      runUrl: string;
    }>;
  }>;
  readAt: string;
  lastReadFailedAt?: string;
}

// ReviewerList / LabelList — the candidates the change-request form offers.
interface ReviewerListRequest {
  sessionId: SessionId;
  query?: string;
}
interface ReviewerListResponse {
  reviewers: Array<{ login: string; name?: string }>;
}
interface LabelListRequest {
  sessionId: SessionId;
}
interface LabelListResponse {
  labels: Array<{ name: string; description?: string }>;
}

// ReviewSubmit — posts the session's held notes that are not stranded as ONE review carrying one
// verdict. The wire carries no note text: the notes come from the held-note store. A review can land
// PARTLY, and the reply says so per note: the notes that posted are recorded as sent and never offered
// again, the ones behind a failure stay held, and a second press posts only what is still held. A
// stranded note is never submitted and never appears in the reply.
interface ReviewSubmitRequest {
  sessionId: SessionId;
  changeRequestNumber: number;
  verdict: "comment" | "approve" | "request_changes";
  body?: string;
}
interface ReviewSubmitResponse {
  reviewUrl?: string; // absent when no review was created because every comment failed
  postedNoteIds: string[];
  failures: Array<{ noteId: string; reason: string }>; // `reason` is the hosting service's own words
}

// ThreadResolve / ThreadReply — act on one hosting thread. Resolving a thread already resolved succeeds.
interface ThreadResolveRequest {
  sessionId: SessionId;
  changeRequestNumber: number;
  threadId: string;
}
interface ThreadResolveResponse {
  threadId: string;
  state: "resolved";
}
interface ThreadReplyRequest {
  sessionId: SessionId;
  changeRequestNumber: number;
  threadId: string;
  body: string;
}
interface ThreadReplyResponse {
  commentId: string;
  url: string;
}

// CheckLogRead — the tail of a failing check's raw log; how much of the tail is read comes from the
// machine, and the log is shown as text.
interface CheckLogReadRequest {
  sessionId: SessionId;
  changeRequestNumber: number;
  checkId: string;
}
interface CheckLogReadResponse {
  text: string;
  truncated: boolean;
  totalBytes: number;
  runUrl: string;
}

// Self-hosted git hosts. A host is one name with no kind to pick: the service asks each installed tool,
// `gh` and `glab`, whether it answers for the host signed in, and keeps the kind of the one that does. A
// name that does not parse, and a host neither tool answers for, are refused in place and nothing is saved.
interface GitHost {
  host: string;
  kind: "github" | "gitlab";
}
interface GitHostListRequest {}
interface GitHostListResponse {
  hosts: GitHost[];
}
interface GitHostAddRequest {
  host: string;
}
interface GitHostAddResponse {
  host: GitHost;
}
interface GitHostRemoveRequest {
  host: string;
}
interface GitHostRemoveResponse {
  host: string;
}

// The held-note store's shapes (the `session.reviewNote*` verbs below). A note records the
// comparison it was written against, which is what a press on the note walks back to.
interface ReviewNoteComparison {
  scope: "changes" | "branch" | "change_request";
  base: string;
  headCommitId?: string; // exactly one of headCommitId and workingTreeBlobId
  workingTreeBlobId?: string;
  requestNumber?: number;
}
interface ReviewNote {
  noteId: string;
  comparison: ReviewNoteComparison;
  path: string;
  oldPath?: string; // a note on a renamed file
  side: "added" | "removed";
  line: number;
  startLine?: number; // a note on a range of lines
  quote: string; // the one-line quote of the line
  body: string;
  stranded: boolean; // the line no longer exists in the diff the note points into
  // `sent` once a posted review carried it: drawn `sent` and never offered again, so a second press
  // after a part-way failure posts only what is still `held`.
  state: "held" | "sent";
}
interface ReviewNoteAddRequest {
  sessionId: SessionId;
  noteId: string; // minted by the client, so a retried add makes one note
  comparison: ReviewNoteComparison;
  path: string;
  oldPath?: string;
  side: "added" | "removed";
  line: number;
  startLine?: number;
  body: string;
}
interface ReviewNoteAddResponse {
  note: ReviewNote;
}
interface ReviewNoteUpdateRequest {
  sessionId: SessionId;
  noteId: string;
  body: string;
}
interface ReviewNoteUpdateResponse {
  note: ReviewNote;
}
interface ReviewNoteRemoveRequest {
  sessionId: SessionId;
  noteIds: string[]; // one press discards every note behind one question, and a steer clears every note
}
interface ReviewNoteRemoveResponse {
  removedNoteIds: string[];
}
interface ReviewNoteListRequest {
  sessionId: SessionId;
}
interface ReviewNoteListUpdate {
  notes: ReviewNote[]; // caught up, then followed; `stranded` recomputed against each note's comparison
}
// git.settled payload (Spec-005 §Artifact and Diff Publication). ONE record for the five git acts
// the transcript records — committing, pushing, pulling, opening a change request and posting a
// review — so those system messages survive a reload. Each `cause` carries exactly the reference
// its system message names: the commit's identifier for `committed`, the branch for `pushed`, the
// branch and the commit it landed on for `pulled`, the request's number plus its address on the
// hosting service for `pull_request_opened`, and the request's number plus the verdict for
// `review_posted`. `runId` is present only on a `committed` record whose commit an agent made as an
// ordinary tool call (read from its run trailer); a push, and every act the person pressed, carries
// none.
interface GitSettledPayload {
  sessionId: SessionId;
  runId?: RunId;
  cause: "committed" | "pushed" | "pulled" | "pull_request_opened" | "review_posted";
  commitId?: string;
  branch?: string;
  requestNumber?: number;
  requestUrl?: string;
  verdict?: "comment" | "approve" | "request_changes";
}
```

Plan-008's git flow is exposed as the `gitflow.*` methods below. Method-name strings are `dotted-camelCase` per `METHOD_NAME_FORMAT`, defined in local-ipc-payloads.md §Plan-005-Partial — Local IPC Daemon Control — the `gitflow` namespace token is the gitflow domain noun (the Plan-008-owned `runtime-daemon/src/gitflow/` daemon module, D-008-3; consumed client-side by the `gitflowClient` SDK, [Plan-008 §Target Areas](../../plans/008-gitflow-pr-and-diff-attribution.md#target-areas)). The PascalCase request/response type symbols (such as `GitActionExecute`) are **rejected** as method strings by that regex — it reserves PascalCase for the project's TypeScript type-name convention — so each wire name differs from its payload type symbol. Names register under the Plan-005-partial daemon `MethodRegistry` per the §5 substrate-vs-namespace carve-out. These methods ride the **daemon JSON-RPC transport only** — the ship facts, the diff and the held notes are this machine's git and daemon state, and the hosting service is reached from the daemon under the person's own signed-in identity, so no control-plane tRPC sibling exists. Every session-scoped method is keyed by the session, and the daemon resolves the session's working folder itself.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `gitflow.branchContextRead` | `query` | `BranchContextReadRequest` | `BranchContextReadResponse` |
| `gitflow.diffRead` | `query` | `DiffReadRequest` | `DiffReadResponse` |
| `gitflow.gitActionPreview` | `query` | `GitActionPreviewRequest` | `GitActionPreviewResponse` |
| `gitflow.gitActionExecute` | `mutation` | `GitActionExecuteRequest` | `GitActionExecuteResponse` |
| `gitflow.gitActionSubscribe` | `subscription` | `GitActionSubscribeRequest` | `GitActionProgress` (stream) |
| `gitflow.commitMessageGenerate` | `mutation` | `CommitMessageGenerateRequest` | `CommitMessageGenerateResponse` |
| `gitflow.changeRequestTextGenerate` | `mutation` | `ChangeRequestTextGenerateRequest` | `ChangeRequestTextGenerateResponse` |
| `gitflow.changeRequestSubscribe` | `subscription` | `ChangeRequestSubscribeRequest` | `ChangeRequestUpdate` (stream) |
| `gitflow.reviewerList` | `query` | `ReviewerListRequest` | `ReviewerListResponse` |
| `gitflow.labelList` | `query` | `LabelListRequest` | `LabelListResponse` |
| `gitflow.reviewSubmit` | `mutation` | `ReviewSubmitRequest` | `ReviewSubmitResponse` |
| `gitflow.threadResolve` | `mutation` | `ThreadResolveRequest` | `ThreadResolveResponse` |
| `gitflow.threadReply` | `mutation` | `ThreadReplyRequest` | `ThreadReplyResponse` |
| `gitflow.checkLogRead` | `query` | `CheckLogReadRequest` | `CheckLogReadResponse` |
| `gitflow.hostList` | `query` | `GitHostListRequest` | `GitHostListResponse` |
| `gitflow.hostAdd` | `mutation` | `GitHostAddRequest` | `GitHostAddResponse` |
| `gitflow.hostRemove` | `mutation` | `GitHostRemoveRequest` | `GitHostRemoveResponse` |

**One git-settlement record, whose cause names the act.** Committing, pushing, pulling, opening a change request and posting a review each settle into ONE durable record — `git.settled`, whose `cause` is one of `committed | pushed | pulled | pull_request_opened | review_posted` and names which of the five it was — so those system messages survive a reload and the transcript says what left this machine and what came into it. The name and the taxonomy census are [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md)'s; what is fixed here is that one record carries all five acts. A review posted with the comment verdict alone reads as a comment on the request. The record is what the flow renders; it is not a second copy of the hosting state, which `gitflow.changeRequestSubscribe` keeps on its own. A result that arrives after the form it came from has closed, or after the pane has been pointed at another session, updates nothing on screen — and the record still lands, because the act happened.

**The held-note store and its verbs.** A review note is a DRAFT the daemon holds, scoped to the session, in the same session-scoped store as the composer draft and its staged files, so a half-written review reaches the person's other devices; typed unsent text is never written to renderer-local storage. `session.reviewNoteAdd` adds a note located at a file and a line — its path (the old path on a renamed file), its side, its line or range of lines — with its own words and the `comparison` it was written against, which is what a press on the note walks back to; `session.reviewNoteUpdate` edits a held note's words; `session.reviewNoteRemove` takes `noteIds`, an array, because one press discards every note behind one question and a steer clears every note at once; and `session.reviewNoteList` is the session's notes, live. A note leaves in exactly one of three ways — composed into the composer draft as a steer, posted as part of one review through `gitflow.reviewSubmit`, or discarded — and nothing else. The daemon checks each held note against the diff it points into and marks a note whose line no longer exists as stranded: it stays readable, editable and deletable, and is left out of a posted review, as is a note on uncommitted lines. Once a note is posted it stops being a held note and becomes a hosting thread, which takes `gitflow.threadReply` and `gitflow.threadResolve` and never the note's edit and delete. What is fixed here is the store — session-scoped, daemon-held, one home per note — and the `noteId` that `gitflow.reviewSubmit`'s result and the adapter's `submitReview` address a note by.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `session.reviewNoteAdd` | `mutation` | `ReviewNoteAddRequest` | `ReviewNoteAddResponse` |
| `session.reviewNoteUpdate` | `mutation` | `ReviewNoteUpdateRequest` | `ReviewNoteUpdateResponse` |
| `session.reviewNoteRemove` | `mutation` | `ReviewNoteRemoveRequest` | `ReviewNoteRemoveResponse` |
| `session.reviewNoteList` | `subscription` | `ReviewNoteListRequest` | `ReviewNoteListUpdate` (stream) |

The reads are `query`s, the live feeds `subscription`s and every other verb a `mutation`, per the tRPC procedure-type convention in remote-control-payloads.md §Plan-025 — Remote Control Bootstrap. The daemon answers these verbs through its own hosting adapter, one per hosting kind, GitHub through the `gh` command-line tool and GitLab through `glab`, each under the person's own signed-in identity. The adapter is daemon-internal, in the daemon's gitflow module (`packages/runtime-daemon/src/gitflow/`), and is not part of this contract; its operations are stated in [Spec-009 §GitHostingAdapter Interface](../../specs/009-gitflow-pr-and-diff-attribution.md#githostingadapter-interface), and every reply a client reads is the verb's own shape above. Canonical Zod schemas live in `packages/contracts/src/gitflow/` per the api-payload-contracts.md §Source-of-Truth Policy.
