# Spec-021: Rate Limiting Policy

| Field                   | Value                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Status**              | `approved`                                                                                                                       |
| **NNN**                 | `021`                                                                                                                            |
| **Slug**                | `rate-limiting-policy`                                                                                                           |
| **Date**                | `2026-04-15`                                                                                                                     |
| **Author(s)**           | `Codex`                                                                                                                          |
| **Depends On**          | [Deployment Topology](../architecture/deployment-topology.md), [Security Architecture](../architecture/security-architecture.md) |
| **Implementation Plan** | [Plan-021: Rate Limiting Policy](../plans/021-rate-limiting-policy.md)                                                           |

## Purpose

Define the rate limiting policy for all API surfaces to protect system availability, prevent abuse, and ensure fair resource allocation across participants.

## Scope

This spec covers rate limiting for:

- Control plane APIs
- WebSocket connections
- Invite redemption

The local daemon is explicitly excluded. It is trusted by socket reachability and does not require rate limiting.

## Non-Goals

- Local daemon rate limiting
- Per-provider or per-model token-level throttling
- Billing or usage metering

## Domain Dependencies

- [Session Model](../domain/session-model.md)
- [Participant And Membership Model](../domain/participant-and-membership-model.md)

## Architectural Dependencies

- [Deployment Topology](../architecture/deployment-topology.md)
- [Security Architecture](../architecture/security-architecture.md)

## Required Behavior

### Deployment-Aware Abstraction

- The rate limiting implementation must be deployment-aware. Cloudflare Workers deployments must use the native `rate_limit` binding (hosted). Self-hosted deployments must use `rate-limiter-flexible` with a Postgres backend.
- Both implementations must enforce identical limits and expose the same programmatic interface. The implementation must swap via deployment configuration, not application code changes.

### Edge Limits

| Limit           | Scope               | Threshold        |
| --------------- | ------------------- | ---------------- |
| General API     | per user per minute | 100 req/user/min |
| Auth endpoints  | per IP per minute   | 20 req/min       |
| Unauthenticated | per IP per minute   | 30 req/min       |

### Application Limits

| Limit                      | Scope                      | Threshold                                                                                                                                              |
| -------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Invite creation            | per session per hour       | 20 invites/session/hr                                                                                                                                  |
| Invite creation            | per participant per hour   | 50 invites/participant/hr                                                                                                                              |
| Pending invites            | per session                | 100 pending invites/session                                                                                                                            |
| Invite redemption attempts | per IP per minute          | 5 redemption attempts/IP/min                                                                                                                           |
| Session creation           | per participant per minute | 10 sessions/participant/min                                                                                                                            |
| Heartbeat                  | per participant per minute | 10 heartbeats/participant/min                                                                                                                          |
| Messages                   | per participant per minute | 60 messages/participant/min                                                                                                                            |
| KeyPackage uploads (V1.1+) | per user per hour          | 5 KeyPackage uploads/user/hr — applies once MLS ships per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md); no KeyPackage endpoint exists in V1 |

### Overflow Response

