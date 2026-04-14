# CodexMonitor Feature Audit Report

Repo Path: `/home/sabossedgh/dev/CodexMonitor`
Date: 2026-04-14
Repo: `CodexMonitor`
Method: source-level audit of docs, frontend, Tauri backend, shared Codex core, and daemon RPC surface, plus a 6-agent `gpt-5.4` `xhigh` exploration pass and manual consolidation.

## Scope And Normalization

This report is a normalized feature inventory for the application as implemented in code, not just as described in `README.md`. Where documentation and implementation differ, implementation wins.

The app uses the word "agent" for multiple things. Normalized terms used below:

- Workspace agent: a Codex-backed conversation/thread running in a workspace.
- Worktree agent: a new workspace created as a git worktree of another workspace.
- Clone agent: a copied workspace created from another workspace directory.
- Subagent: a child thread surfaced by Codex and attached under a parent thread.
- Queued follow-up: a client-side follow-up user message stored locally and sent later to an existing active thread.

## Executive Summary

CodexMonitor is a Tauri application for running and organizing many Codex conversations across many local or remote workspaces. The product is broader than a chat shell. It combines:

- multi-workspace orchestration
- thread and subagent management
- queued and steered follow-ups
- git and GitHub operations
- prompt libraries
- file browsing and file mentions
- review workflows
- local and remote Codex backends
- desktop, mobile, tray, terminal, and notification surfaces
- a large settings surface for Codex, environments, agents, apps, dictation, and platform behavior

The most important implementation detail is that the app is primarily a client for `codex app-server`, not a separate agent runtime. It wraps Codex's JSON-RPC interface, adds local state and UX on top, and forwards most operations through a shared backend core used by both desktop and daemon modes.

## 1. Codex Integration And Runtime Model

### 1.1 How it calls Codex

Local mode launches Codex by spawning:

```text
codex [extra args] app-server
```

Key behaviors:

- discovers Codex from configured `codexBin` or `PATH`
- augments `PATH` with common install locations
- verifies the binary with `codex --version`
- launches in the target workspace `cwd`
- can set `CODEX_HOME`
- initializes the app-server connection with `experimentalApi: true`
- speaks newline-delimited JSON-RPC over stdio
- tracks requests by workspace and thread
- emits synthetic connection events such as `codex/connected`

### 1.2 Local vs remote backend

The app supports two backend modes:

- Local desktop mode: Tauri spawns and manages `codex app-server` directly.
- Remote mode: the desktop or mobile client talks to a CodexMonitor daemon over TCP with token authentication. The daemon reuses the same shared Codex core and forwards most of the same commands.

Remote support includes:

- saved remotes on mobile
- host and token configuration
- connect-and-test flow
- desktop daemon start, stop, and status
- Tailscale helper and command preview

Important constraints:

- only `tcp` remote provider exists
- retries after disconnect are limited and mostly read-oriented
- mutating operations are generally not retried

### 1.3 Codex requests the app actually sends

User-visible Codex operations surfaced by the client include:

- `thread/start`
- `thread/resume`
- `thread/read`
- `thread/fork`
- `thread/list`
- `thread/archive`
- `thread/compact/start`
- `thread/name/set`
- `turn/start`
- `turn/steer`
- `turn/interrupt`
- `review/start`
- `model/list`
- `experimentalFeature/list`
- `collaborationMode/list`
- `skills/list`
- `app/list`
- `account/login/start`
- `account/login/cancel`
- `account/read`
- `account/rateLimits/read`

Important missing or partial surfaces:

- no client request surface for upstream `spawn_agent`
- no client request surface for upstream `send_input`
- no client request surface for upstream `wait`
- no client request surface for upstream `close_agent`
- no client request surface for upstream `resume_agent`
- no client send path for `thread/unarchive`
- no real live-thread subscription stream; "live attach" is synthetic client state

### 1.4 Turn payload and policy nuances

The app's `turn/start` payload can include:

- text
- local, data-URL, or URL-backed images
- app mentions
- model
- reasoning effort
- nullable `serviceTier`
- collaboration mode
- workspace `cwd`
- approval policy
- sandbox policy

Important implementation details:

- per-thread runtime Codex-args overrides intentionally do not let the user change model, approval policy, sandbox policy, full-auto, bypass, OSS mode, local-provider mode, or no-alt-screen flags through that override channel
- `thread/start` always uses `approvalPolicy: "on-request"` regardless of selected access mode
- the default `workspaceWrite` sandbox policy used for turns sets `networkAccess: true`

