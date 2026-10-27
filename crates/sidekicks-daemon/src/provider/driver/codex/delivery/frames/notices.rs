//! The provider's notices on a session: a warning, a deprecation or a config warning as the
//! session's notice, a model switch held for its sentence, and the frames that go to the daemon's
//! log only.

use serde_json::{Map, Value};
use sidekicks_contracts::session::controls::events::SessionNoticePostedPayload;

use crate::provider::driver::codex::delivery::frames::CodexFrameDelivery;
use crate::provider::driver::codex::delivery::notices::{
    CodexWarningReading, hold_reroute, read_codex_config_warning, read_codex_deprecation_notice,
    read_codex_warning,
};
use crate::provider::driver::codex::session::state::CodexSessionRecord;
use crate::provider::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::provider::run::delivery::InboundDelivery;

/// Frames that draw nothing and go to the daemon's log only.
const CODEX_LOGGED_ONLY_METHODS: [&str; 5] = [
    "turn/moderationMetadata",
    "model/verification",
    "modelProvider/authRecoveryStarted",
    "modelProvider/authRecoveryCompleted",
    "windows/worldWritableWarning",
];

impl CodexFrameDelivery {
    pub(super) async fn deliver_notice(
        &self,
        record: &mut CodexSessionRecord,
        method: &str,
        members: &Map<String, Value>,
    ) {
        match method {
            "warning" => match read_codex_warning(&mut record.delivery, record.session_id, members)
            {
                CodexWarningReading::Reroute(reroute) => {
                    self.send_row(record, *reroute).await;
                }
                CodexWarningReading::Notice(notice) => {
                    self.send_notice(record, notice, method).await;
                }
                CodexWarningReading::None => {}
            },
            "deprecationNotice" => {
                if let Some(notice) = read_codex_deprecation_notice(record.session_id, members) {
                    self.send_notice(record, notice, method).await;
                }
            }
            "configWarning" => {
                if let Some(notice) = read_codex_config_warning(record.session_id, members) {
                    self.send_notice(record, notice, method).await;
                }
            }
            "model/rerouted" => {
                let Some(run) = self.row_run_for(record, members, method) else {
                    return;
                };
                if let Some(replaced) = hold_reroute(&mut record.delivery, members, &run.row) {
                    self.send_row(record, replaced).await;
                }
            }
            _ if CODEX_LOGGED_ONLY_METHODS.contains(&method) => {
                CodexTransportDiagnostic::ProviderNoticeLogged {
                    method: method.to_owned(),
                    session_id: record.session_id,
                }
                .report();
            }
            _ => {}
        }
    }

    async fn send_notice(
        &self,
        record: &CodexSessionRecord,
        notice: SessionNoticePostedPayload,
        method: &str,
    ) {
        let delivery = InboundDelivery::SessionNotice {
            session_id: record.session_id,
            notice,
        };
        self.send(record, delivery, method).await;
    }
}
