# Shared Postgres Schema

Canonical schema for the collaboration control plane's shared Postgres database.

**Storage boundary:** Shared session metadata, invites, memberships, presence history, session directory, and cross-node coordination records. See [Data Architecture](../data-architecture.md).

---

## Invariant — No Shared Session-Event Table in V1 (ADR-017)

Per [ADR-017: Shared Event-Sourcing Scope](../../decisions/017-shared-event-sourcing-scope.md), this schema declares the following invariants that constrain all downstream table additions:

1. **Coordination records only.** Shared Postgres stores session metadata, memberships, invites, presence history, runtime-node attachments, session-directory entries, relay-connection records, notification preferences, health snapshots, event-log anchors (Merkle-root witnesses, not event payloads), and cross-node dispatch coordination rows. It does **not** store event payloads.
2. **No `session_events_shared`, `session_events_global`, or equivalent cross-participant event table exists in V1.** The absence is intentional, not an oversight. Grepping this file for `session_events_shared` must return this invariant note — never a table definition. Proposals to add one are out of V1 scope.
3. **Per-daemon local `session_events` is authoritative** per ADR-017 and [local-sqlite-schema.md](./local-sqlite-schema.md). Each daemon owns its own event log with its own monotonic sequence number; cross-participant audit is federated via log export and merge per [Data Architecture §Federated audit model](../data-architecture.md#event-sourcing-scope).
4. **Supersession gates.** Introducing a shared session-event table requires (a) an ADR superseding ADR-017, and (b) completion of the MLS promotion gates named in [ADR-010 §MLS Promotion Criteria](../../decisions/010-paseto-webauthn-mls-auth.md) — audit visibility, interop tests, and the 4-week soak requirement — because a shared event table is meaningful only if payload-level privacy is carried by group-keyed encryption rather than per-pair PASETO wrapping.

These invariants apply to every subsequent `CREATE TABLE` in this schema. Downstream authors extending this file must check compatibility with (1)–(4) before introducing a table whose name or semantics could read as a shared event log. Event-log anchors (see below under `event_log_anchors`) are deliberately metadata-only witnesses and do **not** violate (2).

---

## Participants Identity Anchor (Plan-001)

**Migration-order invariant:** Plan-001's first shared Postgres migration creates the minimal `participants` identity-anchor row shape below, **before** any FK-bearing shared table is created. This is required because `session_memberships.participant_id`, `session_invites.inviter_id`, and `runtime_node_attachments.participant_id` all `REFERENCES participants(id)`, and Plan-001/002/003 execute before Plan-018 per [cross-plan-dependencies.md](../cross-plan-dependencies.md). Plan-018 extends this anchor with identity/profile columns and side tables via additive ALTER migrations — see [Participants and Identity (Plan-018)](#participants-and-identity-plan-018) below.

```sql
-- Owner: Plan-001 (minimal identity anchor for FK resolution)
-- Extended by: Plan-018 (identity/profile columns via ALTER TABLE — see below)
CREATE TABLE participants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The anchor contains only the stable, non-PII fields needed for referential integrity. Plan-018 adds identity-specific columns (`display_name`, `identity_ref`, `metadata`) and the `identity_mappings` side table. No participant rows are inserted before Plan-018's registration flow lands — the anchor table exists only so FK constraints in Plan-001/002/003 tables can be declared at migration time.

---

## Sessions and Membership (Plan-001, Plan-002)

```sql
-- Owner: Plan-001
CREATE TABLE sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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

-- Owner: Plan-001 | Extended by: Plan-002 (invite-driven membership flows)
CREATE TABLE session_memberships (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES sessions(id),
  participant_id  UUID NOT NULL REFERENCES participants(id),  -- born NOT NULL; relaxed to nullable + ON DELETE SET NULL by D-022-7 migration (see GDPR erasure note below)
  role            TEXT NOT NULL DEFAULT 'viewer'
                  CHECK(role IN ('owner', 'viewer', 'collaborator', 'runtime contributor')),
  state           TEXT NOT NULL DEFAULT 'pending'
                  CHECK(state IN ('pending', 'active', 'suspended', 'revoked')),
  joined_at       TIMESTAMPTZ,                   -- set when state becomes 'active'
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(session_id, participant_id)
);

CREATE INDEX idx_session_memberships_session ON session_memberships(session_id);
CREATE INDEX idx_session_memberships_participant ON session_memberships(participant_id);
```

## Session Invites (Plan-002)

```sql
-- Owner: Plan-002
CREATE TABLE session_invites (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES sessions(id),
  inviter_id      UUID NOT NULL REFERENCES participants(id),  -- born NOT NULL; relaxed to nullable + ON DELETE SET NULL by D-022-7 migration (see GDPR erasure note below)
  token_hash      TEXT NOT NULL UNIQUE,          -- hashed invite token (never store plaintext)
  join_mode       TEXT NOT NULL DEFAULT 'viewer'
                  CHECK(join_mode IN ('viewer', 'collaborator', 'runtime contributor')),
  state           TEXT NOT NULL DEFAULT 'pending'
                  CHECK(state IN ('pending', 'accepted', 'expired', 'revoked')),
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_session_invites_session ON session_invites(session_id);
CREATE INDEX idx_session_invites_state ON session_invites(state) WHERE state = 'pending';
```

**GDPR erasure (the two in-V1 anonymize-class FKs).** `session_memberships.participant_id` and `session_invites.inviter_id` are born `NOT NULL REFERENCES participants(id)` by their owners (Plan-001 / Plan-002) and relaxed to nullable + `ON DELETE SET NULL` by [Plan-022's D-022-7 / T22.5.2 control-plane migration](../../plans/022-data-retention-and-gdpr.md#ratified-design-decisions-tier-5-audit-2026-05-30) — a forward ALTER over the shipped owner tables (unlike the `revoked_*` FKs below, which are born in their final `ON DELETE SET NULL` shape at the BL-070 build). A participant hard-DELETE then severs the data-subject link DB-side rather than failing the parent `DELETE FROM participants` or deleting the surviving membership / invite row; `NULL` participant ids are non-equal under `session_memberships`'s `UNIQUE(session_id, participant_id)`, so erasing two participants in the same session is safe. Canonical: [Spec-022 §Shred Fan-Out FK-safety](../../specs/022-data-retention-and-gdpr.md#shred-fan-out), [Plan-022 D-022-7](../../plans/022-data-retention-and-gdpr.md#ratified-design-decisions-tier-5-audit-2026-05-30); the [GDPR Manual Erasure Runbook](../../operations/gdpr-manual-erasure-runbook.md) verifies `confdeltype = 'n'` on both before the irreversible Path-1 shred.

---

## Participants and Identity (Plan-018)

Plan-018 extends the [Plan-001 Participants Identity Anchor](#participants-identity-anchor-plan-001) with identity/profile columns via additive ALTER migrations, and adds the `identity_mappings` side table. The base `participants(id, created_at)` table is already present from Plan-001's first migration — Plan-018 does not re-create it.

```sql
-- Owner: Plan-018 (additive extension of the Plan-001 participants anchor)
-- Strategy: add columns as NULL-able, backfill from Plan-018 registration flow, then
-- ALTER COLUMN ... SET NOT NULL in a follow-up migration once backfill completes.
ALTER TABLE participants
  ADD COLUMN display_name TEXT,                  -- set NOT NULL after backfill
  ADD COLUMN identity_ref TEXT UNIQUE,           -- synthetic primary ref (PASETO kid / minted handle), NOT a {provider}:{external_id} projection — Plan-018 D-018-2; set NOT NULL after backfill
  ADD COLUMN metadata     JSONB NOT NULL DEFAULT '{}';

CREATE INDEX idx_participants_identity ON participants(identity_ref);

-- Owner: Plan-018
CREATE TABLE identity_mappings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id  UUID NOT NULL REFERENCES participants(id),
  provider        TEXT NOT NULL,                 -- e.g. 'github', 'google', 'email'
  external_id     TEXT NOT NULL,                 -- provider-specific ID
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, external_id)
);

