//! A sign-in on an account registered with a pasted key or token, refused before anything starts.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures::StreamExt as _;
use futures::channel::mpsc;
use rstest::rstest;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::record::ProviderAuthMode;
use sidekicks_contracts::provider::account::sign_in::{
    ProviderAccountSignInRequest, ProviderSignInArm, RegisteredAccountSignIn,
};
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::test_file::TestDatabase;

use super::{
    RecordingPublisher, RecordingWatcher, ScriptedLegs, Status, provider, refusal_of,
    register_with_kind,
};
use crate::account::registry::open_test_registry;
use crate::account::registry::tests::register;
use crate::account::sign_in::{
    AccountsInFlight, ProviderSignInBroker, ProviderSignInError, SignInOrigin,
};
use crate::driver::contract::account::ProviderSignInLegs;
use crate::driver::schema::schema_parts;

// A sign-in on an account with a pasted key or token is refused unsupported on either arm before
// anything is reserved or started: refused so even while a switch holds the account, no flow
// starts, and no attempt is left open, so another account's browser sign-in, which holds the
// machine's one slot, starts. Killed by the check after the reservation (the start is refused as
// in flight) and by only the browser arm refused.
#[rstest]
#[case::api_key_browser(ProviderAuthMode::ApiKey, ProviderSignInArm::Browser)]
#[case::api_key_device_code(ProviderAuthMode::ApiKey, ProviderSignInArm::DeviceCode)]
#[case::token_browser(ProviderAuthMode::OauthToken, ProviderSignInArm::Browser)]
#[case::token_device_code(ProviderAuthMode::OauthToken, ProviderSignInArm::DeviceCode)]
#[tokio::test]
async fn a_sign_in_on_a_pasted_credential_account_is_refused_before_anything_starts(
    #[case] kind: ProviderAuthMode,
    #[case] arm: ProviderSignInArm,
) {
    let database = TestDatabase::new(schema_parts());
    let data_folder = tempfile::tempdir().expect("a data folder");
    let (registry, _writer) = open_test_registry(&database, data_folder.path()).await;
    let registry = Arc::new(registry);
    let pasted = register_with_kind(&registry, kind).await;
    let signed_in = register(&registry, "claude").await;
    let (flow_sender, mut flows) = mpsc::unbounded();
    let legs = Arc::new(ScriptedLegs {
        status: Status::Read {
            is_account_named: true,
        },
        flows: flow_sender,
        homes: Mutex::new(Vec::new()),
        holds_machine_slot: true,
    });
    let (published_sender, _published) = mpsc::unbounded();
    let accounts_in_flight = Arc::new(AccountsInFlight::default());
    let broker = ProviderSignInBroker::new(
        Arc::clone(&registry),
        HashMap::from([(
            provider("claude"),
            Arc::clone(&legs) as Arc<dyn ProviderSignInLegs>,
        )]),
        HashMap::new(),
        Arc::new(RecordingPublisher(published_sender)),
        Arc::new(RecordingWatcher::default()),
        Arc::default(),
        Arc::clone(&accounts_in_flight),
    );
    let switch = accounts_in_flight
        .begin(pasted.account_id.clone())
        .expect("the pasted account is free");

    let refused = broker
        .start(
            ProviderAccountSignInRequest::Registered(RegisteredAccountSignIn {
                account_id: pasted.account_id.clone(),
                arm: Some(arm),
            }),
            SignInOrigin::ThisMachine,
        )
        .await
        .expect_err("a sign-in on a pasted-credential account is refused");
    drop(switch);

    assert!(
        matches!(refused, ProviderSignInError::PastedCredential),
        "{refused:?}"
    );
    assert_eq!(
        refusal_of(refused),
        (RefusalCode::ProviderAccountSignInUnsupported, None)
    );
    assert!(lock(&legs.homes).is_empty(), "no flow started");
    broker
        .start(
            ProviderAccountSignInRequest::Registered(RegisteredAccountSignIn {
                account_id: signed_in.account_id.clone(),
                arm: Some(ProviderSignInArm::Browser),
            }),
            SignInOrigin::ThisMachine,
        )
        .await
        .expect("another account's browser sign-in starts");
    flows.next().await.expect("its flow started");
}
