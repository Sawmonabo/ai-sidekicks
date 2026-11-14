use std::sync::{Arc, Mutex};

use axum::http::StatusCode;
use futures::FutureExt as _;
use futures::future::ready;
use rmcp::transport::auth::{CredentialStore as _, StoredCredentials};
use rstest::rstest;
use rusqlite::types::ValueRef;
use secrecy::ExposeSecret as _;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_platforms::CredentialStore as PlatformCredentialStore;
use sidekicks_provider::driver::PROVIDER_REGISTRATIONS;
use sidekicks_provider::driver::contract::sign_in::McpServerAddressReading;
use sidekicks_provider::driver::contract::{MockProviderDriver, ProviderDriver};
use sidekicks_provider::driver::mcp_server::read::{McpServerPolicy, ProviderMcpServersReading};
use sidekicks_provider::driver::mcp_server::write::McpServerWriteOutcome;
use sidekicks_provider::driver::test_registry::first_provider;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::credential_store::service::KeychainService;
use sidekicks_store::credential_store::test_keychain::test_keychain;
use sidekicks_workspace::test_rows::project_and_mount_rows;
use tempfile::TempDir;
use tokio::sync::Notify;

use super::OwedSignOuts;
use crate::mutation::receipts::tests::idempotency_key;
use crate::mutation::service::removal_sign_out::McpRemovalSignOut as _;
use crate::mutation::service::tests::{ScriptedServer, WriteHook, delete, scripted_driver};
use crate::mutation::service::{McpMutationService, McpMutationSources};
use crate::sign_in::address_digest::{ServerAddressDigest, ServerAddressKey};
use crate::sign_in::server::tests::{
    TestSources, answer_address_read, docs_binding, driver_declaring, remote_declaration,
    test_sources,
};
use crate::sign_in::sign_out::revocation::tests::{address, received_revocations, signed_in};
use crate::sign_in::test_service::{FakeAuthorizationServer, Harness, harness};

/// The owed sign-outs and the mutation service over a test's sources, the service finished over
/// them, with the sources and the receipt key's keychain kept alive beside them.
struct Removal {
    owed: Arc<OwedSignOuts>,
    mutations: McpMutationService,
    sources: TestSources,
    _receipt_keychain: (TempDir, PlatformCredentialStore),
}

/// The owed sign-outs over `drivers`, signing out through `harness`'s service, and the mutation
/// service whose removals owe through them.
async fn removal_over(drivers: Vec<Arc<dyn ProviderDriver>>, harness: &Harness) -> Removal {
    let sources = test_sources(drivers).await;
    let owed = OwedSignOuts::new(
        Arc::clone(&harness.service),
        sources.target_reads(),
        Arc::clone(&sources.reads),
        Arc::clone(&sources.writer),
    );
    let (data_folder, platform_store, keychain) = test_keychain(KeychainService::McpReceiptKey);
    let mutations = McpMutationService::new(McpMutationSources {
        providers: Arc::clone(&sources.providers),
        inventory: Arc::clone(&sources.inventory),
        keychain,
        writer: Arc::clone(&sources.writer),
        reads: Arc::clone(&sources.reads),
        removal_rows: None,
        board: Arc::clone(&sources.board),
    })
    .with_removal_sign_out(Arc::clone(&owed) as _);
    Removal {
        owed,
        mutations,
        sources,
        _receipt_keychain: (data_folder, platform_store),
    }
}

/// The first provider's driver declaring the remote `user` binding `docs` at `server`, its address
/// reading `address` while declared, removed by its one write, which first awaits `before_write`.
fn docs_driver(
    server: &FakeAuthorizationServer,
    address: Option<McpServerAddress>,
    before_write: WriteHook,
) -> Arc<dyn ProviderDriver> {
    Arc::new(scripted_driver(
        &first_provider(),
        &["docs"],
        McpServerWriteOutcome::Applied {
            reload_failure: None,
        },
        1,
        false,
        ScriptedServer::Remote {
            url: server.base.clone(),
            address,
            before_write,
        },
    ))
}

