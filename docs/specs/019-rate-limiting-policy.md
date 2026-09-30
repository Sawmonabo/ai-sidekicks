# Spec-019: Rate Limiting Policy

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `019` |
| **Slug** | `rate-limiting-policy` |
| **Date** | `2026-04-15` |
| **Author(s)** | `Codex` |
| **Depends On** | [Deployment Topology](../architecture/deployment-topology.md), [Security Architecture](../architecture/security-architecture.md) |
| **Implementation Plan** | [Plan-019: Rate Limiting Policy](../plans/019-rate-limiting-policy.md) |

## Purpose

Define the rate limiting policy for every surface of the person's own relay and control plane: keep it available, contain abuse from anyone who reaches its address, and stop a runaway client of the person's own from flooding it.

## Scope

This spec covers rate limiting for:

- Control plane APIs
- WebSocket connections

The relay is the person's own, in both deployments [ADR-020](../decisions/020-v1-deployment-model-and-oss-license.md) describes: the Workers relay in the person's own Cloudflare account, or the self-hosted relay they run with Docker Compose (Node, Caddy, Postgres). Only the person's own machines and devices call it with credentials, each authenticating as the person.

The local daemon is explicitly excluded. It is trusted by socket reachability and does not require rate limiting.

## Non-Goals

- Local daemon rate limiting
- Per-provider or per-model token-level throttling
- Billing or usage metering: nothing is billed, because the relay serves its one owner
- Bans and automatic escalation: the relay blocks no identity beyond a limit's own window, and a stolen device's token is answered by revoking that device
- Admin credentials for more than one person: the relay has one owner
- A relay serving other people, or a free public relay

## Domain Dependencies

- [Session Model](../domain/session-model.md)
- [User And Device Model](../domain/user-and-device-model.md)

## Architectural Dependencies

- [Deployment Topology](../architecture/deployment-topology.md)
- [Security Architecture](../architecture/security-architecture.md)

## Required Behavior

### Deployment-Aware Abstraction

- The rate limiting implementation must be deployment-aware. The Workers relay must use Cloudflare's native `rate_limit` binding, with a per-identity Durable Object beside it for the credential routes. The self-hosted relay must use `rate-limiter-flexible` with a Postgres backend.
- On the Workers relay, the credential routes — sign-in, token refresh and device linking — must count in the per-identity Durable Object, one global counter per identity, and not in the per-location binding. A caller rotating through edge locations therefore meets one global count on the routes worth guessing at. Every other row keeps the per-location binding. The credential routes see a handful of requests per device per day, so the Durable Object round trip on them (10 to 50 ms) is never felt.
- Both implementations must enforce identical limits and expose the same programmatic interface. The implementation must swap via deployment configuration, not application code changes.

### Canonical Endpoint Group Registry

This registry is the **single enumeration** of every enforced limit, and no other table in this spec enumerates limits. Implementations iterate this registry; the `Key` column is the canonical machine key used by `RateLimitCheck.endpoint`, middleware wiring, and metric labels.

| Key | Display name | Limit | Window | Identity scope | Tier | Enforcement class |
| --- | --- | --- | --- | --- | --- | --- |
| `general.api` | General API (fallback bucket) | 100/min | 60s | per user | authenticated | sliding_window |
| `auth.endpoint` | Auth endpoints | 20/min | 60s | per IP | anonymous | sliding_window |
| `unauthenticated.request` | Unauthenticated (fallback bucket) | 30/min | 60s | per IP | anonymous | sliding_window |
| `presence.heartbeat` | Presence heartbeat | 10/min | 60s | per device | authenticated | sliding_window — counted by the machine that reads it, inside the device's sealed connection, never by the relay; the machine drops the excess and keeps the last heartbeat per device (see registry semantics below) |
| `approval.resolve` | Approval resolve | 30/min | 60s | per user | authenticated | sliding_window — dormant (see registry semantics below) |
| `artifact.publish` | Artifact publish | 20/min | 60s | per user | authenticated | sliding_window — dormant (see registry semantics below) |
| `health.check` | Health check | 120/min | 60s | per IP | anonymous | sliding_window |
| `ws.message` | Device-sent relay frames | 6,000/min | 60s | per device | authenticated | sliding_window — counted in the relay's memory for the device's one live connection; frames the machine sends, and bytes either way, are bounded by the channel's per-connection backpressure and never by this row |

Registry semantics:

