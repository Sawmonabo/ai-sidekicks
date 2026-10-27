//! An event's body: how it is split from the envelope on append, stored, and joined back on read.

pub mod append;
pub mod codec;
pub mod read;
