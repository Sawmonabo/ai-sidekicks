# Desktop Architecture

## Purpose

Define the desktop app's main process, preload bridge, renderer, and client SDK boundaries.

## Scope

This document covers the desktop application as a client to local and shared system services.

## Context

The desktop app is the primary interactive client, but it must remain a client. Native integration and rich UI belong here; execution truth does not.

## Responsibilities

- render session, orchestration, repo, diff, approval, and linked-device experiences
- supervise the local daemon from the main process
- provide native dialogs, notifications, updater flow, and safe host integration
- share one typed client SDK with the CLI

## Component Boundaries

| Component | Responsibility |
| --- | --- |
| `Main Process` | Owns the native windows and every operating-system action. `windows/` holds the one window factory and main's registry of windows, every window built alike with no main window among them; once a session view's title can be dragged out of its window, `windows/` hit-tests the windows' bounds at the pointer's point on the screen and answers with the window under it, and moves a torn-off window with the pointer, reading nothing of the renderer's layout. `bridge/` holds main's handler for each preload bridge method: the daemon calls, the `window.*` and `machineSettings` members, the `native` namespace, the keyboard map, and the file tokens that stand in for paths. `appearance/` holds the kept appearance record, the platform scheme it drives and the console theme's terminal colors main reports to the daemon. Preview's host answers the daemon's `preview.page*` calls once it is built. `services/` holds main's own services, such as the diagnostic log, the crash reporter, the scheme the renderer is served from and the daemon's start and supervision. `probes/` holds the probes the test tiers read. Main also supervises the daemon and builds the platform's menu, and runs the updater once it is built. |
| `Preload Bridge` | Narrow, typed native bridge between the renderer and the main process. `index.ts` is the expose call alone, and `api.ts` builds the bridge object the page reads as `window.desktopBridge`. |
| `Shared` | Desktop-only contracts between the main process, the preload bridge and the renderer: at `shared/`'s root, `preload-api.ts` holds `PreloadApi`, the preload's exposed API type, and `bridge-channels.ts` holds `BRIDGE_CHANNELS`, the IPC channel each bridge member is carried on, beside the other flat files more than one process reads; `daemon/` holds the daemon call forwarding between preload and main, the method bindings, the `daemon.status` topic and the closed set of daemon subscriptions; `window/` holds a window's id and frame name, the safe-start mark and a window's sizes. A contract that crosses to the daemon or the control plane lives in `packages/contracts` instead: the daemon method map (`DaemonMethod`, `DaemonParams`, `DaemonResult`, `DaemonEvent`) that every client of the daemon needs, and the `preview.*` types, which the daemon serves and whose `preview.page*` calls it makes to main (`preview/methods.ts`). |
| `Renderer` | The page every window shows; one renderer drives every window. `app/` does composition and bootstrap only; `layout/` is the persistent chrome (`AppShell`, `NavigationRail`, `CommandPalette`, `NotificationsList`), the Notifications list opened from the rail's bell; `features/` holds one folder per product area (agents, composer, inspector, preview, repos, sessions, settings, terminal, transcript, workflows, and remote-control and skills once they are built), and no feature imports another; `registries/` holds only the mechanisms features register their panes, screens, commands and key bindings into; `services/` is external communication only: the daemon client, transport, run streams, the per-session event subscription, the window client, the Preview client once it is built, and `platform/`, which holds `PlatformBridge`, the front end's host-agnostic capability boundary, and the `PlatformBridgeProvider` that hands it to the page. The Electron desktop, the web client, Android and iPhone each implement `PlatformBridge`; only the desktop's implementation reads the preload's `window.desktopBridge`. `routing/`, `components/`, `hooks/`, `lib/`, `styles/` and `assets/` hold what several owners share, among them the pointer-drag core in `lib/`, which moves Preview's tabs and the panes, and the terminal's tabs, the waiting messages and the session views once they take it. |
| `Renderer Store` | The renderer's `store/`: app-wide state, including each open session's daemon events applied to it and the lists several features read, such as the agent definitions and the skills, the Notifications list's projection, count and notifier in `store/attention/`, plus the window's own view state in `store/persistence/`. A draft is not kept here: it is held by the daemon, per session, and never written to window storage. |
| `Client SDK` | Typed protocol layer the main process and the CLI use to talk to the local daemon. The renderer does not use it directly; it reaches the daemon through its `PlatformBridge`, on the desktop the preload bridge. |

## Implementation Home

- Desktop application package root: `apps/desktop/`
- Main process root: `apps/desktop/src/main/`, grouped into `windows/`, `bridge/`, `appearance/`, `services/` and `probes/`, with the entry point, the menu and the fixture launch at its root
- Preload bridge root: `apps/desktop/src/preload/`
- Desktop-only contracts shared by the three processes: `apps/desktop/src/shared/`
- Renderer root: `apps/desktop/src/renderer/src/`, the electron-vite renderer root
- The front end's host-agnostic capability boundary, `PlatformBridge`, and its provider: `apps/desktop/src/renderer/src/services/platform/`
- Fixture scenarios, compiled only into development and fixture builds and never shipped: `apps/desktop/fixtures/`
- Tests that span modules or the whole application: `apps/desktop/tests/`; every other desktop test sits beside its source
- Shared client SDK root: `packages/client-sdk/`
- Related CLI client root, which [Plan-005](../plans/005-local-ipc-and-daemon-control.md) creates: `apps/cli/`

Folder layout, ownership, naming and import rules: [`apps/desktop/AGENTS.md`](../../apps/desktop/AGENTS.md).

## Data Flow

1. The renderer's features call their clients in `services/`, which reach the daemon through the renderer's `PlatformBridge` — on the desktop, the preload bridge's `daemon.call` and `daemon.subscribe` — and the control plane through `controlPlane.call`. Neither the page nor the preload holds a credential.
2. The main process talks to the local daemon through the client SDK over the daemon's socket: the handshake, the liveness check, and every call the renderer sends through the bridge. It reports the link and the version range to the renderer on the `daemon.status` topic.
3. The preload bridge and main process provide native dialogs, updater events, file picking, and safe OS interactions. A picked or dropped file reaches the page as a token main minted, never as a path.
4. For each open session, the session-events service subscribes to the daemon and the store applies every event; the features draw the session screen from the store and the window's own view state.

## Trust Boundaries

- The renderer is less trusted than the main process and local daemon.
- The preload bridge must be narrow and capability-based.
- Native OS actions must be routed through controlled main-process APIs rather than arbitrary renderer escape hatches.

## Failure Modes

- The renderer loses its connection to the daemon. The composer's working line says so once, with `Retry`, while the main process reconnects; nothing else on screen changes and no control is disabled. Before the daemon has answered once, the boot card speaks instead.
- The app and the daemon run different versions. Each app accepts its own daemon version and the one before it. Outside that range the app is read-only, and the working line names the side that is behind, the app or the background service, with a press that opens its fix.
- Native bridge calls fail because the main process is unavailable or permissions are missing.

## Related Domain Docs

- [Session Model](../domain/session-model.md)
- [User And Device Model](../domain/user-and-device-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

## Related Specs

- [Local IPC And Daemon Control](../specs/006-local-ipc-and-daemon-control.md)
- [Transcript And Reasoning](../specs/011-transcript-and-reasoning.md)
- [Notifications And Attention Model](../specs/017-notifications-and-attention-model.md)

## Related ADRs

- [Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)
