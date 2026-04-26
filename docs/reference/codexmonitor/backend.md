# CodexMonitor Tauri Backend -- Exhaustive Source-Code Exploration

> Produced by source-code reading of `/home/sabossedgh/dev/external/CodexMonitor/src-tauri/`.
> Version 0.7.68. Every Rust module, every Tauri command, and every Codex integration detail documented below.

---

## 1. Directory Structure

```
src-tauri/
  Cargo.toml
  Cargo.lock
  build.rs
  tauri.conf.json
  tauri.ios.conf.json
  tauri.linux.conf.json
  tauri.windows.conf.json
  Entitlements.plist
  Info.plist
  capabilities/default.json
  icons/                          # App icons (macOS, Windows, iOS, Android, tray)
  gen/apple/                      # Generated Xcode project for iOS
  tests/tauri_config.rs
  src/
    main.rs                       # Desktop entry point (fix-path-env + run())
    lib.rs                        # Tauri app setup, command registration, plugin config
    state.rs                      # AppState struct (central managed state)
    types.rs                      # All shared Rust types (~600 lines)
    storage.rs                    # JSON file persistence (workspaces.json, settings.json)
    event_sink.rs                 # TauriEventSink (EventSink impl for Tauri)
    utils.rs
    tray.rs                       # System tray icon management
    menu.rs / menu_mobile.rs      # App menu (desktop / mobile stubs)
    window.rs                     # Window appearance utilities
    notifications.rs              # Notification fallback helpers
    daemon_binary.rs              # Daemon binary path resolution
    git_utils.rs                  # Git root resolution helpers
    rules.rs                      # Codex approval rules file management
    local_usage.rs                # Token usage snapshot command
    backend/
      mod.rs
      app_server.rs               # WorkspaceSession -- spawn & manage `codex app-server`
      events.rs                   # EventSink trait, AppServerEvent, TerminalOutput/Exit
    codex/
      mod.rs                      # All Codex-related Tauri commands (thread, turn, agent, model, etc.)
      args.rs                     # Codex CLI argument parsing (shell_words)
      config.rs                   # config.toml feature flag read/write (steer, collab, unified_exec, apps, personality)
      home.rs                     # CODEX_HOME resolution (~/.codex, $CODEX_HOME, tilde/env expansion)
    shared/
      mod.rs                      # Module declarations for all shared cores
      codex_core.rs               # Core thread/turn/review/model/account/login/skills/apps logic
      codex_aux_core.rs           # Background prompt runner, commit message gen, run metadata gen, agent description gen
      codex_update_core.rs        # Codex CLI update helper
      agents_config_core.rs       # Multi-agent CRUD (create/update/delete agents in config.toml + managed TOML files)
      config_toml_core.rs         # TOML document manipulation (load/save/ensure_table/feature_flags)
      files_core.rs               # Scoped file read/write core (AGENTS.md, config.toml)
      git_core.rs                 # Low-level git2 operations
      git_rpc.rs                  # Git RPC request/method types for daemon bridging
      git_ui_core.rs              # Git UI core (mod.rs imports sub-modules)
      git_ui_core/
        commands.rs               # git status/diff/log/stage/commit/push/pull/fetch/sync via git2
        context.rs                # Git context resolution
        diff.rs                   # Diff generation (text + binary + image diffs)
        github.rs                 # GitHub integration via `gh` CLI
        log.rs                    # Git log with ahead/behind
        tests.rs
      local_usage_core.rs         # Token usage aggregation from CODEX_HOME logs
      process_core.rs             # Process utilities (kill_child_process_tree, tokio_command)
      prompts_core.rs             # Prompt library CRUD (markdown files with YAML frontmatter)
      settings_core.rs            # Settings get/update core
      account.rs                  # Auth account reading from CODEX_HOME
      workspace_rpc.rs            # Workspace RPC request types for daemon bridging
      workspaces_core.rs          # Workspace core (mod.rs imports sub-modules)
      workspaces_core/
        connect.rs                # Workspace connection lifecycle
        crud_persistence.rs       # Workspace add/remove/update persistence
        git_orchestration.rs      # Worktree git orchestration
        helpers.rs                # Workspace helper utilities
        io.rs                     # Workspace file listing
        runtime_codex_args.rs     # Runtime Codex args management
        worktree.rs               # Worktree creation/rename/removal
      worktree_core.rs            # Worktree path resolution helpers
    remote_backend/
      mod.rs                      # RemoteBackend client, is_remote_mode, call_remote, retry logic
      protocol.rs                 # Line-delimited JSON-RPC protocol (build_request_line, parse_incoming_line)
      tcp_transport.rs            # TcpTransport (TcpStream connection)
      transport.rs                # Transport abstraction (PendingMap, spawn_transport_io, read_loop)
    git/
      mod.rs                      # All Git Tauri commands (30+ commands)
    files/
      mod.rs                      # File Tauri commands (file_read, file_write, read_image_as_data_url, write_text_file)
      io.rs                       # TextFileResponse type, raw read/write
      ops.rs                      # Policy-based read/write operations
      policy.rs                   # FileScope (Workspace|Global) x FileKind (Agents|Config) policies
    workspaces/
      mod.rs
      commands.rs                 # All Workspace Tauri commands (20+ commands)
      files.rs                    # Workspace file listing & preview (uses `ignore` crate for .gitignore)
      git.rs                      # Workspace-level git helpers (git2 + CLI)
      macos.rs                    # macOS app icon resolution for "Open in..."
      settings.rs                 # Workspace settings update logic
      worktree.rs                 # Worktree path sanitization and uniqueness
      tests.rs
    settings/
      mod.rs                      # Settings Tauri commands (get_app_settings, update_app_settings, get_codex_config_path)
    prompts.rs                    # Prompt Tauri commands (list, create, update, delete, move, workspace_dir, global_dir)
    terminal.rs                   # Terminal Tauri commands (open, write, resize, close) -- uses portable-pty
    terminal_mobile.rs            # Mobile terminal stubs
    dictation/
      mod.rs                      # Conditional compilation: real.rs (desktop) / stub.rs (mobile)
      real.rs                     # Whisper-based dictation (cpal audio + whisper-rs)
      stub.rs                     # No-op stubs for iOS/Android
    tailscale/
      mod.rs                      # Tailscale status detection + daemon management
      core.rs                     # Tailscale JSON status parsing
      daemon_commands.rs          # Daemon start/stop/status commands
      rpc_client.rs               # TCP RPC client for daemon probing
    bin/
      codex_monitor_daemon.rs     # Standalone daemon binary (TCP JSON-RPC server)
      codex_monitor_daemonctl.rs  # CLI daemon management tool (start/stop/status/command-preview)
      codex_monitor_daemon/
        rpc.rs                    # RPC module imports
        rpc/
          dispatcher.rs           # Central RPC dispatcher (routes to domain handlers)
          codex.rs                # Codex RPC handlers
          daemon.rs               # Daemon meta-RPC handlers (auth, ping)
          git.rs                  # Git RPC handlers
          prompts.rs              # Prompts RPC handlers
          workspace.rs            # Workspace RPC handlers
        transport.rs              # Daemon TCP transport (accept, read/write loops)
```