CREATE INDEX idx_identity_mappings_participant ON identity_mappings(participant_id);
```

**`identity_ref` is a synthetic primary ref, not a provider projection (Plan-018 D-018-2).** It is a stable identifier decoupled from any single external provider — a PASETO `kid` or an internally minted synthetic handle — so a participant who links a second provider keeps one `identity_ref` and gains a second `identity_mappings` row, rather than colliding on the `identity_ref UNIQUE` constraint that a denormalized `{provider}:{external_id}` value would force. The per-provider `{provider, external_id}` tuples live in `identity_mappings`; `identity_ref` is the join-stable participant anchor those mappings resolve to.

---

## Token Revocation (BL-070 — Auth Infrastructure)

Backs `POST /auth/revoke-all-for-participant` (see [security-architecture.md §Bulk Revoke All For Participant](../security-architecture.md#bulk-revoke-all-for-participant-bl-070)). Cross-plan auth infrastructure, not Plan-018 identity schema.

```sql
-- Owner: BL-070
CREATE TABLE revoked_jtis (
  jti              TEXT PRIMARY KEY,
  participant_id   UUID REFERENCES participants(id) ON DELETE SET NULL,  -- nullable + SET NULL on erasure (Plan-022 D-022-7)
  family_id        UUID NOT NULL,                 -- refresh-token rotation family
  revoked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason           TEXT NOT NULL
                   CHECK(reason IN ('account_compromise', 'password_reset', 'admin_action', 'self_service')),
  expires_at       TIMESTAMPTZ NOT NULL            -- aligns with the revoked token's natural expiry
);

