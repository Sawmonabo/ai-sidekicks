//! The permission check over the approval fixture: rules recorded through answered cards, and
//! provider asks decided in the check's order. The fixture is shared with the permission asks'
//! tests.

use std::sync::{Arc, Mutex};

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::approval::{
    ApprovalCategory, ApprovalDecision, ApprovalRequestId, ApprovalResolveRequest,
    RememberedRuleSense, RememberedScopeKind,
};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::NonEmptyText;
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

use super::test_fixture::{TestPermissionCheck, test_permission_check};
use super::{PermissionCheck, PermissionCheckError, ProviderAskVerdict};
use crate::request_create::{ApprovalRequestCreateRequest, ApprovalRequestOrigin};
use crate::rules::ApprovalRules;
use crate::service::tests::{ApprovalFixture, from_json};
use sidekicks_policy::ask_rule::{ProviderAskActionKind, ProviderAskRule};
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::session_control::RevokeRuleParams;
use sidekicks_provider::port::permission_ask::{
    ProviderAnswerRule, ProviderAskAction, ProviderPermissionAsk,
};
use sidekicks_provider::run::posture::ExecutionPostureService;
use sidekicks_std::mutex_lock::lock;

/// The approval fixture with the permission check and the rules over it.
pub(crate) struct CheckFixture {
    /// The session, its run and the approval service.
    pub(crate) approvals: ApprovalFixture,
    /// The rules in force.
    pub(crate) rules: Arc<ApprovalRules>,
    /// The bound every line is read under.
    pub(crate) shell_lines: Arc<ShellLineReadingBound>,
    /// The check under test.
    pub(crate) check: Arc<PermissionCheck>,
    /// Each live run's posture, none until a test sets one.
    pub(crate) postures: Arc<ExecutionPostureService>,
    /// Every rule the rules handed a provider to take out of force, oldest first.
    provider_rule_calls: Arc<Mutex<Vec<RevokeRuleParams>>>,
    /// The agent-memory folder and the posture files.
    _home: TempDir,
}

impl CheckFixture {
    /// The fixture, its run's holds reaching no engine.
    pub(crate) async fn new() -> Self {
        let approvals = ApprovalFixture::without_holds().await;
        let home = tempfile::tempdir().expect("a home folder");
        let TestPermissionCheck {
            rules,
            shell_lines,
            check,
            postures,
            provider_rule_calls,
        } = test_permission_check(
            &approvals.database.path(),
            &approvals.events,
            &approvals.writer,
            &approvals.service,
            home.path(),
        );
        Self {
            approvals,
            rules,
            shell_lines,
            check,
            postures,
            provider_rule_calls,
            _home: home,
        }
    }

    /// Every rule the rules handed a provider to take out of force, oldest first.
    pub(crate) fn provider_rule_calls(&self) -> Vec<RevokeRuleParams> {
        lock(&self.provider_rule_calls).clone()
    }

    /// The provider's ask on the fixture's run for `action`, which keeps session and project rules.
    pub(crate) fn ask(&self, request_id: &str, action: ProviderAskAction) -> ProviderPermissionAsk {
        ProviderPermissionAsk {
            session_id: self.approvals.session_id,
            run_id: self.approvals.run_id,
            request_id: request_id.to_owned(),
            tool_name: "Bash".to_owned(),
            input: json!({}),
            action,
            rule_scopes: vec![RememberedScopeKind::Session, RememberedScopeKind::Project],
            is_provider_flagged: false,
            is_sent_by_level_rule: false,
            tool_call_id: None,
            prompt: None,
            correction_of: None,
        }
    }

