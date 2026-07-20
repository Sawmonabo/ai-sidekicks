# Local SQLite Schema

Canonical schema for the local daemon's SQLite database. Each runtime node maintains its own instance.

**Storage boundary:** Machine-scoped execution truth and recovery data. See [Data Architecture](../data-architecture.md).

## Pragmas

```sql
PRAGMA journal_mode = WAL;      -- concurrent readers during writes
PRAGMA synchronous = FULL;      -- override better-sqlite3 default (NORMAL) for chain-of-custody durability (see Spec-015 §Pragmas + Spec-006 §Integrity Protocol)
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

---

## Session Events (Plan-001, extended by Plans 006, 015)

```sql
-- Owner: Plan-001 | Extended by: Plan-006 (event taxonomy + integrity protocol), Plan-015 (replay cursors)
CREATE TABLE session_events (
  id                     TEXT PRIMARY KEY,           -- ULID or UUID
  session_id             TEXT NOT NULL,              -- real session ULID/UUID, or a reserved node-scope sentinel for daemon-scope events (no FK; see Spec-006 §Security Events + Plan-022 D-022-8)
  sequence               INTEGER NOT NULL,           -- monotonic per session
  occurred_at            TEXT NOT NULL,              -- RFC 3339 UTC with ms precision (wall-clock; display + audit)
  monotonic_ns           INTEGER NOT NULL,           -- process.hrtime.bigint() at emit; within-daemon ordering only (see Spec-015 §Clock Handling, BL-062)
  category               TEXT NOT NULL,              -- e.g. 'run_lifecycle', 'assistant_output', 'tool_activity'
  type                   TEXT NOT NULL,              -- specific event type within category
  actor                  TEXT,                       -- participant_id or agent_id or NULL for system
  payload                TEXT NOT NULL DEFAULT '{}', -- JSON event payload
  pii_payload            BLOB,                       -- encrypted per-participant AES-256-GCM (GDPR); NOT hashed/signed
  correlation_id         TEXT,                       -- links related events
  causation_id           TEXT,                       -- parent event that caused this one
  version                TEXT NOT NULL DEFAULT '1.0'
                         CHECK (version GLOB '[0-9]*.[0-9]*'), -- semver "MAJOR.MINOR" per ADR-018 §Decision #1
                                                               -- (never INTEGER; comparison must parse MAJOR/MINOR as ints —
                                                               -- lexical TEXT comparison is unsafe, e.g. "1.10" < "1.9")
  -- Integrity protocol (BL-050): hash-chain + per-event daemon signature
  prev_hash              BLOB NOT NULL,              -- 32 bytes; row_hash of previous row (zero-filled at sequence=0)
  row_hash               BLOB NOT NULL,              -- 32 bytes; BLAKE3(prev_hash || JCS-canonical envelope bytes); frozen pre-compaction
  daemon_signature       BLOB NOT NULL,              -- 64 bytes; Ed25519 over same canonical bytes; frozen pre-compaction
  participant_signature  BLOB,                       -- 64 bytes; Ed25519 from participant key; NULL for non-sensitive events
  -- Compaction (Plan-006 Tier 4 Phase 3): typed retention discriminator + post-compaction stub commitment
  retention_class        TEXT CHECK (retention_class IS NULL OR retention_class = 'audit_stub'), -- NULL = live row (per-row chain-verified); 'audit_stub' = compacted (anchor + stub_signature verified). Column-level CHECK closes the discriminator domain; it is ALTER-ADD-COLUMN-addable (references only this column; NULL-permitting so pre-migration rows pass). Co-presence (audit_stub ⟺ non-NULL stub_signature) is a two-column invariant that cannot be an ALTER-added table-level CHECK without a 12-step table rebuild; it is instead enforced at the verification layer per Spec-006 §Post-Compaction Integrity (NULL stub_signature on an audit_stub row → stub_signature_invalid; surviving scalar columns category/type/actor/occurred_at bound to the signed payload projection → stub_scalar_mismatch on divergence).
  stub_signature         BLOB,                       -- 64 bytes; Ed25519 over canonical_bytes(audit-stub projection); NULL for live rows. Authenticates the post-compaction stub representation per Spec-006 §Post-Compaction Integrity (frozen row_hash/daemon_signature commit only to the now-discarded pre-compaction bytes)
  UNIQUE(session_id, sequence)
);

CREATE INDEX idx_session_events_session_seq ON session_events(session_id, sequence);
CREATE INDEX idx_session_events_type ON session_events(session_id, type);
CREATE INDEX idx_session_events_correlation ON session_events(correlation_id) WHERE correlation_id IS NOT NULL;
-- Hot-path replay keeps live rows fast; the partial index excludes compacted stubs.
CREATE INDEX idx_session_events_live ON session_events(session_id, sequence) WHERE retention_class IS NULL;
CREATE UNIQUE INDEX idx_session_events_run_terminal_once ON session_events(json_extract(payload, '$.runId'), json_extract(payload, '$.runVersion')) WHERE category = 'run_lifecycle' AND type IN ('run.completed', 'run.failed', 'run.interrupted');

