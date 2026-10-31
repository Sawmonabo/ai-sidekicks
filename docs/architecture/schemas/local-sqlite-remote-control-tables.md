# Remote Control Tables (Plan-025)

The Remote Control tables of the daemon's one SQLite schema: this machine's own record and its verified view of the account's devices. The [Local SQLite Schema](local-sqlite-schema.md) holds its pragmas, its conventions and every other area.

## This Machine

```sql
-- Owner: Plan-025
-- This machine: its id and its owner's user id, both minted at the daemon's first start and kept
-- the same at every later start; the friendly name read then (Spec-002), which a rename replaces;
-- and the public halves pinning its identity key and channel key. One row.
CREATE TABLE local_machine (
  singleton            INTEGER PRIMARY KEY CHECK (singleton = 1),
  machine_id           TEXT NOT NULL,
  owner_user_id        TEXT NOT NULL,  -- a hosted account signed in to later attaches to it
  name                 TEXT NOT NULL,
  minted_at            TEXT NOT NULL,
  identity_public_key  BLOB,           -- NULL until the first mint, replaced at the relink
  channel_public_key   BLOB            -- NULL until the first mint, replaced at the relink
) STRICT;

-- Owner: Plan-025
CREATE TABLE machine_trust_state (
  machine_id        TEXT NOT NULL,
  owner_user_id     TEXT NOT NULL,
  established_at    TEXT NOT NULL,  -- first registration; a re-registration keeps it
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (machine_id, owner_user_id)
) STRICT;
```

## The Account's Devices

Each machine keeps its own verified view of the account's devices, which the channel's handshake reads, and the ports it shares with them ([Spec-027](../../specs/027-remote-control.md)). Settings › Devices lists both. The account's trust is an append-only chain of signed statements, each naming the hash of the one before it. Every machine verifies the chain itself and trusts a key only when a path of `machine.added`, `device.linked` and `account.passkey.added` statements reaches it from its own machine key, each signed while its signer was still trusted at that point in the chain. A `device.revoked`, `machine.removed` or `account.passkey.removed` ends the key it names at that point: a statement that key signs afterward is refused, and what it signed before stands, so every device, machine and passkey it added stays trusted. An ended key is never trusted again.

```sql
-- Owner: Plan-025
-- The verified chain, append-only. Kept until the account is gone; a forgotten device's
-- `device.revoked` stays in it.
CREATE TABLE trust_statements (
  statement_hash    TEXT PRIMARY KEY,             -- the statement's own hash, which the next statement names
  previous_hash     TEXT,                         -- the hash of the statement before it; NULL for the chain's first
  kind              TEXT NOT NULL
                    CHECK(kind IN ('device.linked', 'device.renamed', 'device.revoked',
                                   'account.passkey.added', 'account.passkey.removed',
                                   'machine.added', 'machine.renamed', 'machine.removed')),
  statement         BLOB NOT NULL                 -- the signed statement as verified, signed by a machine key, a device key or a passkey
) STRICT;

-- Owner: Plan-025
-- One row per device the chain trusts or has revoked. Kept until the account is gone; a
-- forgotten device's row goes.
CREATE TABLE trusted_devices (
  device_id               TEXT PRIMARY KEY,
  public_key              BLOB NOT NULL,
  key_algorithm           TEXT NOT NULL
                          CHECK(key_algorithm IN ('p256', 'ed25519')),  -- every public key carries its algorithm, because the Secure Enclave has no Ed25519
  name                    TEXT NOT NULL,
  platform                TEXT NOT NULL,
  trusted_by_statement    TEXT NOT NULL REFERENCES trust_statements(statement_hash),  -- the statement that trusts it
  revoked_at              TEXT,                   -- NULL while trusted
  notification_settings   TEXT,                   -- JSON: the device's switches {notifyOutsideTheApp, countOnAppIcon, kinds}, handed over by device.notificationSettings.update; the device holds the source of truth
  push_key                BLOB,                   -- the key a push notice to this device is sealed to
  web_push_keys           TEXT,                   -- JSON: the web client's subscription keys {p256dh, auth}; NULL on every other device
  CHECK(revoked_at IS NULL OR (notification_settings IS NULL AND push_key IS NULL AND web_push_keys IS NULL))  -- the switches and push keys are kept until the device is revoked
) STRICT;

-- Owner: Plan-025
-- The ports this machine shares with the account's devices: only listed ports, and only loopback,
-- forwarded through the channel. A row stays until the port is removed from the list.
CREATE TABLE shared_ports (
  port      INTEGER PRIMARY KEY
            CHECK(port BETWEEN 1 AND 65535),
  added_at  TEXT NOT NULL
) STRICT;
```
