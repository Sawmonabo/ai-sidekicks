//! The provider's notices on a session: a warning, a deprecation or a config warning as the
//! session's notice, the start of a new reading of its settings, a model switch held for its
//! sentence, and the frames that go to the daemon's log only.

use serde_json::{Map, Value};
use sidekicks_contracts::session::controls::events::{SessionNotice, SessionNoticePostedPayload};

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::delivery::frames::CodexFrameDelivery;
use crate::driver::codex::delivery::notices::{
    CodexWarningReading, hold_reroute, read_codex_config_warning, read_codex_deprecation_notice,
    read_codex_warning,
};
use crate::driver::codex::service::supervisor::routing::CODEX_CONFIG_WARNING_METHOD;
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::record_readers::read_non_empty_string;
use crate::run::delivery::InboundDelivery;

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
            CODEX_CONFIG_WARNING_METHOD => {
                if let Some(notice) = read_codex_config_warning(record.session_id, members) {
                    self.send_notice(record, notice, method).await;
                }
            }
            "model/rerouted" => {
                let to_model = read_non_empty_string(members, "toModel");
                // Marked in use first, so a model the price list lacks is fetched at the reroute.
                if let Some(to_model) = to_model {
                    self.dependencies.pricing.mark_in_use(&[to_model]).await;
                }
                // The turn runs on the model it moved to, whether or not its row has a run.
                if let (Some(turn_id), Some(to_model)) =
                    (read_non_empty_string(members, "turnId"), to_model)
                    && let Some(input) = record.turn_input_by_turn_id.get_mut(turn_id)
                {
                    to_model.clone_into(&mut input.model);
                }
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

    /// Posts the session's notice that a new reading of Codex's settings began, which ends every
    /// earlier ignored-settings notice ahead of the config warnings the reading sends.
    pub(crate) async fn deliver_settings_reading_began(&self, record: &CodexSessionRecord) {
        let notice = SessionNoticePostedPayload::Notice(SessionNotice::SettingsLoaded {
            session_id: record.session_id,
            provider: DESCRIPTOR.provider_id(),
            file: None,
        });
        self.send_notice(record, notice, CODEX_CONFIG_WARNING_METHOD)
            .await;
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
