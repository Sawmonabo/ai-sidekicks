//! The hand-over brief's word-for-word tail: the newest exchanges of a canonical transcript,
//! transformed and rendered under the brief's budget. It reads only its arguments, never a clock,
//! store, file or process, so the brief is rebuilt from the log on every send and no caller can hold
//! a stale one.
//!
//! - The budget is a share of the target's context window, never a fixed token count.
//! - Eviction removes whole exchanges only, so a tool call never travels without its result, and
//!   the newest exchange and the newest tool exchanges are kept.

use std::collections::{HashMap, HashSet};

use sidekicks_contracts::event::declared_variants::ToolCallEndCause;
use sidekicks_contracts::provider::driver::declared_loss::DeclaredLossKind;

use crate::hand_over::canonical_transcript::{
    CanonicalToolResultOutcome, CanonicalTranscriptProjection, CanonicalTranscriptRole,
    CanonicalTranscriptSegment, CanonicalTranscriptTurn, shown_tool_result_body,
};
use crate::hand_over::transform_pipeline::{
    order_declared_losses, segment_content_is_unavailable, transform_transcript,
};

/// The share of the target's context window the default budget gives the brief, in percent.
const DEFAULT_BUDGET_PERCENT_OF_WINDOW: u64 = 20;

/// How many of the newest tool-bearing exchanges the default budget keeps whatever their size.
const DEFAULT_PROTECTED_TAIL_TOOL_EXCHANGE_COUNT: usize = 2;

/// How many of the newest exchanges the brief carries word for word before the budget evicts any;
/// the brief's section heading names this count in words.
pub(crate) const WORD_FOR_WORD_EXCHANGE_COUNT: usize = 2;

/// What a body the fold could not read renders as: an empty body would render as no turn at all,
/// and the declared loss does not reach this text.
const BRIEF_UNAVAILABLE_BODY_TEXT: &str = "(this content could not be recovered)";

/// How a call that has no result reads where its ending would stand.
const NO_RESULT_ENDING: &str = "no result recorded";

/// The brief's budget as a share of the target's context window, so it holds across models.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct BriefBudgetPolicy {
    /// The target model's context window, in tokens.
    pub(crate) target_context_window_tokens: u64,
    /// The share of that window the brief may take, in percent.
    pub(crate) budget_percent_of_window: u64,
    /// How many of the newest tool-bearing exchanges eviction never removes, each on its own.
    pub(crate) protected_tail_tool_exchange_count: usize,
}

impl BriefBudgetPolicy {
    /// The default budget for a target whose context window is `context_window_tokens`.
    pub(crate) fn for_context_window(context_window_tokens: u64) -> Self {
        Self {
            target_context_window_tokens: context_window_tokens,
            budget_percent_of_window: DEFAULT_BUDGET_PERCENT_OF_WINDOW,
            protected_tail_tool_exchange_count: DEFAULT_PROTECTED_TAIL_TOOL_EXCHANGE_COUNT,
        }
    }

    /// The budget in tokens, rounded down.
    pub(crate) fn budget_tokens(self) -> u64 {
        self.target_context_window_tokens
            .saturating_mul(self.budget_percent_of_window)
            / 100
    }
}

/// The word-for-word tail under the budget and what it could not carry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BriefRendering {
    /// The kept exchanges, each under its `### Exchange <n> of <total>` heading.
    pub(crate) text: String,
    /// The turns that survived the transform, the count and the budget, in log order.
    pub(crate) included_turns: Vec<CanonicalTranscriptTurn>,
    /// What the tail could not carry, in the contract's order.
    pub(crate) declared_losses: Vec<DeclaredLossKind>,
}

/// Renders a canonical transcript's newest exchanges under the brief's budget, pricing text with
/// an injected token estimator so a driver can supply its real tokenizer.
pub(crate) struct BriefProjection {
    /// Estimates the tokens a text takes.
    estimate_tokens: Box<dyn Fn(&str) -> u64 + Send + Sync>,
}

impl Default for BriefProjection {
    /// Prices four UTF-16 units as one token, rounded up, so every daemon prices a text alike.
    fn default() -> Self {
        Self::with_estimator(|text| {
            u64::try_from(text.encode_utf16().count().div_ceil(4))
                .expect("a text's length fits in 64 bits")
        })
    }
}

impl BriefProjection {
    /// A projection that prices text with `estimate_tokens`.
    pub(crate) fn with_estimator(
        estimate_tokens: impl Fn(&str) -> u64 + Send + Sync + 'static,
    ) -> Self {
        Self {
            estimate_tokens: Box::new(estimate_tokens),
        }
    }