## 2. Queue, Steer, Stop, Pause, Resume, And Multi-Agent Semantics

This section is the most important behavioral normalization in the codebase.

### 2.1 Queue vs steer

Follow-up messages sent while a thread is already processing can use one of two modes:

- Queue: store the follow-up locally and send it later when the active turn finishes.
- Steer: send the follow-up immediately to the current active turn via `turn/steer`.

Actual behavior:

- the default follow-up mode is configurable in settings
- `Shift+Cmd/Ctrl+Enter` sends using the opposite mode for a single message
- steer is only attempted when steer support is enabled and the thread has an active turn id
- otherwise the client falls back to queueing
- queued follow-ups are per-thread, FIFO, local, sequential, uncapped, and in-memory
- queue flushing only runs for the currently active thread
- if steer fails, automatic requeue happens in the composer path, not in every direct send helper

What this means in practice:

- queue is a client feature, not a Codex server-side queue
- steer is a Codex turn mutation feature, but only when an active turn exists
- there is no evidence of a persistent server-backed task queue for agents

### 2.2 Stop vs pause

"Stop" is real. "Pause" is much narrower than the UI language may suggest.

Stop behavior:

- the client optimistically clears local processing state
- it shows a "Session stopped." system message
- it sends `turn/interrupt`
- if a turn id is not available yet, it stores a pending interrupt and sends it once `turn/started` arrives

Pause behavior:

- there is no true active-turn pause or unpause operation
- the app only pauses queued-message flushing in a narrow case: when a queued follow-up exists and Codex requires user input or plan approval/changes before continuing
- this is a queue-drain pause, not a runtime pause of Codex execution

### 2.3 Resume semantics

`/resume` and `thread/resume` do not mean "resume a paused turn."

Actual meaning:

- refresh or reattach thread state from Codex
- blocked while the thread is currently processing
- implementation skips resume if the local snapshot is already present in some flows

Normalized conclusion:

- stop = interrupt current turn
- pause = suspend queued follow-up flushing in specific UX states
- resume = re-read or reattach thread state, not continue a suspended turn

### 2.4 Multi-agent support

The app absolutely has a multi-agent story, but it is a mix of real capability and configuration/UI layering.

Real multi-agent related capabilities:

- create a new top-level agent thread
- create a new worktree agent
- create a new clone agent
- display child subagents under parent threads
- group detached review children back under the parent thread
- hide internal `memory_consolidation` children
- cascade archive behavior from parent to subagent descendants
- store and edit managed agent config files
- expose `features.multi_agent`, `agents.max_threads`, and `agents.max_depth`

Current implementation limits:

- thread and depth limits are configured but not locally enforced at runtime
- enforcement appears to rely on upstream Codex
- the client does not directly expose upstream spawn/wait/close/resume-agent operations
- collaboration mode is included on `turn/start`, not on `turn/steer`

Normalized conclusion:

- CodexMonitor can orchestrate many agent threads and visualize subagents
- it does not expose the full upstream agent-orchestration API surface directly
- a large part of the "multi-agent" behavior is thread/workspace orchestration plus settings, not a full custom agent scheduler

## 3. Workspace, Project, And Home Surfaces

### 3.1 Workspace lifecycle

The app can:

- add workspaces from multiple paths at once
- validate directories and dedupe imports
- expand `~/`
- auto-restore and auto-connect workspaces
- refresh workspaces on focus and visibility changes
- connect and disconnect workspaces
- remove workspaces
- open workspaces in configured external tools

Mobile and remote-specific behavior:

- replaces native directory picking with server-path entry
- stores recent server paths for reuse

### 3.2 Project grouping and navigation

The sidebar and project settings support:

- project groups
- reserved `Ungrouped`
- persistent group ordering
- persistent project ordering within groups
- organize modes: `By project`, `By project activity`, `Thread list`
- sort modes: `Updated`, `Created`
- persisted collapse state

Important edge behavior:

- worktrees inherit parent group
- clone agents are nested under the source project in the sidebar even though they are stored as main workspaces
- project activity mode does not account for worktree-child activity

### 3.3 Home and workspace-home

There are two distinct higher-level surfaces:

- Home dashboard
- workspace-home for a selected workspace with no active thread

Home dashboard provides:

- quick-add actions
- latest agents strip
- usage snapshot
- workspace filtering
- token/time toggle
- periodic refresh while visible
- week navigation
- top models
- account limit display

Workspace-home provides:

