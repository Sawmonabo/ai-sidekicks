//! The hand-over brief's frame: the one message a new provider takes in place of a conversation it
//! cannot continue, five sections around the old provider's stripped summary, and the record of
//! the session's steps and newest exchanges it is composed from. It reads only its arguments,
//! never a clock, store, file or process.
//!
//! - The diff counts against the brief's budget; past it, section 2 carries the diff's per-file
//!   counts and says where the whole diff is.
//! - What did not carry is read off the composed brief: a tool's output is lost only when neither
//!   the word-for-word tail nor the summary carries it.

use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::path::Path;

use sidekicks_contracts::provider::driver::declared_loss::DeclaredLossKind;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::AgentRunQueuedPayload;
use sidekicks_contracts::session::id::SessionId;

use crate::hand_over::brief::projection::{
    BriefBudgetPolicy, BriefProjection, WORD_FOR_WORD_EXCHANGE_COUNT, one_line_arguments,
    partition_into_exchanges, tool_call_ending,
};
use crate::hand_over::canonical_transcript::{
    CanonicalTranscriptProjection, CanonicalTranscriptRole, CanonicalTranscriptSegment,
    CanonicalTranscriptTurn,
};
use crate::hand_over::session_transcript::SessionTranscriptSink;
use crate::hand_over::transform_pipeline::{order_declared_losses, segment_content_is_unavailable};

/// The brief's first line on a move to a provider the session has not run on.
const OPENING_LINE: &str = "This conversation continues from an earlier part whose record is not \
in this conversation, so this message stands in for it. Use it to build on the work already done \
and avoid redoing it.";

/// The brief's first line on a move back to a provider the session ran on.
const SWITCH_BACK_OPENING_LINE: &str = "This conversation went on elsewhere since your last turn, \
and that part's record is not in this conversation, so this message stands in for it. Use it to \
build on the work already done and avoid redoing it.";

/// Section 1's heading on a move to a provider the session has not run on.
const SUMMARY_HEADING: &str = "## 1. Summary of the earlier part, written at its end";

/// Section 1's heading on a move back.
const SWITCH_BACK_SUMMARY_HEADING: &str =
    "## 1. Summary of what happened since, written at its end";

/// Section 2's heading.
const CHANGES_HEADING: &str = "## 2. The branch and the changes, read from disk just now";

/// Section 3's heading.
const STEPS_HEADING: &str = "## 3. Every earlier step, one line each, with its output left out";

/// Section 4's heading, which names [`WORD_FOR_WORD_EXCHANGE_COUNT`] in words.
const EXCHANGES_HEADING: &str = "## 4. The last two exchanges, word for word";

/// Section 5's heading on a move to a provider the session has not run on.
const TRANSCRIPT_HEADING: &str = "## 5. The whole earlier conversation";

/// Section 5's heading on a move back.
const SWITCH_BACK_TRANSCRIPT_HEADING: &str = "## 5. The whole conversation since your last turn";

/// The heading the person's words follow where the brief opens their next message.
const PERSONS_MESSAGE_HEADING: &str = "## The person's message";

/// The line that stands for the diff when its whole text is past the budget.
const DIFF_PAST_BUDGET_LINE: &str = "The whole diff is too long for this message; run `git diff \
HEAD` in the working folder to read it.";

/// What a step line keeps of its call's arguments, in characters.
const STEP_ARGUMENTS_MAX_CHARS: usize = 160;

/// How much of the conversation a brief stands in for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BriefCoverage {
    /// The whole conversation, on a move to a provider the session has not run on.
    WholeConversation,
    /// What happened since the session last ran on the provider it moves back to.
    SinceLastTurn,
}

/// The working folder's changes against its last commit, as `git diff HEAD --stat --patch` printed
/// them.
#[derive(Clone, Copy, Debug)]
pub enum WorkingDiff<'diff> {
    /// The repository has a commit: the diff's per-file counts and its patch, each empty when
    /// nothing changed.
    AgainstHead {
        /// The per-file counts (`--stat`).
        stat: &'diff str,
        /// The patch, as `git diff HEAD` prints it.
        patch: &'diff str,
    },
    /// The repository has no commit yet, so there is nothing to diff against.
    NoCommitYet,
}

