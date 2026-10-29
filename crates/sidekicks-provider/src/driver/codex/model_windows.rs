//! Each Codex model's context windows, read from the raw catalog `codex debug models` prints:
//! `model/list` carries no window, while each catalog row carries the model's default window, the
//! largest one it can be set to, the share of it Codex leaves usable and its own compaction point.
//! The windows a home's catalog gave its running build are kept, so a session's reading runs no
//! dump of its own, and each read hands the catalog to the calibration.

use std::collections::HashMap;
use std::error::Error;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use sidekicks_contracts::provider::driver::capabilities::ProviderModel;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::mutex_lock::lock;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::calibration::CodexCompactionLimits;
use crate::driver::codex::service::command::read_codex_model_catalog_dump;
use crate::driver::codex::service::home::CodexServiceHome;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::contract::error::bound_failure_detail;
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::driver::error_causes::{ModelCatalogUnreadable, UNSPECIFIED_PROVIDER_FAILURE_DETAIL};

/// The catalog dump's name, as an unreadable catalog's refusal names it.
const CODEX_CATALOG_DUMP_NAME: &str = "Codex debug models";

/// The share of a window Codex leaves usable where a catalog row names none, in percent.
pub(crate) const CODEX_DEFAULT_USABLE_PERCENT: u64 = 95;

/// The share of the whole window Codex compacts at where nothing lowers it, in percent.
pub(crate) const CODEX_DEFAULT_COMPACTION_PERCENT: u64 = 90;

/// One model's windows as Codex's catalog gives them, in tokens; either window may be absent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CodexModelWindow {
    /// The model's default window.
    pub(crate) context_window: Option<u64>,
    /// The largest window the model can be set to.
    pub(crate) max_context_window: Option<u64>,
    /// The share of the window Codex leaves usable, in percent.
    pub(crate) usable_percent: u64,
    /// The compaction point the catalog sets for the model, where it sets one.
    pub(crate) auto_compact_token_limit: Option<u64>,
}

impl CodexModelWindow {
    /// The whole window a conversation runs, as Codex resolves it: `requested` within the
    /// largest, else the default, else the largest.
    pub(crate) fn whole_window(&self, requested: Option<u64>) -> Option<u64> {
        match requested {
            Some(requested) => Some(
                self.max_context_window
                    .map_or(requested, |largest| requested.min(largest)),
            ),
            None => self.context_window.or(self.max_context_window),
        }
    }

    /// The usable window Codex reports for a conversation on `requested`'s window.
    pub(crate) fn usable_window(&self, requested: Option<u64>) -> Option<u64> {
        self.whole_window(requested)
            .map(|whole| whole.saturating_mul(self.usable_percent) / 100)
    }

    /// Where Codex compacts a conversation on `requested`'s window by default: nine tenths of the
    /// whole window, or the catalog's own point where that is lower.
    pub(crate) fn default_compaction_limit(&self, requested: Option<u64>) -> Option<u64> {
        let point = self
            .whole_window(requested)
            .map(|whole| whole.saturating_mul(CODEX_DEFAULT_COMPACTION_PERCENT) / 100);
        match (point, self.auto_compact_token_limit) {
            (Some(point), Some(limit)) => Some(point.min(limit)),
            (point, limit) => point.or(limit),
        }
    }

    /// The model's largest window, only where it exceeds the default.
    pub(crate) fn larger_window(&self) -> Option<u64> {
        let (Some(context_window), Some(max_context_window)) =
            (self.context_window, self.max_context_window)
        else {
            return None;
        };
        (max_context_window > context_window).then_some(max_context_window)
    }
}

/// Each model's windows by its slug.
pub(crate) type CodexModelWindows = HashMap<String, CodexModelWindow>;

/// One read of a home's catalog: the dump as Codex printed it and each model's windows in it.
#[derive(Clone)]
pub(crate) struct CodexCatalogReading {
    /// The dump, as `codex debug models` printed it.
    pub(crate) dump: Arc<str>,
    /// Each model's windows the dump gives.
    pub(crate) windows: Arc<CodexModelWindows>,
}

/// The windows each Codex home's catalog last gave, kept for the build that printed them.
pub(crate) struct CodexModelWindowCache {
    /// Never held across an await.
    readings: Mutex<HashMap<PathBuf, CachedModelWindows>>,
    compaction_limits: Arc<CodexCompactionLimits>,
}

struct CachedModelWindows {
    provider_version: String,
    windows: Arc<CodexModelWindows>,
}

impl CodexModelWindowCache {
    /// No windows kept yet; each catalog read is handed to `compaction_limits` to calibrate.
    pub(crate) fn new(compaction_limits: Arc<CodexCompactionLimits>) -> Self {
        Self {
            readings: Mutex::default(),
            compaction_limits,
        }
    }

