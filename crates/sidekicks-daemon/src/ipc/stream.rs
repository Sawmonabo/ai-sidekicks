//! Subscriptions' streams: the open subscriptions and their frames, what a feed is pulled through,
//! how a change stream's frames are batched from its stored record, and the newest-value feed.

pub(crate) mod feed;
pub(crate) mod frame_batcher;
pub(crate) mod latest_value;
pub(crate) mod subscriptions;
