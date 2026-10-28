//! Codex's app-server protocol as this crate's build generates it from one Codex release's schema
//! bundle: the types the provider crate sends, with every type they reach, and the notification
//! and server request methods the protocol names. What the provider crate receives is read by
//! hand-written readers instead, which ignore what a newer release adds.
#![expect(
    unreachable_pub,
    reason = "the generator writes `pub` items, which this private module keeps inside the driver"
)]
#![expect(
    dead_code,
    reason = "the generator writes every type a sent type reaches, and the driver sends only some"
)]
#![expect(
    clippy::doc_markdown,
    clippy::enum_variant_names,
    reason = "the generator copies the schema's descriptions and names as Codex writes them"
)]

include!(concat!(env!("OUT_DIR"), "/codex_app_server_protocol.rs"));
