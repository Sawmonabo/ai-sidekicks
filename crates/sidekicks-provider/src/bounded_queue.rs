//! A queue kept at a bound by forgetting its oldest entry, for what is remembered only while it is
//! recent.

use std::collections::VecDeque;

/// Pushes `entry` onto `kept`, the oldest forgotten past `bound`.
pub(crate) fn remember<T>(kept: &mut VecDeque<T>, entry: T, bound: usize) {
    if kept.len() >= bound {
        kept.pop_front();
    }
    kept.push_back(entry);
}
