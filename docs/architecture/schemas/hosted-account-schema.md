# Hosted Account Schema

Canonical schema for the hosted account's SQLite database, which lives inside the relay: in the account object's own SQLite storage on the Workers relay, and in a SQLite file the relay's one process writes on the Compose relay ([Deployment Topology §Account Storage](../deployment-topology.md#account-storage)). It is one schema, built whole: there are no numbered migration steps, and every table is in this one schema and its test. The writer creates the whole schema in one transaction when it opens an empty database. On the Workers relay the writer's one schema script is one `sql.exec()` call, which Cloudflare runs as one transaction ([Cloudflare: SQLite-backed Durable Object Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), whose methods table notes that each method is implicitly wrapped inside a transaction), so the schema is built whole or not at all and the writer's check for a built schema only tells an empty database from a built one.

**Types.** Every table is `STRICT`, and every `REFERENCES` is enforced: the Compose relay opens its file with `PRAGMA foreign_keys = ON`, and the relay's first test confirms a Durable Object's SQLite enforces them on the Workers relay. An id the writer mints is a UUID held as `TEXT`; a time is Unix seconds as `INTEGER`, defaulting to `unixepoch()` (a token's own `iat` and `exp` are RFC 3339 strings inside the token, as PASETO writes them), except `counted_requests`, whose window frees to the millisecond ([§Counted Requests](#counted-requests-plan-018)); a key or a signed statement is a `BLOB`; a list or a JSON value is `TEXT` holding JSON.

**Storage boundary:** The account and its sign-in state, the person's devices and machines with the signed statement chain that says which of them are trusted. The control plane keeps no session record: a device reaches a session only through its machine, and the machine's service is the session's one store. It stores no artifact either: a session's artifacts stay on the machine that runs it. See [Data Architecture](../data-architecture.md).

---

## Invariant — No Shared Session-Event Table in V1 (ADR-016)

Per [ADR-016: Shared Event-Sourcing Scope](../../decisions/016-shared-event-sourcing-scope.md), this schema declares the following invariants that constrain all downstream table additions:

1. **Coordination records only.** The hosted account's database stores each device's last-seen time, written from its relay connection at most once a minute, device and machine rows (each one PUBLIC key with its algorithm — the private halves stay on the device or the machine and never reach the control plane), and the account's append-only signed statement chain. It keeps no session record: a device reaches a session only through its machine, and the machine's service is the session's one store. It stores no notification preference and queues no notification: each machine decides and seals every push itself. It holds no attachment of a machine to a session and no heartbeat record, no terminal lease, which is the machine's alone, and no artifact, which stays on the machine that runs the session. It does **not** store event payloads.
2. **No `session_events_shared`, `session_events_global`, or equivalent cross-user event table exists in V1.** The absence is intentional, not an oversight.
3. **Per-daemon local `session_events` is authoritative** per ADR-016 and [local-sqlite-schema.md](./local-sqlite-schema.md). Each daemon owns its own event log with its own monotonic sequence number; an audit across the person's machines reads each machine's own log, per [Data Architecture §Event-Sourcing Scope](../data-architecture.md#event-sourcing-scope).
4. **No shared session-event table.** Session events live in each machine's local log ([ADR-016](../../decisions/016-shared-event-sourcing-scope.md)).

These invariants hold for every table in this schema: no table's name or meaning reads as a shared event log.

---

## Users Identity Anchor (Plan-001)

**Order within the one schema:** the `users` table below is created before every table that references it, because `machines.user_id`, `devices.user_id` and the other user-bearing tables `REFERENCES users(id)`. Plan-015's identity columns are part of the same schema — see [Users and Identity (Plan-015)](#users-and-identity-plan-015) below.

```sql
-- Owner: Plan-001 (minimal identity anchor for FK resolution)
-- Identity columns: Plan-015
CREATE TABLE users (
  id              TEXT PRIMARY KEY,              -- a UUID the writer mints
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  display_name    TEXT NOT NULL,                 -- Owner: Plan-015
  identity_ref    TEXT NOT NULL UNIQUE           -- Owner: Plan-015; the account's random WebAuthn user handle as unpadded base64url, carried by every passkey it holds — Plan-015 D-015-2
) STRICT;
```

Plan-001 owns `id` and `created_at`, the fields every referencing table needs; Plan-015 owns the identity columns (`display_name`, `identity_ref`), declared in the same `CREATE TABLE users`. No user rows exist before `Create an account` on the control plane's sign-in page writes the account's one row. A deployment holds one account: `users` holds at most one row, the sign-in page offers `Create an account` only while it is empty, and the creation arm refuses once a row exists.

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

Backs the relying party's half of the WebAuthn ceremony [ADR-010](../../decisions/010-tokens-passkeys-and-the-remote-channel.md) requires, owned by Plan-015 Phase 6 (T6.1 — CP-015-8). The web client and the iPhone app call these routes, the authentication pair with no sign-in and the rest signed in. The sign-in page a machine's service opens (`/oauth/authorize`) calls the authentication-options route, and for `Create an account` the registration-options route with no sign-in, and hands the assertion or attestation to the sign-in page's approval of the pending [`authorization_requests`](#tokens-and-sign-in) row; the desktop app carries no WebAuthn, and no JSON-RPC method string is involved.

```sql
-- Owner: Plan-015 (T6.1)
CREATE TABLE webauthn_credentials (
  user_id           TEXT NOT NULL REFERENCES users(id),
  credential_id     TEXT PRIMARY KEY,       -- base64url; authenticator-minted, unique by construction; the passkey's id
  public_key        BLOB NOT NULL,          -- COSE public key, as returned by the verification library
  aaguid            TEXT NOT NULL,          -- the authenticator's AAGUID, which names the passkey's provider on the Devices page
  signature_counter INTEGER NOT NULL DEFAULT 0,
  transports        TEXT,                   -- JSON array of authenticator-reported transport hints, for allowCredentials
  registered_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at      INTEGER
) STRICT;

CREATE INDEX idx_webauthn_credentials_user ON webauthn_credentials(user_id);

-- Owner: Plan-015 (T6.1) — the single-use ceremony fence
CREATE TABLE webauthn_challenges (
  challenge       TEXT PRIMARY KEY,         -- the challenge IS the selector a verification presents
  transaction_id  TEXT NOT NULL UNIQUE,     -- a UUID; the correlator an unauthenticated caller quotes back
  user_id         TEXT REFERENCES users(id),  -- the signed-in user adding a passkey; NULL for a sign-in, whose user is known only from the verified response, and for account creation
  ceremony        TEXT NOT NULL CHECK (ceremony IN ('registration','authentication')),
  expires_at      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE INDEX idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);
```

**`webauthn_challenges` is the single-use fence, and consuming a challenge is deleting its row (Plan-015 T6.4 / I-015-6).** Consumption is one statement — `DELETE FROM webauthn_challenges WHERE challenge = ?1 AND transaction_id = ?2 AND ceremony = ?3 AND user_id IS ?4 AND expires_at > ?5 RETURNING *`, the router's clock bound as a parameter, the same clock the issue leg wrote `expires_at` from — so two verifications of one challenge cannot both find a row, and an expired row is never returned even before the issue leg's delete reaches it. Each issue first deletes the rows whose `expires_at` has passed, in the same transaction, on the `expires_at` index, so no timer runs and the table holds at most the challenges of the last five minutes; that delete is hygiene, not the correctness mechanism. A sealed stateless challenge was considered and rejected: single-use is the property that matters, and a self-contained token stays replayable until it expires unless a durable fence records its consumption, so the stateless design does not remove the write — it adds a second signing secret to rotate beside a write it still has to perform.

**The verification reads and advances the signature counter in the transaction that consumed the challenge (Plan-015 I-015-8).** The advance is a read and a conditional write with nothing awaited between them, on the database's one writer ([§Transactions On One Writer](#transactions-on-one-writer)), so two replays of a cloned authenticator run one after the other: the second reads the first's advance and is refused. A read and a write split by an await would be defeated by the exact adversary the counter exists to detect: both replays would read the old value and each find the presented counter greater.

Both tables carry `REFERENCES users(id)` for the same reason `devices` does — it places them inside the [Spec-020 §Path 2](../../specs/020-data-retention-export-and-deletion.md#erasure-paths) exhaustive inbound-FK erasure closure, and the closure costs nothing because a WebAuthn credential is verified live and no retained row re-verifies one post-erasure.

---

## Tokens And Sign-In

Backs the hosted account's tokens: `refresh_token_families` holds one row per live sign-in, a machine's or a phone's or browser's, the denylist tables hold what was revoked, `dpop_proof_jtis` holds the DPoP proofs already seen, and `authorization_requests` holds each pending sign-in a machine's service started with a pushed authorization request (RFC 9126). Every revocation — a sign-out, which the service sends to `/oauth/revoke` (RFC 7009), a spent refresh token presented again, a device revoked through the statement chain, the account's deletion — writes the token's `jti` or its whole family to the denylist. A trade is one compare-and-swap on the family's row, `UPDATE refresh_token_families SET current_jti = <new>, last_traded_at = unixepoch() WHERE family_id = <presented family> AND current_jti = <presented jti>`: one row updated is a good trade; no row updated while the family's row exists means the presented `jti` was already spent, which is reuse, so the same transaction deletes the family's row and writes its `revoked_token_families` row; a family with neither a live row nor a revoked row is refused. The swap also settles two trades of one token: the writer runs them one after the other, and only the first updates the row. `refresh_token_families`, the denylist tables and `dpop_proof_jtis` are Plan-015 T6.6's, which checks every proof and every signed-in request against them; `authorization_requests`, the trade, reuse detection and sign-out are T5.4's.

```sql
-- Owner: Plan-015 (T6.6, the control plane's tokens)
CREATE TABLE revoked_jtis (
  jti              TEXT PRIMARY KEY,
  user_id          TEXT REFERENCES users(id) ON DELETE SET NULL,  -- nullable + SET NULL on erasure (Plan-019 D-019-3)
  family_id        TEXT NOT NULL,                 -- a UUID; the refresh-token rotation family
  revoked_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  reason           TEXT NOT NULL
                   CHECK(reason IN ('signOut', 'refreshReuse', 'deviceRevoked', 'accountDeleted')),
  expires_at       INTEGER NOT NULL               -- aligns with the revoked token's natural expiry
) STRICT;

CREATE INDEX idx_revoked_jtis_user ON revoked_jtis(user_id);
CREATE INDEX idx_revoked_jtis_family ON revoked_jtis(family_id);
CREATE INDEX idx_revoked_jtis_expires ON revoked_jtis(expires_at);

-- Owner: Plan-015 (T6.6, the control plane's tokens)
CREATE TABLE revoked_token_families (
  family_id        TEXT PRIMARY KEY,              -- a UUID
  user_id          TEXT NOT NULL REFERENCES users(id),  -- the family's account: a refresh token has no lifetime of its own, so the row stays for the account's life and is deleted with the account
  revoked_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  reason           TEXT NOT NULL
                   CHECK(reason IN ('signOut', 'refreshReuse', 'deviceRevoked', 'accountDeleted'))
) STRICT;

CREATE INDEX idx_revoked_families_user ON revoked_token_families(user_id);

-- Owner: Plan-015 (T6.6, the control plane's tokens)
-- One row per live sign-in: a machine's, or a phone's or browser's. A trade is one compare-and-swap
-- on current_jti; a presented jti of a live family that is not current is spent, which is reuse.
CREATE TABLE refresh_token_families (
  family_id        TEXT PRIMARY KEY,              -- a UUID
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cnf_jkt          TEXT NOT NULL,                 -- the thumbprint of the DPoP key the family is bound to
  current_jti      TEXT NOT NULL,                 -- the one refresh token of the family that may still be traded
  issued_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  last_traded_at   INTEGER
) STRICT;

CREATE INDEX idx_refresh_token_families_user ON refresh_token_families(user_id);

-- Owner: Plan-015 (T6.6, the control plane's tokens) — each DPoP proof's jti, accepted once
CREATE TABLE dpop_proof_jtis (
  jti              TEXT PRIMARY KEY,              -- an insert that finds its jti already here refuses the proof as a replay
  expires_at       INTEGER NOT NULL               -- the proof's iat plus the accepted window
) STRICT;

CREATE INDEX idx_dpop_proof_jtis_expires ON dpop_proof_jtis(expires_at);

-- Owner: Plan-015 (T5.4, the sign-in) — one row per pending sign-in, written by its pushed authorization request
CREATE TABLE authorization_requests (
  request_uri          TEXT PRIMARY KEY,          -- the one-time request_uri the pushed authorization request answers with; the sign-in page opens on it
  code_challenge       TEXT NOT NULL,             -- the PKCE S256 challenge; only the machine's service holds the verifier
  state                TEXT NOT NULL,             -- the value the redirect carries back for the service to check
  redirect_uri         TEXT NOT NULL,             -- http://127.0.0.1:<port>/callback, the service's one-time listener, or the relay's /signed-in/code for a pasted code
  dpop_jkt             TEXT NOT NULL,             -- the thumbprint of the DPoP key that signed the request; the code is redeemed only with that key
  machine_id           TEXT NOT NULL,             -- the machine's id
  identity_public_key  BLOB NOT NULL,             -- the machine's identity key, PUBLIC half only
  channel_public_key   BLOB NOT NULL,             -- the machine's channel key, PUBLIC half only
  machine_name         TEXT NOT NULL,             -- the machine's friendly name
  platform             TEXT NOT NULL,             -- the operating system the service runs on
  service_version      TEXT NOT NULL,             -- the service's semver version
  expires_at           INTEGER NOT NULL,          -- the whole sign-in attempt's bound
  approved_user_id     TEXT REFERENCES users(id) ON DELETE CASCADE, -- set when the sign-in page approves the request
  authorization_code   TEXT UNIQUE,               -- set at approval; redeemed once at the token route
  code_expires_at      INTEGER,                   -- the authorization code's own, shorter bound
  issued_family_id     TEXT,                      -- set when the code is redeemed: the refresh-token family it issued
  pending_identity_ref TEXT,                      -- `Create an account`: the user handle minted for the new account
  pending_display_name TEXT,                      -- `Create an account`: the typed `Name`
  first_passkey_proof  TEXT,                      -- `Create an account`: JSON of the first passkey's assertion over a challenge made from a nonce and the PKCE challenge, that nonce and the browser that made it, returned by the token route
  created_at           INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE INDEX idx_authorization_requests_expires ON authorization_requests(expires_at);
```

**Nothing in these tables runs on a timer.** Each insert into `dpop_proof_jtis`, `revoked_jtis` and `authorization_requests` first deletes that table's rows past their time, in the same transaction, on its `expires_at` index, as the [WebAuthn ceremony](#webauthn-ceremony-plan-015)'s issue leg does. An `authorization_requests` row's time is the later of its `expires_at` and its `code_expires_at`: its delete takes the rows past both, which the `expires_at` index still narrows to, so a code approved near the attempt's bound keeps its row until the code's own bound passes. The token route redeems an authorization code only with the PKCE verifier that matches `code_challenge` and a DPoP proof by the key `dpop_jkt` names, and sets the row's `issued_family_id` when it issues the refresh token, keeping the row until `code_expires_at` passes, so a code yields one sign-in and a code presented again is refused (`invalid_grant`) and revokes the family it issued. The approval's creation arm writes the user record from that row's pending columns.

**Account deletion.** On `revoked_jtis`, `user_id` is nullable + `ON DELETE SET NULL` by design: a user hard-DELETE severs the data-subject link, while the denylist key (`jti`, the PRIMARY KEY — **not** `user_id`) survives to its `expires_at + 24h` reap, so erasure cannot resurrect a revoked access token within its validity window. A `revoked_token_families` row is hard-deleted with its account, in `account.delete`'s inbound-foreign-key closure (Plan-019 CP-019-3): no refresh token of a deleted account can be traded, so nothing is left for the row to block. An `authorization_requests` row approved for the account goes with it (`ON DELETE CASCADE`). Canonical: [Plan-019 D-019-3](../../plans/019-data-retention-export-and-deletion.md), [Spec-020 §Erasure Paths](../../specs/020-data-retention-export-and-deletion.md#erasure-paths); `sidekicks account delete` is the one deletion path; the [Hosted Account Deletion Runbook](../../operations/hosted-account-deletion-runbook.md) is the person's break-glass procedure, run only when they can no longer sign in.

**Retention:** A `revoked_jtis` row is deleted by the first insert 24 hours past its `expires_at`, the access token's own 15-minute expiry, so once another revocation is written the table holds no row past its reap time, and a row past it blocks nothing, since its token no longer verifies. A `revoked_token_families` row has no expiry: the refresh token lasts until sign-out or revocation (see [security-architecture.md §Token revocation](../security-architecture.md#token-revocation)), so a revoked family stays on the denylist for its account's life and goes with the account (`account.delete`). The table grows by one row per sign-out or revocation. A `dpop_proof_jtis` row is one DPoP proof inside its `iat` window, deleted by the first insert after its `expires_at`, so the table holds about the proofs of one window at the request rate; its rows and the time each check adds are measured against [Plan-015](../../plans/015-hosted-account-and-identity.md) T6.6's budget. `refresh_token_families` holds one row per live sign-in, a machine's or a phone's or browser's: a trade updates that row in place, so nothing grows per trade, and the row goes at sign-out or revocation (to the denylist) and with the account (`ON DELETE CASCADE`).

---

## Counted Requests (Plan-018)

The sign-in routes' rate limit counts each request per source address in this one table, the same counter on both relays ([Spec-019 §One Counter On Both Relays](../../specs/019-rate-limiting-policy.md#one-counter-on-both-relays)).

```sql
-- Owner: Plan-018 (Phase 2)
-- One row per request a sign-in route counted, kept until it leaves its window.
CREATE TABLE counted_requests (
  endpoint_group   TEXT NOT NULL,                 -- the endpoint group's key, `auth.endpoint`
  identity         TEXT NOT NULL,                 -- the source address in canonical form: an IPv4 address, or an IPv6 /64 prefix
  expires_at_ms    INTEGER NOT NULL               -- Unix milliseconds: the instant the request leaves its window
) STRICT;

CREATE INDEX idx_counted_requests_window
  ON counted_requests(endpoint_group, identity, expires_at_ms);
CREATE INDEX idx_counted_requests_expires ON counted_requests(expires_at_ms);
```

**Milliseconds.** `expires_at_ms` is the one time in the schema kept in Unix milliseconds, because a window frees to the millisecond and the 429's `resetAt` is read from it.

**Cleanup.** Each check first deletes every row past its window, then counts the address's rows, then refuses or inserts, with nothing awaited between. The rows of an address that stops sending go by a timer: on the Workers relay the account object's one alarm, set by a counted request only when none is pending, and on the Compose relay one cleanup task, started by a counted request only when none is running. Each wakes when the first address's window empties, deletes every row past its window and runs again while rows remain. Every window is 60 seconds, so an address's rows are gone within a minute of its last request.

**Erasure.** A row names a source address and no user, so it joins no erasure path; it goes within a window of the request it counts.

---

## Devices, Machines And The Statement Chain (Plan-025)

Who may drive the person's sessions is decided by an append-only chain of signed statements, which the control plane keeps and every machine verifies itself ([Spec-027 §Required Behavior](../../specs/027-remote-control.md#required-behavior)). The control plane holds each device's and each machine's public key and the chain; it never holds a private key or a linking secret, and it trusts nothing on its own: every machine verifies the chain itself and trusts a key only when a path of `machine.added`, `device.linked` and `account.passkey.added` statements reaches it from its own machine key, each signed while its signer was still trusted at that point in the chain. A `device.revoked`, `machine.removed` or `account.passkey.removed` ends the key it names at that point: a statement that key signs afterward is refused, and what it signed before stands, so every device, machine and passkey it added stays trusted. An ended key is never trusted again. Every public key carries its algorithm, because a phone's hardware key is P-256 and a machine's key is Ed25519.

```sql
-- Owner: Plan-025 (Phase 2; kept until the device is forgotten)
CREATE TABLE devices (
  device_id        TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  public_key       BLOB NOT NULL,                 -- the device's identity key, PUBLIC half only; made on the device and never exported
  key_algorithm    TEXT NOT NULL CHECK(key_algorithm IN ('p256', 'ed25519')),
  kind             TEXT NOT NULL,                 -- what kind of device it is, shown in the Devices list beside its name
  platform         TEXT NOT NULL,
  name             TEXT NOT NULL,                 -- the one name every device and machine shows for it
  app_version      TEXT,
  linked_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at     INTEGER,                       -- the end of its last relay connection; written at most once a minute
  revoked_at       INTEGER,
  push_platform    TEXT CHECK(push_platform IN ('apns', 'webPush')),
  push_address     TEXT                           -- the APNs token or Web Push endpoint; dropped at revoke
) STRICT;

CREATE INDEX idx_devices_user ON devices(user_id);

-- Owner: Plan-025 (Phase 3: the executing machine's registration, keyed by machine and owning user)
CREATE TABLE machines (
  machine_id         TEXT PRIMARY KEY,            -- the machine's id
  user_id            TEXT NOT NULL REFERENCES users(id),
  public_key         BLOB NOT NULL,               -- the service's identity key, PUBLIC half only; replaced only by a new machine.added when a removed machine is linked again
  key_algorithm      TEXT NOT NULL CHECK(key_algorithm = 'ed25519'), -- a machine's key is the service's Ed25519 key
  name               TEXT NOT NULL,               -- the machine's friendly name
  platform           TEXT NOT NULL,               -- the operating system the service runs on, as registered
  service_version    TEXT NOT NULL,               -- the service's semver version, as registered
  registered_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  last_connected_at  INTEGER
) STRICT;

CREATE INDEX idx_machines_user ON machines(user_id);

-- Owner: Plan-025 (Phase 2; append-only for the account's life)
CREATE TABLE trust_statements (
  statement_hash   TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  previous_hash    TEXT,                          -- the statement before it; NULL only for the account's first
  kind             TEXT NOT NULL
                   CHECK(kind IN ('device.linked', 'device.renamed', 'device.revoked',
                                  'account.passkey.added', 'account.passkey.removed',
                                  'machine.added', 'machine.renamed', 'machine.removed')),
  statement        BLOB NOT NULL,                 -- the signed statement as its signer wrote it: a machine key, a device key or a passkey
  received_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, previous_hash)                  -- one chain per account: no statement has two successors
) STRICT;
```

**Append-only.** A statement is never updated or deleted while the account exists; a forgotten device's `devices` row goes, and its `device.revoked` stays in the chain. Every channel open carries the chain head each side holds, and a machine that sees a newer head fetches the missing statements, so a control plane that withholds a statement from one machine is caught at the next connection of any honest device. For one person with a few machines and devices the chain stays under a hundred statements a year, about 30 KB.

**Push.** A machine seals each push to the device's push key and hands the sealed bytes to the control plane, which looks up `push_address` and delivers through the person's own APNs or VAPID credentials. The control plane holds nothing that opens a notice, and keeps no notification queue or preference.

**Erasure.** All three tables carry `REFERENCES users(id)` and join the [Spec-020 §Erasure Paths](../../specs/020-data-retention-export-and-deletion.md#erasure-paths) Path-2 closure as hard-DELETE: an erased account's devices, machines and chain go with it.

**Invariant compatibility.** One current-state row per device and per machine, and a chain of trust statements that carries no session content and no event payload, so none of them reads as a shared event log under invariant (2).

---

## Transactions On One Writer

The database has one writer. On the Workers relay it is the account object, a Durable Object, which runs one request's code at a time and runs each step in `transactionSync`, committing the step's writes together or rolling them all back when it fails ([Cloudflare: SQLite-backed Durable Object Storage §`transaction`](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transaction)); on the Compose relay it is the relay's one process, which runs each request's statements in one transaction. No two transactions interleave, so there are no row locks and no lock order, and every transaction keeps one rule: **a read and the write that depends on it run with nothing awaited between them.** An await, such as an outbound call, ends the step, so a request that must wait reads again after the wait.

| Transaction | What it reads and writes in one step |
| --- | --- |
| WebAuthn ceremony verification (Plan-015 I-015-8) | The assertion is checked first, since the verifier awaits, against the challenge and the stored counter read without consuming either. Then one step consumes the challenge with its single `DELETE … RETURNING` (the single-use fence) and writes the counter's advance with an update that matches only while the passkey is still its user's and the stored value is below the presented one, or both are 0. Two replays of a cloned authenticator commit one after the other, so the second's update meets the first's advance and is refused |
| Sign-in approval (Plan-015 T5.4) | Checks the passkey as the authentication verify leg does, consuming the challenge and advancing the counter, then sets the `authorization_requests` row's approved user and authorization code. `Create an account`'s arm refuses when `users` already holds a row, consumes both its challenges, the registration's and the first passkey's assertion's, inserts the user record and its first `webauthn_credentials` row, and then updates the same `authorization_requests` row. The first-passkey arm of the authentication options issue reads the request's row, records its challenge and writes the nonce to that row in one step |
| Token route (Plan-015 T5.4) | Reads the request's row by its authorization code. When the row's `issued_family_id` is set, the code is presented again: it refuses with `invalid_grant` and revokes that family, deleting its `refresh_token_families` row and writing its `revoked_token_families` row. Otherwise it checks the PKCE verifier and the DPoP proof, writes the new `refresh_token_families` row and sets the request's row's `issued_family_id`, keeping the row until its `code_expires_at` passes |
| Refresh trade (Plan-015 T5.4) | The compare-and-swap on `refresh_token_families`; on reuse, deletes the family's row and writes its `revoked_token_families` row |
