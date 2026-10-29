//! The Codex services of one driver, one per credential home: a session on an account the app
//! manages shares that account's lasting service, which a daemon restart keeps running, and the
//! person's own Codex folder holds the terminal service while terminal reach is on, which no
//! session of the app runs on. A service listens on the home's own control socket, which a
//! terminal's plain `codex` joins, except for a planned restart's second service, which takes a
//! socket of its own beside it under a name no daemon start reuses, the home's socket then pointed
//! at it. The capability read runs one short-lived service of its own on an empty folder, which
//! the registry never holds.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use futures::future::{BoxFuture, join_all};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::{CAN_LINK_A_SOCKET, read_socket_link};
use sidekicks_std::mutex_lock::lock;
use tokio::runtime::Handle;
use tokio::task::JoinHandle;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::service::record::recorded_home_keys;
use crate::driver::codex::service::socket_link::{is_listening, point_socket_link_at_service};
use crate::driver::codex::service::supervisor::start::kept_records::stop_kept_services;
#[cfg(any(test, feature = "test-support"))]
use crate::driver::codex::service::supervisor::test_service::ScriptedCodexService;
use crate::driver::codex::service::supervisor::{
    CodexService, CodexServiceDependencies, CodexServiceSocket,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::contract::error::DriverError;
use crate::driver::daemon_stop::DaemonStopIntent;
use crate::service_log::provider_service_log_file_of_key;

/// The folder under a Codex home that holds its control sockets.
const CODEX_CONTROL_SOCKET_FOLDER: &str = "app-server-control";

/// The home's own control socket's name in that folder.
const CODEX_HOME_SOCKET_NAME: &str = "app-server-control.sock";

/// The folder under the daemon's data folder the capability read's service runs in as its home,
/// made empty before each read and removed after it.
pub(crate) const CODEX_CAPABILITY_READ_FOLDER: &str = "codex-capability-read";

/// Resolves which Codex home a session's account runs in, and the one home terminal reach runs on.
pub(crate) trait CodexHomeResolver: Send + Sync {
    /// The home of `provider_account_id`'s account, never a folder outside the account's home.
    /// Fails with `provider.account.notFound` or `provider.account.credentialHome.unavailable`,
    /// and as the accounts' read fails.
    fn codex_home_for<'call>(
        &'call self,
        provider_account_id: &'call ProviderAccountId,
    ) -> BoxFuture<'call, Result<CodexServiceHome, DriverError>>;

    /// The person's own Codex folder, the one home the terminal service runs on.
    fn terminal_reach_home(&self) -> CodexServiceHome;
}

/// One service per credential home, made on first use and kept while the driver lives.
pub(crate) struct CodexServiceRegistry {
    homes: Arc<dyn CodexHomeResolver>,
    dependencies: Arc<CodexServiceDependencies>,
    // Shared with the tasks that retire a service the switch took off its home.
    services: Arc<Mutex<RegisteredServices>>,
}

#[derive(Default)]
struct RegisteredServices {
    by_home: HashMap<PathBuf, Arc<CodexService>>,
    // Services that left their home and are ending, so a shutdown meanwhile stops them too: those a
    // planned restart took over from until they are retired, and the one the switch-off stops.
    replaced: Vec<Arc<CodexService>>,
}

impl CodexServiceRegistry {
    /// A registry resolving homes through `homes`, whose services share `dependencies`.
    pub(crate) fn new(
        homes: Arc<dyn CodexHomeResolver>,
        dependencies: Arc<CodexServiceDependencies>,
    ) -> Self {
        Self {
            homes,
            dependencies,
            services: Arc::default(),
        }
    }

    /// The service of `provider_account_id`'s home, made but not started when it is the home's
    /// first use. Fails as the home's resolve does.
    pub(crate) async fn service_for(
        &self,
        provider_account_id: &ProviderAccountId,
    ) -> Result<Arc<CodexService>, DriverError> {
        let home = self.homes.codex_home_for(provider_account_id).await?;
        if let Some(existing) = self.lock().by_home.get(&home.codex_home) {
            return Ok(Arc::clone(existing));
        }
        Ok(self.service_on_home(home))
    }