/// A write hook that awaits nothing.
fn no_wait() -> WriteHook {
    Arc::new(|| ready(()).boxed())
}

/// The second provider's `user` binding of the server `notes`.
fn notes_binding() -> McpServerBindingRef {
    McpServerBindingRef::User {
        provider: ProviderId::new(PROVIDER_REGISTRATIONS[1].descriptor.id.to_owned())
            .expect("a provider id"),
        server_name: McpServerName::new("notes".to_owned()).expect("a server name"),
    }
}

/// `server`'s address spelled with an upper-case scheme, which folds to the same server.
fn shouted(server: &FakeAuthorizationServer) -> McpServerAddress {
    McpServerAddress::new(&server.base.replacen("http://", "HTTP://", 1)).expect("an address")
}

/// The second provider's driver declaring `notes` at `server` shouted, its one address read
/// answering `reading`.
fn notes_driver(
    server: &FakeAuthorizationServer,
    reading: McpServerAddressReading,
) -> Arc<dyn ProviderDriver> {
    let mut driver = driver_declaring(vec![remote_declaration(
        &notes_binding(),
        shouted(server).as_str(),
    )]);
    answer_address_read(&mut driver, Ok(reading));
    Arc::new(driver)
}

/// Whether the keychain still holds `server`'s sign-in.
async fn is_held(harness: &Harness, server: &FakeAuthorizationServer) -> bool {
    harness
        .keychain
        .read(
            harness
                .service
                .custody
                .test_digest(&address(server))
                .await
                .as_str(),
        )
        .await
        .expect("the keychain answers")
        .is_some()
}

/// The owed sign-outs recorded.
async fn records(owed: &OwedSignOuts) -> Vec<ServerAddressDigest> {
    owed.records.list().await.expect("the records read")
}

// The removal of the last binding naming a signed-in server signs it out, revoking its refresh
// token; another provider's binding naming it, spelled another way, keeps it. Each case's write
// asserts the record is kept before it. Killed by the scan skipped, by only the removed binding's
// provider scanned, by addresses compared as spelled (each loses the item in
// `another_provider_declares_it`), by the record written after the provider's write (the write's
// assertion) and by a record left after the settle (both).
#[rstest]
#[case::last_binding(false)]
#[case::another_provider_declares_it(true)]
#[tokio::test]
async fn removing_a_binding_signs_its_server_out_only_when_it_was_the_last(
    #[case] is_declared_elsewhere: bool,
) {
    let (server, harness, _authorizer) = signed_in(StatusCode::OK, None, None).await;
    let digest = harness.service.custody.test_digest(&address(&server)).await;
    let owed_cell: Arc<Mutex<Option<Arc<OwedSignOuts>>>> = Arc::default();
    let (hook_cell, hook_address) = (Arc::clone(&owed_cell), digest.clone());
    let assert_recorded: WriteHook = Arc::new(move || {
        let owed = lock(&hook_cell)
            .clone()
            .expect("the owed sign-outs are built");
        let expected = vec![hook_address.clone()];
        async move { assert_eq!(records(&owed).await, expected) }.boxed()
    });
    let notes = if is_declared_elsewhere {
        notes_driver(&server, McpServerAddressReading::Declared(shouted(&server)))
    } else {
        Arc::new(driver_declaring(Vec::new()))
    };
    let removal = removal_over(
        vec![
            docs_driver(&server, Some(address(&server)), assert_recorded),
            notes,
        ],
        &harness,
    )
    .await;
    *lock(&owed_cell) = Some(Arc::clone(&removal.owed));

    let removed = removal
        .mutations
        .delete(delete(&first_provider(), &idempotency_key(), "docs"))
        .await;

    assert!(removed.is_ok(), "the removal lands");
    assert_eq!(is_held(&harness, &server).await, is_declared_elsewhere);
    if is_declared_elsewhere {
        assert!(lock(&server.revocation_forms).is_empty());
    } else {
        assert_eq!(received_revocations(&server).await.len(), 1);
    }
    assert_eq!(
        records(&removal.owed).await,
        Vec::<ServerAddressDigest>::new()
    );
}

