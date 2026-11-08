use std::sync::Arc;

use rstest::rstest;
use rusqlite::Connection;
use serde_json::{Value, json};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::builder::{
    NewWorkflowDraftUpdateRequest, SavedWorkflowDraftUpdateRequest, WorkflowDraftUpdateRequest,
    WorkflowProviderUpdateRequest,
};
use sidekicks_contracts::workflow::definition::document::{
    WORKFLOW_NAME_MAX_LEN, WorkflowDefinitionId, WorkflowDocument, WorkflowNodeId,
    WorkflowVersionId,
};
use sidekicks_contracts::workflow::definition::methods::{
    WorkflowCreateOrigin, WorkflowDefinitionCreateRequest, WorkflowDefinitionCreateResponse,
    WorkflowDefinitionReadRequest, WorkflowDefinitionReadResponse,
    WorkflowDefinitionReadWithoutWebhookToken, WorkflowDefinitionUpdateRequest,
};
use sidekicks_contracts::workflow::definition::refusals::WorkflowDefinitionFinding;
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

use super::{
    WORKFLOW_DEFINITION_STORE_STATEMENT_CAPACITY, WorkflowDefinitionStore,
    WorkflowDefinitionStoreError, WorkflowSaveAuthor,
};
use crate::definitions::drafts::{WORKFLOW_DRAFT_STORE_STATEMENT_CAPACITY, WorkflowDraftStore};
use crate::definitions::errors::DefinitionRefusal;
use crate::definitions::library::{WORKFLOW_LIBRARY_STATEMENT_CAPACITY, WorkflowLibrary};
use crate::engine::ports::StepPayloadArtifacts;
use crate::engine::ports::kept_payloads::KeptPayloads;
use crate::kinds::{NodeKind, NodeKindTable, PassThroughExecutor, command_test_kind, test_kind};
use crate::not_found::{WorkflowNotFound, WorkflowVersionAddress};
use crate::schema::schema_parts;

/// A document of `name` whose trigger feeds its one node, which the graph check passes.
fn document(name: &str, path: &str) -> Value {
    json!({
        "schemaVersion": "2",
        "name": name,
        "trigger": {
            "id": "trigger", "kind": "trigger.manual", "kindVersion": 1, "name": "Start",
            "order": 0, "params": {},
        },
        "nodes": [{
            "id": "read", "kind": "files.read", "kindVersion": 1, "name": "Read notes",
            "order": 0, "params": { "path": path },
        }],
        "edges": [{
            "id": "trigger-to-read", "source": "trigger", "sourceHandle": "outputs/main/0",
            "target": "read", "targetHandle": "inputs/main/0",
        }],
    })
}

fn saved_document(name: &str, path: &str) -> WorkflowDocument {
    serde_json::from_value(document(name, path)).expect("the test's document reads")
}

/// A shell-line bound far past every command line here.
pub(super) const SHELL_LINE_LIMIT: usize = 4_096;

/// The store and the draft store over one test database holding the workflow tables, the store
/// reading command lines inside a bound of `shell_line_limit` bytes, knowing two kinds, the
/// command step `developer.shell`, whose line is its `command` param, and [`call_kind`], and
/// deleting kept artifacts through the payload store answered beside them.
pub(super) async fn open_stores(
    database: &TestDatabase,
    shell_line_limit: usize,
) -> (
    WorkflowDefinitionStore,
    WorkflowDraftStore,
    Arc<KeptPayloads>,
) {
    let payloads = Arc::new(KeptPayloads::default());
    let writer = Arc::new(
        DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens the test database"),
    );
    let pool = Arc::new(DatabaseReadPool::new(
        database.path(),
        WORKFLOW_LIBRARY_STATEMENT_CAPACITY
            + WORKFLOW_DEFINITION_STORE_STATEMENT_CAPACITY
            + WORKFLOW_DRAFT_STORE_STATEMENT_CAPACITY,
    ));
    (
        WorkflowDefinitionStore::new(
            Arc::clone(&pool),
            Arc::clone(&writer),
            Arc::new(
                NodeKindTable::new(vec![command_test_kind(), call_kind()])
                    .expect("the test's kinds table builds"),
            ),
            Arc::new(ShellLineReadingBound::new(shell_line_limit)),
            Arc::clone(&payloads) as Arc<dyn StepPayloadArtifacts>,
        ),
        WorkflowDraftStore::new(pool, writer),
        payloads,
    )
}

