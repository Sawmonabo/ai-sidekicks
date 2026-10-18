//! The client's transport: the daemon's local socket, one connection's reader and writer over the
//! frame codec, the JSON-RPC client that owns the calls and the subscription streams it hands out.

pub mod json_rpc;
pub mod link;
pub mod local_socket;
pub mod subscription;
