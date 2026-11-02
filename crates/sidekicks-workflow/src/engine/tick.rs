//! The engine's tick: each turn of its loop walks what committed, admits and dispatches the
//! steps the walk readied, and commits what they reported in one write.

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the program's workflow engine, which runs the tick"
    )
)]

mod node_settings;
