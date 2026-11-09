use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::ready;
use rstest::rstest;
use rusqlite::{OptionalExtension as _, params};
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_contracts::mcp::event::McpSubscribeEmission;
use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::mcp::server::requests::{
    McpServerDeleteRequest, McpServerEnabledUpdateRequest, McpServerUpsertRequest,
};
use sidekicks_contracts::mcp::server::{
    McpApplicationGrade, McpApprovalMode, McpServerBindingRef, McpServerConfigChangedNotice,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::stream::feed::{CreditGate, Feed};
use sidekicks_platforms::CredentialStore as PlatformCredentialStore;
use sidekicks_provider::driver::PROVIDER_REGISTRATIONS;
use sidekicks_provider::driver::contract::{MockProviderDriver, ProviderDriver};
use sidekicks_provider::driver::mcp_server::read::{
    McpServerDeclaration, McpServerPolicy, McpServerToolDefaults, ProviderMcpServersReading,
};
use sidekicks_provider::driver::mcp_server::write::{
    McpServerEntry, McpServerObserved, McpServerObservedEntry, McpServerWrite,
    McpServerWriteOutcome, McpServerWriteRefusal,
};
use sidekicks_provider::driver::test_registry::registry_of_first_providers;
use sidekicks_provider::tool_server_name::DAEMON_TOOL_SERVER_NAME;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::credential_store::service::KeychainService;
use sidekicks_store::credential_store::test_keychain::{CountingKeychain, test_keychain};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement};
use sidekicks_store::database::writer::test_file::TestDatabase;
use tempfile::TempDir;

use super::{McpMutationService, McpMutationSources, McpOperation, McpRemovalRows};
use crate::binding::store::McpBindingKey;
use crate::mutation::receipts::tests::{idempotency_key, receipts_over_a_database};
use crate::mutation::receipts::{McpIntentReceipt, McpReceiptDigest};
use crate::mutation::settle::tests::{is_owed, settled};
use crate::status::notices::McpNoticeBoard;
use crate::test_inventory::open_test_inventory;

/// The trigger that refuses every receipt's commit, so a write lands and its receipt stays
/// `pending`.
const FAIL_COMMITS_SQL: &str = "CREATE TRIGGER fail_commits BEFORE UPDATE ON mcp_mutation_receipts
     BEGIN SELECT RAISE(ABORT, 'the test fails this commit'); END";

/// The provider the test registry registers first, which every test's driver answers for.
fn first_provider() -> ProviderId {
    ProviderId::new(PROVIDER_REGISTRATIONS[0].descriptor.id.to_owned()).expect("a provider id")
}

/// The one entry every server's declaration holds in the scripted config.
fn entry() -> McpServerEntry {
    McpServerEntry::from_members(
        serde_json::from_value(json!({ "command": "npx" })).expect("the entry is an object"),
    )
}