---

## 2. Dependencies and Build

### Cargo.toml Key Dependencies

| Crate | Version | Purpose |
|---|---|---|
| `tauri` | 2.10.3 | App framework (protocol-asset, macos-private-api, tray-icon, image-png) |
| `tauri-plugin-liquid-glass` | 0.1 | macOS vibrancy/transparency |
| `tauri-plugin-notification` | 2 | System notifications |
| `tauri-plugin-opener` | 2 | File/URL opener |
| `tauri-plugin-process` | 2 | Process info |
| `tauri-plugin-dialog` | 2 | Native dialogs |
| `tauri-plugin-updater` | 2.10.0 | In-app auto-update (desktop only) |
| `tauri-plugin-window-state` | 2 | Window state persistence (desktop only) |
| `tokio` | 1 | Async runtime (fs, net, io-util, process, rt, sync, time) |
| `tokio-tungstenite` | 0.24 | WebSocket (rustls-tls) -- vestigial dependency, no usage in source files |
| `serde` / `serde_json` | 1 | Serialization |
| `git2` | 0.20.3 | Native git operations (vendored openssl+libgit2) |
| `ignore` | 0.4.25 | .gitignore-aware file walking |
| `reqwest` | 0.12 | HTTP client (rustls-tls) |
| `uuid` | 1 | UUID v4 generation |
| `base64` | 0.22 | Image encoding |
| `chrono` | 0.4 | Date/time |
| `shell-words` | 1.1 | Shell argument parsing |
| `toml_edit` | 0.20.2 | TOML document editing (preserves formatting) |
| `fix-path-env` | git | Syncs PATH from user shell profile on macOS |
| `portable-pty` | 0.8 | PTY terminal backend (desktop only) |
| `cpal` | 0.15 | Audio capture for dictation (desktop only) |
| `whisper-rs` | 0.12 | Local Whisper speech-to-text (desktop only) |
| `sha2` | 0.10 | SHA-256 hashing (desktop only) |
| `libc` | 0.2 | Unix system calls |
| `futures-util` | 0.3 | Async stream utilities |

### macOS-Specific Dependencies
- `objc2`, `objc2-app-kit`, `objc2-foundation`, `objc2-av-foundation`, `block2` -- Native Cocoa interop for window appearance, audio permissions.

### Build Configuration
- `tauri.conf.json`: productName "Codex Monitor", identifier `com.dimillian.codexmonitor`, window 1200x700 min 360x600, titleBarStyle Overlay, transparent, dragDropEnabled, devtools enabled. Asset protocol enabled with `**/*` scope. CSP disabled. Auto-updater with GitHub releases endpoint.
- Platform configs: `tauri.linux.conf.json`, `tauri.windows.conf.json`, `tauri.ios.conf.json` for platform overrides.

### Binary Targets
- `codex-monitor` (default) -- the Tauri desktop app
- `codex_monitor_daemon` -- standalone TCP JSON-RPC server
- `codex_monitor_daemonctl` -- CLI tool for daemon management

---

## 3. App Setup and State

### Tauri App Initialization (lib.rs `run()`)

1. **Linux workarounds**: Sets `__NV_PRIME_RENDER_OFFLOAD=1`, `WEBKIT_DISABLE_DMABUF_RENDERER=1` (Wayland+NVIDIA), `WEBKIT_DISABLE_COMPOSITING_MODE=1` (X11).
2. **Builder configuration**:
   - Desktop: manages `MenuItemRegistry`, `TrayState`, registers menu event handler, disables default macOS menu, builds custom menu.
   - Window event: hides main window on close (macOS) instead of destroying.
3. **Setup**:
   - Loads `AppState` from disk (workspaces.json, settings.json).
   - macOS: initializes system tray.
   - Windows: removes decorations, hides native menu bar.
   - Desktop: spawns async task for daemon auto-start if remote mode + TCP provider.
   - iOS: configures edge-to-edge webview.
   - Desktop: installs updater plugin.
4. **Plugins**: liquid-glass, opener, dialog, process, notification, window-state (desktop).
5. **Command registration**: 120+ Tauri commands registered via `invoke_handler`.
6. **Exit handling**: On exit, stops managed daemons unless `keep_daemon_running_after_app_close` is set.
7. **Reopen handling** (macOS): Shows and focuses the main window.

### AppState (state.rs)

```rust
pub(crate) struct AppState {
    workspaces: Mutex<HashMap<String, WorkspaceEntry>>,
    sessions: Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    terminal_sessions: Mutex<HashMap<String, Arc<TerminalSession>>>,
    remote_backend: Mutex<Option<RemoteBackend>>,
    storage_path: PathBuf,          // workspaces.json
    settings_path: PathBuf,         // settings.json
    app_settings: Mutex<AppSettings>,
    dictation: Mutex<DictationState>,
    codex_login_cancels: Mutex<HashMap<String, CodexLoginCancelState>>,
    tcp_daemon: Mutex<TcpDaemonRuntime>,
}
```

Loaded from `app_data_dir()` on startup. Workspaces read from JSON, settings with migration support.

---

## 4. Tauri Command Inventory

### Settings & Config (3 commands)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `get_app_settings` | -- | `AppSettings` | Reads settings, applies window theme |
| `update_app_settings` | `settings: AppSettings` | `AppSettings` | Persists settings, resets remote backend if transport changed, ensures daemon runtime |
| `get_codex_config_path` | -- | `String` | Returns path to `$CODEX_HOME/config.toml` |

### File Operations (4 commands)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `file_read` | `scope: FileScope, kind: FileKind, workspace_id?: String` | `TextFileResponse` | Reads AGENTS.md or config.toml (global/workspace) |
| `file_write` | `scope, kind, workspace_id?, content: String` | `()` | Writes AGENTS.md or config.toml |
| `read_image_as_data_url` | `path: String` | `String` | Converts image to data URL (remote/mobile only). HEIC converted via sips on macOS. |
| `write_text_file` | `path: String, content: String` | `()` | Writes arbitrary text file (used for exports) |

### Codex Doctor & Update (2 commands)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `codex_doctor` | `codex_bin?, codex_args?` | `Value` (ok, version, appServerOk, nodeOk, etc.) | Health check: verifies codex CLI, app-server, Node.js |
| `codex_update` | `codex_bin?, codex_args?` | `Value` | Runs `codex update` |

### Thread Operations (10 commands)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `start_thread` | `workspace_id` | `Value` | Creates new thread via `thread/start` RPC |
| `resume_thread` | `workspace_id, thread_id` | `Value` | Resumes existing thread via `thread/resume` |
| `read_thread` | `workspace_id, thread_id` | `Value` | Reads thread data via `thread/read` |
| `thread_live_subscribe` | `workspace_id, thread_id` | `Value` | Subscribe to live thread events |
| `thread_live_unsubscribe` | `workspace_id, thread_id` | `Value` | Unsubscribe from live thread events |
| `fork_thread` | `workspace_id, thread_id` | `Value` | Forks thread via `thread/fork` |
| `list_threads` | `workspace_id, cursor?, limit?, sort_key?` | `Value` | Lists threads via `thread/list` (filters by sourceKinds) |
| `archive_thread` | `workspace_id, thread_id` | `Value` | Archives thread via `thread/archive` |
| `compact_thread` | `workspace_id, thread_id` | `Value` | Compacts thread via `thread/compact/start` |
| `set_thread_name` | `workspace_id, thread_id, name` | `Value` | Sets thread name via `thread/name/set` |

