# CodexMonitor Comprehensive Architecture and Feature Review

Repo path: `/home/sabossedgh/dev/external/CodexMonitor`
Date: 2026-04-14
Version: 0.7.68
Method: deep source-level audit of Tauri backend (Rust), frontend (React/TypeScript), daemon binary, remote backend, and all shared cores.

This review provides deep architectural analysis and an explicit signature-feature gap assessment against the 5 ai-sidekicks capabilities. Appendix A contains the full user-facing feature audit with per-feature evidence trails.

---

## 1. Technology Stack

| Layer               | Technology                                   | Evidence                                       |
| ------------------- | -------------------------------------------- | ---------------------------------------------- |
| Desktop runtime     | Tauri 2.10.3                                 | `src-tauri/Cargo.toml`                         |
| Backend language    | Rust (edition 2021)                          | `src-tauri/Cargo.toml`                         |
| Frontend framework  | React 19.1.0                                 | `package.json`                                 |
| Build tool          | Vite 7.0.4                                   | `package.json`, `vite.config.ts`               |
| Language            | TypeScript 5.8.3                             | `package.json`                                 |
| Test framework      | Vitest 3.2.4                                 | `package.json`                                 |
| Terminal emulation  | xterm.js 5.5.0                               | `package.json`                                 |
| Git library (Rust)  | git2 0.20.3 (vendored libgit2 + openssl)     | `src-tauri/Cargo.toml`                         |
| Markdown rendering  | react-markdown 10.1.0 + remark-gfm           | `package.json`                                 |
| Diff rendering      | @pierre/diffs 1.0.6                          | `package.json`                                 |
| Syntax highlighting | prismjs 1.30.0                               | `package.json`                                 |
| Virtualized lists   | @tanstack/react-virtual 3.13.18              | `package.json`                                 |
| Error tracking      | @sentry/react 10.36.0                        | `package.json`                                 |
| Speech-to-text      | whisper-rs 0.12 (desktop only)               | `src-tauri/Cargo.toml`                         |
| Audio capture       | cpal 0.15 (desktop only)                     | `src-tauri/Cargo.toml`                         |
| PTY                 | portable-pty 0.8 (desktop only)              | `src-tauri/Cargo.toml`                         |
| TCP networking      | tokio (net, io-util) + tokio-tungstenite     | `src-tauri/Cargo.toml`                         |
| HTTP client         | reqwest 0.12 (rustls-tls)                    | `src-tauri/Cargo.toml`                         |
| TOML editing        | toml_edit 0.20.2                             | `src-tauri/Cargo.toml`                         |
| macOS glass effects | tauri-plugin-liquid-glass                    | `src-tauri/Cargo.toml`, `package.json`         |
| Platform targets    | macOS, Linux, Windows, iOS (Android partial) | `src-tauri/src/lib.rs` conditional compilation |

---

## 2. Architecture Overview

### 2.1 System topology

CodexMonitor has two primary runtime modes:

**Local desktop mode:**

```
[React Frontend] --IPC invoke--> [Tauri Rust Backend] --stdio JSON-RPC--> [codex app-server]
```

**Remote/daemon mode:**

```
[React Frontend] --IPC invoke--> [Tauri Rust Backend] --TCP JSON-RPC--> [codex-monitor-daemon] --stdio JSON-RPC--> [codex app-server]
```

The mobile client (iOS) always uses remote mode.

### 2.2 Process model

- One `codex app-server` process is spawned per workspace session (`src-tauri/src/backend/app_server.rs:749-794`).
- Multiple workspaces can share a single session via `register_workspace()` and `register_workspace_with_path()` on `WorkspaceSession` (`app_server.rs:451-478`).
- Communication with Codex is newline-delimited JSON-RPC over stdio.
- Request tracking uses atomic `u64` IDs with `oneshot` channels for response correlation.
- A 300-second per-request timeout is enforced (`REQUEST_TIMEOUT`, `app_server.rs:432`).
- Background thread callbacks use `mpsc::UnboundedSender<Value>` channels for commit message generation and similar background tasks (`app_server.rs:444`).

### 2.3 Data flow for a user message

1. Frontend `useQueuedSend.ts` resolves intent (send/queue/steer).
2. `useThreadMessaging.ts` calls `sendUserMessageService()` or `steerTurnService()` from `src/services/tauri.ts`.
3. Tauri IPC bridges to `codex::send_user_message` or `codex::turn_steer` in `src-tauri/src/codex/mod.rs`.
4. If remote mode, the call is forwarded via `remote_backend::call_remote()`.
5. If local mode, `codex_core::send_user_message_core()` builds the `turn/start` payload and sends it via `WorkspaceSession::send_request_for_workspace()`.
6. The `codex app-server` stdout reader loop (`app_server.rs:800+`) parses responses and notifications.
7. Events are emitted via `EventSink::emit_app_server_event()` to the frontend through Tauri's event system.
8. Frontend `useAppServerEvents.ts` routes events to thread hooks/reducer for state updates.

### 2.4 State architecture

**Backend state** (`src-tauri/src/state.rs`):

- `AppState` holds `Mutex<HashMap<String, WorkspaceEntry>>` for workspaces, `Mutex<HashMap<String, Arc<WorkspaceSession>>>` for sessions, `Mutex<AppSettings>` for settings, `Mutex<Option<RemoteBackend>>` for remote connection, `Mutex<TcpDaemonRuntime>` for daemon, terminal sessions, dictation state, and login cancellation state.
- Persisted to `workspaces.json` and `settings.json` in the Tauri app data directory.

**Frontend state**:

