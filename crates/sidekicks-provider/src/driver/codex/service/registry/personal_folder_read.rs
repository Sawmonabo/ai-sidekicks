//! The reads that run on the person's own Codex folder: Codex's config read and the machine probe.
//! Each runs on the daemon's service there where one fits; otherwise on a transient service the
//! daemon starts as its own child on a socket of its own beside the folder's, never the folder's
//! service, and stops once the read settles. The probe never runs on a joined service, whose
//! unload delay the daemon does not set, so its throwaway conversation would outlive it.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use sidekicks_platforms::create_private_folder;
use sidekicks_std::mutex_lock::lock;

use crate::driver::codex::service::command_line::compose_thread_unload_override;
use crate::driver::codex::service::home::CodexServiceKind;
use crate::driver::codex::service::registry::{
    CodexServiceRegistry, home_socket_path, own_socket_path,
};
use crate::driver::codex::service::supervisor::{CodexService, CodexServiceSocket};
use crate::driver::codex::session::errors::CodexError;

/// What a read on the person's own Codex folder is, which decides the service it runs on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PersonalFolderRead {
    /// Codex's config read, which starts no conversation, so any service on the folder serves it.
    Config,
    /// The machine probe, whose throwaway conversation must unload as its connection drops: only
    /// the terminal service, or a transient one that unloads at once.
    #[cfg_attr(not(test), expect(dead_code, reason = "the Codex machine probe"))]
    Probe,
}

/// The service one read on the person's own folder runs on, and whether it was started for that
/// read alone.
pub(super) struct PersonalFolderService {
    /// The service.
    pub(super) service: Arc<CodexService>,
    /// Whether it was started for the read alone, so it is stopped once the read settles.
    pub(super) is_transient: bool,
}

impl CodexServiceRegistry {
    /// Runs `read` on a started service on the person's own Codex folder: for a config read the
    /// daemon's service there, the terminal or a joined one, while it serves; for a probe the
    /// terminal service while it serves; otherwise a transient service started for the read and
    /// stopped once the read settled and the service is free. Fails as the transient service's
    /// socket cannot be named or its folder made, as the start fails, and as `read` fails.
    pub(crate) async fn read_on_personal_folder<Answer, Reading>(
        &self,
        purpose: PersonalFolderRead,
        read: impl FnOnce(Arc<CodexService>) -> Reading,
    ) -> Result<Answer, CodexError>
    where
        Reading: Future<Output = Result<Answer, CodexError>>,
    {
        let PersonalFolderService {
            service,
            is_transient,
        } = self.personal_folder_service(purpose)?;
        let startup_timeout = self.dependencies.startup_timeout;
        if !is_transient {
            service.ensure_started(startup_timeout).await?;
            return read(service).await;
        }
        let answered = async {
            make_socket_folder(&service)?;
            service.ensure_started(startup_timeout).await?;
            read(Arc::clone(&service)).await
        }
        .await;
        self.retire_transient(service);
        answered
    }

    // The service `purpose` runs on: one of the daemon's on the folder that fits and serves, else
    // a transient one, made but not started and held among the transient services.
    pub(super) fn personal_folder_service(
        &self,
        purpose: PersonalFolderRead,
    ) -> Result<PersonalFolderService, CodexError> {
        let home = self.homes.terminal_reach_home();
        let fitting = match purpose {
            PersonalFolderRead::Config => self.service_on(&home.codex_home),
            PersonalFolderRead::Probe => self
                .lock()
                .by_home
                .get(&home.codex_home)
                .filter(|service| service.kind() == CodexServiceKind::Terminal)
                .cloned(),
        };
        if let Some(service) = fitting.filter(|service| service.is_serving()) {
            return Ok(PersonalFolderService {
                service,
                is_transient: false,
            });
        }
        let config_overrides = match purpose {
            PersonalFolderRead::Config => Vec::new(),
            // After the shared delay, so the probe's conversation unloads as its connection drops.
            PersonalFolderRead::Probe => vec![compose_thread_unload_override(Duration::ZERO)],
        };
        let path = own_socket_path(&home.codex_home).map_err(|error| CodexError::Transport {
            detail: "The socket of a Codex read's own service could not be named.".to_owned(),
            cause: Some(Box::new(error)),
        })?;
        let home_socket = home_socket_path(&home.codex_home);
        let service = CodexService::new(
            home,
            CodexServiceSocket { path, home_socket },
            CodexServiceKind::Account,
            Arc::clone(&self.dependencies),
            config_overrides,
        );
        self.lock().transient.push(Arc::clone(&service));
        Ok(PersonalFolderService {
            service,
            is_transient: true,
        })
    }

    // Stops `service`, a read's transient one, on the driver's tracked tasks once it is free to
    // stop, and forgets it; a shutdown meanwhile ends the wait, the shutdown stopping it.
    fn retire_transient(&self, service: Arc<CodexService>) {
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