    // The service registered on `home`, made when none is: the terminal service on the person's
    // own folder, the account's own child on an account's home.
    fn service_on_home(&self, home: CodexServiceHome) -> Arc<CodexService> {
        let home_socket = home_socket_path(&home.codex_home);
        let kind = match home.kind {
            CodexHomeKind::PersonalFolder => CodexServiceKind::Terminal,
            CodexHomeKind::Account(_) | CodexHomeKind::CapabilityRead => CodexServiceKind::Account,
        };
        let mut services = self.lock();
        // Another caller may have made it while the home resolved.
        match services.by_home.entry(home.codex_home.clone()) {
            Entry::Occupied(registered) => Arc::clone(registered.get()),
            Entry::Vacant(slot) => {
                let service = CodexService::new(
                    home,
                    CodexServiceSocket {
                        path: home_socket.clone(),
                        home_socket,
                    },
                    kind,
                    Arc::clone(&self.dependencies),
                );
                Arc::clone(slot.insert(service))
            }
        }
    }

    /// A service of its own for one capability read, on [`CODEX_CAPABILITY_READ_FOLDER`] under
    /// the data folder, made empty first, signed in to no account and never one the registry
    /// holds, so no session runs on it; made but not started. The caller stops it and removes the
    /// folder with [`CodexServiceRegistry::remove_capability_read_home`] whether the read
    /// succeeded or failed. Fails when the folder cannot be emptied or made.
    pub(crate) async fn capability_read_service(&self) -> Result<Arc<CodexService>, DriverError> {
        let codex_home = capability_read_home(&self.dependencies.data_folder);
        self.remove_capability_read_home().await?;
        tokio::fs::create_dir_all(&codex_home)
            .await
            .map_err(|error| DriverError::Internal(Box::new(error)))?;
        let home_socket = home_socket_path(&codex_home);
        Ok(CodexService::new(
            CodexServiceHome {
                codex_home,
                kind: CodexHomeKind::CapabilityRead,
            },
            CodexServiceSocket {
                path: home_socket.clone(),
                home_socket,
            },
            CodexServiceKind::Account,
            Arc::clone(&self.dependencies),
        ))
    }

    /// Removes the capability read's folder and everything its service wrote there; a folder
    /// already gone is removed. Fails as the removal fails.
    pub(crate) async fn remove_capability_read_home(&self) -> Result<(), DriverError> {
        match tokio::fs::remove_dir_all(capability_read_home(&self.dependencies.data_folder)).await
        {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(DriverError::Internal(Box::new(error))),
        }
    }

    /// Whether terminal reach is on, read from the service: the person's own folder's service is
    /// the one terminal reach names, and it is up or on its way back up. One that failed to start,
    /// ended in a crash loop or was stopped reads as off.
    pub(crate) fn is_terminal_service_on(&self) -> bool {
        self.lock()
            .by_home
            .values()
            .any(|service| is_terminal_reach_home(service.home()) && service.is_serving())
    }

    /// Starts the terminal service on the person's own Codex folder as the switch turns terminal
    /// reach on: the folder's service until now leaves it at once and is retired once free, as
    /// the switch-off retires one. A start that fails takes the new service off the folder again,
    /// stopped, so no service is left on the folder. Fails as the start does.
    pub(crate) async fn start_terminal_service(&self) -> Result<(), DriverError> {
        let home = self.homes.terminal_reach_home();
        if let Some(previous) = self.leave_home(&home.codex_home) {
            self.retire_once_free(previous);
        }
        let service = self.service_on_home(home);
        let Err(error) = service
            .ensure_started(self.dependencies.startup_timeout)
            .await
        else {
            return Ok(());
        };
        let is_registered = {
            let mut services = self.lock();
            let codex_home = &service.home().codex_home;
            let is_registered = services
                .by_home
                .get(codex_home)
                .is_some_and(|registered| Arc::ptr_eq(registered, &service));
            if is_registered {
                services.by_home.remove(codex_home);
            }
            is_registered
        };
        if is_registered {
            service.stop().await;
        }
        Err(error.into())
    }

