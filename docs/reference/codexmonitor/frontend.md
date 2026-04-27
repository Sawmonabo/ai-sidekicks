# CodexMonitor Frontend -- Exhaustive Feature and Implementation Inventory

Source: `/home/sabossedgh/dev/external/CodexMonitor/src/`
Explored: 2026-04-14

---

## 1. Directory Structure

```
src/
  App.tsx                         # Root component (window label routing)
  main.tsx                        # ReactDOM entry, Sentry init, mobile viewport helpers
  types.ts                        # All shared TypeScript type definitions (~712 lines)
  vite-env.d.ts                   # Vite environment type shims
  lucide-icons.d.ts               # Lucide icon type declarations

  assets/
    app-icons/                    # PNG icons: finder, vscode, zed, antigravity, cursor, ghostty
    error-notification.mp3
    success-notification.mp3

  hooks/
    useDebouncedValue.ts          # Generic debounce hook

  services/
    tauri.ts                      # All Tauri invoke wrappers (~950 lines)
    events.ts                     # Tauri event subscription hub (createEventHub pattern)
    dragDrop.ts                   # Window drag-and-drop subscription
    toasts.ts                     # Error toast pub/sub bus

  styles/                         # All CSS files (30+ stylesheets)
    base.css, ds-tokens.css, ds-modal.css, ds-toast.css, ds-panel.css,
    ds-diff.css, ds-popover.css, ds-tooltip.css, buttons.css, sidebar.css,
    home.css, workspace-home.css, main.css, messages.css, approval-toasts.css,
    error-toasts.css, request-user-input.css, update-toasts.css, composer.css,
    review-inline.css, diff.css, diff-viewer.css, file-tree.css, panel-tabs.css,
    prompts.css, debug.css, terminal.css, plan.css, about.css, tabbar.css,
    worktree-modal.css, clone-modal.css, workspace-from-url-modal.css,
    mobile-remote-workspace-modal.css, branch-switcher-modal.css,
    git-init-modal.css, settings.css, compact-base.css, compact-phone.css,
    compact-tablet.css

  test/
    vitest.setup.ts

  utils/                          # 30+ utility modules
    approvalRules.ts              # Approval command parsing
    appServerEvents.ts            # App server event parsing
    caretPosition.ts              # Caret/cursor position calculations
    chatScrollback.ts             # Chat scrollback limit constants
    codexArgsInput.ts             # Codex args normalization
    commitMessage.ts              # Commit message generation helpers
    commitMessagePrompt.ts        # Commit message prompt template
    composerText.ts               # Composer text utilities (fence triggers, paste normalization)
    customPrompts.ts              # Custom prompt expansion logic
    debugEntries.ts               # Debug entry formatting
    dictation.ts                  # Dictation transcript insertion helpers
    diff.ts                       # Diff parsing utilities
    diffsWorker.ts                # Web worker for diff computation
    fileLinks.ts                  # File link parsing (path:line:col)
    fileTypeIcons.ts              # File type to icon URL mapping
    fonts.ts                      # Font family utilities
    formatting.ts                 # General formatting helpers
    internalPlanReadyMessages.ts  # Plan-ready message detection
    keys.ts                       # Keyboard event helpers (isComposingEvent)
    notificationSounds.ts         # Sound notification playback
    platformPaths.ts              # Platform detection, path joining, isMac/Mobile
    pullRequestPrompt.ts          # PR review prompt template
    pullRequestReviewPrompt.ts    # PR review prompt builder
    remarkFileLinks.ts            # Remark plugin for file links in markdown
    shortcuts.ts                  # Keyboard shortcut parsing and matching
    syntax.ts                     # Language detection from file paths
    threadItems.ts                # Thread item normalization (main barrel)
    threadItems.collab.ts         # Collaboration/subagent thread item processing
    threadItems.conversion.ts     # Raw server items to ConversationItem conversion
    threadItems.explore.ts        # Explore item merging
    threadItems.listOps.ts        # Thread item list operations (append, replace)
    threadItems.shared.ts         # Shared thread item helpers
    threadStatus.ts               # Thread status classification
    threadText.ts                 # Thread text extraction
    time.ts                       # Relative time formatting
    uiScale.ts                    # UI scale CSS variable management

  features/
    about/
      components/AboutView.tsx    # About window view

    app/                          # Core application orchestration
      bootstrap/
        useAppBootstrap.ts
        useAppBootstrapOrchestration.ts
      orchestration/
        useThreadOrchestration.ts
        useThreadCodexOrchestration.ts
        useWorkspaceOrchestration.ts
        useLayoutOrchestration.ts
      hooks/                      # ~60 hooks
      components/                 # ~30 components
      utils/                      # launchScriptIcons, openAppIcons, openApp, usageLabels
      constants.ts

    apps/
      hooks/useApps.ts
      utils/appMentions.ts        # $mention resolution for connected apps

    collaboration/
      hooks/
        useCollaborationModes.ts
        useCollaborationModeSelection.ts

    composer/
      hooks/                      # 14 hooks
      components/                 # 10 components

    debug/
      hooks/useDebugLog.ts
      components/DebugPanel.tsx

    design-system/
      diff/diffViewerTheme.ts
      components/
        classNames.ts
        modal/ModalShell.tsx
        panel/PanelPrimitives.tsx
        popover/PopoverPrimitives.tsx
        settings/SettingsPrimitives.tsx
        toast/ToastPrimitives.tsx

    dictation/
      hooks/useDictationModel.ts, useHoldToDictate.ts, useDictation.ts
      components/DictationWaveform.tsx

    files/
      components/FileTreePanel.tsx, FilePreviewPopover.tsx

    git/
      types.ts                    # GitPanelMode type
      hooks/                      # 20 hooks
      utils/                      # 8 utility modules
      components/                 # 20 components

    home/
      homeTypes.ts
      homeFormatters.ts
      homeUsageViewModel.ts
      hooks/useLocalUsage.ts
      components/Home.tsx, HomeActions.tsx, HomeLatestAgentsSection.tsx, HomeUsageSection.tsx

    layout/
      hooks/                      # 12 hooks + layoutNodes/ sub-directory
      components/                 # 8 components

    messages/
      hooks/useFileLinkOpener.ts
      utils/                      # 5 utility modules
      components/                 # 5 components

    mobile/
      hooks/useMobileServerSetup.ts
      components/MobileServerSetupWizard.tsx

    models/
      hooks/useModels.ts
      utils/modelListResponse.ts

    notifications/
      hooks/                      # 4 hooks
      components/ErrorToasts.tsx

    plan/
      components/PlanPanel.tsx

    prompts/
      hooks/useCustomPrompts.ts
      components/PromptPanel.tsx

    settings/
      hooks/                      # 16 hooks
      components/
        SettingsView.tsx, SettingsNav.tsx
        settingsTypes.ts, settingsViewConstants.ts, settingsViewHelpers.ts
        sections/                 # 13 section components

    shared/
      hooks/useFileEditor.ts
      components/MagicSparkleIcon.tsx, FileEditorCard.tsx

    skills/
      hooks/useSkills.ts

    terminal/
      hooks/useTerminalController.ts, useTerminalSession.ts, useTerminalTabs.ts
      components/TerminalDock.tsx, TerminalPanel.tsx

    threads/
      hooks/                      # 30+ hooks + threadReducer/ sub-directory
      utils/                      # 12 utility modules
      components/                 # (thread list components live under app/components)

    update/
      hooks/useUpdater.ts
      utils/                      # update utilities
      components/UpdateToast.tsx

    workspaces/
      domain/workspaceGroups.ts
      hooks/                      # 16 hooks
      components/                 # 10 components
```

