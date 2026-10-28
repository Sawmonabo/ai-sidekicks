//! This machine's part of the daemon's schema: its own record, minted at the daemon's first start,
//! with the public halves of its two keys, set at their first mint and replaced at a relink, and
//! its registration.

/// This machine's tables.
pub(crate) const MACHINE_SCHEMA_SQL: &str = "
-- ---------------------------------------------------------------------------
-- This machine: its id and its owner's user id, both minted at the daemon's
-- first start, its friendly name, read then and replaced when the machine is
-- renamed, and the pins of its two keys. One row.
-- ---------------------------------------------------------------------------
CREATE TABLE local_machine (
  singleton            INTEGER PRIMARY KEY CHECK (singleton = 1),
  machine_id           TEXT NOT NULL,
  -- A hosted account signed in to later attaches to it.
  owner_user_id        TEXT NOT NULL,
  name                 TEXT NOT NULL,
  minted_at            TEXT NOT NULL,           -- RFC 3339 UTC, ms precision
  -- The 32-byte public halves of the Ed25519 identity key and the X25519
  -- channel key the credential store holds: NULL until the first mint sets
  -- both, replaced together at a relink. A key gone or not matching its pin is
  -- refused; only a relink, or a sign-in while unregistered, mints again.
  identity_public_key  BLOB,
  channel_public_key   BLOB
) STRICT;

-- This machine's registration: one row per machine and owning user.
CREATE TABLE machine_trust_state (
  machine_id      TEXT NOT NULL,
  owner_user_id   TEXT NOT NULL,
  established_at  TEXT NOT NULL,                -- first registration; a re-registration keeps it
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (machine_id, owner_user_id)
) STRICT;
";
