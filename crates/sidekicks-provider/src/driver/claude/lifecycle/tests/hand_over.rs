//! The hand-over brief's summary, taken through the driver on copies of a resting session.

use serde_json::json;
use sidekicks_contracts::provider::driver::declared_loss::DeclaredLossKind;

use super::session_controls::{
    FULL_MODEL_ID, counts, one_turn_outcome, one_turn_reply, opus_spend,
};
use crate::driver::claude::session::scripted::binding_id;
use crate::driver::claude::session::scripted::driver::{ScriptedDriver, resume_params};
use crate::driver::claude::session::scripted::starts::ScriptedOneTurnRecord;
use crate::driver::claude::session::transport::control::ClaudePermissionMode;
use crate::driver::claude::spawn::launch::one_turn::ClaudeOneTurnReply;
use crate::driver::session_control::{ExportHandoverBriefParams, HandoverSummaryKind};
use crate::driver::test_registry::new_session_id;
use crate::hand_over::brief::HANDOVER_SUMMARY_TEMPLATE;
use crate::port::usage_sink::MeteredUsageOwner;

/// Claude Code's own framing around a summary, as its compaction writes it.
const OPENING: &str = "This session is being continued from a previous conversation that ran \
     out of context. The summary below covers the earlier portion of the conversation.";
const POINTER: &str = "If you need specific details from before compaction (like exact code \
     snippets, error messages, or content you generated), read the full transcript at: \
     /home/person/.claude/projects/work/copy.jsonl";
const CONTINUE: &str = "Continue the conversation from where it left off without asking the \
     user any further questions. Pick up the last task as if the break never happened.";

/// What `/compact` is sent with.
const COMPACT: &str = "/compact list every decision the person made that still holds, each once, \
     with what it applies to and its current value; list withdrawn values under 'Withdrawn, do \
     not use'";

// Killed by a strip removed (the opening, the pointer, the instruction to go on without asking,
// or the compaction's instruction at the end of the quoted message), by an unreadable summary
// returned or refused instead of answered with the template, by a copy that is not a plan-mode
// copy of the stored conversation, and by a copy's rows reduced by the parent's sum instead of
// recorded at the copy's own spend, each as the session's copy.
#[tokio::test(start_paused = true)]
async fn a_hand_over_summary_is_claude_codes_own_unframed_else_the_templates_answer() {
    let fixture = ScriptedDriver::new();
    for _session in 0..2 {
        fixture.starts.script_catalog(json!({"models": [
            {"value": "opus", "displayName": "Opus", "resolvedModel": FULL_MODEL_ID},
        ]}));
    }
    fixture.usage.report_prior(counts(100, 10));
    let summary = "Summary:\n1. Primary Request:\n   - \"Fix the login page.\"";
    let spent = |input, output| Some(opus_spend(&[(input, output)], None));
    let summarized_reply = ClaudeOneTurnReply {
        compaction_summary: Some(format!(
            "{OPENING}\nSummary:\n1. Primary Request:\n   - \"Fix the login page. {COMPACT}\"\n\
             {POINTER}\n{CONTINUE}"
        )),
        ..one_turn_reply("")
    };
    let unreadable_reply = ClaudeOneTurnReply {
        compaction_summary: Some(format!("{OPENING}\n{POINTER}\n{CONTINUE}")),
        ..one_turn_reply("")
    };
    let template_reply = one_turn_reply("1. The goal of this work.");
    for (reply, spend) in [
        (summarized_reply, spent(150, 30)),
        (unreadable_reply, spent(140, 20)),
        (template_reply, spent(170, 40)),
    ] {
        fixture
            .starts
            .script_one_turn(one_turn_outcome(reply, spend));
    }
    let export = |session_id| ExportHandoverBriefParams {
        session_id,
        binding_id: binding_id("lead"),
        resume: resume_params(session_id),
    };
    let summarized = new_session_id();
    let templated = new_session_id();

    let own = fixture
        .driver
        .export_handover_brief(export(summarized))
        .await
        .expect("Claude Code's own summary is taken");
    let template = fixture
        .driver
        .export_handover_brief(export(templated))
        .await
        .expect("the template is answered");

    assert_eq!(own.summary, summary);
    assert_eq!(own.kind, HandoverSummaryKind::ProviderSummary);
    assert_eq!(template.summary, "1. The goal of this work.");
    assert_eq!(template.kind, HandoverSummaryKind::Template);
    assert_eq!(
        template.declared_losses,
        [
            DeclaredLossKind::ProviderPrivateReasoning,
            DeclaredLossKind::ConversationHistorySummarized,
        ]
    );
    let copy = |text: &str| ScriptedOneTurnRecord {
        model: FULL_MODEL_ID.to_owned(),
        resume_handle: Some(resume_params(summarized).resume_handle),
        permission_mode: Some(ClaudePermissionMode::Plan),
        text: text.to_owned(),
    };
    assert_eq!(
        fixture.starts.take_one_turns(),
        [
            copy(COMPACT),
            copy(COMPACT),
            copy(HANDOVER_SUMMARY_TEMPLATE)
        ]
    );
    let metered: Vec<_> = fixture
        .usage
        .metered()
        .into_iter()
        .map(|metered| {
            let axes = metered.delta.axis_deltas;
            let is_copy = metered.owner == MeteredUsageOwner::Session;
            (is_copy, metered.session_id, axes.input, axes.output)
        })
        .collect();
    assert_eq!(
        metered,
        [
            (true, summarized, Some(150), Some(30)),
            (true, templated, Some(140), Some(20)),
            (true, templated, Some(170), Some(40)),
        ]
    );
}