---

## 2. App Shell and Routing

### Entry Point (`main.tsx`)

- Initializes **Sentry** error tracking with `@sentry/react`.
- Tracks `app_open` metric on launch.
- Disables mobile zoom gestures (pinch, gesture events).
- Syncs mobile viewport height via `--app-height` CSS variable; tracks `visualViewport` resize/scroll.
- Sets `data-mobileComposerFocus` attribute when a composer textarea is focused on mobile.
- Renders `<App />` inside `React.StrictMode`.

### Root Component (`App.tsx`)

- Uses `useWindowLabel()` to distinguish window types.
- If window label is `"about"`, renders lazy-loaded `AboutView`.
- Otherwise renders `MainApp`.

### MainApp (`features/app/components/MainApp.tsx`)

- Central orchestrator (~900 lines). Instantiates and wires together all major hooks.
- Key hooks consumed: `useAppBootstrapOrchestration`, `useWorkspaceController`, `useMobileServerSetup`, `useLayoutController`, `useModels`, `useCollaborationModes`, `useSkills`, `useApps`, `useCustomPrompts`, `useThreads`, `useQueuedSend`, `useTerminalController`, `usePullRequestComposer`, `useUpdaterController`, `useErrorToasts`, `useComposerShortcuts`, `useComposerMenuActions`, `useComposerEditorState`, `useThreadRows`, `usePlanReadyActions`, and many more.
- Renders `MainAppShell` which composes: drag strip, titlebar expand controls, window caption controls, lazy `GitHubPanelData`, `AppLayout`, `AppModals`, and optionally `MobileServerSetupWizard`.

### AppLayout (`features/app/components/AppLayout.tsx`)

- Dispatches to three responsive layouts: `DesktopLayout`, `TabletLayout`, `PhoneLayout`.
- Props include: sidebar node, messages node, composer node, approval toasts, update toast, error toasts, home node, header nodes, git diff panels, plan panel, debug panel, terminal dock.
- Supports `centerMode: "chat" | "diff"` with optional split view (`splitChatDiffView`).

### Responsive Layouts

- **DesktopLayout**: Three-column layout (sidebar | center | right panel) with resizable dividers. Center has layered chat/diff panes. Bottom docks for terminal, debug, and plan panels.
- **TabletLayout**: Two-section layout with swipeable tab navigation.
- **PhoneLayout**: Single-column stacked layout with bottom tab bar.

---

## 3. Composer System

### Architecture

- **Composer** (`features/composer/components/Composer.tsx`): Main composer wrapper. Manages text state, autocomplete, prompt history, draft effects, key handling.
- **ComposerInput** (`ComposerInput.tsx`): Textarea with action buttons (send/stop, mic, expand, image attach). Supports drag-and-drop image attachment.
- **ComposerMetaBar** (`ComposerMetaBar.tsx`): Bottom bar displaying model selector, access mode, reasoning effort, collaboration mode, service tier, codex args override, context usage (token counts).
- **ComposerQueue** (`ComposerQueue.tsx`): Displays queued follow-up messages with edit/delete actions.
- **ComposerSuggestionsPopover** (`ComposerSuggestionsPopover.tsx`): Autocomplete dropdown and review prompt UI.
- **ComposerAttachments** (`ComposerAttachments.tsx`): Image attachment thumbnails with remove buttons.
- **ComposerMobileActionsMenu** (`ComposerMobileActionsMenu.tsx`): Mobile-specific actions (attach, dictation, expand).
- **ReviewInlinePrompt** (`ReviewInlinePrompt.tsx`): Review target selection UI.

### Hooks

- `useComposerAutocompleteState`: Manages autocomplete trigger detection and item matching. Triggers: `@` (files), `/` (skills, prompts, slash commands), `$` (apps).
- `useComposerAutocomplete`: Core autocomplete logic -- file matching, skill matching, prompt matching, app matching.
- `useComposerKeyDown`: Handles Enter (send), Shift+Enter (newline or list continuation), Shift+Cmd+Enter (opposite follow-up intent), arrow keys (autocomplete navigation), backtick expansion, Tab (accept suggestion).
- `useComposerShortcuts`: Keyboard shortcuts for cycling model, access mode, reasoning effort, collaboration mode.
- `useComposerMenuActions`: Responds to menu-level cycle events for model/access/reasoning/collaboration.
- `useComposerEditorState`: Derives `ComposerEditorSettings` from app settings preset.
- `useComposerDraftEffects`: Syncs draft text, prefill drafts, insert text, and dictation transcripts into the composer.
- `useComposerSuggestionStyle`: Calculates popover position based on caret location.
- `useComposerImageDrop`: Handles drag-and-drop and clipboard paste for image attachments.
- `useComposerImages`: Manages attached image list with pick/attach/remove operations.
- `useComposerInputLayout`: Detects phone layout and tall input state.
- `useComposerMobileActions`: Manages mobile actions menu open/close state.
- `useComposerDictationControls`: Dictation button state and click handlers.
- `usePromptHistory`: Arrow-key prompt history navigation (up/down through previously sent prompts).

### Sending Modes

- **Default send**: Enter key. Sends message to active thread.
- **Queue**: When agent is processing, messages are queued for sequential delivery.
- **Steer**: When agent is processing and steer is enabled, sends a steer command to redirect the active turn.
- **Follow-up behavior**: Configurable default (queue vs steer). Shift+Cmd+Enter sends with the opposite intent.

### Slash Commands

Parsed in `useQueuedSend`: `/fork`, `/review`, `/compact`, `/new`, `/resume`, `/fast`, `/mcp`, `/apps`, `/status`.

### Autocomplete Triggers

- `@` -- File mention autocomplete from workspace file listing.
- `/` -- Skill names, custom prompts (prefixed `prompts:`), slash commands.
- `$` -- App mentions (connected apps/connectors).

### Editor Features (Composer Presets)

Three presets: Default, Helpful, Smart. Each controls:

- `expandFenceOnSpace` / `expandFenceOnEnter` -- Auto-expand triple backtick triggers.
- `fenceLanguageTags` -- Recognize language tags after backticks.
- `fenceWrapSelection` -- Wrap selected text in fence block.
- `autoWrapPasteMultiline` -- Auto-wrap multi-line pastes in code blocks.
- `autoWrapPasteCodeLike` -- Auto-wrap code-like single-line pastes.
- `continueListOnShiftEnter` -- Continue markdown lists on Shift+Enter.

