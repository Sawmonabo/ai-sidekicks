use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::channel::{mpsc, oneshot};
use futures::future::BoxFuture;
use futures::{FutureExt as _, StreamExt as _};
use rstest::rstest;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::record::{
    BillingMode, ProviderAccountHealthState, ProviderAccountId, ProviderAccountNotification,
    ProviderSignInOutcome,
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
    AttemptId, ProviderAccountNotificationPublisher, ProviderSignInBroker, ProviderSignInError,
};
use crate::account::credential_home::CredentialHome;
use crate::account::registry::tests::{open_registry, register};
use crate::account::registry::{HealthObservation, ProviderAccountRegistry};
use crate::driver::contract::account::{
    ProviderSignInEnd, ProviderSignInHandle, ProviderSignInInput, ProviderSignInLegs,
    ProviderSignInObservation, SignInOrigin,
};
use crate::driver::contract::error::DriverError;
use crate::driver::schema::schema_parts;

/// The provider's own prompt, which only a broker forwarding raw text would let out.
const PROMPT_LINE: &str = "Paste code here if prompted";

/// The code the person pastes.
const CODE: &str = "pasted-code-4e1b";

/// The longest wait for a notification the attempt's task publishes.
const NOTIFICATION_WAIT: Duration = Duration::from_secs(5);

type Code = FreeFormText<PROVIDER_SIGN_IN_CODE_MAX_LEN>;

/// One running scripted flow, as the test drives it.
struct ScriptedFlow {
    account_id: ProviderAccountId,
    home: PathBuf,
    prompts: mpsc::UnboundedSender<()>,
    end: Arc<Mutex<Option<oneshot::Sender<ProviderSignInEnd>>>>,
    written: Arc<Mutex<Vec<String>>>,
}

impl ScriptedFlow {
    fn finish(&self, end: ProviderSignInEnd) {
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

    fn cancel(&self) -> BoxFuture<'_, Result<(), DriverError>> {
        if let Some(sender) = lock(&self.end).take() {
            sender
                .send(ProviderSignInEnd::Canceled)
                .expect("the broker awaits the flow's end");
        }
        async { Ok(()) }.boxed()
    }
}

/// What the scripted provider does at the start and in its status read after the flow.
#[derive(Clone, Copy, Debug)]
enum Status {
    /// The arm emits nothing to act on.
    Unsupported,
    /// The status read names the account, or not.
    Read { is_account_named: bool },
    /// The status read fails with the provider's raw prompt in its error.
    Unreadable,
}

struct ScriptedLegs {
    status: Status,
    flows: mpsc::UnboundedSender<ScriptedFlow>,
    homes: Mutex<Vec<PathBuf>>,
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
                }),
                Status::Unreadable | Status::Unsupported => {
                    Err(DriverError::Internal(PROMPT_LINE.into()))
                }
            }
        }
        .boxed()
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

fn code(text: &str) -> Code {
    Code::new(text.to_owned()).expect("a test code")
}

fn provider(id: &str) -> ProviderId {
    ProviderId::new(id.to_owned()).expect("a test provider id")
}

// One attempt through each row of the sign-in table: no row while the flow runs, a code only to
// the attempt waiting for one, one settled end, and the registry as that end leaves it. No
// published notification carries the prompt or the code, and no session event is appended. Dies
// to a row inserted at the start, to a raw line forwarded as the failure text, to a code written
// before the prompt or twice, and to a failed new account keeping its home.
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
    Some(ProviderSignInOutcome::Failed))]
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
async fn one_sign_in_attempt_settles_as_the_table_says(
    #[case] is_registered: bool,
    #[case] status: Status,
    #[case] end: ProviderSignInEnd,
    #[case] expected: Option<ProviderSignInOutcome>,
) {
    let database = TestDatabase::new(schema_parts());
    let data_folder = tempfile::tempdir().expect("a data folder");
    let (registry, _writer) = open_registry(&database, data_folder.path()).await;
    let registry = Arc::new(registry);
    let existing = if is_registered {
        Some(register(&registry, "claude").await)
    } else {
        None
    };
    let existing_ids: Vec<_> = existing.iter().map(|a| a.account_id.clone()).collect();
    let (flow_sender, mut flows) = mpsc::unbounded();
    let legs = Arc::new(ScriptedLegs {
        status,
        flows: flow_sender,
        homes: Mutex::new(Vec::new()),
    });
    let (published_sender, mut published) = mpsc::unbounded();
    let broker = ProviderSignInBroker::new(
        Arc::clone(&registry),
        HashMap::from([(
            provider("claude"),
            Arc::clone(&legs) as Arc<dyn ProviderSignInLegs>,
        )]),
        Arc::new(RecordingPublisher(published_sender)),
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

    // No row while the flow runs; the minted home is there to sign in to.
    assert_eq!(account_ids(&registry).await, existing_ids);
    assert!(flow.home.is_dir());
    if is_registered {
        assert!(matches!(
            broker.start(request, SignInOrigin::ThisMachine).await,
            Err(ProviderSignInError::InFlight)
        ));
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

    // The ended attempt takes no code and no cancel.
    let late_cancel = broker.cancel(&attempt_id).await.expect("a cancel");
    assert_eq!(late_cancel, ProviderSignInCancelStatus::NotFound);
    let late_code = broker.submit_code(&attempt_id, code(CODE)).await;
    assert_eq!(
        late_code.expect("a submit"),
        ProviderSignInCodeSubmitStatus::NotFound
    );

    let accounts = registry.list(None).await.expect("the accounts read");
    match (&existing, outcome) {
        (None, ProviderSignInOutcome::Succeeded) => {
            assert_eq!(accounts.len(), 1);
            assert_eq!(accounts[0].account_id, flow.account_id);
            assert_eq!(accounts[0].billing_mode, BillingMode::Unknown);
            assert!(flow.home.is_dir(), "an admitted account keeps its home");
        }
        (None, ProviderSignInOutcome::Failed | ProviderSignInOutcome::Canceled) => {
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
        }
    }
    assert_eq!(session_event_count(&database.path()), events_before);
    assert!(published.try_recv().is_err(), "nothing more is published");
}