/// Everything the frame holds besides the session's steps and exchanges, each read at the moment
/// of the move.
#[derive(Clone, Copy, Debug)]
pub struct BriefFrameParts<'parts> {
    /// How much of the conversation the brief stands in for.
    pub coverage: BriefCoverage,
    /// The old provider's own summary, its framing stripped.
    pub summary: &'parts str,
    /// What the summary could not carry, as its driver declared it.
    pub summary_losses: &'parts [DeclaredLossKind],
    /// The branch `git branch --show-current` printed; empty when HEAD is detached.
    pub branch: &'parts str,
    /// What `git status --short` printed.
    pub status: &'parts str,
    /// The changes against the last commit.
    pub diff: WorkingDiff<'parts>,
    /// The whole transcript's file, by its absolute path.
    pub transcript_file: &'parts Path,
}

/// The brief as it is sent, and what it could not carry, in the contract's order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComposedBrief {
    /// The brief's text.
    pub text: String,
    /// What did not carry, read off the text and never empty: the summary's own losses lead it.
    pub declared_losses: Vec<DeclaredLossKind>,
}

impl ComposedBrief {
    /// The brief opening the person's next message, their `words` under the person's heading.
    pub fn with_persons_message(&self, words: &str) -> String {
        format!("{}\n\n{PERSONS_MESSAGE_HEADING}\n\n{words}", self.text)
    }
}

/// Renders the brief's frame for one target model, under a budget that is that model's share of
/// its context window.
pub struct BriefFrame {
    /// Prices the text and renders the tail.
    projection: BriefProjection,
    /// The brief's share of the target's window.
    budget: BriefBudgetPolicy,
}

impl BriefFrame {
    /// The frame for a target model whose context window is `context_window_tokens`.
    pub fn for_context_window(context_window_tokens: u64) -> Self {
        Self {
            projection: BriefProjection::default(),
            budget: BriefBudgetPolicy::for_context_window(context_window_tokens),
        }
    }

    /// The brief of `parts` and of `history`, the steps and newest exchanges the session's read
    /// gathered. The frame and the diff are priced first; the exchanges take what the budget then
    /// leaves, the newest exchange and the newest tool exchanges kept whatever it leaves.
    pub fn render(&self, parts: &BriefFrameParts<'_>, history: BriefHistory) -> ComposedBrief {
        let steps = history.step_lines();
        let left_out_outputs: Vec<String> = history.left_out_output_call_ids();
        let budget_tokens = self.budget.budget_tokens();
        let mut is_diff_whole = true;
        let mut spent_tokens =
            self.projection
                .estimate_tokens(&frame_text(parts, is_diff_whole, &steps, ""));
        if spent_tokens > budget_tokens
            && matches!(parts.diff, WorkingDiff::AgainstHead { patch, .. } if !patch.is_empty())
        {
            is_diff_whole = false;
            spent_tokens =
                self.projection
                    .estimate_tokens(&frame_text(parts, is_diff_whole, &steps, ""));
        }
        let has_read_helper = history.has_read_helper;
        let mut losses = parts.summary_losses.to_vec();
        let mut exchanges = String::new();
        let mut carried_calls = HashSet::new();
        if let Some((tail, earlier_exchange_count)) = history.into_tail() {
            let rendering = self.projection.render_tail(
                tail,
                self.budget,
                earlier_exchange_count,
                spent_tokens,
            );
            exchanges = rendering.text;
            losses.extend(rendering.declared_losses);
            carried_calls.extend(
                rendering
                    .included_turns
                    .into_iter()
                    .flat_map(|turn| turn.segments)
                    .filter_map(|segment| {
                        if let CanonicalTranscriptSegment::ToolCall { tool_call_id, .. } = segment {
                            Some(tool_call_id)
                        } else {
                            None
                        }
                    }),
            );
        }
        if left_out_outputs
            .iter()
            .any(|tool_call_id| !carried_calls.contains(tool_call_id))
        {
            losses.push(DeclaredLossKind::ToolOutputBodies);
        }
        if has_read_helper {
            losses.push(DeclaredLossKind::HelperConversations);
        }
        ComposedBrief {
            text: frame_text(parts, is_diff_whole, &steps, &exchanges),
            declared_losses: order_declared_losses(losses),
        }
    }
}

