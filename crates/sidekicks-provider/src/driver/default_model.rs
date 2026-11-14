//! The model a new session of a provider starts on, read from that provider's own catalog.

use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::capabilities::ProviderModel;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_ipc::domain_error::DomainError;

use crate::driver::contract::error::DriverError;

/// The row of `provider`'s catalog `rows` that the catalog marks as the model a new session starts
/// on. Fails with a `provider.capability.unsupported` refusal naming the provider when no row is
/// marked, since the provider then offers no default model.
pub fn read_default_model<'rows>(
    provider: &ProviderId,
    rows: &'rows [ProviderModel],
) -> Result<&'rows ProviderModel, DriverError> {
    rows.iter().find(|row| row.is_default).ok_or_else(|| {
        DomainError::new(
            "The provider's model catalog marks no default model",
            RefusalCode::ProviderCapabilityUnsupported,
        )
        .with_detail(json!({ "providerId": provider.as_str() }))
        .into()
    })
}

#[cfg(test)]
mod tests {
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::provider::driver::capabilities::ProviderModel;

    use super::read_default_model;
    use crate::driver::contract::error::DriverError;
    use crate::driver::registry::{test_provider, test_token};

    fn row(model_id: &str, is_default: bool) -> ProviderModel {
        ProviderModel {
            id: test_token(model_id),
            name: test_token(model_id),
            capabilities: Vec::new(),
            effort_levels: None,
            output_speed_levels: None,
            fast: false,
            larger_window: false,
            is_default,
            context_window: None,
        }
    }

    // Killed by taking the catalog's first model as its default, or by answering one where the
    // catalog marks none.
    #[test]
    fn the_default_model_reader_answers_the_marked_row_and_refuses_an_unmarked_catalog() {
        let provider = test_provider();
        let marked = [
            row("first", false),
            row("second", true),
            row("third", false),
        ];
        let marked_row = read_default_model(&provider, &marked).expect("a row is marked");
        assert_eq!(marked_row.id.as_str(), "second");

        let unmarked = [row("first", false), row("second", false)];
        let Err(DriverError::Refused(refusal)) = read_default_model(&provider, &unmarked) else {
            panic!("a catalog that marks no row must be refused");
        };
        assert_eq!(refusal.code, RefusalCode::ProviderCapabilityUnsupported);
    }
}
