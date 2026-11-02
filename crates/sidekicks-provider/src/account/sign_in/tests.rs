use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::channel::{mpsc, oneshot};
use futures::future::BoxFuture;
use futures::{FutureExt as _, StreamExt as _};
use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::record::{
    BillingMode, ProviderAccountHealthState, ProviderAccountId, ProviderAccountNotification,
    ProviderAuthMode, ProviderSignInOutcome,
};
use sidekicks_contracts::provider::account::sign_in::{
    NewAccountSignIn, PROVIDER_SIGN_IN_CODE_MAX_LEN, ProviderAccountSignInRequest,
    ProviderSignInCancelStatus, ProviderSignInCodeSubmitStatus, RegisteredAccountSignIn,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::web_address::HttpsAddress;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::test_file::TestDatabase;

use super::{
    AccountsInFlight, AttemptId, ProviderAccountNotificationPublisher, ProviderSignInBroker,
    ProviderSignInError, SignedInAccountWatcher,
};
use crate::account::credential_home::CredentialHome;
use crate::account::home_lock::AccountHomeLock;
use crate::account::registry::tests::register;
use crate::account::registry::{
    AccountAdmission, HealthObservation, ProviderAccountRegistry, RegisteredAccount,
    open_test_registry,
};
use crate::driver::contract::account::{
    ProviderSignInEnd, ProviderSignInHandle, ProviderSignInInput, ProviderSignInLegs,
    ProviderSignInObservation, SignInOrigin,
};
use crate::driver::contract::error::DriverError;
use crate::driver::schema::schema_parts;

mod machine_slot;

/// The provider's own prompt, which only a broker forwarding raw text would let out.
const PROMPT_LINE: &str = "Paste code here if prompted";

/// The code the person pastes.
const CODE: &str = "pasted-code-4e1b";

/// The longest wait for a notification the attempt's task publishes.
const NOTIFICATION_WAIT: Duration = Duration::from_secs(5);

/// How long the test tries for the home before it reads as held.
const HELD_HOME_WAIT: Duration = Duration::from_millis(50);

/// The kind of sign-in the scripted status read reports.
const OBSERVED_AUTH_MODE: ProviderAuthMode = ProviderAuthMode::OauthSubscription;

/// The kind of sign-in a registered account holds before it signs in again.
const EARLIER_AUTH_MODE: ProviderAuthMode = ProviderAuthMode::ApiKey;

type Code = FreeFormText<PROVIDER_SIGN_IN_CODE_MAX_LEN>;

/// One running scripted flow, as the test drives it.
pub(crate) struct ScriptedFlow {
    account_id: ProviderAccountId,
    home: PathBuf,
    prompts: mpsc::UnboundedSender<()>,
    end: Arc<Mutex<Option<oneshot::Sender<ProviderSignInEnd>>>>,
    written: Arc<Mutex<Vec<String>>>,
}

impl ScriptedFlow {
    /// Ends the flow as `end`.
    pub(crate) fn finish(&self, end: ProviderSignInEnd) {
        let sender = lock(&self.end).take().expect("the flow has not ended");
        sender.send(end).expect("the broker awaits the flow's end");
    }

    fn written(&self) -> Vec<String> {
        lock(&self.written).clone()
    }
}

/// The flow's input: codes are recorded, a cancel ends the flow canceled.
struct ScriptedInput {
    end: Arc<Mutex<Option<oneshot::Sender<ProviderSignInEnd>>>>,
    written: Arc<Mutex<Vec<String>>>,
}

impl ProviderSignInInput for ScriptedInput {
    fn write_code(&self, code: Code) -> BoxFuture<'_, Result<(), DriverError>> {
        lock(&self.written).push(code.into_string());
        async { Ok(()) }.boxed()
    }

    fn cancel(&self) -> BoxFuture<'_, Result<ProviderSignInCancelStatus, DriverError>> {
        let status = match lock(&self.end).take() {
            Some(sender) => {
                sender
                    .send(ProviderSignInEnd::Canceled)
                    .expect("the broker awaits the flow's end");
                ProviderSignInCancelStatus::Canceled
            }
            None => ProviderSignInCancelStatus::NotFound,
        };
        async move { Ok(status) }.boxed()
    }
}

