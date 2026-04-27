# Paseo App Client and CLI -- Complete Feature and Implementation Inventory

Source-code exploration of `packages/app/` (cross-platform Expo app) and `packages/cli/` (Node.js CLI client).

---

## App Client Section

### 1. Directory Structure

```
packages/app/src/
  app/                         -- Expo Router layout and routes
    _layout.tsx                -- Root layout, providers, host runtime wiring
    index.tsx                  -- Root route, host selection / redirect
    welcome.tsx                -- Welcome/onboarding screen
    settings.tsx               -- Legacy settings redirect
    pair-scan.tsx              -- QR code scanning for pairing
    h/[serverId]/              -- Per-host dynamic routes
      index.tsx                -- Host root, redirects to workspace/open-project
      agent/[agentId].tsx      -- Agent detail route (redirects to workspace)
      open-project.tsx         -- Open project screen
      sessions.tsx             -- All sessions list
      settings.tsx             -- Host settings screen
      workspace/[workspaceId]/
        _layout.tsx            -- Workspace layout, intent parsing
        index.tsx              -- Null placeholder

  attachments/                 -- File attachment system
    service.ts                 -- Attachment persistence service
    store.ts                   -- Attachment store abstraction
    types.ts                   -- AttachmentMetadata type
    utils.ts                   -- Attachment utilities
    local-file-attachment-store.ts
    native/native-file-attachment-store.ts
    web/indexeddb-attachment-store.ts
    use-attachment-preview-url.ts

  components/                  -- All UI components
    active-processes.tsx        -- Running agent process list
    adaptive-modal-sheet.tsx    -- Cross-platform modal sheet
    add-host-method-modal.tsx   -- Host connection method picker
    add-host-modal.tsx          -- Add host by address
    agent-activity.tsx          -- Agent activity display
    agent-form/                 -- Agent creation form dropdowns
    agent-input-area.tsx        -- Chat composer (input area wrapper)
    agent-input-area.status-controls.ts
    agent-input-submit.ts       -- Message submission logic
    agent-list.tsx              -- Agent list component
    agent-status-bar.tsx        -- Agent status bar (model, status, usage)
    agent-status-bar.model-loading.ts
    agent-status-dot.tsx        -- Status dot indicator
    agent-stream-view.tsx       -- Main agent conversation stream view
    agent-stream-render-model.ts      -- Stream rendering model
    agent-stream-render-strategy.ts   -- Rendering strategy (batching, virtualization)
    agent-stream-web-virtualization.ts -- Web-specific virtualization
    archived-agent-callout.tsx  -- Archived agent banner
    artifact-drawer.tsx         -- Artifact display drawer (markdown, diff, image, code)
    audio-debug-notice.tsx      -- Audio debug overlay
    branch-switcher.tsx         -- Git branch switching combobox
    code-insets.ts              -- Code block styling
    combined-model-selector.tsx -- Provider+model picker across all providers
    command-center.tsx          -- Command palette (Cmd+K)
    connection-status.tsx       -- Connection health indicator dot
    context-window-meter.tsx    -- Token usage circular progress indicator
    desktop/
      titlebar-drag-region.tsx  -- Electron titlebar drag area
    dictation-controls.tsx      -- Dictation (STT) overlay
    diff-scroll.tsx             -- Diff scrolling (native)
    diff-scroll.web.tsx         -- Diff scrolling (web)
    diff-viewer.tsx             -- Side-by-side diff viewer
    download-toast.tsx          -- File download progress toast
    draggable-list.tsx          -- Draggable sortable list
    empty-state.tsx             -- Empty state placeholder
    explorer-sidebar.tsx        -- File/diff explorer sidebar
    file-drop-zone.tsx          -- Drag-and-drop file zone
    file-explorer-pane.tsx      -- File tree explorer
    file-pane.tsx               -- File content viewer pane
    git-actions-policy.ts       -- Git action availability logic
    git-actions-split-button.tsx -- Git actions split button (commit, push, PR, etc.)
    git-diff-pane.tsx           -- Git diff display pane
    headers/                    -- Screen header components
    icons/                      -- Provider and app icons (Claude, Codex, Copilot, OpenCode, Pi, GitHub, Paseo)
    keyboard-shortcuts-dialog.tsx -- Shortcuts reference dialog
    left-sidebar.tsx            -- Main left sidebar (agent/workspace list)
    material-file-icons.ts      -- File type icon resolver
    message-input.tsx           -- Text input with dictation, voice, image paste, autocomplete
    message.tsx                 -- Message rendering (user, assistant, activity, tool calls, todos, plans, compaction markers)
    mode-selector-modal.tsx     -- Agent mode switcher modal
    pair-link-modal.tsx         -- Paste pairing link modal
    plan-card.tsx               -- Plan display card in stream
    project-picker-modal.tsx    -- Project/directory picker modal
    provider-diagnostic-sheet.tsx -- Provider health diagnostics
    provider-icons.ts           -- Provider icon resolver
    question-form-card.tsx      -- Structured question form from agents
    realtime-voice-overlay.tsx  -- Bidirectional realtime voice overlay
    resize-handle.tsx           -- Panel resize handle
    sidebar-agent-list-skeleton.tsx
    sidebar-workspace-list.tsx  -- Workspace list in sidebar
    sortable-inline-list.tsx    -- Sortable inline list
    split-container.tsx         -- Split pane container (IDE-like splits)
    split-drop-zone.tsx         -- Drop zone for tab-to-pane splitting
    stream-strategy-native.tsx  -- Native stream rendering
    stream-strategy-web.tsx     -- Web stream rendering
    synced-loader.tsx           -- Synchronized loading indicator
    terminal-emulator.tsx       -- xterm.js-based terminal emulator (DOM component)
    terminal-pane.tsx           -- Terminal pane wrapper
    toast-host.tsx              -- Toast notification host
    tool-call-details.tsx       -- Tool call detail expansion
    tool-call-sheet.tsx         -- Tool call detail bottom sheet
    ui/                         -- Design system primitives
      autocomplete.tsx, button.tsx, combobox.tsx, context-menu.tsx,
      dropdown-menu.tsx, segmented-control.tsx, shortcut.tsx,
      status-badge.tsx, tooltip.tsx
    voice-button.tsx            -- Voice mode toggle button
    voice-compact-indicator.tsx -- Voice active indicator
    voice-panel.tsx             -- Voice mode panel
    volume-meter.tsx            -- Audio volume visualization
    web-desktop-scrollbar.tsx   -- Custom scrollbar for web/desktop
    welcome-screen.tsx          -- Welcome/onboarding screen

  config/                      -- Audio debug configuration
  constants/
    layout.ts                  -- Layout constants, breakpoints, compact form factor detection
    platform.ts                -- isWeb, isNative booleans
    theme.ts                   -- Color, font, spacing constants

  contexts/
    explorer-sidebar-animation-context.tsx
    horizontal-scroll-context.tsx
    session-context.tsx         -- Session provider (agent streams, timeline, voice)
    session-status-tracking.ts  -- Agent status reconciliation
    session-stream-lifecycle.ts -- Stream lifecycle management
    session-stream-reducers.ts  -- Stream event processing
    session-timeline-bootstrap-policy.ts
    session-timeline-seq-gate.ts
    sidebar-animation-context.tsx
    toast-context.tsx           -- Toast notification system
    voice-context.tsx           -- Voice runtime provider

  desktop/
    attachments/                -- Desktop-specific attachment handling
    components/
      desktop-permission-row.tsx
      desktop-permissions-section.tsx
      desktop-updates-section.tsx -- Auto-update UI
      integrations-section.tsx   -- CLI install + Skills install
      pair-device-section.tsx    -- Mobile device pairing from desktop
    daemon/
      desktop-daemon.ts          -- Desktop daemon lifecycle (start, status, logs, pair)
      desktop-daemon-transport.ts -- Local socket/pipe transport
    electron/
      events.ts                  -- Electron event bridge
      host.ts                    -- Desktop host API
      invoke.ts                  -- Electron IPC invoke
      window.ts                  -- Window controls (titlebar colors)
    hooks/
      use-daemon-status.ts
    host.ts                      -- Desktop host detection
    permissions/                 -- Desktop permission management (notifications, microphone)
    pick-directory.ts            -- Native directory picker
    updates/
      desktop-updates.ts         -- App update checking and installation
      update-banner.tsx          -- Update available banner
      use-desktop-app-updater.ts

  dictation/                    -- Speech-to-text dictation
    dictation-stream-sender.ts  -- Audio chunk streaming to daemon

  hooks/
    checkout-diff-order.ts      -- Diff ordering logic
    checkout-status-revalidation.ts
    feature-preferences.ts      -- Feature preference storage
    image-attachment-picker.ts  -- Image attachment selection
    use-agent-attention-clear.ts -- Clear attention flag
    use-agent-autocomplete.ts   -- @file and /command autocomplete
    use-agent-commands-query.ts -- Slash command querying
    use-agent-form-state.ts     -- Agent creation form state
    use-agent-initialization.ts -- Agent boot sequence
    use-agent-input-draft.ts    -- Draft input persistence
    use-agent-screen-state-machine.ts -- Agent screen lifecycle state machine
    use-aggregated-agents.ts    -- Cross-host agent aggregation
    use-all-agents-list.ts      -- Full agent list with revalidation
    use-app-visible.ts          -- App visibility tracking
    use-archive-agent.ts        -- Agent archival
    use-audio-recorder.native.ts / .web.ts -- Audio recording
    use-autocomplete.ts         -- Generic autocomplete hook
    use-branch-switcher.ts      -- Branch switching logic
    use-changes-preferences.ts  -- Changes panel preferences
    use-checkout-diff-query.ts  -- Git diff data fetching
    use-checkout-pr-status-query.ts -- PR status
    use-checkout-status-query.ts -- Git checkout status
    use-client-activity.ts      -- Client activity heartbeat
    use-color-scheme.ts / .web.ts -- System color scheme detection
    use-command-center.ts       -- Command palette logic
    use-daemon-config.ts        -- Daemon configuration
    use-dictation.ts / .shared.ts -- Dictation hooks
    use-dictation-audio-source.native.ts / .web.ts
    use-draft-agent-create-flow.ts -- Draft to agent creation
    use-draft-agent-features.ts -- Draft agent feature flags
    use-explorer-open-gesture.ts -- Explorer swipe gesture
    use-favicon-status.ts       -- Browser favicon status badge
    use-file-drop-zone.ts       -- File drop handling
    use-file-explorer-actions.ts -- File explorer CRUD
    use-form-preferences.ts     -- Form defaults persistence
    use-git-actions.ts          -- Git action handlers
    use-image-attachment-picker.ts -- Image picker
    use-is-local-daemon.ts      -- Local daemon detection
    use-keyboard-action-handler.ts
    use-keyboard-shift-style.ts
    use-keyboard-shortcut-overrides.ts
    use-keyboard-shortcuts.ts   -- Global keyboard shortcut registration
    use-open-project.ts         -- Project opening
    use-open-project-picker.ts  -- Project picker trigger
    use-preferred-editor.ts     -- Editor preference (VS Code, Cursor, etc.)
    use-project-icon-query.ts   -- Project icon resolution
    use-providers-snapshot.ts   -- Provider snapshot prefetching
    use-push-token-registration.ts -- Push notification token
    use-recent-paths.ts         -- Recently opened paths
    use-session-directory.ts    -- Session directory access
    use-settings.ts             -- App settings (theme, daemon management, send behavior)
    use-shortcut-keys.ts        -- Shortcut key resolution
    use-show-shortcut-badges.ts
    use-sidebar-agent-sections.ts
    use-sidebar-shortcut-model.ts -- Sidebar shortcuts
    use-sidebar-workspaces-list.ts -- Workspace list for sidebar
    use-stable-event.ts
    use-theme-color.ts
    use-workspace-navigation.ts

  keyboard/
    actions.ts                  -- All keyboard action IDs
    focus-scope.ts              -- Focus scope management
    keyboard-action-dispatcher.ts -- Action dispatching
    keyboard-shortcut-routing.ts -- Shortcut routing
    keyboard-shortcuts.ts       -- Shortcut definitions
    shortcut-string.ts          -- Shortcut label formatting

  lib/
    overlay-root.ts             -- Overlay root management

  panels/
    agent-panel.tsx             -- Agent tab panel
    draft-panel.tsx             -- Draft (new agent) tab panel
    file-panel.tsx              -- File viewer tab panel
    pane-context.tsx            -- Pane context provider
    panel-registry.ts           -- Panel type registry
    register-panels.ts          -- Panel registration (agent, draft, terminal, file)
    terminal-panel.tsx          -- Terminal tab panel

  polyfills/                    -- crypto, screen-orientation

  query/
    query-client.ts             -- React Query client

  runtime/
    activity/                   -- Agent activity coalescing and scheduling
    host-runtime.ts             -- Host runtime store (connections, clients, agent directory)

  screens/
    agent/
      agent-ready-screen-bottom-anchor.ts
      draft-agent-screen.tsx    -- New agent creation screen
    open-project-screen.tsx     -- Open project/directory screen
    sessions-screen.tsx         -- All sessions list screen
    settings-screen.tsx         -- Full settings screen
    settings/
      keyboard-shortcuts-section.tsx
    startup-splash-screen.tsx   -- Boot splash screen
    workspace/
      use-mounted-tab-set.ts
      use-workspace-tab-layout.ts
      workspace-agent-visibility.ts
      workspace-bulk-close.ts   -- Bulk tab closing
      workspace-desktop-tabs-row.tsx -- Desktop tab bar
      workspace-draft-agent-tab.tsx
      workspace-draft-pane-focus.ts
      workspace-git-actions.tsx -- Git actions in workspace header
      workspace-header-source.ts
      workspace-open-in-editor-button.tsx -- "Open in editor" button
      workspace-pane-content.tsx
      workspace-pane-state.ts
      workspace-screen.tsx      -- Main workspace screen (tabs, panes, headers)
      workspace-source-of-truth.ts
      workspace-tab-layout.ts
      workspace-tab-menu.ts     -- Tab context menu entries
      workspace-tab-model.ts
      workspace-tab-presentation.tsx
      workspace-tabs-types.ts

  stores/
    checkout-git-actions-store.ts  -- Git action execution state
    create-flow-store.ts        -- Agent creation flow state
    download-store.ts           -- File download state
    draft-keys.ts               -- Draft ID generation
    draft-store.ts              -- Draft persistence (text, images, lifecycle)
    explorer-tab-memory.ts      -- Explorer tab recall per checkout
    keyboard-shortcuts-store.ts -- Custom shortcut overrides
    navigation-active-workspace-store.ts
    panel-store.ts              -- Panel visibility state (mobile/desktop)
    section-order-store.ts      -- Sidebar section ordering
    session-store.ts            -- Agent, workspace, terminal, file explorer state
    sidebar-collapsed-sections-store.ts
    sidebar-order-store.ts
    workspace-layout-actions.ts
    workspace-layout-store.ts   -- Workspace layout persistence
    workspace-tabs-store.ts     -- Workspace tab state (agent, terminal, file, draft)

  styles/
    markdown-styles.ts          -- Markdown rendering styles
    settings.ts                 -- Settings screen styles
    theme.ts                    -- Theme definitions (dark, zinc, midnight, claude, ghostty, light)
    unistyles.ts                -- Unistyles registration

  terminal/
    hooks/
      use-workspace-terminal-session-retention.ts
    runtime/
      terminal-emulator-runtime.ts  -- xterm.js runtime wrapper
      terminal-snapshot.ts      -- Terminal state snapshotting
      terminal-stream-controller.ts -- Terminal WebSocket stream
      workspace-terminal-session.ts -- Terminal session lifecycle

  types/
    agent-activity.ts
    agent-directory.ts          -- Agent directory entry type
    host-connection.ts          -- HostProfile, HostConnection types
    shared.ts                   -- PendingPermission, common types
    stream.ts                   -- StreamItem types (user_message, assistant_message, thought, tool_call, todo_list, activity_log, compaction)

  utils/                        -- ~80 utility modules (see file tree above)
  voice/
    audio-engine-types.ts       -- Audio engine interface
    audio-engine.native.ts      -- Native audio engine
    audio-engine.web.ts         -- Web audio engine
    realtime-voice-config.ts    -- Voice configuration
    voice-runtime.ts            -- Voice runtime state machine
```

