use std::path::Path;

use serde_json::json;
use sidekicks_contracts::provider::driver::declared_loss::DeclaredLossKind;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::AgentRunQueuedPayload;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_store::database::writer::test_file::test_session_id;

use super::{
    BriefCoverage, BriefFrame, BriefFrameParts, BriefHistory, EXCHANGES_HEADING, STEPS_HEADING,
    WorkingDiff, frame_text,
};
use crate::hand_over::canonical_transcript::{
    CanonicalToolResultOutcome, CanonicalToolResultProvenance, CanonicalTranscriptRole,
    CanonicalTranscriptSegment,
};
use crate::hand_over::session_transcript::SessionTranscriptSink as _;

const GOAL: &str = "1. The goal of this work.";

const SUMMARY_LOSSES: [DeclaredLossKind; 2] = [
    DeclaredLossKind::ProviderPrivateReasoning,
    DeclaredLossKind::ConversationHistorySummarized,
];

fn parts(coverage: BriefCoverage, diff: WorkingDiff<'_>) -> BriefFrameParts<'_> {
    BriefFrameParts {
        coverage,
        summary: "1. The goal of this work.\n",
        summary_losses: &SUMMARY_LOSSES,
        branch: "main\n",
        status: "",
        diff,
        transcript_file: Path::new("/data/sessions/s/hand-over-transcript-1.txt"),
    }
}

fn queued(parent_run_id: Option<RunId>) -> AgentRunQueuedPayload {
    let mut payload = json!({
        "sessionId": test_session_id(),
        "runId": RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
        "runVersion": 0,
        "newState": "queued",
        "agentId": mint_uuid_v7().to_string(),
        "admittedProviderAccountId": "account-1",
    });
    if let Some(parent_run_id) = parent_run_id {
        payload["parentRunId"] = json!(parent_run_id);
        payload["reachedBy"] = json!("providerSubagent");
    }
    serde_json::from_value(payload).expect("the run's creation record reads")
}

fn words(position: u64, text: &str) -> CanonicalTranscriptSegment {
    CanonicalTranscriptSegment::Text {
        position,
        text: text.to_owned(),
        is_content_unavailable: false,
        queue_item_id: None,
    }
}

/// Hands `history` one exchange: the person's words, then the agent's call `call` with its
/// result where it names one, then its reply.
fn exchange(history: &mut BriefHistory, number: u64, call: Option<&str>) {
    let position = number * 10;
    history
        .open_turn(CanonicalTranscriptRole::User)
        .expect("the history takes a turn");
    history
        .segment(words(position, &format!("ask {number}")))
        .expect("the history takes a segment");
    history
        .open_turn(CanonicalTranscriptRole::Assistant)
        .expect("the history takes a turn");
    if let Some(call) = call {
        history
            .segment(CanonicalTranscriptSegment::ToolCall {
                position: position + 1,
                tool_call_id: call.to_owned(),
                tool_name: "read".to_owned(),
                arguments_json: format!("{{\"n\":{number}}}"),
                is_content_unavailable: false,
            })
            .expect("the history takes a segment");
        history
            .segment(CanonicalTranscriptSegment::ToolResult {
                position: position + 2,
                tool_call_id: call.to_owned(),
                outcome: CanonicalToolResultOutcome::Succeeded,
                provenance: CanonicalToolResultProvenance::Provider,
                end_cause: None,
                text: format!("output {number}"),
                is_content_unavailable: false,
            })
            .expect("the history takes a segment");
    }
    history
        .segment(words(position + 3, &format!("reply {number}")))
        .expect("the history takes a segment");
}

/// A lead run of four exchanges under `summary`, each with a call but the third, which has one
/// only where `is_third_a_tool_exchange`.
fn four_exchanges(summary: &str, is_third_a_tool_exchange: bool) -> BriefHistory {
    let mut history = BriefHistory::new(summary.to_owned());
    history
        .open_run(1, &queued(None))
        .expect("the history takes a run");
    exchange(&mut history, 1, Some("call-1"));
    exchange(&mut history, 2, Some("call-2"));
    exchange(
        &mut history,
        3,
        is_third_a_tool_exchange.then_some("call-3"),
    );
    exchange(&mut history, 4, Some("call-4"));
    history
}

fn section<'text>(text: &'text str, heading: &str, next_heading: &str) -> &'text str {
    let start = text.find(heading).expect("the section is there") + heading.len();
    let end = text[start..]
        .find(next_heading)
        .map_or(text.len(), |end| start + end);
    &text[start..end]
}

