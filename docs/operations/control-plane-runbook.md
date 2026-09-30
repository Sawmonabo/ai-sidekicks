# Control-Plane Runbook

## Purpose

Recover the person's own control plane and relay, on their Cloudflare account or their own Compose server, when linking a device, signing a machine in, or reaching a machine from a device is failing.

## Symptoms

- A device cannot link: the new device never shows the six digits, or the linking device never sees it confirm
- A machine card reads `Not reachable · last seen <when>` while that machine's service is running
- A device card reads `Seen in two places at once. Revoke it if you did not expect this.`
- `sidekicks daemon status` prints `refused: the relay's key does not match the one pinned when it was linked`
- `sidekicks sign-in` fails on a machine
- Scope and blast radius: every device's reach to every machine through that relay. Sessions keep running on their machines, and the desktop app on each machine keeps driving its own sessions over the machine's local connection.

## Detection

- On the machine, run `sidekicks daemon status`. While a relay is configured it prints the relay block: each linked device by name, connected or not, the age of the last frame out and the last frame in, the reconnect count and the rejected-frame count, each counted since the service started. With no relay configured the block is absent.
- Every device not connected, with an old last frame in, means the machine's own relay connection is down. One device refused with a rejected-frame count that climbs, then stops for a minute, means that device went over its quota. One device that keeps reconnecting means its key is in two places.
- `sidekicks devices` prints the account's machines and devices, as the Devices page's cards show them.
- Read the relay's own logs: the Worker's logs in the person's Cloudflare account, or `docker compose logs` on the Compose server.

## Preconditions

- The `sidekicks` command line on one of the person's machines
- For the Workers relay, the person's own Cloudflare account; for the Compose relay, a shell on the server that runs its `docker-compose.yml` (Node, Caddy and Postgres)
- A device already linked, or a passkey, to link a device again after a revoke

## Recovery Steps

1. Run `sidekicks daemon status` on the machine and read the relay block against Detection.
2. If the machine's own relay connection is down, check the machine's network, then the relay: the Worker's deployment in the Cloudflare account, or the containers on the Compose server. On the Compose server, bring Postgres back before restarting the Node service.
3. If `sidekicks sign-in` fails, fix the relay first. Sign-in runs only while the service is stopped, so stop it (`sidekicks daemon stop`, or `Stop` on Settings › Runtime), run `sidekicks sign-in` on the machine, and start the service again (`sidekicks daemon start`).
4. If one device was refused for going over its quota of 6,000 device-sent frames a minute, it gets one refusal frame and a 60-second pause, and resumes after the pause; nothing needs doing.
5. If a device card reads `Seen in two places at once`, its key is in two places. If that is not expected, revoke the device (`Revoke` on its card, or `sidekicks devices revoke <device>`) and link the real device again as a new one.
6. If a device refuses a machine with `<machine> is using a new key, so it was not connected.`, the machine was reinstalled without a key rotation: remove it on Devices and link it again. Linked again, it mints a new identity key under its same machine id, and its new `runtimenode.added` moves every device's pin for that id; its store, sessions and id stay.
7. If `sidekicks daemon status` prints `refused: the relay's key does not match the one pinned when it was linked`, and the relay was redeployed on purpose with a new key, run `sidekicks relay repin --force` with the new key's hash. Only a relay without a publicly trusted certificate is pinned; a pinned relay's key that changed without a deliberate redeploy is treated as an attack and left refused.
8. Link one device and open one known session from it before declaring recovery complete.

## Validation

- The relay block of `sidekicks daemon status` shows each expected device connected, with a recent last frame out and in
- Each machine card reads `Reachable` on a linked device
- A device links, with the same six digits confirmed on both screens, and opens a known session on the machine that holds it

## Escalation

- When the relay stays unreachable after a redeploy, or the Compose server's Postgres cannot be brought back, report it to the project as a bug with the relay block and the relay's logs attached

## CLI Commands

```bash
sidekicks daemon status          # the relay block, and a refused relay pin
sidekicks devices                # the machines and the linked devices
sidekicks devices revoke <device>
sidekicks daemon stop            # sign-in runs only while the service is stopped
sidekicks sign-in
sidekicks daemon start
sidekicks relay repin --force    # a relay without a publicly trusted certificate, redeployed on purpose
```

## SLOs and Thresholds

| Threshold | Value |
| --- | --- |
| Machine shown `Not reachable` | 45 seconds without a frame on its relay connection |
| Per-device quota | 6,000 device-sent frames a minute; over it, one refusal frame and a 60-second pause |
| Live connections per key | One; a new connection closes the one before it |
| Key in two places | Three displacements within a minute; the relay refuses both connections for a minute |
| Channel rekey | A fresh handshake on every connection and every 10 minutes on a long one |

## Who Runs It And Where To Report

- The relay belongs to one person, who runs this procedure on their machine and their own relay; there is no paging, no chat alert and no on-call rotation.
- A relay that stays unreachable after these steps is reported to the project as a bug, with the relay block and the relay's logs attached.

## Related Architecture Docs

- [Control Plane Architecture](../architecture/control-plane.md)
- [Data Architecture](../architecture/data-architecture.md)
- [Security Architecture](../architecture/security-architecture.md)

## Related Specs

- [Identity And User State](../specs/016-identity-and-user-state.md)
- [Self-Host Secure Defaults](../specs/024-self-host-secure-defaults.md)
- [Remote Control](../specs/028-remote-control.md)

## Related Plans

- [Session Core](../plans/001-session-core.md)
- [Remote Control](../plans/028-remote-control.md)
