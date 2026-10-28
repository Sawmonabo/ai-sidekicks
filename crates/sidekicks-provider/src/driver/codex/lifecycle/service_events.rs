//! What each Codex service's events do through the session pieces: a process's end ends the turns
//! of the sessions on it, a service back resumes their conversations, a crash loop tells them it
//! stays down, a failed start tells the queue their processes are gone, a rate-limit push is filed
//! and a terminal service's planned restart moves them. Each event runs off the service's runner,
//! on the driver's tasks.

use std::sync::Arc;

use sidekicks_contracts::run::control::ProcessExit;

use crate::driver::codex::lifecycle::CodexDriverParts;
use crate::driver::codex::lifecycle::effects::CodexDriverLink;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::events::{
    CodexServiceEvents, CodexServiceRecoveryCause,
};
use crate::driver::codex::session::errors::CodexError;

/// The service events of every service the driver dials, acted on through the composed pieces.
pub(crate) struct CodexDriverServiceEvents {
    link: Arc<CodexDriverLink>,
}

impl CodexDriverServiceEvents {
    /// Events reaching the pieces through `link`.
    pub(crate) fn new(link: Arc<CodexDriverLink>) -> Self {
        Self { link }
    }

    // Runs `act` on the driver's tasks; before any session composed the pieces, no session is on
    // the service, so the event has nothing to act on.
    fn spawn<Act, Acting>(&self, service: &Arc<CodexService>, event: &'static str, act: Act)
    where
        Act: FnOnce(Arc<CodexDriverParts>, Arc<CodexService>) -> Acting,
        Acting: Future<Output = ()> + Send + 'static,
    {
        let Some(parts) = self.link.parts() else {
            tracing::debug!(
                codex_home = %service.home().codex_home.display(),
                event,
                "a codex service event came before any session, with nothing to act on"
            );
            return;
        };
        let tasks = parts.tasks.clone();
        tasks.spawn(act(parts, Arc::clone(service)));
    }
}

impl CodexServiceEvents for CodexDriverServiceEvents {
    fn process_exited(&self, service: &Arc<CodexService>, exit: Option<&ProcessExit>) {
        let exit = exit.cloned();
        // Remembered here, in the service's own event order, so a restart's recovery spawned
        // earlier cannot forget an exit that came after it.
        if let (Some(parts), Some(exit)) = (self.link.parts(), &exit) {
            parts.recovery.remember_exit(service, exit.clone());
        }
        self.spawn(service, "process exited", |parts, service| async move {
            parts.recovery.end_turns_on_exit(&service, exit).await;
        });
    }

    fn recovered(&self, service: &Arc<CodexService>, cause: CodexServiceRecoveryCause) {
        // Marked here, in the service's own event order, before the service reads as up; with no
        // parts yet, the spawn below logs the event and acts on nothing.
        let Some(generation) = self.link.parts().map(|parts| {
            parts.recovery.forget_exit(service);
            parts.recovery.owe_resumes(service)
        }) else {
            self.spawn(service, "recovered", |_, _| async {});
            return;
        };
        self.spawn(service, "recovered", move |parts, service| async move {
            parts.recovery.recover(&service, cause, generation).await;
        });
    }

    fn crash_loop(&self, service: &Arc<CodexService>, start_failure: Option<Arc<CodexError>>) {
        self.spawn(service, "crash loop", |parts, service| async move {
            parts
                .recovery
                .crash_loop(&service, start_failure.as_deref())
                .await;
        });
    }

    fn start_failed(&self, service: &Arc<CodexService>) {
        self.spawn(service, "start failed", |parts, service| async move {
            parts.recovery.start_failed(&service);
        });
    }

    fn rate_limits_observed(&self, service: &Arc<CodexService>) {
        self.spawn(
            service,
            "rate limits observed",
            |parts, service| async move {
                parts.rate_limits.file(&service).await;
            },
        );
    }

    fn planned_restart_requested(&self, service: &Arc<CodexService>) {
        self.spawn(service, "planned restart", |parts, service| async move {
            parts.recovery.move_terminal_service(&service).await;
        });
    }
}
