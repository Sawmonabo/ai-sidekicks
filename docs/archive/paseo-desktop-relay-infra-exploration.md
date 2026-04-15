# Paseo Desktop Shell, Relay, Infrastructure, and Configuration Exploration

Source: direct source-code reading of `/home/sabossedgh/dev/paseo/`
Date: 2026-04-14

---

## 1. Monorepo Structure

### Workspace Layout

npm workspace monorepo at version `0.1.56`. Root `package.json` defines 8 workspaces:

| Package | npm name | Role |
|---------|----------|------|
| `packages/server` | `@getpaseo/server` | Daemon: agent lifecycle, WebSocket API, MCP server, speech |
| `packages/app` | `@getpaseo/app` | Cross-platform Expo client (iOS, Android, web) |
| `packages/cli` | `@getpaseo/cli` | Commander.js CLI (`paseo run/ls/logs/wait/send/attach/...`) |
| `packages/relay` | `@getpaseo/relay` | E2E encrypted relay (Cloudflare Durable Objects) |
| `packages/desktop` | `@getpaseo/desktop` | Electron desktop wrapper |
| `packages/website` | `@getpaseo/website` | Marketing site (paseo.sh) via TanStack Router + Cloudflare Workers |
| `packages/highlight` | `@getpaseo/highlight` | Syntax highlighting (Lezer parsers) |
| `packages/expo-two-way-audio` | `@getpaseo/expo-two-way-audio` | Native Expo module for bidirectional audio streaming |

### Internal Dependency Graph

```
desktop --> cli --> server --> relay
                           --> highlight
app --> server (shared types/client)
    --> expo-two-way-audio
cli --> relay (for E2E encryption on client side)
    --> server (shared types/client)
```

### Published Packages (npm public)

Four packages are published to npm: `@getpaseo/highlight`, `@getpaseo/relay`, `@getpaseo/server`, `@getpaseo/cli`. The rest are private.

---

## 2. Desktop Shell (Electron)

### Source Files

All source under `packages/desktop/src/`:

```
src/
  main.ts                          -- Electron main process entry
  preload.ts                       -- Context bridge for renderer
  login-shell-env.ts               -- Login shell environment resolution
  open-project-routing.ts          -- Parse --open-project from argv
  vendor.d.ts                      -- Type declarations for unzip-crx-3
  daemon/
    daemon-manager.ts              -- Daemon lifecycle + IPC command registry
    local-transport.ts             -- WebSocket transport to local daemon
    node-entrypoint-launcher.ts    -- Node entrypoint invocation builder
    node-entrypoint-runner.ts      -- Packaged entrypoint runner
    runtime-paths.ts               -- CLI/server path resolution + CLI execution
  features/
    attachments.ts                 -- Managed attachment file storage
    auto-updater.ts                -- electron-updater integration
    dialogs.ts                     -- Native dialog handlers (ask/open)
    menu.ts                        -- Application menu + context menu
    notifications.ts               -- Native notification system
    opener.ts                      -- External URL opener
    react-devtools.ts              -- Dev-mode React DevTools extension loader
  integrations/
    cli-install-path.ts            -- CLI symlink source path resolution
    integrations-manager.ts        -- CLI and skills installation
  window/
    window-manager.ts              -- Window chrome, titlebar overlay, resize events
```

### main.ts -- Electron Main Process

**Startup sequence:**

1. Initialize `electron-log` with console spy for renderer
2. Call `inheritLoginShellEnv()` -- spawns user's login shell to capture full environment (adapted from VS Code's `shellEnv.ts`). Critical for macOS/Linux where Finder/Dock launches get a minimal environment.
3. Detect git worktree for dev isolation -- each worktree gets separate `userData` so multiple Electron windows can run side-by-side
4. Apply `PASEO_ELECTRON_FLAGS` from environment (e.g., `--disable-gpu`)
5. Parse `--open-project` from argv for deep linking
6. Register `paseo://` as a privileged scheme
7. On `app.whenReady()`:
   - Register custom protocol handler for `paseo://` scheme (SPA fallback to `index.html`)
   - Apply app icon (macOS dock)
   - Set up application menu
   - Register notification center (macOS probe)
   - Register daemon manager (IPC handlers)
   - Register window manager
   - Register dialog, notification, opener handlers
   - Create main window

**Window creation:**

- 1200x800 default, hidden until `ready-to-show`
- Context isolation enabled, node integration disabled
- Platform-specific chrome: hidden titlebar on all platforms, traffic light position on macOS, custom titlebar overlay on Windows/Linux (29px height)
- Theme-aware background color (`#181B1A` dark, `#ffffff` light)
- Dev mode: loads from Expo dev server at `localhost:8081`, opens DevTools
- Production: loads from `paseo://app/` custom protocol, served from bundled `app-dist/`

**Single instance lock:**

- `app.requestSingleInstanceLock()` prevents multiple instances
- Second instance sends `commandLine` to first instance, which parses `--open-project` and sends event to renderer

**App lifecycle:**

- `before-quit`: closes all WebSocket transport sessions
- `window-all-closed`: quits on non-macOS, stays in dock on macOS
- `activate`: creates new window if none exist (macOS standard)

