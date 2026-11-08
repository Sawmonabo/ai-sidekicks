//! The MCP part of the daemon's schema: the command receipts, the two-phase record that keeps a
//! side-effecting tool call from running twice across a restart, and the handle a task-augmented
//! call is resumed by; and the governance tables, which hold only what the daemon itself decides
//! about each server binding, never a copy of a provider's own config.

use sidekicks_contracts::mcp::server::inventory::McpAssignableIdempotencyClass;
use sidekicks_contracts::mcp::server::{McpApprovalMode, McpBindingScope};
use sidekicks_store::database::schema::{SchemaPart, SchemaParts};
use sidekicks_store::database::sql_list::{sql_list_of, sql_list_of_every};

use crate::binding::store::PROJECT_SWITCH_SCOPES;
use crate::client::tasks::recorder::MCP_TASK_ID_MAX_LENGTH;
use crate::client::tasks::{McpServerEndpoint, McpTaskGeneration};
use crate::command_receipts::{CommandAcceptance, CommandOutcome};

/// A governance mutation's receipt status: written `pending` before the provider is touched, and
/// `committed` with the saved response in the same write as the mutation's own rows. Stored by its
/// camelCase name.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, strum::EnumString, strum::IntoStaticStr, strum::VariantArray,
)]
#[strum(serialize_all = "camelCase")]
pub(crate) enum McpMutationReceiptStatus {
    /// The intent is recorded and the mutation has not finished.
    Pending,
    /// The mutation finished and its response is saved.
    Committed,
}

/// The provider drivers' list, the command receipts' own part and the MCP governance tables.
pub fn schema_parts() -> SchemaParts {
    sidekicks_provider::driver::schema::schema_parts()
        .with_part(SchemaPart::new(
            "command_receipts",
            command_receipts_schema_sql(),
        ))
        .with_part(SchemaPart::new(
            "mcp_governance",
            mcp_governance_schema_sql(),
        ))
}

// The command receipts' table and indexes.
fn command_receipts_schema_sql() -> String {
    let receipt_statuses = format!(
        "{}, {}",
        sql_list_of_every::<CommandAcceptance>(),
        sql_list_of_every::<CommandOutcome>()
    );
    let task_generations = sql_list_of_every::<McpTaskGeneration>();
    let stdio_endpoint = McpServerEndpoint::STDIO;
    let address_endpoint_glob = format!(
        "{}{}",
        McpServerEndpoint::ADDRESS_PREFIX,
        "[0-9a-f]".repeat(McpServerEndpoint::ADDRESS_DIGEST_HEX_LEN)
    );
    format!(
        "
-- ---------------------------------------------------------------------------
-- Command receipts.
-- ---------------------------------------------------------------------------
CREATE TABLE command_receipts (
  id                   TEXT PRIMARY KEY,
  command_id           TEXT NOT NULL UNIQUE,      -- the client-supplied idempotency key
  run_id               TEXT NOT NULL,
  status               TEXT NOT NULL CHECK(status IN ({receipt_statuses})),
  -- started_at is set in the write that records the command, and completed_at by its end's write.
  -- Started and not completed is in flight.
  started_at           TEXT,
  completed_at         TEXT,
  -- The receiver-generated task id from a task-augmented call's acceptance, the one handle the
  -- call is resumed by after a restart. NULL until the acceptance is stored; a call a restart
  -- finds with no handle is never run again, and its run goes on, told the outcome is unknown.
  -- Untrusted peer output, bounded in code points.
  mcp_task_id          TEXT
                       CHECK(mcp_task_id IS NULL OR (length(mcp_task_id) > 0
                         AND length(mcp_task_id) <= {MCP_TASK_ID_MAX_LENGTH}
                         AND instr(mcp_task_id, char(0)) = 0)),
  -- The task's protocol generation, set exactly when mcp_task_id is and in the same statement,
  -- since a task is resumed by its generation.
  mcp_task_generation  TEXT CHECK(mcp_task_generation IN ({task_generations})),
  -- The name of the server the task was accepted on; a resume reaches only that server.
  mcp_server_name      TEXT,
  -- Which server the task was accepted on, by its endpoint; a resume reaches only that server.
  mcp_server_endpoint  TEXT CHECK(mcp_server_endpoint IS NULL
                         OR mcp_server_endpoint = '{stdio_endpoint}'
                         OR mcp_server_endpoint GLOB '{address_endpoint_glob}'),
  -- 1 once the call moved to the background, so its result is owed a delivery.
  backgrounded         INTEGER NOT NULL DEFAULT 0 CHECK(backgrounded IN (0, 1)),
  -- 1 once a backgrounded call's result has reached the conversation, so a result that arrives
  -- after a restart is delivered once; only a backgrounded call's result is owed a delivery.
  delivered            INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0, 1)),
  created_at           TEXT NOT NULL,
  -- The task's handle, generation, server name and endpoint are set together or NULL together.
  CHECK((mcp_task_id IS NULL) = (mcp_task_generation IS NULL)
    AND (mcp_task_id IS NULL) = (mcp_server_name IS NULL)
    AND (mcp_task_id IS NULL) = (mcp_server_endpoint IS NULL)),
  CHECK(delivered <= backgrounded)
) STRICT;

