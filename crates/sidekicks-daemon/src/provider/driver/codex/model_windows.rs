//! Each Codex model's context windows, read from the raw catalog `codex debug models` prints:
//! `model/list` carries no window, while each catalog row carries the model's default window and
//! the largest one it can be set to.

use std::collections::HashMap;
use std::error::Error;
use std::future::Future;

use serde_json::{Map, Value, json};
use sidekicks_contracts::provider::driver::capabilities::ProviderModel;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::error_description::describe_error;
use crate::provider::driver::codex::DESCRIPTOR;
use crate::provider::driver::codex::service::home::CodexServiceHome;
use crate::provider::driver::contract::bound_failure_detail;
use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::provider::driver::error_causes::{
    ModelCatalogUnreadable, UNSPECIFIED_PROVIDER_FAILURE_DETAIL,
};

/// The catalog dump's name, as an unreadable catalog's refusal names it.
const CODEX_CATALOG_DUMP_NAME: &str = "Codex debug models";

/// The windows Codex's catalog gives one model, in tokens; either may be absent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CodexModelWindow {
    /// The model's default window.
    pub(crate) context_window: Option<u64>,
    /// The largest window the model can be set to.
    pub(crate) max_context_window: Option<u64>,
}

/// A catalog row left out of the windows, named by its slug when one could be read.
struct RejectedModelRow {
    slug: Option<String>,
    detail: String,
}

/// One dump read: each model's windows by slug, and the rows that could not be read.
struct ModelWindowReading {
    windows: HashMap<String, CodexModelWindow>,
    rejected_rows: Vec<RejectedModelRow>,
}

/// Each model's windows from the service's own catalog dump, which `dump` reads by running
/// `codex debug models`. Never fails: a failed read, or a row that could not be read, is reported
/// as `modelWindowReadFailed` and leaves those models without a window.
#[expect(
    dead_code,
    reason = "the Codex driver's model list joins each model's windows from it"
)]
pub(crate) async fn read_codex_service_model_windows(
    dump: impl Future<Output = Result<String, impl Error + 'static>>,
    home: &CodexServiceHome,
) -> HashMap<String, CodexModelWindow> {
    let reading = match dump.await {
        Ok(dump) => read_model_windows(&dump).map_err(|error| describe_error(&error)),
        Err(error) => Err(describe_error(&error)),
    };
    let reading = match reading {
        Ok(reading) => reading,
        Err(detail) => {
            report_window_read_failed(home, &detail, None);
            return HashMap::new();
        }
    };
    for rejected in &reading.rejected_rows {
        report_window_read_failed(home, &rejected.detail, rejected.slug.as_deref());
    }
    reading.windows
}

/// The `model/list` rows with their window set where the catalog gives the row's id one: the
/// default window, else the largest, as Codex resolves it. A model whose largest window exceeds
/// its default gets a second row right after it, the same id with `larger_window` set and the
/// largest window. Other rows are returned unchanged.
#[expect(
    dead_code,
    reason = "the Codex driver's model list joins each model's windows with it"
)]
pub(crate) fn join_codex_model_windows(
    models: Vec<ProviderModel>,
    windows: &HashMap<String, CodexModelWindow>,
) -> Vec<ProviderModel> {
    models
        .into_iter()
        .flat_map(|model| {
            let window = windows.get(model.id.as_str());
            let context_window = window
                .and_then(|window| window.context_window.or(window.max_context_window))
                .and_then(SafeInt::new);
            let Some(context_window) = context_window else {
                return vec![model];
            };
            let larger_window = window
                .and_then(|window| find_larger_window(*window))
                .and_then(SafeInt::new);
            let default_row = ProviderModel {
                context_window: Some(context_window),
                ..model
            };
            match larger_window {
                Some(larger_window) => {
                    let larger_row = ProviderModel {
                        context_window: Some(larger_window),
                        larger_window: true,
                        ..default_row.clone()
                    };
                    vec![default_row, larger_row]
                }
                None => vec![default_row],
            }
        })
        .collect()
}

