# Forge Frontend Source-Code Exploration

> Exhaustive feature and implementation inventory of `/home/sabossedgh/dev/external/forge/apps/web/`
> Generated from direct source-code reading, not docs or archives.

---

## 1. Directory Structure

```
apps/web/src/
  branding.ts                     # App name/version constants (Forge Alpha)
  chat-scroll.ts                  # Chat auto-scroll behavior
  composer-editor-mentions.ts     # @-mention parsing in composer (segments: text, mention, terminal-context)
  composer-logic.ts               # Slash command detection, trigger detection, cursor management
  composerDraftStore.ts           # Zustand store for draft threads, persisted to localStorage
  contextMenuFallback.ts          # Browser fallback for native context menus
  debug.ts                        # Debug utilities
  devServerSocketErrors.ts        # Dev server socket error handling
  diffRouteSearch.ts              # URL search param parsing for diff panel state
  editorPreferences.ts            # Preferred editor resolution/persistence
  env.ts                          # Environment detection (isElectron, etc.)
  historyBootstrap.ts             # History bootstrap logic
  keybindings.ts                  # Keyboard shortcut resolution, formatting, matching
  main.tsx                        # App entry point
  markdown-links.ts               # Markdown link processing
  modelSelection.ts               # Model selection logic, custom model management
  nativeApi.ts                    # NativeApi singleton (bridges to wsNativeApi or window.nativeApi)
  orchestrationEventBatch.ts      # Safe batch application of orchestration events
  orchestrationEventEffects.ts    # Derives side effects from orchestration event batches
  orchestrationRecovery.ts        # Recovery coordinator: bootstrap, replay, snapshot fallback
  pendingUserInput.ts             # Pending user input extraction
  productIdentity.ts              # Product identity utilities
  projectScripts.ts               # Project script management
  proposedPlan.ts                 # Proposed plan utilities
  providerModels.ts               # Provider model resolution
  pullRequestReference.ts         # PR reference parsing
  pushEventRouter.ts              # Routes workflow/channel push events to stores
  routeTree.gen.ts                # TanStack Router generated route tree
  router.ts                       # Router configuration
  store.ts                        # Main Zustand store (AppState: projects, threads, sidebar summaries)
  storeEventHandlers.ts           # Event handler implementations for the main store
  storeMappers.ts                 # Mapping functions for store transformations
  storeSelectors.ts               # Selector hooks (useThreadById, etc.)
  storeSidebar.ts                 # Sidebar-specific store computations
  storeStateHelpers.ts            # State update helpers
  terminalActivity.ts             # Terminal subprocess activity detection
  terminalStateStore.ts           # Zustand store for per-thread terminal UI state (persisted)
  terminal-links.ts               # Terminal link detection
  threadSelectionStore.ts         # Zustand store for multi-select (Cmd+Click, Shift+Click range)
  timestampFormat.ts              # Timestamp formatting utilities
  types.ts                        # Core type definitions (Thread, ChatMessage, Project, etc.)
  uiStateStore.ts                 # Zustand store for UI state (project expansion, ordering, thread visits)
  vscode-icons.ts                 # VS Code icon resolution for file types
  worktreeCleanup.ts              # Worktree orphan detection and cleanup
  wsNativeApi.ts                  # WebSocket-based NativeApi implementation
  wsRpcClient.ts                  # Typed WS RPC client wrapping WsTransport
  wsTransport.ts                  # Effect-based WebSocket transport (request, requestStream, subscribe)

  components/                     # All UI components (see Section 3)
  hooks/                          # React hooks
  lib/                            # Utility libraries
  routes/                         # TanStack Router file-based routes
  rpc/                            # RPC client, server state atoms, protocol
  session-logic/                  # Session projection, timeline, work log, tool enrichment
  stores/                         # Feature-specific Zustand stores (workflow, channel, discussion)
```

---

## 2. Route Map

Uses **TanStack Router** with file-based routing.

| Route File                                                       | URL Pattern                                                   | Params                        | Component                    | Description                                                                                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `__root.tsx`                                                     | `/` (root layout)                                             | --                            | `RootRouteView`              | App shell: toast providers, connection setup, event router, sidebar layout. Shows `ConnectingView` or `DaemonVersionMismatchView` on error.                    |
| `_chat.tsx`                                                      | `/_chat` (layout)                                             | --                            | `ChatRouteLayout`            | Wraps chat routes. Registers global shortcuts (`chat.new`, `chat.newLocal`, Escape to clear selection).                                                        |
| `_chat.index.tsx`                                                | `/`                                                           | --                            | `ChatIndexRouteView`         | Empty state: "Select a thread or create a new one."                                                                                                            |
| `_chat.$threadId.tsx`                                            | `/$threadId`                                                  | `threadId`                    | `ChatThreadRouteView`        | Main chat view. Search params: `diff`, `diffMode` (agent/workspace), `diffTurnId`, `diffFilePath`, `designPanel`. Renders `ChatView` + diff/design side panel. |
| `settings.tsx`                                                   | `/settings`                                                   | --                            | `SettingsContentLayout`      | Settings layout with restore-defaults button. Redirects `/settings` to `/settings/general`.                                                                    |
| `settings.general.tsx`                                           | `/settings/general`                                           | --                            | `GeneralSettingsPanel`       | General settings panel.                                                                                                                                        |
| `settings.archived.tsx`                                          | `/settings/archived`                                          | --                            | `ArchivedThreadsPanel`       | Archived threads management.                                                                                                                                   |
| `agent-modes.tsx`                                                | `/agent-modes`                                                | --                            | Layout                       | Redirects to `/agent-modes/workflows`.                                                                                                                         |
| `agent-modes.workflows.tsx`                                      | `/agent-modes/workflows`                                      | --                            | Layout                       | Workflow sub-layout.                                                                                                                                           |
| `agent-modes.workflows.index.tsx`                                | `/agent-modes/workflows/`                                     | --                            | `WorkflowEditor` (null)      | New workflow creation.                                                                                                                                         |
| `agent-modes.workflows.$workflowId.tsx`                          | `/agent-modes/workflows/$workflowId`                          | `workflowId`                  | `WorkflowEditor`             | Edit existing workflow.                                                                                                                                        |
| `agent-modes.discussions.tsx`                                    | `/agent-modes/discussions`                                    | --                            | Layout                       | Discussion sub-layout.                                                                                                                                         |
| `agent-modes.discussions.index.tsx`                              | `/agent-modes/discussions/`                                   | --                            | `DiscussionEditor` (null)    | New discussion creation.                                                                                                                                       |
| `agent-modes.discussions.global.$discussionName.tsx`             | `/agent-modes/discussions/global/$discussionName`             | `discussionName`              | `DiscussionEditor` (global)  | Edit global discussion.                                                                                                                                        |
| `agent-modes.discussions.project.$projectId.$discussionName.tsx` | `/agent-modes/discussions/project/$projectId/$discussionName` | `projectId`, `discussionName` | `DiscussionEditor` (project) | Edit project-scoped discussion.                                                                                                                                |

---

## 3. Component Inventory

### 3.1 Root / Layout Components

