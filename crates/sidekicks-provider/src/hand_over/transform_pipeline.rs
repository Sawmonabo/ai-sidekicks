//! What a canonical transcript becomes before it is handed over: its turns placed, the provider's
//! reasoning summaries carried as plain text, then the tool-call pairing repaired, in that order,
//! each loss declared. Repairing comes last because it answers what the earlier steps leave; the
//! order lives only in [`transform_transcript`]. The result is rebuilt on every call, since the
//! log it comes from moves.
#![cfg_attr(
    not(test),
    expect(dead_code, reason = "the provider switch's hand-over brief")
)]

use std::collections::{HashMap, HashSet};

use sidekicks_contracts::provider::driver::declared_loss::DeclaredLossKind;
use strum::VariantArray;

use crate::hand_over::canonical_transcript::{
    CanonicalToolResultOutcome, CanonicalToolResultProvenance, CanonicalTranscriptProjection,
    CanonicalTranscriptRole, CanonicalTranscriptSegment, CanonicalTranscriptTurn,
};

/// The text a repaired result carries for a call that was never answered. Fixed, so two such
/// results read alike to the target.
const SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT: &str =
    "This tool call produced no result: the turn ended before one was recorded.";

/// The text a repaired result carries for a call that reused an id an earlier call holds; saying
/// the turn ended would be false there.
const SYNTHETIC_REUSED_IDENTIFIER_TOOL_RESULT_TEXT: &str =
    "This tool call produced no result: it reused an identifier an earlier call already holds.";

/// Put between a reused id and the call's position, so a person reading the target sees the id
/// was repaired and which id it came from.
const REPAIRED_TOOL_CALL_ID_INFIX: &str = "-repaired-";

/// What the transform leaves of a projection: its portable turns and every loss it declared, in
/// the contract's order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TransformedTranscript {
    /// The turns, in log order; a turn the repair emptied is gone.
    pub(crate) turns: Vec<CanonicalTranscriptTurn>,
    /// The losses, each once, in [`DeclaredLossKind::VARIANTS`] order.
    pub(crate) declared_losses: Vec<DeclaredLossKind>,
}

/// Whether `segment` stands in for a body the fold could not read. The loss this transform
/// declares and the brief's rendering of the segment both decide by it.
pub(crate) fn segment_content_is_unavailable(segment: &CanonicalTranscriptSegment) -> bool {
    match segment {
        CanonicalTranscriptSegment::Text {
            is_content_unavailable,
            ..
        }
        | CanonicalTranscriptSegment::ToolCall {
            is_content_unavailable,
            ..
        }
        | CanonicalTranscriptSegment::ToolResult {
            is_content_unavailable,
            ..
        } => *is_content_unavailable,
        CanonicalTranscriptSegment::Reasoning { .. } => false,
    }
}

/// Places `projection`'s turns, carries each reasoning summary as plain text and repairs the
/// tool-call pairing, in that order, declaring `TurnContentUnavailable` for a body the fold could
/// not read and `ToolCallHistoryRepaired` for any repair.
pub(crate) fn transform_transcript(
    projection: CanonicalTranscriptProjection,
) -> TransformedTranscript {
    let turns = projection.turns;
    let mut declared_losses = Vec::new();
    // Declared before anything moves, so a consumer never reads an empty list as nothing lost.
    if turns
        .iter()
        .any(|turn| turn.segments.iter().any(segment_content_is_unavailable))
    {
        declared_losses.push(DeclaredLossKind::TurnContentUnavailable);
    }
    let turns = carry_reasoning_as_text(turns);
    let (turns, is_repaired) = repair_tool_call_pairing(turns);
    if is_repaired {
        declared_losses.push(DeclaredLossKind::ToolCallHistoryRepaired);
    }
    TransformedTranscript {
        turns,
        declared_losses: order_declared_losses(declared_losses),
    }
}

/// `losses` each once, in [`DeclaredLossKind::VARIANTS`] order, so two runs over one transcript
/// declare identical lists.
pub(crate) fn order_declared_losses(
    losses: impl IntoIterator<Item = DeclaredLossKind>,
) -> Vec<DeclaredLossKind> {
    let present: HashSet<DeclaredLossKind> = losses.into_iter().collect();
    DeclaredLossKind::VARIANTS
        .iter()
        .copied()
        .filter(|kind| present.contains(kind))
        .collect()
}