- Thread state managed via `useThreadsReducer.ts` with slices: `threadLifecycleSlice.ts`, `threadItemsSlice.ts`, `threadConfigSlice.ts`, `threadSnapshotSlice.ts`, `threadQueueSlice.ts`.
- Workspace state via `useWorkspaces.ts`.
- Settings via `useAppSettings.ts` through `useAppSettingsController.ts`.
- No external state management library (Redux/Zustand); all state is React hooks and context.

---

## 3. Complete Feature Inventory

This inventory is organized by functional area. For exhaustive per-feature detail, see `codexmonitor-feature-audit-report.md`. Below adds evidence paths and structural context.

### 3.1 Codex session management

| Capability                                         | Evidence                                                |
| -------------------------------------------------- | ------------------------------------------------------- |
| Spawn `codex app-server` per workspace             | `src-tauri/src/backend/app_server.rs:749-794`           |
| Discover Codex binary from PATH + common locations | `app_server.rs:563-644`                                 |
| Verify binary with `codex --version`               | `app_server.rs:700-747`                                 |
| Initialize with `experimentalApi: true`            | `app_server.rs:419-429`                                 |
| Track requests by ID with timeout                  | `app_server.rs:494-541`                                 |
| Route events to correct workspace by thread ID     | `app_server.rs:280-306`, `extract_related_thread_ids()` |
| Hide `memory_consolidation` subagent threads       | `app_server.rs:372-383`                                 |
| CODEX_HOME resolution per workspace/parent         | `src-tauri/src/shared/codex_core.rs:230-238`            |

### 3.2 Thread operations (JSON-RPC)

Sent to `codex app-server`:

- `thread/start` -- `codex_core.rs:251-265`
- `thread/resume` -- `codex_core.rs:267-277`
- `thread/read` -- `codex_core.rs:279-289`
- `thread/fork` -- `codex_core.rs:315-325`
- `thread/list` -- `codex_core.rs:327-348` (with `sourceKinds` filter)
- `thread/archive` -- `codex_core.rs:363-373`
- `thread/compact/start` -- `codex_core.rs:375-385`
- `thread/name/set` -- `codex_core.rs:387-398`
- `turn/start` -- `codex_core.rs:474-526`
- `turn/steer` -- `codex_core.rs:528-549`
- `turn/interrupt` -- `codex_core.rs:562-573`
- `review/start` -- `codex_core.rs:575-592`
- `collaborationMode/list` -- `codex_core.rs:552-560`
- `model/list` -- `codex_core.rs:594+`
- `experimentalFeature/list` -- `codex/mod.rs:541-563`
- `skills/list` -- `codex/mod.rs:793-809`
- `app/list` -- `codex/mod.rs:812-836`
- `mcpServerStatus/list` -- `codex_core.rs:350-361`
- `account/login/start` + `account/login/cancel` -- `codex/mod.rs:754-790`
- `account/read` -- `codex/mod.rs:735-751`
- `account/rateLimits/read` -- `codex/mod.rs:716-732`
- `thread/live_subscribe` / `thread/live_unsubscribe` -- synthetic client events (`codex/mod.rs:134-207`)

### 3.3 Workspace and worktree model

| Capability                              | Evidence                                                               |
| --------------------------------------- | ---------------------------------------------------------------------- |
| Add workspaces from paths (multiple)    | `src-tauri/src/workspaces/`                                            |
| Clone from git URL                      | `workspaces::add_workspace_from_git_url` in `lib.rs:199`               |
| Create worktrees with branch suggestion | `workspaces::add_worktree` in `lib.rs:203`                             |
| Create clone copies                     | `workspaces::add_clone` in `lib.rs:201`                                |
| Worktree setup scripts                  | `worktree_setup_status`, `worktree_setup_mark_ran` in `lib.rs:202-203` |
| Remove workspace/worktree               | `lib.rs:205-206`                                                       |
| Rename worktree + upstream branch       | `lib.rs:207-208`                                                       |
| Apply worktree changes                  | `lib.rs:209`                                                           |
| Auto-restore workspaces on launch       | `useWorkspaceRestore.ts`                                               |
| Refresh on focus                        | `useWorkspaceRefreshOnFocus.ts`                                        |
| Open in external tools                  | `useWorkspaceLaunchScripts.ts`, `open_workspace_in` command            |
| File tree browsing                      | `useWorkspaceFiles.ts`, `list_workspace_files` command                 |
| Group management                        | `useWorkspaceGroupOps.ts`, `useCollapsedGroups.ts`                     |

### 3.4 Git and GitHub

| Capability                                 | Evidence                                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Detect repo root, init, status, diff       | `src-tauri/src/git/mod.rs` (612 lines), `src-tauri/src/shared/git_core.rs`, `src-tauri/src/shared/git_ui_core.rs` |
| Branch list/create/checkout                | `lib.rs:260-262`, `useGitBranches.ts`, `useBranchSwitcher.ts`                                                     |
| Stage/unstage/discard (file and all)       | `lib.rs:248-254`                                                                                                  |
| Commit, push, pull, fetch, sync            | `lib.rs:255-259`                                                                                                  |
| AI commit message generation               | `codex::generate_commit_message` (`codex/mod.rs:891-941`)                                                         |
| Git log with ahead/behind tracking         | `get_git_log`, `GitLogResponse` type                                                                              |
| Image and binary diff handling             | `GitFileDiff` type with `isImage`, `isImage`, `oldImageData/newImageData`                                         |
| GitHub: create repo, list issues, list PRs | `lib.rs:236-244`                                                                                                  |
| GitHub: PR diff, PR comments, checkout PR  | `lib.rs:243-246`                                                                                                  |
| PR-aware review UX                         | `usePullRequestComposer.ts`, `usePullRequestReviewActions.ts`                                                     |
| Split/unified diff view                    | `GitDiffViewer.tsx`, `GitDiffPanel.tsx`                                                                           |
| Branch switcher with shortcut              | `useBranchSwitcher.ts`, `useBranchSwitcherShortcut.ts`                                                            |