### 2. Routing and Navigation

**Route structure (Expo Router, file-system based):**

| Route | Screen | Purpose |
|-------|--------|---------|
| `/` | `index.tsx` | Root redirect: if any host is online, redirect to that host's root; otherwise redirect to `/welcome` |
| `/welcome` | `WelcomeScreen` | Onboarding: connect to a daemon via QR scan, direct connection, or paste pairing link |
| `/settings` | Legacy redirect | Redirects to `/h/[serverId]/settings` for the first host |
| `/pair-scan` | `PairScanScreen` | Camera-based QR code scanning (native only; web shows unsupported message) |
| `/h/[serverId]` | `HostIndexRoute` | Host root: redirects to the most recent workspace or open-project screen |
| `/h/[serverId]/agent/[agentId]` | `HostAgentReadyRoute` | Agent detail: resolves agent's cwd, redirects to workspace with agent tab |
| `/h/[serverId]/open-project` | `OpenProjectScreen` | Directory picker to open a workspace |
| `/h/[serverId]/sessions` | `SessionsScreen` | Lists all sessions (agents) for this host, sorted by creation date |
| `/h/[serverId]/settings` | `SettingsScreen` | Full settings screen for this host |
| `/h/[serverId]/workspace/[workspaceId]` | `WorkspaceScreen` | Main workspace view with tabs, panes, headers |

