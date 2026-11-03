//! The resolution of a step's secrets at its launch. Only a parameter its kind marks sensitive is
//! read for a reference, and only when its whole value is one `secret://<scope>/<name>` reference;
//! the save already refused a reference anywhere else. A `shared` reference resolves on every run,
//! a `project` one only in the project the run works in.
//!
//! Resolution is two steps, so no database connection is held across a keychain call: the records
//! are found on a read connection, then their values are read from the keychain. The result names
//! parameters, never a command line or an environment: the launcher decides how a value rides.

use std::convert::Infallible;
use std::error::Error;

use rusqlite::{Connection, OptionalExtension as _, named_params};
use secrecy::SecretString;
use serde_json::Value;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::wire::record::JsonRecord;
use sidekicks_contracts::workflow::definition::item::WorkflowStepError;
use sidekicks_contracts::workflow::kind::{WorkflowNodeKindSpec, WorkflowParamSpec};
use sidekicks_contracts::workflow::secret::{
    WorkflowSecretId, WorkflowSecretNotFoundDetails, WorkflowSecretReference,
    WorkflowSecretReferenceNotFound, WorkflowSecretScope, WorkflowSecretStoreUnavailableDetails,
};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::credential_store::KeychainRefusal;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};

use crate::expressions::param_strings::{ParamPathSegment, walk_param_strings};
use crate::kinds::{coded_step_error, uncoded_step_error};
use crate::secrets::store::WorkflowSecretStore;

/// The statements [`find_step_secrets`] runs on a read connection: the live record of one
/// reference.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the read pool the daemon opens for the engine's steps"
    )
)]
pub(crate) const STEP_SECRET_STATEMENT_CAPACITY: usize = 1;

// A record being deleted no longer resolves, so a value its delete is removing is never handed out.
const LIVE_SECRET_RECORD_SQL: &str = "SELECT id FROM workflow_secrets
  WHERE scope = @scope AND scope_ref = @scope_ref AND name = @name
    AND removal_requested_at IS NULL";

/// A sensitive parameter's reference and the record that holds it, which
/// [`resolve_step_secrets`] reads the value of.
#[derive(Debug)]
struct FoundStepSecret {
    /// The parameter's name.
    parameter: String,
    /// The reference the parameter stores.
    reference: WorkflowSecretReference,
    /// The record the reference names.
    secret_id: WorkflowSecretId,
}

/// A sensitive parameter's secret value, for the launcher to hand the step.
#[derive(Debug)]
pub(crate) struct ResolvedStepSecret {
    /// The parameter's name.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the kinds' executors, which hand each secret to the param it resolved"
        )
    )]
    pub(crate) parameter: String,
    /// The secret's value.
    #[cfg_attr(not(test), expect(dead_code, reason = "the tick's step launch"))]
    pub(crate) value: SecretString,
}