### Turn & Message Operations (5 commands)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `send_user_message` | `workspace_id, thread_id, text, model?, effort?, service_tier?, access_mode?, images?, app_mentions?, collaboration_mode?` | `Value` | Starts a turn via `turn/start`. Builds sandbox policy from access_mode. |
| `turn_steer` | `workspace_id, thread_id, turn_id, text, images?, app_mentions?` | `Value` | Steers active turn via `turn/steer` |
| `turn_interrupt` | `workspace_id, thread_id, turn_id` | `Value` | Interrupts turn via `turn/interrupt` |
| `start_review` | `workspace_id, thread_id, target, delivery?` | `Value` | Starts code review via `review/start` |
| `respond_to_server_request` | `workspace_id, request_id, result` | `()` | Responds to server approval/prompt via JSON-RPC response |

### AI Generation (3 commands)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `generate_commit_message` | `workspace_id, commit_message_model_id?` | `String` | Background prompt to Codex for git commit message |
| `generate_run_metadata` | `workspace_id, prompt` | `Value` (title, worktreeName) | Background prompt to generate title + worktree branch name |
| `generate_agent_description` | `workspace_id, description` | `GeneratedAgentConfiguration` | Background prompt to generate agent description + developer instructions |

### Model & Feature Operations (4 commands)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `model_list` | `workspace_id` | `Value` | Lists available models via `model/list` |
| `experimental_feature_list` | `workspace_id, cursor?, limit?` | `Value` | Lists experimental features via `experimentalFeature/list` |
| `set_codex_feature_flag` | `feature_key, enabled` | `()` | Writes feature flag to config.toml |
| `get_config_model` | `workspace_id` | `Value` | Reads configured model from config.toml |

### Account & Auth (4 commands)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `account_rate_limits` | `workspace_id` | `Value` | Reads rate limits via `account/rateLimits/read` |
| `account_read` | `workspace_id` | `Value` | Reads account info (session + fallback from auth file) |
| `codex_login` | `workspace_id` | `Value` (loginId, authUrl) | Starts ChatGPT login flow via `account/login/start` |
| `codex_login_cancel` | `workspace_id` | `Value` | Cancels pending login via `account/login/cancel` |

### Skills & Apps (2 commands)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `skills_list` | `workspace_id` | `Value` | Lists skills via `skills/list` (includes project .agents/skills) |
| `apps_list` | `workspace_id, cursor?, limit?, thread_id?` | `Value` | Lists apps via `app/list` |

### Collaboration (1 command)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `collaboration_mode_list` | `workspace_id` | `Value` | Lists collaboration modes via `collaborationMode/list` |

### Agent Configuration (7 commands)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `get_agents_settings` | -- | `AgentsSettingsDto` | Reads agents config (multi_agent enabled, max_threads, max_depth, agent list) |
| `set_agents_core_settings` | `input: SetAgentsCoreInput` | `AgentsSettingsDto` | Sets multi-agent enabled, max_threads (1-12), max_depth (1-4) |
| `create_agent` | `input: CreateAgentInput` | `AgentsSettingsDto` | Creates agent with template TOML file in managed agents dir |
| `update_agent` | `input: UpdateAgentInput` | `AgentsSettingsDto` | Updates agent (rename, description, developer_instructions) |
| `delete_agent` | `input: DeleteAgentInput` | `AgentsSettingsDto` | Deletes agent from config and optionally removes managed file |
| `read_agent_config_toml` | `agent_name` | `String` | Reads raw TOML content of managed agent config |
| `write_agent_config_toml` | `agent_name, content` | `()` | Writes raw TOML content to managed agent config |

### Approval Rules (1 command)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `remember_approval_rule` | `workspace_id, command: Vec<String>` | `Value` | Appends prefix_rule to `$CODEX_HOME/rules/default.rules` |

### MCP Server Status (1 command)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `list_mcp_server_status` | `workspace_id, cursor?, limit?` | `Value` | Lists MCP server statuses via `mcpServerStatus/list` |

### Workspace Operations (17 commands)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `list_workspaces` | -- | `Vec<WorkspaceInfo>` | Lists all workspaces with connection status |
| `is_workspace_path_dir` | `path` | `bool` | Checks if path is a directory |
| `add_workspace` | `path` | `WorkspaceInfo` | Adds workspace, auto-connects, persists to workspaces.json |
| `add_workspace_from_git_url` | `url, destination_path, target_folder_name?` | `WorkspaceInfo` | Clones git repo then adds as workspace |
| `add_clone` | `source_workspace_id, copy_name, copies_folder` | `WorkspaceInfo` | Creates workspace clone |
| `add_worktree` | `parent_id, branch, name?, copy_agents_md?` | `WorkspaceInfo` | Creates git worktree workspace |
| `worktree_setup_status` | `workspace_id` | `WorktreeSetupStatus` | Checks if setup script needs to run |
| `worktree_setup_mark_ran` | `workspace_id` | `()` | Marks setup script as ran |
| `remove_workspace` | `id` | `()` | Removes workspace (disconnects session, prunes worktree if applicable) |
| `remove_worktree` | `id` | `()` | Removes worktree workspace specifically |
| `rename_worktree` | `id, branch` | `WorkspaceInfo` | Renames worktree branch and moves directory |
| `rename_worktree_upstream` | `id, old_branch, new_branch` | `()` | Renames upstream tracking branch |
| `apply_worktree_changes` | `workspace_id` | `()` | Applies staged worktree changes |
| `update_workspace_settings` | `id, settings` | `WorkspaceInfo` | Updates workspace settings (sort, group, git_root, scripts) |
| `set_workspace_runtime_codex_args` | `workspace_id, codex_args?` | `WorkspaceRuntimeCodexArgsResult` | Changes Codex args for a connected workspace at runtime |
| `connect_workspace` | `id` | `()` | Connects workspace (spawns codex app-server) |
| `open_workspace_in` | `path, app?, args, command?, line?, column?` | `()` | Opens workspace in external editor/app |

### Workspace Files (3 commands)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `list_workspace_files` | `workspace_id` | `Vec<String>` | Lists files respecting .gitignore (uses `ignore` crate) |
| `read_workspace_file` | `workspace_id, path` | `WorkspaceFileResponse` | Reads file content from workspace |
| `get_open_app_icon` | `app_name` | `Option<String>` | Gets app icon as base64 (macOS only) |

