//! The permission asks over the check's fixture, the run bound to a stand-in driver that records
//! every answer it is handed and fails the first hands a test says.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use futures::FutureExt as _;
use serde_json::json;
use sidekicks_contracts::approval::ApprovalResolveRequest;
use sidekicks_contracts::wire::id::mint_uuid_v7;

use super::{CHECK_FAILED_REFUSAL, PermissionAsks, PermissionAsksDeps};
use crate::approvals::service::tests::{SETTLE_WAIT, from_json};
use crate::approvals::store::APPROVAL_REQUEST_READER_STATEMENT_CAPACITY;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::policy::permission_check::tests::{CheckFixture, LINE_LIMIT};
use crate::provider::driver::contract::{DriverError, MockProviderDriver, ProviderRequestAnswer};
use crate::provider::driver::test_registry::{
    bind_run_to_first_provider, registry_of_first_providers,
};
use crate::provider::port::permission_ask::{
    ProviderAskAction, ProviderPermissionAnswer, ProviderPermissionAskWithdrawal,
};

/// The intake over the check's fixture, and every answer its driver was handed.
struct AsksFixture {
    check: CheckFixture,
    asks: Arc<PermissionAsks>,
    handed: Arc<Mutex<Vec<ProviderPermissionAnswer>>>,
}

