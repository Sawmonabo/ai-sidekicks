//! A workflow step's actions through the permission check: each level's gate, the card a command
//! or a program raises and the rule it offers, and the daemon's session rules over a step.

use std::path::{Path, PathBuf};

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::approval::{ApprovalResolveRequest, RememberedRuleSense};
use sidekicks_contracts::mcp::server::{McpApprovalMode, McpServerName, McpToolName};
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::wire::id::mint_uuid_v7;
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
// Read-only, outside it asks at Read-only, Ask and Reviewed, is refused at Sandboxed and is free at
// YOLO, and Sandboxed refuses the repository's hooks and config inside the checkout too. Killed by
// an inside write at Ask raising a card, by an outside write at Sandboxed allowed, and by the hooks
// left open at Sandboxed.
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

// An "Always allow" on a step's card keeps a session rule the daemon answers the same action with
// next time, with no card, while a same-named tool on another server still asks, as does a tool
// whose server and name join to the same words; the card is asked by the step that names itself.
// Killed by skipping the rule lookup, by a subject that drops the tool's server, by a rule keyed
// on the joined name alone, and by asking the card as the run's agent.
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
// reviewer sees a step the daemon runs, and run free at Sandboxed and YOLO; a command's card offers
// the rule its line names, a program's none. Killed by any level's arm wrong, Reviewed's among
// them, and by a rule offered on a program's launch line.
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

// A step's card offers a rule only over the one plain command its line names, in the words that
// command's rule names: never over a line of several commands, a wrapped command, one after an
// assignment or a force push, which is destructive git, nor over a program's launch line. Killed
// by a compound or wrapped subject offered, by the command's subject dropped or replaced by the
// whole line, by skipping the line's category, and by a subject derived for a program line.
#[rstest]
#[case::plain(command_step("cargo test"), ("toolExecution", "cargo test", true))]
#[case::with_options(command_step("cargo test --release"), ("toolExecution", "cargo test", true))]
#[case::compound(
    command_step("pnpm test && pnpm lint"),
    ("toolExecution", "pnpm test && pnpm lint", false)
)]
#[case::wrapped(command_step("sudo cargo test"), ("toolExecution", "sudo cargo test", false))]
#[case::assignment(command_step("FOO=1 cargo test"), ("toolExecution", "FOO=1 cargo test", false))]
#[case::force_push(command_step("git push --force"), ("destructiveGit", "git push --force", false))]
#[case::program(code_step("cargo test"), ("toolExecution", "cargo test", false))]
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

// A session rule the daemon keeps over a command's words answers the step whose line names them:
// an allow runs it with no card, a block refuses it, and a revoked allow is no longer in force, so
// the card is raised again. Killed by skipping the rule lookup for a command, by a block answered
// as an allow, and by a revoked rule read as in force.
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