// A removal whose sign-out the keychain refuses still lands, its sign-out kept owed, and the next
// settle does it. Killed by the refusal returned from the removal, by the record cleared on a
// refusal, and by a settle that does not read the records.
#[tokio::test]
async fn a_refused_keychain_leaves_the_removal_landed_and_its_sign_out_owed() {
    let (server, harness, _authorizer) = signed_in(StatusCode::OK, None, None).await;
    let digest = harness.service.custody.test_digest(&address(&server)).await;
    let removal = removal_over(
        vec![
            docs_driver(&server, Some(address(&server)), no_wait()),
            Arc::new(driver_declaring(Vec::new())),
        ],
        &harness,
    )
    .await;
    harness
        .platform_store
        .refuse_next_call(&harness.sign_in_service_name, digest.as_str());

    let removed = removal
        .mutations
        .delete(delete(&first_provider(), &idempotency_key(), "docs"))
        .await;

    assert!(removed.is_ok(), "the removal lands");
    assert!(is_held(&harness, &server).await);
    assert_eq!(records(&removal.owed).await, [digest]);

    removal.owed.settle_owed_sign_outs().await;

    assert!(!is_held(&harness, &server).await);
    assert_eq!(received_revocations(&server).await.len(), 1);
    assert_eq!(
        records(&removal.owed).await,
        Vec::<ServerAddressDigest>::new()
    );
}

