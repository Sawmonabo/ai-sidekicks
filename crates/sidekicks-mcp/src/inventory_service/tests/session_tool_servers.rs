use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::ready;
use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::mcp::server::inventory::McpOverrideOrigin;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_workspace::project::records::AttachedProjectRoot;

use super::{DriverAnswer, WAIT_BOUND, docs_binding, open_inventory, reading_of};
use crate::binding::resolver::{McpFirstFill, attached_root_path};
use crate::binding::session_tool_servers::{McpSessionToolServers, McpSessionToolServersError};

/// A first fill whose read fails is recorded as failed, and an opening then reads the provider
/// once itself: where that read lands the opening composes from it, and where it fails too the
/// opening is refused. Killed by the failed fill left unrecorded (the wait never ends), by a
/// failed fill composing from the empty table, and by the opening refusing without its own read.
#[rstest]
#[case::its_read_lands(true)]
#[case::its_read_fails_too(false)]
#[tokio::test]
async fn an_opening_after_a_failed_fill_reads_the_provider_once(#[case] does_read_land: bool) {
    let reads = Arc::new(AtomicUsize::new(0));
    let driver_reads = Arc::clone(&reads);
    let answer: DriverAnswer = Box::new(move |provider, request| {
        let is_fill = driver_reads.fetch_add(1, Ordering::SeqCst) == 0;
        if is_fill || !does_read_land {
            ready(Err(DriverError::Internal(
                "the config could not be read".into(),
            )))
            .boxed()
        } else {
            ready(Ok(reading_of(&provider, &request))).boxed()
        }
    });
    let inventory = open_inventory(answer).await;
    inventory.service.fill_attribution().await;
    let first_fill = tokio::time::timeout(
        WAIT_BOUND,
        inventory
            .attribution
            .wait_for_first_fill(&inventory.provider),
    )
    .await
    .expect("a failed fill ends the wait");
    assert_eq!(first_fill, McpFirstFill::Failed);
    let composer = McpSessionToolServers::new(
        Arc::clone(&inventory.attribution),
        inventory.service.sources.store.clone(),
    );
    composer
        .register_inventory(Arc::clone(&inventory.service))
        .expect("the inventory registers once");

    let composed = tokio::time::timeout(WAIT_BOUND, composer.compose(&inventory.provider, None))
        .await
        .expect("the opening answers");

    assert_eq!(reads.load(Ordering::SeqCst), 2);
    if does_read_land {
        let bindings: Vec<_> = composed
            .expect("the opening composes")
            .into_iter()
            .map(|server| server.binding)
            .collect();
        assert_eq!(bindings, vec![docs_binding(&inventory.provider)]);
    } else {
        assert!(matches!(
            composed,
            Err(McpSessionToolServersError::ProviderUnread(_))
        ));
    }
}

/// The openings that meet one failed fill share one read of the provider: the first to hold the
/// provider's refill reads, and each after it finds the table filled and opens without a read.
/// Killed by the hold removed, where every opening reads.
#[tokio::test]
async fn openings_after_a_failed_fill_share_one_read() {
    const OPENINGS: usize = 4;
    let reads = Arc::new(AtomicUsize::new(0));
    let driver_reads = Arc::clone(&reads);
    let answer: DriverAnswer = Box::new(move |provider, request| {
        if driver_reads.fetch_add(1, Ordering::SeqCst) == 0 {
            return ready(Err(DriverError::Internal(
                "the config could not be read".into(),
            )))
            .boxed();
        }
        // Slow enough that every opening meets the failed fill while this read runs.
        async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            Ok(reading_of(&provider, &request))
        }
        .boxed()
    });
    let inventory = open_inventory(answer).await;
    inventory.service.fill_attribution().await;
    let composer = McpSessionToolServers::new(
        Arc::clone(&inventory.attribution),
        inventory.service.sources.store.clone(),
    );
    composer
        .register_inventory(Arc::clone(&inventory.service))
        .expect("the inventory registers once");

    let opened = tokio::time::timeout(
        WAIT_BOUND,
        futures::future::join_all(
            (0..OPENINGS).map(|_| composer.compose(&inventory.provider, None)),
        ),
    )
    .await
    .expect("the openings answer");

    assert_eq!(reads.load(Ordering::SeqCst), 2);
    for composed in opened {
        let bindings: Vec<_> = composed
            .expect("the opening composes")
            .into_iter()
            .map(|server| server.binding)
            .collect();
        assert_eq!(bindings, vec![docs_binding(&inventory.provider)]);
    }
}

/// After a fill, with no list asked, a server only account B's config file switches off at a root
/// stays out of every session there, one on account A among them: the fill names each stored
/// account for its config file and asks none for its servers. Killed by a fill that names no
/// account (the server joins the session) and by one that asks the accounts' servers.
#[tokio::test]
async fn after_a_fill_a_server_only_one_accounts_file_switches_off_stays_out_of_the_session() {
    let root = AttachedProjectRoot {
        project_id: ProjectId::new(&mint_uuid_v7().to_string()).expect("a project id"),
        repo_mount_id: RepoMountId::new(&mint_uuid_v7().to_string()).expect("a mount id"),
        canonical_root: "/projects/app".into(),
        place: None,
    };
    let switched_off_in = McpOverrideOrigin::Placed(attached_root_path(&root).expect("a path"));
    let inventory = open_inventory(Box::new(move |provider, request| {
        assert!(
            request.provider_account_ids.is_empty(),
            "a fill asks no servers"
        );
        let mut reading = reading_of(&provider, &request);
        let account_ids = &request.config_file_account_ids;
        if account_ids
            .iter()
            .any(|account| account.as_str() == "account-b")
        {
            reading.declarations[0].disabled_in = vec![switched_off_in.clone()];
        }
        ready(Ok(reading)).boxed()
    }))
    .await;
    inventory
        .database
        .reader()
        .execute(
            "INSERT INTO provider_accounts (account_id, provider, credential_home_path,
               billing_mode, created_at, updated_at)
             VALUES ('account-a', ?1, '/accounts/a', 'unknown', '2026-10-01T00:00:00Z',
               '2026-10-01T00:00:00Z'), ('account-b', ?1, '/accounts/b', 'unknown',
               '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')",
            params![inventory.provider.as_str()],
        )
        .expect("the accounts are stored");

    inventory.service.fill_attribution().await;
    let composer = McpSessionToolServers::new(
        Arc::clone(&inventory.attribution),
        inventory.service.sources.store.clone(),
    );
    let composed = composer.compose(&inventory.provider, Some(&root)).await;

    assert_eq!(composed.expect("the session's set composes"), Vec::new());
}