| Component                   | File                              | Description                                                                                                                                  |
| --------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `RootRouteView`             | `routes/__root.tsx`               | Top-level: Electron connection check, toast providers, server state bootstrap, event router, app sidebar layout                              |
| `ConnectingView`            | `routes/__root.tsx`               | "Connecting to Forge server..." placeholder                                                                                                  |
| `DaemonVersionMismatchView` | `routes/__root.tsx`               | Version mismatch error with daemon version details                                                                                           |
| `RootRouteErrorView`        | `routes/__root.tsx`               | Error boundary with expandable details                                                                                                       |
| `EventRouter`               | `routes/__root.tsx`               | Subscribes to orchestration domain events, terminal events, workflow/channel push events. Orchestrates recovery (replay, snapshot fallback). |
| `ServerStateBootstrap`      | `routes/__root.tsx`               | Initiates server state sync on mount                                                                                                         |
| `AppSidebarLayout`          | `components/AppSidebarLayout.tsx` | Two-column layout: main sidebar + content area                                                                                               |
| `ConnectionSetup`           | `components/ConnectionSetup.tsx`  | Electron-only setup UI when no server URL configured                                                                                         |

### 3.2 Chat Components (Main View)

| Component           | File                              | Description                                                                                                                                                                                                                                                                                         |
| ------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChatView`          | `components/ChatView.tsx` (196KB) | **Massive** main chat component. Handles: message sending, model selection, runtime mode, interaction mode, composer state, thread lifecycle, approvals, pending inputs, terminal contexts, image attachments, summarization, worktree management, design mode, workflow execution, quality checks. |
| `ChatView.logic.ts` | `components/ChatView.logic.ts`    | Logic: draft thread building, inline turn diff summaries, terminal thread reconciliation, last-invoked script tracking                                                                                                                                                                              |
| `ChatMarkdown`      | `components/ChatMarkdown.tsx`     | Markdown renderer for chat messages with custom link handling, code blocks, copy buttons                                                                                                                                                                                                            |
| `ChatHeader`        | `components/chat/ChatHeader.tsx`  | Thread header bar with thread title, navigation                                                                                                                                                                                                                                                     |

### 3.3 Chat Sub-Components

| Component                            | File                                                     | Description                                                                                                    |
| ------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `MessagesTimeline`                   | `components/chat/MessagesTimeline.tsx`                   | Renders timeline of messages, work entries, proposed plans, and "working" indicators. Supports virtualization. |
| `MessagesTimeline.logic.ts`          | `components/chat/MessagesTimeline.logic.ts`              | Row derivation: work-group, work-entry, message, proposed-plan, working rows. Duration computation.            |
| `ComposerCommandMenu`                | `components/chat/ComposerCommandMenu.tsx`                | Slash command menu (`/model`, `/plan`, `/default`, `/design`)                                                  |
| `ComposerPendingApprovalPanel`       | `components/chat/ComposerPendingApprovalPanel.tsx`       | Panel shown when tool call needs approval (command, file-read, file-change)                                    |
| `ComposerPendingApprovalActions`     | `components/chat/ComposerPendingApprovalActions.tsx`     | Approve/reject action buttons for pending approvals                                                            |
| `ComposerPendingPermissionPanel`     | `components/chat/ComposerPendingPermissionPanel.tsx`     | Permission request panel                                                                                       |
| `ComposerPendingUserInputPanel`      | `components/chat/ComposerPendingUserInputPanel.tsx`      | Panel for pending user input questions                                                                         |
| `ComposerPendingMcpElicitationPanel` | `components/chat/ComposerPendingMcpElicitationPanel.tsx` | MCP elicitation request panel                                                                                  |
| `ComposerPendingTerminalContexts`    | `components/chat/ComposerPendingTerminalContexts.tsx`    | Terminal context selection chips in composer                                                                   |
| `ComposerBackgroundTaskTray`         | `components/chat/ComposerBackgroundTaskTray.tsx`         | Tray showing background tasks (agent tasks, commands) with running/completed status                            |
| `ComposerPlanFollowUpBanner`         | `components/chat/ComposerPlanFollowUpBanner.tsx`         | Banner for plan follow-up actions                                                                              |
| `ComposerPrimaryActions`             | `components/chat/ComposerPrimaryActions.tsx`             | Send/stop/interrupt buttons                                                                                    |
| `CompactComposerControlsMenu`        | `components/chat/CompactComposerControlsMenu.tsx`        | Compact version of composer controls for narrow viewports                                                      |
| `ComposerPromptEditor`               | `components/ComposerPromptEditor.tsx` (35KB)             | Rich text editor for composer with @-mention autocomplete, slash commands, terminal context chips, image paste |
| `ContextWindowMeter`                 | `components/chat/ContextWindowMeter.tsx`                 | Visual meter showing context window usage                                                                      |
| `RateLimitsMeter`                    | `components/chat/RateLimitsMeter.tsx`                    | Rate limits display                                                                                            |
| `DiffStatLabel`                      | `components/chat/DiffStatLabel.tsx`                      | Inline diff stat display (+N/-M)                                                                               |
| `DiscussionRolesPicker`              | `components/chat/DiscussionRolesPicker.tsx`              | Picker for discussion participant roles                                                                        |
| `ExpandedImagePreview`               | `components/chat/ExpandedImagePreview.tsx`               | Full-size image preview overlay                                                                                |
| `LazyCommandOutput`                  | `components/chat/LazyCommandOutput.tsx`                  | Lazy-loaded command output display                                                                             |
| `LazySubagentEntries`                | `components/chat/LazySubagentEntries.tsx`                | Lazy-loaded subagent activity feed                                                                             |
| `MessageCopyButton`                  | `components/chat/MessageCopyButton.tsx`                  | Copy-to-clipboard for messages                                                                                 |
| `OpenInPicker`                       | `components/chat/OpenInPicker.tsx`                       | "Open in [editor]" picker                                                                                      |
| `ProposedPlanCard`                   | `components/chat/ProposedPlanCard.tsx`                   | Card rendering a proposed plan with implement/dismiss actions                                                  |
| `ProviderModelPicker`                | `components/chat/ProviderModelPicker.tsx`                | Provider (Codex/Claude) and model selector dropdown                                                            |
| `ProviderStatusBanner`               | `components/chat/ProviderStatusBanner.tsx`               | Banner for provider status issues                                                                              |
| `SubagentHeading`                    | `components/chat/SubagentHeading.tsx`                    | Heading for subagent activity sections                                                                         |
| `SummarizeButton`                    | `components/chat/SummarizeButton.tsx`                    | Button to trigger conversation summarization                                                                   |
| `SummaryCard`                        | `components/chat/SummaryCard.tsx`                        | Card showing a conversation summary                                                                            |
| `TerminalContextInlineChip`          | `components/chat/TerminalContextInlineChip.tsx`          | Inline chip showing terminal context attachment                                                                |
| `ThreadErrorBanner`                  | `components/chat/ThreadErrorBanner.tsx`                  | Error banner for thread-level errors                                                                           |
| `TraitsPicker`                       | `components/chat/TraitsPicker.tsx`                       | Picker for provider traits/options                                                                             |
| `UnifiedThreadPicker`                | `components/chat/UnifiedThreadPicker.tsx`                | Unified thread/workflow picker for new thread creation                                                         |
| `VscodeEntryIcon`                    | `components/chat/VscodeEntryIcon.tsx`                    | VS Code-style file icon component                                                                              |
| `ChangedFilesTree`                   | `components/chat/ChangedFilesTree.tsx`                   | Tree view of files changed in a turn                                                                           |
| `CommandOutputPanel`                 | `components/chat/CommandOutputPanel.tsx`                 | Expandable panel for command output display                                                                    |

### 3.4 Composer Support Files

| File                              | Description                                                     |
| --------------------------------- | --------------------------------------------------------------- |
| `composerFooterLayout.ts`         | Layout logic for composer footer (responsive column rules)      |
| `composerInlineChip.ts`           | Inline chip styling/sizing                                      |
| `composerProviderRegistry.tsx`    | Provider registry for composer (maps providers to their config) |
| `backgroundStatusPresentation.ts` | Background task status formatting                               |
| `subagentPresentation.ts`         | Subagent display helpers                                        |
| `userMessageTerminalContexts.ts`  | Terminal context extraction from user messages                  |

### 3.5 Sidebar Components

| Component                    | File                                                | Description                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Sidebar`                    | `components/Sidebar.tsx`                            | Main sidebar: project tree, thread list, new-thread button, multi-select bulk actions (archive, delete), settings/agent-modes navigation                                                                                                                                                                                             |
| `Sidebar.logic.ts`           | `components/Sidebar.logic.ts` (20KB)                | Thread status derivation (pending-approval, awaiting-input, discussing, designing, planning, working, connecting, plan-ready, paused, completed, failed), thread sorting (created, updated, last-message, last-activity, status), project sorting (custom, created, alpha, activity), thread traversal, fallback thread after delete |
| `SidebarTree`                | `components/SidebarTree.tsx`                        | Tree view rendering for hierarchical thread display                                                                                                                                                                                                                                                                                  |
| `SidebarTree.logic.ts`       | `components/SidebarTree.logic.ts`                   | Tree node construction (parent/child thread grouping), expand/collapse state                                                                                                                                                                                                                                                         |
| `SidebarBrand`               | `components/sidebar/SidebarBrand.tsx`               | App logo/name in sidebar header                                                                                                                                                                                                                                                                                                      |
| `SidebarDesktopUpdateBanner` | `components/sidebar/SidebarDesktopUpdateBanner.tsx` | Desktop update notification banner                                                                                                                                                                                                                                                                                                   |
| `SidebarFooterNav`           | `components/sidebar/SidebarFooterNav.tsx`           | Footer navigation (settings, agent modes links)                                                                                                                                                                                                                                                                                      |
| `SidebarProjectItem`         | `components/sidebar/SidebarProjectItem.tsx`         | Individual project item in sidebar (collapsible, drag-reorderable)                                                                                                                                                                                                                                                                   |
| `SidebarProjectsSection`     | `components/sidebar/SidebarProjectsSection.tsx`     | Projects section container                                                                                                                                                                                                                                                                                                           |
| `SidebarThreadRow`           | `components/sidebar/SidebarThreadRow.tsx`           | Individual thread row (title, status pill, actions menu, multi-select, jump hints)                                                                                                                                                                                                                                                   |
| `SidebarThreadStatus`        | `components/sidebar/SidebarThreadStatus.tsx`        | Thread status pill (Working, Planning, Designing, Discussing, Connecting, Completed, Paused, Pending Approval, Awaiting Input, Plan Ready, Failed)                                                                                                                                                                                   |
| `SidebarUpdatePill`          | `components/sidebar/SidebarUpdatePill.tsx`          | Update notification pill                                                                                                                                                                                                                                                                                                             |
| `useSidebarData.ts`          | `components/sidebar/useSidebarData.ts`              | Hook combining projects, threads, git status, and tree state into renderable sidebar data                                                                                                                                                                                                                                            |
| `useSidebarInteractions.ts`  | `components/sidebar/useSidebarInteractions.ts`      | Hook for sidebar interaction handlers (click, drag, context menu)                                                                                                                                                                                                                                                                    |