// A settle from outside a removal, as a press's, while the removal's write waits, leaves its
// record and the sign-in; the removal's own settle then signs out. Killed by the in-flight count
// skipped and by the hold dropped before the write: the outside settle, reading the binding still
// declared, clears the record and the item stays.
#[tokio::test]
async fn a_settle_leaves_the_record_of_a_delete_still_in_flight() {
    let (server, harness, _authorizer) = signed_in(StatusCode::OK, None, None).await;
    let digest = harness.service.custody.test_digest(&address(&server)).await;
    let (started, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    let (hook_started, hook_release) = (Arc::clone(&started), Arc::clone(&release));
    let waiting: WriteHook = Arc::new(move || {
        let (started, release) = (Arc::clone(&hook_started), Arc::clone(&hook_release));
        async move {
            started.notify_one();
            release.notified().await;
        }
        .boxed()
    });
    let removal = removal_over(
        vec![
            docs_driver(&server, Some(address(&server)), waiting),
            Arc::new(driver_declaring(Vec::new())),
        ],
        &harness,
    )
    .await;
    let outside = async {
        started.notified().await;
        removal.owed.settle_owed_sign_outs().await;
        assert_eq!(records(&removal.owed).await, std::slice::from_ref(&digest));
        assert!(is_held(&harness, &server).await);
        release.notify_one();
    };

    let (removed, ()) = tokio::join!(
        removal
            .mutations
            .delete(delete(&first_provider(), &idempotency_key(), "docs")),
        outside
    );

    assert!(removed.is_ok(), "the removal lands");
    assert!(!is_held(&harness, &server).await);
    assert_eq!(received_revocations(&server).await.len(), 1);
    assert_eq!(
        records(&removal.owed).await,
        Vec::<ServerAddressDigest>::new()
    );
}

// A removed binding whose address no longer reads, as one whose variable lost its value, signs
// out at the address it last read as. Killed by the binding's last declared address not read on
// an unreadable address: nothing is owed and the item stays.
#[tokio::test]
async fn an_address_that_no_longer_reads_signs_out_through_the_last_declared_one() {
    let (server, harness, _authorizer) = signed_in(StatusCode::OK, None, None).await;
    let removal = removal_over(
        vec![
            docs_driver(&server, None, no_wait()),
            Arc::new(driver_declaring(Vec::new())),
        ],
        &harness,
    )
    .await;
    removal
        .owed
        .note_declared(&docs_binding(), &address(&server))
        .await
        .expect("the address is kept");

    let removed = removal
        .mutations
        .delete(delete(&first_provider(), &idempotency_key(), "docs"))
        .await;

    assert!(removed.is_ok(), "the removal lands");
    assert!(!is_held(&harness, &server).await);
    assert_eq!(received_revocations(&server).await.len(), 1);
    assert_eq!(
        records(&removal.owed).await,
        Vec::<ServerAddressDigest>::new()
    );
}

// A binding that reads at a new address owes the old one's sign-out, which the next settle does
// while the binding keeps the new one. Killed by the old address not owed where the binding held
// another (the item stays), and by the binding's address not updated (a second read at the new
// address owes again).
#[tokio::test]
async fn a_changed_address_owes_the_old_ones_sign_out() {
    let (server, harness, _authorizer) = signed_in(StatusCode::OK, None, None).await;
    let moved = McpServerAddress::new("https://elsewhere.example.test/mcp").expect("an address");
    let mut driver = driver_declaring(vec![remote_declaration(&docs_binding(), moved.as_str())]);
    answer_address_read(
        &mut driver,
        Ok(McpServerAddressReading::Declared(moved.clone())),
    );
    let removal = removal_over(vec![Arc::new(driver)], &harness).await;
    removal
        .owed
        .note_declared(&docs_binding(), &address(&server))
        .await
        .expect("the first address is kept");

    removal
        .owed
        .note_declared(&docs_binding(), &moved)
        .await
        .expect("the new address is kept");
    removal.owed.settle_owed_sign_outs().await;

    assert!(!is_held(&harness, &server).await);
    assert_eq!(received_revocations(&server).await.len(), 1);
    assert_eq!(
        records(&removal.owed).await,
        Vec::<ServerAddressDigest>::new()
    );
    removal
        .owed
        .note_declared(&docs_binding(), &moved)
        .await
        .expect("the new address is read again");
    assert_eq!(
        records(&removal.owed).await,
        Vec::<ServerAddressDigest>::new()
    );
}

// A remaining binding whose address no longer reads keeps the sign-in at the address it last read
// as. Killed by an unreadable address counted as naming no server: the sign-in is signed out
// while that binding still names it.
#[tokio::test]
async fn a_remaining_binding_whose_address_no_longer_reads_keeps_the_sign_in() {
    let (server, harness, _authorizer) = signed_in(StatusCode::OK, None, None).await;
    let removal = removal_over(
        vec![
            docs_driver(&server, Some(address(&server)), no_wait()),
            notes_driver(&server, McpServerAddressReading::Unreadable),
        ],
        &harness,
    )
    .await;
    removal
        .owed
        .note_declared(&notes_binding(), &shouted(&server))
        .await
        .expect("the address is kept");

    let removed = removal
        .mutations
        .delete(delete(&first_provider(), &idempotency_key(), "docs"))
        .await;

    assert!(removed.is_ok(), "the removal lands");
    assert!(is_held(&harness, &server).await);
    assert!(lock(&server.revocation_forms).is_empty());
    assert_eq!(
        records(&removal.owed).await,
        Vec::<ServerAddressDigest>::new()
    );
}

// No stored row and no keychain account names a signed-in server's user name, password or query:
// each holds the server's digest, and the address is kept only inside the sign-in's secret.
// Killed by any of the three tables, or the keychain item's account, keeping the address.
#[tokio::test]
async fn no_row_or_keychain_account_holds_a_signed_in_address() {
    const SECRETS: [&str; 3] = ["alice-user", "hunter2-pass", "query-secret"];
    let harness = harness().await;
    let removal = removal_over(vec![Arc::new(driver_declaring(Vec::new()))], &harness).await;
    let secret_address = McpServerAddress::new(
        "https://alice-user:hunter2-pass@docs.example.test/mcp?key=query-secret",
    )
    .expect("an address");
    let custody = &harness.service.custody;
    let digest = custody
        .digest(&secret_address)
        .await
        .expect("the address key is made");
    let token_response = serde_json::from_value(serde_json::json!({
        "access_token": "test-access-token",
        "token_type": "Bearer",
        "refresh_token": "test-refresh-token",
    }))
    .expect("a token response reads");
    custody
        .attempt_credential_store(
            &digest,
            &secret_address,
            custody.sign_out_generation(&digest),
            None,
            None,
        )
        .save(StoredCredentials::new(
            "test-client".to_owned(),
            Some(token_response),
            vec![],
            None,
        ))
        .await
        .expect("the sign-in is kept");
    harness
        .admitted_clients
        .mark_own_client_unfinished(&digest)
        .await
        .expect("the mark is kept");
    removal
        .owed
        .note_declared(&notes_binding(), &secret_address)
        .await
        .expect("the address is kept");
    removal
        .owed
        .note_declared(&docs_binding(), &secret_address)
        .await
        .expect("the address is kept");
    removal
        .owed
        .note_declared(
            &docs_binding(),
            &McpServerAddress::new("https://elsewhere.example.test/mcp").expect("an address"),
        )
        .await
        .expect("the moved address owes the first");

    let connection =
        rusqlite::Connection::open(harness.database.path()).expect("the database opens");
    let mut stored = Vec::new();
    for table in [
        "mcp_server_bindings",
        "mcp_server_owed_sign_outs",
        "mcp_server_admitted_clients",
    ] {
        let mut statement = connection
            .prepare(&format!("SELECT * FROM {table}"))
            .expect("the table reads");
        let columns = statement.column_count();
        let mut rows = statement.query([]).expect("the rows read");
        while let Some(row) = rows.next().expect("a row reads") {
            for column in 0..columns {
                // Text and blobs as their text, so a search finds what they hold.
                stored.push(match row.get_ref(column).expect("a value reads") {
                    ValueRef::Text(bytes) | ValueRef::Blob(bytes) => {
                        String::from_utf8_lossy(bytes).into_owned()
                    }
                    value @ (ValueRef::Null | ValueRef::Integer(_) | ValueRef::Real(_)) => {
                        format!("{value:?}")
                    }
                });
            }
        }
    }
    let accounts = harness
        .keychain
        .accounts()
        .await
        .expect("the keychain lists");

    assert!(
        stored.iter().any(|value| value.contains(digest.as_str())),
        "the rows name the server by its digest: {stored:?}"
    );
    assert!(accounts.iter().any(|account| account == digest.as_str()));
    for secret in SECRETS {
        assert!(
            !stored.iter().any(|value| value.contains(secret)),
            "{stored:?}"
        );
        assert!(
            !accounts.iter().any(|account| account.contains(secret)),
            "{accounts:?}"
        );
    }
    let item = harness
        .keychain
        .read(digest.as_str())
        .await
        .expect("the keychain reads")
        .expect("the sign-in is kept");
    assert!(
        item.expose_secret().contains("hunter2-pass"),
        "the secret keeps the address"
    );
}

// A removal that lands while a settle's scan runs, the scan having read its binding still
// declared, keeps its record through that settle and is signed out by the run its own settle
// asks for. Killed by a settle that checks only the removals counted now: the scan's stale reading
// clears the record and the item stays.
#[tokio::test]
async fn a_removal_landing_during_a_scan_keeps_its_record_for_its_own_settle() {
    let (server, harness, _authorizer) = signed_in(StatusCode::OK, None, None).await;
    let (scan_reached, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    let (reached_by_driver, release_for_driver) = (Arc::clone(&scan_reached), Arc::clone(&release));
    let is_first_read = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let mut notes = driver_declaring(vec![remote_declaration(
        &notes_binding(),
        "https://notes.example.test/mcp",
    )]);
    notes
        .expect_read_mcp_server_addresses()
        .returning(move |requests| {
            let blocks = is_first_read.swap(false, std::sync::atomic::Ordering::SeqCst);
            let (reached, release) = (
                Arc::clone(&reached_by_driver),
                Arc::clone(&release_for_driver),
            );
            async move {
                if blocks {
                    reached.notify_one();
                    release.notified().await;
                }
                requests
                    .iter()
                    .map(|_request| {
                        Ok(McpServerAddressReading::Declared(
                            McpServerAddress::new("https://notes.example.test/mcp")
                                .expect("an address"),
                        ))
                    })
                    .collect()
            }
            .boxed()
        });
    let hook_written = Arc::new(Notify::new());
    let hook_notice = Arc::clone(&hook_written);
    let notify_write: WriteHook = Arc::new(move || {
        let notice = Arc::clone(&hook_notice);
        async move { notice.notify_one() }.boxed()
    });
    let removal = removal_over(
        vec![
            docs_driver(&server, Some(address(&server)), notify_write),
            Arc::new(notes),
        ],
        &harness,
    )
    .await;
    let other = ServerAddressKey::of_test_fill(9)
        .digest(&McpServerAddress::new("https://other.example.test/mcp").expect("an address"));
    removal
        .owed
        .records
        .record(&other)
        .await
        .expect("an earlier record is kept");

    let outside = removal.owed.settle_after_request();
    let landing = async {
        scan_reached.notified().await;
        let removed =
            removal
                .mutations
                .delete(delete(&first_provider(), &idempotency_key(), "docs"));
        let releasing = async {
            hook_written.notified().await;
            release.notify_one();
        };
        let (removed, ()) = tokio::join!(removed, releasing);
        removed
    };
    let ((), removed) = tokio::join!(outside, landing);

    assert!(removed.is_ok(), "the removal lands");
    assert!(!is_held(&harness, &server).await);
    assert_eq!(received_revocations(&server).await.len(), 1);
    assert_eq!(
        records(&removal.owed).await,
        Vec::<ServerAddressDigest>::new()
    );
}

// A removal counted before a settle began, whose write lands and whose hold drops while that
// settle's scan holds its binding still declared, keeps its record through that settle and is
// signed out by its own. Killed by a release that does not stamp the server: the earlier settle
// clears the record from its stale reading and the item stays.
#[tokio::test]
async fn a_removal_released_during_an_earlier_settles_scan_still_signs_out() {
    let (server, harness, _authorizer) = signed_in(StatusCode::OK, None, None).await;
    let (scan_reached, release_scan) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    let (reached_by_driver, release_for_driver) =
        (Arc::clone(&scan_reached), Arc::clone(&release_scan));
    let is_armed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let armed_for_driver = Arc::clone(&is_armed);
    let mut notes = driver_declaring(vec![remote_declaration(
        &notes_binding(),
        "https://notes.example.test/mcp",
    )]);
    notes
        .expect_read_mcp_server_addresses()
        .returning(move |requests| {
            let blocks = armed_for_driver.swap(false, std::sync::atomic::Ordering::SeqCst);
            let (reached, release) = (
                Arc::clone(&reached_by_driver),
                Arc::clone(&release_for_driver),
            );
            async move {
                if blocks {
                    reached.notify_one();
                    release.notified().await;
                }
                requests
                    .iter()
                    .map(|_request| {
                        Ok(McpServerAddressReading::Declared(
                            McpServerAddress::new("https://notes.example.test/mcp")
                                .expect("an address"),
                        ))
                    })
                    .collect()
            }
            .boxed()
        });
    let (write_reached, go_write) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    let (reached_by_write, go_for_write) = (Arc::clone(&write_reached), Arc::clone(&go_write));
    let waiting: WriteHook = Arc::new(move || {
        let (reached, go) = (Arc::clone(&reached_by_write), Arc::clone(&go_for_write));
        async move {
            reached.notify_one();
            go.notified().await;
        }
        .boxed()
    });
    let removal = removal_over(
        vec![
            docs_driver(&server, Some(address(&server)), waiting),
            Arc::new(notes),
        ],
        &harness,
    )
    .await;

    let removed = removal
        .mutations
        .delete(delete(&first_provider(), &idempotency_key(), "docs"));
    let earlier = async {
        write_reached.notified().await;
        is_armed.store(true, std::sync::atomic::Ordering::SeqCst);
        removal.owed.settle_after_request().await;
    };
    let landing = async {
        scan_reached.notified().await;
        go_write.notify_one();
        while !lock(&removal.owed.in_flight).counts.is_empty() {
            tokio::task::yield_now().await;
        }
        release_scan.notify_one();
    };
    let (removed, (), ()) = tokio::join!(removed, earlier, landing);

    assert!(removed.is_ok(), "the removal lands");
    assert!(!is_held(&harness, &server).await);
    assert_eq!(received_revocations(&server).await.len(), 1);
    assert_eq!(
        records(&removal.owed).await,
        Vec::<ServerAddressDigest>::new()
    );
}

// A detached project's folder still counts as a root: a server only its `.mcp.json` names keeps
// its sign-in when another binding at that server is removed. Killed by the scan reading the
// attached roots alone: the project's binding is never declared and the sign-in is revoked.
#[tokio::test]
async fn a_detached_projects_server_keeps_its_sign_in() {
    let (server, harness, _authorizer) = signed_in(StatusCode::OK, None, None).await;
    let project_binding: McpServerBindingRef = serde_json::from_value(serde_json::json!({
        "provider": PROVIDER_REGISTRATIONS[1].descriptor.id,
        "scope": "project",
        "scopeRef": "/repos/app",
        "serverName": "notes",
    }))
    .expect("a binding");
    let declared_binding = project_binding.clone();
    let declared_address = shouted(&server);
    let mut notes = MockProviderDriver::new();
    let declaration = remote_declaration(&declared_binding, declared_address.as_str());
    notes.expect_read_mcp_servers().returning(move |request| {
        let is_root_read = request
            .attached_roots
            .iter()
            .any(|root| root.path.as_str() == "/repos/app");
        Box::pin(ready(Ok(ProviderMcpServersReading {
            declarations: if is_root_read {
                vec![declaration.clone()]
            } else {
                Vec::new()
            },
            roots: Vec::new(),
            is_machine_managed: false,
            server_policy: McpServerPolicy::default(),
            account_servers: Vec::new(),
            probe_readings: Vec::new(),
        })))
    });
    notes
        .expect_read_mcp_server_addresses()
        .returning(move |requests| {
            let address = declared_address.clone();
            Box::pin(ready(
                requests
                    .iter()
                    .map(|_request| Ok(McpServerAddressReading::Declared(address.clone())))
                    .collect(),
            ))
        });
    let removal = removal_over(
        vec![
            docs_driver(&server, Some(address(&server)), no_wait()),
            Arc::new(notes),
        ],
        &harness,
    )
    .await;
    let connection = removal.sources.database.reader();
    for row in project_and_mount_rows("detached", None) {
        connection
            .execute_batch(&row)
            .expect("the project and its mount are stored");
    }
    connection
        .execute_batch("UPDATE repo_mounts SET state = 'detached'")
        .expect("the mount is detached");

    let removed = removal
        .mutations
        .delete(delete(&first_provider(), &idempotency_key(), "docs"))
        .await;

    assert!(removed.is_ok(), "the removal lands");
    assert!(is_held(&harness, &server).await);
    assert!(lock(&server.revocation_forms).is_empty());
    assert_eq!(
        records(&removal.owed).await,
        Vec::<ServerAddressDigest>::new()
    );
}
