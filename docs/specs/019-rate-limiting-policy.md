# Spec-019: Rate Limiting Policy

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `019` |
| **Slug** | `rate-limiting-policy` |
| **Date** | `2026-04-15` |
| **Author(s)** | `Codex` |
| **Depends On** | [Deployment Topology](../architecture/deployment-topology.md), [Security Architecture](../architecture/security-architecture.md) |
| **Implementation Plan** | [Plan-018: Rate Limiting Policy](../plans/018-rate-limiting-policy.md) |

## Purpose

Define how the person's own relay bounds the requests that reach it without a credential: its sign-in routes are counted, so anyone who reaches its address cannot run sign-in, token refresh or device linking attempts against it without bound.

## Scope

This spec covers the relay's sign-in routes: sign-in, token refresh and device linking.

The relay is the person's own, in both deployments [ADR-019](../decisions/019-v1-deployment-model-and-oss-license.md) describes: the Workers relay in the person's own Cloudflare account, or the self-hosted relay they run with Docker Compose (Node, Caddy, Postgres). Only the person's own machines and devices call it with credentials, each authenticating as the person.

The local daemon is explicitly excluded. It is trusted by socket reachability and does not require rate limiting.

## Non-Goals

- Local daemon rate limiting
- A limit on any route a credential reaches: every caller with credentials is the person
- A limit on the relay's channel: the relay forwards each device's frames as fast as the machine drains them, and backpressure on the channel bounds both directions
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

- Both deployments count the sign-in routes, with the same limit and the same programmatic interface. The Workers relay counts them in a per-identity Durable Object, one global counter per identity, so a caller rotating through edge locations meets one count. The sign-in routes see a handful of requests per device per day, so the Durable Object round trip on them (10 to 50 ms) is never felt. The self-hosted relay, one process, counts them in that process's memory.
- The implementation must swap via deployment configuration, not application code changes.

### Canonical Endpoint Group Registry

This registry is the **single enumeration** of every enforced limit, and no other table in this spec enumerates limits. Implementations iterate this registry; the `Key` column is the canonical machine key used by `RateLimitCheck.endpoint` and middleware wiring.

| Key | Display name | Limit | Window | Identity scope |
| --- | --- | --- | --- | --- |
| `auth.endpoint` | Sign-in routes: sign-in, token refresh and device linking | 20/min | 60s, sliding | per source address |

Nothing else on the relay is counted.

### Overflow Response

- When the limit is exceeded, the relay must respond with HTTP `429 Too Many Requests`.
- The response must include a `Retry-After` header indicating the number of seconds the client should wait.
- The refusal body is the standard `RateLimitResponse` from [Error Contracts](../architecture/contracts/error-contracts.md).

## Default Behavior

- The limit is active by default on every sign-in route.
- An allowed response carries no rate-limit header; `Retry-After` comes only on a 429.

## Fallback Behavior

- A counter error fails that one request like any backend error.

## Interfaces And Contracts

- `RateLimitCheck(identity, endpoint) -> { allowed: boolean, remaining: number, resetAt: timestamp, limit: number }` must be callable before request processing; `identity` is the caller's source address.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Rate limit counters are ephemeral and must not be persisted beyond their sliding window.

## Example Flows

- `Example: An unauthenticated client hammers the auth endpoint 25 times in one minute. Requests 21 to 25 receive 429 with Retry-After, and the client is admitted again once its window frees; on the Workers relay the count is the same whichever edge location serves it.`

## Implementation Notes

- The abstraction layer should present a single `RateLimiter` interface that the Durable Object counter and the in-memory counter both implement. Configuration selects the implementation at startup.
- Sliding window counters are preferred over fixed windows to avoid burst-at-boundary behavior.

## Pitfalls To Avoid

- Applying rate limits to the local daemon IPC path (it is trusted by design)
- Using fixed-window counters that allow double-rate bursts at window boundaries
- Failing to include `Retry-After` on 429 responses (clients cannot back off intelligently)

## Acceptance Criteria

- [ ] Sign-in route requests exceeding 20 per source address per minute on `auth.endpoint` receive HTTP 429 with `Retry-After`.
- [ ] The Workers relay counts the sign-in routes in a per-identity Durable Object and the self-hosted relay in its process's memory; both enforce the same limit.
- [ ] On the Workers relay, requests to the sign-in routes count once across every edge location: the 21st `auth.endpoint` request from one address in a minute is refused whichever location serves it.
- [ ] A counter error fails only the request it occurred on.
- [ ] Local daemon endpoints are not rate-limited.

## Open Questions

None.

## References

- [Deployment Topology](../architecture/deployment-topology.md)
- [Security Architecture](../architecture/security-architecture.md)
- [OWASP API Security Top 10 (2023) — API4:2023 Unrestricted Resource Consumption](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/) — the governing class for per-caller rate limits
- [Cloudflare Workers — rate-limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) — `simple.period` accepts only 10 s or 60 s; the counter is per-Cloudflare-location rather than global; the binding is documented as "intentionally designed to not be used as an accurate accounting system". The source for why the sign-in routes count in the per-identity Durable Object (read 2026-08-25).
