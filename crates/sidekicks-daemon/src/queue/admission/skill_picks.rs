//! Resolves the skills a send picked as the session's provider loads them, behind the memory gate
//! when the read would start the provider's process.

use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::queue::QueuedSkillPick;
use sidekicks_contracts::session::id::SessionId;

use super::{QueueAdmission, provider_work};
use crate::admission::memory_gate::MemoryAdmissionState;
use crate::database::connection::read_pool::ReadLength;
use crate::ipc::domain_error::DomainError;
use crate::provider::driver::contract::ProviderDriver;
use crate::provider::driver::run_control::PickedSkill;
use crate::queue::error::QueueError;
use crate::queue::store::QueueItemReader;

impl QueueAdmission {
    /// The skills `picks` names as the session's provider loads them: none asked, none read. A
    /// start of the session's queued run is waited for first, so the read never takes a second
    /// place behind it, and a read that would start the provider's process waits at the gate
    /// itself and leaves it once the read settles. Refuses `provider.timeout` when either wait
    /// outlives the delivery timeout, and as the driver refuses a pick.
    pub(crate) async fn resolve_skill_picks(
        &self,
        session_id: SessionId,
        provider: &ProviderId,
        driver: &dyn ProviderDriver,
        picks: Option<Vec<QueuedSkillPick>>,
    ) -> Result<Option<Vec<PickedSkill>>, QueueError> {
        let Some(picks) = picks.filter(|picks| !picks.is_empty()) else {
            return Ok(None);
        };
        let live_run_id = self
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QueueError>(QueueItemReader::new(reader).read_live_lead_run(&session_id)?)
            })
            .await?;
        if let Some(live_run_id) = live_run_id {
            let start = self.lock().starts.get(&live_run_id).cloned();
            if let Some(mut start) = start {
                let waited = tokio::time::timeout(
                    self.deps.delivery_timeout,
                    start.wait_for(|is_done| *is_done),
                )
                .await;
                if waited.is_err() {
                    return Err(provider_timed_out(session_id).into());
                }
            }
        }
        let place =
            if driver.skill_resolve_starts_process() && driver.starts_process(session_id).await {
                let place = self.deps.memory_gate.enqueue(provider_work(
                    &self.deps.providers,
                    provider,
                    false,
                )?);
                let mut admitted = place.admitted();
                let waited = tokio::time::timeout(
                    self.deps.delivery_timeout,
                    admitted.wait_for(Option::is_some),
                )
                .await;
                if waited.is_err() || place.state() != MemoryAdmissionState::Admitted {
                    return Err(provider_timed_out(session_id).into());
                }
                Some(place)
            } else {
                None
            };
        let resolved = driver.resolve_skill_picks(session_id, picks).await;
        drop(place);
        Ok(Some(resolved?))
    }
}

// The refusal of a skill read whose wait outlived the delivery timeout.
fn provider_timed_out(session_id: SessionId) -> DomainError {
    DomainError::new(
        "The session's provider could not be started within the delivery timeout",
        RefusalCode::ProviderTimeout,
    )
    .with_detail(json!({ "sessionId": session_id }))
}