### 3.5 Composer

| Capability                                     | Evidence                                            |
| ---------------------------------------------- | --------------------------------------------------- |
| Text entry, Enter to send, Shift+Enter newline | `src/features/composer/hooks/useComposerKeyDown.ts` |
| Image attachments (picker/drag/paste)          | `useComposerImages.ts`, `useComposerImageDrop.ts`   |
| Queue/steer follow-ups                         | `useQueuedSend.ts`                                  |
| Draft persistence                              | `useComposerDraftEffects.ts`                        |
| Prompt autocomplete                            | `useComposerAutocomplete.ts`                        |
| Slash commands                                 | Parsed in `useQueuedSend.ts:77-106`                 |
| Prompt history                                 | `usePromptHistory.ts`                               |
| App mentions (`$app`)                          | `ComposerInput.tsx`, `useComposerAutocomplete.ts`   |
| File mentions                                  | `useComposerAutocomplete.ts`                        |
| Skill autocomplete                             | `useComposerAutocomplete.ts`                        |
| Dictation                                      | `useComposerDictationControls.ts`                   |
| Collaboration mode selector                    | `useComposerController.ts`                          |
| Model/effort/access controls                   | `ComposerMetaBar.tsx`                               |
| Auto-wrap pasted multiline/code                | `useComposerEditorState.ts`                         |

### 3.6 Message rendering

Supported `ConversationItem` kinds (`src/types.ts:100-142`):

- `message` (user/assistant with optional images)
- `userInput` (user-input requests with questions/answers)
- `reasoning` (summary + content)
- `diff` (title + diff text + status)
- `review` (started/completed)
- `explore` (read/search/list/run entries)
- `tool` (type, title, detail, output, duration, changes, collab sender/receiver)

Rendering: `src/features/messages/components/Messages.tsx`, `MessageRows.tsx`, `Markdown.tsx`.
Utilities: `src/features/messages/utils/`.

### 3.7 Settings surface

Major sections verified in `AppSettings` type (`src-tauri/src/types.rs:378+`, `src/types.ts:238+`):

- Codex binary and args configuration
- Backend mode (local/remote)
- Remote backend host, token, saved remotes
- Default access mode, review delivery mode
- Model, effort, service tier persistence
- UI scale, theme, font families
- Keyboard shortcuts (model cycle, access cycle, reasoning cycle, collaboration cycle, interrupt, new agent, new worktree, archive, toggle panels, workspace cycling)
- Notification sounds, system notifications, subagent notifications
- Git settings (diff whitespace, preload diffs, commit message prompt/model)
- Collaboration modes toggle
- Follow-up message behavior (queue/steer)
- Queue pause on response required
- Dictation model, language, hold key
- Composer editor presets (expand fence, auto-wrap, etc.)
- Thread title autogeneration
- Auto app update checks
- Usage display preferences (show remaining, token/time toggle)

### 3.8 Platform surfaces

| Surface                          | Evidence                                                            |
| -------------------------------- | ------------------------------------------------------------------- |
| Desktop (macOS, Linux, Windows)  | `src-tauri/src/lib.rs` conditional compilation, window state plugin |
| macOS tray with recent threads   | `src-tauri/src/tray.rs`, `useTrayRecentThreads.ts`                  |
| macOS hide-on-close              | `lib.rs:111-114`                                                    |
| Windows custom titlebar          | `lib.rs:128-130`                                                    |
| Linux NVIDIA/Wayland workarounds | `lib.rs:72-91`                                                      |
| iOS mobile                       | `lib.rs:159-164`, `menu_mobile.rs`, `terminal_mobile.rs`            |
| Embedded terminal (desktop only) | `src-tauri/src/terminal.rs`, xterm.js frontend                      |
| Auto-updater (desktop only)      | `tauri-plugin-updater`                                              |
| System notifications             | `src-tauri/src/notifications.rs`                                    |
| Debug panel                      | `src/features/debug/`                                               |

---

## 4. Signature Feature Analysis

### 4.1 Mid-session invites and shared runtime contribution

**Rating: ABSENT**

**What CodexMonitor implements:**

- Nothing related to mid-session invites or shared runtime contribution.
- The application is fundamentally single-user. One user controls all workspaces, threads, and agent sessions.
- "Collaboration modes" (`collaborationMode/list`, passed on `turn/start`) are a Codex API parameter that controls agent behavior style (e.g., "plan" mode), not multi-human collaboration (`src-tauri/src/shared/codex_core.rs:552-560`, `src/types.ts:210`).

**What it does NOT implement:**

- No invite mechanism for other humans to join a session.
- No concept of a shared runtime that multiple users contribute to.
- No identity or authentication layer for multiple users (only single-user Codex login).
- No session sharing or handoff protocol.
- No "bring your own agent" capability for external participants.

### 4.2 Multi-user and multi-agent chat

**Rating: PARTIAL** (multi-agent present, multi-user absent, chat policy absent)

**What CodexMonitor implements -- multi-agent:**

