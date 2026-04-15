# System Context

## Purpose

Describe the whole-system architecture and its primary external actors.

## Scope

This document defines the greenfield system at the highest level: clients, local execution, shared coordination, external providers, and developer resources.

## Context

The product is a collaborative agent operating system for software work. It must combine local execution with shared session membership, presence, relay, and audit semantics. Collaboration is first-class, but code execution remains local to participant-controlled runtime nodes.

Primary actors:

- human participants
- participant-controlled runtime nodes
- desktop and CLI clients
- the collaboration control plane
- external provider runtimes
- git hosting and repository infrastructure

## Responsibilities

- provide durable shared sessions for humans and agents
- keep execution local to participant runtime nodes
- coordinate membership, invites, presence, relay, and notifications through the control plane
- expose one canonical event model for chat, runs, approvals, interventions, and artifacts
- support repo-bound coding flows with worktree isolation and attributable diffs

## Component Boundaries

- `Desktop App` and `CLI` are clients. They render and control; they do not become the system of record.
- `Local Runtime Daemon` is the execution kernel on each participant machine.
- `Collaboration Control Plane` owns shared membership, invite, presence, relay, and notification concerns.
- `Provider Drivers` adapt external AI runtimes into the daemon's normalized run contract.
- `Git Engine` and workspace services stay inside the local execution boundary because they touch local code and filesystem state.

## Data Flow

1. A participant uses the desktop app or CLI to create or join a session.
2. The control plane authorizes membership and announces shared session metadata.
3. The participant's local runtime daemon attaches runtime nodes, workspaces, and agents to the session.
4. Runs execute locally through provider drivers and workspace services.
5. Local runtime events append to the canonical local event log and publish live updates.
6. Shared metadata, presence, invite state, and notification signals flow through the control plane.
7. Clients read projections from both local runtime and shared control-plane surfaces to render the session.

## Client Delivery Path

- `CLI` is the first implementation client for the typed local daemon contract.
- `Desktop App` follows as a richer client over the same client SDK and daemon surfaces.
- New local execution capabilities should become consumable through the shared client SDK and CLI path before they rely on renderer-only behavior.

## Trust Boundaries

- The boundary between client and local daemon separates presentation from execution authority.
- The boundary between local daemon and control plane separates code execution from collaboration coordination.
- The boundary between daemon and external providers separates normalized run semantics from provider-native behavior.

## Failure Modes

- The local daemon is unavailable, preventing execution on that node.
- The control plane is unavailable, preventing invite, presence, or shared-session coordination.
- Provider drivers fail or drift from expected capability behavior.
- Event projection lag causes stale client views until catch-up completes.

## Related Domain Docs

- [Glossary](../domain/glossary.md)
- [Session Model](../domain/session-model.md)
- [Runtime Node Model](../domain/runtime-node-model.md)
- [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md)

## Related Specs

- [Shared Session Core](../specs/001-shared-session-core.md)
- [Runtime Node Attach](../specs/003-runtime-node-attach.md)
- [Control Plane Relay And Session Join](../specs/008-control-plane-relay-and-session-join.md)

## Related ADRs

- [Session Is The Primary Domain Object](../decisions/001-session-is-the-primary-domain-object.md)
- [Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
