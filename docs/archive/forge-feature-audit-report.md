# Forge Feature Audit

Date: 2026-04-14

Project root: `/home/sabossedgh/dev/forge`

Scope: repo-wide static audit of `apps/web`, `apps/server`, `apps/desktop`, `apps/marketing`, `packages/contracts`, and `packages/shared`.

Method:
- Direct code inspection across the monorepo.
- Parallel `gpt-5.4` `xhigh` agent passes for app shell, workflows/diffs, daemon/persistence, and provider/runtime areas.
- Manual normalization and deduplication of overlapping findings.

Conventions:
- `user`: directly visible end-user product behavior.
- `operator`: setup/admin/debug/maintainer capability.
- `internal`: implemented platform capability or latent surface not always exposed in the primary UI.
- `conditional`: feature exists but is gated by platform, runtime mode, provider state, or route/query state.

## Plain-Language Summary

### What This App Is

Forge is a desktop/web workspace for doing software work with coding agents. It combines:

- chat with agents
- project/thread organization
- workflow automation
- code review and diff tools
- terminal and git operations
- and a backend that keeps long-running agent sessions alive

### 1. Project And Conversation Management

- Multiple projects: You can add more than one codebase/workspace and switch between them in the sidebar.
  Example: keep your frontend repo and backend repo in the same app and jump between them.
- Multiple threads per project: Each project can have many separate conversations.
  Example: one thread for `fix login bug`, another for `add billing page`, another for `release checklist`.
- Thread organization: Threads can be pinned, archived, renamed, forked, marked unread, and sorted.
  Example: pin your main implementation thread, archive old debugging threads, fork a thread before trying a risky idea.
- Project organization: Projects can be sorted automatically or manually.
  Example: keep your most important repo at the top even if it was not updated most recently.

### 2. Chatting With Coding Agents

- Normal agent chat: You can talk to an AI agent about your code and get streamed responses while it works.
  Example: `Find why session resume fails after reconnect and fix it.`
- Provider and model selection: The app supports choosing which agent/provider to use, mainly Codex and Claude right now.
  Example: use Codex for code editing, then switch to Claude for a second opinion.
- Saved draft state: If you leave a thread and come back later, your unfinished prompt and settings are still there.
  Example: start writing a long request, switch threads, then return without losing it.
- Path mentions and smart input: The composer understands things like file/path mentions and command-style inputs.
  Example: mention a specific file so the agent focuses on `apps/server/src/wsServer.ts`.

### 3. Different Working Modes

- Chat mode: regular back-and-forth coding help.
  Example: `Explain this function and patch the bug.`
- Plan mode: the agent focuses on producing a plan before implementation.
  Example: `Design a migration strategy for moving provider state into SQLite.`
- Design mode: the app can show generated design artifacts or previews tied to the thread.
  Example: ask for a UI redesign and review visual output inside the app.

### 4. Human Control, Safety, And Approval

- Command/file approvals: The app can stop and ask for approval before risky actions.
  Example: the agent wants to run a shell command or modify files, and you must approve first.
- Permission grants: You can grant access to folders or network capabilities for a turn or a whole session.
  Example: allow reading one repo folder for this request only, or allow network for the whole session.
- User-input prompts: The app can pause and ask you a structured question when the workflow needs a decision.
  Example: `Which environment should I target: staging or production?`
- MCP/tool elicitation: Some tools can ask you to open a URL, fill a form, or provide structured input.
  Example: a tool asks you to authenticate or paste a JSON config value.

### 5. Workflow And Collaboration Features

- Saved workflows: You can define reusable multi-step agent workflows instead of relying only on ad hoc prompts.
  Example: create a workflow for `analyze issue -> make plan -> implement -> summarize`.
- Discussions: The app supports managed multi-participant discussion flows, not just one agent talking to one user.
  Example: simulate `architect`, `reviewer`, and `implementer` roles discussing a change.
- Per-role model choices: Different participants in a discussion can use different models.
  Example: a stronger model for architecture, a cheaper one for implementation.

### 6. Coding Workflow Tools Around The Chat

- Git integration: The app exposes repo actions like branch/worktree-related operations and git-aware views.
  Example: create a worktree for a feature branch and keep it tied to a specific thread.
- Diff review: You can inspect code diffs inside the app rather than leaving for another tool.
  Example: review what the agent changed before accepting it.
- Project scripts: The UI can surface and run repo-level scripts.
  Example: trigger lint/typecheck/build tasks from the thread workspace.
- Open in editor/file manager: The app can jump from the thread to your local editor or project folder.
  Example: open the current workspace in VS Code or Cursor.
- Terminal integration: Terminal activity can be attached to the thread context.
  Example: include recent terminal output in the next prompt so the agent can reason about a failure.

### 7. Long-Running Agent Runtime

- Persistent sessions: The backend is built to keep agent sessions alive and recover from reconnects/restarts.
  Example: close the UI, reopen it, and resume the same thread instead of starting over.
- Event/timeline tracking: The system records what happened during an agent run.
  Example: see phases like planning, waiting for approval, generating output, or running subtasks.
- Background task visibility: The app can show background agent/subagent work rather than only the final reply.
  Example: see that a subagent is exploring one file while the main agent continues elsewhere.

### 8. Desktop App Features

- Electron desktop shell: There is a native desktop app, not just a browser UI.
  Example: use native dialogs, tray behavior, updater flows, and local integration.
- Local daemon connection: The desktop app can connect to a local backend process.
  Example: launch Forge on your machine and have it manage the server for you.
- WSL support: On Windows, it can connect to a Forge/backend running inside WSL.
  Example: keep code in Ubuntu/WSL but use a Windows desktop UI.
- Auto-updates: The desktop app has built-in update/download/install flows.
  Example: get notified that a new version is ready and install it from the app.

### 9. Internal Platform Features You Don’t Directly “See”

- WebSocket API: The frontend and backend communicate over a structured realtime protocol.
  Example: agent events, terminal updates, approvals, and settings changes stream live.
- Persistence layer: The server stores projects, threads, messages, workflows, approvals, and other runtime state.
  Example: your thread list and conversation history survive restarts.
