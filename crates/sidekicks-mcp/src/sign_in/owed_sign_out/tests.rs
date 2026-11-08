use std::sync::{Arc, Mutex};

use axum::http::StatusCode;
use futures::FutureExt as _;
use futures::future::ready;
use rstest::rstest;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_platforms::CredentialStore as PlatformCredentialStore;
use sidekicks_provider::driver::PROVIDER_REGISTRATIONS;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::contract::sign_in::McpServerAddressReading;
use sidekicks_provider::driver::mcp_server::write::McpServerWriteOutcome;
use sidekicks_provider::driver::test_registry::first_provider;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::credential_store::service::KeychainService;
use sidekicks_store::credential_store::test_keychain::test_keychain;
use tempfile::TempDir;
use tokio::sync::Notify;

use super::OwedSignOuts;
use crate::mutation::receipts::tests::idempotency_key;
use crate::mutation::service::removal_sign_out::McpRemovalSignOut as _;
use crate::mutation::service::tests::{ScriptedServer, WriteHook, delete, scripted_driver};
use crate::mutation::service::{McpMutationService, McpMutationSources};
use crate::sign_in::canonical_server_address;
use crate::sign_in::sign_out::tests::{address, received_revocations, signed_in};
use crate::sign_in::target::tests::{
    TestSources, answer_address_read, docs_binding, driver_declaring, remote_declaration,
    test_sources,
};
use crate::sign_in::test_service::{FakeAuthorizationServer, Harness};

/// The owed sign-outs and the mutation service over a test's sources, the service finished over
/// them, with the sources and the receipt key's keychain kept alive beside them.
struct Removal {
    owed: Arc<OwedSignOuts>,
    mutations: McpMutationService,
    _sources: TestSources,
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
        _sources: sources,
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
        .read(&canonical_server_address(&address(server)))
        .await
        .expect("the keychain answers")
        .is_some()
}

/// The owed sign-outs recorded.
async fn records(owed: &OwedSignOuts) -> Vec<String> {
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
    let canonical_address = canonical_server_address(&address(&server));
    let owed_cell: Arc<Mutex<Option<Arc<OwedSignOuts>>>> = Arc::default();
    let (hook_cell, hook_address) = (Arc::clone(&owed_cell), canonical_address.clone());
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
    assert_eq!(records(&removal.owed).await, Vec::<String>::new());
}

// A removal whose sign-out the keychain refuses still lands, its sign-out kept owed, and the next
// settle does it. Killed by the refusal returned from the removal, by the record cleared on a
// refusal, and by a settle that does not read the records.
#[tokio::test]
async fn a_refused_keychain_leaves_the_removal_landed_and_its_sign_out_owed() {
    let (server, harness, _authorizer) = signed_in(StatusCode::OK, None, None).await;
    let canonical_address = canonical_server_address(&address(&server));
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
        .refuse_next_call(KeychainService::McpSignIns.as_str(), &canonical_address);

    let removed = removal
        .mutations
        .delete(delete(&first_provider(), &idempotency_key(), "docs"))
        .await;

    assert!(removed.is_ok(), "the removal lands");
    assert!(is_held(&harness, &server).await);
    assert_eq!(records(&removal.owed).await, [canonical_address]);

    removal.owed.settle_owed_sign_outs().await;

    assert!(!is_held(&harness, &server).await);
    assert_eq!(received_revocations(&server).await.len(), 1);
    assert_eq!(records(&removal.owed).await, Vec::<String>::new());
}

// A settle from outside a removal, as a press's, while the removal's write waits, leaves its
// record and the sign-in; the removal's own settle then signs out. Killed by the in-flight count
// skipped and by the hold dropped before the write: the outside settle, reading the binding still
// declared, clears the record and the item stays.
#[tokio::test]
async fn a_settle_leaves_the_record_of_a_delete_still_in_flight() {
    let (server, harness, _authorizer) = signed_in(StatusCode::OK, None, None).await;
    let canonical_address = canonical_server_address(&address(&server));
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
        assert_eq!(records(&removal.owed).await, [canonical_address.as_str()]);
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
    assert_eq!(records(&removal.owed).await, Vec::<String>::new());
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
    assert_eq!(records(&removal.owed).await, Vec::<String>::new());
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
    assert_eq!(records(&removal.owed).await, Vec::<String>::new());
    removal
        .owed
        .note_declared(&docs_binding(), &moved)
        .await
        .expect("the new address is read again");
    assert_eq!(records(&removal.owed).await, Vec::<String>::new());
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
    assert_eq!(records(&removal.owed).await, Vec::<String>::new());
}