/// `turns` with each reasoning segment turned into text: logged reasoning is the provider's own
/// summary, which the person already saw, so it travels and declares no loss.
fn carry_reasoning_as_text(
    mut turns: Vec<CanonicalTranscriptTurn>,
) -> Vec<CanonicalTranscriptTurn> {
    for segment in turns.iter_mut().flat_map(|turn| turn.segments.iter_mut()) {
        if let CanonicalTranscriptSegment::Reasoning { position, text } = segment {
            *segment = CanonicalTranscriptSegment::Text {
                position: *position,
                text: std::mem::take(text),
                is_content_unavailable: false,
            };
        }
    }
    turns
}

/// A turn's place and author, kept while its segments are walked out of order.
struct TurnHead {
    position: u64,
    role: CanonicalTranscriptRole,
    segment_count: usize,
}

/// `turns` with every call answered exactly once, and whether anything was repaired. Pairing is by
/// place across the whole transcript, so a result before its call is as unpaired as one with no
/// call:
///
/// - a call with no result takes a failed, repaired result right after it, and is never dropped;
/// - a result before its call moves right after it, keeping the provider's outcome; one after it
///   keeps its place;
/// - a result with no call is removed, since carrying it would claim a call that never happened;
/// - of several results under one id, the first stays;
/// - a call reusing an id an earlier call holds takes a new id made from its place, with a failed,
///   repaired result under it, its arguments unchanged; the earlier call's result moves up to it,
///   so a reader pairing a call with the next result never reads the repair as its outcome.
fn repair_tool_call_pairing(
    turns: Vec<CanonicalTranscriptTurn>,
) -> (Vec<CanonicalTranscriptTurn>, bool) {
    // Ordinals count segments across the whole transcript, so before and after hold across a
    // turn boundary, where a provider's out-of-order output lands them.
    let mut owner_call_ordinals: HashMap<String, usize> = HashMap::new();
    let mut reused_tool_call_ids: HashSet<String> = HashSet::new();
    let mut retained_result_ordinals: HashMap<String, usize> = HashMap::new();
    // Every id in use, so a new one never collides with a real call.
    let mut identifiers_in_use: HashSet<String> = HashSet::new();
    let mut ordinal = 0;
    for segment in turns.iter().flat_map(|turn| turn.segments.iter()) {
        match segment {
            CanonicalTranscriptSegment::ToolCall { tool_call_id, .. } => {
                identifiers_in_use.insert(tool_call_id.clone());
                if owner_call_ordinals.contains_key(tool_call_id) {
                    reused_tool_call_ids.insert(tool_call_id.clone());
                } else {
                    owner_call_ordinals.insert(tool_call_id.clone(), ordinal);
                }
            }
            CanonicalTranscriptSegment::ToolResult { tool_call_id, .. } => {
                identifiers_in_use.insert(tool_call_id.clone());
                if !retained_result_ordinals.contains_key(tool_call_id) {
                    retained_result_ordinals.insert(tool_call_id.clone(), ordinal);
                }
            }
            CanonicalTranscriptSegment::Text { .. }
            | CanonicalTranscriptSegment::Reasoning { .. } => {}
        }
        ordinal += 1;
    }

    // Each segment sits in its ordinal's slot until it is emitted, so a result can be taken out of
    // its place to sit beside its call.
    let mut heads = Vec::with_capacity(turns.len());
    let mut slots: Vec<Option<CanonicalTranscriptSegment>> = Vec::with_capacity(ordinal);
    for turn in turns {
        heads.push(TurnHead {
            position: turn.position,
            role: turn.role,
            segment_count: turn.segments.len(),
        });
        slots.extend(turn.segments.into_iter().map(Some));
    }

    let mut is_repaired = false;
    let mut repaired_turns = Vec::with_capacity(heads.len());
    let mut current = 0;
    for head in heads {
        let mut segments = Vec::with_capacity(head.segment_count);
        for _ in 0..head.segment_count {
            let ordinal = current;
            current += 1;
            // An empty slot held a result already emitted beside its call.
            let Some(segment) = slots[ordinal].take() else {
                continue;
            };
            match segment {
                CanonicalTranscriptSegment::ToolResult {
                    ref tool_call_id, ..
                } => {
                    let call_ordinal = owner_call_ordinals.get(tool_call_id).copied();
                    let is_retained = retained_result_ordinals.get(tool_call_id) == Some(&ordinal);
                    match call_ordinal {
                        Some(call_ordinal) if is_retained => {
                            if ordinal < call_ordinal {
                                // It waits in its slot for its call to take it.
                                is_repaired = true;
                                slots[ordinal] = Some(segment);
                            } else {
                                segments.push(segment);
                            }
                        }
                        // A result with no call, or a second answer to an answered call.
                        Some(_) | None => is_repaired = true,
                    }
                }
                CanonicalTranscriptSegment::ToolCall {
                    position,
                    tool_call_id,
                    tool_name,
                    arguments_json,
                    is_content_unavailable,
                } => {
                    if owner_call_ordinals.get(&tool_call_id) != Some(&ordinal) {
                        is_repaired = true;
                        let disambiguated_tool_call_id = mint_disambiguated_tool_call_id(
                            &tool_call_id,
                            ordinal,
                            &identifiers_in_use,
                        );
                        identifiers_in_use.insert(disambiguated_tool_call_id.clone());
                        segments.push(CanonicalTranscriptSegment::ToolCall {
                            position,
                            tool_call_id: disambiguated_tool_call_id.clone(),
                            tool_name,
                            arguments_json,
                            is_content_unavailable,
                        });
                        segments.push(repaired_tool_result(
                            position,
                            disambiguated_tool_call_id,
                            SYNTHETIC_REUSED_IDENTIFIER_TOOL_RESULT_TEXT,
                        ));
                        continue;
                    }
                    let retained_result_ordinal =
                        retained_result_ordinals.get(&tool_call_id).copied();
                    let is_reused = reused_tool_call_ids.contains(&tool_call_id);
                    segments.push(CanonicalTranscriptSegment::ToolCall {
                        position,
                        tool_call_id: tool_call_id.clone(),
                        tool_name,
                        arguments_json,
                        is_content_unavailable,
                    });
                    match retained_result_ordinal {
                        None => {
                            is_repaired = true;
                            segments.push(repaired_tool_result(
                                position,
                                tool_call_id,
                                SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT,
                            ));
                        }
                        Some(result_ordinal) if result_ordinal < ordinal || is_reused => {
                            is_repaired = true;
                            let result = slots[result_ordinal]
                                .take()
                                .expect("a call's retained result waits in its slot for the call");
                            segments.push(result);
                        }
                        Some(_) => {}
                    }
                }
                CanonicalTranscriptSegment::Text { .. }
                | CanonicalTranscriptSegment::Reasoning { .. } => segments.push(segment),
            }
        }
        if !segments.is_empty() {
            repaired_turns.push(CanonicalTranscriptTurn {
                position: head.position,
                role: head.role,
                segments,
            });
        }
    }
    (repaired_turns, is_repaired)
}

