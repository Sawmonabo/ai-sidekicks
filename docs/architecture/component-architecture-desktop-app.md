# Component Architecture Desktop App

## Purpose

Define the desktop shell, renderer, and client SDK boundaries.

## Scope

This document covers the desktop application as a client to local and shared system services.

## Context

The desktop app is the primary interactive client, but it must remain a client. Native integration and rich UI belong here; execution truth does not.

## Responsibilities

- render session, orchestration, repo, diff, approval, and invite experiences
- supervise the local daemon through the desktop shell
- provide native dialogs, notifications, updater flow, and safe host integration
- share one typed client SDK with the CLI

## Component Boundaries

| Component | Responsibility |
| --- | --- |
| `Electron Main` | Window lifecycle, updater, daemon supervision, native OS integration, and secure preload wiring. |
| `Preload Bridge` | Narrow, typed native bridge between renderer and main process. |
| `Renderer` | Session UI, diff UI, workflow authoring, approvals, invites, settings, and live projections. |
| `Client SDK` | Typed protocol layer used by renderer and CLI to talk to local daemon and control plane. |
| `Local Cache` | Optional client-side cache for drafts, view state, and offline-friendly presentation metadata. |

## Data Flow

1. The renderer issues typed requests through the client SDK.
2. The client SDK talks to the local daemon for execution state and to the control plane for shared session coordination.
3. The preload bridge and main process provide native dialogs, updater events, file picking, and safe OS interactions.
4. The renderer merges live projections and local view state into interactive session surfaces.

## Trust Boundaries

- The renderer is less trusted than the main process and local daemon.
- The preload bridge must be narrow and capability-based.
- Native OS actions must be routed through controlled shell APIs rather than arbitrary renderer escape hatches.

## Failure Modes

- The renderer loses connection to the daemon and must enter reconnect or degraded read-only mode.
- Renderer and daemon versions drift and require compatibility handling or upgrade enforcement.
- Native bridge calls fail because the shell is unavailable or permissions are missing.

## Related Domain Docs

- [Session Model](../domain/session-model.md)
- [Participant And Membership Model](../domain/participant-and-membership-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

## Related Specs

- [Local IPC And Daemon Control](../specs/007-local-ipc-and-daemon-control.md)
- [Live Timeline Visibility And Reasoning Surfaces](../specs/013-live-timeline-visibility-and-reasoning-surfaces.md)
- [Notifications And Attention Model](../specs/019-notifications-and-attention-model.md)

## Related ADRs

- [Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)
