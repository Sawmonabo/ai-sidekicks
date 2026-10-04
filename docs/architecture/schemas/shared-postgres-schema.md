# Shared Postgres Schema

Canonical schema for the control plane's shared Postgres database. It is one schema, built whole: there are no numbered migration steps, and every table is in this one schema and its test.

**Storage boundary:** The account and its sign-in state, the person's devices and machines with the signed statement chain that says which of them are trusted. The control plane keeps no session record: a device reaches a session only through its machine over the relay, and the machine's service is the session's one store. It stores no artifact either: a session's artifacts stay on the machine that runs it. See [Data Architecture](../data-architecture.md).

---

## Invariant — No Shared Session-Event Table in V1 (ADR-016)

Per [ADR-016: Shared Event-Sourcing Scope](../../decisions/016-shared-event-sourcing-scope.md), this schema declares the following invariants that constrain all downstream table additions:

1. **Coordination records only.** Shared Postgres stores each device's last-seen time, written from its relay connection at most once a minute, device and machine rows (each one PUBLIC key with its algorithm — the private halves stay on the device or the machine and never reach the control plane), and the account's append-only signed statement chain. It keeps no session record: a device reaches a session only through its machine over the relay, and the machine's service is the session's one store. It stores no notification preference and queues no notification: each machine decides and seals every push itself. It holds no attachment of a machine to a session and no heartbeat record, no terminal lease, which is the machine's alone, and no artifact, which stays on the machine that runs the session. It does **not** store event payloads.
2. **No `session_events_shared`, `session_events_global`, or equivalent cross-user event table exists in V1.** The absence is intentional, not an oversight.
3. **Per-daemon local `session_events` is authoritative** per ADR-016 and [local-sqlite-schema.md](./local-sqlite-schema.md). Each daemon owns its own event log with its own monotonic sequence number; an audit across the person's machines reads each machine's own log, per [Data Architecture §Event-Sourcing Scope](../data-architecture.md#event-sourcing-scope).
4. **No shared session-event table.** Session events live in each machine's local log ([ADR-016](../../decisions/016-shared-event-sourcing-scope.md)).

These invariants hold for every table in this schema: no table's name or meaning reads as a shared event log.

---

## Users Identity Anchor (Plan-001)

**Order within the one schema:** the `users` table below is created before every table that references it, because `runtime_nodes.user_id`, `devices.user_id` and the other user-bearing tables `REFERENCES users(id)`. Plan-015's identity columns are part of the same schema — see [Users and Identity (Plan-015)](#users-and-identity-plan-015) below.

```sql
-- Owner: Plan-001 (minimal identity anchor for FK resolution)
-- Identity columns: Plan-015
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  display_name    TEXT NOT NULL,                 -- Owner: Plan-015
  identity_ref    TEXT NOT NULL UNIQUE,          -- Owner: Plan-015; the account's random WebAuthn user handle as unpadded base64url, carried by every passkey it holds — Plan-015 D-015-2
  metadata        JSONB NOT NULL DEFAULT '{}'    -- Owner: Plan-015
);
```

Plan-001 owns `id` and `created_at`, the fields every referencing table needs; Plan-015 owns the identity columns (`display_name`, `identity_ref`, `metadata`), declared in the same `CREATE TABLE users`. No user rows exist before `Create an account` on Plan-015's device-code page writes the account's one row.

---

## Users and Identity (Plan-015)

Plan-015 owns the identity columns of the [Plan-001 Users Identity Anchor](#users-identity-anchor-plan-001), declared in `CREATE TABLE users` above. The person's devices are [Plan-025's](#devices-machines-and-the-statement-chain-plan-025).

```sql
-- Owner: Plan-015 (the index on the users anchor's identity column)

CREATE INDEX idx_users_identity ON users(identity_ref);
```

**`identity_ref` is the account's WebAuthn user handle (Plan-015 D-015-2).** The account is keyed by its own id: `identity_ref` is random bytes minted when the account is created, at most 64 of them and carrying no personal data ([WebAuthn Level 3 §5.4.3](https://www.w3.org/TR/webauthn-3/#dictionary-user-credential-params)), and every passkey the account holds carries it as its user handle. The column holds the handle's bytes as unpadded base64url, WebAuthn's own JSON form for the user id; `users.id` stays the key. A passkey resolves to its one user through its [`webauthn_credentials`](#webauthn-ceremony-plan-015) row, whose `credential_id UNIQUE` keeps one passkey from naming two users; no outside sign-in makes or finds the account.

---

## WebAuthn Ceremony (Plan-015)

Backs the relying party's half of the WebAuthn ceremony [ADR-010](../../decisions/010-tokens-passkeys-and-the-remote-channel.md) requires, owned by Plan-015 Phase 6 (T6.1 — CP-015-8). The web client and the phone apps call these routes over their authenticated control-plane channel, and the device-code page `sidekicks sign-in` opens calls the authentication-options route and hands the assertion to the device-code grant's approval route; the desktop app carries no WebAuthn, and no JSON-RPC method string is involved.

```sql
-- Owner: Plan-015 (T6.1)
CREATE TABLE webauthn_credentials (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id),
  credential_id     TEXT NOT NULL UNIQUE,   -- base64url; authenticator-minted, unique by construction
  public_key        BYTEA NOT NULL,         -- COSE public key, as returned by the verification library
  signature_counter BIGINT NOT NULL DEFAULT 0,
  transports        TEXT[],                 -- authenticator-reported transport hints, for allowCredentials
  registered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at      TIMESTAMPTZ
);

CREATE INDEX idx_webauthn_credentials_user ON webauthn_credentials(user_id);

-- Owner: Plan-015 (T6.1) — the single-use ceremony fence
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

**`webauthn_challenges` is the single-use fence, and consuming a challenge is deleting its row (Plan-015 T6.4 / I-015-7).** Consumption is one statement — `DELETE FROM webauthn_challenges WHERE challenge = $1 AND transaction_id = $2 AND expires_at > now() RETURNING *` — so two concurrent verifications of one challenge cannot both find a row, and an expired row is never returned even before the periodic sweep reaches it. The sweep is hygiene, not the correctness mechanism. A sealed stateless challenge was considered and rejected: single-use is the property that matters, and a self-contained token stays replayable until it expires unless a durable fence records its consumption, so the stateless design does not remove the write — it adds a second signing secret to rotate beside a write it still has to perform.

**The verification transaction takes this table `FOR UPDATE` (Plan-015 I-015-9).** The signature-counter advance is a locked read and a conditional write inside the same transaction that consumed the challenge, so the ceremony's lock order is `webauthn_challenges` → `webauthn_credentials`, registered below at [§Lock Ordering Across Shared Tables](#lock-ordering-across-shared-tables). An unlocked read-then-write is defeated by the exact adversary the counter exists to detect: two concurrent replays of a cloned authenticator each read the pre-existing value and each find the presented counter greater.

Both tables carry `REFERENCES users(id)` for the same reason `devices` does — it places them inside the [Spec-020 §Path 2](../../specs/020-data-retention-and-gdpr.md#erasure-paths) exhaustive inbound-FK erasure closure, and the closure costs nothing because a WebAuthn credential is verified live and no retained row re-verifies one post-erasure.

---

## Token Revocation

Backs the hosted account's refresh tokens: `refresh_token_families` holds one row per signed-in machine, its live sign-in, and the denylist tables hold what was revoked. Every revocation — a sign-out, a spent refresh token presented again, a device revoked through the statement chain, the account's deletion — writes the token's `jti` or its whole family to the denylist. A trade is one compare-and-swap on the family's row, `UPDATE refresh_token_families SET current_jti = <new>, last_traded_at = now() WHERE family_id = <presented family> AND current_jti = <presented jti>`: one row updated is a good trade; no row updated while the family's row exists means the presented `jti` was already spent, which is reuse, so the same transaction deletes the family's row and writes its `revoked_token_families` row; a family with neither a live row nor a revoked row is refused. The swap also settles two trades racing with one token: only one updates the row. Built by Plan-015 Phase 5 with the account work.

```sql
-- Owner: Plan-015 (Phase 5, the control plane's account work)
CREATE TABLE revoked_jtis (
  jti              TEXT PRIMARY KEY,
  user_id   UUID REFERENCES users(id) ON DELETE SET NULL,  -- nullable + SET NULL on erasure (Plan-019 D-019-3)
  family_id        UUID NOT NULL,                 -- refresh-token rotation family
  revoked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason           TEXT NOT NULL
                   CHECK(reason IN ('sign_out', 'refresh_reuse', 'device_revoked', 'account_deleted')),
  expires_at       TIMESTAMPTZ NOT NULL            -- aligns with the revoked token's natural expiry
);

CREATE INDEX idx_revoked_jtis_user ON revoked_jtis(user_id);
CREATE INDEX idx_revoked_jtis_family ON revoked_jtis(family_id);
CREATE INDEX idx_revoked_jtis_expires ON revoked_jtis(expires_at);

-- Owner: Plan-015 (Phase 5, the control plane's account work)
CREATE TABLE revoked_token_families (
  family_id        UUID PRIMARY KEY,
  user_id   UUID NOT NULL REFERENCES users(id),  -- the family's account: a refresh token has no lifetime of its own, so the row stays for the account's life and is deleted with the account
  revoked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason           TEXT NOT NULL
                   CHECK(reason IN ('sign_out', 'refresh_reuse', 'device_revoked', 'account_deleted'))
);

CREATE INDEX idx_revoked_families_user ON revoked_token_families(user_id);

-- Owner: Plan-015 (Phase 5, the control plane's account work)
-- One row per live sign-in, that is per signed-in machine. A trade is one compare-and-swap on
-- current_jti; a presented jti of a live family that is not current is spent, which is reuse.
CREATE TABLE refresh_token_families (
  family_id        UUID PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cnf_jkt          TEXT NOT NULL,                 -- the thumbprint of the machine's DPoP key the family is bound to
  current_jti      TEXT NOT NULL,                 -- the one refresh token of the family that may still be traded
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_traded_at   TIMESTAMPTZ
);

CREATE INDEX idx_refresh_token_families_user ON refresh_token_families(user_id);
```

**Account deletion.** On `revoked_jtis`, `user_id` is nullable + `ON DELETE SET NULL` by design: a user hard-DELETE severs the data-subject link, while the denylist key (`jti`, the PRIMARY KEY — **not** `user_id`) survives to its `expires_at + 24h` reap, so erasure cannot resurrect a revoked access token within its validity window. A `revoked_token_families` row is hard-deleted with its account, in `account.delete`'s inbound-foreign-key closure (Plan-019 CP-019-3): no refresh token of a deleted account can be traded, so nothing is left for the row to block. Canonical: [Plan-019 D-019-3](../../plans/019-data-retention-and-gdpr.md), [Spec-020 §Erasure Paths](../../specs/020-data-retention-and-gdpr.md#erasure-paths); `sidekicks delete-account` is the one deletion path; the [Hosted Account Deletion Runbook](../../operations/hosted-account-deletion-runbook.md) is the person's break-glass procedure, run only when they can no longer sign in.

**Retention:** A `revoked_jtis` row is reaped 24 hours past its `expires_at`, the access token's own 15-minute expiry, so the table holds only tokens that could still verify. A `revoked_token_families` row has no expiry: the refresh token lasts until sign-out or revocation (see [security-architecture.md §Token revocation](../security-architecture.md#token-revocation)), so a revoked family stays on the denylist for its account's life and goes with the account (`account.delete`). The table grows by one row per sign-out or revocation. `refresh_token_families` holds one row per signed-in machine: a trade updates that row in place, so nothing grows per trade, and the row goes at sign-out or revocation (to the denylist) and with the account (`ON DELETE CASCADE`).

---

## Devices, Machines And The Statement Chain (Plan-025)

Who may drive the person's sessions is decided by an append-only chain of signed statements, which the control plane keeps and every machine verifies itself ([Spec-027 §Required Behavior](../../specs/027-remote-control.md#required-behavior)). The control plane holds each device's and each machine's public key and the chain; it never holds a private key or a linking secret, and it trusts nothing on its own: every machine verifies the chain itself and trusts a key only when a path of `runtimenode.added`, `device.linked` and `passkey.added` statements reaches it from its own machine key, each signed while its signer was still trusted at that point in the chain. A `device.revoked`, `runtimenode.removed` or `passkey.removed` ends the key it names at that point: a statement that key signs afterward is refused, and what it signed before stands, so every device, machine and passkey it added stays trusted. An ended key is never trusted again. Every public key carries its algorithm, because a phone's hardware key is P-256 and a machine's key is Ed25519.

```sql
-- Owner: Plan-025 (Phase 2; kept until the device is forgotten)
CREATE TABLE devices (
  device_id        TEXT PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES users(id),
  public_key       BYTEA NOT NULL,                -- the device's identity key, PUBLIC half only; made on the device and never exported
  key_algorithm    TEXT NOT NULL CHECK(key_algorithm IN ('p256', 'ed25519')),
  kind             TEXT NOT NULL,                 -- what kind of device it is, shown in the Devices list beside its name
  platform         TEXT NOT NULL,
  name             TEXT NOT NULL,                 -- the one name every device and machine shows for it
  app_version      TEXT,
  linked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ,                   -- the end of its last relay connection; written at most once a minute
  revoked_at       TIMESTAMPTZ,
  push_platform    TEXT CHECK(push_platform IN ('apns', 'fcm', 'webPush')),
  push_address     TEXT                           -- the APNs token, FCM token or Web Push endpoint; dropped at revoke
);

CREATE INDEX idx_devices_user ON devices(user_id);

-- Owner: Plan-025 (Phase 3: the executing machine's registration, keyed by machine and owning user)
CREATE TABLE runtime_nodes (
  node_id            TEXT PRIMARY KEY,            -- the machine's id
  user_id            UUID NOT NULL REFERENCES users(id),
  public_key         BYTEA NOT NULL,              -- the service's identity key, PUBLIC half only; replaced only by a new runtimenode.added when a removed machine is linked again
  key_algorithm      TEXT NOT NULL CHECK(key_algorithm = 'ed25519'), -- a machine's key is the service's Ed25519 key
  name               TEXT NOT NULL,               -- the machine's friendly name
  platform           TEXT NOT NULL,               -- the operating system the service runs on, as registered
  service_version    TEXT NOT NULL,               -- the service's semver version, as registered
  registered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_connected_at  TIMESTAMPTZ
);

CREATE INDEX idx_runtime_nodes_user ON runtime_nodes(user_id);

-- Owner: Plan-025 (Phase 2; append-only for the account's life)
CREATE TABLE trust_statements (
  statement_hash   TEXT PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES users(id),
  previous_hash    TEXT,                          -- the statement before it; NULL only for the account's first
  kind             TEXT NOT NULL
                   CHECK(kind IN ('device.linked', 'device.renamed', 'device.revoked',
                                  'passkey.added', 'passkey.removed',
                                  'runtimenode.added', 'runtimenode.renamed', 'runtimenode.removed')),
  statement        BYTEA NOT NULL,                -- the signed statement as its signer wrote it: a machine key, a device key or a passkey
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, previous_hash)                  -- one chain per account: no statement has two successors
);
```

**Append-only.** A statement is never updated or deleted while the account exists; a forgotten device's `devices` row goes, and its `device.revoked` stays in the chain. Every channel open carries the chain head each side holds, and a machine that sees a newer head fetches the missing statements, so a control plane that withholds a statement from one machine is caught at the next connection of any honest device. For one person with a few machines and devices the chain stays under a hundred statements a year, about 30 KB.

**Push.** A machine seals each push to the device's push key and hands the sealed bytes to the control plane, which looks up `push_address` and delivers through the person's own APNs, FCM or VAPID credentials. The control plane holds nothing that opens a notice, and keeps no notification queue or preference.

**Erasure.** All three tables carry `REFERENCES users(id)` and join the [Spec-020 §Erasure Paths](../../specs/020-data-retention-and-gdpr.md#erasure-paths) Path-2 closure as hard-DELETE: an erased account's devices, machines and chain go with it.

**Invariant compatibility.** One current-state row per device and per machine, and a chain of trust statements that carries no session content and no event payload, so none of them reads as a shared event log under invariant (2).

---

## Lock Ordering Across Shared Tables

Row-lock ordering over the tables above is recorded here. Every control-plane transaction that takes row locks on more than one table in this schema acquires them in the order recorded here, in the modes recorded here. A transaction MAY skip a level it does not need — skipping is order-consistent and creates no cycle — but it MUST NOT reorder one. A plan whose ceremony locks only its **own** uncontested tables registers that internal order here as well, so there is exactly one place to read a lock order rather than one per plan.

### Registrants

| Registrant | Lock order | Per-transaction detail |
| --- | --- | --- |
| WebAuthn ceremony verification (Plan-015 I-015-9) | `webauthn_challenges` → `webauthn_credentials` | A plan's own uncontested pair, registered here rather than in that plan alone. The challenge is consumed by a single `DELETE … RETURNING` (the single-use fence); the same transaction then takes `webauthn_credentials` `FOR UPDATE` before reading the stored signature counter and commits the advance conditionally on the presented value exceeding it. An unlocked read-then-write is defeated by exactly the cloned-authenticator replay the counter exists to detect: two concurrent replays each read the pre-existing value and each find the presented counter greater |

### Tables that deliberately register nothing

The local-SQLite `command_receipts` and `mcp_*` tables register nothing here: every registrant above locks control-plane Postgres rows, while those are daemon-local tables whose single-writer transactions cannot deadlock across plans.

---

## Advisory Lock ID Registry

Postgres `pg_advisory_xact_lock(bigint)` IDs share a single per-database namespace; two callers using the same ID silently serialize against each other. To prevent silent collisions, every advisory-lock caller MUST use a distinct ID, allocated below.

| ID | Owner | Purpose |
| --- | --- | --- |
| `9_000_000_001` | Plan-001 control-plane | Serializes the one schema's creation across control-plane replicas that start at the same time. |

**Reserved bands.** `9_000_000_000`–`9_000_000_999` is reserved for control-plane schema-coordination locks (creating the one schema and similar boot-path serialization). Plans that need cross-replica coordination locks for runtime concerns SHOULD allocate above `9_001_000_000` to keep the schema-coordination band contiguous and reviewable.