/// A failed result the repair made for `tool_call_id`. It takes its call's position, since no
/// logged row gave it.
fn repaired_tool_result(
    position: u64,
    tool_call_id: String,
    text: &str,
) -> CanonicalTranscriptSegment {
    CanonicalTranscriptSegment::ToolResult {
        position,
        tool_call_id,
        outcome: CanonicalToolResultOutcome::Failed,
        provenance: CanonicalToolResultProvenance::Repaired,
        text: text.to_owned(),
        is_content_unavailable: false,
    }
}

/// A new id for a call that reused `reused_tool_call_id`, made from its ordinal so two runs over
/// one transcript make the same id; a numbered suffix steps past an id already in use.
fn mint_disambiguated_tool_call_id(
    reused_tool_call_id: &str,
    ordinal: usize,
    identifiers_in_use: &HashSet<String>,
) -> String {
    let stem = format!("{reused_tool_call_id}{REPAIRED_TOOL_CALL_ID_INFIX}{ordinal}");
    let mut candidate = stem.clone();
    let mut attempt: u64 = 0;
    while identifiers_in_use.contains(&candidate) {
        attempt += 1;
        candidate = format!("{stem}-{attempt}");
    }
    candidate
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::provider::driver::declared_loss::DeclaredLossKind;
    use sidekicks_contracts::run::id::RunId;

    use super::{
        SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT, SYNTHETIC_REUSED_IDENTIFIER_TOOL_RESULT_TEXT,
        transform_transcript,
    };
    use crate::hand_over::canonical_transcript::{
        CanonicalToolResultOutcome, CanonicalToolResultProvenance, CanonicalTranscriptProjection,
        CanonicalTranscriptRole, CanonicalTranscriptSegment, CanonicalTranscriptTurn,
    };
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_store::database::writer::test_file::test_session_id;

    /// A projection of one assistant turn holding `segments`.
    fn projection_of(segments: Vec<CanonicalTranscriptSegment>) -> CanonicalTranscriptProjection {
        CanonicalTranscriptProjection {
            session_id: test_session_id(),
            run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
            built_at_position: 4,
            turns: vec![CanonicalTranscriptTurn {
                position: 0,
                role: CanonicalTranscriptRole::Assistant,
                segments,
            }],
        }
    }

    fn call(position: u64, tool_call_id: &str) -> CanonicalTranscriptSegment {
        CanonicalTranscriptSegment::ToolCall {
            position,
            tool_call_id: tool_call_id.to_owned(),
            tool_name: "Read".to_owned(),
            arguments_json: format!(r#"{{"at":{position}}}"#),
            is_content_unavailable: false,
        }
    }

    fn result(
        position: u64,
        tool_call_id: &str,
        provenance: CanonicalToolResultProvenance,
        text: &str,
    ) -> CanonicalTranscriptSegment {
        let outcome = match provenance {
            CanonicalToolResultProvenance::Provider => CanonicalToolResultOutcome::Succeeded,
            CanonicalToolResultProvenance::Repaired => CanonicalToolResultOutcome::Failed,
        };
        CanonicalTranscriptSegment::ToolResult {
            position,
            tool_call_id: tool_call_id.to_owned(),
            outcome,
            provenance,
            text: text.to_owned(),
            is_content_unavailable: false,
        }
    }

    #[rstest]
    #[case::result_before_its_call(
        vec![result(1, "call-1", CanonicalToolResultProvenance::Provider, "a"), call(2, "call-1")],
        vec![call(2, "call-1"), result(1, "call-1", CanonicalToolResultProvenance::Provider, "a")],
    )]
    #[case::reused_id(
        vec![
            call(1, "call-1"),
            call(2, "call-1"),
            result(3, "call-1", CanonicalToolResultProvenance::Provider, "a"),
        ],
        vec![
            call(1, "call-1"),
            result(3, "call-1", CanonicalToolResultProvenance::Provider, "a"),
            call(2, "call-1-repaired-1"),
            result(
                2,
                "call-1-repaired-1",
                CanonicalToolResultProvenance::Repaired,
                SYNTHETIC_REUSED_IDENTIFIER_TOOL_RESULT_TEXT,
            ),
        ],
    )]
    fn a_result_is_moved_beside_the_call_it_answers(
        #[case] segments: Vec<CanonicalTranscriptSegment>,
        #[case] expected: Vec<CanonicalTranscriptSegment>,
    ) {
        let transformed = transform_transcript(projection_of(segments));

        assert_eq!(transformed.turns[0].segments, expected);
        assert_eq!(
            transformed.declared_losses,
            [DeclaredLossKind::ToolCallHistoryRepaired]
        );
    }

    #[test]
    fn an_unanswered_call_is_answered_and_losses_follow_the_contract_order() {
        let text =
            |position, text: &str, is_content_unavailable| CanonicalTranscriptSegment::Text {
                position,
                text: text.to_owned(),
                is_content_unavailable,
            };
        let call = CanonicalTranscriptSegment::ToolCall {
            position: 2,
            tool_call_id: "call-1".to_owned(),
            tool_name: "Read".to_owned(),
            arguments_json: r#"{"path":"a.txt"}"#.to_owned(),
            is_content_unavailable: false,
        };
        let projection = CanonicalTranscriptProjection {
            session_id: test_session_id(),
            run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
            built_at_position: 3,
            turns: vec![
                CanonicalTranscriptTurn {
                    position: 0,
                    role: CanonicalTranscriptRole::User,
                    segments: vec![text(0, "Read the file", false)],
                },
                CanonicalTranscriptTurn {
                    position: 1,
                    role: CanonicalTranscriptRole::Assistant,
                    segments: vec![
                        CanonicalTranscriptSegment::Reasoning {
                            position: 1,
                            text: "Opening it.".to_owned(),
                        },
                        call.clone(),
                        text(3, "", true),
                    ],
                },
            ],
        };

        let transformed = transform_transcript(projection);

        assert_eq!(
            transformed.turns[1].segments,
            [
                text(1, "Opening it.", false),
                call,
                CanonicalTranscriptSegment::ToolResult {
                    position: 2,
                    tool_call_id: "call-1".to_owned(),
                    outcome: CanonicalToolResultOutcome::Failed,
                    provenance: CanonicalToolResultProvenance::Repaired,
                    text: SYNTHETIC_INTERRUPTED_TOOL_RESULT_TEXT.to_owned(),
                    is_content_unavailable: false,
                },
                text(3, "", true),
            ]
        );
        // The unreadable body is declared first, so insertion order would put it first.
        assert_eq!(
            transformed.declared_losses,
            [
                DeclaredLossKind::ToolCallHistoryRepaired,
                DeclaredLossKind::TurnContentUnavailable,
            ]
        );
    }
}
