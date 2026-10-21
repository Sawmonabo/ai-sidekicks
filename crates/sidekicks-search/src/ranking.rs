//! The one fuzzy matcher: a typed query scored as a case-insensitive subsequence of a candidate,
//! with the positions it matched, for the command palette, settings search and the keybinding map.
//!
//! Text is UTF-16 code units throughout, as JavaScript indexes it, so the matched indices index the
//! renderer's own string, and case and letters are judged per unit by JavaScript's rules. The best
//! embedding is found by dynamic programming over `f64` scores: a greedy left-to-right walk gets
//! `cs` → `Copy SHA` wrong, committing to the `c` of `Copy` and leaving the `S` of `SHA` reachable
//! only mid-word. The gap penalty is linear, which admits a running maximum in the inner loop, so
//! time and memory stay O(candidate × query) behind an O(candidate) subsequence check. Ties go to
//! the earliest end, so rows do not flicker between keystrokes.

/// Paid for every matched unit; constant within one search, it keeps a good match positive.
const BASE_CHARACTER_SCORE: f64 = 16.0;

/// Paid when the typed unit matches the candidate's case exactly: a typed capital is meant.
const EXACT_CASE_BONUS: f64 = 8.0;

/// Paid at the start of a word (the first unit, after a separator, or on a camel-case hump), so
/// `cs` reaches `Copy SHA` over `class`.
const WORD_BOUNDARY_BONUS: f64 = 24.0;

/// Paid when a match sits right after the previous one, so `rest` prefers `Restart run`.
const CONSECUTIVE_BONUS: f64 = 20.0;

/// Paid once, when the first unit matches at the candidate's start.
const PREFIX_BONUS: f64 = 32.0;

/// Charged per unit skipped between two matches; linear, for the running maximum.
const GAP_PENALTY_PER_CHARACTER: f64 = 3.0;

/// Charged per unit skipped before the first match, lighter than a gap.
const LEADING_GAP_PENALTY_PER_CHARACTER: f64 = 1.0;

/// Charged per unit left after the last match; it breaks ties toward the shorter candidate.
const TRAILING_PENALTY_PER_CHARACTER: f64 = 0.5;

/// The units that open a word when they precede a matched unit: path and identifier separators.
const WORD_SEPARATOR_CHARACTERS: &[u8] = b" \t-_./\\:,()[]{}@#";

/// The score of a cell no embedding reaches.
const NO_PATH: f64 = f64::NEG_INFINITY;

/// The parent of a cell no embedding reaches.
const NO_PARENT: u32 = u32::MAX;

/// A scored embedding of a query inside a candidate.
#[derive(Clone, Debug, PartialEq)]
pub struct SubsequenceMatch {
    /// Higher is better; unbounded both ways, so only the ordering means anything.
    pub score: f64,
    /// Indices into the candidate in UTF-16 units, ascending, one per query unit.
    pub matched_indices: Vec<u32>,
}