CREATE INDEX idx_command_receipts_run ON command_receipts(run_id);
-- The in-flight receipts the restart's sweep reads.
CREATE INDEX idx_command_receipts_inflight ON command_receipts(run_id)
  WHERE started_at IS NOT NULL AND completed_at IS NULL;
"
    )
}

// The MCP governance tables. A binding's identity is (provider, scope, scope_ref, scope_place,
// server_name): same-named servers in two scopes, and one project path in two distributions, are
// two keys. No column holds a config value, a credential or key material.
fn mcp_governance_schema_sql() -> String {
    let scopes = sql_list_of_every::<McpBindingScope>();
    let scopes_without_ref =
        sql_list_of([McpBindingScope::User, McpBindingScope::Managed].map(<&str>::from));
    let scopes_with_place =
        sql_list_of([McpBindingScope::Project, McpBindingScope::Local].map(<&str>::from));
    let switchable_scopes = sql_list_of(PROJECT_SWITCH_SCOPES.map(<&str>::from));
    let managed = <&'static str>::from(McpBindingScope::Managed);
    let approval_modes = sql_list_of_every::<McpApprovalMode>();
    let idempotency_classes = sql_list_of_every::<McpAssignableIdempotencyClass>();
    let receipt_statuses = sql_list_of_every::<McpMutationReceiptStatus>();
    let committed = <&'static str>::from(McpMutationReceiptStatus::Committed);
    format!(
        "
-- ---------------------------------------------------------------------------
-- mcp_server_bindings: each binding's governance row, written when the binding is first observed.
-- ---------------------------------------------------------------------------
CREATE TABLE mcp_server_bindings (
  -- The provider's open id, as written.
  provider                   TEXT NOT NULL,
  scope                      TEXT NOT NULL CHECK(scope IN ({scopes})),
  -- The project root, the keying folder, the plugin's name or the provider account's id; '' where
  -- the scope has none.
  scope_ref                  TEXT NOT NULL DEFAULT '',
  -- The WSL 2 distribution a project or local root is in; '' elsewhere.
  scope_place                TEXT NOT NULL DEFAULT '',
  server_name                TEXT NOT NULL,
  -- The daemon's own switch for a binding whose provider keeps none; NULL is no overlay.
  enabled_override           INTEGER
                             CHECK(enabled_override IS NULL OR enabled_override IN (0, 1)),
  -- JSON: the binding's own tool fields in the provider's config before the daemon first wrote a
  -- tool override there, kept while any override is written and dropped once none is, so clearing
  -- an override restores what the provider had.
  native_tool_baseline_json  TEXT,
  -- The canonical address the binding's whole address last read as, which a removal signs out
  -- once its variables no longer read; NULL until one has read. It may hold credentials.
  last_declared_address      TEXT,
  first_observed_at          TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  PRIMARY KEY (provider, scope, scope_ref, scope_place, server_name),
  CHECK((scope IN ({scopes_without_ref})) = (scope_ref = '')),
  CHECK(scope IN ({scopes_with_place}) OR scope_place = '')
) STRICT;

-- ---------------------------------------------------------------------------
-- mcp_tool_overrides: one tool's overrides on one binding, deleted with the binding.
-- ---------------------------------------------------------------------------
CREATE TABLE mcp_tool_overrides (
  provider           TEXT NOT NULL,
  scope              TEXT NOT NULL CHECK(scope IN ({scopes})),
  scope_ref          TEXT NOT NULL DEFAULT '',
  scope_place        TEXT NOT NULL DEFAULT '',
  server_name        TEXT NOT NULL,
  tool_name          TEXT NOT NULL,
  -- Allowed or denied; NULL is the provider's default.
  enabled            INTEGER CHECK(enabled IS NULL OR enabled IN (0, 1)),
  approval_mode      TEXT CHECK(approval_mode IS NULL OR approval_mode IN ({approval_modes})),
  -- NULL is the floor: an interrupted call is reconciled by hand.
  idempotency_class  TEXT CHECK(idempotency_class IS NULL
                       OR idempotency_class IN ({idempotency_classes})),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (provider, scope, scope_ref, scope_place, server_name, tool_name),
  -- Clearing a row's last facet deletes the row.
  CHECK(enabled IS NOT NULL OR approval_mode IS NOT NULL OR idempotency_class IS NOT NULL),
  CHECK((scope IN ({scopes_without_ref})) = (scope_ref = '')),
  CHECK(scope IN ({scopes_with_place}) OR scope_place = ''),
  FOREIGN KEY (provider, scope, scope_ref, scope_place, server_name)
    REFERENCES mcp_server_bindings(provider, scope, scope_ref, scope_place, server_name)
    ON DELETE CASCADE
) STRICT;

-- ---------------------------------------------------------------------------
-- mcp_mutation_receipts: a governance mutation's idempotency key, written as a pending intent
-- before the provider is touched and committed in the same write as the mutation's own rows.
-- ---------------------------------------------------------------------------
CREATE TABLE mcp_mutation_receipts (
  client_idempotency_key  TEXT NOT NULL PRIMARY KEY,
  -- The mcp.* method the key was spent on.
  operation               TEXT NOT NULL,
  -- The binding the mutation writes, keyed as its row is. No foreign key: a first add's row does
  -- not exist when the receipt begins, and a committed remove's receipt outlives its binding.
  provider                TEXT NOT NULL,
  scope                   TEXT NOT NULL CHECK(scope IN ({scopes})),
  scope_ref               TEXT NOT NULL DEFAULT '',
  scope_place             TEXT NOT NULL DEFAULT '',
  server_name             TEXT NOT NULL,
  -- The keyed digest of the idempotency key and the request; NULL only on a row committed when
  -- the receipt key was lost.
  request_digest          BLOB CHECK(request_digest IS NULL OR length(request_digest) = 32),
  -- The keyed digest of the binding's declaration before the write; NULL where it had none.
  before_digest           BLOB CHECK(before_digest IS NULL OR length(before_digest) = 32),
  -- The keyed digest of the declaration the write leaves; NULL for a remove.
  after_digest            BLOB CHECK(after_digest IS NULL OR length(after_digest) = 32),
  -- A switch's wanted state; NULL for every other mutation.
  wanted_enabled          INTEGER CHECK(wanted_enabled IS NULL OR wanted_enabled IN (0, 1)),
  status                  TEXT NOT NULL CHECK(status IN ({receipt_statuses})),
  -- The response a retry with the same key gets back; NULL while pending. A sign-in's is saved
  -- without its sign-in address.
  response_json           TEXT,
  -- Committed rows older than a day are pruned on later mutation writes; a pending one is settled
  -- at start.
  created_at              TEXT NOT NULL,
  CHECK((status = '{committed}') = (response_json IS NOT NULL)),
  CHECK(request_digest IS NOT NULL OR status = '{committed}'),
  CHECK((scope IN ({scopes_without_ref})) = (scope_ref = '')),
  CHECK(scope IN ({scopes_with_place}) OR scope_place = '')
) STRICT;

-- ---------------------------------------------------------------------------
-- mcp_receipt_key_pin: the keyed hash of a fixed label under the receipt key the credential
-- store holds, never the key, which tells that key from another. One row, written when a key is
-- first held and replaced when a lost key is made again.
-- ---------------------------------------------------------------------------
CREATE TABLE mcp_receipt_key_pin (
  singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
  pin        BLOB NOT NULL CHECK(length(pin) = 32)
) STRICT;

-- ---------------------------------------------------------------------------
-- mcp_project_server_switches: the daemon's own switch for a server a provider brings itself, one
-- row per such server switched off for one project, deleted when it is switched back on.
-- ---------------------------------------------------------------------------
CREATE TABLE mcp_project_server_switches (
  provider       TEXT NOT NULL,
  scope          TEXT NOT NULL CHECK(scope IN ({switchable_scopes})),
  scope_ref      TEXT NOT NULL DEFAULT '',
  scope_place    TEXT NOT NULL DEFAULT '',
  server_name    TEXT NOT NULL,
  -- The project root the server is off for, and the distribution that root is in ('' elsewhere).
  project_root   TEXT NOT NULL,
  project_place  TEXT NOT NULL DEFAULT '',
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (provider, scope, scope_ref, scope_place, server_name, project_root, project_place),
  CHECK((scope = '{managed}') = (scope_ref = '')),
  -- Neither scope a switch takes has a distribution.
  CHECK(scope_place = ''),
  FOREIGN KEY (provider, scope, scope_ref, scope_place, server_name)
    REFERENCES mcp_server_bindings(provider, scope, scope_ref, scope_place, server_name)
    ON DELETE CASCADE
) STRICT;

-- ---------------------------------------------------------------------------
-- mcp_server_admitted_clients: which sign-in client each server admitted, one row per server
-- address however many bindings name it, kept through a sign-out. Not a credential.
-- ---------------------------------------------------------------------------
CREATE TABLE mcp_server_admitted_clients (
  -- The server's canonical address, the account its sign-in is kept under.
  server_address            TEXT NOT NULL PRIMARY KEY,
  -- The open id of the provider whose own client the server admitted; NULL until one has.
  admitted_oauth_client     TEXT,
  -- When the daemon's own client last ended an attempt with no callback; NULL otherwise.
  own_client_unfinished_at  TEXT,
  CHECK(admitted_oauth_client IS NOT NULL OR own_client_unfinished_at IS NOT NULL)
) STRICT;

-- ---------------------------------------------------------------------------
-- mcp_server_owed_sign_outs: the canonical address of a server a removed binding, or one whose
-- address changed, named, whose sign-out is owed unless another binding still names it; a removal
-- writes it before the provider's write. Not a credential.
-- ---------------------------------------------------------------------------
CREATE TABLE mcp_server_owed_sign_outs (
  server_address  TEXT NOT NULL PRIMARY KEY
) STRICT;
"
    )
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use rusqlite::{Connection, ffi, params};
    use sidekicks_contracts::mcp::server::inventory::McpAssignableIdempotencyClass;
    use sidekicks_contracts::mcp::server::{McpApprovalMode, McpBindingScope};
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use strum::VariantArray;

    use super::{McpMutationReceiptStatus, schema_parts};

    // The daemon's own open of a fresh file, so the schema is built and foreign keys are on.
    fn open_database() -> (TestDatabase, Connection) {
        let database = TestDatabase::new(schema_parts());
        let connection = database.opener()().expect("the test creates its database");
        (database, connection)
    }

    fn insert_binding(
        connection: &Connection,
        scope: &str,
        scope_ref: &str,
        scope_place: &str,
        server_name: &str,
    ) -> rusqlite::Result<usize> {
        connection.execute(
            "INSERT INTO mcp_server_bindings
               (provider, scope, scope_ref, scope_place, server_name, first_observed_at, updated_at)
             VALUES ('provider-a', ?1, ?2, ?3, ?4, 't', 't')",
            params![scope, scope_ref, scope_place, server_name],
        )
    }

    fn count_rows(connection: &Connection, table: &str) -> i64 {
        connection
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .expect("the test counts the table's rows")
    }

    // Every member of each closed set is stored as the wire spells it, on a binding whose
    // reference and place fit its scope.
    #[test]
    fn every_closed_value_is_stored() {
        let (_database, connection) = open_database();

        for scope in McpBindingScope::VARIANTS {
            let (scope_ref, scope_place) = match scope {
                McpBindingScope::User | McpBindingScope::Managed => ("", ""),
                McpBindingScope::Project | McpBindingScope::Local => ("/repo", "Ubuntu"),
                McpBindingScope::Plugin => ("tools-plugin", ""),
                McpBindingScope::Connector => ("account-1", ""),
            };
            let word = serde_json::to_value(scope).expect("a scope is JSON");
            insert_binding(
                &connection,
                word.as_str().expect("a scope is a JSON string"),
                scope_ref,
                scope_place,
                "server",
            )
            .unwrap_or_else(|error| panic!("a {scope:?} binding is stored: {error}"));
        }
        for approval_mode in McpApprovalMode::VARIANTS {
            let word = serde_json::to_value(approval_mode).expect("an approval mode is JSON");
            let word = word.as_str().expect("an approval mode is a JSON string");
            connection
                .execute(
                    "INSERT INTO mcp_tool_overrides (provider, scope, server_name, tool_name,
                       approval_mode, created_at, updated_at)
                     VALUES ('provider-a', 'user', 'server', ?1, ?1, 't', 't')",
                    params![word],
                )
                .unwrap_or_else(|error| panic!("approval mode {word} is stored: {error}"));
        }
        for idempotency_class in McpAssignableIdempotencyClass::VARIANTS {
            let word =
                serde_json::to_value(idempotency_class).expect("an idempotency class is JSON");
            let word = word
                .as_str()
                .expect("an idempotency class is a JSON string");
            connection
                .execute(
                    "INSERT INTO mcp_tool_overrides (provider, scope, server_name, tool_name,
                       idempotency_class, created_at, updated_at)
                     VALUES ('provider-a', 'user', 'server', ?1, ?1, 't', 't')",
                    params![word],
                )
                .unwrap_or_else(|error| panic!("idempotency class {word} is stored: {error}"));
        }
        for status in McpMutationReceiptStatus::VARIANTS {
            let word: &str = (*status).into();
            let response = match status {
                McpMutationReceiptStatus::Pending => None,
                McpMutationReceiptStatus::Committed => Some("{}"),
            };
            connection
                .execute(
                    "INSERT INTO mcp_mutation_receipts (client_idempotency_key, operation,
                       provider, scope, server_name, request_digest, status, response_json,
                       created_at)
                     VALUES (?1, 'mcp.server.upsert', 'provider-a', 'user', 'server',
                       zeroblob(32), ?1, ?2, 't')",
                    params![word, response],
                )
                .unwrap_or_else(|error| panic!("receipt status {word} is stored: {error}"));
        }

        assert_eq!(
            count_rows(&connection, "mcp_server_bindings"),
            i64::try_from(McpBindingScope::VARIANTS.len()).expect("the scopes fit an i64")
        );
    }

    // Each row breaks exactly one CHECK and passes every other constraint, its binding included,
    // so only that CHECK can refuse it.
    #[rstest]
    #[case::outsider_scope(
        "INSERT INTO mcp_server_bindings (provider, scope, scope_ref, server_name,
           first_observed_at, updated_at)
         VALUES ('provider-a', 'team', 'team-1', 'server', 't', 't')"
    )]
    #[case::outsider_override_scope(
        "INSERT INTO mcp_tool_overrides (provider, scope, scope_ref, server_name, tool_name,
           enabled, created_at, updated_at)
         VALUES ('provider-a', 'team', 'team-1', 'server', 'tool', 0, 't', 't')"
    )]
    #[case::outsider_approval_mode(
        "INSERT INTO mcp_tool_overrides (provider, scope, server_name, tool_name, approval_mode,
           created_at, updated_at)
         VALUES ('provider-a', 'user', 'server', 'tool', 'never', 't', 't')"
    )]
    #[case::outsider_idempotency_class(
        "INSERT INTO mcp_tool_overrides (provider, scope, server_name, tool_name,
           idempotency_class, created_at, updated_at)
         VALUES ('provider-a', 'user', 'server', 'tool', 'manualReconcileOnly', 't', 't')"
    )]
    #[case::outsider_receipt_status(
        "INSERT INTO mcp_mutation_receipts (client_idempotency_key, operation, provider, scope,
           server_name, request_digest, status, created_at)
         VALUES ('key-1', 'mcp.server.upsert', 'provider-a', 'user', 'server', zeroblob(32),
           'expired', 't')"
    )]
    #[case::pending_without_request_digest(
        "INSERT INTO mcp_mutation_receipts (client_idempotency_key, operation, provider, scope,
           server_name, status, created_at)
         VALUES ('key-1', 'mcp.server.upsert', 'provider-a', 'user', 'server', 'pending', 't')"
    )]
    #[case::outsider_switch_scope(
        "INSERT INTO mcp_project_server_switches (provider, scope, scope_ref, server_name,
           project_root, updated_at)
         VALUES ('provider-a', 'project', '/repo', 'server', '/repo', 't')"
    )]
    #[case::user_with_ref(
        "INSERT INTO mcp_server_bindings (provider, scope, scope_ref, server_name,
           first_observed_at, updated_at) VALUES ('provider-a', 'user', '/repo', 'other', 't', 't')"
    )]
    #[case::managed_with_ref(
        "INSERT INTO mcp_server_bindings (provider, scope, scope_ref, server_name,
           first_observed_at, updated_at)
         VALUES ('provider-a', 'managed', 'org', 'other', 't', 't')"
    )]
    #[case::user_with_place(
        "INSERT INTO mcp_server_bindings (provider, scope, scope_place, server_name,
           first_observed_at, updated_at)
         VALUES ('provider-a', 'user', 'Ubuntu', 'other', 't', 't')"
    )]
    fn a_row_outside_a_closed_column_or_its_scope_rules_is_refused(#[case] statement: &str) {
        let (_database, connection) = open_database();
        insert_binding(&connection, "user", "", "", "server").expect("the user binding is stored");
        insert_binding(&connection, "project", "/repo", "", "server")
            .expect("the project binding is stored");

        let refusal = connection
            .execute(statement, [])
            .expect_err("the row is refused");

        assert_eq!(
            refusal.sqlite_error().map(|failure| failure.extended_code),
            Some(ffi::SQLITE_CONSTRAINT_CHECK),
            "a CHECK refuses the row: {refusal}"
        );
    }

    // The distribution is part of the key, so one project path in two distributions is two
    // bindings.
    #[test]
    fn one_project_path_in_two_distributions_is_two_bindings() {
        let (_database, connection) = open_database();

        insert_binding(&connection, "project", "/repo", "", "server")
            .expect("the binding with no distribution is stored");
        insert_binding(&connection, "project", "/repo", "Ubuntu", "server")
            .expect("the binding in a distribution is stored beside it");

        assert_eq!(count_rows(&connection, "mcp_server_bindings"), 2);
    }

    // A binding's overrides and project switches never outlive its row.
    #[test]
    fn deleting_a_binding_deletes_its_overrides_and_switches() {
        let (_database, connection) = open_database();
        insert_binding(&connection, "connector", "account-1", "", "Slack")
            .expect("the connector binding is stored");
        connection
            .execute(
                "INSERT INTO mcp_tool_overrides (provider, scope, scope_ref, server_name, tool_name,
                   enabled, created_at, updated_at)
                 VALUES ('provider-a', 'connector', 'account-1', 'Slack', 'search', 0, 't', 't')",
                [],
            )
            .expect("the override is stored");
        connection
            .execute(
                "INSERT INTO mcp_project_server_switches (provider, scope, scope_ref, server_name,
                   project_root, updated_at)
                 VALUES ('provider-a', 'connector', 'account-1', 'Slack', '/repo', 't')",
                [],
            )
            .expect("the switch is stored");

        connection
            .execute("DELETE FROM mcp_server_bindings", [])
            .expect("the binding is deleted");

        assert_eq!(count_rows(&connection, "mcp_tool_overrides"), 0);
        assert_eq!(count_rows(&connection, "mcp_project_server_switches"), 0);
    }
}
