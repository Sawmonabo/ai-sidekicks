//! The control plane: the Cloudflare Worker on `worker` and `axum`, and the library the Compose
//! relay's program serves. Both hosts answer through one router and count the sign-in routes with
//! one rate limiter over the account's SQLite store.

pub mod account;
pub mod account_store;
pub mod rate_limit;
pub mod server;
#[cfg(target_arch = "wasm32")]
mod worker;
