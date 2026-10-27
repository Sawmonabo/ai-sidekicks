//! The plan record's intake: a plan a driver hands is kept as a `summary` artifact and recorded
//! `waiting` in one write, `artifact.published` before the `plan.proposed` that names it, and a
//! held request the provider let go reopens its plan. No held request outlives the daemon, so at
//! start every plan still waiting on one is reopened the same way. Nothing settles a plan on
//! elapsed time, and no plan moves its run.

use std::error::Error;
use std::sync::Arc;

use bytes::Bytes as ByteBuffer;
use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::artifacts::manifest::ArtifactType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::plan::{PlanHoldEndedReason, PlanId};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::record::JsonRecord;

use crate::manifest_write::{
    PublishedManifestWrite, manifest_write_failure, published_manifest_write,
};
use crate::plans::record::compose_plan_proposed_payload;
use crate::plans::store::{hold_end_write, insert_plan_statement, read_held_plans};
use crate::publish::{ArtifactPublishService, DaemonPayload};
use crate::refusals::ArtifactError;
use crate::validation::file_name_metadata;
use sidekicks_provider::port::plan::{PlanPort, ProviderPlan, ProviderPlanHoldEnd};
use sidekicks_session::plan_holds::HeldPlan;
use sidekicks_session::run::state_change::refused_statement_index;
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};

#[cfg(any(test, feature = "test-support"))]
pub mod test_fixture;
#[cfg(test)]
mod tests;

/// The statements [`PlansService`] prepares on a read connection: the plans of every run still
/// waiting on a held request (`HELD_PLANS_SQL`).
pub const PLANS_STATEMENT_CAPACITY: usize = 1;

/// The media type a plan's artifact is kept under.
const PLAN_MEDIA_TYPE: &str = "text/markdown";