/// The step `http.call` at version 1, whose `token` param the kind marks sensitive and whose
/// `url` param it does not, and whose `tool` and `tool.backup` params are tool bindings, the
/// second's id holding a dot.
fn call_kind() -> NodeKind {
    test_kind(
        json!({
            "kind": "http.call", "version": 1, "category": "developer",
            "displayName": "Call a service", "description": "A request to a service.",
            "icon": "globe",
            "params": [
                { "id": "token", "label": "Token", "type": "string", "sensitive": true },
                { "id": "url", "label": "Address", "type": "string" },
                { "id": "tool", "label": "Tool", "type": "mcpTool" },
                { "id": "tool.backup", "label": "Backup tool", "type": "mcpTool" },
            ],
            "inputs": [{ "type": "main", "id": "inputs/main/0", "label": "In" }],
            "outputs": [{ "type": "main", "id": "outputs/main/0", "label": "Out" }],
            "outputsDeriveFromParams": false,
        }),
        None,
        Box::new(PassThroughExecutor),
    )
}

fn author() -> WorkflowSaveAuthor {
    WorkflowSaveAuthor {
        device_id: DeviceId::new("device".to_owned()).expect("the id is well formed"),
        agent_id: None,
    }
}

// A create of a document named `name` whose node reads `path`, from `origin`.
async fn create_from(
    store: &WorkflowDefinitionStore,
    name: &str,
    path: &str,
    origin: WorkflowCreateOrigin,
) -> Result<WorkflowDefinitionCreateResponse, WorkflowDefinitionStoreError> {
    store
        .create(
            &WorkflowDefinitionCreateRequest {
                document: saved_document(name, path),
                origin,
            },
            &author(),
            None,
        )
        .await
}

async fn create(store: &WorkflowDefinitionStore, name: &str) -> WorkflowDefinitionId {
    create_from(store, name, "notes.md", WorkflowCreateOrigin::FileImport {})
        .await
        .expect("the create commits")
        .definition_id
}

fn duplicate_of(copied_version_id: WorkflowVersionId) -> WorkflowCreateOrigin {
    WorkflowCreateOrigin::Duplicate { copied_version_id }
}

async fn hold_draft(drafts: &WorkflowDraftStore, definition_id: WorkflowDefinitionId) {
    drafts
        .update(&WorkflowDraftUpdateRequest::Saved(
            SavedWorkflowDraftUpdateRequest {
                definition_id,
                based_on_version_number: SafeInt::new(1),
                document: serde_json::from_value(document("Unsaved", "draft.md"))
                    .expect("the test's draft reads"),
            },
        ))
        .await
        .expect("the draft is held");
}

fn version_count(rows: &Connection, definition_id: WorkflowDefinitionId) -> i64 {
    rows.query_row(
        "SELECT COUNT(*) FROM workflow_versions WHERE definition_id = ?1",
        [definition_id.text().as_str()],
        |row| row.get(0),
    )
    .expect("the test counts the versions")
}

fn update(definition_id: WorkflowDefinitionId, name: &str) -> WorkflowDefinitionUpdateRequest {
    WorkflowDefinitionUpdateRequest {
        definition_id,
        expected_version_number: SafeInt::new(1).expect("one is a version number"),
        document: saved_document(name, "changed.md"),
        restored_version_number: None,
    }
}

