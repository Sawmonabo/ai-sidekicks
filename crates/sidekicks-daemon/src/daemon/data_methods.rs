//! The data verbs Settings › Runtime and the command line send: `daemon.dataExport.start`,
//! `.subscribe` and `.cancel` over the service's exports, and `daemon.data.erase`, refused with
//! `daemon.data.storeUnavailable` before anything is erased when the keychain cannot be emptied
//! and with `daemon.data.eraseRunning` while an erase runs.

use std::path::PathBuf;
use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::daemon::data::{
    DaemonDataErase, DaemonDataExportAlreadyRunningDetails, DaemonDataExportCancel,
    DaemonDataExportCancelRequest, DaemonDataExportDestinationNotWritableDetails,
    DaemonDataExportStart, DaemonDataExportStartRequest, DaemonDataExportStartResponse,
    DaemonDataExportSubscribe, DaemonDataExportSubscribeRequest, DaemonDataStoreUnavailableDetails,
    DataExportProgress,
};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_ipc::stream::feed::Feed;
use sidekicks_ipc::stream::latest_value::{LatestValueFeed, LatestValueOutlet};
use tokio::sync::watch;

use crate::data_acts::erase::{DataErase, DataEraseRefusal};
use crate::data_acts::export::{DataExportStartRefusal, DataExports, is_finished};

/// What the data verbs act on.
pub(crate) struct DataMethodsDeps {
    /// The service's exports.
    pub(crate) exports: Arc<DataExports>,
    /// The erase.
    pub(crate) erase: Arc<DataErase>,
}