- Create new agent threads within workspaces (`thread/start`).
- Create worktree agents with separate git branches (`workspaces::add_worktree`).
- Create clone agents as workspace copies (`workspaces::add_clone`).
- Display child subagents under parent threads in the thread list.
- Agent configuration CRUD: create/update/delete managed agents with TOML config files (`src-tauri/src/shared/agents_config_core.rs`).
- Settings for `features.multi_agent`, `agents.max_threads` (cap 12), `agents.max_depth` (cap 4) (`src/services/tauri.ts:141-147`).
- `ConversationItem` with `collabSender`, `collabReceiver`, `collabReceivers`, `collabStatuses` fields (`src/types.ts:137-141`) -- rendering multi-agent coordination events.
- Thread list filtering by `sourceKinds` to show/hide subagent types (`codex_core.rs:24-32`).
- Hide `memory_consolidation` subagent threads automatically (`app_server.rs:372-383`).
- Cascade archive from parent to subagent descendants (frontend thread logic).
- Detached review children tracked and grouped back under parents (`useDetachedReviewTracking.ts`).

**What it does NOT implement:**

- No multi-user: the entire application is single-user with no user identity model beyond the Codex account.
- No channels: threads are flat lists grouped by workspace, not topic channels.
- No roles: no user or agent role assignments within a conversation.
- No turn policy: no rules governing who speaks when or in what order.
- No budget policy: no per-agent or per-session token/time budgets enforced by the client. Usage is tracked passively.
- No stop conditions: no configurable conditions that automatically stop a session (e.g., "stop after N tokens" or "stop if quality drops").
- No moderation: no content filtering, escalation rules, or human review gates between agents.
- `max_threads` and `max_depth` limits are stored but enforcement is delegated entirely to upstream Codex, not enforced by the client.
- No direct client surface for upstream `spawn_agent`, `wait`, `close_agent`, `resume_agent` operations.

### 4.3 Queue, steer, pause, resume

**Rating: PARTIAL** (steer is real; queue is client-only in-memory; pause and resume are not what the names suggest)

**What CodexMonitor implements:**

**Queue:**

- Client-side follow-up message queue implemented in `useQueuedSend.ts`.
- Queue state is pure React `useState` -- entirely in-memory, not persisted, not backed by a daemon or server.
- Queue is per-thread, FIFO, sequential, uncapped.
- Queue flushing only runs for the currently active thread.
- User can edit or delete queued follow-ups before they are sent.
- The `queueFlushPaused` flag suspends flushing when Codex requires user input or plan approval (`useQueuedSend.ts:383`).
- Configurable default follow-up behavior: `queue` or `steer` (`AppSettings.followUpMessageBehavior`).
- `Shift+Cmd/Ctrl+Enter` sends using the opposite mode.

**Steer:**

- Real. Sends `turn/steer` to the active Codex turn via `codex_core::turn_steer_core()` (`codex_core.rs:528-549`).
- Includes `expectedTurnId` for safety.
- Falls back to queueing if steer fails (requeue on `steer_failed` status in `useQueuedSend.ts:297-299`).
- Steer does NOT carry collaboration mode (only `turn/start` does).

**Stop (interrupt):**

- Real. Sends `turn/interrupt` to Codex (`codex_core.rs:562-573`).
- Client optimistically clears processing state and shows "Session stopped." system message (`useThreadMessaging.ts:438-443`).
- Handles pending interrupts when turn ID is not yet available (`useThreadMessaging.ts:444-446`).

**Pause:**

- NOT a true runtime pause. The word "pause" in the codebase refers only to `queueFlushPaused` -- suspending the drain of queued follow-up messages when Codex needs user input or plan approval.
- There is no operation to pause a running Codex turn and resume it later.
- `pauseQueuedMessagesWhenResponseRequired` is a user-facing setting (`src/types.ts:292`).

**Resume:**

- NOT "resume a paused turn." `thread/resume` (`codex_core.rs:267-277`) refreshes or reattaches thread state from Codex.
- The `/resume` slash command calls `refreshThread()` which re-reads thread state (`useThreadMessaging.ts:879-902`).
- Blocked while the thread is currently processing.

**What it does NOT implement:**

- No server-backed or daemon-backed persistent task queue.
- No queue that survives app restart.
- No queue that processes across threads in parallel.
- No true pause/unpause of active Codex execution.
- No ability to resume from a persisted mid-execution state.

### 4.4 Repo attach and git flow

**Rating: MOSTLY COMPLETE** (strong git surface, limited automation)

**What CodexMonitor implements:**

**Repo mounts:**

- Workspaces are directory-backed, each workspace path is passed as `cwd` to Codex.
- Multiple workspaces can be attached simultaneously.
- Worktrees create git worktrees of existing repos with separate branches.
- Clones create full directory copies.
- Git root detection and multi-root scanning (`list_git_roots`).

**Worktrees:**

- Create with branch name, optional display name, optional `AGENTS.md` copy.
- Branch from local or remote-tracking refs.
- Configurable placement directory (`worktreesFolder` per workspace or global).
- Setup scripts executed after creation.
- Rename worktree (local + upstream branch).
- Apply worktree changes.
- Remove worktree with cleanup.

**Branch strategies:**

- Branch list, create, checkout operations.
- Branch switcher with keyboard shortcut.
- Worktree creation includes branch suggestion/slugging.
- However: no automated branch naming conventions, no automatic PR creation, no merge strategies.

**Diff attribution:**

- Diffs are rendered per-file with staged/unstaged separation.
- Image and binary diff handling.
- Commit diff inspection.
- However: no attribution of which agent made which change. Diff attribution is entirely Codex-internal.

**PR prep:**

- GitHub PR list, detail, diff, comments.
- PR checkout.
- PR-aware review UX (`usePullRequestComposer.ts`, `usePullRequestReviewActions.ts`).
- Commit-review shortcuts.
- AI-generated commit messages.
- GitHub repo creation from local repo.
- However: no automated PR creation flow from the app. No PR writeback (comments, approvals) beyond what Codex generates through its tools.

**What it does NOT implement:**

