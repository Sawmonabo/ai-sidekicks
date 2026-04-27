# Repo Exploration: App State UI And Routing

## Table of Contents

- [Role](#role)
- [Host Routing And URL Semantics](#host-routing-and-url-semantics)
- [Draft Agent Creation And Provider Selection](#draft-agent-creation-and-provider-selection)
- [Session State And Stream Normalization](#session-state-and-stream-normalization)
- [Workspace Navigation And Stream Rendering](#workspace-navigation-and-stream-rendering)
- [Settings Diagnostics And Provider Visibility](#settings-diagnostics-and-provider-visibility)
- [How To Read These Modules](#how-to-read-these-modules)
- [Sources](#sources)

## Role

This layer explains how the Expo client turns daemon state into a navigable product. The first app walkthrough covered the shell, host runtime, and session provider at a high level. These modules show the deeper mechanics: how URLs encode host and workspace identity, how agent-creation state is resolved without clobbering user edits, how stream events are normalized into UI items, and how the sidebar and settings screens project daemon capabilities back to the user.[S1][S2][S3][S4]

## Host Routing And URL Semantics

`host-routes.ts` is the app's routing grammar. It strips query and hash fragments, parses `/h/:serverId/...` routes, base64url-encodes workspace IDs and file paths, preserves compatibility with older path-like route formats, and decodes `open=` intents such as `agent:...`, `terminal:...`, `draft:...`, and `file:...`.[S8]

`left-sidebar.tsx` is the main consumer of that route model. It resolves the active host from the current pathname, falls back to the first configured host when needed, reads the live connection snapshot from the host runtime, and maps host selection back into route changes. The same component also owns the project list refresh and the jump points to host sessions and settings.[S1]

Together, those files show that host selection is not an afterthought. The app assumes multiple daemons are possible, and the route space is explicitly designed around that reality.[S1][S8]

## Draft Agent Creation And Provider Selection

`DraftAgentScreen` is the concrete "new agent" workflow. It parses URL params for server, provider, mode, model, thinking option, working directory, and worktree mode, filters to online hosts, keeps a durable draft ID for input state, and coordinates working-directory suggestions, branch suggestions, worktree attach or create flows, and the actual agent-create path.[S2]

The interesting logic behind that screen lives in `use-agent-form-state.ts`. That hook resolves form state from multiple sources with a strict priority order: explicit initial values first, then stored preferences, then provider defaults, and only then fallbacks. It also tracks which fields the user has already modified so asynchronous provider or model refreshes do not overwrite deliberate user choices.[S6]

`use-providers-snapshot.ts` fills in the runtime side of that form. It queries the daemon for provider snapshots when the connected server supports the feature, subscribes to `providers_snapshot_update`, and exposes refresh or invalidation hooks so the create flow and settings UI can react to provider availability changes without rebuilding their own transport layer.[S5]

## Session State And Stream Normalization

The session model in the app is intentionally layered. `session-store.ts` defines the normalized per-host state maps for agents, workspaces, explorer state, permissions, stream heads and tails, pending updates, and server metadata.[S4]

`session-context.tsx` is the live integration layer above that store. It subscribes to daemon messages, applies authoritative fetches and incremental updates, buffers state during initialization, confirms audio output playback, and coordinates side effects such as notifications and permission handling.[S2]

`session-stream-reducers.ts` contains the hard consistency rules. It decides when a fetched timeline replaces local history versus appending to it, gates live events by epoch and sequence, and requests canonical catch-up when a gap appears in live delivery.[S3]

The UI-friendly result of that pipeline lives in `types/stream.ts`. That file normalizes raw transport events into `user_message`, `assistant_message`, `thought`, `tool_call`, `todo_list`, `activity_log`, and `compaction` items, merges streaming assistant chunks, finalizes active thoughts, de-duplicates tool calls, and gives the renderer a stable item model instead of provider-specific payloads.[S7]

## Workspace Navigation And Stream Rendering

`agent-stream-view.tsx` is where normalized stream state becomes UI. It chooses a render strategy from platform and breakpoint, stitches the authoritative tail together with the optimistic live head, and wires inline path presses back into workspace routing or file-explorer directory fetches.[S9]

That file is also one of the best examples of the app's cross-platform stance. It keeps render strategy, viewport control, and inline file navigation abstracted behind helpers rather than scattering platform-specific branching across every message component.[S9]

## Settings Diagnostics And Provider Visibility

`settings-screen.tsx` is the app's operational control surface. It defines the section model for hosts, permissions, desktop-only integrations, pair-device flows, daemon controls, providers, diagnostics, and about; it pulls live host status from the runtime; and it consumes daemon config plus provider snapshots to surface diagnostics, versions, and provider visibility in one place.[S10]

That matters architecturally because settings is not just static preferences UI. It is the place where the client exposes daemon capabilities, connection status, provider diagnostics, and update or pairing workflows back to the user.[S5][S10]

## How To Read These Modules

Read these files in this order:

1. `host-routes.ts` and `left-sidebar.tsx` for host-aware navigation and route-to-UI mapping.[S1][S8]
2. `use-agent-form-state.ts`, `use-providers-snapshot.ts`, and `draft-agent-screen.tsx` for the create-agent flow and provider selection model.[S2][S5][S6]
3. `session-store.ts`, `session-context.tsx`, and `session-stream-reducers.ts` for normalized state ingestion and live-stream consistency.[S2][S3][S4]
4. `types/stream.ts` and `agent-stream-view.tsx` for the UI item model and stream rendering path.[S7][S9]
5. `settings-screen.tsx` for the app's operational and diagnostic surfaces.[S10]

## Sources

- [S1] `packages/app/src/components/left-sidebar.tsx#L1-L1014`, active host selection, host picker routing, project refresh, and sidebar navigation behavior.
- [S2] `packages/app/src/screens/agent/draft-agent-screen.tsx#L1-L1421`, draft-agent route params, online host resolution, input drafts, and create-flow orchestration.
- [S3] `packages/app/src/contexts/session-stream-reducers.ts#L24-L432`, canonical timeline reduction, live stream gating, and gap recovery.
- [S4] `packages/app/src/stores/session-store.ts#L1-L1165`, normalized per-session state for agents, workspaces, explorer state, permissions, and stream data.
- [S5] `packages/app/src/hooks/use-providers-snapshot.ts#L1-L92`, provider snapshot query model and live update subscription.
- [S6] `packages/app/src/hooks/use-agent-form-state.ts#L1-L748`, form-state resolution, preference merging, model and thinking-option selection, and user-modified field tracking.
- [S7] `packages/app/src/types/stream.ts#L1-L871`, normalized stream item model and append or merge rules for live and canonical updates.
- [S8] `packages/app/src/utils/host-routes.ts#L1-L362`, host route parsing, workspace or file identity encoding, and `open` intent decoding.
- [S9] `packages/app/src/components/agent-stream-view.tsx#L1-L1121`, stream render strategy selection, workspace file navigation, and viewport control.
- [S10] `packages/app/src/screens/settings-screen.tsx#L1-L2082`, settings section model, host controls, provider visibility, diagnostics, and daemon-facing settings UI.
- [S11] `packages/app/src/contexts/session-context.tsx#L224-L320` and `packages/app/src/contexts/session-context.tsx#L830-L1320`, session provider responsibilities, daemon subscriptions, and authoritative state application.
