# Shared Postgres Schema

Canonical schema for the collaboration control plane's shared Postgres database.

**Storage boundary:** Shared session metadata, invites, memberships, presence history, session directory, and cross-node coordination records. See [Data Architecture](../data-architecture.md).

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
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_state ON sessions(state);

-- Owner: Plan-001 | Extended by: Plan-002 (invite-driven membership flows)
CREATE TABLE session_memberships (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES sessions(id),
  participant_id  UUID NOT NULL REFERENCES participants(id),
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
  inviter_id      UUID NOT NULL REFERENCES participants(id),
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

---

## Participants and Identity (Plan-018)

```sql
-- Owner: Plan-018
CREATE TABLE participants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name    TEXT NOT NULL,
  identity_ref    TEXT NOT NULL UNIQUE,          -- stable identity reference (e.g. email, OAuth sub)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata        JSONB NOT NULL DEFAULT '{}'    -- extensible profile data
);

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
  state           TEXT NOT NULL DEFAULT 'registering'
                  CHECK(state IN ('registering', 'online', 'degraded', 'offline', 'revoked')),
  attached_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_node_attachments_session ON runtime_node_attachments(session_id);
CREATE INDEX idx_node_attachments_participant ON runtime_node_attachments(participant_id);
CREATE UNIQUE INDEX idx_node_attachments_node ON runtime_node_attachments(node_id, session_id);

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
```

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