- Observability/logging: The app includes tracing/logging/debug infrastructure.
  Example: operators can diagnose why a provider session crashed or stalled.

### 10. Important Caveat

The report also says some areas look incomplete or only partially exposed.

- Some features exist in code but may not be fully wired into the UI yet.
  Example: parts of workflow deletion and some background-task ownership behavior look unfinished.
- Some features are conditional.
  Example: WSL-specific setup only appears on Windows desktop, and some provider/model controls only appear when that model supports them.

## 1. App Shell, Navigation, And Settings

- Sidebar application shell | user | Main UI is a left-sidebar workbench with resizable, width-persistent layout, off-canvas behavior on smaller screens, and desktop menu routing into Settings. | evidence: `apps/web/src/components/AppSidebarLayout.tsx`, `apps/web/src/main.tsx`
- Branded sidebar and footer nav | user | Sidebar brand links back to chat, shows stage/version context, and footer navigation exposes `Agent Modes` and `Settings`. | evidence: `apps/web/src/components/sidebar/SidebarBrand.tsx`, `apps/web/src/components/sidebar/SidebarFooterNav.tsx`
- Empty-thread landing state | user | Root chat surface shows a dedicated empty state until a thread is selected or created. | evidence: `apps/web/src/routes/_chat.index.tsx`
- Root connectivity and failure shells | user | App can show connecting state, desktop-only connection setup, daemon/app version mismatch, and fatal router error details with reload/retry actions. | evidence: `apps/web/src/routes/__root.tsx`, `apps/web/src/components/ConnectionSetup.tsx`
- Bootstrap navigation restore | user | Server welcome payload can auto-expand a bootstrap project and route the app directly into a designated thread. | evidence: `apps/web/src/routes/__root.tsx`, `packages/contracts/src/server.ts`
- Desktop connection setup | user | Electron setup flow supports WSL and external-server connection modes, connection testing, distro discovery, Forge binary verification, and saved connection config. | evidence: `apps/web/src/components/ConnectionSetup.tsx`, `apps/desktop/src/connectionConfig.ts`
- Project creation and dedupe | user | Sidebar can add projects from path or folder picker, dedupe by `cwd`, and auto-create an initial thread for a new project. | evidence: `apps/web/src/components/sidebar/useSidebarInteractions.ts`
- Project sorting | user | Projects can be sorted by updated time, created time, or manual drag order. | evidence: `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/sidebar/SidebarProjectsSection.tsx`, `packages/contracts/src/settings.ts`
- Thread sorting | user | Threads can be sorted by updated time or created time. | evidence: `apps/web/src/components/Sidebar.tsx`, `packages/contracts/src/settings.ts`
- Project-tree persistence | user | Expanded/collapsed project state and manual ordering are stored locally and migrated from legacy keys. | evidence: `apps/web/src/uiStateStore.ts`
- Project sections and thread tree | user | Projects show pinned and unpinned threads, expandable child-thread trees, and `Show more` truncation for long lists. | evidence: `apps/web/src/components/sidebar/useSidebarData.ts`, `apps/web/src/components/sidebar/SidebarProjectItem.tsx`, `apps/web/src/components/sidebar/SidebarThreadRow.tsx`
- Project status rollups | user | Project rows aggregate hidden-thread and collapsed-state status indicators. | evidence: `apps/web/src/components/sidebar/useSidebarData.ts`, `apps/web/src/components/sidebar/SidebarProjectItem.tsx`
- Rich thread rows | user | Thread rows surface status, unread state, provider/model/role metadata, fork ancestry, PR state, running terminal state, design-mode markers, timestamps, pinning, and archive actions. | evidence: `apps/web/src/storeSidebar.ts`, `apps/web/src/components/sidebar/SidebarThreadRow.tsx`
- Thread context menus | user | Per-thread actions include rename, fork, mark unread, copy workspace path, copy thread id, archive, and delete. | evidence: `apps/web/src/components/sidebar/useSidebarInteractions.ts`
- Multi-select thread handling | user | Sidebar supports Cmd/Ctrl toggle selection, Shift range selection, bulk context-menu actions, Escape clear, and outside-click clear. | evidence: `apps/web/src/threadSelectionStore.ts`, `apps/web/src/components/sidebar/useSidebarInteractions.ts`, `apps/web/src/routes/_chat.tsx`
- Keyboard thread navigation | user | Keybindings support previous/next thread, jump-to-numbered thread hints, and new-thread creation shortcuts. | evidence: `apps/web/src/components/sidebar/useSidebarInteractions.ts`, `packages/contracts/src/keybindings.ts`
- Settings shell | user | `/settings` routes into General and Archive sections, with browser and Electron-specific header variants and back navigation. | evidence: `apps/web/src/routes/settings.tsx`, `apps/web/src/components/settings/SettingsSidebarNav.tsx`
- General client settings | user | UI exposes theme, timestamp format, diff word wrap, assistant streaming, archive/delete confirmations, default thread environment mode, worktree branch prefix, and git text-generation model settings. | evidence: `apps/web/src/components/settings/SettingsPanels.tsx`, `packages/contracts/src/settings.ts`
- Provider administration | operator | Settings can enable/disable providers, edit binary paths and `CODEX_HOME`, refresh health/auth snapshots, inspect provider versions, and manage custom models. | evidence: `apps/web/src/components/settings/SettingsPanels.tsx`, `apps/server/src/provider/Layers/ProviderRegistry.ts`, `apps/server/src/provider/Layers/CodexProvider.ts`, `apps/server/src/provider/Layers/ClaudeProvider.ts`
- Diagnostics and config paths | operator | Settings surfaces `settings.json`, `keybindings.json`, logs directory, observability config, and appearance validation issues, with open-in-editor support. | evidence: `apps/web/src/components/settings/SettingsPanels.tsx`, `apps/web/src/components/chat/OpenInPicker.tsx`
- Keybindings hot reload feedback | operator | Invalid or updated keybindings configs produce toast feedback and direct-open actions. | evidence: `apps/web/src/routes/__root.tsx`, `apps/server/src/keybindings.ts`
- Desktop update surfaces | user | Settings and sidebar expose app version, updater state, download/install controls, and Apple Silicon translation warnings. | evidence: `apps/web/src/components/settings/SettingsPanels.tsx`, `apps/web/src/components/sidebar/SidebarUpdatePill.tsx`, `apps/web/src/components/sidebar/SidebarDesktopUpdateBanner.tsx`, `apps/desktop/src/updateMachine.ts`
- Archived thread management | user | Archived threads are grouped by project and support inline unarchive and delete from the Archive settings view. | evidence: `apps/web/src/routes/settings.archived.tsx`, `apps/web/src/components/settings/SettingsPanels.tsx`