/// Why a plan was not recorded or a hold not ended; nothing of the failed write is kept.
#[derive(Debug, thiserror::Error)]
pub enum PlanError {
    /// The plan's artifact was not kept, or its write was refused.
    #[error(transparent)]
    Artifact(#[from] ArtifactError),
    /// The write of a lost hold was not kept.
    #[error("the end of a plan's held request was not recorded")]
    Append(#[from] SessionEventAppendError),
    /// A read of the plan rows did not reach a connection.
    #[error(transparent)]
    Read(#[from] DatabaseReadError),
    /// SQLite refused a read, or a stored column does not read as its type.
    #[error("a read of the plan rows failed")]
    Database(#[from] rusqlite::Error),
    /// Several holds were not ended, every failure kept.
    #[error(transparent)]
    Several(Box<SettleFailures<PlanError>>),
}

/// Records the plans the drivers hand and ends the holds they let go.
pub struct PlansService {
    publisher: Arc<ArtifactPublishService>,
    appender: Arc<SessionEventAppender>,
    reads: Arc<DatabaseReadPool>,
}

impl PlansService {
    /// A service keeping each plan's text through `publisher`, writing through `appender` and
    /// reading the plan rows through `reads`.
    pub fn new(
        publisher: Arc<ArtifactPublishService>,
        appender: Arc<SessionEventAppender>,
        reads: Arc<DatabaseReadPool>,
    ) -> Self {
        Self {
            publisher,
            appender,
            reads,
        }
    }

    /// Records `plan` `waiting`: its artifact, `artifact.published`, the plan's row and
    /// `plan.proposed` naming the artifact, in one write. Answers the minted plan id. Fails with
    /// `session.notFound` or `agent.run.notFound`, as the store fails, or as the write does.
    pub async fn take_plan(&self, plan: ProviderPlan) -> Result<PlanId, PlanError> {
        let metadata = match &plan.plan_file_path {
            Some(path) => file_name_metadata(path.as_str()),
            None => JsonRecord::default(),
        };
        let payload = DaemonPayload {
            session_id: plan.session_id,
            run_id: Some(plan.run_id),
            artifact_type: ArtifactType::Summary,
            payload: ByteBuffer::from(plan.text.clone().into_bytes()),
            media_type: PLAN_MEDIA_TYPE.to_owned(),
            metadata,
        };
        let appender = Arc::clone(&self.appender);
        let plan_id = self
            .publisher
            .store_daemon_payload(payload, move |mut manifest| async move {
                let proposed = compose_plan_proposed_payload(plan, manifest.artifact_id);
                manifest.plan_id = Some(proposed.plan_id);
                let created_at = manifest.created_at.clone();
                let PublishedManifestWrite {
                    mut statements,
                    event: published,
                    manifest,
                } = published_manifest_write(manifest);
                statements.push(insert_plan_statement(&proposed, &created_at));
                let plan_id = proposed.plan_id;
                let event = SessionEventDraft::of_session(
                    proposed.session_id,
                    &SessionEvent::PlanProposed(proposed),
                )
                .expect("a plan.proposed payload has no check a plan's text can break");
                appender
                    .append(
                        event,
                        SessionEventLinkage {
                            occurred_at: Some(created_at),
                            transactional_prelude: statements,
                            preceding_events: vec![published],
                            ..SessionEventLinkage::default()
                        },
                    )
                    .await
                    .map_err(|failure| manifest_write_failure(&manifest, failure))?;
                Ok::<_, ArtifactError>(plan_id)
            })
            .await?;
        Ok(plan_id)
    }

    /// Reopens the plan `hold_end` names, recording `plan.hold.ended` with its reason, when it
    /// still waits on the request its driver held; a plan that holds none, or that is settled,
    /// is left as it is. Fails as the write fails.
    pub async fn end_plan_hold(&self, hold_end: ProviderPlanHoldEnd) -> Result<(), PlanError> {
        self.end_hold(
            HeldPlan {
                plan_id: hold_end.plan_id,
                session_id: hold_end.session_id,
            },
            hold_end.reason,
        )
        .await
    }

    /// Reopens every plan of `session_id` still waiting on a held request, `runEnded`, since no
    /// held request outlives the daemon; a plan that holds none stays waiting. Every plan is tried
    /// before the failures return together.
    pub async fn end_holds_lost_at_restart(&self, session_id: SessionId) -> Result<(), PlanError> {
        let held = self
            .reads
            .read(ReadLength::Short, move |reader| {
                Ok::<_, PlanError>(read_held_plans(reader, Some(&session_id))?)
            })
            .await?;
        let mut outcomes = Vec::with_capacity(held.len());
        for plan in held {
            outcomes.push(self.end_hold(plan, PlanHoldEndedReason::RunEnded).await);
        }
        settle_all(
            outcomes,
            "reopening the plans whose held requests a restart lost",
        )
        .map(drop)
        .map_err(|failures| match failures {
            SettleFailures::One(failure) => failure,
            many @ SettleFailures::Many { .. } => PlanError::Several(Box::new(many)),
        })
    }

    // The hold's end in one write, nothing written when the guard finds the plan holding none.
    async fn end_hold(&self, held: HeldPlan, reason: PlanHoldEndedReason) -> Result<(), PlanError> {
        let (statement, event) = hold_end_write(held, reason);
        let appended = self
            .appender
            .append(
                event,
                SessionEventLinkage {
                    transactional_prelude: vec![statement],
                    ..SessionEventLinkage::default()
                },
            )
            .await;
        match appended {
            Ok(_receipt) => Ok(()),
            Err(failure) if refused_statement_index(&failure) == Some(0) => Ok(()),
            Err(failure) => Err(failure.into()),
        }
    }
}

impl PlanPort for PlansService {
    fn take_plan(
        &self,
        plan: ProviderPlan,
    ) -> BoxFuture<'_, Result<PlanId, Box<dyn Error + Send + Sync>>> {
        PlansService::take_plan(self, plan)
            .map(|taken| taken.map_err(Into::into))
            .boxed()
    }

    fn end_plan_hold(
        &self,
        hold_end: ProviderPlanHoldEnd,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        PlansService::end_plan_hold(self, hold_end)
            .map(|ended| ended.map_err(Into::into))
            .boxed()
    }
}