/// A driver over a config holding the `user` servers `declared`, each write of which is answered
/// `outcome` and is expected `writes` times; a write that is not refused adds or removes its
/// server, which the next observe and read then see, an added `local` server as the off user entry
/// a provider that emulates `local` writes. Each declaration says the daemon keeps its switch where
/// `is_switch_kept_by_daemon` is set.
fn scripted_driver(
    provider: &ProviderId,
    declared: &[&str],
    outcome: McpServerWriteOutcome,
    writes: usize,
    is_switch_kept_by_daemon: bool,
) -> MockProviderDriver {
    // Each declared server by name, with its entry's own switch.
    let config: Arc<Mutex<HashMap<String, Option<bool>>>> = Arc::new(Mutex::new(
        declared
            .iter()
            .map(|name| ((*name).to_owned(), None))
            .collect(),
    ));
    let mut driver = MockProviderDriver::new();
    expect_declarations_read(
        &mut driver,
        provider,
        Arc::clone(&config),
        is_switch_kept_by_daemon,
    );
    let observe_config = Arc::clone(&config);
    driver
        .expect_observe_mcp_server()
        .returning(move |binding| {
            let is_present = lock(&observe_config).contains_key(binding.server_name().as_str());
            Box::pin(ready(Ok(McpServerObserved {
                entry: if is_present {
                    McpServerObservedEntry::Present(entry())
                } else {
                    McpServerObservedEntry::Absent
                },
                config_version: None,
                config_files: Vec::new(),
            })))
        });
    driver
        .expect_compose_mcp_server()
        .returning(|_binding, _config, _before| Ok(entry()));
    driver
        .expect_write_mcp_server()
        .times(writes)
        .returning(move |write, _before| {
            if !matches!(outcome, McpServerWriteOutcome::Refused(_)) {
                let mut config = lock(&config);
                match &write {
                    McpServerWrite::Upsert { binding, .. } => {
                        let binding = binding.binding();
                        let enabled =
                            matches!(binding, McpServerBindingRef::Local { .. }).then_some(false);
                        config.insert(binding.server_name().as_str().to_owned(), enabled);
                    }
                    McpServerWrite::Remove { binding } => {
                        config.remove(binding.binding().server_name().as_str());
                    }
                    McpServerWrite::SetEnabled { binding, .. } => {
                        config
                            .entry(binding.server_name().as_str().to_owned())
                            .or_insert(None);
                    }
                }
            }
            Box::pin(ready(outcome.clone()))
        });
    driver
}

/// Answers `driver`'s every declarations read with the `user` servers `config` holds, each with its
/// own switch, kept by the daemon where `is_switch_kept_by_daemon` is set.
fn expect_declarations_read(
    driver: &mut MockProviderDriver,
    provider: &ProviderId,
    config: Arc<Mutex<HashMap<String, Option<bool>>>>,
    is_switch_kept_by_daemon: bool,
) {
    let provider = provider.clone();
    driver.expect_read_mcp_servers().returning(move |_request| {
        let declarations = lock(&config)
            .iter()
            .map(|(name, enabled)| declaration(&provider, name, *enabled, is_switch_kept_by_daemon))
            .collect();
        Box::pin(ready(Ok(ProviderMcpServersReading {
            declarations,
            roots: Vec::new(),
            is_machine_managed: false,
            server_policy: McpServerPolicy::default(),
            account_servers: Vec::new(),
            probe_readings: Vec::new(),
        })))
    });
}

/// The `user` server `name`'s declaration, with the entry's command and its own switch `enabled`,
/// its switch kept by the daemon where `is_switch_kept_by_daemon` is set.
fn declaration(
    provider: &ProviderId,
    name: &str,
    enabled: Option<bool>,
    is_switch_kept_by_daemon: bool,
) -> McpServerDeclaration {
    McpServerDeclaration {
        binding: serde_json::from_value(user_binding(provider, name)).expect("a binding"),
        config: McpServerConfigView::Stdio {
            command: "npx".to_owned(),
            args: None,
            env_var_names: None,
            enabled,
            required: None,
            startup_timeout_sec: None,
            tool_timeout_sec: None,
        },
        superseded_in: Vec::new(),
        disabled_in: Vec::new(),
        is_read_only: false,
        sign_in_client: None,
        is_switch_kept_by_daemon,
        tool_defaults: McpServerToolDefaults::with_approval_mode(McpApprovalMode::Auto),
        organization_managed: None,
    }
}

fn user_binding(provider: &ProviderId, name: &str) -> Value {
    json!({ "scope": "user", "provider": provider.as_str(), "serverName": name })
}

/// An upsert of the `user` server `name` under `key`, declaring `command`.
fn upsert(
    provider: &ProviderId,
    key: &ClientUuid,
    name: &str,
    command: &str,
) -> McpServerUpsertRequest {
    let mut request = user_binding(provider, name);
    request["clientIdempotencyKey"] = json!(key.as_str());
    request["config"] = json!({ "transport": "stdio", "command": command });
    serde_json::from_value(request).expect("an upsert request")
}

/// A removal of the `user` server `name` under `key`.
fn delete(provider: &ProviderId, key: &ClientUuid, name: &str) -> McpServerDeleteRequest {
    let mut request = user_binding(provider, name);
    request["clientIdempotencyKey"] = json!(key.as_str());
    serde_json::from_value(request).expect("a delete request")
}

