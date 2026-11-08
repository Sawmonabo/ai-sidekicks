//! Codex's log export read for price: the tag each launch carries, which launch an export came
//! from, each completed response its records state, the responses a session's stream stated, and
//! the exported responses a session holds until it can tell a stated one from a new one.

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Codex's export reader prices each completed response through it"
    )
)]
pub(crate) mod completed_response;
pub(crate) mod exports;
pub(crate) mod held_responses;
pub(crate) mod streamed_responses;
