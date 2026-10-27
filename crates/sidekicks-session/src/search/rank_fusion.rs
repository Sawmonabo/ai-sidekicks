//! Reciprocal Rank Fusion: several ranked lists of the same items merged into one, each list
//! adding 1/(60 + rank) for every item it ranks, with rank counted from one.

use std::collections::HashMap;
use std::hash::Hash;

/// The constant from the method's original paper, which keeps one list's top item from swamping
/// an item every list ranks well.
const RANK_FUSION_OFFSET: f64 = 60.0;

/// Merges ranked lists into one, best first: an item's score is the sum over the lists that rank
/// it of 1/(60 + its rank there). Ties keep the order of first appearance across the lists.
#[expect(
    dead_code,
    reason = "the agents' session_search tool merges text and relation ranks"
)]
pub(crate) fn fuse_ranked_lists<Item: Clone + Eq + Hash>(ranked_lists: &[&[Item]]) -> Vec<Item> {
    // Scores in order of first appearance, and each item's place among them.
    let mut scores: Vec<(Item, f64)> = Vec::new();
    let mut places: HashMap<Item, usize> = HashMap::new();
    for ranked_list in ranked_lists {
        let mut rank = RANK_FUSION_OFFSET;
        for item in *ranked_list {
            rank += 1.0;
            let place = *places.entry(item.clone()).or_insert_with(|| {
                scores.push((item.clone(), 0.0));
                scores.len() - 1
            });
            scores[place].1 += 1.0 / rank;
        }
    }
    // The sort is stable, so ties keep first appearance.
    scores.sort_by(|left, right| right.1.total_cmp(&left.1));
    scores.into_iter().map(|(item, _)| item).collect()
}
