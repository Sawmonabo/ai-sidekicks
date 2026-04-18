# Plan-023: Desktop Shell And Renderer

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `023` |
| **Slug** | `desktop-shell-and-renderer` |
| **Date** | `2026-04-17` |
| **Author(s)** | `Claude Opus 4.7` |
| **Spec** | [Spec-023: Desktop Shell And Renderer](../specs/023-desktop-shell-and-renderer.md) |
| **Required ADRs** | [ADR-016: Electron Desktop Shell](../decisions/016-electron-desktop-shell.md); [ADR-010: PASETO + WebAuthn + MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md); [ADR-009: JSON-RPC IPC Wire Format](../decisions/009-json-rpc-ipc-wire-format.md); [ADR-014: tRPC Control-Plane API](../decisions/014-trpc-control-plane-api.md); [ADR-015: V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md); [ADR-020: V1 Deployment Model And OSS License](../decisions/020-v1-deployment-model-and-oss-license.md) |
| **Dependencies** | Plan-007 (local daemon IPC — the shell supervises the daemon process defined here and forwards its JSON-RPC contract through the preload bridge); Plan-018 (PASETO v4.public access / v4.local refresh token issuance — the main process holds these and attaches them to control-plane calls); Plan-008 (control-plane relay + tRPC/WebSocket transport — the main process forwards renderer-originated control-plane calls to it); Plan-024 (Rust PTY sidecar — **supervised by the daemon, not by this shell**; this plan documents the non-dependency so reviewers do not wire a second supervisor). **Consumed by (downstream, not a dependency):** Plan-026 consumes the `onboarding.*` preload-bridge surface authored by this plan. |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Ship the Spec-023 Electron desktop shell and React + Vite renderer as a three-process system (main / renderer / supervised daemon) that lands the renderer-untrusted trust stance, the narrow typed preload bridge, the full Electron Fuses + ASAR-integrity + CSP hardening baseline, `utilityProcess`-based daemon supervision, `electron-updater` v6.8.4 auto-update with a project-owned rollback state machine, `@napi-rs/keyring` + `safeStorage` keystore access with Linux plaintext-fallback detection, code-signing + notarization on macOS / Windows / Linux, Crashpad + `@sentry/electron` v7.11.0 crash reporting with main-process PII scrubbing, and the WebAuthn PRF ceremony via a per-platform native-module strategy (Vault12 `electron-webauthn-mac` on macOS; Device Authorization Grant fallback on Windows / Linux until Electron issue [#24573](https://github.com/electron/electron/issues/24573) ships a cross-platform binding). Renderer composes the V1 Signature Feature views (timeline, approvals, invites, runs, multi-agent channels) as thin projections over the bridge — it is the shell surface, not the authority.

## Scope

- `apps/desktop/` — **new app package.** The Electron main process (`apps/desktop/electron/main/`), the preload bridge (`apps/desktop/electron/preload/`), and the React + Vite renderer (`apps/desktop/src/`).
- Electron runtime target: **41.1.0+** per ADR-016 §Decision, to pick up the Q1 2026 CVE batch (CVE-2026-34769, -34770, -34771, -34772, -34774, -34764, -34776; all fixed 2026-04-02 in 39.8.5 / 40.8.5 / 41.1.0) per [Electron GHSA feed](https://github.com/electron/electron/security/advisories). Plan target updates to Electron 42.x (GA 2026-05-05) at V1 RC cut.
- Build toolchain: **`electron-vite`** (alex8088) v5.0.0 stable — Vite-powered main / preload / renderer build with HMR, source-code protection, and a single `electron.vite.config.ts`. Alternative considered + rejected in §Risks And Blockers.
- Packaging + auto-update: **`electron-builder`** v26.9.0 + **`electron-updater`** v6.8.4 per Spec-023 §Implementation Notes §Build And Packaging and §Auto-Updater.
- Renderer stack: React 19 + Vite 6 + TypeScript strict (per ADR-016 §Success Criteria).
- Preload bridge: single `window.sidekicks` object via `contextBridge.exposeInMainWorld`; narrow typed capability surface (no `any`) per Spec-023 §Preload Bridge Contract.
- Security hardening: every `BrowserWindow` created with the exact `webPreferences` locked in Spec-023 §Security Hardening Baseline; every release build packaged with the nine Electron Fuses + the ASAR Integrity Digest (new in Electron 41 via `@electron/asar` v4.1.0+); strict CSP per Spec-023.
- Daemon supervision: `utilityProcess.fork()` (not `child_process.fork`) with the exponential-backoff restart policy + 5-attempt ceiling + `"memory-eviction"` special-case from Spec-023 §Implementation Notes §Utility Process Vs Child Process.
- Keystore: **`@napi-rs/keyring`** v1.2.0 primary; Electron `safeStorage` for one-shot-blob cases; Linux `safeStorage.getSelectedStorageBackend()` must reject `basic_text` / `unknown` per Spec-023 §Implementation Notes §Native Keystore.
- Auto-update: downloaded artifacts are Ed25519-signature-verified against a build-time-embedded public key; on post-apply daemon-handshake failure the rollback state machine restores the prior-version binary. The rollback state machine is **authored by this plan**; it is not an out-of-the-box `electron-updater` feature.
- WebAuthn: main-process orchestration via a per-platform strategy — Vault12 `electron-webauthn-mac` v1.0.0 on macOS arm64 + x64; **Device Authorization Grant (DAG) loopback fallback** on Windows and Linux in V1. V1 does **not** claim cross-platform native platform-authenticator flows; the posture is documented as an accepted scope degradation tracked in §Open Questions of Spec-023.
- Code-signing + notarization: Apple Developer ID Application cert + `xcrun notarytool` (macOS); Azure Artifact Signing Basic SKU OR EV cert from DigiCert / Sectigo / SSL.com (Windows, subject to CSC-31's new 15-month validity ceiling); GPG-signed `.deb` / `.rpm` + optional AppImage signature (Linux).
- Crash reporting: **`@sentry/electron`** v7.11.0 with `SentryMinidump` default integration (Crashpad-sourced); per-process `init()` in main + every renderer + the `utilityProcess` daemon; main-process `beforeSend` scrubber strips tokens, session IDs, file-paths, content payloads before upload; minidump-byte-level scrubbing is a server-side posture documented as a gap (see §Risks And Blockers).
- Deep-link: register the `sidekicks://` protocol handler on all three platforms; URL parsing + token extraction + capability-exchange happen in the main process, never in the renderer.
- E2E test harness: **Playwright `_electron`** namespace (still officially marked experimental in v1.58.x per [Playwright class-electron docs](https://playwright.dev/docs/api/class-electron), but the only production-viable option; Spectron has been archived since 2022).
- Monorepo placement: `apps/desktop/` as a workspace package, sibling to `packages/runtime-daemon/`, `packages/contracts/`, `packages/control-plane/` per the monorepo topology in [container-architecture.md](../architecture/container-architecture.md) §Client Delivery Sequence.

## Non-Goals

- **Renderer visual design, component library, theme system.** Spec-023 §Non-Goals explicitly defers this to a design track. Plan-023 delivers the skeleton composition per Spec-023 §Signature Feature Composition Sketches; final pixel-level UX is out of scope.
- **Daemon internals.** Owned by `component-architecture-local-daemon.md` and Spec-007 / Plan-007. This plan consumes Plan-007's daemon contract; it does not re-specify it.
- **PTY supervision from the shell.** Per Plan-024 §Target Areas, `PtyHostSelector` + `RustSidecarPtyHost` + `NodePtyHost` are owned by the **daemon** (`packages/runtime-daemon/src/pty/`). The shell never consumes the PtyHost contract directly. A Plan-023 edit wiring PTY supervision into the main process is a review rejection.
- **The CLI client.** CLI first-run onboarding lives in Plan-026; CLI session surfaces are owned by a separate plan. Plan-023 is desktop-only.
- **Mobile or browser-hosted renderer surfaces.** Out of V1 per ADR-015; out of Spec-007 scope; out of this plan's scope.
- **Provider-driver protocols.** Owned by Spec-005.
- **Workflow authoring UX.** Owned by the V1.1 workflow-engine track per ADR-015; Plan-023 does not compose a workflow-authoring view.
- **MSIX (Windows Store) distribution.** V1 ships NSIS + MSI direct-download; MSIX is a V1.1 re-evaluation per Spec-023 §Open Questions.
- **Reproducible builds.** Not claimed by V1 per Spec-023 §Open Questions; neither `electron-builder` nor `electron-vite` guarantees bit-reproducibility.
- **Snap / Flatpak packaging.** V1 ships `.AppImage` + `.deb` + `.rpm`; Snap / Flatpak is a user-demand-gated follow-up per Spec-023 §Open Questions.
- **Reconciling `security-architecture.md` §Local Daemon Authentication.** Reconciled under BL-056 on 2026-04-18 before Plan-023 execution. Plan-023 consumes the renderer-untrusted stance as declared in Spec-023 §Trust Stance and now consistent in `security-architecture.md` §Local Daemon Authentication; no further alignment work is required in this plan.

## Preconditions

- [x] Spec-023 is approved (this plan is paired with it).
- [x] ADR-016 (Electron desktop shell + forward-declarative 41.1.0+ floor) is accepted.
- [x] ADR-010 (PASETO + WebAuthn + MLS) is accepted — the credential path this plan implements.
- [x] ADR-009 (JSON-RPC IPC wire format) is accepted — the wire format the preload bridge forwards.
- [x] ADR-014 (tRPC control-plane API) is accepted — the transport the main process forwards to.
- [x] ADR-020 (V1 deployment model) is accepted — declares the hosted-SaaS and self-host options Plan-026 routes through this shell.
- [ ] Plan-007 exposes the `DaemonStart`/`DaemonStop`/`DaemonRestart`/`DaemonStatusRead` surface the shell supervisor consumes. Plan-007 ownership of the daemon-start contract is load-bearing; if Plan-007 ships without an explicit `DaemonHello` readiness signal, Step 7 below blocks until it lands.
- [ ] Plan-018 exposes a main-process-consumable API for issuing / refreshing PASETO v4.public tokens + storing the matched DPoP key. The shell does not mint tokens; it stores and presents them.
- [ ] Plan-008 exposes a tRPC v11 client + WebSocket (JSON-RPC 2.0) client surface the main process can instantiate. The shell is a forwarder, not a protocol implementer.
- [ ] `packages/contracts/src/` exports `DaemonMethod` / `DaemonParams` / `DaemonResult` / `DaemonEvent` / `DaemonEventPayload` typed union per Spec-007 (owned by Plan-007). This plan's preload-bridge types re-export them.

## Target Areas

### New package

- `apps/desktop/` — **created by this plan.** Workspace package, sibling to `packages/*`.
- `apps/desktop/package.json` — declares the Electron 41.1.0+ runtime, `electron-vite` v5 as the build tool, `electron-builder` v26.9.0 + `electron-updater` v6.8.4 as packaging + update toolchain, `@napi-rs/keyring` v1.2.0, `@sentry/electron` v7.11.0, `@electron/asar` v4.1.0+, `@electron/fuses` for fuse-flipping at build time, `electron-webauthn-mac` v1.0.0 as an optional macOS-only dep. Renderer deps: `react` v19, `react-dom` v19. Playwright `_electron` for E2E testing.

### Main process

- `apps/desktop/electron/main/index.ts` — **created.** Main entrypoint. Calls `app.requestSingleInstanceLock()`; reads startup config; initializes Sentry + crashReporter **first** (before any other module loads, per [`@sentry/electron` docs](https://docs.sentry.io/platforms/javascript/guides/electron/)); registers the `sidekicks://` protocol handler; creates the main window; starts the daemon supervisor.
- `apps/desktop/electron/main/window.ts` — **created.** `createMainWindow()` factory that returns a `BrowserWindow` with the exact `webPreferences` locked in Spec-023 §Security Hardening Baseline. A build-time assertion asserts these values match the spec.
- `apps/desktop/electron/main/protocol.ts` — **created.** Custom protocol (`sidekicks-renderer://`) the renderer bundle is served from — not `file://`, per Spec-023's `GrantFileProtocolExtraPrivileges` fuse-disabled posture.
- `apps/desktop/electron/main/bridge/index.ts` — **created.** IPC handler registration. One `ipcMain.handle` per preload-bridge method from Spec-023 §Preload Bridge Contract.
- `apps/desktop/electron/main/bridge/daemon.ts` — **created.** `daemon.call` / `daemon.subscribe` handlers. Forwards to the Plan-007 daemon client with the session token attached server-side.
- `apps/desktop/electron/main/bridge/control-plane.ts` — **created.** `controlPlane.call` / `controlPlane.subscribeRelay` handlers. Attaches `Authorization: Bearer <paseto-v4.public>` + `DPoP: <signed-proof>` headers; strips auth material from responses before returning to renderer.
- `apps/desktop/electron/main/bridge/native.ts` — **created.** `showOpenDialog` / `showSaveDialog` / `showMessageBox` / `showNotification` / `openExternal` (with allowlist validation) / `copyToClipboard` / `revealInFileExplorer` (operating on opaque `FilePathRef` tokens).
- `apps/desktop/electron/main/bridge/webauthn.ts` — **created.** `webAuthn.createCredential` / `getAssertion` / `deriveKeyMaterial` (PRF). Dispatches to the per-platform strategy from `webauthn/*.ts`.
- `apps/desktop/electron/main/bridge/update.ts` — **created.** `update.getState` / `subscribe` / `requestCheck` / `requestRestart`. Forwards to the `updater.ts` state machine.
- `apps/desktop/electron/main/bridge/onboarding.ts` — **created (Plan-023 authors the surface; Plan-026 implements the flow logic).** `onboarding.presentChoice` / `onboarding.telemetryPrompt` per Spec-026 §Desktop Surface. Plan-023 registers the stubs + wires the modal window; Plan-026 lands the flow body.
- `apps/desktop/electron/main/daemon-supervisor.ts` — **created.** `utilityProcess.fork(daemonEntryPath)` with the full backoff + crash + version-mismatch + `"memory-eviction"` special-case logic from Spec-023 §Daemon Supervision Lifecycle. Emits lifecycle events that the renderer observes through the bridge.
- `apps/desktop/electron/main/keystore.ts` — **created.** Abstraction over `@napi-rs/keyring` + Electron `safeStorage`. Exports `getSecret(key)` / `setSecret(key, value)` / `deleteSecret(key)`. At startup asserts `safeStorage.isEncryptionAvailable()` + on Linux asserts `safeStorage.getSelectedStorageBackend()` ∉ {`basic_text`, `unknown`}; on failure, surfaces the degradation to `update.subscribe`-style event and sets a `keystoreAvailable: false` flag consumed by Plan-026.
- `apps/desktop/electron/main/updater.ts` — **created.** `electron-updater` wrapper + rollback state machine. Tracks prior-version artifact path in `apps/desktop/electron/main/state/updater-state.json`. On post-apply daemon-handshake failure, swaps the current binary with the prior-version artifact and re-launches. Scheduled update checks on 4-hour cadence + startup + explicit user request.
- `apps/desktop/electron/main/webauthn/index.ts` — **created.** Strategy dispatcher: on `darwin` → `mac.ts`; on `win32` / `linux` → `fallback-dag.ts`. Exports `createCredential` / `getAssertion` / `deriveKeyMaterial` with identical signatures regardless of backend.
- `apps/desktop/electron/main/webauthn/mac.ts` — **created.** Binding to Vault12 `electron-webauthn-mac` v1.0.0. Guarded at load time by `process.platform === 'darwin'`.
- `apps/desktop/electron/main/webauthn/fallback-dag.ts` — **created.** Device Authorization Grant flow: open the system browser to the control-plane's `authorize` endpoint; bind a loopback server to `127.0.0.1:<ephemeral>` (NOT `localhost` — avoids IPv6 `::1` DNS ambiguity per the Apr-2026 research pass); accept one inbound callback bearing the authorization-code + state; 5-min timeout via `AbortSignal.timeout(300_000)`; PKCE S256 via `oauth4webapi` v3.8.5 `randomPKCECodeVerifier()` + `calculatePKCECodeChallenge()`.
- `apps/desktop/electron/main/crash-reporter.ts` — **created.** Initializes `@sentry/electron/main` with `beforeSend` scrubber per Spec-023 §Implementation Notes §Crash Reporting. The scrubber deletes `token`, `dpop`, `session_token`, `prf_output` top-level keys; replaces session IDs with stable SHA-256 hashes; truncates file paths to extension; elides `event.request.data.content`. Renderer-side init lives in `apps/desktop/src/sentry.ts`.
- `apps/desktop/electron/main/deep-link.ts` — **created.** `app.setAsDefaultProtocolClient('sidekicks')`. On macOS: `open-url` event handler. On Windows / Linux: `second-instance` event handler (the URL arrives via `argv` on secondary-instance launch). URL parse + token extraction + `controlPlane.acceptInvite(token)` call in the main process; renderer receives only the post-exchange session capability.

### Preload

- `apps/desktop/electron/preload/index.ts` — **created.** Single `contextBridge.exposeInMainWorld('sidekicks', bridge)` call per Spec-023. The bridge object's type is re-exported from `packages/contracts/src/desktop-bridge.ts`.

### Contracts

- `packages/contracts/src/desktop-bridge.ts` — **created by this plan.** The `SidekicksBridge` interface from Spec-023 §Preload Bridge Contract, re-exporting the Plan-007 daemon types, the Plan-008 control-plane types, and new types `OpenDialogOptions` / `SaveDialogOptions` / `MessageBoxOptions` / `NotificationOptions` / `FilePathRef` / `PrfInput` / `UpdateState`. Exported as **type-only** (no runtime). The negative-test (Spec-023 §Acceptance Criteria: "No auth material appears on the bridge") is a TypeScript conditional-type test in `packages/contracts/src/desktop-bridge.test-d.ts`.

### Renderer

- `apps/desktop/src/main.tsx` — **created.** React entrypoint. Initializes Sentry renderer-side (`@sentry/electron/renderer`). Renders `<App />` into `#root`.
- `apps/desktop/src/App.tsx` — **created.** Top-level router + layout shell. Composes the five Signature Feature views as routes.
- `apps/desktop/src/features/timeline/TimelineView.tsx` — **created, composition-only.** Consumes `window.sidekicks.daemon.subscribe('session.events', ...)` per Spec-013. Filter / scroll-to-tail / jump-to-ID interactions.
- `apps/desktop/src/features/approvals/ApprovalsView.tsx` — **created, composition-only.** Consumes `daemon.call('approvals.listPending')` per Spec-012.
- `apps/desktop/src/features/invites/InvitesView.tsx` — **created, composition-only.** Consumes `controlPlane.call('invites.list')` per Spec-002.
- `apps/desktop/src/features/runs/RunsView.tsx` — **created, composition-only.** Consumes `daemon.subscribe('run.state', ...)` per Spec-004.
- `apps/desktop/src/features/channels/ChannelsView.tsx` — **created, composition-only.** Consumes `daemon.subscribe('channel.*', ...)` per Spec-016.
- `apps/desktop/src/sentry.ts` — **created.** Renderer-side `@sentry/electron/renderer` init. No `beforeSend` override (main-process scrubber catches everything that upload-ships; renderer stays thin).

### Build / Config

- `apps/desktop/electron.vite.config.ts` — **created.** `electron-vite` v5 config: main / preload / renderer targets; source-code protection (opt-in; obfuscates main + preload output); HMR on dev; strict TypeScript.
- `apps/desktop/electron-builder.yml` — **created.** Multi-platform config: macOS (`.dmg`, `.zip`, arm64 + x64, hardened runtime + notarization), Windows (NSIS + MSI, x64, Artifact Signing OR EV cert), Linux (`.AppImage`, `.deb`, `.rpm`, x64 + arm64). ASAR packing; auto-update feed URL.
- `apps/desktop/build/fuses.ts` — **created.** Uses `@electron/fuses`'s `flipFuses()` to apply the nine-fuse posture from Spec-023 §Security Hardening Baseline. Called after packaging, **before** signing (fuse-flip invalidates the signature; signing must be the last step).
- `apps/desktop/build/asar-digest.ts` — **created.** Runs `asar integrity-digest on <app-path>` via `@electron/asar` v4.1.0+ after fuse-flip, before signing, so the embedded digest is part of what gets signed.
- `apps/desktop/build/code-sign.ts` — **created.** Orchestrates signing: macOS (`xcrun notarytool submit` + `xcrun stapler staple`, with a 16-hour timeout + retry per Spec-023 §Code Signing — Apple notarization queue delays); Windows (Azure Artifact Signing basic-SKU signing, or EV-cert fallback via `signtool`); Linux (GPG-sign `.deb` / `.rpm`).
- `apps/desktop/eslint.config.mjs` — **created.** Flat-config ESLint; `no-restricted-imports` rule bans `require` / `process` / `global` / `electron` modules from the renderer (`apps/desktop/src/**`). This is a **CI gate** — any renderer file importing Node built-ins fails the build.

### Test

- `apps/desktop/test/e2e/` — **created.** Playwright `_electron` spec files.
  - `launch.spec.ts` — asserts app launches, main window appears, renderer bundle loads via custom protocol, `window.sidekicks` is defined, `window.require` is `undefined`.
  - `fuses.spec.ts` — asserts `@electron/fuses.getCurrentFuseWire()` on the packaged binary returns the posture from Spec-023.
  - `bridge-surface.spec.ts` — asserts the `window.sidekicks` surface matches the type re-exported from `packages/contracts/src/desktop-bridge.ts`; asserts no property name containing `token` / `dpop` / `prf` is exposed.
  - `daemon-supervision.spec.ts` — asserts daemon start, `DaemonHello` received within 10s, daemon crash triggers restart, 5 consecutive crashes surface persistent-error state, `"memory-eviction"` exits do NOT increment the failure counter.
  - `deep-link.spec.ts` — asserts `sidekicks://invite/<token>` invocation routes through main process, raw token does not appear in any bridge-transcript event.
  - `webauthn-mac.spec.ts` (darwin-only) — asserts Vault12 addon loads, `getAssertion` returns an assertion shape.
  - `webauthn-fallback.spec.ts` (win32 + linux) — asserts DAG loopback server binds to `127.0.0.1` (not `localhost`), accepts one callback, closes within 5 minutes, rejects `plain` PKCE method.
  - `keystore.spec.ts` — asserts `safeStorage.isEncryptionAvailable()`; on Linux, asserts the plaintext-fallback backend is refused.
  - `updater-rollback.spec.ts` — simulated post-apply daemon-handshake failure triggers rollback to prior-version artifact.

## Data And Storage Changes

No Postgres or Durable Object schema changes — the desktop shell stores only:

### OS-level keystore entries (platform-backed)

- Key `ai-sidekicks:paseto-refresh-token` — PASETO v4.local refresh token.
- Key `ai-sidekicks:daemon-session-token` — cached across daemon restarts for fast handshake (rotated on daemon restart per Security Architecture §Session Token; the cache is a latency optimization only).
- Key `ai-sidekicks:participant-identity-key:<participant-id>` — participant-identity private key material (one per participant identity).
- Key `ai-sidekicks:prf-wrapping-key:<participant-id>` — WebAuthn PRF-derived refresh-token-wrapping key.

All four keys are accessed through `keystore.ts` only. Renderer code must not import `keystore.ts` (enforced by ESLint restricted-imports).

### Shell-local config

- `<app-user-data>/config/settings.json` — window state (size, position, maximized), non-sensitive user preferences. Read on startup, written on `before-quit`.
- `<app-user-data>/config/updater-state.json` — current version, prior-version artifact path, last-check timestamp, staged-update metadata. Managed by `updater.ts` rollback state machine.
- `<app-user-data>/config/supervisor-state.json` — daemon PID, last-heartbeat timestamp, restart attempt count. Diagnostic only; not authoritative for daemon state.

`<app-user-data>` resolves per Electron `app.getPath('userData')`: `~/Library/Application Support/AI Sidekicks` (macOS), `%APPDATA%\AI Sidekicks` (Windows), `~/.config/AI Sidekicks` (Linux).

### Build-time asset

- `apps/desktop/electron/main/updater-public-key.ts` — **created, committed to source.** The Ed25519 public key used to verify update-artifact signatures, embedded at compile time as a `Uint8Array` constant. Update-key rotation is a build-time change, not a runtime change. This key is distinct from the code-signing certificate (Spec-023 §Pitfalls To Avoid names conflating them as a rotation-mishap vector).

## API And Transport Changes

### Preload bridge contract (new, owned by this plan)

The full `SidekicksBridge` interface from Spec-023 §Preload Bridge Contract lives in `packages/contracts/src/desktop-bridge.ts`. Key requirements:

- All methods return `Promise<T>` or a synchronous primitive; no callbacks (`ipcRenderer`-style pub-sub uses the `subscribe(...): Unsubscribe` pattern).
- No property or method signature references `Token`, `DPoP`, `PRF`, or `SessionToken` in its type or return shape.
- `FilePathRef` is an opaque branded type (`string & { __brand: 'FilePathRef' }`); the renderer cannot dereference a filesystem path — dereferencing requires a second bridge round trip.

### Daemon JSON-RPC forwarding

- Wire format: Content-Length-framed JSON-RPC 2.0 per Spec-007 / ADR-009.
- Transport: Unix domain socket (macOS / Linux) or named pipe (Windows) per Spec-007. The shell instantiates the client from Plan-007's shared client SDK.
- The main process attaches the daemon session token as an RPC-level header; the renderer never sees the token.

### Control-plane tRPC + WebSocket forwarding

- Wire format: tRPC v11 over HTTPS for request/response; JSON-RPC 2.0 over WebSocket for relay subscription per ADR-014 / Spec-008.
- The main process attaches `Authorization: Bearer <paseto-v4.public>` + `DPoP: <signed-proof>` headers to every outbound HTTP request and the initial WebSocket handshake.
- Response sanitization: the main process strips `set-cookie` headers and any upstream auth-material-carrying headers before returning the response body to the renderer.

### Deep-link transport

- Protocol: `sidekicks://<action>/<...args>`. Actions: `invite/<token>`, `session/<id>`.
- URL arrival:
  - macOS: `app.on('open-url', (event, url) => ...)` handler.
  - Windows / Linux: `app.on('second-instance', (event, argv) => argv.find(a => a.startsWith('sidekicks://')))` handler; the URL is the last `argv` entry on secondary-instance launch.
- Token lifecycle: parsed in main process; exchanged for a session capability via `controlPlane.call('acceptInvite', { token })`; raw token is memory-discarded after exchange and **never** crosses the bridge.

### Update feed transport

- Transport: HTTPS GET against the project-operated static artifact store.
- Manifest format: `electron-updater` v6.8.4's YAML manifest (`latest-mac.yml`, `latest.yml`, `latest-linux.yml`) + an Ed25519-signed `manifest.sig` covering the YAML bytes.
- Artifact format: `.dmg` / `.zip` (macOS), `.exe` NSIS + `.msi` (Windows), `.AppImage` + `.deb` + `.rpm` (Linux).
- NSIS-only block-map delta updates enabled; macOS + Linux download full payloads per [`electron-updater` docs](https://www.electron.build/auto-update).

## Implementation Steps

1. **Scaffold `apps/desktop/` workspace package.** Create `package.json` with the dependency set declared in §Target Areas. Add to the root workspace `package.json`'s `workspaces` array. Configure TypeScript strict (`"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`).
2. **Author the preload-bridge type.** `packages/contracts/src/desktop-bridge.ts` — full `SidekicksBridge` interface per Spec-023. Re-export Plan-007 daemon types + Plan-008 control-plane types. Type-only file, no runtime. Author the conditional-type negative test (`Expect<Not<SidekicksBridge[any] includes 'token' | 'dpop' | 'prf'>>`) in `desktop-bridge.test-d.ts`.
3. **Author `electron.vite.config.ts`.** `electron-vite` v5.0.0 config with three entries (main / preload / renderer). Renderer loads via custom protocol, not `file://`. Enable `build.sourcemap: 'hidden'` (sourcemap emitted but not referenced from the bundle, so they are available for Sentry upload but not shipped to end users).
4. **Author the main-window factory.** `apps/desktop/electron/main/window.ts` — `createMainWindow()` returns a `BrowserWindow` with the `webPreferences` block from Spec-023 §Security Hardening Baseline. Write a build-time assertion (`apps/desktop/build/assert-webprefs.ts`) that greps the factory's source and fails the build if any of the locked-in values are changed.
5. **Author the preload bridge.** `apps/desktop/electron/preload/index.ts` — single `contextBridge.exposeInMainWorld('sidekicks', bridge)` call. Each bridge method delegates to `ipcRenderer.invoke('<channel>', ...)`; no direct Node API use. The bridge object must be structurally typed as the `SidekicksBridge` type from step 2.
6. **Wire the IPC handlers.** `apps/desktop/electron/main/bridge/index.ts` + the five per-surface bridge files. One `ipcMain.handle('<channel>', handler)` per method. Each handler validates input against the Spec-023 contract; auth material is attached server-side; responses are sanitized before return.
7. **Author the daemon supervisor.** `apps/desktop/electron/main/daemon-supervisor.ts` — `utilityProcess.fork(daemonEntryPath, args, { serviceName: 'ai-sidekicks-daemon' })` invoked **after** `app.whenReady()` (per Spec-023 §Implementation Notes §Utility Process Vs Child Process). Exit-reason switch: `"memory-eviction"` → restart without incrementing failure counter; any other non-zero exit → increment counter, back off per the Spec-023 ladder (`100ms, 300ms, 1s, 3s, 10s`), surface persistent error after 5 attempts. Version-negotiation gate: on `DaemonHello` check `protocol_version` against the shell's pinned minimum; on mismatch, block mutating bridge calls and allow only read-only subscriptions.
8. **Author the keystore abstraction.** `apps/desktop/electron/main/keystore.ts` — exports `getSecret`/`setSecret`/`deleteSecret`. `@napi-rs/keyring` is the primary path; `safeStorage` is a fallback for platforms where `@napi-rs/keyring` is unavailable. On startup: `safeStorage.isEncryptionAvailable()` must return `true`; on Linux, `safeStorage.getSelectedStorageBackend()` must return `gnome_libsecret` or `kwallet[456]` — `basic_text` and `unknown` are refused. On refusal: emit `keystoreUnavailable` event via the bridge; `setSecret` subsequently throws `KeystoreUnavailableError`; Plan-026 consumes this event to refuse long-lived token persistence and degrade to memory-only session.
9. **Author the WebAuthn strategy dispatcher.** `apps/desktop/electron/main/webauthn/index.ts`. On `darwin`: lazy-require `electron-webauthn-mac` v1.0.0; assert it exposes `createCredential` / `getAssertion`. On `win32` / `linux`: route to `fallback-dag.ts`. `deriveKeyMaterial` (PRF extension) is implemented only on macOS in V1; on Windows / Linux it throws `WebAuthnPrfUnsupportedError` and the caller falls back to refresh-token-based re-auth.
10. **Author the DAG fallback.** `apps/desktop/electron/main/webauthn/fallback-dag.ts`. `http.createServer()` bound to `'127.0.0.1'` (explicitly NOT `'localhost'`) with port `0` for an OS-assigned ephemeral port; `server.listen(0, '127.0.0.1', () => { const port = server.address().port; open(<authorize-url>?redirect_uri=http://127.0.0.1:${port}/callback&code_challenge=...&code_challenge_method=S256) })`. One-shot callback acceptance; `AbortSignal.timeout(300_000)` aborts the server on 5-min timeout. PKCE via `oauth4webapi` v3.8.5 `randomPKCECodeVerifier()` + `calculatePKCECodeChallenge()`; `plain` method is rejected at authorize-URL construction time per [RFC 7636 §4](https://datatracker.ietf.org/doc/html/rfc7636). Binding to `127.0.0.1` (not `localhost`) avoids the IPv6 `::1` DNS-ambiguity pitfall surfaced in the Apr-2026 research pass and is what RFC 8252 §7.3 normatively scopes.
11. **Author the auto-update state machine.** `apps/desktop/electron/main/updater.ts`. `autoUpdater` (from `electron-updater`) on a 4-hour cadence + startup + explicit check. `on('update-downloaded')` handler: verify Ed25519 signature against `updater-public-key.ts` embedded key; if valid → stage artifact at `apps/desktop/<staging-dir>` + write `updater-state.json` with `priorVersionPath = <current-exe-path>`. On `app.relaunch() + app.quit()` flow: on post-relaunch, wait for `DaemonHello`; on timeout (10s) or version-mismatch, trigger rollback (swap back to prior-version artifact, re-launch). Rollback is a one-way ratchet: the version that failed is marked `rollback_blacklist = [version]` in `updater-state.json` and will not be re-attempted automatically.
12. **Author the crash reporter.** `apps/desktop/electron/main/crash-reporter.ts` — called **first** in `main/index.ts` before any other module loads. Initializes `@sentry/electron/main` v7.11.0 with `beforeSend` scrubber. Enable `SentryMinidump` integration (default; captures Crashpad minidumps with Sentry breadcrumbs/context per [Sentry Electron docs](https://docs.sentry.io/platforms/javascript/guides/electron/configuration/integrations/electronminidump/)). Renderer + utility-process SDKs are initialized inside those processes respectively — **the v7 SDK does not auto-initialize renderers**; explicit `init()` is required per the Apr-2026 research pass.
13. **Author the deep-link handler.** `apps/desktop/electron/main/deep-link.ts`. `app.setAsDefaultProtocolClient('sidekicks')` at startup. `open-url` (macOS) and `second-instance` (Windows / Linux) handlers call `controlPlane.call('acceptInvite', { token })`; emit `session:joined` bridge event on success; raw token is never transmitted through `window.webContents.send`.
14. **Author the renderer shell.** `apps/desktop/src/App.tsx` + the five feature-view files. Each view is a thin composition over the bridge; none implements business logic that duplicates the owning plan's responsibility.
15. **Author the build pipeline.** `apps/desktop/build/fuses.ts` + `asar-digest.ts` + `code-sign.ts`. Pipeline order: `electron-builder` packages → `fuses.ts` flips fuses → `asar-digest.ts` embeds the digest → `code-sign.ts` signs (per-platform). Fuse-flipping + digest-embedding **must** precede signing; both invalidate any prior signature.
16. **Author the update-feed hosting stubs.** `apps/desktop/release/manifest-sign.ts` — signs `latest-*.yml` files with an Ed25519 private key held by the release-engineering role (out-of-band key). Outputs `manifest.sig` alongside each `latest-*.yml`. The signing key is distinct from code-signing certs (per Spec-023 §Pitfalls To Avoid).
17. **Author the renderer ESLint config.** `apps/desktop/eslint.config.mjs` — `no-restricted-imports` rule banning `electron` / `node:*` / `fs` / `child_process` / `net` / `os` / `path` / `process` / `keytar` / `@napi-rs/keyring` / `./electron/main/**` / `./electron/preload/**` from `apps/desktop/src/**`. CI runs this lint; any renderer-side Node import fails the build.
18. **Author the Playwright `_electron` E2E suite.** `apps/desktop/test/e2e/*.spec.ts` per §Target Areas Test section. Playwright v1.58.x is the current line as of April 2026; the `_electron` namespace is still experimental per [Playwright class-electron docs](https://playwright.dev/docs/api/class-electron), but it is the only production-viable harness (Spectron archived in 2022 with no revival). Tests must tolerate minor API churn between Playwright releases.
19. **Author the CI gate scripts.** `.github/workflows/desktop-build.yml` (or project-native CI format) — on every PR touching `apps/desktop/**` or `packages/contracts/src/desktop-bridge.ts`: run `pnpm lint` (ESLint) + `pnpm typecheck` (TS strict) + `pnpm test:unit` + `pnpm test:e2e` (Playwright in headless Electron mode) + `pnpm build:fuses --verify` (asserts the packaged-binary fuse wire matches the declared posture). A per-platform release job signs + notarizes on tag pushes.
20. **Document release runbook.** `apps/desktop/RELEASE.md` — per-platform signing prerequisites (Developer ID cert on macOS; Artifact Signing account on Windows OR EV cert + HSM token; GPG key on Linux), notarization retry procedure, rollback procedure, update-signing-key rotation procedure.

## Parallelization Notes

- Step 1 (scaffold) + step 2 (bridge type) must land first; everything else orbits them.
- Steps 3 (vite config) + 4 (window factory) + 5 (preload) can run in parallel; they have no cross-file dependencies.
- Steps 6 (IPC handlers) + 7 (daemon supervisor) + 8 (keystore) + 9 (webauthn dispatch) can run in parallel after steps 1–5.
- Step 10 (DAG fallback) depends on step 8 (keystore) for token persistence.
- Step 11 (auto-update) depends on step 7 (daemon supervisor) for the post-apply handshake, and on step 8 (keystore) for the update-signing-public-key embedding.
- Step 12 (crash reporter) has no dependency and should be authored early so it runs first at startup.
- Step 13 (deep-link) depends on step 6 (IPC handlers) for the `session:joined` bridge emission.
- Step 14 (renderer shell) depends on step 2 (bridge type) — can start in parallel with steps 6–13 since it consumes the bridge-shape, not the backing implementations.
- Step 15 (build pipeline) depends on everything compiling; orchestrates tail-end of release flow.
- Steps 17 (eslint) + 18 (E2E) + 19 (CI) + 20 (runbook) are independent tail-end tasks.

## Test And Verification Plan

- **Unit tests** (Vitest, `apps/desktop/electron/main/**/*.test.ts`):
  - `daemon-supervisor.test.ts` — assert `"memory-eviction"` exit does NOT increment failure counter; assert 5 crash-restart cycles surface persistent-error state; assert backoff schedule matches Spec-023.
  - `keystore.test.ts` — mock `safeStorage` / `@napi-rs/keyring`; assert Linux `basic_text` backend refusal; assert `gnome_libsecret` acceptance; assert `keystoreUnavailable` bridge event emission on refusal.
  - `updater.test.ts` — mock `electron-updater`; assert Ed25519 signature verification on `update-downloaded`; assert rollback trigger on post-apply handshake timeout; assert rollback-blacklist persistence.
  - `bridge/*.test.ts` — per-surface unit tests; assert auth material is stripped from responses.
- **E2E tests** (Playwright `_electron`, `apps/desktop/test/e2e/*.spec.ts`):
  - Per §Target Areas Test section. Nine spec files covering launch, fuses, bridge surface, daemon supervision, deep-link, WebAuthn (per-platform), keystore, updater rollback.
  - Bridge-surface negative test is the primary enforcement of Spec-023 §Acceptance Criteria "No auth material on `window.sidekicks`": asserts no property name matches `/token|dpop|prf|secret/i` and no property type contains those keywords.
- **Contract tests** (TypeScript conditional-type tests, `packages/contracts/src/desktop-bridge.test-d.ts`):
  - The `SidekicksBridge` type does not accept a shape with a `token: string` property; the type-test fails to compile if the interface is edited to leak auth material.
- **Build-time assertions**:
  - `assert-webprefs.ts` — greps `window.ts` for each Spec-023-locked `webPreferences` key; fails the build on drift.
  - `fuses.ts --verify` mode — reads the packaged binary's fuse wire and asserts equality with the declared posture.
- **Release-gate tests**:
  - Signed artifacts pass platform-native signature checks: Gatekeeper (macOS, `spctl --assess --type execute`), SmartScreen (Windows, `Get-AuthenticodeSignature`), `dpkg-sig --verify` (Linux `.deb`), `rpm --checksig` (Linux `.rpm`).
  - Auto-update download → signature-verify → stage → apply → daemon-handshake exercises end-to-end in a CI matrix job per platform.
- **Bundle-size verification**:
  - `apps/desktop/build/size-check.ts` — asserts post-asar, post-compression bundle size is under the ADR-016 150 MB ceiling. Fails the CI build on regression.

## Rollout Order

1. Scaffold `apps/desktop/` + bridge type + vite config + eslint config (steps 1, 2, 3, 17).
2. Land main-window factory + preload + IPC handler skeletons (steps 4, 5, 6).
3. Land crash reporter (step 12) — must be wired early so it catches startup crashes during subsequent step landings.
4. Land daemon supervisor + keystore + WebAuthn dispatch (steps 7, 8, 9). Gate: Plan-007 `DaemonHello` signal must be live.
5. Land DAG fallback + auto-updater + deep-link (steps 10, 11, 13).
6. Land renderer shell + feature views (step 14). Gate: the bridge types from step 2 must be stable.
7. Land build pipeline (step 15) + release-manifest signing (step 16). First packaged release candidate emits from this step.
8. Land E2E suite (step 18) + CI gate (step 19) + release runbook (step 20).
9. Manual per-platform smoke on macOS arm64 + x64, Windows 11, Ubuntu 24.04 LTS, Fedora 41. First-run UX exercise against Plan-026.
10. Ship internal beta to dogfood cohort. Monitor Sentry crash rate, daemon-supervisor restart rate, update-apply success rate for 2 weeks.
11. Public V1 release once beta metrics are green.

## Rollback Or Fallback

- **Renderer-level bug post-release**: auto-update ships a patched binary within 24 hours of detection; users receive it on next update-check cycle (max 4 hours) or explicit "check for updates" action.
- **Main-process crash loop post-update**: users receive the auto-rollback to the prior-version binary on daemon-handshake failure. No user action required.
- **Keystore unavailable at runtime**: session proceeds memory-only; auth material is not persisted; user must re-authenticate on every shell restart. Degradation is surfaced via a persistent banner.
- **Daemon fails to start after 5 backoff attempts**: shell enters offline read-only mode; user can view the last-synced session state but cannot issue new runs, approvals, or invites. Manual retry button surfaced.
- **Auto-update signature-verification failure**: staged artifact is discarded; failure is logged to `updater-state.json`; next update-check cycle re-attempts. Signed-key compromise is a release-engineering incident requiring out-of-band communication.
- **Notarization queue delay (macOS)**: release pipeline's 16-hour timeout + retry allows a delayed release candidate to complete asynchronously. If notarization fails outright (rare), the artifact is not distributed.

## Risks And Blockers

- **`electron-vite` v6 stability.** v5.0.0 stable is 16 months old (released 2024-12-07); v6.0.0-beta.1 shipped 2026-04-12 but is pre-GA. **Decision: pin to v5.0.0 for V1.** Revisit v6 for V1.1 once the beta stabilizes. Alternative considered: direct Vite + `electron-builder` wiring without a wrapper (gives maximum control; loses HMR convenience and source-code-protection baked-in). Alternative rejected because V1 desktop is a greenfield Electron app and `electron-vite` is the de-facto production pick for 2026 greenfield projects per the Apr-2026 research pass. Alternative also considered: `@electron-forge/plugin-vite` — still marked experimental in v7.11.1 (2026-01-12) per [Electron Forge Vite plugin docs](https://www.electronforge.io/config/plugins/vite). Rejected: an experimental plugin is not a V1-appropriate foundation.
- **Playwright `_electron` experimental API.** Still officially marked experimental in v1.58.x per [Playwright class-electron docs](https://playwright.dev/docs/api/class-electron). Accepted: this is the only viable option (Spectron archived since 2022 with no revival confirmed in the Apr-2026 research pass). Mitigation: design test suites to tolerate minor API churn between Playwright releases; pin Playwright in `package.json` and review changelogs on every bump.
- **WebAuthn cross-platform gap.** Electron issue [#24573](https://github.com/electron/electron/issues/24573) (open since Jul 2020, no 2026 activity, no assignee, no milestone per the Apr-2026 research pass) means native platform-authenticator flows are not available out-of-box in Electron 41. V1 ships macOS-only WebAuthn PRF (Vault12 `electron-webauthn-mac`) + Device Authorization Grant fallback on Windows / Linux. Accepted. This gap is documented in Spec-023 §Open Questions; if a cross-platform module with confirmed Windows-Hello + Linux-FIDO2 coverage emerges mid-V1, Plan-023 adopts it via a focused edit. The `@electron-webauthn/native` package is **deprecated** per the npm registry per the Apr-2026 research pass and is **not** adopted.
- **Minidump PII scrubbing gap.** `@sentry/electron` v7.11.0's `beforeSend` hook does not apply to raw minidump bytes; minidumps go through **server-side** scrubbing rules per [Sentry Electron minidump docs](https://docs.sentry.io/platforms/javascript/guides/electron/configuration/integrations/electronminidump/). Minidumps contain heap memory, which includes PASETO tokens, DPoP keys, PRF output. **Mitigation path**: (a) `crashReporter.start({ uploadToServer: true })` is gated on explicit user opt-in (default off) in the first-run telemetry prompt owned by Plan-026; (b) Sentry server-side data-scrubbing rules are configured to strip PASETO token patterns (`v4.public.`, `v4.local.`) and DPoP JWT patterns before the minidump is persisted. Self-hosted symbolication (Option B in Spec-023 §Open Questions) is the long-term answer; V1 ships the Sentry path with the dual gate.
- **Azure Artifact Signing regional eligibility.** Spec-023 §Open Questions: USA / Canada / EU / UK organizations + US / Canada individuals only. If the issuing org is outside eligibility, the Windows-signing path falls back to a traditional EV cert (DigiCert / Sectigo / SSL.com), now subject to CSC-31's 15-month validity (not the pre-2026 3-year) per [CA/Browser Forum CSC-31 ballot](https://cabforum.org/working-groups/code-signing/requirements/). Plan-023 documents both paths; lock-in decision is release-engineering-owned, pre-V1 RC.
- **Smart App Control reputation cold-start on Windows.** A freshly-signed binary has low reputation in Windows Defender's Intelligent Security Graph. First-launch UX on Windows 11 will be rough until reputation accumulates. Accepted for V1. Mitigation: Artifact Signing's Public Trust chain is documented as the preferred path specifically because it chains to a CA in the Microsoft Trusted Root Program; the first-run onboarding copy in Plan-026 includes a "Run anyway" guidance for SmartScreen.
- **Notarization queue delays on macOS.** Per Spec-023 §Code Signing — Apple notarization queues have been reporting 16+ hour delays in February 2026 per [Apple Developer forum thread 813441](https://developer.apple.com/forums/thread/813441). Release pipeline's per-platform signing step includes an 18-hour timeout + retry. Accepted as a release-latency risk; does not block V1 if release engineering is staffed for async release cutting.
- **Rollback state-machine complexity.** Electron's built-in `autoUpdater` does not ship rollback; `electron-updater` v6.8.4 does not ship rollback. Plan-023 authors the rollback state machine from scratch (step 11). Accepted: this is first-class code with unit-test coverage. Alternative considered: dual-slot A/B update (Android-style); rejected for V1 because dual-slot is a disk-space + launcher-complexity doubling that is inappropriate before we have load-bearing evidence the single-slot-with-rollback approach is insufficient.
- **`@napi-rs/keyring` ecosystem maturity.** `@napi-rs/keyring` v1.2.0 is the keytar successor path per Spec-023 §Implementation Notes §Native Keystore. It has not yet seen the battle-testing of `node-keytar` (archived 2022). **Mitigation**: the `keystore.ts` abstraction is backend-agnostic; if `@napi-rs/keyring` regresses, the abstraction can swap to `safeStorage` for all keys (with the accepted usability regression that `safeStorage` is a one-shot-blob API without per-key metadata). This swap is a code-only change, no schema migration.
- **Renderer clipboard deprecation pitfall.** Electron 40+ deprecated direct `navigator.clipboard.*` from the renderer per Spec-023 §Implementation Notes §Renderer Bundle. The ESLint `no-restricted-imports` rule is the CI gate; a renderer file that imports `@capacitor/clipboard` or similar cross-platform clipboard library bypasses the rule. **Mitigation**: document in `apps/desktop/README.md` that clipboard access must route through `window.sidekicks.native.copyToClipboard`; add a runtime assertion (`expect(navigator.clipboard).toBeUndefined()` in renderer boot) that fails fast if a transitive dep re-introduces renderer-clipboard access.
- **Single-instance-lock race with deep-link.** Spec-023 §Main Process Responsibilities requires `app.requestSingleInstanceLock()`. Without the lock, a `sidekicks://invite/<token>` URL arriving at a second instance would race with the first instance's daemon state. The lock + `second-instance` event handler is the correct pattern, but it introduces a subtle bug: if the first instance is mid-crash during URL arrival, the second instance gets the lock and may re-exchange the invite token. Accepted: Plan-007's invite-redemption API is idempotent on double-submission (same token → same session membership), so the race is a UX oddity not a security issue. Documented in `apps/desktop/RELEASE.md`.

## Done Checklist

- [ ] `apps/desktop/` scaffolded as a workspace package with Electron 41.1.0+ runtime, `electron-vite` v5.0.0, `electron-builder` v26.9.0, `electron-updater` v6.8.4, `@napi-rs/keyring` v1.2.0, `@sentry/electron` v7.11.0, `@electron/asar` v4.1.0+, `@electron/fuses`.
- [ ] `packages/contracts/src/desktop-bridge.ts` exports the `SidekicksBridge` interface from Spec-023 §Preload Bridge Contract; conditional-type negative test passes.
- [ ] Every `BrowserWindow` is created with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, a preload script, and the custom protocol load (not `file://`). Build-time assertion script (`assert-webprefs.ts`) greps the factory for each value and fails the build on drift.
- [ ] Release builds ship with the nine Electron Fuses from Spec-023 §Security Hardening Baseline set as declared; `fuses.ts --verify` mode asserts the packaged binary's fuse wire matches on every CI build.
- [ ] Release builds embed the ASAR Integrity Digest (new in Electron 41 via `@electron/asar` v4.1.0+) **before** code signing; packaging pipeline order is enforced.
- [ ] The `window.sidekicks` surface has no `any`-typed escape hatch; the bridge type negative test catches leaks of `token` / `dpop` / `prf` / `secret` names.
- [ ] Daemon is supervised via `utilityProcess.fork()` after `app.whenReady()`; `"memory-eviction"` exit is special-cased (restart without incrementing failure counter); 5 consecutive non-memory-eviction crashes surface persistent-error state.
- [ ] `@napi-rs/keyring` v1.2.0 is the primary keystore path; `safeStorage.getSelectedStorageBackend()` refuses `basic_text` / `unknown` on Linux; on refusal, `keystoreUnavailable` bridge event is emitted and long-lived token persistence degrades to memory-only.
- [ ] WebAuthn ceremony routes to Vault12 `electron-webauthn-mac` v1.0.0 on macOS; routes to the Device Authorization Grant loopback fallback on Windows / Linux. DAG fallback binds to `'127.0.0.1'` (not `'localhost'`), uses PKCE S256 via `oauth4webapi` v3.8.5, rejects `plain` method, times out after 5 minutes via `AbortSignal.timeout(300_000)`.
- [ ] Auto-updater verifies Ed25519 signature against the build-time-embedded update-signing public key; rollback state machine restores prior-version artifact on post-apply daemon-handshake failure; rollback-blacklist prevents automatic re-attempts of a version that just failed.
- [ ] `sidekicks://` protocol handler routes `invite/<token>` URLs through the main process; raw token is exchanged via `controlPlane.call('acceptInvite', { token })` and never crosses the bridge to the renderer.
- [ ] `@sentry/electron/main` `init()` is the first thing called in `main/index.ts`; `beforeSend` scrubber strips tokens, session IDs, file paths, content payloads. Renderer and utility-process Sentry SDKs are explicitly initialized (v7 does not auto-initialize renderers). `SentryMinidump` integration is enabled with opt-in `uploadToServer` gated by Plan-026 first-run telemetry prompt. Sentry server-side data-scrubbing rules are configured for PASETO / DPoP patterns.
- [ ] Renderer ESLint config rejects `electron` / `node:*` / `fs` / `child_process` / `net` / `os` / `path` / `process` imports from `apps/desktop/src/**`; CI gate fails on violation.
- [ ] Playwright `_electron` E2E suite covers launch, fuses, bridge surface, daemon supervision, deep-link, WebAuthn (per-platform), keystore, updater rollback. Tests tolerate Playwright API churn by pinning a specific Playwright version in `package.json`.
- [ ] Code-signed release artifacts pass Gatekeeper (macOS), SmartScreen (Windows 10 + 11), `dpkg-sig --verify` (Linux `.deb`), `rpm --checksig` (Linux `.rpm`). macOS signing uses `xcrun notarytool` with 18-hour timeout + retry.
- [ ] Shell bundle size (post-asar, post-compression) is under 150 MB per ADR-016 Success Criteria; CI size-check fails on regression.
- [ ] Clipboard access flows only through `window.sidekicks.native.copyToClipboard`; runtime assertion in renderer boot fails if `navigator.clipboard` becomes defined via transitive dep.
- [ ] `app.requestSingleInstanceLock()` is held at startup; `second-instance` handler receives deep-link URLs on Windows / Linux; `open-url` handler receives them on macOS.
- [ ] All five Signature Feature views (timeline, approvals, invites, runs, multi-agent channels) are composition-only over the bridge; no feature view duplicates daemon-side logic.
- [ ] Update-signing Ed25519 key is distinct from the code-signing certificate; rotation procedures for both are documented in `apps/desktop/RELEASE.md`.

## Tier Placement

Tier 7-8, per `docs/architecture/cross-plan-dependencies.md` §5 Canonical Build Order. Strictly **downstream of Plan-007** (consumes the daemon IPC contract), **downstream of Plan-018** (consumes PASETO tokens), **downstream of Plan-008** (consumes the control-plane tRPC + WebSocket client), **parallel to Plan-024** (both are shell-surface plans but Plan-024 is owned by the daemon, not the shell), and **upstream of Plan-026** (Plan-026 consumes the `onboarding.*` preload-bridge surface authored here). Placement update to `cross-plan-dependencies.md` §5 is BL-054's scope (Session 4); Plan-023's body states the tier intent only.

## References

- [Spec-023: Desktop Shell And Renderer](../specs/023-desktop-shell-and-renderer.md)
- [ADR-016: Electron Desktop Shell](../decisions/016-electron-desktop-shell.md)
- [ADR-010: PASETO + WebAuthn + MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md)
- [ADR-009: JSON-RPC IPC Wire Format](../decisions/009-json-rpc-ipc-wire-format.md)
- [ADR-014: tRPC Control-Plane API](../decisions/014-trpc-control-plane-api.md)
- [ADR-020: V1 Deployment Model And OSS License](../decisions/020-v1-deployment-model-and-oss-license.md)
- [Container Architecture](../architecture/container-architecture.md)
- [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md)
- [Security Architecture](../architecture/security-architecture.md)
- [Plan-024: Rust PTY Sidecar](./024-rust-pty-sidecar.md) — PtyHost ownership boundary (daemon, not shell)
- [Plan-026: First-Run Onboarding](./026-first-run-onboarding.md) — consumes the `onboarding.*` preload-bridge surface authored here
- [Electron 41.0 release notes](https://www.electronjs.org/blog/electron-41-0) — Chromium 146, Node 24.14, ASAR Integrity Digest, MSIX auto-update
- [Electron `utilityProcess` API](https://www.electronjs.org/docs/latest/api/utility-process)
- [Electron `safeStorage` API](https://www.electronjs.org/docs/latest/api/safe-storage) — Linux plaintext-fallback behavior
- [Electron GHSA feed](https://github.com/electron/electron/security/advisories) — Q1 2026 CVE batch; 41.1.0 fixed-branch floor
- [`electron-vite` (alex8088)](https://electron-vite.org/) — v5.0.0 stable (2024-12-07); v6.0.0-beta.1 (2026-04-12)
- [`electron-builder` releases](https://github.com/electron-userland/electron-builder/releases) — v26.9.0 (2026-04-14)
- [`electron-updater` auto-update docs](https://www.electron.build/auto-update)
- [`@napi-rs/keyring` npm](https://www.npmjs.com/package/@napi-rs/keyring) — v1.2.0 keytar-compatible replacement
- [`@sentry/electron` releases](https://github.com/getsentry/sentry-electron/releases) — v7.11.0 (2026-04-07)
- [Sentry Electron SDK docs](https://docs.sentry.io/platforms/javascript/guides/electron/) — per-process `init()`, `SentryMinidump` default, `beforeSend` scrubbing
- [`electron-webauthn-mac` (Vault12)](https://github.com/vault12/electron-webauthn-mac) — v1.0.0 (2025-12-10), macOS-only
- [Electron issue #24573](https://github.com/electron/electron/issues/24573) — cross-platform WebAuthn binding (still open, no ETA)
- [Playwright class `_electron` docs](https://playwright.dev/docs/api/class-electron) — still experimental in v1.58.x
- [Playwright release notes](https://playwright.dev/docs/release-notes)
- [`oauth4webapi` (panva)](https://github.com/panva/oauth4webapi) — v3.8.5 (2026-02-16) — PKCE S256 primitives
- [RFC 8252 §7.3 — Loopback Interface Redirection](https://datatracker.ietf.org/doc/html/rfc8252#section-7.3) — "MUST allow any port to be specified at the time of the request"
- [RFC 7636 §4 — PKCE code challenge methods](https://datatracker.ietf.org/doc/html/rfc7636#section-4)
- [CA/Browser Forum CSC-31](https://cabforum.org/working-groups/code-signing/requirements/) — 460-day cert validity cap (effective 2026-03-01)
- [Microsoft Azure Artifact Signing GA announcement](https://techcommunity.microsoft.com/blog/microsoft-security-blog/simplifying-code-signing-for-windows-apps-artifact-signing-ga/4482789)
- [Apple Developer forum thread 813441](https://developer.apple.com/forums/thread/813441) — notarization queue delays
