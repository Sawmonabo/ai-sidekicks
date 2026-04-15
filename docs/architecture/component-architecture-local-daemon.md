# Component Architecture Local Daemon

## Purpose

Define the internal components owned by the machine-local execution daemon, the Local Runtime Daemon.

## Scope

This document covers execution, orchestration, persistence, and local control components owned by the Local Runtime Daemon.

## Context

The Local Runtime Daemon is the local execution kernel. It must own the parts of the product that touch provider sessions, repositories, tools, terminals, and recovery state.

## Responsibilities

- host the session engine and local scheduling logic
- manage provider drivers and runtime-node capabilities
- manage repo mounts, workspaces, worktrees, and git actions
- execute tools and terminals within local trust policy
- persist local events, receipts, projections, and runtime bindings
- expose the local control surface used by the desktop app and CLI

## Component Boundaries

| Component | Responsibility |
| --- | --- |
| `Local Session Engine` | Applies commands, emits canonical events, owns run and queue semantics, and maintains session-scoped projections for the local node. |
| `Provider Driver Manager` | Creates, resumes, interrupts, and closes provider-backed execution sessions through normalized driver contracts. |
| `Git Engine` | Owns repo attach, worktree lifecycle, branch strategy, diff generation, and PR preparation. |
| `Workspace Service` | Resolves execution roots, file access policy, attachments, and local filesystem context. |
| `Tool And Terminal Service` | Runs shell commands, terminal sessions, and local tools under policy control. |
| `Local Persistence Layer` | Stores canonical local event log, command receipts, runtime bindings, projections, and recovery metadata. |
| `Local IPC Gateway` | Exposes stable local control APIs to renderer and CLI clients. |

## Implementation Home

- Primary implementation root: `packages/runtime-daemon/`
- Shared contracts consumed here: `packages/contracts/`
- Shared client-facing transport types consumed here: `packages/client-sdk/`

## Data Flow

1. A local client submits a command through IPC.
2. The local session engine validates the command against membership, node capability, and policy state.
3. The session engine invokes provider, git, workspace, or tool services as needed.
4. Resulting state changes become canonical local events and projection updates.
5. Live subscribers receive normalized updates, and recovery metadata is persisted for restart safety.

## Trust Boundaries

- The daemon trusts its own local persistence and execution policy decisions more than any remote client input.
- Provider drivers run at the daemon edge and must not leak provider-native semantics into the core engine.
- Tool and terminal execution cross from normalized orchestration into machine-side effects and therefore require explicit approval and policy enforcement.

## Failure Modes

- A provider driver cannot resume a prior session handle.
- The local event store is unavailable or inconsistent.
- Worktree creation or repo binding fails before a run can start.
- Terminal or tool subprocesses outlive the client connection and require daemon-owned cleanup.

## Related Domain Docs

- [Runtime Node Model](../domain/runtime-node-model.md)
- [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md)
- [Run State Machine](../domain/run-state-machine.md)
- [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md)

## Related Specs

- [Runtime Node Attach](../specs/003-runtime-node-attach.md)
- [Queue Steer Pause Resume](../specs/004-queue-steer-pause-resume.md)
- [Provider Driver Contract And Capabilities](../specs/005-provider-driver-contract-and-capabilities.md)
- [Local IPC And Daemon Control](../specs/007-local-ipc-and-daemon-control.md)
- [Worktree Lifecycle And Execution Modes](../specs/010-worktree-lifecycle-and-execution-modes.md)

## Related ADRs

- [Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
- [Provider Drivers Use A Normalized Interface](../decisions/005-provider-drivers-use-a-normalized-interface.md)
- [Worktree First Execution Mode](../decisions/006-worktree-first-execution-mode.md)
