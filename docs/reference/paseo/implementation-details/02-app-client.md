# Repo Exploration: App Client

## Table of Contents

- [Role](#role)
- [App Shell And Routing](#app-shell-and-routing)
- [Host Runtime Orchestration](#host-runtime-orchestration)
- [Session State And Stream Synchronization](#session-state-and-stream-synchronization)
- [Workspace UI Model](#workspace-ui-model)
- [How To Read This Package](#how-to-read-this-package)
- [Sources](#sources)

## Role

`packages/app` is the richest client in the repo. It is not a thin terminal around server state; it is a cross-platform Expo application that can manage multiple hosts, reconcile live stream state, and present a workspace model that spans agents, files, git status, and terminals.[S1][S2]

## App Shell And Routing

The app shell in `_layout.tsx` sets up the global provider stack: Unistyles, crypto polyfills, safe-area handling, keyboard and gesture systems, bottom sheets, portals, React Query, voice runtime, host runtime access, per-host `SessionProvider` instances, notifications, and app-wide UI scaffolding such as the sidebar and command center.[S1]

The root route in `index.tsx` does one simple but important thing: once storage and runtime bootstrap are ready, it routes the user either to the earliest online host or to `/welcome` if no host is currently connected.[S2]

That split mirrors the product model. The app does not assume a single daemon and does not assume local-only operation; host selection is a first-class concern at the route layer.[S1][S2]

## Host Runtime Orchestration

`packages/app/src/runtime/host-runtime.ts` is the client-side control plane. It defines the `HostRuntimeSnapshot`, which tracks active connection, `DaemonClient`, online status, probe state, last error, agent-directory sync state, and client generation.[S3]

The `HostRuntimeController` maintains a connection state machine and an adaptive probing loop. It probes candidate direct and relay connections, tracks latency, activates the first reachable one, and can later switch to a faster connection only after repeated probes cross a switching threshold.[S4]

The same module also owns agent-directory hydration. `refreshAgentDirectory()` paginates `fetchAgents()`, optionally establishes a live subscription, and marks the controller as loading, ready, or errored so the UI can distinguish between initial load, revalidation, and post-ready failures.[S5]

Architecturally, this is the main reason the app feels resilient: host connectivity, route state, and agent-directory state are related but intentionally not collapsed into one boolean.[S3][S4][S5]

## Session State And Stream Synchronization

`SessionProvider` in `session-context.tsx` is the glue layer between the live `DaemonClient` and the Zustand session store. It initializes per-host state, tracks pending updates, handles notifications, decodes audio output, buffers permission requests, and applies authoritative server snapshots back into the store.[S6]

The hard part is stream consistency, and that logic is deliberately split. `session-stream-reducers.ts` contains the pure reducers for canonical timeline fetches and live stream events. `processTimelineResponse()` decides between full replacement and incremental append, updates epoch/sequence cursors, and emits side effects like catch-up requests when a gap is detected. `processAgentStreamEvent()` gates live events by epoch and sequence, applies them to the head/tail stream model, and can request a canonical catch-up when live delivery has a gap.[S7]

Back in `session-context.tsx`, the React layer subscribes to daemon message types such as `agent_update`, `agent_stream`, `fetch_agent_timeline_response`, `workspace_update`, `status`, permission messages, `audio_output`, and activity logs. The file coordinates buffering during initialization, canonical catch-up, optimistic status updates, and audio playback confirmation.[S8]

The base data model for that state lives in `session-store.ts`, which defines the per-session maps for agents, workspaces, permissions, file explorer state, stream head/tail state, timeline cursors, queued messages, and server metadata.[S9]

## Workspace UI Model

The workspace screen is large because it is the main product surface. `workspace-screen.tsx` imports the explorer sidebar, split container, tab presentation system, git actions, terminal retention hooks, mobile and desktop tab rows, bulk close logic, and layout helpers such as `useIsCompactFormFactor()`.[S10]

The screen composes a desktop-style workspace abstraction out of reusable pieces: active workspace descriptor, tabs, split panes, terminals, agent views, file tabs, and git actions. That keeps route-level state small while allowing the screen to support web, native, compact layouts, and desktop-pane splits from one entrypoint.[S10]

## How To Read This Package

Read the package in this order:

1. `_layout.tsx` and `index.tsx` for app bootstrap and route entry.[S1][S2]
2. `runtime/host-runtime.ts` for connection management and agent-directory sync.[S3][S4][S5]
3. `contexts/session-context.tsx` and `contexts/session-stream-reducers.ts` for session ingestion and stream consistency.[S6][S7][S8]
4. `stores/session-store.ts` for the normalized client state model.[S9]
5. `screens/workspace/workspace-screen.tsx` for the top-level workspace composition.[S10]

## Sources

- [S1] `packages/app/src/app/_layout.tsx#L1-L239`, app shell providers, host session manager, and notification wiring.
- [S2] `packages/app/src/app/index.tsx#L1-L56`, root route selection based on host connectivity.
- [S3] `packages/app/src/runtime/host-runtime.ts#L35-L220`, host runtime snapshot and connection state model.
- [S4] `packages/app/src/runtime/host-runtime.ts#L460-L860`, host runtime controller startup, probing, and adaptive connection switching.
- [S5] `packages/app/src/runtime/host-runtime.ts#L1733-L1799`, paginated `fetchAgents()` refresh and directory-sync state transitions.
- [S6] `packages/app/src/contexts/session-context.tsx#L224-L320`, session provider responsibilities and store integration points.
- [S7] `packages/app/src/contexts/session-stream-reducers.ts#L24-L420`, canonical timeline reduction, stream-event gating, and gap recovery logic.
- [S8] `packages/app/src/contexts/session-context.tsx#L830-L1320`, timeline application, daemon subscriptions, permissions, audio output, and activity handling.
- [S9] `packages/app/src/stores/session-store.ts#L1-L260`, normalized session, agent, workspace, explorer, and stream state definitions.
- [S10] `packages/app/src/screens/workspace/workspace-screen.tsx#L1-L260`, workspace shell dependencies and multipane composition entrypoint.
