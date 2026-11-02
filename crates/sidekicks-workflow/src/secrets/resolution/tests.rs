use std::sync::Arc;

use rstest::rstest;
use rusqlite::{Connection, params};
use secrecy::ExposeSecret;
use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::wire::record::JsonRecord;
use sidekicks_contracts::workflow::definition::item::WorkflowStepError;
use sidekicks_contracts::workflow::kind::WorkflowNodeKindSpec;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_std::keyed_lock::HeldWorkEnd;
use sidekicks_store::credential_store::{KeychainRefusal, SecretKeychain};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;

use super::{
    STEP_SECRET_STATEMENT_CAPACITY, StepSecretRefusal, find_step_secrets, resolve_node_secrets,
    resolve_step_secrets,
};
use crate::schema::schema_parts;
use crate::secrets::store::{ScriptedKeychain, WorkflowSecretStore};

const SHARED_ID: &str = "0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c0001";
const FIRST_PROJECT_ID: &str = "0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c0002";
const REMOVING_ID: &str = "0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c0003";
const UNSEALED_ID: &str = "0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c0004";

const FIRST_PROJECT: &str = "0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c1001";
const SECOND_PROJECT: &str = "0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c1002";

const SHARED_VALUE: &str = "shared-hunter2-do-not-print";
const FIRST_PROJECT_VALUE: &str = "project-hunter2-do-not-print";
const REMOVING_VALUE: &str = "removing-hunter2-do-not-print";

/// The keychain holding the shared, first project and removing records' values, or refusing every
/// read; the unsealed record's keychain entry is missing.
fn scripted_keychain(is_refusing: bool) -> Arc<ScriptedKeychain> {
    ScriptedKeychain::holding(
        &[
            (SHARED_ID, SHARED_VALUE),
            (FIRST_PROJECT_ID, FIRST_PROJECT_VALUE),
            (REMOVING_ID, REMOVING_VALUE),
        ],
        is_refusing,
    )
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
    let found = find_step_secrets(connection, project, [("token", value)])?;
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

/// A kind holding a repeating collection `headers`, whose field `value` is sensitive and whose
/// field `name` is not, beside a plain leaf `url`.
fn headers_kind() -> WorkflowNodeKindSpec {
    serde_json::from_value(json!({
        "kind": "test.request", "version": 1, "category": "developer",
        "displayName": "Request", "description": "A request with headers.",
        "icon": "globe", "inputs": [], "outputs": [], "outputsDeriveFromParams": false,
        "params": [
            {
                "id": "headers", "label": "Headers", "type": "collection", "multiple": true,
                "fields": [
                    { "id": "name", "label": "Name", "type": "string" },
                    { "id": "value", "label": "Value", "type": "string", "sensitive": true },
                ],
            },
            { "id": "url", "label": "URL", "type": "string" },
        ],
    }))
    .expect("the test kind's spec reads")
}

/// A reference in a nested sensitive leaf resolves under its path, while the same reference in a
/// plain leaf and in the collection's plain field resolves to nothing and a sensitive leaf holding
/// plain text stays a plain value; a node with no sensitive string resolves to nothing and asks the
/// keychain nothing. Mutations: walk only the top level, so the nested secret never resolves;
/// resolve a reference whose leaf is not sensitive; refuse a sensitive leaf's plain text.
#[tokio::test]
async fn a_nested_sensitive_leaf_resolves_under_its_path() {
    let database = TestDatabase::new(schema_parts());
    database_with_secrets(&database);
    let pool = DatabaseReadPool::new(database.path(), STEP_SECRET_STATEMENT_CAPACITY);
    let kind = headers_kind();
    let resolve = async |params: serde_json::Value, keychain: Arc<ScriptedKeychain>| {
        let params: JsonRecord = serde_json::from_value(params).expect("the test's params read");
        let store = WorkflowSecretStore::new(keychain as Arc<dyn SecretKeychain>);
        resolve_node_secrets(&pool, &store, None, &kind, &params)
            .await
            .expect("the node's secrets resolve")
    };

    let keychain = scripted_keychain(false);
    let resolved = resolve(
        json!({
            "headers": [
                {
                    "name": "secret://shared/deploy-key",
                    "value": "secret://shared/deploy-key",
                },
                { "name": "note", "value": "plain text" },
            ],
            "url": "secret://shared/deploy-key",
        }),
        Arc::clone(&keychain),
    )
    .await;
    let [only] = resolved.as_slice() else {
        panic!("only the sensitive leaf resolves: {resolved:?}");
    };
    assert_eq!(only.parameter, "headers[0].value");
    assert_eq!(only.value.expose_secret(), SHARED_VALUE);
    assert_eq!(keychain.reads(), vec![SHARED_ID.to_owned()]);

    let keychain = scripted_keychain(false);
    let resolved = resolve(
        json!({ "headers": [{ "name": "secret://shared/deploy-key" }], "url": "plain" }),
        Arc::clone(&keychain),
    )
    .await;
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
    let store = WorkflowSecretStore::new(scripted_keychain(false));
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
    let store = WorkflowSecretStore::new(scripted_keychain(false));

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
    let store = WorkflowSecretStore::new(scripted_keychain(true));

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

/// Each refusal fails the step with its own code and details: a reference no record holds as
/// `workflow.secret.notFound` naming it, a keychain that cannot be used as
/// `workflow.secret.storeUnavailable` with its own cause, and a failed read with no code.
/// Mutations: swap the two codes; drop the details; give a failed read a code.
#[rstest]
#[case::not_found(
    StepSecretRefusal::NotFound {
        reference: "secret://shared/missing".parse().expect("the test's reference reads"),
    },
    json!({
        "message": "No secret is stored for secret://shared/missing.",
        "code": "workflow.secret.notFound",
        "details": { "reference": "secret://shared/missing" },
    }),
)]
#[case::store_unavailable(
    StepSecretRefusal::StoreUnavailable(KeychainRefusal::from(HeldWorkEnd::Unanswered)),
    {
        let refusal = KeychainRefusal::from(HeldWorkEnd::Unanswered);
        json!({
            "message": refusal.to_string(),
            "code": "workflow.secret.storeUnavailable",
            "details": { "cause": refusal.cause() },
        })
    },
)]
#[case::database(
    StepSecretRefusal::Database(rusqlite::Error::QueryReturnedNoRows),
    json!({ "message": "a read of a workflow secret's record failed" }),
)]
fn each_secret_refusal_fails_the_step_with_its_own_code(
    #[case] refusal: StepSecretRefusal,
    #[case] expected: serde_json::Value,
) {
    let error = WorkflowStepError::from(refusal);

    assert_eq!(
        serde_json::to_value(error).expect("a step failure writes"),
        expected
    );
}