// Killed by a section missing or out of order, by output not placed under its own heading,
// and by the first move's wording on a switch back.
#[test]
fn the_frame_reads_its_five_sections_in_order() {
    let first = parts(
        BriefCoverage::WholeConversation,
        WorkingDiff::AgainstHead {
            stat: "",
            patch: "",
        },
    );
    let text = frame_text(
        &first,
        true,
        &["- read: {} \u{2192} succeeded".to_owned()],
        "### Exchange 1 of 1",
    );
    assert_eq!(
        text,
        "This conversation continues from an earlier part whose record is not in this \
         conversation, so this message stands in for it. Use it to build on the work already \
         done and avoid redoing it.\n\n\
         ## 1. Summary of the earlier part, written at its end\n\n\
         1. The goal of this work.\n\n\
         ## 2. The branch and the changes, read from disk just now\n\n\
         Branch: `main`\n\n\
         `git status --short`:\n\n(clean)\n\n\
         `git diff HEAD`:\n\n(no changes)\n\n\
         ## 3. Every earlier step, one line each, with its output left out\n\n\
         - read: {} \u{2192} succeeded\n\n\
         ## 4. The last two exchanges, word for word\n\n\
         ### Exchange 1 of 1\n\n\
         ## 5. The whole earlier conversation\n\n\
         If you need specific details from the earlier conversation (like exact code \
         snippets, error messages, or content you generated), read its whole transcript, one \
         plain file at `/data/sessions/s/hand-over-transcript-1.txt`, with your file tools."
    );

    let back = frame_text(
        &parts(BriefCoverage::SinceLastTurn, WorkingDiff::NoCommitYet),
        true,
        &[],
        "",
    );
    assert!(back.starts_with(
        "This conversation went on elsewhere since your last turn, and that part's record is \
         not in this conversation, so this message stands in for it."
    ));
    assert!(back.contains("\n\n## 1. Summary of what happened since, written at its end\n\n"));
    assert!(back.contains("\n\n## 5. The whole conversation since your last turn\n\n"));
    assert!(!back.contains("## 1. Summary of the earlier part"));
    assert!(!back.contains("## 5. The whole earlier conversation"));

    let composed = BriefFrame::for_context_window(1_000_000)
        .render(&first, BriefHistory::new(first.summary.to_owned()));
    assert!(
        composed
            .with_persons_message("Go on")
            .ends_with("your file tools.\n\n## The person's message\n\nGo on")
    );
}

// Killed by a diff that never counts against the budget, and by one carried as its counts
// when it fits.
#[test]
fn a_diff_past_the_budget_travels_as_its_counts() {
    let small_patch = "diff --git a/a.rs b/a.rs\n+one line\n";
    let large_patch = format!(
        "diff --git a/a.rs b/a.rs\n{}",
        "+a long line\n".repeat(2_000)
    );
    let stat = " a.rs | 1 +\n 1 file changed, 1 insertion(+)\n";
    let frame = BriefFrame::for_context_window(20_000);

    let small = frame.render(
        &parts(
            BriefCoverage::WholeConversation,
            WorkingDiff::AgainstHead {
                stat,
                patch: small_patch,
            },
        ),
        BriefHistory::new(String::new()),
    );
    let large = frame.render(
        &parts(
            BriefCoverage::WholeConversation,
            WorkingDiff::AgainstHead {
                stat,
                patch: &large_patch,
            },
        ),
        BriefHistory::new(String::new()),
    );

    assert!(
        small
            .text
            .contains(&format!("`git diff HEAD`:\n\n{}", small_patch.trim_end()))
    );
    assert!(!small.text.contains("--stat"));
    assert!(!large.text.contains("+a long line"));
    assert!(large.text.contains(&format!(
        "`git diff HEAD --stat`:\n\n{}\n\nThe whole diff is too long for this message; run \
         `git diff HEAD` in the working folder to read it.",
        stat.trim_end()
    )));
}

