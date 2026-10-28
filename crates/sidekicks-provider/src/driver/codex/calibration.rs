//! Where Codex compacts each model on each window, which no request reports: measured by a
//! calibration run for every model a service's catalog lists, at each read of a catalog its build
//! has not printed before in this daemon run, stored by build, model and window, and answered from
//! memory. A limit failed is tried again at the next catalog read, and one a session asks for that
//! no read measured is read from the store, else measured, on its first ask. A reading made
//! meanwhile falls back to Codex's default point.

mod log_reading;
mod measurement;
mod stand_in;
mod store;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::DatabaseWriter;
use tokio_util::task::TaskTracker;

use crate::driver::codex::calibration::measurement::{
    CodexCalibrationRequest, compose_codex_calibration_catalog, measure_codex_compaction_limit,
    read_codex_calibration_catalog, remove_left_calibration_folder,
};
use crate::driver::codex::calibration::store::{
    CodexMeasuredWindow, read_stored_codex_limit, store_codex_limit,
};
use crate::driver::codex::model_windows::CodexCatalogReading;
use crate::driver::codex::service::supervisor::CodexService;

/// One limit's key in memory: the Codex build, the model and the larger window the session
/// chose, `None` for the model's default.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct CodexLimitKey {
    provider_version: String,
    request: CodexCalibrationRequest,
}

/// Where one limit stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CodexLimitState {
    /// Read or measured now.
    Pending,
    /// Known, in tokens.
    Known(u64),
    /// Its read and measurement failed; it stays unknown until the next catalog read.
    Unknown,
}

/// The Codex compaction limits of one driver, shared by every session.
pub(crate) struct CodexCompactionLimits {
    reads: Arc<DatabaseReadPool>,
    writer: Arc<PortRegistration<Arc<DatabaseWriter>>>,
    tasks: TaskTracker,
    limits: Mutex<HashMap<CodexLimitKey, CodexLimitState>>,
    // The digest of the catalog each build last printed in this daemon run.
    catalog_digests: Mutex<HashMap<String, blake3::Hash>>,
    // The one removal, per daemon run, of the scratch a former run left, done before any run.
    sweep: tokio::sync::OnceCell<()>,
    // Held through each run, since every run takes the one scratch folder.
    runs: tokio::sync::Mutex<()>,
}

impl CodexCompactionLimits {
    /// The limits over the daemon's read pool and its writer's registration, their reads and
    /// measurements run on `tasks`.
    pub(crate) fn new(
        reads: Arc<DatabaseReadPool>,
        writer: Arc<PortRegistration<Arc<DatabaseWriter>>>,
        tasks: TaskTracker,
    ) -> Self {
        Self {
            reads,
            writer,
            tasks,
            limits: Mutex::default(),
            catalog_digests: Mutex::default(),
            sweep: tokio::sync::OnceCell::new(),
            runs: tokio::sync::Mutex::default(),
        }
    }

    /// The limit, in tokens, at which `service`'s Codex build compacts `model_id` on the window
    /// the session runs, `requested_window` where it chose the larger one; `None` while it is read
    /// or measured, after both failed, or for a service whose build is unread. A first ask starts
    /// the read, and the measurement where nothing is stored, in the background.
    pub(crate) fn limit(
        self: &Arc<Self>,
        service: &Arc<CodexService>,
        model_id: &str,
        requested_window: Option<u64>,
    ) -> Option<u64> {
        let provider_version = service.version_reading()?.report.raw_version;
        let key = CodexLimitKey {
            provider_version,
            request: CodexCalibrationRequest {
                model_id: model_id.to_owned(),
                requested_window,
            },
        };
        let mut limits = lock(&self.limits);
        match limits.get(&key) {
            Some(CodexLimitState::Known(limit)) => return Some(*limit),
            Some(CodexLimitState::Pending | CodexLimitState::Unknown) => return None,
            None => {}
        }
        limits.insert(key.clone(), CodexLimitState::Pending);
        drop(limits);
        self.settle(service, key, None);
        None
    }