- full composer
- image attachments
- skills, apps, prompt, and file autocomplete
- inline `AGENTS.md` editing
- recent runs
- recent threads
- optional git-init banner
- run controls for local vs worktree execution

### 3.4 Worktrees and cloned workspaces

Worktree features:

- create worktrees with optional display name
- branch suggestion and slugging
- optional copy of `AGENTS.md`
- editable per-project setup script
- configurable placement precedence
- branch from local or matching remote-tracking refs
- auto-open setup terminal in some flows
- rename-in-place
- follow-up rename to upstream branch
- copy `cd` command
- reveal in file manager

Clone features:

- create a copied workspace from an existing workspace
- prompt for a copy name
- suggest a `<repo>-copies` directory
- persist copies folder by project group
- preserve or infer lineage from source workspace

Repository import from URL:

- clone remote repository into a chosen parent folder
- optional target-name override
- validation before create

## 4. Threads, Composer, Messages, Plans, And Approvals

### 4.1 Thread list and navigation

Capabilities:

- search threads by workspace, thread title, model, or reasoning effort
- debounce search
- pin top-level threads
- show pinned roots in a separate cross-workspace section
- collapse subagent trees
- search older threads
- load older threads
- thread buckets in thread-list mode: Now, Earlier today, Yesterday, This week, Older
- include active or processing threads even when truncation would normally hide them
- include required parents so subagents remain navigable

Context-menu features include:

- rename thread
- sync from server
- pin or unpin
- copy thread id
- archive
- reload workspace threads
- delete workspace
- show worktree/clone in file manager
- delete worktree/clone

### 4.2 Composer

Composer capabilities:

- send on `Enter`
- newline on `Shift+Enter`
- queue or steer follow-ups while processing
- show follow-up hint
- edit or delete queued follow-ups before flush
- prompt history per logical composer key
- image attachments via picker, drag-drop, or paste
- attachment dedupe
- image preview from filesystem, data URL, or HTTP URL
- draft persistence keyed by thread or workspace draft key
- slash commands
- prompt autocomplete
- skill autocomplete
- app autocomplete
- file mention autocomplete
- dictation state handling
- optional per-thread Codex args profile
- collaboration mode selector or Plan toggle
- model, effort, access, and usage-ring controls

Editing helpers:

- auto-wrap pasted multiline or code-like text
- expand code fence triggers on `Space` or `Enter`
- continue markdown lists on `Shift+Enter`

### 4.3 Slash commands

Supported slash commands:

- `/apps`
- `/compact`
- `/fast`
- `/fork`
- `/mcp`
- `/new`
- `/resume`
- `/review`
- `/status`

Command notes:

- slash commands ignore attached images
- `/new` creates a new thread and then sends remaining text
- `/resume` means thread refresh semantics, not active-turn unpause

### 4.4 Message rendering and interaction

The app renders and groups:

- user and assistant messages
- reasoning items
- review items
- user-input requests
- diffs
- tool items
- explore items

Message capabilities:

- copy
- quote into composer
- image lightbox
- grouped tool and reasoning summaries
- inline diffs for file-change tools
- delayed command-output rendering for live tools
- last-200-line output capping for command tool display
- export plan tool output as Markdown
- in-app thread links via `thread://...` or `/thread/...`
- clickable file-like path chips
- system-open for external URLs

### 4.5 Plans and approvals

Plan and approval features:

- plan panel with explanation and numbered state rows
- plan-ready follow-up card with `Implement` and `Send changes`
- per-thread plan-card dismissal tracking
- toast-based approval stack
- keyboard approval on `Enter` outside editable fields
- `Decline`, `Always allow`, and `Approve`
- remembered approval prefixes for future auto-accept
- request-user-input surface for first pending request in the active thread/workspace

## 5. Git, GitHub, And Review Workflows

### 5.1 Git support

Implemented git capabilities include:

- detect repo root
- init repo
- read status
- read staged and unstaged diffs
- commit diff inspection
- branch list
- branch create
- branch checkout
- stage file
- unstage file
- discard file changes
- stage all
- unstage all
- commit
- commit and push
- fetch
- pull
- push
- sync
- ahead/behind and upstream reporting
- AI-generated commit messages
- image and binary diff handling

Important constraints:

- ignores skip-worktree and gitignored files
- text diff size cap around 2 MB
- image cap around 10 MB
- discard can fall back to `git clean`
- `git` CLI is a hard dependency for mutating operations

### 5.2 GitHub support