/// A save writes its version and clears its workflow's draft as one write; a save refused for a
/// name another workflow holds, in another letter case, writes no version, keeps the workflow's
/// name and leaves its draft held, whether the check before the write or the one inside it refuses
/// it. Mutations: drop the draft's clear from the save; fold no case in either name check; answer
/// the in-write name check's refusal as a stale version.
#[tokio::test]
async fn a_save_clears_its_draft_and_a_refused_name_leaves_nothing() {
    let database = TestDatabase::new(schema_parts());
    let (store, drafts, _payloads) = open_stores(&database, SHELL_LINE_LIMIT).await;
    let nightly = create(&store, "Nightly").await;
    let weekly = create(&store, "Weekly").await;
    hold_draft(&drafts, nightly).await;
    hold_draft(&drafts, weekly).await;

    let saved = store
        .update(&update(nightly, "Nightly"), &author())
        .await
        .expect("the save commits");
    assert_eq!(saved.version_number.get(), 2);
    let cleared = drafts.read(Some(nightly)).await.expect("the draft reads");
    assert_eq!(cleared.draft, None);

    let request = update(weekly, "NIGHTLY");
    let refusals = [
        store.update(&request, &author()).await,
        // The write alone, as when the name is taken after the check before it.
        store.write_update(&request, &author()).await,
    ];
    for refused in refusals {
        let refused = refused.expect_err("a name another workflow holds is refused");
        let WorkflowDefinitionStoreError::Refused(DefinitionRefusal::Refused { findings }) =
            refused
        else {
            panic!("the save is refused with findings, not {refused:?}");
        };
        assert_eq!(
            findings,
            vec![WorkflowDefinitionFinding::NameTaken {
                node_ids: Vec::new()
            }]
        );
    }
    let rows = database.reader();
    assert_eq!(version_count(&rows, weekly), 1);
    assert_eq!(definition_name(&rows, weekly), "Weekly");
    let held = drafts.read(Some(weekly)).await.expect("the draft reads");
    assert!(held.draft.is_some(), "a refused save leaves its draft held");
}

/// A create from the builder's new-workflow draft clears that draft in its own write; a file
/// import leaves it held, since the builder was not saving it. Mutations: drop the draft's clear
/// from the create; clear it for every origin.
#[tokio::test]
async fn a_create_from_the_new_workflow_draft_clears_it_and_an_import_leaves_it() {
    let database = TestDatabase::new(schema_parts());
    let (store, drafts, _payloads) = open_stores(&database, SHELL_LINE_LIMIT).await;
    let hold_new_draft = || async {
        drafts
            .update(&WorkflowDraftUpdateRequest::New(
                NewWorkflowDraftUpdateRequest {
                    definition_id: None,
                    based_on_version_number: None,
                    document: serde_json::from_value(document("Unsaved", "draft.md"))
                        .expect("the test's draft reads"),
                },
            ))
            .await
            .expect("the draft is held");
    };

    hold_new_draft().await;
    create_from(
        &store,
        "Imported",
        "notes.md",
        WorkflowCreateOrigin::FileImport {},
    )
    .await
    .expect("the import commits");
    let held = drafts.read(None).await.expect("the draft reads");
    assert!(
        held.draft.is_some(),
        "an import leaves the new workflow's draft held"
    );

    create_from(
        &store,
        "Drafted",
        "draft.md",
        WorkflowCreateOrigin::NewWorkflowDraft {},
    )
    .await
    .expect("the create commits");
    let cleared = drafts.read(None).await.expect("the draft reads");
    assert_eq!(cleared.draft, None);
}

fn definition_name(rows: &Connection, definition_id: WorkflowDefinitionId) -> String {
    rows.query_row(
        "SELECT name FROM workflow_definitions WHERE id = ?1",
        [definition_id.text().as_str()],
        |row| row.get(0),
    )
    .expect("the test reads the workflow")
}