---

## 4. Thread Management

### State Management (`useThreadsReducer.ts`)

- Uses `useReducer` with a complex thread reducer. State shape includes:
  - `threadsByWorkspace`: Record<workspaceId, ThreadSummary[]>
  - `activeThreadIdByWorkspace`: Record<workspaceId, threadId>
  - `itemsByThread`: Record<threadId, ConversationItem[]>
  - `threadStatusById`: Record<threadId, { isProcessing, isReviewing, hasUnread }>
  - `activeTurnIdByThread`, `turnDiffByThread`, `tokenUsageByThread`
  - `planByThread`: Record<threadId, TurnPlan>
  - `rateLimitsByWorkspace`, `accountByWorkspace`
  - `approvals`, `userInputRequests`
  - `hiddenThreadIdsByWorkspace`, `threadResumeLoadingById`
  - `threadListLoadingByWorkspace`, `threadListPagingByWorkspace`
  - `threadParentById` (parent-child thread relationships)
  - `lastAgentMessageByThread`

### Thread Reducer Slices

- `threadItemsSlice`: Add/replace/append conversation items.
- `threadSnapshotSlice`: Thread list management (add, remove, rename, archive, unarchive).
- `threadLifecycleSlice`: Processing status, turn tracking, unread state.
- `threadConfigSlice`: Thread configuration metadata.
- `threadQueueSlice`: Approval and user input request management.

### Thread Hooks

- `useThreads`: Master hook coordinating all thread sub-hooks.
- `useThreadActions`: Start, fork, resume, refresh, archive, reset, list threads. Supports pagination (`loadOlderThreadsForWorkspace`).
- `useThreadMessaging`: Send messages, steer turns, start reviews, fork, compact, resume. Handles prompt expansion, service tier, collaboration mode.
- `useThreadEventHandlers`: Processes app server events (thread started, items added, turn completed, thread archived/unarchived).
- `useThreadApprovals`: Manages approval requests and allowlist.
- `useThreadUserInput`: Handles user input request submission.
- `useThreadSelectors`: Derives activeThreadId and activeItems from state.
- `useThreadStatus`: Processing/reviewing state management.
- `useThreadStorage`: localStorage-backed thread metadata (custom names, activity timestamps, pinned threads).
- `useThreadLinking`: Parent-child thread relationship management.
- `useThreadRateLimits`: Rate limit fetching and tracking per workspace.
- `useThreadAccountInfo`: Account info (type, email, plan) per workspace.
- `useThreadTitleAutogeneration`: Auto-generates thread titles from first user message.
- `useThreadCodexParams`: Per-thread model/effort/access preferences.
- `useQueuedSend`: Message queuing, sequential flush, slash command dispatch.
- `useDetachedReviewTracking`: Tracks detached review child threads.
- `useReviewPrompt`: Multi-step review target selection (preset, branch, commit, custom).
- `useRenameThreadPrompt`: Thread rename dialog.
- `useCopyThread`: Copy thread content to clipboard.

### Thread List UI

- **Sidebar** (`features/app/components/Sidebar.tsx`): Full sidebar with search, workspace groups, thread list, pinned threads, bottom rail.
- **ThreadRow** (`ThreadRow.tsx`): Individual thread row with status indicator, subagent pill (color-coded by hash), time label, context menu.
- **PinnedThreadList** (`PinnedThreadList.tsx`): Pinned threads section above main list.
- **SidebarSearchBar** (`SidebarSearchBar.tsx`): Filter threads and workspaces.
- **SidebarWorkspaceGroups** (`SidebarWorkspaceGroups.tsx`): Grouped workspace display.
- **SidebarThreadsOnlySection** (`SidebarThreadsOnlySection.tsx`): Flat thread list mode.
- **SidebarBottomRail** (`SidebarBottomRail.tsx`): Settings, add workspace, usage display.
- **ThreadList** (`ThreadList.tsx`): Virtualized thread list with time buckets (Now, Earlier today, Yesterday, This week, Older).

### Thread List Features

- Sort by `created_at` or `updated_at`.
- Organize by project (workspace groups), project activity, or threads only.
- Search/filter across thread names and workspace names.
- Pin/unpin threads.
- Context menu: rename, archive, copy, open in new worktree, pin/unpin.
- Collapsible workspace groups and subagent tree branches.
- Unread indicator, processing spinner, user input required indicator.

---

## 5. Message Rendering

### ConversationItem Types

Seven distinct kinds with specialized renderers:

1. **message** (`MessageRow`): User and assistant messages.
   - Renders markdown content via `Markdown` component.
   - Image grid with lightbox viewer (click to zoom).
   - Copy button, quote button (with text selection support).
   - Table-only messages get special styling (`message-bubble-table-only`).

2. **reasoning** (`ReasoningRow`): Model reasoning/thinking output.
   - Expandable/collapsible with Brain icon.
   - Shows summary title (truncated to 80 chars), body text as markdown.
   - Status tone: processing (no body) or completed (has body).

3. **review** (`ReviewRow`): Code review items.
   - Shows "Review started" or "Review completed" header with badge.
   - Review text rendered as markdown.

4. **diff** (`DiffRow`): Inline diff display.
   - Title header with optional status.
   - Uses `PierreDiffBlock` for syntax-highlighted diff rendering.

5. **tool** (`ToolRow`): Tool call results -- the most complex renderer.
   - Icon selection by tool type: Terminal (command), FileDiff (file change), Search (web search), Image (image view), Users (collaboration), Brain (reasoning), FileText (read), Wrench (generic).
   - Tool types: `commandExecution`, `fileChange`, `webSearch`, `imageView`, `collabToolCall`, `mcpToolCall`, `hook`, `plan`.
   - Command execution: Shows cleaned command text, working directory, live output with auto-scroll, terminal-style output display (max 200 lines window).
   - File changes: Shows file list with per-file diff rendering via `PierreDiffBlock`.
   - Plan tool: Shows plan output as markdown with "Export .md" action.
   - MCP tool calls: Smart labeling (search, read, generic tool).
   - Collaboration tool calls: Shows sender/receiver agents with nickname/role labels.
   - Expandable/collapsible with inline status badge.
   - Duration display for hooks.

6. **explore** (`ExploreRow`): File exploration activities.
   - Shows list of entries (read, search, list, run operations).
   - Merges consecutive explore items.
   - Status: exploring (spinner) or explored (complete).

7. **userInput** (`UserInputRow`): Answered user input prompts.
   - Expandable/collapsible.
   - Shows question/answer pairs.
   - Preview format: "answered: [question]: [answer] +N more".

### Message Grouping