// Killed by an output body in a step line, by a call without its result, by a third exchange
// carried, by an eviction that splits an exchange or takes a protected one, and by
// `contextTruncated` declared where nothing was evicted.
#[test]
fn the_steps_leave_outputs_out_and_the_tail_keeps_the_newest_two_exchanges_whole() {
    let parts = parts(
        BriefCoverage::WholeConversation,
        WorkingDiff::AgainstHead {
            stat: "",
            patch: "",
        },
    );
    let roomy =
        BriefFrame::for_context_window(1_000_000).render(&parts, four_exchanges(GOAL, false));
    let steps = section(&roomy.text, STEPS_HEADING, EXCHANGES_HEADING);
    assert_eq!(
        steps.trim(),
        "- read: {\"n\":1} \u{2192} succeeded\n\
         - read: {\"n\":2} \u{2192} succeeded\n\
         - read: {\"n\":4} \u{2192} succeeded"
    );
    let tail = section(&roomy.text, "## 4.", "## 5.");
    assert_eq!(
        tail.trim_start_matches(|c: char| c != '\n').trim(),
        "### Exchange 3 of 4\n\
         **The person:** ask 3\n\
         **The assistant:** reply 3\n\n\
         ### Exchange 4 of 4\n\
         **The person:** ask 4\n\
         **Tool call:** read {\"n\":4} \u{2192} succeeded\n\
         output 4\n\
         **The assistant:** reply 4"
    );
    assert_eq!(
        roomy.declared_losses,
        [
            DeclaredLossKind::ProviderPrivateReasoning,
            DeclaredLossKind::ConversationHistorySummarized,
            DeclaredLossKind::ToolOutputBodies,
        ]
    );

    // The frame alone passes this budget, so only protected exchanges stay.
    let tight = BriefFrame::for_context_window(100);
    let evicted = tight.render(&parts, four_exchanges(GOAL, false));
    let tail = section(&evicted.text, "## 4.", "## 5.");
    assert!(tail.contains("### Exchange 4 of 4\n**The person:** ask 4\n**Tool call:**"));
    assert!(!tail.contains("Exchange 3 of 4"));
    assert!(
        evicted
            .declared_losses
            .contains(&DeclaredLossKind::ContextTruncated)
    );

    let protected = tight.render(&parts, four_exchanges(GOAL, true));
    let tail = section(&protected.text, "## 4.", "## 5.");
    assert!(tail.contains("### Exchange 3 of 4"));
    assert!(tail.contains("### Exchange 4 of 4"));
    assert!(
        !protected
            .declared_losses
            .contains(&DeclaredLossKind::ContextTruncated)
    );
}

// Killed by a helper's call read as a step, and by a loss list written from a rule rather
// than from what was read: no helper, no helper loss; every output in the tail or quoted by
// the summary, no output loss.
#[test]
fn a_helpers_run_is_read_past_and_declared() {
    let parts = parts(
        BriefCoverage::WholeConversation,
        WorkingDiff::AgainstHead {
            stat: "",
            patch: "",
        },
    );
    let frame = BriefFrame::for_context_window(1_000_000);
    let lead = queued(None);
    let mut with_helper = BriefHistory::new("It printed output 1.".to_owned());
    with_helper
        .open_run(1, &lead)
        .expect("the history takes a run");
    exchange(&mut with_helper, 1, Some("call-1"));
    with_helper
        .open_run(2, &queued(Some(lead.run_id())))
        .expect("the history takes a run");
    exchange(&mut with_helper, 2, Some("helper-call"));
    let mut without_helper = BriefHistory::new(String::new());
    without_helper
        .open_run(1, &lead)
        .expect("the history takes a run");
    exchange(&mut without_helper, 1, Some("call-1"));

    let helped = frame.render(&parts, with_helper);
    let alone = frame.render(&parts, without_helper);

    assert!(!helped.text.contains("\"n\":2"));
    assert!(!helped.text.contains("ask 2"));
    assert_eq!(
        helped.declared_losses,
        [
            DeclaredLossKind::ProviderPrivateReasoning,
            DeclaredLossKind::ConversationHistorySummarized,
            DeclaredLossKind::HelperConversations,
        ]
    );
    assert_eq!(alone.declared_losses, SUMMARY_LOSSES);
}
