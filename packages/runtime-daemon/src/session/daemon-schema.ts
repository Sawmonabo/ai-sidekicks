// The daemon's local SQLite schema: every table, index and trigger, in one script.
//
// The SQL is a TypeScript string because `tsc -b` copies no `.sql` asset into
// `dist/`, so a file loaded beside the module would be missing at run time.
//
// Every table is STRICT: a column refuses a value of the wrong storage class
// (text into INTEGER, a fractional REAL into INTEGER) instead of storing it.
// JSON columns are TEXT. A table is added here, with its test; there are no
// numbered migrations.

/**
 * The whole daemon schema. `applyMigrations` executes it once, in one
 * transaction, on a database that has none of it yet.
 */
export const DAEMON_SCHEMA_SQL: string = `
-- ---------------------------------------------------------------------------
-- session_events: the append-only, hash-chained, signed event log.
-- ---------------------------------------------------------------------------
-- The integrity columns carry no DEFAULT: a writer that forgot to fill the
-- chain must fail loudly. Their length CHECKs catch a wrong-size placeholder at
-- insert time instead of at chain verification.
CREATE TABLE session_events (
  id                TEXT PRIMARY KEY,             -- ULID or UUID
  session_id        TEXT NOT NULL,
  sequence          INTEGER NOT NULL,             -- monotonic per session
  occurred_at       TEXT NOT NULL,                -- RFC 3339 UTC, ms precision; display and audit
  -- process.hrtime.bigint() at emit; in-daemon ordering only
  monotonic_ns      INTEGER NOT NULL,
  category          TEXT NOT NULL,
  type              TEXT NOT NULL,
  actor             TEXT,                         -- user or agent id; NULL for the system
  payload           TEXT NOT NULL DEFAULT '{}',   -- JSON
  -- per-user AES-256-GCM; outside the hashed and signed bytes
  pii_payload       BLOB,
  -- owner stamp: the user whose key sealed pii_payload
  pii_user_id       TEXT,
  -- machine-authored prose under the session content key
  content_payload   BLOB,
  correlation_id    TEXT,
  causation_id      TEXT,
  -- "MAJOR.MINOR". The GLOB is only a smoke check (its * matches anything);
  -- the writer parses the real shape. TEXT, because comparison parses the parts.
  version           TEXT NOT NULL DEFAULT '1.0'
                    CHECK(version GLOB '[0-9]*.[0-9]*'),
  -- 32 bytes; row_hash of the previous row, zero-filled at sequence 0
  prev_hash         BLOB NOT NULL,
  -- 32 bytes; BLAKE3(prev_hash || JCS envelope bytes)
  row_hash          BLOB NOT NULL,
  daemon_signature  BLOB NOT NULL,                -- 64 bytes; Ed25519 over the same canonical bytes
  -- NULL = live row (chain-verified); 'audit_stub' = compacted (anchor and
  -- stub_signature verified). A column, not a payload member, so the verifier
  -- can branch on it without trusting the bytes it is about to verify.
  retention_class   TEXT
                    CHECK(retention_class IS NULL OR retention_class = 'audit_stub'),
  -- 64 bytes; Ed25519 over the exact stub bytes stored in payload. row_hash and
  -- daemon_signature commit only to the discarded pre-compaction bytes.
  stub_signature    BLOB,
  UNIQUE (session_id, sequence),
  CHECK(length(prev_hash) = 32),
  CHECK(length(row_hash) = 32),
  CHECK(length(daemon_signature) = 64)
) STRICT;

CREATE INDEX idx_session_events_session_seq ON session_events(session_id, sequence);
CREATE INDEX idx_session_events_type ON session_events(session_id, type);
CREATE INDEX idx_session_events_correlation ON session_events(correlation_id)
  WHERE correlation_id IS NOT NULL;
-- Keeps replay and the compactor's candidate scan off the stub suffix, which
-- grows without bound while the live set stays bounded.
CREATE INDEX idx_session_events_live ON session_events(session_id, sequence)
  WHERE retention_class IS NULL;

-- At most one terminal event per (runId, runVersion). The key lives in the JSON
-- payload, so the index is partial over terminal run_lifecycle rows only.
CREATE UNIQUE INDEX idx_session_events_run_terminal_once
  ON session_events(json_extract(payload, '$.runId'), json_extract(payload, '$.runVersion'))
  WHERE category = 'run_lifecycle' AND type IN ('run.completed', 'run.failed', 'run.interrupted');

-- A UNIQUE index treats NULLs as distinct, and "7" and 7 as different keys: a
-- terminal insert must carry a text runId and an integer runVersion.
CREATE TRIGGER trg_run_terminal_key_insert BEFORE INSERT ON session_events
WHEN NEW.category = 'run_lifecycle'
  AND NEW.type IN ('run.completed', 'run.failed', 'run.interrupted')
  AND (json_extract(NEW.payload, '$.runId') IS NULL
    OR json_type(NEW.payload, '$.runId') <> 'text'
    OR json_extract(NEW.payload, '$.runVersion') IS NULL
    OR json_type(NEW.payload, '$.runVersion') <> 'integer')
BEGIN
  SELECT RAISE(ABORT,
    'terminal run_lifecycle requires a text runId and an integer runVersion');
END;

-- A committed terminal row keeps its key and cannot be moved out of the index's
-- predicate. IS NOT, not <>, so a NULL operand still yields true or false.
CREATE TRIGGER trg_run_terminal_key_update
BEFORE UPDATE OF payload, category, type ON session_events
WHEN OLD.category = 'run_lifecycle'
  AND OLD.type IN ('run.completed', 'run.failed', 'run.interrupted')
  AND (json_extract(NEW.payload, '$.runId') IS NULL
    OR json_type(NEW.payload, '$.runId') <> 'text'
    OR json_extract(NEW.payload, '$.runVersion') IS NULL
    OR json_type(NEW.payload, '$.runVersion') <> 'integer'
    OR json_extract(NEW.payload, '$.runId') IS NOT json_extract(OLD.payload, '$.runId')
    OR json_extract(NEW.payload, '$.runVersion') IS NOT json_extract(OLD.payload, '$.runVersion')
    OR NEW.category IS NOT OLD.category
    OR NEW.type IS NOT OLD.type)
BEGIN
  SELECT RAISE(ABORT,
    'terminal run_lifecycle row must preserve runId, runVersion, category and type');
END;

-- Terminal rows are insert-only: no update may promote a row into the index.
CREATE TRIGGER trg_run_terminal_key_promote BEFORE UPDATE OF category, type ON session_events
WHEN NOT (OLD.category = 'run_lifecycle'
    AND OLD.type IN ('run.completed', 'run.failed', 'run.interrupted'))
  AND NEW.category = 'run_lifecycle'
  AND NEW.type IN ('run.completed', 'run.failed', 'run.interrupted')
BEGIN
  SELECT RAISE(ABORT,
    'a row cannot be promoted to terminal run_lifecycle by UPDATE; terminal rows are insert-only');
END;

CREATE TABLE session_snapshots (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  as_of_sequence  INTEGER NOT NULL,             -- reflects events up to this sequence
  state_blob      BLOB NOT NULL,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (session_id, as_of_sequence) REFERENCES session_events(session_id, sequence)
) STRICT;

CREATE INDEX idx_session_snapshots_session ON session_snapshots(session_id, as_of_sequence);

-- The composer's unsent draft, one row per session, so a half-typed message
-- survives a restart and reaches the person's other devices. An empty draft
-- is no row: Send clears the draft by deleting it.
CREATE TABLE session_drafts (
  session_id  TEXT PRIMARY KEY,
  text        TEXT NOT NULL,
  updated_at  TEXT NOT NULL                     -- RFC 3339 UTC, ms precision
) STRICT;

-- ---------------------------------------------------------------------------
-- Key custody.
-- ---------------------------------------------------------------------------
CREATE TABLE user_keys (
  user_id             TEXT NOT NULL PRIMARY KEY,
  encrypted_key_blob  BLOB NOT NULL,            -- AES-256-GCM key, encrypted at rest
  key_version         INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  rotated_at          TEXT
) STRICT;

-- The wrapped key that seals every content_payload of one session. Stored, not
-- derived from the master key, so a master-key rotation re-wraps it instead of
-- making every body unreadable. Created on the session's first content append.
CREATE TABLE session_content_keys (
  session_id          TEXT NOT NULL PRIMARY KEY,
  encrypted_key_blob  BLOB NOT NULL,
  key_version         INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  rotated_at          TEXT
) STRICT;

-- The per-session Ed25519 key that signs every session_events row. Local only:
-- it attests that this machine wrote a row. The private half is sealed with the
-- OS-keystore master key. rotated_at stays NULL: a different-key registration is
-- refused, and no rotation exists.
CREATE TABLE daemon_signing_keys (
  session_id          TEXT PRIMARY KEY,
  public_key          BLOB NOT NULL,            -- 32 bytes
  sealed_private_key  BLOB NOT NULL,
  created_at          TEXT NOT NULL,
  rotated_at          TEXT
) STRICT;

-- ---------------------------------------------------------------------------
-- Merkle anchors awaiting upload to the control plane.
-- ---------------------------------------------------------------------------
-- A row here, not a confirmed upload, is what lets compaction proceed: the
-- control plane is a witness, and compaction must keep working while it is
-- unreachable. Durable so a restart never re-signs or skips a range. Rows on the
-- daemon-scope sentinel session are local witnesses only and are never uploaded,
-- so their uploaded_at stays NULL.
CREATE TABLE pending_anchor_uploads (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  node_id           TEXT NOT NULL,
  start_sequence    INTEGER NOT NULL,
  end_sequence      INTEGER NOT NULL,
  -- BLAKE3 Merkle root over row_hash leaves (RFC 9162 MTH)
  merkle_root       BLOB NOT NULL,
  root_signature    BLOB NOT NULL,              -- Ed25519 over the anchor claim (RFC 8785)
  anchored_at       TEXT NOT NULL,
  uploaded_at       TEXT,                       -- set once the control plane confirms
  attempt_count     INTEGER NOT NULL DEFAULT 0, -- drives the upload backoff
  last_attempt_at   TEXT,
  last_error        TEXT,
  -- end_sequence is in the key: a cadence anchor [1,1000] and a covering anchor
  -- [1,5000] share a start and must coexist. "A covering anchor exists" is a
  -- coverage query, never an exact-start match; the key dedups only a re-fire of
  -- the identical range.
  UNIQUE (session_id, node_id, start_sequence, end_sequence)
) STRICT;

CREATE INDEX idx_pending_anchor_uploads_pending
  ON pending_anchor_uploads(session_id, anchored_at)
  WHERE uploaded_at IS NULL;

-- ---------------------------------------------------------------------------
-- This machine's registration: one row per machine and owning user.
-- ---------------------------------------------------------------------------
CREATE TABLE node_trust_state (
  node_id         TEXT NOT NULL,
  owner_user_id   TEXT NOT NULL,
  established_at  TEXT NOT NULL,                -- first registration; a re-registration keeps it
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (node_id, owner_user_id)
) STRICT;

-- ---------------------------------------------------------------------------
-- Provider drivers: run bindings and the capability cache.
-- ---------------------------------------------------------------------------
-- contract_version, resume_handle and the CLI version are provider-declared
-- strings. The CHECKs bound what SQLite can express (length, no NUL); the write
-- seam reuses the same bounds and checks semver shape.
CREATE TABLE runtime_bindings (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL,
  driver_name         TEXT NOT NULL,            -- 'claude' or 'codex'
  contract_version    TEXT NOT NULL
    CHECK(length(contract_version) > 0 AND length(contract_version) <= 64
      AND instr(contract_version, char(0)) = 0),
  cli_version_raw     TEXT                      -- verbatim provider-reported CLI version
    CHECK(cli_version_raw IS NULL OR (length(cli_version_raw) > 0
      AND length(cli_version_raw) <= 128 AND instr(cli_version_raw, char(0)) = 0)),
  -- Parsed form of the pair. The leading conjunct is the both-or-neither rule.
  cli_version_semver  TEXT
    CHECK((cli_version_semver IS NULL) = (cli_version_raw IS NULL)
      AND (cli_version_semver IS NULL OR (length(cli_version_semver) > 0
        AND length(cli_version_semver) <= 64 AND instr(cli_version_semver, char(0)) = 0))),
  resume_handle       TEXT                      -- provider-owned opaque handle
    CHECK(resume_handle IS NULL OR (length(resume_handle) > 0
      AND length(resume_handle) <= 4096 AND instr(resume_handle, char(0)) = 0)),
  runtime_metadata    TEXT NOT NULL DEFAULT '{}', -- JSON: provider-specific recovery data
  -- JSON: the spawn-bound configuration realized at spawn, re-read by recovery
  -- to rebuild the resume request. Function legs are re-injected, never stored.
  spawn_config        TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
) STRICT;

CREATE INDEX idx_runtime_bindings_run ON runtime_bindings(run_id);

-- One row per driver and flag. The hydrator refuses a cache whose row set is not
-- exactly the flag union, so a refresh writes every flag.
CREATE TABLE driver_capabilities (
  driver_name       TEXT NOT NULL,
  capability_flag   TEXT NOT NULL
                    CHECK(capability_flag IN (
                      'resume', 'steer', 'interactive_requests', 'mcp',
                      'tool_calls', 'reasoning_stream', 'model_mutation',
                      'structured_output', 'rollback', 'session_goals',
                      'callback_tools', 'subagents', 'transcript_replay',
                      'context_compaction', 'provider_commands', 'output_speed'
                    )),
  supported         INTEGER NOT NULL DEFAULT 0, -- 0 or 1
  refreshed_at      TEXT NOT NULL,
  PRIMARY KEY (driver_name, capability_flag)
) STRICT;

-- Per-tool idempotency class, so crash recovery picks its dispatch without
-- asking the driver.
CREATE TABLE driver_tools (
  driver_name        TEXT NOT NULL,
  tool_name          TEXT NOT NULL,
  idempotency_class  TEXT NOT NULL
    CHECK(idempotency_class IN ('idempotent', 'compensable', 'manual_reconcile_only')),
  description        TEXT,
  refreshed_at       TEXT NOT NULL,
  PRIMARY KEY (driver_name, tool_name)
) STRICT;

-- The per-driver parent of the capability cache: the advertised contract
-- version, so a cold start rebuilds the capability result without the driver.
-- A NULL CLI-version pair is a cache miss; the version is never invented.
CREATE TABLE driver_contract_meta (
  driver_name         TEXT PRIMARY KEY,
  contract_version    TEXT NOT NULL
    CHECK(length(contract_version) > 0 AND length(contract_version) <= 64
      AND instr(contract_version, char(0)) = 0),
  cli_version_raw     TEXT
    CHECK(cli_version_raw IS NULL OR (length(cli_version_raw) > 0
      AND length(cli_version_raw) <= 128 AND instr(cli_version_raw, char(0)) = 0)),
  cli_version_semver  TEXT
    CHECK((cli_version_semver IS NULL) = (cli_version_raw IS NULL)
      AND (cli_version_semver IS NULL OR (length(cli_version_semver) > 0
        AND length(cli_version_semver) <= 64 AND instr(cli_version_semver, char(0)) = 0))),
  refreshed_at        TEXT NOT NULL
) STRICT;

-- ---------------------------------------------------------------------------
-- Repositories, workspaces, worktrees and run execution roots.
-- ---------------------------------------------------------------------------
-- A mount belongs to the machine, not to a session. local_path is what the
-- user entered; canonical_root is the resolver's absolute, symlink-resolved
-- path, and every trust check keys on it.
CREATE TABLE repo_mounts (
  id              TEXT PRIMARY KEY,
  node_id         TEXT NOT NULL,                -- the daemon's own node, stamped at attach
  local_path      TEXT NOT NULL,
  canonical_root  TEXT NOT NULL,
  vcs_type        TEXT NOT NULL DEFAULT 'git'
                  CHECK(vcs_type IN ('git')),
  state           TEXT NOT NULL DEFAULT 'attached'
                  CHECK(state IN ('attached', 'detached', 'archived')),
  attached_at     TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  metadata        TEXT NOT NULL DEFAULT '{}'    -- JSON
) STRICT;

-- Two aliases of one root on one machine are one mount; the same path on two
-- machines is two filesystems; a detached row does not block a re-attach.
CREATE UNIQUE INDEX idx_repo_mounts_active_root
  ON repo_mounts(node_id, canonical_root) WHERE state = 'attached';

CREATE TABLE workspaces (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  repo_mount_id   TEXT NOT NULL REFERENCES repo_mounts(id),
  execution_mode  TEXT NOT NULL
                  CHECK(execution_mode IN ('bound-root', 'provisioned-worktree')),
  fs_root         TEXT,                         -- NULL while the root is provisioning
  state           TEXT NOT NULL DEFAULT 'preparing'
                  CHECK(state IN ('preparing', 'ready', 'busy', 'stale', 'archived')),
  metadata        TEXT NOT NULL DEFAULT '{}',   -- JSON; lastError after a failed mode switch
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;

CREATE INDEX idx_workspaces_session ON workspaces(session_id);
CREATE INDEX idx_workspaces_repo ON workspaces(repo_mount_id);

-- Session and run ids are event-sourced, so they carry no foreign key.
CREATE TABLE worktrees (
  id                    TEXT PRIMARY KEY,
  repo_mount_id         TEXT NOT NULL REFERENCES repo_mounts(id),
  created_by_session_id TEXT NOT NULL,
  created_by_run_id     TEXT,                   -- NULL for a prepare before any run
  branch_name           TEXT NOT NULL,
  fs_root               TEXT NOT NULL,          -- under the daemon's execution-roots directory
  state                 TEXT NOT NULL DEFAULT 'creating'
    CHECK(state IN ('creating', 'ready', 'dirty', 'merged', 'retired', 'failed')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  -- stamped by the disk-cleanup sweep after retirement
  cleaned_at            TEXT
) STRICT;

CREATE INDEX idx_worktrees_repo ON worktrees(repo_mount_id);
-- Git's own rule: a checkout on disk (any state but retired or failed, merged
-- included) holds its branch. This index arbitrates a creation race.
CREATE UNIQUE INDEX idx_worktrees_active_branch ON worktrees(repo_mount_id, branch_name)
  WHERE state NOT IN ('retired', 'failed');

-- A provisioned-worktree row names its worktree; a bound-root row names none
-- (the mount's own checkout has no root row).
CREATE TABLE branch_contexts (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  worktree_id   TEXT REFERENCES worktrees(id),
  base_branch   TEXT NOT NULL,
  head_branch   TEXT NOT NULL,
  upstream_ref  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;

CREATE INDEX idx_branch_contexts_workspace ON branch_contexts(workspace_id);
-- One binding row per (worktree, workspace): the upsert key.
CREATE UNIQUE INDEX idx_branch_contexts_worktree_workspace
  ON branch_contexts(worktree_id, workspace_id) WHERE worktree_id IS NOT NULL;

-- released_at stamps the run-terminal release of the root.
CREATE TABLE run_execution_contexts (
  run_id             TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  execution_mode     TEXT NOT NULL
                     CHECK(execution_mode IN ('bound-root', 'provisioned-worktree')),
  execution_root     TEXT NOT NULL,
  -- git rev-parse --git-common-dir (absolute) at creation: the git dir that
  -- outlives a retired worktree, so snapshot refs can still be pruned.
  git_common_dir     TEXT NOT NULL,
  worktree_id        TEXT REFERENCES worktrees(id),
  branch_context_id  TEXT REFERENCES branch_contexts(id),
  created_at         TEXT NOT NULL,
  released_at        TEXT,
  -- The mode names which root id is present; both modes carry their branch
  -- context.
  CHECK(
    (execution_mode = 'bound-root' AND worktree_id IS NULL AND branch_context_id IS NOT NULL)
    OR (execution_mode = 'provisioned-worktree'
        AND worktree_id IS NOT NULL AND branch_context_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_run_execution_contexts_workspace ON run_execution_contexts(workspace_id);

-- ---------------------------------------------------------------------------
-- The admission queue, interventions and command receipts.
-- ---------------------------------------------------------------------------
-- A queued item's body never rides payload: a user-authored body is sealed into
-- pii_payload under the author's key. Orchestration-authored content is session
-- work product, not personal data, and stays in payload with both PII columns
-- NULL. pii_user_id is unindexed on both tables: it is read only by a
-- maintenance scan, and an index would cost every write.
CREATE TABLE queue_items (
  id                        TEXT PRIMARY KEY,
  session_id                TEXT NOT NULL,
  state                     TEXT NOT NULL DEFAULT 'queued'
    CHECK(state IN ('queued', 'admitted', 'superseded', 'canceled', 'not_delivered')),
  priority                  INTEGER NOT NULL DEFAULT 0, -- higher is more urgent
  payload                   TEXT NOT NULL DEFAULT '{}', -- JSON, non-PII members only
  pii_payload               BLOB,
  pii_user_id               TEXT,
  -- Run-bound admission: NULL on an ordinary item, which admission turns into a
  -- new run. Set only by the edit-and-resend composite, whose item is delivered
  -- into its bound run on resume.
  target_run_id             TEXT,
  -- The intervention whose admission created this item, written in the same
  -- transaction as target_run_id.
  admitting_intervention_id TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
) STRICT;

CREATE INDEX idx_queue_items_session_state ON queue_items(session_id, state);
CREATE INDEX idx_queue_items_target_run ON queue_items(target_run_id)
  WHERE target_run_id IS NOT NULL;

CREATE TABLE interventions (
  id                      TEXT PRIMARY KEY,
  target_run_id           TEXT NOT NULL,
  type                    TEXT NOT NULL
                          CHECK(type IN ('steer', 'interrupt', 'cancel')),
  state                   TEXT NOT NULL DEFAULT 'requested'
    CHECK(state IN ('requested', 'accepted', 'applied', 'rejected', 'degraded', 'expired')),
  -- JSON, non-PII fields only; a steer's text is in pii_payload
  payload                 TEXT NOT NULL DEFAULT '{}',
  expected_run_version    INTEGER NOT NULL,           -- the fail-closed comparand
  client_idempotency_key  TEXT NOT NULL,              -- requester-generated UUID
  -- The user-authored body, sealed under the requester's key. The retention pass
  -- NULLs it after the 90-day full-retention bound.
  pii_payload             BLOB,
  pii_user_id             TEXT,
  -- 'user' for a request over an identity-carrying transport, 'system' for the
  -- in-process orchestration entry. No DEFAULT: a default would fail open, so
  -- every insert names its path.
  origin                  TEXT NOT NULL
                          CHECK(origin IN ('user', 'system')),
  result                  TEXT,                       -- JSON outcome
  -- Why a request was rejected. A rejected outcome carries no result, so an
  -- idempotent replay rebuilds rejectionReason from here.
  rejection_reason        TEXT,
  created_at              TEXT NOT NULL,
  resolved_at             TEXT,
  -- An identical retry replays the recorded outcome; a reused key with a
  -- different payload is refused (intervention.idempotency_conflict).
  UNIQUE (target_run_id, client_idempotency_key)
) STRICT;

CREATE INDEX idx_interventions_run ON interventions(target_run_id);
CREATE INDEX idx_interventions_state ON interventions(state)
  WHERE state IN ('requested', 'accepted');

CREATE TABLE command_receipts (
  id            TEXT PRIMARY KEY,
  command_id    TEXT NOT NULL UNIQUE,         -- client-supplied idempotency key
  run_id        TEXT,
  status        TEXT NOT NULL
                CHECK(status IN ('accepted', 'rejected', 'completed', 'failed')),
  created_at    TEXT NOT NULL,
  -- The receiver-generated MCP Tasks taskId from its acceptance. NULL until the
  -- acceptance is stored, so a crash before it leaves the call on the
  -- manual-reconcile halt. Untrusted peer output: the write seam checks the same
  -- 256 bound and names the violation.
  mcp_task_id   TEXT
    CHECK(mcp_task_id IS NULL OR (length(mcp_task_id) > 0
      AND length(mcp_task_id) <= 256 AND instr(mcp_task_id, char(0)) = 0))
) STRICT;

CREATE INDEX idx_command_receipts_run ON command_receipts(run_id) WHERE run_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Provider accounts and their quota readings.
-- ---------------------------------------------------------------------------
-- No credential material in any column: credentials live in each account's
-- credential home, written by the provider's own tooling.
CREATE TABLE provider_accounts (
  -- Daemon-minted and immutable. NOT NULL is explicit because a rowid table's
  -- TEXT PRIMARY KEY otherwise admits NULL, and NULLs never collide
  -- (sqlite.org/quirks.html#primary_keys_can_sometimes_contain_nulls).
  account_id                TEXT NOT NULL PRIMARY KEY,
  provider                  TEXT NOT NULL
                            CHECK(provider IN ('claude', 'codex')),
  display_label             TEXT NOT NULL,      -- the user's label; treated as personal data
  -- The daemon builds each spawn environment from this path and never inherits
  -- ambient provider credentials.
  credential_home_path      TEXT NOT NULL,
  -- Starts at 1 and is bumped at every credential-home transition. Below 1 a
  -- reading would sort before the account it describes; typeof refuses 1.5,
  -- which INTEGER affinity would otherwise keep as REAL.
  credential_generation     INTEGER NOT NULL DEFAULT 1
    CHECK(typeof(credential_generation) = 'integer' AND credential_generation >= 1),
  -- How the account is charged; 'unknown' is honest absence, never 'metered'.
  -- Labels cost, never derives it.
  billing_mode              TEXT NOT NULL
                            CHECK(billing_mode IN ('subscription', 'metered', 'unknown')),
  is_default                INTEGER NOT NULL DEFAULT 0
                            CHECK(is_default IN (0, 1)),
  -- The stored outcome of the last validation: the authentication probe with the
  -- credential-home observation taken with it. NULL until first probed, shown as
  -- indeterminate. A registry read never re-derives it, so a read spawns nothing.
  health_state              TEXT
    CHECK(health_state IS NULL
      OR health_state IN ('authenticated', 'reauth_required', 'home_missing', 'indeterminate')),
  -- When health_state was observed; not updated_at, which a relabel moves.
  health_observed_at        TEXT,
  -- The mode the provider's own status surface reports, never assumed. 'unknown'
  -- is a mode this daemon does not recognize, so a new vendor mode does not fail
  -- the observation.
  observed_auth_mode        TEXT
    CHECK(observed_auth_mode IS NULL OR observed_auth_mode IN
      ('oauth_subscription', 'oauth_token', 'api_key', 'external', 'none', 'unknown')),
  last_refresh_observed_at  TEXT,               -- NULL means not observed, never "fine"
  -- When the credential was issued: the observed sign-in, or a token's issuance
  -- time from the provider or the user. Never the registration time, which can
  -- be months later. NULL renders the re-login estimate as unknown.
  logged_in_at              TEXT,
  -- Provider-reported identity, so two accounts of one provider can be told
  -- apart. Replaced by a later observation; never logged, evented or put on an
  -- error.
  observed_account_email    TEXT,
  observed_account_org_id   TEXT,
  observed_account_org_name TEXT,
  -- Removal marks this first, then destroys the sealed token, then deletes the
  -- row: SQLite and the keystore commit separately, so a crash strands a row
  -- marked unusable, never a live secret. Admission refuses a marked account.
  removal_intent            INTEGER NOT NULL DEFAULT 0
                            CHECK(removal_intent IN (0, 1)),
  -- Opt-out for the background health observer only; the probe verb and spawn
  -- validation still write the pair.
  probe_enabled             INTEGER NOT NULL DEFAULT 1
                            CHECK(probe_enabled IN (0, 1)),
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  -- The observation is a pair: a reading without its time, or a time without a
  -- reading, is refused.
  CHECK((health_state IS NULL) = (health_observed_at IS NULL))
) STRICT;

-- One default per provider. Two concurrent set-default calls would each see no
-- other default; the index refuses the second.
CREATE UNIQUE INDEX provider_accounts_one_default_per_provider
  ON provider_accounts(provider)
  WHERE is_default = 1;

-- One account per credential home, across providers: two rows on one home would
-- share credentials and spend.
CREATE UNIQUE INDEX provider_accounts_unique_credential_home
  ON provider_accounts(credential_home_path);

-- The newest quota reading per account and limit. Keyed by limit, not window
-- length: one provider publishes several limits that share a window length.
CREATE TABLE provider_account_usage_windows (
  account_id    TEXT NOT NULL
                REFERENCES provider_accounts(account_id) ON DELETE CASCADE,
  -- The provider's own identifier, verbatim and untrusted; 'default' when the
  -- reading names none. Not a CHECK: the provider's limit set is open.
  limit_id      TEXT NOT NULL,
  window_mins   INTEGER NOT NULL,               -- an attribute: the limit determines it
  label         TEXT,                           -- display only
  -- Not capped at 100: a provider may report over-consumption.
  used_percent  REAL NOT NULL
                CHECK(used_percent >= 0),
  resets_at     TEXT,                           -- NULL is unknown, never "now"
  -- The ordering key: the later reading is current; source breaks exact ties.
  observed_at   TEXT NOT NULL,
  -- The account's generation when read. A home rebuild keeps these rows (the
  -- provider-side allowance keeps running), so this stamp marks a pre-rebuild
  -- reading stale. Same floor and storage class as the parent's generation.
  observed_credential_generation INTEGER NOT NULL
    CHECK(typeof(observed_credential_generation) = 'integer'
      AND observed_credential_generation >= 1),
  -- The deliberate probe verb or real traffic. The background observer is not a
  -- source: reading quota there would trigger a proactive credential refresh.
  source        TEXT NOT NULL
                CHECK(source IN ('probe', 'run')),
  PRIMARY KEY (account_id, limit_id)
) STRICT;
`;
