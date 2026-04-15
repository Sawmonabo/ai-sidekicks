# Spec-005: Provider Driver Contract And Capabilities

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `005` |
| **Slug** | `provider-driver-contract-and-capabilities` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Runtime Node Model](../domain/runtime-node-model.md), [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md), [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md), [Data Architecture](../architecture/data-architecture.md) |
| **Implementation Plan** | [Plan-005: Provider Driver Contract And Capabilities](../plans/005-provider-driver-contract-and-capabilities.md) |

## Purpose

Define the normalized driver boundary between the core runtime and provider-specific execution transports.

## Scope

This spec covers required driver operations, capability advertisement, normalized event shapes, and runtime binding persistence.

## Non-Goals

- UI behavior for every capability
- Provider-specific prompt tuning
- Provider commercial or billing concerns

## Domain Dependencies

- [Runtime Node Model](../domain/runtime-node-model.md)
- [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md)
- [Run State Machine](../domain/run-state-machine.md)

## Architectural Dependencies

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Data Architecture](../architecture/data-architecture.md)

## Required Behavior

- Every provider integration must implement a normalized driver contract.
- Provider drivers must execute within a participant-owned or operator-owned runtime node governed by a local daemon. V1 must not depend on a shared hosted driver service as the execution authority.
- The driver contract must support create session, resume session, start run, interrupt run, apply intervention, respond to interactive request, close session, and enumerate models or modes or both where available.
- The `applyIntervention` operation is a generic dispatcher that routes intervention requests (steer, interrupt, cancel) to the appropriate driver-specific handler based on the intervention type and the driver's declared capabilities. Drivers that do not support a given intervention type must return a `degraded` result, allowing the orchestration layer to fall back (e.g., steer degrades to queue + interrupt for providers without native steer support).
- Drivers must emit normalized runtime events rather than leaking provider-native event types into the session engine.
- Drivers must declare capability flags for at least `resume`, `steer`, `interactive_requests`, `mcp`, `tool_calls`, `reasoning_stream`, and `model_mutation`. The `pause` flag is intentionally excluded — no current provider implements native pause. Pause is an orchestration-layer construct (interrupt run, persist state, queue resume) that does not require driver support.
- Drivers must persist provider-owned resume handles separately from canonical session and run ids.
- The runtime must treat undeclared capabilities as unsupported.

## Default Behavior

- Driver capability declarations are required at attach time and may be refreshed when provider state changes.
- Initial provider drivers are local-runtime-node integrations. They may call remote provider APIs or services, but driver control and execution authority remain attached to the local runtime node.
- Unknown capability fields are ignored until the driver contract version explicitly supports them.
- The runtime must only surface controls that correspond to supported capabilities for the active run.

## Fallback Behavior

- If a driver cannot resume a previously persisted handle, it must surface `provider failure` detail and a visible `recovery-needed` condition; it must not silently create a replacement provider session under the same canonical run.
- If a provider offers provider-native data that cannot be normalized safely, the runtime must store it as diagnostic metadata only, not as canonical domain state.
- If a driver does not support dynamic model or mode mutation, the runtime must require a new run or agent configuration rather than simulating mutation.
- If a requested integration path would require shared hosted execution outside the local runtime boundary, v1 must reject or mark that path unsupported rather than routing execution through the collaboration control plane.

## Interfaces And Contracts

- Required driver operations:
  - `createSession`
  - `resumeSession`
  - `startRun`
  - `interruptRun`
  - `applyIntervention` — generic dispatcher for steer, interrupt, cancel; checks capability flags and returns `degraded` for unsupported intervention types
  - `respondToRequest`
  - `closeSession`
  - `listModels`
  - `listModes`
  - `getCapabilities`
- Required normalized event families:
  - run lifecycle
  - assistant output
  - tool activity
  - interactive request
  - artifact publication
  - usage or quota telemetry where available

## State And Data Implications

- Runtime bindings must store driver name, contract version, resume handle, and runtime metadata needed for recovery.
- Capability changes must be emitted as events so clients and projections can adjust behavior safely.
- Diagnostic raw events may be retained separately from canonical normalized events.

## Example Flows

- `Example: A local Codex driver starts a session through its native transport, exposes resume and steer capability, and emits normalized run events into the daemon.`
- `Example: A local Claude driver calls a remote provider API from the participant's runtime node. The provider service is remote, but the canonical driver authority and policy enforcement remain local.`
- `Example: A driver lacks pause support. The orchestration layer implements pause as: interrupt the active run, persist conversation history and run state to local SQLite, queue a resume. When the user resumes, a new turn is started with the full saved context. The driver only sees interruptRun followed later by startRun — it never needs to know about pause.`
- `Example: A user steers a Codex run. The orchestration layer calls applyIntervention(type: "steer", payload). The Codex driver supports steer natively via turn/steer and applies it. For a Claude run, applyIntervention returns degraded, and the orchestration layer falls back to queuing the steer content and interrupting the current turn.`

## Implementation Notes

- Keep the contract small but explicit. The runtime should not need provider-name branches to answer common lifecycle questions.
- Contract versioning should allow additive capability expansion without breaking older drivers.
- Resume handle persistence belongs to the runtime binding layer, not the user-facing domain model.

## Pitfalls To Avoid

- Letting provider-native ids replace canonical ids
- Treating missing capability declarations as implicitly supported
- Making the session engine understand transport-specific details such as JSON-RPC framing or stdio protocol

## Acceptance Criteria

- [ ] A new driver can be integrated without changing session or run domain semantics.
- [ ] Unsupported capabilities remain unavailable to the user and cannot be invoked accidentally.
- [ ] Driver recovery failure produces explicit `provider failure` detail and `recovery-needed` condition rather than silent session replacement.

## ADR Triggers

- If the runtime stops using a normalized driver interface, create or update `../decisions/005-provider-drivers-use-a-normalized-interface.md`.

## Open Questions

- No blocking open questions remain for v1.
- V1 decision: driver capability changes are refreshed on a bounded periodic cadence and may also be pushed live when supported. Correctness must not depend on push-only updates.
- V1 decision: the first implementation supports local-runtime-node drivers only. Shared hosted execution drivers are out of scope, even when a local driver talks to a remote provider API.

## References

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Runtime Node Model](../domain/runtime-node-model.md)
- [Run State Machine](../domain/run-state-machine.md)
