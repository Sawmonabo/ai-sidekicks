//! Links between sessions: the rows that record them, and adding and removing them.

#[expect(
    dead_code,
    reason = "the session tools' started links and a fork's copiedFrom link"
)]
pub(crate) mod recorded;
pub mod service;