- No automatic branch strategy enforcement (naming conventions, auto-branching).
- No diff attribution tracking (which agent changed what).
- No automated PR creation workflow from the app UI.
- No GitHub writeback (posting review comments, merging PRs) from the app.
- GitHub operations require `gh` CLI as a hard dependency.
- No GitLab, Bitbucket, or other forge support.

### 4.5 Visibility

**Rating: PARTIAL** (good message/tool rendering, limited state transition visibility)

**What CodexMonitor implements:**

**Message timeline:**

- Real-time rendering of user messages, assistant messages, reasoning items, diffs, tool calls, explore items, review items, user input requests.
- Tool items include type, title, detail, output, duration, and file changes.
- Explore items track read/search/list/run operations.
- Reasoning items with summary and full content.
- Inline diffs for file-change tools.
- Delayed command-output rendering for live tools.
- Last-200-line output capping for command display.

**Approval visibility:**

- Toast-based approval stack.
- Approve/Decline/Always-allow actions.
- Remembered approval prefixes.

**Subagent visibility:**

- Child subagents displayed under parent threads.
- Detached review children grouped back to parents.
- `collabSender`, `collabReceiver`, `collabStatuses` on tool items for multi-agent coordination display.

**Debug panel:**

- Debug dock showing client/server/error log entries with timestamps.
- Copy and clear log.
- Debug entries for turn/start, turn/steer, turn/interrupt, review/start with full payloads.

**Usage visibility:**

- Session and weekly limit readouts.
- Usage ring in composer.
- Home dashboard with weekly usage, top models, account limits.
- Tray usage summary on macOS.

**What it does NOT implement:**