/// What the scripted provider does at the start and in its status read after the flow.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Status {
    /// The arm emits nothing to act on.
    Unsupported,
    /// The status read names the account, or not.
    Read { is_account_named: bool },
    /// The status read fails with the provider's raw prompt in its error.
    Unreadable,
}

/// Sign-in legs whose flows the test drives: each flow started goes to `flows`, and the status
/// read after it answers as `status` says.
pub(crate) struct ScriptedLegs {
    /// What the start and the status read do.
    pub(crate) status: Status,
    /// Where each flow started goes.
    pub(crate) flows: mpsc::UnboundedSender<ScriptedFlow>,
    /// Each home a flow started in.
    pub(crate) homes: Mutex<Vec<PathBuf>>,
    /// Whether a sign-in at this machine holds what the machine has only one of.
    pub(crate) holds_machine_slot: bool,
}

impl ProviderSignInLegs for ScriptedLegs {
    fn start_sign_in(
        &self,
        provider_account_id: ProviderAccountId,
        home: CredentialHome,
        _origin: SignInOrigin,
    ) -> BoxFuture<'_, Result<ProviderSignInHandle, DriverError>> {
        lock(&self.homes).push(home.path().to_owned());
        if matches!(self.status, Status::Unsupported) {
            let refusal = DomainError::new(
                "nothing to act on",
                RefusalCode::ProviderAccountSignInUnsupported,
            );
            return async move { Err(DriverError::Refused(Box::new(refusal))) }.boxed();
        }
        let (prompts, code_prompts) = mpsc::unbounded();
        let (end_sender, end) = oneshot::channel();
        let end_sender = Arc::new(Mutex::new(Some(end_sender)));
        let written = Arc::new(Mutex::new(Vec::new()));
        self.flows
            .unbounded_send(ScriptedFlow {
                account_id: provider_account_id,
                home: home.path().to_owned(),
                prompts,
                end: Arc::clone(&end_sender),
                written: Arc::clone(&written),
            })
            .expect("the test holds the flows");
        let handle = ProviderSignInHandle {
            verification_uri: HttpsAddress::new("https://claude.ai/oauth/authorize?code=true")
                .expect("an https address"),
            user_code: None,
            expires_at: None,
            browser_opened_by_provider: false,
            code_prompts: code_prompts.boxed(),
            input: Box::new(ScriptedInput {
                end: end_sender,
                written,
            }),
            completion: async move { end.await.unwrap_or(ProviderSignInEnd::Failed) }.boxed(),
        };
        async move { Ok(handle) }.boxed()
    }

    fn observe_sign_in(
        &self,
        _provider_account_id: ProviderAccountId,
        _home: CredentialHome,
    ) -> BoxFuture<'_, Result<ProviderSignInObservation, DriverError>> {
        let status = self.status;
        async move {
            match status {
                Status::Read { is_account_named } => Ok(ProviderSignInObservation {
                    health: HealthObservation {
                        state: ProviderAccountHealthState::Authenticated,
                        observed_at: WireInstant::now(),
                    },
                    is_account_named,
                    observed_auth_mode: Some(OBSERVED_AUTH_MODE),
                }),
                Status::Unreadable | Status::Unsupported => {
                    Err(DriverError::Internal(PROMPT_LINE.into()))
                }
            }
        }
        .boxed()
    }

    fn is_one_per_machine(&self, origin: SignInOrigin) -> bool {
        self.holds_machine_slot && origin == SignInOrigin::ThisMachine
    }
}

struct RecordingPublisher(mpsc::UnboundedSender<ProviderAccountNotification>);

impl ProviderAccountNotificationPublisher for RecordingPublisher {
    fn publish(&self, notification: ProviderAccountNotification) {
        let printed = serde_json::to_string(&notification).expect("a notification writes");
        assert!(!printed.contains(PROMPT_LINE), "{printed}");
        assert!(!printed.contains(CODE), "{printed}");
        self.0
            .unbounded_send(notification)
            .expect("the test holds the notifications");
    }
}