- **Fallback buckets.** `general.api` applies to every authenticated control-plane procedure that has no more-specific registry row; `unauthenticated.request` applies to every unauthenticated procedure with no more-specific row. A request is counted against exactly one sliding-window row: the most specific matching row, else its tier's fallback bucket.
- **Dormant rows.** `approval.resolve` is priced and reserved but wired by nobody: an approval, a question or a plan is answered on the daemon of the machine that owns the session, and the local daemon IPC path is excluded from rate limiting (see §Scope and §Non-Goals). Every linked device can answer, and the first answer settles it; an answer from another device travels inside that device's end-to-end encrypted channel to the owning machine, whose daemon takes it as any other answer and records the answering device on the resolution event. The relay sees only frame sizes and times, never a method, so the answer counts as one frame under `ws.message` and no relay surface can meter `approval.resolve` itself. The row arms when such a surface exists — the local daemon becoming reachable over the network rather than through its socket alone, or an answer leaving the owning machine's daemon for a surface the control plane or the relay can read, even while the local daemon stays socket-only — and the plan that owns that surface wires it then at this registry's price; no backlog item. The relay does not count `presence.heartbeat` either, for the same reason: each device sends its presence heartbeat inside its channel to each machine it reaches, when the app's visibility changes and otherwise every 15 seconds, so the relay forwards it as one more frame under `ws.message` and never sees a heartbeat as such. The machine, the end that reads the method, counts it inside the device's sealed connection: it admits 10 a minute per connected device, drops the excess and keeps the last heartbeat per device ([Plan-028](../plans/028-remote-control.md)). `artifact.publish` joins the dormant class and takes `approval.resolve`'s reason exactly: **no control-plane method string or tRPC procedure for artifact publication is registered anywhere in the corpus.** Publication is a client↔daemon call ([Spec-012 §Interfaces And Contracts](./012-artifacts-files-and-attachments.md#interfaces-and-contracts); the [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) `ArtifactPublish` family's ingest sibling binds to the local IPC transport, whose 1 MB per-frame ceiling is an IPC-frame bound; [Plan-012](../plans/012-artifacts-files-and-attachments.md) registers `artifact.*` under the daemon JSON-RPC registry), and the local daemon path is excluded from rate limiting by §Scope, §Non-Goals, and this spec's own acceptance criterion. No network-reachable counterpart exists either: a device reads a session's artifacts from the machine that holds them, through Remote Control's method proxy inside the device's encrypted channel, so the relay carries no artifact upload or fetch. The 20/min price stays reserved and arms only if a network-reachable publication surface is introduced, a control-plane procedure or relay route accepting a publish directly, and the plan that owns that surface wires it then at this registry's price — **no backlog item**, the same posture as `approval.resolve`.
- **Per-frame WS limiting.** `ws.message` is evaluated per frame a device sends on its connection, whatever the frame carries (see §WebSocket Overflow Response), not per connection establishment alone. Frames on a machine's connection are not counted by it.

### Overflow Response

- When a sliding-window rate limit is exceeded, the system must respond with HTTP `429 Too Many Requests`.
- The response must include a `Retry-After` header indicating the number of seconds the client should wait.
- The response must include standard rate limit headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`.

### WebSocket Overflow Response

A device over its `ws.message` quota gets one in-band `rate_limited` error frame (the WebSocket analog of the 429 envelope, carrying `retryAfter: 60`, `limit`, `remaining: 0`, `resetAt`), and the relay then forwards nothing that device sends for 60 seconds; the connection stays open, and the frames of the pause draw no further refusal frame. The machine's `sidekicks daemon status` adds the refusal to that device's rejected-frame count in its relay block. The quota never closes the connection: closing converts a one-frame overflow into a reconnect storm. The frame shape is registered in [API Payload Contracts](../architecture/contracts/api-payload-contracts.md).

### Rate Limit Tiers

| Tier | Description | Multiplier |
| --- | --- | --- |
| anonymous | Unauthenticated requests (health check) | 1x (base) |
| authenticated | The person's own machines and devices, each authenticated as the person | 1x |

Every caller with credentials is the person, so one base limit serves every authenticated row and no caller holds a multiple of it. No "system service" principal exists.

Every registry row is a sliding-window counter. Refusals include the standard `RateLimitResponse` from [Error Contracts](../architecture/contracts/error-contracts.md).

## Default Behavior

- All rate limits are active by default for every control plane endpoint and WebSocket connection — **except rows explicitly marked dormant/reserved in the §Canonical Endpoint Group Registry** (`approval.resolve`, `artifact.publish`), whose limit is reserved and arms only when a network-reachable surface for it exists (see the registry's dormant-row semantics); a dormant row is not enforced by an ad hoc limiter.
- Clients that stay within limits receive no rate-limiting headers until they approach the threshold. "Approach the threshold" is defined as: `remaining < 25%` of the row's limit. Headers are always present on 429 responses, and are suppressed entirely while the backend is in fail-open grace (the degraded response arm carries no window fields to serialize).

## Fallback Behavior

- If the rate limiting backend (Postgres on the self-hosted relay; the Cloudflare `rate_limit` binding and the per-identity Durable Object on the Workers relay) is unavailable, the system must fail open for a bounded grace period (configurable, default 60 seconds) and must log the failure as a warning.
- If the grace period expires without backend recovery, the system must fail closed and reject requests with HTTP `503 Service Unavailable`.
- Grace-period admissions are marked `degraded`, suppress rate-limit headers, and count on `rate_limit_backend_error_total{backend}` rather than on `rate_limit_trip_total{endpoint,tier}`, so an outage is never read as a limit trip.

## Interfaces And Contracts

- `RateLimitCheck(identity, identityType, endpoint, tier?, context?) -> { allowed: boolean, remaining: number, resetAt: timestamp, limit: number } | { allowed: true, degraded: true, graceEndsAt: timestamp }` must be callable before request processing (the response's window arm carries the window fields; the fail-open degraded arm, returned only during grace, carries no window fields — `graceEndsAt` is the grace-expiry instant, never a window reset).
- All HTTP responses from rate-limited endpoints must include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers, subject to the §Default Behavior threshold-approach and degraded-suppression rules. (the admin API bullet is deleted)
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Rate limit counters are ephemeral and must not be persisted beyond their sliding window.

## Example Flows

- `Example: A loop in the phone app sends frames as fast as it can. The relay forwards the first 6,000 in the minute, answers the 6,001st with one rate_limited frame, and forwards nothing from the phone for 60 seconds while its connection stays open. On the machine, sidekicks daemon status shows the refusal in the phone's rejected-frame count.`
- `Example: An unauthenticated client hammers the auth endpoint 25 times in one minute. Requests 21 to 25 receive 429 with Retry-After, and the client is admitted again once its window frees; on the Workers relay the count is the same whichever edge location serves it.`

## Implementation Notes

- The abstraction layer should present a single `RateLimiter` interface that both Cloudflare and Postgres backends implement. Configuration selects the backend at startup.
- Sliding window counters are preferred over fixed windows to avoid burst-at-boundary behavior.
- WebSocket rate limiting applies per message frame, not per connection establishment alone; overflow semantics are pinned in §WebSocket Overflow Response.

## Pitfalls To Avoid

- Applying rate limits to the local daemon IPC path (it is trusted by design)
- Using fixed-window counters that allow double-rate bursts at window boundaries
- Failing to include `Retry-After` on 429 responses (clients cannot back off intelligently)

## Acceptance Criteria

- [ ] General API requests exceeding 100 req/user/min on the `general.api` fallback bucket receive HTTP 429 with correct rate limit headers.
- [ ] Auth endpoint requests exceeding 20 req/IP/min on `auth.endpoint` receive HTTP 429 with `Retry-After`.
- [ ] The Workers relay uses Cloudflare `rate_limit` with a per-identity Durable Object for the credential routes; the self-hosted relay uses `rate-limiter-flexible` with Postgres; both enforce identical limits.
- [ ] On the Workers relay, requests to the credential routes count once across every edge location: the 21st `auth.endpoint` request from one address in a minute is refused whichever location serves it.
- [ ] A device that sends more than 6,000 frames in a minute receives one `rate_limited` frame, its frames for the next 60 seconds are not forwarded and draw no further refusal frame, and its connection stays open.
- [ ] Local daemon endpoints are not rate-limited.

## Open Questions

None.

## References

- [Deployment Topology](../architecture/deployment-topology.md)
- [Security Architecture](../architecture/security-architecture.md)
- [OWASP API Security Top 10 (2023) — API4:2023 Unrestricted Resource Consumption](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/) — the governing class for per-caller rate limits
- [Cloudflare Workers — rate-limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) — `simple.period` accepts only 10 s or 60 s; the counter is per-Cloudflare-location rather than global; the binding is documented as "intentionally designed to not be used as an accurate accounting system". The source for why the credential routes count in the per-identity Durable Object (read 2026-08-25).
- [`rate-limiter-flexible`](https://github.com/animir/node-rate-limiter-flexible) — this spec's own self-hosted backend; latest `11.2.0`.
