//! Builds the artifact store over the daemon's one database and registers the `artifact.*` calls it
//! answers: the three ingest calls, the publish, the list and the read. The store sits in the data folder, the
//! content-addressed payloads in `objects/` and the spools of ingests and publishes beside them in
//! `spool/`, on one volume, so a spool moves into the store by a rename. Its start schedules the
//! ingest reaper on the daemon's one scheduler: a pass at once, which clears the spools a stopped
//! daemon left, then one every ten minutes.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt as _;
use sidekicks_platforms::{WallClock, volume_free_bytes};

use crate::artifacts::admission::UploadAdmission;
use crate::artifacts::attachment_resolver::ArtifactAttachmentResolver;
use crate::artifacts::ingest::service::ArtifactIngestService;
use crate::artifacts::payload_store::PayloadStore;
use crate::artifacts::publish::ArtifactPublishService;
use crate::daemon::scheduler::{ScheduleError, ScheduledJobHandle, Scheduler};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::events::log_service::EventLogService;
use crate::events::session::appender::SessionEventAppender;
use crate::events::session::version::SESSION_EVENT_VERSION;
use crate::ipc::handlers::artifact::ingest::register_artifact_ingest;
use crate::ipc::handlers::artifact::list::register_artifact_list;
use crate::ipc::handlers::artifact::publish::register_artifact_publish;
use crate::ipc::handlers::artifact::read::register_artifact_read;
use crate::ipc::registry::{MethodRegistryBuilder, RegistrationError};

const ARTIFACTS_FOLDER_NAME: &str = "artifacts";

// How often the reaper looks for streams past their lifetime and spools gone unwritten: often
// enough that a stream is ended within minutes of its six-hour lifetime.
const INGEST_REAPER_INTERVAL: Duration = Duration::from_mins(10);

/// What the artifact store is built from.
pub(crate) struct ArtifactMethodsDeps {
    /// The daemon's one event log, which each artifact's rows are written with.
    pub(crate) event_log: Arc<EventLogService>,
    /// The daemon's database readers.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The daemon's data folder; the store lives in its `artifacts` folder.
    pub(crate) data_folder: PathBuf,
    /// The clock a stream's lifetime is read on.
    pub(crate) clock: Arc<dyn WallClock>,
}

/// Why the artifact store could not be built.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ArtifactMethodsError {
    /// The store's payload folder could not be opened.
    #[error("the artifact store's payload folder could not be opened")]
    PayloadStore(#[source] std::io::Error),
    /// A call was already registered.
    #[error(transparent)]
    Registration(#[from] RegistrationError),
}

/// The artifact store's background work, and its binding of a message's files to stored copies.
#[expect(
    dead_code,
    reason = "the daemon's start schedules the reaper and hands the drivers the attachments"
)]
pub(crate) struct ArtifactMethods {
    /// Binds the files a message carries to their stored copies, for the drivers to hand over.
    pub(crate) attachments: ArtifactAttachmentResolver,
    /// Stores the daemon's own payloads, for the plan record and a chat's versions.
    pub(crate) publisher: Arc<ArtifactPublishService>,
    ingest: Arc<ArtifactIngestService>,
}

impl ArtifactMethods {
    /// Schedules the ingest reaper on `scheduler`, a pass at once then one every ten minutes;
    /// called once, after the daemon's recovery pass has ended. Canceling the handle ends future
    /// passes. Fails when the scheduler has stopped.
    #[expect(
        dead_code,
        reason = "the daemon's start schedules the reaper once its recovery pass has ended"
    )]
    pub(crate) fn start(&self, scheduler: &Scheduler) -> Result<ScheduledJobHandle, ScheduleError> {
        let ingest = Arc::clone(&self.ingest);
        scheduler.schedule_repeating(
            "ingest reaper",
            INGEST_REAPER_INTERVAL,
            Duration::ZERO,
            move |_stop| {
                let ingest = Arc::clone(&ingest);
                async move { ingest.reap().await.map_err(Into::into) }.boxed()
            },
        )
    }
}

/// Builds the artifact store and registers its calls on `registry`. Fails when the payload folder
/// cannot be opened or a call is already registered.
#[expect(
    dead_code,
    reason = "the daemon's start builds the artifact store once its database is open"
)]
pub(crate) fn register_artifact_methods(
    registry: &mut MethodRegistryBuilder,
    deps: ArtifactMethodsDeps,
) -> Result<ArtifactMethods, ArtifactMethodsError> {
    let store_folder = deps.data_folder.join(ARTIFACTS_FOLDER_NAME);
    let payloads = Arc::new(
        PayloadStore::new(store_folder.join("objects"))
            .map_err(ArtifactMethodsError::PayloadStore)?,
    );
    let admission = Arc::new(UploadAdmission::new(
        store_folder.join("spool"),
        volume_free_bytes,
    ));
    let appender = Arc::new(SessionEventAppender::new(
        deps.event_log,
        SESSION_EVENT_VERSION.clone(),
    ));
    let ingest = Arc::new(ArtifactIngestService::new(
        Arc::clone(&appender),
        Arc::clone(&deps.reads),
        Arc::clone(&payloads),
        Arc::clone(&admission),
        Arc::clone(&deps.clock),
    ));
    register_artifact_ingest(registry, Arc::clone(&ingest))?;
    let publisher = Arc::new(ArtifactPublishService::new(
        appender,
        Arc::clone(&deps.reads),
        Arc::clone(&payloads),
        admission,
        deps.clock,
    ));
    register_artifact_publish(registry, Arc::clone(&publisher))?;
    register_artifact_list(registry, Arc::clone(&deps.reads))?;
    register_artifact_read(registry, Arc::clone(&deps.reads), Arc::clone(&payloads))?;
    Ok(ArtifactMethods {
        publisher,
        attachments: ArtifactAttachmentResolver::new(deps.reads, payloads),
        ingest,
    })
}