/// A switch-off of the `user` server `name` under `key`.
fn switch_off(
    provider: &ProviderId,
    key: &ClientUuid,
    name: &str,
) -> McpServerEnabledUpdateRequest {
    let mut request = user_binding(provider, name);
    request["clientIdempotencyKey"] = json!(key.as_str());
    request["enabled"] = json!(false);
    serde_json::from_value(request).expect("a switch request")
}

/// The code a refused call answered, `None` where it was served.
fn code<Response>(answer: &Result<Response, DomainError>) -> Option<RefusalCode> {
    answer.as_ref().err().map(|refusal| refusal.code)
}

/// A mutation service over a fresh database and keychain, the table's first providers answered by
/// a test's drivers in order, with the real inventory, binding store and receipts under it, and a
/// feed reading the board its tracker and the service send on.
struct Fixture {
    database: TestDatabase,
    keychain: Arc<CountingKeychain>,
    service: McpMutationService,
    notices: Box<dyn Feed<Emission = McpSubscribeEmission>>,
    _data_folder: TempDir,
    _platform_store: PlatformCredentialStore,
}

impl Fixture {
    async fn new(
        drivers: Vec<Arc<dyn ProviderDriver>>,
        removal_rows: Option<McpRemovalRows>,
    ) -> Self {
        let (database, _receipts, writer, reads) = receipts_over_a_database().await;
        let (data_folder, platform_store, keychain) = test_keychain(KeychainService::McpReceiptKey);
        let keychain = Arc::new(CountingKeychain::new(keychain));
        let providers = Arc::new(registry_of_first_providers(drivers));
        let board = Arc::new(McpNoticeBoard::default());
        let notices = board.follow().await.expect("the board's follow succeeds");
        let inventory = open_test_inventory(
            Arc::clone(&providers),
            Arc::clone(&writer),
            Arc::clone(&reads),
            Arc::clone(&board),
        )
        .await;
        let service = McpMutationService::new(McpMutationSources {
            providers,
            inventory: inventory.service,
            keychain: Arc::clone(&keychain) as _,
            writer,
            reads,
            removal_rows,
            board,
        });
        Self {
            database,
            keychain,
            service,
            notices: Box::new(notices),
            _data_folder: data_folder,
            _platform_store: platform_store,
        }
    }

    /// `key`'s receipt status, `None` where it has no receipt.
    fn receipt_status(&self, key: &ClientUuid) -> Option<String> {
        self.database
            .reader()
            .query_row(
                "SELECT status FROM mcp_mutation_receipts WHERE client_idempotency_key = ?1",
                params![key.as_str()],
                |row| row.get(0),
            )
            .optional()
            .expect("the test reads the receipt")
    }

    fn count(&self, sql: &str) -> i64 {
        self.database
            .reader()
            .query_row(sql, [], |row| row.get(0))
            .expect("the test counts the rows")
    }

    fn run(&self, sql: &str) {
        self.database
            .reader()
            .execute_batch(sql)
            .expect("the test changes the database");
    }

    /// The config-changed notices waiting on the fixture's feed, in the order it reads them; the
    /// tracker's status notices are passed over.
    fn config_notices(&mut self) -> Vec<McpServerConfigChangedNotice> {
        let gate = CreditGate::with_credit(1);
        let mut notices = Vec::new();
        while let Some(read) = self.notices.next(&gate).now_or_never() {
            let Some(emission) = read.expect("the board never fails") else {
                break;
            };
            match emission {
                McpSubscribeEmission::ConfigChanged(notice) => notices.push(notice),
                McpSubscribeEmission::StatusChanged(_)
                | McpSubscribeEmission::GovernanceEvent(_) => {}
            }
        }
        notices
    }
}

/// The `user` server `name`'s binding.
fn user_binding_ref(provider: &ProviderId, name: &str) -> McpServerBindingRef {
    serde_json::from_value(user_binding(provider, name)).expect("a binding")
}