### preload.ts -- Context Bridge

Exposes `window.paseoDesktop` with:

- `platform`: process platform string
- `invoke(command, args)`: IPC invoke for daemon commands
- `getPendingOpenProject()`: get startup open-project path
- `events.on(event, handler)`: subscribe to main process events (returns unsubscribe)
- `window.getCurrentWindow()`: toggle maximize, check fullscreen, update window controls, set badge count, listen for resize
- `dialog`: ask (confirmation) and open (file picker)
- `notification`: check support, send notifications
- `opener.openUrl(url)`: open external URLs
- `menu.showContextMenu(input)`: terminal context menu

### Daemon Supervision

**daemon-manager.ts:**

The daemon is a detached child process managed by the desktop shell.

**Lifecycle states:** `starting`, `running`, `stopped`, `errored`

**Start daemon:**
1. Check if already running via `paseo daemon status --json`
2. If running but version mismatches desktop app version, stop and restart
3. Resolve daemon runner entrypoint (from `@getpaseo/server` dist or source)
4. Create Node entrypoint invocation with `ELECTRON_RUN_AS_NODE=1`
5. Spawn detached process with `stdio: ['ignore', 'ignore', 'ignore']`
6. Set `PASEO_DESKTOP_MANAGED=1` env
7. Wait for grace period (1200ms) to confirm process didn't die
8. Poll `daemon status` up to 150 times at 200ms intervals for PID + listen address

**Stop daemon:**
1. Send `SIGTERM`
2. Wait up to 15s for PID to exit
3. If still running, `SIGKILL` process group, wait 3s more

**Restart:** stop then start

**IPC Command Registry:**

All commands dispatched through a single `paseo:invoke` IPC handler:

| Command | Action |
|---------|--------|
| `desktop_daemon_status` | Get daemon status |
| `start_desktop_daemon` | Start daemon |
| `stop_desktop_daemon` | Stop daemon |
| `restart_desktop_daemon` | Restart daemon |
| `desktop_daemon_logs` | Tail last 100 lines of daemon.log |
| `desktop_daemon_pairing` | Get QR code/URL for mobile pairing |
| `cli_daemon_status` | Get CLI-formatted daemon status |
| `write_attachment_base64` | Write attachment to managed storage |
| `copy_attachment_file` | Copy file to managed attachment storage |
| `read_file_base64` | Read managed file as base64 |
| `delete_attachment_file` | Delete managed attachment |
| `garbage_collect_attachment_files` | GC unreferenced attachments |
| `open_local_daemon_transport` | Open WebSocket to local daemon |
| `send_local_daemon_transport_message` | Send message on transport |
| `close_local_daemon_transport` | Close transport session |
| `check_app_update` | Check for desktop app update |
| `install_app_update` | Download and install update (stops daemon first) |
| `get_local_daemon_version` | Get running daemon version |
| `install_cli` | Install CLI symlink to `~/.local/bin/paseo` |
| `get_cli_install_status` | Check if CLI is installed |
| `install_skills` | Install orchestration skills |
| `get_skills_install_status` | Check skills installation |

### Local Transport (local-transport.ts)

WebSocket connection to the local daemon via Unix domain socket or Windows named pipe:

- URL format: `ws+unix:///path/to/socket:/ws`
- Manages sessions with unique IDs
- Emits events to all BrowserWindows via `paseo:event:local-daemon-transport-event`
- Event kinds: `open`, `message`, `close`, `error`
- Supports both text and binary messages (binary as base64)

### Runtime Paths (runtime-paths.ts)

Resolves paths for both packaged and development modes:

**Packaged mode:**
- Daemon runner: `app.asar/node_modules/@getpaseo/server/dist/scripts/supervisor-entrypoint.js`
- CLI: `app.asar/node_modules/@getpaseo/cli/dist/index.js`
- Node entrypoint runner: `app.asar.unpacked/dist/daemon/node-entrypoint-runner.js`
- Uses Electron Helper on macOS for `ELECTRON_RUN_AS_NODE` processes

**Development mode:**
- Resolves from workspace `node_modules` via `createRequire`
- Falls back to source (`.ts`) with `--import tsx` if dist not built

### Auto-Update (auto-updater.ts)

Uses `electron-updater`:

- `autoDownload: true` -- downloads in background
- `autoInstallOnAppQuit: true`
- `autoRunAppAfterInstall: true`
- Caches update info between checks
- `downloadAndInstallUpdate` stops daemon before `quitAndInstall`
- 1500ms delay before quit to allow renderer to receive response
- No-op in development mode

### Window Management (window-manager.ts)

- Platform-specific titlebar: hidden on all, traffic light on macOS, overlay on Windows/Linux
- Overlay height: 29px (compact, reduced from original 48px)
- Dynamic theme colors for overlay and window background
- Resize events forwarded to renderer
- Default context menu: copy, paste, select all
- Drag-drop prevention: blocks `file://` navigation from drops
- Badge count support on macOS/Linux

### Open Project Routing