    /// Records a session rule of `sense` over `subject` for actions like `action`, as an answered
    /// card of a provider ask makes one.
    async fn remember(&self, action: ProviderAskAction, subject: &str, sense: RememberedRuleSense) {
        let card = self
            .approvals
            .service
            .create(
                ApprovalRequestCreateRequest {
                    session_id: self.approvals.session_id,
                    run_id: self.approvals.run_id,
                    requested_by: from_json(json!("agent")),
                    category: ApprovalCategory::NetworkAccess,
                    scope: from_json(json!(subject)),
                    resource_descriptor: from_json(json!({
                        "subject": subject,
                        "standingAllowOffered": true,
                        "projectScopeOffered": false,
                        "editable": false,
                        "action": action,
                    })),
                },
                ApprovalRequestOrigin {
                    ask_id: Some(from_json(json!(mint_uuid_v7()))),
                    tool_call_id: None,
                },
            )
            .await
            .expect("the rule's card is raised");
        let decision = match sense {
            RememberedRuleSense::Allow => ApprovalDecision::Approved,
            RememberedRuleSense::Block => ApprovalDecision::Rejected,
        };
        let request: ApprovalResolveRequest = from_json(json!({
            "decision": decision,
            "approvalRequestId": card.approval_request_id,
            "clientResolutionId": mint_uuid_v7().to_string(),
            "rememberedScope": { "kind": "session", "pattern": subject, "sense": sense },
        }));
        let resolved = self
            .approvals
            .service
            .resolve(&request, from_json(json!("device-1")))
            .await
            .expect("the rule's card is answered");
        let made = ProviderAnswerRule {
            rule: ProviderAskRule {
                kind: RememberedScopeKind::Session,
                sense,
                action: ProviderAskActionKind::from(&action),
                subject: subject.to_owned(),
            },
            project_folders: Vec::new(),
        };
        self.rules
            .record(&resolved.request, &made)
            .await
            .expect("the rule is recorded");
    }

    /// Approves a card on the run whose command the person corrected to `corrected`.
    pub(crate) async fn approve_corrected(&self, corrected: &str) -> ApprovalRequestId {
        let card = self
            .approvals
            .raise("git push")
            .await
            .expect("the card is raised");
        let request: ApprovalResolveRequest = from_json(json!({
            "decision": "approved",
            "approvalRequestId": card.approval_request_id,
            "clientResolutionId": mint_uuid_v7().to_string(),
            "editedAction": corrected,
        }));
        self.approvals
            .service
            .resolve(&request, from_json(json!("device-1")))
            .await
            .expect("the correction is approved");
        card.approval_request_id
    }

    /// How the check settles `ask`, in words a case compares.
    pub(crate) async fn verdict(&self, ask: &ProviderPermissionAsk) -> String {
        self.verdict_unless_withdrawn(ask, &CancellationToken::new())
            .await
    }

    /// How the check settles `ask` under `withdrawal`, in words a case compares.
    async fn verdict_unless_withdrawn(
        &self,
        ask: &ProviderPermissionAsk,
        withdrawal: &CancellationToken,
    ) -> String {
        let ask_id: NonEmptyText = from_json(json!(mint_uuid_v7()));
        let verdict = match self
            .check
            .check_provider_ask(ask, &ask_id, withdrawal)
            .await
        {
            Ok(verdict) => verdict,
            Err(PermissionCheckError::Withdrawn) => return "withdrawn".to_owned(),
            Err(failure) => panic!("the check failed: {failure}"),
        };
        match verdict {
            ProviderAskVerdict::Allowed => "allowed".to_owned(),
            ProviderAskVerdict::AnsweredByRule(rule) => format!("rule {}", rule.subject),
            ProviderAskVerdict::Denied { refusal } => format!("denied: {refusal}"),
            ProviderAskVerdict::CardRaised(card) => {
                let offered: bool = self
                    .approvals
                    .database
                    .reader()
                    .query_row(
                        "SELECT json_extract(resource_descriptor, '$.standingAllowOffered')
                         FROM approval_requests WHERE id = ?1",
                        [card.approval_request_id.text().as_str()],
                        |row| row.get(0),
                    )
                    .expect("the test reads the card");
                format!("card offering a rule: {offered}")
            }
        }
    }
}

fn command(line: &str) -> ProviderAskAction {
    ProviderAskAction::Command {
        command: line.to_owned(),
    }
}

/// One provider ask the check decides, after the rules and answers its case sets up.
#[derive(Clone, Copy, Debug)]
enum AskCase {
    /// A provider's background work, an allow over it in force.
    BackgroundWorkUnderAllow,
    /// A host a block in force names.
    BlockedHost,
    /// An ask the level's own rule sent.
    SentByLevelRule,
    /// An ask carrying out an approved correction, twice.
    CorrectionTwice,
    /// An ask the provider's own check flagged, an allow over it in force.
    FlaggedUnderAllow,
    /// An ask an allow in force answers.
    AllowedByRule,
    /// A line with an unterminated quote.
    UnterminatedQuote,
}