### Git Operations (22 commands)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `get_git_status` | `workspace_id` | `Value` | Full git status (staged, unstaged, untracked with additions/deletions) |
| `init_git_repo` | `workspace_id, branch, force?` | `Value` | Initializes git repo in workspace |
| `create_github_repo` | `workspace_id, repo, visibility, branch?` | `Value` | Creates GitHub repo via `gh repo create` |
| `list_git_roots` | `workspace_id, depth?` | `Vec<String>` | Lists git roots in workspace |
| `get_git_diffs` | `workspace_id` | `Vec<GitFileDiff>` | Gets file diffs with old/new lines, binary/image detection |
| `get_git_log` | `workspace_id, limit?` | `GitLogResponse` | Git log with ahead/behind counts and upstream info |
| `get_git_commit_diff` | `workspace_id, sha` | `Vec<GitCommitDiff>` | Gets diff for specific commit |
| `get_git_remote` | `workspace_id` | `Option<String>` | Gets remote URL |
| `stage_git_file` | `workspace_id, path` | `()` | Stages single file |
| `stage_git_all` | `workspace_id` | `()` | Stages all changes |
| `unstage_git_file` | `workspace_id, path` | `()` | Unstages single file |
| `revert_git_file` | `workspace_id, path` | `()` | Reverts single file |
| `revert_git_all` | `workspace_id` | `()` | Reverts all changes |
| `commit_git` | `workspace_id, message` | `()` | Creates commit |
| `push_git` | `workspace_id` | `()` | Pushes to remote |
| `pull_git` | `workspace_id` | `()` | Pulls from remote |
| `fetch_git` | `workspace_id` | `()` | Fetches from remote |
| `sync_git` | `workspace_id` | `()` | Fetch + pull combined |
| `list_git_branches` | `workspace_id` | `Value` | Lists local and remote branches |
| `checkout_git_branch` | `workspace_id, name` | `()` | Checks out branch |
| `create_git_branch` | `workspace_id, name` | `()` | Creates new branch |

### GitHub Integration (5 commands)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `get_github_issues` | `workspace_id` | `GitHubIssuesResponse` | Lists GitHub issues via `gh issue list` |
| `get_github_pull_requests` | `workspace_id` | `GitHubPullRequestsResponse` | Lists PRs via `gh pr list` |
| `get_github_pull_request_diff` | `workspace_id, pr_number` | `Vec<GitHubPullRequestDiff>` | Gets PR diff via `gh pr diff` |
| `get_github_pull_request_comments` | `workspace_id, pr_number` | `Vec<GitHubPullRequestComment>` | Gets PR comments via `gh api` |
| `checkout_github_pull_request` | `workspace_id, pr_number` | `()` | Checks out PR via `gh pr checkout` |

### Prompt Library (7 commands)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `prompts_list` | `workspace_id` | `Vec<CustomPromptEntry>` | Lists workspace + global prompts |
| `prompts_create` | `workspace_id, scope, name, description?, argument_hint?, content` | `CustomPromptEntry` | Creates markdown prompt file |
| `prompts_update` | `workspace_id, path, name, description?, argument_hint?, content` | `CustomPromptEntry` | Updates prompt (supports rename) |
| `prompts_delete` | `workspace_id, path` | `()` | Deletes prompt file |
| `prompts_move` | `workspace_id, path, scope` | `CustomPromptEntry` | Moves prompt between workspace/global scope |
| `prompts_workspace_dir` | `workspace_id` | `String` | Returns workspace prompts directory path |
| `prompts_global_dir` | `workspace_id` | `String` | Returns global prompts directory path |

### Terminal (4 commands)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `terminal_open` | `workspace_id, terminal_id, cols, rows` | `TerminalSessionInfo` | Opens PTY terminal session in workspace directory |
| `terminal_write` | `workspace_id, terminal_id, data` | `()` | Writes data to terminal |
| `terminal_resize` | `workspace_id, terminal_id, cols, rows` | `()` | Resizes terminal |
| `terminal_close` | `workspace_id, terminal_id` | `()` | Closes terminal (kills child process) |

### Dictation (8 commands)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `dictation_model_status` | -- | status | Checks Whisper model download status |
| `dictation_download_model` | -- | -- | Downloads Whisper model |
| `dictation_cancel_download` | -- | -- | Cancels model download |
| `dictation_remove_model` | -- | -- | Removes downloaded model |
| `dictation_start` | -- | -- | Starts audio capture + transcription |
| `dictation_request_permission` | -- | -- | Requests microphone permission |
| `dictation_stop` | -- | transcription | Stops dictation, returns text |
| `dictation_cancel` | -- | -- | Cancels dictation without result |

### Notifications & Build Info (3 commands)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `is_macos_debug_build` | -- | `bool` | Checks if running as macOS debug build |
| `app_build_type` | -- | `String` | Returns build type string |
| `send_notification_fallback` | -- | -- | Sends notification via Tauri plugin fallback |

### Local Usage (1 command)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `local_usage_snapshot` | `days?, workspace_path?` | `LocalUsageSnapshot` | Token usage data (daily breakdown, totals, top models) |

### Tailscale / Remote Daemon (5 commands)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `tailscale_status` | -- | `TailscaleStatus` | Detects Tailscale installation and network status |
| `tailscale_daemon_command_preview` | -- | `TailscaleDaemonCommandPreview` | Shows what command would be run to start daemon |
| `tailscale_daemon_start` | -- | `TcpDaemonStatus` | Starts the TCP daemon process |
| `tailscale_daemon_stop` | -- | `TcpDaemonStatus` | Stops the TCP daemon process |
| `tailscale_daemon_status` | -- | `TcpDaemonStatus` | Returns current daemon status |

### Menu & Tray (3 commands)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `menu_set_accelerators` | accelerators | -- | Updates menu keyboard shortcuts |
| `set_tray_recent_threads` | thread data | -- | Updates tray icon recent threads |
| `set_tray_session_usage` | usage data | -- | Updates tray icon usage display |

### Utility (1 command)
| Command | Parameters | Returns | Description |
|---|---|---|---|
| `is_mobile_runtime` | -- | `bool` | Returns true on iOS/Android |

**Total: ~122 Tauri commands**

---

## 5. Codex Integration

### App-Server Lifecycle

1. **Spawning** (`backend/app_server.rs::spawn_workspace_session`):
   - Resolves codex binary path (default `codex`, or custom from settings).
   - Builds PATH with extra directories (homebrew, .local/bin, .cargo/bin, .bun/bin, nvm, etc.).
   - Runs `codex --version` to verify installation.
   - Spawns `codex app-server` with stdio pipes.
   - Sets `CODEX_HOME` env var if resolved.
   - Sets `cwd` to workspace path.
   - Creates `WorkspaceSession` with stdin writer, stdout reader, pending request map.
   - Sends `initialize` request with client info and capabilities.
   - Spawns stdout reader task that processes JSON-RPC messages line by line.
   - Spawns stderr reader task for error logging.

2. **WorkspaceSession struct**:
   - `child: Mutex<Child>` -- the process handle
   - `stdin: Mutex<ChildStdin>` -- for writing requests
   - `pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>` -- pending request callbacks
   - `request_context: Mutex<HashMap<u64, RequestContext>>` -- tracks workspace + method per request
   - `thread_workspace: Mutex<HashMap<String, String>>` -- maps threadId to workspaceId
   - `hidden_thread_ids: Mutex<HashSet<String>>` -- memory consolidation threads to hide
   - `background_thread_callbacks: Mutex<HashMap<String, mpsc::UnboundedSender<Value>>>` -- for background prompts
   - `workspace_ids: Mutex<HashSet<String>>` -- registered workspace IDs
   - `workspace_roots: Mutex<HashMap<String, String>>` -- normalized workspace paths

