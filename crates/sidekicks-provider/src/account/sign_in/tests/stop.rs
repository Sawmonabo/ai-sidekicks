//! The daemon's stop ends every sign-in attempt and waits for each to settle.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::StreamExt as _;
use futures::channel::mpsc;
use sidekicks_contracts::provider::account::record::{
    ProviderAccountNotification, ProviderSignInOutcome,
};
use sidekicks_contracts::provider::account::sign_in::{
    NewAccountSignIn, ProviderAccountSignInRequest,
};
use sidekicks_store::database::writer::test_file::TestDatabase;

use super::{
    RecordingPublisher, RecordingWatcher, ScriptedLegs, Status, account_ids, next_notification,
    provider,
};
use crate::account::home_lock::AccountHomeLock;
use crate::account::registry::open_test_registry;
use crate::account::sign_in::ProviderSignInBroker;
use crate::driver::contract::account::{ProviderSignInLegs, SignInOrigin};
use crate::driver::schema::schema_parts;

// The longest the stop waits for the attempts to settle.
const STOP_BOUND: Duration = Duration::from_secs(5);

// A stop during a new account's open flow cancels the flow through the provider's own cancel and
// returns only once the attempt settled canceled with its minted home removed, so no home is left
// with no row. Killed by no stop arm in the flow's wait (the flow never ends and the stop answers
// unsettled) and by the attempt spawned outside the broker's tracked tasks (the stop answers
// before the home is removed).
#[tokio::test]
async fn a_stop_cancels_a_new_accounts_open_flow_and_removes_its_home() {
    let database = TestDatabase::new(schema_parts());
    let data_folder = tempfile::tempdir().expect("a data folder");
    let (registry, _writer) = open_test_registry(&database, data_folder.path()).await;
    let registry = Arc::new(registry);
    let (flow_sender, mut flows) = mpsc::unbounded();
    let legs = Arc::new(ScriptedLegs {
        status: Status::Read {
            is_account_named: true,
        },
        flows: flow_sender,
        homes: Mutex::new(Vec::new()),
        holds_machine_slot: false,
    });
    let (published_sender, mut published) = mpsc::unbounded();
    let broker = ProviderSignInBroker::new(
        Arc::clone(&registry),
        HashMap::from([(provider("claude"), legs as Arc<dyn ProviderSignInLegs>)]),
        Arc::new(RecordingPublisher(published_sender)),
        Arc::new(RecordingWatcher::default()),
        Arc::new(AccountHomeLock::default()),
        Arc::default(),
    );
    broker
        .start(
            ProviderAccountSignInRequest::New(NewAccountSignIn {
                provider: provider("claude"),
            }),
            SignInOrigin::ThisMachine,
        )
        .await
        .expect("the sign-in starts");
    let flow = flows.next().await.expect("the flow starts");
    assert!(flow.home.exists(), "the minted home is made");

    assert!(
        broker.stop(STOP_BOUND).await,
        "the attempt settles within the stop's bound"
    );

    assert!(!flow.home.exists(), "the minted home is removed");
    assert_eq!(account_ids(&registry).await, []);
    let ProviderAccountNotification::SignInCompleted { outcome, .. } =
        next_notification(&mut published).await
    else {
        panic!("the stopped attempt reports its end");
    };
    assert_eq!(outcome, ProviderSignInOutcome::Canceled);
}