- `buildToolGroups()`: Groups consecutive tool/reasoning/explore/userInput items into collapsible tool groups.
- Groups show summary: "N tool calls, M messages".
- Single items are not grouped.

### Additional Message Features

- **WorkingIndicator**: Spinner with elapsed timer during processing. Shows "Done in X:XX" after completion. Remote polling countdown display.
- **PlanReadyFollowupMessage**: Shows accept/modify buttons when a plan completes.
- **RequestUserInputMessage**: Multi-question form with option selection and freetext notes.
- **Markdown renderer** (`Markdown.tsx`): ReactMarkdown with GFM, syntax highlighting (Shiki), file link detection, thread link detection, code block copy.
- **Image lightbox**: Full-screen image preview with Escape to close.

---

## 6. Plan and Approval UI

### Plan Panel (`PlanPanel.tsx`)

- Displays active `TurnPlan` with step progress (completed/total).
- Optional explanation text.
- Ordered step list with status indicators: `[ ]` pending, `[>]` in-progress, `[x]` completed.
- "Waiting on a plan..." / "No active plan." empty states.
- Resizable panel height.

### Plan Ready Follow-up

- `PlanReadyFollowupMessage`: Shown when a plan tool completes successfully.
- Two actions: "Accept" (proceed with plan) and "Submit changes" (modify the plan).
- Plan export: "Export .md" button saves plan content to file via system save dialog.

### Approval Toasts (`ApprovalToasts.tsx`)

- Toast-based approval UI displayed as a viewport-anchored stack.
- Shows: workspace name, method name (parsed from `codex/requestApproval/`), parameter details.
- Actions: **Decline**, **Always allow** (remembers command pattern), **Approve (Enter)**.
- Enter key globally approves the latest request when not in an input field.
- Parameters rendered as key-value pairs; arrays/objects shown as JSON code blocks.

### Request User Input

- `RequestUserInputMessage`: Structured form for agent-requested user input.
- Supports multiple questions per request.
- Each question can have selectable options and/or freetext input.
- Submit button sends answers back to the agent.

---

## 7. Workspace Management

### Workspace Types

- `WorkspaceKind`: `"main"` | `"worktree"`.
- `WorkspaceInfo`: id, name, path, connected status, kind, parentId, worktree info, settings.
- `WorkspaceSettings`: sidebarCollapsed, sortOrder, groupId, cloneSourceWorkspaceId, gitRoot, launchScript, launchScripts, worktreeSetupScript, worktreesFolder.
- `WorkspaceGroup`: id, name, sortOrder, copiesFolder.

### Workspace Hooks

- `useWorkspaces`: Lists and manages workspaces via Tauri backend.
- `useWorkspaceCrud`: Add, remove, update workspace settings.
- `useWorkspaceSelection`: Tracks active workspace, handles workspace switching.
- `useWorkspaceGroupOps`: Create, rename, move, delete workspace groups; assign workspaces to groups.
- `useWorktreeOps`: Add worktree, remove worktree, rename worktree, rename upstream branch.
- `useClonePrompt`: Clone workspace dialog state.
- `useWorktreePrompt`: Worktree creation dialog (branch name, copy agents.md option).
- `useWorkspaceFromUrlPrompt`: Add workspace from git URL dialog.
- `useRenameWorktreePrompt`: Rename worktree branch dialog.
- `useWorkspaceDropZone`: Drag-and-drop workspace folder import.
- `useWorkspaceFiles`: File listing for the active workspace.
- `useWorkspaceHome`: Workspace home view state (run mode, recent threads, prompt).
- `useWorkspaceRefreshOnFocus`: Refresh workspace data on window focus.
- `useWorkspaceRestore`: Restore previously active workspace on app launch.
- `useWorkspaceAgentMd`: Read/write workspace-level agents.md file.

### Workspace Components

- **WorkspaceHome** (`WorkspaceHome.tsx`): Workspace landing page with:
  - Git init banner (for repos without git).
  - Run controls (start agent, run mode selection).
  - Recent thread history.
  - Agents.md editor (`FileEditorCard`).
  - Composer input for starting new runs.
  - Model/effort/collaboration mode selection.
  - Dictation support.
- **WorktreePrompt** (`WorktreePrompt.tsx`): Modal for creating git worktrees.
- **ClonePrompt** (`ClonePrompt.tsx`): Modal for cloning workspaces.
- **WorkspaceFromUrlPrompt** (`WorkspaceFromUrlPrompt.tsx`): Modal for adding workspace from git URL.
- **MobileRemoteWorkspacePrompt** (`MobileRemoteWorkspacePrompt.tsx`): Mobile workspace path entry.
- **WorkspaceHomeGitInitBanner** (`WorkspaceHomeGitInitBanner.tsx`): Banner prompting git init.
- **WorkspaceHomeRunControls** (`WorkspaceHomeRunControls.tsx`): Run mode selector, model pills, start button.
- **WorkspaceHomeHistory** (`WorkspaceHomeHistory.tsx`): Recent thread instances list.

### Workspace Operations (Tauri Service Layer)

- `addWorkspace(path)`, `addWorkspaceFromGitUrl(url, dest, name)`, `addClone(sourceId, folder, name)`.
- `addWorktree(parentId, branch, name, copyAgentsMd)`, `removeWorktree(id)`, `renameWorktree(id, branch)`.
- `connectWorkspace(id)`, `removeWorkspace(id)`, `updateWorkspaceSettings(id, settings)`.
- `applyWorktreeChanges(workspaceId)`, `getWorktreeSetupStatus(workspaceId)`, `markWorktreeSetupRan(workspaceId)`.
- `isWorkspacePathDir(path)`, `pickWorkspacePath()`, `pickWorkspacePaths()`.
- `listWorkspaces()`.

### Launch Scripts

- Each workspace can have multiple launch scripts (`LaunchScriptEntry`).
- Icons: play, build, debug, wrench, terminal, code, server, database, package, test, lint, dev, git, config, logs.
- `LaunchScriptButton`, `LaunchScriptEntryButton`, `LaunchScriptIconPicker` components.
- `useWorkspaceLaunchScript` / `useWorkspaceLaunchScripts` hooks.
- `useWorktreeSetupScript`: Runs setup script on new worktree creation.

---

## 8. Settings Surface

### Settings Sections (13 total)

Accessed via `SettingsView` modal with side navigation (`SettingsNav`).

1. **Projects** (`SettingsProjectsSection`): Workspace list with reorder, delete, group assignment. Workspace group management (create, rename, move, delete).

2. **Environments** (`SettingsEnvironmentsSection`): Per-workspace environment configuration.

3. **Display & Sound** (`SettingsDisplaySection`): Theme (system/light/dark/dim), UI scale, reduce transparency, UI font family, code font family, code font size, notification sounds enable/disable, system notifications enable/disable, subagent system notifications, usage show remaining toggle, show message file path.

4. **About** (`SettingsAboutSection`): App version, links.

