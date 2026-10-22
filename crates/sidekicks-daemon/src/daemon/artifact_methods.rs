//! Builds the artifact store over the daemon's one database and registers the `artifact.*` calls it
//! answers: the three ingest calls, the publish, the list and the read. The store sits in the data
//! folder, the content-addressed payloads in `objects/` and the spools of ingests and publishes
//! beside them in `spool/`, on one volume, so a spool moves into the store by a rename. Its start
//! schedules the ingest reaper on the daemon's one scheduler: a pass at once, which clears the
//! spools a stopped daemon left, then one every ten minutes; each pass also sweeps the payloads no
//! reference names, which a crash between a delete and its reclaim leaves behind.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_platforms::{WallClock, volume_free_bytes};
use tokio_util::sync::CancellationToken;

use crate::artifacts::admission::UploadAdmission;
use crate::artifacts::attachment_resolver::ArtifactAttachmentResolver;
use crate::artifacts::ingest::service::ArtifactIngestService;
use crate::artifacts::payload_store::PayloadStore;
use crate::artifacts::publish::ArtifactPublishService;
use crate::daemon::scheduler::{
    JobCondition, ScheduleError, ScheduledJobHandle, ScheduledJobOutcome, Scheduler,
};
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
    reason = "the daemon's start schedules the reaper, hands the drivers the attachments and \
              the plans and a chat's versions the publisher"
)]
pub(crate) struct ArtifactMethods {
    /// Binds the files a message carries to their stored copies, for the drivers to hand over.
    pub(crate) attachments: ArtifactAttachmentResolver,
    /// Stores the daemon's own payloads, for the plan record and a chat's versions.
    pub(crate) publisher: Arc<ArtifactPublishService>,
    /// The stored payloads, which the data export copies each session's files from.
    pub(crate) payloads: Arc<PayloadStore>,
    ingest: Arc<ArtifactIngestService>,
    reads: Arc<DatabaseReadPool>,
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
        scheduler.schedule_repeating(
            "ingest reaper",
            JobCondition::Always,
            INGEST_REAPER_INTERVAL,
            Duration::ZERO,
            self.reaper_pass(),
        )
    }

    // One reaper pass: the ingest's reap, then the orphan sweep, which runs whether the reap
    // failed or not. Fails with the reap's failure, the sweep's written to the service log beside
    // it, or the sweep's alone.
    fn reaper_pass(
        &self,
    ) -> impl FnMut(CancellationToken) -> BoxFuture<'static, ScheduledJobOutcome> + Send + 'static
    {
        let ingest = Arc::clone(&self.ingest);
        let payloads = Arc::clone(&self.payloads);
        let reads = Arc::clone(&self.reads);
        move |_stop| {
            let ingest = Arc::clone(&ingest);
            let payloads = Arc::clone(&payloads);
            let reads = Arc::clone(&reads);
            async move {
                let reaped = ingest.reap().await;
                let swept = payloads.sweep_orphans(&reads).await;
                match (reaped, swept) {
                    (Ok(()), Ok(())) => Ok(()),
                    (Ok(()), Err(sweep_failure)) => Err(sweep_failure.into()),
                    (Err(reap_failure), swept) => {
                        if let Err(sweep_failure) = swept {
                            tracing::warn!(
                                error = &sweep_failure as &(dyn std::error::Error + 'static),
                                "The orphan sweep failed beside the ingest reaper"
                            );
                        }
                        Err(reap_failure.into())
                    }
                }
            }
            .boxed()
        }
    }
}

/// Builds the artifact store and registers its calls on `registry`. Fails when the payload folder
/// cannot be opened or a call is already registered.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start builds the artifact store once its database is open"
    )
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
        attachments: ArtifactAttachmentResolver::new(
            Arc::clone(&deps.reads),
            Arc::clone(&payloads),
        ),
        ingest,
        payloads,
        reads: deps.reads,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sha2::{Digest as _, Sha256};
    use sidekicks_platforms::WallClockTimer;
    use tokio_util::sync::CancellationToken;

    use super::{ARTIFACTS_FOLDER_NAME, ArtifactMethodsDeps, register_artifact_methods};
    use crate::artifacts::payload_store::ContentHash;
    use crate::artifacts::test_store::{ArtifactTestStore, write_payload_reference};
    use crate::ipc::registry::MethodRegistryBuilder;

    // One reaper pass sweeps the payloads no reference names and keeps a referenced one. Killed by
    // the sweep left out of the reaper's pass.
    #[tokio::test]
    async fn a_reaper_pass_sweeps_an_orphan_and_keeps_a_referenced_payload() {
        let store = ArtifactTestStore::open().await;
        let data_folder = tempfile::tempdir().expect("the data folder is made");
        let methods = register_artifact_methods(
            &mut MethodRegistryBuilder::new(),
            ArtifactMethodsDeps {
                event_log: Arc::clone(&store.event_log),
                reads: Arc::clone(&store.reads),
                data_folder: data_folder.path().to_path_buf(),
                clock: Arc::new(WallClockTimer::new().expect("the test arms a wall clock")),
            },
        )
        .expect("the artifact store opens");
        let spool_folder = data_folder.path().join(ARTIFACTS_FOLDER_NAME).join("spool");
        std::fs::create_dir_all(&spool_folder).expect("the spool folder is made");
        let mut stored = Vec::new();
        for bytes in [b"referenced".as_slice(), b"orphaned".as_slice()] {
            let content_hash = ContentHash::of_sha256(&Sha256::digest(bytes));
            let spool = spool_folder.join(content_hash.as_str().replace(':', "-"));
            std::fs::write(&spool, bytes).expect("the spool is written");
            methods
                .payloads
                .admit(spool, &content_hash, async { Ok(()) })
                .await
                .expect("the bytes are stored");
            stored.push(content_hash);
        }
        let [referenced, orphaned] = <[ContentHash; 2]>::try_from(stored).expect("two stored");
        write_payload_reference(&store.writer, store.session_id, &referenced).await;

        let mut pass = methods.reaper_pass();
        pass(CancellationToken::new())
            .await
            .expect("the pass succeeds");

        assert!(methods.payloads.object_path_of(&referenced).exists());
        assert!(!methods.payloads.object_path_of(&orphaned).exists());
    }
}
