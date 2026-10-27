//! git's and ssh's questions during a clone: the broker that hands each one to its clone's owner,
//! and the askpass mode git and ssh run to ask it.

pub(crate) mod broker;
pub(crate) mod program;