/// Why a step's secrets did not resolve; the step fails without starting. Each refusal answers
/// its own code, and none names a secret's value.
#[derive(Debug, thiserror::Error)]
pub enum StepSecretRefusal {
    /// No live record holds the reference, the run works in no project for a `project` one, or the
    /// keychain holds no value for its record (`workflow.secret.notFound`).
    #[error("No secret is stored for {reference}.")]
    NotFound {
        /// The reference that did not resolve.
        reference: WorkflowSecretReference,
    },
    /// The keychain is locked or unavailable (`workflow.secret.storeUnavailable`).
    #[error(transparent)]
    StoreUnavailable(KeychainRefusal),
    /// SQLite refused the read of a secret's record.
    #[error("a read of a workflow secret's record failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

impl StepSecretRefusal {
    /// Whether a failure lies under the refusal: the keychain's, or a failed read's; a reference
    /// that did not resolve has none.
    #[cfg_attr(not(test), expect(dead_code, reason = "the tick's step launch"))]
    pub(crate) fn has_failure_underneath(&self) -> bool {
        !matches!(self, Self::NotFound { .. })
    }
}

/// The code a refusal answers, its details and the keychain's failure underneath, where there is
/// one.
struct CodedSecretRefusal {
    /// The refusal's code.
    code: RefusalCode,
    /// The code's details.
    details: Value,
    /// The keychain's failure underneath.
    failure: Option<Box<dyn Error + Send + Sync>>,
}

/// The code and details of a reference that did not resolve and of a keychain that could not be
/// used; a failed read, which answers no code, comes back as it is.
fn coded_refusal(refusal: StepSecretRefusal) -> Result<CodedSecretRefusal, StepSecretRefusal> {
    let (code, details, failure) = match refusal {
        StepSecretRefusal::NotFound { reference } => (
            RefusalCode::WorkflowSecretNotFound,
            serde_json::to_value(WorkflowSecretNotFoundDetails::Reference(
                WorkflowSecretReferenceNotFound {
                    reference,
                    secret_id: None,
                },
            )),
            None,
        ),
        StepSecretRefusal::StoreUnavailable(keychain_refusal) => {
            let (cause, failure) = keychain_refusal.into_cause_and_failure();
            (
                RefusalCode::WorkflowSecretStoreUnavailable,
                serde_json::to_value(WorkflowSecretStoreUnavailableDetails { cause }),
                failure,
            )
        }
        fault @ (StepSecretRefusal::Database(_) | StepSecretRefusal::Pool(_)) => {
            return Err(fault);
        }
    };
    Ok(CodedSecretRefusal {
        code,
        details: details.expect("a secret refusal's details are plain JSON"),
        failure,
    })
}

impl From<StepSecretRefusal> for HandlerError {
    /// A reference that did not resolve and a keychain that could not be used answer their own
    /// codes; a failed read is a fault in the daemon.
    fn from(refusal: StepSecretRefusal) -> Self {
        let message = refusal.to_string();
        match coded_refusal(refusal) {
            Ok(CodedSecretRefusal {
                code,
                details,
                failure,
            }) => Self::Refused(
                DomainError::new(message, code)
                    .with_detail(details)
                    .with_optional_source(failure),
            ),
            Err(fault) => Self::Internal(Box::new(fault)),
        }
    }
}

impl From<StepSecretRefusal> for WorkflowStepError {
    /// A reference that did not resolve and a keychain that could not be used fail the step with
    /// their own codes, and a failed read fails it with no code; the step's driver sets the node
    /// and, before this, records the failure underneath with its causes in the engine's record.
    fn from(refusal: StepSecretRefusal) -> Self {
        let message = refusal.to_string();
        match coded_refusal(refusal) {
            Ok(CodedSecretRefusal { code, details, .. }) => {
                coded_step_error(code, message, details, None)
            }
            Err(fault) => uncoded_step_error(fault.to_string()),
        }
    }
}

/// Resolves the secrets of a node of kind `spec` whose params are `params`, in a run working in
/// `project` or in none: each string a param holds whole, nested ones included, that sits on a leaf
/// `spec` marks sensitive is looked up, under its path's text. Reads nothing when no string is
/// sensitive. Fails as [`find_step_secrets`] and [`resolve_step_secrets`] do.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the tick's dispatch, which resolves a step's secrets when it launches"
    )
)]
pub(crate) async fn resolve_node_secrets(
    pool: &DatabaseReadPool,
    store: &WorkflowSecretStore,
    project: Option<&ProjectId>,
    spec: &WorkflowNodeKindSpec,
    params: &JsonRecord,
) -> Result<Vec<ResolvedStepSecret>, StepSecretRefusal> {
    let mut sensitive = Vec::new();
    let Ok(()) = walk_param_strings(params, |path, text| {
        if is_sensitive_leaf(&spec.params, &path.param, &path.segments) {
            sensitive.push((path.to_string(), text.to_owned()));
        }
        Ok::<(), Infallible>(())
    });
    if sensitive.is_empty() {
        return Ok(Vec::new());
    }
    let project = project.copied();
    let found = pool
        .read(ReadLength::Short, move |connection| {
            find_step_secrets(
                connection,
                project.as_ref(),
                sensitive
                    .iter()
                    .map(|(parameter, value)| (parameter.as_str(), value.as_str())),
            )
        })
        .await?;
    resolve_step_secrets(store, found).await
}

