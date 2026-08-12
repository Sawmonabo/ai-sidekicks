# Spec-021: Rate Limiting Policy

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `021` |
| **Slug** | `rate-limiting-policy` |
| **Date** | `2026-04-15` (amended 2026-06-10, Tier-6 readiness audit; amended 2026-07-02, capability-enhancement campaign B8 — `presence.heartbeat` V1-enforcement status; amended 2026-07-08 — four artifact-relay rows per the [ADR-015 cross-node amendment](../decisions/015-v1-feature-scope-definition.md#amendment-2026-07-08-v11-deferred-features-3--2-cross-node-shared-artifacts-pulled-into-v1); amended 2026-07-09 — two further relay rows, `artifact.fetch.complete` (Spec-014's ack-driven delivery) and `artifact.upload.complete` (upload finalization); byte/storage quotas stay Spec-014-owned; amended 2026-08-11 — the `invite.preview` registry row ([BL-133](../backlog.md), campaign §4.B decision 5) plus the stacked `invite.redeem_ip` preview-path extension, flip-and-restored `approved` in the same swap by the [Plan-002/Spec-002 restoring targeted readiness-audit delta](../plans/002-invite-membership-and-presence.md#preconditions) (PR #322, §6 node NS-57 — the Spec-006 PR #278/#321 self-audit shape); registry grows 24 → 25 rows, wiring stays Tier 6 with the other invite rows per Plan-002 CP-002-3 — recorded, not wired) |
| **Author(s)** | `Codex` |
| **Depends On** | [Deployment Topology](../architecture/deployment-topology.md), [Security Architecture](../architecture/security-architecture.md) |
| **Implementation Plan** | [Plan-021: Rate Limiting Policy](../plans/021-rate-limiting-policy.md) |

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

### Canonical Endpoint Group Registry

This registry is the **single enumeration** of every enforced limit (Tier-6 audit, D-021-6). The former §Edge Limits, §Application Limits, and §Rate Limit Values tables enumerated overlapping-but-divergent sets; they are collapsed into this one table, and no other table in this spec enumerates limits. Implementations iterate this registry; the `Key` column is the canonical machine key used by `RateLimitCheck.endpoint`, middleware wiring, and metric labels.

| Key | Display name | Limit | Window | Identity scope | Tier | Elevated-eligible | Enforcement class |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `general.api` | General API (fallback bucket) | 100/min | 60s | per participant | authenticated | — | sliding_window |
| `auth.endpoint` | Auth endpoints | 20/min | 60s | per IP | anonymous | — | sliding_window |
| `unauthenticated.request` | Unauthenticated (fallback bucket) | 30/min | 60s | per IP | anonymous | — | sliding_window |
| `session.create` | Session create | 10/min | 60s | per participant | authenticated | — | sliding_window |
| `session.join` | Session join | 30/min | 60s | per participant | authenticated | ✓ | sliding_window |
| `invite.create_session` | Invite create (session budget) | 20/hr | 1h | per session | authenticated | — | sliding_window |
| `invite.create_participant` | Invite create (participant budget) | 50/hr | 1h | per participant | authenticated | ✓ | sliding_window |
| `invite.pending_cap` | Pending invites | 100 concurrent | — | per session | authenticated | — | concurrency_cap |
| `invite.accept` | Invite accept (token brute-force guard) | 10/min | 60s | per token-hash | anonymous | — | sliding_window |
| `invite.preview` | Invite preview (non-consuming metadata read) | 10/min | 60s | per token-hash | anonymous | — | sliding_window |
| `invite.redeem_ip` | Invite redemption attempts (source guard) | 5/min | 60s | per IP | anonymous | — | sliding_window |
| `presence.heartbeat` | Presence heartbeat | 10/min | 60s | per participant | authenticated | — | sliding_window — dormant in V1 (see registry semantics below) |
| `event.query` | Event query (read) | 60/min | 60s | per participant | authenticated | ✓ | sliding_window |
| `event.subscribe` | Event subscribe (SSE) | 5 concurrent | — | per participant | authenticated | — | concurrency_cap |
| `approval.resolve` | Approval resolve | 30/min | 60s | per participant | authenticated | ✓ | sliding_window — dormant in V1 (see registry semantics below) |
| `artifact.publish` | Artifact publish | 20/min | 60s | per session | authenticated | — | sliding_window |
| `artifact.upload.init` | Artifact relay upload init | 20/min | 60s | per session | authenticated | — | sliding_window — matches `artifact.publish` cadence; one resumable upload per pinned publish ([Spec-014 §Cross-Node Artifact Relay (V1)](./014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1)) |
| `artifact.upload.chunk` | Artifact relay chunk upload | 300/min | 60s | per session | authenticated | — | sliding_window — 8 MiB chunks ⇒ ≈2.4 GiB/min request ceiling; bytes are additionally governed by the Spec-014 storage quotas |
| `artifact.upload.complete` | Artifact relay upload finalize | 20/min | 60s | per session | authenticated | — | sliding_window — one finalization per chunked upload, so bounded 1:1 by `artifact.upload.init`'s ceiling (which it mirrors); the transition that lets `replicationStatus` reach `pinned` ([Spec-014 §Cross-Node Artifact Relay (V1)](./014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1) Publish step 4). An idempotent re-pin of an already-pinned digest short-circuits at `artifact.upload.init` and never reaches this endpoint |
| `artifact.fetch.authorize` | Artifact fetch-token mint | 60/min | 60s | per participant | authenticated | ✓ | sliding_window — short-lived DPoP-bound tokens are re-minted on resume |
| `artifact.fetch.chunk` | Artifact relay chunk fetch | 600/min | 60s | per participant | authenticated | ✓ | sliding_window — resumable multi-chunk fetch; bytes governed by Spec-014 quotas |
| `artifact.fetch.complete` | Artifact fetch-complete ack | 60/min | 60s | per participant | authenticated | ✓ | sliding_window — one post-verification acknowledgement per completed fetch (mirrors the `artifact.fetch.authorize` cadence); the ack is what sets `delivered_at` and drives refcount GC ([Spec-014 §Cross-Node Artifact Relay (V1)](./014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1) Fetch step 6) |
| `health.check` | Health check | 120/min | 60s | per IP | anonymous | — | sliding_window |
| `ws.message` | WebSocket messages | 60/min | 60s | per participant | authenticated | ✓ | sliding_window |
| `keypackage.upload` | KeyPackage uploads (V1.1+) | 5/hr | 1h | per user | authenticated | — | sliding_window — applies once MLS ships per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md); no KeyPackage endpoint exists in V1 |

Registry semantics (Tier-6 audit, D-021-6):

- **Fallback buckets.** `general.api` applies to every authenticated control-plane procedure that has no more-specific registry row; `unauthenticated.request` applies to every unauthenticated procedure with no more-specific row. A request is counted against exactly one sliding-window row: the most specific matching row, else its tier's fallback bucket.
- **Stacked invite-redemption limits.** `invite.accept` (per token-hash — throttles brute force against one token) and `invite.redeem_ip` (per IP — throttles one source spraying many tokens) are deliberately **both** enforced on the redemption path; they defend distinct axes. The redemption acceptance criterion (AC-3) anchors on `invite.redeem_ip`. **The preview path stacks the same way (2026-08-11):** `invite.preview` (per token-hash) and `invite.redeem_ip` (per IP) are both enforced on a preview attempt — preview validates the same token space and returns the same two-tier refusals as accept ([Spec-002 §Interfaces And Contracts](002-invite-membership-and-presence.md#interfaces-and-contracts)), so a single source spraying candidate tokens through the non-consuming read would otherwise probe with only per-token budgets; stacking the IP row keeps preview **at least as strict as accept** on both axes, which is the row's design rule. This is the one deliberate exception to the most-specific-row rule above, mirroring the accept-path stack.
- **Concurrency caps are not counters.** Rows with `enforcement class: concurrency_cap` are enforced at the owning resource surface (the invite store enforces `invite.pending_cap` at creation time; the SSE subscription registry enforces `event.subscribe` at subscribe time), not by the sliding-window limiter. They share the standard overflow envelope and `429` status, with the timing fields and timing headers omitted per §Overflow Response (cap capacity frees when an existing holder releases, not at a known reset time).
- **Dormant rows.** `approval.resolve` is priced and reserved but wired by nobody in V1: Plan-012's ratified transport is daemon JSON-RPC only (Plan-012 D-012-5; no control-plane tRPC sibling exists), and the local daemon IPC path is excluded from rate limiting (see §Scope and §Non-Goals). Plan-027's V1 cross-node approval is target-node-owner-scoped — resolution happens on the owner's daemon over local IPC — so no network-reachable `approval.resolve` surface exists in V1. The row re-arms via BL-145 if the §ADR Triggers topology condition fires (the daemon becoming network-reachable). `presence.heartbeat` is likewise priced and reserved but not enforced in V1 — for a distinct reason: unlike `approval.resolve` (which has no V1 surface at all), the heartbeat channel is **live** in V1 (heartbeats flow), but they ride the **WebSocket (JSON-RPC 2.0)** collaboration channel ([Spec-002](../specs/002-invite-membership-and-presence.md) §Heartbeat Transport; [Spec-008](../specs/008-control-plane-relay-and-session-join.md) §Control-Plane Transport Protocol), which ships **no per-message admission surface** in V1 — the connection is PASETO-authenticated per participant at handshake, but individual heartbeat messages are neither a tRPC procedure (nothing for the limiter to wrap) nor a relay binary frame (the per-frame seam decodes only the ciphertext-envelope `type`), so nothing meters them. The 10/min limit stays reserved; per-message metering arms with the V1.1 JSON-RPC-WS message-admission surface (that surface is the gate — mirroring `keypackage.upload`'s MLS gate — no new backlog item). The unmetered-but-authenticated channel is an accepted V1 posture, bounded by the per-participant authentication established at connect.
- **Per-frame WS limiting.** `ws.message` is evaluated per message frame (see §WebSocket Overflow Response), not per connection establishment alone.

### Overflow Response

- When a sliding-window rate limit is exceeded, the system must respond with HTTP `429 Too Many Requests`.
- The response must include a `Retry-After` header indicating the number of seconds the client should wait.
- The response must include standard rate limit headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`.
- Concurrency-cap refusals (registry rows with `enforcement class: concurrency_cap`) return `429` with the same envelope but omit `Retry-After`, `X-RateLimit-Reset`, and the envelope timing fields (`retryAfter`, `resetAt`): cap capacity is freed by an existing holder releasing (a pending invite resolving, a subscription closing), not at a known reset timestamp — fabricating window data is prohibited. `X-RateLimit-Limit` (the cap itself) and `X-RateLimit-Remaining: 0` remain truthful and are sent.

### WebSocket Overflow Response

(Tier-6 audit, D-021-9.) A `ws.message` counter trip refuses the offending frame only: the relay sends one in-band `rate_limited` error frame (the WebSocket analog of the 429 envelope, carrying `retryAfter`, `limit`, `remaining: 0`, `resetAt`) and the connection stays open. The connection is closed with application close code `4029` **only** when an active escalation block exists for the identity — merely-over-budget participants keep their connection; blocked identities lose it. An active **admin ban** also tears down the connection, but with the distinct application close code `4003` — a ban is a 403-class admission refusal (`ratelimit.banned`), not rate-limit overflow, so it never reuses `4029`; the close reason carries the ban expiry when one exists and omits it for permanent bans. Closing on first trip is prohibited (it converts a one-frame overflow into a reconnect storm). The frame shape and both close codes (`4029`, `4003`) are registered in [API Payload Contracts](../architecture/contracts/api-payload-contracts.md).

### Escalation

- 3 violations within 5 minutes must trigger a 15-minute block for the offending identity.
- 10 violations within 1 hour must trigger a 1-hour block for the offending identity and must emit an ops alert.
- Blocks key on the same `(identity, identityType)` that accumulated the violations, and must be enforced for the full block window independent of remaining counter capacity.
- "Emit an ops alert" means: emit an alertable telemetry signal — a Prometheus counter increment (`rate_limit_block_total{window_size="1h"}`) plus one structured warning log with bounded, PII-free fields. Operator alert routing off scraped counters is the deployment's concern, not a V1 in-product surface (Tier-6 audit, D-021-7).
- Permanent bans must be manageable exclusively via the admin API. Automated escalation must not permanently ban without human action.
- Admin bans MAY carry an expiry (`expiresAt`); a NULL expiry is permanent. Time-limited admin bans are admin-issued and distinct from automated escalation blocks (separate store, separate issuance authority) (Tier-6 audit, D-021-12).

### Rate Limit Tiers

| Tier | Description | Multiplier |
| --- | --- | --- |
| anonymous | Unauthenticated requests (invite accept, health check) | 1x (base) |
| authenticated | Standard authenticated participant | 1x |
| elevated | Session owner, resolved from the caller's membership role for the request's target session | 3x |

The elevated tier allows burst operations during session setup. Elevated eligibility requires both (Tier-6 audit, D-021-4): (a) a caller-keyed (per-participant) bucket — per-session, per-IP, and per-token-hash buckets are tier-invariant because their key is not a caller — and (b) a target session resolvable from the request, so the caller's owner role can be read. The registry's `Elevated-eligible` column marks the V1 set. The former "system service" elevated principal is removed from V1: no service-principal identity surface exists; reinstating it requires a minted service-identity surface and an ADR (see §ADR Triggers).

Counter limits — registry rows with enforcement class `sliding_window` — use the sliding window algorithm; `concurrency_cap` rows are live concurrent counts enforced at their owning resource surface (see the registry semantics above), not time windows. Refusals from both classes include the standard `RateLimitResponse` from [Error Contracts](../architecture/contracts/error-contracts.md); concurrency-cap refusals omit its timing fields per §Overflow Response.

## Default Behavior

- All rate limits are active by default for every control plane endpoint and WebSocket connection — **except rows explicitly marked dormant/reserved in the §Registry** (`presence.heartbeat`, `approval.resolve`), whose limit is reserved and arms only when its named V1.1 admission surface ships (see the §Registry dormant-row semantics); a dormant row is not enforced by an ad hoc V1 limiter.
- Clients that stay within limits receive no rate-limiting headers until they approach the threshold. "Approach the threshold" is defined as: `remaining < 25%` of the row's limit (Tier-6 audit). Headers are always present on 429 responses (concurrency-cap refusals send the truthful subset — limit and remaining — per §Overflow Response), and are suppressed entirely while the backend is in fail-open grace (the degraded response arm carries no window fields to serialize).

## Fallback Behavior

- If the rate limiting backend (Postgres on self-host; the Cloudflare `rate_limit` binding / escalation Durable Object on hosted) is unavailable, the system must fail open for a bounded grace period (configurable, default 60 seconds) and must log the failure as a warning.
- If the grace period expires without backend recovery, the system must fail closed and reject requests with HTTP `503 Service Unavailable`.

## Interfaces And Contracts

- `RateLimitCheck(identity, identityType, endpoint, tier?, context?) -> { allowed: boolean, remaining: number, resetAt: timestamp, limit: number, blockUntil?: timestamp } | { allowed: true, degraded: true, graceEndsAt: timestamp }` must be callable before request processing (Tier-6 audit — five-field request; two-arm response: the window arm carries the four window fields plus the `blockUntil` marker, set only while an active §Escalation block denies the identity — it carries the block expiry and discriminates counter trips from active blocks; the fail-open degraded arm, returned only during grace, carries no window fields — `graceEndsAt` is the grace-expiry instant, never a window reset).
- All HTTP responses from rate-limited endpoints must include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers, subject to the §Default Behavior threshold-approach and degraded-suppression rules; concurrency-cap responses omit `X-RateLimit-Reset` (and `Retry-After`) per the §Overflow Response no-reset-clock rule and send only the truthful `X-RateLimit-Limit` + `X-RateLimit-Remaining` pair.
- The admin API must expose `POST /admin/bans`, `GET /admin/bans`, and `DELETE /admin/bans/{id}` for ban management (Tier-6 audit, D-021-12 adds the list route).
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Rate limit counters are ephemeral and must not be persisted beyond their sliding window.
- Escalation state (violation counts, active blocks) must be persisted in the rate limiting backend for the duration of the escalation window.
- Permanent bans must be stored durably and must survive backend restarts. Time-limited admin bans share the same durable store; expiry is row state, not a separate mechanism.
- GDPR erasure dispositions (Tier-6 audit, D-021-13): `admin_bans` rows are retained under the abuse-prevention legitimate-interest carve-out — erasure must not un-ban an identity — with revoked/expired rows purgeable after 90 days; `rate_limit_escalations` rows for an erased participant are hard-deleted. See [Spec-022 §Shred Fan-Out](./022-data-retention-and-gdpr.md#shred-fan-out).

## Example Flows

- `Example: A participant sends 60 messages in one minute. The 61st message receives HTTP 429 with Retry-After: 12 and the participant must wait before sending again.`
- `Example: An unauthenticated client hammers the auth endpoint 25 times in one minute. After the 20th request, it receives 429. After 3 violations within 5 minutes, the IP is blocked for 15 minutes.`
- `Example: An operator uses the admin API to permanently ban an IP that has been persistently abusive. All future requests from that IP receive 403 Forbidden (enforcement propagates within the documented ≤60s ban-cache staleness bound; immediate in the issuing process).`

## Implementation Notes

- The abstraction layer should present a single `RateLimiter` interface that both Cloudflare and Postgres backends implement. Configuration selects the backend at startup.
- Sliding window counters are preferred over fixed windows to avoid burst-at-boundary behavior.
- WebSocket rate limiting applies per message frame, not per connection establishment alone; overflow semantics are pinned in §WebSocket Overflow Response.

## Pitfalls To Avoid

- Applying rate limits to the local daemon IPC path (it is trusted by design)
- Using fixed-window counters that allow double-rate bursts at window boundaries
- Failing to include `Retry-After` on sliding-window 429 responses (clients cannot back off intelligently; concurrency-cap refusals deliberately omit it — no truthful value exists)
- Allowing automated escalation to reach permanent bans without human review
- Treating concurrency-cap registry rows as sliding-window counters (they are enforced at the owning resource surface)

## Acceptance Criteria

- [ ] General API requests exceeding 100 req/user/min on the `general.api` fallback bucket receive HTTP 429 with correct rate limit headers.
- [ ] Auth endpoint requests exceeding 20 req/IP/min on `auth.endpoint` receive HTTP 429 with `Retry-After`.
- [ ] Invite redemption attempts exceeding 5/IP/min on `invite.redeem_ip` receive HTTP 429.
- [ ] 3 violations within 5 minutes trigger a 15-minute block.
- [ ] 10 violations within 1 hour trigger a 1-hour block and emit an ops alert (counter increment + structured warning log per §Escalation).
- [ ] Permanent bans are manageable only via the admin API.
- [ ] Hosted deployment uses Cloudflare `rate_limit`; self-hosted uses `rate-limiter-flexible` with Postgres; both enforce identical limits.
- [ ] Local daemon endpoints are not rate-limited.
- [ ] An elevated-eligible endpoint group admits 3× the base limit for a session owner (membership-role-resolved) and 1× for non-owners (Tier-6 audit, D-021-4).

## ADR Triggers

- If the deployment topology changes such that the local daemon becomes network-reachable (not socket-only), rate limiting scope must be revisited and an ADR created.
- If a third deployment target is introduced beyond Cloudflare Workers and self-hosted Postgres, the abstraction layer design must be revisited.
- If a service-principal identity surface is minted (reinstating the former "system service" elevated tier), the tier model must be revisited via ADR (Tier-6 audit, D-021-4).

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- Tier-6 readiness audit (2026-06-10) resolved: endpoint-group registry unification with canonical keys (D-021-6), stacked invite-redemption limits (D-021-6), elevated-tier redefinition to session-owner with the two-condition eligibility rule (D-021-4), ops-alert realization as alertable telemetry (D-021-7), WebSocket drop-frame overflow semantics (D-021-9), admin-ban expiry + list route (D-021-12), GDPR erasure dispositions (D-021-13), fail-open substrate wording, threshold-approach header definition, and the five-field check shape. Ratified decision bodies live in [Plan-021 §Ratified Design Decisions](../plans/021-rate-limiting-policy.md#ratified-design-decisions-tier-6-audit).

## References

- [Deployment Topology](../architecture/deployment-topology.md)
- [Security Architecture](../architecture/security-architecture.md)
