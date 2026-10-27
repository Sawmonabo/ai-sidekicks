//! The hand-over brief's prose: the canonical transcript, transformed, rendered as bounded text. It
//! reads only its arguments, never a clock, store, file or process, so the brief is rebuilt from
//! the log on every send and no caller can hold a stale one.
//!
//! - The budget is a share of the target's context window, never a fixed token count.
//! - Eviction removes whole exchanges only, so a tool call never travels without its result, and
//!   the newest exchange and the newest tool exchanges are kept.
#![cfg_attr(
    not(test),
    expect(dead_code, reason = "the provider switch's hand-over brief")
)]

use std::collections::{HashMap, HashSet};

use sidekicks_contracts::provider::driver::declared_loss::DeclaredLossKind;

use crate::hand_over::canonical_transcript::{
    CanonicalTranscriptProjection, CanonicalTranscriptRole, CanonicalTranscriptSegment,
    CanonicalTranscriptTurn,
};
use crate::hand_over::transform_pipeline::{
    order_declared_losses, segment_content_is_unavailable, transform_transcript,
};

/// The share of the target's context window the default budget gives the brief, in percent.
const DEFAULT_BUDGET_PERCENT_OF_WINDOW: u64 = 20;

/// How many of the newest tool-bearing exchanges the default budget keeps whatever their size.
const DEFAULT_PROTECTED_TAIL_TOOL_EXCHANGE_COUNT: usize = 2;

/// The brief's opening, which tells the target the conversation is already under way.
const BRIEF_OPENING_LINES: &str = "This message continues a conversation that is already under \
     way; it is not a new instruction.\nWhat follows is a bounded summary of that conversation, \
     not its verbatim record.";

/// The line between the brief's preamble and its exchanges.
const BRIEF_TRANSCRIPT_SEPARATOR: &str = "---";

/// What a body the fold could not read renders as: an empty body would render as no turn at all,
/// and the declared loss does not reach this text.
const BRIEF_UNAVAILABLE_BODY_TEXT: &str = "(this content could not be recovered)";

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
    fn budget_tokens(self) -> u64 {
        self.target_context_window_tokens
            .saturating_mul(self.budget_percent_of_window)
            / 100
    }
}

/// The bounded brief prose and what the budget kept and dropped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BriefRendering {
    /// The exact prose the brief turn carries.
    pub(crate) text: String,
    /// The turns that survived the transform and the budget, in log order.
    pub(crate) included_turns: Vec<CanonicalTranscriptTurn>,
    /// How many exchanges the prose holds.
    pub(crate) included_exchange_count: usize,
    /// How many exchanges the budget evicted.
    pub(crate) evicted_exchange_count: usize,
    /// The estimate of the emitted prose, in tokens.
    pub(crate) estimated_tokens: u64,
    /// The budget, in tokens.
    pub(crate) budget_tokens: u64,
    /// Whether the prose passes the budget; only the kept exchanges can push it over.
    pub(crate) exceeds_budget: bool,
    /// What the brief could not carry, in the contract's order; never empty.
    pub(crate) declared_losses: Vec<DeclaredLossKind>,
}