/// Which mutation a notice case runs.
#[derive(Clone, Copy, Debug)]
enum NoticeEdit {
    /// An upsert of `docs`.
    Upsert,
    /// A switch-off of `docs`.
    SwitchOff,
}

/// A change committed as landed sends one config-changed notice for its binding, a daemon-kept
/// switch committed with no provider call included. Killed by no notice on the daemon-kept
/// commit.
#[rstest]
#[case::a_landed_upsert(&[], 1, false, NoticeEdit::Upsert)]
#[case::a_switch_the_daemon_keeps(&["docs"], 0, true, NoticeEdit::SwitchOff)]
#[tokio::test]
async fn the_config_notice_follows_the_commit(
    #[case] declared: &[&str],
    #[case] writes: usize,
    #[case] is_switch_kept_by_daemon: bool,
    #[case] edit: NoticeEdit,
) {
    let provider = first_provider();
    let driver = scripted_driver(
        &provider,
        declared,
        McpServerWriteOutcome::Applied {
            reload_failure: None,
        },
        writes,
        is_switch_kept_by_daemon,
    );
    let mut fixture = Fixture::new(vec![Arc::new(driver)], None).await;
    let key = idempotency_key();

    let answered = match edit {
        NoticeEdit::Upsert => code(
            &fixture
                .service
                .upsert(upsert(&provider, &key, "docs", "npx"))
                .await,
        ),
        NoticeEdit::SwitchOff => code(
            &fixture
                .service
                .set_enabled(switch_off(&provider, &key, "docs"))
                .await,
        ),
    };

    assert_eq!(answered, None);
    let bindings: Vec<_> = fixture
        .config_notices()
        .iter()
        .map(McpServerConfigChangedNotice::binding)
        .collect();
    assert_eq!(bindings, vec![user_binding_ref(&provider, "docs")]);
}

/// Two calls under one key at once, the second with another request: the provider is written
/// once, the first lands and the second answers the key's conflict. Killed by the saved check
/// removed, by the key's lock removed, and by the key compared without the request.
#[tokio::test]
async fn a_same_key_retry_with_another_request_conflicts_after_one_write() {
    let provider = first_provider();
    let driver = scripted_driver(
        &provider,
        &[],
        McpServerWriteOutcome::Applied {
            reload_failure: None,
        },
        1,
        false,
    );
    let fixture = Fixture::new(vec![Arc::new(driver)], None).await;
    let key = idempotency_key();

    let (first, second) = tokio::join!(
        fixture
            .service
            .upsert(upsert(&provider, &key, "docs", "npx")),
        fixture
            .service
            .upsert(upsert(&provider, &key, "docs", "uvx")),
    );

    let mut codes = vec![code(&first), code(&second)];
    codes.sort_by_key(Option::is_some);
    assert_eq!(
        codes,
        vec![None, Some(RefusalCode::McpServerIdempotencyConflict)]
    );
    assert_eq!(fixture.receipt_status(&key).as_deref(), Some("committed"));
}

/// A write that lands while its receipt's commit is refused leaves the receipt `pending`, writes
/// no binding row and sends no notice; the start's pass then commits it once, as landed, with its
/// row, one config-changed notice and no second write, and the retry's saved answer sends none.
/// Killed by a commit apart from the binding's row, by a pass that skips the receipt, by a notice
/// sent before the commit, and by no notice at a settle.
#[tokio::test]
async fn a_landed_write_whose_commit_failed_is_committed_by_the_start() {
    let provider = first_provider();
    let driver = scripted_driver(
        &provider,
        &[],
        McpServerWriteOutcome::Applied {
            reload_failure: None,
        },
        1,
        false,
    );
    let mut fixture = Fixture::new(vec![Arc::new(driver)], None).await;
    let key = idempotency_key();
    fixture.run(FAIL_COMMITS_SQL);

    let answer = fixture
        .service
        .upsert(upsert(&provider, &key, "docs", "npx"))
        .await;

    assert_eq!(code(&answer), Some(RefusalCode::McpBindingStoreUnavailable));
    assert_eq!(fixture.receipt_status(&key).as_deref(), Some("pending"));
    assert_eq!(fixture.count("SELECT count(*) FROM mcp_server_bindings"), 0);
    assert_eq!(fixture.config_notices(), Vec::new());

    fixture.run("DROP TRIGGER fail_commits");
    fixture.service.settle_pending();
    settled(&fixture.service.pending).await;

    assert_eq!(fixture.receipt_status(&key).as_deref(), Some("committed"));
    assert_eq!(fixture.count("SELECT count(*) FROM mcp_server_bindings"), 1);
    let settled_bindings: Vec<_> = fixture
        .config_notices()
        .iter()
        .map(McpServerConfigChangedNotice::binding)
        .collect();
    assert_eq!(settled_bindings, vec![user_binding_ref(&provider, "docs")]);
    let retry = fixture
        .service
        .upsert(upsert(&provider, &key, "docs", "npx"))
        .await
        .expect("the retry answers the settled change");
    assert_eq!(retry.applied, McpApplicationGrade::UserConfigWrite);
    assert_eq!(fixture.config_notices(), Vec::new());
}