/// Scores `candidate` against `query`, both UTF-16 units. `None` when the query is empty, longer
/// than the candidate or not a case-insensitive subsequence of it: an empty query is a state of its
/// own, never a match of everything.
pub fn score_subsequence(candidate: &[u16], query: &[u16]) -> Option<SubsequenceMatch> {
    let candidate_length = candidate.len();
    let query_length = query.len();
    if query_length == 0 || candidate_length == 0 || query_length > candidate_length {
        return None;
    }
    let candidate_codes: Vec<u16> = candidate.iter().map(|unit| folded_unit(*unit)).collect();
    let query_codes: Vec<u16> = query.iter().map(|unit| folded_unit(*unit)).collect();
    if !is_subsequence(&candidate_codes, &query_codes) {
        return None;
    }
    let flags = word_boundary_flags(candidate);
    let character_score = |candidate_index: usize, query_index: usize| {
        let mut score = BASE_CHARACTER_SCORE;
        if candidate[candidate_index] == query[query_index] {
            score += EXACT_CASE_BONUS;
        }
        if flags[candidate_index] {
            score += WORD_BOUNDARY_BONUS;
        }
        if candidate_index == 0 {
            score += PREFIX_BONUS;
        }
        score
    };

    // `previous_row[k]` and `current_row[k]` hold the best score of an embedding of the query's
    // prefix ending at candidate unit k; `parents` records the unit each came from.
    let mut previous_row = vec![NO_PATH; candidate_length];
    let mut current_row = vec![NO_PATH; candidate_length];
    let mut parents = vec![NO_PARENT; query_length * candidate_length];

    for candidate_index in 0..candidate_length {
        if candidate_codes[candidate_index] == query_codes[0] {
            current_row[candidate_index] = character_score(candidate_index, 0)
                - LEADING_GAP_PENALTY_PER_CHARACTER * units(candidate_index);
        }
    }

    for query_index in 1..query_length {
        std::mem::swap(&mut previous_row, &mut current_row);
        current_row.fill(NO_PATH);
        // Entering unit k, this holds the best of `previous_row[j] - GAP * (k - 2 - j)` over
        // j <= k - 2, so the best transition across a gap into k is that less one more GAP.
        let mut best_gap_reachable_score = NO_PATH;
        let mut best_gap_reachable_index = NO_PARENT;
        for candidate_index in query_index..candidate_length {
            let arriving_score = previous_row[candidate_index - 1];
            let decayed_score = if best_gap_reachable_score == NO_PATH {
                NO_PATH
            } else {
                best_gap_reachable_score - GAP_PENALTY_PER_CHARACTER
            };
            if candidate_codes[candidate_index] == query_codes[query_index] {
                let consecutive_option = if arriving_score == NO_PATH {
                    NO_PATH
                } else {
                    arriving_score + CONSECUTIVE_BONUS
                };
                // A tie goes to the consecutive run.
                let transition =
                    if consecutive_option != NO_PATH && consecutive_option >= decayed_score {
                        Some((consecutive_option, unit_index(candidate_index - 1)))
                    } else if decayed_score != NO_PATH && best_gap_reachable_index != NO_PARENT {
                        Some((decayed_score, best_gap_reachable_index))
                    } else {
                        None
                    };
                if let Some((transition_score, parent_index)) = transition {
                    current_row[candidate_index] =
                        transition_score + character_score(candidate_index, query_index);
                    parents[query_index * candidate_length + candidate_index] = parent_index;
                }
            }
            // A tie goes to the nearer unit.
            if arriving_score != NO_PATH && arriving_score >= decayed_score {
                best_gap_reachable_score = arriving_score;
                best_gap_reachable_index = unit_index(candidate_index - 1);
            } else {
                best_gap_reachable_score = decayed_score;
            }
        }
    }

    let mut best: Option<(f64, usize)> = None;
    for (candidate_index, end_score) in current_row.iter().enumerate().skip(query_length - 1) {
        if *end_score == NO_PATH {
            continue;
        }
        let total_score = end_score
            - TRAILING_PENALTY_PER_CHARACTER * units(candidate_length - 1 - candidate_index);
        // Strictly greater, so the earliest end wins a tie.
        if best.is_none_or(|(best_score, _)| total_score > best_score) {
            best = Some((total_score, candidate_index));
        }
    }
    let (score, end_index) = best?;
    let mut matched_indices = vec![0; query_length];
    let mut walk_index = unit_index(end_index);
    for query_index in (0..query_length).rev() {
        matched_indices[query_index] = walk_index;
        if query_index > 0 {
            walk_index = parents[query_index * candidate_length + index_of(walk_index)];
        }
    }
    Some(SubsequenceMatch {
        score,
        matched_indices,
    })
}

/// `count` units as a score term.
#[expect(
    clippy::cast_precision_loss,
    reason = "a label's length in UTF-16 units stays far below 2^52, where f64 is exact"
)]
fn units(count: usize) -> f64 {
    count as f64
}

