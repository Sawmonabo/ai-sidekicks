//! The machine's one sign-in slot: held by a sign-in at this machine until it ends, and freed by a
//! start whose flow could not start.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures::channel::mpsc;
use futures::future::BoxFuture;
use futures::{FutureExt as _, StreamExt as _};
use sidekicks_contracts::provider::account::record::{
    ProviderAccountId, ProviderAccountNotification,
};
use sidekicks_contracts::provider::account::sign_in::{
    NewAccountSignIn, ProviderAccountSignInRequest, ProviderSignInCancelStatus,
};
use sidekicks_store::database::writer::test_file::TestDatabase;

use super::{
    RecordingPublisher, RecordingWatcher, ScriptedFlow, ScriptedLegs, Status, next_notification,
    provider,
};
use crate::account::credential_home::CredentialHome;
use crate::account::registry::open_test_registry;
use crate::account::sign_in::{ProviderSignInBroker, ProviderSignInError};
use crate::driver::contract::account::{
    ProviderSignInHandle, ProviderSignInLegs, ProviderSignInObservation, SignInOrigin,
};
use crate::driver::contract::error::DriverError;
use crate::driver::schema::schema_parts;

/// Legs whose first start fails as a flow that could not start, and whose every later start runs
/// as `inner`'s.
struct FirstStartFails {
    inner: ScriptedLegs,
    has_failed: AtomicBool,
}

impl ProviderSignInLegs for FirstStartFails {
    fn start_sign_in(
        &self,
        provider_account_id: ProviderAccountId,
        home: CredentialHome,
        origin: SignInOrigin,
    ) -> BoxFuture<'_, Result<ProviderSignInHandle, DriverError>> {
        if !self.has_failed.swap(true, Ordering::SeqCst) {
            return async { Err(DriverError::Internal("the flow could not start".into())) }.boxed();
        }
        self.inner.start_sign_in(provider_account_id, home, origin)
    }

    fn observe_sign_in(
        &self,
        provider_account_id: ProviderAccountId,
        home: CredentialHome,
    ) -> BoxFuture<'_, Result<ProviderSignInObservation, DriverError>> {
        self.inner.observe_sign_in(provider_account_id, home)
    }

    fn is_one_per_machine(&self, origin: SignInOrigin) -> bool {
        self.inner.is_one_per_machine(origin)
    }
}

// Scripted legs of `codex` whose sign-ins at this machine hold the machine's one slot, each flow
// started going to the answered receiver.
fn machine_slot_legs() -> (ScriptedLegs, mpsc::UnboundedReceiver<ScriptedFlow>) {
    let (flow_sender, flows) = mpsc::unbounded();
    let legs = ScriptedLegs {
        status: Status::Read {
            is_account_named: true,
        },
        flows: flow_sender,
        homes: Mutex::new(Vec::new()),
        holds_machine_slot: true,
    };
    (legs, flows)
}

// A broker over a fresh registry whose one provider, `codex`, signs in through `legs`, with the
// notifications it publishes and the registry's database and data folder, kept for the test.
async fn broker_over(
    legs: Arc<dyn ProviderSignInLegs>,
) -> (
    ProviderSignInBroker,
    mpsc::UnboundedReceiver<ProviderAccountNotification>,
    (TestDatabase, tempfile::TempDir),
) {
    let database = TestDatabase::new(schema_parts());
    let data_folder = tempfile::tempdir().expect("a data folder");
    let (registry, _writer) = open_test_registry(&database, data_folder.path()).await;
    let (published_sender, published) = mpsc::unbounded();
    let broker = ProviderSignInBroker::new(
        Arc::new(registry),
        HashMap::from([(provider("codex"), legs)]),
        Arc::new(RecordingPublisher(published_sender)),
        Arc::new(RecordingWatcher::default()),
        Arc::default(),
        Arc::default(),
    );
    (broker, published, (database, data_folder))
}

fn new_codex_account() -> ProviderAccountSignInRequest {
    ProviderAccountSignInRequest::New(NewAccountSignIn {
        provider: provider("codex"),
    })
}

// While one account's sign-in at this machine holds the machine's one slot, another account's
// start there is refused naming the open attempt before it mints a home, while a start from
// another device runs; the open flow stays cancelable, and once it has ended a start at this
// machine runs. Killed by no slot (the second start runs), by the slot not freed at the flow's
// end (the last start is refused), by the slot checked only after the mint (the homes folder is
// read-only, so the mint fails first), by a refused start's home left behind, and by the slot
// applied to a start from another device.
#[tokio::test]
async fn one_sign_in_at_this_machine_holds_the_machine_s_slot_until_it_ends() {
    let (legs, mut flows) = machine_slot_legs();
    let (broker, mut published, _kept) = broker_over(Arc::new(legs)).await;

    let open = broker
        .start(new_codex_account(), SignInOrigin::ThisMachine)
        .await
        .expect("the first sign-in at this machine starts");
    let open_flow = flows.next().await.expect("the first flow started");
    let homes_folder = open_flow
        .home
        .parent()
        .expect("a home sits in the homes folder");
    let writable = std::fs::metadata(homes_folder)
        .expect("the homes folder's permissions read")
        .permissions();
    let mut read_only = writable.clone();
    read_only.set_readonly(true);
    std::fs::set_permissions(homes_folder, read_only).expect("the homes folder is made read-only");

    let refused = broker
        .start(new_codex_account(), SignInOrigin::ThisMachine)
        .await
        .expect_err("a second sign-in at this machine is refused");
    std::fs::set_permissions(homes_folder, writable).expect("the homes folder is writable again");
    assert!(
        matches!(&refused, ProviderSignInError::AttemptOpen { account_id, attempt_id }
            if *account_id == open_flow.account_id && *attempt_id == open.attempt_id),
        "{refused:?}"
    );
    let homes: Vec<PathBuf> = std::fs::read_dir(homes_folder)
        .expect("the homes folder reads")
        .map(|entry| entry.expect("a home entry reads").path())
        .collect();
    assert_eq!(
        homes,
        vec![open_flow.home.clone()],
        "the refused start's home is removed"
    );

    broker
        .start(new_codex_account(), SignInOrigin::AnotherDevice)
        .await
        .expect("a sign-in from another device starts while the slot is held");
    flows.next().await.expect("the other device's flow started");

    let canceled = broker.cancel(&open.attempt_id).await.expect("a cancel");
    assert_eq!(canceled, ProviderSignInCancelStatus::Canceled);
    let ProviderAccountNotification::SignInCompleted { attempt_id, .. } =
        next_notification(&mut published).await
    else {
        panic!("the canceled attempt reports its end");
    };
    assert_eq!(attempt_id, open.attempt_id);

    broker
        .start(new_codex_account(), SignInOrigin::ThisMachine)
        .await
        .expect("a sign-in at this machine starts once the open one has ended");
}

// A start at this machine whose flow could not start frees the machine's slot. Killed by a failed
// start's attempt left listed, which refuses the next start at this machine.
#[tokio::test]
async fn a_failed_start_at_this_machine_frees_the_machine_s_slot() {
    let (inner, mut flows) = machine_slot_legs();
    let legs = FirstStartFails {
        inner,
        has_failed: AtomicBool::new(false),
    };
    let (broker, _published, _kept) = broker_over(Arc::new(legs)).await;

    broker
        .start(new_codex_account(), SignInOrigin::ThisMachine)
        .await
        .expect_err("the first flow could not start");
    broker
        .start(new_codex_account(), SignInOrigin::ThisMachine)
        .await
        .expect("the next sign-in at this machine starts");
    flows.next().await.expect("the next flow started");
}