-- Projection-level terminal-key CHECK (Spec-006 at-most-once terminal emission; assigned to the campaign B11
-- schema work). SQLite has no ALTER TABLE ... ADD CHECK on an existing table (sqlite.org/lang_altertable.html), so a
-- trigger trio is the idiomatic equivalent: abort any terminal run_lifecycle write whose runId/runVersion key is NULL
-- OR the wrong storage class (json_type: runId 'text', runVersion 'integer' — a type-drifted "7"-vs-7 key bypasses the
-- UNIQUE index, which keys by storage class). The BEFORE UPDATE leg keys off OLD (the row WAS terminal) and additionally aborts a value-changing key rewrite (NEW key IS NOT OLD, null-safe) or a category/type de-scope — either frees the index slot for a duplicate terminal — enforcing stub-preservation against the compactor (key + category + type kept for the row's whole retention life). The promote leg rejects re-typing any non-terminal row INTO the guarded set (terminal rows are INSERT-only): an OLD-keyed guard alone would let a null-keyed promotion slip both legs and the NULL-distinct UNIQUE index.
CREATE TRIGGER trg_run_terminal_key_insert BEFORE INSERT ON session_events
WHEN NEW.category = 'run_lifecycle'
  AND NEW.type IN ('run.completed', 'run.failed', 'run.interrupted')
  AND (json_extract(NEW.payload, '$.runId') IS NULL OR json_type(NEW.payload, '$.runId') <> 'text' OR json_extract(NEW.payload, '$.runVersion') IS NULL OR json_type(NEW.payload, '$.runVersion') <> 'integer')
BEGIN
  SELECT RAISE(ABORT, 'terminal run_lifecycle requires text runId + integer runVersion (non-null, correct storage class)');
END;
CREATE TRIGGER trg_run_terminal_key_update BEFORE UPDATE OF payload, category, type ON session_events
WHEN OLD.category = 'run_lifecycle'
  AND OLD.type IN ('run.completed', 'run.failed', 'run.interrupted')
  AND (json_extract(NEW.payload, '$.runId') IS NULL OR json_type(NEW.payload, '$.runId') <> 'text' OR json_extract(NEW.payload, '$.runVersion') IS NULL OR json_type(NEW.payload, '$.runVersion') <> 'integer' OR json_extract(NEW.payload, '$.runId') IS NOT json_extract(OLD.payload, '$.runId') OR json_extract(NEW.payload, '$.runVersion') IS NOT json_extract(OLD.payload, '$.runVersion') OR NEW.category IS NOT OLD.category OR NEW.type IS NOT OLD.type)
BEGIN
  SELECT RAISE(ABORT, 'terminal run_lifecycle stub must preserve runId + runVersion (value + storage class) + category + type');
END;
CREATE TRIGGER trg_run_terminal_key_promote BEFORE UPDATE OF category, type ON session_events
WHEN NOT (OLD.category = 'run_lifecycle' AND OLD.type IN ('run.completed', 'run.failed', 'run.interrupted'))
  AND NEW.category = 'run_lifecycle'
  AND NEW.type IN ('run.completed', 'run.failed', 'run.interrupted')
BEGIN
  SELECT RAISE(ABORT, 'session_events rows cannot be promoted to terminal run_lifecycle by UPDATE — terminal rows are INSERT-only');
END;
```

**Integrity protocol.** `prev_hash`, `row_hash`, `daemon_signature` are required; `participant_signature` is NULL-able and present only for sensitive events (approvals, policy changes, membership revocations). For un-compacted rows (`retention_class IS NULL`) the verifier recomputes the per-row chain hash + signature over the live `payload`. After compaction (`retention_class = 'audit_stub'`) the original canonical bytes are discarded, so `row_hash`/`daemon_signature` freeze as a commitment to the (now-gone) pre-compaction state and the **`stub_signature`** authenticates the surviving audit-stub bytes; range existence is additionally witnessed by the covering Merkle anchor in `pending_anchor_uploads` / `event_log_anchors`. The canonical serialization (RFC 8785 JCS) and the full verification order are specified in [Security Architecture § Audit Log Integrity](../security-architecture.md#audit-log-integrity) and [Spec-006 § Integrity Protocol](../../specs/006-session-event-taxonomy-and-audit-log.md#integrity-protocol) + [§ Post-Compaction Integrity](../../specs/006-session-event-taxonomy-and-audit-log.md#post-compaction-integrity). The `idx_session_events_run_terminal_once` partial unique index is the schema-level terminal-exactly-once backstop (Plan-006, campaign B11): a duplicate terminal `run_lifecycle` row for the same `(runId, runVersion)` epoch fails loud with a `UNIQUE` violation; NULL `runId`/`runVersion` rows bypass it (SQLite NULL-distinctness), so the Plan-004 terminal emitter (campaign B9) enforces the non-null-key precondition this index backstops. The engine semantics this backstop relies on are load-bearing, and each is cited to the official SQLite documentation: [expression indexes](https://sqlite.org/expridx.html) (the index keys on `json_extract(payload, …)` expressions), [partial indexes](https://sqlite.org/partialindex.html) (the `WHERE category = 'run_lifecycle' AND type IN (…)` filter), [UNIQUE-index enforcement](https://sqlite.org/lang_createindex.html#unique_indexes), and [NULL-distinctness](https://sqlite.org/nulls.html) (two NULLs are distinct for UNIQUE purposes, so NULL-key rows bypass the constraint). It ships via the additive migration `0NNN-run-lifecycle-terminal-backstop-index.ts`. The same migration installs the `trg_run_terminal_key_insert` / `trg_run_terminal_key_update` / `trg_run_terminal_key_promote` trigger trio — the projection-level CHECK-equivalent Spec-006's at-most-once-terminal-emission rule assigns to this schema work — which aborts terminal `run_lifecycle` writes whose `runId` / `runVersion` key is NULL **or the wrong storage class** (`json_type` must be `'text'` for `runId` and `'integer'` for `runVersion`, per the `RunId` string / any-run-progression-counter payload contract in [Spec-006 §Run Lifecycle](../../specs/006-session-event-taxonomy-and-audit-log.md#run-lifecycle-run_lifecycle) — a `"7"`-vs-`7` type-drifted key would otherwise bypass the storage-class-keyed UNIQUE index for exactly the malformed rows the backstop exists to catch). The INSERT leg closes the NULL-distinctness bypass the UNIQUE index cannot catch; the UPDATE leg (`BEFORE UPDATE OF payload, category, type`, keyed off `OLD` so a row that WAS terminal cannot escape by mutation) additionally aborts a **value-changing key rewrite** (`NEW` key `IS NOT` `OLD`, null-safe — a compactor bug rewriting `(R,7)` to another non-null pair would otherwise free the index slot for a duplicate terminal) and a **`category`/`type` de-scope** (flipping a terminal row out of the guarded set is the same escape), enforcing stub-preservation against the compactor across the row's whole retention life. The promote leg closes the inverse escape: an UPDATE re-typing a non-terminal row INTO the guarded set is rejected outright — terminal rows are INSERT-only — so a null-keyed promotion cannot slip past the OLD-keyed update leg and the NULL-distinct UNIQUE index (campaign B11 schema work, hardened by the W2.5 re-audit).

## Session Snapshots (Plan-001, extended by Plans 006, 015)

```sql
-- Owner: Plan-001 | Extended by: Plan-006, Plan-015
CREATE TABLE session_snapshots (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL,
  as_of_sequence        INTEGER NOT NULL,           -- snapshot reflects events up to this sequence (replay-cursor state)
  state_blob            BLOB NOT NULL,              -- serialized session state
  created_at            TEXT NOT NULL,
  -- Compaction hints (Plan-006 Tier 4 Phase 4, migration 0NNN-session-snapshots-compaction-cursor.ts):
  -- let replay/projection detect compacted regions without scanning session_events.
  has_compacted_ranges  INTEGER NOT NULL DEFAULT 0, -- boolean: 0 or 1; whether [.., as_of_sequence] contains audit_stub rows
  compacted_range_count INTEGER NOT NULL DEFAULT 0, -- count of distinct compacted ranges reflected in this snapshot
  FOREIGN KEY (session_id, as_of_sequence) REFERENCES session_events(session_id, sequence)
);

CREATE INDEX idx_session_snapshots_session ON session_snapshots(session_id, as_of_sequence);
```

---

## Queue and Intervention Tables (Plan-004)

```sql
-- Owner: Plan-004
CREATE TABLE queue_items (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  channel_id      TEXT,                       -- nullable for session-level items
  state           TEXT NOT NULL DEFAULT 'queued'
                  CHECK(state IN ('queued', 'admitted', 'superseded', 'canceled', 'expired')),
  priority        INTEGER NOT NULL DEFAULT 0, -- higher = more urgent
  payload         TEXT NOT NULL DEFAULT '{}', -- JSON: content, context, metadata
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_queue_items_session_state ON queue_items(session_id, state);
CREATE INDEX idx_queue_items_channel ON queue_items(channel_id) WHERE channel_id IS NOT NULL;

-- Owner: Plan-004 | Extended by: Spec-005 campaign B3 (client_idempotency_key intervention dedupe); Spec-004 campaign B2 (rollback type — targetPosition rides the payload JSON, no new column)
CREATE TABLE interventions (
  id                     TEXT PRIMARY KEY,
  target_run_id          TEXT NOT NULL,
  type                   TEXT NOT NULL
                         CHECK(type IN ('steer', 'interrupt', 'cancel', 'rollback')),
  state                  TEXT NOT NULL DEFAULT 'requested'
                         CHECK(state IN ('requested', 'accepted', 'applied', 'rejected', 'degraded', 'expired')),
  payload                TEXT NOT NULL DEFAULT '{}', -- JSON: type-specific fields
  expected_run_version   INTEGER NOT NULL,           -- MANDATORY fail-closed comparand (Spec-004 §Interfaces And Contracts / Plan-004 D-004-2)
  client_idempotency_key TEXT NOT NULL,              -- MANDATORY requester-generated UUID (participant client or daemon system-origination); replay-or-conflict intervention dedupe (Spec-005 §Required Behavior, campaign B3)
  result                 TEXT,                       -- JSON: outcome details
  initiator_id           TEXT,                       -- participant or system
  created_at             TEXT NOT NULL,
  resolved_at            TEXT,
  UNIQUE(target_run_id, client_idempotency_key)      -- identical retry replays the recorded outcome; key reuse with a differing payload rejects as intervention.idempotency_conflict — distinct grain from command_receipts.command_id (per-command crash-recovery dedupe)
);

CREATE INDEX idx_interventions_run ON interventions(target_run_id);
CREATE INDEX idx_interventions_state ON interventions(state) WHERE state IN ('requested', 'accepted');

-- Owner: Plan-004 | Extended by: Plan-015 (recovery + two-phase idempotency protocol, BL-051)
CREATE TABLE command_receipts (
  id                TEXT PRIMARY KEY,
  command_id        TEXT NOT NULL UNIQUE,         -- idempotency key (client-supplied)
  run_id            TEXT,
  status            TEXT NOT NULL
                    CHECK(status IN ('accepted', 'rejected', 'completed', 'failed')),
  -- BL-051 two-phase commit columns
  idempotency_class TEXT NOT NULL
                    CHECK(idempotency_class IN ('idempotent', 'compensable', 'manual_reconcile_only')),
  dedupe_key        TEXT,                         -- propagated to remote side for 'compensable' tools
  started_at        TEXT,                         -- set by Phase 2 optimistic CAS; NULL until claimed
  completed_at      TEXT,                         -- set by Phase 3; NULL until terminal-status
  created_at        TEXT NOT NULL
);

CREATE INDEX idx_command_receipts_run ON command_receipts(run_id) WHERE run_id IS NOT NULL;
-- Recovery sweep index: find in-flight receipts needing idempotency-class-based handling
CREATE INDEX idx_command_receipts_inflight ON command_receipts(run_id)
  WHERE started_at IS NOT NULL AND completed_at IS NULL;
```

---

## Driver and Runtime Binding Tables (Plan-005)

```sql
-- Owner: Plan-005 | Extended by: Plan-015 (recovery-aware persistence)
-- Provider-output defense-in-depth CHECKs (Plan-005 T2.1): contract_version and
-- resume_handle are provider-declared strings persisted at the write seam. The
-- DB CHECK layer bounds the SQLite-expressible part (length + NUL-rejection);
-- semver-shape validation is NOT expressible as a pure-SQLite CHECK and is
-- enforced at the write seam Zod guard (T2.2 runtime_bindings) using the
-- `semver` package. The 4096/64 length literals are the canonical bounds that
-- the T2.2 write-path guard reuses, so the two layers stay consistent.
CREATE TABLE runtime_bindings (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL,
  driver_name         TEXT NOT NULL,            -- e.g. 'claude', 'codex'
  contract_version    TEXT NOT NULL             -- canonical, identifying semver of driver contract (build metadata rejected by the T2.2 write-path Zod guard)
                      CHECK (length(contract_version) > 0 AND length(contract_version) <= 64 AND instr(contract_version, char(0)) = 0),
  cli_version_raw     TEXT                      -- verbatim provider-reported CLI version captured at binding write (Spec-005 §Required Behavior `cliVersion` report, campaign B3); NULL only on pre-B3 rows — the write path stores the pair or neither
                      CHECK (cli_version_raw IS NULL OR (length(cli_version_raw) > 0 AND length(cli_version_raw) <= 128 AND instr(cli_version_raw, char(0)) = 0)),
  cli_version_semver  TEXT                      -- parsed floor-compare form of the pair; the fail-closed floor gate (`driver.cli_version_unparseable`) runs before any binding write, so a stored pair is always parseable
                      CHECK ((cli_version_semver IS NULL) = (cli_version_raw IS NULL) AND (cli_version_semver IS NULL OR (length(cli_version_semver) > 0 AND length(cli_version_semver) <= 64 AND instr(cli_version_semver, char(0)) = 0))),
  resume_handle       TEXT                      -- provider-owned opaque handle
                      CHECK (resume_handle IS NULL OR (length(resume_handle) > 0 AND length(resume_handle) <= 4096 AND instr(resume_handle, char(0)) = 0)),
  runtime_metadata    TEXT NOT NULL DEFAULT '{}', -- JSON: provider-specific recovery data
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX idx_runtime_bindings_run ON runtime_bindings(run_id);

-- Owner: Plan-005
CREATE TABLE driver_capabilities (
  driver_name       TEXT NOT NULL,
  capability_flag   TEXT NOT NULL
                    CHECK(capability_flag IN (
                      'resume', 'steer', 'interactive_requests', 'mcp',
                      'tool_calls', 'reasoning_stream', 'model_mutation',
                      'structured_output', 'rollback', 'session_goals',
                      'callback_tools', 'subagents', 'cost_cap'
                    )),
  supported         INTEGER NOT NULL DEFAULT 0, -- boolean: 0 or 1
                    -- Campaign-B3/B6 widening note: the catch-up migration that widens the CHECK above MUST
                    -- backfill the six new flags (five B3 + B6's cost_cap) as supported=0 for every existing driver_name (undeclared =
                    -- unsupported, I-005-2); a pre-B3 seven-row cache would otherwise break the hydrator's exact-cardinality guard before any refresh could heal it.
  refreshed_at      TEXT NOT NULL,
  PRIMARY KEY (driver_name, capability_flag)
);

-- Owner: Plan-005
-- Per-tool metadata for the daemon's two-phase command-receipt protocol at
-- crash-recovery dispatch time (idempotency_class lookup without round-tripping
-- the driver per Spec-005:178-180). Normalized per-tool rows mirror the
-- per-flag-row shape of driver_capabilities.
CREATE TABLE driver_tools (
  driver_name        TEXT NOT NULL,
  tool_name          TEXT NOT NULL,
  idempotency_class  TEXT NOT NULL
                     CHECK(idempotency_class IN (
                       'idempotent', 'compensable', 'manual_reconcile_only'
                     )),
  description        TEXT,
  refreshed_at       TEXT NOT NULL,
  PRIMARY KEY (driver_name, tool_name)
);

-- Owner: Plan-005
-- Per-driver capability-contract metadata. The capability cache is keyed by driver_name
-- (driver_capabilities + driver_tools are per-driver children); this parent row holds the
-- single per-driver contract_version so cold-start hydration can reconstruct
-- GetCapabilitiesResult = { capabilities: { flags, contractVersion }, tools } WITHOUT
-- round-tripping the driver (Spec-005:178-180 cache-as-source-of-truth). Distinct from
-- runtime_bindings.contract_version, which records the version bound to a specific run.
-- Provider-output defense-in-depth CHECK (Plan-005 T2.1): `contract_version`
-- mirrors the `runtime_bindings.contract_version` bound (length + NUL-rejection,
-- 64-char ceiling). Semver-shape validation lives at the T2.4 write-path Zod
-- guard (the `semver` package) — not expressible as a pure-SQLite CHECK.
-- `contract_version` is a CANONICAL, IDENTIFYING semver string: build metadata
-- (SemVer §10, non-identifying) is rejected by the T2.4 write-path Zod guard, so
-- two byte-different strings can never denote the same contract version (which
-- would otherwise spuriously fire `runtime_node.capability_updated` on a
-- non-change).
CREATE TABLE driver_contract_meta (
  driver_name         TEXT PRIMARY KEY,
  contract_version    TEXT NOT NULL             -- canonical, identifying semver of the driver's advertised capability contract (build metadata rejected by the T2.4 write-path Zod guard)
                      CHECK (length(contract_version) > 0 AND length(contract_version) <= 64 AND instr(contract_version, char(0)) = 0),
  cli_version_raw     TEXT                      -- cached `cliVersion.raw` from the last capability refresh (Spec-005 §Required Behavior, campaign B3); NULL only on pre-B3 rows
                      CHECK (cli_version_raw IS NULL OR (length(cli_version_raw) > 0 AND length(cli_version_raw) <= 128 AND instr(cli_version_raw, char(0)) = 0)),
  cli_version_semver  TEXT                      -- cached parsed form; cold-start hydration MUST treat a NULL pair as a cache miss and refresh from the driver — the required `GetCapabilitiesResult.cliVersion` is never fabricated from cache
                      CHECK ((cli_version_semver IS NULL) = (cli_version_raw IS NULL) AND (cli_version_semver IS NULL OR (length(cli_version_semver) > 0 AND length(cli_version_semver) <= 64 AND instr(cli_version_semver, char(0)) = 0))),
  refreshed_at        TEXT NOT NULL             -- last capability-refresh write (matches driver_capabilities.refreshed_at cadence)
);
```

The build-metadata rejection above is grounded in the SemVer specification itself: per [Semantic Versioning 2.0.0 §10](https://semver.org/#spec-item-10), "Build metadata MUST be ignored when determining version precedence. Thus two versions that differ only in the build metadata, have the same precedence." (fetched 2026-06-15). Because `1.2.3+build.5` and `1.2.3+build.6` denote the SAME contract version under that precedence rule, persisting them as byte-distinct `contract_version` strings would let a non-change masquerade as a change. The shared write-path Zod guard (`assertValidContractVersion`, invoked from both the T2.2 `runtime_bindings` and T2.4 `driver_contract_meta` write paths) therefore REJECTS — rather than strips/normalizes — any value carrying build metadata, keeping the stored value byte-identical to what was validated and both `contract_version` columns canonical-identifying.

---

## Audit Log Crypto Tables (Plan-006)

```sql
-- Owner: Plan-006 | Migration: 0NNN-daemon-signing-keys.ts (Tier 4 Phase 2)
-- Per-session daemon Ed25519 signing keypair. Private key is sealed via the
-- OS keystore master key (@napi-rs/keyring v1.2.0 per Spec-022:146 — Keychain
-- kSecAttrAccessibleWhenUnlockedThisDeviceOnly on macOS / CRED_TYPE_GENERIC
-- CRED_PERSIST_LOCAL_MACHINE on Windows / Secret Service via libsecret +
-- kwallet6 + keyutils fallback on Linux). Public key is registered in the
-- session participant roster at join time per Spec-006:611. Sealed-key storage
-- lives in local SQLite (NOT shared-Postgres sessions) per ADR-004 SQLite-
-- local-state boundary — daemon-private secrets are per-machine.
CREATE TABLE daemon_signing_keys (
  session_id          TEXT PRIMARY KEY,
  public_key          BLOB NOT NULL,         -- Ed25519 32-byte public key
  sealed_private_key  BLOB NOT NULL,         -- Ed25519 private key sealed via OS keystore master key
  created_at          TEXT NOT NULL,
  rotated_at          TEXT                   -- non-NULL when key has been rotated per ADR-010
);

-- Owner: Plan-006 | Migration: 0NNN-pending-anchor-uploads.ts (Tier 4 Phase 3)
-- Durable partition-tolerance queue for Merkle anchors awaiting control-plane
-- upload. Unflushed anchors survive daemon restart without re-signing per
-- Plan-006:152. The (session_id, node_id, start_sequence, end_sequence) UNIQUE
-- constraint makes the T3.3 anchorRange() force-fire path (consumed by T3.2
-- compactor's anchor-before-compaction protocol per Spec-006 §Post-Compaction
-- Integrity) idempotent against re-entry of an identical range (the key dedups
-- genuine re-fires only — coverage semantics in the constraint comment below).
-- Node-scope (sentinel session_id) chains queue their local Merkle anchors here too, as the durable
-- LOCAL witness. In V1 those sentinel-partitioned rows are NOT upload candidates -- the upload worker
-- selects session-scoped rows only (the sentinel cannot satisfy event_log_anchors' non-null session_id
-- FK, and node-scope control-plane witnessing is a V1.1 extension per ADR-017 §Node-Scope Anchor
-- Witnessing). Their uploaded_at stays NULL by design in V1.
CREATE TABLE pending_anchor_uploads (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  node_id             TEXT NOT NULL,
  start_sequence      INTEGER NOT NULL,
  end_sequence        INTEGER NOT NULL,
  merkle_root         BLOB NOT NULL,         -- BLAKE3 binary Merkle tree root (RFC 9162 §2.1 odd-leaf duplication)
  root_signature      BLOB NOT NULL,         -- Ed25519 signature over merkle_root by daemon_signing_keys.sealed_private_key
  anchored_at         TEXT NOT NULL,         -- daemon-local timestamp at anchor computation
  uploaded_at         TEXT,                  -- non-NULL once control-plane confirms upload to event_log_anchors
  -- Durable retry/backoff state (partition-anchor queue durability decision, resolved per Plan-006 §Open Authoring Decisions (Category 2 — Audit-Surfaced)): survives daemon
  -- restart so upload retry resumes and the last failure is queryable for operator triage post-restart.
  attempt_count       INTEGER NOT NULL DEFAULT 0, -- upload attempts since enqueue; drives exponential backoff
  last_attempt_at     TEXT,                  -- daemon-local timestamp of most recent upload attempt; NULL until first attempt
  last_error          TEXT,                  -- last upload failure detail (operator triage); NULL on success or before first attempt
  -- end_sequence is part of the key: a cadence anchor [1,1000] and a wider compaction-covering anchor [1,5000] share start_sequence=1 and MUST coexist.
  -- "Covering anchor exists" (Spec-006 §Post-Compaction Integrity step 1) is a COVERAGE query (start_sequence <= range_start AND end_sequence >= range_end), NOT an exact-start match; the key only dedups genuine re-fires of the identical range.
  UNIQUE (session_id, node_id, start_sequence, end_sequence)
);

CREATE INDEX idx_pending_anchor_uploads_pending
  ON pending_anchor_uploads(session_id, anchored_at)
  WHERE uploaded_at IS NULL;
```

---

## Runtime Node Local Tables (Plan-003)

```sql
-- Owner: Plan-003
CREATE TABLE node_capabilities (
  node_id           TEXT NOT NULL,
  capability_key    TEXT NOT NULL,
  capability_value  TEXT NOT NULL DEFAULT '{}', -- JSON
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (node_id, capability_key)
);

-- Owner: Plan-003
CREATE TABLE node_trust_state (
  node_id           TEXT NOT NULL PRIMARY KEY,
  trust_level       TEXT NOT NULL DEFAULT 'untrusted',
                    -- V1 value set ratified by the Tier-6 audit (Plan-012 D-012-15): 'untrusted' | 'envelope_trusted'.
                    -- The shipped 0002 migration carries no CHECK (a retroactive CHECK requires a table rebuild);
                    -- enforcement is at the seams: Plan-012 owns the elevation write (parse-at-boundary) and its
                    -- policy evaluator treats any out-of-set value as 'untrusted' (fail-closed read; Spec-012 §Fallback Behavior).
  established_at    TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
```

---

## Workspace and Git Tables (Plan-009, Plan-010, Plan-011)

```sql
-- Owner: Plan-009
CREATE TABLE repo_mounts (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  node_id         TEXT NOT NULL,              -- owning runtime node (the node that can access the path)
  local_path      TEXT NOT NULL,              -- user-entered attach path (provenance)
  canonical_root  TEXT NOT NULL,              -- resolver output: absolute, symlink-resolved (envelope/dedupe key)
  vcs_type        TEXT NOT NULL DEFAULT 'git'
                  CHECK(vcs_type IN ('git', 'none')),
  state           TEXT NOT NULL DEFAULT 'attached'
                  CHECK(state IN ('attached', 'detached', 'archived')),
  attached_at     TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  metadata        TEXT NOT NULL DEFAULT '{}' -- JSON
);

CREATE INDEX idx_repo_mounts_session ON repo_mounts(session_id);
-- Active-mount uniqueness binds the CANONICAL root per owning node (Plan-009 D-009-7): two
-- entered aliases resolving to one root on one node are one mount; the same absolute path on two
-- different nodes is two distinct node-local filesystems (Spec-009 line 73) and both attach;
-- detached rows stay re-attachable as new rows.
CREATE UNIQUE INDEX idx_repo_mounts_active_root
  ON repo_mounts(session_id, node_id, canonical_root) WHERE state = 'attached';

-- Owner: Plan-009
CREATE TABLE workspaces (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  repo_mount_id   TEXT NOT NULL REFERENCES repo_mounts(id),
  execution_mode  TEXT NOT NULL DEFAULT 'read-only' -- read-only until a writable mode is explicitly selected (Spec-009; 'worktree' is the default WRITABLE run mode per ADR-006, not the row default)
                  CHECK(execution_mode IN ('read-only', 'branch', 'worktree', 'ephemeral clone')),
  fs_root         TEXT,                       -- resolved filesystem root
  state           TEXT NOT NULL DEFAULT 'provisioning'
                  CHECK(state IN ('provisioning', 'ready', 'busy', 'stale', 'archived')),
  metadata        TEXT NOT NULL DEFAULT '{}', -- JSON; lastError detail on a failed mode switch (Spec-009)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_workspaces_session ON workspaces(session_id);
CREATE INDEX idx_workspaces_repo ON workspaces(repo_mount_id);

-- Owner: Plan-010 (Tier-6 audit: provenance columns, active-branch uniqueness, cleanup stamp — D-010-5)
CREATE TABLE worktrees (
  id                    TEXT PRIMARY KEY,
  repo_mount_id         TEXT NOT NULL REFERENCES repo_mounts(id),
  created_by_session_id TEXT NOT NULL,              -- creating-session provenance (Spec-010 §State And Data Implications; session ids are event-sourced — no FK, matching session_id columns elsewhere)
  created_by_run_id     TEXT,                       -- creating-run provenance; NULL = pre-run explicit prepare (run ids are event-sourced, not FK-constrained)
  branch_name           TEXT NOT NULL,
  fs_root               TEXT NOT NULL,              -- filesystem path to worktree (under the daemon execution-roots dir, D-010-6)
  state                 TEXT NOT NULL DEFAULT 'creating'
                        CHECK(state IN ('creating', 'ready', 'dirty', 'merged', 'retired', 'failed')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  cleaned_at            TEXT                        -- async disk-cleanup stamp (retire records state; the sweep stamps cleanup)
);

CREATE INDEX idx_worktrees_repo ON worktrees(repo_mount_id);
-- At most one live checkout per (mount, branch): mirrors git's own constraint — a checkout existing
-- on disk (any non-retired, non-failed state, including 'merged') still holds the branch. Race arbiter
-- for the provenance-split collision policy (Spec-010 §Resolved Questions).
CREATE UNIQUE INDEX idx_worktrees_active_branch ON worktrees(repo_mount_id, branch_name)
  WHERE state NOT IN ('retired', 'failed');

-- Owner: Plan-010 (Tier-6 audit: TTL + cleanup bookkeeping — D-010-5)
CREATE TABLE ephemeral_clones (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  clone_root      TEXT NOT NULL,              -- filesystem path (under the daemon execution-roots dir, D-010-6)
  branch_name     TEXT NOT NULL,              -- head branch inside the clone (caller-supplied or slug-derived at prepare; the status read exposes it — Spec-010 §Interfaces)
  cleanup_policy  TEXT NOT NULL DEFAULT 'on_run_complete'
                  CHECK(cleanup_policy IN ('on_run_complete', 'manual')),
  state           TEXT NOT NULL DEFAULT 'creating'
                  CHECK(state IN ('creating', 'ready', 'retired', 'failed')),
  expires_at      TEXT NOT NULL,              -- TTL deadline (daemon config, default 24h; Spec-009 §Ephemeral Clone Lifecycle)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  cleaned_at      TEXT                        -- async disk-cleanup stamp
);

CREATE INDEX idx_ephemeral_clones_workspace ON ephemeral_clones(workspace_id);
CREATE INDEX idx_ephemeral_clones_sweep ON ephemeral_clones(state, expires_at);  -- cleanup-tick scan

-- Owner: Plan-010 | Extended by: Plan-011
-- Polymorphic root carrier (Tier-6 audit, D-010-5): worktree-mode rows reference the worktree,
-- ephemeral-clone rows the clone, branch-mode rows neither (the main checkout carries no Plan-010 root row).
CREATE TABLE branch_contexts (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  worktree_id        TEXT REFERENCES worktrees(id),
  ephemeral_clone_id TEXT REFERENCES ephemeral_clones(id),
  base_branch        TEXT NOT NULL,
  head_branch        TEXT NOT NULL,
  upstream_ref       TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  CHECK (worktree_id IS NULL OR ephemeral_clone_id IS NULL)
);

CREATE INDEX idx_branch_contexts_workspace ON branch_contexts(workspace_id);
CREATE UNIQUE INDEX idx_branch_contexts_worktree_workspace ON branch_contexts(worktree_id, workspace_id) WHERE worktree_id IS NOT NULL;  -- one binding row per (workspace, worktree) — D-010-15 upsert; the worktree-keyed BranchContextRead resolves on the pair

-- Owner: Plan-010 (Tier-6 audit, D-010-16)
-- Per-run execution binding (Spec-010 §State And Data Implications: execution mode as run setup data):
-- which workspace/mode/root a repo-bound run executes against. run_id is event-sourced (runs live in
-- the event log, not a table) — PRIMARY KEY without FK. released_at stamps run-terminal release; a terminal-source rollback clears it atomically with the run's re-open, and a rollback composite ending without a confirmed rewind restores it (campaign B2 — Spec-004 §Required Behavior; the campaign's Plan-010 bundle owns the implementing task).
CREATE TABLE run_execution_contexts (
  run_id             TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,                  -- event-sourced session id (no FK, matching session_id columns elsewhere)
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  execution_mode     TEXT NOT NULL
                     CHECK(execution_mode IN ('read-only', 'branch', 'worktree', 'ephemeral clone')),
  execution_root     TEXT NOT NULL,
  git_common_dir     TEXT NOT NULL,                  -- `git rev-parse --git-common-dir` (absolute) captured at context creation: the surviving canonical git dir for snapshot-ref ops, so Plan-010 T5.3 ref pruning outlives a worktree retirement of execution_root (worktree mode → main repo git dir; branch/read-only → <root>/.git; ephemeral clone → the clone's own git dir, refs sharing the clone's disposal lifecycle)
  worktree_id        TEXT REFERENCES worktrees(id),
  ephemeral_clone_id TEXT REFERENCES ephemeral_clones(id),
  branch_context_id  TEXT REFERENCES branch_contexts(id),
  created_at         TEXT NOT NULL,
  released_at        TEXT,
  -- Mode-conditional identity (Tier-6 audit): the mode names exactly which root id is
  -- present, and every writable mode carries its branch context (Spec-010 §State And
  -- Data Implications); read-only carries none of the three.
  CHECK (
    (execution_mode = 'read-only' AND worktree_id IS NULL AND ephemeral_clone_id IS NULL AND branch_context_id IS NULL)
    OR (execution_mode = 'branch' AND worktree_id IS NULL AND ephemeral_clone_id IS NULL AND branch_context_id IS NOT NULL)
    OR (execution_mode = 'worktree' AND worktree_id IS NOT NULL AND ephemeral_clone_id IS NULL AND branch_context_id IS NOT NULL)
    OR (execution_mode = 'ephemeral clone' AND ephemeral_clone_id IS NOT NULL AND worktree_id IS NULL AND branch_context_id IS NOT NULL)
  )
);

CREATE INDEX idx_run_execution_contexts_workspace ON run_execution_contexts(workspace_id);

-- Owner: Plan-011
CREATE TABLE diff_artifacts (
  id                    TEXT PRIMARY KEY,
  artifact_manifest_id  TEXT NOT NULL REFERENCES artifact_manifests(id),  -- every diff_artifact links to its minted manifest (CP-011-2; the diff is the manifest's payload, D-014-1 never-payload-less). The session is reached via this FK (artifact_manifests.session_id NOT NULL); a manifest-less row would be session-unreachable.
  run_id                TEXT,                 -- nullable: present for run_attributed, absent for workspace_fallback (Spec-011:44/58 — a fallback artifact must not imply precise run attribution; D-011-2)
  workspace_id          TEXT REFERENCES workspaces(id),  -- nullable mirror of run_id: present for workspace_fallback (the durable workspace-level provenance Spec-011:44 mandates — D-011-4 persists what the wire's workspace_fallback.workspaceId carries; the prior schema dropped it, treating the workspace as a transient mint-time resolver), null for run_attributed (whose workspace is reachable via the run's run_execution_contexts.workspace_id). FK because workspaces is table-backed, unlike event-sourced run_id/session_id.
  attribution_mode      TEXT NOT NULL         -- Spec-011:52/58 provenance quality (D-011-2)
                        CHECK(attribution_mode IN ('run_attributed', 'workspace_fallback')),
  base_ref              TEXT NOT NULL,
  head_ref              TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  CHECK(
    (attribution_mode = 'run_attributed' AND run_id IS NOT NULL AND workspace_id IS NULL)
    OR (attribution_mode = 'workspace_fallback' AND run_id IS NULL AND workspace_id IS NOT NULL)
  )  -- biconditional (D-011-2, D-011-4): run_attributed binds to its originating run (its workspace reached via that run's run_execution_contexts.workspace_id, so workspace_id is null); a workspace_fallback artifact MUST NOT carry a run_id (else it would imply the precise attribution it explicitly lacks, contradicting the run_id comment above + Spec-011:44/52/58) and MUST carry workspace_id (the durable workspace-level label, mirroring the wire union). The prior one-way form (<> OR) admitted a fallback row with a non-null run_id; the prior schema also dropped workspace_id entirely (KscWH).
);

CREATE INDEX idx_diff_artifacts_run ON diff_artifacts(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX idx_diff_artifacts_workspace ON diff_artifacts(workspace_id) WHERE workspace_id IS NOT NULL;

-- Owner: Plan-011
CREATE TABLE pr_preparations (
  id                  TEXT PRIMARY KEY,
  branch_context_id   TEXT NOT NULL REFERENCES branch_contexts(id),
  state               TEXT NOT NULL DEFAULT 'draft'
                      CHECK(state IN ('draft', 'ready', 'submitted', 'merged', 'abandoned')),
  proposal_blob       TEXT,                   -- JSON: title, description, reviewers
  target_branch       TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE INDEX idx_pr_preparations_branch ON pr_preparations(branch_context_id);
```

---

## Artifact Tables (Plan-014)

```sql
-- Owner: Plan-014
-- Tier-7 audit (NS-19): + subject, size_bytes, annotations realize the OCI manifest envelope (D-014-1, D-014-2);
--   + replication_status realizes the Spec-014:66 manifest-first replication surface (A-014-3) — nullable;
--   the multi-state CHECK the audit deferred (anti-fabrication) arrived 2026-07-08: the cross-node relay
--   amendment spec-names the full value set (Spec-014 §Cross-Node Artifact Relay (V1)); see note below;
--   + relay_cek_ciphertext arrived 2026-07-09 (publisher-retained CEK, Spec-014 Publish step 1).
CREATE TABLE artifact_manifests (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,
  run_id             TEXT,
  artifact_type      TEXT NOT NULL              -- Spec-014 §Interfaces And Contracts discriminator (D-014-4)
                     CHECK(artifact_type IN ('file', 'diff', 'summary', 'log', 'design', 'workflow_output')),
  subject            TEXT REFERENCES artifact_manifests(id),  -- OCI `subject`: NULL for originals; a derivative (redacted/summarized shareable form) points to its source manifest, never an in-place UPDATE of the original (I-014-2, Spec-014 §State And Data Implications, A-014-4)
  visibility         TEXT NOT NULL DEFAULT 'local-only'
                     CHECK(visibility IN ('local-only', 'shared')),
  state              TEXT NOT NULL DEFAULT 'pending'
                     CHECK(state IN ('pending', 'published', 'superseded')),
  content_hash       TEXT NOT NULL,              -- SHA-256 content address (OCI `digest`); intrinsic to a content-addressed manifest (I-014-1), set at insert by the writing producer (AttachmentIngest or ArtifactPublish) from its own payload — D-014-1
  size_bytes         INTEGER NOT NULL,           -- OCI manifest-descriptor `size` (payload byte length); set at insert by the writing producer from its own payload, never a payload-less row — D-014-1
  annotations        TEXT NOT NULL DEFAULT '{}', -- OCI `annotations`: JSON-encoded string→string map (first-class OCI manifest property, not freeform `metadata`) — D-014-1, D-014-2
  replication_status TEXT                        -- A-014-3 surface; value set spec-named by the 2026-07-08 relay amendment (mirrors ArtifactManifest.replicationStatus?: pending_replication while payload transfer is pending; pinned once every chunk is relay-acknowledged — the offline-availability guarantee attaches only then; over_cap / quota_exceeded = honest publisher-local degradation; expired = TTL/eviction). NULL = local-only artifact with no replication surface.
                     CHECK(replication_status IN ('pending_replication', 'pinned', 'over_cap', 'quota_exceeded', 'expired')),
  relay_cek_ciphertext BLOB,                  -- publisher-retained CEK for the relay pin, wrapped by the Spec-022 daemon master key; NULL for local-only artifacts, set at the first relay-bound publish — before any pin: a solo-session publish uploads nothing and stays pending_replication yet retains the CEK, so the first re-publish performs the initial pin under the SAME CEK. Re-publish re-wraps this SAME CEK for new recipients (the pinned ciphertext is under it; the relay holds only recipient-wrapped copies) — without it the publisher could not extend late-join access except by re-encrypting + re-uploading under a fresh key. Deliberately not a per-participant erasure target: dies with the manifest row or the daemon master key (Spec-022 §PII Data Map artifact-payload posture). Spec-014 Publish step 1.
  metadata           TEXT NOT NULL DEFAULT '{}', -- JSON: freeform daemon-side provenance/media-type/etc. — distinct from the OCI `annotations` map (own column above)
  created_at         TEXT NOT NULL,
  CHECK(subject IS NULL OR subject <> id)        -- I-014-2: a derivative points to a *distinct* source manifest, never itself (no self-referential subject; same guard pattern as run_links parent<>child)
);

CREATE INDEX idx_artifact_manifests_session ON artifact_manifests(session_id);
CREATE INDEX idx_artifact_manifests_run ON artifact_manifests(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX idx_artifact_manifests_hash ON artifact_manifests(content_hash);
CREATE INDEX idx_artifact_manifests_subject ON artifact_manifests(subject) WHERE subject IS NOT NULL;

-- Owner: Plan-014
CREATE TABLE artifact_payload_refs (
  id              TEXT PRIMARY KEY,
  manifest_id     TEXT NOT NULL REFERENCES artifact_manifests(id),
  storage_path    TEXT NOT NULL,              -- filesystem path or CAS key
  media_type      TEXT NOT NULL,              -- MIME type
  size_bytes      INTEGER NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_artifact_payload_refs_manifest ON artifact_payload_refs(manifest_id);

-- Owner: Plan-014 (2026-07-09 cross-node relay amendment)
-- The daemon-local durable artifact-encryption keypair — one row per participant on this node
-- (node scoping is the database itself: each daemon holds its own store). Relay CEKs are wrapped
-- to this key, NEVER to the ADR-010 session-ephemeral X25519 keys (those are zeroed at session
-- end — wrapping to them would orphan every relay-held CEK on the first restart and silently
-- void the offline-fetch guarantee). The private half is wrapped by the Spec-022 daemon master
-- key (same custody + backup-exclusion posture as participant_keys); the public half is announced
-- in-session as an Ed25519-identity-signed attestation (Spec-014 Publish step 3). Rotation
-- RETIRES rather than replaces: a rotated-out key stays in this table (retired_at set, never used
-- for new wraps) until every artifact_relay_recipients row bearing its thumbprint is delivered or
-- TTL-expired — bounded by the 30 d 'extended'-tier ceiling — because a within-TTL pinned blob
-- wrapped to it must stay fetchable while the publisher is offline. Hence one row per
-- (participant, key_thumbprint), not one per participant; exactly one active row per participant.
-- Erasure is participant-keyed, so it destroys active and retired keys together (Spec-022 Path 1).
CREATE TABLE artifact_encryption_keys (
  participant_id        TEXT NOT NULL,
  key_thumbprint        TEXT NOT NULL,   -- matches artifact_relay_recipients.key_thumbprint (post-restart/rotation key selection)
  encrypted_private_key BLOB NOT NULL,   -- X25519 private half, master-key-wrapped (nonce || ciphertext || tag — the D-022-2 wire form)
  public_key            BLOB NOT NULL,   -- X25519 public half (attested to session peers)
  created_at            TEXT NOT NULL,
  retired_at            TEXT,            -- NULL = the active key; non-NULL = retained for undelivered/within-TTL blobs only
  PRIMARY KEY (participant_id, key_thumbprint)
);

-- Exactly one active (non-retired) artifact key per participant on this node.
CREATE UNIQUE INDEX idx_artifact_encryption_keys_active
  ON artifact_encryption_keys(participant_id) WHERE retired_at IS NULL;
```

> **Tier-7 audit (NS-19) — ratified design (Plan-014 → `approved`).** `artifact_manifests.subject` (OCI `subject`, self-referential FK — derivative-not-mutation per I-014-2, guarded by a table-level `CHECK(subject IS NULL OR subject <> id)` so no manifest is its own subject — a derivative must point to a _distinct_ source, the same self-reference guard pattern as `run_links` parent≠child), `artifact_manifests.size_bytes` (OCI manifest-descriptor `size`), and `artifact_manifests.annotations` (OCI `annotations`, a first-class string→string map per the [OCI image-manifest spec](https://github.com/opencontainers/image-spec/blob/main/manifest.md)) realize the OCI envelope per D-014-1. **`content_hash`/`size_bytes` are `NOT NULL`:** a content-addressed manifest's `digest` is intrinsic to its identity (I-014-1), and each producer (Plan-014 Task 2 AttachmentIngest, Task 3 ArtifactPublish) computes the SHA-256 + byte length from its own payload and inserts its manifest with both columns set in the same transaction as the payload-ref — the two are independent producers, each writing its own manifest (so the `artifactId` AttachmentIngest returns resolves from the ingest-written manifest, not a later publish), so neither is ever NULL and no payload-less manifest is ever read — this is 1:1 with the **required** `digest`/`size` fields on the `ArtifactManifest` wire shape ([api-payload-contracts.md](../contracts/api-payload-contracts.md)). **D-014-2 (OCI `annotations` reciprocity):** `annotations` is its own column rather than riding inside `metadata` JSON, so the at-rest shape is 1:1 with the wire — `ArtifactReadResponse.annotations` is a field distinct from `metadata` in [api-payload-contracts.md](../contracts/api-payload-contracts.md) — and consistent with `subject`/`size_bytes` getting dedicated columns; `metadata` stays purely freeform. `artifact_manifests.replication_status` (A-014-3) realizes the `Spec-014 §Fallback Behavior` manifest-first replication surface — the column exists (spec-required: shared artifacts replicate manifest-first with deferred payload, `Spec-014 §Resolved Questions and V1 Scope Decisions` + `Spec-014 §Fallback Behavior`), nullable, and V1 writes the spec-named `pending_replication` while a shared artifact awaits payload transfer; it surfaces on the wire as the optional `ArtifactManifest.replicationStatus?` field (1:1 at-rest↔wire). It carried **no multi-state `CHECK`** at the audit: `Spec-014 §Fallback Behavior` named only `pending_replication` ("or equivalent"), so terminal/failed values were a deferred owner refinement — none was invented there (anti-fabrication). This schema edit + the `api-payload-contracts.md` artifact-wire edit + Plan-014 CP-014-1 landed as one ratified bundle in the NS-19 audit swap. **(2026-07-08: the deferred refinement arrived — the [Spec-014 §Cross-Node Artifact Relay (V1)](../../specs/014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1) amendment spec-names the full value set `pending_replication | pinned | over_cap | quota_exceeded | expired`, so the CHECK above now exists; the wire mirror stays `ArtifactManifest.replicationStatus?`.)**

---

## Approval Tables (Plan-012)

The 9 canonical approval categories: `tool_execution`, `file_write`, `network_access`, `destructive_git`, `user_input`, `plan_approval`, `mcp_elicitation`, `gate`, `human_phase_contribution`.

```sql
-- Owner: Plan-012 (amended by the Tier-6 plan-readiness audit, D-012-2)
CREATE TABLE approval_requests (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL,        -- owning session (Spec-012 line 58; Spec-006 §Approval Flow payload; projection key);
                                              -- no local FK target (sessions are control-plane rows per ADR-004)
  run_id                TEXT NOT NULL,        -- no REFERENCES: run state is event-sourced (ADR-017; interventions precedent)
  requested_by          TEXT NOT NULL,        -- requester actor (participant or agent actor id; Spec-012 line 58)
  category              TEXT NOT NULL
                        CHECK(category IN (
                          'tool_execution', 'file_write', 'network_access', 'destructive_git',
                          'user_input', 'plan_approval', 'mcp_elicitation', 'gate',
                          'human_phase_contribution'                              -- SA-12 addition; mirrors Spec-012 canonical enum
                        )),
  scope                 TEXT NOT NULL,        -- requested scope descriptor
  resource_descriptor   TEXT NOT NULL DEFAULT '{}', -- target resource details (JSON; Spec-012 line 96 'must include')
  ask_id                TEXT,                 -- originating driver_ask askId, set iff the request was minted by the
                                              -- CP-012-6 driver-ask normalizer (Spec-012 §Resolved Questions, Part-B
                                              -- fail-closed follow-up 2026-07-17); rebuilt from approval.requested.askId
                                              -- at replay (D-012-6/D-012-7) so outcome/expiry routing to the native
                                              -- ask survives restart with multiple in-flight asks on one run
  expiry_at             TEXT,                 -- ISO 8601, nullable for no-expiry (equals the ask's expiresAt when
                                              -- ask_id is set — the Spec-012 one-shared-deadline rule)
  state                 TEXT NOT NULL DEFAULT 'pending'
                        CHECK(state IN ('pending', 'approved', 'rejected', 'expired', 'canceled')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,        -- last state-transition instant (expiry/cancel carry no resolution row)
  CHECK (ask_id IS NULL OR expiry_at IS NOT NULL)
                                              -- an ask-associated (normalizer-minted) row always carries the shared
                                              -- deadline: ask_id without expiry_at could never re-arm the durable
                                              -- timeout after restart, re-creating an unbounded pending ask
                                              -- (Spec-012 Part-B fail-closed follow-up 2026-07-17; replay-side
                                              -- backstop — the approval-flow emission refinement enforces the same
                                              -- askId ⇒ expiryAt pairing origin-blind at parse, so an invalid mint
                                              -- refuses before it is durable; the T1.3 migration copies this CHECK
                                              -- verbatim and pins it in its tests)
);

CREATE INDEX idx_approval_requests_run ON approval_requests(run_id);
CREATE INDEX idx_approval_requests_session ON approval_requests(session_id);
CREATE INDEX idx_approval_requests_state ON approval_requests(state) WHERE state = 'pending';
CREATE UNIQUE INDEX idx_approval_requests_ask ON approval_requests(run_id, ask_id) WHERE ask_id IS NOT NULL;
-- UNIQUE (run_id, ask_id): exactly one approval row per native ask — a normalizer retry or replay
-- re-mint collides here instead of persisting a duplicate pending row whose outcome/expiry routing
-- would then fan out or pick arbitrarily (Spec-012 one ask↔one approval; duplicate-normalization test
-- rides the T1.3 migration suite)

-- Owner: Plan-012
CREATE TABLE approval_resolutions (
  request_id               TEXT PRIMARY KEY REFERENCES approval_requests(id),
                                              -- PK = the durable wire id (approvalRequestId): enforces the 1:1 decision row
                                              -- and keeps every column event-derivable for peer/replay rebuild (I-012-9)
  approver_id              TEXT NOT NULL,     -- participant recorded as approver (D-012-12: node-owner binding on the
                                              -- local socket; verified PASETO sub on authenticated surfaces; Spec-012 line 97)
  decision                 TEXT NOT NULL
                           CHECK(decision IN ('approved', 'rejected')),
  effective_scope          TEXT NOT NULL,     -- granted scope; = request scope unless approver narrowed it (Spec-012 line 59);
                                              -- never broader than requested (domain invariant; Phase-2 enforced)
  remembered_scope_kind    TEXT               -- 'run' | 'session' when remembering was requested; NULL otherwise (Spec-012 line 118)
                           CHECK(remembered_scope_kind IS NULL OR remembered_scope_kind IN ('run', 'session')),
  remembered_scope_pattern TEXT,              -- resource-matching pattern for the remembered rule, nullable
  resolved_at              TEXT NOT NULL,
  audit_metadata           TEXT NOT NULL DEFAULT '{}' -- JSON: audit trail
);

-- Owner: Plan-012
CREATE TABLE remembered_approval_rules (
  id                         TEXT PRIMARY KEY,
  session_id                 TEXT NOT NULL,   -- rules are session-scoped (Spec-012 line 82); membership-invalidation key
  participant_id             TEXT NOT NULL,   -- the GRANTOR (approver who opted in); audit + membership-invalidation key, not a match key (D-012-10)
  node_id                    TEXT NOT NULL,   -- executing node whose trust envelope the grant rides; node-trust-invalidation key (Spec-012 line 91)
  run_id                     TEXT,            -- originating run; NOT NULL iff scope_kind = 'run' (the Spec-012 line 111 'this run only' binding)
  created_from_request_id    TEXT NOT NULL REFERENCES approval_resolutions(request_id), -- origin decision (Spec-012 line 106 audit history); the durable wire id carried on approval.remembered, so the FK rebuilds byte-equal from events alone (I-012-9)
  category                   TEXT NOT NULL
                             CHECK(category IN (
                               'tool_execution', 'file_write', 'network_access', 'destructive_git',
                               'user_input', 'plan_approval', 'mcp_elicitation', 'gate',
                               'human_phase_contribution'                              -- SA-12 addition; mirrors Spec-012 canonical enum
                             )),
  scope_kind                 TEXT NOT NULL
                             CHECK(scope_kind IN ('run', 'session')),  -- explicit enum, not free-form (Spec-012 line 118)
  scope_pattern              TEXT,            -- resource-matching pattern within the kind boundary; NULL = category-wide within
                                              -- (session, node, kind); semantics are category-derived (D-012-10)
  granted_at                 TEXT NOT NULL,
  revoked_at                 TEXT,            -- nullable; set when rule is invalidated
  invalidation_trigger       TEXT
                             CHECK(invalidation_trigger IS NULL OR invalidation_trigger IN
                               ('explicit', 'membership_change', 'node_trust_change', 'session_end')),
  CHECK((revoked_at IS NULL) = (invalidation_trigger IS NULL)),  -- co-presence: a revocation always records its trigger
  CHECK((scope_kind = 'run') = (run_id IS NOT NULL))             -- run-kind rules bind to their originating run
);

CREATE INDEX idx_remembered_rules_participant ON remembered_approval_rules(participant_id, category);
CREATE INDEX idx_remembered_rules_session ON remembered_approval_rules(session_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_remembered_rules_node ON remembered_approval_rules(node_id) WHERE revoked_at IS NULL;
```

---

## Cross-Node Dispatch Tables (Plan-027)

Stores per-daemon ApprovalRecord envelopes for Spec-024. The same logical dispatch may produce one caller-local row and one target-local row, distinguished by `local_role`. Dispatch payloads, action payloads, and result payloads are not stored here; the durable audit artifact is the dual-signed ApprovalRecord envelope plus lifecycle metadata.

```sql
-- Owner: Plan-027
CREATE TABLE cross_node_dispatch_approvals (
  id                    TEXT PRIMARY KEY,
  dispatch_id           TEXT NOT NULL,
  session_id            TEXT NOT NULL,
  local_role            TEXT NOT NULL
                        CHECK(local_role IN ('caller', 'target')),
  caller_participant_id TEXT NOT NULL,
  target_participant_id TEXT NOT NULL,
  target_node_id        TEXT NOT NULL,
  capability            TEXT NOT NULL,
  request_body_hash     TEXT NOT NULL CHECK(request_body_hash GLOB 'b3:*'),
  approval_record_json  TEXT,                 -- JSON: Spec-024 dual-token ApprovalRecord envelope; NULL until decision
  caller_token_jti      TEXT NOT NULL,
  approver_token_jti    TEXT,                 -- NULL until target-owner decision exists
  decision              TEXT
                        CHECK(decision IS NULL OR decision IN ('allow', 'deny')),
  state                 TEXT NOT NULL DEFAULT 'requested'
                        CHECK(state IN (
                          'requested', 'approved', 'denied', 'executed',
                          'completed', 'failed', 'expired', 'rejected'
                        )),
  created_at            TEXT NOT NULL,
  resolved_at           TEXT,
  expires_at            TEXT NOT NULL,
  UNIQUE(dispatch_id, local_role)
);

CREATE INDEX idx_cross_node_dispatch_approvals_session_state
  ON cross_node_dispatch_approvals(session_id, state);

CREATE INDEX idx_cross_node_dispatch_approvals_target
  ON cross_node_dispatch_approvals(target_node_id, state);

CREATE INDEX idx_cross_node_dispatch_approvals_expiry
  ON cross_node_dispatch_approvals(expires_at)
  WHERE state IN ('requested', 'approved', 'executed');
```

Caller-local durable record of an outbound cross-node dispatch whose result the caller has not yet observed, backing the run-idle exemption (campaign B17). While an open row — `closed_at IS NULL` **and** `expires_at > now` — names a run as its **originating run**, the `runHasPendingCrossNodeDispatch(runId)` predicate holds and the run-idle sweep hard-skips that run (per [Spec-024 § Cross-Node Failure Semantics](../../specs/024-cross-node-dispatch-and-approval.md#cross-node-failure-semantics); consumed by [Plan-016](../../plans/016-multi-agent-channels-and-orchestration.md) T2.7's idle-reaper seam — a hard skip, not an activity-timestamp bump). The expiry bound is **part of the predicate**, not merely a sweep side effect: an overdue open row (past `expires_at`, not yet closed by the expiry sweep) does not satisfy the predicate, so a caller restarting after the deadline never hard-skips the run on a stale row before the sweep has run. The daemon writes the row **before** the relay send (INSERT-before-relay-write ordering), so the initiating run's idle-exemption is durable across a caller restart at any point in the send path — a crash between the intent record and the relay write still leaves the run correctly idle-protected until its window closes. This record backs the run-idle hard-skip; it is **not** a resend outbox — the caller token and action payload are deliberately not retained here (see the custody sentence below), so a dispatch lost before its relay send is bounded by `expires_at` rather than silently resent or protecting the run indefinitely. The row is **closed in place** at conclusion — `closed_at` / `close_reason` stamped, the row is never deleted at close — so a restart rebuilds each run's open pending window from the open rows alone and never resurrects a concluded window. The terminal-observation event append (`dispatch.result_observed`, or `dispatch.approval_observed` for a denial) and this row's closure **commit in one SQLite transaction**: restart rebuilds from the rows alone, so a non-atomic close would either idle-protect a concluded dispatch to its expiry bound (event appended, row still open) or destroy the only recovery record before its audit event exists (row closed, event lost). This single-transaction atomicity is scoped to **terminal-observation** closes (`close_reason = 'observed_terminal'`) — the only closes that append an event; the other two close reasons append nothing and carry no atomicity obligation: the expiry sweep's `expiry_bound` close of an unobserved window, and the `send_failed` close, where a synchronous relay-send failure is caller-observed but precedes `dispatch.sent`, so (Spec-006 registers no send-failure event, and a terminal the caller never observes appends nothing) the caller closes the row in place immediately — the closed row standing as the durable record — rather than holding the run idle-protected to the expiry bound, with the expiry sweep remaining the backstop only for a crash during send. A terminal observed **after** the row has already closed `expiry_bound` or been pruned — the target's buffered-delivery window equals the caller's `expires_at`, so clock skew or delivery latency can straddle the edge — does not mutate, reopen, or re-close the row: the verified observation appends its `dispatch.result_observed` / `dispatch.approval_observed` event **idempotently, event-only**, deduped per `dispatch_id` against the prior event (an `observed_terminal` row implies its event exists; post-prune the event log is the dedupe source), so the audit trail is fulfilled while closed-in-place and never-resurrect hold and the restart rebuild (rows alone) is untouched. The complementary `dispatch.sent` event stays base-payload per [Spec-006 § Cross-Node Dispatch](../../specs/006-session-event-taxonomy-and-audit-log.md#cross-node-dispatch-cross_node_dispatch); it is the audit record, not the rebuild source. Only routing/liveness metadata lives here — ApprovalRecord envelopes, PASETO tokens, action payloads, and result payloads do not (those follow the `cross_node_dispatch_approvals` custody rules above).

```sql
-- Owner: Plan-027
CREATE TABLE cross_node_pending_dispatch (
  dispatch_id       TEXT PRIMARY KEY,     -- one caller-local pending row per dispatch
  session_id        TEXT NOT NULL,
  run_id            TEXT NOT NULL,        -- the ORIGINATING run; runHasPendingCrossNodeDispatch(runId) keys on this
  target_node_id    TEXT NOT NULL,        -- routing/audit context only, never authoritative
  capability        TEXT NOT NULL,        -- dispatched capability, for surfacing/audit context
  caller_token_jti  TEXT NOT NULL,        -- correlates to caller_token / the caller's cross_node_dispatch_approvals(dispatch_id, local_role='caller') row
  expires_at        TEXT NOT NULL,        -- caller-local clock bound = caller_token.exp + result-buffer window; the unobserved-conclusion backstop
  created_at        TEXT NOT NULL,        -- stamped at INSERT, BEFORE the relay send
  closed_at         TEXT,                 -- NULL = window open (pending); stamped in place when the window closes
  close_reason      TEXT                  -- how the window closed; the observed outcome discriminator lives in the dispatch.result_observed event, not duplicated here
                    CHECK (close_reason IS NULL OR close_reason IN ('observed_terminal', 'expiry_bound', 'send_failed')),
  -- closed_at and close_reason are set together: a row is either fully open or fully closed
  CHECK ((closed_at IS NULL) = (close_reason IS NULL))
);

-- runHasPendingCrossNodeDispatch(runId) hot query: partial index on open rows; the predicate adds `AND expires_at > now`.
CREATE INDEX idx_cross_node_pending_dispatch_open_by_run
  ON cross_node_pending_dispatch(run_id)
  WHERE closed_at IS NULL;

-- The caller-local expiry sweep that closes windows at the clock bound (close_reason = 'expiry_bound').
CREATE INDEX idx_cross_node_pending_dispatch_expiry
  ON cross_node_pending_dispatch(expires_at)
  WHERE closed_at IS NULL;
```

Retention: a closed row is pruned once `expires_at` has elapsed — a concrete caller-local bound, `caller_token.exp` + the 5-minute result-buffer window ([Plan-027 § Data And Storage Changes](../../plans/027-cross-node-dispatch-and-approval.md#data-and-storage-changes) Implementation Step 9 / [Spec-024 § Cross-Node Failure Semantics](../../specs/024-cross-node-dispatch-and-approval.md#cross-node-failure-semantics)); no separate audit-retention window governs this table, because the durable audit trail of the observed outcome is the caller's `dispatch.result_observed` event, not this transient liveness row. Migration: additive `0NNN-cross-node-pending-dispatch.ts`, shipped in the single shared migration chain (`applyMigrations(db)` in `migration-runner.ts` runs one unconditional chain per daemon), so the table is created on every daemon; only the caller role writes and reads it, and a daemon that never originates a dispatch keeps it empty. This differs from `cross_node_dispatch_approvals` by row-population, not presence: a dispatch writes approvals rows on both its caller and target daemons, but a pending-dispatch row exists only on the originating daemon.

---

## Workflow Tables (Plan-017)

Full workflow-engine V1 schema. Nine tables implement the 10-state phase machine, append-only hash-chained gate history (C-13/I7), parallel-join bookkeeping, and OWN-only channel linkage. `session_events` remains canonical truth; tables 3/4/7/8/9 are rebuildable projections, and 1/2/5/6 are immutable truth (6 additionally carries a per-run BLAKE3 chain anchored to [Spec-006 § Integrity Protocol](../../specs/006-session-event-taxonomy-and-audit-log.md#integrity-protocol)).

The normalized-table-over-blob shape, the per-run hash-chained gate-resolution audit trail, and the rebuildable-projection split align with industry persistence precedents: durable-execution engines persist normalized state per run rather than monolithic blobs ([Restate — What is Durable Execution](https://restate.dev/what-is-durable-execution), fetched 2026-04-26); large-engine persistence tiers separate hot live state from cold archive ([Argo Workflows — Workflow Archive](https://argo-workflows.readthedocs.io/en/latest/workflow-archive/), fetched 2026-04-25); and append-only hash-chained audit trails are the canonical academic precedent for tamper-evident logging (_"a tamper-evident log... uses a hash chain to detect tampering with high probability"_ — [Crosby & Wallach, Efficient Data Structures for Tamper-Evident Logging, USENIX Security 2009](https://static.usenix.org/event/sec09/tech/full_papers/crosby.pdf), fetched 2026-04-25). `Spec-017 §References` > Persistence + hash-chain enumerates the full primary-source corpus.

```sql
-- ========================================================================
-- 1. workflow_definitions — content-hashed, immutable, schema-versioned
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitments: C-1 (YAML + TS SDK), C-8 (schema version marker)
CREATE TABLE workflow_definitions (
  id                   TEXT PRIMARY KEY,               -- ULID; NOT the content hash
  session_id           TEXT NOT NULL,                  -- owning session
  name                 TEXT NOT NULL,                  -- author-facing name
  scope                TEXT NOT NULL DEFAULT 'session'
                       CHECK(scope IN ('session','channel')),
  content_hash         TEXT NOT NULL,                  -- BLAKE3 over JCS-canonicalized definition body
  schema_version       TEXT NOT NULL                   -- `ai-sidekicks-schema: 1.0` per C-8
                       CHECK(schema_version GLOB '[0-9]*.[0-9]*'),
  definition_body      TEXT NOT NULL,                  -- JSON (canonicalized per RFC 8785); full author-supplied definition
  created_at           TEXT NOT NULL,
  created_by           TEXT,                           -- participant_id
  UNIQUE(session_id, content_hash)                     -- dedupe identical submissions
);

CREATE INDEX idx_workflow_definitions_session ON workflow_definitions(session_id);
CREATE INDEX idx_workflow_definitions_content_hash ON workflow_definitions(content_hash);

-- Note: `updated_at` intentionally absent — definitions are immutable by C-9/F13 convention.
-- Edits create a new row in workflow_versions referencing this row as a parent.

-- ========================================================================
-- 2. workflow_versions — definition history chain (F13 additive versioning)
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitments: F13 / C-8 version-API-at-V1 (Pass D §2.2)
CREATE TABLE workflow_versions (
  id                   TEXT PRIMARY KEY,               -- ULID
  definition_id        TEXT NOT NULL REFERENCES workflow_definitions(id),
  version_number       INTEGER NOT NULL,               -- monotonic per definition_id
  parent_version_id    TEXT REFERENCES workflow_versions(id), -- NULL at version_number=1
  parent_content_hash  TEXT,                           -- BLAKE3 of parent definition body; NULL at version 1
  content_hash         TEXT NOT NULL,                  -- BLAKE3 of THIS version's body
  phase_definitions    TEXT NOT NULL DEFAULT '[]',     -- JSON array of phase configs
  author_note          TEXT,                           -- opt-in changelog message
  created_at           TEXT NOT NULL,
  created_by           TEXT,                           -- participant_id
  UNIQUE(definition_id, version_number),
  UNIQUE(content_hash)                                 -- dedupe across definitions too
);

CREATE INDEX idx_workflow_versions_definition ON workflow_versions(definition_id, version_number DESC);
CREATE INDEX idx_workflow_versions_parent ON workflow_versions(parent_version_id)
  WHERE parent_version_id IS NOT NULL;

-- ========================================================================
-- 3. workflow_runs — top-level run state; counters and deadlines
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitments: SA-1 (max_phase_transitions), SA-2 (max_duration), SA-3 (resource pools)
CREATE TABLE workflow_runs (
  id                        TEXT PRIMARY KEY,          -- ULID
  workflow_version_id       TEXT NOT NULL REFERENCES workflow_versions(id),
  session_id                TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'pending'
                            CHECK(status IN (
                              'pending','running','suspended','completed','failed','cancelled'
                            )),
  -- SA-1 iteration counter
  phase_transitions_count   INTEGER NOT NULL DEFAULT 0,
  max_phase_transitions     INTEGER NOT NULL DEFAULT 100, -- SA-1 default
  -- SA-2 duration deadline
  started_at                TEXT,                      -- RFC 3339 UTC
  deadline_at               TEXT,                      -- started_at + max_duration (computed at start)
  max_duration_ms           INTEGER NOT NULL DEFAULT 86400000, -- SA-2 default 24h
  completed_at              TEXT,
  -- SA-3 pool reservations (snapshot only; pool runtime state is ephemeral and NOT persisted)
  pool_reservations_snapshot TEXT NOT NULL DEFAULT '{}', -- JSON: {pty_slots: n, agent_memory_mb: n}
  -- Result
  failure_reason            TEXT,                       -- null unless status in ('failed','cancelled')
  failure_detail            TEXT,                       -- JSON; includes cancellation_reason per Pass F
  created_at                TEXT NOT NULL,
  created_by                TEXT,                       -- participant_id or trigger
  CHECK(phase_transitions_count <= max_phase_transitions),
  CHECK(max_duration_ms > 0)
);

CREATE INDEX idx_workflow_runs_session ON workflow_runs(session_id);
CREATE INDEX idx_workflow_runs_status ON workflow_runs(status)
  WHERE status IN ('pending','running','suspended');
CREATE INDEX idx_workflow_runs_deadline ON workflow_runs(deadline_at)
  WHERE status IN ('running','suspended') AND deadline_at IS NOT NULL;
CREATE INDEX idx_workflow_runs_version ON workflow_runs(workflow_version_id);

-- ========================================================================
-- 4. workflow_phase_states — per-phase state machine projection
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitments: 10-state machine from Wave-1 §7.1 / Pass F scope
-- Phase types cover all four V1 types: single-agent, multi-agent, automated, human
-- (`automated` subtype `auto-continue`/`done`/`quality-checks`; `human` subtype `human-approval`/`human`)
CREATE TABLE workflow_phase_states (
  id                      TEXT PRIMARY KEY,            -- ULID; also the phase_run_id used by Pass B channels
  workflow_run_id         TEXT NOT NULL REFERENCES workflow_runs(id),
  phase_id                TEXT NOT NULL,               -- logical phase id from workflow_versions.phase_definitions
  phase_type              TEXT NOT NULL
                          CHECK(phase_type IN (
                            'single-agent','multi-agent','auto-continue','done',
                            'human-approval','human','quality-checks','gate','terminal'
                          )),
  -- 10-state machine per Wave-1 §7.1 / Pass F
  state                   TEXT NOT NULL DEFAULT 'admitted'
                          CHECK(state IN (
                            'admitted','waiting_on_pool','started','progressed',
                            'suspended','resumed','cancelling','failed','completed','retried'
                          )),
  attempt_number          INTEGER NOT NULL DEFAULT 1,  -- 1..max_retries; retry creates new row per C-9
  -- Parent-sibling (for parallel blocks)
  parallel_join_id        TEXT REFERENCES parallel_join_state(id), -- NULL unless under a parallel join
  -- Timing
  admitted_at             TEXT NOT NULL,
  started_at              TEXT,
  progressed_at           TEXT,                        -- most recent progress heartbeat
  completed_at            TEXT,
  -- Failure & cancellation
  failure_reason          TEXT,
  cancellation_reason     TEXT
                          CHECK(cancellation_reason IS NULL
                                OR cancellation_reason IN ('sibling_failure','deadline_exceeded','user_cancel','gate_rejected')),
  -- Pool reservation (transient; for crash recovery decision)
  pool_reservation        TEXT,                        -- JSON {pty_slots: n, agent_memory_mb: n}; NULL after release
  -- Resume metadata
  resume_cursor           TEXT,                        -- opaque; for driver adapter; see Plan-015 recovery
  last_event_sequence     INTEGER,                     -- session_events.sequence projected from at rebuild
  UNIQUE(workflow_run_id, phase_id, attempt_number)    -- retry creates new attempt row per C-9
);

CREATE INDEX idx_workflow_phase_states_run ON workflow_phase_states(workflow_run_id);
CREATE INDEX idx_workflow_phase_states_active ON workflow_phase_states(workflow_run_id, state)
  WHERE state IN ('admitted','waiting_on_pool','started','progressed','suspended','cancelling');
CREATE INDEX idx_workflow_phase_states_parallel ON workflow_phase_states(parallel_join_id)
  WHERE parallel_join_id IS NOT NULL;

-- ========================================================================
-- 5. phase_outputs — immutable per C-9; retry creates new output identity
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitment: C-9 output immutability; GitHub Actions v3→v4 artifact-API lesson
CREATE TABLE phase_outputs (
  id                      TEXT PRIMARY KEY,            -- ULID; content-stable identity
  phase_run_id            TEXT NOT NULL REFERENCES workflow_phase_states(id),
  workflow_run_id         TEXT NOT NULL REFERENCES workflow_runs(id), -- denormalized for index
  output_name             TEXT NOT NULL,               -- name within the phase's output contract
  value_kind              TEXT NOT NULL
                          CHECK(value_kind IN ('scalar','json','artifact_ref','agent_transcript_ref')),
  value_json              TEXT,                        -- primitive/JSON payload; NULL when value_kind=artifact_ref
  artifact_manifest_id    TEXT REFERENCES artifact_manifests(id), -- Plan-014 integration; NULL unless value_kind=artifact_ref
  content_hash            TEXT NOT NULL,               -- BLAKE3 of canonicalized output bytes (for dedupe + replay check)
  created_at              TEXT NOT NULL,
  UNIQUE(phase_run_id, output_name)                    -- outputs are write-once per attempt
);

CREATE INDEX idx_phase_outputs_run ON phase_outputs(workflow_run_id);
CREATE INDEX idx_phase_outputs_phase ON phase_outputs(phase_run_id);
CREATE INDEX idx_phase_outputs_artifact ON phase_outputs(artifact_manifest_id)
  WHERE artifact_manifest_id IS NOT NULL;
-- Immutability invariant: no UPDATE trigger — all writes INSERT-only; a retry inserts
-- a new row under a new phase_run_id (attempt_number+1) rather than mutating the existing row.

-- ========================================================================
-- 6. workflow_gate_resolutions — append-only hash-chained per C-13 / I7
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitment: C-13 append-only hash-chained approval history (Pass E §4.7)
-- Algorithm anchored to Spec-006 §Integrity Protocol (BLAKE3 + Ed25519 + RFC 8785 JCS)
-- to keep one canonicalization rule across the daemon.
CREATE TABLE workflow_gate_resolutions (
  id                         TEXT PRIMARY KEY,          -- ULID
  workflow_run_id            TEXT NOT NULL REFERENCES workflow_runs(id),
  sequence                   INTEGER NOT NULL,          -- per-run monotonic starting at 1
  phase_run_id               TEXT REFERENCES workflow_phase_states(id), -- NULL for run-level gates
  -- Gate identity
  gate_kind                  TEXT NOT NULL
                             CHECK(gate_kind IN (
                               'human-approval','quality-checks','human','channel-moderation',
                               'workflow-phase','definition-edit-audit'
                             )),
  approval_category          TEXT                       -- mirrors Plan-012 approval_requests.category when applicable
                             CHECK(approval_category IS NULL OR approval_category IN (
                               'tool_execution','file_write','network_access','destructive_git',
                               'user_input','plan_approval','mcp_elicitation','gate',
                               'human_phase_contribution'                                      -- SA-12 addition
                             )),
  approval_request_id        TEXT REFERENCES approval_requests(id), -- Plan-012 integration; NULL for non-approval gate kinds
  -- Resolution
  outcome                    TEXT NOT NULL
                             CHECK(outcome IN ('approved','rejected','timed_out','withdrawn','admin_override')),
  approver_id                TEXT,                      -- participant_id; NULL for 'timed_out' / 'withdrawn'
  approver_capability        TEXT,                      -- Cedar capability string (C-14 typed capability)
  resolved_at                TEXT NOT NULL,
  -- Policy-at-resolution-time (C-13: replays use at-execution-time policy, not current)
  policy_snapshot_hash       TEXT NOT NULL,             -- BLAKE3 of the Plan-012 policy bundle active at resolved_at
  decision_context           TEXT NOT NULL DEFAULT '{}', -- JSON: scope, resource, reason text, etc.
  -- Hash chain (per-run, anchored to Spec-006 scheme)
  prev_hash                  BLOB NOT NULL,             -- 32 bytes; row_hash of prior entry; zero-filled at sequence=1
  row_hash                   BLOB NOT NULL,             -- 32 bytes; BLAKE3(prev_hash || JCS-canonical(row_body))
  daemon_signature           BLOB NOT NULL,             -- 64 bytes; Ed25519 over same canonical bytes
  approver_signature         BLOB,                      -- 64 bytes; Ed25519 from approver's participant key; NULL for 'timed_out'
  UNIQUE(workflow_run_id, sequence)
);

CREATE INDEX idx_gate_resolutions_run ON workflow_gate_resolutions(workflow_run_id, sequence);
CREATE INDEX idx_gate_resolutions_phase ON workflow_gate_resolutions(phase_run_id)
  WHERE phase_run_id IS NOT NULL;
CREATE INDEX idx_gate_resolutions_approval ON workflow_gate_resolutions(approval_request_id)
  WHERE approval_request_id IS NOT NULL;

-- No UPDATE or DELETE triggers — append-only enforced at application layer (writer worker only inserts).
-- Verification procedure: BLAKE3 chain recompute per Spec-006 §Integrity Protocol + dual-anchor cross-check vs session_events payload (see "Hash-chain verification" note below this block).

-- ========================================================================
-- 7. parallel_join_state — sibling set + cancellation bookkeeping
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitment: SA-4 ParallelJoinPolicy (Pass A §3.4)
CREATE TABLE parallel_join_state (
  id                      TEXT PRIMARY KEY,           -- ULID; referenced by workflow_phase_states.parallel_join_id
  workflow_run_id         TEXT NOT NULL REFERENCES workflow_runs(id),
  join_node_id            TEXT NOT NULL,              -- phase id of the join node in the DAG
  policy                  TEXT NOT NULL
                          CHECK(policy IN ('fail-fast','all-settled','any-success')),
  expected_sibling_count  INTEGER NOT NULL,           -- number of siblings entering the join
  completed_count         INTEGER NOT NULL DEFAULT 0,
  failed_count            INTEGER NOT NULL DEFAULT 0,
  cancelled_count         INTEGER NOT NULL DEFAULT 0,
  resolution              TEXT
                          CHECK(resolution IS NULL OR resolution IN ('all_succeeded','any_succeeded','any_failed','all_failed','cancelled')),
  resolved_at             TEXT,                       -- set when the join condition fires
  -- Cancellation cascade bookkeeping (Wave-1 §3.1 synchrony verification)
  cancel_wave_tick        INTEGER,                    -- executor tick at which cancel wave fired; NULL until fail-fast triggers
  created_at              TEXT NOT NULL
);

CREATE INDEX idx_parallel_join_state_run ON parallel_join_state(workflow_run_id);
CREATE INDEX idx_parallel_join_state_unresolved ON parallel_join_state(workflow_run_id)
  WHERE resolution IS NULL;

-- ========================================================================
-- 8. workflow_channels — phase_run_id ↔ channel_id (OWN-only V1)
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitment: SA-6 ownership: OWN V1 (BIND deferred to V1.1 under criterion-gated commitments per ADR-015)
-- Pass B §3.1 channel-lifecycle coupling; Spec-016 linkage
CREATE TABLE workflow_channels (
  id                      TEXT PRIMARY KEY,           -- ULID
  phase_run_id            TEXT NOT NULL UNIQUE REFERENCES workflow_phase_states(id), -- UNIQUE = OWN 1:1
  channel_id              TEXT NOT NULL REFERENCES channels(id),
  ownership               TEXT NOT NULL DEFAULT 'OWN'
                          CHECK(ownership IN ('OWN')),  -- V1: OWN only; BIND reserved for V1.1 per ADR-015
  termination_policy      TEXT NOT NULL DEFAULT 'CLOSE_WITH_RECORDS_PRESERVED'
                          CHECK(termination_policy IN (
                            'CLOSE_WITH_RECORDS_PRESERVED','REQUEST_CANCEL','TERMINATE'
                          )),
  grace_period_ms         INTEGER NOT NULL DEFAULT 30000, -- SA-9: 30s grace on REQUEST_CANCEL
  created_at              TEXT NOT NULL,
  terminated_at           TEXT,
  termination_reason      TEXT
);

CREATE INDEX idx_workflow_channels_channel ON workflow_channels(channel_id);

-- ========================================================================
-- 9. human_phase_form_state — draft autosave (daemon-side fallback for V1.x)
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 status: Pass C §3 — V1 clients use localStorage/IndexedDB; this table
-- ships empty in V1 so the V1.x daemon-side draft persistence has no migration cost.
CREATE TABLE human_phase_form_state (
  id                      TEXT PRIMARY KEY,           -- ULID
  phase_run_id            TEXT NOT NULL REFERENCES workflow_phase_states(id),
  participant_id          TEXT NOT NULL,              -- who's drafting (implicit-claim on first open)
  draft_json              TEXT NOT NULL DEFAULT '{}', -- JSON: current form field values
  draft_version           INTEGER NOT NULL DEFAULT 1, -- bumps on each autosave tick; optimistic-concurrency token
  submitted               INTEGER NOT NULL DEFAULT 0  -- boolean; 1 terminal
                          CHECK(submitted IN (0,1)),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE(phase_run_id, participant_id)                -- one draft slot per (phase, participant)
);

CREATE INDEX idx_human_phase_form_state_phase ON human_phase_form_state(phase_run_id)
  WHERE submitted = 0;
```

**Index rationale + write-amplification estimate:** Per-index query justifications above are sized against SQLite's standard query-planner cost model — partial indexes with `WHERE` clauses are evaluated only over the matching subset, yielding the smallest workable index for the live-set queries ([SQLite — Partial Indexes](https://www.sqlite.org/partialindex.html), fetched 2026-04-25). The ~42 KB / 110-write projection for a 10-phase workflow assumes Spec-015's 50-event batch flushed under one `db.transaction(fn)` call — `better-sqlite3` commits each batch atomically and rolls back on throw (_"Calling [.transaction()] returns a new function that, when called, runs the given function inside an SQLite transaction"_ — [better-sqlite3 API docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md), fetched 2026-04-25). Two to three batch flushes therefore absorb the full workflow lifecycle without triggering write-amplification regressions under `synchronous = FULL` WAL ([SQLite — Write-Ahead Logging](https://www.sqlite.org/wal.html), fetched 2026-04-25).

**Hash-chain verification:** Per-run BLAKE3 chain recompute follows the exact algorithm specified in [Spec-006 § Integrity Protocol](../../specs/006-session-event-taxonomy-and-audit-log.md#integrity-protocol) — recompute `BLAKE3(prev_hash || canonical_bytes(row))` for each entry and compare to the stored `row_hash`, then verify `daemon_signature` against the canonical bytes. The hash function is the BLAKE3 reference specification ([BLAKE3 specification](https://github.com/BLAKE3-team/BLAKE3-specs/blob/master/blake3.pdf), fetched 2026-04-25). The dual-anchor check additionally cross-checks `session_events` (category `workflow_gate_resolution`, payload fields `gate_resolution_id` + `row_hash`) so a tampered `workflow_gate_resolutions` row is detected even if its local chain is internally consistent — the same tamper-evidence pattern Crosby & Wallach formalized ([Efficient Data Structures for Tamper-Evident Logging, USENIX Security 2009](https://static.usenix.org/event/sec09/tech/full_papers/crosby.pdf), fetched 2026-04-25). Verification is exposed as a CLI subcommand (Plan-017).

---

## Channel and Orchestration Tables (Plan-016)

DDL hardened during the Tier-6 plan-readiness audit (D-016-15, A-016-5, A-016-2, D-016-5). Posture per table: `channels`, `run_links`, and `agents` are events-canonical projections ([ADR-017](../../decisions/017-shared-event-sourcing-scope.md) Option B — rebuilt from `session_events` on replay; never written except by the projector); `session_budgets` is row-canonical daemon configuration (the `queue_items` posture — mutated by wire method, not evented). `channels` holds **user-created channels only**: the bootstrap main channel is projected (`deriveMainChannelId(sessionId)` per CP-002-7) and never has a row or a `channel.created` event.

```sql
-- Owner: Plan-016 (events-canonical projection of channel.* events; user channels only — main is synthesized)
CREATE TABLE channels (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  name            TEXT,
  state           TEXT NOT NULL DEFAULT 'active'
                  CHECK(state IN ('active', 'muted', 'archived')),
  config          TEXT NOT NULL DEFAULT '{}', -- JSON: ChannelConfig (packages/contracts/src/orchestration.ts) — {turnPolicy?, roundRobinOrder?, moderation?}
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_channels_session ON channels(session_id);

-- Owner: Plan-016 (events-canonical projection of the run.queued orchestration-carrier fields — D-016-3)
CREATE TABLE run_links (
  parent_run_id     TEXT NOT NULL,
  child_run_id      TEXT NOT NULL,
  session_id        TEXT NOT NULL,                      -- session provenance (I-016-3): replay + relay rebuild scope by session
  link_type         TEXT NOT NULL DEFAULT 'spawn'
                    CHECK(link_type IN ('spawn', 'delegate', 'handoff')),
  internal_helper   INTEGER NOT NULL DEFAULT 0
                    CHECK(internal_helper IN (0, 1)),   -- durable home of the internal-helper flag (I-016-10)
  producing_node_id TEXT NOT NULL,                      -- runtime node that admitted the child run (reachability projection input)
  created_at        TEXT NOT NULL,
  PRIMARY KEY (child_run_id),                       -- single-parent: a child run links to exactly one parent (one-shot run.queued linkage D-016-3; depth-1 model)
  CHECK (parent_run_id <> child_run_id)             -- a run never parents itself
);

CREATE INDEX idx_run_links_parent ON run_links(parent_run_id); -- parent → children scans (orchestration.childRunLinkRead; active-child accounting)
CREATE INDEX idx_run_links_session ON run_links(session_id);

-- Owner: Plan-016 (events-canonical projection of agent.* events — A-016-2; state enum is the
-- canonical 4-state agent lifecycle from domain/agent-channel-and-run-model.md §Lifecycle.
-- V1 wire mapping: agent.attach -> 'ready' (or 'configured' when the named default node is not
-- currently attached), agent.detach -> 'disabled', re-attach -> 'ready'; 'archived' is registered
-- but no V1 wire mutation reaches it. The resulting state is carried ON the agent.* event payloads
-- so the projection is deterministic from the log alone.)
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  driver_name     TEXT NOT NULL,                        -- provider driver key (Plan-005 capability surface)
  model_id        TEXT NOT NULL,
  default_node_id TEXT,                                 -- NULL = any local attached node
  state           TEXT NOT NULL DEFAULT 'ready'
                  CHECK(state IN ('configured', 'ready', 'disabled', 'archived')),
  config          TEXT NOT NULL DEFAULT '{}',           -- JSON: agent-scoped driver config (opaque to the schema)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_agents_session ON agents(session_id);

-- Owner: Plan-016 (row-canonical daemon configuration — queue_items posture, NOT evented; one row per session, created on first read/update with Spec-016 §Budget Policies / §Scheduler Limits defaults; mutated only via orchestration.budgetUpdate, session owner only — D-016-5)
CREATE TABLE session_budgets (
  session_id                    TEXT PRIMARY KEY,
  cost_limit_cents              INTEGER NOT NULL DEFAULT 1000,  -- Spec-016: $10 per session
  turn_limit_per_agent          INTEGER NOT NULL DEFAULT 50,    -- Spec-016:109: max consecutive turns per (channel, agent), reset on interleave (D-016-8) — not a per-session total
  max_executing_channels        INTEGER NOT NULL DEFAULT 5,     -- Spec-016 §Scheduler Limits
  max_queue_depth_per_channel   INTEGER NOT NULL DEFAULT 25,
  max_pending_orchestration_runs INTEGER NOT NULL DEFAULT 10,
  active_child_limit            INTEGER NOT NULL DEFAULT 5,     -- Spec-016:175 daemon default, configurable
  unpriced_family_caps          TEXT NOT NULL DEFAULT '[]',     -- JSON [{modelFamily, hardCapUsdCents}] — owner-supplied unpriced-family escapes, native-cap legs only (Spec-016 §Cost Derivation And Absent-Cost Semantics, campaign B6); wire mirror = OrchestrationBudgetUpdate.unpricedFamilyCaps
  updated_at                    TEXT NOT NULL,
  -- Non-negative-integer floors on every limit; wire mirror = orchestration.budgetUpdate Zod .int().nonnegative() (D-016-5)
  CHECK (typeof(cost_limit_cents) = 'integer' AND cost_limit_cents >= 0),
  CHECK (typeof(turn_limit_per_agent) = 'integer' AND turn_limit_per_agent >= 0),
  CHECK (typeof(max_executing_channels) = 'integer' AND max_executing_channels >= 0),
  CHECK (typeof(max_queue_depth_per_channel) = 'integer' AND max_queue_depth_per_channel >= 0),
  CHECK (typeof(max_pending_orchestration_runs) = 'integer' AND max_pending_orchestration_runs >= 0),
  CHECK (typeof(active_child_limit) = 'integer' AND active_child_limit >= 0)
);

-- Live-leg goal-delivery crash consistency (Spec-016 §Session Goals, campaign B6): the durable
-- goal-dispatch intent written BEFORE the driver op (ADR-019 spawn-intent pattern); startup
-- reconciliation completes a dangling row keyed on durable leg states: no 'failed' leg = interrupted apply (re-issue to EVERY leg, acked included — idempotent last-write-wins re-send; acked is advisory across restart); any 'failed' leg = revert mode (re-assert the prior goal on EVERY leg, pending included — an in-flight call may have applied unacked; never re-issue the new goal — a refusing leg is marked 'failed' BEFORE compensation begins, so a doomed mutation never re-applies across a crash) — each successful prior-goal re-assertion flips its leg to 'reverted' ('acked' -> 'reverted' and 'pending' -> 'reverted' alike — pending is unknown-outcome and converges only by re-assertion) — and delete WITHOUT appending (converging with a refusal outcome). Deleted on append — the append and the delete commit in ONE transaction (both tables daemon-local), so a committed event with a live row is unrepresentable; on failure, deleted only once EVERY non-'failed' leg is 'reverted' — pending included, since a pending leg's in-flight call may already carry the goal unacked (a failed or unconverged revert keeps the row durable with that leg still 'acked'/'pending', so restart reconciliation knows exactly which legs still carry the unapplied goal and the durable turn gate stays alive; further goal mutations for the session stay blocked until convergence) — a refused mutation never re-applies on replay.
-- One in-flight goal mutation per session (goal ops serialize per session).
CREATE TABLE session_goal_dispatch_intents (
  session_id  TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,   -- JSON {op: 'set'|'clear', goal?: {text}, prior: {goal?}, actor: ParticipantId, legs: {bindingId: 'pending'|'acked'|'failed'|'reverted'}} — everything the crash-recovered session.goal_* event and the revert path need (Spec-006 envelope attribution; last-write-wins revert)
  created_at  TEXT NOT NULL
);
```

Per-run token (`tokenLimit`, default 100000) and idle-timeout (`idleTimeoutMs`, default 300000) budgets are per-run `OrchestrationRunConfig` values resolved at admission (request override else session default) and persisted durably as the `run.queued` payload's `effectiveRunConfig` (Plan-016 D-016-5; api-payload `RunStateChangeEvent`) — they have no session-level column, and budget/idle enforcement rebuilds from that event field on replay, never by re-merging session defaults that may have changed mid-run. Budget _accounting_ (tokens/cost consumed) has no table: the daemon's `BudgetAccountant` is an in-memory projection rebuilt on replay from `usage_telemetry` + `run.*` events (D-016-5).

---

## GDPR and Recovery Tables (Spec-022, Plan-015)

```sql
-- Owner: Spec-022 (GDPR)
CREATE TABLE participant_keys (
  participant_id    TEXT NOT NULL PRIMARY KEY,
  encrypted_key_blob BLOB NOT NULL,           -- XChaCha20-Poly1305-wrapped AES-256 content key (wire: nonce || ciphertext || tag) — Plan-022 D-022-2
  key_version       INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  rotated_at        TEXT
);

-- Owner: Plan-015
CREATE TABLE replay_cursors (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL UNIQUE,
  last_sequence   INTEGER NOT NULL,           -- last replayed event sequence
  state           TEXT NOT NULL DEFAULT 'current'
                  CHECK(state IN ('current', 'rebuilding', 'stale')),
  updated_at      TEXT NOT NULL
);

-- Owner: Plan-015
CREATE TABLE recovery_checkpoints (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  checkpoint_type TEXT NOT NULL,              -- e.g. 'full', 'incremental'
  as_of_sequence  INTEGER NOT NULL,
  state_blob      BLOB NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_recovery_checkpoints_session ON recovery_checkpoints(session_id);
```

---

## Diagnostic Bucket Tables (Plan-020)

Runtime-local bounded-retention buckets for raw diagnostic material. These tables may contain PII-bearing content, command output, tool traces, or reasoning detail, so they stay in Local SQLite only, default-deny outbound telemetry, and support both TTL expiry and participant-scoped purge per Spec-022 shred fan-out Path 3.

```sql
-- Owner: Plan-020
CREATE TABLE driver_raw_events (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  run_id              TEXT,
  participant_id      TEXT,
  source_ref          TEXT,
  content_kind        TEXT NOT NULL DEFAULT 'driver_raw_event',
  bucket_payload      BLOB NOT NULL,
  payload_digest      BLOB NOT NULL,
  raw_capture_opt_in  INTEGER NOT NULL DEFAULT 0 CHECK(raw_capture_opt_in IN (0, 1)),
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  purged_at           TEXT
);

CREATE INDEX idx_driver_raw_events_session ON driver_raw_events(session_id, created_at);
CREATE INDEX idx_driver_raw_events_participant ON driver_raw_events(participant_id)
  WHERE participant_id IS NOT NULL AND purged_at IS NULL;
CREATE INDEX idx_driver_raw_events_expiry ON driver_raw_events(expires_at)
  WHERE purged_at IS NULL;

-- Owner: Plan-020
CREATE TABLE command_output (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  run_id              TEXT,
  participant_id      TEXT,
  source_ref          TEXT,
  content_kind        TEXT NOT NULL DEFAULT 'command_output',
  bucket_payload      BLOB NOT NULL,
  payload_digest      BLOB NOT NULL,
  raw_capture_opt_in  INTEGER NOT NULL DEFAULT 0 CHECK(raw_capture_opt_in IN (0, 1)),
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  purged_at           TEXT
);

CREATE INDEX idx_command_output_session ON command_output(session_id, created_at);
CREATE INDEX idx_command_output_participant ON command_output(participant_id)
  WHERE participant_id IS NOT NULL AND purged_at IS NULL;
CREATE INDEX idx_command_output_expiry ON command_output(expires_at)
  WHERE purged_at IS NULL;

-- Owner: Plan-020
CREATE TABLE tool_traces (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  run_id              TEXT,
  participant_id      TEXT,
  source_ref          TEXT,
  content_kind        TEXT NOT NULL DEFAULT 'tool_trace',
  bucket_payload      BLOB NOT NULL,
  payload_digest      BLOB NOT NULL,
  raw_capture_opt_in  INTEGER NOT NULL DEFAULT 0 CHECK(raw_capture_opt_in IN (0, 1)),
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  purged_at           TEXT
);

CREATE INDEX idx_tool_traces_session ON tool_traces(session_id, created_at);
CREATE INDEX idx_tool_traces_participant ON tool_traces(participant_id)
  WHERE participant_id IS NOT NULL AND purged_at IS NULL;
CREATE INDEX idx_tool_traces_expiry ON tool_traces(expires_at)
  WHERE purged_at IS NULL;

-- Owner: Plan-020
CREATE TABLE reasoning_detail (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  run_id              TEXT,
  participant_id      TEXT,
  source_ref          TEXT,
  content_kind        TEXT NOT NULL DEFAULT 'reasoning_detail',
  bucket_payload      BLOB NOT NULL,
  payload_digest      BLOB NOT NULL,
  raw_capture_opt_in  INTEGER NOT NULL DEFAULT 0 CHECK(raw_capture_opt_in IN (0, 1)),
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  purged_at           TEXT
);

CREATE INDEX idx_reasoning_detail_session ON reasoning_detail(session_id, created_at);
CREATE INDEX idx_reasoning_detail_participant ON reasoning_detail(participant_id)
  WHERE participant_id IS NOT NULL AND purged_at IS NULL;
CREATE INDEX idx_reasoning_detail_expiry ON reasoning_detail(expires_at)
  WHERE purged_at IS NULL;
```

---

## Schema Version Table

```sql
CREATE TABLE schema_version (
  version         INTEGER NOT NULL PRIMARY KEY,
  applied_at      TEXT NOT NULL,
  description     TEXT
);

INSERT INTO schema_version (version, applied_at, description)
VALUES (1, datetime('now'), 'Initial schema');
```
