# Spec-023: Desktop Shell And Renderer

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `023` |
| **Slug** | `desktop-shell-and-renderer` |
| **Date** | `2026-04-17` |
| **Author(s)** | `Claude (AI-assisted)` |
| **Depends On** | [ADR-016: Electron Desktop Shell](../decisions/016-electron-desktop-shell.md), [ADR-010: PASETO + WebAuthn + MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md), [ADR-009: JSON-RPC IPC Wire Format](../decisions/009-json-rpc-ipc-wire-format.md), [Container Architecture](../architecture/container-architecture.md), [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md), [Security Architecture](../architecture/security-architecture.md), [Spec-007: Local IPC And Daemon Control](./007-local-ipc-and-daemon-control.md) |
| **Implementation Plan** | [Plan-023: Desktop Shell And Renderer](../plans/023-desktop-shell-and-renderer.md) |

## Purpose

Define the Electron desktop shell (main process + preload) and React + Vite renderer for AI Sidekicks — the second client delivery track after the CLI (per `container-architecture.md` §Client Delivery Sequence). This spec specifies:

- the shell/renderer process boundary and the preload bridge capability surface
- main-process responsibilities (windowing, native dialogs, notifications, deep-link handling, daemon supervision, auto-update, native keystore access, WebAuthn orchestration)
- renderer composition for each V1 Signature Feature view
- code-signing, notarization, and distribution across macOS (arm64 + x64), Windows 10/11 (x64), and Linux (x64 + arm64)
- the explicit renderer-untrusted trust stance required to keep auth material out of renderer reach

## Scope

In scope:

- Electron main-process architecture and lifecycle
- Preload bridge contract (capability surface between renderer and main)
- Renderer composition of V1 Signature Features (timeline, approvals, invites, runs, multi-agent channels)
- Daemon supervision from the shell (start, stop, health, crash recovery, version pinning)
- Auto-update flow, signature verification, and rollback safety
- Code-signing and notarization for all three V1 platforms
- WebAuthn (including the PRF extension) orchestration for desktop credential flows
- OS-keystore integration for persistent auth material
- Deep-link handling for invite URLs
- Security hardening posture (contextIsolation, sandbox, Electron Fuses, CSP)
- Crash reporting for main, renderer, and supervised-daemon process crashes
- Accessibility baseline (OS-level screen-reader and high-contrast compliance)

## Non-Goals

- Renderer visual design, component library choice, theme system (owned by the design track; this spec specifies _what_ views compose, not _how_ they look)
- Daemon internals (owned by `component-architecture-local-daemon.md` and Spec-007)
- Control-plane authentication protocol details (owned by Spec-008 and ADR-010)
- Mobile or browser-hosted renderer surfaces (out of V1 per ADR-015; browser-only local clients explicitly out of scope per Spec-007 §Resolved Questions and V1 Scope Decisions)
- The CLI client (Spec-007 owns the IPC contract the renderer reuses; CLI-specific UX is out of scope here)
- Provider-driver internal protocols (owned by Spec-005)
- Workflow authoring UX (workflow engine is V1.1 per ADR-015; renderer composition sketch is omitted)

## Domain Dependencies

- [Session Model](../domain/session-model.md) — session, participants, runs, channels
- [Participant And Membership Model](../domain/participant-and-membership-model.md) — role/capability surface the renderer reflects
- [Run State Machine](../domain/run-state-machine.md) — run-view state the renderer projects
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md) — approval + diff views
- [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md) — multi-agent channel view

## Architectural Dependencies

- [ADR-016: Electron Desktop Shell](../decisions/016-electron-desktop-shell.md) — Electron as the V1 shell and authoritative source for the supported stable-branch floor; the forward declaration this spec implements
- [ADR-010: PASETO + WebAuthn + MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md) — desktop credential path (WebAuthn PRF); this spec is the shell-side implementation surface
- [ADR-009: JSON-RPC IPC Wire Format](../decisions/009-json-rpc-ipc-wire-format.md) — wire format the preload bridge forwards
- [Container Architecture](../architecture/container-architecture.md) — renderer-untrusted trust boundary; canonical monorepo topology
- [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md) — shell/renderer/client-SDK component boundaries
- [Security Architecture](../architecture/security-architecture.md) — auth material handling and trust boundaries (§Local Daemon Authentication reconciled with this spec under BL-056 on 2026-04-18)
- [Spec-007: Local IPC And Daemon Control](./007-local-ipc-and-daemon-control.md) — the typed daemon contract the renderer reuses via the shared client SDK

## Required Behavior

### Process Model

The desktop application must run as three cooperating processes:

1. **Shell (Electron main process).** Node.js runtime. Owns windowing, native dialogs, notifications, deep-link protocol handler, daemon supervision, auto-updater, OS-keystore access, WebAuthn orchestration, and all session-scoped auth material.
2. **Renderer (Electron renderer process, one per window).** Chromium with `contextIsolation: true` and `sandbox: true`. Loads the React + Vite bundle. Has no direct Node.js access and no direct filesystem, network, or OS access — all such capabilities flow through the preload bridge.
3. **Local Daemon (spawned child process of the shell, or external service).** Runs `packages/runtime-daemon/`. The shell supervises it via the `DaemonStart`, `DaemonStop`, `DaemonRestart`, and `DaemonStatusRead` surface from Spec-007. The daemon owns all execution authority.

The renderer must never fork, spawn, or exec a process. The renderer must never open a filesystem handle or a network socket directly — every such operation flows through the preload bridge and is enforced in the shell's main process.

### Trust Stance

The renderer is **untrusted** relative to the shell and daemon, consistent with `container-architecture.md` §Trust Boundaries and `component-architecture-desktop-app.md` §Trust Boundaries.

The shell (main process) holds all of the following; the renderer never holds any of them:

- the local daemon session token from `$XDG_RUNTIME_DIR/ai-sidekicks/daemon.token` per Security Architecture §Local Daemon Authentication (loaded at shell startup)
- the PASETO v4.public access token issued by the Collaboration Control Plane per ADR-010
- the PASETO v4.local refresh token per ADR-010
- the ephemeral Ed25519 DPoP private key bound to the access token per Security Architecture §Control-Plane Authentication
- WebAuthn PRF-derived credential-wrapping keys per ADR-010
- any participant-identity private-key material stored in the OS keystore

All renderer-originated daemon or control-plane requests flow through the preload bridge, which:

1. validates the request against a narrow capability-typed contract brokered to the renderer at session start
2. attaches the session token (for daemon calls) or the PASETO access token + DPoP proof (for control-plane calls) in the main process
3. forwards the request over the Spec-007 Content-Length JSON-RPC transport (daemon) or the ADR-014 tRPC / WebSocket transport (control plane)
4. returns only the sanitized response payload to the renderer — never the raw auth headers

`security-architecture.md` §Local Daemon Authentication was reconciled with this spec's renderer-untrusted stance under BL-056 on 2026-04-18. It now states that the renderer is **not a direct daemon client**; all renderer-originated requests flow through the preload bridge to the Desktop Shell, which forwards them to the daemon with attached auth headers. The Shell and CLI both present the 256-bit session token at daemon-connect time (token is primary; socket permissions 0700 are defense-in-depth). The prior "trusted local process" framing and the "token optional for renderer / CLI" permission have been removed.

### Security Hardening Baseline

Every `BrowserWindow` must be created with the following `webPreferences`:

```ts
{
  contextIsolation: true,          // must be true; isolates preload from renderer
  sandbox: true,                   // must be true; renderer runs in OS-level sandbox
  nodeIntegration: false,          // must be false; no Node APIs in renderer
  nodeIntegrationInWorker: false,  // must be false
  webSecurity: true,               // must be true; enforces same-origin
  preload: '<absolute path>',      // preload script registered here
  // no remoteModule (removed in Electron >= 14)
}
```