### 3.6 Diff Components

| Component                    | File                                             | Description                                                                                                          |
| ---------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `DiffPanel`                  | `components/DiffPanel.tsx` (26KB)                | Full diff panel: turn-by-turn or full-thread diffs, agent vs workspace diff modes, file tree navigation, diff viewer |
| `DiffPanel.logic.ts`         | `components/DiffPanel.logic.ts`                  | Diff mode resolution logic                                                                                           |
| `DiffPanelBody`              | `components/DiffPanelBody.tsx`                   | Diff content body with file-level rendering                                                                          |
| `DiffPanelShell`             | `components/DiffPanelShell.tsx`                  | Shell/chrome for diff panel (header skeleton, loading state)                                                         |
| `DiffWorkerPoolProvider`     | `components/DiffWorkerPoolProvider.tsx`          | Web worker pool provider for diff computation                                                                        |
| `CollapsibleFileDiffList`    | `components/CollapsibleFileDiffList.tsx`         | Collapsible list of file diffs                                                                                       |
| `CompactDiffCard`            | `components/diff/CompactDiffCard.tsx`            | Compact inline diff card                                                                                             |
| `CompactDiffEntryRow`        | `components/diff/CompactDiffEntryRow.tsx`        | Individual entry row in compact diff                                                                                 |
| `CompactDiffHeader`          | `components/diff/CompactDiffHeader.tsx`          | Header for compact diff                                                                                              |
| `CompactDiffPreview`         | `components/diff/CompactDiffPreview.tsx`         | Compact diff preview with hunk rendering                                                                             |
| `CompactDiffSummaryFallback` | `components/diff/CompactDiffSummaryFallback.tsx` | Fallback when diff content unavailable                                                                               |

### 3.7 Design Preview

| Component            | File                                       | Description                                                                                                                                                      |
| -------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DesignPreviewPanel` | `components/DesignPreviewPanel.tsx` (15KB) | Design artifact preview panel for design-mode threads. Shows rendered design artifacts, pending design options/choices. Supports inline sidebar and sheet modes. |

### 3.8 Workflow Components

| Component                    | File                                          | Description                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowEditor`             | `components/WorkflowEditor.tsx` (22KB)        | Full workflow authoring UI: phases, prompts, gates, quality checks, sandbox modes, discussion assignment, model selection per phase                                                                                                                                                                              |
| `WorkflowEditor.logic.ts`    | `components/WorkflowEditor.logic.ts` (16KB)   | Workflow editor logic: phase creation, default prompts (implement, review, finalize, advocate, etc.), gate options (auto-continue, quality-checks, human-approval, done), on-fail options (retry, go-back-to, stop), execution kinds (agent, automated, human), quality check references (test, lint, typecheck) |
| `WorkflowEditor.parts.tsx`   | `components/WorkflowEditor.parts.tsx`         | Reusable sub-components for workflow editor (phase card fields, etc.)                                                                                                                                                                                                                                            |
| `WorkflowPicker.logic.ts`    | `components/WorkflowPicker.logic.ts`          | Workflow selection/picker logic                                                                                                                                                                                                                                                                                  |
| `WorkflowTimeline`           | `components/WorkflowTimeline.tsx` (17KB)      | Runtime workflow timeline showing phase progression, bootstrap events, quality checks, gate approvals                                                                                                                                                                                                            |
| `WorkflowTimeline.logic.ts`  | `components/WorkflowTimeline.logic.ts` (22KB) | Timeline rendering logic: phase status derivation, output rendering (schema, conversation, channel, none), quality check results, bootstrap state                                                                                                                                                                |
| `WorkflowTimeline.parts.tsx` | `components/WorkflowTimeline.parts.tsx`       | Timeline sub-components (phase cards, status indicators)                                                                                                                                                                                                                                                         |