3. **Connection sharing**: Multiple workspaces can share a single app-server session. Thread routing uses cwd-based workspace resolution.

### JSON-RPC Protocol

**Transport**: Line-delimited JSON over stdio (app) or TCP (daemon).

**Request format**: `{"id": <u64>, "method": "<string>", "params": <object>}`

**Response format**: `{"id": <u64>, "result": <any>}` or `{"id": <u64>, "error": {"message": "<string>"}}`

**Notification format** (server-to-client): `{"method": "<string>", "params": <object>}`

**Initialize request** (sent on connect):
```json
{
  "clientInfo": {
    "name": "codex_monitor",
    "title": "Codex Monitor",
    "version": "<app_version>"
  },
  "capabilities": {
    "experimentalApi": true
  }
}
```

### Complete JSON-RPC Method Inventory

#### Thread Methods
| Method | Params | Description |
|---|---|---|
| `thread/start` | `{cwd, approvalPolicy: "on-request"}` | Start new thread |
| `thread/resume` | `{threadId}` | Resume existing thread |
| `thread/read` | `{threadId}` | Read thread content |
| `thread/fork` | `{threadId}` | Fork thread |
| `thread/list` | `{cursor?, limit?, sortKey?, sourceKinds}` | List threads. sourceKinds: cli, vscode, appServer, subAgentReview, subAgentCompact, subAgentThreadSpawn, unknown |
| `thread/archive` | `{threadId}` | Archive thread |
| `thread/compact/start` | `{threadId}` | Start thread compaction |
| `thread/name/set` | `{threadId, name}` | Set thread name |

#### Turn Methods
| Method | Params | Description |
|---|---|---|
| `turn/start` | `{threadId, input, cwd, approvalPolicy, sandboxPolicy, model?, effort?, serviceTier?, collaborationMode?}` | Start a turn with user message |
| `turn/steer` | `{threadId, expectedTurnId, input}` | Steer an active turn |
| `turn/interrupt` | `{threadId, turnId}` | Interrupt active turn |

**Input items** for turn/start and turn/steer:
- `{"type": "text", "text": "..."}` -- text content
- `{"type": "image", "url": "..."}` -- image URL or data URL
- `{"type": "localImage", "path": "..."}` -- local image file path
- `{"type": "mention", "name": "...", "path": "app://..."}` -- app mention

**Sandbox policies**:
- `{"type": "dangerFullAccess"}` -- full access mode
- `{"type": "readOnly"}` -- read-only mode
- `{"type": "workspaceWrite", "writableRoots": [...], "networkAccess": true}` -- workspace-scoped write

#### Review Methods
| Method | Params | Description |
|---|---|---|
| `review/start` | `{threadId, target, delivery?}` | Start code review |

#### Model Methods
| Method | Params | Description |
|---|---|---|
| `model/list` | `{}` | List available models |

#### Feature Methods
| Method | Params | Description |
|---|---|---|
| `experimentalFeature/list` | `{cursor?, limit?}` | List experimental features |

#### Account Methods
| Method | Params | Description |
|---|---|---|
| `account/rateLimits/read` | null | Read rate limits |
| `account/read` | null | Read account info |
| `account/login/start` | `{"type": "chatgpt"}` | Start login flow (returns loginId, authUrl) |
| `account/login/cancel` | `{loginId}` | Cancel login |

#### Skills & Apps Methods
| Method | Params | Description |
|---|---|---|
| `skills/list` | `{cwd, skillsPaths?}` | List available skills |
| `app/list` | `{cursor?, limit?, threadId?}` | List apps |

#### MCP Methods
| Method | Params | Description |
|---|---|---|
| `mcpServerStatus/list` | `{cursor?, limit?}` | List MCP server statuses |

#### Collaboration Methods
| Method | Params | Description |
|---|---|---|
| `collaborationMode/list` | `{}` | List collaboration modes |

### Server-to-Client Notifications

**Supported Codex v2 notifications** (routed via frontend `appServerEvents.ts`):

| Notification | Description |
|---|---|
| `account/login/completed` | Login completed (global broadcast) |
| `account/rateLimits/updated` | Rate limits changed (global broadcast) |
| `account/updated` | Account state changed (global broadcast) |
| `app/list/updated` | App list changed |
| `error` | General error |
| `hook/completed` | Hook execution completed |
| `hook/started` | Hook execution started |
| `item/agentMessage/delta` | Streaming agent message delta (text) |
| `item/commandExecution/outputDelta` | Command execution streaming output |
| `item/commandExecution/terminalInteraction` | Terminal interaction within command |
| `item/completed` | Item finished (includes contextCompaction type) |
| `item/fileChange/outputDelta` | File change streaming output |
| `item/plan/delta` | Plan streaming delta |
| `item/reasoning/summaryPartAdded` | Reasoning summary part added |
| `item/reasoning/summaryTextDelta` | Reasoning summary text delta |
| `item/reasoning/textDelta` | Reasoning text delta |
| `item/started` | Item started (includes contextCompaction type) |
| `thread/archived` | Thread archived |
| `thread/closed` | Thread closed |
| `thread/name/updated` | Thread name changed |
| `thread/started` | Thread started |
| `thread/status/changed` | Thread status changed |
| `thread/tokenUsage/updated` | Thread token usage updated |
| `thread/unarchived` | Thread unarchived |
| `turn/completed` | Turn finished |
| `turn/diff/updated` | Turn diff updated (fully wired) |
| `turn/plan/updated` | Turn plan updated |
| `turn/started` | Turn started |

**Additional stream methods** (not standard Codex v2 notifications):

| Method | Description |
|---|---|
| `item/commandExecution/requestApproval` | Approval request for command execution (server request) |
| `item/fileChange/requestApproval` | Approval request for file changes (server request) |
| `item/permissions/requestApproval` | Approval request for permissions (server request) |
| `item/tool/requestUserInput` | Tool requesting user input (server request) |
| `codex/backgroundThread` | CodexMonitor synthetic event (hide background threads) |
| `codex/connected` | CodexMonitor synthetic event (workspace connected) |
| `codex/parseError` | CodexMonitor synthetic event (JSON parse error from stdout) |
| `codex/event/skills_update_available` | Skills update available |
| `thread/live_attached` | Thread live subscription attached (locally emitted) |
| `thread/live_detached` | Thread live subscription detached (locally emitted) |

**Missing Codex v2 notifications** (not yet routed):
`configWarning`, `command/exec/outputDelta`, `deprecationNotice`, `fuzzyFileSearch/session*`, `item/mcpToolCall/progress`, `item/autoApprovalReview/*`, `mcpServer/oauthLogin/completed`, `mcpServer/startupStatus/updated`, `model/rerouted`, `rawResponseItem/completed`, `serverRequest/resolved`, `skills/changed`, `thread/realtime/*`, `windows/worldWritableWarning`, `windowsSandbox/setupCompleted`.