5. **Composer** (`SettingsComposerSection`): Editor preset (default/helpful/smart), individual toggle overrides for fence expansion, language tags, wrap selection, auto-wrap paste, list continuation, code block copy modifier.

6. **Dictation** (`SettingsDictationSection`): Dictation enable/disable, model selection (tiny/base/small/medium/large-v3), download/cancel/remove model, preferred language, hold key configuration.

7. **Shortcuts** (`SettingsShortcutsSection`): 18 configurable keyboard shortcuts:
   - Composer: model cycle, access cycle, reasoning cycle, collaboration cycle.
   - Actions: interrupt, new agent, new worktree agent, new clone agent, archive thread.
   - Navigation: toggle projects sidebar, toggle git sidebar, branch switcher, toggle debug panel, toggle terminal, cycle agent next/prev, cycle workspace next/prev.

8. **Open In** (`SettingsOpenAppsSection`): Configure external apps for "Open in" functionality. Each target: id, label, kind (app/command/finder), appName, command, args. Shows app icons.

9. **Git** (`SettingsGitSection`): Commit message prompt template, commit message model selection, preload git diffs toggle, git diff ignore whitespace changes, global worktrees folder.

10. **Server** (`SettingsServerSection`): Backend mode (local/remote), remote backend provider (TCP), remote backend host/token, Tailscale integration (status, DNS name, daemon start/stop), keep daemon running after close, Codex binary path, Codex args, Codex doctor (health check), Codex update.

11. **Agents** (`SettingsAgentsSection`): Multi-agent enable/disable, max threads, max depth, agent list (create/edit/delete). Each agent: name, description, developer instructions, config file, template, model, reasoning effort.

12. **Codex** (`SettingsCodexSection`): Codex-specific configuration (binary path, args, config TOML editor).

13. **Features** (`SettingsFeaturesSection`): Experimental feature flags from Codex backend. Each feature: name, stage (under_development/beta/stable/deprecated/removed), enabled toggle, description, announcement.

### App-Level Settings (`AppSettings` type, ~75 fields)

- Backend: codexBin, codexArgs, backendMode, remoteBackendProvider/Host/Token, remoteBackends, activeRemoteBackendId, keepDaemonRunningAfterAppClose.
- Defaults: defaultAccessMode, reviewDeliveryMode.
- Composer shortcuts: composerModelShortcut, composerAccessShortcut, composerReasoningShortcut, composerCollaborationShortcut.
- Action shortcuts: interruptShortcut, newAgentShortcut, newWorktreeAgentShortcut, newCloneAgentShortcut, archiveThreadShortcut.
- Panel shortcuts: toggleProjectsSidebarShortcut, toggleGitSidebarShortcut, branchSwitcherShortcut, toggleDebugPanelShortcut, toggleTerminalShortcut.
- Navigation shortcuts: cycleAgentNext/Prev, cycleWorkspaceNext/Prev.
- Display: uiScale, theme, uiFontFamily, codeFontFamily, codeFontSize.
- Behavior: usageShowRemaining, showMessageFilePath, chatHistoryScrollbackItems, threadTitleAutogenerationEnabled, automaticAppUpdateChecksEnabled.
- Notifications: notificationSoundsEnabled, systemNotificationsEnabled, subagentSystemNotificationsEnabled.
- Git: splitChatDiffView, preloadGitDiffs, gitDiffIgnoreWhitespaceChanges, commitMessagePrompt, commitMessageModelId.
- Advanced: collaborationModesEnabled, steerEnabled, followUpMessageBehavior, composerFollowUpHintEnabled, pauseQueuedMessagesWhenResponseRequired, unifiedExecEnabled.
- Apps: experimentalAppsEnabled, personality, dictationEnabled, dictationModelId, dictationPreferredLanguage, dictationHoldKey.
- Composer editor: composerEditorPreset, composerFence\* toggles, composerListContinuation, composerCodeBlockCopyUseModifier.
- Workspace: workspaceGroups, globalWorktreesFolder, openAppTargets, selectedOpenAppId.

---

## 9. File Browsing and Mentions

### File Tree Panel (`FileTreePanel.tsx`)

- Virtualized file tree using `@tanstack/react-virtual`.
- Builds tree from flat file paths. Folders are collapsible.
- Search/filter bar for file names.
- File type icons via `getFileTypeIconUrl()`.
- Context menu per file: Insert mention (@path), Open in app, Reveal in file manager.
- File preview popover on hover.
- Modified files highlighted (git status integration).
- Row height: 28px.
- Supports `PanelTabId` mode switching.

### File Preview (`FilePreviewPopover.tsx`)

- Reads file content via `readWorkspaceFile` Tauri command.
- Shows syntax-highlighted preview.
- Handles truncation for large files.

### File Mentions

- `@` trigger in composer activates file autocomplete.
- Files from workspace listing matched against typed query.
- File path inserted into composer text.
- Workspace file listing provided by `useWorkspaceFiles` hook via `getWorkspaceFiles` Tauri command.

### File Link Handling

- `useFileLinkOpener`: Opens file links in configured external editor.
- `fileLinks.ts`: Parses `path:line:col` format from message text.
- `remarkFileLinks.ts`: Remark plugin that converts file paths in markdown to clickable links.
- Context menu for file links: Open in default app, Open in specific app, Copy path.

---

## 10. Git and GitHub Integration

### Git Hooks

- `useGitStatus`: Fetches git status (branch, staged/unstaged files, additions/deletions). Auto-refreshes on thread message activity.
- `useGitDiffs`: Fetches file diffs for the workspace.
- `useGitLog`: Fetches commit log (entries, ahead/behind counts, upstream).
- `useGitCommitDiffs`: Fetches diff for a specific commit.
- `useGitBranches`: Lists local and remote branches.
- `useBranchSwitcher`: Branch checkout with search.
- `useBranchSwitcherShortcut`: Keyboard shortcut for branch switcher.
- `useGitRemote`: Fetches remote URL.
- `useGitActions`: Stage, unstage, revert, commit, push, pull, fetch, sync operations.
- `useGitRepoScan`: Scans for git roots within workspace.
- `useInitGitRepoPrompt`: Git repo initialization flow.
- `useAutoExitEmptyDiff`: Exits diff view when no changes remain.
- `useDiffFileSelection`: Tracks selected file in diff view.

### GitHub Hooks

- `useGitHubIssues`: Fetches GitHub issues for the repo.
- `useGitHubPullRequests`: Fetches pull requests.
- `useGitHubPullRequestDiffs`: Fetches PR diffs.
- `useGitHubPullRequestComments`: Fetches PR comments.
- `usePullRequestComposer`: Manages PR review message composition.
- `usePullRequestLineSelection`: Line selection for PR review comments.
- `usePullRequestReviewActions`: Review action buttons (full review, risks, tests, summary, question).

### Git Panel Components