/// A watcher that records each account it is handed.
#[derive(Default)]
pub(crate) struct RecordingWatcher(Mutex<Vec<ProviderAccountId>>);

impl SignedInAccountWatcher for RecordingWatcher {
    fn watch_signed_in(&self, account: &RegisteredAccount) {
        lock(&self.0).push(account.account_id.clone());
    }
}

async fn next_notification(
    published: &mut mpsc::UnboundedReceiver<ProviderAccountNotification>,
) -> ProviderAccountNotification {
    tokio::time::timeout(NOTIFICATION_WAIT, published.next())
        .await
        .expect("a notification within the wait")
        .expect("the broker holds the publisher")
}

fn session_event_count(database_path: &Path) -> i64 {
    rusqlite::Connection::open(database_path)
        .expect("the test database opens")
        .query_row("SELECT count(*) FROM session_events", [], |row| row.get(0))
        .expect("the session events count")
}

async fn account_ids(registry: &ProviderAccountRegistry) -> Vec<ProviderAccountId> {
    registry
        .list(None)
        .await
        .expect("the accounts read")
        .into_iter()
        .map(|account| account.account_id)
        .collect()
}

// Mints a Claude Code account and admits it signed in with `kind`.
async fn register_with_kind(
    registry: &ProviderAccountRegistry,
    kind: ProviderAuthMode,
) -> RegisteredAccount {
    let minted = registry
        .mint(provider("claude"))
        .expect("the account is minted");
    let admission = AccountAdmission {
        display_label: None,
        billing_mode: BillingMode::Subscription,
        health: Some(HealthObservation {
            state: ProviderAccountHealthState::Authenticated,
            observed_at: WireInstant::now(),
        }),
        observed_auth_mode: Some(kind),
    };
    registry
        .admit(&minted, &admission)
        .await
        .expect("the account is admitted")
}

fn code(text: &str) -> Code {
    Code::new(text.to_owned()).expect("a test code")
}

fn provider(id: &str) -> ProviderId {
    ProviderId::new(id.to_owned()).expect("a test provider id")
}

// The refusal code `error` answers on the wire, and its details.
fn refusal_of(error: ProviderSignInError) -> (RefusalCode, Option<serde_json::Value>) {
    let HandlerError::Refused(refusal) = HandlerError::from(error) else {
        panic!("a sign-in refusal answers a refusal");
    };
    (
        refusal.code,
        refusal
            .detail
            .map(|detail| serde_json::Value::Object(*detail)),
    )
}

// One attempt through each way a sign-in ends: no row while the flow runs, the account's home free
// while the person signs in and after the attempt settles, a code only to the attempt waiting for
// one, a written row published as the account it now is before one settled end, and the registry
// as that end leaves it, a new account and a re-signed registered one with the kind of sign-in its
// status read reported. No published notification carries the prompt or the code, and no session
// event is appended. Killed by a row inserted at the start, by a raw line forwarded as the failure
// text, by a code written before the prompt or twice, by a failed new account keeping its home, by
// the home held across the flow or after it, by a written row not published, and by the reported
// kind not written or an earlier kind kept over it, a registered account's included.
#[rstest]
#[case::new_named(false, Status::Read { is_account_named: true }, ProviderSignInEnd::Finished,
    Some(ProviderSignInOutcome::Succeeded))]
#[case::new_unnamed(false, Status::Read { is_account_named: false }, ProviderSignInEnd::Finished,
    Some(ProviderSignInOutcome::Failed))]
#[case::new_status_unreadable(
    false,
    Status::Unreadable,
    ProviderSignInEnd::Finished,
    Some(ProviderSignInOutcome::Failed)
)]
#[case::new_failed(false, Status::Read { is_account_named: true }, ProviderSignInEnd::Failed,
    Some(ProviderSignInOutcome::Failed))]
#[case::new_expired(false, Status::Read { is_account_named: true }, ProviderSignInEnd::Expired,
    Some(ProviderSignInOutcome::Expired))]
#[case::new_canceled(false, Status::Read { is_account_named: true }, ProviderSignInEnd::Canceled,
    Some(ProviderSignInOutcome::Canceled))]