/// The larger window, in tokens, a `codex debug models` dump offers `model_id`, as its picker row
/// shows it; `None` for a model with one window or none listed. Fails with
/// [`ModelCatalogUnreadable`] when the dump, or the model's own row, cannot be read.
#[expect(
    dead_code,
    reason = "the Codex session's create checks the larger window it was asked for against it"
)]
pub(crate) fn read_codex_larger_window(
    dump: &str,
    model_id: &str,
) -> Result<Option<u64>, ModelCatalogUnreadable> {
    let reading = read_model_windows(dump)?;
    if let Some(rejected) = reading
        .rejected_rows
        .iter()
        .find(|rejected| rejected.slug.as_deref() == Some(model_id))
    {
        return Err(catalog_unreadable(&format!(
            "the row of model '{model_id}' is unreadable ({})",
            rejected.detail
        )));
    }
    Ok(reading
        .windows
        .get(model_id)
        .and_then(|window| find_larger_window(*window)))
}

// Reads the dump row by row: a row that fails is left out among the rejected rows, and a row with
// neither window is left out. Fails when the dump is not JSON or has no `models` array.
fn read_model_windows(dump: &str) -> Result<ModelWindowReading, ModelCatalogUnreadable> {
    let parsed: Value = serde_json::from_str(dump).map_err(|error| {
        catalog_unreadable(&format!(
            "the output is not JSON ({})",
            describe_error(&error)
        ))
    })?;
    let Some(rows) = parsed.get("models").and_then(Value::as_array) else {
        return Err(catalog_unreadable("the output has no `models` array"));
    };
    let mut reading = ModelWindowReading {
        windows: HashMap::new(),
        rejected_rows: Vec::new(),
    };
    for row in rows {
        match read_model_row(row) {
            Ok((slug, window)) => {
                if window.context_window.is_some() || window.max_context_window.is_some() {
                    reading.windows.insert(slug, window);
                }
            }
            Err(detail) => reading.rejected_rows.push(RejectedModelRow {
                slug: row
                    .get("slug")
                    .and_then(Value::as_str)
                    .filter(|slug| !slug.is_empty())
                    .map(str::to_owned),
                detail,
            }),
        }
    }
    Ok(reading)
}

// A row's slug and windows; a row's other members (its instructions, tiers and effort levels) are
// not read here.
fn read_model_row(row: &Value) -> Result<(String, CodexModelWindow), String> {
    let Some(row) = row.as_object() else {
        return Err("the row is not an object".to_owned());
    };
    let slug = row
        .get("slug")
        .and_then(Value::as_str)
        .filter(|slug| !slug.is_empty())
        .ok_or_else(|| "the row has no `slug` text".to_owned())?;
    Ok((
        slug.to_owned(),
        CodexModelWindow {
            context_window: read_window(row, "context_window")?,
            max_context_window: read_window(row, "max_context_window")?,
        },
    ))
}

// A window member: absent, or a positive whole number of tokens.
fn read_window(row: &Map<String, Value>, member: &str) -> Result<Option<u64>, String> {
    match row.get(member) {
        None => Ok(None),
        Some(window) => window
            .as_u64()
            .filter(|tokens| *tokens > 0)
            .map(Some)
            .ok_or_else(|| format!("`{member}` is not a positive whole number")),
    }
}

// A model's largest window, only where it exceeds the default.
fn find_larger_window(window: CodexModelWindow) -> Option<u64> {
    let (Some(context_window), Some(max_context_window)) =
        (window.context_window, window.max_context_window)
    else {
        return None;
    };
    (max_context_window > context_window).then_some(max_context_window)
}

fn catalog_unreadable(detail: &str) -> ModelCatalogUnreadable {
    ModelCatalogUnreadable {
        provider: DESCRIPTOR.provider_id(),
        reply_name: CODEX_CATALOG_DUMP_NAME,
        detail: bound_failure_detail(detail, UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone()),
    }
}

fn report_window_read_failed(home: &CodexServiceHome, detail: &str, slug: Option<&str>) {
    let mut details = Map::from_iter([(
        "codexHome".to_owned(),
        json!(home.codex_home.to_string_lossy()),
    )]);
    if let Some(slug) = slug {
        details.insert("slug".to_owned(), json!(slug));
    }
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id: home.provider_account_id.clone(),
        kind: DriverDiagnosticKind::ModelWindowReadFailed,
        raw_wire_type: None,
        disposition_reason: detail.to_owned(),
        details,
    });
}