/// Renders a canonical transcript into the brief's bounded prose, pricing text with an injected
/// token estimator so a driver can supply its real tokenizer.
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

    /// The brief for `projection` under `budget`. It always declares the conversation summarized
    /// and the provider's private reasoning left behind, and declares the context truncated only
    /// when an exchange was evicted.
    pub(crate) fn render(
        &self,
        projection: CanonicalTranscriptProjection,
        budget: BriefBudgetPolicy,
    ) -> BriefRendering {
        // The strip and the repair first: an unpaired call is accepted once by a provider and
        // refused on every later request.
        let transformed = transform_transcript(projection);
        let turns = transformed.turns;
        let exchanges = partition_into_exchanges(&turns);
        let budget_tokens = budget.budget_tokens();
        let protected =
            protected_exchange_indices(&exchanges, budget.protected_tail_tool_exchange_count);
        // Rendered once; the admission walk only joins them.
        let renderings: Vec<String> = exchanges
            .iter()
            .map(|exchange| render_exchange(&turns[exchange.turns.clone()]))
            .collect();

        let mut admitted = vec![false; exchanges.len()];
        for &index in &protected {
            admitted[index] = true;
        }
        // The rest, newest first, until the first that does not fit; protected ones are stepped
        // over, so the notice tells of the gaps. Each candidate is priced as the exact text sent.
        for index in (0..exchanges.len()).rev() {
            if protected.contains(&index) {
                continue;
            }
            admitted[index] = true;
            if (self.estimate_tokens)(&assemble_brief(&renderings, &admitted)) > budget_tokens {
                admitted[index] = false;
                break;
            }
        }

        let included_exchange_count = admitted.iter().filter(|is_admitted| **is_admitted).count();
        let evicted_exchange_count = exchanges.len() - included_exchange_count;
        let text = assemble_brief(&renderings, &admitted);
        // Measured on the emitted text, so an estimator that is not monotone shows as over budget.
        let estimated_tokens = (self.estimate_tokens)(&text);
        let mut losses = transformed.declared_losses;
        // Always declared: an empty list would claim nothing was dropped, and no provider lets its
        // private reasoning travel.
        losses.push(DeclaredLossKind::ConversationHistorySummarized);
        losses.push(DeclaredLossKind::ProviderPrivateReasoning);
        // Only on eviction: an over-budget brief that evicted nothing dropped nothing.
        if evicted_exchange_count > 0 {
            losses.push(DeclaredLossKind::ContextTruncated);
        }
        let mut turns = turns.into_iter();
        let mut included_turns = Vec::new();
        for (exchange, is_admitted) in exchanges.iter().zip(&admitted) {
            let exchange_turns = turns.by_ref().take(exchange.turns.len());
            if *is_admitted {
                included_turns.extend(exchange_turns);
            } else {
                exchange_turns.for_each(drop);
            }
        }
        BriefRendering {
            text,
            included_turns,
            included_exchange_count,
            evicted_exchange_count,
            estimated_tokens,
            budget_tokens,
            exceeds_budget: estimated_tokens > budget_tokens,
            declared_losses: order_declared_losses(losses),
        }
    }
}

/// Consecutive turns that eviction keeps or drops as one: no tool call id's first-to-last span
/// crosses an exchange's edge, so a call and its result travel together.
struct TranscriptExchange {
    /// The exchange's turns, as indices into the transformed turns.
    turns: std::ops::Range<usize>,
    /// Whether any of its turns holds a tool call or result.
    carries_tool_activity: bool,
}