**Navigation patterns:**
- All host routes are wrapped in `HostRouteBootstrapBoundary` which ensures the host runtime is connected before rendering.
- Workspace routes accept `?open=agent:<id>`, `?open=terminal:<id>`, `?open=file:<path>`, `?open=draft:<id>` query params to deep-link into specific tabs.
- The root `_layout.tsx` wraps everything in a deep provider hierarchy: `GestureHandlerRootView > PortalProvider > SafeAreaProvider > KeyboardProvider > QueryProvider > BottomSheetModalProvider > HostRuntimeBootstrapProvider > ProvidersWrapper > SidebarAnimationProvider > HorizontalScrollProvider > ToastProvider > AppWithSidebar > RootStack`.

### 3. Host/Session Model

**Host profile (`HostProfile`):**
- `serverId`: unique daemon identifier
- Connections array, each of type `HostConnection`:
  - `directTcp`: hostname:port
  - `directSocket`: Unix domain socket path
  - `directPipe`: Windows named pipe
  - `relay`: relay endpoint + daemon public key (base64)

**Connection lifecycle:**
1. On bootstrap, the `HostRuntimeStore` loads saved host profiles from AsyncStorage.
2. For desktop (Electron), the store manages a local daemon: starts it, connects via local socket/pipe transport.
3. For each host, the store creates a `DaemonClient` (WebSocket-based).
4. Connection selection probes all available connection candidates and selects the best one (`selectBestConnection`).
5. Once connected, the store polls the agent directory and manages reconnection.

