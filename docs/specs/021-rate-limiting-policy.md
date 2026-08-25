# Spec-021: Rate Limiting Policy

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `021` |
| **Slug** | `rate-limiting-policy` |
| **Date** | `2026-04-15` (amended 2026-06-10, Tier-6 readiness audit; amended 2026-07-02, capability-enhancement campaign B8 — `presence.heartbeat` V1-enforcement status; amended 2026-07-08 — four artifact-relay rows per the [ADR-015 cross-node amendment](../decisions/015-v1-feature-scope-definition.md#amendment-2026-07-08-v11-deferred-features-3--2-cross-node-shared-artifacts-pulled-into-v1); amended 2026-07-09 — two further relay rows, `artifact.fetch.complete` (Spec-014's ack-driven delivery) and `artifact.upload.complete` (upload finalization); byte/storage quotas stay Spec-014-owned; amended 2026-08-11 — the `invite.preview` registry row ([BL-133](../backlog.md), campaign §4.B decision 5) plus the stacked `invite.redeem_ip` preview-path extension, flip-and-restored `approved` in the same swap by the [Plan-002/Spec-002 restoring targeted readiness-audit delta](../plans/002-invite-membership-and-presence.md#preconditions) (PR #322, §6 node NS-57 — the Spec-006 PR #278/#321 self-audit shape); registry grows 24 → 25 rows, wiring stays Tier 6 with the other invite rows per Plan-002 CP-002-3 — recorded, not wired); amended 2026-08-25 — the rate-limit wiring amendment (§6 node NS-80): `event.subscribe` re-priced 5 → 10 concurrent, `artifact.publish` marked dormant/reserved, the concurrency-cap slot-accounting and status-fidelity rules stated in §Overflow Response, and a new §ADR Triggers re-arm bullet (§ADR Triggers 4 → 5 bullets, the new one placed beside the `approval.resolve` trigger it mirrors rather than appended) — registry stays 25 rows, flip-and-restored `approved` in the same swap) |
| **Author(s)** | `Codex` |
| **Depends On** | [Deployment Topology](../architecture/deployment-topology.md), [Security Architecture](../architecture/security-architecture.md) |
| **Implementation Plan** | [Plan-021: Rate Limiting Policy](../plans/021-rate-limiting-policy.md) |

> **Amendment (2026-08-25, rate-limit wiring — the three unowned enforcement legs given owners; user-ratified, §6 node NS-80).** Flips the previously-`approved` spec to `review` per the audit runbook's spec-amendment rule, since it changes a registry limit, moves a row into the dormant class, and adds normative §Overflow Response, §Fallback Behavior, §ADR Triggers, and §Acceptance Criteria text, and **restores `approved` in the same diff** through the targeted readiness-audit delta riding it — the same-PR flip-and-restore shape [Plan-021](../plans/021-rate-limiting-policy.md), [Plan-008](../plans/008-control-plane-relay-and-session-join.md), [Plan-014](../plans/014-artifacts-files-and-attachments.md), and [Plan-002](../plans/002-invite-membership-and-presence.md) take in this swap. **The growth, in four parts.** **(1) `event.subscribe` is re-priced 5 → 10 concurrent** (user-ratified 2026-08-25): over **HTTP/1.1** a browser permits only six concurrent connections per browser+domain — the limit applies across tabs, not per tab ([MDN, _Using server-sent events_ §Browser compatibility / connection limit](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events), read 2026-08-25) — and one person's desktop shell, CLI, and open tabs all draw on the same per-participant budget, so a cap of five refused legitimate simultaneous use before it refused abuse. The transport scoping is deliberate and does not weaken the case: under **HTTP/2** the ceiling is the negotiated `SETTINGS_MAX_CONCURRENT_STREAMS` (commonly 100), so the browser stops being the binding constraint and this cap becomes the one that binds — which is the argument for pricing it at a number a legitimate user does not reach, not against it. The scope, tier, and enforcement class are unchanged; only the number moves. **(2) `artifact.publish` joins the dormant/reserved class** on the `approval.resolve` template. The narrow, checkable claim: **no control-plane method string or tRPC procedure for artifact publication is registered anywhere in the corpus** — [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) shapes `ArtifactPublishRequest` / `ArtifactPublishResponse` as an interface family whose ingest sibling it binds explicitly to the **local IPC transport** (the 1 MB per-frame ceiling is an IPC-frame bound), [Spec-014 §Interfaces And Contracts](./014-artifacts-files-and-attachments.md#interfaces-and-contracts) places publication at the client↔daemon boundary, [Plan-014](../plans/014-artifacts-files-and-attachments.md) T14.5 registers the `artifact.*` handlers under Plan-007's **daemon** JSON-RPC registry, and §Scope / §Non-Goals / §Acceptance Criteria all exclude the local daemon path. The network-side counterpart is not missing — it is the six `artifact.upload.*` / `artifact.fetch.*` rows, which is exactly what the `artifact.upload.init` row's own note already says ("matches `artifact.publish` cadence; one resumable upload per pinned publish"). Pricing stays as recorded; a new §ADR Triggers bullet — the artifact-publication one, placed beside the `approval.resolve` trigger it mirrors rather than appended, taking that section from four bullets to five — is the re-arm gate, and **no backlog item is minted**, mirroring the `presence.heartbeat` / `approval.resolve` / `keypackage.upload` posture. **(3) Concurrency caps gain their missing half.** The pre-amendment text said where caps are enforced and what they omit from the envelope, but never said how a slot is released or what the refusal may be rewritten into — the two properties that decide whether a cap is safe. §Overflow Response now states both: a bounded lease with an independent expiry backstop beside the release-on-termination path, and the requirement that a cap refusal reach the client as **exactly** `429`. §Fallback Behavior records the third property the pair implies — what a cap does when its own lease store is down — as **no deviation at all**: the general fail-open-then-fail-closed-`503` rule applies unchanged, and the outage-versus-cap-trip distinction is carried by telemetry (`rate_limit_backend_error_total` rather than `rate_limit_trip_total`) instead of by the status. One acceptance criterion, **appended last** so the existing bullets keep their positional identity, covers all three. **(4) Each of the three previously-unowned legs is assigned to a named task** in its owning plan — the SSE cap to [Plan-008](../plans/008-control-plane-relay-and-session-join.md) Phase R5, the six relay rows to [Plan-014](../plans/014-artifacts-files-and-attachments.md) T14.14 / T14.15, and the invite pending cap to [Plan-002](../plans/002-invite-membership-and-presence.md) T4.3 — which is what lets [BL-120](../archive/backlog-archive.md#bl-120-plan-002-phase-4-invite-endpoint-rate-limit-wiring-tier-6-deferral), [BL-144](../archive/backlog-archive.md#bl-144-eventsubscribe-sse-concurrency-cap-enforcement-5-concurrentparticipant), and [BL-146](../archive/backlog-archive.md#bl-146-artifactpublish-rate-limit-wiring-plan-014-tier-7) close. **Mints nothing**: no registry row, error code, wire member, table, or column; the registry stays 25 rows and no census moves.

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
| `event.subscribe` | Event subscribe (SSE) | 10 concurrent | — | per participant | authenticated | — | concurrency_cap |
| `approval.resolve` | Approval resolve | 30/min | 60s | per participant | authenticated | ✓ | sliding_window — dormant in V1 (see registry semantics below) |
| `artifact.publish` | Artifact publish | 20/min | 60s | per session | authenticated | — | sliding_window — dormant in V1 (see registry semantics below) |
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
- **Concurrency caps are not counters.** Rows with `enforcement class: concurrency_cap` are enforced at the owning resource surface (the invite store enforces `invite.pending_cap` at creation time; the SSE subscription registry enforces `event.subscribe` at subscribe time), not by the sliding-window limiter. They share the standard overflow envelope and `429` status, with the timing fields and timing headers omitted per §Overflow Response (cap capacity frees when an existing holder releases, not at a known reset time). A cap row's canonical key still names it in `RateLimitCheck.endpoint` and in metric labels even though no counter backs it, so a cap owner and a window owner report trips through the same telemetry family. **A cap row's key is not required to equal the procedure name of the surface that enforces it** — `event.subscribe` is enforced by the shipped `session.subscribe` SSE surface — so the surface owner states the key-to-surface binding as an invariant rather than leaving it to prose.
- **Dormant rows.** `approval.resolve` is priced and reserved but wired by nobody in V1: Plan-012's ratified transport is daemon JSON-RPC only (Plan-012 D-012-5; no control-plane tRPC sibling exists), and the local daemon IPC path is excluded from rate limiting (see §Scope and §Non-Goals). Plan-027's V1 cross-node approval is target-node-owner-scoped — resolution happens on the owner's daemon over local IPC — so no network-reachable `approval.resolve` surface exists in V1. The row re-arms under either §ADR Triggers condition that makes such a surface exist — the topology trigger (the local daemon becoming network-reachable) or the delegated/remote `approval.resolve` surface trigger — wired then by the surface-owning plan at this registry's price; those triggers are the gate, mirroring the `presence.heartbeat` and `keypackage.upload` posture below — no backlog item. `presence.heartbeat` is likewise priced and reserved but not enforced in V1 — for a distinct reason: unlike `approval.resolve` (which has no V1 surface at all), the heartbeat channel is **live** in V1 (heartbeats flow), but they ride the **WebSocket (JSON-RPC 2.0)** collaboration channel ([Spec-002](../specs/002-invite-membership-and-presence.md) §Heartbeat Transport; [Spec-008](../specs/008-control-plane-relay-and-session-join.md) §Control-Plane Transport Protocol), which ships **no per-message admission surface** in V1 — the connection is PASETO-authenticated per participant at handshake, but individual heartbeat messages are neither a tRPC procedure (nothing for the limiter to wrap) nor a relay binary frame (the per-frame seam decodes only the ciphertext-envelope `type`), so nothing meters them. The 10/min limit stays reserved; per-message metering arms with the V1.1 JSON-RPC-WS message-admission surface (that surface is the gate — mirroring `keypackage.upload`'s MLS gate — no new backlog item). The unmetered-but-authenticated channel is an accepted V1 posture, bounded by the per-participant authentication established at connect. `artifact.publish` joins the dormant class and takes `approval.resolve`'s reason exactly: **no control-plane method string or tRPC procedure for artifact publication is registered anywhere in the corpus.** Publication is a client↔daemon call ([Spec-014 §Interfaces And Contracts](./014-artifacts-files-and-attachments.md#interfaces-and-contracts); the [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) `ArtifactPublish` family's ingest sibling binds to the local IPC transport, whose 1 MB per-frame ceiling is an IPC-frame bound; [Plan-014](../plans/014-artifacts-files-and-attachments.md) T14.5 registers `artifact.*` under the daemon JSON-RPC registry), and the local daemon path is excluded from rate limiting by §Scope, §Non-Goals, and this spec's own acceptance criterion. The network-reachable counterpart already has its own six rows — `artifact.upload.*` and `artifact.fetch.*`, wired by Plan-014 T14.14 / T14.15 — which is what the `artifact.upload.init` row's note means when it prices itself against `artifact.publish` cadence: the relay row is the network-side sibling of a local publish, not a duplicate of it. The 20/min price stays reserved and arms only if a network-reachable publication surface is introduced (the §ADR Triggers bullet below is the gate) — **no backlog item**, the same posture as `presence.heartbeat`, `approval.resolve`, and `keypackage.upload`.
- **Per-frame WS limiting.** `ws.message` is evaluated per message frame (see §WebSocket Overflow Response), not per connection establishment alone.

### Overflow Response

- When a sliding-window rate limit is exceeded, the system must respond with HTTP `429 Too Many Requests`.
- The response must include a `Retry-After` header indicating the number of seconds the client should wait.
- The response must include standard rate limit headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`.
- Concurrency-cap refusals (registry rows with `enforcement class: concurrency_cap`) return `429` with the same envelope but omit `Retry-After`, `X-RateLimit-Reset`, and the envelope timing fields (`retryAfter`, `resetAt`): cap capacity is freed by an existing holder releasing (a pending invite resolving, a subscription closing), not at a known reset timestamp — fabricating window data is prohibited. `X-RateLimit-Limit` (the cap itself) and `X-RateLimit-Remaining: 0` remain truthful and are sent. This representation is standards-aligned rather than a local shortcut: `concurrent-requests` is a registered quota unit in [draft-ietf-httpapi-ratelimit-headers-11 §3.1.2](https://www.ietf.org/archive/id/draft-ietf-httpapi-ratelimit-headers-11.txt), whose window and reset parameters are OPTIONAL.
- **Slot accounting (concurrency_cap).** A cap holder occupies its slot for the whole life of the resource it holds, so every cap owner MUST implement **both** halves of release: the normal termination path (the subscription closes, the pending invite resolves or expires) **and** an independent expiry backstop — a bounded lease the holder renews from a signal it already emits, so a slot cannot outlive a holder whose termination signal never arrives. One half alone is not sufficient in either direction: release-only leaks a slot permanently whenever the runtime declines to signal termination (a live example is the still-open [workerd #6832](https://github.com/cloudflare/workerd/issues/6832), where a stream's `cancel()` callback stopped firing on client disconnect from `1.20260619.1` onward), and a leaked slot fails **closed against a legitimate participant** — a cap's worst failure mode, since it locks the honest caller out while costing an abuser nothing. Lease-only, conversely, holds a freed slot for the lease remainder. The lease duration is expressed as a multiple of the holder's own renewal signal rather than as an independent constant, so the two cannot drift apart.
- **Status fidelity on streaming surfaces.** A cap refusal MUST reach the client as **exactly** `429`, and nothing in front of the enforcing surface (an edge error page, a proxy rewriting an unhandled throw) may convert it into a `5xx`. The reason is not client retry — a conforming [WHATWG EventSource](https://html.spec.whatwg.org/multipage/server-sent-events.html#sse-processing-model) _fails the connection_ on **every** non-`200` and does not reconnect, so `429` and `503` are alike in that respect. It is that the status is the only refusal signal a streaming client can act on: `429` names a caller-side limit the caller can resolve by closing a subscription, while a `5xx` names a server fault and licenses the client's own retry/alerting policy to treat the refusal as an outage. A cap refusal disguised as a `5xx` therefore misroutes both the client's behavior and the operator's paging. The enforcing surface's tests assert the status code itself, not merely the envelope body.

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

- All rate limits are active by default for every control plane endpoint and WebSocket connection — **except rows explicitly marked dormant/reserved in the §Registry** (`presence.heartbeat`, `approval.resolve`, `artifact.publish`), whose limit is reserved and arms only when its named V1.1 admission surface ships (see the §Registry dormant-row semantics); a dormant row is not enforced by an ad hoc V1 limiter.
- Clients that stay within limits receive no rate-limiting headers until they approach the threshold. "Approach the threshold" is defined as: `remaining < 25%` of the row's limit (Tier-6 audit). Headers are always present on 429 responses (concurrency-cap refusals send the truthful subset — limit and remaining — per §Overflow Response), and are suppressed entirely while the backend is in fail-open grace (the degraded response arm carries no window fields to serialize).

## Fallback Behavior

- If the rate limiting backend (Postgres on self-host; the Cloudflare `rate_limit` binding / escalation Durable Object on hosted) is unavailable, the system must fail open for a bounded grace period (configurable, default 60 seconds) and must log the failure as a warning.
- If the grace period expires without backend recovery, the system must fail closed and reject requests with HTTP `503 Service Unavailable`.
- **Concurrency-cap surfaces take the general rule unchanged, including its `503`** (recorded 2026-08-25). An earlier draft of this amendment carved out a status deviation for cap surfaces on the premise that a conforming `EventSource` reconnects on `503`; that premise is **false** — the [processing model](https://html.spec.whatwg.org/multipage/server-sent-events.html#sse-processing-model) fails the connection on every non-`200` and does not reconnect — so the carve-out is withdrawn rather than kept on a different argument. A `concurrency_cap` row whose lease store is unavailable fails open for the bounded grace period and then fails closed with `503` `ratelimit.backend_unavailable`, exactly as every other row does: the caller is being refused because the backend is down, `503` is the truthful statement of that, and answering `429` would tell a caller to close a subscription it does not have. Grace-period admissions are marked `degraded`, suppress rate-limit headers, and count on `rate_limit_backend_error_total{backend}` rather than on `rate_limit_trip_total{endpoint,tier}` — the outage-versus-cap-trip distinction the §Overflow Response slot-accounting bullet relies on is telemetric, not statutory.

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
- [ ] A `concurrency_cap` row refuses at the cap with **exactly** `429` (never a 5xx), releases the slot on both the normal-termination and the client-disconnect path with an expiry backstop covering neither firing, and — when its own lease store is unavailable — takes §Fallback Behavior unchanged: admit for the grace period marked `degraded` and counted as a backend fault, then fail closed with `503` `ratelimit.backend_unavailable` (§Overflow Response, §Fallback Behavior; appended 2026-08-25 — this criterion is last so the preceding bullets keep their positional identity).

## ADR Triggers

- If the deployment topology changes such that the local daemon becomes network-reachable (not socket-only), rate limiting scope must be revisited and an ADR created.
- If a delegated or remote `approval.resolve` surface is introduced — resolution leaving the target-node owner's daemon-local IPC path (the Plan-027 V1 cross-node model) for a control-plane- or relay-carried surface, even while the local daemon stays socket-only — the dormant `approval.resolve` registry row must be wired by the surface-owning plan at its registered price and the rate-limiting scope revisited via ADR (surface-forwarded 2026-08-25 from the withdrawn BL-145, whose gate text carried this trigger).
- If a network-reachable artifact-publication surface is introduced — a control-plane procedure or relay route accepting a publish directly, rather than the V1 shape where a participant publishes to their own daemon over local IPC and the daemon replicates through the `artifact.upload.*` relay rows — the dormant `artifact.publish` registry row must be wired by the surface-owning plan at its registered price and the rate-limiting scope revisited via ADR (2026-08-25, §6 node NS-80; the `approval.resolve` bullet's shape).
- If a third deployment target is introduced beyond Cloudflare Workers and self-hosted Postgres, the abstraction layer design must be revisited.
- If a service-principal identity surface is minted (reinstating the former "system service" elevated tier), the tier model must be revisited via ADR (Tier-6 audit, D-021-4).

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- Tier-6 readiness audit (2026-06-10) resolved: endpoint-group registry unification with canonical keys (D-021-6), stacked invite-redemption limits (D-021-6), elevated-tier redefinition to session-owner with the two-condition eligibility rule (D-021-4), ops-alert realization as alertable telemetry (D-021-7), WebSocket drop-frame overflow semantics (D-021-9), admin-ban expiry + list route (D-021-12), GDPR erasure dispositions (D-021-13), fail-open substrate wording, threshold-approach header definition, and the five-field check shape. Ratified decision bodies live in [Plan-021 §Ratified Design Decisions](../plans/021-rate-limiting-policy.md#ratified-design-decisions-tier-6-audit).

## References

- [Deployment Topology](../architecture/deployment-topology.md)
- [Security Architecture](../architecture/security-architecture.md)
- [draft-ietf-httpapi-ratelimit-headers-11](https://www.ietf.org/archive/id/draft-ietf-httpapi-ratelimit-headers-11.txt) — §3.1.2 registers `concurrent-requests` as a quota unit; the window/reset parameters are OPTIONAL (Internet-Draft, HTTPAPI WG, published 2026-05-23)
- [WHATWG HTML — Server-sent events processing model](https://html.spec.whatwg.org/multipage/server-sent-events.html#sse-processing-model) — **any** non-`200` status (or a `Content-Type` that is not `text/event-stream`) _fails the connection_, and "once the user agent has failed the connection, it does not attempt to reconnect"; only a network error after a successful `200` reestablishes. Corrected 2026-08-25 against the primary source (Codex round 2): an earlier reading of this row claimed 5xx-specific reconnection, which the spec does not say
- [OWASP API Security Top 10 (2023) — API4:2023 Unrestricted Resource Consumption](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/) — the governing class for per-caller caps on long-lived connections
- [MDN — Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) — the per-browser+domain open-connection ceiling of **six** applies when SSE is **not** carried over HTTP/2, and is shared across a browser's tabs; over HTTP/2 the ceiling is the negotiated maximum concurrent streams (default 100). The source of the `event.subscribe` re-price's transport-scoped premise (read 2026-08-25).
- [Cloudflare Workers — rate-limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) — `simple.period` accepts only 10 s or 60 s; the counter is per-Cloudflare-location rather than global; the binding is documented as "intentionally designed to not be used as an accurate accounting system", and exposes no concurrency or in-flight primitive. The source for why a `concurrency_cap` row cannot be served by the platform binding (read 2026-08-25).
- [`rate-limiter-flexible`](https://github.com/animir/node-rate-limiter-flexible) (this spec's own self-host backend; latest `11.2.0`) — its `RateLimiterQueue` wiki page states plainly that it **"doesn't limit concurrency"** and instead queues token consumption FIFO within a window. The source for why the cap is hand-rolled rather than delegated to the limiter already in the dependency set (read 2026-08-25).
- [cloudflare/workerd#6832](https://github.com/cloudflare/workerd/issues/6832) — open: a response stream's `cancel()` callback stopped firing on client disconnect from `1.20260619.1`, the concrete case the slot-accounting rule's expiry backstop exists for
