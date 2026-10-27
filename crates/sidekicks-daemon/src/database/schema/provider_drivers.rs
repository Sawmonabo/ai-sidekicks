//! The provider drivers' part of the daemon's schema. A run's binding to its provider and the
//! conversations a session left on its provider are truth no event holds: recovery resumes from
//! the binding, and the purge deletes every conversation left. The capability cache is a cache of
//! what each driver last reported, so a cold start answers without asking the driver. Every
//! provider-declared text column is bounded by the same constants its write checks.

use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_CONTRACT_VERSION_MAX_LEN;
use sidekicks_contracts::provider::driver::tools::IdempotencyClass;

use crate::driver::capabilities::DriverCapabilityFlag;
use crate::output_validation::{
    CLI_VERSION_RAW_MAX_LEN, CLI_VERSION_SEMVER_MAX_LEN, RESUME_HANDLE_MAX_LEN,
};
use sidekicks_store::database::schema::{SchemaPart, SchemaParts};
use sidekicks_store::database::sql_list::sql_list_of_every;

/// The worktrees' list and the provider drivers' own part.
pub(crate) fn schema_parts() -> SchemaParts {
    sidekicks_workspace::git::worktree::schema::schema_parts().with_part(SchemaPart::new(
        "provider_drivers",
        provider_drivers_schema_sql(),
    ))
}

// The provider drivers' tables and indexes.
fn provider_drivers_schema_sql() -> String {
    let capability_flags = sql_list_of_every::<DriverCapabilityFlag>();
    let idempotency_classes = sql_list_of_every::<IdempotencyClass>();
    let contract_version_check = format!(
        "length(contract_version) > 0 AND length(contract_version) <= \
         {PROVIDER_WIRE_CONTRACT_VERSION_MAX_LEN} AND instr(contract_version, char(0)) = 0"
    );
    let cli_version_raw_bound = format!(
        "length(cli_version_raw) > 0 AND length(cli_version_raw) <= {CLI_VERSION_RAW_MAX_LEN} \
         AND instr(cli_version_raw, char(0)) = 0"
    );
    let cli_version_semver_check = format!(
        "cli_version_semver IS NULL OR (length(cli_version_semver) > 0 \
         AND length(cli_version_semver) <= {CLI_VERSION_SEMVER_MAX_LEN} \
         AND instr(cli_version_semver, char(0)) = 0)"
    );
    format!(
        "
-- ---------------------------------------------------------------------------
-- Provider drivers: run bindings, left conversations and the capability cache.
-- ---------------------------------------------------------------------------
-- contract_version, resume_handle and the CLI version are provider-declared text. The `CHECK` constraints bound
-- what SQLite can express (length in code points, no NUL); the write checks the same bounds and
-- the semantic-version shape.
CREATE TABLE runtime_bindings (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL,
  provider_name       TEXT NOT NULL,            -- the provider's open id
  contract_version    TEXT NOT NULL CHECK({contract_version_check}),
  -- The provider-printed CLI version verbatim, captured at every binding write.
  cli_version_raw     TEXT NOT NULL CHECK({cli_version_raw_bound}),
  -- Its parsed form; NULL where the printed version does not parse. Shown, never compared.
  cli_version_semver  TEXT CHECK({cli_version_semver_check}),
  resume_handle       TEXT                      -- provider-owned opaque handle
                      CHECK(resume_handle IS NULL OR (length(resume_handle) > 0
                        AND length(resume_handle) <= {RESUME_HANDLE_MAX_LEN}
                        AND instr(resume_handle, char(0)) = 0)),
  -- JSON: the spawn-bound configuration realized at spawn, re-read by recovery to rebuild the
  -- resume request. Function legs are re-injected, never stored.
  spawn_config        TEXT NOT NULL DEFAULT '{{}}',
  runtime_metadata    TEXT NOT NULL DEFAULT '{{}}', -- JSON: provider-specific recovery data
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
) STRICT;

CREATE INDEX idx_runtime_bindings_run ON runtime_bindings(run_id);

-- Each conversation a session left on its provider: the one a fork moved it off, or the one a
-- restart's resume forked away from. Written in the same write as the binding's new resume handle;
-- the whole-session purge deletes each on its provider.
CREATE TABLE left_conversations (
  session_id           TEXT NOT NULL,
  provider_name        TEXT NOT NULL,
  provider_account_id  TEXT,                    -- NULL on the machine's default home
  conversation_id      TEXT NOT NULL            -- provider-owned, bounded as resume_handle is
                       CHECK(length(conversation_id) > 0
                         AND length(conversation_id) <= {RESUME_HANDLE_MAX_LEN}
                         AND instr(conversation_id, char(0)) = 0),
  left_at              TEXT NOT NULL,
  PRIMARY KEY (provider_name, conversation_id)
) STRICT;

CREATE INDEX idx_left_conversations_session ON left_conversations(session_id);

-- One row per provider and flag, supported = 0 where the driver does not declare it. The reader
-- refuses a cache whose row set is not exactly the flag set, so a refresh writes every flag.
CREATE TABLE driver_capabilities (
  provider_name     TEXT NOT NULL,
  capability_flag   TEXT NOT NULL CHECK(capability_flag IN ({capability_flags})),
  supported         INTEGER NOT NULL DEFAULT 0 CHECK(supported IN (0, 1)),
  refreshed_at      TEXT NOT NULL,
  PRIMARY KEY (provider_name, capability_flag)
) STRICT;

-- Each tool's idempotency class as the driver declared it, so the capability result is rebuilt
-- without asking the driver; recovery never branches on it.
CREATE TABLE driver_tools (
  provider_name      TEXT NOT NULL,
  tool_name          TEXT NOT NULL,
  idempotency_class  TEXT NOT NULL CHECK(idempotency_class IN ({idempotency_classes})),
  description        TEXT,
  refreshed_at       TEXT NOT NULL,
  PRIMARY KEY (provider_name, tool_name)
) STRICT;

-- The parent of the capability cache per provider: the advertised contract version, so a cold
-- start rebuilds the capability result without the driver. A NULL CLI version is a cache miss; the
-- version is never invented.
CREATE TABLE driver_contract_meta (
  provider_name       TEXT PRIMARY KEY,
  contract_version    TEXT NOT NULL CHECK({contract_version_check}),
  cli_version_raw     TEXT CHECK(cli_version_raw IS NULL OR ({cli_version_raw_bound})),
  cli_version_semver  TEXT
                      CHECK((cli_version_raw IS NOT NULL OR cli_version_semver IS NULL)
                        AND ({cli_version_semver_check})),
  -- Every capability refresh, and the refresh of the CLI version alone, so it may lead
  -- driver_capabilities.refreshed_at.
  refreshed_at        TEXT NOT NULL
) STRICT;
"
    )
}