**Session state (`SessionStore`):**
- Per-serverId session state containing:
  - `agents`: Map of `Agent` objects (id, provider, status, cwd, model, modes, permissions, attention, labels, persistence, usage)
  - `workspaces`: Map of `WorkspaceDescriptor` (project path, project kind, workspace kind)
  - `terminals`: Map of terminal entries
  - `fileExplorerStates`: per-workspace file explorer state
  - `serverInfo`: daemon server info and capabilities
  - `agentStreams`: per-agent stream item arrays and metadata
  - `agentLastSyncTimestamps`: for history revalidation

**Core workspace model:** A workspace corresponds to a project directory. Within each workspace, the user manages tabs of four kinds: agent, terminal, file, and draft. On desktop, tabs can be arranged across split panes (horizontal and vertical splits). This is the IDE-like layout at the center of the app.

**Agent lifecycle statuses:** initializing, idle, running, error, closed

**Agent properties:**
- `provider`: AgentProvider (claude, codex, copilot, opencode, pi)
- `currentModeId` + `availableModes`: provider-specific operational modes
- `capabilities`: AgentCapabilityFlags
- `pendingPermissions`: permission requests awaiting approval
- `persistence`: persistence handle for long-running agents
- `requiresAttention` + `attentionReason`: finished, error, or permission
- `archivedAt`: soft-delete timestamp
- `labels`: key-value metadata
- `projectPlacement`: workspace/checkout information

### 4. Agent Views