    /// Takes the terminal service off the person's own Codex folder as the switch turns terminal
    /// reach off and answers at once, so no planned restart takes its place; the service is
    /// retired on the driver's tracked tasks once no terminal session is inside it and no command
    /// a session left on it runs, the terminal service ended with it. A folder with no terminal
    /// service is left as it is. Answers the retirement's task.
    pub(crate) fn stop_terminal_service(&self) -> Option<JoinHandle<()>> {
        let home = self.homes.terminal_reach_home();
        let is_terminal = self
            .lock()
            .by_home
            .get(&home.codex_home)
            .is_some_and(|service| is_terminal_reach_home(service.home()));
        if !is_terminal {
            return None;
        }
        self.leave_home(&home.codex_home)
            .map(|service| self.retire_once_free(service))
    }

    // Takes the service off `codex_home`, kept among the replaced while it ends.
    fn leave_home(&self, codex_home: &Path) -> Option<Arc<CodexService>> {
        let mut services = self.lock();
        let service = services.by_home.remove(codex_home)?;
        services.replaced.push(Arc::clone(&service));
        Some(service)
    }

    // Retires `service`, which left its home, on the driver's tracked tasks once it is free to
    // stop; a failed wait is reported and puts it back as the home's service where none took its
    // place, and a shutdown meanwhile ends the wait, the shutdown stopping it.
    fn retire_once_free(&self, service: Arc<CodexService>) -> JoinHandle<()> {
        let services = Arc::clone(&self.services);
        self.dependencies.tasks.spawn(async move {
            let freed = tokio::select! {
                freed = service.when_free_to_stop() => freed,
                () = service.when_shut_down() => return,
            };
            if let Err(error) = freed {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    codex_home = %service.home().codex_home.display(),
                    "whether the codex terminal service is free could not be read; it keeps \
                     running"
                );
                let mut held = lock(&services);
                let registered = &mut *held;
                if let Entry::Vacant(slot) =
                    registered.by_home.entry(service.home().codex_home.clone())
                {
                    registered
                        .replaced
                        .retain(|replaced| !Arc::ptr_eq(replaced, &service));
                    slot.insert(service);
                }
                return;
            }
            retire_service(&services, &service).await;
        })
    }

    /// Every service the registry holds, the replaced ones left out.
    pub(crate) fn services(&self) -> Vec<Arc<CodexService>> {
        self.lock().by_home.values().cloned().collect()
    }

    /// The service the registry holds on `codex_home`, or one that left it and still runs; `None`
    /// when no service of the driver is on that home.
    pub(crate) fn service_on(&self, codex_home: &Path) -> Option<Arc<CodexService>> {
        let services = self.lock();
        services.by_home.get(codex_home).cloned().or_else(|| {
            services
                .replaced
                .iter()
                .find(|replaced| replaced.home().codex_home == codex_home)
                .cloned()
        })
    }

    /// Whether no service holds `codex_home`: none of the driver's is on it, and nothing listens
    /// on the home's control socket, a service of the person's own or of a former daemon among
    /// them; a connect that tells nothing either way reads as held. Blocking: called on a
    /// blocking thread of the daemon's runtime.
    pub(crate) fn is_home_quiet(&self, codex_home: &Path) -> bool {
        self.service_on(codex_home).is_none()
            && Handle::current()
                .block_on(is_listening(&home_socket_path(codex_home)))
                .is_ok_and(|is_listened_on| !is_listened_on)
    }

    /// Starts a second service on `service`'s home, which becomes the home's service once it is
    /// up; the first stays until its conversations have moved off it. Where the home's control
    /// socket is a link, the second listens on a socket of its own and the link is pointed at it
    /// once it is up, unless a service answering in the first's place, Codex's managed daemon in
    /// use, holds the link; where the system refuses to move it, the path being the socket
    /// itself, the first is stopped once no terminal session is inside it and no command left on
    /// it runs, and the second takes the home's own socket, terminals reconnecting by themselves.
    /// Fails as the start does, the first then kept as the home's service; when the home's
    /// service changed while the second started, the second then stopped; and when the home's
    /// socket could not be pointed at the second, which then runs on unreached.
    pub(crate) async fn replace(
        &self,
        service: &Arc<CodexService>,
    ) -> Result<Arc<CodexService>, CodexError> {
        let home = service.home().clone();
        let home_socket = home_socket_path(&home.codex_home);
        let can_move_link = CAN_LINK_A_SOCKET;
        let path = if can_move_link {
            own_socket_path(&home.codex_home).map_err(|error| CodexError::Transport {
                detail: "The second Codex service's socket could not be named.".to_owned(),
                cause: Some(Box::new(error)),
            })?
        } else {
            service.when_free_to_stop().await?;
            service.stop().await;
            home_socket.clone()
        };
        let replacement = CodexService::new(
            home.clone(),
            CodexServiceSocket {
                path: path.clone(),
                home_socket: home_socket.clone(),
            },
            CodexServiceKind::Terminal,
            Arc::clone(&self.dependencies),
        );
        if let Err(error) = replacement
            .ensure_started(self.dependencies.startup_timeout)
            .await
        {
            // A start still under way at the bound is stood down, so nothing it launches outlives
            // the replacement.
            replacement.stop().await;
            return Err(error);
        }
        let is_swapped = {
            let mut services = self.lock();
            let is_registered = services
                .by_home
                .get(&home.codex_home)
                .is_some_and(|registered| Arc::ptr_eq(registered, service));
            if is_registered {
                services
                    .by_home
                    .insert(home.codex_home, Arc::clone(&replacement));
                if can_move_link {
                    services.replaced.push(Arc::clone(service));
                }
                service.set_holds_home_link(false);
                service.mark_replaced();
            }
            is_registered
        };
        if !is_swapped {
            // The switch-off stopped the first meanwhile, so nothing takes the second.
            replacement.stop().await;
            return Err(CodexError::Transport {
                detail: "The Codex folder's service changed while its second service started."
                    .to_owned(),
                cause: None,
            });
        }
        if can_move_link && may_take_socket_link(&home_socket, service).await? {
            point_socket_link_at_service(&home_socket, &path).map_err(|error| {
                CodexError::Transport {
                    detail: "The Codex folder's socket could not be pointed at the second \
                             service."
                        .to_owned(),
                    cause: Some(Box::new(error)),
                }
            })?;
            replacement.set_holds_home_link(true);
        }
        Ok(replacement)
    }

    /// Stops a service that left its home and forgets it: one a planned restart took over from,
    /// once no conversation is left on it, ends by Codex's own drain, after its running replies.
    pub(crate) async fn retire(&self, service: &Arc<CodexService>) {
        retire_service(&self.services, service).await;
    }

    /// Shuts every service down for good, the replaced ones included, and answers once every one
    /// has: the daemon's own are stopped, a joined one only disconnected, under `Restart` every
    /// lasting service, the terminal service and each account home's, keeps running in its record
    /// for the next start to join, and under `Stop` every service a record still keeps is stopped
    /// too, one a former daemon kept that this one never joined among them; every drain's wait is
    /// called off, its service draining on by itself. Each stop reports its own failure.
    pub(crate) async fn shutdown(&self, intent: DaemonStopIntent) {
        // A stop never waits on a drain: each drains on by itself, its record left marked.
        self.dependencies.drains.call_off();
        let services: Vec<Arc<CodexService>> = {
            let mut services = self.lock();
            let replaced = std::mem::take(&mut services.replaced);
            services.by_home.values().cloned().chain(replaced).collect()
        };
        join_all(services.iter().map(|service| service.shutdown(intent))).await;
        match intent {
            DaemonStopIntent::Stop => {
                stop_kept_services(self.dependencies.data_folder.clone()).await;
            }
            DaemonStopIntent::Restart => {}
        }
    }

    /// The logs of the lasting services that may run now: each one the registry holds, a replaced
    /// one included, that is serving, and the one on each Codex folder whose records' folder holds
    /// a record, which a former daemon's service this daemon has not joined writes. Blocking: it
    /// lists the records' folder. Fails when that listing fails, since a service it would name may
    /// still write its log.
    pub(crate) fn running_service_log_files(&self) -> io::Result<Vec<PathBuf>> {
        let mut files: Vec<PathBuf> = {
            let services = self.lock();
            services
                .by_home
                .values()
                .chain(&services.replaced)
                .filter(|service| service.is_serving())
                .filter_map(|service| service.lasting_log_file())
                .collect()
        };
        files.extend(
            recorded_home_keys(&self.dependencies.data_folder)?
                .iter()
                .map(|home_key| {
                    provider_service_log_file_of_key(
                        &self.dependencies.logs_folder,
                        &DESCRIPTOR.provider_id(),
                        home_key,
                    )
                }),
        );
        files.sort();
        files.dedup();
        Ok(files)
    }

    fn lock(&self) -> MutexGuard<'_, RegisteredServices> {
        lock(&self.services)
    }
}