/// A candidate position as a matched index.
fn unit_index(index: usize) -> u32 {
    u32::try_from(index).expect("a candidate holds fewer than 2^32 UTF-16 units")
}

/// A matched index as a position in the candidate.
fn index_of(index: u32) -> usize {
    usize::try_from(index).expect("a matched index came from a position in the candidate")
}

/// `unit` lower-cased when the lower case stays one UTF-16 unit, as JavaScript's `toLowerCase`
/// leaves the string's length alone only then; a lone surrogate stays itself.
fn folded_unit(unit: u16) -> u16 {
    if let Ok(byte) = u8::try_from(unit)
        && byte.is_ascii()
    {
        return u16::from(byte.to_ascii_lowercase());
    }
    let Some(character) = char::from_u32(u32::from(unit)) else {
        return unit;
    };
    let mut lower = character.to_lowercase();
    match (lower.next(), lower.next()) {
        (Some(only), None) => u16::try_from(u32::from(only)).unwrap_or(unit),
        _ => unit,
    }
}

/// Whether a case map of `unit` gives back that unit alone.
fn maps_to_itself(unit: u16, mut mapped: impl Iterator<Item = char>) -> bool {
    match (mapped.next(), mapped.next()) {
        (Some(only), None) => u32::from(only) == u32::from(unit),
        _ => false,
    }
}

/// JavaScript's `c !== c.toUpperCase() && c === c.toLowerCase()` on one unit.
fn is_lowercase_letter(unit: u16) -> bool {
    if let Ok(byte) = u8::try_from(unit)
        && byte.is_ascii()
    {
        return byte.is_ascii_lowercase();
    }
    char::from_u32(u32::from(unit)).is_some_and(|character| {
        !maps_to_itself(unit, character.to_uppercase())
            && maps_to_itself(unit, character.to_lowercase())
    })
}

/// JavaScript's `c !== c.toLowerCase() && c === c.toUpperCase()` on one unit.
fn is_uppercase_letter(unit: u16) -> bool {
    if let Ok(byte) = u8::try_from(unit)
        && byte.is_ascii()
    {
        return byte.is_ascii_uppercase();
    }
    char::from_u32(u32::from(unit)).is_some_and(|character| {
        !maps_to_itself(unit, character.to_lowercase())
            && maps_to_itself(unit, character.to_uppercase())
    })
}

fn is_ascii_digit(unit: u16) -> bool {
    (u16::from(b'0')..=u16::from(b'9')).contains(&unit)
}

fn is_separator(unit: u16) -> bool {
    u8::try_from(unit).is_ok_and(|byte| WORD_SEPARATOR_CHARACTERS.contains(&byte))
}

/// For each unit, whether a word starts there: the first unit, a unit after a separator, or an
/// upper-case letter after a lower-case letter or a digit, so `parseJSONPayload` has boundaries at
/// `p`, `J` and `P`.
fn word_boundary_flags(candidate: &[u16]) -> Vec<bool> {
    (0..candidate.len())
        .map(|index| {
            let Some(previous) = index.checked_sub(1).map(|before| candidate[before]) else {
                return true;
            };
            is_separator(previous)
                || (is_uppercase_letter(candidate[index])
                    && (is_lowercase_letter(previous) || is_ascii_digit(previous)))
        })
        .collect()
}

/// Whether `query_codes` is a subsequence of `candidate_codes`: one greedy pass is exact for
/// existence, though not for quality, so it bails out before the dynamic program.
fn is_subsequence(candidate_codes: &[u16], query_codes: &[u16]) -> bool {
    let mut cursor = 0;
    for unit in candidate_codes {
        if cursor == query_codes.len() {
            break;
        }
        if *unit == query_codes[cursor] {
            cursor += 1;
        }
    }
    cursor == query_codes.len()
}

/// The WebAssembly module's exports, which the renderer calls. The page writes text into the
/// module's own buffers and reads results back from them; a buffer's address holds only until the
/// next call that resizes it, and the module runs on one thread with no call re-entering it.
#[cfg(target_arch = "wasm32")]
#[expect(
    unsafe_code,
    reason = "the page calls the matcher through exported C functions over the module's buffers"
)]
pub mod exports {
    use std::cell::RefCell;