## 2. Chat, Composer, And Session Runtime

- Chat thread workbench | user | Active chat route can mount the main chat view plus either an inline/sidebar diff panel or design preview panel, with mobile sheet fallbacks. | evidence: `apps/web/src/routes/_chat.$threadId.tsx`
- Composer slash commands | user | Composer recognizes `/plan`, `/default`, `/design`, and `/model`, plus `@path` mentions and inline terminal-context tokens. | evidence: `apps/web/src/composer-logic.ts`
- Persistent composer drafts | user | Per-thread drafts retain prompt text, attachments, images, terminal contexts, provider/model picks, runtime mode, workflow/discussion targeting, and worktree context, with sticky model memory and migration support. | evidence: `apps/web/src/composerDraftStore.ts`
- Mention and path search menu | user | Composer autocomplete supports workspace path suggestions, slash commands, and model suggestions with keyboard-highlight control. | evidence: `apps/web/src/components/chat/ComposerCommandMenu.tsx`, `apps/server/src/ws.ts`
- Interaction-mode switching | user | Composer can switch between Chat, Plan, and Design modes. | evidence: `apps/web/src/components/chat/CompactComposerControlsMenu.tsx`, `packages/contracts/src/orchestration/events.ts`
- Runtime-access switching | user | Composer can toggle between supervised (`approval-required`) and `full-access` runtime modes. | evidence: `apps/web/src/components/chat/CompactComposerControlsMenu.tsx`, `packages/contracts/src/providerSchemas.ts`
- Unified model/workflow/discussion picker | user | A single trigger can represent either direct model selection, a workflow selection, or a discussion selection, and choosing one clears conflicting thread context. | evidence: `apps/web/src/components/chat/UnifiedThreadPicker.tsx`, `apps/web/src/stores/workflowStore.ts`, `apps/web/src/stores/discussionStore.ts`
- Discussion role model overrides | user | Managed discussions can store per-participant model overrides in draft-thread state. | evidence: `apps/web/src/components/chat/DiscussionRolesPicker.tsx`, `apps/web/src/composerDraftStore.ts`
- Provider/model picker | user | Model picker supports Codex and Claude provider/model menus, disables unavailable providers, and shows coming-soon placeholders for future providers. | evidence: `apps/web/src/components/chat/ProviderModelPicker.tsx`
- Provider status warning banner | user | Active thread can show warning/error provider health banners when a provider is degraded or unavailable. | evidence: `apps/web/src/components/chat/ProviderStatusBanner.tsx`
- Model traits controls | user | Provider-specific traits include reasoning effort, thinking toggle, fast mode, context window options, and prompt-controlled ultrathink handling. | evidence: `apps/web/src/components/chat/TraitsPicker.tsx`, `packages/shared/src/model.ts`
- Chat header actions | user | Header exposes project scripts, open-in-editor/file-manager, git actions, terminal toggle, diff toggle, and design-preview toggle. | evidence: `apps/web/src/components/chat/ChatHeader.tsx`
- Open-in-editor picker | user | Workspace can open in Cursor, Trae, VS Code, VS Code Insiders, VSCodium, Zed, Antigravity, IntelliJ, or the system file manager, with a preferred-editor shortcut. | evidence: `apps/web/src/components/chat/OpenInPicker.tsx`, `packages/contracts/src/editor.ts`
- Primary composer actions | user | Send button adapts to running/connecting/busy state, pending-question flow, and plan follow-up actions (`Refine`, `Implement`, `Implement in a new thread`). | evidence: `apps/web/src/components/chat/ComposerPrimaryActions.tsx`
- Pending approval UX | user | Composer surfaces pending command/file-read/file-change approvals and approval counts. | evidence: `apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx`
- Permission-request UX | user | Fine-grained permission requests can be granted per turn or per session, with selectable read/write paths and network toggle. | evidence: `apps/web/src/components/chat/ComposerPendingPermissionPanel.tsx`
- MCP elicitation UX | user | MCP requests support URL opening, structured form answers, raw JSON/text responses, and accept/decline/cancel resolution. | evidence: `apps/web/src/components/chat/ComposerPendingMcpElicitationPanel.tsx`
- Pending user-input wizard | user | Interactive user-input prompts render as numbered multi-step cards with option choices, auto-advance, and digit-key shortcuts. | evidence: `apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx`, `apps/web/src/pendingUserInput.ts`
- Terminal context chips | user | Composer can attach terminal snapshots as inline chips, including expiration handling and tooltip previews. | evidence: `apps/web/src/components/chat/ComposerPendingTerminalContexts.tsx`, `apps/web/src/lib/terminalContext.ts`
- Plan follow-up banner | user | When a plan is ready, composer shows a dedicated banner and follow-up action state. | evidence: `apps/web/src/components/chat/ComposerPlanFollowUpBanner.tsx`
- Context-window meter | user | Composer shows context-window usage percent/tokens, total processed tokens, and auto-compaction hints. | evidence: `apps/web/src/components/chat/ContextWindowMeter.tsx`, `apps/web/src/lib/contextWindow.ts`
- Rate-limit meter | user | UI shows provider usage ceilings with threshold coloring and reset timing for primary and secondary windows. | evidence: `apps/web/src/components/chat/RateLimitsMeter.tsx`, `packages/contracts/src/server.ts`
- Thread error banner | user | Thread-local error conditions display as dismissible inline alerts. | evidence: `apps/web/src/components/chat/ThreadErrorBanner.tsx`
- Live timeline rendering | user | Thread history is projected into messages, tool activity, summaries, plans, inline diffs, command outputs, and subagent groups with virtualization for large histories. | evidence: `apps/web/src/components/chat/MessagesTimeline.tsx`, `apps/web/src/components/chat/MessagesTimeline.logic.ts`, `apps/web/src/session-logic/index.ts`
- Inline terminal context parsing | user | User messages can embed structured terminal-context references and have them re-rendered as concise context chips/labels. | evidence: `apps/web/src/components/chat/userMessageTerminalContexts.ts`, `apps/web/src/lib/terminalContext.ts`
- Revert and diff entry actions | user | Timeline can open per-turn diffs, expand inline diff previews, and trigger revert actions tied to checkpoint turn counts. | evidence: `apps/web/src/components/chat/MessagesTimeline.tsx`, `apps/web/src/session-logic/approvals.ts`
- Command output viewer | user | Tool output panels auto-stick to bottom, support copy, and can render notices plus bounded-height output. | evidence: `apps/web/src/components/chat/CommandOutputPanel.tsx`, `apps/web/src/components/chat/LazyCommandOutput.tsx`
- Lazy subagent activity feed | user | Parent threads can fetch, poll, and render child-provider-thread work logs on demand, with omitted-entry counts and background-task debugging support. | evidence: `apps/web/src/components/chat/LazySubagentEntries.tsx`, `apps/server/src/ws.ts`
- Background task tray | user | Composer shows a collapsible background tray for long-running commands and subagents, with running/completed/error state, elapsed time, output expansion, and subagent entries. | evidence: `apps/web/src/components/chat/ComposerBackgroundTaskTray.tsx`, `apps/web/src/session-logic/backgroundSignals.ts`
- Summary generation | user | Threads can request model-driven summaries, remember a sticky summary model, and render summary cards with model badge and copy support. | evidence: `apps/web/src/components/chat/SummarizeButton.tsx`, `apps/web/src/components/chat/SummaryCard.tsx`
- Changed-files tree | user | Message-level diff summaries can render directory/file trees with diff stats and click-through into turn diffs. | evidence: `apps/web/src/components/chat/ChangedFilesTree.tsx`
- Native bridge and WS RPC fallback | internal | Client prefers desktop-native APIs when present and otherwise falls back to WS RPC, with reconnect, resubscription, and event replay support. | evidence: `apps/web/src/nativeApi.ts`, `apps/web/src/wsNativeApi.ts`, `apps/web/src/wsTransport.ts`, `apps/web/src/wsRpcClient.ts`
- Session recovery and replay | internal | Client can bootstrap from snapshot, replay orchestration events, and coalesce streamed message events to recover after reconnects. | evidence: `apps/web/src/routes/__root.tsx`, `apps/web/src/orchestrationRecovery.ts`, `apps/web/src/orchestrationEventBatch.ts`, `apps/web/src/orchestrationEventEffects.ts`, `apps/server/src/ws.ts`
- Terminal drawer persistence | user | Terminal UI persists per-thread open state, panel height, splits, active group, running-subprocess state, and a capped event buffer with orphan cleanup. | evidence: `apps/web/src/terminalStateStore.ts`, `apps/web/src/terminalActivity.ts`