/// A Duplicate is named the first free `<name> copy`, then `<name> copy 2`, a name at its bound cut
/// so the copy's fits; its first version keeps the copied version's package locks while its
/// document is that version's, and none when it differs. One naming a version no row holds, or a
/// version of a deleted workflow, is refused as that version not found, not as a held name, and
/// writes no workflow. Mutations: carry the locks whatever the document; answer every refused
/// create as a held name; drop the copied version's check, or its deleted workflow condition, from
/// the write; leave a copy's name uncut.
#[tokio::test]
async fn a_duplicate_takes_a_free_copy_name_and_its_source_locks_only_for_the_same_content() {
    let database = TestDatabase::new(schema_parts());
    let (store, _drafts, _payloads) = open_stores(&database, SHELL_LINE_LIMIT).await;
    let source = create_from(
        &store,
        "Nightly",
        "notes.md",
        WorkflowCreateOrigin::FileImport {},
    )
    .await
    .expect("the create commits");
    let source_version = source.workflow_version_id;
    let locks = r#"{"read":{"lodash":"4.17.21"}}"#;
    let rows = database.reader();
    rows.execute(
        "UPDATE workflow_versions SET code_locks_json = ?1 WHERE id = ?2",
        [locks, source_version.text().as_str()],
    )
    .expect("the test locks the source's packages");
    for (expected_name, path, expected_locks) in [
        ("Nightly copy", "notes.md", locks),
        ("Nightly copy 2", "changed.md", "{}"),
    ] {
        let copy = create_from(&store, "Nightly", path, duplicate_of(source_version))
            .await
            .expect("the duplicate commits");
        assert_eq!(definition_name(&rows, copy.definition_id), expected_name);
        let copy_locks: String = rows
            .query_row(
                "SELECT code_locks_json FROM workflow_versions WHERE id = ?1",
                [copy.workflow_version_id.text().as_str()],
                |row| row.get(0),
            )
            .expect("the test reads the copy's locks");
        assert_eq!(copy_locks, expected_locks, "{expected_name}");
    }
    // A source at the name's bound is cut so its copy fits it, never refused or a fault.
    let longest = "n".repeat(WORKFLOW_NAME_MAX_LEN);
    let longest_source = create_from(
        &store,
        &longest,
        "notes.md",
        WorkflowCreateOrigin::FileImport {},
    )
    .await
    .expect("a name at the bound is saved");
    for suffix in [" copy", " copy 2"] {
        let copy = create_from(
            &store,
            &longest,
            "notes.md",
            duplicate_of(longest_source.workflow_version_id),
        )
        .await
        .expect("the duplicate of a name at the bound commits");
        assert_eq!(
            definition_name(&rows, copy.definition_id),
            format!(
                "{}{suffix}",
                &longest[..WORKFLOW_NAME_MAX_LEN - suffix.len()]
            )
        );
    }

    let missing = WorkflowVersionId::new("0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e59")
        .expect("the id is a version id");
    let refused_missing = create_from(&store, "Weekly", "notes.md", duplicate_of(missing)).await;
    rows.execute(
        "UPDATE workflow_definitions SET deleted_at = ?1 WHERE id = ?2",
        [
            "2026-10-14T09:30:00.000Z",
            source.definition_id.text().as_str(),
        ],
    )
    .expect("the test deletes the source");
    let refused_deleted =
        create_from(&store, "Nightly", "notes.md", duplicate_of(source_version)).await;
    for (refused, copied_version_id) in [
        (refused_missing, missing),
        (refused_deleted, source_version),
    ] {
        let refused = refused.expect_err("a copied version not in the library is refused");
        let WorkflowDefinitionStoreError::NotFound(WorkflowNotFound::Version(
            WorkflowVersionAddress::Id {
                workflow_version_id,
            },
        )) = refused
        else {
            panic!("the duplicate is refused as its version not found, not {refused:?}");
        };
        assert_eq!(workflow_version_id, copied_version_id);
    }
    let definition_count: i64 = rows
        .query_row("SELECT COUNT(*) FROM workflow_definitions", [], |row| {
            row.get(0)
        })
        .expect("the test counts the workflows");
    assert_eq!(definition_count, 6, "the two sources and their four copies");
}