    use super::score_subsequence;

    /// The buffers the exports share between calls.
    #[derive(Default)]
    struct Buffers {
        scratch: Vec<u16>,
        indices: Vec<u32>,
        list_units: Vec<u16>,
        list_offsets: Vec<u32>,
        scores: Vec<f64>,
    }

    thread_local! {
        static BUFFERS: RefCell<Buffers> = RefCell::new(Buffers::default());
    }

    fn length(count: u32) -> usize {
        usize::try_from(count).expect("a wasm32 usize holds every u32")
    }

    /// Sizes the scratch buffer to `units` UTF-16 units and returns its address, where a call to
    /// `score` reads the candidate then the query, or `score_list` the query.
    #[unsafe(no_mangle)]
    pub extern "C" fn scratch(units: u32) -> *mut u16 {
        BUFFERS.with_borrow_mut(|buffers| {
            buffers.scratch.resize(length(units), 0);
            buffers.scratch.as_mut_ptr()
        })
    }

    /// The address of the matched indices the last `score` or `score_list` wrote.
    #[unsafe(no_mangle)]
    pub extern "C" fn indices() -> *const u32 {
        BUFFERS.with_borrow(|buffers| buffers.indices.as_ptr())
    }

    /// Scores the candidate in the scratch buffer's first `candidate_length` units against the
    /// `query_length` units after it; returns the score, or NaN when the query does not match or
    /// the lengths pass the buffer. The matched indices are at `indices()`.
    #[unsafe(no_mangle)]
    pub extern "C" fn score(candidate_length: u32, query_length: u32) -> f64 {
        BUFFERS.with_borrow_mut(|buffers| {
            let candidate_end = length(candidate_length);
            let query_end = candidate_end.saturating_add(length(query_length));
            let (Some(candidate), Some(query)) = (
                buffers.scratch.get(..candidate_end),
                buffers.scratch.get(candidate_end..query_end),
            ) else {
                return f64::NAN;
            };
            match score_subsequence(candidate, query) {
                Some(found) => {
                    buffers.indices = found.matched_indices;
                    found.score
                }
                None => f64::NAN,
            }
        })
    }

    /// Sizes the list for `units` UTF-16 units across `count` candidates and returns the units'
    /// address; the page writes the candidates there, back to back, and their `count + 1` offsets
    /// at `list_offsets()`.
    #[unsafe(no_mangle)]
    pub extern "C" fn list_reserve(units: u32, count: u32) -> *mut u16 {
        BUFFERS.with_borrow_mut(|buffers| {
            buffers.list_units.resize(length(units), 0);
            buffers.list_offsets.resize(length(count) + 1, 0);
            buffers.scores.resize(length(count), f64::NAN);
            buffers.list_units.as_mut_ptr()
        })
    }

    /// The address of the list's `count + 1` offsets, each where a candidate starts in the list's
    /// units, the last where the units end.
    #[unsafe(no_mangle)]
    pub extern "C" fn list_offsets() -> *mut u32 {
        BUFFERS.with_borrow_mut(|buffers| buffers.list_offsets.as_mut_ptr())
    }

    /// The address of each candidate's score from the last `score_list`, NaN where it missed.
    #[unsafe(no_mangle)]
    pub extern "C" fn list_scores() -> *const f64 {
        BUFFERS.with_borrow(|buffers| buffers.scores.as_ptr())
    }

