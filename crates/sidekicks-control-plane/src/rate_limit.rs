//! The sign-in routes' rate limit: each request is counted against its endpoint group's sliding
//! window per source address, in the account store on both hosts, and one over the limit is
//! refused with a 429 before its route runs.

pub(crate) mod endpoint_groups;
pub mod enforcement_pipeline;
pub mod layer;
pub mod limiter;