## 3. Workflows, Discussions, Plans, And Human Gates

- Agent Modes surface | user | `/agent-modes` routes into workflow and discussion authoring. | evidence: `apps/web/src/routes/agent-modes.tsx`, `apps/web/src/routes/agent-modes.workflows.*`, `apps/web/src/routes/agent-modes.discussions.*`
- Workflow library | user | Workflow editor sidebar lists built-in, global, and project-scoped workflows with scope badges and phase previews. | evidence: `apps/web/src/components/WorkflowEditor.parts.tsx`
- Workflow authoring | user | Workflows support name, description, global/project scope, create, update, validation, and built-in read-only cloning. | evidence: `apps/web/src/components/WorkflowEditor.tsx`
- Workflow phase strip | user | Phases can be added, removed, reordered, and selected from a horizontal strip. | evidence: `apps/web/src/components/WorkflowEditor.tsx`, `apps/web/src/components/PhaseCard.parts.tsx`
- Phase execution modes | user | Each phase supports single-agent, multi-agent deliberation, automated, and human modes. | evidence: `apps/web/src/components/PhaseCard.parts.tsx`, `packages/contracts/src/workflow.ts`
- Agent prompt/model controls | user | Single-agent phases support prompt-template selection, custom prompt editing, and auto vs override model choice. | evidence: `apps/web/src/components/PhaseCard.fields.tsx`
- Deliberation controls | user | Multi-agent phases expose Advocate and Interrogator definitions with separate prompts, models, and max turns. | evidence: `apps/web/src/components/PhaseCard.parts.tsx`, `packages/contracts/src/workflow.ts`
- Gate and quality-check controls | user | Phases can define post-phase gates, failure behavior, retry targets, max retries, and per-phase quality checks. | evidence: `apps/web/src/components/PhaseCard.gate.tsx`, `packages/contracts/src/workflow.ts`
- Workflow timeline | user | Runtime workflow view shows phase runs, iterations, child-session counts, outputs, transition states, and auto-expansion behavior. | evidence: `apps/web/src/components/WorkflowTimeline.tsx`, `apps/web/src/components/WorkflowTimeline.logic.ts`
- Workflow output modes | user | Phase outputs can render as conversation markdown, channel transcripts, or schema outputs with structured JSON drill-down. | evidence: `apps/web/src/components/WorkflowTimeline.parts.tsx`
- Child-session transcripts | user | Expanded phases can show attached child sessions with role/provider metadata and transcripts. | evidence: `apps/web/src/components/WorkflowTimeline.tsx`
- Human approval gate UI | user | Waiting-human phases surface approval summaries, quality-check results, correction text, and approve/correct/reject actions. | evidence: `apps/web/src/components/GateApproval.tsx`, `apps/web/src/components/WorkflowTimeline.tsx`
- Auto-jump to child sessions | user | Workflow UI can automatically navigate into newly spawned child threads during bootstrap or handoff. | evidence: `apps/web/src/components/WorkflowTimeline.tsx`
- Discussion library | user | Discussions can be filtered by all projects or a specific project, show scope badges and participant roles, and mark shadowed definitions. | evidence: `apps/web/src/components/DiscussionEditor.tsx`
- Discussion authoring | user | Discussions support create/update/delete, global vs project scope, description, participant management, role descriptions, provider/model selection, system prompts, and max turns. | evidence: `apps/web/src/components/DiscussionEditor.tsx`, `apps/web/src/components/DiscussionEditor.logic.ts`, `packages/contracts/src/discussion.ts`
- Proposed plan sidebar | user | Active plans show explanation, step statuses, timestamps, and expandable markdown. | evidence: `apps/web/src/components/PlanSidebar.tsx`
- Plan export and handoff | user | Proposed plans can be copied, downloaded, saved into the workspace, and transformed into implementation prompts, titles, and filenames. | evidence: `apps/web/src/components/PlanSidebar.tsx`, `apps/web/src/proposedPlan.ts`