/// With the keychain refusing reads, each mutation fails closed before it writes a receipt,
/// mints a key or reaches the provider, whose driver answers no call. Killed by a receipt begun
/// or a driver called before the receipt key is read.
#[tokio::test]
async fn every_mutation_reads_the_receipt_key_first() {
    let provider = first_provider();
    let fixture = Fixture::new(vec![Arc::new(MockProviderDriver::new())], None).await;
    fixture
        .keychain
        .set_read_refusal(Some(KeychainRefusalCause::Locked));

    let upserted = fixture
        .service
        .upsert(upsert(&provider, &idempotency_key(), "docs", "npx"))
        .await;
    let deleted = fixture
        .service
        .delete(delete(&provider, &idempotency_key(), "docs"))
        .await;
    let switched = fixture
        .service
        .set_enabled(switch_off(&provider, &idempotency_key(), "docs"))
        .await;

    for answer in [code(&upserted), code(&deleted), code(&switched)] {
        assert_eq!(answer, Some(RefusalCode::McpBindingStoreUnavailable));
    }
    assert_eq!(
        fixture.count("SELECT count(*) FROM mcp_mutation_receipts"),
        0
    );
    assert_eq!(fixture.keychain.writes(), 0);
}

/// A change the preflight refuses writes no receipt and reaches no driver call past the
/// declarations read, whose driver answers that read alone with nothing declared; a connector's
/// switch, which the daemon keeps per project, is refused before its commit. Killed by the receipt
/// begun or the daemon-kept switch committed before the check, and by the observe, the compose or
/// the write moved ahead of it.
#[tokio::test]
async fn a_change_the_preflight_refuses_writes_no_receipt() {
    let provider = first_provider();
    let mut driver = MockProviderDriver::new();
    expect_declarations_read(&mut driver, &provider, Arc::default(), false);
    let fixture = Fixture::new(vec![Arc::new(driver)], None).await;

    let upserted = fixture
        .service
        .upsert(upsert(
            &provider,
            &idempotency_key(),
            DAEMON_TOOL_SERVER_NAME,
            "npx",
        ))
        .await;
    let deleted = fixture
        .service
        .delete(delete(&provider, &idempotency_key(), "docs"))
        .await;
    let switched = fixture
        .service
        .set_enabled(switch_off(&provider, &idempotency_key(), "docs"))
        .await;
    let connector_switch = json!({
        "scope": "connector",
        "provider": provider.as_str(),
        "scopeRef": "account-1",
        "serverName": "slack",
        "clientIdempotencyKey": idempotency_key().as_str(),
        "enabled": false,
        "projectRoot": "/work/app",
    });
    let connector_switched = fixture
        .service
        .set_enabled(serde_json::from_value(connector_switch).expect("a switch request"))
        .await;

    assert_eq!(code(&upserted), Some(RefusalCode::McpServerConfigInvalid));
    for answer in [code(&deleted), code(&switched), code(&connector_switched)] {
        assert_eq!(answer, Some(RefusalCode::McpServerNotFound));
    }
    assert_eq!(
        fixture.count("SELECT count(*) FROM mcp_mutation_receipts"),
        0
    );
}