- **GitDiffPanel** (`GitDiffPanel.tsx`): Main git panel with multiple modes:
  - Status mode: File list with staged/unstaged status, additions/deletions.
  - Diff mode: Side-by-side or unified diff viewer.
  - Per-file mode: Thread-level diffs grouped by file.
  - Log mode: Commit history with ahead/behind indicators.
  - Issues mode: GitHub issues list.
  - Pull Requests mode: PR list with diff viewing.
- **GitDiffViewer** (`GitDiffViewer.tsx`): Full diff viewer with file navigation, syntax highlighting, line selection, image diff support.
- **GitDiffViewerDiffCard** (`GitDiffViewerDiffCard.tsx`): Individual file diff card.
- **GitDiffViewerPullRequestSummary** (`GitDiffViewerPullRequestSummary.tsx`): PR summary header.
- **BranchSwitcherPrompt** (`BranchSwitcherPrompt.tsx`): Modal for switching branches with search.
- **BranchList** (`BranchList.tsx`): Branch list with search filtering.
- **InitGitRepoPrompt** (`InitGitRepoPrompt.tsx`): Git initialization dialog.
- **PierreDiffBlock** (`PierreDiffBlock.tsx`): Syntax-highlighted diff block renderer.
- **ImageDiffCard** (`ImageDiffCard.tsx`): Side-by-side image diff display.
- **GitHubPanelData** (`GitHubPanelData.tsx`): Data fetcher component for GitHub integration (lazy loaded).

### Git Operations (Tauri Layer)

- `getGitStatus`, `getGitDiffs`, `getGitLog`, `getGitCommitDiff`, `getGitRemote`.
- `stageGitFile`, `stageGitAll`, `unstageGitFile`, `revertGitFile`, `revertGitAll`.
- `commitGit`, `pushGit`, `pullGit`, `fetchGit`, `syncGit`.
- `listGitBranches`, `checkoutGitBranch`, `listGitRoots`.
- `initGitRepo`, `createGitHubRepo`.
- `getGitHubIssues`, `getGitHubPullRequests`, `getGitHubPullRequestDiff`, `getGitHubPullRequestComments`, `checkoutGitHubPullRequest`.

### Review System

- `/review` command opens multi-step review prompt.
- Review targets: uncommitted changes, base branch, specific commit, custom instructions.
- Review delivery: inline (blocks parent thread) or detached (separate thread).
- PR review intents: full, risks, tests, summary, question.
- PR line selection for targeted review comments.
- Review prompt with preset selection, branch picker, commit picker, custom instructions.

---

## 11. Prompt Library

### Data Model

- `CustomPromptOption`: name, path, description, argumentHint, content, scope (workspace/global).

### Prompt Hooks

- `useCustomPrompts`: Fetches prompt list from backend. Provides create, update, delete, move operations.

### Prompt Panel (`PromptPanel.tsx`)

- Lists workspace and global prompts with search filtering.
- Context menu per prompt: Send to agent, Send to new agent, Edit, Move (workspace<->global), Delete.
- Create/edit form: name, description, argument hint, content (multi-line), scope selector.
- Argument support: prompts with `argumentHint` accept arguments after the prompt name.
- Prompt command format: `/prompts:promptName [args]`.

### Prompt Expansion

- `expandCustomPromptText()` in `utils/customPrompts.ts`: Resolves `/prompts:name` references in message text.
- Supports argument substitution into prompt content.
- Error handling for missing prompts.

### Autocomplete Integration

- Prompts appear in `/` autocomplete with `prompts:` prefix.
- Shows prompt name, description, and argument hint in autocomplete.

---

## 12. Home and Dashboard

### Home View (`features/home/components/Home.tsx`)

- Title: "Codex Monitor" with subtitle "Orchestrate agents across your local projects."
- **HomeLatestAgentsSection**: Shows recent agent runs across all workspaces with project name, message preview, timestamp, processing status. Clicking navigates to the thread.
- **HomeActions**: "Add workspace" and "Add from URL" buttons.
- **HomeUsageSection**: Usage statistics dashboard with:
  - Account info (email, plan type).
  - Rate limit display (primary/secondary windows, credits).
  - Local usage statistics (7-day/30-day tokens, average daily, cache hit rate, peak day).
  - Usage metric toggle (tokens vs time).
  - Per-workspace usage filtering.
  - Top models by usage share.

### Home Types

- `LatestAgentRun`: message, timestamp, projectName, groupName, workspaceId, threadId, isProcessing.
- `UsageMetric`: "tokens" | "time".
- `UsageWorkspaceOption`: id, label.
- `HomeStatCard`: label, value, suffix, caption.

### Local Usage Data

- `LocalUsageSnapshot`: days array, totals, top models.
- `LocalUsageDay`: day, inputTokens, cachedInputTokens, outputTokens, totalTokens, agentTimeMs, agentRuns.
- `useLocalUsage` hook fetches via `localUsageSnapshot` Tauri command.

---

## 13. State Management

### Architecture: Hook-Based State (No Store Library)

The application uses React hooks and `useReducer` as its state management pattern. There is no external store library (no Redux, Zustand, Jotai, etc.).

### Core State Holders

1. **Thread State** (`useThreadsReducer`): Single large reducer managing all thread-related state. Dispatches via `ThreadAction` discriminated union. Split into sub-slices for maintainability.

2. **App Settings** (`useAppSettings`): Loads and persists `AppSettings` via Tauri backend. Queued save for debounced persistence.

3. **Workspace State** (`useWorkspaces` + `useWorkspaceController`): Workspace list, groups, active workspace, CRUD operations.

4. **Layout State** (`useLayoutController`): Sidebar collapsed, right panel collapsed, panel sizes, debug open, terminal open, resizing state, responsive breakpoints.

5. **Model State** (`useModels`): Available models, selected model, reasoning options, effort selection.

6. **Collaboration State** (`useCollaborationModes`): Available collaboration modes, selected mode.

7. **Composer State**: Distributed across multiple hooks (text, autocomplete, images, drafts, dictation).

### Data Flow Pattern

- Tauri backend events arrive via `subscribeAppServerEvents` -> `useAppServerEvents` -> `useThreadEventHandlers` -> dispatch to thread reducer.
- User actions flow: Component -> hook callback -> Tauri invoke -> backend response -> state update -> re-render.
- Settings changes: Component -> `setAppSettings` -> `queueSaveSettings` (debounced) -> `updateAppSettings` Tauri invoke.

### Orchestration Hooks

The `app/orchestration/` directory contains composition hooks that wire together multiple hooks:

- `useThreadOrchestration`: Bootstrap, sync, selection handlers, UI orchestration for threads.
- `useWorkspaceOrchestration`: Workspace insights and ordering orchestration.
- `useLayoutOrchestration`: App shell class names and layout state.
- `useThreadCodexOrchestration`: Thread-scoped Codex parameters (model, effort, access mode, service tier).
- `useAppBootstrapOrchestration`: Initial app setup (settings, doctor, debug, dictation, scale).

---

## 14. Service Layer (Tauri Bridge)