Supports two patterns:
1. Positional: `paseo /path/to/project` (must be absolute directory that exists)
2. Flag: `paseo --open-project /path/to/project`
3. Filters out macOS process serial number (`-psn_`) and `--no-sandbox` args

### CLI and Skills Installation (integrations-manager.ts)

**CLI Installation:**
- Target: `~/.local/bin/paseo` (or `paseo.cmd` on Windows)
- On macOS/Linux: creates symlink to bundled shim or AppImage/executable
- On Windows: generates `.cmd` trampoline that delegates to bundled shim
- Updates shell rc file (`~/.zshrc`, `~/.bashrc`, `~/.config/fish/config.fish`) with PATH if needed

**Skills Installation:**
- 6 skills: `paseo`, `paseo-loop`, `paseo-handoff`, `paseo-orchestrator`, `paseo-chat`, `paseo-committee`
- Copies `SKILL.md` files to `~/.agents/skills/<name>/`
- Creates symlinks in `~/.claude/skills/<name>/`
- Copies to `~/.codex/skills/<name>/`
- Windows: uses directory junctions, falls back to file copy

### Login Shell Environment (login-shell-env.ts)

Adapted from VS Code's `shellEnv.ts`:

- Only runs on macOS/Linux (no-op on Windows)
- Spawns user's login shell (`$SHELL` or from `userInfo()`)
- Supports: bash, zsh, fish, nu, xonsh, tcsh/csh, pwsh/powershell
- Captures full `process.env` via marker-wrapped JSON
- 10-second timeout
- Restores `ELECTRON_RUN_AS_NODE` and `ELECTRON_NO_ATTACH_CONSOLE` state
- Removes `XDG_RUNTIME_DIR` (Electron-specific)

### Other Features

**Attachments (attachments.ts):**
- Managed storage at `$PASEO_HOME/desktop-attachments/`
- Write from base64, copy from file, read as base64, delete, garbage collect
- Path traversal protection (must stay within attachments dir)

**Notifications (notifications.ts):**
- macOS registration probe on startup (silent notification to appear in System Preferences)
- Click handler: focuses window, sends click event with data payload to renderer

**React DevTools (react-devtools.ts):**
- Dev mode only
- Downloads CRX from Chrome Web Store
- Extracts and loads extension

---

## 3. Relay Architecture

### Source Files

```
packages/relay/src/
  crypto.ts                -- NaCl crypto primitives
  base64.ts                -- Base64 encode/decode utilities
  encrypted-channel.ts     -- E2E encrypted channel over transport
  e2ee.ts                  -- Re-exports (duplicate of index.ts)
  cloudflare-adapter.ts    -- Cloudflare Durable Objects relay server
  types.ts                 -- Connection types
  index.ts                 -- Public API exports
```

### Cryptographic Foundation (crypto.ts)

**Library:** TweetNaCl (`tweetnacl` npm package)

**Key exchange:** Curve25519 ECDH (`nacl.box.keyPair()`, `nacl.box.before()`)
- Public keys: 32 bytes
- Secret keys: 32 bytes
- Shared key: 32 bytes (precomputed from `nacl.box.before`)

**Encryption:** XSalsa20-Poly1305 (`nacl.box.after()` / `nacl.box.open.after()`)
- Random nonce: 24 bytes per message
- Authenticated encryption (tamper detection)

**Wire format:**
```
[nonce (24 bytes)] [ciphertext...]
```

**Transport format:** Binary bundle encoded as base64 text over WebSocket

**PRNG:** Falls back to `crypto.getRandomValues` if TweetNaCl's native PRNG unavailable.

### Encrypted Channel (encrypted-channel.ts)

Two factory functions for creating channels:

**`createClientChannel(transport, daemonPublicKeyB64, events)`:**
1. Generate fresh keypair
2. Import daemon's public key (received via QR code)
3. Derive shared key via ECDH
4. Send `{type: "e2ee_hello", key: "<our-public-key-b64>"}` as plaintext
5. Retry hello every 1000ms until `e2ee_ready` received
6. On `e2ee_ready`: transition to `open` state, flush pending sends
7. Max 200 pending sends buffered during handshake

**`createDaemonChannel(transport, daemonKeyPair, events)`:**
1. Wait for client's `e2ee_hello` with their public key
2. Import client public key, derive shared key
3. Send `{type: "e2ee_ready"}` as plaintext
4. Transition to `open` state
5. Buffer any messages that arrive during async key derivation

**Channel states:** `connecting` -> `handshaking` -> `open` -> `closed`

**Post-handshake handling:**
- If daemon receives a repeat `e2ee_hello` with same key: re-sends `e2ee_ready` (idempotent retry)
- If daemon receives `e2ee_hello` with different key: re-keys (new client session), drops pending sends
- Plaintext frames on encrypted channel cause fatal error (closes transport with 1011)
- Decryption failures are fatal (close transport)

**Message flow (open state):**
- `send(data)`: encrypt with shared key, send as base64 text
- `handleMessage(data)`: decode base64, decrypt with shared key, deliver plaintext

### Cloudflare Relay (cloudflare-adapter.ts)

**Deployment:** Cloudflare Durable Objects with WebSocket hibernation

**Two protocol versions:**

