//! The providers' Settings rows applied at the daemon's start: each row's stored value over its
//! driver's default, place by place, before anything provider-facing runs.

use std::collections::BTreeSet;

use futures::future::join_all;
use serde_json::{Map, Value};
use sidekicks_contracts::machine::settings::{ProviderRowValue, ProviderSettingValues};
use sidekicks_contracts::place::Place;
use sidekicks_contracts::provider::declaration::{ProviderDeclarationId, ProviderValue};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::contract::params_and_results::ApplyRowValueParams;
use sidekicks_provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_std::error_description::describe_error;
use tokio_util::sync::CancellationToken;

use crate::daemon::machine_settings::file::MachineSettingsFile;

/// Applies to every driver its Settings rows' values, all drivers at once, each one
/// `settings_file` stores over the driver's default, before anything provider-facing runs: a
/// provider with a lasting service joins it here, or starts it on the same socket, before any
/// session's recovery or capability read reaches for it. Each driver's own start bound is the only
/// bound, and `stop` ends the wait where it stands. A row that fails to apply, or a settings file
/// that cannot be read, is logged and the start goes on. A value changed later is applied by the
/// provider settings' update, through the same driver call.
pub(crate) async fn apply_stored_rows(
    registry: &ProviderRegistry,
    settings_file: &MachineSettingsFile,
    stop: &CancellationToken,
) {
    let applying = async {
        match settings_file.read().await {
            Ok(reading) => apply_row_values(registry, &reading.settings.provider_settings).await,
            Err(error) => tracing::error!(
                error = &error as &(dyn std::error::Error + 'static),
                "the providers' stored settings could not be read, so none was applied"
            ),
        }
    };
    tokio::select! {
        () = applying => {}
        () = stop.cancelled() => {}
    }
}

// Applies to every driver its rows' values, all drivers at once: each value `stored` holds for a
// row over the driver's default for it, place by place.
async fn apply_row_values(registry: &ProviderRegistry, stored: &ProviderSettingValues) {
    join_all(registry.drivers().map(|(provider, driver)| async move {
        let stored_rows = stored
            .as_map()
            .get(provider)
            .map(|rows| rows.as_map().clone())
            .unwrap_or_default();
        let mut defaults = driver.row_defaults().into_map();
        let row_ids: BTreeSet<ProviderDeclarationId> =
            defaults.keys().chain(stored_rows.keys()).cloned().collect();
        for row_id in row_ids {
            let mut values = defaults
                .remove(&row_id)
                .map(placed_values)
                .unwrap_or_default();
            let stored_row = stored_rows.get(&row_id).cloned();
            for (place, value) in stored_row.map(placed_values).unwrap_or_default() {
                match values.iter_mut().find(|(placed, _)| *placed == place) {
                    Some(placed) => placed.1 = value,
                    None => values.push((place, value)),
                }
            }
            for (place, value) in values {
                let applied = driver
                    .apply_row_value(ApplyRowValueParams {
                        row_id: row_id.clone(),
                        place,
                        value,
                    })
                    .await;
                if let Err(error) = applied {
                    report_row_apply_failure(provider, &row_id, &error);
                }
            }
        }
    }))
    .await;
}

// A row's value as each place's value: a switch's entry in each place it names, else one value
// naming no place.
fn placed_values(value: ProviderRowValue) -> Vec<(Option<Place>, Option<ProviderValue>)> {
    match value {
        ProviderRowValue::Places(switches) => switches
            .as_slice()
            .iter()
            .map(|switch| {
                (
                    switch.place.clone(),
                    Some(ProviderValue::Switch(switch.enabled)),
                )
            })
            .collect(),
        ProviderRowValue::Value(text) => vec![(None, text.map(ProviderValue::Text))],
    }
}

fn report_row_apply_failure(
    provider: &ProviderId,
    row_id: &ProviderDeclarationId,
    error: &DriverError,
) {
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: provider.clone(),
        provider_account_id: None,
        kind: DriverDiagnosticKind::SettingsRowApplyFailed,
        raw_wire_type: None,
        disposition_reason: "settings row value not applied at the start; applied again at the \
                             next change"
            .to_owned(),
        details: Map::from_iter([
            ("rowId".to_owned(), Value::from(row_id.as_str())),
            ("message".to_owned(), Value::from(describe_error(error))),
        ]),
    });
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    use futures::FutureExt as _;
    use sidekicks_contracts::machine::settings::{
        MachineSettings, ProviderRowValue, ProviderRowValues,
    };
    use sidekicks_contracts::provider::declaration::{
        ProviderDeclarationId, ProviderPlaceSwitch, ProviderPlaceSwitches, ProviderValue,
    };
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::wire::record::Record;
    use sidekicks_provider::driver::PROVIDERS;
    use sidekicks_provider::driver::contract::MockProviderDriver;
    use sidekicks_provider::driver::contract::params_and_results::ApplyRowValueParams;
    use sidekicks_std::mutex_lock::lock;
    use tokio_util::sync::CancellationToken;

    use super::apply_stored_rows;
    use crate::daemon::machine_settings::file::MachineSettingsFile;
    use crate::daemon::process::providers::test_start::TestStart;

    fn row_id(id: &str) -> ProviderDeclarationId {
        ProviderDeclarationId::new(id.to_owned()).expect("a test row id")
    }

    fn switch_row(enabled: bool) -> ProviderRowValue {
        ProviderRowValue::Places(
            ProviderPlaceSwitches::new(vec![ProviderPlaceSwitch {
                place: None,
                enabled,
            }])
            .expect("one place is within the bounds"),
        )
    }

    fn rows(values: Vec<(&str, ProviderRowValue)>) -> ProviderRowValues {
        Record::new(
            values
                .into_iter()
                .map(|(id, value)| (row_id(id), value))
                .collect::<BTreeMap<_, _>>(),
        )
        .expect("no test row is the prototype key")
    }

    // The stored rows' application applies each row's value: the driver's default where the app
    // stored none, the stored value over it where it did. Killed by leaving the replay out, which
    // applies nothing, or by applying the defaults alone.
    #[tokio::test]
    async fn the_stored_rows_apply_each_rows_stored_value_over_the_drivers_default() {
        let start = TestStart::new();
        let applied = Arc::new(Mutex::new(Vec::new()));
        let mut driver = MockProviderDriver::new();
        driver.expect_row_defaults().returning(|| {
            rows(vec![
                ("reach", switch_row(true)),
                ("style", switch_row(true)),
            ])
        });
        let applying = Arc::clone(&applied);
        driver
            .expect_apply_row_value()
            .returning(move |params: ApplyRowValueParams| {
                lock(&applying).push((
                    params.row_id.as_str().to_owned(),
                    params.place,
                    params.value,
                ));
                async { Ok(()) }.boxed()
            });
        let providers = start.build(vec![driver]).await;
        let provider = ProviderId::new(PROVIDERS[0].id.to_owned()).expect("a table id");
        let settings_path = start.home.path().join("machine-settings.json");
        let settings = MachineSettings {
            provider_settings: Record::new(BTreeMap::from([(
                provider,
                rows(vec![("style", switch_row(false))]),
            )]))
            .expect("no provider id is the prototype key"),
            ..MachineSettings::default()
        };
        std::fs::write(
            &settings_path,
            serde_json::to_vec(&settings).expect("the settings serialize"),
        )
        .expect("the test stores the settings");

        apply_stored_rows(
            &providers.registry,
            &MachineSettingsFile::new(settings_path),
            &CancellationToken::new(),
        )
        .await;

        assert_eq!(
            *lock(&applied),
            [
                ("reach".to_owned(), None, Some(ProviderValue::Switch(true))),
                ("style".to_owned(), None, Some(ProviderValue::Switch(false))),
            ]
        );
    }
}