**Agent stream view (`AgentStreamView`):**
- Renders a scrollable timeline of `StreamItem`s:
  - `user_message`: User messages with optional image attachments
  - `assistant_message`: Assistant text with Markdown rendering
  - `thought`: Reasoning/thinking blocks with loading state
  - `tool_call`: Tool call cards with shimmer animation when executing, expandable details
  - `todo_list`: Checklist/plan cards
  - `activity_log`: System messages (info, success, error, system)
  - `compaction`: Context compaction markers (scissors icon)
- Supports virtual scrolling on web (`agent-stream-web-virtualization.ts`).
- Auto-scrolls to bottom on new content with configurable anchor behavior.
- Tool calls display: name, icon resolution per tool type, arguments, results, status (executing/completed/failed). Expandable via bottom sheet or inline.
- Plan cards (`PlanCard`): structured plan display.
- Inline file path links: clickable, open files in workspace file pane.
- Assistant image rendering with metadata tracking and source resolution.
- Markdown rendering via `react-native-markdown-display` with custom code block styling, syntax highlighting hints, and list markers.
- Turn copy button: copies assistant message text.

**Artifact drawer:**
- Supports artifact types: markdown, diff, image, code.
- Modal overlay for viewing artifacts.

**Agent status bar:**
- Shows provider, model name, thinking mode, status, model loading progress.
- Context window meter: circular progress indicator showing token usage vs. max.

**Agent list / sidebar:**
- Groups agents by workspace/project.
- Shows status dots (color-coded), agent title, time ago.
- Supports archive/unarchive, drag-and-drop reordering.

### 5. Chat Interface

**Message composer (`AgentInputArea` + `MessageInput`):**
- Multi-line text input with dynamic height.
- Placeholder text adapts: desktop shows "Message the agent, tag @files, or use /commands and /skills"; mobile shows "Message, @files, /commands".
- Image attachment support: paste from clipboard, pick from gallery (native), drag-and-drop (web). Preview thumbnails with remove.
- `@file` autocomplete: mentions files from the workspace file tree.
- `/command` and `/skill` autocomplete: queries available commands from the daemon.
- Send behavior: configurable "interrupt" (send immediately even if agent is running) or "queue" (queue message for after current turn). Per-session setting.
- Submit button states: send arrow, stop square (while agent running), loading spinner.
- Keyboard shortcuts: Enter to send (configurable), Shift+Enter for newline.
- Dictation integration: one-way speech-to-text -- microphone button, push-to-talk, speech is transcribed into the composer text field, auto-send on dictation end.
- Realtime voice mode: bidirectional audio conversation -- user speaks, agent responds with TTS. The voice runtime state machine progresses through phases: disabled, starting, listening, submitting, waiting, playing, stopping.
- Draft persistence: drafts auto-saved to `DraftStore` (AsyncStorage), survives app restart. Lifecycle states: active, sent, abandoned.
- Message queue: messages queued while agent is running, sent in order after turn completes.

**Message types rendered:**
- `UserMessage`: right-aligned bubble with text and optional images.
- `AssistantMessage`: left-aligned Markdown-rendered text.
- `ActivityLog`: system messages with icons (info, success, error, warning).
- `ToolCall`: collapsible tool execution card with status, arguments, result preview.
- `TodoListCard`: checklist with completion state.
- `CompactionMarker`: visual divider indicating context compaction.
- `SpeakMessage`: voice response display.
- `PlanCard`: structured plan with steps.
- `QuestionFormCard`: structured form that agents can present for user input.

### 6. Settings Surface

**Settings sections (per-host):**

| Section | Platform | Contents |
|---------|----------|----------|
| **Hosts** | All | List of connected hosts, connection type (relay/TCP/socket/pipe), status, add/edit/remove hosts. Each host shows serverId, hostname, connections, active connection badge. |
| **General** | All | Theme selector (dark, zinc, midnight, claude, ghostty, light, auto), send behavior (interrupt vs queue), manage built-in daemon toggle. |
| **Permissions** | All | Desktop permission management for notifications and microphone. |
| **Shortcuts** | Desktop | Keyboard shortcut customization. |
| **Integrations** | Desktop | CLI installation status and install button, Skills installation status and install button. Links to docs. |
| **Pair device** | Desktop | QR code and pairing link for connecting mobile devices to the daemon. |
| **Daemon** | Desktop | Local daemon management, restart, logs. |
| **Providers** | Desktop | Provider health status (claude, codex, copilot, opencode, pi), diagnostic sheets per provider. |
| **Diagnostics** | All | Debug information. |
| **About** | All | App version, links. |

**Theme system:**
- 6 named themes + auto (system): dark, zinc, midnight, claude, ghostty, light.
- Theme cycle via keyboard shortcut.
- Desktop window controls overlay color synced with theme.
- Unistyles-based responsive theming with breakpoints.

### 7. State Management

**Store architecture (Zustand):**

