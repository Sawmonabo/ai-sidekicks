# Shared Postgres Schema

Canonical schema for the control plane's shared Postgres database.

**Storage boundary:** Shared session metadata, device and runtime-node liveness, session directory, cross-node coordination records, and artifact-relay blob-store coordination state (blob metadata + per-`(user, node)` wrapped content keys; the ciphertext chunk bytes themselves live in the deployment's object store, never in Postgres — [Spec-014 §Cross-Node Artifact Relay (V1)](../../specs/014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1)). See [Data Architecture](../data-architecture.md).

---

## Invariant — No Shared Session-Event Table in V1 (ADR-017)

Per [ADR-017: Shared Event-Sourcing Scope](../../decisions/017-shared-event-sourcing-scope.md), this schema declares the following invariants that constrain all downstream table additions:

1. **Coordination records only.** Shared Postgres stores session metadata, device and runtime-node liveness, runtime-node attachments, session-directory entries, relay-connection records, notification preferences, queued per-user notification-delivery records (derived notification-rendering fields plus a reference to the canonical triggering event — never the event payload), health snapshots, event-log anchors (Merkle-root witnesses, not event payloads), cross-node dispatch coordination rows, session terminal-lease coordination rows (current holder only — the `pty.control_changed` event stream stays daemon-local), daemon signing-key verification-roster rows (session-scoped Ed25519 PUBLIC keys only — the private halves stay sealed in daemon-local SQLite per ADR-004, and the `runtime_node.*` lifecycle event stream stays daemon-local), device identity-key roster rows (registered per-device Ed25519 PUBLIC keys only — the private halves stay in each device's ADR-021 custody tier and never reach the control plane; Plan-018 T5.1, 2026-08-15), and artifact-relay blob-store coordination rows (blob metadata + per-user wrapped CEKs — ciphertext key envelopes and delivery/lease state, never event payloads and never the chunk bytes, which live in the deployment's object store). It does **not** store event payloads.
2. **No `session_events_shared`, `session_events_global`, or equivalent cross-user event table exists in V1.** The absence is intentional, not an oversight. Grepping this file for `session_events_shared` must return this invariant note — never a table definition. Proposals to add one are out of V1 scope.
3. **Per-daemon local `session_events` is authoritative** per ADR-017 and [local-sqlite-schema.md](./local-sqlite-schema.md). Each daemon owns its own event log with its own monotonic sequence number; cross-user audit is federated via log export and merge per [Data Architecture §Federated audit model](../data-architecture.md#event-sourcing-scope).
4. **Supersession gates.** Introducing a shared session-event table requires (a) an ADR superseding ADR-017, and (b) completion of the MLS promotion gates named in [ADR-010 §MLS Promotion Criteria](../../decisions/010-paseto-webauthn-mls-auth.md) — audit visibility, interop tests, and the 4-week soak requirement — because a shared event table is meaningful only if payload-level privacy is carried by group-keyed encryption rather than per-pair PASETO wrapping.

These invariants apply to every subsequent `CREATE TABLE` in this schema. Downstream authors extending this file must check compatibility with (1)–(4) before introducing a table whose name or semantics could read as a shared event log. Event-log anchors (see below under `event_log_anchors`) are deliberately metadata-only witnesses and do **not** violate (2).

---

## Users Identity Anchor (Plan-001)

**Migration-order invariant:** Plan-001's first shared Postgres migration creates the minimal `users` identity-anchor row shape below, **before** any FK-bearing shared table is created. This is required because `sessions.owner_user_id` and `runtime_node_attachments.user_id` both `REFERENCES users(id)`, and Plan-001/003 execute before Plan-018. Plan-018 extends this anchor with identity/profile columns and side tables via additive ALTER migrations — see [Users and Identity (Plan-018)](#users-and-identity-plan-018) below.

```sql
-- Owner: Plan-001 (minimal identity anchor for FK resolution)
-- Extended by: Plan-018 (identity/profile columns via ALTER TABLE — see below)
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The anchor contains only the stable, non-PII fields needed for referential integrity. Plan-018 adds identity-specific columns (`display_name`, `identity_ref`, `metadata`) and the `identity_mappings` side table. No user rows are inserted before Plan-018's registration flow lands — the anchor table exists only so FK constraints in Plan-001/003 tables can be declared at migration time.

---

## Sessions (Plan-001)

```sql
-- Owner: Plan-001
CREATE TABLE sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   UUID NOT NULL REFERENCES users(id),  -- the account holder this session belongs to
  state           TEXT NOT NULL DEFAULT 'provisioning'
                  CHECK(state IN ('provisioning', 'active', 'archived', 'closed', 'purge_requested', 'purged')),
  config          JSONB NOT NULL DEFAULT '{}',   -- session configuration
  metadata        JSONB NOT NULL DEFAULT '{}',   -- extensible metadata
  min_client_version TEXT,                       -- NULL = no floor; semver "MAJOR.MINOR" per ADR-018 §Decision #1
                                                 -- (format) and §Decision #3 (monotonic session-floor enforcement).
                                                 -- Control plane is authoritative for session metadata (ADR-004);
                                                 -- peers read floor from here at join and reject below-floor
                                                 -- writes with VERSION_FLOOR_EXCEEDED per ADR-018 §Decision #4.
                                                 -- Enforcement owned by Plan-003 attach flow (BL-090).
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_state ON sessions(state);

-- BL-069 invariant: `sessions.id` is daemon-assigned UUID v7 per RFC 9562 for the
-- normal production path. Local-only sessions are created by daemons without
-- control-plane contact; the daemon generates the UUID v7 and presents it on
-- reconciliation via idempotent upsert:
--   INSERT INTO sessions (id, ...) VALUES (...)
--     ON CONFLICT (id) DO UPDATE SET updated_at = sessions.updated_at RETURNING *;
-- DO UPDATE (not DO NOTHING) is required so RETURNING * yields a row on every
-- attempt, letting the daemon distinguish retry-after-crash from silent write
-- loss. The gen_random_uuid() default above handles the rare control-plane-
-- originated row (e.g., admin provisioning). Postgres 18's native uuidv7() and
-- uuid_extract_timestamp() reverse-validate any daemon-generated id. See
-- domain/session-model.md §Local-Only Reconciliation.
```

---

## Users and Identity (Plan-018)

Plan-018 extends the [Plan-001 Users Identity Anchor](#users-identity-anchor-plan-001) with identity/profile columns via additive ALTER migrations, and adds the `identity_mappings` and `user_identity_keys` side tables (the latter at the 2026-08-15 promotion pass, T5.1 — its own migration file). The base `users(id, created_at)` table is already present from Plan-001's first migration — Plan-018 does not re-create it.

```sql
-- Owner: Plan-018 (additive extension of the Plan-001 users anchor)
-- Strategy: add columns as NULL-able, backfill from Plan-018 registration flow, then
-- ALTER COLUMN ... SET NOT NULL in a follow-up migration once backfill completes.
ALTER TABLE users
  ADD COLUMN display_name TEXT,                  -- set NOT NULL after backfill
  ADD COLUMN identity_ref TEXT UNIQUE,           -- synthetic primary ref (PASETO kid / minted handle), NOT a {provider}:{external_id} projection — Plan-018 D-018-2; set NOT NULL after backfill
  ADD COLUMN metadata     JSONB NOT NULL DEFAULT '{}';

CREATE INDEX idx_users_identity ON users(identity_ref);

-- Owner: Plan-018
CREATE TABLE identity_mappings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id  UUID NOT NULL REFERENCES users(id),
  provider        TEXT NOT NULL,                 -- e.g. 'github', 'google', 'email'
  external_id     TEXT NOT NULL,                 -- provider-specific ID
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, external_id)
);

CREATE INDEX idx_identity_mappings_user ON identity_mappings(user_id);

-- Owner: Plan-018 (T5.1, 2026-08-15 promotion pass — sibling of identity_mappings)
CREATE TABLE user_identity_keys (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   UUID NOT NULL REFERENCES users(id),
  key_fingerprint  TEXT NOT NULL,        -- per-key selector; the Plan-014 identityKeyFingerprint value
  public_key       TEXT NOT NULL,        -- 64-char lowercase hex Ed25519 public key (the daemon_signing_public_keys column shape); PUBLIC half only — the private half stays in the device's ADR-021 custody tier
  registered_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, key_fingerprint)
);

CREATE INDEX idx_user_identity_keys_user ON user_identity_keys(user_id);
```

**`user_identity_keys` is the device roster, and is multi-row per user by construction (Plan-018 T5.1/I-018-12).** One row per linked device's identity key — a user with N linked devices holds N rows, which is the ordinary Remote Control case rather than an edge case ([trust-and-identity.md §Edge Cases](../../domain/trust-and-identity.md#edge-cases), [user-and-device-model.md](../../domain/user-and-device-model.md)); `UNIQUE(user_id, key_fingerprint)` mirrors `identity_mappings`' `UNIQUE(provider, external_id)` shape (same owner, same anchor, same multi-row idiom). Registration is register-once: a different `public_key` under an existing fingerprint is refused before any row mutation (the control-plane half of ADR-021's Refuse-On-Rotation Invariant). The `REFERENCES users(id)` FK deliberately places the table inside the [Spec-022 §Path 2](../../specs/022-data-retention-and-gdpr.md#shred-fan-out) exhaustive inbound-FK erasure closure — the opposite of `daemon_signing_public_keys`' FK-free choice, because a device's long-term identity key is person-bound (the machine-key exemption does not transfer) and every consumer (Plan-031 bundle admission, Plan-014 attestation delivery, Plan-027 dispatch intake) verifies at live time, so no retained row needs post-erasure re-verification. Reads are scoped to the owning user via `UserIdentityKeyRoster` (Plan-018 I-018-13); key bytes never ride `UserProjection` (I-018-14).

**`identity_ref` is a synthetic primary ref, not a provider projection (Plan-018 D-018-2).** It is a stable identifier decoupled from any single external provider — a PASETO `kid` or an internally minted synthetic handle — so a user who links a second provider keeps one `identity_ref` and gains a second `identity_mappings` row, rather than colliding on the `identity_ref UNIQUE` constraint that a denormalized `{provider}:{external_id}` value would force. The per-provider `{provider, external_id}` tuples live in `identity_mappings`; `identity_ref` is the join-stable user anchor those mappings resolve to.

---

## WebAuthn Ceremony (Plan-018)

Backs the relying party's half of the WebAuthn ceremony [ADR-010](../../decisions/010-paseto-webauthn-mls-auth.md) has required since acceptance and no plan owned until the 2026-09-01 WebAuthn-ceremony amendment (Plan-018 Phase 6, T6.1 — CP-018-14). The Electron main process calls these routes over its own authenticated control-plane channel per [Spec-023 §Main Process Responsibilities](../../specs/023-desktop-shell-and-renderer.md#main-process-responsibilities); no JSON-RPC method string is involved.

```sql
-- Owner: Plan-018 (T6.1, 2026-09-01 WebAuthn-ceremony amendment)
CREATE TABLE webauthn_credentials (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id),
  credential_id     TEXT NOT NULL UNIQUE,   -- base64url; authenticator-minted, unique by construction
  public_key        BYTEA NOT NULL,         -- COSE public key, as returned by the verification library
  signature_counter BIGINT NOT NULL DEFAULT 0,
  uv_mode           TEXT NOT NULL CHECK (uv_mode IN ('uv','no-uv')),  -- the user-verification bit observed at registration
  transports        TEXT[],                 -- authenticator-reported transport hints, for allowCredentials
  registered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at      TIMESTAMPTZ
);