/// Which of the three saves a test runs.
#[derive(Clone, Copy, Debug)]
enum SavePath {
    Create,
    Duplicate,
    Update,
}

/// A document of `name` whose trigger feeds one command step running `command`.
fn command_document(name: &str, command: &str) -> WorkflowDocument {
    let mut document = document(name, "notes.md");
    document["nodes"][0] = json!({
        "id": "run", "kind": "developer.shell", "kindVersion": 1, "name": "Run tests",
        "order": 0, "params": { "command": command },
    });
    document["edges"][0]["target"] = json!("run");
    serde_json::from_value(document).expect("the test's document reads")
}

/// A create, a Duplicate and an update each refuse a command step whose fill does not expand, with
/// the reason naming the fill, and one whose line is past the shell-line bound's limit, which no
/// reading reads; none writes a version. Mutations: check the fills on one save path only; read
/// the line with a reader of no bound's limit; refuse no fill.
#[rstest]
#[tokio::test]
async fn every_save_refuses_a_command_fill_that_does_not_expand(
    #[values(SavePath::Create, SavePath::Duplicate, SavePath::Update)] path: SavePath,
    #[values(
        (SHELL_LINE_LIMIT, "=echo '{{ $json.x }}'", "Fill 1 sits in single quotes"),
        (8, "=echo {{ $json.x }}", "Fill 1 is on a line a reading could not read whole"),
    )]
    line_case: (usize, &str, &str),
) {
    let (shell_line_limit, command, reason) = line_case;
    let database = TestDatabase::new(schema_parts());
    let (store, _drafts, _payloads) = open_stores(&database, shell_line_limit).await;
    let source = create_from(
        &store,
        "Nightly",
        "notes.md",
        WorkflowCreateOrigin::FileImport {},
    )
    .await
    .expect("the create commits");
    let document = command_document("Checks", command);
    let refused = match path {
        SavePath::Create => store
            .create(
                &WorkflowDefinitionCreateRequest {
                    document,
                    origin: WorkflowCreateOrigin::FileImport {},
                },
                &author(),
                None,
            )
            .await
            .map(|_| ()),
        SavePath::Duplicate => store
            .create(
                &WorkflowDefinitionCreateRequest {
                    document,
                    origin: duplicate_of(source.workflow_version_id),
                },
                &author(),
                None,
            )
            .await
            .map(|_| ()),
        SavePath::Update => store
            .update(
                &WorkflowDefinitionUpdateRequest {
                    definition_id: source.definition_id,
                    expected_version_number: SafeInt::new(1).expect("one is a version number"),
                    document,
                    restored_version_number: None,
                },
                &author(),
            )
            .await
            .map(|_| ()),
    };

    let Err(WorkflowDefinitionStoreError::Refused(DefinitionRefusal::Refused { findings })) =
        refused
    else {
        panic!("the {path:?} is refused with findings, not {refused:?}");
    };
    let [WorkflowDefinitionFinding::ExpressionNotExpanded { node_ids, detail }] =
        findings.as_slice()
    else {
        panic!("the {path:?} is refused for its fill alone, not {findings:?}");
    };
    assert_eq!(
        node_ids
            .iter()
            .map(WorkflowNodeId::as_str)
            .collect::<Vec<_>>(),
        ["run"]
    );
    assert!(detail.as_str().starts_with(reason), "{detail:?}");
    let versions: i64 = database
        .reader()
        .query_row("SELECT COUNT(*) FROM workflow_versions", [], |row| {
            row.get(0)
        })
        .expect("the test counts the versions");
    assert_eq!(versions, 1, "only the source's version is written");
}