#[case::new_unsupported(false, Status::Unsupported, ProviderSignInEnd::Failed, None)]
#[case::registered_named(true, Status::Read { is_account_named: true },
    ProviderSignInEnd::Finished, Some(ProviderSignInOutcome::Succeeded))]
#[case::registered_failed(true, Status::Read { is_account_named: true }, ProviderSignInEnd::Failed,
    Some(ProviderSignInOutcome::Failed))]
#[case::registered_canceled(true, Status::Read { is_account_named: true },
    ProviderSignInEnd::Canceled, Some(ProviderSignInOutcome::Canceled))]
#[tokio::test]
async fn one_sign_in_attempt_settles_as_its_end_says(
    #[case] is_registered: bool,
    #[case] status: Status,
    #[case] end: ProviderSignInEnd,
    #[case] expected: Option<ProviderSignInOutcome>,
) {
    let database = TestDatabase::new(schema_parts());
    let data_folder = tempfile::tempdir().expect("a data folder");
    let (registry, _writer) = open_test_registry(&database, data_folder.path()).await;
    let registry = Arc::new(registry);
    let existing = if is_registered {
        Some(register_with_kind(&registry, EARLIER_AUTH_MODE).await)
    } else {
        None
    };
    let existing_ids: Vec<_> = existing.iter().map(|a| a.account_id.clone()).collect();
    let (flow_sender, mut flows) = mpsc::unbounded();
    let legs = Arc::new(ScriptedLegs {
        status,
        flows: flow_sender,
        homes: Mutex::new(Vec::new()),
        holds_machine_slot: false,
    });
    let (published_sender, mut published) = mpsc::unbounded();
    let watcher = Arc::new(RecordingWatcher::default());
    let home_lock = Arc::new(AccountHomeLock::default());
    let accounts_in_flight = Arc::new(AccountsInFlight::default());
    let broker = ProviderSignInBroker::new(
        Arc::clone(&registry),
        HashMap::from([(
            provider("claude"),
            Arc::clone(&legs) as Arc<dyn ProviderSignInLegs>,
        )]),
        Arc::new(RecordingPublisher(published_sender)),
        Arc::clone(&watcher) as Arc<dyn SignedInAccountWatcher>,
        Arc::clone(&home_lock),
        Arc::clone(&accounts_in_flight),
    );
    let events_before = session_event_count(&database.path());
    let request = match &existing {
        Some(account) => ProviderAccountSignInRequest::Registered(RegisteredAccountSignIn {
            account_id: account.account_id.clone(),
        }),
        None => ProviderAccountSignInRequest::New(NewAccountSignIn {
            provider: provider("claude"),
        }),
    };

    let started = broker
        .start(request.clone(), SignInOrigin::AnotherDevice)
        .await;
    let Some(expected) = expected else {
        let error = started.expect_err("an arm with nothing to act on is refused");
        let HandlerError::Refused(refusal) = HandlerError::from(error) else {
            panic!("a refusal");
        };
        assert_eq!(refusal.code, RefusalCode::ProviderAccountSignInUnsupported);
        assert_eq!(account_ids(&registry).await, existing_ids);
        let homes = lock(&legs.homes).clone();
        assert_eq!(homes.len(), 1);
        assert!(!homes[0].exists(), "a refused new account keeps no home");
        return;
    };
    let response = started.expect("the sign-in starts");
    let printed = serde_json::to_string(&response).expect("the reply writes");
    assert!(!printed.contains(PROMPT_LINE), "{printed}");
    let flow = flows.next().await.expect("the flow started");
    let attempt_id = response.attempt_id;
    if let Some(account) = &existing {
        assert_eq!(flow.account_id, account.account_id);
        assert_eq!(flow.home, account.credential_home.path());
    }

    // No row while the flow runs; the minted home is there to sign in to, and is free meanwhile.
    assert_eq!(account_ids(&registry).await, existing_ids);
    assert!(flow.home.is_dir());
    drop(
        tokio::time::timeout(HELD_HOME_WAIT, home_lock.hold(flow.account_id.clone()))
            .await
            .expect("the attempt leaves the account's home free while its flow runs"),
    );
    // A second start on the account is refused naming the open attempt, in the refusal's details.
    if is_registered {
        let refused = broker
            .start(request.clone(), SignInOrigin::ThisMachine)
            .await
            .expect_err("a second start on the account is refused");
        assert!(
            matches!(&refused, ProviderSignInError::AttemptOpen { account_id, attempt_id: open }
                if *account_id == flow.account_id && *open == attempt_id),
            "{refused:?}"
        );
        assert_eq!(
            refusal_of(refused),
            (
                RefusalCode::ProviderAccountSignInInFlight,
                Some(json!({"accountId": flow.account_id, "attemptId": attempt_id}))
            )
        );
    }

    // A code reaches only the attempt that waits for one, once per prompt.
    let unknown = AttemptId::new("0".repeat(32)).expect("an attempt id");
    for id in [&attempt_id, &unknown] {
        let status = broker.submit_code(id, code(CODE)).await.expect("a submit");
        assert_eq!(status, ProviderSignInCodeSubmitStatus::NotFound);
    }
    assert_eq!(flow.written(), Vec::<String>::new());
    flow.prompts
        .unbounded_send(())
        .expect("the attempt reads prompts");
    assert_eq!(
        next_notification(&mut published).await,
        ProviderAccountNotification::SignInCodeRequested {
            attempt_id: attempt_id.clone()
        }
    );
    let submitted = broker.submit_code(&attempt_id, code(CODE)).await;
    assert_eq!(
        submitted.expect("a submit"),
        ProviderSignInCodeSubmitStatus::Submitted
    );
    let again = broker.submit_code(&attempt_id, code("second")).await;
    assert_eq!(
        again.expect("a submit"),
        ProviderSignInCodeSubmitStatus::NotFound
    );
    assert_eq!(flow.written(), vec![CODE.to_owned()]);

    if end == ProviderSignInEnd::Canceled {
        let canceled = broker.cancel(&attempt_id).await.expect("a cancel");
        assert_eq!(canceled, ProviderSignInCancelStatus::Canceled);
    } else {
        flow.finish(end);
    }
    // A row the attempt wrote goes out as the account it now is, before the attempt's end.
    let is_row_written = end == ProviderSignInEnd::Finished
        && matches!(status, Status::Read { is_account_named } if is_account_named || is_registered);
    if is_row_written {
        let ProviderAccountNotification::AccountChanged { account } =
            next_notification(&mut published).await
        else {
            panic!("the written row is published");
        };
        assert_eq!(account.account_id(), &flow.account_id);
    }
    let ProviderAccountNotification::SignInCompleted {
        attempt_id: completed_id,
        account_id,
        outcome,
        failure_reason,
    } = next_notification(&mut published).await
    else {
        panic!("the attempt reports its end");
    };
    assert_eq!(completed_id, attempt_id);
    assert_eq!(account_id, flow.account_id);
    assert_eq!(outcome, expected);
    assert_eq!(
        failure_reason.is_some(),
        outcome == ProviderSignInOutcome::Failed
    );
    // The home is free once the attempt has settled.
    drop(
        tokio::time::timeout(NOTIFICATION_WAIT, home_lock.hold(flow.account_id.clone()))
            .await
            .expect("the settled attempt frees the account's home"),
    );
    // A finished sign-in, new or registered, is observed from then on, and no other end is.
    let watched = lock(&watcher.0).clone();
    if outcome == ProviderSignInOutcome::Succeeded {
        assert_eq!(watched, vec![flow.account_id.clone()]);
    } else {
        assert!(watched.is_empty(), "{watched:?}");
    }

    // The ended attempt takes no code and no cancel.
    let late_cancel = broker.cancel(&attempt_id).await.expect("a cancel");
    assert_eq!(late_cancel, ProviderSignInCancelStatus::NotFound);
    let late_code = broker.submit_code(&attempt_id, code(CODE)).await;
    assert_eq!(
        late_code.expect("a submit"),
        ProviderSignInCodeSubmitStatus::NotFound
    );
    // A switch or a reset holding the account refuses the start with no attempt to name.
    if is_registered {
        let switch = accounts_in_flight
            .begin(flow.account_id.clone())
            .expect("the settled attempt left the account free");
        let refused = broker
            .start(request, SignInOrigin::ThisMachine)
            .await
            .expect_err("a start on an account a switch holds is refused");
        assert!(
            matches!(refused, ProviderSignInError::InFlight),
            "{refused:?}"
        );
        assert_eq!(
            refusal_of(refused),
            (RefusalCode::ProviderAccountSignInInFlight, None)
        );
        drop(switch);
    }

    let accounts = registry.list(None).await.expect("the accounts read");
    match (&existing, outcome) {
        (None, ProviderSignInOutcome::Succeeded) => {
            assert_eq!(accounts.len(), 1);
            assert_eq!(accounts[0].account_id, flow.account_id);
            assert_eq!(accounts[0].billing_mode, BillingMode::Unknown);
            assert_eq!(accounts[0].observed_auth_mode, Some(OBSERVED_AUTH_MODE));
            assert!(flow.home.is_dir(), "an admitted account keeps its home");
        }
        (
            None,
            ProviderSignInOutcome::Failed
            | ProviderSignInOutcome::Expired
            | ProviderSignInOutcome::Canceled,
        ) => {
            assert!(accounts.is_empty(), "{accounts:?}");
            assert!(
                !flow.home.exists(),
                "a new account no sign-in named keeps no home"
            );
        }
        (Some(account), _) => {
            assert_eq!(
                account_ids(&registry).await,
                vec![account.account_id.clone()]
            );
            assert!(flow.home.is_dir(), "a registered account keeps its home");
            // Registered with another kind; a finished re-sign-in replaces it with the kind its
            // read reported, and any other end keeps it.
            let expected_mode = if outcome == ProviderSignInOutcome::Succeeded {
                OBSERVED_AUTH_MODE
            } else {
                EARLIER_AUTH_MODE
            };
            assert_eq!(accounts[0].observed_auth_mode, Some(expected_mode));
        }
    }
    assert_eq!(session_event_count(&database.path()), events_before);
    assert!(published.try_recv().is_err(), "nothing more is published");
}