/// The brief's five sections in order: the summary, the branch and changes with the diff whole or
/// as its counts, the `steps` lines and the `exchanges` text, then the transcript file.
fn frame_text(
    parts: &BriefFrameParts<'_>,
    is_diff_whole: bool,
    steps: &[String],
    exchanges: &str,
) -> String {
    let (opening_line, summary_heading, transcript_heading) = match parts.coverage {
        BriefCoverage::WholeConversation => (OPENING_LINE, SUMMARY_HEADING, TRANSCRIPT_HEADING),
        BriefCoverage::SinceLastTurn => (
            SWITCH_BACK_OPENING_LINE,
            SWITCH_BACK_SUMMARY_HEADING,
            SWITCH_BACK_TRANSCRIPT_HEADING,
        ),
    };
    let branch = match parts.branch.trim() {
        "" => "(none: HEAD is detached)".to_owned(),
        branch => format!("`{branch}`"),
    };
    let diff = match parts.diff {
        WorkingDiff::AgainstHead { patch, .. } if is_diff_whole => {
            format!(
                "`git diff HEAD`:\n\n{}",
                or_placeholder(patch, "(no changes)")
            )
        }
        WorkingDiff::AgainstHead { stat, .. } => format!(
            "`git diff HEAD --stat`:\n\n{}\n\n{DIFF_PAST_BUDGET_LINE}",
            stat.trim_end_matches('\n')
        ),
        WorkingDiff::NoCommitYet => {
            "`git diff HEAD`:\n\n(no commit yet, so the status above lists every change)".to_owned()
        }
    };
    let steps = if steps.is_empty() {
        "(no steps)".to_owned()
    } else {
        steps.join("\n")
    };
    [
        opening_line.to_owned(),
        summary_heading.to_owned(),
        parts.summary.trim().to_owned(),
        CHANGES_HEADING.to_owned(),
        format!("Branch: {branch}"),
        "`git status --short`:".to_owned(),
        or_placeholder(parts.status, "(clean)").to_owned(),
        diff,
        STEPS_HEADING.to_owned(),
        steps,
        EXCHANGES_HEADING.to_owned(),
        or_placeholder(exchanges, "(no exchanges)").to_owned(),
        transcript_heading.to_owned(),
        format!(
            "If you need specific details from the earlier conversation (like exact code \
             snippets, error messages, or content you generated), read its whole transcript, one \
             plain file at `{}`, with your file tools.",
            parts.transcript_file.display()
        ),
    ]
    .join("\n\n")
}

/// `output` without its closing line breaks, or `placeholder` where it prints nothing.
fn or_placeholder<'text>(output: &'text str, placeholder: &'text str) -> &'text str {
    if output.trim().is_empty() {
        placeholder
    } else {
        output.trim_end_matches('\n')
    }
}

/// One tool call of the lead's runs, as its step line tells it.
struct BriefStep {
    /// The call's id, which pairs it with its result and with the tail's copy of it.
    tool_call_id: String,
    /// The step and what it was: the tool's name and its arguments on one line.
    what: String,
    /// How it ended; `None` while no result has come.
    ending: Option<String>,
    /// Whether its result had an output that the summary does not quote.
    is_output_left_out: bool,
}

/// The session's steps and newest exchanges, gathered as its transcript is read: every tool call
/// of the lead's runs as a step, and the turns of the newest exchanges, so memory holds the steps
/// and the tail, never the session. A helper's run is read past.
pub struct BriefHistory {
    /// The old provider's summary, against which a left-out output is checked.
    summary: String,
    /// Every step, in log order.
    steps: Vec<BriefStep>,
    /// The steps of the run being read whose result has not come, by call id.
    open_steps: HashMap<String, usize>,
    /// Whether the run being read is a helper's.
    is_reading_helper: bool,
    /// Whether any helper's run was read past.
    has_read_helper: bool,
    /// The session and the newest lead run, which the tail is folded under.
    tail_run: Option<(SessionId, RunId)>,
    /// The newest exchanges' turns, from the first turn of the oldest still kept.
    turns: Vec<CanonicalTranscriptTurn>,
    /// How many exchanges came before the kept turns.
    earlier_exchange_count: usize,
}