### 3.9 Discussion Components

| Component                   | File                                     | Description                                                                                                                                                                                       |
| --------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DiscussionEditor`          | `components/DiscussionEditor.tsx` (47KB) | Multi-agent discussion authoring: participant roles, system prompts, model selection per participant, max turns, discussion scope (global/project), managed discussion list, create/update/delete |
| `DiscussionEditor.logic.ts` | `components/DiscussionEditor.logic.ts`   | Discussion validation, empty draft creation (default: advocate + critic), participant model resolution, managed discussion sorting                                                                |

### 3.10 Phase and Gate Components

| Component               | File                                    | Description                                                                                                    |
| ----------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `PhaseCard`             | `components/PhaseCard.tsx`              | Workflow phase card container                                                                                  |
| `PhaseCard.fields.tsx`  | `components/PhaseCard.fields.tsx`       | Phase card form fields (prompt, execution kind, model, etc.)                                                   |
| `PhaseCard.gate.tsx`    | `components/PhaseCard.gate.tsx`         | Gate configuration sub-card (after action, quality checks, on-fail behavior)                                   |
| `PhaseCard.parts.tsx`   | `components/PhaseCard.parts.tsx` (15KB) | Reusable phase card parts                                                                                      |
| `GateApproval`          | `components/GateApproval.tsx` (9KB)     | Gate approval UI: approve (A key), correct (C key), reject (R key) with correction text, quality check display |
| `GateApproval.logic.ts` | `components/GateApproval.logic.ts`      | Gate approval logic, keyboard shortcuts, summary derivation from structured output                             |
| `QualityCheckResults`   | `components/QualityCheckResults.tsx`    | Quality check results display (pass/fail with details)                                                         |
| `PlanSidebar`           | `components/PlanSidebar.tsx` (10KB)     | Sidebar showing active plan steps with status indicators (pending/in-progress/completed)                       |

### 3.11 Git Integration Components

| Component                     | File                                                | Description                                                                                                                                                                          |
| ----------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GitActionsControl`           | `components/GitActionsControl.tsx` (38KB)           | Git action dialog: commit, push, create PR. Supports stacked actions (commit+push, commit+push+PR). Custom commit messages, progress stages, default branch protection confirmation. |
| `GitActionsControl.logic.ts`  | `components/GitActionsControl.logic.ts` (9KB)       | Menu item building, quick action resolution, progress stage computation, default branch action dialog copy                                                                           |
| `BranchToolbar`               | `components/BranchToolbar.tsx` (6KB)                | Branch display toolbar showing current branch, worktree status                                                                                                                       |
| `BranchToolbar.logic.ts`      | `components/BranchToolbar.logic.ts`                 | Branch resolution, env mode derivation after branch change, worktree selection target                                                                                                |
| `BranchToolbarBranchSelector` | `components/BranchToolbarBranchSelector.tsx` (17KB) | Branch picker dropdown with local/remote branches, create branch, checkout PR                                                                                                        |
| `PullRequestThreadDialog`     | `components/PullRequestThreadDialog.tsx` (9KB)      | Dialog for creating a thread from a pull request                                                                                                                                     |

### 3.12 Terminal Integration

| Component              | File                                         | Description                                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ThreadTerminalDrawer` | `components/ThreadTerminalDrawer.tsx` (46KB) | Full terminal integration: resizable drawer, multiple terminals per thread, terminal groups, split/new terminal, close terminal, running subprocess indicators, xterm.js integration, terminal event streaming |

### 3.13 Settings Components

| Component              | File                                         | Description                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SettingsPanels`       | `components/settings/SettingsPanels.tsx`     | General settings: theme (system/light/dark), timestamp format (system/12h/24h), streaming toggle, default thread env mode, provider configuration (Codex/Claude binary paths, home paths, custom models, auth status), model selection, default model per provider, desktop update, confirm archive/delete toggles, diff word wrap, sidebar sort orders, project scripts control, keybindings path display |
| `SettingsSidebarNav`   | `components/settings/SettingsSidebarNav.tsx` | Settings sidebar navigation (General, Archive sections) with back button                                                                                                                                                                                                                                                                                                                                   |
| `ArchivedThreadsPanel` | `components/settings/SettingsPanels.tsx`     | Archived threads listing with unarchive/delete actions, relative timestamps                                                                                                                                                                                                                                                                                                                                |

### 3.14 Agent Modes

| Component        | File                            | Description                                                         |
| ---------------- | ------------------------------- | ------------------------------------------------------------------- |
| `AgentModesPage` | `components/AgentModesPage.tsx` | Agent modes page layout (workflows tab, discussions tab navigation) |

### 3.15 Miscellaneous Components

| Component                        | File                                          | Description                                                        |
| -------------------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| `Icons`                          | `components/Icons.tsx` (33KB)                 | SVG icon library (Codex, Claude, provider icons, tool icons, etc.) |
| `ProjectFavicon`                 | `components/ProjectFavicon.tsx`               | Project favicon display                                            |
| `ProjectScriptsControl`          | `components/ProjectScriptsControl.tsx` (16KB) | Project-level script management and execution                      |
| `ProjectScriptsControl.logic.ts` | `components/ProjectScriptsControl.logic.ts`   | Script control logic                                               |
| `KeybindingsToast`               | `components/KeybindingsToast.browser.tsx`     | Toast notifications for keybinding changes                         |

### 3.16 UI Primitives (`components/ui/`)

Full shadcn/radix-based design system:

- `alert-dialog.tsx`, `alert.tsx`, `autocomplete.tsx`, `badge.tsx`, `button.tsx`
- `card.tsx`, `checkbox.tsx`, `collapsible.tsx`, `combobox.tsx`, `command.tsx`
- `dialog.tsx`, `empty.tsx`, `field.tsx`, `fieldset.tsx`, `form.tsx`, `group.tsx`
- `input-group.tsx`, `input.tsx`, `kbd.tsx`, `label.tsx`, `menu.tsx`, `popover.tsx`
- `radio-group.tsx`, `scroll-area.tsx`, `select.tsx`, `separator.tsx`, `sheet.tsx`
- `sidebar.tsx` (resizable sidebar with rail, trigger, provider context)
- `skeleton.tsx`, `spinner.tsx`, `switch.tsx`, `textarea.tsx`
- `toast.tsx` (toast manager with anchored toasts), `toggle-group.tsx`, `toggle.tsx`, `tooltip.tsx`

---

## 4. State Management

All state management uses **Zustand**. Six distinct stores:

### 4.1 Main App Store (`store.ts`)

```
useStore: AppState
  - projects: Project[]
  - threads: Thread[]
  - sidebarThreadsById: Record<string, SidebarThreadSummary>
  - threadIdsByProjectId: Record<string, ThreadId[]>
  - threadWorkLogById: Record<string, WorkLogProjectionState>
  - bootstrapComplete: boolean
```

Actions: `syncServerReadModel`, `applyOrchestrationEvent`, `applyOrchestrationEvents`, `setError`, `setThreadBranch`

Selectors: `selectProjectById`, `selectThreadById`, `selectSidebarThreadSummaryById`, `selectThreadWorkLogById`, `selectThreadIdsByProjectId`, `selectThreadsByIds`

### 4.2 UI State Store (`uiStateStore.ts`)

