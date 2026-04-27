# Repo Exploration Series

Date: 2026-04-14

Project root: `/home/sabossedgh/dev/external/paseo`

## Table of Contents

- [Purpose](#purpose)
- [Document Map](#document-map)
- [Citation Format](#citation-format)
- [Sources](#sources)

## Purpose

This directory is a source-backed architectural walkthrough of the Paseo monorepo. It is organized by runtime boundary and package responsibility rather than by alphabetical file order, because the repo is built around a single daemon control plane with multiple clients and transports layered around it.[S1][S2]

## Document Map

- [00 Overview](./00-overview.md) explains the repo-wide topology, end-to-end execution flow, persistence model, and reading order.
- [01 Server Daemon](./01-server-daemon.md) explains the daemon bootstrap path, WebSocket protocol, session controller, provider registry, and server-side services.
- [02 App Client](./02-app-client.md) explains the Expo app shell, host runtime orchestration, session synchronization, and workspace UI model.
- [03 CLI And Desktop](./03-cli-and-desktop.md) explains the Commander CLI and the Electron wrapper that supervises a daemon.
- [04 Relay And Support Packages](./04-relay-and-support-packages.md) explains the encrypted relay transport plus the smaller support packages and website.
- [05 Server Services And Config](./05-server-services-and-config.md) explains daemon config resolution, trust boundaries, file-backed persistence, and the long-running server services behind schedules, loops, speech, chat, terminals, and workspace registries.
- [06 Server Providers And Normalization](./06-server-providers-and-normalization.md) explains how provider manifests, registry wrapping, and adapter clients normalize Claude, Codex, OpenCode, and ACP-style agents into one daemon contract.
- [07 App State UI And Routing](./07-app-state-ui-and-routing.md) explains the app's deeper route model, draft-agent form resolution, stream normalization, file and workspace navigation, and the settings/diagnostics surfaces.
- [08 Session And Agent Manager](./08-session-and-agent-manager.md) explains the daemon's per-client controller and shared agent runtime in detail: RPC dispatch, compatibility gates, timeline fetches, run orchestration, cancellation, permissions, and attention tracking.
- [09 Provider Transports And Features](./09-provider-transports-and-features.md) explains how each provider is actually driven under the hood: CLI, SDK, local app-server, local HTTP API, or ACP process; plus capability flags, feature handling, persistence, and normalization.

## Citation Format

Inline citations use short source keys such as `[S1]`. Each file ends with a `Sources` section that resolves those keys to concrete files and line ranges.

## Sources

- [S1] `package.json#L1-L105`, workspace package list, root scripts, and release/build structure.
- [S2] `docs/ARCHITECTURE.md#L3-L192`, system topology, package roles, protocol summary, and deployment models.