// A registered account's home reset while its sign-in runs fails the attempt and stores nothing:
// the row stays as the reset left it, nothing is published but the end, and no one is told to
// watch it. The attempt's store waits for the home's hold, and meanwhile a start on the account is
// refused naming the settling attempt, which takes no cancel. Killed by the end stored with no
// compare, by the store taken without the home's hold, by the attempt unlisted at its flow's end
// (the start is refused with no attempt named), and by a settling attempt taking a cancel.
#[tokio::test]
async fn a_sign_in_whose_home_changed_under_it_writes_nothing() {
    let database = TestDatabase::new(schema_parts());
    let data_folder = tempfile::tempdir().expect("a data folder");
    let (registry, _writer) = open_test_registry(&database, data_folder.path()).await;
    let registry = Arc::new(registry);
    let account = register(&registry, "claude").await;
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
    let watcher = Arc::new(RecordingWatcher::default());
    let home_lock = Arc::new(AccountHomeLock::default());
    let broker = ProviderSignInBroker::new(
        Arc::clone(&registry),
        HashMap::from([(provider("claude"), legs as Arc<dyn ProviderSignInLegs>)]),
        Arc::new(RecordingPublisher(published_sender)),
        Arc::clone(&watcher) as Arc<dyn SignedInAccountWatcher>,
        Arc::clone(&home_lock),
        Arc::default(),
    );
    let request = ProviderAccountSignInRequest::Registered(RegisteredAccountSignIn {
        account_id: account.account_id.clone(),
    });
    let started = broker
        .start(request.clone(), SignInOrigin::ThisMachine)
        .await
        .expect("the sign-in starts");
    let flow = flows.next().await.expect("the flow started");

    // A reset holds the home while the flow finishes, so the attempt's store waits behind it.
    let reset_hold = home_lock.hold(account.account_id.clone()).await;
    registry
        .record_home_reset(&account.account_id, &WireInstant::now())
        .await
        .expect("the home is reset");
    let after_reset = registry
        .read(account.account_id.clone())
        .await
        .expect("the account reads");
    flow.finish(ProviderSignInEnd::Finished);
    assert!(
        tokio::time::timeout(HELD_HOME_WAIT, published.next())
            .await
            .is_err(),
        "the attempt's end waits for the home"
    );
    let refused = broker
        .start(request, SignInOrigin::ThisMachine)
        .await
        .expect_err("a start on a settling attempt's account is refused");
    assert!(
        matches!(&refused, ProviderSignInError::AttemptOpen { attempt_id, .. }
            if *attempt_id == started.attempt_id),
        "{refused:?}"
    );
    let settling_cancel = broker.cancel(&started.attempt_id).await;
    assert_eq!(
        settling_cancel.expect("a cancel"),
        ProviderSignInCancelStatus::NotFound
    );
    drop(reset_hold);

    let ProviderAccountNotification::SignInCompleted {
        outcome,
        failure_reason,
        ..
    } = next_notification(&mut published).await
    else {
        panic!("only the attempt's end is published");
    };
    assert_eq!(outcome, ProviderSignInOutcome::Failed);
    assert!(failure_reason.is_some());
    assert_eq!(
        registry
            .read(account.account_id.clone())
            .await
            .expect("the account reads"),
        after_reset
    );
    assert!(lock(&watcher.0).is_empty());
    assert!(published.try_recv().is_err(), "nothing more is published");
}

