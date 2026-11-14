//! The permission check over the approval fixture: rules recorded through answered cards, and
//! provider asks decided in the check's order; a workflow step's actions are tested in
//! `step_actions`. The fixture is shared with the permission asks' tests.

use std::sync::{Arc, Mutex};

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::approval::{
    ApprovalCategory, ApprovalDecision, ApprovalRequestId, ApprovalResolveRequest,
    RememberedRuleSense, RememberedScopeKind,
};
use sidekicks_contracts::provider::tool_call::ToolCallActionKind;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_policy::ask_rule::ProviderAskRule;
use sidekicks_policy::authorizer::Authorizer;
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_provider::callback_tools::host::CallbackToolApprovalOutcome;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::session_control::RevokeRuleParams;
use sidekicks_provider::port::permission_ask::{
    ProviderAnswerRule, ProviderAskAction, ProviderPermissionAsk,
};
use sidekicks_provider::run::posture::ExecutionPostureService;
use sidekicks_std::mutex_lock::lock;
use sidekicks_workflow::runs::step_action::{StepAction, StepActionCheck};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

use super::test_fixture::{TestPermissionCheck, test_permission_check};
use super::{PermissionCheck, PermissionCheckError, ProviderAskVerdict, ToolCallVerdict};
use crate::request_create::{ApprovalRequestCreateRequest, ApprovalRequestOrigin};
use crate::rules::ApprovalRules;
use crate::service::tests::{ApprovalFixture, from_json, held_by_a_live_call};

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
        Self::deciding_by(None).await
    }

    /// The fixture deciding workflow starts by `authorizer`, the built-in rules where `None`.
    pub(crate) async fn deciding_by(authorizer: Option<Authorizer>) -> Self {
        Self::over(ApprovalFixture::without_holds().await, authorizer)
    }

    /// The fixture, its run's holds moving its run.
    pub(crate) async fn moving_its_run() -> Self {
        Self::over(ApprovalFixture::new().await, None)
    }

    fn over(approvals: ApprovalFixture, authorizer: Option<Authorizer>) -> Self {
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
            authorizer,
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
    /// card of a provider ask makes one, or of the daemon's own card where `is_daemon_kept`.
    async fn remember(
        &self,
        action: ProviderAskAction,
        subject: &str,
        sense: RememberedRuleSense,
        is_daemon_kept: bool,
    ) {
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
                    ask_id: (!is_daemon_kept).then(|| from_json(json!(mint_uuid_v7()))),
                    tool_call_id: None,
                    input_digest: None,
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
            .resolve(&request, from_json(json!("device-1")), held_by_a_live_call)
            .await
            .expect("the rule's card is answered");
        let made = ProviderAnswerRule {
            rule: ProviderAskRule {
                kind: RememberedScopeKind::Session,
                sense,
                action: ToolCallActionKind::from(&action),
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
            .resolve(&request, from_json(json!("device-1")), held_by_a_live_call)
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
            ProviderAskVerdict::CardRaised(card) => self.card_words(&card.approval_request_id),
        }
    }

    /// How the check settles a workflow step's `action` at `level`, in words a case compares.
    async fn step_verdict(&self, level: PermissionLevel, action: &StepAction) -> String {
        let verdict = self
            .check
            .check_step_action(self.step_check(level, action))
            .await
            .expect("the check decides");
        match verdict {
            ToolCallVerdict::Settled(CallbackToolApprovalOutcome::Allow { basis }) => {
                format!("allowed by {basis:?}")
            }
            ToolCallVerdict::Settled(CallbackToolApprovalOutcome::Deny { reason, .. }) => {
                format!("denied: {reason}")
            }
            ToolCallVerdict::CardRaised(card) => self.card_words(&card.approval_request_id),
        }
    }

    // The check of a workflow step's `action` at `level` on the fixture's run, asked by the step.
    fn step_check(&self, level: PermissionLevel, action: &StepAction) -> StepActionCheck {
        StepActionCheck {
            session_id: self.approvals.session_id,
            run_id: self.approvals.run_id,
            requested_by: NonEmptyText::new(STEP_ASKER.to_owned()).expect("a step's name"),
            level,
            action: action.clone(),
        }
    }

    // A raised card in words: whether it offers a standing rule.
    fn card_words(&self, card: &ApprovalRequestId) -> String {
        let (_category, _subject, offered) = self.card_offer(card);
        format!("card offering a rule: {offered}")
    }

    // A raised card's category, the words its rule would name, and whether it offers that rule.
    fn card_offer(&self, card: &ApprovalRequestId) -> (String, String, bool) {
        self.approvals
            .database
            .reader()
            .query_row(
                "SELECT category, json_extract(resource_descriptor, '$.subject'),
                        json_extract(resource_descriptor, '$.standingAllowOffered')
                 FROM approval_requests WHERE id = ?1",
                [card.text().as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("the test reads the card")
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
                    false,
                )
                .await;
            vec![fixture.ask("ask-1", command("claude daemon"))]
        }
        AskCase::BlockedHost => {
            let host = ProviderAskAction::Network {
                host: "example.com".to_owned(),
            };
            fixture
                .remember(
                    host.clone(),
                    "example.com",
                    RememberedRuleSense::Allow,
                    false,
                )
                .await;
            fixture
                .remember(
                    host.clone(),
                    "example.com",
                    RememberedRuleSense::Block,
                    false,
                )
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
                .remember(
                    command("git push"),
                    "git push",
                    RememberedRuleSense::Allow,
                    false,
                )
                .await;
            vec![ProviderPermissionAsk {
                is_provider_flagged: true,
                ..fixture.ask("ask-1", command("git push"))
            }]
        }
        AskCase::AllowedByRule => {
            fixture
                .remember(
                    command("git push"),
                    "git push",
                    RememberedRuleSense::Allow,
                    false,
                )
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

// Who asks on a step's card.
const STEP_ASKER: &str = "workflow-step";

mod step_actions {
    //! A workflow step's actions through the permission check: each level's gate, the card a
    //! command or a program raises and the rule it offers, and the daemon's session rules over a
    //! step.

    use std::path::{Path, PathBuf};

    use rstest::rstest;
    use serde_json::json;
    use sidekicks_contracts::approval::{ApprovalResolveRequest, RememberedRuleSense};
    use sidekicks_contracts::mcp::server::{McpApprovalMode, McpServerName, McpToolName};
    use sidekicks_contracts::session::controls::methods::PermissionLevel;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_provider::driver::PROVIDERS;
    use sidekicks_workflow::runs::step_action::StepAction;

    use super::{CheckFixture, STEP_ASKER, command};
    use crate::permission_asks::tests::{AsksFixture, device};
    use crate::permission_check::step_action::{
        ASKING_TOOL_REFUSAL, GIT_FOLDER_REFUSAL, OUTSIDE_CHECKOUT_REFUSAL,
    };
    use crate::permission_check::{BLOCKED_BY_RULE_REFUSAL, ToolCallVerdict};
    use crate::service::tests::from_json;

    // How a step's action settles where the level's table frees it, asks, or refuses it.
    const FREE: &str = "allowed by Policy";
    const CARD: &str = "card offering a rule: true";

    fn file_write(target: &Path) -> StepAction {
        let checkout = PathBuf::from("/work/checkout");
        StepAction::FileWrite {
            target: target.to_path_buf(),
            git_folder: checkout.join(".git"),
            checkout_root: checkout,
        }
    }

    fn mcp_call(server: &str, tool: &str, approval_mode: McpApprovalMode) -> StepAction {
        StepAction::McpCall {
            server: McpServerName::new(server.to_owned()).expect("a short server name"),
            tool: McpToolName::new(tool.to_owned()).expect("a short tool name"),
            approval_mode,
        }
    }

    // The levels in the order each case lists its verdicts.
    const LEVELS: [PermissionLevel; 5] = [
        PermissionLevel::Readonly,
        PermissionLevel::Ask,
        PermissionLevel::Reviewed,
        PermissionLevel::Sandboxed,
        PermissionLevel::Yolo,
    ];

    // A step's file write follows the levels' own table: inside the checkout it asks only at
    // Read-only, outside it asks at Read-only, Ask and Reviewed, is refused at Sandboxed and is
    // free at YOLO, and Sandboxed refuses the repository's hooks and config inside the checkout
    // too. Killed by an inside write at Ask raising a card, by an outside write at Sandboxed
    // allowed, and by the hooks left open at Sandboxed.
    #[rstest]
    #[case::inside("/work/checkout/src/main.rs", [CARD, FREE, FREE, FREE, FREE])]
    #[case::outside("/work/notes.md", [CARD, CARD, CARD, OUTSIDE, FREE])]
    #[case::git_hooks("/work/checkout/.git/hooks/pre-commit", [CARD, FREE, FREE, GIT, FREE])]
    #[case::git_config("/work/checkout/.git/config", [CARD, FREE, FREE, GIT, FREE])]
    #[tokio::test]
    async fn a_steps_file_write_follows_the_levels_table(
        #[case] target: &str,
        #[case] expected: [&str; 5],
    ) {
        let fixture = CheckFixture::new().await;
        let mut verdicts = Vec::new();
        for level in LEVELS {
            verdicts.push(
                fixture
                    .step_verdict(level, &file_write(Path::new(target)))
                    .await,
            );
        }
        let expected: Vec<String> = expected.iter().map(|verdict| step_words(verdict)).collect();
        assert_eq!(verdicts, expected);
    }

    // A step's tool call follows Codex's own decision for the binding's mode, no annotations read:
    // `approve` runs at every level, and every other mode asks at each level but Sandboxed, which
    // refuses it. Killed by `approve` asking, by YOLO never asking, and by Sandboxed running a tool
    // that asks.
    #[rstest]
    #[case::approve(McpApprovalMode::Approve, [FREE, FREE, FREE, FREE, FREE])]
    #[case::prompt(McpApprovalMode::Prompt, [CARD, CARD, CARD, ASKING, CARD])]
    #[case::writes(McpApprovalMode::Writes, [CARD, CARD, CARD, ASKING, CARD])]
    #[case::auto(McpApprovalMode::Auto, [CARD, CARD, CARD, ASKING, CARD])]
    #[tokio::test]
    async fn a_steps_tool_call_follows_its_bindings_approval_mode(
        #[case] approval_mode: McpApprovalMode,
        #[case] expected: [&str; 5],
    ) {
        let fixture = CheckFixture::new().await;
        let mut verdicts = Vec::new();
        for level in LEVELS {
            verdicts.push(
                fixture
                    .step_verdict(level, &mcp_call("docs", "search", approval_mode))
                    .await,
            );
        }
        let expected: Vec<String> = expected.iter().map(|verdict| step_words(verdict)).collect();
        assert_eq!(verdicts, expected);
    }

    // Stand-ins for the refusals a case expects, in the step module's words.
    const OUTSIDE: &str = "outside";
    const GIT: &str = "git";
    const ASKING: &str = "asking";

    fn step_words(verdict: &str) -> String {
        match verdict {
            OUTSIDE => format!("denied: {OUTSIDE_CHECKOUT_REFUSAL}"),
            GIT => format!("denied: {GIT_FOLDER_REFUSAL}"),
            ASKING => format!("denied: {ASKING_TOOL_REFUSAL}"),
            other => other.to_owned(),
        }
    }

    // An "Always allow" on a step's card keeps a session rule the daemon answers the same action
    // with next time, with no card, while a same-named tool on another server still asks, as does a
    // tool whose server and name join to the same words; the card is asked by the step that names
    // itself. Killed by skipping the rule lookup, by a subject that drops the tool's server, by a
    // rule keyed on the joined name alone, and by asking the card as the run's agent.
    #[tokio::test]
    async fn a_session_rule_answers_a_steps_second_identical_action() {
        let fixture = AsksFixture::new().await;
        let check = &fixture.check;
        let write = file_write(Path::new("/work/notes.md"));
        let docs_search = mcp_call("docs", "search", McpApprovalMode::Prompt);
        let joined_left = mcp_call("a__b", "c", McpApprovalMode::Prompt);
        for (action, subject) in [
            (&write, "/work/notes.md"),
            (&docs_search, "mcp__docs__search"),
            (&joined_left, "mcp__a__b__c"),
        ] {
            let card = check
                .check
                .check_step_action(check.step_check(PermissionLevel::Ask, action))
                .await
                .expect("the check decides");
            let ToolCallVerdict::CardRaised(card) = card else {
                panic!("the first {subject} raises its card");
            };
            let requested_by: String = check
                .approvals
                .database
                .reader()
                .query_row(
                    "SELECT requested_by FROM approval_requests WHERE id = ?1",
                    [card.approval_request_id.text().as_str()],
                    |row| row.get(0),
                )
                .expect("the card is stored");
            assert_eq!(requested_by, STEP_ASKER);
            let request: ApprovalResolveRequest = from_json(json!({
                "decision": "approved",
                "approvalRequestId": card.approval_request_id,
                "clientResolutionId": mint_uuid_v7().to_string(),
                "rememberedScope": { "kind": "session", "pattern": subject, "sense": "allow" },
            }));
            fixture
                .asks
                .resolve(&request, device())
                .await
                .expect("the card is answered");
        }
        let mut verdicts = Vec::new();
        for action in [
            &write,
            &docs_search,
            &mcp_call("wiki", "search", McpApprovalMode::Prompt),
            &mcp_call("a", "b__c", McpApprovalMode::Prompt),
            &joined_left,
        ] {
            verdicts.push(check.step_verdict(PermissionLevel::Ask, action).await);
        }
        assert_eq!(
            verdicts,
            [
                "allowed by RememberedRule",
                "allowed by RememberedRule",
                CARD,
                CARD,
                "allowed by RememberedRule",
            ]
        );
    }

    fn command_step(line: &str) -> StepAction {
        StepAction::Command {
            line: line.to_owned(),
            shown_line: line.to_owned(),
        }
    }

    fn code_step(command: &str) -> StepAction {
        StepAction::Code {
            command: command.to_owned(),
        }
    }

    // How a card that offers no rule reads.
    const BARE_CARD: &str = "card offering a rule: false";

    // A command step and a program step ask at Read-only, Ask and Reviewed, since no provider's
    // reviewer sees a step the daemon runs, and run free at Sandboxed and YOLO; a command's card
    // offers the rule its line names, a program's none. Killed by any level's arm wrong, Reviewed's
    // among them, and by a rule offered on a program's launch line.
    #[rstest]
    #[case::command(command_step("cargo test"), [CARD, CARD, CARD, FREE, FREE])]
    #[case::program(code_step("cargo test"), [BARE_CARD, BARE_CARD, BARE_CARD, FREE, FREE])]
    #[tokio::test]
    async fn a_command_or_program_step_asks_at_the_levels_that_ask(
        #[case] action: StepAction,
        #[case] expected: [&str; 5],
    ) {
        let fixture = CheckFixture::new().await;
        let mut verdicts = Vec::new();
        for level in LEVELS {
            verdicts.push(fixture.step_verdict(level, &action).await);
        }
        assert_eq!(verdicts, expected);
    }

    // A command step's card offers a rule only over the one plain command its line names, in the
    // words that command's rule names: never over a line of several commands, a wrapped command,
    // one after an assignment, or a force push, which is destructive git and shows its rule's words
    // with no rule offered; a program's launch line offering none is proven at each level above.
    // Killed by a compound or wrapped subject offered, by the command's subject dropped or replaced
    // by the whole line, and by skipping the line's category.
    #[rstest]
    #[case::plain(command_step("cargo test"), ("toolExecution", "cargo test", true))]
    #[case::with_options(
        command_step("cargo test --release"),
        ("toolExecution", "cargo test", true)
    )]
    #[case::compound(
        command_step("pnpm test && pnpm lint"),
        ("toolExecution", "pnpm test && pnpm lint", false)
    )]
    #[case::wrapped(command_step("sudo cargo test"), ("toolExecution", "sudo cargo test", false))]
    #[case::assignment(
        command_step("FOO=1 cargo test"),
        ("toolExecution", "FOO=1 cargo test", false)
    )]
    #[case::force_push(
        command_step("git push --force"),
        ("destructiveGit", "git push", false)
    )]
    #[tokio::test]
    async fn a_steps_card_offers_a_rule_only_over_one_plain_command(
        #[case] action: StepAction,
        #[case] expected: (&str, &str, bool),
    ) {
        let fixture = CheckFixture::new().await;
        let verdict = fixture
            .check
            .check_step_action(fixture.step_check(PermissionLevel::Ask, &action))
            .await
            .expect("the check decides");
        let ToolCallVerdict::CardRaised(card) = verdict else {
            panic!("the step raises its card");
        };
        let (category, subject, offered) = fixture.card_offer(&card.approval_request_id);
        assert_eq!((category.as_str(), subject.as_str(), offered), expected);
    }

    // A command step whose line starts a provider's background work is refused at every level, a
    // level that runs commands free and a level that asks alike, before any card, in the provider's
    // own words: by a subcommand, by a flag, and by a line a shell string hands on. Killed by
    // skipping the refusal, by refusing only where the level asks, and by raising the card first.
    #[rstest]
    #[case::subcommand("claude agents")]
    #[case::flag("claude --bg x")]
    #[case::shell_string("sh -c 'claude --bg x'")]
    #[tokio::test]
    async fn a_command_step_starting_background_work_is_refused_at_every_level(#[case] line: &str) {
        let fixture = CheckFixture::new().await;
        let refusal = PROVIDERS
            .iter()
            .find_map(|descriptor| descriptor.background_work.as_ref())
            .map(|work| format!("denied: {}", work.refusal))
            .expect("a provider declares background work");
        let mut verdicts = Vec::new();
        for level in LEVELS {
            verdicts.push(fixture.step_verdict(level, &command_step(line)).await);
        }
        assert_eq!(verdicts, vec![refusal; LEVELS.len()]);
    }

    // A command step's card shows its filled, masked line, while its category and the rule it
    // offers are read from the line of value references, so a filled value holding a quote, which
    // the shell only ever reads as one word, cannot change the rule. Killed by the card showing the
    // reference line, by its stored action carrying it, and by reading the filled line for the
    // rule, which reads three commands and offers none.
    #[tokio::test]
    async fn a_command_steps_card_shows_its_filled_line_and_reads_the_rule_from_references() {
        let fixture = CheckFixture::new().await;
        let shown_line = r#"cargo test "x"; rm -rf ~; echo """#;
        let step = StepAction::Command {
            line: r#"cargo test "${SIDEKICKS_VALUE_1}""#.to_owned(),
            shown_line: shown_line.to_owned(),
        };
        let verdict = fixture
            .check
            .check_step_action(fixture.step_check(PermissionLevel::Ask, &step))
            .await
            .expect("the check decides");
        let ToolCallVerdict::CardRaised(card) = verdict else {
            panic!("the step raises its card");
        };
        let (category, subject, offered) = fixture.card_offer(&card.approval_request_id);
        assert_eq!(
            (category.as_str(), subject.as_str(), offered),
            ("toolExecution", "cargo test", true)
        );
        let (scope, command): (String, String) = fixture
            .approvals
            .database
            .reader()
            .query_row(
                "SELECT scope, json_extract(resource_descriptor, '$.action.command')
                 FROM approval_requests WHERE id = ?1",
                [card.approval_request_id.text().as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the test reads the card");
        assert_eq!((scope.as_str(), command.as_str()), (shown_line, shown_line));
    }

    // A session rule the daemon keeps over a command's words answers the step whose line names
    // them: an allow runs it with no card, a block refuses it, and a revoked allow is no longer in
    // force, so the card is raised again. Killed by skipping the rule lookup for a command, by a
    // block answered as an allow, and by a revoked rule read as in force.
    #[tokio::test]
    async fn a_rule_in_force_answers_a_command_step_until_revoked() {
        let fixture = AsksFixture::new().await;
        let check = &fixture.check;
        let step = command_step("cargo test");
        let verdict = check
            .check
            .check_step_action(check.step_check(PermissionLevel::Ask, &step))
            .await
            .expect("the check decides");
        let ToolCallVerdict::CardRaised(card) = verdict else {
            panic!("the first step raises its card");
        };
        let request: ApprovalResolveRequest = from_json(json!({
            "decision": "approved",
            "approvalRequestId": card.approval_request_id,
            "clientResolutionId": mint_uuid_v7().to_string(),
            "rememberedScope": { "kind": "session", "pattern": "cargo test", "sense": "allow" },
        }));
        fixture
            .asks
            .resolve(&request, device())
            .await
            .expect("the card is answered");
        assert_eq!(
            check.step_verdict(PermissionLevel::Ask, &step).await,
            "allowed by RememberedRule"
        );
        let in_force = check
            .rules
            .list(check.approvals.session_id)
            .await
            .expect("the rules read")
            .rules;
        check
            .rules
            .revoke(in_force[0].rule_id)
            .await
            .expect("the rule is revoked");
        assert_eq!(check.step_verdict(PermissionLevel::Ask, &step).await, CARD);

        let blocked = CheckFixture::new().await;
        blocked
            .remember(
                command("cargo test"),
                "cargo test",
                RememberedRuleSense::Block,
                true,
            )
            .await;
        assert_eq!(
            blocked.step_verdict(PermissionLevel::Ask, &step).await,
            format!("denied: {BLOCKED_BY_RULE_REFUSAL}")
        );
    }
}
