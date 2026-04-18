# Plan-005: Provider Driver Contract And Capabilities

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `005` |
| **Slug** | `provider-driver-contract-and-capabilities` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-005: Provider Driver Contract And Capabilities](../specs/005-provider-driver-contract-and-capabilities.md) |
| **Required ADRs** | [ADR-005](../decisions/005-provider-drivers-use-a-normalized-interface.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md) |
| **Dependencies** | None |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |
| **References** | [ADR-011](../decisions/011-generic-intervention-dispatch.md) (generic intervention dispatch), [Updated Spec-005](../specs/005-provider-driver-contract-and-capabilities.md) (applyIntervention, 7 capability flags) |

## Goal

Implement the normalized provider driver contract, capability registry, and runtime binding persistence.

## Scope

This plan covers shared driver interfaces, two initial drivers, capability refresh, and recovery binding storage.

## Non-Goals

- Multi-agent workflow semantics
- Provider-specific UI tuning beyond capability exposure
- Support for every future provider in the first pass
- Shared hosted execution drivers

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/provider-driver.ts`
- `packages/runtime-daemon/src/provider/provider-registry.ts`
- `packages/runtime-daemon/src/provider/runtime-binding-store.ts`
- `packages/runtime-daemon/src/provider/drivers/codex/`
- `packages/runtime-daemon/src/provider/drivers/claude/`
- `packages/client-sdk/src/providerClient.ts`

## Data And Storage Changes

- Add local `runtime_bindings` and `driver_capabilities` persistence.
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for column definitions.

## API And Transport Changes

- Add typed driver capability and driver runtime events to the client SDK.
- Define internal driver interface for 10 operations: create, resume, start, interrupt, respond, close, applyIntervention, listModels, listModes, getCapabilities.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define contract types and capability schema. The driver contract enumerates 10 operations: `create`, `resume`, `start`, `interrupt`, `respond`, `close`, `applyIntervention`, `listModels`, `listModes`, `getCapabilities`. The capability schema defines 7 flags: `resume`, `steer`, `interactive_requests`, `mcp`, `tool_calls`, `reasoning_stream`, `model_mutation`.
2. Implement registry and runtime binding persistence.
3. Implement initial Codex and Claude drivers against the contract as local-runtime-node integrations rather than shared hosted execution services.
4. Add client SDK exposure for capability-aware controls and diagnostics. Include degraded-fallback behavior: when `applyIntervention` receives an unsupported intervention type the driver returns a structured rejection so the caller can degrade gracefully rather than error.

## Parallelization Notes

- Contract work and binding-store work can start first.
- Codex and Claude driver implementations can proceed in parallel once the contract stabilizes.

## Test And Verification Plan

- Contract conformance tests for driver lifecycle methods
- Capability matrix tests for control exposure
- Recovery tests for adopt-existing and resume-handle paths
- Integration tests proving driver lifecycle and policy enforcement stay daemon-local even when the provider endpoint itself is remote

## Rollout Order

1. Land shared driver contract and registry
2. Port first driver
3. Port second driver
4. Enable capability-driven UI behavior

## Rollback Or Fallback

- Keep one driver behind a compatibility adapter if the full contract rollout regresses.

## Risks And Blockers

- Contract churn while both initial drivers are under construction
- Recovery semantics may diverge before enough conformance tests exist
- Remote provider APIs can be mistaken for permission to centralize driver execution unless the local-runtime boundary stays explicit in code and docs

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