**v1 (legacy):** Single server/client socket pair
- One `server` WebSocket (daemon)
- One `client` WebSocket (app)
- Messages forwarded bidirectionally without modification

**v2 (current):** Control + per-client data sockets
- `server-control`: One daemon control socket per serverId (receives `connected`/`disconnected`/`sync` events)
- `server:${connectionId}`: One daemon data socket per connectionId
- `client:${connectionId}`: Many client sockets per connectionId

**v2 Connection flow:**
1. Client connects to relay with `role=client` (assigned a `connectionId` if none provided)
2. Relay notifies daemon control socket: `{type: "connected", connectionId: "..."}`
3. Daemon opens per-connection data socket with `role=server&connectionId=...`
4. Messages routed by `connectionId` tag

**Connection health:**
- If daemon's control socket appears stuck (client connected but no server data socket after 10s):
  - First nudge: sends `sync` message with all connected connectionIds
  - Second nudge (5s later): force-closes control sockets
- Client disconnect: cleans up matching server-data socket, notifies control
- Server-data disconnect: force-closes matching client sockets (triggers re-handshake)

**Frame buffering:** Up to 200 frames buffered per connectionId when daemon data socket not yet connected. Flushed when daemon connects.

**Worker entry point:**
- `/health` -- health check endpoint
- `/ws?serverId=...&role=...&v=...` -- WebSocket relay endpoint
- Routes to version-isolated Durable Object: `relay-v${version}:${serverId}`

### Trust Model

The relay is designed to be **untrusted** (zero-knowledge):

**What the relay sees:**
- IP addresses
- Timing
- Message sizes
- Session IDs
- Connection metadata (role, connectionId)

**What the relay cannot do:**
- Read message contents (all encrypted with XSalsa20-Poly1305)
- Forge messages (authenticated encryption)
- Send commands (cannot complete ECDH handshake without private key)
- Derive keys from observed handshake traffic

**Trust anchor:** The QR code/pairing link containing the daemon's public key. Treat like a password.

**Known limitation (from SECURITY.md):** Within a live session, replay protection is not yet implemented. The protocol uses random nonces but does not track nonce reuse or message counters. Session-level replay is prevented by fresh keys per session.

### Pairing Protocol

1. Daemon generates persistent ECDH keypair, stores locally
2. Desktop shows QR code or pairing link containing:
   - `serverId`
   - `daemonPublicKeyB64`
   - `relay.endpoint` (e.g., `relay.paseo.sh:443`)
3. Mobile app scans QR, extracts daemon's public key
4. Client connects to relay, sends `e2ee_hello` with own public key
5. Daemon receives hello, derives shared key, sends `e2ee_ready`
6. Encrypted channel established

---

## 4. Supporting Packages

### packages/highlight -- Syntax Highlighting

Lezer-based syntax highlighting library supporting 14 languages:

**Languages (from dependencies):** C++, CSS, Go, HTML, Java, JavaScript/TypeScript, JSON, Markdown, PHP, Python, Rust, XML, YAML, Elixir

**Source structure:**
- `highlighter.ts` -- Main highlight engine
- `parsers.ts` -- Language parser registry
- `colors.ts` -- Color scheme definitions
- `types.ts` -- Type definitions

Published as `@getpaseo/highlight` on npm. Used by `@getpaseo/server` for rendering agent output.

### packages/expo-two-way-audio -- Native Audio Module

Expo native module for bidirectional audio streaming:

**Platforms:** iOS (Swift), Android (Kotlin)

**iOS files:**
- `AudioEngine.swift` -- Core audio engine
- `ExpoTwoWayAudioModule.swift` -- Expo module bridge
- `MicrophonePermissionRequester.swift` -- Permission handling

**Android files:**
- `AudioEngine.kt` -- Core audio engine
- `ExpoTwoWayAudioModule.kt` -- Expo module bridge
- `ExpoTwoWayAudioLifeCycleListener.kt` -- Android lifecycle
- `ExpoTwoWayAudioPackage.kt` -- Package registration

**TypeScript API:**
- `core.ts` -- Core functions
- `events.ts` -- Event types
- `hooks.ts` -- React hooks
- `ExpoTwoWayAudioModule.ts` -- Module bridge

Includes two example apps (`basic-usage`, `flow-api`). Originally authored by Speechmatics, forked by boudra.

### packages/website -- Marketing Site

- TanStack Router + Vite + React 19
- Deployed on Cloudflare Workers (`wrangler.toml`)
- Tailwind CSS v4, Framer Motion for animations
- Has `posts/` directory for content
- Serves `paseo.sh`

### packages/cli -- Command-Line Client

Commander.js CLI providing Docker-style commands:

**Agent commands:** `run`, `ls`, `logs`, `wait`, `send`, `inspect`, `stop`, `archive`, `delete`, `attach`, `reload`
**Daemon commands:** `start`, `stop`, `restart`, `status`, `pair`
**Orchestration:** `loop run/ls/inspect/logs/stop`, `schedule create/ls/inspect/logs/pause/resume/delete`, `chat create/ls/inspect/post/read/wait/delete`
**Terminal commands:** `terminal ls/create/kill/capture/send-keys`
**Other:** `permit allow/deny/ls`, `provider ls/models`, `worktree ls/archive`