    /// Measures where `service`'s build compacts every model `catalog` lists, on its default
    /// window and on its larger one, in the background: each limit not known yet, or failed, and
    /// every one again when the build printed another catalog before in this daemon run.
    pub(crate) fn calibrate_catalog(
        self: &Arc<Self>,
        service: &Arc<CodexService>,
        provider_version: String,
        catalog: CodexCatalogReading,
    ) {
        let digest = blake3::hash(catalog.dump.as_bytes());
        let is_catalog_changed = lock(&self.catalog_digests)
            .insert(provider_version.clone(), digest)
            .is_some_and(|before| before != digest);
        let mut limits = lock(&self.limits);
        let due = select_due_limits(
            &limits,
            list_catalog_keys(&provider_version, &catalog),
            is_catalog_changed,
        );
        for key in &due {
            limits.insert(key.clone(), CodexLimitState::Pending);
        }
        drop(limits);
        for key in due {
            // A changed catalog's limits are measured again rather than read from the store,
            // which keeps the former catalog's under the same build, model and window.
            let source = CodexCatalogSource {
                catalog: catalog.clone(),
                is_store_current: !is_catalog_changed,
            };
            self.settle(service, key, Some(source));
        }
    }

    // Reads or measures `key`'s limit in the background and keeps what came of it.
    fn settle(
        self: &Arc<Self>,
        service: &Arc<CodexService>,
        key: CodexLimitKey,
        source: Option<CodexCatalogSource>,
    ) {
        let compaction_limits = Arc::clone(self);
        let service = Arc::clone(service);
        self.tasks.spawn(async move {
            // The first ask of a daemon run clears what a crashed run left.
            compaction_limits.sweep_left_scratch(&service).await;
            let state = match compaction_limits
                .read_or_measure(&service, &key, source)
                .await
            {
                Ok(limit) => CodexLimitState::Known(limit),
                Err(error) => {
                    tracing::warn!(
                        error = &*error as &(dyn std::error::Error + 'static),
                        model = %key.request.model_id,
                        version = %key.provider_version,
                        "the codex compaction limit could not be read or measured"
                    );
                    CodexLimitState::Unknown
                }
            };
            lock(&compaction_limits.limits).insert(key, state);
        });
    }

    // The stored limit of `key`'s build, model and window where the store is current, else one
    // measured now and stored; on `source`'s catalog where one was read, else the service's own.
    async fn read_or_measure(
        &self,
        service: &CodexService,
        key: &CodexLimitKey,
        source: Option<CodexCatalogSource>,
    ) -> Result<u64, Box<dyn std::error::Error + Send + Sync>> {
        let (catalog, is_store_current) = match source {
            Some(source) => (
                compose_codex_calibration_catalog(&source.catalog, &key.request)?,
                source.is_store_current,
            ),
            None => (
                read_codex_calibration_catalog(service, &key.request).await?,
                true,
            ),
        };
        let measured = CodexMeasuredWindow {
            provider_version: key.provider_version.clone(),
            model_id: key.request.model_id.clone(),
            window_tokens: catalog.window_tokens,
        };
        if is_store_current
            && let Some(limit) = read_stored_codex_limit(&self.reads, &measured).await?
        {
            return Ok(limit);
        }
        self.sweep_left_scratch(service).await;
        let run_turn = self.runs.lock().await;
        let limit =
            measure_codex_compaction_limit(service, &catalog, &key.request.model_id).await?;
        drop(run_turn);
        let writer = self.writer.require_port()?;
        store_codex_limit(writer, &measured, limit).await?;
        Ok(limit)
    }

    async fn sweep_left_scratch(&self, service: &CodexService) {
        self.sweep
            .get_or_init(|| remove_left_calibration_folder(&service.dependencies().data_folder))
            .await;
    }
}

/// A catalog read a limit is settled on, and whether the store still holds its build's limits.
struct CodexCatalogSource {
    catalog: CodexCatalogReading,
    is_store_current: bool,
}

// Every limit `catalog` lists for `provider_version`: each model's default window, and its larger
// one where it offers one.
fn list_catalog_keys(provider_version: &str, catalog: &CodexCatalogReading) -> Vec<CodexLimitKey> {
    catalog
        .windows
        .iter()
        .flat_map(|(model_id, window)| {
            std::iter::once(None)
                .chain(window.larger_window().map(Some))
                .map(|requested_window| CodexLimitKey {
                    provider_version: provider_version.to_owned(),
                    request: CodexCalibrationRequest {
                        model_id: model_id.clone(),
                        requested_window,
                    },
                })
        })
        .collect()
}

// The limits of `keys` a catalog read settles: each not known yet or failed, and every one when
// the catalog changed.
fn select_due_limits(
    limits: &HashMap<CodexLimitKey, CodexLimitState>,
    keys: Vec<CodexLimitKey>,
    is_catalog_changed: bool,
) -> Vec<CodexLimitKey> {
    keys.into_iter()
        .filter(|key| match limits.get(key) {
            None | Some(CodexLimitState::Unknown) => true,
            Some(CodexLimitState::Pending | CodexLimitState::Known(_)) => is_catalog_changed,
        })
        .collect()
}

#[cfg(test)]
mod tests;
