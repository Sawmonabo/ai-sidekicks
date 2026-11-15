//! Codex's config read and the machine probe on the person's own Codex folder, and the transient
//! service a read there starts. Each runs on the daemon's service there where one fits; otherwise
//! on a transient service the daemon starts as its own child on a socket of its own beside the
//! folder's, never the folder's service, while the read holds the folder, and stops once the read
//! settles. A transient service unloads a conversation as its connection drops, so a probe that
//! follows a config read runs on the service the read started. The probe never runs on a joined
//! service, whose unload delay the daemon does not set, so its throwaway conversation would outlive
//! it. A stored turn is read only where the folder's own service failed a wait's reads or answers
//! nothing, so always on a transient service.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use sidekicks_platforms::create_private_folder;
use sidekicks_std::keyed_lock::KeyHold;
use sidekicks_std::mutex_lock::lock;

use crate::driver::codex::service::command_line::compose_thread_unload_override;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::service::registry::personal_folder::PERSONAL_FOLDER_HOLDS;
use crate::driver::codex::service::registry::{
    CodexServiceRegistry, home_socket_path, own_socket_path,
};
use crate::driver::codex::service::supervisor::refusals::shut_down_refusal;
use crate::driver::codex::service::supervisor::{CodexService, CodexServiceSocket};
use crate::driver::codex::session::errors::CodexError;

/// What a read on the person's own Codex folder is, which decides the service it runs on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PersonalFolderRead {
    /// Codex's config read or write, which starts no conversation, so any service on the folder
    /// serves it.
    Config,
    /// The machine probe, whose throwaway conversation must unload as its connection drops: only
    /// the terminal service, or a transient one that unloads at once.
    Probe,
}

impl CodexServiceRegistry {
    /// Runs `read` on a started service on the person's own Codex folder: for a config read the
    /// daemon's service there, the terminal or a joined one, while it serves; for a probe the
    /// terminal service while it serves; otherwise a transient service started for the read once
    /// the read holds the folder, and stopped once the read settled and the service is free.
    /// Fails as the transient service's socket cannot be named or its folder made, once the
    /// daemon is shutting down, as the start fails, and as `read` fails.
    pub(crate) async fn read_on_personal_folder<Answer, Reading>(
        &self,
        purpose: PersonalFolderRead,
        read: impl FnOnce(Arc<CodexService>) -> Reading,
    ) -> Result<Answer, CodexError>
    where
        Reading: Future<Output = Result<Answer, CodexError>>,
    {
        let folder = self.homes.terminal_reach_home().codex_home;
        if let Some(service) = self.fitting_service(purpose, &folder) {
            service
                .ensure_started(self.dependencies.startup_timeout)
                .await?;
            return read(service).await;
        }
        let hold = PERSONAL_FOLDER_HOLDS.acquire(folder).await;
        let service = self.transient_service(&hold)?;
        let answered = async {
            self.start_transient(&service).await?;
            read(Arc::clone(&service)).await
        }
        .await;
        self.retire_transient(service, hold);
        answered
    }

    // Starts `service`, a read's transient one, its socket's folder made first. Fails as the
    // folder cannot be made and as the start fails.
    pub(super) async fn start_transient(&self, service: &CodexService) -> Result<(), CodexError> {
        make_socket_folder(service)?;
        service
            .ensure_started(self.dependencies.startup_timeout)
            .await
    }

    /// Runs `probe`, the machine probe, on `service`, the one a read on the person's own folder
    /// runs on, where a probe fits it: the terminal service, or a transient one the read started;
    /// otherwise on a service as a [`PersonalFolderRead::Probe`] read takes one. Fails as
    /// [`Self::read_on_personal_folder`] does.
    pub(crate) async fn probe_on_personal_folder<Answer, Probing>(
        &self,
        service: Arc<CodexService>,
        probe: impl FnOnce(Arc<CodexService>) -> Probing,
    ) -> Result<Answer, CodexError>
    where
        Probing: Future<Output = Result<Answer, CodexError>>,
    {
        let is_transient = self
            .lock()
            .transient
            .iter()
            .any(|transient| Arc::ptr_eq(transient, &service));
        let is_terminal = self
            .daemon_terminal_service()
            .is_some_and(|terminal| Arc::ptr_eq(&terminal, &service));
        if is_transient || is_terminal {
            return probe(service).await;
        }
        self.read_on_personal_folder(PersonalFolderRead::Probe, probe)
            .await
    }