Dependencies: Commander, Chalk, YAML, ws, @clack/prompts, mime-types

### packages/server -- The Daemon

The heart of Paseo. Key dependencies reveal capabilities:

**Agent providers:**
- `@anthropic-ai/claude-agent-sdk` -- Claude Code
- Codex (via CodexAppServer)
- `@opencode-ai/sdk` -- OpenCode
- `@agentclientprotocol/sdk` -- ACP protocol (Pi, Copilot)
- `pi-acp` -- Pi agent

**Infrastructure:**
- Express HTTP server with WebSocket
- `node-pty` -- PTY/terminal emulation
- `pino` -- Structured logging
- `ws` -- WebSocket
- `@modelcontextprotocol/sdk` -- MCP server
- `zod` -- Runtime schema validation

**Speech/Voice:**
- `sherpa-onnx` + `sherpa-onnx-node` -- Local STT/TTS
- `onnxruntime-node` -- ONNX inference
- `@deepgram/sdk` -- Cloud STT
- `@sctg/sentencepiece-js` -- Tokenization

**Other:** QR code generation, rotating file stream, AI SDK for structured output

### packages/app -- Mobile/Web Client

Cross-platform Expo app (not deeply explored per task scope, but noted):
- React Native + Expo Router
- iOS, Android, web (browser), web (Electron desktop)
- Voice features: dictation (STT) and voice agent (realtime)
- Platform gating via `isWeb`, `isNative`, `getIsElectron()`, `useIsCompactFormFactor()`
- Metro file extensions for platform-specific implementations

---

## 5. Build System

### Scripts (scripts/)

| Script | Purpose |
|--------|---------|
| `dev.sh` | Start daemon + Expo app with `concurrently`, uses `portless` for URL management |
| `dev.ps1` | Windows equivalent, builds highlight+relay first, uses fixed `localhost:6767` |
| `emit-release-env.mjs` | Compute release environment variables from a git tag |
| `fix-lockfile.mjs` | Fix lockfile issues |
| `measure-relay-latency.ts` | Benchmark direct vs relay latency (ping times) |
| `metro-config-windows-loader-patch.cjs` | Windows Metro compatibility |
| `postinstall-patches.mjs` | Apply patches after install |
| `prove-relay-prod.mjs` | Verify production relay |
| `push-current-release-tag.mjs` | Push release tag to git |
| `release-version-utils.mjs` | Version parsing and manipulation |
| `set-release-version.mjs` | Bump all workspace versions |
| `sync-release-notes-from-changelog.mjs` | Sync changelog to GitHub releases |
| `sync-workspace-versions.mjs` | Keep all workspace versions in sync |
| `update-nix.sh` | Update Nix flake lock |

### Development Workflow

**`npm run dev`** (Unix):
1. Derive `PASEO_HOME` -- stable for worktrees, temp dir otherwise
2. Share speech models with main install
3. Get app/daemon URLs from `portless`
4. Set wildcard CORS (dev only)
5. Run daemon and Metro in parallel via `concurrently`

**`npm run dev:win`** (Windows):
1. Similar but builds highlight+relay first
2. Uses fixed `localhost:6767`
3. No `portless` (not needed)

### Build Pipeline

**`npm run build:daemon`**: Builds in dependency order:
1. `@getpaseo/highlight`
2. `@getpaseo/relay`
3. `@getpaseo/server`
4. `@getpaseo/cli`

**`npm run build:desktop`**: Syncs versions, builds web app, then builds Electron app with `electron-builder`

### Release System

Versioning:
- `npm run version:all:patch/minor/major` -- bump all workspaces
- `npm run release:rc:*` -- release candidate flow
- `npm run release:promote` -- promote RC to stable
- `npm run release:patch/minor/major` -- full release (check + version + publish + push)
- Published packages: highlight, relay, server, cli

### GitHub Actions CI/CD

12 workflow files:

| Workflow | Purpose |
|---------|---------|
| `ci.yml` | Main CI |
| `server-ci.yml` | Server-specific CI |
| `desktop-release.yml` | Desktop app build + release (macOS/Windows/Linux) |
| `android-apk-release.yml` | Android APK build |
| `deploy-app.yml` | Deploy mobile app |
| `deploy-relay.yml` | Deploy relay to Cloudflare |
| `deploy-website.yml` | Deploy website to Cloudflare |
| `nix-build.yml` | Nix package build |
| `fix-nix-hash.yml` | Auto-fix Nix hash when lockfile changes |
| `release-notes-sync.yml` | Sync changelog to GitHub releases |

---

## 6. Project Configuration

### TypeScript

**`tsconfig.base.json`:**
- Target: ES2020
- Module: ESNext with bundler resolution
- Strict mode enabled
- `isolatedModules`, `incremental` enabled
- `skipLibCheck: true`

Root `tsconfig.json` just extends base.

Each package has its own `tsconfig.json`. Desktop uses `tsconfig.json` targeting Node + Electron APIs. Server has separate configs: `tsconfig.server.json`, `tsconfig.server.typecheck.json`, `tsconfig.scripts.json`.

