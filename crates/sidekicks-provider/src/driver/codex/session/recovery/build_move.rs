//! Restarting a service on the program as it is now, after a Codex update or when the service asks
//! for a restart before it lists models, with its conversations resumed on the new process. An
//! account's service restarts in place once every session on it is idle, each held in its slot so
//! no turn starts meanwhile. A terminal service, which terminals the person joined share, gets a
//! second service each conversation moves to as its session goes idle: the conversation leaves
//! the first, which unloads it, since Codex refuses to resume one another service still writes,
//! and the first is retired once no session is on it and no conversation is held there for its
//! commands. The person's own service is not the daemon's to restart; it is only dialed again.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::session::controls::events::SessionNotice;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio::time::Instant;

use super::{CodexServiceRecovery, CodexWriterLeft, never_left};
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::run::turn_end_waiters::CodexTurnWait;
use crate::driver::codex::service::home::CodexServiceKind;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::start::read_codex_loaded_threads;
use crate::driver::codex::session::calls::{call_codex_session, wait_for_codex_turns};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::inbound::{CodexSessionCall, CodexSessionInboundSender};
use crate::driver::codex::session::slots::{CodexSessionClaim, let_go_codex_thread};
use crate::driver::codex::transport::connection::CODEX_REQUEST_TIMEOUT;
use crate::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::driver::session_control::{DriverResumeResult, ProviderBuildChange};

/// How long a conversation may take to unload from the service it leaves before its resume on the
/// new one goes ahead and Codex decides.
const CODEX_UNLOAD_TIMEOUT: std::time::Duration = CODEX_REQUEST_TIMEOUT;

impl CodexServiceRecovery {
    /// Moves every session on the driver's services onto the build that replaced the running one,
    /// each when its running reply ends or at once while idle, and tells each session moved; the
    /// person's own service stays on the build it runs. Answers once every move is under way.
    pub(crate) fn move_to_provider_build(self: &Arc<Self>, change: &ProviderBuildChange) {
        for service in self.dependencies.services.services() {
            if service.kind() == CodexServiceKind::Joined || service.attached_sessions().is_empty()
            {
                continue;
            }
            let recovery = Arc::clone(self);
            let change = change.clone();
            self.dependencies.tasks.spawn(async move {
                if let Err(error) = recovery.restart_service(&service, Some(change)).await {
                    report_restart_failed(&service, &error);
                }
            });
        }
    }

    /// Restarts `service` on the program as it is now, its conversations resumed on the new
    /// process and each session told of `change` where a build move asked for one: an account's
    /// in place once its sessions are idle, a terminal one through its planned restart, and the
    /// person's own redialed. Fails as an account service's start fails.
    pub(crate) async fn restart_service(
        self: &Arc<Self>,
        service: &Arc<CodexService>,
        change: Option<ProviderBuildChange>,
    ) -> Result<(), CodexError> {
        match service.kind() {
            CodexServiceKind::Account => {
                self.restart_account_service(service, change.as_ref()).await
            }
            CodexServiceKind::Terminal => {
                if let Some(change) = change {
                    self.lock()
                        .pending_build_change
                        .insert(service.id(), change);
                }
                service.request_planned_restart();
                Ok(())
            }
            // The redial's recovery resumes its conversations as a reconnect does.
            CodexServiceKind::Joined => {
                service.request_planned_restart();
                Ok(())
            }
        }
    }

    /// A terminal service's planned restart: a second service on the program as it is now, and
    /// each session moved to it once idle; the first is retired once it holds none.
    pub(crate) async fn move_terminal_service(self: &Arc<Self>, service: &Arc<CodexService>) {
        let change = self.lock().pending_build_change.remove(&service.id());
        let replacement = match self.dependencies.services.replace(service).await {
            Ok(replacement) => replacement,
            Err(error) => {
                report_restart_failed(service, &error);
                return;
            }
        };
        let sessions = service.attached_sessions();
        if sessions.is_empty() {
            self.retire_when_empty(service);
        }
        for inbound in sessions {
            let recovery = Arc::clone(self);
            let from = Arc::clone(service);
            let to = Arc::clone(&replacement);
            let change = change.clone();
            self.dependencies.tasks.spawn(async move {
                recovery
                    .move_when_idle(&inbound, &from, &to, change.as_ref())
                    .await;
            });
        }
    }