| Store | Purpose | Persistence |
|-------|---------|-------------|
| `session-store` | Agent state, workspaces, terminals, file explorers, server info, agent streams | In-memory (hydrated from daemon) |
| `panel-store` | Sidebar visibility, explorer state, mobile/desktop panel state | AsyncStorage (persisted) |
| `draft-store` | Draft message text and images per agent/draft | AsyncStorage (persisted, versioned) |
| `workspace-layout-store` | Workspace tab layout, active tabs, split pane configuration | AsyncStorage (persisted) |
| `workspace-tabs-store` | Tab definitions (agent, terminal, file, draft) | AsyncStorage (persisted) |
| `create-flow-store` | Agent creation flow state | In-memory |
| `download-store` | File download progress | In-memory |
| `keyboard-shortcuts-store` | Custom shortcut overrides | AsyncStorage (persisted) |
| `checkout-git-actions-store` | Git action execution state per checkout | In-memory |
| `navigation-active-workspace-store` | Currently active workspace for navigation sync | In-memory |
| `section-order-store` | Sidebar section ordering | AsyncStorage (persisted) |
| `sidebar-collapsed-sections-store` | Collapsed sidebar sections | AsyncStorage (persisted) |
| `sidebar-order-store` | Sidebar workspace ordering | AsyncStorage (persisted) |
| `explorer-tab-memory` | Explorer tab (files/changes) per checkout | AsyncStorage (persisted) |

**React Query:** Used for server-derived data (settings, providers, checkout status, diff data, branch list, terminals, project icons, agent commands).

**Context providers:**
- `SessionProvider`: per-host session lifecycle, stream event processing, voice audio routing, push token registration.
- `VoiceProvider`: voice runtime lifecycle, mute state, active voice session.
- `ToastProvider`: toast notification queue.
- `SidebarAnimationProvider`: sidebar open/close animation state (Reanimated shared values).
- `HorizontalScrollProvider`: tracks horizontal scroll state for gesture arbitration.
- `ExplorerSidebarAnimationProvider`: explorer sidebar animation.

### 8. Service Layer

**Daemon communication:**
- `DaemonClient` from `@server/client/daemon-client`: WebSocket-based bidirectional communication.
- Transport types:
  1. **Direct TCP**: `ws://host:port/ws`
  2. **Unix Socket**: `ws+unix://path:/ws`
  3. **Named Pipe**: `ws://localhost/ws` with `socketPath` (Windows)
  4. **Relay**: `wss://relay.endpoint/ws` with daemon public key for authenticated relay
- Desktop local daemon transport: Electron IPC bridge for socket/pipe communication without raw WebSocket.
- Client operations (derived from session-context and hooks):
  - `fetchAgents()`, `fetchAgent(id)`, `fetchAgentTimeline(id)`
  - `createAgent()`, `sendMessage()`, `stopAgent()`, `deleteAgent()`, `archiveAgent()`
  - `setAgentMode()`, `reloadAgent()`, `updateAgent()`
  - `respondToPermission()` (allow/deny)
  - `fetchCheckoutStatus()`, `fetchCheckoutDiff()`, `switchBranch()`
  - `fetchTerminals()`, `createTerminal()`, `killTerminal()`
  - `fetchFileExplorer()`, `readFile()`, `downloadFile()`
  - `openProject()`, `fetchWorkspaces()`
  - `fetchProviders()`, `fetchProviderModels()`
  - `fetchDaemonConfig()`, `fetchServerInfo()`
  - Voice: `setVoiceMode()`, `sendVoiceAudioChunk()`, `audioPlayed()`, `abortRequest()`
  - Git: `gitCommit()`, `gitPush()`, `gitPull()`, `gitCreatePr()`, `gitMergeBranch()`, `gitMergeFromBase()`, `archiveWorktree()`
  - `openInEditor()` (opens workspace in preferred editor)
  - Agent stream subscription (real-time SSE events)

### 9. Mobile/Desktop Behavior

**Layout:**
- `useIsCompactFormFactor()`: breakpoint-based detection (not just platform).
- Compact (mobile): single-panel view with overlay sidebars. Only one panel visible at a time: agent view, agent list (left overlay), or file explorer (right overlay).
- Desktop: persistent sidebars alongside main content. Both sidebars can be open simultaneously.
- Desktop supports split panes (`SplitContainer`): divide workspace into multiple panes, each showing a different tab.
- Focus mode: hides both sidebars for distraction-free view.

**Mobile-specific:**
- Gesture-based sidebar open (swipe right from left edge).
- Gesture arbitration with horizontal scroll.
- Mobile tab switcher: combobox dropdown instead of tab bar.
- `MobileGestureWrapper` wraps the entire app container.
- Camera-based QR scanning for pairing (native only).

**Desktop-specific:**
- Electron titlebar drag region.
- Window controls overlay color sync with theme.
- Resizable sidebars (draggable splitters, min/max widths).
- Desktop tab row with drag-and-drop tab reordering.
- Split pane support: vertical and horizontal splits, tab-to-pane dropping.
- Keyboard shortcuts visible as badges on buttons.
- Auto-update banner and installation.
- CLI and Skills installation from settings.
- Device pairing (generate QR/link for mobile).
- Local daemon management (start, stop, restart).

**Web-specific:**
- Browser favicon badge showing attention state.
- Web notification API integration.
- IndexedDB attachment store.
- Custom scrollbar rendering.
- Document title sync with active workspace.
- URL state management (clean `?open` params from browser URL after consumption).

### 10. Notifications and Attention

**Attention model:**
- Agents can `requireAttention` with reasons: `finished`, `error`, `permission`.
- Attention is cleared on: focus entry, input focus, prompt send.
- Permission-required attention is not auto-cleared.