    /// Scores every listed candidate against the query in the scratch buffer's first
    /// `query_length` units, writing each one's score at `list_scores()` and its `query_length`
    /// matched indices at `indices()`, candidate after candidate; returns how many matched.
    #[unsafe(no_mangle)]
    pub extern "C" fn score_list(query_length: u32) -> u32 {
        BUFFERS.with_borrow_mut(|buffers| {
            let Buffers {
                scratch,
                indices,
                list_units,
                list_offsets,
                scores,
            } = buffers;
            let query_length = length(query_length);
            let query = scratch.get(..query_length).unwrap_or_default();
            let count = scores.len();
            indices.clear();
            indices.resize(count * query_length, 0);
            let mut matched = 0;
            for (index, offsets) in list_offsets.windows(2).enumerate() {
                let candidate = list_units
                    .get(length(offsets[0])..length(offsets[1]))
                    .unwrap_or_default();
                match score_subsequence(candidate, query) {
                    Some(found) => {
                        scores[index] = found.score;
                        indices[index * query_length..(index + 1) * query_length]
                            .copy_from_slice(&found.matched_indices);
                        matched += 1;
                    }
                    None => scores[index] = f64::NAN,
                }
            }
            matched
        })
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::score_subsequence;

    fn utf16(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    // Each score worked out from the constants. `cs` ranks `Copy SHA` (99) over `class` (97.5):
    // both its units open words. `ab` loses one gap penalty per unit skipped. A one-unit query
    // whose two ends total 7 each takes the earlier. A consecutive run and a gap that both reach
    // 14 before `b` take the run.
    #[rstest]
    #[case::an_initialism_reaches_a_candidate_whose_word_starts_it_spells(
        "Copy SHA",
        "cs",
        99.0,
        &[0, 5]
    )]
    #[case::letters_mid_word_score_below_word_starts("class", "cs", 97.5, &[0, 3])]
    #[case::one_unit_gap("axb", "ab", 101.0, &[0, 2])]
    #[case::two_unit_gap("axxb", "ab", 98.0, &[0, 3])]
    #[case::earliest_end_tie(&format!("XA{}a", "X".repeat(15)), "a", 7.0, &[1])]
    #[case::consecutive_run_tie(&format!("a{}Ab", "X".repeat(21)), "ab", 38.0, &[22, 23])]
    fn scores_the_best_embedding(
        #[case] candidate: &str,
        #[case] query: &str,
        #[case] score: f64,
        #[case] matched_indices: &[u32],
    ) {
        let found = score_subsequence(&utf16(candidate), &utf16(query)).expect("the query matches");
        // Compared as text: each expected score is exact in binary, and text reads well on failure.
        assert_eq!(
            (found.score.to_string(), found.matched_indices),
            (score.to_string(), matched_indices.to_vec())
        );
    }

    #[rstest]
    #[case::a_scrambled_order("Copy SHA", "sc")]
    #[case::a_unit_the_candidate_lacks("class", "csx")]
    #[case::a_query_longer_than_the_candidate("cs", "css")]
    #[case::an_empty_query("class", "")]
    fn a_query_that_is_not_a_case_insensitive_subsequence_matches_nothing(
        #[case] candidate: &str,
        #[case] query: &str,
    ) {
        assert_eq!(score_subsequence(&utf16(candidate), &utf16(query)), None);
    }

    #[rstest]
    #[case::adjacent_matches_rank_over_scattered_ones("ab", "abxx", "axbx")]
    #[case::a_prefix_match_ranks_first("run", "Run tests", "Stop run")]
    fn ranks_the_better_candidate_over_the_worse(
        #[case] query: &str,
        #[case] better: &str,
        #[case] worse: &str,
    ) {
        let score_of = |candidate: &str| {
            score_subsequence(&utf16(candidate), &utf16(query))
                .expect("the query matches")
                .score
        };
        assert!(
            score_of(better) > score_of(worse),
            "{better} scores {} and {worse} {}",
            score_of(better),
            score_of(worse)
        );
    }

    #[test]
    fn matched_indices_point_at_the_original_candidates_utf16_units() {
        // The emoji takes two UTF-16 units and four UTF-8 bytes, so `É` sits at unit 3, character
        // 2 and byte 5; `ét` matches it folded to lower case.
        let found = score_subsequence(&utf16("😀 Été"), &utf16("ét")).expect("the query matches");
        assert_eq!(found.matched_indices, vec![3, 4]);
    }
}