### `services/tauri.ts` (~950 lines)

All communication with the Rust Tauri backend happens through `invoke()` calls. Major categories:

**Workspace Management**: `listWorkspaces`, `addWorkspace`, `addWorkspaceFromGitUrl`, `addClone`, `addWorktree`, `removeWorkspace`, `removeWorktree`, `renameWorktree`, `renameWorktreeUpstream`, `updateWorkspaceSettings`, `connectWorkspace`, `applyWorktreeChanges`, `getWorktreeSetupStatus`, `markWorktreeSetupRan`, `isWorkspacePathDir`.

**Thread Operations**: `startThread`, `forkThread`, `compactThread`, `sendUserMessage`, `interruptTurn`, `steerTurn`, `startReview`, `readThread`, `setThreadName`, `archiveThread`, `listThreads`.

**Approvals**: `respondToServerRequest`, `respondToUserInputRequest`, `rememberApprovalRule`.

**Git**: `getGitStatus`, `getGitDiffs`, `getGitLog`, `getGitCommitDiff`, `getGitRemote`, `stageGitFile`, `stageGitAll`, `unstageGitFile`, `revertGitFile`, `revertGitAll`, `commitGit`, `pushGit`, `pullGit`, `fetchGit`, `syncGit`, `listGitBranches`, `checkoutGitBranch`, `listGitRoots`, `initGitRepo`, `createGitHubRepo`.

**GitHub**: `getGitHubIssues`, `getGitHubPullRequests`, `getGitHubPullRequestDiff`, `getGitHubPullRequestComments`, `checkoutGitHubPullRequest`.

**Models & Features**: `getModelList`, `getExperimentalFeatureList`, `setCodexFeatureFlag`, `getCollaborationModes`, `getSkillsList`, `getAppsList`.

**Prompts**: `getPromptsList`, `createPrompt`, `updatePrompt`, `deletePrompt`, `movePrompt`, `getWorkspacePromptsDir`, `getGlobalPromptsDir`.

**Files**: `getWorkspaceFiles`, `readWorkspaceFile`, `readAgentMd`, `writeAgentMd`, `readGlobalAgentsMd`, `writeGlobalAgentsMd`, `readGlobalCodexConfigToml`, `writeGlobalCodexConfigToml`, `readImageAsDataUrl`, `exportMarkdownFile`.

**Agents**: `getAgentsSettings`, `setAgentsCoreSettings`, `createAgent`, `updateAgent`, `deleteAgent`, `readAgentConfigToml`, `writeAgentConfigToml`.

**Settings**: `getAppSettings`, `updateAppSettings`, `setMenuAccelerators`.

**Account**: `getAccountRateLimits`, `getAccountInfo`, `runCodexLogin`, `cancelCodexLogin`.

**Server**: `tailscaleStatus`, `tailscaleDaemonStart/Stop/Status`, `tailscaleDaemonCommandPreview`.

**System**: `runCodexDoctor`, `runCodexUpdate`, `isMobileRuntime`, `getConfigModel`, `setWorkspaceRuntimeCodexArgs`, `openWorkspaceIn`, `getOpenAppIcon`, `generateRunMetadata`, `localUsageSnapshot`.

**Terminal**: `terminalSpawn`, `terminalWrite`, `terminalResize`, `terminalKill`.

**Dictation**: `dictationModelStatus`, `dictationModelDownload`, `dictationModelDownloadCancel`, `dictationModelRemove`, `dictationSessionStart`, `dictationSessionStop`.

**Tray**: `setTrayRecentThreads`, `setTraySessionUsage`.

### `services/events.ts`

Event hub pattern using `createEventHub<T>()`. Subscriptions auto-start/stop Tauri event listeners.

Event channels: `app-server-event`, `dictation-download`, `dictation-event`, `terminal-output`, `terminal-exit`, `updater-check`, `tray-open-thread`, `menu-new-agent`, `menu-new-worktree-agent`, `menu-new-clone-agent`, `menu-add-workspace`, `menu-add-workspace-from-url`, `menu-open-settings`, `menu-toggle-*-sidebar/panel/terminal`, `menu-next/prev-agent/workspace`, `menu-composer-cycle-*`.

### `services/toasts.ts`

Simple pub/sub for error toasts with auto-generated IDs.

### `services/dragDrop.ts`

Window-level drag-and-drop event subscription via `getCurrentWindow().onDragDropEvent()`.

---

## 15. Multi-Agent Visualization

### Subagent Trees

- `subagentTree.ts`: `getSubagentDescendantThreadIds()` performs BFS traversal of parent-child thread relationships to find all subagent descendants.
- `threadParentById`: Record mapping child thread IDs to parent thread IDs.
- Thread linking: `useThreadLinking` hook maintains parent-child relationships.
- Subagent detection: `isSubagent` flag on `ThreadSummary`, `onSubagentThreadDetected` callback.

### Thread Grouping in Sidebar

- Subagent threads are nested under their parent threads with indentation.
- `ThreadRow` shows subagent pill with color-coded hue based on hash of workspace+nickname/role.
- Subagent groups are collapsible/expandable via toggle.
- Formatting: `formatSubagentRoleLabel()` normalizes role labels (replace underscores, capitalize words).

### Cascade Operations

- Archiving a parent thread cascades to archive all subagent descendants.
- `CASCADE_ARCHIVE_SKIP_TTL_MS = 120000` (2 min TTL for skipping cascade re-triggers).

### Collaboration Tool Rendering

- `collabToolCall` tool type renders sender/receiver agent information.
- Labels: "spawning/spawned", "sending to/sent to", "waiting for/waited for", "resuming/resumed", "closing/closed".
- Multiple receivers: Shows first receiver with "+N" indicator.

### Thread Hydration

- `hydrateSubagentThreads()`: Reads full thread data for discovered subagent threads to populate nickname, role, timestamps.
- In-flight tracking prevents duplicate hydration requests.

---

## 16. Notification and Sound System

### Sound Notifications

- `useAgentSoundNotifications`: Plays success/error sounds when agent turns complete.
- Sound files: `success-notification.mp3`, `error-notification.mp3`.
- Controlled by `notificationSoundsEnabled` setting.
- `notificationSounds.ts`: Audio playback utility.

### System Notifications

- `useAgentSystemNotifications`: Native OS notifications via `@tauri-apps/plugin-notification`.
- `useAgentResponseRequiredNotifications`: Notifications for approval requests and user input.
- Controlled by `systemNotificationsEnabled` and `subagentSystemNotificationsEnabled`.
- `useSystemNotificationThreadLinks`: Links notification clicks to thread navigation.

### Error Toasts

- `useErrorToasts`: Manages error toast stack.
- `ErrorToasts` component renders toast cards with dismiss buttons.
- Toasts auto-dismiss after configurable duration.

---

## 17. Dictation / Voice Features

### Dictation System

