//! What a provider's requests cost, kept apart from any one provider: the price list's rates and
//! everything that prices a request from them, the repricing of requests held until a copy or a
//! sign-in kind prices them, the receiver of the providers' telemetry exports, and each process's
//! export status.

pub mod decimal;
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "each driver's telemetry feeds it")
)]
pub(crate) mod export_status;
mod fetch;
pub mod held;
pub mod list;
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "each driver prices its live requests through it")
)]
pub(crate) mod live;
pub(crate) mod quote;
pub mod receiver;
pub mod rule;
pub mod store;
#[cfg(test)]
mod test_fixture;