impl AsksFixture {
    /// The fixture, its driver failing its first `failing_hands` hands before the provider takes
    /// them.
    async fn new(failing_hands: usize) -> Self {
        let check = CheckFixture::new().await;
        bind_run_to_first_provider(&check.approvals.database, check.approvals.run_id);
        let handed = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&handed);
        let calls = AtomicUsize::new(0);
        let mut driver = MockProviderDriver::new();
        driver.expect_respond_to_request().returning(move |params| {
            let outcome = if calls.fetch_add(1, Ordering::SeqCst) < failing_hands {
                Err(DriverError::Internal(
                    "the provider's channel is closed".into(),
                ))
            } else {
                if let ProviderRequestAnswer::Permission(answer) = params.response {
                    recorded
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .push(answer);
                }
                Ok(())
            };
            async move { outcome }.boxed()
        });
        let asks = Arc::new(PermissionAsks::new(PermissionAsksDeps {
            reads: Arc::new(DatabaseReadPool::new(
                check.approvals.database.path(),
                APPROVAL_REQUEST_READER_STATEMENT_CAPACITY,
            )),
            approvals: Arc::clone(&check.approvals.service),
            check: Arc::clone(&check.check),
            rules: Arc::clone(&check.rules),
            providers: Arc::new(registry_of_first_providers(vec![Arc::new(driver)])),
        }));
        Self {
            check,
            asks,
            handed,
        }
    }

    fn git_push(&self) -> crate::provider::port::permission_ask::ProviderPermissionAsk {
        self.check.ask(
            "ask-1",
            ProviderAskAction::Command {
                command: "git push".to_owned(),
            },
        )
    }

    fn withdrawal(&self) -> ProviderPermissionAskWithdrawal {
        ProviderPermissionAskWithdrawal {
            session_id: self.check.approvals.session_id,
            request_id: "ask-1".to_owned(),
        }
    }

    /// Every card's state, oldest first.
    fn card_states(&self) -> Vec<String> {
        self.check
            .approvals
            .database
            .reader()
            .prepare("SELECT state FROM approval_requests ORDER BY created_at, id")
            .expect("the test's read prepares")
            .query_map([], |row| row.get(0))
            .expect("the test reads the cards")
            .collect::<Result<_, _>>()
            .expect("each card reads")
    }

    fn handed(&self) -> Vec<ProviderPermissionAnswer> {
        self.handed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

// An ask taken back while it is checked raises no card and answers nothing. Killed by checking
// the withdrawal only after the card is raised.
#[tokio::test]
async fn an_ask_taken_back_during_its_check_raises_nothing() {
    let fixture = AsksFixture::new(0).await;
    // Every line byte is held, so the ask's check waits at its line's read.
    let (release, released) = std::sync::mpsc::channel::<()>();
    let lines = Arc::clone(&fixture.check.shell_lines);
    let holder = tokio::spawn(async move {
        lines
            .read(LINE_LIMIT, move |_reader| {
                released.recv().expect("the test releases the line bytes");
            })
            .await
    });
    tokio::task::yield_now().await;
    let asks = Arc::clone(&fixture.asks);
    let ask = fixture.git_push();
    let taken = tokio::spawn(async move { asks.take_ask(ask).await });
    tokio::task::yield_now().await;
    fixture
        .asks
        .withdraw_ask(fixture.withdrawal())
        .await
        .expect("the withdrawal settles");
    release.send(()).expect("the holder waits");
    holder
        .await
        .expect("the holder ends")
        .expect("the holder's read runs");
    tokio::time::timeout(SETTLE_WAIT, taken)
        .await
        .expect("the ask settles")
        .expect("the ask's task ends")
        .expect("a withdrawn ask is no failure");
    assert_eq!(fixture.card_states(), Vec::<String>::new());
    assert_eq!(fixture.handed(), []);
}

// A second delivery of an ask still waiting raises no second card, and a withdrawal once the card
// stands cancels it. Killed by a held map that does not hold the ask, and by a withdrawal that
// lets go of the ask without canceling its card.
#[tokio::test]
async fn a_held_ask_raises_one_card_which_its_withdrawal_cancels() {
    let fixture = AsksFixture::new(0).await;
    for _delivery in 0..2 {
        fixture
            .asks
            .take_ask(fixture.git_push())
            .await
            .expect("the ask is taken");
    }
    assert_eq!(fixture.card_states(), ["pending"]);
    fixture
        .asks
        .withdraw_ask(fixture.withdrawal())
        .await
        .expect("the withdrawal settles");
    assert_eq!(fixture.card_states(), ["canceled"]);
    assert_eq!(fixture.handed(), []);
}

// An ask whose check failed is refused at its provider with the check-failed line, and the
// failure goes back to the driver. Killed by a failed check that answers nothing, and by one
// that swallows its failure.
#[tokio::test]
async fn an_ask_whose_check_failed_is_refused_and_fails() {
    let fixture = AsksFixture::new(0).await;
    fixture
        .check
        .approvals
        .execute("UPDATE sessions SET state = 'closed'");
    let failed = fixture.asks.take_ask(fixture.git_push()).await;
    assert!(failed.is_err());
    assert_eq!(
        fixture.handed(),
        [ProviderPermissionAnswer::Refuse {
            reason: Some(CHECK_FAILED_REFUSAL.to_owned()),
            made_rule: None,
        }]
    );
}

// An answer whose hand failed before the provider took it is handed again by the client's
// resend, once, and a resend after a hand that went through hands nothing. Killed by letting go
// of the ask before its hand, by skipping the held ask on a resend, and by handing on every
// resend.
#[tokio::test]
async fn a_resend_hands_an_answer_only_where_no_hand_reached_the_provider() {
    let fixture = AsksFixture::new(1).await;
    fixture
        .asks
        .take_ask(fixture.git_push())
        .await
        .expect("the ask raises its card");
    let card: String = fixture
        .check
        .approvals
        .database
        .reader()
        .query_row("SELECT id FROM approval_requests", [], |row| row.get(0))
        .expect("the test reads the card");
    let answer: ApprovalResolveRequest = from_json(json!({
        "decision": "approved",
        "approvalRequestId": card,
        "clientResolutionId": mint_uuid_v7().to_string(),
    }));
    let device = || from_json(json!("device-1"));
    assert!(fixture.asks.resolve(&answer, device()).await.is_err());
    assert_eq!(fixture.handed(), []);
    fixture
        .asks
        .resolve(&answer, device())
        .await
        .expect("the resend hands the answer");
    fixture
        .asks
        .resolve(&answer, device())
        .await
        .expect("a resend after the hand is answered");
    assert_eq!(
        fixture.handed(),
        [ProviderPermissionAnswer::Allow {
            correction: None,
            made_rule: None,
            answered_by_rule: None,
        }]
    );
}