**Notification channels:**
1. **Push notifications (native)**: `expo-notifications` for iOS/Android. Token registered with daemon. Suppressed when app is in foreground.
2. **Desktop notifications (Electron)**: Electron notification API via host bridge.
3. **Web notifications**: `Notification` API with permission request.
4. **In-app**: Status dots on agent list, favicon badge, attention indicators in sidebar.

**Notification routing:**
- Tapping a notification navigates to the relevant agent within its workspace.
- Payload contains `serverId`, `agentId`, `workspaceId`/`cwd`.
- Routes built by `buildNotificationRoute()`: prioritizes workspace route with agent tab if cwd is known.

**Favicon status sync:**
- `useFaviconStatus()`: updates browser favicon to indicate agent attention state.

**Desktop badge state:**
- `packages/app/src/utils/desktop-badge-state.ts`: computes badge state from agent attention across all hosts.

---

## CLI Section

### 11. Command Inventory

**Global options (all commands):**
- `-o, --format <format>`: output format: table, json, yaml (default: table)
- `--json`: alias for `--format json`
- `-q, --quiet`: minimal output (IDs only)
- `--no-headers`: omit table headers
- `--no-color`: disable colored output
- `-v, --version`: version number
- `-h, --help`: help text

**Per-command daemon host option:** Most commands accept `--host <address>` to target a specific daemon instead of the default. This is added via `addDaemonHostOption` and is available on all agent, chat, terminal, loop, schedule, permit, provider, and worktree commands.

**Top-level agent aliases (also available as `paseo agent <cmd>`):**

| Command | Description | Key Flags |
|---------|-------------|-----------|
| `paseo ls` | List agents (excludes archived by default) | `-a/--all` (include archived), `--label <key=value>`, `--thinking <id>` |
| `paseo run <prompt>` | Create and start an agent | `-d/--detach`, `--title`, `--provider` (default: claude), `--model`, `--thinking`, `--mode`, `--worktree <name>`, `--base <branch>`, `--image <path>` (repeatable), `--cwd`, `--label <key=value>` (repeatable), `--wait-timeout <duration>`, `--output-schema <file-or-json>` |
| `paseo attach <id>` | Attach to running agent's output stream | |
| `paseo logs <id>` | Stream agent logs | |
| `paseo stop <id>` | Stop a running agent | |
| `paseo delete <id>` | Delete an agent | |
| `paseo send <id> <message>` | Send a message to an agent | |
| `paseo inspect <id>` | Inspect agent details | |
| `paseo wait <id>` | Wait for an agent to reach a terminal state | |
| `paseo archive <id>` | Archive an agent | |

**Top-level daemon aliases:**

| Command | Description | Key Flags |
|---------|-------------|-----------|
| `paseo start` | Start the local daemon | `--listen`, `--port`, `--home`, `--no-relay`, `--no-mcp`, `--allowed-hosts` |
| `paseo status` | Show local daemon status | `--home` |
| `paseo restart` | Restart local daemon | `--home`, `--timeout`, `--force`, `--listen`, `--port`, `--no-relay`, `--no-mcp`, `--allowed-hosts` |
| `paseo onboard` | First-time setup wizard | `--listen`, `--port`, `--home`, `--no-relay`, `--no-mcp`, `--allowed-hosts`, `--timeout`, `--voice <ask\|enable\|disable>` |

**`paseo agent` subcommands (advanced):**

| Command | Description | Key Flags |
|---------|-------------|-----------|
| `agent mode <id> [mode]` | Change agent's operational mode | `--list` (list available modes) |
| `agent archive <id>` | Archive agent | |
| `agent reload <id>` | Reload agent configuration | |
| `agent update <id>` | Update agent metadata | `--name`, `--label` (repeatable) |

**`paseo daemon` subcommands:**

| Command | Description | Key Flags |
|---------|-------------|-----------|
| `daemon start` | Start the local daemon | `--listen`, `--port`, `--home`, `--no-relay`, `--no-mcp`, `--no-inject-mcp`, `--allowed-hosts` |
| `daemon status` | Show daemon status | `--home` |
| `daemon stop` | Stop the daemon | `--home`, `--timeout`, `--force` |
| `daemon restart` | Restart the daemon | `--home`, `--timeout`, `--force`, `--listen`, `--port`, `--no-relay`, `--no-mcp`, `--no-inject-mcp`, `--allowed-hosts` |
| `daemon pair` | Print pairing QR code and link | `--home`, `--json` |

**`paseo chat` subcommands:**

| Command | Description | Key Flags |
|---------|-------------|-----------|
| `chat create <name>` | Create a chat room | `--purpose` |
| `chat ls` | List chat rooms | |
| `chat inspect <name-or-id>` | Inspect a chat room | |
| `chat delete <name-or-id>` | Delete a chat room | |
| `chat post <name-or-id> <message>` | Post a message | `--reply-to <msg-id>` |
| `chat read <name-or-id>` | Read messages | `--limit`, `--since`, `--agent` |
| `chat wait <name-or-id>` | Wait for new messages | `--timeout` |

**`paseo terminal` subcommands:**

| Command | Description | Key Flags |
|---------|-------------|-----------|
| `terminal ls` | List terminals | `--all`, `--cwd` |
| `terminal create` | Create a terminal | `--cwd`, `--name` |
| `terminal kill <id>` | Kill a terminal | |
| `terminal capture <id>` | Capture terminal output | `--start`, `--end`, `-S/--scrollback`, `--ansi`, `--json` |
| `terminal send-keys <id> <keys...>` | Send keys to terminal | `-l/--literal`, `--json` |