- **Model Management**: `useDictationModel` hook manages Whisper model lifecycle (download, cancel, remove).
- Five model sizes: tiny (75MB), base (142MB), small (466MB), medium (1.5GB), large-v3 (3.0GB).
- Model states: missing, downloading, ready, error.
- Download progress tracking (totalBytes, downloadedBytes).

### Dictation Session

- `useDictation`: Core dictation session management.
- `useHoldToDictate`: Hold-key-to-dictate mode (configurable hold key).
- Session states: idle, listening, processing.
- Events: state changes, audio level, transcript, error, canceled.
- Transcripts include unique IDs for idempotent handling.
- `DictationWaveform` component: Visual audio level indicator.

### Integration

- Mic button in composer: Toggle dictation, cancel, open settings.
- Dictation transcripts are inserted into composer text via `useComposerDraftEffects`.
- Configurable preferred language.
- Mobile actions menu includes dictation toggle.

---

## 18. Terminal Integration

### Terminal Hooks

- `useTerminalController`: Manages terminal lifecycle, spawning, and session coordination.
- `useTerminalSession`: Individual terminal session (xterm.js integration). Handles resize, write, output events.
- `useTerminalTabs`: Multi-tab terminal management.

### Terminal Components

- `TerminalPanel`: Renders xterm.js terminal surface with status overlay (idle/connecting/ready/error).
- `TerminalDock`: Dockable terminal panel with tab bar and resize handle.

### Tauri Commands

- `terminalSpawn(workspaceId, terminalId)`: Spawn a new terminal process.
- `terminalWrite(workspaceId, terminalId, data)`: Send data to terminal.
- `terminalResize(workspaceId, terminalId, cols, rows)`: Resize terminal.
- `terminalKill(workspaceId, terminalId)`: Kill terminal process.

### Events

- `terminal-output`: Terminal output data events.
- `terminal-exit`: Terminal process exit events.

---

## 19. Update System

### Update Hooks

- `useUpdater`: Manages app update lifecycle. Stages: idle, checking, available, downloading, installing, restarting, latest, error.
- `useUpdaterController`: Coordinates update checks and notifications.

### Update UI

- `UpdateToast`: Toast-based update notification with progress bar.
- Shows: version, download progress (bytes/total), status messages.
- Actions: Update, Later, Retry (on error), Dismiss.
- Post-update notice: Shows release notes fetched from GitHub, rendered as markdown.
- Automatic update checks controlled by `automaticAppUpdateChecksEnabled`.

---

## 20. Mobile / Responsive Support

### Platform Detection

- `isMobilePlatform()` and `isMobileRuntime()` (Tauri command).
- Three layout modes: Desktop, Tablet, Phone.

### Mobile-Specific Features

- `MobileServerSetupWizard`: Setup flow for connecting mobile to remote server.
- `MobileRemoteWorkspacePrompt`: Path entry for remote workspaces.
- `useComposerMobileActions`: Mobile actions menu (attach, dictation, expand).
- Viewport height sync for mobile keyboard.
- Pinch zoom prevention.
- Composer focus state tracking for mobile keyboard handling.

### Responsive CSS

- `compact-base.css`: Shared compact mode styles.
- `compact-phone.css`: Phone-specific styles.
- `compact-tablet.css`: Tablet-specific styles.
- `PhoneLayout`: Single-column with tab bar navigation.
- `TabletLayout`: Two-section with swipeable navigation.
- `TabletNav`: Tablet navigation component.
- `TabBar`: Bottom tab bar for phone layout.

---

## 21. Design System

### Primitives

- `ModalShell`: Reusable modal container with backdrop and escape handling.
- `PanelPrimitives`: `PanelMeta`, `PanelSearchField` for consistent panel headers.
- `PopoverPrimitives`: Popover positioning and rendering.
- `SettingsPrimitives`: Settings form controls.
- `ToastPrimitives`: `ToastViewport`, `ToastCard`, `ToastHeader`, `ToastTitle`, `ToastBody`, `ToastError`, `ToastActions`.
- `classNames`: Utility for conditional class name joining.
- `diffViewerTheme`: Theming for the diff viewer component.

---

## 22. Account and Authentication

### Account Types

- `AccountSnapshot`: type (chatgpt/apikey/unknown), email, planType, requiresOpenaiAuth.
- `RateLimitSnapshot`: primary/secondary windows, credits, planType.
- `CreditsSnapshot`: hasCredits, unlimited, balance.

### Account Hooks

- `useThreadAccountInfo`: Fetches account info per workspace.
- `useAccountSwitching`: Handles OpenAI auth login flow (`runCodexLogin`, `cancelCodexLogin`).
- `useHomeAccount`: Provides account data for home dashboard.

### Tray Integration

- `useTrayRecentThreads`: Updates system tray with recent thread list.
- `useTraySessionUsage`: Updates tray with session/weekly usage labels.
- `subscribeTrayOpenThread`: Handles "open thread" from tray click.

---

## 23. Debug System

### Debug Hooks

- `useDebugLog`: Manages debug entry collection with max capacity.

### Debug Panel

- `DebugPanel`: Scrollable log viewer showing timestamped entries.
- Entry sources: client, server, event, stderr, error.
- Copy all entries to clipboard functionality.
- Clear entries functionality.
- Toggle via keyboard shortcut.

---

## 24. Skills and Apps

### Skills

- `useSkills`: Fetches skill list from Codex backend.
- `SkillOption`: name, path, description.
- Skills appear in `/` autocomplete.

### Apps (Connected Apps / Connectors)

- `useApps`: Fetches available apps from backend.
- `AppOption`: id, name, description, isAccessible, installUrl, distributionChannel.
- `$` trigger in composer for app mentions.
- App mention resolution: `connectorMentionSlug()`, `resolveBoundAppMentions()`.
- `AppMention`: name, path (sent with messages for context).

### Collaboration Modes

- `useCollaborationModes`: Fetches available collaboration modes.
- `CollaborationModeOption`: id, label, mode, model, reasoningEffort, developerInstructions, value.
- Selectable per-thread and per-message.

---

## 25. Keyboard Shortcuts Summary

### Global Shortcuts (configurable)

- Cycle model, cycle access mode, cycle reasoning effort, cycle collaboration mode.
- Interrupt agent, new agent, new worktree agent, new clone agent.
- Archive thread, toggle projects sidebar, toggle git sidebar.
- Branch switcher, toggle debug panel, toggle terminal.
- Cycle agent next/prev, cycle workspace next/prev.

### Composer Shortcuts

- Enter: Send (or queue/steer when processing).
- Shift+Enter: New line (or continue list).
- Shift+Cmd+Enter: Send with opposite follow-up intent.
- Up/Down arrows: Prompt history navigation (when autocomplete closed).
- Tab: Accept autocomplete suggestion.
- Backtick triggers: Auto-expand code fences.

### UI Scale

- Cmd+Plus / Cmd+Minus: Zoom in/out.
- Cmd+0: Reset zoom.