CREATE INDEX idx_revoked_jtis_participant ON revoked_jtis(participant_id);
CREATE INDEX idx_revoked_jtis_family ON revoked_jtis(family_id);
CREATE INDEX idx_revoked_jtis_expires ON revoked_jtis(expires_at);

-- Owner: BL-070
CREATE TABLE revoked_token_families (
  family_id        UUID PRIMARY KEY,
  participant_id   UUID REFERENCES participants(id) ON DELETE SET NULL,  -- nullable + SET NULL on erasure (Plan-022 D-022-7)
  revoked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason           TEXT NOT NULL
                   CHECK(reason IN ('account_compromise', 'password_reset', 'admin_action', 'self_service'))
);

CREATE INDEX idx_revoked_families_participant ON revoked_token_families(participant_id);
```

**GDPR erasure.** `participant_id` is nullable + `ON DELETE SET NULL` by design — born this way at BL-070's post-V1 build (no migration; these tables build already in their final FK shape). A participant hard-DELETE severs the data-subject link, while the denylist key (`jti` / `family_id`, the PRIMARY KEY — **not** `participant_id`) survives to its natural `expires_at + 24h` reap, so erasure cannot resurrect a revoked token within its validity window (the GDPR Art. 17(3) security carve-out). Canonical: [Plan-022 D-022-7](../../plans/022-data-retention-and-gdpr.md#ratified-design-decisions-tier-5-audit-2026-05-30), [Spec-022 §Shred Fan-Out](../../specs/022-data-retention-and-gdpr.md#shred-fan-out); the [GDPR Manual Erasure Runbook](../../operations/gdpr-manual-erasure-runbook.md) is the V1 operator procedure.

**Retention:** Rows are reaped after `expires_at + 24h` safety margin. The 7-day refresh-token TTL (see [security-architecture.md §Token revocation](../security-architecture.md#token-revocation)) bounds the total row count — worst case is roughly `7 days × daily-active refresh tokens per participant`.

**Multi-region propagation:** The control plane writes a revocation row to the local region, then propagates via Postgres logical replication (publication/subscription) to peer regions. Propagation is best-effort and eventually consistent; see [security-architecture.md §Bulk Revoke All For Participant](../security-architecture.md#bulk-revoke-all-for-participant-bl-070) for the eventual-consistency window analysis.

---

## Runtime Node Attachments (Plan-003)

```sql
-- Owner: Plan-003
CREATE TABLE runtime_node_attachments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES sessions(id),
  participant_id  UUID NOT NULL REFERENCES participants(id),
  node_id         TEXT NOT NULL,                 -- daemon-assigned node identifier
  capabilities    JSONB NOT NULL DEFAULT '{}',   -- declared capabilities
  client_version  TEXT NOT NULL,                 -- daemon semver "MAJOR.MINOR" at attach; floor-compared vs sessions.min_client_version (ADR-018 §Decision #4) — makes the read-only verdict auditable + roster-displayable
  state           TEXT NOT NULL DEFAULT 'registering'
                  CHECK(state IN ('registering', 'online', 'degraded', 'offline', 'revoked')),
  attached_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_node_attachments_session ON runtime_node_attachments(session_id);
CREATE INDEX idx_node_attachments_participant ON runtime_node_attachments(participant_id);
CREATE UNIQUE INDEX idx_node_attachments_node ON runtime_node_attachments(node_id, session_id);
-- One-active-session enforcement (Plan-003 I-003-5; Spec-003 line 114 — "one active session at a time in v1"):
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

## Session Directory and Relay (Plan-008)

```sql
-- Owner: Plan-008
CREATE TABLE session_directory (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES sessions(id) UNIQUE,
  relay_endpoint  TEXT,                          -- WebSocket URL for relay
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Owner: Plan-008
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

-- Owner: Plan-008
-- Durable cross-session ephemeral-key reuse guard (I-008-7c, Spec-008:179). Each participant
-- mints a fresh ephemeral X25519 key pair per session (I-008-6), and the per-session relay
-- Durable Object discards its bundles on close — so a key reused in a *later* session can only
-- be detected against a store that OUTLIVES the session. This control-plane table is that store
-- (OD-008r-2, Tier-5 readiness audit). The PK on the public key is the DB-level uniqueness index that
-- makes a duplicate INSERT of a key a constraint violation; the broker's admission logic reads the
-- stored session_id before deciding — rejecting a CROSS-session reuse with relay.bundle_rejected
-- (Spec-008:179) and treating a SAME-session re-presentation as an idempotent admit ONLY for the
-- participant that first claimed the key (Spec-008:130 reconnect-resume; a different participant is
-- rejected). That original-claimant check is broker live-layer logic against the in-memory admission
-- record (fail-closed when absent → client re-mints) — this table stays the cross-session
-- (key → first session_id) backstop, never a claimant store. The audit ratifies that
-- the store is durable + uniqueness-indexed and
-- that its retention is — by design — the FULL single-use horizon: Spec-008:179 requires a
-- reused key to be rejected across ALL distinct sessions, so any pruning that drops a
-- still-rejectable key would re-admit it on re-insert — a literal invariant violation — and
-- therefore V1 prunes nothing. Full-horizon retention is the correct terminal design here, not
-- a placeholder to be optimized later: the ephemeral public key is a CLIENT-chosen value with no
-- server-anchored birth time except its first appearance in this table, so a freshness/TTL window
-- cannot bound the store — a client reusing a key re-presents it under a fresh timestamp that a
-- time-windowed store would have forgotten and would wrongly re-admit. (This is why the TLS 1.3
-- 0-RTT anti-replay window does NOT transfer: that window binds a SERVER-issued ticket age the
-- peer cannot re-stamp — RFC 8446 §8 — whereas here the dedup key is client-minted.) Remembering
-- every key is therefore irreducible, not lazy. The table is bounded by historical
-- (session × participant) ephemeral-key count, not by traffic volume (~64 bytes/row — trivial at
-- desktop-runtime scale); at hosted scale its growth is an ops concern (time-partition the table,
-- keeping every partition queryable — never DROP, which would re-admit a pruned key) decoupled
-- from the security property. Bounding retention would weaken Spec-008:179's forward-secrecy
-- guarantee and is therefore a separate Spec-008 Type-2 decision, not a code-level optimization.
CREATE TABLE relay_seen_ephemeral_keys (
  ephemeral_x25519_public BYTEA PRIMARY KEY,     -- 32-byte X25519 public key; PK = global single-use index
  session_id              UUID NOT NULL REFERENCES sessions(id),  -- the session that first claimed this key
  seen_at                 TIMESTAMPTZ NOT NULL DEFAULT now()      -- first-seen audit anchor (full-horizon retention by design; see comment above)
);

CREATE INDEX idx_relay_seen_ephemeral_keys_session ON relay_seen_ephemeral_keys(session_id);
```

---

## Rate Limiting Tables (Plan-021)

Admin bans (`admin_bans`) are shared by both deployments. Escalation state (`rate_limit_escalations`) is self-host only; hosted deployments use Cloudflare Durable Objects (`RateLimitEscalationDO`) for in-memory escalation counters and persist nothing in Postgres for that path.

```sql
-- Owner: Plan-021
CREATE TABLE admin_bans (
  ban_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity        TEXT NOT NULL,
  identity_type   TEXT NOT NULL
                  CHECK(identity_type IN ('participant', 'ip', 'token_hash')),
  issued_by       TEXT NOT NULL,                  -- ParticipantId of issuing admin (operator-scope, stored as text)
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason          TEXT,
  expires_at      TIMESTAMPTZ,                    -- NULL = permanent
  revoked_at      TIMESTAMPTZ,
  revoked_by      TEXT                            -- ParticipantId of revoking admin
);

-- One-active-ban enforcement: partial UNIQUE applies only to non-revoked rows.
CREATE UNIQUE INDEX idx_admin_bans_one_active
  ON admin_bans (identity, identity_type)
  WHERE revoked_at IS NULL;

-- Hot read path: covers ban-check query (active, non-expired).
CREATE INDEX idx_admin_bans_lookup
  ON admin_bans (identity, identity_type)
  WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now());

-- Owner: Plan-021 (self-host only; hosted uses RateLimitEscalationDO)
CREATE TABLE rate_limit_escalations (
  identity             TEXT NOT NULL,
  identity_type        TEXT NOT NULL,
  violation_count      INTEGER NOT NULL DEFAULT 0,
  first_violation_at   TIMESTAMPTZ,
  last_violation_at    TIMESTAMPTZ,
  active_block_until   TIMESTAMPTZ,
  PRIMARY KEY (identity, identity_type)
);
```

---

## Cross-Node Dispatch Coordination (Plan-027)

Routing metadata only. The control plane never stores dispatch payloads, ApprovalRecord envelopes, PASETO tokens, action payloads, or result payloads; those remain daemon-local per ADR-017 and Spec-024.

```sql
-- Owner: Plan-027
CREATE TABLE cross_node_dispatch_coordination (
  dispatch_id           UUID PRIMARY KEY,
  session_id            UUID NOT NULL REFERENCES sessions(id),
  caller_participant_id UUID NOT NULL REFERENCES participants(id),
  target_participant_id UUID NOT NULL REFERENCES participants(id),
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

**GDPR erasure (hard-DELETE class).** `cross_node_dispatch_coordination` has **no `participant_id` column**; it references the participant as both `caller_participant_id` and `target_participant_id`, each `NOT NULL REFERENCES participants(id)` with the default `NO ACTION`. A participant erasure therefore hard-DELETEs every row where the participant is caller **or** target — `DELETE FROM cross_node_dispatch_coordination WHERE caller_participant_id = :pid OR target_participant_id = :pid;` — and must run **before** the `DELETE FROM participants` anchor, or the two `NO ACTION` FKs make that parent `DELETE` fail. This row is routing metadata only (the dispatch payload, capability token, and `ApprovalRecord` are never stored here), so it is hard-DELETE, not anonymize. Canonical: [Spec-022 §Shred Fan-Out](../../specs/022-data-retention-and-gdpr.md#shred-fan-out); the [GDPR Manual Erasure Runbook §Path 2](../../operations/gdpr-manual-erasure-runbook.md#path-2--hard-delete--sever-postgres-rows-control-plane) is the V1 operator procedure.

---

## Notification Preferences (Plan-019)

```sql
-- Owner: Plan-019
CREATE TABLE notification_preferences (
  participant_id    UUID NOT NULL REFERENCES participants(id),
  preference_key    TEXT NOT NULL,               -- e.g. 'approval_required', 'run_failed'
  preference_value  JSONB NOT NULL DEFAULT '{}', -- channel, threshold, mute settings
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (participant_id, preference_key)
);
```

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

The control plane stores Merkle-root **anchors** (metadata only) for per-daemon event logs; it does **not** store event payloads. This is consistent with [ADR-017 Shared Event-Sourcing Scope](../../decisions/017-shared-event-sourcing-scope.md), which rejected a shared event log for V1, and with [Security Architecture § Audit Log Integrity](../security-architecture.md#audit-log-integrity), which defines the tamper-evidence protocol.

```sql
-- Owner: Plan-006 (BL-050)
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
  root_signature    BYTEA NOT NULL,                   -- 64 bytes; Ed25519 signature over merkle_root by emitting daemon
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

**Verification**: an audit reader resolves the emitting daemon's Ed25519 public key from the session participant roster (keyed by `node_id` with validity windows for rotation per [ADR-010](../../decisions/010-paseto-webauthn-mls-auth.md)) and checks `root_signature` against `merkle_root`. Anchor cadence defaults (`ANCHOR_INTERVAL_EVENTS = 1000` events or `ANCHOR_INTERVAL_SECONDS = 300` seconds, whichever first) are set in [Spec-006 § Integrity Protocol](../../specs/006-session-event-taxonomy-and-audit-log.md#integrity-protocol).

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