// Each step answers in its turn: the daemon's own refusal before any rule, a block before
// anything else, the level's own rule before a correction or an allow, one correction spent
// once, an allow only where one may stand, and a line not read whole names no rule. Killed by an
// allow answering before the daemon's own refusal or a block, by dropping any step, by a second
// use of a correction, by an allow standing on a flagged ask, and by a subject read from a line
// not read whole; where the level's own rule stands among the steps is not pinned.
#[rstest]
#[case::background_work(AskCase::BackgroundWorkUnderAllow, &[BACKGROUND_WORK_DENIAL])]
#[case::blocked_host(AskCase::BlockedHost, &[BLOCKED_DENIAL])]
#[case::sent_by_level_rule(AskCase::SentByLevelRule, &["allowed"])]
#[case::correction_twice(AskCase::CorrectionTwice, &["allowed", "card offering a rule: true"])]
#[case::flagged(AskCase::FlaggedUnderAllow, &["card offering a rule: false"])]
#[case::allowed_by_rule(AskCase::AllowedByRule, &["rule git push"])]
#[case::unterminated_quote(AskCase::UnterminatedQuote, &["card offering a rule: false"])]
#[tokio::test]
async fn a_provider_ask_is_answered_by_the_first_step_that_settles_it(
    #[case] case: AskCase,
    #[case] expected: &[&str],
) {
    let fixture = CheckFixture::new().await;
    let asks = match case {
        AskCase::BackgroundWorkUnderAllow => {
            fixture
                .remember(
                    command("claude daemon"),
                    "claude daemon",
                    RememberedRuleSense::Allow,
                )
                .await;
            vec![fixture.ask("ask-1", command("claude daemon"))]
        }
        AskCase::BlockedHost => {
            let host = ProviderAskAction::Network {
                host: "example.com".to_owned(),
            };
            fixture
                .remember(host.clone(), "example.com", RememberedRuleSense::Allow)
                .await;
            fixture
                .remember(host.clone(), "example.com", RememberedRuleSense::Block)
                .await;
            vec![fixture.ask("ask-1", host)]
        }
        AskCase::SentByLevelRule => {
            let ask = ProviderPermissionAsk {
                is_sent_by_level_rule: true,
                ..fixture.ask("ask-1", command("rm -rf build"))
            };
            vec![ask]
        }
        AskCase::CorrectionTwice => {
            let card = fixture.approve_corrected("git push --dry-run").await;
            let ask = ProviderPermissionAsk {
                correction_of: Some(card),
                ..fixture.ask("ask-1", command("git push --dry-run"))
            };
            vec![ask.clone(), ask]
        }
        AskCase::FlaggedUnderAllow => {
            fixture
                .remember(command("git push"), "git push", RememberedRuleSense::Allow)
                .await;
            vec![ProviderPermissionAsk {
                is_provider_flagged: true,
                ..fixture.ask("ask-1", command("git push"))
            }]
        }
        AskCase::AllowedByRule => {
            fixture
                .remember(command("git push"), "git push", RememberedRuleSense::Allow)
                .await;
            vec![fixture.ask("ask-1", command("git push"))]
        }
        AskCase::UnterminatedQuote => {
            vec![fixture.ask("ask-1", command("git push \"unterminated"))]
        }
    };
    let mut verdicts = Vec::new();
    for ask in &asks {
        verdicts.push(fixture.verdict(ask).await);
    }
    // The background-work refusal is the provider's own words, read from its descriptor.
    let background_work_refusal = PROVIDERS
        .iter()
        .find_map(|descriptor| descriptor.background_work.as_ref())
        .map(|work| format!("denied: {}", work.refusal))
        .expect("a provider declares background work");
    let expected: Vec<String> = expected
        .iter()
        .map(|verdict| match *verdict {
            BACKGROUND_WORK_DENIAL => background_work_refusal.clone(),
            other => other.to_owned(),
        })
        .collect();
    assert_eq!(verdicts, expected);
}

// Stands for the refusal of a provider's background work, which its descriptor words.
const BACKGROUND_WORK_DENIAL: &str = "denied: background work";

// How a block in force on the session settles an ask.
const BLOCKED_DENIAL: &str = "denied: A rule in force on this session blocks this.";

// An ask taken back before its correction is carried out spends nothing: it settles withdrawn,
// and the same ask checked again is allowed by the correction. Killed by checking the withdrawal
// only after the correction is spent.
#[tokio::test]
async fn a_withdrawn_ask_leaves_its_correction_unspent() {
    let fixture = CheckFixture::new().await;
    let card = fixture.approve_corrected("git push --dry-run").await;
    let ask = ProviderPermissionAsk {
        correction_of: Some(card),
        ..fixture.ask("ask-1", command("git push --dry-run"))
    };
    let withdrawn = CancellationToken::new();
    withdrawn.cancel();
    assert_eq!(
        fixture.verdict_unless_withdrawn(&ask, &withdrawn).await,
        "withdrawn"
    );
    assert_eq!(fixture.verdict(&ask).await, "allowed");
}
