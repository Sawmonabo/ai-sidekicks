//! The driver's answers a test of a pause or of a delivery hands back.

use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::driver::contract::DriverError;
use sidekicks_provider::driver::error_causes::RequestUnanswered;

/// The driver's answer when the request went out and no answer came.
pub fn unanswered() -> DriverError {
    DriverError::Unanswered(RequestUnanswered {
        refusal: DomainError::new("the provider did not answer", RefusalCode::ProviderTimeout),
    })
}
