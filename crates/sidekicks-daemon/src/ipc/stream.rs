//! Subscriptions' streams: what a feed is pulled through and how a change stream's frames are
//! batched from its stored record.

pub(crate) mod feed;
pub(crate) mod frame_batcher;