### Linting and Formatting

**Biome** (`biome.json`):
- Formatter: 2-space indent, 100 char line width
- JavaScript: double quotes, trailing commas, semicolons
- CSS: modules and Tailwind directives enabled
- Linter: **disabled** (formatting only)
- VCS-aware (respects `.gitignore`)

### Testing

**Vitest** (`vitest.config.ts`):
- Excludes `.claude/` directories
- Server has extensive test scripts:
  - `test:unit` -- excludes e2e tests
  - `test:integration` -- specific e2e test files, single worker
  - `test:e2e` -- full e2e suite
  - `test:integration:real` -- real provider integration
  - `test:integration:local` -- local integration
- Relay has unit tests for crypto, encrypted channel, cloudflare adapter, and live relay e2e
- Desktop has tests for window manager, CLI install path, node entrypoint launcher, open project routing

### Other Config Files

- `.mise.toml` / `.tool-versions` -- Node.js version management
- `patches/react-native-draggable-flatlist+4.0.3.patch` -- Single patch applied via postinstall
- `cli-client-id` -- Static client ID for CLI identification
- `paseo.json` -- Worktree setup config (npm ci, build daemon, copy .env, run dev terminal)
- `app.json` -- Expo config (Android package: `com.moboudra.paseo`)

---

## 7. Skills System

### Overview

Skills are markdown instruction files (`SKILL.md`) that teach AI coding agents how to use Paseo CLI for orchestration. They are installed to `~/.claude/skills/`, `~/.agents/skills/`, and `~/.codex/skills/`.

### Skills Inventory

| Skill | Trigger | Purpose |
|-------|---------|---------|
| `paseo` | Always loaded as prerequisite | Complete CLI reference for all agent, loop, schedule, chat, terminal commands. Includes model list, permissions guidance, waiting guidelines, bash composition patterns. |
| `paseo-loop` | "loop", "babysit", "keep trying until" | Iterative worker/verifier cycle. Worker does work, verifier checks, repeats until done or limits hit. Cross-provider (e.g., Codex worker + Claude verifier). |
| `paseo-handoff` | "handoff", "hand off", "hand this to" | Transfer current task to a fresh agent with comprehensive context briefing. Supports worktree isolation. Default: Codex gpt-5.4. |
| `paseo-orchestrate` | "orchestrate", "implement end to end" | Full implementation orchestrator: Triage -> Grill -> Research -> Plan -> Approve -> Implement -> Verify -> Cleanup -> Final QA -> Deliver. Uses MCP tools, not CLI. Deploys researcher, planner, impl, auditor, refactorer, QA agents. |
| `paseo-chat` | "chat room", "coordinate through chat" | Asynchronous agent coordination via persistent chat rooms with @mentions. |
| `paseo-committee` | Stuck, looping, tunnel-visioning | Forms committee of two high-reasoning agents (Opus 4.6 + GPT 5.4) for root cause analysis. Three phases: Plan -> Implement -> Review. |

### Orchestrate Skill Detail

The most complex skill. Key features:

**Complexity orders:** 1 (single file) to 4 (architectural, system-wide). Determines agent count per phase.

**Phase flow:**
1. Triage -- orchestrator assesses complexity
2. Grill (interactive) -- Socratic questioning of user
3. Research -- parallel researcher agents
4. Plan -- planner agents + plan-reviewers
5. Approve (interactive)
6. Set up -- persist plan + create heartbeat schedule (5min self-check)
7. Implement -- TDD-first, refactor-first impl agents
8. Verify -- specialized auditor agents (overeng, dry, tests, regression, types, browser, parity)
9. Cleanup -- refactorer agents (dry, dead-code, naming)
10. Final QA -- regression suite + review + browser QA
11. Deliver -- commit/PR creation with CI monitoring

**Key principles:**
- Orchestrator never writes code
- Always TDD (failing test first)
- Always archive agents when done
- Describe problems not solutions to agents
- Plan file on disk is source of truth
- Heartbeat schedule monitors progress every 5 minutes

### Orchestrate Preferences

Stored in `~/.paseo/orchestrate.json`:

| Category | Roles | Default |
|----------|-------|---------|
| `impl` | impl, tester, refactorer | `codex/gpt-5.4` |
| `ui` | UI/styling agents | `claude/opus` |
| `research` | researcher | `codex/gpt-5.4` |
| `planning` | planner, plan-reviewer | `codex/gpt-5.4` |
| `audit` | auditor, qa | `codex/gpt-5.4` |

---

## 8. Security Model

### Trust Boundaries

**Local daemon (default: `127.0.0.1:6767`):**
- Trusted by network reachability (same as Docker daemon model)
- No additional authentication token
- Host header validation for DNS rebinding protection
- CORS origin checks as defense-in-depth
- Exposing beyond loopback is user's responsibility