/// A save refuses a secret named inside an expression, even in a param its kind marks sensitive,
/// and a plain secret reference in a param its kind does not mark, each once on its node however
/// many values break it, and writes no workflow. Mutations: drop the param check from the save;
/// raise one finding per refused value.
#[rstest]
#[case::an_expression_in_a_sensitive_param(
    json!({ "token": "=secret://shared/x", "url": "={{ 'secret://shared/y' }}" }),
    json!([{ "rule": "secretInExpression", "nodeIds": ["call"] }]),
)]
#[case::a_reference_in_a_plain_param(
    json!({ "token": "secret://shared/x", "url": "secret://shared/x" }),
    json!([{ "rule": "secretOutsideSensitiveField", "nodeIds": ["call"] }]),
)]
#[tokio::test]
async fn a_save_refuses_a_secret_its_params_cannot_resolve(
    #[case] params: Value,
    #[case] expected: Value,
) {
    let database = TestDatabase::new(schema_parts());
    let (store, _drafts, _payloads) = open_stores(&database, SHELL_LINE_LIMIT).await;
    let mut document = document("Calls", "notes.md");
    document["nodes"][0] = json!({
        "id": "call", "kind": "http.call", "kindVersion": 1, "name": "Call",
        "order": 0, "params": params,
    });
    document["edges"][0]["target"] = json!("call");

    let refused = store
        .create(
            &WorkflowDefinitionCreateRequest {
                document: serde_json::from_value(document).expect("the test's document reads"),
                origin: WorkflowCreateOrigin::FileImport {},
            },
            &author(),
            None,
        )
        .await;

    let Err(WorkflowDefinitionStoreError::Refused(DefinitionRefusal::Refused { findings })) =
        refused
    else {
        panic!("the save is refused with findings, not {refused:?}");
    };
    assert_eq!(
        serde_json::to_value(&findings).expect("the findings write as JSON"),
        expected
    );
    let definitions: i64 = database
        .reader()
        .query_row("SELECT COUNT(*) FROM workflow_definitions", [], |row| {
            row.get(0)
        })
        .expect("the test counts the workflows");
    assert_eq!(definitions, 0, "a refused save writes no workflow");
}

/// A save refuses a tool binding carrying a policy as the request's own read refuses an unknown
/// member, naming the field at its place in the request, a param id holding a dot as one step, and
/// writes no workflow; the binding without it saves. Mutations: let a binding no finding names pass
/// the save; split the check's path at each dot.
#[rstest]
#[case::carrying_a_policy("tool", Some("allow"))]
#[case::a_reference_only("tool", None)]
#[case::under_a_dotted_param_id("tool.backup", Some("allow"))]
#[tokio::test]
async fn a_save_refuses_a_tool_binding_carrying_a_policy(
    #[case] param_id: &str,
    #[case] approval_mode: Option<&str>,
) {
    let database = TestDatabase::new(schema_parts());
    let (store, _drafts, _payloads) = open_stores(&database, SHELL_LINE_LIMIT).await;
    let mut tool = json!({
        "binding": { "scope": "user", "provider": "codex", "serverName": "github" },
        "toolName": "search",
    });
    if let Some(approval_mode) = approval_mode {
        tool["approvalMode"] = json!(approval_mode);
    }
    let mut document = document("Calls", "notes.md");
    document["nodes"][0] = json!({
        "id": "call", "kind": "http.call", "kindVersion": 1, "name": "Call",
        "order": 0, "params": { param_id: tool },
    });
    document["edges"][0]["target"] = json!("call");

    let saved = store
        .create(
            &WorkflowDefinitionCreateRequest {
                document: serde_json::from_value(document).expect("the test's document reads"),
                origin: WorkflowCreateOrigin::FileImport {},
            },
            &author(),
            None,
        )
        .await;

    if approval_mode.is_none() {
        assert!(saved.is_ok(), "{saved:?}");
        return;
    }
    let Err(WorkflowDefinitionStoreError::Refused(DefinitionRefusal::Unreadable { issues })) =
        saved
    else {
        panic!("the save is refused as unreadable, not {saved:?}");
    };
    let [issue] = issues.as_slice() else {
        panic!("one field is named: {issues:?}");
    };
    assert_eq!(
        serde_json::to_value(&issue.path).expect("a path writes as JSON"),
        json!(["document", "nodes", 0, "params", param_id, "approvalMode"])
    );
    assert!(
        issue.message.starts_with("breaks the schema's"),
        "{issue:?}"
    );
    let definitions: i64 = database
        .reader()
        .query_row("SELECT COUNT(*) FROM workflow_definitions", [], |row| {
            row.get(0)
        })
        .expect("the test counts the workflows");
    assert_eq!(definitions, 0, "a refused save writes no workflow");
}

