//! The Codex services of one driver, one per credential home: a session on an account the app
//! manages shares that account's service, and sessions on the person's own Codex folder share the
//! service there. A service listens on the home's own control socket, which a terminal's plain
//! `codex` joins, except in two cases where it takes a socket of its own beside it under a name no
//! daemon start reuses: a planned restart's second service, which the home's socket is then
//! pointed at, and the service on the person's own folder while terminal reach is off, so no
//! terminal joins it (an inference: off means no terminal joins anything of the daemon's).

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures::future::{BoxFuture, join_all};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::{CAN_LINK_A_SOCKET, read_socket_link};
use tokio::runtime::Handle;

use crate::provider::driver::codex::service::home::{
    CodexHomeKind, CodexServiceHome, CodexServiceKind,
};
use crate::provider::driver::codex::service::socket_link::{
    is_listening, point_socket_link_at_service,
};
#[cfg(test)]
use crate::provider::driver::codex::service::supervisor::test_service::ScriptedCodexService;
use crate::provider::driver::codex::service::supervisor::{
    CodexService, CodexServiceDependencies, CodexServiceSocket,
};
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::daemon_stop::DaemonStopIntent;

/// The folder under a Codex home that holds its control sockets.
const CODEX_CONTROL_SOCKET_FOLDER: &str = "app-server-control";

/// The home's own control socket's name in that folder.
const CODEX_HOME_SOCKET_NAME: &str = "app-server-control.sock";

/// Resolves which Codex home a session's account runs in.
pub(crate) trait CodexHomeResolver: Send + Sync {
    /// The home for `provider_account_id`; `None` names the machine's default account. Fails with
    /// the resolve's driver error.
    fn codex_home_for<'call>(
        &'call self,
        provider_account_id: Option<&'call ProviderAccountId>,
    ) -> BoxFuture<'call, Result<CodexServiceHome, DriverError>>;
}

/// One service per credential home, made on first use and kept while the driver lives.
pub(crate) struct CodexServiceRegistry {
    homes: Arc<dyn CodexHomeResolver>,
    dependencies: Arc<CodexServiceDependencies>,
    services: Mutex<RegisteredServices>,
}

#[derive(Default)]
struct RegisteredServices {
    by_home: HashMap<PathBuf, Arc<CodexService>>,
    // Services that left their home and are ending, so a shutdown meanwhile stops them too: those a
    // planned restart took over from until they are retired, and the one the switch-off stops.
    replaced: Vec<Arc<CodexService>>,
}

#[expect(
    dead_code,
    reason = "the daemon's start registers the driver, whose sessions, recovery and terminal \
              switch reach services through the registry"
)]
impl CodexServiceRegistry {
    /// A registry resolving homes through `homes`, whose services share `dependencies`.
    pub(crate) fn new(
        homes: Arc<dyn CodexHomeResolver>,
        dependencies: Arc<CodexServiceDependencies>,
    ) -> Self {
        Self {
            homes,
            dependencies,
            services: Mutex::default(),
        }
    }

    /// The service for an account's home, made but not started when it is the home's first use.
    /// Fails with the home resolve's driver error, and on a socket name that could not be drawn.
    pub(crate) async fn service_for(
        &self,
        provider_account_id: Option<&ProviderAccountId>,
    ) -> Result<Arc<CodexService>, DriverError> {
        let home = self.homes.codex_home_for(provider_account_id).await?;
        if let Some(existing) = self.lock().by_home.get(&home.codex_home) {
            return Ok(Arc::clone(existing));
        }
        let home_socket = home_socket_path(&home.codex_home);
        let (path, kind) = match home.kind {
            CodexHomeKind::Account => (home_socket.clone(), CodexServiceKind::Account),
            CodexHomeKind::PersonalFolder {
                is_terminal_reach_on: true,
            } => (home_socket.clone(), CodexServiceKind::Terminal),
            CodexHomeKind::PersonalFolder {
                is_terminal_reach_on: false,
            } => (
                own_socket_path(&home.codex_home)
                    .map_err(|error| DriverError::Internal(Box::new(error)))?,
                CodexServiceKind::Account,
            ),
        };
        let mut services = self.lock();
        // Another caller may have made it while the home resolved.
        let service = services
            .by_home
            .entry(home.codex_home.clone())
            .or_insert_with(|| {
                CodexService::new(
                    home,
                    CodexServiceSocket { path, home_socket },
                    kind,
                    Arc::clone(&self.dependencies),
                )
            });
        Ok(Arc::clone(service))
    }

