//! Where Codex compacts each model on each window, which no request reports: measured once per
//! Codex build by a calibration run, stored by build, model and window, and answered from memory.
//! A limit not yet known is read from the store, else measured, in the background on its first
//! ask, so a reading made meanwhile falls back to Codex's default point.

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
    CodexCalibrationRequest, measure_codex_compaction_limit, read_codex_calibration_catalog,
};
use crate::driver::codex::calibration::store::{
    CodexMeasuredWindow, read_stored_codex_limit, store_codex_limit,
};
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
    /// Its read and measurement failed; it stays unknown until the daemon starts again.
    Unknown,
}

/// The Codex compaction limits of one driver, shared by every session.
pub(crate) struct CodexCompactionLimits {
    reads: Arc<DatabaseReadPool>,
    writer: Arc<PortRegistration<Arc<DatabaseWriter>>>,
    tasks: TaskTracker,
    limits: Mutex<HashMap<CodexLimitKey, CodexLimitState>>,
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
        let compaction_limits = Arc::clone(self);
        let service = Arc::clone(service);
        self.tasks.spawn(async move {
            let state = match compaction_limits.read_or_measure(&service, &key).await {
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
        None
    }

    // The stored limit of `key`'s build, model and window, else one measured now and stored.
    async fn read_or_measure(
        &self,
        service: &CodexService,
        key: &CodexLimitKey,
    ) -> Result<u64, Box<dyn std::error::Error + Send + Sync>> {
        let catalog = read_codex_calibration_catalog(service, &key.request).await?;
        let measured = CodexMeasuredWindow {
            provider_version: key.provider_version.clone(),
            model_id: key.request.model_id.clone(),
            window_tokens: catalog.window_tokens,
        };
        if let Some(limit) = read_stored_codex_limit(&self.reads, &measured).await? {
            return Ok(limit);
        }
        let limit =
            measure_codex_compaction_limit(service, &catalog, &key.request.model_id).await?;
        let writer = self.writer.require_port()?;
        store_codex_limit(writer, &measured, limit).await?;
        Ok(limit)
    }
}