**Missing Codex v2 client request methods** (not sent):
`account/logout`, `command/exec/*`, `config/*`, `externalAgentConfig/*`, `feedback/upload`, `fs/*`, `fuzzyFileSearch/*`, `mcpServer/oauth/login`, `plugin/*`, `skills/config/write`, `thread/backgroundTerminals/clean`, `thread/decrement_elicitation`, `thread/increment_elicitation`, `thread/loaded/list`, `thread/metadata/update`, `thread/realtime/*`, `thread/rollback`, `thread/shellCommand`, `thread/unarchive`, `thread/unsubscribe`, `windowsSandbox/setupStart`.

**Missing server request handling** (app-server -> client, not handled):
`item/tool/call`, `account/chatgptAuthTokens/refresh`, `mcpServer/elicitation/request`.

### Event Routing

The stdout reader task in `app_server.rs` performs sophisticated routing:
- Matches response IDs to pending requests.
- Extracts thread IDs from results/params (supports multiple naming conventions: threadId, thread_id, thread.id).
- Routes events to the correct workspace based on thread-to-workspace mapping.
- Supports background thread callbacks for commit message / metadata generation.
- Filters out hidden threads (memory consolidation).
- Broadcasts global notifications (account/updated, etc.) to all workspaces.
- Handles `thread/list` results to update thread-to-workspace mappings based on cwd.

### Background Prompt System

`run_background_prompt_core` in `codex_aux_core.rs`:
1. Starts a new thread with `approvalPolicy: "never"`.
2. Hides the thread from the UI via `codex/backgroundThread` notification.
3. Registers a background callback channel for the thread.
4. Starts a turn with read-only sandbox.
5. Collects `item/agentMessage/delta` events until `turn/completed`.
6. Archives the thread after completion.
7. Returns the accumulated text response.

Used for: commit message generation, run metadata generation, agent description generation.

---

## 6. Remote/Daemon Mode

### Architecture

CodexMonitor supports two backend modes:
- **Local** (default): Spawns `codex app-server` per workspace directly.
- **Remote**: Connects to a standalone daemon process over TCP.

### TCP Transport

**Protocol**: Line-delimited JSON-RPC over raw TCP socket (default port 4732).

**Connection flow**:
1. `TcpTransport::connect()` opens `TcpStream` to configured host.
2. `spawn_transport_io()` creates read/write tasks with pending request map.
3. First request must be `auth` with bearer token (unless `--insecure-no-auth`).
4. Outbound queue capacity: 512 messages.

**Incoming message handling** (`dispatch_incoming_line`):
- Response (has id + result/error): resolves pending request.
- Notification "app-server-event": emitted to Tauri frontend.
- Notification "terminal-output": emitted to Tauri frontend.
- Notification "terminal-exit": emitted to Tauri frontend.

**Disconnection handling**:
- `mark_disconnected()` fails all pending requests with "remote backend disconnected".
- `call_remote()` retries safe methods (list/read operations) after reconnect.
- Non-retryable methods: `send_user_message`, `start_thread`, `remove_workspace`, etc.

### Daemon Binary (`codex_monitor_daemon`)

Standalone TCP server that reuses all shared core logic:
- Listens on configurable address (default `127.0.0.1:4732`).
- Token authentication required (via `--token` or `CODEX_MONITOR_DAEMON_TOKEN`).
- Per-connection semaphore limits in-flight RPCs to 32.
- Broadcasts app-server events and terminal events to all connected clients.
- Shares app data (workspaces.json, settings.json) with the desktop app.

**RPC Dispatcher** routes to domain handlers:
1. `daemon` -- `ping`, `daemon_info`, `daemon_shutdown`, `menu_set_accelerators`, `is_macos_debug_build`, `send_notification_fallback`
2. `workspace` -- `list_workspaces`, `is_workspace_path_dir`, `add_workspace`, `add_workspace_from_git_url`, `add_worktree`, `worktree_setup_status`, `worktree_setup_mark_ran`, `connect_workspace`, `set_workspace_runtime_codex_args`, `remove_workspace`, `remove_worktree`, `rename_worktree`, `rename_worktree_upstream`, `update_workspace_settings`, `list_workspace_files`, `read_workspace_file`, `add_clone`, `file_read`, `file_write`, `get_app_settings`, `update_app_settings`, `apply_worktree_changes`, `open_workspace_in`, `get_open_app_icon`, `local_usage_snapshot`
3. `codex` -- `get_codex_config_path`, `get_config_model`, `start_thread`, `resume_thread`, `read_thread`, `thread_live_subscribe`, `thread_live_unsubscribe`, `fork_thread`, `list_threads`, `list_mcp_server_status`, `archive_thread`, `compact_thread`, `set_thread_name`, `send_user_message`, `turn_interrupt`, `turn_steer`, `start_review`, `model_list`, `experimental_feature_list`, `collaboration_mode_list`, `set_codex_feature_flag`, `get_agents_settings`, `set_agents_core_settings`, `create_agent`, `update_agent`, `delete_agent`, `read_agent_config_toml`, `write_agent_config_toml`, `account_rate_limits`, `account_read`, `codex_login`, `codex_login_cancel`, `skills_list`, `apps_list`, `respond_to_server_request`, `remember_approval_rule`, `codex_doctor`, `generate_run_metadata`, `generate_agent_description`
4. `git` -- all 27 git methods: `get_git_status`, `init_git_repo`, `create_github_repo`, `list_git_roots`, `get_git_diffs`, `get_git_log`, `get_git_commit_diff`, `get_git_remote`, `stage_git_file`, `stage_git_all`, `unstage_git_file`, `revert_git_file`, `revert_git_all`, `commit_git`, `push_git`, `pull_git`, `fetch_git`, `sync_git`, `get_github_issues`, `get_github_pull_requests`, `get_github_pull_request_diff`, `get_github_pull_request_comments`, `checkout_github_pull_request`, `list_git_branches`, `checkout_git_branch`, `create_git_branch`, `generate_commit_message`
5. `prompts` -- `prompts_list`, `prompts_workspace_dir`, `prompts_global_dir`, `prompts_create`, `prompts_update`, `prompts_delete`, `prompts_move`

**Local-only operations** (NOT available via daemon): Terminal sessions (open/write/resize/close), dictation (all 8 commands), system tray content updates, window appearance, auto-updater, Tailscale status/daemon management, `codex_update`, `remember_approval_rule` (from app Tauri command -- though daemon has it in codex handler), `write_text_file`.

### Daemon Control CLI (`codex_monitor_daemonctl`)

Commands: `start`, `stop`, `status`, `command-preview`.
Options: `--data-dir`, `--listen`, `--token`, `--daemon-path`, `--json`.

### Daemon Lifecycle Management (tailscale/daemon_commands.rs)

The app can manage the daemon process lifecycle:
- **Start**: Spawns daemon binary, waits for port availability, connects.
- **Stop**: Sends SIGTERM, waits, sends SIGKILL if needed. Can stop external daemons by PID.
- **Status**: Checks child process status, refresh runtime state.
- **Version enforcement**: Restarts daemon if version mismatch detected.
- **Auto-start**: On app launch in remote mode, daemon is automatically started.
- **Exit cleanup**: On app exit, stops daemon unless `keep_daemon_running_after_app_close` setting is enabled.