impl BriefHistory {
    /// A history whose left-out outputs are checked against the old provider's `summary`.
    pub fn new(summary: String) -> Self {
        Self {
            summary,
            steps: Vec::new(),
            open_steps: HashMap::new(),
            is_reading_helper: false,
            has_read_helper: false,
            tail_run: None,
            turns: Vec::new(),
            earlier_exchange_count: 0,
        }
    }

    /// Each step as its line: `- <tool>: <arguments> → <how it ended>`.
    fn step_lines(&self) -> Vec<String> {
        self.steps
            .iter()
            .map(|step| {
                let ending = step
                    .ending
                    .clone()
                    .unwrap_or_else(|| tool_call_ending(None));
                format!("- {} \u{2192} {ending}", step.what)
            })
            .collect()
    }

    /// The call ids of the steps whose output the summary does not quote.
    fn left_out_output_call_ids(&self) -> Vec<String> {
        self.steps
            .iter()
            .filter(|step| step.is_output_left_out)
            .map(|step| step.tool_call_id.clone())
            .collect()
    }

    /// The kept turns as a transcript of the newest lead run, with how many exchanges came before
    /// them; `None` when no lead run had a turn.
    fn into_tail(self) -> Option<(CanonicalTranscriptProjection, usize)> {
        let (session_id, run_id) = self.tail_run?;
        let built_at_position = self
            .turns
            .iter()
            .flat_map(|turn| &turn.segments)
            .map(segment_position)
            .max()
            .unwrap_or_default();
        Some((
            CanonicalTranscriptProjection {
                session_id,
                run_id,
                built_at_position,
                turns: self.turns,
            },
            self.earlier_exchange_count,
        ))
    }

    /// Drops the oldest exchanges past the newest [`WORD_FOR_WORD_EXCHANGE_COUNT`], up to the
    /// first that holds a call still waiting on its result, whose result may yet join it to a
    /// later exchange.
    fn drop_older_exchanges(&mut self) {
        let exchanges = partition_into_exchanges(&self.turns);
        let first_open = exchanges.iter().position(|exchange| {
            self.turns[exchange.turns.clone()]
                .iter()
                .flat_map(|turn| &turn.segments)
                .any(|segment| {
                    matches!(
                        segment,
                        CanonicalTranscriptSegment::ToolCall { tool_call_id, .. }
                            if self.open_steps.contains_key(tool_call_id)
                    )
                })
        });
        let dropped = exchanges
            .len()
            .saturating_sub(WORD_FOR_WORD_EXCHANGE_COUNT)
            .min(first_open.unwrap_or(exchanges.len()));
        if dropped > 0 {
            self.turns.drain(..exchanges[dropped].turns.start);
            self.earlier_exchange_count += dropped;
        }
    }

    /// Adds `segment` to the open turn, which takes its position from its first segment.
    fn push_segment(&mut self, segment: CanonicalTranscriptSegment) {
        let turn = self
            .turns
            .last_mut()
            .expect("the read opens a turn before its first segment");
        if turn.segments.is_empty() {
            turn.position = segment_position(&segment);
        }
        turn.segments.push(segment);
    }
}

impl SessionTranscriptSink for BriefHistory {
    type Error = Infallible;

    fn open_run(&mut self, _number: u64, queued: &AgentRunQueuedPayload) -> Result<(), Infallible> {
        // A run's calls are answered within it, so a call still open here never will be.
        self.open_steps.clear();
        let parent_run_id = match queued {
            AgentRunQueuedPayload::SessionAgent(payload) => payload.parent_run_id,
            AgentRunQueuedPayload::ResolvedAgent(payload) => payload.parent_run_id,
        };
        self.is_reading_helper = parent_run_id.is_some();
        if self.is_reading_helper {
            self.has_read_helper = true;
        } else {
            self.tail_run = Some((queued.session_id(), queued.run_id()));
        }
        Ok(())
    }

