//! Codex's log export read for price: the tag each launch carries, which launch an export came
//! from, and each completed response its records state.

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Codex's export reader prices each completed response through it"
    )
)]
mod completed_response;
