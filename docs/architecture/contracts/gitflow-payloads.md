# Gitflow Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-008 — Gitflow PR And Diff Attribution

```ts
// GitBranchContextRead — the ship facts for the folder a session works in, keyed by the session.
// The daemon maps each session to its working folder and keeps one watch and one cache per folder,
// shared by every session working there, so two sessions in one checkout read one set of facts. The
// read answers before any run, and it carries everything the change-request form opens with — the
// base, the head, whether the act pushes first (`neverLeftMachine`) and the hosting service's
// request word — so no separate prepare call exists. It is re-read after every git act, on each
// `git.settled`, and when the working tree changes. The request of git.branchContext.read,
// git.commitMessage.generate, git.changeRequest.text.generate and git.label.list: the session.
interface GitSessionRequest {
  sessionId: SessionId;
}
interface GitBranchContextReadResponse {
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
    reviewDecision?: "approved" | "changesRequested" | "reviewRequired";
  }>; // newest open first
  hosting?: { serviceName: string; requestWord: "pullRequest" | "mergeRequest" }; // absent where no hosting service answers for the remote
}

// GitDiffRead — Review's diff. A pane read that is retried and re-read, so it mints nothing and
// stores nothing. Three scopes — the working changes against the last commit, untracked files
// included; the branch against a base (absent: the daemon's default base), narrowable to one of its
// commits; and one of the branch's change requests — plus a `workflowRun` arm that diffs two
// snapshot points of one workflow run, read from that run's own capture folder with the
// repository's objects as an alternate. One entry per path, composed into a single patch however
// many edits touched it; an untracked file the repository does not ignore reads as added. The reply
// is always the whole diff: the daemon never cuts a patch at a size.
type WorkflowRunSnapshotPoint =
  | { epoch: number; point: "start" }
  | { epoch: number; point: "pause"; pauseNumber: number } // an approval pause, counted from 1; epoch counted from 0
  | { epoch: number; point: "end" }; // each re-execution of the run opens the next epoch
type GitDiffReadRequest =
  | { sessionId: SessionId; scope: "changes" }
  | { sessionId: SessionId; scope: "branch"; base?: string; commitId?: string } // commitId narrows to one commit
  | { sessionId: SessionId; scope: "changeRequest"; changeRequestNumber: number }
  | {
      sessionId: SessionId;
      scope: "workflowRun";
      workflowRunId: WorkflowRunId;
      from: WorkflowRunSnapshotPoint;
      to: WorkflowRunSnapshotPoint;
    };
interface GitDiffReadResponse {
  head: string;
  base: string;
  files: Array<{
    path: string;
    oldPath?: string; // present exactly on a rename
    kind: "added" | "deleted" | "renamed" | "modified"; // a copy reads `added`
    modeChanged?: boolean;
    binary?: boolean;
    // why the lines are not shown; size never is
    unreadable?: "permissionDenied" | "notRegularFile";
    additions: number;
    deletions: number;
    patch?: string; // the file's unified patch; absent for a binary file or one that could not be read
    // git's blob id for each side, as `git diff --full-index` gives it (the working file's hash on the
    // working side); a gap read and a held note's comparison key on it. Absent on the side where the file
    // does not exist.
    oldBlobId?: string;
    newBlobId?: string;
    newestTurn?: number; // the latest turn that changed the file; absent for a change made outside a turn
    // on the workflowRun arm only: the step that changed the file, its node id and the name it
    // shows, per file and never per line
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
type GitAct = "commit" | "push" | "pull" | "openChangeRequest";
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
interface GitActFrame {
  commands: Array<{
    index: number;
    text: string;
    state: "pending" | "running" | "done" | "failed";
    output?: string;
  }>;
  settled: boolean; // true once the act has ended
}

// GitCommitMessageGenerate / GitChangeRequestTextGenerate — a fresh process that carries no
// conversation, on the provider and model Settings › General's `Commit and pull request text` picks
// (`commitTextModel`; `null` is `Automatic`, the session's provider and its lowest-priced model, or
// the session's model where none is priced), runs read-only and outside the repository at the
// lowest effort the model takes, with thinking off where the model allows it, and reads the whole
// working folder's diff, the branch and recent commit subjects. The diff is never cut or thinned:
// one request when it fits, otherwise several passes over every changed file, lockfiles and
// generated files included, the daemon tracking which files each pass covered, then one pass that
// writes the text. A request or a pass fits when it is within the model's window and within any
// per-message limit the provider has (on Codex, 1,048,576 characters of a message's `text`), and
// every pass is sized under both, so Codex's `input_too_large` never answers a correctly sized
// pass. The window is the provider's own figure: Codex's catalog row from `codex debug models`
// (`context_window`, `max_context_window`) and Claude Code's `get_context_usage` read at the
// process's creation; the price table gives only the price, so a model it does not price is sized
// the same way. The response names each changed file no pass could read and never claims to cover
// it. A failure is refused under the codes this contract registers (error-contracts.md §Git): a
// passing upstream failure under `git.generateFailed`, the provider's refusal of the content by its
// own policy under `git.generateRefused`, each carrying the provider's own words, while a missing
// sign-in, a timeout, a provider not installed or a spent allowance answers the shared provider and
// account code for it; it never falls back to another provider, model or account. A chosen provider
// other than the session's runs on that provider's `Default` account, and a `Default` account that
// cannot run the request fails with its reason, never swapped.
interface GitCommitMessageGenerateResponse {
  subject: string;
  body: string;
  unreadPaths: string[]; // each changed file no pass could read, which the text does not cover; empty when every file was read
}
interface GitChangeRequestTextGenerateResponse {
  title: string;
  description: string;
  unreadPaths: string[]; // as on GitCommitMessageGenerateResponse
}

// GitChangeRequestSubscribe — the session's change requests, live. `summary` (state, can-merge,
// review decision) feeds the header's request word; `full` adds the description, the reviews and
// requested reviewers, the threads and the checks, for Review. While a subscriber holds it, the
// daemon sends the hosting service a conditional request every 60 s (an unchanged answer costs no
// quota); a `full` subscriber, the pull-request tab in view, re-reads every 60 s while the request
// is open and every five minutes once it is merged or closed. It refreshes at once after the
// person's own git and change-request acts; with no subscriber nothing asks the host. A failed read
// keeps the last state and says when the read failed, rather than ending the stream, and the next
// read waits as [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) D-008-10 sets out.
interface GitChangeRequestSubscribeRequest {
  sessionId: SessionId;
  depth: "summary" | "full";
}
interface ChangeRequestFrame {
  requests: Array<{
    number: number;
    url: string;
    state: "open" | "merged" | "closed";
    isDraft: boolean;
    mergeable?: "mergeable" | "conflicting" | "unknown";
    reviewDecision?: "approved" | "changesRequested" | "reviewRequired";
    headCommitId: string;
    // Present at `full` depth only.
    author?: string;
    description?: string;
    reviews?: Array<{ reviewer: string; verdict: "comment" | "approve" | "requestChanges" }>;
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

// GitReviewerList / GitLabelList — the candidates the change-request form offers.
interface GitReviewerListRequest {
  sessionId: SessionId;
  query?: string;
}
interface GitReviewerListResponse {
  reviewers: Array<{ login: string; name?: string }>;
}
interface GitLabelListResponse {
  labels: Array<{ name: string; description?: string }>;
}

// GitReviewSubmit — posts the session's held notes that are not stranded as ONE review carrying one
// verdict. The wire carries no note text: the notes come from the held-note store. A review can land
// PARTLY, and the reply says so per note: the notes that posted are recorded as sent and never offered
// again, the ones behind a failure stay held, and a second press posts only what is still held. A
// stranded note is never submitted and never appears in the reply.
interface GitReviewSubmitRequest {
  sessionId: SessionId;
  changeRequestNumber: number;
  verdict: "comment" | "approve" | "requestChanges";
  body?: string;
}
interface GitReviewSubmitResponse {
  reviewUrl?: string; // absent when no review was created because every comment failed
  postedNoteIds: string[];
  failures: Array<{ noteId: string; reason: string }>; // `reason` is the hosting service's own words
}

// GitReviewThreadResolve / GitReviewThreadReply — act on one hosting thread. Resolving a thread
// already resolved succeeds.
interface GitReviewThreadResolveRequest {
  sessionId: SessionId;
  changeRequestNumber: number;
  threadId: string;
}
interface GitReviewThreadResolveResponse {
  threadId: string;
  state: "resolved";
}
interface GitReviewThreadReplyRequest {
  sessionId: SessionId;
  changeRequestNumber: number;
  threadId: string;
  body: string;
}
interface GitReviewThreadReplyResponse {
  commentId: string;
  url: string;
}

// GitCheckLogRead — the tail of a failing check's raw log; how much of the tail is read comes from
// the machine, and the log is shown as text.
interface GitCheckLogReadRequest {
  sessionId: SessionId;
  changeRequestNumber: number;
  checkId: string;
}
interface GitCheckLogReadResponse {
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

// The held-note store's shapes (the `session.reviewNote.*` verbs below). A note records the
// comparison it was written against, which is what a press on the note walks back to.
interface ReviewNoteComparison {
  scope: "changes" | "branch" | "changeRequest";
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
  quote: string; // the line's text, read from that side's file at the comparison when added
  body: string;
  stranded: boolean; // that line is gone from that side's file, or no longer says what `quote` holds
  createdAt: string; // RFC 3339 UTC
  updatedAt: string; // RFC 3339 UTC; the last edit of `body`
  // `git.review.submit` adds `state: "held" | "sent"` to this shape when it is built: `sent` once
  // a posted review carried the note, drawn `sent` and never offered again, so a second press after
  // a part-way failure posts only what is still `held`. Until then the schema refuses the member.
}
interface SessionReviewNoteAddRequest {
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
interface SessionReviewNoteUpdateRequest {
  sessionId: SessionId;
  noteId: string;
  body: string;
}
interface SessionReviewNoteResponse {
  note: ReviewNote; // answers both an add and an update
}
interface SessionReviewNoteDeleteRequest {
  sessionId: SessionId;
  noteIds: string[]; // one press discards every note behind one question, and a steer clears every note
}
interface SessionReviewNoteDeleteResponse {
  removedNoteIds: string[]; // the notes this delete discarded; an id the session did not hold is left out
}
interface SessionReviewNoteSubscribeRequest {
  sessionId: SessionId;
}
interface ReviewNoteSet {
  notes: ReviewNote[]; // caught up, then followed; `stranded` recomputed against each note's comparison
}
// git.settled payload (Spec-005 §Artifact and Diff Publication). ONE record for the five git acts
// the transcript records — committing, pushing, pulling, opening a change request and posting a
// review — so those system messages survive a reload. Each `cause` carries exactly the reference
// its system message names: the commit's identifier for `committed`, the branch for `pushed`, the
// branch and the commit it landed on for `pulled`, the request's number plus its address on the
// hosting service for `pullRequestOpened`, and the request's number plus the verdict for
// `reviewPosted`. `runId` is present only on a `committed` record whose commit an agent made as an
// ordinary tool call (read from its run trailer); a push, and every act the person pressed, carries
// none.
interface GitSettledPayload {
  sessionId: SessionId;
  runId?: RunId;
  cause: "committed" | "pushed" | "pulled" | "pullRequestOpened" | "reviewPosted";
  commitId?: string;
  branch?: string;
  requestNumber?: number;
  requestUrl?: string;
  verdict?: "comment" | "approve" | "requestChanges";
}
```

