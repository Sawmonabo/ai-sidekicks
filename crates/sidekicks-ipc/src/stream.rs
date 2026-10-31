//! Subscriptions' streams: the open subscriptions and their frames, what a feed is pulled through,
//! how a change stream's frames are batched from its stored record, and the newest-value feeds,
//! single and keyed.

pub mod feed;
pub mod frame_batcher;
pub mod latest_value;
pub mod subscriptions;
