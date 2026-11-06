//! The daemon's stop ends every sign-in attempt and waits for each to settle, and a new account's
//! start after the stop mints nothing.

use std::collections::HashMap;
use std::path::Path;
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
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::test_file::TestDatabase;

use super::{
    RecordingPublisher, RecordingWatcher, ScriptedFlow, ScriptedLegs, Status, account_ids,
    next_notification, provider,
};
use crate::account::credential_home::CredentialHome;
use crate::account::credential_home::marks::read_minted_homes;
use crate::account::credential_home::test_legs::RecordedSignOuts;
use crate::account::home_lock::AccountHomeLock;
use crate::account::registry::{ProviderAccountRegistry, open_test_registry};
use crate::account::resolver::credential_home_folders;
use crate::account::sign_in::{ProviderSignInBroker, ProviderSignInError, SignInOrigin};
use crate::driver::contract::account::{ProviderAccountLegs, ProviderSignInLegs};
use crate::driver::schema::schema_parts;

// The longest the stop waits for the attempts to settle.
const STOP_BOUND: Duration = Duration::from_secs(5);

// A broker over `database` with homes under `data_folder`, its flows sent to the receiver, its
// notifications to the other, and its new accounts' sign-outs recorded.
struct StopFixture {
    registry: Arc<ProviderAccountRegistry>,
    legs: Arc<ScriptedLegs>,
    sign_outs: Arc<RecordedSignOuts>,
    broker: ProviderSignInBroker,
    flows: mpsc::UnboundedReceiver<ScriptedFlow>,
    published: mpsc::UnboundedReceiver<ProviderAccountNotification>,
}

async fn stop_fixture(database: &TestDatabase, data_folder: &Path) -> StopFixture {
    let (registry, _writer) = open_test_registry(database, data_folder).await;
    let registry = Arc::new(registry);
    let (flow_sender, flows) = mpsc::unbounded();
    let legs = Arc::new(ScriptedLegs {
        status: Status::Read {
            is_account_named: true,
        },
        flows: flow_sender,
        homes: Mutex::new(Vec::new()),
        holds_machine_slot: false,
    });
    let sign_outs = Arc::new(RecordedSignOuts::default());
    let (published_sender, published) = mpsc::unbounded();
    let broker = ProviderSignInBroker::new(
        Arc::clone(&registry),
        HashMap::from([(
            provider("claude"),
            Arc::clone(&legs) as Arc<dyn ProviderSignInLegs>,
        )]),
        HashMap::from([(
            provider("claude"),
            Arc::clone(&sign_outs) as Arc<dyn ProviderAccountLegs>,
        )]),
        Arc::new(RecordingPublisher(published_sender)),
        Arc::new(RecordingWatcher::default()),
        Arc::new(AccountHomeLock::default()),
        Arc::default(),
    );
    StopFixture {
        registry,
        legs,
        sign_outs,
        broker,
        flows,
        published,
    }
}

fn new_account_start() -> ProviderAccountSignInRequest {
    ProviderAccountSignInRequest::New(NewAccountSignIn {
        provider: provider("claude"),
        arm: None,
    })
}

// A stop during a new account's open flow cancels the flow through the provider's own cancel and
// returns only once the attempt settled canceled with its minted home signed out in its own
// folders and removed, so no home is left with no row and no sign-in is left at the provider.
// Killed by no stop arm in the flow's wait (the flow never ends and the stop answers unsettled),
// by the attempt spawned outside the broker's tracked tasks (the stop answers before the home is
// removed), and by the settle removing the home with no sign-out.
#[tokio::test]
async fn a_stop_cancels_a_new_accounts_open_flow_and_signs_out_and_removes_its_home() {
    let database = TestDatabase::new(schema_parts());
    let data_folder = tempfile::tempdir().expect("a data folder");
    let mut fixture = stop_fixture(&database, data_folder.path()).await;
    fixture
        .broker
        .start(new_account_start(), SignInOrigin::ThisMachine)
        .await
        .expect("the sign-in starts");
    let flow = fixture.flows.next().await.expect("the flow starts");
    assert!(flow.home.exists(), "the minted home is made");

    assert!(
        fixture.broker.stop(STOP_BOUND).await,
        "the attempt settles within the stop's bound"
    );

    assert!(!flow.home.exists(), "the minted home is removed");
    assert_eq!(
        fixture.sign_outs.signed_out(),
        [(
            flow.account_id.clone(),
            credential_home_folders(&provider("claude"), &CredentialHome::at(flow.home.clone())),
        )],
        "the home is signed out in its own folders"
    );
    assert_eq!(account_ids(&fixture.registry).await, []);
    let ProviderAccountNotification::SignInCompleted { outcome, .. } =
        next_notification(&mut fixture.published).await
    else {
        panic!("the stopped attempt reports its end");
    };
    assert_eq!(outcome, ProviderSignInOutcome::Canceled);
}

// A new-account start sent after the stop ends before it mints: it reaches no provider, signs no
// home out, and makes no home or mark. Killed by a start that mints before it checks the stop,
// which makes the folder of homes.
#[tokio::test]
async fn a_stopped_broker_starts_no_flow() {
    let database = TestDatabase::new(schema_parts());
    let data_folder = tempfile::tempdir().expect("a data folder");
    let fixture = stop_fixture(&database, data_folder.path()).await;
    assert!(
        fixture.broker.stop(STOP_BOUND).await,
        "nothing is under way"
    );

    let started = fixture
        .broker
        .start(new_account_start(), SignInOrigin::ThisMachine)
        .await;
    assert!(
        matches!(started, Err(ProviderSignInError::StartEnded)),
        "a start after the stop ends before it mints"
    );

    assert!(lock(&fixture.legs.homes).is_empty(), "no flow starts");
    assert!(
        fixture.sign_outs.signed_out().is_empty(),
        "no home is signed out"
    );
    let homes = data_folder.path().join("accounts");
    let is_home_made = homes
        .try_exists()
        .expect("the folder of homes is looked at");
    assert!(!is_home_made, "no home is minted");
    assert!(
        read_minted_homes(data_folder.path())
            .expect("the marks read")
            .is_empty(),
        "no minted mark is left"
    );
}