/// Registers the export's three verbs and the erase. Fails the start when a method is already
/// registered.
pub(crate) fn register_data_methods(
    registry: &mut MethodRegistryBuilder,
    deps: DataMethodsDeps,
) -> Result<(), RegistrationError> {
    let starting = Arc::clone(&deps.exports);
    registry.register::<DaemonDataExportStart, _>(
        move |request: DaemonDataExportStartRequest, _context: HandlerContext| {
            let started = starting
                .start(PathBuf::from(request.destination.as_str()))
                .map(|job_id| DaemonDataExportStartResponse { job_id })
                .map_err(|refusal| start_refusal(refusal, request.destination));
            async move { started }.boxed()
        },
    )?;
    let following = Arc::clone(&deps.exports);
    registry.register_subscription::<DaemonDataExportSubscribe, _>(
        move |request: DaemonDataExportSubscribeRequest,
              _context: HandlerContext,
              subscription_id: SubscriptionId| {
            let progress = following.follow(request.job_id);
            async move {
                let progress = progress.ok_or_else(unknown_export)?;
                let feed =
                    LatestValueFeed::open(
                        |outlet| async move { Ok(follow_progress(progress, outlet)) },
                    )
                    .await?;
                let feed: Box<dyn Feed<Emission = DataExportProgress>> = Box::new(feed);
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )?;
    let canceling = Arc::clone(&deps.exports);
    registry.register::<DaemonDataExportCancel, _>(
        move |request: DaemonDataExportCancelRequest, _context: HandlerContext| {
            let canceled = if canceling.cancel(request.job_id) {
                Ok(EmptyPayload {})
            } else {
                Err(unknown_export())
            };
            async move { canceled }.boxed()
        },
    )?;
    let erase = deps.erase;
    registry.register::<DaemonDataErase, _>(move |_: EmptyPayload, _context: HandlerContext| {
        let erase = Arc::clone(&erase);
        async move {
            erase.begin().await.map_err(erase_refusal)?;
            Ok(EmptyPayload {})
        }
        .boxed()
    })
}

// Sends the job's progress as it stands, then each change, and ends the stream once the job ends.
fn follow_progress(
    mut progress: watch::Receiver<DataExportProgress>,
    outlet: LatestValueOutlet<DataExportProgress>,
) -> impl FnOnce() + Send + use<> {
    let following = tokio::spawn(async move {
        loop {
            let current = progress.borrow_and_update().clone();
            let has_ended = is_finished(&current);
            outlet.send(current);
            if has_ended || progress.changed().await.is_err() {
                break;
            }
        }
    });
    move || following.abort()
}

fn start_refusal(refusal: DataExportStartRefusal, destination: FilesystemPath) -> HandlerError {
    match refusal {
        DataExportStartRefusal::AlreadyRunning(job_id) => DomainError::new(
            "Another export is running. Follow it, or start again once it ends.",
            RefusalCode::DaemonDataExportAlreadyRunning,
        )
        .with_detail(DaemonDataExportAlreadyRunningDetails { job_id })
        .into(),
        DataExportStartRefusal::DestinationExists => DomainError::new(
            "A folder with that name is already there. Export into a new folder.",
            RefusalCode::DaemonDataExportDestinationAlreadyExists,
        )
        .into(),
        DataExportStartRefusal::DestinationNotWritable(failure) => DomainError::new(
            "That folder can't be made there. Pick a place you can write to.",
            RefusalCode::DaemonDataExportDestinationNotWritable,
        )
        .with_detail(DaemonDataExportDestinationNotWritableDetails { path: destination })
        .with_source(failure)
        .into(),
        DataExportStartRefusal::Folder(failure) => HandlerError::Internal(Box::new(failure)),
    }
}

fn unknown_export() -> HandlerError {
    DomainError::new(
        "That export is not one this service is running or ran since it started.",
        RefusalCode::DaemonDataExportNotFound,
    )
    .into()
}

fn erase_refusal(refusal: DataEraseRefusal) -> HandlerError {
    match refusal {
        DataEraseRefusal::Running => DomainError::new(
            "An erase is already running; nothing new starts.",
            RefusalCode::DaemonDataEraseRunning,
        )
        .into(),
        DataEraseRefusal::Keychain(refusal) => DomainError::keychain_refused(
            refusal,
            RefusalCode::DaemonDataStoreUnavailable,
            |cause| DaemonDataStoreUnavailableDetails { cause },
        )
        .into(),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    use futures::FutureExt as _;
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_artifact::payload_store::PayloadStore;
    use sidekicks_artifact::schema::ARTIFACT_STATEMENT_CAPACITY;
    use sidekicks_contracts::daemon::data::{
        DaemonDataErase, DaemonDataExportCancel, DaemonDataExportStart, DaemonDataExportSubscribe,
        DataExportProgress,
    };
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::method::Method as _;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_ipc::call_fixtures::{context, request};
    use sidekicks_ipc::domain_error::DomainError;
    use sidekicks_ipc::registry::{
        Dispatch as _, DispatchError, EncodedFeed, MethodRegistry, MethodRegistryBuilder, Reply,
    };
    use sidekicks_ipc::stream::feed::CreditGate;
    use sidekicks_platforms::CredentialStore;
    use sidekicks_provider::driver::contract::MockProviderDriver;
    use sidekicks_provider::driver::test_registry::registry_of_first_provider;
    use sidekicks_store::credential_store::items::{SecretItems, SecretItemsStart};
    use sidekicks_store::credential_store::os::TestStoreAccess;
    use sidekicks_store::credential_store::place::{
        PlaceRecord, SecretsPlace, record_path, write_record,
    };
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use tempfile::TempDir;

    use super::{DataMethodsDeps, register_data_methods};
    use crate::data_acts::erase::{DataErase, DataEraseDeps};
    use crate::data_acts::export::{DataExportDeps, DataExports};

    const WAIT: Duration = Duration::from_secs(10);
    const UNKNOWN_JOB: &str = "0192f0c1-7a3b-7c00-8000-0000000000ff";

    // The data verbs over an empty store, with a keychain the record names that does not open,
    // and whether the erase's first step ran.
    struct DataVerbs {
        registry: MethodRegistry,
        data_folder: TempDir,
        has_work_stopped: Arc<AtomicBool>,
        _database: TestDatabase,
    }

    async fn data_verbs() -> DataVerbs {
        let database = TestDatabase::new(crate::daemon::schema::schema_parts());
        database.opener()().expect("the test creates its database");
        let data_folder = tempfile::tempdir().expect("the data folder is made");
        let data = data_folder.path().to_path_buf();
        fs::write(data.join("daemon.db"), "kept").expect("the store file is written");
        let exports = Arc::new(DataExports::new(DataExportDeps {
            reads: Arc::new(DatabaseReadPool::new(
                database.path(),
                ARTIFACT_STATEMENT_CAPACITY,
            )),
            read_damaged_from_sequence: Arc::new(|_: &SessionId| None),
            payloads: Arc::new(
                PayloadStore::new(data.join("objects")).expect("the payload store opens"),
            ),
        }));
        write_record(
            &record_path(&data),
            &PlaceRecord::settled(SecretsPlace::OperatingSystem),
        )
        .await
        .expect("the record is written");
        let access = TestStoreAccess::new(CredentialStore::in_memory());
        access.opens.store(false, Ordering::SeqCst);
        let secret_items = SecretItems::new(SecretItemsStart {
            data_folder: data.clone(),
            runs_while_logged_out: false,
            access: access as _,
            call_timeout: Duration::from_secs(5),
        })
        .expect("the system gives random bytes");
        let has_work_stopped = Arc::new(AtomicBool::new(false));
        let stopped = Arc::clone(&has_work_stopped);
        let erase = Arc::new(DataErase::new(DataEraseDeps {
            data_folder: data,
            secret_items,
            providers: Arc::new(registry_of_first_provider(Arc::new(
                MockProviderDriver::new(),
            ))),
            stop_work: Arc::new(move || {
                stopped.store(true, Ordering::SeqCst);
                async {}.boxed()
            }),
            close_data_folder: Arc::new(|| async {}.boxed()),
            end_process: Arc::new(|| {}),
        }));
        let mut builder = MethodRegistryBuilder::new();
        register_data_methods(&mut builder, DataMethodsDeps { exports, erase })
            .expect("the data verbs register");
        DataVerbs {
            registry: builder.freeze(),
            data_folder,
            has_work_stopped,
            _database: database,
        }
    }

    fn refusal_of(reply: Result<Reply, DispatchError>) -> DomainError {
        let Err(DispatchError::Refused(refusal)) = reply else {
            panic!("the call is refused");
        };
        refusal
    }

    // An erase the keychain cannot carry out is refused with `daemon.data.storeUnavailable`,
    // naming its cause, before anything stops or goes. Killed by an erase that starts before the
    // keychain check, and by the refusal answered under another code.
    #[tokio::test]
    async fn an_erase_the_keychain_refuses_answers_store_unavailable_and_erases_nothing() {
        let verbs = data_verbs().await;
        let refused = verbs
            .registry
            .dispatch(
                request(DaemonDataErase::DESCRIPTOR.method, Some(&json!({}))),
                context(1),
            )
            .await;
        let refusal = refusal_of(refused);
        assert_eq!(refusal.code, RefusalCode::DaemonDataStoreUnavailable);
        assert_eq!(
            refusal.detail.expect("the refusal names its cause")["cause"],
            "unavailable"
        );
        tokio::task::yield_now().await;
        assert!(!verbs.has_work_stopped.load(Ordering::SeqCst));
        assert!(verbs.data_folder.path().join("daemon.db").is_file());
    }

    // A subscriber hears the export through to its end and the stream then ends; a job this run
    // did not start is `daemon.dataExport.notFound` to a subscribe and a cancel. Killed by a
    // stream that waits on past the end, and by an unknown job answered under another code.
    #[tokio::test]
    async fn an_export_streams_to_its_end_and_an_unknown_job_is_not_found() {
        let verbs = data_verbs().await;
        let destination = verbs.data_folder.path().join("export");
        let Ok(Reply::Result(started)) = verbs
            .registry
            .dispatch(
                request(
                    DaemonDataExportStart::DESCRIPTOR.method,
                    Some(&json!({ "destination": destination.to_string_lossy() })),
                ),
                context(1),
            )
            .await
        else {
            panic!("the export starts");
        };
        let started: Value = serde_json::from_slice(&started.json).expect("the answer is JSON");
        let Ok(Reply::Subscription { mut feed, .. }) = verbs
            .registry
            .dispatch(
                request(
                    DaemonDataExportSubscribe::DESCRIPTOR.method,
                    Some(&json!({ "jobId": started["jobId"] })),
                ),
                context(1),
            )
            .await
        else {
            panic!("the subscribe answers a subscription");
        };
        let gate = CreditGate::with_credit(16);
        let mut last = None;
        while let Some(emission) = next_emission(&mut feed, &gate).await {
            last = Some(emission);
        }
        assert!(
            matches!(last, Some(DataExportProgress::Completed { .. })),
            "{last:?}"
        );

        for method in [
            DaemonDataExportSubscribe::DESCRIPTOR.method,
            DaemonDataExportCancel::DESCRIPTOR.method,
        ] {
            let refused = verbs
                .registry
                .dispatch(
                    request(method, Some(&json!({ "jobId": UNKNOWN_JOB }))),
                    context(1),
                )
                .await;
            assert_eq!(
                refusal_of(refused).code,
                RefusalCode::DaemonDataExportNotFound
            );
        }
    }

    // A start whose folder cannot be made, its parent missing or a file, which refuses every
    // account on every system, is refused with `daemon.dataExport.destination.notWritable` naming
    // the folder, and nothing is made. Killed by the create failure answered as an internal error,
    // by `NotADirectory` left out of the refusal, and by the refusal under another code.
    #[rstest]
    #[case::parent_missing(false)]
    #[case::parent_is_a_file(true)]
    #[tokio::test]
    async fn an_export_folder_that_cannot_be_made_is_not_writable(#[case] is_parent_a_file: bool) {
        let verbs = data_verbs().await;
        let parent = verbs.data_folder.path().join("parent");
        if is_parent_a_file {
            fs::write(&parent, b"").expect("the parent is written as a file");
        }
        let destination = parent.join("export");
        let refused = verbs
            .registry
            .dispatch(
                request(
                    DaemonDataExportStart::DESCRIPTOR.method,
                    Some(&json!({ "destination": destination.to_string_lossy() })),
                ),
                context(1),
            )
            .await;
        let refusal = refusal_of(refused);
        assert_eq!(
            refusal.code,
            RefusalCode::DaemonDataExportDestinationNotWritable
        );
        assert_eq!(
            refusal.detail.expect("the refusal names the folder")["path"],
            destination.to_string_lossy().as_ref()
        );
        assert!(!destination.exists());
    }

    async fn next_emission(
        feed: &mut Box<dyn EncodedFeed>,
        gate: &CreditGate,
    ) -> Option<DataExportProgress> {
        let emission = tokio::time::timeout(WAIT, feed.next(gate))
            .await
            .expect("the stream sends or ends")
            .expect("the progress reads")?;
        Some(serde_json::from_slice(&emission.json).expect("the emission reads as its type"))
    }
}
