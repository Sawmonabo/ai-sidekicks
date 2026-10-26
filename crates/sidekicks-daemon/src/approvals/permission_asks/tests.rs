//! The permission asks over the check's fixture, the run bound to a stand-in driver that records
//! every answer it is handed and fails its first hand where a test says.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use serde_json::json;
use sidekicks_contracts::approval::{
    ApprovalResolveRequest, RememberedRuleSense, RememberedScopeKind,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::mint_uuid_v7;

use super::{CHECK_FAILED_REFUSAL, PermissionAskError, PermissionAsks, PermissionAsksDeps};
use crate::approvals::request_create::{ApprovalRequestCreateRequest, ApprovalRequestOrigin};
use crate::approvals::service::ApprovalServiceError;
use crate::approvals::service::tests::{SETTLE_WAIT, from_json};
use crate::approvals::store::APPROVAL_REQUEST_READER_STATEMENT_CAPACITY;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::mutex_lock::lock;
use crate::policy::permission_check::tests::{CheckFixture, LINE_LIMIT};
use crate::provider::driver::contract::{DriverError, MockProviderDriver, ProviderRequestAnswer};
use crate::provider::driver::test_registry::{
    bind_run_to_first_provider, registry_of_first_providers,
};
use crate::provider::port::permission_ask::{
    ProviderAnswerRule, ProviderAskAction, ProviderAskActionKind, ProviderAskRule,
    ProviderPermissionAnswer, ProviderPermissionAsk, ProviderPermissionAskWithdrawal,
};
use crate::session::run::pause::tests::unanswered;

/// The intake over the check's fixture, and every answer its driver was handed.
pub(crate) struct AsksFixture {
    /// The check's fixture, its run bound to the stand-in driver.
    pub(crate) check: CheckFixture,
    /// The intake under test.
    pub(crate) asks: Arc<PermissionAsks>,
    handed: Arc<Mutex<Vec<ProviderPermissionAnswer>>>,
}

impl AsksFixture {
    /// The fixture, its driver taking every hand.
    pub(crate) async fn new() -> Self {
        Self::build(None).await
    }

    /// The fixture, its driver failing its first hand with `failure`.
    async fn failing_first_hand(failure: fn() -> DriverError) -> Self {
        Self::build(Some(failure)).await
    }

    async fn build(first_hand_failure: Option<fn() -> DriverError>) -> Self {
        let check = CheckFixture::new().await;
        bind_run_to_first_provider(&check.approvals.database, check.approvals.run_id);
        let handed = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&handed);
        let calls = AtomicUsize::new(0);
        let mut driver = MockProviderDriver::new();
        driver.expect_respond_to_request().returning(move |params| {
            let is_first = calls.fetch_add(1, Ordering::SeqCst) == 0;
            let outcome = match first_hand_failure {
                Some(failure) if is_first => Err(failure()),
                Some(_) | None => {
                    if let ProviderRequestAnswer::Permission(answer) = params.response {
                        lock(&recorded).push(answer);
                    }
                    Ok(())
                }
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

    fn git_push(&self) -> ProviderPermissionAsk {
        self.check.ask("ask-1", command("git push"))
    }

    fn withdrawal(&self) -> ProviderPermissionAskWithdrawal {
        ProviderPermissionAskWithdrawal {
            session_id: self.check.approvals.session_id,
            request_id: "ask-1".to_owned(),
        }
    }

    /// Every card's state, oldest first.
    fn card_states(&self) -> Vec<String> {
        self.read_texts("SELECT state FROM approval_requests ORDER BY created_at, id")
    }

    /// The ids of the cards still pending, oldest first.
    pub(crate) fn pending_cards(&self) -> Vec<String> {
        self.read_texts(
            "SELECT id FROM approval_requests WHERE state = 'pending' ORDER BY created_at, id",
        )
    }

    fn read_texts(&self, sql: &str) -> Vec<String> {
        self.check
            .approvals
            .database
            .reader()
            .prepare(sql)
            .expect("the test's read prepares")
            .query_map([], |row| row.get(0))
            .expect("the test reads its rows")
            .collect::<Result<_, _>>()
            .expect("each row reads")
    }

    fn handed(&self) -> Vec<ProviderPermissionAnswer> {
        lock(&self.handed).clone()
    }
}

/// The device every answer in these tests comes from.
pub(crate) fn device() -> DeviceId {
    from_json(json!("device-1"))
}

fn command(line: &str) -> ProviderAskAction {
    ProviderAskAction::Command {
        command: line.to_owned(),
    }
}

fn approval(card: &str) -> ApprovalResolveRequest {
    from_json(json!({
        "decision": "approved",
        "approvalRequestId": card,
        "clientResolutionId": mint_uuid_v7().to_string(),
    }))
}

fn plain_allow() -> ProviderPermissionAnswer {
    ProviderPermissionAnswer::Allow {
        correction: None,
        made_rule: None,
        answered_by_rule: None,
    }
}

// An ask taken back while it is checked raises no card and answers nothing. Killed by checking
// the withdrawal only after the card is raised.
#[tokio::test]
async fn an_ask_taken_back_during_its_check_raises_nothing() {
    let fixture = AsksFixture::new().await;
    // Every line byte is held, so the ask's check waits at its line's read.
    let (holding, held) = tokio::sync::oneshot::channel();
    let (release, released) = std::sync::mpsc::channel::<()>();
    let lines = Arc::clone(&fixture.check.shell_lines);
    let holder = tokio::spawn(async move {
        lines
            .read(LINE_LIMIT, move |_reader| {
                holding.send(()).expect("the test waits for the hold");
                released.recv().expect("the test releases the line bytes");
            })
            .await
    });
    held.await.expect("the holder holds every line byte");
    let asks = Arc::clone(&fixture.asks);
    let ask = fixture.git_push();
    let key = (ask.run_id, ask.request_id.clone());
    let taken = tokio::spawn(async move { asks.take_ask(ask).await });
    tokio::time::timeout(SETTLE_WAIT, async {
        while !fixture.asks.lock_held().contains_key(&key) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the ask is held");
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
    let fixture = AsksFixture::new().await;
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

// A delivery under a held request id that names another action is another ask: the waiting
// card is withdrawn and the new one's raised, and an answer kept for the one held never goes to
// it; a card whose ask is no longer held takes no answer. Killed by replacing a waiting ask
// without withdrawing its card, by answering the new ask from the held one, and by recording an
// answer to a card no ask holds, or by refusing it while leaving the card pending.
#[tokio::test]
async fn another_action_under_a_held_request_id_is_another_ask() {
    let fixture = AsksFixture::new().await;
    let publish = fixture.check.ask("ask-1", command("npm publish"));
    for ask in [fixture.git_push(), publish] {
        fixture.asks.take_ask(ask).await.expect("the ask is taken");
    }
    assert_eq!(fixture.card_states(), ["canceled", "pending"]);
    let [card] = <[String; 1]>::try_from(fixture.pending_cards()).expect("one card waits");
    fixture
        .asks
        .resolve(&approval(&card), device())
        .await
        .expect("the answer is handed");
    fixture
        .asks
        .take_ask(fixture.git_push())
        .await
        .expect("the ask is taken");
    assert_eq!(fixture.card_states(), ["canceled", "approved", "pending"]);
    assert_eq!(fixture.handed(), [plain_allow()]);
    fixture.asks.forget_run(fixture.check.approvals.run_id);
    let [unheld] = <[String; 1]>::try_from(fixture.pending_cards()).expect("one card waits");
    let refused = fixture.asks.resolve(&approval(&unheld), device()).await;
    assert!(matches!(
        refused,
        Err(PermissionAskError::Refused(refusal))
            if refusal.code == RefusalCode::ApprovalRequestCanceled
    ));
    assert_eq!(fixture.card_states(), ["canceled", "approved", "canceled"]);
}

// An ask whose check failed is refused at its provider with the check-failed line, and the
// failure goes back to the driver. Killed by a failed check that answers nothing, and by one
// that swallows its failure.
#[tokio::test]
async fn an_ask_whose_check_failed_is_refused_and_fails() {
    let fixture = AsksFixture::new().await;
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

// A corrected ask the daemon allowed, delivered again once its answer was lost, gets the kept
// answer: it raises no card and asks for no second use of its correction. Killed by letting go
// of a daemon answer before its hand.
#[tokio::test]
async fn a_redelivered_ask_the_daemon_answered_gets_its_answer_again() {
    let fixture = AsksFixture::new().await;
    let card = fixture.check.approve_corrected("git push --dry-run").await;
    let ask = ProviderPermissionAsk {
        correction_of: Some(card),
        ..fixture.check.ask("ask-1", command("git push --dry-run"))
    };
    for _delivery in 0..2 {
        fixture
            .asks
            .take_ask(ask.clone())
            .await
            .expect("the ask is answered");
    }
    assert_eq!(fixture.card_states(), ["approved"]);
    assert_eq!(fixture.handed(), [plain_allow(), plain_allow()]);
}

// An answer whose hand failed before the provider took it is handed again by the client's
// resend, once; a resend after a hand that went through hands nothing; and the provider's own
// redelivery of the ask gets the answer again. Killed by letting go of the ask before its hand,
// by skipping the held ask on a resend, by handing on every resend, and by a redelivery of an
// answered ask that hands nothing.
#[tokio::test]
async fn a_resend_hands_an_answer_only_where_no_hand_reached_the_provider() {
    let fixture = AsksFixture::failing_first_hand(|| {
        DriverError::Internal("the provider's channel is closed".into())
    })
    .await;
    fixture
        .asks
        .take_ask(fixture.git_push())
        .await
        .expect("the ask raises its card");
    let [card] = <[String; 1]>::try_from(fixture.pending_cards()).expect("one card waits");
    let answer = approval(&card);
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
    assert_eq!(fixture.handed(), [plain_allow()]);
    fixture
        .asks
        .take_ask(fixture.git_push())
        .await
        .expect("the redelivery is answered");
    assert_eq!(fixture.handed(), [plain_allow(), plain_allow()]);
}

// A resend that finds its ask still waiting, the first answer's hand stopped at its project rule's
// folder read (the table renamed away stands in for that read failing), hands the stored answer:
// one under the same id with a correction the first never carried is refused and hands nothing,
// and the same answer sent again hands the stored one. Killed by comparing a resend without its
// correction, and by a failed claim that lets go of the held ask, or marks it handed, before the
// folder read.
#[tokio::test]
async fn a_resend_that_finds_its_ask_waiting_hands_the_stored_answer() {
    let fixture = AsksFixture::new().await;
    let approvals = &fixture.check.approvals;
    approvals.execute("UPDATE sessions SET shape = 'project'");
    fixture
        .asks
        .take_ask(fixture.git_push())
        .await
        .expect("the ask raises its card");
    let [card] = <[String; 1]>::try_from(fixture.pending_cards()).expect("one card waits");
    let [subject] = <[String; 1]>::try_from(fixture.read_texts(
        "SELECT json_extract(resource_descriptor, '$.subject') FROM approval_requests",
    ))
    .expect("one card");
    let client_resolution_id = mint_uuid_v7().to_string();
    let project_allow = |edited_action: Option<&str>| -> ApprovalResolveRequest {
        let mut request = json!({
            "decision": "approved",
            "approvalRequestId": card,
            "clientResolutionId": client_resolution_id,
            "rememberedScope": { "kind": "project", "pattern": subject, "sense": "allow" },
        });
        if let Some(edited_action) = edited_action {
            request["editedAction"] = json!(edited_action);
        }
        from_json(request)
    };
    let answer = project_allow(None);
    approvals.execute("ALTER TABLE workspaces RENAME TO workspaces_away");
    assert!(fixture.asks.resolve(&answer, device()).await.is_err());
    approvals.execute("ALTER TABLE workspaces_away RENAME TO workspaces");
    assert_eq!(fixture.card_states(), ["approved"]);
    let refused = fixture
        .asks
        .resolve(&project_allow(Some("git push --dry-run")), device())
        .await;
    assert!(matches!(
        refused,
        Err(PermissionAskError::Service(ApprovalServiceError::Refused(refusal)))
            if refusal.code == RefusalCode::ApprovalAlreadyResolved
    ));
    assert_eq!(fixture.handed(), []);
    fixture
        .asks
        .resolve(&answer, device())
        .await
        .expect("the resend hands the stored answer");
    assert_eq!(
        fixture.handed(),
        [ProviderPermissionAnswer::Allow {
            correction: None,
            made_rule: Some(ProviderAnswerRule {
                rule: ProviderAskRule {
                    kind: RememberedScopeKind::Project,
                    sense: RememberedRuleSense::Allow,
                    action: ProviderAskActionKind::Command,
                    subject,
                },
                project_folders: Vec::new(),
            }),
            answered_by_rule: None,
        }]
    );
}

// A hand that got no answer back may have reached the provider: the client's resend hands
// nothing, and only the provider's own redelivery of the ask gets the kept answer. Killed by
// letting a resend hand after an unanswered hand.
#[tokio::test]
async fn after_an_unanswered_hand_only_the_providers_redelivery_hands_the_answer() {
    let fixture = AsksFixture::failing_first_hand(unanswered).await;
    fixture
        .asks
        .take_ask(fixture.git_push())
        .await
        .expect("the ask raises its card");
    let [card] = <[String; 1]>::try_from(fixture.pending_cards()).expect("one card waits");
    let answer = approval(&card);
    assert!(fixture.asks.resolve(&answer, device()).await.is_err());
    fixture
        .asks
        .resolve(&answer, device())
        .await
        .expect("the resend is answered");
    assert_eq!(fixture.handed(), []);
    fixture
        .asks
        .take_ask(fixture.git_push())
        .await
        .expect("the redelivery is answered");
    assert_eq!(fixture.handed(), [plain_allow()]);
}

// The session rule an answer made on a card the daemon raised itself, whose record failed, is
// recorded from the stored answer when the same answer is sent again; a resend after that record
// leaves the one rule in force; a resend asking for another rule records nothing and is refused;
// and a late resend after the rule was revoked and another card made its own records nothing and
// revokes nothing. Killed by recording a daemon card's rule only when the answer is first
// recorded, by a record that counts the card's own rule as one it replaces, and by a record that
// skips only a rule still in force.
#[tokio::test]
async fn a_resend_records_the_rule_a_daemon_card_failed_to_record() {
    let fixture = AsksFixture::new().await;
    let approvals = &fixture.check.approvals;
    let raise_card = || async {
        approvals
            .service
            .create(
                ApprovalRequestCreateRequest {
                    session_id: approvals.session_id,
                    run_id: approvals.run_id,
                    requested_by: from_json(json!("agent")),
                    category: from_json(json!("toolExecution")),
                    scope: from_json(json!("session_send")),
                    resource_descriptor: from_json(json!({
                        "subject": "session_send",
                        "standingAllowOffered": true,
                        "projectScopeOffered": false,
                        "editable": false,
                        "action": { "kind": "tool", "toolName": "session_send" },
                        "toolName": "session_send",
                    })),
                },
                ApprovalRequestOrigin::default(),
            )
            .await
            .expect("the daemon raises its card")
            .approval_request_id
    };
    let always_allow =
        |card, client_resolution_id: &str, pattern: &str| -> ApprovalResolveRequest {
            from_json(json!({
                "decision": "approved",
                "approvalRequestId": card,
                "clientResolutionId": client_resolution_id,
                "rememberedScope": { "kind": "session", "pattern": pattern, "sense": "allow" },
            }))
        };
    let card = raise_card().await;
    let client_resolution_id = mint_uuid_v7().to_string();
    let answer = always_allow(card, &client_resolution_id, "session_send");
    approvals.refuses_rules.store(true, Ordering::SeqCst);
    assert!(fixture.asks.resolve(&answer, device()).await.is_err());
    approvals.refuses_rules.store(false, Ordering::SeqCst);
    fixture
        .asks
        .resolve(&answer, device())
        .await
        .expect("the resend records the rule");
    fixture
        .asks
        .resolve(&answer, device())
        .await
        .expect("a resend after the record is answered");
    let find_rule = |subject| {
        fixture.check.rules.find_rule(
            approvals.session_id,
            ProviderAskActionKind::Tool,
            subject,
            true,
        )
    };
    assert!(
        find_rule("session_send")
            .await
            .expect("the rules read")
            .is_some()
    );
    let rules_in_force = || async {
        fixture
            .check
            .rules
            .list(approvals.session_id)
            .await
            .expect("the rules list")
            .rules
            .into_iter()
            .map(|rule| rule.rule_id)
            .collect::<Vec<_>>()
    };
    let [first_rule] = <[_; 1]>::try_from(rules_in_force().await).expect("one rule in force");
    let revoked_rules = || {
        fixture.read_texts(
            "SELECT json_extract(payload, '$.ruleId') FROM session_events
              WHERE type = 'approval.rule.revoked' ORDER BY id",
        )
    };
    assert_eq!(revoked_rules(), Vec::<String>::new());
    let other_rule = always_allow(card, &client_resolution_id, "session_spawn");
    let refused = fixture.asks.resolve(&other_rule, device()).await;
    assert!(matches!(
        refused,
        Err(PermissionAskError::Service(ApprovalServiceError::Refused(refusal)))
            if refusal.code == RefusalCode::ApprovalAlreadyResolved
    ));
    assert!(
        find_rule("session_spawn")
            .await
            .expect("the rules read")
            .is_none()
    );
    fixture
        .check
        .rules
        .revoke(first_rule)
        .await
        .expect("the person revokes the rule");
    let second_card = raise_card().await;
    fixture
        .asks
        .resolve(
            &always_allow(second_card, &mint_uuid_v7().to_string(), "session_send"),
            device(),
        )
        .await
        .expect("the second card makes its rule");
    fixture
        .asks
        .resolve(&answer, device())
        .await
        .expect("the late resend is answered");
    let [second_rule] = <[_; 1]>::try_from(rules_in_force().await).expect("one rule in force");
    assert_eq!(second_rule.text().as_str(), second_card.text().as_str());
    assert_eq!(revoked_rules(), [first_rule.text().as_str()]);
}