    // The service of the daemon's on `folder` that `purpose` fits and that serves; `None` where
    // the read takes a transient one.
    pub(in crate::driver::codex::service::registry) fn fitting_service(
        &self,
        purpose: PersonalFolderRead,
        folder: &Path,
    ) -> Option<Arc<CodexService>> {
        match purpose {
            PersonalFolderRead::Config => self.service_on(folder),
            PersonalFolderRead::Probe => self.daemon_terminal_service(),
        }
        .filter(|service| service.is_serving())
    }

    // A transient service on the folder `hold` holds, made but not started and held among the
    // transient services. Fails as its socket cannot be named, and once the daemon is shutting
    // down, so a read that takes the folder after the shutdown began starts no process.
    pub(in crate::driver::codex::service::registry) fn transient_service(
        &self,
        hold: &KeyHold<'static, PathBuf>,
    ) -> Result<Arc<CodexService>, CodexError> {
        let codex_home = hold.key().clone();
        // After the shared delay, so a probe's conversation unloads as its connection drops.
        let config_overrides = vec![compose_thread_unload_override(Duration::ZERO)];
        let path = own_socket_path(&codex_home).map_err(|error| CodexError::Transport {
            detail: "The socket of a Codex read's own service could not be named.".to_owned(),
            cause: Some(Box::new(error)),
        })?;
        let home_socket = home_socket_path(&codex_home);
        let service = CodexService::new(
            CodexServiceHome {
                codex_home,
                kind: CodexHomeKind::PersonalFolder,
            },
            CodexServiceSocket { path, home_socket },
            CodexServiceKind::Account,
            Arc::clone(&self.dependencies),
            config_overrides,
        );
        let mut services = self.lock();
        if services.is_shut_down {
            return Err(shut_down_refusal());
        }
        services.transient.push(Arc::clone(&service));
        Ok(service)
    }

    // The daemon's own terminal service on the person's own folder, serving or not; `None` where
    // the folder holds no service or a joined one, which terminal reach may still name.
    fn daemon_terminal_service(&self) -> Option<Arc<CodexService>> {
        let home = self.homes.terminal_reach_home();
        self.lock()
            .by_home
            .get(&home.codex_home)
            .filter(|service| service.kind() == CodexServiceKind::Terminal)
            .cloned()
    }

    // Stops `service`, a read's transient one, on the driver's tracked tasks once it is free to
    // stop, and forgets it, then lets `hold` go, so no read on its folder starts another while it
    // stops; a shutdown meanwhile ends the wait once it has stopped the service, and a read that
    // takes the folder after it starts none.
    pub(super) fn retire_transient(
        &self,
        service: Arc<CodexService>,
        hold: KeyHold<'static, PathBuf>,
    ) {
        let services = Arc::clone(&self.services);
        self.dependencies.tasks.spawn(async move {
            let freed = tokio::select! {
                freed = service.when_free_to_stop() => freed,
                () = service.when_shut_down() => return,
            };
            // No session runs on it, so a failed wait stops it all the same.
            if let Err(error) = freed {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "whether a codex read's own service is free could not be read; it is stopped"
                );
            }
            service.stop().await;
            lock(&services)
                .transient
                .retain(|transient| !Arc::ptr_eq(transient, &service));
            drop(hold);
        });
    }
}

// Makes the folder of `service`'s own socket, which Codex listens in.
fn make_socket_folder(service: &CodexService) -> Result<(), CodexError> {
    let folder = service
        .socket_path()
        .parent()
        .expect("a socket of its own sits in the home's control socket folder");
    create_private_folder(folder).map_err(|error| CodexError::Transport {
        detail: "The folder of a Codex read's own service's socket could not be made.".to_owned(),
        cause: Some(Box::new(error)),
    })
}