```
useUiStateStore: UiState
  - projectExpandedById: Record<string, boolean>
  - projectOrder: ProjectId[]
  - lastActiveProjectId: ProjectId | null
  - threadLastVisitedAtById: Record<string, string>
```

Actions: `syncProjects`, `syncThreads`, `markThreadVisited`, `markThreadUnread`, `clearThreadUi`, `toggleProject`, `setProjectExpanded`, `reorderProjects`, `setLastActiveProject`

Persisted to `localStorage` under `forge:ui-state:v1` with debounced writes.

### 4.3 Composer Draft Store (`composerDraftStore.ts`)

```
useComposerDraftStore: ComposerDraftStoreState
  - draftThreadsByThreadId: Record<ThreadId, DraftThreadState>
  - draftThreadIdByProjectId: Record<ProjectId, ThreadId>
  - stickyModelSelectionByProvider: Record<ProviderKind, ModelSelection>
  - stickyActiveProvider: ProviderKind | null
  - stickyRuntimeMode: RuntimeMode
  - stickyInteractionMode: ProviderInteractionMode
```

Each DraftThreadState holds: `projectId`, `createdAt`, `runtimeMode`, `interactionMode`, `workflowId`, `discussionId`, `branch`, `worktreePath`, `envMode`, per-thread composer state (prompt text, image attachments, terminal contexts, model selection per provider).

Persisted to `localStorage` under `forge:composer-drafts:v1` with 300ms debounce. Supports migration from legacy storage keys.

### 4.4 Terminal State Store (`terminalStateStore.ts`)

```
useTerminalStateStore: TerminalStateStoreState
  - terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>
  - terminalEventEntriesByKey: Record<string, TerminalEventEntry[]>
  - nextTerminalEventId: number
```

Each `ThreadTerminalState` holds: `terminalOpen`, `terminalHeight`, `terminalIds`, `runningTerminalIds`, `activeTerminalId`, `terminalGroups`, `activeTerminalGroupId`.

Persisted to `localStorage` under `forge:terminal-state:v1`. Max 200 events per terminal buffer. Supports terminal groups with max 4 terminals per group.

### 4.5 Thread Selection Store (`threadSelectionStore.ts`)

```
useThreadSelectionStore: ThreadSelectionStore
  - selectedThreadIds: ReadonlySet<ThreadId>
  - anchorThreadId: ThreadId | null
```

Actions: `toggleThread` (Cmd/Ctrl+Click), `rangeSelectTo` (Shift+Click), `clearSelection`, `removeFromSelection`, `setAnchor`

### 4.6 Feature Stores (`stores/`)

**Workflow Store** (`stores/workflowStore.ts`):

- `availableWorkflows: WorkflowSummary[]`
- `workflowsById: Record<WorkflowId, WorkflowDefinition>`
- `runtimeByThreadId: Record<ThreadId, WorkflowThreadRuntimeState>` (phase events, quality checks, gate events, bootstrap events, phase outputs)
- `selectedWorkflowId`, editing state (draft, scope, projectId, dirty flag)
- Query integration via TanStack Query (`workflowQueryOptions`, `workflowListQueryOptions`)

**Channel Store** (`stores/channelStore.ts`):

- `channelsById: Record<ChannelId, Channel>`
- `messagesByChannelId: Record<ChannelId, ChannelMessage[]>`
- `messagePaginationByChannelId` (cursor-based pagination)
- `deliberationStateByChannelId` (turn count, participants)
- Channel message pagination, push event handling, intervention mutation

**Discussion Store** (`stores/discussionStore.ts`):

- `availableDiscussions: DiscussionSummary[]`
- `availableManagedDiscussions: DiscussionManagedSummary[]`
- `managedProjectFilter: ProjectId | "__all_projects__"`
- Query integration for list, detail, managed list, managed detail

---

## 5. Transport / Communication Layer

### 5.1 WebSocket Transport (`wsTransport.ts`)

Built on **Effect** runtime with `ManagedRuntime`:

- `request<T>()` -- single request/response
- `requestStream<T>()` -- streaming response consumed to completion
- `subscribe<T>()` -- persistent subscription with auto-retry (250ms default delay), returns unsubscribe function

### 5.2 RPC Protocol (`rpc/protocol.ts`)

- Uses `@forgetools/contracts` `WsRpcGroup` schema
- Creates Effect `RpcClient.layerProtocolSocket` with `retryTransientErrors: true`
- WebSocket URL resolved from current page location (`ws://` or `wss://`, pathname `/ws`)

### 5.3 WS RPC Client (`wsRpcClient.ts`)

Typed facade over `WsTransport` exposing:

- **thread**: `correct` (edit message)
- **terminal**: `open`, `write`, `resize`, `clear`, `restart`, `close`, `onEvent` (subscription)
- **projects**: `searchEntries`, `writeFile`
- **shell**: `openInEditor`
- **git**: `pull`, `status`, `getWorkingTreeDiff`, `runStackedAction` (streaming with progress), `listBranches`, `createWorktree`, `removeWorktree`, `createBranch`, `checkout`, `init`, `resolvePullRequest`, `preparePullRequestThread`
- **server**: `getConfig`, `refreshProviders`, `upsertKeybinding`, `getSettings`, `updateSettings`, `subscribeConfig`, `subscribeLifecycle`
- **orchestration**: `getSnapshot`, `dispatchCommand`, `getTurnDiff`, `getFullThreadDiff`, `getCommandOutput`, `getSubagentActivityFeed`, `getTurnAgentDiff`, `getFullThreadAgentDiff`, `replayEvents`, `onDomainEvent` (subscription with sequence tracking)
- **gate**: `approve`, `reject`
- **request**: `resolve`
- **channel**: `getMessages`, `getChannel`, `onEvent` (subscription)
- **phaseRun**: `list`, `get`
- **phaseOutput**: `get`
- **workflow**: `list`, `get`, `create`, `update`, `onEvent` (subscription)
- **discussion**: `list`, `get`, `listManaged`, `getManaged`, `create`, `update`, `delete`

### 5.4 Native API (`nativeApi.ts`, `wsNativeApi.ts`)

- `readNativeApi()` -- returns cached `NativeApi` instance
- `createWsNativeApi()` -- wraps `WsRpcClient` as a `NativeApi` interface
- Bridges Electron desktop APIs (`window.desktopBridge`) for: folder picker, confirm dialog, context menu, open in editor, open external link
- Falls back to browser implementations (DOM-based confirm dialog, `window.open`)

### 5.5 Server State (`rpc/serverState.ts`)

- Jotai-like atom registry (`rpc/atomRegistry.tsx`) for server-authoritative state
- `useServerConfig()`, `useServerProviders()`, `useServerKeybindings()`, `useServerSettings()`, `useServerObservability()`
- Subscription-based sync via `subscribeServerConfig` and `subscribeServerLifecycle`

---

## 6. Composer System

### 6.1 Slash Commands (`composer-logic.ts`)

Four slash commands: `/model`, `/plan`, `/default`, `/design`

- `/model [query]` -- triggers model picker inline
- `/plan` -- switches to plan interaction mode
- `/default` -- switches back to default interaction mode
- `/design` -- switches to design interaction mode

### 6.2 @-Mentions (`composer-editor-mentions.ts`)

- Pattern: `@filepath` (whitespace-delimited)
- Segments: `text`, `mention` (with path), `terminal-context` (with inline placeholder character)
- Cursor management: collapsed/expanded cursor translation for inline tokens

