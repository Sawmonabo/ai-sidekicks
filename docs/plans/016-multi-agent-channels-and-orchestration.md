# Plan-016: Multi-Agent Channels And Orchestration

| Field               | Value                                                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**          | `approved`                                                                                                                                                                                                  |
| **NNN**             | `016`                                                                                                                                                                                                       |
| **Slug**            | `multi-agent-channels-and-orchestration`                                                                                                                                                                    |
| **Date**            | `2026-04-14`                                                                                                                                                                                                |
| **Author(s)**       | `Codex`                                                                                                                                                                                                     |
| **Spec**            | [Spec-016: Multi-Agent Channels And Orchestration](../specs/016-multi-agent-channels-and-orchestration.md)                                                                                                  |
| **Required ADRs**   | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-005](../decisions/005-provider-drivers-use-a-normalized-interface.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md) |
| **Dependencies**    | [Plan-001](./001-shared-session-core.md) (session core), [Plan-004](./004-queue-steer-pause-resume.md) (queue/steer)                                                                                        |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md)                                                                                                                                   |

## Goal

Implement session-scoped channels, parent-child run linkage, and provider-agnostic orchestration semantics for concurrent multi-agent collaboration.

## Scope

This plan covers channel creation, orchestration run creation, durable run-link projection, internal-helper visibility flags, and desktop surfaces for concurrent agent work.

## Non-Goals

- Workflow authoring syntax
- Provider-native subagent APIs beyond normalized adapters
- Channel-level permission restrictions for the first pass

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/channels/`
- `packages/contracts/src/orchestration/`
- `packages/runtime-daemon/src/orchestration/channel-service.ts`
- `packages/runtime-daemon/src/orchestration/orchestration-run-service.ts`
- `packages/runtime-daemon/src/orchestration/run-link-projector.ts`
- `packages/client-sdk/src/orchestrationClient.ts`
- `apps/desktop/renderer/src/channels/`
- `apps/desktop/renderer/src/child-runs/`

## Data And Storage Changes

- Add durable `channels`, `run_links`, and internal-run metadata to local persistence so orchestration survives replay and restart.
- Extend timeline projections with summarized child-run rows that preserve parent linkage and producing runtime-node provenance.
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for column definitions.

## API And Transport Changes

- Add `ChannelCreate`, `OrchestrationRunCreate`, and `ChildRunLinkRead` to shared contracts and the typed client SDK.
- Carry internal-helper flags and target channel metadata through orchestration commands and run lifecycle events.
- Surface explicit orchestration rejection reasons for delegation-depth and active-child scheduler-limit failures.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define channel identity, run-link, and orchestration-create contracts in shared packages.
2. Implement daemon-side channel creation and parent-child run persistence with provider-agnostic orchestration hooks plus explicit depth and active-child admission checks.
3. Implement replayable run-link projections and summarized child-run publication into session timelines.
4. Add desktop channel and child-run surfaces for concurrent agent activity and expandable delegated-work detail.

## Parallelization Notes

- Channel-identity work and run-link persistence can proceed in parallel once orchestration payloads are fixed.
- Renderer channel surfaces should wait for summary-row and expansion semantics to stabilize.

## Test And Verification Plan

- Multi-agent run-link tests covering parent-child durability across replay and restart
- Driver-adapter tests proving delegated work remains possible when no native subagent primitive exists
- Scheduler-limit tests proving nested delegation and active-child overflow requests fail explicitly instead of spawning hidden work
- UI integration tests proving background helper work remains visible without collapsing into plain chat text

## Rollout Order

1. Land channel and run-link contracts plus persistence
2. Enable delegated child runs and summary-row publication
3. Enable desktop channel surfaces and internal-helper differentiation

## Rollback Or Fallback

- Collapse delegated work to the default session channel while preserving explicit parent-child linkage if channel delivery regresses.

## Risks And Blockers

- Channel-level restriction policy remains unresolved for the first implementation (deferred per [Spec-016 §Resolved Questions](../specs/016-multi-agent-channels-and-orchestration.md) — V1 decision: channel-level permission restrictions deferred)
- Provider-native orchestration differences can leak into product semantics unless normalized at the daemon boundary
- Scheduler-limit policy must remain visible to users and workflows so bounded fan-out does not look like silent runtime failure

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
