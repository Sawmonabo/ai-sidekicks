//! Codex's app-server protocol as the daemon's build generates it from one Codex release's schema
//! bundle: the types the daemon sends, with every type they reach, and the notification methods
//! the protocol names. What the daemon receives is read by hand-written readers instead, which
//! ignore what a newer release adds.
#![expect(
    unreachable_pub,
    reason = "the generator writes `pub` items, which this private module keeps inside the driver"
)]
#![expect(
    dead_code,
    reason = "the generator writes every type a sent type reaches, and the driver sends only some"
)]

include!(concat!(env!("OUT_DIR"), "/codex_app_server_protocol.rs"));