### Tailscale Integration

Detects Tailscale installation and provides suggested remote host:
- Probes multiple binary paths per platform.
- Parses `tailscale status --json` for DNS name, hostname, tailnet, IPs.
- Provides suggested connection host (e.g., `your-mac.your-tailnet.ts.net:4732`).

---

## 7. Git Operations

### Implementation Strategy

Git operations use a hybrid approach:
- **git2 (libgit2)**: Status, diff, log, stage, unstage, revert, commit, branch listing/checkout/creation. Vendored OpenSSL and libgit2.
- **git CLI**: Push, pull, fetch, sync, init, GitHub operations. Via `tokio::process::Command`.
- **gh CLI**: GitHub Issues, Pull Requests, repo creation.

### Status and Diff

- `get_git_status`: Opens repo via git2, iterates statuses. Returns `GitFileStatus` with path, status string, additions/deletions counts.
- `get_git_diffs`: Generates diff for each changed file with old/new lines. Handles binary files (detects binary content). Handles image files (base64 encodes old/new versions with MIME type detection). Supports whitespace-ignore option from settings.
- `get_git_commit_diff`: Diff for a specific commit SHA.

### Staging and Committing

- `stage_git_file` / `stage_git_all`: Adds files to index via git2.
- `unstage_git_file`: Resets index entry via git2.
- `revert_git_file` / `revert_git_all`: Checks out from HEAD via git2.
- `commit_git`: Creates commit with message via git2.
- `push_git` / `pull_git` / `fetch_git` / `sync_git`: Via git CLI commands.

### Branch Management

- `list_git_branches`: Lists local + remote branches with last commit timestamp.
- `checkout_git_branch`: Checks out existing branch.
- `create_git_branch`: Creates new branch from HEAD.

### GitHub Integration (via `gh` CLI)

- `get_github_issues`: `gh issue list --json number,title,url,updatedAt --limit 50`
- `get_github_pull_requests`: `gh pr list --json` with full PR metadata (number, title, url, dates, body, refs, draft status, author)
- `get_github_pull_request_diff`: `gh pr diff <number>` parsed into per-file diffs
- `get_github_pull_request_comments`: `gh api repos/{owner}/{repo}/pulls/{number}/comments`
- `checkout_github_pull_request`: `gh pr checkout <number>`
- `create_github_repo`: `gh repo create <name> --public/--private --source . --push`
- `init_git_repo`: `git init -b <branch>` then sets remote

### Worktree Management

- `add_worktree`: Creates git worktree via `git worktree add`. Resolves unique branch name, sanitizes worktree directory name, copies AGENTS.md if requested.
- `remove_worktree`: Runs `git worktree remove`, falls back to `git worktree prune` + directory removal.
- `rename_worktree`: Renames branch, moves worktree directory, re-registers workspace.
- `rename_worktree_upstream`: Renames remote tracking branch.
- `apply_worktree_changes`: Applies changes from worktree.
- Worktree paths: Resolved under app data dir `worktrees/<workspace-id>` (legacy `.codex-worktrees/` supported).

---

## 8. Agent Configuration

### Storage

Agent configuration lives in `$CODEX_HOME/config.toml`:
```toml
[features]
multi_agent = true

[agents]
max_threads = 6    # 1-12
max_depth = 1      # 1-4

[agents.my-agent]
description = "..."
config_file = "agents/my-agent.toml"
```

Managed agent TOML files live in `$CODEX_HOME/agents/<name>.toml`.

### Agent CRUD

- **Create**: Validates name, creates TOML from template (blank template with model, reasoning_effort, developer_instructions), writes to `agents/<name>.toml`, adds entry to config.toml.
- **Update**: Supports rename (renames both config.toml entry and managed file), description update, developer_instructions update (written into agent TOML file). Rollback on failure.
- **Delete**: Removes from config.toml, optionally deletes managed TOML file. Backup on failure for rollback.
- **Read/Write TOML**: Direct raw TOML access for advanced editing.

### Defaults

- Default agent model: `gpt-5-codex`
- Default reasoning effort: `medium`
- Default max threads: 6
- Default max depth: 1

---

## 9. File System Operations

### File Read/Write (Scoped)

Uses `FileScope` x `FileKind` matrix:
- **Workspace + Agents**: Reads/writes `AGENTS.md` in workspace root. Strict: root must exist, no symlinks.
- **Global + Agents**: Reads/writes `AGENTS.md` in `$CODEX_HOME`. Creates root if missing, allows external symlink target.
- **Global + Config**: Reads/writes `config.toml` in `$CODEX_HOME`. Creates root if missing.
- **Workspace + Config**: Rejected (not supported).

### File Tree

- `list_workspace_files`: Uses `ignore` crate's `WalkBuilder` which respects `.gitignore` files. Returns relative paths.
- `read_workspace_file`: Reads file content from workspace, validates path is within workspace root.

### Image Handling

- Converts images to base64 data URLs.
- Supports PNG, JPEG, GIF, WebP, BMP, TIFF.
- HEIC/HEIF: Converted to JPEG via macOS `/usr/bin/sips` command.
- Max inline image size: 50MB.
- Path normalization: Handles `file://` URIs with percent-decoding.

---

## 10. Prompt Library Backend

### Storage

Prompts are stored as markdown files with optional YAML frontmatter:

```markdown
---
description: "Generate a commit message"
argument-hint: "paste diff here"
---
<prompt content>
```

### Directories

- **Workspace prompts**: `<app_data_dir>/workspaces/<workspace_id>/prompts/`
- **Global prompts**: `$CODEX_HOME/prompts/`

### Operations

- **List**: Discovers `.md` files in both directories. Parses frontmatter for description and argument-hint. Returns sorted list with scope tags.
- **Create**: Sanitizes name (no whitespace, no path separators). Builds file with frontmatter. Prevents duplicates.
- **Update**: Validates path within allowed roots. Supports rename (new file + delete old). Rebuilds frontmatter.
- **Delete**: Validates path within allowed roots. Removes file.
- **Move**: Moves between workspace and global scope. Handles cross-device moves (copy + delete fallback).

---

## 11. Settings Persistence

### Storage

- `settings.json` in app data directory.
- `workspaces.json` in app data directory.

### AppSettings Fields (comprehensive)

**Backend configuration**: codexBin, codexArgs, backendMode (Local/Remote), remoteBackendProvider (Tcp), remoteBackendHost, remoteBackendToken, remoteBackends (array of targets), activeRemoteBackendId, keepDaemonRunningAfterAppClose.

**Access and review**: defaultAccessMode, reviewDeliveryMode.

**Keyboard shortcuts**: composerModelShortcut, composerAccessShortcut, composerReasoningShortcut, interruptShortcut, composerCollaborationShortcut, newAgentShortcut, newWorktreeAgentShortcut, newCloneAgentShortcut, archiveThreadShortcut, toggleProjectsSidebarShortcut, toggleGitSidebarShortcut, toggleDebugPanelShortcut, toggleTerminalShortcut, cycleAgentNextShortcut, cycleAgentPrevShortcut, cycleWorkspaceNextShortcut, cycleWorkspacePrevShortcut.

