use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use rusqlite::{Connection, params};
use secrecy::{ExposeSecret, SecretString};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::project::ProjectId;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_std::keyed_lock::HeldWorkEnd;
use sidekicks_store::credential_store::{KeychainRefusal, SecretKeychain};
use sidekicks_store::database::writer::test_file::TestDatabase;

use super::{StepSecretRefusal, find_step_secrets, resolve_step_secrets};
use crate::schema::schema_parts;
use crate::secrets::store::WorkflowSecretStore;

const SHARED_ID: &str = "0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c0001";
const FIRST_PROJECT_ID: &str = "0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c0002";
const REMOVING_ID: &str = "0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c0003";
const UNSEALED_ID: &str = "0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c0004";

const FIRST_PROJECT: &str = "0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c1001";
const SECOND_PROJECT: &str = "0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c1002";

const SHARED_VALUE: &str = "shared-hunter2-do-not-print";
const FIRST_PROJECT_VALUE: &str = "project-hunter2-do-not-print";
const REMOVING_VALUE: &str = "removing-hunter2-do-not-print";

/// A keychain holding fixed values by account, recording each account read, or refusing every
/// read.
struct ScriptedKeychain {
    values: HashMap<String, String>,
    is_refusing: bool,
    reads: Mutex<Vec<String>>,
}

impl ScriptedKeychain {
    /// The keychain holding the shared, first project and removing records' values; the unsealed
    /// record's keychain entry is missing.
    fn holding(is_refusing: bool) -> Arc<Self> {
        Arc::new(Self {
            values: HashMap::from([
                (SHARED_ID.to_owned(), SHARED_VALUE.to_owned()),
                (FIRST_PROJECT_ID.to_owned(), FIRST_PROJECT_VALUE.to_owned()),
                (REMOVING_ID.to_owned(), REMOVING_VALUE.to_owned()),
            ]),
            is_refusing,
            reads: Mutex::new(Vec::new()),
        })
    }

    fn reads(&self) -> Vec<String> {
        self.reads
            .lock()
            .expect("no test thread panics holding it")
            .clone()
    }
}

impl SecretKeychain for ScriptedKeychain {
    fn write<'call>(
        &'call self,
        _account: &'call str,
        _value: &'call SecretString,
    ) -> BoxFuture<'call, Result<(), KeychainRefusal>> {
        Box::pin(async { Err(KeychainRefusal::from(HeldWorkEnd::Unanswered)) })
    }

    fn read<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<Option<SecretString>, KeychainRefusal>> {
        self.reads
            .lock()
            .expect("no test thread panics holding it")
            .push(account.to_owned());
        let answer = if self.is_refusing {
            Err(KeychainRefusal::from(HeldWorkEnd::Unanswered))
        } else {
            Ok(self.values.get(account).cloned().map(SecretString::from))
        };
        Box::pin(async move { answer })
    }

    fn remove<'call>(
        &'call self,
        _account: &'call str,
    ) -> BoxFuture<'call, Result<bool, KeychainRefusal>> {
        Box::pin(async { Err(KeychainRefusal::from(HeldWorkEnd::Unanswered)) })
    }

    fn accounts(&self) -> BoxFuture<'_, Result<Vec<String>, KeychainRefusal>> {
        Box::pin(async { Err(KeychainRefusal::from(HeldWorkEnd::Unanswered)) })
    }
}

/// A connection on a test database holding: a shared `deploy-key`, the first project's
/// `deploy-key`, a shared `old-key` whose delete has begun, and a shared `unsealed` whose
/// keychain holds no value.
fn database_with_secrets(database: &TestDatabase) -> Connection {
    let connection = database.opener()().expect("the test creates its database");
    for (id, scope, scope_ref, name, removal_requested_at) in [
        (SHARED_ID, "shared", "", "deploy-key", None),
        (
            FIRST_PROJECT_ID,
            "project",
            FIRST_PROJECT,
            "deploy-key",
            None,
        ),
        (
            REMOVING_ID,
            "shared",
            "",
            "old-key",
            Some("2026-10-20T00:00:00.000Z"),
        ),
        (UNSEALED_ID, "shared", "", "unsealed", None),
    ] {
        connection
            .execute(
                "INSERT INTO workflow_secrets
                   (id, scope, scope_ref, name, created_at, updated_at, removal_requested_at)
                 VALUES (?1, ?2, ?3, ?4, '2026-10-01T00:00:00.000Z',
                         '2026-10-01T00:00:00.000Z', ?5)",
                params![id, scope, scope_ref, name, removal_requested_at],
            )
            .expect("the test writes a secret's record");
    }
    connection
}

fn project(id: &str) -> ProjectId {
    ProjectId::new(id).expect("the test's project id")
}

/// One sensitive parameter `token` holding `value`, resolved in a run working in `project`.
async fn resolve_one(
    connection: &Connection,
    store: &WorkflowSecretStore,
    project: Option<&ProjectId>,
    value: &str,
) -> Result<String, StepSecretRefusal> {
    let found = find_step_secrets(connection, project, [("token", value, true)])?;
    let mut resolved = resolve_step_secrets(store, found).await?;
    let only = resolved
        .pop()
        .expect("the one sensitive reference resolves");
    assert_eq!(only.parameter, "token");
    assert!(resolved.is_empty());
    Ok(only.value.expose_secret().to_owned())
}