/// A provider's definite refusal commits the receipt with it and sends no config-changed notice,
/// so a retry under the key answers the same refusal without a second write. Killed by the
/// refused receipt deleted, and by a notice sent for a refusal.
#[tokio::test]
async fn a_definite_refusal_is_saved_and_replayed() {
    let provider = first_provider();
    let driver = scripted_driver(
        &provider,
        &[],
        McpServerWriteOutcome::Refused(McpServerWriteRefusal::StaleVersion {
            expected_version: "sha256:read".to_owned(),
            current_version: "sha256:moved".to_owned(),
        }),
        1,
        false,
    );
    let mut fixture = Fixture::new(vec![Arc::new(driver)], None).await;
    let key = idempotency_key();

    let first = fixture
        .service
        .upsert(upsert(&provider, &key, "docs", "npx"))
        .await;
    let retry = fixture
        .service
        .upsert(upsert(&provider, &key, "docs", "npx"))
        .await;

    assert_eq!(
        code(&first),
        Some(RefusalCode::McpServerConfigWriteConflict)
    );
    assert_eq!(code(&retry), code(&first));
    assert_eq!(
        retry.err().map(|refusal| refusal.message),
        first.err().map(|refusal| refusal.message)
    );
    assert_eq!(fixture.receipt_status(&key).as_deref(), Some("committed"));
    assert_eq!(fixture.config_notices(), Vec::new());
}

/// A removal whose commit failed after the write is settled by the start's pass with the removal
/// port's rows in the receipt's own write, as the live removal writes them. Killed by the settler
/// committing without the port's rows.
#[tokio::test]
async fn a_removal_settled_at_the_start_commits_the_ports_rows() {
    let provider = first_provider();
    let driver = scripted_driver(
        &provider,
        &["docs"],
        McpServerWriteOutcome::Applied {
            reload_failure: None,
        },
        1,
        false,
    );
    let marker: McpRemovalRows = Arc::new(|_key: &McpBindingKey| {
        vec![WriteStatement {
            sql: "INSERT INTO mcp_server_bindings (provider, scope, server_name,
                    first_observed_at, updated_at)
                  VALUES ('provider-a', 'user', 'marker', 't', 't')"
                .into(),
            bindings: StatementBindings::None,
            expected_row_count: Some(1),
        }]
    });
    let fixture = Fixture::new(vec![Arc::new(driver)], Some(marker)).await;
    let key = idempotency_key();
    let markers = "SELECT count(*) FROM mcp_server_bindings WHERE server_name = 'marker'";
    fixture.run(FAIL_COMMITS_SQL);

    let answer = fixture
        .service
        .delete(delete(&provider, &key, "docs"))
        .await;

    assert_eq!(code(&answer), Some(RefusalCode::McpBindingStoreUnavailable));
    assert_eq!(fixture.count(markers), 0);

    fixture.run("DROP TRIGGER fail_commits");
    fixture.service.settle_pending();
    settled(&fixture.service.pending).await;

    assert_eq!(fixture.receipt_status(&key).as_deref(), Some("committed"));
    assert_eq!(fixture.count(markers), 1);
}

/// Two first mutations under two keys at once, with no receipt key made yet, both land.
#[tokio::test]
async fn two_first_mutations_both_land() {
    let provider = first_provider();
    let driver = scripted_driver(
        &provider,
        &[],
        McpServerWriteOutcome::Applied {
            reload_failure: None,
        },
        2,
        false,
    );
    let fixture = Fixture::new(vec![Arc::new(driver)], None).await;
    let (docs_key, mail_key) = (idempotency_key(), idempotency_key());

    let (docs, mail) = tokio::join!(
        fixture
            .service
            .upsert(upsert(&provider, &docs_key, "docs", "npx")),
        fixture
            .service
            .upsert(upsert(&provider, &mail_key, "mail", "npx")),
    );

    assert_eq!((code(&docs), code(&mail)), (None, None));
    assert_eq!(
        fixture.receipt_status(&docs_key).as_deref(),
        Some("committed")
    );
    assert_eq!(
        fixture.receipt_status(&mail_key).as_deref(),
        Some("committed")
    );
}

