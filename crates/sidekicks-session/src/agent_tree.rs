//! A session's tree of provider-native helpers: one row per helper its provider named, keyed by a
//! handle the daemon mints, with its place under its parent and the newest run it carries. A
//! projection written in the run event's own write and rebuilt from the log.

pub mod projection;
pub mod read;
pub mod schema;
pub mod store;
