//! Codex compaction: `thread/compact/start` sent on a session's conversation, `applied` only once
//! the `thread/compacted` frame proves it ran, and the boundary position that frame carries.

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::compaction::{
    AgentRunContextCompactResponse, CompactionFailure,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::compaction_wait::{CompactionWaitTerminal, PendingCompactionRegistry};
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::app_server_protocol::ThreadCompactStartParams;
use crate::driver::codex::transport::connection::{CodexAppServerConnection, read_codex_object};
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use sidekicks_std::error_description::describe_error;

/// Codex's own compaction request, answered before the compaction runs.
const CODEX_THREAD_COMPACT_START_METHOD: &str = "thread/compact/start";

/// The member of a `thread/compacted` frame the boundary is read from.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompactedFrame {
    boundary_position: Option<Value>,
}

/// The conversation one compaction runs on, and where its diagnostics name it.
pub(crate) struct CodexCompactionTarget<'target> {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The account the service runs on; `None` on the machine's default home.
    pub(crate) provider_account_id: Option<&'target ProviderAccountId>,
    /// The session's conversation.
    pub(crate) thread_id: &'target str,
    /// The wait's key for that conversation, as the frame routing settles it.
    pub(crate) wait_key: &'target str,
}

/// Sends `thread/compact/start` on `connection` with the wait armed first, so an early frame is
/// seen, and answers `applied` only on the compaction frame; every other end is `failed` with its
/// reason, reported as a diagnostic.
pub(crate) async fn dispatch_codex_compaction(
    connection: &CodexAppServerConnection,
    pending_compactions: &PendingCompactionRegistry,
    target: CodexCompactionTarget<'_>,
) -> AgentRunContextCompactResponse {
    let wait = pending_compactions.arm(target.wait_key);
    let sent = connection
        .request(
            CODEX_THREAD_COMPACT_START_METHOD,
            &ThreadCompactStartParams {
                thread_id: target.thread_id.to_owned(),
            },
        )
        .await;
    if let Err(error) = sent {
        drop(wait);
        report_compaction_end(&target, &describe_error(&error), "providerError");
        return AgentRunContextCompactResponse::Failed {
            reason: CompactionFailure::ProviderError,
        };
    }
    let settlement = wait.settled().await;
    let (reason, terminal) = match settlement.terminal {
        CompactionWaitTerminal::Observed => {
            return AgentRunContextCompactResponse::Applied {
                boundary_position: settlement.boundary_position.and_then(SafeInt::new),
            };
        }
        CompactionWaitTerminal::NotCompacted => (CompactionFailure::NotCompacted, "notCompacted"),
        CompactionWaitTerminal::BindingLost => (CompactionFailure::BindingLost, "bindingLost"),
    };
    let detail = settlement
        .terminal
        .failure_detail()
        .expect("only an observed compaction has no failure detail");
    report_compaction_end(&target, detail, terminal);
    AgentRunContextCompactResponse::Failed { reason }
}

/// The boundary position a `thread/compacted` frame carries: only a non-negative integer, since
/// Codex's frame names only the thread and turn today, so a build that adds one is read.
pub(crate) fn read_codex_compaction_boundary_position(params: &RawValue) -> Option<u64> {
    read_codex_object::<CompactedFrame>(params.get())
        .and_then(|frame| frame.boundary_position)
        .and_then(|position| position.as_u64())
}

fn report_compaction_end(target: &CodexCompactionTarget<'_>, detail: &str, terminal: &str) {
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id: target.provider_account_id.cloned(),
        kind: DriverDiagnosticKind::CompactionWaitTerminal,
        raw_wire_type: Some(CODEX_THREAD_COMPACT_START_METHOD.to_owned()),
        disposition_reason: detail.to_owned(),
        details: Map::from_iter([
            ("sessionId".to_owned(), json!(target.session_id.to_string())),
            ("terminal".to_owned(), json!(terminal)),
        ]),
    });
}