    /// The tokens `text` takes, as this projection prices it.
    pub(crate) fn estimate_tokens(&self, text: &str) -> u64 {
        (self.estimate_tokens)(text)
    }

    /// The tail for `projection` under `budget`, as the whole of a brief. It always declares the
    /// conversation summarized and the provider's private reasoning left behind, and declares the
    /// context truncated only when an exchange was evicted.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the provider switch's hand-over brief")
    )]
    pub(crate) fn render(
        &self,
        projection: CanonicalTranscriptProjection,
        budget: BriefBudgetPolicy,
    ) -> BriefRendering {
        let mut rendering = self.render_tail(projection, budget, 0, 0);
        rendering.declared_losses.extend([
            DeclaredLossKind::ConversationHistorySummarized,
            DeclaredLossKind::ProviderPrivateReasoning,
        ]);
        rendering.declared_losses = order_declared_losses(rendering.declared_losses);
        rendering
    }

    /// The newest [`WORD_FOR_WORD_EXCHANGE_COUNT`] exchanges of `projection`, which ends a
    /// conversation `earlier_exchange_count` exchanges longer, admitted under what `budget` leaves
    /// once `spent_tokens` are taken. It declares what the transform declared, and the context
    /// truncated only when the budget evicted one of those exchanges; one the count leaves out is
    /// not evicted.
    pub(crate) fn render_tail(
        &self,
        projection: CanonicalTranscriptProjection,
        budget: BriefBudgetPolicy,
        earlier_exchange_count: usize,
        spent_tokens: u64,
    ) -> BriefRendering {
        // The strip and the repair first: an unpaired call is accepted once by a provider and
        // refused on every later request.
        let transformed = transform_transcript(projection);
        let turns = transformed.turns;
        let every_exchange = partition_into_exchanges(&turns);
        let total = earlier_exchange_count + every_exchange.len();
        let first_kept = every_exchange
            .len()
            .saturating_sub(WORD_FOR_WORD_EXCHANGE_COUNT);
        let exchanges = &every_exchange[first_kept..];
        let budget_tokens = budget.budget_tokens().saturating_sub(spent_tokens);
        let protected =
            protected_exchange_indices(exchanges, budget.protected_tail_tool_exchange_count);
        // Rendered once; the admission walk only joins them.
        let renderings: Vec<String> = exchanges
            .iter()
            .enumerate()
            .map(|(index, exchange)| {
                let number = earlier_exchange_count + first_kept + index + 1;
                render_exchange(number, total, &turns[exchange.turns.clone()])
            })
            .collect();

        let mut admitted = vec![false; exchanges.len()];
        for &index in &protected {
            admitted[index] = true;
        }
        // The rest, newest first, until the first that does not fit; protected ones are stepped
        // over, and the headings' numbers show the gaps. Each candidate is priced as the exact
        // text sent.
        for index in (0..exchanges.len()).rev() {
            if protected.contains(&index) {
                continue;
            }
            admitted[index] = true;
            if (self.estimate_tokens)(&join_admitted(&renderings, &admitted)) > budget_tokens {
                admitted[index] = false;
                break;
            }
        }

        let evicted_exchange_count = admitted.iter().filter(|is_admitted| !**is_admitted).count();
        let mut losses = transformed.declared_losses;
        // Only on eviction: an over-budget tail that evicted nothing dropped nothing.
        if evicted_exchange_count > 0 {
            losses.push(DeclaredLossKind::ContextTruncated);
        }
        let included_turns = exchanges
            .iter()
            .zip(&admitted)
            .filter(|(_, is_admitted)| **is_admitted)
            .flat_map(|(exchange, _)| turns[exchange.turns.clone()].iter().cloned())
            .collect();
        BriefRendering {
            text: join_admitted(&renderings, &admitted),
            included_turns,
            declared_losses: order_declared_losses(losses),
        }
    }
}

/// Consecutive turns that eviction keeps or drops as one: each opens at a person's turn, or at the
/// first turn, and no tool call id's first-to-last span crosses an exchange's edge, so a call and
/// its result travel together.
pub(crate) struct TranscriptExchange {
    /// The exchange's turns, as indices into the turns it was cut from.
    pub(crate) turns: std::ops::Range<usize>,
    /// Whether any of its turns holds a tool call or result.
    carries_tool_activity: bool,
}

