//! The spawn contexts and accounts reader of a test whose every session runs in one folder on the
//! test's one account.

use std::path::PathBuf;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::port_registration::PortRegistration;

use crate::driver::ports::DriverPorts;
use crate::driver::test_registry::TestProviderAccounts;
use crate::driver::{CurrentProviderAccount, SessionSpawnContext, SessionSpawnContextResolver};
use crate::runtime_binding::test_store::test_provider_account_id;

/// The spawn-context port with [`OneFolder`] over `folder` registered on it.
pub(crate) fn one_folder_spawn_contexts(
    folder: PathBuf,
) -> Arc<PortRegistration<Arc<dyn SessionSpawnContextResolver>>> {
    let spawn_contexts = DriverPorts::new().spawn_contexts;
    spawn_contexts
        .register(Arc::new(OneFolder(folder)) as Arc<dyn SessionSpawnContextResolver>)
        .expect("a fresh port registers");
    spawn_contexts
}

/// Every session runs in one folder on the test's one account, whose home sits beside the folder.
pub(crate) struct OneFolder(pub(crate) PathBuf);

impl OneFolder {
    /// The accounts reader of the test account, whose folders are both its Codex home beside the
    /// working folder.
    pub(crate) fn accounts(&self) -> TestProviderAccounts {
        TestProviderAccounts::holding_folder(
            CurrentProviderAccount::Current(test_provider_account_id()),
            Some(self.0.with_file_name("codex-home")),
        )
    }
}

impl SessionSpawnContextResolver for OneFolder {
    fn resolve_spawn_context(
        &self,
        _session_id: SessionId,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<SessionSpawnContext, Box<dyn std::error::Error + Send + Sync>>> {
        let working_directory = self.0.clone();
        let account_folders = self
            .accounts()
            .account_folders()
            .expect("the test account has its home");
        async move {
            Ok(SessionSpawnContext {
                working_directory,
                git_common_folder: None,
                every_project_rows: Vec::new(),
                project_rows: Vec::new(),
                account_folders,
                step_bound: None,
                advisor_model: None,
                auto_memory: None,
            })
        }
        .boxed()
    }

    fn resolve_run_folder(
        &self,
        _session_id: SessionId,
    ) -> BoxFuture<'_, Result<PathBuf, Box<dyn std::error::Error + Send + Sync>>> {
        let run_folder = self.0.clone();
        async move { Ok(run_folder) }.boxed()
    }
}
