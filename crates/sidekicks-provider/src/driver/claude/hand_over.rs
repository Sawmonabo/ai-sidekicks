//! The hand-over brief's summary on Claude Code: a one-turn process on a copy of the session's
//! conversation that keeps nothing runs Claude Code's own `/compact` with the decision list's
//! instruction, and the summary it writes travels with Claude Code's own framing taken out. Where
//! no summary can be read, a second copy answers the fixed template instead. The session's own
//! conversation is never touched, and each copy's own spend is recorded on the session's binding.

use sidekicks_contracts::jsonrpc::refusal::RefusalCode;

use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::lifecycle::ClaudeDriver;
use crate::driver::contract::error::DriverError;
use crate::driver::error_causes::provider_failure_refusal;
use crate::driver::session_control::{
    DriverHandoverBriefResult, ExportHandoverBriefParams, HandoverSummaryKind, SideQuestionPurpose,
};
use crate::hand_over::brief::HANDOVER_SUMMARY_TEMPLATE;

/// What the copy is sent: Claude Code's own compaction, asked to add the decision list.
const CLAUDE_HANDOVER_COMPACT_COMMAND: &str = "/compact";

/// The instruction `/compact` carries, which the copy's summary may quote back.
const CLAUDE_HANDOVER_COMPACT_INSTRUCTION: &str = "list every decision the person made that \
     still holds, each once, with what it applies to and its current value; list withdrawn \
     values under 'Withdrawn, do not use'";

/// How Claude Code's summary opens, saying the session is being continued.
const CLAUDE_CONTINUATION_OPENING: &str =
    "This session is being continued from a previous conversation";

/// How Claude Code's summary points at its own session file, the copy's, gone with it.
const CLAUDE_TRANSCRIPT_POINTER: &str = "If you need specific details from before compaction";

/// The words of Claude Code's instruction to continue without asking the person anything.
const CLAUDE_CONTINUE_WITHOUT_ASKING: &str = "without asking the user any further questions";

/// What closes a quote around the person's last message.
const QUOTE_CLOSERS: &[char] = &['"', '\'', '`', '\u{201D}', '\u{2019}', ' ', '\t'];

impl ClaudeDriver {
    /// The session's hand-over summary: Claude Code's own `/compact` summary on a copy of its
    /// conversation, its framing taken out, or where none can be read a second copy's answer to
    /// the fixed template; each copy's own spend recorded on the session's binding. Refused
    /// `provider.unavailable` where the template got no answer; fails as a copy cannot be composed
    /// or its turn fails.
    pub(crate) async fn export_handover_brief(
        &self,
        params: ExportHandoverBriefParams,
    ) -> Result<DriverHandoverBriefResult, DriverError> {
        let parts = self.parts()?;
        let copy = self
            .compose_copy(
                parts,
                params.session_id,
                Some(params.resume),
                SideQuestionPurpose::Person,
            )?
            .await
            .map_err(DriverError::Internal)?;
        // Holds the session awake until the summary is taken.
        let _hold = parts
            .establishment
            .task_services
            .idle_sleep
            .hold_side_question(params.session_id);
        let compacted = parts
            .session_controls
            .run_copy_turn(
                &copy,
                format!("{CLAUDE_HANDOVER_COMPACT_COMMAND} {CLAUDE_HANDOVER_COMPACT_INSTRUCTION}"),
                &params.binding_id,
            )
            .await?;
        if let Some(summary) = compacted
            .compaction_summary
            .as_deref()
            .map(strip_claude_framing)
            .filter(|summary| !summary.is_empty())
        {
            return Ok(DriverHandoverBriefResult::summarized(
                summary,
                HandoverSummaryKind::ProviderSummary,
            ));
        }
        let answered = parts
            .session_controls
            .run_copy_turn(
                &copy,
                HANDOVER_SUMMARY_TEMPLATE.to_owned(),
                &params.binding_id,
            )
            .await?;
        if answered.refusal.is_some() || answered.text.trim().is_empty() {
            return Err(DriverError::from(provider_failure_refusal(
                &DESCRIPTOR.provider_id(),
                "Claude Code gave the hand-over summary no answer",
                RefusalCode::ProviderUnavailable,
                TemplateUnanswered,
            )));
        }
        Ok(DriverHandoverBriefResult::summarized(
            answered.text,
            HandoverSummaryKind::Template,
        ))
    }
}

/// The copy refused the template or answered it with nothing.
#[derive(Debug, thiserror::Error)]
#[error("The copy answered the hand-over template with nothing.")]
struct TemplateUnanswered;

/// `summary` with Claude Code's own framing taken out: its opening saying the session is being
/// continued, its pointer to its own session file, its instruction to continue without asking the
/// person anything, and the compaction's instruction where a quoted line ends with it; trimmed, so
/// a summary of nothing else reads empty.
pub(crate) fn strip_claude_framing(summary: &str) -> String {
    summary
        .lines()
        .filter(|line| {
            let line = line.trim_start();
            !line.starts_with(CLAUDE_CONTINUATION_OPENING)
                && !line.starts_with(CLAUDE_TRANSCRIPT_POINTER)
                && !line.contains(CLAUDE_CONTINUE_WITHOUT_ASKING)
        })
        .map(without_compaction_instruction)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

// `line` without the compaction's instruction where the line, a closing quote aside, ends with
// it, the command before it taken too.
fn without_compaction_instruction(line: &str) -> String {
    let Some(start) = line.rfind(CLAUDE_HANDOVER_COMPACT_INSTRUCTION) else {
        return line.to_owned();
    };
    let rest = &line[start + CLAUDE_HANDOVER_COMPACT_INSTRUCTION.len()..];
    if !rest.trim_matches(QUOTE_CLOSERS).is_empty() {
        return line.to_owned();
    }
    let head = line[..start].trim_end();
    let head = head
        .strip_suffix(CLAUDE_HANDOVER_COMPACT_COMMAND)
        .unwrap_or(head)
        .trim_end();
    format!("{head}{rest}")
}
