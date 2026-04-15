# Plan-001: Shared Session Core

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `001` |
| **Slug** | `shared-session-core` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-001: Shared Session Core](../specs/001-shared-session-core.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-002](../decisions/002-local-execution-shared-control-plane.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md) |

## Goal

Implement the minimum session creation, join, snapshot, and replay foundation used by all later features.

## Scope

This plan covers session ids, default channel creation, owner membership bootstrap, local event append, and typed session read or subscribe APIs.

## Non-Goals

- Invite lifecycle
- Runtime-node attach
- Queue and intervention behavior

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/session.ts`
- `packages/client-sdk/src/sessionClient.ts`
- `packages/runtime-daemon/src/session/session-service.ts`
- `packages/runtime-daemon/src/session/session-projector.ts`
- `packages/control-plane/src/sessions/session-directory-service.ts`
- `apps/desktop/renderer/src/session-bootstrap/`

## Data And Storage Changes

- Add shared `sessions` and `session_memberships` tables to Collaboration Control Plane storage.
- Add local `session_events` and `session_snapshots` tables to Local Runtime Daemon SQLite.

## API And Transport Changes

- Add `SessionCreate`, `SessionRead`, `SessionJoin`, and `SessionSubscribe` to the shared client SDK and daemon/control-plane contracts.

## Implementation Steps

1. Define session contracts and ids in `packages/contracts`.
2. Implement shared Collaboration Control Plane session directory create or read or join paths.
3. Implement Local Runtime Daemon session event append and snapshot projection.
4. Add client SDK methods and desktop bootstrap wiring for create, join, read, and subscribe.

## Parallelization Notes

- Contract definitions and Collaboration Control Plane storage work can proceed in parallel with Local Runtime Daemon projection scaffolding.
- Desktop renderer integration should wait until client SDK contracts are stable.

## Test And Verification Plan

- Contract tests for session payload validation
- Integration tests for create and join and replay bootstrap
- Manual verification of create then reconnect then join from second client

## Rollout Order

1. Ship contracts and storage migrations
2. Enable create and read behind internal feature flag
3. Enable join and live subscribe once replay is stable

## Rollback Or Fallback

- Disable create or join endpoints and keep `local-only` session bootstrap if shared session flows regress.

## Risks And Blockers

- Event ordering mistakes between local and shared projections
- Unresolved `local-only` session promotion semantics

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