#[cfg(any(test, feature = "test-support"))]
impl CodexServiceRegistry {
    /// A registry holding `scripted`'s service as its home's, every account resolving to that
    /// home.
    pub(crate) fn holding(scripted: &ScriptedCodexService) -> Arc<Self> {
        let home = scripted.service.home().clone();
        Self::holding_on(scripted, Arc::new(OneHome(home)))
    }

    /// A registry holding `scripted`'s service as its home's, each account's home resolved by
    /// `homes`.
    pub(crate) fn holding_on(
        scripted: &ScriptedCodexService,
        homes: Arc<dyn CodexHomeResolver>,
    ) -> Arc<Self> {
        let home = scripted.service.home().clone();
        let registry = Arc::new(Self::new(homes, Arc::clone(&scripted.dependencies)));
        registry
            .lock()
            .by_home
            .insert(home.codex_home, Arc::clone(&scripted.service));
        registry
    }
}

/// A home resolver answering the one home a test names for every account and for terminal reach.
#[cfg(any(test, feature = "test-support"))]
pub(crate) struct OneHome(pub(crate) CodexServiceHome);

#[cfg(any(test, feature = "test-support"))]
impl CodexHomeResolver for OneHome {
    fn codex_home_for<'call>(
        &'call self,
        _provider_account_id: &'call ProviderAccountId,
    ) -> BoxFuture<'call, Result<CodexServiceHome, DriverError>> {
        let home = self.0.clone();
        Box::pin(async move { Ok(home) })
    }

    fn terminal_reach_home(&self) -> CodexServiceHome {
        self.0.clone()
    }
}