    /// The windows kept for `service`'s home and running build, `None` before a read of them.
    pub(crate) fn cached(&self, service: &CodexService) -> Option<Arc<CodexModelWindows>> {
        let provider_version = service.version_reading()?.report.raw_version;
        lock(&self.readings)
            .get(&service.home().codex_home)
            .filter(|cached| cached.provider_version == provider_version)
            .map(|cached| Arc::clone(&cached.windows))
    }

    /// The windows kept for `service`, else read from its catalog now and kept. Never fails, as
    /// [`read_codex_service_model_windows`].
    pub(crate) async fn read(&self, service: &Arc<CodexService>) -> Arc<CodexModelWindows> {
        match self.cached(service) {
            Some(windows) => windows,
            None => self.refresh(service).await,
        }
    }

    /// The windows `service`'s catalog gives now, kept in place of an earlier read for a running
    /// build, and the catalog handed to the calibration. A read that gave none is not kept, so the
    /// next asks again. Never fails, as [`read_codex_service_model_windows`].
    pub(crate) async fn refresh(&self, service: &Arc<CodexService>) -> Arc<CodexModelWindows> {
        let dump = read_codex_model_catalog_dump(service).await;
        let windows = Arc::new(read_codex_service_model_windows(
            dump.as_deref()
                .map_err(|error| error as &(dyn Error + 'static)),
            service.home(),
        ));
        let (Ok(dump), Some(version)) = (dump, service.version_reading()) else {
            return windows;
        };
        if windows.is_empty() {
            return windows;
        }
        let provider_version = version.report.raw_version;
        lock(&self.readings).insert(
            service.home().codex_home.clone(),
            CachedModelWindows {
                provider_version: provider_version.clone(),
                windows: Arc::clone(&windows),
            },
        );
        self.compaction_limits.calibrate_catalog(
            service,
            &provider_version,
            &CodexCatalogReading {
                dump: Arc::from(dump),
                windows: Arc::clone(&windows),
            },
        );
        windows
    }
}

/// A catalog row left out of the windows, named by its slug when one could be read.
struct RejectedModelRow {
    slug: Option<String>,
    detail: String,
}

/// One dump read: each model's windows by slug, and the rows that could not be read.
struct ModelWindowReading {
    windows: CodexModelWindows,
    rejected_rows: Vec<RejectedModelRow>,
}

/// Each model's windows from the service's own catalog dump, as `codex debug models` printed it
/// or failed to. Never fails: a failed read, or a row that could not be read, is reported as
/// `modelWindowReadFailed` and leaves those models without a window.
pub(crate) fn read_codex_service_model_windows(
    dump: Result<&str, &(dyn Error + 'static)>,
    home: &CodexServiceHome,
) -> CodexModelWindows {
    let reading = match dump {
        Ok(dump) => read_model_windows(dump).map_err(|error| describe_error(&error)),
        Err(error) => Err(describe_error(error)),
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
pub(crate) fn join_codex_model_windows(
    models: Vec<ProviderModel>,
    windows: &CodexModelWindows,
) -> Vec<ProviderModel> {
    models
        .into_iter()
        .flat_map(|model| {
            let window = windows.get(model.id.as_str());
            let context_window = window
                .and_then(|window| window.whole_window(None))
                .and_then(SafeInt::new);
            let Some(context_window) = context_window else {
                return vec![model];
            };
            let larger_window = window
                .and_then(CodexModelWindow::larger_window)
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
        .and_then(CodexModelWindow::larger_window))
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

// A row's slug and windows, its usable share defaulting as Codex defaults it; a row's other
// members (its instructions, tiers and effort levels) are not read here.
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
            usable_percent: read_usable_percent(row)?,
            auto_compact_token_limit: read_window(row, "auto_compact_token_limit")?,
        },
    ))
}

// A token count member: absent, or a positive whole number of tokens.
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

// The row's usable share: absent for the default, else a whole percent from 1 to 100.
fn read_usable_percent(row: &Map<String, Value>) -> Result<u64, String> {
    match row.get("effective_context_window_percent") {
        None => Ok(CODEX_DEFAULT_USABLE_PERCENT),
        Some(percent) => percent
            .as_u64()
            .filter(|percent| (1..=100).contains(percent))
            .ok_or_else(|| {
                "`effective_context_window_percent` is not a whole percent from 1 to 100".to_owned()
            }),
    }
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
        provider_account_id: home.provider_account_id().cloned(),
        kind: DriverDiagnosticKind::ModelWindowReadFailed,
        raw_wire_type: None,
        disposition_reason: detail.to_owned(),
        details,
    });
}