**Model/composer state**: lastComposerModelId, lastComposerReasoningEffort, composerEditorPreset.

**UI preferences**: uiScale, theme, uiFontFamily, codeFontFamily, codeFontSize, usageShowRemaining, showMessageFilePath, chatHistoryScrollbackItems, splitChatDiffView, preloadGitDiffs, gitDiffIgnoreWhitespaceChanges.

**Feature toggles**: threadTitleAutogenerationEnabled, automaticAppUpdateChecksEnabled, notificationSoundsEnabled, systemNotificationsEnabled, subagentSystemNotificationsEnabled, collaborationModesEnabled, steerEnabled, unifiedExecEnabled, experimentalAppsEnabled, dictationEnabled.

**Behavior settings**: followUpMessageBehavior (steer/queue), composerFollowUpHintEnabled, pauseQueuedMessagesWhenResponseRequired, personality (friendly/pragmatic).

**Commit message**: commitMessagePrompt, commitMessageModelId.

**Dictation**: dictationModelId, dictationPreferredLanguage, dictationHoldKey.

**Worktrees**: globalWorktreesFolder.

### Migrations

- `migrate_follow_up_message_behavior`: Converts legacy `steerEnabled` boolean to `followUpMessageBehavior` string.
- `sanitize_remote_settings_for_tcp_only`: Strips non-TCP provider settings (legacy Orb/WebSocket cleanup).
- Windows namespace path normalization: Strips `\\?\` and `\\?\UNC\` prefixes.

### Workspace Entry Fields

id, name, path, kind (Main/Worktree), parentId, worktree (branch), settings (sidebarCollapsed, sortOrder, groupId, cloneSourceWorkspaceId, gitRoot, launchScript, launchScripts, worktreeSetupScript, worktreesFolder).

---

## 12. Terminal Backend

### Implementation (desktop only via `portable-pty`)

- **Open**: Creates PTY with specified size, spawns user's default shell (`$SHELL` or `/bin/zsh` on Unix, `$COMSPEC` or `powershell.exe` on Windows).
- **Shell args**: Unix gets `-i` (interactive). Windows: PowerShell gets `-NoLogo -NoExit`, CMD gets `/K`.
- **Environment**: Sets `TERM=xterm-256color`, locale variables (LC_ALL, LANG, LC_CTYPE) from system or defaults to `en_US.UTF-8`.
- **I/O**: Spawns reader thread that reads from PTY master, handles UTF-8 boundary splitting, emits `terminal-output` events. Emits `terminal-exit` on stream close.
- **Write**: Writes data bytes to PTY writer. Detects closed-pipe errors for cleanup.
- **Resize**: Updates PTY size via master.resize().
- **Close**: Kills child process, removes session.
- **Session tracking**: Sessions keyed by `{workspace_id}:{terminal_id}`.
- **Mobile**: Stub implementations that return errors.

---

## 13. Error Handling

### Error Pattern

All Tauri commands return `Result<T, String>` where errors are human-readable strings. No custom error enum hierarchy -- the codebase uses string errors throughout.

### Common error sources:
- "workspace not found" / "workspace not connected"
- Codex CLI not found / failed to start
- JSON-RPC timeouts (300s default for requests, 30s for login start)
- "remote backend disconnected" (with retry for safe methods)
- File I/O errors (formatted with context)
- Git2 errors (converted to strings)
- "empty user message" / "missing active turn id"

### Recovery Patterns:
- **Remote reconnection**: On disconnect, clears cached backend, retries safe methods with fresh connection.
- **Background prompt cleanup**: Always archives thread and removes callback on success/failure/timeout.
- **Agent config rollback**: Restores file renames and content on config.toml persist failure.
- **Rules file locking**: File-based lock with 2s timeout and 30s stale detection.
- **Login cancellation**: Two-phase cancel (before/after login ID received).

---

## 14. Project Documentation

### README.md

Describes CodexMonitor as a Tauri app for orchestrating multiple Codex agents across local workspaces. Key features documented:
- Workspace & thread management with worktree/clone agents.
- Composer with image attachments, queue/steer follow-up, autocomplete.
- Git sidebar (diff, staging, log, branches) + GitHub integration via `gh`.
- File tree with search. Prompt library. Terminal dock.
- Remote backend/daemon mode with Tailscale integration.
- iOS support (WIP) with TCP remote backend.
- Detailed build instructions for all platforms.
- Full Tauri IPC surface listing.

### AGENTS.md

Architecture contract for agents working in the repo:
- Non-negotiable rule: shared logic in `src-tauri/src/shared/*`, app and daemon as thin adapters.
- Backend routing order: shared core -> app adapter -> frontend IPC -> daemon RPC.
- App/daemon parity checklist for all remote-capable changes.
- Thread hierarchy invariants, follow-up behavior map, validation matrix.
- Lists hotspot files that need extra care.

### REMOTE_BACKEND_POC.md

Documents the remote daemon proof-of-concept:
- Line-delimited JSON-RPC protocol over TCP.
- Auth handshake required (first message must be `auth`).
- Lists all initially implemented RPC methods.
- Usage examples with netcat.

### docs/ directory contents
- `app-server-events.md` -- app server event documentation
- `codebase-map.md` -- task-oriented file lookup guide
- `mobile-ios-tailscale-blueprint.md` -- iOS + Tailscale setup runbook
- `multi-agent-sync-runbook.md` -- upstream Codex sync checklist
- `changelog.html` -- HTML changelog
- `index.html` / `styles.css` -- docs site
- `assets/` / `screenshots/` -- media

---

## 15. Additional Notable Patterns

### Codex Home Resolution (`codex/home.rs`)
Priority: `$CODEX_HOME` (with tilde/env expansion) -> `~/.codex`. Supports `$VAR`, `${VAR}`, `%VAR%` patterns. Unix fallback to `getpwuid()` for HOME.

### Feature Flag Management (`codex/config.rs`)
Reads/writes to `$CODEX_HOME/config.toml`:
- `features.steer` -- turn steering
- `features.collaboration_modes` -- multi-agent collaboration
- `features.unified_exec` -- background terminal
- `features.apps` -- experimental apps
- `personality` -- friendly/pragmatic

### Dictation (`dictation/`)
Desktop-only local Whisper speech-to-text:
- Downloads Whisper model files (SHA-256 verified).
- Captures audio via `cpal` crate.
- Transcribes via `whisper-rs`.
- Hold-to-talk interface with configurable key.
- Microphone permission management (macOS AVCaptureDevice).

### Local Usage Tracking (`shared/local_usage_core.rs`)
Aggregates token usage from Codex log files:
- Daily breakdown (input/cached/output tokens, agent time, runs).
- 7-day and 30-day totals with cache hit rate.
- Top models by token usage.

### Process Management (`shared/process_core.rs`)
- `kill_child_process_tree`: Platform-specific process tree killing.
- `tokio_command`: Platform-aware command builder (Unix: standard; Windows: CREATE_NO_WINDOW flag).
- Windows: `resolve_windows_executable` for PATHEXT resolution, `build_cmd_c_command` for cmd.exe wrapping.