/// `turns` cut into exchanges before every person's turn that no tool call's span crosses.
pub(crate) fn partition_into_exchanges(
    turns: &[CanonicalTranscriptTurn],
) -> Vec<TranscriptExchange> {
    let mut spans: HashMap<&str, (usize, usize)> = HashMap::new();
    for (index, turn) in turns.iter().enumerate() {
        for segment in &turn.segments {
            if let Some(tool_call_id) = tool_call_id_of(segment) {
                spans
                    .entry(tool_call_id)
                    .and_modify(|span| span.1 = index)
                    .or_insert((index, index));
            }
        }
    }
    // A cut before turn `k` is straddled when some span starts before `k` and ends at or after it:
    // each span adds one over its straddled cuts, summed once from the left.
    let mut straddle_change = vec![0_i64; turns.len() + 1];
    for &(first, last) in spans.values() {
        if first < last {
            straddle_change[first + 1] += 1;
            straddle_change[last + 1] -= 1;
        }
    }
    let mut exchanges = Vec::new();
    let mut start = 0;
    let mut straddling = 0;
    for cut in 1..=turns.len() {
        straddling += straddle_change[cut];
        let is_cut = cut == turns.len()
            || (straddling == 0 && turns[cut].role == CanonicalTranscriptRole::User);
        if is_cut {
            exchanges.push(TranscriptExchange {
                turns: start..cut,
                carries_tool_activity: turns[start..cut].iter().any(|turn| {
                    turn.segments
                        .iter()
                        .any(|segment| tool_call_id_of(segment).is_some())
                }),
            });
            start = cut;
        }
    }
    exchanges
}

/// The tool call id a call or result segment carries; `None` for words.
fn tool_call_id_of(segment: &CanonicalTranscriptSegment) -> Option<&str> {
    match segment {
        CanonicalTranscriptSegment::ToolCall { tool_call_id, .. }
        | CanonicalTranscriptSegment::ToolResult { tool_call_id, .. } => Some(tool_call_id),
        CanonicalTranscriptSegment::Text { .. } | CanonicalTranscriptSegment::Reasoning { .. } => {
            None
        }
    }
}

/// The exchanges eviction never removes: the newest one, since a brief without it tells of a
/// conversation that did not happen, and the newest `protected_tool_exchange_count` tool-bearing
/// ones wherever they sit; at most that count plus one, so the budget still binds.
fn protected_exchange_indices(
    exchanges: &[TranscriptExchange],
    protected_tool_exchange_count: usize,
) -> HashSet<usize> {
    let mut protected = HashSet::new();
    let Some(newest) = exchanges.len().checked_sub(1) else {
        return protected;
    };
    protected.insert(newest);
    protected.extend(
        exchanges
            .iter()
            .enumerate()
            .rev()
            .filter(|(_, exchange)| exchange.carries_tool_activity)
            .map(|(index, _)| index)
            .take(protected_tool_exchange_count),
    );
    protected
}