CREATE INDEX idx_webauthn_credentials_user ON webauthn_credentials(user_id);

-- Owner: Plan-018 (T6.1) — the single-use ceremony fence
CREATE TABLE webauthn_challenges (
  challenge       TEXT PRIMARY KEY,         -- the challenge IS the selector a verification presents
  transaction_id  UUID NOT NULL UNIQUE,     -- the correlator an unauthenticated caller quotes back
  user_id  UUID REFERENCES users(id),  -- NULL until a discoverable-credential sign-in is verified
  ceremony        TEXT NOT NULL CHECK (ceremony IN ('registration','authentication')),
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);
```

**`webauthn_challenges` is the single-use fence, and consuming a challenge is deleting its row (Plan-018 T6.4 / I-018-15).** Consumption is one statement — `DELETE FROM webauthn_challenges WHERE challenge = $1 AND transaction_id = $2 AND expires_at > now() RETURNING *` — so two concurrent verifications of one challenge cannot both find a row, and an expired row is never returned even before the periodic sweep reaches it. The sweep is hygiene, not the correctness mechanism. A sealed stateless challenge was considered and rejected: single-use is the property that matters, and a self-contained token stays replayable until it expires unless a durable fence records its consumption, so the stateless design does not remove the write — it adds a second signing secret to rotate beside a write it still has to perform.

**`webauthn_credentials.uv_mode` is the server-held user-verification mode (Plan-018 I-018-16).** It records the bit the verification library reports on the _verified registration response_, never the `userVerification` preference a request carried — a preference binds no authenticator. The **authentication-verify** reply returns the stored mode of the credential that signed — beside the freshly issued, DPoP-bound PASETO access/refresh pair that reply also carries (Codex round 6; a cold install holds no token to unwrap, so the ceremony issues rather than unlocks) — which is what makes [Spec-023 §WebAuthn Platform-Authenticator Native Module](../../specs/023-desktop-shell-and-renderer.md#webauthn-platform-authenticator-native-module)'s guard 4 checkable at all: CTAP 2.1 mints two per-credential secrets and selects between them on that bit, so a client comparing against a locally-remembered mode has nothing after a reinstall and nothing at all on a second desktop using a synced credential. It rides the verdict rather than the options reply because this deployment's credentials are discoverable — the options leg offers no credential list and cannot know whose mode to return.

**There is deliberately no `prf_eval_input` column (Plan-018 I-018-18).** A `BYTEA NOT NULL` evaluation input was specified here at Codex round 5 and **retired at round 6**: it is unserveable on this deployment, because the credentials are discoverable and the authentication-options reply is composed before any credential is known, so there is nothing to look a per-credential value up for — and returning every candidate's instead would publish the user's enrolled-credential set on a reply that is unauthenticated by design. The PRF evaluation input is a contract-fixed public constant registered at [api-payload-contracts.md §WebAuthn Ceremony Procedure Registry](../contracts/api-payload-contracts.md), the same for every credential, so this table stores nothing for it. The per-authenticator key separation the column was also read as providing lives on the client instead, in [Spec-023](../../specs/023-desktop-shell-and-renderer.md#webauthn-platform-authenticator-native-module)'s custody root — each credential's derived KEK wraps a copy of one installation-scoped key rather than wrapping the envelopes directly.

**The verification transaction takes this table `FOR UPDATE` (Plan-018 I-018-19).** The signature-counter advance is a locked read and a conditional write inside the same transaction that consumed the challenge, so the ceremony's lock order is `webauthn_challenges` → `webauthn_credentials`, registered below at [§Lock Ordering Across Shared Tables](#lock-ordering-across-shared-tables). An unlocked read-then-write is defeated by the exact adversary the counter exists to detect: two concurrent replays of a cloned authenticator each read the pre-existing value and each find the presented counter greater.

Both tables carry `REFERENCES users(id)` for the same reason `user_identity_keys` does — it places them inside the [Spec-022 §Path 2](../../specs/022-data-retention-and-gdpr.md#shred-fan-out) exhaustive inbound-FK erasure closure, and the closure costs nothing because a WebAuthn credential is verified live and no retained row re-verifies one post-erasure.

---

## Token Revocation (BL-070 — Auth Infrastructure)

Backs `POST /auth/revoke-all-for-user` (see [security-architecture.md §Bulk Revoke All For User](../security-architecture.md#bulk-revoke-all-for-user-bl-070)). Cross-plan auth infrastructure, not Plan-018 identity schema.

```sql
-- Owner: BL-070
CREATE TABLE revoked_jtis (
  jti              TEXT PRIMARY KEY,
  user_id   UUID REFERENCES users(id) ON DELETE SET NULL,  -- nullable + SET NULL on erasure (Plan-022 D-022-7)
  family_id        UUID NOT NULL,                 -- refresh-token rotation family
  revoked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason           TEXT NOT NULL
                   CHECK(reason IN ('account_compromise', 'password_reset', 'admin_action', 'self_service')),
  expires_at       TIMESTAMPTZ NOT NULL            -- aligns with the revoked token's natural expiry
);

CREATE INDEX idx_revoked_jtis_user ON revoked_jtis(user_id);
CREATE INDEX idx_revoked_jtis_family ON revoked_jtis(family_id);
CREATE INDEX idx_revoked_jtis_expires ON revoked_jtis(expires_at);

-- Owner: BL-070
CREATE TABLE revoked_token_families (
  family_id        UUID PRIMARY KEY,
  user_id   UUID REFERENCES users(id) ON DELETE SET NULL,  -- nullable + SET NULL on erasure (Plan-022 D-022-7)
  revoked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason           TEXT NOT NULL
                   CHECK(reason IN ('account_compromise', 'password_reset', 'admin_action', 'self_service')),
  expires_at       TIMESTAMPTZ NOT NULL            -- aligns with the revoked family's natural expiry; bounds the reap (mirror revoked_jtis)
);

