//! What a provider's requests cost: the price list's rates and everything that prices a request
//! from them, kept apart from any one provider.

pub mod decimal;
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "each driver's telemetry feeds it")
)]
pub(crate) mod export_status;
mod fetch;
pub mod list;
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "each driver prices its requests through it")
)]
pub(crate) mod quote;
pub mod receiver;
pub mod rule;
pub mod store;