/// An add of a `local` server its provider keeps as an off user entry stores the daemon's switch
/// it asks for, on for a new server that asks nothing, so the row reads as the person set it, and
/// a later edit asking nothing keeps the stored switch. Killed by the add storing no switch, which
/// leaves the row off, and by an edit that asks nothing clearing the stored one.
#[rstest]
#[case::asking_nothing(None, false, Some(1))]
#[case::asking_off(Some(false), false, Some(0))]
#[case::editing_asking_nothing(None, true, Some(1))]
#[tokio::test]
async fn an_emulated_local_add_stores_the_switch_it_asks_for(
    #[case] asked: Option<bool>,
    #[case] is_edited: bool,
    #[case] stored: Option<i64>,
) {
    let emulating = PROVIDER_REGISTRATIONS
        .iter()
        .position(|registration| registration.descriptor.is_mcp_local_scope_emulated)
        .expect("a provider emulates `local` servers");
    let provider = ProviderId::new(PROVIDER_REGISTRATIONS[emulating].descriptor.id.to_owned())
        .expect("a provider id");
    let mut drivers: Vec<Arc<dyn ProviderDriver>> = (0..emulating)
        .map(|_| Arc::new(MockProviderDriver::new()) as Arc<dyn ProviderDriver>)
        .collect();
    let applied = McpServerWriteOutcome::Applied {
        reload_failure: None,
    };
    let writes = 1 + usize::from(is_edited);
    drivers.push(Arc::new(scripted_driver(
        &provider,
        &[],
        applied,
        writes,
        false,
    )));
    let fixture = Fixture::new(drivers, None).await;
    let upsert_asking = |asked: Option<bool>| {
        let key = idempotency_key();
        let mut request = json!({
            "scope": "local",
            "provider": provider.as_str(),
            "scopeRef": "/repos/app",
            "serverName": "docs",
            "clientIdempotencyKey": key.as_str(),
            "config": { "transport": "stdio", "command": "npx" },
        });
        if let Some(asked) = asked {
            request["config"]["enabled"] = json!(asked);
        }
        fixture
            .service
            .upsert(serde_json::from_value(request).expect("an upsert request"))
    };

    let answered = upsert_asking(asked).await;
    assert_eq!(code(&answered), None);
    if is_edited {
        let edited = upsert_asking(None).await;
        assert_eq!(code(&edited), None);
    }

    let switch: Option<i64> = fixture
        .database
        .reader()
        .query_row(
            "SELECT enabled_override FROM mcp_server_bindings WHERE scope = 'local'",
            [],
            |row| row.get(0),
        )
        .expect("the add stores its row");
    assert_eq!(switch, stored);
}

/// A `pending` receipt whose provider no driver is registered for is settled once by the
/// service's own settler and stays `pending`, owing no pass, so no later mutation starts one for
/// it. Killed by a missing driver answering `Unsettled`, which owes the next pass.
#[tokio::test]
async fn a_receipt_no_driver_is_registered_for_owes_no_pass() {
    let fixture = Fixture::new(Vec::new(), None).await;
    let key = idempotency_key();
    let intent = McpIntentReceipt {
        idempotency_key: key.clone(),
        operation: McpOperation::Upsert.method().to_owned(),
        binding: McpBindingKey::of(&user_binding_ref(&first_provider(), "docs")),
        request_digest: McpReceiptDigest::from_bytes([1; 32]),
        before_digest: None,
        after_digest: None,
        wanted_enabled: None,
    };
    fixture
        .service
        .parts
        .receipts
        .begin(&intent)
        .await
        .expect("the intent begins");

    fixture.service.settle_pending();
    settled(&fixture.service.pending).await;

    assert_eq!(fixture.receipt_status(&key).as_deref(), Some("pending"));
    assert!(!is_owed(&fixture.service.pending));
}