    /// Starts the terminal service on the person's own Codex folder as the switch turns terminal
    /// reach on, the folder's service while it was off stopped first. Fails as the home's resolve
    /// or the start does.
    pub(crate) async fn start_terminal_service(&self) -> Result<(), DriverError> {
        self.stop_terminal_service().await?;
        let service = self.service_for(None).await?;
        Ok(service
            .ensure_started(self.dependencies.startup_timeout)
            .await?)
    }

    /// Stops the service on the person's own Codex folder as the switch turns terminal reach off:
    /// it leaves the folder at once, so the folder's next session starts the service the switch
    /// now names and no planned restart takes its place, then stops once no terminal session is
    /// inside it and no command a session left on it runs, the terminal service ended with it.
    /// Fails as the home's resolve does, and as the wait's read of the conversations inside does,
    /// the service then left running, back as the folder's service while none took its place.
    pub(crate) async fn stop_terminal_service(&self) -> Result<(), DriverError> {
        let home = self.homes.codex_home_for(None).await?;
        let service = {
            let mut services = self.lock();
            let Some(service) = services.by_home.remove(&home.codex_home) else {
                return Ok(());
            };
            services.replaced.push(Arc::clone(&service));
            service
        };
        if let Err(error) = service.when_free_to_stop().await {
            let mut held = self.lock();
            let services = &mut *held;
            if let Entry::Vacant(slot) = services.by_home.entry(home.codex_home) {
                services
                    .replaced
                    .retain(|replaced| !Arc::ptr_eq(replaced, &service));
                slot.insert(service);
            }
            return Err(error.into());
        }
        self.retire(&service).await;
        Ok(())
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
        service.stop().await;
        self.lock()
            .replaced
            .retain(|replaced| !Arc::ptr_eq(replaced, service));
    }

    /// Shuts every service down for good, the replaced ones included, and answers once every one
    /// has: the daemon's own are stopped, a joined one only disconnected, under `Restart` the
    /// terminal service keeps running, and every drain's wait is called off, its service draining
    /// on by itself. Each stop reports its own failure.
    pub(crate) async fn shutdown(&self, intent: DaemonStopIntent) {
        // A stop never waits on a drain: each drains on by itself, its record left marked.
        self.dependencies.drains.call_off();
        let services: Vec<Arc<CodexService>> = {
            let mut services = self.lock();
            let replaced = std::mem::take(&mut services.replaced);
            services.by_home.values().cloned().chain(replaced).collect()
        };
        join_all(services.iter().map(|service| service.shutdown(intent))).await;
    }

    fn lock(&self) -> MutexGuard<'_, RegisteredServices> {
        self.services.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
impl CodexServiceRegistry {
    /// A registry holding `scripted`'s service as its home's, every account resolving to that
    /// home.
    pub(crate) fn holding(scripted: &ScriptedCodexService) -> Arc<Self> {
        let home = scripted.service.home().clone();
        let registry = Arc::new(Self::new(
            Arc::new(OneHome(home.clone())),
            Arc::clone(&scripted.dependencies),
        ));
        registry
            .lock()
            .by_home
            .insert(home.codex_home, Arc::clone(&scripted.service));
        registry
    }
}

/// A home resolver answering the one home a test names for every account.
#[cfg(test)]
pub(crate) struct OneHome(pub(crate) CodexServiceHome);

#[cfg(test)]
impl CodexHomeResolver for OneHome {
    fn codex_home_for<'call>(
        &'call self,
        _provider_account_id: Option<&'call ProviderAccountId>,
    ) -> BoxFuture<'call, Result<CodexServiceHome, DriverError>> {
        let home = self.0.clone();
        Box::pin(async move { Ok(home) })
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

/// The home's own control socket.
fn home_socket_path(codex_home: &Path) -> PathBuf {
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