## 4. Git, Worktrees, Diffs, Design, And Project Scripts

- Project scripts launcher | user | Each project can define runnable scripts with a preferred primary action, dropdown launcher, shortcuts, icon picker, edit dialog, and delete confirmation. | evidence: `apps/web/src/components/ProjectScriptsControl.tsx`, `apps/web/src/components/ProjectScriptsControl.parts.tsx`
- Worktree bootstrap scripts | user | Project scripts can be marked `run automatically on worktree creation`. | evidence: `apps/web/src/components/ProjectScriptsControl.tsx`, `packages/contracts/src/orchestration/types.ts`
- Git quick action menu | user | Header git control adapts to repo state and exposes init, commit, push, PR creation/opening, and composite stacked actions. | evidence: `apps/web/src/components/GitActionsControl.tsx`, `packages/contracts/src/git.ts`
- Commit review dialog | user | Pre-commit UI can review changed files, include/exclude files, open files in editor, enter message text, and commit on a new branch. | evidence: `apps/web/src/components/GitActionsControl.tsx`
- Git guardrails | user | Default-branch actions can be intercepted with confirmation and progress toasts stay scoped to the initiating thread. | evidence: `apps/web/src/components/GitActionsControl.tsx`, `apps/web/src/components/GitActionsControl.browser.tsx`
- Branch/worktree toolbar | user | Threads can switch between local and new-worktree environments, specify worktree branch names, and show an attached `Worktree` badge. | evidence: `apps/web/src/components/BranchToolbar.tsx`
- Branch selector | user | Searchable branch picker supports infinite loading, virtualization, local/remote checkout, create-branch, existing-worktree reuse, and PR checkout parsing from `#123`, GitHub URLs, or `gh pr checkout ...`. | evidence: `apps/web/src/components/BranchToolbarBranchSelector.tsx`, `apps/web/src/pullRequestReference.ts`
- Route-addressable diff state | user | Diff open state, mode, selected turn, selected file, and design-panel state are encoded in route search params. | evidence: `apps/web/src/diffRouteSearch.ts`, `apps/web/src/routes/_chat.$threadId.tsx`
- Diff modes | user | Diff UI supports agent-attributed diffs vs full-workspace diffs, stacked vs split rendering, word wrap, and manual refresh of non-live workspace diffs. | evidence: `apps/web/src/components/DiffPanel.tsx`
- Diff browsing | user | Diffs can auto-scroll to selected files, show turn-selection chips including `All turns`, virtualize large file lists, and open changed files in the preferred editor. | evidence: `apps/web/src/components/DiffPanel.tsx`, `apps/web/src/components/DiffPanelBody.tsx`
- Diff fallbacks | user | Agent diffs can fall back to workspace snapshots when attribution coverage is unavailable, and huge patches can defer rendering behind a user-triggered action. | evidence: `apps/web/src/components/DiffPanel.logic.ts`, `apps/web/src/components/DiffPanelBody.tsx`
- Compact diff rendering | user | Inline/compact diff cards support stacked and split previews, overflow clamping, summary headers, and raw fallback notices. | evidence: `apps/web/src/components/diff/*.tsx`
- Design preview | user | Design threads can render HTML artifacts in a sandboxed iframe, switch among multiple artifacts, and preview mobile/tablet/desktop viewport widths. | evidence: `apps/web/src/components/DesignPreviewPanel.tsx`
- Design option resolution | user | When design mode returns multiple options, user can choose an option in-panel and the panel auto-opens when artifacts/options first arrive. | evidence: `apps/web/src/components/DesignPreviewPanel.tsx`, `apps/web/src/routes/_chat.$threadId.tsx`
- Design export to thread | user | Selected design artifacts can be exported into a new thread with artifact and screenshot references. | evidence: `apps/web/src/components/DesignPreviewPanel.tsx`

## 5. Server Runtime, WS API, Providers, And Terminals

