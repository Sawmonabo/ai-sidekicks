//! Where Codex compacts each model on each window, which no request reports: measured by a
//! calibration run for every model a service's catalog lists, at each catalog read, stored by
//! build, model, window and the catalog's digest, and answered from memory. A limit is settled
//! once per catalog: one that failed is tried again only once its build prints another catalog,
//! or in the next daemon run, and a settle whose catalog was replaced meanwhile is done again on
//! the newer one. A limit a session asks for that no read settled is settled on its first ask. A
//! reading made meanwhile falls back to Codex's default point.

mod log_reading;
mod measurement;
mod stand_in;
pub(in crate::driver) mod store;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::DatabaseWriter;
use tokio_util::task::TaskTracker;

use crate::driver::codex::calibration::measurement::{
    CodexCalibrationRequest, compose_codex_calibration_catalog, measure_codex_compaction_limit,
    read_codex_service_catalog, remove_left_calibration_folder,
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
    /// Read or measured now, by the one settle the key runs at a time.
    Pending,
    /// Known, in tokens, for the catalog of `digest`.
    Known { limit: u64, digest: blake3::Hash },
    /// Its read and measurement failed on the catalog of `digest`, `None` where no catalog could
    /// be read; it stays unknown until its build prints another catalog.
    Unknown { digest: Option<blake3::Hash> },
}

/// The Codex compaction limits of one driver, shared by every session.
pub(crate) struct CodexCompactionLimits {
    reads: Arc<DatabaseReadPool>,
    writer: Arc<PortRegistration<Arc<DatabaseWriter>>>,
    tasks: TaskTracker,
    limits: Mutex<HashMap<CodexLimitKey, CodexLimitState>>,
    // The catalog each build last printed in this daemon run, with its digest.
    catalogs: Mutex<HashMap<String, (blake3::Hash, CodexCatalogReading)>>,
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
            catalogs: Mutex::default(),
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
            Some(CodexLimitState::Known { limit, .. }) => return Some(*limit),
            Some(CodexLimitState::Pending | CodexLimitState::Unknown { .. }) => return None,
            None => {}
        }
        limits.insert(key.clone(), CodexLimitState::Pending);
        drop(limits);
        self.settle(service, key);
        None
    }

    /// Measures where `service`'s build compacts every model `catalog` lists, on its default
    /// window and on its larger one, in the background: each limit not settled yet, and each one
    /// settled on another catalog, the one a settle under way runs aside.
    pub(crate) fn calibrate_catalog(
        self: &Arc<Self>,
        service: &Arc<CodexService>,
        provider_version: &str,
        catalog: &CodexCatalogReading,
    ) {
        let digest = blake3::hash(catalog.dump.as_bytes());
        lock(&self.catalogs).insert(provider_version.to_owned(), (digest, catalog.clone()));
        let mut limits = lock(&self.limits);
        let due = select_due_limits(
            &limits,
            list_catalog_keys(provider_version, catalog),
            digest,
        );
        for key in &due {
            limits.insert(key.clone(), CodexLimitState::Pending);
        }
        drop(limits);
        for key in due {
            self.settle(service, key);
        }
    }

    // Reads or measures `key`'s limit in the background on its build's newest catalog and keeps
    // what came of it; a result whose catalog was replaced meanwhile is dropped and the limit
    // settled again on the newer one.
    fn settle(self: &Arc<Self>, service: &Arc<CodexService>, key: CodexLimitKey) {
        let compaction_limits = Arc::clone(self);
        let service = Arc::clone(service);
        self.tasks.spawn(async move {
            // The first ask of a daemon run clears what a crashed run left.
            compaction_limits.sweep_left_scratch(&service).await;
            loop {
                let (digest, state) = compaction_limits.read_or_measure(&service, &key).await;
                let current = lock(&compaction_limits.catalogs)
                    .get(&key.provider_version)
                    .map(|(current, _catalog)| *current);
                if digest.is_none() || digest == current {
                    lock(&compaction_limits.limits).insert(key, state);
                    return;
                }
            }
        });
    }

    // The stored limit of `key`'s build, model and window on its build's newest catalog, the
    // service's own read now where none was, else one measured now and stored, with the digest of
    // the catalog it settled on; a failure is logged and settles the limit unknown.
    async fn read_or_measure(
        &self,
        service: &CodexService,
        key: &CodexLimitKey,
    ) -> (Option<blake3::Hash>, CodexLimitState) {
        let catalog = match self.catalog_of(service, &key.provider_version).await {
            Ok(catalog) => catalog,
            Err(error) => {
                report_unsettled(key, &*error);
                return (None, CodexLimitState::Unknown { digest: None });
            }
        };
        let digest = blake3::hash(catalog.dump.as_bytes());
        let state = match self
            .read_or_measure_on(service, key, &catalog, digest)
            .await
        {
            Ok(limit) => CodexLimitState::Known { limit, digest },
            Err(error) => {
                report_unsettled(key, &*error);
                CodexLimitState::Unknown {
                    digest: Some(digest),
                }
            }
        };
        (Some(digest), state)
    }

    // The newest catalog `provider_version` printed, read from `service` and kept where no read
    // gave one yet.
    async fn catalog_of(
        &self,
        service: &CodexService,
        provider_version: &str,
    ) -> Result<CodexCatalogReading, Box<dyn std::error::Error + Send + Sync>> {
        if let Some((_digest, catalog)) = lock(&self.catalogs).get(provider_version) {
            return Ok(catalog.clone());
        }
        let catalog = read_codex_service_catalog(service).await?;
        let digest = blake3::hash(catalog.dump.as_bytes());
        Ok(lock(&self.catalogs)
            .entry(provider_version.to_owned())
            .or_insert((digest, catalog))
            .1
            .clone())
    }

    async fn read_or_measure_on(
        &self,
        service: &CodexService,
        key: &CodexLimitKey,
        catalog: &CodexCatalogReading,
        digest: blake3::Hash,
    ) -> Result<u64, Box<dyn std::error::Error + Send + Sync>> {
        let catalog = compose_codex_calibration_catalog(catalog, &key.request)?;
        let measured = CodexMeasuredWindow {
            provider_version: key.provider_version.clone(),
            model_id: key.request.model_id.clone(),
            window_tokens: catalog.window_tokens,
            catalog_digest: digest.to_hex().to_string(),
        };
        if let Some(limit) = read_stored_codex_limit(&self.reads, &measured).await? {
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

// Logs why `key`'s limit stays unknown.
fn report_unsettled(key: &CodexLimitKey, error: &(dyn std::error::Error + 'static)) {
    tracing::warn!(
        error,
        model = %key.request.model_id,
        version = %key.provider_version,
        "the codex compaction limit could not be read or measured"
    );
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

// The limits of `keys` a read of the catalog of `digest` settles: each never settled, and each
// settled, known or failed, on another catalog; one under way is left to its settle.
fn select_due_limits(
    limits: &HashMap<CodexLimitKey, CodexLimitState>,
    keys: Vec<CodexLimitKey>,
    digest: blake3::Hash,
) -> Vec<CodexLimitKey> {
    keys.into_iter()
        .filter(|key| match limits.get(key) {
            None => true,
            Some(CodexLimitState::Pending) => false,
            Some(CodexLimitState::Known {
                digest: settled, ..
            }) => *settled != digest,
            Some(CodexLimitState::Unknown { digest: settled }) => *settled != Some(digest),
        })
        .collect()
}

#[cfg(test)]
mod tests;
