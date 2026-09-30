# Control Plane Architecture

## Purpose

Define the Control Plane, the person's own control plane and relay on their Cloudflare account or their own Compose server, and its internal responsibilities.

## Scope

This document covers the remote services inside the Control Plane that connect one user's devices to the runtime nodes executing that user's sessions.

## Context

The Control Plane exists so a user's devices can reach the machine a session runs on without the control plane becoming the code-execution environment.

## Responsibilities

- authenticate the user and the machine or device acting for them
- keep the account's statement chain and the device and machine registry
- register each machine under its own id and its owning user
- relay one encrypted channel between each of the user's devices and each of their machines, and say whether each machine's relay connection is up
- carry push notices each machine has already sealed, adding only the person's own push credentials
- serve the web client

## Component Boundaries

| Component | Responsibility |
| --- | --- |
| `Identity Service` | Authenticates the user and the machine or device acting for them, and issues the identity claims every other service reads. |
| `Device Registry` | Holds the account's statement chain (`device.linked`, `device.renamed`, `device.revoked`, `passkey.added`, `passkey.removed`, `runtimenode.added`, `runtimenode.renamed`, `runtimenode.removed` and `runtimenode.key_rotated`) and one row per linked device and registered machine: name, platform, public identity key, link time, revocation. Every machine verifies the chain itself; the registry's own view of who may use the relay is for spam and cost only. |
| `Device Liveness Service` | Reads reachability from the relay connections, with no heartbeat table: a machine is `Reachable` while its connection is up and `Not reachable · last seen <when>` after 45 seconds without a frame, and a device is `Connected now` while it holds a connection, its `last seen` written at most once a minute. Liveness is about the user's own endpoints; it is never a roster of other people. |
| `Relay Broker` | Relays one Noise channel between each of the user's devices and each of their machines without taking over execution. It holds at most one live connection per key and enforces the per-device quota, and it sees ids, the channel profile, frame sizes and times, never a method, a name or a byte of a session. |
| `Notification Service` | Carries push notices each machine has already sealed to a device's push key, adding only the person's own APNs, FCM or VAPID credentials. It holds nothing that opens a notice and queues nothing. |
| `Web Client Host` | Serves the web client: the same front end the desktop runs, which a browser opens or a phone adds to its Home Screen. |
| `Shared Metadata Store` | Persists the account, the statement chain, the device registry and each machine's registration. It keeps no session record: a device reaches a session only through its machine over the relay, and the machine's daemon is the session's one store. |

## Implementation Home

- Primary implementation root: `packages/control-plane/`
- Shared contracts consumed here: `packages/contracts/`
- Shared client-facing transport types consumed here: `packages/client-sdk/`

## Data Flow

1. The person's first machine signs in and opens the account's statement chain with a `runtimenode.added` statement it signs itself. Its registration carries its id, public key, name, platform and service version.
2. A new device is linked from a device or machine already in use: both screens show the same six digits, and the linking side signs a `device.linked` statement for the new device's public identity key. Every later machine joins the same way, the linking side signing a `runtimenode.added` for the new machine's key instead of a `device.linked`.
3. Each machine keeps one outbound connection to the relay while its service runs, and each device connects while its app is open.
4. The device opens one Noise channel to each machine it can reach, through the relay, and opens a session by asking each machine whether it holds it.
5. When a session starts waiting on the person, finishes or fails, the machine seals a push notice to each device's push key and hands it to the relay, which adds the person's own push credentials.
6. Local Runtime Daemons continue to execute work; the control plane never receives plaintext payloads or decryption-capable keys.

## Trust Boundaries

- The control plane is trusted to keep the statement chain available, to route connections and to relay frames. It is not trusted to decide which keys are trusted: every machine verifies the chain itself, and a revoke the control plane withholds from one machine is caught at the next connection of any honest device.
- The control plane is not trusted as the local filesystem or tool-execution authority for the user's runtime nodes.
- The control plane carries relay ciphertext and cannot read it: relay pathways must minimize trust and exposure because they cross remote infrastructure.

## Failure Modes

- Device linking or revocation fails while local session execution continues.
- A device or machine drops its connection without a clean close, and shows as reachable until 45 seconds pass without a frame.
- The device reaches the relay but the machine's connection is down, so the device reports the machine as `Not reachable · last seen <when>` rather than appear to work.
- A revoked device's connection is not closed promptly, leaving a window in which a retired device still reaches the relay.

## Related Domain Docs

- [Session Model](../domain/session-model.md)
- [User And Device Model](../domain/user-and-device-model.md)
- [Runtime Node Model](../domain/runtime-node-model.md)

## Related Specs

- [Session Core](../specs/001-session-core.md)
- [Remote Control](../specs/028-remote-control.md)
- [Identity And User State](../specs/016-identity-and-user-state.md)

## Related ADRs

- [Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
- [Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)
