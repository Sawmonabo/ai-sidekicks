# Plan-008: Gitflow PR And Diff Attribution

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `008` |
| **Slug** | `gitflow-pr-and-diff-attribution` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-009: Gitflow PR And Diff Attribution](../specs/009-gitflow-pr-and-diff-attribution.md) |
| **Required ADRs** | [ADR-006](../decisions/006-worktree-first-execution-mode.md), [ADR-014](../decisions/014-v1-feature-scope-definition.md) |
| **Dependencies** | [Plan-007](./007-worktree-lifecycle-and-execution-modes.md) (branch context, worktrees, the branch list and the tree-staleness signal), [Plan-012](./012-persistence-and-recovery.md) (the file checkpoint store behind each file's turn), [Plan-004](./004-session-event-taxonomy-and-audit-log.md) (`git.settled` in the session event taxonomy) |
| **Cross-Plan Deps** | Cross-Plan Dependency Graph |
| **References** | [Spec-009 §Git Hosting Adapter](../specs/009-gitflow-pr-and-diff-attribution.md#git-hosting-adapter) (the `GitHostingAdapter` over `gh` and `glab`) |

## Goal

Build Review's daemon half and its surface: the ship facts and the diff a session reads, the acts that ship it, Generate, the hosting sites and their reads, the held review notes, and commit attribution through the daemon's own `Agent-Run` trailer, so what an agent and the person change is read, shipped and reviewed from the session with nothing attributed by guess.

## Scope

This plan covers the ship-facts read with its per-folder watch and cache, the diff read and the gap read, the ship acts with their preview and progress, Generate, the agent-commit watch and the `Agent-Run` trailer hook, the hosting adapters for GitHub and GitLab with the self-hosted host list, the live pull-request read and the reviewer, label, thread and check-log verbs, the held review notes and review posting, and the Review surface on the desktop.

## Non-Goals

- Final merge automation
- Hosting sites beyond GitHub and GitLab
- Workflow-specific review logic

## Preconditions

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/gitflow/` — every `gitflow.*` contract
- `packages/runtime-daemon/src/gitflow/` (not built) — the ship-facts read with its per-folder watch and cache, the agent-commit watch, the diff read, the act runner that builds each act's commands for both the preview and the run, Generate, the trailer hook, the hosting adapters and the host list
- `packages/runtime-daemon/src/ipc/handlers/gitflow.ts` (not built) — the `gitflow.*` handlers
- The desktop's repos feature, `features/repos/` — Review, the ship strip and the pull-request tab

## Data And Storage Changes

- The held review notes: one session-scoped table beside the composer draft, each row a note with its comparison, side, line, optional first line of a range, quote, words, state (`held` or `sent`) and times. It is added to the one local schema and its schema test.
- The registered self-hosted hosts: one table in the same schema, each row a host name and the kind of the tool that answered for it.
- No table for the ship facts, the diff or the hosting reads: the daemon keeps one in-memory cache per working folder (D-008-2), and the durable record of each act is its `git.settled` event.
- `branch_contexts` is Plan-007's; this plan reads it and never alters it.
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for column definitions.

## API And Transport Changes

- Serve the seventeen `gitflow.*` verbs over the daemon's JSON-RPC transport ([Spec-009 §Interfaces And Contracts](../specs/009-gitflow-pr-and-diff-attribution.md#interfaces-and-contracts)): `gitflow.branchContextRead`, `gitflow.diffRead`, `gitflow.gitActionPreview`, `gitflow.gitActionExecute`, `gitflow.gitActionSubscribe`, `gitflow.commitMessageGenerate`, `gitflow.changeRequestTextGenerate`, `gitflow.changeRequestSubscribe`, `gitflow.reviewerList`, `gitflow.labelList`, `gitflow.reviewSubmit`, `gitflow.threadResolve`, `gitflow.threadReply`, `gitflow.checkLogRead`, `gitflow.hostList`, `gitflow.hostAdd` and `gitflow.hostRemove`; beside them `repo.fileRead` and the held-note verbs `session.reviewNoteAdd`, `session.reviewNoteUpdate`, `session.reviewNoteRemove` and `session.reviewNoteList`.
- Emit one settlement event, `git.settled`, for each act that sends a session's work off this machine's working folder or brings it in: a commit, a push, a pull, an opened pull request, or a posted review. Its cause is one of `committed`, `pushed`, `pulled` (`{branch, commitId}`), `pull_request_opened` or `review_posted` (`{requestNumber, verdict}`), and each cause carries exactly the reference the session's system message names ([Spec-009 §Interfaces And Contracts](../specs/009-gitflow-pr-and-diff-attribution.md#interfaces-and-contracts)). The type and its payload are registered in the session event taxonomy ([Spec-005 §Event Type Enumeration](../specs/005-session-event-taxonomy-and-audit-log.md#event-type-enumeration)).

## Invariants

- **I-008-1** — Attribution is never guessed: a file's turn comes only from the session's file checkpoint store and a commit's agent only from its own `Agent-Run` trailer; where neither exists the file or commit carries nothing ([Spec-009 §Required Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#required-behavior), [Spec-009 §Fallback Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#fallback-behavior), [Spec-009 §Pitfalls To Avoid](../specs/009-gitflow-pr-and-diff-attribution.md#pitfalls-to-avoid)).
- **I-008-2** — A pull request's base and head derive exclusively from the recorded branch context, never from transient client or tab state ([Spec-009 §Required Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#required-behavior), [Spec-009 §Pitfalls To Avoid](../specs/009-gitflow-pr-and-diff-attribution.md#pitfalls-to-avoid)).
- **I-008-3** — One daemon function builds an act's commands for both `gitflow.gitActionPreview` and `gitflow.gitActionExecute`, so no act runs a command its preview did not show ([Spec-009 §Required Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#required-behavior), [Spec-009 §Pitfalls To Avoid](../specs/009-gitflow-pr-and-diff-attribution.md#pitfalls-to-avoid)).
- **I-008-4** — `Agent-Run` is the only trailer the daemon writes; it writes no co-author trailer and no address ([Spec-009 §Required Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#required-behavior)).
- **I-008-5** — Held notes live only in the daemon's store; a stranded note and a note on uncommitted lines are never posted, and a posted note is never offered again ([Spec-009 §Required Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#required-behavior)).
- **I-008-6** — With no subscriber, the daemon sends no request to a hosting service ([Spec-009 §Git Hosting Adapter](../specs/009-gitflow-pr-and-diff-attribution.md#git-hosting-adapter)).

## Cross-Plan Obligations

- **CP-008-1 (consumes)** — From Plan-007: `BranchContextId` and the `branch_contexts` row (Plan-007 CP-007-5), read and never altered; `repo.branchList`, the one ordered branch list the base picker draws; and the tree-staleness signal (`repo.workingTreeSubscribe`), which re-reads the ship facts. Plan-008 reads them through Plan-007's services and never edits Plan-007's `git/` module. **Tasks:** T8.2, T8.3, T8.10.
- **CP-008-2 (consumes)** — From Plan-012: the capture folders the file checkpoint store keeps — a session's, for each file's newest turn in the diff, and a workflow run's, for the diff read's `workflowRun` arm, which reads two of the run's snapshot points with the repository's objects as an alternate ([Plan-012 §Implementation Phase Sequence](./012-persistence-and-recovery.md#implementation-phase-sequence)). **Tasks:** T8.3.
- **CP-008-3 (extends)** — To Plan-004: `git.settled` with its causes, registered in the session event taxonomy; Plan-008 is its only producer. **Tasks:** T8.2, T8.4, T8.9.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.
- The `#### Tasks` rows live under §Implementation Phase Sequence below, grouped per phase.

## Implementation Phase Sequence

Plan-008 implementation lands as a sequence of small PRs. Each PR exercises one slice of the plan's vertical and carries a `**Precondition:**` line naming the phases it waits on. The ordering is the one §Rollout Order and §Parallelization Notes set out.

### Phase 1 — Contracts

**Precondition:** none. §Rollout Order step 1: every contract lands before any handler.

#### Tasks

- **T8.1** — Every `gitflow.*` contract in `packages/contracts/src/gitflow/`: the request, the result, the refusals and the stream frames of the Review verbs — `gitflow.branchContextRead`, `gitflow.diffRead`, `gitflow.gitActionPreview`, `gitflow.gitActionExecute`, `gitflow.gitActionSubscribe`, `gitflow.commitMessageGenerate`, `gitflow.changeRequestTextGenerate`, `gitflow.changeRequestSubscribe`, `gitflow.reviewerList`, `gitflow.labelList`, `gitflow.reviewSubmit`, `gitflow.threadResolve`, `gitflow.threadReply`, `gitflow.checkLogRead` — and of the host verbs, `gitflow.hostList`, `gitflow.hostAdd {host}` and `gitflow.hostRemove`. `git.settled`'s cause payload lands in the event contract and the `session.reviewNote*` verbs in the session contract, beside the composer draft's. The contracts land ahead of their handlers; no verb is served until its task below builds it. Every refusal those verbs raise is registered: one code per refusal under the `gitflow` root, each with its reason list, by the rules [error-contracts.md §Error Codes](../architecture/contracts/error-contracts.md#error-codes) states; that document's §Gitflow lists them from this contract.
  - **Spec coverage:** [Spec-009 §Interfaces And Contracts](../specs/009-gitflow-pr-and-diff-attribution.md#interfaces-and-contracts).
  - **Verifies invariant:** none.
  - **Consumes:** the `METHOD_NAME_FORMAT` registry and the canonical method table in [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) (D-008-5).

### Phase 2 — Ship Facts And The Diff Read

**Precondition:** Phase 1 merged. T8.2 and T8.3 each also wait on another plan's phase, stated on the task.

#### Tasks

- **T8.2** — Not built. `gitflow.branchContextRead`, keyed `{sessionId}`: the daemon maps each session to its working folder and answers from that folder's one watch and one cache, shared by every session there (D-008-2). The result carries the ship facts [Spec-009 §Interfaces And Contracts](../specs/009-gitflow-pr-and-diff-attribution.md#interfaces-and-contracts) lists, among them the hosting service's name and request word, whether the branch has never left this machine, a half-finished merge, rebase or bisect with its ending command, and the pull-request form's opening values — its proposed base, title and description, and whether it pushes first. A read that fails in a way that can be retried is retried once by the daemon's one read retry ([Plan-006](./006-repo-attachment-and-workspace-binding.md) T3.9) before anything reaches the screen; one that still fails names which read failed. The same watch is the agent-commit watch: a commit's run comes from its `Agent-Run` trailer and settles `git.settled` `committed` with that run; a push is read from the remote-tracking reflog's `update by push` and settles `pushed` with no run; a fetch changes only the ahead and behind figures; a finished `gh pr create` or `glab mr create` tool call re-reads the pull request.
  - **Spec coverage:** [Spec-009 §Required Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#required-behavior) (the ship strip read off the state, the agent-commit watch, the form's values), [Spec-009 §Fallback Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#fallback-behavior) (a failed read is never an absent fact).
  - **Verifies invariant:** I-008-1, I-008-2.
  - **Consumes:** CP-008-1; CP-008-3.
  - **Waits on:** Plan-007 Phase 3 merged, which serves the tree-staleness signal `repo.workingTreeSubscribe` that re-reads the ship facts (CP-008-1). The wait is this task's alone.
- **T8.3** — Not built. `gitflow.diffRead` and `repo.fileRead`. The diff read answers one comparison as [Spec-009 §The Diff Read](../specs/009-gitflow-pr-and-diff-attribution.md#the-diff-read) fixes it: one entry per path, each file's kind word (a copy reads `added`), binary, unreadable with its cause, untracked files as additions read from the status without touching the index, the patch whole and never cut at a size, git's blob id for each side (D-008-4), and each file's newest turn from the session's capture folder; the branch and pull-request comparisons add their commits with the agent read from each commit's trailer, and a `commitId` narrows either to one commit. Its `workflowRun` arm diffs two of a workflow run's snapshot points from the run's own capture folder — start to end for the run's header, start to that pause for an approval step — and returns each file with the step that changed it, read from the paths each step's captures recorded ([Plan-014](./014-workflow-authoring-and-execution.md) T2.16). A changed picture carries both versions' bytes and natural sizes, the earlier one absent where the picture is new, so the quick look can set them side by side. `repo.fileRead` reads a file not in the diff and the lines inside a gap by `{path, blobId, side}`, answering `stale` when a working-tree side has changed since its blob id was read. Each read here that fails in a way that can be retried, a file's lines included, is retried once by the daemon's one read retry ([Plan-006](./006-repo-attachment-and-workspace-binding.md) T3.9) before anything reaches the screen.
  - **Spec coverage:** [Spec-009 §The Diff Read](../specs/009-gitflow-pr-and-diff-attribution.md#the-diff-read), [Spec-009 §Interfaces And Contracts](../specs/009-gitflow-pr-and-diff-attribution.md#interfaces-and-contracts).
  - **Verifies invariant:** I-008-1.
  - **Consumes:** CP-008-1; CP-008-2.
  - **Waits on:** Plan-012 Phase 1 merged, the file checkpoint store behind each file's turn (T12.6, CP-008-2). The wait is this task's alone.
  - **Tests:** a read failing once with a retryable error answers on its retry 100 ms later and is never shown failed; a `workflowRun` diff marks each file with the step whose captures recorded it; a changed picture's entry carries both versions' sizes, and a new picture's carries one.

### Phase 3 — Ship Acts, Generate And The Trailer

**Precondition:** Phase 1 merged. Parallel to Phase 2.

#### Tasks

- **T8.4** — Not built. `gitflow.gitActionPreview`, `gitflow.gitActionExecute` and `gitflow.gitActionSubscribe`. One daemon function builds an act's commands for the preview and the run (I-008-3). The acts are commit, which sweeps the whole working folder with one add before the commit; push; pull, on the branch this session is on, under the person's own git identity; and open a request with its base, title, description, draft flag, reviewers and labels, carrying its own push only when the branch has never left this machine. There is no amend, no force push and no merge. `retryFromCommand` runs a failed act again from the command that failed; the progress stream catches up and then follows each command's state, its output scrubbed of credentials. Each act settles `git.settled` — `committed`, `pushed`, `pulled` or `pull_request_opened` — and asks for a fresh ship-facts read the moment it finishes.
  - **Spec coverage:** [Spec-009 §Required Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#required-behavior) (commands shown before they run, committing takes the whole folder, pushing and opening a request, every act leaves a record), [Spec-009 §Fallback Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#fallback-behavior) (a failed command keeps its try-again).
  - **Verifies invariant:** I-008-2, I-008-3.
  - **Consumes:** CP-008-3; the hosting adapter for opening a request (T8.7).
- **T8.5** — Not built. `gitflow.commitMessageGenerate` and `gitflow.changeRequestTextGenerate`: a fresh one-turn process on the session's provider and account that carries no conversation, on the model D-008-8 chooses, at the lowest effort with thinking off, read-only, in a folder outside the repository, fed the whole working folder's diff, the branch name and the recent commit subjects. A failure is refused under the code T8.1 registers for it, in the provider's own words, and never falls back to the other provider.
  - **Spec coverage:** [Spec-009 §Required Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#required-behavior) (Generate).
  - **Verifies invariant:** none.
  - **Consumes:** the price table and the provider's model list for the account.
- **T8.6** — Not built. The `Agent-Run` trailer hook, installed in every provider process the daemon spawns as D-008-7 sets out, and the per-session run marker in the provider's environment.
  - **Spec coverage:** [Spec-009 §Required Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#required-behavior) (the trailer, the only trailer the daemon writes).
  - **Verifies invariant:** I-008-1, I-008-4.
  - **Consumes:** the provider spawn paths on Claude Code and on Codex.

### Phase 4 — Hosting, Reviews And Notes

**Precondition:** Phase 1 merged. Parallel to Phases 2 and 3.

#### Tasks

- **T8.7** — Not built. The `GitHostingAdapter`, one adapter per site kind — GitHub over `gh`, GitLab over `glab` — each under the person's own sign-in, with the operations [Spec-009 §GitHostingAdapter Interface](../specs/009-gitflow-pr-and-diff-attribution.md#githostingadapter-interface) lists — `createChangeRequest`, `listChangeRequests`, `getChangeRequestStatus`, `submitReview`, `resolveThread`, `replyToThread`, `readCheckLog`, `listReviewers` and `listLabels` — (D-008-1), the site read from the repository's remote. The adapter's interface and its parameter and result shapes are the daemon's own, in `packages/runtime-daemon/src/gitflow/` (D-008-3), never in `packages/contracts` or api-payload-contracts.md. The self-hosted host list: `gitflow.hostList`, `gitflow.hostRemove`, and `gitflow.hostAdd {host}`, which asks each installed tool whether it answers for the host signed in and keeps the kind of the one that does, refusing a malformed name with `That is not a host name.` and an unanswered host with `<host> didn't answer as GitHub or GitLab. Sign in to it with gh or glab, then add it again.`, saving nothing either way.
  - **Spec coverage:** [Spec-009 §Git Hosting Adapter](../specs/009-gitflow-pr-and-diff-attribution.md#git-hosting-adapter), [Spec-009 §Hosting Sites](../specs/009-gitflow-pr-and-diff-attribution.md#hosting-sites).
  - **Verifies invariant:** none.
  - **Consumes:** the installed `gh` and `glab`.
- **T8.8** — Not built. `gitflow.changeRequestSubscribe {sessionId, depth: summary | full}` on D-008-10's cadence, and `gitflow.reviewerList`, `gitflow.labelList`, `gitflow.threadResolve`, `gitflow.threadReply` and `gitflow.checkLogRead` over the adapter. The subscription's frames carry the widened request facts, when they were read and when a read last failed; nothing asks the host while no one subscribes.
  - **Spec coverage:** [Spec-009 §Interfaces And Contracts](../specs/009-gitflow-pr-and-diff-attribution.md#interfaces-and-contracts), [Spec-009 §Hosting Sites](../specs/009-gitflow-pr-and-diff-attribution.md#hosting-sites), [Spec-009 §Required Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#required-behavior) (the pull-request tab re-reads itself; threads and checks).
  - **Verifies invariant:** I-008-6.
  - **Consumes:** T8.7.
- **T8.9** — Not built. The held notes and review posting. The note store and its verbs, `session.reviewNoteAdd`, `session.reviewNoteUpdate`, `session.reviewNoteRemove {noteIds}` and `session.reviewNoteList` (D-008-9), with each note's `stranded` mark recomputed against its comparison; and `gitflow.reviewSubmit`, which posts the held notes as a pending review, one thread per note, then submits it under one verdict with its optional summary (D-008-6), marks each posted note `sent`, names each note that failed with its reason, leaves stranded notes and notes on uncommitted lines out, and settles `git.settled` `review_posted`.
  - **Spec coverage:** [Spec-009 §Required Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#required-behavior) (a review note is a draft the daemon holds; the ways a held note leaves; a post that partly failed), [Spec-009 §Git Hosting Adapter](../specs/009-gitflow-pr-and-diff-attribution.md#git-hosting-adapter).
  - **Verifies invariant:** I-008-5.
  - **Consumes:** T8.7; the session's composer-draft store; CP-008-3.

### Phase 5 — The Review Surface

**Precondition:** Phase 1 merged. The surface draws from the fixture layout until each verb's task lands and goes live verb by verb.

#### Tasks

- **T8.10** — Not built. Review in `features/repos/`: the diff pane, the scope row with the comparisons and the notes tab, the base picker over `repo.branchList`, the file list, the ship strip with its state line, next action, alternate, forms, Generate and `Exact commands` fold, the pull-request tab with its reviews, threads and check logs, and the header's request word over the `summary` subscription. On the strip, `Commit` and `Open pull request` open their forms while `Push` and `Pull` act on the press with no form, each act's commands under the `Exact commands` fold; while a run is live in the session the four wait, each with its reason in its own hover title, and answer again when the run ends. The reload mark is drawn from the daemon's tree-staleness signal (`repo.workingTreeSubscribe`, which also carries the staleness an allowed approval raises, [Plan-009](./009-approvals-permissions-and-trust-boundaries.md) T2.14), titled `Tree changed — reload`, and from the `full` subscription's head moving past the head the pane loaded, titled `Pull request moved on — reload` and held against that request; the diff is re-read only when the reader presses reload, the line at the top of the pane staying at the top and only the files whose content changed redrawn. The diff paints the spans the daemon's colorer hands it (`highlight.read`): a first pass from the hunk's own lines the moment a file opens, replaced by the whole file's spans when they arrive, with no line moving. The base picker is the one branch-choosing control, built once and drawn again by the worktree switcher's create form ([Plan-020](./020-desktop-app-and-renderer.md) T-020p-1C-5), which adds only the graying of a branch another worktree holds. The held notes leave through the notes tab's send control — `Steer the sidekick` composes one `Address these review notes:` message into the draft, moves focus there, clears the notes and sends nothing; `Post to PR review` posts under `Comment`, `Approve` or `Request changes` — and while any note is held they are one chip in the composer's attachment row, reading `1 note` or `<N> notes` beside any attached file, whose press opens Review on its notes tab and whose `×` asks `Discard <N> notes?` in place on the chip before one `session.reviewNoteRemove`; the chip goes on those three exits and on nothing else. Every comparison draws the file list beside the diff under one set of fold, filter, width and divider rules: Branch over the branch's commits against the base, and Pull request over the request's commits beside its description, reviews, threads and checks. On Branch and Pull request the pane header carries the commit picker, reading `All commits`, whose list holds `All commits` and then each commit as one row of two controls side by side, each reached on its own by the keyboard: the short identifier, which copies the full one and reads `Copied`, or `Could not copy`, for a moment, and the rest of the row, carrying the subject, when the commit landed in the machine's own clock, and the maker's mark — the agent's swatch and name, the robot mark for the session's own agent, nothing where the person made it — whose pick narrows both the file list and the diff, with their counts, to that one commit and leaves the picker reading it; `All commits`, a comparison switch or a reload restores the full range. Each file row shows the turn that changed it as a short word beside its counts, `turn <n>`, reading the newest turn that touched that file, while the row's hover title stays the file path. The header's file-list fold is drawn on every comparison while a file has changed. This task owns Review's before-and-after picture view: pressing a changed picture's row opens the quick look with the old picture beside the new one, each at its natural size inside the column and labeled `before` and `after` under it, over T8.3's read of both versions' bytes; a picture with no earlier version opens alone, as the quick look otherwise opens one. The run view, which a workflow run's `Open in Review` opens over T8.3's `workflowRun` arm, draws the list and the diff alone — no scope row, base picker, notes or ship strip — each file marked with the step that changed it, the mark reading the step's name alone in the list and in the file's diff header, its accessible name `Changed by the <step name> step`, `Loading the changes…` after the session's short delay until the diff has been read, `Could not load the changes` with `Try again` where the read fails, `This run changed no files` when nothing changed, and `Open in editor` only while the file exists.
  - **Spec coverage:** [Spec-009 §Required Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#required-behavior), [Spec-009 §Fallback Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#fallback-behavior), [Spec-009 §The Diff Read](../specs/009-gitflow-pr-and-diff-attribution.md#the-diff-read).
  - **Verifies invariant:** I-008-1 (the surface draws only the turn and agent the daemon supplies).
  - **Consumes:** every verb above; CP-008-1; `highlight.read`, the daemon's one colorer, which [Plan-020](./020-desktop-app-and-renderer.md) T-020r-5-4 also paints from.
  - **Tests:** a file row reads `turn <n>` for the newest turn that touched the file, with the file path as its hover title; while a run is live `Commit`, `Push`, `Open pull request` and `Pull` wait with their reason and act again once it ends, and `Push` and `Pull` run on the press with no form; a staleness signal raises the reload mark and re-reads nothing until reload is pressed; two held notes draw the `2 notes` chip, its `×` asks `Discard 2 notes?` and only a confirm sends `session.reviewNoteRemove`, and a steer composes the notes into the draft and sends nothing; Branch and Pull request each draw the file list beside the diff with the commit picker reading `All commits`; picking a commit's identifier copies the full identifier and narrows nothing, picking the rest of its row narrows both the file list and the diff to that commit, and `All commits` restores the full range; the run view draws no scope row, base picker, notes or ship strip, reads `Loading the changes…` while its diff is read and `Could not load the changes` with `Try again` when that read fails, names each file's step mark `Changed by the <step name> step`, and reads `This run changed no files` on an empty diff; a changed picture's row opens the quick look with both versions labeled `before` and `after`, and a picture with no earlier version opens alone.

## Parallelization Notes

- Phases 2, 3 and 4 progress in parallel once Phase 1's contracts exist; T8.4's open-a-request act waits for T8.7's adapter.
- The Review surface builds against the contracts and the fixture layout, and goes live verb by verb as each task lands.

## Test And Verification Plan

- The trailer: an agent's commit carries `Agent-Run` and no daemon-written co-author trailer; a commit through the forwarder still runs the repository's own hook; the person's commits and a commit made with `git -c core.hooksPath=…` carry none.
- One command source: for each act, the commands the preview returns are the commands the run executes.
- A partial post: a thread that fails names its note, the posted notes are marked sent and a second press posts only what is still held; a stranded note and a note on uncommitted lines are never posted.
- A gap read on a working-tree side answers `stale` once the file changed after the diff was read.
- With no subscriber, no request reaches the hosting service.
- Manual verification on a GitHub repository and on a GitLab host: an agent's commit and push, a person's commit, push, pull and opened request, and a review posted with notes.

## Rollout Order

1. Land every contract (Phase 1)
2. Serve the ship facts and the diff read, so Review reads live (Phase 2)
3. Serve the ship acts, Generate and the trailer hook (Phase 3)
4. Serve the hosting reads, the notes and review posting (Phase 4)
5. The Review surface goes live verb by verb as each task lands (Phase 5)

## Rollback Or Fallback

- If a hosting site's tool regresses, the pull-request half stays dark for that site while the diff, commit, push and pull keep working.

## Risks And Blockers

- A provider may change its own co-author trailer (Claude Code's default, Codex's account setting); each is checked when the provider's pinned version moves, and the daemon's trailer does not depend on either.
- A repository whose hook manager sets its own `core.hooksPath` is served by the forwarder on git older than 2.54, which runs the repository's configured hooks first; a commit made with `git -c core.hooksPath=…` carries no trailer and reads as the person's.
- The GitLab adapter's per-operation mapping onto `glab` — posting notes so a failure names its note, replying, resolving and reading a check's log — is checked against `glab` when T8.7 is built; the requirement is the one GitHub meets.
- A hosting service's rate limit slows the pull-request reads; the backoff and the conditional request keep the last state on screen.

## Design Decisions

- **D-008-1 — The hosting adapter is daemon-internal and host-agnostic, one adapter per site kind over the site's own command-line tool.** [Spec-009 §GitHostingAdapter Interface](../specs/009-gitflow-pr-and-diff-attribution.md#githostingadapter-interface) names its operations in generic `ChangeRequest` terms, so callers never name a site ([Spec-009 §Hosting Sites](../specs/009-gitflow-pr-and-diff-attribution.md#hosting-sites)); their parameter and result shapes are the daemon's own, in `packages/runtime-daemon/src/gitflow/` (not built), and only the `gitflow.*` method shapes are in `packages/contracts/src/gitflow/`, the hosting verbs' requests, results, refusals and frames in its `hosting.ts`. GitHub is served over `gh` and GitLab over `glab`, each under the person's own sign-in. Calling each site's API with a token the daemon holds was considered and not taken: the tools are maintained by the sites, they already carry the person's sign-in, and the daemon then holds no hosting token and every act leaves under the person's identity. `createChangeRequest` on GitHub runs `gh pr create` and then `gh pr view <created-url> --json number,url`, because `gh pr create` prints only the new request's address and a bare `gh pr view` resolves the current branch's request rather than the one just created on an arbitrary `headBranch`.
- **D-008-2 — One watch and one cache per working folder.** The ship-facts read is keyed `{sessionId}` on the wire; inside, the daemon maps each session to its folder and keeps one watch and one cache per folder, shared by every session working there, since two sessions may share a folder. The watch covers the tree's own git folder and the shared refs area, found with `git rev-parse --git-path`, as change signals only; the daemon then asks git, never reads ref files (under reftable there are none), and passes `--no-optional-locks` on every background read.
- **D-008-3 — Plan-008's daemon code lives in `runtime-daemon/src/gitflow/`, not `runtime-daemon/src/git/`.** `src/git/` is Plan-007-owned (worktree services; Plan-007 CP-007-6) and Plan-008 consumes it through contracts and services, never by editing it. The gitflow module sits beside the `packages/contracts/src/gitflow/` contracts and the `ipc/handlers/gitflow.ts` handlers in §Target Areas.
- **D-008-4 — A blob id per side.** The diff read takes each file's two blob ids from `git diff --full-index`, which gives the working file's hash as the right-hand id. A gap read takes `{path, blobId, side}`: a committed side is read with `git cat-file blob`, exact and never stale; a working-tree side is read from disk only while `git hash-object` (without `-w`) still matches, and otherwise answers `stale`, so a gap never opens onto lines the diff did not show; a pull request's head is fetched locally first.
- **D-008-5 — The Plan-008 wire operations take `gitflow.*` `dotted-camelCase` JSON-RPC method names, registered in the canonical `api-payload-contracts.md` method table.** The `METHOD_NAME_FORMAT` registry (api-payload-contracts.md §Plan-005-Partial — Local IPC Daemon Control) is `dotted-camelCase` and **rejects** PascalCase strings, and every sibling wire surface enumerates its methods in a canonical table there. The `gitflow.*` verbs are the Review verbs and the host verbs [Spec-009 §Interfaces And Contracts](../specs/009-gitflow-pr-and-diff-attribution.md#interfaces-and-contracts) lists; the `…Read` and `…List` verbs are queries, the `…Subscribe` verbs are subscriptions, and the rest are mutations. The held-note verbs sit under the `session.*` root beside the composer draft's. There is no preparation verb and no diff-artifact create. The `GitHostingAdapter` stays daemon-internal and is not a wire method (D-008-1).
- **D-008-6 — A review posts as a pending review, one thread per note, then a submit.** On GitHub each note is `addPullRequestReviewThread` on a pending review, then `submitPullRequestReview` takes the pending review's id (or the request's), a required `event` (`APPROVE`, `COMMENT` or `REQUEST_CHANGES`) and the optional summary as `body`, and returns the submitted review; a pending review can be deleted before it is submitted. This lets a post that fails part-way name the note that failed. The REST create-review call was measured all or none — with one comment inside the diff and one on a line outside it, GitHub answers 422 `Line could not be resolved` and the request holds no review, no comment and no pending draft — so it is not used ([GitHub GraphQL: pulls](https://docs.github.com/en/graphql/reference/pulls), [GitHub REST: pull request reviews](https://docs.github.com/en/rest/pulls/reviews)).
- **D-008-7 — The `Agent-Run` trailer comes from the daemon's own git hook.** On git 2.54 or later the hook is set through `GIT_CONFIG_COUNT` in the provider process's environment; on older git it is a `core.hooksPath` folder that forwards every hook name to the repository's own hooks, the repository's `core.hooksPath` first, else `.git/hooks`. The hook adds `Agent-Run: <run-id>` with `git interpret-trailers --if-exists addIfDifferent`, reading the run from a per-session marker set in the provider's environment: at spawn on Claude Code, and through the conversation's `shell_environment_policy.set` on Codex, where `CODEX_THREAD_ID` also names the thread. A trailer written by the provider was not taken, because a provider's commit trailer reaches a commit only if the model follows an instruction, and attribution must not depend on that. The daemon writes no co-author trailer: Claude Code writes its own by default, and Codex's is an instruction to the model sent only when the person's commit-attribution setting in their OpenAI account is on, off by default and always off with an API key; OpenAI's current documentation names no co-author address for Codex.
- **D-008-8 — Generate runs the cheapest priced model the account lists, with thinking off.** The model is the one with the lowest input rate in the price table, the lowest output rate breaking a tie, among the models the provider lists for the account and does not hide; a model the table does not price is never chosen. On Claude Code the process is `-p --model <model> --no-session-persistence --tools "" --json-schema` with `--settings '{"alwaysThinkingEnabled":false,"cleanupPeriodDays":36500}'` (the retention value every Claude Code process the daemon starts carries) and `--strict-mcp-config`; measured with thinking off at 1.8–1.9 s and under $0.002 a title, against 4.0–6.6 s with it on. On Codex it is an ephemeral thread with a read-only sandbox; Codex's model list carries no size, tier or price, which is why the price table decides.
- **D-008-9 — A note records its comparison, and removal takes an array.** Each note records `comparison {scope, base, headCommitId | workingTreeBlobId, requestNumber?}` with `side`, `line` and `startLine?`, so pressing it walks to the comparison that holds it and the stranded check knows what to compare against; a note on uncommitted lines is left out of a post. The client mints the note's id, so an add is idempotent. `session.reviewNoteRemove` takes `noteIds`, because the composer chip's discard and a steer each clear every note in one act.
- **D-008-10 — A request is read only while it is watched.** While a `summary` subscriber holds `gitflow.changeRequestSubscribe` — the header's request word — the daemon sends a conditional request every 60 s, whose unchanged answer costs no rate-limit quota ([GitHub REST: best practices, conditional requests](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests)), and reads again at once after the person's own git and pull-request acts and after each event that changes the request. A `full` subscriber — the pull-request comparison in view — re-reads every 60 s while the request is open and every five minutes once it is merged or closed; a failed read waits one second, then 1.6 times longer each time up to two minutes, with a fifth either way of jitter, longer whenever the service names a time, and at least a minute after a rate limit that names none. With no subscriber nothing asks the host.