    // Holds every session on an account's service in its slot once each is idle, restarts the
    // service, and resumes each conversation on the new process.
    async fn restart_account_service(
        &self,
        service: &Arc<CodexService>,
        change: Option<&ProviderBuildChange>,
    ) -> Result<(), CodexError> {
        let held = loop {
            let mut held: Vec<(CodexSessionClaim<'_>, CodexSessionInboundSender)> = Vec::new();
            let mut busy = None;
            for inbound in service.attached_sessions() {
                match self.claim_idle(&inbound).await {
                    ClaimedIdle::Idle(claim, _) => held.push((claim, inbound)),
                    ClaimedIdle::Busy => {
                        busy = Some(inbound);
                        break;
                    }
                    ClaimedIdle::Gone => {}
                }
            }
            let Some(busy) = busy else {
                break held;
            };
            drop(held);
            // A session that closed meanwhile is passed over on the next round.
            let _settled = wait_for_codex_turns(&busy, CodexTurnWait::Idle, None).await;
        };
        service.restart_planned().await?;
        self.dependencies.release.forget_service(service.id());
        for (claim, inbound) in held {
            let resumed = self
                .resume_claimed(service, &inbound, never_left())
                .await
                .map(|outcome| outcome.result);
            if let Some(result) = &resumed {
                self.report_relaunch(service, &claim, inbound.session_id(), result.clone())
                    .await;
            }
            drop(claim);
            if let Some(result) = resumed {
                self.report_moved(service, &inbound, result, change).await;
            }
        }
        Ok(())
    }

    // Moves one session from `from` to `to` once it is idle, inside its slot, and tells it of
    // `change` once it resumed there.
    async fn move_when_idle(
        &self,
        inbound: &CodexSessionInboundSender,
        from: &Arc<CodexService>,
        to: &Arc<CodexService>,
        change: Option<&ProviderBuildChange>,
    ) {
        loop {
            match self.claim_idle(inbound).await {
                ClaimedIdle::Idle(claim, thread_id) => {
                    let resumed = self.move_claimed(inbound, from, to, thread_id).await;
                    if let Some(result) = &resumed {
                        self.report_relaunch(to, &claim, inbound.session_id(), result.clone())
                            .await;
                    }
                    drop(claim);
                    if let Some(result) = resumed {
                        let is_resumed = matches!(result, DriverResumeResult::Resumed { .. });
                        // The service the record runs on keeps the session; the other lets it go.
                        if is_resumed {
                            from.detach_session(&inbound.session_id());
                        } else {
                            to.detach_session(&inbound.session_id());
                        }
                        self.report_moved(to, inbound, result, change).await;
                    }
                    break;
                }
                ClaimedIdle::Busy => {
                    if wait_for_codex_turns(inbound, CodexTurnWait::Idle, None)
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                ClaimedIdle::Gone => break,
            }
        }
        self.retire_when_empty(from);
    }

    // Claims the session's slot and reads whether a turn is in flight on it and its conversation;
    // a busy session's slot is let go again, so its turn can end.
    async fn claim_idle(&self, inbound: &CodexSessionInboundSender) -> ClaimedIdle<'_> {
        let Ok(claim) = self
            .dependencies
            .slots
            .claim_establishing(inbound.session_id())
            .await
        else {
            return ClaimedIdle::Gone;
        };
        let reading = call_codex_session(inbound, |reply| CodexSessionCall::ReadSession {
            thread_id: None,
            reply,
        })
        .await;
        match reading {
            Ok(reading) if reading.is_turn_in_flight => ClaimedIdle::Busy,
            Ok(reading) => ClaimedIdle::Idle(claim, reading.thread_id),
            Err(_) => ClaimedIdle::Gone,
        }
    }

    // The move itself, the session's slot claimed: its conversations leave `from`, `thread_id`
    // unloading there first, then it resumes on `to`, tried again while `from` still writes it.
    async fn move_claimed(
        &self,
        inbound: &CodexSessionInboundSender,
        from: &Arc<CodexService>,
        to: &Arc<CodexService>,
        thread_id: String,
    ) -> Option<DriverResumeResult> {
        let session_id = inbound.session_id();
        let deadline = Instant::now() + CODEX_UNLOAD_TIMEOUT;
        self.dependencies
            .release
            .release_session_threads(from, &session_id, |released| released != thread_id);
        to.attach_session(inbound.clone());
        let_go_codex_thread(from, &thread_id).await;
        if !await_unloaded(from, &thread_id, deadline).await {
            // Another client, such as a terminal the person joined, still holds it on the old
            // service; the resume goes ahead and Codex decides.
            CodexTransportDiagnostic::ConversationUnloadTimedOut {
                thread_id: thread_id.clone(),
            }
            .report();
        }
        let leaving = Arc::clone(from);
        let writer_left: CodexWriterLeft = Box::new(move || {
            let leaving = Arc::clone(&leaving);
            let thread_id = thread_id.clone();
            async move { await_unloaded(&leaving, &thread_id, deadline).await }.boxed()
        });
        self.resume_claimed(to, inbound, writer_left)
            .await
            .map(|outcome| outcome.result)
    }

    // Tells a session it moved to `change`'s build once its conversation resumed there.
    async fn report_moved(
        &self,
        service: &CodexService,
        inbound: &CodexSessionInboundSender,
        result: DriverResumeResult,
        change: Option<&ProviderBuildChange>,
    ) {
        let session_id = inbound.session_id();
        let is_resumed = matches!(result, DriverResumeResult::Resumed { .. });
        let Some(change) = change.filter(|_| is_resumed) else {
            return;
        };
        let (Ok(from_version), Ok(to_version)) = (
            FreeFormText::new(change.from_version.clone()),
            FreeFormText::new(change.to_version.clone()),
        ) else {
            return;
        };
        self.post_notice(
            service,
            session_id,
            SessionNotice::ProviderUpdated {
                session_id,
                provider: DESCRIPTOR.provider_id(),
                from_version,
                to_version,
            },
        )
        .await;
    }

    // Stops a service a planned restart replaced once no session is on it and no conversation is
    // held there for its commands, which would end with it.
    fn retire_when_empty(&self, service: &Arc<CodexService>) {
        if !service.attached_sessions().is_empty() || !self.lock().retiring.insert(service.id()) {
            return;
        }
        let retiring = Arc::clone(service);
        let release = Arc::clone(&self.dependencies.release);
        let services = Arc::clone(&self.dependencies.services);
        self.dependencies.tasks.spawn(async move {
            release.when_none_held_on(retiring.id()).await;
            services.retire(&retiring).await;
        });
    }
}

/// A session's slot as a move found it.
enum ClaimedIdle<'slots> {
    /// Idle, held in its slot, on the conversation named.
    Idle(CodexSessionClaim<'slots>, String),
    /// A turn is in flight; the slot is let go.
    Busy,
    /// The session closed or was established anew.
    Gone,
}

// Waits until `from` no longer holds the conversation loaded: each `thread/closed` is confirmed by
// reading the loaded conversations, since a close can be stale. `false` once the deadline passed.
async fn await_unloaded(from: &CodexService, thread_id: &str, deadline: Instant) -> bool {
    loop {
        // Armed before the read, so a close between the two is not missed.
        let closed = from.wait_for_thread_closed(thread_id.to_owned());
        if is_unloaded(from, thread_id).await {
            return true;
        }
        if tokio::time::timeout_at(deadline, closed).await.is_err() {
            return false;
        }
    }
}

// Whether `from` no longer holds the conversation loaded; a read that fails leaves it to the
// resume, which Codex refuses while the conversation is still written elsewhere.
async fn is_unloaded(from: &CodexService, thread_id: &str) -> bool {
    let Ok(connection) = from.connection() else {
        // A service that stopped holds nothing loaded.
        return true;
    };
    match read_codex_loaded_threads(&connection).await {
        Ok(loaded) => !loaded.iter().any(|loaded| loaded == thread_id),
        Err(error) => {
            CodexTransportDiagnostic::ConversationUnloadUnconfirmed {
                thread_id: thread_id.to_owned(),
                error: Box::new(error),
            }
            .report();
            true
        }
    }
}

fn report_restart_failed(service: &CodexService, error: &CodexError) {
    tracing::warn!(
        codex_home = %service.home().codex_home.display(),
        error = error as &(dyn std::error::Error + 'static),
        "a codex service could not be restarted on the program as it is now"
    );
}