- No live timeline of state transitions (processing -> waiting -> done transitions are not visualized as a timeline).
- No handoff tracking between agents (agent A delegated to agent B is not surfaced as a trackable event).
- No subtask-level progress tracking beyond subagent thread listing.
- No explicit event log of all approval decisions, tool executions, and state changes as a unified audit trail.
- No visibility into queue state across threads (only the active thread's queue is visible).

---

## 5. Codex Integration Model

### 5.1 Protocol

The `codex app-server` protocol is newline-delimited JSON-RPC over stdio. Each message is a single JSON line terminated by `\n`.

**Request format:**

```json
{"id": <u64>, "method": "<string>", "params": <object>}
```

**Response format:**

```json
{"id": <u64>, "result": <value>}
```

or

```json
{"id": <u64>, "error": {"message": "<string>"}}
```

**Notification format (server to client):**

```json
{"method": "<string>", "params": <object>}
```

### 5.2 Initialization

The app sends an `initialize` request with:

```json
{
  "clientInfo": { "name": "codex_monitor", "title": "Codex Monitor", "version": "<version>" },
  "capabilities": { "experimentalApi": true }
}
```

Evidence: `app_server.rs:419-429`.

### 5.3 Turn payload

A `turn/start` message includes:

- `threadId`, `cwd`, `approvalPolicy`, `sandboxPolicy`
- `input`: array of `{type: "text", text}`, `{type: "image", url}`, `{type: "localImage", path}`, `{type: "mention", name, path}` items
- `model`, `effort`, `serviceTier` (nullable), `collaborationMode`
- Sandbox policy is derived from access mode: `workspaceWrite` (with networkAccess), `readOnly`, or `dangerFullAccess`
- Approval policy is always `on-request` unless access mode is `full-access` (then `never`)

Evidence: `codex_core.rs:474-526`, `codex_core.rs:400-462`.

### 5.4 Event routing

Events from `codex app-server` are routed by:

1. Extracting thread ID and related thread IDs from the event payload (`extract_thread_id`, `extract_related_thread_ids` in `app_server.rs`).
2. Looking up workspace ownership via `thread_workspace` map.
3. Broadcasting to registered workspace IDs, or to specific workspaces for thread-scoped events.
4. Global notifications (`account/updated`, `account/rateLimits/updated`, `account/login/completed`) are broadcast to all workspaces.

### 5.5 Background threads

For operations like commit message generation, the app:

1. Creates a thread via `turn/start`.
2. Registers a `background_thread_callbacks` entry with an `mpsc` channel.
3. Collects events for that thread via the channel.
4. Emits a `codex/backgroundThread` event with `action: "hide"` to suppress the thread from the UI.

Evidence: `codex/mod.rs:891-941`, `app_server.rs:444`.

---

## 6. State Management and Persistence

### 6.1 Backend persistence

| Data                | Storage                                 | Evidence                           |
| ------------------- | --------------------------------------- | ---------------------------------- |
| Workspace entries   | `workspaces.json` in Tauri app data dir | `src-tauri/src/storage.rs:132-152` |
| App settings        | `settings.json` in Tauri app data dir   | `storage.rs:154-180`               |
| Agent configs       | `~/.codex/agents/<name>.toml`           | `shared/agents_config_core.rs`     |
| Global AGENTS.md    | `~/.codex/AGENTS.md`                    | `shared/files_core.rs`             |
| Global config.toml  | `~/.codex/config.toml`                  | `shared/config_toml_core.rs`       |
| Workspace AGENTS.md | `<workspace>/.codex/AGENTS.md`          | `shared/files_core.rs`             |

### 6.2 Frontend persistence

| Data                                             | Storage                                   | Evidence                     |
| ------------------------------------------------ | ----------------------------------------- | ---------------------------- |
| Composer drafts                                  | Local storage (keyed by thread/workspace) | `useComposerDraftEffects.ts` |
| Thread metadata (custom names, pins, timestamps) | Local storage                             | `useThreadStorage.ts`        |
| Prompt history                                   | In-memory per composer key                | `usePromptHistory.ts`        |
| Sidebar collapse state                           | Local storage per workspace               | `useCollapsedGroups.ts`      |
| Thread list organize/sort mode                   | App settings                              | `useThreadListSortKey.ts`    |

### 6.3 Non-persisted state

- Queued follow-up messages (React `useState` only, lost on refresh/restart).
- Active turn IDs (React state).
- Processing/reviewing flags (React state).
- Debug log entries (React state, capped).
- Terminal session buffers (capped at 200,000 characters in Rust backend).

### 6.4 Settings migration

- `followUpMessageBehavior` migrated from legacy `steerEnabled` boolean (`storage.rs:215-231`).
- Remote backend provider sanitized to TCP-only if legacy provider found (`storage.rs:190-213`).
- Windows namespace paths (`\\?\`) normalized on load (`storage.rs:7-108`).

---

## 7. Multi-Agent and Orchestration Model

### 7.1 What "multi-agent" means in CodexMonitor

Multi-agent in CodexMonitor is workspace and thread orchestration layered on top of Codex's native subagent system:

1. **Top-level agents**: Each workspace can have multiple independent threads. Creating a "new agent" means creating a new thread in a workspace.

2. **Worktree agents**: A new workspace created as a git worktree of another. Inherits parent group, gets its own Codex session, operates on a separate branch.

3. **Clone agents**: A directory copy of a workspace. Stored as a main workspace with `cloneSourceWorkspaceId` lineage.

4. **Subagents**: Child threads surfaced by Codex itself (review subagents, compact subagents, thread-spawn subagents). Displayed in the thread list under the parent. Hidden if they are `memory_consolidation` type.

### 7.2 Agent configuration

- `~/.codex/agents/` directory with TOML config files per agent.
- Settings: `multiAgentEnabled` (boolean), `maxThreads` (1-12), `maxDepth` (1-4).
- Custom agents have: name, description, developer instructions, config file path, model, reasoning effort.
- Agent description can be AI-generated via `generate_agent_description` (`codex/mod.rs:984-1024`).

Evidence: `src-tauri/src/shared/agents_config_core.rs`, `src/services/tauri.ts:141-175`.

### 7.3 Limitations

- No client-side enforcement of `maxThreads` or `maxDepth` -- these are written to config for Codex to enforce.
- No direct spawn/wait/close/resume-agent protocol surface from the client.
- No inter-agent messaging from the UI (Codex handles agent-to-agent communication internally).
- No agent scheduling, priority, or resource allocation beyond what Codex provides.

---

## 8. Remote/Daemon Architecture

### 8.1 Daemon binary

The `codex-monitor-daemon` is a standalone Rust binary that:

- Reuses all shared cores (`codex_core`, `git_core`, `workspaces_core`, etc.) via path includes (`src-tauri/src/bin/codex_monitor_daemon.rs:1-62`).
- Listens on TCP (default `127.0.0.1:4732`).
- Authenticates connections via token (`rpc.rs:56-65`).
- Dispatches JSON-RPC requests through `dispatcher.rs` to domain handlers: `codex.rs`, `workspace.rs`, `git.rs`, `prompts.rs`, `daemon.rs`.
- Limits concurrent RPC per connection to 32 (`MAX_IN_FLIGHT_RPC_PER_CONNECTION`).
- Broadcasts `app-server-event`, `terminal-output`, `terminal-exit` events to connected clients.

Evidence: `src-tauri/src/bin/codex_monitor_daemon.rs`, `src-tauri/src/bin/codex_monitor_daemon/rpc/dispatcher.rs`.

### 8.2 Daemon lifecycle

The desktop app can:

- Start, stop, and query daemon status via `tailscale_daemon_start`, `tailscale_daemon_stop`, `tailscale_daemon_status` (naming is historical -- the module is `src-tauri/src/tailscale/`).
- Preview the daemon start command.
- Auto-start daemon on app launch if in remote mode.
- Auto-stop daemon on app exit (unless `keepDaemonRunningAfterAppClose` is set).
- There is also a `codex_monitor_daemonctl` binary (~47 KB) for headless daemon management.

Evidence: `src-tauri/src/tailscale/daemon_commands.rs`, `lib.rs:136-157`.

### 8.3 Remote client transport

- `RemoteBackend` struct wraps a TCP connection with `out_tx` (mpsc sender), `pending` (oneshot map), `connected` (atomic bool).
- 15-second send timeout, 300-second request timeout.
- Retry-after-disconnect only for read-oriented methods (32 methods allowlisted in `can_retry_after_disconnect`, `remote_backend/mod.rs:145-184`).
- Mutating operations (send_user_message, start_thread, remove_workspace, etc.) are NOT retried.
- WSL UNC path normalization for Windows remote access (`remote_backend/mod.rs:37-56`).

### 8.4 What is bridged remotely

All Tauri commands check `is_remote_mode()` and forward to the daemon via `call_remote()` if true. This includes:

- All Codex operations (thread CRUD, messaging, steer, interrupt, review, model list, etc.)
- Git operations (status, diff, log, commit, push, pull, branch, GitHub operations)
- Workspace operations (list, add, remove, worktree, clone, file listing)
- Settings and config operations
- Agent config CRUD
- Usage snapshots
- File read/write for AGENTS.md and config.toml

### 8.5 Limitations

- Only TCP transport exists (no WebSocket, no gRPC, no HTTP).
- Mobile clients must be on the same network (Tailscale suggested for remote access).
- No encryption beyond what Tailscale provides (no TLS on the TCP connection itself).
- No connection pooling or multiplexing.
- The `remember_approval_rule` command has a known bug where the remote path does not forward correctly and can write locally instead (`codex/mod.rs:862-868` -- notably missing remote mode check).

---

## 9. Strengths

1. **Deep Codex integration**: The app wraps nearly the entire `codex app-server` JSON-RPC surface with proper request tracking, timeout handling, and event routing. This is not a thin shell.

2. **Comprehensive git surface**: Full git lifecycle from init through push, including worktree management, branch switching, AI commit messages, GitHub PR review, and image diff rendering. The `git2` library + CLI fallback approach covers edge cases well.

3. **Workspace orchestration**: The ability to manage many workspaces with worktrees, clones, project groups, and per-workspace settings creates a genuine multi-project workflow. Worktree setup scripts and placement configuration show production maturity.

4. **Shared core architecture**: The `src-tauri/src/shared/` pattern means all domain logic works identically in desktop and daemon modes. This is a strong design decision that prevents feature drift between local and remote.

5. **Settings depth**: The settings surface is unusually comprehensive -- keyboard shortcuts, font configuration, diff behavior, notification controls, dictation, composer editor presets, and more. This reflects significant user-facing iteration.

6. **Cross-platform reach**: macOS, Linux, Windows desktop plus iOS mobile from a single codebase, with platform-specific workarounds (NVIDIA/Wayland, macOS glass effects, Windows custom titlebar, iOS edge-to-edge).

7. **Queue and steer UX**: While the queue is client-only, the UX around it is well-considered: configurable default behavior, per-message override, visual queue with edit/delete, automatic fallback from steer to queue, pause on user input required.

---

## 10. Limitations and Gaps

### 10.1 Fundamental architectural limitations

1. **Single-user only**: No user identity model, no session sharing, no multi-human collaboration. This is the largest gap relative to ai-sidekicks requirements.

2. **Client-only queue**: The follow-up queue is React `useState`. It does not survive page refresh, app restart, or work across threads. There is no daemon-backed task queue.

3. **No true pause/resume**: "Pause" is queue-drain suspension. "Resume" is thread state refresh. There is no way to pause a running Codex turn mid-execution and resume it later from persisted state.

4. **No live subscription transport**: `thread/live_subscribe` and `thread/live_unsubscribe` are synthetic client-side events (`codex/mod.rs:134-207`). The `thread_live_subscribe_core` function just validates the session exists and returns -- it does not establish a real subscription stream.

### 10.2 Missing Codex API surfaces

- `spawn_agent`, `wait`, `close_agent`, `resume_agent` -- not exposed to the client.
- `thread/unarchive` -- no client send path.
- `send_input` -- not exposed as a standalone operation.
- Collaboration mode is not applied through `turn/steer`.

### 10.3 Product gaps

- **No diff attribution**: Cannot track which agent made which file change.
- **No automated PR workflow**: No "create PR from this worktree" button. GitHub writeback is limited to repo creation.
- **No audit trail**: Debug panel is ephemeral. No persistent log of all agent actions, approvals, and state transitions.
- **Prompt CRUD weaker in remote mode**: Prompt library operations appear to be local-desktop behavior; remote bridging is weaker than for core Codex and git flows.
- **File panel is read-only**: No general-purpose file editing. The file panel is preview-only with snippet mention insertion.
- **GitHub coverage is narrow**: Open issues/PRs only, 50 result cap, no inline review-thread fidelity, no GitLab/Bitbucket support.
- **No persistent queue or task scheduling**: No way to queue work for later execution or schedule agent runs.

### 10.4 Known bugs

- `remember_approval_rule` in Tauri does not check `is_remote_mode()` and can write locally when it should forward to the daemon (`codex/mod.rs:862-868`).
- Project activity mode does not account for worktree-child activity.
- Clone agents are nested under the source project in the sidebar but stored as main workspaces, causing navigation inconsistencies.
- Some follow-up requeue behavior is composer-specific rather than universal.

---

## 11. Summary for ai-sidekicks Gap Analysis

| Signature Feature                    | Rating              | Key Evidence                                                                                                  |
| ------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------- |
| Mid-session invites / shared runtime | **ABSENT**          | No multi-user, no invite, no shared sessions                                                                  |
| Multi-user multi-agent chat          | **PARTIAL**         | Multi-agent threads/subagents yes; multi-user, channels, roles, policies absent                               |
| Queue, steer, pause, resume          | **PARTIAL**         | Steer real via `turn/steer`; queue client-only in-memory; pause is queue-drain only; resume is thread refresh |
| Repo attach and git flow             | **MOSTLY COMPLETE** | Full git + worktrees + GitHub PR review; no automated PR creation, no diff attribution                        |
| Visibility                           | **PARTIAL**         | Good message/tool rendering; no state transition timeline, no handoff tracking, no audit trail                |

The ai-sidekicks documentation should cover everything CodexMonitor offers in the "mostly complete" and "partial" categories, and explicitly describe the capabilities that are absent from CodexMonitor as differentiating features.

---

## Appendix A. User-Facing Feature Audit

> Merged from `codexmonitor-feature-audit-report.md` (2026-04-14). This appendix provides the complete user-facing product surface inventory with per-feature evidence trails. Sections 1–11 above cover technical architecture; this appendix covers the same product from the user/operator perspective.

Original scope: source-level audit of docs, frontend, Tauri backend, shared Codex core, and daemon RPC surface.

### A.0 Scope And Normalization

This report is a normalized feature inventory for the application as implemented in code, not just as described in `README.md`. Where documentation and implementation differ, implementation wins.

The app uses the word "agent" for multiple things. Normalized terms used below:

- Workspace agent: a Codex-backed conversation/thread running in a workspace.
- Worktree agent: a new workspace created as a git worktree of another workspace.
- Clone agent: a copied workspace created from another workspace directory.
- Subagent: a child thread surfaced by Codex and attached under a parent thread.
- Queued follow-up: a client-side follow-up user message stored locally and sent later to an existing active thread.

### A.0.1 Executive Summary

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

### A.1 Codex Integration And Runtime Model

#### A.1.1 How it calls Codex

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

#### A.1.2 Local vs remote backend

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

#### A.1.3 Codex requests the app actually sends

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

#### A.1.4 Turn payload and policy nuances

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

### A.2 Queue, Steer, Stop, Pause, Resume, And Multi-Agent Semantics

This section is the most important behavioral normalization in the codebase.

#### A.2.1 Queue vs steer

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

#### A.2.2 Stop vs pause

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

#### A.2.3 Resume semantics

`/resume` and `thread/resume` do not mean "resume a paused turn."

Actual meaning:

- refresh or reattach thread state from Codex
- blocked while the thread is currently processing
- implementation skips resume if the local snapshot is already present in some flows

Normalized conclusion:

- stop = interrupt current turn
- pause = suspend queued follow-up flushing in specific UX states
- resume = re-read or reattach thread state, not continue a suspended turn

#### A.2.4 Multi-agent support

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

### A.3 Workspace, Project, And Home Surfaces

#### A.3.1 Workspace lifecycle

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

#### A.3.2 Project grouping and navigation

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

#### A.3.3 Home and workspace-home

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

#### A.3.4 Worktrees and cloned workspaces

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

### A.4 Threads, Composer, Messages, Plans, And Approvals

#### A.4.1 Thread list and navigation

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

#### A.4.2 Composer

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

#### A.4.3 Slash commands

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

#### A.4.4 Message rendering and interaction

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

#### A.4.5 Plans and approvals

Plan and approval features:

- plan panel with explanation and numbered state rows
- plan-ready follow-up card with `Implement` and `Send changes`
- per-thread plan-card dismissal tracking
- toast-based approval stack
- keyboard approval on `Enter` outside editable fields
- `Decline`, `Always allow`, and `Approve`
- remembered approval prefixes for future auto-accept
- request-user-input surface for first pending request in the active thread/workspace

### A.5 Git, GitHub, And Review Workflows

#### A.5.1 Git support

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

#### A.5.2 GitHub support

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

#### A.5.3 Review support

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

### A.6 Prompts, Files, AGENTS.md, And Config Editing

#### A.6.1 Prompt library

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

#### A.6.2 File browsing and mentions

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

#### A.6.3 Scoped config editing

The app has first-class editors for:

- workspace `AGENTS.md`
- global `~/.codex/AGENTS.md`
- global `~/.codex/config.toml`
- managed per-agent config TOML files

Important limitation:

- generic workspace file editing is not a first-class feature; the general file panel is read-only preview, not a general-purpose file editor

### A.7 Agent Settings, Models, Collaboration, Apps, And Other Settings

#### A.7.1 Major settings sections

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

#### A.7.2 Codex and model controls

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

#### A.7.3 Agent settings

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

#### A.7.4 Collaboration modes

Collaboration mode support is real and dynamic.

Capabilities:

- fetch available collaboration modes from Codex
- fall back to sensible defaults when needed
- carry developer instructions, model, and reasoning metadata
- simplify to a Plan toggle when only `default` and `plan` exist
- send selected mode on `turn/start`

Important nuance:

- collaboration mode is not applied through `turn/steer`

#### A.7.5 Apps integration

The app has a separate Apps integration surface:

- app list fetched from Codex when enabled and connected
- accessible apps prioritized in UI
- refresh from app-server events
- `$app` autocomplete
- `/apps` output showing connected and installable apps
- install URLs surfaced for installable apps

#### A.7.6 Other notable settings capabilities

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

### A.8 Terminal, Debugging, Usage, Notifications, And Platform Surfaces

#### A.8.1 Embedded terminal

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

#### A.8.2 Debug and usage surfaces

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

#### A.8.3 Notifications and platform behavior

Verified platform behaviors:

- system notifications for long-running runs
- notification body truncation
- macOS tray support
- debug-build macOS notification fallback
- global zoom shortcuts
- terminal and debug shortcuts suppressed while typing

### A.9 Limitations, Gaps, And Doc Drift

#### A.9.1 Real gaps in supported Codex features

- no direct client surface for upstream spawn/wait/close/resume-agent operations
- no true pause or unpause of an active Codex turn
- no real thread live-subscribe transport despite some "live attach" naming
- no client send path for unarchive
- missing handling for several upstream request and notification types

#### A.9.2 Real product limitations

- queue is local in-memory only
- queue flushing only tracks the active thread
- prompt CRUD is weaker in remote mode than core Codex flows
- generic workspace files are previewable but not generally editable
- GitHub coverage is narrower than the Git surface and weak on inline review-thread fidelity
- add-clone remote bridging appears incomplete compared with daemon support
- worktree and clone behaviors have some nesting and activity-model inconsistencies

#### A.9.3 Known implementation bugs or mismatches

- remote-mode remembered approval rule bug: remote flow exposes the capability in the daemon, but one Tauri command path does not forward it correctly and can write locally instead
- README/docs overstate or misdescribe some semantics, especially around `thread/resume`
- docs mention `thread/read` as missing even though code implements it
- some follow-up requeue behavior is composer-specific rather than universal

### A.10 Bottom-Line Capability Statement

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

### A.11 Primary Evidence Hotspots

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

### A.12 Audit Note

This report is exhaustive with respect to the inspected code paths and surfaced capabilities. It is source-derived, not a full click-by-click runtime certification of every UI path. Where the code clearly defines a feature, it is included. Where the code clearly limits or contradicts a claimed feature, the limitation is documented.
