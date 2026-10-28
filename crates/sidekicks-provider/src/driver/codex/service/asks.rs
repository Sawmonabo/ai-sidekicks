//! The asks a Codex service's connection receives for the person: each queued to the session its
//! conversation belongs to, in its place among that session's frames, and the asks a closed
//! connection let go of withdrawn from that session's cards.

use std::collections::HashMap;
use std::sync::Weak;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::oneshot;

use crate::driver::codex::server_requests::{
    CodexInboundServerRequest, CodexServerRequestAnswer, CodexServerRequestDecision,
    CodexServerRequestResponder,
};
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::routing::read_codex_ask_thread_id;
use crate::driver::codex::session::inbound::CodexSessionInbound;
use crate::driver::codex::transport::connection::CodexForgottenRequest;
use crate::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::driver::contract::DriverError;

/// Routes one service's asks to their sessions and withdraws those a closed connection let go.
pub(super) struct CodexServiceAsks {
    service: Weak<CodexService>,
}

impl CodexServiceAsks {
    /// The asks router of `service`.
    pub(super) fn new(service: Weak<CodexService>) -> Self {
        Self { service }
    }

    /// Withdraws each dropped ask's card on the session its conversation belongs to, one queue
    /// item per session; an ask naming no conversation a session holds has no card.
    pub(super) fn withdraw(&self, dropped: Vec<CodexForgottenRequest>) {
        let Some(service) = self.service.upgrade() else {
            return;
        };
        let mut by_session: HashMap<SessionId, Vec<CodexForgottenRequest>> = HashMap::new();
        {
            let threads = service.lock_threads();
            for request in dropped {
                if let Some(session_id) = request
                    .thread_id
                    .as_deref()
                    .and_then(|thread_id| threads.session_for(thread_id))
                {
                    by_session.entry(*session_id).or_default().push(request);
                }
            }
        }
        for (session_id, dropped) in by_session {
            // A session whose queue is gone has no cards left to withdraw.
            let _unheard = service
                .push_session_item(&session_id, CodexSessionInbound::AsksWithdrawn { dropped });
        }
    }
}

impl CodexServerRequestResponder for CodexServiceAsks {
    // Queued on the reader, so the ask keeps its place among the frames around it; the decision
    // is awaited off the reader.
    fn answer(
        &self,
        request: CodexInboundServerRequest,
    ) -> BoxFuture<'static, Result<CodexServerRequestDecision, DriverError>> {
        let method = request.method.method();
        let Some(service) = self.service.upgrade() else {
            return refuse(no_session_reason(method));
        };
        let thread_id = read_codex_ask_thread_id(&request.params);
        let session_id = thread_id
            .as_deref()
            .and_then(|thread_id| service.lock_threads().session_for(thread_id).copied());
        let Some(session_id) = session_id else {
            CodexTransportDiagnostic::RoutedAskThreadUnresolved {
                method: method.to_owned(),
                thread_id,
            }
            .report();
            return refuse(no_session_reason(method));
        };
        let (decision, decided) = oneshot::channel();
        if !service.push_session_item(&session_id, CodexSessionInbound::Ask { request, decision }) {
            CodexTransportDiagnostic::UnroutedServerRequestRefused {
                method: method.to_owned(),
            }
            .report();
            return refuse(format!(
                "The daemon has no responder registered for \"{method}\"; refusing rather than \
                 answering without adjudication."
            ));
        }
        async move {
            decided.await.unwrap_or_else(|_closed| {
                Ok(CodexServerRequestDecision::Answer(
                    CodexServerRequestAnswer::Refuse {
                        reason: format!(
                            "The session closed before it answered the provider's \"{method}\" \
                         request."
                        ),
                    },
                ))
            })
        }
        .boxed()
    }
}

fn no_session_reason(method: &str) -> String {
    format!(
        "The provider's \"{method}\" request named no conversation this daemon holds, so no \
         session can answer it."
    )
}

fn refuse(reason: String) -> BoxFuture<'static, Result<CodexServerRequestDecision, DriverError>> {
    std::future::ready(Ok(CodexServerRequestDecision::Answer(
        CodexServerRequestAnswer::Refuse { reason },
    )))
    .boxed()
}

#[cfg(test)]
mod tests;
