//! A queue kept at a bound by forgetting its oldest entry, for what is remembered only while it is
//! recent.

use std::collections::VecDeque;

/// Pushes `entry` onto `kept`, the oldest taken out past `bound` and answered, so a caller that
/// must still decide it can.
pub(crate) fn remember<T>(kept: &mut VecDeque<T>, entry: T, bound: usize) -> Option<T> {
    let forgotten = if kept.len() >= bound {
        kept.pop_front()
    } else {
        None
    };
    kept.push_back(entry);
    forgotten
}