Implemented GitHub capabilities include:

- create a GitHub repository from the current local repo
- validate or add `origin`
- push current `HEAD`
- patch default branch
- browse open issues
- browse open pull requests
- fetch PR details
- parse and display `gh pr diff`
- load PR comment timeline
- checkout a PR branch

Important constraints:

- open issues and open PRs only
- result caps around 50
- comment loading uses issue comments and does not provide full inline review-thread fidelity
- no broad app-side GitHub writeback flow beyond repo creation and PR checkout
- `gh` CLI is a hard dependency for GitHub operations

### 5.3 Review support

The app supports:

- generic `/review`
- review of uncommitted changes
- review of a base branch
- review of a specific commit
- custom review instructions
- inline or detached review delivery

PR-aware review UX includes:

- selecting a PR to prefill the composer
- `Ask PR` send label
- commit-review shortcuts
- truncation and sanitization of PR material before sending it to Codex

## 6. Prompts, Files, AGENTS.md, And Config Editing

### 6.1 Prompt library

Prompt features:

- workspace and global prompt directories
- create prompt
- edit prompt
- delete prompt
- move prompt
- store prompt as `.md`
- frontmatter metadata
- run prompt in current thread
- run prompt in a new agent/thread
- autocomplete insertion via `/prompts:name`
- placeholder hints
- named placeholder substitution via `key=value`

Important limitation:

- prompt CRUD and folder discovery appear to be local-desktop behavior in practice; remote bridging is notably weaker here than for core Codex and git flows

### 6.2 File browsing and mentions

The file-tree system powers both a files panel and composer mentions.

Capabilities:

- lazy load tree
- virtualized folder-first browsing
- search
- modified-only filter
- expand-all and collapse-all
- mention path insertion
- text and image preview
- multi-line snippet mention with `path:Lx-Ly`
- reveal in file manager
- open in configured editors or commands

Current constraints:

- polling-based updates, not file watching
- skips `.git`, `node_modules`, `dist`, `target`, `release-artifacts`
- no symlink following
- preview limited to UTF-8 text or images
- preview cap around 400 KB
- line-aware editor opening works only for VS Code, Cursor, and Zed

### 6.3 Scoped config editing

The app has first-class editors for:

- workspace `AGENTS.md`
- global `~/.codex/AGENTS.md`
- global `~/.codex/config.toml`
- managed per-agent config TOML files

Important limitation:

- generic workspace file editing is not a first-class feature; the general file panel is read-only preview, not a general-purpose file editor

## 7. Agent Settings, Models, Collaboration, Apps, And Other Settings

### 7.1 Major settings sections

Verified settings sections:

- Projects
- Environments
- Display & Sound
- Composer
- Dictation
- Shortcuts
- Open in
- Git
- Server
- Agents
- Codex
- Features
- About

Mobile uses a master-detail layout below the responsive threshold.

### 7.2 Codex and model controls

The settings surface can configure:

- default Codex path and args
- Codex doctor
- Codex update
- default model
- reasoning effort
- access mode
- review mode
- editors for global `AGENTS.md` and `config.toml`

Model behavior:

- model list is sourced from the first connected workspace
- configured model is merged in even if not returned live
- GPT variants are specially sorted
- reasoning selector is disabled when unsupported by the selected model

### 7.3 Agent settings

Agent-related settings include:

- toggle multi-agent support
- configure `max_threads`
- configure `max_depth`
- create custom agents
- update custom agents
- delete custom agents
- rename managed config files
- edit managed agent TOML

Known defaults and caps surfaced in code/docs:

- upstream default `agents.max_threads = 6`
- CodexMonitor default `max_depth = 1`
- UI/backend caps `max_threads <= 12`
- UI/backend caps `max_depth <= 4`

### 7.4 Collaboration modes

Collaboration mode support is real and dynamic.

Capabilities:

- fetch available collaboration modes from Codex
- fall back to sensible defaults when needed
- carry developer instructions, model, and reasoning metadata
- simplify to a Plan toggle when only `default` and `plan` exist
- send selected mode on `turn/start`

Important nuance:

- collaboration mode is not applied through `turn/steer`

### 7.5 Apps integration

The app has a separate Apps integration surface:

- app list fetched from Codex when enabled and connected
- accessible apps prioritized in UI
- refresh from app-server events
- `$app` autocomplete
- `/apps` output showing connected and installable apps
- install URLs surfaced for installable apps

### 7.6 Other notable settings capabilities

Additional verified settings/features:

- usage limits display as used vs remaining
- tray synchronization for usage state
- dictation with on-device Whisper models
- dictation download, cancel, remove, and permissions
- sound and system notification toggles
- long-running-run notifications when unfocused
- updater check and install
- debug panel configuration
- open-in target ordering and validation
- backend mode, daemon, and Tailscale settings
- visual effect toggles such as transparency reduction and platform-specific window materials

## 8. Terminal, Debugging, Usage, Notifications, And Platform Surfaces

### 8.1 Embedded terminal

The terminal dock is desktop-only and provides:

- tab strip
- new terminal tab
- per-tab close
- horizontal resize
- per-workspace tab association
- auto-renumbered tabs
- lazy session open
- buffered output restore
- backend resize handling
- output cap around 200,000 characters
- overlay states

### 8.2 Debug and usage surfaces

Debug capabilities:

- debug dock or full display
- copy log
- clear log
- resize
- log retention cap
- compact-layout behavior changes

Usage surfaces:

- session and weekly limit readouts
- reset and credits labels
- usage ring in composer
- tray recent-thread summary on macOS

### 8.3 Notifications and platform behavior

Verified platform behaviors:

- system notifications for long-running runs
- notification body truncation
- macOS tray support
- debug-build macOS notification fallback
- global zoom shortcuts
- terminal and debug shortcuts suppressed while typing

## 9. Limitations, Gaps, And Doc Drift

These are important to understand if this audit is being used for planning, product positioning, or reverse engineering.

### 9.1 Real gaps in supported Codex features

- no direct client surface for upstream spawn/wait/close/resume-agent operations
- no true pause or unpause of an active Codex turn
- no real thread live-subscribe transport despite some "live attach" naming
- no client send path for unarchive
- missing handling for several upstream request and notification types

### 9.2 Real product limitations

- queue is local in-memory only
- queue flushing only tracks the active thread
- prompt CRUD is weaker in remote mode than core Codex flows
- generic workspace files are previewable but not generally editable
- GitHub coverage is narrower than the Git surface and weak on inline review-thread fidelity
- add-clone remote bridging appears incomplete compared with daemon support
- worktree and clone behaviors have some nesting and activity-model inconsistencies

### 9.3 Known implementation bugs or mismatches

- remote-mode remembered approval rule bug: remote flow exposes the capability in the daemon, but one Tauri command path does not forward it correctly and can write locally instead
- README/docs overstate or misdescribe some semantics, especially around `thread/resume`
- docs mention `thread/read` as missing even though code implements it
- some follow-up requeue behavior is composer-specific rather than universal

## 10. Bottom-Line Capability Statement

The application is best understood as a multi-workspace Codex operations console.

It can:

- launch and manage Codex sessions locally or through a remote daemon
- organize many workspaces, worktrees, clones, threads, and visible subagents
- send normal turns, queued follow-ups, steered follow-ups, reviews, compactions, and forks
- manage prompts, file mentions, approvals, plans, and collaboration modes
- integrate with git, GitHub, notifications, terminal tabs, and usage/account surfaces

It cannot currently be described as:

- a full custom multi-agent scheduler with first-class spawn/wait/close/resume-agent controls
- a system with true server-backed follow-up queueing
- a system with real pause/unpause of active Codex execution

## 11. Primary Evidence Hotspots

High-value files for follow-up inspection:

- `README.md`
- `docs/codebase-map.md`
- `docs/app-server-events.md`
- `docs/multi-agent-sync-runbook.md`
- `src/services/tauri.ts`
- `src/features/threads/hooks/useQueuedSend.ts`
- `src/features/threads/hooks/useThreadMessaging.ts`
- `src/features/app/hooks/useMainAppComposerWorkspaceState.ts`
- `src/features/workspaces/hooks/useWorkspaceHome.ts`
- `src/features/settings/components/sections/SettingsAgentsSection.tsx`
- `src/features/messages/components/Messages.tsx`
- `src/features/messages/utils/messageRenderUtils.ts`
- `src-tauri/src/shared/codex_core.rs`
- `src-tauri/src/shared/agents_config_core.rs`
- `src-tauri/src/codex/mod.rs`
- `src-tauri/src/lib.rs`

## 12. Audit Note

This report is exhaustive with respect to the inspected code paths and surfaced capabilities. It is source-derived, not a full click-by-click runtime certification of every UI path. Where the code clearly defines a feature, it is included. Where the code clearly limits or contradicts a claimed feature, the limitation is documented.
