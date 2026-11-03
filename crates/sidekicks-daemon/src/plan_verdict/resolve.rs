//! The person's verdict on a plan, resolved: every verdict passes one entry, which answers a plan
//! already settled at once, then takes the plan's lock and reads it again, and refuses a planning
//! session that is gone or closed before any driver hears of it. Keep then answers the planning
//! session's driver and settles the plan `open` in one guarded write; a settle the guard refuses
//! answers the state the plan now holds.

use std::sync::Arc;

use serde_json::json;
use sidekicks_artifact::plans::service::PlanError;
use sidekicks_artifact::plans::verdict::{
    PlanSettleOutcome, PlanSettleVerdict, PlanVerdicts, StoredPlan,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::plan::{PlanId, PlanResolveResponse, PlanState};
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::contract::plan_verdict::{
    AnswerPlanParams, PlanVerdict, PlanVerdictAnswer,
};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_session::changes::refuse_unchangeable_session;
use sidekicks_session::driver_resolution::read_session_driver;
use sidekicks_std::keyed_lock::KeyHold;
use sidekicks_store::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool};
use sidekicks_store::database::schema::session_directory::read_session_state_through;
use sidekicks_store::events::session::read::DamagedFromSequenceReader;

#[cfg(test)]
mod tests;

/// Resolves the person's verdicts on plans through the planning session's driver and the plan's
/// guarded settle.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the plan.resolve handler resolves each person's verdict through it"
    )
)]
pub(crate) struct PlanResolution {
    verdicts: Arc<PlanVerdicts>,
    reads: Arc<DatabaseReadPool>,
    providers: Arc<ProviderRegistry>,
    read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
}

/// Why a verdict was not resolved: a refusal with its code, or a fault of the store, the driver or
/// a stored row.
#[derive(Debug, thiserror::Error)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the plan.resolve handler resolves each person's verdict through it"
    )
)]
pub(crate) enum PlanResolveError {
    /// A refusal with its code.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// The plan's read or settle failed.
    #[error(transparent)]
    Plan(#[from] PlanError),
    /// The planning session's driver did not take the verdict; nothing was written.
    #[error("the provider's driver did not take the plan's verdict")]
    Driver(#[from] DriverError),
    /// A read of the session did not reach a connection.
    #[error(transparent)]
    Read(#[from] DatabaseReadError),
    /// SQLite refused a read of the session, or a stored column does not read as its type.
    #[error("a read of the planning session failed")]
    Database(#[from] rusqlite::Error),
    /// The plan's row holds a state no answer carries: handed off with no fresh session, or still
    /// waiting after a settle the guard refused.
    #[error("plan {plan_id}'s stored state cannot be answered")]
    StoredStateInvalid {
        /// The plan.
        plan_id: PlanId,
    },
}

// A plan the entry let through: settled already, so answered as it stands, or waiting under its
// lock.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the plan.resolve handler resolves each person's verdict through it"
    )
)]
enum HeldPlan<'lock> {
    Settled(PlanResolveResponse),
    Waiting {
        hold: KeyHold<'lock, PlanId>,
        plan: StoredPlan,
    },
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the plan.resolve handler resolves each person's verdict through it"
    )
)]
impl PlanResolution {
    /// Resolution settling through `verdicts`, reading sessions through `reads` up to where
    /// `read_damaged_from_sequence` says each log stops being readable, and reaching each planning
    /// session's driver in `providers`.
    pub(crate) fn new(
        verdicts: Arc<PlanVerdicts>,
        reads: Arc<DatabaseReadPool>,
        providers: Arc<ProviderRegistry>,
        read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    ) -> Self {
        Self {
            verdicts,
            reads,
            providers,
            read_damaged_from_sequence,
        }
    }

