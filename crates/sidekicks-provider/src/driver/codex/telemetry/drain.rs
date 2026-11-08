//! The drain of the export register's hand-off: each completed response taken, one at a time, to
//! the session holding its thread, to its copy's ledger, or off the stream to the session its
//! thread runs below; each launch's kept responses retried; and each ended copy's unstated
//! responses filed when due.

use std::sync::{Arc, Mutex, Weak};

use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::{Notify, mpsc};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::inbound::CodexSessionInbound;
use crate::driver::codex::telemetry::completed_response::CodexCompletedResponse;
use crate::driver::codex::telemetry::copy_threads::CodexEndedCopy;
use crate::driver::codex::telemetry::exports::CodexExports;
use crate::driver::codex::telemetry::held_responses::CodexExportedResponse;
use crate::driver::codex::telemetry::placement::{
    CodexLaunchPlacement, place_off_stream, retry_kept,
};

// What the reader hands the drain, each with the service that ran it and its launch's placement
// state, since a relaunch drops the tag it was read under: one completed response of the export
// numbered `export_number`, or, after that export's responses, a retry of the responses the launch
// kept before it.
pub(super) enum CodexExportItem {
    Response {
        service: Weak<CodexService>,
        launch: Weak<Mutex<CodexLaunchPlacement>>,
        response: CodexCompletedResponse,
        arrived_at: Instant,
        export_number: u64,
    },
    Retry {
        service: Weak<CodexService>,
        launch: Weak<Mutex<CodexLaunchPlacement>>,
        export_number: u64,
    },
}

/// The drain of the register's hand-off, which takes each completed response to the session it
/// belongs to, one at a time, and files each ended copy's unstated responses when due, until the
/// register stops.
pub(crate) struct CodexExportDrain {
    pub(super) register: Weak<CodexExports>,
    pub(super) items: mpsc::Receiver<CodexExportItem>,
    pub(super) copies_ended: Arc<Notify>,
    pub(super) stop: CancellationToken,
}

impl CodexExportDrain {
    /// Takes each handed-off response to its session, one at a time, and files each ended copy
    /// when due, until the register stops, then logs how many responses it leaves in the hand-off.
    pub(crate) async fn run(mut self) {
        loop {
            let next_due = self
                .register
                .upgrade()
                .and_then(|register| register.next_copy_due());
            let copy_due = async {
                match next_due {
                    Some(due_at) => tokio::time::sleep_until(due_at).await,
                    None => std::future::pending().await,
                }
            };
            let item = tokio::select! {
                biased;
                () = self.stop.cancelled() => {
                    tracing::info!(
                        left = self.items.len(),
                        "the codex export drain stopped; the responses left in its hand-off are \
                         dropped"
                    );
                    return;
                }
                item = self.items.recv() => item,
                // A copy's read ended, so the next copy due may be sooner.
                () = self.copies_ended.notified() => continue,
                () = copy_due => {
                    self.file_due_copies().await;
                    continue;
                }
            };
            // The register holds the sender, so its drop ends the drain too.
            let Some(item) = item else {
                return;
            };
            deliver(item).await;
        }
    }

    // Files, as its session's own, each response a copy due now never stated on its stream; one
    // whose service is gone is logged and dropped.
    async fn file_due_copies(&self) {
        let Some(register) = self.register.upgrade() else {
            return;
        };
        for (service, copy) in register.take_due_copies(Instant::now()) {
            let CodexEndedCopy {
                mut filing,
                folder,
                unclaimed,
            } = copy;
            let Some(service) = service.upgrade() else {
                for response in &unclaimed {
                    tracing::info!(
                        conversation_id = response.conversation_id.as_str(),
                        tokens = ?response.counts,
                        "a codex copy's service is gone; its unstated response is dropped"
                    );
                }
                continue;
            };
            for response in unclaimed {
                filing.file(response.meter(), &service, &folder).await;
                response.log_read_for_price();
            }
        }
    }
}

// Pushes `item`'s response onto the queue of the session holding its thread on its service, else
// places or keeps it off the stream on its launch; a retry places what its launch kept. An item
// whose service or launch is gone is logged and dropped.
async fn deliver(item: CodexExportItem) {
    match item {
        CodexExportItem::Response {
            service,
            launch,
            response,
            arrived_at,
            export_number,
        } => {
            let Some(service) = service.upgrade() else {
                tracing::info!(
                    conversation_id = response.conversation_id.as_str(),
                    "a codex completed response's service is gone; it is dropped"
                );
                return;
            };
            if let Some(session_id) = service.session_of_thread(&response.conversation_id) {
                let exported = CodexExportedResponse {
                    response,
                    arrived_at,
                    placed: None,
                };
                push_exported_response(&service, session_id, exported);
                return;
            }
            let Some(launch) = launch.upgrade() else {
                tracing::info!(
                    conversation_id = response.conversation_id.as_str(),
                    "a codex completed response's launch was replaced; it is dropped"
                );
                return;
            };
            // A copy's thread claims against the copy's own stream.
            let offered = lock(&launch).copies().offer(response);
            let Some(response) = offered else {
                return;
            };
            place_off_stream(&service, &launch, response, arrived_at, export_number).await;
        }
        CodexExportItem::Retry {
            service,
            launch,
            export_number,
        } => {
            // A launch that went logged its kept responses as it went.
            if let Some((service, launch)) = service.upgrade().zip(launch.upgrade()) {
                retry_kept(&service, &launch, export_number).await;
            }
        }
    }
}

/// Pushes `exported` onto `session_id`'s queue on `service`; one no session took is logged and
/// dropped.
pub(crate) fn push_exported_response(
    service: &CodexService,
    session_id: SessionId,
    exported: CodexExportedResponse,
) {
    let conversation_id = exported.response.conversation_id.clone();
    if !service.push_session_item(&session_id, CodexSessionInbound::ExportedResponse(exported)) {
        tracing::info!(
            conversation_id = conversation_id.as_str(),
            %session_id,
            "no codex session took a completed response; it is dropped"
        );
    }
}
