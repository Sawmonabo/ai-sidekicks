# System Context

## Purpose

Describe the whole-system architecture and its primary external actors.

## Scope

This document defines the greenfield system at the highest level: clients, local execution, remote coordination, external providers, and developer resources.

## Context

The product is an agentic coding runtime for one user and their sidekicks. **Remote control is first-class**: one user, many linked devices, one machine executing. Any linked device does everything the desktop can — read the timeline, send, steer, stop, approve, drive sidekicks, view the diff, use the terminal — while code execution stays on the user-controlled runtime node that holds the repo.

Primary actors:

- the user
- the user's linked devices
- user-controlled runtime nodes
- desktop and CLI clients
- the control plane
- external provider runtimes
- git hosting and repository infrastructure

## Responsibilities

- provide durable sessions the user can reach from any linked device
- keep execution local to the user's runtime nodes
- coordinate device registration, liveness, relay, and notifications through the control plane
- expose one canonical event model for chat, runs, approvals, interventions, and artifacts
- support repo-bound coding flows with worktree isolation and attributable diffs

## Component Boundaries

- `Desktop App` and `CLI` are clients. They render and control; they do not become the system of record.
- `Local Runtime Daemon` is the execution kernel on each of the user's machines.
- `Control Plane` owns the device registry, device and node liveness, relay, and notification concerns.
- `Provider Drivers` adapt external AI runtimes into the daemon's normalized run contract.
- `Git Engine` and workspace services stay inside the local execution boundary because they touch local code and filesystem state.

## Data Flow

1. The user creates a session from the desktop app or CLI, or opens an existing one from another linked device.
2. The control plane authenticates the device, resolves the session from its directory, and negotiates relay connectivity to the runtime node the session is bound to.
3. The user's local runtime daemon attaches runtime nodes, workspaces, and agents to the session.
4. Runs execute locally through provider drivers and workspace services.
5. Local runtime events append to the canonical local event log and publish live updates.
6. Session metadata, device and node liveness, and notification signals flow through the control plane.
7. Clients read projections from both local runtime and control-plane surfaces to render the session.

## Client Delivery Path

- `CLI` is the first implementation client for the typed local daemon contract.
- `Desktop App` follows as a richer client over the same client SDK and daemon surfaces.
- New local execution capabilities should become consumable through the shared client SDK and CLI path before they rely on renderer-only behavior.

## Trust Boundaries

- The boundary between client and local daemon separates presentation from execution authority.
- The boundary between local daemon and control plane separates code execution from device-to-node coordination.
- The boundary between daemon and external providers separates normalized run semantics from provider-native behavior.

## Failure Modes

- The local daemon is unavailable, preventing execution on that node.
- The control plane is unavailable, preventing device linking, liveness, or remote access to a running session.
- Provider drivers fail or drift from expected capability behavior.
- Event projection lag causes stale client views until catch-up completes.

## Related Domain Docs

- [Glossary](../domain/glossary.md)
- [Session Model](../domain/session-model.md)
- [User And Device Model](../domain/user-and-device-model.md)
- [Runtime Node Model](../domain/runtime-node-model.md)
- [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md)

## Related Specs

- [Session Core](../specs/001-session-core.md)
- [Runtime Node Attach](../specs/002-runtime-node-attach.md)
- [Remote Control](../specs/028-remote-control.md)

## Related ADRs

- [Session Is The Primary Domain Object](../decisions/001-session-is-the-primary-domain-object.md)
- [Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