Plan-008's git flow is exposed as the `git.*` methods below. Method-name strings follow the wire-name grammar, dotted lowerCamelCase segments ([Local IPC Payload Contracts §Wire-Name Grammar](./local-ipc-payloads.md#wire-name-grammar)). The PascalCase request/response type symbols (such as `GitActionExecute`) are off that grammar, which leaves PascalCase to type names, so `is_wire_name` fails the build on one used as a method string and each wire name differs from its payload type symbol. Names register under the Plan-005-partial daemon `MethodRegistry` per the §5 substrate-vs-namespace carve-out. These methods ride the **daemon JSON-RPC transport only** — the ship facts, the diff and the held notes are this machine's git and daemon state, and the hosting service is reached from the daemon under the person's own signed-in identity, so no control-plane route sibling exists. Every session-scoped method is keyed by the session, and the daemon resolves the session's working folder itself.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `git.branchContext.read` | `query` | `GitSessionRequest` | `GitBranchContextReadResponse` |
| `git.diff.read` | `query` | `GitDiffReadRequest` | `GitDiffReadResponse` |
| `git.action.preview` | `query` | `GitActionPreviewRequest` | `GitActionPreviewResponse` |
| `git.action.execute` | `mutation` | `GitActionExecuteRequest` | `GitActionExecuteResponse` |
| `git.action.subscribe` | `subscription` | `GitActionSubscribeRequest` | `GitActFrame` (stream) |
| `git.commitMessage.generate` | `mutation` | `GitSessionRequest` | `GitCommitMessageGenerateResponse` |
| `git.changeRequest.text.generate` | `mutation` | `GitSessionRequest` | `GitChangeRequestTextGenerateResponse` |
| `git.changeRequest.subscribe` | `subscription` | `GitChangeRequestSubscribeRequest` | `ChangeRequestFrame` (stream) |
| `git.reviewer.list` | `query` | `GitReviewerListRequest` | `GitReviewerListResponse` |
| `git.label.list` | `query` | `GitSessionRequest` | `GitLabelListResponse` |
| `git.review.submit` | `mutation` | `GitReviewSubmitRequest` | `GitReviewSubmitResponse` |
| `git.reviewThread.resolve` | `mutation` | `GitReviewThreadResolveRequest` | `GitReviewThreadResolveResponse` |
| `git.reviewThread.reply` | `mutation` | `GitReviewThreadReplyRequest` | `GitReviewThreadReplyResponse` |
| `git.checkLog.read` | `query` | `GitCheckLogReadRequest` | `GitCheckLogReadResponse` |
| `git.host.list` | `query` | `EmptyPayload` | `GitHostListResponse` |
| `git.host.add` | `mutation` | `GitHostAddRequest` | `GitHostAddResponse` |
| `git.host.remove` | `mutation` | `GitHostRemoveRequest` | `GitHostRemoveResponse` |