/// `turns` cut into exchanges at every place no tool call's span crosses.
fn partition_into_exchanges(turns: &[CanonicalTranscriptTurn]) -> Vec<TranscriptExchange> {
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
        if cut == turns.len() || straddling == 0 {
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

/// The brief's whole text: the opening, the eviction notice where any exchange was evicted, the
/// separator, then every admitted exchange in log order.
fn assemble_brief(renderings: &[String], admitted: &[bool]) -> String {
    let included = admitted.iter().filter(|is_admitted| **is_admitted).count();
    let evicted = admitted.len() - included;
    let mut lines: Vec<&str> = vec![BRIEF_OPENING_LINES];
    let notice;
    if evicted > 0 {
        // Never claims the shown exchanges are the newest: protection is per exchange, so gaps
        // occur.
        notice = format!(
            "Earlier parts of this conversation are omitted from the summary: {included} of {} \
             exchanges appear below in log order, and may not be consecutive.",
            admitted.len()
        );
        lines.push(&notice);
    }
    lines.push(BRIEF_TRANSCRIPT_SEPARATOR);
    lines.extend(
        renderings
            .iter()
            .zip(admitted)
            .filter(|(_, is_admitted)| **is_admitted)
            .map(|(rendering, _)| rendering.as_str()),
    );
    lines.join("\n")
}

/// One exchange's turns, one line block per turn.
fn render_exchange(turns: &[CanonicalTranscriptTurn]) -> String {
    turns.iter().map(render_turn).collect::<Vec<_>>().join("\n")
}

/// One turn: its author, then each segment that renders to anything.
fn render_turn(turn: &CanonicalTranscriptTurn) -> String {
    let speaker = match turn.role {
        CanonicalTranscriptRole::User => "User",
        CanonicalTranscriptRole::Assistant => "Assistant",
    };
    let segments: Vec<String> = turn.segments.iter().filter_map(render_segment).collect();
    format!("{speaker}: {}", segments.join("\n"))
}

/// One segment's text; `None` for empty words, which would render as nothing.
fn render_segment(segment: &CanonicalTranscriptSegment) -> Option<String> {
    let body = |text: &str| {
        if segment_content_is_unavailable(segment) {
            BRIEF_UNAVAILABLE_BODY_TEXT.to_owned()
        } else {
            text.to_owned()
        }
    };
    match segment {
        CanonicalTranscriptSegment::Text { text, .. }
        | CanonicalTranscriptSegment::Reasoning { text, .. } => {
            let rendered = body(text);
            (!rendered.is_empty()).then_some(rendered)
        }
        CanonicalTranscriptSegment::ToolCall {
            tool_call_id,
            tool_name,
            arguments_json,
            ..
        } => Some(format!(
            "[tool call {tool_name} ({tool_call_id})] {}",
            body(arguments_json)
        )),
        CanonicalTranscriptSegment::ToolResult {
            tool_call_id,
            outcome,
            text,
            ..
        } => Some(format!(
            "[tool result {} ({tool_call_id})] {}",
            outcome.as_str(),
            body(text)
        )),
    }
}

#[cfg(test)]
mod tests {
    use sidekicks_contracts::provider::driver::declared_loss::DeclaredLossKind;
    use sidekicks_contracts::run::id::RunId;

    use super::{BriefBudgetPolicy, BriefProjection};
    use crate::hand_over::canonical_transcript::{
        CanonicalToolResultOutcome, CanonicalToolResultProvenance, CanonicalTranscriptProjection,
        CanonicalTranscriptRole, CanonicalTranscriptSegment, CanonicalTranscriptTurn,
    };
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_store::database::writer::test_file::test_session_id;

    fn words(position: u64, role: CanonicalTranscriptRole, text: &str) -> CanonicalTranscriptTurn {
        CanonicalTranscriptTurn {
            position,
            role,
            segments: vec![CanonicalTranscriptSegment::Text {
                position,
                text: text.to_owned(),
                is_content_unavailable: false,
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

    #[test]
    fn eviction_drops_whole_exchanges_and_keeps_the_newest_and_the_tool_exchanges() {
        let call = CanonicalTranscriptTurn {
            position: 1,
            role: CanonicalTranscriptRole::Assistant,
            segments: vec![CanonicalTranscriptSegment::ToolCall {
                position: 1,
                tool_call_id: "call-1".to_owned(),
                tool_name: "Read".to_owned(),
                arguments_json: "{}".to_owned(),
                is_content_unavailable: false,
            }],
        };
        let result = CanonicalTranscriptTurn {
            position: 3,
            role: CanonicalTranscriptRole::Assistant,
            segments: vec![CanonicalTranscriptSegment::ToolResult {
                position: 3,
                tool_call_id: "call-1".to_owned(),
                outcome: CanonicalToolResultOutcome::Succeeded,
                provenance: CanonicalToolResultProvenance::Provider,
                text: "contents".to_owned(),
                is_content_unavailable: false,
            }],
        };
        // The call and its result straddle the person's turn between them, so the three are one
        // exchange; the oldest words are the only exchange eviction may take.
        let turns = vec![
            words(0, CanonicalTranscriptRole::User, &"old words ".repeat(50)),
            call,
            words(2, CanonicalTranscriptRole::User, "Go on"),
            result,
            words(4, CanonicalTranscriptRole::User, "Newest"),
        ];
        let projection = BriefProjection::default();

        let tight = projection.render(
            projection_of(turns.clone()),
            BriefBudgetPolicy::for_context_window(10),
        );
        let roomy = projection.render(
            projection_of(turns),
            BriefBudgetPolicy::for_context_window(1_000_000),
        );

        let positions: Vec<u64> = tight
            .included_turns
            .iter()
            .map(|turn| turn.position)
            .collect();
        assert_eq!(positions, [1, 2, 3, 4]);
        assert_eq!(
            (tight.included_exchange_count, tight.evicted_exchange_count),
            (2, 1)
        );
        assert!(tight.exceeds_budget);
        assert!(
            tight
                .declared_losses
                .contains(&DeclaredLossKind::ContextTruncated)
        );
        assert_eq!(roomy.evicted_exchange_count, 0);
        assert!(
            !roomy
                .declared_losses
                .contains(&DeclaredLossKind::ContextTruncated)
        );
    }
}