/// Whether the string at `segments` below the param `param` sits on a leaf of `specs` marked
/// sensitive: a member enters a collection's field of its name, an entry only a repeating
/// collection's list, and the walk must end on the leaf itself.
fn is_sensitive_leaf(
    specs: &[WorkflowParamSpec],
    param: &str,
    segments: &[ParamPathSegment],
) -> bool {
    let Some(mut spec) = find_param(specs, param) else {
        return false;
    };
    let mut segments = segments.iter();
    loop {
        match spec {
            WorkflowParamSpec::Leaf(leaf) => {
                return segments.next().is_none() && leaf.sensitive == Some(true);
            }
            WorkflowParamSpec::Collection(collection) => {
                if collection.multiple == Some(true)
                    && !matches!(segments.next(), Some(ParamPathSegment::Index(_)))
                {
                    return false;
                }
                let Some(ParamPathSegment::Key(field)) = segments.next() else {
                    return false;
                };
                let Some(field_spec) = find_param(&collection.fields, field) else {
                    return false;
                };
                spec = field_spec;
            }
        }
    }
}

/// The param of `specs` whose id is `id`.
fn find_param<'spec>(
    specs: &'spec [WorkflowParamSpec],
    id: &str,
) -> Option<&'spec WorkflowParamSpec> {
    specs.iter().find(|spec| {
        let spec_id = match spec {
            WorkflowParamSpec::Leaf(leaf) => &leaf.id,
            WorkflowParamSpec::Collection(collection) => &collection.id,
        };
        spec_id.0.as_str() == id
    })
}

/// Finds the record of each sensitive parameter's reference, given each parameter as its name and
/// its value's text, in a run working in `project` or in none. A parameter holding a plain value
/// is left out. Fails with [`StepSecretRefusal::NotFound`] for the first reference no live record
/// holds, or with [`StepSecretRefusal::Database`] when the read does.
fn find_step_secrets<'parameter>(
    connection: &Connection,
    project: Option<&ProjectId>,
    parameters: impl IntoIterator<Item = (&'parameter str, &'parameter str)>,
) -> Result<Vec<FoundStepSecret>, StepSecretRefusal> {
    let project_text = project.map(ProjectId::text);
    let mut found = Vec::new();
    for (parameter, value) in parameters {
        let Ok(reference) = value.parse::<WorkflowSecretReference>() else {
            continue;
        };
        let scope_ref = match (reference.scope, &project_text) {
            (WorkflowSecretScope::Shared, _) => "",
            (WorkflowSecretScope::Project, Some(project_text)) => project_text.as_str(),
            (WorkflowSecretScope::Project, None) => {
                return Err(StepSecretRefusal::NotFound { reference });
            }
        };
        let secret_id = connection
            .prepare_cached(LIVE_SECRET_RECORD_SQL)?
            .query_row(
                named_params! {
                    "@scope": <&'static str>::from(reference.scope),
                    "@scope_ref": scope_ref,
                    "@name": reference.name.as_str(),
                },
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(secret_id) = secret_id else {
            return Err(StepSecretRefusal::NotFound { reference });
        };
        let secret_id =
            WorkflowSecretId::new(&secret_id).expect("a secret's id is the UUID the daemon minted");
        found.push(FoundStepSecret {
            parameter: parameter.to_owned(),
            reference,
            secret_id,
        });
    }
    Ok(found)
}

/// Reads each found secret's value from `store`, in the order found. Fails with
/// [`StepSecretRefusal::NotFound`] for the first record whose keychain holds no value, or with
/// [`StepSecretRefusal::StoreUnavailable`] when the keychain cannot be used.
async fn resolve_step_secrets(
    store: &WorkflowSecretStore,
    found: Vec<FoundStepSecret>,
) -> Result<Vec<ResolvedStepSecret>, StepSecretRefusal> {
    let mut resolved = Vec::with_capacity(found.len());
    for FoundStepSecret {
        parameter,
        reference,
        secret_id,
    } in found
    {
        let value = store
            .resolve(secret_id)
            .await
            .map_err(StepSecretRefusal::StoreUnavailable)?
            .ok_or(StepSecretRefusal::NotFound { reference })?;
        resolved.push(ResolvedStepSecret { parameter, value });
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
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
            let params: JsonRecord =
                serde_json::from_value(params).expect("the test's params read");
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
}