/// Every admitted exchange's rendering in log order, a blank line between two.
fn join_admitted(renderings: &[String], admitted: &[bool]) -> String {
    renderings
        .iter()
        .zip(admitted)
        .filter(|(_, is_admitted)| **is_admitted)
        .map(|(rendering, _)| rendering.as_str())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Exchange `number` of `total`: its heading, then each segment that renders to anything, a call
/// on one line with how it ended and its output under it.
fn render_exchange(number: usize, total: usize, turns: &[CanonicalTranscriptTurn]) -> String {
    // After the transform's repair each call has one result, and the exchange holds both.
    let results: HashMap<&str, &CanonicalTranscriptSegment> = turns
        .iter()
        .flat_map(|turn| &turn.segments)
        .filter_map(|segment| {
            if let CanonicalTranscriptSegment::ToolResult { tool_call_id, .. } = segment {
                Some((tool_call_id.as_str(), segment))
            } else {
                None
            }
        })
        .collect();
    let mut lines = vec![format!("### Exchange {number} of {total}")];
    for turn in turns {
        let speaker = match turn.role {
            CanonicalTranscriptRole::User => "**The person:**",
            CanonicalTranscriptRole::Assistant => "**The assistant:**",
        };
        for segment in &turn.segments {
            match segment {
                CanonicalTranscriptSegment::Text { text, .. }
                | CanonicalTranscriptSegment::Reasoning { text, .. } => {
                    let words = if segment_content_is_unavailable(segment) {
                        BRIEF_UNAVAILABLE_BODY_TEXT
                    } else {
                        text.as_str()
                    };
                    if !words.is_empty() {
                        lines.push(format!("{speaker} {words}"));
                    }
                }
                CanonicalTranscriptSegment::ToolCall {
                    tool_call_id,
                    tool_name,
                    arguments_json,
                    ..
                } => {
                    let arguments = if segment_content_is_unavailable(segment) {
                        BRIEF_UNAVAILABLE_BODY_TEXT
                    } else {
                        arguments_json.as_str()
                    };
                    let result = results.get(tool_call_id.as_str()).copied();
                    let arguments = one_line_arguments(arguments, None);
                    let call = if arguments.is_empty() {
                        tool_name.clone()
                    } else {
                        format!("{tool_name} {arguments}")
                    };
                    lines.push(format!(
                        "**Tool call:** {call} \u{2192} {}",
                        tool_call_ending(result)
                    ));
                    if let Some(output) = result.and_then(shown_output) {
                        lines.push(output.to_owned());
                    }
                }
                // Rendered under its call.
                CanonicalTranscriptSegment::ToolResult { .. } => {}
            }
        }
    }
    lines.join("\n")
}

/// A result's output as the brief shows it under its call; `None` when it has none, as a call that
/// ended with no result has.
fn shown_output(result: &CanonicalTranscriptSegment) -> Option<&str> {
    let CanonicalTranscriptSegment::ToolResult { text, .. } = result else {
        return None;
    };
    if segment_content_is_unavailable(result) {
        return Some(BRIEF_UNAVAILABLE_BODY_TEXT);
    }
    (!text.is_empty()).then_some(text.as_str())
}

/// A call's arguments on one line, their line breaks made spaces, cut to `max_chars` characters
/// with an ellipsis marking the cut where a bound is given.
pub(crate) fn one_line_arguments(arguments: &str, max_chars: Option<usize>) -> String {
    let mut one_line = arguments.lines().collect::<Vec<_>>().join(" ");
    if let Some((cut, _)) = max_chars.and_then(|max_chars| one_line.char_indices().nth(max_chars)) {
        one_line.truncate(cut);
        one_line.push('\u{2026}');
    }
    one_line
}

/// How a call ended, read off its result `result`: `succeeded`, `failed`, `failed: <why>` where it
/// ended with no result, or that no result was recorded.
pub(crate) fn tool_call_ending(result: Option<&CanonicalTranscriptSegment>) -> String {
    let Some(CanonicalTranscriptSegment::ToolResult {
        outcome, end_cause, ..
    }) = result
    else {
        return NO_RESULT_ENDING.to_owned();
    };
    ending_of(*outcome, *end_cause)
}

/// `outcome`'s word, with why the call ended with no result where `end_cause` says.
fn ending_of(outcome: CanonicalToolResultOutcome, end_cause: Option<ToolCallEndCause>) -> String {
    match end_cause {
        Some(end_cause) => format!(
            "{}: {}",
            outcome.as_str(),
            shown_tool_result_body("", Some(end_cause))
        ),
        None => outcome.as_str().to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use sidekicks_contracts::provider::driver::declared_loss::DeclaredLossKind;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_store::database::writer::test_file::test_session_id;

    use super::{BriefBudgetPolicy, BriefProjection};
    use crate::hand_over::canonical_transcript::{
        CanonicalTranscriptProjection, CanonicalTranscriptRole, CanonicalTranscriptSegment,
        CanonicalTranscriptTurn,
    };

    fn words(position: u64, role: CanonicalTranscriptRole, text: &str) -> CanonicalTranscriptTurn {
        CanonicalTranscriptTurn {
            position,
            role,
            segments: vec![CanonicalTranscriptSegment::Text {
                position,
                text: text.to_owned(),
                is_content_unavailable: false,
                queue_item_id: None,
            }],
        }
    }

    fn projection_of(turns: Vec<CanonicalTranscriptTurn>) -> CanonicalTranscriptProjection {
        CanonicalTranscriptProjection {
            session_id: test_session_id(),
            run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
            built_at_position: 4,
            turns,
        }
    }

    #[test]
    fn a_brief_declares_the_summary_together_with_the_private_reasoning() {
        let rendering = BriefProjection::default().render(
            projection_of(vec![words(
                0,
                CanonicalTranscriptRole::User,
                "Fix the build",
            )]),
            BriefBudgetPolicy::for_context_window(1_000_000),
        );

        assert_eq!(
            rendering.declared_losses,
            [
                DeclaredLossKind::ProviderPrivateReasoning,
                DeclaredLossKind::ConversationHistorySummarized,
            ]
        );
    }
}
