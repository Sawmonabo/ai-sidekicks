# Spec-009: Gitflow PR And Diff Attribution

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `009` |
| **Slug** | `gitflow-pr-and-diff-attribution` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md), [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md), [Worktree Lifecycle And Execution Modes](../specs/008-worktree-lifecycle-and-execution-modes.md) |
| **Implementation Plan** | [Plan-009: Gitflow PR And Diff Attribution](../plans/009-gitflow-pr-and-diff-attribution.md) |

## Purpose

Define the branch, PR, and diff-attribution behavior for repo-bound coding runs.

## Scope

This spec covers branch strategy, pull-request preparation, diff artifacts, and attribution quality levels, and the review surface that reads a diff and ships it: how a diff is read, the three comparisons it offers, the ship actions of commit, push, pull and open a request, and the review notes and verdicts it carries to the hosting service.

## Non-Goals

- A review workflow of the console's own: the surface carries the hosting service's threads and verdicts and invents no review state beside them
- Git hosting vendor-specific features
- Merge automation policy

## Domain Dependencies

- [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

## Architectural Dependencies

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Observability Architecture](../architecture/observability-architecture.md)
- [ADR-006: Worktree First Execution Mode](../decisions/006-worktree-first-execution-mode.md)

## Required Behavior

- Every writable coding run in `branch`, `worktree`, or `ephemeral clone` mode must execute against an explicit branch context.
- The git engine must track base branch, head branch, and worktree association for each writable coding context.
- Diff artifacts must carry provenance to the producing run when that attribution is available.
- DiffArtifact is a specialized artifact with `artifactType: "diff"` in the shared manifest envelope (defined in Spec-012).
- When precise run attribution is unavailable, the system must emit a clearly labeled workspace-level diff artifact rather than implying precise run attribution.
- Code attribution uses Agent Trace standard + git trailers (`Agent-Run: <run-id>`, `Co-authored-by: <agent-name>`) for both commit-level and line-level provenance.
- PR preparation must use the recorded base and head branch context rather than inferring it from the currently selected client tab.
- A commit, push, or PR-preparation action the user takes must state exactly what it will run before it runs: the form carries the values it will use, and the exact commands sit under a fold beneath the confirming control, ticking off in place as each one finishes. An agent's own commit, push and pull-request calls are ordinary tool calls governed by the session's approval policy ([Spec-010 §Required Behavior](./010-approvals-permissions-and-trust-boundaries.md#required-behavior)); git is never gated a second time and no proposal block is drawn for it.
- **The review surface is one pane, never a route.** Review is the diff pane with a ship strip and a pull-request tab composed on top: never a modal, never a route, never a second kind of pane. It opens wide enough to read a diff's two halves side by side, never narrows past the point one half still reads at, resizes from its own edge and can take the whole column, and its sub-line names the two ends of the comparison, the file count and the totals. It renders what the daemon reports, computes no git state of its own, and paints the syntax spans the daemon hands it rather than colouring anything itself. Its chrome is closed: the header carries exactly the file-list fold, the split-view toggle, the reload, the full-width toggle and the close, and the scope row exactly the three comparisons below — no word-wrap toggle, no whitespace toggle, no separate checks panel.
- **Review never opens on a session with no repository attached.** Such a session keeps files rather than changes: its review control is drawn at every moment and inert at every moment with the reason in its own tooltip, the chord that opens Review does nothing there however many files the session has written, and attaching a repository ([Spec-007 §Required Behavior](./007-repo-attachment-and-workspace-binding.md#required-behavior)) is what makes Review able to open on it.
- **Three comparisons, one at a time.** The uncommitted work with its file count; the branch's commits against the recorded base with their count; and the pull request, carrying its number, or reading that there is none and answering no press. Where the branch carries more than one request the scope lists them with a count, the newest open one standing first. Each comparison's empty line names the comparison it answered rather than the pane — no uncommitted changes, no changes against the base, no pull request yet — and a comparison still loading says so in that same place without blanking what is already drawn.
- **The base is read, never checked out.** The base picker draws the one ordered branch list the daemon supplies ([Spec-008 §Interfaces And Contracts](./008-worktree-lifecycle-and-execution-modes.md#interfaces-and-contracts)) and refuses nothing, because a diff base is read and never checked out. Typed text narrows the list, the arrow keys move through what is left, Enter takes the selection and relabels the control, Escape closes the menu with the base where it was, nothing matching draws one inert line saying so while keeping what was typed, and a list longer than the menu can hold draws what fits and says how many of how many it is showing. The picker opens on the project's default branch and never on the branch being compared: where the default IS that branch it opens on `main` or `master` if either is in the list, and otherwise on the first branch in the list that is not the current one. A base the user picked stands for as long as that branch is still in the list.
- **The branch comparison is the one commit list.** It holds the commits this session is responsible for, one line each: the short identifier, whose press copies the full one and says so for a moment; the subject; when it landed, in the user's own clock; and, where an agent made the commit, that agent's mark and name, with nothing where the user made it. Pressing a row narrows the diff, the counts and the file list to that one commit, exactly one at a time, and switching comparison or reloading returns the whole branch. There is no author column and no date column, because one person's name on every row says nothing, and the console draws no repository history at all — no lane graph, no branch-tips overview, no paging row, no commit search. Repository history is read in the session's own terminal or on the hosting service's own pages.
- **The pull-request comparison reads the request, and never guesses at it.** Its header carries the state beside the two facts the hosting read supplies — whether the request can merge or its branches conflict, and its review decision in plain words — each absent rather than guessed while the service has not settled it, and neither of them a control. Reviewers are listed one to a row under their own heading with each latest verdict in plain words, those who have been asked but have not answered standing separately, and with no verdict at all the heading is absent and the comparison says there is no review yet. The description is a card folded under the header whenever the comparison opens, showing its first line beside the word for it, opening and folding again on a press, and drawn not at all where the request has no description. The request's number is the door to its page on the hosting service: a press opens that address in the system browser, the way any address outside this machine opens, and it is drawn only while the daemon has supplied the address.
- **Attribution in the review surface is per file and per turn, never per line.** Each file row names the newest turn that touched it beside its counts, and a commit row carries the mark and name of the agent that made it. No gutter carries per-line authorship and no file row takes a colour bar for who changed it; the line-level provenance this spec records lives in the commit trailers, not in the pane's chrome.
- **A review note is a draft the daemon holds.** Notes are held by the daemon and scoped to the session, so a half-written review reaches the user's other devices; typed unsent text is never put in window storage. A held note is a card under its line carrying the file and line it points at, a one-line quote of that line, its own words, and an edit and a delete drawn plainly and at all times rather than on hover; it carries no reply and no resolve. A note left on the removed side of a rename cites the old path, so its line number still means something. A note whose line no longer exists in the diff is marked stranded and kept — still readable, editable and deletable — and is left out of any review posted to the hosting service.
- **A held note leaves in exactly three ways.** Composed into the draft as a steer: one message opening with a line asking for the review notes to be addressed, each note located by its file and line, focus moved to the draft, the notes cleared, and nothing sent — the message stays an ordinary user turn, since it already names every file and line the notes touched. Posted as one pull-request review under exactly one verdict. Or discarded. While any note is held it is one chip in the composer's attachment row saying how many, drawn beside any attached file rather than in place of it; pressing it opens the review surface on its notes tab, which carries the count and lists each note by its file and line with the send control beneath, and each entry there takes the reader to that line in the diff. The chip's own dismissal discards the notes behind one question asked in place on the chip. The count clears on those three things and on nothing else, so it can never stand for notes that are gone.
- **A post that partly failed says what did not go.** The send strip names the file and line of the note that failed and why, the notes that did post are marked sent and are never offered again, and the notes behind the failure stay held; a second press posts only what is still held.
- **The ship strip is read off the state, never remembered.** One sentence above the buttons says where the branch stands and what happens next — so many commits ahead of the base, so many files uncommitted, pushed with no request — and it is present in every state, including the one that offers no action. One next action follows from the state: uncommitted work commits, an unpushed branch pushes, a pushed branch with no request opens one, and otherwise none is offered. One alternate stands beside it, and for as long as the branch is behind its base that alternate is a pull, in place of whatever the state would otherwise have offered there; it goes the moment the branch is level, and it never displaces the next action, so a behind branch with uncommitted files still offers the commit first. The commit action is absent for as long as a merge, a rebase or a bisect is half-finished, and the state line names which one is open and the exact command that ends it — that pending operation being the daemon's fact like every other.
- **Committing takes the whole working folder.** There is no staging surface: nothing selects files, hunks or lines, the commit form says how many changed files it will sweep in, and the fold beneath the button shows the add that sweeps them before the commit runs. Splitting a commit is done in the session's own terminal. The commit form's subject label carries a live count of its characters against 72, the figure alone turning amber past it; it is a reading and never a limit — the field takes a subject of any length, the confirming control stays live, and nothing is refused, truncated or rewritten — and no other field carries one. Generating text writes the commit subject and body, or the pull-request title and description, from the working folder's diff, the branch name and the recent commit subjects; what it writes is editable, and pressing again rewrites it.
- **Pushing and opening a request.** A pull-request action carries its own push only when the branch has never left this machine; nothing else is folded in. Opening a request takes the base branch, whether it is a draft, its reviewers and its labels. The strip offers no amend and no force push — rewriting pushed history is done in the session's own terminal, and the strip re-reads the state when it is — and no merge: merge is out of scope, and the pane says so in the hosting service's own vocabulary rather than hiding the gap. Stacked requests and restore-from-review do not exist. A pull acts on press with no form, its command under the same fold, and runs under the user's own git identity; it acts on the branch this session is on, in the folder in front of the reader, and a tree elsewhere that has fallen behind is reached by moving to it. The behind figure the strip reads is the daemon's background fetch's, never a fetch of its own.
- **Every act leaves a record where the session can see it.** A commit, a push and an opened request each append one act row to the session's own flow naming what left this machine, and their outcomes are recorded by one settlement event, `git.settled`, so those rows survive a reload. Every push leaves the machine under the user's own hosting-CLI identity whether the user pressed or an agent ran it, and an agent's commit carries a git trailer naming it, so the history says who wrote it outside the console too. A result that arrives after the form it came from has closed, or after the surface was pointed at another session, updates nothing on screen — the act still happened and its row still stands. Each act asks the daemon for a fresh read the moment it finishes rather than waiting on the next watch tick, so the next action offered is true the instant the act lands, and a read that comes back for a session the surface has since left is dropped.
- **Nothing is swapped out from under the reader.** Tree staleness is a signal the daemon emits from watching the working folder ([Spec-008 §Interfaces And Contracts](./008-worktree-lifecycle-and-execution-modes.md#interfaces-and-contracts)) — the pane never infers it — and it shows as a reload mark whose reason says the tree changed; a pull request that has gained commits past the head the pane loaded raises the same mark with its own reason, held against that request so switching requests never raises it falsely. The diff is re-read only when the reader presses reload. A reload puts the line that was at the top of the pane back at the top of the pane however much the content above it grew or shrank, redraws only the files whose content actually changed, and changes nothing at all when the result is identical. A rebuild the reader caused — folding a file, opening a note — moves nothing.
- **The pull-request tab re-reads itself, and only itself.** While it is the comparison in view it re-reads the request's state and its threads on a cadence — often enough to be current, less often once the request is settled — so the state and the thread counts change under the reader as the hosting service reports them. The patch is never re-read or swapped with them.
- **Threads and checks.** A posted note is a hosting thread sitting at the line it is about, taking that thread's own reply and resolve; resolving it flips its state and drops the unresolved count. An unresolved thread stands open with its replies and its actions, and a resolved or outdated one folds to a single line at its anchor naming who left it, its state and how many replies it holds. Pressing a thread takes the reader to its line: the comparison that holds it, the file unfolded, the thread opened and the line brought into view and flashed; a thread with no line in the diff opens at its own card instead. The pull-request tab has no time-ordered feed — threads under one heading with the unresolved count, commits in the branch comparison, verdicts in the review rows, and nothing gathering the three into a stream — and the only free-standing body the surface offers is the summary that goes with a review verdict. A failing check opens its raw log at its end, because the useful part of a build log is the last of it, drawing only the lines on screen however long it is and saying above them how much was left out; the log carries exactly two controls, the one that sends the failure to the agent and the one that opens that check's own page on the hosting service in the system browser, and there is no save-to-file.
- **The surface never resolves a conflict.** It never draws a conflicted file, takes no side over another, edits nothing in place and marks nothing resolved: a half-finished merge or rebase is named on the state line with the command that ends it, and the conflicted file itself is read in the editor or in the session's own terminal.

## Default Behavior

- The default PR target branch is the worktree's recorded base branch.
- The default attribution mode is `run_attributed` when the daemon can correlate a diff to run provenance.
- `read-only` runs do not produce writable branch context or PR-preparation side effects.
- If multiple commits occur within one worktree during one run lineage, the system may prepare one cumulative PR by default.

## Fallback Behavior

- If precise attribution fails, the system must emit `workspace_fallback` diff artifacts with explicit labeling.
- If git hosting integration is unavailable, the system must still produce a PR-ready branch summary and diff artifact bundle.
- If the current branch is already checked out in an incompatible execution context, the system must require explicit user choice before proceeding.
- A read the review surface depends on that fails in a way that can be retried is retried once, after a short fixed pause in the daemon, before anything reaches the screen; no figure on screen depends on that pause. A failure that survives the retry is named in one line at the top of the pane saying which read it was, with a try-again at its right, and the diff already drawn stays exactly where it is until the new content is ready; the line goes when the read succeeds.
- A git read that failed is never rendered as an absent fact. The state line says which read it was and offers the try-again, and the strip's action buttons stay absent until the facts are back, because a button drawn on a fact the daemon does not have is the one thing the strip must never do.
- A command a strip action runs that fails is marked as failed in the fold that showed it, keeps a try-again that runs it again from where it stopped, and lands its cause as a row in the session's flow either way, so the record survives the pane.
- A pull-request read that fails backs off — the wait growing from seconds towards minutes until one succeeds — and the last state that was read stays on screen through every failure, so the tab never blanks.
- With no diff to draw the surface has four answers: a clean tree reads that there is nothing to review; a pane whose subject is gone closes itself and says so in one line; a read slow enough to be waited on says it is reading where the diff would be, so a fast read never flickers; and a failed read says the working folder could not be read, with the try-again beside it.
- A file the surface cannot draw says why as text in the body where the file would have been, in the console's own words and naming the cause — binary contents not shown, too large to show, permission denied, not a regular file — with the file's header above it unchanged, so its path, its counts and its open-in-editor control still work. A reason may be repeated in a tooltip but is never only in one.
- A failure while drawing the diff shows one short line in the body in place of whatever was there, and never replaces a diff that is already readable.
- While a run is live every control that would reach the agent waits, with the reason in its own tooltip.

## Interfaces And Contracts

- `BranchContextRead` must expose base, head, upstream, and worktree association.
- `DiffArtifactCreate` must identify attribution mode and compared states.
- `PRPrepare` must generate a reviewable proposal before any remote mutation.
- `GitActionExecute` must preserve causation to the requesting run or user.
- Git hosting uses a `GitHostingAdapter` interface with `gh` CLI as the V1 implementation. Normalized terminology: `createChangeRequest` (not `createPullRequest`). Auto-detect provider from git remote URL. See [Git Hosting Adapter](#git-hosting-adapter) below for full details.
- Clients reach this spec's surface under the `gitflow.*` wire namespace: the branch-context read, diff-artifact creation, pull-request preparation, and the git action execute that commits, pushes, pulls and opens a request.
- `PRPrepare`'s reviewable proposal is what the user reads and edits in the pull-request form before pressing — the base, the title and description, the draft flag, the reviewers and the labels — never a separate block in the session's conversation.
- One settlement event, `git.settled`, records the acts that left this machine, so their rows survive a reload. Its cause set is closed at three — `committed`, `pushed`, `pull_request_opened` — and each cause carries exactly the reference its row names: the commit's identifier, the branch, and the request's number with its address on the hosting service. The session event taxonomy registers the type and its payload ([Spec-005](./005-session-event-taxonomy-and-audit-log.md)).
- Two hosting operations beyond the adapter's read and create surface are owed: submitting a review with its verdict and its line-anchored notes, and resolving a review thread (§Git Hosting Adapter).
- Held review notes live in the daemon's session-scoped store beside the session's composer draft, which is the surface that carries them to the user's other devices; the review submission reads that store rather than taking note text off the wire from a client.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Branch and PR metadata belong to daemon-owned git projections.
- Diff artifacts must store attribution mode, provenance, and compared-state identifiers.
- The `diff_artifacts` table references `artifact_manifests` via foreign key. Plan-012 (artifacts) is a dependency of Plan-009 (Gitflow).
- Reviewable git actions require durable audit records.

## DiffArtifact and General Artifact Relationship

DiffArtifact is a SUBTYPE of the general artifact system defined in Spec-012. Every DiffArtifact IS an artifact -- it appears in artifact listings, has visibility control, content hashing, and all other artifact capabilities.

Schema relationship:

- The `diff_artifacts` table uses `artifact_manifests` (Plan-012) as its manifest, linked by a foreign key: `diff_artifacts.artifact_manifest_id -> artifact_manifests.id`.
- The corresponding `artifact_manifests` row carries `artifact_type = 'diff'` and the OCI-inspired manifest envelope (id, sessionId, runId, digest, size, artifactType, annotations, subject, createdAt).
- The `diff_artifacts` table adds extension columns specific to diff provenance: `attribution_mode`, `base_ref`, `head_ref`.

This subtype pattern means diff artifacts inherit all general artifact behaviors (deduplication via `content_hash`, visibility classes `local-only`/`shared`, state lifecycle `pending`/`published`/`superseded`, payload refs via `artifact_payload_refs`) without duplicating that infrastructure.

What a diff carries, per file, is the daemon's answer and never the client's inference:

- One word for what happened — added, deleted, renamed from the old path, mode changed — carried on the file's row and on its header, never by colour alone, and said once rather than repeated as a separate notice row above the file's changes. A file that was only edited carries no word.
- That file's own added and removed counts, and the newest turn that touched it.
- A file the agent edited more than once in one turn reaches the surface as ONE file: the daemon composes the edits into a single patch with true line numbers and one pair of counts, and the surface draws one row and one body for that path.
- A changed binary file is marked binary, and the surface writes that its contents are not shown where its lines would be; the file keeps its row, its header and its word, and counts that are zero because there are no lines are left off rather than drawn as zeros.
- A patch the daemon had to cut short says so twice: the comparison's sub-line ends by naming it partial, and the diff's own last row says the diff was cut there. The size at which a patch is cut is read from what the machine has, never from a fixed number of bytes.
- Every untracked file the repository does not ignore appears in the uncommitted comparison as a new file, its lines as additions and its counts in the totals, read from the repository's status without ever touching the index.
- A rename carries the path the file had before, so a note anchored on the removed side still means something.

How a diff is read is fixed by this spec, so every surface reading one reads it the same way:

- Every file folds to its header, and a folded file keeps its whole header — the path, its counts, and its open-in-editor and copy-path controls — so it still says what changed and still opens. The fold control tells assistive technology whether the file is open, and the keyboard presses it as a pointer does.
- There is no capped body and no row limit: a file is either folded to its header or shown whole, its rows built only as they scroll into view however long it is, and a folded file contributes no rows at all. Files that are noise start folded — lockfiles, generated files, and any file longer than the surface can show at once — and a fold or unfold by hand stands over that from then on. There is no second control that lifts a shortened body, because no body is shortened.
- One toggle folds every file, and it reads as pressed only while every file in the loaded diff is folded, re-reading itself when a single file is folded or unfolded by hand. Which files were folded is remembered per session and per file on that device and laid back over the diff whenever the surface opens on that session again — after a reload, after closing and reopening, and after a session switch — and a file no longer in the diff drops out of that memory.
- A collapsed gap between two changes opens a step at a time in the direction asked for, one screenful per press, with only the arrow the file's shape allows; a gap one step covers has no arrows and opens whole on a single press, and each press leaves the reading position where it was. The patch's technical range line is never drawn: the gap expander stands where one would, saying in words how many unchanged lines are hidden.
- Split view pairs runs of removed and added lines into one grid row so the halves cannot drift, and the left half carries no gutter and no notes, so a note has exactly one home. Where a removed line is paired with its added line the part that actually changed carries a stronger wash of the row's own colour, snapped out to whole words; the pair is left plainly washed when the two lines are the same, when either is very long, or when most of the line changed, so a rewritten line is never painted end to end.
- A file's line-number columns are as wide as that file's largest line number reads at the current text size and never narrower than two figures, both halves of split view sized the same way from the same file, so a number never spills into the code. A file with no newline at its end says so in one quiet row under its last line, spanning both halves as one row in split view rather than stranding it on one side.
- A line wider than the surface wraps at word boundaries with its continuations hung past the first row, so nothing is ever clipped and the diff never scrolls sideways; there is no wrap toggle.
- The file list is as wide as the longest path in the current list reads at the current text size, capped at a share of the pane so a deep path cannot eat into the diff, sized from its own drag edge and remembered at the width it is left at. It folds itself when the pane narrows past the point where it and one readable half of a diff both fit and comes back when the pane widens past it, while a fold made by hand with the header's control stands until it is undone by hand, so the two never fight.
- The file list is flat while every row fits the column at once and groups under faint folder headings the moment it does not, one heading per run of files, a folder holding a single child merged into one heading; the switch is read from how many rows the column can show at the current text size, never from a fixed number of files, and the filter, the selection and the diff's scroll are untouched by it. One filter box matches anywhere in a path, so an extension narrows the list as readily as a name does, and no second control filters it. In a path the folder is dimmed and truncates from its left while the file name keeps the row's own weight and never shrinks.
- The gutter control that opens a note is drawn on the row under the pointer, on the row that holds keyboard focus, and on every row from the start on a screen whose pointer cannot hover.
- Colouring arrives in two passes and the surface never computes it: a first pass is taken from the hunk's own lines the moment the file opens, and the whole file's spans replace it when they arrive, so a string that opens above the hunk corrects itself without the lines moving.

### Implementation Ordering

Plan-012 (general artifacts) MUST be implemented before Plan-009 (diff artifacts). Both reside in Tier 6 of the canonical build order, but Plan-009 declares a dependency on Plan-012 in its plan header.

The foreign key constraint `diff_artifacts.artifact_manifest_id REFERENCES artifact_manifests(id)` enforces this at the schema level: the `artifact_manifests` table must exist before `diff_artifacts` rows can be inserted.

### Artifact Storage Mechanism

Artifact content is stored outside the SQLite database using content-addressed storage (CAS).

**Local artifacts:**

- Filesystem CAS keyed by SHA-256 hash of the artifact content.
- Storage path: `<data_dir>/artifacts/<hash[0:2]>/<hash>` (first two hex characters as a directory prefix for fan-out).
- The `artifact_payload_refs.storage_path` column records this CAS key.

**Shared artifacts:**

- Blob store with an OCI-inspired manifest envelope.
- The `artifact_manifests` table stores the manifest metadata (including `content_hash` for deduplication).
- The `artifact_payload_refs` table stores the storage path or blob reference.

**Deduplication:**

- Identical content (same SHA-256 hash) produces the same CAS key, avoiding duplicate storage.
- The `artifact_manifests.content_hash` index enables fast lookup of existing content before writing.

## Git Hosting Adapter

**V1 Decision:** The default git hosting tool is `gh` (GitHub CLI).

**Rationale:**

- GitHub is the one hosting provider V1 targets.
- `gh` is well-maintained by GitHub and covers the operations needed for V1: PR creation, status checks, diff retrieval, and commenting.
- `gh` supports auth delegation via `gh auth`, avoiding the need for the daemon to manage OAuth tokens or personal access tokens directly.
- The adapter wraps `gh` CLI calls rather than using the GitHub REST API directly. This avoids token management complexity in V1 -- the daemon delegates authentication entirely to the user's existing `gh auth` session.

### GitHostingAdapter Interface

The adapter uses host-agnostic naming (`ChangeRequest` rather than `PullRequest`) so the interface can support future hosting providers without breaking callers.

| Operation | Description | Wraps (`gh` V1) |
| --- | --- | --- |
| `createChangeRequest(params)` | Creates a PR. Params: `baseBranch`, `headBranch`, `title`, `description`, `reviewers?` | `gh pr create` + `gh pr view <created-url> --json number,url` |
| `updateChangeRequest(params)` | Updates PR metadata (title, description, reviewers, labels). | `gh pr edit` |
| `listChangeRequests(params)` | Lists PRs for a repo, with optional state and label filters. | `gh pr list` |
| `getChangeRequestStatus(params)` | Returns PR status: open/merged/closed plus CI check results. | `gh pr view` |
| `addComment(params)` | Adds a comment to an existing PR. | `gh api …/issues/{number}/comments` (`gh pr comment` has no `--json`) |
| `submitReview(params)` | Submits one review carrying exactly one verdict — comment, approve or request changes — together with its line-anchored notes, each naming a file and a position. | `gh api repos/{owner}/{repo}/pulls/{pull_number}/reviews` |
| `resolveReviewThread(params)` | Marks one review thread resolved. | `gh api graphql` |

All operations accept a `repoMountId` to identify the target repository context and return structured results (not raw CLI output). Read operations (`listChangeRequests`, `getChangeRequestStatus`) parse `gh pr … --json` output into typed response objects. Write operations whose porcelain `gh pr` subcommand exposes **no** `--json` flag resolve their structured result via the JSON-returning REST path instead: `addComment` posts via `gh api repos/{owner}/{repo}/issues/{number}/comments` (returns `{ id, html_url }`), and `createChangeRequest` runs `gh pr create` (which prints only the new PR URL to stdout) then resolves the structured handle by passing that URL to `gh pr view <created-url> --json number,url` — never a bare `gh pr view`, which resolves the current branch's PR, not the one just created on an arbitrary `headBranch`. The adapter never scrapes porcelain stdout.

The two review operations take the REST path for the same reason. `gh pr review` accepts only a review body — it carries no per-file, per-line comments and exposes no `--json` — so a line-anchored review with a verdict goes through `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`, whose `event` parameter takes the verdict (`APPROVE`, `REQUEST_CHANGES`, `COMMENT`) and whose `comments` array carries each note's file and position ([GitHub REST: pull request reviews](https://docs.github.com/en/rest/pulls/reviews), accessed 2026-09-21). Resolving a thread has no `gh pr` subcommand at all (checked against `gh` 2.92.0), so it goes through the CLI's GraphQL passthrough.

`getChangeRequestStatus` must additionally return everything a reader needs to judge a request without leaving the console: its state, whether it can merge or its branches conflict, its review decision in plain words, each reviewer's latest verdict and the reviewers who have been asked but have not answered, its description body, its own web address on the service, and who authored it. All of these are `gh pr view --json` fields in the V1 implementation (`mergeable` and `mergeStateStatus`, `reviewDecision`, `latestReviews`, `reviewRequests`, `body`, `url`, `author`, `statusCheckRollup`; checked against `gh` 2.92.0). A fact the service has not settled yet must come back absent rather than guessed, and a surface renders each of these as a fact rather than as a control.

The author field is load-bearing for one refusal: a hosting service refuses an approval on a request the signed-in identity authored. The approve verdict therefore keeps its fixed place beside comment and request-changes and is offered disabled on the user's own request, with that reason given in its own tooltip, while the other two stay live and post exactly as they otherwise do. This is the one place on the review surface where a control is disabled rather than absent.

The adapter also reports the vocabulary the host uses, and one session's surfaces all speak it: where a host calls them pull requests the strip, the comparison and the number read pull request and carry `#`; where a host calls them merge requests the same places read merge request and carry `!`. Where the adapter cannot say which service it is, the pull-request wording stands. This is what host-agnostic `ChangeRequest` naming buys — the interface never changes, only the words a surface prints.

### Multi-Host Path (V2)

V1 ships with GitHub (`gh` CLI) only. The following adapters are documented as future work:

- **GitLab adapter:** Wraps `glab` CLI or the GitLab REST API. `glab` provides a similar CLI experience to `gh` for merge request operations.
- **Bitbucket adapter:** Wraps the Bitbucket REST API directly. There is no widely-used CLI equivalent for Bitbucket, so the adapter would use HTTP calls.

The `GitHostingAdapter` interface is designed to be host-agnostic -- all methods use generic `ChangeRequest` terminology, and callers never reference GitHub-specific concepts. Adding a new hosting provider requires implementing the interface without changing any calling code.

See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for the typed `GitHostingAdapter` interface definition.

## Example Flows

- `Example: A coding run edits files in a worktree, publishes a run-attributed diff artifact, and later prepares a PR against the recorded base branch.`
- `Example: Attribution metadata is incomplete after a recovery path. The system publishes a workspace fallback diff artifact and labels it as such in the timeline.`

## Implementation Notes

- Attribution quality is a first-class field, not an inferred UI decoration.
- PR preparation and diff production are related but distinct operations.
- Head or base branch changes after worktree creation must be explicit updates to the stored branch context.

## Pitfalls To Avoid

- Pretending workspace diffs are run-attributed when they are not
- Inferring PR base or head from transient client state
- Mutating remote git state without a reviewable preparation step

## Acceptance Criteria

- [ ] Writable coding runs in `branch`, `worktree`, or `ephemeral clone` mode always have an explicit branch context.
- [ ] Diff artifacts distinguish run-attributed and workspace-fallback attribution modes.
- [ ] PR preparation produces a reviewable proposal tied to base and head branch context.

## ADR Triggers

- If the system abandons worktree-centered Gitflow as the default coding path, create or update `../decisions/006-worktree-first-execution-mode.md`.

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- V1 decision: stacked PR workflows are deferred. The first release supports single-branch, single-PR proposal flow only.

## References

- [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)
- [Worktree Lifecycle And Execution Modes](../specs/008-worktree-lifecycle-and-execution-modes.md)
- [Spec-012](./012-artifacts-files-and-attachments.md)
