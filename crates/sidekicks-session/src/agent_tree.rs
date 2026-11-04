//! A session's tree of provider-native helpers: one row per helper its provider named, keyed by a
//! handle the daemon mints, with its place under its parent and the newest run it carries, a
//! projection written in the run event's own write and rebuilt from the log. Over it sit the tree
//! as a client reads it, the sweep that stops every agent below a run or a session, the lookup the
//! drivers' hooks find a helper by, the read of the helpers a driver re-attaches after a restart,
//! and a person's controls on one child, its interrupt.

pub mod controls;
pub mod lookup;
pub mod projection;
pub mod read;
pub mod reattach;
pub mod schema;
pub mod store;
pub mod sweep;
