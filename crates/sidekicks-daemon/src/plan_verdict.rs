//! A plan's verdict: what the daemon does when the person keeps planning, builds the plan, or hands
//! it to a fresh session. The seed composes the opening message that carries the plan into that
//! fresh session; the resolution passes every verdict through one entry and settles it.

pub(crate) mod resolve;
pub(crate) mod seed;