    /// Keeps planning on `plan_id` from `device_id`: the planning session's driver hears the keep,
    /// then the plan settles `open` with `plan.kept`. A plan already settled answers its state, and
    /// so does one another verdict settled while the driver answered. Refused `plan.notFound` for
    /// a plan no row holds or a planning session gone or being purged, and `session.alreadyClosed`
    /// for a closed one, each with nothing sent and nothing written. Fails as the driver fails,
    /// nothing written, and as a read or the write fails.
    pub(crate) async fn keep(
        &self,
        plan_id: PlanId,
        device_id: DeviceId,
    ) -> Result<PlanResolveResponse, PlanResolveError> {
        let (hold, plan) = match self.hold_waiting(plan_id).await? {
            HeldPlan::Settled(answer) => return Ok(answer),
            HeldPlan::Waiting { hold, plan } => (hold, plan),
        };
        let (_provider, _account, driver) = read_session_driver::<PlanResolveError>(
            &self.reads,
            &self.providers,
            self.read_damaged_from_sequence.as_ref(),
            plan.session_id,
        )
        .await?;
        match driver
            .answer_plan(AnswerPlanParams {
                session_id: plan.session_id,
                plan_id,
                holds_request: plan.holds_request,
                verdict: PlanVerdict::Keep {},
            })
            .await?
        {
            // A request answered or withdrawn meanwhile leaves the plan to the guarded settle,
            // which reads back whatever settled it.
            PlanVerdictAnswer::Answered { .. } | PlanVerdictAnswer::NotHeld {} => {}
        }
        match self
            .verdicts
            .settle(
                &hold,
                plan.session_id,
                PlanSettleVerdict::Keep,
                device_id,
                Vec::new(),
            )
            .await?
        {
            PlanSettleOutcome::Settled => Ok(PlanResolveResponse::Open { plan_id }),
            PlanSettleOutcome::Unchanged(stored) => settled_answer(plan_id, &stored)?
                .ok_or(PlanResolveError::StoredStateInvalid { plan_id }),
            PlanSettleOutcome::Gone => Err(plan_not_found(plan_id).into()),
        }
    }

    // The entry: a settled plan answers at once, with no wait for its lock; a waiting one is read
    // again under the lock, then its planning session must still take a change.
    async fn hold_waiting(&self, plan_id: PlanId) -> Result<HeldPlan<'_>, PlanResolveError> {
        let before_lock = self
            .verdicts
            .read_plan(plan_id)
            .await?
            .ok_or_else(|| plan_not_found(plan_id))?;
        if let Some(answer) = settled_answer(plan_id, &before_lock)? {
            return Ok(HeldPlan::Settled(answer));
        }
        let hold = self.verdicts.plan_lock().acquire(plan_id).await;
        let plan = self
            .verdicts
            .read_plan(plan_id)
            .await?
            .ok_or_else(|| plan_not_found(plan_id))?;
        if let Some(answer) = settled_answer(plan_id, &plan)? {
            return Ok(HeldPlan::Settled(answer));
        }
        match read_session_state_through::<PlanResolveError>(&self.reads, plan.session_id).await? {
            None | Some(SessionState::PurgeRequested) => return Err(plan_not_found(plan_id).into()),
            Some(
                state @ (SessionState::Provisioning
                | SessionState::Active
                | SessionState::Archived
                | SessionState::Closed),
            ) => refuse_unchangeable_session(&plan.session_id, state)?,
        }
        Ok(HeldPlan::Waiting { hold, plan })
    }
}

// The answer a settled plan gives, `None` while it waits. Fails for a handed-off row that names
// no fresh session.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the plan.resolve handler resolves each person's verdict through it"
    )
)]
fn settled_answer(
    plan_id: PlanId,
    stored: &StoredPlan,
) -> Result<Option<PlanResolveResponse>, PlanResolveError> {
    Ok(match stored.state {
        PlanState::Waiting => None,
        PlanState::Accepted => Some(PlanResolveResponse::Accepted { plan_id }),
        PlanState::HandedOff => Some(PlanResolveResponse::HandedOff {
            plan_id,
            fresh_session_id: stored
                .fresh_session_id
                .ok_or(PlanResolveError::StoredStateInvalid { plan_id })?,
        }),
        PlanState::Open => Some(PlanResolveResponse::Open { plan_id }),
    })
}

// `plan.notFound` for a plan no row holds, or whose planning session is gone or being purged.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the plan.resolve handler resolves each person's verdict through it"
    )
)]
fn plan_not_found(plan_id: PlanId) -> DomainError {
    DomainError::new("This daemon holds no such plan", RefusalCode::PlanNotFound)
        .with_detail(json!({ "planId": plan_id }))
}