- Runtime modes and startup | operator | `forge` supports `web`, `desktop`, and `daemon` modes, derives config from flags/env/bootstrap-FD, and composes HTTP, WS, provider, terminal, orchestration, and persistence layers. | evidence: `apps/server/src/cli.ts`, `apps/server/src/server.ts`
- Daemon lifecycle CLI | operator | CLI can start, stop, restart, inspect, and clean daemon-managed worktree directories. | evidence: `apps/server/src/cli.ts`
- Daemon session control CLI | operator | CLI can create/list/status sessions, send turns/corrections, approve/reject gates, retry/skip bootstrap, intervene in channels, pause/resume/cancel, answer requests, tail transcripts, and subscribe to event streams. | evidence: `apps/server/src/cli.ts`
- HTTP server surfaces | user | Server exposes `/health`, static client serving, dev-server redirect mode, safe attachment routes, project favicon routes, and design/shared-chat bridge endpoints. | evidence: `apps/server/src/http.ts`
- WS orchestration API | user | `/ws` exposes orchestration snapshot reads, command output, subagent feeds, event replay, thread diffs, full-thread diffs, and agent diffs. | evidence: `apps/server/src/ws.ts`, `packages/contracts/src/orchestration/rpcSchemas.ts`
- WS workflow/discussion/channel API | user | WS exposes transcript reads, child-session reads, request resolution, channel reads, phase outputs, workflow CRUD, discussion CRUD, and live workflow/channel push subscriptions. | evidence: `apps/server/src/ws.ts`
- WS config/settings API | operator | WS can fetch and patch server settings, upsert keybindings, refresh provider snapshots, and subscribe to provider/settings/rate-limit/lifecycle streams. | evidence: `apps/server/src/ws.ts`, `packages/contracts/src/server.ts`
- Workspace and editor API | user | WS can search project entries, guarded-write files inside workspace roots, and open editors/file managers. | evidence: `apps/server/src/ws.ts`, `packages/contracts/src/project.ts`
- Git API | user | WS exposes git status, working-tree diff, pull, stacked-action progress, PR resolution/prep, branch listing/creation/checkout, worktree create/remove, and repo init. | evidence: `apps/server/src/ws.ts`, `packages/contracts/src/git.ts`
- Terminal API | user | WS supports open/write/resize/clear/restart/close terminal sessions, event subscription, history persistence, multiple terminal ids per thread, and running-subprocess state. | evidence: `apps/server/src/ws.ts`, `apps/server/src/terminal/Layers/Manager.ts`, `packages/contracts/src/terminal.ts`
- Lifecycle startup events | user | Server emits `welcome` and `ready` lifecycle streams, including optional bootstrap project/thread ids. | evidence: `apps/server/src/serverRuntimeStartup.ts`, `apps/server/src/serverLifecycleEvents.ts`, `packages/contracts/src/server.ts`
- Auto-bootstrap from current cwd | user | Startup can create a project and first thread from the current working directory when appropriate. | evidence: `apps/server/src/cli.ts`, `apps/server/src/serverRuntimeStartup.ts`
- Server settings service | operator | Settings are sparse JSON with defaults, file-watch reload, validation, and fallback provider/model logic for text generation. | evidence: `apps/server/src/serverSettings.ts`, `packages/contracts/src/settings.ts`
- Keybindings service | operator | Keybindings have defaults, JSON validation, startup backfill, atomic upserts, and watch-driven live updates. | evidence: `apps/server/src/keybindings.ts`, `packages/contracts/src/keybindings.ts`
- Provider registry | operator | Registry aggregates Codex and Claude provider health/auth/version/model snapshots and streams updates into the UI. | evidence: `apps/server/src/provider/Layers/ProviderRegistry.ts`
- Provider session orchestration | internal | Provider service validates inputs, enforces enablement, persists runtime bindings, recovers sessions from persisted state, and supports start/send/interrupt/respond/stop/list/fork/rollback. | evidence: `apps/server/src/provider/Layers/ProviderService.ts`, `apps/server/src/provider/Layers/ProviderSessionDirectory.ts`
- Codex provider runtime | user | Codex integration includes CLI version/auth probing, model capabilities, `codex app-server` session start/resume, turn send/interrupt, model switching, rollback, fork, MCP server injection, and system-prompt injection. | evidence: `apps/server/src/provider/Layers/CodexProvider.ts`, `apps/server/src/provider/Layers/CodexAdapter.ts`, `apps/server/src/codexAppServerManager.ts`
- Claude provider runtime | user | Claude integration includes CLI/auth probing, subscription-aware capability adjustments, SDK-backed sessions, MCP registration, model switching, rollback, and fork. | evidence: `apps/server/src/provider/Layers/ClaudeProvider.ts`, `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- Attachment and image handling | user | Server normalizes attachment ids/extensions, stores attachments, and infers image MIME information. | evidence: `apps/server/src/attachmentStore.ts`, `apps/server/src/imageMime.ts`
- Editor launch service | user | Server can discover editors and launch them, including WSL-aware Windows editor bridging and file-manager support. | evidence: `apps/server/src/open.ts`, `packages/contracts/src/editor.ts`

## 6. Orchestration, Daemon, Persistence, Observability, And Workspace Services

- Bootstrap envelope intake | internal | Server can read bootstrap JSON from an arbitrary inherited file descriptor with timeout and cross-platform fd duplication logic. | evidence: `apps/server/src/bootstrap.ts`
- Daemon singleton lifecycle | operator | Daemon mode enforces single-instance ownership, trusted socket/manifest validation, stale-state cleanup, and graceful/forced shutdown. | evidence: `apps/server/src/daemon/Layers/DaemonService.ts`, `packages/shared/src/daemon.ts`
- Daemon JSON-RPC socket | operator | Daemon exposes a protocol-versioned JSON-RPC socket with `daemon.ping`, `daemon.stop`, and higher-level session/thread/workflow/discussion/channel RPC. | evidence: `apps/server/src/daemon/protocol.ts`, `apps/server/src/daemon/Layers/SocketTransport.ts`
- Notification reactor | user | Daemon can emit desktop notifications for sessions needing attention, session completion, and deliberation completion with deep links. | evidence: `apps/server/src/daemon/Layers/NotificationReactor.ts`, `apps/server/src/daemon/Layers/NotificationDispatch.ts`
- Structured debug logging | operator | `FORGE_DEBUG` drives topic-based NDJSON debug output mirrored to stderr. | evidence: `apps/server/src/debug.ts`
- Observability pipeline | operator | Local trace files are always written and OTLP traces/metrics can be exported when configured. | evidence: `apps/server/src/observability/Layers/Observability.ts`, `apps/server/src/observability/LocalFileTracer.ts`, `apps/server/src/observability/TraceSink.ts`
- RPC instrumentation | operator | RPC calls record span metadata plus per-method duration/outcome metrics. | evidence: `apps/server/src/observability/RpcInstrumentation.ts`
- Analytics hooks | operator | Anonymous analytics identify users from hashed provider identity or persisted anonymous id and attach platform/version metadata. | evidence: `apps/server/src/telemetry/Identify.ts`, `apps/server/src/telemetry/Layers/AnalyticsService.ts`
- SQLite + migrations | internal | Runtime selects Bun or Node SQLite backends, enables WAL/foreign keys, and auto-runs migrations. | evidence: `apps/server/src/persistence/Layers/Sqlite.ts`, `apps/server/src/persistence/Migrations.ts`, `apps/server/src/NodeSqliteClient.ts`
- Event store and command receipts | internal | Ordered orchestration events and command receipts are persisted for replay, dedupe, and recovery. | evidence: `apps/server/src/persistence/Layers/OrchestrationEventStore.ts`, `apps/server/src/persistence/Layers/OrchestrationCommandReceipts.ts`
- Projection model | internal | Server persists projects, threads, messages, activities, turns, checkpoints, workflows, phase runs, phase outputs, channels, pending approvals, pending requests, and agent diffs. | evidence: `apps/server/src/persistence/Services/*`, `apps/server/src/persistence/Migrations/*`
- Recovery and reconciliation | internal | Stored provider runtime bindings, projector cursors, and pending-turn/request state support startup reconciliation after restarts. | evidence: `apps/server/src/persistence/Layers/ProviderSessionRuntime.ts`, `apps/server/src/orchestration/Layers/StartupReconciliation.ts`
- Workspace search and guarded file writes | user | Workspace layer normalizes roots, blocks traversal/absolute escape, writes files relative to workspace, and offers cached git-aware or filesystem fallback entry search. | evidence: `apps/server/src/workspace/Layers/WorkspacePaths.ts`, `apps/server/src/workspace/Layers/WorkspaceFileSystem.ts`, `apps/server/src/workspace/Layers/WorkspaceEntries.ts`
- Process execution safeguards | internal | Shared subprocess runner enforces timeout, output limits, stdin piping, truncation behavior, and platform-specific cleanup. | evidence: `apps/server/src/processRunner.ts`

## 7. Desktop Shell, Native Bridge, And Distribution

- Electron desktop bridge | user | Renderer gets a native bridge for folder picking, confirms, theme setting, context menus, external links, update state/actions, connection management, WSL discovery, and open-in-editor. | evidence: `apps/desktop/src/preload.ts`, `packages/contracts/src/ipc.ts`
- Local vs WSL vs external connection modes | user | Desktop app can connect to a locally managed daemon, a Forge instance inside WSL, or an arbitrary external WS server. | evidence: `apps/desktop/src/connectionConfig.ts`, `apps/desktop/src/main.ts`
- Protocol-handler and single-instance behavior | user | Desktop app registers `forge://` handling and coordinates second-instance/open-url routing. | evidence: `apps/desktop/src/daemonLifecycle.ts`, `apps/desktop/src/main.ts`
- Managed daemon launch | user | Desktop can spawn and supervise a detached local daemon, detect an existing daemon, and reconnect after connection changes. | evidence: `apps/desktop/src/daemonLifecycle.ts`, `apps/desktop/src/main.ts`
- WSL integration | user | Windows desktop can enumerate WSL distros, verify a Forge binary inside a distro, resolve WSL home, translate Linux paths to UNC, and launch the backend through `wsl.exe`. | evidence: `apps/desktop/src/wsl.ts`, `apps/desktop/src/daemonLifecycle.ts`, `apps/desktop/src/main.ts`
- WSL editor launch | user | In WSL mode, desktop can detect Windows editor CLIs and open Linux paths in Windows editors/file manager with line/column support. | evidence: `apps/desktop/src/editorLaunch.ts`
- Native folder picking and confirmations | user | Desktop IPC supports folder selection, confirm dialogs, safe external URL opening, and native context menus. | evidence: `apps/desktop/src/main.ts`, `apps/desktop/src/preload.ts`
- Desktop tray and status | user | Desktop maintains a tray icon/menu reflecting daemon status and common actions. | evidence: `apps/desktop/src/main.ts`
- Auto-update system | user | Desktop supports update checks, download/install, feed configuration, startup polling, progress broadcasting, and packaged-build eligibility rules. | evidence: `apps/desktop/src/main.ts`, `apps/desktop/src/updateMachine.ts`, `apps/desktop/src/updateState.ts`
- Desktop logging | operator | Packaged desktop build captures stdout/stderr into rotating logs and records desktop lifecycle metadata. | evidence: `apps/desktop/src/main.ts`, `packages/shared/src/logging.ts`
- Marketing landing page | user | Marketing site shows hero download CTA, screenshot, and platform-detected asset selection. | evidence: `apps/marketing/src/pages/index.astro`, `apps/marketing/src/lib/releases.ts`
- Download page | user | Download page lists platform-specific installers, latest release tag, changelog link, and fallback to GitHub Releases. | evidence: `apps/marketing/src/pages/download.astro`, `apps/marketing/src/lib/releases.ts`

## 8. Hidden, Conditional, And Gated Behavior

- Desktop connection setup only appears when running in Electron and no desktop WS URL has been configured. | evidence: `apps/web/src/routes/__root.tsx`
- WSL setup is Windows/Electron-specific and depends on available distros plus a resolvable Forge binary inside WSL. | evidence: `apps/web/src/components/ConnectionSetup.tsx`, `apps/desktop/src/wsl.ts`
- External-server connect is gated on a successful connection test before the UI enables a full connect/save flow. | evidence: `apps/web/src/components/ConnectionSetup.tsx`, `apps/desktop/src/main.ts`
- Add-project behavior differs by platform: Electron can browse for folders, while non-Electron/web falls back to typed path entry. | evidence: `apps/web/src/components/sidebar/useSidebarInteractions.ts`
- Manual project drag-reordering is only active when project sort order is `manual`. | evidence: `apps/web/src/components/Sidebar.tsx`
- Traits menu only appears when the selected model exposes effort/thinking/context-window controls. | evidence: `apps/web/src/components/chat/TraitsPicker.tsx`
- Workflow/discussion targeting menus only appear when a draft thread exists and matching workflow/discussion data is available. | evidence: `apps/web/src/components/chat/UnifiedThreadPicker.tsx`
- Discussion role picker is hidden when the selected discussion has no participants. | evidence: `apps/web/src/components/chat/DiscussionRolesPicker.tsx`
- Workflow built-ins are viewable but not directly editable; they must be cloned before saving. | evidence: `apps/web/src/components/WorkflowEditor.tsx`
- Discussion `Shadowed` status is conditional on managed/effective discussion resolution. | evidence: `apps/web/src/components/DiscussionEditor.tsx`
- Branch selector behavior changes in worktree mode: branch choice can become base-branch selection instead of immediate checkout. | evidence: `apps/web/src/components/BranchToolbarBranchSelector.tsx`
- `diffTurnId` and `diffFilePath` only remain meaningful in agent-diff mode; workspace mode strips them. | evidence: `apps/web/src/diffRouteSearch.ts`
- Huge diffs deliberately defer rich rendering until the user requests it. | evidence: `apps/web/src/components/DiffPanelBody.tsx`
- Design preview only appears in design interaction mode and auto-opens once artifacts or pending choices first arrive. | evidence: `apps/web/src/routes/_chat.$threadId.tsx`, `apps/web/src/components/chat/ChatHeader.tsx`
- Save-plan-to-workspace requires both a workspace root and a live native API connection. | evidence: `apps/web/src/components/PlanSidebar.tsx`
- Direct summary dispatch remains disabled until the user has chosen a sticky summary model. | evidence: `apps/web/src/components/chat/SummarizeButton.tsx`
- Provider availability is conditional on enablement, binary discovery, auth status, provider-specific probes, and subscription/model capability detection. | evidence: `apps/server/src/provider/Layers/CodexProvider.ts`, `apps/server/src/provider/Layers/ClaudeProvider.ts`
- Provider session recovery depends on persisted runtime bindings and usually a stored resume cursor; missing state does not silently recreate sessions. | evidence: `apps/server/src/provider/Layers/ProviderService.ts`
- Terminal spawn environment strips `FORGE_*`, `VITE_*`, and selected port env vars before launching shells. | evidence: `apps/server/src/terminal/Layers/Manager.ts`
- Terminal history persists across reopen/restart unless explicitly deleted. | evidence: `apps/server/src/terminal/Layers/Manager.ts`
- `/ws` and bridge endpoints only require auth if `config.authToken` is set; otherwise they run unauthenticated. | evidence: `apps/server/src/ws.ts`, `apps/server/src/http.ts`
- `web` mode defaults `autoBootstrapProjectFromCwd=true`; `desktop` and `daemon` pin loopback/no-browser defaults differently. | evidence: `apps/server/src/cli.ts`
- OTLP export is conditional on configured URLs, while local trace-file capture is always constructed. | evidence: `apps/server/src/observability/Layers/Observability.ts`
- Auto-update is only enabled in packaged production builds, and Linux auto-update requires AppImage packaging. | evidence: `apps/desktop/src/updateState.ts`

## 9. Latent, Incomplete, Or Ambiguous Surfaces

- Workflow deletion looks partially implemented in component props but is not wired into the current editor flow. | evidence: `apps/web/src/components/WorkflowEditor.parts.tsx`, `apps/web/src/components/WorkflowEditor.tsx`
- Workflow scope selection is implicit: project-scoped workflows auto-bind to the first project rather than exposing a full explicit picker. | evidence: `apps/web/src/components/WorkflowEditor.tsx`
- Discussion project scoping for new items is influenced by sidebar filter state rather than a dedicated project picker. | evidence: `apps/web/src/components/DiscussionEditor.tsx`
- Workflow-picker logic distinguishes `discussion` vs `workflow` items via deliberation, but that split is not obviously exposed as a dedicated user-facing picker surface in the audited files. | evidence: `apps/web/src/components/WorkflowPicker.logic.ts`
- Some persistence tables exist without clearly exposed runtime services in this repo slice, including raw checkpoint diff blobs and several phase/session provenance tables. | evidence: `apps/server/src/persistence/Migrations/003_CheckpointDiffBlobs.ts`, `apps/server/src/persistence/Migrations/021_ChannelTables.ts`, `apps/server/src/persistence/Migrations/023_PhaseOutputTables.ts`
- `sessionType.ts` includes a `chat` session type while the audited CLI create path only surfaced `agent` and `workflow`; the primary `chat` creation entrypoint appears to be elsewhere in the stack. | evidence: `apps/server/src/sessionType.ts`, `apps/server/src/cli.ts`
- Codex dynamic tool plumbing exists in `codexAppServerManager`, but the exact exposed product flow is not self-contained in the audited provider slice. | evidence: `apps/server/src/codexAppServerManager.ts`
- Shared-chat/design bridge tokens are clearly consumed by HTTP routes, but token issuance/cleanup are managed out-of-band from the routes themselves. | evidence: `apps/server/src/http.ts`, `apps/server/src/design/designBridge.ts`, `apps/server/src/discussion/sharedChatBridge.ts`
- Design export and selection error handling leans on console logging in places rather than consistently surfacing user-visible failure UI. | evidence: `apps/web/src/components/DesignPreviewPanel.tsx`
- Background tray ownership is partly unresolved: some timeline/tray ownership helpers are effectively no-ops, which suggests unfinished inline-vs-tray separation. | evidence: `apps/web/src/session-logic/utils.ts`, `apps/web/src/session-logic/timeline.ts`
- Codex subagent fan-out is lossy in at least one path: only the first matched child subagent group is attached to a parent spawn row. | evidence: `apps/web/src/session-logic/subagentGrouping.ts`

## 10. Bottom Line

Forge is already much broader than a basic chat wrapper. The current product surface spans:
- Multi-provider coding-agent sessions with live streaming, approvals, permission negotiation, MCP elicitation, summaries, and subagent/background-task visibility.
- Full workflow and discussion authoring plus runtime workflow timelines and human approval gates.
- Git/worktree orchestration, route-addressable diff review, design-mode artifact preview/export, and project script automation.
- A real server platform with daemon mode, event sourcing/projections, terminal multiplexing, provider recovery, observability, analytics, and guarded workspace APIs.
- A desktop shell with managed daemon lifecycle, WSL bridging, native editor integration, updater flows, and a separate marketing/download surface.

This audit intentionally separates clearly surfaced product behavior from conditional and latent plumbing so the current feature set is not overstated.