fn assert_not_found(result: Result<String, StepSecretRefusal>, reference: &str) {
    match result {
        Err(StepSecretRefusal::NotFound { reference: refused }) => {
            assert_eq!(refused.to_string(), reference);
        }
        other => panic!("expected {reference} not found, got {other:?}"),
    }
}

/// A reference in a parameter its kind does not mark sensitive resolves to nothing and the
/// keychain is never asked, while a sensitive one holding plain text stays a plain value.
/// Mutation: drop the sensitive filter, so the unmarked parameter resolves the shared record.
#[tokio::test]
async fn an_unmarked_parameters_reference_never_resolves() {
    let database = TestDatabase::new(schema_parts());
    let connection = database_with_secrets(&database);
    let keychain = ScriptedKeychain::holding(false);
    let store = WorkflowSecretStore::new(Arc::clone(&keychain) as Arc<dyn SecretKeychain>);

    let found = find_step_secrets(
        &connection,
        Some(&project(FIRST_PROJECT)),
        [
            ("url", "secret://shared/deploy-key", false),
            ("note", "plain text", true),
        ],
    )
    .expect("the read succeeds");
    let resolved = resolve_step_secrets(&store, found)
        .await
        .expect("nothing is resolved");

    assert!(resolved.is_empty(), "{resolved:?}");
    assert!(keychain.reads().is_empty(), "{:?}", keychain.reads());
}

/// A `project` reference resolves only in the project the run works in: in a run with no
/// project it is not found, in the first project it is that project's value, and in another
/// project it is not found though the name is held elsewhere, while a `shared` reference of the
/// same name reads the shared value. Mutations: a project reference read under the shared place
/// when the run has none; drop the `scope_ref` compare, so the second project reads the first's.
#[tokio::test]
async fn a_reference_resolves_only_in_its_own_place() {
    let database = TestDatabase::new(schema_parts());
    let connection = database_with_secrets(&database);
    let store = WorkflowSecretStore::new(ScriptedKeychain::holding(false));
    let first_project = project(FIRST_PROJECT);

    assert_not_found(
        resolve_one(&connection, &store, None, "secret://project/deploy-key").await,
        "secret://project/deploy-key",
    );
    assert_eq!(
        resolve_one(
            &connection,
            &store,
            Some(&first_project),
            "secret://project/deploy-key"
        )
        .await
        .expect("the first project's secret resolves"),
        FIRST_PROJECT_VALUE
    );
    assert_not_found(
        resolve_one(
            &connection,
            &store,
            Some(&project(SECOND_PROJECT)),
            "secret://project/deploy-key",
        )
        .await,
        "secret://project/deploy-key",
    );
    assert_eq!(
        resolve_one(
            &connection,
            &store,
            Some(&first_project),
            "secret://shared/deploy-key"
        )
        .await
        .expect("the shared secret resolves"),
        SHARED_VALUE
    );
}

/// A record whose delete has begun is not found though the keychain still holds its value, and
/// so is a live record whose keychain holds none. Mutations: drop the `removal_requested_at`
/// filter; read a missing value as an empty one.
#[tokio::test]
async fn a_record_being_removed_or_unsealed_is_not_found() {
    let database = TestDatabase::new(schema_parts());
    let connection = database_with_secrets(&database);
    let store = WorkflowSecretStore::new(ScriptedKeychain::holding(false));

    assert_not_found(
        resolve_one(&connection, &store, None, "secret://shared/old-key").await,
        "secret://shared/old-key",
    );
    assert_not_found(
        resolve_one(&connection, &store, None, "secret://shared/unsealed").await,
        "secret://shared/unsealed",
    );
}

/// A keychain that refuses fails the step as `workflow.secret.storeUnavailable`, and neither the
/// refusal nor the answer it becomes names the value. Mutations: a refusing keychain read as no
/// value; the value written into the refusal.
#[tokio::test]
async fn a_refusing_keychain_is_store_unavailable_without_naming_the_value() {
    let database = TestDatabase::new(schema_parts());
    let connection = database_with_secrets(&database);
    let store = WorkflowSecretStore::new(ScriptedKeychain::holding(true));

    let refusal = resolve_one(&connection, &store, None, "secret://shared/deploy-key")
        .await
        .expect_err("a refusing keychain resolves nothing");
    assert!(
        matches!(refusal, StepSecretRefusal::StoreUnavailable(_)),
        "{refusal:?}"
    );
    let mut written = vec![refusal.to_string(), format!("{refusal:?}")];
    let HandlerError::Refused(refused) = HandlerError::from(refusal) else {
        panic!("a keychain that cannot be used is a refusal, not a fault");
    };
    assert_eq!(refused.code, RefusalCode::WorkflowSecretStoreUnavailable);
    written.extend([refused.to_string(), format!("{refused:?}")]);
    for text in written {
        assert!(!text.contains("hunter2"), "{text}");
    }
}