CREATE INDEX idx_revoked_families_user ON revoked_token_families(user_id);
CREATE INDEX idx_revoked_families_expires ON revoked_token_families(expires_at);
```

**GDPR erasure.** `user_id` is nullable + `ON DELETE SET NULL` by design — born this way at BL-070's post-V1 build (no migration; these tables build already in their final FK shape). A user hard-DELETE severs the data-subject link, while the denylist key (`jti` / `family_id`, the PRIMARY KEY — **not** `user_id`) survives to its natural `expires_at + 24h` reap, so erasure cannot resurrect a revoked token within its validity window (the GDPR Art. 17(3) security carve-out). Canonical: [Plan-022 D-022-7](../../plans/022-data-retention-and-gdpr.md#ratified-design-decisions-tier-5-audit-2026-05-30), [Spec-022 §Shred Fan-Out](../../specs/022-data-retention-and-gdpr.md#shred-fan-out); the [GDPR Manual Erasure Runbook](../../operations/gdpr-manual-erasure-runbook.md) is the V1 operator procedure.

**Retention:** Rows are reaped after `expires_at + 24h` safety margin. The 7-day refresh-token TTL (see [security-architecture.md §Token revocation](../security-architecture.md#token-revocation)) bounds the total row count — worst case is roughly `7 days × daily-active refresh tokens per user`.

**Multi-region propagation:** The control plane writes a revocation row to the local region, then propagates via Postgres logical replication (publication/subscription) to peer regions. Propagation is best-effort and eventually consistent; see [security-architecture.md §Bulk Revoke All For User](../security-architecture.md#bulk-revoke-all-for-user-bl-070) for the eventual-consistency window analysis.

---

## Runtime Node Attachments (Plan-003)

```sql
-- Owner: Plan-003
CREATE TABLE runtime_node_attachments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES sessions(id),
  user_id  UUID NOT NULL REFERENCES users(id),
  node_id         TEXT NOT NULL,                 -- daemon-assigned node identifier
  capabilities    JSONB NOT NULL DEFAULT '{}',   -- declared capabilities
  client_version  TEXT NOT NULL,                 -- daemon semver "MAJOR.MINOR" at attach; floor-compared vs sessions.min_client_version (ADR-018 §Decision #4) — makes the read-only verdict auditable + roster-displayable
  state           TEXT NOT NULL DEFAULT 'registering'
                  CHECK(state IN ('registering', 'online', 'degraded', 'offline', 'revoked')),
  attached_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_node_attachments_session ON runtime_node_attachments(session_id);
CREATE INDEX idx_node_attachments_user ON runtime_node_attachments(user_id);
CREATE UNIQUE INDEX idx_node_attachments_node ON runtime_node_attachments(node_id, session_id);
-- One-active-session enforcement (Plan-003 I-003-5; Spec-003 §Resolved Questions and V1 Scope Decisions — "one active session at a time in v1"):
-- a node has at most one attachment in an active state across all sessions. The partial UNIQUE constrains
-- only active-state rows, so an inactive ('offline' or 'revoked') row does not block a later (re)attach at
-- the index level. Reattach eligibility is then a T3.2 application decision: an 'offline' row is reactivated
-- on reconnect, while a 'revoked' row is refused — revocation is terminal (Plan-003 T3.2/P10).
CREATE UNIQUE INDEX idx_node_attachments_active ON runtime_node_attachments(node_id)
  WHERE state IN ('registering', 'online', 'degraded');

-- Owner: Plan-003
CREATE TABLE runtime_node_presence (
  node_id             TEXT NOT NULL PRIMARY KEY,
  last_heartbeat_at   TIMESTAMPTZ NOT NULL,
  health_state        TEXT NOT NULL DEFAULT 'online'
                      CHECK(health_state IN ('online', 'degraded', 'offline'))
);
```

---

## Session Directory and Relay (Plan-031)

```sql
-- Owner: Plan-031
CREATE TABLE session_directory (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES sessions(id) UNIQUE,
  relay_endpoint  TEXT,                          -- WebSocket URL for relay
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Owner: Plan-031
CREATE TABLE relay_connections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES sessions(id),
  node_id         TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'connecting'
                  CHECK(state IN ('connecting', 'connected', 'disconnected')),
  connected_at    TIMESTAMPTZ,
  disconnected_at TIMESTAMPTZ,
  metadata        JSONB NOT NULL DEFAULT '{}'    -- connection metadata
);

CREATE INDEX idx_relay_connections_session ON relay_connections(session_id);

-- Owner: Plan-031
-- Durable cross-session ephemeral-key reuse guard: Spec-031 §The encryption envelope requires the
-- control plane to record the first session that claimed each ephemeral X25519 public key and to
-- reject any later presentation of that key under a different session.
-- Each endpoint mints a fresh ephemeral X25519 key pair per session (Spec-031), and the
-- per-session relay Durable Object discards its bundles on close — so a key reused in a *later*
-- session can only be detected against a store that OUTLIVES the session. This control-plane table
-- is that store (OD-008r-2, Tier-5 readiness audit). The PK on the public key is the DB-level
-- uniqueness index that makes a duplicate INSERT of a key a constraint violation; the broker's
-- admission logic reads the stored session_id before deciding — rejecting a CROSS-session reuse
-- with relay.bundle_rejected (Spec-031) and treating a SAME-session
-- re-presentation as an idempotent admit ONLY for the endpoint that first claimed the key
-- (Spec-031's reconnect-resume step; a different endpoint
-- is rejected). That original-claimant check is broker live-layer logic against the in-memory
-- admission record (fail-closed when absent → client re-mints) — this table stays the cross-session
-- (key → first session_id) backstop, never a claimant store. The audit ratifies that the store is
-- durable + uniqueness-indexed and that its retention is — by design — the FULL single-use horizon:
-- Spec-031 requires a reused key to be rejected across ALL distinct sessions, so
-- any pruning that drops a still-rejectable key would re-admit it on re-insert — a literal
-- invariant violation — and therefore V1 prunes nothing. Full-horizon retention is the correct
-- terminal design here, not a placeholder to be optimized later: the ephemeral public key is a
-- CLIENT-chosen value with no server-anchored birth time except its first appearance in this table,
-- so a freshness/TTL window cannot bound the store — a client reusing a key re-presents it under a
-- fresh timestamp that a time-windowed store would have forgotten and would wrongly re-admit. (This
-- is why the TLS 1.3 0-RTT anti-replay window does NOT transfer: that window binds a SERVER-issued
-- ticket age the peer cannot re-stamp — RFC 8446 §8 — whereas here the dedup key is client-minted.)
-- Remembering every key is therefore irreducible, not lazy. The table is bounded by historical
-- (session × user) ephemeral-key count, not by traffic volume (~64 bytes/row — trivial at
-- desktop-runtime scale); at hosted scale its growth is an ops concern (time-partition the table,
-- keeping every partition queryable — never DROP, which would re-admit a pruned key) decoupled from
-- the security property. Bounding retention would weaken the Spec-031
-- forward-secrecy guarantee and is therefore a decision of Spec-031's own, not a code-level
-- optimization.
CREATE TABLE relay_seen_ephemeral_keys (
  ephemeral_x25519_public BYTEA PRIMARY KEY,     -- 32-byte X25519 public key; PK = global single-use index
  session_id              UUID NOT NULL REFERENCES sessions(id),  -- the session that first claimed this key
  seen_at                 TIMESTAMPTZ NOT NULL DEFAULT now()      -- first-seen audit anchor (full-horizon retention by design; see comment above)
);

CREATE INDEX idx_relay_seen_ephemeral_keys_session ON relay_seen_ephemeral_keys(session_id);
```

---

## Session Channel Directory (Plan-016)

The control-plane half of the channel directory ([Spec-016 §Interfaces And Contracts](../../specs/016-multi-agent-channels-and-orchestration.md#interfaces-and-contracts), D-016-22): the store the `channel.directoryPublish` ingest mutation writes and the `ChannelList` read serves, so a device that did not create a channel can still list it. **Plan-016 owns the whole directory** — the daemon-side producer and this store alike — so the ingest mutation, this DDL, and the read path have one owner and one shape. **Forward-declared:** the additive migration ships with Plan-016's channel-directory control-plane task; the DDL is pinned here so that task, the ingest mutation, and the `ChannelList` read share one canonical shape.

Channel **content** never reaches the control plane — it transits the relay end-to-end sealed. What this table holds is channel existence metadata only, which is the deliberate, scoped disclosure Spec-016 records.

```sql
-- Owner: Plan-016 (channel-directory control-plane leg per D-016-22)
-- One row per published channel. The daemon publishes every accepted channel-lifecycle transition
-- after its durable event append, at-least-once and never blocking, so this table converges rather
-- than being authoritative: it is a projection of publications, and the daemon's own events remain
-- canonical (ADR-017).
CREATE TABLE session_channel_directory (
  channel_id        UUID PRIMARY KEY,                      -- daemon-minted channel id; the directory is keyed by the channel itself
  session_id        UUID NOT NULL REFERENCES sessions(id), -- scopes the ChannelList read and the Spec-022 erasure closure
  name              TEXT,                                  -- user-supplied; create-once bound (below). NULL until the creation publication lands
  kind              TEXT,                                  -- the ChannelCreate channel kind; create-once bound. NULL = unresolvable -> the entry is OMITTED from ChannelList
  state             TEXT NOT NULL
                    CHECK(state IN ('active', 'muted', 'archived')),  -- the daemon channel-state vocabulary, verbatim
  disclosure_origin TEXT,                                  -- the originNodeId whose origin-authenticated creation publication bound name + kind; NULL until bound
  disclosure_conflicted BOOLEAN NOT NULL DEFAULT false,    -- two origin-authenticated creation claims disagreed -> kind unresolvable, entry omitted
  retained_candidates JSONB NOT NULL DEFAULT '{}',         -- the per-origin candidate-retention fold: one entry per originNodeId holding
                                                           -- {originSeq, state, occurredAt, eventId}, keeping the originSeq-max candidate for
                                                           -- that origin; publications from before the origin-key extension share one reserved
                                                           -- keyless slot ordered by envelope (occurredAt, id) alone. `state` above is RESOLVED
                                                           -- from this set, never written directly by an ingest.
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_session_channel_directory_session ON session_channel_directory(session_id);
```

**Resolution rules the ingest enforces (Spec-016 §Interfaces And Contracts).** `state` is resolved from `retained_candidates`, not assigned: `archived` is terminal in the channel lifecycle and therefore **latches** — the row reads `archived` iff any retained candidate ever carried it, so a delayed or replayed mute/unmute straggler can never resurrect it — while a non-terminal resolution takes the `(occurredAt, id)`-lexicographic-max retained candidate. The disclosure-bearing fields `name` and `kind` bind **create-once**, on an axis independent of `state`: they are honored only from the publication whose `lifecycleEventKind` is `channel.created` and whose authenticated caller identity matches its payload's `originNodeId`, and are immutable thereafter. A healing re-publication by a non-origin daemon keeps the row's existence and ordering alive but binds nothing, so a compromised daemon cannot relabel another origin's channel — its forgeries land as omitted placeholders at worst. Because both the retention fold and the create-once binding are order-independent, duplicates and stragglers converge instead of regressing directory state, and a delayed publication can briefly under-list a channel but never lists one on facts the control plane could not verify.

**GDPR.** `name` is user-supplied free text, so this table and that column are durable-tier PII: the row joins the [Spec-022 §Shred Fan-Out](../../specs/022-data-retention-and-gdpr.md#shred-fan-out) closure through `session_id`, deleted with the session it belongs to, and a name cleared by erasure can never rebind from a redelivered or sweep publication because the create-once binding admits only a creation publication that has already been honored.

**Verification**: consistent with the invariants at the top of this file — a single current-state coordination row per channel, never an event log; the `channel.*` lifecycle event stream stays in the daemon-local event store per ADR-017.

---

## Artifact Relay Blob Store (Plan-014)

Coordination state for the [Spec-014 §Cross-Node Artifact Relay (V1)](../../specs/014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1) eager-pin store-and-forward: blob metadata, per-user wrapped content-encryption keys (CEKs), delivery refcounts, and fetch grace leases. The ciphertext **chunk bytes never enter Postgres** — they live in the deployment's object store (invariant (1) above); these tables hold only key envelopes and lifecycle state, so a relay operator (or a Postgres compromise) yields ciphertext coordinates but no decryption capability. Both user references join the [Spec-022 §Shred Fan-Out](../../specs/022-data-retention-and-gdpr.md#shred-fan-out) Path-2 `REFERENCES users(id)` closure (CP-022-6): `artifact_relay_recipients.user_id` is hard-DELETE class (dropping the row IS the wrapped-CEK crypto-shred), and `artifact_relay_blobs.publisher_user_id` is anonymize class (born nullable + `ON DELETE SET NULL` — the blob survives to refcount-zero/TTL so the remaining recipient nodes' availability is unaffected by the publisher's erasure).

```sql
-- Owner: Plan-014
-- Blob lifecycle: state 'pending_replication' at upload-init → 'pinned' when every chunk is
-- relay-acknowledged AND the finalize has re-hashed the assembled ciphertext to equal ciphertext_digest — the CAS key is verified, never trusted; a re-pin re-verifies the stored copy, so re-publish repairs at-rest corruption
-- (the offline-availability guarantee attaches ONLY to a LIVE pin: state = 'pinned' AND expires_at > now(). Read paths evaluate that
--  predicate rather than trusting state alone, because the sweep is hourly and a row can sit past its TTL until it runs — Spec-014
--  §TTL sweep disposition (V1), 2026-08-26);
-- 'expired' records a TTL sweep. Value set = the storage-lifecycle SUBSET of the Spec-014 replicationStatus wire enum:
-- the degradation states ('over_cap' / 'quota_exceeded') mean NO relay upload happened (Spec-014 failure table), so
-- they never create a blob row — they live only on the artifact manifest (SQLite replication_status + the wire field).
-- Byte-destruction triggers: refcount-zero (all intended recipients fetched) OR expires_at, whichever
-- first; hourly async sweep + 90% node-storage watermark eviction (delivered/nearest-TTL first).
-- ROW disposition differs by trigger (Spec-014 §TTL sweep disposition (V1), settled 2026-08-26, BL-152):
--   refcount-zero delete and watermark eviction DELETE this row (reclaiming the object FIRST — the mirror of
--   the TTL order below, safe because their trigger already establishes no fetch is owed); recipients cascade.
--   the TTL sweep RETAINS it as a TOMBSTONE at state='expired' — payload-free once its reclaim confirms — so
--   a later fetch can be told 410 (was pinned, retention elapsed, re-publish restores) instead of a zero-row
--   404 (no grant). One INTENT transaction hard-DELETEs every recipient row for the digest (the wrapped-CEK
--   crypto-shred) and sets state='expired'; the object-store bytes are reclaimed strictly after; a CONFIRMING
--   transaction then stamps bytes_reclaimed_at and NULLs publisher_user_id together (timing corrected
--   2026-08-26, PR #364 round 1). That order is mandatory: this row is the ONLY index into the stored object,
--   so deleting it first would orphan bytes on a crash. The tombstone is purged once bytes_reclaimed_at +
--   relay_tombstone_grace (30 d default) has passed. A re-publish UPSERT re-anchors expires_at, returns state
--   to 'pending_replication', and CLEARS bytes_reclaimed_at — but ONLY on a tombstone whose reclaim has
--   confirmed: arriving while bytes_reclaimed_at IS NULL it is refused 429 + Retry-After, because the reclaim
--   it would race commits outside this transaction and would delete the bytes the re-pin just wrote. Stages 2-3
--   also run under a session-level advisory lock on the digest, so two passes cannot delete one key concurrently.
-- The due-pin and purge stages are both driven off idx_artifact_relay_blobs_expires — due pins by expires_at,
-- purgeable tombstones by expires_at < now() - grace (a superset, since bytes_reclaimed_at >= expires_at
-- always) — so neither needs an index of its own. The RECLAIM-RETRY pass does (added 2026-08-26, PR #364
-- round 1): it must find tombstones whose object-store delete has not confirmed, and bytes_reclaimed_at IS NULL
-- is not a prefix of that index, so the pass would scan the whole grace-window population — which grows every
-- hour and is dominated by rows already reclaimed. The partial index below isolates exactly the retry set,
-- and stays small by construction because every row leaves it as soon as its reclaim confirms.
CREATE TABLE artifact_relay_blobs (
  ciphertext_digest        TEXT PRIMARY KEY,   -- multihash-prefixed (sha256:…) whole-ciphertext digest; CAS key, one row per stored blob
  session_id               UUID NOT NULL REFERENCES sessions(id),
  publisher_user_id UUID REFERENCES users(id) ON DELETE SET NULL,  -- anonymize-class (CP-022-6); NULL after publisher erasure.
                           -- Second, lifecycle-driven writer (2026-08-26): the TTL sweep NULLs it — but in the
                           -- transaction that stamps bytes_reclaimed_at, NOT at the sweep's intent, so bytes still
                           -- in the object store stay attributable to the publisher whose quota they spend
                           -- (Spec-014 §TTL sweep disposition (V1)). An unreclaimed tombstone therefore still names
                           -- its publisher, and is covered by this same ON DELETE SET NULL if erasure arrives first.
  size_bytes               BIGINT NOT NULL,
  chunk_size_bytes         INTEGER NOT NULL,   -- fixed 8 MiB in V1 (Spec-014 artifact_relay_chunk_bytes)
  chunk_count              INTEGER NOT NULL,
  retention_tier           TEXT NOT NULL DEFAULT 'default'
                           CHECK(retention_tier IN ('volatile', 'default', 'extended')),
  state                    TEXT NOT NULL DEFAULT 'pending_replication'
                           CHECK(state IN ('pending_replication', 'pinned', 'expired')),
  expires_at               TIMESTAMPTZ NOT NULL,          -- tier-derived TTL deletion trigger; re-anchored to now + tier TTL on every successful re-pin (Spec-014 Publish steps 3-4: a re-pin is a fresh grant of the same bytes)
  bytes_reclaimed_at       TIMESTAMPTZ,        -- NULL until the sweep confirms the object-store bytes are gone; the
                                               -- confirming UPDATE stamps this AND NULLs publisher_user_id in
                                               -- ONE transaction (the two stop together — see that column). Then the
                                               -- relay_tombstone_grace purge clock, and the predicate byte-quota accounting
                                               -- filters on (a tombstone spends no session/user budget). A tombstone
                                               -- left with NULL here is a reclaim owed a retry on the next sweep pass; the
                                               -- retry is safe because the relay holds no content refcount (ciphertext_digest
                                               -- is the PK and per-artifact CEKs preclude cross-publication dedup), so the
                                               -- reclaim is a plain idempotent object-store delete. Added 2026-08-26.
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_artifact_relay_blobs_session ON artifact_relay_blobs(session_id);
CREATE INDEX idx_artifact_relay_blobs_expires ON artifact_relay_blobs(expires_at);
CREATE INDEX idx_artifact_relay_blobs_unreclaimed ON artifact_relay_blobs(expires_at)
  WHERE state = 'expired' AND bytes_reclaimed_at IS NULL;   -- reclaim-retry queue only; an INDEX, not a table, so no census moves

-- Owner: Plan-014
-- One row per (blob, intended recipient node): carries the wrapped CEK for one attested (user, node) — encrypted to that node's DURABLE artifact-encryption X25519 key (Spec-014 Publish step 3; never the ADR-010 session-ephemeral keys, which are zeroed at session end and would orphan the CEK on restart), thumbprint-tagged so the fetching daemon selects the right private key after restart/rotation — the relay cannot unwrap;
-- per Spec-014 Publish step 3 this row is the wrapped CEK's ONLY store, never the durable artifact.published event — deleting it is a true shred), delivery state (delivered_at NULL = undelivered;
-- refcount-zero = zero NULLs remain for the blob across every (user, node) row — a user's
-- second node keeps the blob alive until it fetches or TTL; delivered_at is written ONLY by the
-- authenticated ArtifactFetchComplete ack that follows client-side chunk/commitment/CAS verification,
-- never inferred from the last chunk GET — Spec-014 Fetch step 6; the acked row is resolved from the
-- fetch token's own (user, node) DPoP-bound claims, never a caller-supplied node_id, so a node presenting a token minted for itself cannot mark a sibling delivered; mint-time authorization is user-granular (Spec-014 Fetch step 5, scoped 2026-08-08) and this ack proves no CEK unwrap, so a COMPROMISED
-- same-user node CAN still forge this write, clear the blob's last outstanding row, and destroy the blob at refcount-zero GC with no remedy while the publisher is offline — the named V1 availability residual, not a closed case; and the write is idempotent), and the in-flight fetch grace lease
-- (GC must not evict the blob while a lease is live — a bound on DISCRETIONARY watermark eviction only; it does
--  NOT extend the contracted TTL, so a fetch crossing an expiry boundary is refused rather than carried past
--  the retention bound. Spec-014 §TTL sweep disposition (V1), 2026-08-26). Hard-DELETE class in the CP-022-6
-- closure: deleting a user's rows IS the crypto-shred (their reach to the CEK is destroyed) and
-- simultaneously removes them from the intended-recipient set, keeping refcount semantics
-- consistent after erasure. The SAME hard delete has a second, lifecycle-driven trigger (2026-08-26): the TTL
-- sweep drops every row for the digest in its own transaction, so the wrapped CEKs are shredded on the ordinary
-- retention path and not only on an erasure request. The disposition is unchanged — only when it fires is wider
-- — and the blob tombstone the sweep leaves behind names no user once its reclaim confirms, while its one
-- pre-reclaim reference (publisher_user_id) is already an enumerated anonymize-class FK, so it joins
-- neither the Spec-022 PII data map nor the CP-022-6 closure at either stage. Backup honesty (Spec-014 §State And Data Implications): Postgres
-- PITR/WAL archiving is database-wide — rows cannot be excluded — so either the backup/PITR
-- window is bounded ≤ the erasure SLA (30 d relay-TTL ceiling), or wrapped_cek is stored under a
-- separately-destroyable KEK (Spec-022 §Daemon Master Key precedent); otherwise shred is incomplete.
CREATE TABLE artifact_relay_recipients (
  ciphertext_digest TEXT NOT NULL REFERENCES artifact_relay_blobs(ciphertext_digest) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id),  -- hard-DELETE class (CP-022-6); erasure removes ALL of a user's node rows
  node_id           TEXT NOT NULL,      -- daemon-assigned node identifier (runtime_node_* convention); per-node delivery tracking
  wrapped_cek       BYTEA NOT NULL,     -- CEK wrapped to this node's durable artifact-encryption X25519 key; ~100 bytes
  key_thumbprint    TEXT NOT NULL,      -- thumbprint of the wrapping public key; the recipient retains that key (even once retired) until this row is delivered or TTL-expired
  delivered_at      TIMESTAMPTZ,        -- NULL = not yet fetched-and-verified by this recipient node
  lease_expires_at  TIMESTAMPTZ,        -- in-flight resumable-fetch grace lease; NULL when no fetch in flight
  PRIMARY KEY (ciphertext_digest, user_id, node_id)
);

CREATE INDEX idx_artifact_relay_recipients_user ON artifact_relay_recipients(user_id);

-- Thumbprint→node injectivity within one user's rows for one blob (2026-08-16 artifact-lifecycle
-- amendment). This is what makes the Spec-014 Fetch step 5 mint selector resolvable: the caller presents the
-- key thumbprints it holds, and (ciphertext_digest, user_id = token sub, key_thumbprint) must select
-- exactly ONE row, from which node_id is derived — never from caller input. An INDEX, not a table: no census
-- moves. It composes with the primary key above rather than replacing it — the PK bounds rows per node, this
-- index bounds rows per key. Satisfiable by construction: each node generates its own artifact-encryption
-- keypair and no private key is ever shared or copied between nodes (trust-and-identity.md §Edge Cases), so
-- two of a user's nodes cannot legitimately carry one thumbprint. The ONE violating state is the
-- attestation spoof Spec-014 Publish step 3 names as a V1 residual — and this index converts it from a silent
-- victim-node lockout into a pre-write refusal: the relay validates the declared recipient entries for a
-- duplicate (user, thumbprint) BEFORE writing, drops BOTH colliding entries fail-closed (it cannot
-- adjudicate which node is honest), pins for every non-colliding recipient, and reports the dropped entries to
-- the publisher. The publish itself never fails — failing it would hand any user-authorized identity a
-- denial-of-publish primitive over the whole session. The index is therefore the durable backstop behind a
-- check the write path already makes. NOTE for the re-pin path: a re-publish to a node that has ROTATED must
-- UPSERT on the primary key (updating wrapped_cek + key_thumbprint in place), never INSERT — an insert would
-- violate the PK and a second row per node would break the I-014-7 per-node delivery refcount. The screen
-- covers SURVIVING rows as well as the submitted set (Spec-014 Publish step 3; 2026-08-17, PR #341 round 2):
-- an incoming entry — a re-pin UPSERT included — whose (user, thumbprint) collides with a surviving
-- row for a DIFFERENT node is rejected per-entry with the surviving row untouched (a standing grant is never
-- deleted on the strength of a new publish — that would be a revocation primitive), the publish never fails,
-- and a write-time violation of this index that outruns the screen resolves to the same per-entry rejection.
CREATE UNIQUE INDEX idx_artifact_relay_recipients_thumbprint
  ON artifact_relay_recipients(ciphertext_digest, user_id, key_thumbprint);
```

---

## Rate Limiting Tables (Plan-021)

Admin bans (`admin_bans`) are shared by both deployments. Escalation state (`rate_limit_escalations`) is self-host only; hosted deployments use Cloudflare Durable Objects (`RateLimitEscalationDO`) for escalation state and persist nothing in Postgres for that path. The self-host sliding-window counters live in `ratelimit_*`-prefixed tables that `rate-limiter-flexible` auto-creates on first use — library-managed, deliberately absent from this hand-authored schema and from the migration sequence (`Plan-021 §Data And Storage Changes`).

```sql
-- Owner: Plan-021
CREATE TABLE admin_bans (
  ban_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity        TEXT NOT NULL,
  identity_type   TEXT NOT NULL
                  CHECK(identity_type IN ('user', 'ip', 'token_hash', 'session', 'user')),
  issued_by       TEXT NOT NULL,                  -- operator attribution, server-derived from the operator-token context (Plan-021 D-021-1: 'deployment-operator' in V1 — no user principal exists on this surface); deliberately no FK — rows survive user deletion (Plan-021 D-021-13)
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason          TEXT,
  expires_at      TIMESTAMPTZ,                    -- NULL = permanent
  revoked_at      TIMESTAMPTZ,
  revoked_by      TEXT                            -- operator attribution of the revoking operator (same semantics as issued_by)
);

-- One-active-ban enforcement: partial UNIQUE applies only to non-revoked rows. The predicate
-- cannot test expiry (now() is not IMMUTABLE — true of ANY index predicate, so no separate
-- expiry-filtered lookup index can exist either); an expired-but-unrevoked row keeps the slot and
-- the issue path supersedes it by atomic revoke-then-insert (Plan-021 D-021-12). This index also
-- serves the ban-check hot read: findActive scans it and filters expiry in the query
-- (AND (expires_at IS NULL OR expires_at > now())) at execution time.
CREATE UNIQUE INDEX idx_admin_bans_one_active
  ON admin_bans (identity, identity_type)
  WHERE revoked_at IS NULL;

-- Owner: Plan-021 (self-host only; hosted uses RateLimitEscalationDO)
CREATE TABLE rate_limit_escalations (
  identity             TEXT NOT NULL,
  identity_type        TEXT NOT NULL
                       CHECK(identity_type IN ('user', 'ip', 'token_hash', 'session', 'user')),
  violation_timestamps TIMESTAMPTZ[] NOT NULL DEFAULT '{}',  -- per-violation timestamps; append + prune to the 1-hr horizon on upsert — exact N-in-window ladder evaluation, DO parity (Plan-021 §Data And Storage Changes)
  active_block_until   TIMESTAMPTZ,
  PRIMARY KEY (identity, identity_type)
);
```

The five-value `identity_type` domain (`'user' | 'ip' | 'token_hash' | 'session' | 'user'`) matches `RateLimitIdentityType` in `packages/contracts/src/rate-limiter.ts` (Plan-021 D-021-17 — `'session'` covers the per-session registry rows; `'user'` is reserved dormant for the V1.1 `keypackage.upload` activation per ADR-010, with no V1 writer); both tables carry the same CHECK so the domain cannot drift per table.

**GDPR erasure dispositions (Plan-021 D-021-13; mirrored in [Spec-022 §Shred Fan-Out](../../specs/022-data-retention-and-gdpr.md#shred-fan-out) and the [manual-erasure runbook](../../operations/gdpr-manual-erasure-runbook.md)).** `admin_bans` rows are **retained** on user erasure under the abuse-prevention legitimate-interest carve-out — including rows whose `identity_type = 'user'` matches the erased user and rows where the erased user appears as `issued_by`/`revoked_by` (erasure must not un-ban an identity, and operator attribution must survive; hence TEXT columns with no FK). Revoked or expired rows become purgeable 90 days after revocation/expiry. `rate_limit_escalations` rows for an erased user identity are **hard-DELETEd** (ephemeral ≤1-hour operational state; nothing to retain). Ephemerality is actively enforced, not upsert-dependent: rows whose violations have all aged past the 1-hr horizon and whose block (if any) has expired — `GREATEST(max(violation_timestamps) + interval '1 hour', COALESCE(active_block_until, '-infinity')) < now()` — are deleted by `PostgresEscalationStore.sweepExpired()` on the relay's unref'd 10-minute interval (Plan-021 T21.2-3; scheduled by the relay's own startup step), mirroring the hosted DO's self-eviction alarm; a quiet identity's row never outlives its window. The library-managed `ratelimit_*` counter tables (section intro above) hold no per-user durable state beyond their sliding windows and are outside the erasure fan-out.

---

## Cross-Node Dispatch Coordination (Plan-027)

Routing metadata only. The control plane never stores dispatch payloads, ApprovalRecord envelopes, PASETO tokens, action payloads, or result payloads; those remain daemon-local per ADR-017 and Spec-024.

```sql
-- Owner: Plan-027
CREATE TABLE cross_node_dispatch_coordination (
  dispatch_id           UUID PRIMARY KEY,
  session_id            UUID NOT NULL REFERENCES sessions(id),
  caller_user_id UUID NOT NULL REFERENCES users(id),
  target_user_id UUID NOT NULL REFERENCES users(id),
  target_node_id        TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'requested'
                        CHECK(status IN ('requested', 'approved', 'denied', 'executed', 'expired')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at           TIMESTAMPTZ
);

CREATE INDEX idx_cross_node_dispatch_coordination_session
  ON cross_node_dispatch_coordination(session_id, status);

CREATE INDEX idx_cross_node_dispatch_coordination_target
  ON cross_node_dispatch_coordination(target_node_id, status);
```

**GDPR erasure (hard-DELETE class).** `cross_node_dispatch_coordination` has **no `user_id` column**; it references the user as both `caller_user_id` and `target_user_id`, each `NOT NULL REFERENCES users(id)` with the default `NO ACTION`. A user erasure therefore hard-DELETEs every row where the user is caller **or** target — `DELETE FROM cross_node_dispatch_coordination WHERE caller_user_id = :pid OR target_user_id = :pid;` — and must run **before** the `DELETE FROM users` anchor, or the two `NO ACTION` FKs make that parent `DELETE` fail. This row is routing metadata only (the dispatch payload, capability token, and `ApprovalRecord` are never stored here), so it is hard-DELETE, not anonymize. Canonical: [Spec-022 §Shred Fan-Out](../../specs/022-data-retention-and-gdpr.md#shred-fan-out); the [GDPR Manual Erasure Runbook §Path 2](../../operations/gdpr-manual-erasure-runbook.md#path-2--hard-delete--sever-postgres-rows-control-plane) is the V1 operator procedure.

---

## Notification Preferences (Plan-019)

```sql
-- Owner: Plan-019
CREATE TABLE notification_preferences (
  user_id    UUID NOT NULL REFERENCES users(id),
  preference_key    TEXT NOT NULL,               -- e.g. 'approval_required', 'run_failed'
  preference_value  JSONB NOT NULL DEFAULT '{}', -- channel, threshold, mute settings
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, preference_key)
);
```

---

## Notification Queue (Plan-019)

Durable per-user delivery records for the offline leg of [Spec-019 §Cross-Device Delivery](../../specs/019-notifications-and-attention-model.md#cross-device-delivery): V1 delivers notifications to currently-connected devices over the SSE subscription, and **if no device is connected the notification is queued in the control plane** and delivered as a batch on the user's next connect, replayed from the last delivered position. This table is that queue — the substrate the spec's catch-up sentence assumes. **Forward-declared:** the additive migration ships with the Plan-019 Phase 2 preference-and-queue-storage leg (`Plan-019 §Implementation Phase Sequence`); the DDL is pinned here so the emit path, the reconnect catch-up read, the expiry sweep, and the migration share one canonical shape.

**Deliberately absent: no cursor table, no per-device delivery state, no delivery-attempt or backoff column, no coalescing or cross-device dedup key.** Each omission tracks a behavior Spec-019 does not state, and columns are not added ahead of the behavior that would write them. The catch-up cursor is derived, not stored (see the delivery model below). Per-device state has no V1 writer: the spec scopes V1 delivery to the user and defers per-device fan-out — and with it any duplicate-suppression across devices — to the V2 push/digest leg. Redelivery attempts, backoff, and coalescing of related notifications are likewise unstated: a queued row is either pushed once (and stamped) or stays owed until it expires.

```sql
-- Owner: Plan-019 (Phase 2 ships the additive control-plane migration)
-- One row per notification owed to one user while that user has no connected device.
-- Coordination/delivery records only: each row carries a REFERENCE to the canonical event that
-- triggered it (source_event_id) plus the derived notification-rendering fields, never the event
-- payload -- the invariant-(1) constraint at the top of this file.
CREATE TABLE notification_queue (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_sequence    BIGSERIAL UNIQUE,            -- monotonic per-table delivery order; the derived catch-up cursor reads it (BIGSERIAL implies NOT NULL)
  user_id    UUID NOT NULL REFERENCES users(id),
  session_id        UUID NOT NULL REFERENCES sessions(id),
  run_id            UUID,                        -- NULL for session-scoped triggers (mirrors AttentionItem.runId?);
                                                 -- deliberately no FK: runs are daemon-local per ADR-017, so no
                                                 -- shared `runs` table exists to reference.
  attention_trigger TEXT NOT NULL                -- the wire field is AttentionItem.trigger; qualified here because
                                                 -- bare TRIGGER is a reserved word in the SQL standard and a DDL
                                                 -- keyword in Postgres (the local schema's invalidation_trigger is
                                                 -- the same precedent). The DOMAIN below is byte-identical to the
                                                 -- contract union; only the column name is qualified.
                    CHECK(attention_trigger IN ('pending_approval', 'pending_input', 'run_completed',
                                                'run_failed', 'mention')),
  severity          TEXT NOT NULL
                    CHECK(severity IN ('actionable', 'informational')),
  summary           TEXT NOT NULL,               -- derived render string (AttentionItem.summary); personal content -- see the erasure note
  source_event_id   TEXT NOT NULL,               -- canonical triggering event id; deliberately no FK (the event row is daemon-local)
  queued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at      TIMESTAMPTZ,                 -- NULL = still owed; stamped when the row goes out in a batch
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days',
  CHECK (expires_at > queued_at)
);

-- Reconnect catch-up read: the user's still-owed rows, already in delivery order.
CREATE INDEX idx_notification_queue_undelivered
  ON notification_queue (user_id, queue_sequence)
  WHERE delivered_at IS NULL;

-- Expiry purge sweep.
CREATE INDEX idx_notification_queue_expiry ON notification_queue (expires_at);
```

The `attention_trigger` and `severity` domains are byte-identical to the `AttentionItem` contract's `trigger` and `severity` unions in [api-payload-contracts.md](../contracts/api-payload-contracts.md), which ground them in [Spec-019 §Required Behavior](../../specs/019-notifications-and-attention-model.md#required-behavior)'s minimum trigger set and [Spec-019 §Default Behavior](../../specs/019-notifications-and-attention-model.md#default-behavior)'s actionable/informational split; the CHECK constraints exist so a queued row cannot carry a trigger the client has no rendering for. The column-name qualification is the only divergence from the wire shape, and it is a keyword-avoidance rename, not a domain change. `summary` is carried rather than re-derived at delivery time because the queue's entire purpose is delivery to a client that was absent when the attention state was derived.

**Delivery model (a cursor without a cursor table).** The catch-up position is the pair (`delivered_at IS NULL`, `queue_sequence`): the reconnect read selects the user's undelivered rows in `queue_sequence` order, pushes them as one batch over the [Spec-019 §Desktop-to-Desktop Delivery](../../specs/019-notifications-and-attention-model.md#desktop-to-desktop-delivery) SSE subscription, and stamps `delivered_at` on exactly the rows it pushed — so the next connect resumes where this one stopped without a stored per-user cursor row to keep in sync. `queue_sequence` rather than `queued_at` carries the order because rows inserted in one transaction share a single `now()`: timestamps tie, and a timestamp-keyed resume across a tie can skip or repeat a row. `notification_preferences` filtering happens at emit time, before a row is written ([Spec-019 §Desktop-to-Desktop Delivery](../../specs/019-notifications-and-attention-model.md#desktop-to-desktop-delivery) — non-matching events are dropped at the control plane), so the queue holds only notifications the user has already opted into and the catch-up read applies no further filter.

**Retention (7 days, then permanent deletion).** `expires_at` defaults to `queued_at + 7 days`, the one retention figure [Spec-019 §Cross-Device Delivery](../../specs/019-notifications-and-attention-model.md#cross-device-delivery) states, and the CHECK keeps it strictly after `queued_at` so a row can never be born expired. The purge sweep deletes every row past `expires_at`, delivered or not: an undelivered row is "expired and permanently deleted" by the spec's own words, and a delivered row has discharged its purpose with no stated longer-retention obligation. Deletion is permanent and leaves no tombstone — this queue is a delivery buffer, not an audit surface; the canonical event each row references stays in the emitting daemon's local log per ADR-017.

**Invariant compatibility (checked against (1)–(4) above, as this file requires of every table addition).** This table engages (1) and (2) and violates neither. It is **per-user delivery state** — which notifications one user is owed and whether each has been pushed — not a cross-user event stream: there is no session-ordered read path, no sequence shared across users, and no replay semantics (`queue_sequence` orders one user's pending batch, not a session's history). It stores **no event payload**: `source_event_id` is a reference whose row lives in the emitting daemon's local `session_events`, and `trigger` / `severity` / `summary` are the derived notification-rendering fields of the `AttentionItem` contract, produced by the attention projection rather than copied off an event. A reader of this table learns that a user was owed a notification; it cannot reconstruct the session. Invariants (3) and (4) are untouched — the daemon-local log stays authoritative and no supersession gate is engaged.

**GDPR erasure (hard-DELETE class).** `notification_queue.user_id` is `NOT NULL REFERENCES users(id)` with the default `NO ACTION`, so this table joins the [Spec-022 §Shred Fan-Out](../../specs/022-data-retention-and-gdpr.md#shred-fan-out) Path-2 `REFERENCES users(id)` closure (Plan-022 CP-022-6 ⇄ Plan-019 CP-019-1), alongside its sibling `notification_preferences`. A user erasure hard-DELETEs every row for that user — `DELETE FROM notification_queue WHERE user_id = :pid;` — and must run **before** the `DELETE FROM users` anchor, or the `NO ACTION` FK makes that parent `DELETE` fail. Hard-DELETE rather than anonymize: the row carries no audit-trail or referential obligation (the canonical event survives in the daemon-local log), and `summary` is derived personal content, so severing the FK alone would leave personal data behind. The [GDPR Manual Erasure Runbook §Path 2](../../operations/gdpr-manual-erasure-runbook.md#path-2--hard-delete--sever-postgres-rows-control-plane) is the V1 operator procedure.

---

## Observability (Plan-020)

```sql
-- Owner: Plan-020
CREATE TABLE health_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES sessions(id),
  node_id         TEXT,
  snapshot_type   TEXT NOT NULL,                  -- 'session', 'node', 'run'
  health_state    TEXT NOT NULL,
  details         JSONB NOT NULL DEFAULT '{}',
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_health_snapshots_session ON health_snapshots(session_id);
CREATE INDEX idx_health_snapshots_recorded ON health_snapshots(recorded_at);
```

---

## Event Log Anchors (Plan-006 — Integrity Witness)

The control plane stores Merkle-root **anchors** (metadata only) for per-daemon event logs; it does **not** store event payloads. This is consistent with [ADR-017 Shared Event-Sourcing Scope](../../decisions/017-shared-event-sourcing-scope.md), which rejected a shared event log for V1, and with [Security Architecture § Audit Log Integrity](../security-architecture.md#audit-log-integrity), which defines the tamper-evidence protocol. **Forward-declared:** the additive migration ships with Plan-006 T3.3 (Tier 4 Phase 3) as `packages/control-plane/src/migrations/0003-event-log-anchors.ts`, with its same-commit `MIGRATIONS`-array registration in `packages/control-plane/src/sessions/migration-runner.ts`; the DDL is pinned here so the anchor-upload write path, the verification read below, and the migration share one canonical shape. That shipment landed 2026-08-04 (PR #287) at `{ version: 3 }`; the **Forward-declared** label stays because the migration file's own header cites this block by that name as its canonical source, and its `EVENT_LOG_ANCHORS_MIGRATION_SQL` reproduces the DDL below verbatim — so any column-shape edit still lands here first per AGENTS.md doc-first ordering.

```sql
-- Owner: Plan-006 (BL-050; T3.3 additive control-plane migration)
-- Witness-only storage: Merkle roots + signatures for per-daemon local event logs.
-- Event payloads remain on the emitting daemon's local SQLite; never uploaded here.
-- V1 scope: SESSION-scoped anchors only. Node-scope (sentinel-partitioned, daemon-scope) chains
-- are witnessed locally only in V1 -- control-plane upload requires a node-identity trust anchor and
-- is a V1.1 extension (ADR-017 §Node-Scope Anchor Witnessing; Spec-006 §Daemon-Scope Event Binding).
-- The non-null session_id FK below is correct under this scope: only session-scoped anchors land here.
CREATE TABLE event_log_anchors (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID NOT NULL REFERENCES sessions(id),
  node_id           TEXT NOT NULL,                    -- emitting daemon's NodeId (roster key)
  start_sequence    BIGINT NOT NULL,                  -- first session_events.sequence in anchor range
  end_sequence      BIGINT NOT NULL,                  -- last session_events.sequence in anchor range
  merkle_root       BYTEA NOT NULL,                   -- 32 bytes; BLAKE3 Merkle root over row_hash leaves
  root_signature    BYTEA NOT NULL,                   -- 64 bytes; Ed25519 by the emitting daemon over the anchor CLAIM -- the RFC 8785 canonicalization of {endSequence, merkleRoot, nodeId, sessionId, startSequence} per Spec-006 §Anchoring Cadence (2026-08-11: coordinates signed, not merkle_root alone)
  anchored_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_sequence >= start_sequence),
  -- end_sequence is part of the key (mirrors local pending_anchor_uploads): a cadence anchor [1,1000] and a wider
  -- compaction-covering anchor [1,5000] share start_sequence=1 and MUST coexist, so the daemon's ON CONFLICT DO NOTHING
  -- upload dedups only genuine re-uploads of the identical range. "Covering anchor" at verify time is a coverage test
  -- (start_sequence <= range_start AND end_sequence >= range_end) per Spec-006 §Post-Compaction Integrity, not exact-start.
  UNIQUE(session_id, node_id, start_sequence, end_sequence)
);

CREATE INDEX idx_event_log_anchors_session ON event_log_anchors(session_id, anchored_at DESC);
CREATE INDEX idx_event_log_anchors_node ON event_log_anchors(node_id, anchored_at DESC);
```

**Verification**: an audit reader resolves the emitting daemon's Ed25519 public key by `node_id` from the [§Daemon Signing Public Keys](#daemon-signing-public-keys-plan-006--verification-key-roster) verification-key roster below and checks `root_signature` over the anchor claim — the row's coordinates and root together, per [Spec-006 §Anchoring Cadence](../../specs/006-session-event-taxonomy-and-audit-log.md#anchoring-cadence)'s 2026-08-11 amendment — so a stored row whose span or log identity was relabeled after signing fails verification rather than passing a coverage test on unsigned coordinates. V1 ships no daemon signing-key rotation ceremony — registration is register-once per `(session_id, node_id)` and a different-key registration is refused, per [Security Architecture §Per-Event Daemon Signature](../security-architecture.md#per-event-daemon-signature); validity-window resolution of superseded keys is the V1.1+ extension a specified rotation ceremony would unlock. Anchor cadence defaults (`ANCHOR_INTERVAL_EVENTS = 1000` events or `ANCHOR_INTERVAL_SECONDS = 300` seconds, whichever first) are set in [Spec-006 § Integrity Protocol](../../specs/006-session-event-taxonomy-and-audit-log.md#integrity-protocol).

---

## Daemon Signing Public Keys (Plan-006 — Verification-Key Roster)

The `NodeId`-keyed resolution surface behind [Security Architecture §Per-Event Daemon Signature](../security-architecture.md#per-event-daemon-signature): one session-scoped Ed25519 PUBLIC key per `(session, node)`, registered by the emitting daemon after a successful attach via `runtimenode.signingkeyregister` (daemon-called mutation) and resolved by verifiers via `runtimenode.signingkeyroster` (query) — both registered in the [api-payload §Signing-Key Registration Method Registry](../contracts/api-payload-contracts.md#signing-key-registration-method-registry-tier-4-plan-006-t410). **Forward-declared:** the additive migration ships with Plan-006 T4.10 (Tier 4 Phase 4, CP-006-7 leg B / CP-003-5); the DDL is pinned here so the registration service, the resolution query, and the migration share one canonical shape.

```sql
-- Owner: Plan-006 (T4.10 additive control-plane migration per CP-006-7 leg B / CP-003-5)
-- Verification keys only: the 32-byte Ed25519 PUBLIC half of the daemon's session-scoped signing
-- keypair (64-char lowercase hex on the wire, hex-decoded at persist). The private half never
-- leaves the emitting daemon (local sealed daemon_signing_keys per ADR-004; local-sqlite-schema.md).
-- Register-once: a registration presenting a DIFFERENT key for a registered (session, node) pair is
-- refused with typed runtimenode.signingkeyregister_conflict, never overwritten (the Plan-006 T4.2 refuse_on_rotation
-- mirror). An absent row = the node attached under a pre-leg-B daemon or control plane (its
-- uploaded anchors stay emitter-only-verifiable -- the honest degrade).
-- Deliberately NO user FK: key material is machine-generated and carries no personal data,
-- so this table sits outside the Spec-022 §Shred Fan-Out Path-2 REFERENCES users(id)
-- closure and SURVIVES user erasure. That durability is load-bearing, not incidental: the
-- crypto-shredded runtime_node.* event stream and the event_log_anchors rows this key verifies are
-- RETAINED post-erasure (unlike runtime_node_attachments' operational hard-DELETE disposition), so
-- the verification key must outlive the attachment that registered it.
CREATE TABLE daemon_signing_public_keys (
  session_id      UUID NOT NULL REFERENCES sessions(id),
  node_id         TEXT NOT NULL,                 -- emitting daemon's NodeId (roster key; matches event_log_anchors.node_id)
  public_key      BYTEA NOT NULL,                -- 32 bytes; Ed25519 public key
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, node_id)              -- register-once carrier: the PK is the refusal's uniqueness substrate
);
```

**Verification**: consistent with the invariants at the top of this file — a single current-state coordination/roster row per `(session, node)`, never an event log; the `runtime_node.*` lifecycle event stream stays in the daemon-local event store per ADR-017.

---

## Session Terminal Lease (Plan-024)

Per-session shared-terminal write-lease coordination record ([Spec-003 §Required Behavior](../../specs/003-runtime-node-attach.md#required-behavior), campaign B4) — the current holder only, projected by the `runtimenode.roster` join as `RuntimeNodeRosterResponse.controlHolder`. **Forward-declared:** the additive migration ships with the Plan-024 Phase 3B lease leg (campaign B16); the DDL is pinned here so the roster projection, the erasure fan-out, and the Phase 3B migration share one canonical shape. Invariant-compliant by construction: a single current-state row per session (same coordination tier as `runtime_node_presence`), never an event log — the `pty.control_changed` transition stream stays in the daemon-local event store per ADR-017.

**Deliberately absent (2026-08-03 projection-conformance amendment): no lease-expiry or authority-epoch column.** A time-bounded lease with an authority-issued fence is the correct shape when the _control plane_ is the lease authority; in V1 it is not ([Spec-003 §Required Behavior](../../specs/003-runtime-node-attach.md#required-behavior) makes the terminal-owning daemon the sole authority). Server-owned columns here would make the control plane a **second writer** on this row, contradicting the single-producer write model below, its no-cross-writer-lock-ordering property, and ADR-017's daemon-local transition stream — and they would fence the record rather than the terminal, since enforcement lives on the holder's own machine. The time-bounded design belongs with the future relay-borne remote-take leg Spec-003's forward constraint names, which ships its own additive migration when that write leg lands; dormant columns are not added ahead of it.

```sql
-- Owner: Plan-024 (Phase 3B / campaign B16 ships the additive migration)
CREATE TABLE session_terminal_leases (
  session_id            UUID PRIMARY KEY REFERENCES sessions(id),
  holder_user_id UUID REFERENCES users(id) ON DELETE SET NULL,  -- NULL = lease free (writes refused; Spec-003 null-holder-refuses-writes)
  node_id               TEXT NOT NULL,     -- producing terminal-owning node: binds the row to its single producer; re-binds only when that node stops being a live terminal host — its attachment leaves the active set (explicit detach) OR its runtime_node_presence.health_state reads offline (api-payload leaseupdate contract)
  transition_seq        BIGINT NOT NULL,   -- daemon-owned strictly-increasing per session (persisted daemon-side across restarts); stale transport retries compare lower and are discarded
  transitioned_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_session_terminal_leases_holder ON session_terminal_leases(holder_user_id);
```

**Write model (single producer).** The terminal-owning daemon is the sole lease authority ([Spec-003 §Required Behavior](../../specs/003-runtime-node-attach.md#required-behavior)): it adjudicates every take/release and publishes each transition to the control plane via the `runtimenode.leaseupdate` projection-sync mutation ([api-payload-contracts §Session Terminal-Control Method Registry](../contracts/api-payload-contracts.md#session-terminal-control-method-registry-tier-3-campaign-b4)); the control plane persists what the daemon publishes through a **producer-bound, monotonic conditional upsert** carrying the api-payload contract's **caller-authorization** predicates **inside** the write statement rather than in a preceding probe (active attachment for `(node_id, session_id)` owned by the verified caller), so the form is `INSERT … SELECT … WHERE EXISTS (…) ON CONFLICT (session_id) DO UPDATE … WHERE ((session_terminal_leases.node_id = EXCLUDED.node_id AND session_terminal_leases.transition_seq < EXCLUDED.transition_seq) OR (session_terminal_leases.node_id <> EXCLUDED.node_id AND <recorded-producer-departed>)) AND EXISTS (…)` — the authorization `EXISTS` repeated on **both** arms, because `ON CONFLICT … DO UPDATE … WHERE` is evaluated only on conflict and a bare `VALUES` insert would bypass it against an absent row (same producer ⇒ the sequence must increase — an equal-or-lower retry is acknowledged and discarded; an authorized producer re-bind re-baselines the sequence). The **producer re-bind** condition rides **inside** that statement (2026-08-03 amendment, closing a review-found TOCTOU): `<recorded-producer-departed>` is the departure disjunction over the row's **recorded** producer — `NOT EXISTS` an active `runtime_node_attachments` row for `(session_terminal_leases.node_id, session_id)`, `OR EXISTS` a `runtime_node_presence` row for it reading `offline` — so a different node is accepted only when the recorded producer has stopped being a live terminal host, evaluated **under the conflicting row's lock in the same statement as the write**, never in a preceding probe. A probe-then-write split here is exploitable in both directions: two replacement nodes that both observed the producer offline would both pass the probe and each overwrite the other (the second write must instead re-evaluate against the first's committed re-bind and refuse, because the new recorded producer is live), and a returning former producer's delayed publish would overwrite its successor (it must instead be refused on the different-node arm while the successor is live). With the predicate in the statement both races serialize on the lease row's conflict lock and re-evaluate against the current row, so exactly one recorded producer survives any interleaving. A zero-row result is therefore ambiguous across all three refusal causes — stale `transition_seq` (acknowledged and discarded), failed caller authorization, refused re-bind — and needs in-transaction classification (re-read and distinguish; never collapse them). Because exactly one daemon owns a session's terminal, writes to a given row are serialized at the producer — no cross-writer lock ordering exists on this table, and the `runtime_node_attachments` / `runtime_node_presence` facts the predicates consult are **read, never written** (each an `EXISTS` inside the single write statement — one snapshot, no lock taken on those tables), so this table registers no entry in [§Lock Ordering Across Shared Tables](#lock-ordering-across-shared-tables) below; the `node_id` binding and monotonic `transition_seq` make that single-producer assumption enforced rather than assumed (a stale delivery or a non-owning attached node's daemon cannot overwrite the projection — campaign B4 round 6). The holder is cleared by the daemon-published auto-releases (holder liveness/attachment drop; holder authorization loss — device revocation; and the agent-run write-burst release on the acquiring run's first lifecycle transition out of `running` — `auto_released_run_idle`, `Spec-003 §Required Behavior` Part-A completion 2026-07-16), and `idx_session_terminal_leases_holder` serves exactly the three holder-keyed sweeps: liveness-drop clear, authorization-loss clear, and the erasure selector below (the run-idle release needs no holder-keyed sweep — the daemon resolves it through the acquiring-run tag on its daemon-local lease record — re-bound on each agent-path acquisition, so it names the most recent acquiring run — never a `holder_user_id` lookup). The roster's `controlHolder` is not a byte-mirror of this column: the read resolves it to null while the row's `node_id` carries `runtime_node_presence.health_state = 'offline'` — a read-time predicate over the verdict Plan-003's heartbeat sweep already derived, writing nothing, so the read-side surface stays honest during the window in which no successor host has exercised the `offline` re-bind disjunct above ([api-payload §Session Terminal-Control Method Registry](../contracts/api-payload-contracts.md#session-terminal-control-method-registry-tier-3-campaign-b4), Codex PR #283 rounds 2-3).

**GDPR erasure (anonymize via `ON DELETE SET NULL` — the sixth anonymize-class FK).** `holder_user_id` is born nullable + `ON DELETE SET NULL` at its Phase 3B build (no ALTER — the table does not exist before that migration, the same born-correct pattern as `artifact_relay_blobs.publisher_user_id`). A user hard-DELETE auto-nulls the holder, converging on the correct lease semantics — the lease frees (null-holder-refuses-writes, fail-closed) while the row survives as session coordination state. **Ordering (the daemon stays the sole lease authority):** this projection row never changes without the daemon's `pty.control_changed` broadcast, so the documented erasure flow revokes the user's devices and node attachments **before** the `DELETE` — the authorization-loss force-clear has then already freed the lease daemon-side and published the transition, and the `SET NULL` fires on an already-`NULL` holder as a DB-side idempotent backstop (the [GDPR Manual Erasure Runbook](../../operations/gdpr-manual-erasure-runbook.md) Precondition carries the operator check; an out-of-flow direct DELETE still converges to the same fail-closed lease-free state but bypasses the broadcast — exactly why the ordering is required, never the primary transition). Canonical dispositions: [Spec-022 §Shred Fan-Out](../../specs/022-data-retention-and-gdpr.md#shred-fan-out); operator verification in the [GDPR Manual Erasure Runbook](../../operations/gdpr-manual-erasure-runbook.md).

---

## Lock Ordering Across Shared Tables

This is the canonical home for row-lock ordering over the tables above. Every control-plane transaction that takes row locks on more than one table in this schema acquires them in the order recorded here, in the modes recorded here. A transaction MAY skip a level it does not need — skipping is order-consistent and creates no cycle — but it MUST NOT reorder one. A plan whose ceremony locks only its **own** uncontested tables registers that internal order here as well, so there is exactly one place to read a lock order rather than one per plan.

### The contested chain

```
sessions → runtime_node_attachments → daemon_signing_public_keys
```

The chain is the **union across registrants**, not any single registrant's own path: no registrant takes all three levels, and each row below names the levels it actually instantiates.

| Level | Table | Mode | Why this is the weakest sufficient mode |
| --- | --- | --- | --- |
| 1 | `sessions` | `FOR KEY SHARE` where only the row's existence and its never-changing `owner_user_id` are needed; `FOR SHARE` where the transaction must serialize against a `min_client_version` floor change | `FOR KEY SHARE` blocks a `DELETE` or a key-changing `UPDATE`, which is the whole existence guarantee an ownership read needs, and it is the mode the attachment upsert's own foreign key takes implicitly, so no lock upgrade occurs. It does **not** conflict with the `FOR NO KEY UPDATE` a floor-raising `UPDATE sessions SET min_client_version = …` acquires — acceptable only where the floor verdict is **derived at read time and never persisted**. A surface that needs the floor authoritative-at-write takes `FOR SHARE` instead ([ADR-025 §D8](../../decisions/025-runtime-node-control-plane-caller-authorization.md#d8--locking-discipline-one-canonical-order-weakest-sufficient-mode-two-phase-resolve-for-nodeid-keyed-procedures)) |
| 2 | `runtime_node_attachments` | `FOR NO KEY UPDATE` on mutator paths; `FOR SHARE` on read-only authorization | The mutators update `state` / `capabilities` / `client_version`. `state` sits only in a **partial** unique index, and PostgreSQL excludes partial and expressional indexes from the `FOR UPDATE`-escalation column set, so those updates take `FOR NO KEY UPDATE` natively and matching that mode is sufficient. It conflicts with a concurrent detach, with the other mutators, and with an erasure `DELETE` (which takes `FOR UPDATE`). The read-only arm belongs to a transaction whose own mutation targets a table outside this chain |
| 3 | `daemon_signing_public_keys` | No explicit row-lock mode — the register-once write is `INSERT … ON CONFLICT DO NOTHING` with in-transaction classification, so the primary key `(session_id, node_id)` is the serialization point and a raw `23505` is never raised | The row is written once and never updated, so there is no read-then-write to protect; the only concurrency to resolve is two registrations racing for the same pair, which the conflict already settles |

### Registrants

| Registrant | Levels | Per-transaction detail |
| --- | --- | --- |
| Runtime-node mutators — `attach`, `heartbeat`, `capabilityupdate`, `detach` (Plan-003 I-003-6, ratified by [ADR-025 §D8](../../decisions/025-runtime-node-control-plane-caller-authorization.md#d8--locking-discipline-one-canonical-order-weakest-sufficient-mode-two-phase-resolve-for-nodeid-keyed-procedures)) | 1 → 2 | `attach` takes level 1 `FOR KEY SHARE`; `capabilityupdate` takes it `FOR SHARE`, because its `VERSION_FLOOR_EXCEEDED` write-admission gate needs the floor authoritative-at-write; `heartbeat` and `detach` read no floor and take `FOR KEY SHARE`. At level 2 the mutator paths (`capabilityupdate`, `detach`) take `FOR NO KEY UPDATE` and `heartbeat` takes `FOR SHARE`, its own mutation targeting `runtime_node_presence`, which is outside this chain. **Two-phase resolve is mandatory** for the procedures keyed on `nodeId` alone (`heartbeat`, `capabilityupdate`, `detach`): an unlocked pre-read yielding a `(session_id, user_id)` snapshot that authorizes nothing, then the locks in chain order, then a **re-verify** of the locked row against that snapshot, failing closed on mismatch. Taking level 2 first to learn the session would invert the levels and deadlock ABBA against `attach` |
| Signing-key registration — `runtimenode.signingkeyregister` (Plan-006 T4.10) | 1 → 3 | Holds `sessions` `FOR SHARE` — registration is a version-sensitive domain write, so the floor must be authoritative-at-write — and writes level 3 through the register-once conflict. It instantiates **no** level-2 acquisition: the 2026-08-11 admission-time registration decoupling removed it, because no attachment row exists at admission time to read |
| WebAuthn ceremony verification (Plan-018 I-018-19) | `webauthn_challenges` → `webauthn_credentials` | A plan's own uncontested pair, registered here rather than in that plan alone. The challenge is consumed by a single `DELETE … RETURNING` (the single-use fence); the same transaction then takes `webauthn_credentials` `FOR UPDATE` before reading the stored signature counter and commits the advance conditionally on the presented value exceeding it. An unlocked read-then-write is defeated by exactly the cloned-authenticator replay the counter exists to detect: two concurrent replays each read the pre-existing value and each find the presented counter greater |

### Tables that deliberately register nothing

`session_terminal_leases` has one writer per row by construction (the terminal-owning daemon is the sole lease authority), and the `runtime_node_attachments` / `runtime_node_presence` facts its write predicates consult are read inside the single write statement and never written, so it takes no lock on this chain and registers no entry. The local-SQLite `command_receipts` and `mcp_*` tables register nothing here either: every registrant above locks control-plane Postgres rows, while those are daemon-local tables whose single-writer transactions cannot deadlock across plans.

---

## Schema Migrations

```sql
CREATE TABLE schema_migrations (
  version         INTEGER NOT NULL PRIMARY KEY,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  description     TEXT
);

INSERT INTO schema_migrations (version, description)
VALUES (1, 'Initial schema');
```

### Advisory Lock ID Registry

Postgres `pg_advisory_xact_lock(bigint)` IDs share a single per-database namespace; two callers using the same ID silently serialize against each other. To prevent silent collisions across plans, every advisory-lock caller MUST allocate a distinct ID below before merging.

| ID | Owner | Purpose |
| --- | --- | --- |
| `9_000_000_001` | Plan-001 control-plane | `MIGRATION_LOCK_ID` — serializes the lock-and-re-probe block in `applyMigrations` (concurrent boots). |

**Reserved bands.** `9_000_000_000`–`9_000_000_999` is reserved for control-plane schema-coordination locks (migration runners and similar boot-path serialization). Plans that need cross-replica coordination locks for runtime concerns (e.g. session-directory housekeeping, dispatch coordination) SHOULD allocate above `9_001_000_000` to keep the schema-coordination band contiguous and reviewable. Plan-016 / Plan-021 / Plan-027 do not currently allocate any advisory-lock IDs; if a future iteration adds one, append a row above before opening the PR.
