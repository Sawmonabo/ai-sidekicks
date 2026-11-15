//! The stored data's methods the start builds: the export, and the erase, which ends the sign-ins
//! under way, signs every account home out and ends the process once its reply is written.

use std::path::Path;
use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_artifact::payload_store::PayloadStore;
use sidekicks_provider::account::credential_home::{ACCOUNT_SIGN_OUT_BOUND, sign_out_every_home};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_store::credential_store::items::SecretItems;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::events::session::read::DamagedFromSequenceReader;

use crate::daemon::data_methods::DataMethodsDeps;
use crate::daemon::process::stop::DaemonStopReason;
use crate::data_acts::erase::{DataErase, DataEraseDeps, EraseStep};
use crate::data_acts::export::{DataExportDeps, DataExports};
use crate::ipc::handlers::provider_account::ProviderAccountMethodSources;

/// What the stored data's methods are built from: the start's handles, lent, and the erase's steps
/// and secrets, owned.
pub(super) struct DataMethodsStart<'start> {
    /// The database's read pool.
    pub(super) reads: &'start Arc<DatabaseReadPool>,
    /// The sequence a damaged session's reads stop before.
    pub(super) read_damaged_from_sequence: &'start Arc<DamagedFromSequenceReader>,
    /// The artifact store's payloads, which the export copies each session's files from.
    pub(super) payloads: &'start Arc<PayloadStore>,
    /// The daemon's data folder.
    pub(super) data_folder: &'start Path,
    /// The registered drivers.
    pub(super) providers: &'start Arc<ProviderRegistry>,
    /// The account methods' sources, whose legs sign each home out and whose broker ends the
    /// sign-ins under way.
    pub(super) accounts: &'start ProviderAccountMethodSources,
    /// The daemon's secrets, which the erase removes.
    pub(super) secret_items: Arc<SecretItems>,
    /// Stops every run and shell once the erase's reply is written.
    pub(super) stop_work: EraseStep,
    /// Closes everything that holds a file in the data folder.
    pub(super) close_data_folder: EraseStep,
    /// Stops the daemon, which the erase's end asks for.
    pub(super) accept_stop: Arc<dyn Fn(DaemonStopReason) + Send + Sync>,
}

/// Builds the export and the erase from `start`.
pub(super) fn build_data_methods(start: DataMethodsStart<'_>) -> DataMethodsDeps {
    let DataMethodsStart {
        reads,
        read_damaged_from_sequence,
        payloads,
        data_folder,
        providers,
        accounts,
        secret_items,
        stop_work,
        close_data_folder,
        accept_stop,
    } = start;
    let (erase_reads, erase_data_folder, erase_legs, erase_sign_ins) = (
        Arc::clone(reads),
        data_folder.to_path_buf(),
        accounts.account_legs.clone(),
        Arc::clone(&accounts.sign_in),
    );
    DataMethodsDeps {
        exports: Arc::new(DataExports::new(DataExportDeps {
            reads: Arc::clone(reads),
            read_damaged_from_sequence: Arc::clone(read_damaged_from_sequence),
            payloads: Arc::clone(payloads),
            data_folder: data_folder.to_path_buf(),
        })),
        erase: Arc::new(DataErase::new(DataEraseDeps {
            data_folder: data_folder.to_path_buf(),
            secret_items,
            providers: Arc::clone(providers),
            stop_work,
            sign_out_accounts: Arc::new(move || {
                let (pool, legs) = (Arc::clone(&erase_reads), erase_legs.clone());
                let folder = erase_data_folder.clone();
                async move {
                    sign_out_every_home(&pool, &folder, &legs, ACCOUNT_SIGN_OUT_BOUND).await
                }
                .boxed()
            }),
            end_sign_ins: Arc::new(move || {
                let sign_ins = Arc::clone(&erase_sign_ins);
                async move { sign_ins.stop(ACCOUNT_SIGN_OUT_BOUND).await }.boxed()
            }),
            close_data_folder,
            end_process: Arc::new(move || accept_stop(DaemonStopReason::Erase)),
        })),
    }
}