**Relay connection (E2E encrypted):**
- Relay server is untrusted/zero-knowledge
- All traffic encrypted with XSalsa20-Poly1305
- ECDH key exchange (Curve25519) for shared secret derivation
- QR code is the trust anchor (contains daemon's public key)

**Agent authentication:**
- Paseo does not manage provider API keys
- Each provider (Claude, Codex, OpenCode) handles own auth
- Agents run in user context with existing credentials

### What the Relay Cannot Do

1. **Send commands** -- cannot complete ECDH handshake without phone's private key
2. **Read traffic** -- NaCl box authenticated encryption
3. **Forge messages** -- authenticated encryption rejects tampered messages
4. **Replay across sessions** -- fresh keys per session

### Known Security Gap

Within a live session: no replay protection yet. Random nonces are used but nonce reuse/message counters are not tracked.

### Security Hardening (from CHANGELOG)

- Shell injection, symlink escape, and pairing endpoint hardening (v0.1.44)
- Relay and pairing URLs stripped from daemon logs (v0.1.53)
- Agent metadata and process isolation improvements

---

## 9. Data Model

### Persistence Strategy

- **File-based JSON** -- no database
- **Zod runtime validation** for all schemas
- **Atomic writes** -- write to temp file then rename
- **No migrations** -- optional fields with defaults for forward compatibility

### Storage Layout

```
$PASEO_HOME/                          (default: ~/.paseo)
  config.json                          -- Daemon configuration
  daemon.log                           -- Daemon trace logs
  push-tokens.json                     -- Expo push notification tokens
  desktop-attachments/                 -- Desktop managed attachment files
  agents/{project-dir}/{agentId}.json  -- One file per agent
  schedules/{scheduleId}.json          -- One file per schedule
  chat/rooms.json                      -- All rooms + messages
  loops/loops.json                     -- All loop records
  projects/projects.json               -- Project registry
  projects/workspaces.json             -- Workspace registry
```

### Key Entities

**Agent Record:** UUID-keyed, grouped by project dir. Status: initializing, idle, running, error, closed. Contains config, runtime info, persistence handle for session resume, features (toggle/select), attention tracking, soft-delete via `archivedAt`.

**Schedule:** 8-char hex ID. Cadence: fixed interval or cron. Target: existing agent or new agent creation. Tracks run history.

**Loop:** Iterative worker/verifier cycle. Tracks iterations, worker/verifier agent IDs, verification results (shell checks + LLM judgment), log entries with monotonic sequence.

**Chat:** Rooms with messages. Messages support @mentions (agent IDs or `@everyone`), replies, and timestamps.

**Project/Workspace:** Project = git repo or directory. Workspace = specific CWD within a project (local checkout, worktree, or directory).

### Client-Side Storage

- **Draft Store:** AsyncStorage (`paseo-drafts`) with input text, images, lifecycle state
- **Attachment Store (Web):** IndexedDB (`paseo-attachment-bytes`) for binary blobs

### Daemon Configuration

Single `config.json` with sections for:
- `daemon`: listen address, allowed hosts, MCP, CORS, relay settings
- `providers`: OpenAI API key, local models dir
- `agents.providers`: per-provider command override and env
- `features`: dictation (STT), voice mode (LLM, STT, TTS, turn detection)
- `log`: level, format, console/file settings, rotation

---

## 10. Architecture (from docs/ARCHITECTURE.md)

### System Overview

```
Mobile App (Expo) / CLI (Commander) / Desktop App (Electron)
    |                    |                    |
    | WebSocket          | WebSocket          | Managed subprocess + WebSocket
    | (direct or relay)  | (direct)           |
    +--------------------+--------------------+
                         |
                    Daemon (Node.js)
                         |
            +------------+------------+
            |            |            |
       Claude Agent  Codex Agent  OpenCode Agent
```

### WebSocket Protocol

Binary-multiplexed WebSocket protocol shared by all clients:

**Handshake:**
- Client -> Server: `WSHelloMessage { id, clientId, version, timestamp }`
- Server -> Client: `WSWelcomeMessage { clientId, daemonVersion, sessionId, capabilities }`

**Binary multiplexing (BinaryMuxFrame):**
- Channel 0: control messages
- Channel 1: terminal data
- 1-byte channel ID + 1-byte flags + variable payload

**Message types:** agent_update, agent_stream, workspace_update, agent_permission_request, command-response pairs

### Agent Lifecycle

```
initializing -> idle -> running -> idle (or error -> closed)
                 ^        |
                 +--------+  (agent completes a turn, awaits next prompt)
```

AgentManager tracks up to 200 timeline items per agent. Timeline is append-only with epochs.

### Agent Providers

| Provider | Wraps | Session format |
|----------|-------|----------------|
| Claude | Anthropic Agent SDK | `~/.claude/projects/{cwd}/{session-id}.jsonl` |
| Codex | CodexAppServer | `~/.codex/sessions/{date}/rollout-{ts}-{id}.jsonl` |
| OpenCode | OpenCode CLI | Provider-managed |

Common `AgentClient` interface. Normalized `ToolCallDetail` type for tool calls.

### Deployment Models

1. **Local daemon** (default): `127.0.0.1:6767`
2. **Managed desktop**: Electron spawns daemon as subprocess
3. **Remote + relay**: Daemon behind firewall, relay bridges with E2E encryption

---

## 11. Nix Configuration

### flake.nix

Supports 4 systems: `x86_64-linux`, `aarch64-linux`, `x86_64-darwin`, `aarch64-darwin`

Provides:
- `packages.default` / `packages.paseo` -- built with `buildNpmPackage`
- `nixosModules.paseo` -- NixOS systemd service module
- `devShells.default` -- Node.js 22 + Python 3

### nix/package.nix

`buildNpmPackage` derivation:
- Excludes non-daemon workspace contents (app src, website src, desktop src)
- Excludes test files
- Only rebuilds `node-pty` (speech native modules intentionally skipped)
- Runs `npm run build:daemon`
- Creates `paseo-server` wrapper (Node + server entry)
- Creates `paseo` wrapper (Node + CLI entry)

### nix/module.nix

NixOS service module with options:
- `enable`, `package`, `user`, `group`
- `dataDir` (defaults to `/var/lib/paseo` for system user, `~/.paseo` for real user)
- `port` (default 6767), `listenAddress` (default 127.0.0.1)
- `openFirewall`, `allowedHosts`
- `relay.enable` (default true)
- `inheritUserEnvironment` -- adds user's NixOS profile paths so agents can find tools
- `environment` -- extra env vars

Service config: `Type=simple`, `Restart=on-failure`, `RestartSec=5`, `KillSignal=SIGTERM`, `TimeoutStopSec=15`

---

## 12. Development Workflow (from CONTRIBUTING.md)

### Project Governance

BDFL project by Mohamed Boudra. PRs without prior discussion likely rejected.

### Development Setup

```bash
npm run dev          # daemon + Expo in parallel
npm run dev:server   # daemon only
npm run dev:app      # Expo only
npm run dev:desktop  # Electron desktop
npm run dev:website  # marketing site
npm run typecheck    # always after changes
npm run test --workspaces --if-present
```

### PR Requirements

- Prior discussion and scope alignment
- One idea per PR
- UI changes must include screenshots/videos for every affected platform
- UI tested on mobile and web minimum
- Typecheck passes
- Tests pass
- No breaking WebSocket/protocol changes

### Most Welcome Contributions

Bug fixes, Windows/Linux fixes, regression fixes, doc improvements, packaging/platform fixes, focused UX improvements, behavior-locking tests.

---

## 13. Changelog Highlights (Recent)

**v0.1.56 (latest):** Empty git repo crash fix, project isolation
**v0.1.55:** Provider profiles, ACP agent support, max reasoning effort, Git caching overhaul, Windows native support, iPad/tablet layouts, IME composition fix
**v0.1.54:** Inline image previews, server-side provider resolution
**v0.1.53:** Paseo MCP tools for agents, git pull, child agent notifications, agent reload
**v0.1.52:** Theme selector (6 themes), branch switching, auto-download updates
**v0.1.51:** Image attachments for OpenCode, WebStorm editor, send behavior settings
**v0.1.50:** Context window meter, open-in-editor, side-by-side diffs, voice mode, plan actions, background git fetch
**v0.1.48:** Provider diagnostics, snapshot system, Codex question handling
**v0.1.45:** Pi + Copilot providers, `paseo .` opens desktop, provider features system, Codex plan mode, desktop integrations settings
**v0.1.32:** Tauri -> Electron migration, rebindable keyboard shortcuts, macOS notarization

---

## 14. Key Observations for Gap Analysis

1. **Relay is production-grade:** Dual-version protocol (v1 legacy, v2 multiplexed), Cloudflare Durable Objects with hibernation, frame buffering, health monitoring, connection ID routing. This is mature infrastructure.

2. **Encryption is solid but has a known gap:** XSalsa20-Poly1305 with Curve25519 ECDH is well-chosen. The acknowledged lack of within-session replay protection is a documented trade-off.

3. **Desktop shell is feature-complete:** Auto-update, daemon supervision, CLI/skills installation, login shell environment, single-instance, deep linking, native dialogs/notifications, attachment management. Cross-platform (macOS/Windows/Linux).

4. **Skills system is sophisticated:** The orchestrate skill is a full implementation methodology (TDD-first, refactor-first, multi-agent coordination). Committee skill uses dual high-reasoning models for root cause analysis.

5. **No tray icon or system tray integration:** The desktop app uses standard window management. No tray icon, no "minimize to tray" behavior.

6. **No deep linking via protocol handler:** The `paseo://` scheme is registered for internal SPA routing only, not for external deep links (no `app.setAsDefaultProtocolClient` call observed).

7. **Daemon logs are file-based:** `daemon.log` with `rotating-file-stream`. No centralized logging or observability.

8. **Voice features span multiple packages:** `expo-two-way-audio` for native audio, `sherpa-onnx` for local STT/TTS, `@deepgram/sdk` for cloud STT. Voice mode supports dictation and realtime voice agent.

9. **Multi-provider architecture:** Claude Code, Codex, OpenCode, Pi, Copilot via ACP protocol. Common `AgentClient` interface with provider-specific adapters.

10. **File-based persistence (no database):** Atomic JSON writes with Zod validation. Simple but limits concurrent access and query capabilities.