**`paseo loop` subcommands:**

| Command | Description | Key Flags |
|---------|-------------|-----------|
| `loop run <prompt>` | Start a worker loop | `--provider`, `--model`, `--verify-provider`, `--verify-model`, `--verify <prompt>`, `--verify-check <command>` (repeatable), `--archive`, `--name`, `--sleep`, `--max-iterations`, `--max-time` |
| `loop ls` | List running loops | |
| `loop inspect <id>` | Inspect a loop | |
| `loop logs <id>` | Show loop logs | |
| `loop stop <id>` | Stop a loop | |

**`paseo schedule` subcommands:**

| Command | Description | Key Flags |
|---------|-------------|-----------|
| `schedule create <prompt>` | Create a schedule | `--every`, `--cron`, `--name`, `--target <self\|new-agent\|agent-id>`, `--provider`, `--max-runs`, `--expires-in` |
| `schedule ls` | List schedules | |
| `schedule inspect <id>` | Inspect a schedule | |
| `schedule logs <id>` | Show schedule run logs | |
| `schedule pause <id>` | Pause a schedule | |
| `schedule resume <id>` | Resume a paused schedule | |
| `schedule delete <id>` | Delete a schedule | |

**`paseo permit` subcommands:**

| Command | Description | Key Flags |
|---------|-------------|-----------|
| `permit ls` | List pending permissions | |
| `permit allow <agent> [req_id]` | Allow a permission | `--all`, `--input <json>` |
| `permit deny <agent> [req_id]` | Deny a permission | `--all`, `--message`, `--interrupt` |

**`paseo provider` subcommands:**

| Command | Description | Key Flags |
|---------|-------------|-----------|
| `provider ls` | List available providers and status | |
| `provider models <provider>` | List models for a provider | `--thinking` |

**`paseo worktree` subcommands:**

| Command | Description | Key Flags |
|---------|-------------|-----------|
| `worktree ls` | List Paseo-managed git worktrees | |
| `worktree archive <name>` | Archive a worktree (removes worktree and branch) | |

**`paseo speech`:** Stub command group with no subcommands (placeholder).

**`paseo <directory-path>`:** Opens the desktop app with that project (detected via `classify.ts`; if the first argument is an existing directory and not a known command, it launches the desktop app).

### 12. Daemon Communication

**Transport:** The CLI connects to the daemon via the same `DaemonClient` WebSocket protocol as the app.

**Connection resolution order:**
1. Explicit `--host` option or `PASEO_HOST` environment variable.
2. IPC socket/pipe from `PASEO_LISTEN` env var or `paseo.pid` file.
3. Config file (`~/.paseo/config.json`) listen address.
4. Default: `localhost:6767`.

**WebSocket factory:** Node.js `ws` library with custom headers and optional `socketPath` for IPC.

**Client ID:** Persistent CLI client ID stored at `~/.paseo/cli-client-id` (or `<PASEO_HOME>/cli-client-id`).

**Agent resolution:** Supports full ID, prefix match, title match (case-insensitive), and partial title match.

### 13. Interactive Features

**`paseo onboard`:**
- Full interactive wizard using `@clack/prompts`.
- Steps: intro, resolve Paseo home, voice setup prompt (confirm dialog), start daemon, wait for readiness (spinner with download progress), generate pairing QR, print next steps.
- Non-interactive fallback: skips prompts, defaults voice to disabled.

**`paseo attach <id>`:**
- Streams agent timeline in real-time.
- Prints: assistant messages (raw text to stdout), reasoning blocks, tool call status, todo progress, errors, user messages, permission requests, status changes.
- Runs until agent reaches a terminal state.

**`paseo run <prompt>` (non-detached):**
- Creates agent and attaches to its output stream.
- Supports `--wait-timeout` for maximum wait time.
- Supports `--output-schema` for structured JSON output extraction.
- Structured response: extracts and validates JSON from agent's last message using schema.

**`paseo daemon pair`:**
- Generates and prints QR code and pairing link.
- Supports `--json` output.

### 14. Output Formatting

**Output system (`packages/cli/src/output/`):**

| Module | Purpose |
|--------|---------|
| `with-output.ts` | Command wrapper for automatic output rendering |
| `render.ts` | Format dispatcher (table, json, yaml) |
| `table.ts` | Terminal table rendering with column alignment, optional color |
| `json.ts` | JSON output with pretty-printing |
| `yaml.ts` | YAML output |
| `quiet.ts` | Minimal output (IDs only) |
| `types.ts` | Output schema types, result types (SingleResult, ListResult, StreamResult) |

**Result types:**
- `SingleResult<T>`: single item output with schema
- `ListResult<T>`: list output with schema (used by ls commands)
- `StreamResult`: streaming output
- `CommandError`: structured error output (code, message, details)

**Output options normalization:**
- `--json` overrides format to json.
- `--output-schema` forces json format and non-quiet mode.
- Table format supports colored columns (e.g., agent status: green for running, yellow for idle, red for error).
- `--no-headers` removes table header row.
- `--no-color` disables ANSI colors.