### 6.3 Trigger Detection

`detectComposerTrigger(text, cursor)` returns:

- `kind: "path"` -- @-mention trigger with query
- `kind: "slash-command"` -- partial command match
- `kind: "slash-model"` -- `/model` with optional query

### 6.4 Composer Draft Store

Per-thread drafts with:

- Prompt text with terminal context placeholders
- Image attachments (persisted as data URLs, restored as File objects)
- Terminal context drafts (thread, terminal, line range)
- Model selection per provider
- Runtime mode, interaction mode
- Sticky state (model selection, provider, runtime mode carried to new threads)
- Branch, worktree path, env mode (local/worktree)
- Workflow ID, discussion ID, discussion role models

### 6.5 Composer Editor (`ComposerPromptEditor.tsx`)

35KB rich text editor:

- Inline @-mention chips (rendered as non-editable spans)
- Terminal context inline chips
- Image paste/drop support
- Slash command autocomplete menu
- Model picker integration
- Resize support
- Keyboard navigation around inline tokens

---

## 7. Timeline / Message Rendering

### 7.1 Session Logic Pipeline (`session-logic/`)

**Timeline Entry Types**:

- `message` -- user/assistant/system chat messages
- `proposed-plan` -- proposed implementation plans
- `work` -- tool invocations, commands, file operations

**Work Log Entry** (`session-logic/types.ts`):
Rich entry type with 40+ fields including: `label`, `command`, `changedFiles`, `tone` (thinking/tool/info/error), `toolTitle`, `itemType`, `requestKind`, `inlineDiff`, `toolName`, `itemStatus`, `exitCode`, `durationMs`, `output`, `isBackgroundCommand`, `backgroundTaskId/Status`, `mcpServer/Tool`, `searchPattern/ResultCount`, `filePath`, `agentDescription/Type/Model/Prompt`, `childThreadAttribution`, `subagentGroupMeta`

**Tool Enrichment** (`session-logic/toolEnrichment.ts`):
Extracts tool name, exit code, duration, output, background status, MCP server/tool, search info, file path, agent metadata from raw orchestration activities.

**Subagent Grouping** (`session-logic/subagentGrouping.ts`):

- Identifies Codex collab control tools
- Synthesizes Claude task output lifecycle activities
- Groups parent entries with subagent child thread metadata
- Fallback entry display before lazy RPC feed loads

**Background Signals** (`session-logic/backgroundSignals.ts`):

- Background command detection and status tracking
- Streamed command output collection
- Background task retention (5 seconds after completion)
- Tray visibility logic

**Work Log Pipeline** (`session-logic/workLogPipeline.ts`):
Derives work log entries with scoping (latest-turn vs all-turns).

**Projector** (`session-logic/projector.ts`):
Incremental projection state that tracks: active lifecycle entries, command launch entries, background completion entries, streamed output, provider background tasks, Codex candidate commands, child thread metadata. Supports bootstrap and incremental activity/message application.

### 7.2 Timeline Rendering

**`MessagesTimeline.tsx`**: Renders rows as:

- **work-group** -- collapsed group of work log entries (max 6 visible)
- **work-entry** -- individual tool/command activity
- **message** -- chat message with markdown rendering, completion dividers, inline diff summaries
- **proposed-plan** -- plan card with implement/dismiss actions
- **working** -- active work indicator with participant labels

Supports virtualization (`MessagesTimeline.virtualization.browser.tsx`) and monitoring (`MessagesTimeline.monitor.browser.tsx`).

### 7.3 Timeline Height Estimation (`timelineHeight.ts`)

Pre-computes row heights for virtualized scrolling.

---

## 8. Workflow and Discussion UI

### 8.1 Workflow Editor

Full CRUD for workflow definitions:

- **Phases**: ordered list of phases, each with:
  - Prompt (text or reference to predefined: implement, review, finalize, etc.)
  - Execution kind (agent, automated, human)
  - Model selection
  - Sandbox mode
  - Discussion assignment
  - Gate configuration:
    - After: auto-continue, quality-checks, human-approval, done
    - Quality checks: test, lint, typecheck (or custom)
    - On fail: retry, go-back-to (specific phase), stop
- **Scope**: global or project-scoped workflows
- **Built-in workflows**: read-only display

### 8.2 Workflow Runtime Timeline

Renders live workflow execution:

- **Bootstrap events**: started, data, error
- **Phase events**: started, completed, failed with outputs
- **Quality check events**: per-check pass/fail with details
- **Gate events**: pending, approved, rejected with corrections
- Phase output rendering: schema (structured JSON), conversation transcript, channel transcript, none

### 8.3 Discussion Editor

Full CRUD for multi-agent discussions:

- **Participants**: role, description, system prompt, model selection per participant
- **Settings**: max turns
- **Scope**: global or project-scoped
- **Managed discussions**: list/detail views with project filter
- Default participants: advocate + critic

### 8.4 Discussion Runtime

- Channel-based messaging system (`channelStore.ts`)
- Participant tracking (type: human/system/agent, role, ID)
- Turn counting
- Human intervention via `channel.post-message` dispatch command
- Discussion role picker (`DiscussionRolesPicker.tsx`)

---

## 9. Diff and Design Preview

### 9.1 Diff Panel (`DiffPanel.tsx`)

Two modes:

- **Agent diff** -- diffs from agent turns (`getTurnAgentDiff`, `getFullThreadAgentDiff`)
- **Workspace diff** -- working tree diffs (`getWorkingTreeDiff`)

Features:

- Turn-by-turn navigation with diff stat labels
- Full thread cumulative diff
- File tree with change indicators
- Side-by-side and unified diff views (via `@pierre/diffs`)
- Diff themes (light/dark)
- Word wrap toggle
- Web worker pool for diff computation (`DiffWorkerPoolProvider`)

### 9.2 Compact Diff Components

Inline diff previews in the timeline:

- `CompactDiffCard` -- card with collapsed/expanded diff
- `CompactDiffPreview` -- parsed hunk rendering with context/addition/deletion segments
- `CompactDiffEntryRow` -- individual file entry in compact diff
- `CompactDiffHeader` -- diff header with stats
- `CompactDiffSummaryFallback` -- when patch unavailable, shows file list

### 9.3 Layout Modes

- **Sidebar mode** -- resizable inline sidebar (min 26rem, default 48vw, stored width)
- **Sheet mode** -- slide-over sheet on narrow viewports (< 1180px)
- Composer resize guard prevents diff sidebar from overflowing composer width

### 9.4 Design Preview (`DesignPreviewPanel.tsx`)

For threads in `design` interaction mode:

- Renders design artifacts (HTML/image preview via artifact path)
- Shows pending design options/choices
- Auto-opens when first artifacts arrive
- Same sidebar/sheet layout modes as diff panel

---

## 10. Settings and Configuration

### 10.1 Server-Authoritative Settings

Stored in `settings.json` on server, synced via RPC:

- `enableAssistantStreaming` -- toggle streaming responses
- `defaultThreadEnvMode` -- local or worktree
- `textGenerationModelSelection` -- default model
- `providers.codex.binaryPath`, `providers.codex.homePath`, `providers.codex.customModels`
- `providers.claudeAgent.binaryPath`, `providers.claudeAgent.customModels`

### 10.2 Client-Only Settings