Every renderer document must be served with a strict `Content-Security-Policy`. At minimum:

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
connect-src 'self' https://<configured-control-plane-origin> wss://<configured-relay-origin>;
img-src 'self' data: blob:;
font-src 'self';
frame-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none';
```

Electron Fuses — the shell binary must be packaged with the following fuses (see [Implementation Notes §Electron Fuses](#electron-fuses) for rationale and primary-source citations):

- `RunAsNode`: **disabled** — prevents the shipped Electron binary from running as a generic Node.js runtime via `ELECTRON_RUN_AS_NODE`
- `EnableCookieEncryption`: **enabled** — encrypts the cookie store at rest using OS-level primitives
- `EnableNodeOptionsEnvironmentVariable`: **disabled** — prevents `NODE_OPTIONS` / `NODE_EXTRA_CA_CERTS` from injecting code at startup
- `EnableNodeCliInspectArguments`: **disabled** — prevents `--inspect` and `--inspect-brk` debugger flags at the Electron command line
- `EnableEmbeddedAsarIntegrityValidation`: **enabled** — verifies asar-bundle integrity at load time (graduated from experimental to stable in Electron 39; now available on Linux via digest mode as of Electron 41)
- `OnlyLoadAppFromAsar`: **enabled** — refuses to load the app from anywhere other than the signed asar
- `LoadBrowserProcessSpecificV8Snapshot`: **enabled** — prevents renderer V8 snapshots from leaking into the browser process
- `GrantFileProtocolExtraPrivileges`: **disabled** — refuses to grant privileged APIs to `file://` origins; the renderer is served via a custom protocol, not `file://`
- `WasmTrapHandlers`: **enabled** (default) — required for WASM memory safety without perf cost

In addition to the Fuses above, release builds must embed an **ASAR Integrity Digest** (new in Electron 41 via `@electron/asar` v4.1.0+, invoked as `asar integrity-digest on /path/to/YourApp.app`). Digest generation must run **before** the code-signing step because toggling fuses and embedding the digest both invalidate the signature.

### Preload Bridge Contract

The preload script exposes a single typed object on `window.sidekicks` via `contextBridge.exposeInMainWorld`. The object surface must be declarative, narrow, and capability-scoped.

```ts
interface SidekicksBridge {
  // daemon RPC — request/response over Spec-007 JSON-RPC contract
  daemon: {
    call<M extends DaemonMethod>(method: M, params: DaemonParams<M>): Promise<DaemonResult<M>>;
    subscribe<E extends DaemonEvent>(
      event: E,
      handler: (payload: DaemonEventPayload<E>) => void,
    ): Unsubscribe;
  };

  // control-plane RPC — request/response over tRPC, live updates over WebSocket JSON-RPC 2.0
  controlPlane: {
    call<P extends CpProcedure>(procedure: P, input: CpInput<P>): Promise<CpOutput<P>>;
    subscribeRelay(sessionId: SessionId, handler: RelayEventHandler): Unsubscribe;
  };

  // native capabilities — renderer requests, main performs, sanitized result returned
  native: {
    showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogResult>;
    showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogResult>;
    showMessageBox(options: MessageBoxOptions): Promise<MessageBoxResult>;
    showNotification(options: NotificationOptions): void;
    openExternal(url: string): Promise<void>; // main-process allowlist-validated
    copyToClipboard(text: string): Promise<void>;
    revealInFileExplorer(path: FilePathRef): Promise<void>;
  };

  // WebAuthn — renderer cannot call navigator.credentials.* directly under strict CSP;
  //           main process orchestrates the WebAuthn ceremony via Electron's bindings
  webAuthn: {
    createCredential(options: PublicKeyCredentialCreationOptions): Promise<PublicKeyCredential>;
    getAssertion(options: PublicKeyCredentialRequestOptions): Promise<PublicKeyCredential>;
    deriveKeyMaterial(input: PrfInput): Promise<ArrayBuffer>; // PRF extension per ADR-010
  };

  // auto-update — renderer observes state; main process drives
  update: {
    getState(): Promise<UpdateState>;
    subscribe(handler: (state: UpdateState) => void): Unsubscribe;
    requestCheck(): Promise<void>;
    requestRestart(): Promise<void>;
  };

  // app meta — read-only
  app: {
    version: string;
    platform: "darwin" | "linux" | "win32";
    arch: "arm64" | "x64";
    locale: string;
  };
}
```

The bridge must not expose:

- raw `ipcRenderer` or `ipcMain`
- `require`, `process`, `global`, or any Node built-in
- auth material (daemon session token, PASETO tokens, DPoP key, WebAuthn PRF output) in any form — PRF output is derived and consumed inside main-process-owned caches
- arbitrary file paths as strings — paths returned to the renderer are opaque `FilePathRef` tokens; dereferencing requires a second main-process round trip

### Main Process Responsibilities

- **App lifecycle.** Single-instance lock (`app.requestSingleInstanceLock()`). Graceful shutdown on `before-quit` — signal the daemon to flush, wait up to a 10-second budget, then force-terminate. Relaunch on update apply.
- **Window management.** Main session window. Optional auxiliary windows (full-screen timeline, detached agent console). Platform-appropriate menu bar (macOS app menu; Windows/Linux window menu). Tray icon with status (connected / offline / update-available).
- **Native dialog surface.** File open/save, message boxes, system notifications — exposed to renderer via the bridge above.
- **Notifications.** Cross-platform via `Notification` API. Must honor OS Do-Not-Disturb. Click-to-focus must surface the window and navigate to the event source.
- **Deep-link handling.** The shell must register a protocol handler for `sidekicks://` (e.g., `sidekicks://invite/<token>`) on all three platforms. On invocation, the shell parses the URL, routes to the renderer's invite-accept flow, and never exposes the raw token to the renderer — the token is exchanged for a session capability in the main process.
- **Daemon supervision.** Start, stop, restart, and monitor the local daemon via Spec-007's `DaemonStart`/`DaemonStop`/`DaemonRestart`/`DaemonStatusRead` surface. Crash detection triggers automatic restart with exponential backoff (`100ms, 300ms, 1s, 3s, 10s`) up to five attempts, then surfaces a persistent UI error state. Version mismatch (per Spec-007 §Version Negotiation) blocks mutating operations but preserves read-only visibility.
- **Auto-update.** Scheduled checks against the configured feed. Download, verify signature, stage, and apply on relaunch. Surface update state to the renderer via the `update` bridge channel. Rollback on signature-verification failure or post-install daemon handshake failure.
- **OS keystore access.** Store and retrieve the PASETO refresh token, the daemon session token (cached between daemon restarts for fast handshake), and any participant-identity private keys. Encrypted at rest via OS primitives (macOS Keychain, Windows Credential Manager, Linux Secret Service / libsecret with KWallet fallback).
- **WebAuthn orchestration.** Drive the WebAuthn create and get ceremonies on behalf of the renderer via Electron's WebAuthn bindings; return the authenticator assertion through the bridge. Handle the PRF extension per ADR-010 and pass derived key material into the main-process-owned credential-wrap cache — never into the renderer.
- **Crash reporting.** Electron `crashReporter` for main and renderer process crashes. Supervised daemon crashes surface through the Spec-007 supervision contract. All crash payloads must strip PII (session IDs replaced with stable hashes; file paths truncated to extension; no content payloads).

### Renderer Responsibilities

- Render session, orchestration, repo, diff, approval, invite, settings, and workflow-viewer surfaces
- Merge live projections from daemon subscriptions with control-plane subscriptions into a coherent session experience (per `component-architecture-desktop-app.md` §Data Flow)
- Route all privileged operations through the preload bridge
- Never cache auth material (the bridge enforces this; renderer code treats every call as authenticated-by-main)
- Handle disconnection states gracefully: daemon disconnect → reconnect or read-only mode per Spec-007 §Failure Modes; control-plane disconnect → local continuity with degraded collaboration UI

### WebAuthn Credential Flow

