# Shared Postgres Schema

Canonical schema for the collaboration control plane's shared Postgres database.

**Storage boundary:** Shared session metadata, invites, memberships, presence history, session directory, channel-directory rows (minimal channel existence/lifecycle metadata published by the owning daemons — never message content; see [Session Channel Directory (Plan-002)](#session-channel-directory-plan-002)), cross-node coordination records, and artifact-relay blob-store coordination state (blob metadata + per-`(participant, node)` wrapped content keys; the ciphertext chunk bytes themselves live in the deployment's object store, never in Postgres — [Spec-014 §Cross-Node Artifact Relay (V1)](../../specs/014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1)). See [Data Architecture](../data-architecture.md).

---

## Invariant — No Shared Session-Event Table in V1 (ADR-017)

Per [ADR-017: Shared Event-Sourcing Scope](../../decisions/017-shared-event-sourcing-scope.md), this schema declares the following invariants that constrain all downstream table additions:

1. **Coordination records only.** Shared Postgres stores session metadata, memberships, invites, presence history, runtime-node attachments, session-directory entries, relay-connection records, notification preferences, queued per-participant notification-delivery records (derived notification-rendering fields plus a reference to the canonical triggering event — never the event payload), health snapshots, event-log anchors (Merkle-root witnesses, not event payloads), cross-node dispatch coordination rows, session terminal-lease coordination rows (current holder only — the `pty.control_changed` event stream stays daemon-local), daemon signing-key verification-roster rows (session-scoped Ed25519 PUBLIC keys only — the private halves stay sealed in daemon-local SQLite per ADR-004, and the `runtime_node.*` lifecycle event stream stays daemon-local), channel-directory rows (minimal channel existence/lifecycle metadata each owning daemon publishes per [Spec-016 §Interfaces And Contracts](../../specs/016-multi-agent-channels-and-orchestration.md#interfaces-and-contracts) D-016-22 — id, name, state, kind, member pair, and origin-ordering keys; a fold projection of the daemon-local `channel.*` event stream, never the events themselves and never message content), and artifact-relay blob-store coordination rows (blob metadata + per-participant wrapped CEKs — ciphertext key envelopes and delivery/lease state, never event payloads and never the chunk bytes, which live in the deployment's object store). It does **not** store event payloads.
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

**GDPR erasure (the two forward-ALTER anonymize-class FKs).** `session_memberships.participant_id` and `session_invites.inviter_id` are born `NOT NULL REFERENCES participants(id)` by their owners (Plan-001 / Plan-002) and relaxed to nullable + `ON DELETE SET NULL` by [Plan-022's D-022-7 / T22.5.2 control-plane migration](../../plans/022-data-retention-and-gdpr.md#ratified-design-decisions-tier-5-audit-2026-05-30) — a forward ALTER over the shipped owner tables (unlike the `revoked_*` FKs below and the `session_channel_directory` member-pair FKs in the next section, which are born in their final `ON DELETE SET NULL` shape at their own builds). A participant hard-DELETE then severs the data-subject link DB-side rather than failing the parent `DELETE FROM participants` or deleting the surviving membership / invite row; `NULL` participant ids are non-equal under `session_memberships`'s `UNIQUE(session_id, participant_id)`, so erasing two participants in the same session is safe. Canonical: [Spec-022 §Shred Fan-Out FK-safety](../../specs/022-data-retention-and-gdpr.md#shred-fan-out), [Plan-022 D-022-7](../../plans/022-data-retention-and-gdpr.md#ratified-design-decisions-tier-5-audit-2026-05-30); the [GDPR Manual Erasure Runbook](../../operations/gdpr-manual-erasure-runbook.md) verifies `confdeltype = 'n'` on both before the irreversible Path-1 shred.

---

## Session Channel Directory (Plan-002)

The control-plane channel directory — the Plan-002-owned backing store of the [Spec-016 §Interfaces And Contracts](../../specs/016-multi-agent-channels-and-orchestration.md#interfaces-and-contracts) D-016-22 channel-directory publication (producer: [Plan-016 T2.14](../../plans/016-multi-agent-channels-and-orchestration.md#tasks) / CP-016-15) and the channel source behind the [Spec-002 §Interfaces And Contracts](../../specs/002-invite-membership-and-presence.md#interfaces-and-contracts) `ChannelList` projection's per-caller `direct`-channel filter (Plan-002 I-002-6). Each row is one channel's **fold state** — the per-origin candidate set the idempotent ingest mutation retains over at-least-once, arbitrarily reordered publications, plus the deterministic resolution it materializes from that set — not an event and not an authority: the daemon-local `channel.*` event stream stays canonical per ADR-017, and this table is a coordination-records projection of it (invariant 1 above). Registered by Plan-002's channel-directory carrier delta (2026-08-11) closing [Plan-016's §Preconditions carrier box](../../plans/016-multi-agent-channels-and-orchestration.md#preconditions); ships as control-plane migration `0005-session-channel-directory.ts` with Plan-002 T3.7.

```sql
-- Owner: Plan-002 (channel-directory ingest carrier — CP-002-10 ⇄ Plan-016 CP-016-15)
CREATE TABLE session_channel_directory (
  channel_id            UUID PRIMARY KEY,              -- daemon-authored ChannelId (the fold register's key)
  session_id            UUID NOT NULL REFERENCES sessions(id),
  name                  TEXT,                          -- publication `name?`; nullable by contract
  state                 TEXT NOT NULL
                        CHECK(state IN ('active', 'muted', 'archived')),
  kind                  TEXT,                          -- Plan-016's channel-kind vocabulary (D-016-21; `direct` is the
                                                       -- one disclosure-restricted member). Deliberately NO CHECK: the
                                                       -- vocabulary is Plan-016-owned and additive, and a constraint
                                                       -- rejection would DROP an at-least-once publication (existence
                                                       -- lost) instead of degrading its kind — readers treat NULL or
                                                       -- any unrecognized value as unresolvable → omit-as-`direct`
  member_pair_low_id    UUID REFERENCES participants(id) ON DELETE SET NULL,
  member_pair_high_id   UUID REFERENCES participants(id) ON DELETE SET NULL,
  disclosure_collapsed  BOOLEAN NOT NULL DEFAULT FALSE, -- conflicting origin-authenticated creation claims observed:
                                                        -- kind + pair permanently unbindable; row reads as `direct`
  origin_candidates     JSONB NOT NULL DEFAULT '{}',   -- the retained candidate set the resolver reads: one candidate
                                                       -- {seq, occurredAt, eventId, state} per origin node id under
                                                       -- `origins`, plus one `legacy` slot for keyless pre-extension
                                                       -- publications; ordering + state only, never disclosure
                                                       -- fields — see Fold semantics below
  origin_node_id        TEXT,                          -- resolving candidate's origin daemon (NULL when the legacy slot resolves)
  origin_seq            BIGINT,                        -- resolving candidate's per-(session, origin) channel-lifecycle counter (NULL for legacy)
  origin_occurred_at    TIMESTAMPTZ NOT NULL,          -- resolving candidate's envelope occurredAt (cross-origin comparator)
  origin_event_id       TEXT NOT NULL,                 -- resolving candidate's envelope id (cross-origin comparator tiebreak)
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (member_pair_low_id IS NULL OR member_pair_high_id IS NULL
         OR member_pair_low_id < member_pair_high_id)  -- canonicalized pair (low < high); NULL-tolerant so an
                                                       -- erasure SET NULL on one column never fails the participant DELETE
);

CREATE INDEX idx_session_channel_directory_session ON session_channel_directory(session_id);
```

**Fold semantics (per-origin candidate retention — redesigned 2026-08-11, PR #322 Codex round 1).** The earlier single-winner comparator (same-origin `origin_seq`, cross-origin `(occurred_at, event_id)`) was **not order-independent** — a same-origin-seq branch and a cross-origin-timestamp branch can disagree when an origin clock steps backward, so two replicas receiving one publication set in different orders could disagree — and dropping `origin_seq` to a timestamp tiebreak was rejected because same-origin causality is exactly what the counter was minted for (a clock rewind between an origin's `muted` and `unmuted` would otherwise pin the stale state forever). The fold instead **retains one candidate per origin** in `origin_candidates` and resolves from the whole set, which makes the stored row a pure function of the publication _set_: **(1) candidate admission** — a publication updates only its own origin's slot, kept iff its `originSeq` is higher (duplicates are no-ops); a keyless legacy publication (pre-extension event payload — the wire's optional origin keys) competes only for the single `legacy` slot under `(origin_occurred_at, origin_event_id)`-max; a retained candidate carries **ordering keys and `state` only** — never `name`, `kind`, or the member pair — deliberately, so the GDPR name-clearing below has no second copy inside `origin_candidates` to chase; **(2) state resolution** — `archived` latches terminally as a **sticky read of the stored `state` column, not a candidate-set recompute**: the ingest checks the stored `state` before resolving, an admitted publication carrying `archived` writes `state = 'archived'`, and a latched row's state is never downgraded (equivalently: the row's state is `archived` iff any publication ever carried it — Plan-016 D-016-12 — which is why the latch survives even a faulty origin later replacing its own archived candidate in `origin_candidates`); while latched, the four `origin_*` columns hold the `(origin_occurred_at, origin_event_id)`-max **archived** publication's keys — a max-fold over the archived publications themselves, kept in the columns rather than the replaceable candidate set, so the materialized keys stay a pure set function too; on an unlatched row the `(origin_occurred_at, origin_event_id)`-lexicographic-max retained candidate's state stands, and the four `origin_*` columns materialize that resolving candidate's keys (cross-origin resolution is wall-clock and skew-prone — the recorded LWW residual whose V1.1 seam is the HLC upgrade, ADR-017/BL-076); **(3) the create-once disclosure binding is an independent axis** — `kind`, the member pair, **and `name`** bind exactly once, from the origin-authenticated `channel.created` publication (identified by the wire's `lifecycleEventKind`, never inferred from `state`), and are immutable to the ingest thereafter — an unbound row (kind `NULL`, not collapsed) binds whenever that creation publication lands, even after `archived`, without reviving state; conflicting origin-authenticated creation claims set `disclosure_collapsed` instead of rebinding; legacy and non-origin publications never bind. Canonical contract: [Spec-002 §Interfaces And Contracts](../../specs/002-invite-membership-and-presence.md#interfaces-and-contracts) (the channel-directory ingest bullet), [Spec-016 §Interfaces And Contracts](../../specs/016-multi-agent-channels-and-orchestration.md#interfaces-and-contracts) (D-016-22).

**GDPR erasure (born-correct anonymize-class FKs).** `member_pair_low_id` / `member_pair_high_id` are **born nullable + `ON DELETE SET NULL`** at this table's Plan-002 carrier build — the `artifact_relay_blobs.publisher_participant_id` / `session_terminal_leases.holder_participant_id` born-correct pattern, no D-022-7-style forward ALTER — and nullable is additionally their domain semantics (both columns are `NULL` on every non-`direct` channel). A participant hard-DELETE auto-nulls only the erased member's column; the surviving row keeps the other member's id, and the [Spec-002 §Interfaces And Contracts](../../specs/002-invite-membership-and-presence.md#interfaces-and-contracts) omission predicate matches callers against the remaining non-`NULL` member(s) — a `NULL` member matches no caller, so erasure **narrows** a `direct` channel's visibility (fail-closed), never widens it. **A `direct` row's `name` is pair-attributed PII, not work product (2026-08-11, PR #322 Codex round 1):** the erasure flow additionally clears it — `UPDATE session_channel_directory SET name = NULL WHERE member_pair_low_id = :pid OR member_pair_high_id = :pid` — executed **before** the participant hard-DELETE (afterwards the `SET NULL` severance makes the rows unfindable by participant id), intrinsically `direct`-scoped because only `direct` rows carry pair columns; non-`direct` names are session work product under [Spec-022 §PII Data Map](../../specs/022-data-retention-and-gdpr.md#pii-data-map)'s artifact posture. The cleared name cannot resurrect: `name` is in the create-once binding (fold semantics above), so no redelivered or sweep publication rebinds it on a bound row. The erasure `SET NULL` and the name-clearing `UPDATE` are DB-side severances, not ingest writes, so neither violates the create-once immutability rule above. Dispositions: [Spec-022 §Shred Fan-Out](../../specs/022-data-retention-and-gdpr.md#shred-fan-out) Path 2 (anonymize class; the FK-safety census counts both columns); operator procedure: [GDPR Manual Erasure Runbook](../../operations/gdpr-manual-erasure-runbook.md).

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
                   CHECK(reason IN ('account_compromise', 'password_reset', 'admin_action', 'self_service')),
  expires_at       TIMESTAMPTZ NOT NULL            -- aligns with the revoked family's natural expiry; bounds the reap (mirror revoked_jtis)
);

CREATE INDEX idx_revoked_families_participant ON revoked_token_families(participant_id);
CREATE INDEX idx_revoked_families_expires ON revoked_token_families(expires_at);
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
-- Durable cross-session ephemeral-key reuse guard (I-008-7c, Spec-008 §Relay Negotiation — "Reused
-- ephemeral X25519 public keys across distinct sessions must be rejected by the control plane").
-- Each participant mints a fresh ephemeral X25519 key pair per session (I-008-6), and the
-- per-session relay Durable Object discards its bundles on close — so a key reused in a *later*
-- session can only be detected against a store that OUTLIVES the session. This control-plane table
-- is that store (OD-008r-2, Tier-5 readiness audit). The PK on the public key is the DB-level
-- uniqueness index that makes a duplicate INSERT of a key a constraint violation; the broker's
-- admission logic reads the stored session_id before deciding — rejecting a CROSS-session reuse
-- with relay.bundle_rejected (Spec-008 §Relay Negotiation) and treating a SAME-session
-- re-presentation as an idempotent admit ONLY for the participant that first claimed the key
-- (Spec-008 §Relay Connection Lifecycle step 6, the reconnect-resume step; a different participant
-- is rejected). That original-claimant check is broker live-layer logic against the in-memory
-- admission record (fail-closed when absent → client re-mints) — this table stays the cross-session
-- (key → first session_id) backstop, never a claimant store. The audit ratifies that the store is
-- durable + uniqueness-indexed and that its retention is — by design — the FULL single-use horizon:
-- Spec-008 §Relay Negotiation requires a reused key to be rejected across ALL distinct sessions, so
-- any pruning that drops a still-rejectable key would re-admit it on re-insert — a literal
-- invariant violation — and therefore V1 prunes nothing. Full-horizon retention is the correct
-- terminal design here, not a placeholder to be optimized later: the ephemeral public key is a
-- CLIENT-chosen value with no server-anchored birth time except its first appearance in this table,
-- so a freshness/TTL window cannot bound the store — a client reusing a key re-presents it under a
-- fresh timestamp that a time-windowed store would have forgotten and would wrongly re-admit. (This
-- is why the TLS 1.3 0-RTT anti-replay window does NOT transfer: that window binds a SERVER-issued
-- ticket age the peer cannot re-stamp — RFC 8446 §8 — whereas here the dedup key is client-minted.)
-- Remembering every key is therefore irreducible, not lazy. The table is bounded by historical
-- (session × participant) ephemeral-key count, not by traffic volume (~64 bytes/row — trivial at
-- desktop-runtime scale); at hosted scale its growth is an ops concern (time-partition the table,
-- keeping every partition queryable — never DROP, which would re-admit a pruned key) decoupled from
-- the security property. Bounding retention would weaken the Spec-008 §Relay Negotiation
-- forward-secrecy guarantee and is therefore a separate Spec-008 Type-2 decision, not a code-level
-- optimization.
CREATE TABLE relay_seen_ephemeral_keys (
  ephemeral_x25519_public BYTEA PRIMARY KEY,     -- 32-byte X25519 public key; PK = global single-use index
  session_id              UUID NOT NULL REFERENCES sessions(id),  -- the session that first claimed this key
  seen_at                 TIMESTAMPTZ NOT NULL DEFAULT now()      -- first-seen audit anchor (full-horizon retention by design; see comment above)
);

CREATE INDEX idx_relay_seen_ephemeral_keys_session ON relay_seen_ephemeral_keys(session_id);
```

---

## Artifact Relay Blob Store (Plan-014)

Coordination state for the [Spec-014 §Cross-Node Artifact Relay (V1)](../../specs/014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1) eager-pin store-and-forward: blob metadata, per-participant wrapped content-encryption keys (CEKs), delivery refcounts, and fetch grace leases. The ciphertext **chunk bytes never enter Postgres** — they live in the deployment's object store (invariant (1) above); these tables hold only key envelopes and lifecycle state, so a relay operator (or a Postgres compromise) yields ciphertext coordinates but no decryption capability. Both participant references join the [Spec-022 §Shred Fan-Out](../../specs/022-data-retention-and-gdpr.md#shred-fan-out) Path-2 `REFERENCES participants(id)` closure (CP-022-6): `artifact_relay_recipients.participant_id` is hard-DELETE class (dropping the row IS the wrapped-CEK crypto-shred), and `artifact_relay_blobs.publisher_participant_id` is anonymize class (born nullable + `ON DELETE SET NULL` — the blob survives to refcount-zero/TTL so other participants' availability is unaffected by the publisher's erasure).

```sql
-- Owner: Plan-014
-- Blob lifecycle: state 'pending_replication' at upload-init → 'pinned' when every chunk is
-- relay-acknowledged AND the finalize has re-hashed the assembled ciphertext to equal ciphertext_digest — the CAS key is verified, never trusted; a re-pin re-verifies the stored copy, so re-publish repairs at-rest corruption (the offline-availability guarantee attaches ONLY to 'pinned');
-- 'expired' records TTL/eviction. Value set = the storage-lifecycle SUBSET of the Spec-014 replicationStatus wire enum:
-- the degradation states ('over_cap' / 'quota_exceeded') mean NO relay upload happened (Spec-014 failure table), so
-- they never create a blob row — they live only on the artifact manifest (SQLite replication_status + the wire field).
-- Deletion triggers: refcount-zero (all intended recipients fetched) OR expires_at, whichever
-- first; hourly async sweep + 90% node-storage watermark eviction (delivered/nearest-TTL first).
CREATE TABLE artifact_relay_blobs (
  ciphertext_digest        TEXT PRIMARY KEY,   -- multihash-prefixed (sha256:…) whole-ciphertext digest; CAS key, one row per stored blob
  session_id               UUID NOT NULL REFERENCES sessions(id),
  publisher_participant_id UUID REFERENCES participants(id) ON DELETE SET NULL,  -- anonymize-class (CP-022-6); NULL after publisher erasure
  size_bytes               BIGINT NOT NULL,
  chunk_size_bytes         INTEGER NOT NULL,   -- fixed 8 MiB in V1 (Spec-014 artifact_relay_chunk_bytes)
  chunk_count              INTEGER NOT NULL,
  retention_tier           TEXT NOT NULL DEFAULT 'default'
                           CHECK(retention_tier IN ('volatile', 'default', 'extended')),
  state                    TEXT NOT NULL DEFAULT 'pending_replication'
                           CHECK(state IN ('pending_replication', 'pinned', 'expired')),
  expires_at               TIMESTAMPTZ NOT NULL,          -- tier-derived TTL deletion trigger; re-anchored to now + tier TTL on every successful re-pin (Spec-014 Publish steps 3-4: a re-pin is a fresh grant of the same bytes)
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_artifact_relay_blobs_session ON artifact_relay_blobs(session_id);
CREATE INDEX idx_artifact_relay_blobs_expires ON artifact_relay_blobs(expires_at);

-- Owner: Plan-014
-- One row per (blob, intended recipient node): carries the wrapped CEK for one attested (participant, node) — encrypted to that node's DURABLE artifact-encryption X25519 key (Spec-014 Publish step 3; never the ADR-010 session-ephemeral keys, which are zeroed at session end and would orphan the CEK on restart), thumbprint-tagged so the fetching daemon selects the right private key after restart/rotation — the relay cannot unwrap;
-- per Spec-014 Publish step 3 this row is the wrapped CEK's ONLY store, never the durable artifact.published event — deleting it is a true shred), delivery state (delivered_at NULL = undelivered;
-- refcount-zero = zero NULLs remain for the blob across every (participant, node) row — a participant's
-- second node keeps the blob alive until it fetches or TTL; delivered_at is written ONLY by the
-- authenticated ArtifactFetchComplete ack that follows client-side chunk/commitment/CAS verification,
-- never inferred from the last chunk GET — Spec-014 Fetch step 6; the acked row is resolved from the
-- fetch token's own (participant, node) DPoP-bound claims, never a caller-supplied node_id, so a node presenting a token minted for itself cannot mark a sibling delivered; mint-time authorization is participant-granular (Spec-014 Fetch step 5, scoped 2026-08-08) and this ack proves no CEK unwrap, so a COMPROMISED
-- same-participant node CAN still forge this write, clear the blob's last outstanding row, and destroy the blob at refcount-zero GC with no remedy while the publisher is offline — the named V1 availability residual, not a closed case; and the write is idempotent), and the in-flight fetch grace lease
-- (GC must not evict the blob while a lease is live). Hard-DELETE class in the CP-022-6 closure:
-- deleting a participant's rows IS the crypto-shred (their reach to the CEK is destroyed) and
-- simultaneously removes them from the intended-recipient set, keeping refcount semantics
-- consistent after erasure. Backup honesty (Spec-014 §State And Data Implications): Postgres
-- PITR/WAL archiving is database-wide — rows cannot be excluded — so either the backup/PITR
-- window is bounded ≤ the erasure SLA (30 d relay-TTL ceiling), or wrapped_cek is stored under a
-- separately-destroyable KEK (Spec-022 §Daemon Master Key precedent); otherwise shred is incomplete.
CREATE TABLE artifact_relay_recipients (
  ciphertext_digest TEXT NOT NULL REFERENCES artifact_relay_blobs(ciphertext_digest) ON DELETE CASCADE,
  participant_id    UUID NOT NULL REFERENCES participants(id),  -- hard-DELETE class (CP-022-6); erasure removes ALL of a participant's node rows
  node_id           TEXT NOT NULL,      -- daemon-assigned node identifier (runtime_node_* convention); per-node delivery tracking
  wrapped_cek       BYTEA NOT NULL,     -- CEK wrapped to this node's durable artifact-encryption X25519 key; ~100 bytes
  key_thumbprint    TEXT NOT NULL,      -- thumbprint of the wrapping public key; the recipient retains that key (even once retired) until this row is delivered or TTL-expired
  delivered_at      TIMESTAMPTZ,        -- NULL = not yet fetched-and-verified by this recipient node
  lease_expires_at  TIMESTAMPTZ,        -- in-flight resumable-fetch grace lease; NULL when no fetch in flight
  PRIMARY KEY (ciphertext_digest, participant_id, node_id)
);

CREATE INDEX idx_artifact_relay_recipients_participant ON artifact_relay_recipients(participant_id);
```

---

## Rate Limiting Tables (Plan-021)

Admin bans (`admin_bans`) are shared by both deployments. Escalation state (`rate_limit_escalations`) is self-host only; hosted deployments use Cloudflare Durable Objects (`RateLimitEscalationDO`) for escalation state and persist nothing in Postgres for that path. The self-host sliding-window counters live in `ratelimit_*`-prefixed tables that `rate-limiter-flexible` auto-creates on first use — library-managed, deliberately absent from this hand-authored schema and from the migration sequence (`Plan-021 §Data And Storage Changes`; [cross-plan-dependencies.md §1 Plan-021 row](../cross-plan-dependencies.md#1-table-ownership-map)).

```sql
-- Owner: Plan-021
CREATE TABLE admin_bans (
  ban_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity        TEXT NOT NULL,
  identity_type   TEXT NOT NULL
                  CHECK(identity_type IN ('participant', 'ip', 'token_hash', 'session', 'user')),
  issued_by       TEXT NOT NULL,                  -- operator attribution, server-derived from the operator-token context (Plan-021 D-021-1: 'deployment-operator' in V1 — no participant principal exists on this surface); deliberately no FK — rows survive participant deletion (Plan-021 D-021-13)
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
                       CHECK(identity_type IN ('participant', 'ip', 'token_hash', 'session', 'user')),
  violation_timestamps TIMESTAMPTZ[] NOT NULL DEFAULT '{}',  -- per-violation timestamps; append + prune to the 1-hr horizon on upsert — exact N-in-window ladder evaluation, DO parity (Plan-021 §Data And Storage Changes)
  active_block_until   TIMESTAMPTZ,
  PRIMARY KEY (identity, identity_type)
);
```

The five-value `identity_type` domain (`'participant' | 'ip' | 'token_hash' | 'session' | 'user'`) matches `RateLimitIdentityType` in `packages/contracts/src/rate-limiter.ts` (Plan-021 D-021-17 — `'session'` covers per-session registry rows such as `invite.create_session` and `invite.pending_cap`; `'user'` is reserved dormant for the V1.1 `keypackage.upload` activation per ADR-010, with no V1 writer); both tables carry the same CHECK so the domain cannot drift per table.

**GDPR erasure dispositions (Plan-021 D-021-13; mirrored in [Spec-022 §Shred Fan-Out](../../specs/022-data-retention-and-gdpr.md#shred-fan-out) and the [manual-erasure runbook](../../operations/gdpr-manual-erasure-runbook.md)).** `admin_bans` rows are **retained** on participant erasure under the abuse-prevention legitimate-interest carve-out — including rows whose `identity_type = 'participant'` matches the erased participant and rows where the erased participant appears as `issued_by`/`revoked_by` (erasure must not un-ban an identity, and operator attribution must survive; hence TEXT columns with no FK). Revoked or expired rows become purgeable 90 days after revocation/expiry. `rate_limit_escalations` rows for an erased participant identity are **hard-DELETEd** (ephemeral ≤1-hour operational state; nothing to retain). Ephemerality is actively enforced, not upsert-dependent: rows whose violations have all aged past the 1-hr horizon and whose block (if any) has expired — `GREATEST(max(violation_timestamps) + interval '1 hour', COALESCE(active_block_until, '-infinity')) < now()` — are deleted by `PostgresEscalationStore.sweepExpired()` on the relay's unref'd 10-minute interval (Plan-021 T21.2-3; scheduled by Plan-025 step 7), mirroring the hosted DO's self-eviction alarm; a quiet identity's row never outlives its window. The library-managed `ratelimit_*` counter tables (section intro above) hold no per-participant durable state beyond their sliding windows and are outside the erasure fan-out.

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

## Notification Queue (Plan-019)

Durable per-participant delivery records for the offline leg of [Spec-019 §Cross-Device Delivery](../../specs/019-notifications-and-attention-model.md#cross-device-delivery): V1 delivers notifications to currently-connected devices over the SSE subscription, and **if no device is connected the notification is queued in the control plane** and delivered as a batch on the participant's next connect, replayed from the last delivered position. This table is that queue — the substrate the spec's catch-up sentence assumes. **Forward-declared:** the additive migration ships with the Plan-019 Phase 2 preference-and-queue-storage leg (`Plan-019 §Implementation Phase Sequence`); the DDL is pinned here so the emit path, the reconnect catch-up read, the expiry sweep, and the migration share one canonical shape.

**Deliberately absent: no cursor table, no per-device delivery state, no delivery-attempt or backoff column, no coalescing or cross-device dedup key.** Each omission tracks a behavior Spec-019 does not state, and columns are not added ahead of the behavior that would write them. The catch-up cursor is derived, not stored (see the delivery model below). Per-device state has no V1 writer: the spec scopes V1 delivery to the participant and defers per-device fan-out — and with it any duplicate-suppression across devices — to the V2 push/digest leg. Redelivery attempts, backoff, and coalescing of related notifications are likewise unstated: a queued row is either pushed once (and stamped) or stays owed until it expires.

```sql
-- Owner: Plan-019 (Phase 2 ships the additive control-plane migration)
-- One row per notification owed to one participant while that participant has no connected device.
-- Coordination/delivery records only: each row carries a REFERENCE to the canonical event that
-- triggered it (source_event_id) plus the derived notification-rendering fields, never the event
-- payload -- the invariant-(1) constraint at the top of this file.
CREATE TABLE notification_queue (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_sequence    BIGSERIAL UNIQUE,            -- monotonic per-table delivery order; the derived catch-up cursor reads it (BIGSERIAL implies NOT NULL)
  participant_id    UUID NOT NULL REFERENCES participants(id),
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
                                                'run_failed', 'invite_received', 'mention')),
  severity          TEXT NOT NULL
                    CHECK(severity IN ('actionable', 'informational')),
  summary           TEXT NOT NULL,               -- derived render string (AttentionItem.summary); personal content -- see the erasure note
  source_event_id   TEXT NOT NULL,               -- canonical triggering event id; deliberately no FK (the event row is daemon-local)
  queued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at      TIMESTAMPTZ,                 -- NULL = still owed; stamped when the row goes out in a batch
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days',
  CHECK (expires_at > queued_at)
);

-- Reconnect catch-up read: the participant's still-owed rows, already in delivery order.
CREATE INDEX idx_notification_queue_undelivered
  ON notification_queue (participant_id, queue_sequence)
  WHERE delivered_at IS NULL;

-- Expiry purge sweep.
CREATE INDEX idx_notification_queue_expiry ON notification_queue (expires_at);
```

The `attention_trigger` and `severity` domains are byte-identical to the `AttentionItem` contract's `trigger` and `severity` unions in [api-payload-contracts.md](../contracts/api-payload-contracts.md), which ground them in [Spec-019 §Required Behavior](../../specs/019-notifications-and-attention-model.md#required-behavior)'s minimum trigger set and [Spec-019 §Default Behavior](../../specs/019-notifications-and-attention-model.md#default-behavior)'s actionable/informational split; the CHECK constraints exist so a queued row cannot carry a trigger the client has no rendering for. The column-name qualification is the only divergence from the wire shape, and it is a keyword-avoidance rename, not a domain change. `summary` is carried rather than re-derived at delivery time because the queue's entire purpose is delivery to a client that was absent when the attention state was derived.

**Delivery model (a cursor without a cursor table).** The catch-up position is the pair (`delivered_at IS NULL`, `queue_sequence`): the reconnect read selects the participant's undelivered rows in `queue_sequence` order, pushes them as one batch over the [Spec-019 §Desktop-to-Desktop Delivery](../../specs/019-notifications-and-attention-model.md#desktop-to-desktop-delivery) SSE subscription, and stamps `delivered_at` on exactly the rows it pushed — so the next connect resumes where this one stopped without a stored per-participant cursor row to keep in sync. `queue_sequence` rather than `queued_at` carries the order because rows inserted in one transaction share a single `now()`: timestamps tie, and a timestamp-keyed resume across a tie can skip or repeat a row. `notification_preferences` filtering happens at emit time, before a row is written ([Spec-019 §Desktop-to-Desktop Delivery](../../specs/019-notifications-and-attention-model.md#desktop-to-desktop-delivery) — non-matching events are dropped at the control plane), so the queue holds only notifications the participant has already opted into and the catch-up read applies no further filter.

**Retention (7 days, then permanent deletion).** `expires_at` defaults to `queued_at + 7 days`, the one retention figure [Spec-019 §Cross-Device Delivery](../../specs/019-notifications-and-attention-model.md#cross-device-delivery) states, and the CHECK keeps it strictly after `queued_at` so a row can never be born expired. The purge sweep deletes every row past `expires_at`, delivered or not: an undelivered row is "expired and permanently deleted" by the spec's own words, and a delivered row has discharged its purpose with no stated longer-retention obligation. Deletion is permanent and leaves no tombstone — this queue is a delivery buffer, not an audit surface; the canonical event each row references stays in the emitting daemon's local log per ADR-017.

**Invariant compatibility (checked against (1)–(4) above, as this file requires of every table addition).** This table engages (1) and (2) and violates neither. It is **per-participant delivery state** — which notifications one participant is owed and whether each has been pushed — not a cross-participant event stream: there is no session-ordered read path, no sequence shared across participants, and no replay semantics (`queue_sequence` orders one participant's pending batch, not a session's history). It stores **no event payload**: `source_event_id` is a reference whose row lives in the emitting daemon's local `session_events`, and `trigger` / `severity` / `summary` are the derived notification-rendering fields of the `AttentionItem` contract, produced by the attention projection rather than copied off an event. A reader of this table learns that a participant was owed a notification; it cannot reconstruct the session. Invariants (3) and (4) are untouched — the daemon-local log stays authoritative and no supersession gate is engaged.

**GDPR erasure (hard-DELETE class).** `notification_queue.participant_id` is `NOT NULL REFERENCES participants(id)` with the default `NO ACTION`, so this table joins the [Spec-022 §Shred Fan-Out](../../specs/022-data-retention-and-gdpr.md#shred-fan-out) Path-2 `REFERENCES participants(id)` closure (Plan-022 CP-022-6 ⇄ Plan-019 CP-019-1) as its thirteenth row, alongside its sibling `notification_preferences`. A participant erasure hard-DELETEs every row for that participant — `DELETE FROM notification_queue WHERE participant_id = :pid;` — and must run **before** the `DELETE FROM participants` anchor, or the `NO ACTION` FK makes that parent `DELETE` fail. Hard-DELETE rather than anonymize: the row carries no audit-trail or referential obligation (the canonical event survives in the daemon-local log), and `summary` is derived personal content, so severing the FK alone would leave personal data behind. The [GDPR Manual Erasure Runbook §Path 2](../../operations/gdpr-manual-erasure-runbook.md#path-2--hard-delete--sever-postgres-rows-control-plane) is the V1 operator procedure.

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

The control plane stores Merkle-root **anchors** (metadata only) for per-daemon event logs; it does **not** store event payloads. This is consistent with [ADR-017 Shared Event-Sourcing Scope](../../decisions/017-shared-event-sourcing-scope.md), which rejected a shared event log for V1, and with [Security Architecture § Audit Log Integrity](../security-architecture.md#audit-log-integrity), which defines the tamper-evidence protocol. **Forward-declared:** the additive migration ships with Plan-006 T3.3 (Tier 4 Phase 3) as `packages/control-plane/src/migrations/0004-event-log-anchors.ts`, with its same-commit `MIGRATIONS`-array registration in `packages/control-plane/src/sessions/migration-runner.ts`; the DDL is pinned here so the anchor-upload write path, the verification read below, and the migration share one canonical shape. That shipment landed 2026-08-04 (PR #287) at `{ version: 4 }`; the **Forward-declared** label stays because the migration file's own header cites this block by that name as its canonical source, and its `EVENT_LOG_ANCHORS_MIGRATION_SQL` reproduces the DDL below verbatim — so any column-shape edit still lands here first per AGENTS.md doc-first ordering.

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
-- Deliberately NO participant FK: key material is machine-generated and carries no personal data,
-- so this table sits outside the Spec-022 §Shred Fan-Out Path-2 REFERENCES participants(id)
-- closure and SURVIVES participant erasure. That durability is load-bearing, not incidental: the
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

Per-session shared-terminal write-lease coordination record ([Spec-003 §Required Behavior](../../specs/003-runtime-node-attach.md#required-behavior), campaign B4) — the current holder only, projected by the `runtimenode.roster` join as `RuntimeNodeRosterResponse.controlHolder`. **Forward-declared:** the additive migration ships with the Plan-024 Phase 3B lease leg (campaign B16), per the [cross-plan-dependencies §3 forward assignment](../cross-plan-dependencies.md); the DDL is pinned here so the roster projection, the erasure fan-out, and the Phase 3B migration share one canonical shape. Invariant-compliant by construction: a single current-state row per session (same coordination tier as `runtime_node_presence`), never an event log — the `pty.control_changed` transition stream stays in the daemon-local event store per ADR-017.

**Deliberately absent (2026-08-03 projection-conformance amendment): no lease-expiry or authority-epoch column.** A time-bounded lease with an authority-issued fence is the correct shape when the _control plane_ is the lease authority; in V1 it is not ([Spec-003 §Required Behavior](../../specs/003-runtime-node-attach.md#required-behavior) makes the terminal-owning daemon the sole authority). Server-owned columns here would make the control plane a **second writer** on this row, contradicting the single-producer write model below, its no-cross-writer-lock-ordering property, and ADR-017's daemon-local transition stream — and they would fence the record rather than the terminal, since enforcement lives on the holder's own machine. The time-bounded design belongs with the future relay-borne remote-take leg Spec-003's forward constraint names, which ships its own additive migration when that write leg lands; dormant columns are not added ahead of it.

```sql
-- Owner: Plan-024 (Phase 3B / campaign B16 ships the additive migration)
CREATE TABLE session_terminal_leases (
  session_id            UUID PRIMARY KEY REFERENCES sessions(id),
  holder_participant_id UUID REFERENCES participants(id) ON DELETE SET NULL,  -- NULL = lease free (writes refused; Spec-003 null-holder-refuses-writes)
  node_id               TEXT NOT NULL,     -- producing terminal-owning node: binds the row to its single producer; re-binds only when that node stops being a live terminal host — its attachment leaves the active set (explicit detach) OR its runtime_node_presence.health_state reads offline (api-payload leaseupdate contract)
  transition_seq        BIGINT NOT NULL,   -- daemon-owned strictly-increasing per session (persisted daemon-side across restarts); stale transport retries compare lower and are discarded
  transitioned_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_session_terminal_leases_holder ON session_terminal_leases(holder_participant_id);
```

**Write model (single producer).** The terminal-owning daemon is the sole lease authority ([Spec-003 §Required Behavior](../../specs/003-runtime-node-attach.md#required-behavior)): it adjudicates every take/release and publishes each transition to the control plane via the `runtimenode.leaseupdate` projection-sync mutation ([api-payload-contracts §Session Terminal-Control Method Registry](../contracts/api-payload-contracts.md#session-terminal-control-method-registry-tier-3-campaign-b4)); the control plane persists what the daemon publishes through a **producer-bound, monotonic conditional upsert** carrying the api-payload contract's **caller-authorization** predicates **inside** the write statement rather than in a preceding probe (active attachment for `(node_id, session_id)` owned by the verified caller, plus — on a holder-asserting publish only, `controlHolder ≠ null` — that caller's `state = 'active'` `session_memberships` row), so the form is `INSERT … SELECT … WHERE EXISTS (…) ON CONFLICT (session_id) DO UPDATE … WHERE ((session_terminal_leases.node_id = EXCLUDED.node_id AND session_terminal_leases.transition_seq < EXCLUDED.transition_seq) OR (session_terminal_leases.node_id <> EXCLUDED.node_id AND <recorded-producer-departed>)) AND EXISTS (…)` — the authorization `EXISTS` repeated on **both** arms, because `ON CONFLICT … DO UPDATE … WHERE` is evaluated only on conflict and a bare `VALUES` insert would bypass it against an absent row (same producer ⇒ the sequence must increase — an equal-or-lower retry is acknowledged and discarded; an authorized producer re-bind re-baselines the sequence). The **producer re-bind** condition rides **inside** that statement (2026-08-03 amendment, closing a review-found TOCTOU): `<recorded-producer-departed>` is the departure disjunction over the row's **recorded** producer — `NOT EXISTS` an active `runtime_node_attachments` row for `(session_terminal_leases.node_id, session_id)`, `OR EXISTS` a `runtime_node_presence` row for it reading `offline` — so a different node is accepted only when the recorded producer has stopped being a live terminal host, evaluated **under the conflicting row's lock in the same statement as the write**, never in a preceding probe. A probe-then-write split here is exploitable in both directions: two replacement nodes that both observed the producer offline would both pass the probe and each overwrite the other (the second write must instead re-evaluate against the first's committed re-bind and refuse, because the new recorded producer is live), and a returning former producer's delayed publish would overwrite its successor (it must instead be refused on the different-node arm while the successor is live). With the predicate in the statement both races serialize on the lease row's conflict lock and re-evaluate against the current row, so exactly one recorded producer survives any interleaving. A zero-row result is therefore ambiguous across all three refusal causes — stale `transition_seq` (acknowledged and discarded), failed caller authorization, refused re-bind — and needs in-transaction classification (re-read and distinguish; never collapse them). Because exactly one daemon owns a session's terminal, writes to a given row are serialized at the producer — no cross-writer lock ordering exists on this table, and the `session_memberships` / `runtime_node_attachments` / `runtime_node_presence` facts the predicates consult are **read, never written** (each an `EXISTS` inside the single write statement — one snapshot, no lock taken on those tables), so this table registers no entry in [cross-plan-dependencies §Lock Ordering Across Shared Tables](../cross-plan-dependencies.md#lock-ordering-across-shared-tables); the `node_id` binding and monotonic `transition_seq` make that single-producer assumption enforced rather than assumed (a stale delivery or a non-owning attached node's daemon cannot overwrite the projection — campaign B4 round 6). The holder is cleared by the daemon-published auto-releases (holder presence/attachment drop; holder authorization loss — role change out of the authorized set, suspension, or revocation; and the agent-run write-burst release on the acquiring run's first lifecycle transition out of `running` — `auto_released_run_idle`, `Spec-003 §Required Behavior` Part-A completion 2026-07-16), and `idx_session_terminal_leases_holder` serves exactly the three holder-keyed sweeps: presence-drop clear, authorization-loss clear, and the erasure selector below (the run-idle release needs no holder-keyed sweep — the daemon resolves it through the acquiring-run tag on its daemon-local lease record — re-bound on each agent-path acquisition, so it names the most recent acquiring run — never a `holder_participant_id` lookup). The roster's `controlHolder` is not a byte-mirror of this column: the read resolves it to null while the row's `node_id` carries `runtime_node_presence.health_state = 'offline'` — a read-time predicate over the verdict Plan-003's heartbeat sweep already derived, writing nothing, so the read-side surface stays honest during the window in which no successor host has exercised the `offline` re-bind disjunct above ([api-payload §Session Terminal-Control Method Registry](../contracts/api-payload-contracts.md#session-terminal-control-method-registry-tier-3-campaign-b4), Codex PR #283 rounds 2-3).

**GDPR erasure (anonymize via `ON DELETE SET NULL` — the sixth anonymize-class FK).** `holder_participant_id` is born nullable + `ON DELETE SET NULL` at its Phase 3B build (no ALTER — the table does not exist before that migration, the same born-correct pattern as `artifact_relay_blobs.publisher_participant_id`). A participant hard-DELETE auto-nulls the holder, converging on the correct lease semantics — the lease frees (null-holder-refuses-writes, fail-closed) while the row survives as session coordination state. **Ordering (the daemon stays the sole lease authority):** this projection row never changes without the daemon's `pty.control_changed` broadcast, so the documented erasure flow ends the participant's session memberships **before** the `DELETE` — the authorization-loss force-clear has then already freed the lease daemon-side and published the transition, and the `SET NULL` fires on an already-`NULL` holder as a DB-side idempotent backstop (the [GDPR Manual Erasure Runbook](../../operations/gdpr-manual-erasure-runbook.md) Precondition carries the operator check; an out-of-flow direct DELETE still converges to the same fail-closed lease-free state but bypasses the broadcast — exactly why the ordering is required, never the primary transition). Canonical dispositions: [Spec-022 §Shred Fan-Out](../../specs/022-data-retention-and-gdpr.md#shred-fan-out); operator verification in the [GDPR Manual Erasure Runbook](../../operations/gdpr-manual-erasure-runbook.md).

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
