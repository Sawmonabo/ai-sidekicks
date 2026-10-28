//! Paths as text: how each operating system spells, joins and compares one, a typed path made
//! absolute and folded on the running system, a path a program printed read back as a path, and
//! one path written relative to another as git writes it.

pub(crate) mod program_output;
pub(crate) mod relative;
pub(crate) mod resolution;
pub(crate) mod rules;
