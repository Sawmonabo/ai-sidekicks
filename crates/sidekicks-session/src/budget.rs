//! A session's two limits, its spend across every provider and the tokens one run may use, each
//! unlimited until set, which are read before every admission and every usage report.

pub mod limits;
pub mod schema;
