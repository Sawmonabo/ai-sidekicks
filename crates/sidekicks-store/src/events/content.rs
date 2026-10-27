//! An event's body: how it is split from the envelope on append, stored, and joined back on read.

pub(crate) mod append;
pub(crate) mod codec;
pub(crate) mod read;