Per ADR-010, WebAuthn PRF is the primary desktop credential path. Electron does not provide platform-authenticator flows natively (see [Implementation Notes §WebAuthn Platform-Authenticator Native Module](#webauthn-platform-authenticator-native-module)), so the main process drives the ceremony through a native-module binding, not through `navigator.credentials.*` in the renderer.

End-to-end flow:

1. Renderer requests sign-in → bridge `webAuthn.getAssertion(options)`
2. Main process invokes the chosen native-module binding against the platform authenticator (Touch ID / Windows Hello / FIDO2 roaming on Linux)
3. Authenticator produces the assertion + PRF output
4. Main process stores the PRF-derived wrapping key in its own address space (never exposed to renderer)
5. Main process uses the wrapping key to unlock the PASETO refresh token from the OS keystore
6. Main process returns only the ceremony success signal + participant identity claims to the renderer
7. Subsequent control-plane calls from the renderer flow through the bridge, where the main process attaches the unwrapped access token + DPoP proof

If the native module is unavailable or the platform authenticator does not support the PRF extension, the flow falls back to the Device Authorization Grant path per §Fallback Behavior.

### Deep-Link Invite Flow

1. OS invokes `sidekicks://invite/<token>` — protocol handler fires in the main process
2. Main process parses the URL, extracts the invite token, and calls the control-plane `acceptInvite(token)` procedure with the attached PASETO access token + DPoP proof
3. On success, main process receives the new session membership and notifies the renderer via a bridge event
4. Renderer navigates to the newly joined session view
5. The raw invite token never crosses the bridge to the renderer

### Auto-Update Flow

1. Main process schedules update checks on a configurable cadence (default: every four hours, additionally on app startup, additionally on user request)
2. On available update: download to a temp location and verify the signature against the bundled update-signing public key
3. Post-verification: stage the update artifact in the platform-appropriate location (`CSIDL_LOCAL_APPDATA` on Windows; `~/Library/Application Support` on macOS; `$XDG_DATA_HOME` on Linux)
4. Notify the renderer via `update.subscribe`; renderer surfaces the "Update ready — restart to apply" UX
5. On restart (user-initiated via bridge `update.requestRestart()` or next natural launch): apply the staged update
6. Post-apply: perform the daemon handshake. If the daemon fails to start or reports an incompatible protocol version, roll back to the previous version and re-surface the update to try again later
7. If signature verification ever fails, discard the artifact, log the event, and re-attempt the download next cycle

Update signature verification must use an Ed25519 or ECDSA-P256 signing key pinned at build time. The public key is embedded in the shell binary and immutable for the lifetime of that binary.

### Daemon Supervision Lifecycle

1. Shell startup: read daemon config (socket path, expected version); probe the existing socket
2. If daemon not running: spawn via `utilityProcess.fork(daemonEntryPath)` (see [Implementation Notes](#utility-process-vs-child-process)); wait for `DaemonHello` readiness signal up to a 10-second timeout
3. If daemon running but version incompatible: surface to renderer; block mutating operations; permit read-only subscriptions
4. Live mode: heartbeat via `DaemonStatusRead` on 30-second cadence; missed heartbeats trigger reconnect probe
5. Daemon crash: detect via `utilityProcess` exit event; restart with backoff; after five failed attempts surface persistent error state
6. Shell shutdown: send `DaemonStop` with a 10-second grace window, then force-terminate

## Default Behavior

- The shell auto-connects to the local daemon at shell startup (starting the daemon if needed, per Spec-007 §Default Behavior) and exposes renderer-accessible capabilities via the preload bridge per §Trust Stance; the renderer is not a direct daemon client
- Auto-update is **enabled** by default; user may disable it via settings
- Crash reporting is **enabled** by default with PII-stripping; user may opt out via settings
- Notifications are **enabled** by default; user may mute per session or globally
- Deep-link protocol handler registration is performed on first launch

## Fallback Behavior

- If OS-local transport to the daemon is unavailable: fall back to loopback per Spec-007 §Fallback Behavior; surface the fallback clearly in the UI
- If the daemon fails to start after five backoff attempts: enter offline read-only mode; surface the error; expose a manual retry
- If the auto-updater cannot reach the feed: skip this cycle; retry on schedule; do not block normal operation
- If WebAuthn is unavailable (authenticator missing, PRF extension unsupported by the platform authenticator): fall back to the CLI-equivalent Device Authorization Grant flow per Security Architecture §Control-Plane Authentication, surfaced as a `localhost:<port>/callback` browser capture
- If the OS keystore is unavailable: refuse to persist long-lived auth material; session is memory-only; surface the degradation

## Interfaces And Contracts

### Renderer → Shell → Daemon (via Preload Bridge)

- Wire format between renderer and shell: Electron IPC over `contextBridge`-exposed functions; serialization via structured clone
- Wire format between shell and daemon: JSON-RPC 2.0 with Content-Length framing per Spec-007 and ADR-009
- The shell is a transparent forwarder for the daemon contract — no method rewriting, only auth-header attachment and response-payload sanitization

### Renderer → Shell → Control Plane (via Preload Bridge)

- Wire format between shell and control plane: tRPC v11 over HTTPS for request/response; WebSocket (JSON-RPC 2.0) for bidirectional relay coordination per ADR-014 and Spec-008
- Shell attaches `Authorization: Bearer <PASETO v4.public>` + `DPoP: <signed-proof>` headers; renderer never sees them

### Shell ↔ OS Keystore

- macOS: Keychain Services via a native-binding library (see [Implementation Notes §Native Keystore](#native-keystore))
- Windows: Credential Manager via the same abstraction
- Linux: Secret Service (libsecret) with KWallet fallback; if neither available, surface the OS-keystore-unavailable degradation from §Fallback Behavior

### Shell ↔ Auto-Update Feed

- Transport: HTTPS
- Artifact format: platform-appropriate (`.dmg` / `.zip` for macOS, `.exe` NSIS or MSI for Windows, `.AppImage` / `.deb` / `.rpm` for Linux) plus a manifest carrying the artifact hash and signature
- Signature algorithm: Ed25519 (preferred) or ECDSA-P256

## State And Data Implications

- Window state (size, position, maximized) persisted to shell-local config; not sensitive
- Settings (auto-update preference, notification preferences, workspace mounts) persisted to shell-local config
- Auth material (tokens, keys) persisted to OS keystore; never shell config, never renderer storage
- Daemon session token cached in shell memory for the lifetime of the session; rotated on daemon restart per Security Architecture §Session Token
- Supervisor state (daemon PID, last-heartbeat timestamp, restart attempt count) persisted in shell-local state for crash-recovery diagnostic only
- Update artifact cache: shell-owned; cleared after successful apply or after a configurable retention window

## Example Flows

- `Example: First-run onboarding.` The shell starts with no daemon running. The shell launches the daemon as a utility process, waits for `DaemonHello` readiness, and loads the renderer. The renderer displays the first-run three-way-choice onboarding surface (relay selection) per Spec-026 (BL-081). User selects "free public relay". The shell writes the choice to daemon config and forwards the daemon-configured relay URL to the renderer. The renderer displays the sign-in surface.

- `Example: Accept invite via deep link.` User clicks `sidekicks://invite/abc123` in their chat client. The OS dispatches the URL to the registered handler. The shell parses the token, calls `controlPlane.acceptInvite(abc123)` with the session's PASETO access token + DPoP proof, receives the new session membership, emits a `session:joined` event on the bridge, and the renderer navigates to the joined session view.

- `Example: Passkey sign-in.` Renderer calls `bridge.webAuthn.getAssertion({...})`. Shell invokes Electron's WebAuthn binding; the platform authenticator prompts (Touch ID / Windows Hello). Authenticator returns the assertion plus PRF output. Shell derives the refresh-token-wrapping key, unwraps the refresh token from the OS keystore, exchanges it for a fresh access token at the control plane, caches the access token + DPoP key in main-process memory, and returns only the participant identity claims to the renderer.

- `Example: Auto-update applied.` Shell hits the update feed on schedule; finds a new version; downloads and verifies the signature; stages the artifact; emits an `update:ready` event. Renderer surfaces "Update ready — restart to apply." User clicks; shell calls `app.relaunch()` after a graceful daemon shutdown; the new shell launches; the daemon handshake succeeds; the user sees the new version.

- `Example: Daemon crash mid-session.` The session engine process exits abnormally; shell's `utilityProcess` exit handler fires. Shell surfaces "Local runtime disconnected — reconnecting…" to the renderer. Shell restarts the daemon with exponential backoff; on recovery the daemon replays its event log and the renderer resubscribes. User sees the timeline catch up and the session resume.

## Signature Feature Composition Sketches

Each V1 Signature Feature view must compose daemon and control-plane state via the preload bridge. The owning plan listed in parentheses is the canonical source of feature behavior; the renderer is a read-and-steer projection of that behavior, not the source of truth.

### Timeline View — the "everything happens here" surface (→ Plan-013 Live Timeline And Reasoning Surfaces)

- Data sources: daemon event-log subscription (`bridge.daemon.subscribe('session.events', …)` per Spec-013); control-plane presence subscription for participant-state badges
- Renders: chronological event stream (messages, tool calls, approvals, diffs, agent reasoning, interventions, state transitions) per Spec-013
- Interactions: scroll-to-tail, jump-to-event-by-ID, filter-by-participant / event-type, "replay from here" via Spec-015 replay contract
- State handling: live-tailing mode vs historical-browse mode; local projection cache invalidation on daemon reconnect
- Owning plan: Plan-013

### Approvals View (→ Plan-012 Approvals, Permissions, Trust Boundaries)

- Data sources: daemon approval-queue subscription; approval-policy read via `bridge.daemon.call('approvals.listPending')` per Spec-012
- Renders: pending approval cards (category, requesting agent, summary of action, target scope, remembered-rule option); resolved approvals in history view
- Interactions: approve / deny / remember-for-session / remember-for-scope, all forwarded to the daemon approval engine
- Owning plan: Plan-012

### Invites View (→ Plan-002 Invite, Membership, Presence)

- Data sources: control-plane `invites.list` procedure; control-plane presence subscription
- Renders: pending sent invites (with expiry + shareable-link copy), received invites (accept / decline), membership roster per Spec-002
- Interactions: create invite (produces shareable link token); revoke invite; manage membership role (owner-only) per Security Architecture Permission Matrix
- Owning plan: Plan-002

### Runs View (→ Plan-004 Queue, Steer, Pause, Resume)

- Data sources: daemon run-state subscription per Spec-004; daemon queue subscription per Spec-004
- Renders: active runs with live status (queued / running / paused / completed / errored), queue contents, intervention history per Spec-004
- Interactions: pause / resume / steer / interrupt / cancel on active runs; enqueue / dequeue / reorder on queue; all forwarded to the daemon run engine per the Run State Machine domain model
- Owning plan: Plan-004

### Multi-Agent Channels View (→ Plan-016 Multi-Agent Channels And Orchestration)

- Data sources: daemon channel subscription per Spec-016; control-plane presence subscription for participant attention-state
- Renders: channel list with per-channel turn policy + budget badges; turn-order indicator; stop-condition status; moderation hooks per Spec-016
- Interactions: create channel; configure turn policy / budget / stop condition (scoped to session-owner capability); moderate (mute participant, pause channel); intervene per ADR-011 intervention-dispatch
- Owning plan: Plan-016
- Note: Spec-016 V1-readiness review per BL-042 may tighten defaults; this sketch binds to whatever Spec-016 finalizes.

## Implementation Notes

_This section captures architecture-relevant, non-normative implementation guidance. It will be expanded with primary-source citations from the current-state Electron ecosystem research once the research pass completes; see References §Research Conducted._

### Electron Version And Support Window

V1 builds must target **Electron 41.x** (stable release 2026-03-10, Chromium 146.0.7680.65, V8 14.6, Node v24.14.0) at minimum patch version **41.1.0** to pick up the Q1 2026 high-severity CVE batch (CVE-2026-34769, -34770, -34771, -34772, -34774, -34764, all fixed 2026-04-02 in 39.8.5 / 40.8.5 / 41.1.0). 41.1.0 also subsumes the earlier [CVE-2026-34776](https://nvd.nist.gov/vuln/detail/CVE-2026-34776) fix ([GHSA-3c8v-cfp5-9885](https://github.com/electron/electron/security/advisories/GHSA-3c8v-cfp5-9885), out-of-bounds heap read in `requestSingleInstanceLock()` second-instance IPC parser on macOS and Linux; shipped in 41.0.0), whose per-branch floors are the source-of-truth in [ADR-016 §Decision](../decisions/016-electron-desktop-shell.md#decision). Electron 42 is scheduled for 2026-05-05; by V1 GA the target is expected to be Electron 42.x.

Electron has **no LTS lane**. The project team supports the latest three stable majors on an 8-week release cadence aligned with Chromium's 4-week stable channel. Support windows as of 2026-04-17:

- Electron 37: EOL 2026-01-13
- Electron 38: EOL 2026-03-10
- Electron 39: EOL 2026-05-05
- Electron 40: EOL 2026-06-30
- Electron 41: EOL 2026-08-25

**Consequence:** Plan-023 must budget two forced major-version upgrades in V1's first year after ship. Same-week patch adoption is required on security-advisory drops. This is the single largest recurring operational cost of choosing Electron and is accepted per ADR-016; Plan-023 must include release-engineering capacity for the cadence.

Sources:

- [Electron release timeline](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)
- [Release schedule](https://releases.electronjs.org/schedule)
- [Electron 41.0 release notes](https://www.electronjs.org/blog/electron-41-0)
- [GitHub Security Advisories, electron/electron](https://github.com/electron/electron/security/advisories)

### Electron Fuses

Electron Fuses are build-time toggles on the shipped binary that harden the binary against misuse as a generic Node runtime or against injection vectors. The posture declared above (RunAsNode disabled, NodeOptions disabled, CLI inspect disabled, asar integrity enabled, OnlyLoadAppFromAsar enabled, cookie encryption enabled) matches the current Electron-documented production hardening recommendation and the posture VS Code, Slack, and 1Password ship with.

### Utility Process Vs Child Process

The shell supervises the daemon via `utilityProcess.fork()` (introduced in Electron 22; production-ready since Electron 24) rather than raw `child_process.fork()`. `utilityProcess` is Chromium-Services-backed (not Node's native `child_process`), which gives the daemon:

- an isolated V8 instance
- MessagePort-based IPC with `MessagePortMain` transfer via `postMessage(msg, [transfer])` — survives across process boundaries
- exit-event propagation the shell can hook for crash recovery
- integration with Electron's Crashpad reporting pipeline
- participation in the shell's structured-clone IPC

The daemon does not inherit the shell's Chromium command-line flags or memory pressure. `utilityProcess.fork()` must be called after `app.ready`.

Exit-reason handling: as of Electron 40, `utilityProcess` exits may carry the reason `"memory-eviction"` — this is the OS reclaiming memory from a backgrounded process, not a crash. Supervisor logic must treat `"memory-eviction"` distinctly from crash reasons (restart with the standard backoff, but without incrementing the failure counter that feeds the "five-attempts-then-surface-error" rule in §Daemon Supervision Lifecycle).

Gotcha: `utilityProcess` has no direct network-interception API equivalent to a renderer's `session` object. If the daemon needs Electron's network stack (for cert pinning, for example), requests must proxy back through the shell main process. If the daemon is content with Node's native `https`, this is moot.

Sources:

- [Electron utilityProcess API](https://www.electronjs.org/docs/latest/api/utility-process)
- [Electron 40.0 release notes](https://www.electronjs.org/blog/electron-40-0) — `"memory-eviction"` exit reason
- [Electron Message Ports tutorial](https://www.electronjs.org/docs/latest/tutorial/message-ports)

### Native Keystore

`node-keytar` was archived by its maintainers on 2022-12-15 (last release v7.9.0, 2022-02-17) and is **not** a supported dependency for new projects. The 2026 replacement adopted by this project is **`@napi-rs/keyring`** (v1.2.0, 2025-09-02 — a napi-rs Rust binding to the `keyring-rs` crate, self-described as a "100% compatible node-keytar alternative"). It supports macOS Keychain, Windows Credential Manager, and Linux Secret Service. It does **not** require libsecret on Linux (it uses `secret-service-rs`), which matters in headless CI, WSL, and Codespaces environments. It is also the replacement path used by the Microsoft Authentication Library for JS and the Azure Identity SDK.

For simple encrypt-one-blob use cases (e.g., small settings values), Electron's main-process `safeStorage` API is acceptable. `safeStorage` uses Keychain on macOS, DPAPI on Windows, and Secret Service / kwallet / libsecret on Linux. Exposed methods: `isEncryptionAvailable`, `encryptString`, `decryptString`, `getSelectedStorageBackend` (Linux only).

**Critical Linux gotcha for V1:** When no OS keystore is available, `safeStorage` silently falls back to a **hardcoded plaintext password** — i.e., secrets are unprotected. This is explicit in the Electron docs. For AI Sidekicks, which holds PASETO refresh tokens, DPoP keys, and WebAuthn PRF-derived wrapping material, the shell must:

1. Call `safeStorage.isEncryptionAvailable()` at startup
2. On Linux, additionally call `safeStorage.getSelectedStorageBackend()` and reject the values `'basic_text'` and `'unknown'`
3. On a non-protective backend, **refuse to persist long-lived auth material** — degrade to memory-only session per §Fallback Behavior, and surface the degradation prominently

The same rule applies to `@napi-rs/keyring` on headless Linux without Secret Service: the abstraction layer must detect the no-keystore case and refuse to persist auth material rather than silently falling back.

Sources:

- [`node-keytar` archive notice](https://github.com/atom/node-keytar) — "archived by the owner on Dec 15, 2022"
- [`@napi-rs/keyring` v1.2.0](https://www.npmjs.com/package/@napi-rs/keyring)
- [MSAL JS keytar migration issue](https://github.com/AzureAD/microsoft-authentication-library-for-js/issues/7170) — corroborating MSAL's move off keytar
- [Electron `safeStorage` API](https://www.electronjs.org/docs/latest/api/safe-storage) — explicit Linux plaintext-fallback behavior

### Build And Packaging

`electron-builder` v26.9.0 (released 2026-04-14) is the packaging tool for V1. Multi-platform coverage: macOS `.dmg` and `.zip`, Windows NSIS and MSI, Linux `.AppImage` / `.deb` / `.rpm` / Snap / Flatpak. Reasoning: cross-platform installer-format coverage is broader than Electron Forge's, production-proven at the scale of VS Code / 1Password / Slack, and integrates cleanly with `electron-updater` for the update path on all three platforms.

**Alternative considered:** Electron Forge. Forge v7.11.1 (2026-01-12) is the Electron team's officially-maintained packaging tool, and the electronjs.org docs recommend it as the default. Forge v8.0.0 (the ESM release) is still in alpha as of 2026-04-10; the Forge README explicitly directs production users to v7.x. Forge wins on "closer to Electron's official cadence and less third-party surface." It loses on auto-update: Forge requires wiring `update.electronjs.org` or a custom updater, neither of which covers Linux at all.

Decision: `electron-builder` wins for this spec because cross-platform auto-update on macOS + Windows + Linux is a V1 requirement (see §Auto-Updater below). Plan-023 must pin to `electron-builder` v26.9.x minor versions and review the changelog on every bump (electron-builder is outside "official Electron support," per the Electron docs).

**Reproducibility limit:** Neither `electron-builder` nor Electron Forge guarantees bit-reproducible binaries out of the box. No primary source found in the 2026-04 research pass claims Electron apps can be bit-reproducibly built today. If Spec-023 needs reproducibility (supply-chain verification, for example), Plan-023 must architect supporting infrastructure (SOURCE_DATE_EPOCH, deterministic filesystem ordering, stripped metadata). V1 does **not** claim reproducible builds; this is an accepted scope gap to revisit in V1.1.

Sources:

- [electron-builder v26.9.0 release](https://github.com/electron-userland/electron-builder/releases)
- [Electron Forge v7.11.1 / v8.0.0-alpha](https://github.com/electron/forge)
- [Electron Forge overview](https://www.electronjs.org/docs/latest/tutorial/forge-overview)
- [electron.build](https://www.electron.build)

### Auto-Updater

`electron-updater` v6.8.4 (released 2026-04-14, part of the `electron-builder` project) drives the auto-update flow. Code-signature validation on **both macOS and Windows**. Staged rollouts (0–100% gradual) supported. Squirrel.Windows is explicitly unsupported and must not be used.

Update feed hosting: project-operated static artifact store (S3-backed) with an Ed25519-signed manifest. Update signing key is distinct from the code-signing certificate and is rotated on a documented schedule.

**Delta update posture:** `electron-updater` ships block-map-based differential updates on Windows/NSIS only. macOS DMGs and Linux AppImages download full payloads. Plan-023 must budget bandwidth accordingly (this is a material difference from browser-style delta updates and should not be assumed).

**Rollback absence:** Neither `electron-updater` nor Electron's built-in `autoUpdater` module ships automatic rollback on failed update. The "Update Flow" requirement of this spec (roll back on signature-verification failure or post-install daemon-handshake failure) is **architecture we must build**, not an out-of-box feature. Plan-023 must include the rollback state machine (prior-version artifact retention, launcher-based version selection, or a dual-slot approach) as a first-class component.

**MSIX (Windows Store) path:** Electron 41 added MSIX auto-updating via the same JSON response format as Squirrel.Mac (per Electron RFC #21). Not required for V1 (V1 ships NSIS / MSI installers direct-download). Re-evaluate MSIX for V1.1 if Windows Store distribution becomes a target.

**Alternative (not chosen):** Electron's built-in `autoUpdater` module uses Squirrel.Mac on macOS and Squirrel.Windows (or MSIX updater, auto-detected) on Windows; it has **no built-in Linux support**. The hosted `update.electronjs.org` service is restricted to public GitHub repos, macOS (DMG) + Windows (NSIS) only, and requires signed macOS builds. Neither covers V1's Linux requirement.

Sources:

- [electron-updater v6.8.4 release](https://github.com/electron-userland/electron-builder/releases)
- [electron-updater documentation](https://www.electron.build/auto-update)
- [Electron built-in autoUpdater API](https://www.electronjs.org/docs/latest/api/auto-updater)
- [update.electronjs.org](https://github.com/electron/update.electronjs.org)
- [Electron 41 MSIX auto-updating](https://www.electronjs.org/blog/electron-41-0)

### Code Signing And Notarization

**Major 2026 change — CA/Browser Forum Ballot CSC-31 (effective 2026-03-01):** All publicly-trusted code-signing certificates issued on or after 2026-03-01 have a maximum validity of **460 days (~15 months)**, down from the prior 39-month cap. EV and non-EV certs are both affected. Hardware-token holders must physically rekey every 15 months rather than every 3 years. This reshapes the vendor-cost calculus and makes per-month subscription signing services competitive with EV-cert purchases for small/mid-tier publishers.

#### macOS

- **Identity:** Apple Developer ID Application certificate, issued free under the $99/year Apple Developer Program membership.
- **Process:** Hardened runtime enabled + Apple notarization via `xcrun notarytool` (the `altool` command has been deprecated since 2023-11-01 and must not be used) + `xcrun stapler` to attach the notarization ticket to the artifact so it works offline.
- **Entitlements:** The hardened runtime must declare only what the shell needs. V8/JIT commonly requires `com.apple.security.cs.allow-unsigned-executable-memory` and `com.apple.security.cs.allow-jit`; dynamic loading of native modules may require `com.apple.security.cs.allow-dyld-environment-variables`; keystore access uses `keychain-access-groups`.
- **Operational risk (Jan 2026+):** Apple's notarization queues have been experiencing delays of 24–120+ hours per active developer-forum threads. Plan-023's release pipeline must include **timeout + retry** logic rather than synchronous blocking on notarization.

#### Windows

- **Primary path:** **Azure Artifact Signing** (renamed from "Azure Trusted Signing" when it went **GA on 2026-01-12**), Basic SKU $9.99/month (5,000 signatures, 1 certificate profile). FIPS 140-2 Level 3 HSM-backed, zero-touch cert lifecycle, no hardware token, no EV-cert purchase. Chains to a CA in the Microsoft Trusted Root Program — recommended path for Smart App Control friendliness.
  - **Eligibility gate:** Public Trust is available to organizations in **USA, Canada, EU, UK** and to **individual developers in USA and Canada only**. Outside those regions, Artifact Signing is not available for public-trust signing and this project must use a traditional EV cert. Per-deployment decision; confirm eligibility before locking in.
  - **Does not issue EV certificates.** If distribution requires EV (e.g., for instant SmartScreen reputation), Artifact Signing is not sufficient and a traditional EV cert from DigiCert / Sectigo / SSL.com is required in addition.
- **Fallback path:** EV code-signing cert from DigiCert / Sectigo / SSL.com. Typical OV pricing $300–$700/year; EV pricing $400–$1,200/year. Under CSC-31, renewal is now every 15 months rather than 3 years — factor this into vendor comparison vs. Artifact Signing's monthly subscription.
- **Smart App Control reality:** Valid code signing is **not sufficient** for Smart App Control to allow a binary. SAC evaluates cert trust chain _and_ cloud reputation (Intelligent Security Graph). New binaries with low distribution get blocked until reputation builds, even with a valid EV signature. First-launch UX on Windows 11 will be rough until reputation accumulates; mitigation is Artifact Signing's Public Trust chain + clear user-facing "Run anyway" instructions.
- **Windows 10 EOL:** Windows 10 reached end-of-support on 2025-10-14. Per Spec-023 §Scope, V1 supports Windows 10 + 11 (x64). Because Windows 10 is EOL, this spec accepts the security-posture implication of shipping to an EOL OS for V1. Plan-023 must surface this as a known-state item; a V1.1 decision may tighten to Windows 11 only.

#### Linux

There is no universal code-signing model for Linux. Three distinct formats, three distinct signing mechanisms:

- **`.AppImage`** — optional embedded GPG signature (rarely verified by users); this project additionally publishes the artifact hash alongside the download.
- **`.deb` / `.rpm`** — GPG-sign the package with the project's release key; publish the public key for repositories.
- **Snap / Flatpak** — Canonical signs Snap artifacts on your behalf at the Snap Store; Flathub signs Flatpak artifacts at publication.

`electron-builder` supports all of the above. No automatic signing beyond what each format specifies.

Sources:

- [CA/Browser Forum CSC-31 ballot](https://cabforum.org/working-groups/code-signing/requirements/)
- [Microsoft — Azure Artifact Signing GA announcement (2026-01-12)](https://techcommunity.microsoft.com/blog/microsoft-security-blog/simplifying-code-signing-for-windows-apps-artifact-signing-ga/4482789)
- [Azure Artifact Signing FAQ — eligibility & EV scope](https://learn.microsoft.com/en-us/azure/artifact-signing/faq)
- [Apple Developer ID](https://developer.apple.com/developer-id/)
- [Apple Developer forum — notarization queue delays](https://developer.apple.com/forums/thread/813441)
- [Windows 10 lifecycle](https://learn.microsoft.com/en-us/lifecycle/products/windows-10-home-and-pro)

### Crash Reporting

Electron's built-in `crashReporter` module uses **Crashpad** (not Breakpad as older docs suggest). It automatically covers main, renderer, Node `child_process`, and `utilityProcess` crashes. Payloads upload as `multipart/form-data` POST (minidump + metadata — version, platform, process type, custom params with key ≤39 bytes, value ≤127 bytes). Compression has been enabled by default since Electron 12.

**V1 sink choice — deferred to a follow-up decision:**

- **Option A — Sentry Electron SDK.** Production-grade symbolication, issue grouping, release tracking, per-process initialization (`@sentry/electron/main`, `/renderer`, `/utility`). Lower operational burden. Cost: third-party dependency holding minidumps.
- **Option B — Self-hosted symbolication.** Project-operated minidump sink. Higher operational burden. Benefit: no third party sees crash payloads.

**Critical PII rule (applies to both options):** Minidumps contain process heap memory, which for this shell contains PASETO tokens, DPoP keys, WebAuthn PRF output, OAuth bearer headers, and daemon session tokens. Uploading unfiltered minidumps to a third party is a data-exfiltration vector. V1 must:

1. Configure `crashReporter.start({ uploadToServer: true, ... })` only after initializing `beforeSend`-equivalent scrubbers (Sentry's `beforeSend` / `denyUrls` / `ignoreErrors` hooks, or equivalent pre-upload scrub for the self-hosted path).
2. Strip session IDs → stable hashes; file paths → extension-only; user messages and agent reasoning payloads → elided.
3. For the self-hosted path, keep the sink inside the same security boundary as the control plane.

Final sink decision is a BL-to-be-filed and owned by Plan-023; this spec declares the requirements the choice must satisfy.

Sources:

- [Electron `crashReporter` API (Crashpad)](https://www.electronjs.org/docs/latest/api/crash-reporter)
- [Sentry Electron SDK documentation](https://docs.sentry.io/platforms/javascript/guides/electron/)

### WebAuthn Platform-Authenticator Native Module

Electron does **not** provide native platform-authenticator WebAuthn prompts on macOS, Windows, or Linux out of the box, despite the underlying Chromium supporting them. The canonical open issues ([electron/electron #15404](https://github.com/electron/electron/issues/15404), [#24573](https://github.com/electron/electron/issues/24573)) remain open as of 2026-04. Additionally, Chromium 146 (shipped in Electron 41) **removed** the `web-authentication-new-passkey-ui` flag that was an earlier workaround — any code path relying on that flag breaks on Electron 41+.

V1 therefore depends on a **native module** to bridge the platform authenticator to the WebAuthn ceremony. Candidates:

- **`electron-webauthn-mac`** (open-sourced by Vault12 in January 2026) — uses Apple `AuthenticationServices` to bridge WebAuthn / passkeys to Touch ID and iCloud Keychain on macOS. [GitHub](https://github.com/vault12/electron-webauthn-mac).
- **`@electron-webauthn/native`** — published as cross-platform, but the research pass could not confirm platform coverage beyond the marketing claim. [npm](https://www.npmjs.com/package/@electron-webauthn/native).

**Required Plan-023 work before lock-in:** Prototype platform-authenticator flows on all three target OSes and confirm:

1. Touch ID works via the Vault12 module on macOS arm64 + x64.
2. Windows Hello works on Windows 10 + 11 via the chosen cross-platform module.
3. FIDO2 roaming authenticators (and, where available, platform authenticators) work on Linux.

If the cross-platform module fails (2) or (3), V1 must either pick a different module or accept the Device Authorization Grant fallback as the Windows/Linux path (per §Fallback Behavior). The prototype's outcome is an open question for V1 (see §Open Questions).

### Renderer Bundle

React + Vite per ADR-016; TypeScript strict. Vite produces ES module output; the main process loads the bundle via a custom protocol (not `file://`, because the `GrantFileProtocolExtraPrivileges` fuse is disabled) with strict CSP (no `eval`, no inline scripts, no `unsafe-eval`).

**Renderer clipboard deprecation (Electron 40+):** Direct clipboard-API usage in renderer processes was deprecated in Electron 40. Clipboard access must be exposed via the preload bridge's `native.copyToClipboard` surface and implemented in the main process. The renderer must not call `navigator.clipboard.*` directly; CI lint must catch such imports.

## Pitfalls To Avoid

- **Giving the renderer any form of Node or process access.** `nodeIntegration: true` or `sandbox: false` in any window must be treated as a build-time error.
- **Leaking auth material across the bridge.** Audit the preload surface — any function returning a PASETO token, DPoP proof, WebAuthn PRF output, or daemon session token to the renderer is a security regression.
- **Skipping asar integrity verification in release builds.** `EnableEmbeddedAsarIntegrityValidation` must be enabled for every release; disabling it (even temporarily for debugging) in a signed release binary defeats the tamper-detection posture.
- **Coupling renderer lifecycle to daemon lifecycle.** Daemon disconnect must degrade the renderer to read-only mode, not crash it. Daemon crash with automatic restart must not lose renderer state.
- **Letting the renderer hold session-scoped state that should be re-derived from the daemon on reconnect.** State kept for fast UX (e.g., scroll position) is fine; state kept as truth (e.g., pending-approval list) creates divergence when the daemon reconnects.
- **Registering the `sidekicks://` protocol handler without conflict resolution.** On first run, if a prior installation already claims the handler, the new installation must either displace it explicitly or surface the conflict.
- **Treating the auto-update signature key as if it were the code-signing certificate.** They are separate keys with separate rotation schedules; conflating them risks a rotation mishap invalidating installed binaries.
- **Shipping renderer code that imports Node built-ins.** Vite's build must fail fast on accidental Node imports in the renderer bundle.

## Acceptance Criteria

- [ ] The shell creates every `BrowserWindow` with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, and a preload script that uses only `contextBridge.exposeInMainWorld` — verified by contract test
- [ ] No auth material (daemon session token, PASETO tokens, DPoP key, WebAuthn PRF output) appears on the `window.sidekicks` surface — verified by a negative contract test against the bridge's exposed type
- [ ] Every Electron Fuse declared in §Security Hardening Baseline is set to the declared value in every released binary — verified by a build-time assertion
- [ ] WebAuthn PRF-based sign-in flow succeeds on Windows, macOS, and Linux against a platform authenticator — verified by Plan-023 integration tests per ADR-016 Success Criteria
- [ ] The shell supervises the daemon via `utilityProcess.fork`, restarts on crash with the declared backoff, and surfaces persistent-error state after five failed attempts — verified by integration test
- [ ] Auto-update download + signature verification + staged-apply + post-apply daemon handshake is exercised end-to-end on every release platform in CI — verified by Plan-023 release-gate test
- [ ] Code-signed release artifacts pass Gatekeeper (macOS), SmartScreen (Windows 10/11), and the configured Linux package-manager signature check — verified by Plan-023 release smoke test
- [ ] Every Signature Feature view (timeline, approvals, invites, runs, multi-agent channels) composes the owning-plan contract without duplicating daemon logic — verified by renderer unit tests against mocked bridge methods
- [ ] `sidekicks://invite/<token>` deep-link handling accepts an invite without the raw token crossing the bridge — verified by integration test asserting the bridge-surface transcript
- [ ] Shell bundle size (post-asar, post-compression) is under the ADR-016 Success Criteria target of 150 MB — verified by CI artifact size check
- [ ] The preload bridge surface has no `any`-typed escape hatch in its public type — verified by TypeScript strict-mode build
- [ ] Renderer attempts to access `require`, `process`, or `global` return `undefined` — verified by runtime assertion in a sandbox test

## ADR Triggers

- If the shell needs a renderer-trusted trust stance (for any reason — e.g., DOM-side cryptography that cannot round-trip through the main process), an ADR must supersede ADR-016's stance and reconcile with `container-architecture.md` and `security-architecture.md` in one coherent motion.
- If `utilityProcess` proves inadequate for daemon supervision and the project needs a separate external daemon, update or replace ADR-016 §Daemon Supervision guidance.
- If a subsequent platform is added (e.g., web-hosted renderer), the renderer-side assumptions here must be re-derived; this spec is desktop-only.
- If a decision is made to move off `electron-updater` (for example to `update.electronjs.org` hosted service), document the feed and signing-key implications in an ADR before the migration.

## Open Questions

- **Crash-reporter sink (Sentry Electron SDK vs self-hosted symbolication):** deferred to a follow-up BL owned by Plan-023; decision depends on operational maturity of the self-hosted symbolication pipeline and on PII-handling review. The requirements both options must satisfy are declared in §Implementation Notes §Crash Reporting.
- **Azure Artifact Signing regional eligibility for this project's issuing organization:** Public Trust is USA/Canada/EU/UK organizations + US/Canada individuals only. Organizational account review pending before lock-in; fallback is a traditional EV cert from DigiCert / Sectigo / SSL.com (now 15-month validity per CSC-31, not 3-year).
- **WebAuthn native-module lock-in for Windows + Linux:** `@electron-webauthn/native` is published as cross-platform but coverage beyond macOS could not be authoritatively confirmed in the 2026-04 research pass. Plan-023 must prototype Windows Hello and Linux platform / roaming authenticator flows against the candidate module before locking it in; if cross-platform fails, per-platform strategy (Vault12 module on macOS, Device Authorization Grant fallback elsewhere) is the accepted degradation.
- **Windows 10 V1 support horizon:** Windows 10 reached EOL on 2025-10-14. V1 currently supports Windows 10 + 11 (x64). V1.1 may tighten to Windows 11 only; this is a scope-policy decision pending, not a technical blocker.
- **MSIX (Windows Store) distribution:** Not in V1 scope (V1 ships NSIS / MSI direct-download). Electron 41 added MSIX auto-updating; re-evaluate for V1.1.
- **Reproducible builds:** Not claimed by V1 (neither electron-builder nor Electron Forge guarantees them out of the box). Revisit for V1.1 if supply-chain verification becomes a requirement.
- **Linux package-manager presence:** V1 ships `.AppImage`, `.deb`, and `.rpm`; whether to also ship a Snap / Flatpak manifest is a follow-up gated on user-demand signal.
- **WebAuthn PRF fallback UX:** The Device Authorization Grant fallback is documented, but the UX gate (how the user discovers their authenticator is insufficient, how they are guided to the fallback) needs surfacing in Spec-026 (BL-081) first-run onboarding.

## References

### Research Conducted

A dedicated current-state research pass (Electron version / cadence, security hardening, IPC / preload bridge, code signing, auto-updater, native keystore, crash reporting, build tooling, utility-process patterns, WebAuthn, and 2026 greenfield red flags) was run on 2026-04-17 and integrated inline in §Required Behavior and §Implementation Notes. Primary sources are cited with each integration. The table below indexes the sources for reviewer traceability.

| Source | Type | Key Finding | URL |
| --- | --- | --- | --- |
| Electron release timeline | Documentation | 3-major support window, 8-week cadence, no LTS lane | https://www.electronjs.org/docs/latest/tutorial/electron-timelines |
| Electron release schedule | Documentation | v41 EOL 2026-08-25; forced upgrade cadence confirmation | https://releases.electronjs.org/schedule |
| Electron 41.0 release notes | Release notes | Chromium 146, Node 24.14, ASAR Integrity Digest, MSIX auto-update | https://www.electronjs.org/blog/electron-41-0 |
| Electron 40.0 release notes | Release notes | `utilityProcess` `"memory-eviction"` exit reason; renderer clipboard deprecation; macOS dSYM format change | https://www.electronjs.org/blog/electron-40-0 |
| Electron 39.0 release notes | Release notes | ASAR Integrity graduated to stable; `@electron/packager` v19 enables it by default | https://www.electronjs.org/blog/electron-39-0 |
| Electron Security Checklist | Documentation | 20-item hardening checklist — the basis for §Security Hardening Baseline | https://www.electronjs.org/docs/latest/tutorial/security |
| Electron Fuses documentation | Documentation | Fuse defaults and recommended production posture | https://www.electronjs.org/docs/latest/tutorial/fuses |
| Electron IPC tutorial | Documentation | `contextBridge` + `invoke` / `handle` patterns | https://www.electronjs.org/docs/latest/tutorial/ipc |
| Electron `utilityProcess` API | Documentation | Chromium-Services-backed process model; `MessagePortMain`; post-`app.ready` requirement | https://www.electronjs.org/docs/latest/api/utility-process |
| Electron Message Ports tutorial | Documentation | `ipcRenderer.postMessage` required for MessagePort transfer | https://www.electronjs.org/docs/latest/tutorial/message-ports |
| Electron `safeStorage` API | Documentation | Linux plaintext-fallback when no keystore; `getSelectedStorageBackend` check | https://www.electronjs.org/docs/latest/api/safe-storage |
| Electron `autoUpdater` API | Documentation | Built-in updater: Squirrel.Mac / Squirrel.Windows or MSIX; no Linux support | https://www.electronjs.org/docs/latest/api/auto-updater |
| Electron `crashReporter` API | Documentation | Crashpad-based; multipart/form-data upload; 39/127-byte metadata limits | https://www.electronjs.org/docs/latest/api/crash-reporter |
| Electron Forge overview | Documentation | Officially-recommended packaging; v7.11.1 stable, v8.0.0 alpha (ESM) | https://www.electronjs.org/docs/latest/tutorial/forge-overview |
| Electron GitHub Security Advisories | Primary source | Q1 2026 CVE batch (2026-04-02): 34769/34770/34771/34772/34774/34764 | https://github.com/electron/electron/security/advisories |
| electron-builder releases | Release notes | v26.9.0 (2026-04-14); v26.8.2 (2026-03-04) tar security patches | https://github.com/electron-userland/electron-builder/releases |
| electron.build auto-update docs | Documentation | Code-signature validation on macOS + Windows; staged rollouts; NSIS-only block-map delta | https://www.electron.build/auto-update |
| Electron Forge GitHub | Source | v7.11.1 stable (2026-01-12); v8.0.0-alpha.7 (2026-04-10) | https://github.com/electron/forge |
| update.electronjs.org | Source | Restrictions: public GitHub repos only; macOS + Windows only; no Linux | https://github.com/electron/update.electronjs.org |
| node-keytar archive | Primary source | Archived 2022-12-15; last release v7.9.0 (2022-02-17) | https://github.com/atom/node-keytar |
| `@napi-rs/keyring` npm | Package | v1.2.0 (2025-09-02); keytar-compatible replacement; no libsecret required on Linux | https://www.npmjs.com/package/@napi-rs/keyring |
| `@napi-rs/keyring` GitHub | Source | Rust napi-rs binding to keyring-rs crate | https://github.com/Brooooooklyn/keyring-node |
| MSAL JS issue #7170 | Primary source | Microsoft's migration off keytar (corroborating) | https://github.com/AzureAD/microsoft-authentication-library-for-js/issues/7170 |
| CA/Browser Forum CSC-31 | Primary source | Adopted 2025-11-17, effective 2026-03-01: 460-day max cert validity | https://cabforum.org/working-groups/code-signing/requirements/ |
| Microsoft — Artifact Signing GA | Primary source | Renamed from Trusted Signing; GA 2026-01-12; Basic SKU pricing | https://techcommunity.microsoft.com/blog/microsoft-security-blog/simplifying-code-signing-for-windows-apps-artifact-signing-ga/4482789 |
| Azure Artifact Signing FAQ | Documentation | Regional eligibility (USA/Canada/EU/UK orgs; US/Canada individuals); no EV cert issuance | https://learn.microsoft.com/en-us/azure/artifact-signing/faq |
| Apple Developer ID | Documentation | Developer ID cert free under $99/yr program; notarization required | https://developer.apple.com/developer-id/ |
| Apple Developer forum — notarization delays | Primary source | January 2026: 24–120+ hour queue delays reported | https://developer.apple.com/forums/thread/813441 |
| Microsoft — Windows 10 lifecycle | Primary source | Windows 10 EOL 2025-10-14 | https://learn.microsoft.com/en-us/lifecycle/products/windows-10-home-and-pro |
| Sentry Electron SDK documentation | Documentation | Per-process init (`@sentry/electron/main` / `/renderer` / `/utility`) | https://docs.sentry.io/platforms/javascript/guides/electron/ |
| `electron-webauthn-mac` (Vault12) | Source | Jan 2026 open-source release; bridges Apple `AuthenticationServices` for passkeys | https://github.com/vault12/electron-webauthn-mac |
| `@electron-webauthn/native` | Package | Published as cross-platform; scope beyond macOS not authoritatively confirmed in this pass | https://www.npmjs.com/package/@electron-webauthn/native |
| electron/electron #15404 | Primary source | Long-standing open issue on native WebAuthn support | https://github.com/electron/electron/issues/15404 |
| electron/electron #24573 | Primary source | Long-standing open issue on WebAuthn bindings | https://github.com/electron/electron/issues/24573 |
| GitLab Advisory DB — CVE-2026-34769 | Primary source | Example high-severity entry from Q1 2026 batch | https://advisories.gitlab.com/pkg/npm/electron/CVE-2026-34769/ |

### Related Specs

- [Spec-007: Local IPC And Daemon Control](./007-local-ipc-and-daemon-control.md) — the typed daemon contract the renderer reuses via the shared client SDK
- [Spec-008: Control Plane Relay And Session Join](./008-control-plane-relay-and-session-join.md) — control-plane authentication and relay transport
- [Spec-012: Approvals, Permissions, Trust Boundaries](./012-approvals-permissions-and-trust-boundaries.md) — Approvals view composition target
- [Spec-013: Live Timeline Visibility And Reasoning Surfaces](./013-live-timeline-visibility-and-reasoning-surfaces.md) — Timeline view composition target
- [Spec-015: Persistence Recovery And Replay](./015-persistence-recovery-and-replay.md) — replay-from-here behavior in the Timeline view
- [Spec-016: Multi-Agent Channels And Orchestration](./016-multi-agent-channels-and-orchestration.md) — Multi-Agent Channels view composition target (V1-readiness review in BL-042)
- [Spec-002: Invite, Membership, Presence](./002-invite-membership-and-presence.md) — Invites view composition target
- [Spec-004: Queue, Steer, Pause, Resume](./004-queue-steer-pause-resume.md) — Runs view composition target
- [Spec-026: First-Run Onboarding](./026-first-run-onboarding.md) — first-run relay choice surfaced by the shell (to be authored per BL-081)

### Related ADRs

- [ADR-016: Electron Desktop Shell](../decisions/016-electron-desktop-shell.md) — forward declaration this spec implements
- [ADR-010: PASETO + WebAuthn + MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md) — WebAuthn PRF credential path
- [ADR-009: JSON-RPC IPC Wire Format](../decisions/009-json-rpc-ipc-wire-format.md) — daemon IPC wire format the preload bridge forwards
- [ADR-014: tRPC Control Plane API](../decisions/014-trpc-control-plane-api.md) — control-plane transport the preload bridge forwards

### Related Architecture Docs

- [Container Architecture](../architecture/container-architecture.md) — renderer-untrusted trust boundary; canonical monorepo topology
- [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md) — shell / renderer / client-SDK component decomposition
- [Security Architecture](../architecture/security-architecture.md) — auth material handling; §Local Daemon Authentication reconciled with this spec under BL-056 on 2026-04-18
- [Deployment Topology](../architecture/deployment-topology.md) — desktop-shell placement in the per-participant local container set

### Related Backlog Items

- [BL-041](../archive/backlog-archive.md) — this spec (authoring)
- [BL-043](../archive/backlog-archive.md) — Plan-023 implementation plan (implements this spec)
- [BL-056](../archive/backlog-archive.md) — resolved 2026-04-18; `security-architecture.md` §Local Daemon Authentication now reflects the renderer-untrusted stance this spec declares
- [BL-078](../archive/backlog-archive.md) — Plan-024 Rust PTY sidecar (supervised by the daemon, not the shell; referenced for completeness)
- [BL-081](../archive/backlog-archive.md) — Spec-026 first-run onboarding (the shell surfaces the three-way-choice UX)