Stored in `localStorage` under `forge:client-settings:v1`:

- `confirmThreadArchive` -- confirmation dialog toggle
- `confirmThreadDelete` -- confirmation dialog toggle
- `diffWordWrap` -- word wrap in diff viewer
- `sidebarProjectSortOrder` -- custom, created, alpha, activity
- `sidebarThreadSortOrder` -- created, updated, last-message, last-activity, status
- `timestampFormat` -- locale, 12-hour, 24-hour

### 10.3 General Settings Panel

- Theme selector (system/light/dark)
- Timestamp format
- Assistant streaming toggle
- Default thread environment mode
- Provider configuration with status indicators (ready, disabled, error, warning)
- Provider binary path, home path, custom model management
- Default model picker per provider
- Desktop update controls
- Keybindings config path display
- Settings file path display
- App version display

### 10.4 Archived Threads Panel

- List of archived threads with project favicon, relative timestamps
- Unarchive and delete actions
- Empty state when no archived threads

---

## 11. Terminal Integration

### 11.1 Terminal State

Per-thread terminal state tracked in `terminalStateStore`:

- Open/closed, height (resizable, default 280px)
- Multiple terminals per thread (default "default" terminal)
- Terminal groups with max 4 terminals per group
- Active terminal/group tracking
- Running subprocess detection per terminal

### 11.2 Terminal Drawer (`ThreadTerminalDrawer.tsx`, 46KB)

Features:

- Resizable drawer at bottom of chat view
- Multi-terminal tabs with add (split/new) and close
- Terminal group management
- xterm.js integration with:
  - Bi-directional data streaming (write via RPC, events via subscription)
  - Terminal resize events
  - Clear (Ctrl+L / Cmd+K)
  - Restart terminal
  - Terminal link detection (`terminal-links.ts`)
  - Navigation shortcuts (word forward/backward, line start/end)
  - Running subprocess indicator
- Terminal event buffering (max 200 events per terminal)
- Terminal state persistence across page reloads

### 11.3 Terminal Context

- Terminal output can be attached to composer messages as context
- `TerminalContextDraft`: thread ID, terminal ID, terminal label, line start/end range
- Inline terminal context chips in composer editor
- Terminal context extraction from user messages

---

## 12. Git Integration UI

### 12.1 Branch Toolbar

- Current branch display
- Worktree path indicator
- Branch selector dropdown with:
  - Local and remote branches
  - Worktree-linked branches
  - Create new branch
  - Checkout from PR number

### 12.2 Git Actions

Stacked action system supporting combined operations:

- **Commit** -- auto-generated or custom commit message, feature branch creation
- **Push** -- push to remote with target display
- **Create PR** -- generates PR content, creates GitHub PR
- **Combined**: commit+push, commit+push+PR

Progress stages shown during execution. Default branch protection with confirmation dialog.

### 12.3 Pull Request Integration

- `PullRequestThreadDialog` -- create thread from PR
- `resolvePullRequest` / `preparePullRequestThread` RPC calls
- PR status in branch selector

### 12.4 Worktree Management

- Create/remove worktrees via RPC
- Orphaned worktree detection on thread deletion
- Worktree cleanup with user confirmation
- Env mode toggle: local (shared CWD) vs worktree (isolated)

---

## 13. Keyboard Shortcuts and Navigation

### 13.1 Keybinding System (`keybindings.ts`)

Full keybinding system with:

- Server-configurable keybindings via `ResolvedKeybindingsConfig`
- Context-aware matching (`terminalFocus`, `terminalOpen` contexts)
- `when` clause evaluation (identifier, not, and, or AST nodes)
- Platform-aware modifier resolution (Cmd on Mac, Ctrl on Windows/Linux)
- Conflict detection and resolution (last-wins)

### 13.2 Registered Commands

| Command                                 | Description                                              |
| --------------------------------------- | -------------------------------------------------------- |
| `chat.new`                              | New thread (inherits branch/worktree from active thread) |
| `chat.newLocal`                         | New local thread                                         |
| `terminal.toggle`                       | Toggle terminal drawer                                   |
| `terminal.split`                        | Split terminal in current group                          |
| `terminal.new`                          | New terminal in new group                                |
| `terminal.close`                        | Close active terminal                                    |
| `diff.toggle`                           | Toggle diff panel                                        |
| `editor.openFavorite`                   | Open in preferred editor                                 |
| `thread.previous`                       | Navigate to previous thread                              |
| `thread.next`                           | Navigate to next thread                                  |
| `thread.jump.0` through `thread.jump.9` | Jump to thread by index (with visual hint overlay)       |

### 13.3 Gate Approval Shortcuts

- `A` -- approve gate
- `C` -- correct gate (sends correction then rejects)
- `R` -- reject gate (requires reason)

### 13.4 Terminal Navigation Shortcuts

- Alt+Left/Right (Mac) or Ctrl+Left/Right -- word navigation
- Cmd+Left/Right (Mac) -- line start/end
- Ctrl+L or Cmd+K -- clear terminal

### 13.5 Settings / Global

- `Escape` -- clear thread selection, exit settings
- Sidebar thread multi-select: Cmd/Ctrl+Click (toggle), Shift+Click (range)
- Thread jump hints shown when modifier keys held

---

## 14. Hooks

| Hook                   | File                            | Description                                                                                                |
| ---------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `useAppearance`        | `hooks/useAppearance.ts`        | Appearance/theme management                                                                                |
| `useCopyToClipboard`   | `hooks/useCopyToClipboard.ts`   | Clipboard copy with feedback                                                                               |
| `useHandleNewThread`   | `hooks/useHandleNewThread.ts`   | New thread creation with project resolution, draft reuse, navigation                                       |
| `useLocalStorage`      | `hooks/useLocalStorage.ts`      | Typed localStorage hook with schema validation                                                             |
| `useMediaQuery`        | `hooks/useMediaQuery.ts`        | CSS media query matching                                                                                   |
| `useSettings`          | `hooks/useSettings.ts`          | Unified settings (server + client merged) with selector support                                            |
| `useTheme`             | `hooks/useTheme.ts`             | Theme toggle (system/light/dark)                                                                           |
| `useThreadActions`     | `hooks/useThreadActions.ts`     | Thread lifecycle: archive, unarchive, pin, unpin, delete (with worktree cleanup), fork, confirm-and-delete |
| `useTurnDiffSummaries` | `hooks/useTurnDiffSummaries.ts` | Turn diff summary derivation                                                                               |

---

## 15. Lib Utilities

