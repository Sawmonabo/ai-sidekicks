//! Work over many items that each wait mostly on another process or the disk, run as many at once
//! as the machine has processors, so a long list neither runs one by one nor starts every process
//! together.

use std::num::NonZero;
use std::thread::available_parallelism;

use futures::{StreamExt, stream};

use crate::settle_all::{SettleFailures, settle_all};

/// Maps every item through `map`, at most one per processor at a time, and returns the results in
/// the items' order. Every item settles before a failure is returned, the one failure or every one
/// in [`SettleFailures`], so nothing still runs once the caller hears of it.
pub(crate) async fn map_with_processor_bound<Item, Output, Failure, Work>(
    items: impl IntoIterator<Item = Item>,
    map: impl Fn(Item) -> Work,
) -> Result<Vec<Output>, SettleFailures<Failure>>
where
    Work: Future<Output = Result<Output, Failure>>,
{
    let processors = available_parallelism().map_or(1, NonZero::get);
    let mut outcomes: Vec<(usize, Result<Output, Failure>)> =
        stream::iter(items.into_iter().enumerate())
            .map(|(index, item)| {
                let work = map(item);
                async move { (index, work.await) }
            })
            .buffer_unordered(processors)
            .collect()
            .await;
    outcomes.sort_unstable_by_key(|(index, _)| *index);
    settle_all(
        outcomes
            .into_iter()
            .map(|(_, outcome)| outcome)
            .collect::<Vec<_>>(),
        "the work bounded by the processors",
    )
}
