# Component Architecture Control Plane

## Purpose

Define the hosted or self-hosted Control Plane and its internal responsibilities.

## Scope

This document covers the remote services inside the Control Plane that connect one user's devices to the runtime nodes executing that user's sessions.

## Context

The Control Plane exists so a user's devices can reach the machine a session runs on without the control plane becoming the code-execution environment.

## Responsibilities

- authenticate the user and the device acting for them
- keep the device registry: link, rename, revoke
- track device and runtime-node liveness
- broker relay connectivity between a user's devices and that user's runtime nodes
- deliver notifications and session metadata
- provide a durable directory for sessions and coordination state

## Component Boundaries

| Component | Responsibility |
| --- | --- |
| `Identity Service` | Authenticates the user and the device acting for them, and issues the identity claims every other service reads. |
| `Session Directory` | Stores session metadata needed for discovery, device reconnect, and coordination. |
| `Device Registry` | Holds one durable row per linked device — name, kind, public identity key, link time, revocation — and answers "which devices can act as this user". |
| `Device Liveness Service` | Tracks device and runtime-node heartbeats and disconnect grace windows. Liveness is about the user's own endpoints; it is never a roster of other people. |
| `Relay Broker` | Helps a user's devices and runtime nodes establish connectivity without taking over execution. |
| `Artifact Relay Blob Store` | Holds eagerly pinned, digest-addressed E2EE artifact ciphertext chunks and per-`(user, node)` wrapped CEKs (durable artifact keys) with refcount/TTL GC and quota accounting; never holds decryption-capable key material ([Spec-014 §Cross-Node Artifact Relay (V1)](../specs/014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1); lands with Plan-014 Tasks 7–10). |
| `Notification Service` | Delivers attention and session-level notifications to the user's connected devices, and queues them when no device is connected. |
| `Shared Metadata Store` | Persists the session directory, device registry, and liveness state that a user's devices and nodes read. |

## Implementation Home

- Primary implementation root: `packages/control-plane/`
- Shared contracts consumed here: `packages/contracts/`
- Shared client-facing transport types consumed here: `packages/client-sdk/`

## Data Flow

1. A device authenticates with the identity service using its own registered identity key.
2. A new device is linked: it registers its public identity key and takes a row in the device registry.
3. The device reads the session directory to find the user's sessions and the runtime node each is bound to.
4. The liveness service receives heartbeats from that user's devices and runtime nodes.
5. The relay broker negotiates a session-scoped, short-lived connection so the device and the runtime node can exchange end-to-end-encrypted frames; notification delivery rides the same session metadata.
6. Local Runtime Daemons continue to execute work and push the coordination data the control plane needs — plus, at `artifact.publish` of a shared artifact, encrypted ciphertext for relay pinning ([Spec-014 §Cross-Node Artifact Relay (V1)](../specs/014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1)); the control plane never receives plaintext payloads or decryption-capable keys.

## Trust Boundaries

- The control plane is trusted for identity, device registration, liveness, and relay coordination.
- The control plane is not trusted as the local filesystem or tool-execution authority for the user's runtime nodes.
- The control plane carries relay ciphertext and cannot read it: relay pathways must minimize trust and exposure because they cross remote infrastructure.

## Failure Modes

- Device linking or revocation fails while local session execution continues.
- Device or node liveness becomes stale because a client disconnects without clean shutdown.
- Relay negotiation succeeds for the device but fails to establish live runtime-node connectivity, so the device must report the machine as unreachable rather than appear to work.
- A revoked device's connection is not closed promptly, leaving a window in which a retired device still reaches the relay.

## Related Domain Docs

- [Session Model](../domain/session-model.md)
- [User And Device Model](../domain/user-and-device-model.md)
- [Runtime Node Model](../domain/runtime-node-model.md)

## Related Specs

- [Shared Session Core](../specs/001-shared-session-core.md)
- [Remote Control](../specs/031-remote-control.md)
- [Identity And User State](../specs/018-identity-and-user-state.md)

## Related ADRs

- [Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
- [Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)