// The library's read of the latest version of a workflow that holds no webhook token.
fn read_definition(
    rows: &Connection,
    definition_id: WorkflowDefinitionId,
) -> WorkflowDefinitionReadWithoutWebhookToken {
    let read = WorkflowLibrary::new(rows)
        .read(&WorkflowDefinitionReadRequest {
            definition_id,
            version: None,
        })
        .expect("the workflow reads");
    let WorkflowDefinitionReadResponse::WithoutWebhookToken(read) = read else {
        panic!("the workflow holds no webhook token: {read:?}");
    };
    read
}

fn provider(id: &str) -> ProviderId {
    ProviderId::new(id.to_owned()).expect("the id is a provider id")
}

/// A create stores the provider pick its caller passes, and none for `None`; a change to the pick
/// reads back and mints no version, and a deleted workflow's pick is refused as not found.
/// Mutations: drop the pick from the create; write the change to another column; mint a version
/// on the change; let the change reach a deleted workflow; leave the column out of the read.
#[tokio::test]
async fn a_provider_pick_is_kept_beside_the_versions() {
    let database = TestDatabase::new(schema_parts());
    let (store, _drafts, _payloads) = open_stores(&database, SHELL_LINE_LIMIT).await;
    let rows = database.reader();
    let picked = store
        .create(
            &WorkflowDefinitionCreateRequest {
                document: saved_document("Nightly", "notes.md"),
                origin: WorkflowCreateOrigin::FileImport {},
            },
            &author(),
            Some(&provider("codex")),
        )
        .await
        .expect("the create commits")
        .definition_id;
    let created = read_definition(&rows, picked);
    assert_eq!(created.provider, Some(provider("codex")));

    let changed = store
        .update_provider(&WorkflowProviderUpdateRequest {
            definition_id: picked,
            provider: provider("claude-code"),
        })
        .await
        .expect("the change commits");
    assert_eq!(changed.provider, provider("claude-code"));
    let read = read_definition(&rows, picked);
    assert_eq!(read.provider, Some(provider("claude-code")));
    assert_eq!(read.content_hash, created.content_hash);
    assert_eq!(version_count(&rows, picked), 1);

    let blank = create(&store, "Weekly").await;
    assert_eq!(read_definition(&rows, blank).provider, None);

    rows.execute(
        "UPDATE workflow_definitions SET deleted_at = ?1 WHERE id = ?2",
        ["2026-10-14T09:30:00.000Z", picked.text().as_str()],
    )
    .expect("the test deletes the workflow");
    let refused = store
        .update_provider(&WorkflowProviderUpdateRequest {
            definition_id: picked,
            provider: provider("codex"),
        })
        .await
        .expect_err("a deleted workflow's pick is refused");
    let WorkflowDefinitionStoreError::NotFound(WorkflowNotFound::Definition { definition_id }) =
        refused
    else {
        panic!("the change is refused as the workflow not found, not {refused:?}");
    };
    assert_eq!(definition_id, picked);
}