| Module                     | File                              | Description                                                                                |
| -------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| `appearance`               | `lib/appearance.ts`               | Theme detection and application                                                            |
| `clipboard`                | `lib/clipboard.ts`                | Clipboard API wrapper                                                                      |
| `contextWindow`            | `lib/contextWindow.ts`            | Context window size calculation                                                            |
| `desktopUpdateReactQuery`  | `lib/desktopUpdateReactQuery.ts`  | Desktop update state via TanStack Query                                                    |
| `diffRendering`            | `lib/diffRendering.ts`            | Diff theme names, complexity classification, compact preview models                        |
| `gitReactQuery`            | `lib/gitReactQuery.ts`            | Git operations as TanStack Query options                                                   |
| `keyboardTargets`          | `lib/keyboardTargets.ts`          | Editable element detection for keyboard shortcut filtering                                 |
| `lruCache`                 | `lib/lruCache.ts`                 | LRU cache implementation                                                                   |
| `projectReactQuery`        | `lib/projectReactQuery.ts`        | Project query keys                                                                         |
| `projectScriptKeybindings` | `lib/projectScriptKeybindings.ts` | Project script keyboard shortcut management                                                |
| `providerReactQuery`       | `lib/providerReactQuery.ts`       | Provider query keys and options                                                            |
| `rateLimits`               | `lib/rateLimits.ts`               | Rate limit calculation and display                                                         |
| `roleColors`               | `lib/roleColors.ts`               | Discussion role color assignment                                                           |
| `storage`                  | `lib/storage.ts`                  | Storage utilities: key migration, debounced storage, memory storage                        |
| `terminalContext`          | `lib/terminalContext.ts`          | Terminal context placeholder management                                                    |
| `terminalFocus`            | `lib/terminalFocus.ts`            | Terminal focus detection                                                                   |
| `terminalStateCleanup`     | `lib/terminalStateCleanup.ts`     | Orphaned terminal state cleanup                                                            |
| `turnDiffTree`             | `lib/turnDiffTree.ts`             | Turn diff file tree construction                                                           |
| `utils`                    | `lib/utils.ts`                    | General utilities: UUID generation, cn() class merging, URL resolution, platform detection |

---

## 16. Orchestration Event Types (Complete Inventory)

The frontend handles the following event types in `storeEventHandlers.ts`:

**Project Events**:

- `project.created` -- new project registered
- `project.meta-updated` -- title, workspace root, default model, scripts changed
- `project.deleted` -- project removed

**Thread Lifecycle Events**:

- `thread.created` -- new thread (with parent, phase run, workflow, discussion, role, child threads, spawn mode/branch/worktree)
- `thread.deleted` -- thread removed
- `thread.archived` / `thread.unarchived` -- archive toggle
- `thread.pinned` / `thread.unpinned` -- pin toggle
- `thread.meta-updated` -- title, model selection, branch, worktree path
- `thread.runtime-mode-set` -- runtime mode change (full-access, etc.)
- `thread.interaction-mode-set` -- interaction mode change (default, plan, design)
- `thread.forked` -- thread forked from source (copies messages)
- `thread.bootstrap-started/completed/failed/skipped` -- bootstrap lifecycle (no-op in frontend)

**Session Events**:

- `thread.status-changed` -- session status update
- `thread.completed` -- session finished successfully
- `thread.failed` -- session error with error message
- `thread.cancelled` -- session cancelled by user
- `thread.session-set` -- full session state replacement
- `thread.session-stop-requested` -- stop request acknowledged

**Message Events**:

- `thread.message-sent` -- user/assistant/system message (supports streaming with text append, attachments, attribution)

**Turn Events**:

- `thread.turn-start-requested` -- turn requested with model/runtime/interaction mode
- `thread.turn-interrupt-requested` -- turn interruption
- `thread.turn-started` -- turn execution began
- `thread.turn-completed` -- turn finished
- `thread.turn-restarted` -- turn reverted/interrupted

**Diff Events**:

- `thread.turn-diff-completed` -- workspace diff checkpoint for a turn
- `thread.agent-diff-upserted` -- agent-specific diff summary
- `thread.proposed-plan-upserted` -- proposed implementation plan

**Activity Events**:

- `thread.activity-appended` -- tool/command activity (feeds work log projector)

**Design Events**:

- `request.opened` (type: design-option) -- design option request
- `request.resolved` -- design request resolved
- `request.stale` -- design request expired
- `thread.design.artifact-rendered` -- new design artifact
- `thread.design.options-presented` -- design option choices presented
- `thread.design.option-chosen` -- user chose a design option

**Revert Events**:

- `thread.reverted` -- thread reverted to earlier turn (trims messages, diffs, activities, plans)

**No-op Events**:

- `thread.interactive-request-response-requested` -- acknowledged but no state change

---

## 17. ChatView Feature Surfaces (from ChatView.tsx, 196KB)

The ChatView component is the largest single file and contains features not present in sub-components:

**Message Send Flow**:

- Prompt text with @-mentions expanded to file paths
- Terminal context attachment (appended to prompt or inline)
- Image attachments (up to `PROVIDER_SEND_TURN_MAX_ATTACHMENTS`, max `PROVIDER_SEND_TURN_MAX_IMAGE_BYTES` per image)
- Image-only bootstrap prompt when user sends only images
- Model selection per-provider with sticky state
- Runtime mode (full-access) and interaction mode (default, plan, design)
- Claude effort level prefix injection for supported models
- Slash command handling: `/plan`, `/design`, `/default` switch interaction mode; `/model` opens model picker
- Worktree preparation before first turn (creates worktree if env mode is "worktree")
- Local dispatch snapshot for optimistic UI updates
- Wait for server thread acknowledgment before navigating

**Interactive Requests**:

- Approval requests (command, file-read, file-change) with approve/reject/always-allow
- Permission requests (tool permission grants)
- User input requests (multi-question forms with pre-filled answers)
- MCP elicitation requests (MCP tool parameter collection)

**Plan Follow-Up**:

- Proposed plan cards with implement/dismiss
- Plan implementation: creates new thread, dispatches plan as source
- Plan follow-up banner for continued iteration

**Worktree Management (inline)**:

- Create worktree mutation
- Remove worktree mutation
- Branch checkout
- PR-based thread creation

**Terminal Management**:

- Mounted terminal threads reconciliation (max 10 hidden)
- Terminal open/close/split/new from within chat
- Script execution in terminal

**Project Scripts**:

- Script invocation from chat
- Last-invoked script tracking per project
- Script keybinding decoding

**Summarization**:

- Conversation summarization trigger

**Composer State**:

- @-mention autocomplete with file search (debounced 120ms)
- Cursor management for inline tokens
- Compact/full composer footer layout switching
- Provider traits picker integration
- Context window meter
- Rate limits meter

---

## 18. Orchestration Recovery

Three-tier recovery system (`orchestrationRecovery.ts`):

1. **Bootstrap** -- initial snapshot load from server
2. **Replay** -- catch up from a sequence gap using `replayEvents(fromSequenceExclusive)`
3. **Snapshot fallback** -- full snapshot reload when replay fails

State machine tracks: `latestSequence`, `nextExpectedSequence`, `highestObservedSequence`, `bootstrapped`, `pendingReplay`, `inFlight` (snapshot or replay phase).

Domain event classifier: returns `"apply"` (process normally) or `"recover"` (trigger gap recovery).

Live event batches are coalesced (consecutive `thread.message-sent` for same message ID merged) and applied through `safelyApplyOrchestrationEventBatch` which catches errors and falls back to snapshot recovery.

---

## 19. Technology Stack Summary

- **Framework**: React 18+ with `useEffectEvent`
- **Router**: TanStack Router (file-based routing)
- **State**: Zustand (6 stores) with localStorage persistence
- **Server cache**: TanStack Query
- **Transport**: Effect runtime over WebSocket (`effect/unstable/rpc`)
- **UI primitives**: shadcn/ui + Radix primitives
- **Styling**: Tailwind CSS
- **Diff rendering**: `@pierre/diffs` library
- **Terminal**: xterm.js (lazy-loaded)
- **Build**: Vite
- **Testing**: Vitest (unit + browser tests)
- **Desktop**: Electron (optional, detected via `isElectron`)