**One git-settlement record, whose cause names the act.** Committing, pushing, pulling, opening a change request and posting a review each settle into ONE durable record — `git.settled`, whose `cause` is one of `committed | pushed | pulled | pullRequestOpened | reviewPosted` and names which of the five it was — so those system messages survive a reload and the transcript says what left this machine and what came into it. The name and the taxonomy census are [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md)'s; what is fixed here is that one record carries all five acts. A review posted with the comment verdict alone reads as a comment on the request. The record is what the flow renders; it is not a second copy of the hosting state, which `git.changeRequest.subscribe` keeps on its own. A result that arrives after the form it came from has closed, or after the pane has been pointed at another session, updates nothing on screen — and the record still lands, because the act happened.

**The held-note store and its verbs.** A review note is a DRAFT the daemon holds, scoped to the session, in the same session-scoped store as the composer draft and its staged files, so a half-written review reaches the person's other devices; typed unsent text is never written to renderer-local storage. `session.reviewNote.add` adds a note located at a file and a line — its path (the old path on a renamed file), its side, its line or range of lines — with its own words and the `comparison` it was written against, which is what a press on the note walks back to; `session.reviewNote.update` edits a held note's words; `session.reviewNote.delete` takes `noteIds`, an array, because one press discards every note behind one question and a steer clears every note at once; and `session.reviewNote.subscribe` is the session's notes, live. A note leaves in exactly one of three ways — composed into the composer draft as a steer, posted as part of one review through `git.review.submit`, or discarded — and nothing else. The daemon checks each held note against the diff it points into and marks a note whose line no longer exists as stranded: it stays readable, editable and deletable, and is left out of a posted review, as is a note on uncommitted lines. Once a note is posted it stops being a held note and becomes a hosting thread, which takes `git.reviewThread.reply` and `git.reviewThread.resolve` and never the note's edit and delete. What is fixed here is the store — session-scoped, daemon-held, one home per note — and the `noteId` that `git.review.submit`'s result and the adapter's `submitReview` address a note by.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `session.reviewNote.add` | `mutation` | `SessionReviewNoteAddRequest` | `SessionReviewNoteResponse` |
| `session.reviewNote.update` | `mutation` | `SessionReviewNoteUpdateRequest` | `SessionReviewNoteResponse` |
| `session.reviewNote.delete` | `mutation` | `SessionReviewNoteDeleteRequest` | `SessionReviewNoteDeleteResponse` |
| `session.reviewNote.subscribe` | `subscription` | `SessionReviewNoteSubscribeRequest` | `ReviewNoteSet` (stream) |

The reads are `query`s, the live feeds `subscription`s and every other verb a `mutation`, per [API Payload Contracts §Procedure Types](./api-payload-contracts.md#procedure-types). The daemon answers these verbs through its own hosting adapter, one per hosting kind, GitHub through the `gh` command-line tool and GitLab through `glab`, each under the person's own signed-in identity. The adapter is daemon-internal, in the daemon's git module (`crates/sidekicks-workspace/src/git/`), and is not part of this contract; its operations are stated in [Spec-009 §GitHostingAdapter Interface](../../specs/009-gitflow-pr-and-diff-attribution.md#githostingadapter-interface), and every reply a client reads is the verb's own shape above. The Rust types live in `crates/sidekicks-contracts/src/git/`, and the held-note shapes in `crates/sidekicks-contracts/src/review_note.rs`; the generated TypeScript keeps `packages/contracts/src/git/` and `packages/contracts/src/review-note.ts`, per the api-payload-contracts.md §Source-of-Truth Policy.