/// Whether a planned restart may move the home's link off `first`: it names the first's socket,
/// or nothing answers on it; a service answering in its place, Codex's managed daemon in use,
/// keeps it. Fails with the link's read error and the connect's other failures.
async fn may_take_socket_link(
    home_socket: &Path,
    first: &CodexService,
) -> Result<bool, CodexError> {
    let read = async {
        let names_first = read_socket_link(home_socket)?.is_some_and(|target| {
            first
                .physical_socket()
                .is_some_and(|first_socket| first_socket == target)
        });
        Ok::<_, io::Error>(names_first || !is_listening(home_socket).await?)
    };
    read.await.map_err(|error| CodexError::Transport {
        detail: "The Codex folder's socket link could not be checked.".to_owned(),
        cause: Some(Box::new(error)),
    })
}

// Stops `service`, which left its home, and forgets it among `services`.
async fn retire_service(services: &Mutex<RegisteredServices>, service: &Arc<CodexService>) {
    service.stop().await;
    lock(services)
        .replaced
        .retain(|replaced| !Arc::ptr_eq(replaced, service));
}

// Whether `home` is the person's own folder, which only the terminal service runs on.
fn is_terminal_reach_home(home: &CodexServiceHome) -> bool {
    home.kind == CodexHomeKind::PersonalFolder
}

/// The capability read's home: its folder under the daemon's `data_folder`.
pub(crate) fn capability_read_home(data_folder: &Path) -> PathBuf {
    data_folder.join(CODEX_CAPABILITY_READ_FOLDER)
}

/// The home's own control socket.
pub(crate) fn home_socket_path(codex_home: &Path) -> PathBuf {
    codex_home
        .join(CODEX_CONTROL_SOCKET_FOLDER)
        .join(CODEX_HOME_SOCKET_NAME)
}

/// A socket of its own beside the home's, `sidekicks-<8 hex>.sock`, as long as the home's own
/// name, so no daemon start reuses one a lasting service still listens on. Fails when the system
/// gave no random bytes.
pub(super) fn own_socket_path(codex_home: &Path) -> Result<PathBuf, getrandom::Error> {
    let name = format!("sidekicks-{:08x}.sock", getrandom::u32()?);
    Ok(codex_home.join(CODEX_CONTROL_SOCKET_FOLDER).join(name))
}

#[cfg(test)]
mod tests;