// A cancel asked while an attempt's flow is still starting answers canceled, and the flow is
// canceled once it has started. Killed by a starting attempt's cancel answering `notFound`, and by
// the cancel never sent to the started flow (its end never comes).
#[tokio::test]
async fn a_cancel_while_the_flow_starts_cancels_it_once_started() {
    let database = TestDatabase::new(schema_parts());
    let data_folder = tempfile::tempdir().expect("a data folder");
    let (registry, _writer) = open_test_registry(&database, data_folder.path()).await;
    let registry = Arc::new(registry);
    let account = register(&registry, "claude").await;
    let (flow_sender, _flows) = mpsc::unbounded();
    let legs = Arc::new(ScriptedLegs {
        status: Status::Read {
            is_account_named: true,
        },
        flows: flow_sender,
        homes: Mutex::new(Vec::new()),
        holds_machine_slot: false,
    });
    let (published_sender, mut published) = mpsc::unbounded();
    let home_lock = Arc::new(AccountHomeLock::default());
    let accounts_in_flight = Arc::new(AccountsInFlight::default());
    let broker = ProviderSignInBroker::new(
        registry,
        HashMap::from([(provider("claude"), legs as Arc<dyn ProviderSignInLegs>)]),
        Arc::new(RecordingPublisher(published_sender)),
        Arc::new(RecordingWatcher::default()),
        Arc::clone(&home_lock),
        Arc::clone(&accounts_in_flight),
    );
    let request = ProviderAccountSignInRequest::Registered(RegisteredAccountSignIn {
        account_id: account.account_id.clone(),
    });
    // The home held keeps the attempt starting until the cancel is asked.
    let home_hold = home_lock.hold(account.account_id.clone()).await;

    let canceled_while_starting = async {
        while !accounts_in_flight.is_in_flight(&account.account_id) {
            tokio::task::yield_now().await;
        }
        let refused = broker
            .start(request.clone(), SignInOrigin::ThisMachine)
            .await
            .expect_err("a start on a starting attempt's account is refused");
        let ProviderSignInError::AttemptOpen { attempt_id, .. } = refused else {
            panic!("the refusal names the starting attempt, not {refused:?}");
        };
        let canceled = broker.cancel(&attempt_id).await.expect("a cancel");
        drop(home_hold);
        (attempt_id, canceled)
    };
    let (started, (attempt_id, canceled)) = tokio::join!(
        broker.start(request.clone(), SignInOrigin::ThisMachine),
        canceled_while_starting
    );

    assert_eq!(canceled, ProviderSignInCancelStatus::Canceled);
    assert_eq!(started.expect("the sign-in starts").attempt_id, attempt_id);
    let ProviderAccountNotification::SignInCompleted { outcome, .. } =
        next_notification(&mut published).await
    else {
        panic!("the canceled attempt reports its end");
    };
    assert_eq!(outcome, ProviderSignInOutcome::Canceled);
}
