//! What a provider's requests cost, kept apart from any one provider: the price list's rates and
//! everything that prices a request from them, the repricing of requests held until a copy or a
//! sign-in kind prices them, the receiver of the providers' telemetry exports, and each process's
//! export status.

pub mod decimal;
pub(crate) mod export_status;
mod fetch;
pub mod held;
pub mod list;
pub(crate) mod live;
pub(crate) mod quote;
pub mod receiver;
pub mod rule;
pub mod store;
#[cfg(test)]
pub(crate) mod test_fixture;

use std::error::Error;

/// A failure a pricing port or store answers, boxed so each port keeps its own error type.
pub(crate) type BoxedError = Box<dyn Error + Send + Sync>;