    fn open_turn(&mut self, role: CanonicalTranscriptRole) -> Result<(), Infallible> {
        if self.is_reading_helper {
            return Ok(());
        }
        if role == CanonicalTranscriptRole::User {
            self.drop_older_exchanges();
        }
        self.turns.push(CanonicalTranscriptTurn {
            position: 0,
            role,
            segments: Vec::new(),
        });
        Ok(())
    }

    fn segment(&mut self, segment: CanonicalTranscriptSegment) -> Result<(), Infallible> {
        if self.is_reading_helper {
            return Ok(());
        }
        record_step(
            &mut self.steps,
            &mut self.open_steps,
            &self.summary,
            &segment,
        );
        self.push_segment(segment);
        Ok(())
    }

    fn open_streamed_segment(
        &mut self,
        head: CanonicalTranscriptSegment,
    ) -> Result<(), Infallible> {
        if !self.is_reading_helper {
            self.push_segment(head);
        }
        Ok(())
    }

    fn body_frame(&mut self, frame: &str) -> Result<(), Infallible> {
        if self.is_reading_helper {
            return Ok(());
        }
        let body = match self
            .turns
            .last_mut()
            .and_then(|turn| turn.segments.last_mut())
            .expect("a streamed segment is open before its frames")
        {
            CanonicalTranscriptSegment::Text { text, .. }
            | CanonicalTranscriptSegment::Reasoning { text, .. }
            | CanonicalTranscriptSegment::ToolResult { text, .. } => text,
            CanonicalTranscriptSegment::ToolCall { arguments_json, .. } => arguments_json,
        };
        body.push_str(frame);
        Ok(())
    }

    fn close_streamed_segment(&mut self) -> Result<(), Infallible> {
        if self.is_reading_helper {
            return Ok(());
        }
        let segment = self
            .turns
            .last()
            .and_then(|turn| turn.segments.last())
            .expect("a streamed segment is open before it closes");
        record_step(
            &mut self.steps,
            &mut self.open_steps,
            &self.summary,
            segment,
        );
        Ok(())
    }
}

/// Records what `segment` does to the steps: a call opens one, and a result says how its call
/// ended and whether its output, which no step line carries, goes unquoted by `summary`.
fn record_step(
    steps: &mut Vec<BriefStep>,
    open_steps: &mut HashMap<String, usize>,
    summary: &str,
    segment: &CanonicalTranscriptSegment,
) {
    match segment {
        CanonicalTranscriptSegment::ToolCall {
            tool_call_id,
            tool_name,
            arguments_json,
            ..
        } => {
            let arguments = if segment_content_is_unavailable(segment) {
                String::new()
            } else {
                one_line_arguments(arguments_json, Some(STEP_ARGUMENTS_MAX_CHARS))
            };
            let what = if arguments.is_empty() {
                tool_name.clone()
            } else {
                format!("{tool_name}: {arguments}")
            };
            open_steps.insert(tool_call_id.clone(), steps.len());
            steps.push(BriefStep {
                tool_call_id: tool_call_id.clone(),
                what,
                ending: None,
                is_output_left_out: false,
            });
        }
        CanonicalTranscriptSegment::ToolResult {
            tool_call_id, text, ..
        } => {
            let Some(index) = open_steps.remove(tool_call_id) else {
                return;
            };
            let step = &mut steps[index];
            step.ending = Some(tool_call_ending(Some(segment)));
            step.is_output_left_out = segment_content_is_unavailable(segment)
                || (!text.is_empty() && !summary.contains(text.as_str()));
        }
        CanonicalTranscriptSegment::Text { .. } | CanonicalTranscriptSegment::Reasoning { .. } => {}
    }
}

/// The sequence of the row `segment` came from.
fn segment_position(segment: &CanonicalTranscriptSegment) -> u64 {
    match segment {
        CanonicalTranscriptSegment::Text { position, .. }
        | CanonicalTranscriptSegment::Reasoning { position, .. }
        | CanonicalTranscriptSegment::ToolCall { position, .. }
        | CanonicalTranscriptSegment::ToolResult { position, .. } => *position,
    }
}

#[cfg(test)]
mod tests;
