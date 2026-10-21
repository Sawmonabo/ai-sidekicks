//! The permission check over the approval fixture: rules recorded through answered cards, and
//! provider asks decided in the check's order. The fixture is shared with the permission asks'
//! tests.

use std::sync::Arc;

use futures::FutureExt as _;
use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::approval::{
    ApprovalCategory, ApprovalDecision, ApprovalRequestId, ApprovalResolveRequest,
    RememberedRuleSense, RememberedScopeKind,
};
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::session::id::UserId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::NonEmptyText;
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

use super::{PermissionCheck, PermissionCheckDeps, ProviderAskVerdict};
use crate::approvals::request_create::{ApprovalRequestCreateRequest, ApprovalRequestOrigin};
use crate::approvals::rules::{APPROVAL_RULES_STATEMENT_CAPACITY, ApprovalRules};
use crate::approvals::service::tests::{ApprovalFixture, from_json};
use crate::approvals::store::APPROVAL_REQUEST_READER_STATEMENT_CAPACITY;
use crate::daemon::machine::local::LocalMachine;
use crate::daemon::machine::registry::{MACHINE_REGISTRY_STATEMENT_CAPACITY, MachineRegistry};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::policy::authorizer::Authorizer;
use crate::policy::execution_posture_service::ExecutionPostureService;
use crate::policy::shell_commands::reading_bound::ShellLineReadingBound;
use crate::provider::driver::PROVIDERS;
use crate::provider::port::permission_ask::{
    ProviderAnswerRule, ProviderAskAction, ProviderAskActionKind, ProviderAskRule,
    ProviderPermissionAsk,
};

/// The bound the tests read shell lines under.
pub(crate) const LINE_LIMIT: usize = 4096;

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
    /// The agent-memory folder and the posture files.
    _home: TempDir,
}

impl CheckFixture {
    /// The fixture, its run's holds reaching no engine.
    pub(crate) async fn new() -> Self {
        let approvals = ApprovalFixture::without_holds().await;
        let path = approvals.database.path();
        let shell_lines = Arc::new(ShellLineReadingBound::new(LINE_LIMIT));
        let machine_id =
            MachineId::new(mint_uuid_v7().to_string()).expect("a minted UUID is a machine id");
        let rules = Arc::new(ApprovalRules::new(
            Arc::new(DatabaseReadPool::new(
                path.clone(),
                APPROVAL_RULES_STATEMENT_CAPACITY,
            )),
            Arc::clone(&approvals.events),
            machine_id.clone(),
            Box::new(|_rule| async { Ok(()) }.boxed()),
            Arc::clone(&shell_lines),
        ));
        let home = tempfile::tempdir().expect("a home folder");
        let check = Arc::new(PermissionCheck::new(PermissionCheckDeps {
            reads: Arc::new(DatabaseReadPool::new(
                path.clone(),
                APPROVAL_REQUEST_READER_STATEMENT_CAPACITY,
            )),
            approvals: Arc::clone(&approvals.service),
            rules: Arc::clone(&rules),
            shell_lines: Arc::clone(&shell_lines),
            postures: Arc::new(ExecutionPostureService::new(
                home.path(),
                home.path().join("session-token"),
            )),
            machine: Arc::new(MachineRegistry::new(
                Arc::new(DatabaseReadPool::new(
                    path,
                    MACHINE_REGISTRY_STATEMENT_CAPACITY,
                )),
                Arc::clone(&approvals.writer),
                LocalMachine {
                    machine_id,
                    owner_user_id: UserId::try_from(mint_uuid_v7())
                        .expect("a minted UUID is a user id"),
                    name: "test".to_owned(),
                },
            )),
            authorizer: Arc::new(Authorizer::load_built_in().expect("the built-in rules load")),
            agent_memory_folder: home.path().to_path_buf(),
        }));
        Self {
            approvals,
            rules,
            shell_lines,
            check,
            _home: home,
        }
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
    async fn approve_corrected(&self, corrected: &str) -> ApprovalRequestId {
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
    async fn verdict(&self, ask: &ProviderPermissionAsk) -> String {
        let ask_id: NonEmptyText = from_json(json!(mint_uuid_v7()));
        let verdict = self
            .check
            .check_provider_ask(ask, &ask_id, &CancellationToken::new())
            .await
            .expect("the check decides");
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
// once, an allow only where one may stand, and a line not read whole names no rule. Killed by
// reordering the steps, by a second use of a correction, and by a subject read from a line not
// read whole.
#[rstest]
#[case::background_work(AskCase::BackgroundWorkUnderAllow, &[BACKGROUND_WORK_DENIAL])]
#[case::blocked_host(AskCase::BlockedHost, &["denied: A rule in force on this session blocks this."])]
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