- When a rate limit is exceeded, the system must respond with HTTP `429 Too Many Requests`.
- The response must include a `Retry-After` header indicating the number of seconds the client should wait.
- The response must include standard rate limit headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`.

### Escalation

- 3 violations within 5 minutes must trigger a 15-minute block for the offending identity.
- 10 violations within 1 hour must trigger a 1-hour block for the offending identity and must emit an ops alert.
- Permanent bans must be manageable exclusively via the admin API. Automated escalation must not permanently ban without human action.

## Rate Limit Values

| Endpoint Group        | Limit          | Window          | Tier          |
| --------------------- | -------------- | --------------- | ------------- |
| Session create        | 10/min         | per participant | authenticated |
| Session join          | 30/min         | per participant | authenticated |
| Invite create         | 20/hr          | per session     | authenticated |
| Invite create         | 50/hr          | per participant | authenticated |
| Pending invites       | 100 concurrent | per session     | authenticated |
| Invite accept         | 10/min         | per token-hash  | anonymous     |
| Presence heartbeat    | 10/min         | per participant | authenticated |
| Event query (read)    | 60/min         | per participant | authenticated |
| Event subscribe (SSE) | 5 concurrent   | per participant | authenticated |
| Approval resolve      | 30/min         | per participant | authenticated |
| Artifact publish      | 20/min         | per session     | authenticated |
| Health check          | 120/min        | per IP          | anonymous     |

### Rate Limit Tiers

| Tier          | Description                                            | Multiplier |
| ------------- | ------------------------------------------------------ | ---------- |
| anonymous     | Unauthenticated requests (invite accept, health check) | 1x (base)  |
| authenticated | Standard authenticated participant                     | 1x         |
| elevated      | Session owner or system service                        | 3x         |

The elevated tier allows burst operations during session setup. All limits use the sliding window algorithm. Responses include the standard `RateLimitResponse` from [Error Contracts](../architecture/contracts/error-contracts.md).

## Default Behavior

- All rate limits are active by default for every control plane endpoint and WebSocket connection.
- Clients that stay within limits receive no rate-limiting headers until they approach the threshold.

## Fallback Behavior

- If the rate limiting backend (Postgres or Cloudflare KV) is unavailable, the system must fail open for a bounded grace period (configurable, default 60 seconds) and must log the failure as a warning.
- If the grace period expires without backend recovery, the system must fail closed and reject requests with HTTP `503 Service Unavailable`.

## Interfaces And Contracts

- `RateLimitCheck(identity, endpoint, context) -> { allowed: boolean, remaining: number, resetAt: timestamp }` must be callable before request processing.
- All HTTP responses from rate-limited endpoints must include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers.
- The admin API must expose `POST /admin/bans` and `DELETE /admin/bans/{id}` for permanent ban management.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Rate limit counters are ephemeral and must not be persisted beyond their sliding window.
- Escalation state (violation counts, active blocks) must be persisted in the rate limiting backend for the duration of the escalation window.
- Permanent bans must be stored durably and must survive backend restarts.

## Example Flows

- `Example: A participant sends 60 messages in one minute. The 61st message receives HTTP 429 with Retry-After: 12 and the participant must wait before sending again.`
- `Example: An unauthenticated client hammers the auth endpoint 25 times in one minute. After the 20th request, it receives 429. After 3 violations within 5 minutes, the IP is blocked for 15 minutes.`
- `Example: An operator uses the admin API to permanently ban an IP that has been persistently abusive. All future requests from that IP receive 403 Forbidden.`

## Implementation Notes

- The abstraction layer should present a single `RateLimiter` interface that both Cloudflare and Postgres backends implement. Configuration selects the backend at startup.
- Sliding window counters are preferred over fixed windows to avoid burst-at-boundary behavior.
- WebSocket rate limiting applies per message frame, not per connection establishment alone.

## Pitfalls To Avoid

- Applying rate limits to the local daemon IPC path (it is trusted by design)
- Using fixed-window counters that allow double-rate bursts at window boundaries
- Failing to include `Retry-After` on 429 responses (clients cannot back off intelligently)
- Allowing automated escalation to reach permanent bans without human review

## Acceptance Criteria

- [ ] General API requests exceeding 100 req/user/min receive HTTP 429 with correct rate limit headers.
- [ ] Auth endpoint requests exceeding 20 req/IP/min receive HTTP 429 with `Retry-After`.
- [ ] Invite redemption attempts exceeding 5/IP/min receive HTTP 429.
- [ ] 3 violations within 5 minutes trigger a 15-minute block.
- [ ] 10 violations within 1 hour trigger a 1-hour block and emit an ops alert.
- [ ] Permanent bans are manageable only via the admin API.
- [ ] Hosted deployment uses Cloudflare `rate_limit`; self-hosted uses `rate-limiter-flexible` with Postgres; both enforce identical limits.
- [ ] Local daemon endpoints are not rate-limited.

## ADR Triggers

- If the deployment topology changes such that the local daemon becomes network-reachable (not socket-only), rate limiting scope must be revisited and an ADR created.
- If a third deployment target is introduced beyond Cloudflare Workers and self-hosted Postgres, the abstraction layer design must be revisited.

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.

## References

- [Deployment Topology](../architecture/deployment-topology.md)
- [Security Architecture](../architecture/security-architecture.md)
